import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openComparisonTaskControl, type ComparisonRunnerGrant } from '../server/harness-comparison-runner';
import { cloudReviewAlarm } from '../server/cloud-review-runner';
import { creationPipelineAlarm } from '../server/forge-creation-pipeline';
import { prepareReview } from '../server/forge-api';
import { canonicalHarness, CCB_ENGINE_COMMIT, HARNESS_GAME_LIMITS, modelContractHash } from '../server/harness-policy';
import { encryptKey, type ModelConfig } from '../server/settings';

const databases: DatabaseSync[] = [];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonicalSha = (value: unknown) => sha(canonicalHarness(value));
const image = `registry.cloudflare.com/${'a'.repeat(32)}/research@sha256:${'b'.repeat(64)}`;
const implementationCommit = 'c'.repeat(40);
const manifestSha256 = 'd'.repeat(64), runtimeTreeSha256 = 'e'.repeat(64), authorizationSha256 = 'f'.repeat(64);
const time = 1_800_000_000_000, clock = new Date(time).toISOString();
const ownerlessCase = 'tap-rhythm';
const html = '<!doctype html><title>Exact B product</title>';
const creationPublic = { model: 'claude-opus-5-5', protocol: 'anthropic' as const, baseUrl: 'https://riffle-api.pages.dev',
  enabled: true, vision: true, effort: 'high' as const, maxOutputTokens: 0, updatedAt: clock };
const reviewPublic = { model: 'deepseek-flash', protocol: 'openai' as const, baseUrl: 'https://api.deepseek.com',
  enabled: true, vision: true, effort: 'low' as const, maxOutputTokens: 0, updatedAt: clock };

