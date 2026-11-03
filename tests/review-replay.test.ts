import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,writeFile,readFile,rm,stat,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {attachReplayAdaptive,aggregateReplayResults,createReplayPacks as createLockedReplayPacks,unlockReplayPack,lockReplayReview,createReplayAdjudicationPacks,replayTextFields,replayProbe,replayHash,replayModelConfig,selectReplayCalibration,validateReplayGroups,REPLAY_ARMS} from '../scripts/review-replay';
const dirs:string[]=[];afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const rules={rawDirection:'Synthetic current direction',rawScoring:'Synthetic 0–3 rubric',scoreMin:0,scoreMax:3,passScore:7};
const model={model:'synthetic-current-agent',provider:'agent',effort:'high',vision:true};
const report=()=>({schema_version:2,assessment_status:'complete',aes:0,ease:3,play:3,score_reasons:{aes:'Synthetic image',ease:'Synthetic action',play:'Synthetic observed cycle'},uncertainties:[],verdict:'打回：合成',reviewer_comment:'Synthetic',strengths:[],issues:[{kind:'confirmed',severity:'高',area:'synthetic',problem:'Synthetic claim',evidence:'frame-0',evidence_refs:['frame-0'],fix:'Synthetic fix'}],optional_suggestions:[],fix_prompt:'Synthetic fix'});
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'pgc-replay-synthetic-'));dirs.push(dir);
 const html='<!doctype html><title>Synthetic</title><canvas></canvas>';const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKfoAAAAASUVORK5CYII=','base64');
 await writeFile(join(dir,'input.html'),html);await writeFile(join(dir,'image.png'),png);
 const cal={split:'calibration',work_id:'cal-work',version_id:'cal-version',theme:'SECRET_THEME',author_notes:'SECRET_AUTHOR_NOTE'};
 const held={split:'heldout',work_id:'eval-work',version_id:'eval-version',sample_id:'heldout-SECRET_THEME',theme:'SECRET_THEME',author_notes:'SECRET_AUTHOR_NOTE',historical_reviews:[{comment:'SECRET_HELDOUT_COMMENT'}],local_html:'input.html',input_sha256:hash(html),screenshots:Array.from({length:5},()=>({path:'image.png',sha256:hash(png),label:'SECRET_THEME'})),baseline_probe:{captureMethod:'browser-viewport-v1',errors:['baseline runtime log'],actions:[{id:'base-action',type:'tap',x:10,y:20}],theme:'SECRET_THEME',author_notes:'SECRET_AUTHOR_NOTE',adaptive:{errors:['ADAPTIVE_ONLY_LOG']}},adaptive_probe:{rounds:1,actionCount:1,playMs:20,actions:[{id:'extra-action',type:'drag',x:10,y:20,toX:30,toY:40}],errors:['ADAPTIVE_ONLY_LOG'],firstLook:{observations:'SECRET_OLD_MODEL_ANSWER'},theme:'SECRET_THEME',author_notes:'SECRET_AUTHOR_NOTE'}};
 const card={work_id:'cal-work',version_id:'cal-version',sample_id:'cal-SECRET_THEME',theme:'SECRET_THEME',author_notes:'SECRET_AUTHOR_NOTE',source_records:[{record_id:'cal-record',stage:'unspecified',historical_scores:{aesthetics:2,ease_of_play:2,playability:2},historical_comment_original:'Permitted calibration clue',comment_state:'substantive_or_other',reviewer_name:'SECRET_REVIEWER'}],judgments:[{historical_quote:'Permitted calibration clue',model_interpretation_of_historical_clue:'Needs a sustained action to verify',evidence_needed:['actual action'],verification_actions:['hold and drag'],boundary:'not reproduced',modification_direction_if_supported:'fix only if observed',category_if_reproduced:'experience',claim_status:'historical_claim_not_reproduced',current_rule_mapping:{status:'fits_current_rule'},source_record_ids:['cal-record'],author_notes:'SECRET_AUTHOR_NOTE'}]};
 const input={manifest:{samples:[cal,held]},rules:{...rules,calibrationCases:[{title:'SECRET_HIDDEN_RULE_CASE'}]},calibration:{cases:[card]},modelConfig:model,out:join(dir,'packs'),base:dir};return {dir,html,cal,held,card,input};
}
async function createReplayPacks(input:any){const index=await createLockedReplayPacks(input);for(const r of index.runs){const first=join(r.visual_package,'..','look.json');await writeFile(first,JSON.stringify({packet_id:r.run_id,executor:'agent',observations:'Synthetic first impression',uncertainties:[]}));await unlockReplayPack({run:join(r.visual_package,'..'),firstLook:first});}return index;}
const run=(arm:string,override:any={})=>({run_id:'synthetic-'+arm,arm,work_id:'same-work',version_id:'same-version',input_sha256:hash('input'),rules_hash:replayHash(rules),model_config_hash:replayHash(model),status:'completed',report:report(),elapsed_ms:1000,adjudication:{executor:'human',adjudicator:'synthetic-adjudicator',checks:[{id:'candidate-a',kind:'candidate',reproduced:true,hit:true,evidence_refs:['action-1']},{id:'not-reproduced',kind:'candidate',reproduced:false,hit:false,evidence_refs:['action-2']},{id:'allegation-a',kind:'report_issue',report_issue_index:0,supported:false,evidence_refs:['action-1','frame-0']},{id:'suggestion-a',kind:'suggestion',causal:true,excessive_change:false,evidence_refs:['action-1']}],reference_scores:{aes:1,ease:3,play:null},score_evidence_refs:['frame-0','action-1']},...override});

