import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {digest} from '../server/review-device-state';
import {readNaturalReviewSnapshot} from '../server/review-observation-export';

const databases:DatabaseSync[]=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
const since='2026-11-04T00:00:00.000Z',now='2026-11-05T00:00:00.000Z';
function setup(){
 const sql=new DatabaseSync(':memory:');databases.push(sql);
 for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(`migrations/${name}`,'utf8'));
 const queries:string[]=[],DB:any={prepare(query:string){queries.push(query);let args:any[]=[];const statement={bind(...values:any[]){args=values;return statement;},all:async()=>({results:sql.prepare(query).all(...args)})};return statement;}};
 const job=(id:string,status='queued',created=since,hidden=0,executor='agent')=>sql.prepare(`INSERT INTO review_jobs(id,owner_id,title,status,created_at,updated_at,owner_hidden,model_executor,review_mode,input_hash,evidence_hash,lease,model_snapshot,error)
   VALUES(?,'owner-private','PRIVATE_TITLE',?,?,?,?,?,'basic',NULL,NULL,'PRIVATE_LEASE','PRIVATE_MODEL_CONFIG','PRIVATE_ERROR')`).run(id,status,created,created,hidden,executor);
 const report=(id:string,result:string,hidden=0)=>{const saved=sql.prepare("INSERT INTO reviews(owner_id,title,result,probe,shots,created_at,job_id,owner_hidden,model,evidence_hash) VALUES('owner-private','PRIVATE_TITLE',?,'PRIVATE_PROBE','PRIVATE_SCREENSHOTS',?,?,?,'synthetic-model','evidence-from-report')").run(result,since,id,hidden);return Number(saved.lastInsertRowid);};
 return {sql,DB,queries,job,report};
}
describe('local natural-submission observation snapshot',()=>{
 it('retains queued, running, failed, hidden and unlinked tasks without requiring reports or timings',async()=>{
  const s=setup();s.job('queued');s.job('running','running');s.job('failed','error',since,1);s.job('hidden-done','done',since,1);s.report('hidden-done','{"aes":0,"ease":null,"verdict":"待复核"}',1);
  const snapshot=await readNaturalReviewSnapshot(s.DB,since,now);expect(snapshot).toMatchObject({schemaVersion:1,kind:'natural-review-snapshot',since,capturedAt:now,complete:true,totalObserved:4,truncated:false});
  expect(snapshot.tasks.map(t=>t.jobId)).toEqual(['failed','hidden-done','queued','running']);expect(snapshot.tasks.map(t=>t.status)).toEqual(['error','done','queued','running']);
  for(const task of snapshot.tasks){expect(task.link).toBeNull();expect(task.startedAt).toBeNull();expect(task.finishedAt).toBeNull();expect(task.outcome).toBeNull();}
  const failed=snapshot.tasks[0];expect(failed).toMatchObject({report:null,reportId:null,reportHash:null,inputHash:null,effort:null,configHash:null,configurationOrigin:null});expect(s.queries).toHaveLength(1);
 });
 it('exports exact report values and hashes stored bytes, not a normalized JSON reconstruction',async()=>{
  const s=setup();s.job('done','done',since,0,'manual-admin');
  const raw=' { "play": 0, "aes": null, "extra": [0, null, false] }\n',reportId=s.report('done',raw);
  s.sql.prepare("UPDATE review_jobs SET input_hash='input-original',evidence_hash='locked-evidence' WHERE id='done'").run();
  s.sql.prepare("INSERT INTO review_execution_timing(job_id,started_at,finished_at,outcome,model_name,effort,config_hash,config_origin,created_at) VALUES('done',?,?,'done','frozen-model','auto','frozen-hash','server',?)").run(since,now,since);
  s.sql.prepare("INSERT INTO creator_feedback_links(task_id,owner_id,game_id,version_id,known_work_id,known_submission_id,matched_by,scope_revision,created_at) VALUES('done','owner-private','game_anon','version_anon','PRIVATE_ORIGINAL_WORK','PRIVATE_ORIGINAL_VERSION','user-confirmed',0,?)").run(since);
  const [task]=(await readNaturalReviewSnapshot(s.DB,since,now)).tasks;
  expect(task).toMatchObject({executor:'manual-admin',inputHash:'input-original',evidenceHash:'locked-evidence',startedAt:since,finishedAt:now,outcome:'done',model:'frozen-model',effort:'auto',configHash:'frozen-hash',configurationOrigin:'server',reportId,reportCreatedAt:since,reportHashBasis:'stored-result-utf8',reportParseError:false,report:{play:0,aes:null,extra:[0,null,false]},link:{workId:'game_anon',versionId:'version_anon',linkedAt:since,scopeRevision:0}});
  expect(task.reportHash).toBe(await digest(raw));expect(task.reportHash).not.toBe(await digest(JSON.stringify(task.report)));
 });
 it('does not require result_id to recover an already persisted report and keeps invalid JSON as a row',async()=>{
  const s=setup();s.job('interrupted','running');s.report('interrupted','{ invalid PRIVATE_REPORT_TEXT');
  const result=await readNaturalReviewSnapshot(s.DB,since,now);expect(result.totalObserved).toBe(1);expect(result.tasks[0]).toMatchObject({jobId:'interrupted',status:'running',report:null,reportParseError:true,reportHash:await digest('{ invalid PRIVATE_REPORT_TEXT')});expect(JSON.stringify(result)).not.toContain('PRIVATE_REPORT_TEXT');
 });
 it('preserves JSON null and zero as stored report values without confusing them with a missing report',async()=>{
  const s=setup();s.job('null-report','done');s.report('null-report','null');s.job('zero-report','done');s.report('zero-report','0');
  const snapshot=await readNaturalReviewSnapshot(s.DB,since,now);expect(snapshot.tasks[0]).toMatchObject({report:null,reportParseError:false,reportHash:await digest('null')});expect(snapshot.tasks[1]).toMatchObject({report:0,reportParseError:false,reportHash:await digest('0')});
 });
 it('uses the fixed inclusive start/exclusive end and normalizes valid UTC fractional forms',async()=>{
  const s=setup();s.job('earlier','done','2026-11-03T23:59:59.999Z');s.job('start');s.job('last','queued','2026-11-04T23:59:59.999Z');s.job('end','queued',now);
  const snapshot=await readNaturalReviewSnapshot(s.DB,'2026-11-04T00:00:00Z','2026-11-05T00:00:00.0Z');expect(snapshot.tasks.map(t=>t.jobId)).toEqual(['start','last']);expect(snapshot.since).toBe('2026-11-04T00:00:00Z');
  expect(await readNaturalReviewSnapshot(s.DB,now,now)).toMatchObject({complete:true,totalObserved:0,truncated:false,tasks:[]});
 });
 it.each(['2026-02-30T00:00:00Z','2026-13-01T00:00:00Z','2026-11-04T24:00:00Z','2026-11-04T00:00:60Z','2026-11-04','2026-11-04T00:00:00','2026-11-04T00:00:00.0000Z','2026-11-04T00:00:00Z junk',"2026-11-04T00:00:00Z' OR 1=1 --",''])('rejects an invalid or non-UTC ISO boundary before querying (%s)',async value=>{
  const DB={prepare:vi.fn()};await expect(readNaturalReviewSnapshot(DB,value,now)).rejects.toThrow('ISO');await expect(readNaturalReviewSnapshot(DB,since,value)).rejects.toThrow('ISO');expect(DB.prepare).not.toHaveBeenCalled();
 });
 it('rejects a start after the capture time',async()=>{const DB={prepare:vi.fn()};await expect(readNaturalReviewSnapshot(DB,now,since)).rejects.toThrow('晚于');expect(DB.prepare).not.toHaveBeenCalled();});
 it('counts every matching task in the same read while bounding returned rows to 10000',async()=>{
  const s=setup();s.sql.exec('BEGIN');for(let i=0;i<10005;i++)s.job(`bounded-${String(i).padStart(5,'0')}`,i%2?'error':'queued',since,i%3?0:1);s.sql.exec('COMMIT');
  const snapshot=await readNaturalReviewSnapshot(s.DB,since,now);expect(snapshot).toMatchObject({complete:false,totalObserved:10005,truncated:true});expect(snapshot.tasks).toHaveLength(10000);expect(snapshot.tasks[0].jobId).toBe('bounded-00000');expect(snapshot.tasks.at(-1)?.jobId).toBe('bounded-09999');expect(s.queries).toHaveLength(1);expect(s.queries[0]).toContain('COUNT(*) OVER()');expect(s.queries[0]).toContain('LIMIT 10001');
 });
 it('uses a one-to-one report join protected by the real unique job index',async()=>{
  const s=setup();s.job('unique-job','done');s.report('unique-job','{"score":0}');expect(()=>s.report('unique-job','{"score":1}')).toThrow('UNIQUE');
  const indexes=s.sql.prepare("PRAGMA index_list('reviews')").all() as any[];expect(indexes.find(index=>index.name==='reviews_job')).toMatchObject({unique:1});expect(await readNaturalReviewSnapshot(s.DB,since,now)).toMatchObject({totalObserved:1,tasks:[{jobId:'unique-job',report:{score:0}}]});
 });
 it('exports only the agreed metadata and original report, never private runtime or identity fields',async()=>{
  const s=setup();s.job('privacy','done',since,1,'unknown-executor');s.report('privacy','{"score":0}');s.sql.prepare("INSERT INTO review_inputs(job_id,part,data,created_at) VALUES('privacy',0,'PRIVATE_HTML_SOURCE',?)").run(since);
  const before=s.sql.prepare('SELECT * FROM review_jobs').all(),snapshot=await readNaturalReviewSnapshot(s.DB,since,now),json=JSON.stringify(snapshot);
  expect(snapshot.tasks[0].executor).toBe('unknown-executor');for(const privateText of ['PRIVATE_HTML_SOURCE','PRIVATE_TITLE','PRIVATE_LEASE','PRIVATE_MODEL_CONFIG','PRIVATE_ERROR','PRIVATE_PROBE','PRIVATE_SCREENSHOTS','PRIVATE_ORIGINAL_WORK','PRIVATE_ORIGINAL_VERSION','username','encryptedKey'])expect(json).not.toContain(privateText);
  expect(Object.keys(snapshot.tasks[0]).sort()).toEqual(['jobId','ownerId','createdAt','status','updatedAt','executor','mode','inputHash','startedAt','finishedAt','outcome','model','effort','configHash','configurationOrigin','reportId','reportCreatedAt','reportHash','reportHashBasis','report','reportParseError','evidenceHash','link'].sort());expect(s.sql.prepare('SELECT * FROM review_jobs').all()).toEqual(before);expect(s.queries.every(q=>/^SELECT /.test(q))).toBe(true);
 });
});
