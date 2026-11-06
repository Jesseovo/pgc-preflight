import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertContainerIsolation, createHarness } from '../harness/runtime.mjs';
import { canonical, fileEntry, sha256 } from '../harness/envelope.mjs';
import { inspectStream } from '../harness/model-bridge.mjs';
import { workspaceResponse } from '../harness/workspace.mjs';
import { validateCreationOutput } from '../server/forge-creation-pipeline';
import { parseProductionOutput } from '../server/forge-production-output';
import { harnessResultText } from '../server/harness-host';
import { prepareArtifact } from '../server/forge-workspace';

const controlToken = 'synthetic-control-token-for-test-only';
const lease = 'synthetic-model-lease-for-test-only';
const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVQYV2NgAAIAAAUAAYoz4wQAAAAASUVORK5CYII=';
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link href="https://example.invalid/style.css"></head><body>before<script src="https://example.invalid/game.js"></script><script>document.body.onclick=()=>{}</script></body></html>\n';
const captureId = `tool-${'a'.repeat(64)}:shot:1`;
const fixture = String.raw`
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Socket } from 'node:net';
const configPath = process.argv[process.argv.indexOf('--mcp-config') + 1];
const server = JSON.parse(await readFile(configPath, 'utf8')).mcpServers.pgc_workspace;
const body = JSON.parse(Buffer.concat(await Array.fromAsync(process.stdin)).toString()).message;
const fixture = body.content.at(-1).text;
const api = process.env.ANTHROPIC_BASE_URL;
const model = process.argv[process.argv.indexOf('--model') + 1];
const isOpenAI = process.env.CLAUDE_CODE_USE_OPENAI === '1';
if (process.env.PGC_HARNESS_CONTROL_TOKEN || process.env.PGC_HARNESS_GATEWAY_URL ||
    process.env.ANTHROPIC_API_KEY !== 'pgc-loopback-only' ||
    Object.keys(process.env).some(key => /SECRET|PGC_HARNESS_CONTROL|PGC_HARNESS_GATEWAY/.test(key))) process.exit(2);
async function forbidden(operation, code) {
  try { await operation(); } catch (error) { if (error.code === code) return; }
  process.exit(12);
}
await forbidden(() => readFile('/pgc-forbidden-host-fixture'), 'ERR_ACCESS_DENIED');
await forbidden(() => writeFile('/pgc-forbidden-host-fixture', 'not allowed'), 'ERR_ACCESS_DENIED');
await forbidden(() => spawnSync(process.execPath, ['--version']), 'ERR_ACCESS_DENIED');
await forbidden(() => new Socket().connect({ host: '127.0.0.1', port: 1 }), 'PGC_CCB_NETWORK_DENIED');
if (process.permission.has('fs.read', '/proc/' + process.ppid + '/environ')) process.exit(21);
const allowedPort = Number(new URL(api).port);
let portReads = 0;
const socket = new Socket();
await new Promise((resolve, reject) => {
  socket.once('error', reject);
  socket.connect({ host: '127.0.0.1', get port() { return ++portReads === 1 ? allowedPort : 1; } }, () => {
    if (socket.remotePort === allowedPort) resolve();
    else reject(new Error('Unexpected destination'));
  });
}).finally(() => socket.destroy());
if ((await fetch(api + '/v1/messages/count_tokens', { method: 'POST', body: '{}' })).status !== 403 ||
    (await fetch(server.url, { method: 'POST', body: '{}' })).status !== 403) process.exit(13);
let rpc = 0;
async function call(name, args) {
  const res = await fetch(server.url, {
    method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' },
    body: JSON.stringify({jsonrpc:'2.0',id:++rpc,method:'tools/call',params:{name,arguments:args}}),
  });
  return (await res.json()).result;
}
const modelURL = api + (isOpenAI ? '/v1/chat/completions' : '/v1/messages?beta=true');
let turn = randomUUID();
const ask = async messages => {
  const res = await fetch(modelURL, {
    method:'POST', headers:{'x-pgc-ccb-turn':turn, 'content-type':'application/json'},
    body:JSON.stringify({model,max_tokens:64000,stream:true,messages,
      ...(isOpenAI ? {enable_thinking:true,chat_template_kwargs:{thinking:true}}
        : {metadata:{user_id:'ignore-private-identity'}})}),
  });
  return { status: res.status, text: await res.text() };
};
const result = text => console.log(JSON.stringify({type:'result', subtype:'success', is_error:false, result:text}));
const response = await ask([body]);
if (response.status !== 200) process.exit(3);
if (fixture === 'game with capture') {
  const duplicate = await ask([body]);
  if (duplicate.status !== 409) process.exit(4);
  const denied = await call('write', {path:'../outside',content:'blocked'});
  if (!denied.isError) process.exit(5);
  const deniedInput = await call('write', {path:'input/game.html',content:'blocked'});
  if (!deniedInput.isError) process.exit(6);
  const read = await call('read', {path:'game.html'});
  const original = JSON.parse(read.content[0].text);
  if (!original.content.includes('before')) process.exit(7);
  if ((await call('write', {path:'game.html', content:'<!doctype html><html><body>unfinished'})).isError) process.exit(17);
  const incomplete = await call('capture', {});
  if (!incomplete.isError || !incomplete.content[0].text.includes('game.html is not ready')) process.exit(18);
  if ((await call('write', {path:'game.html', content:original.content})).isError) process.exit(19);
  const patched = await call('patch', {path:'game.html', oldText:'before',newText:'after'});
  if (patched.isError) process.exit(8);
  const capture = await call('capture', {});
  if (capture.isError || capture.content[1].type !== 'image' || capture.content[0].text.includes(capture.content[1].data)) process.exit(9);
  const details = JSON.parse(capture.content[0].text);
  const prepared = JSON.parse((await call('read', {path:'game.html'})).content[0].text);
  const immutable = JSON.parse((await call('read', {path:'input/game.html'})).content[0].text);
  if (details.workspacePreparation?.beforeSha256 !== JSON.parse(patched.content[0].text).sha256 ||
      details.workspacePreparation?.afterSha256 !== prepared.sha256 || details.inputHash !== prepared.sha256 ||
      prepared.content.endsWith('\n') || prepared.content.includes('example.invalid') ||
      immutable.content !== original.content) process.exit(20);
  const picture = capture.content[1];
  const messages = [body, {role:'user',content:[{type:'tool_result',tool_use_id:'synthetic',content:[
    {type:'text', text:capture.content[0].text},
    {type:'image',source:{type:'base64', media_type:picture.mimeType,data:picture.data}},
  ]}]}];
  turn = randomUUID();
  if ((await ask(messages)).status !== 200) process.exit(10);
  const record = {
    requirements:[{id:'goal',text:'Polish',status:'implemented'}],decisions:[],coreChanges:[],
    selfCheck:{findings:[{
      id:'issue',kind:'confirmed',phenomenon:'Fixture overlap',trigger:'After touch',cause:'Hint position',
      minimalChange:'Move the hint',retest:'Repeat touch',evidenceRefs:[details.shots[0].id],coreChange:false,resolved:false,
    }],unverified:[],changes:[],requestRepair:true},
  };
  if ((await call('write', {path:'record.json',content:JSON.stringify(record)})).isError) process.exit(11);
  result('The game is ready.');
} else if (fixture === 'build game') {
  if ((await call('write', {path:'game.html',content:'<!doctype html><html><body>Build</body></html>'})).isError) process.exit(14);
  const record = {requirements:[{id:'goal',text:'Build',status:'implemented'}],decisions:[],coreChanges:[]};
  if ((await call('write', {path:'record.json',content:JSON.stringify(record)})).isError) process.exit(15);
  turn = randomUUID();
  if ((await ask([body])).status !== 200) process.exit(16);
  result('The complete build is ready.');
} else {
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'thinking',thinking:'private synthetic thinking'}]}}));
  result('Synthetic result.');
}
`;

