// One timer per document; each mounted reader retains its own due time/backoff.
const pending=new Map<object,{at:number;read:()=>void}>();
let timer:ReturnType<typeof setTimeout>|undefined;
const available=()=>!document.hidden&&navigator.onLine;
function arm(){clearTimeout(timer);if(!pending.size||!available())return;const at=Math.min(...Array.from(pending.values(),item=>item.at));timer=setTimeout(()=>{timer=undefined;const now=Date.now();for(const[key,item]of pending)if(item.at<=now){pending.delete(key);item.read();}arm();},Math.max(0,at-Date.now()));}
export function scheduleRead(read:()=>void,delay:number){const key={};pending.set(key,{at:Date.now()+delay,read});arm();return()=>{pending.delete(key);arm();};}
if(typeof document!=='undefined'){const wake=()=>{if(available())for(const item of pending.values())item.at=Date.now();arm();};document.addEventListener('visibilitychange',wake);window.addEventListener('online',wake);window.addEventListener('offline',arm);}
