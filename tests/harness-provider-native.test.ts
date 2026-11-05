import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { providerResearchSchema } from '../scripts/harness-provider-research-schema';
import {
  createHarnessRun, endHarnessRun, finishHarnessRequest, forwardHarnessRequest, getHarnessRunSummary,
  releaseHarnessSlot, reserveHarnessRequest, type HarnessDatabase,
} from '../server/harness-ledger';
import { recordProviderResearchAssistantDigest, publishProviderResearchAssistantDigest, readProviderResearchPriorAssistantDigest } from '../server/harness-provider-research-observer';
import {
  OPUS_RESEARCH_HTML, OPUS_RESEARCH_MODEL, OPUS_RESEARCH_RECORD, OPUS_RESEARCH_TOOLS, OPUS_RESEARCH_TOTAL_CAP,
  OPUS_RESEARCH_TURN_CAP, OPUS_RESEARCH_WIRE, opusResearchFixtureManifest,
} from '../server/harness-provider-fixture';
import {
  ProviderNativeRunnerHost, handleProviderNativeControl, handleProviderNativeOutbound,
  providerNativeConfig, signProviderNativeControl, type ProviderNativeEnv,
} from '../server/harness-provider-native';
import { handleProviderResearchCandidate } from '../server/harness-provider-candidate';
import { canonicalHarness, harnessHash, modelContractHash } from '../server/harness-policy';
import { encryptKey, type ModelConfig } from '../server/settings';
import type { HarnessOutboundScope } from '../server/harness-outbound-scope';

function d1(sqlite: DatabaseSync): HarnessDatabase {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = (values: SQLInputValue[] = []) => ({
        bind: (...args: unknown[]) => bound(args as SQLInputValue[]),
        first: async <T>() => (statement.get(...values) as T | undefined) ?? null,
        run: async () => statement.run(...values),
      });
      return bound();
    },
  };
}

describe('provider research D1 bootstrap', () => {
  it('uses only isolated research tables and settles real ledger telemetry and digest rows', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(providerResearchSchema());
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual([
        { name: 'harness_events' }, { name: 'harness_requests' }, { name: 'harness_runs' },
        { name: 'model_runs' }, { name: 'provider_research_assistant_digests' },
      ]);
      const db = d1(sqlite);
      const now = Date.now();
      const identity = { taskId: 'fixture-task', generation: 'fixture-generation' };
      const input = {
        ...identity, ownerId: 'admin', actor: 'admin', family: 'forge', sourceHash: OPUS_RESEARCH_WIRE.sourceHash, snapshot: { synthetic: true },
        model: { profileId: 'fixture-opus', profileHash: 'a'.repeat(64), purpose: 'game', protocol: 'anthropic', model: OPUS_RESEARCH_MODEL,
          effort: 'high', vision: true, maxOutputTokens: 64_000 },
        now, deadlineAt: now + 60_000, limits: { maxTotalOutputTokens: OPUS_RESEARCH_TOTAL_CAP, maxModelTurns: OPUS_RESEARCH_TURN_CAP, maxRepairs: 0 },
      } as const;
      const allocated = await createHarnessRun(db, input);
      expect(allocated?.run).toMatchObject({ ...identity, modelTurns: 0, status: 'active' });
      expect(await createHarnessRun(db, input)).toBeNull();
      const request = { ...identity, requestId: 'build-0-synthetic' };
      expect(await reserveHarnessRequest(db, request, 'b'.repeat(64), 64_000, now, now, now + 50_000)).toMatchObject({ status: 'reserved' });
      expect(await forwardHarnessRequest(db, request, now + 1)).toBeTruthy();
      expect(await finishHarnessRequest(db, request, { state: 'completed', inputTokens: 20, outputTokens: 15, finishReason: 'tool_use' }, now + 5)).toBeTruthy();
      const assistant = { ...request, assistantSha256: 'c'.repeat(64) };
      await recordProviderResearchAssistantDigest(db, assistant);
      expect(await readProviderResearchPriorAssistantDigest(db, identity)).toBeNull();
      await publishProviderResearchAssistantDigest(db, assistant);
      expect(await readProviderResearchPriorAssistantDigest(db, identity)).toMatchObject({ requestId: request.requestId, assistantSha256: 'c'.repeat(64) });
      expect(await getHarnessRunSummary(db, identity)).toMatchObject({ modelTurns: 1, outputTokens: 15, reservedTokens: 0 });
      expect(sqlite.prepare('SELECT status,purpose,output_tokens,attempts FROM model_runs').get()).toEqual({
        status: 'ok', purpose: 'harness:game', output_tokens: 15, attempts: 1,
      });
      expect(await endHarnessRun(db, identity, 'done', 'runtime_failed', now + 6)).toBe(true);
      await releaseHarnessSlot(db, identity, now + 7);
      expect(sqlite.prepare('SELECT status,released_at FROM harness_runs').get()).toEqual({ status: 'done', released_at: now + 7 });
      expect(await createHarnessRun(db, input)).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});


const image = `registry.cloudflare.com/${'a'.repeat(32)}/pgc-research@sha256:${'b'.repeat(64)}`;
const candidateVersion = '10000000-0000-4000-8000-000000000001';
const fixtureTask = 'fixture-native-task';
const fixtureGeneration = 'fixture-native-generation';
const brokerKey = 'a'.repeat(64);
const controlKey = 'b'.repeat(64);
const fixtureSettingsKey = 'synthetic-settings-key';
const controlOrigin = 'http://pgc-provider-native.internal';

function event(type: string, fields: object = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}
function fixtureStream(first: boolean) {
  const firstPart = event('message_start', { message: { role: 'assistant', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
  const tool = event('content_block_start', {
    index: 0, content_block: { type: 'tool_use', id: 'toolu_synthetic', name: 'mcp__pgc_workspace__write', input: {} },
  }) + event('content_block_delta', {
    index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'record.json', content: OPUS_RESEARCH_RECORD }) },
  }) + event('content_block_stop', { index: 0 });
  return firstPart + (first ? tool : '') +
    event('message_delta', { delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 7 } }) + event('message_stop');
}

