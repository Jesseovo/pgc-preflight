import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { relative, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { canonical, sha256 } from '../harness/envelope.mjs';
import { createHarness } from '../harness/runtime.mjs';
import {
  DEEPSEEK_RESEARCH_FIXTURE_ID, DEEPSEEK_RESEARCH_MODEL, DEEPSEEK_RESEARCH_OUTPUT_CAP, DEEPSEEK_RESEARCH_PATH,
  DEEPSEEK_RESEARCH_READ, DEEPSEEK_RESEARCH_RESULT, DEEPSEEK_RESEARCH_TOTAL_CAP, DEEPSEEK_RESEARCH_TURN_CAP, DEEPSEEK_RESEARCH_WIRE,
  deepSeekResearchAssistant, deepSeekResearchFixtureEnvelope, deepSeekResearchFixtureSourceHash, matchDeepSeekResearchRequest,
} from '../server/harness-provider-deepseek-fixture';
import type { HarnessRun } from '../server/harness-ledger';

const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
const output = resolve(artifacts, 'ccb-harness-deepseek-fixture', DEEPSEEK_RESEARCH_FIXTURE_ID);
const checkOnly = process.argv[3] === '--check-only';
assert.equal(process.argv.length, checkOnly ? 4 : 3);
const entry = await realpath(resolve(process.argv[2] ?? ''));
const child = relative(artifacts, entry);
assert.ok(child && !child.startsWith('..') && entry.endsWith('/dist/cli-node.js'), 'Provide the privately built pinned CCB CLI under artifacts/');
const controlToken = 'synthetic-deepseek-compatibility-control';
const lease = 'synthetic-deepseek-compatibility-lease';
const identity = { runId: 'fixture-synthetic', taskId: 'fixture-task', generation: 'fixture-generation' };
const toolId = 'call_synthetic_marker';
const reasoning = 'Synthetic compatibility reasoning.';
const toolArgs = { path: DEEPSEEK_RESEARCH_PATH };
const resultText = JSON.stringify(DEEPSEEK_RESEARCH_RESULT);
const captured: any[] = [];
const requestIds: string[] = [];

const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${lease}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, DEEPSEEK_RESEARCH_MODEL);
    assert.equal(body.max_tokens, DEEPSEEK_RESEARCH_OUTPUT_CAP);
    const requestId = request.headers['x-pgc-harness-request-id'];
    assert.equal(typeof requestId, 'string');
    requestIds.push(requestId as string);
    captured.push(body);
    const index = captured.length;
    assert.ok(index <= 2);
    const chunksFor = (choice: object | null, usage: object | null = null) => ({
      id: `chatcmpl-fixture-${index}`, object: 'chat.completion.chunk', created: 1_800_000_000,
      model: DEEPSEEK_RESEARCH_MODEL, choices: choice ? [{ index: 0, ...choice }] : [], usage,
    });
    const delta = (value: object) => chunksFor({ delta: value, finish_reason: null });
    const events = [delta({ role: 'assistant', content: '' }),
      ...(index === 1 ? [
        delta({ reasoning_content: reasoning.slice(0, 10) }), delta({ reasoning_content: reasoning.slice(10) }),
        delta({ tool_calls: [{ index: 0, id: toolId, type: 'function', function: { name: DEEPSEEK_RESEARCH_READ, arguments: '' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolArgs) } }] }),
      ] : [delta({ content: resultText })]),
      chunksFor({ delta: {}, finish_reason: index === 1 ? 'tool_calls' : 'stop' }),
      chunksFor(null, { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, completion_tokens_details: { reasoning_tokens: index === 1 ? 5 : 0 } }),
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  })().catch(error => {
    response.destroy();
    console.error(error instanceof Error ? error.message : 'Synthetic gateway failed');
    process.exitCode = 1;
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const runtime = createHarness({ controlToken, gatewayURL: `http://127.0.0.1:${address.port}`, fixtureCli: undefined, smokeCli: entry });
try {
  const listener = await runtime.listen(0, '127.0.0.1') as { port: number };
  const call = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${listener.port}${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(2000),
    headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json', 'x-pgc-harness-run': identity.runId },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const startedAt = Date.now();
  const deadline = startedAt + 15_000;
  const envelope = await deepSeekResearchFixtureEnvelope(identity, deadline);
  const started = await call('/v1/start', { envelope, envelopeSha256: sha256(canonical(envelope)), lease });
  assert.equal(started.status, 202);
  while (Date.now() < deadline && (await (await call('/v1/status')).json()).state === 'running') await wait(100);
  const result = await (await call('/v1/result')).json();
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  assert.equal(result.modelTurns, 2);
  assert.equal(result.outputTokens, 20);
  assert.deepEqual(JSON.parse(result.text), DEEPSEEK_RESEARCH_RESULT);
  assert.equal(captured.length, 2);
  const sourceHash = await deepSeekResearchFixtureSourceHash();
  assert.equal(sourceHash, DEEPSEEK_RESEARCH_WIRE.sourceHash);
  const model = { model: DEEPSEEK_RESEARCH_MODEL, protocol: 'openai', purpose: 'review', effort: 'low', vision: true,
    maxOutputTokens: DEEPSEEK_RESEARCH_OUTPUT_CAP, profileId: 'synthetic', profileHash: '0'.repeat(64) } as const;
  const run: HarnessRun = { ...identity, actor: 'admin', ownerId: 'admin', family: 'review', sourceHash,
    snapshotHash: '0'.repeat(64), model, slot: 1, status: 'active', failureCode: null, startedAt, deadlineAt: deadline,
    endedAt: null, releasedAt: null, maxRepairs: 0, maxTotalOutputTokens: DEEPSEEK_RESEARCH_TOTAL_CAP,
    maxModelTurns: DEEPSEEK_RESEARCH_TURN_CAP, modelTurns: 0, outputTokens: 0, reservedTokens: 0 };
  const prior = sha256(canonical([deepSeekResearchAssistant(null, reasoning, toolId, DEEPSEEK_RESEARCH_READ, JSON.stringify(toolArgs))]));
  for (const [index, body] of captured.entries()) {
    assert.equal(await matchDeepSeekResearchRequest(body, model, { requestId: requestIds[index],
      run: { ...run, modelTurns: index, outputTokens: index * 10 }, readPriorAssistantDigest: async () => index ? prior : null }), true);
  }
  if (!checkOnly) {
    await mkdir(output, { recursive: true, mode: 0o700 });
    assert.equal(await realpath(output), output);
    const synthetic = { fixture: DEEPSEEK_RESEARCH_FIXTURE_ID, sourceHash, wire: DEEPSEEK_RESEARCH_WIRE,
      synthetic: true, realProviderCalls: 0, modelTurns: result.modelTurns, outputTokens: result.outputTokens };
    for (const [name, data] of Object.entries({ first: captured[0], continuation: captured[1], receipt: synthetic })) {
      await writeFile(resolve(output, `${name}.synthetic.json`), JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
  }
  console.log('Pinned CCB completed two scripted OpenAI Chat Completions turns.');
} finally {
  runtime.close();
  server.close();
  server.closeAllConnections();
}
