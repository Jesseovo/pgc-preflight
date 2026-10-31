import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {launchLocalBrowser} from '../server/local-browser';
let star=false,mutations=0;
const server=createServer(async(req,res)=>{const url=new URL(req.url!,'http://local');const json=(v:any)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(v));};
 try{
  if(req.method!=='GET')mutations++;
  if(url.pathname==='/api/auth/me')return json({id:star?'star':'review',role:'member',star,canReview:true,displayName:'合成验收成员'});
  if(url.pathname==='/api/square/games')return json({items:[],total:0,page:1,pageSize:12,hasMore:false});
  if(url.pathname==='/api/forge/review/worker-status')return json({devices:[],online:false});
  if(url.pathname==='/api/forge/state')return json({games:0,vocab:0,fresh_subjects:100});
  if(url.pathname==='/api/forge/settings')return json({draw_size:2});
  if(url.pathname.startsWith('/api/forge/'))return json([]);
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  const mapped=url.pathname==='/'?'/review.html':url.pathname==='/square'?'/square.html':url.pathname==='/forge/'?'/forge/index.html':url.pathname;
  const file=resolve('public','.'+mapped);assert(file.startsWith(resolve('public')+sep));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'image/png');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await launchLocalBrowser();await mkdir('artifacts',{recursive:true});
try{
 for(const value of [false,true]){star=value;const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.setViewport({width:1440,height:1000});await page.goto(origin+(star?'/forge/':'/'));await page.waitForSelector('.member-sidebar .member-square');await page.waitForSelector(star?'#pickCards':'.review-setup');
  assert.equal(await page.$('[data-tab=draw]')!==null,star);const rect=await page.$eval('.member-sidebar',el=>el.getBoundingClientRect().width);assert.equal(rect,208);
  await page.click('[data-account-password]');await page.waitForSelector('.member-password[open]');await page.click('[data-close]');await page.waitForFunction(()=>!document.querySelector('.member-password'));assert.equal(await page.$('.member-password'),null);
  await page.screenshot({path:`artifacts/member-shell-${star?'star':'review'}.png`});
  await page.click('.member-square');await page.waitForSelector('#results .empty-state');assert.equal(await page.$eval('.member-square',el=>el.getAttribute('aria-current')),'page');assert.equal(await page.$eval('.member-sidebar',el=>el.getBoundingClientRect().width),rect);
  await page.type('#search','纸间花园');await page.click('#search-form button');await page.waitForFunction(()=>new URL(location.href).searchParams.get('q')==='纸间花园');
  await page.click('.member-nav a[href="'+(star?'/forge/?tab=review':'/')+'"]');await page.waitForSelector('.review-setup');await page.click('.member-square');await page.waitForSelector('#results .empty-state');assert.equal(await page.$eval('#search',el=>(el as HTMLInputElement).value),'纸间花园');
  await page.setViewport({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:`artifacts/member-square-${star?'star':'review'}-mobile.png`,fullPage:true});
  await page.click('.member-nav a[href="'+(star?'/forge/?tab=review':'/')+'"]');await page.waitForSelector('.review-setup');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:`artifacts/member-review-${star?'star':'review'}-mobile.png`,fullPage:true});
  assert.deepEqual(errors,[]);await page.close();
 }
 assert.equal(mutations,0);console.log('PASS 普通成员与 Star 共用导航、广场连续导航与搜索恢复、权限入口、修改密码对话框、两类手机布局；零任务提交。');
}finally{await browser.close();server.close();}
