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
    const load=await DB.prepare('SELECT (SELECT count(*) FROM model_slots WHERE key_id=? AND expires_at>?) AS n,COALESCE((SELECT max(next_at,cooldown_until) FROM model_throttle WHERE id=?),0) AS ready').bind(key,Date.now(),key).first();
    candidates.push({profileId,runtime,load:Number(load?.n||0),ready:Number(load?.ready||0)});
  }
  const now=Date.now();candidates.sort((a,b)=>Number(a.ready>now)-Number(b.ready>now)||a.load-b.load);
  for(const c of candidates){const lease=await tryModelSlot(DB,c.runtime,id,Date.now()+14*60000);if(lease)return {config:{...config!,activeProfile:c.profileId,routes:{...config?.routes,create:c.profileId}},reserved:true,lease};}
  return null;
}
