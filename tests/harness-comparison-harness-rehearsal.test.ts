import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runHarnessRehearsal } from '../scripts/harness-comparison-harness-rehearsal';

const parents: string[] = [];
let trappedFetch: ReturnType<typeof vi.fn>;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const adapterCommit = 'd67553ff2e42d716ae08c5d1e670521a368749c9';
const runtimeCommit = '630303565f44c061c7ed8ad7b992dcc4e9db8929';
const pinnedBytes = (commit: string, path: string) => execFileSync('/usr/bin/git', ['show', commit + ':' + path], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), env: { PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1' },
});
function target() {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'comparison-b-rehearsal-'));
  parents.push(parent);
  return join(parent, 'run');
}
beforeEach(() => {
  trappedFetch = vi.fn(() => { throw new Error('Unexpected real network fetch'); });
  vi.stubGlobal('fetch', trappedFetch);
});
afterEach(() => {
  expect(trappedFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

test('B uses actual creation and review runners with exact synthetic evidence across the Gateway', async () => {
  const { output, result, reviewInput } = await runHarnessRehearsal({ out: target() });
  expect(result).toMatchObject({
    scope: 'synthetic-offline-b-rehearsal', executionAllowed: false, formalImportAllowed: false,
    scriptedForwards: 4, providerRequests: 0, networkOperations: 0, realContainers: 0,
    closure: { allocations: 4, destructions: 4 },
  });
  const sourceBytes = readFileSync(join(output, 'source.json'));
  const source = JSON.parse(sourceBytes.toString());
  expect(result.sourceVerification).toMatchObject({ sourceReceiptSha256: sha(sourceBytes),
    adapterSha256: sha(pinnedBytes(adapterCommit, 'scripts/harness-comparison-harness-rehearsal.ts')),
    sharedFixtureSha256: sha(pinnedBytes(adapterCommit, 'scripts/harness-comparison-rehearsal-fixture.ts')),
    runtimeTreeSha256: source.runtimeTreeSha256, runtimeTreeEndSha256: source.runtimeTreeSha256 });
  expect(source.implementationCommit).toBe(runtimeCommit);
  for (const name of ['server/harness-host.ts', 'server/harness-gateway.ts', 'harness/envelope.mjs', 'harness/model-bridge.mjs']) {
    expect(source.trackedRuntimeFiles[name]).toBe(sha(pinnedBytes(runtimeCommit, name)));
  }
  expect(result.creation.status).toBe('done');
  expect(result.creation.stages.map(stage => stage.stage)).toEqual(['build', 'polish']);
  expect(result.creation.stageVersionId).toBe(result.creation.stages[1].version_id);
  const html = readFileSync(join(output, 'artifact.html'), 'utf8');
  expect(html).toBe(reviewInput.html);
  expect(sha(html)).toBe(result.creation.sha256);
  expect(result.review).toMatchObject({ status: 'done', evidence: {
    htmlSha256: sha(html), probeSha256: sha(JSON.stringify(reviewInput.probe)),
    shotSha256: reviewInput.shots.map(shot => sha(Buffer.from(shot.data.split(',')[1], 'base64'))),
  } });
  expect(result.review.evidence.shotSha256).toHaveLength(4);
  expect(new Set(result.review.evidence.shotSha256).size).toBe(4);
  expect(result.dispatches.map(request => [request.phase, request.model, request.effort, request.outputCap])).toEqual([
    ['build', 'claude-opus-5-5', 'high', 64_000], ['polish', 'claude-opus-5-5', 'high', 64_000],
    ['review', 'deepseek-flash', 'low', 24_000], ['review_verify', 'deepseek-flash', 'low', 24_000],
  ]);
  const [initial, verify] = result.dispatches.slice(2);
  for (const dispatch of [initial, verify]) {
    expect(dispatch).toMatchObject({ reviewEvidence: result.review.evidence,
      rulesSha256: result.review.rulesSha256, rulesContentSha256: result.review.rulesContentSha256,
      calibrationSha256: result.review.calibrationSha256, modelConfigSha256: result.review.modelConfigSha256,
      ledger: { attempts: 1, state: 'completed', input_tokens: 55, output_tokens: 72, reasoning_tokens: 5, finish_reason: 'stop' } });
  }
  expect(initial.bodySha256).not.toBe(verify.bodySha256);
  expect(initial.imageSha256).toEqual(verify.imageSha256);
  expect(result.review.draftSha256).not.toBe(result.review.finalSha256);
  expect(result.nativeReceipts.map(({ phase, aggregateOutputCap, maxModelTurns, maxRepairs, state }) =>
    [phase, aggregateOutputCap, maxModelTurns, maxRepairs, state])).toEqual([
    ['build', 256_000, 24, 2, 'succeeded'], ['polish', 256_000, 24, 2, 'succeeded'],
    ['review', 48_000, 8, 0, 'succeeded'], ['review_verify', 48_000, 8, 0, 'succeeded'],
  ]);
  expect(result.runs.every(row => row.released_at !== null && row.reserved_tokens === 0)).toBe(true);
  expect(statSync(output).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(output)) expect(statSync(join(output, name)).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(output, 'dispatch-3.json'), 'utf8')).not.toMatch(/Bearer |encryptedKey|messages|reasoning_content/);
  await expect(runHarnessRehearsal({ out: output })).rejects.toMatchObject({ code: 'EEXIST' });
}, 20_000);

test('interrupted DeepSeek stream latches unknown and no replay or unchecked report is published', async () => {
  const { output, result } = await runHarnessRehearsal({ out: target(), scenario: 'unknown-response' });
  expect(result).toMatchObject({ scriptedForwards: 3, forwardsBeforeRecovery: 3, providerRequests: 0,
    review: { status: 'error', interruptedResultUnknown: true, draftSha256: null, finalSha256: null } });
  expect(result.dispatches.at(-1)).toMatchObject({ phase: 'review',
    ledger: { attempts: 1, state: 'unknown', output_tokens: null, error_code: 'stream_incomplete' } });
  expect(result.nativeReceipts.at(-1)).toMatchObject({ phase: 'review', state: 'failed' });
  expect(result.closure).toEqual({ allocations: 3, destructions: 3 });
  expect(result.runs.at(-1)).toMatchObject({ status: 'unknown', reserved_tokens: 24_000, released_at: expect.any(Number) });
  expect(existsSync(join(output, 'initial-draft.json'))).toBe(false);
  expect(existsSync(join(output, 'final-report.json'))).toBe(false);
}, 20_000);

test('a failed report transaction retries sealed publication with no additional native or model attempt', async () => {
  const { output, result } = await runHarnessRehearsal({ out: target(), scenario: 'persist-recovery' });
  expect(result).toMatchObject({ scriptedForwards: 4, forwardsBeforeRecovery: 4, failedWrites: 1,
    review: { status: 'done', publicationRetried: true }, closure: { allocations: 4, destructions: 4 } });
  expect(existsSync(join(output, 'initial-draft.json'))).toBe(true);
  expect(existsSync(join(output, 'final-report.json'))).toBe(true);
}, 20_000);

test('rejects a parent traversal before creating the rehearsal', async () => {
  const output = target();
  await expect(runHarnessRehearsal({ out: output + '/../run' })).rejects.toThrow(/fresh private rehearsal directory/);
  expect(existsSync(output)).toBe(false);
});
