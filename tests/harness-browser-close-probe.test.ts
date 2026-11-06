import puppeteer from '@cloudflare/puppeteer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { BrowserCloseProbe } from '../scripts/harness-browser-close-probe-worker';

vi.mock('@cloudflare/puppeteer', () => ({ default: { acquire: vi.fn(), connect: vi.fn() } }));
afterEach(() => vi.resetAllMocks());

const sessionId = 'exact-allocated-session';
const token = 'a'.repeat(64);
const endpoint = (path: string, init?: RequestInit) => new Request(`https://probe.invalid${path}`, init);
const run = () => endpoint('/run', { method: 'POST' });
const recheck = () => endpoint('/recheck', { method: 'POST' });

function setup() {
  let stored: unknown;
  let serial = Promise.resolve();
  const storage: ConstructorParameters<typeof BrowserCloseProbe>[0]['storage'] = {
    async get<T>() { return structuredClone(stored) as T | undefined; },
    async put<T>(_key: string, value: T) { stored = structuredClone(value); },
    setAlarm: vi.fn(async (_time: number) => {}),
    transaction(callback) {
      const result = serial.then(() => callback(storage));
      serial = result.then(() => {}, () => {});
      return result;
    },
  };
  const BROWSER = {
    getSession: vi.fn(async (_id: string): Promise<unknown> => ({ sessionId })),
    closeSession: vi.fn(async (_id: string): Promise<unknown> => ({ status: 'closed' })),
  };
  const env = { BROWSER } as unknown as ConstructorParameters<typeof BrowserCloseProbe>[1];
  const browser = { version: vi.fn(async () => 'Chrome/synthetic'), disconnect: vi.fn(async () => {}) };
  vi.mocked(puppeteer.acquire).mockResolvedValue({ sessionId } as Awaited<ReturnType<typeof puppeteer.acquire>>);
  vi.mocked(puppeteer.connect).mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof puppeteer.connect>>);
  return { storage, env, BROWSER, browser, probe: new BrowserCloseProbe({ storage }, env) };
}

