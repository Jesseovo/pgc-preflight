import {reviewActivity} from '../server/review-usage';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {adminDashboardApi,adminDateBounds} from '../server/admin-dashboard-api';
import worker,{ReviewControlPlane} from '../server/worker';
import {hashPassword,memberLogin} from '../server/members';
import {configStore,memberStore} from '../server/storage';
import {login,saveConfig} from '../server/settings';
import {inputSnapshot,saveArtifact} from '../server/forge-workspace';
import {executeForgeTask} from '../server/forge-runner';
import {enqueueReview} from '../server/review-jobs';
import {purgeOldForgeTasks} from '../server/forge-tasks';

const databases:DatabaseSync[]=[];
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();databases.splice(0).forEach(db=>db.close());});
const today='2026-10-28T04:00:00.000Z';
async function setup(beforeAdmin=false){
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(today));
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(n=>n.endsWith('.sql')&&(!beforeAdmin||n<'0024')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const preparedSql:string[]=[];
  const DB:any={prepare(sql:string){preparedSql.push(sql);let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>{const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>sqlite.prepare(sql).run(...params)};return s;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const out=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const secrets={ADMIN_PASSWORD:'dashboard-admin',SETTINGS_KEY:'dashboard-secret'},password=await hashPassword('member-password');
  for(const id of ['a','b','disabled','plain'])sqlite.prepare('INSERT INTO members(id,username,display_name,password_hash,password_salt,enabled,star,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,id,`Member ${id}`,password.hash,password.salt,id==='disabled'?0:1,id==='plain'?0:1,today,today);
  const cookies:Record<string,string>={admin:`pgc_admin=${await login(secrets.ADMIN_PASSWORD,secrets)}`,a:`pgc_member=${await memberLogin('a','member-password',memberStore(DB),secrets.SETTINGS_KEY)}`,'':''};
  const dispatch=vi.fn(async()=>Response.json({ok:true})),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const env:any={...secrets,DB,modelStore:configStore(DB),FORGE_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:dispatch})},CHECK_RATE_LIMIT:{limit:async()=>({success:true})},FORGE_RATE_LIMIT:{limit:async()=>({success:true})},ASSETS:{fetch:async()=>new Response('fixture')},BROWSER:{}};
  function request(path:string,method='GET',owner='admin',extra:Record<string,string>={}){return new Request(`https://dashboard.test/api/admin/${path}`,{method,headers:{Cookie:cookies[owner]||'',Origin:'https://dashboard.test','Content-Type':'application/json',...extra},body:method==='POST'?'{}':undefined});}
  async function call(path:string,method='GET',owner='admin',extra:Record<string,string>={}){const result=await adminDashboardApi(request(path,method,owner,extra),env);expect(result).not.toBeNull();return result!;}
  async function data(path:string){const res=await call(path);expect(res.status,await res.clone().text()).toBe(200);return res.json() as Promise<any>;}
  function topic(id:number,owner='a',time=today,extra:Record<string,any>={}){
    const fields={id,owner_id:owner,batch:'fixture',subject:`subject-${id}`,medium:'pixel',gesture:'tap',structure:'score',mood:'calm',status:'liked',data:JSON.stringify({title:`Title ${id}`,logline:`Summary ${id}`,core_loop:'ORIGINAL_INPUT_LOOP',private_html:'PRIVATE_JSON_SOURCE'}),created_at:time,updated_at:time,...extra};
    sqlite.prepare(`INSERT INTO topics(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields).map(()=>'?').join(',')})`).run(...Object.values(fields));
  }
  function task(id:string,project=1,owner='a',status='error',executor='platform',extra:Record<string,any>={}){
    const fields={id,owner_id:owner,kind:'brief',scope:`${owner}:brief:${project}`,payload:JSON.stringify({type:'brief',id:project}),status,executor,input_snapshot:JSON.stringify({cfg:{template:'ORIGINAL_TEMPLATE'},topic:{id:project,owner_id:owner,data:{title:`Original ${project}`}},revision:0,policy_revision:0,heads:{}}),error:status==='error'?'fixture error':'',created_at:today,updated_at:today,...extra};
    sqlite.prepare(`INSERT INTO forge_tasks(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields).map(()=>'?').join(',')})`).run(...Object.values(fields));
  }
  return {sqlite,DB,env,call,data,request,topic,task,dispatch,fetcher,preparedSql};
}

