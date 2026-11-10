import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  COMPARISON_LEDGER_SCHEMA, comparisonAdmittedSlotsSha256, openComparisonLedger,
  type ComparisonAdmittedSlot, type ComparisonGrant, type ComparisonLedgerDatabase, type ComparisonTransport,
} from '../scripts/harness-comparison-ledger';

const digest = (digit: string) => digit.repeat(64);
const baseTime = 1_800_000_000_000;
const text = new TextEncoder();
const databases: DatabaseSync[] = [];
const directories: string[] = [];
let blockedFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  blockedFetch = vi.fn(() => { throw new Error('Unexpected real transport'); });
  vi.stubGlobal('fetch', blockedFetch);
});
afterEach(() => {
  expect(blockedFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sqlite(file: string) {
  const db = new DatabaseSync(file);
  databases.push(db);
  return db;
}

function facade(db: DatabaseSync, beforeStatement?: (sql: string) => void): ComparisonLedgerDatabase {
  return { prepare(sql) {
    const statement = db.prepare(sql);
    const query = (args: (string | number | null)[]) => ({
      bind(...bound: (string | number | null)[]) { return query(bound); },
      async first<T>() {
        beforeStatement?.(sql);
        return (statement.get(...args) ?? null) as T | null;
      },
    });
    return query([]);
  } };
}

function wire(cap: number, extra: Record<string, unknown> = {}) {
  return text.encode(JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'private-material-wire' }],
    stream: true, max_tokens: cap, reasoning_effort: 'low', thinking: { type: 'enabled' },
    response_format: { type: 'json_object' }, ...extra }));
}

function makeSlot(arm: 'A' | 'B'): ComparisonAdmittedSlot {
  const route = { transportId: 'deepseek-review', modelContractHash: digest('a'), protocol: 'openai' as const, model: 'deepseek-flash',
    effort: 'low' as const, stream: true, jsonMode: true, maxOutputTokens: 80 };
  return { slotId: `slot-${arm}`, taskId: `task-${arm}`, ownerId: `owner-${arm}`, caseId: 'case-one', arm, operation: 'review',
    sourceSha256: digest('b'), evidenceSha256: digest('c'), modelConfigSha256: digest('d'), stages: { review: route, review_verify: route } };
}

async function setup(
  send: ComparisonTransport<string>['send'],
  caps: Partial<Pick<ComparisonGrant, 'maxRequests' | 'maxOutputTokens'>> = {},
  slots = [makeSlot('A'), makeSlot('B')],
) {
  const directory = mkdtempSync(join(tmpdir(), 'comparison-ledger-'));
  directories.push(directory);
  const file = join(directory, 'research.sqlite');
  const db = sqlite(file);
  for (const sql of COMPARISON_LEDGER_SCHEMA) db.exec(sql);
  const authorityA = {}, authorityB = {}, authorityCreation = {};
  const authorities = new Map([['slot-A', authorityA], ['slot-B', authorityB], ['slot-B-build', authorityCreation]]);
  const grant: ComparisonGrant = { schemaVersion: 1, purpose: 'isolated-comparison', scope: 'rehearsal', runId: 'run-one',
    ledgerDatabaseId: 'research-only', planSha256: digest('e'), manifestSha256: digest('f'),
    admittedSlotsSha256: await comparisonAdmittedSlotsSha256(slots), authorizationSha256: digest('1'),
    maxRequests: 3, maxOutputTokens: 100, notBefore: baseTime, deadlineAt: baseTime + 60_000, ...caps };
  const transports = new Map<string, ComparisonTransport<string>>([
    ['deepseek-review', { kind: 'synthetic', modelContractHash: digest('a'), send }],
    ['opus-create', { kind: 'synthetic', modelContractHash: digest('3'), send }],
  ]);
  const options = { database: { scope: 'isolated-comparison' as const, id: 'research-only', connection: facade(db) },
    grant, slots, authorities, transports, now: () => baseTime + 1 };
  const ledger = await openComparisonLedger(options);
  return { db, file, options, ledger, authorityA, authorityB, authorityCreation, a: ledger.bindSlot(authorityA, 'slot-A'), b: ledger.bindSlot(authorityB, 'slot-B') };
}

