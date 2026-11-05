import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarnessRun, getHarnessRunSummary, type HarnessDatabase } from '../server/harness-ledger';
import { modelContractHash } from '../server/harness-policy';
import {
  handleHarnessProviderResearch, PROVIDER_RESEARCH_EXPECTED_VERSION_HEADER, PROVIDER_RESEARCH_MODEL, PROVIDER_RESEARCH_PLAN, signHarnessProviderResearch,
  providerResearchAssistantDigest, recordProviderResearchAssistantDigest, type ProviderResearchManifest,
} from '../server/harness-provider-research';
import { encryptKey, type ModelConfig } from '../server/settings';

const dbs: DatabaseSync[] = [];
const encoder = new TextEncoder();
const signingKey = 'b'.repeat(64);
const settingsKey = 'synthetic-settings-key';
const apiKey = 'synthetic-research-provider-key';
const prompt = 'Fixed synthetic research fixture';
const image = 'aGVsbG8=';
const tool = 'mcp__pgc_workspace__read_file';
const requestId = 'probe-0-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function database(migrations: string[]) {
  const sqlite = new DatabaseSync(':memory:');
  dbs.push(sqlite);
  for (const file of migrations) sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  const statements: string[] = [];
  const db: HarnessDatabase = {
    prepare(sql) {
      statements.push(sql);
      const statement = sqlite.prepare(sql);
      const bound = (args: SQLInputValue[] = []) => ({
        bind: (...values: unknown[]) => bound(values as SQLInputValue[]),
        first: async <T>() => (statement.get(...args) as T | undefined) ?? null,
        run: async () => statement.run(...args),
      });
      return bound();
    },
  };
  return { db, sqlite, statements };
}

const event = (type: string, value: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const messageStart = event('message_start', { message: { role: 'assistant', content: [], usage: { input_tokens: 9, output_tokens: 0 } } });
const sse = messageStart +
  event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) + event('message_stop');
const assistantContent = [
  { type: 'thinking', thinking: 'synthetic private thought', signature: 'synthetic signature' },
  { type: 'redacted_thinking', data: 'synthetic redacted bytes' },
  { type: 'text', text: 'Synthetic explanation' },
  { type: 'tool_use', id: 'toolu_synthetic', name: tool, input: { path: 'input/research.txt' } },
];
const toolSse = messageStart +
  event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
  event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: assistantContent[0].thinking } }) +
  event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: assistantContent[0].signature } }) +
  event('content_block_stop', { index: 0 }) +
  event('content_block_start', { index: 1, content_block: assistantContent[1] }) + event('content_block_stop', { index: 1 }) +
  event('content_block_start', { index: 2, content_block: { type: 'text', text: 'ignored by pinned CCB' } }) +
  event('content_block_delta', { index: 2, delta: { type: 'text_delta', text: assistantContent[2].text } }) + event('content_block_stop', { index: 2 }) +
  event('content_block_start', { index: 3, content_block: { type: 'tool_use', id: assistantContent[3].id, name: tool, input: {} } }) +
  event('content_block_delta', { index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":' } }) +
  event('content_block_delta', { index: 3, delta: { type: 'input_json_delta', partial_json: '"input/research.txt"}' } }) +
  event('content_block_stop', { index: 3 }) + event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 11 } }) + event('message_stop');
const nativeBody = {
  model: 'claude-opus-5-5', stream: true, max_tokens: 1024,
  system: 'Fixed synthetic research system',
  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] }],
  tools: [{ name: tool, description: 'Read synthetic input', input_schema: { type: 'object' } }],
};

