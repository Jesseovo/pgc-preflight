import { modelCapabilities } from '../src/model-options';
import {
  authorizeHarnessLease, finishHarnessRequest, forwardHarnessRequest, harnessIdentifier,
  harnessSha256, readLockedHarnessProfile, rearmHarnessRequest, reserveHarnessRequest,
  type HarnessDatabase, type HarnessRequestIdentity, type HarnessRun,
} from './harness-ledger';
import {
  HARNESS_MAX_REQUEST_MS, HARNESS_MODEL_HEADERS, type HarnessFailureCode, type HarnessFinishReason, type HarnessModelPolicy,
} from './harness-protocol';
import { tryModelSlot } from './model-capacity';
import { createModelThrottle, pauseModel, retryAfterMs, type ModelThrottleDatabase } from './model-throttle';
import { decryptKey, type ModelConfig, type ModelRuntime } from './settings';

const maxRequestBytes = 24 * 1024 * 1024;
const maxResponseBytes = 12 * 1024 * 1024;
const maxEventCharacters = 2 * 1024 * 1024;
const maxMessages = 256;
const maxTools = 96;
const encoder = new TextEncoder();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).every(key => fields.includes(key));
const base64Image = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const commonFields = ['model', 'messages', 'tools', 'tool_choice', 'stream', 'temperature', 'top_p'];
const anthropicFields = [...commonFields, 'system', 'max_tokens', 'top_k', 'stop_sequences', 'thinking', 'output_config', 'cache_control'];
const openAIFields = [...commonFields, 'max_tokens', 'max_completion_tokens', 'stream_options', 'reasoning_effort',
  'thinking', 'response_format', 'parallel_tool_calls', 'stop', 'n', 'seed', 'frequency_penalty', 'presence_penalty', 'store'];
const anthropicToolFields = ['type', 'name', 'description', 'input_schema', 'cache_control', 'strict', 'eager_input_streaming'];
const anthropicReasons = ['end_turn', 'tool_use', 'stop_sequence', 'max_tokens', 'refusal', 'pause_turn'] as const;
const openAIReasons = ['stop', 'tool_calls', 'function_call', 'length', 'content_filter'] as const;
const rejectionReasons: readonly HarnessFinishReason[] = ['refusal', 'pause_turn', 'content_filter'];
const truncationReasons: readonly HarnessFinishReason[] = ['max_tokens', 'length'];

type GatewayErrorCode = HarnessFailureCode | 'invalid_request' | 'invalid_lease' | 'route_denied' |
  'request_too_large' | 'request_duplicate' | 'request_conflict' | 'budget_or_state' | 'gateway_unavailable';
class GatewayError extends Error {
  constructor(readonly code: GatewayErrorCode, readonly status: number) { super(code); }
}
const invalid = (): never => { throw new GatewayError('invalid_request', 400); };

export interface HarnessGatewayOptions {
  DB: HarnessDatabase;
  capacityDB?: ModelThrottleDatabase;
  loadConfig: () => Promise<ModelConfig | null>;
  settingsKey: string;
  authorizeRun: (run: HarnessRun) => Promise<boolean>;
  fetcher?: typeof fetch;
  now?: () => number;
  waitUntil?: (promise: Promise<unknown>) => void;
  deadlineAt?: number;
  requestIdPrefix?: string;
  expectedModelTurns?: number;
  allowTransportRetry?: boolean;
}

function errorResponse(code: GatewayErrorCode, status: number, protocol: HarnessModelPolicy['protocol'] | null = null): Response {
  const error = { type: status === 429 ? 'rate_limit_error' : 'pgc_harness_error', message: code };
  return Response.json(protocol === 'anthropic' ? { type: 'error', error } : { error }, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function requestBody(request: Request, signal: AbortSignal): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > maxRequestBytes) throw new GatewayError('request_too_large', 413);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) return invalid();
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxRequestBytes) throw new GatewayError('request_too_large', 413);
      parts.push(decoder.decode(result.value, { stream: true }));
    }
    return JSON.parse(parts.join('') + decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof GatewayError) throw error;
    if (signal.aborted) throw new GatewayError('deadline', 504);
    return invalid();
  } finally {
    reader.releaseLock();
  }
}

