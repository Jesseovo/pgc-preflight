import { describe, expect, it, vi } from 'vitest';
import { CreatorFeedbackClient, FeedbackProviderError, parseFeedbackCursor } from '../server/creator-feedback-client';

const snapshotId = '11111111-1111-4111-8111-111111111111';
const contract = { version: 1, scopeRevision: 3, dataset: 'ordinary_games', authorScope: 'all', fileVersionCount: 0, idNamespace: 'integration_pseudonym', historySince: '2026-11-03', historyGaps: ['older revisions unavailable'], pollingSeconds: 120, snapshotsExpireHours: 24, pagination: { defaultLimit: 20, maxLimit: 50 }, rateLimit: { requestsPerMinute: 120 } };
function syntheticGame() {
  return { id: 'game_synthetic', authorId: 'author_synthetic', title: 'Synthetic', description: '', status: 'approved', revision: 2, createdAt: 'historical unknown zone', updatedAt: '2026-11-03', archived: true, deleted: false, textRedacted: true, idNamespace: 'integration_pseudonym',
    versions: [{ id: 'version_synthetic', revision: 1, title: 'Synthetic', description: '', submittedAt: '2026-10-01', updateNote: '', withdrawn: false, ruleVersion: null, status: null, statusSource: null, finalReviewId: null, files: { zip: { bytes: 31, url: 'https://private.invalid/x' }, html: { bytes: null }, token: 'synthetic-secret' }, fileAccess: false }],
    reviews: [{ id: 'review_synthetic', versionId: 'version_synthetic', stage: 'decision_review', revision: 1, eventSequence: null, reviewerId: 'reviewer_synthetic', reviewerRole: null, scores: [{ name: '美学', description: '', max: 3, score: 0 }, { name: '易玩性', description: '', max: 3, score: null }], total: null, decision: null, feedback: '', createdAt: 'legacy timestamp', recordedAt: null, scored: true, historicalBaseline: true, deleted: false, reopened: false, revoked: false, effective: true }],
    comments: [{ id: 'comment_synthetic', versionId: null, authorId: 'author_synthetic', content: '', createdAt: '2026-11-01', editedAt: null, deleted: false }] };
}
function response(value: unknown, init?: ResponseInit) { return new Response(JSON.stringify(value), init); }
function clientWith(value: unknown) { const fetcher = vi.fn<typeof fetch>(async () => response(value)); return { client: new CreatorFeedbackClient('synthetic-token', { fetcher }), fetcher }; }

