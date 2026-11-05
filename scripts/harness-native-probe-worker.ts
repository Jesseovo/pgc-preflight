import { WorkerEntrypoint } from 'cloudflare:workers';
import { scopeHarnessOutbound, type HarnessOutboundScope } from '../server/harness-outbound-scope';
import { isHarnessImage } from '../server/harness-protocol';

type Binding = { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
type Env = { NATIVE_PROBE: Binding; HARNESS_RESEARCH_TOKEN: string; RESEARCH_IMAGE: string };
type Action = 'run' | 'arm-timeout';
type Check = boolean | null;
type Capabilities = { uids: number[] | null; effective: string | null; permitted: string | null; inheritable: string | null; ambient: string | null; bounding: string | null; noNewPrivs: boolean | null };
type Inspection = { runtime: Capabilities | null; cli: Capabilities | null; childSecretIsolation: boolean | null; workspaceEmpty: boolean };
type Receipt = {
  image: string; action: Action; state: 'running' | 'passed' | 'failed'; releaseReady: false; error?: string;
  checks: Record<string, Check>; processes?: Pick<Inspection, 'runtime' | 'cli'>; cleanup?: 'request' | 'alarm';
};
type Active = { action: Action; taskId: string; generation: string; lease: string; runId: string; control: string; deadlineAt: number; image: string };
const maxRunMs = 90_000;
const runtimeRunMs = 24_000;
const internal = 'http://pgc-native-probe.internal';
const gateway = 'http://pgc-harness.internal';
const probeName = 'native-research';
const probeMarker = 'x-pgc-native-probe';
const hash = /^[a-f0-9]{64}$/;
const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const encoder = new TextEncoder();

function secret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function matches(a: string | null, b: string): boolean {
  if (a === null || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';
  return JSON.stringify(value);
}
async function sha(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function configured(env: Env): boolean {
  return hash.test(env.HARNESS_RESEARCH_TOKEN ?? '') && isHarnessImage(env.RESEARCH_IMAGE) && Boolean(env.NATIVE_PROBE);
}
const deny = () => json({ error: 'probe_denied' }, 403, { [probeMarker]: 'blocked' });

/** A separate entrypoint with no provider or D1 binding. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!configured(env) || !matches(request.headers.get('authorization'), 'Bearer ' + env.HARNESS_RESEARCH_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const action = url.pathname;
    const method = action === '/status' ? 'GET' : 'POST';
    if (url.search || request.method !== method || request.body || !['/run', '/arm-timeout', '/status'].includes(action)) return json({ error: 'route_denied' }, 404);
    return env.NATIVE_PROBE.get(env.NATIVE_PROBE.idFromName(probeName)).fetch(new Request(internal + action, { method }));
  },
};

/** This handler deliberately has no outbound fetch path. */
export class NativeProbeOutbound extends WorkerEntrypoint<Env, HarnessOutboundScope> {
  async fetch(request: Request) {
    const forwarded = scopeHarnessOutbound(request, this.ctx.props);
    if (!forwarded || new URL(forwarded.url).pathname !== '/v1/messages') return deny();
    const id = forwarded.headers.get('x-pgc-harness-request-id');
    if (id === 'probe-0-direct') return json({ fixture: true }, 200, { [probeMarker]: 'allowed' });
    if (!/^probe-0-[a-f0-9-]{36}$/.test(id ?? '')) return deny();
    const stub = this.env.NATIVE_PROBE.get(this.env.NATIVE_PROBE.idFromName(probeName));
    const observed = await stub.fetch(new Request(internal + '/observed', {
      method: 'POST', headers: { Authorization: 'Bearer ' + this.ctx.props.lease },
    }));
    if (!observed.ok) return deny();
    // Keep the real CLI alive on a synthetic response until its own deadline.
    // No provider is called and no prompt or model output is persisted.
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(': native-research-fixture\n\n')); },
    }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', [probeMarker]: 'fixture' } });
  }
}

