import {complete} from './forge-llm';
import {prepareArtifact,saveArtifact,ownedTopic} from './forge-workspace';
import {gameStageSystem,gameStageUser,GAME_BUILD_SCHEMA,GAME_POLISH_SCHEMA,GAME_REPAIR_SCHEMA} from './forge/prompts.js';
import {activeModelProfile,modelProfiles} from './settings';
import {memberStore} from './storage';
import {claimCreationModel} from './model-capacity';
import {captureFor} from './cloud-review-capture';
import {digest,canonicalJson,stamp,problem} from './review-device-state';
import {failForgeTask} from './forge-tasks';

type Stage='build'|'polish'|'repair';
type Checkpoint={model?:string|null;phase:string;stage:Stage;snapshot:any;config:any;output?:any;capture?:any;previous?:any;previousCapture?:any;versionId?:string;createdAt:number;stageStartedAt?:number;failure?:string};
const schemas={build:GAME_BUILD_SCHEMA,polish:GAME_POLISH_SCHEMA,repair:GAME_REPAIR_SCHEMA};
const labels={build:'完整玩法与内容',polish:'美术与交互精修',repair:'定向修复'};
const strings=(x:any,max=100)=>Array.isArray(x)&&x.length<=max&&x.every(v=>typeof v==='string'&&v.length<=12000);
const allowed=(value:any,keys:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));

// Structural/evidence validation only. No score, taste, or defect inference.
export function validateCreationOutput(value:any,stage:Stage,capture?:any,previous?:any):string[]{
  if(!allowed(value,['html','requirements','decisions','coreChanges',...(stage==='build'?[]:['selfCheck'])])||typeof value.html!=='string'||!value.html.trim())return ['html'];
  if(!Array.isArray(value.requirements)||!value.requirements.length||value.requirements.length>100||value.requirements.some((r:any)=>!allowed(r,['id','text','status','evidence','reason'])||typeof r.id!=='string'||!r.id.trim()||typeof r.text!=='string'||!r.text.trim()||!['implemented','unverified','deferred'].includes(r.status)||['evidence','reason'].some(k=>k in r&&typeof r[k]!=='string')))return ['requirements'];
  if(new Set(value.requirements.map((r:any)=>r.id)).size!==value.requirements.length)return ['requirements.id'];
  if(!strings(value.decisions)||!strings(value.coreChanges))return ['decisions/coreChanges'];
  if(stage==='build')return [];
  const requirements=new Set(value.requirements.map((r:any)=>r.id));
  if(previous?.requirements?.some((r:any)=>!requirements.has(r.id)))return ['requirements must retain prior IDs'];
  if(previous?.coreChanges?.some((change:string)=>!value.coreChanges.includes(change)))return ['coreChanges must retain prior changes'];
  const check=value.selfCheck,refs=new Set([...(capture?.shots||[]).map((s:any)=>s.id),...(capture?.probe?.actions||[]).map((a:any)=>a.id)]);
  if(!allowed(check,['findings','unverified','changes','requestRepair'])||!Array.isArray(check.findings)||check.findings.length>50||!strings(check.unverified)||!strings(check.changes)||typeof check.requestRepair!=='boolean'||stage==='repair'&&check.requestRepair)return ['selfCheck'];
  for(const f of check.findings){
    if(!allowed(f,['kind','id','phenomenon','trigger','cause','minimalChange','retest','evidenceRefs','coreChange','resolved'])||!['confirmed','experience','unverified'].includes(f.kind)||['id','phenomenon','trigger','cause','minimalChange','retest'].some(k=>typeof f[k]!=='string')||!f.id.trim()||!f.phenomenon.trim()||!strings(f.evidenceRefs,32)||f.evidenceRefs.some((r:string)=>!refs.has(r))||typeof f.coreChange!=='boolean'||typeof f.resolved!=='boolean')return ['selfCheck.findings'];
    if(f.kind!=='unverified'&&!f.evidenceRefs.length)return ['selfCheck.findings.evidenceRefs'];
  }
  if(new Set(check.findings.map((f:any)=>f.id)).size!==check.findings.length)return ['selfCheck.findings.id'];
  if(check.requestRepair&&!check.findings.some((f:any)=>f.kind==='confirmed'&&!f.resolved&&!f.coreChange&&f.evidenceRefs.length))return ['selfCheck.requestRepair requires an evidenced unresolved finding'];
  return [];
}

