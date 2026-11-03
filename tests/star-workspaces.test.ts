import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {forgeApi,prepareReview} from '../server/forge-api';
import {hashPassword,memberLogin,updateMember} from '../server/members';
import {memberStore} from '../server/storage';
import {login,encryptKey} from '../server/settings';
import {executeForgeTask} from '../server/forge-runner';
import {createAgentTask} from '../server/forge-agent-api';

const databases:DatabaseSync[]=[];
afterEach(()=>{vi.unstubAllGlobals();databases.splice(0).forEach(db=>db.close());});
const migrations=()=>readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort();
function database(beforeStar=false){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of migrations().filter(n=>!beforeStar||n<'0017'))sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const DB:any={prepare(sql:string){let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>{const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>{const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};return s;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const out=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  return{sqlite,DB};
}
async function setup(){
  const{sqlite,DB}=database(),secrets={ADMIN_PASSWORD:'workspace-admin',SETTINGS_KEY:'workspace-secret'};
  const password=await hashPassword('workspace-password');
  for(const id of ['a','b','plain'])sqlite.prepare('INSERT INTO members(id,username,display_name,password_hash,password_salt,star,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,id,id,password.hash,password.salt,id==='plain'?0:1,'now','now');
  const members=memberStore(DB),cookies:Record<string,string>={admin:`pgc_admin=${await login(secrets.ADMIN_PASSWORD,secrets)}`};
  for(const id of ['a','b','plain'])cookies[id]=`pgc_member=${await memberLogin(id,'workspace-password',members,secrets.SETTINGS_KEY)}`;
  const modelStore={get:vi.fn(async()=>({baseUrl:'https://model.invalid',model:'private-cloud-model',encryptedKey:'PRIVATE_MODEL_KEY',enabled:true,protocol:'openai'}))};
  const dispatch=vi.fn(async()=>Response.json({ok:true}));
  const env:any={...secrets,DB,modelStore,FORGE_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:dispatch})}};
  const request=(owner:string,method:string,path:string,data?:unknown,extra:Record<string,string>={})=>forgeApi(new Request(`https://workspace.test/api/forge/${path}`,{method,headers:{Cookie:cookies[owner],Origin:'https://workspace.test','Content-Type':'application/json',...extra},body:data===undefined?undefined:JSON.stringify(data)}),env,path.split('?')[0].split('/'),members);
  const topic=(owner:string,title:string)=>Number(sqlite.prepare("INSERT INTO topics(batch,subject,medium,gesture,structure,mood,status,data,brief_md,assets_html,product_html,owner_id,created_at,updated_at) VALUES('fixture',?,'pixel','tap','rhythm','calm','liked',?,?,?,?,?,'now','now')").run(`${owner}-subject`,JSON.stringify({title,logline:`${title}-design`,core_loop:'Catch a star',controls:'Tap',art_direction:'Pixel'}),`${title}-brief`,`${title}-assets`,`${title}-product`,owner).lastInsertRowid);
  const game=(owner:string,title:string,isPublic=0)=>Number(sqlite.prepare("INSERT INTO games(title,descr,status,score,aes,ease,play,subject,owner_id,is_public) VALUES(?,?,'approved',9,3,3,3,?,?,?)").run(title,`${title}-description`,`${owner}-subject`,owner,isPublic).lastInsertRowid);
  const review=(owner:string,title:string)=>Number(sqlite.prepare("INSERT INTO reviews(owner_id,title,score,result,probe,created_at) VALUES(?,?,9,?,'{}','now')").run(owner,title,JSON.stringify({aes:3,ease:3,play:3})).lastInsertRowid);
  return{sqlite,DB,env,members,cookies,request,topic,game,review,dispatch};
}

