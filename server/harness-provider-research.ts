import { handleHarnessModelRequest, type HarnessGatewayOptions } from './harness-gateway';
import { authorizeHarnessLease, endHarnessRun, harnessIdentifier, harnessSha256, lockHarnessModel, type HarnessRun } from './harness-ledger';
import { canonicalHarness, modelContractHash } from './harness-policy';
import { HARNESS_MAX_REQUEST_MS, HARNESS_MAX_REQUEST_TOKENS, HARNESS_MODEL_HEADERS, type HarnessRunIdentity, type LockedHarnessModel } from './harness-protocol';
import { observeProviderResearchAssistant, publishProviderResearchAssistantDigest, readProviderResearchPriorAssistantDigest,
  revokeProviderResearchAssistantDigest, type ProviderResearchAssistantReceipt } from './harness-provider-research-observer';
import { MODEL_PURPOSES, type ModelPurpose } from './settings';

export { providerResearchAssistantDigest, recordProviderResearchAssistantDigest } from './harness-provider-research-observer';

export const PROVIDER_RESEARCH_PLAN = '/api/__harness-provider-research/plan';
export const PROVIDER_RESEARCH_MODEL = '/api/__harness-provider-research/model';
export const PROVIDER_RESEARCH_EXPECTED_VERSION_HEADER = 'x-pgc-research-expected-version';
// The existing ledger reserves this owner marker for administrator-owned runs.
// The mandatory research snapshot and separate database identify the fixture.
export const PROVIDER_RESEARCH_OWNER = 'admin';
const authHeaders = { at: 'x-pgc-research-at', sha: 'x-pgc-research-body-sha256', signature: 'x-pgc-research-signature' };
const hash = /^[a-f0-9]{64}$/;
const requestUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxClockDifferenceMs = 30_000;
const maxFixtureBytes = 1024 * 1024;
const encoder = new TextEncoder();

export interface ProviderResearchManifest extends HarnessRunIdentity {
  fixtureId: string;
  sourceHash: string;
  modelContractHash: string;
  purpose: ModelPurpose;
  phase: string;
  notBefore: number;
  expiresAt: number;
  maxRequestOutputTokens: number;
  maxTotalOutputTokens: number;
  maxModelTurns: number;
  toolNames: readonly string[];
  /** Checks fixed system/user text, image bytes, tool schemas, and any correlated continuation. */
  requestMatches(body: Readonly<Record<string, unknown>>, model: Readonly<LockedHarnessModel>,
    context: { requestId: string; run: Readonly<HarnessRun>; readPriorAssistantDigest(): Promise<string | null> }): boolean | Promise<boolean>;
}

export interface ProviderResearchOptions extends Pick<HarnessGatewayOptions, 'DB' | 'loadConfig' | 'settingsKey' | 'fetcher' | 'now' | 'waitUntil'> {
  capacityDB: NonNullable<HarnessGatewayOptions['capacityDB']>;
  authKey: string;
  manifest: ProviderResearchManifest;
  /** Mandatory for an Anthropic fixture with a tool continuation. Use the research ledger. */
  recordAssistantDigest?: (receipt: ProviderResearchAssistantReceipt) => Promise<void>;
}

interface SignatureScope extends HarnessRunIdentity {
  method: string;
  path: string;
  requestId: string;
  timestamp: number;
  bodySha256: string;
  lease: string;
  expectedVersion?: string;
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g) ?? [], pair => Number.parseInt(pair, 16));
}

function signingInput(scope: SignatureScope) {
  return encoder.encode(JSON.stringify(['pgc-provider-research-v1', scope.method, scope.path, scope.taskId, scope.generation,
    scope.requestId, scope.timestamp, scope.bodySha256, scope.lease, scope.expectedVersion ?? '']));
}

async function signingKey(key: string, operation: 'sign' | 'verify') {
  if (!hash.test(key)) throw new Error('invalid_research_auth_key');
  return crypto.subtle.importKey('raw', fromHex(key), { name: 'HMAC', hash: 'SHA-256' }, false, [operation]);
}

