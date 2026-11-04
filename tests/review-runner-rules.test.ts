import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {advanceCloudReview} from '../server/cloud-review-runner';
import {executeDeviceReview} from '../server/review-runner';
import {prepareReview,consistentVerdict} from '../server/forge-api';
import {generateReview,generateReviewStage} from '../server/review-generation';
vi.mock('../server/forge-api',()=>({prepareReview:vi.fn(async(_env,input)=>({system:'PINNED RULES '+input.rulesSnapshot?.id,user:[...(input.shots||[]).map((image:any)=>({type:'image',data:image.data})),{type:'text',text:input.html}],images:input.shots||[],reportSchemaVersion:input.reportSchemaVersion})),consistentVerdict:vi.fn(()=> 'LEGACY_NORMALIZED')}));
vi.mock('../server/review-generation',()=>({generateReview:vi.fn(),generateReviewStage:vi.fn()}));
const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.clearAllMocks();});
function setup(version=2){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${name}`,'utf8'));
  const DB:any={prepare(sql:string){let p:any[]=[];const s:any={bind(...v:any[]){p=v;return s;},first:async()=>sqlite.prepare(sql).get(...p)||null,all:async()=>({results:sqlite.prepare(sql).all(...p)}),run:async()=>s.execute(),execute:()=>{const r=sqlite.prepare(sql).run(...p);return {meta:{changes:Number(r.changes)}};}};return s;},batch:async(ss:any[])=>{sqlite.exec('BEGIN');try{const r=ss.map(s=>s.execute());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const values=new Map<string,any>();
  const storage:any={get:async(k:string)=>structuredClone(values.get(k)),put:async(k:string,v:any)=>{values.set(k,structuredClone(v));},delete:async(k:string)=>values.delete(k),setAlarm:async()=>{},deleteAlarm:async()=>{},deleteAll:async()=>values.clear(),transaction:async(fn:any)=>fn(storage)};
  const rules={schemaVersion:2,id:'pinned-rule-id',contentHash:'a'.repeat(64),sourceUrl:'https://creator-hub-7mi.pages.dev/#/',capturedAt:'2026-11-02T10:00:00.000Z',rawDirection:'MUST preserve direction; prefer calm colours.',rawScoring:'Each dimension 0–3.',scoreMin:0,scoreMax:3,passScore:7,notes:'',calibrationCases:[],publishedAt:'2026-11-02T11:00:00.000Z'};
  const id=crypto.randomUUID(),text=version===2?JSON.stringify(rules):null;
  const profile={enabled:true,encryptedKey:'synthetic-encrypted-key',model:'synthetic-model',baseUrl:'https://fixture.invalid',protocol:'openai'};
  sqlite.prepare("INSERT INTO review_jobs(id,owner_id,title,status,executor,model_executor,created_at,updated_at,rules_snapshot,report_schema_version,model_snapshot) VALUES(?,'admin','SYNTHETIC','queued','cloud','platform','now','now',?,?,?)").run(id,text,version,JSON.stringify({id:'synthetic',profile}));
  sqlite.prepare("INSERT INTO review_inputs(job_id,part,data,created_at) VALUES(?,0,?,'now')").run(id,JSON.stringify({html:'<!doctype html><canvas></canvas>',title:'SYNTHETIC'}));
  const evidence={probe:{captureMethod:'browser-viewport-v1'},shots:Array.from({length:4},(_,i)=>({id:`baseline-${i+1}`,label:`SYNTHETIC ${i+1}`,data:`data:image/jpeg;base64,${Buffer.from(`SYNTHETIC ${i+1}`).toString('base64')}`}))};
  const env={DB,modelStore:{get:async()=>profile},captureReview:async()=>evidence};
  const tick=()=>advanceCloudReview({storage},env,id);
  const saved=()=>sqlite.prepare('SELECT * FROM reviews WHERE job_id=?').get(id) as any;
  const result={schema_version:2,assessment_status:'needs_review',aes:3,ease:null,play:2,verdict:'待复核：操作证据不足',score_reasons:{aes:'截图',ease:'缺操作证据',play:'源码'},uncertainties:['操作效果未验证'],optional_suggestions:[],issues:[],strengths:[],reviewer_comment:'MODEL_RESULT',fix_prompt:''};
  return {DB,sqlite,env,storage,values,rules,text,id,tick,saved,result,evidence};
}
describe('runner rule/version provenance and unknown scoring',()=>{
  it('pins rule and report schema into cloud checkpoint and persists null score without rewriting v2 model verdict',async()=>{
    const s=setup();vi.mocked(generateReviewStage).mockResolvedValue(s.result);
    await s.tick();expect(prepareReview).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({rulesSnapshot:s.rules,reportSchemaVersion:2}));
    const readParts=(prefix:string)=>JSON.parse(Array.from({length:s.values.get(`${prefix}Parts`)},(_,i)=>s.values.get(`${prefix}:${i}`)).join(''));
    const preparedState=readParts('cloudState');expect(preparedState).toMatchObject({version:2,materialRef:expect.any(String)});expect(preparedState.draft).toBeUndefined();expect(preparedState.result).toBeUndefined();
    const materialPrefix=`cloudImmutable:${preparedState.materialRef}`,checkpoint=readParts(materialPrefix);
    expect(checkpoint.request).toMatchObject({reportSchemaVersion:2,system:'PINNED RULES '+s.rules.id});
    expect(checkpoint.images).toEqual(s.evidence.shots);expect(checkpoint.probe).toEqual(s.evidence.probe);
    const restoredRequest={...checkpoint.request,user:checkpoint.request.user.map((part:any)=>{if(part.type!=='image')return part;const {imageIndex,...metadata}=part;expect(part.data).toBeUndefined();return {...metadata,data:checkpoint.images[imageIndex].data};})};
    expect(restoredRequest.user.filter((part:any)=>part.type==='image').map((part:any)=>part.data)).toEqual(s.evidence.shots.map(shot=>shot.data));
    // Changing platform settings/model after preparation cannot change either
    // the immutable evidence or the task's locked rule/model identities.
    s.sqlite.prepare("INSERT INTO settings(id,value,updated_at) VALUES('redlines','NEW_GLOBAL_RULES','now')").run();
    const originalProfile=await s.env.modelStore.get();s.env.modelStore.get=async()=>({...originalProfile,model:'different-model'});
    await s.tick();const draftState=readParts('cloudState');expect(draftState).toMatchObject({version:2,materialRef:preparedState.materialRef,draft:s.result});expect(readParts(materialPrefix)).toEqual(checkpoint);
    await s.tick();expect(readParts('cloudState')).toMatchObject({version:2,materialRef:preparedState.materialRef,result:s.result});expect(readParts(materialPrefix)).toEqual(checkpoint);
    await s.tick();
    expect(s.saved()).toMatchObject({score:null,rules_snapshot:s.text});
    expect(JSON.parse(s.saved().result).verdict).toBe(s.result.verdict);expect(consistentVerdict).not.toHaveBeenCalled();
    expect(JSON.parse(s.saved().shots)).toEqual(s.evidence.shots);
    const calls=vi.mocked(generateReviewStage).mock.calls;expect(calls.map(call=>call[3])).toEqual(['review','review_verify']);
    for(const call of calls){expect(call[2]).toMatchObject(restoredRequest);expect(await call[0].modelStore.get()).toMatchObject({model:originalProfile.model});}
    expect(calls[1][4]).toEqual(s.result);
  });
  it('device platform compatibility passes locked snapshot and also keeps genuine zero score distinct from unknown',async()=>{
    const s=setup();s.sqlite.prepare("UPDATE review_jobs SET status='running',executor='device',evidence_ready=1 WHERE id=?").run(s.id);
    s.sqlite.prepare("INSERT INTO review_evidence(job_id,part,data,created_at) VALUES(?,0,?,'now')").run(s.id,JSON.stringify({probe:{},shots:[]}));
    const zero={...s.result,assessment_status:'complete',aes:0,ease:0,play:0,verdict:'打回：模型给出零分'};vi.mocked(generateReview).mockResolvedValue(zero);
    await executeDeviceReview(s.env,s.id);
    expect(prepareReview).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({rulesSnapshot:s.rules,reportSchemaVersion:2}));
    expect(s.saved()).toMatchObject({score:0,rules_snapshot:s.text});expect(JSON.parse(s.saved().result).verdict).toBe(zero.verdict);expect(consistentVerdict).not.toHaveBeenCalled();
  });
  it('an old final-ready checkpoint without schema stays legacy and does not rerun a model',async()=>{
    const s=setup(1),legacy={aes:2,ease:2,play:3,verdict:'LEGACY_MODEL_VERDICT'};
    s.sqlite.prepare("UPDATE review_jobs SET status='running' WHERE id=?").run(s.id);
    await s.storage.put('cloudPhase','final-ready');await s.storage.put('cloudParts',1);await s.storage.put('cloud:0',JSON.stringify({request:{system:'OLD'},result:legacy,topic_id:null,probe:{},images:[]}));
    await s.tick();expect(s.saved()).toMatchObject({score:7,rules_snapshot:null});expect(JSON.parse(s.saved().result).verdict).toBe('LEGACY_NORMALIZED');
    expect(generateReviewStage).not.toHaveBeenCalled();expect(consistentVerdict).toHaveBeenCalledWith('LEGACY_MODEL_VERDICT',7);
  });
});
