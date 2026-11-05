import {
  authorizeHarnessLease, createHarnessRun, endHarnessRun, getHarnessRunSummary, harnessIdentifier, harnessSha256,
  releaseHarnessSlot, type HarnessDatabase,
} from './harness-ledger';
import { scopeHarnessOutbound, type HarnessOutboundScope } from './harness-outbound-scope';
import { canonicalHarness, harnessHash } from './harness-policy';
import { HARNESS_MAX_REQUEST_MS, HARNESS_MODEL_HEADERS, isHarnessImage, type LockedHarnessModel } from './harness-protocol';
import { verifyProviderResearchResponse } from './harness-provider-candidate';
import {
  OPUS_RESEARCH_FIXTURE_ID, OPUS_RESEARCH_HTML, OPUS_RESEARCH_MODEL, OPUS_RESEARCH_OUTPUT_CAP,
  OPUS_RESEARCH_PHASE, OPUS_RESEARCH_RECORD, OPUS_RESEARCH_TOOLS, OPUS_RESEARCH_TOTAL_CAP, OPUS_RESEARCH_TURN_CAP,
  OPUS_RESEARCH_WIRE, opusResearchFixtureEnvelope,
} from './harness-provider-fixture';
import { PROVIDER_RESEARCH_MODEL, PROVIDER_RESEARCH_PLAN, signHarnessProviderResearch } from './harness-provider-research';
import { readProviderResearchPriorAssistantDigest } from './harness-provider-research-observer';

type FetchBinding = { fetch(request: Request): Promise<Response> };
type ObjectBinding = { idFromName(name: string): unknown; get(id: unknown): FetchBinding };
export type ProviderNativeEnv = {
  PROVIDER_NATIVE_RUNNER: ObjectBinding;
  PROVIDER_RESEARCH_DB: HarnessDatabase;
  PROVIDER_RESEARCH_BROKER: FetchBinding;
  PROVIDER_NATIVE_CONTROL_KEY: string;
  PROVIDER_RESEARCH_AUTH_KEY: string;
  PROVIDER_NATIVE_FIXTURE: string;
  PROVIDER_NATIVE_PUBLIC_CONTROL_ORIGIN?: string;
  PROVIDER_NATIVE_VERSION?: { id?: string };
};
type NativeConfig = {
  image: string; candidateVersion: string; taskId: string; generation: string; modelContractHash: string;
  notBefore: number; expiresAt: number; researchDatabaseId: string; productionDatabaseId: string;
};
type NativeStage = 'armed' | 'running' | 'cleanup_pending' | 'passed' | 'failed' | 'unknown';
type NativeReceipt = {
  state: NativeStage; fixtureId: string; image: string; candidateVersion: string; sourceHash: string;
  modelContractHash: string; releaseReady: false; failure?: string; completedAt?: number;
  modelTurns?: number; outputTokens?: number; containerDestroyed?: boolean;
};
type Latch = { config: NativeConfig; receipt: NativeReceipt; requestIds: string[]; completedTurns: number; cleanupAttempts: number; verified?: true };
type Plan = Parameters<typeof createHarnessRun>[1] & {
  model: LockedHarnessModel; deadlineAt: number; phase: string; maxRequestOutputTokens: number;
};
type RuntimeSession = { control: string; runId: string };
type NativePath = '/run' | '/status';
type NativeControlStage = 'configuration' | 'origin' | 'route' | 'headers' | 'timestamp' | 'signature' | 'body' | 'dispatch' | 'runner';
const maxCleanupAttempts = 3;

const internal = 'http://pgc-provider-native.internal';
const gateway = 'http://pgc-harness.internal';
const broker = 'https://pgc.ovoxin.top';
const brokerWorker = 'pgc-preflight';
const hexPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const requestPattern = /^build-0-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const deny = () => json({ error: 'research_route_denied' }, 404);
const fail = (code: string) => new NativeFailure(code);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (a: unknown, b: unknown) => canonicalHarness(a) === canonicalHarness(b);
const secret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
const fromHex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], item => Number.parseInt(item, 16));
const identity = ({ taskId, generation }: NativeConfig) => ({ taskId, generation });
const slotName = ({ taskId, generation }: NativeConfig) => `${taskId}:${generation}`;
const limits = { maxTotalOutputTokens: OPUS_RESEARCH_TOTAL_CAP, maxModelTurns: OPUS_RESEARCH_TURN_CAP, maxRepairs: 0 };
class NativeFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

