import type { EmbeddedAssistantBlock, EmbeddedModelRequest } from './embedded-ccb/types';
import { handleHarnessModelRequest, HARNESS_MAX_RETAINED_RESPONSE_BYTES, HarnessNativeResponseLimitError, type HarnessGatewayOptions, type HarnessNativeObserver, type HarnessNativeUsage, type HarnessUpstreamErrorResponse } from './harness-gateway';
import { harnessSha256, type HarnessRequestIdentity, type HarnessRun } from './harness-ledger';
import { HARNESS_MODEL_HEADERS, type HarnessFinishReason, type HarnessModelPolicy } from './harness-protocol';
import { retryAfterMs } from './model-throttle';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const maxBlocks = 256;
const maxEvents = 128_000;
const encoder = new TextEncoder();
class RetainedResponseBudget {
  private bytes = 0;
  retain(...parts: (string | undefined)[]) {
    for (const part of parts) if (part) this.bytes += encoder.encode(part).byteLength;
    if (this.bytes > HARNESS_MAX_RETAINED_RESPONSE_BYTES) throw new HarnessNativeResponseLimitError();
  }
}
const invalid = (): never => { throw new Error('stream_invalid'); };
function requireNative(value: unknown): asserts value { if (!value) invalid(); }

export type EmbeddedNativeAssistantBlock = EmbeddedAssistantBlock;

export type EmbeddedHarnessModelScope = {
  run: Pick<HarnessRun, 'taskId' | 'generation' | 'model' | 'deadlineAt'>;
  lease: string;
  requestId: HarnessRequestIdentity['requestId'];
  deadlineAt: number;
  remainingOutputTokens?: number;
};

export type EmbeddedHarnessGatewayOptions = Omit<HarnessGatewayOptions, 'nativeObserver' | 'allowTransportRetry' | 'deadlineAt'>;

type EmbeddedResponseHeaders = {
  contentType: 'text/event-stream' | 'application/json' | 'text/plain' | 'text/html' | null;
  requestIdSha256: string | null;
  xRequestIdSha256: string | null;
  cfRaySha256: string | null;
  retryAfterMs: number | null;
};

export type EmbeddedHarnessModelDiagnostics = {
  requestSentAt: number | null;
  responseHeadAt: number | null;
  firstByteAt: number | null;
  lastByteAt: number | null;
  nativeTerminalAt: number | null;
  finishedAt: number | null;
  httpStatus: number | null;
  responseHeaders: Readonly<EmbeddedResponseHeaders> | null;
  errorResponse: HarnessUpstreamErrorResponse | null;
  cancelReason: 'client_disconnected' | 'deadline' | null;
  byteCount: number;
  chunkCount: number;
  nativeEventCount: number;
};

export type EmbeddedHarnessModelResult = {
  id?: string;
  role: 'assistant';
  content: EmbeddedNativeAssistantBlock[];
  stopReason: HarnessFinishReason;
  usage: { inputTokens: number | null; outputTokens: number; reasoningTokens: number | null };
  diagnostics: Readonly<EmbeddedHarnessModelDiagnostics>;
};

const codes = [
  'authorization_revoked', 'profile_unavailable', 'deadline', 'capacity', 'provider_redirect', 'provider_rejected',
  'provider_unknown', 'stream_error', 'stream_incomplete', 'stream_invalid', 'stream_limit', 'output_truncated',
  'output_rejected', 'client_disconnected', 'interrupted', 'runtime_failed', 'invalid_request', 'invalid_lease',
  'route_denied', 'request_too_large', 'request_duplicate', 'request_conflict', 'budget_or_state', 'gateway_unavailable',
] as const;
type ModelErrorCode = typeof codes[number];
const safeCode = (value: unknown): value is ModelErrorCode => typeof value === 'string' && codes.includes(value as ModelErrorCode);

export class EmbeddedHarnessModelError extends Error {
  constructor(readonly code: ModelErrorCode, readonly diagnostics: Readonly<EmbeddedHarnessModelDiagnostics>) {
    super(code);
    this.name = 'EmbeddedHarnessModelError';
  }
}

