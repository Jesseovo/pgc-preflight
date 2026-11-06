import {captureFor,closeCaptureBrowser,type CaptureBrowserLifecycle} from './cloud-review-capture';

export const embeddedCaptureKey='embedded-baseline-capture';
type Pending={id:string;browserId?:string;cancelled?:boolean};

/** Recover only the session acquired by this task. Never enumerate other sessions. */
export async function closeEmbeddedCapture(env:any,storage:any){
  const pending=await storage.transaction(async(tx:any)=>{
    const value:Pending|undefined=await tx.get(embeddedCaptureKey);
    if(value)await tx.put(embeddedCaptureKey,{...value,cancelled:true});
    return value;
  });
  if(!pending)return;
  if(!pending.browserId)throw new Error('基础采集浏览器申请结果未知，保留记录等待清理。');
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([closeCaptureBrowser(env.BROWSER,pending.browserId),new Promise<never>((_,reject)=>{
      timeout=setTimeout(()=>reject(new Error('基础采集浏览器关闭超时，保留原会话记录。')),5000);
    })]);
  }finally{clearTimeout(timeout);}
  await storage.transaction(async(tx:any)=>{
    const current:Pending|undefined=await tx.get(embeddedCaptureKey);
    if(!current||current.id!==pending.id||current.browserId!==pending.browserId)throw new Error('基础采集关闭记录不匹配。');
    await tx.delete(embeddedCaptureKey);
  });
}

/** The existing four-viewport capture, with a durable own-session lifecycle. */
export async function captureEmbeddedBaseline(env:any,storage:any,html:string,onWait:((message:string)=>Promise<void>)|undefined,deadlineAt:number){
  await closeEmbeddedCapture(env,storage);
  const id=crypto.randomUUID();let closureConfirmed=false;
  const lifecycle:CaptureBrowserLifecycle={
    acquiring:()=>storage.transaction(async(tx:any)=>{
      if(await tx.get(embeddedCaptureKey))throw new Error('基础采集已有待关闭浏览器。');
      await tx.put(embeddedCaptureKey,{id});
    }),
    rejected:async()=>{
      const cancelled=await storage.transaction(async(tx:any)=>{
        const pending:Pending|undefined=await tx.get(embeddedCaptureKey);
        if(!pending||pending.id!==id||pending.browserId)throw new Error('基础采集拒绝记录不匹配。');
        await tx.delete(embeddedCaptureKey);
        return pending.cancelled;
      });
      if(cancelled)throw new Error('基础采集已停止。');
    },
    acquired:async browserId=>{
      const cancelled=await storage.transaction(async(tx:any)=>{
        const pending:Pending|undefined=await tx.get(embeddedCaptureKey);
        if(pending?.id!==id||pending.browserId)throw new Error('基础采集申请记录不匹配。');
        await tx.put(embeddedCaptureKey,{...pending,browserId});
        return pending.cancelled;
      });
      if(cancelled)throw new Error('基础采集已停止。');
    },
    closed:async browserId=>{
      await storage.transaction(async(tx:any)=>{
        const pending:Pending|undefined=await tx.get(embeddedCaptureKey);
        if(pending?.id!==id||pending.browserId!==browserId)throw new Error('基础采集关闭记录不匹配。');
        await tx.delete(embeddedCaptureKey);
      });
      closureConfirmed=true;
    },
  };
  const capture=env.captureReview||captureFor({...env,creationCaptureStrict:true});
  const result=await capture(html,onWait,deadlineAt,undefined,lifecycle);
  if(!closureConfirmed)throw new Error('基础采集未确认浏览器关闭，未进入模型阶段。');
  return result;
}