describe('offline blind replay packs (synthetic files only)',()=>{
 it('generates three arms with identical version/rules/model and separates first images from source',async()=>{
  const s=await setup(),index=await createReplayPacks(s.input);expect(index.expected_runs).toBe(3);expect(index.ready_runs).toBe(3);
  const visual=JSON.parse(await readFile(index.runs[0].visual_package,'utf8'));const source=JSON.parse(await readFile(index.runs[0].source_package,'utf8'));
  expect(visual.phase).toBe('first_view');expect(JSON.stringify(visual)).not.toContain(s.html);expect(visual.screenshots).toHaveLength(1);expect(source.source.html).toBe(s.html);expect(source.gates.requires_saved_first_look).toBe('first-look.result.json');
  for(const r of index.runs){expect(r.input_sha256).toBe(s.held.input_sha256);expect(r.rules_hash).toBe(index.rules_hash);expect(r.model_config_hash).toBe(index.model_config_hash);const packet=JSON.parse(await readFile(r.source_package,'utf8'));expect(packet.calibration_cases).toHaveLength(r.arm==='baseline'?0:1);expect(packet.adaptive_play.enabled).toBe(r.arm==='newcaladaptive');}
  expect((await stat(s.input.out)).mode&0o777).toBe(0o700);expect((await stat(index.runs[0].source_package)).mode&0o777).toBe(0o600);
 });
 it('does not pass heldout history, strata, author/reviewer notes or implicit rule cases to evaluators',async()=>{
  const s=await setup(),index=await createReplayPacks(s.input);
  for(const r of index.runs)for(const file of [r.visual_package,r.source_package]){const text=await readFile(file,'utf8');for(const secret of ['SECRET_THEME','SECRET_AUTHOR_NOTE','SECRET_HELDOUT_COMMENT','SECRET_REVIEWER','SECRET_HIDDEN_RULE_CASE'])expect(text).not.toContain(secret);}
 });
 it('reports missing or mismatched HTML/hash and missing screenshots explicitly without source substitution',async()=>{
  const s=await setup();s.held.input_sha256=hash('different');s.held.screenshots=[];
  const index=await createReplayPacks(s.input);expect(index.ready_runs).toBe(0);expect(index.coverage.gap_runs).toBe(3);
  const packet=JSON.parse(await readFile(index.runs[0].source_package,'utf8'));expect(packet.source).toBeNull();expect(packet.gaps).toEqual(expect.arrayContaining([{stage:'source',reason:'sha256_mismatch'},{stage:'first_view',reason:'missing_first_view_screenshot'}]));
  delete (s.held as any).input_sha256;const nohash=await createReplayPacks({...s.input,out:join(s.dir,'nohash')});expect(nohash.runs[0].gaps).toContainEqual({stage:'source',reason:'missing_or_invalid_sha256'});
  s.held.input_sha256=hash(s.html);s.held.local_html='missing.html';const missing=await createReplayPacks({...s.input,out:join(s.dir,'missing')});expect(missing.runs[0].gaps).toContainEqual({stage:'source',reason:'missing_file'});
 });
 it('isolates first view, four baseline images/logs and adaptive images/actions by arm, with no stale file reuse',async()=>{
  const s=await setup(),index=await createReplayPacks(s.input);
  for(const r of index.runs){const first=JSON.parse(await readFile(r.visual_package,'utf8')),full=JSON.parse(await readFile(r.source_package,'utf8'));
   expect(first.screenshots).toHaveLength(1);expect(first.screenshots[0].id).toContain('first_view');expect(first.probe).toBeUndefined();
   expect(full.screenshots).toHaveLength(r.arm==='newcaladaptive'?5:4);expect(full.probe.errors).toEqual(['baseline runtime log']);
   const text=JSON.stringify(full);expect(text).not.toContain('SECRET_OLD_MODEL_ANSWER');
   if(r.arm==='newcaladaptive'){expect(full.adaptive_probe.errors).toEqual(['ADAPTIVE_ONLY_LOG']);expect(full.adaptive_probe.actions[0].type).toBe('drag');}
   else{expect(full.adaptive_probe).toBeUndefined();expect(text).not.toContain('ADAPTIVE_ONLY_LOG');expect(text).not.toContain('extra-action');expect(full.screenshots.some((x:any)=>x.source==='provided-adaptive-capture')).toBe(false);}
  }
  await expect(createReplayPacks(s.input)).rejects.toThrow('fresh --out');
 });
 it('uses a separately supplied first-view image and keeps missing adaptive evidence out of baseline readiness',async()=>{
  const s=await setup();const first=Buffer.concat([await readFile(join(s.dir,'image.png')),Buffer.from('independent-first-view')]);await writeFile(join(s.dir,'first.png'),first);
  (s.held as any).first_view_screenshots=[{path:'first.png',sha256:hash(first)}];s.held.screenshots[4].sha256=hash('missing adaptive bytes');
  const index=await createReplayPacks(s.input);expect(index.ready_runs).toBe(2);
  for(const r of index.runs){const visual=JSON.parse(await readFile(r.visual_package,'utf8'));expect(visual.screenshots[0].sha256).toBe(hash(first));
   if(r.arm==='newcaladaptive'){expect(r.ready).toBe(false);expect(r.gaps).toContainEqual({stage:'adaptive',frame:0,reason:'sha256_mismatch'});}
   else{expect(r.ready).toBe(true);expect(r.gaps).toEqual([]);}
  }
 });
 it('unmapped current-rule judgments block newcal readiness and are withheld, without blocking baseline',async()=>{
  const s=await setup();s.card.judgments[0].current_rule_mapping.status='unknown';
  const index=await createReplayPacks(s.input);expect(index.runs.find(r=>r.arm==='baseline').ready).toBe(true);
  for(const r of index.runs.filter(r=>r.arm!=='baseline')){expect(r.ready).toBe(false);expect(r.gaps).toContainEqual({stage:'calibration',reason:'calibration_rule_mapping_incomplete',unmapped_judgments:1});expect(JSON.parse(await readFile(r.source_package,'utf8')).calibration_cases).toEqual([]);}
 });
 it('uses production source representation while retaining the exact input hash and executable logic',async()=>{
  const s=await setup();const html='<!doctype html><img src="data:image/png;base64,'+'A'.repeat(2000)+'"><script>function actualLogic(){return 42}</script>';
  await writeFile(join(s.dir,'input.html'),html);s.held.input_sha256=hash(html);const index=await createReplayPacks(s.input);
  const source=JSON.parse(await readFile(index.runs[0].source_package,'utf8')).source;
  expect(source.sha256).toBe(hash(html));expect(source.representation).toBe('reviewSource-v1');expect(source.html).toContain('编码素材已省略');expect(source.html).toContain('function actualLogic(){return 42}');expect(source.html).not.toContain('A'.repeat(2000));
 });
 it('rejects group leakage, foreign cards, duplicate versions and secret model configuration',async()=>{
  const s=await setup();expect(()=>validateReplayGroups({samples:[s.cal,{...s.held,work_id:s.cal.work_id}]})).toThrow('Leakage');
  expect(()=>validateReplayGroups({samples:[s.held,s.held]})).toThrow('Duplicate');
  await expect(createReplayPacks({...s.input,calibration:{cases:[{...s.card,work_id:s.held.work_id,version_id:s.held.version_id}]}})).rejects.toThrow('Leakage');
  expect(selectReplayCalibration([s.card],s.card.work_id,new Map())).toEqual([]);
  expect(()=>replayModelConfig({...model,apiKey:'synthetic-secret'})).toThrow('non-secret');
 });
 it('passes adjudicated examples without private histories or historical reference scores',async()=>{
  const s=await setup();const verified={id:'counterexample-1',type:'counterexample',executor:'agent',adjudicator:'SECRET_REVIEWER',evidence_manifest_sha256:hash('synthetic evidence'),evidence_refs:['action:2','shot:3'],evidence_summary:'Observed restart',phenomenon:'Restart works',trigger:'Click result screen',cause:'Existing restart handler',rule_basis:'Current rule',minimal_change:null,retest:'Repeat result flow',limits:'Only this path',current_rule_mapping:{status:'fits_current_rule',reason:'Direct evidence'},reference_scores:{aes:2,ease:2,play:2},raw_history:'SECRET_HELDOUT_COMMENT'};
  Object.assign(verified,{origin:'new_observation',score_interpretation:'Explain limited experience without reference scores',source_record_ids:[],evidence_manifests:{main:{path:'/SECRET_PRIVATE_PATH',sha256:hash('synthetic evidence')}},additional_sources:[{path:'/SECRET_PRIVATE_SOURCE',sha256:hash('source excerpt'),read_scope:'handler',context_boundary:'Adjudication-only additional source'}]});
  (s.input as any).calibration={cases:[{...s.card,verified_cases:[verified]}]};const index=await createReplayPacks(s.input);
  for(const r of index.runs){const packet=JSON.parse(await readFile(r.source_package,'utf8'));if(r.arm==='baseline'){expect(packet.calibration_cases).toEqual([]);continue;}
   const card=packet.calibration_cases[0];expect(card.verified_cases[0].minimal_change).toBeNull();expect(card.verified_cases[0].evidence_summary).toBe('Observed restart');expect(card.verified_cases[0].evidence_manifests.main).toEqual({sha256:hash('synthetic evidence')});expect(card.verified_cases[0].score_interpretation).toContain('limited experience');expect(card.verified_cases[0].additional_sources[0].read_scope).toBe('handler');expect(card.historical_records).toBeUndefined();expect(JSON.stringify(card)).not.toContain('SECRET_');expect(JSON.stringify(card)).not.toContain('reference_scores');
  }
  expect(()=>selectReplayCalibration([{...s.card,verified_cases:[{...verified,evidence_refs:[]}]}],'target',new Map([['cal-work',new Set(['cal-version'])]]))).toThrow('provenance');
  const limited=selectReplayCalibration([{...s.card,verified_cases:[{...verified,limits:['Only the observed tutorial path','Intermittent match failures remain unconfirmed']}]}],'target',new Map([['cal-work',new Set(['cal-version'])]]));
  expect(limited[0].verified_cases![0].limits).toEqual(['Only the observed tutorial path','Intermittent match failures remain unconfirmed']);
 });
});

