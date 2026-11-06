import { createHash } from 'node:crypto';
import type { Browser } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';
import { HarnessTools } from '../server/harness-tools';
import type { CaptureBrowserLifecycle } from '../server/cloud-review-capture';
import { canonicalHarness, harnessHash } from '../server/harness-policy';
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
const shot = (index: number, actionRefs: (string | number)[] = []) => ({
  id: `shot-${index}`, label: 'Original viewport', data: screenshot, actionRefs,
});
const deadline = () => Date.now() + 10_000;
const pendingCaptureKey = 'harness-browser-pending-capture';
const call = (name: string, id: string, args: Record<string, unknown>) => ({ name, id, arguments: args });
const version = async (input: string) => ({ html: input, inputHash: await harnessHash(input) });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(storage = new TestStorage()) {
  const disconnect = vi.fn(async () => {});
  const closeOwn = vi.fn(async (_browserId: string) => {});
  const launch = vi.fn(async (_deadline: number, acquired: (id: string) => Promise<void>, acquiring: () => Promise<void>, _rejected: () => Promise<void>) => {
    await acquiring();
    await acquired('exact-acquired-browser');
    return { disconnect } as unknown as Browser;
  });
  const capture = vi.fn(async (_html: string, _onWait?: unknown, _deadline?: number, _creation?: { activeBudgetMs: number }, lifecycle?: CaptureBrowserLifecycle) => {
    await lifecycle!.acquiring();
    await lifecycle!.acquired('exact-capture-browser');
    await lifecycle!.closed('exact-capture-browser');
    return {
      shots: Array.from({ length: 4 }, (_, i) => shot(i + 1, i === 0 ? [] : ['touch'])),
      probe: {
        loaded: {}, actions: [{ id: 'touch', type: 'tap' }],
        observations: Array.from({ length: 4 }, (_, i) => ({ id: `shot-${i + 1}`, actionRefs: i === 0 ? [] : ['touch'] })),
      }, captureRuntimeMs: 26_000,
    };
  });
  const act = vi.fn();
  const play = vi.fn((_browser: Browser, _html: string, inputHash: string, _remaining: number) => ({
    closed: false,
    playMs: 0,
    shots: [] as ReturnType<typeof shot>[],
    actions: [] as { beforeImageId: string; afterImageId: string }[],
    async start() {
      this.playMs = 1100;
      this.shots.push(shot(1));
    },
    async act(round: { actions: unknown[] }) {
      act(round);
      const actions = validatePlayActions(round.actions, 24);
      const beforeImageId = this.shots.at(-1)!.id;
      for (let i = 0; i < playActionCaptureCount(actions); i++) this.shots.push(shot(this.shots.length + 1, [this.actions.length + 1]));
      this.actions.push({ beforeImageId, afterImageId: this.shots.at(-1)!.id });
      this.playMs += 200;
    },
    summary() {
      return { contextOrigin: 'creator-self-check', sourceBlind: false, inputHash, playMs: this.playMs, modelWaitMs: 1500, actions: this.actions };
    },
    async close() { this.closed = true; },
  }));
  const deps = { closeOwn, launch, capture, play };
  const env = {} as ConstructorParameters<typeof HarnessTools>[0];
  return { tools: new HarnessTools(env, storage, deps as unknown as ConstructorParameters<typeof HarnessTools>[2]), capture, launch, disconnect, closeOwn, act, play, storage };
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
    expect(original.shots[0]).toMatchObject({
      id: `${original.evidenceId}:shot:1`, sourceId: 'shot-1', data: screenshot,
      sha256: createHash('sha256').update(Buffer.from(screenshot.split(',')[1], 'base64')).digest('hex'),
    });
    expect(original.actions[0]).toMatchObject({ id: `${original.evidenceId}:action:1`, sourceId: 'touch' });
    expect(original.shots[1].actionRefs).toEqual([original.actions[0].id]);
    expect(original.probe).toMatchObject({ observations: [{ id: original.shots[0].id, sourceId: 'shot-1' },
      { id: original.shots[1].id, actionRefs: [original.actions[0].id] }, {}, {}] });
    const { evidenceHash, ...record } = original;
    expect(evidenceHash).toBe(await harnessHash(canonicalHarness(record)));
    const resumed = fixture(first.storage);
    expect(await resumed.tools.execute(operation, deadline())).toEqual(original);
    expect(resumed.capture).not.toHaveBeenCalled();
    await expect(resumed.tools.execute(call('capture', 'capture-1', changed), deadline())).rejects.toMatchObject({ status: 409 });
    const second = await resumed.tools.execute(call('capture', 'capture-2', changed), deadline());
    const third = await resumed.tools.execute(call('capture', 'capture-3', material), deadline());
    expect(second.shots[0].sourceId).toBe(original.shots[0].sourceId);
    expect(second.shots[0].id).not.toBe(original.shots[0].id);
    expect(third.inputHash).toBe(original.inputHash);
    expect(third.shots[0].id).not.toBe(original.shots[0].id);
    expect(await fixture(first.storage).tools.readResults()).toEqual([original, second, third]);
    await expect(resumed.tools.execute(call('play-start', 'start-after-budget', material), deadline())).rejects.toMatchObject({ status: 409 });
    expect(resumed.capture).toHaveBeenCalledTimes(2);
    expect(resumed.capture.mock.calls[0].slice(0, 4)).toMatchObject([another, undefined, expect.any(Number), { activeBudgetMs: 154_000 }]);
    expect(resumed.capture.mock.calls[1].slice(0, 4)).toMatchObject([html, undefined, expect.any(Number), { activeBudgetMs: 128_000 }]);
    expect(await first.storage.get('harness-browser-state')).toMatchObject({ shots: 12, activeMs: 78_000 });
  });

  it('preserves continuous-drag originals, tracks real active time, and closes the exact session', async () => {
    const { tools, act, closeOwn, disconnect, play } = fixture();
    const material = await version(html);
    const started = await tools.execute(call('play-start', 'start', material), deadline());
    expect(started).toMatchObject({ sourceBlind: false, playMs: 1100, shots: [{ data: screenshot }] });
    const session = { sessionId: started.sessionId, inputHash: material.inputHash };
    const action = { type: 'drag', path: [{ x: 4, y: 4, atMs: 0, capture: true }, { x: 30, y: 45, atMs: 50, capture: true }] };
    const round = { hypothesis: 'The canvas responds to a held drag.', actions: [action] };
    const actionCall = call('play-act', 'round', { ...session, round });
    const result = await tools.execute(actionCall, deadline());
    expect(result.shots).toHaveLength(3);
    expect(result.actions).toEqual([{
      id: `${result.evidenceId}:action:1`, sourceId: 1, beforeImageId: started.shots[0].id,
      afterImageId: result.shots[2].id,
    }]);
    expect(result.shots.every(shot => shot.actionRefs[0] === result.actions[0].id)).toBe(true);
    expect(result.summary).toMatchObject({ contextOrigin: 'creator-self-check', sourceBlind: false, playMs: 1300, modelWaitMs: 1500 });
    expect(act).toHaveBeenCalledExactlyOnceWith(round);
    expect(await tools.execute(actionCall, deadline())).toEqual(result);
    await expect(tools.execute(call('play-act', 'wrong-input', { ...session, inputHash: (await version(another)).inputHash, round }), deadline())).rejects.toMatchObject({ status: 409 });
    const next = await tools.execute(call('play-act', 'second-round', {
      ...session, round: { hypothesis: 'Check another input.', actions: [{ type: 'tap', x: 12, y: 23 }] },
    }), deadline());
    expect(next.actions).toEqual([{
      id: `${next.evidenceId}:action:1`, sourceId: 2, beforeImageId: result.shots[2].id,
      afterImageId: next.shots[0].id,
    }]);
    const finished = await tools.execute(call('play-finish', 'finish', session), deadline());
    expect(finished.shots).toEqual([]);
    expect(finished.actions).toEqual([]);
    expect(finished.summary).toMatchObject({ actions: [...result.actions, ...next.actions] });
    expect(await tools.readResults()).toEqual([started, result, next, finished]);
    expect(closeOwn).toHaveBeenCalledExactlyOnceWith('exact-acquired-browser');
    expect(disconnect).toHaveBeenCalledOnce();
    await tools.execute(call('play-start', 'second-version', await version(another)), deadline());
    expect(play.mock.calls[1][3]).toBe(180_000 - 1500);
    await tools.close();
    expect(closeOwn).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
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
    expect(first.closeOwn).toHaveBeenCalledExactlyOnceWith('exact-acquired-browser');
    expect(next.play.mock.calls[0][3]).toBe(180_000 - 1100);
    expect(await first.storage.get('harness-browser-state')).toMatchObject({ shots: 2, activeMs: 2200 });
    await next.tools.close();
  });

  it('retries only the known rejected play acquisition and tracks the next exact browser', async () => {
    const first = fixture();
    first.launch.mockImplementationOnce(async (_deadline, acquired, acquiring, rejected) => {
      await acquiring();
      expect(await first.storage.get('harness-browser-state')).toMatchObject({ session: { acquisitionStarted: true } });
      await rejected();
      expect(await first.storage.get('harness-browser-state')).toMatchObject({ session: { acquisitionStarted: false } });
      await acquiring();
      await acquired('exact-browser-after-429');
      return { disconnect: first.disconnect } as unknown as Browser;
    });
    const result = await first.tools.execute(call('play-start', 'play-retry', await version(html)), deadline());
    expect(result.shots).toHaveLength(1);
    await first.tools.close();
    expect(first.closeOwn).toHaveBeenCalledExactlyOnceWith('exact-browser-after-429');
  });

  it('clears a rejected supplemental capture marker before retrying with a new browser', async () => {
    const first = fixture();
    const capture = first.capture.getMockImplementation()!;
    first.capture.mockImplementationOnce(async (source, wait, at, options, lifecycle) => {
      await lifecycle!.acquiring();
      expect(await first.storage.get(pendingCaptureKey)).toMatchObject({ invocationId: 'capture-retry' });
      await lifecycle!.rejected();
      expect(await first.storage.get(pendingCaptureKey)).toBeNull();
      return capture(source, wait, at, options, lifecycle);
    });
    const result = await first.tools.execute(call('capture', 'capture-retry', await version(html)), deadline());
    expect(result.shots).toHaveLength(4);
    expect(await first.storage.get(pendingCaptureKey)).toBeNull();
    await first.tools.close();
    expect(first.closeOwn).not.toHaveBeenCalled();
  });

  it('retains an unknown or legacy allocation without an ID and refuses to report it closed', async () => {
    const first = fixture();
    first.launch.mockImplementationOnce(async (_deadline, _acquired, acquiring) => {
      await acquiring();
      throw new Error('lost acquisition response');
    });
    const material = await version(html);
    await expect(first.tools.execute(call('play-start', 'unknown-play', material), deadline())).rejects.toMatchObject({ status: 502 });
    const state = (await first.storage.get<{ session: { id: string; acquisitionStarted?: boolean } }>('harness-browser-state'))!;
    expect(state.session).toMatchObject({ acquisitionStarted: true });
    const resumed = fixture(first.storage);
    const closing = call('play-close', 'close-unknown', { sessionId: state.session.id, inputHash: material.inputHash });
    await expect(resumed.tools.execute(closing, deadline())).rejects.toMatchObject({ status: 503 });
    await expect(resumed.tools.close()).rejects.toMatchObject({ status: 503 });
    expect(resumed.closeOwn).not.toHaveBeenCalled();

    delete state.session.acquisitionStarted;
    await first.storage.put('harness-browser-state', state);
    await expect(fixture(first.storage).tools.close()).rejects.toMatchObject({ status: 503 });
  });

  it('retires only a queued, unrequested play session and prevents a later launch', async () => {
    const first = fixture();
    const queued = gate();
    const gateOpen = gate();
    first.launch.mockImplementationOnce(async (_deadline, _acquired, acquiring) => {
      queued.resolve();
      await gateOpen.promise;
      await acquiring();
      throw new Error('unexpected request after retirement');
    });
    const execution = first.tools.execute(call('play-start', 'queued-play', await version(html)), deadline());
    const outcome = expect(execution).rejects.toMatchObject({ status: 409 });
    await queued.promise;
    const resumed = fixture(first.storage);
    await expect(resumed.tools.close()).resolves.toBeUndefined();
    gateOpen.resolve();
    await outcome;
    expect(resumed.closeOwn).not.toHaveBeenCalled();
    expect(await first.storage.get<{ session?: unknown }>('harness-browser-state')).not.toHaveProperty('session');
  });

  it('persists a late play allocation before cancellation and recovers the exact ID after restart', async () => {
    const first = fixture();
    const started = gate();
    const allocated = gate();
    first.launch.mockImplementationOnce(async (_deadline, acquired, acquiring) => {
      await acquiring();
      started.resolve();
      await allocated.promise;
      await acquired('late-play-browser');
      throw new Error('unexpected connection after cancellation');
    });
    const execution = first.tools.execute(call('play-start', 'late-play', await version(html)), deadline());
    const outcome = expect(execution).rejects.toMatchObject({ status: 409 });
    await started.promise;
    const resumed = fixture(first.storage);
    await expect(resumed.tools.close()).rejects.toMatchObject({ status: 503 });
    expect(resumed.closeOwn).not.toHaveBeenCalled();
    allocated.resolve();
    await outcome;
    expect(await first.storage.get('harness-browser-state')).toMatchObject({ session: { browserId: 'late-play-browser', acquisitionStarted: true, cancelled: true } });
    await expect(resumed.tools.close()).resolves.toBeUndefined();
    expect(resumed.closeOwn).toHaveBeenCalledExactlyOnceWith('late-play-browser');
  });

  it('does not treat local disconnect as remote closure and retries a known connection failure by ID', async () => {
    const first = fixture();
    const material = await version(html);
    const opening = await first.tools.execute(call('play-start', 'open', material), deadline());
    first.closeOwn.mockRejectedValueOnce(new Error('remote close unknown'));
    await expect(first.tools.execute(call('play-close', 'close-unconfirmed', { sessionId: opening.sessionId, inputHash: material.inputHash }), deadline())).rejects.toMatchObject({ status: 503 });
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(await first.storage.get('harness-browser-state')).toMatchObject({ session: { browserId: 'exact-acquired-browser' } });
    const resumed = fixture(first.storage);
    await resumed.tools.close();
    expect(resumed.closeOwn).toHaveBeenCalledExactlyOnceWith('exact-acquired-browser');

    const connection = fixture();
    connection.launch.mockImplementationOnce(async (_deadline, acquired, acquiring) => {
      await acquiring();
      await acquired('play-with-failed-connect');
      throw new Error('connection failed');
    });
    await expect(connection.tools.execute(call('play-start', 'failed-connect', material), deadline())).rejects.toMatchObject({ status: 502 });
    await connection.tools.close();
    expect(connection.closeOwn).toHaveBeenCalledExactlyOnceWith('play-with-failed-connect');
  });

  it('fails closed on corrupted completed evidence without another browser call', async () => {
    const { tools, capture, storage } = fixture();
    const material = await version(html);
    const request = call('capture', 'saved', material);
    await tools.execute(request, deadline());
    const part = await storage.get<string>('harness-browser-call:saved:0');
    expect(part).toContain('Original viewport');
    await storage.put('harness-browser-call:saved:0', part!.replace('Original viewport', 'Unverified viewport'));
    await expect(tools.readResults()).rejects.toMatchObject({ status: 409 });
    await expect(tools.execute(request, deadline())).rejects.toMatchObject({ status: 409 });
    expect(capture).toHaveBeenCalledOnce();
  });

  it('withholds captures that overrun the shared active-browser time', async () => {
    const { tools, capture, storage } = fixture();
    capture.mockResolvedValueOnce({ shots: Array.from({ length: 4 }, (_, i) => shot(i + 1)), probe: { loaded: {}, actions: [], observations: [] }, captureRuntimeMs: 180_001 });
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
    expect(await tools.readResults()).toEqual([]);
  });

  it('keeps an acquired capture across connection failure, restart and an unconfirmed close', async () => {
    const first = fixture();
    first.capture.mockImplementationOnce(async (_html, _wait, _deadline, _creation, lifecycle) => {
      await lifecycle!.acquiring();
      await lifecycle!.acquired('capture-after-connect-failure');
      throw new Error('connection failed');
    });
    const material = await version(html);
    await expect(first.tools.execute(call('capture', 'interrupted', material), deadline())).rejects.toMatchObject({ status: 502 });
    expect(await first.storage.get(pendingCaptureKey)).toEqual({ invocationId: 'interrupted', browserId: 'capture-after-connect-failure' });
    const resumed = fixture(first.storage);
    await expect(resumed.tools.execute(call('capture', 'different', material), deadline())).rejects.toMatchObject({ status: 503 });
    resumed.closeOwn.mockRejectedValueOnce(new Error('unknown close result'));
    await expect(resumed.tools.close()).rejects.toMatchObject({ status: 503 });
    expect(await first.storage.get(pendingCaptureKey)).toMatchObject({ browserId: 'capture-after-connect-failure', cancelled: true });
    await expect(resumed.tools.close()).resolves.toBeUndefined();
    expect(resumed.closeOwn.mock.calls).toEqual([['capture-after-connect-failure'], ['capture-after-connect-failure']]);
    expect(await first.storage.get(pendingCaptureKey)).toBeNull();
    expect(await resumed.tools.readResults()).toEqual([]);
  });

  it('blocks cleanup before a late acquire returns and records the exact ID before aborting', async () => {
    const first = fixture();
    const waiting = gate();
    const allocated = gate();
    first.capture.mockImplementationOnce(async (_html, _wait, _deadline, _creation, lifecycle) => {
      await lifecycle!.acquiring();
      waiting.resolve();
      await allocated.promise;
      await lifecycle!.acquired('capture-allocated-after-close');
      throw new Error('unexpected capture after cancellation');
    });
    const material = await version(html);
    const running = first.tools.execute(call('capture', 'acquiring', material), deadline());
    const outcome = expect(running).rejects.toMatchObject({ status: 409 });
    await waiting.promise;
    const resumed = fixture(first.storage);
    await expect(resumed.tools.close()).rejects.toMatchObject({ status: 503 });
    expect(resumed.closeOwn).not.toHaveBeenCalled();
    expect(await first.storage.get(pendingCaptureKey)).toEqual({ invocationId: 'acquiring', cancelled: true });
    allocated.resolve();
    await outcome;
    expect(await first.storage.get(pendingCaptureKey)).toMatchObject({ browserId: 'capture-allocated-after-close' });
    await expect(resumed.tools.close()).resolves.toBeUndefined();
    expect(resumed.closeOwn).toHaveBeenCalledExactlyOnceWith('capture-allocated-after-close');
  });

  it('stops a queued capture from acquiring a browser after cleanup succeeded', async () => {
    const first = fixture();
    const queued = gate();
    const gateOpen = gate();
    first.capture.mockImplementationOnce(async (_html, _wait, _deadline, _creation, lifecycle) => {
      queued.resolve();
      await gateOpen.promise;
      await lifecycle!.acquiring();
      throw new Error('unexpected allocation after cleanup');
    });
    const running = first.tools.execute(call('capture', 'queued', await version(html)), deadline());
    const outcome = expect(running).rejects.toMatchObject({ status: 409 });
    await queued.promise;
    await expect(first.tools.close()).resolves.toBeUndefined();
    gateOpen.resolve();
    await outcome;
    expect(first.closeOwn).not.toHaveBeenCalled();
    expect(await first.storage.get(pendingCaptureKey)).toBeUndefined();
  });

  it('keeps an unknown allocation after its deadline and closes a known late allocation without releasing evidence', async () => {
    const first = fixture();
    const late = gate();
    const returned = gate();
    first.capture.mockImplementationOnce(async (_html, _wait, _deadline, _creation, lifecycle) => {
      await lifecycle!.acquiring();
      await late.promise;
      try { await lifecycle!.acquired('capture-returned-after-deadline'); }
      finally { returned.resolve(); }
      throw new Error('unexpected capture after deadline');
    });
    const material = await version(html);
    await expect(first.tools.execute(call('capture', 'expired', material), Date.now() + 80)).rejects.toMatchObject({ status: 504 });
    const resumed = fixture(first.storage);
    await expect(resumed.tools.close()).rejects.toMatchObject({ status: 503 });
    expect(resumed.closeOwn).not.toHaveBeenCalled();
    late.resolve();
    await returned.promise;
    await expect(resumed.tools.close()).resolves.toBeUndefined();
    expect(resumed.closeOwn).toHaveBeenCalledExactlyOnceWith('capture-returned-after-deadline');
    expect(await resumed.tools.readResults()).toEqual([]);
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
