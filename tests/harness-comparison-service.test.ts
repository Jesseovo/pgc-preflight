import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  COMPARISON_SERVICE_BASELINE_PATH, COMPARISON_SERVICE_FORWARD_PATH, COMPARISON_SERVICE_NONCE_SCHEMA, COMPARISON_SERVICE_ORIGIN, COMPARISON_SERVICE_PROFILE_PATH,
  createComparisonServiceClient, createComparisonServiceHandler, type ComparisonServiceContext,
} from '../server/harness-comparison-service';
import { canonicalHarness, harnessHash } from '../server/harness-policy';
import { HARNESS_MODEL_HEADERS } from '../server/harness-protocol';

const at = 1_800_000_000_000, version = '231f7591-370d-4f92-8356-87c346f430f6', other = '241f7591-370d-4f92-8356-87c346f430f6';
const taskId = '101f7591-370d-8f92-8356-87c346f430f6', secondId = '111f7591-370d-8f92-8356-87c346f430f6';
const digest = (ch: string) => ch.repeat(64);
const authKey = digest('0');
const context: ComparisonServiceContext = {
  runId: 'formal-run', authorizationSha256: digest('1'), runnerGrantSha256: digest('2'), dispatchGrantSha256: digest('3'),
  planSha256: digest('4'), manifestSha256: digest('5'), runnerDatabaseId: 'isolated-b', nonceDatabaseId: 'isolated-nonces',
  candidateVersion: version, notBefore: at - 60_000, deadlineAt: at + 600_000, taskIds: [taskId, secondId],
};
const profileScope = {
  taskId, slotSha256: digest('6'), admissionSha256: digest('7'), inputSha256: digest('8'), policySha256: digest('9'),
  grantSha256: context.runnerGrantSha256, authorizationSha256: context.authorizationSha256, dispatchGrantSha256: context.dispatchGrantSha256,
  planSha256: context.planSha256, manifestSha256: context.manifestSha256, runnerDatabaseId: context.runnerDatabaseId,
  ownerId: 'admin', operation: 'review' as const, sourceSha256: digest('a'), evidenceSha256: digest('b'),
  modelConfigSha256: digest('c'), modelContractHash: digest('d'), deadlineAt: context.deadlineAt,
};
const forwardScope = { taskId, generation: 'one', lease: digest('e'), stageDeadlineAt: at + 240_000,
  requestIdPrefix: 'review-0-', jsonOutput: true, stage: 'review' as const };
const modelBytes = new TextEncoder().encode('{"message":"private synthetic prompt 🎮","stream":true}');
const generic = 'Comparison service unavailable';
const profile = { profileId: 'deepseek', profile: {
  encryptedKey: 'AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAA=', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
  protocol: 'openai' as const, enabled: true, vision: true, effort: 'low' as const, maxOutputTokens: 24_000, updatedAt: 'synthetic',
} };
type ServerOptions = Parameters<typeof createComparisonServiceHandler>[0];

const databases: DatabaseSync[] = [];
let globalFetch: ReturnType<typeof vi.fn>;
beforeEach(() => { globalFetch = vi.fn(() => { throw new Error('Unexpected external fetch'); }); vi.stubGlobal('fetch', globalFetch); });
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});
function native(signal?: AbortSignal, body: Uint8Array<ArrayBuffer> = modelBytes, path = '/v1/chat/completions') {
  return new Request('http://pgc-harness.internal' + path, { method: 'POST', body, signal, headers: {
    'content-type': 'application/json', authorization: 'Bearer ' + forwardScope.lease, [HARNESS_MODEL_HEADERS.task]: taskId,
    [HARNESS_MODEL_HEADERS.generation]: forwardScope.generation, [HARNESS_MODEL_HEADERS.requestId]: 'review-0-one',
    'x-arbitrary-private-header': 'private native header',
  } });
}
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  return { source, controller, cancel };
}
function setup(overrides: Partial<ServerOptions> = {}) {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  sqlite.exec(COMPARISON_SERVICE_NONCE_SCHEMA);
  const execute = vi.fn((sql: string, args: (string | number)[]) => sqlite.prepare(sql).get(...args));
  const nonceDatabase: ServerOptions['nonceDatabase'] = { scope: 'isolated-comparison', id: context.nonceDatabaseId,
    connection: { prepare: sql => ({ bind: (...args) => ({ async first() { return execute(sql, args); } }) }) } };
  const handle = vi.fn<ServerOptions['handle']>(async call => call.kind === 'profile' ?
    { ...profile, scopeSha256: await harnessHash(canonicalHarness(call.scope)) } : null);
  const options = { context, authKey, executingVersion: version, nonceDatabase, handle, now: () => at, ...overrides };
  const server = createComparisonServiceHandler(options);
  const fetcher = vi.fn(async (request: Request) => server(request));
  const client = createComparisonServiceClient({ context, authKey, fetcher, now: () => at });
  return { server, client, options, handle, fetcher, execute, sqlite };
}
function alter(request: Request, fields: Record<string, string>, url?: string) {
  const headers = new Headers(request.headers);
  for (const [key, value] of Object.entries(fields)) headers.set(key, value);
  return new Request(url ?? request.url, { method: request.method, headers, body: request.body, duplex: 'half' } as RequestInit);
}

