import { expect, it } from 'vitest';
import { verifyEmbeddedForgeBrowser } from '../scripts/verify-embedded-forge-browser';

it.runIf(process.env.PGC_EMBEDDED_BROWSER_TEST === '1')('runs original Forge and Review alarms with separate real Chromium captures and scripted native SSE', async () => {
  const receipt = await verifyEmbeddedForgeBrowser();
  expect(receipt).toMatchObject({
    runtime: 'local-workerd-original-forge-and-review-runners', capture: 'local-chromium-full-viewport',
    provider: 'synthetic-anthropic-and-deepseek-sse', externalProviderRequests: 0, scriptedModelCalls: 5, browserProcessesClosed: 3,
    staleReferenceRejected: true, runSlotReleased: true, actualLocalBrowser: true, completedWorkspaceToolReceipts: 5,
    review: { scriptedModelCalls: 2, score: null, onlyVerifiedReportPublished: true, creatorAndSameVersionHumanAnswersExcluded: true },
  });
  expect(receipt.stages.map(stage => [stage.phase, stage.shots.length])).toEqual([['build', 4], ['polish', 4]]);
  expect(receipt.review.shots).toHaveLength(4);
  expect(receipt.review.sourceSha256).toBe(receipt.final.artifactSha256);
}, 220_000);
