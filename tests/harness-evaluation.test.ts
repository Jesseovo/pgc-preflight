import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importRecord, packet, prepare, report } from '../scripts/harness-evaluation';

const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const revision = 'b'.repeat(40);
const harnessImage = `registry.cloudflare.com/${'1'.repeat(32)}/fixture@sha256:${'c'.repeat(64)}`;
const changedImage = harnessImage.replace(/c{64}$/, 'f'.repeat(64));
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const directories: string[] = [];
type Arm = 'A' | 'B';
type Time = { startedAt: string; finishedAt: string };
type Ref = { path: string; sha256: string };
type Case = { id: string; materialSha256: string; checklist: { id: string }[] };

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(configured = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pgc-harness-eval-')));
  directories.push(directory);
  await mkdir(join(directory, 'inputs'));
  async function artifact(name: string, bytes: Buffer | string): Promise<Ref> {
    const path = `inputs/${name}`;
    await writeFile(join(directory, path), bytes);
    return { path, sha256: digest(bytes) };
  }
  const rules = await artifact('rules.json', '{"synthetic":"rules"}');
  const calibration = await artifact('calibration.json', '[]');
  const creationConfig = await artifact('creation-config.json', '{"model":"claude-opus-5-5"}');
  const reviewConfig = await artifact('review-config.json', '{"model":"deepseek-test"}');
  const settings = await artifact('settings.json', encoded({
    creationModel: { name: 'claude-opus-5-5', config: creationConfig },
    reviewModel: { name: 'deepseek-test', config: reviewConfig },
    rulesVersion: 'synthetic-v2', rules, calibration, harnessCommit: revision, harnessImage,
  }));
  const manifestSha256 = await prepare(directory, configured ? join(directory, settings.path) : undefined);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { cases: Case[]; frozenAt: string };
  const usageEvidence = await artifact('usage.json', '{"input":500,"output":600}');
  const coverageEvidence = [await artifact('observation.txt', 'Synthetic test evidence')];
  const probe = await artifact('probe.json', '{"captureMethod":"browser-viewport-v2"}');
  const shots = await Promise.all([1, 2, 3, 4].map(i =>
    artifact(`image-${i}.png`, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([i])]))));
  const reportArtifact = await artifact('report.json', encoded({
    schema_version: 2, assessment_status: 'complete', aes: 1, ease: 2, play: 1,
    score_reasons: { aes: 'Synthetic', ease: 'Synthetic', play: 'Synthetic' },
    uncertainties: [], verdict: '通过', reviewer_comment: '', strengths: [], issues: [], fix_prompt: '', optional_suggestions: [],
  }));
  const after = (instant: string, amount: number) => new Date(Date.parse(instant) + amount).toISOString();
  const clock = { startedAt: manifest.frozenAt, finishedAt: manifest.frozenAt };
  const observer = { independent: true, observerType: 'human', observerId: 'fixture-adjudicator' };
  const stage = (phase: string, window: Time) => ({
    phase, status: 'completed', ...window, failure: null, inputTokens: 500, outputTokens: 600, usageEvidence,
  });
  async function creation(item: Case, arm: Arm, overrides: object = {}, content = '<!doctype html><title>Synthetic</title>') {
    const html = await artifact(`${item.id}.${arm}.html`, content);
    await importRecord(directory, 'creation', {
      manifestSha256, caseId: item.id, arm, implementationCommit: arm === 'A' ? baseline : revision,
      ...(arm === 'B' ? { image: harnessImage } : {}),
      materialSha256: item.materialSha256, modelConfigSha256: creationConfig.sha256,
      status: 'completed', ...clock, failure: null, stages: [stage('build', clock)], html, blindSafe: true,
      attachments: [], controllerUsage: arm === 'B' ? { turns: 1, repairs: 0, evidence: usageEvidence } : null, ...overrides,
    });
    return html;
  }
  async function lockedReviewInput(item: Case, html: Ref) {
    const evidenceSha256 = digest(encoded({ html: html.sha256, probe: probe.sha256, shots: shots.map(shot => shot.sha256) }));
    const catalog = [{ id: 'critical-1', observation: 'Synthetic observed issue', evidence: coverageEvidence }];
    await importRecord(directory, 'review-input', {
      manifestSha256, caseId: item.id, htmlSha256: html.sha256, evidenceSha256, probe, shots,
      blindSafe: true, ...observer, catalogExhaustive: true, catalog, catalogEvidence: coverageEvidence, disputes: [],
    });
    const locked = JSON.parse(await readFile(join(directory, 'records', `review-input.${item.id}.json`), 'utf8')) as { lockedAt: string };
    return { evidenceSha256, lockedAt: locked.lockedAt };
  }
  async function review(item: Case, arm: Arm, html: Ref, lock: Awaited<ReturnType<typeof lockedReviewInput>>, overrides: object = {}, runOverrides: object = {}) {
    const window = { startedAt: lock.lockedAt, finishedAt: after(lock.lockedAt, 2) };
    const bindings = { htmlSha256: html.sha256, evidenceSha256: lock.evidenceSha256,
      ...(arm === 'B' ? { image: harnessImage } : {}), modelConfigSha256: reviewConfig.sha256, rulesSha256: rules.sha256, calibrationSha256: calibration.sha256 };
    const initial = { ...stage('initial', { startedAt: window.startedAt, finishedAt: after(window.startedAt, 1) }), ...bindings };
    const verify = { ...stage('verify', { startedAt: initial.finishedAt, finishedAt: window.finishedAt }), ...bindings, initialReportSha256: reportArtifact.sha256, ...overrides };
    return importRecord(directory, 'review', {
      manifestSha256, caseId: item.id, arm, implementationCommit: arm === 'A' ? baseline : revision,
      ...(arm === 'B' ? { image: harnessImage } : {}),
      status: 'completed', ...window, failure: null, initial, verify,
      initialReport: reportArtifact, finalReport: reportArtifact, attachments: [], blindSafe: true, ...runOverrides,
    });
  }
  function finding(id: string, state = 'verified') { return { id, state, observation: 'Independent synthetic observation', evidence: coverageEvidence }; }
  async function judge(item: Case, arm: Arm, kind: 'creation' | 'review', overrides: object = {}) {
    const disclosed = await packet(directory, kind, item.id, arm);
    return importRecord(directory, kind === 'creation' ? 'creation-judgment' : 'review-judgment', {
      manifestSha256, ...disclosed, ...observer, blind: true, coverageComplete: true, coverageEvidence, disputes: [],
      ...(kind === 'creation'
        ? { checks: item.checklist.map(({ id }) => finding(id)), criticalDefects: [], unapprovedCoreChanges: [] }
        : { mandatoryRemediations: [], criticalHits: [finding('critical-1')] }),
      ...overrides,
    });
  }
  return { directory, manifest, manifestSha256, artifact, creation, lockedReviewInput, review, judge, finding, clock };
}

