import { describe, expect, it, vi } from 'vitest';
import { scopeHarnessOutbound } from '../server/harness-outbound-scope';

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

describe('native harness research boundary', () => {
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
    expect((await call('/run', 'POST', 'bad')).status).toBe(401);
    expect((await call('/observed', 'POST')).status).toBe(404);
    expect((await call('/run?url=https://else.invalid', 'POST')).status).toBe(404);
    expect((await call('/run', 'POST', token, '{}')).status).toBe(404);
    expect((await call('/status', 'POST')).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect((await call('/run', 'POST')).status).toBe(200);
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
});

function setup({ privileged = false } = {}) {
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
        const body = await request.json() as { lease: string };
        await runner.fetch(new Request(internal + '/observed', { method: 'POST', headers: { Authorization: 'Bearer ' + body.lease } }));
        return Response.json({}, { status: 202 });
      }
      if (path === '/v1/status') return Response.json({ state: 'failed', failure: 'deadline_exceeded' });
      throw new Error('Unexpected private endpoint');
    } }),
    exec: vi.fn(async (_command: string[], options: { stdin?: unknown }) => {
      const result = options.stdin ? { privateGateway: true, httpInterceptDenied: true, httpsInterceptDenied: true, crossTaskDenied: true } :
        { runtime: masks, cli: reading++ === 0 ? masks : null, childSecretIsolation: true, workspaceEmpty: true };
      return { exitCode: Promise.resolve(0), output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify(result)) }) };
    }),
  };
  const env = { HARNESS_RESEARCH_TOKEN: token, RESEARCH_IMAGE: image, NATIVE_PROBE: { idFromName: (name: string) => name, get: () => ({ fetch: vi.fn() }) } };
  runner = new NativeProbeRunner({ storage, container, exports: { NativeProbeOutbound: vi.fn(() => ({})) } }, env);
  const post = (path: string) => runner.fetch(new Request(internal + path, { method: 'POST' }));
  return { runner, container, post, data, getAlarm: () => alarm };
}

describe('native probe orchestration with scripted container', () => {
  it('requires capability evidence, redacts ephemeral credentials, and destroys the instance', async () => {
    const s = setup({ privileged: true });
    const response = await s.post('/run');
    expect(response.status).toBe(502);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ state: 'failed', releaseReady: false, cleanup: 'request',
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
