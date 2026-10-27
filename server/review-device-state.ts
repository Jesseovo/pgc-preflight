export const stamp=()=>new Date().toISOString();
export const problem=(message:string,status=400)=>Object.assign(new Error(message),{status});
export const digest=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
export async function readReviewInput(DB:any,id:string,table='review_inputs'){
  if(!['review_inputs','review_evidence'].includes(table))throw new Error('Invalid input table');
  const {results}=await DB.prepare(`SELECT data FROM ${table} WHERE job_id=? ORDER BY part`).bind(id).all();
  if(!results.length)throw problem('临时审核材料已过期，请重新上传。',410);
  return JSON.parse(results.map((r:any)=>r.data).join(''));
}
export function inputChunks(DB:any,id:string,value:unknown,table='review_evidence'){
  if(!['review_inputs','review_evidence'].includes(table))throw new Error('Invalid input table');
  const text=JSON.stringify(value),statements=[];
  for(let i=0;i<text.length;){let end=Math.min(i+120000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
    const condition=table==='review_evidence'?" WHERE EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND evidence_ready=0 AND status='running')":'';
    statements.push(DB.prepare(`INSERT INTO ${table}(job_id,part,data,created_at) SELECT ?,?,?,?${condition}`).bind(id,statements.length,text.slice(i,end),stamp(),...(condition?[id]:[])));i=end;
  }
  return statements;
}
export async function failDeviceReview(DB:any,id:string,message:string){
  await DB.batch([
    DB.prepare("UPDATE review_jobs SET status='error',error=?,quota_charged=CASE WHEN model_started_at IS NULL THEN 0 ELSE quota_charged END,updated_at=? WHERE id=? AND status IN ('queued','running')").bind(message.slice(0,500),stamp(),id),
    ...['review_inputs','review_evidence'].map(t=>DB.prepare(`DELETE FROM ${t} WHERE job_id=? AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND status IN ('error','done'))`).bind(id,id)),
  ]);
}
export async function recoverDeviceReviews(DB:any){
  const cutoff=new Date(Date.now()-180000).toISOString();
  await DB.batch([
    // A disconnected capture may be claimed again. Once evidence is accepted,
    // the cloud alarm owns the job; device heartbeats must not affect it.
    DB.prepare("UPDATE review_jobs SET status='queued',lease=NULL,worker_id=NULL,stage='capture',error='等待 Agent 重新连接',updated_at=? WHERE executor='device' AND status='running' AND evidence_ready=0 AND model_execution_started_at IS NULL AND updated_at<?").bind(stamp(),cutoff),
    DB.prepare("UPDATE review_jobs SET status='error',quota_charged=CASE WHEN model_started_at IS NULL THEN 0 ELSE quota_charged END,error='云端审核已中断，模型状态未知；未发布评分，请手动重试。',updated_at=? WHERE executor='device' AND status='running' AND evidence_ready=1 AND updated_at<?").bind(stamp(),new Date(Date.now()-15*60000).toISOString()),
    DB.prepare("DELETE FROM review_pairings WHERE expires_at<?").bind(stamp()),
    ...['review_inputs','review_evidence'].map(t=>DB.prepare(`DELETE FROM ${t} WHERE job_id IN (SELECT id FROM review_jobs WHERE executor='device' AND status IN ('error','done'))`).bind()),
  ]);
}
export async function deviceOwnerAllowed(DB:any,row:any){
  if(row.owner_id==='admin')return;
  const member=await DB.prepare('SELECT enabled,can_review,session_version FROM members WHERE id=?').bind(row.owner_id).first();
  if(!member?.enabled||!member.can_review)throw problem('成员账号已停用或审核权限已撤销。',403);
}
