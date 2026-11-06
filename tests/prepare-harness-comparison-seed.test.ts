import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { comparisonMaterialParts, comparisonMaterialSeed, prepareComparisonSeed, readComparisonSeedUtf8 } from '../scripts/prepare-harness-comparison-seed';
import { comparisonAdmittedSlotsSha256, type ComparisonAdmittedSlot } from '../scripts/harness-comparison-ledger';
import { materialStoreFromLedger, type ComparisonDeployment } from '../server/harness-comparison-entry-config';
import { canonicalHarness, CCB_ENGINE_COMMIT } from '../server/harness-policy';
import type { Database } from '../server/storage';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const image = 'registry.cloudflare.com/' + 'a'.repeat(32) + '/synthetic@sha256:' + 'b'.repeat(64);
const material = { key: 'frozen/' + sha('汉字🙂'.repeat(22_000)), text: '汉字🙂'.repeat(22_000) };
async function fixture() {
  const manifestSha256 = sha('manifest'), version = '12345678-1234-1234-1234-123456789abc';
  const implementationCommit = 'c'.repeat(40);
  const cases = ['tap', 'drag', 'strategy', 'collision', 'restart', 'dense'].map(id => {
    const hashes = Object.fromEntries(['brief.md', 'sample.svg', 'assets.html'].map(name => [name, sha(id + name)]));
    return { id, materialSha256: sha(JSON.stringify(hashes, null, 2) + '\n'),
      materials: Object.entries(hashes).map(([name, sha256]) => ({ path: `materials/${id}/${name}`, sha256 })) };
  });
  const settings = { creationModel: { name: 'claude-opus-5-5', config: { path: 'inputs/opus.json', sha256: sha('opus') } },
    reviewModel: { name: 'deepseek-flash', config: { path: 'inputs/deepseek.json', sha256: sha('deepseek') } },
    rulesVersion: 'synthetic.rules', rules: { path: 'inputs/rules.json', sha256: sha(material.text) },
    calibration: { path: 'inputs/calibration.json', sha256: sha('calibration') },
    harnessCommit: implementationCommit, harnessImage: image };
  let index = 0;
  const planSlots = cases.flatMap(item => {
    const ids = Array.from({ length: 4 }, () => '00000000-0000-8000-8000-' + (++index).toString(16).padStart(12, '0'));
    return (['A', 'B'] as const).flatMap((arm, i) => [
      { caseId: item.id, arm, operation: 'creation' as const, taskId: ids[i], materialSha256: item.materialSha256,
        modelConfigSha256: settings.creationModel.config.sha256 },
      { caseId: item.id, arm, operation: 'review' as const, taskId: ids[2 + i], modelConfigSha256: settings.reviewModel.config.sha256,
        rulesSha256: settings.rules.sha256, calibrationSha256: settings.calibration.sha256,
        requires: { creationTaskId: ids[1], creationRecord: `records/creation.${item.id}.B.json`,
          reviewInputRecord: `records/review-input.${item.id}.json`, verification: 'required-at-execution',
          exactCompletedBlindSafeBHtml: true, originalOrderedBasicShots: 4 } },
    ]);
  });
  const planBytes = JSON.stringify({ schemaVersion: 1, scope: 'formal', executionAllowed: false, manifestSha256,
    materialIndexSha256: sha('index'), source: { A: { implementationCommit: baseline },
      B: { implementationCommit, engineCommit: CCB_ENGINE_COMMIT, image } },
    verification: {}, workflows: {}, settings, cases, slots: planSlots });
  const owner = 'comparison-' + sha(planBytes).slice(0, 24);
  const slots: ComparisonAdmittedSlot[] = planSlots.map((slot, i) => {
    const game = slot.operation === 'creation';
    const stages = game ? ['build', 'polish', 'repair', ...(slot.arm === 'B' ? ['repair2'] : [])] : ['review', 'review_verify'];
    return { slotId: 'slot-' + i, taskId: slot.taskId, caseId: slot.caseId, arm: slot.arm, operation: slot.operation,
      ownerId: game ? owner : 'admin', sourceSha256: 'materialSha256' in slot ? slot.materialSha256! : null, evidenceSha256: null,
      modelConfigSha256: slot.modelConfigSha256,
      stages: Object.fromEntries(stages.map(stage => [stage, { transportId: 'route-' + i, modelContractHash: sha(slot.operation),
        protocol: game ? 'anthropic' : 'openai', model: game ? 'claude-opus-5-5' : 'deepseek-flash',
        effort: game ? 'high' : 'low', stream: true, jsonMode: !game, maxOutputTokens: game ? 64_000 : 24_000 }])) };
  });
  const grant = { schemaVersion: 1, purpose: 'isolated-comparison', scope: 'formal', runId: 'synthetic-seed', ledgerDatabaseId: 'ledger',
    planSha256: sha(planBytes), manifestSha256, authorizationSha256: sha('test-only'),
    admittedSlotsSha256: await comparisonAdmittedSlotsSha256(slots), maxRequests: 1, maxOutputTokens: 64_000, notBefore: 1, deadlineAt: 2 } as const;
  const dispatchGrantSha256 = sha(canonicalHarness(['comparison-dispatch-grant-v1', grant]));
  const A = { implementationCommit: baseline, runtimeTreeSha256: sha('A-tree'), bundleSha256: sha('A-bundle'),
    workerVersion: version.replace(/c$/, 'd') };
  const B = { implementationCommit, runtimeTreeSha256: sha('B-tree'), bundleSha256: sha('B-bundle'),
    workerVersion: version.replace(/c$/, 'e'), image };
  const shared = { dispatchGrantSha256, authorizationSha256: grant.authorizationSha256, planSha256: grant.planSha256, manifestSha256,
    notBefore: grant.notBefore, deadlineAt: grant.deadlineAt };
  const runner = (arm: 'A' | 'B') => ({ ...shared, schemaVersion: 1 as const, purpose: grant.purpose, scope: grant.scope,
    runnerDatabaseId: arm, maxRequests: grant.maxRequests, maxOutputTokens: grant.maxOutputTokens,
    implementationCommit: arm === 'A' ? A.implementationCommit : B.implementationCommit,
    runtimeTreeSha256: arm === 'A' ? A.runtimeTreeSha256 : B.runtimeTreeSha256, image: arm === 'A' ? null : image });
  const runnerGrants = { A: runner('A'), B: runner('B') };
  const context = (arm: 'A' | 'B') => ({ ...shared, runId: grant.runId, candidateVersion: version, runnerDatabaseId: arm,
    nonceDatabaseId: 'ledger', runnerGrantSha256: sha(canonicalHarness(runnerGrants[arm])),
    taskIds: slots.filter(slot => slot.arm === arm).map(slot => slot.taskId) });
  return {
    schemaVersion: 1, grant, planBytes, slots, runnerGrants, databases: { A: 'A', B: 'B', ledger: 'ledger', nonce: 'ledger' },
    contexts: { A: context('A'), B: context('B') }, attestation: { authorizedCandidateVersion: version, executingCandidateVersion: version, A, B },
  } satisfies ComparisonDeployment;
}
function database(sqlite: DatabaseSync): Database {
  return { prepare(sql) {
    const statement = (values: SQLInputValue[]): ReturnType<Database['prepare']> => ({
      bind: (...values) => statement(values as SQLInputValue[]),
      async first<T>() { return (sqlite.prepare(sql).get(...values) ?? null) as T | null; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] }; },
      async run() { return sqlite.prepare(sql).run(...values); },
    });
    return statement([]);
  } };
}
type Statement = { sql: string; params: (string | number)[] };
function atomic(db: DatabaseSync, statements: Statement[]) {
  db.exec('BEGIN');
  try {
    for (const item of statements) db.prepare(item.sql).run(...item.params);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('offline seed starts disabled and only publishes a material after its bounded staged parts are complete', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const deployment = JSON.stringify(await fixture());
    const seed = await prepareComparisonSeed(deployment, [material]);
    expect(seed).toMatchObject({ schemaVersion: 2, enabled: false, providerRequests: 0, executionAllowed: false, deploymentSha256: sha(deployment) });
    atomic(db, seed.bootstrapStatements);
    expect(db.prepare('SELECT enabled,deployment_sha FROM comparison_service_grants').get()).toEqual({ enabled: 0, deployment_sha: sha(deployment) });
    expect(db.prepare('SELECT count(*) AS count FROM comparison_dispatch_attempts').get()).toEqual({ count: 0 });
    const store = materialStoreFromLedger(database(db)), staged = seed.materials[0];
    expect(staged.partCount).toBeGreaterThan(1);
    atomic(db, staged.stage.slice(0, 1));
    await expect(store.get(material.key)).resolves.toBeNull();
    expect(() => atomic(db, staged.publish)).toThrow();
    await expect(store.get(material.key)).resolves.toBeNull();
    atomic(db, staged.stage.slice(1));
    const readback = staged.readback.flatMap(query => db.prepare(query.sql).all(...query.params)) as { part: number; data: string }[];
    expect(readback.map(part => part.part)).toEqual(Array.from({ length: staged.partCount }, (_, i) => i));
    expect(sha(readback.map(part => part.data).join(''))).toBe(staged.sha256);
    atomic(db, staged.publish);
    expect(await (await store.get(material.key))!.text()).toBe(material.text);
    expect(db.prepare('SELECT count(*) AS count FROM comparison_material_seed_chunks').get()).toEqual({ count: 0 });
    expect(() => db.exec("UPDATE comparison_service_deployments SET deployment_json='{}'")).toThrow();
    expect(() => db.exec('DELETE FROM comparison_service_deployments')).toThrow();
    expect(() => db.prepare('INSERT OR REPLACE INTO comparison_service_deployments VALUES (?,?,?)')
      .run(seed.bootstrap.runId, sha('{}'), '{}')).toThrow();
    expect(db.prepare('SELECT deployment_json FROM comparison_service_deployments').get()).toEqual({ deployment_json: deployment });
  } finally { db.close(); }
});

