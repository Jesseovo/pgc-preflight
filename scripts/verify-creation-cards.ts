import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {launchLocalBrowser} from '../server/local-browser';

const game=(v:number)=>`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#eff4e9"><button id="play" onclick="this.textContent='Played ${v}'">Game ${v}</button><script>window.version=${v}</script></body></html>`;
const asset='<!doctype html><html><body style="background:#f8ead9"><h1>Paper Garden</h1><canvas id="asset"></canvas></body></html>';
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" fill="#789575"/></svg>';
const brief='# 通用模板\n## A. 固定要求\n平台通用规则\n\n## F. 本款游戏设计\n### F1. 一句话\n**纸间花园**：收集随风飘落的花瓣。';
const topic:any={id:1,status:'made',subject:'纸间花园',medium:'剪纸',gesture:'拖动',structure:'收集',mood:'安静',data:{title:'Paper Garden',logline:'Catch petals in a tiny paper world.',core_loop:'Catch falling petals',controls:'Drag to move',twist:'Collect petals without touching dark seeds',palette:['#eef1df','#789575','#d5ac71']},score:8,note:'',has_preview:1,has_brief:1,has_assets:1,has_product:1,brief_md:brief,assets_html:asset,preview_svg:svg,brief_status:'',assets_status:'',product_status:'',updated_at:'2026-10-28T04:00:00Z'};
let html=game(1),sequence=0,notesSaved=false,restores=0;
const posts:any[]=[],jobs:any[]=[],versions:any[]=[{id:'game-1',kind:'game',content:html,current:true,disposition:'current'},{id:'brief-1',kind:'brief',content:brief,current:true,disposition:'current'},{id:'asset-1',kind:'assets',content:asset,current:true,disposition:'current'}];
function finish(kind:string){const j=jobs.slice().reverse().find(j=>j.kind===kind)!;assert(j);const v={id:kind+'-'+j.id,kind,content:kind==='game'?game(2):kind==='brief'?brief.replace('纸间花园','全新花园')+'\n### F2. 新美术\n透明纸片与金色花蕊。':svg,current:true,disposition:'current'};versions.filter(v=>v.kind===kind).forEach(v=>{v.current=false;v.disposition='historical';});versions.unshift(v);j.status='done';j.result={id:1,version_id:v.id,disposition:'current'};if(kind==='game'){html=v.content;topic.product_status='';}else if(kind==='brief'){topic.brief_md=v.content;topic.brief_status='';}else topic.preview_svg=v.content;}
const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://localhost'),parts=url.pathname.split('/');
  const json=(v:any,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
  const preview=(content:string)=>{res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'"});res.end(content);};
  try{
    if(url.pathname==='/api/auth/me')return json({id:'fixture-star',role:'member',star:true,canReview:true,displayName:'交互验证'});
    if(url.pathname==='/api/forge/state')return json({games:1,vocab:5});
    if(url.pathname==='/api/forge/settings')return json({draw_size:2});
    if(url.pathname==='/api/forge/vocab')return json([]);
    if(url.pathname==='/api/forge/topics'||url.pathname==='/api/forge/products')return json([topic]);
    if(url.pathname==='/api/forge/generation-jobs')return json(jobs.slice().reverse());
    if(url.pathname.startsWith('/api/forge/generation-jobs/'))return json(jobs.find(j=>j.id===parts[4]));
    if(url.pathname==='/api/forge/topics/1'){
      if(req.method==='PATCH'){let text='';for await(const c of req)text+=c;await new Promise(r=>setTimeout(r,250));topic.note=JSON.parse(text).note;notesSaved=true;}
      return json(topic);
    }
    if(url.pathname==='/api/forge/topics/1/versions')return json(versions.map(({content,...v})=>v));
    if(url.pathname.startsWith('/api/forge/topics/1/versions/')){const v=versions.find(v=>v.id===parts[6]);assert(v);return parts[7]==='preview'?preview(v.content):json(v);}
    if(url.pathname==='/api/forge/topics/1/restore'){let text='';for await(const c of req)text+=c;const v=versions.find(v=>v.id===JSON.parse(text).version_id);assert(v);html=v.content;restores++;return json({ok:true});}
    if(url.pathname==='/api/forge/topics/1/product')return json({html});
    if(url.pathname==='/api/forge/topics/1/product-preview')return preview(html);
    if(url.pathname==='/api/forge/topics/1/assets-preview')return preview(asset);
    if(url.pathname==='/api/forge/topics/1/game'&&req.method==='GET')return json({has_product:true,product_status:topic.product_status});
    if(/^\/api\/forge\/topics\/1\/(game|brief|preview)$/.test(url.pathname)&&req.method==='POST'){
      const kind=parts[5],regenerate=url.searchParams.get('regenerate');assert.equal(regenerate,'1','Existing artifacts must explicitly request a new version');
      if(kind==='game')assert(notesSaved,'Generation must wait for the pending note save');
      posts.push({kind,regenerate,note:topic.note});const id='job-'+(++sequence),job={id,kind,status:'running',detail:'模型正在生成新版本…',scope:`fixture:${kind==='game'?'game':kind}:1`,created_at:new Date().toISOString()};jobs.push(job);if(kind==='game')topic.product_status='running';else if(kind==='brief')topic.brief_status='running';return json({pending:true,jobId:id});
    }
    const root=resolve('public'),file=resolve(root,'.'+(url.pathname==='/test'?'/forge/index.html':url.pathname));if(!file.startsWith(root+sep))throw new Error('path');const bytes=await readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'image/png');res.end(bytes);
  }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(error as Error).message}));}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await launchLocalBrowser();await mkdir('artifacts',{recursive:true});
