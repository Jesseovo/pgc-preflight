import { activeModelProfile } from './settings';
import { prepareReview, consistentVerdict } from './forge-api';
import { generateReviewStage } from './review-generation';
import { deviceOwnerAllowed, failDeviceReview, readReviewInput, stamp } from './review-device-state';
import { updateReviewProgress } from './review-jobs';
import { captureFor } from './cloud-review-capture';

type Phase = 'prepared' | 'review-started' | 'draft-ready' | 'verify-started' | 'final-ready';
type Checkpoint = { deadline: number; config: any; request: any; images: any[]; probe: any; title: string; topic_id: number | null; draft?: any; result?: any };

// Each KV value stays below DO's 128 KiB bound even for Chinese + emoji.
// Phase, material and the next alarm commit atomically. No source is exposed
// through public state endpoints; all ephemeral keys are deleted on termination.
async function save(storage: any, phase: Phase, data: Checkpoint) {
  const text = JSON.stringify(data);
  await storage.transaction(async (tx: any) => {
    let count = 0;
    for (let i = 0; i < text.length; i += 30000) await tx.put(`cloud:${count++}`, text.slice(i, i + 30000));
    const old = await tx.get('cloudParts') || 0;
    for (let i = count; i < old; i++) await tx.delete(`cloud:${i}`);
    await tx.put('cloudParts', count);
    await tx.put('cloudPhase', phase);
    await tx.setAlarm(Date.now() + 30000);
  });
}
async function load(storage: any): Promise<Checkpoint> {
  const count = await storage.get('cloudParts');
  if (!count) throw new Error('后台审核检查点缺失，未发布评分，请重新上传。');
  const parts = [];
  for (let i = 0; i < count; i++) {
    const value = await storage.get(`cloud:${i}`);
    if (typeof value !== 'string') throw new Error('后台审核检查点不完整，未发布评分。');
    parts.push(value);
  }
  return JSON.parse(parts.join(''));
}
const clear = async (storage: any) => { await storage.deleteAlarm(); await storage.deleteAll(); };

