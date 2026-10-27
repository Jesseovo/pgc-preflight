import {afterEach,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {acquireBrowser} from '../server/browser-capacity';
afterEach(()=>vi.useRealTimers());
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
