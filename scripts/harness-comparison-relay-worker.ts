/** Private named Fetcher binding. The public Worker entrypoint is closed. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  COMPARISON_SERVICE_BASELINE_PATH, COMPARISON_SERVICE_FORWARD_PATH, COMPARISON_SERVICE_ORIGIN, COMPARISON_SERVICE_PROFILE_PATH,
  createComparisonServiceClient, type ComparisonServiceContext,
} from '../server/harness-comparison-service';
import { HARNESS_MODEL_HEADERS } from '../server/harness-protocol';

type Env = {
  COMPARISON_SERVICE_CONTEXT?: string;
  COMPARISON_SERVICE_AUTH_KEY?: string;
};
export type ComparisonRelayFetcher = { fetch(request: Request): Promise<Response> };
type Client = ReturnType<typeof createComparisonServiceClient>;
type ProfileScope = Parameters<Client['readVerifiedProfile']>[0];
type HarnessScope = Parameters<Client['forwardHarness']>[1];
type BaselineScope = Parameters<Client['forwardBaseline']>[0];
const internal = 'https://comparison-relay.internal';
const paths = ['/profile', '/forward', '/baseline'] as const;
type Path = typeof paths[number];
const targets = new Set([
  COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_PROFILE_PATH,
  COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_FORWARD_PATH,
  COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_BASELINE_PATH,
]);
const metadataHeader = 'x-pgc-comparison-relay-scope';
const versionHeader = 'x-pgc-comparison-broker-version';
const versionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxMetadata = 8 * 1024;
const maxNative = 24 * 1024 * 1024;
const maxProfile = 32 * 1024;
const readTimeoutMs = 15_000;
const harnessTargets = {
  anthropic: 'http://pgc-harness.internal/v1/messages',
  openai: 'http://pgc-harness.internal/v1/chat/completions',
};
const baselineTargets = {
  creation: 'https://riffle-api.pages.dev/v1/messages',
  review: 'https://api.deepseek.com/chat/completions',
};
const harnessHeaders = ['content-type', 'authorization', ...Object.values(HARNESS_MODEL_HEADERS)];
const baselineHeaders = ['accept', 'content-type', 'authorization', 'x-api-key', 'idempotency-key', 'anthropic-version'];
const sentinel = 'pgc-comparison-local-placeholder';
const unavailable = () => new Error('Comparison relay unavailable');
const response = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });
const denied = () => response(403);

function need(value: unknown): asserts value { if (!value) throw unavailable(); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function copyHeaders(input: Headers, allowed: string[]) {
  const headers = new Headers();
  for (const name of allowed) {
    const value = input.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}
function baselineWireHeaders(input: Headers, scope: BaselineScope) {
  const creation = scope.operation === 'creation';
  const authorization = creation ? 'x-api-key' : 'authorization';
  need(input.get(authorization) === (creation ? sentinel : 'Bearer ' + sentinel) &&
    !input.has(creation ? 'authorization' : 'x-api-key') &&
    [...input.keys()].every(header => baselineHeaders.includes(header)));
  return copyHeaders(input, baselineHeaders);
}
function trustedFetch(request: Request) {
  need(request.method === 'POST' && request.redirect === 'manual' && targets.has(request.url));
  return fetch(request);
}
function internalRequest(url: string, headers: Headers, body: BodyInit | null, signal?: AbortSignal) {
  // Node's Request constructor requires duplex for a streaming body.
  return new Request(url, { method: 'POST', redirect: 'manual', headers, body, signal, duplex: 'half' } as RequestInit);
}
function cancel(value: Request | Response) { void value.body?.cancel().catch(() => {}); }

async function boundedText(value: Request | Response, limit: number, signal?: AbortSignal) {
  const length = value.headers.get('content-length');
  need(value.body && (length === null || /^\d+$/.test(length) && Number(length) <= limit));
  const reader = value.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let bytes = 0, text = '', complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    need(!signal?.aborted);
    while (true) {
      const part = await reader.read();
      need(!signal?.aborted);
      if (part.done) break;
      bytes += part.value.byteLength;
      need(bytes <= limit);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    complete = true;
    return text;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!complete) abort();
    reader.releaseLock();
  }
}

/** Turn a stable private Fetcher binding into the typed comparison client. */
export function createComparisonCandidateRelayClient(binding: ComparisonRelayFetcher): Client {
  async function relay(path: Path, version: string, scope: unknown, headers = new Headers(), body: BodyInit | null = null,
    signal?: AbortSignal, protocol?: keyof typeof harnessTargets) {
    need(typeof version === 'string' && versionPattern.test(version) && !signal?.aborted);
    const metadata = JSON.stringify({ version, scope, ...(protocol === undefined ? {} : { protocol }) });
    need(metadata.length <= maxMetadata);
    headers.set(metadataHeader, metadata);
    const result = await binding.fetch(internalRequest(internal + path, headers, body, signal));
    if (signal?.aborted || result.headers.get(versionHeader) !== version || result.redirected ||
        result.status >= 300 && result.status < 400) {
      cancel(result);
      throw unavailable();
    }
    return result;
  }
  function nativeResponse(result: Response) {
    if (!result.ok) {
      cancel(result);
      return response(result.status, { [versionHeader]: result.headers.get(versionHeader)! });
    }
    if (!result.body || !/^text\/event-stream(?:\s*;|$)/i.test(result.headers.get('content-type') ?? '')) {
      cancel(result);
      throw unavailable();
    }
    return result;
  }
  return {
    async readVerifiedProfile(scope, version) {
      try {
        const result = await relay('/profile', version, scope);
        if (result.status === 404) { cancel(result); return null; }
        if (!result.ok || !result.headers.get('content-type')?.startsWith('application/json')) {
          cancel(result);
          throw unavailable();
        }
        const profile = JSON.parse(await boundedText(result, maxProfile, AbortSignal.timeout(readTimeoutMs)));
        need(object(profile) && profile.candidateVersion === version);
        return profile as Awaited<ReturnType<Client['readVerifiedProfile']>>;
      } catch { throw unavailable(); }
    },
    async forwardHarness(request, scope, version) {
      try {
        const protocol = request.url === harnessTargets.anthropic ? 'anthropic' : request.url === harnessTargets.openai ? 'openai' : null;
        need(protocol && request.method === 'POST' && request.body && !request.headers.has('x-api-key'));
        return nativeResponse(await relay('/forward', version, scope, copyHeaders(request.headers, harnessHeaders), request.body, request.signal, protocol));
      } catch { throw unavailable(); }
    },
    async forwardBaseline(scope, url, init, version) {
      try {
        need((scope.operation === 'creation' || scope.operation === 'review') && url === baselineTargets[scope.operation] &&
          init.method === 'POST' && init.redirect === 'manual' && init.signal instanceof AbortSignal &&
          !init.signal.aborted && typeof init.body === 'string' && init.body.length <= maxNative);
        const result = await relay('/baseline', version, scope, baselineWireHeaders(new Headers(init.headers), scope), init.body, init.signal);
        if (!result.ok) { cancel(result); throw unavailable(); }
        return nativeResponse(result);
      } catch { throw unavailable(); }
    },
  };
}

