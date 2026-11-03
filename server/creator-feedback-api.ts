import {authorized} from './settings';
import {digest} from './review-device-state';
import {CreatorFeedbackClient,FeedbackProviderError} from './creator-feedback-client';
import {readFeedbackStatus,readFeedbackGame,readFeedbackRules,readFeedbackReviewHistory,readFeedbackContract,purgeFeedbackData} from './creator-feedback-sync';
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
      const job=await env.DB.prepare('SELECT id,owner_id FROM review_jobs WHERE id=?').bind(b.jobId).first();if(!job)throw err('原审核任务不存在。',404);
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
    if(route==='/job'&&request.method==='GET'){
      const jobId=url.searchParams.get('jobId');if(!external(jobId))throw err('任务编号不正确。');
      const link=await env.DB.prepare('SELECT * FROM creator_feedback_links WHERE task_id=?').bind(jobId).first();if(!link)throw err('尚未建立准确投稿关联。',404);
      const game=await readFeedbackGame(env.DB,link.game_id),version=game?.versions.find((v:any)=>v.id===link.version_id);
      if(!version)throw err('该关联版本已不在授权缓存中。',404);
      const ai=await env.DB.prepare('SELECT score,result,model FROM reviews WHERE job_id=? AND owner_id=?').bind(jobId,link.owner_id).first();
      const result=ai?JSON.parse(ai.result):null;
      const reviewHistory=(await readFeedbackReviewHistory(env.DB,game.id)).filter((r:any)=>r.versionId===version.id);await sameGeneration(env,state,game.id);
      return json({jobId,workId:game.id,versionId:version.id,source:'creator-hub-feedback-v1',complete:state.phase==='delta',matchedBy:link.matched_by,version,reviews:game.reviews.filter((r:any)=>r.versionId===version.id),reviewHistory,ai:ai?{score:ai.score,model:ai.model,dimensions:{aes:result.aes,ease:result.ease,play:result.play}}:null,interpretation:'Independent source judgments, not reproduced defect labels; review stage alone does not establish final approval.'});
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