describe('管理员概览、作品及任务专用接口',()=>{
  it('使用北京时间自然日和连续7/30个日期，跨UTC日期仍保持同一天',()=>{
    const now=Date.parse('2026-10-27T18:00:00Z');
    expect(adminDateBounds('today',now)).toEqual(['2026-10-27T16:00:00.000Z','2026-10-28T16:00:00.000Z']);
    expect(adminDateBounds('7d',now)?.[0]).toBe('2026-10-21T16:00:00.000Z');
    expect(adminDateBounds('30d',now)?.[0]).toBe('2026-09-28T16:00:00.000Z');expect(adminDateBounds('all',now)).toBeNull();
  });

  it('完整数据库分页超过300条，筛选和总数准确，列表只含展示元数据',async()=>{
    const s=await setup();for(let i=1;i<=341;i++)s.topic(i,i<=320?'a':'b',i===1?'2025-01-01T00:00:00.000Z':today,{product_html:i===1?'PRIVATE_GAME_SOURCE':null,preview_svg:i===1?'<svg>PRIVATE_SVG_SOURCE</svg>':null});
    s.sqlite.prepare("INSERT INTO games(id,title,owner_id,updated_at) VALUES(1,'Title 1','a',?)").run(today);
    const page=await s.data('projects?page=14');expect(page.total).toBe(342);expect(page.items).toHaveLength(24);expect(page.pageSize).toBe(24);
    const last=await s.data('projects?page=15');expect(last.total).toBe(342);expect(last.items).toHaveLength(6);
    const mine=await s.data('projects?owner=a');expect(mine.total).toBe(321);expect(mine.items.every((p:any)=>p.ownerId==='a')).toBe(true);
    expect((await s.data('projects?owner=a&range=today')).total).toBe(320);
    expect((await s.data('projects?type=game')).items[0]).toMatchObject({id:1,type:'game',status:'historical',materials:{game:false}});
    const products=await s.data('projects?status=product');expect(products.total).toBe(1);expect(products.items[0]).toMatchObject({id:1,thumbnailUrl:'/api/admin/projects/topic/1/material/preview/thumbnail',materials:{game:true,preview:true,brief:false,assets:false}});
    expect((await s.data('projects?q=Title%20341')).total).toBe(1);expect((await s.data('projects?q=%25')).total).toBe(0);
    s.sqlite.prepare("UPDATE topics SET product_status='error' WHERE id=1").run();expect((await s.data('projects?status=product')).total).toBe(1);expect((await s.data('projects?status=error')).total).toBe(1);
    s.task('preview-failed',2,'a','error','platform',{kind:'preview',scope:'a:preview:2',payload:JSON.stringify({type:'preview',id:2})});
    expect((await s.data('projects?status=error')).items.map((p:any)=>p.id)).toContain(2);
    const combined=JSON.stringify([page,last,mine,products]);expect(combined).not.toMatch(/PRIVATE_GAME_SOURCE|PRIVATE_SVG_SOURCE|PRIVATE_JSON_SOURCE|password_hash|input_snapshot|encryptedKey|product_html|preview_svg/);
    expect((await s.call('projects?pageSize=101')).status).toBe(400);expect((await s.call('projects?range=forever')).status).toBe(400);
  });

  it('作品详情精确关联选题审核，材料按指定不可变历史读取并隔离预览和下载',async()=>{
    const s=await setup();s.topic(1);s.topic(2,'b');
    const version=async(topicId:number,kind:string,content:string,owner='a')=>saveArtifact(s.DB,{topicId,owner,kind,content,revision:0,executor:'platform',force:true});
    const old=await version(1,'game','<!doctype html><html>OLD_PRIVATE_GAME</html>');const current=await version(1,'game','<!doctype html><html>CURRENT_PRIVATE_GAME</html>');
    await version(1,'preview','<svg xmlns="http://www.w3.org/2000/svg"><text>PRIVATE_SVG</text></svg>');await version(1,'brief','## F. readable brief');await version(1,'assets','<!doctype html><html>PRIVATE_ASSETS</html>');
    const other=await version(2,'game','<!doctype html><html>OTHER_OWNER_GAME</html>','b');
    s.sqlite.prepare("INSERT INTO reviews(owner_id,title,topic_id,score,result,probe,created_at) VALUES('a','Title 1',1,7,'{}','{}',?)").run(today);
    s.sqlite.prepare("INSERT INTO reviews(owner_id,title,score,result,probe,created_at) VALUES('a','Title 1',9,'{}','{}',?)").run(today);
    const detail=await s.data('projects/topic/1');expect(detail.relatedReviews).toHaveLength(1);expect(detail.overview.core_loop).toBe('ORIGINAL_INPUT_LOOP');expect(detail.versions).toHaveLength(5);
    expect(JSON.stringify(detail)).not.toMatch(/OLD_PRIVATE_GAME|CURRENT_PRIVATE_GAME|PRIVATE_ASSETS|PRIVATE_SVG|PRIVATE_JSON_SOURCE|input_versions/);
    const meta=await s.data(`projects/topic/1/material/game?version=${old.id}`);expect(meta).not.toHaveProperty('content');expect(meta.previewUrl).toContain(`version=${old.id}`);
    const preview=await s.call(`projects/topic/1/material/game/preview?version=${old.id}`);expect(await preview.text()).toContain('OLD_PRIVATE_GAME');expect(preview.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");expect(preview.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');expect(preview.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await s.data(`projects/topic/1/material/game?version=${current.id}&raw=1`)).content).toContain('CURRENT_PRIVATE_GAME');
    expect((await s.data('projects/topic/1/material/brief')).content).toBe('## F. readable brief');
    expect((await s.data('projects/topic/1/material/expand')).content).toContain('Title 1');
    const thumbnail=await s.call('projects/topic/1/material/preview/thumbnail');expect(thumbnail.headers.get('Content-Type')).toContain('image/svg+xml');expect(await thumbnail.text()).toMatch(/^<svg/);
    const file=await s.call(`projects/topic/1/material/game/file?version=${old.id}`);expect(file.headers.get('Content-Disposition')).toContain('attachment');expect(file.headers.get('Content-Security-Policy')).toBe('sandbox');expect(await file.text()).toContain('OLD_PRIVATE_GAME');
    expect((await s.call(`projects/topic/1/material/game?version=${other.id}`)).status).toBe(404);expect((await s.call(`projects/topic/1/material/brief?version=${old.id}`)).status).toBe(404);
  });

  it('概览按首次游戏版本计算新增成品，旧成品改版不重复累计，活动任务与成员数来自全库',async()=>{
    const s=await setup();for(let i=1;i<=310;i++){s.topic(i);s.task(`failure-${i}`,i);}
    const version=async(id:string,topic:number,time:string)=>s.sqlite.prepare("INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,executor,disposition,created_at) VALUES(?,'a',?,'game','PRIVATE_DASHBOARD_GAME',0,'platform','historical',?)").run(id,topic,time);
    await version('old-product',1,'2026-09-01T00:00:00.000Z');await version('old-rewrite',1,today);await version('first-new',2,today);await version('new-rewrite',2,today);
    s.sqlite.prepare("UPDATE topics SET product_html='PRIVATE_DASHBOARD_GAME' WHERE id IN (1,2)").run();
    s.task('active-agent',311,'a','running','agent');s.topic(311);
    s.sqlite.prepare("INSERT INTO review_jobs(id,owner_id,title,status,stage,model_executor,created_at,updated_at) VALUES('review-active','b','Review','running','review','agent',?,?)").run(today,today);
    const dashboard=await s.data('dashboard?range=today');expect(dashboard.timeZone).toBe('Asia/Shanghai');expect(dashboard.metrics).toEqual({productiveMembers:1,newProducts:1,failedTasks:310,activeTasks:0});expect(dashboard.waitingAgentCount).toBe(2);expect(dashboard.attention).toHaveLength(8);
    expect(dashboard.progress.find((p:any)=>p.id==='a')).toMatchObject({creations:0,products:1,activeTasks:0,currentTask:expect.stringContaining('等待 Agent')});
    expect((await s.data('dashboard?range=today&owner=b')).metrics).toEqual({productiveMembers:0,newProducts:0,failedTasks:0,activeTasks:0});
    expect(JSON.stringify(dashboard)).not.toMatch(/PRIVATE_DASHBOARD_GAME|ORIGINAL_TEMPLATE|input_snapshot|password_hash/);
  });

  it('总览只取每位成员的一条当前任务，同时用全量聚合保持准确计数',async()=>{
    const s=await setup();s.topic(1);const activeStatuses=['queued','running','pending','capture','review','verify'];
    for(let i=0;i<240;i++)s.task(`active-${i}`,1,'a',i%2?'running':'queued','platform',{kind:'game',scope:`a:game:${i}`,payload:JSON.stringify({type:'game',id:1}),updated_at:new Date(Date.parse(today)+i).toISOString()});
    const reviewTask=s.sqlite.prepare('INSERT INTO review_jobs(id,owner_id,title,status,stage,model_executor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
    for(let i=0;i<activeStatuses.length;i++){
      reviewTask.run(`platform-review-${i}`,'a','Platform review',activeStatuses[i],'review','platform',today,new Date(Date.parse(today)+i).toISOString());
      reviewTask.run(`agent-review-${i}`,'b','Agent review',activeStatuses[i],'verify','agent',today,new Date(Date.parse(today)+i).toISOString());
    }
    reviewTask.run('review-waiting','disabled','Review','running','verify','agent',today,today);
    const result=await s.data('dashboard?range=today');expect(result.metrics.activeTasks).toBe(246);expect(result.waitingAgentCount).toBe(7);
    expect(result.progress.find((m:any)=>m.id==='a')).toMatchObject({activeTasks:246,currentTask:'游戏制作 · 执行中'});
    expect(result.progress.find((m:any)=>m.id==='b')).toMatchObject({activeTasks:0,currentTask:'AI 审核 · 等待 Agent'});
    const currentQuery=s.preparedSql.find(sql=>sql.includes('active_ranked'))!;expect(currentQuery).toContain('row_number() OVER(PARTITION BY owner_id');expect(currentQuery).toContain('WHERE member_rank=1');expect(currentQuery).toContain('SELECT owner_id,kind,executor,status,updated_at FROM active_ranked');expect(currentQuery).not.toContain('input_snapshot');
    const aggregateQuery=s.preparedSql.find(sql=>sql.includes("sum(executor='platform') platform_count"))!;expect(aggregateQuery).toContain("sum(executor='agent') agent_count");expect(aggregateQuery).toContain('GROUP BY owner_id');expect(aggregateQuery).not.toContain('input_snapshot');
    expect(result.progress).toHaveLength(4);expect(JSON.stringify(result)).not.toMatch(/active-\d+|platform-review-\d+|agent-review-\d+/);
  });

  it('任务数据库分页、成员/状态/类型/项目筛选准确，Agent继续指令携原编号',async()=>{
    const s=await setup();s.topic(1);s.topic(2,'b');for(let i=0;i<325;i++)s.task(`task-${i}`,1);
    s.task('b-task',2,'b');s.task('agent-original',1,'a','running','agent');
    s.sqlite.prepare("INSERT INTO review_jobs(id,owner_id,title,status,model_executor,input_ready,created_at,updated_at) VALUES('review-source-gone','a','Title 1','error','platform',0,?,?)").run(today,today);
    const page=await s.data('tasks?page=14');expect(page.total).toBe(328);expect(page.items).toHaveLength(16);
    expect((await s.data('tasks?owner=a&status=error&type=creation')).total).toBe(325);expect((await s.data('tasks?project=1')).total).toBe(326);
    const agent=await s.data('tasks/creation/agent-original');expect(agent).toMatchObject({task:{executor:'agent',canRetry:false,statusLabel:'等待 Agent'},continuePrompt:expect.stringContaining('agent-original')});
    const review=await s.data('tasks/review/review-source-gone');expect(review).toMatchObject({sourceAvailable:false,task:{canRetry:false,retryReason:expect.stringContaining('重新上传')}});
    const waiting=await s.data('tasks?status=waiting-agent');expect(waiting.total).toBe(1);expect(waiting.waitingAgentCount).toBe(1);
    expect(waiting.activeCount).toBe(0);expect((await s.data('tasks?status=active')).total).toBe(0);
    expect(await s.data('projects?owner=a')).toMatchObject({activeCount:0,waitingAgentCount:1});
    expect(JSON.stringify([page,agent,review])).not.toMatch(/input_snapshot|ORIGINAL_TEMPLATE|payload|receipt_hash|PRIVATE_JSON_SOURCE/);
  });

  it('所有数据和材料接口只允许管理员Cookie，Bearer不能借Cookie升权，重试检查Origin',async()=>{
    const s=await setup();s.topic(1);s.task('failed');
    const paths=['dashboard','projects','projects/topic/1','projects/topic/1/material/brief','projects/topic/1/material/game/preview','tasks','tasks/creation/failed'];
    for(const path of paths){for(const owner of ['','a'])expect((await s.call(path,'GET',owner)).status,path).toBe(403);expect((await s.call(path,'GET','admin',{Authorization:'Bearer fixture-device-token'})).status,path).toBe(403);}
    expect((await s.call('tasks/creation/failed/retry','POST','admin',{Origin:'https://other.test'})).status).toBe(403);expect(s.dispatch).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('失败平台任务一次直接重试并发去重，原任务不变、保留实际成员和原输入快照',async()=>{
    const s=await setup();s.topic(1,'a',today,{product_html:'OLD_PRODUCT_SURVIVES'});s.task('original-failed',1);
    const before=s.sqlite.prepare("SELECT * FROM forge_tasks WHERE id='original-failed'").get() as any;
    const responses=await Promise.all([s.call('tasks/creation/original-failed/retry','POST'),s.call('tasks/creation/original-failed/retry','POST')]);expect(responses.map(r=>r.status)).toEqual([202,202]);
    const [one,two]=await Promise.all(responses.map(r=>r.json())) as any[];expect(one.task.id).toBe(two.task.id);expect(one.task).toMatchObject({ownerId:'a',requestedBy:'admin',retryOf:'original-failed',executor:'platform'});
    const retry=s.sqlite.prepare('SELECT * FROM forge_tasks WHERE id=?').get(one.task.id) as any;expect(retry.input_snapshot).toBe(before.input_snapshot);expect(retry.payload).toBe(before.payload);expect(retry.owner_id).toBe('a');expect(s.sqlite.prepare("SELECT * FROM forge_tasks WHERE id='original-failed'").get()).toEqual(before);
    expect(s.sqlite.prepare('SELECT product_html FROM topics WHERE id=1').get()).toMatchObject({product_html:'OLD_PRODUCT_SURVIVES'});
    s.sqlite.prepare("UPDATE forge_tasks SET status='done' WHERE id=?").run(retry.id);
    expect(await (await s.call('tasks/creation/original-failed/retry','POST')).json()).toMatchObject({task:{id:retry.id,status:'done'}});
    s.sqlite.prepare("UPDATE forge_tasks SET status='error' WHERE id=?").run(retry.id);
    expect(await (await s.call('tasks/creation/original-failed/retry','POST')).json()).toMatchObject({task:{id:retry.id,status:'error'}});
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks WHERE retry_of=?').get('original-failed')).toMatchObject({n:1});expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('重试完整制作保留原流程和高思考预算，以新任务重新开始而不复制阶段',async()=>{
    const s=await setup();
    const oldGame='<!doctype html><html>OLD_V2_RETRY_GAME</html>';
    s.topic(1,'a',today,{creative_version:2,brief_md:'原策划书',product_html:oldGame});
    const job={type:'game',id:1,creative_version:2,requestId:'original-request',regenerate:true};
    const snapshot=await inputSnapshot(s.DB,'a',job);
    expect(snapshot).toMatchObject({creative_version:2,platform_creation_policy:{version:1,effort:'high',maxTokens:64000}});
    const lockedInput=JSON.stringify(snapshot);
    s.task('failed-v2',1,'a','error','platform',{kind:'game',scope:'a:game:1',payload:JSON.stringify(job),creative_version:2,input_snapshot:lockedInput,
      phase:'polish:model',phase_started_at:today,started_at:today,model_started_at:today});
    s.sqlite.prepare("INSERT INTO forge_creation_stages(task_id,stage,owner_id,topic_id,version_id,content_hash,self_check,created_at) VALUES('failed-v2','build','a',1,'original-stage','original-hash','{}',?)").run(today);
    const original=s.sqlite.prepare("SELECT * FROM forge_tasks WHERE id='failed-v2'").get();

    const response=await s.call('tasks/creation/failed-v2/retry','POST');
    expect(response.status).toBe(202);
    const {task}=await response.json() as {task:{id:string}};
    expect(task.id).not.toBe('failed-v2');
    const saved=s.sqlite.prepare('SELECT creative_version,input_snapshot,payload,status,phase,phase_started_at,started_at,model_started_at FROM forge_tasks WHERE id=?').get(task.id);
    expect(saved).toMatchObject({creative_version:2,payload:JSON.stringify({...job,requestId:task.id}),
      status:'queued',phase:null,phase_started_at:null,started_at:null,model_started_at:null});
    expect(saved?.input_snapshot === lockedInput).toBe(true);
    expect(s.sqlite.prepare('SELECT task_id,stage FROM forge_creation_stages').all()).toEqual([{task_id:'failed-v2',stage:'build'}]);
    expect(s.sqlite.prepare("SELECT * FROM forge_tasks WHERE id='failed-v2'").get()).toEqual(original);
    expect(s.sqlite.prepare('SELECT product_html,product_request_id FROM topics WHERE id=1').get()).toEqual({product_html:oldGame,product_request_id:task.id});
    expect(s.dispatch).toHaveBeenCalledTimes(1);
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('活动scope冲突返回现有任务而不转换Agent或修改状态，拒绝越权或缺失原输入',async()=>{
    const s=await setup();s.topic(1);s.task('failed');s.task('active-original',1,'a','running','agent',{detail:'ORIGINAL_ACTIVE_DETAIL'});
    const before=s.sqlite.prepare("SELECT * FROM forge_tasks WHERE id='active-original'").get();
    const response=await s.call('tasks/creation/failed/retry','POST');expect(await response.json()).toMatchObject({task:{id:'active-original',executor:'agent'}});expect(s.sqlite.prepare("SELECT * FROM forge_tasks WHERE id='active-original'").get()).toEqual(before);expect(s.dispatch).not.toHaveBeenCalled();
    s.task('agent-failed',2,'a','error','agent');expect((await s.call('tasks/creation/agent-failed/retry','POST')).status).toBe(409);
    s.topic(3,'disabled');s.task('disabled-failed',3,'disabled');expect((await s.call('tasks/creation/disabled-failed/retry','POST')).status).toBe(409);
    s.topic(4);s.task('no-input',4,'a','error','platform',{input_snapshot:null});expect((await s.call('tasks/creation/no-input/retry','POST')).status).toBe(409);
    s.topic(5);s.task('wrong-owner-input',5,'a','error','platform',{input_snapshot:JSON.stringify({cfg:{},topic:{id:5,owner_id:'b'}})});expect((await s.call('tasks/creation/wrong-owner-input/retry','POST')).status).toBe(409);
    expect((await s.data('tasks/creation/wrong-owner-input')).task.canRetry).toBe(false);
    expect((await s.data('tasks/creation/no-input')).sourceAvailable).toBe(false);
  });

  it('管理员索引支持按成员和项目定位，不依赖每个作品反复扫描任务表',async()=>{
    const s=await setup();
    const plan=s.sqlite.prepare("EXPLAIN QUERY PLAN SELECT id FROM forge_tasks WHERE owner_id=? AND (CASE WHEN json_valid(payload) THEN COALESCE(json_extract(payload,'$.id'),json_extract(payload,'$.ids[0]')) END)=? AND executor=? AND status=?").all('a',1,'platform','running');
    expect(JSON.stringify(plan)).toContain('forge_tasks_admin_topic');
    const history=s.sqlite.prepare('EXPLAIN QUERY PLAN SELECT id FROM artifact_versions WHERE topic_id=? AND owner_id=? ORDER BY kind,created_at DESC').all(1,'a');
    expect(JSON.stringify(history)).toContain('artifact_versions_admin_topic');
    s.topic(1);s.task('indexed-project-task');await s.data('projects');
    const countSql=s.preparedSql.find(sql=>sql.startsWith('WITH project_meta')&&sql.includes('SELECT count(*) total'))!;
    const actualPlan=s.sqlite.prepare(`EXPLAIN QUERY PLAN ${countSql}`).all();
    const details=actualPlan.map((r:any)=>r.detail).join('\n');expect(details).toMatch(/forge_tasks_admin_topic \(owner_id=\? AND <expr>=\?/);expect(details).not.toMatch(/SCAN f\b/);
  });

  it('审核任务只保存明确选题关联，未完成/源清理后仍可精确筛选，不按同名关联',async()=>{
    const s=await setup();s.topic(1);s.topic(2,'b');
    const id=crypto.randomUUID(),payload={request_id:id,topic_id:1,title:'Same title',html:'<!doctype html><html>PRIVATE_REVIEW_HTML</html>'};
    await enqueueReview({...s.env,modelExecutor:'agent'},payload,'a');
    const unrelated=crypto.randomUUID();await enqueueReview({...s.env,modelExecutor:'agent'},{...payload,request_id:unrelated,topic_id:undefined},'a');
    const list=await s.data('tasks?type=review&project=1');expect(list.total).toBe(1);expect(list.items[0]).toMatchObject({id,projectId:1,projectType:'topic',ownerId:'a'});
    expect(JSON.stringify(list)).not.toContain('PRIVATE_REVIEW_HTML');
    s.sqlite.prepare('DELETE FROM review_inputs WHERE job_id=?').run(id);s.sqlite.prepare("UPDATE review_jobs SET input_ready=0,status='error' WHERE id=?").run(id);
    expect((await s.data('tasks?type=review&project=1')).total).toBe(1);expect(await s.data(`tasks/review/${id}`)).toMatchObject({sourceAvailable:false,task:{projectId:1,canRetry:false}});
    await expect(enqueueReview({...s.env,modelExecutor:'agent'},{...payload,request_id:crypto.randomUUID(),topic_id:2},'a')).rejects.toMatchObject({status:404});
    expect(s.sqlite.prepare('SELECT count(*) n FROM review_jobs').get()).toEqual({n:2});expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('迁移只从原job/report精确关系回填选题，保留旧评分与报告并忽略同名及跨owner关系',async()=>{
    const s=await setup(true);s.topic(1);s.topic(2,'b');
    for(const id of ['exact','same-title-only','wrong-owner'])s.sqlite.prepare("INSERT INTO review_jobs(id,owner_id,title,status,created_at,updated_at) VALUES(?,'a','Same title','done',?,?)").run(id,today,today);
    s.sqlite.prepare("INSERT INTO reviews(owner_id,title,topic_id,score,result,probe,created_at,job_id) VALUES('a','Original exact title',1,7,'PRIVATE_ORIGINAL_REPORT','PRIVATE_ORIGINAL_PROBE',?,'exact')").run(today);
    s.sqlite.prepare("INSERT INTO reviews(owner_id,title,topic_id,score,result,probe,created_at) VALUES('a','Same title',1,9,'UNLINKED_REPORT','{}',?)").run(today);
    s.sqlite.prepare("INSERT INTO reviews(owner_id,title,topic_id,score,result,probe,created_at,job_id) VALUES('b','Same title',2,5,'OTHER_OWNER_REPORT','{}',?,'wrong-owner')").run(today);
    const before=s.sqlite.prepare('SELECT * FROM reviews ORDER BY id').all();s.sqlite.exec(readFileSync('migrations/0024_admin_dashboard.sql','utf8'));
    expect(s.sqlite.prepare('SELECT id,topic_id FROM review_jobs ORDER BY id').all()).toEqual([{id:'exact',topic_id:1},{id:'same-title-only',topic_id:null},{id:'wrong-owner',topic_id:null}]);expect(s.sqlite.prepare('SELECT * FROM reviews ORDER BY id').all()).toEqual(before);
  });

  it('30天清理保留仍被直接重试引用的旧任务，先清理子任务再清理原任务',async()=>{
    const s=await setup(true);s.sqlite.exec('PRAGMA foreign_keys=ON');
    // setup(true) models the deployed pre-0024 schema; apply the new self-reference.
    s.sqlite.exec(readFileSync('migrations/0024_admin_dashboard.sql','utf8'));
    const old='2026-08-01T00:00:00.000Z',recent='2026-10-28T04:00:00.000Z';
    s.task('old-parent',1,'a','error','platform',{updated_at:old});
    s.task('recent-retry',1,'a','queued','platform',{retry_of:'old-parent',updated_at:recent});
    await purgeOldForgeTasks(s.DB,Date.parse(today));
    expect(s.sqlite.prepare('SELECT id FROM forge_tasks ORDER BY id').all()).toEqual([{id:'old-parent'},{id:'recent-retry'}]);
    s.sqlite.prepare('UPDATE forge_tasks SET status=\'error\',updated_at=? WHERE id=\'recent-retry\'').run(old);
    await purgeOldForgeTasks(s.DB,Date.parse(today));
    expect(s.sqlite.prepare('SELECT id FROM forge_tasks').all()).toEqual([{id:'old-parent'}]);
    await purgeOldForgeTasks(s.DB,Date.parse(today));
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toEqual({n:0});
  });

  it('完成与失败按发生时间计入北京时间日期，最近活动独立于所选统计日期',async()=>{
    const s=await setup(),yesterday='2026-10-27T15:59:59.000Z';s.topic(1);s.topic(2,'b');
    s.task('cross-day-done',1,'a','done','platform',{created_at:yesterday,updated_at:today});
    s.task('cross-day-failure',1,'a','error','platform',{created_at:yesterday,updated_at:today});
    s.task('past-activity',2,'b','done','platform',{created_at:yesterday,updated_at:yesterday});
    s.sqlite.prepare("INSERT INTO review_jobs(id,owner_id,title,status,created_at,updated_at) VALUES('cross-day-review','a','Review','done',?,?)").run(yesterday,today);
    const data=await s.data('dashboard?range=today');expect(data.metrics).toMatchObject({productiveMembers:1,failedTasks:1});expect(data.progress.find((r:any)=>r.id==='a')).toMatchObject({creations:1,reviews:1,lastActivity:today});expect(data.progress.find((r:any)=>r.id==='b')).toMatchObject({creations:0,reviews:0,lastActivity:yesterday});
    expect(data.attention.map((r:any)=>r.id)).toEqual(['cross-day-failure']);
    const failedToday=await s.data('tasks?range=today&status=error');expect(failedToday.total).toBe(data.metrics.failedTasks);expect(failedToday.items.map((r:any)=>r.id)).toEqual(['cross-day-failure']);
    const completedToday=await s.data('tasks?range=today&status=done');expect(completedToday.total).toBe(2);expect(completedToday.items.map((r:any)=>r.id).sort()).toEqual(['cross-day-done','cross-day-review']);
    expect((await s.data('tasks?range=today&owner=b')).total).toBe(0);
  });

  it('新增成品下钻按首次游戏版本日期定位，旧成品改版与pending结果不混入',async()=>{
    const s=await setup(),yesterday='2026-10-27T15:59:59.000Z';
    for(const id of [1,2,3])s.topic(id,'a',today,{product_html:`PRIVATE_GAME_${id}`});
    const version=(id:string,topicId:number,time:string,disposition='historical')=>s.sqlite.prepare("INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,executor,disposition,created_at) VALUES(?,'a',?,'game','PRIVATE_GAME',0,'platform',?,?)").run(id,topicId,disposition,time);
    version('previous-first',1,yesterday);version('previous-rewrite',1,today);version('today-first',2,today,'current');version('pending-only',3,today,'pending');
    const dashboard=await s.data('dashboard?range=today'),drill=await s.data('projects?range=today&firstProducts=1');
    expect(drill.total).toBe(dashboard.metrics.newProducts);expect(drill.total).toBe(1);expect(drill.items.map((r:any)=>r.id)).toEqual([2]);
    expect((await s.data('projects?range=today&status=product')).total).toBe(3);
    expect((await s.data('projects?range=today&firstProducts=1&owner=b')).total).toBe(0);
    expect((await s.data('projects?range=all&firstProducts=1')).total).toBe(2);
  });

  it('图表补零、半开时段下钻、首次成品去重与当前任务分组保持一致',async()=>{
    const s=await setup();s.topic(1,'a',today,{product_html:'PRIVATE'});
    for(const [id,time] of [['first','2026-10-28T03:00:00.000Z'],['rewrite',today]])s.sqlite.prepare("INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,executor,disposition,created_at) VALUES(?,'a',1,'game','PRIVATE',0,'platform','current',?)").run(id,time);
    s.sqlite.prepare("INSERT INTO review_jobs(id,owner_id,title,filename,status,created_at,updated_at) VALUES('done','a','Test','test.html','done',?,?)").run('2026-10-27T01:00:00.000Z','2026-10-28T03:59:59.000Z');
    s.task('pq',1,'a','queued','platform');s.task('ar',2,'a','running','agent');
    const data=await s.data('dashboard?range=today');expect(data.trend).toHaveLength(24);expect(data.trend.reduce((n:number,r:any)=>n+r.products,0)).toBe(1);expect(data.trend.reduce((n:number,r:any)=>n+r.reviews,0)).toBe(1);
    const bin=data.trend.find((r:any)=>r.products);expect(bin).toMatchObject({from:'2026-10-28T03:00:00.000Z',to:'2026-10-28T04:00:00.000Z',reviews:1});
    const query=new URLSearchParams({from:bin.from,to:bin.to});expect((await s.data('projects?firstProducts=1&'+query)).total).toBe(1);
    expect((await reviewActivity(s.DB,new URLSearchParams({from:bin.from,to:bin.to,status:'done',scope:'all'}))).total).toBe(1);
    for(const group of data.taskGroups)expect((await s.data('tasks?status='+group.key)).total).toBe(group.count);
    expect((await s.data('dashboard?range=7d&owner=b')).trend.every((r:any)=>!r.products&&!r.reviews)).toBe(true);
    expect((await s.call('projects?from=invalid&to=invalid')).status).toBe(400);
    const plan=s.sqlite.prepare("EXPLAIN QUERY PLAN SELECT updated_at,count(*) FROM review_jobs WHERE status='done' AND updated_at>=? AND updated_at<? GROUP BY updated_at").all(bin.from,bin.to);expect(plan.some((r:any)=>String(r.detail).includes('INDEX'))).toBe(true);
  });

  it('真实Worker和控制面路径传递Runner，重试沿用旧输入且上游修改后的结果保持pending',async()=>{
    const s=await setup();s.topic(1,'a',today,{brief_md:'EXISTING_BRIEF',product_html:'EXISTING_PRODUCT'});
    await saveConfig({profile:'opus',protocol:'anthropic',baseUrl:'https://fixture.example',model:'claude-opus-5-5',apiKey:'synthetic-test-key'},s.env.modelStore,s.env.SETTINGS_KEY);
    const snapshot=await inputSnapshot(s.DB,'a',{type:'brief',id:1});s.task('worker-failure',1,'a','error','platform',{input_snapshot:JSON.stringify(snapshot)});
    s.sqlite.prepare("UPDATE topics SET requirements='NEW_REQUIREMENTS',content_revision=content_revision+1 WHERE id=1").run();
    const response=await worker.fetch(s.request('tasks/creation/worker-failure/retry','POST'),s.env,{waitUntil(){}});expect(response.status).toBe(202);const {task}=await response.json() as any;expect(s.dispatch).toHaveBeenCalled();
    const control=new ReviewControlPlane({waitUntil(){}},s.env);const duplicate=await control.fetch(s.request('tasks/creation/worker-failure/retry','POST'));expect(await duplicate.json()).toMatchObject({task:{id:task.id}});
    const fetcher=vi.fn(async(_url:any,init:any)=>{const input=JSON.parse(init.body);expect(JSON.stringify(input)).toContain('ORIGINAL_INPUT_LOOP');expect(JSON.stringify(input)).not.toContain('NEW_REQUIREMENTS');return Response.json({content:[{type:'text',text:'## F. 游戏设计\nORIGINAL_INPUT_RESULT'}],stop_reason:'end_turn'});});vi.stubGlobal('fetch',fetcher);
    await executeForgeTask(s.env,task.id);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(s.sqlite.prepare('SELECT status,owner_id FROM forge_tasks WHERE id=?').get(task.id)).toMatchObject({status:'done',owner_id:'a'});expect(s.sqlite.prepare('SELECT disposition,content FROM artifact_versions WHERE task_id=?').get(task.id)).toMatchObject({disposition:'pending',content:expect.stringContaining('ORIGINAL_INPUT_RESULT')});
    expect(s.sqlite.prepare('SELECT brief_md,product_html FROM topics WHERE id=1').get()).toMatchObject({brief_md:'EXISTING_BRIEF',product_html:'EXISTING_PRODUCT'});
  });

  it('游戏重试只更换执行幂等编号，保留旧游戏直到新版本实际保存，执行前再次检查Star',async()=>{
    const s=await setup(),old='<!doctype html><html>OLD_RETRY_GAME</html>';
    s.topic(1,'a',today,{product_html:old});s.topic(2,'a',today,{product_html:old});
    await saveConfig({profile:'opus',protocol:'anthropic',baseUrl:'https://fixture.example',model:'claude-opus-5-5',apiKey:'synthetic-test-key'},s.env.modelStore,s.env.SETTINGS_KEY);
    for(const id of [1,2]){
      const snapshot=await inputSnapshot(s.DB,'a',{type:'game',id,requestId:'old-id',regenerate:true});
      s.task(`failed-game-${id}`,id,'a','error','platform',{kind:'game',scope:`a:game:${id}`,payload:JSON.stringify({type:'game',id,requestId:'old-id',regenerate:true}),input_snapshot:JSON.stringify(snapshot)});
    }
    const {task}=await (await s.call('tasks/creation/failed-game-1/retry','POST')).json() as any;
    const saved=s.sqlite.prepare('SELECT payload,input_snapshot,creative_version FROM forge_tasks WHERE id=?').get(task.id) as any;
    expect(saved.creative_version).toBe(1);
    expect(JSON.parse(saved.payload)).toEqual({type:'game',id:1,requestId:task.id,regenerate:true});expect(s.sqlite.prepare('SELECT product_html,product_request_id,product_status FROM topics WHERE id=1').get()).toEqual({product_html:old,product_request_id:task.id,product_status:'queued'});
    const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><button>New version</button><script>let score=0;</script></body></html>';
    const fetcher=vi.fn(async()=>Response.json({content:[{type:'text',text:html}],stop_reason:'end_turn'}));vi.stubGlobal('fetch',fetcher);
    await executeForgeTask(s.env,task.id);expect(s.sqlite.prepare('SELECT product_html FROM topics WHERE id=1').get()).toEqual({product_html:html});expect(s.sqlite.prepare('SELECT owner_id,kind,disposition FROM artifact_versions WHERE task_id=?').get(task.id)).toEqual({owner_id:'a',kind:'game',disposition:'current'});
    const next=await (await s.call('tasks/creation/failed-game-2/retry','POST')).json() as any;
    s.sqlite.prepare("UPDATE members SET star=0 WHERE id='a'").run();await executeForgeTask(s.env,next.task.id);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(s.sqlite.prepare('SELECT status FROM forge_tasks WHERE id=?').get(next.task.id)).toEqual({status:'error'});expect(s.sqlite.prepare('SELECT product_html FROM topics WHERE id=2').get()).toEqual({product_html:old});
  });
});
