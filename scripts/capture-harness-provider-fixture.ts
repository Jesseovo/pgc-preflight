import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { relative, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../harness/runtime.mjs';
import { canonical, sha256 } from '../harness/envelope.mjs';
import {
  OPUS_RESEARCH_FINAL, OPUS_RESEARCH_FIXTURE_ID, OPUS_RESEARCH_HTML, OPUS_RESEARCH_MODEL, OPUS_RESEARCH_RECORD, OPUS_RESEARCH_TOOL,
  OPUS_RESEARCH_OUTPUT_CAP, OPUS_RESEARCH_TOTAL_CAP, OPUS_RESEARCH_TURN_CAP, OPUS_RESEARCH_WIRE,
  matchOpusResearchRequest, opusResearchFixtureEnvelope, opusResearchFixtureSourceHash,
} from '../server/harness-provider-fixture';
import type { HarnessRun } from '../server/harness-ledger';

const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
const output = resolve(artifacts, 'ccb-harness-20261105/provider-fixture', OPUS_RESEARCH_FIXTURE_ID);
const entry = await realpath(resolve(process.argv[2] ?? ''));
const child = relative(artifacts, entry);
assert.ok(child && !child.startsWith('..') && entry.endsWith('/dist/cli-node.js'), 'Provide the privately built pinned CCB CLI under artifacts/');
const controlToken = 'synthetic-compatibility-control';
const lease = 'synthetic-compatibility-lease';
const identity = { runId: 'fixture-synthetic', taskId: 'fixture-task', generation: 'fixture-generation' };
const captured: Record<string, unknown>[] = [];
const requestIds: string[] = [];
const assistant: Record<string, unknown>[] = [
  { type: 'thinking', thinking: 'Synthetic rationale for compatibility verification.', signature: 'c3ludGhldGljLXNpZ25hdHVyZQ==' },
  { type: 'text', text: 'I will write the synthetic record.' },
  { type: 'tool_use', id: 'toolu_fixture_synthetic', name: OPUS_RESEARCH_TOOL,
    input: { path: 'record.json', content: OPUS_RESEARCH_RECORD } },
];

function partsFor(block: Record<string, unknown>, index: number): Record<string, unknown>[] {
  const start = (content_block: Record<string, unknown>) => ({ type: 'content_block_start', index, content_block });
  const delta = (value: Record<string, unknown>) => ({ type: 'content_block_delta', index, delta: value });
  let parts;
  switch (block.type) {
    case 'thinking':
      parts = [start({ type: 'thinking', thinking: '', signature: '' }), delta({ type: 'thinking_delta', thinking: block.thinking }), delta({ type: 'signature_delta', signature: block.signature })];
      break;
    case 'text':
      parts = [start({ type: 'text', text: '' }), delta({ type: 'text_delta', text: block.text })];
      break;
    case 'tool_use':
      parts = [start({ type: 'tool_use', id: block.id, name: block.name, input: {} }),
        delta({ type: 'input_json_delta', partial_json: JSON.stringify(block.input) })];
      break;
    default:
      throw new Error('Unsupported synthetic block');
  }
  return [...parts, { type: 'content_block_stop', index }];
}

const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/messages');
    assert.equal(request.headers.authorization, `Bearer ${lease}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, OPUS_RESEARCH_MODEL);
    assert.equal(body.max_tokens, 64_000);
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.deepEqual(body.output_config, { effort: 'high' });
    const requestId = request.headers['x-pgc-harness-request-id'];
    assert.equal(typeof requestId, 'string');
    requestIds.push(requestId as string);
    captured.push(body);
    const index = captured.length;
    assert.ok(index <= 2);
    const events = [
      { type: 'message_start', message: { id: `msg_fixture_${index}`, model: OPUS_RESEARCH_MODEL, type: 'message', role: 'assistant',
        content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0 } } },
      ...(index === 1 ? assistant : [{ type: 'text', text: OPUS_RESEARCH_FINAL }]).flatMap(partsFor),
      { type: 'message_delta', delta: { stop_reason: index === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  })().catch(error => {
    response.destroy();
    console.error(error instanceof Error ? error.message : 'Synthetic gateway failed');
    process.exitCode = 1;
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const runtime = createHarness({
  controlToken, gatewayURL: `http://127.0.0.1:${address.port}`, fixtureCli: undefined, smokeCli: entry,
});
try {
  const listener = await runtime.listen(0, '127.0.0.1') as { port: number };
  const call = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${listener.port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json', 'x-pgc-harness-run': identity.runId },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(2000),
  });
  const startedAt = Date.now();
  const deadline = startedAt + 15_000;
  const envelope = await opusResearchFixtureEnvelope(identity, deadline);
  const started = await call('/v1/start', { envelope, envelopeSha256: sha256(canonical(envelope)), lease });
  assert.equal(started.status, 202);
  while (Date.now() < deadline && (await (await call('/v1/status')).json()).state === 'running') await wait(100);
  const result = await (await call('/v1/result')).json();
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  assert.equal(result.modelTurns, 2);
  assert.equal(result.outputTokens, 20);
  assert.equal(captured.length, 2);
  assert.deepEqual(result.files.map((file: { path: string; content: string }) => [file.path, file.content]),
    [['game.html', OPUS_RESEARCH_HTML], ['record.json', OPUS_RESEARCH_RECORD]]);
  const sourceHash = await opusResearchFixtureSourceHash();
  assert.equal(sourceHash, OPUS_RESEARCH_WIRE.sourceHash);
  assert.deepEqual(envelope.files.slice(1).map(file => file.sha256), OPUS_RESEARCH_WIRE.imageSha256);
  const model = { model: OPUS_RESEARCH_MODEL, protocol: 'anthropic', purpose: 'game', effort: 'high', vision: true,
    maxOutputTokens: OPUS_RESEARCH_OUTPUT_CAP, profileId: 'synthetic', profileHash: '0'.repeat(64) } as const;
  const run: HarnessRun = {
    taskId: identity.taskId, generation: identity.generation, actor: 'admin', family: 'forge', ownerId: 'admin',
    sourceHash, snapshotHash: '0'.repeat(64), model, slot: 1, status: 'active', failureCode: null, startedAt,
    deadlineAt: deadline, endedAt: null, releasedAt: null, maxRepairs: 0, maxTotalOutputTokens: OPUS_RESEARCH_TOTAL_CAP,
    maxModelTurns: OPUS_RESEARCH_TURN_CAP, modelTurns: 0, outputTokens: 0, reservedTokens: 0,
  };
  const priorDigest = sha256(canonical(assistant));
  for (const [index, body] of captured.entries()) {
    assert.equal(await matchOpusResearchRequest(body, model, {
      requestId: requestIds[index], run: { ...run, modelTurns: index, outputTokens: index * 10 },
      readPriorAssistantDigest: async () => index ? priorDigest : null,
    }), true, 'Pinned CCB produced an unexpected fixture request');
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(output), output, 'Synthetic fixture output must stay in the private directory');
  for (const [name, value] of Object.entries({ first: captured[0], continuation: captured[1], assistant })) {
    await writeFile(resolve(output, `${name}.synthetic.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  await writeFile(resolve(output, 'synthetic-receipt.json'), JSON.stringify({
    fixture: OPUS_RESEARCH_FIXTURE_ID, sourceHash, wire: OPUS_RESEARCH_WIRE, firstAssistantSha256: priorDigest,
    synthetic: true, modelTurns: result.modelTurns, outputTokens: result.outputTokens,
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Pinned CCB synthetic provider fixture completed two native turns with original images and one allowed workspace write.');
} finally {
  runtime.close();
  server.close();
  server.closeAllConnections();
}
