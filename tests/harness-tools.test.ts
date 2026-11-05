import type { Browser } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';
import { HarnessTools } from '../server/harness-tools';
import { harnessHash } from '../server/harness-policy';
import { AdaptivePlay, playActionCaptureCount, validatePlayActions } from '../scripts/review-adaptive';

class TestStorage {
  private records = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.records.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.records.set(key, structuredClone(value)); }
  async transaction<T>(callback: (tx: TestStorage) => Promise<T>) {
    const previous = structuredClone(this.records);
    try {
      return await callback(this);
    } catch (error) {
      this.records = previous;
      throw error;
    }
  }
}

const html = '<!doctype html><title>Synthetic test</title>';
const another = '<!doctype html><title>New synthetic version</title>';
const screenshot = 'data:image/jpeg;base64,/9j/2Q==';
const shot = (index: number) => ({ id: `shot-${index}`, label: 'Original viewport', data: screenshot });
const deadline = () => Date.now() + 10_000;
const call = (name: string, id: string, args: Record<string, unknown>) => ({ name, id, arguments: args });
const version = async (input: string) => ({ html: input, inputHash: await harnessHash(input) });

function fixture(storage = new TestStorage()) {
  const closeBrowser = vi.fn(async () => {});
  const closeOwn = vi.fn(async () => {});
  const launch = vi.fn(async (_deadline: number, acquired: (id: string) => Promise<void>) => {
    await acquired('exact-acquired-browser');
    return { close: closeBrowser } as unknown as Browser;
  });
  const capture = vi.fn(async (_html: string, _onWait?: unknown, _deadline?: number, _creation?: { activeBudgetMs: number }) => ({ shots: Array.from({ length: 4 }, (_, i) => shot(i + 1)), probe: { loaded: {} }, captureRuntimeMs: 26_000 }));
  const act = vi.fn();
  const play = vi.fn((_browser: Browser, _html: string, inputHash: string, _remaining: number) => ({
    closed: false,
    playMs: 0,
    shots: [] as ReturnType<typeof shot>[],
    async start() {
      this.playMs = 1100;
      this.shots.push(shot(1));
    },
    async act(round: { actions: unknown[] }) {
      act(round);
      const actions = validatePlayActions(round.actions, 24);
      for (let i = 0; i < playActionCaptureCount(actions); i++) this.shots.push(shot(this.shots.length + 1));
      this.playMs += 200;
    },
    summary() {
      return { contextOrigin: 'creator-self-check', sourceBlind: false, inputHash, playMs: this.playMs, modelWaitMs: 1500 };
    },
    async close() { this.closed = true; },
  }));
  const deps = { closeOwn, launch, capture, play };
  const env = {} as ConstructorParameters<typeof HarnessTools>[0];
  return { tools: new HarnessTools(env, storage, deps as unknown as ConstructorParameters<typeof HarnessTools>[2]), capture, launch, closeBrowser, closeOwn, act, play, storage };
}