const inspectScript = String.raw`
import fs from 'node:fs';
const read = (path) => { try { return fs.readFileSync(path, 'utf8'); } catch { return null; } };
function proc(entry) {
  const base = '/proc/' + entry;
  const cmd = read(base + '/cmdline');
  if (!cmd) return null;
  const args = cmd.split('\0');
  const role = args.includes('/opt/harness/runtime.mjs') ? 'runtime' : args.includes('/opt/ccb/dist/cli-node.js') ? 'cli' : null;
  if (!role) return null;
  const status = read(base + '/status');
  const field = (name) => status?.match(new RegExp('^' + name + ':\\s*([^\\s]+)', 'm'))?.[1] ?? null;
  const uids = status?.match(/^Uid:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m)?.slice(1).map(Number) ?? null;
  const noNewPrivs = field('NoNewPrivs');
  const hex = (name) => { const v = field(name); return /^[0-9a-f]{8,32}$/.test(v ?? '') ? v : null; };
  const environment = read(base + '/environ');
  const parsed = environment === null ? null : new Map(environment.split('\0').filter(x=>x.includes('=')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
  return { role, capabilities: { uids, effective: hex('CapEff'), permitted: hex('CapPrm'), inheritable: hex('CapInh'), ambient: hex('CapAmb'),
    bounding: hex('CapBnd'), noNewPrivs: noNewPrivs === null ? null : noNewPrivs === '1' },
    isolated: parsed === null ? null : role === 'runtime' ? parsed.has('PGC_HARNESS_CONTROL_TOKEN') &&
      !parsed.has('SETTINGS_KEY') && !parsed.has('HARNESS_RESEARCH_TOKEN') && !parsed.has('ANTHROPIC_API_KEY') && !parsed.has('OPENAI_API_KEY') :
      !parsed.has('PGC_HARNESS_CONTROL_TOKEN') && !parsed.has('PGC_HARNESS_GATEWAY_URL') &&
      !parsed.has('SETTINGS_KEY') && !parsed.has('HARNESS_RESEARCH_TOKEN') &&
      parsed.get('ANTHROPIC_API_KEY') === 'pgc-loopback-only' && parsed.get('OPENAI_API_KEY') === 'pgc-loopback-only' };
}
const entries = fs.readdirSync('/proc').filter(name=>/^\d+$/.test(name)).slice(0,128).map(proc).filter(Boolean);
const runtime = entries.find(entry=>entry.role==='runtime');
const cli = entries.find(entry=>entry.role==='cli');
const isolated = runtime?.isolated == null || cli?.isolated == null ? null : runtime.isolated && cli.isolated;
const workspaceEmpty = !fs.readdirSync('/tmp').some(name=>name.startsWith('pgc-ccb-'));
console.log(JSON.stringify({runtime:runtime?.capabilities??null,cli:cli?.capabilities??null,childSecretIsolation:isolated,workspaceEmpty}));
`;

const networkScript = String.raw`
import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0,'utf8'));
const expected = {
  Authorization:'Bearer '+input.lease,'x-pgc-harness-task':input.taskId,
  'x-pgc-harness-generation':input.generation,'x-pgc-harness-request-id':'probe-0-direct',
};
async function probe(url, headers, marker, status) {
  try {
    const response = await fetch(url,{method:'POST',headers,body:'{}',redirect:'manual',signal:AbortSignal.timeout(3000)});
    await response.body?.cancel();
    return response.status===status && response.headers.get('x-pgc-native-probe')===marker;
  } catch { return null; }
}
const privateURL='http://pgc-harness.internal/v1/messages';
const [privateGateway,httpInterceptDenied,httpsInterceptDenied,wrongTask,wrongGeneration,wrongBearer]=await Promise.all([
  probe(privateURL,expected,'allowed',200),
  probe('http://example.com/',{},'blocked',403),
  probe('https://example.com/',{},'blocked',403),
  probe(privateURL,{...expected,'x-pgc-harness-task':'different-task'},'blocked',403),
  probe(privateURL,{...expected,'x-pgc-harness-generation':'different-generation'},'blocked',403),
  probe(privateURL,{...expected,Authorization:'Bearer different-lease'},'blocked',403),
]);
console.log(JSON.stringify({privateGateway,httpInterceptDenied,httpsInterceptDenied,
  crossTaskDenied:[wrongTask,wrongGeneration,wrongBearer].includes(false)?false:[wrongTask,wrongGeneration,wrongBearer].includes(null)?null:true}));
`;

