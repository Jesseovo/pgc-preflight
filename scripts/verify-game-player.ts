import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {launchLocalBrowser} from '../server/local-browser';

const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#eaf1e8}button{width:100%;height:50vh}</style></head><body><button id="play" onclick="this.textContent=\'Played\'">Play</button><script>window.started=true</script></body></html>';
const topic={id:1,owner_id:'fixture-star',status:'made',subject:'纸间花园',medium:'剪纸',gesture:'点击',structure:'收集',mood:'轻快',data:{title:'Paper Garden',controls:'Tap',logline:'Catch petals'},has_product:1,product_status:'',has_brief:1,brief_md:'## F. 本款设计\n纸间花园',updated_at:'2026-10-28T04:00:00Z'};
const versions=[{id:'old-game',kind:'game',content:html,current:false,executor:'platform',created_at:'2026-10-28'}];
let loads=0,modelCalls=0;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url!,'http://fixture');const json=(v:any)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(v));};
 try{
  if(req.method==='POST')modelCalls++;
  if(url.pathname==='/api/auth/me')return json({id:'fixture-star',role:'member',star:true,canReview:false,displayName:'合成成员'});
  if(url.pathname==='/api/admin/config')return json({activeProfile:'deepseek',profiles:{deepseek:{name:'Synthetic model',baseUrl:'https://fixture.invalid',model:'deepseek-flash',protocol:'openai',enabled:true,hasKey:true}},routes:{},effective:{}});
  if(url.pathname==='/api/admin/workspace')return json({topics:[topic],products:[topic],games:[],tasks:[],agents:[],members:[{id:'fixture-star',displayName:'合成成员'}],suggestions:[],reviewJobs:[],reviews:[]});
  if(url.pathname==='/api/admin/members')return json([]);
  if(url.pathname==='/api/admin/review-workers')return json({online:0,devices:[]});
  if(url.pathname==='/api/admin/public-data')return json({settings:{},vocab:[],games:[]});
  if(url.pathname==='/api/forge/state')return json({games:0,vocab:5});
  if(url.pathname==='/api/forge/settings')return json({draw_size:1});
  if(url.pathname==='/api/forge/vocab'||url.pathname==='/api/forge/generation-jobs')return json([]);
  if(url.pathname==='/api/forge/products'||url.pathname==='/api/forge/topics')return json([topic]);
  if(url.pathname==='/api/forge/topics/1/product')return json({html});
  if(url.pathname==='/api/forge/topics/1')return json({...topic,product_html:html});
  if(url.pathname==='/api/forge/topics/1/versions')return json(versions);
  if(url.pathname==='/api/forge/topics/1/versions/old-game')return json(versions[0]);
  if(url.pathname.endsWith('/product-preview')||url.pathname.endsWith('/old-game/preview')){loads++;res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"});return res.end(html);}
  const root=resolve(url.pathname.startsWith('/forge/')||url.pathname==='/test'?'public':'dist');const path=url.pathname==='/admin'?'/index.html':url.pathname==='/test'?'/forge/index.html':url.pathname;const file=resolve(root,'.'+path);assert(file.startsWith(root+sep));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'image/png');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`,browser=await launchLocalBrowser();await mkdir('artifacts',{recursive:true});
async function verifyPlayer(page:any,selector:string){
 const iframe=await page.waitForSelector(selector,{visible:true}),stage=await iframe.evaluateHandle((el:any)=>el.closest('.game-player-stage')),box=await stage.boundingBox();assert(box);assert(Math.abs(box.width/box.height-9/16)<.002,'Player stage must remain 9:16');
 const frame=await iframe.contentFrame();await frame.waitForSelector('#play');await frame.click('#play');assert.equal(await frame.$eval('#play',(el:any)=>el.textContent),'Played');assert.equal(await frame.evaluate('typeof parent.document').catch(()=> 'blocked'),'blocked');assert.equal(await iframe.evaluate((el:any)=>el.getAttribute('sandbox')),'allow-scripts');
 return box;
}
try{
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>{errors.push(String(e));console.log('Browser error:',String(e));});page.on('response',r=>{if(r.status()>=400)console.log('HTTP',r.status(),new URL(r.url()).pathname);});await page.setViewport({width:1360,height:960});// The redesigned admin is covered against real APIs in verify-admin-dashboard.ts.
 for(const [width,height] of [[1360,960],[390,844],[390,693],[844,390]]){
  await page.setViewport({width,height,isMobile:width<1000,hasTouch:width<1000});await page.goto(origin+'/test');await page.waitForSelector('#drawBtn');await page.click('[data-tab=products]');await page.waitForSelector('[data-id="1"] [data-act=viewProduct]');await page.click('[data-id="1"] [data-act=viewProduct]');
  const player='[data-id="1"] .game-player iframe.product-frame';
  const box=await verifyPlayer(page,player);assert(box.width<=width);assert(box.height<=height);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  if(width===1360){await page.click('[data-id="1"] .game-player [data-player-fullscreen]');await page.waitForFunction(()=>!!document.fullscreenElement);await verifyPlayer(page,player);await page.evaluate(()=>document.exitFullscreen());}
  await page.click('[data-id="1"] [data-viewer-act=close]');assert.equal(await page.$(player),null,'Member close must stop game scripts and remove the iframe');
 }
 assert.equal(modelCalls,0,'Preview must never generate again');assert.deepEqual(errors,[]);console.log('PASS 成员试玩、9:16 多屏适配、触摸、全屏、关闭销毁、隔离和零模型调用。');
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