/** Use only inside the trusted research Worker. The container receives its native run lease. */
export async function signHarnessProviderResearch(authKey: string, input: Omit<SignatureScope, 'bodySha256'> & { body: Uint8Array<ArrayBuffer> }) {
  const bodySha256 = await harnessSha256(input.body);
  const bytes = await crypto.subtle.sign('HMAC', await signingKey(authKey, 'sign'), signingInput({ ...input, bodySha256 }));
  const signature = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  return new Headers({
    [HARNESS_MODEL_HEADERS.task]: input.taskId, [HARNESS_MODEL_HEADERS.generation]: input.generation,
    [HARNESS_MODEL_HEADERS.requestId]: input.requestId, [authHeaders.at]: String(input.timestamp),
    [authHeaders.sha]: bodySha256, [authHeaders.signature]: signature,
    ...(input.expectedVersion !== undefined && { [PROVIDER_RESEARCH_EXPECTED_VERSION_HEADER]: input.expectedVersion }),
    ...(input.lease && { Authorization: `Bearer ${input.lease}` }),
    ...(input.method === 'POST' && { 'Content-Type': 'application/json' }),
  });
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

const reject = (error: string, status: number) => json({ error }, status);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isIntegerIn = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function manifestValid(manifest: ProviderResearchManifest) {
  return [manifest.fixtureId, manifest.taskId, manifest.generation, manifest.phase].every(harnessIdentifier) && manifest.phase.length <= 64 &&
    hash.test(manifest.sourceHash) && hash.test(manifest.modelContractHash) && MODEL_PURPOSES.includes(manifest.purpose) &&
    isIntegerIn(manifest.notBefore, 1, Number.MAX_SAFE_INTEGER) &&
    isIntegerIn(manifest.expiresAt, manifest.notBefore + 1, manifest.notBefore + HARNESS_MAX_REQUEST_MS) &&
    isIntegerIn(manifest.maxRequestOutputTokens, 1, HARNESS_MAX_REQUEST_TOKENS) &&
    isIntegerIn(manifest.maxModelTurns, 1, 4) &&
    isIntegerIn(manifest.maxTotalOutputTokens, manifest.maxRequestOutputTokens, manifest.maxRequestOutputTokens * manifest.maxModelTurns) &&
    Array.isArray(manifest.toolNames) && manifest.toolNames.length <= 16 && manifest.toolNames.every(harnessIdentifier) &&
    (!manifest.toolNames.length || manifest.maxModelTurns <= 2) && new Set(manifest.toolNames).size === manifest.toolNames.length &&
    typeof manifest.requestMatches === 'function';
}

async function authenticate(request: Request, options: ProviderResearchOptions, path: string, now: number): Promise<SignatureScope | null> {
  const { manifest, authKey } = options;
  const taskId = request.headers.get(HARNESS_MODEL_HEADERS.task);
  const generation = request.headers.get(HARNESS_MODEL_HEADERS.generation);
  const requestId = request.headers.get(HARNESS_MODEL_HEADERS.requestId);
  const rawTimestamp = request.headers.get(authHeaders.at) ?? '';
  const timestamp = /^[0-9]{1,16}$/.test(rawTimestamp) ? Number(rawTimestamp) : NaN;
  const bodySha256 = request.headers.get(authHeaders.sha) ?? '';
  const signature = request.headers.get(authHeaders.signature) ?? '';
  const expectedVersion = request.headers.get(PROVIDER_RESEARCH_EXPECTED_VERSION_HEADER) ?? undefined;
  const authorization = request.headers.get('authorization');
  const lease = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  const prefix = `${manifest.phase}-0-`;
  if (request.headers.has('cookie') || request.headers.has('x-api-key') || taskId !== manifest.taskId || generation !== manifest.generation ||
      !isIntegerIn(timestamp, now - maxClockDifferenceMs, now + maxClockDifferenceMs) ||
      !hash.test(bodySha256) || !hash.test(signature) ||
      (expectedVersion !== undefined && !requestUuid.test(expectedVersion)) ||
      (path === PROVIDER_RESEARCH_PLAN ? requestId !== 'plan' || authorization !== null :
        !requestId?.startsWith(prefix) || !requestUuid.test(requestId.slice(prefix.length)) || !lease)) return null;
  const scope = { method: request.method, path, taskId, generation, requestId: requestId!, timestamp, bodySha256, lease, expectedVersion };
  return await crypto.subtle.verify('HMAC', await signingKey(authKey, 'verify'), fromHex(signature), signingInput(scope)) ? scope : null;
}

async function readBody(request: Request, maximum: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array();
  if (request.body.locked || Number(request.headers.get('content-length')) > maximum) return null;
  const reader = request.body.getReader();
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let count = 0; count < 1024; count++) {
      const { done, value } = await reader.read();
      if (done) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
      }
      size += value.byteLength;
      if (size > maximum) return null;
      chunks.push(value);
    }
    return null;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000); });
    return await Promise.race([read().catch(() => null), deadline]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function toolsMatch(body: Record<string, unknown>, model: LockedHarnessModel, allowed: readonly string[]) {
  if (body.tools === undefined) return allowed.length === 0;
  if (!Array.isArray(body.tools) || body.tools.length !== allowed.length) return false;
  const names = body.tools.map(tool => {
    if (!isObject(tool)) return null;
    return model.protocol === 'anthropic' ? tool.name : isObject(tool.function) ? tool.function.name : null;
  });
  return allowed.every(name => names.includes(name));
}

export async function handleHarnessProviderResearch(request: Request, options: ProviderResearchOptions): Promise<Response> {
  const url = new URL(request.url);
  const plan = url.pathname === PROVIDER_RESEARCH_PLAN;
  if (url.search || url.hash || (plan ? request.method !== 'GET' : url.pathname !== PROVIDER_RESEARCH_MODEL || request.method !== 'POST')) {
    return reject('research_route_denied', 404);
  }
  const { manifest, DB, capacityDB, settingsKey } = options;
  const now = options.now ?? Date.now;
  if (!manifestValid(manifest) || !hash.test(options.authKey) || !settingsKey || !capacityDB || capacityDB === DB ||
      now() < manifest.notBefore || now() >= manifest.expiresAt) return reject('research_unavailable', 503);
  try {
    const scope = await authenticate(request, options, url.pathname, now());
    if (!scope) return reject('research_unauthorized', 401);
    const bytes = await readBody(request, plan ? 0 : maxFixtureBytes);
    if (!bytes || await harnessSha256(bytes) !== scope.bodySha256) return reject('research_body_denied', 400);
    if (request.signal.aborted || now() >= manifest.expiresAt || Math.abs(now() - scope.timestamp) > maxClockDifferenceMs) return reject('research_unauthorized', 401);

    const selectModel = async () => {
      const config = await options.loadConfig();
      const model = await lockHarnessModel(config, manifest.purpose, manifest.maxRequestOutputTokens);
      if (!model || model.maxOutputTokens < manifest.maxRequestOutputTokens ||
          await modelContractHash(config, manifest.purpose) !== manifest.modelContractHash) return null;
      return { config, model };
    };
    const family = manifest.purpose === 'review' || manifest.purpose === 'review_verify' ? 'review' : 'forge';
    const toolContinuation = manifest.toolNames.length > 0 && manifest.maxModelTurns > 1;
    const continuationSupported = (model: LockedHarnessModel) => !toolContinuation || model.protocol === 'anthropic' && !!options.recordAssistantDigest;
    const limits = { maxTotalOutputTokens: manifest.maxTotalOutputTokens, maxModelTurns: manifest.maxModelTurns, maxRepairs: 0 };
    const snapshot = { kind: 'provider-research-v1', fixtureId: manifest.fixtureId, sourceHash: manifest.sourceHash,
      modelContractHash: manifest.modelContractHash, purpose: manifest.purpose, phase: manifest.phase, notBefore: manifest.notBefore,
      expiresAt: manifest.expiresAt, maxRequestOutputTokens: manifest.maxRequestOutputTokens, limits, toolNames: [...manifest.toolNames] };
    if (plan) {
      const selected = await selectModel();
      if (!selected) return reject('research_profile_unavailable', 503);
      if (!continuationSupported(selected.model)) return reject('research_continuation_unavailable', 503);
      return json({ taskId: scope.taskId, generation: scope.generation, ownerId: PROVIDER_RESEARCH_OWNER, actor: 'admin', family,
        sourceHash: manifest.sourceHash, snapshot, model: selected.model, limits, maxRequestOutputTokens: manifest.maxRequestOutputTokens,
        phase: manifest.phase, deadlineAt: manifest.expiresAt });
    }

    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return reject('research_body_denied', 400);
    const snapshotHash = await harnessSha256(JSON.stringify(snapshot));
    const authorizeRun = async (run: HarnessRun) => run.ownerId === PROVIDER_RESEARCH_OWNER && run.actor === 'admin' && run.family === family &&
      run.sourceHash === manifest.sourceHash && run.snapshotHash === snapshotHash && run.model.purpose === manifest.purpose &&
      run.startedAt >= manifest.notBefore && run.deadlineAt <= manifest.expiresAt && now() < run.deadlineAt &&
      run.maxTotalOutputTokens === limits.maxTotalOutputTokens && run.maxModelTurns === limits.maxModelTurns && run.maxRepairs === 0;
    const run = await authorizeHarnessLease(DB, scope, scope.lease, { authorizeRun, now: now() });
    if (!run) return reject('research_unauthorized', 401);
    if (!continuationSupported(run.model)) return reject('research_continuation_unavailable', 503);
    const priorAssistant = toolContinuation && run.modelTurns > 0 ? await readProviderResearchPriorAssistantDigest(DB, run) : null;
    if (toolContinuation && run.modelTurns > 0 && (!priorAssistant || priorAssistant.requestId === scope.requestId)) {
      return reject('research_continuation_denied', 409);
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return reject('research_body_denied', 400); }
    if (!isObject(body) || body.model !== run.model.model || body.stream !== true ||
        !isIntegerIn(body.max_tokens ?? body.max_completion_tokens, 1, manifest.maxRequestOutputTokens) ||
        !toolsMatch(body, run.model, manifest.toolNames) ||
        await manifest.requestMatches(body, run.model, { requestId: scope.requestId, run,
          readPriorAssistantDigest: async () => priorAssistant?.assistantSha256 ?? null }) !== true) return reject('research_fixture_denied', 400);

    const nativePath = run.model.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
    const response = await handleHarnessModelRequest(new Request('http://pgc-harness.internal' + nativePath, {
      method: 'POST', signal: request.signal, body: bytes, headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${scope.lease}`, [HARNESS_MODEL_HEADERS.task]: scope.taskId,
        [HARNESS_MODEL_HEADERS.generation]: scope.generation, [HARNESS_MODEL_HEADERS.requestId]: scope.requestId,
      },
    }), {
      DB, capacityDB, settingsKey, now, authorizeRun, fetcher: options.fetcher, waitUntil: options.waitUntil,
      deadlineAt: manifest.expiresAt, requestIdPrefix: `${manifest.phase}-0-`, expectedModelTurns: run.modelTurns,
      loadConfig: async () => {
        const selected = await selectModel();
        return selected && canonicalHarness(selected.model) === canonicalHarness(run.model) ? selected.config : null;
      },
    });
    return toolContinuation && run.modelTurns === 0 ? observeProviderResearchAssistant(response, scope, request.signal, {
      record: options.recordAssistantDigest!, publish: receipt => publishProviderResearchAssistantDigest(DB, receipt),
      fail: async code => {
        await endHarnessRun(DB, run, 'failed', code, now());
        await revokeProviderResearchAssistantDigest(DB, scope);
      },
      waitUntil: options.waitUntil,
    }) : response;
  } catch {
    return reject('research_unavailable', 503);
  }
}