function readCheck(value: unknown): Check {
  return typeof value === 'boolean' ? value : null;
}
function safeCapabilities(raw: unknown): Capabilities | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const uids = Array.isArray(value.uids) && value.uids.length === 4 &&
    value.uids.every(uid => Number.isSafeInteger(uid) && uid >= 0 && uid <= 4_294_967_295) ? value.uids as number[] : null;
  const mask = (key: string) => typeof value[key] === 'string' && /^[0-9a-f]{8,32}$/.test(value[key] as string) ? value[key] as string : null;
  return { uids, effective: mask('effective'), permitted: mask('permitted'), inheritable: mask('inheritable'),
    ambient: mask('ambient'), bounding: mask('bounding'), noNewPrivs: readCheck(value.noNewPrivs) };
}

export class NativeProbeRunner {
  private tearingDown?: Promise<void>;
  constructor(private ctx: any, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const { origin, pathname, search } = new URL(request.url);
    if (origin !== internal || search || !configured(this.env)) return deny();
    const storage = this.ctx.storage;
    if (pathname === '/observed' && request.method === 'POST') {
      const active = await storage.get('active') as Active | undefined;
      if (!active || Date.now() >= active.deadlineAt || !matches(request.headers.get('authorization'), 'Bearer ' + active.lease)) return deny();
      await storage.put('observed', true);
      return json({ ok: true });
    }
    if (pathname === '/status' && request.method === 'GET') return json(await storage.get('receipt') ?? { state: 'idle' });
    if (request.method !== 'POST' || request.body || !['/run', '/arm-timeout'].includes(pathname)) return deny();
    if (this.ctx.container?.images?.ccb !== this.env.RESEARCH_IMAGE) return json({ error: 'image_mismatch' }, 409);
    const action: Action = pathname === '/run' ? 'run' : 'arm-timeout';
    const active: Active = {
      action, taskId: crypto.randomUUID(), generation: crypto.randomUUID(), lease: secret(), runId: crypto.randomUUID(),
      control: secret(), deadlineAt: Date.now() + maxRunMs, image: this.env.RESEARCH_IMAGE,
    };
    const receipt: Receipt = { action, image: active.image, state: 'running', releaseReady: false, checks: {} };
    const claimed = await storage.transaction(async (tx: any) => {
      if (await tx.get('active') || await tx.get('finished:' + action)) return false;
      await tx.put('active', active);
      await tx.put('receipt', receipt);
      await tx.delete('observed');
      await tx.setAlarm(active.deadlineAt);
      return true;
    });
    if (!claimed) return json({ error: 'probe_active_or_already_finished' }, 409);
    try {
      await this.boot(active, receipt);
      if (action === 'arm-timeout') {
        await storage.put('receipt', receipt);
        await storage.setAlarm(Date.now() + 5_000);
        return json(receipt, 202);
      }
      await this.run(active, receipt);
    } catch {
      receipt.error = 'probe_execution_failed';
    }
    await this.cleanup(active, receipt, 'request');
    return json(receipt, receipt.state === 'passed' ? 200 : 502);
  }

