import {CreatorFeedbackClient, FeedbackProviderError} from './creator-feedback-client';

export type FeedbackSyncEnv = {DB:any; CREATOR_FEEDBACK_TOKEN?:string; CREATOR_FEEDBACK_ENABLED?:string};
type Client = Pick<CreatorFeedbackClient,'contract'|'snapshot'|'games'|'changes'|'rules'>;
const POLL=120_000, CONTINUE=5_000, LEASE=90_000;
const tables=['creator_feedback_links','creator_feedback_chunks','creator_feedback_games','creator_feedback_events'];
const state=(DB:any)=>DB.prepare('SELECT * FROM creator_feedback_state WHERE id=1').first();
const cursor=(value:string)=>{const m=/^(\d+):(\d+)$/.exec(value);if(!m||!Number.isSafeInteger(Number(m[1]))||!Number.isSafeInteger(Number(m[2])))throw new Error('cursor');return {scope:Number(m[1]),seq:Number(m[2])};};
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(n=>n.toString(16).padStart(2,'0')).join('');

/** This returns only operational metadata; never credentials, hashes or source text. */
export async function readFeedbackStatus(DB:any){
 const s=await state(DB);
 return {status:s?.status||'disabled',phase:s?.phase||'snapshot',complete:s?.phase==='delta',scopeRevision:s?.scope_revision??null,nextRunAt:s?.next_run_at??null,lastSuccessAt:s?.last_success_at??null,lastAttemptAt:s?.updated_at??null,errorCode:s?.error_code??null,failures:s?.failures||0};
}
export async function readFeedbackGame(DB:any,gameId:string){return readChunks(DB,'game',gameId);}
export async function readFeedbackRules(DB:any){return readChunks(DB,'rules','candidate');}
export async function readFeedbackContract(DB:any){return readChunks(DB,'contract','current');}
/** Stable identity/revision order; this is not a reconstructed event-time game timeline. */
export async function readFeedbackReviewHistory(DB:any,gameId:string){
 const r=await DB.prepare("SELECT entity_id,payload FROM creator_feedback_chunks WHERE kind='review' AND game_id=? ORDER BY entity_id,part").bind(gameId).all();
 const values=new Map<string,string>();for(const row of r.results||[])values.set(row.entity_id,(values.get(row.entity_id)||'')+row.payload);
 return [...values.values()].map(raw=>JSON.parse(raw)).sort((a,b)=>String(a.id).localeCompare(String(b.id))||a.revision-b.revision);
}
async function readChunks(DB:any,kind:string,id:string){
 const r=await DB.prepare('SELECT payload FROM creator_feedback_chunks WHERE kind=? AND entity_id=? ORDER BY part').bind(kind,id).all();
 return r.results?.length?JSON.parse(r.results.map((p:any)=>p.payload).join('')):null;
}
/** Administrative purge also fences any in-flight fetch. Rotation is required to leave auth_revoked. */
export async function purgeFeedbackData(DB:any,options:{halt?:boolean;now?:number;expectedGeneration?:number}={}){
 const now=options.now??Date.now();
 const expected=options.expectedGeneration;
 const condition=expected===undefined?'1':'EXISTS(SELECT 1 FROM creator_feedback_state WHERE id=1 AND generation=?)';
 const bind=expected===undefined?[]:[expected];
 await DB.batch([...tables.map(t=>DB.prepare(`DELETE FROM ${t} WHERE ${condition}`).bind(...bind)),DB.prepare(`UPDATE creator_feedback_state SET generation=generation+1,status=CASE WHEN status='auth_revoked' THEN 'auth_revoked' ELSE ? END,phase='snapshot',pending_key=NULL,snapshot_id=NULL,snapshot_cursor=NULL,snapshot_after=NULL,snapshot_expires_at=NULL,cursor=NULL,scope_revision=NULL,lease_token=NULL,lease_until=0,next_run_at=CASE WHEN status='auth_revoked' THEN NULL ELSE ? END,failures=0,error_code=CASE WHEN status='auth_revoked' THEN 'authorization_revoked' ELSE NULL END,last_success_at=NULL,updated_at=? WHERE id=1 AND ${condition}`).bind(options.halt?'auth_revoked':'disabled',options.halt?null:now,now,...bind)]);
 return readFeedbackStatus(DB);
}

