import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {reviewDeviceApi,reviewDeviceWeb} from '../server/review-device-api';
import {digest,recoverDeviceReviews} from '../server/review-device-state';
import {executeDeviceReview,ReviewRunner} from '../server/review-runner';
import {generateReview} from '../server/review-generation';
import {memberLogin,hashPassword} from '../server/members';
import {memberStore} from '../server/storage';
import {reviewUsage} from '../server/review-usage';
vi.mock('../server/review-generation',()=>({generateReview:vi.fn()}));
const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.resetAllMocks();});
function setup(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  for(const id of ['a','b'])sqlite.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at) VALUES (?,?,?,'unused','00000000000000000000000000000000','now','now')").run(id,id,id);
  const DB:any={prepare(sql:string){let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>{const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>sqlite.prepare(sql).run(...params)};return s;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const out=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const schedule=vi.fn(async()=>Response.json({ok:true}));
  const profile={baseUrl:'https://fixture.invalid',protocol:'openai',model:'deepseek-flash',enabled:true,encryptedKey:'PRIVATE_ENCRYPTED_KEY',updatedAt:''};
  const env={DB,SETTINGS_KEY:'fixture',ADMIN_PASSWORD:'fixture-admin',modelStore:{get:async()=>profile},REVIEW_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:schedule})}};
  const tokens={a:'a'.repeat(64),b:'b'.repeat(64)};
  async function device(owner:'a'|'b'){
    const id=crypto.randomUUID(),code=owner.repeat(40),expires=new Date(Date.now()+300000).toISOString();
    sqlite.prepare('INSERT INTO review_pairings VALUES(?,?,?, ?,NULL)').run(await digest(code),owner,'1',expires);
    const res=await call('pair',{deviceId:id,code,token:tokens[owner]},owner);expect(res.status).toBe(200);return id;
  }
  function call(action:string,body:any={},owner:'a'|'b'='a'){return reviewDeviceApi(new Request(`https://fixture.test/api/review-device/${action}`,{method:'POST',headers:{Authorization:`Bearer ${tokens[owner]}`,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);}
  async function submit(owner:'a'|'b'='a',id=crypto.randomUUID()){
    const response=await call('submit',{request_id:id,title:`${owner} fixture`,filename:'fixture.html',html:'<html><title>ORIGINAL_GAME</title><canvas></canvas></html>'},owner);expect(response.status).toBe(200);return response.json() as Promise<any>;
  }
  async function claim(owner:'a'|'b'='a',claimId=crypto.randomUUID()){return (await call('claim',{claimId},owner)).json() as Promise<any>;}
  const evidence=(job:any)=>({id:job.id,lease:job.lease,probe:{captureMethod:'browser-viewport-v1',observations:[]},shots:Array.from({length:4},(_,i)=>({label:`frame-${i}`,data:'data:image/jpeg;base64,YQ=='}))});
  return {sqlite,DB,env,device,call,submit,claim,evidence,schedule};
}
describe('成员本机采集与云端审核',()=>{
  it('设备只允许明确列出的审核操作，嵌套路径不能借末尾名称绕过',async()=>{
    const s=setup();await s.device('a');
    for(const action of ['config','topics','settings','admin/jobs','nested/pair','nested/report','jobs/']){
      expect((await s.call(action)).status,action).toBe(403);
    }
    expect((await s.call('jobs')).status).toBe(200);
  });
  it('他人任务不能查看、领取、续租、上传证据、标记失败或读取报告',async()=>{
    const s=setup();await s.device('a');await s.device('b');
    const b=await s.submit('b'),job=await s.claim('b');
    expect((await s.call('job',{id:b.id})).status).toBe(404);
    expect((await s.call('report',{id:b.id})).status).toBe(404);
    expect(await (await s.call('claim',{id:b.id,claimId:crypto.randomUUID()})).json()).toBe(null);
    for(const action of ['evidence','fail'])expect((await s.call(action,s.evidence(job))).status).toBe(409);
    s.sqlite.prepare("UPDATE review_jobs SET updated_at='unchanged' WHERE id=?").run(b.id);
    expect((await s.call('heartbeat',{job:{id:b.id,lease:job.lease}})).status).toBe(200);
    expect(s.sqlite.prepare('SELECT updated_at FROM review_jobs WHERE id=?').get(b.id)).toMatchObject({updated_at:'unchanged'});
    expect(s.schedule).not.toHaveBeenCalled();
    expect(JSON.stringify(await (await s.call('jobs')).json())).not.toContain(b.id);
  });
  it('网页授权需要本人有效会话与同源请求；指定领取不会取走另一项任务',async()=>{
    const s=setup();
    const password=await hashPassword('fixture-password');
    s.sqlite.prepare("UPDATE members SET password_hash=?,password_salt=? WHERE id='a'").run(password.hash,password.salt);
    const cookie=`pgc_member=${await memberLogin('a','fixture-password',memberStore(s.DB),s.env.SETTINGS_KEY)}`;
    const web=(origin:string,cookieValue=cookie)=>reviewDeviceWeb(new Request('https://fixture.test/api/forge/review/device/pairing',{method:'POST',headers:{Origin:origin,Cookie:cookieValue}}),s.env);
    expect((await web('https://elsewhere.test')).status).toBe(403);
    expect((await web('https://fixture.test','')).status).toBe(401);
    const paired=await (await web('https://fixture.test')).json() as any;
    expect(paired.code).toMatch(/^[a-f0-9]{40}$/);
    expect((await s.call('pair',{deviceId:crypto.randomUUID(),code:paired.code,token:'a'.repeat(64)})).status).toBe(200);
    const first=await s.submit(),second=await s.submit();
    const chosen=await (await s.call('claim',{claimId:crypto.randomUUID(),id:second.id})).json() as any;
    expect(chosen.id).toBe(second.id);
    expect(await (await s.call('job',{id:first.id})).json()).toMatchObject({status:'queued'});
  });
  it('配对码单次使用，令牌仅存摘要；重配同一设备可恢复，失效权限立即阻断',async()=>{
    const s=setup(),id=await s.device('a');
    const row=s.sqlite.prepare('SELECT * FROM review_devices WHERE id=?').get(id) as any;
    expect(row.token_hash).not.toBe('a'.repeat(64));
    expect((await s.call('pair',{deviceId:id,code:'a'.repeat(40),token:'a'.repeat(64)})).status).toBe(200);
    expect((await s.call('pair',{deviceId:crypto.randomUUID(),code:'a'.repeat(40),token:'a'.repeat(64)})).status).toBe(409);
    s.sqlite.exec("UPDATE members SET session_version=2 WHERE id='a'");
    expect((await s.call('jobs')).status).toBe(401);
  });
  it('Agent提交沿用原子额度与幂等；领取仅本人，响应不泄漏模型配置，错误租约被拒绝',async()=>{
    const s=setup();await s.device('a');await s.device('b');s.sqlite.exec("UPDATE members SET daily_review_limit=1 WHERE id='a'");
    const a=await s.submit(),b=await s.submit('b');await s.submit('a',a.id);
    expect(await reviewUsage(s.DB,'a')).toMatchObject({used:1,remaining:0});
    expect((await s.call('submit',{request_id:crypto.randomUUID(),html:'<html></html>'})).status).toBe(429);
    const job=await s.claim();expect(job.id).toBe(a.id);expect(Object.keys(job).sort()).toEqual(['html','id','lease','title']);
    expect(await s.claim('a',job.lease)).toEqual(job);expect(await s.claim()).toBe(null);
    expect((await s.call('job',{id:b.id})).status).toBe(404);
    expect((await s.call('evidence',{...s.evidence(job),lease:crypto.randomUUID()})).status).toBe(409);
    expect((await s.claim('b')).id).toBe(b.id);
  });
  it('证据锁定与幂等，上传失败可恢复；云端模型执行只启动一次，完成后保留报告清理材料',async()=>{
    const s=setup();await s.device('a');const j=await s.submit(),job=await s.claim();
    s.schedule.mockResolvedValueOnce(new Response('unavailable',{status:503}));
    expect((await s.call('evidence',s.evidence(job))).status).toBe(503);
    expect((await s.call('evidence',s.evidence(job))).status).toBe(200);
    const tampered=s.evidence(job);tampered.shots[0].label='changed';
    expect((await s.call('evidence',tampered)).status).toBe(409);
    expect((await s.call('fail',{id:job.id,lease:job.lease})).status).toBe(409);
    vi.mocked(generateReview).mockImplementation(async(_env,_cfg,req)=>{await req.onStart?.();expect(JSON.stringify(req.user)).toContain('ORIGINAL_GAME');return {aes:2,ease:2,play:3,verdict:'模拟通过'};});
    await Promise.all([executeDeviceReview(s.env,j.id),executeDeviceReview(s.env,j.id)]);
    expect(generateReview).toHaveBeenCalledTimes(1);
    const result=await (await s.call('report',{id:j.id})).json() as any;
    expect(result).toMatchObject({score:7,probe:{evidenceOrigin:'member-device'},result:{aes:2}});
    expect(result.shots).toHaveLength(4);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_inputs').get()).toMatchObject({n:0});
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_evidence').get()).toMatchObject({n:0});
    expect(await reviewUsage(s.DB,'a')).toMatchObject({used:1});
  });
  it('采集断线回收lease，模型前失败退次；模型后失败不发布初稿且不退次',async()=>{
    const s=setup();await s.device('a');const j=await s.submit(),job=await s.claim();
    s.sqlite.prepare('UPDATE review_jobs SET updated_at=? WHERE id=?').run(new Date(Date.now()-4*60000).toISOString(),j.id);
    await recoverDeviceReviews(s.DB);const reclaimed=await s.claim();expect(reclaimed.id).toBe(j.id);expect(reclaimed.lease).not.toBe(job.lease);
    expect((await s.call('evidence',s.evidence(job))).status).toBe(409);
    await s.call('fail',{...reclaimed,message:'capture failed'});expect(await reviewUsage(s.DB,'a')).toMatchObject({used:0});
    const next=await s.submit(),claimed=await s.claim();await s.call('evidence',s.evidence(claimed));
    vi.mocked(generateReview).mockImplementation(async(_e,_c,req)=>{await req.onStart?.();throw new Error('verification failed');});
    await executeDeviceReview(s.env,next.id);expect(await reviewUsage(s.DB,'a')).toMatchObject({used:1});
    expect((await s.call('report',{id:next.id})).status).toBe(409);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM reviews').get()).toMatchObject({n:0});
  });
  it('运行中断的alarm不会重放状态未知的模型请求；撤销设备立即失效',async()=>{
    const s=setup();const device=await s.device('a');const j=await s.submit();await s.claim();
    s.sqlite.prepare('UPDATE review_jobs SET evidence_ready=1,model_execution_started_at=?,model_started_at=? WHERE id=?').run('started','started',j.id);
    const state={storage:{get:async()=>j.id,deleteAlarm:vi.fn(),deleteAll:vi.fn()}};
    await new ReviewRunner(state,s.env).alarm();expect(generateReview).not.toHaveBeenCalled();
    expect(await (await s.call('job',{id:j.id})).json()).toMatchObject({status:'error',quota_charged:1});
    s.sqlite.prepare('UPDATE review_devices SET revoked=1 WHERE id=?').run(device);
    expect((await s.call('jobs')).status).toBe(401);
  });
});
