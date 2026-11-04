import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {cloudReviewAlarm,advanceCloudReview} from '../server/cloud-review-runner';
import {enqueueReview} from '../server/review-jobs';
import {complete} from '../server/forge-llm';
vi.mock('../server/forge-llm',async original=>({...await original<typeof import('../server/forge-llm')>(),complete:vi.fn()}));
const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.resetAllMocks();});
function setup(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const DB:any={prepare(sql:string){let p:any[]=[];const s:any={bind(...v:any[]){p=v;return s;},first:async()=>sqlite.prepare(sql).get(...p)||null,all:async()=>({results:sqlite.prepare(sql).all(...p)}),run:async()=>{const r=sqlite.prepare(sql).run(...p);return{meta:{changes:Number(r.changes)}};},execute:()=>sqlite.prepare(sql).run(...p)};return s;},batch:vi.fn(async(stmts:any[])=>{sqlite.exec('BEGIN');try{const r=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}})};
  const values=new Map<string,any>();const writes:{key:string;bytes:number}[]=[];let alarm:number|null=null;
  const storage:any={get:async(k:string)=>structuredClone(values.get(k)),put:async(k:string,v:any)=>{writes.push({key:k,bytes:Buffer.byteLength(typeof v==='string'?v:JSON.stringify(v))});values.set(k,structuredClone(v));},delete:async(k:string)=>values.delete(k),setAlarm:async(v:number)=>{alarm=v;},getAlarm:async()=>alarm,deleteAlarm:async()=>{alarm=null;},deleteAll:async()=>values.clear(),transaction:async(fn:any)=>{const before=structuredClone(values),oldAlarm=alarm;try{return await fn(storage);}catch(e){values.clear();for(const[k,v]of before)values.set(k,v);alarm=oldAlarm;throw e;}}};
  const model={model:'deepseek-flash',baseUrl:'https://fixture.invalid',protocol:'openai',encryptedKey:'TEST_ENCRYPTED_KEY',enabled:true,updatedAt:''};
  const evidence={probe:{captureMethod:'browser-viewport-v1',note:'SYNTHETIC'},shots:Array.from({length:4},(_,i)=>({label:`synthetic-${i}`,data:'data:image/jpeg;base64,'+'a'.repeat(40000)}))};
  const env={DB,SETTINGS_KEY:'fixture',modelExecutor:'platform' as const,modelStore:{get:vi.fn(async()=>model)},captureReview:vi.fn(async()=>evidence),REVIEW_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:vi.fn(async()=>Response.json({ok:true}))})}};
  const input={request_id:crypto.randomUUID(),title:'CHECKPOINT_SYNTHETIC',html:'<!doctype html><title>SYNTHETIC</title><canvas></canvas>'};
  const draft={aes:2,ease:2,play:2,verdict:'打回',score_reasons:{aes:'图像证据',ease:'运行记录',play:'源码推断'},uncertainties:['长期节奏'],issues:[],strengths:[],reviewer_comment:'初稿',fix_prompt:'验证后再修改'};
  const final={...draft,play:3,verdict:'通过',reviewer_comment:'复核完成'};
  vi.mocked(complete).mockImplementation(async(_env,_cfg,req)=>{await req.onStart?.();await req.onWait?.('正在思考');return req.purpose==='review'?structuredClone(draft):structuredClone(final);});
  const tick=async()=>{alarm=null;await advanceCloudReview({storage},env,input.request_id);};
  const runAlarm=async()=>{alarm=null;await cloudReviewAlarm({storage},env,input.request_id);};
  const row=()=>sqlite.prepare('SELECT * FROM review_jobs WHERE id=?').get(input.request_id) as any;
  return{sqlite,DB,env,storage,values,writes,input,tick,runAlarm,row,draft,final,evidence};
}
describe('云端审核阶段检查点',()=>{
  it('正常任务在单次alarm连续完成，阶段间不用再排队；故障仍能从检查点恢复',async()=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');await s.runAlarm();
    expect(s.row()).toMatchObject({status:'done',stage:'done'});expect(complete).toHaveBeenCalledTimes(2);expect(s.env.captureReview).toHaveBeenCalledTimes(1);expect(s.values.size).toBe(0);
  });
  it('四图采集、初评、复核与保存独立恢复；两轮保持同模型、同材料、24k预算',async()=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');
    await s.tick();expect(await s.storage.get('cloudPhase')).toBe('prepared');expect(complete).not.toHaveBeenCalled();
    for(const [key,value]of s.values)if(key.startsWith('cloud:'))expect(Buffer.byteLength(value)).toBeLessThan(128*1024);
    await s.tick();expect(await s.storage.get('cloudPhase')).toBe('draft-ready');expect(s.row().result_id).toBeNull();expect(complete).toHaveBeenCalledTimes(1);
    s.env.modelStore.get.mockResolvedValue({...await s.env.modelStore.get(),model:'different-model'});
    await s.tick();expect(await s.storage.get('cloudPhase')).toBe('final-ready');expect(s.row().result_id).toBeNull();
    await s.tick();expect(s.row()).toMatchObject({status:'done',stage:'done'});
    const saved=s.sqlite.prepare('SELECT * FROM reviews WHERE job_id=?').get(s.input.request_id) as any;
    expect(JSON.parse(saved.result)).toMatchObject({play:3,reviewer_comment:'复核完成'});expect(JSON.parse(saved.shots)).toHaveLength(4);
    const calls=vi.mocked(complete).mock.calls;expect(calls.map(c=>c[2].maxTokens)).toEqual([24000,24000]);
    expect(calls[0][2].system).toBe(calls[1][2].system);
    expect((calls[1][2].user as any[]).slice(0,-1)).toEqual(calls[0][2].user);
    expect(await calls[1][0].modelStore.get()).toMatchObject({model:'deepseek-flash'});
    expect(calls[1][2].deadline).toBe(calls[0][2].deadline);expect(calls[1][2].idempotencyKey).toBe(`pgc-review-${s.input.request_id}-verify`);
    expect(s.sqlite.prepare('SELECT count(*) n FROM review_inputs').get()).toMatchObject({n:0});expect(s.values.size).toBe(0);
    await s.tick();expect(complete).toHaveBeenCalledTimes(2);expect(s.env.captureReview).toHaveBeenCalledTimes(1);
  });
  it('终稿已完成后数据库临时故障只重试保存，绝不重新调用模型',async()=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');for(let i=0;i<3;i++)await s.tick();
    s.DB.batch.mockRejectedValueOnce(new Error('D1 temporary failure'));
    await s.runAlarm();expect(await s.storage.get('cloudPhase')).toBe('final-ready');expect(await s.storage.getAlarm()).toBeGreaterThan(Date.now());
    await s.tick();expect(s.row().status).toBe('done');expect(complete).toHaveBeenCalledTimes(2);
  });
  it('初评或复核状态未知时明确失败，不重放请求、不发布未复核报告',async()=>{
    for(const phase of ['review-started','verify-started']){
      const s=setup();await enqueueReview(s.env,s.input,'admin');await s.tick();
      await s.storage.put('cloudPhase',phase);await s.tick();
      expect(s.row()).toMatchObject({status:'error',result_id:null});expect(s.row().error).toContain('状态未知');
      expect(s.sqlite.prepare('SELECT count(*) n FROM reviews').get()).toMatchObject({n:0});expect(s.values.size).toBe(0);
    }
    expect(complete).not.toHaveBeenCalled();
  });
  it('复核失败不发布初评，成员Agent任务完全排除',async()=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');await s.tick();await s.tick();
    vi.mocked(complete).mockRejectedValueOnce(new Error('synthetic verify failure'));await s.tick();
    expect(s.row()).toMatchObject({status:'error',result_id:null});
    const a=setup();await enqueueReview({...a.env,modelExecutor:'agent'},a.input,'admin');await a.tick();
    expect(a.row()).toMatchObject({status:'queued',model_executor:'agent',quota_charged:0});expect(a.env.captureReview).not.toHaveBeenCalled();
  });
  it('旧Queue请求已经启动但没有检查点时不会再次调用；已有报告只修复终态',async()=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');
    s.sqlite.prepare("UPDATE review_jobs SET status='running',stage='verify',model_started_at=? WHERE id=?").run(new Date().toISOString(),s.input.request_id);
    await s.tick();expect(s.row()).toMatchObject({status:'error',result_id:null});expect(complete).not.toHaveBeenCalled();expect(s.env.captureReview).not.toHaveBeenCalled();
    const p=setup();await enqueueReview(p.env,p.input,'admin');
    p.sqlite.prepare("UPDATE review_jobs SET status='running',stage='verify',model_started_at=? WHERE id=?").run(new Date().toISOString(),p.input.request_id);
    p.sqlite.prepare("INSERT INTO reviews(owner_id,title,result,probe,created_at,job_id) VALUES('admin','synthetic',?,'{}',?,?)").run(JSON.stringify(p.final),new Date().toISOString(),p.input.request_id);
    await p.tick();expect(p.row().status).toBe('done');expect(p.row().result_id).toBeTruthy();expect(p.env.captureReview).not.toHaveBeenCalled();
  });
  it('不可变四图只存一份一次，阶段更新只写小结果；节省可量化的检查点字节',async()=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');await s.tick();
    const ref=JSON.parse([...s.values].filter(([k])=>/^cloudState:\d+$/.test(k)).map(([,v])=>v).join('')).materialRef;
    const materialKeys=[...s.values.keys()].filter(k=>k.startsWith(`cloudImmutable:${ref}:`));
    const immutable=JSON.parse(materialKeys.map(k=>s.values.get(k)).join(''));
    const original={...immutable,request:{...immutable.request,user:immutable.request.user.map((part:any)=>{if(part.type!=='image')return part;const {imageIndex,...metadata}=part;return {...metadata,data:immutable.images[imageIndex].data};})}};
    const writesAtPrepared=s.writes.length;
    await s.tick();await s.tick();
    expect(s.writes.slice(writesAtPrepared).some(w=>w.key.startsWith('cloudImmutable:'))).toBe(false);
    expect(s.writes.slice(writesAtPrepared).filter(w=>/^cloudState:\d+$/.test(w.key)).every(w=>w.bytes<5000)).toBe(true);
    for(const key of materialKeys)expect(Buffer.byteLength(s.values.get(key))).toBeLessThan(128*1024);
    const calls=vi.mocked(complete).mock.calls;
    // The previous implementation rewrote evidence in prepared/draft/final,
    // including the duplicate request.user and images copies each time.
    const legacyBytes=[original,{...original,draft:s.draft},{...original,draft:s.draft,result:s.final}].reduce((n,value)=>n+Buffer.byteLength(JSON.stringify(value)),0);
    const actualBytes=s.writes.filter(w=>/^cloudImmutable:.*:\d+$/.test(w.key)||/^cloudState:\d+$/.test(w.key)).reduce((n,w)=>n+w.bytes,0);
    expect(actualBytes).toBeLessThan(legacyBytes/4);
    expect(calls[0][2].user).toEqual((calls[1][2].user as any[]).slice(0,-1));
  });
  it.each(['prepared','draft-ready','final-ready'])('旧 %s 完整检查点仍恢复同材料，不重采集或重放完成阶段',async phase=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');const completed=phase==='prepared'?1:phase==='draft-ready'?2:3;
    for(let i=0;i<completed;i++)await s.tick();
    const parseParts=(prefix:string)=>JSON.parse(Array.from({length:s.values.get(`${prefix}Parts`)},(_,i)=>s.values.get(`${prefix}:${i}`)).join(''));
    const mutable=parseParts('cloudState'),immutable=parseParts(`cloudImmutable:${mutable.materialRef}`);
    immutable.request.user=immutable.request.user.map((part:any)=>{if(part.type!=='image')return part;const {imageIndex,...metadata}=part;return {...metadata,data:immutable.images[imageIndex].data};});
    const legacy={...immutable,...(mutable.draft?{draft:mutable.draft}:{}),...(mutable.result?{result:mutable.result}:{} )};
    s.values.clear();const json=JSON.stringify(legacy);let parts=0;for(let i=0;i<json.length;i+=30000)s.values.set(`cloud:${parts++}`,json.slice(i,i+30000));s.values.set('cloudParts',parts);s.values.set('cloudPhase',phase);
    await s.runAlarm();expect(s.row().status).toBe('done');expect(complete).toHaveBeenCalledTimes(2);expect(s.env.captureReview).toHaveBeenCalledTimes(1);
    expect(JSON.parse((s.sqlite.prepare('SELECT shots FROM reviews WHERE job_id=?').get(s.input.request_id) as any).shots)).toEqual(s.evidence.shots);
  });
  it('缺失不可变图像分片时不调用模型，损坏证据不能评分',async()=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');await s.tick();const key=[...s.values.keys()].find(k=>/^cloudImmutable:.*:0$/.test(k))!;s.values.delete(key);await s.tick();expect(s.row().status).toBe('error');expect(complete).not.toHaveBeenCalled();
  });

  it('记录服务器开始/结束与采集初评复核落库跨度；遥测失败不改变已完成审核',async()=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');await s.runAlarm();
    const timing=s.sqlite.prepare('SELECT * FROM review_execution_timing WHERE job_id=?').get(s.input.request_id) as any;
    expect(timing).toMatchObject({outcome:'done',model_name:'deepseek-flash',effort:'auto',config_origin:'server'});expect(timing.config_hash).toMatch(/^[a-f0-9]{64}$/);expect(Date.parse(timing.finished_at)).toBeGreaterThanOrEqual(Date.parse(timing.started_at));
    expect((s.sqlite.prepare('SELECT phase,status,origin FROM review_timing_events WHERE job_id=?').all(s.input.request_id) as any[]).sort((a,b)=>a.phase.localeCompare(b.phase))).toEqual(['capture','initial','persist','verification'].map(phase=>({phase,status:'ok',origin:'server'})));
    vi.mocked(complete).mockClear();const broken=setup();await enqueueReview(broken.env,broken.input,'admin');const prepare=broken.DB.prepare;
    broken.DB.prepare=(sql:string)=>{if(/review_execution_timing|review_timing_events/.test(sql))throw new Error('synthetic telemetry failure');return prepare(sql);};
    await broken.runAlarm();expect(broken.row().status).toBe('done');expect(complete).toHaveBeenCalledTimes(2);
  });
  it('延迟到达的初评进度不能覆盖复核阶段，终态也不被进度改写',async()=>{
    const s=setup();await enqueueReview(s.env,s.input,'admin');await s.tick();await s.tick();const initial=vi.mocked(complete).mock.calls[0][2];await s.tick();const before=s.row();expect(before.stage).toBe('verify');await initial.onWait?.('late initial update');expect(s.row().error).toBe(before.error);await s.tick();await initial.onWait?.('late finished update');expect(s.row().status).toBe('done');expect(s.row().error).toBe('');
  });

});
