import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {validateReviewEvidence} from '../server/review-evidence';

// Local synthetic transport, not a platform-model or deployed-server test.
const directory=await mkdtemp(join(tmpdir(),'pgc-adaptive-cli-')),id=randomUUID(),lease=randomUUID();
const html='<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#ddebd7}button{width:300px;height:300px}</style><button ontouchstart="this.textContent=event.isTrusted?\'TRUSTED\':\'UNTRUSTED\'">START</button><!-- private-source-sentinel -->';
let accepted=false,evidence:any,evidenceHash='',rejectUpload=true,calls=0;
const server=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const value=JSON.parse(raw),action=req.url!.split('/').pop();
  const send=(status:number,payload:any)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));};
  if(action==='submit'){assert.equal(value.review_mode,'enhanced');send(200,{id,status:'queued',stage:'capture',review_mode:'enhanced'});}
  else if(action==='job')send(200,{id,status:'running',stage:accepted?'review':'capture',model_executor:'agent',review_mode:'enhanced'});
  else if(action==='claim')send(200,{id,lease,html,stage:accepted?'review':'capture',review_mode:'enhanced',model_executor:'agent'});
  else if(action==='heartbeat')send(200,{ok:true});
  else if(action==='evidence'){
    await validateReviewEvidence({review_mode:'enhanced',model_executor:'agent',report_schema_version:2},value.probe,value.shots);
    calls++;const hash=createHash('sha256').update(raw).digest('hex');if(evidenceHash)assert.equal(hash,evidenceHash,'reconnection must reuse exactly sealed evidence');evidenceHash=hash;evidence=value;
    if(rejectUpload)send(503,{error:'synthetic disconnected upload'});else{accepted=true;send(200,{model_executor:'agent',evidenceHash});}
  }else if(action==='material')send(200,{user:[],stage:'review',system:'synthetic',evidenceHash});
  else send(400,{error:'unexpected route'});
});
await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
const env={...process.env,PGC_ORIGIN:`http://127.0.0.1:${(server.address() as any).port}`,PGC_AGENT_DATA:directory,PGC_WORKER_TOKEN:'synthetic-local-token'};
async function run(args:string[],ok=true){
  const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((done,reject)=>{
    const child=spawn(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/review-agent.ts'),...args],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));
  });
  assert(!result.stdout.includes('private-source-sentinel'));assert.equal(result.code,ok?0:1,result.stderr);return result.stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
}
try{
  const path=join(directory,'game.html');await writeFile(path,html,{mode:0o600});
  const started=await run(['review',path,'--enhanced','--request-id',id]);const first=started.find(x=>x.event==='play-first-image');assert(first?.imageSha256);assert.equal(first.source,'member-device');
  await run(['review',path,'--enhanced','--request-id',randomUUID()],false);
  const resumed=await run(['capture',id]);assert.equal(resumed.find(x=>x.event==='play')?.imageSha256,first.imageSha256);
  await run(['play-analyze',id],false);
  const input=join(directory,'input.json');await writeFile(input,JSON.stringify({hypothesis:'Visible START button',actions:[{type:'tap',x:120,y:150}]}));
  const acted=await run(['play-act',id,'--json',input]);assert.equal(acted[0].rounds,1);assert.equal(acted[0].actionCount,1);
  await writeFile(input,JSON.stringify({imageSha256:first.imageSha256,observations:'START button; touched it before source disclosure.',uncertainties:['No complete loop tested']}));
  await run(['play-first-look',id,'--json',input]);
  const analyzed=await run(['play-analyze',id]);assert.equal(analyzed[0].screenshots.length,4);
  const analysis=JSON.parse(await readFile(analyzed[0].analysisPath,'utf8'));assert(analysis.source.includes('private-source-sentinel'));
  await writeFile(input,JSON.stringify({hypothesis:'Inspect continuous touch before release',actions:[{type:'drag',path:[{x:120,y:150,atMs:0},{x:180,y:160,atMs:100,capture:true},{x:110,y:200,atMs:200}]}]}));
  const gesture=await run(['play-act',id,'--json',input]);assert.equal(gesture[0].actionCount,2);assert.equal(gesture[0].screenshots.length,2);
  for(const shot of gesture[0].screenshots){assert.equal(shot.imageSha256,createHash('sha256').update(await readFile(shot.path)).digest('hex'));assert.deepEqual(shot.actionRefs,[2]);}
  assert.equal(gesture[0].screenshots[0].requestedOffsetMs,100);
  await run(['play-finish',id],false);assert(evidenceHash);assert.equal(evidence.probe.captureMethod,'browser-viewport-v2');assert.equal(evidence.shots.length,8);assert.equal(evidence.probe.adaptive.firstLook.preDisclosureActionCount,1);assert.equal(evidence.probe.adaptive.sourceDisclosure.actionCount,1);assert.equal(evidence.shots[0].data,`data:image/jpeg;base64,${(await readFile(analysis.screenshots[0].path)).toString('base64')}`);assert((await readdir(join(directory,'outbox'))).some(x=>x===`${id}.bin`));
  rejectUpload=false;await run(['play-finish',id]);assert(accepted);assert(calls>=4);assert.equal((await readdir(join(directory,'outbox'))).length,0);
  await assert.rejects(readFile(join(directory,'play',`${id}.endpoint`)),'helper must close after evidence sealed');
  console.log(JSON.stringify({ok:true,synthetic:true,crossCliSession:true,blindUiAction:true,immutableOutboxRecovery:true,helperClosed:true}));
}finally{
  // Also close on assertion failure; never leave the synthetic browser helper alive.
  try{await run(['play-close',id]);}catch{}
  await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});
}