describe('explicit evidence adjudication aggregation',()=>{
 it('uses only reproduced evidence-backed candidate judgments and explicit quality labels; unknown is null',()=>{
  const result=aggregateReplayResults({runs:[run('baseline')]});const arm=result.arms.baseline;
  expect(arm.reproduced_candidate_hit_rate).toEqual({numerator:1,denominator:1,value:1});expect(arm.unsupported_allegation_rate.value).toBe(1);expect(arm.causal_suggestion_rate.value).toBe(1);expect(arm.excessive_change_rate.value).toBe(0);
  expect(arm.score_mae).toEqual({aes:{value:1,denominator:1},ease:{value:0,denominator:1},play:{value:null,denominator:0}});expect(result.arms.newcal.reproduced_candidate_hit_rate.value).toBeNull();expect(result.arms.newcal.failure_rate.value).toBeNull();
 });
 it('does not infer adjudications from report wording, history, absent references or absent labels',()=>{
  const noAdjudication=run('baseline',{adjudication:undefined});const result=aggregateReplayResults({runs:[noAdjudication]});expect(result.arms.baseline.unsupported_allegation_rate.value).toBeNull();expect(result.arms.baseline.score_mae.aes.value).toBeNull();
  const r=run('newcal');r.adjudication.checks.forEach((c:any)=>c.evidence_refs=[]);r.adjudication.score_evidence_refs=[];const empty=aggregateReplayResults({runs:[r]});for(const k of ['reproduced_candidate_hit_rate','unsupported_allegation_rate','causal_suggestion_rate','excessive_change_rate'])expect(empty.arms.newcal[k].value).toBeNull();
 });
 it('pairs only exact same input/version/rules/model and preserves missing paired metrics',()=>{
  const all=REPLAY_ARMS.map(a=>run(a));const paired=aggregateReplayResults({runs:all});expect(paired.paired.complete_groups).toBe(1);expect(paired.paired.groups[0].comparisons.newcal.score_mae_delta.play).toBeNull();
  for(const field of ['version_id','input_sha256','rules_hash','model_config_hash']){const altered=all.map(r=>({...r}));(altered[2] as any)[field]=field==='version_id'?'different-version':hash('different');expect(aggregateReplayResults({runs:altered}).paired.complete_groups).toBe(0);}
 });
 it('tracks failed/invalid/unsubmitted coverage and never substitutes a report or zero success',()=>{
  const a=run('baseline',{status:'failed',report:undefined,elapsed_ms:2500});const b=run('newcal',{report:{aes:0}});const plan={runs:[a,b,run('newcaladaptive')]};
  const result=aggregateReplayResults({plan,runs:[a,b]});expect(result.arms.baseline.failure_rate.value).toBe(1);expect(result.arms.newcal.coverage.invalid_reports).toBe(1);expect(result.arms.newcaladaptive.coverage.unsubmitted).toBe(1);expect(result.arms.newcaladaptive.failure_rate.value).toBeNull();expect(result.invalid_reports).toHaveLength(1);expect(result.paired.complete_groups).toBe(0);
  expect(()=>aggregateReplayResults({plan,runs:[{...a,input_sha256:hash('wrong')}]})).toThrow('identity');
 });
 it('rejects duplicate run/check IDs instead of inflating denominators',()=>{
  const a=run('baseline');expect(()=>aggregateReplayResults({runs:[a,a]})).toThrow('unique');a.adjudication.checks.push(a.adjudication.checks[0]);expect(()=>aggregateReplayResults({runs:[a]})).toThrow('check IDs');
 });
});

function strictFixture(){
 const exact={rules:hash('exact rules bytes'),prompt:hash('exact prompt bytes'),model_config:hash('exact config bytes')};const runs:any[]=[],catalogs:any[]=[];
 for(let i=0;i<12;i++){
  const catalog={work_id:'work-'+i,version_id:'version-'+i,input_sha256:hash('input-'+i),executor:'agent',adjudicator:'synthetic-blind-agent',complete:true,candidates:[{id:'candidate',verified:true,critical:true,evidence_refs:['verified-action']}]};catalogs.push(catalog);
  for(const arm of REPLAY_ARMS){const r:any={run_id:i+'-'+arm,arm,work_id:catalog.work_id,version_id:catalog.version_id,input_sha256:catalog.input_sha256,rules_hash:replayHash(rules),model_config_hash:replayHash(model),exact_file_hashes:exact,catalog_hash:replayHash(catalog),status:'completed',elapsed_ms:1000,report:report()};
   const frozen={schema_version:1,packet_id:r.run_id,input_sha256:r.input_sha256,rules_hash:r.rules_hash,model_config_hash:r.model_config_hash,exact_file_hashes:exact,files:[{path:'synthetic-file-'+r.run_id,sha256:hash('synthetic')} ]};
   r.execution={initial:{evidence_manifest:frozen,locked:true,execution_id:r.run_id+'-initial',model_config_hash:r.model_config_hash,evidence_hash:replayHash(frozen),report:r.report,report_sha256:replayHash(r.report)}};
   r.execution.verification={...r.execution.initial,execution_id:r.run_id+'-verification',draft_sha256:r.execution.initial.report_sha256};
   r.adjudication={executor:'agent',adjudicator:'blind-agent',complete:true,unresolved_disputes:[],fields:replayTextFields(r.report).map(f=>({path:f.path,sha256:f.sha256,atoms:f.text.length?[{id:f.path,start:0,end:f.text.length,text:f.text,kind:f.path==='/issues/0/problem'?'claim':f.path==='/fix_prompt'?'suggestion':'non_claim',reason:'Explicit synthetic judgment',assertion_scope:'none',assertion_basis:'not_applicable',...(f.path==='/issues/0/problem'||f.path==='/fix_prompt'?{assertion_scope:'negative_allegation',assertion_basis:'confirmed',supported:f.path==='/fix_prompt'||arm!=='baseline',mandatory:false,unverified:false,evidence_refs:['verified-action']}:{}),...(f.path==='/fix_prompt'?{causal:true,excessive_change:false}:{})}]:[]})),candidate_hits:[{candidate_id:'candidate',hit:true,claim_ids:['/fix_prompt'],evidence_refs:['verified-action']}],unknown_dimensions:[]};runs.push(r);
  }
 }
 return {schema_version:2,plan:{runs:runs.map(r=>({run_id:r.run_id,arm:r.arm,work_id:r.work_id,version_id:r.version_id,input_sha256:r.input_sha256,rules_hash:r.rules_hash,model_config_hash:r.model_config_hash,evidence_hash:r.execution.initial.evidence_hash,evidence_manifest:r.execution.initial.evidence_manifest})),exact_file_hashes:exact},catalogs,runs};
}

