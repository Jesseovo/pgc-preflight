import {readFile,writeFile,mkdir,rename,unlink,open,readdir,stat} from 'node:fs/promises';
import {basename,resolve,join} from 'node:path';
import {homedir,hostname,freemem} from 'node:os';
import {createHash,randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {spawn} from 'node:child_process';
import {launchLocalBrowser} from '../server/local-browser';
import {captureReview} from '../server/review-probe';

// On-demand Agent tool: no installer, scheduled task, daemon or provider Key.
// stdout is JSON Lines. Credentials never appear in output or command arguments.
const origin=new URL(process.env.PGC_ORIGIN||'https://pgc.ovoxin.top').origin;
if(new URL(origin).protocol!=='https:'&&!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))throw new Error('PGC_ORIGIN 必须使用 HTTPS。');
const scope=createHash('sha256').update(origin).digest('hex').slice(0,16);
const dataDir=resolve(process.env.PGC_AGENT_DATA||join(process.env.LOCALAPPDATA||join(homedir(),'.config'),'PGC Preflight','agent',scope));
const credentialPath=join(dataDir,'credential.json');
const args=process.argv.slice(2),command=args.shift()||'help';
const print=(value:unknown)=>console.log(JSON.stringify(value));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const uuid=(value:string)=>/^[a-f0-9-]{36}$/.test(value);
let token=process.env.PGC_WORKER_TOKEN||'';
let current:{id:string;lease:string}|null=null;
async function atomic(path:string,data:string|Buffer){const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,data,{mode:0o600});await rename(temp,path);}