export async function runFeedbackSync(env:FeedbackSyncEnv,options:{client?:Client;now?:number}={}){
 const DB=env.DB,started=Date.now(),now=options.now??started,clock=()=>now+Date.now()-started;
 let s=await state(DB);
 if(env.CREATOR_FEEDBACK_ENABLED!=='true'||!env.CREATOR_FEEDBACK_TOKEN){
  if(s.status!=='disabled'&&s.status!=='auth_revoked')await purgeFeedbackData(DB,{now});
  return readFeedbackStatus(DB);
 }
 const fingerprint=await hash(env.CREATOR_FEEDBACK_TOKEN);
 if(s.credential_hash!==fingerprint){
  const guard='EXISTS(SELECT 1 FROM creator_feedback_state WHERE id=1 AND generation=? AND credential_hash IS ?)';
  await DB.batch([...tables.map(t=>DB.prepare(`DELETE FROM ${t} WHERE ${guard}`).bind(s.generation,s.credential_hash)),DB.prepare(`UPDATE creator_feedback_state SET credential_hash=?,generation=generation+1,status='ready',phase='snapshot',scope_revision=NULL,pending_key=NULL,snapshot_id=NULL,snapshot_cursor=NULL,snapshot_after=NULL,snapshot_expires_at=NULL,cursor=NULL,lease_token=NULL,lease_until=0,next_run_at=?,failures=0,error_code=NULL,last_success_at=NULL,updated_at=? WHERE id=1 AND generation=? AND credential_hash IS ?`).bind(fingerprint,now,now,s.generation,s.credential_hash)]);
  s=await state(DB);
 }
 if(s.status==='auth_revoked'||s.credential_hash!==fingerprint)return readFeedbackStatus(DB);
 const lease=crypto.randomUUID();
 await DB.prepare(`UPDATE creator_feedback_state SET lease_token=?,lease_until=?,status='syncing',updated_at=? WHERE id=1 AND generation=? AND credential_hash=? AND lease_until<=? AND (next_run_at IS NULL OR next_run_at<=?) AND status<>'auth_revoked'`).bind(lease,now+LEASE,now,s.generation,fingerprint,now,now).run();
 s=await state(DB);
 if(s.lease_token!==lease)return readFeedbackStatus(DB);
 const generation=s.generation;
 let fenceTime=clock();
 const guard='EXISTS(SELECT 1 FROM creator_feedback_state WHERE id=1 AND generation=? AND lease_token=? AND lease_until>=?)';
 const guarded=(sql:string,params:any[]=[])=>DB.prepare(sql).bind(...params,generation,lease,fenceTime);
 const update=(set:string,params:any[]=[])=>guarded(`UPDATE creator_feedback_state SET ${set} WHERE id=1 AND ${guard}`,params);
 // An observed error must survive expiry of its own lease. A successor's
 // different lease token (or generation) still fences this handler out.
 const errorGuard='EXISTS(SELECT 1 FROM creator_feedback_state WHERE id=1 AND generation=? AND lease_token=?)';
 const errorStatement=(sql:string,params:any[]=[])=>DB.prepare(sql).bind(...params,generation,lease);
 const errorUpdate=(set:string,params:any[]=[])=>errorStatement(`UPDATE creator_feedback_state SET ${set} WHERE id=1 AND ${errorGuard}`,params);
 const purge=()=>tables.map(t=>errorStatement(`DELETE FROM ${t} WHERE ${errorGuard}`));
 const reset=async(status:string,error:string|null,next:number|null,scope:number|null=null)=>{
  await DB.batch([...purge(),errorUpdate(`generation=generation+1,status=?,phase='snapshot',pending_key=NULL,snapshot_id=NULL,snapshot_cursor=NULL,snapshot_after=NULL,snapshot_expires_at=NULL,cursor=NULL,scope_revision=?,lease_token=NULL,lease_until=0,next_run_at=?,failures=0,error_code=?,last_success_at=NULL`,[status,scope,next,error])]);
 };
 const finish=(phase:string,next:number)=>update(`phase=?,status='ready',next_run_at=?,last_success_at=?,failures=0,error_code=NULL,lease_token=NULL,lease_until=0`,[phase,next,clock()]);
 const chunks=(kind:string,id:string,gameId:string|null,value:unknown)=>{
  const json=JSON.stringify(value),parts:string[]=[];
  // At most 15k UTF-16 units / 45k UTF-8 bytes; keep surrogate pairs intact.
  for(let at=0;at<json.length;){let end=Math.min(at+15_000,json.length);const last=json.charCodeAt(end-1);if(end<json.length&&last>=0xd800&&last<=0xdbff)end--;parts.push(json.slice(at,end));at=end;}
  return [guarded(`DELETE FROM creator_feedback_chunks WHERE kind=? AND entity_id=? AND ${guard}`,[kind,id]),...parts.map((payload,i)=>guarded(`INSERT INTO creator_feedback_chunks(kind,entity_id,game_id,part,payload) SELECT ?,?,?,?,? WHERE ${guard} ON CONFLICT(kind,entity_id,part) DO UPDATE SET payload=excluded.payload,game_id=excluded.game_id`,[kind,id,gameId,i,payload]))];
 };
 const gameWrites=(game:any,sequence:number)=>[
  guarded(`INSERT INTO creator_feedback_games(game_id,last_sequence,updated_at) SELECT ?,?,? WHERE ${guard} ON CONFLICT(game_id) DO UPDATE SET last_sequence=excluded.last_sequence,updated_at=excluded.updated_at`,[game.id,sequence,clock()]),
  ...chunks('game',game.id,game.id,game),
  ...(game.versions||[]).flatMap((v:any)=>(v.reviews||[]).flatMap((r:any)=>chunks('review',`${r.id}:${r.revision}`,game.id,r))),
  ...(game.reviews||[]).flatMap((r:any)=>chunks('review',`${r.id}:${r.revision}`,game.id,r))
 ];
 try{
  const client=options.client??new CreatorFeedbackClient(env.CREATOR_FEEDBACK_TOKEN);
  const contract=await client.contract();fenceTime=clock();
  const contractProvenance={contract,fetchedAt:new Date(clock()).toISOString(),source:'https://creator-hub-7mi.pages.dev/api/integrations/feedback/v1/contract'};
  if(s.scope_revision!==null&&contract.scopeRevision!==s.scope_revision){await reset('ready','scope_changed',clock()+CONTINUE,contract.scopeRevision);return readFeedbackStatus(DB);}
  await update('scope_revision=?',[contract.scopeRevision]).run();
  if(s.phase==='snapshot'&&!s.snapshot_id){
   const key=s.pending_key||crypto.randomUUID();
   // Durable before POST: an interrupted response retries the very same UUID.
   await update('pending_key=?',[key]).run();
   const fresh=await state(DB);if(fresh.lease_token!==lease||fresh.generation!==generation||fresh.lease_until<clock())return readFeedbackStatus(DB);
   const snap=await client.snapshot(key);fenceTime=clock();
   if(cursor(snap.cursor).scope!==contract.scopeRevision||cursor(snap.cursor).seq!==snap.watermark)throw new Error('cursor');
   await DB.batch([...chunks('contract','current',null,contractProvenance),update('snapshot_id=?,snapshot_cursor=?,snapshot_expires_at=?,snapshot_after=NULL,pending_key=NULL',[snap.id,snap.cursor,snap.expiresAt]),finish('snapshot',clock()+CONTINUE)]);
  }else if(s.phase==='snapshot'){
   const page=await client.games(s.snapshot_id,s.snapshot_after,20);fenceTime=clock();
   if(page.snapshot!==s.snapshot_id||page.cursor!==s.snapshot_cursor||page.nextAfter===s.snapshot_after&&page.nextAfter!==null)throw new Error('snapshot');
   const writes=page.games.flatMap((g:any)=>gameWrites(g,cursor(s.snapshot_cursor).seq));
   await DB.batch([...writes,...chunks('contract','current',null,contractProvenance),update('snapshot_after=?,cursor=?',[page.nextAfter,page.nextAfter===null?s.snapshot_cursor:null]),finish(page.nextAfter===null?'delta':'snapshot',clock()+CONTINUE)]);
  }else{
   const page=await client.changes(s.cursor,20),before=cursor(s.cursor),after=cursor(page.cursor);
   if(before.scope!==after.scope||after.seq<before.seq||page.hasMore&&after.seq===before.seq)throw new Error('cursor');
   const rules=await client.rules();fenceTime=clock();
   const writes:any[]=[];const seen=new Set<number>(),latest=new Map<string,any>();
   for(const event of page.events as any[]){
    if(!Number.isSafeInteger(event.id)||event.id<0||event.id>after.seq)throw new Error('event');
    if(event.game&&event.workId&&event.game.id!==event.workId)throw new Error('event_identity');
    if(seen.has(event.id))continue;seen.add(event.id);
    if(event.id<=before.seq)continue;
    if(await DB.prepare('SELECT event_id FROM creator_feedback_events WHERE event_id=?').bind(event.id).first())continue;
    writes.push(guarded(`INSERT OR IGNORE INTO creator_feedback_events(event_id,game_id) SELECT ?,? WHERE ${guard}`,[event.id,event.workId??event.game?.id??null]));
    const id=event.workId??event.game?.id;if(id&&(!latest.has(id)||latest.get(id).id<event.id))latest.set(id,event);
   }
   for(const [id,event]of latest){
    const old=await DB.prepare('SELECT last_sequence FROM creator_feedback_games WHERE game_id=?').bind(id).first();
    if(old&&old.last_sequence>=event.id)continue;
    if(event.operation==='removed'){
     writes.push(...['creator_feedback_links','creator_feedback_chunks','creator_feedback_games'].map(t=>guarded(`DELETE FROM ${t} WHERE game_id=? AND ${guard}`,[id])));
     writes.push(guarded(`UPDATE creator_feedback_events SET game_id=NULL WHERE game_id=? AND ${guard}`,[id]));
     // Retain only event IDs for deduplication; erase even their game association.
    }else if(event.game){writes.push(...gameWrites(event.game,event.id));}
   }
   await DB.batch([...writes,...chunks('rules','candidate',null,rules),...chunks('contract','current',null,contractProvenance),update('cursor=?',[page.cursor]),finish('delta',clock()+(page.hasMore?CONTINUE:POLL))]);
  }
 }catch(error){
  fenceTime=clock();
  if(error instanceof FeedbackProviderError&&error.status===401)await reset('auth_revoked','authorization_revoked',null);
  else if(error instanceof FeedbackProviderError&&error.status===409)await reset('ready','scope_changed',clock()+CONTINUE);
  else if(error instanceof FeedbackProviderError&&error.status===410){
   // Expiration rebuilds snapshot data; previously authorized caches are purged too.
   await reset('ready','snapshot_expired',clock()+CONTINUE,s.scope_revision);
  }else{
   const limited=error instanceof FeedbackProviderError&&error.status===429;
   const delay=limited?Math.max(60_000,(error.retryAfterSeconds||0)*1000):Math.min(30*60_000,30_000*2**Math.min(s.failures,6));
   await errorUpdate(`status='backoff',next_run_at=?,failures=failures+1,error_code=?,lease_token=NULL,lease_until=0`,[clock()+delay,limited?'rate_limited':error instanceof FeedbackProviderError&&error.status>=500?'provider_unavailable':error instanceof FeedbackProviderError?'provider_rejected':'sync_interrupted']).run();
  }
 }
 return readFeedbackStatus(DB);
}