try{
  const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));await page.setViewport({width:1360,height:980});
  await page.goto(origin+'/test');await page.waitForSelector('#drawBtn');await page.click('[data-tab=picks]');await page.waitForSelector('.creation-card');
  assert.equal(await page.$$eval('.creation-main-actions .primary',els=>els.length),1);assert.equal(await page.$$eval('.creation-materials .material-link',els=>els.length),3);
  await page.screenshot({path:'artifacts/creation-cards-desktop.png',fullPage:true});
  await page.click('[data-act=brief]');await page.waitForSelector('.brief-document');assert.match(await page.$eval('.brief-document',el=>el.textContent!),/纸间花园/);assert.equal(await page.$('#modalBody > pre'),null);assert.equal(await page.$eval('.brief-contract',el=>(el as HTMLDetailsElement).open),false);
  await page.screenshot({path:'artifacts/creation-brief-readable.png',fullPage:true});await page.click('#regenBrief');await page.waitForSelector('#briefProgress');assert.equal(posts.length,1);await page.click('#modalClose');await page.click('[data-act=brief]');assert.equal(posts.length,1);finish('brief');await page.waitForFunction('document.querySelector(".brief-document")?.textContent.includes("全新花园")');
  await page.click('#modalClose');await page.click('[data-act=preview]');await page.waitForSelector('#regenSvg');assert((await page.$eval('#modalBody img',el=>el.getAttribute('src')))?.startsWith('data:image/svg+xml'));await page.click('#regenSvg');await page.waitForSelector('#previewProgress');finish('preview');await page.waitForSelector('#regenSvg');assert.equal(posts.filter(p=>p.kind==='preview').length,1);
  await page.click('#modalClose');await page.click('[data-act=assets]');await page.waitForSelector('.assets-frame');const assets=await (await page.$('.assets-frame'))!.contentFrame();await assets!.waitForSelector('#asset');assert.equal(await assets!.evaluate('typeof parent.document').catch(()=> 'blocked'),'blocked');
  await page.click('#modalClose');await page.click('[data-act=versions]');await page.waitForSelector('[data-version=game-1]');await page.click('[data-version=game-1]');await page.waitForSelector('iframe.product-frame');const historic=await (await page.$('iframe.product-frame'))!.contentFrame();await historic!.waitForSelector('#play');await historic!.click('#play');assert.equal(await historic!.$eval('#play',el=>el.textContent),'Played 1');assert.equal(await page.$('#modalBody pre'),null);await page.screenshot({path:'artifacts/creation-history-playable.png',fullPage:true});assert.equal(posts.filter(p=>p.kind==='game').length,0);
  await page.click('#modalClose');await page.click('.creation-note input');await page.type('.creation-note input','增加花瓣的飘动反馈');await page.click('.creation-more summary');await page.click('[data-act=regenerateGame]');await page.waitForSelector('#productProgress');await page.waitForFunction('document.querySelector("#productProgress").textContent.includes("新版本")');assert.equal(posts.filter(p=>p.kind==='game').length,1);assert.equal(posts.at(-1).note,'增加花瓣的飘动反馈');
  await page.click('#modalClose');await page.click('[data-act=viewProduct]');await page.waitForSelector('#regenerateProduct:disabled');const old=await (await page.$('iframe.product-frame'))!.contentFrame();await old!.waitForSelector('#play');assert.equal(await old!.$eval('#play',el=>el.textContent),'Game 1');
  await page.click('#modalClose');await page.reload();await page.waitForSelector('#drawBtn');await page.click('[data-tab=products]');await page.waitForSelector('[data-act=viewProduct]');await page.waitForSelector('[data-task-key=product-1]');assert.equal(posts.filter(p=>p.kind==='game').length,1);finish('game');await page.waitForSelector('[data-task-key=product-1][data-task-state=done]');assert.equal(await page.$eval('#modal',el=>(el as HTMLElement).hidden),true);
  await page.click('[data-act=viewProduct]');const fresh=await (await page.waitForSelector('iframe.product-frame'))!.contentFrame();await fresh!.waitForSelector('#play');assert.equal(await fresh!.$eval('#play',el=>el.textContent),'Game 2');await page.click('#modalClose');
  await page.click('[data-act=versions]');await page.waitForSelector('[data-version=game-1]');await page.click('[data-version=game-1]');await page.waitForSelector('#restoreVersion:not(:disabled)');await page.click('#restoreVersion');await page.waitForFunction('document.querySelector("#modal").hidden');assert.equal(restores,1);assert.equal(posts.filter(p=>p.kind==='game').length,1,'Restoring never calls a model');
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.waitForSelector('#drawBtn');await page.click('[data-tab=picks]');await page.waitForSelector('.creation-card');assert(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));await page.screenshot({path:'artifacts/creation-cards-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  console.log('PASS 卡片主次操作、材料真实预览、简报正文、三种重新生成、制作要求先保存、旧成品保留、刷新去重、历史试玩和恢复、手机布局。');
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
