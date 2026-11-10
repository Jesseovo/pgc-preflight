/** Offline SQL parameters for isolated research storage. Never activates or sends a request. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalHarness, CCB_ENGINE_COMMIT } from '../server/harness-policy';
import {
  COMPARISON_ENTRY_LEDGER_SCHEMA, comparisonEntryExact, comparisonEntryHash, comparisonEntryTask, type ComparisonDeployment,
} from '../server/harness-comparison-entry-config';
import { COMPARISON_SERVICE_NONCE_SCHEMA } from '../server/harness-comparison-service';
import { isHarnessImage } from '../server/harness-protocol';
import type { planComparison } from './harness-comparison-coordinator';
import { COMPARISON_LEDGER_SCHEMA, comparisonAdmittedSlotsSha256 } from './harness-comparison-ledger';

type Statement = { sql: string; params: (string | number)[] };
type Material = { key: string; text: string };
type Plan = Awaited<ReturnType<typeof planComparison>>['plan'];
const sha = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex');
const maxPartBytes = 96 * 1024;
const maxDeploymentBytes = 1024 * 1024;
const maxMaterialsFile = 128 * 1024 * 1024;
const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const arms = ['A', 'B'] as const;
const versionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const materialKey = /^(frozen\/|evidence\/([a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/)([a-f0-9]{64})$/;
const stageTable = `CREATE TABLE IF NOT EXISTS comparison_material_seed_chunks (
  material_key TEXT NOT NULL, part INTEGER NOT NULL CHECK(typeof(part)='integer' AND part>=0),
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) BETWEEN 1 AND ${maxPartBytes}),
  PRIMARY KEY(material_key,part)
)`;
const shape = (value: unknown, keys: string[]) => comparisonEntryExact(value, keys);
const id = (value: unknown) => typeof value === 'string' && idPattern.test(value);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const same = (left: unknown, right: unknown) => canonicalHarness(left) === canonicalHarness(right);

function parse<T>(value: string, label: string, sealed = false): T {
  let parsed: T;
  try { parsed = JSON.parse(value) as T; } catch { throw new Error('Invalid ' + label + ' JSON'); }
  if (sealed) {
    // Sealed inputs use JSON.stringify encoding. Whitespace outside strings
    // is flexible, but duplicate keys cannot disappear from stored bytes.
    const compact = value.replace(/"(?:\\.|[^"\\])*"|[ \t\r\n]+/g, token => token.startsWith('"') ? token : '');
    assert(JSON.stringify(parsed) === compact, 'Invalid ' + label + ' encoding');
  }
  return parsed;
}

function ref(value: { path: string; sha256: string }) {
  return shape(value, ['path', 'sha256']) && typeof value.path === 'string' &&
    value.path.startsWith('inputs/') && !value.path.includes('\\') && value.path.split('/').every(part => part && part !== '..' && part !== '.') &&
    comparisonEntryHash(value.sha256);
}

async function checkedDeployment(deploymentJson: string) {
  assert(typeof deploymentJson === 'string' && Buffer.from(deploymentJson).toString('utf8') === deploymentJson &&
    Buffer.byteLength(deploymentJson) <= maxDeploymentBytes, 'Deployment exceeds bootstrap byte limit or has malformed UTF-8');
  const config = parse<ComparisonDeployment>(deploymentJson, 'deployment', true);
  assert(shape(config, ['schemaVersion', 'grant', 'slots', 'runnerGrants', 'planBytes', 'attestation', 'databases', 'contexts']) &&
    config.schemaVersion === 1 && shape(config.databases, ['A', 'B', 'ledger', 'nonce']) &&
    Object.values(config.databases).every(id) && new Set([config.databases.A, config.databases.B, config.databases.ledger]).size === 3 &&
    config.databases.nonce === config.databases.ledger && shape(config.runnerGrants, ['A', 'B']) && shape(config.contexts, ['A', 'B']),
  'Invalid deployment shape or database isolation; this seed requires nonce and ledger to be the same database');

  const { grant, attestation, planBytes, slots } = config;
  assert(shape(grant, ['schemaVersion', 'purpose', 'scope', 'runId', 'ledgerDatabaseId', 'planSha256', 'manifestSha256',
    'admittedSlotsSha256', 'authorizationSha256', 'maxRequests', 'maxOutputTokens', 'notBefore', 'deadlineAt']) &&
    grant.schemaVersion === 1 && grant.scope === 'formal' && grant.purpose === 'isolated-comparison' && id(grant.runId) &&
    grant.ledgerDatabaseId === config.databases.ledger &&
    [grant.planSha256, grant.manifestSha256, grant.admittedSlotsSha256, grant.authorizationSha256].every(comparisonEntryHash) &&
    [grant.maxRequests, grant.maxOutputTokens, grant.notBefore, grant.deadlineAt].every(positive) && grant.notBefore < grant.deadlineAt &&
    typeof planBytes === 'string' && Buffer.byteLength(planBytes) <= 512 * 1024 && sha(planBytes) === grant.planSha256 &&
    await comparisonAdmittedSlotsSha256(slots) === grant.admittedSlotsSha256, 'Invalid frozen dispatch grant, plan or admitted-slot digest');

  assert(shape(attestation, ['authorizedCandidateVersion', 'executingCandidateVersion', 'A', 'B']) &&
    shape(attestation.A, ['implementationCommit', 'runtimeTreeSha256', 'workerVersion', 'bundleSha256']) &&
    shape(attestation.B, ['implementationCommit', 'runtimeTreeSha256', 'workerVersion', 'bundleSha256', 'image']) &&
    attestation.authorizedCandidateVersion === attestation.executingCandidateVersion &&
    [attestation.executingCandidateVersion, attestation.A.workerVersion, attestation.B.workerVersion]
      .every(value => typeof value === 'string' && versionPattern.test(value)) &&
    new Set([attestation.executingCandidateVersion, attestation.A.workerVersion, attestation.B.workerVersion]).size === 3 &&
    [attestation.A.runtimeTreeSha256, attestation.B.runtimeTreeSha256, attestation.A.bundleSha256, attestation.B.bundleSha256].every(comparisonEntryHash) &&
    attestation.A.implementationCommit === baseline && typeof attestation.B.implementationCommit === 'string' &&
    commitPattern.test(attestation.B.implementationCommit) && isHarnessImage(attestation.B.image), 'Invalid Worker runtime or candidate attestation');

  const plan = parse<Plan>(planBytes, 'formal plan', true);
  assert(shape(plan, ['schemaVersion', 'scope', 'executionAllowed', 'manifestSha256', 'materialIndexSha256',
    'source', 'verification', 'workflows', 'settings', 'cases', 'slots']) &&
    plan.schemaVersion === 1 && plan.scope === 'formal' && plan.executionAllowed === false && plan.manifestSha256 === grant.manifestSha256 &&
    comparisonEntryHash(plan.materialIndexSha256) && same(plan.source, {
      A: { implementationCommit: baseline }, B: { implementationCommit: attestation.B.implementationCommit, engineCommit: CCB_ENGINE_COMMIT, image: attestation.B.image },
    }) && Array.isArray(plan.cases) && plan.cases.length === 6 && Array.isArray(plan.slots) && plan.slots.length === 24 &&
    slots.length === 24 && new Set(plan.slots.map(slot => slot.taskId)).size === 24 &&
    shape(plan.settings, ['creationModel', 'reviewModel', 'rulesVersion', 'rules', 'calibration', 'harnessCommit', 'harnessImage']) &&
    plan.settings.harnessCommit === attestation.B.implementationCommit && plan.settings.harnessImage === attestation.B.image &&
    typeof plan.settings.rulesVersion === 'string' && /^[a-z0-9][a-z0-9._-]{0,95}$/i.test(plan.settings.rulesVersion) && ref(plan.settings.rules) && ref(plan.settings.calibration) &&
    shape(plan.settings.creationModel, ['name', 'config']) && plan.settings.creationModel.name === 'claude-opus-5-5' &&
    shape(plan.settings.reviewModel, ['name', 'config']) && plan.settings.reviewModel.name === 'deepseek-flash' &&
    ref(plan.settings.creationModel.config) && ref(plan.settings.reviewModel.config), 'Invalid formal plan or source pins');

  const cases = new Map(plan.cases.map(item => [item.id, item]));
  const registeredMaterials = new Set([plan.settings.rules.sha256, plan.settings.calibration.sha256,
    plan.settings.creationModel.config.sha256, plan.settings.reviewModel.config.sha256]);
  assert(cases.size === 6, 'Repeated formal case identity');
  for (const item of plan.cases) {
    assert(shape(item, ['id', 'materialSha256', 'materials']) && id(item.id) && comparisonEntryHash(item.materialSha256) &&
      Array.isArray(item.materials) && item.materials.length === 3, 'Invalid formal case material lock');
    const materialHashes: Record<string, string> = {};
    for (const name of ['brief.md', 'sample.svg', 'assets.html']) {
      const material = item.materials.find(value => value.path === `materials/${item.id}/${name}`);
      assert(material && shape(material, ['path', 'sha256']) && comparisonEntryHash(material.sha256), 'Invalid formal material reference');
      materialHashes[name] = material.sha256;
      registeredMaterials.add(material.sha256);
    }
    assert(sha(JSON.stringify(materialHashes, null, 2) + '\n') === item.materialSha256, 'Formal case material digest differs');
  }

  const reviewed = new Set<string>();
  const transportOwners = new Map<string, string>();
  const contracts = new Map<ComparisonDeployment['slots'][number]['operation'], string>();
  for (const slot of slots) {
    const planned = plan.slots.find(item => item.taskId === slot.taskId);
    const item = cases.get(slot.caseId), game = slot.operation === 'creation';
    const expectedStages = game ? ['build', 'polish', 'repair', ...(slot.arm === 'B' ? ['repair2'] : [])] : ['review', 'review_verify'];
    assert(planned && item && comparisonEntryTask(slot.taskId) && planned.caseId === slot.caseId && planned.arm === slot.arm &&
      planned.operation === slot.operation && planned.modelConfigSha256 === slot.modelConfigSha256 &&
      slot.ownerId === (game ? 'comparison-' + grant.planSha256.slice(0, 24) : 'admin') &&
      slot.modelConfigSha256 === (game ? plan.settings.creationModel.config.sha256 : plan.settings.reviewModel.config.sha256) &&
      shape(slot.stages, expectedStages), 'Admitted slot conflicts with the exact formal roster');
    if (game) {
      assert(shape(planned, ['caseId', 'arm', 'operation', 'taskId', 'materialSha256', 'modelConfigSha256']) &&
        'materialSha256' in planned && planned.materialSha256 === item.materialSha256 && slot.sourceSha256 === item.materialSha256 &&
        slot.evidenceSha256 === null, 'Creation slot material lock differs');
    } else {
      const creation = slots.find(value => value.caseId === slot.caseId && value.arm === 'B' && value.operation === 'creation');
      assert(creation && shape(planned, ['caseId', 'arm', 'operation', 'taskId', 'modelConfigSha256', 'rulesSha256', 'calibrationSha256', 'requires']) &&
        'requires' in planned && planned.rulesSha256 === plan.settings.rules.sha256 && planned.calibrationSha256 === plan.settings.calibration.sha256 &&
        same(planned.requires, { creationTaskId: creation.taskId, creationRecord: `records/creation.${slot.caseId}.B.json`,
          reviewInputRecord: `records/review-input.${slot.caseId}.json`, verification: 'required-at-execution',
          exactCompletedBlindSafeBHtml: true, originalOrderedBasicShots: 4 }), 'Review slot is not bound to exact B creation and rules');
      reviewed.add(slot.taskId);
    }
    for (const route of Object.values(slot.stages)) {
      assert((!transportOwners.has(route.transportId) || transportOwners.get(route.transportId) === slot.taskId) &&
        route.protocol === (game ? 'anthropic' : 'openai') && route.model === (game ? 'claude-opus-5-5' : 'deepseek-flash') &&
        route.effort === (game ? 'high' : 'low') && route.stream && route.jsonMode === !game &&
        route.maxOutputTokens === (game ? 64_000 : 24_000) &&
        (!contracts.has(slot.operation) || contracts.get(slot.operation) === route.modelContractHash),
      'Admitted model route is not the formal native contract');
      transportOwners.set(route.transportId, slot.taskId);
      contracts.set(slot.operation, route.modelContractHash);
    }
  }

  const grantSha = sha(canonicalHarness(['comparison-dispatch-grant-v1', grant]));
  const shared = { authorizationSha256: grant.authorizationSha256, dispatchGrantSha256: grantSha, planSha256: grant.planSha256,
    manifestSha256: grant.manifestSha256, notBefore: grant.notBefore, deadlineAt: grant.deadlineAt };
  for (const arm of arms) {
    const runner = config.runnerGrants[arm], runtime = attestation[arm], context = config.contexts[arm];
    assert(same(runner, { ...shared, schemaVersion: 1, purpose: grant.purpose, scope: 'formal', runnerDatabaseId: config.databases[arm],
      maxRequests: grant.maxRequests, maxOutputTokens: grant.maxOutputTokens, implementationCommit: runtime.implementationCommit,
      runtimeTreeSha256: runtime.runtimeTreeSha256, image: arm === 'A' ? null : attestation.B.image }), 'Runner grant differs from the frozen grant and runtime');
    assert(context && Array.isArray(context.taskIds) && same({ ...context, taskIds: [...context.taskIds].sort() }, {
      ...shared, runId: grant.runId, runnerGrantSha256: sha(canonicalHarness(runner)), runnerDatabaseId: config.databases[arm],
      nonceDatabaseId: config.databases.ledger, candidateVersion: attestation.executingCandidateVersion,
      taskIds: slots.filter(slot => slot.arm === arm).map(slot => slot.taskId).sort(),
    }), 'Signed service context differs from the frozen grant and task roster');
  }
  return { config, grantSha, registeredMaterials, reviewed };
}

/** Slice on Unicode scalar boundaries; a JS character count is not a D1 byte budget. */
export function comparisonMaterialParts(text: string) {
  assert(typeof text === 'string' && text.length > 0 && Buffer.from(text).toString('utf8') === text, 'Material must be nonempty well-formed UTF-8');
  const parts: string[] = [];
  let part: string[] = [], bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > maxPartBytes) { parts.push(part.join('')); part = []; bytes = 0; }
    part.push(point); bytes += size;
  }
  if (part.length) parts.push(part.join(''));
  return parts;
}

