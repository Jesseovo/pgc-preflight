/** Private A provider bridge. There is no HTTP route or implicit network transport. */
import type { ComparisonAdmittedSlot, ComparisonGrant, ComparisonStage, ComparisonStreamFrame, ComparisonStreamingTransport, openComparisonLedger } from '../scripts/harness-comparison-ledger';
import { createComparisonSseTransport } from '../scripts/harness-comparison-stream';
import { authorizeHarnessLease, harnessIdentifier, lockHarnessModel, type HarnessDatabase, type HarnessRun } from './harness-ledger';
import { handleHarnessModelRequest } from './harness-gateway';
import { scopeHarnessOutbound, type HarnessOutboundScope } from './harness-outbound-scope';
import { canonicalHarness, harnessHash, modelContractHash } from './harness-policy';
import { HARNESS_MAX_REQUEST_MS, HARNESS_MODEL_HEADERS } from './harness-protocol';
import { tryModelSlot } from './model-capacity';
import { createModelThrottle, retryAfterMs, type ModelThrottleDatabase } from './model-throttle';
import { activeModelProfile, decryptKey, type ModelConfig, type ModelPurpose } from './settings';

type Ledger = Awaited<ReturnType<typeof openComparisonLedger<unknown>>>;
type NativeFetch = (url: string, init: RequestInit) => Promise<Response>;
type Scope = Readonly<{ arm: 'A'; taskId: string; ownerId: string; operation: 'creation' | 'review'; stage: ComparisonStage }>;
type SlotLease = NonNullable<Awaited<ReturnType<typeof tryModelSlot>>>;
type InFlight = {
  stage: ComparisonStage; body: string; headers: Headers;
  vendorStarted: boolean; transportClaimed?: boolean; lease?: SlotLease; providerKey?: string;
};
type Approval = Readonly<{ profileId: string; profileHash: string; providerUrl: string; publicProfileSnapshot: string }>;
type BrokerOptions = {
  grant: ComparisonGrant; slot: ComparisonAdmittedSlot; approval: Approval;
  loadConfig(): Promise<ModelConfig | null>; settingsKey: string; capacityDB: ModelThrottleDatabase; fetcher: NativeFetch;
  waitUntil?(promise: Promise<unknown>): void;
};

const sentinel = 'pgc-comparison-local-placeholder';
const hash = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const publicKeys = ['name', 'model', 'baseUrl', 'protocol', 'enabled', 'vision', 'effort', 'maxOutputTokens', 'updatedAt'];
const deltaKeys = new Set(['content', 'reasoning_content', 'text', 'thinking', 'partial_json', 'arguments', 'signature']);
const internalError = () => new Error('Comparison provider request unavailable');
function requireSafe(condition: unknown): asserts condition { if (!condition) throw internalError(); }
function holdDiagnostics(options: BrokerOptions, diagnostics: Promise<void>) {
  try { options.waitUntil?.(diagnostics); } catch { /* Observation cannot affect forwarding. */ }
}

function allowedStage(scope: Scope, key: string) {
  const creation = scope.operation === 'creation';
  const prefix = (creation ? 'pgc-create-' : 'pgc-review-') + scope.taskId + (creation ? ':' : '-');
  if (!key.startsWith(prefix)) return false;
  const suffix = key.slice(prefix.length);
  if (creation) return /^(build|polish|repair)-[a-f0-9]{24}$/.exec(suffix)?.[1] === scope.stage;
  const review = /^(verify-)?[a-f0-9]{24}(?:-retry-[1-9][0-9]*)?$/.exec(suffix);
  return !!review && (review[1] ? 'review_verify' : 'review') === scope.stage;
}

function checkedHeaders(init: RequestInit, protocol: 'anthropic' | 'openai') {
  let headers: Headers;
  try { headers = new Headers(init.headers); } catch { throw internalError(); }
  const anthropic = protocol === 'anthropic';
  const authorization = anthropic ? 'x-api-key' : 'authorization';
  const allowed = ['accept', 'content-type', 'idempotency-key', authorization, ...(anthropic ? ['anthropic-version'] : [])];
  requireSafe([...headers.keys()].every(key => allowed.includes(key)) && headers.get('accept') === 'text/event-stream' &&
    headers.get('content-type') === 'application/json' && headers.get(authorization) === (anthropic ? sentinel : 'Bearer ' + sentinel) &&
    (!anthropic || headers.get('anthropic-version') === '2023-06-01'));
  return headers;
}

