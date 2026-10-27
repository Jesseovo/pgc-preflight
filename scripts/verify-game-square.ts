import assert from 'node:assert/strict';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {cp,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {launchLocalBrowser} from '../server/local-browser';

// Isolated, real workerd + Durable Object + migrated local D1 integration check.
// No deployment, remote D1, platform model, external site or existing dev server.
// Synthetic game/report data only. Credentials stay in memory and the removed
// fixture config. Dist is copied once so concurrent builds cannot affect a run.
const repo=resolve('.'),artifacts=resolve('artifacts');
await mkdir(artifacts,{recursive:true});
const root=await mkdtemp(join(artifacts,'square-verify-'));
const state=join(root,'state'),config=join(root,'wrangler.json'),assets=join(root,'assets');
const wrangler=resolve('node_modules/wrangler/bin/wrangler.js');
const adminPassword=randomBytes(24).toString('hex'),settingsKey=randomBytes(32).toString('hex'),password=randomBytes(16).toString('hex');
const checks:string[]=[];
let worker:ChildProcess|undefined,browser:Awaited<ReturnType<typeof launchLocalBrowser>>|undefined;
let workerLog='';
const check=(name:string)=>{checks.push(name);console.log(`PASS ${name}`);};
async function freePort(){const server=createServer();await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port;}
async function stopWorker(){
  if(!worker?.pid||worker.exitCode!==null)return;
  if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(worker.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
  else worker.kill('SIGTERM');
  await Promise.race([new Promise<void>(done=>worker!.once('close',()=>done())),delay(5000)]);
}
try{
  await cp(resolve('dist'),assets,{recursive:true});
  const original=JSON.parse(await readFile('wrangler.jsonc','utf8'));
  const isolated={
    name:'pgc-square-local-fixture',main:resolve('server/worker.ts'),
    compatibility_date:original.compatibility_date,compatibility_flags:original.compatibility_flags,
    durable_objects:original.durable_objects,migrations:original.migrations,
    assets:{...original.assets,directory:assets},ratelimits:original.ratelimits,
    d1_databases:[{binding:'DB',database_name:'square-fixture',database_id:randomUUID()}],
    vars:{ADMIN_PASSWORD:adminPassword,SETTINGS_KEY:settingsKey},
  };
  await writeFile(config,JSON.stringify(isolated));
  const migrations=(await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort();
  const schema=join(root,'schema.sql');await writeFile(schema,(await Promise.all(migrations.map(name=>readFile(join('migrations',name),'utf8')))).join('\n'));
  try{execFileSync(process.execPath,[wrangler,'d1','execute','square-fixture','--config',config,'--local','--persist-to',state,'--file',schema,'--json'],{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});}
  catch{throw new Error('Isolated local D1 migration failed; remote D1 was not used.');}
  const port=await freePort(),inspector=await freePort(),origin=`http://127.0.0.1:${port}`;
  worker=spawn(process.execPath,[wrangler,'dev','--config',config,'--local','--persist-to',state,'--port',String(port),'--inspector-port',String(inspector),'--ip','127.0.0.1','--no-live-reload'],{cwd:repo,windowsHide:true,stdio:['ignore','pipe','pipe']});
  worker.stdout?.on('data',data=>workerLog=(workerLog+data).slice(-30000));worker.stderr?.on('data',data=>workerLog=(workerLog+data).slice(-30000));
  worker.once('error',()=>{workerLog+='\nworker spawn failed';});
  let ready=false;for(let i=0;i<150;i++){
    if(worker.exitCode!==null)break;
    try{const response=await fetch(origin+'/api/auth/me',{signal:AbortSignal.timeout(1000)});if(response.status===401){ready=true;break;}}catch{}
    await delay(400);
  }
  if(!ready){let safe=workerLog;for(const secret of [adminPassword,settingsKey,password])safe=safe.replaceAll(secret,'[redacted]');await writeFile(join(artifacts,'square-worker-startup-error.log'),safe);throw new Error('Isolated Worker did not start; redacted startup evidence saved.');}
  check('real isolated Worker, Durable Object and all local D1 migrations ready');
  async function call(path:string,{cookie='',token='',body,method,headers={}}:{cookie?:string;token?:string;body?:any;method?:string;headers?:Record<string,string>}={}){
    return fetch(origin+path,{method:method||(body===undefined?'GET':'POST'),redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:`Bearer ${token}`} :{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  }
  async function json(path:string,options:Parameters<typeof call>[1]={},expected=200){const response=await call(path,options);const value=await response.json() as any;assert.equal(response.status,expected,`${path}: ${value?.error||'unexpected status'}`);return value;}
  async function status(path:string,expected:number,options:Parameters<typeof call>[1]={}){const response=await call(path,options);assert.equal(response.status,expected,`${path}: unexpected HTTP status`);return response;}
  async function login(path:string,body:any){const response=await call(path,{body});assert.equal(response.status,200,'fixture login failed');const cookie=response.headers.get('Set-Cookie')?.split(';')[0];assert.ok(cookie,'fixture login cookie missing');return cookie;}
  const admin=await login('/api/admin/login',{password:adminPassword});
  const accounts:Record<string,{id:string;cookie:string}>={};
  for(const [username,canReview,star] of [['plain',false,false],['reviewer',true,false],['star',false,true],['disabled',false,false]] as const){
    const member=await json('/api/admin/members',{cookie:admin,body:{username,password,displayName:`Square Fixture ${username}`,canReview,star,dailyReviewLimit:0}},201);
    accounts[username]={id:member.id,cookie:await login('/api/auth/login',{username,password})};
  }
  await json('/api/admin/members/'+accounts.disabled.id,{cookie:admin,method:'PATCH',body:{enabled:false}});
  const aliases=['/square','/square/','/square.html','/square/index.html'];
  for(const path of aliases){for(const cookie of ['',accounts.disabled.cookie]){const response=await status(path,302,{cookie});assert.equal(response.headers.get('Location'),'/login');}}
  for(const cookie of ['',accounts.disabled.cookie])await status('/api/square/games',401,{cookie});
  check('anonymous and disabled sessions cannot read square documents or APIs');
  for(const cookie of [accounts.plain.cookie,accounts.reviewer.cookie,accounts.star.cookie,admin]){
    await status('/square',200,{cookie});const list=await json('/api/square/games',{cookie});assert.equal(list.total,0);
  }
  check('every enabled login can enter square without canReview, Star or admin role');
  await status('/api/square/games?scope=manage',403,{cookie:accounts.plain.cookie});
  await status('/api/admin/members',401,{cookie:accounts.plain.cookie});
  await status('/api/forge/review/device/pairing',401,{cookie:accounts.plain.cookie,body:{}});
  check('square access does not grant member review or administrative permissions');
  async function pair(cookie:string){const pairing=await json('/api/forge/review/device/pairing',{cookie,body:{}});const token=randomBytes(32).toString('hex'),deviceId=randomUUID();await json('/api/review-device/pair',{body:{code:pairing.code,token,deviceId,name:'Synthetic square verification'}});return token;}
  const token=await pair(accounts.reviewer.cookie),otherToken=await pair(accounts.reviewer.cookie),foreignToken=await pair(admin);
  for(const auth of [`Bearer ${token}`,'Basic fixture'])for(const path of ['/square','/api/square/games','/api/square/games?scope=manage'])await status(path,403,{cookie:admin,headers:{Authorization:auth}});
  check('any Authorization header, including Bearer plus admin Cookie, is denied');
  const html='<!doctype html><html><meta charset="utf-8"><title>Square synthetic source</title><body><h1>Synthetic square fixture</h1><script>const result={type:"square-sandbox-fixture",scriptRan:true};for(const [name,fn] of [["parent",()=>parent.document.body],["cookie",()=>document.cookie],["storage",()=>localStorage.getItem("square-secret")]]){try{fn();result[name]="allowed"}catch{result[name]="blocked"}}fetch("/__square_fetch_probe").catch(()=>{});const image=new Image();image.src="/__square_image_probe";parent.postMessage(result,"*");</script></body></html>';
  async function submit(title:string,content=html,bearer=token){return json('/api/review-device/submit',{token:bearer,body:{request_id:randomUUID(),title,filename:'fixture.html',html:content,model_executor:'agent'}});}
  let tick=0;const time=()=>new Date(Date.UTC(2026,9,27,12,0,tick++)).toISOString();
  const human=(job:any,overrides:any={})=>({id:job.id,...(job.lease?{lease:job.lease}:{}),requestId:randomUUID(),workId:`work-${job.id}`,versionId:'version-1',score:0,feedback:'Synthetic final feedback',updatedAt:time(),source:'https://creator-hub-7mi.pages.dev',status:'reviewed',phase:'final',matchedBy:'user-confirmed',...overrides});
  const saveHuman=(body:any,bearer=token)=>json('/api/review-device/human-review',{token:bearer,body});
  const publish=(job:any,content=html,bearer=token,requestId=randomUUID())=>json('/api/review-device/gallery',{token:bearer,body:{id:job.id,...(job.lease?{lease:job.lease}:{}),requestId,html:content}});
  const noApproval=await submit('Private unreviewed source');
  await status('/api/review-device/gallery',409,{token,body:{id:noApproval.id,requestId:randomUUID(),html}});
  const legacy=await saveHuman(human(noApproval));assert.equal(legacy.human_review.decision,null);assert.equal(legacy.gallery,undefined);
  await status('/api/review-device/gallery',409,{token,body:{id:noApproval.id,requestId:randomUUID(),html}});
  const preliminary=await submit('Private preliminary source');
  await saveHuman(human(preliminary,{phase:'preliminary',score:9}));
  await status('/api/review-device/gallery',409,{token,body:{id:preliminary.id,requestId:randomUUID(),html}});
  await status('/api/review-device/human-review',400,{token,body:human(preliminary,{phase:'preliminary',decision:'approved'})});
  const waiting=await submit('Private pending source');await saveHuman(human(waiting,{status:'pending',phase:null,score:null,feedback:null}));
  const initialRejected=await submit('Private rejected source');await saveHuman(human(initialRejected,{decision:'rejected',score:9}));
  assert.equal((await json('/api/square/games',{cookie:accounts.plain.cookie})).total,0);
  assert.equal((await json('/api/square/games?scope=manage',{cookie:admin})).total,0);
  check('only explicit final approved publishes; legacy scores, preliminary, pending and rejection stay private');
  const approved=await submit('Zero score approved fixture');
  const approvedBody=human(approved,{decision:'approved'}),approvedResult=await saveHuman(approvedBody),game=approvedResult.gallery;
  assert.ok(game?.id,'eligible queued source should auto-publish');assert.equal(game.score,0);assert.equal(game.visible,true);
  assert.equal((await saveHuman(approvedBody)).gallery.id,game.id);
  const requestId=randomUUID();assert.equal((await publish(approved,html,token,requestId)).gallery.id,game.id);assert.equal((await publish(approved,html,token,requestId)).gallery.id,game.id);
  await status('/api/review-device/gallery',409,{token,body:{id:approved.id,requestId:randomUUID(),html:html+'\n'}});
  await status('/api/review-device/gallery',404,{token:foreignToken,cookie:admin,body:{id:approved.id,requestId:randomUUID(),html}});
  await status('/api/review-device/human-review',409,{token,body:human(approved,{versionId:'version-2',decision:'approved'})});
  const changedVersion=await submit('Same version different source',html+'<!-- changed -->');
  const changed=await saveHuman(human(changedVersion,{workId:approvedBody.workId,versionId:approvedBody.versionId,decision:'approved'}));assert.equal(changed.human_review.decision,'approved');assert.equal(changed.gallery,undefined);
  await status('/api/review-device/gallery',409,{token,body:{id:changedVersion.id,requestId:randomUUID(),html:html+'<!-- changed -->'}});
  check('zero score is preserved; publication is idempotent, exact-byte and immutable per owner/work/version');
  const claimed=await submit('Original device lease fixture'),lease=await json('/api/review-device/claim',{token,body:{id:claimed.id,claimId:randomUUID()}});
  await saveHuman(human(lease,{decision:'approved'}));
  await status('/api/review-device/gallery',409,{token:otherToken,body:{id:lease.id,lease:lease.lease,requestId:randomUUID(),html}});
  await status('/api/review-device/gallery',409,{token,body:{id:lease.id,requestId:randomUUID(),html}});
  await publish(lease);
  check('running publication remains bound to the original device and lease');
  const completed=await submit('Cleaned input fixture'),completedLease=await json('/api/review-device/claim',{token:otherToken,body:{id:completed.id,claimId:randomUUID()}});
  const ev=await json('/api/review-device/evidence',{token:otherToken,body:{id:completed.id,lease:completedLease.lease,probe:{captureMethod:'browser-viewport-v1',observations:[]},shots:Array.from({length:4},(_,i)=>({label:`fixture-${i}`,data:'data:image/jpeg;base64,YQ=='}))}});
  const report={aes:2,ease:2,play:2,verdict:'建议修改',reviewer_comment:'Synthetic report; protocol only',score_reasons:{aes:'Synthetic',ease:'Synthetic',play:'Synthetic'},uncertainties:['Synthetic protocol verification'],strengths:['Synthetic'],issues:[],fix_prompt:'Synthetic feedback'};
  const draft={id:completed.id,lease:completedLease.lease,evidenceHash:ev.evidenceHash,model:'synthetic-square-fixture',report};
  const drafted=await json('/api/review-device/draft',{token:otherToken,body:draft});
  await json('/api/review-device/complete',{token:otherToken,body:{...draft,verification:{confirmed:true,model:draft.model,evidenceHash:draft.evidenceHash,draftHash:drafted.draftHash}}});
  const pending=await saveHuman(human(completedLease,{decision:'approved',score:null}),otherToken);assert.equal(pending.gallery_pending,true);assert.equal(pending.gallery,undefined);
  const recovered=await publish(completedLease,html,otherToken);assert.equal(recovered.gallery.score,null);assert.equal(recovered.gallery.visible,true);
  const savedReport=await json('/api/review-device/report',{token:otherToken,body:{id:completed.id}});assert.deepEqual(savedReport.result,report);
  check('completed input cleanup returns gallery_pending; original lease/HTML recovers it without altering AI report');
  const detail=await json('/api/square/games/'+game.id,{cookie:accounts.plain.cookie});assert.equal(detail.score,0);assert.equal('html' in detail,false);
  for(const cookie of ['',accounts.disabled.cookie])for(const suffix of ['','/preview'])await status('/api/square/games/'+game.id+suffix,401,{cookie});
  await status('/api/square/games/'+game.id+'/preview',403,{cookie:admin,token});
  const preview=await status('/api/square/games/'+game.id+'/preview',200,{cookie:accounts.plain.cookie});assert.equal(await preview.text(),html);
  const previewHead=await status('/api/square/games/'+game.id+'/preview',200,{cookie:accounts.plain.cookie,method:'HEAD'});
  assert.match(previewHead.headers.get('Content-Type')||'',/text\/html/i);
  const csp=preview.headers.get('Content-Security-Policy')||'';
  for(const directive of ['sandbox allow-scripts',"default-src 'none'","connect-src 'none'","object-src 'none'","frame-src 'none'","base-uri 'none'","form-action 'none'","frame-ancestors 'self'"])assert.ok(csp.includes(directive),`CSP ${directive}`);
  assert.equal(csp.includes('allow-same-origin'),false);assert.match(preview.headers.get('Cache-Control')||'',/private.*no-store/);assert.match(preview.headers.get('Vary')||'',/Cookie/i);assert.equal(preview.headers.get('Referrer-Policy'),'no-referrer');
  check('private detail/preview require login; exact HTML has sandbox CSP, disabled network APIs and private no-store caching');
  browser=await launchLocalBrowser();
  const page=await browser.newPage();const [cookieName,...cookieParts]=accounts.plain.cookie.split('=');await browser.setCookie({name:cookieName,value:cookieParts.join('='),domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict'});
  // A blocked fetch/image can still emit a browser request event before CSP
  // rejects it. Count only responses, which prove that a network resource was
  // actually delivered to the frame.
  const network:string[]=[];page.on('response',response=>{if(response.url().includes('__square_'))network.push(response.url());});
  await page.goto(origin+'/square',{waitUntil:'domcontentloaded'});
  await page.evaluate((src:string)=>{document.body.innerHTML='';localStorage.setItem('square-secret','parent-only');(window as any).__squareEvidence=null;addEventListener('message',event=>{if(event.data?.type==='square-sandbox-fixture')(window as any).__squareEvidence={...event.data,eventOrigin:event.origin};});const frame=document.createElement('iframe');frame.sandbox.add('allow-scripts');frame.referrerPolicy='no-referrer';frame.src=src;document.body.append(frame);},origin+'/api/square/games/'+game.id+'/preview');
  await page.waitForFunction(()=>!!(window as any).__squareEvidence,{timeout:10000});await delay(300);
  const sandboxEvidence=await page.evaluate(()=>(window as any).__squareEvidence);assert.deepEqual(sandboxEvidence,{type:'square-sandbox-fixture',scriptRan:true,parent:'blocked',cookie:'blocked',storage:'blocked',eventOrigin:'null'});assert.deepEqual(network,[]);
  check('real Chromium executes game in opaque origin, blocks parent/Cookie/storage access and fetch/image probes');
  await browser.close();browser=undefined;
  await status('/api/square/games/'+game.id+'/visibility',403,{cookie:accounts.plain.cookie,body:{hidden:true}});
  await status('/api/square/games/'+game.id+'/visibility',403,{cookie:admin,body:{hidden:true},headers:{Origin:'https://other.invalid'}});
  await json('/api/square/games/'+game.id+'/visibility',{cookie:admin,body:{hidden:true}});
  for(const cookie of [accounts.plain.cookie,admin])for(const suffix of ['','/preview'])await status('/api/square/games/'+game.id+suffix,404,{cookie});
  const managed=await json('/api/square/games?scope=manage',{cookie:admin});assert.equal(managed.items.find((item:any)=>item.id===game.id).hidden,true);
  await json('/api/square/games/'+game.id+'/visibility',{cookie:admin,body:{hidden:false}});await status('/api/square/games/'+game.id+'/preview',200,{cookie:accounts.plain.cookie});
  check('only admin can hide/unhide with same-origin POST; hidden detail/preview are 404 even for admin');
  await saveHuman(human(approved,{workId:approvedBody.workId,decision:'rejected'}));
  for(const cookie of [accounts.plain.cookie,admin])for(const suffix of ['','/preview'])await status('/api/square/games/'+game.id+suffix,404,{cookie});
  const managedRejected=await json('/api/square/games?scope=manage',{cookie:admin});assert.equal(managedRejected.items.find((item:any)=>item.id===game.id).visible,false);
  await status('/api/review-device/gallery',409,{token,body:{id:approved.id,requestId:randomUUID(),html}});
  check('new final rejection removes a previously approved version immediately and prevents republishing');
  for(let i=0;i<14;i++){const job=await submit(`Pagination fixture ${String(i).padStart(2,'0')}${i===0?' 100%_literal':''}`);await saveHuman(human(job,{decision:'approved',score:i%10===9?8:i%9}));}
  const first=await json('/api/square/games?q=Pagination%20fixture&page=1',{cookie:accounts.plain.cookie}),second=await json('/api/square/games?q=Pagination%20fixture&page=2',{cookie:accounts.plain.cookie});
  assert.equal(first.total,14);assert.equal(first.pageSize,12);assert.equal(first.items.length,12);assert.equal(first.hasMore,true);assert.equal(second.items.length,2);assert.equal(second.hasMore,false);assert.equal(new Set([...first.items,...second.items].map((item:any)=>item.id)).size,14);
  assert.equal((await json('/api/square/games?q='+encodeURIComponent('100%_literal'),{cookie:accounts.plain.cookie})).total,1);
  assert.equal((await json('/api/square/games?q='+encodeURIComponent('Square Fixture reviewer'),{cookie:accounts.plain.cookie})).total,16);
  assert.equal((await json('/api/square/games?q=does-not-exist',{cookie:accounts.plain.cookie})).total,0);
  for(const value of ['0','-1','1.5','1e2','1000000'])await status('/api/square/games?page='+encodeURIComponent(value),400,{cookie:accounts.plain.cookie});
  check('search escapes literal percent/underscore, matches authors, and paginates without duplicates');
  const evidence=join(artifacts,`game-square-local-evidence-${randomUUID()}.json`);
  await writeFile(evidence,JSON.stringify({kind:'local-synthetic-integration',at:new Date().toISOString(),productionWrites:false,migrations,checks,sandboxEvidence,previewCsp:csp,sourceHtmlPersistedOnlyAfterApproval:true},null,2));
  console.log(`PASS ${checks.length} groups; evidence: ${evidence}`);
}finally{
  await browser?.close().catch(()=>{});await stopWorker();
  const target=resolve(root);assert.ok(target.startsWith(artifacts+sep));assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('square-verify-'));
  await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
