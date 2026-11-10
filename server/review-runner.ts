import {parseReviewRulesSnapshot} from './review-rules';
import {reportScore} from './review-report';
import {configStore} from './storage';
import {prepareReview,consistentVerdict} from './forge-api';
import {generateReview} from './review-generation';
import {deviceOwnerAllowed,failDeviceReview,readReviewInput,stamp} from './review-device-state';
import {cloudReviewAlarm} from './cloud-review-runner';
import {clearHarnessRunnerStorage} from './harness-execution';

// One alarm per game, with a 15-minute wall-clock limit and Free DO CPU
// allowance. The alarm survives a closed member tab or disconnected device.
// A duplicate alarm can observe a lease, but never replay an unknown paid call.
export async function executeDeviceReview(env:any,id:string){
  const DB=env.DB;
  const claimed=await DB.prepare("UPDATE review_jobs SET model_execution_started_at=?,updated_at=? WHERE id=? AND executor='device' AND model_executor='platform' AND status='running' AND evidence_ready=1 AND model_execution_started_at IS NULL RETURNING *").bind(stamp(),stamp(),id).first();
  if(!claimed)return;
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  try{
    heartbeat=setInterval(()=>{void DB.prepare("UPDATE review_jobs SET updated_at=? WHERE id=? AND status='running'").bind(stamp(),id).run().catch(()=>{});},30000);
    await deviceOwnerAllowed(DB,claimed);
    const input=await readReviewInput(DB,id),evidence=await readReviewInput(DB,id,'review_evidence');
    const selected=JSON.parse(claimed.model_snapshot);
    const config={...selected.profile,activeProfile:selected.id,profiles:{[selected.id]:selected.profile},routes:{review:selected.id}};
    const runtime={...env,ownerId:claimed.owner_id,modelStore:{get:async()=>config}};
    const reportSchemaVersion:1|2=claimed.report_schema_version===2?2:1;
    const {images,...request}=await prepareReview(runtime,{...input,...evidence,rulesSnapshot:claimed.rules_snapshot?parseReviewRulesSnapshot(claimed.rules_snapshot):null,reportSchemaVersion});
    const result=await generateReview(runtime,{}, {...request,reportSchemaVersion,deadline:Date.now()+12*60000,idempotencyKey:`pgc-review-${id}`,
      onStart:async()=>{
        await deviceOwnerAllowed(DB,claimed);
        const updated=await DB.prepare("UPDATE review_jobs SET model_started_at=COALESCE(model_started_at,?),updated_at=? WHERE id=? AND status='running'").bind(stamp(),stamp(),id).run();
        if(!updated.meta.changes)throw new Error('审核任务已经停止。');
      },
      onWait:async(message:string)=>{await DB.prepare("UPDATE review_jobs SET stage=CASE WHEN ? LIKE '%复核%' THEN 'verify' ELSE stage END,error=?,updated_at=? WHERE id=? AND status='running'").bind(message,message,stamp(),id).run();},
    });
    const score=reportScore(result);if(reportSchemaVersion===1&&score!==null)result.verdict=consistentVerdict(result.verdict,score);
    await DB.batch([
      DB.prepare(`INSERT OR IGNORE INTO reviews(owner_id,title,topic_id,score,result,probe,shots,created_at,job_id,rules_snapshot) SELECT owner_id,title,?,?,?,?,?,?,id,rules_snapshot FROM review_jobs WHERE id=? AND status='running'`).bind(input.topic_id||null,score,JSON.stringify(result),JSON.stringify({...evidence.probe,evidenceOrigin:'member-device'}),JSON.stringify(images),stamp(),id),
      DB.prepare("UPDATE review_jobs SET status='done',stage='done',result_id=(SELECT id FROM reviews WHERE job_id=?),error='',updated_at=? WHERE id=? AND status='running' AND EXISTS(SELECT 1 FROM reviews WHERE job_id=?)").bind(id,stamp(),id,id),
      ...['review_inputs','review_evidence'].map(t=>DB.prepare(`DELETE FROM ${t} WHERE job_id=? AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND status='done')`).bind(id,id)),
    ]);
  }catch(error){await failDeviceReview(DB,id,(error as Error).message||'云端模型审核未完成，请重试。');}
  finally{clearInterval(heartbeat);}
}
export class ReviewRunner{
  constructor(private state:any,private env:any){}
  async fetch(request:Request){
    const id=await request.text();if(!/^[a-f0-9-]{36}$/.test(id))return new Response('Invalid job', {status:400});
    const row=await this.env.DB.prepare('SELECT status,executor,evidence_ready,model_execution_started_at,model_executor FROM review_jobs WHERE id=?').bind(id).first();
    const meta=await this.state.storage.get('embedded-harness-meta'),journal=await this.state.storage.get('embedded-harness-allocation');
    const needsEmbeddedCleanup=Boolean(meta?.taskId===id||journal?.taskId===id||await this.state.storage.get('jobId')===id&&await this.state.storage.get('embedded-baseline-capture'));
    if(!row||row.model_executor!=='platform'){
      if(needsEmbeddedCleanup){await this.state.storage.put('jobId',id);if(!await this.state.storage.getAlarm())await this.state.storage.setAlarm(Date.now()+100);}
      return Response.json({error:'此任务由成员 Agent 执行。'},{status:409});
    }
    // Persist only compatible platform work; local jobs never schedule alarms.
    await this.state.storage.put('jobId',id);
    if(!await this.state.storage.getAlarm() && (needsEmbeddedCleanup||row.executor==='cloud'&&['queued','running'].includes(row.status) || row?.status==='running'&&row.evidence_ready&&!row.model_execution_started_at))await this.state.storage.setAlarm(Date.now()+100);
    return Response.json({ok:true});
  }
  async alarm(){
    const id=await this.state.storage.get('jobId');if(!id)return;
    const row=await this.env.DB.prepare('SELECT status,executor,model_execution_started_at,model_executor FROM review_jobs WHERE id=?').bind(id).first();
    if(row?.executor==='cloud'&&row.model_executor==='platform')return cloudReviewAlarm(this.state,{...this.env,modelStore:configStore(this.env.DB)},id);
    if(row?.status!=='running'||row.model_executor!=='platform'){await clearHarnessRunnerStorage(this.env,this.state.storage,id);await this.state.storage.deleteAlarm();return;}
    if(row.model_execution_started_at){
      await failDeviceReview(this.env.DB,id,'云端执行意外中断，模型请求状态未知；未发布评分，请手动重试。');
    }else{
      // Watchdog also handles runtime eviction without retrying provider calls.
      await this.state.storage.setAlarm(Date.now()+14*60000);
      await executeDeviceReview({...this.env,modelStore:configStore(this.env.DB)},id);
    }
    await this.state.storage.deleteAlarm();
    await clearHarnessRunnerStorage(this.env,this.state.storage,id);
  }
}
