import {decryptKey,modelProfiles,profileId,type ConfigStore} from './settings';

// Forward only known budget fields, never arbitrary provider metadata.
const amount=(v:unknown)=>v===null?null:typeof v==='number'&&Number.isFinite(v)?v:undefined;
const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():undefined;
function budget(v:any){return Object.fromEntries(['limit','used','remaining','available'].map(k=>[k,amount(v?.[k])]).filter(([,v])=>v!==undefined));}
export async function modelQuota(store:ConfigStore,secret:string,id:unknown){
  const profile=profileId(id),p=modelProfiles(await store.get())[profile];
  if(!p?.encryptedKey)throw new Error('请先保存该模型的 Key。');
  const url=new URL(p.baseUrl);
  if(url.origin!=='https://riffle-api.pages.dev'||!/^claude-opus-5-5$/i.test(p.model))throw new Error('余额查询目前仅支持 Riffle Opus 配置。');
  const key=await decryptKey(p.encryptedKey,secret);
  const response=await fetch('https://riffle-api.pages.dev/v1/quota',{headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)}).catch(()=>{throw new Error('余额接口连接失败或超时，请稍后刷新。');});
  if(!response.ok)throw new Error(`余额接口暂不可用（HTTP ${response.status}），请稍后刷新。`);
  let data:any;try{const text=await response.text();if(text.length>64000)throw new Error();data=JSON.parse(text);}catch{throw new Error('余额接口返回格式异常，请稍后刷新。');}
  if(data?.object!=='key_quota'||data.currency!=='CNY'||!data.daily||!data.total||amount(data.available)===undefined)throw new Error('余额接口缺少预算信息，请稍后刷新。');
  return {profile,currency:'CNY',daily:{...budget(data.daily),resetAt:date(data.daily.reset_at),unknownRequests:amount(data.daily.unknown_requests)},total:budget(data.total),
    available:amount(data.available),reservations:{amount:amount(data.reservations?.amount),requests:amount(data.reservations?.requests)},pendingReviewRequests:amount(data.pending_review_requests),
    requestsPerMinute:amount(data.requests_per_minute),updatedAt:date(data.updated_at),queriedAt:new Date().toISOString()};
}
