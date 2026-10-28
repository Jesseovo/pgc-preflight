import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {adminWorkspaceApi} from '../server/admin-workspace-api';
import worker from '../server/worker';
import {hashPassword,memberLogin} from '../server/members';
import {memberStore} from '../server/storage';
import {login} from '../server/settings';
import {reviewActivity,reviewDay} from '../server/review-usage';

const databases:DatabaseSync[]=[];
afterEach(()=>{vi.unstubAllGlobals();databases.splice(0).forEach(db=>db.close());});
const report=(comment='SCRIPTED_MANUAL_REPORT')=>({aes:2,ease:3,play:2,score_reasons:{aes:'截图显示清楚的形状。',ease:'操作证据显示触摸有效。',play:'源码提供挑战循环，长期节奏待验证。'},uncertainties:['未验证长期节奏。'],verdict:'通过（7/9）',reviewer_comment:comment,fix_prompt:'无需强制修改。',strengths:['操作与主题对应。'],issues:[]});
async function setup(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const DB:any={prepare(sql:string){let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>{const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>{const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};return s;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const out=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const secrets={ADMIN_PASSWORD:'management-admin',SETTINGS_KEY:'management-secret'},password=await hashPassword('management-password');
  for(const id of ['a','b','plain'])sqlite.prepare('INSERT INTO members(id,username,display_name,password_hash,password_salt,star,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,id,id,password.hash,password.salt,id==='plain'?0:1,'now','now');
  const members=memberStore(DB),cookies:Record<string,string>={admin:`pgc_admin=${await login(secrets.ADMIN_PASSWORD,secrets)}`,'':''};
  for(const id of ['a','b','plain'])cookies[id]=`pgc_member=${await memberLogin(id,'management-password',members,secrets.SETTINGS_KEY)}`;
  const config={enabled:true,encryptedKey:'PRIVATE_ENCRYPTED_KEY',model:'deepseek-flash',baseUrl:'https://fixture.invalid',protocol:'openai',updatedAt:'now'};
  sqlite.prepare("INSERT INTO settings(id,value,updated_at) VALUES('model',?,'now')").run(JSON.stringify(config));
  const send=vi.fn(async()=>{}),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const env:any={...secrets,DB,modelStore:{get:vi.fn(async()=>config)},REVIEW_QUEUE:{send},captureReview:vi.fn(),CHECK_RATE_LIMIT:{limit:async()=>({success:true})},FORGE_RATE_LIMIT:{limit:async()=>({success:true})},BROWSER:{},ASSETS:{fetch:async()=>new Response('fixture')}};
  function request(path:string,method='GET',data?:unknown,owner='admin',extra:Record<string,string>={}){return new Request(`https://management.test/api/admin/${path}`,{method,headers:{Cookie:cookies[owner],Origin:'https://management.test','Content-Type':'application/json',...extra},body:data===undefined?undefined:JSON.stringify(data)});}
  async function call(path:string,method='GET',data?:unknown,owner='admin',extra:Record<string,string>={}){const result=await adminWorkspaceApi(request(path,method,data,owner,extra),env);expect(result).not.toBeNull();return result!;}
  return{sqlite,DB,env,call,request,cookies,send,fetcher};
}

describe('管理员内容管理与手动审核入口',()=>{
  it('管理员成品列表独立于最近选题，支持成员筛选且不返回游戏源码',async()=>{
    const s=await setup();
    const insert=s.sqlite.prepare("INSERT INTO topics(owner_id,batch,subject,medium,gesture,structure,mood,status,data,product_html,created_at,updated_at) VALUES(?,'fixture',?,'pixel','tap','score','calm','made',?,?,?,?)");
    insert.run('a','old-product',JSON.stringify({title:'Member A Game'}),'PRIVATE_GAME_HTML','2000','2000');
    insert.run('b','other-product',JSON.stringify({title:'Member B Game'}),'OTHER_PRIVATE_GAME_HTML','2001','2001');
    for(let i=0;i<301;i++)insert.run('a','recent-topic-'+i,'{}',null,'2026','2026');
    const all=await(await s.call('workspace')).json() as any;expect(all.topics).toHaveLength(300);expect(all.products).toHaveLength(2);
    expect(all.products.find((p:any)=>p.owner_id==='a').data.title).toBe('Member A Game');expect(JSON.stringify(all)).not.toMatch(/PRIVATE_GAME_HTML|OTHER_PRIVATE_GAME_HTML/);
    const mine=await(await s.call('workspace?owner=a')).json() as any;expect(mine.products).toHaveLength(1);expect(mine.products[0].owner_id).toBe('a');
  });
  it('只有管理员可管理公共内容、上传游戏或导入报告，设备令牌不能借Cookie升权',async()=>{
    const s=await setup();
    for(const owner of ['','plain','a'])for(const[path,method]of [['workspace','GET'],['public-data','GET'],['public-data','POST'],['review-upload','POST'],['review-import','POST']] as const)expect((await s.call(path,method,method==='POST'?{}:undefined,owner)).status,`${owner} ${path}`).toBe(403);
    for(const path of ['public-data','review-upload','review-import'])expect((await s.call(path,'POST',{},'admin',{Origin:'https://elsewhere.test'})).status,path).toBe(403);
    expect((await s.call('workspace','GET',undefined,'admin',{Authorization:`Bearer ${'a'.repeat(64)}`})).status).toBe(403);
    expect(s.send).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('管理员通过实际Worker入口显式提交平台审核；重复请求只排队一次',async()=>{
    const s=await setup(),input={request_id:crypto.randomUUID(),title:'ADMIN_UPLOADED_GAME',filename:'admin-game.html',html:'<!doctype html><html><canvas></canvas></html>'};
    const first=await worker.fetch(s.request('review-upload','POST',input),s.env,{waitUntil(){}});expect(first.status).toBe(202);
    const second=await worker.fetch(s.request('review-upload','POST',input),s.env,{waitUntil(){}});expect(second.status).toBe(202);
    expect((await first.json() as any).id).toBe(input.request_id);expect((await second.json() as any).id).toBe(input.request_id);
    expect(s.sqlite.prepare('SELECT owner_id,model_executor,executor,quota_charged FROM review_jobs WHERE id=?').get(input.request_id)).toMatchObject({owner_id:'admin',model_executor:'platform',executor:'cloud',quota_charged:1});
    expect(s.send).toHaveBeenCalledTimes(1);expect(s.env.captureReview).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('手动报告标记管理员来源，幂等导入不扣成员额度，变更回传被拒绝',async()=>{
    const s=await setup(),input={request_id:crypto.randomUUID(),owner_id:'a',title:'ADMIN_IMPORTED_REPORT',filename:'manual.html',result:report(),probe:{captureMethod:'browser-viewport-v1',evidenceOrigin:'member-device',modelExecutor:'agent'},shots:[]};
    const first=await s.call('review-import','POST',input);expect(first.status).toBe(201);const original=await first.json() as any;
    const repeated=await s.call('review-import','POST',input);expect(repeated.status).toBe(200);expect(await repeated.json()).toEqual(original);
    expect((await s.call('review-import','POST',{...input,result:report('CHANGED_RESULT')})).status).toBe(409);
    expect((await s.call('review-import','POST',{...input,owner_id:'b'})).status).toBe(409);
    expect(s.sqlite.prepare('SELECT count(*) n FROM reviews').get()).toMatchObject({n:1});
    const saved=s.sqlite.prepare('SELECT * FROM reviews').get() as any;expect(saved).toMatchObject({id:original.id,owner_id:'a',model_executor:'manual-admin',score:7});
    expect(JSON.parse(saved.probe)).toMatchObject({evidenceOrigin:'admin-upload',modelExecutor:'manual-admin'});
    expect(s.sqlite.prepare('SELECT quota_charged,status,model_executor FROM review_jobs').get()).toMatchObject({quota_charged:0,status:'done',model_executor:'manual-admin'});
    expect(s.sqlite.prepare('SELECT usage_day FROM review_jobs').get()).toMatchObject({usage_day:reviewDay()});
    expect((await reviewActivity(s.DB,new URLSearchParams({scope:'all'}))).total).toBe(1);
    s.sqlite.prepare('UPDATE review_jobs SET usage_day=NULL').run();
    expect((await reviewActivity(s.DB,new URLSearchParams({scope:'all'}))).total).toBe(1);
    expect(s.sqlite.prepare('SELECT count(*) n FROM review_inputs').get()).toMatchObject({n:0});expect(s.send).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('并发导入同报告不重复落库；同编号不同报告只有一份可以提交',async()=>{
    const s=await setup(),same={request_id:crypto.randomUUID(),owner_id:'a',result:report()};
    const duplicate=await Promise.all([s.call('review-import','POST',same),s.call('review-import','POST',same)]);
    for(const result of duplicate)expect([200,201]).toContain(result.status);
    expect(s.sqlite.prepare('SELECT count(*) n FROM reviews WHERE job_id=?').get(same.request_id)).toMatchObject({n:1});
    const request_id=crypto.randomUUID();const results=await Promise.all([s.call('review-import','POST',{request_id,result:report('FIRST')}),s.call('review-import','POST',{request_id,result:report('SECOND')})]);
    expect(results.filter(r=>r.status===201)).toHaveLength(1);expect(results.filter(r=>r.status===409)).toHaveLength(1);
    expect(s.sqlite.prepare('SELECT count(*) n FROM reviews WHERE job_id=?').get(request_id)).toMatchObject({n:1});
  });

  it('不完整报告和无效成员不会生成记录；管理员查看任务时不暴露凭据或材料快照',async()=>{
    const s=await setup();
    expect((await s.call('review-import','POST',{request_id:crypto.randomUUID(),result:{aes:3,ease:3,play:3}})).status).toBe(400);
    expect((await s.call('review-import','POST',{request_id:crypto.randomUUID(),owner_id:'missing-member',result:report()})).status).toBe(404);
    s.sqlite.prepare("INSERT INTO forge_tasks(id,kind,scope,payload,owner_id,executor,input_snapshot,receipt_hash,created_at,updated_at) VALUES('task-a','brief','a:brief:1','PRIVATE_TASK_PAYLOAD','a','agent','PRIVATE_MATERIAL_SNAPSHOT','PRIVATE_RECEIPT_HASH','now','now')").run();
    const response=await s.call('workspace');expect(response.status).toBe(200);const text=await response.text();
    expect(text).toContain('task-a');expect(text).not.toMatch(/PRIVATE_ENCRYPTED_KEY|PRIVATE_TASK_PAYLOAD|PRIVATE_MATERIAL_SNAPSHOT|PRIVATE_RECEIPT_HASH|passwordHash|passwordSalt|sessionVersion/);
    expect(s.sqlite.prepare('SELECT count(*) n FROM reviews').get()).toMatchObject({n:0});
  });

  it('词库建议审批前只保留建议；公共发布与审批仅管理员修改，拒绝后不能再次批准',async()=>{
    const s=await setup(),suggestionId=crypto.randomUUID();
    s.sqlite.prepare("INSERT INTO vocab_suggestions(id,owner_id,task_id,dim,words,created_at,updated_at) VALUES(?,'a',?,'subject',?,'now','now')").run(suggestionId,crypto.randomUUID(),JSON.stringify([{word:'PENDING_PUBLIC_WORD',note:'local model suggestion'}]));
    const gameId=Number(s.sqlite.prepare("INSERT INTO games(title,owner_id) VALUES('A_PRIVATE_GAME','a')").run().lastInsertRowid);
    expect((await s.call('public-data','POST',{action:'suggestion-approve',id:suggestionId},'a')).status).toBe(403);
    expect(s.sqlite.prepare('SELECT count(*) n FROM vocab').get()).toMatchObject({n:0});
    expect((await s.call('public-data','POST',{action:'suggestion-approve',id:suggestionId})).status).toBe(200);
    expect((await s.call('public-data','POST',{action:'suggestion-approve',id:suggestionId})).status).toBe(200);
    expect(s.sqlite.prepare("SELECT count(*) n FROM vocab WHERE word='PENDING_PUBLIC_WORD'").get()).toMatchObject({n:1});
    expect((await s.call('public-data','POST',{action:'publish-game',id:gameId})).status).toBe(200);
    expect(s.sqlite.prepare('SELECT is_public FROM games WHERE id=?').get(gameId)).toMatchObject({is_public:1});
    const rejectedId=crypto.randomUUID();s.sqlite.prepare("INSERT INTO vocab_suggestions(id,owner_id,task_id,dim,words,created_at,updated_at) VALUES(?,'a',?,'subject',?,'now','now')").run(rejectedId,crypto.randomUUID(),JSON.stringify([{word:'REJECTED_WORD'}]));
    await s.call('public-data','POST',{action:'suggestion-reject',id:rejectedId});await s.call('public-data','POST',{action:'suggestion-approve',id:rejectedId});
    expect(s.sqlite.prepare("SELECT count(*) n FROM vocab WHERE word='REJECTED_WORD'").get()).toMatchObject({n:0});
  });
});
