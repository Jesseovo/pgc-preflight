import puppeteer from '@cloudflare/puppeteer';
import { closeCaptureBrowser } from '../server/cloud-review-capture';

type BrowserBinding = Parameters<typeof puppeteer.acquire>[0] & {
  closeSession(id: string): Promise<unknown>;
  getSession(id: string): Promise<unknown>;
};
type Store = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(time: number): Promise<void>;
};
type Storage = Store & { transaction<T>(callback: (tx: Store) => Promise<T>): Promise<T> };
type Env = { BROWSER: BrowserBinding };
type WorkerEnv = Env & {
  HARNESS_RESEARCH_TOKEN: string;
  BROWSER_CLOSE_PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
};
type SessionState = 'active' | 'ended-number' | 'absent' | 'invalid' | 'unknown';
type SessionLookupError = { name: 'Error' | 'TypeError' | 'DOMException' | 'NotFoundError' | 'other'; status: number | null; notFound: boolean };
type Probe = {
  startedAt: number; browserId?: string;
  acquireStarted: boolean;
  before: SessionState; after: SessionState; closeStatus: 'closing' | 'closed' | 'unknown';
  connected: boolean | null; cleanupConfirmed: boolean; cleanupAttempts: number;
  recheckAuthorized?: true; getSessionError?: SessionLookupError;
};

const key = 'browser-close-probe';
const deadlineMs = 45_000;
const retryMs = 5_000;
const maxCleanupAttempts = 6;
const maxRecheckedAttempts = 8;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const opaqueToken = /^[a-f0-9]{64}$/;
function authorized(value: string | null, token: string) {
  if (!opaqueToken.test(token) || !value || value.length !== token.length + 7) return false;
  const expected = `Bearer ${token}`;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}
function classifySession(value: unknown, id: string): SessionState {
  if (value === null) return 'absent';
  if (typeof value !== 'object' || !value || !('sessionId' in value) || value.sessionId !== id) return 'invalid';
  if (!('endTime' in value) || value.endTime === null || value.endTime === undefined || value.endTime === 0) return 'active';
  return typeof value.endTime === 'number' && Number.isFinite(value.endTime) && value.endTime > 0 ? 'ended-number' : 'invalid';
}
function classifyClose(value: unknown): Probe['closeStatus'] {
  const status = typeof value === 'object' && value && 'status' in value ? value.status : value;
  return status === 'closing' || status === 'closed' ? status : 'unknown';
}
function lookupError(error: unknown): SessionLookupError {
  const detail = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const name = detail.name === 'Error' || detail.name === 'TypeError' || detail.name === 'DOMException' || detail.name === 'NotFoundError' ? detail.name : 'other';
  const message = typeof detail.message === 'string' ? detail.message : typeof error === 'string' ? error : '';
  const rawStatus = detail.status ?? detail.statusCode ?? /\b(?:HTTP(?:\s+status)?|status(?:\s+code)?|code)[:\s]+([45]\d\d)\b/i.exec(message)?.[1];
  const status = typeof rawStatus === 'number' || typeof rawStatus === 'string' && /^[45]\d\d$/.test(rawStatus) ? Number(rawStatus) : null;
  const validStatus = status !== null && Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
  const notFound = validStatus === 404 || validStatus === null && /\b(?:session (?:[a-z0-9_-]+ )?not found|404\s+not found)\b/i.test(message);
  return { name, status: validStatus, notFound };
}
function receipt(probe: Probe | undefined) {
  if (!probe) return { state: 'not-run', releaseReady: false };
  const { startedAt, acquireStarted, before, after, closeStatus, connected, cleanupConfirmed, cleanupAttempts, recheckAuthorized, getSessionError } = probe;
  const passed = connected === true && before === 'active' && closeStatus !== 'unknown' && cleanupConfirmed;
  const waiting = !cleanupConfirmed && (recheckAuthorized && cleanupAttempts < maxRecheckedAttempts ||
    Date.now() < startedAt + deadlineMs && (connected === null || connected === true && cleanupAttempts < maxCleanupAttempts));
  const state = passed ? 'passed' : waiting ? 'running' : 'failed';
  return { state, startedAt, acquireStarted, acquired: Boolean(probe.browserId), before, after, closeStatus, connected, cleanupConfirmed, cleanupAttempts,
    recheckAuthorized: Boolean(recheckAuthorized), getSessionError: getSessionError ?? null, releaseReady: false };
}

