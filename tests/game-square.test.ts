import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {galleryApi} from '../server/gallery';
import {reviewDeviceApi} from '../server/review-device-api';
import {digest} from '../server/review-device-state';
import {hashPassword,memberLogin} from '../server/members';
import {memberStore} from '../server/storage';
import {login} from '../server/settings';

const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.restoreAllMocks();});
const original='<html><title>原版游戏</title><canvas></canvas><script>window.fixture="😀"</script></html>\r\n';
const human=(job:any,overrides:any={})=>({id:job.id,...(job.lease?{lease:job.lease}:{}),requestId:crypto.randomUUID(),workId:`work-${job.id}`,versionId:'version:1',score:0,feedback:'PRIVATE_HUMAN_FEEDBACK',updatedAt:'2026-10-27T10:00:00.000Z',source:'https://creator-hub-7mi.pages.dev',status:'reviewed',phase:'final',matchedBy:'user-confirmed',decision:'approved',...overrides});

async function setup(){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const password=await hashPassword('test-only-password');
  for(const id of ['a','b','reader','star'])sqlite.prepare('INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,daily_review_limit,can_review,star) VALUES(?,?,?,?,?,?,?,0,?,?)').run(id,id,id==='a'?'作者 100%_A':id,password.hash,password.salt,'now','now',Number(id!=='reader'),Number(id==='star'));
  const statements:Array<{sql:string;params:any[]}>=[],batchSizes:number[]=[];
  const DB:any={prepare(sql:string){let params:any[]=[];const s:any={bind(...values:any[]){params=values;return s;},first:async()=>{statements.push({sql,params});return sqlite.prepare(sql).get(...params)||null;},all:async()=>{statements.push({sql,params});return {results:sqlite.prepare(sql).all(...params)};},run:async()=>{statements.push({sql,params});const r=sqlite.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>{statements.push({sql,params});return sqlite.prepare(sql).run(...params);}};return s;},batch:async(items:any[])=>{batchSizes.push(items.length);sqlite.exec('BEGIN');try{const values=items.map(s=>s.execute());sqlite.exec('COMMIT');return values;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const modelGet=vi.fn(async()=>{throw new Error('Square must never call a platform model');}),schedule=vi.fn(),send=vi.fn();
  const env={DB,SETTINGS_KEY:'fixture-secret',ADMIN_PASSWORD:'fixture-admin',modelStore:{get:modelGet},REVIEW_QUEUE:{send},REVIEW_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:schedule})}};
  const tokens={a:'a'.repeat(64),a2:'c'.repeat(64),b:'b'.repeat(64)},devices:Record<string,string>={};
  for(const [name,token] of Object.entries(tokens)){
    devices[name]=crypto.randomUUID();sqlite.prepare('INSERT INTO review_devices(id,owner_id,session_version,token_hash,pairing_hash,name,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(devices[name],name==='a2'?'a':name,'1',await digest(token),name,name,new Date(Date.now()+86400000).toISOString(),new Date().toISOString());
  }
  const cookies:Record<string,string>={admin:`pgc_admin=${await login(env.ADMIN_PASSWORD,env)}`};
  await Promise.all(['a','reader','star'].map(async id=>cookies[id]=`pgc_member=${await memberLogin(id,'test-only-password',memberStore(DB),env.SETTINGS_KEY)}`));
  const call=(action:string,body:any={},name:keyof typeof tokens='a')=>reviewDeviceApi(new Request(`https://fixture.test/api/review-device/${action}`,{method:'POST',headers:{Authorization:`Bearer ${tokens[name]}`,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
  async function ok(action:string,body:any={},name:keyof typeof tokens='a'){const response=await call(action,body,name),value=await response.json() as any;expect(response.status,JSON.stringify(value)).toBe(200);return value;}
  const submit=(html=original,title='原版游戏',name:keyof typeof tokens='a')=>ok('submit',{request_id:crypto.randomUUID(),title,filename:'original.html',html},name);
  const get=(path='',user='a',headers:Record<string,string>={})=>galleryApi(new Request(`https://fixture.test/api/square/games${path}`,{headers:{...(cookies[user]?{Cookie:cookies[user]}:{}),...headers}}),env) as Promise<Response>;
  const head=(id:string,user='a')=>galleryApi(new Request(`https://fixture.test/api/square/games/${id}/preview`,{method:'HEAD',headers:cookies[user]?{Cookie:cookies[user]}:{}}),env) as Promise<Response>;
  const list=async(path='',user='a')=>{const response=await get(path,user),body=await response.json() as any;expect(response.status,JSON.stringify(body)).toBe(200);return body;};
  const visibility=(id:string,hidden:boolean,user='admin',origin='https://fixture.test')=>galleryApi(new Request(`https://fixture.test/api/square/games/${id}/visibility`,{method:'POST',headers:{Cookie:cookies[user],Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({hidden})}),env) as Promise<Response>;
  return {sqlite,DB,env,devices,tokens,cookies,call,ok,submit,get,head,list,visibility,statements,batchSizes,modelGet,schedule,send};
}

describe('仅登录成员可浏览试玩的游戏广场',()=>{
  it('普通成员、无审核权限成员、Star 和管理员可浏览，匿名与设备凭据拒绝，停用旧会话立即失效',async()=>{
    const s=await setup(),job=await s.submit(),saved=await s.ok('human-review',human(job)),id=saved.gallery.id;
    for(const user of ['a','reader','star','admin']){
      expect((await s.list('',user)).items).toHaveLength(1);
      expect((await s.get(`/${id}`,user)).status).toBe(200);expect((await s.get(`/${id}/preview`,user)).status).toBe(200);
    }
    for(const path of ['',`/${id}`,`/${id}/preview`]){
      expect((await s.get(path,'anonymous')).status).toBe(401);
      expect((await s.get(path,'admin',{Authorization:`Bearer ${s.tokens.a}`})).status).toBe(403);
    }
    s.sqlite.exec("UPDATE members SET enabled=0 WHERE id='reader'");expect((await s.get('','reader')).status).toBe(401);
    s.sqlite.exec("UPDATE members SET session_version=2 WHERE id='star'");expect((await s.get('','star')).status).toBe(401);
  });

  it('只有明确通过真人终审才保存共享文件，0 分通过有效，高分、拒绝、预审和缺结论均不发布',async()=>{
    const s=await setup();
    for(const change of [{decision:undefined,score:9},{decision:null,score:9},{decision:'rejected',score:9},{decision:undefined,phase:'preliminary',score:9},{decision:undefined,status:'pending',phase:null,score:null,feedback:null}]){
      const job=await s.submit(),saved=await s.ok('human-review',human(job,change));expect(saved).not.toHaveProperty('gallery');expect(saved).not.toHaveProperty('gallery_pending');
      expect((await s.call('gallery',{id:job.id,requestId:crypto.randomUUID(),html:original})).status).toBe(409);
    }
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM gallery_games').get()).toMatchObject({n:0});expect(s.sqlite.prepare('SELECT COUNT(*) n FROM gallery_game_html').get()).toMatchObject({n:0});
    const job=await s.submit(),saved=await s.ok('human-review',human(job));expect(saved.gallery).toMatchObject({score:0,visible:true,versionId:'version:1'});
    expect((await s.list()).total).toBe(1);expect(s.sqlite.prepare('SELECT SUM(quota_charged) n FROM review_jobs').get()).toMatchObject({n:0});
    expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();expect(s.send).not.toHaveBeenCalled();
  });

  it('通过回填自动复制原版，临时输入清理后才提示补传，并严格校验原 HTML 哈希',async()=>{
    const s=await setup(),job=await s.submit();s.sqlite.prepare('DELETE FROM review_inputs WHERE job_id=?').run(job.id);
    const body=human(job),saved=await s.ok('human-review',body);expect(saved).toMatchObject({gallery_pending:true,human_review:{decision:'approved'}});expect(saved).not.toHaveProperty('gallery');
    for(const html of [original.trim(),original.replace('😀','x'),original.replace(/\r\n/g,'\n')])expect((await s.call('gallery',{id:job.id,requestId:crypto.randomUUID(),html})).status).toBe(409);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM gallery_game_html').get()).toMatchObject({n:0});
    const published=await s.ok('gallery',{id:job.id,requestId:crypto.randomUUID(),html:original});expect(await (await s.get(`/${published.gallery.id}/preview`)).text()).toBe(original);
    expect((await s.ok('human-review',body)).gallery.id).toBe(published.gallery.id);
    const denied=await s.submit();s.sqlite.prepare('DELETE FROM review_inputs WHERE job_id=?').run(denied.id);
    expect(await s.ok('human-review',human(denied,{decision:'rejected'}))).not.toHaveProperty('gallery_pending');
  });

  it('同版本文件和请求不可替换，重复、并发和 JSON 字段重排幂等；同版本其他任务复用条目',async()=>{
    const s=await setup(),job=await s.submit(),association={workId:'fixed-work',versionId:'fixed-version'},approved=await s.ok('human-review',human(job,association));
    const body={id:job.id,requestId:crypto.randomUUID(),html:original},repeated=await Promise.all(Array.from({length:5},()=>s.ok('gallery',body)));
    expect(new Set(repeated.map(r=>r.gallery.id))).toEqual(new Set([approved.gallery.id]));expect(await s.ok('gallery',Object.fromEntries(Object.entries(body).reverse()))).toEqual(repeated[0]);
    const same=await s.submit(),sameSaved=await s.ok('human-review',human(same,{...association,updatedAt:'2026-10-27T11:00:00.000Z'}));expect(sameSaved.gallery.id).toBe(approved.gallery.id);
    expect((await s.call('gallery',{...body,id:same.id})).status).toBe(409);
    expect((await s.ok('gallery',{...body,id:same.id,requestId:crypto.randomUUID()})).gallery.id).toBe(approved.gallery.id);
    const changed=await s.submit('<html>replacement source</html>'),changedSaved=await s.ok('human-review',human(changed,{...association,updatedAt:'2026-10-27T12:00:00.000Z'}));
    expect(changedSaved.human_review.decision).toBe('approved');expect(changedSaved).not.toHaveProperty('gallery_pending');expect((await s.call('gallery',{id:changed.id,requestId:crypto.randomUUID(),html:'<html>replacement source</html>'})).status).toBe(409);
    expect(s.sqlite.prepare('SELECT COUNT(*) n FROM gallery_games').get()).toMatchObject({n:1});expect(await (await s.get(`/${approved.gallery.id}/preview`)).text()).toBe(original);
  });

  it('未领取任务允许本人设备，领取后必须原设备与原租约；跨成员、失效设备和注入字段拒绝',async()=>{
    const s=await setup(),job=await s.submit();await s.ok('human-review',human(job),'a2');
    const body={id:job.id,requestId:crypto.randomUUID(),html:original};expect((await s.call('gallery',body,'b')).status).toBe(404);expect((await s.call('gallery',{...body,owner_id:'b'})).status).toBe(400);
    const claimed=await s.ok('claim',{id:job.id,claimId:crypto.randomUUID()}),leased={...body,lease:claimed.lease};
    expect((await s.call('gallery',leased,'a2')).status).toBe(409);expect((await s.call('gallery',body)).status).toBe(409);expect((await s.call('gallery',{...leased,lease:crypto.randomUUID()})).status).toBe(409);
    expect((await s.ok('gallery',leased)).gallery.visible).toBe(true);s.sqlite.prepare('UPDATE review_devices SET revoked=1 WHERE id=?').run(s.devices.a);expect((await s.call('gallery',leased)).status).toBe(401);
  });

  it('跨任务最新终审拒绝立即下架，迟到批准与预审不能恢复；新终审通过恢复同一版本',async()=>{
    const s=await setup(),job=await s.submit(),association={workId:'same-work',versionId:'same-version'},first=await s.ok('human-review',human(job,association)),id=first.gallery.id;
    const newer=await s.submit();await s.ok('human-review',human(newer,{...association,decision:'rejected',updatedAt:'2026-10-27T12:00:00.000Z'}));
    expect((await s.list()).total).toBe(0);expect((await s.get(`/${id}/preview`,'admin')).status).toBe(404);
    for(const change of [{updatedAt:'2026-10-27T11:00:00.000Z'},{updatedAt:'2026-10-27T13:00:00.000Z',phase:'preliminary',decision:undefined}]){
      const old=await s.submit(),response=await s.ok('human-review',human(old,{...association,...change}));expect(response).not.toHaveProperty('gallery_pending');expect((await s.list()).total).toBe(0);
    }
    const restored=await s.ok('human-review',human(newer,{...association,decision:'approved',score:0,updatedAt:'2026-10-27T14:00:00.000Z'}));expect(restored.gallery.id).toBe(id);expect((await s.list()).items[0]).toMatchObject({id,score:0,approvedAt:'2026-10-27T14:00:00.000Z'});
    // A new final record without an explicit decision cannot imply approval.
    await s.ok('human-review',human(newer,{...association,decision:null,score:9,updatedAt:'2026-10-27T15:00:00.000Z'}));expect((await s.list()).total).toBe(0);
  });

  it('管理员同源请求可下架与恢复，回填不解除手动下架，普通成员和跨站操作拒绝',async()=>{
    const s=await setup(),job=await s.submit(),first=await s.ok('human-review',human(job)),id=first.gallery.id;
    expect((await s.visibility(id,true,'a')).status).toBe(403);expect((await s.visibility(id,true,'admin','https://attacker.test')).status).toBe(403);
    expect(await (await s.visibility(id,true)).json()).toMatchObject({hidden:true,visible:false});expect((await s.list()).total).toBe(0);
    expect((await s.get(`/${id}`,'admin')).status).toBe(404);expect((await s.get(`/${id}/preview`,'admin')).status).toBe(404);expect((await s.get('?scope=manage','a')).status).toBe(403);
    expect((await s.list('?scope=manage','admin')).items[0]).toMatchObject({id,hidden:true,visible:false});
    await s.ok('human-review',human(job,{updatedAt:'2026-10-27T11:00:00.000Z'}));expect((await s.list()).total).toBe(0);
    expect(await (await s.visibility(id,false)).json()).toMatchObject({hidden:false,visible:true});
    await s.ok('human-review',human(job,{decision:'rejected',updatedAt:'2026-10-27T12:00:00.000Z'}));expect(await (await s.visibility(id,false)).json()).toMatchObject({hidden:false,visible:false});expect((await s.list()).total).toBe(0);
  });

  it('列表详情仅公开作品白名单，预览保留原 HTML 并使用无同源权限、无网络的脚本沙箱',async()=>{
    const s=await setup(),job=await s.submit(),saved=await s.ok('human-review',human(job)),id=saved.gallery.id,detail=await (await s.get(`/${id}`)).json();
    expect(Object.keys(detail as any).sort()).toEqual(['id','title','author','score','approvedAt','workId','versionId','hidden','visible'].sort());expect((await s.list()).items[0]).toEqual(detail);
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE_HUMAN_FEEDBACK|owner_id|job_id|token|html|content_hash|lease/);
    const preview=await s.get(`/${id}/preview`),csp=preview.headers.get('Content-Security-Policy')!;
    expect(await preview.text()).toBe(original);expect(csp).toContain('sandbox allow-scripts;');expect(csp).not.toContain('allow-same-origin');
    for(const policy of ["default-src 'none'","connect-src 'none'","frame-src 'none'","worker-src 'none'","object-src 'none'","form-action 'none'","frame-ancestors 'self'"])expect(csp).toContain(policy);
    expect(preview.headers.get('Cache-Control')).toBe('private, no-store');expect(preview.headers.get('Vary')).toBe('Cookie');expect(preview.headers.get('Referrer-Policy')).toBe('no-referrer');expect(preview.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(preview.headers.get('Content-Type')).toContain('text/html');
    const start=s.statements.length,head=await s.head(id);expect(head.status).toBe(200);expect(await head.text()).toBe('');expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(preview.headers));expect(s.statements.slice(start).some(r=>/SELECT (?:part,)?data/.test(r.sql))).toBe(false);expect((await s.head(id,'anonymous')).status).toBe(401);
    await s.visibility(id,true);expect((await s.head(id)).status).toBe(404);
  });

  it('分页每页 12 项，搜索标题和作者并转义 LIKE 通配符；列表不扫描 HTML 内容',async()=>{
    const s=await setup();
    for(let i=0;i<14;i++){const job=await s.submit(original,i===0?'Unique 50%_game':`Game ${i}`);await s.ok('human-review',human(job));}
    const one=await s.list(),two=await s.list('?page=2');expect(one).toMatchObject({page:1,pageSize:12,total:14,hasMore:true});expect(one.items).toHaveLength(12);expect(two).toMatchObject({page:2,pageSize:12,total:14,hasMore:false});expect(two.items).toHaveLength(2);expect(new Set([...one.items,...two.items].map(r=>r.id)).size).toBe(14);
    expect((await s.list('?q=Unique')).total).toBe(1);expect((await s.list('?q=100%25_A')).total).toBe(14);expect((await s.list('?q=100X_A')).total).toBe(0);expect((await s.list('?q=50%25_')).total).toBe(1);
    for(const page of ['0','-1','1.5','x'])expect((await s.get(`?page=${page}`)).status).toBe(400);
    const start=s.statements.length;await s.list('?q=Game');expect(s.statements.slice(start).some(r=>/CAST\(p\.data AS BLOB\)/.test(r.sql))).toBe(false);
  });

  it('分片缺失不能上市，内容损坏或分片序号改变不能返回预览',async()=>{
    const s=await setup(),job=await s.submit(),saved=await s.ok('human-review',human(job)),id=saved.gallery.id;
    s.sqlite.prepare("UPDATE gallery_game_html SET data=replace(data,'原版','替换') WHERE game_id=?").run(id);expect((await s.get(`/${id}/preview`)).status).toBe(404);
    s.sqlite.prepare('UPDATE gallery_game_html SET data=?,part=3 WHERE game_id=?').run(original,id);expect((await s.get(`/${id}/preview`)).status).toBe(404);
    s.sqlite.prepare('DELETE FROM gallery_game_html WHERE game_id=?').run(id);expect((await s.list()).total).toBe(0);expect((await s.get(`/${id}`)).status).toBe(404);
  });

  it('事务写入前撤销权限或终审会拒绝发布，自动保存失败保留已提交的人审',async()=>{
    const s=await setup(),job=await s.submit();s.sqlite.prepare('DELETE FROM review_inputs WHERE job_id=?').run(job.id);const body=human(job),stored=await s.ok('human-review',body),batch=s.DB.batch;
    vi.spyOn(s.DB,'batch').mockImplementationOnce((async(items:any[])=>{s.sqlite.prepare('UPDATE review_devices SET revoked=1 WHERE id=?').run(s.devices.a);return batch(items);}) as any);
    expect((await s.call('gallery',{id:job.id,requestId:crypto.randomUUID(),html:original})).status).toBe(409);expect(s.sqlite.prepare('SELECT COUNT(*) n FROM gallery_game_html').get()).toMatchObject({n:0});
    s.sqlite.prepare('UPDATE review_devices SET revoked=0 WHERE id=?').run(s.devices.a);
    s.sqlite.prepare('INSERT INTO review_inputs(job_id,part,data,created_at) VALUES(?,0,?,?)').run(job.id,JSON.stringify({html:original}),new Date().toISOString());
    vi.spyOn(s.DB,'batch').mockRejectedValueOnce(new Error('synthetic storage unavailable'));
    expect(await s.ok('human-review',body)).toMatchObject({gallery_pending:true,human_review:stored.human_review});expect(s.sqlite.prepare('SELECT COUNT(*) n FROM review_human_reviews').get()).toMatchObject({n:1});
    await s.ok('gallery',{id:job.id,requestId:crypto.randomUUID(),html:original});const requestId=crypto.randomUUID();
    vi.spyOn(s.DB,'batch').mockImplementationOnce((async(items:any[])=>{s.sqlite.prepare("UPDATE review_human_reviews SET decision='rejected' WHERE job_id=? AND is_current=1").run(job.id);return batch(items);}) as any);
    expect((await s.call('gallery',{id:job.id,requestId,html:original})).status).toBe(409);expect(s.sqlite.prepare('SELECT request_id FROM gallery_publish_requests WHERE request_id=?').get(requestId)).toBeUndefined();expect((await s.list()).total).toBe(0);
  });

  it('最大 8 MB 文件在有界 SQL batch 内完整发布，Unicode 分片不拆代理对',async()=>{
    const s=await setup(),job=await s.submit();s.sqlite.prepare('DELETE FROM review_inputs WHERE job_id=?').run(job.id);await s.ok('human-review',human(job));
    const html='<html>'+('x'.repeat(119993)+'😀').repeat(69)+'z'.repeat(108802)+'</html>';
    expect(new TextEncoder().encode(html).length).toBe(8*1024*1024);
    s.sqlite.prepare('UPDATE review_jobs SET input_hash=? WHERE id=?').run(await digest(html),job.id);
    const start=s.statements.length,result=await s.ok('gallery',{id:job.id,requestId:crypto.randomUUID(),html});expect(s.batchSizes.at(-1)).toBeLessThanOrEqual(6);
    expect(s.statements.slice(start).every(r=>r.params.length<=100)).toBe(true);
    expect(await (await s.get(`/${result.gallery.id}/preview`)).text()).toBe(html);
    expect((await s.call('gallery',{id:job.id,requestId:crypto.randomUUID(),html:html+'x'})).status).toBe(413);
  });
});
