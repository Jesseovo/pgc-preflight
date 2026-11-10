import { describe, expect, it, vi } from 'vitest';
import { handleProviderResearchCandidate, verifyProviderResearchResponse } from '../server/harness-provider-candidate';
import { type ProviderResearchOptions, PROVIDER_RESEARCH_PLAN } from '../server/harness-provider-research';
import { fetchResearchCandidate } from '../scripts/harness-provider-candidate-entry';

const version = '11111111-1111-4111-8111-111111111111';
const authKey = 'a'.repeat(64);
// Unauthenticated calls must not reach either database or any model loader.
const unavailable = () => {
  const loadConfig = vi.fn(() => { throw new Error('must not load config'); });
  const db = new Proxy({}, { get() { throw new Error('must not access database'); } });
  return { options: { DB: db, capacityDB: {}, settingsKey: 'synthetic', authKey, loadConfig,
    manifest: { fixtureId: 'fixture', taskId: 'task', generation: 'generation', phase: 'build', purpose: 'game',
      sourceHash: 'a'.repeat(64), modelContractHash: 'b'.repeat(64), notBefore: 1, expiresAt: 600_001,
      maxRequestOutputTokens: 64_000, maxTotalOutputTokens: 128_000, maxModelTurns: 2,
      toolNames: [], requestMatches: () => true }, now: () => 10_000,
  } as unknown as ProviderResearchOptions, loadConfig };
};

describe('zero-traffic research candidate', () => {
  it('packaged entry rejects ordinary fetch before touching any environment binding', async () => {
    const env = new Proxy({}, { get() { throw new Error('no bindings'); } });
    const response = await fetchResearchCandidate(new Request('https://example.test/api/admin/test'), env as never,
      { waitUntil() { throw new Error('no work'); } });
    expect(response.status).toBe(403);
  });
  it.each(['/api/admin/test', '/api/forge/tasks', '/admin', '/', PROVIDER_RESEARCH_PLAN + '/extra'])(
    'denies nonresearch %s without old application or database access', async path => {
      const { options, loadConfig } = unavailable();
      const response = await handleProviderResearchCandidate(new Request('https://example.test' + path, {
        headers: { 'Cloudflare-Workers-Version-Overrides': `pgc-preflight="${version}"` },
      }), options, { id: version });
      expect(response.status).toBe(403);
      expect(loadConfig).not.toHaveBeenCalled();
    });

  it('signs the actually executing version and binds the response to the exact request', async () => {
    const { options, loadConfig } = unavailable();
    const request = new Request('https://example.test' + PROVIDER_RESEARCH_PLAN, { headers: {
      'x-pgc-research-signature': 'c'.repeat(64), 'x-pgc-harness-request-id': 'plan',
      'x-pgc-research-expected-version': version,
    } });
    const response = await handleProviderResearchCandidate(request, options, { id: version });
    expect(response.status).toBe(401);
    expect(await verifyProviderResearchResponse(request, response, version, authKey)).toBe(true);
    expect(await verifyProviderResearchResponse(request, response, version.replace(/^1/, '2'), authKey)).toBe(false);
    expect(await verifyProviderResearchResponse(request, response, version, 'b'.repeat(64))).toBe(false);
    const other = new Request(request, { headers: { 'x-pgc-harness-request-id': 'changed' } });
    expect(await verifyProviderResearchResponse(other, response, version, authKey)).toBe(false);
    const changed = new Response(null, { status: 200, headers: response.headers });
    expect(await verifyProviderResearchResponse(request, changed, version, authKey)).toBe(false);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('requires actual version metadata before processing research routes', async () => {
    const { options, loadConfig } = unavailable();
    const request = new Request('https://example.test' + PROVIDER_RESEARCH_PLAN);
    expect((await handleProviderResearchCandidate(request, options, undefined)).status).toBe(503);
    expect((await handleProviderResearchCandidate(request, options, { id: version })).status).toBe(503);
    const wrong = new Request(request, { headers: { 'x-pgc-research-expected-version': version.replace(/^1/, '2') } });
    expect((await handleProviderResearchCandidate(wrong, options, { id: version })).status).toBe(503);
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
