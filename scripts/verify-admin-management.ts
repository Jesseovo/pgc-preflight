import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer,type IncomingMessage} from 'node:http';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchLocalBrowser} from '../server/local-browser';
import type {AdminRoute} from '../src/admin/contracts';

// Run with npx tsx scripts/verify-admin-management.ts. Everything is synthetic:
// the UI is bundled from source and its requests end at this loopback server.
const repository=fileURLToPath(new URL('..',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'pgc-admin-management-'));
const mutations:Array<{path:string;body:any}>=[];
const unexpectedRequests:string[]=[];
const member={id:'11111111-1111-1111-1111-111111111111',displayName:'合成成员',username:'fixture',enabled:true,canReview:true,star:true,dailyReviewLimit:50,createdAt:'2026-10-28T01:00:00Z',updatedAt:'2026-10-28T01:00:00Z',lastActivity:'2026-10-27T18:20:00.000Z'};
const idleMember={...member,id:'33333333-3333-3333-3333-333333333333',username:'idle.fixture',displayName:'暂无活动成员',lastActivity:null};
const emptyBinding=()=>({status:'unlinked',sourceAuthorId:null as string|null,workId:null as string|null,versionId:null as string|null,verifiedAt:null as string|null});
const pilot={memberId:member.id,displayName:member.displayName,username:member.username,accountEnabled:true,pilotEnabled:false,creatorAccount:'',revision:0,enrollmentStartedAt:null as string|null,updatedAt:null as string|null,binding:emptyBinding()};
let pilotAvailable=false,losePilotResponse=true,limitPilotLink=true;
const pilotRequests=new Map<string,string>();
const result={aes:2,ease:3,play:2,verdict:'建议修改',reviewer_comment:'合成审核意见',score_reasons:{aes:'美学证据',ease:'操作证据',play:'玩法证据'},uncertainties:['声音待确认'],strengths:['规则清楚'],issues:[{severity:'中',area:'反馈',problem:'合成问题',evidence:'合成证据',fix:'合成建议'}],fix_prompt:'请按建议修改'};
const human={status:'reviewed',phase:'final',score:8,decision:'approved',feedback:'真人反馈',workId:'work-1',versionId:'v1'};
const report={id:1,owner_id:member.id,title:'合成游戏',score:7,result,created_at:'2026-10-28T01:00:00Z',model_executor:'agent',probe:{evidenceOrigin:'member-device',summary:'合成采集摘要'},shots:[],human_review:human};
let failPermission=true,uploadFailures=2,delayPublic=false,releasePublic:(()=>void)|undefined,onPublicStarted:(()=>void)|undefined;
let browser:Awaited<ReturnType<typeof launchLocalBrowser>>|undefined;
const bundled=new Map<string,Uint8Array>();

