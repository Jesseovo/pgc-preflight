import {configStore} from './storage';
import {processForgeJob, type ForgeEnv, type ForgeJob} from './forge-api';
import {failForgeTask, FORGE_RESULT_RECOVERY_MS, FORGE_TASK_LIMIT_MS, hasForgeHarnessResult, type ForgeTask} from './forge-tasks';
import {memberStore} from './storage';
import {claimCreationModel} from './model-capacity';
import {creationPipelineAlarm} from './forge-creation-pipeline';
import {harnessExecutionFor,finishHarnessTask,clearHarnessRunnerStorage} from './harness-execution';
import {harnessHash} from './harness-policy';

async function requireCreationAccess(env:ForgeEnv,owner:string){
  if(owner==='admin')return; // historical platform tasks only
  const member=await memberStore(env.DB).byId(owner);
  if(!member?.enabled||!member.star)throw new Error('账号已停用或 Star 权限已撤销，本次未发起新的模型请求。');
}

async function publishForgeHarnessResult(env:ForgeEnv,id:string){
  await finishHarnessTask(env,id,'completed');
  await env.DB.prepare("UPDATE forge_tasks SET status='done',detail='已完成',error='',updated_at=? WHERE id=? AND status='running' AND result IS NOT NULL")
    .bind(new Date().toISOString(),id).run();
}

export async function executeForgeTask(env: ForgeEnv, id: string) {
  const at = new Date().toISOString();
  const pending:ForgeTask|null=await env.DB.prepare("SELECT * FROM forge_tasks WHERE id=? AND executor='platform' AND status='queued'").bind(id).first();
  if(!pending)return;
  let reservation:Awaited<ReturnType<typeof claimCreationModel>>;
  try{
    await requireCreationAccess(env,pending.owner_id||'admin');
    const job:ForgeJob=JSON.parse(pending.payload);
    reservation=pending.harness_policy?{config:await env.modelStore.get(),reserved:false,lease:{release:async()=>{}}}:await claimCreationModel(env.DB,await env.modelStore.get(),env.SETTINGS_KEY,job.type==='game'?'game':'create',id);
  }catch(error){await failForgeTask(env,pending,error instanceof Error?error.message:'模型配置无法读取。');return;}
  if(!reservation){await env.DB.prepare("UPDATE forge_tasks SET detail='制作模型并发已满，等待空闲 Key 名额…',updated_at=? WHERE id=? AND status='queued'").bind(at,id).run();return;}
  const row: ForgeTask | null = await env.DB.prepare("UPDATE forge_tasks SET status='running',started_at=?,updated_at=?,detail='正在准备生成材料…' WHERE id=? AND executor='platform' AND status='queued' RETURNING *").bind(at,at,id).first();
  if (!row) {await reservation.lease.release();return;}
  let uncertain=false,startedHarness=false;
  const update = (detail:string) => env.DB.prepare("UPDATE forge_tasks SET detail=?,updated_at=? WHERE id=? AND status='running'").bind(detail,new Date().toISOString(),id).run();
  const timer = setInterval(()=>{void env.DB.prepare("UPDATE forge_tasks SET updated_at=? WHERE id=? AND status='running'").bind(new Date().toISOString(),id).run().catch(()=>{});},30000);
  try {
    await requireCreationAccess(env,row.owner_id||'admin');
    const job: ForgeJob = JSON.parse(row.payload);
    const config=reservation.config;
    const harnessExecution=harnessExecutionFor(row,'forge',row.kind,await harnessHash(row.input_snapshot||'null'),Date.now()+12*60000);
    const result = await processForgeJob({...env,harnessExecution,modelStore:{get:async()=>config,set:async()=>{throw new Error('任务模型快照不可修改。');}},ownerId:row.owner_id||'admin',generationSnapshot:row.input_snapshot?JSON.parse(row.input_snapshot):null,generation:{id,deadline:Date.now()+12*60000,
      capacityReserved:reservation.reserved,onUncertain:()=>{uncertain=true;},
      onStart:async()=>{
        await requireCreationAccess(env,row.owner_id||'admin');
        const result = await env.DB.prepare("UPDATE forge_tasks SET model_started_at=COALESCE(model_started_at,?),updated_at=? WHERE id=? AND status='running'").bind(new Date().toISOString(),new Date().toISOString(),id).run();
        if (!result.meta.changes) throw new Error('生成任务已停止。');
        startedHarness=Boolean(harnessExecution);
      },onWait:async(message:string)=>{await update(message || '等待模型输出…');},
    }},job);
    // Artifact HTML and briefs live on topics, not in a second task copy.
    const version=await env.DB.prepare('SELECT id,topic_id,disposition FROM artifact_versions WHERE task_id=?').bind(id).first();
    const saved = version?{id:version.topic_id,version_id:version.id,disposition:version.disposition}:['preview','suggest','tag','mechanism-check'].includes(job.type) ? result : {id:'id' in job ? job.id : undefined};
    if(startedHarness){
      const checkpoint=await env.DB.prepare("UPDATE forge_tasks SET result=?,updated_at=? WHERE id=? AND status='running' AND result IS NULL")
        .bind(JSON.stringify(saved),new Date().toISOString(),id).run();
      if(!checkpoint.meta.changes)throw new Error('生成任务已停止。');
      await publishForgeHarnessResult(env,id).catch(()=>{});
      return;
    }
    await env.DB.prepare("UPDATE forge_tasks SET status='done',result=?,detail='已完成',error='',updated_at=? WHERE id=? AND status='running'").bind(JSON.stringify(saved),new Date().toISOString(),id).run();
  } catch (error) {
    await failForgeTask(env,row,error instanceof Error ? error.message : '生成未完成，请手动重试。');
  } finally {clearInterval(timer);if(!uncertain)await reservation.lease.release();}
}

