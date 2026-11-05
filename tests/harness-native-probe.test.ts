import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { canonical, validateStart } from '../harness/envelope.mjs';
import { scopeHarnessOutbound } from '../server/harness-outbound-scope';
import { canonicalHarness } from '../server/harness-policy';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(protected ctx: unknown, protected env: unknown) {}
  },
}));
import worker, { NativeProbeOutbound, NativeProbeRunner } from '../scripts/harness-native-probe-worker';

const image = `registry.cloudflare.com/${'a'.repeat(32)}/fixture@sha256:${'b'.repeat(64)}`;
const token = 'c'.repeat(64);
const scope = { taskId: 'task-a', generation: 'generation-a', lease: 'd'.repeat(64) };
const endpoint = 'http://pgc-harness.internal/v1/messages';
const internal = 'http://pgc-native-probe.internal';
const request = (url: string, headers: Record<string, string> = {}) => new Request(url, { method: 'POST', headers, body: '{}' });
function streamPost(url: string, stream: 'empty' | 'data' | 'stalled') {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stream === 'empty') controller.close();
      if (stream === 'data') controller.enqueue(new Uint8Array([1]));
    },
    cancel: () => new Promise(() => {}),
  });
  const options = { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body, duplex: 'half' };
  return new Request(url, options);
}

