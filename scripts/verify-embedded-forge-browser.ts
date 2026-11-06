import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response, type Request } from 'miniflare';
import puppeteer, { type Browser } from 'puppeteer-core';
import { validateCreationOutput } from '../server/forge-creation-pipeline';
import { findChrome } from '../server/local-browser';
import { captureReview } from '../server/review-probe';

const root = fileURLToPath(new URL('../', import.meta.url));
const model = 'claude-opus-5-5';
const endpoint = 'https://embedded-forge-provider.invalid/v1/messages';
const syntheticKey = 'embedded-forge-synthetic-provider';
const task = '89aa9c25-9ff7-4776-9d29-9d716b583bfe';
const reviewTask = '06c4d95b-2a53-4af4-9ca8-3bbc2866192f';
const reviewModel = 'deepseek-v4-flash';
const reviewEndpoint = 'https://api.deepseek.com/chat/completions';
const reviewSyntheticKey = 'embedded-review-synthetic-provider';
const authorCanary = 'CREATION_SELF_CHECK_PRIVATE_CANARY';
const humanCanary = 'SAME_VERSION_HUMAN_ANSWER_CANARY';
const calibrationCanary = 'OTHER_SYNTHETIC_CALIBRATION_CANARY';
const draftCanary = 'INDEPENDENT_INITIAL_DRAFT_CANARY';
const finalCanary = 'INDEPENDENT_VERIFIED_RESULT_CANARY';
const reviewDraft = {
  schema_version: 2, assessment_status: 'needs_review', aes: 2, ease: 2, play: null,
  score_reasons: { aes: 'Synthetic screenshot observation', ease: 'Synthetic visible prompt and tap', play: 'Sustained play unverified' },
  uncertainties: ['Sustained play unverified'], verdict: '待复核：长期体验未知', reviewer_comment: draftCanary,
  strengths: [], issues: [], optional_suggestions: [], fix_prompt: '',
};
const verifiedReport = { ...reviewDraft, reviewer_comment: finalCanary };
const syntheticHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tap Relay Fixture</title><style>*{box-sizing:border-box}body{margin:0;display:grid;place-items:center;min-height:100dvh;background:#132533;color:white;font:22px sans-serif}
main{display:grid;place-items:center;width:min(100vw,56.25dvh);height:100dvh;position:relative;background:#1c394d}
button{position:absolute;top:54%;width:78%;height:15%;background:#b76828;color:white;font:inherit;border:3px solid white;border-radius:16px;touch-action:manipulation}
output{position:absolute;top:24%}</style></head><body><main><output id="score">Score 0</output><button id="target">Tap relay</button></main>
<script>let n=0;document.getElementById('target').onclick=()=>{document.getElementById('score').textContent='Score '+(++n);};</script></body></html>`;
const polishedHtml = syntheticHtml.replace('#b76828', '#117464');
const buildRecord = {
  requirements: [{ id: 'tap', text: 'Tap increases the visible count', status: 'implemented' }],
  decisions: ['Synthetic tap fixture'], coreChanges: [],
};
const polishRecord = { ...buildRecord, selfCheck: { findings: [], unverified: ['Long-term play'], changes: ['Adjusted button color', authorCanary], requestRepair: false } };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const manifest = (contents: string) => ({ mainModule: 'index.js', modules: { 'index.js': { type: 'esm' as const, contents } } });
const fixtureWorker = String.raw`
import { ForgeRunner } from './server/forge-runner';
import { ReviewRunner } from './server/review-runner';
import { enqueueReview } from './server/review-jobs';
import { reviewRulesAdmin } from './server/review-rules';
import { configStore } from './server/storage';
import { enqueueForgeTask } from './server/forge-tasks';
import { CCB_ENGINE_COMMIT, EMBEDDED_CCB_VERSION, harnessHash, modelContractHash } from './server/harness-policy';
import { encryptKey } from './server/settings';
function localBrowserEnvironment(env) {
    const browserCall = async (route, body) => {
      const response = await env.LOCAL_BROWSER.fetch('https://local-browser.invalid/' + route, {
        method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error('Local Chromium ' + route + ' failed.');
      return response.json();
    };
    return {
      ...env,
      BROWSER: {
        closeSession: sessionId => browserCall('close', { sessionId }),
        getSession: sessionId => browserCall('status', { sessionId }),
      },
      captureReview: async (html, onWait, deadlineAt, _options, lifecycle) => {
        if (!lifecycle) throw new Error('Embedded baseline capture lifecycle was not wired.');
        await onWait('Local Chromium fixture capturing full viewports.');
        await lifecycle.acquiring();
        const { sessionId } = await browserCall('launch', {});
        try {
          await lifecycle.acquired(sessionId);
          return await browserCall('capture', { sessionId, html, deadlineAt });
        } finally {
          if ((await browserCall('close', { sessionId })).status !== 'closed') throw new Error('Local Chromium close unconfirmed.');
          await lifecycle.closed(sessionId);
        }
      },
    };
}
export class LocalForgeRunner extends ForgeRunner {
  constructor(state, env) { super(state, localBrowserEnvironment(env)); }
}
export class LocalReviewRunner extends ReviewRunner {
  constructor(state, env) { super(state, localBrowserEnvironment(env)); }
}
async function syntheticRelease(config, coreBundleSha256) {
  const contracts = await Promise.all(['game', 'review'].map(purpose => modelContractHash(config, purpose)));
  // Isolated fixture registration, never consumed by deployment.
  return JSON.stringify({ engine: 'ccb-embedded', engineCommit: CCB_ENGINE_COMMIT, coreVersion: EMBEDDED_CCB_VERSION,
    coreParityVerified: true, coreBundleSha256, rightsConfirmed: true, providerCompatibilityVerified: true, comparisonAccepted: true, isolationVerified: true,
    evidenceHash: 'e'.repeat(64), compatibleModelContracts: contracts, contextWindows: Object.fromEntries(contracts.map(hash => [hash, 150000])) });
}
async function enqueueSyntheticReview(env) {
  const html = await env.DB.prepare('SELECT product_html FROM topics WHERE id=9').first('product_html');
  if (typeof html !== 'string') throw new Error('Original Forge artifact is missing.');
  const inputHash = await harnessHash(html);
  const at = new Date().toISOString();
  const title = 'Tap Relay Fixture';
  const priorId = 'e3443a4f-693e-4a0c-8f6f-9313d96926bc';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO review_jobs(id,owner_id,title,status,created_at,updated_at,input_hash) VALUES(?,'fixture-member',?,'done',?,?,?)")
      .bind(priorId,title,at,at,inputHash),
    env.DB.prepare("INSERT INTO review_human_reviews(job_id,owner_id,device_id,request_id,payload_hash,work_id,version_id,score,feedback," +
      "source_updated_at,source,status,phase,matched_by,uploaded_content_hash,display_rank,is_current,created_at)" +
      " VALUES(?,'fixture-member','synthetic-device','synthetic-request',?,'synthetic-work','synthetic-version',9,?,?,'synthetic','reviewed','final','user-confirmed',?,1,1,?)")
      .bind(priorId,inputHash,'SAME_VERSION_HUMAN_ANSWER_CANARY',at,inputHash,at),
  ]);
  const rules = body => reviewRulesAdmin(new Request('https://local-forge.test/review-rules', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env.DB);
  const { candidate } = await rules({ action: 'import', snapshot: {
    sourceUrl: 'https://creator-hub-7mi.pages.dev/#/', capturedAt: at,
    rawDirection: 'Synthetic published direction. Use only the locked evidence.',
    rawScoring: 'Synthetic published scale. Unknown evidence remains unknown.',
    calibrationCases: [
      { id: 'same-case', title, evidence: 'SAME_VERSION_HUMAN_ANSWER_CANARY', score: null, rationale: 'Synthetic same-game exclusion' },
      { id: 'other-case', title: 'Different Example', evidence: 'OTHER_SYNTHETIC_CALIBRATION_CANARY', score: null, rationale: 'Synthetic unrelated calibration' },
    ],
  } });
  const { active } = await rules({ action: 'publish', id: candidate.id, expectedActiveId: null });
  const modelStore = configStore(env.DB);
  const HARNESS_RELEASE = await syntheticRelease(await modelStore.get(), env.LOCAL_BUNDLE_SHA);
  const row = await enqueueReview({ ...localBrowserEnvironment(env), modelExecutor: 'platform', modelStore,
    HARNESS_ROLLOUT: 'pilot', HARNESS_RELEASE }, { request_id: '06c4d95b-2a53-4af4-9ca8-3bbc2866192f', html, title }, 'admin');
  return Response.json({ taskId: row.id, status: row.status, schemaVersion: row.report_schema_version, inputHash, rulesSha256: active.contentHash });
}
export default { async fetch(request, env) {
  if (request.method !== 'POST') return new Response(null, { status: 404 });
  const route = new URL(request.url).pathname;
  if (route === '/enqueue-review') return enqueueSyntheticReview(env);
  if (route !== '/enqueue') return new Response(null, { status: 404 });
  const at = new Date().toISOString();
  const profile = { model: 'claude-opus-5-5', baseUrl: 'https://embedded-forge-provider.invalid', protocol: 'anthropic',
    encryptedKey: await encryptKey('embedded-forge-synthetic-provider', env.SETTINGS_KEY), enabled: true, updatedAt: at, vision: true };
  const review = { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', protocol: 'openai',
    encryptedKey: await encryptKey('embedded-review-synthetic-provider', env.SETTINGS_KEY), enabled: true, updatedAt: at, vision: true };
  const config = { ...profile, activeProfile: 'default', profiles: { default: profile, review }, routes: { create: 'default', review: 'review' } };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO settings(id,value,updated_at) VALUES(?,?,?)').bind('model', JSON.stringify(config), at),
    env.DB.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,star) VALUES('fixture-member','fixture','Synthetic member','fixture','fixture',?,?,1)").bind(at, at),
    env.DB.prepare("INSERT INTO review_pilot_members(member_id,pilot_enabled,creator_account,revision,enrollment_started_at,updated_at) VALUES('fixture-member',1,'',1,?,?)").bind(at, at),
    env.DB.prepare("INSERT INTO topics(id,batch,subject,medium,gesture,structure,mood,status,data,created_at,updated_at,owner_id,brief_md,creative_version) VALUES(9,'fixture','relay','dom','tap','counter','calm','liked',?,?,?,'fixture-member','Single button increases visible count on each tap.',2)")
      .bind(JSON.stringify({ title: 'Tap Relay Fixture', core_loop: 'Tap relay', controls: 'Tap', art_direction: 'Simple colors' }), at, at),
  ]);
  const HARNESS_RELEASE = await syntheticRelease(config, env.LOCAL_BUNDLE_SHA);
  const row = await enqueueForgeTask({ ...env, modelStore: { get: async () => config }, ownerId: 'fixture-member',
    CREATIVE_V2_ROLLOUT: 'pilot', HARNESS_ROLLOUT: 'pilot', HARNESS_RELEASE }, { type: 'game', id: 9, creative_version: 2 },
    '89aa9c25-9ff7-4776-9d29-9d716b583bfe');
  return Response.json({ taskId: row.id, status: row.status, engine: JSON.parse(row.harness_policy).engine });
} };
`;

type Capture = Awaited<ReturnType<typeof captureReview>>;
type NativeBlock = { type: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: NativeBlock[];
  source?: { data?: string; media_type?: string; type?: string } };
type Message = { role: string; content: NativeBlock[] };
type StageRow = { stage: string; content_hash: string; evidence_hash: string; self_check: string };
type DraftRow = { phase: string; path: string; content_hash: string };
type Tool = { id: string; name: string; input: Record<string, unknown> };
type CaptureReceipt = { inputHash: string; durationMs: number; shots: Array<{ sha256: string; width: number; height: number;
  firstLook: boolean; touchLinked: boolean }> };
const tool = (id: string, name: string, input: Tool['input']): Tool => ({ id, name, input });
const gameWrite = (id: string) => tool(id, 'write', { path: 'game.html', content: syntheticHtml, expectedSha256: null });
const recordWrite = (id: string, value: object) => tool(id, 'write', { path: 'record.json', content: JSON.stringify(value), expectedSha256: null });

function sse(turn: number, tools: Tool[]) {
  const event = (type: string, value: object = {}) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n';
  let wire = event('message_start', { message: { id: 'msg-forge-' + turn, type: 'message', role: 'assistant', model,
    content: [], usage: { input_tokens: 40, output_tokens: 0 } } });
  for (const [index, item] of tools.entries()) {
    wire += event('content_block_start', { index, content_block: { type: 'tool_use', id: item.id, name: item.name, input: {} } });
    wire += event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(item.input) } });
    wire += event('content_block_stop', { index });
  }
  if (!tools.length) {
    wire += event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    wire += event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Fixture artifact saved.' } });
    wire += event('content_block_stop', { index: 0 });
  }
  wire += event('message_delta', { delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 31 } });
  return new Response(wire + event('message_stop'), { headers: { 'content-type': 'text/event-stream' } });
}

function reviewSse(turn: number, report: object) {
  const event = (choices: object[], usage?: object) =>
    'data: ' + JSON.stringify({ id: 'deepseek-fixture-' + turn, model: reviewModel, choices, usage }) + '\n\n';
  const choice = (delta: object, finish_reason: string | null = null) => event([{ index: 0, delta, finish_reason }]);
  const wire = choice({ role: 'assistant', reasoning_content: 'SYNTHETIC_REVIEW_REASONING_NOT_PERSISTED' }) +
    choice({ content: JSON.stringify(report) }, 'stop') +
    event([], { prompt_tokens: 47, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 31 } }) + 'data: [DONE]\n\n';
  return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
}

function latestResult(messages: Message[], id: string) {
  const latest = messages.at(-1);
  strictEqual(latest?.role, 'user');
  const result = latest?.content.find(block => block.type === 'tool_result' && block.tool_use_id === id);
  ok(result && !result.is_error && result.content?.[0]?.type === 'text', 'Missing successful native tool result ' + id + ': ' + (result?.content?.[0]?.text ?? 'absent').slice(0, 160));
  return JSON.parse(result.content[0].text!);
}

function jpegDimensions(bytes: Buffer) {
  strictEqual(bytes.readUInt16BE(0), 0xffd8);
  for (let cursor = 2; cursor + 8 < bytes.length;) {
    strictEqual(bytes[cursor], 0xff);
    const marker = bytes[cursor + 1];
    const length = bytes.readUInt16BE(cursor + 2);
    if (marker === 0xc0 || marker === 0xc2) return { height: bytes.readUInt16BE(cursor + 5), width: bytes.readUInt16BE(cursor + 7) };
    if (marker === 0xda || marker === 0xd9 || length < 2) break;
    cursor += 2 + length;
  }
  throw new Error('Expected original JPEG frame dimensions.');
}

function frameBytes(data: string) {
  ok(data.startsWith('data:image/jpeg;base64,'));
  return Buffer.from(data.slice('data:image/jpeg;base64,'.length), 'base64');
}

function captureReceipt(html: string, value: Capture, durationMs: number): CaptureReceipt {
  const shots = value.shots.map(shot => {
    const bytes = frameBytes(shot.data);
    return { sha256: sha(bytes), ...jpegDimensions(bytes), firstLook: shot.label.includes('首次触摸前'), touchLinked: shot.actionRefs.length === 1 };
  });
  deepStrictEqual(shots.map(({ width, height, firstLook, touchLinked }) => [width, height, firstLook, touchLinked]),
    [[360, 640, false, true], [360, 780, true, false], [360, 780, false, true], [360, 840, false, true]]);
  deepStrictEqual(value.probe.observations.map(value => /Score 1/.test(value.domText)), [true, false, true, true]);
  ok(/Score 0/.test(value.probe.observations[1].domText));
  ok(Object.values(value.probe.loaded).every(Boolean));
  deepStrictEqual(value.probe.errors, []);
  deepStrictEqual(value.probe.loadErrors, []);
  return { inputHash: sha(html), durationMs, shots };
}

async function applySchema(runtime: Miniflare) {
  const source = new DatabaseSync(':memory:');
  try {
    for (const name of readdirSync(resolve(root, 'migrations')).sort().filter(name => name.endsWith('.sql'))) {
      source.exec(readFileSync(resolve(root, 'migrations', name), 'utf8'));
    }
    const rows = source.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[];
    const db = await runtime.getD1Database('DB', 'forge');
    for (let i = 0; i < rows.length; i += 30) await db.batch(rows.slice(i, i + 30).map(row => db.prepare(row.sql)));
    const seed = source.prepare('SELECT id, revision FROM workspace_policy_revision').get() as { id: number; revision: number };
    await db.batch([
      db.prepare('INSERT INTO workspace_policy_revision(id,revision) VALUES (?,?)').bind(seed.id, seed.revision),
      db.prepare('INSERT INTO review_rule_head(id,version_id) VALUES(1,NULL)'),
    ]);
    return db;
  } finally {
    source.close();
  }
}

export async function verifyEmbeddedForgeBrowser(executablePath = findChrome()) {
  if (!executablePath || !existsSync(executablePath)) throw new Error('Set PGC_CHROME_PATH to an existing local Chromium executable.');
  const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).length > 0;
  const built = await build({
    absWorkingDir: root, stdin: { contents: fixtureWorker, sourcefile: 'forge-browser-fixture.js', resolveDir: root },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'node:*'], write: false, metafile: true,
  });
  const bundle = built.outputFiles[0];
  const graph = Object.keys(built.metafile.inputs);
  for (const required of ['server/forge-runner.ts', 'server/forge-creation-pipeline.ts', 'server/review-runner.ts',
    'server/cloud-review-runner.ts', 'server/harness-embedded-runtime.ts',
    'server/harness-embedded-model.ts', 'server/harness-embedded-workspace.ts', 'server/harness-embedded-capture.ts', 'server/embedded-ccb/index.ts']) ok(graph.includes(required));
  const sourceGraphSha256 = sha(JSON.stringify(graph.filter(path => /^(server|src)\//.test(path)).sort()
    .map(path => [path, sha(readFileSync(resolve(root, path)))])));
  const captures: CaptureReceipt[] = [];
  const browsers = new Map<string, Browser>();
  const closedSessions = new Set<string>();
  let modelCalls = 0, reviewCalls = 0, rejectedOutbound = 0;
  let reviewPrefix: { system: string; materials: unknown[]; imageHashes: string[]; idempotencyKey: string } | undefined;
  let providerFailure: unknown, browserFailure: unknown;

  async function localBrowser(request: Request) {
    try {
      const url = new URL(request.url);
      strictEqual(url.origin, 'https://local-browser.invalid');
      strictEqual(request.method, 'POST');
      const { sessionId, html, deadlineAt } = await request.json() as { sessionId: string; html: string; deadlineAt: number };
      if (url.pathname === '/launch') {
        strictEqual(browsers.size, 0);
        const id = randomUUID();
        const browser = await puppeteer.launch({ executablePath, headless: true, args: [
          '--disable-background-networking', '--disable-component-update', '--disable-sync',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost', '--proxy-server=127.0.0.1:9',
        ] });
        browsers.set(id, browser);
        return Response.json({ sessionId: id });
      }
      if (url.pathname === '/status') return Response.json(browsers.has(sessionId) ? { sessionId } : null);
      if (url.pathname === '/close' && closedSessions.has(sessionId)) return Response.json({ status: 'closed' });
      const browser = browsers.get(sessionId);
      ok(browser, 'Local browser session was not acquired by this fixture.');
      if (url.pathname === '/close') {
        await browser.close();
        strictEqual(browser.connected, false);
        const process = browser.process();
        ok(process && (process.exitCode !== null || process.signalCode !== null), 'Chromium process exit is unconfirmed.');
        browsers.delete(sessionId);
        closedSessions.add(sessionId);
        return Response.json({ status: 'closed' });
      }
      strictEqual(url.pathname, '/capture');
      strictEqual(html, [syntheticHtml, polishedHtml, polishedHtml][captures.length]);
      const start = Date.now();
      const evidence = await captureReview(browser, html, { denyExternal: true, deadlineAt });
      captures.push(captureReceipt(html, evidence, Date.now() - start));
      return Response.json(evidence);
    } catch (error) {
      browserFailure ??= error;
      return new Response(null, { status: 500 });
    }
  }

  async function provider(request: Request) {
    if (request.url === reviewEndpoint && request.method === 'POST') return reviewProvider(request);
    if (request.url !== endpoint || request.method !== 'POST') {
      rejectedOutbound++;
      return new Response(null, { status: 403 });
    }
    const turn = modelCalls++;
    try {
      const wire = await request.json() as { model: string; stream: boolean; messages: Message[]; thinking?: { type: string } };
      strictEqual(request.headers.get('x-api-key'), syntheticKey);
      ok(request.headers.get('idempotency-key'));
      strictEqual(wire.model, model);
      strictEqual(wire.stream, true);
      strictEqual(wire.thinking?.type, 'adaptive');
      const messages = wire.messages;
      if (turn === 0) return sse(turn, [gameWrite('write-build'), recordWrite('record-build', buildRecord)]);
      if (turn === 1) {
        strictEqual(latestResult(messages, 'write-build').sha256, sha(syntheticHtml));
        strictEqual(latestResult(messages, 'record-build').sha256, sha(JSON.stringify(buildRecord)));
        return sse(turn, []);
      }
      if (turn === 2) {
        strictEqual(browsers.size, 0);
        strictEqual(closedSessions.size, 1);
        const images = messages[0].content.filter(block => block.type === 'image').map(block => {
          strictEqual(block.source?.media_type, 'image/jpeg');
          strictEqual(block.source?.type, 'base64');
          return sha(Buffer.from(block.source?.data ?? '', 'base64'));
        });
        deepStrictEqual(images, captures[0].shots.map(shot => shot.sha256));
        return sse(turn, [tool('read-old-game', 'read', { path: 'input/game.html' })]);
      }
      if (turn === 3) {
        const read = latestResult(messages, 'read-old-game');
        strictEqual(read.content, syntheticHtml);
        strictEqual(read.sha256, captures[0].inputHash);
        return sse(turn, [tool('patch-polish', 'patch', { path: 'game.html', expectedSha256: read.sha256,
          oldText: '#b76828', newText: '#117464' }), recordWrite('record-polish', polishRecord)]);
      }
      if (turn === 4) {
        strictEqual(latestResult(messages, 'patch-polish').sha256, sha(polishedHtml));
        strictEqual(latestResult(messages, 'record-polish').sha256, sha(JSON.stringify(polishRecord)));
        return sse(turn, []);
      }
      throw new Error('Unexpected scripted model turn.');
    } catch (error) {
      providerFailure ??= error;
      return new Response(null, { status: 500 });
    }
  }

  async function reviewProvider(request: Request) {
    const turn = reviewCalls++;
    try {
      ok(turn < 2);
      strictEqual(browsers.size, 0);
      strictEqual(closedSessions.size, 3);
      strictEqual(request.headers.get('authorization'), 'Bearer ' + reviewSyntheticKey);
      const idempotencyKey = request.headers.get('idempotency-key');
      ok(idempotencyKey);
      const wire = await request.json() as { model: string; stream: boolean; max_tokens: number; reasoning_effort: string;
        thinking: { type: string }; response_format: { type: string }; stream_options: { include_usage: boolean }; tools?: unknown[];
        messages: [{ role: string; content: string }, { role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }] };
      strictEqual(wire.model, reviewModel);
      strictEqual(wire.stream, true);
      strictEqual(wire.max_tokens, 24_000);
      strictEqual(wire.reasoning_effort, 'low');
      strictEqual(wire.thinking.type, 'enabled');
      strictEqual(wire.response_format.type, 'json_object');
      strictEqual(wire.stream_options.include_usage, true);
      ok(!wire.tools?.length);
      deepStrictEqual(wire.messages.map(message => message.role), ['system', 'user']);
      const [system, user] = wire.messages.map(message => message.content) as [string, typeof wire.messages[1]['content']];
      ok(system.includes(calibrationCanary));
      const { user: materials } = JSON.parse(user[0].text!) as { user: Array<{ type: string; text?: string; imagePath?: string }> };
      const plain = JSON.stringify({ system, materials });
      for (const privateField of [authorCanary, humanCanary, 'record.json', 'creator-self-check']) {
        ok(!plain.includes(privateField), 'Independent review received private author or same-version answer data.');
      }
      ok(materials.some(part => part.text?.includes(polishedHtml)), 'Independent review did not get the polished HTML.');
      const imageHashes = user.filter(part => part.type === 'image_url').map(part => sha(frameBytes(part.image_url!.url)));
      deepStrictEqual(imageHashes, captures[2].shots.map(shot => shot.sha256));
      if (turn === 0) {
        ok(!plain.includes(draftCanary));
        reviewPrefix = { system, materials, imageHashes, idempotencyKey };
        return reviewSse(turn, reviewDraft);
      }
      ok(reviewPrefix);
      strictEqual(system, reviewPrefix.system);
      deepStrictEqual(materials.slice(0, -1), reviewPrefix.materials);
      deepStrictEqual(imageHashes, reviewPrefix.imageHashes);
      ok(idempotencyKey !== reviewPrefix.idempotencyKey);
      ok(materials.at(-1)?.text?.includes(draftCanary));
      return reviewSse(turn, verifiedReport);
    } catch (error) {
      providerFailure ??= error;
      return new Response(null, { status: 500 });
    }
  }

  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: [{
    config: { name: 'forge', compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
      env: { DB: { type: 'd1', name: 'embedded-forge-fixture' },
        FORGE_RUNNER: { type: 'durable-object', worker: 'forge', exportName: 'LocalForgeRunner' },
        REVIEW_RUNNER: { type: 'durable-object', worker: 'forge', exportName: 'LocalReviewRunner' },
        LOCAL_BROWSER: { type: 'fetcher', handler: localBrowser },
        SETTINGS_KEY: { type: 'text', value: 'local-forge-synthetic-secret' },
        LOCAL_BUNDLE_SHA: { type: 'text', value: sha(bundle.contents) } },
      exports: { LocalForgeRunner: { type: 'durable-object', storage: 'sqlite' }, LocalReviewRunner: { type: 'durable-object', storage: 'sqlite' } },
      manifest: manifest(bundle.text),
    },
    dev: { outboundService: { type: 'fetcher', handler: provider } },
  }] });
  try {
    const db = await applySchema(runtime);
    const admitted = await runtime.dispatchFetch('http://local-forge.test/enqueue', { method: 'POST' });
    if (!admitted.ok) throw new Error('Local Forge admission failed (' + admitted.status + '): ' + await admitted.text());
    deepStrictEqual(await admitted.json(), { taskId: task, status: 'queued', engine: 'ccb-embedded' });
    async function waitTerminal(query: string, id: string) {
      const end = Date.now() + 105_000;
      let row;
      do {
        row = await db.prepare(query).bind(id).first<{ status: string; phase: string; result: string | null; error: string }>();
        if (row?.status === 'error' || row?.status === 'done') break;
        await delay(200);
      } while (Date.now() < end);
      if (providerFailure) throw providerFailure;
      if (browserFailure) throw browserFailure;
      ok(row?.status === 'done' && row.phase === 'done', 'Local task did not finish: ' + JSON.stringify(row));
      return row;
    }
    const row = await waitTerminal('SELECT status,phase,result,error FROM forge_tasks WHERE id=?', task);
    strictEqual(browsers.size, 0);
    strictEqual(closedSessions.size, 2);
    strictEqual(modelCalls, 5);
    strictEqual(rejectedOutbound, 0);
    const result = JSON.parse(row.result!);
    strictEqual(result.self_check_status, 'captured-awaiting-independent-review');
    strictEqual(result.content_hash, sha(polishedHtml));
    const version = await db.prepare('SELECT content,kind,owner_id,executor,model FROM artifact_versions WHERE id=?')
      .bind(result.version_id).first<{ content: string; kind: string; owner_id: string; executor: string; model: string }>();
    deepStrictEqual(version, { content: polishedHtml, kind: 'game', owner_id: 'fixture-member', executor: 'platform', model });
    strictEqual(await db.prepare('SELECT product_html FROM topics WHERE id=9').first('product_html'), polishedHtml);
    const stages: StageRow[] = (await db.prepare('SELECT stage,content_hash,evidence_hash,self_check FROM forge_creation_stages WHERE task_id=? ORDER BY stage')
      .bind(task).all<StageRow>()).results;
    deepStrictEqual(stages.map(stage => stage.stage), ['build', 'polish']);
    strictEqual(JSON.parse(stages[1].self_check).judgedInputHash, sha(syntheticHtml));
    strictEqual(JSON.parse(stages[1].self_check).judgedEvidenceHash, stages[0].evidence_hash);
    ok(stages[0].evidence_hash !== stages[1].evidence_hash && stages[0].content_hash !== stages[1].content_hash);
    const persisted = [];
    for (const [index, stage] of stages.entries()) {
      const parts: { content: string }[] = (await db.prepare('SELECT content FROM forge_creation_evidence WHERE task_id=? AND stage=? AND part>=0 ORDER BY part')
        .bind(task, stage.stage).all<{ content: string }>()).results;
      const evidence = JSON.parse(parts.map(part => part.content).join(''));
      strictEqual(evidence.inputHash, stage.content_hash);
      strictEqual(evidence.inputHash, captures[index].inputHash);
      strictEqual(evidence.hash, stage.evidence_hash);
      deepStrictEqual(evidence.shots.map((shot: { data: string; hash: string }) => {
        const original = sha(frameBytes(shot.data));
        strictEqual(shot.hash, original);
        return original;
      }), captures[index].shots.map(shot => shot.sha256));
      persisted.push(evidence);
    }
    ok(captures[0].shots.every((shot, index) => shot.sha256 !== captures[1].shots[index].sha256));
    const stale = { html: polishedHtml, ...polishRecord, selfCheck: { ...polishRecord.selfCheck, findings: [{
      kind: 'confirmed', id: 'stale', phenomenon: 'Synthetic stale ref', trigger: '', cause: '', minimalChange: '', retest: '',
      evidenceRefs: [persisted[0].shots[0].id], coreChange: false, resolved: false,
    }] } };
    deepStrictEqual(validateCreationOutput(stale, 'polish', persisted[1], buildRecord, true, [], sha(polishedHtml)), ['selfCheck.findings']);
    stale.selfCheck.findings[0].evidenceRefs = [persisted[1].shots[0].id];
    deepStrictEqual(validateCreationOutput(stale, 'polish', persisted[1], buildRecord, true, [], sha(polishedHtml)), []);
    const phases = (await db.prepare('SELECT phase,state,stop_reason FROM harness_embedded_phases WHERE task_id=? ORDER BY phase')
      .bind(task).all()).results;
    deepStrictEqual(phases, ['build', 'polish'].map(phase => ({ phase, state: 'succeeded', stop_reason: 'completed' })));
    const requests = (await db.prepare('SELECT state,attempts FROM harness_requests WHERE task_id=? ORDER BY rowid').bind(task).all()).results;
    deepStrictEqual(requests, Array.from({ length: 5 }, () => ({ state: 'completed', attempts: 1 })));
    const run = await db.prepare('SELECT status,reserved_tokens,released_at FROM harness_runs WHERE task_id=?').bind(task)
      .first<{ status: string; reserved_tokens: number; released_at: number }>();
    strictEqual(run?.status, 'done');
    strictEqual(run?.reserved_tokens, 0);
    ok(run.released_at > 0);
    const toolRows: { phase: string; name: string; state: string; input_hash: string; result_hash: string }[] =
      (await db.prepare('SELECT phase,name,state,input_hash,result_hash FROM harness_embedded_tools WHERE task_id=? ORDER BY rowid')
        .bind(task).all()).results;
    deepStrictEqual(toolRows.map(({ phase, name, state }) => [phase, name, state]), [
      ['build', 'write', 'completed'], ['build', 'write', 'completed'], ['polish', 'read', 'completed'],
      ['polish', 'patch', 'completed'], ['polish', 'write', 'completed'],
    ]);
    ok(toolRows.every(row => /^[0-9a-f]{64}$/.test(row.input_hash) && /^[0-9a-f]{64}$/.test(row.result_hash)));
    const drafts: DraftRow[] = (await db.prepare(`SELECT phase,path,content_hash FROM harness_embedded_artifacts WHERE task_id=?
      GROUP BY phase,path,content_hash ORDER BY phase,path,content_hash`).bind(task).all<DraftRow>()).results;
    deepStrictEqual(drafts.filter(draft => draft.path === 'game.html').map(draft => [draft.phase, draft.content_hash]),
      [['build', sha(syntheticHtml)], ['polish', sha(polishedHtml)]]);
    const reviewAdmitted = await runtime.dispatchFetch('http://local-forge.test/enqueue-review', { method: 'POST' });
    if (!reviewAdmitted.ok) throw new Error('Local review admission failed (' + reviewAdmitted.status + '): ' + await reviewAdmitted.text());
    const admission = await reviewAdmitted.json() as { taskId: string; status: string; schemaVersion: number; inputHash: string; rulesSha256: string };
    deepStrictEqual({ ...admission, rulesSha256: null }, {
      taskId: reviewTask, status: 'queued', schemaVersion: 2, inputHash: sha(polishedHtml), rulesSha256: null,
    });
    await waitTerminal('SELECT status,stage AS phase,result_id AS result,error FROM review_jobs WHERE id=?', reviewTask);
    const report = await db.prepare('SELECT owner_id,score,result,probe,shots,rules_snapshot FROM reviews WHERE job_id=?')
      .bind(reviewTask).first<{ owner_id: string; score: number | null; result: string; probe: string; shots: string; rules_snapshot: string }>();
    ok(report);
    strictEqual(report.owner_id, 'admin');
    strictEqual(report.score, null);
    deepStrictEqual(JSON.parse(report.result), verifiedReport);
    strictEqual(JSON.parse(report.probe).evidenceOrigin, 'admin-upload');
    strictEqual(JSON.parse(report.rules_snapshot).contentHash, admission.rulesSha256);
    deepStrictEqual(JSON.parse(report.shots).map((shot: { data: string }) => sha(frameBytes(shot.data))), captures[2].shots.map(shot => shot.sha256));
    strictEqual(await db.prepare('SELECT count(*) AS n FROM review_inputs WHERE job_id=?').bind(reviewTask).first('n'), 0);
    const reviewRequests = (await db.prepare('SELECT state,attempts,output_cap FROM harness_requests WHERE task_id=? ORDER BY rowid')
      .bind(reviewTask).all()).results;
    deepStrictEqual(reviewRequests, Array.from({ length: 2 }, () => ({ state: 'completed', attempts: 1, output_cap: 24_000 })));
    const reviewRun = await db.prepare('SELECT status,reserved_tokens,released_at FROM harness_runs WHERE task_id=?').bind(reviewTask)
      .first<{ status: string; reserved_tokens: number; released_at: number }>();
    strictEqual(reviewRun?.status, 'done');
    strictEqual(reviewRun?.reserved_tokens, 0);
    ok(reviewRun.released_at > 0);
    const reviewPhases = (await db.prepare('SELECT phase,state,stop_reason FROM harness_embedded_phases WHERE task_id=? ORDER BY phase')
      .bind(reviewTask).all()).results;
    deepStrictEqual(reviewPhases, ['review', 'review_verify'].map(phase => ({ phase, state: 'succeeded', stop_reason: 'completed' })));
    strictEqual(await db.prepare('SELECT count(*) AS n FROM harness_embedded_tools WHERE task_id=?').bind(reviewTask).first('n'), 0);
    strictEqual(reviewCalls, 2);
    strictEqual(rejectedOutbound, 0);
    strictEqual(browsers.size, 0);
    strictEqual(closedSessions.size, 3);
    ok(reviewPrefix);
    return {
      schemaVersion: 2, runtime: 'local-workerd-original-forge-and-review-runners', capture: 'local-chromium-full-viewport',
      actualLocalBrowser: true, cloudBrowserRendering: false, provider: 'synthetic-anthropic-and-deepseek-sse',
      externalProviderRequests: 0, browserProcessesClosed: closedSessions.size,
      implementationCommit, dirty, sourceGraphSha256, bundleSha256: sha(bundle.contents),
      final: { artifactSha256: result.content_hash, resultStatus: result.self_check_status },
      stages: stages.map((stage, index) => ({ phase: stage.stage, evidenceSha256: stage.evidence_hash,
        sourceSha256: stage.content_hash, durationMs: captures[index].durationMs, shots: captures[index].shots })),
      scriptedModelCalls: modelCalls, completedWorkspaceToolReceipts: toolRows.length, staleReferenceRejected: true, runSlotReleased: true,
      review: { sourceSha256: captures[2].inputHash, rulesSha256: admission.rulesSha256, shots: captures[2].shots,
        scriptedModelCalls: reviewCalls, sharedEvidencePrefixSha256: sha(JSON.stringify([reviewPrefix.system, reviewPrefix.materials, reviewPrefix.imageHashes])),
        reportSha256: sha(report.result), score: report.score, onlyVerifiedReportPublished: true, creatorAndSameVersionHumanAnswersExcluded: true },
    };
  } finally {
    try { await runtime.dispose(); }
    finally { await Promise.allSettled([...browsers.values()].map(browser => browser.close())); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = await verifyEmbeddedForgeBrowser();
  const directory = resolve(root, 'artifacts/ccb-embedded-core-local');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const output = resolve(directory, 'embedded-forge-review-browser-verification-v3.json');
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(output);
}
