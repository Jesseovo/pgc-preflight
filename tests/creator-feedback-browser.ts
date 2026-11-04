// Standalone Chromium UI check: node --import tsx tests/creator-feedback-browser.ts
// Entire backend and all source content are synthetic and loopback-only.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {reviewReportErrors} from '../server/review-report';
import {launchLocalBrowser} from '../server/local-browser';
const source='<img src=x onerror="window.__sourceExecuted=true"><script>window.__sourceExecuted=true</script>';
const aiReport={schema_version:2,assessment_status:'complete',aes:3,ease:2,play:2,verdict:'通过（7/9）',reviewer_comment:'合成审核意见：核心操作清晰，持续体验待补测。\n'+source,score_reasons:{aes:'合成美学理由：主体与背景对比清楚。',ease:'合成易玩性理由：首次操作提示可读。',play:'合成可玩性理由：短时观察支持基础循环。'},uncertainties:['合成：尚未验证长期节奏。'],strengths:['合成：主要目标清楚。'],issues:[{kind:'unverified',severity:'低',area:'操作',problem:'合成：长按响应尚待验证。',evidence:'合成证据：只执行过短触摸。',evidence_refs:[],fix:'合成验证方法：补测一次持续长按并记录响应。'}],optional_suggestions:['合成可选建议：优化操作提示的对比度。'],fix_prompt:'合成：当前没有已证实的强制修改。'};
assert.deepEqual(reviewReportErrors(aiReport,{schemaVersion:2}),[]);
const mutations:{path:string;body:any}[]=[];const unexpected:string[]=[];
let declaration:any=null,file:any=null;
const detail=()=>({jobId:'synthetic-job',title:'合成游戏反馈闭环',generation:1,complete:true,matchedBy:'published-record',versionId:'version_synthetic',workId:'game_synthetic',inputHash:'a'.repeat(64),version:{ruleVersion:null},aiRules:null,
 ai:{score:7,model:'synthetic-agent',decision:'approved',dimensions:{aes:3,ease:2,play:2},report:aiReport},platform:{state:'valid',decision:'rejected',reviewId:'review_synthetic',reviewerRole:'leader',reasons:[]},comparison:{state:'different',scoreDifferences:[{name:'美学',ai:3,platform:0,delta:3},{name:'易玩性',ai:2,platform:null,delta:null}]},
 reviews:[{id:'review_synthetic',stage:'decision_review',revision:1,decision:'rejected',effective:true,deleted:false,revoked:false,reopened:false,total:null,scores:[{name:'美学',score:0,max:3}],feedback:source}],reviewHistory:[],assessment:{status:declaration?.status||'unverified',strictEligible:false,gaps:['缺少来源文件绑定与规则证明。'],latestDeclaration:declaration?{declaration}:null,files:file?[{file,createdAt:'2026-11-04T01:00:00Z'}]:[],history:[]}});
