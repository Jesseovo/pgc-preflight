/** Version-selected comparison service. The deployment supplies the private handler and isolated nonce DB. */
import type { ComparisonHarnessOutboundScope, createComparisonBaselineBroker } from './harness-comparison-broker';
import { canonicalHarness, harnessHash } from './harness-policy';
import { HARNESS_MAX_REQUEST_MS, HARNESS_MODEL_HEADERS } from './harness-protocol';
import type { openComparisonTaskControl } from './harness-comparison-runner';
import type { StoredModelProfile } from './settings';

type ControlOptions = Parameters<typeof openComparisonTaskControl>[0];
type ProfileScope = Parameters<NonNullable<ControlOptions['bindVerifiedBroker']>>[0];
type Profile = { scopeSha256: string; profileId: string; profile: StoredModelProfile };
type ForwardScope = ComparisonHarnessOutboundScope;
type BaselineBroker = Awaited<ReturnType<typeof createComparisonBaselineBroker>>;
type BaselineScope = Parameters<ReturnType<BaselineBroker['bind']>>[0];
type Call =
  | { kind: 'profile'; scope: Readonly<ProfileScope> }
  | { kind: 'forward'; scope: Readonly<ForwardScope>; request: Request }
  | { kind: 'baseline'; scope: Readonly<BaselineScope>; url: string; init: RequestInit };
type Handler = (call: Call, signal: AbortSignal) => Promise<Profile | Response | null>;
type NonceDatabase = {
  scope: 'isolated-comparison'; id: string;
  connection: { prepare(sql: string): { bind(...values: (string | number)[]): { first(): Promise<unknown> } } };
};

export type ComparisonServiceContext = Readonly<{
  runId: string;
  authorizationSha256: string;
  runnerGrantSha256: string;
  dispatchGrantSha256: string;
  planSha256: string;
  manifestSha256: string;
  runnerDatabaseId: string;
  nonceDatabaseId: string;
  candidateVersion: string;
  notBefore: number;
  deadlineAt: number;
  taskIds: readonly string[];
}>;

export const COMPARISON_SERVICE_NONCE_SCHEMA = `CREATE TABLE IF NOT EXISTS comparison_service_nonces (
  run_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, nonce)
)`;
export const COMPARISON_SERVICE_ORIGIN = 'https://pgc.ovoxin.top';
export const COMPARISON_SERVICE_PROFILE_PATH = '/api/__harness-comparison/profile';
export const COMPARISON_SERVICE_FORWARD_PATH = '/api/__harness-comparison/forward';
export const COMPARISON_SERVICE_BASELINE_PATH = '/api/__harness-comparison/baseline';

const brokerVersion = 'x-pgc-comparison-broker-version';
const expectedVersion = 'x-pgc-comparison-expected-version';
const signatureHeader = 'x-pgc-comparison-signature';
const bodyShaHeader = 'x-pgc-comparison-body-sha256';
const responseSignatureHeader = 'x-pgc-comparison-response-signature';
const timestampHeader = 'x-pgc-comparison-timestamp';
const nonceHeader = 'x-pgc-comparison-nonce';
const taskHeader = HARNESS_MODEL_HEADERS.task;
const baselineSentinel = 'pgc-comparison-local-placeholder';
const baselineWire = {
  creation: { model: 'claude-opus-5-5', url: 'https://riffle-api.pages.dev/v1/messages', stages: ['build', 'polish', 'repair'] },
  review: { model: 'deepseek-flash', url: 'https://api.deepseek.com/chat/completions', stages: ['review', 'review_verify'] },
} as const;
const digestPattern = /^[a-f0-9]{64}$/;
const noncePattern = /^[a-f0-9]{32}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const taskPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const skewMs = 30_000;
const profileTimeMs = 15_000;
const maxProfileBytes = 32 * 1024;
const maxMetadataBytes = 2_048;
const maxNativeBytes = 24 * 1024 * 1024;
const maxStreamBytes = 12 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const stages = new Map<ForwardScope['stage'], string>([
  ['build', 'build-0-'], ['polish', 'polish-0-'], ['repair', 'repair-1-'], ['repair2', 'repair2-2-'],
  ['review', 'review-0-'], ['review_verify', 'review_verify-0-'],
]);
const profileScopeFields = ['taskId', 'slotSha256', 'admissionSha256', 'inputSha256', 'policySha256', 'grantSha256',
  'authorizationSha256', 'dispatchGrantSha256', 'planSha256', 'manifestSha256', 'runnerDatabaseId', 'ownerId',
  'operation', 'sourceSha256', 'evidenceSha256', 'modelConfigSha256', 'modelContractHash', 'deadlineAt'];
