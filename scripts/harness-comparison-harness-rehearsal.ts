/** B-only offline rehearsal through the real platform runners, HarnessHost and provider Gateway. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { fileEntry, validateStart } from '../harness/envelope.mjs';
import { inspectStream } from '../harness/model-bridge.mjs';
import { cloudReviewAlarm } from '../server/cloud-review-runner';
import { creationPipelineAlarm } from '../server/forge-creation-pipeline';
import { enqueueForgeTask } from '../server/forge-tasks';
import { handleHarnessModelRequest } from '../server/harness-gateway';
import { authorizeHarnessTask, HarnessHost } from '../server/harness-host';
import { scopeHarnessOutbound, type HarnessOutboundScope } from '../server/harness-outbound-scope';
import { CCB_ENGINE_COMMIT, modelContractHash, type HarnessPolicy } from '../server/harness-policy';
import { HARNESS_MODEL_HEADERS } from '../server/harness-protocol';
import { enqueueReview } from '../server/review-jobs';
import { canonicalJson } from '../server/review-device-state';
import { getActiveReviewRules } from '../server/review-rules';
import { encryptKey, type ModelConfig } from '../server/settings';
import { configStore } from '../server/storage';
import { seedSyntheticComparisonReviewRules, syntheticComparisonReviewModel } from './harness-comparison-rehearsal-fixture';

const root = fileURLToPath(new URL('../', import.meta.url));
const scope = 'synthetic-offline-b-rehearsal';
const implementationCommit = '630303565f44c061c7ed8ad7b992dcc4e9db8929';
const image = 'registry.cloudflare.com/071443b43c7562efec975a5e964d5a9c/pgc-ccb-research@sha256:0e95a0406e8dc94b0a4eea1f2cb62ff2a31ff48261d8fca87923d99ebfcec957';
const caseId = 'tap-rhythm';
const materialNames = ['brief.md', 'sample.svg', 'assets.html'] as const;
const opusUrl = 'https://riffle-api.pages.dev/v1/messages';
const deepSeekUrl = 'https://api.deepseek.com/chat/completions';
const fixtureAt = syntheticComparisonReviewModel.updatedAt;
const scenarios = ['success', 'unknown-response', 'persist-recovery'] as const;
type Scenario = typeof scenarios[number];
type Phase = 'build' | 'polish' | 'review' | 'review_verify';
type NativeContext = NonNullable<ReturnType<typeof validateStart>>;
type OutboundProps = HarnessOutboundScope & { stageDeadlineAt: number; requestIdPrefix: string; jsonOutput: boolean };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const save = (directory: string, name: string, value: unknown) =>
  writeFileSync(join(directory, name), encode(value), { flag: 'wx', mode: 0o600 });

const adapterFile = fileURLToPath(import.meta.url);
const fixtureFile = join(root, 'scripts/harness-comparison-rehearsal-fixture.ts');
const adapterAtLoad = sha(readFileSync(adapterFile));
const fixtureAtLoad = sha(readFileSync(fixtureFile));
const runtimePaths = ['server', 'src', 'harness', 'migrations', 'fixtures/harness-evaluation', 'package-lock.json',
  'scripts/review-adaptive.ts', 'scripts/review-capture.ts'];

function verifySource() {
  const tree = execFileSync('/usr/bin/git', ['ls-tree', '-rz', implementationCommit, '--', ...runtimePaths], {
    cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  const entries = tree.split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    assert(match, 'Unexpected pinned B source tree entry');
    const [, , gitBlob, path] = match;
    const file = join(root, path);
    assert.equal(realpathSync(file), file, 'Pinned B source cannot be a symbolic link');
    const bytes = readFileSync(file);
    const actualBlob = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
    assert.equal(actualBlob, gitBlob, `Pinned B file changed: ${path}`);
    return [path, sha(bytes)] as const;
  });
  assert(entries.some(([path]) => path === 'server/harness-host.ts') && entries.some(([path]) => path === 'server/harness-gateway.ts'));
  const adapterSha256 = sha(readFileSync(adapterFile)), sharedFixtureSha256 = sha(readFileSync(fixtureFile));
  assert.equal(adapterSha256, adapterAtLoad, 'B rehearsal adapter changed after module load');
  assert.equal(sharedFixtureSha256, fixtureAtLoad, 'Shared rehearsal fixture changed after module load');
  return { implementationCommit, adapterSha256, sharedFixtureSha256, runtimeTreeSha256: sha(JSON.stringify(entries)),
    trackedRuntimeFiles: Object.fromEntries(entries) };
}

function localDatabase(sqlite: DatabaseSync, beforeBatch: (sql: string[]) => void) {
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const execute = () => {
      const result = sqlite.prepare(sql).run(...values);
      return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    };
    return {
      sql, execute, bind: (...next: SQLInputValue[]) => prepare(sql, next),
      first: async <T = Record<string, any>>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
      all: async <T = Record<string, any>>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
      run: async () => execute(),
    };
  }
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        beforeBatch(statements.map(statement => statement.sql));
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
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    deleteAll(): Promise<void>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    transaction<T>(operation: (tx: Storage) => Promise<T>): Promise<T>;
  };
  const storage: Storage = {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { return values.delete(key); },
    async deleteAll() { values.clear(); },
    async setAlarm(at: number) { alarm = at; },
    async deleteAlarm() { alarm = null; },
    async transaction<T>(operation: (tx: Storage) => Promise<T>): Promise<T> {
      const previous = structuredClone(values), priorAlarm = alarm;
      let result: T;
      try { result = await operation(storage); }
      catch (error) { values = previous; alarm = priorAlarm; throw error; }
      afterCommit?.(values);
      return result;
    },
  };
  return { storage, takeAlarm() { const scheduled = alarm !== null; alarm = null; return scheduled; } };
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

const pixels = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGAAAAAHAALpEtlMAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYmAAAAAKAANQonMOAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZmAAAAANAARPw/7SAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYWAAAAAQAAUm//d+AAAAAElFTkSuQmCC',
];
function syntheticCapture(html: string, context: 'creation-self-check' | 'review-baseline') {
  const capturedAt = new Date().toISOString();
  const actions = ['9:16', '9:19.5', '9:21'].map((ratio, index) => ({ id: `tap-${index + 1}`, ratio, type: 'tap', startedAt: capturedAt }));
  const shots = pixels.map((pixel, index) => ({
    id: `shot-${index + 1}`, label: `Synthetic screenshot ${index + 1}`, capturedAt,
    actionRefs: index ? [actions[index - 1].id] : [], data: `data:image/png;base64,${pixel}`,
  }));
  const observations = shots.map(({ data, ...metadata }) => metadata);
  return { inputHash: sha(html), shots, probe: { captureMethod: 'browser-viewport-v1', actions, observations,
    note: `Synthetic fixture only (${context})` } };
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
function gameOutput(phase: 'build' | 'polish', assetsScript: string) {
  const html = `<!doctype html>\n<html lang="en"><head><title>Synthetic B</title><meta name="viewport" content="width=device-width"></head>\n<body><button>${phase}</button>${assetsScript}</body></html>`;
  const record = {
    requirements: [{ id: 'synthetic-goal', text: 'Synthetic scenario', status: 'implemented' }], decisions: [], coreChanges: [],
    ...(phase === 'polish' ? { selfCheck: { findings: [], unverified: [], changes: [], requestRepair: false } } : {}),
  };
  return sse([{ type: 'message_start', message: { usage: { input_tokens: 22 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify({ html, record }) } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 35 } }, { type: 'message_stop' }]);
}

type Forward = {
  taskId: string; phase: Phase; requestId: string; destination: string; idempotencyKeySha256: string;
  bodySha256: string; model: string; effort: string; outputCap: number; imageSha256: string[]; at: string;
};
type NativeReceipt = {
  taskId: string; runId: string; phase: Phase; envelopeSha256: string; inputImageSha256: string[];
  outputCap: number; aggregateOutputCap: number; maxModelTurns: number; maxRepairs: number;
  state: 'succeeded' | 'failed';
};

function offlineHarness(options: {
  DB: ReturnType<typeof localDatabase>;
  SETTINGS_KEY: string;
  modelStore: ReturnType<typeof configStore>;
  scenario: Scenario;
  assetsScript: string;
  keys: { opus: string; deepseek: string };
}) {
  const dispatches: Forward[] = [], nativeReceipts: NativeReceipt[] = [];
  let baselineReview: { system: unknown; user: unknown[]; schema: unknown; images: string[] } | undefined;
  let expectedReview: { html: string; probe: ReturnType<typeof syntheticCapture>['probe']; shotSha256: string[] } | undefined;
  let allocations = 0, destructions = 0;
  const hosts = new Map<string, HarnessHost>();
  const fetcher = (context: NativeContext, requestId: string): typeof fetch => async (target, init) => {
    const phase = context.run.phase as Phase;
    const creation = phase === 'build' || phase === 'polish';
    const destination = String(target);
    assert.equal(destination, creation ? opusUrl : deepSeekUrl);
    assert(init?.method === 'POST' && typeof init.body === 'string' && init.redirect === 'manual' && init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get(creation ? 'x-api-key' : 'authorization'), creation ? options.keys.opus : `Bearer ${options.keys.deepseek}`);
    assert.equal(headers.has(HARNESS_MODEL_HEADERS.task), false);
    const key = headers.get('idempotency-key') ?? '';
    assert.match(key, /^pgc-harness-[a-f0-9]{64}$/);
    const body = JSON.parse(init.body);
    assert.equal(body.model, creation ? 'claude-opus-5-5' : 'deepseek-flash');
    assert.equal(body.stream, true);
    const outputCap = body.max_tokens;
    assert.equal(outputCap, creation ? 64_000 : 24_000);
    const effort = creation ? body.output_config?.effort : body.reasoning_effort;
    assert.equal(effort, creation ? 'high' : 'low');
    assert.equal(body.thinking?.type, creation ? 'adaptive' : 'enabled');
    if (!creation) {
      assert.equal(body.response_format?.type, 'json_object');
      assert.equal(body.stream_options?.include_usage, true);
    }
    const imageSha256 = body.messages.flatMap((message: { content?: unknown }) => Array.isArray(message.content) ? message.content : [])
      .flatMap((part: any) => {
        const data = part.source?.data ?? part.image_url?.url?.split(',')[1];
        return typeof data === 'string' ? [sha(Buffer.from(data, 'base64'))] : [];
      });
    assert.deepEqual(imageSha256, context.images.map(part => sha(Buffer.from(part.source.data, 'base64'))));
    assert.equal(imageSha256.length, phase === 'build' ? 0 : 4);
    dispatches.push({ taskId: context.run.taskId, phase, requestId, destination, idempotencyKeySha256: sha(key), bodySha256: sha(init.body),
      model: body.model, effort, outputCap, imageSha256, at: new Date().toISOString() });
    if (creation) return gameOutput(phase, options.assetsScript);
    const content = { choices: [{ delta: { content: JSON.stringify(phase === 'review' ? draft : final) } }] };
    if (options.scenario === 'unknown-response' && phase === 'review') return sse([content]);
    return sse([content, { choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 55, completion_tokens: 72, completion_tokens_details: { reasoning_tokens: 5 } } }, '[DONE]']);
  };

  function newHost(taskId: string) {
    const { storage } = localStorage();
    let control = '', props: OutboundProps | undefined, context: NativeContext | undefined;
    let terminal: NativeReceipt['state'] | undefined, files: ReturnType<typeof fileEntry>[] = [];
    let executing: Promise<void> | undefined;
    const seenRuns = new Set<string>();
    const container = {
      running: false, images: { ccb: image },
      start(startOptions: { image: string; enableInternet: boolean; env: Record<string, string> }) {
        assert.equal(startOptions.image, image);
        assert.equal(startOptions.enableInternet, false);
        assert.equal(startOptions.env.PGC_HARNESS_GATEWAY_URL, 'http://pgc-harness.internal');
        assert.equal(container.running, false);
        control = startOptions.env.PGC_HARNESS_CONTROL_TOKEN;
        container.running = true; props = undefined; context = undefined; terminal = undefined; executing = undefined; files = [];
        allocations++;
      },
      async interceptAllOutboundHttp(value: OutboundProps) { assert.equal(value.taskId, taskId); props = value; },
      async interceptOutboundHttps(host: string, value: OutboundProps) { assert.equal(host, '*'); assert.equal(value, props); },
      async setInactivityTimeout(duration: number) { assert.equal(duration, 60_000); },
      async destroy() { assert(container.running); container.running = false; destructions++; },
      getTcpPort(port: number) { assert.equal(port, 8080); return { fetch: nativeFetch }; },
    };

    async function execute(native: NativeContext, outbound: OutboundProps) {
      const phase = native.run.phase as Phase;
      const creation = phase === 'build' || phase === 'polish';
      const inputImages = native.images.map(part => sha(Buffer.from(part.source.data, 'base64')));
      const lockedFile = native.files.get('input/materials.json');
      assert(lockedFile);
      const material = JSON.parse(lockedFile.content);
      if (!creation) {
        assert.equal(outbound.jsonOutput, true);
        assert(expectedReview);
        assert.deepEqual(inputImages, expectedReview.shotSha256);
        const sourceMarker = '\n【源码】\n';
        const original = material.user.find((part: { text?: string }) => part.text?.includes(sourceMarker))?.text;
        assert.equal(original?.split(sourceMarker).at(-1), expectedReview.html);
        assert(original?.includes(JSON.stringify(expectedReview.probe, null, 1)));
        const comparable = { system: material.system, user: material.user, schema: material.schema, images: inputImages };
        if (phase === 'review') baselineReview = structuredClone(comparable);
        else {
          assert(baselineReview);
          const last = comparable.user.at(-1);
          assert(last?.text.includes(JSON.stringify(draft)));
          comparable.user = comparable.user.slice(0, -1);
          assert.deepEqual(comparable, baselineReview);
        }
      } else if (phase === 'polish') {
        assert(native.files.get('input/game.html'));
      }
      const system = native.run.systemPrompt;
      assert(typeof system === 'string' && system.length > 0);
      const prompt = creation ? native.run.prompt + '\n\n' + lockedFile.content : native.run.prompt;
      const parts = [{ type: 'text', text: prompt }, ...(creation ? native.images : native.images.map(part => ({
        type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
      })))];
      const messages = [...(creation ? [] : [{ role: 'system', content: system }]), { role: 'user', content: parts }];
      const path = creation ? '/v1/messages' : '/v1/chat/completions';
      const requestId = outbound.requestIdPrefix + randomUUID();
      const request = scopeHarnessOutbound(new Request('http://pgc-harness.internal' + path, {
        method: 'POST', headers: { 'content-type': 'application/json', [HARNESS_MODEL_HEADERS.requestId]: requestId },
        body: JSON.stringify({ model: native.run.model, ...(creation ? { system } : {}), messages, stream: true, max_tokens: native.run.maxOutputTokens }),
      }), outbound);
      assert(request);
      const response = await handleHarnessModelRequest(request, { DB: options.DB,
        settingsKey: options.SETTINGS_KEY, loadConfig: options.modelStore.get, authorizeRun: run => authorizeHarnessTask(options, run),
        deadlineAt: outbound.stageDeadlineAt, requestIdPrefix: outbound.requestIdPrefix,
        jsonOutput: outbound.jsonOutput, reviewPhase: creation ? undefined : phase, allowTransportRetry: false, fetcher: fetcher(native, requestId),
      });
      try {
        assert(response.ok && response.body);
        const inspector = inspectStream(native.run.protocol, new Set());
        const chunks: Buffer[] = [];
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          inspector.push(chunk);
          chunks.push(Buffer.from(chunk));
        }
        inspector.finish();
        const generated = Buffer.concat(chunks).toString().split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
          .map(line => JSON.parse(line.slice(6))).map(event => creation ? event.delta?.text : event.choices?.[0]?.delta?.content)
          .filter(Boolean).join('');
        const value = JSON.parse(generated);
        files = creation ? [fileEntry('game.html', value.html), fileEntry('record.json', JSON.stringify(value.record))]
          : [fileEntry('result.txt', generated)];
        terminal = 'succeeded';
      } catch {
        terminal = 'failed';
      }
      nativeReceipts.push({ taskId, runId: native.run.runId, phase, envelopeSha256: native.envelopeSha256, inputImageSha256: inputImages,
        outputCap: native.run.maxOutputTokens, aggregateOutputCap: native.run.maxTotalOutputTokens,
        maxModelTurns: native.run.maxModelTurns, maxRepairs: native.run.maxRepairs, state: terminal });
    }

    async function nativeFetch(request: Request) {
      assert(container.running);
      assert.equal(request.headers.get('authorization'), `Bearer ${control}`);
      const { pathname } = new URL(request.url);
      if (pathname === '/v1/start' && request.method === 'POST') {
        const validated = validateStart(await request.json(), Date.now());
        assert(validated && props && !context && !seenRuns.has(validated.run.runId));
        assert.equal(validated.run.taskId, taskId);
        assert.equal(validated.run.generation, props.generation);
        assert.equal(validated.lease, props.lease);
        assert.equal(request.headers.get('x-pgc-harness-run'), validated.run.runId);
        seenRuns.add(validated.run.runId);
        context = validated;
        return Response.json({ state: 'running' }, { status: 202 });
      }
      if (pathname === '/v1/status' && request.method === 'GET') {
        if (!context) return Response.json({}, { status: 404 });
        assert.equal(request.headers.get('x-pgc-harness-run'), context.run.runId);
        assert(props);
        executing ??= execute(context, props);
        await executing;
        return Response.json({ runId: context.run.runId, state: terminal });
      }
      if (pathname === '/v1/result' && request.method === 'GET' && context && terminal === 'succeeded') {
        assert.equal(request.headers.get('x-pgc-harness-run'), context.run.runId);
        return Response.json({ runId: context.run.runId, state: terminal, files });
      }
      return Response.json({}, { status: 404 });
    }
    return new HarnessHost({ storage, container, exports: { HarnessOutbound: ({ props }: { props: OutboundProps }) => props } }, options);
  }

  return { dispatches, nativeReceipts, closure: () => ({ allocations, destructions }),
    lockReview(value: NonNullable<typeof expectedReview>) {
      assert.equal(expectedReview, undefined);
      expectedReview = structuredClone(value);
    },
    binding: { idFromName: (id: string) => id, get(id: string) {
      if (!hosts.has(id)) hosts.set(id, newHost(id));
      return hosts.get(id)!;
    } } };
}

/** No configurable network or credentials. All material and boundaries are synthetic. */
export async function runHarnessRehearsal({ out, scenario = 'success' }: { out: string; scenario?: Scenario }) {
  assert(scenarios.includes(scenario), 'Unknown Harness rehearsal scenario');
  assert(out && !out.split(/[\\/]/).includes('..'), 'Use a fresh private rehearsal directory');
  const output = resolve(out);
  assert.equal(realpathSync(dirname(output)), dirname(output), 'Rehearsal parent must not use symbolic links');
  const sourceAtStart = verifySource();
  mkdirSync(output, { mode: 0o700 });
  save(output, 'source.json', { schemaVersion: 1, scope, ...sourceAtStart });
  const materials = materialNames.map(name => readFileSync(join(root, 'fixtures/harness-evaluation', caseId, name), 'utf8'));
  const assetsScript = materials[2].match(/<script\b[^>]*id=["']game-assets["'][^>]*>[\s\S]*?<\/script>/i)?.[0];
  assert(assetsScript, 'Synthetic asset script missing');
  const sqlite = new DatabaseSync(':memory:');
  try {
    const migrations = Object.keys(sourceAtStart.trackedRuntimeFiles).filter(path => path.startsWith('migrations/') && path.endsWith('.sql')).sort();
    assert(migrations.at(-1)?.startsWith('migrations/0034_'), 'Unexpected B migration set');
    for (const path of migrations) sqlite.exec(readFileSync(join(root, path), 'utf8'));
    let failedWrites = 0;
    const DB = localDatabase(sqlite, statements => {
      if (scenario === 'persist-recovery' && failedWrites === 0 && statements.some(sql => sql.startsWith('INSERT OR IGNORE INTO reviews('))) {
        failedWrites++;
        throw new Error('Synthetic final report D1 failure');
      }
    });
    const at = new Date().toISOString(), owner = 'synthetic-star';
    const creationId = randomUUID(), reviewId = randomUUID();
    sqlite.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,star) VALUES(?,?,?,'local','local',?,?,1)")
      .run(owner, owner, owner, at, at);
    sqlite.prepare("INSERT INTO topics(id,owner_id,batch,subject,medium,gesture,structure,mood,created_at,updated_at,brief_md,preview_svg,assets_html) VALUES(1,?,'local','rhythm','local','tap','local','local',?,?,?,?,?)")
      .run(owner, at, at, ...materials);
    const SETTINGS_KEY = randomUUID(), keys = { opus: randomUUID(), deepseek: randomUUID() };
    const opus = { protocol: 'anthropic' as const, model: 'claude-opus-5-5', baseUrl: 'https://riffle-api.pages.dev',
      effort: 'high' as const, vision: true, enabled: true, updatedAt: fixtureAt, maxOutputTokens: 0, encryptedKey: await encryptKey(keys.opus, SETTINGS_KEY) };
    const deepseek = { ...syntheticComparisonReviewModel, encryptedKey: await encryptKey(keys.deepseek, SETTINGS_KEY) };
    const config: ModelConfig = { ...opus, activeProfile: 'opus', routes: { create: 'opus', review: 'deepseek' }, profiles: { opus, deepseek } };
    const modelStore = configStore(DB);
    await modelStore.set(config);
    const fake = offlineHarness({ DB, SETTINGS_KEY, modelStore, scenario, assetsScript, keys });
    const env = { DB, SETTINGS_KEY, ADMIN_PASSWORD: 'synthetic-unused', modelStore, HARNESS_RUNNER: fake.binding };
    const gameContract = await modelContractHash(config, 'game'), reviewContract = await modelContractHash(config, 'review');
    assert.equal(await modelContractHash(config, 'review_verify'), reviewContract);
    const policy = { version: 1 as const, engine: 'ccb' as const, engineCommit: CCB_ENGINE_COMMIT, image,
      releaseHash: sha('synthetic local B policy attestation') };
    const gamePolicy: HarnessPolicy = { ...policy, family: 'forge', purpose: 'game', modelContractHash: gameContract,
      limits: { maxOutputTokens: 64_000, maxTotalOutputTokens: 256_000, maxModelTurns: 24, maxDurationMs: 2_400_000, maxRepairs: 2 } };
    const reviewPolicy: HarnessPolicy = { ...policy, family: 'review', purpose: 'review', modelContractHash: reviewContract,
      limits: { maxOutputTokens: 24_000, maxTotalOutputTokens: 48_000, maxModelTurns: 8, maxDurationMs: 720_000, maxRepairs: 0 } };
    const forge = localStorage();
    const creationCaptures: string[] = [];
    const forgeEnv = { ...env, ownerId: owner, FORGE_RUNNER: localRunner('/run', creationId, forge),
      async captureReview(html: string) {
        const capture = syntheticCapture(html, 'creation-self-check');
        creationCaptures.push(capture.inputHash);
        return capture;
      } };
    const queued = await enqueueForgeTask(forgeEnv, { type: 'game', id: 1, requestId: creationId, creative_version: 2 }, creationId);
    assert.equal(queued.id, creationId);
    const lockedGame = await DB.prepare(`UPDATE forge_tasks SET harness_policy=? WHERE id=? AND owner_id=? AND kind='game'
      AND executor='platform' AND status='queued' AND creative_version=2 AND harness_policy IS NULL`)
      .bind(JSON.stringify(gamePolicy), creationId, owner).run();
    assert.equal(lockedGame.meta.changes, 1);
    for (let attempt = 0; attempt < 8 && forge.takeAlarm(); attempt++) await creationPipelineAlarm(forge, forgeEnv, creationId);
    const creation = await DB.prepare('SELECT status,result,error FROM forge_tasks WHERE id=?').bind(creationId).first();
    assert.equal(creation?.status, 'done', `Synthetic B creation did not complete: ${creation?.error ?? 'no task'}`);
    const product = JSON.parse(String(creation?.result));
    const version = await DB.prepare('SELECT id,content FROM artifact_versions WHERE id=? AND task_id=? AND owner_id=?')
      .bind(product.version_id, creationId, owner).first<{ id: string; content: string }>();
    assert(version && sha(version.content) === product.content_hash);
    const stages = (await DB.prepare(`SELECT stage,version_id,content_hash,input_hash,evidence_hash FROM forge_creation_stages
      WHERE task_id=? ORDER BY CASE stage WHEN 'build' THEN 1 ELSE 2 END`).bind(creationId).all()).results;
    assert.deepEqual(stages.map(value => value.stage), ['build', 'polish']);
    assert.deepEqual(stages.map(value => value.content_hash), creationCaptures);
    assert.equal(stages[1].version_id, product.stage_version_id);
    const artifact = { versionId: version.id, stageVersionId: product.stage_version_id as string,
      sha256: product.content_hash as string, disposition: product.disposition as string, path: 'artifact.html' };
    writeFileSync(join(output, artifact.path), version.content, { flag: 'wx', mode: 0o600 });
    save(output, 'artifact.json', { scope, caseId, taskId: creationId, ...artifact, stages });

    const reviewBindings = await seedSyntheticComparisonReviewRules(DB, canonicalJson, () => getActiveReviewRules(DB));

    const evidence = syntheticCapture(version.content, 'review-baseline');
    const reviewDigests = { htmlSha256: evidence.inputHash, probeSha256: sha(JSON.stringify(evidence.probe)),
      shotSha256: evidence.shots.map(shot => sha(Buffer.from(shot.data.split(',')[1], 'base64'))) };
    const reviewInput = { html: version.content, probe: evidence.probe, shots: evidence.shots, ...reviewDigests };
    fake.lockReview(reviewInput);
    save(output, 'review-input.json', { scope, ...reviewInput });
    let initialReport: unknown, reviewCaptures = 0;
    const review = localStorage(values => {
      if (values.get('cloudPhase') !== 'draft-ready') return;
      const count = Number(values.get('cloudStateParts'));
      const state = JSON.parse(Array.from({ length: count }, (_, index) => values.get(`cloudState:${index}`)).join(''));
      initialReport = state.draft;
    });
    const reviewEnv = { ...env, modelExecutor: 'platform' as const, REVIEW_RUNNER: localRunner('/start', reviewId, review),
      captureReview: async (html: string) => { assert.equal(sha(html), evidence.inputHash); reviewCaptures++; return structuredClone(evidence); } };
    await enqueueReview(reviewEnv, { request_id: reviewId, title: 'Synthetic paired review', html: version.content }, 'admin');
    const lockedReview = await DB.prepare(`UPDATE review_jobs SET harness_policy=? WHERE id=? AND owner_id='admin' AND model_executor='platform'
      AND executor='cloud' AND status='queued' AND input_ready=1 AND input_hash=? AND report_schema_version=2 AND harness_policy IS NULL`)
      .bind(JSON.stringify(reviewPolicy), reviewId, evidence.inputHash).run();
    assert.equal(lockedReview.meta.changes, 1);
    assert(review.takeAlarm());
    await cloudReviewAlarm(review, reviewEnv, reviewId);
    const forwardsBeforeRecovery = fake.dispatches.length;
    if (scenario === 'persist-recovery') {
      assert.equal(failedWrites, 1);
      assert.equal(await review.storage.get('cloudPhase'), 'final-ready');
      assert.equal(await DB.prepare('SELECT id FROM reviews WHERE job_id=?').bind(reviewId).first(), null);
      assert(review.takeAlarm(), 'Final report recovery was not scheduled');
    }
    if (scenario !== 'success') await cloudReviewAlarm(review, reviewEnv, reviewId);
    assert.equal(fake.dispatches.length, forwardsBeforeRecovery, 'B review re-forwarded during recovery');
    assert.equal(reviewCaptures, 1);
    const reviewRow = await DB.prepare('SELECT status,error,input_hash,report_schema_version,rules_snapshot FROM review_jobs WHERE id=?')
      .bind(reviewId).first();
    assert.equal(reviewRow?.input_hash, artifact.sha256);
    assert.equal(reviewRow?.report_schema_version, 2);
    assert.equal(sha(canonicalJson(JSON.parse(String(reviewRow?.rules_snapshot)))), reviewBindings.rulesSha256);
    const storedReview = await DB.prepare('SELECT result,probe,shots FROM reviews WHERE job_id=?').bind(reviewId).first();
    let draftSha256: string | null = null, finalSha256: string | null = null;
    if (scenario === 'unknown-response') {
      assert.equal(reviewRow?.status, 'error');
      assert.equal(storedReview, null);
      assert.equal(initialReport, undefined);
      assert.equal(fake.dispatches.length, 3);
    } else {
      assert.equal(reviewRow?.status, 'done', `Synthetic B review did not complete: ${reviewRow?.error ?? 'no job'}`);
      assert.deepEqual(initialReport, draft);
      const finalReport = JSON.parse(String(storedReview?.result));
      assert.deepEqual(finalReport, final);
      assert.deepEqual(JSON.parse(String(storedReview?.shots)), evidence.shots);
      const { evidenceOrigin, ...storedProbe } = JSON.parse(String(storedReview?.probe));
      assert.equal(evidenceOrigin, 'admin-upload');
      assert.deepEqual(storedProbe, evidence.probe);
      assert.equal(fake.dispatches.length, 4);
      draftSha256 = sha(encode(initialReport));
      finalSha256 = sha(encode(finalReport));
      save(output, 'initial-draft.json', { scope, taskId: reviewId, report: initialReport });
      save(output, 'final-report.json', { scope, taskId: reviewId, report: finalReport });
    }
    assert.equal(await review.storage.get('cloudPhase'), undefined);
    assert.equal((await DB.prepare('SELECT COUNT(*) AS count FROM review_inputs WHERE job_id=?').bind(reviewId).first())?.count, 0);
    const requests = (await DB.prepare(`SELECT task_id,generation,request_id,body_hash,output_cap,state,attempts,http_status,
      created_at,forwarded_at,finished_at,input_tokens,output_tokens,reasoning_tokens,error_code,finish_reason
      FROM harness_requests ORDER BY rowid`).all()).results;
    assert.equal(requests.length, fake.dispatches.length);
    const dispatches = fake.dispatches.map((forward, index) => {
      const request = requests[index];
      assert(request.task_id === forward.taskId && request.request_id === forward.requestId && request.attempts === 1);
      assert.equal(request.body_hash, forward.bodySha256);
      assert.equal(request.output_cap, forward.outputCap);
      if (forward.phase === 'review' || forward.phase === 'review_verify') assert.deepEqual(forward.imageSha256, reviewDigests.shotSha256);
      const reviewMaterial = forward.phase === 'review' || forward.phase === 'review_verify'
        ? { reviewEvidence: reviewDigests, ...reviewBindings } : {};
      const receipt = { scope, ...forward, ...reviewMaterial, ledger: request };
      save(output, `dispatch-${index + 1}.json`, receipt);
      return receipt;
    });
    if (scenario === 'unknown-response') assert.deepEqual(requests.map(request => request.state), ['completed', 'completed', 'unknown']);
    else assert(requests.every(request => request.state === 'completed'));
    const runs = (await DB.prepare(`SELECT task_id,status,model_turns,output_tokens,reserved_tokens,released_at,max_model_turns,total_output_cap
      FROM harness_runs ORDER BY rowid`).all()).results;
    assert.equal(runs.length, 2);
    assert(runs.every(run => run.released_at !== null));
    assert.deepEqual(runs.map(run => [run.status, run.reserved_tokens]),
      [['done', 0], scenario === 'unknown-response' ? ['unknown', 24_000] : ['done', 0]]);
    const closure = fake.closure();
    assert.deepEqual(closure, { allocations: requests.length, destructions: requests.length });
    const sourceAtEnd = verifySource();
    assert.deepEqual(sourceAtEnd, sourceAtStart, 'Pinned B source changed during rehearsal');
    const sourceVerification = { sourceReceiptSha256: sha(readFileSync(join(output, 'source.json'))),
      adapterSha256: sourceAtStart.adapterSha256, sharedFixtureSha256: sourceAtStart.sharedFixtureSha256,
      runtimeTreeSha256: sourceAtStart.runtimeTreeSha256, runtimeTreeEndSha256: sourceAtEnd.runtimeTreeSha256,
      verifiedTrackedRuntimeFiles: Object.keys(sourceAtStart.trackedRuntimeFiles).length };
    const result = { schemaVersion: 1, scope, scenario, caseId, implementationCommit, policyImage: image, sourceVerification,
      engineCommit: CCB_ENGINE_COMMIT, executionAllowed: false, formalImportAllowed: false,
      syntheticBoundaries: ['isolated-sqlite', 'rollback-memory-do', 'native-container', 'ccb-engine', 'viewport-capture', 'provider-stream'],
      creation: { taskId: creationId, status: creation.status, ...artifact, stages, modelContractHash: gameContract },
      review: { taskId: reviewId, status: reviewRow?.status, draftSha256, finalSha256, evidence: reviewDigests,
        modelContractHash: reviewContract, ...reviewBindings, interruptedResultUnknown: scenario === 'unknown-response', publicationRetried: failedWrites === 1 },
      materialSha256: Object.fromEntries(materialNames.map((name, index) => [name, sha(materials[index])])),
      scriptedForwards: dispatches.length, providerRequests: 0, networkOperations: 0, realContainers: 0,
      forwardsBeforeRecovery, failedWrites, dispatches, nativeReceipts: fake.nativeReceipts, runs, closure };
    save(output, 'verification.json', result);
    return { output, result, reviewInput };
  } finally {
    sqlite.close();
  }
}