describe('enforced source gate and strict offline acceptance',()=>{
 it('writes no source before a valid locked first look and hides arm/history mapping',async()=>{
  const s=await setup(),index=await createLockedReplayPacks(s.input),r=index.runs[0];
  await expect(readFile(r.source_package)).rejects.toThrow();
  const visual=JSON.parse(await readFile(r.visual_package,'utf8'));expect(visual.arm).toBeUndefined();expect(visual.work_id).toBeUndefined();expect(visual.version_id).toBeUndefined();expect(r.visual_package).not.toContain('baseline');
  const first=join(s.dir,'first.json');await writeFile(first,JSON.stringify({observations:'no packet identity'}));
  await expect(unlockReplayPack({run:join(r.visual_package,'..'),firstLook:first})).rejects.toThrow('First look');await expect(readFile(r.source_package)).rejects.toThrow();
  const record={packet_id:r.run_id,executor:'agent',observations:'Synthetic first look',uncertainties:[]};await writeFile(first,JSON.stringify(record));await unlockReplayPack({run:join(r.visual_package,'..'),firstLook:first});
  expect(JSON.parse(await readFile(r.source_package,'utf8')).source.html).toBe(s.html);
  await writeFile(first,JSON.stringify({...record,observations:'replacement'}));await expect(unlockReplayPack({run:join(r.visual_package,'..'),firstLook:first})).rejects.toThrow('locked');
 });
 it('excludes replay_included:false from grouping, cases and every evaluation arm',async()=>{
  const s=await setup();const excluded={...s.cal,replay_included:false,work_id:'bomb',version_id:'bomb-version'};(s.input.manifest.samples as any[]).push(excluded,{...s.held,replay_included:false,work_id:'bomb',version_id:'bomb-version'});(s.input.calibration.cases as any[]).push({...s.card,...excluded});
  const index=await createReplayPacks(s.input);expect(index.expected_runs).toBe(3);expect(index.coverage.calibration_versions).toBe(1);expect(index.excluded_versions).toHaveLength(2);
  for(const r of index.runs)expect(JSON.parse(await readFile(r.source_package,'utf8')).calibration_cases).toHaveLength(r.arm==='baseline'?0:1);
 });
 it('passes only 12 full three-arm reviews with distinct same-model evidence-locked stages',()=>{
  const fixture=strictFixture(),result=aggregateReplayResults(fixture);expect(result.gate).toMatchObject({passed:true,reasons:[]});expect(result.paired.complete_groups).toBe(12);expect(result.arms.baseline.candidate.denominator).toBe(12);expect(result.arms.newcaladaptive.candidate.denominator).toBe(12);
  fixture.runs[0].execution.verification.execution_id=fixture.runs[0].execution.initial.execution_id;expect(aggregateReplayResults(fixture).gate.passed).toBe(false);
 });
 it('rejects missing review stages, files, elapsed, atom paths, omitted candidate mappings and mixed catalogs',()=>{
  for(const mutate of [(f:any)=>delete f.runs[0].execution.verification,(f:any)=>delete f.runs[0].elapsed_ms,(f:any)=>f.runs[0].adjudication.fields.shift(),(f:any)=>f.runs[0].adjudication.candidate_hits.pop(),(f:any)=>f.runs.pop()]){const f=strictFixture();mutate(f);expect(aggregateReplayResults(f).gate.passed).toBe(false);}
  const mixed=strictFixture();mixed.runs[2].catalog_hash=hash('different catalog');expect(()=>aggregateReplayResults(mixed)).toThrow('canonical catalog');
  const file=strictFixture();file.runs[0].exact_file_hashes={...file.runs[0].exact_file_hashes,prompt:hash('changed')};expect(()=>aggregateReplayResults(file)).toThrow('file hashes');
  const missing=strictFixture();missing.catalogs.pop();expect(()=>aggregateReplayResults(missing)).toThrow('exactly cover');
 });
 it('never uses missing denominators or a zero baseline as evidence of improvement',()=>{
  const f=strictFixture();for(const r of f.runs)r.adjudication.fields.find((x:any)=>x.path==='/issues/0/problem').atoms[0].supported=true;
  expect(aggregateReplayResults(f).gate.reasons).toContain('baseline_zero_cannot_claim_reduction');
  for(const c of f.catalogs)c.candidates=[];for(const r of f.runs){r.catalog_hash=replayHash(f.catalogs.find(c=>c.work_id===r.work_id));r.adjudication.candidate_hits=[];}
  expect(aggregateReplayResults(f).gate.reasons).toContain('zero_denominator:newcaladaptive:candidate');
 });
 it('fails unsupported mandatory changes, lost critical hits and increased excessive changes',()=>{
  const f=strictFixture(),c=f.runs[2];c.adjudication.fields.find((x:any)=>x.path==='/issues/0/problem').atoms[0].supported=false;c.adjudication.fields.find((x:any)=>x.path==='/issues/0/problem').atoms[0].mandatory=true;
  c.adjudication.candidate_hits=[{candidate_id:'candidate',hit:false}];c.adjudication.fields.find((x:any)=>x.path==='/fix_prompt').atoms[0].excessive_change=true;
  const reasons=aggregateReplayResults(f).gate.reasons;expect(reasons).toContain('invalid_mandatory_changes_in_C');expect(reasons.some((x:string)=>x.startsWith('critical_hit_lost'))).toBe(true);expect(reasons).toContain('excessive_changes_increased');
 });
 it('requires itemized accepted evidence for increased unverified claims',()=>{
  const f=strictFixture(),c=f.runs[2],atom=c.adjudication.fields.find((x:any)=>x.path==='/issues/0/problem').atoms[0];atom.unverified=true;atom.assertion_basis='unverified';
  expect(aggregateReplayResults(f).gate.reasons.some((x:string)=>x.startsWith('unexplained_unverified_increase'))).toBe(true);
  c.adjudication.comparative_explanations=f.runs.slice(0,2).map(r=>({against_run_id:r.run_id,kind:'unverified',item:atom.id,accepted:true,reason:'Independent evidence explains narrower claim',evidence_refs:['actual-action']}));expect(aggregateReplayResults(f).gate.passed).toBe(true);
 });
 it('requires exact complete text spans with explicit classifications, including summary and fix prompt',()=>{
  const f=strictFixture();const atom=f.runs[0].adjudication.fields.find((x:any)=>x.path==='/fix_prompt').atoms[0];atom.end--;
  expect(()=>aggregateReplayResults(f)).toThrow('exact text');
  const legacy=aggregateReplayResults({runs:[run('baseline')]});expect(legacy.legacy).toBe(true);expect(legacy.gate_eligible).toBe(false);
 });
});


