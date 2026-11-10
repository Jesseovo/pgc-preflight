import { describe, expect, it, vi } from 'vitest';
import { awaitIdleResearchWorker, observeResearchAction, researchResponseDiagnostic } from '../scripts/harness-native-probe-run-state.mjs';

function clock() {
  let at = 100;
  return { now: () => at, pause: async (ms: number) => { at += ms; } };
}

const getDiagnostic = { version: 'auth-v1', method: 'GET' };
const authDenied = { httpStatus: 401, receipt: { error: 'authorization_mismatch' },
  diagnostic: { version: 'auth-v1', method: 'POST', stage: 'pre-dispatch-auth', edge: 'SJC' } };
const idle = { httpStatus: 200, receipt: { state: 'idle' }, diagnostic: getDiagnostic };

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

  it('records only allowlisted response diagnostics and extracts the edge suffix', () => {
    expect(researchResponseDiagnostic(new Headers({
      'x-pgc-native-probe-version': 'auth-v1', 'x-pgc-native-probe-method': 'POST',
      'x-pgc-native-probe-stage': 'pre-dispatch-auth', 'cf-ray': '0123456789abcdef-SJC', authorization: 'private',
    }))).toEqual(authDenied.diagnostic);
    expect(researchResponseDiagnostic(new Headers({
      'x-pgc-native-probe-version': 'arbitrary', 'x-pgc-native-probe-method': 'private', 'cf-ray': 'private',
    }))).toBeUndefined();
  });

  it('retries an explicit pre-dispatch auth rejection after reading the expected state', async () => {
    const terminal = { httpStatus: 200, receipt: { state: 'passed', action: 'run' } };
    const request = vi.fn().mockResolvedValueOnce(authDenied).mockResolvedValueOnce(idle).mockResolvedValueOnce(terminal);
    expect(await observeResearchAction(request, '/run', 'run', clock())).toEqual({
      ...terminal, authRejectionCount: 1, authRejections: [{ reason: 'authorization_mismatch', ...authDenied.diagnostic }],
    });
    expect(request.mock.calls).toEqual([['/run', 'POST', 115_000], ['/status', 'GET', 5000], ['/run', 'POST', 115_000]]);
  });

  it('bounds repeated authenticated Worker denials to three attempts', async () => {
    const request = vi.fn(async (_path, method) => method === 'GET' ? idle : authDenied);
    expect(await observeResearchAction(request, '/run', 'run', clock())).toMatchObject({ authRejectionCount: 3 });
    expect(request.mock.calls.map(([, method]) => method)).toEqual(['POST', 'GET', 'POST', 'GET', 'POST']);
  });

  it.each([401, 502])('never retries an unmarked or ordinary HTTP %s', async httpStatus => {
    const request = vi.fn().mockResolvedValueOnce({ httpStatus, receipt: authDenied.receipt }).mockResolvedValueOnce(idle);
    await observeResearchAction(request, '/run', 'run', clock());
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
  });

  it('stops retrying when a read sees a running action', async () => {
    const running = { httpStatus: 200, receipt: { state: 'running', action: 'run' }, diagnostic: getDiagnostic };
    const request = vi.fn().mockResolvedValueOnce(authDenied).mockResolvedValueOnce(running);
    expect(await observeResearchAction(request, '/run', 'run', clock())).toMatchObject({ authRetryStatus: { outcome: 'already_started' } });
    expect(request.mock.calls.map(([, method]) => method)).toEqual(['POST', 'GET']);
  });

  it('allows a rejected alarm action to retry after confirming the first container was destroyed', async () => {
    const previous = { httpStatus: 200, receipt: { state: 'passed', action: 'run', checks: { containerDestroyed: true } }, diagnostic: getDiagnostic };
    const terminal = { httpStatus: 200, receipt: { state: 'passed', action: 'arm-timeout' } };
    const request = vi.fn().mockResolvedValueOnce(authDenied).mockResolvedValueOnce(previous).mockResolvedValueOnce(terminal);
    expect(await observeResearchAction(request, '/arm-timeout', 'arm-timeout', clock())).toMatchObject({
      ...terminal, authRejectionCount: 1,
    });
    expect(request.mock.calls.map(([, method]) => method)).toEqual(['POST', 'GET', 'POST']);
  });
});
