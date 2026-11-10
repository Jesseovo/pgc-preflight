import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { planComparison } from '../scripts/harness-comparison-coordinator';
import { prepare } from '../scripts/harness-evaluation';

const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const commit = '630303565f44c061c7ed8ad7b992dcc4e9db8929';
const image = 'registry.cloudflare.com/071443b43c7562efec975a5e964d5a9c/pgc-ccb-research@sha256:0e95a0406e8dc94b0a4eea1f2cb62ff2a31ff48261d8fca87923d99ebfcec957';
const fixtures = fileURLToPath(new URL('../fixtures/harness-evaluation', import.meta.url));
const materialNames = ['brief.md', 'sample.svg', 'assets.html'];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup(options: { frozen?: boolean; archive?: boolean; candidateCommit?: string; candidateImage?: string } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pgc-comparison-plan-')));
  directories.push(parent);
  const registry = join(parent, 'registry');
  await mkdir(registry, { mode: 0o700 });
  await mkdir(join(registry, 'inputs'));
  async function input(name: string, value: unknown) {
    const path = `inputs/${name}.json`;
    const bytes = encoded(value);
    await writeFile(join(registry, path), bytes);
    return { path, sha256: sha(bytes) };
  }
  const creation = await input('create', { model: 'claude-opus-5-5' });
  const review = await input('review', { model: 'deepseek-fixture' });
  const rules = await input('rules', { version: 'synthetic-v2' });
  const calibration = await input('calibration', []);
  const settings = await input('settings', {
    creationModel: { name: 'claude-opus-5-5', config: creation }, reviewModel: { name: 'deepseek-fixture', config: review },
    rulesVersion: 'synthetic-v2', rules, calibration, harnessCommit: options.candidateCommit ?? commit, harnessImage: options.candidateImage ?? image,
  });
  const checklists = await readFile(join(fixtures, 'checklists.json'));
  const cases = await Promise.all((JSON.parse(checklists.toString('utf8')) as { id: string }[]).map(async ({ id }) => ({ id,
    materials: await Promise.all(materialNames.map(async name => ({ path: `archive/${id}/${name}`, sha256: sha(await readFile(join(fixtures, id, name))) }))),
  })));
  const comparisonIndex = join(parent, 'comparison-index.json');
  await writeFile(comparisonIndex, encoded({ schemaVersion: 1, checklistSha256: sha(checklists), cases }));
  const manifestSha256 = await prepare(registry, options.frozen === false ? undefined : join(registry, settings.path), options.archive === false ? undefined : comparisonIndex);
  return { registry, comparisonIndex, out: join(parent, 'plan'), parent, manifestSha256, creation, review, rules, calibration };
}

