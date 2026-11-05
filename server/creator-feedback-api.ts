import {authorized} from './settings';
import {digest} from './review-device-state';
import {CreatorFeedbackClient,FeedbackProviderError} from './creator-feedback-client';
import {readFeedbackStatus,readFeedbackGame,readFeedbackRules,readFeedbackReviewHistory,readFeedbackContract,purgeFeedbackData} from './creator-feedback-sync';
import {derivePlatformDecision,deriveAiDecision} from './review-evaluation';
import {parseFeedbackDeclaration,readFeedbackAssessment,saveFeedbackAssessment,measureFeedbackFile} from './creator-feedback-assessment';
import {feedbackEnabled,scheduleCreatorFeedback,type CreatorFeedbackEnv} from './creator-feedback-runner';

type Env=CreatorFeedbackEnv&{ADMIN_PASSWORD:string;SETTINGS_KEY:string};
const prefix='/api/admin/creator-feedback';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const err=(message:string,status=400)=>Object.assign(new Error(message),{status});
const external=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);
async function body(request:Request){
  if(!request.headers.get('Content-Type')?.includes('application/json'))throw err('请使用 JSON。',415);
  if(Number(request.headers.get('Content-Length')||0)>4096)throw err('请求过大。',413);
  const reader=request.body?.getReader();if(!reader)throw err('请求为空。');
  let text='',bytes=0;const decoder=new TextDecoder();
  try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>4096){await reader.cancel();throw err('请求过大。',413);}text+=decoder.decode(r.value,{stream:true});}text+=decoder.decode();}
  finally{reader.releaseLock();}
  try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw err('请求不是 JSON 对象。');}
}
async function ready(env:Env){
  if(!feedbackEnabled(env))throw err('回流未启用或尚未配置专用凭据。',503);
  const row=await env.DB.prepare('SELECT * FROM creator_feedback_state WHERE id=1').first();
  if(!row||row.status==='auth_revoked'||row.credential_hash!==await digest(env.CREATOR_FEEDBACK_TOKEN!))throw err('回流需要重新验证授权并同步。',409);
  return row;
}
async function sameGeneration(env:Env,before:any,gameId?:string){
  const current=await ready(env);
  if(current.generation!==before.generation||current.scope_revision!==before.scope_revision)throw err('同步授权发生变化，请重新读取。',409);
  if(gameId&&!await env.DB.prepare('SELECT game_id FROM creator_feedback_games WHERE game_id=?').bind(gameId).first())throw err('作品已移出授权缓存。',404);
}

