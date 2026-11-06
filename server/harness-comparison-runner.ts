/** Private B comparison release/alarm barrier. No route, scheduler, or provider transport. */
import { prepareReview } from './forge-api';
import { openComparisonEvidencePack, type ComparisonEvidenceIdentity } from './harness-comparison-evidence';
import { canonicalHarness, CCB_ENGINE_COMMIT, harnessHash, modelContractHash, parseHarnessPolicy, type HarnessBinding } from './harness-policy';
import { isHarnessImage } from './harness-protocol';
import { parseReviewRulesSnapshot } from './review-rules';
import { activeModelProfile, type ModelConfig, type StoredModelProfile } from './settings';

type SQLValue = string | number | null;
type Statement = {
  bind(...values: SQLValue[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};
type Database = { prepare(sql: string): Statement };
type Operation = 'creation' | 'review';
type TaskState = { storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> } };
type PrivateRunnerEnvironment = {
  DB: Database;
  SETTINGS_KEY: '';
  HARNESS_RUNNER: HarnessBinding;
  modelStore: { get(): Promise<ModelConfig> };
  captureReview(html: string, progress?: (message: string) => Promise<void>, deadlineAt?: number): unknown;
};
type Alarm = (state: TaskState, env: PrivateRunnerEnvironment, taskId: string) => Promise<unknown>;
type RuntimePin = { implementationCommit: string; runtimeTreeSha256: string; image: string };
export type ComparisonRunnerGrant = RuntimePin & {
  schemaVersion: 1;
  purpose: 'isolated-comparison';
  scope: 'formal';
  authorizationSha256: string;
  /** Digest of the independently authorized shared A/B dispatch grant. */
  dispatchGrantSha256: string;
  planSha256: string;
  manifestSha256: string;
  runnerDatabaseId: string;
  maxRequests: number;
  maxOutputTokens: number;
  notBefore: number;
  deadlineAt: number;
};
export type ComparisonReleaseSeal = {
  taskId: string;
  slotSha256: string;
  admissionSha256: string;
  inputSha256: string;
  policySha256: string;
};
type BrokerScope = ComparisonReleaseSeal & {
  grantSha256: string;
  authorizationSha256: string;
  dispatchGrantSha256: string;
  planSha256: string;
  manifestSha256: string;
  runnerDatabaseId: string;
  ownerId: string;
  operation: Operation;
  sourceSha256: string;
  evidenceSha256: string | null;
  modelConfigSha256: string;
  modelContractHash: string;
  deadlineAt: number;
};
type BrokerBinding = {
  scopeSha256: string;
  harnessRunner: HarnessBinding;
  profileId: string;
  // Opaque production ciphertext may stay in trusted server checkpoints. The
  // actual Key and SETTINGS_KEY never enter this task environment or a receipt.
  profile: StoredModelProfile;
};
type Slot = {
  caseId: string; arm: 'A' | 'B'; operation: Operation; taskId: string; modelConfigSha256: string;
  materialSha256?: string; rulesSha256?: string; calibrationSha256?: string; requires?: { creationTaskId: string };
};
type Plan = {
  schemaVersion: 1; scope: 'formal'; executionAllowed: false; manifestSha256: string;
  source: { B: { implementationCommit: string; engineCommit: string; image: string } };
  slots: Slot[];
  cases: { id: string; materialSha256: string; materials: { path: string; sha256: string }[] }[];
};
type Admission = { identity_sha: string; identity_json: string; state: string; input_sha: string; policy_sha: string };
type Identity = {
  schemaVersion: 1; scope: 'formal'; planSha256: string; manifestSha256: string; slot: Slot; ownerId: string;
  sourceHash: string; evidenceHash: string | null; packHash: string | null; modelContractHash: string; harnessPolicy: unknown;
};
type TaskRow = {
  id: string; owner_id: string; status: string; executor: string; harness_policy: string | null;
  kind?: string; scope?: string; creative_version?: number; input_snapshot?: string; payload?: string;
  model_executor?: string; input_ready?: number; input_hash?: string; rules_snapshot?: string; report_schema_version?: number;
  review_mode?: string; title?: string; filename?: string; topic_id?: number | null;
  model_started_at?: string | null; model_execution_started_at?: string | null;
};
type StoredRelease = {
  grant_sha: string; slot_sha: string; admission_sha: string; input_sha: string; policy_sha: string;
  profile_sha: string; release_sha: string; released_at: number;
};

const releaseTable = `CREATE TABLE IF NOT EXISTS comparison_execution_releases (
  task_id TEXT PRIMARY KEY REFERENCES comparison_admissions(task_id),
  grant_sha TEXT NOT NULL, slot_sha TEXT NOT NULL, admission_sha TEXT NOT NULL, input_sha TEXT NOT NULL,
  policy_sha TEXT NOT NULL, profile_sha TEXT NOT NULL, release_sha TEXT NOT NULL, released_at INTEGER NOT NULL
)`;
const digest = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const taskIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const profiles = ['name', 'baseUrl', 'model', 'protocol', 'enabled', 'vision', 'effort', 'maxOutputTokens', 'updatedAt'];
const materialFields = [['brief.md', 'brief_md'], ['sample.svg', 'preview_svg'], ['assets.html', 'assets_html']] as const;
const phaseKey = 'comparison-release';
const isHash = (value: unknown): value is string => typeof value === 'string' && digest.test(value);
const hashValue = (value: unknown) => harnessHash(canonicalHarness(value));
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const same = (left: unknown, right: unknown) => canonicalHarness(left) === canonicalHarness(right);

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function exact(value: object, names: string[]) {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function parseJson<T = any>(text: string, label: string): T {
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`Invalid comparison ${label}`); }
}

