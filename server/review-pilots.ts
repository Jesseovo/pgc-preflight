import {authorized,type AppSecrets} from './settings';
import {canonicalJson,digest,problem} from './review-device-state';
import {CreatorFeedbackClient,FeedbackProviderError,type FeedbackGame} from './creator-feedback-client';
import {purgeFeedbackData} from './creator-feedback-sync';
import {feedbackEnabled,type CreatorFeedbackEnv} from './creator-feedback-runner';

type Env=CreatorFeedbackEnv&AppSecrets;
type Action='member'|'link'|'unlink';
const prefix='/api/admin/review-pilots';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sourceId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,240}$/.test(value);
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export interface PilotMember {
  memberId:string;displayName:string;username:string;accountEnabled:boolean;pilotEnabled:boolean;
  creatorAccount:string;revision:number;enrollmentStartedAt:string|null;updatedAt:string|null;
  binding:{status:'unlinked'|'declared'|'linked'|'stale';sourceAuthorId:string|null;workId:string|null;versionId:string|null;verifiedAt:string|null};
}
interface PilotRow {
  memberId:string;displayName:string;username:string;accountEnabled:number;pilot_enabled:number|null;
  creator_account:string|null;revision:number|null;enrollment_started_at:string|null;updated_at:string|null;
  binding_status:'none'|'linked'|'stale'|null;source_author_id:string|null;work_id:string|null;version_id:string|null;
  verified_at:string|null;source_generation:number|null;scope_revision:number|null;
  currentGeneration:number|null;currentScope:number|null;credentialHash:string|null;sourceStatus:string|null;sourcePhase:string|null;
}
interface Binding {authorId:string;workId:string;versionId:string;generation:number;scopeRevision:number;credentialHash:string;sequence:number}
const memberColumns=`m.id AS memberId,m.display_name AS displayName,m.username,m.enabled AS accountEnabled,p.*,
  s.generation AS currentGeneration,s.scope_revision AS currentScope,s.credential_hash AS credentialHash,s.status AS sourceStatus,s.phase AS sourcePhase`;
