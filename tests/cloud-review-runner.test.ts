import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {cloudReviewAlarm} from '../server/cloud-review-runner';
import {enqueueReview} from '../server/review-jobs';
import {complete} from '../server/forge-llm';
vi.mock('../server/forge-llm',async original=>({...await original<typeof import('../server/forge-llm')>(),complete:vi.fn()}));
const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.resetAllMocks();});
function setup(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const DB:any={prepare(sql:string){let p:any[]=[];const s:any={bind(...v:any[]){p=v;return s;},first:async()=>sqlite.prepare(sql).get(...p)||null,all:async()=>({results:sqlite.prepare(sql).all(...p)}),run:async()=>{const r=sqlite.prepare(sql).run(...p);return{meta:{changes:Number(r.changes)}};},execute:()=>sqlite.prepare(sql).run(...p)};return s;},batch:vi.fn(async(stmts:any[])=>{sqlite.exec('BEGIN');try{const r=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}})};
  const values=new Map<string,any>();let alarm:number|null=null;
  const storage:any={get:async(k:string)=>structuredClone(values.get(k)),put:async(k:string,v:any)=>{values.set(k,structuredClone(v));},delete:async(k:string)=>values.delete(k),setAlarm:async(v:number)=>{alarm=v;},getAlarm:async()=>alarm,deleteAlarm:async()=>{alarm=null;},deleteAll:async()=>values.clear(),transaction:async(fn:any)=>{const before=structuredClone(values),oldAlarm=alarm;try{return await fn(storage);}catch(e){values.clear();for(const[k,v]of before)values.set(k,v);alarm=oldAlarm;throw e;}}};
  const model={model:'deepseek-flash',baseUrl:'https://fixture.invalid',protocol:'openai',encryptedKey:'TEST_ENCRYPTED_KEY',enabled:true,updatedAt:''};
  const evidence={probe:{captureMethod:'browser-viewport-v1',note:'SYNTHETIC'},shots:Array.from({length:4},(_,i)=>({label:`synthetic-${i}`,data:'data:image/jpeg;base64,'+'a'.repeat(40000)}))};
  const env={DB,SETTINGS_KEY:'fixture',modelExecutor:'platform' as const,modelStore:{get:vi.fn(async()=>model)},captureReview:vi.fn(async()=>evidence),REVIEW_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:vi.fn(async()=>Response.json({ok:true}))})}};
  const input={request_id:crypto.randomUUID(),title:'CHECKPOINT_SYNTHETIC',html:'<!doctype html><title>SYNTHETIC</title><canvas></canvas>'};
  const draft={aes:2,ease:2,play:2,verdict:'打回',score_reasons:{aes:'图像证据',ease:'运行记录',play:'源码推断'},uncertainties:['长期节奏'],issues:[],strengths:[],reviewer_comment:'初稿',fix_prompt:'验证后再修改'};
  const final={...draft,play:3,verdict:'通过',reviewer_comment:'复核完成'};
  vi.mocked(complete).mockImplementation(async(_env,_cfg,req)=>{await req.onStart?.();await req.onWait?.('正在思考');return req.purpose==='review'?structuredClone(draft):structuredClone(final);});
  const tick=async()=>{alarm=null;await cloudReviewAlarm({storage},env,input.request_id);};
  const row=()=>sqlite.prepare('SELECT * FROM review_jobs WHERE id=?').get(input.request_id) as any;
  return{sqlite,DB,env,storage,values,input,tick,row,draft,final,evidence};
}
describe('云端审核阶段检查点',()=>{
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
    await s.tick();expect(await s.storage.get('cloudPhase')).toBe('final-ready');expect(await s.storage.getAlarm()).toBeGreaterThan(Date.now());
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
});