async function setup() {
  const ledger = database(readdirSync('migrations').sort().filter(name => name.endsWith('.sql') && name < '0034'));
  ledger.sqlite.exec(readFileSync('scripts/harness-provider-research-ledger.sql', 'utf8'));
  const capacity = database(['0007_model_throttle.sql', '0023_model_slots.sql']);
  const opus = { protocol: 'anthropic' as const, model: nativeBody.model, baseUrl: 'https://riffle-api.pages.dev', effort: 'low' as const,
    encryptedKey: await encryptKey(apiKey, settingsKey), vision: true, enabled: true, updatedAt: 'fixture' };
  const review = { ...opus, protocol: 'openai' as const, model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', vision: false };
  const config: ModelConfig = { ...opus, activeProfile: 'opus', routes: { create: 'opus', review: 'review' }, profiles: { opus, review } };
  const now = Date.now();
  const manifest: ProviderResearchManifest = { fixtureId: 'synthetic-native', taskId: 'research-task', generation: 'research-generation',
    sourceHash: 'a'.repeat(64), modelContractHash: await modelContractHash(config, 'game'), purpose: 'game', phase: 'probe',
    notBefore: now - 10_000, expiresAt: now + 60_000, maxRequestOutputTokens: 1024, maxTotalOutputTokens: 2048, maxModelTurns: 2,
    toolNames: [tool], requestMatches: vi.fn(async (body) => body.system === nativeBody.system &&
      JSON.stringify(body.messages) === JSON.stringify(nativeBody.messages) && JSON.stringify(body.tools) === JSON.stringify(nativeBody.tools)) };
  const loadConfig = vi.fn(async (): Promise<ModelConfig | null> => config);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }));
  const options = { DB: ledger.db, capacityDB: capacity.db, authKey: signingKey, settingsKey, manifest, loadConfig, fetcher,
    recordAssistantDigest: (receipt: Parameters<typeof recordProviderResearchAssistantDigest>[1]) => recordProviderResearchAssistantDigest(ledger.db, receipt) };
  async function signed({ path = PROVIDER_RESEARCH_MODEL, method = path === PROVIDER_RESEARCH_PLAN ? 'GET' : 'POST',
    taskId = manifest.taskId, generation = manifest.generation, id = path === PROVIDER_RESEARCH_PLAN ? 'plan' : requestId,
    timestamp = Date.now(), lease = '', body = path === PROVIDER_RESEARCH_PLAN ? '' : JSON.stringify(nativeBody),
    mutateHeaders, wireBody = body, key = signingKey, expectedVersion } : {
    path?: string; method?: string; taskId?: string; generation?: string; id?: string; timestamp?: number; lease?: string;
    body?: string; mutateHeaders?: (headers: Headers) => void; wireBody?: string; key?: string; expectedVersion?: string;
  } = {}) {
    const headers = await signHarnessProviderResearch(key, { path, method, taskId, generation, requestId: id, timestamp, lease,
      body: encoder.encode(body), expectedVersion });
    mutateHeaders?.(headers);
    return new Request('https://candidate.invalid' + path, { method, headers, ...(method === 'POST' && { body: wireBody }) });
  }
  async function plan() {
    return handleHarnessProviderResearch(await signed({ path: PROVIDER_RESEARCH_PLAN }), options);
  }
  async function register(overrides: Partial<Parameters<typeof createHarnessRun>[1]> = {}) {
    const response = await plan();
    expect(response.status).toBe(200);
    const input = await response.json() as Parameters<typeof createHarnessRun>[1];
    return (await createHarnessRun(ledger.db, { ...input, ...overrides }))!;
  }
  return { ledger, capacity, config, manifest, options, fetcher, loadConfig, signed, plan, register };
}

afterEach(() => { dbs.splice(0).forEach(db => db.close()); });