export function providerNativeConfig(value: string): NativeConfig | null {
  try {
    const raw = JSON.parse(value);
    if (!exactKeys(raw, ['image', 'candidateVersion', 'taskId', 'generation', 'modelContractHash',
      'notBefore', 'expiresAt', 'researchDatabaseId', 'productionDatabaseId'])) return null;
    const config = raw as NativeConfig;
    if (!isHarnessImage(config.image) || !uuidPattern.test(config.candidateVersion) ||
        !harnessIdentifier(config.taskId) || !harnessIdentifier(config.generation) || !hexPattern.test(config.modelContractHash) ||
        !uuidPattern.test(config.researchDatabaseId) || !uuidPattern.test(config.productionDatabaseId) ||
        config.researchDatabaseId === config.productionDatabaseId || !Number.isSafeInteger(config.notBefore) ||
        !Number.isSafeInteger(config.expiresAt) || config.notBefore <= 0 || config.expiresAt <= config.notBefore ||
        config.expiresAt - config.notBefore > HARNESS_MAX_REQUEST_MS) return null;
    return config;
  } catch {
    return null;
  }
}

function configured(env: ProviderNativeEnv) {
  if (!env.PROVIDER_NATIVE_RUNNER || !env.PROVIDER_RESEARCH_DB || !env.PROVIDER_RESEARCH_BROKER ||
      !hexPattern.test(env.PROVIDER_NATIVE_CONTROL_KEY) || !hexPattern.test(env.PROVIDER_RESEARCH_AUTH_KEY) ||
      env.PROVIDER_NATIVE_CONTROL_KEY === env.PROVIDER_RESEARCH_AUTH_KEY) return null;
  return providerNativeConfig(env.PROVIDER_NATIVE_FIXTURE);
}

function controlBytes(config: NativeConfig, method: string, origin: string, path: string, at: number, nonce: string) {
  return encoder.encode(canonicalHarness(['pgc-provider-native-control-v1', config, method, origin, path, at, nonce]));
}

async function controlKey(key: string, usage: 'sign' | 'verify') {
  if (!hexPattern.test(key)) throw fail('control_key_invalid');
  return crypto.subtle.importKey('raw', fromHex(key), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signProviderNativeControl(config: NativeConfig, key: string, path: NativePath,
  at = Date.now(), origin = internal) {
  const method = path === '/run' ? 'POST' : 'GET';
  const nonce = crypto.randomUUID();
  const digest = await crypto.subtle.sign('HMAC', await controlKey(key, 'sign'), controlBytes(config, method, origin, path, at, nonce));
  return new Headers({
    'x-pgc-native-research-at': String(at),
    'x-pgc-native-research-nonce': nonce,
    'x-pgc-native-research-signature': Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join(''),
  });
}

async function readBytes(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (let i = 0; i < 1024; i++) {
      const { done, value } = await reader.read();
      if (done) {
        const out = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
        return out;
      }
      length += value.byteLength;
      if (length > maximum) break;
      chunks.push(value);
    }
    throw fail('research_body_limit');
  };
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fail('research_body_timeout')), 2000); });
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readJson(response: Response, maximum = 16_384): Promise<unknown> {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(response.body, maximum)));
}

function streamWithCompletion(body: ReadableStream<Uint8Array>, requestSignal: AbortSignal,
  complete: (signal: AbortSignal) => Promise<Response>) {
  const reader = body.getReader();
  const downstream = new AbortController();
  const signal = AbortSignal.any([requestSignal, downstream.signal]);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) {
          if (signal.aborted || !(await complete(signal)).ok) throw fail('research_stream_completion_unconfirmed');
          signal.throwIfAborted();
          signal.removeEventListener('abort', abort);
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        signal.removeEventListener('abort', abort);
        abort();
        controller.error(error);
      }
    },
    cancel() {
      signal.removeEventListener('abort', abort);
      downstream.abort();
      return reader.cancel();
    },
  }, { highWaterMark: 0 });
}