// Long model calls use Free SQLite DO alarms, not ordinary Free Queue CPU.
// Re-delivery can observe a task, but cannot replay a paid request.
export class ForgeRunner {
  constructor(private state:any, private env:any) {this.env={...env,harnessStorage:state.storage};}
  async fetch(request:Request) {
    const id = await request.text();
    if (!/^[a-f0-9-]{36}$/.test(id)) return new Response('Invalid task',{status:400});
    await this.state.storage.put('taskId',id);
    const row = await this.env.DB.prepare('SELECT status,executor,creative_version,kind,result FROM forge_tasks WHERE id=?').bind(id).first();
    const needsEmbeddedCleanup=Boolean(await this.state.storage.get('embedded-harness-meta')||await this.state.storage.get('embedded-harness-allocation')||await this.state.storage.get('embedded-baseline-capture'));
    if ((needsEmbeddedCleanup||row?.executor!=='agent' && (row?.status==='queued'||row?.status==='running'&&(row.creative_version===2&&row.kind==='game'||row.result))) && !await this.state.storage.getAlarm()) await this.state.storage.setAlarm(Date.now()+100);
    return Response.json({ok:true});
  }
  async alarm() {
    const id = await this.state.storage.get('taskId');
    if (!id) return;
    const row: ForgeTask | null = await this.env.DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(id).first();
    if(row?.executor==='agent'){await this.state.storage.deleteAlarm();await clearHarnessRunnerStorage(this.env,this.state.storage,id);return;}
    if(row?.creative_version===2&&row.kind==='game')return creationPipelineAlarm(this.state,{...this.env,modelStore:configStore(this.env.DB)},id);
    if (row?.status === 'queued') {
      await this.state.storage.setAlarm(Date.now()+FORGE_TASK_LIMIT_MS);
      await executeForgeTask({...this.env,modelStore:configStore(this.env.DB)},id);
      const current=await this.env.DB.prepare('SELECT status,result FROM forge_tasks WHERE id=?').bind(id).first();
      if(current?.status==='queued'){await this.state.storage.setAlarm(Date.now()+5000);return;}
      if(current?.status==='running'&&current.result){await this.state.storage.setAlarm(Date.now()+30000);return;}
    } else if (row?.status === 'running') {
      if(hasForgeHarnessResult(row)&&Date.now()-Date.parse(row.updated_at)<=FORGE_RESULT_RECOVERY_MS){
        try{await publishForgeHarnessResult(this.env,id);}
        catch{await this.state.storage.setAlarm(Date.now()+30000);return;}
      }else await failForgeTask(this.env,row,hasForgeHarnessResult(row)?'生成结果保存超过恢复时限，未自动重复生成。':'后台执行意外中断，模型请求结果未知；未自动重复生成，请手动重试。');
    }
    await this.state.storage.deleteAlarm();
    await clearHarnessRunnerStorage(this.env,this.state.storage,id);
  }
}
