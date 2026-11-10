import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  COMPARISON_ENTRY_LEDGER_SCHEMA, loadComparisonDeployment, materialStoreFromLedger, type ComparisonBootstrap, type ComparisonDeployment,
} from '../server/harness-comparison-entry-config';
import { harnessHash } from '../server/harness-policy';
import {
  COMPARISON_SERVICE_NONCE_SCHEMA, COMPARISON_SERVICE_ORIGIN, COMPARISON_SERVICE_PROFILE_PATH,
  createComparisonServiceClient, type ComparisonServiceContext,
} from '../server/harness-comparison-service';
import { inspectComparisonProfilePins, openComparisonAuthority, openComparisonBaselineAuthority, openComparisonCandidateRegistry } from '../server/harness-comparison-registry';
import type { Database } from '../server/storage';
import { fetchComparisonCandidate, type ComparisonCandidateEnvironment } from '../scripts/harness-comparison-candidate-entry';

vi.mock('../server/harness-comparison-registry', () => ({
  inspectComparisonProfilePins: vi.fn(), openComparisonAuthority: vi.fn(), openComparisonBaselineAuthority: vi.fn(),
  openComparisonCandidateRegistry: vi.fn(),
}));
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(protected ctx: unknown, protected env: unknown) {} },
}));
import authorityWorker, { ComparisonAuthority, ComparisonBaselineAuthority } from '../scripts/harness-comparison-authority-worker';

const version = '231f7591-370d-4f92-8356-87c346f430f6';
const otherVersion = version.replace(/^2/, '3');
const aTask = '111f7591-370d-8f92-8356-87c346f430f6';
const bTask = '121f7591-370d-8f92-8356-87c346f430f6';
const digest = (ch: string) => ch.repeat(64);
const key = digest('0');
const now = 1_800_000_000_000;
const sqlite: DatabaseSync[] = [];
let unexpectedFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  unexpectedFetch = vi.fn(() => { throw new Error('External fetch is forbidden in entry tests'); });
  vi.stubGlobal('fetch', unexpectedFetch);
});
afterEach(() => {
  expect(unexpectedFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const db of sqlite.splice(0)) db.close();
});

