import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdir,writeFile,rm,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {reviewDeviceApi} from '../server/review-device-api';
import {digest} from '../server/review-device-state';
import {reviewUsage} from '../server/review-usage';

// Real shipped bundle, persisted credentials, real isolated Chromium evidence,
// migrated DB and local two-stage report protocol. Model output is scripted;
// this checks transport/evidence only, not actual model judgment.
const sqlite=new DatabaseSync(':memory:');
for(const file of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(await readFile('migrations/'+file,'utf8'));
const DB:any={prepare(sql:string){let values:any[]=[];const stmt:any={bind(...v:any[]){values=v;return stmt;},first:async()=>sqlite.prepare(sql).get(...values)||null,all:async()=>({results:sqlite.prepare(sql).all(...values)}),run:async()=>{const r=sqlite.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>sqlite.prepare(sql).run(...values)};return stmt;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const r=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
sqlite.exec("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at) VALUES('fixture','fixture','Fixture','unused','unused','now','now')");
let calls=0,env:any;
const report={aes:2,ease:2,play:2,verdict:'建议修改',reviewer_comment:'合成接口报告，用于验证接入流程。',score_reasons:{aes:'合成依据',ease:'合成依据',play:'合成依据'},uncertainties:['手感保留人工审核'],strengths:['合成亮点'],issues:[],fix_prompt:'合成修改建议'};
const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  try{
    if(req.url==='/chat/completions'){
      calls++;const b=JSON.parse(body);assert.equal(b.model,'deepseek-flash');assert.equal(b.max_tokens,24000);
      assert.equal(b.messages[1].content.filter((p:any)=>p.type==='image_url').length,4);
      assert.match(JSON.stringify(b.messages),/AGENT_FIXTURE/);
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(report)},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);return;
    }
    const result=await reviewDeviceApi(new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers as any,body}),env);
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());
  }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${(server.address() as any).port}`;
env={DB,SETTINGS_KEY:'fixture-secret',ADMIN_PASSWORD:'fixture-admin',modelStore:{get:async()=>{throw new Error('Local review must not read platform model configuration');}},REVIEW_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:async()=>{throw new Error('Local review must not schedule platform execution');}})}};
await mkdir('artifacts',{recursive:true});
const root=await mkdtemp(resolve('artifacts/agent-verify-'));
const cli=async(args:string[],extra:Record<string,string>={},stdin='')=>new Promise<any[]>((done,reject)=>{
  const child=spawn(process.execPath,[resolve('public/agent/review-agent.mjs'),...args],{env:{...process.env,PGC_ORIGIN:origin,PGC_AGENT_DATA:join(root,'account'),...extra},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.on('error',reject);child.on('close',code=>code===0?done(stdout.trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))):reject(new Error(`CLI failed ${code}: ${stderr}\n${stdout}`)));
  child.stdin.on('error',()=>{});child.stdin.end(stdin);
});
try{
  const code='a'.repeat(40);sqlite.prepare('INSERT INTO review_pairings VALUES(?,?,?, ?,NULL)').run(await digest(code),'fixture','1',new Date(Date.now()+300000).toISOString());
  assert.equal((await cli(['pair'],{},code))[0].event,'paired');
  const credential=await readFile(join(root,'account','credential.json'),'utf8');if(process.platform==='win32')assert.match(credential,/dpapi/);
  const a=join(root,'a.html'),b=join(root,'b.html');
  for(const path of [a,b])await writeFile(path,'<!doctype html><html><title>AGENT_FIXTURE</title><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#d7e7d9"><h1>AGENT_FIXTURE</h1><button onclick="this.textContent=\'touched\'">Start</button><canvas width="360" height="200"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#55795d";c.fillRect(30,30,140,100);</script></body></html>');
  const humanPath=join(root,'human.json'),source='https://creator-hub-7mi.pages.dev';
  const human={workId:'fixture-work',versionId:'fixture-version',score:null,feedback:null,updatedAt:'2026-10-27T08:00:00.000Z',source,status:'pending',phase:null,matchedBy:'published-record',uploadedContentHash:createHash('sha256').update(await readFile(a)).digest('hex')};
  await writeFile(humanPath,JSON.stringify(human));
  const submitted=await cli(['submit',a,'--human-review',humanPath]);
  assert.equal(submitted.find(e=>e.event==='human-review').human_review.status,'pending');
  const result=await cli(['review',a,b,'--out',join(root,'reports')]);
  const ids=result.filter(e=>e.event==='submitted').map(e=>e.job.id);assert.equal(ids.length,2);
  const materials=result.filter(e=>e.event==='material');assert.equal(materials.length,1);
  const remaining=result.find(e=>e.event==='remaining');assert.deepEqual(remaining.remaining,[ids[1]]);assert.deepEqual(remaining.continueCommands,[['continue',ids[1]]]);
  assert.equal(sqlite.prepare('SELECT status FROM review_jobs WHERE id=?').get(ids[1])!.status,'queued');
  assert.equal(sqlite.prepare('SELECT evidence_ready FROM review_jobs WHERE id=?').get(ids[1])!.evidence_ready,0);
  for(let index=0;index<ids.length;index++){
    const material=index===0?materials[0]:(await cli(['continue',ids[index],'--out',join(root,'reports')])).find(e=>e.event==='material');
    assert.equal(material.jobId,ids[index]);
    const data=JSON.parse(await readFile(material.materialPath,'utf8'));
    assert.match(JSON.stringify(data),/AGENT_FIXTURE/);assert.equal(material.screenshots.length,4);
    for(const shot of material.screenshots)assert.ok((await readFile(shot.path)).length>1000);
    const draftPath=join(root,`${material.jobId}-draft.json`),verifiedPath=join(root,`${material.jobId}-verified.json`);
    const draft={model:'scripted-agent-fixture',modelConfiguration:{effort:'scripted-none'},evidenceHash:data.evidenceHash,report};
    await writeFile(draftPath,JSON.stringify(draft));
    const drafted=(await cli(['draft',material.jobId,'--json',draftPath])).find(e=>e.event==='draft');
    const verification=(await cli(['material',material.jobId,'--out',join(root,'verification')])).find(e=>e.event==='material');
    const verifiedMaterial=JSON.parse(await readFile(verification.materialPath,'utf8'));
    assert.equal(verifiedMaterial.draftHash,drafted.draftHash);assert.equal(verifiedMaterial.stage,'verify');assert.equal(verifiedMaterial.mode,'delta');assert.deepEqual(verifiedMaterial.modelConfiguration,draft.modelConfiguration);
    assert.match(verifiedMaterial.draftBoundary,/不是标准答案/);assert.match(verifiedMaterial.instruction,/不可信/);assert.match(verifiedMaterial.instruction,/指令不生效/);
    assert.ok(verifiedMaterial.materialReference);assert.equal(verifiedMaterial.user,undefined);
    const original=JSON.parse(await readFile(verifiedMaterial.materialReference,'utf8'));
    assert.equal(original.evidenceHash,data.evidenceHash);assert.equal(original.materialHash,data.materialHash);assert.equal(original.system,data.system);assert.deepEqual(original.schema,data.schema);
    assert.deepEqual(original.user,data.user);assert.deepEqual(verification.screenshots,material.screenshots);
    for(const shot of verification.screenshots)assert.equal(createHash('sha256').update(await readFile(shot.path)).digest('hex'),shot.sha256);
    await writeFile(verifiedPath,JSON.stringify({...draft,verification:{confirmed:true,model:draft.model,evidenceHash:data.evidenceHash,draftHash:drafted.draftHash}}));
    const done=await cli(['complete',material.jobId,'--json',verifiedPath,'--out',join(root,'reports')]);
    const saved=done.find(e=>e.event==='report').report;assert.equal(saved.model_executor,'agent');assert.equal(saved.shots.length,4);
    await assert.rejects(readFile(verifiedMaterial.materialReference,'utf8'),{code:'ENOENT'});
    assert.ok(await readFile(material.materialPath,'utf8'));assert.ok(await readFile(index===0?a:b,'utf8'));
    await cli(['complete',material.jobId,'--json',verifiedPath]);
    assert.equal((await cli(['report',material.jobId]))[0].report.id,saved.id);
  }
  assert.equal(calls,0);assert.equal((await reviewUsage(DB,'fixture')).used,0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM review_execution_timing WHERE effort='scripted-none' AND config_origin='member-device'").get()!.n,2);
  const rerun=await cli(['review',a,'--out',join(root,'reports')]);assert.equal(rerun.find(e=>e.event==='submitted').job.id,ids[0]);assert.equal(calls,0);
  assert.equal((await cli(['report',ids[1]]))[0].report.probe.evidenceOrigin,'member-device');
  const aiResult=sqlite.prepare('SELECT result FROM reviews WHERE job_id=?').get(ids[0])!.result;
  await writeFile(humanPath,JSON.stringify({...human,status:'reviewed',phase:'final',score:0,feedback:'合成真人反馈；仅验证回填。',updatedAt:'2026-10-27T09:00:00.000Z'}));
  await cli(['human-review',ids[0],'--json',humanPath]);
  await cli(['human-review',ids[0],'--json',humanPath]);
  const updated=(await cli(['report',ids[0]]))[0].report;
  assert.equal(updated.human_review.score,0);assert.equal(updated.human_review.phase,'final');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM review_human_reviews').get()!.n,2);
  assert.equal(sqlite.prepare('SELECT result FROM reviews WHERE job_id=?').get(ids[0])!.result,aiResult);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM review_inputs').get()!.n,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM review_evidence').get()!.n,0);
  console.log('PASS Agent bundle → stdin/DPAPI pair → first-game immediate material + queued remainder → explicit continue after completion → 8 real viewport images → same-image delta verification + terminal cache cleanup + report reread → queued and completed human-feedback sync/idempotency → immutable AI reports; zero platform calls/quota. Scripted judgments only.');
}finally{await new Promise<void>(r=>server.close(()=>r()));sqlite.close();const target=resolve(root),parent=resolve('artifacts');assert.ok(target.startsWith(parent+'\\')||target.startsWith(parent+'/'));assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('agent-verify-'));await rm(target,{recursive:true,force:true});}
