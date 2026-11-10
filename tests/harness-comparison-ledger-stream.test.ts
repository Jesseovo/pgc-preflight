import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createComparisonSseTransport } from '../scripts/harness-comparison-stream';
import {
  COMPARISON_LEDGER_SCHEMA, COMPARISON_SYNTHETIC_KEEPALIVE_FRAME, comparisonAdmittedSlotsSha256, openComparisonLedger,
  type ComparisonAdmittedSlot, type ComparisonGrant, type ComparisonLedgerDatabase, type ComparisonStreamFrame,
  type ComparisonStreamingTransport,
} from '../scripts/harness-comparison-ledger';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const digest = (value: string) => value.repeat(64);
const now = 1_800_000_000_000;
const databases: DatabaseSync[] = [];
let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => { fetch = vi.fn(() => { throw new Error('No real provider transport'); }); vi.stubGlobal('fetch', fetch); });
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function response() {
  let writer!: ReadableStreamDefaultController<ComparisonStreamFrame>;
  const cancel = vi.fn();
  const frames = new ReadableStream<ComparisonStreamFrame>({ start(controller) { writer = controller; }, cancel });
  const head = new Response(null, { status: 200, statusText: 'Synthetic SSE', headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-fixture': 'original' } });
  return {
    opened: { kind: 'stream' as const, head, frames }, cancel,
    data: (line: string) => writer.enqueue({ kind: 'data', bytes: encoder.encode(line) }),
    terminal: (outcome: Extract<ComparisonStreamFrame, { kind: 'terminal' }>['outcome'] = { state: 'completed', inputTokens: 34, outputTokens: 12 }) =>
      writer.enqueue({ kind: 'terminal', bytes: encoder.encode('data: [DONE]\r\n\r\n'), outcome }),
    close: () => writer.close(),
  };
}

function request(requestId: string, cap = 60, model = 'deepseek-flash') {
  return { requestId, stage: 'review' as const, body: encoder.encode(JSON.stringify({ model,
    messages: [{ role: 'user', content: 'private synthetic source' }], stream: true, max_tokens: cap })) };
}

async function setup(open: ComparisonStreamingTransport['open'], caps: Partial<Pick<ComparisonGrant, 'maxRequests' | 'maxOutputTokens' | 'deadlineAt' | 'scope'>> = {},
  beforeStatement?: (sql: string) => Promise<void>, clock = () => now, protocol: 'anthropic' | 'openai' = 'openai', syntheticKeepalive = false) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  for (const sql of COMPARISON_LEDGER_SCHEMA) db.exec(sql);
  const connection: ComparisonLedgerDatabase = { prepare(sql) {
    const statement = db.prepare(sql);
    const wrapper = (args: (string | number | null)[]) => ({ bind: (...bound: (string | number | null)[]) => wrapper(bound),
      async first<T>() { await beforeStatement?.(sql); return (statement.get(...args) ?? null) as T | null; } });
    return wrapper([]);
  } };
  const route = { transportId: 'test-stream', modelContractHash: digest('a'), protocol, model: protocol === 'openai' ? 'deepseek-flash' : 'claude-opus-5-5',
    effort: null, stream: true, jsonMode: false, maxOutputTokens: 80 };
  const slots: ComparisonAdmittedSlot[] = (['A', 'B'] as const).map(arm => ({ slotId: `slot-${arm}`, taskId: `task-${arm}`, ownerId: `owner-${arm}`,
    caseId: 'tap-rhythm', arm, operation: 'review', sourceSha256: digest('b'), evidenceSha256: digest('c'), modelConfigSha256: digest('d'), stages: { review: route } }));
  const grant: ComparisonGrant = { schemaVersion: 1, purpose: 'isolated-comparison', scope: 'rehearsal', runId: 'stream-test', ledgerDatabaseId: 'local-d1',
    planSha256: digest('e'), manifestSha256: digest('f'), admittedSlotsSha256: await comparisonAdmittedSlotsSha256(slots), authorizationSha256: digest('1'),
    maxRequests: 2, maxOutputTokens: 100, notBefore: now - 1, deadlineAt: now + 60_000, ...caps };
  const authorityA = {}, authorityB = {};
  const ledger = await openComparisonLedger({ database: { scope: 'isolated-comparison', id: 'local-d1', connection }, grant, slots,
    authorities: new Map([['slot-A', authorityA], ['slot-B', authorityB]]),
    streamingTransports: new Map([['test-stream', { kind: 'synthetic', modelContractHash: digest('a'), open }]]), now: clock, syntheticKeepalive });
  return { db, ledger, authorityA, a: ledger.bindSlot(authorityA, 'slot-A'), b: ledger.bindSlot(authorityB, 'slot-B') };
}

const nativeStart = 'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n';
const nativeFinish = 'data: {"choices":[{"index":0,"finish_reason":"stop"}],"usage":{"completion_tokens":12,"prompt_tokens":17}}\n\n';
const nativeStop = 'data: [DONE]\n\n';
function nativeFixture(protocol: 'anthropic' | 'openai' = 'openai') {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel });
  const fetchResponse = vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  const transport = createComparisonSseTransport({ kind: 'synthetic', modelContractHash: digest('a'), protocol, fetchResponse });
  return { source, cancel, transport, fetchResponse, emit: (bytes: string) => source.enqueue(encoder.encode(bytes)) };
}
const savedDiagnostic = (db: DatabaseSync) => db.prepare('SELECT * FROM comparison_dispatch_stream_diagnostics').get();

