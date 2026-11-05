import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, fileEntry, LIMITS, sha256, validateStart } from './envelope.mjs';
import { bridgeModel, parseGatewayURL, readBody, reply } from './model-bridge.mjs';
import { workspaceResponse } from './workspace.mjs';

const pinnedCli = '/opt/ccb/dist/cli-node.js';
const networkLock = fileURLToPath(new URL('./network-lock.mjs', import.meta.url));
const maxLineBytes = 4 * 1024 * 1024;

function matches(value, expected) {
  if (typeof value !== 'string' || Buffer.byteLength(value) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function status(context) {
  const { run, state, failure, modelIds, outputTokens } = context;
  return { runId: run.runId, taskId: run.taskId, phase: run.phase, state, failure, modelTurns: modelIds.size, outputTokens };
}

function serve(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  if (!server?.listening) return;
  server.close();
  server.closeAllConnections();
}

async function launch(context, origin, cli, fixture) {
  const { run, root } = context;
  const cwd = join(root, 'workspace');
  const home = join(root, 'home');
  const config = join(root, 'mcp.json');
  const system = join(root, 'system.txt');
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await writeFile(config, JSON.stringify({
    mcpServers: {
      pgc_workspace: { type: 'http', url: `${origin}/mcp`, headers: { 'x-pgc-workspace': context.toolSecret } },
    },
  }), { mode: 0o600 });
  await writeFile(system, run.systemPrompt, { mode: 0o600 });

  const args = [
    '--print', '--bare', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands',
    '--tools', '', '--strict-mcp-config', '--mcp-config', config,
    '--permission-mode', 'bypassPermissions', '--model', run.model,
    '--max-turns', String(run.maxModelTurns), '--system-prompt-file', system,
  ];
  if (['low', 'medium', 'high', 'max'].includes(run.effort)) args.push('--effort', run.effort);
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home, TMPDIR: root, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(run.maxOutputTokens),
    DISABLE_AUTO_COMPACT: '1', DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1', ENABLE_SEARCH_EXTRA_TOOLS: 'false',
    PGC_CCB_HARNESS: '1', PGC_CCB_LOOPBACK_PORT: new URL(origin).port,
    ANTHROPIC_BASE_URL: origin, ANTHROPIC_API_KEY: 'pgc-loopback-only',
    OPENAI_BASE_URL: `${origin}/v1`, OPENAI_API_KEY: 'pgc-loopback-only',
    ...(run.protocol === 'openai' && { CLAUDE_CODE_USE_OPENAI: '1', OPENAI_MODEL: run.model }),
    ...(run.effort === 'xhigh' && { CLAUDE_CODE_EFFORT_LEVEL: run.effort }),
  };
  if (context.abort.signal.aborted) return;
  const entry = await realpath(cli);
  if (context.abort.signal.aborted) return;
  const permissions = [
    '--permission', `--allow-fs-read=${fixture ? dirname(entry) : dirname(dirname(entry))}`,
    `--allow-fs-read=${root}`, `--allow-fs-read=${networkLock}`, `--allow-fs-write=${home}`,
  ];
  return spawn(process.execPath, [...permissions, '--import', networkLock, entry, ...args], {
    cwd, env, stdio: ['pipe', 'pipe', 'ignore'],
  });
}

function consumeOutput(child, context, stop) {
  let pending = '';
  let result;
  let valid = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (context.abort.signal.aborted) return;
    pending += chunk;
    try {
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > maxLineBytes) throw new Error('Output exceeds limit');
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message?.type !== 'result') continue;
        if (result !== undefined) throw new Error('Multiple terminal events');
        result = typeof message.result === 'string' ? message.result : null;
        valid = message.subtype === 'success' && message.is_error === false &&
          (result === null || Buffer.byteLength(result) <= LIMITS.fileBytes);
      }
      if (Buffer.byteLength(pending) > maxLineBytes) throw new Error('Output exceeds limit');
    } catch {
      pending = '';
      stop('invalid_ccb_output');
    }
  });
  return () => ({ result, valid: valid && !pending.trim() });
}

