import { deepStrictEqual, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = (contents: string) => ({ mainModule: 'index.js', modules: { 'index.js': { type: 'esm' as const, contents } } });
const sharedFixture = String.raw`
const modelName = 'claude-opus-5-5';
const endpoint = 'https://embedded-provider.invalid/v1/messages';
const materials = JSON.stringify({ title: 'Synthetic tap ⏱', requirement: '保持原始材料和视口图。' });
const game = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><script>let play = 1;</script></body></html>';
const patched = game.replace('play = 1', 'play = 2');
const record = JSON.stringify({ fixture: 'synthetic', executed: false });
const picture = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=';
const capturePictures = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4/58BAAT/Af9dfQKHAAAAAElFTkSuQmCC',
];
const finalText = 'Synthetic workspace result complete.';
const localKey = 'synthetic-workerd-provider-key';
const thought = 'synthetic signed thought';
const signature = 'fixture-native-signature';
function requireValue(condition, code) { if (!condition) throw new Error(code); }
const pngBytes = data => Uint8Array.from(atob(data), value => value.charCodeAt(0));
async function sha(value) {
  const digest = await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
globalThis.fetch = () => { throw new Error('External network is disabled in this fixture.'); };
`;

const workerFixture = String.raw`
import { DurableObject } from 'cloudflare:workers';
import { runEmbeddedQuery } from './server/embedded-ccb/index';
import { openEmbeddedWorkspace } from './server/harness-embedded-workspace';
import { runEmbeddedHarnessModel, EmbeddedHarnessModelError } from './server/harness-embedded-model';
import { createHarnessRun, getHarnessRun, lockHarnessModel } from './server/harness-ledger';
import { encryptKey } from './server/settings';
` + sharedFixture + String.raw`
export class FixtureWorkspace extends DurableObject {
  async fetch(request) {
    const mode = new URL(request.url).pathname.slice(1);
    const DB = this.env.DB;
    const settingsKey = 'synthetic-workerd-settings-key';
    const profile = { model: modelName, baseUrl: new URL(endpoint).origin, protocol: 'anthropic',
      encryptedKey: await encryptKey(localKey, settingsKey), enabled: true, updatedAt: 'initial', vision: true };
    const config = { ...profile, activeProfile: 'default', profiles: { default: profile } };
    const model = await lockHarnessModel(config, 'game');
    const deadlineAt = Date.now() + 60_000;
    const taskId = 'workerd-embedded-' + mode;
    const identity = { taskId, generation: 'synthetic-generation' };
    const { run, lease } = await createHarnessRun(DB, { ...identity, ownerId: 'synthetic-owner',
      family: 'forge', actor: 'star', sourceHash: await sha(materials), snapshot: { mode }, model, deadlineAt,
      limits: { maxTotalOutputTokens: 256000, maxModelTurns: 8 } });
    const imageSha = await sha(pngBytes(picture));
    const gameSha = await sha(patched);
    const forwarded = [];
    const tools = [];
    const archived = [];
    let captures = 0, closes = 0, failed = null;
    const browser = {
      async execute(invocation) {
        captures++;
        requireValue(invocation.name === 'capture' && invocation.arguments.html === patched &&
          invocation.arguments.inputHash === gameSha, 'capture-input-drift');
        return { tool: 'capture', inputHash: gameSha, evidenceHash: await sha('synthetic-browser'),
          shots: await Promise.all(capturePictures.map(async (data, index) => ({
            id: 'synthetic-frame-' + index, data: 'data:image/png;base64,' + data, sha256: await sha(pngBytes(data)),
          }))) };
      },
      async readResults() { return []; },
      async close() { closes++; },
    };
    const signal = new AbortController().signal;
    const options = { taskId, runId: run.generation, purpose: 'game', vision: true, deadlineAt, signal, browser,
      storage: this.ctx.storage, authorize: () => true, imagePaths: ['input/frame.png'],
      files: [{ path: 'input/materials.json', encoding: 'utf8', content: materials, sha256: await sha(materials) },
        { path: 'input/frame.png', encoding: 'base64', content: picture, sha256: imageSha }],
      async onArtifact(file) { archived.push({ path: file.path, sha256: file.sha256 }); },
    };
    const workspace = await openEmbeddedWorkspace(options);
    let query;
    try {
      query = await runEmbeddedQuery({
        system: 'Synthetic embedded workerd verification.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Run the synthetic workspace chain.' }, ...workspace.initialImages] }],
        tools: workspace.tools, model: modelName, contextWindow: 100000, maxOutputTokens: model.maxOutputTokens,
        maxTotalOutputTokens: 256000, maxModelTurns: 8, signal,
      }, {
        callModel: async (call) => {
          const current = await getHarnessRun(DB, identity);
          requireValue(current.status === 'active' && current.reservedTokens === 0, 'run-is-not-forwardable');
          try {
            return await runEmbeddedHarnessModel(call, {
              run: current, lease, requestId: 'build-0-turn-' + call.turn, deadlineAt,
              remainingOutputTokens: current.maxTotalOutputTokens - current.outputTokens - current.reservedTokens,
            }, {
              DB, loadConfig: () => config, settingsKey, authorizeRun: (candidate) => candidate.taskId === taskId,
              expectedModelTurns: current.modelTurns, requestIdPrefix: 'build-0-',
              fetcher: (input, init) => {
                requireValue(String(input) === endpoint && init.redirect === 'manual', 'native-endpoint-drift');
                forwarded.push(call.turn);
                const headers = new Headers(init.headers);
                headers.set('x-fixture-mode', mode);
                headers.set('x-fixture-turn', String(call.turn));
                return this.env.PROVIDER.fetch(new Request(input, { ...init, headers }));
              },
            });
          } catch (error) {
            if (error instanceof EmbeddedHarnessModelError) failed = error.code;
            throw error;
          }
        },
        runTool: async (tool, toolSignal) => {
          tools.push(tool.name);
          const result = await workspace.call({ id: tool.id, name: tool.name, arguments: tool.input }, toolSignal);
          return { content: result.content, isError: result.is_error };
        },
      });
    } finally {
      await workspace.close();
    }
    const resumedWorkspace = await openEmbeddedWorkspace({ ...options, browser: undefined });
    const persisted = await resumedWorkspace.readOutputs();
    await resumedWorkspace.close();
    const persistedGame = persisted.find(file => file.path === 'game.html');
    const persistedRecord = persisted.find(file => file.path === 'record.json');
    const lastRun = await getHarnessRun(DB, identity);
    const { results: requests } = await DB.prepare(
      'SELECT state, error_code AS errorCode, attempts, output_cap AS outputCap, output_tokens AS outputTokens FROM harness_requests WHERE task_id=? ORDER BY rowid'
    ).bind(taskId).all();
    return Response.json({
      terminal: query.reason, finalTextMatches: query.finalAssistant?.content.map(block => block.text).join('') === finalText,
      forwarded, tools, captures, closes, archived, failed, requests,
      reservedTokens: lastRun.reservedTokens, outputTokens: lastRun.outputTokens,
      durableArtifactsMatch: persistedGame?.content === patched && persistedRecord?.content === record,
      artifactCount: persisted.length, gameSha256: persistedGame?.sha256 ?? null,
    });
  }
}
export default {
  fetch(request, env) {
    const mode = new URL(request.url).pathname;
    if (mode !== '/success' && mode !== '/unknown') return new Response(null, { status: 404 });
    return env.FIXTURE.get(env.FIXTURE.idFromName(mode)).fetch(request);
  }
};
`;

const providerFixture = sharedFixture + String.raw`
function event(type, body = {}) { return 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...body }) + '\n\n'; }
const start = (index, content_block) => event('content_block_start', { index, content_block });
const delta = (index, delta) => event('content_block_delta', { index, delta });
const stop = index => event('content_block_stop', { index });
function tool(index, id, name, input) {
  const json = JSON.stringify(input);
  const split = Math.floor(json.length / 2);
  return start(index, { type: 'tool_use', id, name, input: {} }) +
    delta(index, { type: 'input_json_delta', partial_json: json.slice(0, split) }) +
    delta(index, { type: 'input_json_delta', partial_json: json.slice(split) }) + stop(index);
}
function matchingImage(block, original) {
  return block?.type === 'image' && block.source?.type === 'base64' &&
    block.source.media_type === 'image/png' && block.source.data === original;
}
function result(message, id) {
  const block = message?.content?.find(block => block.type === 'tool_result' && block.tool_use_id === id);
  requireValue(message?.role === 'user' && block && !block.is_error && block.content[0]?.type === 'text', 'tool-result-drift');
  return { metadata: JSON.parse(block.content[0].text), images: block.content.slice(1) };
}
export default {
  async fetch(request) {
    const mode = request.headers.get('x-fixture-mode');
    const turn = Number(request.headers.get('x-fixture-turn')) - 1;
    const wire = await request.json();
    requireValue(request.url === endpoint && request.method === 'POST' && request.headers.get('x-api-key') === localKey &&
      Boolean(request.headers.get('idempotency-key')) && wire.model === modelName && wire.stream === true &&
      wire.thinking?.type === 'adaptive' && wire.output_config?.effort === 'high', 'provider-wire-drift');
    requireValue(wire.messages[0]?.role === 'user' && matchingImage(wire.messages[0].content[1], picture), 'initial-image-drift');
    let events = event('message_start', { message: { id: 'msg-' + turn, type: 'message', role: 'assistant',
      model: modelName, content: [], usage: { input_tokens: 20, output_tokens: 0 } } });
    if (mode === 'unknown') {
      requireValue(turn === 0, 'unexpected-unknown-replay');
      events += tool(0, 'untrusted-write', 'write', { path: 'game.html', content: game, expectedSha256: null });
    } else if (turn === 0) {
      events += start(0, { type: 'thinking', thinking: '' }) +
        delta(0, { type: 'thinking_delta', thinking: thought }) +
        delta(0, { type: 'signature_delta', signature }) + stop(0) +
        tool(1, 'read-materials', 'read', { path: 'input/materials.json' });
    } else if (turn === 1) {
      requireValue(wire.messages[1]?.role === 'assistant' && wire.messages[1].content[0]?.thinking === thought &&
        wire.messages[1].content[0]?.signature === signature, 'native-thinking-drift');
      const read = result(wire.messages[2], 'read-materials').metadata;
      requireValue(read.content === materials && read.sha256 === await sha(materials) && read.nextOffset === null, 'material-drift');
      events += tool(0, 'write-game', 'write', { path: 'game.html', content: game, expectedSha256: null }) +
        tool(1, 'write-record', 'write', { path: 'record.json', content: record, expectedSha256: null });
    } else if (turn === 2) {
      const previous = wire.messages[wire.messages.length - 1];
      requireValue(result(previous, 'write-game').metadata.sha256 === await sha(game) &&
        result(previous, 'write-record').metadata.sha256 === await sha(record), 'write-digest-drift');
      events += tool(0, 'patch-game', 'patch', { path: 'game.html', oldText: 'play = 1', newText: 'play = 2', expectedSha256: await sha(game) }) +
        tool(1, 'capture-game', 'capture', {});
    } else if (turn === 3) {
      const previous = wire.messages[wire.messages.length - 1];
      const capture = result(previous, 'capture-game');
      const gameSha = await sha(patched);
      requireValue(result(previous, 'patch-game').metadata.sha256 === gameSha && capture.metadata.inputHash === gameSha &&
        capture.images.length === 4 && capture.images.every((image, index) => matchingImage(image, capturePictures[index])) &&
        capture.metadata.shots.every((shot, index) => shot.id === 'synthetic-frame-' + index && shot.imageNumber === index + 1),
      'original-capture-drift');
      events += start(0, { type: 'text', text: '' }) + delta(0, { type: 'text_delta', text: finalText }) + stop(0);
    } else throw new Error('unexpected-provider-turn');
    events += event('message_delta', { delta: { stop_reason: turn === 3 ? 'end_turn' : 'tool_use' },
      usage: { output_tokens: 10 + turn } });
    if (mode === 'success') events += event('message_stop');
    const bytes = new TextEncoder().encode(events);
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) controller.close();
        else { controller.enqueue(bytes.slice(offset, offset + 17)); offset += 17; }
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }
};
`;

async function applyActualLedgerSchema(runtime: Miniflare) {
  const source = new DatabaseSync(':memory:');
  try {
    for (const file of readdirSync(resolve(root, 'migrations')).sort().filter(name => name.endsWith('.sql') && name < '0034')) {
      source.exec(readFileSync(resolve(root, 'migrations', file), 'utf8'));
    }
    const definitions = source.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL
      AND tbl_name IN ('harness_runs','harness_requests','harness_events','model_runs','model_slots','model_throttle')
      ORDER BY rowid`).all() as { sql: string }[];
    const d1 = await runtime.getD1Database('DB', 'fixture');
    await d1.batch(definitions.map(row => d1.prepare(row.sql)));
  } finally {
    source.close();
  }
}

type RequestResult = { state: string; errorCode: string | null; attempts: number; outputCap: number; outputTokens: number | null };
type WorkerdResult = {
  terminal: string; finalTextMatches: boolean; forwarded: number[]; tools: string[];
  captures: number; closes: number; archived: { path: string; sha256: string }[];
  failed: string | null; requests: RequestResult[]; reservedTokens: number; outputTokens: number;
  durableArtifactsMatch: boolean; artifactCount: number; gameSha256: string | null;
};

export async function verifyEmbeddedHarnessWorkerd() {
  const built = await build({
    absWorkingDir: root, stdin: { contents: workerFixture, sourcefile: 'embedded-workerd-fixture.js', resolveDir: root },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], write: false, metafile: true,
  });
  const output = built.outputFiles[0];
  const inputs = Object.keys(built.metafile.inputs);
  const required = ['server/embedded-ccb/index.ts', 'server/harness-embedded-model.ts', 'server/harness-embedded-workspace.ts', 'server/harness-gateway.ts'];
  const forbidden = /(?:node:|bun:|child_process|\/harness\/(?:workspace|envelope)\.mjs|(?:^|\/)harness-(?:host|outbound)\.ts$)/i;
  if (!required.every(path => inputs.includes(path)) || inputs.some(path => forbidden.test('/' + path)) ||
      /\bBun\.(?:spawn|file)|\b(?:interceptAllOutboundHttp|getTcpPort)\b/.test(output.text) ||
      Object.values(built.metafile.outputs).flatMap(file => file.imports).some(entry => entry.external && entry.path !== 'cloudflare:workers')) {
    throw new Error('Unexpected runtime dependency in embedded workerd bundle.');
  }
  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: [
    { config: { name: 'fixture', compatibilityDate: '2026-10-23', compatibilityFlags: ['enable_request_signal'],
      env: { PROVIDER: { type: 'worker', worker: 'provider' },
        DB: { type: 'd1', name: 'embedded-workerd-ledger' },
        FIXTURE: { type: 'durable-object', worker: 'fixture', exportName: 'FixtureWorkspace' } },
      exports: { FixtureWorkspace: { type: 'durable-object', storage: 'sqlite' } },
      manifest: manifest(output.text) } },
    { config: { name: 'provider', compatibilityDate: '2026-10-23', manifest: manifest(providerFixture) } },
  ] });
  try {
    await applyActualLedgerSchema(runtime);
    const read = async (mode: 'success' | 'unknown'): Promise<WorkerdResult> => {
      const response = await runtime.dispatchFetch('http://embedded-local.test/' + mode);
      if (!response.ok) throw new Error('Embedded workerd fixture failed for ' + mode + ' (' + response.status + ')');
      return await response.json() as WorkerdResult;
    };
    const success = await read('success');
    const unknown = await read('unknown');
    validateScenarios(success, unknown);
    return {
      schemaVersion: 1, runtime: 'local-workerd', fixtureProvider: 'synthetic-anthropic-sse-service-binding',
      browserEvidence: 'synthetic-original-png-fixture', productionRunnerCovered: false,
      externalProviderRequests: 0, bundle: { sha256: createHash('sha256').update(output.contents).digest('hex'), required },
      success, unknown,
    };
  } finally {
    await runtime.dispose();
  }
}

function validateScenarios(success: WorkerdResult, unknown: WorkerdResult) {
  strictEqual(success.terminal, 'completed');
  strictEqual(success.finalTextMatches, true);
  deepStrictEqual(success.forwarded, [1, 2, 3, 4]);
  deepStrictEqual(success.tools, ['read', 'write', 'write', 'patch', 'capture']);
  strictEqual(success.captures, 1);
  strictEqual(success.closes, 1);
  strictEqual(success.durableArtifactsMatch, true);
  strictEqual(success.artifactCount, 2);
  deepStrictEqual(success.archived.map(artifact => artifact.path), ['game.html', 'record.json', 'game.html']);
  strictEqual(success.archived[2].sha256, success.gameSha256);
  strictEqual(success.failed, null);
  strictEqual(success.reservedTokens, 0);
  strictEqual(success.outputTokens, 46);
  deepStrictEqual(success.requests.map(({ state, errorCode, attempts, outputTokens }) =>
    [state, errorCode, attempts, outputTokens]), [10, 11, 12, 13].map(tokens => ['completed', null, 1, tokens]));

  strictEqual(unknown.terminal, 'model_error');
  strictEqual(unknown.finalTextMatches, false);
  deepStrictEqual(unknown.forwarded, [1]);
  deepStrictEqual(unknown.tools, []);
  strictEqual(unknown.captures, 0);
  strictEqual(unknown.closes, 1);
  deepStrictEqual(unknown.archived, []);
  strictEqual(unknown.failed, 'stream_incomplete');
  strictEqual(unknown.artifactCount, 0);
  strictEqual(unknown.outputTokens, 0);
  strictEqual(unknown.reservedTokens, 64_000);
  deepStrictEqual(unknown.requests, [{
    state: 'unknown', errorCode: 'stream_incomplete', attempts: 1, outputCap: 64_000, outputTokens: null,
  }]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = await verifyEmbeddedHarnessWorkerd();
  const directory = resolve(root, 'artifacts/ccb-embedded-core-local');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const out = resolve(directory, 'embedded-workerd-verification-v1.json');
  writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(out);
}