const memberTables='members m LEFT JOIN review_pilot_members p ON p.member_id=m.id LEFT JOIN creator_feedback_state s ON s.id=1';
const emptyBinding={sourceAuthorId:null,workId:null,versionId:null,verifiedAt:null};
function view(row:PilotRow,status:PilotMember['binding']['status']):PilotMember {
  return {memberId:row.memberId,displayName:row.displayName,username:row.username,accountEnabled:!!row.accountEnabled,
    pilotEnabled:!!row.pilot_enabled,creatorAccount:row.creator_account??'',revision:row.revision??0,
    enrollmentStartedAt:row.enrollment_started_at??null,updatedAt:row.updated_at??null,
    binding:{status,...(status==='linked'?{sourceAuthorId:row.source_author_id,workId:row.work_id,versionId:row.version_id,verifiedAt:row.verified_at}:emptyBinding)}};
}
function authorizedBinding(row:PilotRow,credentialHash?:string|null){
  return row.source_generation===row.currentGeneration&&row.scope_revision===row.currentScope&&row.sourcePhase==='delta'&&
    !['disabled','auth_revoked'].includes(row.sourceStatus??'disabled')&&(credentialHash===undefined||credentialHash!==null&&credentialHash===row.credentialHash);
}
async function cachedGame(DB:any,workId:string){
  // Read the sequence and all parts in one SQL snapshot. Keep each part as
  // its own SQL value so a large game never hits D1's per-value size limit.
  const {results}=await DB.prepare(`SELECT g.last_sequence AS sequence,c.part,c.payload
    FROM creator_feedback_games g LEFT JOIN creator_feedback_chunks c
      ON c.kind='game' AND c.entity_id=g.game_id WHERE g.game_id=? ORDER BY c.part`).bind(workId).all();
  const parts=results as {sequence:number;part:number|null;payload:string|null}[];
  if(!parts.length)return null;
  let game:FeedbackGame|null=null;
  if(parts.every((part,index)=>part.part===index&&typeof part.payload==='string')){
    try{game=JSON.parse(parts.map(part=>part.payload).join(''));}catch{/* A corrupt cache cannot verify a binding. */}
  }
  return {sequence:parts[0].sequence,game};
}
function matches(game:FeedbackGame|null,workId:string,authorId:string,versionId:string){
  return game?.id===workId&&game.authorId===authorId&&game.deleted===false&&Array.isArray(game.versions)&&game.versions.some(version=>version?.id===versionId);
}
async function invalidateBinding(DB:any,row:PilotRow,cache?:{sequence:number|null}):Promise<PilotMember>{
  const cacheGuard=cache?'AND (SELECT last_sequence FROM creator_feedback_games WHERE game_id=?) IS ?':'';
  const updated=await DB.prepare(`UPDATE review_pilot_members SET binding_status='stale',source_author_id=NULL,work_id=NULL,
    version_id=NULL,verified_at=NULL,source_generation=NULL,scope_revision=NULL,revision=revision+1,updated_at=?
    WHERE member_id=? AND revision=? AND binding_status='linked' ${cacheGuard}
    AND EXISTS(SELECT 1 FROM creator_feedback_state WHERE id=1 AND generation IS ?
      AND scope_revision IS ? AND credential_hash IS ?) RETURNING revision,updated_at`)
    .bind(new Date().toISOString(),row.memberId,row.revision,...(cache?[row.work_id,cache.sequence]:[]),row.currentGeneration,row.currentScope,row.credentialHash).first();
  return view(updated?{...row,...updated}:row,'stale');
}
async function resolveView(DB:any,row:PilotRow,credentialHash?:string|null,clearInvalid=false):Promise<PilotMember>{
  if(row.binding_status!=='linked')return view(row,row.binding_status==='stale'?'stale':row.creator_account?'declared':'unlinked');
  if(!authorizedBinding(row,credentialHash)){
    const authorityLost=row.source_generation!==row.currentGeneration||row.scope_revision!==row.currentScope||
      ['disabled','auth_revoked'].includes(row.sourceStatus??'disabled')||
      credentialHash!==undefined&&(credentialHash===null||credentialHash!==row.credentialHash);
    return clearInvalid&&authorityLost?invalidateBinding(DB,row):view(row,'stale');
  }
  const cached=await cachedGame(DB,row.work_id!);
  if(matches(cached?.game??null,row.work_id!,row.source_author_id!,row.version_id!)){
    // Recheck the binding and scope after reading the separately stored JSON.
    const same=await DB.prepare(`SELECT 1 FROM review_pilot_members p JOIN creator_feedback_state s ON s.id=1
      JOIN creator_feedback_games g ON g.game_id=p.work_id WHERE p.member_id=? AND p.revision=? AND p.binding_status='linked'
      AND p.source_generation=s.generation AND p.scope_revision=s.scope_revision AND s.phase='delta'
      AND s.status NOT IN ('disabled','auth_revoked') AND s.credential_hash IS ? AND g.last_sequence=?`)
      .bind(row.memberId,row.revision,row.credentialHash,cached!.sequence).first();
    return view(row,same?'linked':'stale');
  }
  return clearInvalid?invalidateBinding(DB,row,{sequence:cached?.sequence??null}):view(row,'stale');
}
/** Read-only metadata for controlled local research. Account flags are independent. */
export async function readPilotMembers(DB:any):Promise<PilotMember[]>{
  const rows=(await DB.prepare(`SELECT ${memberColumns} FROM ${memberTables} ORDER BY m.display_name,m.id`).all()).results as PilotRow[];
  return Promise.all(rows.map(row=>resolveView(DB,row)));
}
async function readRow(DB:any,memberId:string):Promise<PilotRow>{
  const row=await DB.prepare(`SELECT ${memberColumns} FROM ${memberTables} WHERE m.id=?`).bind(memberId).first();
  if(!row)throw problem('成员不存在。',404);
  return row;
}
async function body(request:Request):Promise<Record<string,unknown>>{
  if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw problem('请使用 JSON。',415);
  if(Number(request.headers.get('Content-Length')||0)>4096)throw problem('请求过大。',413);
  const reader=request.body?.getReader();
  if(!reader)throw problem('请求为空。');
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let text='',bytes=0;
  try{
    while(true){
      const part=await reader.read();if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>4096){await reader.cancel().catch(()=>{});throw problem('请求过大。',413);}
      text+=decoder.decode(part.value,{stream:true});
    }
    const value=JSON.parse(text+decoder.decode());
    if(!value||typeof value!=='object'||Array.isArray(value))throw problem('请求不是 JSON 对象。');
    return value;
  }catch(error){if((error as any)?.status===413)throw error;throw problem('请求不是有效 JSON 对象。');}
  finally{reader.releaseLock();}
}
function parse(action:Action,input:Record<string,unknown>){
  const allowed=['memberId','expectedRevision','requestId',...(action==='member'?['pilotEnabled','creatorAccount']:action==='link'?['workId','versionId','ownershipConfirmed']:[])];
  const {memberId,expectedRevision,requestId}=input;
  if(Object.keys(input).some(key=>!allowed.includes(key))||!sourceId(memberId)||typeof requestId!=='string'||!uuid.test(requestId)||
    !Number.isSafeInteger(expectedRevision)||Number(expectedRevision)<0||Number(expectedRevision)>=Number.MAX_SAFE_INTEGER)throw problem('成员、修订号或请求编号不正确。');
  const common={memberId,expectedRevision:Number(expectedRevision),requestId:requestId.toLowerCase()};
  if(action==='member'){
    if(typeof input.pilotEnabled!=='boolean'||typeof input.creatorAccount!=='string')throw problem('灰测状态或账号声明不正确。');
    const creatorAccount=input.creatorAccount.trim();
    if(creatorAccount.length>120||/[\x00-\x1f\x7f]/.test(creatorAccount))throw problem('Creator 账号声明最多 120 个字符，不能包含控制字符。');
    return {...common,pilotEnabled:input.pilotEnabled,creatorAccount};
  }
  if(action==='link'){
    if(!sourceId(input.workId)||!sourceId(input.versionId)||input.ownershipConfirmed!==true)throw problem('需要准确作品、投稿版本及管理员归属确认。');
    return {...common,workId:input.workId,versionId:input.versionId,ownershipConfirmed:true};
  }
  return common;
}
async function verifyLink(env:Env,credentialHash:string|null,workId:string,versionId:string):Promise<Binding>{
  if(!credentialHash)throw problem('回流未启用或尚未配置专用凭据。',503);
  const state=await env.DB.prepare('SELECT generation,scope_revision,credential_hash,status,phase FROM creator_feedback_state WHERE id=1').first();
  if(!state||state.credential_hash!==credentialHash||state.phase!=='delta'||state.scope_revision===null||['disabled','auth_revoked'].includes(state.status))throw problem('请先完成当前授权的回流同步。',409);
  try{
    const client=new CreatorFeedbackClient(env.CREATOR_FEEDBACK_TOKEN!);
    const contract=await client.contract();
    if(contract.scopeRevision!==state.scope_revision)throw new FeedbackProviderError('http_error',409);
    const identity=await client.identity(versionId);
    const game=await client.game(workId);
    if(identity.workId!==game.id||!sourceId(game.authorId)||!matches(game,game.id,game.authorId,identity.id))throw problem('作品归属或准确投稿版本无法核验。',409);
    const cached=await cachedGame(env.DB,game.id);
    if(!cached||!matches(cached.game,game.id,game.authorId,identity.id))throw problem('授权缓存尚未同步同一作者与准确投稿版本。',409);
    return {authorId:game.authorId,workId:game.id,versionId:identity.id,generation:state.generation,scopeRevision:state.scope_revision,credentialHash,sequence:cached.sequence};
  }catch(error){
    if(!(error instanceof FeedbackProviderError))throw error;
    if([401,409,410].includes(error.status)){
      await purgeFeedbackData(env.DB,{halt:error.status===401,expectedGeneration:state.generation});
      throw problem('来源授权或缓存已变化，请重新同步后核验。',409);
    }
    throw problem('来源接口暂不可用，未建立关联。',502);
  }
}
async function save(DB:any,row:PilotRow,input:ReturnType<typeof parse>,action:Action,payloadHash:string,binding?:Binding){
  const now=new Date().toISOString(),mutationId=crypto.randomUUID();
  const memberId=input.memberId,expected=input.expectedRevision;
  const account='creatorAccount' in input?input.creatorAccount:row.creator_account??'';
  const pilotEnabled='pilotEnabled' in input?input.pilotEnabled:!!row.pilot_enabled;
  const enrolledAt=pilotEnabled&&!row.pilot_enabled?now:row.enrollment_started_at;
  const clear=action==='unlink'||account!==(row.creator_account??'');
  const status=binding?'linked':clear?'none':row.binding_status??'none';
  const source=binding?[binding.authorId,binding.workId,binding.versionId,now,binding.generation,binding.scopeRevision]:
    clear?[null,null,null,null,null,null]:[row.source_author_id,row.work_id,row.version_id,row.verified_at,row.source_generation,row.scope_revision];
  const sourceGuard=binding?`AND EXISTS(SELECT 1 FROM creator_feedback_state s JOIN creator_feedback_games g ON g.game_id=?
    WHERE s.id=1 AND s.generation=? AND s.scope_revision=? AND s.credential_hash=? AND s.phase='delta'
    AND s.status NOT IN ('disabled','auth_revoked') AND g.last_sequence=?)
    AND NOT EXISTS(SELECT 1 FROM review_pilot_members WHERE source_author_id=? AND member_id<>?)`:'';
  const sourceParams=binding?[binding.workId,binding.generation,binding.scopeRevision,binding.credentialHash,binding.sequence,binding.authorId,memberId]:[];
  await DB.batch([
    DB.prepare(`INSERT OR IGNORE INTO review_pilot_requests(request_id,member_id,payload_hash,mutation_id,revision,pilot_enabled,enrollment_started_at,created_at)
      SELECT ?,m.id,?,?,?,?,?,? FROM members m LEFT JOIN review_pilot_members p ON p.member_id=m.id
      WHERE m.id=? AND COALESCE(p.revision,0)=? ${sourceGuard}`)
      .bind(input.requestId,payloadHash,mutationId,expected+1,Number(pilotEnabled),enrolledAt,now,memberId,expected,...sourceParams),
    DB.prepare(`INSERT INTO review_pilot_members(member_id,pilot_enabled,creator_account,revision,enrollment_started_at,updated_at,binding_status,
      source_author_id,work_id,version_id,verified_at,source_generation,scope_revision)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM review_pilot_requests WHERE request_id=? AND mutation_id=?)
      ON CONFLICT(member_id) DO UPDATE SET pilot_enabled=excluded.pilot_enabled,creator_account=excluded.creator_account,
      revision=excluded.revision,enrollment_started_at=excluded.enrollment_started_at,updated_at=excluded.updated_at,
      binding_status=excluded.binding_status,source_author_id=excluded.source_author_id,work_id=excluded.work_id,
      version_id=excluded.version_id,verified_at=excluded.verified_at,source_generation=excluded.source_generation,scope_revision=excluded.scope_revision`)
      .bind(memberId,Number(pilotEnabled),account,expected+1,enrolledAt,now,status,...source,input.requestId,mutationId),
  ]);
  const receipt=await DB.prepare('SELECT member_id,payload_hash FROM review_pilot_requests WHERE request_id=?').bind(input.requestId).first();
  if(receipt?.member_id!==memberId||receipt.payload_hash!==payloadHash)throw problem('请求、成员修订或来源授权已变化，或该来源作者已关联其他成员。',409);
}

