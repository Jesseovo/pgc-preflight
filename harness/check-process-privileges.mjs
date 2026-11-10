import assert from 'node:assert/strict';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { canonical, sha256 } from '/opt/harness/envelope.mjs';

const controlToken = 'synthetic-offline-probe-only';
const lease = 'synthetic-process-isolation-lease';
const runId = 'process-isolation-fixture';
const api = 'http://127.0.0.1:8080';
const headers = {
  authorization: `Bearer ${controlToken}`,
  'content-type': 'application/json',
  'x-pgc-harness-run': runId,
};
const timeoutMs = 15_000;

async function processIds() {
  return (await readdir('/proc')).filter(name => /^\d+$/.test(name));
}

async function liveProcess(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return '';
    throw error;
  });
  const fields = Object.fromEntries(status.split('\n').flatMap(line => {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
  return fields.Pid === pid && fields.State && !/^[ZXx]\b/.test(fields.State) ? fields : null;
}

async function findRuntime() {
  const processes = [];
  for (const pid of await processIds()) {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (!cmdline.split('\0').includes('/opt/harness/runtime.mjs')) continue;
    const candidate = await liveProcess(pid);
    if (candidate) processes.push(candidate);
  }
  assert.equal(processes.length, 1, 'Expected one live harness runtime');
  return processes[0];
}

async function findCli(runtime) {
  // Pinned CCB overwrites argv through process.title before making the
  // synthetic model request. The harness starts only one direct child, via
  // process.execPath with the fixed CCB entry point. Verify that live child
  // and its executable while the synthetic gateway holds its response open.
  const children = [];
  for (const pid of await processIds()) {
    if (pid === String(process.pid)) continue;
    const candidate = await liveProcess(pid);
    if (candidate?.PPid === runtime.Pid) children.push(candidate);
  }
  assert.equal(children.length, 1, 'Expected one live direct CCB child during the synthetic request');
  const [cli] = children;
  const [runtimeExe, cliExe] = await Promise.all([
    readlink(`/proc/${runtime.Pid}/exe`),
    readlink(`/proc/${cli.Pid}/exe`),
  ]);
  assert.equal(cliExe, runtimeExe, 'The direct CCB child must run the same Node executable');
  return cli;
}

function checkPrivileges(fields) {
  const uids = fields.Uid?.split(/\s+/).map(Number);
  assert.equal(uids?.length, 4);
  assert.ok(uids.every(uid => Number.isSafeInteger(uid) && uid > 0));
  assert.equal(fields.NoNewPrivs, '1');
  const masks = Object.fromEntries(['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd'].map(key => {
    assert.match(fields[key], /^0+$/, `${key} retained privileges`);
    return [key, fields[key]];
  }));
  return { uids, noNewPrivs: true, ...masks };
}

const received = Promise.withResolvers();
let syntheticRequests = 0;
const gateway = createServer((request, response) => {
  void (async () => {
    if (request.url !== '/v1/messages' || request.method !== 'POST' ||
        request.headers.authorization !== `Bearer ${lease}`) {
      response.writeHead(403).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'));
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.stream, true);
    syntheticRequests++;
    assert.equal(syntheticRequests, 1);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    received.resolve(response);
  })().catch(error => {
    response.destroy();
    received.reject(error);
  });
});

async function call(route, options = {}) {
  return fetch(api + route, { headers, signal: AbortSignal.timeout(1000), ...options });
}

async function ready() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await call('/v1/health').catch(() => null);
    if (response?.ok && (await response.json()).status === 'ready') return;
    await wait(100);
  }
  throw new Error('Runtime did not become ready');
}

function finish(response) {
  const events = [
    { type: 'message_start', message: { id: 'synthetic-msg', model: 'claude-opus-5-5', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic isolation fixture' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

try {
  await ready();
  assert.equal((await fetch(api + '/v1/health', { signal: AbortSignal.timeout(1000) })).status, 401);
  const runtime = await findRuntime();
  // The actual parent must stay up and keep the default Inspector socket
  // closed after a same-container signal.
  process.kill(Number(runtime.Pid), 'SIGUSR1');
  await wait(400);
  await assert.rejects(fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(1000) }),
    error => error.cause?.code === 'ECONNREFUSED');
  assert.equal((await call('/v1/health')).status, 200);
  await new Promise((resolve, reject) => {
    gateway.once('error', reject);
    gateway.listen(80, '127.0.0.1', resolve);
  });
  const envelope = {
    runId, taskId: 'synthetic-privilege-task', generation: 'synthetic-privilege-generation',
    phase: 'review', purpose: 'review', protocol: 'anthropic', model: 'claude-opus-5-5', effort: 'high',
    deadlineAt: Date.now() + timeoutMs, maxOutputTokens: 2048, maxTotalOutputTokens: 2048,
    maxModelTurns: 1, maxRepairs: 0, repair: 0, vision: false, files: [],
    prompt: 'Produce the synthetic isolation fixture.', systemPrompt: 'Synthetic Linux process-isolation test.',
  };
  const start = await call('/v1/start', {
    method: 'POST', body: JSON.stringify({ envelope, envelopeSha256: sha256(canonical(envelope)), lease }),
  });
  assert.equal(start.status, 202);
  const timeout = new AbortController();
  let response;
  try {
    response = await Promise.race([
      received.promise, wait(timeoutMs, undefined, { signal: timeout.signal }).then(() => { throw new Error('Pinned CCB did not reach the synthetic gateway'); }),
    ]);
  } finally {
    timeout.abort();
  }
  const cli = await findCli(runtime);
  const summary = {
    runtime: checkPrivileges(runtime), cli: checkPrivileges(cli),
    cliIdentity: 'unique-live-direct-node-child', signalInspectorBlocked: true, syntheticRequests,
  };
  finish(response);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await (await call('/v1/status')).json();
    if (status.state !== 'running') {
      assert.equal(status.state, 'succeeded');
      const result = await (await call('/v1/result')).json();
      assert.equal(result.text, 'synthetic isolation fixture');
      console.log(JSON.stringify(summary));
      break;
    }
    await wait(100);
  }
  assert.equal((await (await call('/v1/status')).json()).state, 'succeeded');
} finally {
  gateway.closeAllConnections();
  gateway.close();
}
