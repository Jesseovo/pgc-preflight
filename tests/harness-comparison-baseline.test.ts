import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBaselineRehearsal, type BaselineReviewInput } from '../scripts/harness-comparison-baseline';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const scenarios = ['success', 'unknown-response', 'persist-recovery'] as const;

function sharedReviewInput(): BaselineReviewInput {
  const html = '<!doctype html><html><head><title>Synthetic B source</title></head><body>External synthetic fixture</body></html>';
  const images = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGAAAAAHAALpEtlMAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYmAAAAAKAANQonMOAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZmAAAAANAARPw/7SAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYWAAAAAQAAUm//d+AAAAAElFTkSuQmCC',
  ].reverse();
  const observations = images.map((_, i) => ({ id: `shared-${i}`, label: `Shared shot ${i}`, actionRefs: [], capturedAt: '2026-11-06T00:00:00.000Z' }));
  const probe = { captureMethod: 'browser-viewport-v1', observations };
  return { html, htmlSha256: sha(Buffer.from(html)), probe, probeSha256: sha(Buffer.from(JSON.stringify(probe))),
    shots: observations.map((observation, i) => ({ ...observation, data: `data:image/png;base64,${images[i]}` })),
    shotSha256: images.map(image => sha(Buffer.from(image, 'base64'))),
  };
}

describe('exact archived A baseline rehearsal', () => {
  it.each(scenarios)('runs %s using archived enqueue and alarms', scenario => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'pgc-baseline-test-'));
    try {
      const out = join(directory, 'receipts');
      const reviewInput = scenario === 'success' ? sharedReviewInput() : undefined;
      const { provenance, result } = runBaselineRehearsal({ out, scenario, reviewInput });
      const unknown = scenario === 'unknown-response';
      const retry = scenario === 'persist-recovery';
      const read = (name: string) => JSON.parse(readFileSync(join(out, name), 'utf8'));
      expect(provenance).toMatchObject({ implementationCommit: '8afbf81c85c785f5d2d071dda9ecedba510b42ab', tree: '491936d02f57b9125be86e36e73e76048009d82f',
        adapterSha256: sha(readFileSync(new URL('../scripts/harness-comparison-baseline.ts', import.meta.url))),
      });
      expect(Object.keys(provenance.migrations).at(-1)).toBe('0032_forge_creation_pipeline.sql');
      expect(provenance.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result).toMatchObject({ scenario, caseId: 'tap-rhythm', scope: 'synthetic-offline-a-rehearsal', executionAllowed: false, formalImportAllowed: false,
        providerRequests: 0, networkOperations: 0, scriptedForwards: unknown ? 3 : 4, forwardsBeforeRecovery: unknown ? 3 : 4, failedWrites: retry ? 1 : 0,
        creation: { status: 'done', path: 'artifact.html' }, review: { status: unknown ? 'error' : 'done', interruptedResultUnknown: unknown, publicationRetried: retry },
      });
      expect(read('verification.json')).toMatchObject({ ...result, sourceReceiptSha256: sha(readFileSync(join(out, 'source.json'))) });
      expect(read('artifact.json').versionId).toBe(result.creation.versionId);
      expect(sha(readFileSync(join(out, 'artifact.html')))).toBe(result.creation.sha256);
      const phases = unknown ? ['build', 'polish', 'initial'] : ['build', 'polish', 'initial', 'verify'];
      const requests = phases.map((_, index) => read(`dispatch-${index + 1}.json`));
      expect(requests.map(request => request.phase)).toEqual(phases);
      expect(requests.map(request => request.outputCap)).toEqual([64000, 64000, 24000, ...(unknown ? [] : [24000])]);
      expect(requests.map(request => request.effort)).toEqual(['high', 'high', 'low', ...(unknown ? [] : ['low'])]);
      expect(requests.map(request => request.imageSha256.length)).toEqual([0, 4, 4, ...(unknown ? [] : [4])]);
      expect(new Set(requests[2].imageSha256).size).toBe(4);
      const { rulesSha256, rulesContentSha256, calibrationSha256, modelConfigSha256 } = result.review;
      const bindings = { rulesSha256, rulesContentSha256, calibrationSha256, modelConfigSha256 };
      for (const digest of Object.values(bindings)) expect(digest).toMatch(/^[a-f0-9]{64}$/);
      if (reviewInput) {
        const { htmlSha256, probeSha256, shotSha256 } = reviewInput;
        expect(result.creation.sha256).not.toBe(htmlSha256);
        expect(result.review).toMatchObject({ inputOrigin: 'shared-synthetic', evidence: { htmlSha256, probeSha256, shotSha256 } });
        const dispatchEvidence = { reviewEvidence: { htmlSha256, probeSha256, shotSha256 }, ...bindings };
        for (const request of requests.slice(2)) expect(request).toMatchObject(dispatchEvidence);
      }
      expect(new Set(requests.map(request => request.idempotencyKey)).size).toBe(phases.length);
      expect(read('usage.json').metrics.map((metric: { attempts: number }) => metric.attempts)).toEqual(phases.map(() => 1));
      const files = readdirSync(out);
      if (unknown) {
        expect(files).not.toContain('initial-draft.json');
        expect(files).not.toContain('final-report.json');
        expect(read('usage.json').metrics.at(-1)).toMatchObject({ status: 'error', output_tokens: null });
      } else {
        expect(read('initial-draft.json').report.reviewer_comment).toBe('Synthetic initial report');
        expect(read('final-report.json').report.reviewer_comment).toBe('Synthetic verification report');
        expect(requests[3].imageSha256).toEqual(requests[2].imageSha256);
      }
      for (const file of files) expect(statSync(join(out, file)).mode & 0o777).toBe(0o600);
      expect(() => runBaselineRehearsal({ out })).toThrow('EEXIST');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses tampered shared review input before any dispatch', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'pgc-baseline-test-'));
    try {
      const out = join(directory, 'receipts');
      const reviewInput = sharedReviewInput();
      reviewInput.html += '\nchanged';
      expect(() => runBaselineRehearsal({ out, reviewInput })).toThrow('Shared synthetic review evidence digest differs');
      expect(readdirSync(out)).toEqual(['source.json']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