/** Reject credential echoes rather than modifying native bytes or passing an error payload through. */
function credentialGuard(key: string) {
  const tails = new Map<string, string>();
  const remember = (path: string, value: string) => {
    const joined = (tails.get(path) ?? '') + value;
    requireSafe(!joined.includes(key) && (tails.has(path) || tails.size < 256));
    tails.set(path, key.length > 1 ? joined.slice(1 - key.length) : '');
  };
  const inspect = (value: unknown, path: string, field?: string) => {
    if (typeof value === 'string') {
      requireSafe(!value.includes(key));
      if (field && deltaKeys.has(field)) remember(path, value);
    } else if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        requireSafe(!name.includes(key));
        inspect(item, path + '/' + name, name);
      }
    }
  };
  return new TransformStream<ComparisonStreamFrame, ComparisonStreamFrame>({
    transform(frame, controller) {
      const text = decoder.decode(frame.bytes);
      requireSafe(!text.includes(key));
      const data = text.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data && data !== '[DONE]') inspect(JSON.parse(data), '');
      controller.enqueue(frame);
    },
  });
}

async function lockedProvider(options: BrokerOptions, arm: 'A' | 'B') {
  const slot = structuredClone(options.slot), grant = structuredClone(options.grant), approval = { ...options.approval };
  const { loadConfig, settingsKey, capacityDB, fetcher } = options;
  const purpose: ModelPurpose = slot.operation === 'creation' ? 'game' : 'review';
  requireSafe(grant.scope === 'formal' && slot.arm === arm && (slot.operation === 'creation' || slot.operation === 'review') && settingsKey && capacityDB &&
    typeof fetcher === 'function' && hash.test(approval.profileHash) &&
    await harnessHash(approval.publicProfileSnapshot) === slot.modelConfigSha256);
  let frozen: Record<string, unknown>;
  try { frozen = JSON.parse(approval.publicProfileSnapshot); } catch { throw internalError(); }
  const protocol: 'anthropic' | 'openai' = purpose === 'game' ? 'anthropic' : 'openai';
  const cap = purpose === 'game' ? 64_000 : 24_000;
  const providerUrl = purpose === 'game' ? 'https://riffle-api.pages.dev/v1/messages' : 'https://api.deepseek.com/chat/completions';
  const expectedModel = purpose === 'game' ? 'claude-opus-5-5' : 'deepseek-flash';
  requireSafe(frozen && typeof frozen === 'object' && Object.keys(frozen).every(key => publicKeys.includes(key)) &&
    approval.providerUrl === providerUrl && frozen.baseUrl === (purpose === 'game' ? 'https://riffle-api.pages.dev' : 'https://api.deepseek.com') &&
    frozen.protocol === protocol && frozen.model === expectedModel && frozen.enabled === true && frozen.vision === true);

  async function currentProfile(contract: string) {
    const config = await loadConfig();
    const [locked, actualContract] = await Promise.all([lockHarnessModel(config, purpose, cap), modelContractHash(config, purpose)]);
    const selected = activeModelProfile(config, purpose);
    requireSafe(locked?.profileId === approval.profileId && locked.profileHash === approval.profileHash &&
      locked.maxOutputTokens === cap && locked.effort === (purpose === 'game' ? 'high' : 'low') && actualContract === contract && selected);
    const publicProjection = Object.fromEntries(Object.keys(frozen).map(key => [key, selected.profile[key as keyof typeof selected.profile]]));
    requireSafe(canonicalHarness(publicProjection) === canonicalHarness(frozen));
    return selected.profile;
  }
  for (const route of Object.values(slot.stages)) {
    requireSafe(route.protocol === protocol && route.model === expectedModel && route.stream && route.jsonMode === (purpose === 'review') &&
      route.effort === (purpose === 'game' ? 'high' : 'low') && route.maxOutputTokens === cap);
    await currentProfile(route.modelContractHash);
  }
  return { slot, grant, approval, protocol, providerUrl, currentProfile };
}

/** The trusted host owns the admitted slot, provider approval and ledger authority.
 * Register this slot's transports in the same shared ledger before binding its callback. */
