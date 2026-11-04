import {digest} from './review-device-state';

export interface NaturalReviewTask {
  jobId:string; ownerId:string; createdAt:string; status:string; updatedAt:string;
  executor:string|null; mode:string|null; inputHash:string|null;
  startedAt:string|null; finishedAt:string|null; outcome:string|null;
  model:string|null; effort:string|null; configHash:string|null; configurationOrigin:string|null;
  reportId:number|null; reportCreatedAt:string|null; reportHash:string|null;
  reportHashBasis:'stored-result-utf8'; report:unknown; reportParseError:boolean;
  evidenceHash:string|null;
  link:{workId:string;versionId:string;linkedAt:string;scopeRevision:number}|null;
}
export interface NaturalReviewSnapshot {
  schemaVersion:1; kind:'natural-review-snapshot'; since:string; capturedAt:string;
  complete:boolean; totalObserved:number; truncated:boolean; tasks:NaturalReviewTask[];
}

// Accept only actual UTC ISO dates, rejecting Date.parse's calendar rollover
// (for example February 30) and normalizing optional milliseconds for SQL order.
function isoBoundary(value:unknown):string {
  if(typeof value!=='string')throw new Error('观察窗口必须使用有效 UTC ISO 时间。');
  const match=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  if(!match)throw new Error('观察窗口必须使用有效 UTC ISO 时间。');
  const normalized=`${match[1]}.${(match[2]||'').padEnd(3,'0')}Z`,milliseconds=Date.parse(normalized);
  if(!Number.isFinite(milliseconds)||new Date(milliseconds).toISOString()!==normalized)throw new Error('观察窗口必须使用有效 UTC ISO 时间。');
  return normalized;
}

/** Local controlled observation only: enumerate tasks, never judge eligibility or score.
 * At most 10000 tasks are returned; totalObserved counts the full SQL window. */
export async function readNaturalReviewSnapshot(DB:any,since:string,now=new Date().toISOString()):Promise<NaturalReviewSnapshot>{
  const lower=isoBoundary(since),upper=isoBoundary(now);
  if(lower>upper)throw new Error('观察起点不能晚于快照时间。');
  // All joins have a unique task key. The window count and rows share one SQL
  // observation; neither reports, visibility nor source linkage filter tasks.
  const response=await DB.prepare(`SELECT COUNT(*) OVER() AS observedTotal,
    j.id AS jobId,j.owner_id AS ownerId,j.created_at AS createdAt,j.status,j.updated_at AS updatedAt,
    j.model_executor AS executor,j.review_mode AS mode,j.input_hash AS inputHash,
    t.started_at AS startedAt,t.finished_at AS finishedAt,t.outcome,
    COALESCE(t.model_name,j.local_model,NULLIF(r.model,'')) AS model,t.effort,t.config_hash AS configHash,t.config_origin AS configurationOrigin,
    r.id AS reportId,r.created_at AS reportCreatedAt,r.result AS storedResult,
    COALESCE(j.evidence_hash,r.evidence_hash) AS evidenceHash,
    l.game_id AS linkedWorkId,l.version_id AS linkedVersionId,l.created_at AS linkedAt,l.scope_revision AS scopeRevision
    FROM review_jobs j LEFT JOIN review_execution_timing t ON t.job_id=j.id
    LEFT JOIN reviews r ON r.job_id=j.id LEFT JOIN creator_feedback_links l ON l.task_id=j.id
    WHERE j.created_at>=? AND j.created_at<? ORDER BY j.created_at ASC,j.id ASC LIMIT 10001`).bind(lower,upper).all();
  const rows=response.results||[],totalObserved=rows.length?Number(rows[0].observedTotal):0;
  if(!Number.isSafeInteger(totalObserved)||totalObserved<rows.length)throw new Error('观察任务计数不完整。');
  const tasks:NaturalReviewTask[]=[];
  for(const row of rows.slice(0,10000)){
    let report:unknown=null,reportParseError=false,reportHash:string|null=null;
    if(row.storedResult!==null&&row.storedResult!==undefined){
      // Hash the exact stored UTF-8 string, including whitespace/key order.
      reportHash=await digest(row.storedResult);
      try{report=JSON.parse(row.storedResult);}catch{reportParseError=true;}
    }
    tasks.push({jobId:row.jobId,ownerId:row.ownerId,createdAt:row.createdAt,status:row.status,updatedAt:row.updatedAt,
      executor:row.executor??null,mode:row.mode??null,inputHash:row.inputHash??null,
      startedAt:row.startedAt??null,finishedAt:row.finishedAt??null,outcome:row.outcome??null,
      model:row.model??null,effort:row.effort??null,configHash:row.configHash??null,configurationOrigin:row.configurationOrigin??null,
      reportId:row.reportId??null,reportCreatedAt:row.reportCreatedAt??null,reportHash,reportHashBasis:'stored-result-utf8',report,reportParseError,
      evidenceHash:row.evidenceHash??null,
      link:row.linkedWorkId===null||row.linkedWorkId===undefined?null:{workId:row.linkedWorkId,versionId:row.linkedVersionId,linkedAt:row.linkedAt,scopeRevision:row.scopeRevision}});
  }
  const truncated=totalObserved>tasks.length;
  return {schemaVersion:1,kind:'natural-review-snapshot',since,capturedAt:now,complete:!truncated,totalObserved,truncated,tasks};
}