describe('immutable review records and blinded adjudicator packets',()=>{
 it('locks separate initial and verification records against evidence/model changes',async()=>{
  const s=await setup(),index=await createReplayPacks(s.input),r=index.runs[0],folder=join(r.visual_package,'..');
  const resultPath=join(s.dir,'result.json'),evidence=r.source_package;
  const payload={execution_id:'initial-call',model_config_hash:r.model_config_hash,report:report()};await writeFile(resultPath,JSON.stringify(payload));
  const initial=await lockReplayReview({run:folder,stage:'initial',result:resultPath,evidence});
  await writeFile(resultPath,JSON.stringify({...payload,draft_sha256:initial.report_sha256}));await expect(lockReplayReview({run:folder,stage:'verification',result:resultPath,evidence})).rejects.toThrow('separate execution');
  await writeFile(resultPath,JSON.stringify({...payload,execution_id:'verification-call',draft_sha256:initial.report_sha256}));const verified=await lockReplayReview({run:folder,stage:'verification',result:resultPath,evidence});expect(verified.evidence_hash).toBe(initial.evidence_hash);
  await writeFile(resultPath,JSON.stringify({...payload,execution_id:'another-initial'}));await expect(lockReplayReview({run:folder,stage:'initial',result:resultPath,evidence})).rejects.toThrow('immutable');
 });
 it('exports report text paths and opaque report IDs while root retains private mapping',async()=>{
  const f=strictFixture(),s=await setup(),out=join(s.dir,'blind');const result=await createReplayAdjudicationPacks({...f,out});
  expect(result.packets).toHaveLength(12);const packet=JSON.parse(await readFile(result.packets[0].path,'utf8'));const text=JSON.stringify(packet);
  for(const secret of ['baseline','newcal','work-0','version-0'])expect(text).not.toContain(secret);
  expect(packet.reports).toHaveLength(3);expect(packet.reports[0].text_fields.map((x:any)=>x.path)).toContain('/fix_prompt');expect(await readFile(result.private_mapping,'utf8')).toContain('newcaladaptive');
 });
 it('requires per-dimension explanations when unknown scores increase',()=>{
  const f=strictFixture(),c=f.runs[2];c.report.aes=null;c.report.assessment_status='needs_review';c.report.verdict='待复核：合成';c.report.uncertainties=['Unobserved dimension'];
  const old=new Map(c.adjudication.fields.map((x:any)=>[x.path,x]));c.adjudication.fields=replayTextFields(c.report).map(field=>{const prior:any=old.get(field.path);return {...field,atoms:[{id:field.path,start:0,kind:'non_claim',reason:'Explicit metadata judgment',assertion_scope:'none',assertion_basis:'not_applicable',...(prior?.atoms[0]??{}),end:field.text.length,text:field.text}]};});
  for(const stage of ['initial','verification'])c.execution[stage].report_sha256=replayHash(c.report);c.execution.verification.draft_sha256=c.execution.initial.report_sha256;
  c.adjudication.unknown_dimensions=[{dimension:'aes',reason:'No visual basis',evidence_refs:['actual-action']}];
  expect(aggregateReplayResults(f).gate.reasons.some((x:string)=>x.startsWith('unexplained_unknown_increase'))).toBe(true);
  c.adjudication.comparative_explanations=f.runs.slice(0,2).map(r=>({against_run_id:r.run_id,kind:'unknown',item:'aes',accepted:true,reason:'Explicit evidence supports preserving unknown',evidence_refs:['actual-action']}));const result=aggregateReplayResults(f);expect(result.gate.passed).toBe(true);expect(result.paired.groups[0].comparisons.C_vs_A.score_delta).toEqual({aes:null,ease:0,play:0});
 });
 it('shows B/A, C/B and C/A per-game changes and critical losses without aggregate cancellation',()=>{
  const f=strictFixture();f.runs[1].adjudication.candidate_hits=[{candidate_id:'candidate',hit:false}];const result=aggregateReplayResults(f);
  expect(Object.keys(result.paired.groups[0].comparisons)).toEqual(['B_vs_A','C_vs_B','C_vs_A']);expect(result.paired.groups[0].comparisons.B_vs_A.critical_lost).toEqual(['candidate']);expect(result.paired.critical_regressions[0].comparison).toBe('B_vs_A');expect(result.paired.groups[0].comparisons.C_vs_B.critical_gained).toEqual(['candidate']);
  expect(result.paired.groups[0].comparisons.B_vs_A.score_delta).toEqual({aes:0,ease:0,play:0});
 });
});


describe('factual replay provenance and file integrity',()=>{
 it('keeps continuous drag timing/errors/image links and shot offsets without hypotheses or old answers',async()=>{
  const s=await setup();const action={id:'drag-1',type:'drag',path:[{x:1,y:2,atMs:0,capture:true,hypothesis:'SECRET_HYPOTHESIS'},{x:3,y:4,atMs:500,capture:false}],trajectoryMethod:'linear-interpolation-50ms-v1',error:'touch ended early',beforeImageId:'before',afterImageId:'after',hypothesis:'SECRET_HYPOTHESIS',answer:'SECRET_ANSWER'};
  (s.held as any).adaptive_probe.actions=[action];s.held.screenshots[4]={...s.held.screenshots[4],actionOffsetMs:510,requestedOffsetMs:500} as any;
  const index=await createReplayPacks(s.input),r=index.runs.find(r=>r.arm==='newcaladaptive'),packet=JSON.parse(await readFile(r.source_package,'utf8'));
  expect(packet.adaptive_probe.actions[0]).toMatchObject({path:[{x:1,y:2,atMs:0,capture:true},{x:3,y:4,atMs:500,capture:false}],trajectoryMethod:'linear-interpolation-50ms-v1',error:action.error,beforeImageId:'before',afterImageId:'after'});
  expect(packet.screenshots[4]).toMatchObject({actionOffsetMs:510,requestedOffsetMs:500});expect(JSON.stringify(packet)).not.toContain('SECRET_HYPOTHESIS');expect(JSON.stringify(packet)).not.toContain('SECRET_ANSWER');
  expect(replayProbe({captureMethod:'browser-viewport-v1',actions:[action]})?.actions[0]).toMatchObject({path:packet.adaptive_probe.actions[0].path});
 });
 it('rejects arbitrary evidence and another run or input manifest before initial lock',async()=>{
  const s=await setup(),index=await createReplayPacks(s.input),[r,other]=index.runs,folder=join(r.visual_package,'..'),result=join(s.dir,'result.json'),evidence=join(s.dir,'manifest.json');
  await writeFile(result,JSON.stringify({execution_id:'initial',model_config_hash:r.model_config_hash,report:report()}));await writeFile(evidence,'arbitrary string');
  await expect(lockReplayReview({run:folder,stage:'initial',result,evidence})).rejects.toThrow('this run stage2');
  await expect(lockReplayReview({run:folder,stage:'initial',result,evidence:other.source_package})).rejects.toThrow('bind this packet');
  const foreign=await setup(),foreignHtml='<!doctype html><title>Another synthetic game</title>';await writeFile(join(foreign.dir,'input.html'),foreignHtml);foreign.held.input_sha256=hash(foreignHtml);const otherGame=(await createReplayPacks(foreign.input)).runs[0];
  await writeFile(evidence,JSON.stringify({packet_id:r.run_id,input_sha256:otherGame.input_sha256,locked:true,files:[{path:otherGame.source_package,sha256:hash(await readFile(otherGame.source_package))}]}));
  await expect(lockReplayReview({run:folder,stage:'initial',result,evidence})).rejects.toThrow('bind this packet');
  await expect(readFile(join(folder,'initial.lock.json'))).rejects.toThrow();
 });
 it('detects changes to a valid manifest member before initial and after initial, including JPEG bytes',async()=>{
  const s=await setup(),index=await createReplayPacks(s.input),r=index.runs[0],folder=join(r.visual_package,'..'),result=join(s.dir,'result.json'),evidence=join(s.dir,'manifest.json'),jpg=join(s.dir,'supplement.jpg');
  const jpeg=Buffer.from([255,216,255,217]);await writeFile(jpg,jpeg);await writeFile(evidence,JSON.stringify({packet_id:r.run_id,input_sha256:r.input_sha256,locked:true,files:[{path:jpg,sha256:hash(jpeg)}]}));
  const payload={execution_id:'initial',model_config_hash:r.model_config_hash,report:report()};await writeFile(result,JSON.stringify(payload));
  await writeFile(jpg,Buffer.from([255,216,1,217]));await expect(lockReplayReview({run:folder,stage:'initial',result,evidence})).rejects.toThrow('file hash mismatch');
  await writeFile(jpg,jpeg);const initial=await lockReplayReview({run:folder,stage:'initial',result,evidence});
  const updated=JSON.parse(await readFile(join(s.input.out,'pack-index.json'),'utf8')),planned=updated.runs.find((p:any)=>p.run_id===r.run_id);expect(planned.evidence_hash).toBe(initial.evidence_hash);expect(replayHash(planned.evidence_manifest)).toBe(initial.evidence_hash);
  await writeFile(result,JSON.stringify({...payload,execution_id:'verify',draft_sha256:initial.report_sha256}));await writeFile(jpg,Buffer.from([255,216,3,217]));await expect(lockReplayReview({run:folder,stage:'verification',result,evidence})).rejects.toThrow('file hash mismatch');
 });
 it('rejects stage2 modification before initial and any packet image replacement after initial',async()=>{
  const s=await setup(),index=await createReplayPacks(s.input),r=index.runs[0],folder=join(r.visual_package,'..'),result=join(s.dir,'result.json');
  const payload={execution_id:'initial',model_config_hash:r.model_config_hash,report:report()};await writeFile(result,JSON.stringify(payload));
  const original=await readFile(r.source_package,'utf8'),packet=JSON.parse(original);packet.probe.errors.push('injected evidence');await writeFile(r.source_package,JSON.stringify(packet));
  await expect(lockReplayReview({run:folder,stage:'initial',result,evidence:r.source_package})).rejects.toThrow('stage2 source packet changed');await writeFile(r.source_package,original);
  const initial=await lockReplayReview({run:folder,stage:'initial',result,evidence:r.source_package});await writeFile(result,JSON.stringify({...payload,execution_id:'verify',draft_sha256:initial.report_sha256}));await writeFile(join(folder,packet.screenshots[0].path),'changed pixels');
  await expect(lockReplayReview({run:folder,stage:'verification',result,evidence:r.source_package})).rejects.toThrow('file hash mismatch');
 });
 it('rejects equal stage evidence hashes that are absent from or differ from the planned frozen digest',()=>{
  const f=strictFixture();f.runs[0].execution.initial.evidence_hash=hash('unrelated');f.runs[0].execution.verification.evidence_hash=hash('unrelated');expect(aggregateReplayResults(f).gate.passed).toBe(false);
  const missing=strictFixture();delete missing.plan.runs[0].evidence_hash;expect(aggregateReplayResults(missing).gate.passed).toBe(false);
 });
});


