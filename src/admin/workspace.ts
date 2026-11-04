import {createIcons,LayoutDashboard,Gamepad2,Workflow,ClipboardCheck,Users,Settings2,Compass,LogOut,ShieldCheck,Menu} from 'lucide';
import {createReadCache} from '../../public/forge/experience.js';
const icons={LayoutDashboard,Gamepad2,Workflow,ClipboardCheck,Users,Settings2,Compass,LogOut,ShieldCheck,Menu};
const reads=createReadCache();
import {progressHtml,withProgress} from '../progress';
import {mountContent,contentListRequest} from './content';
import {mountManagement} from './manage';
import {mountFeedback} from './feedback';
import {mountOverview} from './overview';
import {baseRoute,detailTarget,inspectorRoute,readRoute,routeUrl,viewLabels} from './navigation';
import type {AdminContext,AdminInspector,AdminProjectSequence,AdminRoute,AdminView} from './contracts';

type Slot={controller:AbortController;cleanup?:()=>void;refresh:(()=>Promise<void>)|null;mode:'active'|'agent'|'idle';failures:number;busy:boolean;pollFailed:boolean;nextAt:number};
type TrailEntry={target:AdminInspector;scrollTop:number};
type ViewMemory=Partial<Record<AdminView,{url:string;scrollY:number}>>;
const memoryKey='pgc-admin-navigation-v1';
const app=document.querySelector<HTMLElement>('#app')!;
const navIcons:Record<AdminView,string>={overview:'layout-dashboard',works:'gamepad-2',tasks:'workflow',reviews:'clipboard-check',feedback:'clipboard-check',members:'users',settings:'settings-2'};
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let route=readRoute(location.search),main:Slot|undefined,detail:Slot|undefined,mainUrl='',authenticated=false;
let pollTimer:ReturnType<typeof setTimeout>|undefined,toastTimer:ReturnType<typeof setTimeout>|undefined;
let projects:AdminProjectSequence=[],returnFocus:HTMLElement|null=null,pendingClose=false,closingInspector=false,restoringScroll=false;
let detailFocus:{attribute:string;value:string}|undefined;
let refreshMainAfterClose=false;
const slot=():Slot=>({controller:new AbortController(),refresh:null,mode:'idle',failures:0,busy:false,pollFailed:false,nextAt:0});
const currentSlot=()=>route.inspector?detail:main;
const dialog=()=>document.querySelector<HTMLDialogElement>('#admin-inspector');
const detailBody=()=>document.querySelector<HTMLElement>('#admin-inspector-body');
const desktop=matchMedia('(min-width:1024px)');
const trail=():TrailEntry[]=>history.state?.inspectorTrail||[];
const inspectorLabel=(i:AdminInspector)=>i.kind==='project'?'作品':i.kind==='task'?'任务':'审核报告';
history.scrollRestoration='manual';

function syncMasterLayout(){
  const active=desktop.matches&&!route.id&&['works','tasks','reviews'].includes(route.view)&&(route.layout!=='grid'||!!route.inspector);
  app.classList.toggle('master-detail',active);
  const empty=document.querySelector<HTMLElement>('#admin-empty-detail');
  if(empty){
    empty.hidden=!active||!!route.inspector;
    if(!empty.hidden){const label=route.view==='works'?'作品':route.view==='tasks'?'任务':'审核记录';empty.innerHTML=`<div><span aria-hidden="true">←</span><h2>选择${route.view==='works'?'一款':'一项'}${label}</h2><p>${route.view==='works'?'点击左侧作品，在这里试玩，或查看创作材料和审核结果。':route.view==='tasks'?'点击左侧任务，查看执行状态、结果和后续操作。':'点击左侧游戏标题，查看审核报告；未完成的记录可查看任务状态。'}</p></div>`;}
  }
}

