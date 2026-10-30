import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { launchLocalBrowser } from '../server/local-browser';

// Exercise the shipped UI with controlled jobs; no real games or model keys.
const topic = {id:1,status:'liked',subject:'Light',medium:'Pixel',gesture:'Tap',structure:'Collect',mood:'Calm',data:{title:'Pocket Lights',logline:'Catch falling stars.'},score:8,has_product:0,product_status:'',product_error:'',brief_status:''};
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#eaf1e8"><button id="play" onclick="this.textContent=\'Score: 1\'">Play</button></body></html>';
let requests = 0, statusReads = 0, offline = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  const json = (data: unknown, status=200) => { response.writeHead(status, {'Content-Type':'application/json'}); response.end(JSON.stringify(data)); };
  if(url.pathname==='/api/auth/me')return json({id:'fixture-star',role:'member',star:true,canReview:true,displayName:'合成成员'});
  if(url.pathname==='/api/forge/generation-jobs')return json([]);
  if (url.pathname === '/api/forge/state') return json({games:1,vocab:5,fresh_subjects:10,providers:{openai:true},provider:'openai',model:'claude-opus-5-5'});
  if (url.pathname === '/api/forge/settings') return json({draw_size:2});
  if (url.pathname === '/api/forge/vocab') return json([]);
  if (url.pathname === '/api/forge/topics') return json([topic]);
  if (url.pathname === '/api/forge/products') return json(topic.product_status || topic.has_product ? [topic] : []);
  if (url.pathname === '/api/forge/topics/1/game') {
    if (request.method === 'POST') { requests++; topic.product_status='queued'; topic.product_error='等待后台制作队列…'; return json({id:1,status:'pending'}); }
    statusReads++; if (offline) { offline=false; return json({error:'fixture interruption'},503); }
    return json({id:1,product_status:topic.product_status,product_error:topic.product_error,has_product:Boolean(topic.has_product)});
  }
  if (url.pathname === '/api/forge/topics/1/product') return json({id:1,html});
  if (url.pathname === '/api/forge/topics/1/product-file') { response.writeHead(200,{'Content-Type':'text/html','Content-Disposition':'attachment; filename="game.html"'}); return response.end(html); }
  if (url.pathname === '/api/forge/topics/1/product-preview') { response.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"}); return response.end(html); }
  try {
    const root=resolve('public');
    const file=resolve(root, `.${url.pathname === '/test' ? '/forge/index.html' : url.pathname}`);
    if (!file.startsWith(root+sep)) throw new Error('path');
    const bytes=await readFile(file);
    response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'image/png');
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await launchLocalBrowser();
await mkdir('artifacts',{recursive:true});
try {
  const page=await browser.newPage(); const errors:string[]=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.setViewport({width:1360,height:960});
  await page.goto(`${origin}/test?tab=draw&layout=cards`); await page.waitForSelector('#drawBtn');
  await page.click('[data-tab="picks"]'); await page.waitForSelector('[data-act="makeGame"]');
  await page.click('[data-act="makeGame"]'); await page.waitForSelector('.creation-job-progress [role="progressbar"]');
  await page.waitForFunction('document.querySelector(".creation-job-progress").textContent.includes("后台已接收")');
  assert.equal(requests,1);
  assert.equal(await page.$eval('.creation-job-progress [role="progressbar"]',el=>el.hasAttribute('aria-valuenow')),false);
  assert.equal(await page.$eval('#modal',el=>(el as HTMLElement).hidden),true);
  assert.equal(await page.$eval('[data-act="makeGame"]',el=>(el as HTMLButtonElement).disabled),true);assert.equal(requests,1);
  await page.click('[data-tab="products"]'); await page.waitForSelector('#productCards [data-act="resumeProduct"]');
  await page.screenshot({path:'artifacts/products-pending.png',fullPage:true});
  // New browser document must resume the same persisted job without POST.
  await page.reload(); await page.waitForSelector('#productCards .product-job-progress');
  assert.equal(requests,1); offline=true;
  await page.waitForFunction('document.querySelector(".product-job-progress").textContent.includes("重新连接")');
  topic.product_status='running'; topic.product_error='Opus 正在编写完整 HTML 游戏…';
  await page.waitForFunction('document.querySelector(".product-job-progress").textContent.includes("编写完整")');
  topic.product_status='';topic.product_error='';topic.has_product=1;topic.status='made';
  await page.waitForSelector('[data-act="viewProduct"]');
  assert.equal(await page.$eval('#modal',el=>(el as HTMLElement).hidden),true);
  await page.click('[data-act="viewProduct"]'); await page.waitForSelector('iframe.product-frame');
  const frameHandle=await page.$('iframe.product-frame'); const frame=await frameHandle!.contentFrame();
  await frame!.waitForSelector('#play'); await frame!.click('#play');
  assert.equal(await frame!.$eval('#play',el=>el.textContent),'Score: 1');
  assert.equal(await page.$eval('iframe.product-frame',el=>el.getAttribute('sandbox')),'allow-scripts');
  assert.equal(await frame!.evaluate('typeof parent.document').catch(()=> 'blocked'),'blocked');
  const downloaded=await fetch(`${origin}/api/forge/topics/1/product-file`);
  assert.match(downloaded.headers.get('Content-Disposition')!,/attachment/); assert.equal(await downloaded.text(),html);
  await page.screenshot({path:'artifacts/products-complete.png',fullPage:true});
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.waitForSelector('[data-act="viewProduct"]');
  // Changing mobile emulation reloads Chromium's document.
  await page.click('[data-act="viewProduct"]');
  await page.waitForSelector('iframe.product-frame');
  assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'Mobile page must not overflow');
  await page.screenshot({path:'artifacts/products-mobile.png',fullPage:true});
  await page.click('[data-viewer-act="close"]');assert.equal(await page.$('iframe.product-frame'),null);
  topic.has_product=0;topic.status='liked';topic.product_status='error';topic.product_error='合成模型错误，请重试';
  await page.reload();await page.waitForSelector('#productCards');
  await page.waitForSelector('[data-act="retryProduct"]'); await page.click('[data-act="retryProduct"]');
  await page.waitForFunction('document.querySelector(".product-job-progress").textContent.includes("后台已接收")');
  assert.equal(requests,2);topic.product_status='error';topic.product_error='合成模型错误，请重试';
  await page.waitForSelector('#productCards .bad.small');
  assert.equal(errors.length,0,errors.join('\n'));assert(statusReads>=4);
  console.log('PASS 开始制作一次提交、阶段进度、跨栏目/刷新恢复、断线重连、完成不抢焦点、隔离试玩、下载、失败重试和手机布局。');
} finally {await browser.close();server.close();}