it('links all 24 stable offline slots to the six cases and frozen inputs', async () => {
  const fetch = vi.fn(() => { throw new Error('The planner has no network access'); });
  vi.stubGlobal('fetch', fetch);
  const run = await setup();
  const first = await planComparison({ ...run, scope: 'formal' });
  const { plan } = first;
  expect(plan).toMatchObject({ scope: 'formal', executionAllowed: false, manifestSha256: run.manifestSha256,
    verification: { modelProvenance: 'unverified', rulesProvenance: 'unverified', providerCompatibility: 'unverified', executionAuthorization: 'unverified' },
    source: { A: { implementationCommit: baseline }, B: { implementationCommit: commit, image } },
    settings: { creationModel: { config: run.creation }, reviewModel: { config: run.review }, rules: run.rules, calibration: run.calibration },
  });
  expect(plan.materialIndexSha256).toBe(sha(await readFile(run.comparisonIndex)));
  expect(plan.cases.map(item => item.id)).toEqual(['tap-rhythm', 'continuous-drag', 'strategy-tradeoffs', 'collision-feedback', 'difficulty-restart', 'dense-mobile']);
  expect(plan.cases.flatMap(item => item.materials)).toHaveLength(18);
  expect(plan.slots.filter(slot => slot.operation === 'creation')).toHaveLength(12);
  expect(plan.slots.filter(slot => slot.operation === 'review')).toHaveLength(12);
  expect(new Set(plan.slots.map(slot => slot.taskId)).size).toBe(24);
  for (const slot of plan.slots) {
    expect(slot.taskId).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-8[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
    if ('requires' in slot) {
      const b = plan.slots.find(candidate => candidate.operation === 'creation' && candidate.arm === 'B' && candidate.caseId === slot.caseId);
      expect(slot).toMatchObject({ modelConfigSha256: run.review.sha256, rulesSha256: run.rules.sha256, calibrationSha256: run.calibration.sha256,
        requires: { creationTaskId: b!.taskId, creationRecord: `records/creation.${slot.caseId}.B.json`, reviewInputRecord: `records/review-input.${slot.caseId}.json`,
          verification: 'required-at-execution', exactCompletedBlindSafeBHtml: true, originalOrderedBasicShots: 4 } });
    } else {
      expect(slot).toMatchObject({ modelConfigSha256: run.creation.sha256, materialSha256: plan.cases.find(item => item.id === slot.caseId)!.materialSha256 });
    }
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(await readdir(join(run.registry, 'records'))).toEqual([]);
  expect(first.planSha256).toBe(sha(await readFile(first.output)));
  expect((await lstat(first.output)).mode & 0o777).toBe(0o600);
  expect((await lstat(run.out)).mode & 0o777).toBe(0o700);
});

it('makes concurrent identical writes idempotent and separates rehearsal identities', async () => {
  const run = await setup();
  const formal = { ...run, scope: 'formal' as const };
  const [first, repeat] = await Promise.all([planComparison(formal), planComparison(formal)]);
  expect(first).toEqual(repeat);
  expect(await readdir(run.out)).toEqual(['plan.json']);
  const other = await planComparison({ ...run, scope: 'rehearsal', out: join(run.parent, 'rehearsal') });
  expect(other.plan).toMatchObject({ scope: 'rehearsal', executionAllowed: false });
  expect(other.plan.slots.every(slot => !first.plan.slots.some(original => original.taskId === slot.taskId))).toBe(true);
  await expect(planComparison({ ...run, scope: 'rehearsal' })).rejects.toThrow('Existing comparison plan conflicts');
  expect(sha(await readFile(first.output))).toBe(first.planSha256);
});

it('requires frozen model snapshots, an archived index and the formal pins', async () => {
  await expect(planComparison({ ...await setup({ frozen: false }), scope: 'formal' })).rejects.toThrow('Freeze model and rules snapshots');
  await expect(planComparison({ ...await setup({ archive: false }), scope: 'formal' })).rejects.toThrow('Comparison index differs');
  const otherCommit = await setup({ candidateCommit: 'b'.repeat(40) });
  await expect(planComparison({ ...otherCommit, scope: 'formal' })).rejects.toThrow('pinned B implementation and image');
  await expect(planComparison({ ...otherCommit, scope: 'rehearsal' })).resolves.toMatchObject({ plan: { scope: 'rehearsal' } });
  const otherImage = await setup({ candidateImage: image.replace(/:[a-f\d]{64}$/, `:${'d'.repeat(64)}`) });
  await expect(planComparison({ ...otherImage, scope: 'formal' })).rejects.toThrow('pinned B implementation and image');
});

it('rejects tampered model config, material, index and resealed case paths', async () => {
  const run = await setup();
  const config = join(run.registry, run.review.path);
  const original = await readFile(config);
  await writeFile(config, '{}');
  await expect(planComparison({ ...run, scope: 'formal' })).rejects.toThrow('File hash mismatch for model configuration snapshot');
  await writeFile(config, original);
  const material = join(run.registry, 'materials', 'tap-rhythm', 'brief.md');
  const materialBytes = await readFile(material);
  await writeFile(material, Buffer.concat([materialBytes, Buffer.from('!')]));
  await expect(planComparison({ ...run, scope: 'formal' })).rejects.toThrow('Frozen material hash mismatch');
  await writeFile(material, materialBytes);
  const index = await readFile(run.comparisonIndex);
  await writeFile(run.comparisonIndex, Buffer.concat([index, Buffer.from(' ')]));
  await expect(planComparison({ ...run, scope: 'formal' })).rejects.toThrow('Comparison index differs');
  await writeFile(run.comparisonIndex, index);
  const manifestPath = join(run.registry, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.cases[0].id = '../../inputs';
  const forged = encoded(manifest);
  await writeFile(manifestPath, forged);
  const seal = join(run.registry, 'registration.json');
  await writeFile(seal, encoded({ ...JSON.parse(await readFile(seal, 'utf8')), manifestSha256: sha(forged) }));
  await expect(planComparison({ ...run, scope: 'formal' })).rejects.toThrow('six registered cases');
  await expect(lstat(run.out)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects changed source, budget or review mode even if the manifest was resealed', async () => {
  const run = await setup();
  const manifestPath = join(run.registry, 'manifest.json');
  const sealPath = join(run.registry, 'registration.json');
  const manifestBytes = await readFile(manifestPath, 'utf8');
  const originalSeal = JSON.parse(await readFile(sealPath, 'utf8'));
  for (const edit of [
    ['creation', 'A', 'implementationCommit', 'e'.repeat(40)],
    ['creation', 'B', 'taskMaxOutputTokens', 256_001],
    ['review', 'B', 'mode', 'enhanced'],
  ] as const) {
    const [operation, arm, field, value] = edit;
    const manifest = JSON.parse(manifestBytes);
    manifest[operation][arm][field] = value;
    const changed = encoded(manifest);
    await writeFile(manifestPath, changed);
    await writeFile(sealPath, encoded({ ...originalSeal, manifestSha256: sha(changed) }));
    await expect(planComparison({ ...run, scope: 'formal' })).rejects.toThrow('Frozen creation or review workflow differs');
  }
  await expect(lstat(run.out)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects coordinated material replacement in the registry and archived index', async () => {
  const run = await setup();
  const changed = 'replacement brief';
  await writeFile(join(run.registry, 'materials', 'tap-rhythm', 'brief.md'), changed);
  const archive = JSON.parse(await readFile(run.comparisonIndex, 'utf8'));
  archive.cases[0].materials[0].sha256 = sha(changed);
  await writeFile(run.comparisonIndex, encoded(archive));
  const manifestPath = join(run.registry, 'manifest.json');
  const sealPath = join(run.registry, 'registration.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.materialIndexSha256 = sha(encoded(archive));
  manifest.cases[0].materials['brief.md'] = sha(changed);
  manifest.cases[0].materialSha256 = sha(encoded(manifest.cases[0].materials));
  const bytes = encoded(manifest);
  await writeFile(manifestPath, bytes);
  await writeFile(sealPath, encoded({ ...JSON.parse(await readFile(sealPath, 'utf8')), manifestSha256: sha(bytes) }));
  await expect(planComparison({ ...run, scope: 'formal' })).rejects.toThrow('fixed comparison fixture');
  await expect(lstat(run.out)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a frozen JSON snapshot that explicitly names a different model', async () => {
  const run = await setup();
  const manifestPath = join(run.registry, 'manifest.json');
  const sealPath = join(run.registry, 'registration.json');
  const changed = encoded({ model: 'unexpected-model' });
  await writeFile(join(run.registry, run.review.path), changed);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.settings.reviewModel.config.sha256 = sha(changed);
  const bytes = encoded(manifest);
  await writeFile(manifestPath, bytes);
  await writeFile(sealPath, encoded({ ...JSON.parse(await readFile(sealPath, 'utf8')), manifestSha256: sha(bytes) }));
  await expect(planComparison({ ...run, scope: 'formal' })).rejects.toThrow('disagrees with the registered model name');
});

it('rejects path traversal and symlinked inputs, directories and output files', async () => {
  const run = await setup();
  const formal = { ...run, scope: 'formal' as const };
  await expect(planComparison({ ...formal, out: `${run.parent}/../escaped` })).rejects.toThrow('must not traverse');
  const alias = join(run.parent, 'alias');
  await symlink(run.registry, alias);
  await expect(planComparison({ ...formal, registry: alias })).rejects.toThrow('without symbolic links');
  await expect(planComparison({ ...formal, out: alias })).rejects.toThrow('without symbolic links');
  const aliasIndex = join(run.parent, 'alias-index.json');
  await symlink(run.comparisonIndex, aliasIndex);
  await expect(planComparison({ ...formal, comparisonIndex: aliasIndex })).rejects.toThrow('without symbolic links');
  const material = join(run.registry, 'materials', 'tap-rhythm', 'brief.md');
  const materialBytes = await readFile(material);
  await unlink(material);
  await symlink(join(fixtures, 'tap-rhythm', 'brief.md'), material);
  await expect(planComparison(formal)).rejects.toThrow('without symbolic links');
  await unlink(material);
  await writeFile(material, materialBytes);
  const existing = await planComparison({ ...formal, out: join(run.parent, 'previous') });
  await mkdir(run.out, { mode: 0o700 });
  await symlink(existing.output, join(run.out, 'plan.json'));
  await expect(planComparison(formal)).rejects.toThrow('not a private regular file');
  expect(sha(await readFile(existing.output))).toBe(existing.planSha256);
});