function jsonInput(text: string): JsonObject {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  requireNative(object(value));
  return value;
}

type NativeEvent = Parameters<HarnessNativeObserver['event']>[0];
type NativeMessage = { id?: string; content: EmbeddedNativeAssistantBlock[] };
type NativeAssembly = {
  event(value: NativeEvent): void;
  complete(reason: HarnessFinishReason): NativeMessage;
};

type ToolBlock = Extract<EmbeddedNativeAssistantBlock, { type: 'tool_use' }>;
type AnthropicBlock = Exclude<EmbeddedNativeAssistantBlock, { type: 'thinking' }> |
  { type: 'thinking'; thinking: string; signature: string };

function anthropicBlock(value: unknown): AnthropicBlock {
  requireNative(object(value));
  switch (value.type) {
    case 'text':
      requireNative(typeof value.text === 'string' && value.citations == null);
      return { type: value.type, text: value.text };
    case 'thinking':
      requireNative(typeof value.thinking === 'string' && (value.signature === undefined || typeof value.signature === 'string'));
      return { type: value.type, thinking: value.thinking, signature: value.signature ?? '' };
    case 'redacted_thinking':
      requireNative(typeof value.data === 'string' && value.data.length > 0);
      return { type: value.type, data: value.data };
    case 'tool_use':
      requireNative(typeof value.id === 'string' && value.id.length > 0 &&
        typeof value.name === 'string' && value.name.length > 0 && object(value.input));
      // A direct caller is response metadata. This adapter exposes only client tools.
      requireNative(value.caller === undefined || object(value.caller) &&
        value.caller.type === 'direct' && Object.keys(value.caller).length === 1);
      return { type: value.type, id: value.id, name: value.name, input: value.input };
    default: return invalid();
  }
}

class AnthropicAssembly implements NativeAssembly {
  private readonly budget = new RetainedResponseBudget();
  private readonly content: AnthropicBlock[] = [];
  private readonly toolIds = new Set<string>();
  private readonly streamedInputs = new Map<ToolBlock, string>();
  private id?: string;
  private started = false;
  private stopped = false;
  private hasReason = false;
  private active?: { block: AnthropicBlock; parts: string[] };

  constructor(private readonly model: string) {}

  event(value: NativeEvent) {
    requireNative(value !== '[DONE]' && !this.stopped);
    if (value.type === 'ping') return;
    if (value.type === 'message_start') {
      const message = value.message;
      requireNative(!this.started && object(message) && message.role === 'assistant' &&
        Array.isArray(message.content) && message.content.length === 0);
      requireNative(message.model === undefined || message.model === this.model);
      requireNative(message.id === undefined || typeof message.id === 'string' && message.id.length > 0);
      this.budget.retain(message.id);
      this.id = message.id;
      this.started = true;
      return;
    }
    requireNative(this.started);
    if (value.type === 'message_delta') {
      requireNative(!this.active && object(value.delta));
      if (value.delta.stop_reason != null) {
        requireNative(!this.hasReason);
        this.hasReason = true;
      }
      return;
    }
    if (value.type === 'message_stop') {
      requireNative(!this.active && this.hasReason);
      this.stopped = true;
      return;
    }
    requireNative(!this.hasReason && value.index === this.content.length && this.content.length < maxBlocks);
    if (value.type === 'content_block_start') {
      requireNative(!this.active);
      const block = anthropicBlock(value.content_block);
      if (block.type === 'text') this.budget.retain(block.text);
      if (block.type === 'thinking') this.budget.retain(block.thinking, block.signature);
      if (block.type === 'redacted_thinking') this.budget.retain(block.data);
      if (block.type === 'tool_use') this.budget.retain(block.id, block.name, JSON.stringify(block.input));
      this.active = { block, parts: [] };
      return;
    }
    requireNative(this.active);
    if (value.type === 'content_block_delta') {
      requireNative(object(value.delta));
      this.delta(value.delta, this.active);
      return;
    }
    requireNative(value.type === 'content_block_stop');
    const { block, parts } = this.active;
    if (block.type === 'thinking') {
      block.thinking += parts.join('');
    } else if (block.type === 'text') {
      block.text += parts.join('');
    } else if (block.type === 'tool_use') {
      requireNative(!this.toolIds.has(block.id));
      this.toolIds.add(block.id);
      if (parts.length > 0) {
        requireNative(Object.keys(block.input).length === 0);
        this.streamedInputs.set(block, parts.join(''));
      }
    }
    this.content.push(block);
    this.active = undefined;
  }

