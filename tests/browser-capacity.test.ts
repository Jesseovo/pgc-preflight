import {afterEach,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {acquireBrowser,connectAcquiredBrowser} from '../server/browser-capacity';
afterEach(()=>vi.useRealTimers());
it('会话已分配但连接未就绪时只重连同一会话，不重新申请或读取其他会话',async()=>{
  vi.useFakeTimers();
  const acquire=vi.fn(async()=>({sessionId:'own-session'})),connect=vi.fn().mockRejectedValueOnce(new Error("Unable to connect to existing session own-session: Cannot read properties of null (reading 'accept')")).mockResolvedValue('ready');
  const task=connectAcquiredBrowser(acquire,connect);await vi.advanceTimersByTimeAsync(1100);
  expect(await task).toBe('ready');expect(acquire).toHaveBeenCalledTimes(1);expect(connect.mock.calls).toEqual([['own-session'],['own-session']]);
});
it('会话连接恢复有界，永久错误直接结束',async()=>{
  vi.useFakeTimers();const acquire=vi.fn(async()=>({sessionId:'own-session'})),connect=vi.fn().mockRejectedValue(new Error('Unable to connect to existing session own-session'));
  const task=connectAcquiredBrowser(acquire,connect),rejection=expect(task).rejects.toThrow('尚未调用模型');await vi.advanceTimersByTimeAsync(6100);await rejection;
  expect(acquire).toHaveBeenCalledTimes(1);expect(connect).toHaveBeenCalledTimes(4);
  const permanent=vi.fn().mockRejectedValue(new Error('403 forbidden'));
  await expect(connectAcquiredBrowser(acquire,permanent)).rejects.toThrow('403');expect(permanent).toHaveBeenCalledTimes(1);
});
function database(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE browser_launch_gate(id TEXT PRIMARY KEY,lease TEXT,lease_until INTEGER,next_at INTEGER)');
  return {sqlite,DB:{prepare:(sql:string)=>({bind:(...values:any[])=>({run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}})})})}};
}
it('多个消费者共享启动限速，已启动会话能并行，不把启动额度当成会话并发数',async()=>{
  vi.useFakeTimers();const {sqlite,DB}=database();let sessions=0,allowedAt=0;
  const limits=vi.fn(async()=>({activeSessions:Array(sessions).fill({}),maxConcurrentSessions:4,allowedBrowserAcquisitions:Date.now()>=allowedAt?1:0,timeUntilNextAllowedBrowserAcquisition:Math.max(0,allowedAt-Date.now())}));
  const launch=vi.fn(async()=>{sessions++;allowedAt=Date.now()+1000;return sessions;});
  const wait=vi.fn(async()=>{});
  try{
    const tasks=Promise.all(Array.from({length:3},()=>acquireBrowser(DB,limits,launch,wait)));
    await vi.advanceTimersByTimeAsync(4000);
    expect(await tasks).toEqual([1,2,3]);expect(launch).toHaveBeenCalledTimes(3);expect(sessions).toBe(3);expect(wait).toHaveBeenCalled();
  }finally{sqlite.close();}
});
it('上游瞬时429在采集前等待恢复，不直接打断游戏审核',async()=>{
  vi.useFakeTimers();const {sqlite,DB}=database();
  const limits=async()=>({activeSessions:[],maxConcurrentSessions:4,allowedBrowserAcquisitions:1,timeUntilNextAllowedBrowserAcquisition:0});
  const launch=vi.fn().mockRejectedValueOnce(new Error('429 too many browser acquisitions')).mockResolvedValue('browser');
  try{
    const task=acquireBrowser(DB,limits,launch);await vi.advanceTimersByTimeAsync(6000);
    expect(await task).toBe('browser');expect(launch).toHaveBeenCalledTimes(2);
  }finally{sqlite.close();}
});
