import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdir,writeFile,rm,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {reviewDeviceApi} from '../server/review-device-api';
import {executeDeviceReview} from '../server/review-runner';
import {digest} from '../server/review-device-state';
import {encryptKey} from '../server/settings';
import {reviewUsage} from '../server/review-usage';

// Real shipped bundle, persisted credentials, real isolated Chromium evidence,
// actual two-stage model transport and migrated DB. Provider output is scripted.
const sqlite=new DatabaseSync(':memory:');
for(const file of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(await readFile('migrations/'+file,'utf8'));
const DB:any={prepare(sql:string){let values:any[]=[];const stmt:any={bind(...v:any[]){values=v;return stmt;},first:async()=>sqlite.prepare(sql).get(...values)||null,all:async()=>({results:sqlite.prepare(sql).all(...values)}),run:async()=>{const r=sqlite.prepare(sql).run(...values);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};},execute:()=>sqlite.prepare(sql).run(...values)};return stmt;},batch:async(stmts:any[])=>{sqlite.exec('BEGIN');try{const r=stmts.map(s=>s.execute());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
sqlite.exec("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at) VALUES('fixture','fixture','Fixture','unused','unused','now','now')");
let calls=0,env:any;
const report={aes:2,ease:2,play:2,verdict:'建议修改',reviewer_comment:'合成接口报告，用于验证接入流程。',score_reasons:{aes:'合成依据',ease:'合成依据',play:'合成依据'},uncertainties:['手感保留人工审核'],strengths:['合成亮点'],issues:[],fix_prompt:'合成修改建议'};
const pending:Promise<void>[]=[];
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
const profile={baseUrl:origin,protocol:'openai',model:'deepseek-flash',enabled:true,vision:true,encryptedKey:await encryptKey('fixture-only-key','fixture-secret'),updatedAt:''};
env={DB,SETTINGS_KEY:'fixture-secret',ADMIN_PASSWORD:'fixture-admin',modelStore:{get:async()=>profile},REVIEW_RUNNER:{idFromName:(id:string)=>id,get:(id:string)=>({fetch:async()=>{pending.push(new Promise<void>(r=>setTimeout(r,10)).then(()=>executeDeviceReview(env,id)));return Response.json({ok:true});}})}};
await mkdir('artifacts',{recursive:true});
const root=await mkdtemp(resolve('artifacts/agent-verify-'));
const cli=async(args:string[],extra:Record<string,string>={})=>new Promise<any[]>((done,reject)=>{
  const child=spawn(process.execPath,[resolve('public/agent/review-agent.mjs'),...args],{env:{...process.env,PGC_ORIGIN:origin,PGC_AGENT_DATA:join(root,'account'),...extra},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.on('error',reject);child.on('close',code=>code===0?done(stdout.trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))):reject(new Error(`CLI failed ${code}: ${stderr}\n${stdout}`)));
});
try{
  const code='a'.repeat(40);sqlite.prepare('INSERT INTO review_pairings VALUES(?,?,?, ?,NULL)').run(await digest(code),'fixture','1',new Date(Date.now()+300000).toISOString());
  assert.equal((await cli(['pair'],{PGC_PAIR_CODE:code}))[0].event,'paired');
  const credential=await readFile(join(root,'account','credential.json'),'utf8');if(process.platform==='win32')assert.match(credential,/dpapi/);
  const a=join(root,'a.html'),b=join(root,'b.html');
  for(const path of [a,b])await writeFile(path,'<!doctype html><html><title>AGENT_FIXTURE</title><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#d7e7d9"><h1>AGENT_FIXTURE</h1><button onclick="this.textContent=\'touched\'">Start</button><canvas width="360" height="200"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#55795d";c.fillRect(30,30,140,100);</script></body></html>');
  const result=await cli(['review',a,b,'--out',join(root,'reports')]);
  const ids=result.filter(e=>e.event==='submitted').map(e=>e.job.id);assert.equal(ids.length,2);assert.equal(result.filter(e=>e.event==='report').length,2);
  assert.equal(calls,4);assert.equal((await reviewUsage(DB,'fixture')).used,2);
  const rerun=await cli(['review',a,'--out',join(root,'reports')]);assert.equal(rerun.find(e=>e.event==='submitted').job.id,ids[0]);assert.equal(calls,4);
  assert.equal((await cli(['report',ids[1]]))[0].report.probe.evidenceOrigin,'member-device');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM review_inputs').get()!.n,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM review_evidence').get()!.n,0);
  console.log('PASS Agent bundle → DPAPI pair → 2 local games → 8 real viewport images → 4 scripted model calls → JSON reports; repeat reuses jobs/quota; no daemon/installer.');
}finally{await Promise.allSettled(pending);await new Promise<void>(r=>server.close(()=>r()));sqlite.close();await rm(root,{recursive:true,force:true});}