function database() {
  const sql = new DatabaseSync(':memory:');
  sqlite.push(sql);
  const execute = vi.fn((statement: string, type: 'first' | 'all' | 'run', values: SQLInputValue[]) => {
    const query = sql.prepare(statement);
    return type === 'first' ? query.get(...values) ?? null : type === 'all' ? query.all(...values) : query.run(...values);
  });
  const db: Database = { prepare(statement) {
    const wrapper = (values: SQLInputValue[]): ReturnType<Database['prepare']> => ({
      bind: (...params) => wrapper(params as SQLInputValue[]),
      async first<T>() { return execute(statement, 'first', values) as T | null; },
      async all<T>() { return { results: execute(statement, 'all', values) as T[] }; },
      async run() { return execute(statement, 'run', values); },
    });
    return wrapper([]);
  } };
  return { db, sql, execute };
}
function setup() {
  const A = database(), B = database(), ledger = database(), production = database();
  const databaseIds = { A: 'research-a', B: 'research-b', ledger: 'research-ledger', nonce: 'research-ledger' };
  const base = { runId: 'formal-run', authorizationSha256: digest('1'), dispatchGrantSha256: digest('2'),
    planSha256: digest('3'), manifestSha256: digest('4'), nonceDatabaseId: databaseIds.nonce,
    candidateVersion: version, notBefore: now - 60_000, deadlineAt: now + 600_000 };
  const AContext: ComparisonServiceContext = { ...base, runnerDatabaseId: databaseIds.A, runnerGrantSha256: digest('5'), taskIds: [aTask] };
  const BContext: ComparisonServiceContext = { ...base, runnerDatabaseId: databaseIds.B, runnerGrantSha256: digest('6'), taskIds: [bTask] };
  const runner = (runnerDatabaseId: string) => ({ runnerDatabaseId, dispatchGrantSha256: base.dispatchGrantSha256 });
  const deployment = {
    schemaVersion: 1, grant: { ...base, scope: 'formal', ledgerDatabaseId: databaseIds.ledger }, planBytes: 'synthetic',
    slots: [{ arm: 'A', taskId: aTask }, { arm: 'B', taskId: bTask }], runnerGrants: { A: runner(databaseIds.A), B: runner(databaseIds.B) },
    attestation: { authorizedCandidateVersion: version, executingCandidateVersion: version },
    databases: databaseIds, contexts: { A: AContext, B: BContext },
  } as unknown as ComparisonDeployment;
  const bootstrap: ComparisonBootstrap = { runId: base.runId, planSha256: base.planSha256, manifestSha256: base.manifestSha256,
    authorizationSha256: base.authorizationSha256, ledgerDatabaseId: databaseIds.ledger };
  const env: ComparisonCandidateEnvironment = {
    DB: production.db, SETTINGS_KEY: 'synthetic-settings',
    COMPARISON_BOOTSTRAP: JSON.stringify(bootstrap), COMPARISON_DATABASE_IDS: JSON.stringify({ ...databaseIds, production: 'production-db' }),
    COMPARISON_PROFILE_IDS: JSON.stringify({ creation: 'opus', review: 'deepseek' }),
    COMPARISON_SERVICE_AUTH_KEY: key, COMPARISON_CANDIDATE_VERSION: { id: version },
    COMPARISON_A_DB: A.db, COMPARISON_B_DB: B.db, COMPARISON_LEDGER_DB: ledger.db,
  };
  const authorityEnv = { ...env, COMPARISON_DATABASE_IDS: JSON.stringify(databaseIds) };
  for (const sql of [...COMPARISON_ENTRY_LEDGER_SCHEMA, COMPARISON_SERVICE_NONCE_SCHEMA]) ledger.sql.exec(sql);
  const deploymentJson = JSON.stringify(deployment);
  const deploymentSha = createHash('sha256').update(deploymentJson).digest('hex');
  ledger.sql.prepare('INSERT INTO comparison_service_deployments VALUES (?,?,?)').run(base.runId, deploymentSha, deploymentJson);
  ledger.sql.prepare('INSERT INTO comparison_service_grants VALUES (?,?,?,?,?,?,?,?,1)')
    .run(base.runId, base.dispatchGrantSha256, deploymentSha, base.authorizationSha256, base.planSha256, version, base.notBefore, base.deadlineAt);
  production.sql.exec("CREATE TABLE settings(id TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES ('model','null')");
  const profileScope = {
    taskId: bTask, slotSha256: digest('a'), admissionSha256: digest('b'), inputSha256: digest('c'), policySha256: digest('d'),
    grantSha256: BContext.runnerGrantSha256, authorizationSha256: BContext.authorizationSha256, dispatchGrantSha256: BContext.dispatchGrantSha256,
    planSha256: BContext.planSha256, manifestSha256: BContext.manifestSha256, runnerDatabaseId: BContext.runnerDatabaseId,
    ownerId: 'admin', operation: 'review' as const, sourceSha256: digest('e'), evidenceSha256: digest('f'),
    modelConfigSha256: digest('9'), modelContractHash: digest('8'), deadlineAt: BContext.deadlineAt,
  };
  const handle = vi.fn<Parameters<typeof import('../server/harness-comparison-service').createComparisonServiceHandler>[0]['handle']>(async call =>
    call.kind === 'profile' ? null : new Response('data: [DONE]\r\n\r\n', { headers: { 'content-type': 'text/event-stream' } }));
  vi.mocked(inspectComparisonProfilePins).mockImplementation(async options => {
    await options.loadConfig();
    return { creation: { profileId: 'opus', profileHash: digest('a') }, review: { profileId: 'deepseek', profileHash: digest('b') } };
  });
  vi.mocked(openComparisonCandidateRegistry).mockResolvedValue({
    context: BContext, baselineContext: AContext, authority: {} as never, baselineAuthority: {} as never, handle,
    nonceDatabase: { scope: 'isolated-comparison', id: databaseIds.nonce, connection: ledger.db },
  });
  const context = { waitUntil: vi.fn() };
  const fetcher = (request: Request) => fetchComparisonCandidate(request, env, context);
  const clientB = createComparisonServiceClient({ context: BContext, authKey: key, fetcher });
  const clientA = createComparisonServiceClient({ context: AContext, authKey: key, fetcher });
  return { env, authorityEnv, A, B, ledger, production, AContext, BContext, deployment, deploymentSha, bootstrap, profileScope, handle, clientA, clientB, context };
}
function baselineInit() {
  return {
    method: 'POST', redirect: 'manual' as const, signal: new AbortController().signal, body: '{"model":"deepseek-flash","stream":true}',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: 'Bearer pgc-comparison-local-placeholder',
      'idempotency-key': 'pgc-review-' + aTask + '-' + 'a'.repeat(24) },
  };
}
const baselineScope = { arm: 'A', taskId: aTask, ownerId: 'admin', operation: 'review', stage: 'review' } as const;

