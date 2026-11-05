import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeHarnessLease, createHarnessRun, endHarnessRun, finishHarnessRequest, forwardHarnessRequest, getHarnessRun,
  getHarnessRunSummary, lockHarnessModel, readLockedHarnessProfile, rearmHarnessRequest, recordHarnessEvent,
  releaseHarnessSlot, reserveHarnessRequest, type HarnessDatabase,
} from '../server/harness-ledger';
import { HARNESS_MAX_REQUEST_MS, HARNESS_MAX_TASK_MS } from '../server/harness-protocol';
import type { ModelConfig, StoredModelProfile } from '../server/settings';

const opened: DatabaseSync[] = [];
const timestamp = 1_800_000_000_000;
const source = '1'.repeat(64);
const bodyHash = '2'.repeat(64);
const profile: StoredModelProfile = {
  model: 'claude-opus-5-5', baseUrl: 'https://riffle-api.pages.dev', protocol: 'anthropic',
  encryptedKey: 'private-test-encrypted-key', enabled: true, updatedAt: 'initial', effort: 'low',
};
const config = { ...profile, activeProfile: 'opus', profiles: { opus: profile } };

async function setup() {
  const sqlite = new DatabaseSync(':memory:');
  opened.push(sqlite);
  for (const file of readdirSync('migrations').sort().filter(name => name.endsWith('.sql') && name < '0034')) {
    sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  const db: HarnessDatabase = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) {
          const args = values as SQLInputValue[];
          return {
            ...this,
            first: async <T>() => (statement.get(...args) as T | undefined) ?? null,
            run: async () => statement.run(...args),
          };
        },
        first: async <T>() => (statement.get() as T | undefined) ?? null,
        run: async () => statement.run(),
      };
    },
  };
  const model = (await lockHarnessModel(config, 'game'))!;
  const create = (taskId: string, generation = 'g-1', ownerId = 'member-a', limits?: {
    maxTotalOutputTokens: number; maxModelTurns: number;
  }) => createHarnessRun(db, { taskId, generation, ownerId, actor: 'star', model, sourceHash: source, snapshot: { inputs: ['artifact-v1'] }, now: timestamp, limits });
  return { sqlite, db, create };
}

afterEach(() => opened.splice(0).forEach(db => db.close()));