function anthropicContent(value: unknown, vision: boolean, nested = false): boolean {
  if (typeof value === 'string') return true;
  if (!Array.isArray(value) || value.length > maxMessages) return false;
  return value.every(block => {
    if (!object(block)) return false;
    if (block.type === 'text') return typeof block.text === 'string';
    if (block.type === 'image') {
      return vision && object(block.source) && block.source.type === 'base64' &&
        typeof block.source.media_type === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(block.source.media_type) &&
        typeof block.source.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(block.source.data);
    }
    if (nested) return false;
    if (block.type === 'tool_result') return typeof block.tool_use_id === 'string' &&
      (block.content === undefined || anthropicContent(block.content, vision, true));
    if (block.type === 'tool_use') return typeof block.id === 'string' && typeof block.name === 'string' && object(block.input);
    if (block.type === 'thinking') return typeof block.thinking === 'string' && typeof block.signature === 'string';
    if (block.type === 'redacted_thinking') return typeof block.data === 'string';
    return false;
  });
}

function openAIContent(value: unknown, vision: boolean): boolean {
  if (value == null || typeof value === 'string') return true;
  return Array.isArray(value) && value.length <= maxMessages && value.every(block => {
    if (!object(block)) return false;
    if (block.type === 'text') return typeof block.text === 'string';
    if (block.type === 'refusal') return typeof block.refusal === 'string';
    return block.type === 'image_url' && vision && object(block.image_url) &&
      typeof block.image_url.url === 'string' && base64Image.test(block.image_url.url);
  });
}

function parseModelRequest(raw: unknown, policy: HarnessModelPolicy, profile: ModelRuntime): { body: Record<string, unknown>; outputCap: number } {
  if (!object(raw) || raw.model !== policy.model || raw.stream !== true ||
      !Array.isArray(raw.messages) || !raw.messages.length || raw.messages.length > maxMessages) return invalid();
  const anthropic = policy.protocol === 'anthropic';
  if (!hasOnly(raw, anthropic ? anthropicFields : openAIFields)) return invalid();
  if (!raw.messages.every(message => {
    if (!object(message)) return false;
    if (anthropic) return ['user', 'assistant'].includes(String(message.role)) && anthropicContent(message.content, policy.vision);
    return ['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(String(message.role)) &&
      openAIContent(message.content, policy.vision);
  })) return invalid();
  if (raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.length > maxTools || !raw.tools.every(tool => {
    if (!object(tool)) return false;
    if (!anthropic) return tool.type === 'function' && object(tool.function) && hasOnly(tool, ['type', 'function']);
    return (tool.type === undefined || tool.type === 'custom') && typeof tool.name === 'string' &&
      object(tool.input_schema) && hasOnly(tool, anthropicToolFields);
  }))) return invalid();
  const limit = raw.max_tokens ?? raw.max_completion_tokens ?? policy.maxOutputTokens;
  if (raw.max_tokens !== undefined && raw.max_completion_tokens !== undefined ||
      typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > policy.maxOutputTokens) return invalid();

  const body = { ...raw };
  const capability = modelCapabilities(profile);
  if (anthropic) {
    if (raw.system !== undefined && (Array.isArray(raw.system) ?
      !raw.system.every(part => object(part) && part.type === 'text' && typeof part.text === 'string') : typeof raw.system !== 'string')) return invalid();
    body.max_tokens = limit;
    if (capability.kind === 'adaptive') {
      if (raw.thinking !== undefined && (!object(raw.thinking) || raw.thinking.type !== 'adaptive' ||
          !hasOnly(raw.thinking, ['type', 'display']) || (raw.thinking.display !== undefined &&
            !['summarized', 'omitted'].includes(String(raw.thinking.display))))) return invalid();
      if (raw.output_config !== undefined && (!object(raw.output_config) || !hasOnly(raw.output_config, ['effort', 'format']) ||
          raw.output_config.effort !== undefined && raw.output_config.effort !== policy.effort)) return invalid();
      body.thinking = { ...raw.thinking as object, type: 'adaptive' };
      body.output_config = { ...raw.output_config as object, effort: policy.effort };
    } else if (raw.thinking !== undefined || raw.output_config !== undefined) return invalid();
  } else {
    if ((raw.n !== undefined && raw.n !== 1) || (raw.store !== undefined && raw.store !== false)) return invalid();
    if (raw.stream_options !== undefined && (!object(raw.stream_options) || !hasOnly(raw.stream_options, ['include_usage']))) return invalid();
    body.stream_options = { include_usage: true };
    if (raw.max_completion_tokens === undefined) body.max_tokens = limit;
    if (capability.kind === 'deepseek') {
      if (raw.reasoning_effort !== undefined && raw.reasoning_effort !== policy.effort ||
          raw.thinking !== undefined && (!object(raw.thinking) || raw.thinking.type !== 'enabled' || !hasOnly(raw.thinking, ['type']))) return invalid();
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = policy.effort;
    } else if (raw.reasoning_effort !== undefined || raw.thinking !== undefined) return invalid();
  }
  return { body, outputCap: limit };
}

