import {canonicalJson,digest,problem,readReviewInput,stamp} from './review-device-state';

const source='https://creator-hub-7mi.pages.dev';
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const externalId=(v:unknown)=>v===null||typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);
const fields=new Set(['id','requestId','workId','versionId','score','feedback','updatedAt','source','status','phase','matchedBy','uploadedContentHash','lease']);

function validate(b:any){
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!fields.has(k)))throw problem('真人审核包含不支持的字段。');
  if(!uuid(b.id)||!uuid(b.requestId))throw problem('真人审核任务或请求编号不正确。');
  if(b.lease!==undefined&&!uuid(b.lease))throw problem('真人审核租约不正确。');
  if(!externalId(b.workId)||!externalId(b.versionId)||(b.workId===null)!==(b.versionId===null))throw problem('外部作品和版本编号必须成对提供。');
  if(b.score!==null&&(typeof b.score!=='number'||!Number.isFinite(b.score)||b.score<0||b.score>9))throw problem('真人评分必须为空或 0–9 的数值。');
  if(b.feedback!==null&&(typeof b.feedback!=='string'||b.feedback.length>20000))throw problem('真人审核意见必须为空或最多 20000 字。');
  if(typeof b.updatedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(b.updatedAt)||!Number.isFinite(Date.parse(b.updatedAt))||new Date(b.updatedAt).toISOString()!==b.updatedAt)throw problem('真人审核更新时间必须是 UTC ISO 时间。');
  if(b.source!==source||!['reviewed','pending','unavailable','unlinked'].includes(b.status))throw problem('真人审核来源或状态不正确。');
  if(b.phase!==null&&!['final','preliminary'].includes(b.phase)||b.matchedBy!==null&&!['user-confirmed','published-record'].includes(b.matchedBy))throw problem('真人审核阶段或匹配依据不正确。');
  if(b.status==='reviewed'&&(!b.workId||!b.phase||!b.matchedBy||b.score===null&&!b.feedback?.trim()))throw problem('已审核记录需要作品、版本、匹配依据、阶段和评分或意见。');
  if(b.status==='pending'&&(!b.workId||!b.matchedBy))throw problem('待审核记录需要作品、版本和匹配依据。');
  if(b.status!=='reviewed'&&(b.phase!==null||b.score!==null))throw problem('未审核记录不能带审核阶段或评分。');
  if(b.uploadedContentHash!==undefined&&(typeof b.uploadedContentHash!=='string'||!/^[a-f0-9]{64}$/.test(b.uploadedContentHash)))throw problem('上传内容哈希必须为 SHA-256。');
  return {workId:b.workId,versionId:b.versionId,score:b.score,feedback:b.feedback,updatedAt:b.updatedAt,source:b.source,status:b.status,phase:b.phase,matchedBy:b.matchedBy,...(b.uploadedContentHash!==undefined?{uploadedContentHash:b.uploadedContentHash}:{})};
}

export function publicHumanReview(r:any){
  return r?{id:r.id,jobId:r.job_id,requestId:r.request_id,workId:r.work_id,versionId:r.version_id,score:r.score,feedback:r.feedback,updatedAt:r.source_updated_at,source:r.source,status:r.status,phase:r.phase,matchedBy:r.matched_by,uploadedContentHash:r.uploaded_content_hash,createdAt:r.created_at}:null;
}
export async function currentHumanReview(DB:any,jobId:string,ownerId:string){
  return publicHumanReview(await DB.prepare('SELECT * FROM review_human_reviews WHERE job_id=? AND owner_id=? AND is_current=1').bind(jobId,ownerId).first());
}
// Attach only to already-authorized rows, then enforce owner equality again in
// the join so a report can never borrow another member's external association.
export async function withHumanReviews(DB:any,rows:any[],jobRows=false){
  if(!rows.length)return rows;
  const ids=[...new Set(rows.map(r=>jobRows?r.id:r.job_id).filter(Boolean))];
  if(!ids.length)return rows.map(r=>({...r,human_review:null,human_status:null,human_score:null}));
  const groups=[];for(let i=0;i<ids.length;i+=90)groups.push(ids.slice(i,i+90));
  const batches=await Promise.all(groups.map(group=>DB.prepare(`SELECT * FROM review_human_reviews WHERE is_current=1 AND job_id IN (${group.map(()=>'?').join(',')})`).bind(...group).all()));
  const current=new Map(batches.flatMap(batch=>batch.results||[]).map((r:any)=>[`${r.owner_id}:${r.job_id}`,publicHumanReview(r)]));
  return rows.map(r=>{const h:any=current.get(`${r.owner_id}:${jobRows?r.id:r.job_id}`)||null;return {...r,human_review:h,human_status:h?.status??null,human_score:h?.score??null};});
}

