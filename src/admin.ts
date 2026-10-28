import { withProgress, progressHtml } from './progress';
import {createIcons,icons} from 'lucide';
import './style.css';
import './admin.css';
import {mountModelPanel} from './model-panel';
import {reviewTaskStatus} from './review-task-status';

const icon=(name:string)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const app=document.querySelector<HTMLDivElement>('#app')!;
let saved:import('./model-panel').ModelView;
type AdminTab='members'|'forge'|'activity'|'public'|'upload'|'model';
let adminTab:AdminTab='members';
const $=<T extends Element=HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
const iconsReady=()=>createIcons({icons,attrs:{'stroke-width':1.7}});
app.innerHTML=`<header class="header admin-header"><div class="header-inner"><a class="brand" href="/admin"><img src="/favicon.svg" alt="" width="34" height="34"/><span>PGC <b>OverFlow</b></span></a><div class="header-actions"><a class="back-link" href="/square">${icon('gamepad-2')}游戏广场</a><span class="back-link">${icon('shield-check')}超级管理员</span></div></div></header><main class="admin-main"><div id="admin-content"><div class="admin-loading">${progressHtml({label:"正在读取管理配置",detail:"正在确认登录状态…"})}</div></div><footer><span>PGC OverFlow / 管理后台</span><span>接口密钥仅保存在服务端 ${icon('lock-keyhole')}</span></footer></main>`;
iconsReady();

async function api(path:string,method='GET',body?:unknown){
  const label=path.startsWith('quota?')?'查询 Opus Key 余额':path.startsWith('workspace')?'读取团队内容与任务':path==='public-data'?(method==='GET'?'读取公共资料':'保存公共资料'):path==='review-upload'?'提交管理员游戏审核':path==='review-import'?'导入管理员审核报告':path==='test'?'测试模型连接与图片输入':path==='login'?'管理员登录':path==='logout'?'退出登录':path==='config/active'?'切换全局模型':path==='config/routes'?'保存模型用途':path==='config/profile'?'删除模型配置':path==='config'?(method==='GET'?'读取模型配置':'保存模型配置'):path.startsWith('review-activity')?'读取成员审核记录':path==='members'?(method==='GET'?'读取成员列表':'开通成员账号'):'更新成员权限与账号';
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
  $('#admin-content').innerHTML='<div class="admin-layout"><aside class="admin-sidebar"><div class="sidebar-heading">管理中心<span>ADMINISTRATION</span></div><nav class="admin-tabs" aria-label="管理功能"><span class="nav-label">团队</span><button id="tab-members">'+icon('users')+'成员管理</button><button id="tab-forge">'+icon('layers')+'内容与任务</button><button id="tab-activity">'+icon('clipboard-check')+'审核记录</button><span class="nav-label">平台</span><button id="tab-public">'+icon('library')+'公共资料</button><button id="tab-upload">'+icon('upload')+'手动上传</button><button id="tab-model">'+icon('brain-circuit')+'模型配置</button><button id="logout" class="admin-logout">'+icon('log-out')+'退出登录</button></nav><section class="worker-status" id="worker-status" role="status">正在读取成员 Agent 状态…</section></aside><div class="admin-workspace"><div id="model-panel" hidden></div><section id="members-panel" hidden></section><section id="forge-panel" hidden></section><section id="activity-panel" hidden></section><section id="public-panel" hidden></section><section id="upload-panel" hidden></section></div></div>';
  mountModelPanel($('#model-panel'),saved,api,value=>{saved=value;});
  void loadWorkerStatus();
  void renderManagement();
  const selectTab=(name:AdminTab)=>{
    adminTab=name;
    for(const tab of ['members','forge','activity','public','upload','model'] as const){$('#'+tab+'-panel').hidden=tab!==name;const button=$('#tab-'+tab);button.classList.toggle('active',tab===name);button.setAttribute('aria-current',tab===name?'page':'false');}
    if(name==='members'&&!$('#members-panel').children.length)void renderMembers();
    if(name==='activity'&&!$('#activity-panel').children.length)void mountActivity();
  };
  for(const tab of ['members','forge','activity','public','upload','model'] as const)$('#tab-'+tab).onclick=()=>selectTab(tab);
  $('#logout').onclick=async()=>{try{await api('logout','POST');renderLogin();}catch(error){alert(error instanceof Error?error.message:'退出失败。');}};
  selectTab(adminTab);iconsReady();
}

