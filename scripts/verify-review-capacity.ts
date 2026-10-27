import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {launchLocalBrowser} from '../server/local-browser';
import {adminApi} from '../server/admin-api';
import {authApi} from '../server/auth-api';
import {forgeApi} from '../server/forge-api';
import {configStore,memberStore} from '../server/storage';
import {createMember} from '../server/members';
import {saveConfig} from '../server/settings';
import {processReviewJob} from '../server/review-jobs';

// Actual migrated DB and authenticated APIs. Model and capture are fixtures;
// this verifies quota, permissions, ledger and UI, not model accuracy.
const sqlite=new DatabaseSync(':memory:');
for(const file of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(await readFile('migrations/'+file,'utf8'));
const DB:any={prepare:(sql:string)=>{let values:any[]=[];const stmt:any={bind:(...v:any[])=>{values=v;return stmt;},first:async()=>sqlite.prepare(sql).get(...values)||null,all:async()=>({results:sqlite.prepare(sql).all(...values)}),run:async()=>{const r=sqlite.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}},execute:()=>sqlite.prepare(sql).run(...values)};return stmt;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const out=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const secrets={ADMIN_PASSWORD:'fixture-only-admin',SETTINGS_KEY:'fixture-only-encryption'};
const store=configStore(DB),members=memberStore(DB);
await saveConfig({profile:'deepseek',baseUrl:'https://fixture.invalid/v1',model:'fixture-vision',apiKey:'fixture-only-key'},store,secrets.SETTINGS_KEY);
const member=await createMember({username:'quota-fixture',displayName:'测试成员',password:'fixture-only-password',dailyReviewLimit:2},members);
const queue:any[]=[];
const env={...secrets,DB,modelStore:store,captureReview:async()=>({shots:[],probe:{captureMethod:'fixture'}}),REVIEW_QUEUE:{send:async(message:any)=>{queue.push(message);}}};
const report={aes:2,ease:2,play:3,verdict:'通过',reviewer_comment:'合成报告，仅用于界面验证。',score_reasons:{aes:'测试依据',ease:'测试依据',play:'测试依据'},uncertainties:['人工确认'],strengths:['测试亮点'],issues:[],fix_prompt:'测试修改指令'};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost');
  try{
    if(url.pathname.startsWith('/api/')){
      let text='';for await(const chunk of req)text+=chunk;
      const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers as Record<string,string>,body:['GET','HEAD'].includes(req.method!)?undefined:text});
      const out=url.pathname.startsWith('/api/admin/')?await adminApi(request,store,secrets,members,DB):url.pathname.startsWith('/api/auth/')?await authApi(request,members,secrets):await forgeApi(request,env,url.pathname.slice('/api/forge/'.length).split('/'),members);
      res.writeHead(out!.status,Object.fromEntries(out!.headers));res.end(await out!.text());return;
    }
    if(url.pathname==='/forge/'){res.end('fixture');return;}
    const root=resolve(url.pathname.startsWith('/artwork/')||url.pathname.startsWith('/forge/')?'public':'dist');
    const file=resolve(root,'.'+(url.pathname==='/admin'?'/index.html':url.pathname));
    if(!file.startsWith(root+sep))throw Error('path');
    const data=await readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'image/png');res.end(data);
  }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error)}));}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await launchLocalBrowser();
await mkdir('artifacts',{recursive:true});
try{
  const user=await browser.newPage();await user.goto(origin);
  const logged=await user.evaluate(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'quota-fixture',password:'fixture-only-password'})});return r.status;});assert.equal(logged,200);
  const accepted:any=await user.evaluate(async()=>Promise.all(Array.from({length:3},(_,i)=>fetch('/api/forge/review/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:crypto.randomUUID(),title:'Fixture '+i,filename:'fixture-'+i+'.html',html:'<html><title>Fixture</title></html>'})}).then(async r=>({status:r.status,data:await r.json()})))));
  assert.equal(accepted.filter((r:any)=>r.status===202).length,2);assert.equal(accepted.filter((r:any)=>r.status===429).length,1);
  for(const task of queue)await processReviewJob(env,task.id,async(payload,owner,id)=>{sqlite.prepare('UPDATE review_jobs SET model_started_at=? WHERE id=?').run(new Date().toISOString(),id);const result=sqlite.prepare("INSERT INTO reviews(owner_id,title,score,result,probe,shots,created_at,job_id) VALUES (?,?,7,?,'{}','[]',?,?)").run(owner,payload.title,JSON.stringify(report),new Date().toISOString(),id);return{id:Number(result.lastInsertRowid)};});
  assert.equal(await user.evaluate(async()=>{const r=await fetch('/api/admin/review-activity');return r.status;}),401);
  const adminContext=await browser.createBrowserContext();const page=await adminContext.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.setViewport({width:1440,height:1050});await page.goto(origin+'/admin');await page.waitForSelector('#admin-password');
  await page.type('#admin-password',secrets.ADMIN_PASSWORD);await page.click('#login-form button');await page.waitForSelector('#tab-members');await page.click('#tab-members');
  await page.waitForSelector('[data-activity-report]');assert.equal(await page.$$eval('#activity-records tbody tr',r=>r.length),2);
  await page.$eval('[data-quota] input',el=>{(el as HTMLInputElement).value='5';});await page.click('[data-quota] button');
  await page.waitForFunction('document.querySelector("#member-message").textContent.includes("立即生效")');
  assert.equal((await members.byId(member.id))?.dailyReviewLimit,5);
  const usage:any=await user.evaluate(async()=>fetch('/api/forge/review/usage').then(r=>r.json()));assert.equal(usage.remaining,3);
  await page.click('[data-activity-report]');await page.waitForSelector('dialog[open] .review-report');
  assert.match(await page.$eval('.review-report',el=>el.textContent!),/合成报告/);await page.click('#activity-close');
  await page.screenshot({path:'artifacts/review-capacity-admin-desktop.png',fullPage:true});
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.waitForSelector('#tab-members');await page.click('#tab-members');await page.waitForSelector('[data-activity-report]');await page.screenshot({path:'artifacts/review-capacity-admin-mobile.png',fullPage:true});
  assert(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'No mobile page overflow');assert.deepEqual(errors,[]);
  console.log('PASS 真实迁移/成员登录/并发额度拦截/管理员记录与报告/调额立即生效且保留会话/桌面及手机布局');
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));sqlite.close();}
