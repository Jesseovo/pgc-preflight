import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { COMPARISON_LEDGER_SCHEMA, comparisonAdmittedSlotsSha256, type ComparisonAdmittedSlot, type ComparisonGrant } from '../scripts/harness-comparison-ledger';
import { prepareReview } from '../server/forge-api';
import { openComparisonEvidencePack } from '../server/harness-comparison-evidence';
import { createHarnessRun, lockHarnessModel } from '../server/harness-ledger';
import { inspectComparisonProfilePins, openComparisonAuthority, openComparisonCandidateRegistry } from '../server/harness-comparison-registry';
import type { ComparisonRunnerGrant } from '../server/harness-comparison-runner';
import { canonicalHarness, CCB_ENGINE_COMMIT, HARNESS_GAME_LIMITS, harnessHash, modelContractHash } from '../server/harness-policy';
import { HARNESS_MODEL_HEADERS } from '../server/harness-protocol';
import { encryptKey, type ModelConfig } from '../server/settings';

const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab', candidate = '630303565f44c061c7ed8ad7b992dcc4e9db8929';
const image = 'registry.cloudflare.com/071443b43c7562efec975a5e964d5a9c/pgc-ccb-research@sha256:0e95a0406e8dc94b0a4eea1f2cb62ff2a31ff48261d8fca87923d99ebfcec957';
const workerVersion = '12345678-1234-1234-1234-123456789abc', serviceVersion = '87654321-1234-1234-1234-123456789abc';
const secret = 'synthetic-provider-key', settingsKey = 'synthetic-settings-key';
const source = 'tap-rhythm';
const databases: DatabaseSync[] = [];
const digest = (value: unknown) => harnessHash(canonicalHarness(value));
const signal = () => new AbortController().signal;
afterEach(() => { vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });

function binding(id: string) {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  function prepare(sql: string, args: unknown[] = []) {
    const params = args as SQLInputValue[];
    return { bind: (...values: unknown[]) => prepare(sql, values),
      first: async <T>() => (sqlite.prepare(sql).get(...params) ?? null) as T | null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...params) as T[] }),
      run: async () => sqlite.prepare(sql).run(...params),
    };
  }
  return { id, connection: { prepare }, sqlite };
}

