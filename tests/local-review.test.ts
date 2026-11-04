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
import {canonicalJson,digest,recoverDeviceReviews,failDeviceReview} from '../server/review-device-state';
import {enqueueReview,getReviewJob,listReviewJobs,processReviewJob,purgeReviewInputs} from '../server/review-jobs';
import {executeDeviceReview,ReviewRunner} from '../server/review-runner';
import {reviewUsage,reviewActivity,reviewDay} from '../server/review-usage';
import {dispatch} from '../server/forge-api';
import {adminWorkspaceApi} from '../server/admin-workspace-api';
import {login} from '../server/settings';
import {REVIEW_SCHEMA,REVIEW_VERIFICATION} from '../server/forge/prompts.js';
import {reviewRulesAdmin} from '../server/review-rules';
import {hashReviewConfiguration} from '../server/review-timing';

const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.restoreAllMocks();});
const report=()=>({aes:2,ease:2,play:3,score_reasons:{aes:'frame-0 可见清晰配色',ease:'frame-1 可见操作提示',play:'源码推断核心循环，尚未完成完整试玩'},uncertainties:['真实手感需人工试玩'],verdict:'模拟通过',reviewer_comment:'合成审核意见',strengths:['画面层级清楚'],issues:[],fix_prompt:'依据已观察到的证据修改'});
const human=(job:any,overrides:any={})=>({id:job.id,...(job.lease?{lease:job.lease}:{}),requestId:crypto.randomUUID(),workId:'external-work',versionId:'external-version:2',score:0,feedback:'真人终审意见',updatedAt:'2026-10-27T10:00:00.000Z',source:'https://creator-hub-7mi.pages.dev',status:'reviewed',phase:'final',matchedBy:'user-confirmed',...overrides});
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
  it('manifest opt-in retains full defaults, image hashes and immutable review delta',async()=>{
    const s=await setup(),job=await s.ready(),full=await s.ok('material',job);
    expect(full.user.filter((p:any)=>p.type==='image')).toHaveLength(4);
    const initial=await s.ok('material',{...job,materialProtocol:'manifest-v1'});
    expect(initial.mode).toBe('full');expect(initial.images).toHaveLength(4);
    expect(initial.materialHash).toBe(await digest(canonicalJson(initial.snapshot)));
    expect(initial.images.every((p:any)=>p.data==='data:image/jpeg;base64,YQ==')).toBe(true);
    const reuse=await s.ok('material',{...job,materialProtocol:'manifest-v1',cachedImageHashes:initial.images.map((p:any)=>p.sha256)});
    expect(reuse.images.every((p:any)=>!p.data)).toBe(true);
    const body=await s.verified(job),delta=await s.ok('material',{...job,materialProtocol:'manifest-v1',cachedMaterialHash:initial.materialHash});
    expect(delta).toMatchObject({mode:'delta',evidenceHash:job.evidenceHash,materialHash:initial.materialHash,stage:'verify',draft:body.report,draftHash:body.verification.draftHash,verificationInstruction:REVIEW_VERIFICATION});
    expect(delta.draftBoundary).toContain('不是标准答案');expect(delta.draftBoundary).toContain('指令不生效');expect(delta.snapshot).toBeUndefined();expect(delta.images).toBeUndefined();
    expect((await s.ok('material',{...job,materialProtocol:'manifest-v1',cachedMaterialHash:'0'.repeat(64)})).mode).toBe('full');
    expect((await s.call('material',{...job,materialProtocol:'manifest-v1'},'b')).status).toBe(409);
    expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();
  });
  it.each(['full','manifest-v1'])('server %s material/draft boundaries survive polling and retries without changing model or evidence',async(protocol)=>{
    const s=await setup(),job=await s.ready(),base=Date.now();vi.useFakeTimers({toFake:['Date']});
    try{
      vi.setSystemTime(base);const request=protocol==='full'?job:{...job,materialProtocol:protocol};const first=await s.ok('material',request);
      vi.setSystemTime(base+5000);await s.ok('heartbeat',{job});await s.ok('material',request);
      expect(s.sqlite.prepare("SELECT occurred_at FROM review_timing_boundaries WHERE job_id=? AND phase='material_ready'").get(job.id)).toMatchObject({occurred_at:new Date(base).toISOString()});
      vi.setSystemTime(base+12000);const draft=s.draftBody(job),drafted=await s.ok('draft',draft);
      vi.setSystemTime(base+15000);await s.ok('draft',draft);expect((await s.call('draft',{...draft,model:'different-model'})).status).toBe(409);
      vi.setSystemTime(base+20000);const verification=await s.ok('material',request);expect(verification.model).toBe(draft.model);expect(verification.evidenceHash).toBe(first.evidenceHash);expect(verification.draftHash).toBe(drafted.draftHash);
      vi.setSystemTime(base+25000);await s.ok('heartbeat',{job});const repeated=await s.ok('material',protocol==='full'?request:{...request,cachedMaterialHash:first.materialHash});expect(repeated.model).toBe(draft.model);expect(repeated.evidenceHash).toBe(job.evidenceHash);expect(repeated.draftHash).toBe(drafted.draftHash);
      vi.setSystemTime(base+30000);const final={...draft,verification:{confirmed:true,model:draft.model,evidenceHash:job.evidenceHash,draftHash:drafted.draftHash}};await s.ok('complete',final);
      vi.setSystemTime(base+35000);await s.ok('complete',final);
      const phases=s.sqlite.prepare('SELECT phase,occurred_at FROM review_timing_boundaries WHERE job_id=?').all(job.id);expect(Object.fromEntries(phases.map((row:any)=>[row.phase,row.occurred_at]))).toEqual({material_ready:new Date(base).toISOString(),draft_received:new Date(base+12000).toISOString(),verification_ready:new Date(base+20000).toISOString(),completed:new Date(base+30000).toISOString()});
      const timing=s.sqlite.prepare("SELECT event_id,origin,phase,started_at,duration_ms FROM review_timing_events WHERE job_id=? AND event_id LIKE 'device-wall:%' ORDER BY phase").all(job.id);expect(timing).toEqual([{event_id:'device-wall:initial',origin:'server',phase:'initial',started_at:new Date(base).toISOString(),duration_ms:12000},{event_id:'device-wall:verification',origin:'server',phase:'verification',started_at:new Date(base+20000).toISOString(),duration_ms:10000}]);
      const report=await s.ok('report',{id:job.id});expect(report.model).toBe(draft.model);expect(report.evidence_hash).toBe(job.evidenceHash);expect(report.result).toEqual(draft.report);
    }finally{vi.useRealTimers();}
  });
  it('locks declared effort atomically with draft, validates the declaration and keeps telemetry failure separate',async()=>{
    const s=await setup(),job=await s.ready(),draft={...s.draftBody(job),modelConfiguration:{effort:'high'}};
    for(const modelConfiguration of [null,{},[],{effort:''},{effort:'中文'},{effort:'a'.repeat(31)},{effort:'high',key:'private'},{strength:'high'}])expect((await s.call('draft',{...draft,modelConfiguration})).status).toBe(400);
    const prepare=s.DB.prepare;s.DB.prepare=(sql:string)=>{if(sql.startsWith('UPDATE review_execution_timing SET model_name'))throw new Error('fixture telemetry offline');return prepare(sql);};
    const drafted=await s.ok('draft',draft);s.DB.prepare=prepare;
    expect(s.sqlite.prepare('SELECT local_model_configuration FROM review_jobs WHERE id=?').get(job.id)).toMatchObject({local_model_configuration:'{"effort":"high"}'});
    expect((await s.call('draft',{...draft,modelConfiguration:{effort:'low'}})).status).toBe(409);expect((await s.call('draft',{...draft,modelConfiguration:undefined})).status).toBe(409);
    await s.ok('draft',draft);const config=s.sqlite.prepare('SELECT model_name,effort,config_hash,config_origin FROM review_execution_timing WHERE job_id=?').get(job.id);
    expect(config).toEqual({model_name:draft.model,effort:'high',config_hash:await hashReviewConfiguration({model:draft.model,effort:'high',rulesId:null}),config_origin:'member-device'});
    expect((await s.ok('material',{...job,materialProtocol:'manifest-v1'})).modelConfiguration).toEqual({effort:'high'});
    const final={...draft,verification:{confirmed:true,model:draft.model,evidenceHash:job.evidenceHash,draftHash:drafted.draftHash}};
    expect((await s.call('complete',{...final,modelConfiguration:{effort:'low'}})).status).toBe(409);expect((await s.call('complete',{...final,modelConfiguration:undefined})).status).toBe(409);
    await s.ok('complete',final);await s.ok('complete',final);expect(s.sqlite.prepare('SELECT effort,config_origin FROM review_execution_timing WHERE job_id=?').get(job.id)).toMatchObject({effort:'high',config_origin:'member-device'});
    const saved=await s.ok('report',{id:job.id});expect(saved.model).toBe(draft.model);expect(saved.evidence_hash).toBe(job.evidenceHash);expect(s.modelGet).not.toHaveBeenCalled();
  });
  it('old undeclared drafts stay unknown and cannot gain an effort declaration after locking',async()=>{
    const s=await setup(),job=await s.ready(),final=await s.verified(job);
    expect((await s.call('draft',{...s.draftBody(job),modelConfiguration:{effort:'high'}})).status).toBe(409);
    expect((await s.call('complete',{...final,modelConfiguration:{effort:'high'}})).status).toBe(409);
    await s.ok('complete',final);expect(s.sqlite.prepare('SELECT effort,config_hash FROM review_execution_timing WHERE job_id=?').get(job.id)).toEqual({effort:null,config_hash:null});
  });
  it('member timing needs its lease, rejects server origin and preserves idempotent IDs',async()=>{
    const s=await setup(),job=await s.ready(),event={eventId:crypto.randomUUID(),phase:'material',startedAt:new Date().toISOString(),durationMs:123,status:'ok'};
    const start=s.sqlite.prepare('SELECT started_at FROM review_execution_timing WHERE job_id=?').get(job.id)?.started_at;
    await s.ok('heartbeat',{job,timing:[event]});await s.ok('heartbeat',{job,timing:[event]});
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_timing_events WHERE job_id=?').get(job.id)).toMatchObject({n:1});
    expect(s.sqlite.prepare('SELECT origin FROM review_timing_events WHERE job_id=?').get(job.id)).toMatchObject({origin:'member-device'});
    expect((await s.call('heartbeat',{job,timing:[{...event,origin:'server'}]})).status).toBe(400);
    expect((await s.call('heartbeat',{job:{...job,lease:crypto.randomUUID()},timing:[event]})).status).toBe(409);
    expect((await s.call('heartbeat',{job,timing:[event]},'b')).status).toBe(409);
    await s.claim(job.id);expect(s.sqlite.prepare('SELECT started_at FROM review_execution_timing WHERE job_id=?').get(job.id)?.started_at).toBe(start);
    await s.ok('complete',await s.verified(job));expect(s.sqlite.prepare('SELECT outcome FROM review_execution_timing WHERE job_id=?').get(job.id)).toMatchObject({outcome:'done'});
  });

  it('规则发布不改变在途任务；v2未知评分、零分、原证据和同模型复核持久化',async()=>{
    const s=await setup(),legacy=await s.submit();
    const publish=async(marker:string,previous:string|null)=>{
      const candidate=await reviewRulesAdmin(new Request('https://fixture.test/api/admin/review-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'import',snapshot:{sourceUrl:'https://creator-hub-7mi.pages.dev/#/',capturedAt:new Date().toISOString(),rawDirection:marker,rawScoring:'美学、易玩性、可玩性各 0–3 分，总分 7 分参考通过。',calibrationCases:[]}})}),s.DB);
      return (await reviewRulesAdmin(new Request('https://fixture.test/api/admin/review-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'publish',id:candidate.candidate!.id,expectedActiveId:previous})}),s.DB)).active!;
    };
    const rules=await publish('FIRST_RULE',null),submitted=await s.submit();
    await publish('LATER_RULE',rules.id);
    const old=await s.claim(legacy.id);await s.ok('evidence',s.evidence(old));
    expect((await s.ok('material',old)).schema).toEqual(REVIEW_SCHEMA);
    await s.ok('fail',{...old,message:'old fixture cleanup'});
    const job=await s.claim(submitted.id),accepted=await s.ok('evidence',s.evidence(job));job.evidenceHash=accepted.evidenceHash;
    const material=await s.ok('material',job);
    expect(material.system).toContain('FIRST_RULE');expect(material.system).not.toContain('LATER_RULE');
    expect(job.rules_snapshot.id).toBe(rules.id);
    const v2={...report(),schema_version:2,assessment_status:'needs_review',aes:0,ease:2,play:null,verdict:'待复核：核心循环未确认',optional_suggestions:[]};
    expect((await s.call('draft',{...s.draftBody(job),report:report()})).status).toBe(400);
    const body={...s.draftBody(job),modelConfiguration:{effort:'high'},report:v2},draft=await s.ok('draft',body);
    expect(s.sqlite.prepare('SELECT config_hash FROM review_execution_timing WHERE job_id=?').get(job.id)).toMatchObject({config_hash:await hashReviewConfiguration({model:body.model,effort:'high',rulesId:rules.id})});
    const verification={confirmed:true,model:body.model,evidenceHash:job.evidenceHash,draftHash:draft.draftHash};
    expect((await s.call('complete',{...body,verification:{...verification,model:'different'}})).status).toBe(409);
    const verify=await s.ok('material',job);expect(verify.system).toContain('FIRST_RULE');expect(verify.user.slice(0,material.user.length)).toEqual(material.user);
    await s.ok('complete',{...body,verification});
    const saved=await s.ok('report',job);expect(saved.score).toBe(null);expect(saved.result).toEqual(v2);expect(saved.rules_snapshot.id).toBe(rules.id);
    expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled();
  });
  it('增强取证由新规则显式启用，拒绝超限、错图和锁定后替换，断线保留原租约',async()=>{
    const s=await setup(),payload={request_id:crypto.randomUUID(),html:'<html>fixture</html>',review_mode:'enhanced'};
    expect((await s.call('submit',payload)).status).toBe(400);
    const rule={sourceUrl:'https://creator-hub-7mi.pages.dev/#/',capturedAt:new Date().toISOString(),rawDirection:'fixture direction',rawScoring:'fixture 0–3',scoreMin:0,scoreMax:3,passScore:7,notes:'',calibrationCases:[]};
    s.sqlite.prepare('INSERT INTO review_rule_versions VALUES(?,?,?,?,?)').run('rule-fixture',await digest(canonicalJson(rule)),canonicalJson(rule),'2026-11-02T00:00:00Z','2026-11-02T00:00:00Z');
    s.sqlite.exec("UPDATE review_rule_head SET version_id='rule-fixture' WHERE id=1");
    const submitted=await s.ok('submit',payload),job=await s.claim(submitted.id),evidence=s.evidence(job) as any;
    evidence.probe={captureMethod:'browser-viewport-v2',adaptive:{firstLook:{imageSha256:await digest('a'),observations:'仅画面观察，未披露源码',uncertainties:[],sourceBlind:true,recordedAt:new Date().toISOString()},rounds:0,actionCount:0,playMs:0,modelWaitMs:0,actions:[]}};
    evidence.shots=evidence.shots.map((shot:any,i:number)=>({...shot,id:`baseline-${i+1}`,capturedAt:new Date().toISOString(),source:'isolated-chromium',actionRefs:[]}));
    evidence.shots.push({id:'supplemental-1',capturedAt:new Date().toISOString(),source:'member-device',actionRefs:[],label:'supplemental-1',data:'data:image/jpeg;base64,YQ=='});
    expect((await s.call('material',job)).status).toBe(409);
    for(const patch of [{rounds:7},{actionCount:25},{playMs:180001}])expect((await s.call('evidence',{...evidence,probe:{...evidence.probe,adaptive:{...evidence.probe.adaptive,...patch}}})).status).toBe(400);
    expect((await s.call('evidence',{...evidence,shots:[...evidence.shots,...Array(12).fill(evidence.shots[4])]})).status).toBe(400);
    const accepted=await s.ok('evidence',evidence);expect(accepted.evidenceHash).toBeTruthy();
    const restored=await s.claim(submitted.id);expect(restored.lease).toBe(job.lease);expect(restored.review_mode).toBe('enhanced');
    expect((await s.call('evidence',{...evidence,probe:{...evidence.probe,changed:true}})).status).toBe(409);
    expect((await s.ok('material',job)).user.filter((p:any)=>p.type==='image')).toHaveLength(5);
    expect((await s.call('material',job,'b')).status).toBe(409);
    expect(s.modelGet).not.toHaveBeenCalled();
  });
  it('读取新鲜任务不写库或全站清理，成员轮询不清理其他成员的过期任务',async()=>{
    const s=await setup(),a=await s.ready(),b=await s.submit('b'),old=new Date(Date.now()-25*3600000).toISOString();
    s.sqlite.prepare('UPDATE review_jobs SET updated_at=? WHERE id=?').run(old,b.id);
    const prepare=vi.spyOn(s.DB,'prepare');
    await getReviewJob(s.env,a.id,'a');
    expect(prepare.mock.calls.every(([query])=>/^SELECT /i.test(query as string))).toBe(true);
    prepare.mockClear();
    await listReviewJobs(s.env,'a');
    expect(s.sqlite.prepare('SELECT status FROM review_jobs WHERE id=?').get(b.id)).toMatchObject({status:'queued'});
    expect(Number(s.sqlite.prepare('SELECT COUNT(*) n FROM review_inputs WHERE job_id=?').get(b.id)?.n)).toBeGreaterThan(0);
    await recoverDeviceReviews(s.DB);
    expect(s.sqlite.prepare('SELECT status FROM review_jobs WHERE id=?').get(b.id)).toMatchObject({status:'error'});
  });
  it('过期清理与心跳竞争时保留已恢复任务、原租约及材料',async()=>{
    const s=await setup(),job=await s.ready(),old=new Date(Date.now()-25*3600000).toISOString();
    s.sqlite.prepare('UPDATE review_jobs SET updated_at=? WHERE id=?').run(old,job.id);
    await s.ok('heartbeat',{job});
    await failDeviceReview(s.DB,job.id,'expired snapshot',old);
    expect(await getReviewJob(s.env,job.id,'a')).toMatchObject({status:'running'});
    expect(Number(s.sqlite.prepare('SELECT COUNT(*) n FROM review_evidence WHERE job_id=?').get(job.id)?.n)).toBeGreaterThan(0);
  });
  it('真人回填允许未领取任务的本人设备，上传内容按原 HTML 字节验证，领取后绑定原设备和租约',async()=>{
    const s=await setup(),queued=await s.submit(),hash=s.sqlite.prepare('SELECT input_hash FROM review_jobs WHERE id=?').get(queued.id)?.input_hash;
    expect(hash).toBe(await digest('<html><title>ORIGINAL_GAME</title><canvas></canvas></html>'));
    const first=human(queued,{uploadedContentHash:hash});
    expect((await s.call('human-review',{...first,uploadedContentHash:'0'.repeat(64)})).status).toBe(409);
    const saved=await s.ok('human-review',first,'a2');
    expect(saved.human_review).toMatchObject({score:0,workId:'external-work',phase:'final'});
    expect((await s.ok('jobs')).find((j:any)=>j.id===queued.id)).toMatchObject({human_status:'reviewed',human_score:0,human_review:saved.human_review});
    const job=await s.claim(queued.id),newer=human(job,{updatedAt:'2026-10-27T11:00:00.000Z',score:8.5});
    expect((await s.call('human-review',newer,'a2')).status).toBe(409);
    expect((await s.call('human-review',{...newer,lease:undefined})).status).toBe(409);
    expect((await s.ok('human-review',newer)).human_review.score).toBe(8.5);
    expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled();
  });
  it('真人审核回填与任务、账号和设备权限隔离，网页Cookie或注入归属字段不能扩大权限',async()=>{
    const s=await setup(),job=await s.ready(),body=human(job);
    expect((await s.call('human-review',body,'b')).status).toBe(404);
    expect((await s.call('human-review',body,'a2')).status).toBe(409);
    expect((await s.call('human-review',{...body,owner_id:'b'})).status).toBe(400);
    s.sqlite.prepare('UPDATE review_devices SET revoked=1 WHERE id=?').run(s.devices.a);
    expect((await s.call('human-review',body)).status).toBe(401);
    s.sqlite.prepare('UPDATE review_devices SET revoked=0 WHERE id=?').run(s.devices.a);
    s.sqlite.exec("UPDATE members SET can_review=0 WHERE id='a'");expect((await s.call('human-review',body)).status).toBe(401);
    s.sqlite.exec("UPDATE members SET can_review=1 WHERE id='a'");
    await s.ok('fail',{...job,message:'fixture failed'});expect((await s.call('human-review',body)).status).toBe(409);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_human_reviews').get()).toMatchObject({n:0});
  });
  it('真人记录严格校验外部ID、来源、阶段、时间、空分与状态组合，不依作品同名自动匹配',async()=>{
    const s=await setup(),job=await s.submit(),base=human(job);
    for(const change of [{workId:1},{workId:'../other'},{versionId:null},{source:'https://elsewhere.test'},{score:-1},{score:10},{score:'8'},{updatedAt:'2026-02-30T10:00:00.000Z'},{updatedAt:'2026-10-27'},{status:'approved'},{phase:'other'},{matchedBy:'title'},{feedback:'x'.repeat(20001)},{score:null,feedback:'  '},{status:'pending',phase:'final'},{status:'pending',phase:null,score:null,workId:null,versionId:null},{status:'unavailable',phase:null,score:2},{uploadedContentHash:'INVALID'},{lease:{}}]){
      const response=await s.call('human-review',{...base,...change});expect(response.status,JSON.stringify(change).slice(0,200)).toBe(400);
    }
    const unlinked=human(job,{workId:null,versionId:null,score:null,feedback:'用户尚未确认作品版本',status:'unlinked',phase:null,matchedBy:null});
    expect((await s.ok('human-review',unlinked)).human_review).toMatchObject({status:'unlinked',workId:null,versionId:null,score:null});
    const pending=human(job,{status:'pending',phase:null,score:null,feedback:null,updatedAt:'2026-10-27T11:00:00.000Z'});
    expect((await s.ok('human-review',pending)).human_review.status).toBe('pending');
    const rejected=human(job,{score:null,feedback:'直接驳回，无评分',updatedAt:'2026-10-27T12:00:00.000Z'});
    expect((await s.ok('human-review',rejected)).human_review).toMatchObject({score:null,feedback:'直接驳回，无评分',phase:'final'});
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM topics').get()).toMatchObject({n:0});
  });
  it('真人回填并发和响应丢失重传幂等，同请求变更内容或同任务换作品版本被拒绝',async()=>{
    const s=await setup(),job=await s.ready(),body=human(job),repeated=await Promise.all(Array.from({length:5},()=>s.ok('human-review',body)));
    expect(new Set(repeated.map(v=>v.human_review.id)).size).toBe(1);
    expect(await s.ok('human-review',Object.fromEntries(Object.entries(body).reverse()))).toEqual(repeated[0]);
    for(const change of [{score:1},{feedback:'替换意见'},{phase:'preliminary'},{workId:'other-work'},{versionId:'other-version'}])expect((await s.call('human-review',{...body,...change})).status).toBe(409);
    expect((await s.call('human-review',human(job,{workId:'other-work'}))).status).toBe(409);
    expect((await s.call('human-review',human(job,{versionId:'other-version'}))).status).toBe(409);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_human_reviews').get()).toMatchObject({n:1});
    const second=await s.submit(),a=human(second),b=human(second,{workId:'different-confirmed-work'}),race=await Promise.all([s.call('human-review',a),s.call('human-review',b)]);
    expect(race.map(r=>r.status).sort()).toEqual([200,409]);
    const requestRace=await s.submit(),same=human(requestRace),different={...same,feedback:'other valid callback'},results=await Promise.all([s.call('human-review',same),s.call('human-review',different)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  });
  it('迟到回填、预审和查询失败保留历史且不覆盖已有终审，同版本较新终审可更新展示',async()=>{
    const s=await setup(),job=await s.submit(),final=await s.ok('human-review',human(job,{score:7}));
    for(const change of [{updatedAt:'2026-10-27T09:00:00.000Z',score:9},{updatedAt:'2026-10-27T11:00:00.000Z',phase:'preliminary',score:8},{updatedAt:'2026-10-27T12:00:00.000Z',status:'unavailable',phase:null,score:null,feedback:'无法查询'},{updatedAt:'2026-10-27T13:00:00.000Z',workId:null,versionId:null,matchedBy:null,status:'unlinked',phase:null,score:null}]){
      await s.ok('human-review',human(job,change));expect((await s.ok('job',{id:job.id})).human_review).toEqual(final.human_review);
    }
    const fresh=await s.ok('human-review',human(job,{score:8.5,updatedAt:'2026-10-27T14:00:00.000Z'}));
    expect((await s.ok('job',{id:job.id})).human_review).toEqual(fresh.human_review);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_human_reviews').get()).toMatchObject({n:6});
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_human_reviews WHERE is_current=1').get()).toMatchObject({n:1});
  });
  it('已完成任务回填不改变AI报告，成员报告、管理员报告、工作台和活动都读取独立真人关联',async()=>{
    const s=await setup(),job=await s.ready();await s.ok('complete',await s.verified(job));
    const before=s.sqlite.prepare('SELECT * FROM reviews WHERE job_id=?').get(job.id) as any,hash=s.sqlite.prepare('SELECT input_hash FROM review_jobs WHERE id=?').get(job.id)?.input_hash;
    const saved=await s.ok('human-review',human(job,{uploadedContentHash:hash}));
    expect(s.sqlite.prepare('SELECT * FROM reviews WHERE job_id=?').get(job.id)).toEqual(before);
    expect((await s.ok('report',{id:job.id})).human_review).toEqual(saved.human_review);
    const request=new Request('https://fixture.test/api/forge/reviews');
    for(const owner of ['a','admin']){
      const list=await dispatch('GET',['reviews'],request,s.env,owner),detail=await dispatch('GET',['reviews',String(before.id)],request,s.env,owner);
      expect(list.find((r:any)=>r.id===before.id)).toMatchObject({score:7,human_score:0,human_review:saved.human_review});expect(detail.human_review).toEqual(saved.human_review);
    }
    expect(await dispatch('GET',['reviews'],request,s.env,'b')).toEqual([]);
    await expect(dispatch('GET',['reviews',String(before.id)],request,s.env,'b')).rejects.toMatchObject({status:404});
    expect((await reviewActivity(s.DB,new URLSearchParams({date:reviewDay()}))).records.find((r:any)=>r.id===job.id)).toMatchObject({score:7,human_score:0,human_review:saved.human_review});
    const cookie=`pgc_admin=${await login(s.env.ADMIN_PASSWORD,s.env)}`,response=await adminWorkspaceApi(new Request('https://fixture.test/api/admin/workspace',{headers:{Cookie:cookie}}),s.env),workspace=await response!.json() as any;
    expect(response!.status).toBe(200);expect(workspace.reviews.find((r:any)=>r.id===before.id).human_review).toEqual(saved.human_review);expect(workspace.reviewJobs.find((r:any)=>r.id===job.id).human_review).toEqual(saved.human_review);
    expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();
  });
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
    let reportUnavailable=false;
    const server=createServer(async(req,res)=>{
      try{
        const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
        if(reportUnavailable&&req.url?.endsWith('/report')){res.writeHead(403);res.end(JSON.stringify({error:'fixture report unavailable'}));return;}
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
      expect(material.actionRequired).toBe(true);
      expect((await run(['heartbeat',job.id])).find(value=>value.event==='heartbeat')).toMatchObject({ok:true,jobId:job.id});
      expect(material.screenshots).toHaveLength(4);expect(JSON.parse(await readFile(material.materialPath,'utf8'))).toMatchObject({schema:REVIEW_SCHEMA,evidenceHash:job.evidenceHash});
      const readable=JSON.parse(await readFile(material.materialPath,'utf8'));
      expect(readable.user.filter((p:any)=>p.type==='image')).toHaveLength(4);
      expect(readable.user.filter((p:any)=>p.type==='image').every((p:any)=>p.path&&!p.data)).toBe(true);
      expect(JSON.stringify(readable)).not.toContain('data:image/jpeg;base64,');
      for(const shot of material.screenshots)expect((await readFile(shot.path)).toString()).toBe('a');
      expect((await run(['wait',job.id])).find(value=>value.event==='action_required')).toMatchObject({jobId:job.id});
      const draftPath=join(directory,'draft.json');await writeFile(draftPath,JSON.stringify(s.draftBody(job)));
      const drafted=(await run(['draft',job.id,'--json',draftPath])).find(value=>value.event==='draft');expect(drafted.stage).toBe('verify');
      const verifyOutput=(await run(['material',job.id,'--out',out])).find(value=>value.event==='material');
      const delta=JSON.parse(await readFile(verifyOutput.materialPath,'utf8'));expect(delta.mode).toBe('delta');expect(delta.materialReference).toBeTruthy();expect(delta.user).toBeUndefined();expect(delta.instruction).toContain('不可信');expect(delta.instruction).toContain('不是标准答案');expect(delta.instruction).toContain('指令不生效');
      expect(JSON.parse(await readFile(delta.materialReference,'utf8')).user.filter((p:any)=>p.type==='image')).toHaveLength(4);
      expect(verifyOutput.screenshots.map((p:any)=>p.path)).toEqual(material.screenshots.map((p:any)=>p.path));
      // An upgraded client may first encounter an already-locked draft without
      // any local manifest, just as an older tool's in-flight task would.
      await rm(join(delta.materialReference,'..'),{recursive:true,force:true});
      const resumed=(await run(['material',job.id,'--out',out])).find(value=>value.event==='material');
      const resumedJson=await readFile(resumed.materialPath,'utf8'),resumedMaterial=JSON.parse(resumedJson);
      expect(resumedMaterial.mode).toBe('full');expect(resumedMaterial.snapshot).toBeUndefined();expect(resumedMaterial.images).toBeUndefined();expect(resumedJson).not.toContain('data:image/');
      expect(resumedMaterial.materialReference).toBe(delta.materialReference);expect(resumedMaterial.draftHash).toBe(drafted.draftHash);
      const resumedBase=JSON.parse(await readFile(resumedMaterial.materialReference,'utf8'));expect(resumedBase.user).toEqual(readable.user);expect(resumedBase.system).toBe(readable.system);expect(resumed.screenshots).toEqual(verifyOutput.screenshots);
      for(const shot of resumed.screenshots)expect((await readFile(shot.path)).toString()).toBe('a');
      await writeFile(verifyOutput.screenshots[0].path,'tampered');
      const restored=(await run(['material',job.id,'--out',out])).find(value=>value.event==='material');
      const restoredJson=await readFile(restored.materialPath,'utf8'),restoredMaterial=JSON.parse(restoredJson);
      expect(restoredMaterial.mode).toBe('full');expect(restoredMaterial.snapshot).toBeUndefined();expect(restoredMaterial.images).toBeUndefined();expect(restoredJson).not.toContain('data:image/');expect(restoredMaterial.materialReference).toBe(delta.materialReference);expect(restored.screenshots).toEqual(verifyOutput.screenshots);
      expect(JSON.parse(await readFile(restoredMaterial.materialReference,'utf8')).user).toEqual(readable.user);
      expect((await readFile(restored.screenshots[0].path)).toString()).toBe('a');
      const verified={...s.draftBody(job),verification:{confirmed:true,model:'member-owned-model',evidenceHash:job.evidenceHash,draftHash:drafted.draftHash}},finalPath=join(directory,'final.json');
      await writeFile(finalPath,JSON.stringify(verified));
      reportUnavailable=true;await expect(run(['complete',job.id,'--json',finalPath])).rejects.toThrow();
      const privateManifest=join(delta.materialReference,'..','manifest.json');expect(JSON.parse(await readFile(privateManifest,'utf8')).materialHash).toBe(delta.materialHash);
      reportUnavailable=false;const blockedOutput=join(directory,'blocked-output');await writeFile(blockedOutput,'keep explicit file');
      await expect(run(['report',job.id,'--out',blockedOutput])).rejects.toThrow();expect(await readFile(privateManifest,'utf8')).toBeTruthy();
      const complete=await run(['complete',job.id,'--json',finalPath]);
      await expect(readFile(privateManifest,'utf8')).rejects.toMatchObject({code:'ENOENT'});
      expect(await readFile(game,'utf8')).toBe('<html>fixture</html>');expect(await readFile(material.materialPath,'utf8')).toBeTruthy();expect(await readFile(blockedOutput,'utf8')).toBe('keep explicit file');
      expect(complete.find(value=>value.event==='report').report).toMatchObject({model_executor:'agent',model:'member-owned-model',result:report()});
      expect((await run(['complete',job.id,'--json',finalPath])).find(value=>value.event==='complete').status).toBe('done');
      const repeated=await run(['review',game,'--request-id',job.id,'--out',out]);
      expect(repeated.find(value=>value.event==='report').report).toMatchObject({id:complete.find(value=>value.event==='report').report.id,result:report()});
      expect(JSON.parse(await readFile(join(out,`${job.id}.json`),'utf8')).result).toEqual(report());
      expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_jobs').get()).toMatchObject({n:1});expect(s.sqlite.prepare('SELECT COUNT(*) n FROM reviews').get()).toMatchObject({n:1});
      const nextGame=join(directory,'second.html');await writeFile(nextGame,'<html>second fixture</html>');
      const batch=await run(['review',game,nextGame,'--out',out]);
      const remaining=batch.find(value=>value.event==='remaining');expect(remaining.remaining).toHaveLength(1);expect(remaining.continueCommands).toEqual([['continue',remaining.remaining[0]]]);
      expect(await getReviewJob(s.env,remaining.remaining[0],'a')).toMatchObject({status:'queued',stage:'capture'});
      const failed=await s.ready();
      const failedMaterial=(await run(['material',failed.id])).find(value=>value.event==='material');const failedCacheDirectory=join(failedMaterial.screenshots[0].path,'..');
      expect((await run(['fail',failed.id,'--reason','合成模型不可用'])).find(value=>value.event==='fail')).toMatchObject({ok:true,jobId:failed.id});
      expect(await getReviewJob(s.env,failed.id,'a')).toMatchObject({status:'error',error:'合成模型不可用'});
      await expect(readFile(join(failedCacheDirectory,'manifest.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
      expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();
    }finally{
      await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
      const target=resolve(directory),parent=resolve(tmpdir());
      if(!target.startsWith(parent+sep)||!target.split(sep).at(-1)?.startsWith('pgc-local-review-'))throw new Error('Unexpected temporary test path');
      await rm(target,{recursive:true,force:true});
    }
  },30000);
});
