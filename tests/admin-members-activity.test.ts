import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {adminApi} from '../server/admin-api';
import {login,type ConfigStore} from '../server/settings';
import type {Member,MemberStore} from '../server/members';

const databases:DatabaseSync[]=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
const secrets={ADMIN_PASSWORD:'synthetic-admin',SETTINGS_KEY:'synthetic-settings-key'};
const store:ConfigStore={get:async()=>null,set:async()=>{}};
const person=(id:string):Member=>({id,username:id,displayName:`Member ${id}`,enabled:true,canReview:true,star:false,dailyReviewLimit:50,createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2035-12-31T00:00:00.000Z',passwordHash:'PRIVATE_HASH',passwordSalt:'PRIVATE_SALT',sessionVersion:1});
function members(people:Member[]):MemberStore{return{list:async()=>people,byId:async id=>people.find(m=>m.id===id)||null,byUsername:async username=>people.find(m=>m.username===username)||null,save:async()=>{}};}
async function request(){return new Request('https://fixture.test/api/admin/members',{headers:{Cookie:`pgc_admin=${await login(secrets.ADMIN_PASSWORD,secrets)}`}});}
function database(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const table of ['topics','games','forge_tasks','review_jobs'])sqlite.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,owner_id TEXT NOT NULL,updated_at TEXT);`);
  const DB:any={prepare(sql:string){const statement=sqlite.prepare(sql);return{bind(...params:any[]){return{first:async()=>statement.get(...params)||null,all:async()=>({results:statement.all(...params)}),run:async()=>statement.run(...params)};}};}};
  const activity=(table:string,id:number,owner:string,time:string|null)=>sqlite.prepare(`INSERT INTO ${table}(id,owner_id,updated_at) VALUES(?,?,?)`).run(id,owner,time);
  return{DB,activity};
}

describe('成员管理最近内容活动',()=>{
  it('跨完整作品与任务记录取每个成员最新更新时间，不使用账号编辑时间',async()=>{
    const {DB,activity}=database();
    activity('topics',1,'topic-owner','2026-10-27T18:20:00.000Z');
    activity('games',1,'game-owner','2026-10-27T19:00:00.000Z');
    activity('forge_tasks',1,'task-owner','2026-10-27T20:00:00.000Z');
    activity('review_jobs',1,'review-owner','2026-10-27T21:00:00.000Z');
    activity('topics',2,'review-owner','2026-10-20T00:00:00.000Z');
    activity('games',2,'review-owner','2026-10-21T00:00:00.000Z');
    activity('forge_tasks',2,'review-owner','2026-10-22T00:00:00.000Z');
    // More than the former 300-row workspace window must not hide an owner's history.
    for(let id=3;id<=343;id++)activity('topics',id,'busy-owner','2026-10-28T00:00:00.000Z');
    activity('topics',344,'empty-owner',null);
    const people=['topic-owner','game-owner','task-owner','review-owner','busy-owner','empty-owner','new-owner'].map(person);
    const response=await adminApi(await request(),store,secrets,members(people),DB);expect(response?.status).toBe(200);
    const output:any=await response!.json(),times=Object.fromEntries(output.members.map((m:any)=>[m.id,m.lastActivity]));
    expect(times).toEqual({'topic-owner':'2026-10-27T18:20:00.000Z','game-owner':'2026-10-27T19:00:00.000Z','task-owner':'2026-10-27T20:00:00.000Z','review-owner':'2026-10-27T21:00:00.000Z','busy-owner':'2026-10-28T00:00:00.000Z','empty-owner':null,'new-owner':null});
    expect(output.members.every((m:any)=>m.updatedAt==='2035-12-31T00:00:00.000Z')).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE_HASH|PRIVATE_SALT|sessionVersion/);
  });

  it('没有数据库的本地账号接口仍可读取，活动为空且保留原成员字段',async()=>{
    const response=await adminApi(await request(),store,secrets,members([person('local')]));expect(response?.status).toBe(200);
    const output:any=await response!.json();expect(output.members).toHaveLength(1);expect(output.members[0]).toMatchObject({id:'local',displayName:'Member local',dailyReviewLimit:50,canReview:true,lastActivity:null});
  });
});