const req = (requestId: string, cap = 60, stage: 'review' | 'review_verify' = 'review') => ({ requestId, stage, body: wire(cap) });
const completed = (outputTokens: number | null = 25) =>
  ({ state: 'completed' as const, result: 'in-memory-private-result', inputTokens: 40, outputTokens });

describe('isolated comparison dispatch ledger', () => {
  test('two connections cannot reserve concurrent A/B output above the shared cap', async () => {
    let finish!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    const send = vi.fn(async () => { started(); await pending; return completed(); });
    const s = await setup(send);
    const peer = await openComparisonLedger({ ...s.options, database: { ...s.options.database, connection: facade(sqlite(s.file)) } });
    const first = s.a.dispatch(req('review-0'));
    await began;
    const duplicate = await peer.bindSlot(s.authorityA, 'slot-A').dispatch(req('review-0'));
    expect(duplicate).toMatchObject({ dispatched: false, receipt: { state: 'forwarding', accountedOutputTokens: 60 } });
    expect(duplicate).not.toHaveProperty('result');
    const b = peer.bindSlot(s.authorityB, 'slot-B');
    await expect(b.dispatch(req('review-0'))).rejects.toThrow(/budget or slot state/);
    await expect(s.a.dispatch(req('parallel', 10))).rejects.toThrow(/budget or slot state/);
    finish();
    await expect(first).resolves.toMatchObject({ dispatched: true, result: 'in-memory-private-result',
      receipt: { state: 'completed', inputTokens: 40, outputTokens: 25, accountedOutputTokens: 25 } });
    await expect(b.dispatch(req('review-0'))).resolves.toMatchObject({ dispatched: true, receipt: { arm: 'B' } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await s.ledger.budget()).toMatchObject({ reservedRequests: 2, forwardingCommitted: 2, accountedOutputTokens: 50 });
    expect(s.db.prepare('SELECT state FROM comparison_dispatch_transitions WHERE slot_id=? AND request_id=? ORDER BY rowid')
      .all('slot-A', 'review-0').map(row => row.state)).toEqual(['reserved', 'forwarding', 'completed']);
  });

  test('parallel slots cannot exceed the aggregate request cap even after known completion', async () => {
    const send = vi.fn(async () => completed(0));
    const s = await setup(send, { maxRequests: 1, maxOutputTokens: 500 });
    const peer = await openComparisonLedger({ ...s.options, database: { ...s.options.database, connection: facade(sqlite(s.file)) } });
    const outcomes = await Promise.allSettled([s.a.dispatch(req('request-a')), peer.bindSlot(s.authorityB, 'slot-B').dispatch(req('request-b'))]);
    expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await s.ledger.budget()).toMatchObject({ reservedRequests: 1, forwardingCommitted: 1, accountedOutputTokens: 0 });
  });

  test('unknown send latches its slot, keeps its cap and stores no wire or exception text', async () => {
    const send = vi.fn<ComparisonTransport<string>['send']>().mockRejectedValueOnce(new Error('private-credential-and-reasoning'))
      .mockResolvedValueOnce(completed(null));
    const s = await setup(send);
    const result = await s.a.dispatch(req('unknown'));
    expect(result).toMatchObject({ dispatched: true, receipt: { state: 'unknown', failureCode: 'transport-outcome-unknown',
      inputTokens: null, outputTokens: null, accountedOutputTokens: 60, attempt: 1 } });
    expect(await s.a.dispatch(req('unknown'))).toMatchObject({ dispatched: false, receipt: result.receipt });
    await expect(s.a.dispatch(req('next', 10, 'review_verify'))).rejects.toThrow(/budget or slot state/);
    await expect(s.b.dispatch(req('over', 41))).rejects.toThrow(/budget or slot state/);
    await expect(s.b.dispatch(req('fits', 40))).resolves.toMatchObject({ receipt: { state: 'completed', outputTokens: null,
      accountedOutputTokens: 40 } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await s.ledger.budget()).toMatchObject({ accountedOutputTokens: 100, unknownRequests: 1 });
    const stored = JSON.stringify(s.db.prepare('SELECT * FROM comparison_dispatch_attempts').all());
    expect(stored).not.toMatch(/private-material-wire|private-credential-and-reasoning|in-memory-private-result/);
  });

  test('lost durable settlement is reconciled without dispatching again', async () => {
    const send = vi.fn(async () => completed());
    const s = await setup(send);
    const interrupted = await openComparisonLedger({ ...s.options, database: { ...s.options.database,
      connection: facade(sqlite(s.file), sql => {
        if (sql.includes('SET state=?,failure_code=')) throw new Error('Simulated crash before settlement');
      }),
    } });
    await expect(interrupted.bindSlot(s.authorityA, 'slot-A').dispatch(req('interrupted'))).rejects.toThrow(/Simulated crash/);
    const restarted = await openComparisonLedger(s.options);
    const slot = restarted.bindSlot(s.authorityA, 'slot-A');
    expect(await slot.dispatch(req('interrupted'))).toMatchObject({ dispatched: false, receipt: { state: 'forwarding' } });
    expect(await restarted.reconcileInterrupted(s.authorityA, 'slot-A', 'interrupted')).toMatchObject({
      state: 'unknown', outputTokens: null, accountedOutputTokens: 60,
    });
    await expect(slot.dispatch(req('new', 5))).rejects.toThrow(/budget or slot state/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('grant, owner, slot, body, model, output and destination tampering fail closed', async () => {
    const send = vi.fn(async () => completed());
    const s = await setup(send);
    const { options } = s;
    expect(() => s.ledger.bindSlot(s.authorityA, 'slot-B')).toThrow(/authority mismatch/);
    expect(() => s.ledger.bindSlot({}, 'slot-A')).toThrow(/authority mismatch/);
    await expect(openComparisonLedger({ ...options, slots: [{ ...options.slots[0], ownerId: 'wrong-owner' }, options.slots[1]] }))
      .rejects.toThrow(/slot snapshot/);
    await expect(openComparisonLedger({ ...options, grant: { ...options.grant, maxRequests: 0 } })).rejects.toThrow(/explicit isolated/);
    await expect(openComparisonLedger({ ...options, grant: { ...options.grant, maxOutputTokens: null } as unknown as ComparisonGrant }))
      .rejects.toThrow(/explicit isolated/);
    await expect(openComparisonLedger({ ...options, grant: { ...options.grant, purpose: 'synthetic-compatibility' } as unknown as ComparisonGrant }))
      .rejects.toThrow(/explicit isolated/);
    await expect(openComparisonLedger({ ...options, database: { ...options.database, id: 'wrong-database' } })).rejects.toThrow(/explicit isolated/);
    await expect(openComparisonLedger({ ...options, grant: { ...options.grant, planSha256: digest('2') } })).rejects.toThrow(/immutable grant/);
    await expect(openComparisonLedger({ ...options, grant: { ...options.grant, scope: 'formal' } })).rejects.toThrow(/transport conflicts/);
    await expect(s.a.dispatch({ ...req('model'), body: wire(60, { model: 'other-model' }) })).rejects.toThrow(/wire model/);
    await expect(s.a.dispatch({ ...req('bad-cap'), body: wire(81) })).rejects.toThrow(/output cap/);
    await expect(s.a.dispatch({ ...req('json'), body: wire(60, { response_format: undefined }) })).rejects.toThrow(/JSON mode/);
    await expect(s.a.dispatch({ ...req('effort'), body: wire(60, { reasoning_effort: 'high' }) })).rejects.toThrow(/wire effort/);
    await expect(s.a.dispatch({ ...req('route'), body: wire(60, { base_url: 'https://example.invalid' }) })).rejects.toThrow(/wire routing/);
    await expect(s.a.dispatch({ ...req('foreign'), url: 'https://example.invalid' } as ReturnType<typeof req>)).rejects.toThrow(/dispatch request/);
    await expect(s.a.dispatch({ ...req('ambiguous'), body: text.encode(new TextDecoder().decode(wire(60)).replace('{', '{"max_tokens":900,')) }))
      .rejects.toThrow(/compact JSON/);
    expect(send).not.toHaveBeenCalled();
    await s.a.dispatch(req('fixed'));
    await expect(s.a.dispatch(req('fixed', 61))).rejects.toThrow(/reserved wire/);
    await expect(s.a.dispatch(req('fixed', 60, 'review_verify'))).rejects.toThrow(/reserved wire/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('late sealed B evidence binds both review arms without reopening the shared grant', async () => {
    const send = vi.fn(async () => completed(20));
    const creation: ComparisonAdmittedSlot = { ...makeSlot('B'), slotId: 'slot-B-build', taskId: 'task-B-build',
      operation: 'creation', evidenceSha256: null, stages: {
        build: { transportId: 'opus-create', modelContractHash: digest('3'), protocol: 'anthropic', model: 'claude-opus-5-5',
          effort: 'high', stream: true, jsonMode: false, maxOutputTokens: 80 },
      },
    };
    const pending = [makeSlot('A'), makeSlot('B')].map(slot => ({ ...slot, sourceSha256: null, evidenceSha256: null }));
    const s = await setup(send, {}, [creation, ...pending]);
    const opus = text.encode(JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'create' }],
      stream: true, max_tokens: 80, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }));
    await expect(s.ledger.bindSlot(s.authorityCreation, creation.slotId).dispatch({ requestId: 'build-0', stage: 'build', body: opus }))
      .resolves.toMatchObject({ receipt: { operation: 'creation', modelContractHash: digest('3'), state: 'completed' } });
    await expect(s.a.dispatch(req('review-0'))).rejects.toThrow(/awaits sealed evidence/);
    await expect(s.b.dispatch(req('review-0'))).rejects.toThrow(/awaits sealed evidence/);
    const peer = await openComparisonLedger({ ...s.options, database: { ...s.options.database, connection: facade(sqlite(s.file)) } });
    const material = { sourceSha256: digest('4'), evidenceSha256: digest('5') };
    const competing = { sourceSha256: digest('4'), evidenceSha256: digest('6') };
    const admitted = await Promise.allSettled([
      s.ledger.admitReviewEvidence(s.authorityA, 'slot-A', material),
      peer.admitReviewEvidence(s.authorityB, 'slot-B', competing),
    ]);
    expect(admitted.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = admitted.find(result => result.status === 'fulfilled')!.value;
    await expect(peer.admitReviewEvidence(s.authorityB, 'slot-B', winner)).resolves.toEqual(winner);
    const a = await s.a.dispatch(req('review-0'));
    const b = await s.b.dispatch(req('review-0'));
    expect(a.receipt).toMatchObject(winner);
    expect(b.receipt).toMatchObject(winner);
    expect(a.receipt.slotSha256).not.toBe(b.receipt.slotSha256);
    expect(await peer.budget()).toMatchObject({ reservedRequests: 3, forwardingCommitted: 3, accountedOutputTokens: 60 });
    await expect(s.a.dispatch(req('verify-0', 20, 'review_verify'))).rejects.toThrow(/budget or slot state/);
    expect(send).toHaveBeenCalledTimes(3);
  });

  test('known provider rejection records one settled attempt and null usage without retry', async () => {
    const send = vi.fn<ComparisonTransport<string>['send']>().mockResolvedValue({
      state: 'failed', failureCode: 'provider-rejected', inputTokens: null, outputTokens: null,
    });
    const s = await setup(send);
    const first = await s.a.dispatch(req('rejected'));
    expect(first).toMatchObject({ dispatched: true, receipt: { state: 'failed', failureCode: 'provider-rejected',
      inputTokens: null, outputTokens: null, accountedOutputTokens: 60 } });
    expect(await s.a.dispatch(req('rejected'))).toMatchObject({ dispatched: false, receipt: first.receipt });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('deadline and known over-cap usage halt later paid dispatch', async () => {
    const send = vi.fn(async () => completed(61));
    const s = await setup(send);
    const expired = await openComparisonLedger({ ...s.options, now: () => s.options.grant.deadlineAt });
    await expect(expired.bindSlot(s.authorityA, 'slot-A').dispatch(req('expired'))).rejects.toThrow(/deadline/);
    expect(send).not.toHaveBeenCalled();
    const result = await s.a.dispatch(req('over-cap'));
    expect(result).toMatchObject({ receipt: { state: 'failed', failureCode: 'usage-exceeds-reservation',
      outputTokens: 61, accountedOutputTokens: 61 } });
    expect(result).not.toHaveProperty('result');
    await expect(s.b.dispatch(req('new', 5))).rejects.toThrow(/budget or slot state/);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
