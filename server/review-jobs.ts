// Background transport only. Scoring and calibration stay in the Forge review.
import { activeModelProfile } from './settings';
import { reviewDay, reviewUsage } from './review-usage';
import { recoverDeviceReviews, failDeviceReview } from './review-device-state';
import {digest} from './review-device-state';
import {withHumanReviews} from './human-review';

type ReviewJob = { type: 'review'; id: string };
export interface ReviewJobEnv {
  DB: any;
  REVIEW_QUEUE?: { send(message: ReviewJob): Promise<void> };
  modelStore: { get(): Promise<any> };
  captureReview?: (html:string, onWait?:(message:string)=>Promise<void>) => Promise<any>;
  reviewExecutor?: 'device';
  modelExecutor?: 'agent' | 'platform';
}
const stamp = () => new Date().toISOString();
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const publicJob = ({ id, title, filename, stage, status, error, result_id, created_at, updated_at, quota_charged, model_executor, local_model, input_hash, human_review=null }: any) => ({ id, title, filename, stage, status, error, result_id, created_at, updated_at, quota_charged, model_executor, model: local_model,input_hash,human_review,human_status:human_review?.status??null,human_score:human_review?.score??null });

export async function enqueueReview(env: ReviewJobEnv, payload: any, ownerId: string) {
  const local = env.modelExecutor !== 'platform';
  if (!local && !env.REVIEW_QUEUE && env.reviewExecutor!=='device') throw fail('后台审核服务尚未就绪，请稍后重试。', 503);
  if (typeof payload?.html !== 'string' || !payload.html.trim()) throw fail('缺少游戏源码。');
  if (new TextEncoder().encode(payload.html).length > 8 * 1024 * 1024) throw fail('单个 HTML 不能超过 8 MB。', 413);
  if (!local && !env.captureReview && env.reviewExecutor!=='device') throw fail('后台画面采集服务尚未就绪。', 503);
  if (!local) {
    const config = await env.modelStore.get();
    for (const purpose of ['review', 'review_verify'] as const) {
      const model = activeModelProfile(config, purpose);
      if (!model?.profile.enabled || !model.profile.encryptedKey) throw fail(`管理员尚未配置并启用${purpose === 'review' ? '审核初评' : '评分复核'}模型。`, 503);
    }
  }
  const id = payload.request_id;
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw fail('审核请求标识无效，请重新提交。');
  const existing = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ? AND owner_id = ?').bind(id, ownerId).first();
  if (existing) return publicJob((await withHumanReviews(env.DB,[existing],true))[0]);
  if(payload.topic_id!==undefined&&payload.topic_id!==null){
    if(!Number.isInteger(payload.topic_id)||payload.topic_id<1)throw fail('选题编号无效。');
    const topic=await env.DB.prepare('SELECT owner_id FROM topics WHERE id=?').bind(payload.topic_id).first();
    if(!topic||(ownerId!=='admin'&&topic.owner_id!==ownerId))throw fail('选题不存在。',404);
  }
  const title = String(payload.title || '未命名').slice(0, 120);
  const filename = String(payload.filename || '').slice(0, 200);
  const inputHash=await digest(payload.html);
  const now = stamp();
  // One serialized SQLite statement reserves quota even when several uploads
  // arrive together. The same request ID can never charge twice.
  const day = reviewDay();
  const inserted = local ? await env.DB.prepare(`INSERT OR IGNORE INTO review_jobs (id,owner_id,title,filename,stage,usage_day,created_at,updated_at,executor,input_ready,model_executor,quota_charged,input_hash)
    SELECT ?,?,?,?,'capture',?,?,?,'device',0,'agent',0,? WHERE
    (?='admin' OR EXISTS(SELECT 1 FROM members WHERE id=? AND enabled=1 AND can_review=1))`)
    .bind(id,ownerId,title,filename,day,now,now,inputHash,ownerId,ownerId).run()
    : await env.DB.prepare(`INSERT OR IGNORE INTO review_jobs (id, owner_id, title, filename, stage, usage_day, created_at, updated_at,executor,input_ready,model_executor,input_hash)
    SELECT ?, ?, ?, ?, 'capture', ?, ?, ?, ?, 0, 'platform',? WHERE
    (SELECT COUNT(*) FROM review_jobs WHERE owner_id = ? AND status IN ('queued', 'running')) < 50
    AND (? = 'admin' OR EXISTS (SELECT 1 FROM members WHERE id = ? AND enabled = 1 AND can_review = 1 AND
      daily_review_limit > (SELECT COUNT(*) FROM review_jobs WHERE owner_id = ? AND usage_day = ? AND quota_charged = 1)))`)
    .bind(id, ownerId, title, filename, day, now, now,env.reviewExecutor||'cloud',inputHash, ownerId, ownerId, ownerId, ownerId, day).run();
  if (!inserted.meta.changes) {
    const duplicate = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ? AND owner_id = ?').bind(id, ownerId).first();
    if (duplicate) return publicJob((await withHumanReviews(env.DB,[duplicate],true))[0]);
    if(ownerId !== 'admin'){
      const member=await env.DB.prepare('SELECT enabled,can_review FROM members WHERE id=?').bind(ownerId).first();
      if(!member?.enabled||!member.can_review)throw fail('当前账号已停用或审核权限已撤销。',403);
      if(local)throw fail('审核请求标识已被使用，请生成新的请求编号。',409);
      const usage=await reviewUsage(env.DB,ownerId);
      if(!usage.remaining)throw fail(`今日审核次数已用完（${usage.used}/${usage.limit}）。北京时间零点重置，可联系管理员调整。`,429);
    }
    throw fail('最多同时排队 50 个审核任务，请等待当前任务完成。', 429);
  }
  try {
    const text = JSON.stringify({ html: payload.html, title, topic_id: payload.topic_id || null });
    const chunks = [];
    for (let i = 0; i < text.length;) {
      let end = Math.min(i + 120000, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(env.DB.prepare('INSERT INTO review_inputs (job_id, part, data, created_at) VALUES (?, ?, ?, ?)').bind(id, chunks.length, text.slice(i, end), now));
      i = end;
    }
    await env.DB.batch(chunks);
    await env.DB.prepare('UPDATE review_jobs SET input_ready=1 WHERE id=?').bind(id).run();
    if(!local&&env.reviewExecutor!=='device')await env.REVIEW_QUEUE!.send({ type: 'review', id });
  } catch {
    await env.DB.prepare('DELETE FROM review_jobs WHERE id = ? AND status = ?').bind(id, 'queued').run();
    await deleteInput(env, id).catch(() => {});
    throw fail('审核任务提交失败，请重试。', 503);
  }
  return { id, title, filename, stage:'capture', status: 'queued', error: '', result_id: null, created_at: now, updated_at: now, quota_charged:local?0:1, model_executor:local?'agent':'platform' };
}

export async function listReviewJobs(env: ReviewJobEnv, ownerId: string) {
  await recoverInterruptedReviews(env, ownerId);
  const { results } = await env.DB.prepare("SELECT * FROM review_jobs WHERE owner_id = ? AND owner_hidden = 0 AND (created_at > ? OR (model_executor='agent' AND status IN ('queued','running'))) ORDER BY created_at DESC LIMIT 100")
    .bind(ownerId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).all();
  return (await withHumanReviews(env.DB,results||[],true)).map(publicJob);
}

export async function recoverInterruptedReviews(env: {DB:any}, ownerId?: string) {
  await recoverDeviceReviews(env.DB,ownerId);
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const stale=await env.DB.prepare(`SELECT id,updated_at FROM review_jobs WHERE model_executor='platform' AND executor!='device' AND status='running' AND updated_at<?${ownerId?' AND owner_id=?':''}`)
    .bind(cutoff,...(ownerId?[ownerId]:[])).all();
  for(const row of stale.results)await failDeviceReview(env.DB,row.id,'后台审核已中断，未发布评分，请重新上传或重试。',row.updated_at);
}

export async function getReviewJob(env: ReviewJobEnv, id: string, ownerId: string) {
  let row = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ? AND owner_id = ? AND owner_hidden=0').bind(id, ownerId).first();
  if (!row) throw fail('审核任务不存在。', 404);
  if(['queued','running'].includes(row.status)&&row.executor==='device'&&Date.now()-Date.parse(row.updated_at)>(row.model_executor==='agent'?86400000:180000)){
    await recoverDeviceReviews(env.DB,ownerId,id);
    row=await env.DB.prepare('SELECT * FROM review_jobs WHERE id=? AND owner_id=?').bind(id,ownerId).first();
  }
  const stale = row.model_executor!=='agent' && (row.status === 'running' && Date.now() - Date.parse(row.updated_at) > 15 * 60 * 1000
    || row.status === 'queued' && Date.now() - Date.parse(row.created_at) > (row.executor==='device'?24:3) * 60 * 60 * 1000);
  if (stale) {
    await env.DB.prepare("UPDATE review_jobs SET status = 'error', quota_charged = CASE WHEN model_started_at IS NULL THEN 0 ELSE quota_charged END, error = '后台任务已中断，请重试。', updated_at = ? WHERE id = ? AND updated_at = ?")
      .bind(stamp(), id, row.updated_at).run();
    row = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ? AND owner_id = ?').bind(id, ownerId).first();
    if (row.status === 'error') await deleteInput(env, id);
  }
  return publicJob((await withHumanReviews(env.DB,[row],true))[0]);
}

// Model activity updates the member-visible stage and also renews the job
// heartbeat. A live stream that spends a long time thinking must not be
// mistaken for an abandoned queue consumer by the 15-minute stale check.
export async function updateReviewProgress(env: ReviewJobEnv, id: string, message: string) {
  await env.DB.prepare("UPDATE review_jobs SET error = ?, stage = CASE WHEN ? LIKE '%复核%' THEN 'verify' ELSE stage END, updated_at = ? WHERE id = ? AND status = 'running'")
    .bind(message, message, stamp(), id).run();
}

const deleteInput = (env: ReviewJobEnv, id: string) => env.DB.prepare('DELETE FROM review_inputs WHERE job_id = ?').bind(id).run();

export async function purgeReviewInputs(env: { DB: any }) {
  await recoverInterruptedReviews(env);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    ...['review_inputs','review_evidence','review_material'].map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE created_at < ? AND NOT EXISTS(SELECT 1 FROM review_jobs WHERE review_jobs.id=${table}.job_id AND model_executor='agent' AND status IN ('queued','running') AND updated_at>=?)`).bind(cutoff,cutoff)),
    env.DB.prepare("UPDATE review_jobs SET status = 'error', quota_charged = CASE WHEN model_started_at IS NULL THEN 0 ELSE quota_charged END, error = '任务已过期，请重新上传。', updated_at = ? WHERE model_executor='platform' AND created_at < ? AND status IN ('queued', 'running')").bind(stamp(), cutoff),
  ]);
}

export async function processReviewJob(env: ReviewJobEnv, id: string, evaluate: (payload: any, ownerId: string, jobId: string) => Promise<any>) {
  const row = await env.DB.prepare('SELECT * FROM review_jobs WHERE id = ?').bind(id).first();
  if (!row) return;
  if (row.executor==='device'||row.model_executor==='agent') return;
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
  const deadline=Date.now()+14*60*1000; // Leave a minute before the Queue's hard wall-clock limit.
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
    let result=persisted;
    if(!result){
      const payload=JSON.parse(chunks.map((chunk: any) => chunk.data).join(''));
      payload.deadline=deadline;
      if(row.stage==='capture'){
        if(!env.captureReview)throw fail('后台画面采集服务尚未就绪。',503);
        await updateReviewProgress(env,id,'正在采集三种手机比例的真实游戏画面…');
        const evidence=await env.captureReview(payload.html,message=>updateReviewProgress(env,id,message));
        Object.assign(payload,evidence);
      }
      await env.DB.prepare("UPDATE review_jobs SET stage='review' WHERE id=? AND lease=? AND status='running'").bind(id,lease).run();
      result=await evaluate(payload,row.owner_id,id);
    }
    await env.DB.prepare("UPDATE review_jobs SET status = 'done', stage = 'done', result_id = ?, error = '', updated_at = ? WHERE id = ? AND lease = ? AND status = 'running'")
      .bind(result.id, stamp(), id, lease).run();
  } catch (error) {
    await env.DB.prepare("UPDATE review_jobs SET status = 'error', quota_charged = CASE WHEN model_started_at IS NULL THEN 0 ELSE quota_charged END, error = ?, updated_at = ? WHERE id = ? AND lease = ? AND status = 'running'")
      .bind(String(error instanceof Error ? error.message : '审核未完成，请重试。').slice(0, 500), stamp(), id, lease).run();
  } finally {
    clearInterval(heartbeat);
  }
  // Source and screenshots are temporary inputs, never permanent game storage.
  await deleteInput(env, id);
}
