import {describe,it,expect} from 'vitest';
import {mergeNaturalReviewObservations,type NaturalObservationTask} from '../server/review-observation';

const policy='a'.repeat(64),since='2026-11-04T00:00:00.000Z',at=(minute:number)=>`2026-11-04T00:${String(minute).padStart(2,'0')}:00.000Z`;
function task(jobId='job-a',patch:Partial<NaturalObservationTask>={}):NaturalObservationTask{return {
  jobId,ownerId:'member-a',createdAt:at(1),updatedAt:at(2),status:'queued',executor:'agent',mode:'basic',inputHash:'b'.repeat(64),
  startedAt:null,finishedAt:null,outcome:null,model:null,effort:null,configHash:null,configurationOrigin:null,
  reportId:null,reportCreatedAt:null,reportHash:null,report:null,reportHashBasis:'stored-result-utf8',reportParseError:false,evidenceHash:null,link:null,...patch,
};}
function snapshot(tasks:NaturalObservationTask[],minute=10,patch:Record<string,unknown>={}){return {schemaVersion:1,kind:'natural-review-snapshot',since,capturedAt:at(minute),complete:true,totalObserved:tasks.length,truncated:false,tasks,...patch};}
const finished=(jobId='job-a',patch:Partial<NaturalObservationTask>={})=>task(jobId,{
  status:'done',updatedAt:at(5),startedAt:at(2),finishedAt:at(5),outcome:'done',model:'fixture-model',effort:'high',configHash:'c'.repeat(64),configurationOrigin:'member-device',
  reportId:9,reportCreatedAt:at(5),reportHash:'d'.repeat(64),report:{schema_version:2,verdict:'原始报告文本；程序不判断结论'},evidenceHash:'e'.repeat(64),
  link:{workId:'work-exact',versionId:'version-exact',linkedAt:at(6),scopeRevision:2},...patch,
});