describe('native harness research boundary', () => {
  it('uses the same closed canonical JSON for worker and image envelope objects', () => {
    const envelope = { taskId: 'task', files: [{ path: 'input/file.txt', content: 'text' }], effort: 'low' };
    const known = '{"effort":"low","files":[{"content":"text","path":"input/file.txt"}],"taskId":"task"}';
    expect(canonical(envelope)).toBe(known);
    expect(canonicalHarness(envelope)).toBe(known);
  });

  it('denies an explicit wrong task, generation, bearer, key and any non-gateway route', () => {
    const mismatches: Record<string, string>[] = [
      { 'x-pgc-harness-task': 'task-b' }, { 'x-pgc-harness-generation': 'generation-b' },
      { Authorization: 'Bearer different' }, { 'x-api-key': 'different' },
    ];
    for (const headers of mismatches) expect(scopeHarnessOutbound(request(endpoint, headers), scope)).toBeNull();
    for (const url of [endpoint + '?a=1', 'https://pgc-harness.internal/v1/messages', 'http://other.invalid/v1/messages', 'http://pgc-harness.internal/v1/models']) {
      expect(scopeHarnessOutbound(request(url), scope)).toBeNull();
    }
    const bound = scopeHarnessOutbound(request(endpoint, { 'x-api-key': scope.lease }), scope)!;
    expect(bound.headers.get('authorization')).toBe('Bearer ' + scope.lease);
    expect(bound.headers.get('x-pgc-harness-task')).toBe(scope.taskId);
    expect(bound.headers.get('x-pgc-harness-generation')).toBe(scope.generation);
    expect(bound.headers.get('x-api-key')).toBeNull();
  });

  it('requires the independent token and forwards only fixed bodyless actions', async () => {
    const fetch = vi.fn(async () => new Response('fixture'));
    const env = { HARNESS_RESEARCH_TOKEN: token, RESEARCH_IMAGE: image, NATIVE_PROBE: { idFromName: (name: string) => name, get: () => ({ fetch }) } };
    const call = (path: string, method: string, auth = token, body?: string) => worker.fetch(new Request('https://research.invalid' + path, {
      method, headers: { Authorization: 'Bearer ' + auth }, body,
    }), env);
    const missing = new Request('https://research.invalid/run', { method: 'POST' });
    const denials = [
      [await call('/run', 'POST', 'bad', '{}'), 'authorization_mismatch'],
      [await worker.fetch(missing, env), 'authorization_missing'],
      [await worker.fetch(missing, { ...env, HARNESS_RESEARCH_TOKEN: '' }), 'probe_unconfigured'],
    ] as const;
    for (const [denied, error] of denials) {
      expect(denied.status).toBe(401);
      expect(denied.headers.get('x-pgc-native-probe-version')).toBe('auth-v1');
      expect(denied.headers.get('x-pgc-native-probe-method')).toBe('POST');
      expect(denied.headers.get('x-pgc-native-probe-stage')).toBe('pre-dispatch-auth');
      expect(await denied.json()).toEqual({ error });
    }
    expect((await call('/observed', 'POST')).status).toBe(404);
    expect((await call('/run?url=https://else.invalid', 'POST')).status).toBe(404);
    expect((await call('/run', 'POST', token, '{}')).status).toBe(404);
    expect((await call('/status', 'POST')).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    const accepted = await call('/run', 'POST');
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('x-pgc-native-probe-method')).toBe('POST');
    expect(accepted.headers.get('x-pgc-native-probe-stage')).toBeNull();
    const captured = (fetch.mock.calls as unknown as [[Request]])[0][0];
    expect(captured.url).toBe(internal + '/run');
    expect(captured.headers.get('authorization')).toBeNull();
  });

  it('serves the synthetic private fixture only after binding checks, with no actual provider fetch', async () => {
    const notified = vi.fn(async () => new Response('ok'));
    const env = { HARNESS_RESEARCH_TOKEN: token, RESEARCH_IMAGE: image, NATIVE_PROBE: { idFromName: (name: string) => name, get: () => ({ fetch: notified }) } };
    const outbound = new NativeProbeOutbound({ props: scope }, env);
    const denied = await outbound.fetch(request(endpoint, { 'x-pgc-harness-task': 'task-b', 'x-pgc-harness-request-id': 'probe-0-direct' }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('x-pgc-native-probe')).toBe('blocked');
    expect((await outbound.fetch(request(endpoint, { 'x-pgc-harness-request-id': 'probe-0-direct' }))).status).toBe(200);
    expect(notified).not.toHaveBeenCalled();
    const cli = await outbound.fetch(request(endpoint, { 'x-pgc-harness-request-id': 'probe-0-' + crypto.randomUUID() }));
    expect(cli.headers.get('content-type')).toContain('text/event-stream');
    expect(notified).toHaveBeenCalledTimes(1);
    await cli.body?.cancel();
  });

  it.each(['cancelled', 'bounded'])('keeps sending fixture heartbeat bytes until %s and clears all timers', async end => {
    const notified = vi.fn(async () => new Response('ok'));
    const env = { HARNESS_RESEARCH_TOKEN: token, RESEARCH_IMAGE: image, NATIVE_PROBE: { idFromName: (name: string) => name, get: () => ({ fetch: notified }) } };
    const outbound = new NativeProbeOutbound({ props: scope }, env);
    vi.useFakeTimers();
    try {
      const cli = await outbound.fetch(request(endpoint, { 'x-pgc-harness-request-id': 'probe-0-' + crypto.randomUUID() }));
      const reader = cli.body!.getReader();
      const frame = ': native-research-fixture\n\n';
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(frame);
      await vi.advanceTimersByTimeAsync(23_000);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(frame);
      const lateHeartbeat = reader.read();
      await vi.advanceTimersByTimeAsync(1000);
      expect(new TextDecoder().decode((await lateHeartbeat).value)).toBe(frame);
      if (end === 'cancelled') {
        await reader.cancel();
      } else {
        await vi.advanceTimersByTimeAsync(16_000);
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(frame);
        expect(await reader.read()).toEqual({ done: true, value: undefined });
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('dispatches a genuinely empty stream, and refuses data or a stalled body before dispatch', async () => {
    const fetch = vi.fn(async (_request: Request) => new Response('fixture'));
    const env = { HARNESS_RESEARCH_TOKEN: token, RESEARCH_IMAGE: image, NATIVE_PROBE: { idFromName: (name: string) => name, get: () => ({ fetch }) } };
    const url = 'https://research.invalid/run';
    const denied = await Promise.all((['data', 'stalled'] as const).map(stream =>
      worker.fetch(streamPost(url, stream), env)));
    expect(denied.map(response => response.status)).toEqual([404, 404]);
    expect(fetch).not.toHaveBeenCalled();
    const empty = streamPost(url, 'empty');
    expect(empty.body).not.toBeNull();
    expect((await worker.fetch(empty, env)).status).toBe(200);
    expect(fetch.mock.calls[0][0].body).toBeNull();
  });
});

function setup({ privileged = false, runtimeNow = Date.now, startResponse, completion = { state: 'failed', failure: 'deadline_exceeded' },
  finalNoLiveChildren = true }: {
  privileged?: boolean; runtimeNow?: () => number; startResponse?: () => Response; completion?: { state: string; failure?: string };
  finalNoLiveChildren?: boolean | null;
} = {}) {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  interface MemoryStorage {
    get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean>;
    setAlarm(at: number): Promise<void>; deleteAlarm(): Promise<void>; transaction<T>(callback: (tx: MemoryStorage) => Promise<T>): Promise<T>;
  }
  const storage: MemoryStorage = {
    async get(key: string) { return data.get(key); },
    async put(key: string, value: unknown) { data.set(key, structuredClone(value)); },
    async delete(key: string) { return data.delete(key); },
    async setAlarm(at: number) { alarm = at; },
    async deleteAlarm() { alarm = null; },
    async transaction<T>(callback: (tx: MemoryStorage) => Promise<T>): Promise<T> { return callback(storage); },
  };
  const masks = { uids: [1000,1000,1000,1000], effective: privileged ? '00000001' : '00000000',
    permitted: '00000000', inheritable: '00000000', ambient: '00000000', bounding: '00000000', noNewPrivs: true };
  let reading = 0, control = '';
  let runtimeIdentity: { runId: string; taskId: string; phase: string } | undefined;
  let runner: NativeProbeRunner;
  const container = {
    images: { ccb: image },
    running: false,
    start: vi.fn((options: { env: { PGC_HARNESS_CONTROL_TOKEN: string } }) => { container.running = true; control = options.env.PGC_HARNESS_CONTROL_TOKEN; }),
    destroy: vi.fn(async () => { container.running = false; }),
    inspect: async () => container.running ? { image } : null,
    interceptAllOutboundHttp: vi.fn(async () => {}),
    interceptOutboundHttps: vi.fn(async () => {}),
    setInactivityTimeout: vi.fn(async () => {}),
    getTcpPort: () => ({ fetch: async (request: Request) => {
      if (request.headers.get('authorization') !== 'Bearer ' + control) return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === '/v1/health') return Response.json({ status: 'ready' });
      if (path === '/v1/start') {
        const verified = validateStart(await request.json(), runtimeNow());
        if (!verified) return Response.json({ error: 'Invalid run envelope' }, { status: 400 });
        if (startResponse) return startResponse();
        const { runId, taskId, phase } = verified.run;
        runtimeIdentity = { runId, taskId, phase };
        await runner.fetch(new Request(internal + '/observed', { method: 'POST', headers: { Authorization: 'Bearer ' + verified.lease } }));
        return Response.json({}, { status: 202 });
      }
      if (path === '/v1/status') return Response.json({ ...runtimeIdentity, ...completion });
      throw new Error('Unexpected private endpoint');
    } }),
    exec: vi.fn(async (_command: string[], options: { stdin?: unknown }) => {
      const cli = !options.stdin && reading++ === 0 ? masks : null;
      const result = options.stdin ? { privateGateway: true, httpInterceptDenied: true, httpsInterceptDenied: true, crossTaskDenied: true } :
        { runtime: masks, cli, childSecretIsolation: true, workspaceEmpty: true, noLiveChildren: cli ? false : finalNoLiveChildren };
      return { exitCode: Promise.resolve(0), output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify(result)) }) };
    }),
  };
  const env = { HARNESS_RESEARCH_TOKEN: token, RESEARCH_IMAGE: image, NATIVE_PROBE: { idFromName: (name: string) => name, get: () => ({ fetch: vi.fn() }) } };
  runner = new NativeProbeRunner({ storage, container, exports: { NativeProbeOutbound: vi.fn(() => ({})) } }, env);
  const post = (path: string) => runner.fetch(new Request(internal + path, { method: 'POST' }));
  return { runner, container, post, data, getAlarm: () => alarm };
}

describe('native probe orchestration with scripted container', () => {
  it('identifies the renamed CLI by its unique live direct Node parentage', async () => {
    const s = setup();
    await s.post('/run');
    const script = s.container.exec.mock.calls[1][0][3].replace("import fs from 'node:fs';", '');
    const processes = new Map([
      ['10', { ppid: 1, title: '/opt/harness/runtime.mjs', env: 'PGC_HARNESS_CONTROL_TOKEN=fixture' }],
      ['11', { ppid: 10, title: 'claude', env: 'ANTHROPIC_API_KEY=pgc-loopback-only\0OPENAI_API_KEY=pgc-loopback-only' }],
      ['12', { ppid: 10, title: 'inspector', env: '' }],
      ['13', { ppid: 1, title: 'claude', env: '' }],
    ]);
    const inspect = (unreadablePid?: string) => {
      let output;
      runInNewContext(script, {
        process: { pid: 12 }, console: { log: (data: string) => { output = JSON.parse(data); } },
        fs: {
          readdirSync: (path: string) => path === '/proc' ? [...processes.keys()] : [],
          readlinkSync: () => '/usr/local/bin/node',
          readFileSync: (path: string) => {
            const [, , pid, field] = path.split('/');
            const item = processes.get(pid)!;
            if (field === 'status' && pid === unreadablePid) throw new Error('unreadable');
            if (field === 'status') return `State:\tS (sleeping)\nPPid:\t${item.ppid}\nUid:\t1000\t1000\t1000\t1000\n`;
            if (field === 'cmdline') return item.title;
            return item.env;
          },
        },
      });
      return output;
    };
    expect(inspect()).toMatchObject({ cli: { uids: [1000, 1000, 1000, 1000] }, childSecretIsolation: true, noLiveChildren: false });
    processes.get('13')!.ppid = 10;
    expect(inspect()).toMatchObject({ cli: null, childSecretIsolation: null, noLiveChildren: false });
    processes.delete('11');
    expect(inspect('13')).toMatchObject({ cli: null, noLiveChildren: null });
    processes.delete('13');
    expect(inspect()).toMatchObject({ cli: null, noLiveChildren: true });
  });

  it('enforces empty stream handling again on the Durable Object boundary', async () => {
    const s = setup();
    const url = internal + '/arm-timeout';
    const denied = await Promise.all((['data', 'stalled'] as const).map(stream =>
      s.runner.fetch(streamPost(url, stream))));
    expect(denied.map(response => response.status)).toEqual([403, 403]);
    expect(s.container.start).not.toHaveBeenCalled();
    expect(s.getAlarm()).toBeNull();
    expect((await s.runner.fetch(streamPost(url, 'empty'))).status).toBe(202);
    expect(s.container.start).toHaveBeenCalledOnce();
    await s.runner.alarm();
  });

  it('requires capability evidence, redacts ephemeral credentials, and destroys the instance', async () => {
    const s = setup({ privileged: true });
    const response = await s.post('/run');
    expect(response.status).toBe(502);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ state: 'failed', releaseReady: false, cleanup: 'request',
      runtimeStart: { httpStatus: 202 },
      runtimeCompletion: { state: 'failed', failure: 'deadline_exceeded', observedAfterMs: expect.any(Number) },
      observations: { processSampleAfterMs: expect.any(Number), fixtureReachedAfterMs: expect.any(Number) },
      checks: { runtimeBoot: true, cliReachedFixture: true, privateGateway: true, crossTaskDenied: true,
        nonRootUid: true, privilegeDrop: false, nonHttpEgressDenied: null, runtimeDeadline: true, workspaceRemoved: true, containerDestroyed: true } });
    expect(s.container.start).toHaveBeenCalledWith(expect.objectContaining({ image, enableInternet: false }));
    const [options] = s.container.start.mock.calls[0];
    expect(JSON.stringify(receipt)).not.toContain(options.env.PGC_HARNESS_CONTROL_TOKEN);
    expect(JSON.stringify(receipt)).not.toContain(token);
    expect(s.container.running).toBe(false);
    expect(s.data.has('active')).toBe(false);
    expect((await s.post('/run')).status).toBe(409);
  });

  it('leaves the timeout probe running until its durable alarm destroys it', async () => {
    const s = setup();
    expect((await s.post('/arm-timeout')).status).toBe(202);
    expect(s.container.running).toBe(true);
    expect(s.getAlarm()).toBeGreaterThan(Date.now());
    await s.runner.alarm();
    expect(s.container.running).toBe(false);
    expect(s.data.get('receipt')).toMatchObject({ state: 'passed', cleanup: 'alarm', releaseReady: false,
      checks: { alarmCleanup: true, containerDestroyed: true } });
    expect(s.getAlarm()).toBeNull();
  });
});