function resultArtifacts(context, terminal) {
  if (!terminal.valid || context.modelIds.size === 0 || context.activeModel || context.canContinue) return null;
  const { run, outputs } = context;
  const files = outputs.map(path => context.files.get(path)).filter(Boolean);
  if (run.purpose === 'game') {
    if (files.length !== 2 || !/<(?:!doctype\s+html|html(?:\s|>))/i.test(files[0].content)) return null;
    try {
      const record = JSON.parse(files[1].content);
      const fields = ['requirements', 'decisions', 'coreChanges'];
      if (run.phase !== 'build') fields.push('selfCheck');
      if (!record || typeof record !== 'object' || Array.isArray(record) ||
          Object.keys(record).length !== fields.length || !fields.every(key => Object.hasOwn(record, key))) return null;
    } catch {
      return null;
    }
    return { files };
  }
  if (!files.length && terminal.result?.trim()) files.push(fileEntry(outputs[0], terminal.result));
  if (!files[0]?.content.trim()) return null;
  return { text: files[0].content, files };
}

export function createHarness({ controlToken, gatewayURL, fixtureCli, smokeCli, enableProbe = false }) {
  if (typeof controlToken !== 'string' || controlToken.length < 24) throw new Error('Missing harness control token');
  if (fixtureCli && smokeCli) throw new Error('Choose one fixture entry point');
  const cli = fixtureCli ?? smokeCli ?? pinnedCli;
  const gateway = parseGatewayURL(gatewayURL, Boolean(fixtureCli || smokeCli));
  const seen = new Map();
  const browserBudget = { captures: 0, screenshots: 0 };
  let current;
  let shuttingDown = false;

  async function execute(context) {
    const { run } = context;
    let loopback;
    let child;
    let killTimer;
    const abort = () => {
      close(loopback);
      if (child?.pid) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        killTimer.unref();
      }
    };
    const stop = (reason, respond) => {
      if (context.abort.signal.aborted || context.state !== 'running') return;
      context.failure = reason;
      respond?.();
      context.abort.abort();
    };
    context.abort.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => stop('deadline_exceeded'), Math.max(1, run.deadlineAt - Date.now()));
    try {
      context.root = await mkdtemp(join(await realpath(tmpdir()), 'pgc-ccb-'));
      loopback = createServer((request, response) => {
        if (context.abort.signal.aborted) return reply(response, 410, { error: 'Run ended' });
        if (request.url === '/mcp') {
          if (!matches(request.headers['x-pgc-workspace'], context.toolSecret)) return reply(response, 403, { error: 'Operation denied' });
          if (request.method !== 'POST') {
            response.writeHead(405).end();
            return;
          }
          void readBody(request, LIMITS.fileBytes * 2).then(async raw => {
            if (context.abort.signal.aborted) return reply(response, 410, { error: 'Run ended' });
            const body = await workspaceResponse(context, JSON.parse(raw.toString('utf8')), gateway);
            if (body === null) response.writeHead(202).end();
            else reply(response, 200, body);
          }).catch(() => reply(response, 400, { error: 'Invalid tool request' }));
          return;
        }
        void bridgeModel(context, request, response, gateway, stop);
      });
      loopback.requestTimeout = 30_000;
      const address = await serve(loopback, 0, '127.0.0.1');
      child = await launch(context, `http://127.0.0.1:${address.port}`, cli, Boolean(fixtureCli));
      if (!child) return;
      const finalOutput = consumeOutput(child, context, stop);
      child.stdin.on('error', () => {});
      const completion = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      child.stdin.end(JSON.stringify({
        type: 'user', message: { role: 'user', content: [...context.images, { type: 'text', text: run.prompt }] },
        parent_tool_use_id: null, session_id: '',
      }) + '\n');
      const code = await completion;
      if (!context.abort.signal.aborted && code === 0) context.result = resultArtifacts(context, finalOutput());
      if (!context.result && !context.failure) context.failure = 'ccb_incomplete';
    } catch {
      context.failure ??= 'ccb_start_failed';
    } finally {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      close(loopback);
      context.abort.abort();
      if (context.root) {
        try {
          await rm(context.root, { recursive: true, force: true });
        } catch {
          context.result = null;
          context.failure = 'workspace_cleanup_failed';
        }
      }
      context.files.clear();
      context.images.length = 0;
      context.lease = '';
      context.toolSecret = '';
      context.run = { runId: run.runId, taskId: run.taskId, phase: run.phase };
      context.state = context.result ? 'succeeded' : context.failure === 'cancelled' ? 'cancelled' : 'failed';
    }
  }

  const server = createServer((request, response) => {
    if (!matches(request.headers.authorization, `Bearer ${controlToken}`)) return reply(response, 401, { error: 'Unauthorized' });
    if (request.method === 'GET' && request.url === '/v1/health' && enableProbe) {
      return reply(response, 200, { status: 'ready' });
    }
    if (request.method === 'POST' && request.url === '/v1/start') {
      void readBody(request, 20 * 1024 * 1024).then(raw => {
        const body = JSON.parse(raw.toString('utf8'));
        const old = seen.get(body?.envelope?.runId);
        if (old) {
          if (old !== current || body.envelopeSha256 !== current.envelopeSha256 ||
              sha256(canonical(body.envelope)) !== current.envelopeSha256 ||
              typeof body.lease !== 'string' || sha256(body.lease) !== current.leaseHash) {
            return reply(response, 409, { error: 'Run identity already used' });
          }
          return reply(response, 200, status(current));
        }
        const verified = validateStart(body, Date.now());
        if (!verified) return reply(response, 400, { error: 'Invalid run envelope' });
        if (shuttingDown || current?.state === 'running' || seen.size >= 32) return reply(response, 409, { error: 'Harness unavailable' });
        if (current && (current.run.taskId !== verified.run.taskId || current.generation !== verified.run.generation)) {
          return reply(response, 409, { error: 'Container belongs to a different task' });
        }
        const next = {
          ...verified, generation: verified.run.generation, leaseHash: sha256(verified.lease),
          toolSecret: randomBytes(32).toString('hex'), state: 'running', abort: new AbortController(),
          modelIds: new Set(), outputTokens: 0, activeModel: false, canContinue: false,
          browserToolIds: new Set(), browserSessions: new Map(), browserBudget,
        };
        if (current) seen.set(current.run.runId, true);
        current = next;
        seen.set(next.run.runId, next);
        reply(response, 202, status(next));
        void execute(next);
      }).catch(() => reply(response, 400, { error: 'Invalid run request' }));
      return;
    }
    if (!current || request.headers['x-pgc-harness-run'] !== current.run.runId) return reply(response, 404, { error: 'Run not found' });
    if (request.method === 'GET' && request.url === '/v1/status') return reply(response, 200, status(current));
    if (request.method === 'GET' && request.url === '/v1/result') {
      if (!current.result || current.state !== 'succeeded') return reply(response, 409, status(current));
      return reply(response, 200, { ...status(current), ...current.result });
    }
    if (request.method === 'POST' && request.url === '/v1/cancel') {
      if (current.state === 'running' && !current.abort.signal.aborted) {
        current.failure = 'cancelled';
        current.abort.abort();
      }
      return reply(response, 200, status(current));
    }
    return reply(response, 404, { error: 'Not found' });
  });
  server.requestTimeout = 30_000;

  return {
    listen: (port = 8080, host = '0.0.0.0') => serve(server, port, host),
    close() {
      shuttingDown = true;
      current?.abort.abort();
      close(server);
    },
  };
}

export function assertContainerIsolation(status) {
  const uids = /^Uid:[ \t]*(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/m.exec(status)?.slice(1);
  if (!uids || uids.some(uid => Number(uid) === 0) || !/^NoNewPrivs:[ \t]*1[ \t]*$/m.test(status) ||
      !['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd'].every(field =>
        new RegExp(`^${field}:[ \\t]*0+[ \\t]*$`, 'm').test(status))) {
    throw new Error('Container process isolation is not active');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertContainerIsolation(readFileSync('/proc/self/status', 'utf8'));
    const runtime = createHarness({
      controlToken: process.env.PGC_HARNESS_CONTROL_TOKEN,
      gatewayURL: process.env.PGC_HARNESS_GATEWAY_URL,
      enableProbe: true,
    });
    await runtime.listen();
    process.on('SIGTERM', () => runtime.close());
    process.on('SIGINT', () => runtime.close());
  } catch {
    process.exitCode = 1;
  }
}
