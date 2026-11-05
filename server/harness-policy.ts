import {activeModelProfile,MODEL_PURPOSES, type ModelPurpose} from './settings';
import {inferenceOptions} from '../src/model-options';
import {HARNESS_CCB_COMMIT,isHarnessImage} from './harness-protocol';

export const CCB_ENGINE_COMMIT=HARNESS_CCB_COMMIT;
export const HARNESS_GAME_LIMITS=Object.freeze({maxOutputTokens:64_000,maxTotalOutputTokens:256_000,maxModelTurns:24,maxDurationMs:40*60_000,maxRepairs:2});
export type HarnessFamily='forge'|'review';
export type HarnessLimits={maxOutputTokens:number;maxTotalOutputTokens:number;maxModelTurns:number;maxDurationMs:number;maxRepairs:number};
export type HarnessPolicy={version:1;engine:'ccb';engineCommit:string;image:string;releaseHash:string;family:HarnessFamily;purpose:ModelPurpose;modelContractHash:string;limits:HarnessLimits};
export type HarnessBinding={idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
export type HarnessEnvironment={DB:any;HARNESS_ROLLOUT?:string;HARNESS_RELEASE?:string;HARNESS_RUNNER?:HarnessBinding;modelStore:{get():Promise<any>}};

export function canonicalHarness(value:any):string{
  if(value===undefined)throw new Error('Harness material contains an undefined value.');
  return JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonicalHarness(v))):Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,JSON.parse(canonicalHarness(value[k]))])):value);
}
export async function harnessHash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
export async function modelContractHash(config:any,purpose:ModelPurpose){
  const active=activeModelProfile(config,purpose);if(!active)throw new Error('Harness model is not configured.');
  const p=active.profile;
  return harnessHash(canonicalHarness({model:p.model,protocol:p.protocol,baseUrl:p.baseUrl,vision:p.vision!==false,effort:purpose==='game'?'high':p.effort||'auto',maxOutputTokens:p.maxOutputTokens||0}));
}
export function parseHarnessPolicy(raw:unknown):HarnessPolicy|null{
  if(raw==null)return null;
  const p=typeof raw==='string'?JSON.parse(raw):raw as any;
  if(p?.version!==1||p.engine!=='ccb'||p.engineCommit!==CCB_ENGINE_COMMIT||!isHarnessImage(p.image)||!['forge','review'].includes(p.family)||!/^[a-f0-9]{64}$/.test(p.releaseHash)||!/^[a-f0-9]{64}$/.test(p.modelContractHash)||!p.limits)throw new Error('任务的 Harness 版本或预算记录无效。');
  for(const [key,cap] of Object.entries(HARNESS_GAME_LIMITS))if(!Number.isSafeInteger(p.limits[key])||p.limits[key]<0||p.limits[key]>cap)throw new Error('任务的 Harness 预算超出已批准范围。');
  if(!p.limits.maxOutputTokens||!p.limits.maxTotalOutputTokens||!p.limits.maxModelTurns||!p.limits.maxDurationMs)throw new Error('Harness 预算不能为空。');
  if(!MODEL_PURPOSES.includes(p.purpose)||p.family==='review'&&p.purpose!=='review'||p.family==='forge'&&['review','review_verify'].includes(p.purpose))throw new Error('Harness 模型分组无效。');
  return p;
}

// No permissive local default. An engine switch without the release evidence
// cannot silently enrol existing members or old tasks.
export async function newHarnessPolicy(env:HarnessEnvironment,ownerId:string,family:HarnessFamily,purpose:ModelPurpose):Promise<HarnessPolicy|null>{
  if(env.HARNESS_ROLLOUT!=='pilot')return null;
  if(ownerId!=='admin'&&!await env.DB.prepare('SELECT 1 FROM review_pilot_members WHERE member_id=? AND pilot_enabled=1').bind(ownerId).first())return null;
  let release:any;
  try{release=JSON.parse(env.HARNESS_RELEASE||'null');}catch{throw new Error('Harness 发布验收记录无效，未改变执行来源。');}
  if(!env.HARNESS_RUNNER||release?.engineCommit!==CCB_ENGINE_COMMIT||!isHarnessImage(release?.image)||release?.rightsConfirmed!==true||release?.providerCompatibilityVerified!==true||release?.comparisonAccepted!==true||release?.isolationVerified!==true||!/^[a-f0-9]{64}$/.test(release?.evidenceHash||''))throw new Error('Harness 尚未满足授权、隔离和对照验收条件。');
  const config=await env.modelStore.get(),active=activeModelProfile(config,purpose),contract=await modelContractHash(config,purpose);
  if(!active?.profile.enabled||!active.profile.encryptedKey||!Array.isArray(release.compatibleModelContracts)||!release.compatibleModelContracts.includes(contract))throw new Error('当前模型配置尚未完成 Harness 兼容验证，未自动切换模型。');
  const max=inferenceOptions(active.profile,purpose,purpose==='game'?64_000:undefined).maxTokens;
  const limits=purpose==='game'?{...HARNESS_GAME_LIMITS,maxOutputTokens:Math.min(64_000,max)}:{maxOutputTokens:max,maxTotalOutputTokens:family==='review'?max*2:max,maxModelTurns:family==='review'?8:6,maxDurationMs:12*60_000,maxRepairs:0};
  return {version:1,engine:'ccb',engineCommit:CCB_ENGINE_COMMIT,image:release.image,releaseHash:release.evidenceHash,family,purpose,modelContractHash:contract,limits};
}

export function harnessPurpose(kind:string):ModelPurpose{return ({tag:'tags',suggest:'vocab','mechanism-check':'expand'} as Record<string,ModelPurpose>)[kind]||kind as ModelPurpose;}

export function publicHarnessPolicy(raw:unknown){
  const p=parseHarnessPolicy(raw);return p?{version:p.version,engine:p.engine,limits:p.limits}:null;
}
