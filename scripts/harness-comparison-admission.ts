/** Private, paused admission only. No network, live Runner, or release operation. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planComparison } from './harness-comparison-coordinator';
import { buildComparisonEvidencePack } from './harness-comparison-evidence';
import { openComparisonEvidencePack } from '../server/harness-comparison-evidence';
import { enqueueForgeTask } from '../server/forge-tasks';
import { enqueueReview } from '../server/review-jobs';
import { inputSnapshot, saveArtifact } from '../server/forge-workspace';
import { canonicalHarness, CCB_ENGINE_COMMIT, HARNESS_GAME_LIMITS, modelContractHash, parseHarnessPolicy, type HarnessPolicy } from '../server/harness-policy';
import { getActiveReviewRules, parseReviewRulesSnapshot } from '../server/review-rules';
import { inferenceOptions } from '../src/model-options';
import type { ModelConfig, StoredModelProfile } from '../server/settings';

type Plan = Awaited<ReturnType<typeof planComparison>>;
type Arm = 'A' | 'B';
type DB = { prepare(sql: string): any; batch(statements: any[]): Promise<any[]> };
export type ComparisonAdmissionAdapter = {
  implementationCommit: string;
  enqueueForge: typeof enqueueForgeTask;
  enqueueReview: typeof enqueueReview;
  inputSnapshot: typeof inputSnapshot;
  saveArtifact: typeof saveArtifact;
};
export const currentComparisonAdmissionAdapter = (implementationCommit: string): ComparisonAdmissionAdapter =>
  ({ implementationCommit, enqueueForge: enqueueForgeTask, enqueueReview, inputSnapshot, saveArtifact });

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => canonicalHarness(a) === canonicalHarness(b);
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const now = () => new Date().toISOString();
const schema = [
  `CREATE TABLE IF NOT EXISTS comparison_arm (id INTEGER PRIMARY KEY CHECK(id=1), plan_sha TEXT NOT NULL, arm TEXT NOT NULL, implementation TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS comparison_admissions (task_id TEXT PRIMARY KEY, identity_sha TEXT NOT NULL, identity_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('admitted','paused')), input_sha TEXT, policy_sha TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS comparison_schedule_requests (task_id TEXT PRIMARY KEY REFERENCES comparison_admissions(task_id), requested_at TEXT NOT NULL)`,
];

async function profile(bytes: Buffer): Promise<StoredModelProfile> {
  const value = JSON.parse(bytes.toString('utf8'));
  const keys = ['name', 'baseUrl', 'model', 'protocol', 'enabled', 'vision', 'effort', 'maxOutputTokens', 'updatedAt'];
  assert(value && Object.keys(value).every(key => keys.includes(key)), 'Model snapshot must contain public configuration fields only');
  const url = new URL(value.baseUrl);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    typeof value.model === 'string' && ['anthropic', 'openai'].includes(value.protocol) && value.enabled === true &&
    typeof value.vision === 'boolean', 'Incomplete frozen public model profile');
  // An intentionally invalid, non-secret marker satisfies enqueue's presence check.
  // There is no model transport or real Runner in this environment.
  return { ...value, encryptedKey: 'paused-comparison-no-provider-credential' };
}

export async function openPausedComparison(options: {
  DB: DB; arm: Arm; registry: string; comparisonIndex: string; planDirectory: string;
  scope: 'rehearsal' | 'formal'; adapter: ComparisonAdmissionAdapter;
}) {
  const { DB, arm, adapter } = options;
  assert(arm === 'A' || arm === 'B', 'Invalid comparison arm');
  const prepared = await planComparison({ registry: options.registry, comparisonIndex: options.comparisonIndex,
    out: options.planDirectory, scope: options.scope });
  const plan: Plan['plan'] = structuredClone(prepared.plan);
  assert(adapter.implementationCommit === plan.source[arm].implementationCommit, 'Adapter source does not match the frozen arm');
  const owner = `comparison-${prepared.planSha256.slice(0, 24)}`;
  async function frozenFile(ref: { path: string; sha256: string }) {
    const bytes = await readFile(join(options.registry, ref.path));
    assert(sha(bytes) === ref.sha256, 'Frozen input changed before admission');
    return bytes;
  }
  const [createProfile, reviewProfile, rulesBytes, calibrationBytes] = await Promise.all([
    frozenFile(plan.settings.creationModel.config).then(profile), frozenFile(plan.settings.reviewModel.config).then(profile),
    frozenFile(plan.settings.rules), frozenFile(plan.settings.calibration),
  ]);
  assert(createProfile.model === 'claude-opus-5-5' && createProfile.protocol === 'anthropic' &&
    createProfile.model === plan.settings.creationModel.name && reviewProfile.model === plan.settings.reviewModel.name,
  'Model identity changed');
  assert(createProfile.vision && inferenceOptions(createProfile, 'game', 64_000).maxTokens === 64_000 &&
    inferenceOptions(createProfile, 'game', 64_000).effort === 'high',
  'Frozen creation profile must support visual high and the agreed 64k output cap');
  const rules = parseReviewRulesSnapshot(JSON.parse(rulesBytes.toString('utf8')));
  assert(rules.id === plan.settings.rulesVersion && same(rules.calibrationCases, JSON.parse(calibrationBytes.toString('utf8'))),
    'Rule and calibration snapshots disagree');
  const { schemaVersion: _schema, id: ruleId, contentHash, publishedAt, ...ruleContent } = rules;
  assert(sha(canonicalHarness(ruleContent)) === contentHash, 'Frozen rule content hash mismatch');
  const config = { ...createProfile, activeProfile: 'create', routes: { create: 'create', review: 'review' },
    profiles: { create: createProfile, review: reviewProfile } } satisfies ModelConfig;
  const markerExists = await DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comparison_arm'").first();
  if (!markerExists) {
    for (const table of ['members', 'topics', 'games', 'forge_tasks', 'review_jobs', 'reviews', 'artifact_versions', 'review_rule_versions', 'settings', 'vocab']) {
      assert((await DB.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n === 0,
        'Admission requires a new isolated database; existing application data is forbidden');
    }
    await DB.batch(schema.map(sql => DB.prepare(sql)));
  }
  await DB.prepare('INSERT OR IGNORE INTO comparison_arm VALUES(1,?,?,?)')
    .bind(prepared.planSha256, arm, adapter.implementationCommit).run();
  const binding = await DB.prepare('SELECT * FROM comparison_arm WHERE id=1').first();
  assert(binding.plan_sha === prepared.planSha256 && binding.arm === arm && binding.implementation === adapter.implementationCommit,
    'Research database belongs to another plan or arm');
  const at = now();
  await DB.batch([
    DB.prepare(`INSERT OR IGNORE INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,star)
      VALUES(?,?,?,'no-login','no-login',?,?,1)`).bind(owner, owner, 'Private comparison', at, at),
    DB.prepare('INSERT OR IGNORE INTO review_rule_versions(id,content_hash,snapshot,created_at,published_at) VALUES(?,?,?,?,?)')
      .bind(ruleId, contentHash, JSON.stringify(ruleContent), at, publishedAt),
    DB.prepare('UPDATE review_rule_head SET version_id=? WHERE id=1 AND (version_id IS NULL OR version_id=?)').bind(ruleId, ruleId),
  ]);
  assert(same(await getActiveReviewRules(DB), rules), 'Isolated rules differ from the frozen snapshot');

  // The sole scheduling dependency records durable intent. It has no live binding,
  // queue fallback, cron, model transport, or method that releases paused tasks.
  const recordingRunner = {
    idFromName: (id: string) => id,
    get: (id: unknown) => ({ fetch: async (request: Request) => {
      const task = await request.text();
      assert(task === id && request.method === 'POST', 'Unexpected schedule request');
      assert(await DB.prepare('SELECT 1 FROM comparison_admissions WHERE task_id=?').bind(task).first(), 'Unadmitted schedule request');
      await DB.prepare('INSERT OR IGNORE INTO comparison_schedule_requests VALUES(?,?)').bind(task, now()).run();
      return new Response(null, { status: 202 });
    } }),
  };
  const env = { DB, ownerId: owner, memberMode: true, CREATIVE_V2_ROLLOUT: 'all', ADMIN_PASSWORD: 'not-configured', SETTINGS_KEY: 'not-configured',
    modelStore: { get: async () => structuredClone(config), set: async () => { throw new Error('Frozen model configuration'); } },
    FORGE_RUNNER: recordingRunner, REVIEW_RUNNER: recordingRunner,
    captureReview: async () => { throw new Error('Paused comparison cannot capture or execute'); }, modelExecutor: 'platform' as const };

  async function memberPermission() {
    const member = await DB.prepare('SELECT enabled,star FROM members WHERE id=?').bind(owner).first();
    assert(member?.enabled === 1 && member.star === 1, 'Comparison member is disabled or no longer Star');
    for (const table of ['settings', 'vocab', 'games']) assert((await DB.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n === 0,
      'Unexpected shared material in isolated comparison');
  }
  async function policy(operation: 'creation' | 'review') {
    if (arm === 'A') return null;
    const purpose = operation === 'creation' ? 'game' : 'review';
    const p = operation === 'creation' ? createProfile : reviewProfile;
    const cap = inferenceOptions(p, purpose, purpose === 'game' ? 64_000 : /deepseek/i.test(p.model) ? 24_000 : 16_000).maxTokens;
    return parseHarnessPolicy({ version: 1, engine: 'ccb', engineCommit: CCB_ENGINE_COMMIT, image: plan.settings.harnessImage,
      releaseHash: prepared.planSha256, family: purpose === 'game' ? 'forge' : 'review', purpose,
      modelContractHash: await modelContractHash(config, purpose), limits: purpose === 'game'
        ? { ...HARNESS_GAME_LIMITS, maxOutputTokens: cap }
        : { maxOutputTokens: cap, maxTotalOutputTokens: cap * 2, maxModelTurns: 8, maxDurationMs: 720_000, maxRepairs: 0 },
    });
  }
  function slot(caseId: string, operation: 'creation' | 'review') {
    const selected = plan.slots.find(value => value.caseId === caseId && value.arm === arm && value.operation === operation);
    assert(selected, 'Case or operation outside the frozen plan');
    return selected;
  }
  async function admission(caseId: string, operation: 'creation' | 'review', sourceHash: string, evidenceHash: string | null, packHash: string | null = null) {
    const selected = slot(caseId, operation), harnessPolicy = await policy(operation);
    const identity = { schemaVersion: 1, scope: plan.scope, planSha256: prepared.planSha256, manifestSha256: plan.manifestSha256,
      slot: selected, ownerId: operation === 'creation' ? owner : 'admin', sourceHash, evidenceHash, packHash,
      modelContractHash: await modelContractHash(config, operation === 'creation' ? 'game' : 'review'), harnessPolicy };
    const encoded = canonicalHarness(identity), hash = sha(encoded);
    const existing = await DB.prepare('SELECT * FROM comparison_admissions WHERE task_id=?').bind(selected.taskId).first();
    if (!existing) {
      const table = operation === 'creation' ? 'forge_tasks' : 'review_jobs';
      assert(!await DB.prepare(`SELECT 1 FROM ${table} WHERE id=?`).bind(selected.taskId).first(), 'Preexisting task was not admitted');
      await DB.prepare("INSERT OR IGNORE INTO comparison_admissions VALUES(?,?,?,'admitted',NULL,NULL,?)")
        .bind(selected.taskId, hash, encoded, now()).run();
    }
    const row = await DB.prepare('SELECT * FROM comparison_admissions WHERE task_id=?').bind(selected.taskId).first();
    assert(row.identity_sha === hash && row.identity_json === encoded, 'Conflicting admission identity');
    if (row.state === 'paused') {
      const table = operation === 'creation' ? 'forge_tasks' : 'review_jobs';
      assert(await DB.prepare(`SELECT 1 FROM ${table} WHERE id=? AND owner_id=? AND status='queued'`).bind(selected.taskId, identity.ownerId).first(),
        'Previously paused task is missing or changed; do not recreate it');
    }
    return { selected, identity, hash, harnessPolicy, row };
  }
  async function finish(entry: Awaited<ReturnType<typeof admission>>, row: any, input: unknown) {
    const { selected, identity, harnessPolicy } = entry;
    assert(row?.id === selected.taskId && row.owner_id === identity.ownerId && row.status === 'queued' &&
      (selected.operation === 'creation' ? row.executor === 'platform' && row.kind === 'game' && row.creative_version === 2 && row.model_started_at === null
        : row.executor === 'cloud' && row.model_executor === 'platform' && row.input_ready === 1 && row.report_schema_version === 2 && row.review_mode === 'basic'),
    'Task identity, source or paused state changed');
    const inputHash = sha(canonicalHarness(input)), policyHash = sha(canonicalHarness(harnessPolicy));
    if (entry.row.state === 'paused') assert(entry.row.input_sha === inputHash && entry.row.policy_sha === policyHash, 'Paused material changed');
    if (harnessPolicy) {
      const table = selected.operation === 'creation' ? 'forge_tasks' : 'review_jobs';
      assert(!row.harness_policy || same(parseHarnessPolicy(row.harness_policy), harnessPolicy), 'Task has another engine policy');
      if (entry.row.state === 'paused') assert(row.harness_policy, 'Previously paused task lost its engine policy');
      else await DB.prepare(`UPDATE ${table} SET harness_policy=? WHERE id=? AND owner_id=? AND status='queued' AND harness_policy IS NULL`)
          .bind(JSON.stringify(harnessPolicy), selected.taskId, identity.ownerId).run();
      const saved = await DB.prepare(`SELECT harness_policy FROM ${table} WHERE id=?`).bind(selected.taskId).first();
      assert(same(parseHarnessPolicy(saved.harness_policy), harnessPolicy), 'Research policy was not persisted');
    } else assert(!row.harness_policy, 'Baseline task must not use Harness');
    const table = selected.operation === 'creation' ? 'forge_tasks' : 'review_jobs';
    const neverStarted = selected.operation === 'creation' ? 'model_started_at IS NULL' : 'model_started_at IS NULL AND model_execution_started_at IS NULL';
    const stillQueued = `EXISTS(SELECT 1 FROM ${table} WHERE id=comparison_admissions.task_id AND owner_id=? AND status='queued' AND ${neverStarted})`;
    await DB.prepare(`UPDATE comparison_admissions SET state='paused',input_sha=?,policy_sha=? WHERE task_id=? AND identity_sha=? AND state='admitted' AND ${stillQueued}`)
      .bind(inputHash, policyHash, selected.taskId, entry.hash, identity.ownerId).run();
    const saved = await DB.prepare('SELECT * FROM comparison_admissions WHERE task_id=?').bind(selected.taskId).first();
    assert(saved?.state === 'paused' && saved.identity_sha === entry.hash && saved.input_sha === inputHash && saved.policy_sha === policyHash,
      'Paused admission persistence is unverified');
    assert(await DB.prepare(`SELECT 1 FROM ${table} WHERE id=? AND owner_id=? AND status='queued' AND ${neverStarted}`)
      .bind(selected.taskId, identity.ownerId).first(), 'Paused task changed during admission');
    return { taskId: selected.taskId, arm, operation: selected.operation, sourceHash: identity.sourceHash, evidenceHash: identity.evidenceHash,
      inputHash, policyHash, evidencePackHash: identity.packHash, state: 'paused' as const, policyProvenance: 'isolated-research-plan',
      executionAllowed: false, sourceProvenance: 'adapter-declared-requires-independent-source-verification', providerCalls: 0, liveDispatches: 0 };
  }
  // Serialize local admissions so a partial seed/response can be reconciled by the
  // same identity. SQLite keys remain the duplicate boundary across restarts.
  let pending = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation); pending = result.then(() => {}, () => {}); return result;
  }
  async function create(caseId: string) {
    await memberPermission();
    const item = plan.cases.find(value => value.id === caseId); assert(item, 'Unknown case');
    const files = Object.fromEntries(await Promise.all(item.materials.map(async ref => {
      const bytes = await frozenFile(ref); return [ref.path.split('/').at(-1)!, bytes.toString('utf8')];
    })));
    const entry = await admission(caseId, 'creation', item.materialSha256, null);
    const topicId = plan.cases.findIndex(value => value.id === caseId) + 1;
    const active = await DB.prepare("SELECT id FROM forge_tasks WHERE scope=? AND status IN ('queued','running')")
      .bind(`${owner}:game:${topicId}`).first();
    assert(!active || active.id === entry.selected.taskId, 'Another active task owns the comparison scope');
    await DB.prepare(`INSERT OR IGNORE INTO topics(id,owner_id,batch,subject,medium,gesture,structure,mood,created_at,updated_at,creative_version)
      VALUES(?,?,'comparison',?,'frozen','frozen','frozen','frozen',?,?,2)`).bind(topicId, owner, caseId, now(), now()).run();
    for (const [kind, name] of [['brief','brief.md'], ['preview','sample.svg'], ['assets','assets.html']] as const) {
      const topic = await DB.prepare('SELECT * FROM topics WHERE id=? AND owner_id=?').bind(topicId, owner).first();
      assert(topic?.subject === caseId && topic.creative_version === 2 && topic.data === '{}' && topic.requirements === '' &&
        topic.batch === 'comparison' && ['medium','gesture','structure','mood'].every(key => topic[key] === 'frozen'), 'Comparison topic identity changed');
      const seeded = await adapter.saveArtifact(DB, { owner, topicId, kind, content: files[name], revision: topic.content_revision,
        taskId: `comparison-seed:${entry.selected.taskId}:${kind}`, executor: 'platform' });
      assert(seeded.content === files[name] && seeded.owner_id === owner && seeded.topic_id === topicId, 'Seeded version conflicts');
      const head = await DB.prepare('SELECT version_id FROM artifact_heads WHERE topic_id=? AND kind=?').bind(topicId, kind).first();
      assert(head?.version_id === seeded.id && seeded.kind === kind && seeded.disposition === 'current', 'Comparison artifact head changed');
    }
    const job = { type: 'game' as const, id: topicId, requestId: entry.selected.taskId, creative_version: 2 as const };
    const before = await adapter.inputSnapshot(DB, owner, job);
    assert(before.topic.brief_md === files['brief.md'] && before.topic.preview_svg === files['sample.svg'] && before.topic.assets_html === files['assets.html'],
      'Current input heads differ from the frozen materials');
    assert(same(before.games, []) && same(before.prior, []) && same(before.vocab, []),
      'Pre-admit all creation cases before execution; previous case outputs must not enter another context');
    let row = await DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(entry.selected.taskId).first();
    if (!row) {
      await adapter.enqueueForge(env, job, entry.selected.taskId);
      row = await DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(entry.selected.taskId).first();
    }
    const snapshot = JSON.parse(row.input_snapshot);
    assert(row.scope === `${owner}:game:${topicId}` && same(JSON.parse(row.payload), job) && snapshot.topic.id === topicId &&
      same(snapshot.topic.data, {}) && snapshot.topic.requirements === '' && snapshot.topic.subject === caseId &&
      same(snapshot.cfg, before.cfg) && same(snapshot.games, []) && same(snapshot.prior, []) && same(snapshot.vocab, []), 'Queued task context changed');
    // Status fields are changed by enqueue; immutable content, heads and policy
    // revisions must still agree. The saved snapshot itself is hashed in full.
    assert(snapshot.topic.brief_md === files['brief.md'] && snapshot.topic.preview_svg === files['sample.svg'] &&
      snapshot.topic.assets_html === files['assets.html'] && snapshot.topic.owner_id === owner &&
      same(snapshot.heads, before.heads) && snapshot.revision === before.revision && snapshot.policy_revision === before.policy_revision,
    'Queued snapshot no longer matches frozen material');
    if (!await DB.prepare('SELECT 1 FROM comparison_schedule_requests WHERE task_id=?').bind(row.id).first()) {
      await recordingRunner.get(row.id).fetch(new Request('https://internal/start', { method: 'POST', body: row.id }));
    }
    await memberPermission();
    return finish(entry, row, snapshot);
  }
  async function review(caseId: string) {
    slot(caseId, 'review');
    const pack = await buildComparisonEvidencePack(options.registry, options.comparisonIndex, caseId);
    assert(pack.identity.manifestSha256 === plan.manifestSha256, 'Evidence belongs to another manifest');
    const captured = await openComparisonEvidencePack(pack.serialized, pack.identity);
    const inputHash = sha(captured.html);
    const entry = await admission(caseId, 'review', inputHash, pack.identity.evidenceSha256, pack.identity.packSha256);
    assert(same(await getActiveReviewRules(DB), rules), 'Review rules changed after admission opened');
    let row = await DB.prepare('SELECT * FROM review_jobs WHERE id=?').bind(entry.selected.taskId).first();
    if (!row) {
      await adapter.enqueueReview(env, { request_id: entry.selected.taskId, title: caseId, filename: `${caseId}.html`,
        html: captured.html, review_mode: 'basic' }, 'admin');
      row = await DB.prepare('SELECT * FROM review_jobs WHERE id=?').bind(entry.selected.taskId).first();
    }
    assert(row.owner_id === 'admin' && row.status === 'queued' && row.executor === 'cloud' && row.model_executor === 'platform' &&
      row.model_started_at === null && row.model_execution_started_at === null && row.title === caseId && row.filename === `${caseId}.html` && row.topic_id === null &&
      row.review_mode === 'basic' && row.report_schema_version === 2 && row.input_hash === inputHash && same(JSON.parse(row.rules_snapshot), rules),
    'Review input or rules conflict');
    if (!row.input_ready) {
      assert(entry.row.state === 'admitted', 'Previously paused review lost its input');
      const condition = "EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND owner_id='admin' AND status='queued' AND input_ready=0 AND model_started_at IS NULL AND model_execution_started_at IS NULL AND input_hash=?)";
      const statements = [DB.prepare(`DELETE FROM review_inputs WHERE job_id=? AND ${condition}`).bind(row.id, row.id, inputHash)];
      const text = JSON.stringify({ html: captured.html, title: caseId, topic_id: null });
      let part = 0;
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + 120_000, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        statements.push(DB.prepare(`INSERT INTO review_inputs(job_id,part,data,created_at) SELECT ?,?,?,? WHERE ${condition}`)
          .bind(row.id, part++, text.slice(offset, end), now(), row.id, inputHash)); offset = end;
      }
      statements.push(DB.prepare(`UPDATE review_jobs SET input_ready=1 WHERE id=? AND ${condition}`).bind(row.id, row.id, inputHash));
      await DB.batch(statements);
      row = await DB.prepare('SELECT * FROM review_jobs WHERE id=?').bind(row.id).first();
    }
    const chunks = (await DB.prepare('SELECT part,data FROM review_inputs WHERE job_id=? ORDER BY part').bind(entry.selected.taskId).all()).results;
    assert(chunks.every((chunk: { part: number }, index: number) => chunk.part === index), 'Queued review parts are not contiguous');
    assert(same(JSON.parse(chunks.map((chunk: { data: string }) => chunk.data).join('')),
      { html: captured.html, title: caseId, topic_id: null }), 'Queued review input changed');
    if (!await DB.prepare('SELECT 1 FROM comparison_schedule_requests WHERE task_id=?').bind(row.id).first()) {
      await recordingRunner.get(row.id).fetch(new Request('https://internal/start', { method: 'POST', body: row.id }));
    }
    return finish(entry, row, { inputHash, rulesSnapshot: rules, evidenceSha256: pack.identity.evidenceSha256, packSha256: pack.identity.packSha256 });
  }
  return { planSha256: prepared.planSha256, ownerId: owner, scope: plan.scope, executionAllowed: false as const,
    admitCreation: (caseId: string) => serial(() => create(caseId)),
    admitReview: (caseId: string) => serial(() => review(caseId)),
  };
}
