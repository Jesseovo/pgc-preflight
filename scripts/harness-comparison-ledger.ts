/** Private research dispatch. Only an isolated adapter host constructs this ledger and holds its slot authorities. */
import { canonicalHarness, harnessHash } from '../server/harness-policy';

type Statement = {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
};
export interface ComparisonLedgerDatabase {
  prepare(sql: string): Statement;
}

type Scope = 'formal' | 'rehearsal';
export type ComparisonStage = 'build' | 'polish' | 'repair' | 'repair2' | 'review' | 'review_verify';
export type ComparisonGrant = {
  schemaVersion: 1;
  purpose: 'isolated-comparison';
  scope: Scope;
  runId: string;
  ledgerDatabaseId: string;
  planSha256: string;
  manifestSha256: string;
  admittedSlotsSha256: string;
  authorizationSha256: string;
  maxRequests: number;
  maxOutputTokens: number;
  notBefore: number;
  deadlineAt: number;
};
export type ComparisonStageRoute = {
  transportId: string;
  modelContractHash: string;
  protocol: 'anthropic' | 'openai';
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  stream: boolean;
  jsonMode: boolean;
  maxOutputTokens: number;
};
export type ComparisonAdmittedSlot = {
  slotId: string;
  taskId: string;
  ownerId: string;
  caseId: string;
  arm: 'A' | 'B';
  operation: 'creation' | 'review';
  // Review material may be unknown when the aggregate grant is approved.
  sourceSha256: string | null;
  evidenceSha256: string | null;
  modelConfigSha256: string;
  stages: Partial<Record<ComparisonStage, ComparisonStageRoute>>;
};

type State = 'reserved' | 'forwarding' | 'completed' | 'failed' | 'unknown';
type FailureCode =
  | 'provider-rejected' | 'invalid-response' | 'truncated' | 'transport-outcome-unknown'
  | 'interrupted-before-forward' | 'deadline-before-transport' | 'usage-exceeds-reservation';
type Usage = { inputTokens: number | null; outputTokens: number | null };
type FailedOutcome = { state: 'failed'; failureCode: 'provider-rejected' | 'invalid-response' | 'truncated' } & Usage;
type SettlementOutcome = ({ state: 'completed' } & Usage) | FailedOutcome | { state: 'unknown' };
type Outcome<T> =
  | ({ state: 'completed'; result: T } & Usage)
  | FailedOutcome
  | { state: 'unknown' };
type TransportInput = {
  body: Uint8Array; idempotencyKey: string; deadlineAt: number; taskId: string; requestId: string; stage: ComparisonStage;
};
export type ComparisonTransport<T> = {
  kind: 'approved-provider' | 'synthetic';
  modelContractHash: string;
  // The isolated host registers a fixed route and credential. The transport
  // consumes the original bytes, enforces the deadline, and settles only after
  // the response ends. A provider key already fixed by the adapter stays in it.
  send(input: TransportInput): Promise<Outcome<T>>;
};
export type ComparisonStreamFrame =
  | { kind: 'data'; bytes: Uint8Array }
  | { kind: 'terminal'; bytes: Uint8Array; outcome: SettlementOutcome };
const nativeEndReasons = ['clean-terminal', 'transport-open-error', 'transport-http-rejected', 'unexpected-http-response',
  'upstream-eof-before-terminal', 'upstream-body-read-error', 'native-sse-error', 'truncated-sse-frame',
  'invalid-sse-frame', 'invalid-terminal-usage'] as const;
export type ComparisonNativeStreamEnd = typeof nativeEndReasons[number];
type StreamEnd = 'terminal' | 'http-rejection' | 'transport-error' | 'deadline' | 'inbound-abort' | 'downstream-cancel';
export type ComparisonStreamObservation =
  | { kind: 'head'; status: number }
  | { kind: 'bytes'; size: number }
  | { kind: 'frame' }
  | { kind: 'end'; reason: ComparisonNativeStreamEnd; errorType?: unknown; errorCode?: unknown };
type StreamDiagnostic = {
  httpStatus: number | null; headAt: number | null; lastByteAt: number | null; lastFrameAt: number | null;
  byteCount: number; frameCount: number; nativeEnd: ComparisonNativeStreamEnd | null;
  providerErrorType: string | null; providerErrorCode: string | null; streamEnd: StreamEnd; observedAt: number;
};
const providerErrors = new Set(['api_error', 'authentication_error', 'bad_request', 'billing_error', 'content_filter',
  'context_length_exceeded', 'engine_overloaded', 'insufficient_balance', 'internal_server_error', 'invalid_request',
  'invalid_request_error', 'model_not_found', 'not_found_error', 'overloaded_error', 'permission_error', 'rate_limit_error',
  'rate_limit_exceeded', 'request_too_large', 'server_error', 'server_overloaded', 'service_unavailable', 'timeout_error', 'upstream_timeout']);
