/** Read-only Creator Hub integration. Never exposes credentials or file locations. */
const API = 'https://creator-hub-7mi.pages.dev/api/integrations/feedback/v1';
export type FeedbackScalar = string | number | boolean | null;
export interface FeedbackContract {
  version: number; scopeRevision: number; dataset: string; authorScope: string | string[];
  fileVersionCount: number; idNamespace: string; historySince: string | null;
  privacy?: string; historyGaps?: string[]; states?: string[]; archiveAndDeleteAreSeparateFlags?: boolean;
  snapshotIdempotency?: string; cursorRetention?: string; endpoints?: string[]; freeText?: string; pollingSeconds: number; snapshotsExpireHours: number;
  pagination: { defaultLimit: number; maxLimit: number }; rateLimit: { requestsPerMinute: number };
  maxActiveSnapshots?: number;
}
export interface FeedbackSnapshot { id: string; watermark: number; cursor: string; expiresAt: string }
export interface FeedbackScore { name: string; description: string; max: number | null; score: number | null }
export interface FeedbackReview {
  id: string; versionId: string; stage: string; revision: number; eventSequence: number | null;
  reviewerId: string | null; reviewerRole: string | null; scores: FeedbackScore[]; total: number | null;
  decision: string | null; feedback: string; createdAt: string; recordedAt: string | null;
  scored: boolean; historicalBaseline: boolean; deleted: boolean; reopened: boolean; revoked: boolean; effective: boolean;
}
export interface FeedbackVersion {
  id: string; revision: number; title: string; description: string; submittedAt: string; updateNote: string | null;
  withdrawn: boolean; ruleVersion: string | number | null; status: string | null; statusSource: string | null;
  finalReviewId: string | null; files: Partial<Record<'zip' | 'html', { bytes: number | null }>>; fileAccess: boolean;
}
export interface FeedbackComment {
  id: string; workId?: string; versionId: null; authorId: string | null; authorRole?: string | null; body?: string; content?: string; text?: string;
  createdAt: string; editedAt: string | null; deleted?: boolean; revision?: number; eventSequence?: number | null;
}
export interface FeedbackGame {
  id: string; authorId: string; title: string; description: string; status: string; revision: number;
  createdAt: string; updatedAt: string; archived: boolean; deleted: boolean;
  versions: FeedbackVersion[]; reviews: FeedbackReview[]; comments: FeedbackComment[];
  textRedacted: boolean; idNamespace: string;
}
export interface FeedbackGamesPage { snapshot: string; games: FeedbackGame[]; nextAfter: string | null; cursor: string }
export interface FeedbackChange {
  id: number; kind: string; operation: string; entityId: string | null; workId: string | null;
  createdAt: string; game: FeedbackGame | null;
}
export interface FeedbackChangePage { events: FeedbackChange[]; cursor: string; hasMore: boolean; representation: string }
export interface FeedbackRules { rules: { id: string | number; effectiveAt: string; body: { direction: string; criteria: { name: string; description: string; max: number | null }[]; passThreshold: number | null }; sha256: string }[]; historicalCoverage: string | null }
export interface FeedbackIdentity { id: string; workId: string; idNamespace: string }