const imageData=/^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/;
const evidenceId=(v:any)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v);
const timestamp=(v:any)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
async function shotHash(data:string){
  const base64=imageData.exec(data)?.[1];
  if(!base64)throw problem('制作采集必须使用完整视口原图。');
  let bytes:Uint8Array;
  try{bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));}catch{throw problem('制作采集图片编码不正确。');}
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),b=>b.toString(16).padStart(2,'0')).join('');
}
const captureHash=(stage:Stage,shots:any[],probe:any,inputHash:string)=>digest(canonicalJson({stage,shots:shots.map(({data,...s}:any)=>s),probe,inputHash}));
export async function lockCreationCapture(raw:any,stage:Stage,html:string){
  const actions=raw?.probe?.actions,observations=raw?.probe?.observations;
  if(raw?.probe?.captureMethod!=='browser-viewport-v1'||!Array.isArray(raw.shots)||raw.shots.length!==4||!Array.isArray(actions)||actions.length!==3||!Array.isArray(observations)||observations.length!==4)throw problem('制作采集必须保留三个手机比例的动作记录与四张完整视口原图。');
  const actionIds=new Set(actions.map((a:any)=>a?.id)),shotIds=new Set(raw.shots.map((s:any)=>s?.id));
  const ratios=new Set(actions.map((a:any)=>a?.ratio));
  const refs=(r:any)=>Array.isArray(r)&&r.every(id=>actionIds.has(id));
  if(!['9:16','9:19.5','9:21'].every(ratio=>ratios.has(ratio))||actionIds.size!==3||shotIds.size!==4||actions.some((a:any)=>!evidenceId(a?.id)||a.type!=='tap'||!timestamp(a.startedAt))||
    raw.shots.some((s:any)=>!evidenceId(s?.id)||actionIds.has(s.id)||typeof s.label!=='string'||!timestamp(s.capturedAt)||!refs(s.actionRefs)||typeof s.data!=='string')||
    observations.some((o:any,i:number)=>o?.id!==raw.shots[i].id||!timestamp(o.capturedAt)||!refs(o.actionRefs)))throw problem('制作采集的原图编号、时间或动作关联无效。');
  const ref=(id:string)=>`${stage}:${id}`;
  const shots=await Promise.all(raw.shots.map(async({id,label,data,capturedAt,actionRefs}:any)=>({id:ref(id),label,data,capturedAt,actionRefs:actionRefs.map(ref),hash:await shotHash(data)})));
  const {loaded,errors,resources,loadErrors,note}=raw.probe;
  const probe={captureMethod:'browser-viewport-v1',loaded,errors,resources,loadErrors,note,
    actions:actions.map(({id,startedAt,ratio,type,x,y,target,count,note}:any)=>({id:ref(id),startedAt,ratio,type,x,y,target,count,note})),
    observations:observations.map(({id,label,capturedAt,actionRefs,elapsedMs,errors,title,domText,canvases,audio}:any)=>({
      id:ref(id),label,capturedAt,actionRefs:actionRefs.map(ref),elapsedMs,errors,title,domText,canvases,
      audio:audio?{contextStates:audio.contextStates,sourceStarts:audio.sourceStarts,media:audio.media,measuredListening:false}:undefined,
    }))};
  const inputHash=await digest(html),hash=await captureHash(stage,shots,probe,inputHash);
  return {stage,shots,probe,inputHash,hash,capturedAt:stamp(),origin:'isolated-chromium',listeningVerified:false};
}