describe('isolated provider research broker', () => {
  it('reads the exact selected contract only for authenticated planning and never exports configuration credentials', async () => {
    const s = await setup();
    const response = await s.plan();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ ownerId: 'admin', actor: 'admin', family: 'forge',
      model: { profileId: 'opus', protocol: 'anthropic', effort: 'high', maxOutputTokens: 64_000 }, maxRequestOutputTokens: 1024 });
    for (const privateValue of [apiKey, settingsKey, signingKey, s.config.encryptedKey, s.config.baseUrl]) expect(text).not.toContain(privateValue);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.ledger.statements).toEqual([]);
    expect(s.capacity.statements).toEqual([]);

    s.manifest.purpose = 'review';
    s.manifest.modelContractHash = await modelContractHash(s.config, 'review');
    expect(await (await s.plan()).json()).toEqual({ error: 'research_continuation_unavailable' });
    s.manifest.maxModelTurns = 1;
    s.manifest.maxTotalOutputTokens = 1024;
    s.manifest.toolNames = [];
    expect(await (await s.plan()).json()).toMatchObject({ family: 'review', model: { profileId: 'review', protocol: 'openai', vision: false } });
    s.manifest.purpose = 'create';
    s.manifest.modelContractHash = await modelContractHash(s.config, 'create');
    expect(await (await s.plan()).json()).toMatchObject({ family: 'forge', model: { profileId: 'opus', protocol: 'anthropic' } });
  });

  it('does not reach configuration or model on auth, body, route, unregistered run or lease failures', async () => {
    const s = await setup();
    const lease = 'd'.repeat(64);
    for (const [changes, status] of [
      [{ key: 'a'.repeat(64) }, 401],
      [{ timestamp: Date.now() - 31_000 }, 401],
      [{ taskId: 'different-task' }, 401],
      [{ generation: 'different-generation' }, 401],
      [{ id: 'review-0-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, 401],
      [{ mutateHeaders: (h: Headers) => h.set('cookie', 'pgc_admin=synthetic') }, 401],
      [{ mutateHeaders: (h: Headers) => h.set('authorization', 'Bearer ' + 'e'.repeat(64)) }, 401],
      [{ wireBody: '{}' }, 400],
      [{ path: '/v1/messages' }, 404],
      [{ path: PROVIDER_RESEARCH_MODEL + '?url=https://else.invalid' }, 404],
      [{}, 401],
    ] as const) {
      expect((await handleHarnessProviderResearch(await s.signed({ lease, ...changes }), s.options)).status).toBe(status);
    }
    expect(s.loadConfig).not.toHaveBeenCalled();
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.capacity.statements).toEqual([]);
    expect(s.ledger.sqlite.prepare('SELECT count(*) AS count FROM harness_requests').get()).toEqual({ count: 0 });

    const rogue = await s.register({ ownerId: 'real-member-shape', actor: 'star' });
    s.loadConfig.mockClear();
    expect((await handleHarnessProviderResearch(await s.signed({ lease: rogue.lease }), s.options)).status).toBe(401);
    expect(s.loadConfig).not.toHaveBeenCalled();
  });

  it('binds an expected candidate version to the request MAC', async () => {
    const s = await setup();
    const expectedVersion = '11111111-1111-4111-8111-111111111111';
    const path = PROVIDER_RESEARCH_PLAN;
    const invalid = await s.signed({ path, expectedVersion,
      mutateHeaders: headers => headers.set(PROVIDER_RESEARCH_EXPECTED_VERSION_HEADER, '22222222-2222-4222-8222-222222222222') });
    expect((await handleHarnessProviderResearch(invalid, s.options)).status).toBe(401);
    expect(s.loadConfig).not.toHaveBeenCalled();
    const correct = await s.signed({ path, expectedVersion });
    expect(correct.headers.get(PROVIDER_RESEARCH_EXPECTED_VERSION_HEADER)).toBe(expectedVersion);
    expect((await handleHarnessProviderResearch(correct, s.options)).status).toBe(200);
  });

  it('runs native SSE through the existing gateway and writes only shared capacity state in production', async () => {
    const s = await setup();
    const { lease, run } = await s.register();
    const response = await handleHarnessProviderResearch(await s.signed({ lease }), s.options);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sse);
    const [url, init] = s.fetcher.mock.calls[0];
    expect(String(url)).toBe('https://riffle-api.pages.dev/v1/messages');
    expect(new Headers(init?.headers).get('x-api-key')).toBe(apiKey);
    expect(new Headers(init?.headers).has('x-pgc-research-signature')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({ ...nativeBody, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(await getHarnessRunSummary(s.ledger.db, run)).toMatchObject({ modelTurns: 1, outputTokens: 7, reservedTokens: 0 });
    expect(s.ledger.sqlite.prepare('SELECT purpose,output_tokens FROM model_runs').get()).toEqual({ purpose: 'harness:game', output_tokens: 7 });
    expect(s.ledger.statements.some(sql => /model_(?:slots|throttle)/i.test(sql))).toBe(false);
    expect(s.capacity.statements.some(sql => /INSERT INTO model_slots/i.test(sql))).toBe(true);
    expect(s.capacity.statements.some(sql => /INSERT INTO model_throttle/i.test(sql))).toBe(true);
    expect(s.capacity.statements.every(sql => !/harness_|model_runs|settings/i.test(sql))).toBe(true);
    expect(s.capacity.sqlite.prepare('SELECT count(*) AS count FROM model_slots').get()).toEqual({ count: 0 });
    expect((await handleHarnessProviderResearch(await s.signed({ lease }), s.options)).status).toBe(409);
    expect(s.fetcher).toHaveBeenCalledOnce();
  });

  it('rejects changed tool names, image, token cap and auxiliary model before a reservation', async () => {
    const s = await setup();
    const { lease } = await s.register();
    s.loadConfig.mockClear();
    for (const override of [{ model: 'auxiliary' }, { max_tokens: 1025 }, { max_tokens: '1024' }, { tools: [{ name: 'other' }] },
      { tools: [{ ...nativeBody.tools[0], input_schema: { type: 'string' } }] }, { system: 'different system' },
      { messages: [{ role: 'user', content: 'unexpected fixture' }] },
      { messages: [{ role: 'user', content: [nativeBody.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }] }] }]) {
      const body = JSON.stringify({ ...nativeBody, ...override });
      expect((await handleHarnessProviderResearch(await s.signed({ lease, body }), s.options)).status).toBe(400);
    }
    expect(s.loadConfig).not.toHaveBeenCalled();
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.ledger.sqlite.prepare('SELECT count(*) AS count FROM harness_requests').get()).toEqual({ count: 0 });
  });

  it('rechecks the currently selected profile immediately before provider forwarding', async () => {
    const s = await setup();
    const { lease, run } = await s.register();
    const replacement = { ...s.config.profiles!.opus!, encryptedKey: await encryptKey('replacement', settingsKey) };
    s.loadConfig.mockResolvedValueOnce(s.config).mockResolvedValueOnce({ ...s.config,
      activeProfile: 'replacement', routes: { ...s.config.routes, create: 'replacement' }, profiles: { ...s.config.profiles, replacement } });
    expect((await handleHarnessProviderResearch(await s.signed({ lease }), s.options)).status).toBe(503);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(await getHarnessRunSummary(s.ledger.db, run)).toMatchObject({ status: 'failed', failureCode: 'profile_unavailable', reservedTokens: 0 });
    expect(s.ledger.sqlite.prepare('SELECT attempts FROM harness_requests').get()).toEqual({ attempts: 0 });
  });

  it('latches unknown provider outcomes in the research ledger and refuses subsequent request IDs', async () => {
    const s = await setup();
    const { lease, run } = await s.register();
    s.fetcher.mockRejectedValueOnce(new Error('private-synthetic-upstream-error'));
    const first = await handleHarnessProviderResearch(await s.signed({ lease }), s.options);
    expect(first.status).toBe(502);
    expect(await first.text()).not.toContain('private-synthetic-upstream-error');
    expect(await getHarnessRunSummary(s.ledger.db, run)).toMatchObject({ status: 'unknown', failureCode: 'provider_unknown' });
    const next = await handleHarnessProviderResearch(await s.signed({ lease, id: 'probe-0-ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' }), s.options);
    expect(next.status).toBe(401);
    expect(s.fetcher).toHaveBeenCalledOnce();
  });

  it.each([['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']])('matches a correlated tool continuation with %s SSE framing', async (_name, newline) => {
    const s = await setup();
    s.config.profiles!.opus!.baseUrl = 'https://synthetic.invalid';
    s.manifest.modelContractHash = await modelContractHash(s.config, 'game');
    const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_synthetic', content: 'Fixed synthetic result' }] };
    const followup = { ...nativeBody, messages: [...nativeBody.messages, { role: 'assistant', content: assistantContent }, toolResult] };
    const matcher = s.manifest.requestMatches;
    s.manifest.requestMatches = async (body, model, context) => {
      if (!context.run.modelTurns) return matcher(body, model, context);
      const history = (body.messages as typeof followup.messages)[1]?.content;
      return Array.isArray(history) && await providerResearchAssistantDigest(history) === await context.readPriorAssistantDigest() &&
        JSON.stringify(body.messages) === JSON.stringify(followup.messages);
    };
    const { lease } = await s.register();
    const nativeStream = toolSse.replaceAll('\n', newline);
    s.fetcher.mockResolvedValueOnce(new Response(nativeStream, { headers: { 'Content-Type': 'text/event-stream' } }));
    const first = await handleHarnessProviderResearch(await s.signed({ lease }), s.options);
    expect(await first.text()).toBe(nativeStream);
    const digest = s.ledger.sqlite.prepare('SELECT request_id,assistant_sha256,published FROM provider_research_assistant_digests').get();
    expect(digest).toEqual({ request_id: requestId, assistant_sha256: await providerResearchAssistantDigest(assistantContent), published: 1 });
    for (const privateText of ['synthetic private thought', 'synthetic signature', 'synthetic redacted bytes', 'Synthetic explanation']) {
      expect(JSON.stringify(digest)).not.toContain(privateText);
    }
    const id = 'probe-0-ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const changed = { ...followup, messages: [...followup.messages.slice(0, 2), { ...toolResult, content: [] }] };
    expect((await handleHarnessProviderResearch(await s.signed({ lease, id, body: JSON.stringify(changed) }), s.options)).status).toBe(400);
    const second = await handleHarnessProviderResearch(await s.signed({ lease, id, body: JSON.stringify(followup) }), s.options);
    expect(await second.text()).toBe(sse);
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });

  it('never accepts a digest from a partial stream', async () => {
    const s = await setup();
    const { lease, run } = await s.register();
    s.fetcher.mockResolvedValueOnce(new Response(toolSse.replace(event('message_stop'), ''), { headers: { 'Content-Type': 'text/event-stream' } }));
    const first = await handleHarnessProviderResearch(await s.signed({ lease }), s.options);
    await expect(first.text()).rejects.toThrow();
    expect(s.ledger.sqlite.prepare('SELECT count(*) AS count FROM provider_research_assistant_digests').get()).toEqual({ count: 0 });
    expect(await getHarnessRunSummary(s.ledger.db, run)).toMatchObject({ status: 'unknown' });
  });

  it('does not accept an assistant digest after the client disconnects', async () => {
    const s = await setup();
    const { lease, run } = await s.register();
    const cancel = vi.fn();
    s.fetcher.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(messageStart)); }, cancel,
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const controller = new AbortController();
    const request = new Request(await s.signed({ lease }), { signal: controller.signal });
    const response = await handleHarnessProviderResearch(request, s.options);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(messageStart);
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(s.ledger.sqlite.prepare('SELECT count(*) AS count FROM provider_research_assistant_digests').get()).toEqual({ count: 0 });
    expect(await getHarnessRunSummary(s.ledger.db, run)).toMatchObject({ status: 'unknown' });
  });

  it.each([false, true])('closes the run on disconnect while digest storage is pending (staged=%s)', async staged => {
    const s = await setup();
    const { lease, run } = await s.register();
    const ctl = new AbortController();
    let entered!: () => void;
    let unblock!: () => void;
    let exited!: () => void;
    const recording = new Promise<void>(resolve => { entered = resolve; });
    const pause = new Promise<void>(resolve => { unblock = resolve; });
    const finished = new Promise<void>(resolve => { exited = resolve; });
    const options = { ...s.options, recordAssistantDigest: async (receipt: Parameters<typeof recordProviderResearchAssistantDigest>[1]) => {
      try {
        if (staged) await s.options.recordAssistantDigest(receipt);
        entered();
        await pause;
        if (!staged) await s.options.recordAssistantDigest(receipt);
      } finally { exited(); }
    } };
    s.fetcher.mockResolvedValueOnce(new Response(toolSse, { headers: { 'Content-Type': 'text/event-stream' } }));
    const first = await handleHarnessProviderResearch(new Request(await s.signed({ lease }), { signal: ctl.signal }), options);
    const bodyError = first.text().then(() => null, error => error);
    const id = 'probe-0-ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await recording;
    expect(s.ledger.sqlite.prepare('SELECT count(*) AS count FROM provider_research_assistant_digests WHERE published=1').get()).toEqual({ count: 0 });
    expect((await handleHarnessProviderResearch(await s.signed({ lease, id }), options)).status).toBe(409);
    ctl.abort();
    expect(await bodyError).toBeInstanceOf(Error);
    unblock();
    await finished;
    expect(s.ledger.sqlite.prepare('SELECT count(*) AS count FROM provider_research_assistant_digests').get()).toEqual({ count: 0 });
    expect(await getHarnessRunSummary(s.ledger.db, run)).toMatchObject({ status: 'failed', failureCode: 'client_disconnected' });
    expect((await handleHarnessProviderResearch(await s.signed({ lease, id }), options)).status).toBe(401);
    expect(s.fetcher).toHaveBeenCalledOnce();
  });

  it('atomically refuses a stale first turn that validated before another first turn completed', async () => {
    const s = await setup();
    const competingId = 'probe-0-ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    let unblock!: () => void;
    let matched!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const ready = new Promise<void>(resolve => { matched = resolve; });
    const matcher = s.manifest.requestMatches;
    s.manifest.requestMatches = async (body, model, context) => {
      if (context.requestId === competingId) {
        matched();
        await blocked;
      }
      return matcher(body, model, context);
    };
    const { lease } = await s.register();
    const competing = handleHarnessProviderResearch(await s.signed({ lease, id: competingId }), s.options);
    await ready;
    const first = await handleHarnessProviderResearch(await s.signed({ lease }), s.options);
    expect(await first.text()).toBe(sse);
    unblock();
    expect((await competing).status).toBe(409);
    expect(s.fetcher).toHaveBeenCalledOnce();
  });
});
