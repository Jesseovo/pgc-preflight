export const stamp=()=>new Date().toISOString();
export const problem=(message:string,status=400)=>Object.assign(new Error(message),{status});
export const digest=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
// Stable hashes let retries reuse an immutable report even if JSON key order changes.
export const canonicalJson=(value:any):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export async function readReviewInput(DB:any,id:string,table='review_inputs'){
  if(!['review_inputs','review_evidence','review_material'].includes(table))throw new Error('Invalid input table');
  const {results}=await DB.prepare(`SELECT data FROM ${table} WHERE job_id=? ORDER BY part`).bind(id).all();
  if(!results.length)throw problem('临时审核材料已过期，请重新上传。',410);
  return JSON.parse(results.map((r:any)=>r.data).join(''));
}
export function inputChunks(DB:any,id:string,value:unknown,table='review_evidence',materialHash?:string){
  if(!['review_inputs','review_evidence','review_material'].includes(table)||table==='review_material'&&!materialHash)throw new Error('Invalid input table');
  const text=JSON.stringify(value),statements=[];
  for(let i=0;i<text.length;){let end=Math.min(i+120000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
    const condition=table==='review_evidence'?" WHERE EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND evidence_ready=0 AND status='running')":table==='review_material'?" WHERE EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND local_material_hash=? AND status='running')":'';
    statements.push(DB.prepare(`INSERT ${table==='review_material'?'OR IGNORE ':''}INTO ${table}(job_id,part,data,created_at) SELECT ?,?,?,?${condition}`).bind(id,statements.length,text.slice(i,end),stamp(),...(condition?[id,...(table==='review_material'?[materialHash]:[])]:[])));i=end;
  }
  return statements;
}
export async function failDeviceReview(DB:any,id:string,message:string){
  await DB.batch([
    DB.prepare("UPDATE review_jobs SET status='error',error=?,quota_charged=CASE WHEN model_executor='agent' OR model_started_at IS NULL THEN 0 ELSE quota_charged END,updated_at=? WHERE id=? AND status IN ('queued','running')").bind(message.slice(0,500),stamp(),id),
    ...['review_inputs','review_evidence','review_material'].map(t=>DB.prepare(`DELETE FROM ${t} WHERE job_id=? AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND status IN ('error','done'))`).bind(id,id)),
  ]);
}
export async function recoverDeviceReviews(DB:any){
  const cutoff=new Date(Date.now()-180000).toISOString();
  await DB.batch([
    // Existing platform captures retain their old lease recovery. Local model
    // work keeps its original device/lease and can resume after disconnection.
    DB.prepare("UPDATE review_jobs SET status='queued',lease=NULL,worker_id=NULL,stage='capture',error='等待 Agent 重新连接',updated_at=? WHERE executor='device' AND model_executor='platform' AND status='running' AND evidence_ready=0 AND model_execution_started_at IS NULL AND updated_at<?").bind(stamp(),cutoff),
    DB.prepare("UPDATE review_jobs SET status='error',quota_charged=CASE WHEN model_started_at IS NULL THEN 0 ELSE quota_charged END,error='云端审核已中断，模型状态未知；未发布评分，请手动重试。',updated_at=? WHERE executor='device' AND model_executor='platform' AND status='running' AND evidence_ready=1 AND updated_at<?").bind(stamp(),new Date(Date.now()-15*60000).toISOString()),
    DB.prepare("UPDATE review_jobs SET status='error',quota_charged=0,error='本地审核超过 24 小时未活动，临时材料已过期；请重新上传。',updated_at=? WHERE model_executor='agent' AND status IN ('queued','running') AND updated_at<?").bind(stamp(),new Date(Date.now()-86400000).toISOString()),
    DB.prepare("DELETE FROM review_pairings WHERE expires_at<?").bind(stamp()),
    ...['review_inputs','review_evidence','review_material'].map(t=>DB.prepare(`DELETE FROM ${t} WHERE job_id IN (SELECT id FROM review_jobs WHERE executor='device' AND status IN ('error','done'))`).bind()),
  ]);
}
export async function deviceOwnerAllowed(DB:any,row:any){
  if(row.owner_id==='admin')return;
  const member=await DB.prepare('SELECT enabled,can_review,session_version FROM members WHERE id=?').bind(row.owner_id).first();
  if(!member?.enabled||!member.can_review)throw problem('成员账号已停用或审核权限已撤销。',403);
}
