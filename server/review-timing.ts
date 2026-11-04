/** Metadata only: never collect source, credentials, prompts or model reasoning. */
export const REVIEW_TIMING_PHASES = ['browser_start','capture','load','observe','screenshot','evidence_upload','material','initial','verification','persist','actual_play','tool_wait','capacity_wait','throttle_wait','retry_wait','model_request'] as const;
export type ReviewTimingPhase = typeof REVIEW_TIMING_PHASES[number];
export type ReviewTimingEvent = {jobId:string;eventId:string;phase:ReviewTimingPhase;origin:'server'|'member-device';startedAt:string;durationMs:number;status:'ok'|'error'};
const id = (v:unknown):v is string => typeof v==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(v);
const validTime = (v:unknown):v is string => typeof v==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v));
const validEvent = (v:any) => v && id(v.eventId) && REVIEW_TIMING_PHASES.includes(v.phase) && validTime(v.startedAt) && Number.isSafeInteger(v.durationMs) && v.durationMs>=0 && v.durationMs<=86400000 && ['ok','error'].includes(v.status);

/** The device cannot claim server-observed timings or another job's identity. */
export function validateMemberTiming(value:unknown):Omit<ReviewTimingEvent,'jobId'>[] {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>32)throw new Error('计时记录格式不正确。');
  const seen=new Set<string>();
  return value.map(v=>{
    if(!validEvent(v)||Object.keys(v).some(k=>!['eventId','phase','startedAt','durationMs','status'].includes(k))||seen.has(v.eventId))throw new Error('计时记录格式不正确。');
    seen.add(v.eventId);
    return {eventId:v.eventId,phase:v.phase,origin:'member-device',startedAt:v.startedAt,durationMs:v.durationMs,status:v.status};
  });
}

/** Best-effort telemetry must never cause a paid stage or published result to replay. */
export async function recordReviewTiming(DB:any,event:ReviewTimingEvent):Promise<boolean> {
  if(!DB||!id(event.jobId)||!validEvent(event)||!['server','member-device'].includes(event.origin))return false;
  try {
    await DB.prepare(`INSERT OR IGNORE INTO review_timing_events(job_id,event_id,phase,origin,started_at,duration_ms,status,received_at)
      SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM review_jobs WHERE id=?)`)
      .bind(event.jobId,event.eventId,event.phase,event.origin,event.startedAt,event.durationMs,event.status,new Date().toISOString(),event.jobId).run();
    const saved=await DB.prepare('SELECT phase,origin,started_at,duration_ms,status FROM review_timing_events WHERE job_id=? AND event_id=?').bind(event.jobId,event.eventId).first();
    return !!saved&&saved.phase===event.phase&&saved.origin===event.origin&&saved.started_at===event.startedAt&&saved.duration_ms===event.durationMs&&saved.status===event.status;
  } catch { return false; }
}

/** These anchors are server observed. A later retry never moves the start forward. */
export async function markReviewExecution(DB:any,jobId:string,phase:'started'|'done'|'error',now=new Date().toISOString()):Promise<boolean> {
  if(!DB||!id(jobId)||!validTime(now))return false;
  try {
    if(phase==='started')await DB.prepare(`INSERT OR IGNORE INTO review_execution_timing(job_id,started_at,created_at)
      SELECT id,?,? FROM review_jobs WHERE id=? AND status='running'`).bind(now,now,jobId).run();
    else if(phase==='done'||phase==='error')await DB.prepare(`UPDATE review_execution_timing SET finished_at=?,outcome=? WHERE job_id=? AND finished_at IS NULL AND started_at<=?
      AND EXISTS(SELECT 1 FROM review_jobs WHERE id=? AND status=?)`).bind(now,phase,jobId,now,jobId,phase).run();
    else return false;
    const row=await DB.prepare('SELECT started_at,finished_at,outcome FROM review_execution_timing WHERE job_id=?').bind(jobId).first();
    return !!row&&(phase==='started'||row.outcome===phase);
  } catch {return false;}
}