describe('private continuous natural-submission observations',()=>{
  it('keeps every status, failures, unlinked tasks and unknown executor in the candidate denominator',async()=>{
    const tasks=[task('job-a'),task('job-b',{status:'running',startedAt:at(2)}),finished('job-c'),task('job-d',{status:'error',outcome:'error',executor:'manual-admin'}),task('job-e',{executor:null,mode:null})];
    const result=await mergeNaturalReviewObservations(policy,since,snapshot(tasks));
    expect(result.tasks).toHaveLength(5);expect(result.summary).toMatchObject({totalCandidates:5,byStatus:{queued:2,running:1,done:1,error:1},linked:1,missingConfiguration:4,missingTiming:4,missingReport:4,failed:1,missingFromLatest:0,automaticallyEligibleForEvaluation:0,successfulEvaluations:0});
    expect(result.tasks.find(t=>t.jobId==='job-d')!.latest.executor).toBe('manual-admin');expect(result.tasks.find(t=>t.jobId==='job-e')!.latest.executor).toBeNull();
    expect(result.accuracy).toBeNull();expect(result.status).toBe('collecting_not_evaluated');expect(result.boundaries).toMatchObject({randomBlindTest:false,localHashAuthenticatesSource:false,greyMemberEligibilityVerified:false});
  });
  it('appends each observation without dropping disappeared tasks, and can observe them again',async()=>{
    const first=await mergeNaturalReviewObservations(policy,since,snapshot([task('job-a'),task('job-b')]));
    const frozen=structuredClone(first);
    const missing=await mergeNaturalReviewObservations(policy,since,snapshot([finished('job-a')],15),first);
    expect(first).toEqual(frozen);expect(missing.tasks).toHaveLength(2);expect(missing.summary.missingFromLatest).toBe(1);
    const b=missing.tasks.find(t=>t.jobId==='job-b')!;expect(b.missingFromLatest).toBe(true);expect(b.history).toHaveLength(1);expect(b.lastObservedAt).toBe(at(10));
    const returned=await mergeNaturalReviewObservations(policy,since,snapshot([finished('job-a'),task('job-b',{updatedAt:at(18),status:'error',outcome:'error'})],20),missing);
    expect(returned.tasks.find(t=>t.jobId==='job-b')).toMatchObject({missingFromLatest:false,firstObservedAt:at(10),lastObservedAt:at(20)});
    expect(returned.tasks.find(t=>t.jobId==='job-b')!.history).toHaveLength(2);expect(returned.observations).toHaveLength(3);expect(returned.summary.failed).toBe(1);
  });
  it('the identical snapshot is idempotent and a later same-task snapshot remains a new observation',async()=>{
    const source=snapshot([task()]),first=await mergeNaturalReviewObservations(policy,since,source),again=await mergeNaturalReviewObservations(policy,since,source,first);
    expect(again).toEqual(first);expect(again.tasks[0].history).toHaveLength(1);
    const later=await mergeNaturalReviewObservations(policy,since,snapshot([task()],11),again);expect(later.observations).toHaveLength(2);expect(later.tasks[0].history).toHaveLength(2);
    await expect(mergeNaturalReviewObservations(policy,since,source,later)).rejects.toThrow('倒序');
  });
  it('preserves terminal report mutations and both payloads as conflicts, never a successful evaluation',async()=>{
    const first=await mergeNaturalReviewObservations(policy,since,snapshot([finished()]));
    const changed=finished('job-a',{updatedAt:at(12),reportHash:'f'.repeat(64),report:{verdict:'改后的另一个报告'},reportId:10});
    const result=await mergeNaturalReviewObservations(policy,since,snapshot([changed],15),first),entry=result.tasks[0];
    expect(entry.integrityConflict).toBe(true);expect(entry.history[0].task.report).toEqual(first.tasks[0].latest.report);expect(entry.history[1].task.report).toEqual(changed.report);
    expect(entry.integrityConflicts.map(c=>c.code)).toEqual(expect.arrayContaining(['reportHash_changed_after_terminal','reportId_changed_after_terminal','report_payload_changed_after_terminal']));
    expect(result.summary).toMatchObject({totalCandidates:1,integrityConflictTasks:1,successfulEvaluations:0});expect(result.accuracy).toBeNull();
    const reverted=await mergeNaturalReviewObservations(policy,since,snapshot([finished()],20),result);expect(reverted.tasks[0].integrityConflict).toBe(true);
  });
  it('detects changed terminal payload even if the source asserts the same raw report hash',async()=>{
    const first=await mergeNaturalReviewObservations(policy,since,snapshot([finished()]));
    const result=await mergeNaturalReviewObservations(policy,since,snapshot([finished('job-a',{report:{different:true}})],15),first);
    expect(result.tasks[0].integrityConflicts.some(c=>c.code==='report_payload_changed_after_terminal')).toBe(true);
  });
  it.each([
    ['link_unavailable',null],
    ['link_identity_changed',{workId:'work-other',versionId:'version-exact',linkedAt:at(6),scopeRevision:2}],
    ['link_scope_changed',{workId:'work-exact',versionId:'version-exact',linkedAt:at(6),scopeRevision:3}],
  ] as const)('retains a normal-source link change as %s without asserting tampering',async(code,link)=>{
    const first=await mergeNaturalReviewObservations(policy,since,snapshot([finished()]));
    const next=await mergeNaturalReviewObservations(policy,since,snapshot([finished('job-a',{link})],15),first);
    expect(next.tasks[0].history).toHaveLength(2);expect(next.tasks[0].history[0].task.link).toEqual(first.tasks[0].latest.link);
    expect(next.tasks[0].integrityConflicts.some(c=>c.code===code)).toBe(true);expect(next.summary.successfulEvaluations).toBe(0);expect(next.boundaries.linkChangesMayReflectNormalAuthorizationOrSourceUpdates).toBe(true);
  });
  it('allows initially unavailable metadata to appear, while keeping the original unavailable observation',async()=>{
    const first=await mergeNaturalReviewObservations(policy,since,snapshot([task()]));const next=await mergeNaturalReviewObservations(policy,since,snapshot([finished()],15),first);
    expect(next.tasks[0].integrityConflict).toBe(false);expect(next.tasks[0].history[0].task.report).toBeNull();expect(next.tasks[0].history[1].task.report).toEqual(finished().report);
    expect(next.accuracy).toBeNull();expect(next.status).toBe('collecting_not_evaluated');
  });
  it('retains invalid JSON report rows and does not reinterpret source report hashes',async()=>{
    const raw=finished('job-a',{report:null,reportParseError:true,reportHash:'not-canonical-json-but-source-metadata'});
    const result=await mergeNaturalReviewObservations(policy,since,snapshot([raw]));expect(result.tasks[0].latest.reportParseError).toBe(true);expect(result.tasks[0].latest.reportHash).toBe(raw.reportHash);expect(result.summary.missingReport).toBe(1);
  });
  it('binds policy bytes and equivalent ISO windows; rejects changed policy, shifted windows and invalid calendar time',async()=>{
    const first=await mergeNaturalReviewObservations(policy,'2026-11-04T08:00:00+08:00',snapshot([task()]));expect(first.policyFrozenAt).toBe(since);
    expect(await mergeNaturalReviewObservations(policy,since,snapshot([task()],15,{since:'2026-11-04T08:00:00+08:00'}),first)).toMatchObject({policyFrozenAt:since});
    await expect(mergeNaturalReviewObservations('f'.repeat(64),since,snapshot([task()],15),first)).rejects.toThrow('口径');
    await expect(mergeNaturalReviewObservations(policy,at(1),snapshot([task()],15,{since:at(1)}),first)).rejects.toThrow('口径');
    for(const patch of [{since:'2026-11-03T00:00:00Z'},{capturedAt:'2026-02-30T00:00:00Z'},{capturedAt:'2026-11-03T00:00:00Z'}])await expect(mergeNaturalReviewObservations(policy,since,snapshot([],10,patch))).rejects.toThrow();
  });
  it('accepts the frozen policy ISO microseconds and normalizes the same instant at JavaScript precision',async()=>{
    const frozen='2026-11-04T02:11:53.314124+00:00',normalized='2026-11-04T02:11:53.314Z';
    const sample=task('job-a',{createdAt:'2026-11-04T02:12:00Z',updatedAt:'2026-11-04T02:12:01Z'});
    const input=snapshot([sample],10,{since:frozen,capturedAt:'2026-11-04T02:20:00Z'});
    const first=await mergeNaturalReviewObservations(policy,frozen,input);expect(first.policyFrozenAt).toBe(normalized);expect(first.policySha256).toBe(policy);
    expect(await mergeNaturalReviewObservations(policy,frozen,{...input,since:normalized},first)).toEqual(first);
  });
  it('retains updates, completion and association that occur while the source query is in flight',async()=>{
    const current=finished('job-a',{updatedAt:at(14),startedAt:at(11),finishedAt:at(12),reportCreatedAt:at(12),link:{workId:'work-exact',versionId:'version-exact',linkedAt:at(13),scopeRevision:2}});
    const result=await mergeNaturalReviewObservations(policy,since,snapshot([current],10));
    expect(result.tasks[0].latest).toEqual(current);expect(result.tasks[0].history[0].task.finishedAt).toBe(at(12));expect(result.boundaries.capturedAtIsCreationWindowUpperBoundNotAtomicHistoryTime).toBe(true);
    const next=await mergeNaturalReviewObservations(policy,since,snapshot([current],15),result);expect(next.tasks[0].history).toHaveLength(2);expect(next.tasks[0].integrityConflict).toBe(false);
  });
  it('uses stable string ordering for mixed-case and punctuation IDs at the same creation time',async()=>{
    const tasks=['job-A','job-B','job-_','job-a'].sort().map(jobId=>task(jobId));
    const first=await mergeNaturalReviewObservations(policy,since,snapshot(tasks));expect(first.tasks.map(t=>t.jobId)).toEqual(tasks.map(t=>t.jobId));
    const next=await mergeNaturalReviewObservations(policy,since,snapshot(tasks,15),first);expect(next.tasks.map(t=>t.jobId)).toEqual(tasks.map(t=>t.jobId));expect(next.observations).toHaveLength(2);
    expect(await mergeNaturalReviewObservations(policy,since,snapshot(tasks,15),next)).toEqual(next);
  });
  it('rejects out-of-window tasks, duplicate identities, reversed task order, state and stage time errors',async()=>{
    for(const tasks of [[task('job-a',{createdAt:'2026-11-03T23:59:59Z'})],[task('job-a',{createdAt:at(10),updatedAt:at(10)})],[task(),task()],[task('job-b'),task('job-a')],[task('job-a',{status:'unknown' as any})],[task('job-a',{updatedAt:since})],[task('job-a',{startedAt:at(4),finishedAt:at(3)})],[task('job-a',{outcome:'done'})]])await expect(mergeNaturalReviewObservations(policy,since,snapshot(tasks))).rejects.toThrow();
  });
  it('never hides truncated or missing source rows to manufacture an attainment denominator',async()=>{
    const partial=await mergeNaturalReviewObservations(policy,since,snapshot([finished()],10,{complete:false,truncated:true,totalObserved:40}));
    expect(partial.summary).toMatchObject({totalCandidates:1,latestDeclaredButNotExported:39,minimumCandidateDenominator:40,everIncomplete:true,successfulEvaluations:0});expect(partial.accuracy).toBeNull();expect(partial.status).toBe('collecting_not_evaluated');
    const empty=await mergeNaturalReviewObservations(policy,since,snapshot([],15),partial);expect(empty.tasks).toHaveLength(1);expect(empty.summary).toMatchObject({missingFromLatest:1,minimumCandidateDenominator:40,everIncomplete:true});
    for(const patch of [{totalObserved:2},{complete:true,truncated:true},{totalObserved:0},{complete:false,totalObserved:-1}])await expect(mergeNaturalReviewObservations(policy,since,snapshot([task()],10,patch))).rejects.toThrow();
  });
  it('rejects accidentally removed prior tasks, rewritten prior report observations or counts',async()=>{
    const first=await mergeNaturalReviewObservations(policy,since,snapshot([finished('job-a'),task('job-b')]));
    for(const mutate of [(v:any)=>{v.tasks.pop();},(v:any)=>{v.tasks[0].history[0].task.report={replaced:true};v.tasks[0].latest.report={replaced:true};},(v:any)=>{v.observations[0].totalObserved=1;},(v:any)=>{v.observations[0].observedTaskCount=1;}]){const changed=structuredClone(first);mutate(changed);await expect(mergeNaturalReviewObservations(policy,since,snapshot([],15),changed)).rejects.toThrow();}
  });
  it('does not mutate inputs or share mutable boundary state across returned ledgers',async()=>{
    const source=snapshot([task()]),before=structuredClone(source),first=await mergeNaturalReviewObservations(policy,since,source);
    expect(source).toEqual(before);(first.boundaries as any).localHashAuthenticatesSource=true;
    expect((await mergeNaturalReviewObservations(policy,since,source)).boundaries.localHashAuthenticatesSource).toBe(false);
  });
});
