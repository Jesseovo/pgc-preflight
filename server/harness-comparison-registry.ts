/** Private candidate composition. No route, deployment, or authorization is created here. */
import { comparisonAdmittedSlotsSha256, openComparisonLedger, type ComparisonAdmittedSlot, type ComparisonGrant, type ComparisonStage, type ComparisonStreamingTransport } from '../scripts/harness-comparison-ledger';
import type { planComparison } from '../scripts/harness-comparison-coordinator';
import type { ComparisonAuthorityService } from '../scripts/harness-comparison-task-worker';
import { createComparisonBaselineBroker, createComparisonHarnessBroker } from './harness-comparison-broker';
import { openComparisonEvidencePack, type ComparisonEvidenceIdentity } from './harness-comparison-evidence';
import { prepareReview } from './forge-api';
import { authorizeHarnessTask } from './harness-host';
import { canonicalHarness, CCB_ENGINE_COMMIT, harnessHash, modelContractHash, parseHarnessPolicy } from './harness-policy';
import { lockHarnessModel, type HarnessDatabase, type HarnessRun } from './harness-ledger';
import type { ComparisonReleaseSeal, ComparisonRunnerGrant } from './harness-comparison-runner';
import type { ComparisonServiceContext, createComparisonServiceHandler } from './harness-comparison-service';
import { parseReviewRulesSnapshot } from './review-rules';
import { activeModelProfile, type ModelConfig, type StoredModelProfile } from './settings';

type Arm = 'A' | 'B';
type Operation = 'creation' | 'review';
type Plan = Awaited<ReturnType<typeof planComparison>>['plan'];
type PlanSlot = Plan['slots'][number];
type Handle = Parameters<typeof createComparisonServiceHandler>[0]['handle'];
type TaskStatement = {
  bind(...values: unknown[]): TaskStatement; first<T>(): Promise<T | null>; run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
};
type TaskDatabase = { prepare(sql: string): TaskStatement };
type Binding<T> = { id: string; connection: T };
type ProfilePin = { profileId: string; profileHash: string };
type Admission = { identity_sha: string; identity_json: string; state: string; input_sha: string; policy_sha: string };
type AdmissionIdentity = {
  schemaVersion: 1; scope: 'formal'; planSha256: string; manifestSha256: string; slot: PlanSlot; ownerId: string;
  sourceHash: string; evidenceHash: string | null; packHash: string | null; modelContractHash: string; harnessPolicy: unknown;
};
type TaskRow = {
  id: string; owner_id: string; status: string; executor: string; model_started_at: string | null; harness_policy?: string | null;
  kind?: string; phase?: string; scope?: string; creative_version?: number; input_snapshot?: string; payload?: string;
  model_executor?: string; model_execution_started_at?: string | null; stage?: string; review_mode?: string; report_schema_version?: number;
  input_hash?: string; rules_snapshot?: string; input_ready?: number; title?: string; filename?: string; topic_id?: number | null;
};
type Release = { grant_sha: string; slot_sha: string; admission_sha: string; input_sha: string; policy_sha: string;
  profile_sha: string; release_sha: string; released_at: number };
type Attestation = {
  authorizedCandidateVersion: string; executingCandidateVersion: string;
  A: { implementationCommit: string; runtimeTreeSha256: string; workerVersion: string; bundleSha256: string };
  B: { implementationCommit: string; runtimeTreeSha256: string; image: string; workerVersion: string; bundleSha256: string };
};
const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const hex = /^[a-f0-9]{64}$/;
const version = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const uuid8 = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const materials = [['brief.md', 'brief_md'], ['sample.svg', 'preview_svg'], ['assets.html', 'assets_html']] as const;
const publicFields = ['name', 'baseUrl', 'model', 'protocol', 'enabled', 'vision', 'effort', 'maxOutputTokens', 'updatedAt'];
export const COMPARISON_CANDIDATE_PROFILE_SCHEMA = `CREATE TABLE IF NOT EXISTS comparison_candidate_profile_locks (
  operation TEXT PRIMARY KEY, grant_sha TEXT NOT NULL, profile_sha TEXT NOT NULL
)`;
const immutableProfileLocks = ['UPDATE', 'DELETE'].map(operation => `CREATE TRIGGER IF NOT EXISTS comparison_profile_no_${operation.toLowerCase()}
  BEFORE ${operation} ON comparison_candidate_profile_locks BEGIN SELECT RAISE(ABORT,'Immutable comparison profile lock'); END`);
const unavailable = () => new Error('Comparison candidate registry unavailable');
function need(condition: unknown): asserts condition { if (!condition) throw unavailable(); }
const same = (left: unknown, right: unknown) => canonicalHarness(left) === canonicalHarness(right);
const digest = (value: unknown) => harnessHash(canonicalHarness(value));
const isHash = (value: unknown): value is string => typeof value === 'string' && hex.test(value);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
function parse<T>(bytes: string): T { try { return JSON.parse(bytes) as T; } catch { throw unavailable(); } }