async function access(env:any,row:any){
  if(row.owner_id==='admin')return;
  const member=await memberStore(env.DB).byId(row.owner_id);
  if(!member?.enabled||!member.star)throw new Error('账号已停用或 Star 权限已撤销，制作已停止。');
}
async function putCheckpoint(storage:any,cp:Checkpoint){
  const text=JSON.stringify(cp);
  await storage.transaction(async(tx:any)=>{
    const old=await tx.get('creationParts')||0,count=Math.ceil(text.length/28000);
    for(let i=0;i<count;i++)await tx.put(`creation:${i}`,text.slice(i*28000,(i+1)*28000));
    for(let i=count;i<old;i++)await tx.delete(`creation:${i}`);
    await tx.put('creationParts',count);await tx.setAlarm(Date.now()+30000);
  });
}
async function getCheckpoint(storage:any):Promise<Checkpoint|null>{
  const count=await storage.get('creationParts');if(!count)return null;
  if(!Number.isInteger(count)||count>600)throw new Error('制作检查点无效。');
  const parts=[];for(let i=0;i<count;i++){const p=await storage.get(`creation:${i}`);if(typeof p!=='string')throw new Error('制作检查点缺失。');parts.push(p);}
  return JSON.parse(parts.join(''));
}
async function progress(DB:any,id:string,phase:string,message:string,phaseStartedAt?:number){
  await DB.prepare("UPDATE forge_tasks SET phase_started_at=CASE WHEN phase IS NOT ? THEN coalesce(?,phase_started_at) ELSE phase_started_at END,phase=?,detail=?,updated_at=? WHERE id=? AND status='running'")
    .bind(phase,phaseStartedAt?new Date(phaseStartedAt).toISOString():null,phase,message,stamp(),id).run();
}