const bundle=await build({entryPoints:['src/admin.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',outdir:'synthetic-feedback-bundle',loader:{'.png':'dataurl'}});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.contents,css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))!.contents;
const server=createServer(async(req,res)=>{
 const url=new URL(req.url||'/','http://loopback');const json=(v:any,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
 if(url.pathname==='/admin'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="app"></div><script type="module" src="/bundle.js"></script>');return;}
 if(url.pathname==='/bundle.js'||url.pathname==='/bundle.css'){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');res.end(url.pathname.endsWith('.js')?js:css);return;}
 if(['/forge/progress.js','/forge/progress.css','/forge/experience.css','/artwork/pixel-cat.png'].includes(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'image/png');res.end(await readFile(resolve('public'+url.pathname)));return;}
 if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(url.pathname==='/api/auth/me')return json({role:'admin'});
 if(url.pathname==='/api/admin/review-metrics')return json({accuracy:{status:'not_measured'},latency:[]});
 if(url.pathname==='/api/admin/creator-feedback/status')return json({enabled:true,configured:true,status:'ready',phase:'delta',complete:true});
 if(url.pathname==='/api/admin/creator-feedback/links')return json({items:[{jobId:'synthetic-job',versionId:'version_synthetic',ownerName:'合成成员',title:'合成游戏',verificationStatus:declaration?.status||'unverified',measuredFiles:file?1:0}],nextAfter:null});
 if(url.pathname==='/api/admin/creator-feedback/job'||url.pathname==='/api/admin/creator-feedback/export')return json(detail());
 if(req.method==='POST'){
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);const body=req.headers['content-type']==='application/octet-stream'?{bytes:bytes.length,sha256:'a'.repeat(64),inputHashMatches:true,sourceBindingVerified:false}:JSON.parse(bytes.toString());mutations.push({path:url.pathname,body});
  if(url.pathname.endsWith('/assessment'))declaration=body;if(url.pathname.endsWith('/file-evidence'))file=body;return json({saved:true,scheduled:true});
 }
 unexpected.push(url.pathname);json({error:'Unexpected synthetic request'},404);
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as any,origin='http://127.0.0.1:'+address.port;
let browser:Awaited<ReturnType<typeof launchLocalBrowser>>|undefined;
try{
 browser=await launchLocalBrowser();const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.setRequestInterception(true);page.on('request',r=>{if(r.url().startsWith(origin+'/')||r.url().startsWith('data:'))void r.continue();else{unexpected.push('external request');void r.abort();}});
 await page.setViewport({width:1360,height:960});await page.goto(origin+'/admin?view=feedback',{waitUntil:'networkidle0'});await page.waitForSelector('[data-feedback-job]');
 assert.equal(await page.$eval('#tab-feedback',el=>el.textContent?.trim()),'反馈闭环');await page.click('[data-feedback-job]');await page.waitForSelector('[data-feedback-assessment]');
 assert.equal(await page.evaluate(()=>Boolean((window as any).__sourceExecuted)),false);assert.equal(await page.$eval('[data-feedback-detail]',el=>!!el.querySelector('img,script,iframe')),false);
 assert.match(await page.$eval('[data-feedback-detail]',el=>el.textContent||''),/存在差异/);assert.match(await page.$eval('[data-feedback-detail]',el=>el.textContent||''),/组长/);
 assert.equal(await page.$eval('.feedback-ai-raw',el=>(el as HTMLDetailsElement).open),false);assert.equal(await page.$eval('.feedback-source-raw',el=>(el as HTMLDetailsElement).open),false);
 const visible=await page.$eval('[data-feedback-detail]',el=>(el as HTMLElement).innerText);
 for(const text of ['审核意见','三维评分理由','合成美学理由','合成易玩性理由','合成可玩性理由','待验证','合成证据','合成验证方法','合成可选建议','审核决定','当前有效'])assert.ok(visible.includes(text),text);
 assert.ok(!visible.includes('deleted=false'));assert.ok(!visible.includes('decision_review'));assert.ok(!visible.includes('"schema_version"'));
 await page.click('.feedback-ai-raw > summary');assert.equal(await page.$eval('.feedback-ai-raw',el=>(el as HTMLDetailsElement).open),true);assert.deepEqual(JSON.parse(await page.$eval('.feedback-ai-raw pre',el=>el.textContent||'')),aiReport);await page.click('.feedback-ai-raw > summary');
 await page.click('.feedback-source-raw > summary');const raw=JSON.parse(await page.$eval('.feedback-source-raw pre',el=>el.textContent||''));assert.equal(raw.stage,'decision_review');assert.equal(raw.deleted,false);assert.equal(raw.feedback,source);await page.click('.feedback-source-raw > summary');

 await page.select('[data-feedback-assessment] [name=status]','declared');await page.type('[data-feedback-assessment] [name=note]','合成管理员依据，尚无来源文件证明');await page.click('[data-feedback-assessment] button');
 await page.waitForFunction(()=>document.querySelector('.feedback-result')?.textContent?.includes('核验：管理员已声明'));assert.equal(mutations.filter(m=>m.path.endsWith('/assessment')).length,1);assert.equal(mutations.find(m=>m.path.endsWith('/assessment'))!.body.generation,1);
 await page.evaluate(()=>{const input=document.querySelector<HTMLInputElement>('[data-feedback-file] input')!;const d=new DataTransfer();d.items.add(new File(['<script>window.__sourceExecuted=true</script>'],'synthetic.html',{type:'text/html'}));input.files=d.files;});await page.click('[data-feedback-file] button');await page.waitForFunction(()=>document.querySelector('.feedback-measured')?.textContent?.includes('与 PGC 输入一致'));
 assert.equal(mutations.filter(m=>m.path.endsWith('/file-evidence')).length,1);assert.equal(await page.evaluate(()=>Boolean((window as any).__sourceExecuted)),false);
 await page.setViewport({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await mkdir('artifacts/creator-feedback-ui',{recursive:true});await page.screenshot({path:'artifacts/creator-feedback-ui/mobile.png',fullPage:true});await page.setViewport({width:1360,height:960});await page.screenshot({path:'artifacts/creator-feedback-ui/desktop.png',fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(JSON.stringify({passed:true,checks:['standalone navigation','exact version detail','escaped source','readable full-schema AI report','collapsed original JSON retained','readable source statuses','leader rejection','declaration submission','measured file submission','mobile width','zero page errors','zero external requests']}));
}finally{await browser?.close();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
