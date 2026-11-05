import {describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,readdir,rm,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {forgeAgentApi} from '../server/forge-agent-api';
import {digest} from '../server/review-device-state';

describe('个人创作Agent自包含命令行接入',()=>{
  it('真实bundle使用安全授权、稳定请求编号和私有回执完成HTTP往返，工具不调用模型',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'pgc-forge-cli-')),sqlite=new DatabaseSync(':memory:');
    for(const file of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
    sqlite.exec("INSERT INTO members(id,username,display_name,password_hash,password_salt,star,created_at,updated_at) VALUES('a','a','a','unused','unused',1,'now','now')");
    for(const[dim,word]of [['medium','pixel'],['gesture','tap'],['structure','rhythm'],['mood','calm']])sqlite.prepare('INSERT INTO vocab(dim,word) VALUES(?,?)').run(dim,word);
    const code='a'.repeat(40);sqlite.prepare('INSERT INTO forge_agent_pairings VALUES(?,?,?,?,NULL)').run(await digest(code),'a',1,new Date(Date.now()+300000).toISOString());
    const DB:any={prepare(sql:string){let params:any[]=[];const statement:any={bind(...values:any[]){params=values;return statement;},first:async()=>sqlite.prepare(sql).get(...params)||null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>{const result=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},execute:()=>sqlite.prepare(sql).run(...params)};return statement;},batch:async(statements:any[])=>{sqlite.exec('BEGIN');try{const results=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
    const modelGet=vi.fn(async()=>{throw new Error('CLI must not access platform model config');}),schedule=vi.fn();
    const env={DB,modelStore:{get:modelGet},FORGE_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:schedule})}};
    const requests:Array<{action:string;body:any;authorization:string}>=[];
    let loseDraw=false,loseClaim=false;
    const server=createServer(async(request,response)=>{
      try{
        const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
        const body=Buffer.concat(chunks),action=String(request.url).split('/').at(-1)!;
        requests.push({action,body:JSON.parse(body.toString()),authorization:String(request.headers.authorization||'')});
        const result=await forgeAgentApi(new Request(`http://127.0.0.1${request.url}`,{method:'POST',headers:request.headers as Record<string,string>,body}),env);
        if(action==='draw'&&loseDraw||action==='claim'&&loseClaim){loseDraw=false;loseClaim=false;response.writeHead(503,{'Content-Type':'application/json'});response.end(JSON.stringify({error:'fixture response lost after commit'}));return;}
        response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));
      }catch(error){response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:String(error)}));}
    });
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    try{
      const bundle=join(directory,'forge-agent.mjs'),privateDir=join(directory,'private'),address=server.address() as {port:number};
      await build({entryPoints:['scripts/forge-agent.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm',target:'node22'});
      const run=(args:string[],options:{stdin?:string;code?:string;allowError?:boolean}={})=>new Promise<{values:any[];stdout:string;stderr:string;code:number|null}>((done,reject)=>{
        const child=spawn(process.execPath,[bundle,...args],{windowsHide:true,env:{...process.env,PGC_PAIR_CODE:options.code||'',PGC_ORIGIN:`http://127.0.0.1:${address.port}`,PGC_FORGE_AGENT_DATA:privateDir}});
        let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.stdin.on('error',()=>{});child.stdin.end(options.stdin||'');
        const timer=setTimeout(()=>{child.kill();reject(new Error('Forge CLI timed out'));},45000);
        child.on('error',reject);child.on('close',status=>{clearTimeout(timer);if(status!==0&&!options.allowError)reject(new Error(stderr));else done({values:stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),stdout,stderr,code:status});});
      });
      const inputFile=async(name:string,value:any)=>{const path=join(directory,`${name}.json`);await writeFile(path,JSON.stringify(value));return path;};
      const pair=await run(['pair'],{stdin:`${code}\n`}),paired=pair.values[0];
      expect(paired).toMatchObject({ok:true,deviceId:expect.any(String)});
      const firstPair=requests.find(item=>item.action==='pair')!,token=firstPair.body.token;
      expect(pair.stdout+pair.stderr).not.toContain(code);expect(pair.stdout+pair.stderr).not.toContain(token);
      const credential=await readFile(join(privateDir,'credential.bin'),'utf8');
      if(process.platform==='win32'){expect(credential).not.toContain(token);expect(()=>JSON.parse(credential)).toThrow();}
      else{expect((await stat(join(privateDir,'credential.bin'))).mode&0o777).toBe(0o600);expect((await stat(privateDir)).mode&0o777).toBe(0o700);}
      const secondPair=await run(['pair'],{code});expect(secondPair.values[0].deviceId).toBe(paired.deviceId);
      const pairCalls=requests.filter(item=>item.action==='pair');expect(pairCalls[1].body.token).toBe(token);expect(pairCalls[1].body.deviceId).toBe(paired.deviceId);
      expect(sqlite.prepare('SELECT count(*) n FROM forge_agents').get()).toMatchObject({n:1});
      expect((sqlite.prepare('SELECT token_hash FROM forge_agents').get() as any).token_hash).toBe(await digest(token));
      expect((await run(['jobs'])).values).toEqual([[]]);expect((await run(['context'])).values[0]).toMatchObject({model_execution:'local-agent'});

      const drawPath=await inputFile('draw',{subject:'CLI unique first subject',requirements:'CLI requirement'});loseDraw=true;
      const lost=await run(['draw','--json',drawPath],{allowError:true});expect(lost.code).toBe(1);expect(lost.stderr).toContain('fixture response lost after commit');
      const drawn=(await run(['draw','--json',drawPath])).values[0],drawnReplay=(await run(['draw','--json',drawPath])).values[0];expect(drawnReplay).toEqual(drawn);expect(drawn).toHaveLength(1);
      const drawCalls=requests.filter(item=>item.action==='draw');expect(new Set(drawCalls.map(item=>item.body.request_id)).size).toBe(1);expect(drawCalls[0].body.request_id).toMatch(/^[a-f0-9-]{36}$/);
      expect(drawCalls[0].body.creative_version).toBe(2);
      expect(sqlite.prepare('SELECT count(*) n FROM topics').get()).toMatchObject({n:1});
      const otherDraw=await inputFile('other-draw',{subject:'CLI unique second subject',locks:{medium:'ink'}}),concurrentDraws=await Promise.all([run(['draw','--json',otherDraw]),run(['draw','--json',otherDraw])]);
      expect(concurrentDraws[0].values).toEqual(concurrentDraws[1].values);const concurrentDrawCalls=requests.filter(item=>item.action==='draw').slice(-2);expect(concurrentDrawCalls[0].body.request_id).toBe(concurrentDrawCalls[1].body.request_id);expect(concurrentDrawCalls[0].body.request_id).not.toBe(drawCalls[0].body.request_id);

      const createPath=await inputFile('create',{kind:'expand',id:drawn[0].id});
      const created=(await run(['create','--json',createPath])).values[0],repeated=(await run(['create','--json',createPath])).values[0],task=created.tasks[0];
      expect(repeated).toEqual(created);expect(task).toMatchObject({executor:'agent',owner_id:'a',kind:'expand'});
      const createCalls=requests.filter(item=>item.action==='create');expect(createCalls[0].body.request_id).toBe(createCalls[1].body.request_id);expect(sqlite.prepare('SELECT count(*) n FROM forge_tasks').get()).toMatchObject({n:1});
      expect((await run(['jobs'])).values[0][0].id).toBe(task.id);expect((await run(['job',task.id])).values[0]).toMatchObject({id:task.id,status:'queued'});

      loseClaim=true;const claimLost=await run(['claim',task.id],{allowError:true});expect(claimLost.code).toBe(1);
      const materialPath=join(directory,'materials','expand.json'),claimed=(await run(['claim',task.id,'--out',materialPath])).values[0],raw=await readFile(materialPath,'utf8'),material=JSON.parse(raw);
      expect(claimed).toMatchObject({event:'material',path:materialPath,task:{id:task.id}});expect(material).toMatchObject({task:{id:task.id,status:'running'},materials:{schema:expect.any(Object),system:expect.any(String),user:expect.any(String)}});
      const receipt=requests.filter(item=>item.action==='claim')[0].body.receipt;expect(receipt).toMatch(/^[a-f0-9]{64}$/);
      expect(claimLost.stdout+claimLost.stderr+JSON.stringify(claimed)+raw).not.toContain(receipt);
      const directClaim=await run(['claim',task.id]);expect(directClaim.values[0].task.id).toBe(task.id);expect(directClaim.stdout+directClaim.stderr).not.toContain(receipt);
      const claims=requests.filter(item=>item.action==='claim');expect(new Set(claims.map(item=>item.body.receipt)).size).toBe(1);expect(new Set(claims.map(item=>item.body.claimId)).size).toBe(1);
      const savedClaim=await readFile(join(privateDir,`claim-${task.id}.bin`),'utf8');if(process.platform==='win32')expect(savedClaim).not.toContain(receipt);else expect((await stat(join(privateDir,`claim-${task.id}.bin`))).mode&0o777).toBe(0o600);
      if(process.platform!=='win32')await chmod(materialPath,0o666);
      await run(['claim',task.id,'--out',materialPath]);if(process.platform!=='win32')expect((await stat(materialPath)).mode&0o777).toBe(0o600);
      const progressPath=await inputFile('progress',{detail:'验证本地Agent进度',id:crypto.randomUUID(),receipt:'f'.repeat(64)});await run(['heartbeat',task.id,'--json',progressPath]);
      const heartbeat=requests.filter(item=>item.action==='heartbeat').at(-1)!;expect(heartbeat.body).toMatchObject({id:task.id,receipt,detail:'验证本地Agent进度'});

      const failPath=await inputFile('failure',{message:'本地模型无法完成扩写',receipt:'f'.repeat(64),id:crypto.randomUUID()});await run(['fail',task.id,'--json',failPath]);
      expect(requests.filter(item=>item.action==='fail').at(-1)!.body).toMatchObject({id:task.id,receipt,message:'本地模型无法完成扩写'});expect((await run(['job',task.id])).values[0].status).toBe('error');
      const explicit=crypto.randomUUID(),suggestPath=await inputFile('suggest',{request_id:explicit,kind:'suggest',dim:'subject',n:5}),suggest=(await run(['create','--json',suggestPath])).values[0].tasks[0];
      expect(requests.filter(item=>item.action==='create').at(-1)!.body.request_id).toBe(explicit);
      const concurrentClaims=await Promise.all([run(['claim',suggest.id]),run(['claim',suggest.id])]);expect(concurrentClaims[0].values).toEqual(concurrentClaims[1].values);
      const suggestionClaims=requests.filter(item=>item.action==='claim'&&item.body.id===suggest.id),suggestionReceipt=suggestionClaims[0].body.receipt;expect(new Set(suggestionClaims.map(item=>item.body.receipt)).size).toBe(1);expect(new Set(suggestionClaims.map(item=>item.body.claimId)).size).toBe(1);
      const resultPath=await inputFile('result',{result:{words:[{word:'CLI local vocabulary',note:'本地Agent建议'}]},model:'member-owned-model',receipt:'f'.repeat(64),id:crypto.randomUUID()});
      const completed=await run(['complete',suggest.id,'--json',resultPath]);expect(completed.values[0]).toMatchObject({task:{id:suggest.id,status:'done'},status:'pending'});
      const completion=requests.filter(item=>item.action==='complete').at(-1)!;expect(completion.body).toMatchObject({id:suggest.id,receipt:suggestionReceipt,model:'member-owned-model'});
      expect((await run(['complete',suggest.id,'--json',resultPath])).values[0].task.status).toBe('done');expect(sqlite.prepare('SELECT count(*) n FROM vocab_suggestions').get()).toMatchObject({n:1});
      expect(completed.stdout+completed.stderr).not.toContain(suggestionReceipt);expect(completed.stdout+completed.stderr).not.toContain(token);

      const pageInput=await inputFile('mechanisms-page',{after:3,limit:5,receipt:'not a request field'});
      expect((await run(['mechanisms','--json',pageInput])).values[0]).toMatchObject({items:[],next:null});
      expect(requests.at(-1)).toMatchObject({action:'mechanisms',body:{after:3,limit:5}});
      expect(requests.at(-1)?.body).not.toHaveProperty('receipt');

      sqlite.prepare("UPDATE topics SET status='liked',origin='mechanism-choice',data=?,brief_md=? WHERE id=?")
        .run(JSON.stringify({title:'CLI stages'}),'### F1. CLI stages\n### F10. Audio',drawn[0].id);
      const createGamePath=await inputFile('game-task',{kind:'game',id:drawn[0].id});
      const game=(await run(['create','--json',createGamePath])).values[0].tasks[0];
      expect((await run(['claim',game.id])).values[0].materials).toMatchObject({pipeline:{version:2}});
      const html='<!doctype html><html><meta name="viewport" content="width=device-width"><script>document.title="PRIVATE_STAGE_HTML";</script></html>';
      const stagePath=await inputFile('build-stage',{stage:'build',output:{html,requirements:[{id:'R1',text:'Use a title',status:'implemented'}],decisions:[],coreChanges:[]},model:'member-stage-model'});
      const shotData='data:image/jpeg;base64,/9j/2Q==';
      const capturedAt='2026-11-05T00:00:01.000Z';
      const actions=['9:16','9:19.5','9:21'].map(ratio=>({id:`baseline-${ratio}-tap`,ratio,type:'tap',startedAt:capturedAt,x:180,y:400,count:1}));
      const shots=[0,null,1,2].map((actionIndex,index)=>({id:`baseline-${index+1}`,label:`fixture-${index+1}`,data:shotData,capturedAt,actionRefs:actionIndex===null?[]:[actions[actionIndex].id]}));
      const capture={origin:'member-device',inputHash:await digest(html),shots,probe:{captureMethod:'browser-viewport-v1',actions,observations:shots.map(({data,...shot})=>shot)}};
      const staleCapture=await inputFile('stale-capture',{...capture,inputHash:'0'.repeat(64)});
      const requestCount=requests.length;
      expect((await run(['stage',game.id,'--json',stagePath,'--capture',staleCapture],{allowError:true})).stderr).toContain('阶段 HTML 与采集文件不一致');
      expect(requests).toHaveLength(requestCount);
      const evidencePath=await inputFile('build-capture',capture),nextPath=join(directory,'polish.json');
      const locked=(await run(['stage',game.id,'--json',stagePath,'--capture',evidencePath,'--out',nextPath]));
      expect(locked.stdout).not.toMatch(/PRIVATE_STAGE_HTML|data:image/);
      expect(locked.values[0]).toMatchObject({event:'creation-stage',stage:'build',nextStage:'polish',content_hash:capture.inputHash,path:nextPath});
      expect(requests.at(-1)).toMatchObject({action:'creation-stage',body:{stage:'build',capture:{inputHash:capture.inputHash},model:'member-stage-model'}});
      const next=JSON.parse(await readFile(nextPath,'utf8')).nextMaterials;
      const images=next.user.filter((part:any)=>part.type==='image');
      expect(images).toHaveLength(4);
      for(const image of images){
        expect(image).not.toHaveProperty('data');
        expect((await readFile(image.path)).toString('base64')).toBe('/9j/2Q==');
        if(process.platform!=='win32')expect((await stat(image.path)).mode&0o777).toBe(0o600);
      }
      expect(requests.every(item=>item.authorization===`Bearer ${token}`)).toBe(true);expect(modelGet).not.toHaveBeenCalled();expect(schedule).not.toHaveBeenCalled();
      expect((await readdir(privateDir)).some(name=>name.endsWith('.tmp'))).toBe(false);
      const before=requests.length,nullPath=await inputFile('invalid',null);const invalid=await run(['draw','--json',nullPath],{allowError:true});expect(invalid.code).toBe(1);expect(invalid.stderr).toContain('JSON 对象');expect(requests).toHaveLength(before);
    }finally{
      await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));sqlite.close();
      const target=resolve(directory),parent=resolve(tmpdir());if(!target.startsWith(parent+sep)||!target.split(sep).at(-1)?.startsWith('pgc-forge-cli-'))throw new Error('Unexpected temporary test path');
      await rm(target,{recursive:true,force:true});
    }
  },180000);
});