function evidenceStatements(DB:any,row:any,cp:Checkpoint,stageGuard?:{check:string;sql:string;params:any[]}){
  const text=JSON.stringify(cp.capture),parts=[];
  if(new TextEncoder().encode(text).length>2_150_000)throw problem('制作采集超过保存上限，请减小原图编码大小。',413);
  const {shots,...metadata}=cp.capture;
  const details=JSON.stringify({...metadata,shots:shots.map(({data,...s}:any)=>s)});
  if(new TextEncoder().encode(details).length>256_000)throw problem('制作采集记录超过保存上限。',413);
  const filter='WHERE task_id=? AND stage=? AND owner_id=? AND content_hash=?';
  const params=[row.id,cp.stage,row.owner_id,cp.capture.inputHash];
  parts.push(DB.prepare(`UPDATE forge_creation_stages SET evidence_hash=?,evidence=? ${filter} AND evidence_hash IS NULL ${stageGuard?`AND self_check=? AND ${stageGuard.sql}`:''}`)
    .bind(cp.capture.hash,details,...params,...(stageGuard?[stageGuard.check,...stageGuard.params]:[])));
  for(let i=0;i<text.length;){
    let end=Math.min(i+24000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
    parts.push(DB.prepare(`INSERT OR IGNORE INTO forge_creation_evidence(task_id,stage,part,content)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM forge_creation_stages ${filter} AND evidence_hash=?)`).bind(row.id,cp.stage,parts.length-1,text.slice(i,end),...params,cp.capture.hash));
    i=end;
  }
  return parts;
}

async function persistStage(DB:any,row:any,cp:Checkpoint,withEvidence=false,deviceTokenHash?:string){
  const hash=await digest(cp.output.html);
  const id=cp.versionId||crypto.randomUUID(),at=stamp(),s=cp.snapshot;
  const check={schemaVersion:2,kind:'creator-self-check',model:cp.model??activeModelProfile(cp.config,'game')?.profile.model??null,requirements:cp.output.requirements,decisions:cp.output.decisions,coreChanges:cp.output.coreChanges,selfCheck:cp.output.selfCheck||null,judgedInputHash:cp.previousCapture?.inputHash||null,judgedEvidenceHash:cp.previousCapture?.hash||null,outputHash:hash,verification:'model-claims; changed output requires independent review'};
  const checkJson=canonicalJson(check);
  if(new TextEncoder().encode(checkJson).length>512_000)throw problem('制作记录超过保存上限。',413);
  const liveDevice=row.executor==='agent'?`AND EXISTS(SELECT 1 FROM forge_agents d JOIN members m ON m.id=d.owner_id
    WHERE d.id=forge_tasks.device_id AND d.owner_id=forge_tasks.owner_id AND d.revoked=0 AND d.expires_at>? AND m.enabled=1 AND m.session_version=d.session_version${deviceTokenHash?' AND d.token_hash=?':''})` : '';
  const liveTask=`EXISTS(SELECT 1 FROM forge_tasks WHERE id=? AND owner_id=? AND executor=? AND status='running' AND device_id IS ? AND receipt_hash IS ? ${liveDevice})`;
  const liveParams=[row.id,row.owner_id,row.executor,row.device_id??null,row.receipt_hash??null,...(liveDevice?[at,...(deviceTokenHash?[deviceTokenHash]:[])]:[])];
  await DB.batch([
    DB.prepare(`INSERT OR IGNORE INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,input_versions,policy_revision,executor,device_id,model,disposition,created_at)
      SELECT ?,?,?,'game',?,?,?,?,?,?,?,'pending',? WHERE ${liveTask} AND NOT EXISTS(SELECT 1 FROM forge_creation_stages WHERE task_id=? AND stage=?)`)
      .bind(id,row.owner_id,s.topic.id,cp.output.html,s.revision,JSON.stringify(s.heads),s.policy_revision,row.executor,row.device_id??null,check.model??'',at,...liveParams,row.id,cp.stage),
    DB.prepare(`INSERT OR IGNORE INTO forge_creation_stages(task_id,stage,owner_id,topic_id,version_id,content_hash,input_hash,self_check,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${liveTask} AND EXISTS(SELECT 1 FROM artifact_versions WHERE id=? AND owner_id=? AND topic_id=? AND kind='game')`)
      .bind(row.id,cp.stage,row.owner_id,s.topic.id,id,hash,cp.previousCapture?.inputHash||null,checkJson,at,...liveParams,id,row.owner_id,s.topic.id),
    ...(withEvidence?evidenceStatements(DB,row,cp,{check:checkJson,sql:liveTask,params:liveParams}):[]),
  ]);
  const saved=await DB.prepare(`SELECT * FROM forge_creation_stages WHERE task_id=? AND stage=? AND owner_id=? AND ${liveTask}`).bind(row.id,cp.stage,row.owner_id,...liveParams).first();
  if(!saved||saved.content_hash!==hash||saved.self_check!==checkJson||withEvidence&&saved.evidence_hash!==cp.capture.hash)throw problem('阶段或证据已经锁定，不能替换。',409);
  cp.versionId=saved.version_id;
}
async function persistEvidence(DB:any,row:any,cp:Checkpoint){
  await DB.batch(evidenceStatements(DB,row,cp));
  const saved=await DB.prepare('SELECT evidence_hash FROM forge_creation_stages WHERE task_id=? AND stage=? AND owner_id=?').bind(row.id,cp.stage,row.owner_id).first();
  if(saved?.evidence_hash!==cp.capture.hash)throw problem('阶段或证据已经锁定，不能替换。',409);
}

async function publish(DB:any,row:any,cp:Checkpoint){
  const s=cp.snapshot,needsAttention=cp.output.coreChanges.length>0||cp.output.requirements.some((r:any)=>r.status==='deferred')||(cp.output.selfCheck?.findings||[]).some((f:any)=>f.kind==='confirmed'&&(f.coreChange||!f.resolved));
  // The final artifact retains the actual input revision, even when a member
  // must explicitly choose a version with deferred requirements or core changes.
  const version=await saveArtifact(DB,{owner:row.owner_id,topicId:s.topic.id,kind:'game',content:cp.output.html,taskId:row.id,revision:s.revision,pending:needsAttention,policyRevision:s.policy_revision,heads:s.heads,executor:row.executor,deviceId:row.device_id,model:cp.model??activeModelProfile(cp.config,'game')?.profile.model});
  const result={id:s.topic.id,version_id:version.id,disposition:version.disposition,creative_version:2,stage_version_id:cp.versionId,content_hash:await digest(cp.output.html),self_check_status:needsAttention?'needs-attention':'captured-awaiting-independent-review'};
  await DB.prepare("UPDATE forge_tasks SET status='done',phase='done',result=?,detail=?,error='',updated_at=? WHERE id=? AND status='running'").bind(JSON.stringify(result),needsAttention?'制作完成，存在待确认事项；请查看自检与历史版本。':'制作与复测采集完成，正式审核尚未执行。',stamp(),row.id).run();
  return result;
}

export async function creationPipelineAlarm(state:any,env:any,id:string){
  try{while(await advanceCreationPipeline(state,env,id)){/* checkpoints commit before the next phase */}}
  catch(error){
    const status=(error as any)?.status;
    if(Number.isInteger(status)&&status>=400&&status<500)try{
      const row=await env.DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(id).first();
      if(row)await failForgeTask(env,row,(error as Error).message);
      await state.storage.deleteAll();return;
    }catch{/* A transient database failure uses the checkpoint recovery path. */}
    const since=await state.storage.get('creationRecoverySince')||Date.now();
    if(Date.now()-since>86400000){const row=await env.DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(id).first();if(row)await failForgeTask(env,row,'制作检查点恢复超过 24 小时，未自动重放模型。');await state.storage.deleteAll();return;}
    await state.storage.put('creationRecoverySince',since);await state.storage.setAlarm(Date.now()+30000);
  }
}
export async function advanceCreationPipeline(state:any,env:any,id:string){
  const DB=env.DB,storage=state.storage;
  const row=await DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(id).first();
  if(!row||row.executor!=='platform'||row.creative_version!==2||row.kind!=='game'||!['queued','running'].includes(row.status)){await storage.deleteAll();return false;}
  let cp=await getCheckpoint(storage);
  try{await access(env,row);}catch(e){await failForgeTask(env,row,(e as Error).message);await storage.deleteAll();return false;}
  if((!cp||cp.phase==='ready')&&Date.now()-Date.parse(row.created_at)>86400000){await failForgeTask(env,row,'制作等待超过 24 小时；已完成版本保留，请明确重试。');await storage.deleteAll();return false;}
  if(!cp){
    if(row.model_started_at){await failForgeTask(env,row,'制作模型结果未知，未自动重复生成。');await storage.deleteAll();return false;}
    const snapshot=JSON.parse(row.input_snapshot||'null');
    if(!snapshot?.topic?.brief_md?.trim()){await failForgeTask(env,row,'完整制作需要先生成策划书。');await storage.deleteAll();return false;}
    const config=await env.modelStore.get(),profiles=Object.fromEntries(Object.entries(modelProfiles(config)).filter(([,profile])=>profile?.vision!==false));
    const visualConfig=config&&Object.keys(profiles).length?{...config,profiles}:null;
    if(!activeModelProfile(visualConfig,'game')){await failForgeTask(env,row,'完整制作与精修需要已启用并支持视觉的 Claude Opus 5.5。');await storage.deleteAll();return false;}
    cp={phase:'ready',stage:'build',snapshot,config:visualConfig,createdAt:Date.now()};
    await putCheckpoint(storage,cp);
    await DB.prepare("UPDATE forge_tasks SET status='running',started_at=coalesce(started_at,?),phase_started_at=?,updated_at=? WHERE id=? AND status='queued'").bind(stamp(),stamp(),stamp(),id).run();
    return true;
  }
  if(row.status==='queued')await DB.prepare("UPDATE forge_tasks SET status='running',started_at=coalesce(started_at,?),phase_started_at=?,updated_at=? WHERE id=? AND status='queued'").bind(stamp(),stamp(),stamp(),id).run();
  if(cp.phase==='started'||cp.phase==='failed'){
    await failForgeTask(env,row,cp.phase==='started'?'制作阶段中断，模型结果未知；已完成版本保留，未自动重发请求。':cp.failure||'制作阶段失败；已完成版本保留，请明确重试。');await storage.deleteAll();return false;
  }
  if(cp.phase==='ready'){
    let lease:any;
    try{lease=await claimCreationModel(DB,cp.config,env.SETTINGS_KEY,'game',`${id}:${cp.stage}`);}catch(e){await failForgeTask(env,row,(e as Error).message);await storage.deleteAll();return false;}
    if(!lease){await progress(DB,id,`${cp.stage}:waiting`,'等待制作模型名额…',Date.now());await storage.setAlarm(Date.now()+5000);return false;}
    let uncertain=false,output:any;
    let timer:ReturnType<typeof setInterval>|undefined;
    try{
      const active=activeModelProfile(lease.config,'game');if(!active)throw new Error('制作模型未配置。');
      // Freeze a single selected profile, including key/config, for all stages.
      if(cp.stage==='build')cp.config={...active.profile,activeProfile:active.id,profiles:{[active.id]:active.profile},routes:{create:active.id,review:active.id}};
      cp.phase='started';cp.stageStartedAt=Date.now();await putCheckpoint(storage,cp);await storage.setAlarm(Date.now()+14*60000);
      await progress(DB,id,`${cp.stage}:model`,labels[cp.stage],cp.stageStartedAt);
      timer=setInterval(()=>{void DB.prepare("UPDATE forge_tasks SET updated_at=? WHERE id=? AND status='running'").bind(stamp(),id).run().catch(()=>{});},30000);
      const s=cp.snapshot;
      const input={topic:s.topic,brief:s.topic.brief_md,styleSvg:s.topic.preview_svg||'',assetHtml:s.topic.assets_html||'',html:cp.previous?.html,capture:cp.previousCapture,selfCheck:cp.previous?.selfCheck,requirements:cp.previous?.requirements,decisions:cp.previous?.decisions,coreChanges:cp.previous?.coreChanges};
      const runtime={...env,modelStore:{get:async()=>cp!.config},generation:{id:`${id}:${cp.stage}`,capacityReserved:lease.reserved,deadline:Date.now()+12*60000,onUncertain:()=>{uncertain=true;},onStart:async()=>{await access(env,row);const update=await DB.prepare("UPDATE forge_tasks SET model_started_at=coalesce(model_started_at,?),updated_at=? WHERE id=? AND status='running'").bind(stamp(),stamp(),id).run();if(!update.meta.changes)throw new Error('制作任务已停止。');},onWait:async(message:string)=>progress(DB,id,`${cp!.stage}:model`,`${labels[cp!.stage]} · ${message}`)}};
      const result=await complete(runtime,s.cfg,{system:gameStageSystem(cp.stage),user:gameStageUser(cp.stage,input),schema:schemas[cp.stage],strictJson:true,validate:value=>validateCreationOutput(value,cp!.stage,cp!.previousCapture,cp!.previous),maxTokens:32768,maxAttempts:1,purpose:'game',requiredProfile:'opus',outputEffort:'high'});
      const html=await prepareArtifact('game',result.html,s);
      output={...result,html};
    }catch(e){cp.phase='failed';cp.failure=(e as Error).message;await putCheckpoint(storage,cp);await failForgeTask(env,row,cp.failure);await storage.deleteAll();return false;}
    finally{clearInterval(timer);if(!uncertain)await lease.lease.release().catch(()=>{});}
    cp.output=output;cp.phase='output';
    // A transient checkpoint failure cannot trigger a fresh paid request.
    try{await putCheckpoint(storage,cp);}catch{await putCheckpoint(storage,cp);}
    // Give browser acquisition its own alarm lifetime; model stages may use
    // the full twelve minutes, and browser capacity can wait four more.
    await storage.setAlarm(Date.now()+100);return false;
  }
  if(cp.phase==='output'){
    await persistStage(DB,row,cp);
    await progress(DB,id,`${cp.stage}:capture`,`${labels[cp.stage]}已保存，正在采集三种手机比例…`,Date.now());
    let capture:any,error:any;
    for(let attempt=0;attempt<2;attempt++)try{capture=await (env.captureReview||captureFor({...env,creationCaptureStrict:true}))(cp.output.html,async(message:string)=>progress(DB,id,`${cp!.stage}:capture`,message));break;}catch(e){error=e;}
    if(!capture){await failForgeTask(env,row,`采集未完成，已保存阶段版本：${error instanceof Error?error.message:'环境不可用'}`);await storage.deleteAll();return false;}
    try{cp.capture=await lockCreationCapture(capture,cp.stage,cp.output.html);}catch(e){await failForgeTask(env,row,(e as Error).message);await storage.deleteAll();return false;}
    cp.phase='captured';await putCheckpoint(storage,cp);return true;
  }
  if(cp.phase==='captured'){
    await persistEvidence(DB,row,cp);
    if(cp.stage==='build'||cp.stage==='polish'&&cp.output.selfCheck?.requestRepair){
      const next:Stage=cp.stage==='build'?'polish':'repair';
      cp={...cp,stage:next,phase:'ready',previous:cp.output,previousCapture:cp.capture,output:undefined,capture:undefined,versionId:undefined};
      // Each paid stage has its own bounded alarm invocation, rather than
      // accumulating two twelve-minute calls in one event lifetime.
      await putCheckpoint(storage,cp);await storage.setAlarm(Date.now()+100);return false;
    }
    cp.phase='publish';await putCheckpoint(storage,cp);return true;
  }
  if(cp.phase==='publish'){await publish(DB,row,cp);await storage.deleteAll();return false;}
  throw new Error('未知制作检查点。');
}

export async function creationChecks(DB:any,owner:string,topicId:number){
  await ownedTopic(DB,topicId,owner);
  const rows=(await DB.prepare('SELECT task_id,stage,version_id,content_hash,input_hash,evidence_hash,evidence,self_check,created_at FROM forge_creation_stages WHERE owner_id=? AND topic_id=? ORDER BY created_at,stage').bind(owner,topicId).all()).results||[];
  return rows.map((r:any)=>({...r,evidence:r.evidence?JSON.parse(r.evidence):null,self_check:JSON.parse(r.self_check)}));
}
export async function creationEvidence(DB:any,owner:string,topicId:number,taskId:string,stage:string){
  await ownedTopic(DB,topicId,owner);
  const row=await DB.prepare('SELECT evidence_hash,content_hash FROM forge_creation_stages WHERE owner_id=? AND topic_id=? AND task_id=? AND stage=?').bind(owner,topicId,taskId,stage).first();
  if(!row?.evidence_hash)throw problem('制作采集记录不存在。',404);
  const parts=(await DB.prepare('SELECT content FROM forge_creation_evidence WHERE task_id=? AND stage=? ORDER BY part').bind(taskId,stage).all()).results||[];
  let capture:any;
  try{capture=JSON.parse(parts.map((r:any)=>r.content).join(''));}catch{throw problem('锁定制作证据无法校验。',409);}
  if(capture.stage!==stage||capture.inputHash!==row.content_hash||capture.hash!==row.evidence_hash||!Array.isArray(capture.shots)||capture.shots.length!==4||
    (await Promise.all(capture.shots.map(async(s:any)=>await shotHash(s.data)===s.hash))).includes(false)||
    await captureHash(capture.stage,capture.shots,capture.probe,capture.inputHash)!==row.evidence_hash)throw problem('锁定制作证据无法校验。',409);
  return capture;
}

export async function recordAgentCreationStage(DB:any,row:any,payload:any,deviceTokenHash?:string){
  if(row.kind!=='game'||row.creative_version!==2||row.executor!=='agent'||row.status!=='running')throw problem('此任务不接受分阶段制作回传。',409);
  const stage:Stage=payload.stage;
  if(!['build','polish','repair'].includes(stage)||payload.model!=null&&(typeof payload.model!=='string'||!payload.model.trim()||payload.model.length>160))throw problem('阶段或模型名称无效。');
  const snapshot=JSON.parse(row.input_snapshot),previousStage=stage==='polish'?'build':stage==='repair'?'polish':null;
  let previous:any,previousCapture:any;
  if(previousStage){
    const prior=await DB.prepare('SELECT * FROM forge_creation_stages WHERE task_id=? AND stage=?').bind(row.id,previousStage).first();
    if(!prior?.evidence_hash)throw problem('必须先完成前一阶段及实际采集。',409);
    const check=JSON.parse(prior.self_check);
    if(stage==='repair'&&!check.selfCheck?.requestRepair)throw problem('没有已确认且尚未解决的问题，不启动自动定向修复。',409);
    previous={...(check.selfCheck?{selfCheck:check.selfCheck}:{}),requirements:check.requirements,decisions:check.decisions,coreChanges:check.coreChanges};
    previousCapture=await creationEvidence(DB,row.owner_id,snapshot.topic.id,row.id,previousStage);
  }
  const errors=validateCreationOutput(payload.output,stage,previousCapture,previous);if(errors.length)throw problem(`制作阶段结构不完整：${errors.join('、')}`);
  const html=await prepareArtifact('game',payload.output.html,snapshot);
  if(payload.capture?.inputHash!==await digest(html))throw problem('采集文件与阶段产物哈希不一致，请对实际保存的 HTML 重新采集。',409);
  const capture={...await lockCreationCapture(payload.capture,stage,html),origin:'member-device'};
  const cp:Checkpoint={phase:'captured',stage,snapshot,config:null,model:payload.model??null,output:{...payload.output,html},previous,previousCapture,capture,createdAt:Date.now()};
  await persistStage(DB,row,cp,true,deviceTokenHash);
  await DB.prepare(`UPDATE forge_tasks SET phase=?,detail=?,updated_at=?,phase_started_at=CASE WHEN phase IS NOT ? THEN ? ELSE phase_started_at END
    WHERE id=? AND status='running' AND NOT EXISTS(SELECT 1 FROM forge_creation_stages WHERE task_id=?
      AND CASE stage WHEN 'build' THEN 1 WHEN 'polish' THEN 2 ELSE 3 END > ?)`).bind(`${stage}:captured`,`${labels[stage]}与实际采集已保存。`,stamp(),`${stage}:captured`,stamp(),row.id,row.id,['build','polish','repair'].indexOf(stage)+1).run();
  const next:Stage|null=stage==='build'?'polish':stage==='polish'&&payload.output.selfCheck?.requestRepair?'repair':null;
  return {stage,version_id:cp.versionId,content_hash:capture.inputHash,evidence_hash:capture.hash,...(next?{nextMaterials:{stage:next,system:gameStageSystem(next),user:gameStageUser(next,{topic:snapshot.topic,brief:snapshot.topic.brief_md,styleSvg:snapshot.topic.preview_svg||'',assetHtml:snapshot.topic.assets_html||'',html,capture,selfCheck:cp.output.selfCheck,requirements:cp.output.requirements,decisions:cp.output.decisions,coreChanges:cp.output.coreChanges}),schema:schemas[next]}}:{nextMaterials:null,complete:{result:{stage},model:cp.model}})};
}

export async function validateAgentCreationCompletion(DB:any,row:any,stage:any,model?:unknown){
  if(row.kind!=='game'||row.creative_version!==2||row.executor!=='agent'||row.status!=='running')throw problem('此任务不接受分阶段制作完成回传。',409);
  if(!['polish','repair'].includes(stage))throw problem('完整制作至少包含 build 和 polish。');
  const snapshot=JSON.parse(row.input_snapshot);
  const record=await DB.prepare('SELECT * FROM forge_creation_stages WHERE task_id=? AND stage=? AND owner_id=? AND topic_id=?').bind(row.id,stage,row.owner_id,snapshot.topic.id).first();
  if(!record?.evidence_hash)throw problem('末阶段尚未完成并锁定采集。',409);
  const later=await DB.prepare("SELECT 1 FROM forge_creation_stages WHERE task_id=? AND stage='repair'").bind(row.id).first();
  if(stage==='polish'&&later)throw problem('已经执行修复，请引用 repair 阶段。',409);
  const check=JSON.parse(record.self_check);
  if(stage==='polish'&&check.selfCheck.requestRepair)throw problem('末阶段要求一次定向修复，请完成 repair 或明确结束失败。',409);
  if((model??null)!==(check.model??null))throw problem('完成回传必须保留末阶段模型声明。',409);
  await creationEvidence(DB,row.owner_id,snapshot.topic.id,row.id,stage);
  const artifact=await DB.prepare('SELECT content FROM artifact_versions WHERE id=? AND owner_id=?').bind(record.version_id,row.owner_id).first();
  if(!artifact||await digest(artifact.content)!==record.content_hash)throw problem('锁定阶段产物无法校验。',409);
  return {phase:'publish',stage,snapshot,config:null,model:check.model,versionId:record.version_id,createdAt:Date.now(),output:{html:artifact.content,requirements:check.requirements,decisions:check.decisions,coreChanges:check.coreChanges,selfCheck:check.selfCheck}} as Checkpoint;
}

export async function completeAgentCreation(DB:any,row:any,stage:any,model?:unknown){
  const cp=await validateAgentCreationCompletion(DB,row,stage,model);
  return publish(DB,row,cp);
}
