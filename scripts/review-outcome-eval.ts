/** Offline private analysis. No model calls, upstream requests or source changes. */
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {derivePlatformDecision,evaluateConclusionCases,type ConclusionEvaluationCase} from '../server/review-evaluation';
import type {FeedbackGame} from '../server/creator-feedback-client';
const digest=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const args=process.argv.slice(2),command=args.shift();
const option=(name:string)=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
async function json(path:string){const raw=await readFile(resolve(path));return {raw,sha256:digest(raw),data:JSON.parse(raw.toString('utf8'))};}
async function privateJson(path:string,value:unknown){await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await chmod(path,0o600);}
const unknownQuality=()=>({audited:false,unsupportedMandatory:null,incorrectReasons:null,criticalRegression:null,unknownIncreaseExplained:null});
const unknownQualification=()=>({status:'unverified' as const,auditId:null,reasons:['independent_audit_missing']});
const missingPrediction=()=>({status:'missing' as const,report:null,modelConfigHash:null});
function keyedRecords(doc:any,manifestHash:string,registered:Set<string>){
 if(doc.manifestSha256!==manifestHash||!Array.isArray(doc.cases))throw new Error('预测或审计必须绑定原始预登记清单摘要。');
 const map=new Map<string,any>();
 for(const row of doc.cases){if(!row||!registered.has(row.caseId)||map.has(row.caseId))throw new Error('预测或审计有未登记或重复案例。');map.set(row.caseId,row);}
 return map;
}
async function main(){
 const source=option('--source'),out=option('--out');
 if(!['inventory','freeze','evaluate'].includes(command||'')||!source||!out)throw new Error('用法: review-outcome-eval.ts inventory|freeze|evaluate --source feedback-export.json --out PRIVATE_DIRECTORY；freeze 另需 --registry；evaluate 另需 --manifest --predictions --audits。');
 const input=await json(source),folder=resolve(out);await mkdir(folder,{recursive:true,mode:0o700});await chmod(folder,0o700);
 if(input.data.complete!==true||!Array.isArray(input.data.games))throw new Error('需要明确完成的冻结反馈导出。');
 const games:FeedbackGame[]=input.data.games.map((item:any)=>item.game);
 const gameIds=new Set<string>(),versionIds=new Set<string>();
 const labels=games.flatMap(g=>{
  if(gameIds.has(g.id))throw new Error('来源作品编号重复。');gameIds.add(g.id);
  return g.versions.map(v=>{if(versionIds.has(v.id))throw new Error('来源投稿版本编号重复。');versionIds.add(v.id);return {workId:g.id,versionId:v.id,reference:derivePlatformDecision(g,v.id),fileAccess:v.fileAccess};});
 });
 const references=new Map(labels.map(r=>[`${r.workId}:${r.versionId}`,r.reference]));
 const counts={games:games.length,versions:labels.length,valid:labels.filter(r=>r.reference.state==='valid').length,approved:labels.filter(r=>r.reference.decision==='approved').length,rejected:labels.filter(r=>r.reference.decision==='rejected').length,unavailable:labels.filter(r=>r.reference.state==='unavailable').length,conflict:labels.filter(r=>r.reference.state==='conflict').length,ruleUnknown:labels.filter(r=>r.reference.ruleVersion===null).length};
 const provenance={source:resolve(source),sha256:input.sha256,exportedAt:input.data.exportedAt||null,scopeRevision:input.data.contract?.scopeRevision??null};
 const base={schemaVersion:1,generatedAt:new Date().toISOString(),privacy:'local_private_do_not_publish',provenance,counts,modelCalls:0,fileDownloads:0};
 if(command==='inventory'){
  await privateJson(join(folder,'labels.json'),{...base,labels});
  await privateJson(join(folder,'readiness.json'),{...base,accuracy:null,status:'not_measured',target:.8,gaps:['需准确关联 PGC 任务及输入与投稿文件。','历史规则未知必须单列，不默认为现行规则。','关联声明不等于已核验文件、规则和盲评材料。','主验收每路径至少100独立作品、两类各至少20，未知和失败不当成功。'],fileVersionAuthorization:input.data.contract?.fileVersionCount??null});
 }else if(command==='freeze'){
  const path=option('--registry');if(!path)throw new Error('freeze 需要 --registry 指定尚未执行的案例登记清单。');
  const registry=await json(path);if(!Array.isArray(registry.data.cases)||!registry.data.cases.length)throw new Error('登记清单不能为空。');
  const allowed=['caseId','workId','versionId','split','executor','mode','modelConfigHash','rulesHash','calibrationHash','inputHash'];
  const cases=registry.data.cases.map((c:any)=>{
   if(!c||Object.keys(c).some(k=>!allowed.includes(k)))throw new Error('登记清单不得包含预测、参考答案或事后审计。');
   if(!references.has(`${c.workId}:${c.versionId}`))throw new Error('登记作品或准确投稿版本不在来源清单。');
   for(const k of ['modelConfigHash','rulesHash','calibrationHash','inputHash'])if(typeof c[k]!=='string'||!/^[a-f0-9]{64}$/.test(c[k]))throw new Error('登记需要固定模型、规则、校准和输入文件的 SHA-256。');
   return c;
  });
  evaluateConclusionCases(cases.map((c:any)=>({...c,reference:references.get(`${c.workId}:${c.versionId}`),qualification:unknownQualification(),prediction:missingPrediction(),quality:unknownQuality()})));
  const file=join(folder,'manifest.json');
  await privateJson(file,{schemaVersion:1,status:'frozen',frozenAt:base.generatedAt,sourceSha256:input.sha256,scopeRevision:provenance.scopeRevision,cases});
  const manifest=await json(file);await privateJson(join(folder,'registration.json'),{...base,manifestPath:file,manifestSha256:manifest.sha256,registrySha256:registry.sha256,count:cases.length,note:'之后每份预测及独立审计必须携此摘要；本地文件一致性不能单独证明操作员未提前知道历史答案。'});
 }else{
  const manifestPath=option('--manifest'),predictionPath=option('--predictions'),auditPath=option('--audits');
  if(!manifestPath||!predictionPath||!auditPath)throw new Error('evaluate 必须提供预登记 manifest、独立 predictions 和 audits。');
  const manifest=await json(manifestPath),predictions=await json(predictionPath),audits=await json(auditPath);
  if(manifest.data.status!=='frozen'||!Array.isArray(manifest.data.cases)||!manifest.data.cases.length||!Number.isFinite(Date.parse(manifest.data.frozenAt)))throw new Error('预登记清单未冻结或时间不明确。');
  if(manifest.data.scopeRevision!==provenance.scopeRevision)throw new Error('授权范围版本变化，必须先重新核验样本资格。');
  const registered=new Set<string>(manifest.data.cases.map((c:any)=>c.caseId));
  const predictionMap=keyedRecords(predictions.data,manifest.sha256,registered),auditMap=keyedRecords(audits.data,manifest.sha256,registered);
  const cases:ConclusionEvaluationCase[]=manifest.data.cases.map((c:any)=>{
   const p=predictionMap.get(c.caseId),a=auditMap.get(c.caseId);
   if(p&&['done','error'].includes(p.prediction?.status)){
    if(!Number.isFinite(Date.parse(p.finishedAt))||Date.parse(p.finishedAt)<Date.parse(manifest.data.frozenAt))throw new Error('预测缺少登记之后的结束时间，不能作为新保留评估。');
    if(p.inputHash!==c.inputHash||p.rulesHash!==c.rulesHash||p.calibrationHash!==c.calibrationHash)throw new Error('预测使用的输入、规则或校准与登记清单不一致。');
    if(p.prediction.status==='done'&&(typeof p.evidenceHash!=='string'||!/^[a-f0-9]{64}$/.test(p.evidenceHash)))throw new Error('已完成预测缺少锁定证据摘要。');
    if(p.prediction.status==='done'&&a?.qualification?.status==='verified'&&a.evidenceHash!==p.evidenceHash)throw new Error('已核验预测的锁定证据须由独立审计精确引用。');
   }
   const reference=references.get(`${c.workId}:${c.versionId}`)||{state:'unavailable' as const,decision:null,reviewId:null,reviewerRole:null,ruleVersion:null,reasons:['reference_missing_or_removed']};
   return {...c,reference,qualification:a?.qualification??unknownQualification(),prediction:p?.prediction??missingPrediction(),quality:a?.quality??unknownQuality()};
  });
  const metrics=evaluateConclusionCases(cases);
  await privateJson(join(folder,'evaluation.json'),{...base,manifestSha256:manifest.sha256,predictionsSha256:predictions.sha256,auditsSha256:audits.sha256,enrolled:cases.length,predictionsProvided:predictionMap.size,auditsProvided:auditMap.size,metrics,
   qualificationBoundary:'资格和盲评记录由独立核验流程提供；本工具核对预登记集合、材料摘要、结构、时序及来源结论，再计算指标。它不认证上游文件证明或操作员的盲评声明，不把自述自动升级为可信证明。',status:metrics.length?'computed_from_supplied_audits':'not_measured'});
 }
 process.stdout.write(JSON.stringify({output:folder,counts,command,modelCalls:0,fileDownloads:0})+'\n');
}
main().catch(e=>{process.stderr.write((e instanceof Error?e.message:'本地评估未完成')+'\n');process.exitCode=1;});