it('keeps a 195-second synthetic silence alive without modifying native bytes, usage, or observed frame counts', async () => {
  vi.useFakeTimers({ now });
  const supplier = nativeFixture();
  const s = await setup(supplier.transport.open, { deadlineAt: now + 720_000 }, undefined, Date.now, 'openai', true);
  const attempt = await s.a.dispatchStream(request('local-keepalive'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing stream');
  const reader = attempt.response.body!.getReader();
  const start = '\uFEFF' + nativeStart;
  supplier.emit(start);
  expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode((await reader.read()).value)).toBe(start);
  for (let index = 0; index < 19; index++) {
    const chunk = reader.read();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(decoder.decode((await chunk).value)).toBe(COMPARISON_SYNTHETIC_KEEPALIVE_FRAME);
  }
  expect(await s.a.read('local-keepalive')).toMatchObject({ state: 'forwarding', outputTokens: null });
  const next = reader.read();
  await vi.advanceTimersByTimeAsync(5_000);
  supplier.emit(nativeFinish + nativeStop);
  supplier.source.close();
  expect(decoder.decode((await next).value)).toBe(nativeFinish);
  expect(decoder.decode((await reader.read()).value)).toBe(nativeStop);
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  await expect(attempt.completion).resolves.toMatchObject({ state: 'completed', inputTokens: 17, outputTokens: 12 });
  await attempt.diagnostics;
  expect(savedDiagnostic(s.db)).toMatchObject({ byte_count: Buffer.byteLength(start + nativeFinish + nativeStop), frame_count: 3,
    native_end: 'clean-terminal', stream_end: 'terminal', last_byte_at: now + 195_000 });
  expect(supplier.fetchResponse).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('never buffers synthetic keepalives and keeps only one pending source read across timer ticks', async () => {
  vi.useFakeTimers({ now });
  const supplier = response();
  const nativeReader = supplier.opened.frames.getReader(), read = vi.spyOn(nativeReader, 'read');
  vi.spyOn(supplier.opened.frames, 'getReader').mockReturnValue(nativeReader);
  const s = await setup(async () => supplier.opened, { deadlineAt: now + 720_000 }, undefined, Date.now, 'openai', true);
  const attempt = await s.a.dispatchStream(request('bounded-keepalive'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing stream');
  const reader = attempt.response.body!.getReader();
  const first = reader.read();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(vi.getTimerCount()).toBe(1); // No comment before the first native frame.
  expect(read).toHaveBeenCalledTimes(1);
  supplier.data(nativeStart);
  expect(decoder.decode((await first).value)).toBe(nativeStart);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(vi.getTimerCount()).toBe(1); // No consumer demand.
  expect(read).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 3; index++) {
    const ping = reader.read();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(decoder.decode((await ping).value)).toBe(COMPARISON_SYNTHETIC_KEEPALIVE_FRAME);
    expect(read).toHaveBeenCalledTimes(2);
  }
  const pending = reader.read();
  await vi.advanceTimersByTimeAsync(500);
  expect(vi.getTimerCount()).toBe(2);
  await reader.cancel();
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  await expect(attempt.completion).resolves.toMatchObject({ state: 'unknown', outputTokens: null });
  await attempt.diagnostics;
  expect(supplier.cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('stops synthetic keepalive at the original absolute deadline', async () => {
  vi.useFakeTimers({ now });
  const supplier = nativeFixture();
  const s = await setup(supplier.transport.open, { deadlineAt: now + 35_000 }, undefined, Date.now, 'openai', true);
  const attempt = await s.a.dispatchStream(request('deadline-keepalive'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing stream');
  const reader = attempt.response.body!.getReader();
  supplier.emit(nativeStart);
  await reader.read();
  for (let index = 0; index < 3; index++) {
    const ping = reader.read();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(decoder.decode((await ping).value)).toBe(COMPARISON_SYNTHETIC_KEEPALIVE_FRAME);
  }
  const failed = expect(reader.read()).rejects.toThrow('without a verified terminal frame');
  await vi.advanceTimersByTimeAsync(5_000);
  await failed;
  await expect(attempt.completion).resolves.toMatchObject({ state: 'unknown', accountedOutputTokens: 60, outputTokens: null });
  await attempt.diagnostics;
  expect(savedDiagnostic(s.db)).toMatchObject({ last_byte_at: now, frame_count: 1, stream_end: 'deadline', observed_at: now + 35_000 });
  expect(vi.getTimerCount()).toBe(0);
});

it('holds the unchanged terminal frame behind settlement even with synthetic keepalive enabled', async () => {
  vi.useFakeTimers({ now });
  const supplier = response(), entered = gate(), commit = gate();
  const s = await setup(async () => supplier.opened, { deadlineAt: now + 720_000 }, async sql => {
    if (sql.includes('SET state=?,failure_code=')) { entered.release(); await commit.promise; }
  }, Date.now, 'openai', true);
  const attempt = await s.a.dispatchStream(request('keepalive-terminal'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing stream');
  const reader = attempt.response.body!.getReader();
  supplier.data(nativeStart);
  await reader.read();
  const heartbeat = reader.read();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(decoder.decode((await heartbeat).value)).toBe(COMPARISON_SYNTHETIC_KEEPALIVE_FRAME);
  supplier.terminal();
  let done = false;
  const next = reader.read().then(value => { done = true; return value; });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(done).toBe(false);
  expect(await s.a.read('keepalive-terminal')).toMatchObject({ state: 'forwarding' });
  commit.release();
  expect(decoder.decode((await next).value)).toBe('data: [DONE]\r\n\r\n');
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  await expect(attempt.completion).resolves.toMatchObject({ state: 'completed', outputTokens: 12 });
  await attempt.diagnostics;
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects synthetic keepalive configuration for a formal grant before any transport call', async () => {
  const open = vi.fn<ComparisonStreamingTransport['open']>();
  await expect(setup(open, { scope: 'formal' }, undefined, Date.now, 'openai', true)).rejects.toThrow(/limited to isolated rehearsal/);
  expect(open).not.toHaveBeenCalled();
});

it.each([false, true])('keeps a 190-second native stream healthy with heartbeat=%s', async heartbeat => {
  vi.useFakeTimers({ now });
  const start = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":17}}}\n\n';
  const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
  const finish = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n';
  const terminal = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const supplier = nativeFixture('anthropic');
  const s = await setup(supplier.transport.open, { deadlineAt: now + 720_000 }, undefined, Date.now, 'anthropic');
  const attempt = await s.a.dispatchStream(request('long-stream', 60, 'claude-opus-5-5'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing stream');
  const reader = attempt.response.body!.getReader();
  supplier.emit(start);
  expect(decoder.decode((await reader.read()).value)).toBe(start);
  await vi.advanceTimersByTimeAsync(95_000);
  if (heartbeat) {
    supplier.emit(ping);
    expect(decoder.decode((await reader.read()).value)).toBe(ping);
  }
  await vi.advanceTimersByTimeAsync(95_000);
  expect(await s.a.read('long-stream')).toMatchObject({ state: 'forwarding' });
  expect(savedDiagnostic(s.db)).toBeUndefined();
  supplier.emit(finish + terminal);
  supplier.source.close();
  expect(decoder.decode((await reader.read()).value)).toBe(finish);
  expect(decoder.decode((await reader.read()).value)).toBe(terminal);
  await expect(attempt.completion).resolves.toMatchObject({ state: 'completed', outputTokens: 12 });
  await attempt.diagnostics;
  expect(savedDiagnostic(s.db)).toMatchObject({ http_status: 200, head_at: now, last_byte_at: now + 190_000,
    last_frame_at: now + 190_000, byte_count: Buffer.byteLength(start + (heartbeat ? ping : '') + finish + terminal),
    frame_count: heartbeat ? 4 : 3, native_end: 'clean-terminal', stream_end: 'terminal' });
  expect(supplier.fetchResponse).toHaveBeenCalledTimes(1);
});

it.each([
  ['eof', 'upstream-eof-before-terminal', null, null],
  ['read-error', 'upstream-body-read-error', null, null],
  ['native-error', 'native-sse-error', 'overloaded_error', 'other'],
  ['no-final-usage', 'invalid-terminal-usage', null, null],
  ['partial-frame', 'truncated-sse-frame', null, null],
] as const)('preserves unknown accounting and a safe diagnosis after %s', async (mode, nativeEnd, errorType, errorCode) => {
  vi.useFakeTimers({ now });
  const supplier = nativeFixture();
  const s = await setup(supplier.transport.open, { deadlineAt: now + 720_000 }, undefined, Date.now);
  const attempt = await s.a.dispatchStream(request('early-end'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing stream');
  const reader = attempt.response.body!.getReader();
  supplier.emit(nativeStart);
  expect(decoder.decode((await reader.read()).value)).toBe(nativeStart);
  const read = expect(reader.read()).rejects.toThrow(/without a verified terminal frame/);
  await vi.advanceTimersByTimeAsync(181_725);
  if (mode === 'read-error') supplier.source.error(new Error('private supplier failure body'));
  else {
    if (mode === 'native-error') supplier.emit('event: error\ndata: {"error":{"type":"overloaded_error","code":"sensitive-invented-code","message":"private supplier reasoning"}}\n\n');
    if (mode === 'no-final-usage') supplier.emit(nativeStop);
    if (mode === 'partial-frame') supplier.emit('data: {"choices":');
    supplier.source.close();
  }
  await read;
  await expect(attempt.completion).resolves.toMatchObject({ state: 'unknown', outputTokens: null, accountedOutputTokens: 60 });
  await attempt.diagnostics;
  const diag = savedDiagnostic(s.db);
  expect(diag).toMatchObject({ http_status: 200, head_at: now, observed_at: now + 181_725, native_end: nativeEnd,
    provider_error_type: errorType, provider_error_code: errorCode, stream_end: 'transport-error' });
  expect(JSON.stringify(diag)).not.toMatch(/private|sensitive-invented-code|choices/);
  await expect(s.a.dispatchStream(request('early-end'))).resolves.toMatchObject({ dispatched: false });
  expect(supplier.fetchResponse).toHaveBeenCalledTimes(1);
});

it.each(['deadline', 'inbound-abort', 'downstream-cancel'] as const)('distinguishes %s with no supplier termination', async reason => {
  vi.useFakeTimers({ now });
  const supplier = nativeFixture(), inbound = new AbortController();
  const s = await setup(supplier.transport.open, { deadlineAt: now + 720_000 }, undefined, Date.now);
  const attempt = await s.a.dispatchStream(request('abort-case'), inbound.signal);
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing stream');
  const reader = attempt.response.body!.getReader();
  supplier.emit(nativeStart);
  await reader.read();
  if (reason === 'deadline') await vi.advanceTimersByTimeAsync(720_000);
  if (reason === 'inbound-abort') inbound.abort(new Error('private inbound reason'));
  if (reason === 'downstream-cancel') await reader.cancel('private downstream reason');
  await expect(attempt.completion).resolves.toMatchObject({ state: 'unknown', outputTokens: null });
  await attempt.diagnostics;
  expect(savedDiagnostic(s.db)).toMatchObject({ native_end: null, stream_end: reason, frame_count: 1 });
  expect(supplier.cancel).toHaveBeenCalledOnce();
});

it.each(['local-http-denial', 'open-error'] as const)('records %s without implying a provider response', async mode => {
  const denied = mode === 'local-http-denial';
  const transport = createComparisonSseTransport({ kind: 'synthetic', modelContractHash: digest('a'), protocol: 'openai',
    async fetchResponse() {
      if (denied) return new Response(null, { status: 403 });
      throw new Error('private transport exception');
    },
  });
  const s = await setup(transport.open);
  const attempt = await s.a.dispatchStream(request('local-transport'));
  if (!attempt.dispatched) throw new Error('Missing transport attempt');
  expect(attempt.response?.status).toBe(denied ? 403 : undefined);
  await expect(attempt.completion).resolves.toMatchObject({ state: denied ? 'failed' : 'unknown' });
  await attempt.diagnostics;
  const diagnostic = savedDiagnostic(s.db);
  expect(diagnostic).toMatchObject({ http_status: denied ? 403 : null,
    native_end: denied ? 'transport-http-rejected' : 'transport-open-error',
    stream_end: denied ? 'http-rejection' : 'transport-error' });
  expect(JSON.stringify(diagnostic)).not.toContain('private transport exception');
});

it('leaves settlement and terminal bytes intact if writing the diagnostic fails', async () => {
  const supplier = nativeFixture();
  const s = await setup(supplier.transport.open, {}, async sql => {
    if (sql.includes('INSERT OR IGNORE INTO comparison_dispatch_stream_diagnostics')) throw new Error('Diagnostic storage unavailable');
  });
  const attempt = await s.a.dispatchStream(request('diagnostic-failure'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing stream');
  supplier.emit(nativeStart + nativeFinish + nativeStop);
  supplier.source.close();
  await expect(attempt.response.text()).resolves.toBe(nativeStart + nativeFinish + nativeStop);
  await expect(attempt.completion).resolves.toMatchObject({ state: 'completed', outputTokens: 12 });
  await attempt.diagnostics;
  expect(savedDiagnostic(s.db)).toBeUndefined();
});

it('forwards original progress before upstream completion and withholds the original terminator until durable settlement', async () => {
  const supplier = response(), settlementEntered = gate(), commit = gate();
  const open = vi.fn(async () => supplier.opened);
  const s = await setup(open, {}, async sql => {
    if (sql.includes('SET state=?,failure_code=')) { settlementEntered.release(); await commit.promise; }
  });
  open.mockImplementationOnce(async () => {
    expect(s.db.prepare('SELECT state FROM comparison_dispatch_attempts').get()).toEqual({ state: 'forwarding' });
    return supplier.opened;
  });
  const attempt = await s.a.dispatchStream(request('one'));
  expect(attempt.dispatched).toBe(true);
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing streaming response');
  expect(attempt.response.status).toBe(supplier.opened.head.status);
  expect(attempt.response.statusText).toBe(supplier.opened.head.statusText);
  expect([...attempt.response.headers]).toEqual([...supplier.opened.head.headers]);
  const reader = attempt.response.body!.getReader();
  const early = 'data: {"delta":"private progress"}\r\n\r\n';
  supplier.data(early);
  expect(decoder.decode((await reader.read()).value)).toBe(early);
  expect(await s.a.read('one')).toMatchObject({ state: 'forwarding', accountedOutputTokens: 60 });
  await expect(s.a.dispatchStream(request('one'))).resolves.toMatchObject({ dispatched: false, receipt: { state: 'forwarding' } });
  await expect(s.a.dispatchStream(request('one', 61))).rejects.toThrow('reserved wire');
  expect(() => s.ledger.bindSlot(s.authorityA, 'slot-B')).toThrow('authority mismatch');
  await expect(s.b.dispatchStream(request('cross', 41))).rejects.toThrow(/budget or slot state/);
  let terminalReleased = false;
  const tail = reader.read().then(value => { terminalReleased = true; return value; });
  supplier.terminal();
  await settlementEntered.promise;
  expect(terminalReleased).toBe(false);
  expect(await s.ledger.budget()).toMatchObject({ accountedOutputTokens: 60 });
  commit.release();
  expect(decoder.decode((await tail).value)).toBe('data: [DONE]\r\n\r\n');
  await expect(attempt.completion).resolves.toMatchObject({ state: 'completed', inputTokens: 34, outputTokens: 12 });
  expect((await reader.read()).done).toBe(true);
  expect(await s.a.dispatchStream(request('one'))).toMatchObject({ dispatched: false, receipt: { state: 'completed' } });
  expect(open).toHaveBeenCalledOnce();
  expect(JSON.stringify(s.db.prepare('SELECT * FROM comparison_dispatch_attempts').all())).not.toMatch(/private progress|private synthetic source|\[DONE\]/);
});

it('keeps aggregate request exhaustion after streaming completion and refuses an unregistered dispatch mode', async () => {
  const supplier = response(), open = vi.fn(async () => supplier.opened);
  const s = await setup(open, { maxRequests: 1 });
  await expect(s.a.dispatch(request('wrong-mode'))).rejects.toThrow('no admitted transport');
  const attempt = await s.a.dispatchStream(request('one'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing streaming response');
  supplier.terminal();
  expect(await attempt.response.text()).toBe('data: [DONE]\r\n\r\n');
  await expect(attempt.completion).resolves.toMatchObject({ state: 'completed' });
  await expect(s.b.dispatchStream(request('other', 1))).rejects.toThrow(/budget or slot state/);
  expect(open).toHaveBeenCalledOnce();
});

it('settles an explicit provider rejection before handing the original error response back', async () => {
  const original = new Response('synthetic rejection', { status: 401, headers: { 'x-fixture': 'rejected' } });
  const open = vi.fn<ComparisonStreamingTransport['open']>(async () => ({ kind: 'rejected', response: original,
    outcome: { state: 'failed', failureCode: 'provider-rejected', inputTokens: null, outputTokens: null } }));
  const s = await setup(open);
  const attempt = await s.a.dispatchStream(request('denied'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing rejection response');
  expect(attempt.response).toBe(original);
  expect(await s.a.read('denied')).toMatchObject({ state: 'failed', failureCode: 'provider-rejected', accountedOutputTokens: 60 });
  await expect(attempt.completion).resolves.toMatchObject({ state: 'failed' });
  expect(await s.a.dispatchStream(request('denied'))).toMatchObject({ dispatched: false });
  expect(open).toHaveBeenCalledOnce();
});

it('treats missing terminal bytes and client disconnect as unknown, retaining the reservation without replay', async () => {
  const supplier = response(), next = response();
  const open = vi.fn<ComparisonStreamingTransport['open']>().mockResolvedValueOnce(supplier.opened).mockResolvedValueOnce(next.opened);
  const s = await setup(open);
  const attempt = await s.a.dispatchStream(request('eof'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing streaming response');
  supplier.close();
  await expect(attempt.response.text()).rejects.toThrow('without a verified terminal frame');
  await expect(attempt.completion).resolves.toMatchObject({ state: 'unknown', accountedOutputTokens: 60, outputTokens: null });
  await expect(s.a.dispatchStream(request('later', 1))).rejects.toThrow(/budget or slot state/);
  const external = new AbortController();
  const second = await s.b.dispatchStream(request('disconnect', 40), external.signal);
  if (!second.dispatched || !second.response) throw new Error('Missing streaming response');
  external.abort('private cancellation reason');
  await expect(second.response.text()).rejects.toThrow('without a verified terminal frame');
  await expect(second.completion).resolves.toMatchObject({ state: 'unknown', accountedOutputTokens: 40 });
  expect(next.cancel).toHaveBeenCalledOnce();
  expect(await s.b.dispatchStream(request('disconnect', 40))).toMatchObject({ dispatched: false, receipt: { state: 'unknown' } });
  expect(await s.ledger.budget()).toMatchObject({ accountedOutputTokens: 100, unknownRequests: 2 });
  expect(JSON.stringify(s.db.prepare('SELECT * FROM comparison_dispatch_attempts').all())).not.toContain('private cancellation reason');
  expect(open).toHaveBeenCalledTimes(2);
});

it('blocks successful termination on an unavailable settlement and keeps the forwarding row for recovery', async () => {
  const supplier = response(), open = vi.fn(async () => supplier.opened);
  const s = await setup(open, {}, async sql => { if (sql.includes('SET state=?,failure_code=')) throw new Error('Private storage failure'); });
  const attempt = await s.a.dispatchStream(request('uncommitted'));
  if (!attempt.dispatched || !attempt.response) throw new Error('Missing streaming response');
  supplier.terminal();
  await expect(attempt.response.text()).rejects.toThrow('without a verified terminal frame');
  await expect(attempt.completion).rejects.toThrow('settlement could not be verified');
  expect(await s.a.read('uncommitted')).toMatchObject({ state: 'forwarding', accountedOutputTokens: 60 });
  expect(await s.a.dispatchStream(request('uncommitted'))).toMatchObject({ dispatched: false });
  expect(await s.ledger.reconcileInterrupted(s.authorityA, 'slot-A', 'uncommitted')).toMatchObject({ state: 'unknown' });
  await expect(s.a.dispatchStream(request('next', 1))).rejects.toThrow(/budget or slot state/);
  expect(open).toHaveBeenCalledOnce();
});

it('cancels a hung upstream before headers on the deadline and discards a late response', async () => {
  vi.useFakeTimers();
  const supplier = response(), entered = gate(), late = gate();
  const open = vi.fn<ComparisonStreamingTransport['open']>(async ({ signal }) => {
    entered.release(); await late.promise;
    expect(signal.aborted).toBe(true);
    return supplier.opened;
  });
  const s = await setup(open, { deadlineAt: now + 1000 });
  const dispatch = s.a.dispatchStream(request('late'));
  await entered.promise;
  await vi.advanceTimersByTimeAsync(1000);
  const attempt = await dispatch;
  if (!attempt.dispatched) throw new Error('Missing dispatch');
  expect(attempt.response).toBeNull();
  await expect(attempt.completion).resolves.toMatchObject({ state: 'unknown', accountedOutputTokens: 60 });
  late.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(supplier.cancel).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledOnce();
});