export async function hashReviewConfiguration(value:Record<string,unknown>):Promise<string> {
  const allowed=['model','protocol','effort','vision','maxOutputTokens','profileId','updatedAt','rulesId'];
  if(Object.keys(value).some(k=>!allowed.includes(k)))throw new Error('审核配置摘要只能包含非敏感白名单字段。');
  const json=JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function recordReviewConfiguration(DB:any,jobId:string,value:{model:string;effort:string;configHash:string;origin:'server'|'member-device'}):Promise<boolean> {
  if(!DB||!id(jobId)||typeof value.model!=='string'||!value.model.trim()||value.model.length>200||typeof value.effort!=='string'||value.effort.length>30||!/^[a-f0-9]{64}$/.test(value.configHash)||!['server','member-device'].includes(value.origin))return false;
  try {
    await DB.prepare('UPDATE review_execution_timing SET model_name=?,effort=?,config_hash=?,config_origin=? WHERE job_id=? AND config_hash IS NULL').bind(value.model,value.effort,value.configHash,value.origin,jobId).run();
    const row=await DB.prepare('SELECT config_hash,model_name,effort,config_origin FROM review_execution_timing WHERE job_id=?').bind(jobId).first();
    return !!row&&row.config_hash===value.configHash&&row.model_name===value.model&&row.effort===value.effort&&row.config_origin===value.origin;
  } catch{return false;}
}

export async function recordReviewBoundary(DB:any,jobId:string,phase:'material_ready'|'draft_received'|'verification_ready'|'completed',now=new Date().toISOString()):Promise<boolean> {
  if(!DB||!id(jobId)||!validTime(now)||!['material_ready','draft_received','verification_ready','completed'].includes(phase))return false;
  try {
    // Device-reported timings can never create or modify these server observations.
    await DB.prepare(`INSERT OR IGNORE INTO review_timing_boundaries(job_id,phase,occurred_at)
      SELECT id,?,? FROM review_jobs WHERE id=? AND model_executor='agent' AND status IN ('running','done')`).bind(phase,now,jobId).run();
    const ends=phase==='draft_received'?['material_ready','initial']:phase==='completed'?['verification_ready','verification']:null;
    if(ends){
      const start=await DB.prepare('SELECT occurred_at FROM review_timing_boundaries WHERE job_id=? AND phase=?').bind(jobId,ends[0]).first();
      const end=await DB.prepare('SELECT occurred_at FROM review_timing_boundaries WHERE job_id=? AND phase=?').bind(jobId,phase).first();
      if(start&&end){const duration=Date.parse(end.occurred_at)-Date.parse(start.occurred_at);if(duration>=0)await recordReviewTiming(DB,{jobId,eventId:`device-wall:${ends[1]}`,phase:ends[1] as ReviewTimingPhase,origin:'server',startedAt:start.occurred_at,durationMs:duration,status:'ok'});}
    }
    return true;
  }catch{return false;}
}

export interface LatencyObservation {jobId:string;executor:string;mode:string;model?:string|null;configHash?:string|null;effort?:string|null;status:string;createdAt:string;startedAt:string|null;finishedAt:string|null;outcome?:string|null}
const percentile=(values:number[],q:number)=>values.length?values.slice().sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*q)-1)]:null;
export function summarizeReviewLatency(records:LatencyObservation[],now=Date.now()) {
  const groups=new Map<string,LatencyObservation[]>();
  for(const r of records){const key=JSON.stringify([r.executor,r.mode,r.model||null,r.effort||null,r.configHash||null]);groups.set(key,[...(groups.get(key)||[]),r]);}
  return [...groups.entries()].map(([key,rows])=>{
    const [executor,mode,model,effort,configHash]=JSON.parse(key);const targetMs=mode==='enhanced'?300000:180000;
    const started=rows.filter(r=>r.startedAt&&Number.isFinite(Date.parse(r.startedAt)));
    const completed=started.filter(r=>r.status==='done'&&r.outcome==='done'&&r.finishedAt&&Date.parse(r.finishedAt)>=Date.parse(r.startedAt!));
    const durations=completed.map(r=>Date.parse(r.finishedAt!)-Date.parse(r.startedAt!));
    const pendingWithinTarget=started.filter(r=>!['done','error'].includes(r.status)&&now-Date.parse(r.startedAt!)<=targetMs).length;
    const failed=started.filter(r=>r.status==='error').length;
    const unresolved=started.length-completed.length-failed;
    const onTime=durations.filter(n=>n<=targetMs).length;
    const onTimeRate=started.length?onTime/started.length:null;
    // Incomplete/failing runs are never silently removed to make a percentile pass.
    const allRunP90Rank=Math.ceil(started.length*.9);
    const allRunP90=allRunP90Rank&&allRunP90Rank<=durations.length?durations.slice().sort((a,b)=>a-b)[allRunP90Rank-1]:null;
    const missingRequiredAnchor=rows.some(r=>r.status!=='queued'&&(!r.startedAt||!Number.isFinite(Date.parse(r.startedAt))));
    const configurationRecorded=typeof model==='string'&&!!model.trim()&&typeof effort==='string'&&!!effort.trim()&&typeof configHash==='string'&&/^[a-f0-9]{64}$/.test(configHash);
    return {executor,mode,model,effort,configHash,configurationRecorded,targetMs,total:rows.length,started:started.length,missingStart:rows.length-started.length,completed:completed.length,failed,unresolved,pendingWithinTarget,
      onTime,onTimeRate,requiredOnTimeRate:.9,minimumStartedForPilot:30,
      gate:missingRequiredAnchor?'incomplete_telemetry':!configurationRecorded?'configuration_unknown':started.length<30?'insufficient_sample':pendingWithinTarget?'pending':onTimeRate!==null&&onTimeRate>=.9?'passed':'not_met',
      completedOnly:{p50Ms:percentile(durations,.5),p90Ms:percentile(durations,.9),p95Ms:percentile(durations,.95)},
      allStartedP90Ms:allRunP90,allStartedP90Unbounded:started.length>0&&allRunP90===null,
      queueMs:started.map(r=>({jobId:r.jobId,value:Number.isFinite(Date.parse(r.createdAt))?Math.max(0,Date.parse(r.startedAt!)-Date.parse(r.createdAt)):null})),
      interpretation:'Server-observed execution wall time, not pure model latency. Failures and unfinished runs remain in the on-time denominator; completed-only percentiles are descriptive.'};
  });
}