function withoutCSuggestions(){
 const f=strictFixture();
 for(const c of f.runs.filter(r=>r.arm==='newcaladaptive')){
  c.report.fix_prompt='';c.report.issues[0].fix='';
  for(const path of ['/fix_prompt','/issues/0/fix']){const field=c.adjudication.fields.find((x:any)=>x.path===path);field.sha256=replayHash('');field.atoms=[];}
  c.adjudication.candidate_hits[0].claim_ids=['/issues/0/problem'];
  for(const stage of ['initial','verification'])c.execution[stage].report_sha256=replayHash(c.report);c.execution.verification.draft_sha256=c.execution.initial.report_sha256;
 }
 return f;
}
describe('no-suggestion acceptance without fabricated rate denominators',()=>{
 it('allows fully adjudicated C with no suggestions while preserving null causal/excessive rates',()=>{
  const result=aggregateReplayResults(withoutCSuggestions());
  expect(result.gate.passed).toBe(true);expect(result.arms.newcaladaptive.causal).toEqual({numerator:0,denominator:0,value:null});expect(result.arms.newcaladaptive.excessive).toEqual({numerator:0,denominator:0,value:null});
  expect(result.gate.comparisons).toHaveLength(2);for(const comparison of result.gate.comparisons)expect(comparison).toMatchObject({method:'count_only_no_suggestions',candidate_count:0,candidate_rate:null,adjudications_complete:true,passed:true});
 });
 it('still fails an omitted suggestion field and does not interpret incomplete adjudication as no suggestions',()=>{
  const f=withoutCSuggestions(),a=f.runs[0];a.adjudication.fields=a.adjudication.fields.filter((field:any)=>field.path!=='/fix_prompt');a.adjudication.candidate_hits[0].hit=false;
  const result=aggregateReplayResults(f);expect(result.gate.passed).toBe(false);expect(result.gate.reasons).toContain(a.run_id+':unadjudicated_text:/fix_prompt');expect(result.gate.comparisons.find((c:any)=>c.against==='baseline').adjudications_complete).toBe(false);
 });
});


it('rejects unsupported-rate dilution when the absolute number of unsupported assertions does not decrease',()=>{
 const f=strictFixture();for(const r of f.runs.filter(r=>r.arm==='newcaladaptive')){
  r.adjudication.fields.find((field:any)=>field.path==='/issues/0/problem').atoms[0].supported=false;
  Object.assign(r.adjudication.fields.find((field:any)=>field.path==='/reviewer_comment').atoms[0],{kind:'claim',assertion_scope:'negative_allegation',assertion_basis:'confirmed',supported:true,mandatory:false,unverified:false,evidence_refs:['actual-action']});
 }
 const result=aggregateReplayResults(f);expect(result.arms.newcaladaptive.unsupported_negative_allegations.value).toBeLessThan(result.arms.baseline.unsupported_negative_allegations.value);expect(result.arms.newcaladaptive.unsupported_negative_allegations.numerator).toBe(result.arms.baseline.unsupported_negative_allegations.numerator);expect(result.gate.passed).toBe(false);expect(result.gate.reasons).toContain('unsupported_negative_count_not_reduced');expect(result.gate.unsupported_comparison).toMatchObject({method:'count_and_rate',candidate_count:12,comparison_count:12,candidate_denominator:36,comparison_denominator:24,passed:false});
});


// Only synthetic local artifacts: no model/browser calls are needed to exercise
// attachment identity, complete provenance and the initial/verification freeze.
async function adaptiveAttachmentFixture(){
 const s=await setup();
 for(let i=0;i<4;i++){const bytes=Buffer.concat([await readFile(join(s.dir,'image.png')),Buffer.from('baseline-'+i)]),path='base-'+i+'.png';await writeFile(join(s.dir,path),bytes);s.held.screenshots[i]={...s.held.screenshots[i],path,sha256:hash(bytes)};}
 const index=await createReplayPacks(s.input),plan=index.runs.find(r=>r.arm==='newcaladaptive'),folder=join(plan.visual_package,'..'),session=join(s.dir,'session');await mkdir(session);
 const packet=JSON.parse(await readFile(plan.source_package,'utf8'));
 const baseline:any[]=[];
 for(const [i,shot] of packet.screenshots.slice(0,4).entries()){const path=join(session,'baseline-'+i+'.jpg');await writeFile(path,await readFile(join(folder,shot.path)));baseline.push({id:'base-'+i,path,imageSha256:shot.sha256});}
 const image=Buffer.from([255,216,255,217]),imagePath=join(session,'play.jpg');await writeFile(imagePath,image);
 const shots=[{id:'play-1',path:imagePath,imageSha256:hash(image),capturedAt:'2026-11-03T00:00:00Z',actionRefs:[]}];
 const first={imageSha256:hash(image),sourceBlind:true,observations:'Synthetic fresh first look',uncertainties:[],recordedAt:'2026-11-03T00:00:01Z',preDisclosureActionCount:0};
 const disclosure={recordedAt:'2026-11-03T00:00:02Z',actionCount:0};
 const record:any={sessionId:'synthetic-session',inputHash:plan.input_sha256,contextOrigin:'source-blind-adaptive',sourceBlind:true,source:packet.source.html,baseline:{contextOrigin:'independent-basic-capture',screenshots:baseline,probe:s.held.baseline_probe},screenshots:shots,adaptive:{firstLook:first,sourceDisclosure:disclosure,rounds:1,actionCount:1,playMs:180000,actions:[{id:'new-action',type:'tap',x:20,y:20}],errors:['FRESH_ADAPTIVE_LOG']}};
 const analysis:any={contextOrigin:'source-blind-adaptive',sourceBlind:true,inputHash:plan.input_sha256,source:record.source,sourceDisclosure:disclosure,screenshots:baseline};
 const manifestPath=join(session,'manifest.json');
 const save=async(omit:string[]=[])=>{await writeFile(join(session,'first-look.json'),JSON.stringify(record.adaptive.firstLook));await writeFile(join(session,'analysis.json'),JSON.stringify(analysis));await writeFile(join(session,'evidence.json'),JSON.stringify(record));const paths=[join(session,'evidence.json'),join(session,'first-look.json'),join(session,'analysis.json'),...baseline.map(s=>s.path),...record.screenshots.map((s:any)=>s.path)].filter(p=>!omit.includes(p));const files=[];for(const path of paths)files.push({path,sha256:hash(await readFile(path))});await writeFile(manifestPath,JSON.stringify({locked:true,contextOrigin:'source-blind-adaptive',sourceBlind:true,sessionId:record.sessionId,inputHash:record.inputHash,files}));};
 await save();return {...s,index,plan,folder,session,packet,record,analysis,manifestPath,save,attach:()=>attachReplayAdaptive({run:folder,manifest:manifestPath})};
}

