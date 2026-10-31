import {createPageNavigation,prepareReviewReads} from './navigation.js';
import {renderSquare,prepareSquare} from './square-route.js';
import {mountMemberShell} from './member-shell.js';
import { mountReviewWorkspace } from './review-workspace.js';
import { probeChecks } from './review-capture.js';
import { withProgress } from './progress.js';

// 普通成员共用审核与广场外壳，路由切换不重新建立会话。
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, data) {
  const response = await fetch('/api/forge/' + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(60000),
  });
  let value;
  try { value = await response.json(); } catch { throw new Error('审核服务暂时无响应，请稍后重试。'); }
  if (response.status === 401) location.replace('/login');
  if (!response.ok) throw Object.assign(new Error(value.error || '请求未完成，请稍后重试。'), { status: response.status });
  return value;
}
function toast(message) {
  const node = $('#toast'); node.textContent = message; node.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 3500);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { toast('复制失败，请手动选择文字复制。'); }
}
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function openModal(title, html) {
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').hidden = false;
}
$('#modalClose').onclick = () => { $('#modal').hidden = true; };
$('#modal').onclick = event => { if (event.target === $('#modal')) $('#modal').hidden = true; };
$('#loginForm').onsubmit = event => { event.preventDefault(); location.replace('/login'); };
let shell,user,sequence=0,cleanup;
const positions=new Map(),pageNavigation=createPageNavigation($('#view'));
history.scrollRestoration='manual';let scrollTimer;
window.addEventListener('scroll',()=>{if(pageNavigation.pending)return;clearTimeout(scrollTimer);const url=location.href;scrollTimer=setTimeout(()=>{if(!pageNavigation.pending&&url===location.href)history.replaceState({...history.state,scrollY},'',url);},100);},{passive:true});
async function render(){
 const ticket=++sequence,alive=()=>ticket===sequence,square=location.pathname.startsWith('/square');
 const navigation=pageNavigation.begin({alive,scrollTop:history.state?.scrollY||0,label:square?'正在打开游戏广场':'正在打开我的审核',onCommit(){
  document.querySelector('.member-square')?.setAttribute('aria-current',square?'page':'false');document.querySelector('.member-nav a[href="/"]')?.setAttribute('aria-current',square?'false':'page');
  document.title=(square?'游戏广场':'我的审核')+' · PGC Preflight';$('#view').dataset.page=square?'square':'review';
 }});
 cleanup?.();cleanup=undefined;$('#modal').hidden=true;$('#modalBody').replaceChildren();
 try{
  if(square){const dispose=await renderSquare($('#view'),user,alive,navigation.commit);if(alive())cleanup=dispose;else dispose?.();}
  else{
   const prepared=await prepareReviewReads(api);if(!alive())return;
   await navigation.commit(async()=>{const dispose=await mountReviewWorkspace({
    view:$('#view'),api:prepared,allowUpload:false,alive,awaitInitial:true,topics:[],setProbing:()=>{},probeChecks,copyText,download,openModal,
    checksHtml:checks=>`<ul class="checks">${checks.map(check=>`<li><span>${check.level==='ok'?'✓':'·'}</span><span>${escape(check.text)}</span></li>`).join('')}</ul>`,
   });if(alive())cleanup=dispose;else dispose?.();});
  }
 }catch(error){if(alive())await navigation.commit(()=>{$('#view').innerHTML=`<div class="box bad" role="alert"><p>${escape(error.message)}</p><button class="ghost" data-route-retry>重新读取</button></div>`;$('#view [data-route-retry]').onclick=()=>void render();});}
 finally{navigation.finish();}
}
function navigate(square){
 const section=location.pathname.startsWith('/square')?'square':'review';if(square===(section==='square'))return;
 clearTimeout(scrollTimer);if(!pageNavigation.pending){positions.set(section,{url:location.pathname+location.search,scrollY});history.replaceState({...history.state,scrollY},'',location.href);}
 const remembered=positions.get(square?'square':'review');history.pushState({scrollY:remembered?.scrollY||0},'',remembered?.url||(square?'/square':'/'));void render();
}
window.addEventListener('popstate',()=>void render());
withProgress('连接审核工作台',async()=>{const response=await fetch('/api/auth/me');if(!response.ok){location.replace('/login');return;}user=await response.json();shell=mountMemberShell(user,location.pathname.startsWith('/square')?'square':'review',{onSquare:()=>navigate(true),onReview:()=>navigate(false),prepareSquare});await render();shell?.restore();},{compact:true,tray:false}).catch(error=>{$('#view').textContent=error.message;});
