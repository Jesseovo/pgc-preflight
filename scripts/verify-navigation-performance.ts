import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {launchLocalBrowser} from '../server/local-browser';
const baseline=process.argv.includes('--baseline');let star=false,mutations=0,documents=0,reads=0;const samples:any[]=[];
const server=createServer(async(req,res)=>{const url=new URL(req.url!,'http://local');const json=(v:any)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(v));};
 try{
  if(url.pathname.startsWith('/api/')){reads++;await new Promise(r=>setTimeout(r,100));}else if(['/','/square','/forge/'].includes(url.pathname)){documents++;await new Promise(r=>setTimeout(r,100));}
  if(req.method!=='GET')mutations++;
  if(url.pathname==='/api/auth/me')return json({id:star?'star':'review',role:'member',star,canReview:true,displayName:'合成验收成员'});
  if(url.pathname==='/api/square/games')return json({items:[],total:0,page:1,pageSize:12,hasMore:false});
  if(url.pathname==='/api/forge/review/worker-status')return json({devices:[],online:false});
  if(url.pathname==='/api/forge/state')return json({games:0,vocab:0,fresh_subjects:100});
  if(url.pathname==='/api/forge/settings')return json({draw_size:2});
  if(url.pathname.startsWith('/api/forge/'))return json([]);
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  const mapped=url.pathname==='/'?'/review.html':url.pathname==='/square'?(baseline?'/square.html':star?'/forge/index.html':'/review.html'):url.pathname==='/forge/'?'/forge/index.html':url.pathname;
  const file=resolve(baseline?'artifacts/perf-baseline/public':'public','.'+mapped);assert(file.startsWith(resolve(baseline?'artifacts/perf-baseline/public':'public')+sep));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'image/png');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await launchLocalBrowser();await mkdir('artifacts',{recursive:true});
try{
 for(const value of [false,true]){star=value;const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.setViewport({width:1440,height:1000});await page.goto(origin+(star?'/forge/':'/'));await page.waitForSelector('.member-sidebar .member-square');await page.waitForSelector(star?'#pickCards':'.review-setup');
  if(star){await page.click('[data-tab=review]');await page.waitForSelector('.review-setup');}
  await page.waitForFunction(()=>document.querySelector('#rvHistory')?.textContent?.includes('还没有历史报告'));
  const timings:number[]=[];const d0=documents,r0=reads;
  for(let i=0;i<5;i++){
    let t=performance.now();await page.click('.member-square');await page.waitForSelector('.member-square[aria-current=page]');await page.waitForSelector('#results .empty-state');timings.push(performance.now()-t);
    t=performance.now();await page.click('.member-nav [data-tab=review],.member-nav a[href="'+(star?'/forge/?tab=review':'/')+'"]');await page.waitForSelector('.review-setup');await page.waitForFunction(()=>document.querySelector('#rvHistory')?.textContent?.includes('还没有历史报告'));timings.push(performance.now()-t);
  }
  if(!baseline)assert.equal(documents-d0,0,'Member switches must not reload the document');
  samples.push({role:star?'star':'review',timings,documentLoads:documents-d0,apiReads:reads-r0});
  assert.deepEqual(errors,[]);await page.close();
 }
 assert.equal(mutations,0);console.log(JSON.stringify({fixture:'100ms document/API latency; five review-square round trips; synthetic empty lists',baseline,samples},null,2));
}finally{await browser.close();server.close();}