/** Public control is closed unless the isolated Worker origin is explicitly configured. */
export async function handleProviderNativeControl(request: Request, env: ProviderNativeEnv, external = false): Promise<Response> {
  const url = new URL(request.url);
  const origin = external ? env.PROVIDER_NATIVE_PUBLIC_CONTROL_ORIGIN : internal;
  if (!['/run', '/status'].includes(url.pathname)) return deny();
  const identify = (response: Response, stage: NativeControlStage) => {
    const headers = new Headers(response.headers);
    headers.set('x-pgc-native-research-control', 'hmac-v1');
    headers.set('x-pgc-native-research-stage', stage);
    const version = env.PROVIDER_NATIVE_VERSION?.id;
    if (version && uuidPattern.test(version)) headers.set('x-pgc-native-research-version', version);
    return new Response(response.body, { status: response.status, headers });
  };
  const reject = (stage: NativeControlStage) => identify(deny(), stage);
  if (!origin || external && !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(origin)) return reject('configuration');
  if (url.origin !== origin) return reject('origin');
  const config = configured(env);
  if (!config) return reject('configuration');
  const method = url.pathname === '/run' ? 'POST' : 'GET';
  if (url.search || url.hash || request.method !== method || request.headers.has('authorization') || request.headers.has('cookie')) return reject('route');
  const at = Number(request.headers.get('x-pgc-native-research-at'));
  const signature = request.headers.get('x-pgc-native-research-signature') ?? '';
  const nonce = request.headers.get('x-pgc-native-research-nonce') ?? '';
  if (!hexPattern.test(signature) || !uuidPattern.test(nonce)) return reject('headers');
  if (!Number.isSafeInteger(at) || Math.abs(Date.now() - at) > 30_000) return reject('timestamp');
  try {
    if (!await crypto.subtle.verify('HMAC', await controlKey(env.PROVIDER_NATIVE_CONTROL_KEY, 'verify'), fromHex(signature),
      controlBytes(config, method, origin, url.pathname, at, nonce))) return reject('signature');
  } catch { return reject('signature'); }
  try {
    if ((await readBytes(request.body, 0)).length !== 0) return reject('body');
  } catch { return reject('body'); }
  try {
    const runner = env.PROVIDER_NATIVE_RUNNER.get(env.PROVIDER_NATIVE_RUNNER.idFromName(slotName(config)));
    return identify(await runner.fetch(new Request(internal + url.pathname, { method })), 'runner');
  } catch { return identify(json({ error: 'research_runner_unavailable' }, 503), 'dispatch'); }
}

async function signedBrokerRequest(env: ProviderNativeEnv, config: NativeConfig, path: string, requestId: string,
  lease: string, body: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
  const method = path === PROVIDER_RESEARCH_PLAN ? 'GET' : 'POST';
  const headers = await signHarnessProviderResearch(env.PROVIDER_RESEARCH_AUTH_KEY, {
    ...identity(config), method, path, requestId, timestamp: Date.now(), lease, body, expectedVersion: config.candidateVersion,
  });
  headers.set('Cloudflare-Workers-Version-Overrides', `${brokerWorker}="${config.candidateVersion}"`);
  const request = new Request(broker + path, { method, headers, signal, ...(method === 'POST' && { body }) });
  const response = await env.PROVIDER_RESEARCH_BROKER.fetch(request);
  if (!await verifyProviderResearchResponse(request, response, config.candidateVersion, env.PROVIDER_RESEARCH_AUTH_KEY)) {
    void response.body?.cancel().catch(() => {});
    throw fail('broker_version_unverified');
  }
  return response;
}