describe('CreatorFeedbackClient', () => {
  it('uses only fixed origin with no redirects, browser credentials or token in URL', async () => {
    const { client, fetcher } = clientWith(contract); expect(await client.contract()).toEqual(contract);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://creator-hub-7mi.pages.dev/api/integrations/feedback/v1/contract');
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store', method: 'GET', headers: { Authorization: 'Bearer synthetic-token' } });
    expect(JSON.stringify(client)).not.toContain('synthetic-token');
  });
  it('preserves explicit zero, null, empty strings, legacy times and stage without inventing a final decision', async () => {
    const raw = syntheticGame(); const { client } = clientWith(raw); const game = await client.game(raw.id);
    expect(game.reviews[0]).toEqual(raw.reviews[0]); expect(game.versions[0].status).toBeNull();
    expect(game.createdAt).toBe('historical unknown zone'); expect(game.archived).toBe(true); expect(game.deleted).toBe(false);
    expect(game.reviews[0].decision).toBeNull();
  });
  it('allowlists all nested game entities, stripping credentials and storage references', async () => {
    const raw = syntheticGame(); const polluted = { ...raw, token: 'synthetic-secret', account: 'private', versions: raw.versions.map(v => ({ ...v, storageKey: 'private' })), reviews: raw.reviews.map(r => ({ ...r, email: 'private', scores: r.scores.map(s => ({ ...s, token: 'synthetic-secret' })) })), comments: raw.comments.map(c => ({ ...c, user: { token: 'synthetic-secret' } })) };
    const { client } = clientWith(polluted); const game = await client.game(raw.id);
    expect(game.versions[0].files).toEqual({ zip: { bytes: 31 }, html: { bytes: null } });
    const json = JSON.stringify(game); for (const banned of ['synthetic-secret', 'private', 'storageKey', 'email', 'token']) expect(json).not.toContain(banned);
  });
  it('keeps empty score arrays distinct from a scored zero and never repairs inconsistent totals', async () => {
    const raw = syntheticGame(); raw.reviews[0].scores = []; raw.reviews[0].scored = false;
    const result = await clientWith(raw).client.game(raw.id); expect(result.reviews[0].scores).toEqual([]); expect(result.reviews[0].total).toBeNull();
    const altered = { ...raw, reviews: [{ ...raw.reviews[0], total: 2, scores: [{ name: '美学', description: '', max: 3, score: 0 }] }] };
    expect((await clientWith(altered).client.game(raw.id)).reviews[0].total).toBe(2);
  });
  it('preserves null update notes separately from an intentionally empty note', async () => {
    const raw = syntheticGame();
    expect((await clientWith({...raw,versions:[{...raw.versions[0],updateNote:null}]}).client.game(raw.id)).versions[0].updateNote).toBeNull();
    expect((await clientWith(raw).client.game(raw.id)).versions[0].updateNote).toBe('');
  });
  it('does not invent a deletion flag for work-level comments that omit it', async () => {
    const raw=syntheticGame();
    const comment={id:'comment_synthetic',workId:raw.id,versionId:null,authorId:'author_synthetic',authorRole:null,body:'Synthetic comment',createdAt:'legacy timestamp',editedAt:null};
    expect((await clientWith({...raw,comments:[comment]}).client.game(raw.id)).comments).toEqual([comment]);
  });
  it('reads the single game detail envelope and rejects conflicting outer entities', async () => {
    const raw=syntheticGame(),expected=await clientWith(raw).client.game(raw.id);
    expect(await clientWith({game:raw,token:'synthetic-private'}).client.game(raw.id)).toEqual(expected);
    await expect(clientWith({game:raw,id:'game_other'}).client.game(raw.id)).rejects.toMatchObject({code:'invalid_response'});
  });
  it('preserves numeric rule identities and their version references without converting them to strings', async () => {
    const raw=syntheticGame();
    expect((await clientWith({...raw,versions:[{...raw.versions[0],ruleVersion:1}]}).client.game(raw.id)).versions[0].ruleVersion).toBe(1);
    const rules={rules:[{id:1,effectiveAt:'now',body:{direction:'Synthetic',criteria:[],passThreshold:7},sha256:'a'.repeat(64)}],historicalCoverage:'unknown'};
    expect(await clientWith(rules).client.rules()).toEqual(rules);
  });
  it('sends snapshot idempotency once and preserves snapshot boundary', async () => {
    const value = { id: snapshotId, watermark: 3060, cursor: '3:3060', expiresAt: '2026-11-04T00:00:00Z' };
    const { client, fetcher } = clientWith(value); expect(await client.snapshot(snapshotId)).toEqual(value);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'Idempotency-Key': snapshotId } });
  });
  it('uses stable snapshot paging and does not derive cursors from returned event IDs', async () => {
    const page = { snapshot: snapshotId, games: [], nextAfter: 'game_next', cursor: '3:3060' };
    const { client, fetcher } = clientWith(page); expect(await client.games(snapshotId, 'game_prior', 20)).toEqual(page);
    expect(String(fetcher.mock.calls[0][0])).toContain(`snapshot=${snapshotId}&limit=20&after=game_prior`);
    const change = { events: [{ id: 3040, kind: 'rule', operation: 'updated', entityId: 'rule_1', workId: null, game: null, createdAt: '2026-11-03' }], cursor: '3:3060', hasMore: false, representation: 'current' };
    expect(await clientWith(change).client.changes('3:3030')).toEqual(change);
    expect(await clientWith({ ...change, events: [], cursor: '3:3090' }).client.changes('3:3060')).toMatchObject({ events: [], cursor: '3:3090' });
  });
  it('preserves safe contract metadata and author allowlists while omitting unexpected keys', async () => {
    const metadata = { ...contract, authorScope: ['author_synthetic'], privacy: 'redacted', states: ['draft', 'approved'], archiveAndDeleteAreSeparateFlags: true, snapshotIdempotency: 'UUID required', cursorRetention: 'retained', endpoints: ['GET /contract'], freeText: 'review required', maxActiveSnapshots: 4 };
    expect(await clientWith({ ...metadata, token: 'synthetic-secret', account: { password: 'synthetic-secret' } }).client.contract()).toEqual(metadata);
  });
  it('keeps rules history as supplied without deriving applicability or leaking extra fields', async () => {
    const rules = { rules: [{ id: 'rule_synthetic', effectiveAt: '2026-11-03', body: { direction: 'Synthetic direction', criteria: [{ name: '美学', description: '', max: 3 }], passThreshold: 7 }, sha256: 'a'.repeat(64) }], historicalCoverage: 'earlier history unknown' };
    const polluted = { ...rules, token: 'synthetic-secret', rules: rules.rules.map(rule => ({ ...rule, body: { ...rule.body, storageURL: 'https://private.invalid', token: 'synthetic-secret' } })) };
    expect(await clientWith(polluted).client.rules()).toEqual(rules);
  });
  it('identity returns precise anonymous IDs and rejects traversal input before fetching', async () => {
    const value = { id: 'version_synthetic', workId: 'game_synthetic', idNamespace: 'integration_pseudonym', token: 'synthetic-secret' };
    const { client, fetcher } = clientWith(value); expect(await client.identity(snapshotId)).toEqual({ id: 'version_synthetic', workId: 'game_synthetic', idNamespace: 'integration_pseudonym' });
    for (const bad of ['https://bad.invalid', '../files/html', 'a?token=x', 'a/b', '%2e%2e']) expect(() => client.game(bad)).toThrow(FeedbackProviderError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed shapes without returning partial data or repairing fields', async () => {
    const raw = syntheticGame();
    for (const bad of [{ ...raw, reviews: [{ ...raw.reviews[0], scores: [{ name: 'a', description: '', max: 3 }] }] }, { ...raw, idNamespace: 'native' }, { ...raw, deleted: 0 }, { ...raw, versions: undefined }]) {
      await expect(clientWith(bad).client.game(raw.id)).rejects.toMatchObject({ code: 'invalid_response' });
    }
    await expect(clientWith({ ...contract, version: 2 }).client.contract()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it.each([401, 409, 410, 429, 503])('surfaces HTTP %i without body, headers, token or retries', async status => {
    const fetcher = vi.fn(async () => response({ error: 'synthetic-secret' }, { status, headers: { 'Retry-After': '60', 'X-Token': 'synthetic-secret' } }));
    const client = new CreatorFeedbackClient('synthetic-token', { fetcher }); let error: unknown;
    try { await client.contract(); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(FeedbackProviderError); expect(error).toMatchObject({ status, code: 'http_error', retryAfterSeconds: 60 });
    expect(String(error)).not.toContain('synthetic'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sanitizes arbitrary transport exceptions', async () => {
    const fetcher = vi.fn(async () => { throw new Error('synthetic-token private response'); });
    await expect(new CreatorFeedbackClient('synthetic-token', { fetcher }).contract()).rejects.toMatchObject({ message: 'Feedback provider connection failed.', code: 'transport' });
  });
  it('rejects oversized declared and streamed responses and cancels streams', async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(11)); }, cancel() { cancelled = true; } });
    const fetcher = vi.fn(async () => new Response(oversized));
    await expect(new CreatorFeedbackClient('synthetic-token', { fetcher, maxBytes: 10 }).contract()).rejects.toMatchObject({ code: 'response_too_large' }); expect(cancelled).toBe(true);
    const declared = vi.fn(async () => new Response('{}', { headers: { 'Content-Length': '11' } }));
    await expect(new CreatorFeedbackClient('synthetic-token', { fetcher: declared, maxBytes: 10 }).contract()).rejects.toMatchObject({ code: 'response_too_large' });
  });
  it('enforces timeout while fetch ignores signal and cancels a late body', async () => {
    let signal: AbortSignal | null | undefined; let finish!: (response: Response) => void; let cancelled = false;
    const fetcher: typeof fetch = async (_, init) => { signal = init?.signal; return new Promise(resolve => { finish = resolve; }); };
    const pending = new CreatorFeedbackClient('synthetic-token', { fetcher, timeoutMs: 10 }).contract();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' }); expect(signal?.aborted).toBe(true);
    finish(new Response(new ReadableStream({ cancel() { cancelled = true; } }))); await new Promise(resolve => setTimeout(resolve, 0)); expect(cancelled).toBe(true);
  });
  it('extends timeout through a stalled response body and cancels the reader', async () => {
    let cancelled = false;
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } })));
    await expect(new CreatorFeedbackClient('synthetic-token', { fetcher, timeoutMs: 10 }).contract()).rejects.toMatchObject({ code: 'timeout' }); expect(cancelled).toBe(true);
  });
  it('rejects unexpected redirects and cross-origin responses without consuming the body', async () => {
    const redirected = new Response('{}', { status: 302, headers: { Location: 'https://private.invalid' } });
    await expect(new CreatorFeedbackClient('synthetic-token', { fetcher: vi.fn(async () => redirected) }).contract()).rejects.toMatchObject({ code: 'invalid_response' });
    const crossOrigin = new Response('{}'); Object.defineProperty(crossOrigin, 'url', { value: 'https://private.invalid/contract' });
    await expect(new CreatorFeedbackClient('synthetic-token', { fetcher: vi.fn(async () => crossOrigin) }).contract()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('parseFeedbackCursor', () => {
  it('preserves scope and sequence, rejecting unsafe and ambiguous values', () => {
    expect(parseFeedbackCursor('3:3060')).toEqual({ scopeRevision: 3, sequence: 3060 });
    expect(parseFeedbackCursor('0:0')).toEqual({ scopeRevision: 0, sequence: 0 });
    for (const value of ['3:-1', '3:01', '3:1.1', '3:1e3', '3:9007199254740992', '3:4:5', ' 3:4', 'bad']) expect(() => parseFeedbackCursor(value)).toThrow(FeedbackProviderError);
  });
});