const providerError = (value: unknown) => typeof value === 'string' && providerErrors.has(value) ? value : value == null ? null : 'other';
export type ComparisonStreamingTransport = {
  kind: 'approved-provider' | 'synthetic';
  modelContractHash: string;
  // Trusted protocol adapters split the original stream into exact bytes. No
  // protocol terminator may appear in a data frame. The sole terminal frame
  // carries original terminator bytes and validated end-of-stream accounting.
  // EOF or rejection without such an outcome is not evidence of completion.
  open(input: TransportInput & { signal: AbortSignal; observe?(event: ComparisonStreamObservation): void }): Promise<
    | { kind: 'stream'; head: Response; frames: ReadableStream<ComparisonStreamFrame> }
    | { kind: 'rejected'; response: Response; outcome: FailedOutcome }
  >;
};
export type ComparisonDispatchReceipt = Usage & {
  schemaVersion: 1;
  scope: Scope;
  runId: string;
  ledgerDatabaseId: string;
  planSha256: string;
  manifestSha256: string;
  authorizationSha256: string;
  slotId: string;
  slotSha256: string;
  taskId: string;
  ownerId: string;
  caseId: string;
  arm: 'A' | 'B';
  operation: 'creation' | 'review';
  sourceSha256: string;
  evidenceSha256: string | null;
  modelConfigSha256: string;
  stage: ComparisonStage;
  requestId: string;
  attempt: 1;
  bodySha256: string;
  modelContractHash: string;
  outputCap: number;
  accountedOutputTokens: number;
  state: State;
  failureCode: FailureCode | null;
  reservedAt: number;
  forwardingAt: number | null;
  settledAt: number | null;
};
export type ComparisonStreamingDispatch =
  | { receipt: ComparisonDispatchReceipt; dispatched: false }
  | { receipt: ComparisonDispatchReceipt; dispatched: true; response: Response | null;
      completion: Promise<ComparisonDispatchReceipt>; diagnostics: Promise<void> };

