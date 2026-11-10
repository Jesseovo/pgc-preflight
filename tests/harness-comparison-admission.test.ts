import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepare } from '../scripts/harness-evaluation';
import { currentComparisonAdmissionAdapter, openPausedComparison } from '../scripts/harness-comparison-admission';
import { canonicalHarness } from '../server/harness-policy';

const commit = '630303565f44c061c7ed8ad7b992dcc4e9db8929';
const image = 'registry.cloudflare.com/071443b43c7562efec975a5e964d5a9c/pgc-ccb-research@sha256:0e95a0406e8dc94b0a4eea1f2cb62ff2a31ff48261d8fca87923d99ebfcec957';
const dirs: string[] = [], databases: DatabaseSync[] = [];
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
afterEach(async () => { vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup(createOverrides: Record<string, unknown> = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pgc-paused-comparison-'))); dirs.push(parent);
  const registry = join(parent, 'registry'); await mkdir(registry, { mode: 0o700 }); await mkdir(join(registry, 'inputs'), { mode: 0o700 });
  async function input(name: string, data: unknown) {
    const path = `inputs/${name}.json`, bytes = encoded(data); await writeFile(join(registry, path), bytes);
    return { path, sha256: sha(bytes) };
  }
  const create = await input('create', { model: 'claude-opus-5-5', baseUrl: 'https://riffle-api.pages.dev', protocol: 'anthropic', effort: 'high',
    maxOutputTokens: 0, vision: true, enabled: true, updatedAt: 'synthetic', ...createOverrides });
  const review = await input('review', { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', protocol: 'openai', effort: 'low',
    maxOutputTokens: 0, vision: true, enabled: true, updatedAt: 'synthetic' });
  const content = { sourceUrl: 'https://creator-hub-7mi.pages.dev/#/', capturedAt: '2026-11-05T00:00:00.000Z', rawDirection: 'Synthetic rule',
    rawScoring: 'Synthetic scoring', scoreMin: 0, scoreMax: 3, passScore: 7, notes: '', calibrationCases: [] };
  const rules = await input('rules', { schemaVersion: 2, id: 'synthetic-rules', contentHash: sha(canonicalHarness(content)),
    publishedAt: '2026-11-05T00:00:00.000Z', ...content });
  const calibration = await input('calibration', []);
  const settings = await input('settings', { creationModel: { name: 'claude-opus-5-5', config: create }, reviewModel: { name: 'deepseek-flash', config: review },
    rulesVersion: 'synthetic-rules', rules, calibration, harnessCommit: commit, harnessImage: image });
  const checklists = await readFile('fixtures/harness-evaluation/checklists.json');
  const cases = await Promise.all(JSON.parse(checklists.toString()).map(async ({ id }: { id: string }) => ({ id,
    materials: await Promise.all(['brief.md','sample.svg','assets.html'].map(async name => ({ path: `archive/${id}/${name}`,
      sha256: sha(await readFile(`fixtures/harness-evaluation/${id}/${name}`)) }))),
  })));
  const comparisonIndex = join(parent, 'index.json'); await writeFile(comparisonIndex, encoded({ schemaVersion: 1, checklistSha256: sha(checklists), cases }));
  await prepare(registry, join(registry, settings.path), comparisonIndex);
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`migrations/${name}`, 'utf8'));
  let fail = '';
  const DB = {
    prepare(sql: string) {
      let values: any[] = [];
      const statement = { bind(...args: any[]) { values = args; return statement; },
        first: async () => sqlite.prepare(sql).get(...values) ?? null, all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
        run: async () => statement.execute(), execute() {
          if (fail && sql.includes(fail)) { fail = ''; throw new Error('Synthetic paused write failure'); }
          return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } };
        } };
      return statement;
    },
    batch: async (statements: any[]) => {
      sqlite.exec('BEGIN'); try { const results = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const options = { DB, arm: 'B' as const, registry, comparisonIndex, planDirectory: join(parent, 'plan'), scope: 'rehearsal' as const,
    adapter: currentComparisonAdmissionAdapter(commit) };
  const fetch = vi.fn(() => { throw new Error('No external network in admission'); }); vi.stubGlobal('fetch', fetch);
  return { options, sqlite, fetch, failOnce: (snippet: string) => { fail = snippet; } };
}

it('queues the real v2 creation API with complete locked materials and a paused research policy', async () => {
  const s = await setup(), paused = await openPausedComparison(s.options);
  const receipt = await paused.admitCreation('tap-rhythm');
  expect(receipt).toMatchObject({ arm: 'B', state: 'paused', executionAllowed: false, providerCalls: 0, liveDispatches: 0 });
  const row = s.sqlite.prepare('SELECT * FROM forge_tasks WHERE id=?').get(receipt.taskId) as any;
  expect(row).toMatchObject({ owner_id: paused.ownerId, status: 'queued', executor: 'platform', creative_version: 2, model_started_at: null });
  const input = JSON.parse(row.input_snapshot), policy = JSON.parse(row.harness_policy);
  expect(input.topic.brief_md).toBe(await readFile('fixtures/harness-evaluation/tap-rhythm/brief.md', 'utf8'));
  expect(input.topic.preview_svg).toBe(await readFile('fixtures/harness-evaluation/tap-rhythm/sample.svg', 'utf8'));
  expect(input.topic.assets_html).toBe(await readFile('fixtures/harness-evaluation/tap-rhythm/assets.html', 'utf8'));
  expect(Object.keys(input.heads).sort()).toEqual(['assets','brief','preview']);
  expect(policy).toMatchObject({ engine: 'ccb', purpose: 'game', releaseHash: paused.planSha256, limits: { maxOutputTokens: 64_000, maxTotalOutputTokens: 256_000 } });
  expect(s.sqlite.prepare('SELECT count(*) n FROM comparison_schedule_requests').get()).toEqual({ n: 1 });
  expect(s.sqlite.prepare('SELECT count(*) n FROM harness_runs').get()).toEqual({ n: 0 });
  expect(s.fetch).not.toHaveBeenCalled();
  await expect(paused.admitReview('tap-rhythm')).rejects.toThrow();
  expect(s.sqlite.prepare('SELECT count(*) n FROM review_jobs').get()).toEqual({ n: 0 });
});

it('concurrent and restarted duplicate admission retains one task, three versions and one schedule', async () => {
  const s = await setup(), paused = await openPausedComparison(s.options);
  const [a, b] = await Promise.all([paused.admitCreation('tap-rhythm'), paused.admitCreation('tap-rhythm')]);
  expect(a).toEqual(b);
  const resumed = await openPausedComparison(s.options);
  expect(await resumed.admitCreation('tap-rhythm')).toEqual(a);
  expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toEqual({ n: 1 });
  expect(s.sqlite.prepare('SELECT count(*) n FROM artifact_versions').get()).toEqual({ n: 3 });
  expect(s.sqlite.prepare('SELECT count(*) n FROM comparison_schedule_requests').get()).toEqual({ n: 1 });
  expect(s.fetch).not.toHaveBeenCalled();
});

it('recovers the same queued task after interruption before policy persistence without any dispatch', async () => {
  const s = await setup(), paused = await openPausedComparison(s.options);
  s.failOnce('SET harness_policy=');
  await expect(paused.admitCreation('continuous-drag')).rejects.toThrow('Synthetic paused write failure');
  const original = s.sqlite.prepare('SELECT id,harness_policy,status FROM forge_tasks').get() as any;
  expect(original).toMatchObject({ harness_policy: null, status: 'queued' });
  const resumed = await openPausedComparison(s.options);
  expect(await resumed.admitCreation('continuous-drag')).toMatchObject({ taskId: original.id, state: 'paused' });
  expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toEqual({ n: 1 });
  expect(s.sqlite.prepare('SELECT count(*) n FROM comparison_schedule_requests').get()).toEqual({ n: 1 });
  expect(s.fetch).not.toHaveBeenCalled();
});

it('refuses revoked Star, modified materials, conflicting live scope and crossed database bindings', async () => {
  const s = await setup(), paused = await openPausedComparison(s.options);
  s.sqlite.prepare('UPDATE members SET star=0 WHERE id=?').run(paused.ownerId);
  await expect(paused.admitCreation('tap-rhythm')).rejects.toThrow('no longer Star');
  s.sqlite.prepare('UPDATE members SET star=1 WHERE id=?').run(paused.ownerId);
  const receipt = await paused.admitCreation('tap-rhythm');
  s.sqlite.prepare("UPDATE topics SET brief_md='changed' WHERE id=1").run();
  await expect(paused.admitCreation('tap-rhythm')).rejects.toThrow('Current input heads differ');
  const source = JSON.parse((s.sqlite.prepare('SELECT input_snapshot FROM forge_tasks WHERE id=?').get(receipt.taskId) as any).input_snapshot);
  s.sqlite.prepare('UPDATE topics SET brief_md=? WHERE id=1').run(source.topic.brief_md);
  s.sqlite.prepare('UPDATE forge_tasks SET id=? WHERE id=?').run(crypto.randomUUID(), receipt.taskId);
  await expect(paused.admitCreation('tap-rhythm')).rejects.toThrow('Previously paused task is missing');
  s.sqlite.prepare("INSERT INTO forge_tasks(id,kind,scope,payload,owner_id,created_at,updated_at) VALUES(?,'game',?,'{}',?,'now','now')")
    .run(crypto.randomUUID(), `${paused.ownerId}:game:2`, paused.ownerId);
  await expect(paused.admitCreation('continuous-drag')).rejects.toThrow('Another active task');
  await expect(openPausedComparison({ ...s.options, arm: 'A', adapter: currentComparisonAdmissionAdapter('8afbf81c85c785f5d2d071dda9ecedba510b42ab') }))
    .rejects.toThrow('another plan or arm');
  expect(s.fetch).not.toHaveBeenCalled();
});

it('refuses a populated application database before adding research tables', async () => {
  const s = await setup();
  s.sqlite.exec("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at) VALUES('existing','existing','existing','x','x','now','now')");
  await expect(openPausedComparison(s.options)).rejects.toThrow('new isolated database');
  expect(s.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='comparison_arm'").get()).toBeUndefined();
  expect(s.fetch).not.toHaveBeenCalled();
});

it('recovers a swallowed schedule write failure without losing or recreating the queued task', async () => {
  const s = await setup(), paused = await openPausedComparison(s.options);
  s.failOnce('INSERT OR IGNORE INTO comparison_schedule_requests');
  const receipt = await paused.admitCreation('tap-rhythm');
  expect(s.sqlite.prepare('SELECT count(*) n FROM comparison_schedule_requests').get()).toEqual({ n: 1 });
  expect(await (await openPausedComparison(s.options)).admitCreation('tap-rhythm')).toEqual(receipt);
  expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toEqual({ n: 1 });
  expect(s.fetch).not.toHaveBeenCalled();
});

it('rejects prior-case context before creating a task and never certifies a previously started task as paused', async () => {
  const s = await setup(), paused = await openPausedComparison(s.options);
  const first = await paused.admitCreation('tap-rhythm');
  s.sqlite.prepare("UPDATE topics SET status='made', product_html='<html>Prior output</html>' WHERE id=1").run();
  await expect(paused.admitCreation('continuous-drag')).rejects.toThrow('Pre-admit all creation cases');
  expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toEqual({ n: 1 });
  s.sqlite.prepare("UPDATE topics SET status='draft', product_html='' WHERE id=1").run();
  s.sqlite.prepare("UPDATE forge_tasks SET model_started_at='2026-11-06T00:00:00Z' WHERE id=?").run(first.taskId);
  await expect(paused.admitCreation('tap-rhythm')).rejects.toThrow('paused state changed');
  expect(s.fetch).not.toHaveBeenCalled();
});

it('rejects a creation profile that changes the frozen visual or 64k contract before database admission', async () => {
  for (const override of [{ vision: false }, { maxOutputTokens: 32000 }]) {
    const s = await setup(override);
    await expect(openPausedComparison(s.options)).rejects.toThrow('visual high');
    expect(s.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='comparison_arm'").get()).toBeUndefined();
    expect(s.fetch).not.toHaveBeenCalled();
  }
});
