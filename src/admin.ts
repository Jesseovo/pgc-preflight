import { withProgress, progressHtml } from './progress';
import {createIcons,icons} from 'lucide';
import './style.css';
import './admin.css';
import {catWalk} from './artwork';
import {mountModelPanel} from './model-panel';

const icon=(name:string)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const app=document.querySelector<HTMLDivElement>('#app')!;
let saved:import('./model-panel').ModelView;
let adminTab:'model'|'members'|'forge'='forge';
const $=<T extends Element=HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
const iconsReady=()=>createIcons({icons,attrs:{'stroke-width':1.7}});
app.innerHTML=`<header class="header"><div class="header-inner"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="34" height="34"/><span>PGC <b>Preflight</b></span><span class="beta">ADMIN</span></a><div class="header-actions"><span class="back-link">${icon('panels-top-left')}团队工作空间</span></div></div></header><main class="admin-main"><section class="intro"><div><div class="eyebrow">CREATOR WORKSPACE</div><h1>从灵感，到下一款游戏<span>。</span></h1><p>选题、制作简报与基础预审，在一个工作台里完成。</p></div>${catWalk}</section><div id="admin-content"><div class="admin-loading">${progressHtml({label:"正在读取管理配置",detail:"正在确认登录状态…"})}</div></div><footer><span>PGC Preflight / Model-driven review</span><span>接口密钥仅保存在服务端 ${icon('lock-keyhole')}</span></footer></main>`;
iconsReady();

async function api(path:string,method='GET',body?:unknown){
  const label=path==='test'?'测试模型连接与图片输入':path==='login'?'管理员登录':path==='logout'?'退出登录':path==='config/active'?'切换全局模型':path==='config/routes'?'保存模型用途':path==='config/profile'?'删除模型配置':path==='config'?(method==='GET'?'读取模型配置':'保存模型配置'):path==='members'?(method==='GET'?'读取成员列表':'开通成员账号'):'更新成员权限与账号';
  return withProgress(label, async progress => {
  const response=await fetch(`/api/admin/${path}`,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(response.status===401&&path!=='login'){progress.dismiss();renderLogin();throw new Error('登录已过期，请重新登录。');}
  if(!response.ok)throw new Error(data.error||'请求未完成，请稍后重试。');
  return data;
  }, {compact:true,detail:path==='test'?'正在请求模型并验证图片输入，请等待接口返回。':'正在连接管理服务…'});
}
async function init(){try{saved=await api('config');renderSettings();}catch(error){if(!document.querySelector('#login-form'))renderLogin(error instanceof Error?error.message:'管理服务暂不可用。');}}
void init();

function renderLogin(initialMessage=''){
  $('#admin-content').innerHTML=`<section class="login-card"><div class="login-card-heading"><div class="login-symbol">${icon('key-round')}</div><div><h2>管理员登录</h2><p>管理模型与团队账号</p></div></div><form id="login-form" class="auth-form"><div class="auth-field"><label for="admin-password">管理密码</label><input id="admin-password" type="password" autocomplete="current-password" placeholder="输入管理密码" required maxlength="500"/></div><button class="primary-button" type="submit"><span>进入管理页</span>${icon('arrow-right')}</button><p id="login-message" class="form-message" role="status">${escape(initialMessage)}</p></form><div class="login-foot">${icon('shield-check')}登录状态保留 8 小时</div></section>`;
  iconsReady();
  $('#login-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$<HTMLButtonElement>('#login-form button');button.disabled=true;
    try{await api('login','POST',{password:$<HTMLInputElement>('#admin-password').value});saved=await api('config');renderSettings();}
    catch(error){$('#login-message').textContent=error instanceof Error?error.message:'登录失败。';}
    finally{button.disabled=false;}
  });
}
function renderSettings(){
  $('#admin-content').innerHTML='<nav class="admin-tabs" aria-label="管理功能"><button id="tab-forge">'+icon('sparkles')+'创作工作台</button><button id="tab-model">'+icon('brain-circuit')+'模型配置</button><button id="tab-members">'+icon('users')+'成员管理</button><button id="logout" class="admin-logout">'+icon('log-out')+'退出</button></nav><div id="model-panel" hidden></div><section id="members-panel" hidden></section><section id="forge-panel"><div class="forge-embed-heading"><div><span class="eyebrow">PGC FORGE</span><h2>选题与作品工作台</h2><p>从灵感到成品，使用统一配置的模型。</p></div></div><div id="forge-loading" class="pgc-inline-wait"></div><iframe id="forge-embed" title="PGC Forge 管理工作台" src="/forge/?embedded=1"></iframe></section>';
  mountModelPanel($('#model-panel'),saved,api,value=>{saved=value;});
  $('#forge-loading').innerHTML=progressHtml({label:'加载创作工作台',detail:'正在读取工作台页面…'});
  $('#forge-embed').addEventListener('load',()=>{if(document.querySelector('#forge-loading'))$('#forge-loading').hidden=true;});
  const selectTab=(name:'model'|'members'|'forge')=>{
    adminTab=name; $('#model-panel').hidden=name!=='model';$('#members-panel').hidden=name!=='members';$('#forge-panel').hidden=name!=='forge';
    for(const [id,active] of [['tab-model',name==='model'],['tab-members',name==='members'],['tab-forge',name==='forge']] as const)$('#'+id).classList.toggle('active',active);
  };
  $('#tab-model').onclick=()=>selectTab('model');
  $('#tab-forge').onclick=()=>selectTab('forge');
  $('#tab-members').onclick=()=>{selectTab('members');if(!$('#members-panel').children.length)void renderMembers();};
  $('#logout').onclick=async()=>{try{await api('logout','POST');renderLogin();}catch(error){alert(error instanceof Error?error.message:'退出失败。');}};
  selectTab(adminTab);if(adminTab==='members')void renderMembers();iconsReady();
}

