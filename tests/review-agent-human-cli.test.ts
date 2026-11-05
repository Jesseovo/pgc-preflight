import {describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {reviewDeviceApi} from '../server/review-device-api';
import {digest} from '../server/review-device-state';

const source='https://creator-hub-7mi.pages.dev';
const human=()=>({workId:'work-01',versionId:'version:02',score:0,feedback:'真人意见',updatedAt:'2026-10-27T10:00:00.000Z',source,status:'reviewed',phase:'final',matchedBy:'user-confirmed'});
const report={aes:2,ease:2,play:2,score_reasons:{aes:'合成证据',ease:'合成证据',play:'合成证据'},uncertainties:['合成测试'],verdict:'建议修改',reviewer_comment:'合成初评',strengths:[],issues:[],fix_prompt:'合成建议'};

async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'pgc-human-cli-')),sqlite=new DatabaseSync(':memory:');
  for(const file of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  sqlite.exec("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,daily_review_limit) VALUES('owner','owner','Owner','unused','unused','now','now',0)");
  const DB:any={prepare(sql:string){let values:any[]=[];const statement:any={bind(...v:any[]){values=v;return statement;},first:async()=>sqlite.prepare(sql).get(...values)||null,all:async()=>({results:sqlite.prepare(sql).all(...values)}),run:async()=>{const result=sqlite.prepare(sql).run(...values);return{meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},execute:()=>sqlite.prepare(sql).run(...values)};return statement;},batch:async(statements:any[])=>{sqlite.exec('BEGIN');try{const out=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const token='b'.repeat(64),device=crypto.randomUUID();
  sqlite.prepare('INSERT INTO review_devices(id,owner_id,session_version,token_hash,pairing_hash,name,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(device,'owner','1',await digest(token),'unused','CLI',new Date(Date.now()+86400000).toISOString(),new Date().toISOString());
  const modelGet=vi.fn(async()=>{throw new Error('Human review must not access platform model configuration');}),schedule=vi.fn();
  const env={DB,SETTINGS_KEY:'unused',ADMIN_PASSWORD:'unused',modelStore:{get:modelGet},REVIEW_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:schedule})}};
  const direct=async(action:string,body:any)=>{
    const response=await reviewDeviceApi(new Request(`http://fixture.test/api/review-device/${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)}),env),value=await response.json() as any;
    expect(response.status,JSON.stringify(value)).toBe(200);return value;
  };
  const requests:Array<{action:string;body:any;authorization:string}>=[];
  let rejectHuman=false,loseHuman=false,acceptSubmission=false;
  const server=createServer(async(req,res)=>{
    try{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const bytes=Buffer.concat(chunks),action=String(req.url).split('/').at(-1)!;
      requests.push({action,body:JSON.parse(bytes.toString()),authorization:String(req.headers.authorization||'')});
      if(action==='record-submission'&&acceptSubmission){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,strictEligible:false}));return;}
      if(action==='human-review'&&rejectHuman){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'fixture human import unavailable'}));return;}
      const response=await reviewDeviceApi(new Request(`http://127.0.0.1${req.url}`,{method:'POST',headers:req.headers as Record<string,string>,body:bytes}),env);
      if(action==='human-review'&&loseHuman&&response.ok){loseHuman=false;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'fixture response lost after commit'}));return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const bundle=join(directory,'review-agent.mjs'),privateDir=join(directory,'private'),address=server.address() as {port:number};
  await build({entryPoints:['scripts/review-agent.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import{createRequire as __pgcCreateRequire}from'node:module';const require=__pgcCreateRequire(import.meta.url);"}});
  const run=(args:string[],allowError=false)=>new Promise<{values:any[];stdout:string;stderr:string;code:number|null}>((done,reject)=>{
    const child=spawn(process.execPath,[bundle,...args],{windowsHide:true,env:{...process.env,PGC_ORIGIN:`http://127.0.0.1:${address.port}`,PGC_AGENT_DATA:privateDir,PGC_WORKER_TOKEN:token}});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const timer=setTimeout(()=>{child.kill();reject(new Error('Human review CLI timed out'));},15000);
    child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0&&!allowError)reject(new Error(stderr));else done({values:stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),stdout,stderr,code});});
  });
  const json=async(name:string,value:any)=>{const path=join(directory,`${name}.json`);await writeFile(path,JSON.stringify(value));return path;};
  const evidence=async(id:string)=>{
    const job=await direct('claim',{id,claimId:crypto.randomUUID()}),accepted=await direct('evidence',{id,lease:job.lease,probe:{captureMethod:'browser-viewport-v1',observations:[]},shots:Array.from({length:4},(_,i)=>({label:`frame-${i}`,data:'data:image/jpeg;base64,YQ=='}))});
    return {...job,evidenceHash:accepted.evidenceHash};
  };
  const complete=async(job:any)=>{
    await direct('material',{id:job.id,lease:job.lease});
    const body={id:job.id,lease:job.lease,evidenceHash:job.evidenceHash,model:'scripted-cli-fixture',report},draft=await direct('draft',body);
    await direct('complete',{...body,verification:{confirmed:true,model:body.model,evidenceHash:job.evidenceHash,draftHash:draft.draftHash}});
  };
  const close=async()=>{
    await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));sqlite.close();
    const target=resolve(directory),parent=resolve(tmpdir());if(!target.startsWith(parent+sep)||!target.split(sep).at(-1)?.startsWith('pgc-human-cli-'))throw new Error('Unexpected temporary test path');
    await rm(target,{recursive:true,force:true});
  };
  return {directory,privateDir,sqlite,token,requests,modelGet,schedule,direct,run,json,evidence,complete,close,rejectHuman:(value:boolean)=>rejectHuman=value,loseHuman:()=>loseHuman=true,acceptSubmission:()=>acceptSubmission=true};
}

