import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {reviewDeviceApi} from '../server/review-device-api';
import {canonicalJson,digest,recoverDeviceReviews} from '../server/review-device-state';
import {enqueueReview,getReviewJob,processReviewJob,purgeReviewInputs} from '../server/review-jobs';
import {executeDeviceReview,ReviewRunner} from '../server/review-runner';
import {reviewUsage} from '../server/review-usage';
import {REVIEW_SCHEMA,REVIEW_VERIFICATION} from '../server/forge/prompts.js';

const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.restoreAllMocks();});
const report=()=>({aes:2,ease:2,play:3,score_reasons:{aes:'frame-0 可见清晰配色',ease:'frame-1 可见操作提示',play:'源码推断核心循环，尚未完成完整试玩'},uncertainties:['真实手感需人工试玩'],verdict:'模拟通过',reviewer_comment:'合成审核意见',strengths:['画面层级清楚'],issues:[],fix_prompt:'依据已观察到的证据修改'});
async function setup(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  for(const id of ['a','b'])sqlite.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,daily_review_limit) VALUES(?,?,?,'unused','unused','now','now',0)").run(id,id,id);
  const DB:any={prepare(sql:string){let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>{const r=sqlite.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>sqlite.prepare(sql).run(...params)};return s;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const out=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const modelGet=vi.fn(async()=>{throw new Error('Local work must not read platform model configuration');}),schedule=vi.fn(async()=>Response.json({ok:true})),send=vi.fn(async()=>{});
  const env={DB,SETTINGS_KEY:'fixture',ADMIN_PASSWORD:'fixture',modelStore:{get:modelGet},REVIEW_QUEUE:{send},REVIEW_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:schedule})}};
  const tokens={a:'a'.repeat(64),b:'b'.repeat(64),a2:'c'.repeat(64)},devices:Record<string,string>={};
  for(const [name,token] of Object.entries(tokens)){
    devices[name]=crypto.randomUUID();
    sqlite.prepare('INSERT INTO review_devices(id,owner_id,session_version,token_hash,pairing_hash,name,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(devices[name],name==='a2'?'a':name,'1',await digest(token),name,name,new Date(Date.now()+86400000).toISOString(),new Date().toISOString());
  }
  const call=(action:string,body:any={},device:keyof typeof tokens='a')=>reviewDeviceApi(new Request(`https://fixture.test/api/review-device/${action}`,{method:'POST',headers:{Authorization:`Bearer ${tokens[device]}`,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
  async function ok(action:string,body:any={},device:keyof typeof tokens='a'){
    const res=await call(action,body,device),value=await res.json() as any;
    expect(res.status,JSON.stringify(value)).toBe(200);return value;
  }
  async function submit(device:keyof typeof tokens='a',id=crypto.randomUUID()){
    return ok('submit',{request_id:id,title:'Original fixture',filename:'fixture.html',html:'<html><title>ORIGINAL_GAME</title><canvas></canvas></html>',model_executor:'platform'},device);
  }
  const claim=(id:string,device:keyof typeof tokens='a')=>ok('claim',{id,claimId:crypto.randomUUID()},device);
  const evidence=(job:any)=>({id:job.id,lease:job.lease,probe:{captureMethod:'browser-viewport-v1',observations:[]},shots:Array.from({length:4},(_,i)=>({label:`frame-${i}`,data:'data:image/jpeg;base64,YQ=='}))});
  async function ready(){const submitted=await submit(),job=await claim(submitted.id),accepted=await ok('evidence',evidence(job));return {...job,evidenceHash:accepted.evidenceHash};}
  const draftBody=(job:any)=>({id:job.id,lease:job.lease,evidenceHash:job.evidenceHash,model:'member-owned-model',report:report()});
  async function verified(job:any){const draft=draftBody(job),saved=await ok('draft',draft);return {...draft,verification:{confirmed:true,model:draft.model,evidenceHash:job.evidenceHash,draftHash:saved.draftHash}};}
  return {sqlite,DB,env,devices,call,ok,submit,claim,evidence,ready,draftBody,verified,modelGet,schedule,send};
}

describe('成员 Agent 本地模型审核协议',()=>{
  it('无平台配置和每日模型次数也可提交，默认零扣次，不接受设备切到平台执行且无50任务上限',async()=>{
    const s=await setup(),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No network model requests'));
    const first=await s.submit();await s.submit('a',first.id);
    for(let i=0;i<51;i++)await s.submit();
    expect(first).toMatchObject({model_executor:'agent',quota_charged:0,status:'queued'});
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_jobs').get()).toMatchObject({n:52});
    expect(await reviewUsage(s.DB,'a')).toMatchObject({limit:0,used:0});
    expect(s.sqlite.prepare("SELECT COUNT(*) n FROM review_jobs WHERE executor!='device' OR model_executor!='agent' OR quota_charged!=0").get()).toMatchObject({n:0});
    expect(s.modelGet).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it('初评与相同模型复核使用统一标准、原证据和草稿，发布保留来源并清理临时输入',async()=>{
    const s=await setup(),fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No model requests'));
    const job=await s.ready(),material=await s.ok('material',job);
    expect(material).toMatchObject({stage:'review',schema:REVIEW_SCHEMA,verification:REVIEW_VERIFICATION,evidenceHash:job.evidenceHash,evidenceOrigin:'member-device'});
    expect(JSON.stringify(material.user)).toContain('ORIGINAL_GAME');
    expect(material.user.filter((part:any)=>part.type==='image')).toHaveLength(4);
    const body=await s.verified(job),verify=await s.ok('material',job);
    expect(verify.system).toContain(REVIEW_VERIFICATION);expect(verify.draft).toEqual(report());expect(verify.draftHash).toBe(body.verification.draftHash);expect(verify.stage).toBe('verify');
    const done=await s.ok('complete',body),saved=await s.ok('report',{id:job.id});
    expect(done).toMatchObject({status:'done',result_id:saved.id});
    expect(saved).toMatchObject({score:7,model_executor:'agent',model:'member-owned-model',agent_id:s.devices.a,evidence_hash:job.evidenceHash,probe:{evidenceOrigin:'member-device',modelExecutor:'agent'},result:report()});
    expect(saved.shots).toHaveLength(4);
    for(const table of ['review_inputs','review_evidence','review_material'])expect(s.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toMatchObject({n:0});
    expect(await reviewUsage(s.DB,'a')).toMatchObject({used:0});expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it('首次读取锁定规则和校准，复核与并发读取沿用同一材料，新任务使用新规则',async()=>{
    const s=await setup();
    s.sqlite.prepare("INSERT INTO settings(id,value,updated_at) VALUES('redlines','ORIGINAL_POLICY','now')").run();
    s.sqlite.prepare("INSERT INTO games(title,owner_id,is_public,status,score,aes,ease,play) VALUES('ORIGINAL_CALIBRATION','a',0,'approved',9,3,3,3)").run();
    const job=await s.ready(),responses=await Promise.all(Array.from({length:4},()=>s.ok('material',job))),first=responses[0];
    expect(responses).toEqual(Array(4).fill(first));
    const stored=s.sqlite.prepare('SELECT data FROM review_material WHERE job_id=? ORDER BY part').all(job.id).map((part:any)=>part.data).join('');
    expect(stored).not.toContain('data:image/jpeg;base64');expect(stored).toContain('"index":0');
    expect(first.system).toContain('ORIGINAL_POLICY');expect(first.system).toContain('ORIGINAL_CALIBRATION');
    s.sqlite.prepare("UPDATE settings SET value='CHANGED_POLICY' WHERE id='redlines'").run();
    s.sqlite.prepare("UPDATE games SET title='CHANGED_CALIBRATION' WHERE title='ORIGINAL_CALIBRATION'").run();
    const again=await s.ok('material',job);expect(again.system).toBe(first.system);expect(again.user).toEqual(first.user);
    await s.ok('draft',s.draftBody(job));const verify=await s.ok('material',job);
    expect(verify.system).toBe(`${first.system}\n\n${first.verification}`);expect(verify.user.slice(0,-1)).toEqual(first.user);expect(verify.schema).toEqual(first.schema);
    const next=await s.ready(),nextMaterial=await s.ok('material',next);
    expect(nextMaterial.system).toContain('CHANGED_POLICY');expect(nextMaterial.system).toContain('CHANGED_CALIBRATION');expect(nextMaterial.system).not.toContain('ORIGINAL_POLICY');
  });
  it('较长材料分片保存并完整还原，快照不重复保存四张截图',async()=>{
    const s=await setup(),html=`<html><script>\n${Array.from({length:3500},(_,i)=>`const line${i}='${'x'.repeat(40)}';`).join('\n')}\n// LAST_REVIEW_LINE\n</script></html>`;
    const submitted=await s.ok('submit',{request_id:crypto.randomUUID(),title:'Long material',html}),job=await s.claim(submitted.id);await s.ok('evidence',s.evidence(job));
    const material=await s.ok('material',job),parts=s.sqlite.prepare('SELECT part,data FROM review_material WHERE job_id=? ORDER BY part').all(job.id) as Array<{part:number;data:string}>;
    expect(parts.length).toBeGreaterThan(1);expect(parts.every(part=>part.data.length<=120000)).toBe(true);
    const text=parts.map(part=>part.data).join(''),stored=JSON.parse(text);expect(text).not.toContain('data:image/jpeg;base64');expect(stored.user.at(-1).text).toContain('LAST_REVIEW_LINE');
    expect(material.user.at(-1).text).toBe(stored.user.at(-1).text);expect(material.user.filter((part:any)=>part.type==='image')).toHaveLength(4);
    expect(s.sqlite.prepare('SELECT local_material_hash FROM review_jobs WHERE id=?').get(job.id)).toMatchObject({local_material_hash:await digest(canonicalJson(stored))});
  });
  it('证据、初稿和已发布报告不可更换，相同重传和改变JSON字段顺序保持幂等',async()=>{
    const s=await setup(),job=await s.ready(),draft=s.draftBody(job);
    await s.ok('evidence',s.evidence(job));
    const changed=s.evidence(job);changed.shots[0].label='different';expect((await s.call('evidence',changed)).status).toBe(409);
    const initial=await s.ok('draft',draft);expect(await s.ok('draft',draft)).toMatchObject({draftHash:initial.draftHash});
    expect((await s.call('draft',{...draft,report:{...draft.report,aes:3}})).status).toBe(409);
    expect((await s.call('draft',{...draft,model:'different-model'})).status).toBe(409);
    const body=await s.verified(job),first=await s.ok('complete',body);
    const reordered={...body,report:Object.fromEntries(Object.entries(body.report).reverse())};
    expect(await s.ok('complete',reordered)).toMatchObject({result_id:first.result_id,resultHash:first.resultHash});
    expect((await s.call('complete',{...body,report:{...body.report,reviewer_comment:'replacement'}})).status).toBe(409);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM reviews').get()).toMatchObject({n:1});
    expect((await s.call('evidence',changed)).status).toBe(409);
  });
  it('没有有效初稿、原证据或同模型复核凭据不能发布，结构失败不生成报告',async()=>{
    const s=await setup(),job=await s.ready(),draft=s.draftBody(job);
    expect((await s.call('complete',draft)).status).toBe(409);
    expect((await s.call('draft',{...draft,evidenceHash:'wrong'})).status).toBe(409);
    expect((await s.call('draft',{...draft,report:{...draft.report,score_reasons:{aes:''}}})).status).toBe(400);
    expect((await s.call('draft',{...draft,report:{...draft.report,extra:true}})).status).toBe(400);
    const body=await s.verified(job);
    for(const value of [{...body,model:'another-model'},{...body,verification:{...body.verification,confirmed:false}},{...body,verification:{...body.verification,evidenceHash:'wrong'}},{...body,verification:{...body.verification,draftHash:'wrong'}},{...body,verification:{...body.verification,model:'wrong'}}])expect((await s.call('complete',value)).status).toBe(409);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM reviews').get()).toMatchObject({n:0});
    expect(await getReviewJob(s.env,job.id,'a')).toMatchObject({status:'running',stage:'verify',quota_charged:0});
  });
  it('初稿并发相同内容幂等，不同内容仅一个获胜且锁定获胜模型与草稿',async()=>{
    const s=await setup(),job=await s.ready(),body=s.draftBody(job);
    const repeated=await Promise.all(Array.from({length:6},()=>s.call('draft',body)));
    expect(repeated.map(response=>response.status)).toEqual(Array(6).fill(200));
    const receipts=await Promise.all(repeated.map(response=>response.json() as Promise<any>));
    expect(new Set(receipts.map(value=>value.draftHash)).size).toBe(1);
    const other=await s.ready(),a=s.draftBody(other),b={...a,model:'other-member-model',report:{...a.report,reviewer_comment:'other valid draft'}};
    const contenders=await Promise.all([s.call('draft',a),s.call('draft',b)]);
    expect(contenders.map(response=>response.status).sort()).toEqual([200,409]);
    const winner=contenders[0].status===200?a:b,persisted=s.sqlite.prepare('SELECT local_draft,local_model FROM review_jobs WHERE id=?').get(other.id) as any;
    expect(persisted.local_draft).toBe(canonicalJson(winner.report));expect(persisted.local_model).toBe(winner.model);
  });
  it('完成并发相同报告返回同一结果，不同报告仅一个获胜，报告内容与锁定hash始终对应',async()=>{
    const s=await setup(),job=await s.ready(),body=await s.verified(job);
    const repeated=await Promise.all(Array.from({length:6},()=>s.call('complete',body)));
    expect(repeated.map(response=>response.status)).toEqual(Array(6).fill(200));
    const receipts=await Promise.all(repeated.map(response=>response.json() as Promise<any>));
    expect(new Set(receipts.map(value=>value.resultHash)).size).toBe(1);expect(new Set(receipts.map(value=>value.result_id)).size).toBe(1);
    const other=await s.ready(),a=await s.verified(other),b={...a,report:{...a.report,aes:3,reviewer_comment:'different valid final report'}};
    const contenders=await Promise.all([s.call('complete',a),s.call('complete',b)]);
    expect(contenders.map(response=>response.status).sort()).toEqual([200,409]);
    const winner=contenders[0].status===200?a:b,saved=await s.ok('report',{id:other.id}),persisted=s.sqlite.prepare('SELECT local_result_hash FROM review_jobs WHERE id=?').get(other.id) as any;
    expect(saved.result).toEqual(winner.report);
    expect(persisted.local_result_hash).toBe(await digest(canonicalJson({report:winner.report,model:winner.model,evidenceHash:winner.evidenceHash,draftHash:winner.verification.draftHash})));
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM reviews').get()).toMatchObject({n:2});
  });
  it('INSERT冲突不能把不同的持久报告当作当前请求完成或更换内容hash',async()=>{
    const s=await setup(),job=await s.ready(),body=await s.verified(job);
    s.sqlite.prepare("INSERT INTO reviews(owner_id,title,result,probe,created_at,job_id,model_executor,agent_id,model,evidence_hash) VALUES('a','conflict',?,'{}','now',?,'agent',?,?,?)").run(canonicalJson({...body.report,reviewer_comment:'existing other report'}),job.id,s.devices.a,body.model,job.evidenceHash);
    expect((await s.call('complete',body)).status).toBe(409);
    expect(s.sqlite.prepare('SELECT status,result_id FROM review_jobs WHERE id=?').get(job.id)).toMatchObject({status:'running',result_id:null});
    expect(JSON.parse(String(s.sqlite.prepare('SELECT result FROM reviews WHERE job_id=?').get(job.id)?.result)).reviewer_comment).toBe('existing other report');
  });
  it('成员和本人其他设备无法取走任务、材料、续心跳或提交报告，私有校准与选题不外泄',async()=>{
    const s=await setup();
    s.sqlite.prepare("INSERT INTO games(title,owner_id,is_public,status,score,aes,ease,play) VALUES('PRIVATE_MEMBER_B','b',0,'approved',9,3,3,3),('PUBLIC_CALIBRATION','b',1,'approved',9,3,3,3),('OWN_CALIBRATION','a',0,'approved',9,3,3,3)").run();
    const t=s.sqlite.prepare("INSERT INTO topics(batch,subject,medium,gesture,structure,mood,created_at,updated_at,owner_id) VALUES('fixture','secret-b','','','','','now','now','b')").run();
    expect((await s.call('submit',{request_id:crypto.randomUUID(),html:'<html/>',topic_id:Number(t.lastInsertRowid)})).status).toBe(404);
    const job=await s.ready(),body=await s.verified(job);
    expect((await s.call('job',{id:job.id},'b')).status).toBe(404);
    expect(await s.claim(job.id,'b')).toBe(null);expect(await s.claim(job.id,'a2')).toBe(null);
    for(const action of ['material','draft','complete','evidence','fail']){
      expect((await s.call(action,action==='evidence'?s.evidence(job):body,'b')).status,action).toBe(409);
      expect((await s.call(action,action==='evidence'?s.evidence(job):body,'a2')).status,action).toBe(409);
    }
    const old=new Date(Date.now()-20*60000).toISOString();s.sqlite.prepare('UPDATE review_jobs SET updated_at=? WHERE id=?').run(old,job.id);
    await s.ok('heartbeat',{job},'b');expect(s.sqlite.prepare('SELECT updated_at FROM review_jobs WHERE id=?').get(job.id)).toMatchObject({updated_at:old});
    const material=JSON.stringify(await s.ok('material',job));expect(material).not.toContain('PRIVATE_MEMBER_B');expect(material).toContain('PUBLIC_CALIBRATION');expect(material).toContain('OWN_CALIBRATION');
    await s.ok('complete',body);expect((await s.call('report',{id:job.id},'b')).status).toBe(404);
  });
  it('断线保留原设备租约，采集后可启动另一款；长本地推理不被旧15分钟看门狗中断',async()=>{
    const s=await setup(),first=await s.submit(),job=await s.claim(first.id),second=await s.submit();
    expect(await s.claim(second.id)).toBe(null);
    s.sqlite.prepare('UPDATE review_jobs SET updated_at=? WHERE id=?').run(new Date(Date.now()-20*60000).toISOString(),job.id);
    await recoverDeviceReviews(s.DB);expect(await s.claim(first.id)).toMatchObject({lease:job.lease});
    await s.ok('evidence',s.evidence(job));expect(await s.claim(second.id)).toMatchObject({id:second.id});
    s.sqlite.prepare('UPDATE review_jobs SET updated_at=? WHERE id=?').run(new Date(Date.now()-20*60000).toISOString(),job.id);
    expect(await getReviewJob(s.env,job.id,'a')).toMatchObject({status:'running',stage:'review'});
    await s.ok('heartbeat',{job});expect(await getReviewJob(s.env,job.id,'a')).toMatchObject({status:'running'});
    expect(s.schedule).not.toHaveBeenCalled();
  });
  it('本地任务不会触发兼容队列或模型alarm，残留alarm也不把本地任务标为失败',async()=>{
    const s=await setup(),job=await s.ready(),evaluate=vi.fn(),put=vi.fn(),setAlarm=vi.fn();
    await processReviewJob(s.env,job.id,evaluate);await executeDeviceReview(s.env,job.id);
    const state={storage:{put,get:async()=>job.id,setAlarm,getAlarm:async()=>null,deleteAlarm:vi.fn(),deleteAll:vi.fn()}};
    const runner=new ReviewRunner(state,s.env);expect((await runner.fetch(new Request('https://internal/schedule',{method:'POST',body:job.id}))).status).toBe(409);
    await runner.alarm();expect(put).not.toHaveBeenCalled();expect(setAlarm).not.toHaveBeenCalled();expect(evaluate).not.toHaveBeenCalled();expect(s.modelGet).not.toHaveBeenCalled();
    expect(await getReviewJob(s.env,job.id,'a')).toMatchObject({status:'running',model_executor:'agent'});
  });
  it('失败和24小时无活动清理材料，仍活跃的旧任务材料可继续使用，停权立即拒绝',async()=>{
    const s=await setup(),job=await s.ready();await s.ok('material',job);await s.ok('fail',{...job,message:'local verification unavailable'});
    expect(await getReviewJob(s.env,job.id,'a')).toMatchObject({status:'error',error:'local verification unavailable',quota_charged:0});
    for(const table of ['review_inputs','review_evidence','review_material'])expect(s.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toMatchObject({n:0});
    const active=await s.ready(),inactive=await s.ready(),old=new Date(Date.now()-25*3600000).toISOString();
    await s.ok('material',active);await s.ok('material',inactive);
    s.sqlite.prepare('UPDATE review_jobs SET created_at=? WHERE id=?').run(old,active.id);
    s.sqlite.prepare('UPDATE review_jobs SET created_at=?,updated_at=? WHERE id=?').run(old,old,inactive.id);
    for(const table of ['review_inputs','review_evidence','review_material'])s.sqlite.prepare(`UPDATE ${table} SET created_at=?`).run(old);
    await purgeReviewInputs(s.env);
    expect(await getReviewJob(s.env,inactive.id,'a')).toMatchObject({status:'error'});
    for(const table of ['review_inputs','review_evidence','review_material']){expect(s.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE job_id=?`).get(inactive.id)).toMatchObject({n:0});expect(Number(s.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE job_id=?`).get(active.id)?.n)).toBeGreaterThan(0);}
    expect((await s.ok('material',active)).stage).toBe('review');
    s.sqlite.exec("UPDATE members SET can_review=0 WHERE id='a'");expect((await s.call('material',active)).status).toBe(401);
  });
  it('网站默认入队同样只创建本地任务，禁用成员无权提交',async()=>{
    const s=await setup();const job=await enqueueReview(s.env,{request_id:crypto.randomUUID(),html:'<html/>'},'a');expect(job).toMatchObject({model_executor:'agent',quota_charged:0});
    s.sqlite.exec("UPDATE members SET enabled=0 WHERE id='b'");await expect(enqueueReview(s.env,{request_id:crypto.randomUUID(),html:'<html/>'},'b')).rejects.toMatchObject({status:403});
    expect(s.modelGet).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled();
  });
  it('自包含CLI review返回可读材料和四图，draft/complete文件输入往返且wait不会空等平台模型',async()=>{
    const s=await setup(),job=await s.ready(),directory=await mkdtemp(join(tmpdir(),'pgc-local-review-'));
    const server=createServer(async(req,res)=>{
      try{
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
        const response=await reviewDeviceApi(new Request(`http://127.0.0.1${req.url}`,{method:'POST',headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}),s.env);
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
      }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
    });
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    try{
      const address=server.address() as {port:number},bundle=join(directory,'review-agent.mjs'),out=join(directory,'materials');
      await build({entryPoints:['scripts/review-agent.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import{createRequire as __pgcCreateRequire}from'node:module';const require=__pgcCreateRequire(import.meta.url);"}});
      const run=(args:string[])=>new Promise<any[]>((done,reject)=>{
        const child=spawn(process.execPath,[bundle,...args],{windowsHide:true,env:{...process.env,PGC_ORIGIN:`http://127.0.0.1:${address.port}`,PGC_AGENT_DATA:join(directory,'private'),PGC_WORKER_TOKEN:'a'.repeat(64)}});
        let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
        const timer=setTimeout(()=>{child.kill();reject(new Error('Local CLI unexpectedly waited for platform model'));},15000);
        child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(stderr));else done(stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));});
      });
      const game=join(directory,'fixture.html');await writeFile(game,'<html>fixture</html>');
      const output=await run(['review',game,'--request-id',job.id,'--out',out]),material=output.find(value=>value.event==='material');
      expect(material.screenshots).toHaveLength(4);expect(JSON.parse(await readFile(material.materialPath,'utf8'))).toMatchObject({schema:REVIEW_SCHEMA,evidenceHash:job.evidenceHash});
      for(const shot of material.screenshots)expect((await readFile(shot.path)).toString()).toBe('a');
      expect((await run(['wait',job.id])).find(value=>value.event==='action_required')).toMatchObject({jobId:job.id});
      const draftPath=join(directory,'draft.json');await writeFile(draftPath,JSON.stringify(s.draftBody(job)));
      const drafted=(await run(['draft',job.id,'--json',draftPath])).find(value=>value.event==='draft');expect(drafted.stage).toBe('verify');
      const verified={...s.draftBody(job),verification:{confirmed:true,model:'member-owned-model',evidenceHash:job.evidenceHash,draftHash:drafted.draftHash}},finalPath=join(directory,'final.json');
      await writeFile(finalPath,JSON.stringify(verified));const complete=await run(['complete',job.id,'--json',finalPath]);
      expect(complete.find(value=>value.event==='report').report).toMatchObject({model_executor:'agent',model:'member-owned-model',result:report()});
      expect((await run(['complete',job.id,'--json',finalPath])).find(value=>value.event==='complete').status).toBe('done');
      const repeated=await run(['review',game,'--request-id',job.id,'--out',out]);
      expect(repeated.find(value=>value.event==='report').report).toMatchObject({id:complete.find(value=>value.event==='report').report.id,result:report()});
      expect(JSON.parse(await readFile(join(out,`${job.id}.json`),'utf8')).result).toEqual(report());
      expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_jobs').get()).toMatchObject({n:1});expect(s.sqlite.prepare('SELECT COUNT(*) n FROM reviews').get()).toMatchObject({n:1});
      expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();
    }finally{
      await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
      const target=resolve(directory),parent=resolve(tmpdir());
      if(!target.startsWith(parent+sep)||!target.split(sep).at(-1)?.startsWith('pgc-local-review-'))throw new Error('Unexpected temporary test path');
      await rm(target,{recursive:true,force:true});
    }
  },30000);
});
