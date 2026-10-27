import type { ForgeEnv, ForgeJob } from './forge-api';

export interface ForgeRunnerBinding { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
export interface ForgeTask { id: string; kind: string; scope: string; payload: string; status: string; detail: string; error: string; result: string | null; created_at: string; updated_at: string; started_at: string | null; model_started_at: string | null }
const stamp = () => new Date().toISOString();
export const FORGE_TASK_LIMIT_MS = 14 * 60000;
export const taskScope = (job: ForgeJob) => job.type === 'expand' ? `expand:${job.ids[0]}` : job.type === 'suggest' ? `vocab:${job.dim}` : job.type === 'tag' ? 'tags:all' : `${job.type}:${job.id}`;

// Insert the task and its visible state in one transaction. A repeated click
// finds the same active scope, including while waiting for the model gateway.
export async function enqueueForgeTask(env: ForgeEnv, job: ForgeJob, taskId: string = crypto.randomUUID()) {
  if (!env.FORGE_RUNNER) throw new Error('后台生成服务尚未就绪。');
  const id = taskId, scope = taskScope(job), at = stamp();
  if (job.type === 'game') job = {...job, requestId:id};
  const statements = [env.DB.prepare("INSERT OR IGNORE INTO forge_tasks(id,kind,scope,payload,created_at,updated_at,detail) VALUES(?,?,?,?,?,?,'等待后台执行…')").bind(id,job.type,scope,JSON.stringify(job),at,at)];
  const owns = "EXISTS(SELECT 1 FROM forge_tasks WHERE id=? AND status='queued')";
  if (['expand','brief','assets','game'].includes(job.type)) {
    const column = job.type === 'game' ? 'product' : job.type;
    const topicId = job.type === 'expand' ? job.ids[0] : (job as {id:number}).id;
    statements.push(env.DB.prepare(`UPDATE topics SET ${column}_status=?,${column}_error='等待后台执行…',updated_at=?${job.type === 'game' ? ',product_request_id=?' : ''} WHERE id=? AND ${owns}`)
      .bind(job.type === 'game' ? 'queued' : 'running',at,...(job.type === 'game' ? [id] : []),topicId,id));
  }
  await env.DB.batch(statements);
  const row: ForgeTask = await env.DB.prepare("SELECT * FROM forge_tasks WHERE id=? OR (scope=? AND status IN ('queued','running')) ORDER BY created_at DESC LIMIT 1").bind(id,scope).first();
  await scheduleForgeTask(env,row);
  return row;
}

export async function scheduleForgeTask(env: ForgeEnv, row: ForgeTask) {
  if (row.status !== 'queued' || !env.FORGE_RUNNER) return;
  try {
    const binding = env.FORGE_RUNNER;
    const response = await binding.get(binding.idFromName(row.id)).fetch(new Request('https://internal/run',{method:'POST',body:row.id}));
    if (!response.ok) throw new Error('scheduling failed');
  } catch {
    // The durable record is already committed. A GET or maintenance pass can
    // re-schedule this exact ID; never insert a second model task.
    await env.DB.prepare("UPDATE forge_tasks SET detail='正在恢复后台连接…' WHERE id=? AND status='queued'").bind(row.id).run();
  }
}

export async function failForgeTask(env: ForgeEnv, row: ForgeTask, reason: string) {
  const job: ForgeJob = JSON.parse(row.payload), at = stamp(), message = reason.slice(0,700);
  const statements = [];
  if (['expand','brief','assets','game'].includes(job.type)) {
    const column = job.type === 'game' ? 'product' : job.type;
    const topicId = job.type === 'expand' ? job.ids[0] : (job as {id:number}).id;
    statements.push(env.DB.prepare(`UPDATE topics SET ${column}_status='error',${column}_error=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM forge_tasks WHERE id=? AND status IN ('queued','running'))`)
      .bind(message,at,topicId,row.id));
  }
  statements.push(env.DB.prepare("UPDATE forge_tasks SET status='error',error=?,detail=?,updated_at=? WHERE id=? AND status IN ('queued','running')").bind(message,message,at,row.id));
  await env.DB.batch(statements);
}

export async function readForgeTask(env: ForgeEnv, id: string) {
  let row: ForgeTask | null = await env.DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(id).first();
  if (!row) return null;
  if ((row.status === 'running' && Date.now() - Date.parse(row.started_at!) > FORGE_TASK_LIMIT_MS) ||
      (row.status === 'queued' && Date.now() - Date.parse(row.created_at) > 86400000)) {
    await failForgeTask(env,row,'后台执行已中断，未自动重复调用模型。请检查后手动重试。');
    row = await env.DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(id).first();
  }
  if (row) await scheduleForgeTask(env,row);
  return row;
}

export function publicForgeTask(row: ForgeTask) {
  return {id:row.id,kind:row.kind,scope:row.scope,status:row.status,detail:row.detail,error:row.error,
    result:row.status === 'done' && row.result ? JSON.parse(row.result) : null,created_at:row.created_at,started_at:row.started_at,updated_at:row.updated_at};
}

export async function recoverForgeTasks(env: ForgeEnv, topicId?: number) {
  const rows: ForgeTask[] = (await env.DB.prepare(`SELECT * FROM forge_tasks WHERE status IN ('queued','running')${topicId == null ? '' : ' AND scope IN (?,?,?,?,?)'} ORDER BY created_at LIMIT 100`)
    .bind(...(topicId == null ? [] : ['expand','brief','assets','game','preview'].map(k=>`${k}:${topicId}`))).all()).results;
  for (const row of rows) await readForgeTask(env,row.id);
}
