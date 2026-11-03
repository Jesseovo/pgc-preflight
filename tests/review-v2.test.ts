import {describe,expect,it,vi,afterEach} from 'vitest';
import {normalizeReviewOutput,reportScore,reviewReportErrors} from '../server/review-report';
import {reviewSystem,reviewSystemLegacy,REVIEW_SCHEMA,REVIEW_SCHEMA_V2,REVIEW_VERIFICATION_V2} from '../server/forge/prompts.js';
import {generateReview} from '../server/review-generation';
import {complete} from '../server/forge-llm';
vi.mock('../public/forge/progress.js',()=>({startTask:vi.fn(),progressHtml:vi.fn()}));
vi.mock('../server/forge-llm',async original=>({...await original<typeof import('../server/forge-llm')>(),complete:vi.fn()}));
afterEach(()=>{vi.resetAllMocks();vi.unstubAllGlobals();});
const rules={id:'synthetic-rules-v2',rawDirection:'当前方向：极简也可出彩。',rawScoring:'美学、易玩性、可玩性各0–3分。证据不足待复核。',scoreMin:0,scoreMax:3,passScore:7,calibrationCases:[]};
const report=()=>({schema_version:2,assessment_status:'complete',aes:0,ease:3,play:3,score_reasons:{aes:'合成截图有已证实的画面故障',ease:'合成输入记录',play:'合成源码推断'},uncertainties:[],verdict:'打回：合成结论',reviewer_comment:'仅协议测试',strengths:[],issues:[{kind:'confirmed',severity:'高',area:'美学',problem:'合成故障',evidence:'合成截图',evidence_refs:['synthetic-start'],fix:'合成修改'}],optional_suggestions:[],fix_prompt:'修复合成故障'});

describe('v2 合成报告协议（不验证真实模型质量）',()=>{
 it('0 是有效分数，完整报告只算术相加，不改模型报告',()=>{
  const value=report(),before=JSON.stringify(value);
  expect(reviewReportErrors(value)).toEqual([]);expect(reportScore(value)).toBe(6);expect(JSON.stringify(value)).toBe(before);
  expect(normalizeReviewOutput({report:value})).toBe(value);
  expect(REVIEW_SCHEMA_V2.properties.aes).toEqual({type:['integer','null'],minimum:0,maximum:3});
 });
 it('null 保留未知，不转零、不生成通过/失败或总分',()=>{
  const value={...report(),aes:null,assessment_status:'needs_review',verdict:'待复核：缺图',uncertainties:['缺图，请重新采集']};
  expect(reviewReportErrors(value)).toEqual([]);expect(reportScore(value)).toBeNull();expect(value.aes).toBeNull();
  expect(reviewReportErrors({...value,assessment_status:'complete'})).toContain('assessment_status');
  expect(reviewReportErrors({...value,verdict:'打回'})).toContain('verdict');
  expect(reviewReportErrors({...value,uncertainties:[]})).toContain('uncertainties');
 });
 it('严格拒绝数字字符串、越界、版本错配、缺失字段与未知字段，不修补',()=>{
  for(const value of [-1,4,'0',undefined])expect(reviewReportErrors({...report(),aes:value})).toContain('aes');
  expect(reviewReportErrors(report(),{schemaVersion:1})).toContain('schema_version');
  expect(reviewReportErrors({...report(),schema_version:undefined},{schemaVersion:2})).toContain('schema_version');
  expect(reviewReportErrors({...report(),invented:true})).toContain('invented');
  expect(reviewReportErrors({...report(),optional_suggestions:undefined})).toContain('optional_suggestions');
 });
 it('区分已证实、体验与未验证，要求有依据的意见引用真实材料的位置',()=>{
  for(const kind of ['confirmed','experience','unverified'])expect(reviewReportErrors({...report(),issues:[{...report().issues[0],kind}]})).toEqual([]);
  expect(reviewReportErrors({...report(),issues:[{...report().issues[0],kind:'guess'}]})).toContain('issues[0].kind');
  expect(reviewReportErrors({...report(),issues:[{...report().issues[0],evidence_refs:[]}]})).toContain('issues[0].evidence_refs');
  expect(reviewReportErrors({...report(),issues:[{...report().issues[0],kind:'unverified',evidence_refs:[]}]})).toEqual([]);
 });
 it('旧报告仍使用1–3校验和原schema，不升级旧分数',()=>{
  const {schema_version,assessment_status,optional_suggestions,...value}=report();value.aes=1;value.issues=[];
  expect(reviewReportErrors(value,{schemaVersion:1})).toEqual([]);expect(reportScore(value)).toBe(7);
  expect(REVIEW_SCHEMA.properties.aes).toEqual({type:'integer'});
  expect(reviewSystemLegacy({redlines:'旧',positives:[],negatives:[]})).toContain('每项 1–3 分');
 });
});