async function nativeSetup(options: { mismatchVersion?: boolean; disconnectProvider?: boolean; cancelDownstream?: boolean } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const capacity = new DatabaseSync(':memory:');
  sqlite.exec(providerResearchSchema());
  const db = d1(sqlite);
  const capDB = d1(capacity);
  const profile: ModelConfig = {
    name: 'Synthetic Opus', baseUrl: 'https://synthetic-provider.invalid', model: OPUS_RESEARCH_MODEL,
    protocol: 'anthropic', enabled: true, vision: true, updatedAt: 'fixture',
    encryptedKey: await encryptKey('synthetic-key', fixtureSettingsKey),
  };
  const now = Date.now();
  const config = {
    image, candidateVersion, taskId: fixtureTask, generation: fixtureGeneration,
    modelContractHash: await modelContractHash(profile, 'game'), notBefore: now - 1000, expiresAt: now + 60_000,
    researchDatabaseId: '10000000-0000-4000-8000-000000000002', productionDatabaseId: '10000000-0000-4000-8000-000000000003',
  };
  const manifest = opusResearchFixtureManifest(config);
  // The full pinned matcher has its own byte-level tests. Here a real broker
  // and real ledger use a compact synthetic wire fixture to exercise routing.
  manifest.requestMatches = async (_body, _model, context) => context.run.modelTurns === 0 || !!await context.readPriorAssistantDigest();
  let modelCalls = 0;
  const modelFetch = vi.fn<typeof fetch>(async (): Promise<Response> => {
    if (options.disconnectProvider) throw new Error('Synthetic disconnect before response');
    return new Response(fixtureStream(++modelCalls === 1), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const brokerFetch = vi.fn(async (request: Request) => {
    expect(request.headers.get('Cloudflare-Workers-Version-Overrides')).toBe(`pgc-preflight="${candidateVersion}"`);
    expect(request.headers.get('x-pgc-research-expected-version')).toBe(candidateVersion);
    return handleProviderResearchCandidate(request, {
      DB: db, capacityDB: capDB, authKey: brokerKey, settingsKey: fixtureSettingsKey, manifest,
      loadConfig: async () => profile, fetcher: modelFetch,
      recordAssistantDigest: value => recordProviderResearchAssistantDigest(db, value),
    }, { id: options.mismatchVersion ? '10000000-0000-4000-8000-000000000004' : candidateVersion });
  });
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  interface SyntheticStorage {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    transaction<T>(work: (tx: SyntheticStorage) => Promise<T>): Promise<T>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  }
  const storage: SyntheticStorage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    transaction: work => work(storage),
    setAlarm: async (at: number) => { alarm = at; },
    deleteAlarm: async () => { alarm = null; },
  };
  let outbound: ((request: Request) => Promise<Response>) | undefined;
  let runtimeStart: { envelope: { runId: string }; lease: string } | undefined;
  let runtimeState = 'running';
  const tools = OPUS_RESEARCH_TOOLS.map(name => ({ name, description: 'Synthetic', input_schema: { type: 'object' } }));
  const requestIds = [
    'build-0-10000000-0000-4000-8000-000000000011',
    'build-0-10000000-0000-4000-8000-000000000012',
  ];
  const container = {
    images: { ccb: image }, running: false,
    start: vi.fn(async (options: { image: string; enableInternet: boolean; env: Record<string, string> }) => {
      expect(options.image).toBe(image);
      expect(options.enableInternet).toBe(false);
      expect(Object.keys(options.env).sort()).toEqual(['PGC_HARNESS_CONTROL_TOKEN', 'PGC_HARNESS_GATEWAY_URL']);
      container.running = true;
    }),
    inspect: async () => container.running ? { image } : null,
    destroy: vi.fn(async () => { container.running = false; }),
    interceptAllOutboundHttp: async (binding: { fetch: (request: Request) => Promise<Response> }) => { outbound = binding.fetch; },
    interceptOutboundHttps: async () => {}, setInactivityTimeout: async () => {},
    getTcpPort: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/health') return Response.json({ status: 'ready' });
      if (path === '/v1/start') {
        const body = await request.json() as { envelope: { runId: string }; envelopeSha256: string; lease: string };
        expect(await harnessHash(canonicalHarness(body.envelope))).toBe(body.envelopeSha256);
        expect(body.lease).toMatch(/^[a-f0-9]{64}$/);
        runtimeStart = body;
        for (const id of requestIds) {
          const toGateway = (requestId = id) => new Request('http://pgc-harness.internal/v1/messages', {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-pgc-harness-request-id': requestId },
            body: JSON.stringify({
              model: OPUS_RESEARCH_MODEL, max_tokens: 64_000, stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
              messages: [{ role: 'user', content: 'Synthetic native test' }], tools,
            }),
          });
          const response = await outbound!(toGateway());
          if (id === requestIds[0]) {
            const prematureContinuation = await outbound!(toGateway(requestIds[1]));
            expect(prematureContinuation.status).toBe(404);
          }
          if (!response.ok) { runtimeState = 'failed'; break; }
          if (options.cancelDownstream) {
            await response.body!.cancel();
            expect((await outbound!(toGateway(requestIds[1]))).status).toBe(404);
            runtimeState = 'failed';
            break;
          }
          await response.text();
          const duplicate = await outbound!(toGateway());
          expect(duplicate.status).toBe(404);
        }
        if (runtimeState === 'running') runtimeState = 'succeeded';
        return Response.json({ state: 'running' }, { status: 202 });
      }
      if (path === '/v1/status') return Response.json({ state: runtimeState, runId: runtimeStart?.envelope.runId, modelTurns: 2, outputTokens: 14 });
      if (path === '/v1/result') return Response.json({ state: runtimeState, runId: runtimeStart?.envelope.runId, modelTurns: 2, outputTokens: 14, files: [
        { path: 'game.html', encoding: 'utf8', content: OPUS_RESEARCH_HTML, sha256: await harnessHash(OPUS_RESEARCH_HTML) },
        { path: 'record.json', encoding: 'utf8', content: OPUS_RESEARCH_RECORD, sha256: OPUS_RESEARCH_WIRE.recordSha256 },
      ] });
      return new Response(null, { status: 404 });
    } }),
  };
  let host: ProviderNativeRunnerHost;
  const env: ProviderNativeEnv = {
    PROVIDER_NATIVE_RUNNER: { idFromName: name => name, get: () => ({ fetch: request => host.fetch(request) }) },
    PROVIDER_RESEARCH_DB: db, PROVIDER_RESEARCH_BROKER: { fetch: brokerFetch },
    PROVIDER_NATIVE_CONTROL_KEY: controlKey, PROVIDER_RESEARCH_AUTH_KEY: brokerKey,
    PROVIDER_NATIVE_FIXTURE: JSON.stringify(config),
  };
  const ctx = { storage, container, exports: {
    ProviderNativeOutbound: ({ props }: { props: HarnessOutboundScope }) => ({
      fetch: (request: Request) => handleProviderNativeOutbound(request, env, props),
    }),
  } };
  host = new ProviderNativeRunnerHost(ctx, env);
  const control = async (path: '/run' | '/status', key = controlKey, signedAt = Date.now()) =>
    handleProviderNativeControl(new Request(controlOrigin + path, {
      method: path === '/run' ? 'POST' : 'GET', headers: await signProviderNativeControl(config, key, path, signedAt),
    }), env);
  return { sqlite, capacity, db, host, env, config, control, container, brokerFetch, modelFetch, getAlarm: () => alarm,
    close: () => { sqlite.close(); capacity.close(); } };
}