type AuthorityOptions = {
  grant: ComparisonGrant; slots: readonly ComparisonAdmittedSlot[]; runnerGrants: Record<Arm, ComparisonRunnerGrant>;
  planBytes: string; attestation: Attestation;
  databases: { A: Binding<TaskDatabase>; B: Binding<TaskDatabase>; ledger: Binding<HarnessDatabase>; nonce: Binding<HarnessDatabase> };
  loadFrozenInput(sha256: string): Promise<string>;
  loadEvidencePack(taskId: string, identity: ComparisonEvidenceIdentity): Promise<string>;
  authorizeGrant(context: ComparisonServiceContext): Promise<boolean>;
  now?: () => number;
};
type CandidateOptions = AuthorityOptions & {
  databases: AuthorityOptions['databases'] & { capacity: Binding<HarnessDatabase> };
  profiles: Record<Operation, ProfilePin>;
  loadConfig(): Promise<ModelConfig | null>;
  settingsKey: string;
  fetcher(url: string, init: RequestInit): Promise<Response>;
  waitUntil?(promise: Promise<unknown>): void;
};

async function openRegistryAuthority(options: AuthorityOptions) {
  const { loadFrozenInput, loadEvidencePack, authorizeGrant, now = Date.now } = options;
  const databases = { A: options.databases.A, B: options.databases.B, ledger: options.databases.ledger, nonce: options.databases.nonce };
  const grant = structuredClone(options.grant), slots = structuredClone(options.slots), runnerGrants = structuredClone(options.runnerGrants);
  const attestation = structuredClone(options.attestation), planBytes = options.planBytes;
  const bindings = [databases.A, databases.B, databases.ledger];
  const nonce = databases.nonce;
  need(grant.scope === 'formal' && grant.purpose === 'isolated-comparison' && grant.ledgerDatabaseId === databases.ledger.id &&
    positive(grant.notBefore) && positive(grant.deadlineAt) && positive(grant.maxRequests) && positive(grant.maxOutputTokens) &&
    new Set(bindings.map(value => value.id)).size === bindings.length && new Set(bindings.map(value => value.connection)).size === bindings.length &&
    bindings.every(value => id.test(value.id) && value.connection) && id.test(nonce.id) && nonce.connection &&
    [databases.A, databases.B].every(value => nonce.id !== value.id && nonce.connection !== value.connection) &&
    (nonce.id === databases.ledger.id) === (nonce.connection === databases.ledger.connection) && typeof authorizeGrant === 'function' &&
    version.test(attestation.executingCandidateVersion) &&
    attestation.executingCandidateVersion === attestation.authorizedCandidateVersion && version.test(attestation.B.workerVersion) &&
    isHash(attestation.B.bundleSha256) && version.test(attestation.A.workerVersion) && isHash(attestation.A.bundleSha256) &&
    new Set([attestation.A.workerVersion, attestation.B.workerVersion, attestation.executingCandidateVersion]).size === 3 &&
    typeof planBytes === 'string' && planBytes.length <= 512 * 1024 &&
    await harnessHash(planBytes) === grant.planSha256 && await comparisonAdmittedSlotsSha256(slots) === grant.admittedSlotsSha256);
  const plan = parse<Plan>(planBytes);
  need(plan.schemaVersion === 1 && plan.scope === 'formal' && plan.executionAllowed === false && plan.manifestSha256 === grant.manifestSha256 &&
    plan.source.A.implementationCommit === baseline && plan.source.B.implementationCommit === attestation.B.implementationCommit &&
    plan.source.B.engineCommit === CCB_ENGINE_COMMIT &&
    plan.source.B.image === attestation.B.image && plan.cases.length === 6 && new Set(plan.cases.map(value => value.id)).size === 6 &&
    plan.slots.length === 24 && slots.length === 24 && new Set(plan.slots.map(value => value.taskId)).size === 24 &&
    new Set(plan.slots.map(value => [value.caseId, value.arm, value.operation].join('/'))).size === 24);
  const dispatchGrantSha256 = await digest(['comparison-dispatch-grant-v1', grant]);
  const runnerHashes = { A: await digest(runnerGrants.A), B: await digest(runnerGrants.B) };
  for (const arm of ['A', 'B'] as const) {
    const runner = runnerGrants[arm], runtime = attestation[arm];
    need(runner.schemaVersion === 1 && runner.scope === 'formal' && runner.purpose === grant.purpose &&
      runner.runnerDatabaseId === databases[arm].id && runner.dispatchGrantSha256 === dispatchGrantSha256 &&
      runner.authorizationSha256 === grant.authorizationSha256 && runner.planSha256 === grant.planSha256 && runner.manifestSha256 === grant.manifestSha256 &&
      runner.maxRequests === grant.maxRequests && runner.maxOutputTokens === grant.maxOutputTokens && runner.notBefore === grant.notBefore && runner.deadlineAt === grant.deadlineAt &&
      runner.implementationCommit === plan.source[arm].implementationCommit && runner.implementationCommit === runtime.implementationCommit &&
      isHash(runtime.runtimeTreeSha256) && runner.runtimeTreeSha256 === runtime.runtimeTreeSha256 &&
      runner.image === (arm === 'A' ? null : attestation.B.image));
  }
  const owner = 'comparison-' + grant.planSha256.slice(0, 24);
  const slotsByTask = new Map<string, { ledger: ComparisonAdmittedSlot; plan: PlanSlot }>();
  const transportOwners = new Map<string, string>();
  for (const slot of slots) {
    const registered = plan.slots.find(item => item.taskId === slot.taskId);
    const stages = slot.operation === 'review' ? ['review', 'review_verify'] : ['build', 'polish', 'repair', ...(slot.arm === 'B' ? ['repair2'] : [])];
    need(registered && uuid8.test(slot.taskId) && !slotsByTask.has(slot.taskId) &&
      registered.arm === slot.arm && registered.operation === slot.operation && registered.caseId === slot.caseId &&
      registered.modelConfigSha256 === slot.modelConfigSha256 && plan.cases.some(item => item.id === slot.caseId) &&
      slot.ownerId === (slot.operation === 'creation' ? owner : 'admin') &&
      Object.keys(slot.stages).length === stages.length && stages.every(stage => Object.hasOwn(slot.stages, stage)) &&
      (slot.operation === 'creation' ? 'materialSha256' in registered && slot.sourceSha256 === registered.materialSha256 && slot.evidenceSha256 === null :
        'requires' in registered && (slot.sourceSha256 === null && slot.evidenceSha256 === null || isHash(slot.sourceSha256) && isHash(slot.evidenceSha256))));
    slotsByTask.set(slot.taskId, { ledger: slot, plan: registered });
    for (const route of Object.values(slot.stages)) {
      need(!transportOwners.has(route.transportId) || transportOwners.get(route.transportId) === slot.taskId);
      transportOwners.set(route.transportId, slot.taskId);
    }
  }
  const serviceContext = (arm: Arm): ComparisonServiceContext => Object.freeze({
    runId: grant.runId, authorizationSha256: grant.authorizationSha256, runnerGrantSha256: runnerHashes[arm], dispatchGrantSha256,
    planSha256: grant.planSha256, manifestSha256: grant.manifestSha256, runnerDatabaseId: databases[arm].id, nonceDatabaseId: databases.nonce.id,
    candidateVersion: attestation.executingCandidateVersion, notBefore: grant.notBefore, deadlineAt: grant.deadlineAt,
    taskIds: Object.freeze(slots.filter(value => value.arm === arm).map(value => value.taskId)),
  });
  const context = serviceContext('B'), baselineContext = serviceContext('A');
  async function authorized(arm: Arm) {
    need(now() >= grant.notBefore && now() < grant.deadlineAt && await authorizeGrant(arm === 'A' ? baselineContext : context) === true);
  }
  async function marker(arm: Arm) {
    const row = await databases[arm].connection.prepare('SELECT plan_sha,arm,implementation FROM comparison_arm WHERE id=1')
      .first<{ plan_sha: string; arm: Arm; implementation: string }>();
    need(row?.plan_sha === grant.planSha256 && row.arm === arm && row.implementation === plan.source[arm].implementationCommit);
  }
  await Promise.all([authorized('A'), authorized('B'), marker('A'), marker('B')]);

  async function frozen(expected: string, max = 512 * 1024) {
    need(isHash(expected));
    const bytes = await loadFrozenInput(expected);
    need(typeof bytes === 'string' && bytes.length <= max && await harnessHash(bytes) === expected);
    return bytes;
  }
  const profileDb = databases.ledger.connection;
  async function publicModel(operation: Operation, expected: string) {
    const snapshot = await frozen(expected, 64 * 1024);
    const publicProfile = parse<Omit<StoredModelProfile, 'encryptedKey'>>(snapshot);
    need(publicProfile && !Array.isArray(publicProfile) && Object.keys(publicProfile).every(key => publicFields.includes(key)) &&
      publicProfile.enabled === true && publicProfile.vision === true && typeof publicProfile.updatedAt === 'string' &&
      (operation === 'creation' ? publicProfile.protocol === 'anthropic' && publicProfile.model === 'claude-opus-5-5' && publicProfile.baseUrl === 'https://riffle-api.pages.dev' :
        publicProfile.protocol === 'openai' && publicProfile.model === 'deepseek-flash' && publicProfile.baseUrl === 'https://api.deepseek.com'));
    const purpose = operation === 'creation' ? 'game' : 'review';
    const profile = { ...publicProfile, encryptedKey: 'public-contract-marker' };
    const contract = await modelContractHash({ ...profile, activeProfile: 'frozen', profiles: { frozen: profile } }, purpose);
    return { snapshot, publicProfile, contract };
  }
  const frozenProfiles = {
    creation: await publicModel('creation', plan.settings.creationModel.config.sha256),
    review: await publicModel('review', plan.settings.reviewModel.config.sha256),
  };
  for (const slot of slots) {
    const model = frozenProfiles[slot.operation];
    const creation = slot.operation === 'creation';
    need(slot.modelConfigSha256 === (creation ? plan.settings.creationModel.config.sha256 : plan.settings.reviewModel.config.sha256));
    for (const route of Object.values(slot.stages)) {
      need(route.modelContractHash === model.contract && route.protocol === model.publicProfile.protocol && route.model === model.publicProfile.model &&
        route.stream && route.effort === (creation ? 'high' : 'low') && route.maxOutputTokens === (creation ? 64_000 : 24_000) && route.jsonMode === !creation);
    }
  }
  async function storedProfileSha(operation: Operation) {
    const exists = await profileDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comparison_candidate_profile_locks'").first();
    need(exists);
    const row = await profileDb.prepare('SELECT grant_sha,profile_sha FROM comparison_candidate_profile_locks WHERE operation=?')
      .bind(operation).first<{ grant_sha: string; profile_sha: string }>();
    need(row?.grant_sha === dispatchGrantSha256 && isHash(row.profile_sha));
    return row.profile_sha;
  }

  type Task = Awaited<ReturnType<typeof readTask>>;
  async function readTask(taskId: string, arm: Arm, mode: 'active' | 'either') {
    await authorized(arm);
    await marker(arm);
    const registered = slotsByTask.get(taskId);
    need(registered && registered.ledger.arm === arm);
    const { ledger: slot, plan: declared } = registered, db = databases[arm].connection;
    const admission = await db.prepare('SELECT * FROM comparison_admissions WHERE task_id=?').bind(taskId).first<Admission>();
    need(admission?.state === 'paused' && [admission.identity_sha, admission.input_sha, admission.policy_sha].every(isHash) &&
      await harnessHash(admission.identity_json) === admission.identity_sha &&
      await db.prepare('SELECT 1 FROM comparison_schedule_requests WHERE task_id=?').bind(taskId).first());
    const identity = parse<AdmissionIdentity>(admission.identity_json);
    need(identity.schemaVersion === 1 && identity.scope === 'formal' && same(identity.slot, declared) && identity.ownerId === slot.ownerId &&
      identity.planSha256 === grant.planSha256 && identity.manifestSha256 === grant.manifestSha256 && isHash(identity.sourceHash) &&
      identity.modelContractHash === frozenProfiles[slot.operation].contract &&
      Object.values(slot.stages).every(route => route.modelContractHash === identity.modelContractHash));
    const creation = slot.operation === 'creation';
    const row = await db.prepare('SELECT * FROM ' + (creation ? 'forge_tasks' : 'review_jobs') + ' WHERE id=?').bind(taskId).first<TaskRow>();
    need(row?.id === taskId && row.owner_id === slot.ownerId && row.executor === (creation ? 'platform' : 'cloud') &&
      (mode === 'active' ? row.status === 'running' : row.status === 'queued' && !row.model_started_at && !row.model_execution_started_at ||
        mode === 'either' && ['running', 'done', 'error'].includes(row.status)));
    const policy = parseHarnessPolicy(row.harness_policy);
    need(same(policy, identity.harnessPolicy) && await digest(policy) === admission.policy_sha &&
      (arm === 'A' ? !policy && !Object.hasOwn(row, 'harness_policy') : policy && policy.image === attestation.B.image && policy.releaseHash === grant.planSha256 &&
        policy.modelContractHash === identity.modelContractHash && policy.family === (creation ? 'forge' : 'review') &&
        policy.purpose === (creation ? 'game' : 'review')));
    if (creation) {
      need('materialSha256' in declared && row.kind === 'game' && row.creative_version === 2 && typeof row.input_snapshot === 'string' &&
        identity.sourceHash === declared.materialSha256 && identity.evidenceHash === null && identity.packHash === null);
      const snapshot = parse<{ topic: Record<string, unknown> }>(row.input_snapshot);
      const item = plan.cases.find(value => value.id === slot.caseId);
      need(item && snapshot.topic?.owner_id === owner && snapshot.topic.subject === slot.caseId && Number.isSafeInteger(snapshot.topic.id) &&
        row.scope === owner + ':game:' + snapshot.topic.id && typeof row.payload === 'string' &&
        same(parse(row.payload), { type: 'game', id: snapshot.topic.id, requestId: taskId, creative_version: 2 }) &&
        await digest(snapshot) === admission.input_sha &&
        await db.prepare('SELECT 1 FROM members WHERE id=? AND enabled=1 AND star=1').bind(owner).first());
      for (const [name, field] of materials) {
        const ref = item.materials.find(value => value.path === 'materials/' + slot.caseId + '/' + name);
        const content = snapshot.topic[field];
        need(ref && typeof content === 'string' && await harnessHash(content) === ref.sha256);
      }
    } else {
      need('requires' in declared && row.model_executor === 'platform' && row.review_mode === 'basic' && row.report_schema_version === 2 &&
        (['done', 'error'].includes(row.status) || row.input_ready === 1) && row.input_hash === identity.sourceHash && typeof row.rules_snapshot === 'string' &&
        row.title === slot.caseId && row.filename === slot.caseId + '.html' && row.topic_id === null && isHash(identity.evidenceHash) && isHash(identity.packHash) &&
        (slot.sourceSha256 === null || slot.sourceSha256 === identity.sourceHash && slot.evidenceSha256 === identity.evidenceHash));
      const rules = parseReviewRulesSnapshot(parse(row.rules_snapshot));
      const [rulesBytes, calibrationBytes] = await Promise.all([frozen(declared.rulesSha256), frozen(declared.calibrationSha256)]);
      need(same(rules, parseReviewRulesSnapshot(parse(rulesBytes))) && same(rules.calibrationCases, parse(calibrationBytes)) &&
        await digest({ inputHash: identity.sourceHash, rulesSnapshot: rules, evidenceSha256: identity.evidenceHash, packSha256: identity.packHash }) === admission.input_sha);
    }
    const seal: ComparisonReleaseSeal = { taskId, slotSha256: await digest(declared), admissionSha256: admission.identity_sha,
      inputSha256: admission.input_sha, policySha256: admission.policy_sha };
    return { row, slot, declared, identity, seal, db };
  }

  async function releaseRow(task: Task) {
    const arm = task.slot.arm, grantSha256 = runnerHashes[arm];
    const exists = await task.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comparison_execution_releases'").first();
    if (!exists) return false;
    const released = await task.db.prepare('SELECT * FROM comparison_execution_releases WHERE task_id=?').bind(task.slot.taskId).first<Release>();
    if (!released) return false;
    const expectedProfileSha = arm === 'B' ? await storedProfileSha(task.slot.operation) :
      await digest(['comparison-a-marker-v1', task.slot.taskId, frozenProfiles[task.slot.operation].publicProfile]);
    need(released.grant_sha === grantSha256 && released.slot_sha === task.seal.slotSha256 && released.admission_sha === task.seal.admissionSha256 &&
      released.input_sha === task.seal.inputSha256 && released.policy_sha === task.seal.policySha256 && released.profile_sha === expectedProfileSha &&
      released.released_at >= grant.notBefore && released.released_at < grant.deadlineAt && released.released_at <= now() &&
      released.release_sha === await digest({ grantSha256, ...task.seal }));
    return true;
  }

  async function sealedEvidence(task: Task) {
    need('requires' in task.declared && isHash(task.identity.evidenceHash) && isHash(task.identity.packHash));
    const dependency = slotsByTask.get(task.declared.requires.creationTaskId);
    need(dependency?.ledger.arm === 'B' && dependency.ledger.operation === 'creation' && dependency.ledger.caseId === task.slot.caseId);
    await marker('B');
    const b = databases.B.connection, bId = dependency.ledger.taskId;
    const released = await b.prepare('SELECT * FROM comparison_execution_releases WHERE task_id=?').bind(bId).first<Release>();
    const admission = await b.prepare('SELECT * FROM comparison_admissions WHERE task_id=?').bind(bId).first<Admission>();
    need(released && admission?.state === 'paused' && await harnessHash(admission.identity_json) === admission.identity_sha &&
      released.released_at >= grant.notBefore && released.released_at < grant.deadlineAt && released.released_at <= now() &&
      released.grant_sha === runnerHashes.B && released.slot_sha === await digest(dependency.plan) && released.profile_sha === await storedProfileSha('creation') &&
      released.admission_sha === admission.identity_sha && released.input_sha === admission.input_sha && released.policy_sha === admission.policy_sha &&
      released.release_sha === await digest({ grantSha256: runnerHashes.B, taskId: bId, slotSha256: released.slot_sha,
        admissionSha256: released.admission_sha, inputSha256: released.input_sha, policySha256: released.policy_sha }));
    const source = parse<AdmissionIdentity>(admission.identity_json);
    need(source.schemaVersion === 1 && source.scope === 'formal' && source.planSha256 === grant.planSha256 &&
      source.manifestSha256 === grant.manifestSha256 && source.ownerId === owner && same(source.slot, dependency.plan) &&
      source.sourceHash === dependency.ledger.sourceSha256 && source.evidenceHash === null && source.packHash === null &&
      source.modelContractHash === frozenProfiles.creation.contract);
    const product = await b.prepare("SELECT result FROM forge_tasks WHERE id=? AND owner_id=? AND status='done' AND executor='platform' AND kind='game'")
      .bind(bId, owner).first<{ result: string }>();
    const output = product && parse<{ version_id: string; content_hash: string }>(product.result);
    need(output?.content_hash === task.identity.sourceHash && typeof output.version_id === 'string');
    const artifact = await b.prepare("SELECT content FROM artifact_versions WHERE id=? AND task_id=? AND owner_id=? AND kind='game'")
      .bind(output.version_id, bId, owner).first<{ content: string }>();
    const identity = { caseId: task.slot.caseId, manifestSha256: grant.manifestSha256,
      evidenceSha256: task.identity.evidenceHash, packSha256: task.identity.packHash };
    const serialized = await loadEvidencePack(task.slot.taskId, identity);
    const opened = await openComparisonEvidencePack(serialized, identity);
    need(artifact && artifact.content === opened.html && await harnessHash(opened.html) === task.identity.sourceHash);
    const { results } = await task.db.prepare('SELECT part,data FROM review_inputs WHERE job_id=? ORDER BY part')
      .bind(task.slot.taskId).all<{ part: number; data: string }>();
    need(results.length && results.every((part, i) => part.part === i) &&
      same(parse(results.map(part => part.data).join('')), { html: opened.html, title: task.slot.caseId, topic_id: null }));
    return { identity, serialized, opened };
  }

  function taskAuthority(arm: Arm): ComparisonAuthorityService { return {
    async authorizeRelease(seal) {
      try {
        const task = await readTask(seal.taskId, arm, 'either');
        need(same(task.seal, seal));
        if (task.slot.operation === 'review' && ['queued', 'running'].includes(task.row.status)) await sealedEvidence(task);
        need(await releaseRow(task) || task.row.status === 'queued');
        return true;
      } catch { return false; }
    },
    async readTaskRuntime(taskId) {
      try {
        const task = await readTask(taskId, arm, 'either');
        need(await releaseRow(task) || task.row.status === 'queued');
        return { grant: structuredClone(runnerGrants[arm]), planBytes, workerVersion: attestation[arm].workerVersion, bundleSha256: attestation[arm].bundleSha256 };
      } catch { return null; }
    },
    async readFrozenInput(taskId, expected) {
      const task = await readTask(taskId, arm, 'either'), item = task.declared;
      need(['queued', 'running'].includes(task.row.status));
      if (task.row.status === 'running') need(await releaseRow(task));
      need(expected === item.modelConfigSha256 || 'rulesSha256' in item && (expected === item.rulesSha256 || expected === item.calibrationSha256));
      return frozen(expected);
    },
    async readEvidencePack(taskId, identity) {
      const task = await readTask(taskId, arm, 'either');
      need(['queued', 'running'].includes(task.row.status));
      if (task.row.status === 'running') need(await releaseRow(task));
      const pack = await sealedEvidence(task);
      need(same(pack.identity, identity));
      return pack.serialized;
    },
  }; }
  const authority = taskAuthority('B');
  const baselineAuthority = { ...taskAuthority('A'), async verifyCompletedBArtifact(input: {
    taskId: string; caseId: string; planSha256: string; manifestSha256: string; sourceSha256: string; evidenceSha256: string; packSha256: string;
  }) {
    try {
      const slot = slots.find(item => item.arm === 'A' && item.operation === 'review' && item.caseId === input.caseId);
      need(slot && input.planSha256 === grant.planSha256 && input.manifestSha256 === grant.manifestSha256);
      const task = await readTask(slot.taskId, 'A', 'either');
      need('requires' in task.declared && task.declared.requires.creationTaskId === input.taskId && task.identity.sourceHash === input.sourceSha256 &&
        task.identity.evidenceHash === input.evidenceSha256 && task.identity.packHash === input.packSha256 && ['queued', 'running'].includes(task.row.status));
      if (task.row.status === 'running') need(await releaseRow(task));
      await sealedEvidence(task);
      return true;
    } catch { return false; }
  } };

  return { authority, baselineAuthority, context, baselineContext, databases, grant, slots, plan, frozenProfiles, profileDb,
    runnerHashes, dispatchGrantSha256, readTask, releaseRow, sealedEvidence, now };
}