  private delta(delta: JsonObject, { block, parts }: NonNullable<AnthropicAssembly['active']>) {
    if (block.type === 'thinking') {
      if (delta.type === 'signature_delta') {
        requireNative(typeof delta.signature === 'string' && delta.signature.length > 0 && !block.signature);
        this.budget.retain(delta.signature);
        block.signature = delta.signature;
        return;
      }
      requireNative(delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && !block.signature);
      this.budget.retain(delta.thinking);
      parts.push(delta.thinking);
    } else if (block.type === 'text') {
      requireNative(delta.type === 'text_delta' && typeof delta.text === 'string');
      this.budget.retain(delta.text);
      parts.push(delta.text);
    } else if (block.type === 'tool_use') {
      requireNative(delta.type === 'input_json_delta' && typeof delta.partial_json === 'string');
      this.budget.retain(delta.partial_json);
      if (delta.partial_json) parts.push(delta.partial_json);
    } else invalid();
  }

  complete() {
    requireNative(this.stopped && this.content.length > 0);
    requireNative(this.content.every(block => block.type !== 'thinking' || block.signature.length > 0));
    for (const [block, input] of this.streamedInputs) block.input = jsonInput(input);
    return { id: this.id, content: this.content };
  }
}

type OpenAITool = { id: string; name: string; arguments: string[]; isFunction: boolean };

class OpenAIAssembly implements NativeAssembly {
  private readonly budget = new RetainedResponseBudget();
  private id?: string;
  private readonly text: string[] = [];
  private readonly reasoning: string[] = [];
  private readonly tools: OpenAITool[] = [];
  private stopped = false;
  private hasReason = false;

  constructor(private readonly model: string) {}

  event(value: NativeEvent) {
    requireNative(!this.stopped);
    if (value === '[DONE]') {
      requireNative(this.hasReason);
      this.stopped = true;
      return;
    }
    requireNative(value.model === undefined || value.model === this.model);
    if (value.id !== undefined) {
      requireNative(typeof value.id === 'string' && value.id.length > 0 && (this.id === undefined || this.id === value.id));
      if (this.id === undefined) this.budget.retain(value.id);
      this.id = value.id;
    }
    requireNative(Array.isArray(value.choices) && value.choices.length <= 1);
    const choice: unknown = value.choices[0];
    if (choice === undefined) return; // Native usage-only chunk.
    requireNative(!this.hasReason && object(choice) && object(choice.delta));
    const delta = choice.delta;
    requireNative(delta.role == null || delta.role === 'assistant');
    requireNative(delta.function_call == null && delta.refusal == null);
    if (delta.content != null) {
      requireNative(typeof delta.content === 'string');
      this.budget.retain(delta.content);
      this.text.push(delta.content);
    }
    if (delta.reasoning_content != null) {
      requireNative(typeof delta.reasoning_content === 'string');
      this.budget.retain(delta.reasoning_content);
      this.reasoning.push(delta.reasoning_content);
    }
    if (delta.tool_calls != null) {
      requireNative(Array.isArray(delta.tool_calls));
      for (const tool of delta.tool_calls) this.addTool(tool);
    }
    this.hasReason = choice.finish_reason != null;
  }