test('rejects unknown config, route/runner/context drift and cross-database nonce before generating immutable SQL', async () => {
  const config = await fixture();
  await expect(prepareComparisonSeed('{"private-marker":invalid}')).rejects.toThrow(/^Invalid deployment JSON$/);
  const encoded = JSON.stringify(config);
  await expect(prepareComparisonSeed(encoded.replace('"schemaVersion":1', '"schemaVersion":"duplicate-private-marker","schemaVersion":1')))
    .rejects.toThrow(/^Invalid deployment encoding$/);
  const variants = [
    { ...config, unexpected: 'extra' },
    { ...config, databases: { ...config.databases, nonce: 'different' } },
    { ...config, grant: { ...config.grant, runId: 'changed' } },
    { ...config, attestation: { ...config.attestation, executingCandidateVersion: config.attestation.B.workerVersion } },
    { ...config, runnerGrants: { ...config.runnerGrants, A: { ...config.runnerGrants.A, deadlineAt: 3 } } },
    { ...config, contexts: { ...config.contexts, A: { ...config.contexts.A, runnerGrantSha256: sha('changed') } } },
    { ...config, contexts: { ...config.contexts, A: { ...config.contexts.A, nonceDatabaseId: 'different' } } },
    { ...config, contexts: { ...config.contexts, B: { ...config.contexts.B, manifestSha256: sha('other') } } },
    { ...config, contexts: { ...config.contexts, B: { ...config.contexts.B, taskIds: config.contexts.A.taskIds } } },
    { ...config, slots: config.slots.slice(1) },
  ];
  for (const value of variants) await expect(prepareComparisonSeed(JSON.stringify(value))).rejects.toThrow();
  const changedSlots = config.slots.map((slot, i) => i === 0 ? { ...slot, ownerId: 'another-owner' } : slot);
  await expect(prepareComparisonSeed(JSON.stringify({ ...config, slots: changedSlots, grant: { ...config.grant,
    admittedSlotsSha256: await comparisonAdmittedSlotsSha256(changedSlots) } }))).rejects.toThrow('exact formal roster');
  const unrelated = { key: 'frozen/' + sha('unregistered'), text: 'unregistered' };
  await expect(prepareComparisonSeed(JSON.stringify(config), [unrelated])).rejects.toThrow('outside the frozen deployment');
});

