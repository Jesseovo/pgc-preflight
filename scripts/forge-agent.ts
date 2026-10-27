import {readFile,writeFile,mkdir,rename,chmod,link,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir,hostname} from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

// This is only an authenticated platform transport. The user's Agent owns all
// model calls, reasoning, concurrency and session polling.
const origin=new URL(process.env.PGC_ORIGIN||'https://pgc.ovoxin.top').origin;
if(new URL(origin).protocol!=='https:'&&!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))throw new Error('PGC_ORIGIN 必须是 HTTPS 或本机地址。');
const scope=createHash('sha256').update(origin).digest('hex').slice(0,16);
const directory=resolve(process.env.PGC_FORGE_AGENT_DATA||join(process.env.LOCALAPPDATA||join(homedir(),'.config'),'PGC Preflight','forge-agent',scope));
const args=process.argv.slice(2),command=args.shift()||'help';
function option(name:string){const i=args.indexOf(name);if(i<0)return undefined;const v=args[i+1];if(!v||v.startsWith('--'))throw new Error(`${name} 缺少值。`);args.splice(i,2);return v;}
const input=option('--json'),output=option('--out');
const print=(v:unknown)=>console.log(JSON.stringify(v));
async function secure(text:string,decrypt=false):Promise<string>{
  if(process.platform!=='win32')return text;
  const operation=decrypt?"Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)":"Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)";
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Security.Cryptography.ProtectedData]::${operation};[Console]::Write(${decrypt?'[Text.Encoding]::UTF8.GetString($b)':'[Convert]::ToBase64String($b)'});`;
  return new Promise((done,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});let captured='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('本机凭据保护超时。'));},15000);
    child.stdout.on('data',b=>captured+=b);child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(new Error('Windows 凭据保护不可用。'));});child.on('close',code=>{clearTimeout(timer);code===0?done(captured):reject(new Error('无法读取本机授权，请重新配对。'));});child.stdin.end(text);
  });
}
async function privateFile(path:string,text:string,exclusive=false){
  const tmp=`${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  try{
    await writeFile(tmp,text,{mode:0o600});
    if(exclusive){try{await link(tmp,path);}catch(error){if((error as any).code==='EEXIST')return false;throw error;}}
    else await rename(tmp,path);
    if(process.platform!=='win32')await chmod(path,0o600);
    return true;
  }finally{await unlink(tmp).catch(()=>{});}
}
async function save(path:string,value:any,exclusive=false){return privateFile(path,await secure(JSON.stringify(value)),exclusive);}
async function load(path:string){try{return JSON.parse(await secure(await readFile(path,'utf8'),true));}catch(e){if((e as any).code==='ENOENT')return null;throw e;}}
async function main(){
  if(command==='help'){print({commands:['pair (PGC_PAIR_CODE or stdin)','context','draw --json request.json','create --json request.json','jobs','job TASK_UUID','claim TASK_UUID [--out material.json]','heartbeat TASK_UUID [--json progress.json]','complete TASK_UUID --json result.json','fail TASK_UUID --json error.json'],note:'仅传输任务和结果；你自己的 Agent 调用模型。凭据和任务回执保存在本机，工具无常驻服务。'});return;}
  if(!['pair','context','draw','create','jobs','job','claim','heartbeat','complete','fail'].includes(command))throw new Error('未知命令，请使用 help。');
  await mkdir(directory,{recursive:true,mode:0o700});
  const credentialPath=join(directory,'credential.bin');let credential=await load(credentialPath);
  async function api(action:string,body:any={}){
    const response=await fetch(`${origin}/api/forge-agent/${action}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential.token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
    const result=await response.json() as any;if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`);return result;
  }
  if(command==='pair'){
    let code=process.env.PGC_PAIR_CODE||'';if(!code&&!process.stdin.isTTY)for await(const chunk of process.stdin)code+=chunk;
    code=code.trim();if(!/^[a-f0-9]{40}$/.test(code))throw new Error('通过 PGC_PAIR_CODE 或标准输入提供配对码。');
    const hash=createHash('sha256').update(code).digest('hex');
    credential=credential?.pairingHash===hash?credential:{id:credential?.id||randomUUID(),token:randomBytes(32).toString('hex'),pairingHash:hash};
    await save(credentialPath,credential);
    const result=await api('pair',{code,deviceId:credential.id,token:credential.token,name:hostname()});await save(credentialPath,{...credential,expiresAt:result.expiresAt});print(result);return;
  }
  if(!credential)throw new Error('请先在 Star 工作台生成创作配对码，执行 pair。');
  const payload=input?JSON.parse(await readFile(resolve(input),'utf8')):{};
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('请求文件必须是 JSON 对象。');
  if(['context','jobs'].includes(command)){print(await api(command));return;}
  if(['draw','create'].includes(command)){
    if(!payload.request_id){
      const key=createHash('sha256').update(command).update(JSON.stringify(payload)).digest('hex'),path=join(directory,`request-${key}.bin`);
      let saved=await load(path);
      if(!saved){const candidate={id:randomUUID()};saved=await save(path,candidate,true)?candidate:await load(path);}
      payload.request_id=saved.id;
    }
    print(await api(command,payload));return;
  }
  const id=args[0];if(args.length!==1||!/^[a-f0-9-]{36}$/.test(id||''))throw new Error('请提供一个任务 UUID。');
  if(command==='job'){print(await api('job',{id}));return;}
  const claimPath=join(directory,`claim-${id}.bin`);
  let claim=await load(claimPath);
  if(command==='claim'){
    if(!claim){const candidate={claimId:randomUUID(),receipt:randomBytes(32).toString('hex')};claim=await save(claimPath,candidate,true)?candidate:await load(claimPath);}
    const result=await api('claim',{id,...claim});
    if(output&&result){await privateFile(resolve(output),JSON.stringify(result,null,2));print({event:'material',path:resolve(output),task:result.task});}else print(result);return;
  }
  if(!claim)throw new Error('请先在本机领取该任务。');
  if(!['heartbeat','complete','fail'].includes(command))throw new Error('未知命令，请使用 help。');
  print(await api(command,{...payload,id,receipt:claim.receipt}));
}
main().catch(e=>{console.error(JSON.stringify({error:(e as Error).message}));process.exitCode=1;});
