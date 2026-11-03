import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {creatorFeedbackAdminApi} from '../server/creator-feedback-api';
import {CreatorFeedbackClient,type FeedbackContract,type FeedbackGame} from '../server/creator-feedback-client';
import {login} from '../server/settings';
import {hashPassword,memberLogin} from '../server/members';
import {memberStore} from '../server/storage';
import {digest} from '../server/review-device-state';

const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.restoreAllMocks();vi.unstubAllGlobals();});
const game=():FeedbackGame=>({id:'game_synthetic',authorId:'author_synthetic',title:'Synthetic only',description:'',status:'approved',revision:1,createdAt:'legacy unknown zone',updatedAt:'now',archived:false,deleted:false,textRedacted:true,idNamespace:'integration_pseudonym',
 versions:[{id:'version_synthetic',revision:1,title:'Synthetic only',description:'',submittedAt:'now',updateNote:'',withdrawn:false,ruleVersion:null,status:null,statusSource:null,finalReviewId:null,files:{html:{bytes:42}},fileAccess:false}],
 reviews:[{id:'review_synthetic',versionId:'version_synthetic',stage:'decision_review',revision:1,eventSequence:2,reviewerId:'reviewer_synthetic',reviewerRole:null,scores:[{name:'美学',description:'',max:3,score:0},{name:'易玩性',description:'',max:3,score:null}],total:null,decision:null,feedback:'Synthetic source opinion',createdAt:'legacy unknown zone',recordedAt:null,scored:true,historicalBaseline:true,deleted:false,reopened:false,revoked:false,effective:true}],comments:[]});
