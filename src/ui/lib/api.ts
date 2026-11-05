import {useCallback,useEffect,useRef,useState} from 'react';
import {scheduleRead} from './polling';
import {clearNavigationData,configureNavigationData,consumePrefetched,peekResource} from './navigation-data';

export class ApiError extends Error {constructor(message:string,public status:number){super(message);}}
export async function api<T=any>(path:string,options:{method?:string;body?:unknown;signal?:AbortSignal}={}):Promise<T>{
  const form=options.body instanceof FormData||options.body instanceof Blob;
  const response=await fetch(path,{method:options.method||'GET',credentials:'same-origin',cache:'no-store',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),headers:options.body!==undefined&&!form?{'Content-Type':'application/json'}:undefined,body:options.body===undefined?undefined:form?options.body as BodyInit:JSON.stringify(options.body)});
  const data=await response.json().catch(()=>null);
  if(!response.ok){if(response.status===401){clearNavigationData();window.dispatchEvent(new Event('pgc-session-expired'));}throw new ApiError(data?.error||data?.message||`请求未完成（${response.status}）`,response.status);}
  if(options.method&&options.method!=='GET')clearNavigationData();
  return data as T;
}
configureNavigationData((path,options)=>api(path,options));
export function useResource<T=any>(path:string|null,options:{interval?:number}={}){
  const [data,setData]=useState<T|undefined>(()=>peekResource<T>(path)),[loading,setLoading]=useState(!!path),[error,setError]=useState<string|null>(null),[revision,setRevision]=useState(0);
  const reload=useCallback(()=>setRevision(n=>n+1),[]);
  const pathRef=useRef(path);
  const seed=useRef({path,revision,value:peekResource<T>(path)});
  useEffect(()=>{
    let disposed=false,controller:AbortController|null=null,cancelPoll:(()=>void)|undefined,failures=0;
    if(seed.current.path!==path||seed.current.revision!==revision)seed.current={path,revision,value:seed.current.path===path?undefined:consumePrefetched<T>(path)};
    if(pathRef.current!==path){setData(seed.current.value);pathRef.current=path;}
    if(!path){setLoading(false);setError(null);return;}
    const read=async()=>{
      if(disposed||controller)return;
      controller=new AbortController();
      try{const result=await api<T>(path,{signal:controller.signal});if(!disposed){setData(result);seed.current={path,revision,value:result};setError(null);failures=0;}}
      catch(e){if(!disposed&&(e as Error).name!=='AbortError'){setError((e as Error).message);failures++;}}
      finally{controller=null;if(!disposed){setLoading(false);if(options.interval)cancelPoll=scheduleRead(()=>void read(),Math.min(60000,options.interval*2**Math.min(failures,4)));}}
    };
    const prepared=seed.current.value??consumePrefetched<T>(path);
    if(prepared!==undefined){seed.current={path,revision,value:prepared};setData(prepared);setLoading(false);setError(null);if(options.interval)cancelPoll=scheduleRead(()=>void read(),options.interval);}
    else {setLoading(true);void read();}
    return()=>{disposed=true;cancelPoll?.();controller?.abort();};
  },[path,revision,options.interval]);
  return{data:pathRef.current===path?data:peekResource<T>(path),loading:pathRef.current!==path||loading,error:pathRef.current===path?error:null,reload,setData};
}
export function toast(message:string,tone:'success'|'error'|'info'='info'){window.dispatchEvent(new CustomEvent('pgc-notice',{detail:{message,tone}}));}
export function useAction(){
  const locked=useRef(false);const[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const run=useCallback(async<T,>(action:()=>Promise<T>):Promise<T|undefined>=>{
    if(locked.current)return;locked.current=true;setBusy(true);setError(null);
    try{return await action();}catch(e){const message=(e as Error).message||'操作未完成，请重试。';setError(message);toast(message,'error');return undefined;}finally{locked.current=false;setBusy(false);}
  },[]);return{busy,error,run};
}
export async function copyText(text:string){try{await navigator.clipboard.writeText(text);toast('已复制','success');return true;}catch{toast('无法访问剪贴板，请手动选择并复制。','error');return false;}}
export function downloadText(name:string,text:string,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function formatDate(value:unknown){if(!value)return '时间未知';const date=new Date(String(value));return Number.isNaN(date.valueOf())?String(value):date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});}