export async function createComparisonBaselineBroker(options: BrokerOptions & { authorize(scope: Scope): Promise<boolean> }) {
  const { slot, grant, protocol, providerUrl, currentProfile } = await lockedProvider(options, 'A');
  const { settingsKey, capacityDB, authorize, fetcher } = options;
  requireSafe(typeof authorize === 'function');
  const inFlight = new Map<string, InFlight>();
  const transports = new Map<string, ComparisonStreamingTransport>();
  const identity = (stage: ComparisonStage): Scope => Object.freeze({
    arm: 'A', taskId: slot.taskId, ownerId: slot.ownerId, operation: slot.operation, stage,
  });
  async function allowed(scope: Scope) {
    try { return await authorize(scope) === true; } catch { return false; }
  }
  for (const route of Object.values(slot.stages)) {
    if (transports.has(route.transportId)) {
      requireSafe(transports.get(route.transportId)?.modelContractHash === route.modelContractHash);
      continue;
    }
    const native = createComparisonSseTransport({
      kind: 'approved-provider', modelContractHash: route.modelContractHash, protocol,
      async fetchResponse(input) {
        const context = inFlight.get(input.requestId);
        requireSafe(context && !context.transportClaimed && context.stage === input.stage && slot.taskId === input.taskId && grant.deadlineAt === input.deadlineAt &&
          route.transportId === slot.stages[input.stage]?.transportId && decoder.decode(input.body) === context.body);
        context.transportClaimed = true;
        const scope = identity(input.stage);
        const deadline = Math.min(input.deadlineAt, Date.now() + HARNESS_MAX_REQUEST_MS);
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]);
        try {
          requireSafe(!signal.aborted && await allowed(scope));
          const profile = await currentProfile(route.modelContractHash);
          const apiKey = await decryptKey(profile.encryptedKey, settingsKey);
          requireSafe(apiKey && apiKey !== sentinel && !signal.aborted);
          const runtime = { ...profile, apiKey };
          context.lease = await tryModelSlot(capacityDB, runtime, 'comparison-' + await harnessHash(grant.runId + ':' + slot.slotId + ':' + input.requestId), deadline) ?? undefined;
          if (!context.lease) return new Response(null, { status: 429 });
          const throttle = createModelThrottle(capacityDB, runtime);
          await throttle.wait(signal);
          // A reservation or rate-limit wait may span a role revocation or credential rotation.
          const [authorized] = await Promise.all([allowed(scope), currentProfile(route.modelContractHash)]);
          requireSafe(authorized && !signal.aborted && Date.now() < deadline);
          const headers = new Headers(context.headers);
          headers.set(protocol === 'anthropic' ? 'x-api-key' : 'authorization', protocol === 'anthropic' ? apiKey : 'Bearer ' + apiKey);
          context.providerKey = apiKey;
          context.vendorStarted = true;
          const response = await fetcher(providerUrl, { method: 'POST', headers, body: context.body, signal, redirect: 'manual' });
          if (response.status === 429) {
            await throttle.cooldown(Math.min(300_000, Math.max(1_000, retryAfterMs(response.headers.get('Retry-After')) ?? 30_000))).catch(() => {});
          }
          return response;
        } catch {
          // Only an actual network attempt can make this provider request unknown.
          if (!context.vendorStarted) return new Response(null, { status: 403 });
          throw internalError();
        } finally {
          if (!context.vendorStarted) await context.lease?.release().catch(() => {});
        }
      },
    });
    transports.set(route.transportId, { ...native, async open(input) {
      const response = await native.open(input);
      if (response.kind === 'rejected') return response;
      const key = inFlight.get(input.requestId)?.providerKey;
      requireSafe(key);
      return { ...response, frames: response.frames.pipeThrough(credentialGuard(key)) };
    } });
  }
  requireSafe(transports.size > 0);

  function bind(ledger: Ledger, authority: object) {
    const bound = ledger.bindSlot(authority, slot.slotId, { grant, slot });
    return async (scope: Scope, url: string, init: RequestInit): Promise<Response> => {
      const stage = scope?.stage, route = stage && slot.stages[stage];
      const { method, redirect, signal, body } = init;
      requireSafe(scope?.arm === 'A' && scope.taskId === slot.taskId && scope.ownerId === slot.ownerId && scope.operation === slot.operation &&
        route && url === providerUrl && method === 'POST' && redirect === 'manual' && signal instanceof AbortSignal &&
        !signal.aborted && typeof body === 'string');
      const headers = checkedHeaders(init, protocol);
      const key = headers.get('idempotency-key') ?? '';
      requireSafe(allowedStage(scope, key) && await allowed(identity(stage)));
      const requestId = await harnessHash(key);
      requireSafe(!inFlight.has(requestId));
      const context: InFlight = { stage, body, headers, vendorStarted: false };
      inFlight.set(requestId, context);
      const clean = async (retain: boolean) => {
        if (inFlight.get(requestId) === context) inFlight.delete(requestId);
        context.providerKey = undefined;
        if (!retain) await context.lease?.release().catch(() => {});
      };
      try {
        const outcome = await bound.dispatchStream({ requestId, stage, body: encoder.encode(context.body) }, signal);
        if (!outcome.dispatched) {
          await clean(false);
          throw internalError();
        }
        void outcome.completion.then(receipt => clean(context.vendorStarted && receipt.state === 'unknown'), () => clean(context.vendorStarted));
        holdDiagnostics(options, outcome.diagnostics);
        // A baseline transport can retry selected HTTP statuses; this bridge
        // returns only successful native SSE and surfaces all other results as a fixed error.
        if (!outcome.response?.ok) throw internalError();
        return outcome.response;
      } catch {
        // A completion observer owns cleanup after a successful ledger handoff.
        if (inFlight.get(requestId) === context && !context.vendorStarted) await clean(false);
        throw internalError();
      }
    };
  }

  return { streamingTransports: transports as ReadonlyMap<string, ComparisonStreamingTransport>, bind };
}