  private addTool(value: unknown) {
    requireNative(object(value) && typeof value.index === 'number' && Number.isSafeInteger(value.index) &&
      value.index >= 0 && value.index <= this.tools.length && value.index < maxBlocks);
    requireNative(value.type == null || value.type === 'function');
    requireNative(value.function == null || object(value.function));
    const fn = value.function;
    requireNative(value.id == null || typeof value.id === 'string');
    requireNative(fn?.name == null || typeof fn.name === 'string');
    requireNative(fn?.arguments == null || typeof fn.arguments === 'string');
    this.budget.retain(value.id ?? undefined, fn?.name ?? undefined, fn?.arguments ?? undefined);
    const tool = this.tools[value.index] ?? { id: '', name: '', arguments: [], isFunction: false };
    tool.id += value.id ?? '';
    tool.name += fn?.name ?? '';
    tool.isFunction ||= value.type === 'function';
    if (fn?.arguments) tool.arguments.push(fn.arguments);
    this.tools[value.index] = tool;
  }

  complete(reason: HarnessFinishReason) {
    requireNative(this.stopped && (reason === 'stop' || reason === 'tool_calls'));
    const content: EmbeddedNativeAssistantBlock[] = [];
    if (this.reasoning.length) content.push({ type: 'thinking', thinking: this.reasoning.join('') });
    if (this.text.some(Boolean)) content.push({ type: 'text', text: this.text.join('') });
    const ids = new Set<string>();
    for (const tool of this.tools) {
      requireNative(tool.isFunction && tool.id && tool.name && !ids.has(tool.id));
      ids.add(tool.id);
      content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: jsonInput(tool.arguments.join('')) });
    }
    requireNative(content.length > 0);
    return { id: this.id, content };
  }
}

type OpenAIUserPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

function openAIUserPart(value: unknown): OpenAIUserPart {
  requireNative(object(value));
  if (value.type === 'text' && typeof value.text === 'string') return { type: 'text', text: value.text };
  requireNative(value.type === 'image' && object(value.source) && value.source.type === 'base64' &&
    typeof value.source.media_type === 'string' && typeof value.source.data === 'string');
  return { type: 'image_url', image_url: { url: `data:${value.source.media_type};base64,${value.source.data}` } };
}

function openAIUserMessage(content: readonly unknown[]): JsonObject[] {
  const messages: JsonObject[] = [];
  const user: OpenAIUserPart[] = [];
  let ordinaryUserContent = false;
  for (const value of content) {
    requireNative(object(value));
    if (value.type !== 'tool_result') {
      ordinaryUserContent = true;
      user.push(openAIUserPart(value));
      continue;
    }
    requireNative(!ordinaryUserContent && typeof value.tool_use_id === 'string' && value.tool_use_id.length > 0 &&
      (value.is_error === undefined || typeof value.is_error === 'boolean'));
    const result = value.content;
    requireNative(result === undefined || typeof result === 'string' || Array.isArray(result));
    const parts = Array.isArray(result) ? result.map(openAIUserPart) : [];
    const text = typeof result === 'string' ? [{ type: 'text' as const, text: result }] : parts.filter(part => part.type === 'text');
    if (value.is_error) text.unshift({ type: 'text', text: 'Tool error:' });
    messages.push({ role: 'tool', tool_call_id: value.tool_use_id, content: text.length > 1 ? text : text[0]?.text ?? '' });
    const images = parts.filter(part => part.type === 'image_url');
    // The Chat Completions tool role is text-only. Finish all correlated tool
    // messages before attaching images in a following user message.
    if (images.length) {
      user.push({ type: 'text', text: 'Images attached to tool result ' + value.tool_use_id }, ...images);
    }
  }
  if (user.length) messages.push({ role: 'user', content: user });
  requireNative(messages.length > 0);
  return messages;
}

