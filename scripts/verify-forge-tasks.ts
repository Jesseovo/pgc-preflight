import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {launchLocalBrowser} from '../server/local-browser';

// Exercise the shipped task observer across a lost connection and a new page.
const id='11111111-1111-4111-8111-111111111111';
const topic={id:1,status:'liked',subject:'Light',medium:'Pixel',gesture:'Tap',structure:'Collect',mood:'Calm',data:{title:'Test Lights',logline:'Catch stars.'},score:8,has_preview:0,brief_status:''};
let posts=0,reads=0,interrupted=false,finished=false,started=false;
const svg='<svg viewBox="0 0 540 960"><rect width="540" height="960" fill="#dbe6dc"/></svg>';
const row=()=>({id,kind:'preview',scope:'preview:1',status:finished?'done':'running',detail:'模型正在输出样板图…',result:finished?{id:1,svg}:null});
const server=createServer(async(request,response)=>{
  const url=new URL(request.url!,'http://localhost');
  const json=(value:unknown,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
  if(url.pathname==='/api/forge/state')return json({games:1,vocab:5,fresh_subjects:10,providers:{openai:true},model:'claude-opus-5-5'});
  if(url.pathname==='/api/forge/settings')return json({draw_size:1});
  if(url.pathname==='/api/forge/vocab')return json([]);
  if(url.pathname==='/api/forge/topics')return json([topic]);
  if(url.pathname==='/api/forge/topics/1')return json({...topic,preview_svg:finished?svg:null});
  if(url.pathname==='/api/forge/topics/1/preview'){posts++;started=true;return json({pending:true,jobId:id});}
  if(url.pathname==='/api/forge/generation-jobs')return json(started?[row()]:[]);
  if(url.pathname===`/api/forge/generation-jobs/${id}`){
    reads++;
    if(reads===2){interrupted=true;return json({error:'synthetic network loss'},503);}
    return json(row());
  }
  try{
    const root=resolve('public'),file=resolve(root,`.${url.pathname==='/test'?'/forge/index.html':url.pathname}`);
    if(!file.startsWith(root+sep))throw new Error('path');
    const bytes=await readFile(file);
    response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'image/png');response.end(bytes);
  }catch{response.writeHead(404);response.end();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${(server.address() as any).port}`,browser=await launchLocalBrowser();
try{
  await mkdir('artifacts',{recursive:true});
  const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.setViewport({width:1360,height:960});
  await page.goto(`${origin}/test`);await page.waitForSelector('#drawBtn');
  await page.click('[data-tab="picks"]');await page.waitForSelector('[data-act="preview"]');await page.click('[data-act="preview"]');
  await page.waitForFunction('document.querySelector(".pgc-task-tray")?.textContent.includes("重新连接")');
  assert(interrupted);assert.equal(posts,1);
  await page.reload();await page.waitForSelector(`[data-task-key="generation-${id}"][data-task-state="running"]`);
  assert.equal(posts,1,'Reload must observe, not POST again');
  finished=true;topic.has_preview=1;
  await page.waitForSelector(`[data-task-key="generation-${id}"][data-task-state="done"]`);
  await page.click(`[data-task-key="generation-${id}"] button`);await page.waitForSelector('#regenSvg');
  assert.equal(decodeURIComponent(await page.$eval('#modalBody img.preview',e=>e.getAttribute('src')!)).split(',').slice(1).join(','),svg);
  assert.equal(posts,1);assert.deepEqual(errors,[]);
  await page.screenshot({path:'artifacts/forge-tasks-browser.png',fullPage:true});
  console.log('PASS 样板图后台任务、断线等待、刷新恢复、结果预览；始终只提交一次。');
}finally{await browser.close();server.close();}
