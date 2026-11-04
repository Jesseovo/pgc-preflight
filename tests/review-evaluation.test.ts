import {describe,it,expect} from 'vitest';
import {derivePlatformDecision,deriveAiDecision,evaluateConclusionCases,type ConclusionEvaluationCase} from '../server/review-evaluation';
import type {FeedbackGame} from '../server/creator-feedback-client';
const game=():FeedbackGame=>({id:'game-one',authorId:'author',title:'Synthetic',description:'',status:'approved',revision:2,createdAt:'',updatedAt:'',archived:false,deleted:false,textRedacted:true,idNamespace:'integration_pseudonym',comments:[],
 versions:[{id:'version-old',revision:1,title:'',description:'',submittedAt:'',updateNote:null,withdrawn:false,ruleVersion:null,status:'rejected',statusSource:'effective_review_or_unknown',finalReviewId:'review-one',files:{},fileAccess:false}],
 reviews:[{id:'review-one',versionId:'version-old',stage:'decision_review',revision:1,eventSequence:1,reviewerId:null,reviewerRole:'leader',scores:[],total:null,decision:'rejected',feedback:'',createdAt:'',recordedAt:null,scored:false,historicalBaseline:false,deleted:false,reopened:false,revoked:false,effective:true}]});
const report=(approved=true):any=>({schema_version:2,assessment_status:'complete',aes:approved?3:2,ease:2,play:2,score_reasons:{aes:'Synthetic evidence',ease:'Synthetic evidence',play:'Synthetic evidence'},uncertainties:[],verdict:approved?'通过':'打回',reviewer_comment:'Synthetic',strengths:[],issues:[],fix_prompt:'无需强制修改',optional_suggestions:[]});
function cohort():ConclusionEvaluationCase[]{return Array.from({length:100},(_,i)=>({caseId:`case-${i}`,workId:`work-${i}`,versionId:`version-${i}`,split:'holdout',executor:'agent',mode:'basic',modelConfigHash:'frozen',
 qualification:{status:'verified',auditId:`synthetic-audit-${i}`,reasons:[]},reference:{state:'valid',decision:i<50?'approved':'rejected',reviewId:`review-${i}`,reviewerRole:null,ruleVersion:1,reasons:[]},
 prediction:{status:'done',report:report(i<50),modelConfigHash:'frozen'},quality:{audited:true,unsupportedMandatory:0,incorrectReasons:0,criticalRegression:false,unknownIncreaseExplained:true}}));}