describe('offline harness evaluation', () => {
  it('freezes six full material sets and preserves all missing denominators', async () => {
    const run = await setup(false);
    const output = await report(run.directory);
    expect(output.manifestSha256).toBe(run.manifestSha256);
    expect(output.registered).toEqual({ creationRuns: 12, reviewPairs: 6, reviewRuns: 12 });
    expect(output.arms[0].creation).toEqual({ denominator: 6, completed: 0, failed: 0, missing: 6 });
    expect(output.arms[1].review).toEqual({ denominator: 6, completed: 0, failed: 0, missing: 6 });
    expect(output.arms[1].core).toMatchObject({ denominator: 18, missing: 18 });
    expect(output.prerequisites).toEqual({ rightsConfirmed: false, providerCompatibilityVerified: false });
    expect(output).toMatchObject({ quality: 'not-ready', releaseReady: false, modelCalls: 0 });
    const first = run.manifest.cases[0];
    expect(await readdir(join(run.directory, 'materials', first.id))).toEqual(['assets.html', 'brief.md', 'sample.svg']);
    await writeFile(join(run.directory, 'materials', first.id, 'brief.md'), 'changed');
    await expect(report(run.directory)).rejects.toThrow('Frozen material hash mismatch');
  });

  it('does not disclose the mapping, arm, private history or creator self-check', async () => {
    const run = await setup();
    const item = run.manifest.cases[0];
    const frozen = JSON.parse(await readFile(join(run.directory, 'manifest.json'), 'utf8'));
    expect(frozen.creation.B.image).toBe(harnessImage);
    expect(frozen.review.B.image).toBe(harnessImage);
    await expect(run.creation(item, 'B', { image: changedImage })).rejects.toThrow('Run image differs');
    await expect(run.creation(item, 'B', { image: undefined })).rejects.toThrow('Run image differs');
    const selfCheck = await run.artifact('private-self-check.json', '{"creatorSelfCheck":"history-must-remain-private"}');
    const html = await run.creation(item, 'B', { attachments: [selfCheck] });
    const result = await packet(run.directory, 'creation', item.id, 'B');
    const dir = join(run.directory, 'blind', result.packetId);
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['assets.html', 'brief.md', 'checklist.json', 'game.html', 'packet.json', 'sample.svg']);
    const contents = (await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')))).join('\n');
    expect(contents).not.toMatch(/history-must-remain-private|creatorSelfCheck|implementationCommit|modelConfigSha256|"arm"|registry\.cloudflare\.com|mapping\.private/);
    expect(digest(await readFile(join(dir, 'game.html')))).toBe(html.sha256);
    await expect(run.creation(run.manifest.cases[1], 'A', {}, '<!-- pgc:check internal -->')).rejects.toThrow('Embedded creator self-check');
    await writeFile(join(run.directory, html.path), 'changed');
    await expect(report(run.directory)).rejects.toThrow('File hash mismatch');
  });

  it('preserves a recorded failed run and refuses substituted HTML or mismatched review phases', async () => {
    const run = await setup();
    const [first, second] = run.manifest.cases;
    const failed = { status: 'failed', ...run.clock, failure: 'provider-refused', blindSafe: false, stages: [], html: null };
    await run.creation(first, 'A', failed);
    const a = await run.creation(second, 'A', {}, '<title>A version</title>');
    const b = await run.creation(second, 'B', {}, '<title>B version</title>');
    await expect(run.lockedReviewInput(second, a)).rejects.toThrow('exact blind-safe completed B HTML');
    const lock = await run.lockedReviewInput(second, b);
    await expect(run.review(second, 'B', b, lock, { htmlSha256: a.sha256 })).rejects.toThrow('same locked HTML');
    await expect(run.review(second, 'B', b, lock, { evidenceSha256: 'e'.repeat(64) })).rejects.toThrow('same locked HTML');
    await expect(run.review(second, 'B', b, lock, { modelConfigSha256: 'e'.repeat(64) })).rejects.toThrow('same locked HTML');
    await expect(run.review(second, 'B', b, lock, { image: changedImage })).rejects.toThrow('Run image differs');
    await expect(run.review(second, 'B', b, lock, {}, { image: changedImage })).rejects.toThrow('Run image differs');
    await expect(run.review(second, 'B', b, lock, { initialReportSha256: 'e'.repeat(64) })).rejects.toThrow('exact initial report');
    await run.review(second, 'B', b, lock);
    const blind = await packet(run.directory, 'review', second.id, 'B');
    const files = await readdir(join(run.directory, 'blind', blind.packetId));
    expect(files.sort()).toEqual(['catalog-1-1.txt', 'critical-catalog.json', 'game.html', 'packet.json', 'probe.json', 'report.json',
      'viewport-1.png', 'viewport-2.png', 'viewport-3.png', 'viewport-4.png']);
    const summary = await report(run.directory);
    expect(summary.arms[0].creation).toEqual({ denominator: 6, completed: 1, failed: 1, missing: 4 });
    expect(summary.cases[0].runs[0].creation.failure).toBe('provider-refused');
    expect(summary.arms[1].criticalHits).toMatchObject({ denominator: 1, missing: 1 });
    expect(summary.quality).toBe('not-ready');
  });

  it.each(['ceiling', 'improved', 'disputed', 'critical-miss', 'unsupported'] as const)(
    'accounts for all six blinded pairs in the %s condition', async mode => {
      const run = await setup();
      for (const [index, item] of run.manifest.cases.entries()) {
        await run.creation(item, 'A');
        const html = await run.creation(item, 'B');
        const lock = await run.lockedReviewInput(item, html);
        for (const arm of ['A', 'B'] as const) {
          const controlGap = arm === 'A' && mode !== 'ceiling' && index === 0;
          await run.judge(item, arm, 'creation', {
            checks: item.checklist.map(({ id }) => run.finding(id, controlGap && id === 'control' ? 'failed' : 'verified')),
          });
          await run.review(item, arm, html, lock);
          await run.judge(item, arm, 'review', {
            disputes: mode === 'disputed' && index === 0 && arm === 'B' ? ['Open dispute'] : [],
            criticalHits: [run.finding('critical-1', mode === 'critical-miss' && index === 0 && arm === 'B' ? 'failed' : 'verified')],
            mandatoryRemediations: mode === 'unsupported' && index === 0 && arm === 'B' ? [run.finding('mandatory-1', 'failed')] : [],
          });
        }
      }
      const result = await report(run.directory);
      const quality = { ceiling: 'failed', improved: 'passed', disputed: 'not-ready', 'critical-miss': 'failed', unsupported: 'failed' };
      expect(result.quality).toBe(quality[mode]);
      expect(result.controlCeiling).toBe(mode === 'disputed' ? null : mode === 'ceiling');
      expect(result.improvedQualityMetrics).toEqual(mode === 'ceiling' || mode === 'disputed' ? [] : ['control']);
      expect(result.arms[1].review).toEqual({ denominator: 6, completed: 6, failed: 0, missing: 0 });
      expect(result.arms[1].criticalHits.denominator).toBe(6);
      expect(result.releaseReady).toBe(false);
    },
  );
});
