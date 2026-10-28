import './style.css';
import './admin.css';
import './admin/shell.css';
import {createIcons,icons} from 'lucide';
import {progressHtml,withProgress} from './progress';
import {mountContent} from './admin/content';
import {mountManagement} from './admin/manage';
import {mountOverview} from './admin/overview';
import type {AdminContext,AdminRoute,AdminView} from './admin/contracts';

const app=document.querySelector<HTMLElement>('#app')!;
const labels:Record<AdminView,string>={overview:'总览',works:'作品',tasks:'任务',reviews:'审核',members:'成员',settings:'平台设置'};
const navIcons:Record<AdminView,string>={overview:'layout-dashboard',works:'gamepad-2',tasks:'workflow',reviews:'clipboard-check',members:'users',settings:'settings-2'};
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let route=readRoute(),controller=new AbortController(),cleanup:(()=>void)|undefined;
let generation=0,pollTimer:ReturnType<typeof setTimeout>|undefined,refresh:(()=>Promise<void>)|null=null;
let refreshMode:'active'|'agent'|'idle'='idle',failures=0,refreshing=false,pollFailed=false,toastTimer:ReturnType<typeof setTimeout>|undefined,authenticated=false;

function readRoute():AdminRoute{
  const q=new URLSearchParams(location.search),view=(Object.keys(labels).includes(q.get('view')||'')?q.get('view'):'overview') as AdminView,range=q.get('range');
  return {view,range:(['today','7d','30d','all'].includes(range||'')?range:view==='overview'?'today':'all') as AdminRoute['range'],owner:q.get('owner')||'',q:q.get('q')||'',status:q.get('status')||'all',type:q.get('type')||'all',page:Math.max(1,Number.parseInt(q.get('page')||'1',10)||1),id:q.get('id')||undefined,panel:q.get('panel')||undefined,version:q.get('version')||undefined,layout:q.get('layout')==='list'?'list':'grid',section:q.get('section')||undefined};
}
function routeUrl(value:AdminRoute){const q=new URLSearchParams({view:value.view});for(const[key,val]of Object.entries(value)){if(key==='view'||val===undefined||val===''||val==='all'||(key==='page'&&val===1)||(key==='layout'&&val==='grid'))continue;q.set(key,String(val));}return '/admin?'+q;}
function destroyView(){controller.abort();controller=new AbortController();cleanup?.();cleanup=undefined;clearTimeout(pollTimer);refresh=null;refreshMode='idle';refreshing=false;failures=0;document.querySelector('#admin-view')?.querySelectorAll('iframe').forEach(f=>f.remove());}
function navigate(changes:Partial<AdminRoute>,replace=false){
  history.replaceState({...history.state,scrollY:scrollY},'',location.href);
  if(Object.hasOwn(changes,'id')&&changes.id===undefined&&route.id&&history.state?.returnUrl&&changes.view===undefined){const state=history.state;history.pushState({scrollY:state.returnScroll||0},'',state.returnUrl);void renderView(true);return;}
  const base=changes.view&&changes.view!==route.view?{...route,id:undefined,panel:undefined,version:undefined,section:undefined,status:'all',type:'all',q:'',page:1,range:changes.view==='overview'?'today':'all'}:route;
  const next={...base,...changes} as AdminRoute,newState:any={scrollY:0};
  if(!route.id&&next.id){newState.returnUrl=location.pathname+location.search;newState.returnScroll=scrollY;}
  else if(route.id&&next.id&&history.state?.returnUrl){newState.returnUrl=history.state.returnUrl;newState.returnScroll=history.state.returnScroll;}
  if(replace)history.replaceState({...history.state,...newState},'',routeUrl(next));else history.pushState(newState,'',routeUrl(next));void renderView(false);
}
function notice(message:string,error=false){const el=document.querySelector<HTMLElement>('#admin-notice');if(!el)return;clearTimeout(toastTimer);el.textContent=message;el.classList.toggle('error',error);el.hidden=false;toastTimer=setTimeout(()=>{el.hidden=true;},error?8000:4000);}
async function api<T=any>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(path.startsWith('/api/')?path:'/api/admin/'+path,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal}).catch(error=>{if(refreshing&&!signal?.aborted)pollFailed=true;throw error;});
  const value=await response.json().catch(()=>({error:'服务返回了无法读取的响应，请刷新重试。'}));
  if(response.status===401&&path!=='login'){authenticated=false;destroyView();renderLogin('登录已过期，请重新登录。');throw new Error('登录已过期。');}
  if(!response.ok){if(refreshing)pollFailed=true;throw new Error(value.error||`请求未完成（${response.status}）`);}return value as T;
}
function scheduleRefresh(){clearTimeout(pollTimer);if(!refresh||refreshMode==='idle'||document.hidden)return;const delay=Math.min(60000,(refreshMode==='agent'?60000:10000)*2**failures);pollTimer=setTimeout(()=>void runRefresh(),delay);}
async function runRefresh(){if(!refresh||refreshing||document.hidden)return;refreshing=true;pollFailed=false;const own=generation;try{await refresh();if(own===generation){if(pollFailed)throw new Error('refresh failed');failures=0;const el=document.querySelector('#admin-poll-state');if(el)el.textContent='';}}catch{if(own===generation){failures=Math.min(4,failures+1);const el=document.querySelector('#admin-poll-state');if(el)el.textContent='连接暂不可用，正在重试';}}finally{if(own===generation){refreshing=false;scheduleRefresh();}}}
function renderShell(){
  authenticated=true;app.className='admin-app';
  app.innerHTML=`<div class="adm-shell"><aside class="adm-sidebar"><a class="adm-brand" href="/admin"><img src="/artwork/pixel-cat.png" width="35" height="35" alt=""><span>PGC <b>OverFlow</b><small>团队工作台</small></span></a><div class="adm-nav-caption">工作空间</div><nav aria-label="管理导航">${Object.entries(labels).map(([key,label])=>`<button type="button" data-admin-view="${key}" id="tab-${key}"><i data-lucide="${navIcons[key as AdminView]}"></i><span>${label}</span>${key==='tasks'?'<b class="adm-nav-count" id="admin-task-count" hidden></b>':''}</button>`).join('')}</nav><div class="adm-sidebar-bottom"><a href="/square"><i data-lucide="compass"></i>游戏广场</a><button type="button" id="admin-logout"><i data-lucide="log-out"></i>退出登录</button><div class="adm-user"><span>J</span><div>超级管理员<small>团队管理权限</small></div><i data-lucide="shield-check"></i></div></div></aside><main class="adm-main"><header class="adm-topbar"><button class="adm-mobile-toggle" id="admin-menu" aria-label="展开导航" aria-expanded="false"><i data-lucide="menu"></i></button><div class="adm-breadcrumb">工作空间 <span>/</span> <b id="admin-location">总览</b></div><div class="adm-topbar-right"><span id="admin-poll-state"></span><time>${new Date().toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'short'})}</time><span class="adm-admin-dot" title="管理员会话">J</span></div></header><div class="adm-view" id="admin-view"></div><footer class="adm-footer">PGC OverFlow <span>把好想法，做成好游戏。</span></footer></main></div><div id="admin-notice" class="adm-notice" role="status" hidden></div>`;
  for(const button of app.querySelectorAll<HTMLButtonElement>('[data-admin-view]'))button.onclick=()=>navigate({view:button.dataset.adminView as AdminView,id:undefined,owner:'',q:'',status:'all',type:'all',page:1});
  app.querySelector<HTMLButtonElement>('#admin-menu')!.onclick=()=>{const open=app.classList.toggle('nav-open');app.querySelector('#admin-menu')!.setAttribute('aria-expanded',String(open));};
  app.querySelector<HTMLButtonElement>('#admin-logout')!.onclick=async()=>{try{await api('logout','POST');destroyView();authenticated=false;renderLogin();}catch(e){notice(String(e),true);}};
  createIcons({icons,attrs:{'stroke-width':1.7}});void renderView(true);
}
async function renderView(restoreScroll=false){
  if(!authenticated)return;destroyView();route=readRoute();const own=++generation,root=document.querySelector<HTMLElement>('#admin-view')!;app.classList.remove('nav-open');
  document.querySelector('#admin-menu')?.setAttribute('aria-expanded','false');document.querySelector('#admin-location')!.textContent=labels[route.view];document.title=`${labels[route.view]} · PGC OverFlow`;
  for(const button of app.querySelectorAll<HTMLButtonElement>('[data-admin-view]')){const selected=button.dataset.adminView===route.view;button.classList.toggle('active',selected);button.setAttribute('aria-current',selected?'page':'false');}
  document.querySelector('#admin-poll-state')!.textContent='';root.innerHTML=`<div class="adm-skeleton" aria-label="正在读取${labels[route.view]}"><div></div><div></div><div></div></div>`;
  const signal=controller.signal;
  const ctx:AdminContext={root,route,signal,api:(path,method,body)=>api(path,method,body,signal),navigate,notice,setRefresh(callback,mode='idle'){if(own!==generation)return;refresh=callback;refreshMode=mode;scheduleRefresh();}};
  try{const result=await(route.view==='overview'?mountOverview(ctx):['works','tasks'].includes(route.view)?mountContent(ctx):mountManagement(ctx));if(own!==generation){if(typeof result==='function')result();return;}cleanup=typeof result==='function'?result:undefined;requestAnimationFrame(()=>{if(own===generation)window.scrollTo({top:restoreScroll?history.state?.scrollY||0:0,behavior:'instant'});});}
  catch(error){if(own!==generation||controller.signal.aborted)return;root.innerHTML=`<section class="adm-error"><h2>暂时无法读取${labels[route.view]}</h2><p>${escape(error instanceof Error?error.message:error)}</p><button class="adm-button" id="admin-view-retry">重新读取</button></section>`;root.querySelector<HTMLButtonElement>('button')!.onclick=()=>void renderView(true);}
}
function renderLogin(message=''){
  app.className='admin-app';app.innerHTML=`<main class="adm-login"><a class="adm-brand" href="/admin"><img src="/artwork/pixel-cat.png" width="38" height="38" alt=""><span>PGC <b>OverFlow</b></span></a><section><span class="adm-eyebrow">团队工作台</span><h1>欢迎回来</h1><p>登录后查看团队进展与作品。</p><form id="login-form"><label class="adm-field">管理员密码<input id="admin-password" type="password" required autocomplete="current-password" maxlength="500"></label><button class="adm-button primary" type="submit">进入工作台 <span>→</span></button><p id="login-message" role="status">${escape(message)}</p></form></section></main>`;
  app.querySelector<HTMLFormElement>('form')!.onsubmit=event=>{event.preventDefault();const button=app.querySelector<HTMLButtonElement>('button')!;button.disabled=true;void withProgress('管理员登录',async()=>{await api('login','POST',{password:app.querySelector<HTMLInputElement>('input')!.value});renderShell();},{compact:true}).catch(error=>{const target=app.querySelector('#login-message');if(target)target.textContent=String(error.message||error);}).finally(()=>{button.disabled=false;});};
}
window.addEventListener('popstate',()=>void renderView(true));document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(pollTimer);else if(refresh)void runRefresh();});
async function init(){app.className='admin-app';app.innerHTML=`<div class="adm-initial">${progressHtml({label:'正在打开管理工作台',detail:'正在确认登录状态…'})}</div>`;try{const response=await fetch('/api/auth/me',{cache:'no-store'});if(response.status===401){renderLogin();return;}const user=await response.json();if(!response.ok||user.role!=='admin'){renderLogin('请使用管理员身份登录。');return;}renderShell();}catch{renderLogin('管理服务暂不可用，请重试。');}}
void init();