export const COMPARISON_LEDGER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS comparison_dispatch_grant (
    id INTEGER PRIMARY KEY CHECK (id=1),
    grant_sha256 TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS comparison_dispatch_review_material (
    case_id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, evidence_sha256 TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS comparison_dispatch_attempts (
    slot_id TEXT NOT NULL, request_id TEXT NOT NULL, slot_sha256 TEXT NOT NULL,
    stage TEXT NOT NULL, body_sha256 TEXT NOT NULL, model_contract_hash TEXT NOT NULL,
    output_cap INTEGER NOT NULL CHECK (output_cap>0),
    state TEXT NOT NULL CHECK (state IN ('reserved','forwarding','completed','failed','unknown')),
    failure_code TEXT, input_tokens INTEGER, output_tokens INTEGER,
    reserved_at INTEGER NOT NULL, forwarding_at INTEGER, settled_at INTEGER,
    PRIMARY KEY(slot_id,request_id)
  )`,
  `CREATE TABLE IF NOT EXISTS comparison_dispatch_transitions (
    slot_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY(slot_id,request_id,state)
  )`,
  `CREATE TABLE IF NOT EXISTS comparison_dispatch_stream_diagnostics (
    slot_id TEXT NOT NULL, request_id TEXT NOT NULL, http_status INTEGER, head_at INTEGER,
    last_byte_at INTEGER, last_frame_at INTEGER, byte_count INTEGER NOT NULL, frame_count INTEGER NOT NULL,
    native_end TEXT, provider_error_type TEXT, provider_error_code TEXT, stream_end TEXT NOT NULL, observed_at INTEGER NOT NULL,
    PRIMARY KEY(slot_id,request_id),
    FOREIGN KEY(slot_id,request_id) REFERENCES comparison_dispatch_attempts(slot_id,request_id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS comparison_dispatch_on_reserve AFTER INSERT ON comparison_dispatch_attempts
    BEGIN
      INSERT INTO comparison_dispatch_transitions VALUES (NEW.slot_id,NEW.request_id,NEW.state,NEW.reserved_at);
    END`,
  `CREATE TRIGGER IF NOT EXISTS comparison_dispatch_on_transition AFTER UPDATE OF state ON comparison_dispatch_attempts
    BEGIN
      INSERT INTO comparison_dispatch_transitions
      VALUES (NEW.slot_id,NEW.request_id,NEW.state,COALESCE(NEW.settled_at,NEW.forwarding_at));
    END`,
] as const;

type AttemptRow = {
  slot_id: string; request_id: string; slot_sha256: string; stage: ComparisonStage;
  body_sha256: string; model_contract_hash: string; output_cap: number; state: State;
  failure_code: FailureCode | null; input_tokens: number | null; output_tokens: number | null;
  reserved_at: number; forwarding_at: number | null; settled_at: number | null;
};

const hash = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const creationStages: readonly ComparisonStage[] = ['build', 'polish', 'repair', 'repair2'];
const reviewStages: readonly ComparisonStage[] = ['review', 'review_verify'];
const maxWireBytes = 24 * 1024 * 1024;
const wireDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const tokenCount = (value: unknown): value is number | null => value === null || value === 0 || positive(value);
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value: unknown, keys: string[]) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateSlot(slot: ComparisonAdmittedSlot) {
  need(exactKeys(slot, ['slotId', 'taskId', 'ownerId', 'caseId', 'arm', 'operation', 'sourceSha256', 'evidenceSha256', 'modelConfigSha256', 'stages']) &&
    [slot.slotId, slot.taskId, slot.ownerId, slot.caseId].every(value => matches(id, value)) &&
    (slot.arm === 'A' || slot.arm === 'B') && (slot.operation === 'creation' || slot.operation === 'review') &&
    matches(hash, slot.modelConfigSha256) &&
    (slot.operation === 'review'
      ? (matches(hash, slot.sourceSha256) && matches(hash, slot.evidenceSha256)) || (slot.sourceSha256 === null && slot.evidenceSha256 === null)
      : matches(hash, slot.sourceSha256) && slot.evidenceSha256 === null) && isRecord(slot.stages),
  'Invalid admitted comparison slot');
  const allowed = slot.operation === 'creation' ? creationStages : reviewStages;
  const stages = Object.entries(slot.stages);
  need(stages.length > 0 && stages.every(([stage]) => allowed.includes(stage as ComparisonStage)), 'Invalid admitted comparison stages');
  for (const [, route] of stages) {
    need(exactKeys(route, ['transportId', 'modelContractHash', 'protocol', 'model', 'effort', 'stream', 'jsonMode', 'maxOutputTokens']) &&
      matches(id, route.transportId) && matches(hash, route.modelContractHash) &&
      (route.protocol === 'anthropic' || route.protocol === 'openai') &&
      typeof route.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,149}$/.test(route.model) &&
      (route.effort === null || ['low', 'medium', 'high', 'xhigh', 'max'].includes(route.effort)) &&
      typeof route.stream === 'boolean' && typeof route.jsonMode === 'boolean' && (!route.jsonMode || route.protocol === 'openai') &&
      positive(route.maxOutputTokens), 'Invalid admitted comparison model route');
  }
}
function sortedSlots(slots: readonly ComparisonAdmittedSlot[]): ComparisonAdmittedSlot[] {
  need(Array.isArray(slots) && slots.length > 0 && slots.length <= 24, 'Invalid comparison slot count');
  for (const slot of slots) validateSlot(slot);
  need(new Set(slots.map(slot => slot.slotId)).size === slots.length &&
    new Set(slots.map(slot => slot.taskId)).size === slots.length &&
    new Set(slots.map(slot => `${slot.caseId}/${slot.arm}/${slot.operation}`)).size === slots.length,
  'Duplicate admitted comparison identity');
  const reviewCases = new Map<string, string>();
  for (const slot of slots) {
    if (slot.operation !== 'review') continue;
    const material = canonicalHarness([slot.sourceSha256, slot.evidenceSha256]);
    need(!reviewCases.has(slot.caseId) || reviewCases.get(slot.caseId) === material, 'Review arms must share the same material lock');
    reviewCases.set(slot.caseId, material);
  }
  return [...slots].sort((a, b) => a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0);
}
export function comparisonAdmittedSlotsSha256(slots: readonly ComparisonAdmittedSlot[]) {
  return harnessHash(canonicalHarness(['comparison-admitted-slots-v1', sortedSlots(slots)]));
}

function wireOutputCap(body: Uint8Array, route: ComparisonStageRoute) {
  need(body.byteLength > 0 && body.byteLength <= maxWireBytes, 'Invalid comparison wire size');
  let raw: unknown, text: string;
  try {
    text = wireDecoder.decode(body);
    raw = JSON.parse(text);
  } catch { throw new Error('Invalid comparison wire JSON'); }
  // A and B construct provider bytes with JSON.stringify. Compare that exact
  // format to rule out duplicate keys with different downstream interpretation.
  need(JSON.stringify(raw) === text, 'Comparison wire must be the original compact JSON encoding');
  need(isRecord(raw) && raw.model === route.model && raw.stream === route.stream &&
    Array.isArray(raw.messages) && raw.messages.length > 0, 'Comparison wire model contract mismatch');
  const maxTokens = raw.max_tokens ?? raw.max_completion_tokens;
  need(positive(maxTokens) && maxTokens <= route.maxOutputTokens &&
    !(Object.hasOwn(raw, 'max_tokens') && Object.hasOwn(raw, 'max_completion_tokens')) &&
    (route.protocol === 'openai' || !Object.hasOwn(raw, 'max_completion_tokens')),
  'Comparison wire output cap mismatch');
  // Reject multiplicative completions and provider-side routing overrides.
  need((raw.n === undefined || raw.n === 1) &&
    ['provider', 'base_url', 'baseUrl', 'endpoint', 'url', 'api_key', 'apiKey', 'headers', 'authorization']
      .every(key => !Object.hasOwn(raw, key)),
  'Comparison wire routing mismatch');
  const format = raw.response_format;
  need(route.jsonMode ? exactKeys(format, ['type']) && (format as Record<string, unknown>).type === 'json_object' : format === undefined,
    'Comparison wire JSON mode mismatch');
  const thinking = raw.thinking;
  const effort = route.protocol === 'anthropic'
    ? (isRecord(raw.output_config) ? raw.output_config.effort : undefined)
    : raw.reasoning_effort;
  need(route.effort === null ? effort === undefined && thinking === undefined : effort === route.effort && isRecord(thinking) &&
    thinking.type === (route.protocol === 'anthropic' ? 'adaptive' : 'enabled'), 'Comparison wire effort mismatch');
  return maxTokens;
}

async function bodyDigest(body: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const COMPARISON_SYNTHETIC_KEEPALIVE_FRAME = ': pgc-comparison-keepalive\n\n';
const syntheticKeepaliveMs = 10_000;
const syntheticKeepaliveBytes = new TextEncoder().encode(COMPARISON_SYNTHETIC_KEEPALIVE_FRAME);

/** One outstanding source read and at most one demanded keepalive timer. */
function keepaliveFrameReader(reader: ReadableStreamDefaultReader<ComparisonStreamFrame>) {
  type ReadResult = { value: ReadableStreamReadResult<ComparisonStreamFrame> } | { failed: true };
  let pending = false, stopped = false;
  let ready: ReadResult | undefined;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function deliver(result: ReadResult) {
    if (stopped) return;
    ready = result;
    wake?.();
  }
  return {
    async next(canKeepalive: boolean) {
      if (!pending && !stopped) {
        pending = true;
        void reader.read().then(value => deliver({ value }), () => deliver({ failed: true }));
      }
      if (!ready && !stopped) await new Promise<void>(resolve => {
        wake = resolve;
        if (canKeepalive) timer = setTimeout(resolve, syntheticKeepaliveMs);
      });
      clearTimeout(timer);
      wake = undefined;
      if (stopped) return null;
      const result = ready;
      if (!result) return null;
      ready = undefined;
      pending = false;
      if ('failed' in result) throw new Error('Comparison source read failed');
      return result.value;
    },
    stop() {
      stopped = true;
      ready = undefined;
      clearTimeout(timer);
      wake?.();
    },
  };
}

/** Only the trusted protocol adapter reads the supplier stream. The ledger owns the last frame. */
async function streamResponse(input: TransportInput, open: ComparisonStreamingTransport['open'], initial: ComparisonDispatchReceipt,
  settle: (outcome?: SettlementOutcome) => Promise<{ receipt: ComparisonDispatchReceipt; settled: boolean }>,
  saveDiagnostic: (value: StreamDiagnostic) => Promise<unknown>, now: () => number, signal?: AbortSignal,
  syntheticKeepalive = false): Promise<ComparisonStreamingDispatch> {
  const upstream = new AbortController();
  let reader: ReadableStreamDefaultReader<ComparisonStreamFrame> | undefined;
  let keepalive: ReturnType<typeof keepaliveFrameReader> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let finishPromise: ReturnType<typeof settle> | undefined;
  let finishReceipt!: (receipt: ComparisonDispatchReceipt) => void, failReceipt!: (error: unknown) => void;
  const completion = new Promise<ComparisonDispatchReceipt>((resolve, reject) => { finishReceipt = resolve; failReceipt = reject; });
  void completion.catch(() => {});
  let doneDiagnostic!: () => void;
  const diagnostics = new Promise<void>(resolve => { doneDiagnostic = resolve; });
  const observed: Omit<StreamDiagnostic, 'streamEnd' | 'observedAt'> = {
    httpStatus: null, headAt: null, lastByteAt: null, lastFrameAt: null, byteCount: 0, frameCount: 0,
    nativeEnd: null, providerErrorType: null, providerErrorCode: null,
  };
  function observe(event: ComparisonStreamObservation) {
    if (finishPromise) return;
    if (event.kind === 'head' && observed.headAt === null && Number.isSafeInteger(event.status) && event.status >= 100 && event.status <= 599) {
      observed.httpStatus = event.status; observed.headAt = now();
    } else if (event.kind === 'bytes' && Number.isSafeInteger(event.size) && event.size > 0) {
      observed.lastByteAt = now(); observed.byteCount += event.size;
    } else if (event.kind === 'frame') {
      observed.lastFrameAt = now(); observed.frameCount++;
    } else if (event.kind === 'end' && observed.nativeEnd === null && nativeEndReasons.includes(event.reason)) {
      observed.nativeEnd = event.reason;
      if (event.reason === 'native-sse-error') {
        observed.providerErrorType = providerError(event.errorType); observed.providerErrorCode = providerError(event.errorCode);
      }
    }
  }
  let stopped!: () => void;
  const stoppedBeforeHead = new Promise<null>(resolve => { stopped = () => resolve(null); });
  const terminate = () => {
    if (!closed && controller) { closed = true; controller.error(new Error('Comparison stream ended without a verified terminal frame')); }
  };
  function finish(streamEnd: StreamEnd, outcome?: SettlementOutcome) {
    if (!finishPromise) {
      finishPromise = settle(outcome);
      const diagnostic = { ...observed, streamEnd, observedAt: now() };
      void Promise.resolve().then(() => saveDiagnostic(diagnostic)).catch(() => {}).then(doneDiagnostic);
      void finishPromise.then(value => finishReceipt(value.receipt), () => failReceipt(new Error('Comparison stream settlement could not be verified'))).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortInbound);
      });
    }
    return finishPromise;
  }
  function abort(reason: StreamEnd = 'transport-error') {
    if (!upstream.signal.aborted) {
      upstream.abort(); stopped(); terminate();
      keepalive?.stop();
      void reader?.cancel().catch(() => {});
    }
    void finish(reason).catch(() => {});
  }
  const abortInbound = () => abort('inbound-abort');
  const timer = setTimeout(() => abort('deadline'), Math.max(0, Math.min(2_147_483_647, input.deadlineAt - now())));
  signal?.addEventListener('abort', abortInbound, { once: true });
  if (signal?.aborted) abortInbound();
  else if (now() >= input.deadlineAt) abort('deadline');
  let invoked = false;
  const opened = Promise.resolve().then(() => {
    if (upstream.signal.aborted) return null;
    invoked = true;
    return open({ ...input, signal: upstream.signal, observe });
  }).then(reply => {
    if (!upstream.signal.aborted || !reply) return reply;
    if (reply.kind === 'stream') void reply.frames.cancel().catch(() => {});
    else if (reply.kind === 'rejected') void reply.response.body?.cancel().catch(() => {});
    return null;
  }).catch(() => { abort(); return null; });
  const reply = await Promise.race([opened, stoppedBeforeHead]);
  if (!invoked) return { receipt: await completion, dispatched: false };
  const result = { receipt: initial, dispatched: true as const, completion, diagnostics };
  if (!reply || upstream.signal.aborted) return { ...result, response: null };
  if (reply.kind === 'rejected') {
    if (reply.response instanceof Response && !reply.response.ok && reply.outcome?.state === 'failed') {
      const settled = await finish('http-rejection', reply.outcome).catch(() => null);
      if (settled?.settled && settled.receipt.state === 'failed' && !upstream.signal.aborted) return { ...result, response: reply.response };
    }
    void reply.response?.body?.cancel().catch(() => {});
    abort();
    return { ...result, response: null };
  }
  if (!(reply.head instanceof Response) || !reply.head.ok || [204, 205].includes(reply.head.status) || reply.head.body ||
      !/^text\/event-stream(?:\s*;|$)/i.test(reply.head.headers.get('content-type') ?? '') || !(reply.frames instanceof ReadableStream)) {
    if (reply.head instanceof Response) void reply.head.body?.cancel().catch(() => {});
    if (reply.frames instanceof ReadableStream) void reply.frames.cancel().catch(() => {});
    abort();
    return { ...result, response: null };
  }
  try { reader = reply.frames.getReader(); } catch { abort(); return { ...result, response: null }; }
  if (syntheticKeepalive) keepalive = keepaliveFrameReader(reader);
  let nativeFrameDelivered = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull(value) {
      try {
        // Keep the native stream start (including an optional UTF-8 BOM)
        // untouched. A comment is safe only between complete adapter frames.
        const next = keepalive ? await keepalive.next(nativeFrameDelivered) : await reader!.read();
        if (closed || upstream.signal.aborted) return;
        if (now() >= input.deadlineAt) { abort('deadline'); return; }
        if (next === null) { value.enqueue(syntheticKeepaliveBytes.slice()); return; }
        if (next.done) { abort(); return; }
        const frame = next.value;
        if (!(frame?.bytes instanceof Uint8Array) || frame.bytes.length === 0 || frame.bytes.length > 8 * 1024 * 1024) { abort(); return; }
        const bytes = new Uint8Array(frame.bytes);
        if (frame.kind === 'data') { nativeFrameDelivered = true; value.enqueue(bytes); return; }
        if (frame.kind !== 'terminal') { abort(); return; }
        const settled = await finish('terminal', frame.outcome);
        if (closed) return;
        if (!settled.settled || settled.receipt.state !== 'completed' || now() >= input.deadlineAt) { abort(); return; }
        closed = true;
        value.enqueue(bytes);
        value.close();
        void reader?.cancel().catch(() => {});
      } catch { abort(); }
    },
    cancel() { closed = true; abort('downstream-cancel'); },
  }, { highWaterMark: 0 });
  return { ...result, response: new Response(body, { status: reply.head.status, statusText: reply.head.statusText, headers: reply.head.headers }) };
}

/** The host supplies a separately verified grant, admitted snapshot, distinct authorities and fixed transports. */
export async function openComparisonLedger<T>(options: {
  database: { scope: 'isolated-comparison'; id: string; connection: ComparisonLedgerDatabase };
  grant: ComparisonGrant;
  slots: readonly ComparisonAdmittedSlot[];
  authorities: ReadonlyMap<string, object>;
  transports?: ReadonlyMap<string, ComparisonTransport<T>>;
  streamingTransports?: ReadonlyMap<string, ComparisonStreamingTransport>;
  syntheticKeepalive?: boolean;
  now?: () => number;
}) {
  const { database, now = Date.now, syntheticKeepalive = false } = options;
  need(database.scope === 'isolated-comparison' && matches(id, database.id), 'An isolated comparison ledger database is required');
  const supplied = options.grant;
  need(exactKeys(supplied, ['schemaVersion', 'purpose', 'scope', 'runId', 'ledgerDatabaseId', 'planSha256', 'manifestSha256', 'admittedSlotsSha256',
    'authorizationSha256', 'maxRequests', 'maxOutputTokens', 'notBefore', 'deadlineAt']) &&
    supplied.schemaVersion === 1 && supplied.purpose === 'isolated-comparison' &&
    (supplied.scope === 'formal' || supplied.scope === 'rehearsal') && matches(id, supplied.runId) &&
    supplied.ledgerDatabaseId === database.id &&
    [supplied.planSha256, supplied.manifestSha256, supplied.admittedSlotsSha256, supplied.authorizationSha256].every(value => matches(hash, value)) &&
    positive(supplied.maxRequests) && positive(supplied.maxOutputTokens) &&
    positive(supplied.notBefore) && positive(supplied.deadlineAt) && supplied.notBefore < supplied.deadlineAt,
  'An explicit isolated comparison grant with request and output caps is required');
  const grant = { ...supplied };
  need(typeof syntheticKeepalive === 'boolean' && (!syntheticKeepalive || grant.scope === 'rehearsal'),
    'Comparison keepalives are limited to isolated rehearsal transport');
  const snapshot = structuredClone(sortedSlots(options.slots));
  need(await comparisonAdmittedSlotsSha256(snapshot) === grant.admittedSlotsSha256, 'Admitted slot snapshot conflicts with the comparison grant');
  const authorities = new Set<object>();
  type Route = { route: ComparisonStageRoute; send?: ComparisonTransport<T>['send']; open?: ComparisonStreamingTransport['open'] };
  const slots = new Map<string, {
    identity: ComparisonAdmittedSlot;
    sha256: string;
    authority: object;
    routes: Map<ComparisonStage, Route>;
  }>();
  for (const identity of snapshot) {
    const authority = options.authorities.get(identity.slotId);
    need(authority && typeof authority === 'object' && !authorities.has(authority), 'Each admitted slot needs a distinct authority');
    authorities.add(authority);
    const routes = new Map<ComparisonStage, Route>();
    for (const [stage, route] of Object.entries(identity.stages)) {
      const transport = options.transports?.get(route.transportId), streaming = options.streamingTransports?.get(route.transportId);
      const compatible = (value: ComparisonTransport<T> | ComparisonStreamingTransport) =>
        value.kind === (grant.scope === 'formal' ? 'approved-provider' : 'synthetic') && value.modelContractHash === route.modelContractHash;
      need((transport || streaming) && (!transport || typeof transport.send === 'function' && compatible(transport)) &&
        (!streaming || route.stream && typeof streaming.open === 'function' && compatible(streaming)),
      'Trusted comparison transport conflicts with the admitted model or scope');
      routes.set(stage as ComparisonStage, { route, send: transport?.send, open: streaming?.open.bind(streaming) });
    }
    const sha256 = await harnessHash(canonicalHarness(['comparison-slot-v1', identity]));
    slots.set(identity.slotId, { identity, sha256, authority, routes });
  }
  const db = database.connection;
  const grantDigest = await harnessHash(canonicalHarness(['comparison-dispatch-grant-v1', grant]));
  await db.prepare('INSERT INTO comparison_dispatch_grant (id,grant_sha256) VALUES (1,?) ON CONFLICT(id) DO NOTHING RETURNING id')
    .bind(grantDigest).first();
  const existing = await db.prepare('SELECT grant_sha256 FROM comparison_dispatch_grant WHERE id=1').first<{ grant_sha256: string }>();
  need(existing?.grant_sha256 === grantDigest, 'Comparison database is bound to another immutable grant');

  const readRow = (slotId: string, requestId: string) => db.prepare(
    'SELECT * FROM comparison_dispatch_attempts WHERE slot_id=? AND request_id=?',
  ).bind(slotId, requestId).first<AttemptRow>();

  function requireSlot(authority: object, slotId: string) {
    const slot = slots.get(slotId);
    need(slot && slot.authority === authority, 'Comparison slot authority mismatch');
    return slot;
  }

  type Slot = ReturnType<typeof requireSlot>;
  type Material = { source_sha256: string; evidence_sha256: string };
  const readMaterial = (caseId: string) => db.prepare(
    'SELECT source_sha256,evidence_sha256 FROM comparison_dispatch_review_material WHERE case_id=?',
  ).bind(caseId).first<Material>();

  /** The coordinator calls this only after independently verifying the sealed B artifact and capture. */
  async function admitReviewEvidence(authority: object, slotId: string, material: { sourceSha256: string; evidenceSha256: string }) {
    const slot = requireSlot(authority, slotId);
    need(slot.identity.operation === 'review' && exactKeys(material, ['sourceSha256', 'evidenceSha256']) &&
      matches(hash, material.sourceSha256) && matches(hash, material.evidenceSha256), 'Invalid comparison review material');
    const { sourceSha256, evidenceSha256 } = material;
    const { caseId } = slot.identity;
    if (slot.identity.sourceSha256 !== null) {
      need(slot.identity.sourceSha256 === sourceSha256 && slot.identity.evidenceSha256 === evidenceSha256,
        'Comparison review material conflicts with its immutable admission');
      return { sourceSha256, evidenceSha256 };
    }
    await db.prepare(`INSERT INTO comparison_dispatch_review_material (case_id,source_sha256,evidence_sha256)
      VALUES (?,?,?) ON CONFLICT(case_id) DO NOTHING RETURNING case_id`).bind(caseId, sourceSha256, evidenceSha256).first();
    const stored = await readMaterial(caseId);
    need(stored?.source_sha256 === sourceSha256 && stored.evidence_sha256 === evidenceSha256,
      'Comparison review material conflicts with its immutable admission');
    return { sourceSha256, evidenceSha256 };
  }

  async function lockedSlot(slot: Slot) {
    if (slot.identity.sourceSha256 !== null) return { ...slot, identity: { ...slot.identity, sourceSha256: slot.identity.sourceSha256 } };
    const material = await readMaterial(slot.identity.caseId);
    need(material && matches(hash, material.source_sha256) && matches(hash, material.evidence_sha256), 'Comparison review awaits sealed evidence');
    const identity = { ...slot.identity, sourceSha256: material.source_sha256, evidenceSha256: material.evidence_sha256 };
    const sha256 = await harnessHash(canonicalHarness(['comparison-slot-v1', identity]));
    return { ...slot, identity, sha256 };
  }

  function receipt(slot: Awaited<ReturnType<typeof lockedSlot>>, row: AttemptRow): ComparisonDispatchReceipt {
    const { slotId, taskId, ownerId, caseId, arm, operation, sourceSha256, evidenceSha256, modelConfigSha256 } = slot.identity;
    need(row.slot_id === slotId && row.slot_sha256 === slot.sha256, 'Stored comparison attempt identity mismatch');
    return { schemaVersion: 1, scope: grant.scope, runId: grant.runId, ledgerDatabaseId: grant.ledgerDatabaseId, planSha256: grant.planSha256,
      manifestSha256: grant.manifestSha256, authorizationSha256: grant.authorizationSha256,
      slotId, slotSha256: slot.sha256, taskId, ownerId, caseId, arm, operation, sourceSha256, evidenceSha256, modelConfigSha256,
      stage: row.stage, requestId: row.request_id, attempt: 1, bodySha256: row.body_sha256, modelContractHash: row.model_contract_hash,
      outputCap: row.output_cap, accountedOutputTokens: row.output_tokens ?? row.output_cap,
      state: row.state, failureCode: row.failure_code, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      reservedAt: row.reserved_at, forwardingAt: row.forwarding_at, settledAt: row.settled_at };
  }

  async function settle(slotId: string, requestId: string, state: 'completed' | 'failed' | 'unknown',
    failureCode: FailureCode | null, inputTokens: number | null, outputTokens: number | null) {
    return db.prepare(`UPDATE comparison_dispatch_attempts SET state=?,failure_code=?,input_tokens=?,output_tokens=?,settled_at=?
      WHERE slot_id=? AND request_id=? AND state='forwarding' RETURNING *`)
      .bind(state, failureCode, inputTokens, outputTokens, now(), slotId, requestId).first<AttemptRow>();
  }

  async function settleOutcome(slot: Awaited<ReturnType<typeof lockedSlot>>, requestId: string, outputCap: number, outcome?: SettlementOutcome) {
    let state: 'completed' | 'failed' | 'unknown' = 'unknown';
    let failureCode: FailureCode | null = 'transport-outcome-unknown';
    let inputTokens: number | null = null, outputTokens: number | null = null;
    if (outcome && (outcome.state === 'completed' ||
      (outcome.state === 'failed' && ['provider-rejected', 'invalid-response', 'truncated'].includes(outcome.failureCode))) &&
      tokenCount(outcome.inputTokens) && tokenCount(outcome.outputTokens)) {
      ({ inputTokens, outputTokens } = outcome);
      const overCap = outputTokens !== null && outputTokens > outputCap;
      state = overCap ? 'failed' : outcome.state;
      failureCode = overCap ? 'usage-exceeds-reservation' : outcome.state === 'failed' ? outcome.failureCode : null;
    }
    const settled = await settle(slot.identity.slotId, requestId, state, failureCode, inputTokens, outputTokens);
    const current = settled ?? await readRow(slot.identity.slotId, requestId);
    need(current, 'Comparison settlement is unavailable');
    return { receipt: receipt(slot, current), settled: Boolean(settled) };
  }

  type DispatchRequest = { requestId: string; stage: ComparisonStage; body: Uint8Array };

  function bindSlot(authority: object, slotId: string, expected?: { grant: ComparisonGrant; slot: ComparisonAdmittedSlot }) {
    const authorizedSlot = requireSlot(authority, slotId);
    need(!expected || canonicalHarness(expected.grant) === canonicalHarness(grant) &&
      canonicalHarness(expected.slot) === canonicalHarness(authorizedSlot.identity), 'Comparison broker grant or slot mismatch');

    async function read(requestId: string) {
      need(matches(id, requestId), 'Invalid comparison request identity');
      const row = await readRow(slotId, requestId);
      return row && receipt(await lockedSlot(authorizedSlot), row);
    }

    async function begin(request: DispatchRequest, mode: 'send' | 'open') {
      need(exactKeys(request, ['requestId', 'stage', 'body']) && matches(id, request.requestId) &&
        request.body instanceof Uint8Array && request.body.byteLength <= maxWireBytes, 'Invalid comparison dispatch request');
      const { requestId, stage } = request;
      const body = new Uint8Array(request.body);
      const slot = await lockedSlot(authorizedSlot);
      const transport = slot.routes.get(stage);
      need(transport, 'Comparison stage is outside this admitted slot');
      need(typeof transport[mode] === 'function', 'Comparison stage has no admitted transport for this dispatch mode');
      const outputCap = wireOutputCap(body, transport.route);
      const [bodySha256, idempotencyKey] = await Promise.all([
        bodyDigest(body), harnessHash(canonicalHarness(['comparison-request-v1', grantDigest, slot.sha256, requestId])),
      ]);
      const { modelContractHash } = transport.route;
      const duplicate = (row: AttemptRow) => {
        need(row.stage === stage && row.body_sha256 === bodySha256 && row.model_contract_hash === modelContractHash && row.output_cap === outputCap,
          'Comparison request identity conflicts with its reserved wire');
        return { receipt: receipt(slot, row), dispatched: false as const };
      };
      const prior = await readRow(slotId, requestId);
      if (prior) return duplicate(prior);

      const at = now();
      // One write statement serializes request/output reservation across both
      // arms. Active and unknown attempts also block a second call in this slot.
      const reserved = await db.prepare(`INSERT INTO comparison_dispatch_attempts
        (slot_id,request_id,slot_sha256,stage,body_sha256,model_contract_hash,output_cap,state,reserved_at)
        SELECT ?,?,?,?,?,?,?,'reserved',?
        WHERE ? >= ? AND ? < ?
          AND (SELECT COUNT(*) FROM comparison_dispatch_attempts) < ?
          AND COALESCE((SELECT SUM(COALESCE(output_tokens,output_cap)) FROM comparison_dispatch_attempts),0) <= ? - ?
          AND NOT EXISTS (SELECT 1 FROM comparison_dispatch_attempts WHERE failure_code='usage-exceeds-reservation')
          AND NOT EXISTS (SELECT 1 FROM comparison_dispatch_attempts WHERE slot_id=? AND state IN ('reserved','forwarding','unknown'))
        ON CONFLICT(slot_id,request_id) DO NOTHING RETURNING *`)
        .bind(slotId, requestId, slot.sha256, stage, bodySha256, modelContractHash, outputCap, at,
          at, grant.notBefore, at, grant.deadlineAt, grant.maxRequests, grant.maxOutputTokens, outputCap, slotId).first<AttemptRow>();
      if (!reserved) {
        const raced = await readRow(slotId, requestId);
        if (raced) return duplicate(raced);
        throw new Error('Comparison dispatch denied by deadline, budget or slot state');
      }

      const forwardAt = now();
      const forwarding = await db.prepare(`UPDATE comparison_dispatch_attempts SET state='forwarding',forwarding_at=?
        WHERE slot_id=? AND request_id=? AND state='reserved' AND ? < ?
          AND NOT EXISTS (SELECT 1 FROM comparison_dispatch_attempts WHERE failure_code='usage-exceeds-reservation')
        RETURNING *`).bind(forwardAt, slotId, requestId, forwardAt, grant.deadlineAt).first<AttemptRow>();
      if (!forwarding) {
        const current = await readRow(slotId, requestId);
        need(current, 'Comparison reservation is unavailable');
        return duplicate(current);
      }

      if (now() >= grant.deadlineAt) {
        const row = await settle(slotId, requestId, 'failed', 'deadline-before-transport', null, null);
        need(row, 'Comparison settlement ownership was lost');
        return { receipt: receipt(slot, row), dispatched: false as const };
      }

      return { receipt: receipt(slot, forwarding), dispatched: true as const, slot, transport, outputCap,
        input: { body, idempotencyKey, deadlineAt: grant.deadlineAt, taskId: slot.identity.taskId, requestId, stage } };
    }

    async function dispatch(request: DispatchRequest): Promise<{ receipt: ComparisonDispatchReceipt; dispatched: boolean; result?: T }> {
      const started = await begin(request, 'send');
      if (!started.dispatched) return started;
      const { slot, transport, outputCap, input } = started;

      let outcome: Outcome<T> | undefined;
      try {
        outcome = await transport.send!(input);
      } catch {
        // A throw after the durable forwarding CAS cannot prove the vendor
        // failed to receive the request. No exception text enters the ledger.
      }
      const result = await settleOutcome(slot, input.requestId, outputCap, outcome);
      return { receipt: result.receipt, dispatched: true,
        ...(result.settled && result.receipt.state === 'completed' && outcome?.state === 'completed' ? { result: outcome.result } : {}) };
    }

    async function dispatchStream(request: DispatchRequest, signal?: AbortSignal): Promise<ComparisonStreamingDispatch> {
      need(!signal?.aborted, 'Comparison stream was cancelled before admission');
      const started = await begin(request, 'open');
      if (!started.dispatched) return started;
      const { slot, transport, outputCap, input, receipt: initial } = started;
      if (signal?.aborted) {
        const result = await settleOutcome(slot, input.requestId, outputCap);
        return { dispatched: false, receipt: result.receipt };
      }
      return streamResponse(input, transport.open!, initial, outcome => settleOutcome(slot, input.requestId, outputCap, outcome),
        diagnostic => db.prepare(`INSERT OR IGNORE INTO comparison_dispatch_stream_diagnostics
          (slot_id,request_id,http_status,head_at,last_byte_at,last_frame_at,byte_count,frame_count,native_end,
           provider_error_type,provider_error_code,stream_end,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          RETURNING request_id`).bind(slot.identity.slotId, input.requestId, diagnostic.httpStatus, diagnostic.headAt, diagnostic.lastByteAt,
          diagnostic.lastFrameAt, diagnostic.byteCount, diagnostic.frameCount, diagnostic.nativeEnd, diagnostic.providerErrorType,
          diagnostic.providerErrorCode, diagnostic.streamEnd, diagnostic.observedAt).first(), now, signal, syntheticKeepalive);
    }
    return { read, dispatch, dispatchStream };
  }

  /** Call only after the isolated host establishes that the original dispatcher stopped. */
  async function reconcileInterrupted(authority: object, slotId: string, requestId: string) {
    const slot = await lockedSlot(requireSlot(authority, slotId));
    need(matches(id, requestId), 'Invalid comparison request identity');
    const row = await db.prepare(`UPDATE comparison_dispatch_attempts
      SET failure_code=CASE state WHEN 'forwarding' THEN 'transport-outcome-unknown' ELSE 'interrupted-before-forward' END,
        state=CASE state WHEN 'forwarding' THEN 'unknown' ELSE 'failed' END, settled_at=?
      WHERE slot_id=? AND request_id=? AND state IN ('reserved','forwarding') RETURNING *`)
      .bind(now(), slotId, requestId).first<AttemptRow>() ?? await readRow(slotId, requestId);
    return row && receipt(slot, row);
  }

  async function budget() {
    // Forwarding commits are upper-bound accounting, not proof of socket I/O.
    // Stranded reservations remain charged even when no usage is reported.
    const summary = await db.prepare(`SELECT COUNT(*) AS reservedRequests,
      COALESCE(SUM(CASE WHEN forwarding_at IS NULL THEN 0 ELSE 1 END),0) AS forwardingCommitted,
      COALESCE(SUM(COALESCE(output_tokens,output_cap)),0) AS accountedOutputTokens,
      COALESCE(SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END),0) AS unknownRequests
      FROM comparison_dispatch_attempts`).first<{
        reservedRequests: number; forwardingCommitted: number; accountedOutputTokens: number; unknownRequests: number;
      }>();
    need(summary, 'Comparison budget is unavailable');
    return { ...summary, maxRequests: grant.maxRequests, maxOutputTokens: grant.maxOutputTokens };
  }

  return { bindSlot, admitReviewEvidence, reconcileInterrupted, budget };
}