async function emptyBody(request: Request) {
  if (!request.body) return true;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([reader.read().then(result => result.done === true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 250); })]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv) {
    if (!authorized(request.headers.get('Authorization'), env.HARNESS_RESEARCH_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const url = new URL(request.url);
    const valid = url.pathname === '/status' && request.method === 'GET' || ['/run', '/recheck'].includes(url.pathname) && request.method === 'POST';
    if (!valid || url.search || !await emptyBody(request)) return json({ error: 'route_denied' }, 404);
    const binding = env.BROWSER_CLOSE_PROBE;
    return binding.get(binding.idFromName('single-browser')).fetch(new Request(`https://browser-close-probe.invalid${url.pathname}`, { method: request.method }));
  },
};

export class BrowserCloseProbe {
  private cleanup?: Promise<void>;
  constructor(private ctx: { storage: Storage }, private env: Env) {}

  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/status' && request.method === 'GET') return json(receipt(await this.ctx.storage.get<Probe>(key)));
    if (path === '/recheck' && request.method === 'POST') return this.recheck();
    if (path !== '/run' || request.method !== 'POST') return json({ error: 'route_denied' }, 404);
    const startedAt = Date.now();
    const admitted = await this.ctx.storage.transaction(async tx => {
      if (await tx.get<Probe>(key)) return false;
      await tx.put<Probe>(key, { startedAt, acquireStarted: false, before: 'unknown', after: 'unknown', closeStatus: 'unknown', connected: null, cleanupConfirmed: false, cleanupAttempts: 0 });
      await tx.setAlarm(startedAt + deadlineMs);
      return true;
    });
    if (!admitted) return json(receipt(await this.ctx.storage.get<Probe>(key)), 409);

    const binding = this.env.BROWSER;
    try {
      if (typeof binding.closeSession !== 'function' || typeof binding.getSession !== 'function') throw new Error('binding_unavailable');
      await this.update({ acquireStarted: true });
      const allocated = await puppeteer.acquire(binding, { keep_alive: 30_000, recording: false, guardrails: { allowedDomains: [] } });
      if (typeof allocated?.sessionId !== 'string' || !allocated.sessionId) throw new Error('missing_session_id');
      const id = allocated.sessionId;
      await this.update({ browserId: id });
      if (Date.now() >= startedAt + deadlineMs) throw new Error('probe_expired');
      const before = classifySession(await this.lookup(id), id);
      await this.update({ before });
      if (before !== 'active' || Date.now() >= startedAt + deadlineMs) throw new Error('active_session_unconfirmed');
      const browser = await puppeteer.connect(binding, id);
      try { await browser.version(); }
      finally { await browser.disconnect(); }
      await this.update({ connected: Date.now() < startedAt + deadlineMs });
    } catch {
      await this.update({ connected: false });
    } finally {
      await this.retire();
    }
    return json(receipt(await this.ctx.storage.get<Probe>(key)));
  }

  async alarm() { await this.retire(); }

  private async recheck() {
    const decision = await this.ctx.storage.transaction(async tx => {
      const record = await tx.get<Probe>(key);
      if (!record?.browserId) return 'missing';
      if (record.recheckAuthorized || record.cleanupConfirmed) return 'existing';
      if (record.cleanupAttempts < maxCleanupAttempts) return 'running';
      await tx.put<Probe>(key, { ...record, recheckAuthorized: true });
      await tx.setAlarm(Date.now() + retryMs);
      return 'admitted';
    });
    if (decision === 'missing') return json({ error: 'original_session_unavailable' }, 409);
    if (decision === 'running') return json({ error: 'original_cleanup_pending' }, 409);
    if (decision === 'admitted') await this.retire();
    return json(receipt(await this.ctx.storage.get<Probe>(key)));
  }

  private async lookup(id: string) {
    try { return await this.env.BROWSER.getSession(id); }
    catch (error) {
      const diagnosis = lookupError(error);
      await this.update({ getSessionError: diagnosis });
      if (diagnosis.notFound) return null;
      throw new Error('session_lookup_unconfirmed');
    }
  }

  private async update(patch: Partial<Probe>) {
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<Probe>(key);
      if (current) await tx.put<Probe>(key, { ...current, ...patch });
    });
  }

  private retire() {
    return this.cleanup ??= this.closeOriginal().finally(() => { this.cleanup = undefined; });
  }

  private async closeOriginal() {
    const id = await this.ctx.storage.transaction(async tx => {
      const record = await tx.get<Probe>(key);
      const cap = record?.recheckAuthorized ? maxRecheckedAttempts : maxCleanupAttempts;
      if (!record?.browserId || record.cleanupConfirmed || record.cleanupAttempts >= cap) return;
      await tx.put<Probe>(key, { ...record, cleanupAttempts: record.cleanupAttempts + 1 });
      await tx.setAlarm(Date.now() + retryMs);
      return record.browserId;
    });
    if (!id) return;
    const binding = this.env.BROWSER;
    try {
      const observed = {
        closeSession: async (requestedId: string) => {
          if (requestedId !== id) throw new Error('session_mismatch');
          const value = await binding.closeSession(id);
          const closeStatus = classifyClose(value);
          if (closeStatus !== 'unknown') await this.update({ closeStatus });
          return value;
        },
        getSession: async (requestedId: string) => {
          if (requestedId !== id) throw new Error('session_mismatch');
          return this.lookup(id);
        },
      };
      await closeCaptureBrowser(observed as unknown as Parameters<typeof closeCaptureBrowser>[0], id);
      const after = classifySession(await this.lookup(id), id);
      await this.update({ after, cleanupConfirmed: after === 'ended-number' || after === 'absent' });
    } catch {
      // An uncertain observation keeps the exact ID for the next alarm.
    }
  }
}