describe('native probe diagnostics', () => {
  it.each([false, null])('cannot pass workspace cleanup with noLiveChildren=%s even without a recognized CLI', async finalNoLiveChildren => {
    const s = setup({ finalNoLiveChildren });
    const response = await s.post('/run');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ state: 'failed', checks: {
      runtimeDeadline: true, workspaceRemoved: false, noLiveChildren: finalNoLiveChildren, containerDestroyed: true,
    } });
  });

  it.each([
    ['model_stream_incomplete', 'model_stream_incomplete'],
    ['PRIVATE_RUNTIME_DIAGNOSTIC', 'unknown'],
  ])('reports completion separately from the exact deadline check', async (failure, observedFailure) => {
    const s = setup({ completion: { state: 'failed', failure } });
    const response = await s.post('/run');
    expect(response.status).toBe(502);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ state: 'failed', checks: { runtimeDeadline: false, containerDestroyed: true },
      runtimeCompletion: { state: 'failed', failure: observedFailure, observedAfterMs: expect.any(Number) } });
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_RUNTIME_DIAGNOSTIC');
  });

  it('records the allowlisted rejection when runtime validation sees an expired envelope', async () => {
    const s = setup({ runtimeNow: () => Date.now() + 30_000 });
    const response = await s.post('/run');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'runtime_start_rejected',
      runtimeStart: { httpStatus: 400, error: 'invalid_envelope' },
      checks: { runtimeAccepted: false, containerDestroyed: true } });
    expect(s.container.exec).toHaveBeenCalledOnce();
  });

  it.each([
    () => Response.json({ error: 'PRIVATE_PLATFORM_DIAGNOSTIC' }, { status: 400 }),
    () => Response.json({ error: 'Invalid run envelope', secret: 'PRIVATE_PLATFORM_DIAGNOSTIC'.repeat(20) }, { status: 400 }),
    () => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 400 }),
  ])('keeps unexpected, oversized or stalled rejection bodies out of the receipt', async startResponse => {
    const s = setup({ startResponse });
    const response = await s.post('/run');
    expect(response.status).toBe(502);
    const receipt = await response.json();
    expect(receipt.runtimeStart).toEqual({ httpStatus: 400 });
    expect(receipt.error).toBe('runtime_start_rejected');
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_PLATFORM_DIAGNOSTIC');
  });

  it('distinguishes an HTTP intercept installation failure without echoing the platform error', async () => {
    const s = setup();
    s.container.interceptAllOutboundHttp.mockRejectedValueOnce(new Error('PRIVATE_PLATFORM_DIAGNOSTIC'));
    const response = await s.post('/run');
    expect(response.status).toBe(502);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ error: 'http_intercept_failed', checks: { destroyInvoked: true, containerDestroyed: true } });
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_PLATFORM_DIAGNOSTIC');
    expect(s.container.exec).not.toHaveBeenCalled();
  });

  it('keeps a failed timeout verdict when the alarm only observes an already stopped container', async () => {
    const s = setup();
    expect((await s.post('/arm-timeout')).status).toBe(202);
    s.container.running = false;
    await s.runner.alarm();
    expect(s.data.get('receipt')).toMatchObject({ state: 'failed', cleanup: 'alarm',
      checks: { wasRunningBeforeAlarm: false, destroyInvoked: false, alarmCleanup: false, containerDestroyed: true } });
    expect(s.container.destroy).not.toHaveBeenCalled();
  });
});