class StreamError extends Error {
  constructor(readonly code: HarnessFailureCode, readonly rateLimited = false) { super(code); }
}

class StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  finishReason?: HarnessFinishReason;
  characters = 0;
  terminal = false;
  private started = false;
  private hasFinalUsage = false;

  constructor(private readonly protocol: HarnessModelPolicy['protocol'], private readonly outputCap: number) {}

  private readToken(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
    if (value == null) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new StreamError('stream_invalid');
    return value;
  }

  private usage(value: unknown, final = false) {
    if (!object(value)) return;
    const anthropic = this.protocol === 'anthropic';
    const input = this.readToken(anthropic ? value.input_tokens : value.prompt_tokens);
    const output = this.readToken(anthropic ? value.output_tokens : value.completion_tokens, this.outputCap);
    const details = value.completion_tokens_details;
    const reasoning = this.readToken(object(details) ? details.reasoning_tokens : undefined, this.outputCap);
    if (output !== undefined && output < (this.outputTokens ?? 0)) throw new StreamError('stream_invalid');
    if (final && output !== undefined) this.hasFinalUsage = true;
    this.inputTokens = input ?? this.inputTokens;
    this.outputTokens = output ?? this.outputTokens;
    this.reasoningTokens = reasoning ?? this.reasoningTokens;
  }

  private reason(value: unknown, allowed: readonly HarnessFinishReason[]) {
    if (value == null) return;
    if (!allowed.includes(value as HarnessFinishReason) || this.finishReason && this.finishReason !== value) throw new StreamError('stream_invalid');
    this.finishReason = value as HarnessFinishReason;
  }

  accept(event: string | undefined, data: string) {
    if (this.terminal) throw new StreamError('stream_invalid');
    if (this.protocol === 'openai' && data === '[DONE]') {
      this.terminal = true;
      return;
    }
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new StreamError('stream_invalid'); }
    if (!object(value)) throw new StreamError('stream_invalid');
    if (event === 'error' || value.type === 'error' || value.error != null) {
      const type = object(value.error) ? value.error.type ?? value.error.code : null;
      throw new StreamError('stream_error', type === 'rate_limit_error' || type === 'rate_limit_exceeded' || type === 'KEY_RATE_LIMIT');
    }
    if (this.protocol === 'anthropic') {
      if (event !== undefined && event !== value.type) throw new StreamError('stream_invalid');
      if (value.type === 'message_start') {
        if (this.started || !object(value.message)) throw new StreamError('stream_invalid');
        this.started = true;
        this.usage(value.message.usage);
      } else if (value.type === 'content_block_delta' && object(value.delta) && value.delta.type === 'text_delta' &&
          typeof value.delta.text === 'string') {
        this.characters += value.delta.text.length;
      } else if (value.type === 'message_delta') {
        if (!this.started || !object(value.delta)) throw new StreamError('stream_invalid');
        this.reason(value.delta.stop_reason, anthropicReasons);
        this.usage(value.usage, Boolean(this.finishReason));
      } else if (value.type === 'message_stop') {
        if (!this.started) throw new StreamError('stream_invalid');
        this.terminal = true;
      }
    } else {
      if (!Array.isArray(value.choices) || value.choices.length > 1) throw new StreamError('stream_invalid');
      const choice = value.choices[0];
      if (choice !== undefined) {
        if (!object(choice) || (choice.index !== undefined && choice.index !== 0)) throw new StreamError('stream_invalid');
        this.reason(choice.finish_reason, openAIReasons);
        if (object(choice.delta) && typeof choice.delta.content === 'string') this.characters += choice.delta.content.length;
      }
      this.usage(value.usage, Boolean(this.finishReason));
    }
  }

  outcome() {
    if (!this.terminal || !this.finishReason || !this.hasFinalUsage || this.outputTokens === undefined) throw new StreamError('stream_incomplete');
    if (this.reasoningTokens !== undefined && this.reasoningTokens > this.outputTokens) throw new StreamError('stream_invalid');
    const errorCode = truncationReasons.includes(this.finishReason) ? 'output_truncated' :
      rejectionReasons.includes(this.finishReason) ? 'output_rejected' : undefined;
    return {
      state: errorCode ? 'failed' as const : 'completed' as const, errorCode,
      inputTokens: this.inputTokens, outputTokens: this.outputTokens, reasoningTokens: this.reasoningTokens, characters: this.characters, finishReason: this.finishReason,
    } as const;
  }
}

