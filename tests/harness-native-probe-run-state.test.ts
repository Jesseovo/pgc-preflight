import { describe, expect, it, vi } from 'vitest';
import { awaitIdleResearchWorker, observeResearchAction } from '../scripts/harness-native-probe-run-state.mjs';

function clock() {
  let at = 100;
  return { now: () => at, pause: async (ms: number) => { at += ms; } };
}

describe('native research launcher', () => {
  it('waits for the new Secret with bounded GETs only before accepting idle', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ httpStatus: 401, receipt: { error: 'unauthorized' } })
      .mockResolvedValueOnce({ httpStatus: null, receipt: null })
      .mockResolvedValueOnce({ httpStatus: 503, receipt: null })
      .mockResolvedValueOnce({ httpStatus: 200, receipt: { state: 'idle' } });
    expect(await awaitIdleResearchWorker(request, clock())).toEqual({ outcome: 'ready', httpStatus: 200 });
    expect(request.mock.calls).toEqual(Array.from({ length: 4 }, () => ['/status', 'GET', 5000]));
  });

  it.each(['running', 'passed', 'failed'])('does not authorize a new action when status is %s', async state => {
    const request = vi.fn(async () => ({ httpStatus: 200, receipt: { state } }));
    expect(await awaitIdleResearchWorker(request, clock())).toEqual({ outcome: 'already_started', httpStatus: 200, state });
    expect(request.mock.calls).toEqual([['/status', 'GET', 5000]]);
  });

  it('stops secret polling at 60 seconds and never sends a POST', async () => {
    const time = clock();
    const request = vi.fn(async () => ({ httpStatus: 401, receipt: null }));
    expect(await awaitIdleResearchWorker(request, time)).toEqual({ outcome: 'status_wait_expired', httpStatus: 401 });
    expect(time.now()).toBe(60_100);
    expect(request).toHaveBeenCalledTimes(60);
    expect(request.mock.calls.at(-1)).toEqual(['/status', 'GET', 1000]);
  });

  it('recovers an uncertain POST by reading status without issuing a second POST', async () => {
    const terminal = { httpStatus: 200, receipt: { state: 'passed', action: 'run' } };
    const request = vi.fn()
      .mockResolvedValueOnce({ httpStatus: null, receipt: null, executionState: 'unknown' })
      .mockResolvedValueOnce({ httpStatus: 200, receipt: { state: 'running', action: 'run' } })
      .mockResolvedValueOnce(terminal);
    expect(await observeResearchAction(request, '/run', 'run', clock())).toEqual(terminal);
    expect(request.mock.calls).toEqual([['/run', 'POST', 115_000], ['/status', 'GET', 5000], ['/status', 'GET', 5000]]);
  });

  it('cannot use a previous action receipt as proof of an uncertain alarm submission', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ httpStatus: 502, receipt: { error: 'unconfirmed' } })
      .mockResolvedValue({ httpStatus: 200, receipt: { state: 'passed', action: 'run' } });
    expect(await observeResearchAction(request, '/arm-timeout', 'arm-timeout', { ...clock(), timeoutMs: 3500 }))
      .toEqual({ httpStatus: 200, receipt: null, executionState: 'unknown' });
    expect(request.mock.calls).toEqual([['/arm-timeout', 'POST', 115_000], ['/status', 'GET', 1500]]);
  });
});