  private async boot(active: Active, receipt: Receipt) {
    const container = this.ctx.container;
    if (container.running) throw new Error('unexpected_existing_container');
    container.start({
      image: active.image, instance: 'standard-1', enableInternet: false,
      env: { PGC_HARNESS_CONTROL_TOKEN: active.control, PGC_HARNESS_GATEWAY_URL: gateway },
    });
    const intercept = this.ctx.exports.NativeProbeOutbound({ props: {
      taskId: active.taskId, generation: active.generation, lease: active.lease,
    } });
    await container.interceptAllOutboundHttp(intercept);
    await container.interceptOutboundHttps('*', intercept);
    await container.setInactivityTimeout(maxRunMs + 10_000);
    const readyBy = Date.now() + 18_000;
    while (Date.now() < readyBy) {
      try {
        const response = await this.runtime(active, '/v1/health');
        if (response.ok && (await response.json() as { status?: string }).status === 'ready') break;
      } catch { /* Still booting. */ }
      await wait(300);
    }
    const authorized = await this.runtime(active, '/v1/health');
    const denied = await container.getTcpPort(8080).fetch(new Request('http://container/v1/health', { signal: AbortSignal.timeout(3000) }));
    receipt.checks.runtimeBoot = authorized.ok && (await authorized.json() as { status?: string }).status === 'ready';
    receipt.checks.controlAuth = denied.status === 401;
    receipt.checks.imagePinned = (await container.inspect())?.image === active.image;
    if (!receipt.checks.runtimeBoot || !receipt.checks.controlAuth || !receipt.checks.imagePinned) throw new Error('boot_checks_failed');
  }

  private runtime(active: Active, path: string, body?: object) {
    const remaining = active.deadlineAt - Date.now();
    if (remaining <= 0) throw new Error('probe_watchdog_expired');
    return this.ctx.container.getTcpPort(8080).fetch(new Request('http://container' + path, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(Math.min(3000, remaining)),
      headers: { Authorization: 'Bearer ' + active.control, 'x-pgc-harness-run': active.runId, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })) as Promise<Response>;
  }