describe('isolated Browser binding close probe', () => {
  it('protects run and status with the secret and accepts only the fixed no-input routes', async () => {
    const target = vi.fn(async (_request: Request) => Response.json({ accepted: true }));
    const env = { HARNESS_RESEARCH_TOKEN: token, BROWSER_CLOSE_PROBE: { idFromName: vi.fn(() => 'probe'), get: vi.fn(() => ({ fetch: target })) } } as unknown as Parameters<typeof worker.fetch>[1];
    const headers = { Authorization: `Bearer ${token}` };
    expect((await worker.fetch(run(), env)).status).toBe(401);
    expect((await worker.fetch(recheck(), env)).status).toBe(401);
    expect((await worker.fetch(endpoint('/status'), env)).status).toBe(401);
    expect((await worker.fetch(endpoint('/run?target=x', { method: 'POST', headers }), env)).status).toBe(404);
    expect((await worker.fetch(endpoint('/run', { method: 'POST', headers, body: '{}' }), env)).status).toBe(404);
    expect((await worker.fetch(endpoint('/recheck?sessionId=other', { method: 'POST', headers }), env)).status).toBe(404);
    expect((await worker.fetch(endpoint('/status', { headers }), env)).status).toBe(200);
    expect((await worker.fetch(endpoint('/run', { method: 'POST', headers }), env)).status).toBe(200);
    expect((await worker.fetch(endpoint('/recheck', { method: 'POST', headers }), env)).status).toBe(200);
    expect(target.mock.calls.map(([request]) => [request.method, request.headers.get('Authorization')])).toEqual([['GET', null], ['POST', null], ['POST', null]]);
  });

  it('persists pending before acquire and the original ID before connecting and confirms same-ID close', async () => {
    const { storage, BROWSER, browser, probe } = setup();
    BROWSER.getSession.mockResolvedValueOnce({ sessionId }).mockResolvedValueOnce({ sessionId, endTime: Date.now() });
    vi.mocked(puppeteer.acquire).mockImplementationOnce(async () => {
      expect(await storage.get('browser-close-probe')).toMatchObject({ connected: null, cleanupAttempts: 0 });
      return { sessionId } as Awaited<ReturnType<typeof puppeteer.acquire>>;
    });
    vi.mocked(puppeteer.connect).mockImplementationOnce(async (_binding, id) => {
      expect(id).toBe(sessionId);
      expect(await storage.get('browser-close-probe')).toMatchObject({ browserId: sessionId });
      return browser as unknown as Awaited<ReturnType<typeof puppeteer.connect>>;
    });
    const response = await probe.fetch(run());
    const result = await response.text();
    expect(result).not.toContain(sessionId);
    expect(JSON.parse(result)).toMatchObject({ state: 'passed', before: 'active', after: 'ended-number', connected: true, closeStatus: 'closed', cleanupConfirmed: true });
    expect(BROWSER.closeSession).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(BROWSER.getSession.mock.calls.every(([id]) => id === sessionId)).toBe(true);
    expect((await probe.fetch(run())).status).toBe(409);
    await probe.alarm();
    expect(puppeteer.acquire).toHaveBeenCalledOnce();
    expect(BROWSER.closeSession).toHaveBeenCalledOnce();
  });

  it('never reacquires after an unknown response and lets a replacement DO retry only the known original ID', async () => {
    const unknown = setup();
    expect((await unknown.probe.fetch(recheck())).status).toBe(409);
    vi.mocked(puppeteer.acquire).mockRejectedValueOnce(new Error('unknown acquire'));
    const failure = await unknown.probe.fetch(run());
    expect(await failure.json()).toMatchObject({ state: 'failed', acquired: false, cleanupConfirmed: false });
    await new BrowserCloseProbe({ storage: unknown.storage }, unknown.env).alarm();
    expect(unknown.BROWSER.closeSession).not.toHaveBeenCalled();
    expect((await unknown.probe.fetch(run())).status).toBe(409);
    expect((await unknown.probe.fetch(recheck())).status).toBe(409);
    expect(puppeteer.acquire).toHaveBeenCalledOnce();

    const known = setup();
    known.BROWSER.closeSession.mockRejectedValueOnce(new Error('unknown close'));
    await known.probe.fetch(run());
    const resumed = new BrowserCloseProbe({ storage: known.storage }, known.env);
    expect(await (await resumed.fetch(endpoint('/status'))).json()).toMatchObject({ cleanupConfirmed: false });
    known.BROWSER.getSession.mockResolvedValueOnce(null);
    await resumed.alarm();
    expect(await (await resumed.fetch(endpoint('/status'))).json()).toMatchObject({ state: 'passed', after: 'absent', cleanupConfirmed: true });
    expect(known.BROWSER.closeSession.mock.calls).toEqual([[sessionId], [sessionId]]);
    expect(puppeteer.acquire).toHaveBeenCalledTimes(2);
  });

  it('extends cleanup once for concurrent rechecks and caps it at eight attempts on the stored ID', async () => {
    const { probe, BROWSER, storage, env } = setup();
    BROWSER.getSession.mockResolvedValueOnce({ sessionId });
    BROWSER.getSession.mockRejectedValue(Object.assign(new Error(`Session not found while unavailable ${sessionId}`), { status: 503, name: 'private-provider-class' }));
    await probe.fetch(run());
    expect((await probe.fetch(recheck())).status).toBe(409);
    for (let i = 1; i < 6; i++) await probe.alarm();
    expect(BROWSER.closeSession).toHaveBeenCalledTimes(6);
    const resumed = new BrowserCloseProbe({ storage }, env);
    await Promise.all([resumed.fetch(recheck()), resumed.fetch(recheck()), resumed.fetch(recheck())]);
    expect(BROWSER.closeSession).toHaveBeenCalledTimes(7);
    await resumed.alarm();
    await resumed.alarm();
    const response = await resumed.fetch(recheck());
    const content = await response.text();
    expect(JSON.parse(content)).toMatchObject({ state: 'failed', cleanupAttempts: 8, cleanupConfirmed: false, recheckAuthorized: true,
      getSessionError: { name: 'other', status: 503, notFound: false } });
    expect(content).not.toContain(sessionId);
    expect(content).not.toContain('private-provider-class');
    expect(content).not.toContain('while unavailable');
    expect(BROWSER.closeSession.mock.calls).toEqual(Array.from({ length: 8 }, () => [sessionId]));
    expect(puppeteer.acquire).toHaveBeenCalledOnce();
  });

  it.each([
    [Object.assign(new Error('getSession failed'), { status: 404 }), 404],
    [new Error(`Browser session ${sessionId} not found`), null],
  ])('accepts an explicit original-session absence after the close receipt', async (error, status) => {
    const { probe, BROWSER } = setup();
    BROWSER.getSession.mockResolvedValueOnce({ sessionId }).mockRejectedValueOnce(error);
    const response = await probe.fetch(run());
    const content = await response.text();
    expect(JSON.parse(content)).toMatchObject({ state: 'passed', cleanupConfirmed: true, after: 'absent', getSessionError: { name: 'Error', status, notFound: true } });
    expect(content).not.toContain(sessionId);
    expect(BROWSER.closeSession).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(BROWSER.getSession.mock.calls).toEqual([[sessionId], [sessionId]]);
  });
});