export type ComparisonHarnessOutboundScope = HarnessOutboundScope & Readonly<{
  stage: ComparisonStage; stageDeadlineAt: number; requestIdPrefix: string; jsonOutput: boolean;
}>;

/** B only reaches the global budget through the authorized Gateway's private fetch.
 * The Gateway retains its own profile, lease, capacity and per-phase accounting. */
export async function createComparisonHarnessBroker(options: BrokerOptions & {
  harnessDB: HarnessDatabase;
  authorizeRun(run: HarnessRun): Promise<boolean>;
}) {
  const { slot, grant, approval, protocol, providerUrl, currentProfile } = await lockedProvider(options, 'B');
  const { capacityDB, harnessDB, settingsKey, loadConfig, authorizeRun, fetcher } = options;
  requireSafe(harnessDB && harnessDB !== capacityDB && typeof authorizeRun === 'function');
  type GatewayWire = { stage: ComparisonStage; headers: Headers; body: string; providerKey: string; transportClaimed?: boolean; reauthorize(): Promise<boolean> };
  const wires = new Map<string, GatewayWire>();
  const transports = new Map<string, ComparisonStreamingTransport>();
  for (const route of Object.values(slot.stages)) {
    if (transports.has(route.transportId)) {
      requireSafe(transports.get(route.transportId)?.modelContractHash === route.modelContractHash);
      continue;
    }
    const native = createComparisonSseTransport({ kind: 'approved-provider', modelContractHash: route.modelContractHash, protocol,
      async fetchResponse(input) {
        const wire = wires.get(input.requestId);
        requireSafe(wire && !wire.transportClaimed && wire.stage === input.stage && input.taskId === slot.taskId && input.deadlineAt === grant.deadlineAt &&
          route.transportId === slot.stages[input.stage]?.transportId && decoder.decode(input.body) === wire.body);
        wire.transportClaimed = true;
        // The Gateway has already leased production capacity. Revalidate the
        // scope and rotation after the global ledger reservation as well.
        const profileMatches = await currentProfile(route.modelContractHash).then(() => true, () => false);
        const authorized = profileMatches && await wire.reauthorize().catch(() => false);
        if (!authorized || !profileMatches || input.signal.aborted) return new Response(null, { status: 403 });
        return fetcher(providerUrl, { method: 'POST', headers: new Headers(wire.headers), body: wire.body, redirect: 'manual', signal: input.signal });
      },
    });
    transports.set(route.transportId, { ...native, async open(input) {
      const response = await native.open(input);
      if (response.kind === 'rejected') return response;
      const key = wires.get(input.requestId)?.providerKey;
      requireSafe(key);
      return { ...response, frames: response.frames.pipeThrough(credentialGuard(key)) };
    } });
  }
  requireSafe(transports.size > 0);

  function bind(ledger: Ledger, authority: object) {
    const bound = ledger.bindSlot(authority, slot.slotId, { grant, slot });
    return async (request: Request, providedScope: ComparisonHarnessOutboundScope): Promise<Response> => {
      const scope = { ...providedScope };
      const { taskId, generation, lease, stage, requestIdPrefix } = scope, route = slot.stages[stage];
      const repair = stage === 'repair2' ? 2 : stage === 'repair' ? 1 : 0;
      requireSafe(route && taskId === slot.taskId && harnessIdentifier(generation) && hash.test(lease) &&
        requestIdPrefix === stage + '-' + repair + '-' && scope.jsonOutput === route.jsonMode &&
        Number.isSafeInteger(scope.stageDeadlineAt) && scope.stageDeadlineAt > Date.now() &&
        new URL(request.url).pathname === (protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'));
      const forwarded = scopeHarnessOutbound(request, scope);
      const nativeRequestId = forwarded?.headers.get(HARNESS_MODEL_HEADERS.requestId);
      requireSafe(forwarded && harnessIdentifier(nativeRequestId) && nativeRequestId.startsWith(requestIdPrefix));
      const vendorKey = 'pgc-harness-' + await harnessHash([taskId, generation, nativeRequestId].join('\n'));
      const requestId = await harnessHash(vendorKey);
      const creation = slot.operation === 'creation';
      const runMatches = (run: HarnessRun) => run.taskId === taskId && run.generation === generation && run.ownerId === slot.ownerId &&
        run.family === (creation ? 'forge' : 'review') && run.actor === (creation ? 'star' : 'admin') &&
        run.model.purpose === (creation ? 'game' : 'review') && run.model.profileId === approval.profileId &&
        run.model.profileHash === approval.profileHash && run.model.model === route.model && run.model.protocol === protocol &&
        run.model.effort === route.effort && run.model.vision && run.model.maxOutputTokens === route.maxOutputTokens;
      const runAllowed = async (run: HarnessRun) => {
        if (!runMatches(run) || !await authorizeRun(run)) return false;
        // A Harness generation keeps its lease across stages. The signed
        // outbound scope alone cannot authorize a delayed prior-stage request.
        const modelPhase = stage + ':model';
        const active = creation
          ? await harnessDB.prepare("SELECT 1 FROM forge_tasks WHERE id=? AND owner_id=? AND status='running' AND kind='game' AND creative_version=2 AND executor='platform' AND phase IN (?,?)")
            .bind(taskId, slot.ownerId, modelPhase, stage === 'build' ? 'build:waiting' : modelPhase).first()
          : await harnessDB.prepare("SELECT 1 FROM review_jobs WHERE id=? AND owner_id=? AND status='running' AND executor='cloud' AND model_executor='platform' AND stage=?")
            .bind(taskId, slot.ownerId, stage === 'review_verify' ? 'verify' : 'review').first();
        return Boolean(active);
      };
      const reauthorize = async () => Boolean(await authorizeHarnessLease(harnessDB, { taskId, generation }, lease, { authorizeRun: runAllowed }));
      return handleHarnessModelRequest(forwarded, {
        DB: harnessDB, capacityDB, loadConfig, settingsKey, authorizeRun: runAllowed,
        waitUntil: options.waitUntil,
        deadlineAt: Math.min(scope.stageDeadlineAt, grant.deadlineAt), requestIdPrefix, jsonOutput: scope.jsonOutput,
        reviewPhase: stage === 'review' || stage === 'review_verify' ? stage : undefined,
        allowTransportRetry: false,
        fetcher: async (url, init) => {
          requireSafe(String(url) === providerUrl && init?.method === 'POST' && init.redirect === 'manual' &&
            typeof init.body === 'string' && init.signal instanceof AbortSignal && !wires.has(requestId));
          const headers = new Headers(init.headers), apiKey = protocol === 'anthropic' ? headers.get('x-api-key')
            : headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
          requireSafe(apiKey && apiKey !== sentinel && headers.get('idempotency-key') === vendorKey);
          const wire = { stage, headers, body: init.body, providerKey: apiKey, reauthorize };
          wires.set(requestId, wire);
          try {
            const outcome = await bound.dispatchStream({ requestId, stage, body: encoder.encode(wire.body) }, init.signal);
            requireSafe(outcome.dispatched);
            options.waitUntil?.(outcome.completion);
            holdDiagnostics(options, outcome.diagnostics);
            // open() captures the secret guard before returning any response.
            requireSafe(outcome.response);
            return outcome.response;
          } finally {
            wires.delete(requestId);
          }
        },
      });
    };
  }
  return { streamingTransports: transports as ReadonlyMap<string, ComparisonStreamingTransport>, bind };
}