const contract:FeedbackContract={version:1,scopeRevision:3,dataset:'ordinary_games',authorScope:'all',fileVersionCount:0,idNamespace:'integration_pseudonym',historySince:null,pollingSeconds:120,snapshotsExpireHours:24,pagination:{defaultLimit:20,maxLimit:50},rateLimit:{requestsPerMinute:120}};
async function setup(){
 const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
 for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${name}`,'utf8'));
 let afterRead:(query:string)=>void|Promise<void>=()=>{};
 const DB:any={prepare(query:string){let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>{const r=sqlite.prepare(query).get(...params)||null;await afterRead(query);return r;},all:async()=>{const results=sqlite.prepare(query).all(...params);await afterRead(query);return {results};},run:async()=>s.execute(),execute:()=>{const r=sqlite.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}};}};return s;},batch:async(ss:any[])=>{sqlite.exec('BEGIN');try{const r=ss.map(s=>s.execute());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const env={DB,ADMIN_PASSWORD:'synthetic-feedback-admin',SETTINGS_KEY:'synthetic-settings-key',CREATOR_FEEDBACK_ENABLED:'true',CREATOR_FEEDBACK_TOKEN:'synthetic-integration-token'};
 const cookie=`pgc_admin=${await login(env.ADMIN_PASSWORD,env)}`;
 const pw=await hashPassword('synthetic-password');sqlite.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at) VALUES('member','feedbackmember','Synthetic',?,?,'now','now')").run(pw.hash,pw.salt);
 const memberCookie=`pgc_member=${await memberLogin('feedbackmember','synthetic-password',memberStore(DB),env.SETTINGS_KEY)}`;
 const fingerprint=await digest(env.CREATOR_FEEDBACK_TOKEN);
 sqlite.prepare("UPDATE creator_feedback_state SET generation=1,credential_hash=?,scope_revision=3,status='ready',phase='delta',cursor='3:2' WHERE id=1").run(fingerprint);
 function cache(g=game()) {sqlite.prepare('INSERT OR REPLACE INTO creator_feedback_games(game_id,last_sequence,updated_at) VALUES(?,2,1)').run(g.id);sqlite.prepare("INSERT OR REPLACE INTO creator_feedback_chunks(kind,entity_id,game_id,part,payload) VALUES('game',?,?,0,?)").run(g.id,g.id,JSON.stringify(g));}
 cache();
 sqlite.prepare("INSERT INTO creator_feedback_chunks(kind,entity_id,game_id,part,payload) VALUES('rules','candidate',NULL,0,?)").run(JSON.stringify({rules:[{id:'source_rule',body:{direction:'Synthetic candidate',criteria:[],passThreshold:7},effectiveAt:'now',sha256:'a'.repeat(64)}],historicalCoverage:'unknown before start'}));
 sqlite.prepare("INSERT INTO review_jobs(id,owner_id,title,status,created_at,updated_at) VALUES('task-one','member','Synthetic AI task','done','now','now')").run();
 sqlite.prepare("INSERT INTO reviews(owner_id,title,score,result,probe,shots,created_at,job_id,model) VALUES('member','Synthetic AI task',0,?,'{}','[]','now','task-one','synthetic-agent')").run(JSON.stringify({aes:0,ease:null,play:0}));
 sqlite.prepare("INSERT INTO review_human_reviews(job_id,owner_id,device_id,request_id,payload_hash,work_id,version_id,score,feedback,source_updated_at,source,status,phase,matched_by,display_rank,is_current,created_at,decision) VALUES('task-one','member','synthetic-device','synthetic-request','synthetic-hash','known-work','known-version',0,'Synthetic human feedback','now','agent','reviewed','final','user-confirmed',2,1,'now','rejected')").run();
 sqlite.prepare("INSERT INTO gallery_games(id,owner_id,work_id,version_id,job_id,title,content_hash,part_count,byte_length,is_complete,created_at) VALUES('gallery-synthetic','member','other-work','other-version','old-task','Synthetic gallery','synthetic-hash',1,20,1,'now')").run();
 sqlite.prepare("INSERT INTO gallery_game_html VALUES('gallery-synthetic',0,'<p>Synthetic only</p>')").run();
 const network=vi.fn<typeof fetch>(async()=>{throw new Error('Unexpected live fetch');});vi.stubGlobal('fetch',network);
 const mocks={contract:vi.spyOn(CreatorFeedbackClient.prototype,'contract').mockResolvedValue(contract),identity:vi.spyOn(CreatorFeedbackClient.prototype,'identity').mockResolvedValue({id:'version_synthetic',workId:'game_synthetic',idNamespace:'integration_pseudonym'}),game:vi.spyOn(CreatorFeedbackClient.prototype,'game').mockResolvedValue(game())};
 const call=async(path='/status',data?:unknown,headers:Record<string,string>={})=>(await creatorFeedbackAdminApi(new Request('https://feedback.test/api/admin/creator-feedback'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:'https://feedback.test','Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)}),env))!;
 const link={jobId:'task-one',workId:'known-work',versionId:'known-version',matchedBy:'published-record'};
 const preserved=()=>['review_jobs','reviews','review_human_reviews','gallery_games','gallery_game_html','gallery_publish_requests','review_rule_versions','review_rule_head'].map(t=>JSON.stringify(sqlite.prepare(`SELECT * FROM ${t}`).all()));
 return {sqlite,DB,env,cookie,memberCookie,fingerprint,cache,call,link,mocks,network,preserved,onRead(hook:typeof afterRead){afterRead=hook;}};
}
describe('administrator-private source feedback API',()=>{
 it('denies anonymous, member, device Bearer even with administrator cookie, and cross-origin writes',async()=>{
  const s=await setup();
  const denied:Record<string,string>[]=[{Cookie:''},{Cookie:s.memberCookie},{Authorization:'Bearer synthetic-device'}];
  for(const headers of denied)for(const [path,data] of [['/status',undefined],['/link',s.link]] as const)expect((await s.call(path,data,headers)).status).toBe(403);
  expect((await s.call('/link',s.link,{Origin:'https://foreign.test'})).status).toBe(403);
  expect((await s.call('/sync',{}, {Origin:''})).status).toBe(403);
  expect(s.mocks.contract).not.toHaveBeenCalled();expect(s.network).not.toHaveBeenCalled();
 });
 it('defaults disabled, exposes only operational status and makes no provider requests',async()=>{
  const s=await setup();delete (s.env as any).CREATOR_FEEDBACK_ENABLED;delete (s.env as any).CREATOR_FEEDBACK_TOKEN;
  const status=await(await s.call()).json() as any;expect(status).toMatchObject({enabled:false,configured:false});
  for(const path of ['/sync','/link'])expect((await s.call(path,s.link)).status).toBe(503);
  expect(s.mocks.contract).not.toHaveBeenCalled();expect(s.network).not.toHaveBeenCalled();
 });
 it('status and paginated list omit tokens, fingerprints and all source payloads',async()=>{
  const s=await setup();const status=await s.call();expect(status.headers.get('Cache-Control')).toBe('no-store');
  const text=await status.text();for(const secret of [s.env.CREATOR_FEEDBACK_TOKEN,s.fingerprint,'Synthetic source opinion','Synthetic only','Synthetic human feedback'])expect(text).not.toContain(secret);
  s.cache({...game(),id:'game_z'});const list=await(await s.call('/games?limit=1')).json() as any;
  expect(list.games).toEqual([{game_id:'game_synthetic',last_sequence:2}]);expect(list.nextAfter).toBe('game_synthetic');expect(JSON.stringify(list)).not.toContain('Synthetic source opinion');
  const second=await(await s.call('/games?limit=1&after=game_synthetic')).json() as any;expect(second.games).toEqual([{game_id:'game_z',last_sequence:2}]);expect(second.nextAfter).toBeNull();
  for(const limit of ['0','51','1.5','NaN'])expect((await s.call('/games?limit='+limit)).status).toBe(400);
  expect((await s.call('/games?after=../private')).status).toBe(400);expect(s.network).not.toHaveBeenCalled();
 });
 it('preserves raw zero/null and decision_review without inferring approval or publishing candidate rules',async()=>{
  const s=await setup(),before=s.preserved();
  const detail=await(await s.call('/game?id=game_synthetic')).json() as any;expect(detail.game).toEqual(game());expect(detail.game.reviews[0]).toMatchObject({stage:'decision_review',reviewerRole:null,total:null,decision:null,scores:[{score:0},{score:null}]});
  const incoming=await(await s.call('/rules')).json() as any;expect(incoming.published).toBe(false);expect(incoming.rules.rules[0].id).toBe('source_rule');expect(s.preserved()).toEqual(before);
 });
 it('returns the cached contract with its source and collection time without another provider request',async()=>{
  const s=await setup(),value={contract,fetchedAt:'2026-11-03T00:00:00Z',source:'https://creator-hub-7mi.pages.dev/api/integrations/feedback/v1/contract'};
  s.sqlite.prepare("INSERT INTO creator_feedback_chunks(kind,entity_id,game_id,part,payload) VALUES('contract','current',NULL,0,?)").run(JSON.stringify(value));
  expect(await(await s.call('/contract')).json()).toEqual({generation:1,contract:value});expect(s.mocks.contract).not.toHaveBeenCalled();expect(s.network).not.toHaveBeenCalled();
 });
 it('bounds JSON bytes and allows only documented link fields and exact external identifiers',async()=>{
  const s=await setup();
  expect((await s.call('/link',{...s.link,owner_id:'other'})).status).toBe(400);
  expect((await s.call('/link',{...s.link,workId:'https://foreign.test'})).status).toBe(400);
  expect((await s.call('/link',{...s.link,extra:'x'.repeat(5000)})).status).toBe(413);
  expect((await s.call('/link',s.link,{'Content-Length':'5000'})).status).toBe(413);
  expect((await s.call('/link',s.link,{'Content-Type':'text/plain'})).status).toBe(415);
  const malformed=new Request('https://feedback.test/api/admin/creator-feedback/link',{method:'POST',headers:{Cookie:s.cookie,Origin:'https://feedback.test','Content-Type':'application/json'},body:'{"broken":'});
  expect((await creatorFeedbackAdminApi(malformed,s.env))!.status).toBe(400);expect(s.mocks.contract).not.toHaveBeenCalled();
 });
 it('links using existing task owner only after contract scope and exact identity plus work validation; existing reports stay immutable',async()=>{
  const s=await setup(),before=s.preserved();const result=await s.call('/link',s.link);expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({linked:true,jobId:'task-one',workId:'game_synthetic',versionId:'version_synthetic'});
  expect(s.mocks.contract).toHaveBeenCalledOnce();expect(s.mocks.identity).toHaveBeenCalledWith('known-version');expect(s.mocks.game).toHaveBeenCalledWith('known-work');
  expect(s.sqlite.prepare('SELECT owner_id,known_work_id,known_submission_id FROM creator_feedback_links').get()).toMatchObject({owner_id:'member',known_work_id:'known-work',known_submission_id:'known-version'});
  expect(s.preserved()).toEqual(before);expect(s.network).not.toHaveBeenCalled();
  const detail=await(await s.call('/job?jobId=task-one')).json() as any;expect(detail.ai).toEqual({score:0,model:'synthetic-agent',dimensions:{aes:0,ease:null,play:0}});expect(detail.reviews).toEqual(game().reviews);
 });
 it('rejects a missing task, human-binding conflict and immutable reassignment before any provider request',async()=>{
  const s=await setup();expect((await s.call('/link',{...s.link,jobId:'missing-task'})).status).toBe(404);
  expect((await s.call('/link',{...s.link,versionId:'other-version'})).status).toBe(409);expect(s.mocks.contract).not.toHaveBeenCalled();
  expect((await s.call('/link',s.link)).status).toBe(200);s.mocks.contract.mockClear();
  s.sqlite.prepare('DELETE FROM review_human_reviews').run();expect((await s.call('/link',{...s.link,workId:'other-work'})).status).toBe(409);expect(s.mocks.contract).not.toHaveBeenCalled();
  expect(s.sqlite.prepare('SELECT known_work_id FROM creator_feedback_links').get()).toMatchObject({known_work_id:'known-work'});
 });
 it('rejects identity/work mismatch, absent exact version and unsynchronized versions',async()=>{
  const s=await setup();s.mocks.identity.mockResolvedValueOnce({id:'version_synthetic',workId:'game_different',idNamespace:'integration_pseudonym'});expect((await s.call('/link',s.link)).status).toBe(409);
  s.mocks.game.mockResolvedValueOnce({...game(),versions:[]});expect((await s.call('/link',s.link)).status).toBe(409);
  s.cache({...game(),versions:[]});expect((await s.call('/link',s.link)).status).toBe(409);expect(s.sqlite.prepare('SELECT COUNT(*) n FROM creator_feedback_links').get()).toMatchObject({n:0});
 });
 it('scope changes purge private cache and links rather than accepting an old identity',async()=>{
  const s=await setup(),before=s.preserved();s.mocks.contract.mockResolvedValueOnce({...contract,scopeRevision:4});expect((await s.call('/link',s.link)).status).toBe(409);
  expect(s.mocks.identity).not.toHaveBeenCalled();expect(s.sqlite.prepare('SELECT COUNT(*) n FROM creator_feedback_games').get()).toMatchObject({n:0});expect(s.preserved()).toEqual(before);
 });
 it('fences generation and credential rotation while a provider request is in flight',async()=>{
  const s=await setup(),before=s.preserved();s.mocks.game.mockImplementationOnce(async()=>{s.sqlite.prepare('UPDATE creator_feedback_state SET generation=generation+1,credential_hash=? WHERE id=1').run(await digest('synthetic-rotated-token'));return game();});
  expect((await s.call('/link',s.link)).status).toBe(409);expect(s.sqlite.prepare('SELECT COUNT(*) n FROM creator_feedback_links').get()).toMatchObject({n:0});expect(s.preserved()).toEqual(before);
 });
 it('does not create a ghost link when a removed event erases the cached game between read and insert',async()=>{
  const s=await setup();let removed=false;s.onRead(query=>{if(!removed&&query.startsWith('SELECT payload FROM creator_feedback_chunks')){removed=true;s.sqlite.prepare('DELETE FROM creator_feedback_games WHERE game_id=?').run('game_synthetic');s.sqlite.prepare('DELETE FROM creator_feedback_chunks WHERE game_id=?').run('game_synthetic');}});
  expect((await s.call('/link',s.link)).status).toBe(409);expect(removed).toBe(true);expect(s.sqlite.prepare('SELECT COUNT(*) n FROM creator_feedback_links').get()).toMatchObject({n:0});
 });
 it.each(['/game?id=game_synthetic','/games','/rules','/contract'])('does not return old source data for %s after a generation changes during the read',async path=>{
  const s=await setup();let rotated=false;s.onRead(query=>{const target=path==='/games'?query.includes('SELECT game_id,last_sequence'):query.startsWith('SELECT payload FROM creator_feedback_chunks');if(!rotated&&target){rotated=true;s.sqlite.prepare('UPDATE creator_feedback_state SET generation=generation+1').run();}});
  const result=await s.call(path);expect(rotated).toBe(true);expect(result.status).toBe(409);expect(await result.text()).not.toContain('Synthetic source opinion');
 });
 it('does not return a previously linked private job after authorization generation changes during the read',async()=>{
  const s=await setup();expect((await s.call('/link',s.link)).status).toBe(200);let rotated=false;
  s.onRead(query=>{if(!rotated&&query.startsWith('SELECT score,result,model')){rotated=true;s.sqlite.prepare('UPDATE creator_feedback_state SET generation=generation+1').run();}});
  const result=await s.call('/job?jobId=task-one');expect(result.status).toBe(409);expect(await result.text()).not.toContain('Synthetic source opinion');
 });

});