  private async exec<T>(script: string, stdin?: unknown): Promise<T> {
    const controller = new AbortController();
    const proc = await this.ctx.container.exec(['node', '--input-type=module', '-e', script], {
      signal: controller.signal, stderr: 'ignore',
      ...(stdin ? { stdin: new Response(JSON.stringify(stdin)).body,
        env: { NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' } } : {}),
    });
    const timer = setTimeout(() => controller.abort(), 6000);
    void proc.exitCode.then(() => clearTimeout(timer), () => clearTimeout(timer));
    try {
      const output = await proc.output();
      if (output.exitCode !== 0 || output.stdout.byteLength > 4096) throw new Error('probe_exec_failed');
      return JSON.parse(new TextDecoder().decode(output.stdout)) as T;
    } finally { clearTimeout(timer); }
  }

  private async run(active: Active, receipt: Receipt) {
    const network = await this.exec<Record<string, unknown>>(networkScript, {
      taskId: active.taskId, generation: active.generation, lease: active.lease,
    });
    for (const name of ['privateGateway', 'httpInterceptDenied', 'httpsInterceptDenied', 'crossTaskDenied']) {
      receipt.checks[name] = readCheck(network?.[name]);
    }
    receipt.checks.nonHttpEgressDenied = null;
    const deadlineAt = Date.now() + runtimeRunMs;
    const envelope = {
      runId: active.runId, taskId: active.taskId, generation: active.generation, phase: 'probe', purpose: 'brief',
      protocol: 'anthropic', model: 'claude-opus-5-5', effort: 'low', vision: false, deadlineAt,
      maxOutputTokens: 1024, maxTotalOutputTokens: 1024, maxModelTurns: 1, maxRepairs: 0, repair: 0,
      systemPrompt: 'Isolated synthetic research fixture. No external provider is available.',
      prompt: 'Reply with READY.', files: [], outputPath: 'result.txt',
    };
    const start = await this.runtime(active, '/v1/start', { envelope, envelopeSha256: await sha(canonical(envelope)), lease: active.lease });
    receipt.checks.runtimeAccepted = start.status === 202;
    if (!receipt.checks.runtimeAccepted) throw new Error('runtime_rejected');
    let inspection: Inspection | null = null;
    while (Date.now() < deadlineAt - 2000) {
      const current = await this.exec<Inspection>(inspectScript);
      if (current.cli) inspection = current;
      if (inspection && await this.ctx.storage.get('observed')) break;
      await wait(350);
    }
    receipt.checks.cliReachedFixture = Boolean(await this.ctx.storage.get('observed'));
    receipt.processes = { runtime: safeCapabilities(inspection?.runtime), cli: safeCapabilities(inspection?.cli) };
    const actual = [receipt.processes.runtime, receipt.processes.cli];
    receipt.checks.nonRootUid = actual.every(p => p?.uids?.length === 4) ? actual.every(p => p!.uids!.every(uid => uid > 0)) : null;
    const masks = (p: Capabilities) => [p.effective, p.permitted, p.inheritable, p.ambient, p.bounding];
    receipt.checks.privilegeDrop = actual.every(p => p && masks(p).every(Boolean) && p.noNewPrivs !== null)
      ? actual.every(p => masks(p!).every(mask => /^0+$/.test(mask!)) && p!.noNewPrivs)
      : null;
    receipt.checks.childSecretIsolation = readCheck(inspection?.childSecretIsolation);
    while (Date.now() < Math.min(deadlineAt + 6000, active.deadlineAt)) {
      const status = await this.runtime(active, '/v1/status');
      const state = status.ok ? await status.json() as { state?: string; failure?: string } : {};
      if (state.state !== 'running') {
        receipt.checks.runtimeDeadline = state.state === 'failed' && state.failure === 'deadline_exceeded';
        break;
      }
      await wait(350);
    }
    const cleaned = await this.exec<Inspection>(inspectScript);
    receipt.checks.workspaceRemoved = cleaned.workspaceEmpty === true && cleaned.cli === null;
  }

  private async cleanup(active: Active, receipt: Receipt, source: 'request' | 'alarm') {
    if (this.tearingDown) return this.tearingDown;
    const operation = this.cleanupClaim(active, receipt, source);
    this.tearingDown = operation;
    try { await operation; } finally { this.tearingDown = undefined; }
  }

  private async cleanupClaim(active: Active, receipt: Receipt, source: 'request' | 'alarm') {
    const storage = this.ctx.storage;
    if ((await storage.get('active') as Active | undefined)?.runId !== active.runId) return;
    try {
      if (this.ctx.container.running) await this.ctx.container.destroy();
      receipt.checks.containerDestroyed = !this.ctx.container.running && await this.ctx.container.inspect() === null;
    } catch { receipt.checks.containerDestroyed = false; }
    if (!receipt.checks.containerDestroyed) receipt.error ??= 'container_cleanup_unconfirmed';
    receipt.cleanup = source;
    if (source === 'alarm') receipt.checks.alarmCleanup = receipt.checks.containerDestroyed;
    const required = active.action === 'run'
      ? ['runtimeBoot', 'controlAuth', 'imagePinned', 'privateGateway', 'httpInterceptDenied', 'httpsInterceptDenied',
        'crossTaskDenied', 'runtimeAccepted', 'cliReachedFixture', 'nonRootUid', 'privilegeDrop', 'childSecretIsolation', 'runtimeDeadline', 'workspaceRemoved', 'containerDestroyed']
      : ['runtimeBoot', 'controlAuth', 'imagePinned', 'alarmCleanup', 'containerDestroyed'];
    receipt.state = !receipt.error && required.every(name => receipt.checks[name] === true) ? 'passed' : 'failed';
    await storage.put('receipt', receipt);
    if (!receipt.checks.containerDestroyed) {
      await storage.setAlarm(Date.now() + 5000);
      return;
    }
    await storage.transaction(async (tx: any) => {
      await tx.put('finished:' + active.action, true);
      await tx.delete('active');
      await tx.delete('observed');
      await tx.deleteAlarm();
    });
  }

  async alarm() {
    const active = await this.ctx.storage.get('active') as Active | undefined;
    if (!active) return;
    const receipt = await this.ctx.storage.get('receipt') as Receipt | undefined ??
      { action: active.action, image: active.image, state: 'failed', releaseReady: false, checks: {}, error: 'receipt_unavailable' };
    if (active.action === 'run' && receipt.state === 'running') receipt.error = 'probe_watchdog_expired';
    await this.cleanup(active, receipt, 'alarm');
  }
}
