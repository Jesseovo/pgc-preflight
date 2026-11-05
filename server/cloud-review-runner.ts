import {parseReviewRulesSnapshot} from './review-rules';
import {reportScore} from './review-report';
import { activeModelProfile } from './settings';
import { prepareReview, consistentVerdict } from './forge-api';
import { generateReviewStage } from './review-generation';
import { deviceOwnerAllowed, failDeviceReview, readReviewInput, stamp } from './review-device-state';
import { updateReviewProgress } from './review-jobs';
import { captureFor } from './cloud-review-capture';
import {recordReviewTiming,markReviewExecution,recordReviewConfiguration,hashReviewConfiguration,type ReviewTimingPhase} from './review-timing';
import {harnessExecutionFor,finishHarnessTask} from './harness-execution';
import {harnessHash,canonicalHarness} from './harness-policy';

type Phase = 'prepared' | 'review-started' | 'draft-ready' | 'verify-started' | 'final-ready';
type Checkpoint = { deadline: number; config: any; request: any; images: any[]; probe: any; title: string; topic_id: number | null; draft?: any; result?: any; materialRef?:string };

// Immutable evidence/configuration is written once. Mutable phase state refers
// to it, and stores only the completed draft or final result. Transactional
// publication prevents a partially written checkpoint becoming recoverable.
async function putParts(tx:any,prefix:string,value:any){
  const text=JSON.stringify(value);let count=0;
  for(let i=0;i<text.length;i+=30000)await tx.put(`${prefix}:${count++}`,text.slice(i,i+30000));
  const old=await tx.get(`${prefix}Parts`)||0;
  for(let i=count;i<old;i++)await tx.delete(`${prefix}:${i}`);
  await tx.put(`${prefix}Parts`,count);
}
async function getParts(storage:any,prefix:string){
  const count=await storage.get(`${prefix}Parts`);
  if(!Number.isSafeInteger(count)||count<1)throw new Error('后台审核检查点缺失，未发布评分，请重新上传。');
  const parts=[];for(let i=0;i<count;i++){const part=await storage.get(`${prefix}:${i}`);if(typeof part!=='string')throw new Error('后台审核检查点不完整，未发布评分。');parts.push(part);}
  return JSON.parse(parts.join(''));
}
async function save(storage:any,phase:Phase,data:Checkpoint){
  const materialRef=data.materialRef||crypto.randomUUID();
  await storage.transaction(async(tx:any)=>{
    if(!data.materialRef){
      const {draft,result,materialRef:ignored,...immutable}=data;
      // request.user and images originally each held the same image bytes.
      // Retain one copy, restoring the exact request parts before inference.
      const request={...immutable.request,user:Array.isArray(immutable.request.user)?immutable.request.user.map((part:any)=>{
        if(part.type!=='image')return part;
        const imageIndex=immutable.images.findIndex((image:any)=>image.data===part.data);
        if(imageIndex<0)throw new Error('审核请求中的原图引用不完整。');
        const {data,...metadata}=part;return {...metadata,imageIndex};
      }):immutable.request.user};
      await putParts(tx,`cloudImmutable:${materialRef}`,{...immutable,request});
    }
    await putParts(tx,'cloudState',{version:2,materialRef,...(phase==='draft-ready'?{draft:data.draft}:{}),...(phase==='final-ready'?{result:data.result}:{})});
    await tx.put('cloudCheckpointVersion',2);
    await tx.put('cloudPhase',phase);
    await tx.setAlarm(Date.now()+30000);
    // Migrate a completed legacy checkpoint only after its replacement commits.
    const old=await tx.get('cloudParts')||0;for(let i=0;i<old;i++)await tx.delete(`cloud:${i}`);if(old)await tx.delete('cloudParts');
  });
  data.materialRef=materialRef;
}
async function load(storage:any):Promise<Checkpoint>{
  if(await storage.get('cloudCheckpointVersion')!==2)return getParts(storage,'cloud');
  const state=await getParts(storage,'cloudState');
  if(state.version!==2||typeof state.materialRef!=='string')throw new Error('后台审核检查点版本不正确。');
  const data=await getParts(storage,`cloudImmutable:${state.materialRef}`);
  const request={...data.request,user:Array.isArray(data.request.user)?data.request.user.map((part:any)=>{
    if(part.type!=='image')return part;
    const {imageIndex,...metadata}=part,image=data.images[imageIndex];
    if(!Number.isSafeInteger(imageIndex)||!image?.data)throw new Error('审核检查点原图缺失。');
    return {...metadata,data:image.data};
  }):data.request.user};
  return {...data,request,materialRef:state.materialRef,...(state.draft?{draft:state.draft}:{}),...(state.result?{result:state.result}:{})};
}
async function timed<T>(DB:any,id:string,phase:ReviewTimingPhase,fn:()=>Promise<T>){
  const started=Date.now(),startedAt=new Date(started).toISOString();let status:'ok'|'error'='error';
  try{const value=await fn();status='ok';return value;}finally{await recordReviewTiming(DB,{jobId:id,eventId:crypto.randomUUID(),phase,origin:'server',startedAt,durationMs:Math.max(0,Date.now()-started),status}).catch(()=>{});}
}
async function recordConfiguration(DB:any,id:string,data:Checkpoint,rulesSnapshot:string|null){
  try{
    const selected=activeModelProfile(data.config,'review');if(!selected)return;
    const profile=selected.profile,effort=profile.effort||'auto';
    const whitelist={model:profile.model,protocol:profile.protocol||'openai',effort,vision:profile.vision!==false,maxOutputTokens:profile.maxOutputTokens??null,profileId:selected.id,updatedAt:profile.updatedAt||null,rulesId:rulesSnapshot?JSON.parse(rulesSnapshot).id??null:null};
    const configHash=await hashReviewConfiguration(whitelist);
    await recordReviewConfiguration(DB,id,{model:profile.model,effort,configHash,origin:'server'});
  }catch{/* Configuration telemetry never replays a completed paid stage. */}
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
      await markReviewExecution(DB,id,'done').catch(()=>{});
      await clear(storage);return;
    }
  }
  // Once the final model output is durable, database recovery is safe: retry
  // only this idempotent transaction, never either model call.
  if (phase === 'final-ready') {
    const data = await load(storage), result = data.result;
    await recordConfiguration(DB,id,data,row.rules_snapshot);
    const score = reportScore(result);
    if(row.harness_policy)await finishHarnessTask(env,id,'completed');
    if ((data.request.reportSchemaVersion ?? 1) === 1 && score !== null) result.verdict = consistentVerdict(result.verdict, score);
    await timed(DB,id,'persist',()=>DB.batch([
      DB.prepare(`INSERT OR IGNORE INTO reviews(owner_id,title,topic_id,score,result,probe,shots,created_at,job_id,rules_snapshot) SELECT owner_id,title,?,?,?,?,?,?,id,rules_snapshot FROM review_jobs WHERE id=? AND status='running' AND model_executor='platform'`).bind(data.topic_id, score, JSON.stringify(result), JSON.stringify({...data.probe,evidenceOrigin:'admin-upload'}), JSON.stringify(data.images), stamp(), id),
      DB.prepare("UPDATE review_jobs SET status='done',stage='done',result_id=(SELECT id FROM reviews WHERE job_id=?),error='',updated_at=? WHERE id=? AND status='running' AND EXISTS(SELECT 1 FROM reviews WHERE job_id=?)").bind(id, stamp(), id, id),
      ...['review_inputs', 'review_evidence', 'review_material'].map(t => DB.prepare(`DELETE FROM ${t} WHERE job_id=? AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND status='done')`).bind(id,id)),
    ]));
    await markReviewExecution(DB,id,'done').catch(()=>{});
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
      await markReviewExecution(DB,id,'started').catch(()=>{});
      const input = await readReviewInput(DB, id);
      const selected = activeModelProfile(await env.modelStore.get(), 'review');
      if (!selected?.profile.enabled || !selected.profile.encryptedKey) throw new Error('审核模型尚未配置或已停用。');
      const config = { ...selected.profile, activeProfile:selected.id, profiles:{[selected.id]:selected.profile}, routes:{review:selected.id} };
      const runtime = { ...env, ownerId:row.owner_id, modelStore:{get:async()=>config} };
      const evidence = await timed<any>(DB,id,'capture',()=> (env.captureReview || captureFor({...env,reviewJobId:id}))(input.html, (message:string)=>updateReviewProgress(env,id,message)));
      const reportSchemaVersion:1|2=row.report_schema_version===2?2:1;
      const {images,...preparedRequest} = await prepareReview(runtime,{...input,...evidence,rulesSnapshot:row.rules_snapshot?parseReviewRulesSnapshot(row.rules_snapshot):null,reportSchemaVersion});
      const request={...preparedRequest,reportSchemaVersion};
      await updateReviewProgress(env,id,'画面采集已完成，准备模型初评。');
      const data={deadline,config,request,images,probe:evidence.probe,title:input.title,topic_id:input.topic_id||null};
      await save(storage,'prepared',data);
      await recordConfiguration(DB,id,data,row.rules_snapshot);
      return true;
    }
    const data = await load(storage);
    await recordConfiguration(DB,id,data,row.rules_snapshot);
    if (Date.now() >= data.deadline) throw new Error('审核处理时限已到，未发布评分，请重试。');
    const harnessExecution=harnessExecutionFor(row,'review',phase==='prepared'?'review':'review_verify',await harnessHash(canonicalHarness({request:data.request,images:data.images})),data.deadline);
    const runtime = { ...env,harnessExecution, ownerId:row.owner_id, modelStore:{get:async()=>data.config} };
    const request = { ...data.request, deadline:data.deadline, idempotencyKey:`pgc-review-${id}`,
      // A slow initial progress write must not replace the verification message.
      onWait:async(message:string)=>{await DB.prepare("UPDATE review_jobs SET error=?,updated_at=? WHERE id=? AND status='running' AND stage=?").bind(message,stamp(),id,phase==='prepared'?'review':'verify').run();},
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
      data.draft=await timed(DB,id,'initial',()=>generateReviewStage(runtime,{},request,'review'));
      await save(storage,'draft-ready',data);
      return true;
    } else if (phase === 'draft-ready') {
      const advanced=await DB.prepare("UPDATE review_jobs SET stage='verify',updated_at=? WHERE id=? AND status='running' AND model_executor='platform'").bind(stamp(),id).run();
      if(!advanced.meta.changes)throw new Error('审核任务已停止。');
      await storage.put('cloudPhase','verify-started');
      data.result=await timed(DB,id,'verification',()=>generateReviewStage(runtime,{},request,'review_verify',data.draft));
      await save(storage,'final-ready',data);
      return true;
    } else throw new Error('审核阶段不正确，未发布评分。');
  } catch (error) {
    await failDeviceReview(DB,id,(error as Error).message||'审核未完成，请重试。');
    if(row.harness_policy)await finishHarnessTask(env,id,'failed').catch(()=>{});
    await markReviewExecution(DB,id,'error').catch(()=>{});
    await clear(storage);
  } finally { clearInterval(heartbeat); }
}
