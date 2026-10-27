// Background transport only. Scoring and calibration stay in the Forge review.
import { activeModelProfile } from './settings';

type ReviewJob = { type: 'review'; id: string };
export interface ReviewJobEnv {
  DB: any;
  REVIEW_QUEUE?: { send(message: ReviewJob): Promise<void> };
  modelStore: { get(): Promise<any> };
}
const stamp = () => new Date().toISOString();
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const publicJob = ({ id, title, status, error, result_id, created_at, updated_at }: any) => ({ id, title, status, error, result_id, created_at, updated_at });

export async function enqueueReview(env: ReviewJobEnv, payload: any, ownerId: string) {
  if (!env.REVIEW_QUEUE) throw fail('后台审核服务尚未就绪，请稍后重试。', 503);
  if (typeof payload?.html !== 'string' || !payload.html.trim()) throw fail('缺少游戏源码。');
  if (new TextEncoder().encode(payload.html).length > 8 * 1024 * 1024) throw fail('单个 HTML 不能超过 8 MB。', 413);
  const shots = (Array.isArray(payload.shots) ? payload.shots : []).filter((shot: any) =>
    typeof shot?.data === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(shot.data)).slice(0, 6);
  if (shots.reduce((size: number, shot: any) => size + shot.data.length, 0) > 1500000) throw fail('截图总大小过大，请重新采集。', 413);
  if (JSON.stringify(payload.probe || {}).length > 150000) throw fail('运行记录过大，请精简游戏日志。', 413);
  const config = await env.modelStore.get();
  for (const purpose of ['review', 'review_verify'] as const) {
    const model = activeModelProfile(config, purpose);
    if (!model?.profile.enabled || !model.profile.encryptedKey) throw fail(`管理员尚未配置并启用${purpose === 'review' ? '审核初评' : '评分复核'}模型。`, 503);
  }
  const id = payload.request_id;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw fail('审核请求标识无效，请重新提交。');
  const existing = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ? AND owner_id = ?').bind(id, ownerId).first();
  if (existing) return publicJob(existing);
  const title = String(payload.title || '未命名').slice(0, 120);
  const now = stamp();
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO review_jobs (id, owner_id, title, created_at, updated_at)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM review_jobs WHERE owner_id = ? AND status IN ('queued', 'running')) < 20`)
    .bind(id, ownerId, title, now, now, ownerId).run();
  if (!inserted.meta.changes) {
    const duplicate = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ? AND owner_id = ?').bind(id, ownerId).first();
    if (duplicate) return publicJob(duplicate);
    throw fail('最多同时提交 20 个审核任务，请等待当前任务完成。', 429);
  }
  try {
    const text = JSON.stringify({ html: payload.html, title, shots, topic_id: payload.topic_id || null, probe: payload.probe || {} });
    const chunks = [];
    for (let i = 0; i < text.length;) {
      let end = Math.min(i + 120000, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(env.DB.prepare('INSERT INTO review_inputs (job_id, part, data, created_at) VALUES (?, ?, ?, ?)').bind(id, chunks.length, text.slice(i, end), now));
      i = end;
    }
    await env.DB.batch(chunks);
    await env.REVIEW_QUEUE.send({ type: 'review', id });
  } catch {
    await env.DB.prepare('DELETE FROM review_jobs WHERE id = ? AND status = ?').bind(id, 'queued').run();
    await deleteInput(env, id).catch(() => {});
    throw fail('审核任务提交失败，请重试。', 503);
  }
  return { id, title, status: 'queued', error: '', result_id: null, created_at: now, updated_at: now };
}

export async function listReviewJobs(env: ReviewJobEnv, ownerId: string) {
  await recoverInterruptedReviews(env, ownerId);
  const { results } = await env.DB.prepare('SELECT * FROM review_jobs WHERE owner_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 40')
    .bind(ownerId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).all();
  return (results || []).map(publicJob);
}

export async function recoverInterruptedReviews(env: {DB:any}, ownerId?: string) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await env.DB.prepare(`UPDATE review_jobs SET status = 'error', error = '后台审核已中断，未发布评分，请重新上传或重试。', updated_at = ? WHERE status = 'running' AND updated_at < ?${ownerId ? ' AND owner_id = ?' : ''}`)
    .bind(stamp(),cutoff,...(ownerId ? [ownerId] : [])).run();
  await env.DB.prepare("DELETE FROM review_inputs WHERE job_id IN (SELECT id FROM review_jobs WHERE status = 'error')").bind().run();
}

export async function getReviewJob(env: ReviewJobEnv, id: string, ownerId: string) {
  let row = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ? AND owner_id = ?').bind(id, ownerId).first();
  if (!row) throw fail('审核任务不存在。', 404);
  const stale = row.status === 'running' && Date.now() - Date.parse(row.updated_at) > 15 * 60 * 1000
    || row.status === 'queued' && Date.now() - Date.parse(row.created_at) > 3 * 60 * 60 * 1000;
  if (stale) {
    await env.DB.prepare("UPDATE review_jobs SET status = 'error', error = '后台任务已中断，请重试。', updated_at = ? WHERE id = ? AND updated_at = ?")
      .bind(stamp(), id, row.updated_at).run();
    row = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ? AND owner_id = ?').bind(id, ownerId).first();
    if (row.status === 'error') await deleteInput(env, id);
  }
  return publicJob(row);
}

// Model activity updates the member-visible stage and also renews the job
// heartbeat. A live stream that spends a long time thinking must not be
// mistaken for an abandoned queue consumer by the 15-minute stale check.
export async function updateReviewProgress(env: ReviewJobEnv, id: string, message: string) {
  await env.DB.prepare("UPDATE review_jobs SET error = ?, updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(message, stamp(), id).run();
}

const deleteInput = (env: ReviewJobEnv, id: string) => env.DB.prepare('DELETE FROM review_inputs WHERE job_id = ?').bind(id).run();

export async function purgeReviewInputs(env: { DB: any }) {
  await recoverInterruptedReviews(env);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM review_inputs WHERE created_at < ?').bind(cutoff),
    env.DB.prepare("UPDATE review_jobs SET status = 'error', error = '任务已过期，请重新上传。', updated_at = ? WHERE created_at < ? AND status IN ('queued', 'running')").bind(stamp(), cutoff),
  ]);
}

export async function processReviewJob(env: ReviewJobEnv, id: string, evaluate: (payload: any, ownerId: string, jobId: string) => Promise<any>) {
  const row = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ?').bind(id).first();
  if (!row) return;
  if (row.status === 'done' || row.status === 'error') {
    await deleteInput(env, id);
    return;
  }
  if (row.status === 'running' && Date.now() - Date.parse(row.updated_at) > 15 * 60 * 1000) {
    await recoverInterruptedReviews(env);
    return; // Unknown upstream state: never silently replay a paid request.
  }
  const lease = crypto.randomUUID();
  const claim = await env.DB.prepare(`UPDATE review_jobs SET status = 'running', lease = ?, updated_at = ?
    WHERE id = ? AND status = 'queued'`)
    .bind(lease, stamp(), id).run();
  if (!claim.meta.changes) throw fail('任务正在处理。', 409);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    heartbeat = setInterval(() => {
      void env.DB.prepare("UPDATE review_jobs SET updated_at = ? WHERE id = ? AND lease = ? AND status = 'running'")
        .bind(stamp(), id, lease).run().catch(() => {});
    }, 45000);
    if (row.owner_id !== 'admin') {
      const member = await env.DB.prepare('SELECT enabled, can_review FROM members WHERE id = ?').bind(row.owner_id).first();
      if (!member?.enabled || !member.can_review) throw fail('当前账号已停用或审核权限已撤销。', 403);
    }
    const { results: chunks } = await env.DB.prepare('SELECT data FROM review_inputs WHERE job_id = ? ORDER BY part').bind(id).all();
    // An acknowledged result may survive a consumer restart before job status
    // was saved. Reuse it instead of calling the model and inserting twice.
    const persisted = await env.DB.prepare('SELECT id FROM reviews WHERE job_id = ?').bind(id).first();
    if (!persisted && !chunks?.length) throw fail('临时审核文件已过期，请重新上传。');
    const result = persisted || await evaluate(JSON.parse(chunks.map((chunk: any) => chunk.data).join('')), row.owner_id, id);
    await env.DB.prepare("UPDATE review_jobs SET status = 'done', result_id = ?, error = '', updated_at = ? WHERE id = ? AND lease = ?")
      .bind(result.id, stamp(), id, lease).run();
  } catch (error) {
    await env.DB.prepare("UPDATE review_jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND lease = ?")
      .bind(String(error instanceof Error ? error.message : '审核未完成，请重试。').slice(0, 500), stamp(), id, lease).run();
  } finally {
    clearInterval(heartbeat);
  }
  // Source and screenshots are temporary inputs, never permanent game storage.
  await deleteInput(env, id);
}
