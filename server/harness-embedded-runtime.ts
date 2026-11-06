import {runEmbeddedQuery,getEmbeddedExecutionPrompt, type EmbeddedMessage} from './embedded-ccb';
import {openEmbeddedWorkspace} from './harness-embedded-workspace';
import {EmbeddedHarnessModelError,runEmbeddedHarnessModel} from './harness-embedded-model';
import {archiveEmbeddedArtifact} from './harness-embedded-artifacts';
import {authorizeHarnessTask,harnessMaterialFiles,harnessResultText,readHarnessPrivate,storeHarnessPrivate} from './harness-host';
import {canonicalHarness,harnessHash,modelContractHash,parseHarnessPolicy, type HarnessPolicy} from './harness-policy';
import {createHarnessRun,endHarnessRun,getHarnessRun,lockHarnessModel,recordHarnessEvent,releaseHarnessSlot, type HarnessRun} from './harness-ledger';
import {HarnessTools} from './harness-tools';
import {HARNESS_MAX_REQUEST_MS} from './harness-protocol';
import type {HarnessExecution} from './harness-execution';
import {configStore} from './storage';
import {closeEmbeddedCapture} from './harness-embedded-capture';

type NativePolicy=Extract<HarnessPolicy,{engine:'ccb-embedded'}>;
type NativeMeta={taskId:string;generation:string;ownerId:string;family:'forge'|'review';lease:string;policy:NativePolicy;sourceHash:string;
  phase:string;materialHash:string;runId:string;state:'allocated'|'running'|'succeeded'|'failed'|'completed';startedAt:number;stageStartedAt:number;deadlineAt:number;stageDeadlineAt:number;sealedAt?:number};
type Completion={system:string;user:unknown;schema?:unknown;purpose?:string;maxTokens?:number;deadline?:number;onStart?:()=>Promise<void>;onWait?:(message:string)=>Promise<void>;prepareResult?:(text:string)=>string};
type Environment={DB:any;SETTINGS_KEY:string;harnessStorage?:any;harnessExecution?:HarnessExecution;modelStore:{get():Promise<any>};[key:string]:any};
const metaKey='embedded-harness-meta';
const orders:Record<string,string>={build:'polish',polish:'repair',repair:'repair2',review:'review_verify'};
const phases=new Set(['build','polish','repair','repair2','expand','brief','preview','assets','tag','suggest','mechanism-check','review','review_verify']);
export class EmbeddedHarnessCapacityWait extends Error {}

function need(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}

async function requireTask(env:Environment,execution:HarnessExecution) {
  need(await authorizeHarnessTask(env,execution),'内嵌任务权限已失效。');
  const row=await env.DB.prepare(`SELECT harness_policy FROM ${execution.family==='forge'?'forge_tasks':'review_jobs'} WHERE id=?`).bind(execution.taskId).first();
  need(canonicalHarness(parseHarnessPolicy(row?.harness_policy))===canonicalHarness(execution.policy),'内嵌任务策略与锁定记录不同。');
}

async function phaseState(env:Environment,meta:NativeMeta,state:'running'|'succeeded'|'failed',tool:string|null=null,reason:string|null=null){
  const at=Date.now();
  await env.DB.prepare(`INSERT INTO harness_embedded_phases(task_id,generation,phase,core_version,material_hash,state,current_tool,started_at,updated_at,ended_at,stop_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,generation,phase) DO UPDATE SET state=excluded.state,current_tool=excluded.current_tool,updated_at=excluded.updated_at,ended_at=excluded.ended_at,stop_reason=excluded.stop_reason WHERE harness_embedded_phases.state='running'`)
    .bind(meta.taskId,meta.generation,meta.phase,meta.policy.coreVersion,meta.materialHash,state,tool,meta.stageStartedAt,at,state==='running'?null:at,reason).run();
}

