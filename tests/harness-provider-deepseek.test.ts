import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {
  constructor(readonly ctx: unknown, readonly env: unknown) {}
} }));
import { workspaceResponse } from '../harness/workspace.mjs';
import { ProviderNativeControl, ProviderNativeOutbound, ProviderNativeRunner } from '../scripts/harness-provider-deepseek-native-worker';
import { providerResearchSchema } from '../scripts/harness-provider-research-schema';
import { createHarnessRun, getHarnessRun, getHarnessRunSummary, type HarnessDatabase } from '../server/harness-ledger';
import { canonicalHarness, harnessHash } from '../server/harness-policy';
import {
  DEEPSEEK_RESEARCH_CONTRACT, DEEPSEEK_RESEARCH_FIXTURE_ID, DEEPSEEK_RESEARCH_MODEL, DEEPSEEK_RESEARCH_OUTPUT_CAP,
  DEEPSEEK_RESEARCH_PATH, DEEPSEEK_RESEARCH_READ, DEEPSEEK_RESEARCH_RESULT, DEEPSEEK_RESEARCH_WIRE,
  deepSeekResearchAssistant, deepSeekResearchFixtureManifest, deepSeekResearchFixtureMaterial, deepSeekResearchFixtureSourceHash,
} from '../server/harness-provider-deepseek-fixture';
import { deepSeekResearchAssistantFrames } from '../server/harness-provider-deepseek-observer';
import { handleProviderResearchCandidate } from '../server/harness-provider-candidate';
import { deepSeekNativeFixture, signProviderNativeControl, type ProviderNativeEnv } from '../server/harness-provider-native';
import type { HarnessOutboundScope } from '../server/harness-outbound-scope';
import {
  handleHarnessProviderResearch, PROVIDER_RESEARCH_MODEL, PROVIDER_RESEARCH_PLAN, recordProviderResearchAssistantDigest,
  signHarnessProviderResearch,
} from '../server/harness-provider-research';
import { encryptKey, type ModelConfig } from '../server/settings';

const dbs: DatabaseSync[] = [];
const settingsKey = 'synthetic-deepseek-settings-key';
const authKey = 'b'.repeat(64);
const apiKey = 'synthetic-deepseek-api-key';
const firstId = 'review-0-00000000-0000-4000-8000-000000000001';
const secondId = 'review-0-00000000-0000-4000-8000-000000000002';
const thirdId = 'review-0-00000000-0000-4000-8000-000000000003';
const toolId = 'call_synthetic_marker';
const reasoning = 'Synthetic reasoning only';
const argumentsJson = JSON.stringify({ path: DEEPSEEK_RESEARCH_PATH });
const assistant = deepSeekResearchAssistant(null, reasoning, toolId, DEEPSEEK_RESEARCH_READ, argumentsJson);
const encoder = new TextEncoder();

function database(schema: string) {
  const sqlite = new DatabaseSync(':memory:');
  dbs.push(sqlite);
  sqlite.exec(schema);
  const statements: string[] = [];
  const db: HarnessDatabase = { prepare(sql) {
    statements.push(sql);
    const statement = sqlite.prepare(sql);
    const bound = (args: SQLInputValue[] = []) => ({
      bind: (...values: unknown[]) => bound(values as SQLInputValue[]),
      first: async <T>() => (statement.get(...args) as T | undefined) ?? null,
      run: async () => statement.run(...args),
    });
    return bound();
  } };
  return { sqlite, db, statements };
}