export function comparisonMaterialSeed(materials: readonly Material[]) {
  assert(Array.isArray(materials), 'Materials must be an array');
  const seen = new Set<string>();
  return materials.map(material => {
    assert(shape(material, ['key', 'text']) && typeof material.key === 'string' && typeof material.text === 'string', 'Invalid material shape');
    const { key, text } = material;
    const match = materialKey.exec(key);
    assert(match && !seen.has(key) && sha(text) === match[3], 'Material key/hash must be unique and exact');
    seen.add(key);
    const byteLength = Buffer.byteLength(text);
    assert(byteLength <= (match[1] === 'frozen/' ? 512 * 1024 : 64 * 1024 * 1024), 'Material exceeds its limit');
    const parts = comparisonMaterialParts(text), partCount = parts.length, sha256 = match[3];
    const stage: Statement[] = parts.map((part, index) => ({
      sql: 'INSERT INTO comparison_material_seed_chunks(material_key,part,data) VALUES (?,?,?)', params: [key, index, part],
    }));
    const readback: Statement[] = [];
    for (let start = 0; start < partCount; start += 16) {
      readback.push({ sql: 'SELECT part,data FROM comparison_material_seed_chunks WHERE material_key=? AND part>=? AND part<? ORDER BY part',
        params: [key, start, Math.min(partCount, start + 16)] });
    }
    // The published chunk table has a parent foreign key. Publish metadata
    // and verified staged chunks in one transaction after staging completes.
    const publish: Statement[] = [
      { sql: `INSERT INTO comparison_material_blobs(material_key,sha256,byte_length,part_count)
        VALUES (?,?,CASE WHEN (SELECT count(*)=? AND min(part)=0 AND max(part)=? AND sum(length(CAST(data AS BLOB)))=?
          FROM comparison_material_seed_chunks WHERE material_key=?) THEN ? END,?)`,
        params: [key, sha256, partCount, partCount - 1, byteLength, key, byteLength, partCount] },
      { sql: `INSERT INTO comparison_material_chunks(material_key,part,data)
        SELECT material_key,part,data FROM comparison_material_seed_chunks WHERE material_key=? ORDER BY part`, params: [key] },
      { sql: 'DELETE FROM comparison_material_seed_chunks WHERE material_key=?', params: [key] },
    ];
    return { key, sha256, byteLength, partCount, stage, readback, publish };
  });
}