describe('真人审核回填CLI',()=>{
  it('submits exact UTF-8 artifact bytes and only the original lease with the four Creator declaration fields',async()=>{
    const s=await fixture();
    try{
      const game=join(s.directory,'game.html'),html='\ufeff<html>准确版本</html>',artifactVersionId='game-original-version';
      await writeFile(game,html);
      s.sqlite.prepare("INSERT INTO artifact_versions(id,owner_id,topic_id,kind,content,input_revision,executor,disposition,created_at) VALUES(?,'owner',1,'game',?,0,'agent','historical','now')").run(artifactVersionId,html);
      const {values}=await s.run(['submit',game,'--artifact-version',artifactVersionId]);
      const job=values.find(v=>v.event==='submitted').job;
      expect(job).toMatchObject({artifactVersionId,input_hash:await digest(html)});
      expect(s.requests[0].body).toMatchObject({artifactVersionId,html});
      const declaration={workId:'source-work',versionId:'source-version',uploadHash:job.input_hash,provenance:'creator-submission-record'};
      const valid=await s.json('valid-declaration',declaration),forged=await s.json('forged-declaration',{...declaration,lease:'forged',personalToken:'private-token'});
      expect((await s.run(['record-submission',job.id,'--json',valid],true)).code).toBe(1);
      expect(s.requests).toHaveLength(1);
      const claim=await s.evidence(job.id);await s.complete(claim);
      await writeFile(join(s.privateDir,'claims',`${job.id}.json`),JSON.stringify({claimId:claim.lease}));
      expect((await s.run(['record-submission',job.id,'--json',forged],true)).code).toBe(1);
      expect(s.requests).toHaveLength(1);
      s.acceptSubmission();
      const response=await s.run(['record-submission',job.id,'--json',valid]);
      expect(s.requests.at(-1)).toMatchObject({action:'record-submission',body:{...declaration,id:job.id,lease:claim.lease}});
      expect(response.values).toEqual([{event:'record-submission',ok:true,strictEligible:false}]);
      expect(response.stdout+response.stderr).not.toContain(claim.lease);
    }finally{await s.close();}
  },30000);
  it('已完成任务按原租约回填，响应丢失同请求幂等，更新记录使用新请求且不传外部凭据',async()=>{
    const s=await fixture();
    try{
      const html='<html>human CLI fixture</html>',submitted=await s.direct('submit',{html,request_id:crypto.randomUUID()}),job=await s.evidence(submitted.id);await s.complete(job);
      await mkdir(join(s.privateDir,'claims'),{recursive:true});await writeFile(join(s.privateDir,'claims',`${job.id}.json`),JSON.stringify({claimId:job.lease}));
      const input={...human(),uploadedContentHash:await digest(html),id:crypto.randomUUID(),lease:'forged',owner_id:'other',token:'external-secret',verification:{token:'external-secret'}};
      const path=await s.json('human',input);s.loseHuman();
      const first=await s.run(['human-review',job.id,'--json',path]);expect(first.values.find(value=>value.event==='human-review')).toMatchObject({jobId:job.id});
      const calls=s.requests.filter(value=>value.action==='human-review');expect(calls).toHaveLength(2);expect(calls[0].body).toEqual(calls[1].body);expect(calls[0].body).toMatchObject({...human(),id:job.id,lease:job.lease,requestId:expect.any(String)});
      expect(calls[0].body).not.toHaveProperty('verification');expect(calls[0].body).not.toHaveProperty('token');expect(calls[0].body).not.toHaveProperty('owner_id');
      const reordered=await s.json('reordered',Object.fromEntries(Object.entries(input).reverse()));await s.run(['human-review',job.id,'--json',reordered]);
      expect(s.requests.at(-1)!.body.requestId).toBe(calls[0].body.requestId);
      const saved=await s.direct('report',{id:job.id});expect(saved.human_review).toMatchObject({workId:human().workId,versionId:human().versionId,score:0,status:'reviewed'});
      const revised=await s.json('revised',{...human(),score:8.5,updatedAt:'2026-10-27T11:00:00.000Z'});await s.run(['human-review',job.id,'--json',revised]);
      expect(s.requests.at(-1)!.body.requestId).not.toBe(calls[0].body.requestId);expect((await s.direct('report',{id:job.id})).human_review.score).toBe(8.5);
      expect(s.requests.every(value=>value.authorization===`Bearer ${s.token}`)).toBe(true);expect(first.stdout+first.stderr).not.toContain(s.token);expect(first.stdout+first.stderr).not.toContain(job.lease);expect(first.stdout+first.stderr).not.toContain('external-secret');
      expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();expect(s.requests.every(value=>value.action==='human-review')).toBe(true);
    }finally{await s.close();}
  },30000);
  it('单文件关联失败保留AI任务和稳定请求，review继续返回材料并可独立补传',async()=>{
    const s=await fixture();
    try{
      const game=join(s.directory,'game.html');await writeFile(game,'<html>human association fixture</html>');
      const path=await s.json('pending',{...human(),status:'pending',score:null,phase:null,feedback:'等待真人审核'});s.rejectHuman(true);
      const submitted=await s.run(['submit',game,'--human-review',path]),id=submitted.values.find(value=>value.event==='submitted').job.id;
      expect(submitted.code).toBe(0);expect(submitted.values.find(value=>value.event==='human_review_pending')).toMatchObject({jobId:id,retryCommand:['human-review',id,'--json',path]});
      const firstHuman=s.requests.find(value=>value.action==='human-review')!;expect(firstHuman.body).not.toHaveProperty('lease');
      await s.evidence(id);
      const resumed=await s.run(['review',game,'--human-review',path,'--out',join(s.directory,'materials')]);expect(resumed.values.find(value=>value.event==='submitted').job.id).toBe(id);expect(resumed.values.find(value=>value.event==='material')).toMatchObject({jobId:id});
      s.rejectHuman(false);await s.run(['human-review',id,'--json',path]);
      const humans=s.requests.filter(value=>value.action==='human-review');expect(new Set(humans.map(value=>value.body.requestId)).size).toBe(1);expect(humans.at(-1)!.body.lease).toBeTruthy();
      expect(s.sqlite.prepare('SELECT count(*) n FROM review_jobs').get()).toMatchObject({n:1});expect((await s.direct('job',{id})).status).toBe('running');expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();
    }finally{await s.close();}
  },30000);
  it('不合法关联字段在联网前拒绝，多文件不可共用真人记录，无匹配可显式回填unlinked',async()=>{
    const s=await fixture();
    try{
      const id=crypto.randomUUID();
      for(const invalid of [null,[],{...human(),source:'https://elsewhere.test'},{...human(),workId:'../other'},{...human(),score:10},{...human(),status:'pending'},{...human(),updatedAt:'2026-10-27'},{...human(),decision:'preapproved'},{...human(),decision:'approved',phase:'preliminary'}]){
        const path=await s.json('invalid',invalid),before=s.requests.length,result=await s.run(['human-review',id,'--json',path],true);expect(result.code).toBe(1);expect(s.requests).toHaveLength(before);
      }
      const path=await s.json('valid',human()),game=join(s.directory,'game.html');await writeFile(game,'<html/>');
      expect((await s.run(['submit',game,game,'--human-review',path],true)).stderr).toContain('单个 HTML');expect(s.requests).toHaveLength(0);
      const submitted=await s.direct('submit',{html:'<html/>',request_id:id});
      const unlinked=await s.json('unlinked',{workId:null,versionId:null,score:null,feedback:null,phase:null,matchedBy:null,updatedAt:'2026-10-27T12:00:00.000Z',source,status:'unlinked'});
      const result=await s.run(['human-review',submitted.id,'--json',unlinked]);expect(result.code).toBe(0);expect(s.requests.at(-1)!.body).toMatchObject({id:submitted.id,status:'unlinked',workId:null,versionId:null});
    }finally{await s.close();}
  },30000);
  it('完成后终审通过自动补原文件入广场，重复不增条目且改文件不能顶替',async()=>{
    const s=await fixture();
    try{
      const game=join(s.directory,'approved.html'),html='<html><body>Approved version fixture</body></html>';
      await writeFile(game,html);
      const submitted=await s.run(['submit',game]),id=submitted.values.find(value=>value.event==='submitted').job.id;
      const job=await s.evidence(id);await s.complete(job);
      await mkdir(join(s.privateDir,'claims'),{recursive:true});await writeFile(join(s.privateDir,'claims',`${id}.json`),JSON.stringify({claimId:job.lease}));
      const path=await s.json('approved',{...human(),decision:'approved'});
      const result=await s.run(['human-review',id,'--json',path]);
      expect(result.values.find(value=>value.event==='human-review').human_review.decision).toBe('approved');
      expect(result.values.find(value=>value.event==='gallery')).toBeTruthy();
      expect(s.requests.filter(value=>value.action==='gallery').at(-1)!.body).toMatchObject({id,html,lease:job.lease});
      await s.run(['human-review',id,'--json',path]);await s.run(['gallery',id,'--game',game]);
      expect(s.sqlite.prepare('SELECT count(*) n FROM gallery_games').get()).toMatchObject({n:1});
      const before=s.requests.length;await writeFile(game,html+'<!-- modified -->');
      const changed=await s.run(['gallery',id,'--game',game],true);
      expect(changed.code).toBe(1);expect(changed.stderr).toContain('文件已修改');expect(s.requests).toHaveLength(before);
      expect(s.sqlite.prepare('SELECT count(*) n FROM review_inputs').get()).toMatchObject({n:0});
      expect(s.modelGet).not.toHaveBeenCalled();expect(s.schedule).not.toHaveBeenCalled();
    }finally{await s.close();}
  },30000);
  it('找不到原文件时保留已成功人审回填，可用原版显式恢复',async()=>{
    const s=await fixture();
    try{
      const html='<html>Source restored fixture</html>',id=crypto.randomUUID();
      await s.direct('submit',{html,request_id:id});const job=await s.evidence(id);await s.complete(job);
      await mkdir(join(s.privateDir,'claims'),{recursive:true});await writeFile(join(s.privateDir,'claims',`${id}.json`),JSON.stringify({claimId:job.lease}));
      const path=await s.json('approved',{...human(),decision:'approved'}),result=await s.run(['human-review',id,'--json',path]);
      expect(result.code).toBe(0);expect(result.values.find(value=>value.event==='gallery_pending')).toMatchObject({jobId:id});
      expect(s.sqlite.prepare('SELECT decision FROM review_human_reviews WHERE job_id=? AND is_current=1').get(id)).toMatchObject({decision:'approved'});
      const restored=join(s.directory,'restored.html');await writeFile(restored,html);
      await s.run(['gallery',id,'--game',restored]);
      expect(s.sqlite.prepare('SELECT count(*) n FROM gallery_games').get()).toMatchObject({n:1});
    }finally{await s.close();}
  },30000);
});
