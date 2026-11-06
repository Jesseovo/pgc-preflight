import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { currentComparisonAdmissionAdapter, openPausedComparison } from '../scripts/harness-comparison-admission';
import { buildComparisonEvidencePack } from '../scripts/harness-comparison-evidence';
import { importRecord, prepare } from '../scripts/harness-evaluation';
import { canonicalHarness } from '../server/harness-policy';

const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const revision = '630303565f44c061c7ed8ad7b992dcc4e9db8929';
const image = 'registry.cloudflare.com/071443b43c7562efec975a5e964d5a9c/pgc-ccb-research@sha256:0e95a0406e8dc94b0a4eea1f2cb62ff2a31ff48261d8fca87923d99ebfcec957';
const caseId = 'tap-rhythm';
const html = '<!doctype html><title>Synthetic comparison B</title>\r\n';
const directories: string[] = [], databases: DatabaseSync[] = [];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function database() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  for (const file of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  let failures: string[] = [];
  const DB = {
    prepare(sql: string) {
      let values: any[] = [];
      const statement = {
        bind(...args: any[]) { values = args; return statement; },
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
        run: async () => statement.execute(),
        execute() {
          if (failures.length && sql.includes(failures[0])) { failures.shift(); throw new Error('Synthetic interrupted review input write'); }
          return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
        },
      };
      return statement;
    },
    batch: async (statements: { execute(): unknown }[]) => {
      sqlite.exec('BEGIN');
      try { const rows = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return rows; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { DB, sqlite, fail: (...parts: string[]) => { failures = parts; } };
}

async function setup() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pgc-review-admission-')));
  directories.push(parent);
  const registry = join(parent, 'registry');
  await mkdir(join(registry, 'inputs'), { recursive: true, mode: 0o700 });
  async function input(name: string, bytes: Buffer | string) {
    const path = `inputs/${name}`;
    await writeFile(join(registry, path), bytes);
    return { path, sha256: sha(bytes) };
  }
  const create = await input('create.json', encoded({ model: 'claude-opus-5-5', baseUrl: 'https://riffle-api.pages.dev', protocol: 'anthropic',
    effort: 'high', maxOutputTokens: 0, vision: true, enabled: true, updatedAt: 'synthetic' }));
  const review = await input('review.json', encoded({ model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', protocol: 'openai',
    effort: 'low', maxOutputTokens: 0, vision: true, enabled: true, updatedAt: 'synthetic' }));
  const ruleContent = { sourceUrl: 'https://creator-hub-7mi.pages.dev/#/', capturedAt: '2026-11-05T00:00:00.000Z',
    rawDirection: 'Synthetic rule', rawScoring: 'Synthetic scoring', scoreMin: 0, scoreMax: 3, passScore: 7, notes: '', calibrationCases: [] };
  const rules = { schemaVersion: 2, id: 'synthetic-rules', contentHash: sha(canonicalHarness(ruleContent)), publishedAt: '2026-11-05T00:00:00.000Z', ...ruleContent };
  const settings = await input('settings.json', encoded({ creationModel: { name: 'claude-opus-5-5', config: create },
    reviewModel: { name: 'deepseek-flash', config: review }, rulesVersion: rules.id, rules: await input('rules.json', encoded(rules)),
    calibration: await input('calibration.json', '[]'), harnessCommit: revision, harnessImage: image }));
  const checklists = await readFile('fixtures/harness-evaluation/checklists.json');
  const cases = await Promise.all((JSON.parse(checklists.toString()) as { id: string }[]).map(async ({ id }) => ({ id,
    materials: await Promise.all(['brief.md', 'sample.svg', 'assets.html'].map(async name => ({ path: `archive/${id}/${name}`,
      sha256: sha(await readFile(`fixtures/harness-evaluation/${id}/${name}`)) }))),
  })));
  const comparisonIndex = join(parent, 'index.json');
  await writeFile(comparisonIndex, encoded({ schemaVersion: 1, checklistSha256: sha(checklists), cases }));
  const manifestSha256 = await prepare(registry, join(registry, settings.path), comparisonIndex);
  const manifest = JSON.parse(await readFile(join(registry, 'manifest.json'), 'utf8')) as { frozenAt: string; cases: { id: string; materialSha256: string }[] };
  const time = { startedAt: manifest.frozenAt, finishedAt: manifest.frozenAt };
  const b = await input('game-b.html', html);
  await importRecord(registry, 'creation', {
    manifestSha256, caseId, arm: 'B', implementationCommit: revision, image, materialSha256: manifest.cases[0].materialSha256,
    modelConfigSha256: create.sha256, status: 'completed', ...time, failure: null, html: b, blindSafe: true, controllerUsage: null,
    attachments: [await input('private-self-check.json', '{"creatorSelfCheck":"PRIVATE_SELFCHECK"}')],
    stages: [{ phase: 'build', status: 'completed', ...time, failure: null, inputTokens: null, outputTokens: null, usageEvidence: null }],
  });
  const probe = await input('probe.json', encoded({ captureMethod: 'browser-viewport-v1', observations: [
    ['9:16 首次触摸后约 10 秒', 'baseline-9:16-tap'], ['9:19.5 首次触摸前'],
    ['9:19.5 首次触摸后约 3 秒', 'baseline-9:19.5-tap'], ['9:21 首次触摸后约 10 秒', 'baseline-9:21-tap'],
  ].map(([label, ...actionRefs], i) => ({ id: `baseline-${i + 1}`, label, actionRefs, capturedAt: manifest.frozenAt })) }));
  const shots = await Promise.all([1, 2, 3, 4].map(i => input(`view-${i}.jpg`, Buffer.from([255, 216, 255, i]))));
  const evidenceSha256 = sha(encoded({ html: b.sha256, probe: probe.sha256, shots: shots.map(shot => shot.sha256) }));
  const catalog = await input('private-catalog.txt', 'PRIVATE_REFERENCE_ANSWER');
  await importRecord(registry, 'review-input', {
    manifestSha256, caseId, htmlSha256: b.sha256, probe, shots, evidenceSha256, blindSafe: true, observerId: 'local-catalog',
    observerType: 'independent-agent', independent: true, catalogExhaustive: true, catalogEvidence: [catalog], disputes: [],
    catalog: [{ id: 'private-issue', observation: 'PRIVATE_CATALOG', evidence: [catalog] }],
  });
  const fetch = vi.fn(() => { throw new Error('Review admission cannot use external network'); });
  vi.stubGlobal('fetch', fetch);
  const options = { registry, comparisonIndex, planDirectory: join(parent, 'plan'), scope: 'rehearsal' as const };
  return { options, ruleContent, rules, fetch, evidenceSha256 };
}

it('admits both arms from the same B evidence and frozen rules, with no private catalog or real dispatch', async () => {
  const fixture = await setup(), a = database(), b = database();
  const aArm = await openPausedComparison({ ...fixture.options, DB: a.DB, arm: 'A', adapter: currentComparisonAdmissionAdapter(baseline) });
  const bOptions = { ...fixture.options, DB: b.DB, arm: 'B' as const, adapter: currentComparisonAdmissionAdapter(revision) };
  const bArm = await openPausedComparison(bOptions);
  const [left, right] = await Promise.all([aArm.admitReview(caseId), bArm.admitReview(caseId)]);
  const pack = await buildComparisonEvidencePack(fixture.options.registry, fixture.options.comparisonIndex, caseId);
  expect(left.taskId).not.toBe(right.taskId);
  for (const [entry, receipt] of [[a, left], [b, right]] as const) {
    expect(receipt).toMatchObject({ sourceHash: sha(html), evidenceHash: fixture.evidenceSha256, executionAllowed: false, state: 'paused' });
    const row = entry.sqlite.prepare('SELECT * FROM review_jobs WHERE id=?').get(receipt.taskId) as any;
    expect(row).toMatchObject({ owner_id: 'admin', executor: 'cloud', model_executor: 'platform', review_mode: 'basic',
      input_ready: 1, report_schema_version: 2, status: 'queued', input_hash: sha(html), model_started_at: null });
    expect(JSON.parse(row.rules_snapshot)).toEqual(fixture.rules);
    const state = entry.sqlite.prepare('SELECT identity_json FROM comparison_admissions WHERE task_id=?').get(receipt.taskId) as any;
    expect(state.identity_json).toContain(pack.identity.packSha256);
    expect(state.identity_json).not.toMatch(/PRIVATE_|private-catalog|local-catalog/);
    const input = entry.sqlite.prepare('SELECT data FROM review_inputs WHERE job_id=? ORDER BY part').all(receipt.taskId) as { data: string }[];
    expect(JSON.parse(input.map(chunk => chunk.data).join(''))).toEqual({ html, title: caseId, topic_id: null });
    expect(entry.sqlite.prepare('SELECT count(*) n FROM comparison_schedule_requests').get()).toEqual({ n: 1 });
    expect(entry.sqlite.prepare('SELECT count(*) n FROM harness_runs').get()).toEqual({ n: 0 });
  }
  expect((a.sqlite.prepare('SELECT harness_policy FROM review_jobs').get() as any).harness_policy).toBeNull();
  expect(JSON.parse((b.sqlite.prepare('SELECT harness_policy FROM review_jobs').get() as any).harness_policy)).toMatchObject({ purpose: 'review' });
  const restarted = await openPausedComparison(bOptions);
  expect(await restarted.admitReview(caseId)).toEqual(right);
  expect(b.sqlite.prepare('SELECT count(*) n FROM review_jobs').get()).toEqual({ n: 1 });
  expect(b.sqlite.prepare('SELECT count(*) n FROM comparison_schedule_requests').get()).toEqual({ n: 1 });
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it('recovers a same-ID partial input write without scheduling twice or changing the locked artifact', async () => {
  const fixture = await setup(), { DB, sqlite, fail } = database();
  const options = { ...fixture.options, DB, arm: 'B' as const, adapter: currentComparisonAdmissionAdapter(revision) };
  const first = await openPausedComparison(options);
  fail('INSERT INTO review_inputs', 'DELETE FROM review_jobs');
  await expect(first.admitReview(caseId)).rejects.toThrow('Synthetic interrupted review input write');
  const partial = sqlite.prepare('SELECT id,input_ready FROM review_jobs').get() as { id: string; input_ready: number };
  expect(partial.input_ready).toBe(0);
  expect(sqlite.prepare('SELECT count(*) n FROM comparison_schedule_requests').get()).toEqual({ n: 0 });
  const restarted = await openPausedComparison(options);
  expect(await restarted.admitReview(caseId)).toMatchObject({ taskId: partial.id, sourceHash: sha(html), state: 'paused' });
  expect(sqlite.prepare('SELECT id,input_ready FROM review_jobs').get()).toEqual({ id: partial.id, input_ready: 1 });
  expect(sqlite.prepare('SELECT count(*) n FROM comparison_schedule_requests').get()).toEqual({ n: 1 });
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it('refuses modified source shards, a crossed review owner, and changed frozen rules', async () => {
  const fixture = await setup(), { DB, sqlite } = database();
  const open = await openPausedComparison({ ...fixture.options, DB, arm: 'B', adapter: currentComparisonAdmissionAdapter(revision) });
  const admission = await open.admitReview(caseId);
  sqlite.prepare('UPDATE review_inputs SET data=? WHERE job_id=?').run(JSON.stringify({ html: '<title>Substituted</title>', title: caseId, topic_id: null }), admission.taskId);
  await expect(open.admitReview(caseId)).rejects.toThrow(/input|shard/i);
  sqlite.prepare('UPDATE review_inputs SET data=? WHERE job_id=?').run(JSON.stringify({ html, title: caseId, topic_id: null }), admission.taskId);
  sqlite.prepare("UPDATE review_jobs SET owner_id='another-owner' WHERE id=?").run(admission.taskId);
  await expect(open.admitReview(caseId)).rejects.toThrow(/identity|owner|previously paused task/i);
  expect((sqlite.prepare('SELECT owner_id FROM review_jobs WHERE id=?').get(admission.taskId) as any).owner_id).toBe('another-owner');
  sqlite.prepare("UPDATE review_jobs SET owner_id='admin' WHERE id=?").run(admission.taskId);
  const changed = { ...fixture.ruleContent, rawDirection: 'Changed rule' };
  sqlite.prepare('INSERT INTO review_rule_versions(id,content_hash,snapshot,created_at,published_at) VALUES(?,?,?,?,?)')
    .run('changed-rules', sha(canonicalHarness(changed)), JSON.stringify(changed), fixture.rules.publishedAt, fixture.rules.publishedAt);
  sqlite.prepare("UPDATE review_rule_head SET version_id='changed-rules' WHERE id=1").run();
  await expect(open.admitReview(caseId)).rejects.toThrow(/rules/i);
  sqlite.prepare("UPDATE review_rule_head SET version_id='synthetic-rules' WHERE id=1").run();
  sqlite.prepare('DELETE FROM review_jobs WHERE id=?').run(admission.taskId);
  await expect(open.admitReview(caseId)).rejects.toThrow(/previously paused task/i);
  expect(sqlite.prepare('SELECT count(*) n FROM review_jobs').get()).toEqual({ n: 0 });
  expect(sqlite.prepare('SELECT count(*) n FROM comparison_schedule_requests').get()).toEqual({ n: 1 });
  expect(fixture.fetch).not.toHaveBeenCalled();
});
