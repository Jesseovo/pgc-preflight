import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { importRecord, lockedReviewCapture, packet, prepare, readFrozenComparison, readFrozenEmbeddedComparison, report,
  type EmbeddedComparisonIdentity } from '../scripts/harness-evaluation';
import { prepareEmbeddedHarnessConfig } from '../scripts/prepare-embedded-harness-release';
import { canonicalHarness, CCB_ENGINE_COMMIT, EMBEDDED_CCB_VERSION } from '../server/harness-policy';

const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const revision = 'b'.repeat(40);
const harnessImage = `registry.cloudflare.com/${'1'.repeat(32)}/fixture@sha256:${'c'.repeat(64)}`;
const changedImage = harnessImage.replace(/c{64}$/, 'f'.repeat(64));
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const coreBundle = 'export const embeddedCoreFixture = true;\n';
const embedded = { engine: 'ccb-embedded', coreVersion: EMBEDDED_CCB_VERSION, coreBundleSha256: digest(coreBundle) } as const;
const profiles = {
  creation: { name: 'Synthetic creation', model: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://provider.invalid', enabled: true,
    vision: true, effort: 'low', maxOutputTokens: 0, updatedAt: 'synthetic' },
  review: { name: 'Synthetic review', model: 'deepseek-test', protocol: 'openai', baseUrl: 'https://provider.invalid/v1', enabled: true,
    vision: false, effort: 'low', maxOutputTokens: 0, updatedAt: 'synthetic' },
};
const directories: string[] = [];
type Arm = 'A' | 'B';
type Time = { startedAt: string; finishedAt: string };
type Ref = { path: string; sha256: string };
type Case = { id: string; materialSha256: string; checklist: { id: string }[] };

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(configured = true, archived = false, mutateArchive?: (index: { checklistSha256: string; cases: { id: string; materials: Ref[] }[] }) => void,
  identity?: EmbeddedComparisonIdentity) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pgc-harness-eval-')));
  directories.push(directory);
  await mkdir(join(directory, 'inputs'), { mode: 0o700 });
  async function artifact(name: string, bytes: Buffer | string): Promise<Ref> {
    const path = `inputs/${name}`;
    await writeFile(join(directory, path), bytes, { mode: 0o600 });
    return { path, sha256: digest(bytes) };
  }
  const rules = await artifact('rules.json', '{"synthetic":"rules"}');
  const calibration = await artifact('calibration.json', '[]');
  const creationConfig = await artifact('creation-config.json', identity ? encoded(profiles.creation) : '{"model":"claude-opus-5-5"}');
  const reviewConfig = await artifact('review-config.json', identity ? encoded(profiles.review) : '{"model":"deepseek-test"}');
  const settings = await artifact('settings.json', encoded({
    creationModel: { name: 'claude-opus-5-5', config: creationConfig },
    reviewModel: { name: 'deepseek-test', config: reviewConfig },
    rulesVersion: 'synthetic-v2', rules, calibration, harnessCommit: revision, ...(identity ?? { harnessImage }),
  }));
  let indexPath: string | undefined;
  if (archived) {
    const fixtures = fileURLToPath(new URL('../fixtures/harness-evaluation', import.meta.url));
    const checklist = await readFile(join(fixtures, 'checklists.json'));
    const cases = await Promise.all((JSON.parse(checklist.toString('utf8')) as Case[]).map(async ({ id }) => ({ id,
      materials: await Promise.all(['assets.html', 'brief.md', 'sample.svg'].map(async name => ({
        path: `archive/${id}/${name}`, sha256: digest(await readFile(join(fixtures, id, name))),
      }))),
    })));
    const index = { schemaVersion: 1, checklistSha256: digest(checklist), cases: cases.reverse() };
    mutateArchive?.(index);
    indexPath = join(directory, (await artifact('comparison-index.json', encoded(index))).path);
  }
  const manifestSha256 = await prepare(directory, configured ? join(directory, settings.path) : undefined, indexPath);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { cases: Case[]; frozenAt: string };
  const usageEvidence = await artifact('usage.json', '{"input":500,"output":600}');
  const coverageEvidence = [await artifact('observation.txt', 'Synthetic test evidence')];
  const probe = await artifact('probe.json', encoded({ captureMethod: 'browser-viewport-v1', observations: [1, 2, 3, 4].map(i => ({
    id: `baseline-${i}`, label: `original screenshot ${i}`, capturedAt: manifest.frozenAt, actionRefs: [],
  })) }));
  const shots = await Promise.all([1, 2, 3, 4].map(i =>
    artifact(`image-${i}.png`, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from([i])]))));
  const reportArtifact = await artifact('report.json', encoded({
    schema_version: 2, assessment_status: 'complete', aes: 1, ease: 2, play: 1,
    score_reasons: { aes: 'Synthetic', ease: 'Synthetic', play: 'Synthetic' },
    uncertainties: [], verdict: '通过', reviewer_comment: '', strengths: [], issues: [], fix_prompt: '', optional_suggestions: [],
  }));
  const after = (instant: string, amount: number) => new Date(Date.parse(instant) + amount).toISOString();
  const clock = { startedAt: manifest.frozenAt, finishedAt: manifest.frozenAt };
  const observer = { independent: true, observerType: 'human', observerId: 'fixture-catalog-adjudicator' };
  const mark = identity ? { embeddedComparison: identity } : {};
  const runImage = (arm: Arm) => arm === 'B' && !identity ? { image: harnessImage } : {};
  const stage = (phase: string, window: Time) => ({
    phase, status: 'completed', ...window, failure: null, inputTokens: 500, outputTokens: 600, usageEvidence, ...mark,
  });
  async function creation(item: Case, arm: Arm, overrides: object = {}, content = '<!doctype html><title>Synthetic</title>') {
    const html = await artifact(`${item.id}.${arm}.html`, content);
    await importRecord(directory, 'creation', {
      manifestSha256, caseId: item.id, arm, implementationCommit: arm === 'A' ? baseline : revision,
      ...runImage(arm), ...mark,
      materialSha256: item.materialSha256, modelConfigSha256: creationConfig.sha256,
      status: 'completed', ...clock, failure: null, stages: [stage('build', clock)], html, blindSafe: true,
      attachments: [], controllerUsage: arm === 'B' ? { turns: 1, repairs: 0, evidence: usageEvidence } : null, ...overrides,
    });
    return html;
  }
  async function lockedReviewInput(item: Case, html: Ref, overrideProbe = probe, overrideShots = shots) {
    const evidenceSha256 = digest(encoded({ html: html.sha256, probe: overrideProbe.sha256, shots: overrideShots.map(shot => shot.sha256) }));
    const catalog = [{ id: 'critical-1', observation: 'Synthetic observed issue', evidence: coverageEvidence }];
    await importRecord(directory, 'review-input', {
      manifestSha256, caseId: item.id, htmlSha256: html.sha256, evidenceSha256, probe: overrideProbe, shots: overrideShots, ...mark,
      blindSafe: true, ...observer, catalogExhaustive: true, catalog, catalogEvidence: coverageEvidence, disputes: [],
    });
    const locked = JSON.parse(await readFile(join(directory, 'records', `review-input.${item.id}.json`), 'utf8')) as { lockedAt: string };
    return { evidenceSha256, lockedAt: locked.lockedAt };
  }
  async function review(item: Case, arm: Arm, html: Ref, lock: Awaited<ReturnType<typeof lockedReviewInput>>, overrides: object = {}, runOverrides: object = {}) {
    const window = { startedAt: lock.lockedAt, finishedAt: after(lock.lockedAt, 2) };
    const bindings = { htmlSha256: html.sha256, evidenceSha256: lock.evidenceSha256,
      ...runImage(arm), modelConfigSha256: reviewConfig.sha256, rulesSha256: rules.sha256, calibrationSha256: calibration.sha256 };
    const initial = { ...stage('initial', { startedAt: window.startedAt, finishedAt: after(window.startedAt, 1) }), ...bindings };
    const verify = { ...stage('verify', { startedAt: initial.finishedAt, finishedAt: window.finishedAt }), ...bindings, initialReportSha256: reportArtifact.sha256, ...overrides };
    return importRecord(directory, 'review', {
      manifestSha256, caseId: item.id, arm, implementationCommit: arm === 'A' ? baseline : revision,
      ...runImage(arm), ...mark,
      status: 'completed', ...window, failure: null, initial, verify,
      initialReport: reportArtifact, finalReport: reportArtifact, attachments: [], blindSafe: true, ...runOverrides,
    });
  }
  function finding(id: string, state = 'verified') { return { id, state, observation: 'Independent synthetic observation', evidence: coverageEvidence }; }
  async function judge(item: Case, arm: Arm, kind: 'creation' | 'review', overrides: object = {}) {
    const disclosed = await packet(directory, kind, item.id, arm);
    return importRecord(directory, kind === 'creation' ? 'creation-judgment' : 'review-judgment', {
      manifestSha256, ...disclosed, ...observer, ...mark, observerId: `fixture-${kind}-${arm}`, blind: true, coverageComplete: true, coverageEvidence, disputes: [],
      ...(kind === 'creation'
        ? { checks: item.checklist.map(({ id }) => finding(id)), criticalDefects: [], unapprovedCoreChanges: [] }
        : { mandatoryRemediations: [], criticalHits: [finding('critical-1')] }),
      ...overrides,
    });
  }
  return { directory, manifest, manifestSha256, indexPath, artifact, creation, lockedReviewInput, review, judge, finding, clock, mark,
    creationConfig, reviewConfig };
}