// Administrator-only research cache. Never write source opinions into model
// material, legacy human-review rows, or gallery publication hooks.
export async function creatorFeedbackAdminApi(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url);let observedGeneration:number|undefined;
  if(url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))return null;
  try{
    if(request.headers.has('Authorization')||!await authorized(request.headers.get('Cookie'),env))throw err('仅超级管理员可读取回流数据。',403);
    if(request.method!=='GET'&&request.headers.get('Origin')!==url.origin)throw err('请求来源不匹配。',403);
    const route=url.pathname.slice(prefix.length)||'/status';
    if(route==='/status'&&request.method==='GET')return json({enabled:env.CREATOR_FEEDBACK_ENABLED==='true',configured:!!env.CREATOR_FEEDBACK_TOKEN?.trim(),source:'creator-hub-feedback-v1',...await readFeedbackStatus(env.DB)});
    if(route==='/sync'&&request.method==='POST'){
      if(!feedbackEnabled(env))throw err('回流未启用或尚未配置专用凭据。',503);
      return json(await scheduleCreatorFeedback(env),202);
    }
    const state=await ready(env);observedGeneration=state.generation;
    if(route==='/links'&&request.method==='GET'){
      const after=url.searchParams.get('after')||'',limit=Number(url.searchParams.get('limit')||'20');
      if(after&&!external(after)||!Number.isInteger(limit)||limit<1||limit>50)throw err('分页参数不正确。');
      const rows=(await env.DB.prepare(`SELECT l.task_id AS jobId,l.owner_id AS ownerId,l.game_id AS workId,l.version_id AS versionId,l.matched_by AS matchedBy,l.created_at AS linkedAt,j.artifact_version_id AS artifactVersionId,
        j.title,j.status AS taskStatus,j.model_executor AS modelExecutor,COALESCE(m.display_name,CASE WHEN l.owner_id='admin' THEN '超级管理员' ELSE '成员' END) AS ownerName,
        (SELECT json_extract(a.payload,'$.declaration.status') FROM creator_feedback_assessments a WHERE a.task_id=l.task_id AND a.kind='declaration' AND a.generation=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1) AS verificationStatus,
        (SELECT COUNT(*) FROM creator_feedback_assessments a WHERE a.task_id=l.task_id AND a.kind='file' AND a.generation=?) AS measuredFiles
        FROM creator_feedback_links l JOIN review_jobs j ON j.id=l.task_id AND j.owner_id=l.owner_id JOIN creator_feedback_games g ON g.game_id=l.game_id LEFT JOIN members m ON m.id=l.owner_id
        WHERE l.task_id>? AND l.scope_revision=? ORDER BY l.task_id LIMIT ?`).bind(state.generation,state.generation,after,state.scope_revision,limit+1).all()).results||[];
      await sameGeneration(env,state);const items=rows.slice(0,limit).map((r:any)=>({...r,verificationStatus:r.verificationStatus||'unverified',strictEligible:false}));
      return json({generation:state.generation,scopeRevision:state.scope_revision,complete:state.phase==='delta',items,nextAfter:rows.length>limit?items.at(-1)?.jobId:null});
    }
    if(route==='/assessment'&&request.method==='POST'){
      const b=parseFeedbackDeclaration(await body(request));
      const saved=await saveFeedbackAssessment(env.DB,state,b.jobId,b.requestId,b.generation,'declaration',{declaration:b.declaration});
      const assessment=await readFeedbackAssessment(env.DB,b.jobId,state);await sameGeneration(env,state,saved.workId);return json({saved,assessment});
    }
    if(route==='/file-evidence'&&request.method==='POST'){
      const jobId=url.searchParams.get('jobId'),requestId=url.searchParams.get('requestId'),generationRaw=url.searchParams.get('generation'),generation=Number(generationRaw);
      if(!external(jobId)||!requestId||!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(requestId)||!generationRaw||!/^(0|[1-9]\d*)$/.test(generationRaw)||!Number.isSafeInteger(generation))throw err('文件核验任务、请求或授权代次不正确。',400);
      if(generation!==state.generation)throw err('授权已变化，请重新读取后核验。',409);
      const job=await env.DB.prepare('SELECT j.input_hash FROM review_jobs j JOIN creator_feedback_links l ON l.task_id=j.id AND l.owner_id=j.owner_id WHERE j.id=?').bind(jobId).first();if(!job)throw err('请先建立准确投稿关联。',404);
      const file=await measureFeedbackFile(request,job.input_hash??null);
      const saved=await saveFeedbackAssessment(env.DB,state,jobId!,requestId,generation,'file',{file});const assessment=await readFeedbackAssessment(env.DB,jobId!,state);await sameGeneration(env,state,saved.workId);
      return json({saved,assessment});
    }
    if(route==='/assessment'&&request.method==='GET'){
      const jobId=url.searchParams.get('jobId');if(!external(jobId))throw err('任务编号不正确。');
      const link=await env.DB.prepare('SELECT game_id FROM creator_feedback_links WHERE task_id=?').bind(jobId).first();if(!link)throw err('尚未建立准确投稿关联。',404);
      const assessment=await readFeedbackAssessment(env.DB,jobId!,state);await sameGeneration(env,state,link.game_id);return json({generation:state.generation,assessment});
    }
    if(route==='/contract'&&request.method==='GET'){
      const contract=await readFeedbackContract(env.DB);await sameGeneration(env,state);return json({generation:state.generation,contract});
    }
    if(route==='/games'&&request.method==='GET'){
      const after=url.searchParams.get('after')||'',limit=Number(url.searchParams.get('limit')||'20');
      if(after&&!/^game_[A-Za-z0-9_-]{1,150}$/.test(after)||!Number.isInteger(limit)||limit<1||limit>50)throw err('分页参数不正确。');
      const rows=(await env.DB.prepare('SELECT game_id,last_sequence FROM creator_feedback_games WHERE game_id>? ORDER BY game_id LIMIT ?').bind(after,limit+1).all()).results;
      const games=rows.slice(0,limit);
      await sameGeneration(env,state);
      return json({generation:state.generation,phase:state.phase,complete:state.phase==='delta',games,nextAfter:rows.length>limit?games.at(-1)?.game_id:null,representation:'Current cache, not a frozen evaluation export.'});
    }
    if(route==='/game'&&request.method==='GET'){
      const id=url.searchParams.get('id');if(!id||!/^game_[A-Za-z0-9_-]{1,150}$/.test(id))throw err('作品编号不正确。');
      const game=await readFeedbackGame(env.DB,id);if(!game)throw err('授权缓存中没有该作品。',404);
      const reviewHistory=await readFeedbackReviewHistory(env.DB,id);await sameGeneration(env,state,id);
      return json({generation:state.generation,complete:state.phase==='delta',game,reviewHistory});
    }
    if(route==='/rules'&&request.method==='GET'){
      const rules=await readFeedbackRules(env.DB);await sameGeneration(env,state);return json({generation:state.generation,published:false,rules});
    }
    if(route==='/link'&&request.method==='POST'){
      const b=await body(request);
      if(Object.keys(b).some(k=>!['jobId','workId','versionId','matchedBy'].includes(k))||!external(b.jobId)||!external(b.workId)||!external(b.versionId)||!['user-confirmed','published-record'].includes(b.matchedBy))throw err('需要原任务、准确作品和投稿版本及关联依据。');
      const job=await env.DB.prepare('SELECT id,owner_id,artifact_version_id FROM review_jobs WHERE id=?').bind(b.jobId).first();if(!job)throw err('原审核任务不存在。',404);
      if(job.artifact_version_id)throw err('成品版本审核由原审核设备回填实际投稿记录。',409);
      const prior=(await env.DB.prepare('SELECT work_id,version_id FROM review_human_reviews WHERE job_id=? AND work_id IS NOT NULL').bind(job.id).all()).results;
      if(prior.some((p:any)=>p.work_id!==b.workId||p.version_id!==b.versionId))throw err('原任务已有不同的准确投稿关联，不能换绑。',409);
      const old=await env.DB.prepare('SELECT * FROM creator_feedback_links WHERE task_id=?').bind(job.id).first();
      if(old&&(old.known_work_id!==b.workId||old.known_submission_id!==b.versionId))throw err('回流关联已固定，不能换绑。',409);
      const client=new CreatorFeedbackClient(env.CREATOR_FEEDBACK_TOKEN!);
      const contract=await client.contract();if(contract.scopeRevision!==state.scope_revision)throw new FeedbackProviderError('http_error',409);
      const identity=await client.identity(b.versionId),game=await client.game(b.workId);
      if(identity.workId!==game.id||!game.versions.some(v=>v.id===identity.id))throw err('准确投稿版本与作品不匹配。',409);
      const existing=await readFeedbackGame(env.DB,game.id);
      if(!existing||!existing.versions.some((v:any)=>v.id===identity.id))throw err('该准确版本尚未同步，请完成同步后关联。',409);
      await env.DB.prepare(`INSERT INTO creator_feedback_links(task_id,owner_id,game_id,version_id,known_work_id,known_submission_id,matched_by,scope_revision,created_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM creator_feedback_state WHERE id=1 AND generation=? AND scope_revision=? AND credential_hash=? AND status<>'auth_revoked')
        AND EXISTS(SELECT 1 FROM creator_feedback_games WHERE game_id=?)
        ON CONFLICT(task_id) DO NOTHING`).bind(job.id,job.owner_id,game.id,identity.id,b.workId,b.versionId,b.matchedBy,state.scope_revision,new Date().toISOString(),state.generation,state.scope_revision,state.credential_hash,game.id).run();
      const saved=await env.DB.prepare('SELECT * FROM creator_feedback_links WHERE task_id=?').bind(job.id).first();
      if(!saved||saved.game_id!==game.id||saved.version_id!==identity.id)throw err('同步授权或关联发生变化，请重新核对。',409);
      await sameGeneration(env,state,game.id);
      return json({linked:true,jobId:job.id,workId:game.id,versionId:identity.id,matchedBy:saved.matched_by});
    }
    if((route==='/job'||route==='/export')&&request.method==='GET'){
      const jobId=url.searchParams.get('jobId');if(!external(jobId))throw err('任务编号不正确。');
      const link=await env.DB.prepare('SELECT * FROM creator_feedback_links WHERE task_id=?').bind(jobId).first();if(!link)throw err('尚未建立准确投稿关联。',404);
      const game=await readFeedbackGame(env.DB,link.game_id),version=game?.versions.find((v:any)=>v.id===link.version_id);
      if(!version)throw err('该关联版本已不在授权缓存中。',404);
      const ai=await env.DB.prepare('SELECT score,result,model FROM reviews WHERE job_id=? AND owner_id=?').bind(jobId,link.owner_id).first();
      const result=ai?JSON.parse(ai.result):null;
      const task=await env.DB.prepare('SELECT title,input_hash,model_executor,rules_snapshot,artifact_version_id FROM review_jobs WHERE id=? AND owner_id=?').bind(jobId,link.owner_id).first();
      const declaration=task?.artifact_version_id?await env.DB.prepare(`SELECT upload_hash,provenance,created_at FROM creation_review_submissions
        WHERE task_id=? AND known_work_id=? AND known_submission_id=?`).bind(jobId,link.known_work_id,link.known_submission_id).first():null;
      const creation=declaration?{artifactVersionId:task.artifact_version_id,uploadHash:declaration.upload_hash,provenance:declaration.provenance,recordedAt:declaration.created_at,
        sourceIdentityVerified:true,fileVerification:'agent-declared',strictEligible:false}:null;
      const reviewHistory=(await readFeedbackReviewHistory(env.DB,game.id)).filter((r:any)=>r.versionId===version.id);
      const assessment=await readFeedbackAssessment(env.DB,jobId!,state),platform=derivePlatformDecision(game,version.id),aiDecision=deriveAiDecision(result);
      const decidingReview=platform.state==='valid'?game.reviews.filter((r:any)=>r.id===platform.reviewId&&r.versionId===version.id)
        .sort((a:any,b:any)=>b.revision-a.revision)[0]:null;
      const differences=scoreDifferences(result,decidingReview);
      await sameGeneration(env,state,game.id);
      const value={jobId,ownerId:link.owner_id,title:task?.title??'',generation:state.generation,scopeRevision:state.scope_revision,workId:game.id,versionId:version.id,source:'creator-hub-feedback-v1',complete:state.phase==='delta',matchedBy:link.matched_by,
        inputHash:task?.input_hash??null,aiRules:task?.rules_snapshot?JSON.parse(task.rules_snapshot):null,version,reviews:game.reviews.filter((r:any)=>r.versionId===version.id),reviewHistory,creation,
        ai:ai?{score:ai.score,model:ai.model,executor:task?.model_executor??null,dimensions:{aes:result.aes,ease:result.ease,play:result.play},decision:aiDecision,report:result}:null,
        platform,comparison:{state:aiDecision&&platform.state==='valid'?(aiDecision===platform.decision?'match':'different'):'unavailable',scoreDifferences:differences,
          totals:{ai:ai?.score??null,platform:decidingReview?.total??null},decidingReviewRevision:decidingReview?.revision??null},assessment,
        interpretation:'独立来源判断；组长退回可以是平台有效结论，阶段不等于终审。关联声明和本地文件测量不能证明来源文件绑定，意见不自动视为已复现缺陷。'};
      const response=json(route==='/export'?{schemaVersion:1,exportedAt:new Date().toISOString(),...value}:value);
      if(route==='/export')response.headers.set('Content-Disposition','attachment; filename="creator-feedback-'+jobId+'.json"');return response;
    }
    throw err('接口不存在或方法不支持。',404);
  }catch(error){
    if(error instanceof FeedbackProviderError){
      if((error.status===401||error.status===409)&&observedGeneration!==undefined)await purgeFeedbackData(env.DB,{halt:error.status===401,expectedGeneration:observedGeneration}).catch(()=>{});
      return json({error:'来源接口暂不可用，未改写审核报告。',code:error.code},error.status===401||error.status===409?409:502);
    }
    const code=(error as any)?.status;
    return json({error:typeof code==='number'&&code>=400&&code<500?(error as Error).message:'回流服务暂不可用。'},typeof code==='number'?code:500);
  }
}

function scoreDifferences(result:any,review:any){
  const dimensions=[['aes','美学'],['ease','易玩性'],['play','可玩性']];
  return dimensions.map(([key,name])=>{const matches=review?.scores?.filter((s:any)=>s.name===name)||[];const ai=typeof result?.[key]==='number'?result[key]:null;
    const platform=matches.length===1&&typeof matches[0].score==='number'?matches[0].score:null;
    const platformMax=matches.length===1&&typeof matches[0].max==='number'?matches[0].max:null;
    return {dimension:key,name,ai,platform,platformMax,delta:ai!==null&&platform!==null&&platformMax===3?ai-platform:null};});
}
