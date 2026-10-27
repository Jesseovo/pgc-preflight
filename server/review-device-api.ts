import { identity } from './members';
import { memberStore } from './storage';
import { activeModelProfile } from './settings';
import {digest,stamp,problem,inputChunks,failDeviceReview,recoverDeviceReviews} from './review-device-state';
import {enqueueReview,getReviewJob,listReviewJobs} from './review-jobs';

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
type Env={DB:any;SETTINGS_KEY:string;ADMIN_PASSWORD:string;modelStore:{get():Promise<any>};REVIEW_RUNNER?:any};
const validId=(value:any)=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
async function version(env:Env,owner:string){
  if(owner==='admin')return digest(env.ADMIN_PASSWORD);
  const row=await env.DB.prepare('SELECT enabled,can_review,session_version FROM members WHERE id=?').bind(owner).first();
  return row?.enabled&&row.can_review?String(row.session_version):null;
}
async function authenticate(request:Request,env:Env){
  const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if(!token)throw problem('请先在网页授权 Agent。',401);
  const device=await env.DB.prepare('SELECT * FROM review_devices WHERE token_hash=? AND revoked=0 AND expires_at>?').bind(await digest(token),stamp()).first();
  if(!device||await version(env,device.owner_id)!==device.session_version)throw problem('设备配对已过期或账号权限已变更，请重新配对。',401);
  return device;
}
async function leased(env:Env,device:any,b:any){
  const row=await env.DB.prepare("SELECT * FROM review_jobs WHERE id=? AND worker_id=? AND lease=? AND owner_id=? AND executor='device'").bind(b.id,device.id,b.lease,device.owner_id).first();
  if(!row||!['running','done','error'].includes(row.status))throw problem('任务租约已失效，请停止本次采集。',409);
  return row;
}
async function readBody(request:Request){
  if(!request.headers.get('Content-Type')?.includes('application/json'))throw problem('请使用 JSON。',415);
  if(Number(request.headers.get('Content-Length'))>16*1024*1024)throw problem('请求内容过大。',413);
  const text=await request.text();if(new TextEncoder().encode(text).length>16*1024*1024)throw problem('请求内容过大。',413);
  try{return JSON.parse(text);}catch{throw problem('请求内容不是合法 JSON。');}
}
export async function deviceStatus(DB:any,ownerId?:string){
  const {results}=await DB.prepare(`SELECT d.id,d.owner_id,d.name,d.version,d.last_seen,d.expires_at,d.revoked,d.free_memory_mb,m.display_name FROM review_devices d LEFT JOIN members m ON m.id=d.owner_id ${ownerId?'WHERE d.owner_id=?':''} ORDER BY d.last_seen DESC LIMIT 100`).bind(...(ownerId?[ownerId]:[])).all();
  const devices=results.map((d:any)=>({...d,online:!d.revoked&&Date.parse(d.expires_at)>Date.now()&&Date.now()-Date.parse(d.last_seen||'')<90000}));
  return {online:devices.some((d:any)=>d.online),devices};
}
// These operations use the logged-in website session and same-origin POSTs.
export async function reviewDeviceWeb(request:Request,env:Env){
  try{
    const user=await identity(request.headers.get('Cookie'),memberStore(env.DB),env);
    if(!user||!user.canReview)throw problem('请先登录有审核权限的账号。',401);
    const action=new URL(request.url).pathname.split('/').pop();
    if(action==='devices'&&request.method==='GET')return json(await deviceStatus(env.DB,user.id));
    if(request.method!=='POST')throw problem('请使用 POST。',405);
    if(request.headers.get('Origin')!==new URL(request.url).origin)throw problem('请求来源不匹配。',403);
    if(action==='pairing'){
      const code=Array.from(crypto.getRandomValues(new Uint8Array(20)),n=>n.toString(16).padStart(2,'0')).join('');
      const expiresAt=new Date(Date.now()+5*60000).toISOString();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM review_pairings WHERE owner_id=? AND device_id IS NULL').bind(user.id),
        env.DB.prepare('INSERT INTO review_pairings(code_hash,owner_id,session_version,expires_at) VALUES(?,?,?,?)').bind(await digest(code),user.id,await version(env,user.id),expiresAt),
      ]);
      return json({code,expiresAt});
    }
    if(action==='revoke'){
      const b=await readBody(request);
      await env.DB.prepare('UPDATE review_devices SET revoked=1 WHERE id=? AND owner_id=?').bind(b.id,user.id).run();
      return json({ok:true});
    }
    throw problem('接口不存在。',404);
  }catch(error){return json({error:(error as Error).message},(error as any).status||500);}
}
// Paired capture devices receive only their owner's source, never model
// profiles, prompts, API Keys, reports from another member, or SQL access.
export async function reviewDeviceApi(request:Request,env:Env){
  try{
    if(request.method!=='POST')throw problem('请使用 POST。',405);
    const b=await readBody(request),action=new URL(request.url).pathname.split('/').pop(),DB=env.DB;
    if(action==='pair'){
      if(!validId(b.deviceId)||!/^[a-f0-9]{64}$/.test(b.token)||!/^[a-f0-9]{40}$/.test(b.code))throw problem('配对信息不正确。');
      const hash=await digest(b.code),tokenHash=await digest(b.token);
      const pairing=await DB.prepare('SELECT * FROM review_pairings WHERE code_hash=? AND expires_at>?').bind(hash,stamp()).first();
      if(!pairing||await version(env,pairing.owner_id)!==pairing.session_version)throw problem('配对码已过期，请在网页重新生成。',401);
      if(pairing.device_id){
        const existing=await DB.prepare('SELECT * FROM review_devices WHERE id=? AND token_hash=? AND pairing_hash=? AND revoked=0').bind(b.deviceId,tokenHash,hash).first();
        if(!existing)throw problem('配对码已经使用。',409);
        return json({ok:true,deviceId:existing.id,expiresAt:existing.expires_at});
      }
      const count=await DB.prepare('SELECT COUNT(*) n FROM review_devices WHERE owner_id=? AND revoked=0 AND expires_at>?').bind(pairing.owner_id,stamp()).first();
      const replacing=await DB.prepare('SELECT id FROM review_devices WHERE id=? AND owner_id=?').bind(b.deviceId,pairing.owner_id).first();
      if(count.n>=3&&!replacing)throw problem('最多配对 3 台设备，请先在网页断开旧设备。',409);
      const expires=new Date(Date.now()+30*86400000).toISOString();
      await DB.batch([
        DB.prepare(`INSERT INTO review_devices(id,owner_id,session_version,token_hash,pairing_hash,name,expires_at,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM review_pairings WHERE code_hash=? AND device_id IS NULL) AND ((SELECT COUNT(*) FROM review_devices WHERE owner_id=? AND revoked=0 AND expires_at>?)<3 OR EXISTS(SELECT 1 FROM review_devices WHERE id=? AND owner_id=?)) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,session_version=excluded.session_version,token_hash=excluded.token_hash,pairing_hash=excluded.pairing_hash,name=excluded.name,expires_at=excluded.expires_at,created_at=excluded.created_at,revoked=0 WHERE review_devices.owner_id=excluded.owner_id`).bind(b.deviceId,pairing.owner_id,pairing.session_version,tokenHash,hash,String(b.name||'我的电脑').slice(0,80),expires,stamp(),hash,pairing.owner_id,stamp(),b.deviceId,pairing.owner_id),
        DB.prepare('UPDATE review_pairings SET device_id=? WHERE code_hash=? AND device_id IS NULL').bind(b.deviceId,hash),
      ]);
      const paired=await DB.prepare('SELECT id FROM review_devices WHERE id=? AND token_hash=?').bind(b.deviceId,tokenHash).first();
      if(!paired)throw problem('配对码已经使用。',409);
      return json({ok:true,deviceId:b.deviceId,expiresAt:expires});
    }
    const device=await authenticate(request,env);
    // The Agent API uses exactly the web quota and owner checks. The device
    // credential is scoped to this member; it is never a provider API Key.
    if(action==='submit')return json(await enqueueReview({...env,reviewExecutor:'device'},b,device.owner_id));
    if(action==='jobs')return json(await listReviewJobs(env,device.owner_id));
    if(action==='job')return json(await getReviewJob(env,String(b.id||''),device.owner_id));
    if(action==='report'){
      const job=await getReviewJob(env,String(b.id||''),device.owner_id);
      if(job.status!=='done'||!job.result_id)throw problem('审核尚未完成，请先查询进度。',409);
      const report=await DB.prepare('SELECT * FROM reviews WHERE id=? AND owner_id=?').bind(job.result_id,device.owner_id).first();
      if(!report)throw problem('审核报告不存在。',404);
      for(const key of ['result','probe','shots'])report[key]=JSON.parse(report[key]||'null');
      return json(report);
    }
    if(action==='heartbeat'){
      await DB.prepare('UPDATE review_devices SET version=?,last_seen=?,free_memory_mb=? WHERE id=?').bind(String(b.version||'').slice(0,40),stamp(),Math.max(0,Math.min(1000000,Number(b.freeMemoryMB)||0)),device.id).run();
      if(b.job)await DB.prepare("UPDATE review_jobs SET updated_at=? WHERE id=? AND lease=? AND worker_id=? AND owner_id=? AND stage='capture' AND status='running'").bind(stamp(),b.job.id,b.job.lease,device.id,device.owner_id).run();
      return json({ok:true});
    }
    if(action==='claim'){
      if(!validId(b.claimId))throw problem('领取标识不正确。');
      await DB.prepare('UPDATE review_devices SET last_seen=?,version=? WHERE id=?').bind(stamp(),String(b.version||'member-capture-v1').slice(0,40),device.id).run();
      await recoverDeviceReviews(DB);
      const duplicate=await DB.prepare("SELECT * FROM review_jobs WHERE worker_id=? AND lease=? AND owner_id=? AND status='running' AND evidence_ready=0").bind(device.id,b.claimId,device.owner_id).first();
      const selected=activeModelProfile(await env.modelStore.get(),'review');
      if(!selected?.profile.enabled||!selected.profile.encryptedKey)throw problem('管理员尚未启用审核模型。',503);
      const row=duplicate||await DB.prepare(`UPDATE review_jobs SET status='running',worker_id=?,lease=?,updated_at=?,model_snapshot=?
        WHERE id=(SELECT id FROM review_jobs WHERE executor='device' AND owner_id=? AND status='queued' AND input_ready=1 AND (? IS NULL OR id=?) ORDER BY created_at LIMIT 1)
        AND status='queued' AND NOT EXISTS(SELECT 1 FROM review_jobs WHERE worker_id=? AND status='running' AND evidence_ready=0) RETURNING *`)
        .bind(device.id,b.claimId,stamp(),JSON.stringify(selected),device.owner_id,b.id||null,b.id||null,device.id).first();
      if(!row)return json(null);
      const {readReviewInput}=await import('./review-device-state');
      const input=await readReviewInput(DB,row.id);
      return json({id:row.id,lease:row.lease,title:row.title,html:input.html});
    }
    const row=await leased(env,device,b);
    if(action==='evidence'){
      if(row.status==='error')throw problem('任务已中断，请在网页手动重试。',409);
      if(row.status==='done')return json({ok:true,status:'done'});
      const evidence={probe:b.probe,shots:b.shots};
      if(b.probe?.captureMethod!=='browser-viewport-v1'||!Array.isArray(b.shots)||b.shots.length!==4||b.shots.some((s:any)=>typeof s.label!=='string'||typeof s.data!=='string'||!/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(s.data)))throw problem('需要四张完整浏览器视口截图及采集记录。');
      if(!env.REVIEW_RUNNER)throw problem('云端模型执行器尚未就绪。',503);
      const hash=await digest(JSON.stringify(evidence));
      if(row.evidence_ready&&row.evidence_hash!==hash)throw problem('这次任务的证据已经锁定，不能替换。',409);
      if(!row.evidence_ready){
        // The control-plane object serializes this short commit with SQLite's
        // transaction gate; no member may alter evidence after acceptance.
        await DB.batch([
          DB.prepare("DELETE FROM review_evidence WHERE job_id=? AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND evidence_ready=0 AND status='running')").bind(row.id,row.id),
          ...inputChunks(DB,row.id,evidence),
          DB.prepare("UPDATE review_jobs SET evidence_ready=1,evidence_hash=?,stage='review',error='画面已上传，等待云端模型初评',updated_at=? WHERE id=? AND lease=? AND evidence_ready=0 AND status='running'").bind(hash,stamp(),row.id,row.lease),
        ]);
        const accepted=await DB.prepare('SELECT evidence_hash FROM review_jobs WHERE id=?').bind(row.id).first();
        if(accepted.evidence_hash!==hash)throw problem('这次任务的证据已经锁定，不能替换。',409);
      }
      const stub=env.REVIEW_RUNNER.get(env.REVIEW_RUNNER.idFromName(row.id));
      const response=await stub.fetch(new Request('https://internal/schedule',{method:'POST',body:row.id}));
      if(!response.ok)throw problem('证据已保存，云端调度暂不可用；Agent 将使用同一证据重新连接。',503);
      return json({ok:true,status:'review'});
    }
    if(action==='fail'){
      if(row.evidence_ready)throw problem('截图已经上传，后续由云端执行，不能由设备取消。',409);
      await failDeviceReview(DB,row.id,String(b.message||'本机截图未完成，请重试。'));return json({ok:true});
    }
    throw problem('接口不存在。',404);
  }catch(error){return json({error:(error as Error).message||'Agent 请求失败。'},(error as any).status||500);}
}
