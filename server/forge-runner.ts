import {configStore} from './storage';
import {processForgeJob, type ForgeEnv, type ForgeJob} from './forge-api';
import {failForgeTask, FORGE_TASK_LIMIT_MS, type ForgeTask} from './forge-tasks';

export async function executeForgeTask(env: ForgeEnv, id: string) {
  const at = new Date().toISOString();
  const row: ForgeTask | null = await env.DB.prepare("UPDATE forge_tasks SET status='running',started_at=?,updated_at=?,detail='正在准备生成材料…' WHERE id=? AND status='queued' RETURNING *").bind(at,at,id).first();
  if (!row) return;
  const update = (detail:string) => env.DB.prepare("UPDATE forge_tasks SET detail=?,updated_at=? WHERE id=? AND status='running'").bind(detail,new Date().toISOString(),id).run();
  const timer = setInterval(()=>{void env.DB.prepare("UPDATE forge_tasks SET updated_at=? WHERE id=? AND status='running'").bind(new Date().toISOString(),id).run().catch(()=>{});},30000);
  try {
    const job: ForgeJob = JSON.parse(row.payload);
    const result = await processForgeJob({...env,generation:{id,deadline:Date.now()+12*60000,
      onStart:async()=>{
        const result = await env.DB.prepare("UPDATE forge_tasks SET model_started_at=COALESCE(model_started_at,?),updated_at=? WHERE id=? AND status='running'").bind(new Date().toISOString(),new Date().toISOString(),id).run();
        if (!result.meta.changes) throw new Error('生成任务已停止。');
      },onWait:async(message:string)=>{await update(message || '等待模型输出…');},
    }},job);
    // Artifact HTML and briefs live on topics, not in a second task copy.
    const saved = ['preview','suggest','tag'].includes(job.type) ? result : {id:'id' in job ? job.id : undefined};
    await env.DB.prepare("UPDATE forge_tasks SET status='done',result=?,detail='已完成',error='',updated_at=? WHERE id=? AND status='running'").bind(JSON.stringify(saved),new Date().toISOString(),id).run();
  } catch (error) {
    await failForgeTask(env,row,error instanceof Error ? error.message : '生成未完成，请手动重试。');
  } finally {clearInterval(timer);}
}

// Long model calls use Free SQLite DO alarms, not ordinary Free Queue CPU.
// Re-delivery can observe a task, but cannot replay a paid request.
export class ForgeRunner {
  constructor(private state:any, private env:any) {}
  async fetch(request:Request) {
    const id = await request.text();
    if (!/^[a-f0-9-]{36}$/.test(id)) return new Response('Invalid task',{status:400});
    await this.state.storage.put('taskId',id);
    const row = await this.env.DB.prepare('SELECT status FROM forge_tasks WHERE id=?').bind(id).first();
    if (row?.status === 'queued' && !await this.state.storage.getAlarm()) await this.state.storage.setAlarm(Date.now()+100);
    return Response.json({ok:true});
  }
  async alarm() {
    const id = await this.state.storage.get('taskId');
    if (!id) return;
    const row: ForgeTask | null = await this.env.DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(id).first();
    if (row?.status === 'queued') {
      await this.state.storage.setAlarm(Date.now()+FORGE_TASK_LIMIT_MS);
      await executeForgeTask({...this.env,modelStore:configStore(this.env.DB)},id);
    } else if (row?.status === 'running') {
      await failForgeTask(this.env,row,'后台执行意外中断，模型请求结果未知；未自动重复生成，请手动重试。');
    }
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }
}
