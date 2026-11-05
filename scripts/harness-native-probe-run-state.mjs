import { setTimeout as wait } from 'node:timers/promises';

const retryableStatus = new Set([401, 408, 429, 500, 502, 503, 504]);
const completedStates = new Set(['passed', 'failed']);
/** @param {number} milliseconds */
const delay = milliseconds => wait(milliseconds);

export async function awaitIdleResearchWorker(request, { now = Date.now, pause = delay, timeoutMs = 60_000 } = {}) {
  const deadline = now() + timeoutMs;
  let httpStatus = null;
  while (now() < deadline) {
    const result = await request('/status', 'GET', Math.min(5000, deadline - now()));
    httpStatus = result.httpStatus;
    if (httpStatus === 200 && result.receipt?.state === 'idle') return { outcome: 'ready', httpStatus };
    if (httpStatus === 200 && ['running', ...completedStates].includes(result.receipt?.state)) {
      return { outcome: 'already_started', httpStatus, state: result.receipt.state };
    }
    if (httpStatus !== null && !retryableStatus.has(httpStatus)) return { outcome: 'status_unrecognized', httpStatus };
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(1000, remaining));
  }
  return { outcome: 'status_wait_expired', httpStatus };
}

export async function observeResearchAction(request, path, action, { now = Date.now, pause = delay, timeoutMs = 105_000 } = {}) {
  // This is the only POST. Observations may recover its result, never replay it.
  const first = await request(path, 'POST', 115_000);
  if (first.httpStatus !== null && first.httpStatus >= 400 && first.httpStatus < 500 &&
      first.httpStatus !== 408 && first.receipt?.action !== action) return first;
  let current = first;
  const deadline = now() + timeoutMs;
  while (true) {
    if (current.receipt?.action === action && completedStates.has(current.receipt.state)) return current;
    if (now() >= deadline) return { httpStatus: current.httpStatus, receipt: null, executionState: 'unknown' };
    await pause(Math.min(2000, deadline - now()));
    if (now() >= deadline) return { httpStatus: current.httpStatus, receipt: null, executionState: 'unknown' };
    current = await request('/status', 'GET', Math.min(5000, deadline - now()));
    if (current.httpStatus === 200 && current.receipt?.state === 'idle') {
      return { httpStatus: current.httpStatus, receipt: null, executionState: 'unknown' };
    }
  }
}
