import {summarizeReviewLatency,type LatencyObservation} from './review-timing';

/** Called only after adminApi's Cookie/Authorization/Origin checks. */
export async function reviewMetrics(DB:any,params:URLSearchParams,now=Date.now()) {
  const days=Number(params.get('days')||'7');
  if(!Number.isInteger(days)||days<1||days>90)throw new Error('统计范围应为 1–90 天。');
  const start=new Date(now-days*86400000).toISOString();
  const rows=await DB.prepare(`SELECT j.id AS jobId,j.model_executor AS executor,COALESCE(j.review_mode,'basic') AS mode,
    COALESCE(t.model_name,j.local_model,r.model) AS model,t.effort,t.config_hash AS configHash,j.status,j.created_at AS createdAt,t.started_at AS startedAt,t.finished_at AS finishedAt,t.outcome
    FROM review_jobs j LEFT JOIN review_execution_timing t ON t.job_id=j.id LEFT JOIN reviews r ON r.id=j.result_id
    WHERE j.created_at>=? ORDER BY j.created_at DESC,j.id DESC LIMIT 10001`).bind(start).all();
  const records=(rows.results||[]).slice(0,10000) as LatencyObservation[];
  const spans=await DB.prepare(`SELECT e.phase,e.origin,j.model_executor AS executor,COALESCE(j.review_mode,'basic') AS mode,
    COALESCE(t.model_name,j.local_model,r.model) AS model,t.effort,t.config_hash AS configHash,
    COUNT(*) AS samples,AVG(e.duration_ms) AS averageMs,MAX(e.duration_ms) AS maxMs
    FROM review_timing_events e JOIN review_jobs j ON j.id=e.job_id
    LEFT JOIN review_execution_timing t ON t.job_id=j.id LEFT JOIN reviews r ON r.id=j.result_id
    WHERE e.received_at>=? GROUP BY e.phase,e.origin,j.model_executor,COALESCE(j.review_mode,'basic'),COALESCE(t.model_name,j.local_model,r.model),t.effort,t.config_hash`).bind(start).all();
  const transport=await DB.prepare(`SELECT model,profile_id AS profileId,purpose,effort,max_tokens AS maxTokens,COUNT(*) AS samples,SUM(status='ok') AS succeeded,
    AVG(elapsed_ms) AS transportTotalMs,AVG(capacity_wait_ms) AS capacityWaitMs,AVG(throttle_wait_ms) AS throttleWaitMs,
    AVG(retry_wait_ms) AS retryWaitMs,AVG(request_ms) AS requestMs,AVG(first_response_ms) AS firstResponseMs,
    AVG(first_text_from_request_ms) AS firstTextFromRequestMs,first_text_kind AS firstTextKind
    FROM model_runs WHERE created_at>=? AND purpose IN ('review','review_verify') GROUP BY model,profile_id,purpose,effort,max_tokens,first_text_kind`).bind(start).all();
  const truncated=(rows.results||[]).length>10000;
  const latency=summarizeReviewLatency(records,now).map(group=>({...group,windowComplete:!truncated,gate:truncated?'incomplete_window':group.gate}));
  const missing=records.filter(r=>r.status!=='queued'&&!r.startedAt).length;
  return {generatedAt:new Date(now).toISOString(),days,latency,
    timingCoverage:{total:records.length,withStart:records.filter(r=>r.startedAt).length,missingStartedTaskAnchors:missing,truncated,windowComplete:!truncated,
      note:(truncated?'统计窗口超过10000条，仅展示最近任务；窗口不完整，不能判定达标。':'')+'旧任务无可信开始锚点，保持未知；成员细分时间是设备声明，服务端起止墙钟独立计算。'},
    stages:(spans.results||[]).map((row:any)=>({...row,configurationRecorded:row.configHash!==null})),transport:transport.results||[],
    windowBasis:{latency:'job_created_at',stages:'event_received_at',transport:'call_recorded_at'},
    attribution:{stages:'Task-linked by executor, mode and recorded configuration; null fields remain unknown.',transport:'Provider/profile/model/budget aggregates only; no task-level configuration or job link exists in historical model_runs.'},
    accuracy:{status:'not_measured',target:.8,reason:'需冻结保留作品、核验文件和规则关联，再按实际模型配置分别评估；管理员关联声明不能自动作为严格评估证明。'},
    interpretation:'阶段包含父子跨度，不可直接相加。模型调用总时长含排队与退避；非流式完整响应时间不代表首个生成 Token。'};
}
