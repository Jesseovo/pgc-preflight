import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {runFeedbackSync,readFeedbackGame,readFeedbackRules,readFeedbackContract,readFeedbackReviewHistory,purgeFeedbackData,readFeedbackStatus} from '../server/creator-feedback-sync';
import {FeedbackProviderError} from '../server/creator-feedback-client';
const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.restoreAllMocks();});
function setup(){
 const sql=new DatabaseSync(':memory:');databases.push(sql);
 for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(`migrations/${name}`,'utf8'));
 let failBatch=false;
 const DB:any={prepare(query:string){let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>sql.prepare(query).get(...params)||null,all:async()=>({results:sql.prepare(query).all(...params)}),run:async()=>s.execute(),execute(){const r=sql.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}};}};return s;},batch:async(ss:any[])=>{sql.exec('BEGIN');try{const r=ss.map((s,i)=>{const result=s.execute();if(failBatch&&i===1){failBatch=false;throw new Error('interrupted');}return result;});sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const client:any={contract:vi.fn(async()=>({scopeRevision:1})),snapshot:vi.fn(async()=>({id:'snapshot',cursor:'1:10',watermark:10,expiresAt:'2099-01-01T00:00:00Z'})),games:vi.fn(async()=>({snapshot:'snapshot',cursor:'1:10',games:[game()],nextAfter:null})),changes:vi.fn(async()=>({cursor:'1:12',events:[],hasMore:false,representation:'query-time-current-state'})),rules:vi.fn(async()=>({rules:[],historicalCoverage:null}))};
 const env={DB,CREATOR_FEEDBACK_ENABLED:'true',CREATOR_FEEDBACK_TOKEN:'synthetic-feedback-token'};
 let time=1_000_000;
 const step=async()=>{const r=await runFeedbackSync(env,{client,now:time});time=Math.max(time+5000,r.nextRunAt||time+5000);return r;};
 const row=()=>sql.prepare('SELECT * FROM creator_feedback_state').get() as any;
 return {sql,DB,client,env,step,row,fail(){failBatch=true;},advance(n:number){time+=n;}};
}
const review=(revision=1,feedback='Synthetic opinion',flags:any={})=>({id:'review_one',revision,feedback,effective:true,deleted:false,revoked:false,reopened:false,...flags});
const game=(title='Synthetic current game',reviews:any[]=[review()])=>({id:'game_one',title,reviews,versions:[],comments:[]});
const event=(id:number,g:any=game(),operation='updated')=>({id,workId:'game_one',game:g,operation,kind:'review'});
async function bootstrap(s:ReturnType<typeof setup>){await s.step();await s.step();}
describe('private resumable provider feedback cache',()=>{
 it('is disabled by default and never calls the provider',async()=>{const s=setup();delete (s.env as any).CREATOR_FEEDBACK_ENABLED;expect((await s.step()).status).toBe('disabled');expect(s.client.contract).not.toHaveBeenCalled();});
 it('persists snapshot key before POST and resumes the same pending request then exact snapshot cursor',async()=>{
  const s=setup();s.client.snapshot.mockImplementationOnce(async(key:string)=>{expect(s.row().pending_key).toBe(key);throw new Error('response lost');});
  expect((await s.step()).status).toBe('backoff');const key=s.row().pending_key;
  await s.step();expect(s.client.snapshot.mock.calls.map((c:any)=>c[0])).toEqual([key,key]);
  s.client.games.mockResolvedValueOnce({snapshot:'snapshot',cursor:'1:10',games:[game()],nextAfter:'game_one'});
  await s.step();expect(s.row().snapshot_after).toBe('game_one');expect(s.row().cursor).toBeNull();
  await s.step();expect(s.client.games.mock.calls[1]).toEqual(['snapshot','game_one',20]);expect(s.row().cursor).toBe('1:10');
  expect(await readFeedbackGame(s.DB,'game_one')).toEqual(game());
 });
 it('commits empty delta cursor exactly, refreshes only candidate rules and leaves existing data untouched',async()=>{
  const s=setup();const existing=(s.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'creator_feedback_%' ORDER BY name").all() as {name:string}[]).map(t=>t.name);
  const before=existing.map(t=>JSON.stringify(s.sql.prepare(`SELECT * FROM ${t}`).all()));
  await bootstrap(s);await s.step();expect(s.row().cursor).toBe('1:12');expect(await readFeedbackRules(s.DB)).toEqual({rules:[],historicalCoverage:null});
  expect(existing.map(t=>JSON.stringify(s.sql.prepare(`SELECT * FROM ${t}`).all()))).toEqual(before);
  const status=JSON.stringify(await readFeedbackStatus(s.DB));expect(status).not.toContain(s.env.CREATOR_FEEDBACK_TOKEN);expect(status).not.toContain(s.row().credential_hash);
 });
 it('rejects stale cursor and same-sequence events, deduplicates sparse events and treats game as current query state',async()=>{
  const s=setup();await bootstrap(s);
  s.client.changes.mockResolvedValueOnce({cursor:'1:40',events:[event(17,game('current')),event(38,game('current')),event(38,game('duplicate'))],hasMore:true});
  await s.step();expect((await readFeedbackGame(s.DB,'game_one')).title).toBe('current');expect(s.sql.prepare('SELECT count(*) n FROM creator_feedback_events').get()).toMatchObject({n:2});
  s.client.changes.mockResolvedValueOnce({cursor:'1:40',events:[event(17,game('old')),event(39,game('same cursor old'))],hasMore:false});await s.step();expect((await readFeedbackGame(s.DB,'game_one')).title).toBe('current');
  s.client.changes.mockResolvedValueOnce({cursor:'1:20',events:[event(18,game('late'))],hasMore:false});expect((await s.step()).status).toBe('backoff');expect(s.row().cursor).toBe('1:40');
  expect(s.sql.prepare('SELECT representation FROM creator_feedback_games').get()).toMatchObject({representation:'query-time-current-state'});
 });
 it('retains delivered historical review revisions/flags but removed physically erases game opinions and links',async()=>{
  const s=setup();await bootstrap(s);
  s.client.changes.mockResolvedValueOnce({cursor:'1:20',events:[event(20,game('current',[review(1,'Old',{effective:false,revoked:true}),review(2,'Changed',{deleted:true})]))],hasMore:false});await s.step();
  expect(s.sql.prepare("SELECT count(*) n FROM creator_feedback_chunks WHERE kind='review'").get()).toMatchObject({n:2});
  const raw=s.sql.prepare("SELECT payload FROM creator_feedback_chunks WHERE kind='review' ORDER BY entity_id").all() as any[];expect(JSON.parse(raw[0].payload).revoked).toBe(true);
  s.sql.prepare('INSERT INTO creator_feedback_links VALUES(?,?,?,?,?,?,?,?,?)').run('task','game_one','version_one','owner','work','submission','exact',1,'now');
  s.client.changes.mockResolvedValueOnce({cursor:'1:30',events:[event(30,null,'removed')],hasMore:false});await s.step();
  expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();expect(s.sql.prepare('SELECT count(*) n FROM creator_feedback_links').get()).toMatchObject({n:0});expect(s.sql.prepare("SELECT count(*) n FROM creator_feedback_chunks WHERE game_id='game_one'").get()).toMatchObject({n:0});
 });
 it('401 purges and halts even after manual reset until credential changes; rotation rebuilds same scope',async()=>{
  const s=setup();await bootstrap(s);s.client.contract.mockRejectedValueOnce(new FeedbackProviderError('http_error',401));
  expect((await s.step()).status).toBe('auth_revoked');expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();const calls=s.client.contract.mock.calls.length;await purgeFeedbackData(s.DB);s.env.CREATOR_FEEDBACK_ENABLED='false';await s.step();s.env.CREATOR_FEEDBACK_ENABLED='true';await s.step();expect(s.client.contract).toHaveBeenCalledTimes(calls);
  s.env.CREATOR_FEEDBACK_TOKEN='synthetic-rotated';expect((await s.step()).status).toBe('ready');expect(s.row().phase).toBe('snapshot');expect(s.client.snapshot).toHaveBeenCalledTimes(2);
 });
 it.each([409,410])('%s resets snapshot rather than advancing cursor',async code=>{
  const s=setup();await bootstrap(s);s.client.changes.mockRejectedValueOnce(new FeedbackProviderError('http_error',code));await s.step();expect(s.row().cursor).toBeNull();expect(s.row().snapshot_id).toBeNull();expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();await s.step();expect(s.client.snapshot).toHaveBeenCalledTimes(2);
 });
 it('contract scope change purges before another data fetch and clears mapping',async()=>{const s=setup();await bootstrap(s);s.client.contract.mockResolvedValueOnce({scopeRevision:2});await s.step();expect(s.row().scope_revision).toBe(2);expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();expect(s.client.changes).not.toHaveBeenCalled();});
 it('respects 429 floor/Retry-After and exponential 5xx backoff without losing checkpoints',async()=>{
  const s=setup();await bootstrap(s);s.client.changes.mockRejectedValueOnce(new FeedbackProviderError('http_error',429,90));let result=await s.step();expect(result.errorCode).toBe('rate_limited');expect(result.nextRunAt!-result.lastAttemptAt!).toBeGreaterThanOrEqual(90_000);
  s.client.changes.mockRejectedValueOnce(new FeedbackProviderError('http_error',503));result=await s.step();expect(result.nextRunAt!-result.lastAttemptAt!).toBeGreaterThanOrEqual(60_000);expect(s.row().cursor).toBe('1:10');expect(await readFeedbackGame(s.DB,'game_one')).not.toBeNull();
 });
 it('interrupted atomic page rolls back opinions and cursor and retries safely',async()=>{const s=setup();await s.step();s.fail();await s.step();expect(s.row().cursor).toBeNull();expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();await s.step();expect(s.row().cursor).toBe('1:10');expect(await readFeedbackGame(s.DB,'game_one')).not.toBeNull();});
 it('fences a fetched page after explicit purge and cannot resurrect private data',async()=>{const s=setup();await s.step();s.client.games.mockImplementationOnce(async()=>{await purgeFeedbackData(s.DB,{halt:true});return {snapshot:'snapshot',cursor:'1:10',games:[game()],nextAfter:null};});await s.step();expect(s.row().status).toBe('auth_revoked');expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();});
 it('stores Unicode source in sub-80KB chunks and reassembles exact text',async()=>{const s=setup();await s.step();const large=game('中🙂'.repeat(30_000));s.client.games.mockResolvedValueOnce({snapshot:'snapshot',cursor:'1:10',games:[large],nextAfter:null});await s.step();expect(await readFeedbackGame(s.DB,'game_one')).toEqual(large);for(const r of s.sql.prepare('SELECT payload FROM creator_feedback_chunks').all() as any[])expect(Buffer.byteLength(r.payload)).toBeLessThan(80_000);});
 it('fences an expired lease even when a response completes without a successor',async()=>{
  const s=setup();await s.step();const real=Date.now(),spy=vi.spyOn(Date,'now').mockReturnValue(real);
  s.client.games.mockImplementationOnce(async()=>{spy.mockReturnValue(real+91_000);return {snapshot:'snapshot',cursor:'1:10',games:[game('expired')],nextAfter:null};});
  await s.step();expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();expect(s.row().cursor).toBeNull();
 });
 it('rolls back an interrupted delta and its cursor then reuses the exact provider cursor',async()=>{
  const s=setup();await bootstrap(s);s.client.changes.mockResolvedValue({cursor:'1:50',events:[event(50,game('new'))],hasMore:false});s.fail();await s.step();expect(s.row().cursor).toBe('1:10');expect((await readFeedbackGame(s.DB,'game_one')).title).toBe('Synthetic current game');await s.step();expect(s.client.changes.mock.calls.map((c:any)=>c[0])).toEqual(['1:10','1:10']);expect((await readFeedbackGame(s.DB,'game_one')).title).toBe('new');
 });
 it('rotation clears prior game data and fences an in-flight old-token page',async()=>{
  const s=setup();await s.step();s.client.games.mockImplementationOnce(async()=>{s.env.CREATOR_FEEDBACK_TOKEN='rotated-token';await runFeedbackSync(s.env,{client:s.client,now:2_000_000});return {snapshot:'snapshot',cursor:'1:10',games:[game('old integration')],nextAfter:null};});await s.step();expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();expect(s.row().phase).toBe('snapshot');
 });
 it('avoids premature polling and another request while a valid lease is active',async()=>{
  const s=setup();await s.step();const before=s.client.contract.mock.calls.length;await runFeedbackSync(s.env,{client:s.client,now:1_000_001});expect(s.client.contract).toHaveBeenCalledTimes(before);
  s.sql.prepare("UPDATE creator_feedback_state SET lease_token='other',lease_until=9000000,next_run_at=0").run();await s.step();expect(s.client.contract).toHaveBeenCalledTimes(before);
 });
 it('rule-only events update the incoming cache without activating review rules',async()=>{
  const s=setup();await bootstrap(s);const rules={rules:[{id:'incoming',body:{direction:'Candidate only',criteria:[],passThreshold:7},sha256:'synthetic',effectiveAt:'now'}],historicalCoverage:null};s.client.rules.mockResolvedValue(rules);s.client.changes.mockResolvedValue({cursor:'1:60',events:[{id:60,workId:null,game:null,operation:'updated',kind:'rule'}],hasMore:false});await s.step();expect(await readFeedbackRules(s.DB)).toEqual(rules);expect(s.sql.prepare('SELECT count(*) n FROM review_rule_versions').get()).toMatchObject({n:0});
 });

 it('rejects a stale external revocation purge after credential rotation',async()=>{
  const s=setup();await bootstrap(s);const generation=s.row().generation;s.env.CREATOR_FEEDBACK_TOKEN='new-token';await s.step();await s.step();const current=s.row().generation;
  await purgeFeedbackData(s.DB,{halt:true,expectedGeneration:generation});expect(s.row().generation).toBe(current);expect(s.row().status).toBe('ready');expect(await readFeedbackGame(s.DB,'game_one')).not.toBeNull();
  await purgeFeedbackData(s.DB,{halt:true,expectedGeneration:current});expect(s.row().status).toBe('auth_revoked');expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();
 });
 it('exports independently retained delivered revisions in stable identity/revision order',async()=>{
  const s=setup();await bootstrap(s);s.client.changes.mockResolvedValueOnce({cursor:'1:20',events:[event(20,game('current',[review(10,'Tenth'),review(2,'Second')]))],hasMore:false});await s.step();expect((await readFeedbackGame(s.DB,'game_one')).reviews).toHaveLength(2);expect((await readFeedbackReviewHistory(s.DB,'game_one')).map(r=>r.revision)).toEqual([1,2,10]);
 });

 it('rejects inconsistent provider game identity without losing the original cache or advancing cursor',async()=>{
  const s=setup();await bootstrap(s);s.client.changes.mockResolvedValueOnce({cursor:'1:20',events:[{...event(20),game:{...game(),id:'game_other'}}],hasMore:false});expect((await s.step()).status).toBe('backoff');expect(s.row().cursor).toBe('1:10');expect(await readFeedbackGame(s.DB,'game_other')).toBeNull();expect(await readFeedbackGame(s.DB,'game_one')).not.toBeNull();
 });
 it('rejects snapshot cursor/watermark mismatch while retaining its persisted retry key',async()=>{
  const s=setup();s.client.snapshot.mockResolvedValueOnce({id:'snapshot',cursor:'1:10',watermark:9,expiresAt:'2099-01-01T00:00:00Z'});await s.step();expect(s.row().snapshot_id).toBeNull();expect(s.row().pending_key).toBeTruthy();const key=s.row().pending_key;await s.step();expect(s.client.snapshot.mock.calls[1][0]).toBe(key);
 });

 it('atomically retains parsed contract history/authorization provenance and purges it on revocation',async()=>{
  const s=setup();const contract={version:1,scopeRevision:1,dataset:'ordinary_games',authorScope:['anonymous-author'],fileVersionCount:0,idNamespace:'integration_pseudonym',historySince:'2026-10-01T00:00:00Z',historyGaps:['Earlier review changes unknown'],states:'includes archived and deleted',pollingSeconds:120,snapshotsExpireHours:24,pagination:{defaultLimit:20,maxLimit:50},rateLimit:{requestsPerMinute:120},maxActiveSnapshots:4};s.client.contract.mockResolvedValue(contract);
  await bootstrap(s);const first=await readFeedbackContract(s.DB);expect(first.contract).toEqual(contract);expect(first.source).toBe('https://creator-hub-7mi.pages.dev/api/integrations/feedback/v1/contract');expect(Number.isFinite(Date.parse(first.fetchedAt))).toBe(true);expect(JSON.stringify(first)).not.toContain(s.env.CREATOR_FEEDBACK_TOKEN);
  const changed={...contract,historyGaps:['Updated coverage metadata']};s.client.contract.mockResolvedValue(changed);s.client.changes.mockResolvedValue({cursor:'1:20',events:[event(20,game('new'))],hasMore:false});s.fail();await s.step();expect(await readFeedbackContract(s.DB)).toEqual(first);expect(s.row().cursor).toBe('1:10');await s.step();expect((await readFeedbackContract(s.DB)).contract).toEqual(changed);expect(s.row().cursor).toBe('1:20');
  s.client.contract.mockRejectedValueOnce(new FeedbackProviderError('http_error',401));await s.step();expect(await readFeedbackContract(s.DB)).toBeNull();
 });

 it.each([401,409])('persists %s authorization withdrawal after its lease expires',async code=>{
  const s=setup();await bootstrap(s);const real=Date.now(),spy=vi.spyOn(Date,'now').mockReturnValue(real);
  s.client.changes.mockImplementationOnce(async()=>{spy.mockReturnValue(real+91_000);throw new FeedbackProviderError('http_error',code);});
  const result=await s.step();expect(result.status).toBe(code===401?'auth_revoked':'ready');expect(result.errorCode).toBe(code===401?'authorization_revoked':'scope_changed');expect(result.nextRunAt).toEqual(code===401?null:expect.any(Number));expect(await readFeedbackGame(s.DB,'game_one')).toBeNull();expect(s.row().cursor).toBeNull();expect(s.row().lease_token).toBeNull();
 });
 it.each([429,503])('persists %s backoff after its lease expires without losing committed cache',async code=>{
  const s=setup();await bootstrap(s);const real=Date.now(),spy=vi.spyOn(Date,'now').mockReturnValue(real);
  s.client.changes.mockImplementationOnce(async()=>{spy.mockReturnValue(real+91_000);throw new FeedbackProviderError('http_error',code,90);});
  const result=await s.step();expect(result.status).toBe('backoff');expect(result.errorCode).toBe(code===429?'rate_limited':'provider_unavailable');expect(result.nextRunAt!-result.lastAttemptAt!).toBeGreaterThanOrEqual(91_000+(code===429?90_000:30_000));expect(s.row().cursor).toBe('1:10');expect(await readFeedbackGame(s.DB,'game_one')).not.toBeNull();expect(s.row().lease_token).toBeNull();
 });
 it.each([401,409,429,503])('ignores an expired predecessor %s error after a new lease takes over',async code=>{
  const s=setup();await bootstrap(s);const before=s.row(),real=Date.now(),spy=vi.spyOn(Date,'now').mockReturnValue(real);
  s.client.changes.mockImplementationOnce(async()=>{
   spy.mockReturnValue(real+91_000);
   // Same generation, but another invocation has acquired the expired lease.
   s.sql.prepare("UPDATE creator_feedback_state SET lease_token='successor',lease_until=?,status='backoff',next_run_at=?,failures=7,error_code='rate_limited' WHERE id=1").run(before.lease_until+1_000_000,9_000_000);
   throw new FeedbackProviderError('http_error',code,90);
  });
  const result=await s.step();expect(result.status).toBe('backoff');expect(result.errorCode).toBe('rate_limited');expect(result.nextRunAt).toBe(9_000_000);expect(result.failures).toBe(7);expect(s.row().lease_token).toBe('successor');expect(s.row().generation).toBe(before.generation);expect(s.row().cursor).toBe('1:10');expect(await readFeedbackGame(s.DB,'game_one')).not.toBeNull();
 });

});
