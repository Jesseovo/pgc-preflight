import {readFile,writeFile,mkdir,rename,chmod,link,unlink,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir,hostname} from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {cleanGameHtml} from '../server/game-generation';

// Authenticated transport and on-demand evidence capture. The user's Agent
// owns all model calls, reasoning, concurrency and session polling.
const origin=new URL(process.env.PGC_ORIGIN||'https://pgc.ovoxin.top').origin;
if(new URL(origin).protocol!=='https:'&&!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))throw new Error('PGC_ORIGIN 必须是 HTTPS 或本机地址。');
const scope=createHash('sha256').update(origin).digest('hex').slice(0,16);
const directory=resolve(process.env.PGC_FORGE_AGENT_DATA||join(process.env.LOCALAPPDATA||join(homedir(),'.config'),'PGC Preflight','forge-agent',scope));
const args=process.argv.slice(2),command=args.shift()||'help';
function option(name:string){const i=args.indexOf(name);if(i<0)return undefined;const v=args[i+1];if(!v||v.startsWith('--'))throw new Error(`${name} 缺少值。`);args.splice(i,2);return v;}
const input=option('--json'),output=option('--out'),gameFile=option('--file'),captureFile=option('--capture');
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
async function privateFile(path:string,text:string|Buffer,exclusive=false){
  const tmp=`${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  try{
    await writeFile(tmp,text,{mode:0o600,flag:'wx'});
    if(exclusive){try{await link(tmp,path);}catch(error){if((error as any).code==='EEXIST')return false;throw error;}}
    else await rename(tmp,path);
    if(process.platform!=='win32')await chmod(path,0o600);
    return true;
  }finally{await unlink(tmp).catch(()=>{});}
}
async function save(path:string,value:any,exclusive=false){return privateFile(path,await secure(JSON.stringify(value)),exclusive);}
async function load(path:string){try{return JSON.parse(await secure(await readFile(path,'utf8'),true));}catch(e){if((e as any).code==='ENOENT')return null;throw e;}}
const stageNames=new Set(['build','polish','repair']);
function jsonPath(path:string){if(!/\.json$/i.test(path))throw new Error('证据和制作材料的输出文件必须为 .json。');return resolve(path);}
async function readJson(path:string){
  const bytes=await readFile(resolve(path));
  if(bytes.length>12*1024*1024)throw new Error('JSON 文件不能超过 12 MB。');
  let value:any;
  try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('请求文件不是有效的 UTF-8 JSON。');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('请求文件必须是 JSON 对象。');
  return value;
}
function imageBytes(data:unknown){
  if(typeof data!=='string')throw new Error('采集材料缺少真实图片。');
  const match=data.match(/^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!match)throw new Error('采集材料的图片格式不正确。');
  const bytes=Buffer.from(match[2],'base64');
  if(!bytes.length||bytes.toString('base64')!==match[2])throw new Error('采集材料的图片编码不正确。');
  return {ext:match[1]==='jpeg'?'jpg':match[1],bytes};
}
async function saveWithImages(path:string, images:Array<{data:string}>, manifest:(paths:string[])=>unknown){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const imageDir=images.length?await mkdtemp(join(dirname(path),'.pgc-forge-images-')):null;
  try{
    const paths=[];
    for(const [index,image] of images.entries()){
      const {ext,bytes}=imageBytes(image.data),target=join(imageDir!,`viewport-${index+1}.${ext}`);
      await privateFile(target,bytes);paths.push(target);
    }
    await privateFile(path,JSON.stringify(manifest(paths),null,2));
    return paths;
  }catch(error){if(imageDir)await rm(imageDir,{recursive:true,force:true}).catch(()=>{});throw error;}
}
async function capture(id:string){
  if(!gameFile||!output||input||captureFile)throw new Error('使用 capture TASK_UUID --file game.html --out evidence.json。');
  if(!/\.html?$/i.test(gameFile))throw new Error('只支持 .html / .htm 游戏文件。');
  const path=jsonPath(output),bytes=await readFile(resolve(gameFile));
  if(!bytes.length||bytes.length>2_400_000)throw new Error('游戏文件大小超出创作交付范围。');
  let raw:string;
  try{raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('游戏文件必须为有效 UTF-8。');}
  const html=cleanGameHtml(raw),inputHash=createHash('sha256').update(html).digest('hex');
  const [{launchLocalBrowser},{captureReview}]=await Promise.all([import('../server/local-browser'),import('../server/review-probe')]);
  const browser=await launchLocalBrowser();
  const result=await captureReview(browser,html,{denyExternal:true}).finally(()=>browser.close().catch(()=>{}));
  const evidence={origin:'member-device',inputHash,...result};
  if(result.shots.length!==4)throw new Error('未获取全部四张真实视口图。');
  const paths=await saveWithImages(path,result.shots,()=>evidence);
  print({event:'capture',id,path,inputHash,images:result.shots.map(({id,label},index)=>({id,label,path:paths[index]}))});
}
async function outputStage(id:string,stage:string,result:any){
  const next=result?.nextMaterials;
  const metadata={event:'creation-stage',id,stage,version_id:result?.version_id??null,
    content_hash:result?.content_hash??null,evidence_hash:result?.evidence_hash??null};
  if(!next&&!output){print({...metadata,complete:result?.complete??null});return;}
  const path=output?jsonPath(output):join(directory,'stages',id,`${stage}-${randomUUID()}.json`);
  const parts=Array.isArray(next?.user)?next.user:[];
  const images=parts.filter((part:any)=>part?.type==='image');
  const paths=await saveWithImages(path,images,files=>{
    let index=0;
    const user=Array.isArray(next?.user)?parts.map((part:any)=>part?.type==='image'?{type:'image',path:files[index++]}:part):next?.user;
    return {...result,...(next?{nextMaterials:{...next,user}}:{})};
  });
  print({...metadata,path,nextStage:next?.stage??null,images:paths,...(!next?{complete:result?.complete??null}:{})});
}
async function main(){
  const mechanismCommands=['mechanisms','mechanism-match','mechanism-judge','mechanism-choose'];
  if(command==='help'){print({commands:['pair (PGC_PAIR_CODE or stdin)','context','draw --json request.json','create --json request.json','jobs','job TASK_UUID','claim TASK_UUID [--out material.json]','heartbeat TASK_UUID [--json progress.json]','capture TASK_UUID --file game.html --out evidence.json','stage TASK_UUID --json stage.json [--capture evidence.json] [--out next.json]','complete TASK_UUID --json result.json','fail TASK_UUID --json error.json','mechanisms [--json page.json]','mechanism-match --json request.json','mechanism-judge --json request.json','mechanism-choose --json request.json'],note:'按需采集实际证据，模型由你的 Agent 调用。凭据和任务回执保存在本机，工具无常驻服务。'});return;}
  if(!['pair','context','draw','create','jobs','job','claim','heartbeat','capture','stage','complete','fail',...mechanismCommands].includes(command))throw new Error('未知命令，请使用 help。');
  await mkdir(directory,{recursive:true,mode:0o700});
  const credentialPath=join(directory,'credential.bin');let credential=await load(credentialPath);
  async function api(action:string,body:any={}){
    const response=await fetch(`${origin}/api/forge-agent/${action}`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential.token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
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
  if(gameFile&&command!=='capture'||captureFile&&command!=='stage')throw new Error('仅 capture 使用 --file，仅 stage 使用 --capture。');
  const payload=input?await readJson(input):{};
  if(['context','jobs'].includes(command)){print(await api(command));return;}
  if(mechanismCommands.includes(command)){
    if(args.length||command!=='mechanisms'&&!input)throw new Error('请按 help 提供机制命令及请求 JSON。');
    const fields=command==='mechanism-judge'?['check_id','judgment','model']:command==='mechanism-match'?['topic_id','candidate_index']:command==='mechanism-choose'?['topic_id','candidate_index','check_id']:['after','limit'];
    const result=await api(command,Object.fromEntries(fields.map(key=>[key,payload[key]])));
    if(output){const path=jsonPath(output);await privateFile(path,JSON.stringify(result,null,2));print({event:command,path});}else print(result);
    return;
  }
  if(['draw','create'].includes(command)){
    payload.creative_version??=2;
    if(!payload.request_id){
      const keyPayload={...payload};if(keyPayload.creative_version===1)delete keyPayload.creative_version;
      const key=createHash('sha256').update(command).update(JSON.stringify(keyPayload)).digest('hex'),path=join(directory,`request-${key}.bin`);
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
  if(command==='capture'){await capture(id);return;}
  if(command==='stage'){
    if(!input||!stageNames.has(payload.stage)||!payload.output||typeof payload.output!=='object'||Array.isArray(payload.output)||
      typeof payload.output.html!=='string'||!(payload.model===null||typeof payload.model==='string'&&payload.model.trim())||
      captureFile&&payload.capture!==undefined)throw new Error('stage 需要 stage、output、实际 model（未知填 null）和唯一一份采集证据。');
    if(output)jsonPath(output);
    const evidence=captureFile?await readJson(captureFile):payload.capture;
    if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)||evidence.origin!=='member-device'||
      !/^[a-f0-9]{64}$/.test(evidence.inputHash||'')||!Array.isArray(evidence.shots)||evidence.shots.length!==4)throw new Error('请提供 capture 生成的四张图和对应的 HTML 摘要。');
    if(createHash('sha256').update(cleanGameHtml(payload.output.html)).digest('hex')!==evidence.inputHash)throw new Error('阶段 HTML 与采集文件不一致，请重新采集该阶段。');
    const result=await api('creation-stage',{id,receipt:claim.receipt,stage:payload.stage,output:payload.output,model:payload.model,
      capture:{origin:evidence.origin,inputHash:evidence.inputHash,shots:evidence.shots,probe:evidence.probe}});
    await outputStage(id,payload.stage,result);return;
  }
  if(!['heartbeat','complete','fail'].includes(command))throw new Error('未知命令，请使用 help。');
  print(await api(command,{...payload,id,receipt:claim.receipt}));
}
main().catch(e=>{console.error(JSON.stringify({error:(e as Error).message}));process.exitCode=1;});
