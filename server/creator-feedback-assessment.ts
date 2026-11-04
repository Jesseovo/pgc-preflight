import {canonicalJson,digest} from './review-device-state';

export type FeedbackAssessmentStatus='unverified'|'declared'|'excluded';
export interface FeedbackDeclaration {
 status:FeedbackAssessmentStatus; note:string;
 fileRelation:'unknown'|'same-bytes'|'transformed'; sourceArtifactHash:string|null;
 ruleRelation:'unknown'|'admin-inspected'; sourceRuleId:string|number|null; pgcRuleId:string|null; reference:string;
}
export interface FeedbackMeasuredFile {
 sha256:string;bytes:number;inputHash:string|null;inputHashMatches:boolean|null;
 origin:'admin-upload';sourceBindingVerified:false;
}
export interface FeedbackAssessmentRecord {
 id:string;requestId:string;jobId:string;workId:string;versionId:string;kind:'declaration'|'file';generation:number;scopeRevision:number;
 createdAt:string;declaration?:FeedbackDeclaration;file?:FeedbackMeasuredFile;
 provenance:'admin-declaration'|'measured-file';strictEligible:false;
}
export interface FeedbackAssessmentSummary {
 status:FeedbackAssessmentStatus;strictEligible:false;gaps:string[];
 latestDeclaration:FeedbackAssessmentRecord|null;files:FeedbackAssessmentRecord[];history:FeedbackAssessmentRecord[];
}
export interface FeedbackAssessmentFence {generation:number;scope_revision:number;credential_hash:string}
const problem=(message:string,status=400)=>Object.assign(new Error(message),{status});
const uuid=(s:unknown)=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const sha=(s:unknown)=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
function text(v:unknown,max:number){if(typeof v!=='string'||v.length>max)throw problem('核验文字格式或长度不正确。');return v;}
export function parseFeedbackDeclaration(b:any):{jobId:string;requestId:string;generation:number;declaration:FeedbackDeclaration}{
 const allowed=['jobId','requestId','generation','status','note','fileRelation','sourceArtifactHash','ruleRelation','sourceRuleId','pgcRuleId','reference'];
 if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!allowed.includes(k)))throw problem('核验声明包含不支持的字段。');
 if(typeof b.jobId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(b.jobId)||!uuid(b.requestId)||!Number.isSafeInteger(b.generation)||b.generation<0)throw problem('核验任务、请求编号或授权代次不正确。');
 if(!['unverified','declared','excluded'].includes(b.status)||!['unknown','same-bytes','transformed'].includes(b.fileRelation)||!['unknown','admin-inspected'].includes(b.ruleRelation))throw problem('核验状态不正确；管理员声明不能自报严格核验通过。');
 if(b.sourceArtifactHash!==null&&!sha(b.sourceArtifactHash)||b.sourceRuleId!==null&&!(typeof b.sourceRuleId==='string'&&b.sourceRuleId.length<=200||Number.isSafeInteger(b.sourceRuleId)&&b.sourceRuleId>=0)||b.pgcRuleId!==null&&!(typeof b.pgcRuleId==='string'&&b.pgcRuleId.length<=200))throw problem('文件摘要或规则编号不正确。');
 const declaration:FeedbackDeclaration={status:b.status,note:text(b.note,2000),fileRelation:b.fileRelation,sourceArtifactHash:b.sourceArtifactHash,ruleRelation:b.ruleRelation,sourceRuleId:b.sourceRuleId,pgcRuleId:b.pgcRuleId,reference:text(b.reference,500)};
 if(b.status!=='unverified'&&!declaration.note.trim())throw problem('请写明管理员核对或排除依据。');
 return {jobId:b.jobId,requestId:b.requestId,generation:b.generation,declaration};
}
function record(row:any):FeedbackAssessmentRecord{
 const payload=JSON.parse(row.payload);
 return {id:row.id,requestId:row.request_id,jobId:row.task_id,workId:row.game_id,versionId:row.version_id,kind:row.kind,generation:row.generation,scopeRevision:row.scope_revision,createdAt:row.created_at,...payload,provenance:row.kind==='file'?'measured-file':'admin-declaration',strictEligible:false};
}
export async function readFeedbackAssessment(DB:any,jobId:string,fence:FeedbackAssessmentFence):Promise<FeedbackAssessmentSummary>{
 const rows=(await DB.prepare(`SELECT a.* FROM creator_feedback_assessments a
 JOIN creator_feedback_links l ON l.task_id=a.task_id AND l.game_id=a.game_id AND l.version_id=a.version_id AND l.owner_id=a.owner_id AND l.created_at=a.link_created_at
 JOIN creator_feedback_state s ON s.id=1 AND s.generation=a.generation AND s.scope_revision=a.scope_revision
 WHERE a.task_id=? AND a.generation=? AND s.credential_hash=? AND s.status<>'auth_revoked'
 ORDER BY a.created_at DESC,a.rowid DESC LIMIT 100`).bind(jobId,fence.generation,fence.credential_hash).all()).results||[];
 const history=rows.map(record),latestDeclaration=history.find((r:FeedbackAssessmentRecord)=>r.kind==='declaration')||null;
 const files=history.filter((r:FeedbackAssessmentRecord)=>r.kind==='file');
 const gaps=['缺少来源站可独立验证的投稿归属与文件绑定凭证。','缺少已核验的来源规则与本次 AI 锁定规则对应证据。'];
 if(!files.length)gaps.unshift('尚无实际文件字节核验记录。');
 if(files.some((r:FeedbackAssessmentRecord)=>r.file?.inputHashMatches===false))gaps.unshift('上传文件字节与原审核输入摘要不一致；转换关系尚未核验。');
 return {status:latestDeclaration?.declaration?.status||'unverified',strictEligible:false,gaps,latestDeclaration,files,history};
}
export async function saveFeedbackAssessment(DB:any,fence:FeedbackAssessmentFence,jobId:string,requestId:string,generation:number,kind:'declaration'|'file',value:{declaration?:FeedbackDeclaration;file?:FeedbackMeasuredFile}){
 if(generation!==fence.generation)throw problem('授权已变化，请重新读取后核验。',409);
 const link=await DB.prepare('SELECT l.*,j.input_hash FROM creator_feedback_links l JOIN review_jobs j ON j.id=l.task_id AND j.owner_id=l.owner_id WHERE l.task_id=?').bind(jobId).first();
 if(!link)throw problem('请先建立准确投稿关联。',404);
 const payload=canonicalJson(value),hash=await digest(payload),id=crypto.randomUUID(),at=new Date().toISOString();
 await DB.prepare(`INSERT OR IGNORE INTO creator_feedback_assessments(id,task_id,request_id,owner_id,game_id,version_id,generation,scope_revision,link_created_at,kind,payload,payload_hash,created_at)
 SELECT ?,l.task_id,?,l.owner_id,l.game_id,l.version_id,?,?,l.created_at,?,?,?,?
 FROM creator_feedback_links l JOIN review_jobs j ON j.id=l.task_id AND j.owner_id=l.owner_id JOIN creator_feedback_games g ON g.game_id=l.game_id
 JOIN creator_feedback_state s ON s.id=1 AND s.generation=? AND s.scope_revision=? AND s.credential_hash=? AND s.status<>'auth_revoked'
 WHERE l.task_id=? AND l.game_id=? AND l.version_id=? AND l.created_at=? AND l.scope_revision=s.scope_revision`)
 .bind(id,requestId,fence.generation,fence.scope_revision,kind,payload,hash,at,fence.generation,fence.scope_revision,fence.credential_hash,jobId,link.game_id,link.version_id,link.created_at).run();
 const saved=await DB.prepare('SELECT * FROM creator_feedback_assessments WHERE task_id=? AND request_id=? AND generation=?').bind(jobId,requestId,fence.generation).first();
 if(!saved)throw problem('授权或准确版本关联已变化，未保存核验。',409);
 if(saved.kind!==kind||saved.payload_hash!==hash)throw problem('同一核验请求不能更换内容。',409);
 return record(saved);
}
export async function measureFeedbackFile(request:Request,inputHash:string|null):Promise<FeedbackMeasuredFile>{
 if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/octet-stream')throw problem('请上传原始文件字节。',415);
 const cap=8*1024*1024;if(Number(request.headers.get('Content-Length')||0)>cap)throw problem('文件不能超过 8 MB。',413);
 const reader=request.body?.getReader();if(!reader)throw problem('没有文件内容。');
 const chunks:Uint8Array[]=[];let count=0;
 try{while(true){const r=await reader.read();if(r.done)break;count+=r.value.byteLength;if(count>cap){await reader.cancel();throw problem('文件不能超过 8 MB。',413);}chunks.push(r.value);}}finally{reader.releaseLock();}
 if(!count)throw problem('文件内容为空。');
 const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
 return {sha256,bytes:count,inputHash,inputHashMatches:inputHash?sha256===inputHash:null,origin:'admin-upload',sourceBindingVerified:false};
}