class StreamFrames {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private remaining = '';
  private frame = '';
  private data: string[] = [];
  private event?: string;
  private bytes = 0;

  constructor(private readonly usage: StreamUsage) {}

  add(bytes?: Uint8Array): { ordinary: string; terminal: string } {
    this.bytes += bytes?.length ?? 0;
    if (this.bytes > maxResponseBytes) throw new StreamError('stream_limit');
    const previouslyScanned = this.remaining.length - Number(this.remaining.endsWith('\r'));
    try {
      this.remaining += bytes ? this.decoder.decode(bytes, { stream: true }) : this.decoder.decode();
    } catch {
      throw new StreamError('stream_invalid');
    }
    const ordinary: string[] = [];
    const terminal: string[] = [];
    let offset = 0;
    const lineEnd = /\r\n|[\n\r]/g;
    lineEnd.lastIndex = previouslyScanned;
    for (let match = lineEnd.exec(this.remaining); match; match = lineEnd.exec(this.remaining)) {
      const end = match.index + match[0].length;
      if (bytes && match[0] === '\r' && end === this.remaining.length) break;
      const rawLine = this.remaining.slice(offset, match.index);
      const line = offset === 0 && !this.frame ? rawLine.replace(/^\uFEFF/, '') : rawLine;
      this.frame += this.remaining.slice(offset, end);
      if (this.frame.length > maxEventCharacters) throw new StreamError('stream_limit');
      offset = end;
      if (!line) {
        if (this.event === 'error' || this.data.length) this.usage.accept(this.event, this.data.join('\n'));
        (this.usage.terminal ? terminal : ordinary).push(this.frame);
        this.frame = '';
        this.data = [];
        this.event = undefined;
      } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) this.event = line.slice(6).replace(/^ /, '');
    }
    this.remaining = this.remaining.slice(offset);
    if (this.remaining.length + this.frame.length > maxEventCharacters) throw new StreamError('stream_limit');
    if (!bytes && (this.remaining || this.frame)) throw new StreamError('stream_incomplete');
    return { ordinary: ordinary.join(''), terminal: terminal.join('') };
  }
}

