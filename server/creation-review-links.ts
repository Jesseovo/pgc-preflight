import {digest,problem,stamp} from './review-device-state';
import {feedbackEnabled,type CreatorFeedbackEnv} from './creator-feedback-runner';
import {cachedFeedbackVersionSequence,requirePilotAuthor,verifyFeedbackAuthorVersion} from './review-pilots';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const sourceId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
export const validReviewArtifactVersion=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);

export async function verifyReviewArtifact(DB:any,ownerId:string,id:string,inputHash:string,topicId?:number|null):Promise<number>{
  const artifact=await DB.prepare("SELECT topic_id,content FROM artifact_versions WHERE id=? AND owner_id=? AND kind='game'").bind(id,ownerId).first();
  if(!artifact)throw problem('此账号没有该游戏成品版本。',404);
  if(topicId!=null&&topicId!==artifact.topic_id)throw problem('成品版本与选题不一致。',409);
  if(await digest(artifact.content)!==inputHash)throw problem('HTML 与指定成品版本的 SHA-256 不一致，请使用该版本的原文件。',409);
  return artifact.topic_id;
}

export function parseCreationSubmission(value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value))throw problem('需要实际 Creator 投稿记录。');
  const {workId,versionId,uploadHash,provenance}=value as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['workId','versionId','uploadHash','provenance'].includes(key))||!sourceId(workId)||!sourceId(versionId)||
    typeof uploadHash!=='string'||!/^[0-9a-f]{64}$/.test(uploadHash)||provenance!=='creator-submission-record')throw problem('需要实际投稿的作品编号、版本编号、HTML SHA-256 和来源 creator-submission-record。');
  return {workId,versionId,uploadHash,provenance};
}