let fetchTrap: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchTrap = vi.fn(() => { throw new Error('Formal release unit test has no network'); });
  vi.stubGlobal('fetch', fetchTrap);
});
afterEach(() => {
  expect(fetchTrap).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

function fixtureState() {
  const values = new Map<string, unknown>();
  return { storage: {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async deleteAll() { values.clear(); },
    async deleteAlarm() {},
  } };
}
function database() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${name}`, 'utf8'));
  }
  sqlite.exec(`CREATE TABLE comparison_arm(id INTEGER PRIMARY KEY,plan_sha TEXT,arm TEXT,implementation TEXT);
    CREATE TABLE comparison_admissions(task_id TEXT PRIMARY KEY,identity_sha TEXT,identity_json TEXT,state TEXT,input_sha TEXT,policy_sha TEXT,created_at TEXT);
    CREATE TABLE comparison_schedule_requests(task_id TEXT PRIMARY KEY,requested_at TEXT);`);
  const DB = { prepare(sql: string) {
    const stmt = sqlite.prepare(sql);
    function statement(values: SQLInputValue[] = []) {
      return {
        bind: (...next: SQLInputValue[]) => statement(next),
        first: async <T>() => (stmt.get(...values) as T | undefined) ?? null,
        all: async <T>() => ({ results: stmt.all(...values) as T[] }),
        run: async () => stmt.run(...values),
      };
    }
    return statement();
  }, async batch(statements: { run(): Promise<unknown> }[]) {
    sqlite.exec('BEGIN');
    try { const result = await Promise.all(statements.map(statement => statement.run())); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, DB };
}

function evidence(duplicateFirstShot: boolean) {
  const observations = [
    ['9:16 首次触摸后约 10 秒', 'baseline-9:16-tap'], ['9:19.5 首次触摸前'],
    ['9:19.5 首次触摸后约 3 秒', 'baseline-9:19.5-tap'], ['9:21 首次触摸后约 10 秒', 'baseline-9:21-tap'],
  ].map(([label, ...actionRefs], index) => ({ id: `baseline-${index + 1}`, label, actionRefs, capturedAt: clock }));
  const probe = JSON.stringify({ captureMethod: 'browser-viewport-v1', observations }, null, 2);
  const shots = observations.map((item, index) => {
    const bytes = Buffer.from([255, 216, 255, duplicateFirstShot && index === 1 ? 0 : index]);
    return { id: item.id, sha256: sha(bytes), data: `data:image/jpeg;base64,${bytes.toString('base64')}` };
  });
  const evidenceSha256 = sha(JSON.stringify({ html: sha(html), probe: sha(probe), shots: shots.map(shot => shot.sha256) }, null, 2) + '\n');
  const packed = JSON.stringify({ schemaVersion: 1, caseId: ownerlessCase, manifestSha256, evidenceSha256, captureOrigin: 'isolated-chromium',
    html: { text: html, sha256: sha(html) }, probe: { json: probe, sha256: sha(probe) }, shots });
  return { evidenceSha256, packed, packSha256: sha(packed), shots };
}

async function setup(duplicateFirstShot = false) {
  const { sqlite, DB } = database(), authority = {};
  const ruleContent = { sourceUrl: 'https://creator-hub-7mi.pages.dev/#/', capturedAt: clock,
    rawDirection: 'Synthetic directions', rawScoring: 'Synthetic scoring', scoreMin: 0, scoreMax: 3, passScore: 7, notes: '', calibrationCases: [] };
  const rules = { schemaVersion: 2, id: 'synthetic-rules', contentHash: canonicalSha(ruleContent), publishedAt: clock, ...ruleContent };
  const frozenBytes = new Map([JSON.stringify(creationPublic), JSON.stringify(reviewPublic), JSON.stringify(rules), '[]']
    .map(bytes => [sha(bytes), bytes]));
  const names = ['brief.md', 'sample.svg', 'assets.html'];
  const sources = ['brief', 'svg', 'assets'];
  const cases = [ownerlessCase, 'second', 'third', 'fourth', 'fifth', 'sixth'].map(caseId => ({ id: caseId,
    materialSha256: canonicalSha(sources), materials: names.map((name, index) => ({ path: `materials/${caseId}/${name}`, sha256: sha(sources[index]) })) }));
  const slotId = (n: number) => '00000000-0000-8000-8000-' + String(n).padStart(12, '0');
  const slots = cases.flatMap((entry, index) => [
    { caseId: entry.id, arm: 'A', operation: 'creation', taskId: slotId(index * 4), materialSha256: entry.materialSha256,
      modelConfigSha256: sha(JSON.stringify(creationPublic)) },
    { caseId: entry.id, arm: 'B', operation: 'creation', taskId: slotId(index * 4 + 1), materialSha256: entry.materialSha256,
      modelConfigSha256: sha(JSON.stringify(creationPublic)) },
    ...['A', 'B'].map((arm, offset) => ({ caseId: entry.id, arm, operation: 'review', taskId: slotId(index * 4 + 2 + offset),
      modelConfigSha256: sha(JSON.stringify(reviewPublic)), rulesSha256: sha(JSON.stringify(rules)), calibrationSha256: sha('[]'),
      requires: { creationTaskId: slotId(index * 4 + 1) } })),
  ]);
  const plan = { schemaVersion: 1, scope: 'formal', executionAllowed: false, manifestSha256,
    source: { B: { implementationCommit, engineCommit: CCB_ENGINE_COMMIT, image } }, slots, cases };
  const planBytes = JSON.stringify(plan), planSha256 = sha(planBytes);
  const grant: ComparisonRunnerGrant = { schemaVersion: 1, purpose: 'isolated-comparison', scope: 'formal', authorizationSha256,
    dispatchGrantSha256: '1'.repeat(64), planSha256, manifestSha256, runnerDatabaseId: 'isolated-b', maxRequests: 60, maxOutputTokens: 1_000_000,
    notBefore: time - 1, deadlineAt: time + 60_000, implementationCommit, runtimeTreeSha256, image };
  const owner = `comparison-${planSha256.slice(0, 24)}`;
  sqlite.prepare('INSERT INTO comparison_arm VALUES(1,?,?,?)').run(planSha256, 'B', implementationCommit);
  sqlite.prepare(`INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,star)
    VALUES(?,?,?,'synthetic','synthetic',?,?,1)`).run(owner, owner, owner, clock, clock);
  const topic = { id: 1, owner_id: owner, subject: ownerlessCase, brief_md: sources[0], preview_svg: sources[1], assets_html: sources[2] };
  const snapshot = { topic, heads: {}, revision: 0, policy_revision: 0, creative_version: 2 };
  const profileA = { ...creationPublic, encryptedKey: await encryptKey('synthetic-ciphertext', 'synthetic-settings') };
  const profileB = { ...reviewPublic, encryptedKey: await encryptKey('synthetic-ciphertext', 'synthetic-settings') };
  const configFor = (profile: typeof profileA | typeof profileB): ModelConfig =>
    ({ ...profile, activeProfile: 'isolated-profile', profiles: { 'isolated-profile': profile } });
  const game = slots[1], review = slots[3], material = evidence(duplicateFirstShot);
  const policy = async (creation: boolean) => ({ version: 1, engine: 'ccb', engineCommit: CCB_ENGINE_COMMIT, image,
    releaseHash: planSha256, family: creation ? 'forge' : 'review', purpose: creation ? 'game' : 'review',
    modelContractHash: await modelContractHash(configFor(creation ? profileA : profileB), creation ? 'game' : 'review'),
    limits: creation ? HARNESS_GAME_LIMITS : { maxOutputTokens: 24_000, maxTotalOutputTokens: 48_000, maxModelTurns: 8,
      maxDurationMs: 720_000, maxRepairs: 0 } });
  const gamePolicy = await policy(true), reviewPolicy = await policy(false);

  function paused(slot: typeof game, harnessPolicy: typeof gamePolicy, sourceHash: string, evidenceHash: string | null,
    packHash: string | null, taskOwner: string, inputSha256: string) {
    const identity = canonicalHarness({ schemaVersion: 1, scope: 'formal', planSha256, manifestSha256, slot, ownerId: taskOwner,
      sourceHash, evidenceHash, packHash, modelContractHash: harnessPolicy.modelContractHash, harnessPolicy });
    const admissionSha256 = sha(identity), policySha256 = canonicalSha(harnessPolicy);
    sqlite.prepare("INSERT INTO comparison_admissions VALUES(?,?,?,'paused',?,?,?)")
      .run(slot.taskId, admissionSha256, identity, inputSha256, policySha256, clock);
    sqlite.prepare('INSERT INTO comparison_schedule_requests VALUES(?,?)').run(slot.taskId, clock);
    return { taskId: slot.taskId, slotSha256: canonicalSha(slot), admissionSha256, inputSha256, policySha256 };
  }
  sqlite.prepare(`INSERT INTO forge_tasks(id,owner_id,kind,scope,executor,status,payload,input_snapshot,harness_policy,creative_version,created_at,updated_at)
    VALUES(?,?,'game',?,'platform','queued',?,?,?,2,?,?)`).run(game.taskId, owner, `${owner}:game:1`,
      JSON.stringify({ type: 'game', id: 1, requestId: game.taskId, creative_version: 2 }), JSON.stringify(snapshot), JSON.stringify(gamePolicy), clock, clock);
  const gameSeal = paused(game, gamePolicy, cases[0].materialSha256, null, null, owner, canonicalSha(snapshot));
  sqlite.prepare(`INSERT INTO review_jobs(id,owner_id,title,filename,usage_day,created_at,updated_at,status,stage,executor,model_executor,input_ready,
    input_hash,rules_snapshot,report_schema_version,review_mode,harness_policy)
    VALUES(?,'admin',?,?,'2026-11-06',?,?,'queued','capture','cloud','platform',1,?,?,2,'basic',?)`)
    .run(review.taskId, ownerlessCase, `${ownerlessCase}.html`, clock, clock, sha(html), JSON.stringify(rules), JSON.stringify(reviewPolicy));
  sqlite.prepare('INSERT INTO review_inputs(job_id,part,data,created_at) VALUES(?,0,?,?)')
    .run(review.taskId, JSON.stringify({ html, title: ownerlessCase, topic_id: null }), clock);
  const reviewSeal = paused(review, reviewPolicy, sha(html), material.evidenceSha256, material.packSha256, 'admin',
    canonicalSha({ inputHash: sha(html), rulesSnapshot: rules, evidenceSha256: material.evidenceSha256, packSha256: material.packSha256 }));
  const brokerFetch = vi.fn();
  let brokerProfile = profileA;
  const broker = vi.fn(async (scope: Parameters<NonNullable<Parameters<typeof openComparisonTaskControl>[0]['bindVerifiedBroker']>>[0]) =>
    ({ scopeSha256: canonicalSha(scope), profileId: 'isolated-profile',
      profile: scope.operation === 'creation' ? brokerProfile : profileB,
      harnessRunner: { idFromName: (name: string) => name, get: () => ({ fetch: brokerFetch }) } }));
  const alarms = { creation: vi.fn<NonNullable<Parameters<typeof openComparisonTaskControl>[0]['alarms']>['creation']>(),
    review: vi.fn<NonNullable<Parameters<typeof openComparisonTaskControl>[0]['alarms']>['review']>() };
  let current = time, packed = material.packed;
  const options = { authority, database: { scope: 'isolated-comparison' as const, id: 'isolated-b', connection: DB },
    grant, runtime: { implementationCommit, runtimeTreeSha256, image }, planBytes,
    loadFrozenInput: async (hash: string) => frozenBytes.get(hash)!, loadEvidencePack: async () => packed,
    bindVerifiedBroker: broker, failedHarnessRunner: { idFromName: (id: string) => id, get: () => ({ fetch: brokerFetch }) },
    alarms, captureCreation: vi.fn(), now: () => current };
  const control = await openComparisonTaskControl(options);
  function completeCreation() {
    sqlite.prepare("UPDATE forge_tasks SET status='done',result=? WHERE id=?")
      .run(JSON.stringify({ content_hash: sha(html), version_id: 'sealed-version' }), game.taskId);
    sqlite.prepare(`INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,task_id,input_revision,executor,disposition,created_at)
      VALUES('sealed-version',?,1,'game',?,?,0,'platform','current',?)`).run(owner, html, game.taskId, clock);
  }
  return { sqlite, control, options, authority, gameSeal, reviewSeal, material, snapshot, rules, alarms, broker, brokerFetch, completeCreation,
    setNow: (value: number) => { current = value; }, setPack: (value: string) => { packed = value; },
    rotate: async () => { brokerProfile = { ...brokerProfile, encryptedKey: await encryptKey('changed-marker', 'synthetic-settings') }; },
  };
}

test('exact queued creation release is write-once and resumes only its own matching checkpoint', async () => {
  const s = await setup(), state = fixtureState();
  const task = s.control.bindTask(s.authority, s.gameSeal.taskId, state);
  await expect(task.alarm()).rejects.toThrow();
  const release = await s.control.release(s.authority, s.gameSeal);
  expect(await s.control.release(s.authority, s.gameSeal)).toEqual(release);
  expect(s.sqlite.prepare('SELECT status FROM forge_tasks').get()).toEqual({ status: 'queued' });
  expect(JSON.stringify(release)).not.toMatch(/profile|encrypted/i);
  s.alarms.creation.mockImplementationOnce(async (runner, env, id) => {
    expect(env.SETTINGS_KEY).toBe('');
    expect(() => env.HARNESS_RUNNER.idFromName('other-task')).toThrow(/verified scope/);
    const config = await env.modelStore.get();
    s.sqlite.prepare("UPDATE forge_tasks SET status='running' WHERE id=?").run(id);
    await runner.storage.put('creationParts', 1);
    await runner.storage.put('creation:0', JSON.stringify({ snapshot: s.snapshot, config }));
  });
  await expect(task.alarm()).resolves.toEqual({ state: 'invoked', taskId: s.gameSeal.taskId });
  await expect(s.control.bindTask(s.authority, s.gameSeal.taskId, fixtureState()).alarm()).rejects.toThrow(/foreign/);
  await expect(task.alarm()).resolves.toEqual({ state: 'invoked', taskId: s.gameSeal.taskId });
  const checkpoint = JSON.parse((await state.storage.get<string>('creation:0'))!);
  checkpoint.snapshot.topic.brief_md = 'changed';
  await state.storage.put('creation:0', JSON.stringify(checkpoint));
  await expect(task.alarm()).rejects.toThrow(/checkpoint source/);
  expect(s.alarms.creation).toHaveBeenCalledTimes(2);
  expect(s.brokerFetch).not.toHaveBeenCalled();
});

test('rejects foreign authority, slot, production marker, queued mutation, expiry and unavailable broker', async () => {
  const s = await setup();
  await expect(s.control.release({}, s.gameSeal)).rejects.toThrow(/authority/);
  await expect(s.control.release(s.authority, { ...s.gameSeal, taskId: '00000000-0000-8000-8000-000000000000' }))
    .rejects.toThrow(/frozen B/);
  await expect(s.control.release(s.authority, { ...s.gameSeal, admissionSha256: '0'.repeat(64) })).rejects.toThrow(/admission/);
  await expect(openComparisonTaskControl({ ...s.options, planBytes: s.options.planBytes + '\n' })).rejects.toThrow(/plan digest/);
  await expect(openComparisonTaskControl({ ...s.options, runtime: { ...s.options.runtime, runtimeTreeSha256: '0'.repeat(64) } }))
    .rejects.toThrow(/runtime attestation/);
  await expect(openComparisonTaskControl({ ...s.options, database: { ...s.options.database, id: 'production' } }))
    .rejects.toThrow(/isolated comparison/);
  const noBroker = await openComparisonTaskControl({ ...s.options, bindVerifiedBroker: undefined });
  await expect(noBroker.release(s.authority, s.gameSeal)).rejects.toThrow(/broker is unavailable/);
  s.sqlite.exec("UPDATE comparison_arm SET arm='A'");
  await expect(s.control.release(s.authority, s.gameSeal)).rejects.toThrow(/database marker/);
  s.sqlite.exec("UPDATE comparison_arm SET arm='B'");
  s.sqlite.exec("UPDATE forge_tasks SET owner_id='another'");
  await expect(s.control.release(s.authority, s.gameSeal)).rejects.toThrow(/owner/);
  s.sqlite.prepare('UPDATE forge_tasks SET owner_id=?,input_snapshot=?').run(s.snapshot.topic.owner_id,
    JSON.stringify({ ...s.snapshot, topic: { ...s.snapshot.topic, brief_md: 'tampered' } }));
  await expect(s.control.release(s.authority, s.gameSeal)).rejects.toThrow(/snapshot drifted/);
  s.setNow(s.options.grant.deadlineAt);
  await expect(s.control.release(s.authority, s.gameSeal)).rejects.toThrow(/execution window/);
  expect(s.broker).not.toHaveBeenCalled();
  expect(s.alarms.creation).not.toHaveBeenCalled();
});

test('release cannot outlive a broker profile change or be consumed concurrently by another alarm', async () => {
  const s = await setup(), state = fixtureState();
  await s.control.release(s.authority, s.gameSeal);
  const task = s.control.bindTask(s.authority, s.gameSeal.taskId, state);
  let entered!: () => void, complete!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  s.alarms.creation.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { complete = resolve; }); });
  const pending = task.alarm();
  await entering;
  await expect(task.alarm()).rejects.toThrow(/already running/);
  complete();
  await pending;
  await s.rotate();
  await expect(task.alarm()).rejects.toThrow(/profile changed/);
  expect(s.alarms.creation).toHaveBeenCalledTimes(1);
});


test('the release CAS refuses a task changed while obtaining the scoped broker', async () => {
  const s = await setup();
  const original = s.broker.getMockImplementation()!;
  s.broker.mockImplementationOnce(async scope => {
    const binding = await original(scope);
    s.sqlite.exec("UPDATE forge_tasks SET model_started_at='already-started'");
    return binding;
  });
  await expect(s.control.release(s.authority, s.gameSeal)).rejects.toThrow(/release CAS/);
  expect(s.sqlite.prepare('SELECT COUNT(*) AS count FROM comparison_execution_releases').get()).toEqual({ count: 0 });
  expect(s.alarms.creation).not.toHaveBeenCalled();
});

test('review requires the released B result and uses only exact sealed original evidence', async () => {
  const s = await setup();
  await s.control.release(s.authority, s.gameSeal);
  await expect(s.control.release(s.authority, s.reviewSeal)).rejects.toThrow(/completed B artifact/);
  s.completeCreation();
  s.setPack(s.material.packed + '\n');
  await expect(s.control.release(s.authority, s.reviewSeal)).rejects.toThrow(/package SHA-256/);
  s.setPack(s.material.packed);
  const release = await s.control.release(s.authority, s.reviewSeal);
  expect(release.taskId).toBe(s.reviewSeal.taskId);
  s.alarms.review.mockImplementationOnce(async (_state, env) => {
    const captured = await env.captureReview(html) as { shots: { data: string }[] };
    expect(captured.shots.map(shot => shot.data)).toEqual(s.material.shots.map(shot => shot.data));
    await expect(Promise.resolve().then(() => env.captureReview('changed HTML'))).rejects.toThrow(/locked comparison input/);
  });
  const task = s.control.bindTask(s.authority, s.reviewSeal.taskId, fixtureState());
  await expect(task.alarm()).resolves.toEqual({ state: 'invoked', taskId: s.reviewSeal.taskId });
  s.sqlite.exec("UPDATE artifact_versions SET content='tampered'");
  await expect(task.alarm()).rejects.toThrow(/artifact version drifted/);
  expect(s.alarms.review).toHaveBeenCalledTimes(1);
  expect(s.brokerFetch).not.toHaveBeenCalled();
});


test('review recovery checks durable evidence and model profile even when two ordered images are identical', async () => {
  const s = await setup(true), state = fixtureState();
  await s.control.release(s.authority, s.gameSeal);
  s.completeCreation();
  await s.control.release(s.authority, s.reviewSeal);
  const task = s.control.bindTask(s.authority, s.reviewSeal.taskId, state);
  s.alarms.review.mockImplementationOnce(async (runner, env, id) => {
    const evidence = await env.captureReview(html) as { shots: unknown[]; probe: unknown };
    const config = await env.modelStore.get();
    const { images, ...expected } = await prepareReview({ ...env, ownerId: 'admin', modelExecutor: 'platform' }, {
      html, title: ownerlessCase, ...evidence, rulesSnapshot: s.rules as Parameters<typeof prepareReview>[1]['rulesSnapshot'], reportSchemaVersion: 2,
    });
    const request = { ...expected, user: expected.user.map(({ data, ...part }) =>
      part.type === 'image' ? { ...part, imageIndex: images.findIndex(image => image.data === data) } : part) };
    expect(request.user.flatMap(part => 'imageIndex' in part ? [part.imageIndex] : [])).toEqual([0, 0, 2, 3]);
    await runner.storage.put('cloudPhase', 'draft-ready');
    await runner.storage.put('cloudCheckpointVersion', 2);
    await runner.storage.put('cloudStateParts', 1);
    await runner.storage.put('cloudState:0', JSON.stringify({ version: 2, materialRef: 'same-evidence' }));
    await runner.storage.put('cloudImmutable:same-evidenceParts', 1);
    await runner.storage.put('cloudImmutable:same-evidence:0', JSON.stringify({ images, probe: evidence.probe, config, request, title: ownerlessCase, topic_id: null }));
    s.sqlite.prepare("UPDATE review_jobs SET status='running',model_started_at=? WHERE id=?").run(clock, id);
  });
  await expect(task.alarm()).resolves.toEqual({ state: 'invoked', taskId: s.reviewSeal.taskId });
  await expect(task.alarm()).resolves.toEqual({ state: 'invoked', taskId: s.reviewSeal.taskId });
  const checkpoint = JSON.parse((await state.storage.get<string>('cloudImmutable:same-evidence:0'))!);
  await state.storage.put('cloudImmutable:same-evidence:0', JSON.stringify({ ...checkpoint, topic_id: 9 }));
  await expect(task.alarm()).rejects.toThrow(/checkpoint identity drifted/);
  await state.storage.put('cloudImmutable:same-evidence:0', JSON.stringify({
    ...checkpoint, request: { ...checkpoint.request, system: 'tampered rules' },
  }));
  await expect(task.alarm()).rejects.toThrow(/checkpoint source or rules drifted/);
  checkpoint.images.reverse();
  await state.storage.put('cloudImmutable:same-evidence:0', JSON.stringify(checkpoint));
  await expect(task.alarm()).rejects.toThrow(/checkpoint evidence drifted/);
  expect(s.alarms.review).toHaveBeenCalledTimes(2);
});


test.each(['creation', 'review'] as const)('%s missing checkpoint recovers pre-model and stops unknown after model start', async operation => {
  const s = await setup(), state = fixtureState();
  const seal = operation === 'creation' ? s.gameSeal : s.reviewSeal;
  const table = operation === 'creation' ? 'forge_tasks' : 'review_jobs';
  await s.control.release(s.authority, s.gameSeal);
  if (operation === 'review') {
    s.completeCreation();
    await s.control.release(s.authority, s.reviewSeal);
  }
  const task = s.control.bindTask(s.authority, seal.taskId, state);
  s.alarms[operation].mockImplementationOnce(async (_state, _env, id) => {
    s.sqlite.prepare(`UPDATE ${table} SET status='running' WHERE id=?`).run(id);
  });
  await task.alarm();
  s.alarms[operation].mockImplementationOnce(async (_state, env) => {
    // With no provider start marker, the existing runner can recapture.
    expect(env.HARNESS_RUNNER.get(seal.taskId).fetch).toBe(s.brokerFetch);
  });
  await task.alarm();
  s.sqlite.prepare(`UPDATE ${table} SET model_started_at=? WHERE id=?`).run(clock, seal.taskId);
  s.brokerFetch.mockResolvedValue(new Response(null, { status: 200 }));
  s.broker.mockClear();
  s.alarms[operation].mockImplementationOnce(async (runner, env, id) => {
    expect((await env.HARNESS_RUNNER.get(id).fetch(new Request('http://harness/start', { method: 'POST' }))).status).toBe(403);
    await expect(env.modelStore.get()).rejects.toThrow(/blocked/);
    await (operation === 'creation' ? creationPipelineAlarm : cloudReviewAlarm)(runner, env, id);
  });
  await task.alarm();
  expect(s.sqlite.prepare(`SELECT status,error FROM ${table} WHERE id=?`).get(seal.taskId))
    .toMatchObject({ status: 'error', error: expect.stringMatching(/结果未知|状态未知/) });
  expect(s.broker).not.toHaveBeenCalled();
  expect(s.brokerFetch).toHaveBeenCalledTimes(1);
  const request = s.brokerFetch.mock.calls[0][0] as Request;
  expect(new URL(request.url).pathname).toBe('/finish');
  expect(await request.json()).toEqual({ outcome: 'failed' });
});

test('an expired aggregate grant leaves the original sealed checkpoint for independent recovery', async () => {
  const s = await setup(), state = fixtureState();
  await s.control.release(s.authority, s.gameSeal);
  s.completeCreation();
  await s.control.release(s.authority, s.reviewSeal);
  const task = s.control.bindTask(s.authority, s.reviewSeal.taskId, state);
  await state.storage.put('cloudPhase', 'final-ready');
  await state.storage.put('cloudState:0', 'original sealed state');
  s.setNow(s.options.grant.deadlineAt);
  await expect(task.alarm()).rejects.toThrow(/execution window/);
  expect(await state.storage.get('cloudPhase')).toBe('final-ready');
  expect(await state.storage.get('cloudState:0')).toBe('original sealed state');
  expect(s.alarms.review).not.toHaveBeenCalled();
});
