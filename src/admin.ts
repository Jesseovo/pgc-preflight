import { withProgress, progressHtml } from './progress';
import {createIcons,icons} from 'lucide';
import './style.css';
import './admin.css';
import {catWalk} from './artwork';

const icon=(name:string)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const app=document.querySelector<HTMLDivElement>('#app')!;
type ProfileId='deepseek'|'opus';
type ProfileView={baseUrl:string;model:string;protocol:'openai'|'anthropic';enabled:boolean;vision?:boolean;hasKey:boolean;updatedAt:string};
type Purpose='review'|'create';
type PublicConfig={baseUrl:string;model:string;protocol:'openai'|'anthropic';enabled:boolean;hasKey:boolean;updatedAt:string;activeProfile:ProfileId;profiles:Record<ProfileId,ProfileView>;routes?:Record<Purpose,ProfileId|''>;effective?:Record<Purpose,ProfileId|''>};
let saved:PublicConfig={baseUrl:'',model:'',protocol:'openai',enabled:true,hasKey:false,updatedAt:'',activeProfile:'deepseek',profiles:{deepseek:{baseUrl:'',model:'deepseek-chat',protocol:'openai',enabled:true,hasKey:false,updatedAt:''},opus:{baseUrl:'https://riffle-api.pages.dev',model:'claude-opus-5-5',protocol:'anthropic',enabled:true,hasKey:false,updatedAt:''}}};
const PROFILE_LABEL:Record<ProfileId,string>={deepseek:'DeepSeek',opus:'Claude Opus 5.5'};
let selectedProfile:ProfileId='deepseek';
let adminTab:'model'|'members'|'forge'='forge';
const $=<T extends Element=HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
const iconsReady=()=>createIcons({icons,attrs:{'stroke-width':1.7}});
app.innerHTML=`<header class="header"><div class="header-inner"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="34" height="34"/><span>PGC <b>Preflight</b></span><span class="beta">ADMIN</span></a><div class="header-actions"><span class="back-link">${icon('panels-top-left')}团队工作空间</span></div></div></header><main class="admin-main"><section class="intro"><div><div class="eyebrow">CREATOR WORKSPACE</div><h1>从灵感，到下一款游戏<span>。</span></h1><p>选题、制作简报与基础预审，在一个工作台里完成。</p></div>${catWalk}</section><div id="admin-content"><div class="admin-loading">${progressHtml({label:"正在读取管理配置",detail:"正在确认登录状态…"})}</div></div><footer><span>PGC Preflight / Model-driven review</span><span>接口密钥仅保存在服务端 ${icon('lock-keyhole')}</span></footer></main>`;
iconsReady();