function openAIAssistantMessage(content: readonly unknown[]): JsonObject {
  const text: string[] = [], thinking: string[] = [], toolCalls: JsonObject[] = [];
  for (const value of content) {
    requireNative(object(value));
    if (value.type === 'text' && typeof value.text === 'string') text.push(value.text);
    else if (value.type === 'thinking' && typeof value.thinking === 'string' && value.signature === undefined) thinking.push(value.thinking);
    else if (value.type === 'tool_use' && typeof value.id === 'string' && typeof value.name === 'string' && object(value.input)) {
      toolCalls.push({ id: value.id, type: 'function', function: { name: value.name, arguments: JSON.stringify(value.input) } });
    } else invalid();
  }
  requireNative(text.length > 0 || thinking.length > 0 || toolCalls.length > 0);
  return { role: 'assistant', content: text.length ? text.join('') : null,
    ...(thinking.length ? { reasoning_content: thinking.join('') } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

function wireRequest(request: EmbeddedModelRequest, model: HarnessModelPolicy, outputCap: number) {
  requireNative(typeof request.system === 'string' && request.messages.length > 0 &&
    request.messages.every(message => message.role === 'user' || message.role === 'assistant'));
  const shared = { model: model.model, stream: true, max_tokens: outputCap };
  if (model.protocol === 'anthropic') {
    return { ...shared, system: request.system, messages: request.messages,
      ...(request.tools.length ? { tools: request.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })) } : {}) };
  }
  const messages: JsonObject[] = [{ role: 'system', content: request.system }];
  for (const message of request.messages) {
    if (message.role === 'assistant') messages.push(openAIAssistantMessage(message.content));
    else messages.push(...openAIUserMessage(message.content));
  }
  return { ...shared, messages, ...(request.tools.length ? { tools: request.tools.map(({ name, description, input_schema }) =>
    ({ type: 'function', function: { name, description, parameters: input_schema } })) } : {}) };
}

