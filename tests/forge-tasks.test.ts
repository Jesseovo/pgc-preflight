import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {dispatch as dispatchForge} from '../server/forge-api';
import {executeForgeTask,ForgeRunner} from '../server/forge-runner';
import {enqueueForgeTask,failForgeTask,readForgeTask} from '../server/forge-tasks';
import {complete} from '../server/forge-llm';
import {saveConfig} from '../server/settings';
import {tryModelSlot} from '../server/model-capacity';
import type {ModelConfig} from '../server/settings';

const databases:DatabaseSync[]=[];
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();databases.splice(0).forEach(db=>db.close());});
async function setup(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const DB:any={prepare(sql:string){let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>{const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>sqlite.prepare(sql).run(...params)};return s;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const out=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const secrets={ADMIN_PASSWORD:'test-admin',SETTINGS_KEY:'test-secret'};
  let config:ModelConfig|null=null;
  const modelStore={get:async()=>config,set:async(value:ModelConfig)=>{config=value;}};
  await saveConfig({profile:'opus',protocol:'anthropic',baseUrl:'https://fixture.example',model:'claude-opus-5-5',apiKey:'test-only-key'},modelStore,secrets.SETTINGS_KEY);
  await DB.prepare('INSERT INTO settings(id,value,updated_at) VALUES(?,?,?)').bind('model',JSON.stringify(config),new Date().toISOString()).run();
  const at=new Date().toISOString();
  sqlite.prepare("INSERT INTO topics(id,batch,subject,medium,gesture,structure,mood,status,data,created_at,updated_at) VALUES(9,'test','light','pixel','tap','rhythm','calm','liked',?,?,?)").run(JSON.stringify({title:'Test Stars',core_loop:'Catch stars',controls:'Tap',art_direction:'Pixel'}),at,at);
  const dispatch=vi.fn(async()=>Response.json({ok:true}));
  const env:any={...secrets,DB,modelStore,FORGE_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:dispatch})}};
  // Historical platform tasks still exercise the internal runner and transport.
  // Public creation authorization is covered by star-workspaces/forge-agent.
  const request=async(method:string,path:string,data?:unknown)=>{
    try{const result=await dispatchForge(method,path.split('/'),new Request(`https://test.example/api/forge/${path}`,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)}),env,'admin',undefined);return result instanceof Response?result:Response.json(result);}
    catch(error){return Response.json({error:(error as Error).message},{status:(error as any).status||500});}
  };
  const row=()=>sqlite.prepare('SELECT * FROM topics WHERE id=9').get() as any;
  const task=(id:string)=>sqlite.prepare('SELECT * FROM forge_tasks WHERE id=?').get(id) as any;
  return {sqlite,env,request,dispatch,row,task};
}
const response=(text:string,stop_reason='end_turn')=>Response.json({content:[{type:'text',text}],stop_reason});

