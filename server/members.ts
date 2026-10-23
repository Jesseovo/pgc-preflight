import {authorized} from './settings';
import type {AppSecrets} from './settings';

export interface Member {id:string;username:string;displayName:string;passwordHash:string;passwordSalt:string;enabled:boolean;canReview:boolean;sessionVersion:number;createdAt:string;updatedAt:string}
export interface MemberStore {list():Promise<Member[]>;byUsername(username:string):Promise<Member|null>;byId(id:string):Promise<Member|null>;save(member:Member):Promise<void>}
export interface Identity {id:string;username:string;displayName:string;role:'admin'|'member';canReview:boolean}
const encoder=new TextEncoder();
const hex=(value:ArrayBuffer|Uint8Array)=>[...new Uint8Array(value)].map(b=>b.toString(16).padStart(2,'0')).join('');
const unhex=(value:string)=>Uint8Array.from(value.match(/.{2}/g)||[],v=>parseInt(v,16));
export async function hashPassword(password:string,salt?:string):Promise<{hash:string;salt:string}>{
  salt ||= hex(crypto.getRandomValues(new Uint8Array(16)));
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:unhex(salt),iterations:100000,hash:'SHA-256'},material,256);
  return{hash:hex(bits),salt};
}
const same=(a:string,b:string)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
async function sign(text:string,secret:string):Promise<string>{const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(text)));}
export function publicMember(member:Member){const{passwordHash:_,passwordSalt:__,sessionVersion:___,...rest}=member;return rest;}
export function validateAccount(value:unknown){
  const body=value as Record<string,unknown>;
  if(!body||typeof body.username!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(body.username))throw new Error('账号需要 3–32 位英文字母、数字、点、下划线或短横线。');
  if(body.username.toLowerCase()==='admin')throw new Error('admin 为管理员保留账号。');
  const password=validatePassword(body.password);
  const displayName=typeof body.displayName==='string'?body.displayName.trim():body.username;
  if(!displayName||displayName.length>50)throw new Error('成员姓名需要 1–50 个字。');
  return{username:body.username.toLowerCase(),displayName,password,canReview:body.canReview!==false};
}
export function validatePassword(password:unknown):string{if(typeof password!=='string'||password.length<6||password.length>128)throw new Error('密码需要 6–128 位字符。');return password;}
export async function createMember(value:unknown,store:MemberStore):Promise<Member>{
  const fields=validateAccount(value);
  if(await store.byUsername(fields.username))throw new Error('这个账号已经存在。');
  const credential=await hashPassword(fields.password);
  const now=new Date().toISOString();
  const member:Member={id:crypto.randomUUID(),username:fields.username,displayName:fields.displayName,passwordHash:credential.hash,passwordSalt:credential.salt,enabled:true,canReview:fields.canReview,sessionVersion:1,createdAt:now,updatedAt:now};
  await store.save(member);return member;
}
export async function updateMember(id:string,value:unknown,store:MemberStore):Promise<Member>{
  const member=await store.byId(id);if(!member)throw new Error('成员不存在。');
  const body=value as Record<string,unknown>;if(!body||typeof body!=='object')throw new Error('修改内容不正确。');
  if(body.enabled!==undefined){if(typeof body.enabled!=='boolean')throw new Error('账号状态格式不正确。');member.enabled=body.enabled;}
  if(body.canReview!==undefined){if(typeof body.canReview!=='boolean')throw new Error('检查权限格式不正确。');member.canReview=body.canReview;}
  if(body.password!==undefined){const next=await hashPassword(validatePassword(body.password));member.passwordHash=next.hash;member.passwordSalt=next.salt;}
  member.sessionVersion++;member.updatedAt=new Date().toISOString();await store.save(member);return member;
}
export async function memberLogin(username:string,password:string,store:MemberStore,secret:string):Promise<string|null>{
  const member=await store.byUsername(username.toLowerCase());
  // Use the same hash work for unknown users to avoid an account-existence timing signal.
  const candidate=await hashPassword(password,member?.passwordSalt||'00000000000000000000000000000000');
  if(!member?.enabled||!same(candidate.hash,member.passwordHash))return null;
  const payload=`${member.id}.${member.sessionVersion}.${Date.now()+8*60*60*1000}`;
  return`${payload}.${await sign(payload,secret)}`;
}
export async function identity(cookie:string|null,store:MemberStore,secrets:AppSecrets):Promise<Identity|null>{
  if(await authorized(cookie,secrets))return{id:'admin',username:'admin',displayName:'管理员',role:'admin',canReview:true};
  const token=cookie?.match(/(?:^|;\s*)pgc_member=([^;]+)/)?.[1];if(!token||!secrets.SETTINGS_KEY)return null;
  const[id,version,expires,signature]=token.split('.');
  if(!id||!signature||!Number.isFinite(Number(expires))||Number(expires)<=Date.now()||Number(expires)>Date.now()+8*60*60*1000)return null;
  if(!same(signature,await sign(`${id}.${version}.${expires}`,secrets.SETTINGS_KEY)))return null;
  const member=await store.byId(id);if(!member?.enabled||member.sessionVersion!==Number(version))return null;
  return{id:member.id,username:member.username,displayName:member.displayName,role:'member',canReview:member.canReview};
}