function protocolFor(request: Request): HarnessModelPolicy['protocol'] {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.search || url.hash) throw new GatewayError('route_denied', 404);
  if (url.pathname === '/v1/messages') return 'anthropic';
  if (url.pathname === '/v1/chat/completions') return 'openai';
  throw new GatewayError('route_denied', 404);
}

function identityFrom(request: Request): HarnessRequestIdentity {
  const taskId = request.headers.get(HARNESS_MODEL_HEADERS.task);
  const generation = request.headers.get(HARNESS_MODEL_HEADERS.generation);
  const requestId = request.headers.get(HARNESS_MODEL_HEADERS.requestId);
  if (!harnessIdentifier(taskId) || !harnessIdentifier(generation) || !harnessIdentifier(requestId)) throw new GatewayError('invalid_lease', 401);
  return { taskId, generation, requestId };
}

function providerUrl(profile: ModelRuntime): URL {
  let url: URL;
  try {
    url = new URL(profile.baseUrl.replace(/\/+$/, '') + (profile.protocol === 'anthropic' ? '/v1/messages' : '/chat/completions'));
  } catch {
    throw new GatewayError('profile_unavailable', 503);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
    throw new GatewayError('profile_unavailable', 503);
  }
  return url;
}

function upstreamHeaders(protocol: HarnessModelPolicy['protocol'], apiKey: string, idempotencyKey: string) {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Idempotency-Key': idempotencyKey });
  if (protocol === 'anthropic') {
    headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }
  return headers;
}