test('pins fixed custom-domain URL and actual candidate version and accepts only signed opaque profile JSON', async () => {
  const s = setup();
  expect(await s.client.readVerifiedProfile(profileScope, version)).toEqual({
    ...profile, scopeSha256: await harnessHash(canonicalHarness(profileScope)), candidateVersion: version,
  });
  const [sent] = s.fetcher.mock.calls[0];
  expect(sent.url).toBe(COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_PROFILE_PATH);
  expect(sent.redirect).toBe('manual');
  expect(sent.headers.get('Cloudflare-Workers-Version-Overrides')).toBe(`pgc-preflight="${version}"`);
  expect(sent.headers.has('authorization')).toBe(false);
  expect(s.execute).toHaveBeenCalledOnce();
  expect(s.handle).toHaveBeenCalledWith({ kind: 'profile', scope: profileScope }, expect.any(AbortSignal));
  expect(JSON.stringify(s.sqlite.prepare('SELECT * FROM comparison_service_nonces').all())).not.toMatch(/encryptedKey|private|Bearer/);
});

test('streams exact native body in both directions and drops arbitrary native and response headers', async () => {
  const s = setup(), supplier = stream();
  s.handle.mockImplementationOnce(async call => {
    if (call.kind !== 'forward') throw new Error('wrong route');
    expect(call.scope).toEqual(forwardScope);
    expect(call.request.url).toBe('http://pgc-harness.internal/v1/chat/completions');
    expect(call.request.headers.get(HARNESS_MODEL_HEADERS.requestId)).toBe('review-0-one');
    expect(call.request.headers.get('authorization')).toBe('Bearer ' + forwardScope.lease);
    expect(call.request.headers.has('x-arbitrary-private-header')).toBe(false);
    expect(new Uint8Array(await call.request.arrayBuffer())).toEqual(modelBytes);
    return new Response(supplier.source, { status: 201, statusText: 'Private upstream status',
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'set-cookie': 'private', authorization: 'private' } });
  });
  const response = await s.client.forwardHarness(native(), forwardScope, version);
  expect(response.status).toBe(201);
  expect(response.statusText).toBe('');
  expect(Object.fromEntries(response.headers)).toEqual({ 'cache-control': 'no-store', 'content-type': 'text/event-stream',
    'x-content-type-options': 'nosniff', 'x-pgc-comparison-broker-version': version });
  expect(s.fetcher.mock.calls[0][0].url).toBe(COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_FORWARD_PATH);
  expect(s.fetcher.mock.calls[0][0].headers.has('authorization')).toBe(false);
  const reader = response.body!.getReader();
  const early = new Uint8Array([58, 0xe4, 0xb8, 0xad, 13, 10, 13, 10]);
  supplier.controller.enqueue(early);
  expect((await reader.read()).value).toEqual(early);
  const end = new TextEncoder().encode('data: [DONE]\r\n\r\n');
  supplier.controller.enqueue(end);
  supplier.controller.close();
  expect((await reader.read()).value).toEqual(end);
  expect((await reader.read()).done).toBe(true);
});

test('atomically rejects simultaneous nonce replay and retains replay protection across handler restart', async () => {
  const s = setup();
  s.fetcher.mockImplementationOnce(async request => {
    const requests = [request.clone(), request.clone(), request.clone()];
    const pair = await Promise.all(requests.slice(0, 2).map(s.server));
    expect(pair.map(response => response.status).sort()).toEqual([200, 403]);
    const restarted = createComparisonServiceHandler(s.options);
    expect((await restarted(requests[2])).status).toBe(403);
    return pair.find(response => response.status === 200)!;
  });
  await expect(s.client.readVerifiedProfile(profileScope, version)).resolves.toMatchObject({ candidateVersion: version });
  expect(s.handle).toHaveBeenCalledOnce();
  expect(s.sqlite.prepare('SELECT count(*) AS count FROM comparison_service_nonces').get()).toEqual({ count: 1 });
});