async function readBody(request:IncomingMessage){const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
const server=createServer(async(request,response)=>{
  const url=new URL(request.url!,'http://fixture');
  const json=(value:unknown,status=200)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));};
  try{
    if(url.pathname==='/api/admin/review-pilots'&&request.method==='GET'){
      if(!pilotAvailable)return json({error:'灰测设置暂不可用'},404);
      return json({members:[pilot,{...pilot,memberId:idleMember.id,pilotEnabled:false,creatorAccount:'',binding:emptyBinding()}]});
    }
    if(url.pathname.startsWith('/api/admin/review-pilots/')&&request.method==='POST'){
      const body=await readBody(request);mutations.push({path:url.pathname,body});
      assert.equal(body.memberId,member.id);assert.match(body.requestId,/^[a-f0-9-]{36}$/);
      const prior=pilotRequests.get(body.requestId);
      if(prior){assert.equal(prior,JSON.stringify(body));return json({member:pilot});}
      if(body.expectedRevision!==pilot.revision)return json({error:'灰测设置已更新，请重新读取'},409);
      const kind=url.pathname.split('/').at(-1);
      if(kind==='link'&&limitPilotLink){limitPilotLink=false;return json({error:'来源限流，请稍后重试'},429);}
      if(kind==='member'){
        pilot.pilotEnabled=body.pilotEnabled;pilot.creatorAccount=body.creatorAccount;
        pilot.binding={...emptyBinding(),status:pilot.creatorAccount?'declared':'unlinked'};
      }else if(kind==='link'){
        assert.equal(body.ownershipConfirmed,true);
        pilot.binding={status:'linked',sourceAuthorId:'author_fixture',workId:'game_fixture',versionId:'version_fixture',verifiedAt:'2026-11-04T01:00:00Z'};
      }else if(kind==='unlink')pilot.binding={...emptyBinding(),status:'declared'};
      else throw new Error('Unexpected pilot operation');
      pilot.revision++;pilotRequests.set(body.requestId,JSON.stringify(body));
      if(losePilotResponse){losePilotResponse=false;return json({error:'合成连接失败，请用原内容重试'},503);}
      return json({member:pilot});
    }
    if(url.pathname==='/api/admin/members'&&request.method==='GET')return json({members:[member,idleMember]});
    if(url.pathname===`/api/admin/members/${member.id}`&&request.method==='PATCH'){
      const body=await readBody(request);mutations.push({path:url.pathname,body});
      if(body.canReview!==undefined&&failPermission){failPermission=false;return json({error:'合成保存失败'},503);}
      Object.assign(member,body);return json(member);
    }
    if(url.pathname==='/api/admin/members'&&request.method==='POST'){
      const body=await readBody(request);mutations.push({path:url.pathname,body});
      return json({...member,id:'22222222-2222-2222-2222-222222222222',...body},201);
    }
    if(url.pathname==='/api/admin/review-activity'){
      const scope=url.searchParams.get('scope'),owner=url.searchParams.get('member');
      assert(['all','members','admin'].includes(scope!));
      const summaries=[{id:'admin',username:'admin',display_name:'超级管理员',used:1,daily_review_limit:null,submitted:1,completed:1,active:0,failed:0},{id:member.id,username:member.username,display_name:member.displayName,used:0,daily_review_limit:member.dailyReviewLimit,submitted:1,completed:1,active:0,failed:0}].filter(m=>scope==='all'||(scope==='admin')===(m.id==='admin'));
      const records=[{id:'review-job',owner_id:member.id,title:report.title,filename:'fixture.html',status:'done',stage:'done',model_executor:'agent',error:'',result_id:1,created_at:report.created_at,updated_at:report.created_at,quota_charged:0,username:member.username,display_name:member.displayName,score:7,human_review:human}].filter(r=>(scope!=='admin')&&(!owner||owner===r.owner_id));
      return json({day:url.searchParams.get('date'),timeZone:'Asia/Shanghai',scope,records,members:summaries,page:1,pageSize:50,total:records.length});
    }
    if(url.pathname==='/api/forge/reviews/1')return json(report);
    if(url.pathname==='/api/admin/config')return json({activeProfile:'opus',profiles:{opus:{name:'合成模型',model:'claude-opus-5-5',baseUrl:'https://riffle-api.pages.dev/v1',protocol:'anthropic',enabled:true,hasKey:true,keySuffix:'abcd',updatedAt:'',effort:'low',maxOutputTokens:0}},routes:{review:'opus',create:'opus'},effective:{review:'opus',create:'opus'}});
    if(url.pathname==='/api/admin/quota')return json({error:'合成余额查询失败'},502);
    if(url.pathname==='/api/admin/review-rules'&&request.method==='GET')return json({active:null,candidate:null,diff:[],history:[]});
    if(url.pathname==='/api/admin/public-data'&&request.method==='GET'){
      if(delayPublic){delayPublic=false;await new Promise<void>(resolve=>{releasePublic=resolve;onPublicStarted?.();});}
      return json({settings:{redlines:'合成规则',template:'合成模板',template_f:'合成骨架',draw_size:'10',expand_batch:'5'},vocab:[{id:1,dim:'subject',word:'森林',note:'合成备注',base:0,enabled:1}],games:[{id:1,title:'既有案例',is_public:1}],publishableGames:[{id:1,title:'既有案例',owner_id:'admin',is_public:1},{id:2,title:'私有作品',owner_id:member.id,is_public:0}],suggestions:[{id:'suggestion',dim:'subject',owner_id:member.id,ownerName:member.displayName,words:[{word:'水晶',note:'合成补词'}],created_at:report.created_at,status:'pending'}]});
    }
    if(url.pathname==='/api/admin/public-data'&&request.method==='POST'){mutations.push({path:url.pathname,body:await readBody(request)});return json({ok:true});}
    if(url.pathname==='/api/admin/review-upload'&&request.method==='POST'){
      const body=await readBody(request);mutations.push({path:url.pathname,body});
      if(uploadFailures>0){uploadFailures--;return json({error:'合成上传响应失败，请使用原请求重试'},503);}
      return json({id:body.request_id,title:body.title,filename:body.filename,stage:'capture',status:'queued',result_id:null,quota_charged:1,model_executor:'platform'},202);
    }
    if(url.pathname==='/api/admin/review-import'&&request.method==='POST'){mutations.push({path:url.pathname,body:await readBody(request)});return json({id:1,job_id:'import-job'},201);}
    if(url.pathname==='/'){
      response.setHeader('Content-Type','text/html; charset=utf-8');
      return response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><main id="fixture" style="max-width:1100px;margin:auto;padding:24px"></main><script type="module" src="/fixture.js"></script></body></html>');
    }
    if(bundled.has(url.pathname)){response.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'text/javascript');return response.end(bundled.get(url.pathname));}
    if(url.pathname==='/favicon.ico'){response.writeHead(204);return response.end();}
    if(url.pathname.startsWith('/forge/')){
      const root=resolve(repository,'public'),file=resolve(root,'.'+url.pathname);assert(file.startsWith(root+sep));
      response.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');return response.end(await readFile(file));
    }
    unexpectedRequests.push(url.pathname);json({error:'Unexpected synthetic request'},404);
  }catch(error){json({error:String(error)},500);}
});