const safeText=(value:unknown)=>escape(String(value??''));
const adminDims={subject:'题材',medium:'美术媒介',gesture:'手势',structure:'挑战结构',mood:'情绪基调'};
let managementOwner='';
let managementSuggestions:any[]=[];
let workspaceRequest=0;
function filterRows(container:Element,query:string){
  const term=query.trim().toLocaleLowerCase();
  container.querySelectorAll<HTMLElement>('tbody tr').forEach(row=>{row.hidden=!!term&&!row.textContent?.toLocaleLowerCase().includes(term);});
}
const workspaceState=(value:unknown)=>{
  const state=String(value??'').toLocaleLowerCase();
  if(/done|complete|pass|success|published|approved/.test(state))return 'success';
  if(/error|fail|revoked|rejected|disabled/.test(state))return 'danger';
  if(/running|queued|pending|capture|verify|review/.test(state))return 'pending';
  return 'neutral';
};
const workspaceDate=(value:unknown)=>{
  if(!value)return '暂无更新时间';
  const date=new Date(String(value));
  if(Number.isNaN(date.getTime()))return safeText(value);
  return safeText(date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}));
};
async function renderManagement(){
  const panel=$('#forge-panel');
  panel.innerHTML=`<div class="members-heading"><div><span class="eyebrow">TEAM CONTENT</span><h2>成员内容与运行状态</h2><p>成员的创作内容各自独立；管理员维护公共资料并查看团队记录。</p></div><button class="subtle-button" id="workspace-refresh">刷新</button></div><div class="activity-filters workspace-toolbar"><label>成员<select id="workspace-owner"><option value="">全部成员</option></select></label><label class="workspace-search-field">搜索<input id="workspace-search" type="search" placeholder="搜索内容、任务或成员"></label><span id="workspace-counts" role="status"></span></div><div id="workspace-overview" class="workspace-overview" aria-label="团队内容概览"></div><p id="management-message" class="form-message" role="status"></p><div id="workspace-records"></div><details class="management-section"><summary><span>管理员手动上传</span><small>仅管理员可以提交游戏或导入报告</small></summary><p>上传游戏后，点击审核按钮才使用平台模型；成员由自己的 Agent 完成采集、初评和复核。</p><div class="management-pair"><form id="admin-game-upload" class="management-form"><h3>上传 HTML 游戏并审核</h3><label>游戏文件<input id="admin-game-file" type="file" accept=".html,.htm,text/html" required></label><label>标题（可选）<input id="admin-game-title" maxlength="200"></label><button class="primary-button" type="submit">上传并用平台模型审核</button></form><form id="admin-report-import" class="management-form"><h3>导入已有审核报告</h3><label>报告 JSON<input id="admin-report-file" type="file" accept=".json,application/json" required></label><label>报告标题（可选）<input id="admin-report-title" maxlength="200"></label><label>归属成员<select id="admin-report-owner"><option value="admin">管理员</option></select></label><button class="subtle-button" type="submit">导入报告</button></form></div></details><details class="management-section"><summary><span>公共规则与制作模板</span><small>团队 Agent 共享的资料</small></summary><div id="public-settings"></div></details><details class="management-section"><summary><span>公共词库与建议审批</span><small>管理待确认的补词建议</small></summary><div id="public-vocab"></div></details><dialog id="management-detail" class="activity-report"><div class="activity-dialog-head"><b id="management-detail-title">内容详情</b><button type="button" id="management-detail-close" class="subtle-button">关闭</button></div><div id="management-detail-content"></div></dialog><dialog id="activity-report" class="activity-report"><div class="activity-dialog-head"><b>审核报告</b><button type="button" id="activity-close" class="subtle-button">关闭</button></div><div id="activity-report-content" class="review-page"></div></dialog>`;
  const sections=panel.querySelectorAll<HTMLDetailsElement>(':scope > .management-section');
  $('#upload-panel').append(sections[0]);
  $('#public-panel').append(sections[1],sections[2]);
  $('#admin-content').append($('#management-detail'),$('#activity-report'));
  sections[0].open=false;
  sections[1].open=false;
  sections[2].open=false;
  $('#workspace-search').oninput=()=>filterRows($('#workspace-records'),$<HTMLInputElement>('#workspace-search').value);
  $('#upload-panel').insertAdjacentHTML('afterbegin','<div class="members-heading"><h2>手动上传</h2></div><p id="upload-message" class="form-message" role="status"></p>');
  $('#public-panel').insertAdjacentHTML('afterbegin','<div class="members-heading"><h2>公共资料</h2></div><p id="public-message" class="form-message" role="status"></p>');
  $('#management-detail-close').onclick=()=>$<HTMLDialogElement>('#management-detail').close();
  $('#activity-close').onclick=()=>$<HTMLDialogElement>('#activity-report').close();
  $('#workspace-refresh').onclick=()=>void loadManagementWorkspace();
  $('#workspace-owner').onchange=()=>{managementOwner=$<HTMLSelectElement>('#workspace-owner').value;void loadManagementWorkspace();};
  $('#admin-game-upload').onsubmit=event=>{event.preventDefault();const button=$<HTMLButtonElement>('#admin-game-upload button');button.disabled=true;void(async()=>{try{const file=$<HTMLInputElement>('#admin-game-file').files?.[0];if(!file)throw new Error('请选择游戏文件。');if(!/\.html?$/i.test(file.name)||file.size>8*1024*1024)throw new Error('请选择不超过 8 MB 的 HTML 游戏。');const html=await file.text();const title=$<HTMLInputElement>('#admin-game-title').value.trim()||new DOMParser().parseFromString(html,'text/html').title||file.name;await api('review-upload','POST',{html,title,filename:file.name,request_id:crypto.randomUUID()});$('#upload-message').textContent='审核已提交，可在内容与任务中查看进度。';$<HTMLFormElement>('#admin-game-upload').reset();await loadManagementWorkspace();}catch(error){managementError(error);}finally{button.disabled=false;}})();};
  $('#admin-report-import').onsubmit=event=>{event.preventDefault();const button=$<HTMLButtonElement>('#admin-report-import button');button.disabled=true;void(async()=>{try{const file=$<HTMLInputElement>('#admin-report-file').files?.[0];if(!file)throw new Error('请选择报告 JSON。');const report=JSON.parse(await file.text());await api('review-import','POST',{title:$<HTMLInputElement>('#admin-report-title').value.trim()||report.title||file.name,filename:report.filename||file.name,request_id:crypto.randomUUID(),result:report.result||report,probe:report.probe,shots:report.shots||[],owner_id:$<HTMLSelectElement>('#admin-report-owner').value});$('#upload-message').textContent='报告已导入。';$<HTMLFormElement>('#admin-report-import').reset();await loadManagementWorkspace();}catch(error){managementError(error);}finally{button.disabled=false;}})();};
  await Promise.allSettled([loadManagementWorkspace(),loadPublicData()]);
}
function managementError(error:unknown){const target=document.querySelector(adminTab==='upload'?'#upload-message':adminTab==='public'?'#public-message':'#management-message')||document.querySelector('#member-message');if(target)target.textContent=error instanceof Error?error.message:'操作未完成。';}
async function loadManagementWorkspace(){
  if(!document.querySelector('#workspace-records'))return;
  const request=++workspaceRequest;
  try{
    const data=await api(`workspace${managementOwner?'?owner='+encodeURIComponent(managementOwner):''}`);
    if(request!==workspaceRequest||!document.querySelector('#workspace-records'))return;
    const members=data.members||[];
    const owner=$<HTMLSelectElement>('#workspace-owner');owner.innerHTML='<option value="">全部成员</option>'+members.map((m:any)=>`<option value="${safeText(m.id)}">${safeText(m.displayName||m.display_name||m.username)}${m.star?' · ★':''}</option>`).join('');owner.value=managementOwner;
    const reportOwner=$<HTMLSelectElement>('#admin-report-owner'),selectedOwner=reportOwner.value;reportOwner.innerHTML='<option value="admin">管理员</option>'+members.map((m:any)=>`<option value="${safeText(m.id)}">${safeText(m.displayName||m.display_name||m.username)}</option>`).join('');reportOwner.value=selectedOwner;
    const topics=data.topics||[],games=data.games||[],tasks=data.tasks||[],agents=data.agents||[],reviewJobs=data.reviewJobs||[],reviews=data.reviews||[];
    const runningTasks=[...tasks,...reviewJobs].filter((t:any)=>['queued','running'].includes(t.status)&&t.model_executor!=='agent'&&t.executor!=='agent').length;
    const waitingReviews=reviewJobs.filter((t:any)=>t.model_executor==='agent'&&['queued','running'].includes(t.status)).length;
    const onlineAgents=agents.filter((a:any)=>a.online&&!a.revoked).length;
    $('#workspace-counts').textContent=`${topics.length+games.length} 条内容 · ${runningTasks} 个平台任务执行中 · ${waitingReviews} 个审核待 Agent 回传`;
    $('#workspace-overview').innerHTML=`<div class="workspace-stat"><span>选题</span><strong>${topics.length}</strong><small>成员的创作方向</small></div><div class="workspace-stat"><span>作品</span><strong>${games.length}</strong><small>已上传的成品</small></div><div class="workspace-stat"><span>平台执行</span><strong>${runningTasks}</strong><small>云端排队或执行任务</small></div><div class="workspace-stat"><span>在线 Agent</span><strong>${onlineAgents}</strong><small>共 ${agents.length} 个已授权</small></div>`;
    const names=new Map(members.map((m:any)=>[m.id,m.displayName||m.display_name||m.username]));
    const who=(row:any)=>safeText(names.get(row.owner_id)||row.owner_id||'管理员');
    const contentRows=[...topics.map((t:any)=>({row:t,type:'选题',title:t.data?.title||t.title||`选题 ${t.id}`})),...games.map((g:any)=>({row:g,type:'作品',title:g.title}))];
    const openSections=Array.from($('#workspace-records').querySelectorAll<HTMLDetailsElement>('details'),section=>section.open);
    $('#workspace-records').innerHTML=`<details class="management-section workspace-block"><summary><span>内容记录 <b>${contentRows.length}</b></span><small>${topics.length} 个选题 · ${games.length} 款作品 · 点击查看明细</small></summary><div class="management-table"><table><thead><tr><th>成员</th><th>内容</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${contentRows.map(({row,type,title},index)=>`<tr><td>${who(row)}</td><td><span class="workspace-type">${type}</span><strong>${safeText(title)}</strong></td><td><span class="workspace-status ${workspaceState(row.status)}">${safeText(row.status||'未标记')}</span></td><td><time>${workspaceDate(row.updated_at||row.created_at)}</time></td><td><button type="button" class="text-button" data-content-index="${index}">查看详情</button>${type==='作品'?`<button class="text-button" data-publish-game="${safeText(row.id)}">发布到公共作品库</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5" class="workspace-empty">还没有内容。</td></tr>'}</tbody></table></div></details><details class="management-section workspace-block"><summary><span>任务与 Agent 状态 <b>${tasks.length+reviewJobs.length}</b></span><small>${runningTasks} 个平台任务执行中 · ${waitingReviews} 个审核待 Agent 回传 · ${onlineAgents} 个 Agent 在线</small></summary><div class="management-table"><table><thead><tr><th>成员</th><th>任务</th><th>状态 / 阶段</th><th>最近更新</th></tr></thead><tbody>${[...tasks,...reviewJobs].map((t:any)=>`<tr><td>${who(t)}</td><td><span class="workspace-type">${safeText(t.kind||'审核')}</span><strong>${safeText(t.title||t.topic_id||t.id)}</strong></td><td><span class="workspace-status ${workspaceState(t.status)}">${safeText(t.stage?reviewTaskStatus(t).label:t.status||'未知')}</span>${t.stage?`<small>${safeText(reviewTaskStatus(t).detail)}</small>`:t.detail||t.error?`<small>${safeText(t.detail||t.error)}</small>`:''}</td><td><time>${workspaceDate(t.updated_at||t.created_at)}</time></td></tr>`).join('')||'<tr><td colspan="4" class="workspace-empty">暂无任务。</td></tr>'}</tbody></table></div><div class="management-agent-list">${agents.map((a:any)=>`<div><span class="agent-avatar">${icon('bot')}</span><span><strong>${who(a)} · ${safeText(a.name||'Agent')}</strong><small>${a.revoked?'已撤销':a.online?'在线':'已授权'} · ${safeText(a.last_seen||'尚未连接')}</small></span><span class="workspace-status ${a.revoked?'danger':a.online?'success':'neutral'}">${a.revoked?'已撤销':a.online?'在线':'离线'}</span></div>`).join('')||'<p>尚无创作 Agent 授权。</p>'}</div></details><details class="management-section workspace-block"><summary><span>审核报告 <b>${reviews.length}</b></span><small>成员 Agent、管理员导入与平台模型报告</small></summary><div class="management-table"><table><thead><tr><th>成员</th><th>游戏</th><th>执行来源</th><th>结果</th></tr></thead><tbody>${reviews.map((r:any)=>`<tr><td>${who(r)}</td><td><strong>${safeText(r.title||'未命名游戏')}</strong><small>${workspaceDate(r.created_at)}</small></td><td><span class="workspace-status neutral">${safeText(r.model_executor==='agent'?'成员 Agent':/import|manual-admin/.test(r.model_executor||'')?'管理员导入':'平台模型')}</span></td><td><button class="text-button" data-activity-report="${Number(r.id)}">${Number(r.score)} / 9 · 查看报告</button></td></tr>`).join('')||'<tr><td colspan="4" class="workspace-empty">暂无报告。</td></tr>'}</tbody></table></div></details>`;
    $('#workspace-records').querySelectorAll<HTMLButtonElement>('[data-content-index]').forEach(button=>button.onclick=()=>void showManagementContent(contentRows[Number(button.dataset.contentIndex)],button));
    $('#workspace-records').querySelectorAll<HTMLDetailsElement>('details').forEach((section,index)=>{if(openSections[index]!==undefined)section.open=openSections[index];});
    $('#workspace-records').querySelectorAll<HTMLButtonElement>('[data-activity-report]').forEach(button=>button.onclick=()=>void showActivityReport(button));
    filterRows($('#workspace-records'),$<HTMLInputElement>('#workspace-search').value);
    $('#workspace-records').querySelectorAll<HTMLButtonElement>('[data-publish-game]').forEach(button=>button.onclick=()=>void publicAction(button,{action:'publish-game',id:Number(button.dataset.publishGame)}));
    managementSuggestions=data.suggestions||[];
    renderSuggestions(managementSuggestions);
    iconsReady();
  }catch(error){if(request===workspaceRequest)managementError(error);}
}
const materialLabels:Record<string,string>={expand:'选题扩写',brief:'制作简报',preview:'样板图 SVG',assets:'美术资产 HTML',game:'游戏成品 HTML',product:'游戏成品 HTML'};
async function readManagementContent(path:string){
  const response=await fetch(`/api/forge/${path}`,{cache:'no-store'}),data=await response.json();
  if(!response.ok)throw new Error(data.error||'内容读取失败。');
  return data;
}
async function showManagementContent(item:{row:any;type:string;title:string},button:HTMLButtonElement){
  button.disabled=true;
  try{
    const target=$('#management-detail-content');
    const show=(html:string)=>{target.innerHTML=html;$('#management-detail-title').textContent=item.title;$<HTMLDialogElement>('#management-detail').showModal();};
    if(item.type!=='选题'){show(`<pre class="management-json">${safeText(JSON.stringify(item.row,null,2))}</pre>`);return;}
    const [topic,versions]=await withProgress('读取选题全部材料',()=>Promise.all([readManagementContent(`topics/${item.row.id}`),readManagementContent(`topics/${item.row.id}/versions`)]),{compact:true});
    const materials=[['brief',topic.brief_export||topic.brief_md,'brief','下载简报 Markdown'],['preview',topic.preview_svg,'',''],['assets',topic.assets_html,'assets','下载资产 HTML'],['game',topic.product_html,'product-file','下载游戏 HTML']];
    const {brief_md,brief_export,preview_svg,assets_html,product_html,...metadata}=topic;
    show(`<div class="management-detail-body"><p>按需展开阶段材料；生成源码支持在线查看与下载。</p><details class="management-section"><summary><span>选题与补充要求</span><small>原始输入与成员偏好</small></summary><pre class="management-json">${safeText(JSON.stringify(metadata,null,2))}</pre></details>${materials.map(([kind,content,route,label])=>`<details class="management-section" ${kind==='brief'&&content?'open':''}><summary><span>${materialLabels[kind]}</span><small>${content?'已生成，可查看或下载':'尚未生成'}</small></summary>${content?`${route?`<p><a href="/api/forge/topics/${topic.id}/${route}" download>${label}</a></p>`:''}<pre class="management-json">${safeText(content)}</pre>`:'<p>暂无内容。</p>'}</details>`).join('')}<details class="management-section"><summary><span>历史版本</span><small>${versions.length} 个版本，按需查看</small></summary><div class="management-version-list">${versions.map((version:any)=>`<div class="management-version"><span><b>${safeText(materialLabels[version.kind]||version.kind)}</b><small>${safeText(version.created_at)} · ${safeText(version.executor)}${version.model?' · '+safeText(version.model):''}</small><small>${version.current?'当前版本':version.disposition==='pending'?'待确认结果':'历史版本'}${version.stale?' · 上游版本已变化':''}</small></span><button type="button" class="text-button" data-admin-version="${safeText(version.id)}">查看历史内容</button></div>`).join('')||'<p>暂无历史版本。</p>'}</div><div id="management-version-body"></div></details></div>`);
    target.querySelectorAll<HTMLButtonElement>('[data-admin-version]').forEach(versionButton=>versionButton.onclick=()=>{versionButton.disabled=true;void withProgress('读取历史版本',async()=>{
      const version=await readManagementContent(`topics/${topic.id}/versions/${encodeURIComponent(versionButton.dataset.adminVersion!)}`);
      const content=typeof version.content==='string'?version.content:JSON.stringify(version.content,null,2);
      $('#management-version-body').innerHTML=`<h3>${safeText(materialLabels[version.kind]||version.kind)} · ${safeText(version.created_at)}</h3><button class="subtle-button" id="management-download-version" type="button">下载此版本</button><pre class="management-json">${safeText(content)}</pre>`;
      $('#management-download-version').onclick=()=>{const extension=version.kind==='brief'?'md':version.kind==='preview'?'svg':['assets','game','product'].includes(version.kind)?'html':'json';const url=URL.createObjectURL(new Blob([content],{type:'application/octet-stream'}));const link=Object.assign(document.createElement('a'),{href:url,download:`topic-${topic.id}-${version.kind}-${version.id}.${extension}`});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    },{compact:true}).catch(managementError).finally(()=>{versionButton.disabled=false;});});
  }catch(error){managementError(error);}finally{button.disabled=false;}
}
async function publicAction(button:HTMLButtonElement,payload:unknown){button.disabled=true;try{await api('public-data','POST',payload);$(adminTab==='forge'?'#management-message':'#public-message').textContent='公共资料已更新。';await loadPublicData();await loadManagementWorkspace();}catch(error){managementError(error);}finally{button.disabled=false;}}
function renderSuggestions(rows:any[]){
  if(!document.querySelector('#public-suggestions'))return;
  $('#public-suggestions').innerHTML=`<h3>待审批词库建议</h3>${rows.filter(row=>!row.status||row.status==='pending').map(row=>`<div class="management-suggestion"><span><b>${safeText(row.word||(Array.isArray(row.words)?row.words.map((word:any)=>typeof word==='string'?word:word.word).join('、'):row.words)||row.content)}</b><small>${safeText(row.dim)} · ${safeText(row.owner_id)}</small></span><button class="text-button" data-suggestion="${safeText(row.id)}" data-action="suggestion-approve">批准</button><button class="text-button" data-suggestion="${safeText(row.id)}" data-action="suggestion-reject">拒绝</button></div>`).join('')||'<p>暂无待审批建议。</p>'}`;
  $('#public-suggestions').querySelectorAll<HTMLButtonElement>('[data-suggestion]').forEach(button=>button.onclick=()=>void publicAction(button,{action:button.dataset.action,id:button.dataset.suggestion}));
}
async function loadPublicData(){
  try{
    const data=await api('public-data'),settings=data.settings||{};
    if(!document.querySelector('#public-settings'))return;
    $('#public-settings').innerHTML=`<form id="public-settings-form" class="management-form">${[['redlines','选题规律与雷区'],['template','制作模板'],['template_f','F 部分骨架']].map(([key,label])=>`<label>${label}<textarea name="${key}" rows="8">${safeText(settings[key])}</textarea></label>`).join('')}<button class="primary-button" type="submit">保存公共规则与模板</button></form>`;
    $('#public-settings-form').onsubmit=event=>{event.preventDefault();void publicAction($<HTMLButtonElement>('#public-settings-form button'),{action:'settings',settings:{...settings,...Object.fromEntries(new FormData(event.target as HTMLFormElement))}});};
    $('#public-vocab').innerHTML=`<form id="public-vocab-form" class="management-vocab-add"><select name="dim">${Object.entries(adminDims).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select><input name="word" placeholder="新增公共词" required maxlength="100"><input name="note" placeholder="备注"><input name="base" aria-label="权重" type="number" value="1" min="0" step="0.1"><button class="subtle-button" type="submit">添加</button></form><div class="management-table"><table><thead><tr><th>维度 / 词</th><th>备注</th><th>权重</th><th>启用</th><th></th></tr></thead><tbody>${(data.vocab||[]).map((v:any)=>`<tr data-vocab="${Number(v.id)}"><td>${safeText(adminDims[v.dim as keyof typeof adminDims]||v.dim)}<strong>${safeText(v.word)}</strong></td><td><input data-vocab-field="note" value="${safeText(v.note)}"></td><td><input data-vocab-field="base" type="number" min="0" step="0.1" value="${Number(v.base||1)}"></td><td><input data-vocab-field="enabled" type="checkbox" ${v.enabled?'checked':''}></td><td><button class="text-button" data-vocab-delete="${Number(v.id)}">删除</button></td></tr>`).join('')}</tbody></table></div><div id="public-suggestions"></div>`;
    $('#public-vocab-form').onsubmit=event=>{event.preventDefault();void publicAction($<HTMLButtonElement>('#public-vocab-form button'),{action:'vocab-add',...Object.fromEntries(new FormData(event.target as HTMLFormElement))});};
    $('#public-vocab').querySelectorAll<HTMLInputElement>('[data-vocab-field]').forEach(input=>input.onchange=async()=>{input.disabled=true;try{await api('public-data','POST',{action:'vocab-update',id:Number(input.closest<HTMLElement>('[data-vocab]')!.dataset.vocab),[input.dataset.vocabField!]:input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value});}catch(error){managementError(error);}finally{input.disabled=false;}});
    $('#public-vocab').querySelectorAll<HTMLButtonElement>('[data-vocab-delete]').forEach(button=>button.onclick=()=>void publicAction(button,{action:'vocab-delete',id:Number(button.dataset.vocabDelete)}));
    renderSuggestions(managementSuggestions);
  }catch(error){managementError(error);}
}
setInterval(()=>{if(!document.hidden&&document.querySelector('#workspace-records')&&adminTab==='forge')void loadManagementWorkspace();},20000);

async function loadWorkerStatus(){
  if(!document.querySelector('#worker-status'))return;
  try{
    const response=await fetch('/api/admin/review-workers');if(!response.ok)throw new Error();const data=await response.json();
    if(!document.querySelector('#worker-status'))return;
    $('#worker-status').innerHTML=`<div><span class="status-dot ${data.online?'online':''}"></span><strong>成员审核 Agent</strong><span>${data.devices.filter((d:any)=>d.online).length} 台最近连接 · 本机采集与模型审核</span></div><small>${data.devices.filter((d:any)=>!d.revoked&&Date.parse(d.expires_at)>Date.now()).map((d:any)=>`${escape(d.display_name|| (d.owner_id==='admin'?'管理员':d.owner_id))} / ${escape(d.name)} · ${d.online?'最近连接':'已授权'}`).join('；')||'尚无设备授权；成员在审核页复制接入指令给 Agent 即可'}</small>`;
  }catch{if(document.querySelector('#worker-status'))$('#worker-status').textContent='成员 Agent 状态暂时无法读取，请稍后刷新。';}
}
setInterval(()=>{if(!document.hidden)void loadWorkerStatus();},20000);

type MemberView={id:string;username:string;displayName:string;enabled:boolean;canReview:boolean;star:boolean;createdAt:string;dailyReviewLimit:number};
async function renderMembers(){
  $('#members-panel').innerHTML=`<div class="members-heading"><div><span class="eyebrow">团队管理</span><h2>成员管理</h2><p>管理账号、审核权限和 Star 创作权限。</p></div><button class="primary-button" id="show-create">${icon('user-plus')}开通成员账号</button></div><form id="create-member-form" class="member-create" hidden><div class="member-create-fields"><div class="field"><label for="member-username">登录账号</label><input id="member-username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}" placeholder="如 creator01" autocomplete="off"/></div><div class="field"><label for="member-displayname">成员姓名</label><input id="member-displayname" required maxlength="50" placeholder="组员姓名或昵称" autocomplete="off"/></div><div class="field"><label for="member-password">初始密码</label><input id="member-password" type="password" required minlength="6" maxlength="128" placeholder="至少 6 位" autocomplete="new-password"/></div></div><div class="field"><label for="member-limit">平台审核历史每日额度</label><input id="member-limit" type="number" min="0" max="10000" step="1" value="50" required/></div><div class="create-bottom"><div><label><input id="member-review" type="checkbox" checked/>允许 Agent 审核</label><label><input id="member-star" type="checkbox"/>星标成员：开放个人创作工作台</label></div><div><button type="button" class="subtle-button" id="cancel-create">取消</button><button type="submit" class="primary-button">${icon('check')}确认开通</button></div></div></form><p id="member-message" class="form-message" role="status"></p><div class="members-list" id="members-list">正在读取成员…</div>`;
  iconsReady();
  $('#members-list').insertAdjacentHTML('beforebegin','<label class="member-search">搜索成员<input id="member-search" type="search" placeholder="姓名或登录账号"></label>');
  $('#member-search').oninput=()=>filterMembers();
  $('#show-create').addEventListener('click',()=>{$('#create-member-form').hidden=false;$<HTMLInputElement>('#member-username').focus();});
  $('#cancel-create').addEventListener('click',()=>{$('#create-member-form').hidden=true;$<HTMLFormElement>('#create-member-form').reset();});
  $('#create-member-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$<HTMLButtonElement>('#create-member-form button[type="submit"]');button.disabled=true;
    try{await api('members','POST',{username:$<HTMLInputElement>('#member-username').value,displayName:$<HTMLInputElement>('#member-displayname').value,password:$<HTMLInputElement>('#member-password').value,canReview:$<HTMLInputElement>('#member-review').checked,star:$<HTMLInputElement>('#member-star').checked,dailyReviewLimit:Number($<HTMLInputElement>('#member-limit').value)});$('#member-message').textContent='账号已开通。请将账号和初始密码告知该组员，成员可登录后自行修改密码。';$('#member-message').classList.add('success');$<HTMLFormElement>('#create-member-form').reset();$('#create-member-form').hidden=true;await refreshMembers();}
    catch(error){memberError(error);}finally{button.disabled=false;}
  });
  await refreshMembers();
}
function memberError(error:unknown){const target=document.querySelector('#member-message');if(target){target.textContent=error instanceof Error?error.message:'操作未完成。';target.classList.remove('success');}else managementError(error);}
let activityPage=1, activityRequest=0;
const beijingDay=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
async function mountActivity(){
  $('#activity-panel').insertAdjacentHTML('beforeend',`<section class="review-activity"><div class="members-heading"><div><h2>审核记录</h2><p>按日期和成员查看审核结果与平台额度。</p></div><button id="activity-refresh" class="subtle-button">刷新记录</button></div><div class="activity-filters"><label>审核日期<input id="activity-date" type="date" value="${beijingDay()}" required/></label><label>成员<select id="activity-member"><option value="">全部成员</option></select></label><span id="activity-total" role="status"></span></div><div id="activity-summary" class="activity-summary"></div><p id="activity-error" role="status"></p><div id="activity-records" class="activity-records"></div><div class="activity-pager"><button class="subtle-button" id="activity-prev">上一页</button><span id="activity-page"></span><button class="subtle-button" id="activity-next">下一页</button></div></section>`);
  $('#activity-close').onclick=()=>$<HTMLDialogElement>('#activity-report').close();
  $('#activity-refresh').onclick=()=>void loadActivity();
  for(const selector of ['#activity-date','#activity-member'])$(selector).addEventListener('change',()=>{activityPage=1;void loadActivity();});
  $('#activity-prev').onclick=()=>{activityPage--;void loadActivity();};
  $('#activity-next').onclick=()=>{activityPage++;void loadActivity();};
  $('#activity-records').onclick=event=>{
    const button=(event.target as Element).closest<HTMLButtonElement>('[data-activity-report]');
    if(button)void showActivityReport(button);
  };
  await loadActivity();
}
async function loadActivity(){
  if(!document.querySelector('#activity-date'))return;
  const request=++activityRequest;
  const query=new URLSearchParams({date:$<HTMLInputElement>('#activity-date').value,member:$<HTMLSelectElement>('#activity-member').value,page:String(activityPage)});
  $('#activity-error').textContent='';
  try{
    const data=await api(`review-activity?${query}`);
    if(request!==activityRequest||!document.querySelector('#activity-date'))return;
    const member=$<HTMLSelectElement>('#activity-member'),selected=member.value;
    member.innerHTML='<option value="">全部成员</option>'+data.members.map((m:any)=>`<option value="${escape(m.id)}">${escape(m.display_name)} · @${escape(m.username)}</option>`).join('');member.value=selected;
    const list=data.members.filter((m:any)=>!selected||m.id===selected);
    $('#activity-summary').innerHTML=list.map((m:any)=>`<button type="button" data-member-filter="${escape(m.id)}"><strong>${escape(m.display_name)}</strong><b>${m.used}<small> / ${m.daily_review_limit} 平台次数</small></b><span>${m.completed} 完成 · ${m.active} 进行中 · ${m.failed} 未完成</span></button>`).join('');
    $('#activity-summary').querySelectorAll<HTMLButtonElement>('[data-member-filter]').forEach(button=>button.onclick=()=>{member.value=button.dataset.memberFilter!;activityPage=1;void loadActivity();});
    $('#activity-total').textContent=`共 ${data.total} 个游戏 · 北京时间`;
    $('#activity-records').innerHTML=data.records.length?`<table><thead><tr><th>时间 / 成员</th><th>游戏</th><th>审核状态</th><th>平台次数</th><th>分数 / 报告</th></tr></thead><tbody>${data.records.map((r:any)=>`<tr><td><time>${escape(new Date(r.created_at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}))}</time><small>${escape(r.display_name||r.username||'已删除成员')}</small></td><td><strong>${escape(r.title)}</strong><small>${escape(r.filename||'未记录文件名')}</small></td><td><span class="activity-status ${escape(r.status)}">${escape(reviewTaskStatus(r).label)}</span>${reviewTaskStatus(r).detail?`<small title="${escape(reviewTaskStatus(r).detail)}">${escape(reviewTaskStatus(r).detail)}</small>`:''}</td><td>${r.quota_charged?'1 次':'不占平台额度'}</td><td>${r.result_id&&r.score!==null?`<button class="text-button" data-activity-report="${Number(r.result_id)}">${Number(r.score)} / 9 · 查看 ↗</button>`:r.result_id?'报告已删除':'—'}</td></tr>`).join('')}</tbody></table>`:'<p class="empty-state">这一天还没有审核记录。</p>';
    const pages=Math.max(1,Math.ceil(data.total/data.pageSize));
    $('#activity-page').textContent=`${data.page} / ${pages}`;
    $<HTMLButtonElement>('#activity-prev').disabled=data.page<=1;
    $<HTMLButtonElement>('#activity-next').disabled=data.page>=pages;
  }catch(error){if(request===activityRequest&&document.querySelector('#activity-error'))$('#activity-error').textContent=error instanceof Error?error.message:'记录读取失败，请刷新。';}
}
async function showActivityReport(button:HTMLButtonElement){
  button.disabled=true;
  try{
    const report=await withProgress('读取审核报告',async()=>{
      const response=await fetch(`/api/forge/reviews/${button.dataset.activityReport}`);
      const data=await response.json();if(!response.ok)throw new Error(data.error||'报告读取失败。');return data;
    },{compact:true});
    const modulePath=new URL('/forge/review-workspace.js',location.origin).href;
    const {reviewHtml,reportText}=await import(/* @vite-ignore */ modulePath);
    if(!document.querySelector('link[data-review-styles]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/forge/review-workspace.css';link.dataset.reviewStyles='true';document.head.append(link);}
    $('#activity-report-content').innerHTML=reviewHtml(report);
    $('#activity-report-content').querySelectorAll<HTMLButtonElement>('[data-report-jump]').forEach(b=>b.onclick=()=>$('#activity-report-content').querySelector(b.dataset.reportJump!)?.scrollIntoView({block:'start'}));
    $('#activity-report-content [data-copy-fix]').addEventListener('click',()=>void navigator.clipboard.writeText(report.result.fix_prompt||''));
    $('#activity-report-content [data-copy-report]').addEventListener('click',()=>void navigator.clipboard.writeText(reportText(report)));
    $('#activity-report-content [data-download-report]').addEventListener('click',()=>{const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([reportText(report)],{type:'text/markdown;charset=utf-8'}));link.download='review.md';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);});
    $<HTMLDialogElement>('#activity-report').showModal();
  }catch(error){if(adminTab==='forge')managementError(error);else memberError(error);}finally{button.disabled=false;}
}
async function refreshMembers(){
  try{
    const data=await api('members')as{members:MemberView[]};
    $('#members-list').innerHTML=data.members.length?`<div class="member-list-header"><span>成员 / 登录账号</span><span>平台历史额度 / 日</span><span>审核 / 创作权限</span><span>账号状态</span><span>操作</span></div>${data.members.map(member=>`<article class="member-row"><div class="member-person"><div class="member-avatar">${escape(member.displayName.slice(0,1))}</div><div><strong>${escape(member.displayName)}</strong><small>@${escape(member.username)}</small></div></div><form class="member-quota" data-quota="${member.id}"><input type="number" min="0" max="10000" step="1" value="${member.dailyReviewLimit??50}" required aria-label="${escape(member.username)} 平台历史每日审核额度"/><button type="submit" class="text-button">保存</button></form><div class="member-permissions"><label class="permission-control"><input type="checkbox" data-permission="${member.id}" aria-label="${escape(member.username)} 检查权限" ${member.canReview?'checked':''}/><span>${member.canReview?'可审核':'不可审核'}</span></label><label class="permission-control"><input type="checkbox" data-star="${member.id}" aria-label="${escape(member.username)} 星标创作权限" ${member.star?'checked':''}/><span>${member.star?'★ 可创作':'普通成员'}</span></label></div><button class="account-state ${member.enabled?'enabled':''}" data-enabled="${member.id}" data-next="${!member.enabled}"><span class="status-dot"></span>${member.enabled?'使用中':'已停用'}</button><button class="text-button" data-show-reset="${member.id}">${icon('key-round')}重置密码</button><form class="reset-password" data-reset-form="${member.id}" hidden><input type="password" minlength="6" maxlength="128" placeholder="输入新的密码，至少 6 位" aria-label="${escape(member.username)} 新密码" autocomplete="new-password" required/><button class="subtle-button" type="submit">确认重置</button></form></article>`).join('')}`:`<div class="empty-state">${icon('users')}<p>还没有成员账号</p><span>点击上方「开通成员账号」，邀请组员开始检查。</span></div>`;
    document.querySelectorAll<HTMLInputElement>('[data-star]').forEach(input=>input.onchange=async()=>{input.disabled=true;try{await api(`members/${input.dataset.star}`,'PATCH',{star:input.checked});await refreshMembers();}catch(error){input.checked=!input.checked;memberError(error);}finally{input.disabled=false;}});
    document.querySelectorAll<HTMLInputElement>('[data-permission]').forEach(input=>input.addEventListener('change',async()=>{input.disabled=true;try{await api(`members/${input.dataset.permission}`,'PATCH',{canReview:input.checked});await refreshMembers();}catch(error){input.checked=!input.checked;memberError(error);}finally{input.disabled=false;}}));
    document.querySelectorAll<HTMLButtonElement>('[data-enabled]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api(`members/${button.dataset.enabled}`,'PATCH',{enabled:button.dataset.next==='true'});await refreshMembers();}catch(error){memberError(error);}finally{button.disabled=false;}}));
    document.querySelectorAll<HTMLButtonElement>('[data-show-reset]').forEach(button=>button.addEventListener('click',()=>{const form=document.querySelector<HTMLFormElement>(`[data-reset-form="${button.dataset.showReset}"]`)!;form.hidden=!form.hidden;if(!form.hidden)form.querySelector('input')!.focus();}));
    document.querySelectorAll<HTMLFormElement>('[data-reset-form]').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button')!;button.disabled=true;try{await api(`members/${form.dataset.resetForm}`,'PATCH',{password:form.querySelector('input')!.value});$('#member-message').textContent='密码已重置，旧登录状态已失效。请告知该成员新密码。';$('#member-message').classList.add('success');await refreshMembers();}catch(error){memberError(error);}finally{button.disabled=false;}}));
    document.querySelectorAll<HTMLFormElement>('[data-quota]').forEach(form=>form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button')!;button.disabled=true;try{await api(`members/${form.dataset.quota}`,'PATCH',{dailyReviewLimit:Number(form.querySelector('input')!.value)});$('#member-message').textContent='平台历史每日额度已保存；仅适用于平台模型，本机 Agent 审核不受影响。';$('#member-message').classList.add('success');await refreshMembers();await loadActivity();}catch(error){memberError(error);}finally{button.disabled=false;}});
    filterMembers();
    iconsReady();
  }catch(error){memberError(error);}
}
function filterMembers(){
  const term=$<HTMLInputElement>('#member-search').value.trim().toLocaleLowerCase();
  $('#members-list').querySelectorAll<HTMLElement>('.member-row').forEach(row=>{row.hidden=!!term&&!row.querySelector('.member-person')?.textContent?.toLocaleLowerCase().includes(term);});
}
