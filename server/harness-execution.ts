import {canonicalHarness,harnessHash,modelContractHash,parseHarnessPolicy,type HarnessBinding,type HarnessFamily,type HarnessPolicy} from './harness-policy';
import type {ModelPurpose} from './settings';
import {HARNESS_MAX_REQUEST_MS} from './harness-protocol';

type HarnessClock={startedAt:number;taskDeadlineAt:number;stageDeadlineAt:number};
export type HarnessExecution={taskId:string;ownerId:string;family:HarnessFamily;phase:string;sourceHash:string;policy:HarnessPolicy;deadlineAt:number;previousHtml?:string;recoverSealed?:true;onAllocated?:(clock:HarnessClock)=>Promise<void>;onEvidence?:(evidence:any[])=>Promise<void>};
export class HarnessCapacityWait extends Error {}
export class EmbeddedHarnessSealError extends Error {
  constructor(){super('内嵌阶段的锁定结果无法核验，未重放模型请求。');}
}
type SealStorage={get(key:string):Promise<any>};
export async function hasEmbeddedPhaseSeal(storage:SealStorage,taskId:string,phase:string){
  const meta=await storage.get('embedded-harness-meta');
  return meta?.taskId===taskId&&meta?.phase===phase&&meta?.state==='succeeded';
}
async function recoverEmbeddedPhase(env:Environment,execution:HarnessExecution,request:Completion){
  const storage=env.harnessStorage,meta=await storage?.get('embedded-harness-meta');
  if(execution.policy.engine!=='ccb-embedded'||!meta||meta.state!=='succeeded'||
    meta.taskId!==execution.taskId||meta.ownerId!==execution.ownerId||meta.family!==execution.family||
    meta.phase!==execution.phase||meta.sourceHash!==execution.sourceHash||
    canonicalHarness(meta.policy)!==canonicalHarness(execution.policy)||
    !Number.isSafeInteger(meta.sealedAt)||!Number.isSafeInteger(meta.stageStartedAt)||!Number.isSafeInteger(meta.stageDeadlineAt)||
    meta.sealedAt<meta.stageStartedAt||meta.sealedAt>=meta.stageDeadlineAt||meta.sealedAt>=execution.deadlineAt||meta.sealedAt>Date.now())
    throw new EmbeddedHarnessSealError();
  const {authorizeHarnessTask,readHarnessPrivate}=await import('./harness-host');
  if(!await authorizeHarnessTask(env,execution))throw new EmbeddedHarnessSealError();
  const materials={system:request.system,user:request.user,...(request.schema?{schema:request.schema}:{}),...(execution.previousHtml?{previousHtml:execution.previousHtml}:{})};
  const materialHash=await harnessHash(canonicalHarness(materials));
  if(meta.materialHash!==materialHash)throw new EmbeddedHarnessSealError();
  const result=await readHarnessPrivate(storage,`embedded-result:${execution.phase}`).catch(error=>{
    if(error instanceof SyntaxError||error instanceof Error&&/^harness_checkpoint_(invalid|missing)$/.test(error.message))
      throw new EmbeddedHarnessSealError();
    throw error;
  });
  if(result?.materialHash!==materialHash||result.sealedAt!==meta.sealedAt||
    typeof result.text!=='string'||await harnessHash(result.text)!==result.outputHash||
    !Array.isArray(result.evidence)||await harnessHash(canonicalHarness(result.evidence))!==result.evidenceHash)
    throw new EmbeddedHarnessSealError();
  await execution.onEvidence?.(result.evidence);
  return result.text as string;
}
type Environment={HARNESS_RUNNER?:HarnessBinding;harnessStorage?:any;harnessExecution?:HarnessExecution;modelStore:{get():Promise<any>};DB?:any;SETTINGS_KEY?:string};
type Completion={system:string;user:unknown;schema?:unknown;purpose?:ModelPurpose;maxTokens?:number;deadline?:number;onWait?:(message:string)=>Promise<void>;onStart?:()=>Promise<void>;prepareResult?:(text:string)=>string};
export function harnessExecutionFor(row:any,family:HarnessFamily,phase:string,sourceHash:string,deadlineAt:number):HarnessExecution|undefined{
  const policy=parseHarnessPolicy(row.harness_policy);if(!policy)return;
  if(row.executor==='agent'||row.model_executor==='agent')throw new Error('成员 Agent 任务不能转交平台 Harness。');
  return {taskId:row.id,ownerId:row.owner_id||'admin',family,phase,sourceHash,policy,deadlineAt};
}