test('denies ordinary, unauthenticated, and wrong executing-version requests without touching any database or profile', async () => {
  const s = setup(), url = COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_PROFILE_PATH;
  expect((await fetchComparisonCandidate(new Request(COMPARISON_SERVICE_ORIGIN + '/login'), s.env)).status).toBe(403);
  expect((await fetchComparisonCandidate(new Request(url, { method: 'POST', body: 'private input' }), s.env)).status).toBe(403);
  const wrong = createComparisonServiceClient({ context: s.BContext, authKey: key,
    fetcher: request => fetchComparisonCandidate(request, { ...s.env, COMPARISON_CANDIDATE_VERSION: { id: otherVersion } }) });
  await expect(wrong.readVerifiedProfile(s.profileScope, version)).rejects.toThrow('Comparison service unavailable');
  for (const db of [s.A, s.B, s.ledger, s.production]) expect(db.execute).not.toHaveBeenCalled();
  expect(inspectComparisonProfilePins).not.toHaveBeenCalled();
  expect(openComparisonCandidateRegistry).not.toHaveBeenCalled();
});

test('valid-looking headers with the wrong HMAC or changed exact body do not reach nonce or configuration storage', async () => {
  const s = setup();
  const wrong = createComparisonServiceClient({ context: s.BContext, authKey: digest('f'),
    fetcher: request => fetchComparisonCandidate(request, s.env) });
  const altered = createComparisonServiceClient({ context: s.BContext, authKey: key,
    fetcher: request => fetchComparisonCandidate(new Request(request.url, { method: request.method, headers: request.headers, body: '{}' }), s.env) });
  await expect(wrong.readVerifiedProfile(s.profileScope, version)).rejects.toThrow('Comparison service unavailable');
  await expect(altered.readVerifiedProfile(s.profileScope, version)).rejects.toThrow('Comparison service unavailable');
  expect(s.ledger.execute.mock.calls.map(([sql]) => sql)).toHaveLength(2);
  expect(s.ledger.execute.mock.calls.every(([sql]) => sql.includes('FROM comparison_service_deployments'))).toBe(true);
  expect(s.production.execute).not.toHaveBeenCalled();
  expect(inspectComparisonProfilePins).not.toHaveBeenCalled();
});

test('selects the preconfigured arm by path, checks nonce first, and binds exact independent databases', async () => {
  const s = setup();
  await expect(s.clientB.readVerifiedProfile(s.profileScope, version)).resolves.toBeNull();
  const result = await s.clientA.forwardBaseline(baselineScope, 'https://api.deepseek.com/chat/completions', baselineInit(), version);
  expect(await result.text()).toBe('data: [DONE]\r\n\r\n');
  expect(s.ledger.execute.mock.calls[0][0]).toContain('FROM comparison_service_deployments');
  expect(s.ledger.execute.mock.calls[1][0]).toContain('INSERT INTO comparison_service_nonces');
  expect(s.production.execute).toHaveBeenCalledTimes(2);
  expect(s.handle.mock.calls.map(([call]) => call.kind)).toEqual(['profile', 'baseline']);
  const options = vi.mocked(openComparisonCandidateRegistry).mock.calls[0][0];
  expect(options.databases.A).toEqual({ id: 'research-a', connection: s.A.db });
  expect(options.databases.B).toEqual({ id: 'research-b', connection: s.B.db });
  expect(options.databases.ledger).toEqual({ id: 'research-ledger', connection: s.ledger.db });
  expect(options.databases.nonce).toEqual(options.databases.ledger);
  expect(options.databases.capacity).toEqual({ id: 'production-db', connection: s.production.db });
  expect(options.attestation.executingCandidateVersion).toBe(version);
  expect(options.waitUntil).toBeTypeOf('function');
  expect(vi.mocked(inspectComparisonProfilePins).mock.calls[0][0].profileIds).toEqual({ creation: 'opus', review: 'deepseek' });
});