const messages: Record<string, string> = {
  invalid_input: 'Invalid feedback request.', invalid_response: 'Invalid feedback provider response.',
  response_too_large: 'Feedback provider response exceeds size limit.', timeout: 'Feedback provider request timed out.',
  transport: 'Feedback provider connection failed.', http_error: 'Feedback provider request failed.',
};
export class FeedbackProviderError extends Error {
  readonly status: number; readonly retryAfterSeconds: number | null; readonly code: string;
  constructor(code: string, status = 0, retryAfterSeconds: number | null = null) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'transport';
    super(messages[safeCode]); this.name = 'FeedbackProviderError';
    this.code = safeCode; this.status = status; this.retryAfterSeconds = retryAfterSeconds;
  }
}
function invalid(): never { throw new FeedbackProviderError('invalid_response'); }
function input(): never { throw new FeedbackProviderError('invalid_input'); }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) invalid(); return v as Record<string, unknown>; }
function string(v: unknown): string { if (typeof v !== 'string') invalid(); return v; }
function nullableString(v: unknown): string | null { return v === null ? null : string(v); }
function number(v: unknown): number { if (typeof v !== 'number' || !Number.isFinite(v)) invalid(); return v; }
function integer(v: unknown): number { const n = number(v); if (!Number.isSafeInteger(n) || n < 0) invalid(); return n; }
function ruleId(v: unknown): string | number { return typeof v==='number'?integer(v):string(v); }
function nullableNumber(v: unknown): number | null { return v === null ? null : number(v); }
function bool(v: unknown): boolean { if (typeof v !== 'boolean') invalid(); return v; }
function array<T>(v: unknown, parse: (item: unknown) => T): T[] { if (!Array.isArray(v)) invalid(); return v.map(parse); }
function id(v: unknown, prefix: string): string { const s = string(v); if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(s) || s.length > 240) invalid(); return s; }
function namespace(v: unknown): string { const s = string(v); if (s !== 'integration_pseudonym') invalid(); return s; }
export function parseFeedbackCursor(value: string): { scopeRevision: number; sequence: number } {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(value)) input();
  const [scopeRevision, sequence] = value.split(':').map(Number);
  if (!Number.isSafeInteger(scopeRevision) || !Number.isSafeInteger(sequence)) input();
  return { scopeRevision, sequence };
}
function cursor(v: unknown): string { const s = string(v); try { parseFeedbackCursor(s); } catch { invalid(); } return s; }
function review(v: unknown): FeedbackReview {
  const r = object(v);
  return { id: id(r.id, 'review'), versionId: id(r.versionId, 'version'), stage: string(r.stage), revision: integer(r.revision),
    eventSequence: r.eventSequence === null ? null : integer(r.eventSequence), reviewerId: nullableString(r.reviewerId), reviewerRole: nullableString(r.reviewerRole),
    scores: array(r.scores, value => { const s = object(value); return { name: string(s.name), description: string(s.description), max: nullableNumber(s.max), score: nullableNumber(s.score) }; }),
    total: nullableNumber(r.total), decision: nullableString(r.decision), feedback: string(r.feedback), createdAt: string(r.createdAt), recordedAt: nullableString(r.recordedAt),
    scored: bool(r.scored), historicalBaseline: bool(r.historicalBaseline), deleted: bool(r.deleted), reopened: bool(r.reopened), revoked: bool(r.revoked), effective: bool(r.effective) };
}
function version(v: unknown): FeedbackVersion {
  const r = object(v), rawFiles = object(r.files), files: Partial<Record<'zip' | 'html', { bytes: number | null }>> = {};
  // File retrieval is deliberately excluded; never retain URLs, storage keys, or metadata paths.
  for (const key of ['zip', 'html'] as const) if (Object.hasOwn(rawFiles, key)) { const f = object(rawFiles[key]); files[key] = { bytes: f.bytes === null ? null : integer(f.bytes) }; }
  return { id: id(r.id, 'version'), revision: integer(r.revision), title: string(r.title), description: string(r.description), submittedAt: string(r.submittedAt), updateNote: nullableString(r.updateNote),
    withdrawn: bool(r.withdrawn), ruleVersion: r.ruleVersion===null?null:ruleId(r.ruleVersion), status: nullableString(r.status), statusSource: nullableString(r.statusSource),
    finalReviewId: r.finalReviewId === null ? null : id(r.finalReviewId, 'review'), files, fileAccess: bool(r.fileAccess) };
}
function comment(v: unknown): FeedbackComment {
  const r = object(v); if (r.versionId !== null) invalid();
  const result: FeedbackComment = { id: id(r.id, 'comment'), versionId: null, authorId: nullableString(r.authorId), createdAt: string(r.createdAt), editedAt: nullableString(r.editedAt) };
  if (Object.hasOwn(r, 'workId')) result.workId = id(r.workId, 'game');
  if (Object.hasOwn(r, 'deleted')) result.deleted = bool(r.deleted);
  if (Object.hasOwn(r, 'authorRole')) result.authorRole = nullableString(r.authorRole);
  if (Object.hasOwn(r, 'text')) result.text = string(r.text);
  if (Object.hasOwn(r, 'body')) result.body = string(r.body);
  if (Object.hasOwn(r, 'content')) result.content = string(r.content);
  if (Object.hasOwn(r, 'revision')) result.revision = integer(r.revision);
  if (Object.hasOwn(r, 'eventSequence')) result.eventSequence = r.eventSequence === null ? null : integer(r.eventSequence);
  return result;
}
function game(v: unknown): FeedbackGame {
  const r = object(v);
  return { id: id(r.id, 'game'), authorId: string(r.authorId), title: string(r.title), description: string(r.description), status: string(r.status), revision: integer(r.revision),
    createdAt: string(r.createdAt), updatedAt: string(r.updatedAt), archived: bool(r.archived), deleted: bool(r.deleted),
    versions: array(r.versions, version), reviews: array(r.reviews, review), comments: array(r.comments, comment), textRedacted: bool(r.textRedacted), idNamespace: namespace(r.idNamespace) };
}
function contract(v: unknown): FeedbackContract {
  const r = object(v), p = object(r.pagination), l = object(r.rateLimit);
  if (r.version !== 1 || r.dataset !== 'ordinary_games') invalid();
  const c: FeedbackContract = { version: 1, scopeRevision: integer(r.scopeRevision), dataset: string(r.dataset), authorScope: Array.isArray(r.authorScope) ? array(r.authorScope, string) : string(r.authorScope),
    fileVersionCount: integer(r.fileVersionCount), idNamespace: namespace(r.idNamespace), historySince: nullableString(r.historySince), pollingSeconds: integer(r.pollingSeconds), snapshotsExpireHours: integer(r.snapshotsExpireHours),
    pagination: { defaultLimit: integer(p.defaultLimit), maxLimit: integer(p.maxLimit) }, rateLimit: { requestsPerMinute: integer(l.requestsPerMinute) } };
  if (Array.isArray(r.historyGaps) && r.historyGaps.every(s => typeof s === 'string')) c.historyGaps = array(r.historyGaps, string);
  if (Object.hasOwn(r, 'states')) c.states = array(r.states, string);
  if (Object.hasOwn(r, 'archiveAndDeleteAreSeparateFlags')) c.archiveAndDeleteAreSeparateFlags = bool(r.archiveAndDeleteAreSeparateFlags);
  for (const key of ['privacy', 'snapshotIdempotency', 'cursorRetention', 'freeText'] as const) if (Object.hasOwn(r, key)) c[key] = string(r[key]);
  if (Object.hasOwn(r, 'endpoints')) c.endpoints = array(r.endpoints, string);
  if (Object.hasOwn(r, 'maxActiveSnapshots')) c.maxActiveSnapshots = integer(r.maxActiveSnapshots);
  return c;
}
function ruleBody(v: unknown): FeedbackRules['rules'][number]['body'] {
  const r = object(v);
  return { direction: string(r.direction), criteria: array(r.criteria, v => { const c = object(v); return { name: string(c.name), description: string(c.description), max: nullableNumber(c.max) }; }), passThreshold: nullableNumber(r.passThreshold) };
}
function pathId(v: string): string { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,240}$/.test(v)) input(); return encodeURIComponent(v); }
function limitValue(v: number): string { if (!Number.isSafeInteger(v) || v < 1 || v > 50) input(); return String(v); }
function uuid(v: string): string { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) input(); return v; }