export async function prepareComparisonSeed(deploymentJson: string, materials: readonly Material[] = []) {
  const { config, grantSha, registeredMaterials, reviewed } = await checkedDeployment(deploymentJson);
  const { grant } = config, digest = sha(deploymentJson);
  const materialPlans = comparisonMaterialSeed(materials);
  for (const { key, sha256 } of materialPlans) {
    const match = materialKey.exec(key)!;
    assert(match[2] ? reviewed.has(match[2]) : registeredMaterials.has(sha256), 'Material is outside the frozen deployment');
  }
  const bootstrap = { runId: grant.runId, planSha256: grant.planSha256, manifestSha256: grant.manifestSha256,
    authorizationSha256: grant.authorizationSha256, ledgerDatabaseId: grant.ledgerDatabaseId };
  const bootstrapStatements: Statement[] = [
    ...[...COMPARISON_ENTRY_LEDGER_SCHEMA, COMPARISON_SERVICE_NONCE_SCHEMA, ...COMPARISON_LEDGER_SCHEMA, stageTable].map(sql => ({ sql, params: [] })),
    { sql: 'INSERT INTO comparison_service_deployments(run_id,deployment_sha,deployment_json) VALUES (?,?,?)',
      params: [grant.runId, digest, deploymentJson] },
    { sql: `INSERT INTO comparison_service_grants
      (run_id,grant_sha,deployment_sha,authorization_sha,plan_sha,candidate_version,not_before,deadline_at,enabled)
      VALUES (?,?,?,?,?,?,?,?,0)`, params: [grant.runId, grantSha, digest, grant.authorizationSha256, grant.planSha256,
        config.attestation.authorizedCandidateVersion, grant.notBefore, grant.deadlineAt] },
  ];
  return { schemaVersion: 2, kind: 'disabled-comparison-storage-seed', bootstrap, deploymentSha256: digest,
    databaseId: grant.ledgerDatabaseId, bootstrapStatements, materials: materialPlans, enabled: false, providerRequests: 0, executionAllowed: false,
    notes: ['Apply only to the independently verified isolated ledger database.',
      'Apply bootstrapStatements atomically. Existing deployment rows cannot be replaced.',
      'Stage each material in bounded batches. Read back all ordered parts and verify their count, UTF-8 byte length and SHA-256 before publishing.',
      'Apply each material publish list atomically, then independently verify the published digest before using it.',
      'This file is storage input. No authorization, attestation or activation statement is included.'] };
}

