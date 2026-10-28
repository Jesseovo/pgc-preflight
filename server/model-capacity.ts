import {activeModelProfile,decryptKey,modelProfiles,type ModelConfig,type ModelRuntime} from './settings';
import type {ModelThrottleDatabase} from './model-throttle';
export const RIFFLE_CONCURRENCY=2;
export const isRiffle=(config:Pick<ModelRuntime,'baseUrl'>)=>new URL(config.baseUrl).origin==='https://riffle-api.pages.dev';
export async function modelKeyId(config:ModelRuntime){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${new URL(config.baseUrl).origin}|${config.apiKey}`))),v=>v.toString(16).padStart(2,'0')).join('');}
export async function tryModelSlot(DB:ModelThrottleDatabase|undefined,config:ModelRuntime,id:string,expiresAt:number){
  if(!DB||!isRiffle(config))return {release:async()=>{}};
  const key=await modelKeyId(config),at=Date.now();
  const row=await DB.prepare(`INSERT INTO model_slots(request_id,key_id,expires_at)
    SELECT ?,?,? WHERE (SELECT COUNT(*) FROM model_slots WHERE key_id=? AND expires_at>?)<?
    ON CONFLICT(request_id) DO NOTHING RETURNING request_id`).bind(id,key,expiresAt,key,at,RIFFLE_CONCURRENCY).first();
  if(!row)return null;
  return {release:async()=>{await DB.prepare('DELETE FROM model_slots WHERE request_id=? AND key_id=?').bind(id,key).run();}};
}
// All enabled Riffle Opus keys participate. Duplicate profiles with the same Key
// have one shared limit. Other providers retain their explicitly selected model.
export async function claimCreationModel(DB:ModelThrottleDatabase,config:ModelConfig|null,secret:string,purpose:any,id:string){
  const preferred=activeModelProfile(config,purpose);
  if(!preferred)return {config,reserved:false,lease:{release:async()=>{}}};
  const p=preferred.profile;
  if(!p.enabled||!p.encryptedKey||p.protocol!=='anthropic'||!/^claude-opus-5-5$/i.test(p.model)||!isRiffle(p))return {config,reserved:false,lease:{release:async()=>{}}};
  const profiles=modelProfiles(config),ids=[preferred.id,...Object.keys(profiles).filter(v=>v!==preferred.id)],seen=new Set<string>();
  const candidates=[];
  for(const profileId of ids){
    const profile=profiles[profileId]!;
    if(!profile.enabled||!profile.encryptedKey||profile.protocol!=='anthropic'||!/^claude-opus-5-5$/i.test(profile.model)||!isRiffle(profile))continue;
    const runtime={...profile,apiKey:await decryptKey(profile.encryptedKey,secret)},key=await modelKeyId(runtime);if(seen.has(key))continue;seen.add(key);
    candidates.push({profileId,runtime,key});
  }
  if(!candidates.length)return null;
  // Selection and reservation must share one SQL statement. Separate load reads
  // let simultaneous idle tasks all choose the preferred Key before any lease
  // is visible, leaving other Keys unused until that Key reaches its cap.
  const now=Date.now();
  const slot=await DB.prepare(`WITH candidates(key_id,position) AS (VALUES ${candidates.map((_,i)=>`(?,${i})`).join(',')}),
    loads AS (SELECT key_id,position,
      (SELECT count(*) FROM model_slots WHERE key_id=candidates.key_id AND expires_at>?) AS inflight,
      COALESCE((SELECT max(next_at,cooldown_until) FROM model_throttle WHERE id=candidates.key_id),0) AS ready
      FROM candidates),
    winner AS (SELECT key_id FROM loads WHERE inflight<? ORDER BY (ready>?),inflight,position LIMIT 1)
    INSERT INTO model_slots(request_id,key_id,expires_at)
    SELECT ?,key_id,? FROM winner WHERE 1 ON CONFLICT(request_id) DO NOTHING RETURNING key_id`)
    .bind(...candidates.map(c=>c.key),now,RIFFLE_CONCURRENCY,now,id,now+14*60000).first();
  if(!slot)return null;
  const c=candidates.find(c=>c.key===slot.key_id)!;
  const lease={release:async()=>{await DB.prepare('DELETE FROM model_slots WHERE request_id=? AND key_id=?').bind(id,c.key).run();}};
  return {config:{...config!,activeProfile:c.profileId,routes:{...config?.routes,create:c.profileId}},reserved:true,lease};
}