function streamText(first: boolean, finalResult: unknown = DEEPSEEK_RESEARCH_RESULT, reasoningText = reasoning) {
  const chunk = (choices: object[], usage: object | null = null) => ({ id: 'synthetic-completion', model: DEEPSEEK_RESEARCH_MODEL, choices, usage });
  const delta = (value: object) => chunk([{ index: 0, delta: value, finish_reason: null }]);
  const frames = [delta({ role: 'assistant', content: '' }),
    ...(first ? [delta({ reasoning_content: reasoningText }),
      delta({ tool_calls: [{ index: 0, id: toolId, type: 'function', function: { name: DEEPSEEK_RESEARCH_READ, arguments: '{ "path":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: ` "${DEEPSEEK_RESEARCH_PATH}" }` } }] }),
    ] : [delta({ content: JSON.stringify(finalResult) })]),
    chunk([{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }]),
    chunk([], { prompt_tokens: 51, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: first ? 5 : 0 } }),
  ];
  return frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
}

function fragmentedResponse(text: string) {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 13) controller.enqueue(bytes.slice(offset, offset + 13));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function bodies(now: number) {
  const material = await deepSeekResearchFixtureMaterial();
  const ctx = { run: { purpose: 'review', vision: true }, files: new Map(material.files.map(entry => [entry.path, entry])) };
  const toolResponse = async (method: string, params?: object) => {
    const response = await workspaceResponse(ctx, { jsonrpc: '2.0', id: 1, method, params }, '');
    if (!response || !('result' in response)) throw new Error('No fixture tool result');
    return response.result;
  };
  const available = (await toolResponse('tools/list')).tools as { name: string; description: string; inputSchema: object }[];
  const tools = available.map(tool => ({ type: 'function', function: {
    name: `mcp__pgc_workspace__${tool.name}`, description: tool.description, parameters: tool.inputSchema,
  } })).sort((a, b) => a.function.name.localeCompare(b.function.name));
  const date = new Date(now).toISOString().slice(0, 10);
  const reminder = `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is ${date}.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`;
  const messages = [{ role: 'system', content: material.systemPrompt }, { role: 'user', content: [
    { type: 'text', text: `${reminder}\n${material.prompt}` }, ...material.files.slice(1).map(file => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${file.content}` } })),
  ] }];
  const toolContent = await toolResponse('tools/call', { name: 'read', arguments: { path: DEEPSEEK_RESEARCH_PATH } });
  const first = { model: DEEPSEEK_RESEARCH_MODEL, max_tokens: DEEPSEEK_RESEARCH_OUTPUT_CAP, stream: true,
    stream_options: { include_usage: true }, tools, messages };
  return { first, second: { ...first, messages: [...messages, assistant,
    { role: 'tool', tool_call_id: toolId, content: toolContent.content[0].text },
  ] }, material };
}

async function setup() {
  const ledger = database(providerResearchSchema());
  const capacity = database(['0007_model_throttle.sql', '0023_model_slots.sql'].map(name => readFileSync(`migrations/${name}`, 'utf8')).join('\n'));
  const profile: ModelConfig = { model: DEEPSEEK_RESEARCH_MODEL, baseUrl: 'https://api.deepseek.com', protocol: 'openai', effort: 'auto',
    encryptedKey: await encryptKey(apiKey, settingsKey), enabled: true, vision: true, updatedAt: 'synthetic' };
  const now = Date.now();
  const manifest = deepSeekResearchFixtureManifest({ taskId: 'review-research', generation: 'fixture-generation',
    modelContractHash: DEEPSEEK_RESEARCH_CONTRACT, notBefore: now - 1000, expiresAt: now + 60_000 });
  const fetcher = vi.fn<typeof fetch>();
  const options = { DB: ledger.db, capacityDB: capacity.db, authKey, settingsKey, manifest, loadConfig: async () => profile, fetcher,
    recordAssistantDigest: (receipt: Parameters<typeof recordProviderResearchAssistantDigest>[1]) => recordProviderResearchAssistantDigest(ledger.db, receipt) };
  const send = async (id: string, value?: object, lease = '', override = options) => {
    const path = value === undefined ? PROVIDER_RESEARCH_PLAN : PROVIDER_RESEARCH_MODEL;
    const method = value === undefined ? 'GET' : 'POST';
    const body = encoder.encode(value === undefined ? '' : JSON.stringify(value));
    const headers = await signHarnessProviderResearch(authKey, { ...manifest, path, method, requestId: id, body, lease, timestamp: Date.now() });
    return handleHarnessProviderResearch(new Request('https://candidate.invalid' + path, { method, headers, ...(value !== undefined && { body }) }), override);
  };
  return { ...await bodies(now), ledger, capacity, profile, options, manifest, fetcher, send };
}

afterEach(() => dbs.splice(0).forEach(db => db.close()));

it('forwards only the two pinned DeepSeek fixture turns with gateway JSON mode, images, tool digest and usage', async () => {
  const s = await setup();
  expect(await deepSeekResearchFixtureSourceHash()).toBe(DEEPSEEK_RESEARCH_WIRE.sourceHash);
  const planResponse = await s.send('plan');
  expect(planResponse.status).toBe(200);
  const plan = await planResponse.json() as Parameters<typeof createHarnessRun>[1];
  expect(plan).toMatchObject({ family: 'review', snapshot: { fixtureId: DEEPSEEK_RESEARCH_FIXTURE_ID },
    model: { model: DEEPSEEK_RESEARCH_MODEL, protocol: 'openai', effort: 'low', vision: true, maxOutputTokens: 8192 },
    limits: { maxModelTurns: 2, maxTotalOutputTokens: 16_384, maxRepairs: 0 } });
  const { lease } = (await createHarnessRun(s.ledger.db, plan))!;
  expect((await s.send(firstId, { ...s.first, response_format: { type: 'text' } }, lease)).status).toBe(400);
  const mutatedImage = structuredClone(s.first) as any;
  mutatedImage.messages[1].content[1].image_url.url = mutatedImage.messages[1].content[2].image_url.url;
  expect((await s.send(firstId, mutatedImage, lease)).status).toBe(400);
  expect((await s.send(secondId, s.second, lease)).status).toBe(400);
  expect(s.fetcher).not.toHaveBeenCalled();

  s.fetcher.mockImplementationOnce(async () => fragmentedResponse(streamText(true)))
    .mockImplementationOnce(async () => fragmentedResponse(streamText(false)));
  expect(await (await s.send(firstId, s.first, lease)).text()).toBe(streamText(true));
  const row = s.ledger.sqlite.prepare('SELECT assistant_sha256,published FROM provider_research_assistant_digests').get();
  expect(row).toEqual({ assistant_sha256: await harnessHash(canonicalHarness([assistant])), published: 1 });
  const forged = structuredClone(s.second) as any;
  forged.messages[2].reasoning_content += ' changed';
  expect((await s.send(secondId, forged, lease)).status).toBe(400);
  forged.messages[2].reasoning_content = reasoning;
  forged.messages[3].content += ' changed';
  expect((await s.send(secondId, forged, lease)).status).toBe(400);
  expect(await (await s.send(secondId, s.second, lease)).text()).toBe(streamText(false));
  expect((await s.send(thirdId, s.second, lease)).status).toBe(400);
  expect(s.fetcher).toHaveBeenCalledTimes(2);
  for (const [index, [url, init]] of s.fetcher.mock.calls.entries()) {
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(init?.body))).toEqual({ ...[s.first, s.second][index],
      response_format: { type: 'json_object' }, thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  }
  expect(await getHarnessRunSummary(s.ledger.db, plan)).toMatchObject({ modelTurns: 2, outputTokens: 20, reservedTokens: 0 });
  expect(s.ledger.sqlite.prepare('SELECT attempts,input_tokens,output_tokens,reasoning_tokens,finish_reason FROM harness_requests ORDER BY request_id').all())
    .toEqual([{ attempts: 1, input_tokens: 51, output_tokens: 10, reasoning_tokens: 5, finish_reason: 'tool_calls' },
      { attempts: 1, input_tokens: 51, output_tokens: 10, reasoning_tokens: 0, finish_reason: 'stop' }]);
  // The official DeepSeek route has no normal Riffle pacing or slot write.
  expect(s.capacity.statements).toEqual([]);
  expect(JSON.stringify(s.ledger.sqlite.prepare('SELECT * FROM provider_research_assistant_digests').all())).not.toContain(reasoning);
});

it('fails closed on a changed profile or a copied fixture id with a permissive matcher', async () => {
  const s = await setup();
  s.profile.vision = false;
  expect(await (await s.send('plan')).json()).toEqual({ error: 'research_profile_unavailable' });
  s.profile.vision = true;
  expect(await (await s.send('plan', undefined, '', { ...s.options, manifest: { ...s.manifest, requestMatches: () => true } })).json())
    .toEqual({ error: 'research_unavailable' });
  expect(s.fetcher).not.toHaveBeenCalled();
});

it('withholds terminal completion when a DeepSeek result is invalid and never retries it', async () => {
  const s = await setup();
  const plan = await (await s.send('plan')).json() as Parameters<typeof createHarnessRun>[1];
  const { lease } = (await createHarnessRun(s.ledger.db, plan))!;
  s.fetcher.mockImplementationOnce(async () => fragmentedResponse(streamText(true)))
    .mockImplementationOnce(async () => fragmentedResponse(streamText(false, { first: 'green' })));
  await (await s.send(firstId, s.first, lease)).text();
  await expect((await s.send(secondId, s.second, lease)).text()).rejects.toThrow('research_assistant_digest_failed');
  expect(await getHarnessRunSummary(s.ledger.db, plan)).toMatchObject({ status: 'failed', failureCode: 'stream_invalid' });
  expect((await s.send(thirdId, s.second, lease)).status).toBe(401);
  expect(s.fetcher).toHaveBeenCalledTimes(2);
});

it('records shared throttling on an explicit provider 429 without resending the fixture', async () => {
  const s = await setup();
  const plan = await (await s.send('plan')).json() as Parameters<typeof createHarnessRun>[1];
  const { lease } = (await createHarnessRun(s.ledger.db, plan))!;
  s.fetcher.mockImplementationOnce(async () => Response.json({ error: 'synthetic throttle' }, { status: 429 }));
  expect((await s.send(firstId, s.first, lease)).status).toBe(429);
  expect((await s.send(secondId, s.second, lease)).status).toBe(401);
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  expect(s.capacity.statements).toHaveLength(1);
  expect(s.capacity.statements[0]).toMatch(/INSERT INTO model_throttle/);
  expect(s.ledger.sqlite.prepare('SELECT attempts,state FROM harness_requests').get()).toEqual({ attempts: 1, state: 'failed' });
});

it('preserves empty native reasoning and rejects a missing terminal, unexpected model or mismatched artifact', async () => {
  const valid = deepSeekResearchAssistantFrames(true);
  valid.push(encoder.encode(streamText(true, undefined, '')));
  expect(valid.finish()).toEqual([{ ...assistant, reasoning_content: '' }]);
  for (const wire of [streamText(true).replace('data: [DONE]', ''), streamText(true).replace(DEEPSEEK_RESEARCH_MODEL, 'other-model'),
    streamText(true).replace('synthetic-completion', 'different-completion'), streamText(true).replaceAll('reasoning_content', 'other_content')]) {
    const frames = deepSeekResearchAssistantFrames(true);
    expect(() => { frames.push(encoder.encode(wire)); frames.finish(); }).toThrow('deepseek_fixture_stream_invalid');
  }
  const text = JSON.stringify(DEEPSEEK_RESEARCH_RESULT);
  const artifact = { path: 'result.txt', content: text, encoding: 'utf8', sha256: await harnessHash(text) };
  expect(await deepSeekNativeFixture.resultMatches({ text, files: [artifact] })).toBe(true);
  expect(await deepSeekNativeFixture.resultMatches({ text, files: [{ ...artifact, sha256: '0'.repeat(64) }] })).toBe(false);
});

it('runs the separate DeepSeek Native entry through signed planning, two OpenAI transitions, result and cleanup', async () => {
  const s = await setup();
  s.fetcher.mockImplementationOnce(async () => fragmentedResponse(streamText(true)))
    .mockImplementationOnce(async () => fragmentedResponse(streamText(false)));
  const config = {
    image: `registry.cloudflare.com/${'a'.repeat(32)}/synthetic@sha256:${'b'.repeat(64)}`,
    candidateVersion: '00000000-0000-4000-8000-000000000011',
    taskId: s.manifest.taskId, generation: s.manifest.generation, modelContractHash: DEEPSEEK_RESEARCH_CONTRACT,
    notBefore: s.manifest.notBefore, expiresAt: s.manifest.expiresAt,
    researchDatabaseId: '00000000-0000-4000-8000-000000000012', productionDatabaseId: '00000000-0000-4000-8000-000000000013',
  };
  const controlKey = 'c'.repeat(64);
  const broker = vi.fn(async (request: Request) => {
    expect(request.headers.get('Cloudflare-Workers-Version-Overrides')).toBe(`pgc-preflight="${config.candidateVersion}"`);
    return handleProviderResearchCandidate(request, s.options, { id: config.candidateVersion });
  });
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  interface Storage {
    get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>;
    transaction<T>(work: (tx: Storage) => Promise<T>): Promise<T>; setAlarm(at: number): Promise<void>; deleteAlarm(): Promise<void>;
  }
  const storage: Storage = {
    get: async key => structuredClone(values.get(key)), put: async (key, value) => { values.set(key, structuredClone(value)); },
    transaction: work => work(storage), setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
  };
  let host: ProviderNativeRunner;
  const env: ProviderNativeEnv = {
    PROVIDER_NATIVE_RUNNER: { idFromName: name => name, get: () => ({ fetch: request => host.fetch(request) }) },
    PROVIDER_RESEARCH_DB: s.ledger.db, PROVIDER_RESEARCH_BROKER: { fetch: broker },
    PROVIDER_NATIVE_CONTROL_KEY: controlKey, PROVIDER_RESEARCH_AUTH_KEY: authKey, PROVIDER_NATIVE_FIXTURE: JSON.stringify(config),
  };
  let outbound: ProviderNativeOutbound | undefined;
  let runId: string | undefined;
  const text = JSON.stringify(DEEPSEEK_RESEARCH_RESULT);
  const toGateway = (id: string, body: object, path = '/v1/chat/completions') => outbound!.fetch(new Request(`http://pgc-harness.internal${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-pgc-harness-request-id': id }, body: JSON.stringify(body),
  }));
  const container = {
    images: { ccb: config.image }, running: false,
    start: vi.fn(async (options: object) => {
      expect(options).toMatchObject({ image: config.image, enableInternet: false });
      container.running = true;
    }),
    interceptAllOutboundHttp: async (binding: ProviderNativeOutbound) => { outbound = binding; },
    interceptOutboundHttps: vi.fn(async (_pattern: string, _binding: ProviderNativeOutbound) => {}),
    inspect: async () => container.running ? { image: config.image } : null,
    setInactivityTimeout: async () => {},
    destroy: vi.fn(async () => { container.running = false; }),
    getTcpPort: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/health') return Response.json({ status: 'ready' });
      if (path === '/v1/start') {
        const start = await request.json() as { envelope: Record<string, unknown>; envelopeSha256: string; lease: string };
        expect(await harnessHash(canonicalHarness(start.envelope))).toBe(start.envelopeSha256);
        expect(start.envelope).toMatchObject({ purpose: 'review', phase: 'review', protocol: 'openai', model: DEEPSEEK_RESEARCH_MODEL,
          files: s.material.files, imagePaths: s.material.imagePaths });
        expect(start.lease).toMatch(/^[a-f0-9]{64}$/);
        runId = String(start.envelope.runId);
        expect((await toGateway(firstId, s.first, '/v1/messages')).status).toBe(404);
        const first = await toGateway(firstId, s.first);
        expect((await toGateway(secondId, s.second)).status).toBe(404);
        expect(await first.text()).toBe(streamText(true));
        expect(await (await toGateway(secondId, s.second)).text()).toBe(streamText(false));
        expect((await toGateway(thirdId, s.second)).status).toBe(404);
        return Response.json({ state: 'running' }, { status: 202 });
      }
      const outcome = { state: 'succeeded', runId, modelTurns: 2, outputTokens: 20 };
      if (path === '/v1/status') return Response.json(outcome);
      if (path === '/v1/result') return Response.json({ ...outcome, text,
        files: [{ path: 'result.txt', encoding: 'utf8', content: text, sha256: await harnessHash(text) }] });
      return new Response(null, { status: 404 });
    } }),
  };
  host = new ProviderNativeRunner({ storage, container, exports: {
    ProviderNativeOutbound: ({ props }: { props: HarnessOutboundScope }) => new ProviderNativeOutbound({ props }, env),
  } }, env);
  const control = new ProviderNativeControl({}, env);
  const call = async (path: '/run' | '/status') => control.fetch(new Request('http://pgc-provider-native.internal' + path, {
    method: path === '/run' ? 'POST' : 'GET', headers: await signProviderNativeControl(config, controlKey, path),
  }));
  expect((await call('/run')).status).toBe(202);
  expect((await call('/run')).status).toBe(409);
  await host.alarm();
  expect(await (await call('/status')).json()).toMatchObject({ state: 'passed', fixtureId: DEEPSEEK_RESEARCH_FIXTURE_ID,
    modelTurns: 2, outputTokens: 20, containerDestroyed: true, releaseReady: false, transitions: { admitted: 2, completed: 2 } });
  expect(broker.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([PROVIDER_RESEARCH_PLAN, PROVIDER_RESEARCH_MODEL, PROVIDER_RESEARCH_MODEL]);
  expect(s.fetcher.mock.calls.map(([url]) => String(url))).toEqual(Array(2).fill('https://api.deepseek.com/chat/completions'));
  for (const [index, [, init]] of s.fetcher.mock.calls.entries()) {
    expect(JSON.parse(String(init?.body))).toMatchObject({ messages: [s.first, s.second][index].messages, response_format: { type: 'json_object' } });
  }
  expect(container.interceptOutboundHttps).toHaveBeenCalledWith('*', expect.any(ProviderNativeOutbound));
  expect(container.destroy).toHaveBeenCalledOnce();
  expect(alarm).toBeNull();
  expect(await getHarnessRun(s.ledger.db, config)).toMatchObject({ status: 'done', releasedAt: expect.any(Number) });
});
