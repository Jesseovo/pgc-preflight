import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { reviewDay,reviewUsage,reviewActivity } from '../server/review-usage';
import { enqueueReview, getReviewJob, listReviewJobs, processReviewJob, purgeReviewInputs, updateReviewProgress } from '../server/review-jobs';

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
function setup() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  sqlite.exec(readFileSync('migrations/0003_forge.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0006_review_jobs.sql', 'utf8'));
  sqlite.exec(`CREATE TABLE members (id TEXT PRIMARY KEY, enabled INTEGER, can_review INTEGER,username TEXT,display_name TEXT,created_at TEXT); INSERT INTO members VALUES ('a', 1, 1,'a','甲','now'), ('b', 1, 1,'b','乙','now')`);
  sqlite.exec(readFileSync('migrations/0014_review_capacity.sql','utf8'));
  sqlite.exec(readFileSync('migrations/0015_local_review_worker.sql','utf8'));
  sqlite.exec(readFileSync('migrations/0018_review_material_snapshot.sql','utf8'));
  sqlite.exec("ALTER TABLE review_jobs ADD COLUMN model_executor TEXT NOT NULL DEFAULT 'platform'; ALTER TABLE review_jobs ADD COLUMN local_model TEXT;");
  sqlite.exec(readFileSync('migrations/0019_review_visibility.sql','utf8'));
  sqlite.exec(readFileSync('migrations/0020_human_review.sql','utf8'));
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
  // These fixtures exercise the existing platform transport, not new members'
  // default Agent execution (covered in local-review.test.ts).
  const env = { DB, modelExecutor:'platform' as const, captureReview:vi.fn(async () => ({shots:[],probe:{captureMethod:'browser-viewport-v1'}})), REVIEW_QUEUE: { send }, modelStore: { get: async () => ({ baseUrl: 'https://test.example/v1', model: 'fixture', protocol: 'openai', encryptedKey: 'fixture-only', enabled: true, updatedAt: '' }) } };
  const payload = (title = 'Fixture') => ({ title, request_id: crypto.randomUUID(), html: '<html><canvas></canvas></html>', shots: [], probe: {} });
  return { sqlite, env, payload, send };
}

describe('后台并发审核的传输与隔离', () => {
  it('并行提交原子预扣每日额度；重复 ID 不重复扣，调额立即生效', async()=>{
    const {env,payload,sqlite,send}=setup();
    sqlite.exec("UPDATE members SET daily_review_limit=2 WHERE id='a'");
    const inputs=Array.from({length:5},()=>payload());
    const results=await Promise.allSettled(inputs.map(input=>enqueueReview(env,input,'a')));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await reviewUsage(env.DB,'a')).toMatchObject({limit:2,used:2,remaining:0});
    const accepted=results.findIndex(r=>r.status==='fulfilled');
    await enqueueReview(env,inputs[accepted],'a');
    expect(await reviewUsage(env.DB,'a')).toMatchObject({used:2});
    sqlite.exec("UPDATE members SET daily_review_limit=3 WHERE id='a'");
    await enqueueReview(env,payload(),'a');
    expect(await reviewUsage(env.DB,'a')).toMatchObject({limit:3,used:3,remaining:0});
  });
  it('后台采集失败退次；模型调用后失败仍计一次，初评和复核不重复计次',async()=>{
    const {env,payload,sqlite}=setup();
    const captureFailed=await enqueueReview(env,payload(),'a');
    env.captureReview.mockRejectedValueOnce(new Error('fixture-capture-error'));
    const evaluate=vi.fn();
    await processReviewJob(env,captureFailed.id,evaluate);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await reviewUsage(env.DB,'a')).toMatchObject({used:0,remaining:50});
    const failed=await enqueueReview(env,payload(),'a');
    await processReviewJob(env,failed.id,async()=>{
      sqlite.prepare('UPDATE review_jobs SET model_started_at=? WHERE id=?').run(new Date().toISOString(),failed.id);
      await updateReviewProgress(env,failed.id,'模型正在复核评分依据');
      throw new Error('fixture-model-error');
    });
    expect(await reviewUsage(env.DB,'a')).toMatchObject({used:1,remaining:49});
    expect(await getReviewJob(env,failed.id,'a')).toMatchObject({status:'error',stage:'verify',quota_charged:1});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM review_jobs').get()).toMatchObject({n:2});
  });
  it('北京时间零点重置；管理员不占成员额度；记录包含失败和完成的游戏',async()=>{
    expect(reviewDay(Date.parse('2026-10-27T15:59:59Z'))).toBe('2026-10-27');
    expect(reviewDay(Date.parse('2026-10-27T16:00:00Z'))).toBe('2026-10-28');
    const {env,payload,sqlite}=setup();
    sqlite.exec("UPDATE members SET daily_review_limit=1 WHERE id='a'");
    const yesterday=await enqueueReview(env,payload('yesterday'),'a');
    sqlite.prepare('UPDATE review_jobs SET usage_day=? WHERE id=?').run('2000-01-01',yesterday.id);
    const current=await enqueueReview(env,{...payload('today'),filename:'today.html'},'a');
    await processReviewJob(env,current.id,async()=>{throw new Error('capture completed, fixture error');});
    await enqueueReview(env,payload('admin test'),'admin');
    expect(await reviewUsage(env.DB,'admin')).toMatchObject({limit:null,remaining:null});
    const activity=await reviewActivity(env.DB,new URLSearchParams());
    expect(activity.total).toBe(1);
    expect(activity.records[0]).toMatchObject({title:'today',filename:'today.html',status:'error',quota_charged:0,display_name:'甲'});
  });
  it('审核模型停用时拒绝入队，不留下任务或临时输入', async () => {
    const { env, payload, sqlite, send } = setup();
    const profile = await env.modelStore.get();
    env.modelStore.get = async () => ({ ...profile, activeProfile: 'initial', profiles: { initial: profile, verify: { ...profile, enabled: false } }, routes: { review: 'verify', review_verify: 'initial' } });
    await expect(enqueueReview(env, payload(), 'a')).rejects.toMatchObject({ status: 503, message: '管理员尚未配置并启用审核初评模型。' });
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
  it('活动中的模型进度会刷新任务心跳，避免被 15 分钟中断检测误判', async () => {
    const { env, payload, sqlite } = setup(); const task = await enqueueReview(env, payload(), 'a');
    sqlite.prepare("UPDATE review_jobs SET status = 'running', updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 16 * 60 * 1000).toISOString(), task.id);
    await updateReviewProgress(env, task.id, '模型正在思考，连接正常，尚未输出正文…');
    expect(await getReviewJob(env, task.id, 'a')).toMatchObject({ status: 'running', error: '模型正在思考，连接正常，尚未输出正文…' });
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
    for (let i = 0; i < 50; i++) await enqueueReview(env, payload(), 'a');
    await expect(enqueueReview(env, payload(), 'a')).rejects.toMatchObject({ status: 429 });
  });
});