describe('Harness isolated browser tools', () => {
  it('verifies HTML bytes, locks invocation IDs, and shares the twelve-image budget across versions and instances', async () => {
    const first = fixture();
    const material = await version(html);
    const changed = await version(another);
    const operation = call('capture', 'capture-1', material);
    await expect(first.tools.execute(call('capture', 'wrong-digest', { ...material, html: another }), deadline())).rejects.toMatchObject({ status: 400 });
    const original = await first.tools.execute(operation, deadline());
    expect(original).toMatchObject({ inputHash: material.inputHash, contextOrigin: 'creator-self-check', sourceBlind: false });
    expect(original.shots).toHaveLength(4);
    expect((original.shots as { data: string; sha256: string }[])[0]).toMatchObject({ data: screenshot, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const resumed = fixture(first.storage);
    expect(await resumed.tools.execute(operation, deadline())).toEqual(original);
    expect(resumed.capture).not.toHaveBeenCalled();
    await expect(resumed.tools.execute(call('capture', 'capture-1', changed), deadline())).rejects.toMatchObject({ status: 409 });
    await resumed.tools.execute(call('capture', 'capture-2', changed), deadline());
    await resumed.tools.execute(call('capture', 'capture-3', material), deadline());
    await expect(resumed.tools.execute(call('play-start', 'start-after-budget', material), deadline())).rejects.toMatchObject({ status: 409 });
    expect(resumed.capture).toHaveBeenCalledTimes(2);
    expect(resumed.capture.mock.calls[0]).toMatchObject([another, undefined, expect.any(Number), { activeBudgetMs: 154_000 }]);
    expect(resumed.capture.mock.calls[1]).toMatchObject([html, undefined, expect.any(Number), { activeBudgetMs: 128_000 }]);
    expect(await first.storage.get('harness-browser-state')).toMatchObject({ shots: 12, activeMs: 78_000 });
  });

  it('preserves continuous-drag originals, tracks real active time, and closes the exact session', async () => {
    const { tools, act, closeBrowser, play } = fixture();
    const material = await version(html);
    const started = await tools.execute(call('play-start', 'start', material), deadline());
    expect(started).toMatchObject({ sourceBlind: false, playMs: 1100, shots: [{ data: screenshot }] });
    const session = { sessionId: started.sessionId, inputHash: material.inputHash };
    const action = { type: 'drag', path: [{ x: 4, y: 4, atMs: 0, capture: true }, { x: 30, y: 45, atMs: 50, capture: true }] };
    const round = { hypothesis: 'The canvas responds to a held drag.', actions: [action] };
    const actionCall = call('play-act', 'round', { ...session, round });
    const result = await tools.execute(actionCall, deadline());
    expect(result.shots).toHaveLength(3);
    expect(result.summary).toMatchObject({ contextOrigin: 'creator-self-check', sourceBlind: false, playMs: 1300, modelWaitMs: 1500 });
    expect(act).toHaveBeenCalledExactlyOnceWith(round);
    expect(await tools.execute(actionCall, deadline())).toEqual(result);
    await expect(tools.execute(call('play-act', 'wrong-input', { ...session, inputHash: (await version(another)).inputHash, round }), deadline())).rejects.toMatchObject({ status: 409 });
    const finished = await tools.execute(call('play-finish', 'finish', session), deadline());
    expect(finished.shots).toEqual([]);
    expect(closeBrowser).toHaveBeenCalledOnce();
    await tools.execute(call('play-start', 'second-version', await version(another)), deadline());
    expect(play.mock.calls[1][3]).toBe(180_000 - 1300);
    await tools.close();
    expect(closeBrowser).toHaveBeenCalledTimes(2);
  });

  it('refuses to resume a lost context and only attempts closing the acquired browser ID', async () => {
    const first = fixture();
    const material = await version(html);
    const started = await first.tools.execute(call('play-start', 'start', material), deadline());
    const resumed = fixture(first.storage);
    const session = { sessionId: started.sessionId, inputHash: material.inputHash };
    const round = { hypothesis: 'Check touch response.', actions: [{ type: 'tap', x: 12, y: 23 }] };
    await expect(resumed.tools.execute(call('play-act', 'lost', { ...session, round }), deadline())).rejects.toMatchObject({ status: 410 });
    expect(resumed.launch).not.toHaveBeenCalled();
    const closed = await resumed.tools.execute(call('play-close', 'cleanup', session), deadline());
    expect(closed).toMatchObject({ closed: true });
    expect(resumed.closeOwn).toHaveBeenCalledExactlyOnceWith('exact-acquired-browser');
  });

  it('retires a phase session while keeping its shared image and active-time reservations', async () => {
    const first = fixture();
    await first.tools.execute(call('play-start', 'start-phase-1', await version(html)), deadline());
    await first.tools.close();
    const next = fixture(first.storage);
    await next.tools.execute(call('play-start', 'start-phase-2', await version(another)), deadline());
    expect(first.closeBrowser).toHaveBeenCalledOnce();
    expect(next.play.mock.calls[0][3]).toBe(180_000 - 1100);
    expect(await first.storage.get('harness-browser-state')).toMatchObject({ shots: 2, activeMs: 2200 });
    await next.tools.close();
  });

  it('withholds captures that overrun the shared active-browser time', async () => {
    const { tools, capture, storage } = fixture();
    capture.mockResolvedValueOnce({ shots: Array.from({ length: 4 }, (_, i) => shot(i + 1)), probe: { loaded: {} }, captureRuntimeMs: 180_001 });
    const material = await version(html);
    await expect(tools.execute(call('capture', 'over-time', material), deadline())).rejects.toMatchObject({ status: 502 });
    await expect(tools.execute(call('play-start', 'past-time', material), deadline())).rejects.toMatchObject({ status: 409 });
    expect(await storage.get('harness-browser-state')).toMatchObject({ shots: 4, activeMs: 180_000 });
  });

  it('does not repeat a timed-out or ambiguous tool call', async () => {
    const { tools, capture } = fixture();
    const material = await version(html);
    capture.mockImplementationOnce(() => new Promise(() => {}));
    const operation = call('capture', 'unknown', material);
    await expect(tools.execute(operation, Date.now() + 80)).rejects.toMatchObject({ status: 504 });
    await expect(tools.execute(operation, deadline())).rejects.toMatchObject({ status: 409 });
    expect(capture).toHaveBeenCalledOnce();
  });

  it('labels creator observations as source-aware without allowing a blind first-look record', async () => {
    const { inputHash } = await version(html);
    const play = new AdaptivePlay({} as Browser, html, { creationInputHash: inputHash, denyExternal: true });
    expect(play.summary()).toMatchObject({ contextOrigin: 'creator-self-check', sourceBlind: false, inputHash });
    expect(() => play.recordFirstLook({})).toThrow('制作自检不能记录盲评首次印象');
    const member = new AdaptivePlay({} as Browser, html);
    expect(() => member.summary()).toThrow('首次印象尚未记录');
  });
});
