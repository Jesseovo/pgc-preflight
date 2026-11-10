import puppeteer from '@cloudflare/puppeteer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireBrowser, connectAcquiredBrowser } from '../server/browser-capacity';
import { captureEmbeddedBaseline, closeEmbeddedCapture, embeddedCaptureKey } from '../server/harness-embedded-capture';
import { BrowserAcquireRateLimit } from '../server/cloud-review-capture';
import { captureReview } from '../server/review-probe';

vi.mock('../server/browser-capacity', () => ({ acquireBrowser: vi.fn(), connectAcquiredBrowser: vi.fn() }));
vi.mock('../server/review-probe', () => ({ captureReview: vi.fn() }));
vi.mock('@cloudflare/puppeteer', () => ({ default: { acquire: vi.fn(), connect: vi.fn(), limits: vi.fn() } }));

const session = 'owned-synthetic-browser';
const html = '<!doctype html><title>Synthetic capture</title>';

function memoryStorage() {
  let values = new Map<string, unknown>();
  const accessor = (data: Map<string, unknown>) => ({
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    delete: async (key: string) => data.delete(key),
  });
  return {
    get: (key: string) => accessor(values).get(key),
    put: (key: string, value: unknown) => accessor(values).put(key, value),
    async transaction<T>(action: (tx: ReturnType<typeof accessor>) => Promise<T>) {
      const next = new Map(values);
      const value = await action(accessor(next));
      values = next; // A throw rolls back the entire transaction.
      return value;
    },
  };
}

function setup() {
  const storage = memoryStorage();
  const browser = { close: vi.fn() };
  const BROWSER = {
    closeSession: vi.fn(async (_id: string) => ({ status: 'closed' })),
    getSession: vi.fn(async (_id: string): Promise<{ sessionId: string; endTime?: number } | null> => null),
  };
  const env = { DB: {}, BROWSER };
  const evidence = { shots: ['one', 'two', 'three', 'four'], probe: {} };
  vi.mocked(acquireBrowser).mockImplementation(async (_db, _limits, launch) => launch());
  vi.mocked(connectAcquiredBrowser).mockImplementation(async (acquire, connect) => connect((await acquire()).sessionId));
  vi.mocked(puppeteer.acquire).mockResolvedValue({ sessionId: session } as Awaited<ReturnType<typeof puppeteer.acquire>>);
  vi.mocked(puppeteer.connect).mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof puppeteer.connect>>);
  vi.mocked(captureReview).mockResolvedValue(evidence as unknown as Awaited<ReturnType<typeof captureReview>>);
  const deadline = Date.now() + 30_000;
  const capture = () => captureEmbeddedBaseline(env, storage, html, undefined, deadline);
  return { BROWSER, browser, capture, deadline, env, evidence, storage };
}

afterEach(() => vi.resetAllMocks());