test('multibyte materials split on scalar boundaries and reject corrupt identities before generating SQL', () => {
  const text = '界🙂'.repeat(52_000), parts = comparisonMaterialParts(text);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.join('')).toBe(text);
  expect(parts.every(part => Buffer.byteLength(part) <= 96 * 1024 && Buffer.from(part).toString() === part)).toBe(true);
  expect(() => comparisonMaterialParts('bad\ud800')).toThrow();
  expect(() => comparisonMaterialSeed([{ key: 'frozen/' + sha('other'), text }])).toThrow();
  const material = { key: 'frozen/' + sha(text), text };
  expect(() => comparisonMaterialSeed([material, material])).toThrow();
  expect(() => comparisonMaterialSeed([{ key: '../' + sha(text), text }])).toThrow();
});

test('reads exact UTF-8 file contents and rejects undecodable or oversized input', async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'pgc-seed-utf8-')));
  try {
    const file = join(path, 'deployment.json'), valid = '{"value":"汉字🙂"}\n';
    await writeFile(file, valid);
    await expect(readComparisonSeedUtf8(file, Buffer.byteLength(valid))).resolves.toBe(valid);
    await expect(readComparisonSeedUtf8(file, Buffer.byteLength(valid) - 1)).rejects.toThrow('bounded');
    await writeFile(file, new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]));
    await expect(readComparisonSeedUtf8(file, 100)).rejects.toThrow('valid UTF-8');
  } finally { await rm(path, { recursive: true, force: true }); }
});