const observedMediaTypes = ['text/event-stream', 'application/json', 'text/plain', 'text/html'] as const;
const requestIdHeader = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const cfRayHeader = /^[a-f0-9]{16,32}-[A-Z]{3}$/;
const retryAfterHeader = /^(?:\d{1,8}|[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)$/;

async function safeResponseHeaders(headers: Headers, headAt: number): Promise<Readonly<EmbeddedResponseHeaders>> {
  const media = (headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  const retry = headers.get('retry-after');
  const retryMs = retry && retryAfterHeader.test(retry) ? retryAfterMs(retry, headAt) : undefined;
  // Correlate provider-controlled IDs without publishing arbitrary header text.
  const digestHeader = (name: string, pattern: RegExp) => {
    const value = headers.get(name);
    return value && pattern.test(value) ? harnessSha256(value) : null;
  };
  const [requestIdSha256, xRequestIdSha256, cfRaySha256] = await Promise.all([
    digestHeader('request-id', requestIdHeader), digestHeader('x-request-id', requestIdHeader), digestHeader('cf-ray', cfRayHeader),
  ]);
  return Object.freeze({
    contentType: observedMediaTypes.find(type => type === media) ?? null,
    requestIdSha256, xRequestIdSha256, cfRaySha256,
    retryAfterMs: retryMs !== undefined && retryMs <= 7 * 86_400_000 ? retryMs : null,
  });
}

function nativeObserver(model: HarnessModelPolicy, diagnostics: EmbeddedHarnessModelDiagnostics) {
  const assembly = model.protocol === 'anthropic' ? new AnthropicAssembly(model.model) : new OpenAIAssembly(model.model);
  let result: { message: NativeMessage; usage: HarnessNativeUsage } | undefined;
  let responseHeaders: Promise<Readonly<EmbeddedResponseHeaders> | null> | undefined;
  const observer: HarnessNativeObserver = {
    sent(at) { diagnostics.requestSentAt = at; },
    head(status, at, headers) {
      diagnostics.httpStatus = status;
      diagnostics.responseHeadAt = at;
      if (headers) responseHeaders = safeResponseHeaders(headers, at).catch(() => null);
    },
    errorResponse(detail) { diagnostics.errorResponse = Object.freeze({ ...detail }); },
    bytes(count, at) {
      diagnostics.firstByteAt ??= at;
      diagnostics.lastByteAt = at;
      diagnostics.byteCount += count;
      diagnostics.chunkCount++;
    },
    event(value, at, name) {
      diagnostics.nativeEventCount++;
      requireNative(model.protocol !== 'openai' || name === undefined || name === 'message');
      if (value === '[DONE]' || value.type === 'message_stop') diagnostics.nativeTerminalAt = at;
      if (diagnostics.nativeEventCount > maxEvents) throw new HarnessNativeResponseLimitError();
      assembly.event(value);
    },
    complete(usage) { result = { message: assembly.complete(usage.finishReason), usage }; },
  };
  return { observer, result: () => result, responseHeaders: () => responseHeaders };
}

async function gatewayFailure(response: Response): Promise<ModelErrorCode> {
  const body: unknown = await response.json().catch(() => null);
  const error = object(body) && object(body.error) ? body.error.message : undefined;
  return safeCode(error) ? error : 'gateway_unavailable';
}

/** The adapter drains the gateway stream in process. Native content is assembled before settlement and released only after it succeeds. */
export async function runEmbeddedHarnessModel(request: EmbeddedModelRequest, scope: EmbeddedHarnessModelScope,
  options: EmbeddedHarnessGatewayOptions): Promise<EmbeddedHarnessModelResult> {
  const now = options.now ?? Date.now;
  const diagnostics: EmbeddedHarnessModelDiagnostics = { requestSentAt: null, responseHeadAt: null, firstByteAt: null,
    lastByteAt: null, nativeTerminalAt: null, finishedAt: null, httpStatus: null, responseHeaders: null, errorResponse: null, cancelReason: null,
    byteCount: 0, chunkCount: 0, nativeEventCount: 0 };
  const { model } = scope.run;
  const native = nativeObserver(model, diagnostics);
  const finish = async (code?: ModelErrorCode) => Object.freeze({ ...diagnostics, finishedAt: now(),
    responseHeaders: await native.responseHeaders() ?? null,
    cancelReason: code === 'client_disconnected' || code === 'deadline' ? code : null,
  });
  const fail = async (code: ModelErrorCode) => new EmbeddedHarnessModelError(code, await finish(code));
  if (request.model !== model.model) throw await fail('profile_unavailable');
  if (request.signal.aborted) throw await fail('client_disconnected');
  if (!Number.isSafeInteger(scope.deadlineAt) || Math.min(scope.run.deadlineAt, scope.deadlineAt) <= now()) throw await fail('deadline');
  const remaining = scope.remainingOutputTokens ?? model.maxOutputTokens;
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw await fail('budget_or_state');
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) throw await fail('invalid_request');
  const outputCap = Math.min(request.maxOutputTokens, model.maxOutputTokens, remaining);
  const path = model.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  let localRequest: Request;
  try {
    localRequest = new Request('https://pgc-harness.internal' + path, { method: 'POST', signal: request.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + scope.lease,
        [HARNESS_MODEL_HEADERS.task]: scope.run.taskId, [HARNESS_MODEL_HEADERS.generation]: scope.run.generation,
        [HARNESS_MODEL_HEADERS.requestId]: scope.requestId },
      body: JSON.stringify(wireRequest(request, model, outputCap)),
    });
  } catch { throw await fail('invalid_request'); }
  const response = await handleHarnessModelRequest(localRequest, { ...options, deadlineAt: scope.deadlineAt,
    allowTransportRetry: false, nativeObserver: native.observer });
  if (!response.ok) throw await fail(await gatewayFailure(response));
  if (!response.body) throw await fail('stream_incomplete');
  const reader = response.body.getReader();
  try {
    while (!(await reader.read()).done) { /* The gateway's observer assembled these bytes before settlement. */ }
  } catch (error) {
    const code = error instanceof Error && safeCode(error.message) ? error.message : 'stream_incomplete';
    throw await fail(code);
  } finally { reader.releaseLock(); }
  const result = native.result();
  if (!result) throw await fail('stream_incomplete');
  return { ...result.message, role: 'assistant', stopReason: result.usage.finishReason,
    usage: { inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens,
      reasoningTokens: result.usage.reasoningTokens ?? null }, diagnostics: await finish() };
}