test.each(['body', 'path', 'query', 'origin', 'method', 'timestamp', 'nonce', 'task', 'version', 'signature', 'body digest', 'key', 'grant', 'run'] as const)(
  'rejects tampered %s before consuming a nonce or calling the host', async which => {
    const s = setup();
    s.fetcher.mockImplementationOnce(async request => {
      if (which === 'key' || which === 'grant' || which === 'run') return createComparisonServiceHandler({ ...s.options,
        ...(which === 'key' ? { authKey: digest('f') } : { context: { ...context,
          ...(which === 'grant' ? { dispatchGrantSha256: digest('f') } : { runId: 'another-run' }) } }),
      })(request);
      if (which === 'body') return s.server(new Request(request.url, { method: request.method, headers: request.headers, body: '{} ' }));
      if (which === 'path') return s.server(alter(request, { 'content-type': 'application/octet-stream' }, COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_FORWARD_PATH));
      if (which === 'query') return s.server(alter(request, {}, request.url + '?redirect=1'));
      if (which === 'origin') return s.server(alter(request, {}, 'https://elsewhere.invalid' + COMPARISON_SERVICE_PROFILE_PATH));
      if (which === 'method') return s.server(new Request(request.url, { method: 'PUT', headers: request.headers, body: await request.arrayBuffer() }));
      const tamper = {
        timestamp: ['x-pgc-comparison-timestamp', String(at + 1)], nonce: ['x-pgc-comparison-nonce', 'a'.repeat(32)],
        task: [HARNESS_MODEL_HEADERS.task, secondId], version: ['x-pgc-comparison-expected-version', other],
        signature: ['x-pgc-comparison-signature', digest('a')], 'body digest': ['x-pgc-comparison-body-sha256', digest('a')],
      }[which];
      return s.server(alter(request, { [tamper[0]]: tamper[1] }));
    });
    await expect(s.client.readVerifiedProfile(profileScope, version)).rejects.toThrow(generic);
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.handle).not.toHaveBeenCalled();
  });

test('rejects stale signed timestamps and mismatched actual executing versions before nonce insertion', async () => {
  const s = setup();
  for (const override of [{ now: () => at + 30_001 }, { executingVersion: other }, { executingVersion: undefined }]) {
    const handler = createComparisonServiceHandler({ ...s.options, ...override });
    s.fetcher.mockImplementationOnce(handler);
    await expect(s.client.readVerifiedProfile(profileScope, version)).rejects.toThrow(generic);
  }
  await expect(s.client.readVerifiedProfile(profileScope, other)).rejects.toThrow(generic);
  expect(s.fetcher).toHaveBeenCalledTimes(3);
  expect(s.execute).not.toHaveBeenCalled();
  expect(s.handle).not.toHaveBeenCalled();
});

test('rejects a version header without a signed response, redirects, and changes to signed profile JSON', async () => {
  const s = setup();
  s.fetcher.mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json', 'x-pgc-comparison-broker-version': version } }))
    .mockResolvedValueOnce(Response.redirect('https://elsewhere.invalid/secret'));
  s.fetcher.mockImplementationOnce(async request => {
    const response = await s.server(request);
    const json = await response.json() as { profile: { model: string } };
    json.profile.model = 'changed-model';
    return new Response(JSON.stringify(json), { status: response.status, headers: response.headers });
  });
  for (let index = 0; index < 3; index++) await expect(s.client.readVerifiedProfile(profileScope, version)).rejects.toThrow(generic);
  expect(s.handle).toHaveBeenCalledOnce();
});

test('does not accept a valid signed response from a previous request', async () => {
  const s = setup();
  let previous!: Response;
  s.fetcher.mockImplementationOnce(async request => {
    const response = await s.server(request);
    previous = response.clone();
    return response;
  });
  await s.client.readVerifiedProfile(profileScope, version);
  s.fetcher.mockResolvedValueOnce(previous);
  await expect(s.client.readVerifiedProfile(profileScope, version)).rejects.toThrow(generic);
});

