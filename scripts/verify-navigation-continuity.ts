import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {launchLocalBrowser} from '../server/local-browser';
const baseline=process.argv.includes('--baseline'),assetRoot=resolve(baseline?'artifacts/continuity-baseline/public':'public');
let reads=0,writes=0,star=true,failNextSquare=false;
const topics=Array.from({length:60},(_,i)=>({id:i+1,status:'liked',subject:`合成项目 ${i+1}`,data:{title:`合成项目 ${i+1}`,logline:'用于检查页面连续性'},updated_at:'2026-10-31',has_product:0}));
const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://fixture');
  const json=(v:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(v));};
  try{
    if(!['GET','HEAD'].includes(req.method!))writes++;
    if(url.pathname.startsWith('/api/')){reads++;await new Promise(r=>setTimeout(r,450));}
    if(url.pathname==='/api/auth/me')return json({id:star?'star':'review',role:'member',star,canReview:true,displayName:'连续性验收'});
    if(url.pathname==='/api/forge/state')return json({games:0,vocab:10,fresh_subjects:100});
    if(url.pathname==='/api/forge/settings')return json({draw_size:2});
    if(url.pathname==='/api/forge/vocab')return json(Array.from({length:20},(_,i)=>({id:i,dim:'subject',word:'测试词 '+i,base:1,enabled:1})));
    if(url.pathname==='/api/forge/topics')return json(topics);
    if(url.pathname==='/api/forge/agent/devices')return json({devices:[],tasks:[]});
    if(url.pathname==='/api/forge/review/worker-status')return json({devices:[],online:false});
    if(url.pathname==='/api/square/games'&&failNextSquare){failNextSquare=false;res.statusCode=503;return json({error:'Synthetic unavailable'});}
    if(url.pathname==='/api/square/games')return json({items:[],total:0,page:1,pageSize:12,hasMore:false});
    if(url.pathname.startsWith('/api/forge/'))return json([]);
    if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
    const mapped=url.pathname==='/'?'/review.html':['/forge/','/square'].includes(url.pathname)?star?'/forge/index.html':'/review.html':url.pathname;
    const file=resolve(assetRoot,'.'+mapped);assert(file.startsWith(assetRoot+sep));
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'image/png');res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await launchLocalBrowser();await mkdir('artifacts',{recursive:true});const checks:any[]=[];
try{
 for(const role of [true,false]){
  star=role;const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));await page.setViewport({width:1440,height:1000});await page.evaluateOnNewDocument('window.__name = fn => fn;');
  await page.goto(origin+(star?'/forge/':'/'));await page.waitForSelector(star?'#pickCards .project-row':'.review-setup');
  const sample=async(name:string,selector:string,done:string)=>{
    await page.evaluate(()=>{(window as any).__samples=[];let stop=false;(window as any).__stop=()=>{stop=true;};const frame=()=>{const root=document.querySelector('#view')!;(window as any).__samples.push({empty:!root.textContent?.trim(),scroll:scrollY,firstTop:root.firstElementChild?.getBoundingClientRect().top,loading:!!root.querySelector('.pgc-load-status'),page:root.getAttribute('data-page'),selected:document.querySelector('#tabs [aria-current=page]')?.getAttribute('data-tab')||(document.querySelector('.member-square[aria-current=page]')?'square':'review'),text:root.textContent?.trim().slice(0,25)});if(!stop)requestAnimationFrame(frame);};requestAnimationFrame(frame);});
    await page.click(selector);await page.waitForSelector(done);await new Promise(r=>setTimeout(r,180));
    const frames=await page.evaluate(()=>{(window as any).__stop();return (window as any).__samples;});
    const result={role:star?'star':'review',name,emptyFrames:frames.filter((f:any)=>f.empty).length,flowLoadingFrames:frames.filter((f:any)=>f.loading).length,frames};checks.push(result);
    if(!baseline){assert.equal(result.emptyFrames,0,name+' must retain content until replacement');assert.equal(result.flowLoadingFrames,0,name+' must not insert a loading row');assert(frames.every((f:any)=>!f.page||f.page===f.selected),'Content and selected navigation change in the same frame');}
  };
  if(star){await page.evaluate(()=>scrollTo(0,500));await new Promise(r=>setTimeout(r,150));await sample('scrolled projects → vocabulary','[data-tab=vocab]','.tablewrap tbody tr');if(!baseline)assert.equal(await page.evaluate(()=>scrollY),0,'Destination scroll must not inherit outgoing layout events');}
  await sample('workspace → square','.member-square','#results .empty-state');
  await sample('square → workspace',star?'[data-tab=agent]':'.member-nav a[href="/"]',star?'.personal-agent':'.review-setup');
  if(!baseline){
    await page.click('.member-square');await page.waitForSelector('#results .empty-state');
    await page.type('#search','尚未提交的搜索');const length=await page.evaluate(()=>history.length);
    await page.click('.member-square');assert.equal(await page.$eval('#search',el=>(el as HTMLInputElement).value),'尚未提交的搜索');assert.equal(await page.evaluate(()=>history.length),length,'Current navigation is a no-op');
    if(star){
      await page.click('[data-tab=agent]');await new Promise(r=>setTimeout(r,80));await page.click('[data-tab=picks]');
      await page.waitForSelector('#pickCards');await new Promise(r=>setTimeout(r,550));
      assert.equal(await page.$eval('#view',el=>(el as HTMLElement).dataset.page),'picks');
      assert(Math.abs(await page.evaluate(()=>scrollY)-500)<2,'Return to projects restores its own scroll');
      await page.goBack();await page.waitForSelector('.personal-agent');assert.equal(await page.evaluate(()=>scrollY),0,'Abandoned request must not save another page scroll');
    }
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.click('.member-square');await page.waitForSelector('#results .empty-state');
    assert.equal(await page.$eval('#view',el=>el.getAnimations().length),0,'Reduced motion skips entry animation');
    await page.setViewport({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    failNextSquare=true;
    await page.evaluate(()=>{history.pushState({scrollY:0},'','/square?q=retry-fixture');dispatchEvent(new PopStateEvent('popstate'));});
    await page.waitForSelector('[data-route-retry]');assert.equal(await page.$eval('#view',el=>(el as HTMLElement).inert),false);
    await page.click('[data-route-retry]');await page.waitForSelector('#results .empty-state');assert.equal(await page.$('[data-route-retry]'),null);

  }
  assert.deepEqual(errors,[]);await page.close();
 }
 assert.equal(writes,0);await writeFile(`artifacts/continuity-${baseline?'before':'after'}.json`,JSON.stringify({checks,reads,writes},null,2));
 console.log(JSON.stringify(checks.map(({frames,...item})=>item),null,2));
}finally{await browser.close();server.close();}