export default { fetch: denied };

export class ComparisonCandidateRelay extends WorkerEntrypoint<Env> {
  #client?: Client;
  #candidateVersion?: string;

  #service(): Client {
    if (!this.#client) {
      const { COMPARISON_SERVICE_CONTEXT: json, COMPARISON_SERVICE_AUTH_KEY: authKey } = this.env;
      need(typeof json === 'string' && json.length && json.length <= 16 * 1024 && typeof authKey === 'string');
      const context = JSON.parse(json) as ComparisonServiceContext;
      this.#client = createComparisonServiceClient({ context, authKey, fetcher: trustedFetch });
      this.#candidateVersion = context.candidateVersion;
    }
    return this.#client;
  }

  async fetch(request: Request) {
    const path = new URL(request.url).pathname as Path;
    if (request.method !== 'POST' || request.url !== internal + path || !paths.includes(path)) {
      cancel(request);
      return denied();
    }
    try {
      const raw = request.headers.get(metadataHeader);
      need(raw && raw.length <= maxMetadata && !request.signal.aborted);
      const metadata: unknown = JSON.parse(raw);
      need(exact(metadata, path === '/forward' ? ['version', 'scope', 'protocol'] : ['version', 'scope']) && typeof metadata.version === 'string');
      const client = this.#service(), { version } = metadata;
      need(version === this.#candidateVersion);
      if (path === '/profile') {
        need(!request.body);
        const profile = await client.readVerifiedProfile(metadata.scope as ProfileScope, version);
        const headers = { [versionHeader]: version, 'cache-control': 'no-store' };
        return profile === null ? response(404, headers) : Response.json(profile, { headers });
      }
      if (path === '/forward') {
        const protocol = metadata.protocol;
        need((protocol === 'anthropic' || protocol === 'openai') && request.body && !request.headers.has('x-api-key'));
        const native = internalRequest(harnessTargets[protocol], copyHeaders(request.headers, harnessHeaders), request.body, request.signal);
        return await client.forwardHarness(native, metadata.scope as HarnessScope, version);
      }
      const scope = metadata.scope as BaselineScope;
      need(scope && (scope.operation === 'creation' || scope.operation === 'review') && object(scope));
      const headers = new Headers(request.headers);
      // Service binding transport may supply Content-Length itself.
      headers.delete(metadataHeader);
      headers.delete('content-length');
      const wire = baselineWireHeaders(headers, scope);
      const body = await boundedText(request, maxNative, AbortSignal.any([request.signal, AbortSignal.timeout(readTimeoutMs)]));
      return await client.forwardBaseline(scope, baselineTargets[scope.operation], {
        method: 'POST', redirect: 'manual', headers: wire, body, signal: request.signal,
      }, version);
    } catch {
      cancel(request);
      return response(503);
    }
  }
}
