import {
  handleHarnessProviderResearch, PROVIDER_RESEARCH_MODEL, PROVIDER_RESEARCH_PLAN,
  type ProviderResearchOptions,
} from './harness-provider-research';
import { HARNESS_MODEL_HEADERS } from './harness-protocol';

const versionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const versionHeader = 'x-pgc-research-version';
const signatureHeader = 'x-pgc-research-response-signature';

function signatureInput(request: Request, status: number, version: string) {
  return new TextEncoder().encode(JSON.stringify([
    'pgc-provider-research-response-v1', request.method, new URL(request.url).pathname,
    request.headers.get(HARNESS_MODEL_HEADERS.task), request.headers.get(HARNESS_MODEL_HEADERS.generation),
    request.headers.get(HARNESS_MODEL_HEADERS.requestId), request.headers.get('x-pgc-research-signature'), status, version,
  ]));
}

async function key(value: string, usage: 'sign' | 'verify') {
  if (!hashPattern.test(value)) throw new Error('Invalid research response key');
  return crypto.subtle.importKey('raw', Uint8Array.from(value.match(/../g)!, part => Number.parseInt(part, 16)),
    { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Check the actual selected candidate before accepting its plan or SSE. */
export async function verifyProviderResearchResponse(request: Request, response: Response, expectedVersion: string, authKey: string) {
  const signature = response.headers.get(signatureHeader) ?? '';
  if (!versionPattern.test(expectedVersion) || response.headers.get(versionHeader) !== expectedVersion || !hashPattern.test(signature)) return false;
  return crypto.subtle.verify('HMAC', await key(authKey, 'verify'),
    Uint8Array.from(signature.match(/../g)!, part => Number.parseInt(part, 16)),
    signatureInput(request, response.status, expectedVersion));
}

/**
 * Research-only candidate entry. It must be deployed at exactly 0% alongside
 * the frozen original at 100%. It never delegates fetch to original code/DOs.
 * The package separately preserves all original named exports and triggers.
 */
export async function handleProviderResearchCandidate(request: Request, options: ProviderResearchOptions,
  version: { id: string } | undefined): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== PROVIDER_RESEARCH_PLAN && path !== PROVIDER_RESEARCH_MODEL) {
    return Response.json({ error: 'research_candidate_only' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!versionPattern.test(version?.id ?? '') || !hashPattern.test(options.authKey) ||
      request.headers.get('x-pgc-research-expected-version') !== version!.id) {
    return Response.json({ error: 'research_version_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const response = await handleHarnessProviderResearch(request, options);
  const signature = await crypto.subtle.sign('HMAC', await key(options.authKey, 'sign'), signatureInput(request, response.status, version!.id));
  const headers = new Headers(response.headers);
  headers.set(versionHeader, version!.id);
  headers.set(signatureHeader, Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join(''));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