/** Research RPC authority. It never receives provider bindings or settings secrets. */
export async function openComparisonAuthority(options: AuthorityOptions) {
  return (await openRegistryAuthority(options)).authority;
}
export async function openComparisonBaselineAuthority(options: AuthorityOptions) {
  return (await openRegistryAuthority(options)).baselineAuthority;
}

/** Server-only, authorized no-forward bootstrap. Return opaque pins, never ciphertext or keys. */
export async function inspectComparisonProfilePins(options: AuthorityOptions & {
  profileIds: Record<Operation, string>; loadConfig(): Promise<ModelConfig | null>;
}) {
  const { frozenProfiles, profileDb, dispatchGrantSha256 } = await openRegistryAuthority(options);
  const config = await options.loadConfig();
  const hasLocks = await profileDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comparison_candidate_profile_locks'").first();
  async function pin(operation: Operation) {
    const purpose = operation === 'creation' ? 'game' : 'review';
    const selected = activeModelProfile(config, purpose), cap = operation === 'creation' ? 64_000 : 24_000;
    const locked = await lockHarnessModel(config, purpose, cap), { publicProfile, contract } = frozenProfiles[operation];
    need(selected && locked && id.test(options.profileIds[operation]) && selected.id === options.profileIds[operation] &&
      locked.profileId === selected.id && locked.maxOutputTokens === cap && locked.effort === (operation === 'creation' ? 'high' : 'low') &&
      same(Object.fromEntries(Object.keys(publicProfile).map(key => [key, selected.profile[key as keyof StoredModelProfile]])), publicProfile) &&
      await modelContractHash(config, purpose) === contract);
    if (hasLocks) {
      const existing = await profileDb.prepare('SELECT grant_sha,profile_sha FROM comparison_candidate_profile_locks WHERE operation=?')
        .bind(operation).first<{ grant_sha: string; profile_sha: string }>();
      need(!existing || existing.grant_sha === dispatchGrantSha256 &&
        existing.profile_sha === await digest([selected.id, { ...publicProfile, encryptedKey: selected.profile.encryptedKey }]));
    }
    return { profileId: locked.profileId, profileHash: locked.profileHash };
  }
  return { creation: await pin('creation'), review: await pin('review') };
}

