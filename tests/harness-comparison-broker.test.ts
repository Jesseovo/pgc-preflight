import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { COMPARISON_LEDGER_SCHEMA, comparisonAdmittedSlotsSha256, openComparisonLedger,
  type ComparisonAdmittedSlot, type ComparisonGrant, type ComparisonLedgerDatabase } from '../scripts/harness-comparison-ledger';
import { createComparisonBaselineBroker, createComparisonHarnessBroker } from '../server/harness-comparison-broker';
import { createHarnessRun, lockHarnessModel } from '../server/harness-ledger';
import { HARNESS_MODEL_HEADERS } from '../server/harness-protocol';
import { modelContractHash } from '../server/harness-policy';
import { encryptKey, type ModelConfig } from '../server/settings';

const providerKey = 'synthetic-server-provider-secret';
const settingsKey = 'synthetic-settings';
const sentinel = 'pgc-comparison-local-placeholder';
const taskId = '44444444-4444-8444-8444-444444444444';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

function dbInterface(db: DatabaseSync, beforeFirst?: (sql: string) => void) {
  function prepare(sql: string, values: SQLInputValue[] = []) {
    return { bind: (...next: SQLInputValue[]) => prepare(sql, next),
      async first<T>() { beforeFirst?.(sql); return (db.prepare(sql).get(...values) ?? null) as T | null; },
      async run() { return db.prepare(sql).run(...values); },
    };
  }
  return { prepare };
}

