import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitIdleResearchWorker, observeResearchAction } from './harness-native-probe-run-state.mjs';

// A fresh research bearer exists only in this process and the research Worker
// Secret. Never pass it in argv, return it, or write it into a local receipt.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const values = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!['--config', '--url', '--out'].includes(args[index]) || !args[index + 1] || values.has(args[index])) {
    throw new Error('Expected --config PATH --url RESEARCH_WORKER_URL --out PRIVATE_DIRECTORY');
  }
  values.set(args[index], args[index + 1]);
}
if (values.size !== 3) throw new Error('Missing research runner arguments');
const configPath = resolve(values.get('--config'));
const config = JSON.parse(await readFile(configPath, 'utf8'));
const url = new URL(values.get('--url'));
const out = resolve(values.get('--out'));
if (!/^pgc-ccb-native-research-[a-z0-9-]+$/.test(config.name) || url.protocol !== 'https:' ||
    url.hostname.split('.')[0] !== config.name || !url.hostname.endsWith('.workers.dev') ||
    url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !out.startsWith(root + '/artifacts/') || config.d1_databases || config.routes || config.queues ||
    config.services || config.assets || config.triggers || config.vars?.HARNESS_RELEASE ||
    resolve(dirname(configPath), config.main) !== resolve(root, 'scripts/harness-native-probe-worker.ts') ||
    config.durable_objects?.bindings?.length !== 1 || config.durable_objects.bindings[0].name !== 'NATIVE_PROBE' ||
    !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/.+@sha256:[a-f0-9]{64}$/.test(config.vars?.RESEARCH_IMAGE ?? '')) {
  throw new Error('Only the isolated, digest-pinned research configuration is allowed');
}
await mkdir(out, { recursive: true, mode: 0o700 });
const bearer = randomBytes(32).toString('hex');
const report = { schemaVersion: 1, worker: config.name, image: config.vars.RESEARCH_IMAGE,
  startedAt: new Date().toISOString(), providerCalls: 0, secretConfigured: false,
  preflight: null, network: null, timeout: null, overallIsolationAccepted: false };
async function save() {
  const text = JSON.stringify(report, null, 2).replaceAll(bearer, '[redacted]') + '\n';
  await writeFile(resolve(out, 'native-probe-run.json'), text, { mode: 0o600 });
}
async function configureSecret() {
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
      'secret', 'put', 'HARNESS_RESEARCH_TOKEN', '--config', configPath], {
      cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', () => { clearTimeout(timer); fail(new Error('Research Secret setup could not start')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? done() : fail(new Error('Research Secret setup failed')); });
    child.stdin.on('error', () => {});
    child.stdin.end(bearer);
  });
}
async function request(path, method, timeoutMs) {
  let httpStatus = null;
  try {
    const response = await fetch(new URL(path, url), { method, redirect: 'manual',
      headers: { Authorization: 'Bearer ' + bearer }, signal: AbortSignal.timeout(timeoutMs) });
    httpStatus = response.status;
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > 512_000) throw new Error('Response exceeds research limit');
      chunks.push(chunk);
    }
    return { httpStatus, receipt: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { httpStatus, receipt: null, executionState: 'unknown' };
  }
}
await save();
try {
  await configureSecret();
  report.secretConfigured = true; await save();
  report.preflight = await awaitIdleResearchWorker(request); await save();
  if (report.preflight.outcome === 'ready') {
    console.log('Research Worker confirmed idle; starting one fixed synthetic run.');
    report.network = await observeResearchAction(request, '/run', 'run'); await save();
    if (report.network.receipt?.action === 'run' && report.network.receipt.checks?.containerDestroyed === true) {
      console.log('First container closed; checking alarm cleanup.');
      report.timeout = await observeResearchAction(request, '/arm-timeout', 'arm-timeout'); await save();
    }
  }
} catch {
  report.executionError = 'research_runner_failed';
} finally {
  report.completedAt = new Date().toISOString();
  await save();
}
console.log(JSON.stringify({ worker: config.name, receipt: resolve(out, 'native-probe-run.json'),
  preflight: report.preflight?.outcome ?? 'not-run', networkState: report.network?.receipt?.state ?? 'unknown', timeoutState: report.timeout?.receipt?.state ?? 'not-run',
  providerCalls: 0, overallIsolationAccepted: false }));
if (!report.secretConfigured || report.preflight?.outcome !== 'ready' || !report.network?.receipt || report.network.receipt.state === 'running' ||
    report.network.receipt.checks?.containerDestroyed !== true || report.timeout?.receipt?.checks?.alarmCleanup !== true) process.exitCode = 1;