function exactPlan(value: unknown, config: NativeConfig): Plan {
  if (!exactKeys(value, ['taskId', 'generation', 'ownerId', 'actor', 'family', 'sourceHash', 'snapshot', 'model',
    'limits', 'maxRequestOutputTokens', 'phase', 'deadlineAt'])) throw fail('broker_plan_rejected');
  const plan = value as unknown as Plan;
  const snapshot = {
    kind: 'provider-research-v1', fixtureId: OPUS_RESEARCH_FIXTURE_ID, sourceHash: OPUS_RESEARCH_WIRE.sourceHash,
    modelContractHash: config.modelContractHash, purpose: 'game', phase: OPUS_RESEARCH_PHASE,
    notBefore: config.notBefore, expiresAt: config.expiresAt, maxRequestOutputTokens: OPUS_RESEARCH_OUTPUT_CAP,
    limits, toolNames: [...OPUS_RESEARCH_TOOLS],
  };
  const model = plan.model;
  if (plan.taskId !== config.taskId || plan.generation !== config.generation || plan.ownerId !== 'admin' || plan.actor !== 'admin' ||
      plan.family !== 'forge' || plan.sourceHash !== OPUS_RESEARCH_WIRE.sourceHash || plan.phase !== OPUS_RESEARCH_PHASE ||
      plan.deadlineAt !== config.expiresAt || plan.maxRequestOutputTokens !== OPUS_RESEARCH_OUTPUT_CAP ||
      !same(plan.limits, limits) || JSON.stringify(plan.snapshot) !== JSON.stringify(snapshot) ||
      !exactKeys(model, ['profileId', 'profileHash', 'model', 'protocol', 'purpose', 'effort', 'vision', 'maxOutputTokens']) ||
      !harnessIdentifier(model.profileId) || !hexPattern.test(model.profileHash) ||
      model.model !== OPUS_RESEARCH_MODEL || model.protocol !== 'anthropic' || model.purpose !== 'game' ||
      model.effort !== 'high' || model.vision !== true || model.maxOutputTokens !== OPUS_RESEARCH_OUTPUT_CAP) {
    throw fail('broker_plan_rejected');
  }
  return plan;
}

export async function handleProviderNativeOutbound(request: Request, env: ProviderNativeEnv, scope: HarnessOutboundScope) {
  const config = configured(env);
  const forwarded = scopeHarnessOutbound(request, scope);
  if (!config || !forwarded || new URL(forwarded.url).pathname !== '/v1/messages' ||
      scope.taskId !== config.taskId || scope.generation !== config.generation || !hexPattern.test(scope.lease) ||
      Date.now() < config.notBefore || Date.now() >= config.expiresAt) return deny();
  const requestId = forwarded.headers.get(HARNESS_MODEL_HEADERS.requestId);
  if (!requestPattern.test(requestId ?? '') || forwarded.headers.has('cookie')) return deny();
  try {
    const body = await readBytes(forwarded.body, 1024 * 1024);
    if (forwarded.signal.aborted || Date.now() >= config.expiresAt) return deny();
    const runner = env.PROVIDER_NATIVE_RUNNER.get(env.PROVIDER_NATIVE_RUNNER.idFromName(slotName(config)));
    const mark = (path: '/forward' | '/completed', signal: AbortSignal) => runner.fetch(new Request(internal + path, {
      method: 'POST', headers: { authorization: `Bearer ${scope.lease}`, [HARNESS_MODEL_HEADERS.requestId]: requestId! }, signal,
    }));
    const admitted = await mark('/forward', forwarded.signal);
    if (!admitted.ok) return deny();
    const signal = AbortSignal.any([forwarded.signal, AbortSignal.timeout(Math.max(1, config.expiresAt - Date.now()))]);
    const response = await signedBrokerRequest(env, config, PROVIDER_RESEARCH_MODEL, requestId!, scope.lease, body, signal);
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      void response.body?.cancel().catch(() => {});
      return json({ error: 'research_stream_denied' }, 502);
    }
    const stream = streamWithCompletion(response.body, signal, streamSignal => mark('/completed', streamSignal));
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  } catch {
    return json({ error: 'research_stream_unavailable' }, 503);
  }
}

