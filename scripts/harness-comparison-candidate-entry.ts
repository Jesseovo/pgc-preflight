/** Research candidate fetch only. The private packager wraps the preserved production module. */
import {
  loadComparisonDeployment, comparisonEntryExact, comparisonEntryHash, comparisonEntryJson, comparisonEntryRequire, sameComparisonContext,
  type ComparisonResearchBindings,
} from '../server/harness-comparison-entry-config';
import { inspectComparisonProfilePins, openComparisonCandidateRegistry } from '../server/harness-comparison-registry';
import {
  COMPARISON_SERVICE_BASELINE_PATH, COMPARISON_SERVICE_FORWARD_PATH, COMPARISON_SERVICE_ORIGIN, COMPARISON_SERVICE_PROFILE_PATH,
  createComparisonServiceHandler,
} from '../server/harness-comparison-service';
import { configStore, type Database } from '../server/storage';

export type ComparisonCandidateEnvironment = ComparisonResearchBindings & {
  DB?: Database;
  SETTINGS_KEY?: string;
  COMPARISON_PROFILE_IDS?: string;
  COMPARISON_SERVICE_AUTH_KEY?: string;
  COMPARISON_CANDIDATE_VERSION?: { id: string };
};
type Context = { waitUntil?(promise: Promise<unknown>): void };
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const versionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });
const productionProviders = new Set(['https://riffle-api.pages.dev/v1/messages', 'https://api.deepseek.com/chat/completions']);

function fixedProviderFetch(url: string, init: RequestInit) {
  comparisonEntryRequire(productionProviders.has(url) && init.method === 'POST' && init.redirect === 'manual' && init.signal instanceof AbortSignal && !init.signal.aborted);
  return fetch(url, init);
}

export async function fetchComparisonCandidate(request: Request, env: ComparisonCandidateEnvironment, ctx?: Context): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.url !== COMPARISON_SERVICE_ORIGIN + path ||
      ![COMPARISON_SERVICE_BASELINE_PATH, COMPARISON_SERVICE_PROFILE_PATH, COMPARISON_SERVICE_FORWARD_PATH].includes(path)) {
    void request.body?.cancel().catch(() => {});
    return unavailable(403);
  }
  try {
    const executingVersion = env.COMPARISON_CANDIDATE_VERSION?.id;
    const { DB, SETTINGS_KEY: settingsKey, COMPARISON_SERVICE_AUTH_KEY: authKey } = env;
    comparisonEntryRequire(typeof executingVersion === 'string' && versionPattern.test(executingVersion) &&
      DB && typeof DB.prepare === 'function' && typeof settingsKey === 'string' && settingsKey.length > 0 && comparisonEntryHash(authKey));
    // Shape checks only avoid unnecessary reads on unsigned traffic. The
    // service handler still authenticates the exact signed request below.
    if (request.method !== 'POST' || request.headers.get('x-pgc-comparison-expected-version') !== executingVersion ||
        !comparisonEntryHash(request.headers.get('x-pgc-comparison-signature')) ||
        !comparisonEntryHash(request.headers.get('x-pgc-comparison-body-sha256'))) {
      void request.body?.cancel().catch(() => {});
      return unavailable(403);
    }
    const { shared, contexts, productionId } = await loadComparisonDeployment(env, { production: DB, executingVersion });
    const arm = path === COMPARISON_SERVICE_BASELINE_PATH ? 'A' : 'B';
    const context = contexts[arm];
    comparisonEntryRequire(productionId && executingVersion === context.candidateVersion);
    const handler = createComparisonServiceHandler({
      context, authKey, executingVersion, nonceDatabase: { scope: 'isolated-comparison', ...shared.databases.nonce },
      async handle(call, signal) {
        // This callback is entered only after exact version, signature, body
        // digest, clock and atomic nonce validation on the fixed arm path.
        comparisonEntryRequire(!signal.aborted && await shared.authorizeGrant(context) && !signal.aborted);
        const profileIds = comparisonEntryJson<{ creation: string; review: string }>(env.COMPARISON_PROFILE_IDS, 4 * 1024);
        comparisonEntryRequire(comparisonEntryExact(profileIds, ['creation', 'review']) &&
          [profileIds.creation, profileIds.review].every(value => typeof value === 'string' && identifier.test(value)));
        const loadConfig = () => {
          comparisonEntryRequire(!signal.aborted);
          return configStore(DB).get();
        };
        const options = { ...shared, attestation: { ...shared.attestation, executingCandidateVersion: executingVersion } };
        const profiles = await inspectComparisonProfilePins({ ...options, profileIds, loadConfig });
        comparisonEntryRequire(!signal.aborted);
        const registry = await openComparisonCandidateRegistry({
          ...options, profiles, loadConfig, settingsKey, fetcher: fixedProviderFetch,
          waitUntil: ctx?.waitUntil ? promise => ctx.waitUntil!(promise) : undefined,
          databases: { ...shared.databases, capacity: { id: productionId, connection: DB } },
        });
        comparisonEntryRequire(sameComparisonContext(registry.context, contexts.B) &&
          sameComparisonContext(registry.baselineContext, contexts.A) && !signal.aborted);
        return registry.handle(call, signal);
      },
    });
    return await handler(request);
  } catch {
    void request.body?.cancel().catch(() => {});
    return unavailable(503);
  }
}