export async function harnessCompletion(env:Environment,request:Completion):Promise<string>{
  const execution=env.harnessExecution;
  if(execution?.recoverSealed)return recoverEmbeddedPhase(env,execution,request);
  if(execution?.policy.engine==='ccb-embedded'){
    const {embeddedHarnessCompletion,EmbeddedHarnessCapacityWait}=await import('./harness-embedded-runtime');
    try{return await embeddedHarnessCompletion(env as any,request);}
    catch(error){if(error instanceof EmbeddedHarnessCapacityWait)throw new HarnessCapacityWait(error.message);throw error;}
  }
  if(!execution||!env.HARNESS_RUNNER)throw new Error('已锁定的 Harness 执行服务不可用，未切回原模型重跑。');
  const config=await env.modelStore.get();
  const purpose=request.purpose||'create';
  const contract=await modelContractHash(config,execution.policy.purpose);
  if(contract!==execution.policy.modelContractHash)throw new Error('Harness 模型配置与任务锁定版本不同。');
  const materials={system:request.system,user:request.user,...(request.schema?{schema:request.schema}:{}),...(execution.previousHtml?{previousHtml:execution.previousHtml}:{})};
  const materialHash=await harnessHash(canonicalHarness(materials));
  const {onAllocated,onEvidence,...identity}=execution;
  let deadlineAt=Math.min(execution.deadlineAt,request.deadline??Infinity,Date.now()+HARNESS_MAX_REQUEST_MS);
  const binding=env.HARNESS_RUNNER,stub=binding.get(binding.idFromName(execution.taskId));
  // For the first game stage, capacity rejection must leave the original task
  // untouched and let its alarm wait. The host starts the clock on allocation.
  if(!onAllocated)await request.onStart?.();
  const payload=JSON.stringify({...identity,...(onAllocated?{startWindow:'allocation'}:{}),
    taskDeadlineAt:execution.deadlineAt,deadlineAt,purpose,materialHash,materials,config,maxTokens:request.maxTokens});
  let data:any;
  for(;;){
    const started=await stub.fetch(new Request('http://harness/start',{method:'POST',body:payload}));
    try{data=await started.json();}catch{throw new Error('Harness 启动状态无法确认；未发起第二个任务。');}
    // Only a positively identified capacity refusal permits a later start.
    if(started.status===429&&data.error==='harness_capacity'){
      if(onAllocated)throw new HarnessCapacityWait('等待隔离执行名额…');
      if(Date.now()+5000>=deadlineAt)throw new Error('隔离执行名额等待超时，未发起模型请求。');
      await request.onWait?.('等待隔离执行名额…');await new Promise(r=>setTimeout(r,5000));continue;
    }
    if(!started.ok)throw new Error(data.error||'Harness 未能启动。');
    break;
  }
  if(onAllocated){
    const clock:HarnessClock={startedAt:data.startedAt,taskDeadlineAt:data.taskDeadlineAt,stageDeadlineAt:data.stageDeadlineAt};
    if(!Object.values(clock).every(Number.isSafeInteger)||clock.startedAt>Date.now()||
      clock.taskDeadlineAt-clock.startedAt!==execution.policy.limits.maxDurationMs||
      clock.stageDeadlineAt!==Math.min(clock.startedAt+HARNESS_MAX_REQUEST_MS,clock.taskDeadlineAt))throw new Error('Harness 启动时间无法确认；未发起第二个任务。');
    await onAllocated(clock);
    await request.onStart?.();
    deadlineAt=clock.stageDeadlineAt;
  }
  const query=`phase=${encodeURIComponent(execution.phase)}&material=${materialHash}`;
  const read=async(path:string)=>{
    try{
      const response=await stub.fetch(new Request(`http://harness/${path}?${query}`));
      if(response.status<500)return response;
    }catch{/* Retry only a read of the same phase. */}
  };
  const pause=()=>new Promise(resolve=>setTimeout(resolve,2000));
  const recoverRead=async()=>{
    if(Date.now()>=deadlineAt)return false;
    await request.onWait?.('正在恢复原任务状态连接…').catch(()=>{});
    await pause();
    return true;
  };
  const acceptResult=async(body:any)=>{
    if(body?.materialHash!==materialHash||typeof body.text!=='string'||await harnessHash(body.text)!==body.outputHash)throw new Error('Harness 结果与锁定材料不符。');
    if(onEvidence){
      if(!Array.isArray(body.evidence)||await harnessHash(canonicalHarness(body.evidence))!==body.evidenceHash)throw new Error('Harness 补测证据未完整锁定。');
      await onEvidence(body.evidence);
    }
    return body.text as string;
  };
  // One read-only check at expiry can still retrieve a result sealed on time.
  // The host refuses to create a seal for an overdue phase.
  for(;;){
    const response=await read('status');
    if(!response){if(await recoverRead())continue;break;}
    if(!response.ok)throw new Error('Harness 状态暂不可读；原任务保留，不能重复付费执行。');
    const status=await response.json().catch(()=>null) as any;
    if(!status){if(await recoverRead())continue;break;}
    if(status.state==='succeeded'){
      const result=await read('result');
      if(!result){if(await recoverRead())continue;break;}
      if(!result.ok)throw new Error('Harness 已完成的结果尚未保存；未重新调用模型。');
      const body=await result.json().catch(()=>null) as any;
      if(!body){if(await recoverRead())continue;break;}
      return acceptResult(body);
    }
    if(['failed','cancelled','unknown','expired'].includes(status.state))throw new Error(status.error||'Harness 未完成，已保留可用产物。');
    if(Date.now()>=deadlineAt)break;
    await request.onWait?.(status.state==='queued'?'等待隔离执行名额…':'模型正在使用任务工具制作与核验…');
    await pause();
  }
  // The deadline action either returns the already sealed result or stops the
  // original stage. A lost response can retry this action, never its start.
  for(let attempt=0;attempt<3;attempt++){
    const controller=new AbortController();
    let timeout:ReturnType<typeof setTimeout>|undefined;
    const terminal=Promise.resolve().then(()=>stub.fetch(new Request(`http://harness/cancel?${query}`,{
      method:'POST',body:JSON.stringify({reason:'deadline'}),signal:controller.signal,
    }))).then(response=>response.ok?response.json():null).catch(()=>null);
    const body=await Promise.race([terminal,new Promise<null>(resolve=>{
      timeout=setTimeout(()=>{controller.abort();resolve(null);},3000);
    })]).finally(()=>clearTimeout(timeout)) as any;
    if(body?.state==='succeeded')return acceptResult(body.result);
    if(body?.ok===true)break;
    if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error('Harness 本阶段时限已到；保存已完成结果，未自动重跑。');
}

export async function finishHarnessTask(env:{HARNESS_RUNNER?:HarnessBinding;harnessStorage?:any;DB?:any;[key:string]:any},id:string,outcome:'completed'|'failed'){
  if(env.DB){
    const row=await env.DB.prepare('SELECT snapshot FROM harness_runs WHERE task_id=?').bind(id).first();
    if(row&&JSON.parse(row.snapshot)?.engine==='ccb-embedded'){
      const {finishEmbeddedTask}=await import('./harness-embedded-runtime');
      await finishEmbeddedTask(env as any,id,outcome);return;
    }
  }
  if(!env.HARNESS_RUNNER){
    if(outcome==='completed')throw new Error('已锁定的 Harness 执行服务不可用，原结果保留等待恢复。');
    return;
  }
  const stub=env.HARNESS_RUNNER.get(env.HARNESS_RUNNER.idFromName(id));
  const response=await stub.fetch(new Request('http://harness/finish',{method:'POST',body:JSON.stringify({outcome})}));
  if(!response.ok)throw new Error('Harness 清理尚未确认，名额保持占用等待恢复。');
}

export const embeddedCleanupOnlyKey='embedded-cleanup-only';
const cleanupSinceKey='embedded-cleanup-since';
const cleanupStorageKeys=new Set([embeddedCleanupOnlyKey,cleanupSinceKey,'taskId','jobId',
  'embedded-harness-meta','embedded-harness-allocation','embedded-baseline-capture',
  'harness-browser-state','harness-browser-pending-capture','creationRecoverySince','cloudRecoverySince']);

async function trimExpiredEmbeddedStorage(storage:any,meta:any){
  const now=Date.now();
  let since=await storage.get(cleanupSinceKey);
  if(!Number.isSafeInteger(since)){since=now;await storage.put(cleanupSinceKey,since);}
  const clocks=[since,meta?.startedAt,await storage.get('creationRecoverySince'),await storage.get('cloudRecoverySince')];
  if(!clocks.some(clock=>Number.isSafeInteger(clock)&&now-clock>=86400000))return;
  await storage.put(embeddedCleanupOnlyKey,true);
  if(meta?.lease)await storage.put('embedded-harness-meta',{...meta,lease:''});
  // Scan bounded pages. Retain the original browser IDs and the slot's
  // ownership record, while dropping material, output and evidence chunks.
  let startAfter:string|undefined;
  for(;;){
    const keys=[...(await storage.list({limit:128,...(startAfter&&{startAfter})})).keys()] as string[];
    if(!keys.length)break;
    const expired=keys.filter(key=>!cleanupStorageKeys.has(key));
    if(expired.length)await storage.delete(expired);
    startAfter=keys[keys.length-1];
  }
}

/** Retain the original browser identity when cleanup has not been confirmed. */
export async function clearHarnessRunnerStorage(env:any,storage:any,id:string,terminalOutcome?:'completed'|'failed'){
  const {closeEmbeddedCapture,embeddedCaptureKey}=await import('./harness-embedded-capture');
  const meta=await storage.get('embedded-harness-meta'),journal=await storage.get('embedded-harness-allocation');
  const pendingCapture=await storage.get(embeddedCaptureKey);
  try{
    if(pendingCapture)await closeEmbeddedCapture(env,storage);
    if(terminalOutcome)await finishHarnessTask({...env,harnessStorage:storage},id,terminalOutcome);
    else if(meta||journal){
      const {finishEmbeddedTask}=await import('./harness-embedded-runtime');
      await finishEmbeddedTask({...env,harnessStorage:storage},id,meta?.state==='completed'?'completed':'failed');
    }
  }catch(error){
    await storage.setAlarm(Date.now()+30000);
    if(meta||journal||pendingCapture)await trimExpiredEmbeddedStorage(storage,meta);
    throw error;
  }
  await storage.deleteAll();
}