describe('harness run ledger', () => {
  it('keeps at most two physical leases until terminal teardown and never replaces a task generation', async () => {
    const { db, create } = await setup();
    const results = await Promise.all([create('task-1'), create('task-2'), create('task-3')]);
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results.filter(Boolean).map(result => result!.run.slot).sort()).toEqual([1, 2]);
    const first = results.find(Boolean)!;
    expect(await endHarnessRun(db, first.run, 'failed')).toBe(true);
    expect(await create('queued-task')).toBeNull();
    await releaseHarnessSlot(db, first.run);
    expect(await create(first.run.taskId, 'g-2')).toBeNull();
    expect(await create('queued-task')).not.toBeNull();
  });

  it('binds a lease to its exact task, generation, live owner authorization and deadline', async () => {
    const { db, create, sqlite } = await setup();
    const own = (await create('own'))!;
    const other = (await create('other', 'g-1', 'member-b'))!;
    const options = { now: timestamp, authorizeRun: async (run: typeof own.run) => run.ownerId === 'member-a' };
    expect(await authorizeHarnessLease(db, own.run, own.lease, options)).toEqual(own.run);
    expect(await authorizeHarnessLease(db, other.run, own.lease, options)).toBeNull();
    expect(await authorizeHarnessLease(db, other.run, other.lease, options)).toBeNull();
    expect(await authorizeHarnessLease(db, { ...own.run, generation: 'g-2' }, own.lease, options)).toBeNull();
    expect(await authorizeHarnessLease(db, own.run, own.lease, { ...options, now: timestamp + HARNESS_MAX_TASK_MS })).toBeNull();
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM harness_runs').all())).not.toContain(own.lease);
    expect(await getHarnessRunSummary(db, own.run)).not.toHaveProperty('model');
  });

  it('serializes concurrent calls and clamps the next reservation to the actual remaining output budget', async () => {
    const { db, create, sqlite } = await setup();
    const { run } = (await create('task', undefined, undefined, { maxTotalOutputTokens: 100_000, maxModelTurns: 24 }))!;
    const first = { ...run, requestId: 'phase-1' };
    const second = { ...run, requestId: 'phase-2' };
    const competing = { ...run, requestId: 'helper' };
    expect(await Promise.all([
      reserveHarnessRequest(db, first, bodyHash, 64_000, timestamp),
      reserveHarnessRequest(db, first, bodyHash, 64_000, timestamp),
      reserveHarnessRequest(db, competing, bodyHash, 64_000, timestamp),
    ])).toEqual([
      { status: 'reserved', outputCap: 64_000, deadlineAt: timestamp + HARNESS_MAX_REQUEST_MS },
      { status: 'duplicate', previous: 'reserved' },
      { status: 'blocked' },
    ]);
    expect(await reserveHarnessRequest(db, first, source, 64_000, timestamp)).toEqual({ status: 'conflict' });
    expect(await forwardHarnessRequest(db, first, timestamp)).toBe(true);
    expect(await forwardHarnessRequest(db, first, timestamp)).toBe(false);
    expect(await finishHarnessRequest(db, first, { state: 'completed', outputTokens: 55_000, finishReason: 'tool_use' }, timestamp + 1)).toBe(true);
    expect(await reserveHarnessRequest(db, second, bodyHash, 64_000, timestamp + 1)).toMatchObject({ status: 'reserved', outputCap: 45_000 });
    expect(await endHarnessRun(db, run, 'done', undefined, timestamp + 1)).toBe(false);
    await forwardHarnessRequest(db, second, timestamp + 2);
    await finishHarnessRequest(db, second, { state: 'completed', outputTokens: 45_000, finishReason: 'end_turn' }, timestamp + 3);
    expect(await reserveHarnessRequest(db, competing, bodyHash, 1, timestamp + 4)).toEqual({ status: 'blocked' });
    expect(await getHarnessRunSummary(db, run)).toMatchObject({ modelTurns: 2, outputTokens: 100_000, reservedTokens: 0 });
    expect(await endHarnessRun(db, run, 'done', undefined, timestamp + 4)).toBe(true);
    expect(sqlite.prepare('SELECT purpose,status,max_tokens,output_tokens FROM model_runs ORDER BY id').all()).toEqual([
      { purpose: 'harness:game', status: 'ok', max_tokens: 64_000, output_tokens: 55_000 },
      { purpose: 'harness:game', status: 'ok', max_tokens: 45_000, output_tokens: 45_000 },
    ]);
  });

  it('counts bounded explicit retries and rejects further turns at the task limit', async () => {
    const { db, create } = await setup();
    const { run } = (await create('task', undefined, undefined, { maxTotalOutputTokens: 256_000, maxModelTurns: 2 }))!;
    const request = { ...run, requestId: 'build-1' };
    await reserveHarnessRequest(db, request, bodyHash, 64_000, timestamp);
    await forwardHarnessRequest(db, request, timestamp);
    expect(await rearmHarnessRequest(db, request)).toBe(true);
    expect(await forwardHarnessRequest(db, request, timestamp + 1)).toBe(true);
    expect(await rearmHarnessRequest(db, request)).toBe(false);
    await finishHarnessRequest(db, request, { state: 'completed', outputTokens: 1 }, timestamp + 2);
    expect(await reserveHarnessRequest(db, { ...run, requestId: 'build-2' }, bodyHash, 64_000, timestamp + 3)).toEqual({ status: 'blocked' });
    expect(await getHarnessRunSummary(db, run)).toMatchObject({ modelTurns: 2, outputTokens: 1 });
  });

  it('latches an interrupted paid call as unknown and never converts its task to success', async () => {
    const { db, create } = await setup();
    const { run } = (await create('task'))!;
    const request = { ...run, requestId: 'build-1' };
    await reserveHarnessRequest(db, request, bodyHash, 64_000, timestamp);
    await forwardHarnessRequest(db, request, timestamp);
    expect(await reserveHarnessRequest(db, { ...run, requestId: 'build-2' }, bodyHash, 64_000, timestamp + HARNESS_MAX_REQUEST_MS)).toEqual({ status: 'blocked' });
    expect(await endHarnessRun(db, run, 'done', undefined, timestamp + HARNESS_MAX_REQUEST_MS)).toBe(false);
    expect(await finishHarnessRequest(db, request, { state: 'completed', outputTokens: 10 }, timestamp + HARNESS_MAX_REQUEST_MS)).toBe(false);
    expect(await getHarnessRun(db, run)).toMatchObject({ status: 'unknown', failureCode: 'deadline', outputTokens: 0, reservedTokens: 64_000 });
  });

  it('limits repairs to two atomic distinct declarations', async () => {
    const { db, create } = await setup();
    const { run } = (await create('task'))!;
    expect(await recordHarnessEvent(db, run, 'repair', 2, timestamp)).toBe(false);
    expect(await Promise.all([1, 1].map(number => recordHarnessEvent(db, run, 'repair', number, timestamp)))).toEqual([true, false]);
    expect(await recordHarnessEvent(db, run, 'repair', 2, timestamp)).toBe(true);
    expect(await recordHarnessEvent(db, run, 'repair', 3, timestamp)).toBe(false);
  });

  it('locks the selected profile and stops when credentials or capability change', async () => {
    const other: StoredModelProfile = { ...profile, protocol: 'openai', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', vision: false };
    const routed: ModelConfig = { ...config, profiles: { opus: profile, deepseek: other }, routes: { create: 'deepseek', review: 'deepseek' } };
    const game = (await lockHarnessModel(routed, 'game'))!;
    const review = (await lockHarnessModel(routed, 'review'))!;
    expect(game).toMatchObject({ profileId: 'opus', maxOutputTokens: 64_000, effort: 'high' });
    expect(review).toMatchObject({ profileId: 'deepseek', maxOutputTokens: 24_000, effort: 'low', vision: false });
    expect(await readLockedHarnessProfile(routed, game)).toBe(profile);
    expect(await readLockedHarnessProfile({ ...routed, profiles: { opus: { ...profile, encryptedKey: 'rotated' } } }, game)).toBeNull();
    expect(await readLockedHarnessProfile({ ...routed, profiles: { opus: { ...profile, enabled: false } } }, game)).toBeNull();
  });
});