test('rejects malformed scopes and oversize bodies and does not return host credentials or errors', async () => {
  const s = setup();
  await expect(s.client.readVerifiedProfile({ ...profileScope, planSha256: digest('f') }, version)).rejects.toThrow(generic);
  await expect(s.client.forwardHarness(native(undefined, modelBytes, '/v1/tools'), forwardScope, version)).rejects.toThrow(generic);
  await expect(s.client.forwardHarness(native(), { ...forwardScope, generation: 'another' }, version)).rejects.toThrow(generic);
  await expect(s.client.forwardHarness(native(undefined, new Uint8Array(24 * 1024 * 1024 + 1)), forwardScope, version)).rejects.toThrow(generic);
  expect(s.fetcher).not.toHaveBeenCalled();
  s.fetcher.mockImplementationOnce(async request => s.server(new Request(request.url, {
    method: request.method, headers: request.headers, body: 'x'.repeat(32 * 1024 + 1),
  })));
  await expect(s.client.readVerifiedProfile(profileScope, version)).rejects.toThrow(generic);
  expect(s.execute).not.toHaveBeenCalled();
  s.handle.mockResolvedValueOnce({ ...profile, scopeSha256: await harnessHash(canonicalHarness(profileScope)),
    profile: { ...profile.profile, apiKey: 'raw-private-key' } } as Awaited<ReturnType<ServerOptions['handle']>>);
  await expect(s.client.readVerifiedProfile(profileScope, version)).rejects.toThrow(generic);
  s.handle.mockRejectedValueOnce(new Error('upstream raw-private-key'));
  const error = await s.client.forwardHarness(native(), forwardScope, version);
  expect(error.status).toBe(503);
  expect(await error.text()).toBe('');
  s.handle.mockResolvedValueOnce(new Response('upstream raw-private-key', { status: 401,
    headers: { authorization: 'Bearer raw-private-key', 'set-cookie': 'raw-private-key' } }));
  const denied = await s.client.forwardHarness(native(), forwardScope, version);
  expect(denied.status).toBe(401);
  expect(await denied.text()).toBe('');
  expect(JSON.stringify([...denied.headers])).not.toContain('raw-private-key');
});

test('cancels SSE on caller cancellation, excessive bytes or a failed response signature', async () => {
  const s = setup(), a = stream(), b = stream(), c = stream(), controller = new AbortController();
  const response = (source: ReadableStream<Uint8Array>) => new Response(source, { headers: { 'content-type': 'text/event-stream' } });
  s.handle.mockResolvedValueOnce(response(a.source)).mockResolvedValueOnce(response(b.source));
  const first = await s.client.forwardHarness(native(controller.signal), forwardScope, version);
  const pending = first.body!.getReader().read();
  controller.abort('private reason');
  await expect(pending).rejects.toThrow(generic);
  expect(a.cancel).toHaveBeenCalledOnce();
  const second = await s.client.forwardHarness(native(), forwardScope, version);
  b.controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1));
  await expect(second.text()).rejects.toThrow(generic);
  expect(b.cancel).toHaveBeenCalledOnce();
  s.fetcher.mockResolvedValueOnce(new Response(c.source, { headers: { 'content-type': 'text/event-stream', 'x-pgc-comparison-broker-version': version } }));
  await expect(s.client.forwardHarness(native(), forwardScope, version)).rejects.toThrow(generic);
  expect(c.cancel).toHaveBeenCalledOnce();
});

test('allows a signed missing profile and rejects a database with the wrong isolated binding', async () => {
  const s = setup();
  s.handle.mockResolvedValueOnce(null);
  await expect(s.client.readVerifiedProfile(profileScope, version)).resolves.toBeNull();
  expect(() => createComparisonServiceHandler({ ...s.options, nonceDatabase: { ...s.options.nonceDatabase, id: 'wrong' } })).toThrow(generic);
});

test('checks HMAC on the declared digest before reading an untrusted stream', async () => {
  const s = setup();
  const pull = vi.fn(), cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  s.fetcher.mockImplementationOnce(request => {
    const headers = new Headers(request.headers);
    headers.set('x-pgc-comparison-signature', digest('a'));
    return s.server(new Request(request.url, { method: request.method, headers, body, duplex: 'half' } as RequestInit));
  });
  await expect(s.client.readVerifiedProfile(profileScope, version)).rejects.toThrow(generic);
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(s.execute).not.toHaveBeenCalled();
  expect(s.handle).not.toHaveBeenCalled();
});