type MemberView={id:string;username:string;displayName:string;enabled:boolean;canReview:boolean;createdAt:string};
async function renderMembers(){
  $('#members-panel').innerHTML=`<div class="members-heading"><div><span class="eyebrow">TEAM ACCESS</span><h2>给创作者，开一扇门。</h2><p>成员使用你开通的账号登录；检查权限可单独管理。</p></div><button class="primary-button" id="show-create">${icon('user-plus')}开通成员账号</button></div><form id="create-member-form" class="member-create" hidden><div class="member-create-fields"><div class="field"><label for="member-username">登录账号</label><input id="member-username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}" placeholder="如 creator01" autocomplete="off"/></div><div class="field"><label for="member-displayname">成员姓名</label><input id="member-displayname" required maxlength="50" placeholder="组员姓名或昵称" autocomplete="off"/></div><div class="field"><label for="member-password">初始密码</label><input id="member-password" type="password" required minlength="6" maxlength="128" placeholder="至少 6 位" autocomplete="new-password"/></div></div><div class="create-bottom"><label><input id="member-review" type="checkbox" checked/>允许提交游戏检查</label><div><button type="button" class="subtle-button" id="cancel-create">取消</button><button type="submit" class="primary-button">${icon('check')}确认开通</button></div></div></form><p id="member-message" class="form-message" role="status"></p><div class="members-list" id="members-list">正在读取成员…</div>`;
  iconsReady();
  $('#show-create').addEventListener('click',()=>{$('#create-member-form').hidden=false;$<HTMLInputElement>('#member-username').focus();});
  $('#cancel-create').addEventListener('click',()=>{$('#create-member-form').hidden=true;$<HTMLFormElement>('#create-member-form').reset();});
  $('#create-member-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$<HTMLButtonElement>('#create-member-form button[type="submit"]');button.disabled=true;
    try{await api('members','POST',{username:$<HTMLInputElement>('#member-username').value,displayName:$<HTMLInputElement>('#member-displayname').value,password:$<HTMLInputElement>('#member-password').value,canReview:$<HTMLInputElement>('#member-review').checked});$('#member-message').textContent='账号已开通。请将账号和初始密码告知该组员，成员可登录后自行修改密码。';$('#member-message').classList.add('success');$<HTMLFormElement>('#create-member-form').reset();$('#create-member-form').hidden=true;await refreshMembers();}
    catch(error){memberError(error);}finally{button.disabled=false;}
  });
  await refreshMembers();
}
function memberError(error:unknown){$('#member-message').textContent=error instanceof Error?error.message:'操作未完成。';$('#member-message').classList.remove('success');}
async function refreshMembers(){
  try{
    const data=await api('members')as{members:MemberView[]};
    $('#members-list').innerHTML=data.members.length?`<div class="member-list-header"><span>成员 / 登录账号</span><span>检查权限</span><span>账号状态</span><span>操作</span></div>${data.members.map(member=>`<article class="member-row"><div class="member-person"><div class="member-avatar">${escape(member.displayName.slice(0,1))}</div><div><strong>${escape(member.displayName)}</strong><small>@${escape(member.username)}</small></div></div><label class="permission-control"><input type="checkbox" data-permission="${member.id}" aria-label="${escape(member.username)} 检查权限" ${member.canReview?'checked':''}/><span>${member.canReview?'已开通':'未开通'}</span></label><button class="account-state ${member.enabled?'enabled':''}" data-enabled="${member.id}" data-next="${!member.enabled}"><span class="status-dot"></span>${member.enabled?'使用中':'已停用'}</button><button class="text-button" data-show-reset="${member.id}">${icon('key-round')}重置密码</button><form class="reset-password" data-reset-form="${member.id}" hidden><input type="password" minlength="6" maxlength="128" placeholder="输入新的密码，至少 6 位" aria-label="${escape(member.username)} 新密码" autocomplete="new-password" required/><button class="subtle-button" type="submit">确认重置</button></form></article>`).join('')}`:`<div class="empty-state">${icon('users')}<p>还没有成员账号</p><span>点击上方「开通成员账号」，邀请组员开始检查。</span></div>`;
    document.querySelectorAll<HTMLInputElement>('[data-permission]').forEach(input=>input.addEventListener('change',async()=>{input.disabled=true;try{await api(`members/${input.dataset.permission}`,'PATCH',{canReview:input.checked});await refreshMembers();}catch(error){input.checked=!input.checked;memberError(error);}finally{input.disabled=false;}}));
    document.querySelectorAll<HTMLButtonElement>('[data-enabled]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api(`members/${button.dataset.enabled}`,'PATCH',{enabled:button.dataset.next==='true'});await refreshMembers();}catch(error){memberError(error);}finally{button.disabled=false;}}));
    document.querySelectorAll<HTMLButtonElement>('[data-show-reset]').forEach(button=>button.addEventListener('click',()=>{const form=document.querySelector<HTMLFormElement>(`[data-reset-form="${button.dataset.showReset}"]`)!;form.hidden=!form.hidden;if(!form.hidden)form.querySelector('input')!.focus();}));
    document.querySelectorAll<HTMLFormElement>('[data-reset-form]').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button')!;button.disabled=true;try{await api(`members/${form.dataset.resetForm}`,'PATCH',{password:form.querySelector('input')!.value});$('#member-message').textContent='密码已重置，旧登录状态已失效。请告知该成员新密码。';$('#member-message').classList.add('success');await refreshMembers();}catch(error){memberError(error);}finally{button.disabled=false;}}));
    iconsReady();
  }catch(error){memberError(error);}
}
