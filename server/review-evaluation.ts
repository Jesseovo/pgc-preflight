import type {FeedbackGame} from './creator-feedback-client';
import {reviewReportErrors} from './review-report';

export type ReviewDecision='approved'|'rejected';
export interface PlatformDecision {state:'valid'|'unavailable'|'conflict';decision:ReviewDecision|null;reviewId:string|null;reviewerRole:string|null;ruleVersion:string|number|null;reasons:string[]}
/** Source decisions, including a leader's direct return, are labels—not reproduced defects. */
export function derivePlatformDecision(game:FeedbackGame,versionId:string):PlatformDecision {
  const v=game.versions.find(v=>v.id===versionId);
  const result:PlatformDecision={state:'unavailable',decision:null,reviewId:v?.finalReviewId??null,reviewerRole:null,ruleVersion:v?.ruleVersion??null,reasons:[]};
  if(!v){result.reasons.push('version_missing');return result;}
  if(game.deleted)result.reasons.push('game_deleted');
  if(v.withdrawn)result.reasons.push('version_withdrawn');
  if(!['approved','rejected'].includes(v.status||''))result.reasons.push('no_binary_version_status');
  if(!v.finalReviewId)result.reasons.push('no_deciding_review_reference');
  // A native review ID has a revision history. Only its highest revision
  // describes current effectiveness; never fall back to an older approval.
  const histories=new Map<string,FeedbackGame['reviews']>();
  for(const review of game.reviews)histories.set(review.id,[...(histories.get(review.id)||[]),review]);
  const current:FeedbackGame['reviews']=[];
  for(const [reviewId,history]of histories){
    const relevant=reviewId===v.finalReviewId||history.some(r=>r.versionId===versionId);
    if(history.some(r=>!Number.isSafeInteger(r.revision)||r.revision<0)){
      if(relevant){result.state='conflict';result.reasons.push('invalid_review_revision');}continue;
    }
    const highest=Math.max(...history.map(r=>r.revision)),latest=history.filter(r=>r.revision===highest);
    if(latest.length!==1){if(relevant){result.state='conflict';result.reasons.push('duplicate_highest_review_revision');}continue;}
    current.push(latest[0]);
  }
  const refs=current.filter(r=>r.id===v.finalReviewId);
  const active=current.filter(r=>r.versionId===versionId&&r.stage==='decision_review'&&r.effective&&!r.deleted&&!r.revoked&&!r.reopened);
  if(active.length>1){result.state='conflict';result.reasons.push('multiple_effective_decisions');}
  if(v.finalReviewId&&refs.length!==1){result.state='conflict';result.reasons.push('deciding_review_reference_missing_or_duplicate');}
  if(refs.length===1){
    const r=refs[0];result.reviewerRole=r.reviewerRole;
    if(r.versionId!==versionId){result.state='conflict';result.reasons.push('review_version_mismatch');}
    if(r.stage!=='decision_review')result.reasons.push('not_deciding_review');
    if(!r.effective||r.deleted||r.revoked||r.reopened)result.reasons.push('decision_not_effective');
    if(!['approved','rejected'].includes(r.decision||''))result.reasons.push('no_binary_review_decision');
    else if(['approved','rejected'].includes(v.status||'')&&r.decision!==v.status){result.state='conflict';result.reasons.push('version_decision_conflict');}
    if(!result.reasons.length){result.state='valid';result.decision=r.decision as ReviewDecision;}
  }
  return result;
}

/** Parse the model's explicit v2 conclusion, never infer one from score or prose opinions. */
export function deriveAiDecision(report:unknown):ReviewDecision|null {
  const r=report as any;
  if(!r||r.schema_version!==2||r.assessment_status!=='complete'||reviewReportErrors(r,{schemaVersion:2}).length)return null;
  return r.verdict.startsWith('通过')?'approved':r.verdict.startsWith('打回')?'rejected':null;
}

