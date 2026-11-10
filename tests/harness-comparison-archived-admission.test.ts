import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { openPausedComparison } from '../scripts/harness-comparison-admission';
import { importRecord, prepare } from '../scripts/harness-evaluation';
import { canonicalHarness } from '../server/harness-policy';

const repository = fileURLToPath(new URL('../', import.meta.url));
const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const revision = '630303565f44c061c7ed8ad7b992dcc4e9db8929';
const image = 'registry.cloudflare.com/071443b43c7562efec975a5e964d5a9c/pgc-ccb-research@sha256:0e95a0406e8dc94b0a4eea1f2cb62ff2a31ff48261d8fca87923d99ebfcec957';
const caseId = 'tap-rhythm';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

function d1(sqlite: DatabaseSync) {
  function prepare(sql: string, values: SQLInputValue[] = []) {
    const statement = sqlite.prepare(sql);
    const execute = () => ({ meta: { changes: Number(statement.run(...values).changes) } });
    return { bind: (...args: SQLInputValue[]) => prepare(sql, args), first: async () => statement.get(...values) ?? null,
      all: async () => ({ results: statement.all(...values) }), run: async () => execute(), execute };
  }
  return { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
}

async function registryFixture(parent: string) {
  const registry = join(parent, 'registry');
  await mkdir(registry, { mode: 0o700 });
  await mkdir(join(registry, 'inputs'), { mode: 0o700 });
  async function input(name: string, bytes: Buffer | string) {
    const path = 'inputs/' + name;
    await writeFile(join(registry, path), bytes, { mode: 0o600 });
    return { path, sha256: sha(bytes) };
  }
  const opus = { model: 'claude-opus-5-5', protocol: 'anthropic', baseUrl: 'https://riffle-api.pages.dev', enabled: true,
    effort: 'high', vision: true, maxOutputTokens: 64_000, updatedAt: '2026-11-06T00:00:00.000Z' };
  const deepseek = { ...opus, model: 'deepseek-flash', protocol: 'openai', baseUrl: 'https://api.deepseek.com', effort: 'low', maxOutputTokens: 24_000 };
  const creationConfig = await input('create.json', encoded(opus));
  const reviewConfig = await input('review.json', encoded(deepseek));
  const ruleContent = { sourceUrl: 'https://creator-hub-7mi.pages.dev/#/', capturedAt: opus.updatedAt, rawDirection: 'Synthetic archived A rule',
    rawScoring: 'Synthetic archived A scoring', scoreMin: 0, scoreMax: 3, passScore: 7, notes: '', calibrationCases: [] };
  const rules = { schemaVersion: 2, id: 'archived-a-rehearsal-rules', contentHash: sha(canonicalHarness(ruleContent)), publishedAt: opus.updatedAt, ...ruleContent };
  const settings = await input('settings.json', encoded({ creationModel: { name: opus.model, config: creationConfig },
    reviewModel: { name: deepseek.model, config: reviewConfig }, rulesVersion: rules.id, rules: await input('rules.json', encoded(rules)),
    calibration: await input('calibration.json', '[]'), harnessCommit: revision, harnessImage: image }));
  const fixtureRoot = join(repository, 'fixtures/harness-evaluation');
  const checklists = await readFile(join(fixtureRoot, 'checklists.json'));
  const cases = await Promise.all((JSON.parse(checklists.toString()) as { id: string }[]).map(async ({ id }) => ({ id,
    materials: await Promise.all(['brief.md', 'sample.svg', 'assets.html'].map(async name => ({ path: `archive/${id}/${name}`, sha256: sha(await readFile(join(fixtureRoot, id, name))) }))),
  })));
  const comparisonIndex = join(parent, 'index.json');
  await writeFile(comparisonIndex, encoded({ schemaVersion: 1, checklistSha256: sha(checklists), cases }));
  const manifestSha256 = await prepare(registry, join(registry, settings.path), comparisonIndex);
  const manifest = JSON.parse(await readFile(join(registry, 'manifest.json'), 'utf8'));
  const time = { startedAt: manifest.frozenAt, finishedAt: manifest.frozenAt };
  const html = '<!doctype html><title>Archived A receives B</title>\r\n';
  const htmlRef = await input('b.html', html);
  await importRecord(registry, 'creation', { manifestSha256, caseId, arm: 'B', implementationCommit: revision, image,
    materialSha256: manifest.cases[0].materialSha256, modelConfigSha256: creationConfig.sha256, status: 'completed', ...time,
    failure: null, html: htmlRef, blindSafe: true, controllerUsage: null, attachments: [],
    stages: [{ phase: 'build', status: 'completed', ...time, failure: null, inputTokens: null, outputTokens: null, usageEvidence: null }],
  });
  const labels = [ ['9:16 首次触摸后约 10 秒', 'baseline-9:16-tap'], ['9:19.5 首次触摸前'],
    ['9:19.5 首次触摸后约 3 秒', 'baseline-9:19.5-tap'], ['9:21 首次触摸后约 10 秒', 'baseline-9:21-tap'] ];
  const probe = await input('probe.json', encoded({ captureMethod: 'browser-viewport-v1', observations: labels.map(([label, ...actionRefs], index) =>
    ({ id: 'baseline-' + (index + 1), label, actionRefs, capturedAt: manifest.frozenAt })) }));
  const shots = await Promise.all([1, 2, 3, 4].map(index => input(`shot-${index}.jpg`, Buffer.from([255, 216, 255, index]))));
  const evidenceSha256 = sha(encoded({ html: htmlRef.sha256, probe: probe.sha256, shots: shots.map(shot => shot.sha256) }));
  const catalog = await input('catalog.txt', 'Synthetic independent evidence for this test');
  await importRecord(registry, 'review-input', { manifestSha256, caseId, htmlSha256: htmlRef.sha256, probe, shots, evidenceSha256, blindSafe: true,
    observerId: 'archived-a-rehearsal-observer', observerType: 'independent-agent', independent: true,
    catalogExhaustive: true, catalogEvidence: [catalog], disputes: [], catalog: [],
  });
  return { registry, comparisonIndex, rules, html, evidenceSha256 };
}

it('pauses actual archived A creation and cloud review against the original A migrations', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pgc-archived-admission-')));
  const sqlite = new DatabaseSync(':memory:');
  const fetch = vi.fn(() => { throw new Error('Archived paused admission cannot call the network'); });
  vi.stubGlobal('fetch', fetch);
  try {
    const source = join(parent, 'source');
    await mkdir(source);
    await symlink(join(repository, 'node_modules'), join(parent, 'node_modules'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repository, maxBuffer: 15 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1' } });
    expect(git(['rev-parse', baseline + '^{tree}']).toString().trim()).toBe('491936d02f57b9125be86e36e73e76048009d82f');
    execFileSync('tar', ['-xf', '-', '-C', source], { input: git(['archive', '--format=tar', baseline]) });
    const load = (file: string) => import(pathToFileURL(join(source, 'server', file)).href);
    const [{ enqueueForgeTask }, { enqueueReview }, { inputSnapshot, saveArtifact }] = await Promise.all([
      load('forge-tasks.ts'), load('review-jobs.ts'), load('forge-workspace.ts'),
    ]);
    const migrationDir = join(source, 'migrations');
    const migrations = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
    expect(migrations.at(-1)).toBe('0032_forge_creation_pipeline.sql');
    for (const migration of migrations) sqlite.exec(await readFile(join(migrationDir, migration), 'utf8'));
    const { registry, comparisonIndex, rules, html, evidenceSha256 } = await registryFixture(parent);
    const options = { DB: d1(sqlite), arm: 'A' as const, registry, comparisonIndex, planDirectory: join(parent, 'plan'), scope: 'rehearsal' as const,
      adapter: { implementationCommit: baseline, enqueueForge: enqueueForgeTask, enqueueReview, inputSnapshot, saveArtifact } };
    const paused = await openPausedComparison(options);
    const create = await paused.admitCreation(caseId);
    const review = await paused.admitReview(caseId);
    const creationRow = sqlite.prepare('SELECT * FROM forge_tasks WHERE id=?').get(create.taskId)!;
    expect(creationRow).toMatchObject({ status: 'queued', executor: 'platform', creative_version: 2, owner_id: paused.ownerId, model_started_at: null });
    expect(creationRow).not.toHaveProperty('harness_policy');
    expect(JSON.parse(String(creationRow.input_snapshot))).toMatchObject({ platform_creation_policy: { maxTokens: 64_000, effort: 'high' } });
    const reviewRow = sqlite.prepare('SELECT * FROM review_jobs WHERE id=?').get(review.taskId)!;
    expect(reviewRow).toMatchObject({ owner_id: 'admin', status: 'queued', model_executor: 'platform', executor: 'cloud', report_schema_version: 2,
      input_ready: 1, model_started_at: null, model_execution_started_at: null, input_hash: sha(html) });
    expect(reviewRow).not.toHaveProperty('harness_policy');
    expect(JSON.parse(String(reviewRow.rules_snapshot))).toEqual(rules);
    expect(review).toMatchObject({ sourceHash: sha(html), evidenceHash: evidenceSha256, state: 'paused', executionAllowed: false, liveDispatches: 0 });
    const resumed = await openPausedComparison(options);
    expect(await resumed.admitCreation(caseId)).toEqual(create);
    expect(await resumed.admitReview(caseId)).toEqual(review);
    expect(sqlite.prepare('SELECT count(*) AS n FROM comparison_schedule_requests').get()).toEqual({ n: 2 });
    expect(sqlite.prepare('SELECT count(*) AS n FROM model_runs').get()).toEqual({ n: 0 });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    sqlite.close();
    await rm(parent, { recursive: true, force: true });
  }
});