const forwardScopeFields = ['taskId', 'generation', 'lease', 'stageDeadlineAt', 'requestIdPrefix', 'jsonOutput', 'stage'];
const profileFields = ['name', 'baseUrl', 'model', 'protocol', 'enabled', 'vision', 'effort', 'maxOutputTokens', 'updatedAt', 'encryptedKey'];
type Bytes = Uint8Array<ArrayBuffer>;
type Proof = { signature: string; nonce: string; timestamp: number; taskId: string; path: string };
type FrozenContext = { value: ComparisonServiceContext; tasks: Set<string>; binding: string };
const unavailable = () => new Error('Comparison service unavailable');

function ensure(condition: unknown): asserts condition { if (!condition) throw unavailable(); }
function isString(pattern: RegExp, value: unknown): value is string { return typeof value === 'string' && pattern.test(value); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function frozenContext(context: ComparisonServiceContext): FrozenContext {
  ensure(exact(context, ['runId', 'authorizationSha256', 'runnerGrantSha256', 'dispatchGrantSha256', 'planSha256', 'manifestSha256',
    'runnerDatabaseId', 'nonceDatabaseId', 'candidateVersion', 'notBefore', 'deadlineAt', 'taskIds']) && Array.isArray(context.taskIds));
  const value = { ...context, taskIds: [...context.taskIds].sort() };
  const tasks = new Set(value.taskIds);
  ensure(isString(idPattern, value.runId) && isString(idPattern, value.runnerDatabaseId) && isString(idPattern, value.nonceDatabaseId) &&
    [value.authorizationSha256, value.runnerGrantSha256, value.dispatchGrantSha256, value.planSha256, value.manifestSha256]
      .every(item => isString(digestPattern, item)) && isString(uuidPattern, value.candidateVersion) &&
    integer(value.notBefore) && integer(value.deadlineAt) && value.notBefore < value.deadlineAt &&
    tasks.size === value.taskIds.length && tasks.size > 0 && tasks.size <= 24 && value.taskIds.every(task => isString(taskPattern, task)));
  return { value, tasks, binding: canonicalHarness(value) };
}
function inWindow(context: FrozenContext, now: number) {
  return integer(now) && now >= context.value.notBefore && now < context.value.deadlineAt;
}
function unhex(value: string): Bytes {
  return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16));
}
function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function authKey(secret: string) {
  ensure(isString(digestPattern, secret));
  return crypto.subtle.importKey('raw', unhex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sha(bytes: Bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); }
function requestInput(context: FrozenContext, proof: Omit<Proof, 'signature'>, bodySha: string) {
  return encoder.encode(JSON.stringify(['pgc-harness-comparison-http-request-v1', context.binding,
    context.value.candidateVersion, 'POST', proof.path, proof.taskId, bodySha, proof.timestamp, proof.nonce]));
}
function responseInput(context: FrozenContext, proof: Proof, status: number, media: string, bodySha: string | null) {
  return encoder.encode(JSON.stringify(['pgc-harness-comparison-http-response-v1', context.binding,
    proof.signature, proof.path, proof.taskId, proof.nonce, context.value.candidateVersion, status, media, bodySha]));
}
function profileScope(scope: unknown, context: FrozenContext): ProfileScope {
  ensure(exact(scope, profileScopeFields) && context.tasks.has(scope.taskId as string) &&
    scope.grantSha256 === context.value.runnerGrantSha256 && scope.authorizationSha256 === context.value.authorizationSha256 &&
    scope.dispatchGrantSha256 === context.value.dispatchGrantSha256 && scope.planSha256 === context.value.planSha256 &&
    scope.manifestSha256 === context.value.manifestSha256 && scope.runnerDatabaseId === context.value.runnerDatabaseId &&
    scope.deadlineAt === context.value.deadlineAt && isString(idPattern, scope.ownerId) &&
    ['slotSha256', 'admissionSha256', 'inputSha256', 'policySha256', 'sourceSha256', 'modelConfigSha256', 'modelContractHash']
      .every(field => isString(digestPattern, scope[field])) &&
    (scope.operation === 'creation' && scope.evidenceSha256 === null ||
      scope.operation === 'review' && isString(digestPattern, scope.evidenceSha256)));
  return Object.freeze({ ...scope }) as ProfileScope;
}
function forwardScope(scope: unknown, context: FrozenContext, now: number): ForwardScope {
  ensure(exact(scope, forwardScopeFields) && context.tasks.has(scope.taskId as string) &&
    isString(idPattern, scope.generation) && isString(digestPattern, scope.lease) &&
    integer(scope.stageDeadlineAt) && scope.stageDeadlineAt > now && scope.stageDeadlineAt <= context.value.deadlineAt &&
    stages.has(scope.stage as ForwardScope['stage']) && scope.requestIdPrefix === stages.get(scope.stage as ForwardScope['stage']) &&
    typeof scope.jsonOutput === 'boolean' && scope.jsonOutput === (scope.stage === 'review' || scope.stage === 'review_verify'));
  return Object.freeze({ ...scope }) as unknown as ForwardScope;
}
async function verifiedProfile(value: unknown, scope: ProfileScope): Promise<Profile> {
  ensure(exact(value, ['scopeSha256', 'profileId', 'profile']) &&
    value.scopeSha256 === await harnessHash(canonicalHarness(scope)) && isString(idPattern, value.profileId) &&
    !['constructor', 'prototype', '__proto__'].includes(value.profileId) && object(value.profile) &&
    Object.keys(value.profile).every(field => profileFields.includes(field)));
  const profile = value.profile;
  ensure(profile.enabled === true && typeof profile.vision === 'boolean' && (profile.protocol === 'anthropic' || profile.protocol === 'openai') &&
    typeof profile.model === 'string' && profile.model.length > 0 && profile.model.length <= 150 &&
    typeof profile.baseUrl === 'string' && profile.baseUrl.startsWith('https://') && profile.baseUrl.length <= 512 &&
    typeof profile.updatedAt === 'string' && profile.updatedAt.length <= 128 &&
    (profile.name === undefined || typeof profile.name === 'string' && profile.name.length <= 256) &&
    (profile.effort === undefined || ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(profile.effort as string)) &&
    (profile.maxOutputTokens === undefined || profile.maxOutputTokens === 0 || integer(profile.maxOutputTokens)) &&
    isString(/^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{23,}={0,2}$/, profile.encryptedKey) && profile.encryptedKey.length <= 8_192);
  return { scopeSha256: value.scopeSha256 as string, profileId: value.profileId, profile: { ...profile } as unknown as StoredModelProfile };
}

function deadlineSignal(now: number, deadline: number, source?: AbortSignal) {
  ensure(deadline > now);
  const timer = AbortSignal.timeout(Math.min(2_147_483_647, deadline - now));
  return source ? AbortSignal.any([source, timer]) : timer;
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(unavailable());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([stopped, work.then(value => {
      if (signal.aborted) { late?.(value); throw unavailable(); }
      return value;
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
function cancel(response: Request | Response | null) { void response?.body?.cancel().catch(() => {}); }
async function readBytes(message: Request | Response, max: number, signal: AbortSignal): Promise<Bytes> {
  const length = message.headers.get('content-length');
  ensure(message.body && (length === null || /^\d+$/.test(length) && Number(length) <= max));
  const reader = message.body.getReader();
  let total = 0, complete = false;
  let bytes = new Uint8Array(Math.min(max, 1024));
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      const end = total + part.value.byteLength;
      ensure(end <= max);
      if (end > bytes.length) {
        const expanded = new Uint8Array(Math.min(max, Math.max(end, bytes.length * 2)));
        expanded.set(bytes);
        bytes = expanded;
      }
      bytes.set(part.value, total);
      total = end;
    }
    complete = true;
    return bytes.subarray(0, total);
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function streamBytes(response: Response, signal: AbortSignal) {
  ensure(response.body);
  const reader = response.body.getReader();
  let total = 0, released = false;
  function release(cancelBody: boolean) {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', abort);
    if (cancelBody) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let controller: ReadableStreamDefaultController<Uint8Array>;
  function abort() {
    if (!released) { release(true); controller.error(unavailable()); }
  }
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      try {
        const part = await reader.read();
        if (released) return;
        if (part.done) { release(false); value.close(); return; }
        total += part.value.byteLength;
        ensure(total <= maxStreamBytes);
        value.enqueue(part.value);
      } catch { abort(); }
    },
    cancel() { release(true); },
  }, { highWaterMark: 0 });
}
function privateResponse(status: number, headers: HeadersInit = {}) {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });
}
function mediaType(response: Request | Response) {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
}

function forwardEnvelope(request: Request, scope: ForwardScope, native: Bytes) {
  const url = new URL(request.url), requestId = request.headers.get(HARNESS_MODEL_HEADERS.requestId);
  ensure(request.method === 'POST' && request.url === 'http://pgc-harness.internal' + url.pathname &&
    (url.pathname === '/v1/messages' || url.pathname === '/v1/chat/completions') &&
    isString(idPattern, requestId) && requestId.startsWith(scope.requestIdPrefix) &&
    request.headers.get(taskHeader) === scope.taskId && request.headers.get(HARNESS_MODEL_HEADERS.generation) === scope.generation &&
    request.headers.get('authorization') === 'Bearer ' + scope.lease && mediaType(request) === 'application/json' &&
    !request.headers.has('x-api-key') && native.length > 0);
  return nativeEnvelope({ scope, path: url.pathname, requestId }, native);
}
function nativeEnvelope(fields: Record<string, unknown>, native: Bytes) {
  const metadata = encoder.encode(JSON.stringify(fields));
  ensure(metadata.length <= maxMetadataBytes && native.length > 0 && native.length <= maxNativeBytes);
  const bytes = new Uint8Array(4 + metadata.length + native.length);
  new DataView(bytes.buffer).setUint32(0, metadata.length);
  bytes.set(metadata, 4);
  bytes.set(native, 4 + metadata.length);
  return bytes;
}
function unpackEnvelope(bytes: Bytes) {
  ensure(bytes.length > 4);
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  ensure(size > 0 && size <= maxMetadataBytes && bytes.length > 4 + size && bytes.length - 4 - size <= maxNativeBytes);
  const metadata: unknown = JSON.parse(decoder.decode(bytes.subarray(4, 4 + size)));
  return { metadata, native: bytes.subarray(4 + size) };
}
function parseForward(bytes: Bytes, context: FrozenContext, now: number, signal: AbortSignal): Call {
  const { metadata, native } = unpackEnvelope(bytes);
  ensure(exact(metadata, ['scope', 'path', 'requestId']) &&
    (metadata.path === '/v1/messages' || metadata.path === '/v1/chat/completions') && isString(idPattern, metadata.requestId));
  const scope = forwardScope(metadata.scope, context, now);
  ensure(metadata.requestId.startsWith(scope.requestIdPrefix) &&
    (scope.jsonOutput ? metadata.path === '/v1/chat/completions' : metadata.path === '/v1/messages'));
  return { kind: 'forward', scope, request: new Request('http://pgc-harness.internal' + metadata.path, {
    method: 'POST', body: native, signal, redirect: 'manual', headers: {
      'content-type': 'application/json', authorization: 'Bearer ' + scope.lease, [taskHeader]: scope.taskId,
      [HARNESS_MODEL_HEADERS.generation]: scope.generation, [HARNESS_MODEL_HEADERS.requestId]: metadata.requestId,
    },
  }) };
}

function baselineScope(value: unknown, context: FrozenContext): BaselineScope {
  ensure(exact(value, ['arm', 'taskId', 'ownerId', 'operation', 'stage']) && value.arm === 'A' &&
    context.tasks.has(value.taskId as string) && isString(idPattern, value.ownerId) &&
    (value.operation === 'creation' || value.operation === 'review') &&
    (baselineWire[value.operation].stages as readonly unknown[]).includes(value.stage));
  return Object.freeze({ ...value }) as unknown as BaselineScope;
}
function baselineHeaders(scope: BaselineScope, idempotency: unknown): Headers {
  ensure(isString(/^[A-Za-z0-9:._-]{1,256}$/, idempotency));
  return new Headers(scope.operation === 'creation' ? {
    accept: 'text/event-stream', 'content-type': 'application/json', 'idempotency-key': idempotency,
    'x-api-key': baselineSentinel, 'anthropic-version': '2023-06-01',
  } : {
    accept: 'text/event-stream', 'content-type': 'application/json', 'idempotency-key': idempotency,
    authorization: 'Bearer ' + baselineSentinel,
  });
}
function baselineTarget(scope: BaselineScope, body: string) {
  const payload: unknown = JSON.parse(body);
  const route = baselineWire[scope.operation];
  ensure(object(payload) && payload.model === route.model);
  return route.url;
}
function parseBaseline(bytes: Bytes, context: FrozenContext, signal: AbortSignal): Call {
  const { metadata, native } = unpackEnvelope(bytes);
  ensure(exact(metadata, ['scope', 'idempotencyKey']));
  const scope = baselineScope(metadata.scope, context);
  const body = decoder.decode(native);
  return { kind: 'baseline', scope, url: baselineTarget(scope, body), init: {
    method: 'POST', redirect: 'manual', headers: baselineHeaders(scope, metadata.idempotencyKey), body, signal,
  } };
}

export function createComparisonServiceClient(options: {
  context: ComparisonServiceContext; authKey: string; fetcher(request: Request): Promise<Response>; now?: () => number;
}) {
  const context = frozenContext(options.context), key = authKey(options.authKey), { fetcher, now = Date.now } = options;
  async function send(path: string, taskId: string, bytes: Bytes, signal: AbortSignal, media: string) {
    const timestamp = now();
    ensure(inWindow(context, timestamp) && !signal.aborted);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const proofInput = { path, taskId, timestamp, nonce };
    const bodySha = await sha(bytes);
    const signature = hex(await crypto.subtle.sign('HMAC', await key, requestInput(context, proofInput, bodySha)));
    ensure(!signal.aborted);
    const proof = { ...proofInput, signature };
    const response = await abortable(fetcher(new Request(COMPARISON_SERVICE_ORIGIN + path, {
      method: 'POST', redirect: 'manual', signal, body: bytes, headers: {
        'content-type': media, [taskHeader]: taskId, [expectedVersion]: context.value.candidateVersion,
        [signatureHeader]: signature, [bodyShaHeader]: bodySha, [nonceHeader]: nonce, [timestampHeader]: String(timestamp),
        'Cloudflare-Workers-Version-Overrides': `pgc-preflight="${context.value.candidateVersion}"`,
      },
    })), signal, cancel);
    try {
      ensure(!response.redirected && (response.status < 300 || response.status >= 400) &&
        response.headers.get(brokerVersion) === context.value.candidateVersion);
      return { response, proof };
    } catch {
      cancel(response);
      throw unavailable();
    }
  }
  async function verify(response: Response, proof: Proof, media: string, bodySha: string | null) {
    const signature = response.headers.get(responseSignatureHeader);
    ensure(isString(digestPattern, signature) && await crypto.subtle.verify('HMAC', await key, unhex(signature),
      responseInput(context, proof, response.status, media, bodySha)));
  }
  async function forward(path: string, taskId: string, bytes: Bytes, signal: AbortSignal): Promise<Response> {
    const { response, proof } = await send(path, taskId, bytes, signal, 'application/octet-stream');
    try {
      const media = response.ok ? 'text/event-stream' : '';
      ensure(mediaType(response) === media);
      await verify(response, proof, media, null);
      ensure(!signal.aborted);
      const version = context.value.candidateVersion;
      if (!response.ok) { cancel(response); return privateResponse(response.status, { [brokerVersion]: version }); }
      ensure(response.status !== 204 && response.status !== 205);
      return new Response(streamBytes(response, signal), { status: response.status, headers: {
        [brokerVersion]: version, 'content-type': media, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      } });
    } catch {
      cancel(response);
      throw unavailable();
    }
  }
  return {
    async readVerifiedProfile(scopeInput: ProfileScope, version: string): Promise<(Profile & { candidateVersion: string }) | null> {
      try {
        ensure(version === context.value.candidateVersion);
        const scope = profileScope(scopeInput, context), at = now();
        const signal = deadlineSignal(at, Math.min(context.value.deadlineAt, at + profileTimeMs));
        const { response, proof } = await send(COMPARISON_SERVICE_PROFILE_PATH, scope.taskId,
          encoder.encode(JSON.stringify(scope)), signal, 'application/json');
        try {
          if (!response.ok) {
            cancel(response);
            await verify(response, proof, '', null);
            ensure(response.status === 404 && !signal.aborted);
            return null;
          }
          ensure(mediaType(response) === 'application/json');
          const bytes = await readBytes(response, maxProfileBytes, signal);
          await verify(response, proof, 'application/json', await sha(bytes));
          const verified = await verifiedProfile(JSON.parse(decoder.decode(bytes)), scope);
          ensure(!signal.aborted);
          return { ...verified, candidateVersion: version };
        } catch {
          cancel(response);
          throw unavailable();
        }
      } catch { throw unavailable(); }
    },
    async forwardHarness(request: Request, scopeInput: ForwardScope, version: string): Promise<Response> {
      try {
        const at = now();
        ensure(version === context.value.candidateVersion && inWindow(context, at));
        const scope = forwardScope(scopeInput, context, at);
        const signal = deadlineSignal(at, Math.min(scope.stageDeadlineAt, at + HARNESS_MAX_REQUEST_MS), request.signal);
        const bytes = forwardEnvelope(request, scope, await readBytes(request, maxNativeBytes, signal));
        return await forward(COMPARISON_SERVICE_FORWARD_PATH, scope.taskId, bytes, signal);
      } catch { throw unavailable(); }
    },
    async forwardBaseline(scopeInput: BaselineScope, url: string, init: RequestInit, version: string): Promise<Response> {
      try {
        const at = now(), scope = baselineScope(scopeInput, context);
        ensure(version === context.value.candidateVersion && inWindow(context, at) &&
          init.method === 'POST' && init.redirect === 'manual' && init.signal instanceof AbortSignal &&
          !init.signal.aborted && typeof init.body === 'string' && init.body.length <= maxNativeBytes &&
          url === baselineTarget(scope, init.body));
        const supplied = new Headers(init.headers);
        const idempotencyKey = supplied.get('idempotency-key');
        const expected = baselineHeaders(scope, idempotencyKey);
        ensure([...supplied].length === [...expected].length && [...expected].every(([key, value]) => supplied.get(key) === value));
        const signal = deadlineSignal(at, Math.min(context.value.deadlineAt, at + HARNESS_MAX_REQUEST_MS), init.signal);
        const response = await forward(COMPARISON_SERVICE_BASELINE_PATH, scope.taskId,
          nativeEnvelope({ scope, idempotencyKey }, encoder.encode(init.body)), signal);
        ensure(response.ok);
        return response;
      } catch { throw unavailable(); }
    },
  };
}

export function createComparisonServiceHandler(options: {
  context: ComparisonServiceContext; authKey: string; executingVersion: string | undefined;
  nonceDatabase: NonceDatabase; handle: Handler; now?: () => number;
}) {
  const context = frozenContext(options.context), key = authKey(options.authKey);
  const { nonceDatabase, executingVersion, handle, now = Date.now } = options;
  ensure(nonceDatabase.scope === 'isolated-comparison' && nonceDatabase.id === context.value.nonceDatabaseId);
  const database = nonceDatabase.connection;
  async function reply(proof: Proof, status: number, media = '', body: BodyInit | null = null, bodySha: string | null = null) {
    const signature = hex(await crypto.subtle.sign('HMAC', await key, responseInput(context, proof, status, media, bodySha)));
    const headers = new Headers({ [brokerVersion]: context.value.candidateVersion, [responseSignatureHeader]: signature,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (media) headers.set('content-type', media);
    return new Response(body, { status, headers });
  }
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.url !== COMPARISON_SERVICE_ORIGIN + path ||
        (path !== COMPARISON_SERVICE_PROFILE_PATH && path !== COMPARISON_SERVICE_FORWARD_PATH && path !== COMPARISON_SERVICE_BASELINE_PATH)) {
      cancel(request);
      return privateResponse(404);
    }
    if (executingVersion !== context.value.candidateVersion) { cancel(request); return privateResponse(503); }
    const profile = path === COMPARISON_SERVICE_PROFILE_PATH;
    try {
      const at = now();
      const taskId = request.headers.get(taskHeader), nonce = request.headers.get(nonceHeader);
      const signature = request.headers.get(signatureHeader), declaredBodySha = request.headers.get(bodyShaHeader);
      const time = request.headers.get(timestampHeader);
      const timestamp = Number(time);
      ensure(request.method === 'POST' && mediaType(request) === (profile ? 'application/json' : 'application/octet-stream') &&
        inWindow(context, at) && request.headers.get(expectedVersion) === executingVersion &&
        isString(taskPattern, taskId) && context.tasks.has(taskId) && isString(noncePattern, nonce) &&
        isString(digestPattern, signature) && isString(digestPattern, declaredBodySha) && integer(timestamp) && String(timestamp) === time &&
        inWindow(context, timestamp) && Math.abs(at - timestamp) <= skewMs);
      const proof = { path, taskId, nonce, timestamp, signature };
      const requestSignal = deadlineSignal(at, Math.min(context.value.deadlineAt, at + profileTimeMs), request.signal);
      // Authenticate the declared digest before allocating a request buffer. The
      // handler and the nonce ledger still require the actual bytes to match it.
      ensure(await crypto.subtle.verify('HMAC', await key, unhex(signature), requestInput(context, proof, declaredBodySha)) &&
        !requestSignal.aborted);
      const bytes = await readBytes(request, profile ? maxProfileBytes : maxNativeBytes + maxMetadataBytes + 4, requestSignal);
      ensure(await sha(bytes) === declaredBodySha);
      const verifiedAt = now();
      ensure(inWindow(context, verifiedAt) && Math.abs(verifiedAt - timestamp) <= skewMs && !requestSignal.aborted);
      const call: Call = profile ? { kind: 'profile', scope: profileScope(JSON.parse(decoder.decode(bytes)), context) } :
        path === COMPARISON_SERVICE_FORWARD_PATH ? parseForward(bytes, context, verifiedAt, request.signal) :
          parseBaseline(bytes, context, request.signal);
      ensure(call.scope.taskId === taskId);
      const deadline = Math.min(call.kind === 'forward' ? call.scope.stageDeadlineAt : context.value.deadlineAt,
        at + (call.kind === 'profile' ? profileTimeMs : HARNESS_MAX_REQUEST_MS));
      const signal = deadlineSignal(verifiedAt, deadline, request.signal);
      const inserted = await abortable(database.prepare(`INSERT INTO comparison_service_nonces (run_id,nonce,expires_at)
        VALUES (?,?,?) ON CONFLICT(run_id,nonce) DO NOTHING RETURNING nonce`)
        .bind(context.value.runId, nonce, context.value.deadlineAt).first(), signal);
      ensure(object(inserted) && inserted.nonce === nonce && inWindow(context, now()) && now() < deadline && !signal.aborted);
      if (call.kind === 'forward') call.request = new Request(call.request, { signal });
      if (call.kind === 'baseline') call.init.signal = signal;
      let result: Profile | Response | null;
      try { result = await abortable(handle(call, signal), signal, value => { if (value instanceof Response) cancel(value); }); }
      catch { return reply(proof, 503); }
      if (call.kind === 'profile') {
        if (result === null) return reply(proof, 404);
        const bytes = encoder.encode(JSON.stringify(await verifiedProfile(result, call.scope)));
        ensure(bytes.length <= maxProfileBytes && !signal.aborted);
        return reply(proof, 200, 'application/json', bytes, await sha(bytes));
      }
      if (!(result instanceof Response)) return reply(proof, 503);
      if (result.redirected || result.status < 200 || result.status >= 300 && result.status < 400) {
        cancel(result);
        return reply(proof, 503);
      }
      if (!result.ok) {
        cancel(result);
        return reply(proof, result.status);
      }
      if (mediaType(result) !== 'text/event-stream' || !result.body || signal.aborted) {
        cancel(result);
        return reply(proof, 503);
      }
      return reply(proof, result.status, 'text/event-stream', streamBytes(result, signal));
    } catch {
      cancel(request);
      return privateResponse(403);
    }
  };
}