export async function reviewPilotsAdminApi(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url);
  if(url.pathname!==prefix&&!url.pathname.startsWith(`${prefix}/`))return null;
  try{
    if(request.headers.has('Authorization')||!await authorized(request.headers.get('Cookie'),env))throw problem('仅超级管理员可管理灰测成员。',403);
    if(request.method!=='GET'&&request.headers.get('Origin')!==url.origin)throw problem('请求来源不匹配。',403);
    if(!env.DB)throw problem('灰测成员服务尚未就绪。',503);
    const credentialHash=feedbackEnabled(env)?await digest(env.CREATOR_FEEDBACK_TOKEN!):null;
    if(url.pathname===prefix&&request.method==='GET'){
      const rows=(await env.DB.prepare(`SELECT ${memberColumns} FROM ${memberTables} ORDER BY m.display_name,m.id`).all()).results as PilotRow[];
      return json({members:await Promise.all(rows.map(row=>resolveView(env.DB,row,credentialHash,true)))});
    }
    const action=url.pathname.slice(prefix.length+1) as Action;
    if(request.method!=='POST'||!['member','link','unlink'].includes(action))throw problem('接口不存在或方法不支持。',404);
    const input=parse(action,await body(request));
    const payloadHash=await digest(canonicalJson({action,...input}));
    const receipt=await env.DB.prepare('SELECT member_id,payload_hash FROM review_pilot_requests WHERE request_id=?').bind(input.requestId).first();
    const row=await readRow(env.DB,input.memberId);
    if(receipt){
      if(receipt.member_id!==input.memberId||receipt.payload_hash!==payloadHash)throw problem('请求编号已用于其他操作。',409);
      return json({member:await resolveView(env.DB,row,credentialHash,true)});
    }
    if((row.revision??0)!==input.expectedRevision)throw problem('成员设置已变化，请刷新后重试。',409);
    if(action==='link'&&!row.creator_account?.trim())throw problem('请先保存 Creator 账号声明。',409);
    const binding='workId' in input?await verifyLink(env,credentialHash,input.workId,input.versionId):undefined;
    if(binding&&row.binding_status==='linked'&&row.source_author_id!==binding.authorId)throw problem('该成员已有不同的来源作者关联，请先解除关联。',409);
    await save(env.DB,row,input,action,payloadHash,binding);
    return json({member:await resolveView(env.DB,await readRow(env.DB,input.memberId),credentialHash,true)});
  }catch(error){
    const status=(error as any)?.status;
    return typeof status==='number'&&status>=400&&status<500||status===502||status===503
      ?json({error:(error as Error).message},status):json({error:'灰测成员服务暂不可用。'},500);
  }
}
