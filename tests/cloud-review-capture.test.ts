import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import puppeteer from '@cloudflare/puppeteer';
import {captureFor, closeCaptureBrowser} from '../server/cloud-review-capture';
import {acquireBrowser, connectAcquiredBrowser} from '../server/browser-capacity';
import {captureReview} from '../server/review-probe';
import {recordReviewTiming} from '../server/review-timing';
vi.mock('../server/browser-capacity',()=>({acquireBrowser:vi.fn(),connectAcquiredBrowser:vi.fn()}));
vi.mock('../server/review-probe',()=>({captureReview:vi.fn()}));
vi.mock('../server/review-timing',()=>({recordReviewTiming:vi.fn()}));
vi.mock('@cloudflare/puppeteer',()=>({default:{acquire:vi.fn(),connect:vi.fn(),limits:vi.fn()}}));
beforeEach(()=>{vi.mocked(recordReviewTiming).mockResolvedValue(true);});
afterEach(()=>{vi.resetAllMocks();});
describe('cloud capture lifecycle and browser timing',()=>{
 it('records browser acquisition separately and passes unchanged HTML to the existing capture pipeline',async()=>{
  const browser={close:vi.fn(async()=>{})},evidence={shots:[1,2,3,4],probe:{captureMethod:'browser-viewport-v1'}};
  vi.mocked(acquireBrowser).mockResolvedValue(browser);vi.mocked(captureReview).mockResolvedValue(evidence as any);
  const env={DB:{},reviewJobId:'synthetic-job'};await expect(captureFor(env)('<html>synthetic</html>')).resolves.toEqual(evidence);
  expect(captureReview).toHaveBeenCalledWith(browser,'<html>synthetic</html>');expect(browser.close).toHaveBeenCalledOnce();expect(recordReviewTiming).toHaveBeenCalledWith(env.DB,expect.objectContaining({jobId:'synthetic-job',phase:'browser_start',origin:'server',status:'ok'}));
 });
 it('telemetry failure does not block capture and a capture error still closes the acquired browser',async()=>{
  const browser={close:vi.fn(async()=>{})};vi.mocked(acquireBrowser).mockResolvedValue(browser);vi.mocked(recordReviewTiming).mockRejectedValueOnce(new Error('synthetic telemetry error'));vi.mocked(captureReview).mockRejectedValueOnce(new Error('synthetic capture error'));
  await expect(captureFor({DB:{},reviewJobId:'synthetic-job'})('synthetic')).rejects.toThrow('synthetic capture error');expect(browser.close).toHaveBeenCalledOnce();
 });
 it('failed browser acquisition is measured as an error and cannot reach capture or a model',async()=>{
  vi.mocked(acquireBrowser).mockRejectedValueOnce(new Error('synthetic acquisition error'));
  await expect(captureFor({DB:{},reviewJobId:'synthetic-job'})('synthetic')).rejects.toThrow('synthetic acquisition error');expect(captureReview).not.toHaveBeenCalled();expect(recordReviewTiming).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({phase:'browser_start',status:'error'}));
 });
});