export async function readComparisonSeedUtf8(path: string, limit: number) {
  const file = resolve(path);
  const stats = await stat(file);
  assert(stats.isFile() && await realpath(file) === file && stats.size <= limit, 'Seed input must be a bounded regular file');
  const bytes = await readFile(file);
  assert(bytes.byteLength <= limit, 'Seed input exceeds its byte limit');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('Seed input must be valid UTF-8'); }
}

async function main() {
  const { values } = parseArgs({ options: { deployment: { type: 'string' }, materials: { type: 'string' }, out: { type: 'string' } } });
  assert(values.deployment && values.out, 'Use --deployment PRIVATE_JSON [--materials PRIVATE_JSON] --out NEW_PRIVATE_JSON');
  const out = resolve(values.out), parent = dirname(out);
  assert.equal(await realpath(parent), parent);
  assert.equal((await stat(parent)).mode & 0o077, 0, 'Output parent must be private');
  const deployment = await readComparisonSeedUtf8(values.deployment, maxDeploymentBytes);
  const materials = values.materials ? parse<Material[]>(await readComparisonSeedUtf8(values.materials, maxMaterialsFile), 'materials') : [];
  const seed = await prepareComparisonSeed(deployment, materials);
  await writeFile(out, JSON.stringify(seed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ output: out, bootstrapStatements: seed.bootstrapStatements.length,
    materials: seed.materials.length, enabled: false, providerRequests: 0 }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('Comparison seed preparation failed\n');
    process.exitCode = 1;
  });
}
