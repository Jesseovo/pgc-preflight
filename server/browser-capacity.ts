// A shared launch gate prevents simultaneous Workers from racing the browser
// acquisition limit. Sessions still run concurrently up to the account limit.
type Limits = { activeSessions: unknown[]; maxConcurrentSessions: number; allowedBrowserAcquisitions: number; timeUntilNextAllowedBrowserAcquisition: number };
export async function acquireBrowser<T>(DB:any, limits:()=>Promise<Limits>, launch:()=>Promise<T>, onWait?:(message:string)=>Promise<void>, timeoutMs=240000):Promise<T> {
  const deadline=Date.now()+timeoutMs, lease=crypto.randomUUID();
  let announced=false;
  while(Date.now()<deadline){
    const now=Date.now();
    const claim=await DB.prepare(`INSERT INTO browser_launch_gate (id,lease,lease_until,next_at) VALUES ('review',?,?,0)
      ON CONFLICT(id) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until
      WHERE browser_launch_gate.lease_until<=? AND browser_launch_gate.next_at<=?`).bind(lease,now+30000,now,now).run();
    let delay=1000;
    if(claim.meta.changes){
      try {
        const state=await limits();
        if(state.activeSessions.length<state.maxConcurrentSessions&&state.allowedBrowserAcquisitions>0)return await launch();
        delay=state.activeSessions.length>=state.maxConcurrentSessions?2000:Math.max(1000,state.timeUntilNextAllowedBrowserAcquisition+100);
      } catch(error){
        if(!/429|concurrent|too many/i.test(String(error)))throw error;
        delay=5000;
      } finally {
        await DB.prepare("UPDATE browser_launch_gate SET lease_until=0,next_at=? WHERE id='review' AND lease=?").bind(Date.now()+Math.min(delay,30000),lease).run();
      }
    }
    if(!announced){announced=true;await onWait?.('等待截图浏览器空位，系统正在按平台限速自动排队…');}
    await new Promise(resolve=>setTimeout(resolve,Math.min(delay,30000,Math.max(0,deadline-Date.now()))));
  }
  throw new Error('截图服务排队超时，本次未调用模型，审核次数已退回，请稍后重试。');
}