export class ProviderNativeRunnerHost {
  private work?: Promise<void>;
  constructor(private ctx: any, private env: ProviderNativeEnv) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const config = configured(this.env);
    if (!config || url.origin !== internal || url.search || url.hash) return deny();
    const storage = this.ctx.storage;
    if (url.pathname === '/status' && request.method === 'GET') {
      const latch = await storage.get('research-latch') as Latch | undefined;
      return json(latch?.receipt ?? { state: 'idle', releaseReady: false });
    }
    if (['/forward', '/completed'].includes(url.pathname) && request.method === 'POST') {
      return await this.modelTransition(request, config, url.pathname === '/completed') ? new Response(null, { status: 204 }) : deny();
    }
    if (url.pathname !== '/run' || request.method !== 'POST' || Date.now() < config.notBefore || Date.now() >= config.expiresAt ||
        this.ctx.container?.images?.ccb !== config.image) return deny();
    const receipt: NativeReceipt = {
      state: 'armed', fixtureId: OPUS_RESEARCH_FIXTURE_ID, image: config.image, candidateVersion: config.candidateVersion,
      sourceHash: OPUS_RESEARCH_WIRE.sourceHash, modelContractHash: config.modelContractHash, releaseReady: false,
    };
    const claimed = await storage.transaction(async (tx: any) => {
      if (await tx.get('research-latch')) return false;
      await tx.put('research-latch', { config, receipt, requestIds: [], completedTurns: 0, cleanupAttempts: 0 } satisfies Latch);
      await tx.setAlarm(Date.now());
      return true;
    });
    return claimed ? json(receipt, 202) : json({ error: 'research_already_latched' }, 409);
  }

  private async modelTransition(request: Request, config: NativeConfig, completing: boolean) {
    const requestId = request.headers.get(HARNESS_MODEL_HEADERS.requestId);
    const lease = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!requestId || !requestPattern.test(requestId) || !lease || request.signal.aborted || Date.now() >= config.expiresAt) return false;
    const run = await authorizeHarnessLease(this.env.PROVIDER_RESEARCH_DB, identity(config), lease, {
      authorizeRun: async candidate => candidate.actor === 'admin' && candidate.ownerId === 'admin' &&
        candidate.family === 'forge' && candidate.sourceHash === OPUS_RESEARCH_WIRE.sourceHash &&
        candidate.model.model === OPUS_RESEARCH_MODEL && candidate.model.purpose === 'game',
    });
    if (!run || !completing && run.modelTurns >= OPUS_RESEARCH_TURN_CAP) return false;
    const prior = run.modelTurns === 1 ? await readProviderResearchPriorAssistantDigest(this.env.PROVIDER_RESEARCH_DB, run) : null;
    if (completing) {
      const terminal = await this.env.PROVIDER_RESEARCH_DB.prepare(`SELECT state,finish_reason FROM harness_requests
        WHERE task_id=? AND generation=? AND request_id=?`).bind(config.taskId, config.generation, requestId)
        .first<{ state: string; finish_reason: string }>();
      if (terminal?.state !== 'completed' || terminal.finish_reason !== (run.modelTurns === 1 ? 'tool_use' : 'end_turn')) return false;
    }
    return this.ctx.storage.transaction(async (tx: any) => {
      const latch = await tx.get('research-latch') as Latch | undefined;
      if (!latch || latch.receipt.state !== 'running' || !same(latch.config, config) ||
          request.signal.aborted || latch.requestIds.length !== run.modelTurns ||
          (run.modelTurns === 1 && prior?.requestId !== latch.requestIds[0])) return false;
      if (completing) {
        if (latch.completedTurns !== run.modelTurns - 1 || latch.requestIds.at(-1) !== requestId) return false;
        latch.completedTurns++;
      } else {
        if (latch.completedTurns !== run.modelTurns || latch.requestIds.includes(requestId)) return false;
        latch.requestIds.push(requestId);
      }
      await tx.put('research-latch', latch);
      return true;
    });
  }

  alarm(): Promise<void> {
    return this.work ??= this.advance().finally(() => { this.work = undefined; });
  }

  private async advance() {
    const storage = this.ctx.storage;
    const latch = await storage.get('research-latch') as Latch | undefined;
    if (!latch || ['passed', 'failed', 'unknown'].includes(latch.receipt.state)) return;
    const config = configured(this.env);
    if (!config || !same(config, latch.config)) {
      // The original D1 binding cannot be verified after configuration drift.
      // Destroy locally without writing to a possibly different database.
      latch.receipt.failure ??= 'research_configuration_changed';
      await this.cleanup(latch, false);
      return;
    }
    if (latch.receipt.state === 'armed' && Date.now() >= config.notBefore && Date.now() < config.expiresAt) {
      latch.receipt.state = 'running';
      await storage.transaction(async (tx: any) => {
        await tx.put('research-latch', latch);
        await tx.setAlarm(config.expiresAt);
      });
      try {
        await this.run(config);
      } catch (error) {
        const current = await storage.get('research-latch') as Latch;
        current.receipt.failure = error instanceof NativeFailure ? error.code : 'research_execution_failed';
        await this.cleanup(current);
      }
      return;
    }
    if (latch.receipt.state !== 'cleanup_pending') latch.receipt.failure = 'research_interrupted';
    await this.cleanup(latch);
  }

  private async run(config: NativeConfig) {
    const planResponse = await signedBrokerRequest(this.env, config, PROVIDER_RESEARCH_PLAN, 'plan', '', new Uint8Array(),
      AbortSignal.timeout(Math.min(5000, Math.max(1, config.expiresAt - Date.now()))));
    if (!planResponse.ok) throw fail('broker_plan_unavailable');
    const plan = exactPlan(await readJson(planResponse), config);
    if (Date.now() >= config.expiresAt || this.ctx.container.running || this.ctx.container.images.ccb !== config.image) throw fail('research_container_unavailable');
    const allocated = await createHarnessRun(this.env.PROVIDER_RESEARCH_DB, plan);
    if (!allocated) throw fail('research_lease_unavailable');

    const session = { control: secret(), runId: crypto.randomUUID() };
    const container = this.ctx.container;
    await container.start({ image: config.image, instance: 'standard-1', enableInternet: false,
      env: { PGC_HARNESS_CONTROL_TOKEN: session.control, PGC_HARNESS_GATEWAY_URL: gateway } });
    const outbound = this.ctx.exports.ProviderNativeOutbound({ props: { ...identity(config), lease: allocated.lease } });
    await container.interceptAllOutboundHttp(outbound);
    await container.interceptOutboundHttps('*', outbound);
    await container.setInactivityTimeout(Math.max(1000, config.expiresAt - Date.now() + 10_000));
    await this.waitForRuntime(config, session);
    if ((await container.inspect())?.image !== config.image) throw fail('research_image_mismatch');
    const envelope = await opusResearchFixtureEnvelope({ ...identity(config), runId: session.runId }, config.expiresAt);
    // Never resend this POST if the runtime accepted it but its reply was lost.
    const start = await this.runtime(config, session, '/v1/start', {
      envelope, envelopeSha256: await harnessHash(canonicalHarness(envelope)), lease: allocated.lease,
    });
    if (start.status !== 202) throw fail('research_runtime_start_rejected');
    void start.body?.cancel().catch(() => {});
    const outputTokens = await this.waitForCompletion(config, session);
    const latch = await this.ctx.storage.get('research-latch') as Latch;
    await this.verifySettlement(config, latch, outputTokens);
    latch.verified = true;
    await this.cleanup(latch);
  }

  private runtime(config: NativeConfig, session: RuntimeSession, path: string, body?: object): Promise<Response> {
    const remaining = config.expiresAt - Date.now();
    if (remaining <= 0) throw fail('research_deadline');
    return this.ctx.container.getTcpPort(8080).fetch(new Request('http://container' + path, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(Math.min(5000, remaining)),
      headers: { authorization: `Bearer ${session.control}`, 'content-type': 'application/json', 'x-pgc-harness-run': session.runId },
      ...(body && { body: JSON.stringify(body) }),
    }));
  }

  private async waitForRuntime(config: NativeConfig, session: RuntimeSession) {
    const bootDeadline = Math.min(Date.now() + 18_000, config.expiresAt);
    while (Date.now() < bootDeadline) {
      try {
        const response = await this.runtime(config, session, '/v1/health');
        if (response.ok && (await readJson(response, 1024) as { status?: unknown }).status === 'ready') return;
      } catch { /* Only readiness reads retry. */ }
      await wait(250);
    }
    throw fail('research_runtime_unavailable');
  }

  private async waitForCompletion(config: NativeConfig, session: RuntimeSession) {
    while (Date.now() < config.expiresAt) {
      const response = await this.runtime(config, session, '/v1/status');
      if (!response.ok) throw fail('research_runtime_status_unknown');
      const status = await readJson(response, 4096);
      if (!isObject(status) || status.runId !== session.runId) throw fail('research_runtime_status_unknown');
      if (status.state === 'running') { await wait(1000); continue; }
      if (status.state !== 'succeeded' || status.modelTurns !== OPUS_RESEARCH_TURN_CAP ||
          typeof status.outputTokens !== 'number' || !Number.isSafeInteger(status.outputTokens) ||
          status.outputTokens <= 0 || status.outputTokens > OPUS_RESEARCH_TOTAL_CAP) throw fail('research_runtime_incomplete');
      const result = await this.runtime(config, session, '/v1/result');
      if (!result.ok) throw fail('research_fixture_result_missing');
      const value = await readJson(result);
      if (!isObject(value) || value.runId !== session.runId || value.state !== 'succeeded' ||
          value.modelTurns !== OPUS_RESEARCH_TURN_CAP || value.outputTokens !== status.outputTokens || !same(value.files, [
        { path: 'game.html', encoding: 'utf8', content: OPUS_RESEARCH_HTML, sha256: await harnessHash(OPUS_RESEARCH_HTML) },
        { path: 'record.json', encoding: 'utf8', content: OPUS_RESEARCH_RECORD, sha256: OPUS_RESEARCH_WIRE.recordSha256 },
      ])) throw fail('research_fixture_result_mismatch');
      return status.outputTokens;
    }
    throw fail('research_deadline');
  }

  private async verifySettlement(config: NativeConfig, latch: Latch, outputTokens: number) {
    const db = this.env.PROVIDER_RESEARCH_DB;
    const [first, last] = latch.requestIds;
    if (latch.requestIds.length !== OPUS_RESEARCH_TURN_CAP || latch.completedTurns !== OPUS_RESEARCH_TURN_CAP) throw fail('research_settlement_missing');
    const summary = await getHarnessRunSummary(db, identity(config));
    const prior = await readProviderResearchPriorAssistantDigest(db, identity(config));
    const counts = await db.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN request_id=? AND state='completed' AND attempts=1 AND finish_reason='tool_use' AND input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS tool,
      sum(CASE WHEN request_id=? AND state='completed' AND attempts=1 AND finish_reason='end_turn' AND input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS final
      FROM harness_requests WHERE task_id=? AND generation=?`)
      .bind(first, last, config.taskId, config.generation).first<{ total: number; tool: number; final: number }>();
    if (summary?.status !== 'active' || summary.modelTurns !== OPUS_RESEARCH_TURN_CAP || summary.reservedTokens !== 0 ||
        summary.outputTokens !== outputTokens || prior?.requestId !== first || counts?.total !== 2 || counts.tool !== 1 || counts.final !== 1) {
      throw fail('research_settlement_missing');
    }
    latch.receipt.modelTurns = summary.modelTurns;
    latch.receipt.outputTokens = summary.outputTokens;
  }

  private async cleanup(latch: Latch, originalDatabase = true) {
    const { config, receipt } = latch;
    const db = this.env.PROVIDER_RESEARCH_DB;
    const storage = this.ctx.storage;
    receipt.state = 'cleanup_pending';
    latch.cleanupAttempts++;
    await storage.transaction(async (tx: any) => {
      await tx.put('research-latch', latch);
      if (latch.cleanupAttempts < maxCleanupAttempts) await tx.setAlarm(Date.now() + 5000);
    });
    const destroyed = this.destroyContainer();
    let summary;
    let ledgerClosed = false;
    try {
      if (originalDatabase) {
        summary = await getHarnessRunSummary(db, identity(config));
        if (summary?.status === 'active') {
          const verified = latch.verified && !receipt.failure;
          if (verified && !await endHarnessRun(db, identity(config), 'done')) {
            receipt.failure = 'research_settlement_missing';
          }
          if (!verified || receipt.failure) {
            await endHarnessRun(db, identity(config), 'failed', receipt.failure === 'research_deadline' ? 'deadline' : 'interrupted');
          }
          summary = await getHarnessRunSummary(db, identity(config));
        } else if (summary?.status === 'failed' || summary?.status === 'unknown') {
          // The run CAS may have committed before its outstanding request rows were closed.
          await endHarnessRun(db, identity(config), 'failed', summary.failureCode ?? 'interrupted');
        }
        ledgerClosed = !summary || summary.status !== 'active';
      }
    } catch { /* Still destroy the container. */ }
    receipt.containerDestroyed = await destroyed;
    if (ledgerClosed && receipt.containerDestroyed) {
      try {
        if (summary) await releaseHarnessSlot(db, identity(config));
        receipt.state = summary?.status === 'done' && latch.verified && !receipt.failure ? 'passed' : summary?.status === 'unknown' ? 'unknown' : 'failed';
        receipt.completedAt = Date.now();
      } catch { /* Leave the slot and cleanup latched. */ }
    }
    await storage.transaction(async (tx: any) => {
      await tx.put('research-latch', latch);
      if (receipt.state === 'cleanup_pending' && latch.cleanupAttempts < maxCleanupAttempts) await tx.setAlarm(Date.now() + 5000);
      else await tx.deleteAlarm();
    });
  }

  private async destroyContainer() {
    try {
      if (this.ctx.container.running) await this.ctx.container.destroy();
      return !this.ctx.container.running && await this.ctx.container.inspect() === null;
    } catch { return false; }
  }
}
