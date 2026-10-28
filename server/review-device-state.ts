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
export async function failDeviceReview(DB:any,id:string,message:string,expectedUpdatedAt?:string){
  await DB.batch([
    DB.prepare(`UPDATE review_jobs SET status='error',error=?,quota_charged=CASE WHEN model_executor='agent' OR model_started_at IS NULL THEN 0 ELSE quota_charged END,updated_at=? WHERE id=? AND status IN ('queued','running')${expectedUpdatedAt?' AND updated_at=?':''}`).bind(message.slice(0,500),stamp(),id,...(expectedUpdatedAt?[expectedUpdatedAt]:[])),
    ...['review_inputs','review_evidence','review_material'].map(t=>DB.prepare(`DELETE FROM ${t} WHERE job_id=? AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND status IN ('error','done'))`).bind(id,id)),
  ]);
}
export async function recoverDeviceReviews(DB:any,ownerId?:string,jobId?:string){
  // Polling must never sweep every member's completed jobs and material. Use
  // indexed stale candidates, then clean only the jobs that actually expired.
  const scope=`${ownerId?' AND owner_id=?':''}${jobId?' AND id=?':''}`;
  const params=[...(ownerId?[ownerId]:[]),...(jobId?[jobId]:[])];
  const candidates=await DB.prepare(`SELECT id,updated_at,model_executor,evidence_ready,model_execution_started_at FROM review_jobs WHERE
    ((model_executor='agent' AND status IN ('queued','running') AND updated_at<?)
    OR (model_executor='platform' AND executor='device' AND status='running' AND updated_at<?))${scope}`)
    .bind(new Date(Date.now()-86400000).toISOString(),new Date(Date.now()-180000).toISOString(),...params).all();
  for(const row of candidates.results){
    if(row.model_executor==='agent')await failDeviceReview(DB,row.id,'本地审核超过 24 小时未活动，临时材料已过期；请重新上传。',row.updated_at);
    else if(!row.evidence_ready&&!row.model_execution_started_at){
      await DB.prepare("UPDATE review_jobs SET status='queued',lease=NULL,worker_id=NULL,stage='capture',error='等待 Agent 重新连接',updated_at=? WHERE id=? AND status='running' AND evidence_ready=0 AND model_execution_started_at IS NULL AND updated_at=?").bind(stamp(),row.id,row.updated_at).run();
    }else if(row.evidence_ready){
      if(Date.parse(row.updated_at)<Date.now()-15*60000)await failDeviceReview(DB,row.id,'云端审核已中断，模型状态未知；未发布评分，请手动重试。',row.updated_at);
    }
  }
  if(!ownerId&&!jobId)await DB.prepare('DELETE FROM review_pairings WHERE expires_at<?').bind(stamp()).run();
}
export async function deviceOwnerAllowed(DB:any,row:any){
  if(row.owner_id==='admin')return;
  const member=await DB.prepare('SELECT enabled,can_review,session_version FROM members WHERE id=?').bind(row.owner_id).first();
  if(!member?.enabled||!member.can_review)throw problem('成员账号已停用或审核权限已撤销。',403);
}
