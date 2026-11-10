import { setTimeout as wait } from 'node:timers/promises';

const retryableStatus = new Set([401, 408, 429, 500, 502, 503, 504]);
const completedStates = new Set(['passed', 'failed']);
const authErrors = new Set(['probe_unconfigured', 'authorization_missing', 'authorization_mismatch']);
/** @param {number} milliseconds */
const delay = milliseconds => wait(milliseconds);

export function researchResponseDiagnostic(headers) {
  const diagnostic = {};
  if (headers.get('x-pgc-native-probe-version') === 'auth-v1') diagnostic.version = 'auth-v1';
  const method = headers.get('x-pgc-native-probe-method');
  if (['GET', 'POST', 'other'].includes(method)) diagnostic.method = method;
  if (headers.get('x-pgc-native-probe-stage') === 'pre-dispatch-auth') diagnostic.stage = 'pre-dispatch-auth';
  const edge = headers.get('cf-ray')?.match(/^[a-f0-9]{16}-([A-Z]{3})$/)?.[1];
  if (edge) diagnostic.edge = edge;
  return Object.keys(diagnostic).length ? diagnostic : undefined;
}

export function awaitIdleResearchWorker(request, options) {
  return awaitResearchState(request, 'run', false, options);
}

async function awaitResearchState(request, action, markedOnly, { now = Date.now, pause = delay, timeoutMs = 60_000 } = {}) {
  const deadline = now() + timeoutMs;
  let status = { httpStatus: null };
  while (now() < deadline) {
    const result = await request('/status', 'GET', Math.min(5000, deadline - now()));
    const { httpStatus, diagnostic, receipt } = result;
    const authReason = httpStatus === 401 && diagnostic?.stage === 'pre-dispatch-auth' && authErrors.has(receipt?.error) ? receipt.error : undefined;
    status = { httpStatus, ...(diagnostic && { diagnostic }), ...(authReason && { authReason }) };
    if (httpStatus === 200) {
      if (markedOnly && (diagnostic?.version !== 'auth-v1' || diagnostic?.method !== 'GET')) return { outcome: 'status_unrecognized', ...status };
      const ready = action === 'run' ? receipt?.state === 'idle' : receipt?.action === 'run' &&
        completedStates.has(receipt.state) && receipt.checks?.containerDestroyed === true;
      if (ready) return { outcome: 'ready', ...status };
      if (['running', ...completedStates].includes(receipt?.state)) return { outcome: 'already_started', ...status, state: receipt.state };
    }
    if (httpStatus !== null && !retryableStatus.has(httpStatus)) return { outcome: 'status_unrecognized', ...status };
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(1000, remaining));
  }
  return { outcome: 'status_wait_expired', ...status };
}

export async function observeResearchAction(request, path, action, { now = Date.now, pause = delay, timeoutMs = 105_000 } = {}) {
  const authDeadline = now() + 60_000;
  const authRejections = [];
  const withRejections = result => authRejections.length ? { ...result, authRejectionCount: authRejections.length, authRejections } : result;
  let first;
  while (true) {
    first = await request(path, 'POST', 115_000);
    const { httpStatus, diagnostic, receipt } = first;
    if (httpStatus !== 401 || diagnostic?.version !== 'auth-v1' || diagnostic?.method !== 'POST' ||
        diagnostic?.stage !== 'pre-dispatch-auth' || !authErrors.has(receipt?.error)) break;
    authRejections.push({ reason: receipt.error, ...diagnostic });
    if (authRejections.length === 3 || now() >= authDeadline) return withRejections(first);
    await pause(Math.min(1000, authDeadline - now()));
    const status = await awaitResearchState(request, action, true, { now, pause, timeoutMs: authDeadline - now() });
    if (status.outcome !== 'ready' || now() >= authDeadline) return withRejections({ ...first, authRetryStatus: status });
  }
  // Once any submission might have reached the Durable Object, only read status.
  if (first.httpStatus !== null && first.httpStatus >= 400 && first.httpStatus < 500 && first.httpStatus !== 408 &&
      first.receipt?.action !== action) return withRejections(first);
  let current = first;
  const deadline = now() + timeoutMs;
  while (true) {
    if (current.receipt?.action === action && completedStates.has(current.receipt.state)) return withRejections(current);
    if (now() >= deadline) return withRejections({ ...current, receipt: null, executionState: 'unknown' });
    await pause(Math.min(2000, deadline - now()));
    if (now() >= deadline) return withRejections({ ...current, receipt: null, executionState: 'unknown' });
    current = await request('/status', 'GET', Math.min(5000, deadline - now()));
    if (current.httpStatus === 200 && current.receipt?.state === 'idle') {
      return withRejections({ ...current, receipt: null, executionState: 'unknown' });
    }
  }
}