/** Runs inside the existing ForgeRunner/ReviewRunner alarm. No public transport or extra DO. */
export async function embeddedHarnessCompletion(env:Environment,request:Completion):Promise<string>{
  const execution=env.harnessExecution,storage=env.harnessStorage;
  need(execution?.policy.engine==='ccb-embedded'&&storage,'内嵌任务必须由原持久任务执行器执行。');
  need(phases.has(execution.phase),'内嵌任务阶段无效。');
  await requireTask(env,execution);
  await closeEmbeddedCapture(env,storage);
  const policy=execution.policy,config=await env.modelStore.get();
  need(await modelContractHash(config,policy.purpose)===policy.modelContractHash,'内嵌任务模型配置与快照不同。');
  const materials={system:request.system,user:request.user,...(request.schema?{schema:request.schema}:{}),...(execution.previousHtml?{previousHtml:execution.previousHtml}:{})};
  const materialHash=await harnessHash(canonicalHarness(materials));
  let meta=await storage.get(metaKey) as NativeMeta|undefined;
  if(meta){
    need(meta.taskId===execution.taskId&&meta.ownerId===execution.ownerId&&meta.family===execution.family&&meta.sourceHash===execution.sourceHash&&canonicalHarness(meta.policy)===canonicalHarness(policy),'内嵌任务检查点不匹配。');
    if(meta.phase===execution.phase){
      need(meta.materialHash===materialHash,'内嵌阶段材料已锁定。');
      if(meta.state==='succeeded'){
        const result=await readHarnessPrivate(storage,`embedded-result:${meta.phase}`);
        need(result?.materialHash===materialHash&&typeof result.text==='string'&&await harnessHash(result.text)===result.outputHash&&await harnessHash(canonicalHarness(result.evidence))===result.evidenceHash,'内嵌已完成结果无法核验。');
        await execution.onEvidence?.(result.evidence);
        return result.text;
      }
      // An interrupted query has no recoverable signed thinking trajectory.
      // Never reconstruct one and never start another paid turn.
      await finishEmbeddedTask(env,meta.taskId,'failed');
      throw new Error('内嵌阶段上下文已中断，原产物保留；未重放模型请求。');
    }
    need(meta.state==='succeeded'&&orders[meta.phase]===execution.phase,'内嵌阶段顺序无效。');
  }else{
    need(!['polish','repair','repair2','review_verify'].includes(execution.phase),'内嵌前序阶段缺失。');
    const old=await env.DB.prepare('SELECT generation FROM harness_runs WHERE task_id=?').bind(execution.taskId).first();
    if(old){await finishEmbeddedTask(env,execution.taskId,'failed');throw new Error('原内嵌任务恢复材料不可用，未创建第二次执行。');}
    const model=await lockHarnessModel(config,policy.purpose,request.maxTokens);
    need(model,'内嵌任务模型不可用。');
    model.maxOutputTokens=Math.min(model.maxOutputTokens,policy.limits.maxOutputTokens);
    for(;;){
      await requireTask(env,execution);
      const startedAt=Date.now(),generation=crypto.randomUUID();
      const deadlineAt=execution.onAllocated?startedAt+policy.limits.maxDurationMs:Math.min(execution.deadlineAt,request.deadline??Infinity,startedAt+policy.limits.maxDurationMs);
      need(deadlineAt>startedAt,'内嵌任务执行名额等待超时。');
      await storage.put('embedded-harness-allocation',{taskId:execution.taskId,generation});
      const allocated=await createHarnessRun(env.DB,{taskId:execution.taskId,generation,ownerId:execution.ownerId,family:execution.family,actor:execution.family==='review'?'admin':'star',sourceHash:execution.sourceHash,snapshot:policy,model,now:startedAt,deadlineAt,limits:policy.limits});
      if(!allocated){
        await storage.delete('embedded-harness-allocation');
        if(execution.onAllocated)throw new EmbeddedHarnessCapacityWait('等待内嵌任务执行名额…');
        need(Date.now()+5000<deadlineAt,'内嵌任务执行名额等待超时。');
        await request.onWait?.('等待内嵌任务执行名额…');await new Promise(resolve=>setTimeout(resolve,5000));continue;
      }
      meta={taskId:execution.taskId,generation,ownerId:execution.ownerId,family:execution.family,lease:allocated.lease,policy,sourceHash:execution.sourceHash,
        phase:execution.phase,materialHash,runId:crypto.randomUUID(),state:'allocated',startedAt,stageStartedAt:startedAt,deadlineAt:allocated.run.deadlineAt,stageDeadlineAt:Math.min(allocated.run.deadlineAt,startedAt+HARNESS_MAX_REQUEST_MS)};
      break;
    }
    // If this write fails, the ledger still prevents a second allocation.
    await storage.put(metaKey,meta);
    await execution.onAllocated?.({startedAt:meta.startedAt,taskDeadlineAt:meta.deadlineAt,stageDeadlineAt:meta.stageDeadlineAt});
  }
  meta={...meta,phase:execution.phase,materialHash,runId:crypto.randomUUID(),state:'running',stageStartedAt:Date.now(),sealedAt:undefined,
    stageDeadlineAt:Math.min(meta.deadlineAt,request.deadline??Infinity,Date.now()+HARNESS_MAX_REQUEST_MS)};
  need(meta.stageDeadlineAt>Date.now(),'内嵌阶段时限已到。');
  await storage.put(metaKey,meta);
  await phaseState(env,meta,'running');
  const run=await getHarnessRun(env.DB,meta);
  need(run?.status==='active'&&run.reservedTokens===0,'内嵌任务模型结果未知或预算不可用。');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,meta.stageDeadlineAt-Date.now()));
  let workspace:Awaited<ReturnType<typeof openEmbeddedWorkspace>>|undefined;
  let sealed=false;
  const browser=new HarnessTools(env as any,storage);
  const identity=meta;
  const authorize=async()=>{try{await requireTask(env,execution);return !controller.signal.aborted&&Date.now()<identity.stageDeadlineAt;}catch{return false;}};
  try{
    await request.onStart?.();
    if(execution.phase==='repair'||execution.phase==='repair2')need(await recordHarnessEvent(env.DB,meta,'repair',execution.phase==='repair'?1:2),'内嵌定向修复次数超限。');
    const {files,imagePaths}=await harnessMaterialFiles(materials);
    need(run.model.vision||imagePaths.length===0,'当前模型不支持锁定原图，未丢弃图片。');
    workspace=await openEmbeddedWorkspace({taskId:meta.taskId,runId:meta.runId,purpose:policy.purpose,vision:run.model.vision,deadlineAt:meta.stageDeadlineAt,
      files,imagePaths,storage,authorize,signal:controller.signal,browser,onArtifact:file=>archiveEmbeddedArtifact(env.DB,identity,file)});
    const game=policy.purpose==='game';
    // All materials are pinned in the initial context as well as the immutable
    // workspace. A core compaction must not replace the task with a summary.
    const manifest=files.find(f=>f.path==='input/materials.json')!;
    const pinned:EmbeddedMessage[]=[{role:'user',content:[{type:'text',text:manifest.content},...workspace.initialImages]}];
    const system=request.system+'\n\n'+getEmbeddedExecutionPrompt(policy.purpose);
    const stagePrefix=`${meta.phase}-0-`;
    let modelFailure:string|undefined;
    const result=await runEmbeddedQuery({system,messages:pinned,tools:game?workspace.tools:[],model:run.model.model,
      contextWindow:policy.contextWindowTokens,maxOutputTokens:run.model.maxOutputTokens,maxTotalOutputTokens:run.maxTotalOutputTokens-run.outputTokens,
      maxModelTurns:run.maxModelTurns-run.modelTurns,signal:controller.signal},{
      callModel:async call=>{
        await requireTask(env,execution);
        const current=await getHarnessRun(env.DB,identity);need(current?.status==='active'&&current.reservedTokens===0,'内嵌请求已停止或结果未知。');
        const requestId=`${stagePrefix}${crypto.randomUUID()}`;
        await phaseState(env,identity,'running',null);
        await request.onWait?.(call.kind==='compact'?'正在整理工作上下文…':'模型正在制作与核验…');
        const recordDiagnostic=async(diagnostics:unknown,failure:string|null)=>{
          await env.DB.prepare('INSERT OR IGNORE INTO harness_embedded_diagnostics(task_id,generation,request_id,kind,measurements,failure_code) VALUES (?,?,?,?,?,?)')
            .bind(identity.taskId,identity.generation,requestId,call.kind,JSON.stringify(diagnostics),failure).run().catch(()=>{});
        };
        try{
          const answer=await runEmbeddedHarnessModel(call,{run:current,lease:identity.lease,requestId,deadlineAt:identity.stageDeadlineAt,remainingOutputTokens:current.maxTotalOutputTokens-current.outputTokens-current.reservedTokens},
            {DB:env.DB,settingsKey:env.SETTINGS_KEY,loadConfig:()=>configStore(env.DB).get(),authorizeRun:async candidate=>candidate.taskId===identity.taskId&&candidate.generation===identity.generation&&await authorize(),
              expectedModelTurns:current.modelTurns,requestIdPrefix:stagePrefix,...(identity.family==='review'?{reviewPhase:identity.phase as 'review'|'review_verify'}:{}),jsonOutput:call.kind==='main'&&!!request.schema});
          await recordDiagnostic(answer.diagnostics,null);return answer;
        }catch(error){if(error instanceof EmbeddedHarnessModelError){modelFailure=error.code;await recordDiagnostic(error.diagnostics,error.code);}throw error;}
      },
      runTool:async(call,signal)=>{
        signal.throwIfAborted();
        await requireTask(env,execution);await phaseState(env,identity,'running',call.name);
        await request.onWait?.(`正在执行任务工具：${call.name}`);
        const key=[identity.taskId,identity.generation,identity.phase,call.id];
        const inputHash=await harnessHash(canonicalHarness(call.input));
        signal.throwIfAborted();
        const inserted=await env.DB.prepare("INSERT INTO harness_embedded_tools(task_id,generation,phase,call_id,name,input_hash,state,started_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM harness_embedded_phases WHERE task_id=? AND generation=? AND phase=? AND state='running')")
          .bind(...key,call.name,inputHash,'running',Date.now(),identity.taskId,identity.generation,identity.phase).run();
        need(inserted.meta?.changes===1,'内嵌工具阶段已停止。');
        try{
          const value=await workspace!.call({id:call.id,name:call.name,arguments:call.input},signal);
          const recorded=await env.DB.prepare('UPDATE harness_embedded_tools SET result_hash=?,state=?,ended_at=? WHERE task_id=? AND generation=? AND phase=? AND call_id=? AND state=?')
            .bind(await harnessHash(canonicalHarness(value)),value.is_error?'error':'completed',Date.now(),...key,'running').run();
          need(recorded.meta?.changes===1,'内嵌工具结果记录未确认。');
          return {content:value.content,isError:value.is_error};
        }catch(error){
          await env.DB.prepare('UPDATE harness_embedded_tools SET state=?,ended_at=? WHERE task_id=? AND generation=? AND phase=? AND call_id=? AND state=?')
            .bind('interrupted',Date.now(),...key,'running').run().catch(()=>{});
          throw error;
        }
      },
    });
    need(result.reason==='completed',`内嵌核心停止：${modelFailure??result.reason}；已保存文件保留。`);
    const finalRun=await getHarnessRun(env.DB,identity);
    need(finalRun?.status==='active'&&finalRun.reservedTokens===0&&!controller.signal.aborted,'内嵌结果尚未完成账本结算。');
    let text:string;
    if(game){
      const outputs=await workspace.readOutputs();
      text=await harnessResultText({state:'succeeded',files:outputs},policy.purpose);
      for(const file of outputs)await archiveEmbeddedArtifact(env.DB,identity,file);
    }else{
      text=result.finalAssistant?.content.map(block=>block.text).join('')??'';
      need(text.trim(),'内嵌模型未返回完整结果。');
      if(identity.family==='review')need(request.prepareResult,'审核结果必须在持久化前通过原审核校验。');
      if(request.prepareResult)text=request.prepareResult(text);
      await archiveEmbeddedArtifact(env.DB,identity,{path:'result.txt',content:text,sha256:await harnessHash(text)});
    }
    const evidence=await workspace.readBrowserEvidence();
    await workspace.close();
    need(Date.now()<identity.stageDeadlineAt,'内嵌阶段已超时，未发布结果。');
    await execution.onEvidence?.(evidence);
    const outputHash=await harnessHash(text),evidenceHash=await harnessHash(canonicalHarness(evidence)),sealedAt=Date.now();
    need(sealedAt<identity.stageDeadlineAt&&!controller.signal.aborted,'内嵌阶段已超时，未锁定结果。');
    await storeHarnessPrivate(storage,`embedded-result:${identity.phase}`,{materialHash,outputHash,text,evidence,evidenceHash,sealedAt},
      tx=>tx.put(metaKey,{...identity,state:'succeeded',sealedAt}));
    sealed=true;
    await phaseState(env,identity,'succeeded',null,'completed').catch(()=>{});
    return text;
  }catch(error){
    await endHarnessRun(env.DB,identity,'failed','runtime_failed').catch(()=>{});
    await storage.put(metaKey,{...identity,state:'failed'}).catch(()=>{});
    await phaseState(env,identity,'failed',null,error instanceof EmbeddedHarnessModelError?error.code:'runtime_failed').catch(()=>{});
    throw error;
  }finally{
    clearTimeout(timer);controller.abort();
    // The successful path already closed its browser before sealing. A later
    // telemetry read must not turn a durable successful result into a failure.
    if(!sealed){
      if(workspace)await workspace.close();else await browser.close();
      await env.DB.prepare("UPDATE harness_embedded_tools SET state='interrupted',ended_at=? WHERE task_id=? AND generation=? AND phase=? AND state='running'")
        .bind(Date.now(),identity.taskId,identity.generation,identity.phase).run();
      const state=await getHarnessRun(env.DB,identity);
      if(state&&state.status!=='active')await releaseHarnessSlot(env.DB,identity);
    }
  }
}