// Only administrator/legacy platform cloud work reaches this runner. Member
// Agent tasks and device captures keep their own protocol and never use a key.
export async function cloudReviewAlarm(state: any, env: any, id: string) {
  // Keep normal stages in one execution: re-entering the alarm scheduler for
  // every completed stage adds avoidable dispatch latency. Checkpoints + the
  // recovery alarm remain durable between stages if this invocation stops.
  try { while(await advanceCloudReview(state,env,id)) { /* continue safely */ } }
  catch {
    // D1/DO persistence can fail even after the model has completed. Keep the
    // exact checkpoint and re-enter it later. Started phases still fail closed
    // on recovery; this is not a new provider request. Bound abandoned storage.
    const since=await state.storage.get('cloudRecoverySince')||Date.now();
    if(Date.now()-since>=86400000){await clear(state.storage);return;}
    await state.storage.put('cloudRecoverySince',since);
    await state.storage.setAlarm(Date.now()+30000);
  }
}
export async function advanceCloudReview(state: any, env: any, id: string) {
  const DB = env.DB, storage = state.storage;
  const row = await DB.prepare('SELECT * FROM review_jobs WHERE id=?').bind(id).first();
  if (!row || row.executor !== 'cloud' || row.model_executor !== 'platform' || !['queued', 'running'].includes(row.status)) { await clear(storage); return; }
  const phase: Phase | undefined = await storage.get('cloudPhase');
  if(!phase){
    const persisted=await DB.prepare('SELECT id FROM reviews WHERE job_id=?').bind(id).first();
    if(persisted){
      await DB.batch([
        DB.prepare("UPDATE review_jobs SET status='done',stage='done',result_id=?,error='',updated_at=? WHERE id=? AND status IN ('queued','running')").bind(persisted.id,stamp(),id),
        ...['review_inputs','review_evidence','review_material'].map(t=>DB.prepare(`DELETE FROM ${t} WHERE job_id=? AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND status='done')`).bind(id,id)),
      ]);
      await clear(storage);return;
    }
  }
  // Once the final model output is durable, database recovery is safe: retry
  // only this idempotent transaction, never either model call.
  if (phase === 'final-ready') {
    const data = await load(storage), result = data.result;
    const score = result.aes + result.ease + result.play;
    result.verdict = consistentVerdict(result.verdict, score);
    await DB.batch([
      DB.prepare(`INSERT OR IGNORE INTO reviews(owner_id,title,topic_id,score,result,probe,shots,created_at,job_id) SELECT owner_id,title,?,?,?,?,?,?,id FROM review_jobs WHERE id=? AND status='running' AND model_executor='platform'`).bind(data.topic_id, score, JSON.stringify(result), JSON.stringify({...data.probe,evidenceOrigin:'admin-upload'}), JSON.stringify(data.images), stamp(), id),
      DB.prepare("UPDATE review_jobs SET status='done',stage='done',result_id=(SELECT id FROM reviews WHERE job_id=?),error='',updated_at=? WHERE id=? AND status='running' AND EXISTS(SELECT 1 FROM reviews WHERE job_id=?)").bind(id, stamp(), id, id),
      ...['review_inputs', 'review_evidence', 'review_material'].map(t => DB.prepare(`DELETE FROM ${t} WHERE job_id=? AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND status='done')`).bind(id,id)),
    ]);
    await clear(storage);
    return;
  }
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    if (phase === 'review-started' || phase === 'verify-started' || !phase && (row.model_execution_started_at || row.model_started_at)) throw new Error('云端执行意外中断，模型请求状态未知；未重复调用或发布评分，请手动重试。');
    await deviceOwnerAllowed(DB, row);
    await storage.setAlarm(Date.now() + 14 * 60000);
    heartbeat = setInterval(() => { void DB.prepare("UPDATE review_jobs SET updated_at=? WHERE id=? AND status='running'").bind(stamp(), id).run().catch(() => {}); }, 30000);
    if (!phase) {
      if (row.status === 'queued') {
        const claimed = await DB.prepare("UPDATE review_jobs SET status='running',stage='capture',updated_at=? WHERE id=? AND status='queued' AND model_executor='platform' AND executor='cloud' AND input_ready=1").bind(stamp(),id).run();
        if (!claimed.meta.changes) throw new Error('审核文件尚未就绪，请重新上传。');
      }
      const deadline = Date.now() + 12 * 60000;
      const input = await readReviewInput(DB, id);
      const selected = activeModelProfile(await env.modelStore.get(), 'review');
      if (!selected?.profile.enabled || !selected.profile.encryptedKey) throw new Error('审核模型尚未配置或已停用。');
      const config = { ...selected.profile, activeProfile:selected.id, profiles:{[selected.id]:selected.profile}, routes:{review:selected.id} };
      const runtime = { ...env, ownerId:row.owner_id, modelStore:{get:async()=>config} };
      const evidence = await (env.captureReview || captureFor(env))(input.html, (message:string)=>updateReviewProgress(env,id,message));
      const {images,...request} = await prepareReview(runtime,{...input,...evidence});
      await updateReviewProgress(env,id,'画面采集已完成，准备模型初评。');
      await save(storage,'prepared',{deadline,config,request,images,probe:evidence.probe,title:input.title,topic_id:input.topic_id||null});
      return true;
    }
    const data = await load(storage);
    if (Date.now() >= data.deadline) throw new Error('审核处理时限已到，未发布评分，请重试。');
    const runtime = { ...env, ownerId:row.owner_id, modelStore:{get:async()=>data.config} };
    const request = { ...data.request, deadline:data.deadline, idempotencyKey:`pgc-review-${id}`,
      onWait:(message:string)=>updateReviewProgress(env,id,message),
      onStart:async()=>{
        await deviceOwnerAllowed(DB,row);
        const updated=await DB.prepare("UPDATE review_jobs SET model_started_at=COALESCE(model_started_at,?),updated_at=? WHERE id=? AND status='running'").bind(stamp(),stamp(),id).run();
        if(!updated.meta.changes)throw new Error('审核任务已停止。');
      },
    };
    if (phase === 'prepared') {
      const claimed = await DB.prepare("UPDATE review_jobs SET model_execution_started_at=?,stage='review',updated_at=? WHERE id=? AND status='running' AND model_execution_started_at IS NULL").bind(stamp(),stamp(),id).run();
      if(!claimed.meta.changes)throw new Error('模型请求状态未知，未重复执行，请手动重试。');
      await storage.put('cloudPhase','review-started');
      data.draft=await generateReviewStage(runtime,{},request,'review');
      await save(storage,'draft-ready',data);
      return true;
    } else if (phase === 'draft-ready') {
      await storage.put('cloudPhase','verify-started');
      data.result=await generateReviewStage(runtime,{},request,'review_verify',data.draft);
      await save(storage,'final-ready',data);
      return true;
    } else throw new Error('审核阶段不正确，未发布评分。');
  } catch (error) {
    await failDeviceReview(DB,id,(error as Error).message||'审核未完成，请重试。');
    await clear(storage);
  } finally { clearInterval(heartbeat); }
}