describe('Star 工作区迁移与所有权',()=>{
  it('网页明确选择个人 Agent 时不读取平台模型、不调度平台执行，并保持所有权与幂等',async()=>{
    const s=await setup(),id=s.topic('a','AGENT_CHOICE'),other=s.topic('b','OTHER');
    delete s.env.FORGE_RUNNER;
    expect((await s.request('plain','POST',`topics/${id}/game?executor=agent`)).status).toBe(403);
    expect((await s.request('a','POST',`topics/${other}/game?executor=agent`)).status).toBe(404);
    const first=await(await s.request('a','POST',`topics/${id}/game?executor=agent`)).json() as any;
    const repeated=await(await s.request('a','POST',`topics/${id}/game?executor=agent`)).json() as any;
    expect(first.jobId).toBeTruthy();expect(repeated.jobId).toBe(first.jobId);
    expect(s.sqlite.prepare('SELECT executor,owner_id FROM forge_tasks WHERE id=?').get(first.jobId)).toMatchObject({executor:'agent',owner_id:'a'});
    expect(s.env.modelStore.get).not.toHaveBeenCalled();expect(s.dispatch).not.toHaveBeenCalled();
    expect(s.sqlite.prepare('SELECT product_html FROM topics WHERE id=?').get(id)).toMatchObject({product_html:'AGENT_CHOICE-product'});
  });
  it('项目摘要不返回游戏和材料原文，跨成员仍拒绝',async()=>{
    const s=await setup(),id=s.topic('a','SUMMARY');
    const response=await s.request('a','GET',`topics/${id}?summary=1`);expect(response.status).toBe(200);
    const value=await response.json() as any;expect(value).toMatchObject({id,has_product:1,has_brief:1,has_assets:1});
    expect(value.product_html).toBeUndefined();expect(value.brief_md).toBeUndefined();expect(value.assets_html).toBeUndefined();
    expect((await s.request('b','GET',`topics/${id}?summary=1`)).status).toBe(404);
  });
  it('Star 网页制作由平台 Opus 执行，重复提交与跨成员访问被隔离，成品保存版本',async()=>{
    const s=await setup(),id=s.topic('a','A_LIVE_CREATION'),other=s.topic('b','B_PRIVATE_CREATION');
    s.sqlite.prepare("UPDATE topics SET product_html=NULL,assets_html=NULL WHERE id=?").run(id);
    const encryptedKey=await encryptKey('platform-test-key',s.env.SETTINGS_KEY);
    s.env.modelStore.get.mockResolvedValue({profiles:{opus:{baseUrl:'https://fixture.example',model:'claude-opus-5-5',encryptedKey,enabled:true,protocol:'anthropic'}},activeProfile:'opus'});
    expect((await s.request('plain','POST',`topics/${id}/game`)).status).toBe(403);
    expect((await s.request('admin','POST',`topics/${id}/game`)).status).toBe(403);
    expect((await s.request('a','POST',`topics/${other}/game`)).status).toBe(404);
    expect((await s.request('a','POST',`topics/${id}/game`,undefined,{Origin:'https://attacker.test'})).status).toBe(403);
    const first=await (await s.request('a','POST',`topics/${id}/game`)).json() as any;
    const repeat=await (await s.request('a','POST',`topics/${id}/game`)).json() as any;
    expect(first.taskId).toBe(repeat.taskId);expect(first).toMatchObject({executor:'platform',pending:true});
    const agentChoice=await(await s.request('a','POST',`topics/${id}/game?executor=agent`)).json() as any;
    expect(agentChoice.jobId).toBe(first.taskId);expect(agentChoice.tasks[0].executor).toBe('platform');
    expect((await s.request('b','GET',`generation-jobs/${first.taskId}`)).status).toBe(404);
    const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><canvas></canvas><script>let score=0;document.onclick=()=>score++;</script></body></html>';
    const fetcher=vi.fn(async(_url:any,init:any)=>{expect(JSON.parse(init.body).model).toBe('claude-opus-5-5');expect(init.body).not.toContain('B_PRIVATE');return Response.json({content:[{type:'text',text:html}],stop_reason:'end_turn'});});vi.stubGlobal('fetch',fetcher);
    await executeForgeTask(s.env,first.taskId);await executeForgeTask(s.env,first.taskId);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(s.sqlite.prepare('SELECT owner_id,executor,model,disposition FROM artifact_versions WHERE task_id=?').get(first.taskId)).toMatchObject({owner_id:'a',executor:'platform',model:'claude-opus-5-5',disposition:'current'});
    expect((await s.request('a','GET','products')).status).toBe(200);
    expect(await (await s.request('a','GET',`topics/${id}/product-file`)).text()).toBe(html);
    const version=s.sqlite.prepare('SELECT id FROM artifact_versions WHERE task_id=?').get(first.taskId) as any;
    expect((await s.request('b','GET',`topics/${id}/versions/${version.id}/preview`)).status).toBe(404);
    const preview=await s.request('a','GET',`topics/${id}/versions/${version.id}/preview`);
    expect(await preview.text()).toBe(html);expect(preview.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
  });

  it('平台与 Agent 在同一选题同一环节互斥，不会偷偷转换已有 Agent 任务',async()=>{
    const s=await setup(),id=s.topic('a','A_AGENT_QUEUED');
    s.sqlite.prepare('UPDATE topics SET product_html=NULL WHERE id=?').run(id);
    const agent=await createAgentTask(s.env,'a',{type:'game',id});
    s.env.modelStore.get.mockResolvedValue({profiles:{opus:{baseUrl:'https://fixture.example',model:'claude-opus-5-5',encryptedKey:'fixture',enabled:true,protocol:'anthropic'}},activeProfile:'opus'});
    const result=await (await s.request('a','POST',`topics/${id}/game`)).json() as any;
    expect(result.taskId).toBe(agent.id);expect(result.executor).toBe('agent');expect(s.dispatch).not.toHaveBeenCalled();
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toMatchObject({n:1});
  });

  it('撤销 Star 或停用账号后，排队平台任务不再发起模型请求',async()=>{
    for(const change of [{star:false},{enabled:false}]){
      const s=await setup(),id=s.topic('a','A_REVOKED');
      s.sqlite.prepare('UPDATE topics SET product_html=NULL WHERE id=?').run(id);
      s.env.modelStore.get.mockResolvedValue({profiles:{opus:{baseUrl:'https://fixture.example',model:'claude-opus-5-5',encryptedKey:'fixture',enabled:true,protocol:'anthropic'}},activeProfile:'opus'});
      const result=await (await s.request('a','POST',`topics/${id}/game`)).json() as any;
      await updateMember('a',change,s.members);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
      await executeForgeTask(s.env,result.taskId);expect(fetcher).not.toHaveBeenCalled();
      expect(s.sqlite.prepare('SELECT status,model_started_at FROM forge_tasks WHERE id=?').get(result.taskId)).toMatchObject({status:'error',model_started_at:null});
    }
  });

  it('批量扩写预先校验全部归属，不能读取或生成另一成员选题',async()=>{
    const s=await setup(),id=s.topic('a','A_EXPAND'),other=s.topic('b','B_EXPAND');
    s.sqlite.prepare("UPDATE topics SET data='{}' WHERE id IN (?,?)").run(id,other);
    expect((await s.request('a','POST','expand',{ids:[id,other]})).status).toBe(404);
    expect(s.dispatch).not.toHaveBeenCalled();expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toMatchObject({n:0});
  });
  it('成员仅能移除本人已结束任务和报告，管理员记录、额度及请求编号保留',async()=>{
    const s=await setup(), now=new Date().toISOString(), id=crypto.randomUUID(), active=crypto.randomUUID(), failed=crypto.randomUUID();
    s.sqlite.prepare("INSERT INTO review_jobs(id,owner_id,title,status,created_at,updated_at,quota_charged) VALUES(?,'a','failed','error',?,?,1),(?,'a','running','running',?,?,0),(?,'a','failed only','error',?,?,0)").run(id,now,now,active,now,now,failed,now,now);
    const report=s.review('a','A report'), other=s.review('b','B report');
    s.sqlite.prepare('UPDATE reviews SET job_id=? WHERE id=?').run(id,report);
    expect((await s.request('b','DELETE',`review/jobs/${id}`)).status).toBe(404);
    expect((await s.request('a','DELETE',`review/jobs/${active}`)).status).toBe(409);
    expect((await s.request('a','DELETE',`review/jobs/${failed}`)).status).toBe(200);
    expect((await s.request('a','DELETE',`review/jobs/${failed}`)).status).toBe(200);
    expect((await s.request('a','DELETE',`reviews/${other}`)).status).toBe(404);
    expect((await s.request('a','DELETE',`reviews/${report}`,undefined,{Origin:'https://other.test'})).status).toBe(403);
    expect((await s.request('a','DELETE',`reviews/${report}`,undefined,{Authorization:'Bearer invalid'})).status).toBe(403);
    expect((await s.request('a','DELETE',`reviews/${report}`)).status).toBe(200);
    expect((await s.request('a','DELETE',`reviews/${report}`)).status).toBe(200);
    expect(await (await s.request('a','GET','reviews')).json()).toEqual([]);
    expect((await s.request('a','GET',`reviews/${report}`)).status).toBe(404);
    expect((await s.request('a','GET',`review/jobs/${id}`)).status).toBe(404);
    expect(await (await s.request('a','GET','review/jobs')).json()).toEqual([expect.objectContaining({id:active})]);
    expect((await s.request('admin','GET',`reviews/${report}`)).status).toBe(200);
    expect(s.sqlite.prepare('SELECT owner_hidden,quota_charged FROM review_jobs WHERE id=?').get(id)).toMatchObject({owner_hidden:1,quota_charged:1});
    expect(s.sqlite.prepare('SELECT owner_hidden FROM reviews WHERE id=?').get(report)).toMatchObject({owner_hidden:1});
    expect((await s.request('a','POST','review/jobs',{html:'x'})).status).toBe(403);
    expect((await s.request('a','GET','export')).status).toBe(200);
    expect(JSON.stringify(await (await s.request('a','GET','export')).json())).not.toContain('A report');
  });

  it('真实旧库迁移保留管理员作品、各类产物和稳定编号；外部作品编号按 owner 唯一',()=>{
    const{sqlite}=database(true);
    sqlite.prepare("INSERT INTO games(id,ext_id,title,subject) VALUES(41,'external-1','Legacy game',' Old Subject ')").run();
    sqlite.prepare("INSERT INTO topics(id,batch,subject,medium,gesture,structure,mood,data,brief_md,preview_svg,assets_html,product_html,created_at,updated_at) VALUES(51,'legacy',' Topic Subject ','pixel','tap','rhythm','calm',?,?,'<svg/>',?,?,'created','updated')").run(JSON.stringify({title:'Legacy topic'}),'Legacy brief','Legacy assets','Legacy game html');
    sqlite.exec(readFileSync('migrations/0017_star_agent_workspaces.sql','utf8'));
    expect(sqlite.prepare('SELECT id,owner_id,is_public FROM games').get()).toMatchObject({id:41,owner_id:'admin',is_public:0});
    expect(sqlite.prepare('SELECT id,owner_id,content_revision,origin FROM topics').get()).toMatchObject({id:51,owner_id:'admin',content_revision:0,origin:'legacy'});
    expect(sqlite.prepare('SELECT kind,content,owner_id,executor FROM artifact_versions ORDER BY kind').all()).toEqual([
      expect.objectContaining({kind:'assets',content:'Legacy assets',owner_id:'admin',executor:'platform'}),
      expect.objectContaining({kind:'brief',content:'Legacy brief'}),
      expect.objectContaining({kind:'expand',content:JSON.stringify({title:'Legacy topic'})}),
      expect.objectContaining({kind:'game',content:'Legacy game html'}),
      expect.objectContaining({kind:'preview',content:'<svg/>'}),
    ]);
    expect(sqlite.prepare('SELECT count(*) n FROM artifact_heads h JOIN artifact_versions v ON h.version_id=v.id WHERE h.topic_id=51 AND h.kind=v.kind').get()).toMatchObject({n:5});
    expect(sqlite.prepare('SELECT subject_key FROM subject_reservations ORDER BY subject_key').all()).toEqual([{subject_key:'old subject'},{subject_key:'topic subject'}]);
    sqlite.prepare("INSERT INTO games(ext_id,title,owner_id) VALUES('external-1','A game','a')").run();
    sqlite.prepare("INSERT INTO games(ext_id,title,owner_id) VALUES('external-1','B game','b')").run();
    expect(()=>sqlite.prepare("INSERT INTO games(ext_id,title,owner_id) VALUES('external-1','A duplicate','a')").run()).toThrow(/UNIQUE/);
    expect(Number(sqlite.prepare("INSERT INTO games(title,owner_id) VALUES('Next game','a')").run().lastInsertRowid)).toBeGreaterThan(41);
  });

  it('普通成员只开放本人审核，Star 不得访问管理接口，管理员不得代成员发起创作',async()=>{
    const s=await setup(),id=s.topic('a','A_PRIVATE_TOPIC');
    for(const path of ['state','vocab','games','topics','products','export','generation-jobs'])expect((await s.request('plain','GET',path)).status,path).toBe(403);
    for(const[method,path,data]of [['PUT','settings',{draw_size:99}],['POST','seed',{}],['POST','vocab',{dim:'subject',word:'forbidden'}]] as const)expect((await s.request('a',method,path,data)).status,path).toBe(403);
    for(const[path,data]of [['draw',{}],['expand',{ids:[id]}],[`topics/${id}/brief`,{}],[`topics/${id}/assets`,{}],[`topics/${id}/game`,{}]] as const)expect((await s.request('admin','POST',path,data)).status,path).toBe(403);
    expect((await s.request('plain','GET','reviews')).status).toBe(200);
    expect((await s.request('plain','POST','reviews',{title:'forbidden'})).status).toBeGreaterThanOrEqual(400);
    expect(s.dispatch).not.toHaveBeenCalled();
  });

  it('个人作品新增与平台导入绑定本人，不能自定 owner 或发布为公共校准',async()=>{
    const s=await setup();
    const forged=await s.request('a','POST','games',{title:'A_OWN_GAME',owner_id:'b',is_public:1});expect(forged.status).toBe(200);
    const game=await forged.json() as any;expect(game).toMatchObject({owner_id:'a',is_public:0});
    await s.request('a','PATCH',`games/${game.id}`,{title:'A_UPDATED_GAME',owner_id:'b',is_public:1});
    expect(s.sqlite.prepare('SELECT title,owner_id,is_public FROM games WHERE id=?').get(game.id)).toMatchObject({title:'A_UPDATED_GAME',owner_id:'a',is_public:0});
    for(const owner of ['a','b']){
      const response=await s.request(owner,'POST','import',{works:[{id:'same-external-id',title:`${owner}_PRIVATE_IMPORT`,status:'approved',versions:[{r:1,s:'3/3/3'}]}]});expect(response.status).toBe(200);
    }
    expect(s.sqlite.prepare("SELECT owner_id,title FROM games WHERE ext_id='same-external-id' ORDER BY owner_id").all()).toEqual([{owner_id:'a',title:'a_PRIVATE_IMPORT'},{owner_id:'b',title:'b_PRIVATE_IMPORT'}]);
    expect((await s.request('a','POST','import',{works:[{id:'same-external-id',title:'a_UPDATED_IMPORT',status:'approved'}]})).status).toBe(200);
    expect(s.sqlite.prepare("SELECT title FROM games WHERE owner_id='b' AND ext_id='same-external-id'").get()).toMatchObject({title:'b_PRIVATE_IMPORT'});
  });

  it('同文件重复作品编号按顺序合并，保留非空简介并隔离同编号的其他成员',async()=>{
    const s=await setup();
    expect((await s.request('b','POST','import',{works:[{id:'repeated-id',title:'B_PRIVATE_IMPORT',status:'approved'}]})).status).toBe(200);
    const response=await s.request('a','POST','import',{works:[
      {id:'repeated-id',title:'A_FIRST',desc:'KEEP_DESCRIPTION',status:'pending',owner_id:'b',is_public:1},
      {id:'repeated-id',title:'A_LAST',desc:'',status:'approved',versions:[{r:2,s:'3/2/3'}],owner_id:'admin',is_public:1},
    ]});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({inserted:1,updated:1});
    expect(s.sqlite.prepare("SELECT title,descr,status,score,revisions,owner_id,is_public FROM games WHERE owner_id='a' AND ext_id='repeated-id'").get()).toMatchObject({title:'A_LAST',descr:'KEEP_DESCRIPTION',status:'approved',score:8,revisions:2,owner_id:'a',is_public:0});
    expect(s.sqlite.prepare("SELECT title,owner_id FROM games WHERE owner_id='b' AND ext_id='repeated-id'").get()).toMatchObject({title:'B_PRIVATE_IMPORT',owner_id:'b'});
    expect(s.sqlite.prepare("SELECT count(*) n FROM games WHERE ext_id='repeated-id'").get()).toMatchObject({n:2});
  });

  it('列表、导出和单项下载只返回本人内容；不可通过猜编号跨成员读写',async()=>{
    const s=await setup(),a=s.topic('a','A_PRIVATE_TOPIC'),b=s.topic('b','B_PRIVATE_TOPIC'),ag=s.game('a','A_PRIVATE_GAME'),bg=s.game('b','B_PRIVATE_GAME');
    s.review('a','A_PRIVATE_REVIEW');const br=s.review('b','B_PRIVATE_REVIEW');
    for(const path of ['topics?status=liked','products','games','reviews','export']){
      const res=await s.request('a','GET',path);expect(res.status,path).toBe(200);
      const text=await res.text();expect(text,path).not.toContain('B_PRIVATE');expect(text,path).not.toContain('PRIVATE_MODEL_KEY');
    }
    expect((await s.request('a','GET',`topics/${a}/brief`)).status).toBe(200);
    for(const suffix of ['', '/brief','/assets','/assets-preview','/product','/product-preview','/product-file','/game','/versions'])expect((await s.request('a','GET',`topics/${b}${suffix}`)).status,suffix).toBe(404);
    expect((await s.request('a','GET',`reviews/${br}`)).status).toBe(404);
    expect((await s.request('a','PATCH',`topics/${b}`,{status:'rejected',note:'attacker'})).status).toBe(404);
    expect((await s.request('a','PATCH',`games/${bg}`,{title:'attacker'})).status).toBe(404);
    expect((await s.request('a','DELETE',`games/${bg}`)).status).toBe(404);
    expect((await s.request('a','PATCH',`games/${ag}`,{title:'A_OWN_UPDATED'})).status).toBe(200);
    expect(s.sqlite.prepare('SELECT data,note FROM topics WHERE id=?').get(b)).toMatchObject({note:''});
    expect(s.sqlite.prepare('SELECT title FROM games WHERE id=?').get(bg)).toMatchObject({title:'B_PRIVATE_GAME'});
  });

  it('审核校准只包含公开样本与本人作品，不能借 topic_id 读取另一成员设计',async()=>{
    const s=await setup(),own=s.topic('a','A_PRIVATE_DESIGN'),other=s.topic('b','B_PRIVATE_DESIGN');
    s.game('admin','PUBLIC_CALIBRATION',1);s.game('a','A_PRIVATE_CALIBRATION');s.game('b','B_PRIVATE_CALIBRATION');s.game('admin','ADMIN_PRIVATE_CALIBRATION');
    const input={title:'Unrelated new game',html:'<!doctype html><canvas></canvas>',shots:[],probe:{captureMethod:'browser-viewport-v1'}};
    const prepared=await prepareReview(s.env,{...input,topic_id:own},'a');
    const text=JSON.stringify(prepared);expect(text).toContain('PUBLIC_CALIBRATION');expect(text).toContain('A_PRIVATE_CALIBRATION');expect(text).toContain('A_PRIVATE_DESIGN');
    expect(text).not.toContain('B_PRIVATE');expect(text).not.toContain('ADMIN_PRIVATE');
    const foreign=await prepareReview(s.env,{...input,topic_id:other},'a');expect(JSON.stringify(foreign)).not.toContain('B_PRIVATE_DESIGN');
  });

  it('v2 只用发布快照校准，不读取游戏库，全部保留16图且拒绝多图或无效图',async()=>{
    const s=await setup();s.env.modelExecutor='agent';
    s.game('a','OWN_HISTORY_MUST_NOT_APPEAR');s.game('admin','PUBLIC_HISTORY_MUST_NOT_APPEAR',1);
    const permitted={id:'case-a',title:'Allowed case',evidence:'Synthetic screenshot',score:{aes:0,ease:2,play:3},rationale:'Synthetic explanation'};
    const rules={schemaVersion:2 as const,id:'pinned-v2',contentHash:'a'.repeat(64),sourceUrl:'https://creator-hub-7mi.pages.dev/#/',capturedAt:'2026-11-02T10:00:00Z',publishedAt:'2026-11-02T10:01:00Z',rawDirection:'Current MUST and preference text',rawScoring:'Current 0–3 scoring',scoreMin:0 as const,scoreMax:3 as const,passScore:7 as const,notes:'',calibrationCases:[permitted,{...permitted,id:'same-game',title:'Current game',evidence:'SAME_GAME_PAST_ANSWER'}]};
    const original=s.DB.prepare.bind(s.DB);s.DB.prepare=(sql:string)=>{if(/FROM games/i.test(sql))throw new Error('v2 must not query game history');return original(sql);};
    const shots=Array.from({length:16},(_,i)=>({label:`synthetic-${i}`,data:'data:image/png;base64,YQ=='}));
    const input={title:'Current game',html:'<!doctype html><canvas></canvas>',shots,probe:{captureMethod:'browser-viewport-v1'},reportSchemaVersion:2 as const,rulesSnapshot:rules};
    const prepared=await prepareReview(s.env,input,'a');expect(prepared.reportSchemaVersion).toBe(2);expect(prepared.images).toHaveLength(16);
    expect(prepared.user.filter((p:any)=>p.type==='image')).toHaveLength(16);expect(prepared.system).toContain(permitted.title);expect(prepared.system).toContain(rules.rawScoring);
    for(const privateText of ['OWN_HISTORY_MUST_NOT_APPEAR','PUBLIC_HISTORY_MUST_NOT_APPEAR','SAME_GAME_PAST_ANSWER'])expect(prepared.system).not.toContain(privateText);
    expect(s.env.modelStore.get).not.toHaveBeenCalled();
    await expect(prepareReview(s.env,{...input,shots:[...shots,shots[0]]},'a')).rejects.toThrow('最多 16 张');
    await expect(prepareReview(s.env,{...input,shots:[{label:'invalid',data:'broken'}]},'a')).rejects.toThrow('不能截断或丢图');
    await expect(prepareReview(s.env,{...input,rulesSnapshot:null},'a')).rejects.toThrow('规则快照');
  });

  it('本人v2报告与历史列表保留null和锁定规则来源，不把未知显示为不可用',async()=>{
    const s=await setup(),id=s.review('a','Synthetic pending report');
    const result={schema_version:2,assessment_status:'needs_review',aes:null,ease:3,play:3,verdict:'待复核：合成证据不足'};
    const rules={id:'pinned-rules',passScore:7,sourceUrl:'https://creator-hub-7mi.pages.dev/#/'};
    s.sqlite.prepare('UPDATE reviews SET score=NULL,result=?,rules_snapshot=? WHERE id=?').run(JSON.stringify(result),JSON.stringify(rules),id);
    const detail=await(await s.request('a','GET',`reviews/${id}`)).json() as any;
    expect(detail).toMatchObject({score:null,result,rules_snapshot:rules});expect(detail.rules_snapshot).not.toBeTypeOf('string');
    const list=await(await s.request('a','GET','reviews')).json() as any[];
    expect(list.find(r=>r.id===id)).toMatchObject({score:null,report_schema_version:2,assessment_status:'needs_review',verdict:result.verdict});
    expect((await s.request('b','GET',`reviews/${id}`)).status).toBe(404);
  });

  it('撤销 Star 不撤销原会话；停用或改密码使会话版本失效',async()=>{
    const s=await setup(),before=await s.members.byId('a');
    await updateMember('a',{star:false},s.members);
    expect((await s.members.byId('a'))?.sessionVersion).toBe(before?.sessionVersion);
    expect((await s.request('a','GET','topics')).status).toBe(403);
    expect((await s.request('a','GET','reviews')).status).toBe(200);
    await updateMember('a',{star:true},s.members);expect((await s.request('a','GET','topics')).status).toBe(200);
    await updateMember('a',{password:'changed-password'},s.members);expect((await s.request('a','GET','reviews')).status).toBe(401);
    await updateMember('b',{enabled:false},s.members);expect((await s.request('b','GET','reviews')).status).toBe(401);
  });
});