describe('isolated native provider research adapter', () => {
  it('authenticates the private control, verifies a pinned candidate, runs two scoped synthetic calls and cleans up', async () => {
    const s = await nativeSetup();
    try {
      expect(providerNativeConfig(JSON.stringify({ ...s.config, researchDatabaseId: s.config.productionDatabaseId }))).toBeNull();
      expect((await s.control('/run', brokerKey)).status).toBe(404);
      expect((await s.control('/run', controlKey, Date.now() - 31_000)).status).toBe(404);
      expect((await s.control('/run')).status).toBe(202);
      expect((await s.control('/run')).status).toBe(409);
      expect(s.getAlarm()).not.toBeNull();
      await s.host.alarm();
      const receipt = await (await s.control('/status')).json();
      expect(receipt).toMatchObject({ state: 'passed', releaseReady: false, modelTurns: 2, outputTokens: 14, containerDestroyed: true });
      expect(JSON.stringify(receipt)).not.toContain(OPUS_RESEARCH_RECORD);
      expect(s.brokerFetch).toHaveBeenCalledTimes(3);
      expect(s.modelFetch).toHaveBeenCalledTimes(2);
      expect(s.container.start).toHaveBeenCalledOnce();
      expect(s.container.destroy).toHaveBeenCalledOnce();
      expect(s.getAlarm()).toBeNull();
      await s.host.alarm();
      expect(s.modelFetch).toHaveBeenCalledTimes(2);
    } finally { s.close(); }
  });

  it('keeps default control closed unless a fixed external origin is configured and signed', async () => {
    const s = await nativeSetup();
    const origin = 'https://provider-research-fixture.example.workers.dev';
    try {
      const request = async (signedOrigin: string) => new Request(origin + '/status', {
        headers: await signProviderNativeControl(s.config, controlKey, '/status', Date.now(), signedOrigin),
      });
      expect((await handleProviderNativeControl(await request(origin), s.env, true)).status).toBe(404);
      s.env.PROVIDER_NATIVE_PUBLIC_CONTROL_ORIGIN = origin;
      expect((await handleProviderNativeControl(await request(controlOrigin), s.env, true)).status).toBe(404);
      expect((await handleProviderNativeControl(await request(origin), s.env, true)).status).toBe(200);
      const tampered = await request(origin);
      tampered.headers.set('x-pgc-native-research-nonce', '10000000-0000-4000-8000-000000000099');
      expect((await handleProviderNativeControl(tampered, s.env, true)).status).toBe(404);
    } finally { s.close(); }
  });

  it('latches a candidate-version mismatch before allocating a lease or starting a container', async () => {
    const s = await nativeSetup({ mismatchVersion: true });
    try {
      expect((await s.control('/run')).status).toBe(202);
      await s.host.alarm();
      expect(await (await s.control('/status')).json()).toMatchObject({ state: 'failed', failure: 'broker_version_unverified', containerDestroyed: true });
      expect(s.container.start).not.toHaveBeenCalled();
      expect(s.modelFetch).not.toHaveBeenCalled();
      expect(s.sqlite.prepare('SELECT count(*) AS n FROM harness_runs').get()).toEqual({ n: 0 });
    } finally { s.close(); }
  });

  it('closes an unknown paid outcome without another attempt or a new run', async () => {
    const s = await nativeSetup({ disconnectProvider: true });
    try {
      expect((await s.control('/run')).status).toBe(202);
      await s.host.alarm();
      expect(await (await s.control('/status')).json()).toMatchObject({ state: 'unknown', containerDestroyed: true });
      expect((await s.control('/run')).status).toBe(409);
      await s.host.alarm();
      expect(s.modelFetch).toHaveBeenCalledOnce();
      expect(s.sqlite.prepare('SELECT state,attempts FROM harness_requests').get()).toEqual({ state: 'unknown', attempts: 1 });
    } finally { s.close(); }
  });

  it('rejects a continuation after the downstream canceled the first stream', async () => {
    const s = await nativeSetup({ cancelDownstream: true });
    try {
      expect((await s.control('/run')).status).toBe(202);
      await s.host.alarm();
      const receipt = await (await s.control('/status')).json();
      expect(['failed', 'unknown']).toContain(receipt.state);
      expect(receipt.containerDestroyed).toBe(true);
      expect(s.modelFetch).toHaveBeenCalledOnce();
    } finally { s.close(); }
  });

  it('recovers verified settlement after a transient slot release failure without replaying the run', async () => {
    const s = await nativeSetup();
    const prepare = s.db.prepare;
    let releaseCalls = 0;
    vi.spyOn(s.db, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('UPDATE harness_runs SET released_at=') && ++releaseCalls === 1) throw new Error('Synthetic storage failure');
      return prepare(sql);
    });
    try {
      expect((await s.control('/run')).status).toBe(202);
      await s.host.alarm();
      expect(await (await s.control('/status')).json()).toMatchObject({ state: 'cleanup_pending', modelTurns: 2, outputTokens: 14, containerDestroyed: true });
      expect(s.sqlite.prepare('SELECT status,released_at FROM harness_runs').get()).toEqual({ status: 'done', released_at: null });
      expect(s.getAlarm()).not.toBeNull();
      await s.host.alarm();
      expect(await (await s.control('/status')).json()).toMatchObject({ state: 'passed', modelTurns: 2, outputTokens: 14 });
      expect(s.getAlarm()).toBeNull();
      expect(s.container.start).toHaveBeenCalledOnce();
      expect(s.modelFetch).toHaveBeenCalledTimes(2);
    } finally { s.close(); }
  });

  it('retries container destruction after configuration drift without touching an unverified database', async () => {
    const s = await nativeSetup();
    const changedDb = { prepare: vi.fn<HarnessDatabase['prepare']>(() => { throw new Error('Wrong research DB'); }) };
    try {
      expect((await s.control('/run')).status).toBe(202);
      const originalFixture = s.env.PROVIDER_NATIVE_FIXTURE;
      s.env.PROVIDER_NATIVE_FIXTURE = JSON.stringify({ ...s.config, expiresAt: s.config.expiresAt + 100 });
      s.env.PROVIDER_RESEARCH_DB = changedDb;
      s.container.running = true;
      s.container.destroy.mockRejectedValueOnce(new Error('Synthetic destroy failure'));
      await s.host.alarm();
      expect(s.container.running).toBe(true);
      expect(s.getAlarm()).not.toBeNull();
      await s.host.alarm();
      expect(s.container.running).toBe(false);
      expect(changedDb.prepare).not.toHaveBeenCalled();
      s.env.PROVIDER_NATIVE_FIXTURE = originalFixture;
      s.env.PROVIDER_RESEARCH_DB = s.db;
      await s.host.alarm();
      expect(await (await s.control('/status')).json()).toMatchObject({ state: 'failed', failure: 'research_configuration_changed', containerDestroyed: true });
      expect(s.getAlarm()).toBeNull();
      expect(s.modelFetch).not.toHaveBeenCalled();
    } finally { s.close(); }
  });
});