describe('tracked Harness capture', () => {
  function setup() {
    const sessionId = 'newly-acquired-session';
    const browser = { close: vi.fn(async () => {}) };
    const binding = { closeSession: vi.fn(async (_id: string) => ({ status: 'closed' })), getSession: vi.fn(async (_id: string): Promise<unknown> => null) };
    const lifecycle = { acquiring: vi.fn(async () => {}), acquired: vi.fn(async (_id: string) => {}), closed: vi.fn(async (_id: string) => {}) };
    vi.mocked(acquireBrowser).mockImplementation(async (_db, _limits, launch) => launch());
    vi.mocked(connectAcquiredBrowser).mockImplementation(async (acquire, connect) => connect((await acquire()).sessionId));
    vi.mocked(puppeteer.acquire).mockResolvedValue({ sessionId } as Awaited<ReturnType<typeof puppeteer.acquire>>);
    vi.mocked(puppeteer.connect).mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof puppeteer.connect>>);
    vi.mocked(captureReview).mockResolvedValue({ shots: [], probe: {} } as unknown as Awaited<ReturnType<typeof captureReview>>);
    const capture = () => captureFor({ DB: {}, BROWSER: binding, creationCaptureStrict: true })('synthetic', undefined, Date.now() + 30_000, { activeBudgetMs: 15_000 }, lifecycle);
    return { sessionId, browser, binding, lifecycle, capture };
  }

  it('records the acquisition and exact session before connecting, then confirms close before returning evidence', async () => {
    const { capture, binding, lifecycle, sessionId, browser } = setup();
    await expect(capture()).resolves.toMatchObject({ shots: [], captureRuntimeMs: expect.any(Number) });
    expect(lifecycle.acquiring).toHaveBeenCalledBefore(vi.mocked(puppeteer.acquire));
    expect(puppeteer.acquire).toHaveBeenCalledWith(binding, { guardrails: { allowedDomains: [] }, recording: false, keep_alive: expect.any(Number) });
    expect(lifecycle.acquired).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(lifecycle.acquired).toHaveBeenCalledBefore(vi.mocked(puppeteer.connect));
    expect(binding.closeSession).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(binding.closeSession).toHaveBeenCalledBefore(lifecycle.closed);
    expect(lifecycle.closed).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(browser.close).not.toHaveBeenCalled();
  });

  it('keeps an unconfirmed allocation as pending and never retries that provider request', async () => {
    const { capture, binding, lifecycle } = setup();
    vi.mocked(puppeteer.acquire).mockRejectedValueOnce(new Error('429 synthetic ambiguous upstream error'));
    await expect(capture()).rejects.toThrow('截图浏览器申请结果未确认');
    expect(lifecycle.acquiring).toHaveBeenCalledOnce();
    expect(lifecycle.acquired).not.toHaveBeenCalled();
    expect(lifecycle.closed).not.toHaveBeenCalled();
    expect(binding.closeSession).not.toHaveBeenCalled();
    expect(puppeteer.connect).not.toHaveBeenCalled();
    expect(puppeteer.acquire).toHaveBeenCalledOnce();
  });

  it('closes the exact ID after connection fails or the acquisition callback reports cancellation', async () => {
    const first = setup();
    vi.mocked(puppeteer.connect).mockRejectedValueOnce(new Error('socket refused'));
    await expect(first.capture()).rejects.toThrow('socket refused');
    expect(first.binding.closeSession).toHaveBeenCalledExactlyOnceWith(first.sessionId);
    expect(first.lifecycle.closed).toHaveBeenCalledExactlyOnceWith(first.sessionId);

    const second = setup();
    second.lifecycle.acquired.mockRejectedValueOnce(new Error('task already closed'));
    await expect(second.capture()).rejects.toThrow('task already closed');
    expect(puppeteer.connect).toHaveBeenCalledOnce();
    expect(captureReview).not.toHaveBeenCalled();
    expect(second.binding.closeSession).toHaveBeenCalledExactlyOnceWith(second.sessionId);
    expect(second.lifecycle.closed).toHaveBeenCalledExactlyOnceWith(second.sessionId);
  });

  it('withholds evidence and preserves the marker until exact-session closure is confirmed', async () => {
    const { capture, binding, lifecycle, sessionId } = setup();
    vi.useFakeTimers();
    try {
      binding.closeSession.mockResolvedValue({ status: 'closing' });
      binding.getSession.mockResolvedValue({ sessionId });
      const outcome = expect(capture()).rejects.toThrow('截图浏览器关闭尚未确认');
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(binding.getSession).toHaveBeenCalledWith(sessionId);
      expect(lifecycle.closed).not.toHaveBeenCalled();

      const scoped = binding as unknown as Parameters<typeof closeCaptureBrowser>[0];
      binding.closeSession.mockRejectedValue(new Error('unknown close'));
      binding.getSession.mockResolvedValueOnce({ sessionId: 'unrelated-session', endTime: Date.now() });
      await expect(closeCaptureBrowser(scoped, sessionId)).rejects.toThrow('截图浏览器关闭尚未确认');
      const ended = { sessionId, endTime: Date.now() };
      binding.getSession.mockResolvedValueOnce(ended);
      await expect(closeCaptureBrowser(scoped, sessionId)).resolves.toBeUndefined();
      expect(await binding.getSession.mock.results.at(-1)?.value).toEqual(ended);
      for (const query of binding.getSession.mock.calls) expect(query).toEqual([sessionId]);
    } finally {
      vi.useRealTimers();
    }
  });
});