const syntheticSSE = (protocol: string, reason: string, tokens: number) => protocol === 'openai'
  ? `data: ${JSON.stringify({ choices: [{ finish_reason: reason }], usage: { completion_tokens: tokens } })}\n\ndata: [DONE]\n\n`
  : `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: tokens } })}\n\ndata: {"type":"message_stop"}\n\n`;

type Gateway = (request: IncomingMessage, response: ServerResponse, body: any) => void;

it('enumerates and reconstructs a UTF-8 file with parallel UTF-16 workspace reads', async () => {
  const source = '源'.repeat(19_999) + '🎮' + '画'.repeat(19_998) + '🕹️' + '终';
  const entry = fileEntry('input/materials.json', source);
  const context = { run: { purpose: 'game' }, files: new Map([[entry.path, entry]]), outputs: ['game.html', 'record.json'] };
  const call = async (name: string, args: object) => {
    const response = await workspaceResponse(context, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'http://unused.invalid');
    if (!response || !('result' in response)) throw new Error('Workspace fixture did not return a tool result');
    return JSON.parse(response.result.content[0].text);
  };
  const details = { path: entry.path, sha256: entry.sha256, encoding: 'utf8', utf16Length: source.length, utf8Bytes: Buffer.byteLength(source) };
  const { files, readChunkUtf16 } = await call('list', {});
  expect(files).toEqual([details]);
  expect(readChunkUtf16).toBe(20_000);
  const chunks = await Promise.all([0, readChunkUtf16, readChunkUtf16 * 2].map(offset => call('read', { path: entry.path, offset })));
  expect(chunks.map(chunk => chunk.range)).toEqual([
    { start: 0, end: 20_001 }, { start: 20_001, end: 40_001 }, { start: 40_001, end: source.length },
  ]);
  expect(chunks.map(chunk => chunk.nextOffset)).toEqual([20_001, 40_001, null]);
  expect(chunks.map(chunk => chunk.content).join('')).toBe(source);
  for (const chunk of chunks) expect(chunk).toMatchObject(details);
  const sequential = await call('read', { path: entry.path, offset: chunks[0].nextOffset });
  expect(sequential.range.start).toBe(chunks[0].range.end);
  expect((await call('read', { path: entry.path, offset: source.length + 1 })).error).toBe('Invalid offset');
});

