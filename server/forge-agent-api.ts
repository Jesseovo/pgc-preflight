import {identity} from './members';
import {memberStore} from './storage';
import {canonicalJson,digest,problem,stamp} from './review-device-state';
import {artifactColumns,inputSnapshot,kinds,prepareArtifact,reserveDraw,saveArtifact,taskMaterials} from './forge-workspace';

const json=(v:any,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const all=async(DB:any,sql:string,...p:any[])=>(await DB.prepare(sql).bind(...p).all()).results||[];
const uuid=(v:any)=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const secret=(v:any)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export async function agentBody(request:Request){
  if(!request.headers.get('Content-Type')?.includes('application/json'))throw problem('请使用 JSON。',415);
  const text=await request.text();if(new TextEncoder().encode(text).length>2*1024*1024)throw problem('任务内容过大。',413);
  let value:any;try{value=JSON.parse(text);}catch{throw problem('请求不是合法 JSON。');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw problem('请求必须是 JSON 对象。');
  return value;
}
export function publicCreatorTask(row:any){
  const disconnected=row.executor==='agent'&&row.status==='running'&&Date.now()-Date.parse(row.updated_at)>90000;
  return {id:row.id,kind:row.kind,owner_id:row.owner_id,executor:row.executor,status:row.status,detail:disconnected?'等待 Agent 重新连接':row.detail,error:row.error,created_at:row.created_at,updated_at:row.updated_at,started_at:row.started_at,result:row.result?JSON.parse(row.result):null};
}
export async function validateAgentTask(DB:any,owner:string,job:any){
  if(!kinds.includes(job.type))throw problem('创作任务类型不支持。');
  if(artifactColumns[job.type]){
    const id=job.type==='expand'?job.ids?.[0]:job.id;
    if(!Number.isSafeInteger(id)||id<1||(job.type==='expand'&&(!Array.isArray(job.ids)||job.ids.length!==1)))throw problem('需要有效的选题编号。');
  }
  if(job.type==='suggest'&&!['subject','medium'].includes(job.dim))throw problem('只支持补充题材与美术媒介。');
  const s=await inputSnapshot(DB,owner,job),t=s.topic;
  if(t&&job.type!=='expand'&&!t.data.title)throw problem('请先扩写选题。',409);
  if(job.type==='assets'&&!t?.brief_md?.trim())throw problem('先生成简报，再生成资产。',409);
  if(job.type==='game'&&!['liked','made'].includes(t?.status))throw problem('请先把选题加入候选，再开始制作。',409);
  taskMaterials(job,s);
  return s;
}
export async function createAgentTask(env:any,owner:string,job:any,taskId:string=crypto.randomUUID(),snapshot?:any){
  const DB=env.DB,s=snapshot||await validateAgentTask(DB,owner,job),t=s.topic;
  const scope=`${owner}:${job.type}:${t?.id??(job.dim||'all')}`,at=stamp();
  const column=job.type==='game'?'product':['expand','brief','assets'].includes(job.type)?job.type:null;
  await DB.batch([
    DB.prepare("INSERT OR IGNORE INTO forge_tasks(id,kind,scope,payload,status,detail,owner_id,executor,input_snapshot,created_at,updated_at) VALUES(?,?,?,?,'queued','等待 Agent 接单',?,'agent',?,?,?)").bind(taskId,job.type,scope,JSON.stringify(job),owner,JSON.stringify(s),at,at),
    ...(column?[DB.prepare(`UPDATE topics SET ${column}_status='${job.type==='game'?'queued':'running'}',${column}_error='等待 Agent 接单'${job.type==='game'?',product_request_id=?':''} WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM forge_tasks WHERE id=? AND status='queued')`).bind(...(job.type==='game'?[taskId]:[]),t.id,owner,taskId)]:[]),
  ]);
  const row=await DB.prepare("SELECT * FROM forge_tasks WHERE owner_id=? AND (id=? OR (scope=? AND status IN ('queued','running'))) ORDER BY created_at DESC LIMIT 1").bind(owner,taskId,scope).first();
  if(!row)throw problem('任务编号冲突。',409);
  return row;
}

export async function forgeAgentWeb(request:Request,env:any){
  try{
    if(request.headers.has('Authorization'))throw problem('设备凭据不能访问网页接口。',403);
    const user=await identity(request.headers.get('Cookie'),memberStore(env.DB),env);
    if(!user||user.role!=='member'||!user.star)throw problem('需要 Star 成员权限。',403);
    const action=new URL(request.url).pathname.slice('/api/forge/agent/'.length),DB=env.DB;
    if(!['pairing','devices','revoke'].includes(action))throw problem('接口不存在。',404);
    if(action==='devices'&&request.method==='GET')return json({devices:(await all(DB,'SELECT id,name,expires_at,revoked,last_seen FROM forge_agents WHERE owner_id=? ORDER BY created_at DESC',user.id)).map((d:any)=>({...d,online:!d.revoked&&Date.parse(d.expires_at)>Date.now()&&Date.now()-Date.parse(d.last_seen||'')<90000})),tasks:(await all(DB,"SELECT * FROM forge_tasks WHERE owner_id=? AND executor='agent' ORDER BY created_at DESC LIMIT 100",user.id)).map(publicCreatorTask)});
    if(request.method!=='POST')throw problem('请使用 POST。',405);
    if(request.headers.get('Origin')!==new URL(request.url).origin)throw problem('请求来源不匹配。',403);
    if(action==='pairing'){
      const code=Array.from(crypto.getRandomValues(new Uint8Array(20)),v=>v.toString(16).padStart(2,'0')).join('');
      const member=await memberStore(DB).byId(user.id),expiresAt=new Date(Date.now()+300000).toISOString();
      await DB.batch([DB.prepare('DELETE FROM forge_agent_pairings WHERE owner_id=? AND device_id IS NULL').bind(user.id),DB.prepare('INSERT INTO forge_agent_pairings VALUES(?,?,?,?,NULL)').bind(await digest(code),user.id,member!.sessionVersion,expiresAt)]);
      return json({code,expiresAt});
    }
    if(action==='revoke'){const b=await agentBody(request);await DB.prepare('UPDATE forge_agents SET revoked=1 WHERE id=? AND owner_id=?').bind(b.id,user.id).run();return json({ok:true});}
    throw problem('接口不存在。',404);
  }catch(e){return json({error:(e as Error).message},(e as any).status||500);}
}

async function authenticate(request:Request,env:any){
  const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if(!token)throw problem('请先配对创作 Agent。',401);
  const device=await env.DB.prepare('SELECT * FROM forge_agents WHERE token_hash=? AND revoked=0 AND expires_at>?').bind(await digest(token),stamp()).first();
  const member=device?await memberStore(env.DB).byId(device.owner_id):null;
  if(!device||!member?.enabled||member.sessionVersion!==device.session_version)throw problem('创作 Agent 授权已失效。',401);
  return {device,member};
}
export async function forgeAgentApi(request:Request,env:any){
  try{
    if(request.method!=='POST')throw problem('请使用 POST。',405);
    const action=new URL(request.url).pathname.slice('/api/forge-agent/'.length),DB=env.DB;
    const actions=new Set(['pair','context','draw','create','jobs','job','claim','heartbeat','complete','fail']);
    if(!actions.has(action))throw problem('创作凭据不允许这个操作。',403);
    const b=await agentBody(request);
    if(action==='pair'){
      if(!uuid(b.deviceId)||!secret(b.token)||!/^[a-f0-9]{40}$/.test(b.code||''))throw problem('配对格式不正确。');
      const codeHash=await digest(b.code),hash=await digest(b.token);
      const pairing=await DB.prepare('SELECT * FROM forge_agent_pairings WHERE code_hash=? AND expires_at>?').bind(codeHash,stamp()).first();
      const m=pairing?await memberStore(DB).byId(pairing.owner_id):null;
      if(!pairing||!m?.enabled||!m.star||m.sessionVersion!==pairing.session_version)throw problem('配对码过期或成员没有 Star 权限。',401);
      if(pairing.device_id){const existing=await DB.prepare('SELECT id,expires_at FROM forge_agents WHERE id=? AND token_hash=? AND pairing_hash=? AND revoked=0').bind(b.deviceId,hash,codeHash).first();if(!existing)throw problem('配对码已使用。',409);return json({ok:true,deviceId:existing.id,expiresAt:existing.expires_at});}
      const expiresAt=new Date(Date.now()+30*86400000).toISOString();
      await DB.batch([
        DB.prepare(`INSERT INTO forge_agents(id,owner_id,session_version,token_hash,pairing_hash,name,expires_at,created_at)
          SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM forge_agent_pairings WHERE code_hash=? AND device_id IS NULL) AND (SELECT COUNT(*) FROM forge_agents WHERE owner_id=? AND revoked=0 AND expires_at>? AND id<>?)<3
          ON CONFLICT(id) DO UPDATE SET session_version=excluded.session_version,token_hash=excluded.token_hash,pairing_hash=excluded.pairing_hash,name=excluded.name,expires_at=excluded.expires_at,revoked=0 WHERE forge_agents.owner_id=excluded.owner_id`)
          .bind(b.deviceId,m.id,m.sessionVersion,hash,codeHash,String(b.name||'我的创作 Agent').slice(0,80),expiresAt,stamp(),codeHash,m.id,stamp(),b.deviceId),
        DB.prepare('UPDATE forge_agent_pairings SET device_id=? WHERE code_hash=? AND device_id IS NULL AND EXISTS(SELECT 1 FROM forge_agents WHERE id=? AND token_hash=?)').bind(b.deviceId,codeHash,b.deviceId,hash),
      ]);
      const paired=await DB.prepare('SELECT id FROM forge_agents WHERE id=? AND token_hash=? AND pairing_hash=?').bind(b.deviceId,hash,codeHash).first();
      if(!paired)throw problem('配对失败；最多授权 3 台设备，请撤销旧设备后重试。',409);
      return json({ok:true,deviceId:b.deviceId,expiresAt});
    }
    const {device,member}=await authenticate(request,env);
    if(!member.star&&!['complete','fail'].includes(action))throw problem('Star 权限已撤销，仅可回传已执行任务。',403);
    await DB.prepare('UPDATE forge_agents SET last_seen=? WHERE id=?').bind(stamp(),device.id).run();
    if(action==='context'){
      const {publicSettings}=await import('./forge-workspace');
      return json({settings:await publicSettings(DB),vocab:await all(DB,'SELECT * FROM vocab ORDER BY dim,id'),games:await all(DB,'SELECT * FROM games WHERE owner_id=? OR is_public=1',member.id),instructions:'题材通过 draw 接口原子占用。任务只按用户明确要求执行，补词作为管理员建议。',model_execution:'local-agent'});
    }
    if(action==='draw')return json(await reserveDraw(DB,member.id,b));
    if(action==='create'){
      if(!uuid(b.request_id))throw problem('创建任务需要 request_id UUID。');
      const hash=await digest(canonicalJson({kind:b.kind,id:b.id,ids:b.ids,dim:b.dim,n:b.n}));
      const prior=await DB.prepare('SELECT * FROM forge_requests WHERE owner_id=? AND request_id=?').bind(member.id,b.request_id).first();
      if(prior){if(prior.kind!=='create'||prior.payload_hash!==hash)throw problem('请求编号已使用。',409);if(prior.result)return json(JSON.parse(prior.result));}
      await DB.prepare("INSERT OR IGNORE INTO forge_requests(owner_id,request_id,kind,payload_hash) VALUES(?,?,'create',?)").bind(member.id,b.request_id,hash).run();
      const reserved=await DB.prepare('SELECT * FROM forge_requests WHERE owner_id=? AND request_id=?').bind(member.id,b.request_id).first();if(reserved.kind!=='create'||reserved.payload_hash!==hash)throw problem('请求编号已使用。',409);
      const jobs=b.kind==='expand'?(Array.isArray(b.ids)?[...new Set(b.ids)]:[b.id]).map(id=>({type:'expand',ids:[id]})):[{type:b.kind,id:b.id,dim:b.dim,n:Math.min(60,Math.max(5,Number(b.n)||30))}];
      if(!jobs.length||jobs.length>40)throw problem('每批最多创建 40 个任务。');
      // Validate the whole batch before creating its first durable task.
      const snapshots=[];for(const job of jobs)snapshots.push(await validateAgentTask(DB,member.id,job));
      const tasks=[];
      for(let i=0;i<jobs.length;i++){
        const bytes=await digest(`${member.id}:${b.request_id}:${i}`),id=`${bytes.slice(0,8)}-${bytes.slice(8,12)}-${bytes.slice(12,16)}-${bytes.slice(16,20)}-${bytes.slice(20,32)}`;
        tasks.push(publicCreatorTask(await createAgentTask(env,member.id,jobs[i],id,snapshots[i])));
      }
      const result={tasks};await DB.prepare('UPDATE forge_requests SET result=? WHERE owner_id=? AND request_id=? AND payload_hash=?').bind(JSON.stringify(result),member.id,b.request_id,hash).run();return json(result);
    }
    if(action==='jobs')return json((await all(DB,'SELECT * FROM forge_tasks WHERE owner_id=? AND executor=\'agent\' ORDER BY created_at DESC LIMIT 200',member.id)).map(publicCreatorTask));
    if(action==='job'){
      const row=await DB.prepare("SELECT * FROM forge_tasks WHERE id=? AND owner_id=? AND executor='agent'").bind(b.id,member.id).first();if(!row)throw problem('任务不存在。',404);return json(publicCreatorTask(row));
    }
    if(action==='claim'){
      if(!uuid(b.claimId)||!secret(b.receipt))throw problem('需要 claimId UUID 与 64 位随机 receipt。');
      const receiptHash=await digest(b.receipt);
      let row=await DB.prepare("SELECT * FROM forge_tasks WHERE owner_id=? AND executor='agent' AND device_id=? AND claim_id=?").bind(member.id,device.id,b.claimId).first();
      if(row&&(row.receipt_hash!==receiptHash||(b.id&&row.id!==b.id)))throw problem('领取编号已使用，请保留原回执。',409);
      if(!row){
        const candidate=await DB.prepare("SELECT * FROM forge_tasks WHERE owner_id=? AND executor='agent' AND status='queued' AND (? IS NULL OR id=?) ORDER BY created_at,id LIMIT 1").bind(member.id,b.id||null,b.id||null).first();
        if(candidate){
          const snapshot=await validateAgentTask(DB,member.id,JSON.parse(candidate.payload)),at=stamp();
          row=await DB.prepare(`UPDATE forge_tasks SET status='running',device_id=?,claim_id=?,receipt_hash=?,input_snapshot=?,started_at=?,updated_at=?,detail='Agent 正在执行'
            WHERE id=? AND status='queued' AND NOT EXISTS(SELECT 1 FROM forge_tasks WHERE owner_id=? AND device_id=? AND claim_id=?) RETURNING *`)
            .bind(device.id,b.claimId,receiptHash,JSON.stringify(snapshot),at,at,candidate.id,member.id,device.id,b.claimId).first();
          if(!row){row=await DB.prepare('SELECT * FROM forge_tasks WHERE owner_id=? AND device_id=? AND claim_id=?').bind(member.id,device.id,b.claimId).first();if(row&&(row.receipt_hash!==receiptHash||(b.id&&row.id!==b.id)))throw problem('领取编号已使用，请保留原回执。',409);}
        }
      }
      if(!row)return json(null);
      return json({task:publicCreatorTask(row),materials:taskMaterials(JSON.parse(row.payload),JSON.parse(row.input_snapshot))});
    }
    if(action==='heartbeat'){
      if(b.id)await DB.prepare("UPDATE forge_tasks SET updated_at=?,detail=? WHERE id=? AND owner_id=? AND device_id=? AND receipt_hash=? AND status='running'").bind(stamp(),String(b.detail||'Agent 正在执行').slice(0,500),b.id,member.id,device.id,await digest(String(b.receipt||''))).run();
      return json({ok:true});
    }
    const row=await DB.prepare("SELECT * FROM forge_tasks WHERE id=? AND owner_id=? AND device_id=? AND receipt_hash=? AND executor='agent'").bind(b.id,member.id,device.id,await digest(String(b.receipt||''))).first();
    if(!row)throw problem('任务回传凭证无效。',409);
    if(action==='fail'){
      if(row.status==='done')return json({task:publicCreatorTask(row)});
      const job=JSON.parse(row.payload),column=row.kind==='game'?'product':['expand','brief','assets'].includes(row.kind)?row.kind:null,at=stamp(),message=String(b.message||'Agent 执行未完成').slice(0,700);
      // A result that has acquired its immutable hash must finish or resume;
      // a concurrent failure cannot turn an already saved artifact into error.
      await DB.batch([
        ...(column?[DB.prepare(`UPDATE topics SET ${column}_status='error',${column}_error=?,updated_at=? WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM forge_tasks WHERE id=? AND status='running' AND result_hash IS NULL)`).bind(message,at,job.type==='expand'?job.ids[0]:job.id,member.id,row.id)]:[]),
        DB.prepare("UPDATE forge_tasks SET status='error',error=?,detail=?,updated_at=? WHERE id=? AND status='running' AND result_hash IS NULL").bind(message,message,at,row.id),
      ]);
      const finished=await DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(row.id).first();
      if(finished.status==='running')throw problem('结果正在保存，请重试原结果回传。',409);
      return json({ok:true,task:publicCreatorTask(finished)});
    }
    if(b.model!==undefined&&(typeof b.model!=='string'||b.model.length>160))throw problem('模型名称格式不正确。');
    const hash=await digest(canonicalJson({result:b.result,model:b.model||''}));
    if(row.status==='done'){if(row.result_hash!==hash)throw problem('任务已有结果，不能替换。',409);return json({task:publicCreatorTask(row),...JSON.parse(row.result||'{}')});}
    if(row.status!=='running')throw problem('任务未在执行。',409);
    const snapshot=JSON.parse(row.input_snapshot),job=JSON.parse(row.payload);
    let prepared:any=null;
    if(artifactColumns[row.kind]){try{prepared=await prepareArtifact(row.kind,b.result,snapshot);}catch(e){throw problem((e as Error).message);}}
    if(row.kind==='suggest'&&(!Array.isArray(b.result?.words)||!b.result.words.length||b.result.words.length>60||b.result.words.some((w:any)=>!w||typeof w.word!=='string'||!w.word.trim()||w.word.length>160)))throw problem('补词结果格式不正确。');
    if(row.kind==='tag'){
      const items=b.result?.items,allowed=new Map(snapshot.tagGames.map((g:any)=>[g.id,g]));
      if(!Array.isArray(items)||items.length>50||items.some((i:any)=>!i||!allowed.has(i.id)||['subject','medium','gesture','structure','mood'].some(k=>typeof i[k]!=='string'||i[k].length>200))||new Set(items.map((i:any)=>i.id)).size!==items.length)throw problem('打标结果包含无效作品或字段。');
    }
    const locked=await DB.prepare("UPDATE forge_tasks SET result_hash=? WHERE id=? AND status='running' AND (result_hash IS NULL OR result_hash=?) RETURNING id").bind(hash,row.id,hash).first();
    if(!locked){
      const finished=await DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(row.id).first();
      if(finished?.status==='done'&&finished.result_hash===hash)return json({task:publicCreatorTask(finished),...JSON.parse(finished.result||'{}')});
      throw problem('该任务正在提交另一份结果。',409);
    }
    let result:any;
    if(['expand','brief','preview','assets','game'].includes(row.kind)){
      const content=prepared!;
      const version=await saveArtifact(DB,{owner:member.id,topicId:snapshot.topic.id,kind:row.kind,content,taskId:row.id,revision:snapshot.revision,policyRevision:snapshot.policy_revision,heads:snapshot.heads,executor:'agent',deviceId:device.id,model:b.model});
      result={id:snapshot.topic.id,version_id:version.id,disposition:version.disposition,...(row.kind==='preview'?{svg:content}:{})};
    }else if(row.kind==='suggest'){
      await DB.prepare("INSERT OR IGNORE INTO vocab_suggestions(id,owner_id,task_id,dim,words,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(row.id,member.id,row.id,job.dim,JSON.stringify(b.result.words),stamp(),stamp()).run();result={suggestion_id:row.id,words:b.result.words,status:'pending'};
    }else{
      const items=b.result?.items,allowed=new Map(snapshot.tagGames.map((g:any)=>[g.id,g]));
      const at=stamp(),source=JSON.stringify(items.map((i:any)=>allowed.get(i.id)));
      const fields=['ext_id','title','descr','status','score','aes','ease','play','revisions','feedback','subject','medium','gesture','structure','mood','source','updated_at','is_public'];
      const matches=(table:string)=>fields.map(k=>`${table}.${k} IS json_extract(s.value,'$.${k}')`).join(' AND ');
      const count=`(SELECT COUNT(*) FROM games g JOIN json_each(?) s ON g.id=json_extract(s.value,'$.id') WHERE g.owner_id=? AND ${matches('g')})`;
      // Count, writes and final result share one transaction. Concurrent replay
      // sees done and returns the first saved count, even if all CAS writes skip.
      await DB.batch([
        DB.prepare(`UPDATE forge_tasks SET result=json_object('tagged',${count},'conflicts',?-${count}) WHERE id=? AND status='running' AND result IS NULL`).bind(source,member.id,items.length,source,member.id,row.id),
        ...items.map((i:any)=>DB.prepare(`UPDATE games SET subject=?,medium=?,gesture=?,structure=?,mood=?,updated_at=? WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM json_each(?) s WHERE games.id=json_extract(s.value,'$.id') AND ${matches('games')}) AND EXISTS(SELECT 1 FROM forge_tasks WHERE id=? AND status='running')`).bind(i.subject,i.medium,i.gesture,i.structure,i.mood,at,i.id,member.id,JSON.stringify([allowed.get(i.id)]),row.id)),
        DB.prepare("UPDATE forge_tasks SET status='done',result=json_set(result,'$.remaining',(SELECT COUNT(*) FROM games WHERE owner_id=? AND (gesture='' OR medium=''))),detail=CASE WHEN json_extract(result,'$.conflicts')>0 THEN '部分作品已修改，未覆盖冲突字段' ELSE '已完成' END,updated_at=? WHERE id=? AND status='running'").bind(member.id,at,row.id),
      ]);
      const finished=await DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(row.id).first();
      return json({task:publicCreatorTask(finished),...JSON.parse(finished.result)});
    }
    await DB.prepare("UPDATE forge_tasks SET status='done',detail=?,result=?,result_hash=?,updated_at=? WHERE id=? AND status='running'").bind(result.disposition==='pending'?'结果已保存，等待选择版本':'已完成',JSON.stringify(result),hash,stamp(),row.id).run();
    const finished=await DB.prepare('SELECT * FROM forge_tasks WHERE id=?').bind(row.id).first();
    return json({task:publicCreatorTask(finished),...JSON.parse(finished.result)});
  }catch(e){return json({error:(e as Error).message||'创作 Agent 请求失败。'},(e as any).status||500);}
}
