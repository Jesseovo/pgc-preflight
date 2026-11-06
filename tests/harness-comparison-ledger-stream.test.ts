import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  COMPARISON_LEDGER_SCHEMA, comparisonAdmittedSlotsSha256, openComparisonLedger,
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

function request(requestId: string, cap = 60) {
  return { requestId, stage: 'review' as const, body: encoder.encode(JSON.stringify({ model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'private synthetic source' }], stream: true, max_tokens: cap })) };
}

async function setup(open: ComparisonStreamingTransport['open'], caps: Partial<Pick<ComparisonGrant, 'maxRequests' | 'maxOutputTokens' | 'deadlineAt'>> = {},
  beforeStatement?: (sql: string) => Promise<void>) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  for (const sql of COMPARISON_LEDGER_SCHEMA) db.exec(sql);
  const connection: ComparisonLedgerDatabase = { prepare(sql) {
    const statement = db.prepare(sql);
    const wrapper = (args: (string | number | null)[]) => ({ bind: (...bound: (string | number | null)[]) => wrapper(bound),
      async first<T>() { await beforeStatement?.(sql); return (statement.get(...args) ?? null) as T | null; } });
    return wrapper([]);
  } };
  const route = { transportId: 'test-stream', modelContractHash: digest('a'), protocol: 'openai' as const, model: 'deepseek-flash',
    effort: null, stream: true, jsonMode: false, maxOutputTokens: 80 };
  const slots: ComparisonAdmittedSlot[] = (['A', 'B'] as const).map(arm => ({ slotId: `slot-${arm}`, taskId: `task-${arm}`, ownerId: `owner-${arm}`,
    caseId: 'tap-rhythm', arm, operation: 'review', sourceSha256: digest('b'), evidenceSha256: digest('c'), modelConfigSha256: digest('d'), stages: { review: route } }));
  const grant: ComparisonGrant = { schemaVersion: 1, purpose: 'isolated-comparison', scope: 'rehearsal', runId: 'stream-test', ledgerDatabaseId: 'local-d1',
    planSha256: digest('e'), manifestSha256: digest('f'), admittedSlotsSha256: await comparisonAdmittedSlotsSha256(slots), authorizationSha256: digest('1'),
    maxRequests: 2, maxOutputTokens: 100, notBefore: now - 1, deadlineAt: now + 60_000, ...caps };
  const authorityA = {}, authorityB = {};
  const ledger = await openComparisonLedger({ database: { scope: 'isolated-comparison', id: 'local-d1', connection }, grant, slots,
    authorities: new Map([['slot-A', authorityA], ['slot-B', authorityB]]),
    streamingTransports: new Map([['test-stream', { kind: 'synthetic', modelContractHash: digest('a'), open }]]), now: () => now });
  return { db, ledger, authorityA, a: ledger.bindSlot(authorityA, 'slot-A'), b: ledger.bindSlot(authorityB, 'slot-B') };
}

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