const sseText = (events: unknown[]) => events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join('');
const sse = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/event-stream', 'x-secret-upstream': providerKey } });
const anthropic = sseText([
  { type: 'message_start', message: { usage: { input_tokens: 9 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'synthetic text' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
  { type: 'message_stop' },
]);
const openai = sseText([
  { choices: [{ delta: { content: 'synthetic text' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 12 } },
  '[DONE]',
]);

async function setup(fetcher: (url: string, init: RequestInit) => Promise<Response>, options: { creation?: boolean; rotateOnLoad?: number; denyOnCheck?: number } = {}) {
  const direct = vi.fn(() => { throw new Error('No global network'); });
  vi.stubGlobal('fetch', direct);
  const ledgerDb = new DatabaseSync(':memory:'), capacityDb = new DatabaseSync(':memory:');
  databases.push(ledgerDb, capacityDb);
  for (const sql of COMPARISON_LEDGER_SCHEMA) ledgerDb.exec(sql);
  for (const file of ['0007_model_throttle.sql', '0023_model_slots.sql']) capacityDb.exec(readFileSync('migrations/' + file, 'utf8'));
  const creation = options.creation === true, protocol = creation ? 'anthropic' : 'openai', model = creation ? 'claude-opus-5-5' : 'deepseek-flash';
  const baseUrl = creation ? 'https://riffle-api.pages.dev' : 'https://api.deepseek.com';
  const url = baseUrl + (creation ? '/v1/messages' : '/chat/completions'), effort = creation ? 'high' : 'low', maxOutputTokens = creation ? 64_000 : 24_000;
  const publicProfile = { model, baseUrl, protocol, vision: true, enabled: true, effort, maxOutputTokens, updatedAt: 'synthetic' } as const;
  const snapshot = JSON.stringify(publicProfile);
  async function configuration(key: string): Promise<ModelConfig> {
    const profile = { ...publicProfile, encryptedKey: await encryptKey(key, settingsKey) };
    return { ...profile, activeProfile: 'approved', profiles: { approved: profile }, routes: { [creation ? 'create' : 'review']: 'approved' } };
  }
  const initial = await configuration(providerKey), rotated = await configuration('another-synthetic-key');
  const purpose = creation ? 'game' : 'review';
  const pinned = (await lockHarnessModel(initial, purpose, maxOutputTokens))!;
  const stage = creation ? 'build' : 'review';
  const slot: ComparisonAdmittedSlot = {
    slotId: 'slot-a', taskId, ownerId: creation ? 'synthetic-star' : 'admin', caseId: 'tap-rhythm', arm: 'A',
    operation: creation ? 'creation' : 'review', sourceSha256: hash('source'), evidenceSha256: creation ? null : hash('evidence'),
    modelConfigSha256: hash(snapshot), stages: { [stage]: {
      transportId: 'transport-a', modelContractHash: await modelContractHash(initial, purpose), protocol, model,
      effort, stream: true, jsonMode: !creation, maxOutputTokens,
    } },
  };
  const now = Date.now();
  // All network is scripted. This formal-shaped fixture exercises the private provider gate.
  const grant: ComparisonGrant = { schemaVersion: 1, purpose: 'isolated-comparison', scope: 'formal', runId: 'run-a',
    ledgerDatabaseId: 'isolated-test', planSha256: hash('plan'), manifestSha256: hash('manifest'),
    admittedSlotsSha256: await comparisonAdmittedSlotsSha256([slot]), authorizationSha256: hash('authorization'),
    maxRequests: 2, maxOutputTokens: maxOutputTokens * 2, notBefore: now - 100, deadlineAt: now + 60_000,
  };
  let loads = 0, checks = 0;
  const brokerOptions = { slot, grant, settingsKey, capacityDB: dbInterface(capacityDb), fetcher,
    approval: { providerUrl: url, publicProfileSnapshot: snapshot, profileId: pinned.profileId, profileHash: pinned.profileHash },
    loadConfig: async () => ++loads === options.rotateOnLoad ? rotated : initial,
    authorize: async () => ++checks !== options.denyOnCheck,
  };
  const broker = await createComparisonBaselineBroker(brokerOptions), authority = {};
  const ledger = await openComparisonLedger({ database: { scope: 'isolated-comparison', id: grant.ledgerDatabaseId, connection: dbInterface(ledgerDb) as ComparisonLedgerDatabase },
    slots: [slot], authorities: new Map([[slot.slotId, authority]]), grant, streamingTransports: broker.streamingTransports });
  const bound = broker.bind(ledger, authority);
  const scope = { arm: 'A' as const, taskId, ownerId: slot.ownerId, operation: slot.operation, stage: stage as 'build' | 'review' };
  const key = (creation ? 'pgc-create-' + taskId + ':build-' : 'pgc-review-' + taskId + '-') + 'a'.repeat(24);
  const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream', 'Idempotency-Key': key,
    ...(creation ? { 'x-api-key': sentinel, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + sentinel }),
  });
  const body = JSON.stringify({ model, stream: true, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: 'synthetic prompt' }],
    ...(creation ? { thinking: { type: 'adaptive' }, output_config: { effort } } :
      { thinking: { type: 'enabled' }, reasoning_effort: effort, response_format: { type: 'json_object' } }),
  });
  const init = { method: 'POST', headers, body, redirect: 'manual' as const, signal: new AbortController().signal };
  const receipt = () => ledger.bindSlot(authority, slot.slotId).read(hash(key));
  const capacity = () => capacityDb.prepare('SELECT expires_at FROM model_slots').all();
  return { direct, brokerOptions, broker, authority, bound, scope, url, key, init, receipt, capacity, ledger, ledgerDb, pinned };
}

it.each([false, true])('forwards native SSE under the original A key and settles before releasing capacity (%s Anthropic)', async creation => {
  const fetcher = vi.fn(async () => sse(creation ? anthropic : openai));
  const s = await setup(fetcher, { creation });
  expect(() => s.broker.bind(s.ledger, {})).toThrow('authority mismatch');
  const response = await s.bound(s.scope, s.url, s.init);
  expect(response.headers.has('x-secret-upstream')).toBe(false);
  if (creation) expect(s.capacity()).toHaveLength(1);
  expect(await response.text()).toBe(creation ? anthropic : openai);
  const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(request[0]).toBe(s.url);
  expect(request[1]).toMatchObject({ method: 'POST', body: s.init.body, redirect: 'manual', signal: expect.any(AbortSignal) });
  const sent = new Headers(request[1].headers);
  expect(sent.get('Idempotency-Key')).toBe(s.key);
  expect(sent.get(creation ? 'x-api-key' : 'authorization')).toBe(creation ? providerKey : 'Bearer ' + providerKey);
  expect(await s.receipt()).toMatchObject({ requestId: hash(s.key), state: 'completed', outputTokens: 12, inputTokens: 9 });
  await vi.waitFor(() => expect(s.capacity()).toHaveLength(0));
  await expect(s.bound(s.scope, s.url, s.init)).rejects.toThrow('Comparison provider request unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(s.direct).not.toHaveBeenCalled();
  expect(JSON.stringify(s.ledgerDb.prepare('SELECT * FROM comparison_dispatch_attempts').all())).not.toContain(providerKey);
});

it('rejects the wrong task, URL, wire model or public profile without a provider call', async () => {
  const fetcher = vi.fn(async () => sse(openai));
  const s = await setup(fetcher);
  await expect(s.bound({ ...s.scope, ownerId: 'wrong' }, s.url, s.init)).rejects.toThrow('unavailable');
  await expect(s.bound(s.scope, 'https://unapproved.invalid', s.init)).rejects.toThrow('unavailable');
  await expect(s.bound(s.scope, s.url, { ...s.init, body: s.init.body.replace('deepseek-flash', 'other-model') })).rejects.toThrow('unavailable');
  await expect(createComparisonBaselineBroker({ ...s.brokerOptions, approval: { ...s.brokerOptions.approval, publicProfileSnapshot: '{}' } })).rejects.toThrow('unavailable');
  await expect(createComparisonBaselineBroker({ ...s.brokerOptions, grant: { ...s.brokerOptions.grant, scope: 'rehearsal' } })).rejects.toThrow('unavailable');
  await expect(createComparisonBaselineBroker({ ...s.brokerOptions, slot: { ...s.brokerOptions.slot, arm: 'B' } })).rejects.toThrow('unavailable');
  expect(await s.receipt()).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(s.direct).not.toHaveBeenCalled();
});

it('refuses a real ledger with a different grant or slot despite shared authority, route and task ID', async () => {
  const fetcher = vi.fn(async () => sse(openai));
  const s = await setup(fetcher);
  for (const change of ['grant', 'slot']) {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    for (const sql of COMPARISON_LEDGER_SCHEMA) db.exec(sql);
    const slot = { ...s.brokerOptions.slot, ownerId: change === 'slot' ? 'other-owner' : s.brokerOptions.slot.ownerId };
    const grant = { ...s.brokerOptions.grant, planSha256: change === 'grant' ? hash('other-plan') : s.brokerOptions.grant.planSha256,
      admittedSlotsSha256: await comparisonAdmittedSlotsSha256([slot]) };
    const other = await openComparisonLedger({ database: { scope: 'isolated-comparison', id: grant.ledgerDatabaseId, connection: dbInterface(db) },
      slots: [slot], authorities: new Map([[slot.slotId, s.authority]]), grant, streamingTransports: s.broker.streamingTransports });
    expect(() => s.broker.bind(other, s.authority)).toThrow('grant or slot mismatch');
    expect(db.prepare('SELECT count(*) AS count FROM comparison_dispatch_attempts').get()).toEqual({ count: 0 });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([{ rotateOnLoad: 3 }, { denyOnCheck: 3 }])('rechecks a changed credential or revoked authority after taking capacity %j', async options => {
  const fetcher = vi.fn(async () => sse(anthropic));
  const s = await setup(fetcher, { creation: true, ...options });
  await expect(s.bound(s.scope, s.url, s.init)).rejects.toThrow('unavailable');
  expect(fetcher).not.toHaveBeenCalled();
  expect(await s.receipt()).toMatchObject({ state: 'failed' });
  expect(s.capacity()).toHaveLength(0);
});

it('keeps uncertain request budget and Riffle capacity through the deadline and never replays', async () => {
  const fetcher = vi.fn(async () => sse(anthropic.split('data: {"type":"message_stop"}')[0]));
  const s = await setup(fetcher, { creation: true });
  const response = await s.bound(s.scope, s.url, s.init);
  await expect(response.text()).rejects.toThrow('verified terminal');
  expect(await s.receipt()).toMatchObject({ state: 'unknown', accountedOutputTokens: 64_000, outputTokens: null });
  expect(s.capacity()).toEqual([{ expires_at: s.brokerOptions.grant.deadlineAt }]);
  await expect(s.bound(s.scope, s.url, s.init)).rejects.toThrow('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not expose a provider plaintext error or a credential split across SSE events', async () => {
  const error = await setup(async () => new Response(providerKey + ' upstream body', { status: 429 }));
  await expect(error.bound(error.scope, error.url, error.init)).rejects.toThrow(/^Comparison provider request unavailable$/);
  const split = await setup(async () => sse(sseText([
    { choices: [{ delta: { content: providerKey.slice(0, 12) } }] },
    { choices: [{ delta: { content: providerKey.slice(12) } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }, '[DONE]',
  ])));
  const stream = await split.bound(split.scope, split.url, split.init);
  await expect(stream.text()).rejects.toThrow('verified terminal');
  expect(await split.receipt()).toMatchObject({ state: 'unknown' });
});

it.each([
  { status: 200, creation: true, staleDuringReserve: false }, { status: 200, creation: false, staleDuringReserve: false },
  { status: 429, creation: true, staleDuringReserve: false }, { status: 503, creation: true, staleDuringReserve: false },
  { status: 403, creation: true, staleDuringReserve: true }, { status: 403, creation: false, staleDuringReserve: true },
])('requires an active B phase, real Gateway lease and original native provider wire (%j)', async ({ status, creation, staleDuringReserve }) => {
  const fixtureStream = creation ? anthropic : openai;
  const send = vi.fn(async (_url: string, _init: RequestInit) => status === 200 ? sse(fixtureStream) : new Response(providerKey, { status }));
  const s = await setup(send, { creation });
  const globalDb = new DatabaseSync(':memory:'), harnessDb = new DatabaseSync(':memory:');
  databases.push(globalDb, harnessDb);
  for (const sql of COMPARISON_LEDGER_SCHEMA) globalDb.exec(sql);
  for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql') && name <= '0033_harness.sql').sort()) {
    harnessDb.exec(readFileSync('migrations/' + name, 'utf8'));
  }
  const harnessDB = dbInterface(harnessDb), slot = { ...s.brokerOptions.slot, arm: 'B' as const };
  const grant = { ...s.brokerOptions.grant, admittedSlotsSha256: await comparisonAdmittedSlotsSha256([slot]) };
  const generation = 'generation-b', stage = creation ? 'build' : 'review', requestIdPrefix = stage + '-0-', requestId = requestIdPrefix + 'native-turn';
  if (creation) harnessDb.prepare(`INSERT INTO forge_tasks(id,owner_id,kind,scope,payload,status,executor,creative_version,phase,created_at,updated_at)
    VALUES(?,?,'game','fixture','{}','running','platform',2,'build:waiting','fixture','fixture')`).run(taskId, slot.ownerId);
  else harnessDb.prepare(`INSERT INTO review_jobs(id,owner_id,title,status,executor,model_executor,stage,created_at,updated_at)
    VALUES(?,?,'fixture','running','cloud','platform','review','fixture','fixture')`).run(taskId, slot.ownerId);
  const updateStage = harnessDb.prepare(creation ? 'UPDATE forge_tasks SET phase=? WHERE id=?' : 'UPDATE review_jobs SET stage=? WHERE id=?');
  const active = (await createHarnessRun(harnessDB, { taskId, generation, ownerId: slot.ownerId,
    actor: creation ? 'star' : 'admin', family: creation ? 'forge' : 'review',
    model: s.pinned, sourceHash: hash('source'), snapshot: {}, deadlineAt: grant.deadlineAt }))!;
  const broker = await createComparisonHarnessBroker({ ...s.brokerOptions, grant, slot, harnessDB, authorizeRun: async () => true });
  const authority = {}, ledger = await openComparisonLedger({ database: { scope: 'isolated-comparison', id: grant.ledgerDatabaseId,
    connection: dbInterface(globalDb, sql => {
      if (staleDuringReserve && sql.includes("UPDATE comparison_dispatch_attempts SET state='forwarding'")) updateStage.run(creation ? 'polish:model' : 'verify', taskId);
    }) }, slots: [slot], authorities: new Map([[slot.slotId, authority]]), grant,
    streamingTransports: broker.streamingTransports });
  const request = () => new Request('http://pgc-harness.internal' + (creation ? '/v1/messages' : '/v1/chat/completions'), { method: 'POST',
    headers: { 'content-type': 'application/json', [HARNESS_MODEL_HEADERS.requestId]: requestId }, body: s.init.body });
  const scope = { taskId, generation, lease: active.lease, stage, stageDeadlineAt: grant.deadlineAt, requestIdPrefix, jsonOutput: !creation } as const;
  const handle = broker.bind(ledger, authority);
  expect((await handle(request(), { ...scope, lease: 'c'.repeat(64) })).status).toBe(401);
  updateStage.run(creation ? 'build:capture' : 'capture', taskId);
  expect((await handle(request(), scope)).status).toBe(401);
  updateStage.run(creation ? 'build:waiting' : 'review', taskId);
  expect(send).not.toHaveBeenCalled();
  const response = await handle(request(), scope);
  const key = 'pgc-harness-' + hash([taskId, generation, requestId].join('\n'));
  expect(response.status).toBe(status === 503 ? 502 : status);
  if (staleDuringReserve) {
    expect(await ledger.bindSlot(authority, slot.slotId).read(hash(key))).toMatchObject({ state: 'failed' });
    expect(harnessDb.prepare('SELECT attempts,state FROM harness_requests').get()).toEqual({ attempts: 1, state: 'failed' });
    expect((await handle(request(), scope)).status).toBe(401);
    expect(s.capacity()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(s.direct).not.toHaveBeenCalled();
    return;
  }
  if (status === 200) {
    expect(s.capacity()).toHaveLength(creation ? 1 : 0);
    expect(await response.text()).toBe(fixtureStream);
  } else expect(await response.text()).not.toContain(providerKey);
  expect(new Headers(send.mock.calls[0][1].headers).get('Idempotency-Key')).toBe(key);
  expect(new Headers(send.mock.calls[0][1].headers).get(creation ? 'x-api-key' : 'authorization')).toBe(creation ? providerKey : 'Bearer ' + providerKey);
  if (!creation) expect(JSON.parse(String(send.mock.calls[0][1].body))).toMatchObject({ response_format: { type: 'json_object' }, reasoning_effort: 'low' });
  const state = status === 200 ? 'completed' : status === 429 ? 'failed' : 'unknown';
  expect(await ledger.bindSlot(authority, slot.slotId).read(hash(key))).toMatchObject({ state });
  expect(harnessDb.prepare('SELECT attempts,state FROM harness_requests').get()).toEqual({ attempts: 1, state });
  expect(s.capacity()).toHaveLength(status === 503 ? 1 : 0);
  expect((await handle(request(), scope)).status).toBe(status === 200 ? 409 : 401);
  expect(send).toHaveBeenCalledTimes(1);
  expect(s.direct).not.toHaveBeenCalled();
});
