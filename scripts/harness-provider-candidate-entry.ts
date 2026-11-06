import { handleProviderResearchCandidate } from '../server/harness-provider-candidate';
import { PROVIDER_RESEARCH_MODEL, PROVIDER_RESEARCH_PLAN } from '../server/harness-provider-research';
import { opusResearchFixtureManifest } from '../server/harness-provider-fixture';
import { recordProviderResearchAssistantDigest } from '../server/harness-provider-research-observer';
import { configStore, type Database } from '../server/storage';
import type { HarnessDatabase } from '../server/harness-ledger';

interface Env {
  DB: Database;
  HARNESS_RESEARCH_DB: HarnessDatabase;
  SETTINGS_KEY: string;
  PGC_RESEARCH_AUTH: string;
  PGC_RESEARCH_VERSION: { id: string };
  PGC_RESEARCH_MANIFEST: {
    taskId: string; generation: string; modelContractHash: string; notBefore: number; expiresAt: number;
    researchDatabaseId: string; productionDatabaseId: string;
  };
}

// This module is packaged beside exact deployed original modules. It is never
// part of the ordinary production Worker entry/configuration.
export async function fetchResearchCandidate(request: Request, env: Env, ctx: { waitUntil(work: Promise<unknown>): void },
  makeManifest = opusResearchFixtureManifest) {
  const path = new URL(request.url).pathname;
  if (path !== PROVIDER_RESEARCH_PLAN && path !== PROVIDER_RESEARCH_MODEL) {
    return Response.json({ error: 'research_candidate_only' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const manifest = env.PGC_RESEARCH_MANIFEST;
  if (!manifest || typeof manifest.researchDatabaseId !== 'string' || typeof manifest.productionDatabaseId !== 'string' ||
      manifest.researchDatabaseId === manifest.productionDatabaseId || !env.HARNESS_RESEARCH_DB || !env.DB) {
    return Response.json({ error: 'research_configuration_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  let fixture: ReturnType<typeof makeManifest>;
  try { fixture = makeManifest(manifest); }
  catch { return Response.json({ error: 'research_configuration_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  return handleProviderResearchCandidate(request, {
    DB: env.HARNESS_RESEARCH_DB, capacityDB: env.DB,
    loadConfig: () => configStore(env.DB).get(), settingsKey: env.SETTINGS_KEY, authKey: env.PGC_RESEARCH_AUTH,
    manifest: fixture,
    recordAssistantDigest: receipt => recordProviderResearchAssistantDigest(env.HARNESS_RESEARCH_DB, receipt),
    waitUntil: work => ctx.waitUntil(work),
  }, env.PGC_RESEARCH_VERSION);
}