describe('Linux container startup verification', () => {
  const capabilityFields = ['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd'];
  const status = [
    'Uid:\t1000\t1000\t1000\t1000',
    ...capabilityFields.map(field => `${field}:\t0000000000000000`),
    'NoNewPrivs:\t1',
  ].join('\n');

  it('requires all five masks empty, no_new_privs, and nonzero real/effective/saved/filesystem UIDs', () => {
    expect(() => assertContainerIsolation(status)).not.toThrow();
    for (const field of capabilityFields) {
      expect(() => assertContainerIsolation(status.replace(
        `${field}:\t0000000000000000`, `${field}:\t0000000000000100`,
      ))).toThrow('Container process isolation is not active');
    }
    for (const uids of ['0 1000 1000 1000', '1000 0 1000 1000', '1000 1000 0 1000', '1000 1000 1000 0']) {
      expect(() => assertContainerIsolation(status.replace(/^Uid:[^\n]+/, `Uid: ${uids}`))).toThrow();
    }
    expect(() => assertContainerIsolation(status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'))).toThrow();
    expect(() => assertContainerIsolation(status.replace(/^CapBnd:[^\n]+$/m, ''))).toThrow();
  });
});

describe('CCB Node runtime boundary', () => {
  let directory: string;
  let childFixture: string;
  let gateway: ReturnType<typeof createServer>;
  let runtime: ReturnType<typeof createHarness>;
  let base: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pgc-runtime-test-'));
    childFixture = join(directory, 'ccb-fixture.mjs');
    await writeFile(childFixture, fixture);
  });

  afterEach(async () => {
    runtime?.close();
    gateway?.close();
    gateway?.closeAllConnections();
    await rm(directory, { recursive: true, force: true });
  });

  async function serve(handler: Gateway) {
    gateway = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      handler(request, response, JSON.parse(Buffer.concat(chunks).toString()));
    });
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('Invalid test gateway');
    runtime = createHarness({ controlToken, gatewayURL: `http://127.0.0.1:${address.port}`, fixtureCli: childFixture, smokeCli: undefined });
    base = `http://127.0.0.1:${(await runtime.listen(0, '127.0.0.1') as { port: number }).port}`;
  }

  const run = (fields: Record<string, unknown> = {}) => ({
    runId: 'synthetic-run', taskId: 'synthetic-task', generation: 'synthetic-generation',
    phase: 'review', purpose: 'review', protocol: 'openai', model: 'deepseek-chat', effort: 'low',
    deadlineAt: Date.now() + 20_000, maxOutputTokens: 64_000, maxTotalOutputTokens: 64_000,
    maxModelTurns: 3, maxRepairs: 0, repair: 0, vision: false,
    prompt: 'synthetic review', systemPrompt: 'Controlled test input.', files: [], ...fields,
  });

  function call(path: string, request?: unknown, runId = 'synthetic-run') {
    return fetch(base + path, {
      method: request ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json', 'x-pgc-harness-run': runId },
      ...(request ? { body: JSON.stringify(request) } : {}),
    });
  }

  function start(envelope: Record<string, unknown>, envelopeSha256 = sha256(canonical(envelope))) {
    return call('/v1/start', { envelope, envelopeSha256, lease });
  }

  async function done() {
    await expect.poll(async () => (await (await call('/v1/status')).json()).state, { timeout: 6000 })
      .not.toBe('running');
    return (await call('/v1/result')).json();
  }

  it('locks the envelope, model, provider cap and private output to one idempotent run', async () => {
    const observed: any[] = [];
    await serve((request, response, body) => {
      observed.push({ headers: request.headers, url: request.url, body });
      response.setHeader('content-type', 'text/event-stream');
      response.end(syntheticSSE('openai', 'stop', 22));
    });
    const envelope = run();
    expect((await fetch(base + '/v1/status')).status).toBe(401);
    expect((await start(envelope, 'a'.repeat(64))).status).toBe(400);
    expect((await start(envelope)).status).toBe(202);
    expect((await start(envelope)).status).toBe(200);
    expect((await start({ ...envelope, prompt: 'changed' })).status).toBe(409);
    const result = await done();
    expect(result).toMatchObject({ state: 'succeeded', modelTurns: 1, outputTokens: 22, text: 'Synthetic result.' });
    expect(JSON.stringify(result)).not.toContain('private synthetic thinking');
    expect(result.files).toEqual([fileEntry('result.txt', 'Synthetic result.')]);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      url: '/v1/chat/completions', body: { max_tokens: 64000, model: 'deepseek-chat' },
      headers: { authorization: `Bearer ${lease}`, 'x-pgc-harness-generation': 'synthetic-generation' },
    });
    expect(observed[0].body).not.toHaveProperty('enable_thinking');
    expect((await call('/v1/result', undefined, 'another-run')).status).toBe(404);
  });

  it.each(['review', 'brief'])('sends the full UTF-8 %s user material and native image on the first model turn', async purpose => {
    const observed: any[] = [];
    await serve((_request, response, body) => {
      observed.push(body);
      response.setHeader('content-type', 'text/event-stream');
      response.end(syntheticSSE('openai', 'stop', 22));
    });
    const source = '画'.repeat(240_000);
    const user = [source, { imagePath: 'input/image-1.png' }];
    const userMaterials = { user, ...(purpose === 'review' && { schema: { type: 'object' } }) };
    const material = JSON.stringify({ system: 'Locked stage system', ...userMaterials });
    const image = {
      path: 'input/image-1.png', encoding: 'base64', content: screenshot,
      sha256: sha256(Buffer.from(screenshot, 'base64')),
    };
    const { systemPrompt: _systemPrompt, ...envelope } = run({
      inlineTaskMaterials: true, purpose, phase: purpose, maxModelTurns: purpose === 'brief' ? 6 : 8, vision: true, imagePaths: [image.path],
      files: [fileEntry('input/materials.json', material), image],
    });
    const oversized = fileEntry('input/materials.json', JSON.stringify({ system: 'Rules', user: '画'.repeat(700_000) }));
    expect((await start({ ...envelope, files: [oversized, image] })).status).toBe(400);
    expect((await start(envelope)).status).toBe(202);
    expect(await done()).toMatchObject({ state: 'succeeded', modelTurns: 1 });
    expect(observed).toHaveLength(1);
    const content = observed[0].messages[0].content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } });
    expect(JSON.parse(content[1].text.split('\n\nLocked task materials (full text; images supplied separately):\n')[1])).toEqual(userMaterials);
  });

  it('captures the platform-prepared HTML and accepts repair references only for its saved bytes', async () => {
    const modelCalls: any[] = [];
    const browserCalls: any[] = [];
    await serve((request, response, body) => {
      if (request.url === '/v1/tools') {
        browserCalls.push(body);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ inputHash: body.arguments.inputHash, shots: [{ id: captureId, data: `data:image/png;base64,${screenshot}` }] }));
      } else {
        modelCalls.push(body);
        response.setHeader('content-type', 'text/event-stream');
        response.end(syntheticSSE('anthropic', modelCalls.length === 1 ? 'tool_use' : 'end_turn', 22));
      }
    });
    expect((await start(run({
      phase: 'polish', purpose: 'game', protocol: 'anthropic', model: 'claude-opus-5-5', effort: 'high', vision: true,
      prompt: 'game with capture', files: [fileEntry('input/game.html', html)],
    }))).status).toBe(202);
    const result = await done();
    const patched = html.replace('before', 'after');
    const saved = await prepareArtifact('game', patched, { creative_version: 2 });
    expect(saved).not.toContain('example.invalid');
    expect(saved.endsWith('\n')).toBe(false);
    expect(result).toMatchObject({ state: 'succeeded', modelTurns: 2, outputTokens: 44 });
    expect(result.files[0]).toEqual(fileEntry('game.html', saved));
    expect(result.files[1].path).toBe('record.json');
    const parsed = parseProductionOutput(await harnessResultText(result, 'game'));
    const preparedOutput = { ...parsed, html: await prepareArtifact('game', parsed.html, { creative_version: 2 }) };
    expect(preparedOutput.html).toBe(saved);
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0]).toMatchObject({ name: 'capture', arguments: { inputHash: sha256(preparedOutput.html), html: preparedOutput.html } });
    const evidence = [{
      evidenceId: captureId.slice(0, -7), evidenceHash: 'b'.repeat(64), origin: 'harness-browser-tool', tool: 'capture',
      inputHash: browserCalls[0].arguments.inputHash, actions: [],
      shots: [{ id: captureId, data: `data:image/png;base64,${screenshot}`, sha256: sha256(Buffer.from(screenshot, 'base64')) }],
    }];
    expect(validateCreationOutput(preparedOutput, 'polish', undefined, undefined, true, evidence, sha256(preparedOutput.html))).toEqual([]);
    const editedOutput = { ...preparedOutput, html: preparedOutput.html.replace('after', 'edited after evidence') };
    expect(validateCreationOutput(editedOutput, 'polish', undefined, undefined, true, evidence, sha256(editedOutput.html))).toEqual([
      'selfCheck.requestRepair requires an evidenced unresolved finding on a current HTML version',
    ]);
    expect(modelCalls).toHaveLength(2);
    expect(modelCalls[0]).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(modelCalls[0]).not.toHaveProperty('metadata');
    expect(modelCalls[1].max_tokens).toBe(64_000 - 22);
    expect(modelCalls[1].messages[1].content[0].content[1].source.data).toBe(screenshot);
  });

  it('accepts the build record without selfCheck and keeps all sixteen game evidence images', async () => {
    const modelCalls: any[] = [];
    await serve((_request, response, body) => {
      modelCalls.push(body);
      response.setHeader('content-type', 'text/event-stream');
      response.end(syntheticSSE('anthropic', modelCalls.length === 1 ? 'tool_use' : 'end_turn', 22));
    });
    const images = Array.from({ length: 17 }, (_, index) => ({
      path: `input/fixture-${index + 1}.png`, content: screenshot, encoding: 'base64',
      sha256: sha256(Buffer.from(screenshot, 'base64')),
    }));
    const build = run({
      phase: 'build', purpose: 'game', protocol: 'anthropic', model: 'claude-opus-5-5', effort: 'high', vision: true,
      prompt: 'build game', files: images, imagePaths: images.map(image => image.path),
    });
    expect((await start(build)).status).toBe(400);
    expect((await start({ ...build, imagePaths: images.slice(0, 16).map(image => image.path) })).status).toBe(202);
    const result = await done();
    expect(result).toMatchObject({ state: 'succeeded', modelTurns: 2 });
    const parsed = parseProductionOutput(await harnessResultText(result, 'game'));
    expect(validateCreationOutput(parsed, 'build')).toEqual([]);
    expect(parsed).toEqual({
      html: '<!doctype html><html><body>Build</body></html>',
      requirements: [{ id: 'goal', text: 'Build', status: 'implemented' }], decisions: [], coreChanges: [],
    });
    expect(modelCalls).toHaveLength(2);
    for (const body of modelCalls) {
      const images = body.messages[0].content.filter((block: any) => block.type === 'image');
      expect(images).toHaveLength(16);
      expect(images.every((image: any) => image.source.data === screenshot)).toBe(true);
    }
  });

  it('cancels the active request and refuses cross-task reuse', async () => {
    let calls = 0;
    await serve((_request, response) => {
      calls++;
      response.setHeader('content-type', 'text/event-stream');
      response.flushHeaders();
    });
    expect((await start(run())).status).toBe(202);
    await expect.poll(() => calls).toBe(1);
    expect((await call('/v1/cancel', {})).status).toBe(200);
    expect(await done()).toMatchObject({ state: 'cancelled', failure: 'cancelled', modelTurns: 1 });
    expect((await start(run({ runId: 'other-run', taskId: 'other-task' }))).status).toBe(409);
    expect(calls).toBe(1);
  });

  it('accepts a declared OpenAI tool name split across native stream chunks', () => {
    const stream = inspectStream('openai', new Set(['mcp__pgc_workspace__read']));
    const encoder = new TextEncoder();
    for (const name of ['mcp__pgc_', 'workspace__read']) {
      stream.push(encoder.encode(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, type: 'function', function: { name } }] } }],
      })}\n\n`));
    }
    stream.push(encoder.encode(syntheticSSE('openai', 'tool_calls', 12)));
    expect(stream.finish()).toEqual({ usage: 12, reason: 'tool_calls' });
  });

  it.each(['anthropic', 'openai'])('blocks unadvertised shell tool injections in %s streams', async protocol => {
    let calls = 0;
    await serve((_request, response) => {
      calls++;
      response.setHeader('content-type', 'text/event-stream');
      const forged = protocol === 'anthropic'
        ? { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } }
        : { choices: [{ delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'Bash' } }] } }] };
      response.end(`data: ${JSON.stringify(forged)}\n\n` +
        syntheticSSE(protocol, protocol === 'anthropic' ? 'tool_use' : 'tool_calls', 22));
    });
    expect((await start(run({ protocol }))).status).toBe(202);
    expect(await done()).toMatchObject({ state: 'failed', failure: 'model_stream_incomplete', modelTurns: 1 });
    expect(calls).toBe(1);
  });

  it('fails incomplete model output without issuing a replacement request', async () => {
    let calls = 0;
    await serve((_request, response) => {
      calls++;
      response.setHeader('content-type', 'text/event-stream');
      response.end('data: {"choices":[{"finish_reason":null}]}\n\n');
    });
    expect((await start(run())).status).toBe(202);
    expect(await done()).toMatchObject({ state: 'failed', failure: 'model_stream_incomplete', modelTurns: 1 });
    expect(calls).toBe(1);
  });
});
