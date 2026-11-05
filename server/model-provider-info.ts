import {decryptKey,modelProfiles,profileId,type ConfigStore} from './settings';

const riffleOrigin='https://riffle-api.pages.dev';
const modelId='claude-opus-5-5';
const maxBytes=128*1024;
const effortValues=new Set(['low','medium','high','xhigh','max','minimal','auto']);
const modeValues=new Set(['adaptive','enabled','disabled','manual','auto','none','budget']);
const modalityValues=new Set(['text','image','audio','video','pdf']);
const protocolValues=new Set(['anthropic','openai']);
const parameterValues=new Set(['max_tokens','max_output_tokens','thinking','output_config','effort','reasoning_effort','temperature','stream','tools','response_format']);
const numberFields=new Set([
  'contextwindow','contextlength','contexttokens','contextlimit','maxcontext','maxcontextlength','maxcontexttokens',
  'maxinput','maxinputtokens','inputlimit','inputtokenlimit','maxinputlength','maxprompttokens','prompttokenlimit',
  'maxoutput','maxoutputlength','maxoutputtokens','outputlimit','outputtokenlimit','maxcompletion','maxcompletiontokens','maxresponsetokens',
  'maxtokens','tokenlimit','maxthinkingtokens','maxreasoningtokens','thinkingbudgettokens','defaultmaxtokens','defaultmaxoutputtokens',
]);
const booleanFields=new Set(['supported','enabled','vision','stream','streaming','tools','tooluse','functioncalling','jsonmode','structuredoutput','adaptivethinking','reasoning','thinking','imageinput','pdfinput']);
const skippedFields=new Set(['id','object','created','ownedby','description','name','displayname','url','logo','provider']);
const sensitive=/secret|tokenhash|apikey|authorization|credential|password|private|accesskey|bearer|^key$/i;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fieldKey=(v:string)=>v.replace(/_/g,'').toLowerCase();

export class ModelProviderInfoError extends Error {
  constructor(message:string,readonly status=400){super(message);}
}

function enumValues(field:string){
  if(/^(?:supported)?(?:reasoning|thinking)?(?:effort|efforts|effortlevels|levels)$/.test(field))return effortValues;
  if(/^(?:supported)?(?:(?:thinking|reasoning)(?:type|mode|types|modes)?|type|mode|types|modes)$/.test(field))return modeValues;
  if(/^(?:supported)?(?:input|output)?modalities$/.test(field))return modalityValues;
  if(/^(?:supported)?protocols?$/.test(field))return protocolValues;
  if(/^(?:supported)?parameters$/.test(field))return parameterValues;
  return null;
}

function safeCapabilities(model:Record<string,unknown>,key:string){
  const capabilities:Record<string,number|boolean|string|string[]>={};
  const fields:Array<{name:string;type:string}>=[];
  function visit(source:Record<string,unknown>,prefix:string,depth:number){
    for(const [name,value] of Object.entries(source)){
      if(fields.length>=80)break;
      const normalized=fieldKey(name);
      if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)||name.includes(key)||sensitive.test(normalized)||skippedFields.has(normalized))continue;
      const path=prefix?prefix+'.'+name:name;
      fields.push({name:path,type:value===null?'null':Array.isArray(value)?'array':typeof value});
      if(typeof value==='boolean'&&(booleanFields.has(normalized)||normalized.startsWith('supports')))capabilities[path]=value;
      else if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&numberFields.has(normalized))capabilities[path]=value;
      else if(object(value)&&depth<3)visit(value,path,depth+1);
      else {
        const allowed=enumValues(normalized==='enum'?fieldKey(prefix.split('.').at(-1)||''):normalized);
        if(allowed&&typeof value==='string'&&value!==key&&allowed.has(value))capabilities[path]=value;
        if(allowed&&Array.isArray(value)){
          const recognized=[...new Set(value.filter(v=>typeof v==='string'&&v!==key&&allowed.has(v)))];
          if(recognized.length)capabilities[path]=recognized;
        }
      }
    }
  }
  visit(model,'',0);
  return {capabilities,fields};
}

async function boundedJson(response:Response,signal:AbortSignal):Promise<unknown>{
  if(Number(response.headers.get('Content-Length'))>maxBytes||!response.body){
    void response.body?.cancel().catch(()=>{});
    throw new ModelProviderInfoError('模型列表为空或超过安全读取上限。',502);
  }
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0,text='';
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  try{
    while(true){
      signal.throwIfAborted();
      const part=await reader.read();
      signal.throwIfAborted();
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>maxBytes)throw new ModelProviderInfoError('模型列表超过安全读取上限。',502);
      text+=decoder.decode(part.value,{stream:true});
    }
    return JSON.parse(text+decoder.decode());
  }catch(error){
    cancel();
    if(error instanceof ModelProviderInfoError)throw error;
    throw new ModelProviderInfoError(signal.aborted?'模型列表请求超时。':'模型列表返回格式异常。',signal.aborted?504:502);
  }finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}

export async function modelProviderInfo(store:ConfigStore,secret:string,id:unknown){
  let profile:string;
  try{profile=profileId(id);}catch{throw new ModelProviderInfoError('请选择有效的模型配置。');}
  const configured=modelProfiles(await store.get())[profile];
  if(!configured?.encryptedKey)throw new ModelProviderInfoError('请先保存该模型的 Key。',409);
  let origin:string|null=null;
  try{
    const url=new URL(configured.baseUrl);
    if(!url.username&&!url.password)origin=url.origin;
  }catch{/* An invalid stored URL cannot authorize the provider request. */}
  if(origin!==riffleOrigin||configured.protocol!=='anthropic'||configured.model.toLowerCase()!==modelId)throw new ModelProviderInfoError('模型能力查询仅支持 Riffle Claude Opus 5.5 配置。');
  let key:string;
  try{key=await decryptKey(configured.encryptedKey,secret);}catch{throw new ModelProviderInfoError('无法读取已保存的模型 Key。',503);}
  if(!key)throw new ModelProviderInfoError('请先保存该模型的 Key。',409);
  const signal=AbortSignal.timeout(15_000);
  let response:Response;
  try{
    response=await fetch(riffleOrigin+'/v1/models',{method:'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'manual',signal});
  }catch{
    throw new ModelProviderInfoError(signal.aborted?'模型列表请求超时。':'无法连接模型列表。',signal.aborted?504:502);
  }
  if(!response.ok){
    void response.body?.cancel().catch(()=>{});
    throw new ModelProviderInfoError(response.status>=300&&response.status<400?'模型列表返回跳转，已拒绝。':'模型列表请求失败。',502);
  }
  const payload=await boundedJson(response,signal);
  const items=Array.isArray(payload)?payload:object(payload)?payload.data??payload.models:null;
  if(!Array.isArray(items))throw new ModelProviderInfoError('模型列表返回格式异常。',502);
  const matches=items.filter(item=>object(item)&&item.id===configured.model);
  if(matches.length!==1)throw new ModelProviderInfoError('模型列表没有唯一匹配当前配置的模型。',502);
  return {profile,model:configured.model,source:'riffle-model-list',...safeCapabilities(matches[0],key),queriedAt:new Date().toISOString()};
}
