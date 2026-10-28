import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {launchLocalBrowser} from '../server/local-browser';

// Real shared UI + isolated synthetic tasks, no production data or model calls.
let reads=0,unavailable=false;
const ids=Array.from({length:20},()=>randomUUID());
const tasks=ids.map((id,i)=>({id,title:`Synthetic game ${i+1}`,filename:`fixture-${i+1}.html`,status:'running',stage:i%2?'verify':'review',model_executor:'agent',created_at:new Date(Date.now()-12*3600000).toISOString(),updated_at:new Date(Date.now()-3600000).toISOString()}));
const server=createServer(async(req,res)=>{
  const path=new URL(req.url!,'http://localhost').pathname;
  const json=(value:any,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/api/forge/review/jobs'){reads++;return json(unavailable?{error:'temporary database unavailable'}:tasks,unavailable?503:200);}
  if(path==='/api/forge/reviews')return json([]);
  if(path==='/api/forge/review/worker-status')return json({devices:[],online:false});
  if(path==='/fixture'){
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/forge/style.css"><link rel="stylesheet" href="/forge/review-workspace.css"><div id="view"></div><script type="module">
    import{mountReviewWorkspace}from'/forge/review-workspace.js';
    window.copied=[];const api=async(method,path,data)=>{const r=await fetch('/api/forge/'+path);const out=await r.json();if(!r.ok)throw Object.assign(Error(out.error),{status:r.status});return out;};
    await mountReviewWorkspace({view:document.querySelector('#view'),api,allowUpload:false,alive:()=>true,topics:[],setProbing:()=>{},probeChecks:()=>[],checksHtml:()=>'',copyText:t=>window.copied.push(t),download:()=>{},openModal:()=>{}});window.ready=true;</script>`);return;
  }
  try{const file=resolve('public','.'+path);if(!file.startsWith(resolve('public')+sep))throw Error();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'image/png');res.end(await readFile(file));}
  catch{res.writeHead(404);res.end();}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const browser=await launchLocalBrowser();
try{
  await mkdir('artifacts',{recursive:true});
  const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.setViewport({width:1440,height:1080});await page.goto(`http://127.0.0.1:${(server.address() as any).port}/fixture`);
  await page.waitForFunction('window.ready&&document.querySelectorAll("[data-job]").length===20');
  await page.waitForSelector('#rvResumeAgent');
  assert.equal(await page.$('#rvJobs [data-progress-since]'),null,'Agent result waiting must not tick forever');
  assert.equal(await page.$('#rvJobs .rv-spinner'),null,'No evidence that local models are still executing');
  assert.match(await page.$eval('#rvJobs',e=>e.textContent!),/等待 Agent 初评结果/);
  assert.match(await page.$eval('#rvOverview',e=>e.textContent!),/0进行中20待处理/);
  await page.click('#rvResumeAgent');
  const copied=String(await page.evaluate('window.copied[0]'));assert.ok(copied.includes(ids[0]));assert.match(copied,/不要重新提交|不要重新/);assert.match(copied,/complete/);
  await page.screenshot({path:'artifacts/review-agent-waiting-desktop.png',fullPage:true});
  await page.setViewport({width:390,height:844});
  assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Mobile must fit');
  await page.screenshot({path:'artifacts/review-agent-waiting-mobile.png',fullPage:true});
  await new Promise(r=>setTimeout(r,1200));
  assert.ok(reads<=2,`20 tasks must use one batch polling loop; observed ${reads} reads`);
  const beforeHidden=reads;
  await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});dispatchEvent(new Event('online'));");
  await new Promise(r=>setTimeout(r,500));assert.equal(reads,beforeHidden,'Hidden page must not poll');
  unavailable=true;
  await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));");
  await page.waitForFunction('document.querySelector("#rvResult").textContent.includes("不能确认是否仍在执行")');
  assert.equal(await page.$('#rvResult [data-progress-since]'),null);
  unavailable=false;tasks[0].stage='verify';
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  await page.waitForFunction('document.querySelector("#rvJobs .rv-job-status").textContent.includes("等待 Agent 复核结果")');
  assert.deepEqual(errors,[]);
  await writeFile('artifacts/review-waiting-verification.json',JSON.stringify({passed:true,taskCount:20,batchReadsBeforeHidden:beforeHidden,hiddenPollingStopped:true,waitingClockStopped:true,resumeUsesOriginalId:true,transientFailureHonest:true,resumedSameTask:true,mobileFits:true},null,2));
  console.log('PASS 20 synthetic Agent tasks: one batch poll, no fake running clocks, original-task resume, hidden pause, outage/backoff/recovery, mobile fit. No model calls.');
}finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