describe('effective platform outcome semantics',()=>{
 it('includes unscored leader returns and uses the exact old version, not current game state',()=>{expect(derivePlatformDecision(game(),'version-old')).toMatchObject({state:'valid',decision:'rejected',reviewerRole:'leader'});});
 it('preserves unknown reviewer and rule without inventing admin identity',()=>{const g=game();g.reviews[0].reviewerRole=null;g.archived=true;expect(derivePlatformDecision(g,'version-old')).toMatchObject({state:'valid',reviewerRole:null,ruleVersion:null});});
 it.each(['deleted','reopened','revoked'] as const)('does not label an ineffective %s review',flag=>{const g=game();g.reviews[0][flag]=true;expect(derivePlatformDecision(g,'version-old').decision).toBeNull();});
 it('rejects a conflicting current review or version reference',()=>{const g=game();g.reviews.push({...g.reviews[0],id:'other'});expect(derivePlatformDecision(g,'version-old').state).toBe('conflict');g.reviews.pop();g.reviews[0].versionId='another';expect(derivePlatformDecision(g,'version-old').state).toBe('conflict');});
 it('does not manufacture labels for pending, withdrawn or deleted items',()=>{for(const mutate of [(g:FeedbackGame)=>g.versions[0].status='pending',(g:FeedbackGame)=>g.versions[0].withdrawn=true,(g:FeedbackGame)=>g.deleted=true]){const g=game();mutate(g);expect(derivePlatformDecision(g,'version-old').decision).toBeNull();}});

 it('selects the highest native revision and never falls back after revocation',()=>{
  const g=game(),old={...g.reviews[0],effective:false},current={...g.reviews[0],revision:2,decision:'approved',effective:true};g.versions[0].status='approved';g.reviews=[current,old];expect(derivePlatformDecision(g,'version-old')).toMatchObject({state:'valid',decision:'approved'});
  current.revoked=true;expect(derivePlatformDecision(g,'version-old')).toMatchObject({state:'unavailable',decision:null});
 });
 it('rejects duplicate highest native revisions even when their values happen to match',()=>{
  const g=game();g.reviews.push({...g.reviews[0]});expect(derivePlatformDecision(g,'version-old')).toMatchObject({state:'conflict',decision:null});expect(derivePlatformDecision(g,'version-old').reasons).toContain('duplicate_highest_review_revision');
 });
 it('ignores stale effective flags on lower revisions while retaining real distinct-review conflicts',()=>{
  const g=game();g.reviews.push({...g.reviews[0],revision:2});expect(derivePlatformDecision(g,'version-old').state).toBe('valid');g.reviews.push({...g.reviews[0],id:'another-review'});expect(derivePlatformDecision(g,'version-old').reasons).toContain('multiple_effective_decisions');
 });
 it('parses only the validated explicit model conclusion, never scores or opinion prose',()=>{
   expect(deriveAiDecision(report())).toBe('approved');
   expect(deriveAiDecision({...report(),aes:0,ease:0,play:0})).toBe('approved'); // reason/score contradiction is a separate audit, not program rescoring
   expect(deriveAiDecision({...report(),verdict:'建议通过'})).toBeNull();
   expect(deriveAiDecision({...report(),assessment_status:'needs_review',aes:null,verdict:'待复核',uncertainties:['未测']})).toBeNull();
   expect(deriveAiDecision({...report(),schema_version:1})).toBeNull();
 });
});
describe('conclusion-first evaluation arithmetic',()=>{
 it('counts abstentions and failures in the denominator, reports each class and uncertainty',()=>{
  const rows=cohort();for(let i=0;i<10;i++)rows[i].prediction.report={...report(),assessment_status:'needs_review',aes:null,verdict:'待复核',uncertainties:['未测']};
  for(let i=10;i<20;i++)rows[i].prediction.status='error';
  const result=evaluateConclusionCases(rows)[0];expect(result).toMatchObject({denominator:100,correct:80,accuracy:.8,unknown:10,failed:10});
  expect(result.matrix.humanApproved.unknownOrFailed).toBe(20);expect(result.confidenceInterval95!.low).toBeLessThan(.8);expect(result.acceptance.passed).toBe(true);
 });
 it('missing work cannot be counted as success or a complete evaluation',()=>{const rows=cohort();rows[0].prediction.status='missing';const r=evaluateConclusionCases(rows)[0];expect(r.denominator).toBe(100);expect(r.accuracy).toBe(.99);expect(r.acceptance.reasons).toContain('evaluation_not_finished');});
 it('self-attested or rule-incomparable cases cannot produce a passed target',()=>{const rows=cohort();rows.forEach(r=>r.qualification={status:'unverified',auditId:null,reasons:['rules_unknown']});const result=evaluateConclusionCases(rows)[0];expect(result.accuracy).toBeNull();expect(result.acceptance.passed).toBe(false);});
 it('does not hide a configuration change or achieve the target with just one label class',()=>{const rows=cohort();rows[0].prediction.modelConfigHash='other';expect(evaluateConclusionCases(rows)[0].acceptance.reasons).toContain('model_configuration_changed');rows.forEach(r=>{r.reference.decision='approved';r.prediction.report=report();});expect(evaluateConclusionCases(rows)[0].acceptance.reasons).toContain('fewer_than_20_in_each_reference_class');});
 it('prevents cross-split leaks and repeated-version weighting',()=>{const rows=cohort();rows.push({...rows[0],caseId:'calibration',split:'calibration'});expect(()=>evaluateConclusionCases(rows)).toThrow('跨');rows.pop();rows[1].workId=rows[0].workId;expect(()=>evaluateConclusionCases(rows)).toThrow('一个版本');});
 it('does not let matching conclusions override mandatory-change or recall failures',()=>{const rows=cohort();rows[0].quality.unsupportedMandatory=1;rows[1].quality.criticalRegression=true;const result=evaluateConclusionCases(rows)[0];expect(result.accuracy).toBe(1);expect(result.acceptance.reasons).toEqual(expect.arrayContaining(['unsupported_mandatory_changes','critical_issue_regression']));});
 it('cannot combine strong basic results with weak enhanced results into an 80 percent pass',()=>{
  const rows=cohort();for(let i=50;i<100;i++){rows[i].mode='enhanced';if(i>=80)rows[i].prediction.report=report(true);}
  const results=evaluateConclusionCases(rows);expect(results).toHaveLength(2);expect(results.map(r=>r.mode)).toEqual(['basic','enhanced']);expect(results.map(r=>r.accuracy)).toEqual([1,.6]);for(const r of results){expect(r.acceptance.passed).toBe(false);expect(r.acceptance.reasons).toContain('fewer_than_100_independent_games');}
 });
 it('allows the same held-out game to be compared across modes without double weighting either mode',()=>{
  const basic=cohort(),enhanced=basic.map(row=>({...row,caseId:row.caseId+'-enhanced',mode:'enhanced' as const}));const results=evaluateConclusionCases([...basic,...enhanced]);expect(results).toHaveLength(2);expect(results.every(r=>r.denominator===100&&r.acceptance.passed)).toBe(true);
 });
 it.each([{},[],1,'','   ','x'.repeat(201),null])('rejects a malformed verified audit ID (%j)',bad=>{
  const rows=cohort();rows[0].qualification.auditId=bad as any;expect(()=>evaluateConclusionCases(rows)).toThrow('审计编号');
 });
 it('reports a majority-class baseline and balanced accuracy without inventing a new per-class target',()=>{
  const rows=cohort();rows.forEach((row,i)=>{row.reference.decision=i<80?'approved':'rejected';row.prediction.report=report(true);});const r=evaluateConclusionCases(rows)[0];expect(r).toMatchObject({accuracy:.8,majorityBaseline:.8,balancedAccuracy:.5,aboveMajorityBaseline:false,classRecall:{approved:1,rejected:0}});expect(r.effectiveness).toContain('do not establish');
 });

});
