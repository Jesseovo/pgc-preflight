import { expect, it } from 'vitest';
import { verifyEmbeddedHarnessWorkerd } from '../scripts/verify-embedded-harness';

it('runs and verifies embedded query, workspace and native SSE in local workerd against an isolated D1 ledger', async () => {
  const receipt = await verifyEmbeddedHarnessWorkerd();
  expect(receipt).toMatchObject({
    runtime: 'local-workerd',
    fixtureProvider: 'synthetic-anthropic-sse-service-binding',
    browserEvidence: 'synthetic-original-png-fixture',
    productionRunnerCovered: false,
    externalProviderRequests: 0,
    bundle: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    success: { terminal: 'completed', durableArtifactsMatch: true, gameSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    unknown: { terminal: 'model_error', gameSha256: null },
  });
}, 30_000);