describe('embedded baseline browser lifecycle', () => {
  it('persists the exact acquired ID before connection and returns evidence only after confirmed close', async () => {
    const { BROWSER, browser, capture, deadline, evidence, storage } = setup();
    vi.mocked(puppeteer.acquire).mockImplementationOnce(async () => {
      expect(await storage.get(embeddedCaptureKey)).toEqual({ id: expect.any(String) });
      return { sessionId: session } as Awaited<ReturnType<typeof puppeteer.acquire>>;
    });
    vi.mocked(puppeteer.connect).mockImplementationOnce(async (_binding, id) => {
      expect(id).toBe(session);
      expect(await storage.get(embeddedCaptureKey)).toEqual({ id: expect.any(String), browserId: session });
      return browser as unknown as Awaited<ReturnType<typeof puppeteer.connect>>;
    });
    await expect(capture()).resolves.toEqual(evidence);
    expect(await storage.get(embeddedCaptureKey)).toBeUndefined();
    expect(puppeteer.acquire).toHaveBeenCalledWith(BROWSER, {
      keep_alive: expect.any(Number), recording: false, guardrails: { allowedDomains: [] },
    });
    expect(captureReview).toHaveBeenCalledWith(browser, html, { denyExternal: true, deadlineAt: deadline });
    expect(BROWSER.closeSession).toHaveBeenCalledExactlyOnceWith(session);
    expect(browser.close).not.toHaveBeenCalled();
  });

  it('reopens only after recovery confirms the original browser ID closed', async () => {
    const { BROWSER, capture, storage } = setup();
    const old = 'old-owned-session';
    await storage.put(embeddedCaptureKey, { id: 'old-capture', browserId: old });
    await expect(capture()).resolves.toBeDefined();
    expect(BROWSER.closeSession.mock.calls).toEqual([[old], [session]]);
    expect(BROWSER.closeSession).toHaveBeenCalledBefore(vi.mocked(puppeteer.acquire));
    expect(await storage.get(embeddedCaptureKey)).toBeUndefined();
  });

  it('retires a precisely rejected HTTP 429 attempt before the launch gate retries', async () => {
    const { BROWSER, capture, evidence, storage } = setup();
    vi.mocked(puppeteer.acquire).mockRejectedValueOnce(new Error('Unable to create new browser: code: 429: message: private response'));
    vi.mocked(acquireBrowser).mockImplementation(async (_db, _limits, launch) => {
      await expect(launch()).rejects.toBeInstanceOf(BrowserAcquireRateLimit);
      expect(await storage.get(embeddedCaptureKey)).toBeUndefined();
      return launch();
    });
    await expect(capture()).resolves.toEqual(evidence);
    expect(puppeteer.acquire).toHaveBeenCalledTimes(2);
    expect(puppeteer.connect).toHaveBeenCalledExactlyOnceWith(BROWSER, session);
    expect(BROWSER.closeSession).toHaveBeenCalledExactlyOnceWith(session);
    expect(await storage.get(embeddedCaptureKey)).toBeUndefined();
  });

  it.each([
    new Error('Synthetic lost acquire response 429'),
    new Error('Unable to create new browser: code: 503: message: upstream body mentions 429'),
  ])('retains ambiguous acquire %s without allocating again or entering a paid stage', async error => {
    const { BROWSER, capture, env, storage } = setup();
    const startModel = vi.fn();
    vi.mocked(puppeteer.acquire).mockRejectedValueOnce(error);
    await expect(capture().then(startModel)).rejects.toThrow('申请结果未确认');
    expect(await storage.get(embeddedCaptureKey)).toEqual({ id: expect.any(String) });
    await expect(closeEmbeddedCapture(env, storage)).rejects.toThrow('申请结果未知');
    await expect(capture().then(startModel)).rejects.toThrow('申请结果未知');
    expect(await storage.get(embeddedCaptureKey)).toEqual({ id: expect.any(String), cancelled: true });
    expect(puppeteer.acquire).toHaveBeenCalledOnce();
    expect(puppeteer.connect).not.toHaveBeenCalled();
    expect(BROWSER.closeSession).not.toHaveBeenCalled();
    expect(startModel).not.toHaveBeenCalled();
  });

  it('retains a known ID across failed closure and accepts confirmation only for that ID', async () => {
    const { BROWSER, capture, env, storage } = setup();
    const startModel = vi.fn();
    BROWSER.closeSession.mockRejectedValue(new Error('Synthetic close failure'));
    BROWSER.getSession.mockResolvedValue({ sessionId: 'unrelated', endTime: Date.now() });
    await expect(capture().then(startModel)).rejects.toThrow('关闭尚未确认');
    expect(await storage.get(embeddedCaptureKey)).toMatchObject({ browserId: session });
    await expect(capture().then(startModel)).rejects.toThrow('关闭尚未确认');
    expect(await storage.get(embeddedCaptureKey)).toMatchObject({ browserId: session, cancelled: true });
    expect(puppeteer.acquire).toHaveBeenCalledOnce();
    expect(startModel).not.toHaveBeenCalled();
    BROWSER.getSession.mockResolvedValue({ sessionId: session, endTime: Date.now() });
    await closeEmbeddedCapture(env, storage);
    expect(await storage.get(embeddedCaptureKey)).toBeUndefined();
    expect(BROWSER.closeSession.mock.calls).toEqual([[session], [session], [session]]);
    expect(BROWSER.getSession.mock.calls).toEqual([[session], [session], [session]]);
  });

  it('commits a late acquire ID before rejecting cancelled capture, so exact cleanup remains recoverable', async () => {
    const { BROWSER, capture, env, storage } = setup();
    const startModel = vi.fn();
    let reached!: () => void, finishAcquire!: () => void;
    const acquisitionStarted = new Promise<void>(resolve => { reached = resolve; });
    const acquisitionMayReturn = new Promise<void>(resolve => { finishAcquire = resolve; });
    vi.mocked(puppeteer.acquire).mockImplementationOnce(async () => {
      reached();
      await acquisitionMayReturn;
      return { sessionId: session } as Awaited<ReturnType<typeof puppeteer.acquire>>;
    });
    BROWSER.closeSession.mockRejectedValue(new Error('Synthetic close failure'));
    BROWSER.getSession.mockResolvedValue({ sessionId: session });
    const captureOutcome = capture().then(startModel).catch((error: unknown) => error);
    await acquisitionStarted;
    await expect(closeEmbeddedCapture(env, storage)).rejects.toThrow('申请结果未知');
    finishAcquire();
    expect(await captureOutcome).toBeInstanceOf(Error);
    expect(await storage.get(embeddedCaptureKey)).toEqual({ id: expect.any(String), browserId: session, cancelled: true });
    expect(puppeteer.connect).not.toHaveBeenCalled();
    expect(BROWSER.closeSession).toHaveBeenCalledExactlyOnceWith(session);
    expect(startModel).not.toHaveBeenCalled();
    BROWSER.closeSession.mockResolvedValue({ status: 'closed' });
    await closeEmbeddedCapture(env, storage);
    expect(await storage.get(embeddedCaptureKey)).toBeUndefined();
    expect(BROWSER.closeSession.mock.calls).toEqual([[session], [session]]);
  });

  it('bounds a wedged close and retains its marker even if the response arrives later', async () => {
    const { BROWSER, env, storage } = setup();
    const pending = { id: 'bounded-close', browserId: session };
    await storage.put(embeddedCaptureKey, pending);
    let finishClose!: (value: { status: string }) => void;
    BROWSER.closeSession.mockImplementationOnce(() => new Promise(resolve => { finishClose = resolve; }));
    vi.useFakeTimers();
    try {
      const outcome = expect(closeEmbeddedCapture(env, storage)).rejects.toThrow('关闭超时');
      await vi.advanceTimersByTimeAsync(5000);
      await outcome;
      expect(await storage.get(embeddedCaptureKey)).toEqual({ ...pending, cancelled: true });
      finishClose({ status: 'closed' });
      await vi.advanceTimersByTimeAsync(0);
      expect(await storage.get(embeddedCaptureKey)).toEqual({ ...pending, cancelled: true });
      await closeEmbeddedCapture(env, storage);
      expect(await storage.get(embeddedCaptureKey)).toBeUndefined();
      expect(BROWSER.closeSession.mock.calls).toEqual([[session], [session]]);
    } finally { vi.useRealTimers(); }
  });

  it('rejects a capture override that returned pictures without a closure receipt', async () => {
    const { deadline, env, storage } = setup();
    const startModel = vi.fn();
    const override = vi.fn(async () => ({ shots: ['synthetic'] }));
    await expect(captureEmbeddedBaseline({ ...env, captureReview: override }, storage, html, undefined, deadline).then(startModel))
      .rejects.toThrow('未确认浏览器关闭');
    expect(override).toHaveBeenCalledOnce();
    expect(startModel).not.toHaveBeenCalled();
    expect(puppeteer.acquire).not.toHaveBeenCalled();
  });
});
