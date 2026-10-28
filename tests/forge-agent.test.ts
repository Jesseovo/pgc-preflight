import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {forgeAgentApi,forgeAgentWeb} from '../server/forge-agent-api';
import {forgeApi} from '../server/forge-api';
import {executeForgeTask} from '../server/forge-runner';
import {hashPassword,memberLogin,updateMember} from '../server/members';
import {memberStore} from '../server/storage';
import {login} from '../server/settings';
import {adminWorkspaceApi} from '../server/admin-workspace-api';

const databases:DatabaseSync[]=[];
afterEach(()=>{vi.unstubAllGlobals();databases.splice(0).forEach(db=>db.close());});
async function setup(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const DB:any={prepare(sql:string){let params:any[]=[];const s:any={bind(...p:any[]){if(p.length>100)throw new Error('D1 statement exceeds 100 bound parameters');params=p;return s;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>{const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>{const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};return s;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const out=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const secrets={ADMIN_PASSWORD:'agent-admin',SETTINGS_KEY:'agent-secret'},password=await hashPassword('agent-password');
  for(const id of ['a','b','plain'])sqlite.prepare('INSERT INTO members(id,username,display_name,password_hash,password_salt,star,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,id,id,password.hash,password.salt,id==='plain'?0:1,'now','now');
  for(const[dim,word]of [['medium','pixel'],['gesture','tap'],['structure','rhythm'],['mood','calm']])sqlite.prepare('INSERT INTO vocab(dim,word) VALUES(?,?)').run(dim,word);
  const members=memberStore(DB),cookies:Record<string,string>={admin:`pgc_admin=${await login(secrets.ADMIN_PASSWORD,secrets)}`};
  for(const id of ['a','b','plain'])cookies[id]=`pgc_member=${await memberLogin(id,'agent-password',members,secrets.SETTINGS_KEY)}`;
  const modelStore={get:vi.fn(async()=>({enabled:true,encryptedKey:'PRIVATE_MODEL_KEY',model:'PRIVATE_CLOUD_MODEL',baseUrl:'https://private-model.invalid',protocol:'openai'}))};
  const schedule=vi.fn(async()=>Response.json({ok:true})),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const env:any={...secrets,DB,modelStore,FORGE_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:schedule})}};
  const tokens:Record<string,string>={a:'a'.repeat(64),b:'b'.repeat(64),second:'c'.repeat(64),plain:'d'.repeat(64)};
  function call(action:string,data:unknown={},device='a',headers:Record<string,string>={}){return forgeAgentApi(new Request(`https://agent.test/api/forge-agent/${action}`,{method:'POST',headers:{Authorization:`Bearer ${tokens[device]||device}`,'Content-Type':'application/json',...headers},body:JSON.stringify(data)}),env);}
  function web(action:string,owner='a',data?:unknown,origin='https://agent.test'){return forgeAgentWeb(new Request(`https://agent.test/api/forge/agent/${action}`,{method:action==='devices'?'GET':'POST',headers:{Cookie:cookies[owner],Origin:origin,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)}),env);}
  async function pair(owner='a',device=owner){
    const authorization=await web('pairing',owner);expect(authorization.status).toBe(200);
    const {code}=await authorization.json() as any;const deviceId=crypto.randomUUID();
    const response=await call('pair',{deviceId,code,token:tokens[device],name:`${owner} fixture`},device);expect(response.status).toBe(200);
    return{deviceId,code};
  }
  const topic=(owner='a',title='A_PRIVATE_TOPIC')=>Number(sqlite.prepare("INSERT INTO topics(batch,subject,medium,gesture,structure,mood,status,data,brief_md,owner_id,created_at,updated_at) VALUES('fixture',?,'pixel','tap','rhythm','calm','liked',?,'ORIGINAL_BRIEF',?,?,?)").run(`${owner}-subject`,JSON.stringify({title,core_loop:'Catch stars',controls:'Tap',art_direction:'Pixel'}),owner,new Date().toISOString(),new Date().toISOString()).lastInsertRowid);
  async function create(id:number,kind='brief',device='a',requestId=crypto.randomUUID()){
    const response=await call('create',{request_id:requestId,kind,id},device);expect(response.status).toBe(200);
    const result=await response.json() as any;expect(result.tasks).toHaveLength(1);return result.tasks[0];
  }
  async function claim(id:string,device='a',receipt='e'.repeat(64),claimId=crypto.randomUUID()){
    const response=await call('claim',{id,claimId,receipt},device);expect(response.status).toBe(200);
    return{...(await response.json() as any),receipt,claimId};
  }
  return{sqlite,DB,env,members,cookies,call,web,pair,topic,create,claim,schedule,fetcher};
}

async function page(s:Awaited<ReturnType<typeof setup>>,path:string,method='GET',data?:any,owner='a'){
  return forgeApi(new Request(`https://agent.test/api/forge/${path}`,{method,headers:{Cookie:s.cookies[owner],Origin:'https://agent.test','Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)}),s.env,path.split('/'),s.members);
}
const assetScript='const GAME_ASSETS={meta:{style:"pixel"},sprites:{star(ctx){ctx.fillRect(0,0,4,4)}}};';
const assetsHtml=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><canvas></canvas><script id="game-assets">${assetScript}</script></body></html>`;
const gameHtml=assetsHtml.replace('</body>','<script>GAME_ASSETS.sprites.star(document.querySelector("canvas").getContext("2d"));</script></body>');

describe('成员个人 Agent 的权限、租约与结果版本',()=>{
  it('扩写到成品逐步保存带来源的不可覆盖版本，资产原样复用；恢复另存版本并标记下游过时',async()=>{
    const s=await setup();await s.pair();const id=s.topic(),other=s.topic('b');
    const outputs:any={expand:{title:'Local stars',core_loop:'Catch stars',controls:'Tap',art_direction:'Pixel',aes:3,ease:2,play:3},brief:'## F. LOCAL_BRIEF',preview:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',assets:assetsHtml,game:gameHtml};
    const versions:any={};
    for(const kind of ['expand','brief','preview','assets','game']){
      const task=await s.create(id,kind),lease=await s.claim(task.id);
      expect(Number.isFinite(Date.parse(task.created_at))).toBe(true);expect(Number.isFinite(Date.parse(lease.task.started_at))).toBe(true);
      if(kind==='game'){
        expect(lease.materials.user).toContain(assetScript);
        expect((await s.call('complete',{id:task.id,receipt:lease.receipt,result:gameHtml.replace(assetScript,'const GAME_ASSETS={};')})).status).toBe(400);
      }
      const response=await s.call('complete',{id:task.id,receipt:lease.receipt,result:outputs[kind],model:'my-local-model'});expect(response.status,await response.clone().text()).toBe(200);
      const result=await response.json() as any;expect(result.disposition).toBe('current');versions[kind]=result.version_id;
      expect(s.sqlite.prepare('SELECT owner_id,executor,model,device_id,input_revision FROM artifact_versions WHERE id=?').get(result.version_id)).toMatchObject({owner_id:'a',executor:'agent',model:'my-local-model',device_id:expect.any(String),input_revision:Object.keys(versions).length-1});
    }
    const row=s.sqlite.prepare('SELECT status,content_revision,product_html FROM topics WHERE id=?').get(id) as any;expect(row.status).toBe('made');expect(row.content_revision).toBe(5);expect(row.product_html).toContain(assetScript);
    const list=await (await page(s,`topics/${id}/versions`)).json() as any[];expect(list).toHaveLength(5);expect(list.every(v=>v.current&&!v.stale)).toBe(true);
    const preview=await page(s,`topics/${id}/product-preview`);expect(preview.status).toBe(200);expect(preview.headers.get('Content-Security-Policy')).toContain('sandbox');
    const attachment=await page(s,`topics/${id}/product-file`);expect(attachment.headers.get('Content-Disposition')).toContain('attachment');
    const oldBrief=s.sqlite.prepare('SELECT content FROM artifact_versions WHERE id=?').get(versions.brief);
    const restore=await page(s,`topics/${id}/restore`,'POST',{version_id:versions.brief});expect(restore.status).toBe(200);const restored=await restore.json() as any;expect(restored.id).not.toBe(versions.brief);expect(restored.restored_from).toBe(versions.brief);
    expect(s.sqlite.prepare('SELECT content FROM artifact_versions WHERE id=?').get(versions.brief)).toEqual(oldBrief);
    const after=await (await page(s,`topics/${id}/versions`)).json() as any[];expect(after.find(v=>v.id===versions.game).stale).toBe(true);
    expect((await page(s,`topics/${id}/versions/${versions.game}`,'GET',undefined,'b')).status).toBe(404);
    expect((await page(s,`topics/${other}/restore`,'POST',{version_id:versions.brief})).status).toBe(404);
    expect((await page(s,`topics/${id}/restore`,'POST',{version_id:versions.brief},'b')).status).toBe(404);
    expect(s.env.modelStore.get).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('任务领取使用最新选题与公共材料，重复领取保持原快照；公共规则后续变化令结果待采用',async()=>{
    const s=await setup();await s.pair();const id=s.topic(),task=await s.create(id);
    s.sqlite.prepare("INSERT INTO settings(id,value,updated_at) VALUES('template','LATEST_TEMPLATE:',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(new Date().toISOString());
    s.sqlite.prepare("UPDATE topics SET requirements='LATEST_REQUIREMENT',content_revision=content_revision+1 WHERE id=?").run(id);
    const lease=await s.claim(task.id);expect(lease.materials.requirements).toBe('LATEST_REQUIREMENT');
    const saved=JSON.parse((s.sqlite.prepare('SELECT input_snapshot FROM forge_tasks WHERE id=?').get(task.id) as any).input_snapshot);expect(saved.cfg.template).toBe('LATEST_TEMPLATE:');expect(saved.revision).toBe(1);
    s.sqlite.prepare("UPDATE settings SET value='NEWER_TEMPLATE:' WHERE id='template'").run();
    const again=await s.claim(task.id,'a',lease.receipt,lease.claimId);expect(again.materials).toEqual(lease.materials);
    expect((await s.call('complete',{id:task.id,receipt:lease.receipt,result:'## F. CLAIMED_TEMPLATE'})).status).toBe(200);
    const version=s.sqlite.prepare('SELECT content,disposition,policy_revision FROM artifact_versions WHERE task_id=?').get(task.id) as any;expect(version.content).toBe('LATEST_TEMPLATE:## F. CLAIMED_TEMPLATE\n');expect(version.disposition).toBe('pending');expect(version.policy_revision).toBe(saved.policy_revision);
    expect(s.sqlite.prepare('SELECT brief_md FROM topics WHERE id=?').get(id)).toMatchObject({brief_md:'ORIGINAL_BRIEF'});
    const list=await (await page(s,`topics/${id}/versions`)).json() as any[];expect(list[0].stale).toBe(true);
  });

  it('词库和公开案例变更触发待采用；平台模型配置和私有案例变更不影响公共材料版本',async()=>{
    for(const mutation of ['vocab','public-insert','public-update','public-delete','private','model']){
      const s=await setup();await s.pair();const id=s.topic();
      const game=Number(s.sqlite.prepare("INSERT INTO games(title,owner_id,is_public,updated_at) VALUES('Case','b',?,?)").run(mutation.startsWith('public-')&&mutation!=='public-insert'?1:0,new Date().toISOString()).lastInsertRowid);
      const task=await s.create(id),lease=await s.claim(task.id);
      if(mutation==='vocab')s.sqlite.prepare("INSERT INTO vocab(dim,word) VALUES('subject','NEW_PUBLIC_WORD')").run();
      else if(mutation==='public-insert')s.sqlite.prepare("INSERT INTO games(title,owner_id,is_public) VALUES('NEW_PUBLIC_CASE','b',1)").run();
      else if(mutation==='public-delete')s.sqlite.prepare('DELETE FROM games WHERE id=?').run(game);
      else if(mutation==='model')s.sqlite.prepare("INSERT INTO settings(id,value,updated_at) VALUES('model','PRIVATE_MODEL','model-time') ON CONFLICT(id) DO UPDATE SET value=excluded.value").run();
      else s.sqlite.prepare("UPDATE games SET descr='MODIFIED' WHERE id=?").run(game);
      const response=await s.call('complete',{id:task.id,receipt:lease.receipt,result:`## F. ${mutation}`});expect(response.status).toBe(200);
      expect((await response.json() as any).disposition,mutation).toBe(['model','private'].includes(mutation)?'current':'pending');
    }
  });

  it('缺失或非法编号返回明确错误，批量混入他人编号时不产生部分任务；JSON 空值不能引发服务端错误',async()=>{
    const s=await setup();await s.pair();const own=s.topic(),other=s.topic('b');
    for(const b of [null,[],{request_id:crypto.randomUUID(),kind:'brief'},{request_id:crypto.randomUUID(),kind:'expand',ids:[own,'bad']},{request_id:crypto.randomUUID(),kind:'preview',id:-1},{request_id:crypto.randomUUID(),kind:'unknown',id:own}])expect((await s.call('create',b)).status).toBe(400);
    expect((await s.call('create',{request_id:crypto.randomUUID(),kind:'expand',ids:[own,other]})).status).toBe(404);
    expect((await page(s,'expand','POST',{ids:[own,other]})).status).toBe(404);
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toMatchObject({n:0});
    expect(s.sqlite.prepare('SELECT expand_status FROM topics WHERE id=?').get(own)).toMatchObject({expand_status:''});
  });

  it('同一领取编号不能换回执或领取其他任务，重新授予 Star 可恢复原队列',async()=>{
    const s=await setup();await s.pair();const first=await s.create(s.topic()),second=await s.create(s.topic('a','SECOND'),'preview'),lease=await s.claim(first.id);
    expect((await s.call('claim',{claimId:lease.claimId,receipt:'f'.repeat(64)})).status).toBe(409);
    expect((await s.call('claim',{id:second.id,claimId:lease.claimId,receipt:lease.receipt})).status).toBe(409);
    await updateMember('a',{star:false},s.members);expect((await s.call('claim',{id:second.id,claimId:crypto.randomUUID(),receipt:lease.receipt})).status).toBe(403);
    await updateMember('a',{star:true},s.members);expect((await s.claim(second.id)).task.id).toBe(second.id);
  });

  it('补词建议只能待管理员审批，结果键顺序不影响幂等且不接受 owner 字段注入',async()=>{
    const s=await setup();await s.pair();const created=await s.call('create',{request_id:crypto.randomUUID(),kind:'suggest',dim:'subject',id:999999,owner_id:'b'});expect(created.status).toBe(200);const task=(await created.json() as any).tasks[0],lease=await s.claim(task.id);
    const first={id:task.id,receipt:lease.receipt,result:{words:[{word:'Local suggestion',note:'A note'}]},model:'local-model'};
    expect((await s.call('complete',first)).status).toBe(200);
    expect((await s.call('complete',{...first,result:{words:[{note:'A note',word:'Local suggestion'}]}})).status).toBe(200);
    expect(s.sqlite.prepare("SELECT count(*) n FROM vocab WHERE word='Local suggestion'").get()).toMatchObject({n:0});
    expect(s.sqlite.prepare('SELECT owner_id,status FROM vocab_suggestions WHERE id=?').get(task.id)).toMatchObject({owner_id:'a',status:'pending'});
    const approve=async(owner:string)=>adminWorkspaceApi(new Request('https://agent.test/api/admin/public-data',{method:'POST',headers:{Cookie:s.cookies[owner],Origin:'https://agent.test','Content-Type':'application/json'},body:JSON.stringify({action:'suggestion-approve',id:task.id,owner_id:'b'})}),s.env);
    expect((await approve('a'))?.status).toBe(403);expect((await approve('admin'))?.status).toBe(200);expect((await approve('admin'))?.status).toBe(200);
    expect(s.sqlite.prepare("SELECT count(*) n FROM vocab WHERE word='Local suggestion'").get()).toMatchObject({n:1});
    expect(s.sqlite.prepare('SELECT owner_id,status FROM vocab_suggestions WHERE id=?').get(task.id)).toMatchObject({owner_id:'a',status:'approved'});
  });

  it('个人打标按实际写入报告冲突，并发重传仍返回同一计数且不覆盖新资料',async()=>{
    const s=await setup();await s.pair();
    const game=(owner:string,title:string)=>Number(s.sqlite.prepare('INSERT INTO games(title,owner_id,updated_at) VALUES(?,?,?)').run(title,owner,'2026-01-01T00:00:00.000Z').lastInsertRowid);
    const first=game('a','First'),changed=game('a','Changed'),foreign=game('b','B_PRIVATE_GAME');
    const response=await s.call('create',{request_id:crypto.randomUUID(),kind:'tag'}),task=(await response.json() as any).tasks[0],lease=await s.claim(task.id);
    expect(JSON.stringify(lease.materials)).not.toContain('B_PRIVATE_GAME');
    // An edit in the same timestamp resolution must still conflict.
    s.sqlite.prepare("UPDATE games SET gesture='USER_GESTURE' WHERE id=?").run(changed);
    const item=(id:number)=>({id,subject:'LOCAL_SUBJECT',medium:'LOCAL_MEDIUM',gesture:'LOCAL_GESTURE',structure:'LOCAL_STRUCTURE',mood:'LOCAL_MOOD',owner_id:'b',is_public:1});
    expect((await s.call('complete',{id:task.id,receipt:lease.receipt,result:{items:[item(foreign)]}})).status).toBe(400);
    const completion={id:task.id,receipt:lease.receipt,result:{items:[item(first),item(changed)]}},duplicates=await Promise.all([s.call('complete',completion),s.call('complete',completion)]);
    for(const r of duplicates){expect(r.status).toBe(200);expect(await r.json()).toMatchObject({tagged:1,conflicts:1,remaining:1});}
    expect(s.sqlite.prepare('SELECT gesture,owner_id,is_public FROM games WHERE id=?').get(first)).toMatchObject({gesture:'LOCAL_GESTURE',owner_id:'a',is_public:0});
    expect(s.sqlite.prepare('SELECT gesture FROM games WHERE id=?').get(changed)).toMatchObject({gesture:'USER_GESTURE'});
    const replay=await s.call('complete',completion);expect(await replay.json()).toMatchObject({tagged:1,conflicts:1,remaining:1});
  });

  it('完整50款打标在D1单语句参数限制内完成并保留真实计数',async()=>{
    const s=await setup();await s.pair();
    const ids=Array.from({length:50},(_,i)=>Number(s.sqlite.prepare('INSERT INTO games(title,owner_id,updated_at) VALUES(?,?,?)').run(`Game ${i}`,'a','2026-01-01T00:00:00.000Z').lastInsertRowid));
    const response=await s.call('create',{request_id:crypto.randomUUID(),kind:'tag'}),task=(await response.json() as any).tasks[0],lease=await s.claim(task.id);
    const result={items:ids.map(id=>({id,subject:`Subject ${id}`,medium:'pixel',gesture:'tap',structure:'rhythm',mood:'calm'}))};
    const done=await s.call('complete',{id:task.id,receipt:lease.receipt,result});expect(done.status,await done.clone().text()).toBe(200);expect(await done.json()).toMatchObject({tagged:50,conflicts:0,remaining:0});
    expect(s.sqlite.prepare("SELECT count(*) n FROM games WHERE owner_id='a' AND gesture='tap'").get()).toMatchObject({n:50});
  });

  it('成品状态页轮询不会按旧时间戳中断本人或管理员查看的本地任务',async()=>{
    const s=await setup();await s.pair();const id=s.topic(),task=await s.create(id,'game');
    for(const status of ['queued','running']){
      if(status==='running')await s.claim(task.id);
      s.sqlite.prepare("UPDATE forge_tasks SET created_at='2000-01-01T00:00:00.000Z',updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(task.id);
      s.sqlite.prepare("UPDATE topics SET product_status=?,updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(status,id);
      for(const owner of ['a','admin']){const r=await page(s,`topics/${id}/game`,'GET',undefined,owner);expect(r.status).toBe(200);expect(await r.json()).toMatchObject({product_status:status});}
      expect(s.sqlite.prepare('SELECT status FROM forge_tasks WHERE id=?').get(task.id)).toMatchObject({status});
    }
    expect(s.schedule).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('结果已锁定时并发失败不能打断保存，失败先完成时不能再写入产物',async()=>{
    const s=await setup();await s.pair();const task=await s.create(s.topic()),lease=await s.claim(task.id);
    const originalPrepare=s.DB.prepare,originalBatch=s.DB.batch;
    s.DB.prepare=(sql:string)=>Object.assign(originalPrepare(sql),{sql});
    let release!:()=>void,reached!:()=>void;const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>reached=r);
    s.DB.batch=async(stmts:any[])=>{if(stmts.some(x=>x.sql.startsWith('INSERT OR IGNORE INTO artifact_versions'))){reached();await held;}return originalBatch(stmts);};
    const completing=s.call('complete',{id:task.id,receipt:lease.receipt,result:'## F. FINISH_WINS'});await ready;
    const failing=await s.call('fail',{id:task.id,receipt:lease.receipt,message:'DISCONNECT'});expect(failing.status).toBe(409);release();expect((await completing).status).toBe(200);
    expect(s.sqlite.prepare('SELECT status FROM forge_tasks WHERE id=?').get(task.id)).toMatchObject({status:'done'});
    expect(s.sqlite.prepare('SELECT count(*) n FROM artifact_versions WHERE task_id=?').get(task.id)).toMatchObject({n:1});
    const next=await s.create(s.topic('a','FAIL_FIRST')),nextLease=await s.claim(next.id);expect((await s.call('fail',{id:next.id,receipt:nextLease.receipt,message:'USER_STOP'})).status).toBe(200);
    expect((await s.call('complete',{id:next.id,receipt:nextLease.receipt,result:'## F. TOO_LATE'})).status).toBe(409);
    expect(s.sqlite.prepare('SELECT count(*) n FROM artifact_versions WHERE task_id=?').get(next.id)).toMatchObject({n:0});
  });

  it('词库题材的空白规范化在并发中同样原子预留，锁定题材不能绕过已用检查',async()=>{
    const s=await setup();await s.pair();await s.pair('b');s.sqlite.prepare("INSERT INTO vocab(dim,word) VALUES('subject',?)").run('SPACED\t  Subject');
    const responses=await Promise.all([s.call('draw',{request_id:crypto.randomUUID(),n:1}),s.call('draw',{request_id:crypto.randomUUID(),n:1},'b')]);
    for(const r of responses)expect([200,409]).toContain(r.status);
    expect(s.sqlite.prepare('SELECT count(*) n FROM topics').get()).toMatchObject({n:1});
    expect(s.sqlite.prepare("SELECT count(*) n FROM subject_reservations WHERE subject_key='spaced subject'").get()).toMatchObject({n:1});
    expect((await s.call('draw',{request_id:crypto.randomUUID(),locks:{subject:' spaced   subject '}})).status).toBe(409);
    expect((await s.call('draw',{request_id:crypto.randomUUID(),subject:'SPACED\nSUBJECT'},'b')).status).toBe(409);
    expect(s.sqlite.prepare('SELECT count(*) n FROM topics').get()).toMatchObject({n:1});
  });

  it('他人公开案例供模型校准，不影响本人的抽签权重或操作组合偏好',async()=>{
    const s=await setup();await s.pair();s.sqlite.prepare("INSERT INTO vocab(dim,word) VALUES('subject','OWN_DRAW_AVAILABLE')").run();
    s.sqlite.prepare("INSERT INTO games(title,owner_id,is_public,status,score,subject,medium,gesture,structure,mood) VALUES('PUBLIC_CASE','b',1,'rejected',3,'different subject','pixel','tap','rhythm','calm')").run();
    const response=await s.call('draw',{request_id:crypto.randomUUID(),n:1});expect(response.status).toBe(200);expect(await response.json()).toMatchObject([{owner_id:'a',subject:'OWN_DRAW_AVAILABLE',medium:'pixel',gesture:'tap',structure:'rhythm'}]);
  });

  it('成员网页 state/settings/export 只返回公共设置，不读取或回传云模型配置',async()=>{
    const s=await setup();s.topic();
    s.sqlite.prepare("INSERT INTO settings(id,value,updated_at) VALUES('internal-private','INTERNAL_PRIVATE_SECRET',?)").run(new Date().toISOString());
    s.sqlite.prepare("INSERT INTO settings(id,value,updated_at) VALUES('model',?,?)").run(JSON.stringify({model:'PRIVATE_MODEL_METADATA',apiKey:'PRIVATE_MODEL_KEY',baseUrl:'https://private-model.invalid'}),new Date().toISOString());
    for(const path of ['state','settings','export']){
      const response=await page(s,path);expect(response.status).toBe(200);const text=await response.text();expect(text).not.toMatch(/PRIVATE_MODEL|private-model\.invalid|INTERNAL_PRIVATE_SECRET/);
      if(path==='state')expect(JSON.parse(text)).toMatchObject({executor:'platform',model:'平台创作模型',providers:{openai:false}});
      if(path==='settings')expect(Object.keys(JSON.parse(text)).sort()).toEqual(['draw_size','expand_batch','redlines','template','template_f']);
    }
    expect(s.env.modelStore.get).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('网页配对校验 Star、会话和来源；配对码一次使用，数据库只保存摘要',async()=>{
    const s=await setup();
    expect((await s.web('pairing','plain')).status).toBe(403);
    expect((await s.web('pairing','admin')).status).toBe(403);
    expect((await s.web('pairing','a',undefined,'https://elsewhere.test')).status).toBe(403);
    const{deviceId,code}=await s.pair();
    const row=s.sqlite.prepare('SELECT * FROM forge_agents WHERE id=?').get(deviceId) as any;
    expect(row.owner_id).toBe('a');expect(row.token_hash).not.toBe('a'.repeat(64));expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(s.sqlite.prepare('SELECT * FROM forge_agent_pairings').all())).not.toContain(code);
    expect((await s.call('pair',{deviceId,code,token:'a'.repeat(64)})).status).toBe(200);
    expect((await s.call('pair',{deviceId:crypto.randomUUID(),code,token:'c'.repeat(64)},'second')).status).toBe(409);
    const devices=await (await s.web('devices')).json();expect(JSON.stringify(devices)).not.toContain(row.token_hash);
    expect(JSON.stringify(devices)).not.toContain('a'.repeat(64));
  });

  it('网页配对管理拒绝任何Bearer+Cookie组合，嵌套动作不能冒用合法后缀',async()=>{
    const s=await setup(),{deviceId}=await s.pair();
    for(const action of ['pairing','devices','revoke']){
      const method=action==='devices'?'GET':'POST',request=new Request(`https://agent.test/api/forge/agent/${action}`,{method,headers:{Cookie:s.cookies.a,Authorization:`Bearer ${'a'.repeat(64)}`,Origin:'https://agent.test','Content-Type':'application/json'},body:method==='POST'?JSON.stringify({id:deviceId}):undefined});
      expect((await forgeAgentWeb(request,s.env)).status,action).toBe(403);
    }
    for(const action of ['nested/pairing','nested/devices','nested/revoke'])expect((await s.web(action)).status,action).toBe(404);
    expect(s.sqlite.prepare('SELECT revoked FROM forge_agents WHERE id=?').get(deviceId)).toMatchObject({revoked:0});
  });

  it('三台有效设备上限包括重新启用旧设备；同一活跃设备可重新配对',async()=>{
    const s=await setup();
    async function authorize(deviceId=crypto.randomUUID(),token=crypto.randomUUID().replace(/-/g,'').repeat(2)){
      const {code}=await (await s.web('pairing')).json() as any;
      const response=await s.call('pair',{deviceId,code,token});return{response,deviceId,token};
    }
    const old=await authorize();expect(old.response.status).toBe(200);expect((await s.web('revoke','a',{id:old.deviceId})).status).toBe(200);
    const active=[];for(let i=0;i<3;i++){const d=await authorize();expect(d.response.status).toBe(200);active.push(d);}
    expect((await authorize()).response.status).toBe(409);expect((await authorize(old.deviceId)).response.status).toBe(409);
    expect((await authorize(active[0].deviceId)).response.status).toBe(200);
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_agents WHERE revoked=0 AND expires_at>?').get(new Date().toISOString())).toMatchObject({n:3});
    expect((await s.web('revoke','a',{id:active[1].deviceId})).status).toBe(200);expect((await authorize(old.deviceId)).response.status).toBe(200);
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_agents WHERE revoked=0 AND expires_at>?').get(new Date().toISOString())).toMatchObject({n:3});
  });

  it('令牌只允许明确操作与本人的材料，错误令牌不能借管理员 Cookie 升权',async()=>{
    const s=await setup();await s.pair();await s.pair('b');const own=s.topic(),other=s.topic('b','B_PRIVATE_TOPIC');
    for(const action of ['config','settings','admin','nested/context','jobs/','nested/pair'])expect((await s.call(action)).status,action).toBe(403);
    expect((await s.call('context',{},'invalid',{Cookie:s.cookies.admin})).status).toBe(401);
    const noToken=await forgeAgentApi(new Request('https://agent.test/api/forge-agent/context',{method:'POST',headers:{Cookie:s.cookies.admin,'Content-Type':'application/json'},body:'{}'}),s.env);expect(noToken.status).toBe(401);
    const forbidden=await forgeApi(new Request('https://agent.test/api/forge/settings',{headers:{Cookie:s.cookies.admin,Authorization:`Bearer ${'a'.repeat(64)}`}}),s.env,['settings'],s.members);expect(forbidden.status).toBe(403);
    const context=await s.call('context');expect(context.status).toBe(200);expect(await context.text()).not.toMatch(/PRIVATE_MODEL_KEY|private-model\.invalid|PRIVATE_CLOUD_MODEL|B_PRIVATE/);
    expect((await s.call('create',{request_id:crypto.randomUUID(),kind:'brief',id:other})).status).toBe(404);
    const task=await s.create(own),otherTask=await s.create(other,'brief','b');
    expect((await s.call('job',{id:otherTask.id})).status).toBe(404);
    expect(JSON.stringify(await (await s.call('jobs')).json())).not.toContain(otherTask.id);
    const leased=await s.claim(task.id);expect(JSON.stringify(leased.materials)).not.toMatch(/PRIVATE_MODEL_KEY|private-model\.invalid|PRIVATE_CLOUD_MODEL|B_PRIVATE/);
    const foreignClaim=await s.call('claim',{id:otherTask.id,claimId:crypto.randomUUID(),receipt:'f'.repeat(64)});expect(foreignClaim.status).toBe(200);expect(await foreignClaim.json()).toBe(null);
    expect(s.schedule).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('同一请求与相同领取可恢复，改变请求内容或回执被拒绝；结果重复回传只保存一个版本',async()=>{
    const s=await setup();await s.pair();const id=s.topic(),requestId=crypto.randomUUID();
    const task=await s.create(id,'brief','a',requestId);expect((await s.create(id,'brief','a',requestId)).id).toBe(task.id);
    expect((await s.call('create',{request_id:requestId,kind:'preview',id})).status).toBe(409);
    const leased=await s.claim(task.id);
    const replay=await s.call('claim',{id:task.id,claimId:leased.claimId,receipt:leased.receipt});expect(replay.status).toBe(200);expect((await replay.json() as any).task.id).toBe(task.id);
    expect((await s.call('complete',{id:task.id,receipt:'f'.repeat(64),result:'## F. WRONG'})).status).toBe(409);
    expect((await s.call('heartbeat',{id:task.id,receipt:leased.receipt})).status).toBe(200);
    const completion={id:task.id,receipt:leased.receipt,result:'## F. LOCAL_RESULT',model:'member-model'};
    expect((await s.call('complete',completion)).status).toBe(200);expect((await s.call('complete',completion)).status).toBe(200);
    expect((await s.call('complete',{...completion,result:'## F. ALTERED_REPLAY'})).status).toBe(409);
    expect(s.sqlite.prepare('SELECT count(*) n FROM artifact_versions WHERE task_id=?').get(task.id)).toMatchObject({n:1});
    expect(s.sqlite.prepare('SELECT brief_md FROM topics WHERE id=?').get(id)).toMatchObject({brief_md:expect.stringContaining('LOCAL_RESULT')});
    expect(s.sqlite.prepare('SELECT status,executor,owner_id,device_id FROM forge_tasks WHERE id=?').get(task.id)).toMatchObject({status:'done',executor:'agent',owner_id:'a',device_id:expect.any(String)});
    expect(s.schedule).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('撤销 Star 后只允许原设备回传已领取任务，不得读取材料、创建或领取其他任务',async()=>{
    const s=await setup();await s.pair();await s.pair('a','second');const first=await s.create(s.topic()),second=await s.create(s.topic('a','SECOND_PRIVATE_TOPIC'),'preview');
    const leased=await s.claim(first.id),member=await s.members.byId('a');await updateMember('a',{star:false},s.members);
    expect((await s.members.byId('a'))?.sessionVersion).toBe(member?.sessionVersion);
    for(const[action,data]of [['context',{}],['draw',{request_id:crypto.randomUUID(),subject:'new'}],['create',{request_id:crypto.randomUUID(),kind:'brief',id:1}],['claim',{id:second.id,claimId:crypto.randomUUID(),receipt:'f'.repeat(64)}]] as const)expect((await s.call(action,data)).status,action).toBe(403);
    const completion={id:first.id,receipt:leased.receipt,result:'## F. RETURN_AFTER_REVOCATION'};
    expect((await s.call('complete',completion,'second')).status).toBeGreaterThanOrEqual(400);
    expect((await s.call('complete',completion)).status).toBe(200);
    expect((await s.call('complete',{id:second.id,receipt:'f'.repeat(64),result:'UNCLAIMED'})).status).toBeGreaterThanOrEqual(400);
    expect(s.sqlite.prepare('SELECT status FROM forge_tasks WHERE id=?').get(second.id)).toMatchObject({status:'queued'});
  });

  it('账号停用、密码变化和网页设备撤销立即使已领取任务回执失效',async()=>{
    for(const action of ['disable','password','revoke']){
      const s=await setup(),{deviceId}=await s.pair(),task=await s.create(s.topic()),leased=await s.claim(task.id);
      if(action==='revoke')expect((await s.web('revoke','a',{id:deviceId})).status).toBe(200);
      else await updateMember('a',action==='disable'?{enabled:false}:{password:'changed-password'},s.members);
      expect((await s.call('complete',{id:task.id,receipt:leased.receipt,result:'## F. REVOKED_TOKEN'})).status,action).toBe(401);
      expect(s.sqlite.prepare('SELECT brief_md FROM topics WHERE id=1').get()).toMatchObject({brief_md:'ORIGINAL_BRIEF'});
    }
  });

  it('领取后输入发生变化，旧结果保存为历史但不能覆盖新版本',async()=>{
    const s=await setup();await s.pair();const id=s.topic(),task=await s.create(id),leased=await s.claim(task.id);
    s.sqlite.prepare("UPDATE topics SET requirements='NEW_REQUIREMENTS',brief_md='NEW_CURRENT_BRIEF',content_revision=content_revision+1 WHERE id=?").run(id);
    const response=await s.call('complete',{id:task.id,receipt:leased.receipt,result:'## F. OLD_INPUT_RESULT',model:'local-model'});expect(response.status).toBe(200);
    expect(s.sqlite.prepare('SELECT brief_md FROM topics WHERE id=?').get(id)).toMatchObject({brief_md:'NEW_CURRENT_BRIEF'});
    const version=s.sqlite.prepare('SELECT content,disposition,input_revision FROM artifact_versions WHERE task_id=?').get(task.id) as any;
    expect(version.content).toContain('OLD_INPUT_RESULT');expect(version.disposition).not.toBe('current');expect(version.input_revision).toBe(0);
  });

  it('网页读取和后台误投递都不能把个人任务调度成云模型，也不能按旧后台期限终止',async()=>{
    const s=await setup();await s.pair();const topicId=s.topic(),task=await s.create(topicId);
    const read=async(path:string)=>forgeApi(new Request(`https://agent.test/api/forge/${path}`,{headers:{Cookie:s.cookies.a}}),s.env,path.split('/'),s.members);
    expect((await read('generation-jobs')).status).toBe(200);
    expect((await read(`generation-jobs/${task.id}`)).status).toBe(200);
    await executeForgeTask(s.env,task.id);
    expect(s.sqlite.prepare('SELECT status FROM forge_tasks WHERE id=?').get(task.id)).toMatchObject({status:'queued'});
    await s.claim(task.id);
    s.sqlite.prepare("UPDATE forge_tasks SET started_at='2000-01-01',updated_at='2000-01-01' WHERE id=?").run(task.id);
    expect((await read(`generation-jobs/${task.id}`)).status).toBe(200);expect((await read(`topics/${topicId}`)).status).toBe(200);
    expect(s.sqlite.prepare('SELECT status FROM forge_tasks WHERE id=?').get(task.id)).toMatchObject({status:'running'});
    expect(s.schedule).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();expect(s.env.modelStore.get).not.toHaveBeenCalled();
  });

  it('相同请求编号并发提交不同内容，只能创建其中一种任务',async()=>{
    const s=await setup();await s.pair();const id=s.topic(),request_id=crypto.randomUUID();
    const responses=await Promise.all([s.call('create',{request_id,id,kind:'brief'}),s.call('create',{request_id,id,kind:'preview'})]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toMatchObject({n:1});
    const result=JSON.parse((s.sqlite.prepare('SELECT result FROM forge_requests WHERE request_id=?').get(request_id) as any).result);
    expect(result.tasks).toHaveLength(1);
  });

  it('并发重传相同结果幂等完成；不同结果争用同回执只有一个能提交',async()=>{
    const s=await setup();await s.pair();
    const first=await s.create(s.topic()),lease=await s.claim(first.id),same={id:first.id,receipt:lease.receipt,result:'## F. SAME_RESULT'};
    const duplicate=await Promise.all([s.call('complete',same),s.call('complete',same)]);
    expect(duplicate.map(r=>r.status)).toEqual([200,200]);
    expect(s.sqlite.prepare('SELECT count(*) n FROM artifact_versions WHERE task_id=?').get(first.id)).toMatchObject({n:1});
    const second=await s.create(s.topic('a','NEXT_PRIVATE_TOPIC')),nextLease=await s.claim(second.id);
    const conflicting=await Promise.all([s.call('complete',{id:second.id,receipt:nextLease.receipt,result:'## F. RESULT_A'}),s.call('complete',{id:second.id,receipt:nextLease.receipt,result:'## F. RESULT_B'})]);
    expect(conflicting.map(r=>r.status).sort()).toEqual([200,409]);
    expect(s.sqlite.prepare('SELECT count(*) n FROM artifact_versions WHERE task_id=?').get(second.id)).toMatchObject({n:1});
    expect(s.schedule).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('并发自由命题原子预留全站题材，只返回本人记录且错误不泄漏私人需求',async()=>{
    const s=await setup();await s.pair();await s.pair('b');
    const requests=[{request_id:crypto.randomUUID(),subject:'GLOBAL UNIQUE SUBJECT',requirements:'A_PRIVATE_REQUIREMENTS'},{request_id:crypto.randomUUID(),subject:' global unique subject ',requirements:'B_PRIVATE_REQUIREMENTS'}];
    const responses=await Promise.all([s.call('draw',requests[0]),s.call('draw',requests[1],'b')]);
    for(const response of responses)expect([200,409]).toContain(response.status);
    const text=await Promise.all(responses.map(r=>r.text()));expect(text[0]).not.toContain('B_PRIVATE_REQUIREMENTS');expect(text[1]).not.toContain('A_PRIVATE_REQUIREMENTS');
    expect(s.sqlite.prepare('SELECT count(*) n FROM topics').get()).toMatchObject({n:1});
    expect(s.sqlite.prepare('SELECT count(*) n FROM subject_reservations WHERE subject_key=?').get('global unique subject')).toMatchObject({n:1});
    const winner=(s.sqlite.prepare('SELECT owner_id FROM topics').get() as any).owner_id,index=winner==='a'?0:1;
    const replay=await s.call('draw',requests[index],winner);expect(replay.status).toBe(200);expect(s.sqlite.prepare('SELECT count(*) n FROM topics').get()).toMatchObject({n:1});
    expect(s.schedule).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });
});