async function api(path:string,method='GET',body?:unknown){
  const label=path==='test'?'测试模型连接与图片输入':path==='login'?'管理员登录':path==='logout'?'退出登录':path==='config/active'?'切换全局模型':path==='config/routes'?'保存模型用途':path==='config'?(method==='GET'?'读取模型配置':'保存模型配置'):path==='members'?(method==='GET'?'读取成员列表':'开通成员账号'):'更新成员权限与账号';
  return withProgress(label, async progress => {
  const response=await fetch(`/api/admin/${path}`,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(response.status===401&&path!=='login'){progress.dismiss();renderLogin();throw new Error('登录已过期，请重新登录。');}
  if(!response.ok)throw new Error(data.error||'请求未完成，请稍后重试。');
  return data;
  }, {detail:path==='test'?'正在请求模型并验证图片输入，请等待接口返回。':'正在连接管理服务…'});
}
async function init(){try{saved=await api('config');selectedProfile=saved.activeProfile;renderSettings();}catch(error){if(!document.querySelector('#login-form'))renderLogin(error instanceof Error?error.message:'管理服务暂不可用。');}}
void init();

function renderLogin(initialMessage=''){
  $('#admin-content').innerHTML=`<section class="login-card"><div class="login-card-heading"><div class="login-symbol">${icon('key-round')}</div><div><h2>管理员登录</h2><p>管理模型与团队账号</p></div></div><form id="login-form" class="auth-form"><div class="auth-field"><label for="admin-password">管理密码</label><input id="admin-password" type="password" autocomplete="current-password" placeholder="输入管理密码" required maxlength="500"/></div><button class="primary-button" type="submit"><span>进入管理页</span>${icon('arrow-right')}</button><p id="login-message" class="form-message" role="status">${escape(initialMessage)}</p></form><div class="login-foot">${icon('shield-check')}登录状态保留 8 小时</div></section>`;
  iconsReady();
  $('#login-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$<HTMLButtonElement>('#login-form button');button.disabled=true;
    try{await api('login','POST',{password:$<HTMLInputElement>('#admin-password').value});saved=await api('config');selectedProfile=saved.activeProfile;renderSettings();}
    catch(error){$('#login-message').textContent=error instanceof Error?error.message:'登录失败。';}
    finally{button.disabled=false;}
  });
}
function renderSettings(){
  const profile=saved.profiles?.[selectedProfile] || (selectedProfile===saved.activeProfile ? saved : {baseUrl:selectedProfile==='opus'?'https://riffle-api.pages.dev':'',model:selectedProfile==='opus'?'claude-opus-5-5':'deepseek-chat',protocol:selectedProfile==='opus'?'anthropic':'openai',enabled:true,hasKey:false,updatedAt:''});
  const isActive=selectedProfile===saved.activeProfile;
  const label=selectedProfile==='opus'?'Claude Opus 5.5':'DeepSeek';
  const protocolHint=selectedProfile==='opus'?'Anthropic Messages（Riffle 直连）':'OpenAI Chat Completions';
  $('#admin-content').innerHTML=`<nav class="admin-tabs" aria-label="管理功能"><button id="tab-forge">${icon('sparkles')}创作工作台</button><button id="tab-model">${icon('brain-circuit')}模型配置</button><button id="tab-members">${icon('users')}成员管理</button></nav><div class="admin-grid" id="model-panel"><section class="settings-card"><div class="settings-heading"><div><span class="eyebrow">MODEL SWITCHBOARD</span><h2>审核模型</h2></div><span class="config-status ${saved.hasKey&&saved.enabled?'connected':''}"><span class="status-dot"></span>${saved.hasKey&&saved.enabled?'已启用':'待配置'}</span></div>
    <div class="profile-switch" role="group" aria-label="选择模型配置"><button type="button" class="profile-tab ${selectedProfile==='deepseek'?'active':''}" data-profile="deepseek"><b>DeepSeek</b><small>${saved.profiles?.deepseek?.hasKey?'已配置':'未配置'}</small></button><button type="button" class="profile-tab ${selectedProfile==='opus'?'active':''}" data-profile="opus"><b>Claude Opus 5.5</b><small>${saved.profiles?.opus?.hasKey?'已配置':'未配置'}</small></button></div>
    <div class="active-model-note">${isActive?`<b>${escape(label)}</b> 是当前全局模型，没有单独分配的用途都用它。`:`当前正在编辑 <b>${escape(label)}</b>，保存后可切换为全局模型或分配到具体用途。`}</div>
    <div class="model-routes" id="model-routes"><h3>用途分配</h3>
      ${(['review','create'] as Purpose[]).map(purpose=>`<label class="field"><span>${purpose==='review'?'AI 模拟审核':'选题扩写、简报、资产、样板图'}</span><select data-route="${purpose}"><option value="">跟随全局模型（${escape(PROFILE_LABEL[saved.activeProfile])}）</option>${(['deepseek','opus'] as ProfileId[]).map(id=>`<option value="${id}" ${saved.routes?.[purpose]===id?'selected':''} ${saved.profiles?.[id]?.hasKey?'':'disabled'}>${PROFILE_LABEL[id]}${saved.profiles?.[id]?.hasKey?'':'（未配置）'}</option>`).join('')}</select></label>`).join('')}
      <p>${(()=>{const r=saved.effective?.review as ProfileId|'';return r&&saved.profiles?.[r]?.vision===false?`审核当前用的 ${escape(PROFILE_LABEL[r])} 不能看图片：审核时只发源码和运行记录，不发截图，美学判断会弱一些。`:'审核会把游戏截图一起发给模型。';})()}</p>
      <button type="button" class="subtle-button" id="save-routes">${icon('check')}保存用途分配</button><div id="routes-message" class="form-message" role="status" aria-live="polite"></div></div>
    <form id="model-form">
    <div class="field"><label for="base-url">接口地址 <span>${protocolHint}</span></label><input id="base-url" type="url" placeholder="${selectedProfile==='opus'?'https://riffle-api.pages.dev':'https://api.deepseek.com/v1'}" autocomplete="off" value="${escape(profile.baseUrl)}" required/><p>${selectedProfile==='opus'?'Riffle 支持 Anthropic /v1/messages，请求由服务端直连；扩写和简报在后台排队，完成后自动更新。':'填写兼容 Chat Completions 的 HTTPS 接口前缀。'}</p></div>
    <div class="field"><label for="model-name">模型名称 <span>Model</span></label><input id="model-name" placeholder="${selectedProfile==='opus'?'claude-opus-5-5':'deepseek-chat'}" value="${escape(profile.model)}" autocomplete="off" required/></div>
    <div class="field"><label for="api-key">API Key <span>${profile.hasKey?'已保存，留空保留原密钥':'首次配置必填'}</span></label><div class="key-field"><input id="api-key" type="password" autocomplete="new-password" placeholder="${profile.hasKey?'密钥已加密保存，不会回显':'输入模型服务商的 API Key'}" ${profile.hasKey?'':'required'}/><button type="button" class="icon-button" id="toggle-key" aria-label="切换密钥显示">${icon('eye')}</button></div><p>密钥加密保存在服务端，不会发送给上传游戏的用户。</p></div>
    <label class="enable-toggle"><input id="model-enabled" type="checkbox" ${profile.enabled?'checked':''}/><span><b>启用此模型</b><small>关闭后不能切换到它，但不会删除已保存配置。</small></span></label>
    <label class="enable-toggle"><input id="model-vision" type="checkbox" ${(profile as ProfileView).vision!==false?'checked':''}/><span><b>能看图片</b><small>审核会把游戏截图发给它。不支持图片的模型（如 deepseek-chat）请取消勾选，审核时只发源码和运行记录。</small></span></label>
    <div class="form-actions"><button type="button" class="subtle-button" id="test-model">${icon('plug-zap')}测试连接与图片输入</button><div class="model-action-group"><button type="submit" class="primary-button" id="save-model">${icon('check')}保存配置</button><button type="button" class="subtle-button" id="activate-model" ${isActive||!profile.hasKey?'disabled':''}>${icon('arrow-left-right')}${isActive?'当前使用中':'切换到此模型'}</button></div></div><div id="config-message" class="form-message" role="status" aria-live="polite"></div>
  </form></section><aside class="admin-aside"><div class="model-flow"><span class="eyebrow">HOW IT WORKS</span><h2>模型判断，浏览器取证。</h2><div class="flow-step"><span>1</span><div><h3>打开游戏</h3><p>独立浏览器运行 HTML，收集真实画面与运行记录。</p></div></div><div class="flow-step"><span>2</span><div><h3>模型操作</h3><p>模型结合截图决定点击、长按或滑动，再查看结果。</p></div></div><div class="flow-step"><span>3</span><div><h3>模拟评分</h3><p>按原 Forge 标准评估美学、易玩性、可玩性，并引用证据给修改建议。</p></div></div><div class="admin-boundary">这是 AI 模拟预审分数。<br>最终是否提交仍由人工决定。</div></div><div class="config-meta"><span>当前生效</span><b>${escape(saved.model||'未配置')}</b><span>上次保存</span><b>${saved.updatedAt?new Date(saved.updatedAt).toLocaleString('zh-CN'):'尚未配置'}</b><button class="text-button" id="logout">${icon('log-out')}退出管理</button></div></aside></div>`;
  $('#admin-content').insertAdjacentHTML('beforeend','<section id="members-panel" hidden></section><section id="forge-panel" hidden><div class="forge-embed-heading"><div><span class="eyebrow">PGC FORGE</span><h2>选题与作品工作台</h2><p>从选题到简报，沿用同一份全局模型配置。</p></div><a class="subtle-button" href="/admin" target="_blank" rel="noreferrer">新窗口打开 ↗</a></div><div id="forge-loading" class="pgc-inline-wait"></div><iframe id="forge-embed" title="PGC Forge 管理工作台" src="/forge/?embedded=1"></iframe></section>');
  $('#forge-loading').innerHTML=progressHtml({label:'加载创作工作台',detail:'正在读取工作台页面…'});
  $('#forge-embed').addEventListener('load',()=>{if(document.querySelector('#forge-loading'))$('#forge-loading').hidden=true;});
  const selectTab=(name:'model'|'members'|'forge')=>{ adminTab=name; $('#model-panel').hidden=name!=='model';$('#members-panel').hidden=name!=='members';$('#forge-panel').hidden=name!=='forge';for(const [id,active] of [['tab-model',name==='model'],['tab-members',name==='members'],['tab-forge',name==='forge']] as const)$( `#${id}`).classList.toggle('active',active); };
  $('#tab-model').addEventListener('click',()=>selectTab('model'));
  $('#tab-members').addEventListener('click',()=>{selectTab('members');if(!$('#members-panel').children.length)void renderMembers();});
  $('#tab-forge').addEventListener('click',()=>selectTab('forge'));
  selectTab(adminTab);
  if(adminTab==='members')void renderMembers();
  document.querySelectorAll<HTMLButtonElement>('[data-profile]').forEach(button=>button.addEventListener('click',()=>{selectedProfile=button.dataset.profile as ProfileId;renderSettings();}));
  iconsReady();
  $('#toggle-key').addEventListener('click',()=>{const key=$<HTMLInputElement>('#api-key');key.type=key.type==='password'?'text':'password';});
  const fields=()=>({profile:selectedProfile,protocol:selectedProfile==='opus'?'anthropic':'openai',baseUrl:$<HTMLInputElement>('#base-url').value,model:$<HTMLInputElement>('#model-name').value,apiKey:$<HTMLInputElement>('#api-key').value,enabled:$<HTMLInputElement>('#model-enabled').checked,vision:$<HTMLInputElement>('#model-vision').checked});
  $('#save-routes').addEventListener('click',async()=>{const button=$<HTMLButtonElement>('#save-routes');const routes=Object.fromEntries([...document.querySelectorAll<HTMLSelectElement>('[data-route]')].map(select=>[select.dataset.route,select.value]));button.disabled=true;try{saved=await api('config/routes','POST',routes);renderSettings();$('#routes-message').textContent='用途分配已保存，新的任务立即生效。';$('#routes-message').classList.add('success');}catch(error){$('#routes-message').textContent=error instanceof Error?error.message:'保存失败。';button.disabled=false;}});
  const busy=(value:boolean)=>{ $<HTMLButtonElement>('#test-model').disabled=value;$<HTMLButtonElement>('#save-model').disabled=value; };
  const message=(text:string,ok=false)=>{const el=$('#config-message');el.textContent=text;el.classList.toggle('success',ok);};
  $('#model-form').addEventListener('submit',async event=>{event.preventDefault();busy(true);message('正在保存…');try{saved=await api('config','PUT',fields());renderSettings();$('#config-message').textContent=`${label} 配置已保存。`;$('#config-message').classList.add('success');}catch(error){message(error instanceof Error?error.message:'保存失败。');}finally{if(document.querySelector('#save-model'))busy(false);}});
  $('#test-model').addEventListener('click',async()=>{if(!$<HTMLFormElement>('#model-form').reportValidity())return;busy(true);message('正在测试接口与图片输入…');try{const result=await api('test','POST',fields());if(result.vision!==false)message(`连接成功，图片输入也可用。文字请求用时 ${(result.durationMs/1000).toFixed(1)} 秒。`,true);else{$<HTMLInputElement>('#model-vision').checked=false;message(`连接成功（文字请求用时 ${(result.durationMs/1000).toFixed(1)} 秒），但这个模型不接受图片，已帮你取消"能看图片"，保存后生效。${result.visionError?`接口返回：${result.visionError}`:''}`,true);}}catch(error){message(error instanceof Error?error.message:'连接测试失败。');}finally{if(document.querySelector('#save-model'))busy(false);}});
  $('#activate-model').addEventListener('click',async()=>{if(isActive)return;const button=$<HTMLButtonElement>('#activate-model');button.disabled=true;try{saved=await api('config/active','POST',{profile:selectedProfile});renderSettings();}catch(error){message(error instanceof Error?error.message:'切换失败。');button.disabled=false;}});
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