export async function finishEmbeddedTask(env:Environment,id:string,outcome:'completed'|'failed'){
  const storage=env.harnessStorage;
  if(!storage){
    // Public cancellation only schedules the original runner. It cannot
    // release a slot before that runner has closed its own browser.
    if(outcome==='failed'){
      const row=await env.DB.prepare('SELECT family FROM harness_runs WHERE task_id=?').bind(id).first();
      const binding=row?.family==='forge'?env.FORGE_RUNNER:row?.family==='review'?env.REVIEW_RUNNER:undefined;
      if(binding)await binding.get(binding.idFromName(id)).fetch(new Request('https://internal/run',{method:'POST',body:id}));
    }
    throw new Error('内嵌清理等待原任务执行器确认。');
  }
  await closeEmbeddedCapture(env,storage);
  const meta=await storage.get(metaKey) as NativeMeta|undefined;
  if(!meta){
    const row=await env.DB.prepare('SELECT generation,snapshot,status,released_at FROM harness_runs WHERE task_id=?').bind(id).first();
    if(!row)return;
    need(JSON.parse(row.snapshot)?.engine==='ccb-embedded','内嵌清理不能处理其他执行内核。');
    const journal=await storage.get('embedded-harness-allocation');
    need(!journal||journal.taskId===id&&journal.generation===row.generation,'内嵌分配记录不匹配。');
    if(row.status!=='active'&&row.released_at!=null)return;
    const phase=await env.DB.prepare('SELECT 1 FROM harness_embedded_phases WHERE task_id=? AND generation=? LIMIT 1').bind(id,row.generation).first();
    need(!phase&&outcome==='failed','内嵌浏览器恢复资料缺失；执行名额保留等待清理核验。');
    // No phase can begin without both meta and a phase row; no browser/model
    // operation was possible for this abandoned allocation.
    const identity={taskId:id,generation:row.generation};
    await endHarnessRun(env.DB,identity,'failed','interrupted');
    await releaseHarnessSlot(env.DB,identity);return;
  }
  need(meta.taskId===id,'内嵌清理任务不匹配。');
  await new HarnessTools(env as any,storage).close();
  if(outcome==='completed')need(meta.state==='succeeded'||meta.state==='completed','内嵌最终结果尚未锁定。');
  if(outcome==='completed')need(meta.policy.purpose==='game'?['polish','repair','repair2'].includes(meta.phase):meta.family==='review'?meta.phase==='review_verify':true,'内嵌任务最终阶段尚未完成。');
  need(await endHarnessRun(env.DB,meta,outcome==='completed'?'done':'failed','interrupted',Date.now(),outcome==='completed'?meta.sealedAt:Date.now()),'内嵌终态未完成结算。');
  await releaseHarnessSlot(env.DB,meta);
  await storage.put(metaKey,{...meta,state:outcome==='completed'?'completed':'failed',lease:''});
}