const baselineUrl = 'https://api.deepseek.com/chat/completions';
const baselineReview = { arm: 'A', taskId: secondId, ownerId: 'admin', operation: 'review', stage: 'review_verify' } as const;
const baselineCreation = { arm: 'A', taskId: secondId, ownerId: 'owner-a', operation: 'creation', stage: 'build' } as const;
const baselineKey = 'pgc-review-' + secondId + '-verify-' + 'd'.repeat(24);
function baselineInit(signal = new AbortController().signal): RequestInit {
  return { method: 'POST', redirect: 'manual', signal, body: '{"model":"deepseek-flash","messages":[{"content":"synthetic 🎮"}],"stream":true}', headers: {
    accept: 'text/event-stream', 'content-type': 'application/json', 'idempotency-key': baselineKey,
    authorization: 'Bearer pgc-comparison-local-placeholder',
  } };
}
test('forwards A review original JSON, sentinel and legacy idempotency through the same version-verified SSE boundary', async () => {
  const s = setup(), supplier = stream(), init = baselineInit();
  s.handle.mockImplementationOnce(async (call, signal) => {
    if (call.kind !== 'baseline') throw new Error('wrong service action');
    expect(call.scope).toEqual(baselineReview);
    expect(call.url).toBe(baselineUrl);
    expect(call.init).toMatchObject({ method: 'POST', redirect: 'manual', body: init.body, signal });
    expect([...new Headers(call.init.headers)]).toEqual([...new Headers(init.headers)]);
    return new Response(supplier.source, { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await s.client.forwardBaseline(baselineReview, baselineUrl, init, version);
  const [sent] = s.fetcher.mock.calls[0];
  expect(sent.url).toBe(COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_BASELINE_PATH);
  expect(sent.headers.get(HARNESS_MODEL_HEADERS.task)).toBe(secondId);
  expect(sent.headers.has('authorization')).toBe(false);
  expect(sent.headers.has('idempotency-key')).toBe(false);
  const reader = response.body!.getReader();
  const ordinary = new TextEncoder().encode('data: {"content":"流"}\r\n\r\n');
  supplier.controller.enqueue(ordinary);
  expect((await reader.read()).value).toEqual(ordinary);
  const end = new TextEncoder().encode('data: [DONE]\n\n');
  supplier.controller.enqueue(end);
  supplier.controller.close();
  expect((await reader.read()).value).toEqual(end);
  expect((await reader.read()).done).toBe(true);
});

test('reconstructs only the fixed A Anthropic request from the model-bound signed envelope', async () => {
  const s = setup(), url = 'https://riffle-api.pages.dev/v1/messages';
  const key = 'pgc-create-' + secondId + ':build-' + 'a'.repeat(24);
  const init = { ...baselineInit(), body: '{"model":"claude-opus-5-5","stream":true}', headers: {
    accept: 'text/event-stream', 'content-type': 'application/json', 'idempotency-key': key,
    'x-api-key': 'pgc-comparison-local-placeholder', 'anthropic-version': '2023-06-01',
  } };
  s.handle.mockImplementationOnce(async call => {
    if (call.kind !== 'baseline') throw new Error('wrong service action');
    expect(call.url).toBe(url);
    expect(call.scope).toEqual(baselineCreation);
    expect(call.init.body).toBe(init.body);
    expect([...new Headers(call.init.headers)]).toEqual([...new Headers(init.headers)]);
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await s.client.forwardBaseline(baselineCreation, url, init, version);
  expect(await response.text()).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
});

test('rejects arbitrary A targets, swapped stage/model, wrong task and real credentials before any fetch', async () => {
  const s = setup(), init = baselineInit();
  const headers = new Headers(init.headers);
  headers.set('authorization', 'Bearer real-private-key');
  const cases = [
    () => s.client.forwardBaseline(baselineReview, 'https://elsewhere.invalid/chat/completions', init, version),
    () => s.client.forwardBaseline({ ...baselineReview, stage: 'build' }, baselineUrl, init, version),
    () => s.client.forwardBaseline(baselineReview, baselineUrl, { ...init, body: '{"model":"claude-opus-5-5"}' }, version),
    () => s.client.forwardBaseline({ ...baselineReview, taskId: '121f7591-370d-8f92-8356-87c346f430f6' }, baselineUrl, init, version),
    () => s.client.forwardBaseline(baselineReview, baselineUrl, { ...init, headers }, version),
  ];
  for (const invoke of cases) await expect(invoke()).rejects.toThrow(generic);
  expect(s.fetcher).not.toHaveBeenCalled();
  expect(s.handle).not.toHaveBeenCalled();
});

test('A baseline failures and cross-route replay do not cause archive transport retries', async () => {
  const s = setup();
  s.handle.mockResolvedValueOnce(new Response('private vendor text', { status: 429 }));
  await expect(s.client.forwardBaseline(baselineReview, baselineUrl, baselineInit(), version)).rejects.toThrow(generic);
  expect(s.handle).toHaveBeenCalledOnce();
  s.fetcher.mockImplementationOnce(request => s.server(alter(request, {}, COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_FORWARD_PATH)));
  await expect(s.client.forwardBaseline(baselineReview, baselineUrl, baselineInit(), version)).rejects.toThrow(generic);
  expect(s.fetcher).toHaveBeenCalledTimes(2);
  expect(s.handle).toHaveBeenCalledOnce();
  expect(s.execute).toHaveBeenCalledOnce();
});
