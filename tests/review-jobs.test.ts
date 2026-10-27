import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { enqueueReview, getReviewJob, listReviewJobs, processReviewJob, purgeReviewInputs } from '../server/review-jobs';

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
function setup() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  sqlite.exec(readFileSync('migrations/0003_forge.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0006_review_jobs.sql', 'utf8'));
  sqlite.exec('CREATE TABLE members (id TEXT PRIMARY KEY, enabled INTEGER, can_review INTEGER); INSERT INTO members VALUES (\'a\', 1, 1), (\'b\', 1, 1)');
  const DB = {
    prepare(sql: string) {
      return { bind(...params: any[]) {
        const statement = sqlite.prepare(sql);
        return {
          first: async () => statement.get(...params) || null,
          all: async () => ({ results: statement.all(...params) }),
          run: async () => { const result = statement.run(...params); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
          execute: () => statement.run(...params),
        };
      } };
    },
    async batch(statements: any[]) { sqlite.exec('BEGIN'); try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  const send = vi.fn(async (_message: any) => {});
  const env = { DB, REVIEW_QUEUE: { send }, modelStore: { get: async () => ({ baseUrl: 'https://test.example/v1', model: 'fixture', protocol: 'openai', encryptedKey: 'fixture-only', enabled: true, updatedAt: '' }) } };
  const payload = (title = 'Fixture') => ({ title, request_id: crypto.randomUUID(), html: '<html><canvas></canvas></html>', shots: [], probe: {} });
  return { sqlite, env, payload, send };
}

describe('后台并发审核的传输与隔离', () => {
  it('复核模型停用时拒绝入队，不留下任务或临时输入', async () => {
    const { env, payload, sqlite, send } = setup();
    const profile = await env.modelStore.get();
    env.modelStore.get = async () => ({ ...profile, activeProfile: 'initial', profiles: { initial: profile, verify: { ...profile, enabled: false } }, routes: { review: 'initial', review_verify: 'verify' } });
    await expect(enqueueReview(env, payload(), 'a')).rejects.toMatchObject({ status: 503, message: '管理员尚未配置并启用评分复核模型。' });
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM review_jobs').get()).toMatchObject({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM review_inputs').get()).toMatchObject({ n: 0 });
  });
  it('任务重复提交只入队一次，并隔离其他成员的任务', async () => {
    const { env, payload, send } = setup(); const input = payload();
    const job = await enqueueReview(env, input, 'a');
    expect(await enqueueReview(env, input, 'a')).toMatchObject({ id: job.id, status: 'queued' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await listReviewJobs(env, 'b')).toEqual([]);
    await expect(getReviewJob(env, job.id, 'b')).rejects.toMatchObject({ status: 404 });
  });
  it('三次审核可以同时运行，各自落库并删除临时输入，重复消费不重跑模型', async () => {
    const { env, payload, sqlite } = setup();
    const inputs = [payload('A'), payload('B'), payload('C')];
    const tasks = await Promise.all(inputs.map(input => enqueueReview(env, input, 'a')));
    let active = 0, peak = 0;
    const evaluate = vi.fn(async (_input: any, owner: string, job: string) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active--;
      const result = sqlite.prepare("INSERT INTO reviews (owner_id,title,result,probe,created_at,job_id) VALUES (?,?,'{}','{}','now',?)").run(owner, 'Fixture', job);
      return { id: Number(result.lastInsertRowid) };
    });
    await Promise.all(tasks.map(task => processReviewJob(env, task.id, evaluate)));
    expect(peak).toBe(3);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM review_inputs').get()).toMatchObject({ n: 0 });
    for (const task of tasks) expect(await getReviewJob(env, task.id, 'a')).toMatchObject({ status: 'done' });
    await processReviewJob(env, tasks[0].id, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });
  it('输入按小块往返保持中文和 emoji，失败不捏造评分且清理输入', async () => {
    const { env, payload, sqlite } = setup(); const input = payload(); input.html = `<!--${'文'.repeat(119950)}🐈${'字'.repeat(130000)}-->`;
    const task = await enqueueReview(env, input, 'a');
    const evaluate = vi.fn(async (saved: any) => { expect(saved.html).toBe(input.html); throw new Error('fixture-model-timeout'); });
    await processReviewJob(env, task.id, evaluate);
    expect(await getReviewJob(env, task.id, 'a')).toMatchObject({ status: 'error', error: 'fixture-model-timeout', result_id: null });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM review_inputs').get()).toMatchObject({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM reviews').get()).toMatchObject({ n: 0 });
  });
  it('撤销权限后不调用模型，过期输入有清理机制', async () => {
    const { env, payload, sqlite } = setup(); const task = await enqueueReview(env, payload(), 'a');
    sqlite.exec("UPDATE members SET can_review = 0 WHERE id = 'a'");
    const evaluate = vi.fn(); await processReviewJob(env, task.id, evaluate);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await getReviewJob(env, task.id, 'a')).toMatchObject({ status: 'error' });
    const expired = await enqueueReview(env, payload(), 'b');
    sqlite.exec("UPDATE review_inputs SET created_at = '2000-01-01'; UPDATE review_jobs SET created_at = '2000-01-01'");
    await purgeReviewInputs(env);
    expect(await getReviewJob(env, expired.id, 'b')).toMatchObject({ status: 'error' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM review_inputs').get()).toMatchObject({ n: 0 });
  });
  it('后台提交数有上限，入队失败不留下悬空任务', async () => {
    const { env, payload, sqlite, send } = setup();
    send.mockRejectedValueOnce(new Error('fixture-queue-failure'));
    await expect(enqueueReview(env, payload(), 'a')).rejects.toMatchObject({ status: 503 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM review_jobs').get()).toMatchObject({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM review_inputs').get()).toMatchObject({ n: 0 });
    for (let i = 0; i < 20; i++) await enqueueReview(env, payload(), 'a');
    await expect(enqueueReview(env, payload(), 'a')).rejects.toMatchObject({ status: 429 });
  });
});