describe('v2 同证据提示与复核',()=>{
 it('只以当前快照为评分标准，不带固定通过率、旧类型偏好或旧扣分上限',()=>{
  const text=reviewSystem({rules});expect(text).toContain(rules.rawDirection);expect(text).toContain(rules.rawScoring);expect(text).toContain(rules.id);
  for(const stale of ['通过的游戏大多恰好 7 分','三分之二是 2/2/2','最多让它所属的那一项少 1 分','游戏面向海外玩家'])expect(text).not.toContain(stale);
  for(const boundary of ['作者备注','体验评价','evidence_refs','optional_suggestions','动画变化不证明输入有效','不是录音','当前同一游戏的历史答案'])expect(text).toContain(boundary);
  expect(()=>reviewSystem({})).toThrow('快照缺失');
 });
 it('两阶段锁定v2 schema与相同原始前缀，只发布复核模型结果',async()=>{
  const draft=report(),final={...report(),aes:null,assessment_status:'needs_review',verdict:'待复核',uncertainties:['合成证据不足']};
  vi.mocked(complete).mockResolvedValueOnce(draft).mockResolvedValueOnce(final);
  const result=await generateReview({SETTINGS_KEY:'fixture',modelStore:{get:async()=>null}}, {}, {system:reviewSystem({rules}),user:'synthetic evidence',reportSchemaVersion:2,idempotencyKey:'synthetic-v2'});
  expect(result).toBe(final);const calls=vi.mocked(complete).mock.calls;
  expect(calls).toHaveLength(2);
  for(const call of calls){expect(call[2].schema).toBe(REVIEW_SCHEMA_V2);expect(call[2].system).toContain(REVIEW_VERIFICATION_V2);expect(call[2].validate?.({...report(),aes:'0'})).toContain('aes');}
  expect(calls[0][2].system).toBe(calls[1][2].system);expect(calls[1][2].user).toEqual([{type:'text',text:'synthetic evidence'},expect.objectContaining({text:expect.stringContaining(JSON.stringify(draft))})]);
 });
 it('实际报告HTML与Markdown区分零、未知和三类意见，转义证据内容',async()=>{
  vi.stubGlobal('document',{addEventListener:vi.fn()});vi.stubGlobal('addEventListener',vi.fn());
  const {reviewHtml,reportText}=await import('../public/forge/review-workspace.js');
  const value={title:'synthetic',score:6,result:report(),rules_snapshot:{id:rules.id,passScore:7},created_at:'2026-11-02T00:00:00Z'};
  expect(reportText(value)).toContain('美学 0/3');expect(reviewHtml(value)).toContain('>0<small> / 3');
  const unknown={...value,score:null,result:{...report(),aes:null,assessment_status:'needs_review',verdict:'待复核'}};
  const html=reviewHtml(unknown);expect(html).toContain('待判断');expect(html).toContain('待复核');expect(html).not.toContain('模拟通过');expect(html).not.toContain('建议修改');expect(reportText(unknown)).toContain('总分 待复核');expect(html).toContain(rules.id);
  const layered={...value,result:{...report(),issues:['confirmed','experience','unverified'].map(kind=>({...report().issues[0],kind,evidence:'<script>injection</script>'})),optional_suggestions:['可选细化']}};
  const rendered=reviewHtml(layered);for(const label of ['已证实缺陷','体验评价','待验证','验证方法','可选改善','可选细化','synthetic-start'])expect(rendered).toContain(label);expect(rendered).not.toContain('<script>injection');
 });
});