test('A signing context cannot authenticate a B path even when the declared scope is adjusted', async () => {
  const s = setup();
  const cross = createComparisonServiceClient({ context: s.AContext, authKey: key, fetcher: request => fetchComparisonCandidate(request, s.env) });
  await expect(cross.readVerifiedProfile({ ...s.profileScope, taskId: aTask, runnerDatabaseId: s.AContext.runnerDatabaseId,
    grantSha256: s.AContext.runnerGrantSha256 }, version)).rejects.toThrow('Comparison service unavailable');
  expect(s.ledger.execute).toHaveBeenCalledOnce();
  expect(s.ledger.execute.mock.calls[0][0]).toContain('FROM comparison_service_deployments');
  expect(s.production.execute).not.toHaveBeenCalled();
  expect(openComparisonCandidateRegistry).not.toHaveBeenCalled();
});

test('current disabled or mismatched authorization stops both arms before any production config read', async () => {
  const s = setup();
  s.ledger.sql.exec('UPDATE comparison_service_grants SET enabled=0');
  await expect(s.clientB.readVerifiedProfile(s.profileScope, version)).rejects.toThrow('Comparison service unavailable');
  s.ledger.sql.prepare('UPDATE comparison_service_grants SET enabled=1,grant_sha=?').run(digest('9'));
  await expect(s.clientA.forwardBaseline(baselineScope, 'https://api.deepseek.com/chat/completions', baselineInit(), version))
    .rejects.toThrow('Comparison service unavailable');
  expect(s.ledger.sql.prepare('SELECT count(*) AS count FROM comparison_service_nonces').get()).toEqual({ count: 2 });
  expect(inspectComparisonProfilePins).not.toHaveBeenCalled();
  expect(s.production.execute).not.toHaveBeenCalled();
});

test('rejects database ID drift and production object aliases before the nonce write', async () => {
  const s = setup();
  for (const patch of [
    { DB: s.ledger.db },
    { COMPARISON_DATABASE_IDS: JSON.stringify({ ...s.deployment.databases, B: 'wrong-b', production: 'production-db' }) },
    { COMPARISON_DATABASE_IDS: JSON.stringify({ ...s.deployment.databases, production: s.deployment.databases.A }) },
    { COMPARISON_B_DB: s.A.db },
    { COMPARISON_NONCE_DB: s.B.db },
  ]) {
    const client = createComparisonServiceClient({ context: s.BContext, authKey: key,
      fetcher: request => fetchComparisonCandidate(request, { ...s.env, ...patch }) });
    await expect(client.readVerifiedProfile(s.profileScope, version)).rejects.toThrow('Comparison service unavailable');
  }
  expect(s.ledger.execute).toHaveBeenCalledOnce();
  expect(s.ledger.execute.mock.calls[0][0]).toContain('FROM comparison_service_deployments');
  expect(s.production.execute).not.toHaveBeenCalled();
});

