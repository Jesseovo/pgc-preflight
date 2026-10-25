import {createIcons,icons} from 'lucide';
import './style.css';
import './admin.css';
import {catWalk} from './artwork';

const icon=(name:string)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const app=document.querySelector<HTMLDivElement>('#app')!;
type PublicConfig={baseUrl:string;model:string;enabled:boolean;hasKey:boolean;updatedAt:string};
let saved:PublicConfig={baseUrl:'',model:'',enabled:true,hasKey:false,updatedAt:''};
const $=<T extends Element=HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
const iconsReady=()=>createIcons({icons,attrs:{'stroke-width':1.7}});
app.innerHTML=`<header class="header"><div class="header-inner"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="34" height="34"/><span>PGC <b>Preflight</b></span><span class="beta">ADMIN</span></a><div class="header-actions"><a href="/forge" class="back-link">进入 PGC Forge ${icon('arrow-up-right')}</a><a href="/" class="back-link">${icon('arrow-left')}返回检查台</a></div></div></header><main class="admin-main"><section class="intro"><div><div class="eyebrow">MODEL CONTROL ROOM</div><h1>让合适的模型，来检查<span>。</span></h1><p>配置视觉模型，管理你的游戏基础预审。</p></div>${catWalk}</section><div id="admin-content"><div class="admin-loading">正在读取管理配置…</div></div><footer><span>PGC Preflight / Model-driven review</span><span>接口密钥仅保存在服务端 ${icon('lock-keyhole')}</span></footer></main>`;
iconsReady();

async function api(path:string,method='GET',body?:unknown){
  const response=await fetch(`/api/admin/${path}`,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(response.status===401&&path!=='login'){renderLogin();throw new Error('登录已过期，请重新登录。');}
  if(!response.ok)throw new Error(data.error||'请求未完成，请稍后重试。');
  return data;
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
  $('#admin-content').innerHTML=`<nav class="admin-tabs" aria-label="管理功能"><button id="tab-model" class="active">${icon('brain-circuit')}模型配置</button><button id="tab-members">${icon('users')}成员管理</button></nav><div class="admin-grid" id="model-panel"><section class="settings-card"><div class="settings-heading"><div><span class="eyebrow">CONNECTION</span><h2>审核模型</h2></div><span class="config-status ${saved.hasKey&&saved.enabled?'connected':''}"><span class="status-dot"></span>${saved.hasKey&&saved.enabled?'已启用':'待配置'}</span></div><form id="model-form">
    <div class="field"><label for="base-url">接口地址 <span>Base URL</span></label><input id="base-url" type="url" placeholder="https://your-provider.example/v1" autocomplete="off" value="${escape(saved.baseUrl)}" required/><p>填写兼容 Chat Completions 的 HTTPS 接口前缀，无需加 /chat/completions。</p></div>
    <div class="field"><label for="model-name">模型名称 <span>Model</span></label><input id="model-name" placeholder="填写服务商提供的模型 ID" value="${escape(saved.model)}" autocomplete="off" required/><p>请选择支持图片输入、能看懂截图的模型。</p></div>
    <div class="field"><label for="api-key">API Key <span>${saved.hasKey?'已保存，留空保留原密钥':'首次配置必填'}</span></label><div class="key-field"><input id="api-key" type="password" autocomplete="new-password" placeholder="${saved.hasKey?'密钥已加密保存，不会回显':'输入模型服务商的 API Key'}" ${saved.hasKey?'':'required'}/><button type="button" class="icon-button" id="toggle-key" aria-label="切换密钥显示">${icon('eye')}</button></div><p>密钥加密保存在服务端，不会发送给上传游戏的用户。</p></div>
    <label class="enable-toggle"><input id="model-enabled" type="checkbox" ${saved.enabled?'checked':''}/><span><b>启用模型审核</b><small>关闭后暂停新检查，保留当前配置。</small></span></label>
    <div class="form-actions"><button type="button" class="subtle-button" id="test-model">${icon('plug-zap')}测试连接与图片输入</button><button type="submit" class="primary-button" id="save-model">${icon('check')}保存配置</button></div><div id="config-message" class="form-message" role="status" aria-live="polite"></div>
  </form></section><aside class="admin-aside"><div class="model-flow"><span class="eyebrow">HOW IT WORKS</span><h2>模型判断，浏览器取证。</h2><div class="flow-step"><span>1</span><div><h3>打开游戏</h3><p>独立浏览器运行 HTML，收集真实画面与运行记录。</p></div></div><div class="flow-step"><span>2</span><div><h3>模型操作</h3><p>模型结合截图决定点击、长按或滑动，再查看结果。</p></div></div><div class="flow-step"><span>3</span><div><h3>模型出报告</h3><p>只检查基础故障，附截图依据，无法验证就明确说明。</p></div></div><div class="admin-boundary">不评价手感、美感、趣味性。<br>最终审核始终交给人。</div></div><div class="config-meta"><span>上次保存</span><b>${saved.updatedAt?new Date(saved.updatedAt).toLocaleString('zh-CN'):'尚未配置'}</b><button class="text-button" id="logout">${icon('log-out')}退出管理</button></div></aside></div>`;
  $('#admin-content').insertAdjacentHTML('beforeend','<section id="members-panel" hidden></section>');
  $('#tab-model').addEventListener('click',()=>{ $('#model-panel').hidden=false;$('#members-panel').hidden=true;$('#tab-model').classList.add('active');$('#tab-members').classList.remove('active'); });
  $('#tab-members').addEventListener('click',()=>{ $('#model-panel').hidden=true;$('#members-panel').hidden=false;$('#tab-model').classList.remove('active');$('#tab-members').classList.add('active');if(!$('#members-panel').children.length)void renderMembers(); });
  iconsReady();
  $('#toggle-key').addEventListener('click',()=>{const key=$<HTMLInputElement>('#api-key');key.type=key.type==='password'?'text':'password';});
  const fields=()=>({baseUrl:$<HTMLInputElement>('#base-url').value,model:$<HTMLInputElement>('#model-name').value,apiKey:$<HTMLInputElement>('#api-key').value,enabled:$<HTMLInputElement>('#model-enabled').checked});
  const busy=(value:boolean)=>{ $<HTMLButtonElement>('#test-model').disabled=value;$<HTMLButtonElement>('#save-model').disabled=value; };
  const message=(text:string,ok=false)=>{const el=$('#config-message');el.textContent=text;el.classList.toggle('success',ok);};
  $('#model-form').addEventListener('submit',async event=>{event.preventDefault();busy(true);message('正在保存…');try{saved=await api('config','PUT',fields());renderSettings();$('#config-message').textContent='模型配置已保存。可以返回检查台开始审核。';$('#config-message').classList.add('success');}catch(error){message(error instanceof Error?error.message:'保存失败。');}finally{if(document.querySelector('#save-model'))busy(false);}});
  $('#test-model').addEventListener('click',async()=>{if(!$<HTMLFormElement>('#model-form').reportValidity())return;busy(true);message('正在测试接口与图片输入…');try{const result=await api('test','POST',fields());message(`连接成功，图片请求已返回。用时 ${(result.durationMs/1000).toFixed(1)} 秒。保存后生效。`,true);}catch(error){message(error instanceof Error?error.message:'连接测试失败。');}finally{if(document.querySelector('#save-model'))busy(false);}});
  $('#logout').addEventListener('click',async()=>{try{await api('logout','POST');renderLogin();}catch(error){message(error instanceof Error?error.message:'退出失败。');}});
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
