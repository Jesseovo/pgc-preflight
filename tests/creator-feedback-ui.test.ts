import {describe,expect,it} from 'vitest';
import {renderFeedbackDetail,renderFeedbackMetrics} from '../src/admin/feedback';
import {readRoute,routeUrl,detailTarget} from '../src/admin/navigation';
const malicious='<img src=x onerror="window.__sourceExecuted=true"><script>window.__sourceExecuted=true</script>';
describe('administrator feedback presentation',()=>{
 it('labels verified identities separately from Agent file claims and preserves comparison totals',()=>{
  const html=renderFeedbackDetail({jobId:'job',versionId:'submission',creation:{artifactVersionId:malicious,uploadHash:'a'.repeat(64),strictEligible:false},ai:{executor:'agent',score:null},comparison:{totals:{ai:null,platform:0}},platform:{decision:'rejected',reviewerRole:'leader'}});
  for(const text of ['成员 Agent','Creator Hub 真人反馈','Creator 作者与准确投稿版本已核对','Agent 投稿记录 SHA-256','上游未提供文件哈希','<td>总分</td><td>未知</td><td>0</td>','不具备条件'])expect(html).toContain(text);
  expect(html).not.toContain('<img');
 });
 it('escapes source reports, opinions, identifiers and admin statements without executable source markup',()=>{
  const html=renderFeedbackDetail({jobId:malicious,title:malicious,versionId:malicious,complete:true,matchedBy:'user-confirmed',inputHash:'a'.repeat(64),ai:{score:0,model:malicious,dimensions:{aes:0,ease:null,play:0},report:{reviewer_comment:malicious}},platform:{decision:'rejected',reviewId:'r',reviewerRole:'leader',reasons:[]},comparison:{state:'unavailable',scoreDifferences:[{name:malicious,ai:0,platform:null,delta:null}]},reviews:[{id:'r',stage:'decision_review',revision:1,feedback:malicious,total:null,scores:[]}],assessment:{status:'declared',gaps:[malicious],files:[],history:[{note:malicious}]}});
  expect(html).not.toContain('<img');expect(html).not.toContain('<script>');expect(html).toContain('&lt;img');expect(html).toContain('组长');expect(html).toContain('不具备条件');expect(html).toContain('未知');expect(html).toContain('0');
 });
 it('presents AI opinions and issue evidence by default while keeping raw originals in closed disclosure elements',()=>{
  const html=renderFeedbackDetail({jobId:'synthetic',ai:{score:0,dimensions:{aes:0,ease:null,play:2},report:{verdict:'待复核',reviewer_comment:malicious,score_reasons:{aes:'美学原理由',ease:'操作未知',play:'短时观察'},issues:[{kind:'unverified',severity:'低',area:'操作',problem:'待核验问题',evidence:malicious,evidence_refs:[],fix:'验证方法原文'}],optional_suggestions:['可选原文']}},platform:{decision:null,reviewId:'r'},reviews:[{id:'r',stage:'decision_review',decision:'rejected',effective:false,deleted:false,revoked:true,reopened:true,revision:2,total:0,scores:[],feedback:malicious}],assessment:{gaps:[],files:[],history:[]}});
  for(const text of ['审核意见','三维评分理由','美学原理由','证据','验证方法原文','可选原文','审核决定','已撤销','已重开','总分 0'])expect(html).toContain(text);
  expect(html).toContain('class="feedback-ai-raw"><summary>原始 AI 报告 JSON');expect(html).toContain('class="feedback-source-raw"><summary>原始审核字段');expect(html).not.toContain('feedback-ai-raw" open');expect(html).not.toContain('<img');expect(html).not.toContain('<script>');
 });
 it('shows absent timings and accuracy as unmeasured, and preserves observed zero without fabricating progress',()=>{
  const missing=renderFeedbackMetrics(null);expect(missing).toContain('未测');expect(missing).not.toContain('0.0%');expect(missing).toContain('≥80%');
  const measured=renderFeedbackMetrics({accuracy:{status:'not_measured'},latency:[{executor:'agent',mode:'basic',model:malicious,started:4,completed:2,failed:1,unresolved:1,onTimeRate:0,completedOnly:{p50Ms:0,p95Ms:null},gate:'not_verified'}]});expect(measured).toContain('0.0%');expect(measured).toContain('0.0 秒');expect(measured).toContain('未测');expect(measured).not.toContain('<img');
 });
 it.each([['configuration_unknown','配置未记录'],['incomplete_telemetry','计时不完整'],['incomplete_window','窗口不完整'],['insufficient_sample','样本不足'],['pending','仍有任务执行'],['passed','达到耗时目标'],['not_met','尚未达到']])('maps %s to a readable gate without treating device declarations as platform verification', (gate,label)=>{
  const html=renderFeedbackMetrics({accuracy:{status:'not_measured'},latency:[{executor:'agent',mode:'basic',model:'synthetic-model',effort:'low',configHash:'a'.repeat(64),gate,completedOnly:{}}]});expect(html).toContain(label);expect(html).not.toContain(gate);expect(html).toContain('不代表平台已独立验证');expect(html).toContain('配置摘要');
 });
 it('supports a standalone feedback route without converting tasks into unrelated inspector details',()=>{
  const route=readRoute('?view=feedback&id=exact-task&section=prior-task');expect(route.view).toBe('feedback');expect(readRoute(routeUrl(route).split('?')[1])).toEqual(route);expect(detailTarget({view:'feedback',id:'exact-task'},readRoute('?view=works'))).toBeUndefined();
 });
});