export interface ConclusionEvaluationCase {
  caseId:string;workId:string;versionId:string;split:'calibration'|'holdout'|'regression';
  executor:'agent'|'platform';mode:'basic'|'enhanced';modelConfigHash:string;
  /** Eligibility comes from a separate, traceable file/rule/blinding audit. */
  qualification:{status:'verified'|'unverified';auditId:string|null;reasons:string[]};
  reference:PlatformDecision;
  prediction:{status:'done'|'error'|'pending'|'missing';report:unknown;modelConfigHash:string|null};
  quality:{audited:boolean;unsupportedMandatory:number|null;incorrectReasons:number|null;criticalRegression:boolean|null;unknownIncreaseExplained:boolean|null};
}

function interval(successes:number,total:number):{low:number;high:number}|null {
  if(!total)return null;
  const z=1.959963984540054,p=successes/total,d=1+z*z/total;
  const mid=(p+z*z/(2*total))/d,half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;
  return {low:Math.max(0,mid-half),high:Math.min(1,mid+half)};
}

/** Arithmetic over audited cases. This function does not authenticate submitted audits. */
export function evaluateConclusionCases(cases:ConclusionEvaluationCase[]) {
  if(!Array.isArray(cases))throw new Error('评估案例必须为数组。');
  const auditId=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=200;
  const seen=new Set<string>(),splits=new Map<string,string>(),grouped=new Map<string,ConclusionEvaluationCase[]>();
  for(const c of cases){
    if(!c||![c.caseId,c.workId,c.versionId,c.modelConfigHash].every(v=>typeof v==='string'&&v.length>0&&v.length<=200)||!['calibration','holdout','regression'].includes(c.split)||!['agent','platform'].includes(c.executor)||!['basic','enhanced'].includes(c.mode))throw new Error('评估案例结构不正确。');
    if(!c.qualification||!['verified','unverified'].includes(c.qualification.status)||!Array.isArray(c.qualification.reasons)||!c.reference||!['valid','unavailable','conflict'].includes(c.reference.state)||!c.prediction||!['done','error','pending','missing'].includes(c.prediction.status)||!c.quality)throw new Error('评估证据与执行状态缺失。');
    if((c.qualification.auditId!==null&&!auditId(c.qualification.auditId))||(c.qualification.status==='verified'&&!auditId(c.qualification.auditId)))throw new Error('审计编号必须为非空且不超过200字符的字符串。');
    if(c.qualification.reasons.some(v=>typeof v!=='string'||v.length>1000))throw new Error('审计原因字段不正确。');
    if(c.reference.state==='valid'&&!['approved','rejected'].includes(c.reference.decision||''))throw new Error('有效参考结论必须为明确通过或退回。');
    if(typeof c.quality.audited!=='boolean'||['unsupportedMandatory','incorrectReasons'].some(k=>{const v=c.quality[k as 'unsupportedMandatory'|'incorrectReasons'];return v!==null&&(!Number.isSafeInteger(v)||v<0);})||['criticalRegression','unknownIncreaseExplained'].some(k=>{const v=c.quality[k as 'criticalRegression'|'unknownIncreaseExplained'];return v!==null&&typeof v!=='boolean';}))throw new Error('质量审计字段不正确。');
    if(seen.has(c.caseId))throw new Error('评估案例编号重复。');seen.add(c.caseId);
    if(splits.has(c.workId)&&splits.get(c.workId)!==c.split)throw new Error('同一作品不能跨校准、保留或回归集合。');splits.set(c.workId,c.split);
    if(c.split!=='holdout')continue;
    const group=JSON.stringify([c.executor,c.modelConfigHash,c.mode]);grouped.set(group,[...(grouped.get(group)||[]),c]);
  }
  return [...grouped.entries()].map(([key,rows])=>{
    const [executor,modelConfigHash,mode]=JSON.parse(key);
    if(new Set(rows.map(r=>r.workId)).size!==rows.length)throw new Error('主评估每个执行配置的每款作品只能登记一个版本。');
    const qualified=rows.filter(r=>r.qualification.status==='verified'&&r.qualification.auditId&&r.qualification.reasons.length===0);
    const eligible=qualified.filter(r=>r.reference.state==='valid'&&r.reference.decision!==null);
    const matrix={humanApproved:{aiApproved:0,aiRejected:0,unknownOrFailed:0},humanRejected:{aiApproved:0,aiRejected:0,unknownOrFailed:0}};
    let correct=0,completed=0,failed=0,missing=0,unknown=0,mismatchedConfiguration=0;
    for(const row of eligible){
      let ai:ReviewDecision|null=null;
      if(row.prediction.modelConfigHash!==row.modelConfigHash){mismatchedConfiguration++;}
      else if(row.prediction.status==='done'){completed++;ai=deriveAiDecision(row.prediction.report);if(ai===null)unknown++;}
      if(row.prediction.status==='error')failed++;
      if(['pending','missing'].includes(row.prediction.status))missing++;
      const cell=row.reference.decision==='approved'?matrix.humanApproved:matrix.humanRejected;
      if(ai==='approved')cell.aiApproved++;else if(ai==='rejected')cell.aiRejected++;else cell.unknownOrFailed++;
      if(ai!==null&&ai===row.reference.decision)correct++;
    }
    const approved=eligible.filter(r=>r.reference.decision==='approved').length,rejected=eligible.length-approved;
    const accuracy=eligible.length?correct/eligible.length:null;
    const reasons:string[]=[];
    if(qualified.length!==rows.length)reasons.push('unverified_enrolled_cases');
    if(eligible.length!==qualified.length)reasons.push('reference_pending_or_invalid');
    if(eligible.length<100)reasons.push('fewer_than_100_independent_games');
    if(approved<20||rejected<20)reasons.push('fewer_than_20_in_each_reference_class');
    if(accuracy===null||accuracy<.8)reasons.push('agreement_below_target_or_unknown');
    if(missing)reasons.push('evaluation_not_finished');
    if(mismatchedConfiguration)reasons.push('model_configuration_changed');
    const qualityMissing=eligible.filter(r=>!r.quality.audited||r.quality.unsupportedMandatory===null||r.quality.incorrectReasons===null||r.quality.criticalRegression===null||r.quality.unknownIncreaseExplained===null).length;
    if(qualityMissing)reasons.push('quality_audit_incomplete');
    const unsupportedMandatory=eligible.reduce((n,r)=>n+(r.quality.unsupportedMandatory??0),0);
    const incorrectReasons=eligible.reduce((n,r)=>n+(r.quality.incorrectReasons??0),0);
    if(unsupportedMandatory)reasons.push('unsupported_mandatory_changes');
    if(incorrectReasons)reasons.push('incorrect_reasons_need_review');
    if(eligible.some(r=>r.quality.criticalRegression))reasons.push('critical_issue_regression');
    if(eligible.some(r=>r.quality.unknownIncreaseExplained===false))reasons.push('unexplained_unknown_increase');
    const majorityBaseline=eligible.length?Math.max(approved,rejected)/eligible.length:null;
    const approvedRecall=approved?matrix.humanApproved.aiApproved/approved:null,rejectedRecall=rejected?matrix.humanRejected.aiRejected/rejected:null;
    return {executor,modelConfigHash,mode,enrolled:rows.length,qualified:qualified.length,denominator:eligible.length,correct,accuracy,target:.8,confidenceInterval95:interval(correct,eligible.length),
      classCounts:{approved,rejected},majorityBaseline,balancedAccuracy:approvedRecall!==null&&rejectedRecall!==null?(approvedRecall+rejectedRecall)/2:null,aboveMajorityBaseline:accuracy!==null&&majorityBaseline!==null?accuracy>majorityBaseline:null,
      effectiveness:'Agreement and baseline comparisons alone do not establish independent model effectiveness.',matrix,completed,failed,missing,unknown,mismatchedConfiguration,
      classRecall:{approved:approvedRecall,rejected:rejectedRecall},
      quality:{audited:eligible.length-qualityMissing,unsupportedMandatory:qualityMissing?null:unsupportedMandatory,incorrectReasons:qualityMissing?null:incorrectReasons},
      acceptance:{passed:reasons.length===0,reasons},
      boundary:'Agreement with effective platform decisions, including leader returns. Arithmetic over supplied audited evidence is not independent authentication or proof of population accuracy. Unknown and failed predictions remain in the denominator.'};
  });
}