test('bootstrap must select an existing immutable record matching exact anchors, actual version and payload hash', async () => {
  const s = setup();
  for (const patch of [{ runId: 'missing-run' }, { planSha256: digest('9') }, { manifestSha256: digest('9') },
    { authorizationSha256: digest('9') }, { ledgerDatabaseId: 'wrong-ledger' }]) {
    await expect(loadComparisonDeployment({ ...s.authorityEnv, COMPARISON_BOOTSTRAP: JSON.stringify({ ...s.bootstrap, ...patch }) }))
      .rejects.toThrow('Comparison deployment unavailable');
  }
  await expect(loadComparisonDeployment(s.env, { production: s.production.db, executingVersion: otherVersion }))
    .rejects.toThrow('Comparison deployment unavailable');
  const accepted = await loadComparisonDeployment(s.authorityEnv);
  expect(accepted.deploymentSha256).toBe(s.deploymentSha);
  expect(await accepted.shared.authorizeGrant(accepted.contexts.A)).toBe(true);
  s.ledger.sql.prepare('UPDATE comparison_service_grants SET deployment_sha=?').run(digest('9'));
  expect(await accepted.shared.authorizeGrant(accepted.contexts.A)).toBe(false);
  await expect(s.clientB.readVerifiedProfile(s.profileScope, version)).rejects.toThrow('Comparison service unavailable');
  expect(s.production.execute).not.toHaveBeenCalled();
  expect(inspectComparisonProfilePins).not.toHaveBeenCalled();
  for (const sql of [
    'UPDATE comparison_service_deployments SET deployment_json=deployment_json',
    'DELETE FROM comparison_service_deployments',
    'INSERT OR REPLACE INTO comparison_service_deployments SELECT * FROM comparison_service_deployments',
  ]) expect(() => s.ledger.sql.exec(sql)).toThrow('Immutable comparison deployment');
  // Simulate corruption outside the application/DDL gate.
  s.ledger.sql.exec("DROP TRIGGER comparison_deployment_no_update; UPDATE comparison_service_deployments SET deployment_json=deployment_json || ' '");
  await expect(loadComparisonDeployment(s.authorityEnv)).rejects.toThrow('Comparison deployment unavailable');
  expect(openComparisonAuthority).not.toHaveBeenCalled();
});

test('authority exposes only exact arm-scoped plain methods and never passes a production database or key', async () => {
  const s = setup();
  const actions = { authorizeRelease: vi.fn(async () => true), readTaskRuntime: vi.fn(async () => null),
    readFrozenInput: vi.fn(async () => 'frozen'), readEvidencePack: vi.fn(async () => 'sealed') };
  const verifyCompletedBArtifact = vi.fn(async () => true);
  vi.mocked(openComparisonAuthority).mockResolvedValue(actions);
  vi.mocked(openComparisonBaselineAuthority).mockResolvedValue({ ...actions, verifyCompletedBArtifact });
  const A = new ComparisonBaselineAuthority({}, s.authorityEnv), B = new ComparisonAuthority({}, s.authorityEnv);
  expect(authorityWorker.fetch().status).toBe(403);
  expect(B.fetch().status).toBe(403);
  expect(await B.readTaskRuntime(aTask)).toBeNull();
  expect(await A.readTaskRuntime(bTask)).toBeNull();
  await expect(B.readFrozenInput(bTask, 'https://unapproved.invalid/')).rejects.toThrow('Comparison authority unavailable');
  expect(openComparisonAuthority).not.toHaveBeenCalled();
  expect(openComparisonBaselineAuthority).not.toHaveBeenCalled();
  await expect(B.readFrozenInput(bTask, digest('a'))).resolves.toBe('frozen');
  expect(actions.readFrozenInput).toHaveBeenCalledWith(bTask, digest('a'));
  const evidence = { caseId: 'case', manifestSha256: digest('a'), evidenceSha256: digest('b'), packSha256: digest('c') };
  await expect(A.readEvidencePack(aTask, evidence)).resolves.toBe('sealed');
  await expect(A.verifyCompletedBArtifact({ taskId: bTask, ...evidence, planSha256: digest('d'), sourceSha256: digest('e') })).resolves.toBe(true);
  expect(verifyCompletedBArtifact).toHaveBeenCalledOnce();
  for (const options of [...vi.mocked(openComparisonAuthority).mock.calls, ...vi.mocked(openComparisonBaselineAuthority).mock.calls].map(call => call[0])) {
    expect(Object.keys(options).sort()).toEqual(['attestation', 'authorizeGrant', 'databases', 'grant', 'loadEvidencePack', 'loadFrozenInput',
      'planBytes', 'runnerGrants', 'slots']);
    expect(Object.values(options.databases).map(value => value.connection)).not.toContain(s.production.db);
  }
  expect(s.production.execute).not.toHaveBeenCalled();
});