export class CreatorFeedbackClient {
  #token: string; #fetcher: typeof fetch; #timeoutMs: number; #maxBytes: number;
  constructor(token: string, options: { fetcher?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}) {
    if (typeof token !== 'string' || !token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) input();
    // Do not call workerd's native fetch with this client as its receiver.
    this.#token = token; this.#fetcher = options.fetcher ?? ((input,init)=>fetch(input,init));
    this.#timeoutMs = options.timeoutMs ?? 30_000; this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || !Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) input();
  }
  async #request<T>(path: string, parse: (value: unknown) => T, key?: string): Promise<T> {
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let expired = false;
    const cancel = () => { controller.abort(); if (reader) void reader.cancel().catch(() => {}); };
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; cancel(); reject(new FeedbackProviderError('timeout')); }, this.#timeoutMs); });
    const operation = async () => {
      const response = await this.#fetcher(`${API}${path}`, {
        method: key ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
        // workerd supports manual/follow only. Never follow a redirect carrying
        // this bearer; reject every 3xx below. This server-only client has no
        // cookie jar and never forwards incoming headers or browser credentials.
        redirect: 'manual', cache: 'no-store', signal: controller.signal,
      });
      if (expired) { void response.body?.cancel().catch(() => {}); throw new FeedbackProviderError('timeout'); }
      if (response.url && (!response.url.startsWith(`${API}/`) || new URL(response.url).origin !== new URL(API).origin)) { void response.body?.cancel().catch(() => {}); invalid(); }
      if (response.redirected || (response.status >= 300 && response.status < 400)) { void response.body?.cancel().catch(() => {}); invalid(); }
      if (!response.ok) {
        const header = response.headers.get('Retry-After'); let retryAfterSeconds: number | null = null;
        if (header && /^\d+$/.test(header) && Number.isSafeInteger(Number(header))) retryAfterSeconds = Number(header);
        else if (header && Number.isFinite(Date.parse(header))) retryAfterSeconds = Math.max(0, Math.ceil((Date.parse(header) - Date.now()) / 1000));
        void response.body?.cancel().catch(() => {});
        throw new FeedbackProviderError('http_error', response.status, retryAfterSeconds);
      }
      const length = response.headers.get('content-length');
      if (length && /^\d+$/.test(length) && Number(length) > this.#maxBytes) { void response.body?.cancel().catch(() => {}); throw new FeedbackProviderError('response_too_large'); }
      if (!response.body) invalid(); reader = response.body.getReader();
      let bytes = 0; const chunks: Uint8Array[] = [];
      while (true) {
        const item = await reader.read(); if (expired) throw new FeedbackProviderError('timeout'); if (item.done) break;
        bytes += item.value.byteLength; if (bytes > this.#maxBytes) { cancel(); throw new FeedbackProviderError('response_too_large'); } chunks.push(item.value);
      }
      const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); } catch { invalid(); }
      return parse(value);
    };
    try { return await Promise.race([operation(), timeout]); }
    catch (error) { cancel(); throw error instanceof FeedbackProviderError ? error : new FeedbackProviderError('transport'); }
    finally { clearTimeout(timer!); }
  }
  contract(): Promise<FeedbackContract> { return this.#request('/contract', contract); }
  snapshot(idempotencyKey: string): Promise<FeedbackSnapshot> {
    const key = uuid(idempotencyKey);
    return this.#request('/snapshots', v => { const r = object(v); return { id: uuid(string(r.id)), watermark: integer(r.watermark), cursor: cursor(r.cursor), expiresAt: string(r.expiresAt) }; }, key);
  }
  games(snapshotId: string, after: string | null, limit = 20): Promise<FeedbackGamesPage> {
    const params = new URLSearchParams({ snapshot: uuid(snapshotId), limit: limitValue(limit) }); if (after !== null) params.set('after', pathId(after));
    return this.#request(`/games?${params}`, v => { const r = object(v); return { snapshot: uuid(string(r.snapshot)), games: array(r.games, game), nextAfter: r.nextAfter === null ? null : id(r.nextAfter, 'game'), cursor: cursor(r.cursor) }; });
  }
  changes(after: string, limit = 20): Promise<FeedbackChangePage> {
    parseFeedbackCursor(after); const params = new URLSearchParams({ cursor: after, limit: limitValue(limit) });
    return this.#request(`/changes?${params}`, v => { const r = object(v); return { events: array(r.events, v => { const e = object(v); return { id: integer(e.id), kind: string(e.kind), operation: string(e.operation), entityId: nullableString(e.entityId), workId: e.workId === null ? null : id(e.workId, 'game'), createdAt: string(e.createdAt), game: e.game === null ? null : game(e.game) }; }), cursor: cursor(r.cursor), hasMore: bool(r.hasMore), representation: string(r.representation) }; });
  }
  rules(): Promise<FeedbackRules> { return this.#request('/rules', v => { const r = object(v); return { rules: array(r.rules, v => { const s = object(v); return { id: ruleId(s.id), effectiveAt: string(s.effectiveAt), body: ruleBody(s.body), sha256: string(s.sha256) }; }), historicalCoverage: nullableString(r.historicalCoverage) }; }); }
  identity(knownSubmissionId: string): Promise<FeedbackIdentity> { return this.#request(`/versions/${pathId(knownSubmissionId)}/identity`, v => { const r = object(v); return { id: id(r.id, 'version'), workId: id(r.workId, 'game'), idNamespace: namespace(r.idNamespace) }; }); }
  game(workId: string): Promise<FeedbackGame> {
    return this.#request(`/games/${pathId(workId)}`, v => {
      const r=object(v);
      // The live v1 detail response has one known envelope. Do not merge
      // conflicting outer/inner entities or preserve arbitrary wrapper fields.
      if(Object.hasOwn(r,'game')){if(Object.hasOwn(r,'id'))invalid();return game(r.game);}
      return game(r);
    });
  }
}