async function isKeyQueueFull(response: Response, signal: AbortSignal): Promise<boolean> {
  if (response.status !== 503 || !response.body) return false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
      if (text.length > 16 * 1024) return false;
    }
    const payload = JSON.parse(text + decoder.decode());
    return object(payload) && object(payload.error) && payload.error.code === 'KEY_QUEUE_FULL';
  } catch {
    return false;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function handleHarnessModelRequest(request: Request, options: HarnessGatewayOptions): Promise<Response> {
  const db = options.DB;
  const capacityDB = options.capacityDB ?? db;
  const now = options.now ?? Date.now;
  let protocol: HarnessModelPolicy['protocol'] | null = null;
  let id: HarnessRequestIdentity | undefined;
  let reserved = false;
  let potentiallyPaid = false;
  let httpStatus: number | undefined;
  let firstResponseMs: number | undefined;
  let slot: Awaited<ReturnType<typeof tryModelSlot>> = null;
  let streamOwnsResources = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const localAbort = new AbortController();
  const signal = AbortSignal.any([localAbort.signal, request.signal]);
  const stopTimer = () => clearTimeout(timeout);
  const settled = (outcome: Parameters<typeof finishHarnessRequest>[2]) =>
    finishHarnessRequest(db, id!, { ...outcome, httpStatus, firstResponseMs }, now());
  const releaseSlot = async () => {
    if (slot && !potentiallyPaid) await slot.release().catch(() => {});
  };
  try {
    protocol = protocolFor(request);
    id = identityFrom(request);
    if (options.requestIdPrefix && !id.requestId.startsWith(options.requestIdPrefix)) throw new GatewayError('invalid_lease', 401);
    const authorization = request.headers.get('authorization');
    const headerLease = request.headers.get('x-api-key');
    const bearerLease = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if ((authorization && !bearerLease) || (bearerLease && headerLease && bearerLease !== headerLease)) throw new GatewayError('invalid_lease', 401);
    const lease = bearerLease ?? headerLease ?? '';
    const run = await authorizeHarnessLease(db, id, lease, { authorizeRun: options.authorizeRun, now: now() });
    if (!run || run.model.protocol !== protocol) throw new GatewayError('invalid_lease', 401);
    const requestStartedAt = now();
    const stageDeadline = Math.min(run.deadlineAt, options.deadlineAt ?? Infinity);
    if (requestStartedAt >= stageDeadline) throw new GatewayError('deadline', 504);
    timeout = setTimeout(() => localAbort.abort(), Math.min(stageDeadline-requestStartedAt,HARNESS_MAX_REQUEST_MS));
    const profile = await readLockedHarnessProfile(await abortable(options.loadConfig(), signal), run.model);
    if (!profile || !options.settingsKey) throw new GatewayError('profile_unavailable', 503);
    const apiKey = await decryptKey(profile.encryptedKey, options.settingsKey).catch(() => '');
    if (!apiKey) throw new GatewayError('profile_unavailable', 503);
    const runtime = { ...profile, apiKey };
    const url = providerUrl(runtime);
    const body = parseModelRequest(await requestBody(request, signal), run.model, runtime);
    const bodyHash = await harnessSha256(JSON.stringify(body.body));
    const reservation = await reserveHarnessRequest(db, id, bodyHash, body.outputCap, now(), requestStartedAt, stageDeadline, options.expectedModelTurns);
    if (reservation.status !== 'reserved') {
      const code = reservation.status === 'duplicate' ? 'request_duplicate' :
        reservation.status === 'conflict' ? 'request_conflict' : 'budget_or_state';
      return errorResponse(code, 409, protocol);
    }
    reserved = true;
    const capField = body.body.max_completion_tokens === undefined ? 'max_tokens' : 'max_completion_tokens';
    body.body[capField] = reservation.outputCap;
    const upstreamBody = JSON.stringify(body.body);
    clearTimeout(timeout);
    timeout = setTimeout(() => localAbort.abort(), Math.max(0, reservation.deadlineAt - now()));
    const idempotencyKey = `pgc-harness-${await harnessSha256([id.taskId,id.generation,id.requestId].join('\n'))}`;
    const throttle = createModelThrottle(capacityDB, runtime);
    while (!slot) {
      signal.throwIfAborted();
      slot = await tryModelSlot(capacityDB, runtime, idempotencyKey, reservation.deadlineAt + 120_000);
      if (!slot) await pauseModel(5_000, signal);
    }
    const fetcher = options.fetcher ?? fetch;
    const headers = upstreamHeaders(protocol, apiKey, idempotencyKey);
    let upstream: Response;
    for (let attempt = 0; ; attempt++) {
      await abortable(throttle.wait(signal), signal);
      if (!await readLockedHarnessProfile(await abortable(options.loadConfig(), signal), run.model)) throw new GatewayError('profile_unavailable', 503);
      signal.throwIfAborted();
      if (!await abortable(options.authorizeRun(run), signal)) throw new GatewayError('authorization_revoked', 403);
      if (!await forwardHarnessRequest(db, id, now())) throw new GatewayError('budget_or_state', 409);
      signal.throwIfAborted();
      const requestAt = now();
      potentiallyPaid = true;
      upstream = await abortable(fetcher(url, { method: 'POST', headers, body: upstreamBody, redirect: 'manual', signal }), signal);
      firstResponseMs ??= Math.max(0, now() - requestAt);
      httpStatus = upstream.status;
      if (upstream.ok) break;

      const throttled = upstream.status === 429;
      const capacity = await isKeyQueueFull(upstream, signal);
      if (throttled || capacity) {
        potentiallyPaid = false;
        void upstream.body?.cancel().catch(() => {});
        const wait = Math.max(throttled ? 30_000 : 5_000, retryAfterMs(upstream.headers.get('retry-after'), now()) ?? 0);
        if (throttled) await throttle.cooldown(wait);
        if (options.allowTransportRetry !== false && attempt === 0 && now() + wait < reservation.deadlineAt &&
            await rearmHarnessRequest(db, id)) {
          await pauseModel(wait, signal);
          continue;
        }
        throw new GatewayError('provider_rejected', upstream.status);
      }

      void upstream.body?.cancel().catch(() => {});
      if (upstream.status >= 300 && upstream.status < 400) {
        potentiallyPaid = false;
        throw new GatewayError('provider_redirect', 502);
      }
      if (upstream.status >= 400 && upstream.status < 500 && upstream.status !== 408 && upstream.status !== 409) {
        potentiallyPaid = false;
        throw new GatewayError('provider_rejected', upstream.status);
      }
      throw new GatewayError('provider_unknown', 502);
    }
    if (!upstream.body || !upstream.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      void upstream.body?.cancel().catch(() => {});
      throw new GatewayError('stream_incomplete', 502);
    }

    const reader = upstream.body.getReader();
    const usage = new StreamUsage(protocol, reservation.outputCap);
    const frames = new StreamFrames(usage);
    const finalFrames: string[] = [];
    let finished = false;
    let finalize: Promise<void> | undefined;
    let done!: () => void;
    const completion = new Promise<void>(resolve => { done = resolve; });
    options.waitUntil?.(completion);
    const cleanup = () => {
      stopTimer();
      signal.removeEventListener('abort', abort);
      done();
    };
    const fail = (controller: ReadableStreamDefaultController<Uint8Array> | null, code: HarnessFailureCode): Promise<void> => {
      if (finalize) return finalize;
      finished = true;
      finalize = (async () => {
        try {
          await settled({ state: 'unknown', errorCode: code, characters: usage.characters }).catch(() => {});
        } finally {
          void reader.cancel().catch(() => {});
          try { controller?.error(new Error(code)); } catch { /* Consumer already closed. */ }
          cleanup();
        }
      })();
      return finalize;
    };
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const abort = () => { void fail(streamController, request.signal.aborted ? 'client_disconnected' : 'deadline'); };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        if (finished) return;
        try {
          while (!finished) {
            const part = await abortable(reader.read(), signal);
            if (finished) return;
            const parsed = frames.add(part.done ? undefined : part.value);
            if (parsed.terminal) finalFrames.push(parsed.terminal);
            if (part.done) {
              const outcome = usage.outcome();
              if (!await settled(outcome)) throw new StreamError('deadline');
              if (finished) return;
              potentiallyPaid = false;
              finished = true;
              await releaseSlot();
              reader.releaseLock();
              cleanup();
              if (outcome.state === 'completed') {
                controller.enqueue(encoder.encode(parsed.ordinary + finalFrames.join('')));
                controller.close();
              } else {
                controller.error(new Error(outcome.errorCode));
              }
              return;
            }
            if (parsed.ordinary) {
              controller.enqueue(encoder.encode(parsed.ordinary));
              return;
            }
          }
        } catch (error) {
          if (error instanceof StreamError && error.rateLimited) {
            await throttle.cooldown(Math.max(30_000,retryAfterMs(upstream.headers.get('retry-after'),now()) ?? 0)).catch(() => {});
          }
          await fail(controller, error instanceof StreamError ? error.code : 'stream_incomplete');
        }
      },
      cancel() {
        if (!finished) return fail(null, 'client_disconnected');
      },
    });
    streamOwnsResources = true;
    return new Response(stream, { headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    const failure = error instanceof GatewayError ? error :
      signal.aborted ? new GatewayError('deadline', 504) :
      potentiallyPaid ? new GatewayError('provider_unknown', 502) : new GatewayError('gateway_unavailable', 503);
    if (reserved) {
      const code = failure.code === 'budget_or_state' ? 'interrupted' :
        failure.code === 'gateway_unavailable' ? 'runtime_failed' : failure.code as HarnessFailureCode;
      await settled({ state: potentiallyPaid ? 'unknown' : 'failed', errorCode: code }).catch(() => {});
    }
    return errorResponse(failure.code, failure.status, protocol);
  } finally {
    // Streaming settlement owns the timer and provider slot after a 2xx SSE response.
    if (!streamOwnsResources) { stopTimer(); await releaseSlot(); }
  }
}
