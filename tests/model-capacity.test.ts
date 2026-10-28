import {afterEach,describe,it,expect,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {claimCreationModel,tryModelSlot,modelKeyId} from '../server/model-capacity';
import {saveConfig,type ModelConfig,activeModelProfile} from '../server/settings';
import {modelTransport} from '../server/model';
const databases:DatabaseSync[]=[];
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();databases.splice(0).forEach(d=>d.close());});
const runtime={baseUrl:'https://riffle-api.pages.dev',model:'claude-opus-5-5',protocol:'anthropic' as const,apiKey:'fixture-key-a'};
async function setup(keys=['fixture-key-a','fixture-key-b']){
 const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
 sqlite.exec(readFileSync('migrations/0007_model_throttle.sql','utf8'));sqlite.exec(readFileSync('migrations/0023_model_slots.sql','utf8'));
 const DB:any={prepare:(sql:string)=>({bind:(...p:any[])=>({first:async()=>sqlite.prepare(sql).get(...p)||null,run:async()=>sqlite.prepare(sql).run(...p)})})};
 let config:ModelConfig|null=null;const store={get:async()=>config,set:async(v:ModelConfig)=>{config=v;}};
 for(let i=0;i<keys.length;i++)await saveConfig({...runtime,profile:'opus-'+i,name:'Opus '+i,apiKey:keys[i]},store,'secret');
 return {sqlite,DB,config:config!,claim:(id:string)=>claimCreationModel(DB,config,'secret','game',id)};
}
describe('多 Key 制作调度',()=>{
 it('两把不同 Key 分担四个同时任务，每把最多两个；第五个等待释放后继续',async()=>{
  const s=await setup(),leases=await Promise.all(Array.from({length:4},(_,i)=>s.claim('task-'+i)));
  expect(leases.every(Boolean)).toBe(true);expect(await s.claim('task-5')).toBeNull();
  expect(s.sqlite.prepare('SELECT count(*) n FROM model_slots GROUP BY key_id ORDER BY n').all()).toEqual([{n:2},{n:2}]);
  expect(new Set(leases.map(v=>activeModelProfile(v!.config,'game')!.id)).size).toBe(2);
  await leases[0]!.lease.release();expect(await s.claim('task-5')).not.toBeNull();
  expect(JSON.stringify(s.sqlite.prepare('SELECT * FROM model_slots').all())).not.toMatch(/fixture-key/);
 });
 it('重复添加同一 Key 共享同一额度，不虚增并发',async()=>{
  const s=await setup(['same-key','same-key']);expect(await s.claim('one')).not.toBeNull();expect(await s.claim('two')).not.toBeNull();expect(await s.claim('three')).toBeNull();
 });
 it('停用配置不参与调度，过期租约可恢复，不影响其他 Key',async()=>{
  const s=await setup();s.config.profiles!['opus-1']!.enabled=false;
  expect(await s.claim('one')).not.toBeNull();expect(await s.claim('two')).not.toBeNull();expect(await s.claim('three')).toBeNull();
  s.sqlite.exec('UPDATE model_slots SET expires_at=0');expect(await s.claim('three')).not.toBeNull();
 });
 it('完整结束释放名额；状态未知的中断保留名额直到过期，避免重复占用上游',async()=>{
  const s=await setup(['fixture-key-a']);
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({content:[{type:'text',text:'READY'}],stop_reason:'end_turn'})));
  expect(await modelTransport(runtime,{DB:s.DB})([])).toBe('READY');expect(s.sqlite.prepare('SELECT count(*) n FROM model_slots').get()).toMatchObject({n:0});
  s.sqlite.exec('DELETE FROM model_throttle');
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('connection lost');}));
  await expect(modelTransport(runtime,{DB:s.DB})([])).rejects.toThrow('connection lost');expect(s.sqlite.prepare('SELECT count(*) n FROM model_slots').get()).toMatchObject({n:1});
 });
 it('网关明确尚未接纳的 KEY_QUEUE_FULL 按原请求等待，不受普通三次重试限制',async()=>{
  vi.useFakeTimers();const fetcher=vi.fn(async()=>fetcher.mock.calls.length<6?Response.json({error:{code:'KEY_QUEUE_FULL',message:'最多同时运行2个请求'}},{status:503,headers:{'Retry-After':'10'}}):Response.json({content:[{type:'text',text:'READY'}],stop_reason:'end_turn'}));vi.stubGlobal('fetch',fetcher);
  const result=modelTransport(runtime,{idempotencyKey:'same-job',totalTimeoutMs:100000})([]);await vi.advanceTimersByTimeAsync(50000);await expect(result).resolves.toBe('READY');expect(fetcher).toHaveBeenCalledTimes(6);
 });
 it('流内上游429不重放，并给同 Key 留出共享冷却',async()=>{
  const s=await setup(['fixture-key-a']),at=Date.now();
  const fetcher=vi.fn(async()=>new Response('event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"upstream 429"}}\n\n',{headers:{'Content-Type':'text/event-stream'}}));vi.stubGlobal('fetch',fetcher);
  await expect(modelTransport(runtime,{DB:s.DB,idempotencyKey:'uncertain-stream'})([])).rejects.toThrow('429');
  expect(fetcher).toHaveBeenCalledTimes(1);expect(s.sqlite.prepare('SELECT cooldown_until FROM model_throttle').get()).toMatchObject({cooldown_until:expect.any(Number)});
  expect(Number((s.sqlite.prepare('SELECT cooldown_until FROM model_throttle').get() as any).cooldown_until)).toBeGreaterThanOrEqual(at+30000);
 });
});
