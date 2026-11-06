import { describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));
import worker, { EgressProbeRunner, egressPhases, egressVerdict, parseEgressObservations } from '../scripts/harness-egress-probe-worker';

const image = `registry.cloudflare.com/${'a'.repeat(32)}/fixture@sha256:${'b'.repeat(64)}`;
const token = 'c'.repeat(64);
const observation = (reached = true) => ({ reached, connected: reached, result: reached ? 'response' : 'timeout' });
const observations = (reached = true) => Object.fromEntries(['tcp4', 'udp4', 'tcp6', 'udp6'].map(key => [key, observation(reached)]));
function receipts(): any[] {
  return egressPhases.map((phase, i) => ({ phase, image, startedAt: i * 100, endedAt: i * 100 + 50, state: 'completed', enableInternet: phase !== 'blocked',
    containerDestroyed: true, releaseReady: false, observations: observations(phase !== 'blocked') }));
}
function fixture() {
  const data = new Map<string, unknown>();
  const storage: any = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key),
    setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}),
    transaction: async (fn: any) => fn(storage),
  };
  let enabled = true;
  const container = {
    images: { ccb: image }, running: false,
    start: vi.fn(async (opts: any) => { enabled = opts.enableInternet; container.running = true; }),
    destroy: vi.fn(async () => { container.running = false; }),
    inspect: vi.fn(async () => container.running ? { image } : null),
    setInactivityTimeout: vi.fn(async () => {}), interceptAllOutboundHttp: vi.fn(async () => {}), interceptOutboundHttps: vi.fn(async () => {}),
    getTcpPort: () => ({ fetch: async () => Response.json({ status: 'ready' }) }),
    exec: vi.fn(async () => ({ exitCode: Promise.resolve(0), output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify(observations(enabled))) }) })),
  };
  const env = { RESEARCH_IMAGE: image, HARNESS_RESEARCH_TOKEN: token, EGRESS_PROBE: {} as any };
  const runner = new EgressProbeRunner({ storage, container, exports: { EgressProbeOutbound: () => ({}) } }, env);
  const call = (phase: string) => runner.fetch(new Request(`http://pgc-egress-probe.internal/${phase}`, { method: 'POST' }));
  return { storage, data, container, runner, env, call };
}

describe('paired native non-HTTP research probe', () => {
  it('only accepts bounded structured observations without raw network data', () => {
    expect(parseEgressObservations(observations())).toEqual(observations());
    for (const value of [null, [], { ...observations(), raw: 'private' }, { ...observations(), tcp4: { ...observation(), extra: 'value' } },
      { ...observations(), tcp4: { ...observation(), result: 'unexpected' } },
      { ...observations(), tcp4: { ...observation(), reached: false } }]) expect(() => parseEgressObservations(value)).toThrow();
  });
  it('requires reachable before/after controls and blocked native networking for each transport separately', () => {
    const r = receipts();
    expect(egressVerdict(r)).toEqual({ tcp4: true, udp4: true, tcp6: true, udp6: true });
    r[0].observations.udp6 = observation(false);
    expect(egressVerdict(r).udp6).toBeNull();
    r[1].observations.tcp4.connected = true;
    expect(egressVerdict(r).tcp4).toBe(false);
    r[1].observations.udp4.result = 'invalid-response';
    expect(egressVerdict(r).udp4).toBeNull();
    r[2].containerDestroyed = false;
    expect(Object.values(egressVerdict(r)).every(v => v === null)).toBe(true);
  });
  it('rejects incomplete, duplicate, swapped policy and mismatched-image controls', () => {
    for (const mutate of [(r: any[]) => r.pop(), (r: any[]) => r.push(r[0]), (r: any[]) => r.reverse(),
      (r: any[]) => { r[1].enableInternet = true; }, (r: any[]) => { r[2].image += 'changed'; }]) {
      const r = receipts(); mutate(r); expect(Object.values(egressVerdict(r)).every(v => v === null)).toBe(true);
    }
  });
  it('authenticates fixed empty routes and cannot accept an arbitrary host, script or model request', async () => {
    const fetch = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    const env = { ...fixture().env, EGRESS_PROBE: { idFromName: (n: string) => n, get: () => ({ fetch }) } };
    const call = (path: string, body?: string, auth = token) => worker.fetch(new Request('https://probe.invalid' + path, {
      method: 'POST', body, headers: { Authorization: 'Bearer ' + auth },
    }), env);
    expect((await call('/positive-before', undefined, 'bad')).status).toBe(401);
    for (const [path, body] of [['/run', undefined], ['/positive-before?host=else.invalid', undefined], ['/blocked', '{}']]) {
      expect((await call(path!, body)).status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect((await call('/positive-before')).status).toBe(200);
    expect(fetch.mock.calls[0][0].url).toBe('http://pgc-egress-probe.internal/positive-before');
  });
  it('executes a fixed three-phase sequence, destroys each instance and refuses all replays', async () => {
    const f = fixture();
    expect((await f.call('blocked')).status).toBe(409);
    for (const phase of egressPhases) {
      expect((await f.call(phase)).status).toBe(200);
      expect((await f.call(phase)).status).toBe(409);
    }
    expect(f.container.start.mock.calls.map(([opts]) => opts.enableInternet)).toEqual([true, false, true]);
    expect(f.container.destroy).toHaveBeenCalledTimes(3);
    const status = await (await f.runner.fetch(new Request('http://pgc-egress-probe.internal/status'))).json() as any;
    expect(status.active).toBeNull(); expect(status.releaseReady).toBe(false);
    expect(Object.values(status.verdict)).toEqual([true, true, true, true]);
  });
  it('keeps an unconfirmed container reserved and alarm cleanup cannot claim a successful probe', async () => {
    const f = fixture(); f.container.destroy.mockRejectedValue(new Error('temporary'));
    expect((await f.call('positive-before')).status).toBe(502);
    expect(f.data.get('active')).toBe('positive-before');
    expect((await f.call('blocked')).status).toBe(409);
    f.container.destroy.mockImplementation(async () => { f.container.running = false; });
    await f.runner.alarm();
    expect(f.data.has('active')).toBe(false);
    expect((await f.call('blocked')).status).toBe(409);
    expect((f.data.get('receipts') as any[])[0].state).toBe('failed');
  });
  it('serializes alarm cleanup with the next phase and preserves polling', async () => {
    const f = fixture();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const original = f.container.exec.getMockImplementation()!;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.container.exec.mockImplementationOnce(async () => { entered(); await pending; return original(); });
    const before = f.call('positive-before'); await waiting;
    const alarm = f.runner.alarm(), blocked = f.call('blocked');
    const status = await (await f.runner.fetch(new Request('http://pgc-egress-probe.internal/status'))).json() as any;
    expect(status.active).toBe('positive-before'); expect(f.container.start).toHaveBeenCalledTimes(1);
    finish(); expect((await before).status).toBe(200); await alarm;
    expect((await blocked).status).toBe(200); expect(f.container.destroy).toHaveBeenCalledTimes(2);
  });
  it('does not label an over-deadline execution completed even when sockets returned observations', async () => {
    const f = fixture(), now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const original = f.container.exec.getMockImplementation()!;
    f.container.exec.mockImplementationOnce(async () => { vi.mocked(Date.now).mockReturnValue(now + 60_001); return original(); });
    try {
      expect((await f.call('positive-before')).status).toBe(502);
      expect((f.data.get('receipts') as any[])[0]).toMatchObject({ state: 'failed', error: 'watchdog-expired', containerDestroyed: true });
    } finally { vi.restoreAllMocks(); }
  });
});
