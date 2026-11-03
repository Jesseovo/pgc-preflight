import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {adminWorkspaceApi} from '../server/admin-workspace-api';
import {login} from '../server/settings';
import {hashPassword,memberLogin} from '../server/members';
import {memberStore} from '../server/storage';
import {canonicalJson,digest} from '../server/review-device-state';
import {reviewSystem} from '../server/forge/prompts.js';
import {getActiveReviewRules,parseReviewRulesSnapshot,validateReviewRulesSnapshot} from '../server/review-rules';

const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.unstubAllGlobals();});
const source={sourceUrl:'https://creator-hub-7mi.pages.dev/#/',capturedAt:'2026-11-02T10:00:00.000Z',rawDirection:'MUST preserve original. Prefer calm colours.\n必须保留；优先考虑。',rawScoring:'美学、易玩性、可玩性各 0–3 分；参考通过分 7。'};
async function setup(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${name}`,'utf8'));
  const DB:any={prepare(sql:string){let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>s.execute(),execute:()=>{const r=sqlite.prepare(sql).run(...params);return {meta:{changes:Number(r.changes)}};}};return s;},batch:async(ss:any[])=>{sqlite.exec('BEGIN');try{const result=ss.map(s=>s.execute());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const env={DB,ADMIN_PASSWORD:'synthetic-rule-admin',SETTINGS_KEY:'synthetic-rule-setting'},cookie=`pgc_admin=${await login(env.ADMIN_PASSWORD,env)}`;
  const password=await hashPassword('synthetic-member-password');
  sqlite.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at) VALUES('member','rulemember','Synthetic Member',?,?,'now','now')").run(password.hash,password.salt);
  const memberCookie=`pgc_member=${await memberLogin('rulemember','synthetic-member-password',memberStore(DB),env.SETTINGS_KEY)}`;
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const call=async(data?:unknown,headers:Record<string,string>={},query='',path='review-rules')=>{
    const r=await adminWorkspaceApi(new Request('https://rules.test/api/admin/'+path+query,{method:data?'POST':'GET',headers:{Cookie:cookie,Origin:'https://rules.test','Content-Type':'application/json',...headers},body:data?JSON.stringify(data):undefined}),env);return r!;
  };
  const draft=async(input=source)=>{const response=await call({action:'import',snapshot:input});expect(response.status).toBe(200);return (await response.json() as any).candidate;};
  return {sqlite,DB,call,draft,fetcher,memberCookie};
}
describe('explicit immutable admin review-rule publication',()=>{
  it('imports drafts without activation or fetching; hashes canonical normalized content and preserves MUST/prefer wording',async()=>{
    const s=await setup();expect(await getActiveReviewRules(s.DB)).toBeNull();
    const a=await s.draft(),b=await s.draft({...source,scoreMin:0,scoreMax:3,passScore:7} as any);
    expect(a.id).not.toBe(b.id);expect(a.contentHash).toBe(b.contentHash);expect(a.rawDirection).toBe(source.rawDirection);
    expect(await getActiveReviewRules(s.DB)).toBeNull();expect(s.fetcher).not.toHaveBeenCalled();
    const comparison=await(await s.call(undefined,{},'?id='+a.id)).json() as any;
    expect(comparison.diff.find((d:any)=>d.field==='rawDirection')).toMatchObject({before:null,after:source.rawDirection});
  });
  it('requires explicit publication with matching active version, preserves old versions and exposes field diffs',async()=>{
    const s=await setup(),a=await s.draft();
    expect((await s.call({action:'publish',id:a.id,expectedActiveId:null})).status).toBe(200);
    const pinned=await getActiveReviewRules(s.DB);expect(pinned).toMatchObject({id:a.id,schemaVersion:2,scoreMin:0,scoreMax:3,passScore:7,calibrationCases:[]});
    const b=await s.draft({...source,rawDirection:'Prefer different colours.'});
    const comparison=await(await s.call(undefined,{},'?id='+b.id)).json() as any;
    expect(comparison.diff).toEqual([{field:'rawDirection',before:source.rawDirection,after:'Prefer different colours.'}]);
    expect((await s.call({action:'publish',id:b.id,expectedActiveId:null})).status).toBe(409);
    expect((await s.call({action:'publish',id:b.id,expectedActiveId:a.id})).status).toBe(200);
    expect((await getActiveReviewRules(s.DB))?.id).toBe(b.id);expect(pinned?.rawDirection).toBe(source.rawDirection);
    expect((await s.call({action:'publish',id:a.id,expectedActiveId:b.id})).status).toBe(409);
    expect(()=>s.sqlite.prepare('UPDATE review_rule_versions SET snapshot=? WHERE id=?').run('{}',a.id)).toThrow('immutable');
    expect(()=>s.sqlite.prepare('DELETE FROM review_rule_versions WHERE id=?').run(a.id)).toThrow('immutable');
    expect(parseReviewRulesSnapshot(JSON.stringify(pinned))).toEqual(pinned);
    expect(validateReviewRulesSnapshot({...pinned,scoreMin:1})).toBe(false);
    expect(validateReviewRulesSnapshot({...pinned,publishedAt:null})).toBe(false);
    expect(validateReviewRulesSnapshot({...pinned,contentHash:[pinned!.contentHash]})).toBe(false);
    const incomplete={...pinned};delete (incomplete as any).scoreMin;expect(validateReviewRulesSnapshot(incomplete)).toBe(false);
  });
  it('concurrent publications compare and swap the active head without publishing a losing draft',async()=>{
    const s=await setup(),a=await s.draft(),b=await s.draft({...source,rawDirection:'Other draft'});
    const responses=await Promise.all([a,b].map(d=>s.call({action:'publish',id:d.id,expectedActiveId:null})));
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    const rows=s.sqlite.prepare('SELECT id,published_at FROM review_rule_versions').all() as any[];
    expect(rows.filter(r=>r.published_at)).toHaveLength(1);
    expect((await getActiveReviewRules(s.DB))?.id).toBe(rows.find(r=>r.published_at).id);
  });
  it('forbids anonymous, member cookies, device bearer even with admin cookie, and cross-origin imports',async()=>{
    const s=await setup();
    const blocked:Record<string,string>[]=[{Cookie:''},{Cookie:s.memberCookie},{Authorization:'Bearer synthetic-device'}, {Origin:'https://foreign.test'}];
    for(const headers of blocked){
      expect((await s.call({action:'import',snapshot:source},headers)).status).toBe(403);
    }
    expect((await s.call(undefined,{Cookie:''})).status).toBe(403);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_rule_versions').get()).toMatchObject({n:0});
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('refuses publication of a corrupted stored draft rather than activating an incorrect content hash',async()=>{
    const s=await setup(),a=await s.draft();
    const row=s.sqlite.prepare('SELECT snapshot FROM review_rule_versions WHERE id=?').get(a.id) as any;
    s.sqlite.prepare('INSERT INTO review_rule_versions(id,content_hash,snapshot,created_at) VALUES(?,?,?,?)').run('corrupted-draft','f'.repeat(64),row.snapshot,'now');
    expect((await s.call({action:'publish',id:'corrupted-draft',expectedActiveId:null})).status).toBe(409);
    expect(await getActiveReviewRules(s.DB)).toBeNull();
  });
  it('manual v2 imports retain exact published historical provenance and unknown scores; never assume current rules',async()=>{
    const s=await setup(),a=await s.draft();
    await s.call({action:'publish',id:a.id,expectedActiveId:null});
    const first=await getActiveReviewRules(s.DB),b=await s.draft({...source,rawDirection:'New active version'});
    await s.call({action:'publish',id:b.id,expectedActiveId:a.id});
    const result={schema_version:2,assessment_status:'needs_review',aes:0,ease:null,play:2,score_reasons:{aes:'截图观察',ease:'操作证据不足',play:'源码推断'},uncertainties:['缺少操作证据'],verdict:'待复核：需要操作证据',reviewer_comment:'SYNTHETIC',fix_prompt:'',strengths:[],issues:[],optional_suggestions:[]};
    const input={request_id:crypto.randomUUID(),result,rules_snapshot:first};
    const manual=(data:any,headers:Record<string,string>={})=>s.call(data,headers,'','review-import');
    expect((await manual(input,{Cookie:s.memberCookie})).status).toBe(403);
    expect((await manual(input,{Authorization:'Bearer device'})).status).toBe(403);
    const imported=await manual(input);expect(imported.status).toBe(201);
    expect((await manual(input)).status).toBe(200);
    const job=s.sqlite.prepare('SELECT * FROM review_jobs WHERE id=?').get(input.request_id) as any;
    const saved=s.sqlite.prepare('SELECT * FROM reviews WHERE job_id=?').get(input.request_id) as any;
    expect(job).toMatchObject({model_executor:'manual-admin',report_schema_version:2,review_mode:'full',quota_charged:0});
    expect(saved).toMatchObject({score:null,model_executor:'manual-admin'});
    expect(JSON.parse(saved.rules_snapshot)).toEqual(first);expect(JSON.parse(job.rules_snapshot)).toEqual(first);expect(JSON.parse(saved.result)).toEqual(result);
    expect((await manual({...input,rules_snapshot:await getActiveReviewRules(s.DB)})).status).toBe(409);
    for(const bad of [undefined,{...first,id:'invented'}, {...first,rawScoring:'Forged'}, {...first,contentHash:'b'.repeat(64)}]){
      const r=await manual({...input,request_id:crypto.randomUUID(),rules_snapshot:bad});expect([400,409]).toContain(r.status);
    }
    const unpublished=await s.draft();
    expect((await manual({...input,request_id:crypto.randomUUID(),rules_snapshot:{...unpublished,publishedAt:first!.publishedAt}})).status).toBe(409);
    expect((await manual({...input,request_id:crypto.randomUUID(),model_executor:'agent'})).status).toBe(400);
    expect((await manual({...input,request_id:crypto.randomUUID(),report_schema_version:1})).status).toBe(400);
    const zero={...result,assessment_status:'complete',ease:0,play:0,verdict:'打回：零分'};
    const z={...input,request_id:crypto.randomUUID(),result:zero};expect((await manual(z)).status).toBe(201);
    expect(s.sqlite.prepare('SELECT score FROM reviews WHERE job_id=?').get(z.request_id)).toMatchObject({score:0});
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('publishes evidence-only and partial-score cases without fabricating any reference score',async()=>{
    const s=await setup(),cases=[
      {id:'evidence-only',title:'Synthetic interaction clue',evidence:'Only the initial view was observed. To verify: perform a trusted tap and inspect the response.',score:null,rationale:'Historical clue has not been reproduced; no reference score is available.'},
      {id:'partial',title:'Synthetic partial anchor',evidence:'Screenshot supports only the stated visual observation.',score:{aes:0,ease:null,play:null},rationale:'Only aesthetics has an explicit reference score; interaction and sustained play are unknown.'},
    ];
    const a=await s.draft({...source,calibrationCases:cases} as any);
    expect(a.calibrationCases).toEqual(cases);
    await s.call({action:'publish',id:a.id,expectedActiveId:null});
    const published=await getActiveReviewRules(s.DB);expect(published!.calibrationCases).toEqual(cases);
    expect(parseReviewRulesSnapshot(JSON.stringify(published))).toEqual(published);
    const system=reviewSystem({rules:published!});expect(system).toContain('null 绝不能当作 0、默认分或标准答案');
    expect(system).toContain('"score":null');expect(system).toContain('"aes":0,"ease":null,"play":null');
    for(const bad of [undefined,{},[],{aes:null,ease:0},{aes:null,ease:4,play:0},{aes:null,ease:'0',play:0}]){
      const r=await s.call({action:'import',snapshot:{...source,calibrationCases:[{...cases[0],score:bad}]}});expect(r.status).toBe(400);
    }
    for(const field of ['evidence','rationale'])expect((await s.call({action:'import',snapshot:{...source,calibrationCases:[{...cases[0],[field]:''}]}})).status).toBe(400);
  });
  it('keeps existing all-numeric calibration content and hashes byte-compatible',async()=>{
    const s=await setup(),cases=[{id:'numeric',title:'Synthetic old numeric case',evidence:'Explicitly published evidence.',score:{aes:1,ease:2,play:3},rationale:'Explicit reference scores.'}];
    const oldContent={...source,scoreMin:0,scoreMax:3,passScore:7,notes:'',calibrationCases:cases};
    const expected=canonicalJson(oldContent),hash=await digest(expected);
    s.sqlite.prepare('INSERT INTO review_rule_versions VALUES(?,?,?,?,?)').run('old-numeric',hash,expected,'2026-11-02T00:00:00Z','2026-11-02T00:00:00Z');
    s.sqlite.prepare('UPDATE review_rule_head SET version_id=? WHERE id=1').run('old-numeric');
    const published=await getActiveReviewRules(s.DB);expect(published!.contentHash).toBe(hash);expect(published!.calibrationCases).toEqual(cases);
    const {schemaVersion,id,contentHash,publishedAt,...content}=parseReviewRulesSnapshot(JSON.stringify(published));
    expect(canonicalJson(content)).toBe(expected);expect(await digest(canonicalJson(content))).toBe(hash);
  });
  it('rejects arbitrary sources, scoring drift and automatic/private calibration fields; accepts only explicit sanitized cases',async()=>{
    const s=await setup();
    for(const invalid of [{...source,sourceUrl:'https://elsewhere.test/'},{...source,scoreMin:1},{...source,rawScoring:''},{...source,capturedAt:'invalid'},{...source,feedback:'PRIVATE'}, {...source,calibrationCases:[{id:'x',feedback:'PRIVATE'}]}])expect((await s.call({action:'import',snapshot:invalid})).status).toBe(400);
    const cases=[{id:'public-1',title:'Synthetic public calibration',evidence:'Screenshot shows high contrast controls.',score:{aes:0,ease:2,play:3},rationale:'Synthetic calibration rationale.'}];
    const a=await s.draft({...source,calibrationCases:cases} as any);
    expect((await s.call({action:'publish',id:a.id,expectedActiveId:null})).status).toBe(200);
    expect((await getActiveReviewRules(s.DB))?.calibrationCases).toEqual(cases);
  });
});