describe('offline harness evaluation', () => {
  it('verifies and seals the archived materials without treating a rehearsal as a formal freeze', async () => {
    const run = await setup(false, true);
    expect((await report(run.directory)).registration).toEqual({
      settingsFrozen: false, materialIndexSha256: digest(await readFile(run.indexPath!)),
    });
    await expect(setup(false, true, index => { index.cases[0].materials[0].sha256 = '1'.repeat(64); }))
      .rejects.toThrow('Archived material differs');
    await expect(setup(false, true, index => { index.checklistSha256 = '1'.repeat(64); }))
      .rejects.toThrow('Archived checklist differs');
  });

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
    const enhanced = await run.artifact('enhanced-probe.json', '{"captureMethod":"browser-viewport-v2"}');
    await expect(run.lockedReviewInput(second, b, enhanced)).rejects.toThrow('original basic Chromium capture');
    await expect(run.lockedReviewInput(second, b, undefined, [a, a, a, a])).rejects.toThrow('original PNG or JPEG');
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

  it('rejects reuse of a same-case observer between the critical catalog and blind packets', async () => {
    const run = await setup();
    const item = run.manifest.cases[0];
    const html = await run.creation(item, 'B');
    const locked = await run.lockedReviewInput(item, html);
    await run.review(item, 'B', html, locked);
    await run.judge(item, 'B', 'creation', { observerId: 'separate-observer' });
    await expect(run.judge(item, 'B', 'review', { observerId: 'SEPARATE-observer' })).rejects.toThrow('different independent observer');
    await run.review(item, 'A', html, locked);
    await expect(run.judge(item, 'A', 'review', { observerId: 'fixture-catalog-adjudicator' })).rejects.toThrow('different independent observer');
    expect((await report(run.directory)).arms.map(arm => arm.adjudicatedReviews)).toEqual([0, 0]);
  });

  it('replays the exact B HTML, basic probe and original images into independent Runner contexts', async () => {
    const run = await setup();
    const item = run.manifest.cases[0];
    const original = '<title>Synthetic paired evidence</title>';
    const html = await run.creation(item, 'B', {}, original);
    await expect(lockedReviewCapture(run.directory, item.id)).rejects.toThrow('Lock the review input before replay');
    await run.lockedReviewInput(item, html);
    const captureA = await lockedReviewCapture(run.directory, item.id);
    const captureB = await lockedReviewCapture(run.directory, item.id);
    const [a, b] = await Promise.all([captureA(original), captureB(original)]);
    expect(a).toEqual(b);
    expect(a.probe).toEqual(JSON.parse(await readFile(join(run.directory, 'inputs/probe.json'), 'utf8')));
    for (const [index, shot] of a.shots.entries()) {
      expect(shot.label).toBe(`original screenshot ${index + 1}`);
      expect(Buffer.from(shot.data.split(',')[1], 'base64')).toEqual(await readFile(join(run.directory, `inputs/image-${index + 1}.png`)));
    }
    a.shots[0].label = 'mutation isolated to arm A';
    expect(await captureA(original)).toEqual(b);
    await expect(captureB(original + '\n')).rejects.toThrow('Runner HTML differs');
    await writeFile(join(run.directory, 'inputs/image-1.png'), 'changed');
    await expect(lockedReviewCapture(run.directory, item.id)).rejects.toThrow('File hash mismatch');
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

describe('embedded comparison registration and release', () => {
  it('rejects an embedded freeze without an exact core version and digest or with a legacy image', async () => {
    await expect(setup(true, true, undefined, { ...embedded, coreBundleSha256: 'bad-digest' }))
      .rejects.toThrow('Invalid SHA-256 for embedded core bundle');
    await expect(setup(true, true, undefined, { ...embedded, coreVersion: 'other-core' as typeof EMBEDDED_CCB_VERSION }))
      .rejects.toThrow('supported embedded CCB core version');
    const mixed = { ...embedded, harnessImage };
    await expect(setup(true, true, undefined, mixed)).rejects.toThrow('Unexpected fields in settings');
  });

  it('freezes the no-image embedded identity and refuses cross-engine records and workflows', async () => {
    const run = await setup(true, true, undefined, embedded);
    const old = await setup(true, true);
    const current = run.manifest.cases[0];
    const frozen = JSON.parse(await readFile(join(run.directory, 'manifest.json'), 'utf8'));
    expect(frozen.settings).toMatchObject(embedded);
    expect(frozen.settings).not.toHaveProperty('harnessImage');
    for (const workflow of [frozen.creation, frozen.review]) {
      expect(workflow.B).toMatchObject(embedded);
      expect(workflow.B).not.toHaveProperty('image');
      expect(workflow.A).not.toHaveProperty('engine');
    }
    await expect(readFrozenEmbeddedComparison(run.directory, run.indexPath!)).resolves.toMatchObject({ settings: embedded });
    await expect(readFrozenEmbeddedComparison(old.directory, old.indexPath!)).rejects.toThrow('requires an embedded registry');
    await expect(readFrozenComparison(run.directory, run.indexPath!)).rejects.toThrow('cannot use an embedded registry');
    await expect(readFrozenComparison(old.directory, old.indexPath!)).resolves.toMatchObject({ settings: { harnessImage } });

    await expect(run.creation(current, 'B', { embeddedComparison: undefined })).rejects.toThrow('frozen embedded comparison identity');
    await expect(run.creation(current, 'B', { image: harnessImage })).rejects.toThrow('cannot declare a container image');
    await expect(run.creation(current, 'A', { embeddedComparison: { ...embedded, coreBundleSha256: 'f'.repeat(64) } }))
      .rejects.toThrow('frozen embedded comparison identity');
    await expect(old.creation(old.manifest.cases[0], 'B', { embeddedComparison: embedded })).rejects.toThrow('Unexpected fields');
    const html = await run.creation(current, 'B');
    const lock = await run.lockedReviewInput(current, html);
    await expect(run.review(current, 'B', html, lock, { embeddedComparison: undefined })).rejects.toThrow('frozen embedded comparison identity');
    await expect(run.review(current, 'B', html, lock, {}, { manifestSha256: old.manifestSha256 })).rejects.toThrow('frozen manifest');
    await run.review(current, 'B', html, lock);
    const disclosed = await packet(run.directory, 'review', current.id, 'B');
    const blind = JSON.parse(await readFile(join(run.directory, 'blind', disclosed.packetId, 'packet.json'), 'utf8'));
    expect(JSON.stringify(blind)).not.toMatch(/embeddedComparison|ccb-embedded|coreBundleSha256|implementationCommit/);
    expect(await report(run.directory)).toMatchObject({ registration: { embeddedComparison: embedded }, releaseReady: false, quality: 'not-ready' });
    const file = join(run.directory, 'records', `review.${current.id}.B.json`);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    delete stored.initial.embeddedComparison;
    await writeFile(file, encoded(stored));
    await expect(report(run.directory)).rejects.toThrow('frozen embedded comparison identity');
  });

  it('only prepares the ordinary rollout-off config after a complete embedded quality and evidence gate', async () => {
    const run = await setup(true, true, undefined, embedded);
    const repository = fileURLToPath(new URL('../', import.meta.url));
    const base = JSON.parse(await readFile(join(repository, 'wrangler.jsonc'), 'utf8'));
    const outputDir = join(run.directory, 'unwritten-release');
    const args = { evaluation: run.directory, evidence: join(run.directory, 'inputs', 'release-evidence.json'),
      implementationCommit: revision, base, repository, outputDir };
    await expect(prepareEmbeddedHarnessConfig(args)).rejects.toThrow('complete embedded comparison');

    for (const [index, item] of run.manifest.cases.entries()) {
      await run.creation(item, 'A');
      const html = await run.creation(item, 'B');
      const lock = await run.lockedReviewInput(item, html);
      for (const arm of ['A', 'B'] as const) {
        await run.judge(item, arm, 'creation', {
          checks: item.checklist.map(({ id }) => run.finding(id, index === 0 && arm === 'A' && id === 'control' ? 'failed' : 'verified')),
        });
        await run.review(item, arm, html, lock);
        await run.judge(item, arm, 'review');
      }
    }
    expect(await report(run.directory)).toMatchObject({ quality: 'passed', releaseReady: false, modelCalls: 0 });
    const verifiedAt = new Date().toISOString();
    const supporting = await run.artifact('supporting.json', encoded({ fixture: true, synthetic: true }));
    const bundle = await run.artifact('core-bundle.mjs', coreBundle);
    const pin = { schemaVersion: 1, ...embedded, engineCommit: CCB_ENGINE_COMMIT, implementationCommit: revision, manifestSha256: run.manifestSha256 };
    const workerVersion = 'a1111111-a111-4111-8111-a11111111111';
    const receipt = (workflow: 'creation' | 'review') => {
      const { baseUrl, model, protocol, vision, effort, maxOutputTokens } = profiles[workflow];
      const contract = digest(canonicalHarness({ baseUrl, model, protocol, vision,
        effort: workflow === 'creation' ? 'high' : effort, maxOutputTokens }));
      return { ...pin, kind: 'embedded-real-provider', workflow, verifiedAt, workerVersion,
        modelConfigSha256: (workflow === 'creation' ? run.creationConfig : run.reviewConfig).sha256,
        modelContractSha256: contract, contextWindowTokens: 128_000,
        nativeRequests: [{ requestSha256: digest(workflow), httpStatus: 200, attempts: 1,
          terminal: workflow === 'creation' ? 'message_stop' : 'done', outputTokens: 600 }], evidence: [supporting] };
    };
    const creation = await run.artifact('creation-provider-proof.json', encoded(receipt('creation')));
    const review = await run.artifact('review-provider-proof.json', encoded(receipt('review')));
    const isolation = await run.artifact('isolation-proof.json', encoded({ ...pin, kind: 'embedded-runtime-isolation', verifiedAt,
      workerVersion, providerRequests: 0, checks: { existingWorkerAndRunner: true, noContainers: true, noExecutionServices: true,
        taskOwnership: true, browserIsolation: true, exactBrowserClosure: true, noProviderKeyExport: true, terminalCleanup: true },
      evidence: [supporting] }));
    const parity = await run.artifact('core-parity-proof.json', encoded({ ...pin, kind: 'embedded-core-parity', verifiedAt,
      checks: { pinnedUpstream: true, toolContinuation: true, contextCompaction: true, boundedAccounting: true }, evidence: [supporting] }));
    const prerequisite = { manifestSha256: run.manifestSha256, ...run.mark, confirmed: true, observerId: 'independent-fixture-owner',
      confirmedAt: verifiedAt };
    await importRecord(run.directory, 'prerequisite', { ...prerequisite, name: 'rightsConfirmed', evidence: [supporting] });
    await importRecord(run.directory, 'prerequisite', { ...prerequisite, name: 'providerCompatibilityVerified', evidence: [creation, review] });
    const proof = { ...pin, coreBundle: bundle, providerReceipts: [creation, review], isolationReceipt: isolation, parityReceipt: parity };
    await run.artifact('release-evidence.json', encoded(proof));

    const { config, release } = await prepareEmbeddedHarnessConfig(args);
    expect(config.name).toBe(base.name);
    expect(config.durable_objects).toEqual(base.durable_objects);
    expect(config.migrations).toEqual(base.migrations);
    expect(config.browser).toEqual(base.browser);
    expect(config.compatibility_flags).toEqual(base.compatibility_flags);
    expect(resolve(outputDir, config.main)).toBe(resolve(repository, base.main));
    expect(config).not.toHaveProperty('containers');
    expect(config).not.toHaveProperty('services');
    expect(config.vars.HARNESS_ROLLOUT).toBe('off');
    expect(JSON.parse(config.vars.HARNESS_RELEASE)).toMatchObject({ ...embedded, comparisonAccepted: true, isolationVerified: true,
      coreParityVerified: true, compatibleModelContracts: [receipt('creation').modelContractSha256, receipt('review').modelContractSha256].sort() });
    expect(release).not.toHaveProperty('image');
    expect(await readdir(run.directory)).not.toContain('unwritten-release');

    await expect(prepareEmbeddedHarnessConfig({ ...args, implementationCommit: baseline })).rejects.toThrow('exact evaluated implementation commit');
    await run.artifact('release-evidence.json', encoded({ ...proof, coreBundle: supporting }));
    await expect(prepareEmbeddedHarnessConfig(args)).rejects.toThrow('Core bundle does not match');
    const rejectedIsolation = JSON.parse(await readFile(join(run.directory, isolation.path), 'utf8'));
    rejectedIsolation.checks.exactBrowserClosure = false;
    const noClosure = await run.artifact('isolation-no-close.json', encoded(rejectedIsolation));
    await run.artifact('release-evidence.json', encoded({ ...proof, isolationReceipt: noClosure }));
    await expect(prepareEmbeddedHarnessConfig(args)).rejects.toThrow('All embedded isolation checks');
    const otherWorker = await run.artifact('isolation-other-worker.json', encoded({ ...rejectedIsolation,
      workerVersion: 'b2222222-b222-4222-8222-b22222222222' }));
    await run.artifact('release-evidence.json', encoded({ ...proof, isolationReceipt: otherWorker }));
    await expect(prepareEmbeddedHarnessConfig(args)).rejects.toThrow('did not verify the same embedded Worker');
    const unrelatedReceipt = await run.artifact('unrelated-provider-proof.json', encoded({ ...receipt('review'), workerVersion: baseline }));
    await run.artifact('release-evidence.json', encoded({ ...proof, providerReceipts: [creation, unrelatedReceipt] }));
    await expect(prepareEmbeddedHarnessConfig(args)).rejects.toThrow('not accepted as a comparison prerequisite');
  });
});