export async function openComparisonCandidateRegistry(options: CandidateOptions) {
  const { capacity } = options.databases;
  const { loadConfig, settingsKey, fetcher, waitUntil } = options;
  need(id.test(capacity.id) && capacity.connection && settingsKey && typeof loadConfig === 'function' && typeof fetcher === 'function' &&
    [options.databases.A, options.databases.B, options.databases.ledger, options.databases.nonce].every(item =>
      item.id !== capacity.id && item.connection !== capacity.connection));
  const shared = await openRegistryAuthority(options);
  const { authority, baselineAuthority, context, baselineContext, databases, grant, slots, plan, frozenProfiles, profileDb,
    runnerHashes, dispatchGrantSha256, readTask, releaseRow, sealedEvidence, now } = shared;
  type Task = Awaited<ReturnType<typeof readTask>>;
  const pins = structuredClone(options.profiles);
  await profileDb.prepare(COMPARISON_CANDIDATE_PROFILE_SCHEMA).run();
  for (const sql of immutableProfileLocks) await profileDb.prepare(sql).run();
  async function profile(operation: Operation) {
    const purpose = operation === 'creation' ? 'game' : 'review';
    const { snapshot, publicProfile, contract } = frozenProfiles[operation];
    const config = await loadConfig(), selected = activeModelProfile(config, purpose), pin = pins[operation];
    const locked = await lockHarnessModel(config, purpose, operation === 'creation' ? 64_000 : 24_000);
    need(pin && id.test(pin.profileId) && isHash(pin.profileHash) && selected && locked?.profileId === pin.profileId && locked.profileHash === pin.profileHash &&
      await modelContractHash(config, purpose) === contract);
    const projection = Object.fromEntries(Object.keys(publicProfile).map(key => [key, selected.profile[key as keyof StoredModelProfile]]));
    need(same(projection, publicProfile));
    const opaque = { ...publicProfile, encryptedKey: selected.profile.encryptedKey };
    const profileSha = await digest([pin.profileId, opaque]);
    await profileDb.prepare('INSERT OR IGNORE INTO comparison_candidate_profile_locks(operation,grant_sha,profile_sha) VALUES(?,?,?)')
      .bind(operation, dispatchGrantSha256, profileSha).run();
    const saved = await profileDb.prepare('SELECT grant_sha,profile_sha FROM comparison_candidate_profile_locks WHERE operation=?')
      .bind(operation).first<{ grant_sha: string; profile_sha: string }>();
    need(saved?.grant_sha === dispatchGrantSha256 && saved.profile_sha === profileSha);
    return { snapshot, profile: opaque, profileId: pin.profileId, profileHash: pin.profileHash,
      providerUrl: opaque.baseUrl + (operation === 'creation' ? '/v1/messages' : '/chat/completions') };
  }
  // Each broker has a distinct in-memory capability, and the shared ledger owns
  // the complete immutable slot set. The capability never crosses an RPC edge.
  const authorities = new Map(slots.map(slot => [slot.slotId, Object.freeze({})]));
  const transports = new Map<string, ComparisonStreamingTransport>();
  function activePhase(task: Task, stage: ComparisonStage) {
    const started = task.slot.arm === 'B' || Boolean(task.row.model_started_at && (task.slot.operation === 'creation' || task.row.model_execution_started_at));
    return started && Boolean(task.slot.stages[stage]) && (task.slot.operation === 'creation' ? task.row.phase === stage + ':model' ||
      task.slot.arm === 'B' && stage === 'build' && task.row.phase === 'build:waiting' :
      task.row.stage === (stage === 'review_verify' ? 'verify' : 'review'));
  }
  async function active(taskId: string, arm: Arm, stage?: ComparisonStage) {
    const task = await readTask(taskId, arm, 'active');
    need(await releaseRow(task) && (stage === undefined || activePhase(task, stage)));
    return task;
  }
  async function runOrigin(task: Task, run: HarnessRun) {
    const policy = parseHarnessPolicy(task.row.harness_policy);
    need(policy && run.snapshotHash === await harnessHash(JSON.stringify(policy)));
    if (task.slot.operation === 'creation') {
      need(typeof task.row.input_snapshot === 'string');
      return run.sourceHash === await harnessHash(task.row.input_snapshot);
    }
    const evidence = await sealedEvidence(task);
    const profile = { ...frozenProfiles.review.publicProfile, encryptedKey: 'public-contract-marker' };
    const config = { ...profile, activeProfile: 'frozen', profiles: { frozen: profile }, routes: { review: 'frozen' } };
    const { images, ...prepared } = await prepareReview({ DB: task.db, ownerId: 'admin', modelExecutor: 'platform', modelStore: { get: async () => config } }, {
      title: task.slot.caseId, html: evidence.opened.html, ...await evidence.opened.captureReview(evidence.opened.html),
      rulesSnapshot: parseReviewRulesSnapshot(task.row.rules_snapshot), reportSchemaVersion: 2,
    });
    return run.sourceHash === await digest({ request: { ...prepared, reportSchemaVersion: 2 }, images });
  }
  async function createBroker(slot: ComparisonAdmittedSlot) {
    const locked = await profile(slot.operation);
    const approval = { profileId: locked.profileId, profileHash: locked.profileHash, providerUrl: locked.providerUrl, publicProfileSnapshot: locked.snapshot };
    const base = { grant, slot, approval, loadConfig, settingsKey, capacityDB: capacity.connection, fetcher };
    if (slot.arm === 'A') return { arm: 'A' as const, broker: await createComparisonBaselineBroker({ ...base, authorize: async scope => {
      const task = await active(scope.taskId, 'A', scope.stage);
      if (task.slot.operation === 'review') await sealedEvidence(task);
      return true;
    } }) };
    return { arm: 'B' as const, broker: await createComparisonHarnessBroker({ ...base, harnessDB: databases.B.connection, waitUntil,
      authorizeRun: async run => {
        try {
          if (run.taskId !== slot.taskId || !await authorizeHarnessTask({ DB: databases.B.connection }, run)) return false;
          return await runOrigin(await active(run.taskId, 'B'), run);
        } catch { return false; }
      },
    }) };
  }
  const preparedBrokers = new Map<string, ReturnType<typeof createBroker>>();
  function brokerFor(slot: ComparisonAdmittedSlot) {
    const existing = preparedBrokers.get(slot.slotId);
    if (existing) return existing;
    const pending = createBroker(slot);
    preparedBrokers.set(slot.slotId, pending);
    void pending.catch(() => { if (preparedBrokers.get(slot.slotId) === pending) preparedBrokers.delete(slot.slotId); });
    return pending;
  }
  for (const slot of slots) {
    for (const route of Object.values(slot.stages)) {
      transports.set(route.transportId, { kind: 'approved-provider', modelContractHash: route.modelContractHash, async open(input) {
        const transport = (await brokerFor(slot)).broker.streamingTransports.get(route.transportId);
        need(transport);
        return transport.open(input);
      } });
    }
  }
  const ledger = await openComparisonLedger({ database: { scope: 'isolated-comparison', ...databases.ledger },
    grant, slots, authorities, streamingTransports: transports, now });
  async function admitEvidence(task: Task) {
    if (task.slot.operation !== 'review') return;
    await sealedEvidence(task);
    await ledger.admitReviewEvidence(authorities.get(task.slot.slotId)!, task.slot.slotId,
      { sourceSha256: task.identity.sourceHash, evidenceSha256: task.identity.evidenceHash! });
  }

  const handle: Handle = async (call, signal) => {
    try {
      need(!signal.aborted);
      if (call.kind === 'profile') {
        const task = await readTask(call.scope.taskId, 'B', 'either');
        const expected = { ...task.seal, grantSha256: runnerHashes.B, authorizationSha256: grant.authorizationSha256, dispatchGrantSha256,
          planSha256: grant.planSha256, manifestSha256: grant.manifestSha256, runnerDatabaseId: databases.B.id, ownerId: task.slot.ownerId,
          operation: task.slot.operation, sourceSha256: task.identity.sourceHash, evidenceSha256: task.identity.evidenceHash,
          modelConfigSha256: task.slot.modelConfigSha256, modelContractHash: task.identity.modelContractHash, deadlineAt: grant.deadlineAt };
        need(same(call.scope, expected) && ['queued', 'running'].includes(task.row.status));
        const locked = await profile(task.slot.operation);
        const released = await releaseRow(task);
        need(task.row.status === 'queued' || released);
        if (task.slot.operation === 'review') await sealedEvidence(task);
        need(!signal.aborted);
        return { scopeSha256: await digest(expected), profileId: locked.profileId, profile: locked.profile };
      }
      const arm = call.kind === 'baseline' ? 'A' : 'B', task = await active(call.scope.taskId, arm, call.scope.stage);
      await admitEvidence(task);
      const broker = await brokerFor(task.slot), capability = authorities.get(task.slot.slotId)!;
      need(!signal.aborted && broker.arm === arm);
      if (call.kind === 'baseline') {
        need(broker.arm === 'A');
        const forward = broker.broker.bind(ledger, capability);
        return await forward(call.scope, call.url, { ...call.init, signal });
      }
      need(broker.arm === 'B');
      const forward = broker.broker.bind(ledger, capability);
      return await forward(new Request(call.request, { signal }), call.scope);
    } catch { return null; }
  };
  return { context, baselineContext, authority, baselineAuthority, handle, nonceDatabase: { scope: 'isolated-comparison' as const, ...databases.nonce } };
}