async function setup(cap = 2) {
  const databases = { A: binding('a-db'), B: binding('b-db'), ledger: binding('ledger-db'), capacity: binding('capacity-db'), nonce: binding('nonce-db') };
  for (const sql of COMPARISON_LEDGER_SCHEMA) databases.ledger.sqlite.exec(sql);
  for (const file of ['0007_model_throttle.sql', '0023_model_slots.sql']) databases.capacity.sqlite.exec(readFileSync('migrations/' + file, 'utf8'));
  const migrations = readdirSync('migrations').filter(name => name.endsWith('.sql')).sort();
  for (const arm of ['A', 'B'] as const) {
    for (const file of migrations.filter(name => name < (arm === 'A' ? '0033' : '0034'))) databases[arm].sqlite.exec(readFileSync('migrations/' + file, 'utf8'));
    databases[arm].sqlite.exec(`
      CREATE TABLE comparison_arm(id INTEGER PRIMARY KEY,plan_sha TEXT,arm TEXT,implementation TEXT);
      CREATE TABLE comparison_admissions(task_id TEXT PRIMARY KEY,identity_sha TEXT,identity_json TEXT,state TEXT,input_sha TEXT,policy_sha TEXT);
      CREATE TABLE comparison_schedule_requests(task_id TEXT PRIMARY KEY);
      CREATE TABLE comparison_execution_releases(task_id TEXT PRIMARY KEY,grant_sha TEXT,slot_sha TEXT,admission_sha TEXT,input_sha TEXT,policy_sha TEXT,
        profile_sha TEXT,release_sha TEXT,released_at INTEGER);`);
  }
  const creation = { baseUrl: 'https://riffle-api.pages.dev', model: 'claude-opus-5-5', protocol: 'anthropic', enabled: true, vision: true,
    updatedAt: 'synthetic', effort: 'high', maxOutputTokens: 64_000 } as const;
  const review = { ...creation, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', protocol: 'openai', effort: 'low', maxOutputTokens: 24_000 } as const;
  const creationBytes = JSON.stringify(creation), reviewBytes = JSON.stringify(review);
  const creationHash = await harnessHash(creationBytes), reviewHash = await harnessHash(reviewBytes);
  let config: ModelConfig;
  async function setProfile(key: string) {
    const opus = { ...creation, encryptedKey: await encryptKey(key, settingsKey) };
    const deepseek = { ...review, encryptedKey: await encryptKey('synthetic-deepseek-key', settingsKey) };
    config = { ...opus, activeProfile: 'opus', routes: { create: 'opus', review: 'review' }, profiles: { opus, review: deepseek } };
  }
  await setProfile(secret);
  const approvedCreation = (await lockHarnessModel(config!, 'game', 64_000))!, approvedReview = (await lockHarnessModel(config!, 'review', 24_000))!;
  const creationContract = await modelContractHash(config!, 'game'), reviewContract = await modelContractHash(config!, 'review');
  const cases = await Promise.all(['tap-rhythm', 'continuous-drag', 'strategy-tradeoffs', 'collision-feedback', 'difficulty-restart', 'dense-mobile'].map(async id => ({
    id, materialSha256: await harnessHash(id), materials: await Promise.all(['brief.md', 'sample.svg', 'assets.html'].map(async name =>
      ({ path: 'materials/' + id + '/' + name, sha256: await harnessHash(name) }))),
  })));
  const ruleContent = { sourceUrl: 'https://creator-hub-7mi.pages.dev/#/', capturedAt: '2026-11-06T00:00:00Z', rawDirection: 'Synthetic direction',
    rawScoring: 'Synthetic scoring', scoreMin: 0, scoreMax: 3, passScore: 7, notes: '', calibrationCases: [] };
  const rules = { schemaVersion: 2 as const, id: 'synthetic-registry-rules', contentHash: await digest(ruleContent), publishedAt: ruleContent.capturedAt, ...ruleContent,
    scoreMin: 0 as const, scoreMax: 3 as const, passScore: 7 as const };
  const rulesBytes = JSON.stringify(rules), calibrationBytes = '[]';
  const manifestSha256 = await harnessHash('synthetic-manifest'), rulesSha256 = await harnessHash(rulesBytes), calibrationSha256 = await harnessHash(calibrationBytes);
  const draftSlots = cases.flatMap(item => (['A','B'] as const).flatMap(arm => (['creation','review'] as const).map(operation => ({
    caseId: item.id, arm, operation, modelConfigSha256: operation === 'creation' ? creationHash : reviewHash,
  }))));
  const identities = draftSlots.map((slot, i) => ({ ...slot, taskId: '00000000-0000-8000-8000-' + (i+1).toString(16).padStart(12, '0') }));
  const planSlots = identities.map(slot => slot.operation === 'creation' ? { ...slot, materialSha256: cases.find(item => item.id === slot.caseId)!.materialSha256 } :
    { ...slot, rulesSha256, calibrationSha256, requires: { creationTaskId: identities.find(item => item.caseId === slot.caseId && item.arm === 'B' && item.operation === 'creation')!.taskId } });
  const planBytes = JSON.stringify({ schemaVersion: 1, scope: 'formal', executionAllowed: false, manifestSha256, cases, slots: planSlots,
    source: { A: { implementationCommit: baseline }, B: { implementationCommit: candidate, image, engineCommit: CCB_ENGINE_COMMIT } },
    settings: { creationModel: { config: { sha256: creationHash } }, reviewModel: { config: { sha256: reviewHash } } },
  });
  const planSha256 = await harnessHash(planBytes), owner = 'comparison-' + planSha256.slice(0, 24), now = Date.now();
  const slots: ComparisonAdmittedSlot[] = planSlots.map((item, i) => {
    const game = item.operation === 'creation', profile = game ? creation : review;
    return { taskId: item.taskId, slotId: 'slot-' + i, ownerId: game ? owner : 'admin', arm: item.arm, operation: item.operation, caseId: item.caseId,
      modelConfigSha256: item.modelConfigSha256, sourceSha256: 'materialSha256' in item ? item.materialSha256! : null, evidenceSha256: null,
      stages: Object.fromEntries((game ? ['build','polish','repair', ...(item.arm === 'B' ? ['repair2'] : [])] : ['review','review_verify']).map(stage => [stage,
        { transportId: 'route-' + i, protocol: profile.protocol, model: profile.model, effort: profile.effort,
          maxOutputTokens: profile.maxOutputTokens, stream: true, jsonMode: !game, modelContractHash: game ? creationContract : reviewContract }])),
    };
  });
  const grant: ComparisonGrant = { schemaVersion: 1, purpose: 'isolated-comparison', scope: 'formal', runId: 'test-run',
    ledgerDatabaseId: databases.ledger.id, planSha256, manifestSha256, admittedSlotsSha256: await comparisonAdmittedSlotsSha256(slots),
    authorizationSha256: await harnessHash('test-only-approval'), maxRequests: cap, maxOutputTokens: 256_000, notBefore: now - 500, deadlineAt: now + 60_000 };
  const dispatchGrantSha256 = await digest(['comparison-dispatch-grant-v1', grant]);
  const runtimeA = { implementationCommit: baseline, runtimeTreeSha256: await harnessHash('a-tree'), workerVersion: '12345678-1234-1234-1234-123456789abd', bundleSha256: await harnessHash('a-bundle') };
  const runtimeB = { implementationCommit: candidate, runtimeTreeSha256: await harnessHash('b-tree'), image, workerVersion, bundleSha256: await harnessHash('b-bundle') };
  const runnerGrants = Object.fromEntries(await Promise.all((['A', 'B'] as const).map(async arm => {
    const runtime = arm === 'A' ? runtimeA : runtimeB;
    const runner: ComparisonRunnerGrant = { schemaVersion: 1, scope: 'formal', purpose: grant.purpose, authorizationSha256: grant.authorizationSha256,
      dispatchGrantSha256, planSha256, manifestSha256, runnerDatabaseId: databases[arm].id, maxRequests: cap, maxOutputTokens: grant.maxOutputTokens,
      notBefore: grant.notBefore, deadlineAt: grant.deadlineAt, implementationCommit: runtime.implementationCommit, runtimeTreeSha256: runtime.runtimeTreeSha256,
      image: arm === 'A' ? null : image };
    return [arm, runner];
  }))) as Record<'A' | 'B', ComparisonRunnerGrant>;
  const fixture = Object.fromEntries(await Promise.all((['A','B'] as const).map(async arm => {
    const db = databases[arm].sqlite, declared = planSlots.find(item => item.caseId === source && item.arm === arm && item.operation === 'creation')!;
    const task = declared.taskId;
    db.prepare('INSERT INTO comparison_arm VALUES(1,?,?,?)').run(planSha256, arm, arm === 'A' ? baseline : candidate);
    db.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,star) VALUES(?,?,?,'test','test','test','test',1)").run(owner, owner, owner);
    const snapshot = { topic: { id: 1, owner_id: owner, subject: source, brief_md: 'brief.md', preview_svg: 'sample.svg', assets_html: 'assets.html' } };
    const payload = { type: 'game', id: 1, requestId: task, creative_version: 2 };
    const harnessPolicy = arm === 'A' ? null : { version: 1, engine: 'ccb', engineCommit: CCB_ENGINE_COMMIT, image, releaseHash: planSha256,
      family: 'forge', purpose: 'game', modelContractHash: creationContract, limits: HARNESS_GAME_LIMITS };
    db.prepare(`INSERT INTO forge_tasks(id,kind,scope,payload,created_at,updated_at,owner_id,executor,input_snapshot,creative_version${arm === 'B' ? ',harness_policy' : ''})
      VALUES(?,'game',?,?,'test','test',?,'platform',?,2${arm === 'B' ? ',?' : ''})`)
      .run(task, owner + ':game:1', JSON.stringify(payload), owner, JSON.stringify(snapshot), ...(arm === 'B' ? [JSON.stringify(harnessPolicy)] : []));
    const identity = { schemaVersion: 1, scope: 'formal', planSha256, manifestSha256, slot: declared, ownerId: owner,
      sourceHash: cases[0].materialSha256, evidenceHash: null, packHash: null, modelContractHash: creationContract, harnessPolicy };
    const seal = { taskId: task, slotSha256: await digest(declared), admissionSha256: await digest(identity), inputSha256: await digest(snapshot), policySha256: await digest(harnessPolicy) };
    db.prepare("INSERT INTO comparison_admissions VALUES(?,?,?,'paused',?,?)").run(task, seal.admissionSha256, canonicalHarness(identity), seal.inputSha256, seal.policySha256);
    db.prepare('INSERT INTO comparison_schedule_requests VALUES(?)').run(task);
    const grantSha256 = await digest(runnerGrants[arm]);
    const profileSha = arm === 'A' ? await digest(['comparison-a-marker-v1', task, creation]) :
      await digest([approvedCreation.profileId, { ...creation, encryptedKey: config!.profiles!.opus!.encryptedKey }]);
    const scope = { ...seal, grantSha256, authorizationSha256: grant.authorizationSha256, dispatchGrantSha256, planSha256, manifestSha256,
      runnerDatabaseId: databases[arm].id, ownerId: owner, operation: 'creation' as const, sourceSha256: identity.sourceHash, evidenceSha256: null,
      modelConfigSha256: creationHash, modelContractHash: creationContract, deadlineAt: grant.deadlineAt };
    const release = async () => {
      db.prepare('INSERT INTO comparison_execution_releases VALUES(?,?,?,?,?,?,?,?,?)').run(task, grantSha256, seal.slotSha256, seal.admissionSha256,
        seal.inputSha256, seal.policySha256, profileSha, await digest({ grantSha256, ...seal }), now);
      db.prepare("UPDATE forge_tasks SET status='running',phase='build:model',model_started_at='test' WHERE id=?").run(task);
    };
    return [arm, { task, scope, release, seal, db }];
  }))) as Record<'A' | 'B', { task: string; scope: any; release(): Promise<void>; seal: any; db: DatabaseSync }>;
  const wire = ['data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fixture"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}', 'data: {"type":"message_stop"}'].join('\n\n') + '\n\n';
  const reviewWire = 'data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":12}}\n\ndata: [DONE]\n\n';
  const fetcher = vi.fn(async (url: string, _init: RequestInit) => new Response(url.includes('deepseek') ? reviewWire : wire, { headers: { 'content-type': 'text/event-stream' } }));
  const noNetwork = vi.fn(() => { throw new Error('External network disabled'); }); vi.stubGlobal('fetch', noNetwork);
  const evidence = new Map<string, string>();
  const options = { grant, slots, runnerGrants, planBytes, attestation: { A: runtimeA, B: runtimeB, authorizedCandidateVersion: serviceVersion, executingCandidateVersion: serviceVersion },
    databases, profiles: { creation: approvedCreation, review: approvedReview }, settingsKey, loadConfig: async () => config,
    authorizeGrant: vi.fn(async () => true), fetcher,
    loadFrozenInput: async (hash: string) => ({ [creationHash]: creationBytes, [reviewHash]: reviewBytes, [rulesSha256]: rulesBytes, [calibrationSha256]: calibrationBytes })[hash] ?? 'unavailable',
    loadEvidencePack: async (taskId: string) => evidence.get(taskId) ?? 'unavailable',
  };
  const registry = await openComparisonCandidateRegistry(options);
  const body = JSON.stringify({ model: creation.model, max_tokens: creation.maxOutputTokens, stream: true,
    messages: [{ role: 'user', content: 'fixture' }], thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  const baselineCall = () => ({ kind: 'baseline' as const, scope: { arm: 'A' as const, taskId: fixture.A.task, ownerId: owner, operation: 'creation' as const, stage: 'build' as const },
    url: creation.baseUrl + '/v1/messages', init: { method: 'POST', redirect: 'manual' as const, signal: signal(), body, headers: {
      'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01', 'x-api-key': 'pgc-comparison-local-placeholder',
      'idempotency-key': 'pgc-create-' + fixture.A.task + ':build-' + 'a'.repeat(24),
    } } });
  async function harnessCall(drift?: 'source' | 'policy') {
    const generation = 'fixture-generation';
    const row = fixture.B.db.prepare('SELECT input_snapshot,harness_policy FROM forge_tasks WHERE id=?').get(fixture.B.task)!;
    const run = (await createHarnessRun(databases.B.connection, { taskId: fixture.B.task, generation, ownerId: owner, actor: 'star', family: 'forge',
      sourceHash: await harnessHash(drift === 'source' ? 'different-snapshot' : String(row.input_snapshot)),
      snapshot: drift === 'policy' ? { different: true } : JSON.parse(String(row.harness_policy)), model: approvedCreation, deadlineAt: grant.deadlineAt }))!;
    const scope = { taskId: fixture.B.task, generation, lease: run.lease, stage: 'build' as const, stageDeadlineAt: grant.deadlineAt, requestIdPrefix: 'build-0-', jsonOutput: false };
    return { kind: 'forward' as const, scope, request: new Request('http://pgc-harness.internal/v1/messages', { method: 'POST',
      headers: { 'content-type': 'application/json', [HARNESS_MODEL_HEADERS.requestId]: 'build-0-test' }, body }) };
  }
  async function reviewPair() {
    const html = '<!doctype html><title>Sealed B fixture</title>\r\n', htmlSha256 = await harnessHash(html);
    await fixture.B.release();
    fixture.B.db.prepare("UPDATE forge_tasks SET status='done',result=? WHERE id=?").run(JSON.stringify({ version_id: 'fixture-b-version', content_hash: htmlSha256 }), fixture.B.task);
    fixture.B.db.prepare(`INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,task_id,input_revision,executor,disposition,created_at)
      VALUES('fixture-b-version',?,1,'game',?,?,0,'platform','current','test')`).run(owner, html, fixture.B.task);
    const labels = [['9:16 首次触摸后约 10 秒', 'baseline-9:16-tap'], ['9:19.5 首次触摸前'],
      ['9:19.5 首次触摸后约 3 秒', 'baseline-9:19.5-tap'], ['9:21 首次触摸后约 10 秒', 'baseline-9:21-tap']];
    const probe = JSON.stringify({ captureMethod: 'browser-viewport-v1', observations: labels.map(([label, ...actionRefs], index) =>
      ({ id: 'baseline-' + (index + 1), label, actionRefs, capturedAt: rules.capturedAt })) });
    const probeSha256 = await harnessHash(probe);
    const shots = await Promise.all([1, 2, 3, 4].map(async index => {
      const bytes = Uint8Array.from([255, 216, 255, index]);
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      return { id: 'baseline-' + index, sha256, data: 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64') };
    }));
    const evidenceSha256 = await harnessHash(JSON.stringify({ html: htmlSha256, probe: probeSha256, shots: shots.map(item => item.sha256) }, null, 2) + '\n');
    const serialized = JSON.stringify({ schemaVersion: 1, caseId: source, manifestSha256, evidenceSha256, captureOrigin: 'isolated-chromium',
      html: { text: html, sha256: htmlSha256 }, probe: { json: probe, sha256: probeSha256 }, shots });
    const packSha256 = await harnessHash(serialized), packIdentity = { caseId: source, manifestSha256, evidenceSha256, packSha256 };
    const shards = JSON.stringify({ html, title: source, topic_id: null });
    const reviewFixtures = await Promise.all((['A','B'] as const).map(async arm => {
      const declared = planSlots.find(item => item.caseId === source && item.arm === arm && item.operation === 'review')!, taskId = declared.taskId;
      const db = databases[arm].sqlite;
      const policy = arm === 'A' ? null : { version: 1, engine: 'ccb', engineCommit: CCB_ENGINE_COMMIT, image, releaseHash: planSha256,
        family: 'review', purpose: 'review', modelContractHash: reviewContract,
        limits: { maxOutputTokens: 24_000, maxTotalOutputTokens: 48_000, maxModelTurns: 8, maxDurationMs: 720_000, maxRepairs: 0 } };
      db.prepare(`INSERT INTO review_jobs(id,owner_id,title,filename,executor,model_executor,input_ready,input_hash,rules_snapshot,report_schema_version,review_mode,created_at,updated_at${arm === 'B' ? ',harness_policy' : ''})
        VALUES(?,'admin',?,?,'cloud','platform',1,?,?,2,'basic','test','test'${arm === 'B' ? ',?' : ''})`)
        .run(taskId, source, source + '.html', htmlSha256, rulesBytes, ...(arm === 'B' ? [JSON.stringify(policy)] : []));
      db.prepare("INSERT INTO review_inputs(job_id,part,data,created_at) VALUES(?,0,?,'test')").run(taskId, shards);
      evidence.set(taskId, serialized);
      const identity = { schemaVersion: 1, scope: 'formal', planSha256, manifestSha256, slot: declared, ownerId: 'admin', sourceHash: htmlSha256,
        evidenceHash: evidenceSha256, packHash: packSha256, modelContractHash: reviewContract, harnessPolicy: policy };
      const seal = { taskId, slotSha256: await digest(declared), admissionSha256: await digest(identity),
        inputSha256: await digest({ inputHash: htmlSha256, rulesSnapshot: rules, evidenceSha256, packSha256 }), policySha256: await digest(policy) };
      db.prepare("INSERT INTO comparison_admissions VALUES(?,?,?,'paused',?,?)").run(taskId, seal.admissionSha256, canonicalHarness(identity), seal.inputSha256, seal.policySha256);
      db.prepare('INSERT INTO comparison_schedule_requests VALUES(?)').run(taskId);
      const grantSha256 = await digest(runnerGrants[arm]);
      const scope = { ...seal, grantSha256, authorizationSha256: grant.authorizationSha256, dispatchGrantSha256, planSha256, manifestSha256,
        runnerDatabaseId: databases[arm].id, ownerId: 'admin', operation: 'review' as const, sourceSha256: htmlSha256, evidenceSha256,
        modelConfigSha256: reviewHash, modelContractHash: reviewContract, deadlineAt: grant.deadlineAt };
      const release = async () => {
        const profileSha = arm === 'A' ? await digest(['comparison-a-marker-v1', taskId, review]) :
          await digest([approvedReview.profileId, { ...review, encryptedKey: config!.profiles!.review!.encryptedKey }]);
        db.prepare('INSERT INTO comparison_execution_releases VALUES(?,?,?,?,?,?,?,?,?)').run(taskId, grantSha256, seal.slotSha256, seal.admissionSha256,
          seal.inputSha256, seal.policySha256, profileSha, await digest({ grantSha256, ...seal }), now);
        db.prepare("UPDATE review_jobs SET status='running',stage='review',model_started_at='test',model_execution_started_at='test' WHERE id=?").run(taskId);
      };
      return { taskId, scope, release, policy };
    }));
    const [A, B] = reviewFixtures;
    const opened = await openComparisonEvidencePack(serialized, packIdentity);
    const { images, ...prepared } = await prepareReview({ DB: databases.B.connection, ownerId: 'admin', modelExecutor: 'platform', modelStore: { get: async () => config } },
      { title: source, html, ...await opened.captureReview(html), rulesSnapshot: rules, reportSchemaVersion: 2 });
    const sourceHash = await digest({ request: { ...prepared, reportSchemaVersion: 2 }, images });
    const generation = 'fixture-review-generation';
    const active = (await createHarnessRun(databases.B.connection, { taskId: B.taskId, generation, ownerId: 'admin', actor: 'admin', family: 'review',
      sourceHash, snapshot: B.policy, model: approvedReview, deadlineAt: grant.deadlineAt }))!;
    const reviewCall = () => ({ kind: 'forward' as const, scope: { taskId: B.taskId, generation, lease: active.lease, stage: 'review' as const,
      stageDeadlineAt: grant.deadlineAt, requestIdPrefix: 'review-0-', jsonOutput: true }, request: new Request('http://pgc-harness.internal/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', [HARNESS_MODEL_HEADERS.requestId]: 'review-0-fixture' },
      body: JSON.stringify({ model: review.model, max_tokens: 24_000, stream: true, messages: [{ role: 'user', content: 'fixture' }] }),
    }) });
    return { A, B, reviewCall, packIdentity, serialized, shards, proof: { taskId: fixture.B.task, caseId: source, planSha256, manifestSha256,
      sourceSha256: htmlSha256, evidenceSha256, packSha256 }, evidence };
  }
  return { registry, options, fixture, fetcher, noNetwork, creationHash, reviewHash, baselineCall, harnessCall, setProfile, wire, reviewWire, reviewPair };
}

it('attests only the paused B profile before release and exposes only bound authority reads', async () => {
  const s = await setup();
  const { registry, fixture } = s;
  const profile = await registry.handle({ kind: 'profile', scope: fixture.B.scope }, signal());
  expect(profile).toMatchObject({ scopeSha256: await digest(fixture.B.scope), profileId: 'opus', profile: { model: 'claude-opus-5-5', encryptedKey: expect.any(String) } });
  expect(JSON.stringify(profile)).not.toContain(secret);
  expect(fixture.B.db.prepare('SELECT count(*) AS n FROM comparison_execution_releases').get()).toEqual({ n: 0 });
  expect(await registry.authority.authorizeRelease(fixture.B.seal)).toBe(true);
  expect(await registry.authority.readTaskRuntime(fixture.B.task)).toMatchObject({ workerVersion, bundleSha256: s.options.attestation.B.bundleSha256 });
  expect(await registry.authority.readTaskRuntime(fixture.A.task)).toBeNull();
  await expect(registry.authority.readFrozenInput(fixture.B.task, s.reviewHash)).rejects.toThrow('unavailable');
  expect(await registry.handle({ kind: 'profile', scope: { ...fixture.B.scope, ownerId: 'wrong-owner' } }, signal())).toBeNull();
  expect(await registry.handle({ kind: 'profile', scope: { ...fixture.B.scope, dispatchGrantSha256: '1'.repeat(64) } }, signal())).toBeNull();
  expect(await registry.handle(s.baselineCall(), signal())).toBeNull();
  expect(s.fetcher).not.toHaveBeenCalled();
  expect(s.noNetwork).not.toHaveBeenCalled();
  expect(registry.context.taskIds).not.toContain(fixture.A.task);
  expect(registry.baselineContext.taskIds).not.toContain(fixture.B.task);
  expect(await registry.baselineAuthority.readTaskRuntime(fixture.A.task)).toMatchObject({ workerVersion: s.options.attestation.A.workerVersion });
  const privateAuthority = await openComparisonAuthority({ ...s.options, databases: { ...s.options.databases, nonce: s.options.databases.ledger },
    // Excess properties are never read by the separate authority.
    ...{ loadConfig: () => { throw new Error('Authority cannot load provider configuration'); } } });
  expect(await privateAuthority.authorizeRelease(fixture.B.seal)).toBe(true);
  const pins = await inspectComparisonProfilePins({ ...s.options, profileIds: { creation: 'opus', review: 'review' } });
  expect(pins.creation).toEqual({ profileId: 'opus', profileHash: s.options.profiles.creation.profileHash });
  expect(Object.keys(pins.creation)).toEqual(['profileId', 'profileHash']);
  expect(() => s.options.databases.ledger.sqlite.exec("UPDATE comparison_candidate_profile_locks SET profile_sha='changed'")).toThrow('Immutable comparison profile lock');
});

it('binds both actual transports to one hard request cap, requires durable release, and rejects stale phases', async () => {
  const s = await setup(1), { registry, fixture } = s;
  await fixture.A.release(); await fixture.B.release();
  fixture.A.db.prepare("UPDATE forge_tasks SET phase='polish:model' WHERE id=?").run(fixture.A.task);
  expect(await registry.handle(s.baselineCall(), signal())).toBeNull();
  fixture.A.db.prepare("UPDATE forge_tasks SET phase='build:model' WHERE id=?").run(fixture.A.task);
  fixture.A.db.prepare("UPDATE comparison_execution_releases SET release_sha='wrong' WHERE task_id=?").run(fixture.A.task);
  expect(await registry.handle(s.baselineCall(), signal())).toBeNull();
  fixture.A.db.prepare('DELETE FROM comparison_execution_releases WHERE task_id=?').run(fixture.A.task);
  await fixture.A.release();
  const a = await registry.handle(s.baselineCall(), signal());
  expect(a).toBeInstanceOf(Response);
  expect(await (a as Response).text()).toBe(s.wire);
  const b = await registry.handle(await s.harnessCall(), signal());
  expect(b).toBeInstanceOf(Response);
  expect((b as Response).status).toBe(502);
  expect(fixture.B.db.prepare('SELECT state FROM harness_requests').get()).toEqual({ state: 'unknown' });
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  expect(s.noNetwork).not.toHaveBeenCalled();
  expect(s.options.databases.ledger.sqlite.prepare('SELECT count(*) AS n FROM comparison_dispatch_attempts').get()).toEqual({ n: 1 });
}, 15_000);

it.each([undefined, 'source', 'policy'] as const)('independently verifies the B Harness origin and policy before a vendor request (%s)', async drift => {
  const s = await setup(), { registry, fixture } = s;
  expect(await registry.handle({ kind: 'profile', scope: fixture.B.scope }, signal())).not.toBeNull();
  await fixture.B.release();
  const b = await registry.handle(await s.harnessCall(drift), signal());
  expect(b).toBeInstanceOf(Response);
  expect((b as Response).status).toBe(drift ? 401 : 200);
  if (!drift) expect(await (b as Response).text()).toBe(s.wire);
  expect(s.fetcher).toHaveBeenCalledTimes(drift ? 0 : 1);
  expect(s.options.databases.ledger.sqlite.prepare('SELECT count(*) AS n FROM comparison_dispatch_attempts').get()).toEqual({ n: drift ? 0 : 1 });
});

it('binds both review authorities and the B vendor request to the exact completed B artifact, pack and shards', async () => {
  const s = await setup();
  expect(await s.registry.handle({ kind: 'profile', scope: s.fixture.B.scope }, signal())).not.toBeNull();
  const review = await s.reviewPair();
  expect(await s.registry.baselineAuthority.verifyCompletedBArtifact(review.proof)).toBe(true);
  expect(await s.registry.baselineAuthority.verifyCompletedBArtifact({ ...review.proof, taskId: s.fixture.A.task })).toBe(false);
  expect(await s.registry.authority.readEvidencePack(review.B.taskId, review.packIdentity)).toBe(review.serialized);
  expect(await s.registry.handle({ kind: 'profile', scope: review.B.scope }, signal())).not.toBeNull();
  await review.B.release();
  review.evidence.set(review.B.taskId, review.serialized + ' ');
  expect(await s.registry.handle(review.reviewCall(), signal())).toBeNull();
  review.evidence.set(review.B.taskId, review.serialized);
  const db = s.fixture.B.db;
  db.prepare("UPDATE review_inputs SET data='{}' WHERE job_id=?").run(review.B.taskId);
  expect(await s.registry.handle(review.reviewCall(), signal())).toBeNull();
  expect(s.fetcher).not.toHaveBeenCalled();
  db.prepare('UPDATE review_inputs SET data=? WHERE job_id=?').run(review.shards, review.B.taskId);
  const response = await s.registry.handle(review.reviewCall(), signal());
  expect(response).toBeInstanceOf(Response);
  expect(await (response as Response).text()).toBe(s.reviewWire);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});

it('fails closed on wrong runtime, grant or server profile rotation', async () => {
  const s = await setup();
  await expect(openComparisonCandidateRegistry({ ...s.options, attestation: { ...s.options.attestation, executingCandidateVersion: workerVersion } })).rejects.toThrow('unavailable');
  await expect(openComparisonCandidateRegistry({ ...s.options, runnerGrants: { ...s.options.runnerGrants,
    B: { ...s.options.runnerGrants.B, dispatchGrantSha256: 'a'.repeat(64) } } })).rejects.toThrow('unavailable');
  expect(await s.registry.handle({ kind: 'profile', scope: s.fixture.B.scope }, signal())).not.toBeNull();
  await s.fixture.A.release();
  await s.setProfile('rotated-synthetic-key');
  expect(await s.registry.handle({ kind: 'profile', scope: s.fixture.B.scope }, signal())).toBeNull();
  expect(await s.registry.handle(s.baselineCall(), signal())).toBeNull();
  const reopened = await openComparisonCandidateRegistry(s.options);
  expect(await reopened.handle({ kind: 'profile', scope: s.fixture.B.scope }, signal())).toBeNull();
  await expect(inspectComparisonProfilePins({ ...s.options, profileIds: { creation: 'opus', review: 'review' } })).rejects.toThrow('unavailable');
  expect(s.fetcher).not.toHaveBeenCalled();
});