test('fixed material store checks content-addressed names, UTF-8 size, contiguous parts and exact digest', async () => {
  const s = setup(), text = '合成 document 🧪', sha = await harnessHash(text), key = 'frozen/' + sha;
  s.ledger.sql.prepare('INSERT INTO comparison_material_blobs VALUES (?,?,?,?)').run(key, sha, Buffer.byteLength(text), 2);
  s.ledger.sql.prepare('INSERT INTO comparison_material_chunks VALUES (?,?,?),(?,?,?)').run(key, 0, '合成 ', key, 1, 'document 🧪');
  const { shared } = await loadComparisonDeployment(s.authorityEnv);
  await expect(shared.loadFrozenInput(sha)).resolves.toBe(text);
  await expect(materialStoreFromLedger(s.ledger.db).get('https://arbitrary.invalid')).rejects.toThrow('Comparison deployment unavailable');
  s.ledger.sql.prepare('INSERT INTO comparison_material_chunks VALUES (?,?,?)').run(key, 2, 'extra');
  await expect(shared.loadFrozenInput(sha)).rejects.toThrow('Comparison deployment unavailable');
  s.ledger.sql.prepare('DELETE FROM comparison_material_chunks WHERE part=2').run();
  s.ledger.sql.prepare("UPDATE comparison_material_chunks SET data='document 🧫' WHERE part=1").run();
  await expect(shared.loadFrozenInput(sha)).rejects.toThrow('Comparison deployment unavailable');
});

test('boots both bundles in local workerd and exposes only named private authority calls', async () => {
  const buildOptions = { bundle: true, format: 'esm' as const, platform: 'browser' as const, target: 'es2022',
    write: false as const, external: ['cloudflare:workers', 'node:*'] };
  const [candidate, authority] = await Promise.all([
    build({ ...buildOptions, stdin: { resolveDir: process.cwd(), contents:
      "import { fetchComparisonCandidate } from './scripts/harness-comparison-candidate-entry'; export default { fetch: fetchComparisonCandidate };" } }),
    build({ ...buildOptions, entryPoints: ['scripts/harness-comparison-authority-worker.ts'] }),
  ]);
  expect(candidate.outputFiles[0].text).toContain('fetchComparisonCandidate');
  const authoritySource = authority.outputFiles[0].text;
  expect(authoritySource).not.toContain('COMPARISON_SERVICE_AUTH_KEY');
  expect(authoritySource).not.toContain('synthetic-settings');
  expect(candidate.outputFiles[0].text).not.toContain('synthetic-settings');
  const manifest = (contents: string) => ({ mainModule: 'index.js', modules: { 'index.js': { type: 'esm' as const, contents } } });
  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: [
    { config: { name: 'caller', compatibilityDate: '2026-10-23', env: {
      A: { type: 'worker', worker: 'authority', exportName: 'ComparisonBaselineAuthority' },
      B: { type: 'worker', worker: 'authority', exportName: 'ComparisonAuthority' },
      CANDIDATE: { type: 'worker', worker: 'candidate' },
    }, manifest: manifest(`export default { async fetch(req,env) { return Response.json([
      await env.A.readTaskRuntime('invalid'), await env.B.readTaskRuntime('invalid'), await env.A.verifyCompletedBArtifact({}),
      (await env.CANDIDATE.fetch('https://pgc.ovoxin.top/login')).status,
    ]); } };`) } },
    { config: { name: 'authority', compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], manifest: manifest(authoritySource) } },
    { config: { name: 'candidate', compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
      manifest: manifest(candidate.outputFiles[0].text) } },
  ] });
  try {
    expect(await (await runtime.dispatchFetch('http://local.test')).json()).toEqual([null, null, false, 403]);
  } finally { await runtime.dispose(); }
}, 15_000);