export async function recordCreationSubmission(env:CreatorFeedbackEnv,device:{id:string;owner_id:string;session_version:string;token_hash:string},value:any){
  if(!value||typeof value!=='object'||Array.isArray(value))throw problem('需要原审核任务与设备租约。');
  const {id,lease,...declaration}=value;
  if(!uuid(id)||!uuid(lease))throw problem('需要原审核任务与设备租约。');
  const {workId,versionId,uploadHash,provenance}=parseCreationSubmission(declaration),DB=env.DB;
  const job=await DB.prepare(`SELECT j.* FROM review_jobs j WHERE j.id=? AND j.owner_id=? AND j.owner_hidden=0 AND j.executor='device' AND j.model_executor='agent'`).bind(id,device.owner_id).first();
  if(!job)throw problem('审核任务不存在。',404);
  if(job.worker_id!==device.id||job.lease!==lease)throw problem('仅原审核设备可使用原租约回填投稿。',409);
  if(job.status!=='done'||!job.result_id||!job.artifact_version_id)throw problem('需要已经完成且锁定成品版本的独立 AI 审核。',409);
  if(job.input_hash!==uploadHash)throw problem('Agent 声明的投稿 HTML SHA-256 与原审核文件不一致。',409);
  const existing=await DB.prepare('SELECT * FROM creation_review_submissions WHERE task_id=?').bind(id).first();
  const prior=await DB.prepare('SELECT * FROM creator_feedback_links WHERE task_id=?').bind(id).first();
  const sameIds=(row:any)=>row.known_work_id===workId&&row.known_submission_id===versionId;
  if(existing&&(!sameIds(existing)||existing.upload_hash!==uploadHash||existing.device_id!==device.id)||prior&&!sameIds(prior)||
    await DB.prepare('SELECT 1 FROM review_human_reviews WHERE job_id=? AND work_id IS NOT NULL AND (work_id<>? OR version_id<>?) LIMIT 1').bind(id,workId,versionId).first())throw problem('原任务已有不同的准确投稿，不能换绑。',409);
  if(!feedbackEnabled(env))throw problem('回流未启用或尚未配置专用凭据。',503);

  const credentialHash=await digest(env.CREATOR_FEEDBACK_TOKEN!);
  const pilot=await requirePilotAuthor(DB,device.owner_id,credentialHash);
  const sequence=existing&&prior?await cachedFeedbackVersionSequence(DB,prior.game_id,pilot.authorId,prior.version_id):null;
  const source=sequence===null?await verifyFeedbackAuthorVersion(env,credentialHash,workId,versionId):{
    workId:prior.game_id,versionId:prior.version_id,authorId:pilot.authorId,sequence,generation:pilot.generation,scopeRevision:pilot.scopeRevision,
  };
  if(pilot.authorId!==source.authorId||pilot.generation!==source.generation||pilot.scopeRevision!==source.scopeRevision||
    prior&&(prior.game_id!==source.workId||prior.version_id!==source.versionId))throw problem('无法核对原任务、Creator 作者与准确投稿版本。',409);

  // All mutable authorization is checked again with the writes after the
  // upstream await. The cache sequence also fences concurrent source updates.
  const now=stamp();
  const guard=`FROM review_jobs j JOIN review_devices d ON d.id=j.worker_id AND d.owner_id=j.owner_id
    JOIN members m ON m.id=j.owner_id JOIN review_pilot_members p ON p.member_id=m.id
    JOIN creator_feedback_state f ON f.id=1 JOIN creator_feedback_games anchor ON anchor.game_id=p.work_id
    JOIN creator_feedback_games target ON target.game_id=?
    WHERE j.id=? AND j.owner_id=? AND j.lease=? AND j.artifact_version_id=? AND j.input_hash=? AND j.status='done' AND j.owner_hidden=0
    AND j.executor='device' AND j.model_executor='agent' AND j.result_id IS NOT NULL
    AND d.id=? AND d.revoked=0 AND d.token_hash=? AND d.expires_at>? AND d.session_version=? AND m.enabled=1 AND m.can_review=1 AND CAST(m.session_version AS TEXT)=d.session_version
    AND f.generation=? AND f.scope_revision=? AND f.credential_hash=? AND f.phase='delta' AND f.status NOT IN ('disabled','auth_revoked')
    AND p.binding_status='linked' AND p.source_author_id=? AND p.revision=? AND p.source_generation=f.generation AND p.scope_revision=f.scope_revision
    AND anchor.last_sequence=? AND target.last_sequence=?
    AND NOT EXISTS(SELECT 1 FROM review_human_reviews h WHERE h.job_id=j.id AND h.work_id IS NOT NULL AND (h.work_id<>? OR h.version_id<>?))
    AND NOT EXISTS(SELECT 1 FROM creator_feedback_links l WHERE l.task_id=j.id AND
      (l.owner_id<>j.owner_id OR l.known_work_id<>? OR l.known_submission_id<>? OR l.game_id<>? OR l.version_id<>? OR l.scope_revision<>f.scope_revision))`;
  const params=[source.workId,id,device.owner_id,lease,job.artifact_version_id,uploadHash,device.id,device.token_hash,now,device.session_version,
    source.generation,source.scopeRevision,credentialHash,source.authorId,pilot.revision,pilot.sequence,source.sequence,workId,versionId,workId,versionId,source.workId,source.versionId];
  const claim=`EXISTS(SELECT 1 FROM creation_review_submissions s WHERE s.task_id=j.id AND s.device_id=? AND s.known_work_id=? AND s.known_submission_id=? AND s.upload_hash=? AND s.provenance=?)`;
  const claimParams=[device.id,workId,versionId,uploadHash,provenance];
  await DB.batch([
    DB.prepare(`INSERT INTO creation_review_submissions(task_id,device_id,known_work_id,known_submission_id,upload_hash,provenance,created_at)
      SELECT j.id,?,?,?,?,?,? ${guard} ON CONFLICT(task_id) DO NOTHING`).bind(...claimParams,now,...params),
    DB.prepare(`INSERT INTO creator_feedback_links(task_id,owner_id,game_id,version_id,known_work_id,known_submission_id,matched_by,scope_revision,created_at)
      SELECT j.id,j.owner_id,?,?,?,?,'published-record',f.scope_revision,? ${guard} AND ${claim} ON CONFLICT(task_id) DO NOTHING`)
      .bind(source.workId,source.versionId,workId,versionId,now,...params,...claimParams),
  ]);
  const saved=await DB.prepare(`SELECT 1 ${guard} AND ${claim} AND EXISTS(SELECT 1 FROM creator_feedback_links WHERE task_id=j.id)`).bind(...params,...claimParams).first();
  if(!saved)throw problem('原租约、投稿绑定或来源授权已变化，请使用原记录重试。',409);
  // The provider contract has no independently attested HTML digest.
  return {ok:true,jobId:id,artifactVersionId:job.artifact_version_id,sourceIdentityVerified:true,fileVerification:'agent-declared',strictEligible:false};
}