async function dpapi(data:string,decrypt=false):Promise<string>{
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();${decrypt?"$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Text.Encoding]::UTF8.GetString($b))":"$b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Convert]::ToBase64String($b))"}`;
  return new Promise((done,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();
    const timer=setTimeout(()=>{child.kill();reject(new Error('本机凭据保护超时。'));},15000);
    child.on('error',()=>{clearTimeout(timer);reject(new Error('无法使用 Windows 凭据保护。'));});
    child.on('close',code=>{clearTimeout(timer);code===0?done(output):reject(new Error('本机凭据无法解密，请重新配对。'));});
    child.stdin.on('error',()=>{});child.stdin.end(data);
  });
}
async function saveCredential(value:any){
  const text=JSON.stringify(value);
  await atomic(credentialPath,JSON.stringify(process.platform==='win32'?{encoding:'dpapi',data:await dpapi(text)}:{encoding:'private-file',data:text}));
}
async function readCredential(){
  try{const saved=JSON.parse(await readFile(credentialPath,'utf8'));return JSON.parse(saved.encoding==='dpapi'?await dpapi(saved.data,true):saved.data);}catch(e){if((e as any).code==='ENOENT')return null;throw new Error('无法读取本机账号授权，请重新配对。');}
}
async function api(action:string,body:any={}):Promise<any>{
  if(!token)throw new Error('尚未授权。请在审核页生成配对码，让 Agent 执行 pair；无需安装助手。');
  for(let attempt=0;;attempt++){
    try{
      const res=await fetch(`${origin}/api/review-device/${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
      let value:any;try{value=await res.json();}catch{throw Object.assign(new Error(`服务暂不可用：HTTP ${res.status}`),{status:res.status});}
      if(!res.ok)throw Object.assign(new Error(value.error||`HTTP ${res.status}`),{status:res.status,retryAfter:Number(res.headers.get('Retry-After'))||0});
      return value;
    }catch(e){
      const status=(e as any).status;
      if(attempt>=2||status&&status<500&&status!==429)throw e;
      print({event:'progress',stage:'connection',message:'连接暂不可用，使用同一请求重连。'});
      await sleep(Math.min(30000,Math.max(1000*(attempt+1),((e as any).retryAfter||0)*1000)));
    }
  }
}
function option(name:string){const i=args.indexOf(name);if(i<0)return undefined;const value=args[i+1];if(!value||value.startsWith('--'))throw new Error(`${name} 缺少值`);args.splice(i,2);return value;}
const alsoWait=args.includes('--wait');if(alsoWait)args.splice(args.indexOf('--wait'),1);
const output=option('--out'),requestId=option('--request-id');
async function saveReport(id:string){const report=await api('report',{id});if(output){await mkdir(output,{recursive:true});await atomic(join(output,`${id}.json`),JSON.stringify(report,null,2));}print({event:'report',jobId:id,report});return report;}
async function waitFor(ids:string[]){
  const pending=new Set(ids),last=new Map<string,string>(),failures:string[]=[];const end=Date.now()+30*60000;
  while(pending.size&&Date.now()<end){
    // Each poll is small and independent; reports are emitted as they finish.
    for(const id of [...pending]){
      const job=await api('job',{id}),state=`${job.status}:${job.stage}:${job.error}`;
      if(state!==last.get(id)){print({event:'progress',...job});last.set(id,state);}
      if(job.status==='error'){pending.delete(id);failures.push(`${id}: ${job.error}`);}
      if(job.status==='done'){await saveReport(id);pending.delete(id);}
    }
    if(pending.size)await sleep(5000);
  }
  if(pending.size)failures.push(`等待达到 30 分钟，任务未取消，可用 status/wait 继续查询：${[...pending].join(', ')}`);
  if(failures.length)throw new Error(failures.join('\n'));
}
function seal(value:any){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(token).digest(),iv);const body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);}
function unseal(value:Buffer){const decipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(token).digest(),value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString());}
const leaseBody=(job:any)=>({id:job.id,lease:job.lease});
async function capture(id:string){
  const outbox=join(dataDir,'outbox',`${id}.bin`),claimPath=join(dataDir,'claims',`${id}.json`);
  let job=await api('job',{id});
  if(job.status==='error')throw new Error(`${id}: ${job.error}；请明确发起新一轮审核。`);
  if(job.status==='done'){await unlink(outbox).catch(()=>{});print({event:'capture',jobId:id,stage:'already_uploaded',status:job.status});return;}
  let pending:any;
  try{pending=unseal(await readFile(outbox));}catch(e){if((e as any).code!=='ENOENT')throw new Error('本机待传证据无法解密，可能已重新授权；请用 jobs/status 查询旧任务，不要盲目重新提交。');}
  if(pending){
    current=leaseBody(pending);
    try{await api('evidence',pending);await unlink(outbox);await unlink(claimPath).catch(()=>{});current=null;print({event:'capture',jobId:id,stage:'uploaded'});return;}
    catch(e){if((e as any).status!==409)throw e;await unlink(outbox);await unlink(claimPath).catch(()=>{});current=null;}
  }
  if(job.stage!=='capture'){print({event:'capture',jobId:id,stage:'already_uploaded',status:job.status});return;}
  let claim:any;try{claim=JSON.parse(await readFile(claimPath,'utf8'));}catch{}
  if(!claim){claim={claimId:randomUUID()};await atomic(claimPath,JSON.stringify(claim));}
  job=await api('claim',{...claim,id,version:'agent-capture-v1'});
  if(!job){
    const status=await api('job',{id});
    if(status.status==='done'||status.stage!=='capture')return;
    throw new Error(`${id}: 其他采集正在进行；请稍后用 capture 原任务继续，不要重新提交。`);
  }
  current=leaseBody(job);print({event:'capture',jobId:id,stage:'capture',message:'正在无界面浏览器采集三种手机比例、四张完整视口图。'});
  let evidence:any;
  try{
    const browser=await launchLocalBrowser();
    try{evidence=await captureReview(browser,job.html);}finally{await browser.close().catch(()=>{});}
    // Save before upload. A disconnected Agent can resume this exact evidence.
    await atomic(outbox,seal({...leaseBody(job),...evidence}));
  }catch(e){await api('fail',{...leaseBody(job),message:String((e as Error).message).slice(0,500)}).catch(()=>{});current=null;throw e;}
  await api('evidence',{...leaseBody(job),...evidence});
  await unlink(outbox);await unlink(claimPath).catch(()=>{});current=null;
  print({event:'capture',jobId:id,stage:'uploaded',message:'截图已上传，云端正在初评与复核。'});
}
async function submit(path:string){
  if(!/\.html?$/i.test(path))throw new Error('只支持 .html / .htm 文件。');
  const bytes=await readFile(resolve(path));if(!bytes.length||bytes.length>8*1024*1024)throw new Error('单个文件必须在 1 字节至 8 MB 之间。');
  const key=createHash('sha256').update(origin).update(token).update(resolve(path)).update(bytes).digest('hex');
  const manifest=join(dataDir,'submissions',`${key}.json`);
  let saved:any;try{saved=JSON.parse(await readFile(manifest,'utf8'));}catch{}
  let id=requestId||saved?.id;
  if(!requestId&&saved&&Date.now()-Date.parse(saved.createdAt)>86400000){
    let old:any;try{old=await api('job',{id:saved.id});}catch(e){if((e as any).status!==404)throw e;}
    if(!old||['done','error'].includes(old.status))id=undefined;
  }
  id||=randomUUID();if(!uuid(id))throw new Error('request-id 必须是 UUID。');
  // Persist before transmission: a lost response reuses the reservation.
  if(id!==saved?.id)await atomic(manifest,JSON.stringify({id,createdAt:new Date().toISOString()}));
  const job=await api('submit',{html:bytes.toString('utf8'),filename:basename(path),title:basename(path).replace(/\.html?$/i,''),request_id:id});
  print({event:'submitted',job});return id as string;
}
let lockPath:string|undefined,lockOwned=false,heartbeat:ReturnType<typeof setInterval>|undefined;
try{
  if(command==='help'){
    print({commands:['pair (PGC_PAIR_CODE or stdin)','review <file.html> [more.html] [--out directory] [--request-id UUID]','submit <file.html> [more.html] [--wait]','capture <job-id> [--wait]','status <job-id>','jobs','wait <job-id> [--out directory]','report <job-id> [--out directory]'],note:'按需执行，无常驻进程。review 完成提交、采集和等待；同内容重跑复用任务。模型 Key 仅在云端。'});
  }else{
    await mkdir(dataDir,{recursive:true,mode:0o700});
    for(const sub of ['submissions','claims','outbox'])await mkdir(join(dataDir,sub),{recursive:true,mode:0o700});
    if(['pair','submit','review','capture'].includes(command)){
      lockPath=join(dataDir,'capture.lock');
      let old:any;try{old=JSON.parse(await readFile(lockPath,'utf8'));}catch{}
      if(old){try{process.kill(old.pid,0);throw new Error('此设备已有 Agent 操作运行，请等待该命令结束。');}catch(e){if((e as any).code!=='ESRCH')throw e;await unlink(lockPath);}}
      const lock=await open(lockPath,'wx',0o600);lockOwned=true;
      try{await lock.writeFile(JSON.stringify({pid:process.pid}));}finally{await lock.close();}
    }
    if(command==='pair'){
      let code=process.env.PGC_PAIR_CODE||'';
      if(!code&&!process.stdin.isTTY){for await(const chunk of process.stdin)code+=chunk;}
      code=code.trim();if(!/^[a-f0-9]{40}$/.test(code))throw new Error('请通过当前进程 PGC_PAIR_CODE 或 stdin 提供网页的 5 分钟配对码。');
      const hash=createHash('sha256').update(code).digest('hex');
      const previous=await readCredential();
      const credential=previous?.pairingHash===hash?previous:{id:previous?.id||randomUUID(),token:randomBytes(32).toString('hex'),pairingHash:hash};
      token=credential.token;await saveCredential(credential);
      const paired=await api('pair',{code,deviceId:credential.id,token,name:hostname()});
      await saveCredential({...credential,expiresAt:paired.expiresAt});
      print({event:'paired',deviceId:paired.deviceId,expiresAt:paired.expiresAt});
    }else{
      if(!token)token=(await readCredential())?.token||'';
      if(!token)throw new Error('尚未授权。请在网页生成配对码后执行 pair，无需下载安装助手。');
      if(['review','capture'].includes(command)){
        for(const name of await readdir(join(dataDir,'outbox'))){const path=join(dataDir,'outbox',name);if(name.endsWith('.bin')&&Date.now()-(await stat(path)).mtimeMs>86400000)await unlink(path);}
        heartbeat=setInterval(()=>{void api('heartbeat',{version:'agent-capture-v1',freeMemoryMB:Math.floor(freemem()/1048576),job:current}).catch(()=>{});},20000);
      }
      if(command==='submit'||command==='review'){
        if(!args.length||args.length>20||requestId&&args.length!==1)throw new Error('每批 1–20 个 HTML；--request-id 仅支持单文件。');
        const ids:string[]=[],errors:string[]=[];
        for(const path of args)try{ids.push(await submit(path));}catch(e){errors.push((e as Error).message);print({event:'error',file:basename(path),message:(e as Error).message});}
        const captured:string[]=[];
        if(command==='review')for(const id of ids)try{await capture(id);captured.push(id);}catch(e){errors.push((e as Error).message);print({event:'error',jobId:id,message:(e as Error).message});}
        if(command==='review'||alsoWait)try{await waitFor(command==='review'?captured:ids);}catch(e){errors.push((e as Error).message);}
        if(errors.length)throw new Error(errors.join('\n'));
      }else if(command==='jobs')print(await api('jobs'));
      else if(['status','report','wait','capture'].includes(command)){
        if(args.length!==1||!uuid(args[0]))throw new Error('请提供一个 job UUID。');
        const id=args[0];
        if(command==='wait')await waitFor([id]);
        else if(command==='capture'){await capture(id);if(alsoWait)await waitFor([id]);}
        else if(command==='report')await saveReport(id);
        else print(await api('job',{id}));
      }else throw new Error('未知命令，请运行 help。');
    }
  }
}catch(e){console.error(JSON.stringify({error:(e as Error).message}));process.exitCode=1;}
finally{clearInterval(heartbeat);if(lockOwned&&lockPath)await unlink(lockPath).catch(()=>{});}
