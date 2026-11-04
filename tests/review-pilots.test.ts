import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {reviewPilotsAdminApi,readPilotMembers} from '../server/review-pilots';
import {adminApi} from '../server/admin-api';
import {login} from '../server/settings';
import {configStore,memberStore} from '../server/storage';
import {digest} from '../server/review-device-state';
import type {FeedbackGame} from '../server/creator-feedback-client';

const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.unstubAllGlobals();vi.useRealTimers();});
const fixture=():FeedbackGame=>({id:'game_synthetic',authorId:'author_synthetic',title:'Synthetic',description:'',status:'approved',revision:1,
  createdAt:'now',updatedAt:'now',archived:false,deleted:false,textRedacted:true,idNamespace:'integration_pseudonym',reviews:[],comments:[],
  versions:[{id:'version_synthetic',revision:1,title:'Synthetic',description:'',submittedAt:'now',updateNote:null,withdrawn:false,ruleVersion:null,status:null,statusSource:null,finalReviewId:null,files:{},fileAccess:false}]});
const path='/api/admin/review-pilots',origin='https://pilot.test';
const d1ValueLimit=2*1024*1024;
async function setup(){
  const sql=new DatabaseSync(':memory:');databases.push(sql);
  for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(`migrations/${name}`,'utf8'));
  let beforeBatch=()=>{};
  function enforceValueLimit<T extends Record<string,unknown>>(row:T):T {
    if(Object.values(row).some(value=>typeof value==='string'&&Buffer.byteLength(value)>d1ValueLimit))throw new Error('Synthetic D1 value exceeds 2 MiB');
    return row;
  }
  const DB:any={prepare(query:string){let args:any[]=[];const s:any={bind(...values:any[]){args=values;return s;},first:async()=>{const row=sql.prepare(query).get(...args);return row?enforceValueLimit(row):null;},all:async()=>({results:sql.prepare(query).all(...args).map(enforceValueLimit)}),run:async()=>s.execute(),execute:()=>({meta:{changes:Number(sql.prepare(query).run(...args).changes)}})};return s;},batch:async(ss:any[])=>{beforeBatch();sql.exec('BEGIN');try{const results=ss.map(s=>s.execute());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  const env={DB,ADMIN_PASSWORD:'synthetic-admin',SETTINGS_KEY:'synthetic-settings',CREATOR_FEEDBACK_ENABLED:'true',CREATOR_FEEDBACK_TOKEN:'synthetic-provider-token'};
  const cookie=`pgc_admin=${await login(env.ADMIN_PASSWORD,env)}`,fingerprint=await digest(env.CREATOR_FEEDBACK_TOKEN);
  sql.exec(`INSERT INTO members(id,username,display_name,password_hash,password_salt,enabled,can_review,star,session_version,created_at,updated_at)
    VALUES('member-one','fixture-one','Fixture One','PRIVATE_HASH','PRIVATE_SALT',1,1,1,3,'now','now'),
    ('member-two','fixture-two','Fixture Two','PRIVATE_HASH_2','PRIVATE_SALT_2',0,0,0,8,'now','now');`);
  sql.prepare("UPDATE creator_feedback_state SET generation=1,scope_revision=3,credential_hash=?,status='ready',phase='delta' WHERE id=1").run(fingerprint);
  function cache(game=fixture(),sequence=2,partSize=1000){
    sql.exec('BEGIN');try{
      sql.prepare('INSERT INTO creator_feedback_games(game_id,last_sequence,updated_at) VALUES(?,?,1) ON CONFLICT(game_id) DO UPDATE SET last_sequence=excluded.last_sequence').run(game.id,sequence);
      sql.prepare("DELETE FROM creator_feedback_chunks WHERE kind='game' AND entity_id=?").run(game.id);
      const raw=JSON.stringify(game),chunk=sql.prepare("INSERT INTO creator_feedback_chunks(kind,entity_id,game_id,part,payload) VALUES('game',?,?,?,?)");
      for(let at=0,part=0;at<raw.length;at+=partSize,part++)chunk.run(game.id,game.id,part,raw.slice(at,at+partSize));
      sql.exec('COMMIT');
    }catch(error){sql.exec('ROLLBACK');throw error;}
  }
  cache();
  let live=fixture(),providerStatus=200,scopeRevision=3,identityWork=live.id;
  const network=vi.fn<typeof fetch>(async(input,init)=>{
    const url=new URL(String(input));expect(url.origin).toBe('https://creator-hub-7mi.pages.dev');expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${env.CREATOR_FEEDBACK_TOKEN}`);
    if(providerStatus!==200)return Response.json({error:'PRIVATE_PROVIDER_ERROR'}, {status:providerStatus});
    if(url.pathname.endsWith('/contract'))return Response.json({version:1,scopeRevision,dataset:'ordinary_games',authorScope:'all',fileVersionCount:0,idNamespace:'integration_pseudonym',historySince:null,pollingSeconds:120,snapshotsExpireHours:24,pagination:{defaultLimit:20,maxLimit:50},rateLimit:{requestsPerMinute:120}});
    if(url.pathname.endsWith('/identity'))return Response.json({id:live.versions[0].id,workId:identityWork,idNamespace:'integration_pseudonym'});
    if(url.pathname.includes('/games/'))return Response.json({game:live});
    throw new Error('Unexpected provider route');
  });vi.stubGlobal('fetch',network);
  const req=(route='',data?:unknown,headers:Record<string,string>={})=>new Request(origin+path+route,{method:data===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)});
  const call=async(route='',data?:unknown,headers?:Record<string,string>)=>(await reviewPilotsAdminApi(req(route,data,headers),env))!;
  const update=(fields:Record<string,unknown>={})=>({memberId:'member-one',pilotEnabled:true,creatorAccount:'  fixture Creator  ',expectedRevision:0,requestId:crypto.randomUUID(),...fields});
  const link=(fields:Record<string,unknown>={})=>({memberId:'member-one',workId:'known-work',versionId:'known-version',ownershipConfirmed:true,expectedRevision:0,requestId:crypto.randomUUID(),...fields});
  const unlink=(expectedRevision:number)=>({memberId:'member-one',expectedRevision,requestId:crypto.randomUUID()});
  const list=async()=>((await(await call()).json()) as any).members;
  const members=()=>sql.prepare('SELECT * FROM members ORDER BY id').all();
  return {sql,DB,env,req,call,network,cache,update,link,unlink,list,members,beforeBatch(fn:()=>void){beforeBatch=fn;},provider(status:number){providerStatus=status;},setScope(revision:number){scopeRevision=revision;},setLive(game:FeedbackGame){live=game;},setIdentityWork(id:string){identityWork=id;}};
}

describe('administrator pilot member settings',()=>{
  it('lists every member with separate default flags, through the admin route',async()=>{
    const s=await setup(),response=await adminApi(s.req(),configStore(s.DB),s.env,memberStore(s.DB),s.DB);
    expect(response?.status).toBe(200);expect(response?.headers.get('Cache-Control')).toBe('no-store');
    const result=await response!.json() as any;expect(result.members).toHaveLength(2);
    expect(result.members[0]).toMatchObject({memberId:'member-one',accountEnabled:true,pilotEnabled:false,revision:0,creatorAccount:'',enrollmentStartedAt:null,updatedAt:null,binding:{status:'unlinked'}});
    expect(result.members[1]).toMatchObject({memberId:'member-two',accountEnabled:false,pilotEnabled:false});expect(JSON.stringify(result)).not.toContain('PRIVATE_');expect(s.network).not.toHaveBeenCalled();
  });
  it('rejects anonymous, member and any Authorization, and requires same-origin writes',async()=>{
    const s=await setup();
    for(const headers of [{Cookie:''},{Cookie:'pgc_member=fixture'},{Authorization:'Bearer fixture'},{Authorization:''}] as Record<string,string>[]){expect((await s.call('',undefined,headers)).status).toBe(403);expect((await s.call('/member',s.update(),headers)).status).toBe(403);}
    expect((await s.call('/member',s.update(),{Origin:'https://foreign.test'})).status).toBe(403);expect((await s.call('/link',s.link(),{Origin:''})).status).toBe(403);
    expect(s.sql.prepare('SELECT COUNT(*) AS n FROM review_pilot_members').get()).toMatchObject({n:0});expect(s.network).not.toHaveBeenCalled();
  });
  it('checks strict fields, 4 KiB, UUIDs, revision and ownership before mutating or querying upstream',async()=>{
    const s=await setup();
    for(const data of [s.update({star:true}),s.update({pilotEnabled:1}),s.update({creatorAccount:'x'.repeat(121)}),s.update({creatorAccount:'a\nb'}),s.update({expectedRevision:-1}),s.update({requestId:'bad'})])expect((await s.call('/member',data)).status).toBe(400);
    expect((await s.call('/member',s.update({creatorAccount:'x'.repeat(5000)}))).status).toBe(413);
    expect((await s.call('/member',s.update(),{'Content-Type':'text/plain'})).status).toBe(415);
    expect((await s.call('/link',s.link({ownershipConfirmed:false}))).status).toBe(400);
    expect((await s.call('/link',s.link({workId:'../other'}))).status).toBe(400);
    expect((await s.call('/member',s.update({memberId:'missing'}))).status).toBe(404);
    expect(s.network).not.toHaveBeenCalled();
  });
  it('persists enrollment history, keeps entry time across edits, and never mutates member credentials or permissions',async()=>{
    vi.useFakeTimers();vi.setSystemTime(Date.parse('2026-11-04T01:00:00Z'));const s=await setup(),before=s.members();
    const payload=s.update(),saved=await(await s.call('/member',payload)).json() as any;
    expect(saved.member).toMatchObject({pilotEnabled:true,creatorAccount:'fixture Creator',revision:1,enrollmentStartedAt:'2026-11-04T01:00:00.000Z',binding:{status:'declared'}});
    expect(await(await s.call('/member',payload)).json()).toEqual(saved);
    expect((await s.call('/member',{...payload,creatorAccount:'different'})).status).toBe(409);
    expect((await s.call('/member',s.update())).status).toBe(409);
    vi.setSystemTime(Date.parse('2026-11-04T02:00:00Z'));await s.call('/member',s.update({expectedRevision:1,creatorAccount:'changed'}));
    expect((await s.list())[0].enrollmentStartedAt).toBe('2026-11-04T01:00:00.000Z');
    await s.call('/member',s.update({expectedRevision:2,pilotEnabled:false,creatorAccount:'changed'}));
    vi.setSystemTime(Date.parse('2026-11-04T03:00:00Z'));await s.call('/member',s.update({expectedRevision:3,creatorAccount:'changed'}));
    expect((await s.list())[0].enrollmentStartedAt).toBe('2026-11-04T03:00:00.000Z');
    expect(s.sql.prepare('SELECT revision,pilot_enabled,enrollment_started_at FROM review_pilot_requests ORDER BY revision').all()).toEqual([
      {revision:1,pilot_enabled:1,enrollment_started_at:'2026-11-04T01:00:00.000Z'},{revision:2,pilot_enabled:1,enrollment_started_at:'2026-11-04T01:00:00.000Z'},
      {revision:3,pilot_enabled:0,enrollment_started_at:'2026-11-04T01:00:00.000Z'},{revision:4,pilot_enabled:1,enrollment_started_at:'2026-11-04T03:00:00.000Z'},
    ]);expect(s.members()).toEqual(before);expect(s.network).not.toHaveBeenCalled();
  });
  it('checks exact upstream ownership and cache, replays without network, and prevents two members claiming the same author',async()=>{
    const s=await setup();await s.call('/member',s.update());const entry=(await s.list())[0].enrollmentStartedAt;
    const payload=s.link({expectedRevision:1});const response=await s.call('/link',payload);expect(response.status).toBe(200);
    const result=await response.json() as any;expect(result.member).toMatchObject({revision:2,enrollmentStartedAt:entry,binding:{status:'linked',sourceAuthorId:'author_synthetic',workId:'game_synthetic',versionId:'version_synthetic'}});
    expect(s.network).toHaveBeenCalledTimes(3);expect(await(await s.call('/link',payload)).json()).toEqual(result);expect(s.network).toHaveBeenCalledTimes(3);
    await s.call('/member',s.update({memberId:'member-two',creatorAccount:'Second creator'}));
    expect((await s.call('/link',s.link({memberId:'member-two',expectedRevision:1}))).status).toBe(409);
    const unlink=await(await s.call('/unlink',s.unlink(2))).json() as any;expect(unlink.member).toMatchObject({pilotEnabled:true,creatorAccount:'fixture Creator',revision:3,enrollmentStartedAt:entry,binding:{status:'declared',sourceAuthorId:null}});
    expect((await s.call('/link',s.link({memberId:'member-two',expectedRevision:1}))).status).toBe(200);
    const receipts=JSON.stringify(s.sql.prepare('SELECT * FROM review_pilot_requests').all());expect(receipts).not.toMatch(/known-work|known-version|author_synthetic|synthetic-provider-token/);
  });
  it('does not link a mismatched work, a deleted game, or an author absent from the same cached version',async()=>{
    const s=await setup();expect((await s.call('/link',s.link())).status).toBe(409);expect(s.network).not.toHaveBeenCalled();
    await s.call('/member',s.update());s.setIdentityWork('game_other');expect((await s.call('/link',s.link({expectedRevision:1}))).status).toBe(409);
    s.setIdentityWork('game_synthetic');s.setLive({...fixture(),deleted:true});expect((await s.call('/link',s.link({expectedRevision:1}))).status).toBe(409);
    s.setLive({...fixture(),authorId:'author_other'});expect((await s.call('/link',s.link({expectedRevision:1}))).status).toBe(409);
    expect(s.sql.prepare('SELECT COUNT(*) AS n FROM review_pilot_requests').get()).toMatchObject({n:1});
  });
  it('loses the write CAS if cache sequence or authorization generation changes after lookup',async()=>{
    const s=await setup();await s.call('/member',s.update());s.beforeBatch(()=>{s.sql.exec('UPDATE creator_feedback_games SET last_sequence=3');});expect((await s.call('/link',s.link({expectedRevision:1}))).status).toBe(409);
    s.beforeBatch(()=>{s.sql.exec('UPDATE creator_feedback_state SET generation=2');});expect((await s.call('/link',s.link({expectedRevision:1}))).status).toBe(409);
    expect((await s.list())[0]).toMatchObject({revision:1,binding:{status:'declared'}});
  });
  it('uses one winning write under concurrent different requests with the same revision',async()=>{
    const s=await setup();const results=await Promise.all([s.call('/member',s.update()),s.call('/member',s.update({creatorAccount:'second'}))]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect(s.sql.prepare('SELECT COUNT(*) AS n FROM review_pilot_requests').get()).toMatchObject({n:1});expect((await s.list())[0].revision).toBe(1);
  });
  it('reads complete multi-part games, clears soft-deleted or changed bindings, and never revives on cache restoration',async()=>{
    const s=await setup();await s.call('/member',s.update());const multi={...fixture(),description:'synthetic text '.repeat(400)};s.cache(multi);
    expect((s.sql.prepare("SELECT COUNT(*) AS n FROM creator_feedback_chunks WHERE kind='game'").get() as any).n).toBeGreaterThan(1);
    expect((await s.call('/link',s.link({expectedRevision:1}))).status).toBe(200);expect((await readPilotMembers(s.DB))[0].binding.status).toBe('linked');
    s.cache({...multi,description:'updated '.repeat(400)},3);expect((await s.list())[0].binding.status).toBe('linked');
    s.cache({...multi,deleted:true},4);expect((await s.list())[0]).toMatchObject({revision:3,binding:{status:'stale',sourceAuthorId:null,workId:null,versionId:null}});
    s.cache(multi,5);expect((await s.list())[0].binding.status).toBe('stale');
    expect(s.sql.prepare('SELECT source_author_id,work_id,version_id FROM review_pilot_members').get()).toEqual({source_author_id:null,work_id:null,version_id:null});
  });
  it('verifies and reads a game above the D1 single-value limit from individually bounded parts',async()=>{
    const s=await setup();await s.call('/member',s.update());
    const large={...fixture(),description:'Synthetic game description '.repeat(100000)};
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(d1ValueLimit);
    s.cache(large,2,15000);s.setLive(large);
    const response=await s.call('/link',s.link({expectedRevision:1}));expect(response.status).toBe(200);
    expect((await response.json() as any).member.binding).toMatchObject({status:'linked',workId:large.id,versionId:'version_synthetic'});
    expect((await s.list())[0].binding).toMatchObject({status:'linked',sourceAuthorId:large.authorId});
    expect((await readPilotMembers(s.DB))[0].binding.status).toBe('linked');
  });
  it('clears binding when the account label changes, or source is physically removed or changes scope',async()=>{
    const s=await setup();await s.call('/member',s.update());await s.call('/link',s.link({expectedRevision:1}));
    await s.call('/member',s.update({expectedRevision:2,creatorAccount:'changed'}));expect((await s.list())[0]).toMatchObject({revision:3,pilotEnabled:true,binding:{status:'declared',sourceAuthorId:null}});
    await s.call('/link',s.link({expectedRevision:3}));s.sql.exec("DELETE FROM creator_feedback_games WHERE game_id='game_synthetic'");s.cache();expect((await s.list())[0]).toMatchObject({revision:5,pilotEnabled:true,creatorAccount:'changed',binding:{status:'stale'}});
    await s.call('/link',s.link({expectedRevision:5}));s.sql.exec('UPDATE creator_feedback_state SET scope_revision=4');expect((await s.list())[0]).toMatchObject({revision:7,binding:{status:'stale',sourceAuthorId:null}});
  });
  it.each([401,409,410])('clears revoked source data on provider %s without dropping enrollment or replaying old identity',async status=>{
    const s=await setup();await s.call('/member',s.update());const linked=s.link({expectedRevision:1});await s.call('/link',linked);s.provider(status);
    const response=await s.call('/link',s.link({expectedRevision:2}));expect(response.status).toBe(409);expect(await response.text()).not.toContain('PRIVATE_PROVIDER_ERROR');
    expect(s.sql.prepare('SELECT COUNT(*) AS n FROM creator_feedback_games').get()).toMatchObject({n:0});
    expect(s.sql.prepare('SELECT status FROM creator_feedback_state').get()).toMatchObject({status:status===401?'auth_revoked':'disabled'});
    const calls=s.network.mock.calls.length;const replay=await(await s.call('/link',linked)).json() as any;
    expect(replay.member).toMatchObject({pilotEnabled:true,creatorAccount:'fixture Creator',binding:{status:'stale',sourceAuthorId:null,workId:null}});expect(s.network).toHaveBeenCalledTimes(calls);
  });
  it('clears a binding observed while disabled or a credential mismatch, and never revives it on restoration',async()=>{
    const s=await setup();await s.call('/member',s.update());await s.call('/link',s.link({expectedRevision:1}));const calls=s.network.mock.calls.length;
    s.env.CREATOR_FEEDBACK_ENABLED='false';expect((await s.list())[0]).toMatchObject({revision:3,binding:{status:'stale',sourceAuthorId:null}});expect((await s.call('/link',s.link({expectedRevision:3}))).status).toBe(503);
    s.env.CREATOR_FEEDBACK_ENABLED='true';expect((await s.list())[0].binding.status).toBe('stale');expect(s.network).toHaveBeenCalledTimes(calls);
    await s.call('/link',s.link({expectedRevision:3}));const token=s.env.CREATOR_FEEDBACK_TOKEN;s.env.CREATOR_FEEDBACK_TOKEN='synthetic-replacement-token';
    expect((await s.list())[0]).toMatchObject({revision:5,binding:{status:'stale',sourceAuthorId:null}});s.env.CREATOR_FEEDBACK_TOKEN=token;expect((await s.list())[0].binding.status).toBe('stale');
  });
  it('preserves a binding temporarily hidden during an unchanged authorization snapshot',async()=>{
    const s=await setup();await s.call('/member',s.update());await s.call('/link',s.link({expectedRevision:1}));s.sql.exec("UPDATE creator_feedback_state SET phase='snapshot'");
    expect((await s.list())[0]).toMatchObject({revision:2,binding:{status:'stale',sourceAuthorId:null}});s.sql.exec("UPDATE creator_feedback_state SET phase='delta'");
    expect((await s.list())[0]).toMatchObject({revision:2,binding:{status:'linked',sourceAuthorId:'author_synthetic'}});
  });
  it('allows a new reference for the same author but requires unlinking before a different author',async()=>{
    const s=await setup();await s.call('/member',s.update());await s.call('/link',s.link({expectedRevision:1}));
    const sameAuthor={...fixture(),id:'game_same_author'};s.cache(sameAuthor);s.setLive(sameAuthor);s.setIdentityWork(sameAuthor.id);
    expect((await s.call('/link',s.link({expectedRevision:2}))).status).toBe(200);
    const otherAuthor={...fixture(),id:'game_other_author',authorId:'author_other'};s.cache(otherAuthor);s.setLive(otherAuthor);s.setIdentityWork(otherAuthor.id);
    expect((await s.call('/link',s.link({expectedRevision:3}))).status).toBe(409);expect((await s.list())[0]).toMatchObject({revision:3,binding:{status:'linked',workId:sameAuthor.id}});
    await s.call('/unlink',s.unlink(3));expect((await s.call('/link',s.link({expectedRevision:4}))).status).toBe(200);
  });
});