describe('C-only real-session replay attachment',()=>{
 it('attaches idempotently without changing A/B or the four baseline bytes and freezes every original file for both stages',async()=>{
  const f=await adaptiveAttachmentFixture(),siblings=f.index.runs.filter(r=>r.arm!=='newcaladaptive');
  const before=await Promise.all(siblings.map(r=>readFile(r.source_package,'utf8')));
  const initialResult=await f.attach(),once=await readFile(f.plan.source_package,'utf8');expect(await f.attach()).toEqual(initialResult);expect(await readFile(f.plan.source_package,'utf8')).toBe(once);
  const packet=JSON.parse(once);expect(packet.screenshots.slice(0,4)).toEqual(f.packet.screenshots.slice(0,4));expect(packet.adaptive_probe.errors).toEqual(['FRESH_ADAPTIVE_LOG']);expect(once).not.toContain('Synthetic fresh first look');
  for(const [i,r] of siblings.entries()){expect(await readFile(r.source_package,'utf8')).toBe(before[i]);expect(before[i]).not.toContain('FRESH_ADAPTIVE_LOG');await expect(attachReplayAdaptive({run:join(r.visual_package,'..'),manifest:f.manifestPath})).rejects.toThrow('only before');}
  const result=join(f.dir,'result.json');await writeFile(result,JSON.stringify({execution_id:'initial',model_config_hash:f.plan.model_config_hash,report:report()}));
  const initial=await lockReplayReview({run:f.folder,stage:'initial',result,evidence:f.plan.source_package});
  const manifest=JSON.parse(await readFile(f.manifestPath,'utf8'));for(const file of manifest.files)expect(initial.evidence_manifest.files).toContainEqual(file);
  await expect(f.attach()).rejects.toThrow('only before');
  await writeFile(result,JSON.stringify({execution_id:'verify',model_config_hash:f.plan.model_config_hash,draft_sha256:initial.report_sha256,report:report()}));
  const verification=await lockReplayReview({run:f.folder,stage:'verification',result,evidence:f.plan.source_package});expect(verification.evidence_hash).toBe(initial.evidence_hash);
 });
 it.each(['input','baseline-order','baseline-bytes','blind','source-blind-flag','analysis-context','timing','first-look-file','analysis-file','baseline-file','supplement-file','session','source','observations'] as const)('rejects invalid session provenance: %s',async(kind)=>{
  const f=await adaptiveAttachmentFixture();let omit:string[]=[];
  if(kind==='input')f.record.inputHash=hash('different input');
  if(kind==='baseline-order')f.record.baseline.screenshots.reverse();
  if(kind==='baseline-bytes')await writeFile(f.record.baseline.screenshots[0].path,'changed bytes');
  if(kind==='blind')f.record.contextOrigin='informed-verification';
  if(kind==='source-blind-flag')f.record.sourceBlind=false;
  if(kind==='analysis-context')f.analysis.contextOrigin='informed-verification';
  if(kind==='timing')f.record.adaptive.firstLook.recordedAt='2026-11-03T00:00:03Z';
  if(kind==='first-look-file')omit=[join(f.session,'first-look.json')];
  if(kind==='analysis-file')omit=[join(f.session,'analysis.json')];
  if(kind==='baseline-file')omit=[f.record.baseline.screenshots[0].path];
  if(kind==='supplement-file')omit=[f.record.screenshots[0].path];
  if(kind==='source')f.record.source='changed source';
  if(kind==='observations')f.record.baseline.probe={...f.record.baseline.probe,errors:['changed logs']};
  await f.save(omit);
  if(kind==='session'){const m=JSON.parse(await readFile(f.manifestPath,'utf8'));m.sessionId='another-session';await writeFile(f.manifestPath,JSON.stringify(m));}
  await expect(f.attach()).rejects.toThrow();expect(await readFile(f.plan.source_package,'utf8')).toBe(JSON.stringify(f.packet,null,2)+'\n');
 });
 it.each([['rounds',7],['rounds',-1],['rounds',1.5],['actionCount',25],['actionCount',0],['playMs',180001],['playMs',-1],['playMs',null],['rounds',undefined]] as const)('enforces finite protocol counters: %s=%s',async(key,value)=>{
  const f=await adaptiveAttachmentFixture();f.record.adaptive[key]=value;await f.save();await expect(f.attach()).rejects.toThrow('bounded play protocol');
 });
 it('accepts all exact upper bounds but rejects the thirteenth image',async()=>{
  const f=await adaptiveAttachmentFixture();f.record.adaptive.rounds=6;f.record.adaptive.actionCount=24;f.record.adaptive.actions=Array.from({length:24},(_,i)=>({id:'a-'+i,type:'tap',x:1,y:1}));f.record.screenshots=Array.from({length:12},(_,i)=>({...f.record.screenshots[0],id:'s-'+i}));await f.save();await expect(f.attach()).resolves.toMatchObject({supplemental_images:12});
  f.record.screenshots.push({...f.record.screenshots[0],id:'thirteenth'});await f.save();await expect(f.attach()).rejects.toThrow('bounded play protocol');
 });
 it('rejects a changed unlocked source packet before attachment can launder it',async()=>{
  const f=await adaptiveAttachmentFixture(),modified={...f.packet,source:{...f.packet.source,html:'replaced source'}};await writeFile(f.plan.source_package,JSON.stringify(modified));await expect(f.attach()).rejects.toThrow('stage2 source packet changed');
 });
 it.each(['analysis.json','first-look.json','baseline-0.jpg','play.jpg','evidence.json','manifest.json'])('revalidates original %s at lock time after attachment',async name=>{
  const f=await adaptiveAttachmentFixture();await f.attach();await writeFile(join(f.session,name),'changed original');
  const result=join(f.dir,'result.json');await writeFile(result,JSON.stringify({execution_id:'initial',model_config_hash:f.plan.model_config_hash,report:report()}));await expect(lockReplayReview({run:f.folder,stage:'initial',result,evidence:f.plan.source_package})).rejects.toThrow('hash mismatch');
 });
 it('resumes the committed attachment journal when interrupted before atomic stage2 replacement',async()=>{
  const f=await adaptiveAttachmentFixture(),prior=await readFile(f.plan.source_package,'utf8');
  const attached=await f.attach(),complete=await readFile(f.plan.source_package,'utf8');
  // Simulate the only partial commit state: control journal committed, stage2
  // still contains its exact previously validated original bytes.
  await writeFile(f.plan.source_package,prior);await expect(f.attach()).resolves.toEqual(attached);expect(await readFile(f.plan.source_package,'utf8')).toBe(complete);
  await writeFile(f.plan.source_package,prior.replace('baseline runtime log','modified baseline runtime log'));await expect(f.attach()).rejects.toThrow('stage2 source packet changed');
 });
 it('refuses replacing an attached session even before scoring',async()=>{
  const f=await adaptiveAttachmentFixture();await f.attach();f.record.adaptive.errors.push('new session content');await f.save();await expect(f.attach()).rejects.toThrow();
 });
});