describe('后台创作的持久任务',()=>{
  it('Key 满载时保持 queued 并通过 alarm 再调度，释放后执行；排队不占十二分钟制作期限',async()=>{
    const s=await setup(),runtime={baseUrl:'https://riffle-api.pages.dev',model:'claude-opus-5-5',protocol:'anthropic' as const,apiKey:'fixture-capacity-key'};
    const configured=await saveConfig({...runtime,profile:'opus'},s.env.modelStore,s.env.SETTINGS_KEY);
    s.sqlite.prepare("UPDATE settings SET value=? WHERE id='model'").run(JSON.stringify(configured));
    const one=await tryModelSlot(s.env.DB,runtime,'other-one',Date.now()+14*60000),two=await tryModelSlot(s.env.DB,runtime,'other-two',Date.now()+14*60000);
    const row=await enqueueForgeTask(s.env,{type:'game',id:9,requestId:'unused'});
    const fetcher=vi.fn(async()=>response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><canvas></canvas><script>let score=0;</script></body></html>'));vi.stubGlobal('fetch',fetcher);
    const storage={get:async()=>row.id,setAlarm:vi.fn(),deleteAlarm:vi.fn(),deleteAll:vi.fn()};
    await new ForgeRunner({storage},s.env).alarm();
    expect(s.task(row.id)).toMatchObject({status:'queued',model_started_at:null,started_at:null});expect(fetcher).not.toHaveBeenCalled();
    expect(storage.deleteAll).not.toHaveBeenCalled();expect(storage.setAlarm.mock.calls.at(-1)![0]-Date.now()).toBeGreaterThan(4000);
    await one!.release();await executeForgeTask(s.env,row.id);expect(s.task(row.id).status).toBe('done');expect(fetcher).toHaveBeenCalledTimes(1);
    expect(s.sqlite.prepare('SELECT count(*) n FROM model_slots').get()).toMatchObject({n:1});await two!.release();
  });
  it('排队超过旧租约、重复点击和恢复调度都沿用一个任务；完成后重复执行不收费',async()=>{
    const s=await setup();
    const first=await (await s.request('POST','topics/9/brief')).json() as any;
    s.sqlite.exec("UPDATE topics SET updated_at='2000-01-01T00:00:00Z'");
    const second=await (await s.request('POST','topics/9/brief')).json() as any;
    expect(first.taskId).toBe(second.taskId);
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toMatchObject({n:1});
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      expect(JSON.parse(String(init?.body)).max_tokens).toBe(64000);
      return response('## F. 游戏设计\n完整设计');
    });vi.stubGlobal('fetch',fetcher);
    await executeForgeTask(s.env,first.taskId);
    await executeForgeTask(s.env,first.taskId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(s.task(first.taskId)).toMatchObject({status:'done'});
    expect(s.row().brief_md).toContain('完整设计');
    expect(s.row().brief_status).toBe('');
  });

  it('调度响应断开可通过读取恢复原编号，不重新生成任务',async()=>{
    const s=await setup();s.dispatch.mockRejectedValueOnce(new Error('network lost'));
    const row=await enqueueForgeTask(s.env,{type:'preview',id:9});
    expect(row.status).toBe('queued');
    await readForgeTask(s.env,row.id);
    expect(s.dispatch).toHaveBeenCalledTimes(2);
    for(const [request] of s.dispatch.mock.calls as any)expect(await request.clone().text()).toBe(row.id);
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toMatchObject({n:1});
  });

  it('旧队列的固定编号在任务完成后再次投递不会生成新任务',async()=>{
    const s=await setup(),id=crypto.randomUUID();
    await enqueueForgeTask(s.env,{type:'preview',id:9},id);
    s.sqlite.prepare("UPDATE forge_tasks SET status='done' WHERE id=?").run(id);
    const before=s.dispatch.mock.calls.length;
    const same=await enqueueForgeTask(s.env,{type:'preview',id:9},id);
    expect(same.status).toBe('done');expect(s.dispatch.mock.calls.length).toBe(before);
    expect(s.sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toMatchObject({n:1});
  });

  it('进程在付费调用中断后，重入 alarm 明确失败，不重放；手动重试得到新编号，旧任务不能覆盖',async()=>{
    const s=await setup();
    const row=await enqueueForgeTask(s.env,{type:'game',id:9,requestId:'unused'});
    s.sqlite.prepare("UPDATE forge_tasks SET status='running',started_at=?,model_started_at=? WHERE id=?").run(new Date().toISOString(),new Date().toISOString(),row.id);
    const storage={get:async()=>row.id,setAlarm:vi.fn(),deleteAlarm:vi.fn(),deleteAll:vi.fn()};
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await new ForgeRunner({storage},s.env).alarm();
    expect(fetcher).not.toHaveBeenCalled();expect(s.task(row.id).status).toBe('error');expect(s.row().product_status).toBe('error');
    const fresh=await enqueueForgeTask(s.env,{type:'game',id:9,requestId:'unused'});
    expect(fresh.id).not.toBe(row.id);
    await failForgeTask(s.env,row,'late old failure');
    expect(s.row()).toMatchObject({product_status:'queued',product_request_id:fresh.id});
  });

  it('扩写漏项会结束为可重试错误，刷新不会留在运行',async()=>{
    const s=await setup();s.sqlite.exec("UPDATE topics SET data='{}',status='drawn'");
    const started=await s.request('POST','expand',{ids:[9]});expect(started.status).toBe(200);
    const row=s.sqlite.prepare('SELECT * FROM forge_tasks').get() as any;
    const fetcher=vi.fn(async()=>response('{"items":[]}'));vi.stubGlobal('fetch',fetcher);
    await executeForgeTask(s.env,row.id);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(s.task(row.id).status).toBe('error');
    expect(s.row()).toMatchObject({expand_status:'error',data:'{}'});
    expect(s.row().expand_error).toContain('覆盖全部选题');
  });

  it('截断不覆盖已有简报、不自动重做；读取状态恢复中断任务不调用模型',async()=>{
    const s=await setup();s.sqlite.exec("UPDATE topics SET brief_md='original brief'");
    const row=await enqueueForgeTask(s.env,{type:'brief',id:9});
    const fetcher=vi.fn(async()=>response('incomplete','max_tokens'));vi.stubGlobal('fetch',fetcher);
    await executeForgeTask(s.env,row.id);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(s.row().brief_md).toBe('original brief');expect(s.row().brief_status).toBe('error');
    const fresh=await enqueueForgeTask(s.env,{type:'brief',id:9});
    s.sqlite.prepare("UPDATE forge_tasks SET status='running',started_at='2000-01-01' WHERE id=?").run(fresh.id);
    const state=await (await s.request('GET','topics/9')).json() as any;
    expect(state.brief_status).toBe('error');expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('预览、词库和标签走短请求与持久状态接口，返回结果而不占用长HTTP请求',async()=>{
    const s=await setup();
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      if(body.system.includes('风格样板'))return response('<svg viewBox="0 0 540 960"><rect width="10" height="10"/></svg>');
      return response('{"words":[{"word":"test lighthouse","note":"fixture"}]}');
    });vi.stubGlobal('fetch',fetcher);
    for(const [path,data] of [['topics/9/preview',undefined],['suggest',{dim:'subject',n:5}],['tag',undefined]] as const){
      const queued=await (await s.request('POST',path,data)).json() as any;
      expect(queued).toMatchObject({pending:true,jobId:expect.any(String)});
      const before=fetcher.mock.calls.length;
      expect((await (await s.request('GET',`generation-jobs/${queued.jobId}`)).json() as any).status).toBe('queued');
      expect(fetcher.mock.calls.length).toBe(before);
      await executeForgeTask(s.env,queued.jobId);
      const saved=await (await s.request('GET',`generation-jobs/${queued.jobId}`)).json() as any;
      expect(saved.status).toBe('done');
      expect(JSON.stringify(saved)).not.toMatch(/test-only-key|encryptedKey|system/);
      if(path.includes('preview')){
        expect(saved.result).toMatchObject({id:9,disposition:'current',version_id:expect.any(String)});
        expect(s.sqlite.prepare('SELECT content FROM artifact_versions WHERE id=?').get(saved.result.version_id)).toMatchObject({content:expect.stringContaining('<svg')});
      }
      if(path==='suggest')expect(saved.result).toMatchObject({added:1});
      if(path==='tag')expect(saved.result).toMatchObject({tagged:0,remaining:0});
    }
  });

  it('SSE渠道503明确结束任务，complete 不再重放结果未知的请求',async()=>{
    const s=await setup();
    const fetcher=vi.fn(async(..._args: any[])=>fetcher.mock.calls.length === 1
      ? new Response('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Anthropic 渠道返回 503"}}\n\n',{headers:{'Content-Type':'text/event-stream'}})
      : response('{"ok":true}'));
    vi.stubGlobal('fetch',fetcher);
    const result=complete(s.env,{}, {system:'s',user:'u',purpose:'preview',idempotencyKey:'stream-503'});
    await expect(result).rejects.toThrow('本次结果未知');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('非流式简报超过五分钟仍可完成，不误触流式空闲超时',async()=>{
    const s=await setup();vi.useFakeTimers();
    const row=await enqueueForgeTask(s.env,{type:'brief',id:9});
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      expect(JSON.parse(String(init?.body)).stream).toBe(false);
      await new Promise(resolve=>setTimeout(resolve,360000));
      return response('## F. 游戏设计\n慢速但完整的简报');
    });vi.stubGlobal('fetch',fetcher);
    const result=executeForgeTask(s.env,row.id);
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(360000);await result;
    expect(s.task(row.id).status).toBe('done');expect(s.row().brief_md).toContain('慢速但完整');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('非流式调用即使永不回应，也在总期限内结束并保存可重试错误',async()=>{
    const s=await setup();vi.useFakeTimers();
    const row=await enqueueForgeTask(s.env,{type:'brief',id:9});
    const fetcher=vi.fn(()=>new Promise<Response>(()=>{}));vi.stubGlobal('fetch',fetcher);
    const result=executeForgeTask(s.env,row.id);
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(12*60000+100);await result;
    expect(s.task(row.id)).toMatchObject({status:'error',error:expect.stringContaining('超时')});
    expect(s.row().brief_status).toBe('error');expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
