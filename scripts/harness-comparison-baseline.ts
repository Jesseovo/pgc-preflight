/** A-only local rehearsal. Archived production code receives scripted responses in a subprocess. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedSyntheticComparisonReviewRules, syntheticComparisonReviewModel } from './harness-comparison-rehearsal-fixture';

const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const tree = '491936d02f57b9125be86e36e73e76048009d82f';
const scope = 'synthetic-offline-a-rehearsal';
const entry = fileURLToPath(import.meta.url);
const sharedFixturePath = new URL('./harness-comparison-rehearsal-fixture.ts', import.meta.url);
const root = resolve(dirname(entry), '..');
const opusUrl = 'https://riffle-api.pages.dev/v1/messages';
const deepSeekUrl = 'https://api.deepseek.com/chat/completions';
const opusModel = 'claude-opus-5-5';
const caseId = 'tap-rhythm';
const materialNames = ['brief.md', 'sample.svg', 'assets.html'] as const;
const scenarios = ['success', 'unknown-response', 'persist-recovery'] as const;
type Scenario = typeof scenarios[number];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

type ReviewShot = { id: string; label: string; capturedAt: string; actionRefs: string[]; data: string };
type ReviewEvidence = { htmlSha256: string; probeSha256: string; shotSha256: string[] };
type ReviewBindings = Awaited<ReturnType<typeof seedSyntheticComparisonReviewRules>>;
export type BaselineReviewInput = ReviewEvidence & { html: string; probe: unknown; shots: ReviewShot[] };

function writeOnce(directory: string, name: string, bytes: string) {
  const temporary = join(directory, `.receipt-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    linkSync(temporary, join(directory, name));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function save(directory: string, name: string, value: unknown) {
  writeOnce(directory, name, encode(value));
}

function privateOutput(out: string) {
  assert(out && !out.split(/[\\/]/).includes('..'), 'Use a fresh private rehearsal directory');
  const directory = resolve(out);
  assert.equal(realpathSync(dirname(directory)), dirname(directory), 'Rehearsal parent must not use symbolic links');
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

export function runBaselineRehearsal({ out, scenario = 'success', reviewInput }: { out: string; scenario?: Scenario; reviewInput?: BaselineReviewInput }) {
  assert(scenarios.includes(scenario), 'Unknown rehearsal scenario');
  const directory = privateOutput(out);
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'pgc-archived-baseline-'));
  try {
    const env = { PATH: dirname(process.execPath) + delimiter + '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1' };
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, env, maxBuffer: 30 * 1024 * 1024 });
    assert.equal(git(['rev-parse', baseline + '^{tree}']).toString().trim(), tree, 'Baseline tree does not match its pin');
    const archive = git(['archive', '--format=tar', baseline]);
    const archivedRoot = join(temporary, 'source');
    mkdirSync(archivedRoot, { mode: 0o700 });
    execFileSync('tar', ['-xf', '-', '-C', archivedRoot], { input: archive, env });
    // Dependency resolution through the parent leaves the extracted tree untouched.
    const loader = createRequire(import.meta.url).resolve('tsx');
    symlinkSync(join(root, 'node_modules'), join(temporary, 'node_modules'));
    const migrations = readdirSync(join(archivedRoot, 'migrations')).filter(name => name.endsWith('.sql')).sort();
    assert(migrations.at(-1)?.startsWith('0032_'), 'Unexpected baseline migrations');
    const packageLockSha256 = sha(readFileSync(join(archivedRoot, 'package-lock.json')));
    assert.equal(sha(readFileSync(join(root, 'package-lock.json'))), packageLockSha256, 'Local dependency lock differs from the archived baseline');
    const provenance = {
      schemaVersion: 1, scope, implementationCommit: baseline, tree, archiveSha256: sha(archive),
      adapterSha256: sha(readFileSync(entry)), fixtureSha256: sha(readFileSync(sharedFixturePath)), packageLockSha256,
      migrations: Object.fromEntries(migrations.map(name => [name, sha(readFileSync(join(archivedRoot, 'migrations', name)))])),
    };
    save(directory, 'source.json', provenance);
    const wire = execFileSync(process.execPath, ['--import', loader, entry, 'internal', archivedRoot, directory, scenario], {
      cwd: archivedRoot, env, input: JSON.stringify(reviewInput ?? null), timeout: 55_000, maxBuffer: 128 * 1024,
    });
    const result = JSON.parse(wire.toString()) as Awaited<ReturnType<typeof rehearse>>;
    assert.equal(result.scope, scope);
    save(directory, 'verification.json', { ...result, sourceReceiptSha256: sha(readFileSync(join(directory, 'source.json'))) });
    return { output: directory, provenance, result };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function localDatabase(sqlite: DatabaseSync, beforeBatch: (statements: string[]) => void) {
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const execute = () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } });
    return {
      sql, execute, bind: (...next: SQLInputValue[]) => prepare(sql, next),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: async () => execute(),
    };
  }
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      beforeBatch(statements.map(statement => statement.sql));
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function localStorage(afterCommit?: (values: ReadonlyMap<string, unknown>) => void) {
  let values = new Map<string, unknown>(), alarm: number | null = null;
  type Storage = {
    get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>;
    deleteAll(): Promise<void>; setAlarm(at: number): Promise<void>; deleteAlarm(): Promise<void>;
    transaction(fn: (tx: Storage) => Promise<void>): Promise<void>;
  };
  const storage: Storage = {
    get: async key => structuredClone(values.get(key)),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async key => { values.delete(key); },
    deleteAll: async () => { values.clear(); },
    setAlarm: async at => { alarm = at; },
    deleteAlarm: async () => { alarm = null; },
    async transaction(fn) {
      const original = structuredClone(values), previousAlarm = alarm;
      try { await fn(storage); } catch (error) { values = original; alarm = previousAlarm; throw error; }
      afterCommit?.(values);
    },
  };
  return {
    storage,
    takeAlarm() {
      const scheduled = alarm !== null;
      alarm = null;
      return scheduled;
    },
  };
}

function localRunner(path: string, taskId: string, state: ReturnType<typeof localStorage>) {
  return {
    idFromName: (id: string) => id,
    get: (id: string) => ({
      async fetch(request: Request) {
        assert(id === taskId && new URL(request.url).pathname === path && request.method === 'POST');
        assert.equal(await request.text(), id);
        await state.storage.setAlarm(Date.now());
        return Response.json({ ok: true });
      },
    }),
  };
}

function syntheticCapture() {
  const time = new Date().toISOString();
  const actions = ['9:16', '9:19.5', '9:21'].map((ratio, index) => ({ id: `tap-${index + 1}`, ratio, type: 'tap', startedAt: time }));
  const syntheticPixels = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGAAAAAHAALpEtlMAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYmAAAAAKAANQonMOAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZmAAAAANAARPw/7SAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYWAAAAAQAAUm//d+AAAAAElFTkSuQmCC',
  ];
  const shots = syntheticPixels.map((pixel, index) => ({
    id: `shot-${index + 1}`, label: `Synthetic screenshot ${index + 1}`, capturedAt: time,
    actionRefs: index ? [actions[index - 1].id] : [], data: `data:image/png;base64,${pixel}`,
  }));
  const observations = shots.map(({ data, ...metadata }) => metadata);
  return { shots, probe: { captureMethod: 'browser-viewport-v1', actions, observations, note: 'Synthetic fixture only' } };
}

function lockReviewInput(html: string, capture: { probe: unknown; shots: ReviewShot[] }, expected?: ReviewEvidence) {
  assert(typeof html === 'string' && html.trim(), 'Rehearsal review needs original HTML');
  const probe = capture.probe as { captureMethod?: unknown; observations?: Omit<ReviewShot, 'data'>[] };
  assert(probe?.captureMethod === 'browser-viewport-v1' && probe.observations?.length === 4 && capture.shots.length === 4,
    'Rehearsal review needs a basic probe and four shots');
  const shotSha256 = capture.shots.map(({ id, label, capturedAt, actionRefs, data }, index) => {
    const observed = probe.observations![index];
    assert(id === observed.id && label === observed.label && capturedAt === observed.capturedAt);
    assert.deepEqual(actionRefs, observed.actionRefs);
    const base64 = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data)?.[1];
    assert(base64, 'Invalid rehearsal screenshot');
    const bytes = Buffer.from(base64, 'base64');
    assert.equal(bytes.toString('base64'), base64, 'Noncanonical rehearsal screenshot');
    return sha(bytes);
  });
  const evidence = { htmlSha256: sha(html), probeSha256: sha(JSON.stringify(probe)), shotSha256 };
  if (expected) assert.deepEqual(evidence, { htmlSha256: expected.htmlSha256, probeSha256: expected.probeSha256, shotSha256: expected.shotSha256 },
    'Shared synthetic review evidence digest differs');
  return { html, evidence, capture: { probe, shots: capture.shots } };
}

const draft = {
  schema_version: 2, assessment_status: 'complete', aes: 1, ease: 2, play: 1, verdict: '打回',
  score_reasons: { aes: 'Synthetic image', ease: 'Synthetic log', play: 'Synthetic source' },
  uncertainties: [], issues: [], strengths: [], reviewer_comment: 'Synthetic initial report', fix_prompt: '', optional_suggestions: [],
};
const final = { ...draft, reviewer_comment: 'Synthetic verification report' };

function sse(events: unknown[]) {
  return new Response(events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function anthropicOutput(stage: 'build' | 'polish', assetsScript: string) {
  const html = `<!doctype html>\n<html lang="en"><head><title>Synthetic A</title><meta name="viewport" content="width=device-width"></head>\n<body><button>${stage}</button>${assetsScript}</body></html>`;
  const record = {
    requirements: [{ id: 'synthetic-goal', text: 'Synthetic scenario', status: 'implemented' }], decisions: [], coreChanges: [],
    ...(stage === 'polish' ? { selfCheck: { findings: [], unverified: [], changes: [], requestRepair: false } } : {}),
  };
  const text = `<PGC_HTML>\n${html}\n</PGC_HTML>\n<PGC_RECORD>\n${JSON.stringify(record)}\n</PGC_RECORD>`;
  return sse([{ type: 'message_start', message: { usage: { input_tokens: 21 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 34 } }, { type: 'message_stop' }]);
}

type Dispatch = {
  taskId: string; phase: 'build' | 'polish' | 'initial' | 'verify'; destination: string; idempotencyKey: string;
  bodySha256: string; model: string; effort: string; outputCap: number; imageSha256: string[]; at: string; reviewEvidence?: ReviewEvidence;
} & Partial<ReviewBindings>;

async function rehearse(archivedRoot: string, directory: string, scenario: Scenario, reviewInput: BaselineReviewInput | null) {
  const deny = () => { process.stderr.write('Baseline rehearsal blocked network access.\n'); process.exit(90); };
  net.Socket.prototype.connect = deny;
  dgram.Socket.prototype.connect = deny;
  dgram.Socket.prototype.send = deny;
  const source = JSON.parse(readFileSync(join(directory, 'source.json'), 'utf8'));
  assert.equal(source.adapterSha256, sha(readFileSync(entry)), 'Rehearsal adapter changed after source receipt');
  assert.equal(source.fixtureSha256, sha(readFileSync(sharedFixturePath)), 'Rehearsal fixture changed after source receipt');
  const materials = materialNames.map(name => readFileSync(join(root, 'fixtures/harness-evaluation', caseId, name), 'utf8'));
  const assetsScript = materials[2].match(/<script\b[^>]*id=["']game-assets["'][^>]*>[\s\S]*?<\/script>/i)?.[0];
  assert(assetsScript, 'Missing baseline asset script');
  const creationId = randomUUID(), reviewId = randomUUID();
  const sharedReview = reviewInput ? lockReviewInput(reviewInput.html, reviewInput, reviewInput) : null;
  const dispatches: Dispatch[] = [];
  let reviewDispatch: ({ reviewEvidence: ReviewEvidence } & ReviewBindings) | undefined;
  let initialMessages: unknown[] = [];
  globalThis.fetch = async (target, init) => {
    const destination = String(target);
    if ((destination !== opusUrl && destination !== deepSeekUrl) || init?.method !== 'POST' || typeof init.body !== 'string') return deny();
    const headers = new Headers(init.headers);
    const idempotencyKey = headers.get('Idempotency-Key') ?? '';
    const body = JSON.parse(init.body);
    const creation = destination === opusUrl;
    const phase: Dispatch['phase'] = creation ? (idempotencyKey.startsWith(`pgc-create-${creationId}:build-`) ? 'build' : 'polish')
      : (idempotencyKey.startsWith(`pgc-review-${reviewId}-verify-`) ? 'verify' : 'initial');
    const taskId = creation ? creationId : reviewId;
    assert(idempotencyKey.startsWith(creation ? `pgc-create-${creationId}:${phase}-` : `pgc-review-${reviewId}-`));
    assert.equal(init.redirect, 'manual');
    assert(init.signal instanceof AbortSignal);
    assert.equal(body.stream, true);
    const effort = creation ? body.output_config?.effort : body.reasoning_effort;
    assert.equal(effort, creation ? 'high' : 'low');
    assert.equal(body.model, creation ? opusModel : syntheticComparisonReviewModel.model);
    assert.equal(body.max_tokens, creation ? 64_000 : 24_000);
    assert.equal(body.thinking?.type, creation ? 'adaptive' : 'enabled');
    if (!creation) {
      assert.equal(body.response_format?.type, 'json_object');
      assert.equal(body.stream_options?.include_usage, true);
      if (phase === 'initial') initialMessages = body.messages;
      else {
        const comparable = structuredClone(body.messages);
        const last = comparable.at(-1).content;
        const [draftPart] = last.splice(-2, 1); // The archived JSON schema tail remains last.
        assert(draftPart.text.includes(JSON.stringify(draft)));
        assert.deepEqual(comparable, initialMessages);
      }
    }
    const parts = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
    const imageSha256: string[] = parts.flatMap((part: any) => {
      const base64 = part.source?.data ?? part.image_url?.url?.split(',')[1];
      return typeof base64 === 'string' ? [sha(Buffer.from(base64, 'base64'))] : [];
    });
    assert.equal(imageSha256.length, phase === 'build' ? 0 : 4);
    if (!creation) assert.deepEqual(imageSha256, reviewDispatch?.reviewEvidence.shotSha256);
    const dispatch = { taskId, phase, destination, idempotencyKey, bodySha256: sha(init.body), model: body.model,
      effort, outputCap: body.max_tokens, imageSha256, at: new Date().toISOString(), ...(!creation && reviewDispatch) };
    save(directory, `dispatch-${dispatches.length + 1}.json`, { scope, ...dispatch });
    dispatches.push(dispatch);
    if (creation) return anthropicOutput(phase as 'build' | 'polish', assetsScript);
    const content = { choices: [{ delta: { content: JSON.stringify(phase === 'initial' ? draft : final) } }] };
    if (scenario === 'unknown-response' && phase === 'initial') return sse([content]);
    return sse([content, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 54, completion_tokens: 71 } }, '[DONE]']);
  };

  const load = (name: string) => import(pathToFileURL(join(archivedRoot, 'server', name)).href);
  const [{ enqueueForgeTask }, { creationPipelineAlarm }, { enqueueReview }, { cloudReviewAlarm }, { encryptKey }, { getActiveReviewRules }, { canonicalJson }] = await Promise.all([
    load('forge-tasks.ts'), load('forge-creation-pipeline.ts'), load('review-jobs.ts'), load('cloud-review-runner.ts'), load('settings.ts'), load('review-rules.ts'), load('review-device-state.ts'),
  ]);
  const sqlite = new DatabaseSync(':memory:');
  let failedWrites = 0;
  try {
    const migrations = join(archivedRoot, 'migrations');
    for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(join(migrations, name), 'utf8'));
    const DB = localDatabase(sqlite, statements => {
      if (scenario === 'persist-recovery' && failedWrites === 0 && statements.some(sql => sql.startsWith('INSERT OR IGNORE INTO reviews('))) {
        failedWrites++;
        throw new Error('Synthetic final report D1 failure');
      }
    });
    const at = new Date().toISOString(), owner = 'synthetic-star';
    sqlite.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,star) VALUES(?,?,?,'local','local',?,?,1)")
      .run(owner, owner, owner, at, at);
    sqlite.prepare("INSERT INTO topics(id,owner_id,batch,subject,medium,gesture,structure,mood,created_at,updated_at,brief_md,preview_svg,assets_html) VALUES(1,?,'local','rhythm','local','tap','local','local',?,?,?,?,?)")
      .run(owner, at, at, ...materials);
    const SETTINGS_KEY = randomUUID();
    const key = async () => encryptKey(randomUUID(), SETTINGS_KEY);
    const config = { activeProfile: 'opus', routes: { create: 'opus', review: 'deepseek' }, profiles: {
      opus: { model: opusModel, protocol: 'anthropic', baseUrl: 'https://riffle-api.pages.dev', vision: true, enabled: true, effort: 'high', encryptedKey: await key() },
      deepseek: { ...syntheticComparisonReviewModel, encryptedKey: await key() },
    } };
    const env = { DB, SETTINGS_KEY, modelStore: { get: async () => config } };
    const forge = localStorage();
    const forgeEnv = { ...env, ownerId: owner, FORGE_RUNNER: localRunner('/run', creationId, forge), captureReview: syntheticCapture };
    await enqueueForgeTask(forgeEnv, { type: 'game', id: 1, creative_version: 2 }, creationId);
    for (let index = 0; index < 8 && forge.takeAlarm(); index++) await creationPipelineAlarm(forge, forgeEnv, creationId);
    const creation = await DB.prepare('SELECT status,result FROM forge_tasks WHERE id=?').bind(creationId).first();
    assert.equal(creation?.status, 'done', 'Archived A creation did not complete');
    const product = JSON.parse(String(creation?.result));
    const version = await DB.prepare('SELECT id,content FROM artifact_versions WHERE id=? AND task_id=?').bind(product.version_id, creationId).first();
    assert(typeof version?.content === 'string' && sha(version.content) === product.content_hash);
    const artifact = { versionId: version.id, stageVersionId: product.stage_version_id, sha256: product.content_hash, disposition: product.disposition, path: 'artifact.html' };
    writeOnce(directory, artifact.path, version.content);
    save(directory, 'artifact.json', { scope, caseId, taskId: creationId, ...artifact });

    const reviewBindings = await seedSyntheticComparisonReviewRules(DB, canonicalJson, () => getActiveReviewRules(DB));
    let draftSha256: string | null = null;
    const review = localStorage(values => {
      if (values.get('cloudPhase') !== 'draft-ready') return;
      const count = Number(values.get('cloudStateParts'));
      const state = JSON.parse(Array.from({ length: count }, (_, index) => values.get(`cloudState:${index}`)).join(''));
      assert.deepEqual(state.draft, draft);
      save(directory, 'initial-draft.json', { scope, taskId: reviewId, report: state.draft });
      draftSha256 = sha(encode(state.draft));
    });
    const locked = sharedReview ?? lockReviewInput(version.content, syntheticCapture());
    reviewDispatch = { reviewEvidence: locked.evidence, ...reviewBindings };
    const reviewEnv = { ...env, modelExecutor: 'platform', REVIEW_RUNNER: localRunner('/start', reviewId, review),
      captureReview: async (html: string) => { assert.equal(html, locked.html); return structuredClone(locked.capture); } };
    await enqueueReview(reviewEnv, { request_id: reviewId, title: 'Synthetic paired review', html: locked.html }, 'admin');
    assert(review.takeAlarm(), 'Archived review runner was not scheduled');
    await cloudReviewAlarm(review, reviewEnv, reviewId);
    const forwardsBeforeRecovery = dispatches.length;
    if (scenario === 'persist-recovery') {
      assert.equal(failedWrites, 1);
      assert.equal(await review.storage.get('cloudPhase'), 'final-ready');
      assert(review.takeAlarm(), 'Archived review recovery did not schedule an alarm');
    }
    if (scenario !== 'success') await cloudReviewAlarm(review, reviewEnv, reviewId);
    assert.equal(dispatches.length, forwardsBeforeRecovery, 'Review re-forwarded during recovery');
    const reviewRow = await DB.prepare('SELECT status,stage,error,input_hash,report_schema_version,rules_snapshot FROM review_jobs WHERE id=?').bind(reviewId).first();
    assert.equal(reviewRow?.input_hash, locked.evidence.htmlSha256);
    assert.equal(reviewRow?.report_schema_version, 2);
    assert.equal(sha(canonicalJson(JSON.parse(String(reviewRow?.rules_snapshot)))), reviewBindings.rulesSha256);
    const saved = await DB.prepare('SELECT result FROM reviews WHERE job_id=?').bind(reviewId).first();
    if (scenario === 'unknown-response') {
      assert.equal(reviewRow?.status, 'error');
      assert.match(String(reviewRow.error), /连接提前结束/);
      assert(!saved && !draftSha256 && dispatches.length === 3);
    } else {
      assert.equal(reviewRow?.status, 'done');
      assert(draftSha256 && dispatches.length === 4);
      assert.deepEqual(JSON.parse(String(saved?.result)), final);
      save(directory, 'final-report.json', { scope, taskId: reviewId, report: final });
    }
    assert.equal(await review.storage.get('cloudPhase'), undefined);
    assert.equal((await DB.prepare('SELECT count(*) AS count FROM review_inputs WHERE job_id=?').bind(reviewId).first())?.count, 0);
    const metrics = (await DB.prepare('SELECT purpose,status,effort,max_tokens,input_tokens,output_tokens,finish_reason,attempts FROM model_runs ORDER BY rowid').all()).results;
    assert.equal(metrics.length, dispatches.length);
    save(directory, 'usage.json', { scope, metrics });
    return { schemaVersion: 1, scope, scenario, caseId, executionAllowed: false, formalImportAllowed: false,
      creation: { taskId: creationId, status: creation.status, ...artifact }, review: { taskId: reviewId, status: reviewRow?.status, draftSha256,
        evidence: locked.evidence, ...reviewBindings, inputOrigin: sharedReview ? 'shared-synthetic' : 'synthetic-a-artifact',
        interruptedResultUnknown: scenario === 'unknown-response', publicationRetried: failedWrites === 1 },
      materialSha256: Object.fromEntries(materialNames.map((name, index) => [name, sha(materials[index])])),
      scriptedForwards: dispatches.length, providerRequests: 0, networkOperations: 0, forwardsBeforeRecovery, failedWrites };
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, archivedRoot, directory, scenario] = process.argv.slice(2);
  if (command !== 'internal' || !scenarios.includes(scenario as Scenario)) {
    process.stderr.write('This entrypoint is invoked by runBaselineRehearsal.\n');
    process.exitCode = 1;
  } else {
    Promise.resolve().then(() => rehearse(archivedRoot, directory, scenario as Scenario, JSON.parse(readFileSync(0, 'utf8'))))
      .then(result => process.stdout.write(JSON.stringify(result))).catch(error => {
      process.stderr.write(`Baseline rehearsal failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    });
  }
}
