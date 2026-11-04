import {canonicalJson,digest} from './review-device-state';

type TaskStatus='queued'|'running'|'done'|'error';
type Link={workId:string;versionId:string;linkedAt:string;scopeRevision:number};
export interface NaturalObservationTask {
  jobId:string;ownerId:string;createdAt:string;status:TaskStatus;updatedAt:string;
  executor:string|null;mode:string|null;inputHash:string|null;startedAt:string|null;finishedAt:string|null;
  outcome:'done'|'error'|null;model:string|null;effort:string|null;configHash:string|null;configurationOrigin:string|null;
  reportId:string|number|null;reportCreatedAt:string|null;reportHash:string|null;report:unknown;
  reportHashBasis:'stored-result-utf8';reportParseError:boolean;evidenceHash:string|null;link:Link|null;
}
interface Snapshot {
  schemaVersion:1;kind:'natural-review-snapshot';since:string;capturedAt:string;
  complete:boolean;totalObserved:number;truncated:boolean;tasks:NaturalObservationTask[];
}
interface History {snapshotDigest:string;observedAt:string;task:NaturalObservationTask}
interface Conflict {code:string;baselineSnapshotDigest:string;observedSnapshotDigest:string;observedAt:string}
interface Entry {
  jobId:string;firstObservedAt:string;lastObservedAt:string;history:History[];latest:NaturalObservationTask;
  missingFromLatest:boolean;integrityConflict:boolean;integrityConflicts:Conflict[];
}
interface Observation {
  snapshotDigest:string;capturedAt:string;since:string;complete:boolean;totalObserved:number;truncated:boolean;
  observedTaskCount:number;counts:Record<TaskStatus,number>;
}
export interface NaturalReviewLedger {
  schemaVersion:1;kind:'natural-review-ledger';policySha256:string;policyFrozenAt:string;
  observations:Observation[];tasks:Entry[];summary:ReturnType<typeof summarize>;
  accuracy:null;status:'collecting_not_evaluated';boundaries:typeof boundaries;
}
const boundaries={
  privateObservationsOnly:true,randomBlindTest:false,localHashAuthenticatesSource:false,
  greyMemberEligibilityVerified:false,automaticEvaluationEnrollment:false,automaticScoring:false,
  reportHashBasis:'stored-result-utf8; retained source assertion, original bytes not independently available',
  linkChangesMayReflectNormalAuthorizationOrSourceUpdates:true,
  missingFromLatestMeansAbsentFromSnapshotNotProvenDeletion:true,
  capturedAtIsCreationWindowUpperBoundNotAtomicHistoryTime:true,
  taskUpdatesMayBeLaterThanCreationWindowUpperBound:true,
} as const;
const statuses:TaskStatus[]=['queued','running','done','error'];
const taskKeys=['jobId','ownerId','createdAt','status','updatedAt','executor','mode','inputHash','startedAt','finishedAt','outcome','model','effort','configHash','configurationOrigin','reportId','reportCreatedAt','reportHash','report','reportHashBasis','reportParseError','evidenceHash','link'];
const isObject=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:any,max=200)=>typeof v==='string'&&v.length>0&&v.length<=max;
const nullableText=(v:any,max=200)=>v===null||text(v,max);
const compareText=(a:string,b:string)=>a<b?-1:a>b?1:0;
const compareTasks=(a:NaturalObservationTask,b:NaturalObservationTask)=>compareText(a.createdAt,b.createdAt)||compareText(a.jobId,b.jobId);
const sha=(v:any)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function invalid(reason:string):never{throw new Error(`自然投稿观察无效：${reason}`);}
function exactKeys(v:any,keys:string[]){if(!isObject(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))invalid('字段不完整或含未知字段。');}
function iso(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))invalid('时间必须是有效 ISO 时间。');
  const [year,month,day,hour,minute,second]=value.slice(0,19).split(/[-T:]/).map(Number);
  const local=new Date(0);local.setUTCFullYear(year,month-1,day);local.setUTCHours(hour,minute,second,0);
  if(local.getUTCFullYear()!==year||local.getUTCMonth()!==month-1||local.getUTCDate()!==day||hour>23||minute>59||second>59)invalid('时间包含无效日历日期。');
  return new Date(value).toISOString();
}
function jsonValue(v:any,seen=new Set<any>()){
  if(v===null||typeof v==='string'||typeof v==='boolean')return;
  if(typeof v==='number'&&Number.isFinite(v))return;
  if(typeof v!=='object'||seen.has(v)||(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null))invalid('报告必须保留为 JSON 数据。');
  seen.add(v);for(const item of Object.values(v))jsonValue(item,seen);seen.delete(v);
}
function task(value:any,since:string,capturedAt:string):NaturalObservationTask {
  exactKeys(value,taskKeys);
  if(!text(value.jobId)||!text(value.ownerId)||!statuses.includes(value.status)||!['done','error',null].includes(value.outcome))invalid('任务身份或状态不正确。');
  for(const key of ['executor','mode','inputHash','model','effort','configHash','configurationOrigin','reportHash','evidenceHash'])if(!nullableText(value[key]))invalid(`任务 ${key} 格式不正确。`);
  if(value.reportId!==null&&!text(value.reportId)&&!(Number.isSafeInteger(value.reportId)&&value.reportId>=0))invalid('报告编号格式不正确。');
  if(value.reportHashBasis!=='stored-result-utf8'||typeof value.reportParseError!=='boolean'||value.reportParseError&&value.report!==null)invalid('报告来源或解析状态不正确。');
  jsonValue(value.report);
  const result=structuredClone(value) as NaturalObservationTask;
  result.createdAt=iso(value.createdAt);result.updatedAt=iso(value.updatedAt);
  if(result.createdAt<since||result.createdAt>=capturedAt||result.updatedAt<result.createdAt)invalid('任务不在固定观察窗口内，或更新时间倒序。');
  for(const key of ['startedAt','finishedAt','reportCreatedAt'] as const){result[key]=value[key]===null?null:iso(value[key]);if(result[key]!==null&&result[key]!<result.createdAt)invalid('任务阶段时间早于创建。');}
  if(result.startedAt&&result.finishedAt&&result.finishedAt<result.startedAt)invalid('任务结束早于开始。');
  if(value.outcome!==null&&value.outcome!==value.status)invalid('任务结果与当前状态冲突。');
  if(value.link!==null){
    exactKeys(value.link,['workId','versionId','linkedAt','scopeRevision']);
    if(!text(value.link.workId)||!text(value.link.versionId)||!Number.isSafeInteger(value.link.scopeRevision)||value.link.scopeRevision<0)invalid('准确版本关联格式不正确。');
    result.link={...value.link,linkedAt:iso(value.link.linkedAt)};
    if(result.link!.linkedAt<result.createdAt)invalid('版本关联时间早于创建。');
  }
  return result;
}
function snapshot(value:any,since:string):Snapshot {
  exactKeys(value,['schemaVersion','kind','since','capturedAt','complete','totalObserved','truncated','tasks']);
  if(value.schemaVersion!==1||value.kind!=='natural-review-snapshot'||iso(value.since)!==since)invalid('快照窗口必须与已固定口径完全一致。');
  const capturedAt=iso(value.capturedAt);
  if(capturedAt<since||typeof value.complete!=='boolean'||typeof value.truncated!=='boolean'||!Number.isSafeInteger(value.totalObserved)||!Array.isArray(value.tasks)||value.tasks.length>10000||value.totalObserved<value.tasks.length)invalid('快照时间、完整性或总数不正确。');
  if(value.complete&&(value.truncated||value.totalObserved!==value.tasks.length)||value.truncated&&value.complete)invalid('不完整快照不能声明完整覆盖。');
  const tasks=value.tasks.map((v:any)=>task(v,since,capturedAt)),ids=new Set<string>();
  for(const item of tasks){if(ids.has(item.jobId))invalid('同一快照不能重复任务编号。');ids.add(item.jobId);}
  // A stable source order prevents array reordering from manufacturing an observation.
  for(let i=1;i<tasks.length;i++)if(tasks[i-1].createdAt>tasks[i].createdAt||tasks[i-1].createdAt===tasks[i].createdAt&&tasks[i-1].jobId>tasks[i].jobId)invalid('快照任务必须按 createdAt、jobId 升序。');
  return {schemaVersion:1,kind:'natural-review-snapshot',since,capturedAt,complete:value.complete,totalObserved:value.totalObserved,truncated:value.truncated,tasks};
}
const counts=(tasks:NaturalObservationTask[])=>Object.fromEntries(statuses.map(s=>[s,tasks.filter(t=>t.status===s).length])) as Record<TaskStatus,number>;
function conflicts(history:History[]):Conflict[]{
  const result:Conflict[]=[];
  for(let i=1;i<history.length;i++){
    const current=history[i],first=history[0],prior=history[i-1];
    const add=(code:string,baseline:History)=>result.push({code,baselineSnapshotDigest:baseline.snapshotDigest,observedSnapshotDigest:current.snapshotDigest,observedAt:current.observedAt});
    for(const key of ['ownerId','createdAt'] as const)if(current.task[key]!==first.task[key])add(`${key}_changed`,first);
    const input=history.slice(0,i).find(h=>h.task.inputHash!==null);if(input&&current.task.inputHash!==input.task.inputHash)add('input_hash_changed_or_unavailable',input);
    if(current.task.updatedAt<prior.task.updatedAt)add('task_update_time_regressed',prior);
    const terminal=history.slice(0,i).find(h=>['done','error'].includes(h.task.status));
    if(terminal){
      if(current.task.status!==terminal.task.status)add('terminal_status_changed',terminal);
      for(const key of ['reportHash','reportId','reportHashBasis','reportCreatedAt'] as const)if(current.task[key]!==terminal.task[key])add(`${key}_changed_after_terminal`,terminal);
      if(canonicalJson(current.task.report)!==canonicalJson(terminal.task.report)||current.task.reportParseError!==terminal.task.reportParseError)add('report_payload_changed_after_terminal',terminal);
      for(const key of ['model','effort','configHash','configurationOrigin','evidenceHash'] as const)if(current.task[key]!==terminal.task[key])add(`${key}_changed_after_terminal`,terminal);
    }
    const linked=history.slice(0,i).find(h=>h.task.link!==null);
    if(linked){
      const old=linked.task.link!,link=current.task.link;
      if(!link)add('link_unavailable',linked);
      else{
        if(link.workId!==old.workId||link.versionId!==old.versionId)add('link_identity_changed',linked);
        if(link.scopeRevision!==old.scopeRevision)add('link_scope_changed',linked);
        if(link.linkedAt!==old.linkedAt)add('link_observation_time_changed',linked);
      }
    }
  }
  return result;
}
function entries(histories:Map<string,History[]>,latestIds:Set<string>):Entry[]{
  return [...histories].map(([jobId,history])=>{const integrityConflicts=conflicts(history);return {jobId,firstObservedAt:history[0].observedAt,lastObservedAt:history.at(-1)!.observedAt,history,latest:structuredClone(history.at(-1)!.task),missingFromLatest:!latestIds.has(jobId),integrityConflict:integrityConflicts.length>0,integrityConflicts};}).sort((a,b)=>compareTasks(a.latest,b.latest));
}
function summarize(tasks:Entry[],observations:Observation[]){
  const latest=observations.at(-1)!;
  return {
    totalCandidates:tasks.length,byStatus:counts(tasks.map(t=>t.latest)),linked:tasks.filter(t=>t.latest.link!==null).length,
    missingConfiguration:tasks.filter(({latest:t})=>!t.model||!t.effort||!sha(t.configHash)||!t.configurationOrigin).length,
    missingTiming:tasks.filter(({latest:t})=>!t.startedAt||!t.finishedAt).length,
    missingReport:tasks.filter(({latest:t})=>t.reportId===null||!sha(t.reportHash)||t.report===null||t.reportParseError).length,
    missingInputHash:tasks.filter(({latest:t})=>!sha(t.inputHash)).length,
    failed:tasks.filter(t=>t.latest.status==='error').length,missingFromLatest:tasks.filter(t=>t.missingFromLatest).length,
    integrityConflictTasks:tasks.filter(t=>t.integrityConflict).length,
    latestSnapshotComplete:latest.complete,latestSnapshotTruncated:latest.truncated,latestSourceDeclaredTotal:latest.totalObserved,
    latestSnapshotObservedTasks:latest.observedTaskCount,latestDeclaredButNotExported:latest.totalObserved-latest.observedTaskCount,
    maximumSourceDeclaredTotal:Math.max(...observations.map(o=>o.totalObserved)),
    minimumCandidateDenominator:Math.max(tasks.length,...observations.map(o=>o.totalObserved)),
    everIncomplete:observations.some(o=>!o.complete||o.truncated),
    automaticallyEligibleForEvaluation:0,successfulEvaluations:0,
  };
}
async function readPrevious(value:any,policySha256:string,since:string){
  exactKeys(value,['schemaVersion','kind','policySha256','policyFrozenAt','observations','tasks','summary','accuracy','status','boundaries']);
  if(!isObject(value)||value.schemaVersion!==1||value.kind!=='natural-review-ledger'||value.policySha256!==policySha256||iso(value.policyFrozenAt)!==since||value.accuracy!==null||value.status!=='collecting_not_evaluated'||!Array.isArray(value.observations)||!value.observations.length||!Array.isArray(value.tasks))invalid('上一账本与口径不匹配或结构不完整。');
  const histories=new Map<string,History[]>(),observations:Observation[]=[],digests=new Set<string>();
  for(const entry of value.tasks){
    exactKeys(entry,['jobId','firstObservedAt','lastObservedAt','history','latest','missingFromLatest','integrityConflict','integrityConflicts']);
    if(!isObject(entry)||!text(entry.jobId)||histories.has(entry.jobId)||!Array.isArray(entry.history)||!entry.history.length)invalid('上一账本任务历史不完整。');
    histories.set(entry.jobId,entry.history.map((h:any)=>{
      exactKeys(h,['snapshotDigest','observedAt','task']);
      if(!isObject(h)||!sha(h.snapshotDigest)||h.task?.jobId!==entry.jobId)invalid('上一账本历史身份不正确。');
      return {snapshotDigest:h.snapshotDigest,observedAt:iso(h.observedAt),task:h.task} as History;
    }));
  }
  for(const old of value.observations){
    exactKeys(old,['snapshotDigest','capturedAt','since','complete','totalObserved','truncated','observedTaskCount','counts']);
    if(!isObject(old)||!sha(old.snapshotDigest)||digests.has(old.snapshotDigest))invalid('上一账本快照摘要重复或缺失。');
    const capturedAt=iso(old.capturedAt);if(observations.length&&capturedAt<observations.at(-1)!.capturedAt)invalid('上一账本快照倒序。');
    const tasks:NaturalObservationTask[]=[];
    for(const history of histories.values())for(const h of history)if(h.snapshotDigest===old.snapshotDigest){if(h.observedAt!==capturedAt)invalid('历史观察时间与快照不一致。');tasks.push(h.task);}
    tasks.sort(compareTasks);
    const original=snapshot({schemaVersion:1,kind:'natural-review-snapshot',since:old.since,capturedAt,complete:old.complete,totalObserved:old.totalObserved,truncated:old.truncated,tasks},since);
    if(old.observedTaskCount!==tasks.length||canonicalJson(old.counts)!==canonicalJson(counts(tasks))||await digest(canonicalJson(original))!==old.snapshotDigest)invalid('上一账本快照、历史或分母校验失败。');
    observations.push({...old,capturedAt,since});digests.add(old.snapshotDigest);
  }
  const order=new Map(observations.map((o,i)=>[o.snapshotDigest,i]));
  for(const [jobId,history] of histories){
    for(let i=0;i<history.length;i++)if(!order.has(history[i].snapshotDigest)||i&&order.get(history[i-1].snapshotDigest)!>=order.get(history[i].snapshotDigest)!)invalid('上一账本任务历史倒序或重复。');
    const entry=value.tasks.find((t:any)=>t.jobId===jobId);
    if(entry.firstObservedAt!==history[0].observedAt||entry.lastObservedAt!==history.at(-1)!.observedAt||canonicalJson(entry.latest)!==canonicalJson(history.at(-1)!.task))invalid('上一账本最新任务与原始历史不一致。');
  }
  return {histories,observations};
}
/** Private continuous observation, never an enrollment, source authentication or accuracy verdict. */
export async function mergeNaturalReviewObservations(policySha256:string,policyFrozenAt:string,input:unknown,previousLedger?:unknown):Promise<NaturalReviewLedger>{
  if(!sha(policySha256))invalid('口径原始字节 SHA-256 不正确。');
  const since=iso(policyFrozenAt),current=snapshot(input,since),snapshotDigest=await digest(canonicalJson(current));
  const previous=previousLedger===undefined?{histories:new Map<string,History[]>(),observations:[] as Observation[]}:await readPrevious(previousLedger,policySha256,since);
  const {histories,observations}=previous;
  if(observations.length&&current.capturedAt<observations.at(-1)!.capturedAt)invalid('不能追加倒序快照。');
  const duplicate=observations.some(o=>o.snapshotDigest===snapshotDigest);
  if(!duplicate){
    observations.push({snapshotDigest,capturedAt:current.capturedAt,since,complete:current.complete,totalObserved:current.totalObserved,truncated:current.truncated,observedTaskCount:current.tasks.length,counts:counts(current.tasks)});
    for(const t of current.tasks){const history=histories.get(t.jobId)||[];history.push({snapshotDigest,observedAt:current.capturedAt,task:structuredClone(t)});histories.set(t.jobId,history);}
  }
  const tasks=entries(histories,new Set(current.tasks.map(t=>t.jobId)));
  return {schemaVersion:1,kind:'natural-review-ledger',policySha256,policyFrozenAt:since,observations,tasks,summary:summarize(tasks,observations),accuracy:null,status:'collecting_not_evaluated',boundaries:structuredClone(boundaries)};
}