export async function saveHumanReview(DB:any,device:any,b:any){
  const payload=validate(b),hash=await digest(canonicalJson(payload));
  const job=await DB.prepare("SELECT * FROM review_jobs WHERE id=? AND owner_id=? AND executor='device' AND owner_hidden=0").bind(b.id,device.owner_id).first();
  if(!job)throw problem('审核任务不存在。',404);
  if(!['queued','running','done'].includes(job.status))throw problem('此任务不能回填真人审核。',409);
  const hasLease=!!(job.worker_id||job.lease);
  if(hasLease&&(job.worker_id!==device.id||job.lease!==b.lease)||!hasLease&&job.status!=='queued')throw problem('仅原任务设备可回填，请使用原租约。',409);
  const old=await DB.prepare('SELECT * FROM review_human_reviews WHERE job_id=? AND request_id=? AND owner_id=?').bind(job.id,b.requestId,device.owner_id).first();
  if(old){if(old.payload_hash!==hash)throw problem('同一真人审核请求不能更换内容。',409);return {ok:true,human_review:publicHumanReview(old)};}
  if(payload.uploadedContentHash){
    let inputHash=job.input_hash;
    if(!inputHash){
      try{inputHash=await digest((await readReviewInput(DB,job.id)).html);}catch{throw problem('原上传内容已清理，无法验证内容哈希。',409);}
      await DB.prepare('UPDATE review_jobs SET input_hash=? WHERE id=? AND input_hash IS NULL').bind(inputHash,job.id).run();
    }
    if(inputHash!==payload.uploadedContentHash)throw problem('真人审核关联的上传内容哈希不一致。',409);
  }
  const rank=payload.status==='reviewed'?(payload.phase==='final'?3:2):payload.status==='pending'?1:0;
  const now=stamp();
  await DB.batch([
    // Recheck status, lease and immutable external IDs inside the insert, so a
    // concurrent claim or association cannot race the authorization above.
    DB.prepare(`INSERT OR IGNORE INTO review_human_reviews(job_id,owner_id,device_id,request_id,payload_hash,work_id,version_id,score,feedback,source_updated_at,source,status,phase,matched_by,uploaded_content_hash,display_rank,created_at)
      SELECT id,owner_id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM review_jobs j
      WHERE id=? AND owner_id=? AND executor='device' AND owner_hidden=0 AND status IN ('queued','running','done')
      AND ((status='queued' AND worker_id IS NULL AND lease IS NULL) OR (worker_id=? AND lease=?))
      AND NOT EXISTS(SELECT 1 FROM review_human_reviews h WHERE h.job_id=j.id AND h.work_id IS NOT NULL AND ? IS NOT NULL AND (h.work_id<>? OR h.version_id<>?))`)
      .bind(device.id,b.requestId,hash,payload.workId,payload.versionId,payload.score,payload.feedback,payload.updatedAt,payload.source,payload.status,payload.phase,payload.matchedBy,payload.uploadedContentHash??null,rank,now,job.id,device.owner_id,device.id,b.lease??null,payload.workId,payload.workId,payload.versionId),
    // Newer observations may advance the displayed status, but a delayed
    // callback or preliminary/failed lookup cannot replace a final decision.
    DB.prepare(`UPDATE review_human_reviews AS current SET is_current=0 WHERE job_id=? AND is_current=1 AND EXISTS(
      SELECT 1 FROM review_human_reviews incoming WHERE incoming.job_id=current.job_id AND incoming.request_id=? AND incoming.payload_hash=? AND incoming.id<>current.id
      AND incoming.source_updated_at>=current.source_updated_at AND incoming.display_rank>=current.display_rank
      AND (current.work_id IS NULL OR incoming.work_id IS NOT NULL))`)
      .bind(job.id,b.requestId,hash),
    DB.prepare('UPDATE review_human_reviews SET is_current=1 WHERE job_id=? AND request_id=? AND payload_hash=? AND NOT EXISTS(SELECT 1 FROM review_human_reviews h WHERE h.job_id=? AND h.is_current=1)').bind(job.id,b.requestId,hash,job.id),
  ]);
  const saved=await DB.prepare('SELECT * FROM review_human_reviews WHERE job_id=? AND request_id=? AND owner_id=?').bind(job.id,b.requestId,device.owner_id).first();
  if(!saved)throw problem('任务租约或作品关联已改变，请保持原作品和版本。',409);
  if(saved.payload_hash!==hash)throw problem('同一真人审核请求不能更换内容。',409);
  return {ok:true,human_review:publicHumanReview(saved)};
}