describe('explicit negative allegations versus all report assertions',()=>{
 const atom=(r:any,path:string)=>r.adjudication.fields.find((f:any)=>f.path===path).atoms[0];
 const assertion=(scope:string,supported:boolean)=>({kind:'claim',assertion_scope:scope,assertion_basis:'confirmed',supported,mandatory:false,unverified:false,evidence_refs:['synthetic-observation']});
 it('does not call fewer unsupported strengths an improvement when baseline negative errors are zero',()=>{
  const f=strictFixture();
  for(const r of f.runs){
   atom(r,'/issues/0/problem').supported=true;
   r.report.strengths=['Synthetic positive assertion'];
   const text=r.report.strengths[0];r.adjudication.fields.push({path:'/strengths/0',sha256:replayHash(text),atoms:[{id:'/strengths/0',start:0,end:text.length,text,reason:'Blind semantic judgment: positive assertion, not a defect allegation',...assertion('positive_assertion',r.arm!=='baseline')}]});
   for(const stage of ['initial','verification'])r.execution[stage].report_sha256=replayHash(r.report);
   r.execution.verification.draft_sha256=r.execution.initial.report_sha256;
  }
  const result=aggregateReplayResults(f);
  expect(result.arms.baseline.unsupported_assertions.numerator).toBe(12);
  expect(result.arms.newcaladaptive.unsupported_assertions.numerator).toBe(0);
  expect(result.arms.baseline.unsupported_negative_allegations.numerator).toBe(0);
  expect(result.arms.newcaladaptive.unsupported_negative_allegations.numerator).toBe(0);
  expect(result.gate.passed).toBe(false);expect(result.gate.reasons).toContain('baseline_zero_cannot_claim_reduction');
  expect(result.gate.unsupported_comparison.passed).toBe(false);
 });
 it('keeps unsupported positive and neutral assertions descriptive, outside the negative gate and paired metric',()=>{
  const f=strictFixture();const before=aggregateReplayResults(f);
  for(const r of f.runs.filter(r=>r.arm==='newcaladaptive')){
   Object.assign(atom(r,'/score_reasons/aes'),assertion('positive_assertion',false));
   Object.assign(atom(r,'/reviewer_comment'),assertion('neutral_assertion',false));
  }
  const result=aggregateReplayResults(f);
  expect(result.arms.newcaladaptive.unsupported_assertions.numerator).toBe(24);
  expect(result.arms.newcaladaptive.unsupported_negative_allegations).toEqual(before.arms.newcaladaptive.unsupported_negative_allegations);
  expect(result.paired.groups[0].comparisons.C_vs_A.unsupported_negative_allegations_rate_delta).toBe(before.paired.groups[0].comparisons.C_vs_A.unsupported_negative_allegations_rate_delta);
  expect(result.paired.groups[0].comparisons.C_vs_A.unsupported_assertions_rate_delta).not.toBe(before.paired.groups[0].comparisons.C_vs_A.unsupported_assertions_rate_delta);
  expect(result.gate.passed).toBe(true);
 });
 it('counts defects explicitly adjudicated as implied by suggestions as negative allegations',()=>{
  const f=strictFixture(),r=f.runs[2],a=atom(r,'/fix_prompt');
  Object.assign(a,{supported:false,mandatory:true,assertion_basis:'unverified',unverified:true,reason:'Blind semantic judgment: this directive presupposes a missing function without evidence'});
  r.adjudication.candidate_hits[0].claim_ids=['/issues/0/problem'];
  const result=aggregateReplayResults(f);
  expect(result.arms.newcaladaptive.unsupported_negative_allegations.numerator).toBe(1);
  expect(result.arms.newcaladaptive.invalid_mandatory_changes).toBe(1);
  expect(result.gate.reasons).toContain('invalid_mandatory_changes_in_C');
 });
 it('rejects mandatory changes based on experience, unverified assertions, or nonnegative assertions even if marked supported',()=>{
  for(const [scope,basis] of [['negative_allegation','experience'],['negative_allegation','unverified'],['positive_assertion','confirmed'],['neutral_assertion','confirmed']]){
   const f=strictFixture(),r=f.runs[2],a=atom(r,'/issues/0/problem');
   Object.assign(a,{mandatory:true,supported:true,assertion_scope:scope,assertion_basis:basis,unverified:basis==='unverified'});
   const result=aggregateReplayResults(f);expect(result.arms.newcaladaptive.invalid_mandatory_changes).toBe(1);
   expect(result.gate.passed).toBe(false);expect(result.gate.reasons).toContain('invalid_mandatory_changes_in_C');
  }
 });
 it('does not treat evidence-backed negative experience as unsupported merely because it is experience',()=>{
  const f=strictFixture();Object.assign(atom(f.runs[2],'/issues/0/problem'),{assertion_basis:'experience',supported:true});
  const result=aggregateReplayResults(f);expect(result.arms.newcaladaptive.unsupported_negative_allegations.numerator).toBe(0);expect(result.gate.passed).toBe(true);
 });
 it('keeps a genuine explicitly unverified neutral uncertainty outside negative allegations',()=>{
  const f=strictFixture();Object.assign(atom(f.runs[2],'/reviewer_comment'),assertion('neutral_assertion',true),{assertion_basis:'unverified',unverified:true,reason:'Explicitly states what remains unknown, without asserting a current defect'});
  f.runs[2].adjudication.comparative_explanations=f.runs.slice(0,2).map(r=>({against_run_id:r.run_id,kind:'unverified',item:'/reviewer_comment',accepted:true,reason:'Evidence supports maintaining uncertainty',evidence_refs:['synthetic-observation']}));
  const result=aggregateReplayResults(f);expect(result.arms.newcaladaptive.unsupported_negative_allegations.numerator).toBe(0);expect(result.gate.passed).toBe(true);
 });
 it('requires new semantic fields even for metadata and rejects old strict classifications rather than guessing',()=>{
  for(const key of ['assertion_scope','assertion_basis']){
   const f=strictFixture();delete atom(f.runs[0],'/score_reasons/aes')[key];
   expect(()=>aggregateReplayResults(f)).toThrow('explicit assertion_scope and assertion_basis');
  }
  const f=strictFixture();Object.assign(atom(f.runs[0],'/issues/0/problem'),{assertion_scope:'none',assertion_basis:'not_applicable'});
  expect(()=>aggregateReplayResults(f)).toThrow('Claim must have an assertion scope');
 });
 it('requires explicitly completed dispute-free blind adjudication and preserves optional corrections',()=>{
  for(const change of [(a:any)=>delete a.complete,(a:any)=>delete a.unresolved_disputes,(a:any)=>a.complete=false,(a:any)=>a.unresolved_disputes=['scope disputed']]){
   const f=strictFixture();change(f.runs[2].adjudication);const result=aggregateReplayResults(f);
   expect(result.gate.passed).toBe(false);expect(result.gate.reasons).toContain(f.runs[2].run_id+':incomplete_or_disputed_adjudication');expect(result.gate.unsupported_comparison.adjudications_complete).toBe(false);
  }
  const f=strictFixture();f.runs[2].adjudication.corrections=[{atom_id:'/reviewer_comment',reason:'Blind adjudicator confirmed metadata after examining the complete text'}];
  expect(aggregateReplayResults(f).gate.passed).toBe(true);
 });
 it('allows count-only reduction for fully adjudicated C with no negative assertions while preserving a null rate',()=>{
  const f=strictFixture();
  for(const r of f.runs.filter(r=>r.arm==='newcaladaptive'))for(const field of r.adjudication.fields)for(const a of field.atoms)if(a.kind!=='non_claim')a.assertion_scope='neutral_assertion';
  const result=aggregateReplayResults(f);
  expect(result.arms.newcaladaptive.unsupported_negative_allegations).toEqual({numerator:0,denominator:0,value:null});
  expect(result.gate.passed).toBe(true);expect(result.gate.unsupported_comparison).toMatchObject({metric:'unsupported_negative_allegations',method:'count_only_no_negative_allegations',candidate_rate:null,adjudications_complete:true,passed:true});
  f.runs[2].adjudication.fields=f.runs[2].adjudication.fields.filter((field:any)=>field.path!=='/reviewer_comment');const incomplete=aggregateReplayResults(f);
  expect(incomplete.gate.passed).toBe(false);expect(incomplete.gate.unsupported_comparison).toMatchObject({adjudications_complete:false,passed:false});
 });
});
