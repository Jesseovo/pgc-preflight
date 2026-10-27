import type {ConfigStore,ModelConfig} from './settings';
import type {Member,MemberStore} from './members';
interface Statement {bind(...values:unknown[]):Statement;first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>;run():Promise<unknown>}
export interface Database {prepare(query:string):Statement}
type MemberRow={id:string;username:string;display_name:string;password_hash:string;password_salt:string;enabled:number;can_review:number;daily_review_limit?:number;session_version:number;created_at:string;updated_at:string};
const convert=(r:MemberRow):Member=>({id:r.id,username:r.username,displayName:r.display_name,passwordHash:r.password_hash,passwordSalt:r.password_salt,enabled:!!r.enabled,canReview:!!r.can_review,dailyReviewLimit:r.daily_review_limit??50,sessionVersion:r.session_version,createdAt:r.created_at,updatedAt:r.updated_at});
export function configStore(db:Database):ConfigStore{return{get:async()=>{const row=await db.prepare('SELECT value FROM settings WHERE id = ?').bind('model').first<{value:string}>();return row?JSON.parse(row.value)as ModelConfig:null;},set:async config=>{await db.prepare('INSERT INTO settings (id,value,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind('model',JSON.stringify(config),config.updatedAt).run();}};}
export function memberStore(db:Database):MemberStore{return{
  list:async()=>(await db.prepare('SELECT * FROM members ORDER BY created_at DESC').all<MemberRow>()).results.map(convert),
  byUsername:async username=>{const r=await db.prepare('SELECT * FROM members WHERE username = ?').bind(username).first<MemberRow>();return r?convert(r):null;},
  byId:async id=>{const r=await db.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<MemberRow>();return r?convert(r):null;},
  save:async m=>{await db.prepare('INSERT INTO members (id,username,display_name,password_hash,password_salt,enabled,can_review,daily_review_limit,session_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,password_hash=excluded.password_hash,password_salt=excluded.password_salt,enabled=excluded.enabled,can_review=excluded.can_review,daily_review_limit=excluded.daily_review_limit,session_version=excluded.session_version,updated_at=excluded.updated_at').bind(m.id,m.username,m.displayName,m.passwordHash,m.passwordSalt,Number(m.enabled),Number(m.canReview),m.dailyReviewLimit??50,m.sessionVersion,m.createdAt,m.updatedAt).run();},
};}