try{
  const output=await build({stdin:{contents:`
    import {mountManagement} from './src/admin/manage';
    import './src/style.css';import './src/admin.css';import './src/admin/shell.css';
    const root=document.querySelector('#fixture');let controller,cleanup,generation=0;
    let route={view:'members',range:'today',owner:'',q:'',status:'all',type:'all',page:1};
    window.calls=[];window.notices=[];
    window.renderFixture=async(changes)=>{
      const own=++generation;controller?.abort();cleanup?.();root.replaceChildren();controller=new AbortController();
      route={...route,...changes};window.route=route;const current=controller;
      const dispose=await mountManagement({root,route,signal:current.signal,
        api:async(path,method='GET',body)=>{window.calls.push({path,method,body});
          const response=await fetch(path.startsWith('/api/')?path:'/api/admin/'+path,{method,body:body===undefined?undefined:JSON.stringify(body),headers:body===undefined?undefined:{'Content-Type':'application/json'},signal:current.signal});
          const data=await response.json();if(!response.ok)throw Error(data.error);return data;
        },navigate:changes=>void window.renderFixture(changes),notice:(text,error)=>window.notices.push({text,error}),setRefresh:(fn,mode)=>{window.refresh=fn;window.mode=mode;}
      });
      if(own===generation)cleanup=dispose;else dispose();
    };void window.renderFixture({});`,resolveDir:repository,sourcefile:'admin-management-fixture.ts',loader:'ts'},bundle:true,format:'esm',target:'es2022',write:false,outfile:join(temporary,'fixture.js')});
  for(const file of output.outputFiles!){if(file.path.endsWith('.js'))bundled.set('/fixture.js',file.contents);else if(file.path.endsWith('.css'))bundled.set('/fixture.css',file.contents);}
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  browser=await launchLocalBrowser();const page=await browser.newPage(),errors:string[]=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request',request=>{const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&url.origin!==origin){unexpectedRequests.push(request.url());void request.abort();}else void request.continue();});
  const render=async(changes:Partial<AdminRoute>)=>{
    // Puppeteer drops undefined object properties; preserve route resets explicitly.
    const encoded=Object.fromEntries(Object.entries(changes).map(([key,value])=>[key,value===undefined?null:value]));
    await page.evaluate(encoded=>(window as any).renderFixture(Object.fromEntries(Object.entries(encoded).map(([key,value])=>[key,value===null?undefined:value]))),encoded);
  };
  const setValue=async(selector:string,value:string)=>{await page.$eval(selector,(el,value)=>{(el as HTMLInputElement).value=value;},value);};
  const lastBody=()=>mutations.at(-1)!.body;

  await page.setViewport({width:1360,height:960});await page.goto(origin);await page.waitForSelector('[data-member]');
  assert.equal(await page.evaluate(()=>(window as any).calls.some((c:any)=>c.path==='config')),false,'Member entry must not read model settings');
  assert((await page.$eval('[data-member-list] thead',el=>(el as HTMLElement).innerText)).includes('最近活动 · 北京时间'));
  assert((await page.$eval('[data-member-list] time',el=>(el as HTMLElement).innerText)).includes('02:20'),'Activity dates use Beijing time');
  assert.equal(await page.$eval(`[data-member="${idleMember.id}"]`,el=>el.closest('tr')!.querySelectorAll('td')[4].textContent),'暂无','Missing activity is explicit');
  await page.click('[data-member]');await page.waitForSelector('[data-permissions]');await page.click('[data-permissions] button[type=submit]');
  assert.equal(mutations.length,0,'Unchanged permissions must not revoke sessions');
  await page.click('[name=canReview]');await page.click('[data-permissions] button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-permissions] [role=status]')?.textContent?.includes('合成保存失败'));
  assert.equal(await page.$eval('[name=canReview]',el=>(el as HTMLInputElement).checked),false,'Failed save must retain the draft');
  await page.click('[data-permissions] button[type=submit]');await page.waitForFunction(()=>(window as any).notices.some((n:any)=>n.text==='成员权限已保存。'));
  assert.deepEqual(lastBody(),{canReview:false},'Save only changed permission fields');
  await setValue('[data-quota] input','0');await page.click('[data-quota] button');
  await page.waitForFunction(()=>document.querySelector('[data-quota] [role=status]')?.textContent?.includes('额度已保存'));assert.deepEqual(lastBody(),{dailyReviewLimit:0});
  await page.type('[data-password] [name=password]','synthetic123');await page.type('[data-password] [name=confirmPassword]','different123');
  const beforePassword=mutations.length;await page.click('[data-password] button');assert.equal(mutations.length,beforePassword,'Mismatched passwords must not save');
  await setValue('[data-password] [name=confirmPassword]','synthetic123');await page.click('[data-password] button');
  await page.waitForFunction(()=>document.querySelector('[data-password] [role=status]')?.textContent?.includes('密码已重置'));
  assert.equal(await page.$eval('[data-password] [name=password]',el=>(el as HTMLInputElement).value),'');
  await page.waitForFunction(()=>document.querySelector('[data-pilot-message]')?.textContent?.includes('灰测设置暂不可用'));
  pilotAvailable=true;
  await page.click('[data-pilot-reload]');await page.waitForSelector('[data-pilot-member]');
  assert.equal(await page.$eval('[name=creatorAccount]',el=>(el as HTMLInputElement).value),'');
  assert.equal(await page.$eval('[data-pilot-link] fieldset',el=>(el as HTMLFieldSetElement).disabled),true);
  await page.click('[name=pilotEnabled]');await setValue('[name=creatorAccount]','creator.fixture');
  await page.click('[data-pilot-member] button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-pilot-message]')?.textContent?.includes('合成连接失败'));
  const firstPilot=lastBody();assert.deepEqual(Object.keys(firstPilot).sort(),['creatorAccount','expectedRevision','memberId','pilotEnabled','requestId']);
  assert.equal(firstPilot.expectedRevision,0);assert.equal(firstPilot.creatorAccount,'creator.fixture');assert.equal(firstPilot.pilotEnabled,true);
  await page.click('[data-pilot-member] button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-pilot-message]')?.textContent?.includes('灰测设置已保存'));
  assert.deepEqual(lastBody(),firstPilot,'Ambiguous response retry retains the original request UUID');
  const setLink=async()=>{await setValue('[name=workId]','known-work');await setValue('[name=versionId]','known-version');};
  await setLink();const beforeOwnership=mutations.length;await page.click('[data-pilot-link] button[type=submit]');assert.equal(mutations.length,beforeOwnership);
  await page.click('[name=ownershipConfirmed]');pilot.revision++;
  await page.click('[data-pilot-link] button[type=submit]');await page.waitForFunction(()=>document.querySelector('[data-pilot-message]')?.textContent?.includes('请重新读取'));
  assert.equal(lastBody().expectedRevision,1);assert.equal(pilot.binding.status,'declared');
  assert.equal(await page.$eval('[name=versionId]',el=>(el as HTMLInputElement).value),'known-version','Conflict retains form values');
  await page.click('[data-pilot-reload]');await page.waitForFunction(()=>document.querySelector('[data-pilot-message]')?.textContent?.includes('已读取最新设置'));
  await setLink();await page.click('[name=ownershipConfirmed]');await page.click('[data-pilot-link] button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-pilot-message]')?.textContent?.includes('来源限流'));
  const limited=lastBody();assert.equal(limited.expectedRevision,2);assert.equal(pilot.binding.status,'declared');
  await page.click('[data-pilot-link] button[type=submit]');await page.waitForSelector('[data-pilot-unlink]');assert.deepEqual(lastBody(),limited);
  assert.match(await page.$eval('.adm-pilot-bound',el=>el.textContent||''),/version_fixture/);
  const pilotScreenshots=join(repository,'artifacts','review-pilot-members-20261104');
  await mkdir(pilotScreenshots,{recursive:true});
  const capturePilotPage=async(name:string)=>{
    await page.waitForFunction(()=>{
      const card=document.querySelector('[data-member-pilot]');
      return card?.querySelector('[data-pilot-unlink]')&&!card.hasAttribute('aria-busy');
    });
    const clip=await page.evaluate(async()=>{
      await document.fonts.ready;
      window.scrollTo(0,0);
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      const card=document.querySelector('[data-member-pilot]')!;
      return {x:0,y:0,width:innerWidth,height:Math.max(document.documentElement.scrollHeight,Math.ceil(card.getBoundingClientRect().bottom+scrollY+24))};
    });
    await page.screenshot({path:join(pilotScreenshots,name),clip,captureBeyondViewport:true});
  };
  await capturePilotPage('ui-desktop.png');
  await page.setViewport({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile pilot form must not overflow');
  await capturePilotPage('ui-mobile.png');
  await page.setViewport({width:1360,height:960});
  await render({view:'members',id:undefined});await page.waitForFunction(()=>document.querySelector('[data-pilot-cell]')?.textContent?.includes('已关联（管理员确认）'));
  await page.click('[data-member]');await page.waitForSelector('[data-pilot-unlink]');await page.click('[data-pilot-unlink]');
  await page.waitForFunction(()=>document.querySelector('[data-pilot-message]')?.textContent?.includes('投稿关联已解除'));
  assert.equal(lastBody().expectedRevision,3);assert.equal(pilot.creatorAccount,'creator.fixture');assert.equal(pilot.pilotEnabled,true);
  pilot.creatorAccount='"><img src=x onerror=window.__pilotInjection=1>';
  await page.click('[data-pilot-reload]');await page.waitForFunction(()=>document.querySelector('[data-pilot-message]')?.textContent?.includes('已读取最新设置'));
  assert.equal(await page.$eval('[name=creatorAccount]',el=>(el as HTMLInputElement).value),pilot.creatorAccount);
  assert.equal(await page.$('[data-member-pilot] img'),null);assert.equal(await page.evaluate(()=>Boolean((window as any).__pilotInjection)),false);
  await render({view:'members',id:undefined,panel:'create'});await page.waitForSelector('dialog[open]');
  await setValue('dialog [name=username]','new.fixture');await setValue('dialog [name=displayName]','合成新成员');await setValue('dialog [name=password]','synthetic123');
  await page.click('dialog button[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  assert.equal(lastBody().username,'new.fixture');assert.equal(lastBody().star,false);assert.equal(lastBody().dailyReviewLimit,50);

  await render({view:'reviews',id:undefined,panel:undefined,type:'all',section:'2026-10-28'});await page.waitForSelector('[data-report]');
  assert(await page.evaluate(()=>(window as any).calls.some((c:any)=>c.path.startsWith('review-activity?')&&c.path.includes('scope=all'))));
  assert((await page.$eval('[data-review-records]',el=>(el as HTMLElement).innerText)).includes('8 / 9'));
  await page.click('.adm-review-members>summary');
  assert((await page.$eval('[data-review-member=admin]',el=>(el as HTMLElement).innerText)).includes('管理员不占成员额度'),'Null administrator limit must not display as zero');
  await page.select('[name=scope]','admin');await page.waitForFunction(()=>(window as any).route.type==='admin');await page.waitForSelector('[data-review-member=admin]');
  await page.click('.adm-review-members>summary');await page.click('[data-review-member=admin]');await page.waitForFunction(()=>(window as any).calls.some((c:any)=>c.path.includes('scope=admin')&&c.path.includes('member=admin')));
  await render({view:'reviews',owner:'',type:'all'});await page.waitForSelector('[data-report]');await page.click('[data-report]');await page.waitForSelector('.rr-reasons');
  assert(await page.evaluate(()=>(window as any).calls.some((c:any)=>c.path==='/api/forge/reviews/1')),'Read reports using the Forge detail route');
  assert((await page.$eval('.rr-human-review',el=>(el as HTMLElement).innerText)).includes('真人反馈'));
  assert((await page.$eval('[data-report-checks]',el=>el.textContent!)).includes('合成采集摘要'));

  await render({view:'settings',section:'model',id:undefined});await page.waitForSelector('.provider-row');
  await page.waitForFunction(()=>document.querySelector('.provider-balance')?.textContent?.includes('合成余额查询失败'));
  assert.equal(await page.$eval('.model-library',el=>(el as HTMLElement).hidden),true);await page.click('[data-profile]');
  assert.equal(await page.$eval('.model-library',el=>(el as HTMLElement).hidden),false);assert((await page.$eval('.model-editor-heading',el=>(el as HTMLElement).innerText)).includes('abcd'));
  await render({view:'settings',section:'public',id:undefined});await page.waitForSelector('[data-rule]');
  assert.equal(await page.$('[data-rule-editor] textarea'),null,'Public rule editor opens explicitly');assert(await page.$('[data-rules-import]'),'Rule snapshot form loads using only synthetic fixture data');assert((await page.$eval('[data-vocab-list]',el=>(el as HTMLElement).innerText)).includes('森林'));
  await page.click('[data-rule=redlines]');await page.waitForSelector('textarea');await setValue('[data-rule-editor] textarea','更新规则');await page.click('[data-rule-editor] button[type=submit]');
  await page.waitForFunction(()=>!document.querySelector('[data-rule-editor] textarea'));assert.deepEqual(lastBody(),{action:'settings',settings:{redlines:'更新规则'}});
  await page.click('[data-vocab-edit]');await page.waitForSelector('dialog[open]');assert.equal(await page.$eval('dialog [name=base]',el=>(el as HTMLInputElement).value),'0','Zero vocabulary weights remain zero');await page.click('dialog [data-close]');
  await page.click('[data-approve]');await page.waitForFunction(()=>(window as any).notices.some((n:any)=>n.text==='建议已批准并加入公共词库。'));
  assert.deepEqual(lastBody(),{action:'suggestion-approve',id:'suggestion'});await page.waitForFunction(()=>!document.querySelector('[data-suggestions] article[data-busy]'));await page.waitForSelector('[data-case="2"]');
  await page.click('[data-case="2"]');await page.waitForFunction(()=>(window as any).notices.some((n:any)=>n.text==='作品已发布到公共案例库。'));
  assert.deepEqual(lastBody(),{action:'publish-game',id:2,is_public:true});await page.waitForFunction(()=>!document.querySelector('[data-public-games][data-busy]'));

  // Complete an old request after leaving the page: it cannot replace the member list.
  const oldRequestStarted=new Promise<void>(resolve=>{onPublicStarted=resolve;});delayPublic=true;
  await page.evaluate(()=>void (window as any).renderFixture({view:'settings',section:'public'}));await oldRequestStarted;
  await render({view:'members',section:undefined,id:undefined});assert(releasePublic);releasePublic();
  await page.waitForSelector('[data-member]');assert.equal(await page.$('[data-public-games]'),null);

  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.waitForSelector('[data-member]');
  await render({view:'settings',section:'upload',id:undefined});await page.waitForSelector('[data-game-upload]');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile layout must not overflow');
  const htmlFile=join(temporary,'synthetic-game.html');await writeFile(htmlFile,'<!doctype html><title>合成游戏</title><button>play</button>');
  await (await page.$('[data-game-upload] input[type=file]'))!.uploadFile(htmlFile);await page.click('[data-game-upload] button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-game-upload] [role=status]')?.textContent?.includes('合成上传响应失败'));const firstRequest=lastBody().request_id;
  await page.click('[data-game-upload] button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-game-upload] [role=status]')?.textContent?.includes('合成上传响应失败'));assert.equal(lastBody().request_id,firstRequest,'Unchanged retry must retain the request ID');
  await page.type('[data-game-upload] [name=title]','更新合成游戏');await page.click('[data-game-upload] button[type=submit]');
  await page.waitForSelector('[data-game-upload] [data-upload-result]');const changedRequest=lastBody().request_id;assert.notEqual(changedRequest,firstRequest,'Changed metadata needs a new request ID');
  await page.click('[data-game-upload] [data-upload-result]');assert.equal(await page.evaluate(()=>(window as any).route.id),changedRequest);
  await render({view:'settings',section:'upload',id:undefined});const jsonFile=join(temporary,'synthetic-report.json');await writeFile(jsonFile,JSON.stringify(report));
  await (await page.$('[data-report-import] input[type=file]'))!.uploadFile(jsonFile);await page.select('[data-report-import] [name=owner]',member.id);await page.click('[data-report-import] button[type=submit]');
  await page.waitForSelector('[data-report-import] [data-upload-result]');assert.equal(lastBody().owner_id,member.id);assert.deepEqual(lastBody().result,result);
  await page.click('[data-report-import] [data-upload-result]');await page.waitForSelector('.rr-reasons');assert.equal(await page.evaluate(()=>(window as any).route.id),'1');
  assert.deepEqual(errors,[]);assert.deepEqual(unexpectedRequests,[]);
  console.log('PASS 管理模块：灰测配置、Creator 版本关联、独立读取失败、409/429 与幂等重试、成员显式保存与失败保留、旧会话字段、0 额度、密码确认、创建抽屉、审核范围与管理员额度、真人分数、只读报告、模型懒加载与余额失败、公共资料审批发布、旧请求隔离、管理员上传幂等与导入、手机布局。');
}finally{
  releasePublic?.();await browser?.close();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(temporary,{recursive:true,force:true});
}