async function readCheckpoint(storage: TaskState['storage'], key: string, countKey = key + 'Parts') {
  const count = await storage.get<number>(countKey);
  requireThat(positive(count) && count <= 2_200, 'Comparison runner checkpoint is missing or unbounded');
  const parts: string[] = [];
  for (let index = 0; index < count; index++) {
    const part = await storage.get<string>(`${key}:${index}`);
    requireThat(typeof part === 'string', 'Comparison runner checkpoint is incomplete');
    parts.push(part);
  }
  return parseJson(parts.join(''), 'runner checkpoint');
}

/**
 * Construct only inside the private B control plane. The object authority and
 * broker callback are supplied by trusted host code, never decoded from a request.
 */
export async function openComparisonTaskControl(options: {
  authority: object;
  database: { scope: 'isolated-comparison'; id: string; connection: Database };
  grant: ComparisonRunnerGrant;
  runtime: RuntimePin;
  planBytes: string;
  loadFrozenInput: (sha256: string) => Promise<string>;
  loadEvidencePack?: (identity: ComparisonEvidenceIdentity) => Promise<string>;
  bindVerifiedBroker?: (scope: Readonly<BrokerScope>) => Promise<BrokerBinding | null>;
  failedHarnessRunner?: HarnessBinding;
  alarms: { creation: Alarm; review: Alarm };
  captureCreation?: PrivateRunnerEnvironment['captureReview'];
  now?: () => number;
}) {
  const { authority, database, now = Date.now, loadEvidencePack, loadFrozenInput, bindVerifiedBroker, failedHarnessRunner, captureCreation } = options;
  requireThat(authority && typeof authority === 'object', 'Comparison control authority is required');
  const grant = { ...options.grant };
  const runtime = { ...options.runtime };
  const alarms = { ...options.alarms };
  requireThat(exact(grant, ['schemaVersion', 'purpose', 'scope', 'authorizationSha256', 'dispatchGrantSha256', 'planSha256', 'manifestSha256',
    'runnerDatabaseId', 'maxRequests', 'maxOutputTokens', 'notBefore', 'deadlineAt', 'implementationCommit', 'runtimeTreeSha256', 'image']) &&
    grant.schemaVersion === 1 && grant.scope === 'formal' && grant.purpose === 'isolated-comparison' &&
    [grant.authorizationSha256, grant.dispatchGrantSha256, grant.planSha256, grant.manifestSha256, grant.runtimeTreeSha256].every(isHash) &&
    commit.test(grant.implementationCommit) && isHarnessImage(grant.image) && positive(grant.maxRequests) && positive(grant.maxOutputTokens) &&
    positive(grant.notBefore) && positive(grant.deadlineAt) && grant.notBefore < grant.deadlineAt,
  'An explicit formal comparison grant with aggregate caps is required');
  requireThat(database.scope === 'isolated-comparison' && id.test(database.id) && database.id === grant.runnerDatabaseId,
    'An independently bound isolated B database is required');
  requireThat(runtime.implementationCommit === grant.implementationCommit && runtime.runtimeTreeSha256 === grant.runtimeTreeSha256 &&
    runtime.image === grant.image, 'Comparison runtime attestation does not match the grant');
  requireThat(typeof options.planBytes === 'string' && options.planBytes.length <= 512 * 1024 &&
    await harnessHash(options.planBytes) === grant.planSha256, 'Frozen comparison plan digest mismatch');
  const plan = parseJson<Plan>(options.planBytes, 'plan');
  requireThat(plan.schemaVersion === 1 && plan.scope === 'formal' && plan.executionAllowed === false &&
    plan.manifestSha256 === grant.manifestSha256 && plan.source?.B?.implementationCommit === grant.implementationCommit &&
    plan.source.B.image === grant.image && plan.source.B.engineCommit === CCB_ENGINE_COMMIT &&
    Array.isArray(plan.slots) && plan.slots.length === 24 && new Set(plan.slots.map(slot => slot.taskId)).size === 24 &&
    Array.isArray(plan.cases) && plan.cases.length === 6, 'Frozen plan does not describe the approved B comparison');
  const db = database.connection;
  const grantSha256 = await hashValue(grant);
  const owner = `comparison-${grant.planSha256.slice(0, 24)}`;
  requireThat(new Set(plan.cases.map(value => value.id)).size === 6 &&
    plan.slots.every(slot => taskIdentifier.test(slot.taskId) && plan.cases.some(item => item.id === slot.caseId) &&
      (slot.arm === 'A' || slot.arm === 'B') && (slot.operation === 'creation' || slot.operation === 'review')) &&
    new Set(plan.slots.map(slot => `${slot.caseId}/${slot.arm}/${slot.operation}`)).size === 24,
  'Frozen comparison does not contain exactly one slot per case, arm and operation');
  const activeTasks = new Set<string>();
  const storageOwners = new WeakMap<object, string>();

  function trusted(value: object) {
    requireThat(value === authority, 'Comparison control authority mismatch');
    requireThat(now() >= grant.notBefore && now() < grant.deadlineAt, 'Comparison grant is outside its execution window');
  }
  async function isolated() {
    const binding = await db.prepare('SELECT plan_sha,arm,implementation FROM comparison_arm WHERE id=1')
      .first<{ plan_sha: string; arm: string; implementation: string }>();
    requireThat(binding?.arm === 'B' && binding.plan_sha === grant.planSha256 && binding.implementation === grant.implementationCommit &&
      !await db.prepare('SELECT 1 FROM settings LIMIT 1').first(), 'Comparison database marker conflicts with the isolated B plan');
  }
  function approvedSlot(taskId: string) {
    const slot = plan.slots.find(value => value.taskId === taskId);
    requireThat(taskIdentifier.test(taskId) && slot?.arm === 'B' && (slot.operation === 'creation' || slot.operation === 'review') &&
      isHash(slot.modelConfigSha256) && typeof slot.caseId === 'string', 'Task is not a frozen B comparison slot');
    return slot;
  }
  async function readRelease(taskId: string) {
    if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comparison_execution_releases'").first()) return null;
    return db.prepare('SELECT * FROM comparison_execution_releases WHERE task_id=?').bind(taskId).first<StoredRelease>();
  }

  async function load(seal: ComparisonReleaseSeal, allowTerminal: boolean) {
    const slot = approvedSlot(seal.taskId);
    requireThat(exact(seal, ['taskId', 'slotSha256', 'admissionSha256', 'inputSha256', 'policySha256']) &&
      [seal.slotSha256, seal.admissionSha256, seal.inputSha256, seal.policySha256].every(isHash) &&
      await hashValue(slot) === seal.slotSha256, 'Comparison slot seal mismatch');
    await isolated();
    const admitted = await db.prepare('SELECT * FROM comparison_admissions WHERE task_id=?').bind(seal.taskId).first<Admission>();
    requireThat(admitted?.state === 'paused' && admitted.identity_sha === seal.admissionSha256 &&
      admitted.input_sha === seal.inputSha256 && admitted.policy_sha === seal.policySha256 &&
      await harnessHash(admitted.identity_json) === seal.admissionSha256 &&
      await db.prepare('SELECT 1 FROM comparison_schedule_requests WHERE task_id=?').bind(seal.taskId).first(),
    'Missing or changed paused comparison admission');
    const identity = parseJson<Identity>(admitted.identity_json, 'admission');
    const creation = slot.operation === 'creation';
    const taskOwner = creation ? owner : 'admin';
    requireThat(identity.schemaVersion === 1 && identity.scope === 'formal' && identity.planSha256 === grant.planSha256 &&
      identity.manifestSha256 === grant.manifestSha256 && identity.ownerId === taskOwner && same(identity.slot, slot) &&
      isHash(identity.sourceHash) && isHash(identity.modelContractHash), 'Comparison admission identity mismatch');
    const table = creation ? 'forge_tasks' : 'review_jobs';
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(seal.taskId).first<TaskRow>();
    requireThat(row?.id === seal.taskId && row.owner_id === taskOwner && row.executor === (creation ? 'platform' : 'cloud') &&
      (creation ? row.kind === 'game' && row.creative_version === 2 : row.model_executor === 'platform' &&
        row.review_mode === 'basic' && row.report_schema_version === 2 && row.title === slot.caseId &&
        row.filename === `${slot.caseId}.html` && row.topic_id === null), 'Comparison task owner, executor or identity mismatch');
    const policy = parseHarnessPolicy(row.harness_policy);
    requireThat(policy && policy.family === (creation ? 'forge' : 'review') && policy.purpose === (creation ? 'game' : 'review') &&
      policy.image === grant.image && policy.releaseHash === grant.planSha256 && policy.modelContractHash === identity.modelContractHash &&
      same(policy, identity.harnessPolicy) && await hashValue(policy) === seal.policySha256,
    'Comparison task research policy mismatch');
    if (allowTerminal && (row.status === 'done' || row.status === 'error')) return { row, slot, identity };
    requireThat(row.status === 'queued' || (allowTerminal && row.status === 'running'), 'Comparison task cannot be released or resumed');

    if (creation) {
      requireThat(identity.sourceHash === slot.materialSha256 && identity.evidenceHash === null && identity.packHash === null &&
        typeof captureCreation === 'function' && typeof row.input_snapshot === 'string' && typeof row.payload === 'string',
      'Comparison creation source or capture is unavailable');
      const snapshot = parseJson(row.input_snapshot, 'creation snapshot');
      const topic = snapshot.topic;
      const registered = plan.cases.find(item => item.id === slot.caseId);
      requireThat(topic?.owner_id === taskOwner && topic.subject === slot.caseId && Number.isSafeInteger(topic.id) &&
        row.scope === `${taskOwner}:game:${topic.id}` && same(parseJson(row.payload, 'creation payload'),
          { type: 'game', id: topic.id, requestId: row.id, creative_version: 2 }) &&
        registered?.materialSha256 === slot.materialSha256 && await hashValue(snapshot) === seal.inputSha256,
      'Comparison creation snapshot drifted');
      for (const [name, field] of materialFields) {
        const ref = registered.materials.find(value => value.path === `materials/${slot.caseId}/${name}`);
        requireThat(ref && isHash(ref.sha256) && typeof topic[field] === 'string' &&
          await harnessHash(topic[field]) === ref.sha256, 'Comparison creation material drifted');
      }
      requireThat(await db.prepare('SELECT 1 FROM members WHERE id=? AND enabled=1 AND star=1').bind(taskOwner).first(),
        'Comparison Star owner is disabled or unavailable');
      return { row, slot, identity, capture: captureCreation };
    }

    requireThat(row.input_ready === 1 && row.input_hash === identity.sourceHash && typeof row.rules_snapshot === 'string' &&
      isHash(identity.evidenceHash) && isHash(identity.packHash) && isHash(slot.rulesSha256) && isHash(slot.calibrationSha256) && loadEvidencePack,
    'Comparison review input or sealed evidence is unavailable');
    const dependency = approvedSlot(slot.requires?.creationTaskId ?? '');
    requireThat(dependency.operation === 'creation' && dependency.caseId === slot.caseId, 'Review does not depend on the exact B creation slot');
    const creationRelease = await readRelease(dependency.taskId);
    requireThat(creationRelease?.grant_sha === grantSha256 && creationRelease.slot_sha === await hashValue(dependency) &&
      creationRelease.release_sha === await hashValue({ grantSha256, taskId: dependency.taskId, slotSha256: creationRelease.slot_sha,
        admissionSha256: creationRelease.admission_sha, inputSha256: creationRelease.input_sha, policySha256: creationRelease.policy_sha }),
    'Comparison review requires the released B creation identity');
    const product = await db.prepare("SELECT result FROM forge_tasks WHERE id=? AND owner_id=? AND executor='platform' AND kind='game' AND status='done'")
      .bind(dependency.taskId, owner).first<{ result: string }>();
    const result = product && parseJson(product.result, 'B artifact result');
    requireThat(result?.content_hash === identity.sourceHash && typeof result.version_id === 'string',
      'Comparison review requires the completed B artifact');
    const version = await db.prepare("SELECT content FROM artifact_versions WHERE id=? AND task_id=? AND owner_id=? AND kind='game'")
      .bind(result.version_id, dependency.taskId, owner).first<{ content: string }>();
    requireThat(version && await harnessHash(version.content) === identity.sourceHash, 'Comparison B artifact version drifted');
    const packIdentity = { caseId: slot.caseId, manifestSha256: grant.manifestSha256,
      evidenceSha256: identity.evidenceHash, packSha256: identity.packHash };
    const sealed = await openComparisonEvidencePack(await loadEvidencePack(packIdentity), packIdentity);
    requireThat(sealed.html === version.content, 'Comparison review evidence is for another artifact');
    const { results: parts } = await db.prepare('SELECT part,data FROM review_inputs WHERE job_id=? ORDER BY part')
      .bind(row.id).all<{ part: number; data: string }>();
    requireThat(parts.length && parts.every((part, index) => part.part === index) &&
      same(parseJson(parts.map(part => part.data).join(''), 'review input shards'), { html: sealed.html, title: slot.caseId, topic_id: null }),
    'Comparison review input shards drifted');
    const [ruleBytes, calibrationBytes] = await Promise.all([
      frozenInput(slot.rulesSha256, 'review rules', 512 * 1024),
      frozenInput(slot.calibrationSha256, 'review calibration', 512 * 1024),
    ]);
    const rules = parseReviewRulesSnapshot(parseJson(ruleBytes, 'frozen review rules'));
    requireThat(same(rules, parseReviewRulesSnapshot(parseJson(row.rules_snapshot, 'task review rules'))) &&
      same(rules.calibrationCases, parseJson(calibrationBytes, 'frozen review calibration')) &&
      await hashValue({ inputHash: identity.sourceHash, rulesSnapshot: rules,
        evidenceSha256: identity.evidenceHash, packSha256: identity.packHash }) === seal.inputSha256,
    'Comparison review rules or evidence lock drifted');
    return { row, slot, identity, capture: sealed.captureReview, sealed, rules };
  }

  async function frozenInput(expected: string, label: string, maxCharacters: number) {
    const bytes = await loadFrozenInput(expected);
    requireThat(typeof bytes === 'string' && bytes.length <= maxCharacters && await harnessHash(bytes) === expected,
      `Frozen comparison ${label} drifted`);
    return bytes;
  }

  async function brokerFor(seal: ComparisonReleaseSeal, task: Awaited<ReturnType<typeof load>>) {
    requireThat(bindVerifiedBroker && task.capture, 'Verified formal comparison broker is unavailable');
    const { slot, identity } = task;
    const scope: BrokerScope = { ...seal, grantSha256, authorizationSha256: grant.authorizationSha256,
      dispatchGrantSha256: grant.dispatchGrantSha256, planSha256: grant.planSha256,
      manifestSha256: grant.manifestSha256, runnerDatabaseId: database.id, ownerId: identity.ownerId, operation: slot.operation,
      sourceSha256: identity.sourceHash, evidenceSha256: identity.evidenceHash, modelConfigSha256: slot.modelConfigSha256,
      modelContractHash: identity.modelContractHash, deadlineAt: grant.deadlineAt };
    const bytes = await frozenInput(slot.modelConfigSha256, 'model configuration', 64 * 1024);
    const publicModel = parseJson<Omit<StoredModelProfile, 'encryptedKey'>>(bytes, 'public model profile');
    requireThat(publicModel && Object.keys(publicModel).every(field => profiles.includes(field)) &&
      publicModel.enabled === true && typeof publicModel.vision === 'boolean' &&
      typeof publicModel.baseUrl === 'string' && typeof publicModel.model === 'string' && publicModel.model.length > 0 &&
      (publicModel.protocol === 'anthropic' || publicModel.protocol === 'openai'), 'Invalid frozen public model profile');
    let origin: URL;
    try { origin = new URL(publicModel.baseUrl); } catch { throw new Error('Invalid frozen public model origin'); }
    requireThat(origin.protocol === 'https:' && !origin.username && !origin.password && !origin.search && !origin.hash,
      'Invalid frozen public model origin');
    const broker = await bindVerifiedBroker(Object.freeze(scope));
    requireThat(broker && exact(broker, ['scopeSha256', 'harnessRunner', 'profileId', 'profile']) &&
      broker.scopeSha256 === await hashValue(scope) && id.test(broker.profileId) &&
      !['constructor', 'prototype', '__proto__'].includes(broker.profileId) &&
      typeof broker.harnessRunner?.idFromName === 'function' && typeof broker.harnessRunner.get === 'function' && broker.profile,
    'Formal broker refused this exact task scope');
    const { encryptedKey, ...brokerPublic } = broker.profile;
    requireThat(typeof encryptedKey === 'string' && encryptedKey.length <= 8_192 &&
      /^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22,}={0,2}$/.test(encryptedKey) && same(brokerPublic, publicModel),
    'Broker profile is not the frozen public configuration with opaque ciphertext');
    const profile = { ...publicModel, encryptedKey };
    const purpose = slot.operation === 'creation' ? 'game' : 'review';
    const config: ModelConfig = { ...profile, activeProfile: broker.profileId,
      profiles: { [broker.profileId]: profile }, routes: { [purpose === 'game' ? 'create' : 'review']: broker.profileId } };
    requireThat(await modelContractHash(config, purpose) === identity.modelContractHash, 'Broker model contract drifted');
    const profileSha = await hashValue([broker.profileId, profile]);
    const harnessRunner: HarnessBinding = {
      idFromName(name) {
        requireThat(name === seal.taskId, 'Comparison Harness task is outside the verified scope');
        return name;
      },
      get(name) {
        requireThat(name === seal.taskId, 'Comparison Harness task is outside the verified scope');
        return broker.harnessRunner.get(broker.harnessRunner.idFromName(name));
      },
    };
    const env: PrivateRunnerEnvironment = { DB: db, SETTINGS_KEY: '', HARNESS_RUNNER: harnessRunner,
      modelStore: { get: async () => structuredClone(config) }, captureReview: task.capture };
    return { env, profileSha };
  }

  async function release(caller: object, input: ComparisonReleaseSeal) {
    trusted(caller);
    const seal = { ...input };
    requireThat(bindVerifiedBroker, 'Verified formal comparison broker is unavailable');
    await isolated();
    await db.prepare(releaseTable).run();
    const task = await load(seal, true);
    const prior = await readRelease(seal.taskId);
    const releaseSha = await hashValue({ grantSha256, ...seal });
    if (prior) {
      requireThat(prior.grant_sha === grantSha256 && prior.release_sha === releaseSha, 'Comparison task already has another release');
      return { taskId: seal.taskId, releaseSha256: releaseSha, releasedAt: prior.released_at };
    }
    requireThat(task.row.status === 'queued' && !task.row.model_started_at && !task.row.model_execution_started_at,
      'Only an unstarted queued task may receive a release');
    const { profileSha } = await brokerFor(seal, task);
    trusted(caller);
    const table = task.slot.operation === 'creation' ? 'forge_tasks' : 'review_jobs';
    const snapshotColumn = task.slot.operation === 'creation' ? 'input_snapshot' : 'rules_snapshot';
    const source = task.slot.operation === 'creation' ? task.row.input_snapshot : task.row.rules_snapshot;
    await db.prepare(`INSERT INTO comparison_execution_releases
      SELECT a.task_id,?, ?, a.identity_sha,a.input_sha,a.policy_sha,?, ?, ?
      FROM comparison_admissions a JOIN ${table} t ON t.id=a.task_id
      WHERE a.task_id=? AND a.state='paused' AND a.identity_sha=? AND a.input_sha=? AND a.policy_sha=? AND a.identity_json=?
        AND EXISTS(SELECT 1 FROM comparison_arm WHERE id=1 AND arm='B' AND plan_sha=? AND implementation=?)
        AND t.owner_id=? AND t.executor=? AND t.status='queued' AND t.model_started_at IS NULL
        ${task.slot.operation === 'review' ? 'AND t.model_execution_started_at IS NULL AND t.input_ready=1 AND t.input_hash=? AND t.title=? AND t.filename=? AND t.topic_id IS NULL' : ''}
        AND t.harness_policy=? AND t.${snapshotColumn}=?
      ON CONFLICT(task_id) DO NOTHING RETURNING task_id`).bind(grantSha256, seal.slotSha256, profileSha, releaseSha, now(),
        seal.taskId, seal.admissionSha256, seal.inputSha256, seal.policySha256, canonicalHarness(task.identity), grant.planSha256,
        grant.implementationCommit, task.row.owner_id, task.row.executor,
        ...(task.slot.operation === 'review' ? [task.identity.sourceHash, task.slot.caseId, `${task.slot.caseId}.html`] : []), task.row.harness_policy, source ?? null).first();
    const stored = await readRelease(seal.taskId);
    requireThat(stored?.grant_sha === grantSha256 && stored.release_sha === releaseSha && stored.profile_sha === profileSha,
      'Comparison release CAS failed or conflicts with an existing release');
    return { taskId: seal.taskId, releaseSha256: releaseSha, releasedAt: stored.released_at };
  }

  function bindTask(caller: object, taskId: string, state: TaskState) {
    trusted(caller);
    const slot = approvedSlot(taskId);
    requireThat(state?.storage && typeof state.storage.get === 'function' && typeof state.storage.put === 'function',
      'Comparison requires the original task Durable Object state');
    const previousOwner = storageOwners.get(state.storage);
    requireThat(previousOwner === undefined || previousOwner === taskId, 'Comparison Durable Object state belongs to another task');
    storageOwners.set(state.storage, taskId);
    async function run() {
      trusted(caller);
      await isolated();
      const stored = await readRelease(taskId);
      requireThat(stored?.grant_sha === grantSha256, 'Comparison task has no exact active release');
      const seal = { taskId, slotSha256: stored.slot_sha, admissionSha256: stored.admission_sha, inputSha256: stored.input_sha, policySha256: stored.policy_sha };
      requireThat(await hashValue({ grantSha256, ...seal }) === stored.release_sha, 'Stored comparison release digest mismatch');
      const task = await load(seal, true);
      if (task.row.status === 'done' || task.row.status === 'error') return { state: 'terminal' as const, status: task.row.status };
      const marker = await state.storage.get<string>(phaseKey);
      requireThat(marker === undefined || marker === stored.release_sha, 'Comparison Durable Object belongs to another release');
      const running = task.row.status === 'running';
      const modelStarted = Boolean(task.row.model_started_at || task.row.model_execution_started_at);
      if (running) requireThat(marker === stored.release_sha, 'Comparison cannot resume a foreign Durable Object state');
      else requireThat(!modelStarted, 'Comparison queued task already has a model start');
      let missingCheckpoint = false;
      let checkpointConfig: ModelConfig | undefined;
      let reviewCheckpoint: { request: unknown; evidence: Awaited<ReturnType<NonNullable<typeof task.sealed>['captureReview']>> } | undefined;
      if (slot.operation === 'creation') {
        const parts = await state.storage.get<number>('creationParts');
        if (parts !== undefined) {
          const checkpoint = await readCheckpoint(state.storage, 'creation');
          requireThat(marker === stored.release_sha && await hashValue(checkpoint.snapshot) === seal.inputSha256,
            'Comparison creation checkpoint source drifted');
          checkpointConfig = checkpoint.config;
          requireThat(checkpointConfig, 'Comparison creation checkpoint profile is missing');
        } else missingCheckpoint = running;
      } else if (running) {
        const phase = await state.storage.get<string>('cloudPhase');
        if (phase === undefined) missingCheckpoint = true;
        else {
          requireThat(['prepared', 'review-started', 'draft-ready', 'verify-started', 'final-ready'].includes(phase) &&
            await state.storage.get<number>('cloudCheckpointVersion') === 2 && task.sealed, 'Comparison review checkpoint is unavailable');
          const checkpoint = await readCheckpoint(state.storage, 'cloudState');
          requireThat(checkpoint.version === 2 && typeof checkpoint.materialRef === 'string', 'Comparison review checkpoint is malformed');
          const immutable = await readCheckpoint(state.storage, `cloudImmutable:${checkpoint.materialRef}`);
          requireThat(immutable.title === slot.caseId && immutable.topic_id === null, 'Comparison review checkpoint identity drifted');
          checkpointConfig = immutable.config;
          requireThat(checkpointConfig, 'Comparison review checkpoint profile is missing');
          const evidence = await task.sealed.captureReview(task.sealed.html);
          requireThat(same(immutable.images, evidence.shots) && same(immutable.probe, evidence.probe), 'Comparison review checkpoint evidence drifted');
          reviewCheckpoint = { request: immutable.request, evidence };
        }
      } else requireThat(!await state.storage.get('cloudPhase'), 'Comparison queued review already has a checkpoint');
      if (missingCheckpoint && modelStarted) {
        // The existing runner records the lost started operation as unknown.
        // Cleanup must not depend on profile availability or allow a new start.
        const unavailable = () => { throw new Error('Comparison model is blocked during unknown-outcome cleanup'); };
        const cleanup: HarnessBinding = {
          idFromName(name) { requireThat(name === taskId, 'Comparison cleanup task mismatch'); return name; },
          get(name) {
            requireThat(name === taskId, 'Comparison cleanup task mismatch');
            return { async fetch(request) {
              const body = request.method === 'POST' && new URL(request.url).pathname === '/finish'
                ? await request.clone().json().catch(() => null) as { outcome?: unknown } | null : null;
              if (body?.outcome !== 'failed') return new Response(null, { status: 403 });
              if (!failedHarnessRunner) return new Response(null, { status: 503 });
              return failedHarnessRunner.get(failedHarnessRunner.idFromName(taskId)).fetch(request);
            } };
          },
        };
        trusted(caller);
        await alarms[slot.operation](state, { DB: db, SETTINGS_KEY: '', HARNESS_RUNNER: cleanup,
          modelStore: { get: async () => unavailable() }, captureReview: unavailable }, taskId);
        return { state: 'invoked' as const, taskId };
      }
      const { env, profileSha } = await brokerFor(seal, task);
      requireThat(profileSha === stored.profile_sha, 'Comparison broker profile changed after release');
      if (checkpointConfig) {
        const selected = activeModelProfile(checkpointConfig, slot.operation === 'creation' ? 'game' : 'review');
        requireThat(selected && await hashValue([selected.id, selected.profile]) === stored.profile_sha,
          'Comparison checkpoint profile changed after release');
      }
      if (reviewCheckpoint) {
        requireThat(task.sealed && task.rules, 'Comparison review checkpoint lost its sealed source');
        const { images, ...expected } = await prepareReview({ ...env, ownerId: 'admin', modelExecutor: 'platform' }, {
          html: task.sealed.html, title: slot.caseId, ...reviewCheckpoint.evidence, rulesSnapshot: task.rules, reportSchemaVersion: 2,
        });
        const user = Array.isArray(expected.user) ? expected.user.map(part => {
          if (part.type !== 'image') return part;
          const { data, ...metadata } = part;
          // The pinned checkpoint stores the first identical byte sequence.
          // Static scenes may produce identical screenshots at different labels.
          const imageIndex = images.findIndex(image => image.data === data);
          requireThat(imageIndex >= 0, 'Comparison review checkpoint image index drifted');
          return { ...metadata, imageIndex };
        }) : expected.user;
        requireThat(same({ ...expected, user }, reviewCheckpoint.request), 'Comparison review checkpoint source or rules drifted');
      }
      trusted(caller);
      if (marker === undefined) await state.storage.put(phaseKey, stored.release_sha);
      trusted(caller);
      await alarms[slot.operation](state, env, taskId);
      return { state: 'invoked' as const, taskId };
    }
    return {
      async alarm() {
        requireThat(!activeTasks.has(taskId), 'Comparison task alarm is already running');
        activeTasks.add(taskId);
        try { return await run(); } finally { activeTasks.delete(taskId); }
      },
    };
  }

  return { release, bindTask };
}