function readMemory():ViewMemory{try{return JSON.parse(sessionStorage.getItem(memoryKey)||'{}');}catch{return {};}}
function clearMemory(){reads.clear();try{sessionStorage.removeItem(memoryKey);}catch{/* Storage may be unavailable. */}}
function remember(){
  history.replaceState({...history.state,scrollY:scrollY,inspectorScroll:detailBody()?.scrollTop||0},'',location.href);
  if(route.id)return;
  const memory=readMemory();memory[route.view]={url:routeUrl(baseRoute(route)),scrollY};
  try{sessionStorage.setItem(memoryKey,JSON.stringify(memory));}catch{/* Navigation remains functional without storage. */}
}
function dispose(scope:Slot|undefined){if(!scope)return;scope.controller.abort();scope.cleanup?.();scope.refresh=null;}
function closeDialog(){
  const modal=dialog();if(modal?.open)modal.close();
  document.documentElement.classList.remove('admin-inspector-open');
  app.classList.remove('has-inspector','focus-detail');
  syncMasterLayout();
  highlightSelection();
}
function setInspectorMode(){
  const modal=dialog();if(!modal||!route.inspector)return;
  const needsModal=!desktop.matches;
  const focused=document.activeElement instanceof HTMLElement?document.activeElement:null;
  if(modal.open&&modal.matches(':modal')!==needsModal)modal.close();
  app.classList.add('has-inspector');
  syncMasterLayout();
  document.documentElement.classList.toggle('admin-inspector-open',needsModal);
  if(!modal.open){if(needsModal)modal.showModal();else modal.show();}
  if(focused?.isConnected&&focused!==document.body)focused.focus({preventScroll:true});
  scheduleRefresh();
}
function highlightSelection(){
  const target=route.inspector?(trail()[0]?.target||route.inspector):undefined;
  app.querySelectorAll<HTMLElement>('#admin-view [data-project-id],#admin-view [data-task-id],#admin-view [data-report]').forEach(node=>{
    const selected=target?.kind==='project'?node.dataset.projectId===target.id&&node.dataset.projectType===target.type:target?.kind==='task'?node.dataset.taskId===target.id&&node.dataset.taskType===target.type:target?.kind==='report'?node.dataset.report===target.id:false;
    if(selected)node.setAttribute('aria-current','true');else node.removeAttribute('aria-current');
  });
}
function destroy(){clearTimeout(pollTimer);dispose(detail);detail=undefined;dispose(main);main=undefined;closeDialog();mainUrl='';refreshMainAfterClose=false;}
function notice(message:string,error=false){const el=document.querySelector<HTMLElement>('#admin-notice');if(!el)return;clearTimeout(toastTimer);el.textContent=message;el.classList.toggle('error',error);el.hidden=false;toastTimer=setTimeout(()=>{el.hidden=true;},error?8000:4000);}
async function api<T=any>(path:string,method='GET',body?:unknown,scope?:Slot):Promise<T>{
  try{
    const url=path.startsWith('/api/')?path:'/api/admin/'+path;
    const load=async()=>{
    const response=await fetch(url,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(30000)});
    const value=await response.json().catch(()=>({error:'服务返回了无法读取的响应，请刷新重试。'}));
    if(response.status===403)reads.clear();
    if(response.status===401&&path!=='login'){authenticated=false;clearMemory();destroy();renderLogin('登录已过期，请重新登录。');throw new Error('登录已过期。');}
    if(!response.ok)throw new Error(value.error||`请求未完成（${response.status}）`);
    return value;
    };
    const cacheable=method==='GET'&&/^\/api\/admin\/(projects|tasks|dashboard|members)(?:\?|$|\/(?:topic|game|creation|review)\/[^/]+$)/.test(url);
    if(method!=='GET')reads.clear();
    const value=cacheable?await reads.read(url,load,{fresh:!!scope?.busy,signal:scope?.controller.signal}):await load();
    if(method!=='GET')reads.clear();
    if(method!=='GET'&&scope&&scope===detail){refreshMainAfterClose=true;if(desktop.matches&&main)void refreshScope(main);}
    return value as T;
  }catch(error){if(scope?.busy&&!scope.controller.signal.aborted)scope.pollFailed=true;throw error;}
}
// One timer services both visible desktop panes at their own 10/60-second cadence.
const pollDelay=(scope:Slot)=>Math.min(60000,(scope.mode==='agent'?60000:10000)*2**scope.failures);
function visibleScopes():Slot[]{return desktop.matches&&route.inspector&&app.classList.contains('master-detail')?[main,detail].filter((scope):scope is Slot=>!!scope&&!scope.controller.signal.aborted):[currentSlot()].filter((scope):scope is Slot=>!!scope&&!scope.controller.signal.aborted);}
function scheduleRefresh(){
  clearTimeout(pollTimer);if(document.hidden)return;
  const due=visibleScopes().filter(scope=>scope.refresh&&scope.mode!=='idle'&&!scope.busy).map(scope=>scope.nextAt||Date.now()+pollDelay(scope));
  if(due.length)pollTimer=setTimeout(()=>void runRefresh(),Math.max(0,Math.min(...due)-Date.now()));
}
async function refreshScope(scope:Slot){
  if(!scope.refresh||scope.busy||document.hidden||scope.controller.signal.aborted)return;
  scope.busy=true;scope.pollFailed=false;
  try{await scope.refresh();if(scope.pollFailed)throw new Error('refresh failed');scope.failures=0;if(!scope.controller.signal.aborted)highlightSelection();}
  catch{if(!scope.controller.signal.aborted)scope.failures=Math.min(4,scope.failures+1);}
  finally{scope.busy=false;scope.nextAt=Date.now()+pollDelay(scope);const state=document.querySelector('#admin-poll-state');if(state)state.textContent=visibleScopes().some(item=>item.failures>0)?'连接暂不可用，正在重试':'';scheduleRefresh();}
}
async function runRefresh(force=false){
  if(document.hidden)return;const now=Date.now();
  await Promise.allSettled(visibleScopes().filter(scope=>force||(scope.mode!=='idle'&&scope.nextAt<=now)).map(refreshScope));
}
function context(scope:Slot,root:HTMLElement,value:AdminRoute,inside=false):AdminContext{
  return {root,route:value,signal:scope.controller.signal,api:(path,method,body)=>api(path,method,body,scope),navigate:inside?navigateDetail:navigate,notice,
    setRefresh(callback,mode='idle'){if(scope.controller.signal.aborted)return;const changed=scope.mode!==mode||!scope.nextAt;scope.refresh=callback;scope.mode=mode;if(changed)scope.nextAt=Date.now()+pollDelay(scope);scheduleRefresh();},
    setProjects(items){if(!inside&&!scope.controller.signal.aborted)projects=items.map(p=>({id:p.id,type:p.type,title:p.title,hasGame:p.materials.game}));}};
}
async function mount(ctx:AdminContext){return ctx.route.view==='feedback'?mountFeedback(ctx):ctx.route.view==='overview'?mountOverview(ctx):['works','tasks'].includes(ctx.route.view)?mountContent(ctx):mountManagement(ctx);}
function navigate(changes:Partial<AdminRoute>,replace=false){
  if(!route.id){const target=detailTarget(changes,route);if(target){
    const view=inspectorRoute(target).view;
    if(view!==route.view){
      remember();const next={...readRoute('?view='+view),owner:changes.owner??route.owner};
      if(target.kind==='project'&&projects.some(p=>String(p.id)===target.id&&p.type===target.type&&p.hasGame))next.status='product';
      if(target.kind==='task')next.q=target.id;
      const url=routeUrl(next);history.pushState({scrollY:0},'',url);
      void renderLocation(false).then(()=>{if(mainUrl===url&&!route.inspector)openInspector(target,false,0,true);});
    }else openInspector(target,false,0,true);
    return;
  }}
  remember();
  if(Object.hasOwn(changes,'id')&&changes.id===undefined&&route.id&&history.state?.returnUrl&&!changes.view){
    history.pushState({scrollY:history.state.returnScroll||0},'',history.state.returnUrl);void renderLocation(true);return;
  }
  const changing=changes.view&&changes.view!==route.view;
  const base=changing?readRoute('?view='+changes.view):baseRoute(route);
  const next={...base,...changes,inspector:undefined};
  const state:any={scrollY:0};
  if(!route.id&&next.id){state.returnUrl=routeUrl(baseRoute(route));state.returnScroll=scrollY;}
  else if(route.id&&next.id&&history.state?.returnUrl){state.returnUrl=history.state.returnUrl;state.returnScroll=history.state.returnScroll;}
  if(replace)history.replaceState(state,'',routeUrl(next));else history.pushState(state,'',routeUrl(next));
  void renderLocation(false);
}
function switchView(view:AdminView){
  remember();const saved=readMemory()[view];const next=saved?readRoute(saved.url.split('?')[1]||''):readRoute('?view='+view);
  history.pushState({scrollY:saved?.scrollY||0},'',routeUrl({...next,view,id:undefined,panel:undefined,version:undefined,inspector:undefined}));void renderLocation(true);
}
function initialRead(next:AdminRoute){
  if(next.view==='overview')return 'dashboard?'+new URLSearchParams({range:next.range==='all'?'7d':next.range,owner:next.owner});
  if(next.view==='members')return 'members';
  return contentListRequest(next);
}
function prepareView(view:AdminView){
  const saved=readMemory()[view];
  const next=saved?readRoute(saved.url.split('?')[1]||''):readRoute('?view='+view);
  const path=initialRead({...next,view,id:undefined});
  if(path)void api(path).catch(()=>{});
}
function openInspector(target:AdminInspector,replace=false,restoreTop=0,fromList=false){
  remember();const previous=route.inspector;
  if(fromList&&previous)replace=true;
  if(fromList)returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const entries=previous&&!fromList?[...trail()]:[];
  if(previous&&!replace)entries.push({target:previous,scrollTop:detailBody()?.scrollTop||0});
  const state={...history.state,inspectorTrail:entries,inspectorScroll:restoreTop,
    inspectorDepth:previous?(history.state?.inspectorDepth||0)+(replace?0:1):1,
    inspectorRootHadBase:previous?!!history.state?.inspectorRootHadBase:true,
    projectSequence:previous&&!fromList?history.state?.projectSequence||projects:projects};
  const url=routeUrl({...route,inspector:target});
  if(replace)history.replaceState(state,'',url);else history.pushState(state,'',url);
  route=readRoute(location.search);void renderInspector();
}
function closeInspector(){
  if(!route.inspector||closingInspector)return;
  closingInspector=true;
  const depth=history.state?.inspectorDepth||0;
  if(depth>0){pendingClose=!history.state?.inspectorRootHadBase;history.go(-depth);}
  else{closingInspector=false;history.replaceState({scrollY:history.state?.scrollY||0},'',routeUrl(baseRoute(route)));void renderLocation(true);}
}
function backInspector(){if(trail().length)history.back();else closeInspector();}
function navigateDetail(changes:Partial<AdminRoute>){
  if(!route.inspector)return;
  if(Object.hasOwn(changes,'id')&&changes.id===undefined&&!changes.view){backInspector();return;}
  const current=inspectorRoute(route.inspector),target=detailTarget(changes,current);
  if(target){const same=target.kind===route.inspector.kind&&target.id===route.inspector.id&&target.type===route.inspector.type;openInspector(target,same);return;}
  if(!changes.view&&(Object.hasOwn(changes,'panel')||Object.hasOwn(changes,'version'))){
    detailFocus=changes.version?{attribute:'data-version',value:changes.version}:changes.panel?{attribute:'data-panel',value:changes.panel}:undefined;
    openInspector({...route.inspector,panel:Object.hasOwn(changes,'panel')?changes.panel:route.inspector.panel,version:changes.version},true);return;
  }
  navigate(changes);
}
function renderInspectorHeader(target:AdminInspector){
  const entries=trail(),header=document.querySelector<HTMLElement>('#admin-inspector-header')!;
  const focused=header.contains(document.activeElement)?['data-inspector-prev','data-inspector-next','data-inspector-back','data-inspector-close'].find(key=>document.activeElement?.hasAttribute(key)):undefined;
  const sequence:AdminProjectSequence=history.state?.projectSequence||projects;
  const index=target.kind==='project'?sequence.findIndex(p=>String(p.id)===target.id&&p.type===target.type):-1;
  header.innerHTML=`<div class="adm-inspector-path"><nav aria-label="详情路径">${entries.map((e,i)=>`<button type="button" data-trail="${i}">${inspectorLabel(e.target)}</button><span>/</span>`).join('')}<span id="admin-inspector-title">${inspectorLabel(target)}</span></nav>${entries.length?'<button type="button" class="adm-button quiet" data-inspector-back>返回上一层</button>':''}</div><div class="adm-inspector-tools"><button class="adm-button quiet" type="button" data-focus-detail aria-pressed="${app.classList.contains('focus-detail')}">专注查看</button>${index>=0&&!entries.length?`<div class="adm-inspector-sequence"><span>本页 ${index+1} / ${sequence.length}</span><button type="button" class="adm-icon-button" data-inspector-prev aria-label="上一款作品"${index===0?' disabled':''}>←</button><button type="button" class="adm-icon-button" data-inspector-next aria-label="下一款作品"${index===sequence.length-1?' disabled':''}>→</button></div>`:''}<a class="adm-icon-button" href="${esc(routeUrl(inspectorRoute(target)))}" target="_blank" rel="noopener" aria-label="在新标签页打开完整页面" title="打开完整页面">↗</a><button type="button" class="adm-icon-button" data-inspector-close aria-label="关闭详情" title="关闭详情（Esc）">×</button></div>`;
  header.querySelector<HTMLButtonElement>('[data-focus-detail]')!.onclick=()=>{app.classList.toggle('focus-detail');header.querySelector('[data-focus-detail]')!.setAttribute('aria-pressed',String(app.classList.contains('focus-detail')));};
  header.querySelector<HTMLButtonElement>('[data-inspector-close]')!.onclick=closeInspector;
  header.querySelector<HTMLButtonElement>('[data-inspector-back]')?.addEventListener('click',backInspector);
  header.querySelectorAll<HTMLButtonElement>('[data-trail]').forEach(b=>b.onclick=()=>history.go(-(entries.length-Number(b.dataset.trail))));
  for(const [selector,offset]of [['[data-inspector-prev]',-1],['[data-inspector-next]',1]] as const){header.querySelector<HTMLButtonElement>(selector)?.addEventListener('click',()=>{const p=sequence[index+offset];if(p)openInspector({kind:'project',id:String(p.id),type:p.type,panel:p.hasGame?'game':'overview'},true);});}
  if(focused)(header.querySelector<HTMLElement>(`[${focused}]:not(:disabled)`)||header.querySelector<HTMLElement>('[data-inspector-close]'))?.focus({preventScroll:true});
}
async function renderInspector(){
  const target=route.inspector;
  clearTimeout(pollTimer);dispose(detail);detail=undefined;
  if(!target){
    closeDialog();
    const focus=returnFocus,marker=focus?['data-project-id','data-task-id','data-open-task','data-report'].find(key=>focus.hasAttribute(key)):undefined;
    const markerValue=marker?focus?.getAttribute(marker):undefined;
    const typeAttribute=marker==='data-project-id'?'data-project-type':marker==='data-task-id'?'data-task-type':undefined;
    const typeValue=typeAttribute?focus?.getAttribute(typeAttribute):undefined;
    returnFocus=null;
    if(refreshMainAfterClose){refreshMainAfterClose=false;await runRefresh(true);}
    const restore=focus?.isConnected?focus:marker&&markerValue?document.querySelector<HTMLElement>(`#admin-view [${marker}="${CSS.escape(markerValue)}"]${typeAttribute&&typeValue?`[${typeAttribute}="${CSS.escape(typeValue)}"]`:''}`):null;
    restore?.focus({preventScroll:true});scheduleRefresh();return;
  }
  const modal=dialog()!,body=detailBody()!;
  if(!modal.open&&!returnFocus)returnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
  setInspectorMode();highlightSelection();
  renderInspectorHeader(target);body.innerHTML='<div class="content-loading" role="status">正在加载详情…</div>';
  const own=slot();detail=own;const top=history.state?.inspectorScroll||0,focus=detailFocus;detailFocus=undefined;
  if(!desktop.matches||trail().length)document.querySelector<HTMLButtonElement>('[data-inspector-close]')!.focus({preventScroll:true});
  try{
    const cleanup=await mount(context(own,body,inspectorRoute(target),true));
    if(own.controller.signal.aborted){cleanup?.();return;}own.cleanup=cleanup;
    const fitPlayers=()=>body.querySelectorAll<HTMLElement>('.game-player').forEach(player=>{
      if(player.matches(':fullscreen'))return;
      const stage=player.querySelector<HTMLElement>('.game-player-stage');if(!stage)return;
      const occupied=stage.getBoundingClientRect().top-body.getBoundingClientRect().top+body.scrollTop;
      player.style.setProperty('--game-player-height',Math.max(160,Math.floor(body.clientHeight-occupied-24))+'px');
    });
    const sizeObserver=new ResizeObserver(fitPlayers);sizeObserver.observe(body);
    own.controller.signal.addEventListener('abort',()=>sizeObserver.disconnect(),{once:true});
    // Restore a layer's own scroll without moving the background list.
    requestAnimationFrame(()=>{if(detail===own){body.scrollTop=top;fitPlayers();if(focus)(body.querySelector<HTMLElement>(`[${focus.attribute}="${CSS.escape(focus.value)}"]`)||body.querySelector<HTMLElement>('[data-material-select]'))?.focus({preventScroll:true});scheduleRefresh();}});
  }catch(error){if(own.controller.signal.aborted)return;body.innerHTML=`<div class="content-error" role="alert"><strong>暂时无法读取详情</strong><p>${esc(error instanceof Error?error.message:error)}</p><button type="button" class="adm-button" data-inspector-retry>重新读取</button></div>`;body.querySelector<HTMLButtonElement>('button')!.onclick=()=>void renderInspector();}
}
function renderShell(){
  authenticated=true;app.className='admin-app';
  app.innerHTML=`<div class="adm-shell"><aside class="adm-sidebar"><a class="adm-brand" href="/admin"><img src="/artwork/pixel-cat.png" width="32" height="32" alt=""><span>PGC <b>OverFlow</b><small>团队工作台</small></span></a><div class="adm-nav-caption">工作空间</div><nav aria-label="管理导航">${Object.entries(viewLabels).map(([key,label])=>`<button type="button" data-admin-view="${key}" id="tab-${key}"><i data-lucide="${navIcons[key as AdminView]}"></i><span>${label}</span>${key==='tasks'?'<b class="adm-nav-count" id="admin-task-count" hidden></b>':''}</button>`).join('')}</nav><div class="adm-sidebar-bottom"><a href="/square"><i data-lucide="compass"></i>游戏广场</a><button type="button" id="admin-logout"><i data-lucide="log-out"></i>退出登录</button><div class="adm-user"><span>J</span><div>超级管理员<small>团队管理权限</small></div><i data-lucide="shield-check"></i></div></div></aside><main class="adm-main"><header class="adm-topbar"><button class="adm-mobile-toggle" id="admin-menu" aria-label="展开导航" aria-expanded="false"><i data-lucide="menu"></i></button><div class="adm-breadcrumb">工作空间 <span>/</span> <b id="admin-location">总览</b></div><div class="adm-topbar-right"><span id="admin-poll-state"></span><time>${new Date().toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'short'})}</time><span class="adm-admin-dot" title="管理员会话">J</span></div></header><div class="adm-view" id="admin-view"></div></main></div><section id="admin-empty-detail" class="adm-empty-detail" aria-label="详情" hidden></section><dialog id="admin-inspector" class="adm-inspector" aria-labelledby="admin-inspector-title"><header id="admin-inspector-header"></header><div id="admin-inspector-body" class="adm-inspector-body"></div></dialog><div id="admin-notice" class="adm-notice" role="status" hidden></div>`;
  for(const button of app.querySelectorAll<HTMLButtonElement>('[data-admin-view]')){
    const view=button.dataset.adminView as AdminView;
    button.onclick=()=>switchView(view);
    button.onpointerenter=()=>prepareView(view);
    button.onfocus=()=>prepareView(view);
  }
  app.querySelector<HTMLButtonElement>('#admin-menu')!.onclick=()=>{const open=app.classList.toggle('nav-open');app.querySelector('#admin-menu')!.setAttribute('aria-expanded',String(open));};
  app.querySelector<HTMLButtonElement>('#admin-logout')!.onclick=async()=>{try{await api('logout','POST');clearMemory();destroy();authenticated=false;renderLogin();}catch(e){notice(String(e),true);}};
  const modal=dialog()!;modal.addEventListener('cancel',event=>{event.preventDefault();closeInspector();});
  modal.addEventListener('click',event=>{if(event.target!==modal)return;const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeInspector();});
  detailBody()!.addEventListener('scroll',()=>{if(route.inspector)history.replaceState({...history.state,inspectorScroll:detailBody()!.scrollTop},'',location.href);},{passive:true});
  createIcons({icons,attrs:{'stroke-width':1.6}});void renderLocation(true);
}
async function renderLocation(restoreScroll=false){
  if(!authenticated)return;
  const next=readRoute(location.search),nextBaseUrl=routeUrl(baseRoute(next));
  if(main&&mainUrl===nextBaseUrl){route=next;await renderInspector();if(!route.inspector&&restoreScroll)window.scrollTo({top:history.state?.scrollY||0,behavior:'instant'});return;}
  destroy();route=next;mainUrl=nextBaseUrl;projects=[];syncMasterLayout();
  const own=slot();main=own;const root=document.querySelector<HTMLElement>('#admin-view')!;
  app.classList.remove('nav-open');document.querySelector('#admin-menu')?.setAttribute('aria-expanded','false');
  document.querySelector('#admin-location')!.textContent=viewLabels[route.view];document.title=`${viewLabels[route.view]} · PGC OverFlow`;
  for(const button of app.querySelectorAll<HTMLButtonElement>('[data-admin-view]')){const selected=button.dataset.adminView===route.view;button.classList.toggle('active',selected);button.setAttribute('aria-current',selected?'page':'false');}
  const status=document.querySelector('#admin-poll-state')!;status.textContent='';
  root.inert=true;root.setAttribute('aria-busy','true');
  const loading=setTimeout(()=>{if(!own.controller.signal.aborted)status.textContent=`正在读取${viewLabels[next.view]}…`;},200);
  try{
    // Keep the previous layout until the next list is ready. The mount shares
    // this cached read, so fast navigation never paints an empty skeleton.
    const path=initialRead(baseRoute(next));if(path)await api(path,'GET',undefined,own);
    if(own.controller.signal.aborted)return;
    const cleanup=await mount(context(own,root,baseRoute(route)));
    if(own.controller.signal.aborted){cleanup?.();return;}own.cleanup=cleanup;
    restoringScroll=true;window.scrollTo({top:restoreScroll?history.state?.scrollY||0:0,behavior:'instant'});requestAnimationFrame(()=>{restoringScroll=false;});
    await renderInspector();
  }catch(error){if(own.controller.signal.aborted)return;root.innerHTML=`<section class="adm-error"><h2>暂时无法读取${viewLabels[route.view]}</h2><p>${esc(error instanceof Error?error.message:error)}</p><button class="adm-button" id="admin-view-retry">重新读取</button></section>`;root.querySelector<HTMLButtonElement>('button')!.onclick=()=>{mainUrl='';void renderLocation(true);};}
  finally{clearTimeout(loading);if(main===own){root.inert=false;root.removeAttribute('aria-busy');status.textContent='';}}
}
function renderLogin(message=''){
  app.className='admin-app';app.innerHTML=`<main class="adm-login"><a class="adm-brand" href="/admin"><img src="/artwork/pixel-cat.png" width="32" height="32" alt=""><span>PGC <b>OverFlow</b></span></a><section><h1>欢迎回来</h1><p>登录后查看团队进展与作品。</p><form id="login-form"><label class="adm-field">管理员密码<input id="admin-password" type="password" required autocomplete="current-password" maxlength="500"></label><button class="adm-button primary" type="submit">进入工作台 <span>→</span></button><p id="login-message" role="status">${esc(message)}</p></form></section></main>`;
  app.querySelector<HTMLFormElement>('form')!.onsubmit=event=>{event.preventDefault();const button=app.querySelector<HTMLButtonElement>('button')!;button.disabled=true;void withProgress('管理员登录',async()=>{await api('login','POST',{password:app.querySelector<HTMLInputElement>('input')!.value});renderShell();},{compact:true}).catch(error=>{const target=app.querySelector('#login-message');if(target)target.textContent=String(error.message||error);}).finally(()=>{button.disabled=false;});};
}
window.addEventListener('popstate',()=>{closingInspector=false;if(pendingClose){pendingClose=false;history.replaceState({scrollY:history.state?.scrollY||0},'',routeUrl(baseRoute(readRoute(location.search))));}void renderLocation(true);});
window.addEventListener('scroll',()=>{if(authenticated&&!route.inspector&&!restoringScroll)history.replaceState({...history.state,scrollY},'',location.href);},{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(pollTimer);else if(currentSlot()?.refresh)void runRefresh(true);});
desktop.addEventListener('change',()=>{syncMasterLayout();setInspectorMode();});
document.addEventListener('click',event=>{const menu=document.querySelector<HTMLDetailsElement>('.content-filter-menu[open]');if(menu&&event.target instanceof Node&&!menu.contains(event.target))menu.open=false;});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  const menu=document.querySelector<HTMLDetailsElement>('.content-filter-menu[open]');if(menu){menu.open=false;menu.querySelector<HTMLElement>('summary')?.focus({preventScroll:true});event.preventDefault();return;}
  if(route.inspector&&!dialog()?.matches(':modal')&&!document.querySelector('dialog:modal')){event.preventDefault();closeInspector();}
});
export async function initAdmin(){
  app.className='admin-app';app.innerHTML=`<div class="adm-initial">${progressHtml({label:'正在打开管理工作台',detail:'正在确认登录状态…'})}</div>`;
  try{const response=await fetch('/api/auth/me',{cache:'no-store'});if(response.status===401){clearMemory();renderLogin();return;}const user=await response.json();if(!response.ok||user.role!=='admin'){clearMemory();renderLogin('请使用管理员身份登录。');return;}renderShell();}catch{renderLogin('管理服务暂不可用，请重试。');}
}
