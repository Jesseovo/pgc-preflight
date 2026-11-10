import {createPageNavigation,prepareReviewReads} from './navigation.js';
import {renderSquare,prepareSquare} from './square-route.js';
import {mountMemberShell} from './member-shell.js';
// PGC Forge front end. Vanilla JS, no build step.
import {createReadCache,waitVisible,patchHtml,createTaskReader} from './experience.js';
const metadataReads=createReadCache();
const taskReads=createReadCache({ttl:800});
import { startTask, withProgress, progressHtml } from './progress.js';
import { readXlsxRows, listMembers, sheetToWorks } from './review-sheet.js';
import {briefDocument,versionDocument} from './artifact-view.js';
import {gamePlayer,bindGamePlayers} from './game-player.js';

const DIMS = ["subject", "medium", "gesture", "structure", "mood"];
const DIM_LABEL = { subject: "题材", medium: "美术媒介", gesture: "手势", structure: "挑战结构", mood: "情绪基调" };
const STATUS_LABEL = {
  approved: "已通过", preapproved: "组长已通过", pending: "待审核", rejected: "需修改",
  dropped: "自己删掉", shelved: "做了没交", local: "本地",
};
const EXPORT_SNIPPET = `(async()=>{const get=u=>fetch(u).then(r=>r.json());const list=[];for(const q of ['','&status=deleted','&scope=review']){for(let p=1;p<30;p++){const j=await get('/api/works?page='+p+q);list.push(...(j.works||[]).map(w=>({...w,_peer:q==='&scope=review'})));if(!j.pagination||p>=j.pagination.totalPages)break;}}const seen=new Set(),works=[];for(const w of list){if(seen.has(w.id))continue;seen.add(w.id);const d=await get('/api/works/'+w.id);const sc=x=>x?JSON.parse(x).map(k=>k.score).join('/'):null;works.push({id:w.id,title:w.title,desc:w.description,status:w.status,deleted:w.deleted,source:w._peer?'peer':'mine',versions:(d.versions||[]).map(v=>({r:v.revision,s:sc(v.scores),ps:sc(v.pre_scores),fb:v.feedback,pfb:v.pre_feedback}))});}const out=JSON.stringify({works});try{copy(out);console.log('已复制 '+works.length+' 款作品，回到 PGC Forge 粘贴导入');}catch(e){console.log(out);}})();`;

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const memberOnly = document.body.dataset.memberOnly === "true" || location.pathname === "/review";
const state = { session: null, tab: memberOnly ? "review" : "picks", vocab: null, settings: null, info: null, drawn: [], busy: false, showDup: false, cardNotices: new Map() };
const creativeV2Available = () => state.info?.creative_v2_available !== false;
let statusReady = Promise.resolve();

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const hexOk = (h) => /^#[0-9a-f]{3,8}$/i.test(String(h || "").trim());

function toast(msg, ms = 2600) {
  setPageNotice(msg, ms);
}

function focusCardActivity(root, topicId) {
  const card = [...(root?.querySelectorAll('[data-id]') || [])].find(item => Number(item.dataset.id) === Number(topicId));
  const status = card?.querySelector('.creation-job-progress, .pgc-inline-wait, .creation-card-notice, .bad.small');
  if (!status) return;
  if (!status.hasAttribute('tabindex')) status.setAttribute('tabindex', '-1');
  status.focus({ preventScroll: true });
}

async function rawApi(method, path, data) {
  if(method!=='GET'){
    metadataReads.clear();taskReads.clear();
    const [route,query] = path.split('?',2);
    if(method==='POST'){
      const params = new URLSearchParams(query);
      const creation = route==='expand'||/^topics\/\d+\/(brief|preview|assets|game)$/.test(route);
      if(creation){await statusReady;if(creativeV2Available())params.set('creative_version','2');}
      if(state.executor==='agent'&&(creation||route==='mechanisms/check'))params.set('executor','agent');
      if(params.size)path=`${route}?${params}`;
    }
  }
  const load=()=>fetchApi(method,path,data);
  if(method==='GET'&&/^(topics\?|topics\/\d+\?summary=1$|products$|state$|settings$|vocab$)/.test(path))return metadataReads.read(path,load);
  if(method==='GET'&&/^generation-jobs/.test(path))return taskReads.read(path,load);
  try{return await load();}finally{if(method!=='GET'){metadataReads.clear();taskReads.clear();}}
}
async function fetchApi(method, path, data) {
  const options = {signal:AbortSignal.timeout(path === 'review/jobs' && method === 'POST' ? 60000 : 30000)};
  const res = await fetch("/api/forge/" + path, {
    ...options,
    method,
    headers: { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  let out = null;
  try { out = await res.json(); } catch {}
  if(res.status===403){metadataReads.clear();taskReads.clear();}
  if (res.status === 401) {
    metadataReads.clear();taskReads.clear();sessionStorage.removeItem("forge-navigation");
    location.replace('/login');
    throw new Error((out && out.error) || "未授权");
  }
  if (!res.ok) {
    const error = new Error((out && out.error) || `请求失败 ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return out;
}

async function api(method,path,data,progress) {
  const out=await rawApi(method,path,data);
  if(path==='expand')return out;
  return out?.pending && out.jobId ? observeGeneration({id:out.jobId},progress) : out;
}
const taskReader=createTaskReader(()=>fetchApi('GET','generation-jobs'),id=>fetchApi('GET',`generation-jobs/${id}`));
const generationPolls=new Map();
const GENERATION_LABELS={suggest:'补充词库',tag:'自动打标签'};
function observeGeneration(row,provided) {
  if(generationPolls.has(row.id))return generationPolls.get(row.id);
  const task=provided||startTask(GENERATION_LABELS[row.kind]||'后台生成',{key:`generation-${row.id}`,tray:false,detail:row.detail||'等待后台执行…'});
  const promise=(async()=>{

    try{
      while(true){
        let saved;
        try{saved=await taskReader.read(row.id);}
        catch(error){
          if(error.status===401||error.status===403||error.status===404)throw error;
          task.update({detail:'正在重新连接，后台生成继续运行…'});
          continue;
        }
        if(saved.status==='error')throw new Error(saved.error||'生成未完成，请手动重试。');
        if(saved.status==='done'){
          let result=saved.result||{};
          if(result.version_id){
            const version=await rawApi('GET',`topics/${result.id}/versions/${encodeURIComponent(result.version_id)}`);
            if(result.disposition==='pending'){
              const pending=Object.assign(new Error('结果已保存为待确认版本，请在“历史版本”中查看并选择采用。'),{versionPending:true,topicId:result.id});
              throw pending;
            }
            const content=version.content;
            result={...result,status:'done',...(version.kind==='preview'?{svg:content}:version.kind==='brief'?{brief:content}:version.kind==='assets'?{assets:content}:version.kind==='game'?{html:content,has_product:true}:{})};
          }
          if(!provided){
            task.done('已完成');
          }
          return result;
        }
        if(['suggest','tag'].includes(saved.kind)){
          task.update({
            label:GENERATION_LABELS[saved.kind],
            status:saved.status==='queued'?'waiting':'running',
            detail:saved.detail||(saved.status==='queued'?'等待 Agent 领取任务…':'等待本人的 Agent 回传…'),
          });
        }else task.update({status:saved.executor==='agent'?'waiting':'running',detail:(saved.executor==='agent'?'个人 Agent · ':'平台执行 · ')+(saved.detail||(saved.executor==='agent'?'等待本人的 Agent 回传…':'等待模型输出…'))});

      }
      throw new Error('后台任务尚未结束，请稍后刷新查看。');
    }catch(error){if(!provided&&!error.versionPending)task.fail(error.message);throw error;}
    finally{generationPolls.delete(row.id);metadataReads.clear();taskReads.clear();}
  })();
  generationPolls.set(row.id,promise);return promise;
}

async function guard(btn, fn, label) {
  if (btn) { btn.disabled = true; btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true'); }
  try {
    return await withProgress(label || btn?.textContent?.trim() || "正在保存", fn, {compact:true,tray:false});
  } catch (e) {
    toast(e.message, 4200);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy'); }
  }
}

let modalTrigger = null;
function openModal(title, html, trigger = document.activeElement) {
  modalTrigger = trigger instanceof HTMLElement ? trigger : null;
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  bindGamePlayers($("#modalBody"));
  const dialog = $("#modal");
  dialog.hidden = false;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'modalTitle');
  $('#modalClose').focus({ preventScroll: true });
  if (window.frameElement) window.frameElement.scrollIntoView({ block: 'center', behavior: 'instant' });
}
function closeModal() {
  $("#modal").hidden = true;
  $("#modalBody").querySelectorAll('iframe').forEach(frame => frame.remove());
  modalTrigger?.focus?.({ preventScroll: true });
  modalTrigger = null;
}
$("#modalClose").onclick = closeModal;
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener('keydown', event => {
  if ($('#modal').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...$('#modal').querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')]
    .filter(element => element.getClientRects().length);
  if (!focusable.length) { event.preventDefault(); $('#modalClose').focus(); return; }
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

function showLogin() { location.replace('/login'); }
$("#loginForm").onsubmit = (e) => { e.preventDefault(); showLogin(); };

function download(filename, text, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast("复制失败，请手动选择文字复制");
    return false;
  }
}

function setPageNotice(message, duration = 3000) {
  state.pageNotice = message;
  const paint = () => {
    if (!view.isConnected || !state.pageNotice) return;
    let status = $('#forgePageNotice');
    if (!status) { status = document.createElement('p'); status.id = 'forgePageNotice'; status.className = 'forge-page-notice small'; status.setAttribute('role', 'status'); view.prepend(status); }
    status.textContent = state.pageNotice;
  };
  paint();
  clearTimeout(setPageNotice.timer);
  const current = message;
  setPageNotice.timer = setTimeout(() => {
    if (state.pageNotice !== current) return;
    state.pageNotice = '';
    $('#forgePageNotice')?.remove();
  }, duration);
}

function setCardNotice(topic, card, message, selector = '.creation-card-notice') {
  if (!card) return;
  let status = card.querySelector(selector);
  if (!status) { status = document.createElement('p'); status.className = selector.replace(/^\./, ''); status.setAttribute('role', 'status'); card.querySelector('.body')?.append(status); }
  status.textContent = message;
  clearTimeout(topic._noticeTimer);
  topic._noticeTimer = setTimeout(() => { if (status.isConnected) status.remove(); }, 2600);
}

function setTopicNotice(topic, message, root = view) {
  topic._notice = message;
  state.cardNotices.set(topic.id, message);
  const card = [...(root?.querySelectorAll('[data-id]') || [])].find(item => Number(item.dataset.id) === Number(topic.id));
  if (card) setCardNotice(topic, card, message);
  clearTimeout(topic._noticeTimer);
  topic._noticeTimer = setTimeout(() => {
    if (state.cardNotices.get(topic.id) === message) state.cardNotices.delete(topic.id);
    topic._notice = '';
    const current = [...view.querySelectorAll('[data-id]')].find(item => Number(item.dataset.id) === Number(topic.id));
    current?.querySelector('.creation-card-notice')?.remove();
  }, 2600);
}

function repaintFor(root, repaint) { return () => {
  if (!root?.isConnected) return;
  const active = root.ownerDocument.activeElement;
  const card = active instanceof Element && root.contains(active) ? active.closest('[data-id]') : null;
  const id = card?.dataset.id;
  const identity = active instanceof Element && root.contains(active)
    ? ['data-act','data-viewer-act','data-viewer-version'].find(name => active.hasAttribute(name))
    : null;
  const value = identity ? active.getAttribute(identity) : null;
  repaint();
  bindGamePlayers(root);
  if (!id || !identity) return;
  const candidate = active?.dataset.candidate;
  const preferred = [...root.querySelectorAll(`[data-id="${CSS.escape(id)}"] [${identity}]`)].find(item => item.getAttribute(identity) === value&&item.dataset.candidate===candidate);
  if (preferred?.disabled) { focusCardActivity(root, id); return; }
  const target = preferred
    || (identity === 'data-viewer-version' ? root.querySelector(`[data-id="${CSS.escape(id)}"] [data-viewer-act="back"]`) : null)
    || [...root.querySelectorAll(`[data-id="${CSS.escape(id)}"] [data-act]`)].find(item => !item.disabled);
  if (target && !target.disabled) target.focus({preventScroll:true});
  else if (id) focusCardActivity(root, id);
}; }

const stageLabels={build:'制作',polish:'精修',repair:'定向修复',repair2:'第二次定向修复'};
function creationChecksHtml(viewer) {
  const {checks,evidence,record} = viewer;
  const hash = (label,value) => value ? `<p class="small"><b>${label}</b> <code style="overflow-wrap:anywhere">${esc(value)}</code></p>` : '';
  const intro='<p class="small muted">创作阶段记录与正式审核分别保存。自检说明使用的采集范围与尚未验证的项目。</p>';
  if(evidence&&record){
    const shots=Array.isArray(evidence.shots)?evidence.shots:[];
    return intro+`<h3>${esc(stageLabels[record.stage]||record.stage)} · 原始采集</h3>
      ${hash('HTML 摘要',record.content_hash)}${hash('采集摘要',record.evidence_hash)}
      <div class="creation-viewer-versions">${shots.filter(shot=>/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(shot?.data||'')).map(shot=>`<figure style="margin:0">
        <img class="preview" src="${esc(shot.data)}" loading="lazy" decoding="async" alt="${esc(shot.label||'原始视口截图')}" style="display:block;width:100%;max-width:360px">
        <figcaption class="small">${esc(shot.label||'')} · ${esc(shot.id||'')}</figcaption>
      </figure>`).join('')}</div>
      <details><summary>查看采集记录</summary><pre class="md">${esc(JSON.stringify(evidence.probe||{},null,2))}</pre></details>`;
  }
  return intro+(checks.length?`<div class="creation-viewer-versions">${checks.map((item,index)=>{
    const result=item.self_check||{},check=result.selfCheck;
    return `<section class="box">
      <div class="row"><strong class="grow">${esc(stageLabels[item.stage]||item.stage)}</strong>${item.evidence_hash?`<button class="ghost small" data-viewer-act="creation-evidence" data-check-index="${index}">看本阶段原图</button>`:''}</div>
      <p class="muted small">${esc(item.created_at||'')}${result.model?` · ${esc(result.model)}`:''}</p>
      ${hash('产物版本',item.version_id)}${hash('HTML 摘要',item.content_hash)}${hash('采集摘要',item.evidence_hash)}
      ${hash('自检所依据的采集摘要',result.judgedEvidenceHash)}
      ${check?.findings?.length?`<ul>${check.findings.map(finding=>`<li><b>${esc(({confirmed:'已确认',experience:'体验建议',unverified:'待验证'})[finding.kind]||finding.kind)}</b> · ${esc(finding.phenomenon)}</li>`).join('')}</ul>`:''}
      ${check?.unverified?.length?`<p class="small">未验证 · ${esc(check.unverified.join('、'))}</p>`:''}
      <details><summary>查看自检原文</summary><pre class="md">${esc(JSON.stringify(result,null,2))}</pre></details>
    </section>`;
  }).join('')}</div>`:'<p class="muted small">当前没有制作自检记录。</p>');
}

function renderCardViewer(topic) {
  const viewer = topic._viewer;
  if (!viewer) return '';
  const labels = {brief:'简报',preview:'样板图',assets:'美术资产',game:'游戏成品',versions:'历史版本',creationChecks:'制作自检'};
  let body = '';
  if (viewer.kind === 'versions') {
    if (viewer.version) body = `${versionDocument(viewer.version, topic.id)}`;
    else body = `<div class="creation-viewer-versions">${viewer.versions?.map(version => `<div class="creation-viewer-version"><span><b>${esc(VERSION_LABELS[version.kind]||version.kind)}</b><small>${esc(version.created_at||'')} · ${version.current||version.disposition==='current'?'当前版本':version.disposition==='pending'?'待确认结果':'历史版本'}${version.stale?' · 上游版本已变化':''}</small></span><button class="ghost small" data-viewer-version="${esc(version.id)}">${['game','product','assets','preview'].includes(version.kind)?'预览':'阅读'}</button></div>`).join('')||'<p class="muted small">还没有版本记录。</p>'}</div>`;
  } else if (viewer.version) body = versionDocument(viewer.version, topic.id);
  else if (viewer.kind === 'brief') body = briefDocument(viewer.content||'');
  else if (viewer.kind === 'preview') body = `<img class="preview" style="max-width:360px;margin:0 auto" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(viewer.content||'')}" alt="样板图预览">`;
  else if (viewer.kind === 'assets') body = `<iframe class="assets-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="美术资产预览" src="/api/forge/topics/${topic.id}/assets-preview"></iframe>`;
  else if (viewer.kind === 'game') body = gamePlayer(`/api/forge/topics/${topic.id}/product-preview`,topic.data?.title||'游戏试玩');
  else if (viewer.kind === 'creationChecks') body = creationChecksHtml(viewer);
  const v = viewer.version;
  const buttons = viewer.kind === 'versions'
    ? (v ? `<button class="ghost" data-viewer-act="back">返回版本列表</button><button class="ghost" data-viewer-act="copy-version">复制内容</button><button class="primary" data-viewer-act="restore" ${v.current?'disabled':''}>${v.current?'当前版本':v.disposition==='pending'?'采用此结果':'恢复此版本'}</button>` : '')
    : viewer.kind === 'brief' ? `<button class="ghost" data-viewer-act="copy">复制简报</button><a class="btn" href="/api/forge/topics/${topic.id}/brief" download>下载 .md</a><button class="ghost" data-viewer-act="regenerate">重新生成</button>`
    : viewer.kind === 'preview' ? `<button class="ghost" data-viewer-act="download">下载 SVG</button><button class="ghost" data-viewer-act="regenerate">重新生成</button>`
    : viewer.kind === 'assets' ? `<a class="btn" href="/api/forge/topics/${topic.id}/assets" download>下载资产 HTML</a><button class="ghost" data-viewer-act="regenerate">重新生成</button>`
    : viewer.kind === 'creationChecks' ? (viewer.evidence?'<button class="ghost" data-viewer-act="creation-checks-back">返回制作自检</button>':'')
    : `<a class="btn" href="/api/forge/topics/${topic.id}/product-file">下载 HTML</a><button class="ghost" data-viewer-act="copy">复制 HTML</button><button class="ghost" data-viewer-act="regenerate" ${['queued','running'].includes(topic.product_status)?'disabled':''}>重新制作</button>`;
  const title = v ? `${VERSION_LABELS[v.kind]||v.kind} · ${v.created_at||'历史版本'}` : labels[viewer.kind];
  return `<section class="creation-viewer" data-viewer-kind="${esc(viewer.kind)}"><header class="creation-viewer-head"><strong>${esc(title)}</strong><button type="button" class="ghost small" data-viewer-act="close" aria-label="收起查看器">收起</button></header>${v?.stale?'<p class="small bad">生成时使用的上游内容已变化，采用前请核对。</p>':''}${viewer.notice?`<p class="creation-viewer-notice small" role="status">${esc(viewer.notice)}</p>`:''}<div class="creation-viewer-body">${body}</div><footer class="creation-viewer-actions">${buttons}</footer></section>`;
}

function closeCardViewer(topic, root, repaint) {
  const card = root?.querySelector(`[data-id="${topic.id}"]`);
  card?.querySelectorAll('.creation-viewer-slot iframe').forEach(frame => frame.remove());
  card?.querySelector('.creation-viewer-slot')?.replaceChildren();
  topic._viewer = null;
  repaint?.();
}

async function openCardArtifact(button, topic, kind, repaint, root) {
  const card = button?.closest('[data-id]') || root?.querySelector(`[data-id="${topic.id}"]`);
  if (topic._viewer?.kind === kind) { closeCardViewer(topic, root, repaint); return; }
  await guard(button, async () => {
    if (kind === 'versions') {
      const response = await api('GET',`topics/${topic.id}/versions`);
      const versions = Array.isArray(response)?response:response.versions||[];
      topic._viewer={kind,versions};
    } else if (kind === 'creationChecks') {
      const checks=await api('GET',`topics/${topic.id}/creation-checks`);
      topic._viewer={kind,checks:Array.isArray(checks)?checks:[]};
    } else if (kind === 'game') topic._viewer={kind};
    else {
      const saved = await api('GET',`topics/${topic.id}`);
      const content = kind==='brief'?(saved.brief_export||saved.brief_md):kind==='preview'?saved.preview_svg:saved.assets_html;
      topic._viewer={kind,content:content||''};
    }
    if (!root?.isConnected) return;
    repaint();
  },`读取${({versions:'历史版本',game:'游戏成品',brief:'简报',preview:'样板图',assets:'美术资产',creationChecks:'制作自检'})[kind]}`);
}

function handleCardViewerAction(event, button, card, topic, repaint, root) {
    const versionId=button.dataset.viewerVersion;
    if(versionId){void guard(button,async()=>{const summary=topic._viewer.versions.find(item=>item.id===versionId);topic._viewer.version={...summary,...await api('GET',`topics/${topic.id}/versions/${encodeURIComponent(versionId)}`)};if(state.tab==='project'){const url=new URL(location.href);url.searchParams.set('version',versionId);history.replaceState(history.state,'',url);}repaint();},'读取历史版本');return;}
    const action=button.dataset.viewerAct;
    if(action==='creation-evidence'){
      void guard(button,async()=>{
        const viewer=topic._viewer,record=viewer?.checks?.[Number(button.dataset.checkIndex)];
        if(!record?.task_id||!stageLabels[record.stage])return;
        const evidence=await api('GET',`topics/${topic.id}/creation-checks/${encodeURIComponent(record.task_id)}/${record.stage}`);
        if(topic._viewer!==viewer)return;
        Object.assign(viewer,{evidence,record});repaint();
      },'读取本阶段原图');
      return;
    }
    if(action==='creation-checks-back'){delete topic._viewer.evidence;delete topic._viewer.record;repaint();return;}
    if(action==='close'&&state.tab==='project'&&state.projectPanel!=='create'){navigateWorkspace({tab:'picks',project:String(topic.id),panel:'create'},true);return;}
    if(action==='close'){closeCardViewer(topic,root,repaint);return;}
    if(action==='back'){topic._viewer.version=null;repaint();return;}
    if(action==='regenerate'){if(topic._viewer.kind==='game')startProductJob(topic,repaint,{regenerate:true});else generateTopicJob(topic._viewer.kind,topic,repaint,true);return;}
    if(action==='copy-version'){
      void guard(button,async()=>{const v=topic._viewer.version;const content=typeof v.content==='string'?v.content:JSON.stringify(v.content,null,2);if(await copyText(content))showViewerNotice(topic,card,'已复制到剪贴板。');});return;
    }
    if(action==='restore'){
      void guard(button,async()=>{const v=topic._viewer.version;await api('POST',`topics/${topic.id}/restore`,{version_id:v.id});topic._viewer=null;topic._pendingVersion=false;setTopicNotice(topic,'版本已恢复；其他历史产物仍可查看。',root);await refreshStatus();state.drawn=[];render();},'恢复历史版本');return;
    }
    if(action==='copy'){
      void guard(button,async()=>{let content=topic._viewer.kind==='game'?(await api('GET',`topics/${topic.id}/product`)).html:topic._viewer.content;if(await copyText(content))showViewerNotice(topic,card,'已复制到剪贴板。');});return;
    }
    if(action==='download'&&topic._viewer.kind==='preview') download(`${topic.data?.title||'preview'}.svg`,topic._viewer.content,'image/svg+xml');
}

function showViewerNotice(topic, card, message) {
  if (!topic._viewer || !card?.isConnected) return;
  topic._viewer.notice = message;
  let status = card.querySelector('.creation-viewer-notice');
  if (!status) {
    status = document.createElement('p');
    status.className = 'creation-viewer-notice small';
    status.setAttribute('role', 'status');
    card.querySelector('.creation-viewer')?.prepend(status);
  }
  if (status) status.textContent = message;
}

async function loadVocab(force) {
  if (!state.vocab || force) state.vocab = await api("GET", "vocab");
  return state.vocab;
}

async function refreshStatus() {
  state.info = await api("GET", "state");
  const i = state.info;
  $("#status").innerHTML = `${esc(state.session?.displayName || "我的空间")} · ${esc(i.games)} 款作品 · ${esc(i.vocab)} 个公共词`;
}

// ---------- tabs ----------

document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b || (memberOnly && b.dataset.tab !== "review")) return;
  if (state.reviewProbing) { toast('正在采集游戏画面，采集结束后即可切换。'); return; }
  navigateWorkspace({tab:b.dataset.tab});
});

// Each render gets a ticket; a slower render for a tab the user already left
// must not overwrite the current view.
let renderSeq=0,viewCleanup;
const pageNavigation=createPageNavigation(view);
function render() {
  const seq=++renderSeq,tab=state.tab;
  const alive=()=>seq===renderSeq;
  const label={square:'游戏广场',project:'项目',draw:'发现选题',picks:'我的项目',products:'已有成品',review:'我的审核',vocab:'词库',games:'历史导入作品',settings:'规则与偏好',agent:'我的 Agent'}[tab];
  const navigation=pageNavigation.begin({alive,scrollTop:history.state?.scrollY||0,label:'正在打开'+label,onCommit(){
    for(const button of document.querySelectorAll('#tabs [data-tab]')){const selected=button.dataset.tab===(tab==='project'?'picks':tab);button.classList.toggle('on',selected);button.setAttribute('aria-current',selected?'page':'false');if(selected&&button.closest('details')&&!matchMedia('(max-width:900px)').matches)button.closest('details').open=true;}
    document.querySelector('.member-square')?.setAttribute('aria-current',tab==='square'?'page':'false');
    document.body.classList.toggle('project-open',tab==='project');document.title=label+' · PGC Preflight';
    view.dataset.page=tab;
  }});
  alive.commit=navigation.commit;
  viewCleanup?.();viewCleanup=undefined;
  view.querySelectorAll('iframe').forEach(frame=>frame.remove());
  if(!$('#modal').hidden)closeModal();
  const fn={square:async alive=>{const cleanup=await renderSquare(view,state.session,alive,alive.commit);if(alive())viewCleanup=cleanup;else cleanup?.();},project:renderProject,draw:renderDraw,picks:renderPicks,products:renderProducts,review:renderReview,vocab:renderVocab,games:renderGames,settings:renderSettings,agent:renderAgent}[tab];
  Promise.resolve().then(()=>fn(alive))
    .then(()=>{if(alive()&&state.pageNotice)setPageNotice(state.pageNotice);})
    .catch(error=>{if(alive())return navigation.commit(()=>{view.innerHTML=`<div class="box bad" role="alert"><p>${esc(error.message)}</p><button class="ghost" data-route-retry>重新读取</button></div>`;view.querySelector('[data-route-retry]').onclick=()=>render();});})
    .finally(()=>navigation.finish());
}

// ---------- project navigation ----------
const navigationMemory=new Map();
history.scrollRestoration='manual';
let navigationScrollTimer;
window.addEventListener('scroll',()=>{if(pageNavigation.pending)return;clearTimeout(navigationScrollTimer);const url=location.href;navigationScrollTimer=setTimeout(()=>{if(!pageNavigation.pending&&location.href===url)history.replaceState({...history.state,scrollY},'',url);},100);},{passive:true});
function navigateWorkspace({tab='picks',project='',panel='create'},replace=false){
  if(!project&&!state.projectId&&state.tab===tab)return;
  clearTimeout(navigationScrollTimer);
  if(!pageNavigation.pending){history.replaceState({...history.state,scrollY},'',location.href);if(!state.projectId)navigationMemory.set(state.tab,{url:location.search,scrollY});}
  const remembered=!project?navigationMemory.get(tab):null;
  const params=remembered?new URLSearchParams(remembered.url):new URLSearchParams({tab});
  if(state.projectLayout==='cards')params.set('layout','cards');
  if(project)params.set('project',project);if(project&&panel!=='create')params.set('panel',panel);
  history[replace?'replaceState':'pushState']({scrollY:remembered?.scrollY||0},'',tab==='square'?'/square'+(remembered?.url||''):'/forge/?'+params);restoreWorkspace();
}
function restoreWorkspace(){
  const q=new URLSearchParams(location.search),tabs=['draw','picks','products','review','vocab','games','settings','agent'];
  state.projectId=/^\d+$/.test(q.get('project')||'')?Number(q.get('project')):null;
  state.projectLayout=q.get('layout')==='cards'?'cards':'list';
  state.projectSearch=q.get('q')||'';state.projectFilter=['working','product','error'].includes(q.get('filter'))?q.get('filter'):'all';state.projectPage=Math.max(1,parseInt(q.get('page')||'1')||1);
  state.projectPanel=['create','play','review','versions'].includes(q.get('panel'))?q.get('panel'):'create';
  state.tab=location.pathname.startsWith('/square')?'square':memberOnly?'review':state.projectId?'project':tabs.includes(q.get('tab'))?q.get('tab'):'picks';
  render();
}
window.addEventListener('popstate',restoreWorkspace);
document.addEventListener('click',event=>{const button=event.target.closest('[data-open-project]');if(button)navigateWorkspace({tab:'picks',project:button.dataset.openProject,panel:button.dataset.projectPanel||'create'});});
const executorControl=()=>`<label class="executor-choice">创作方式 <select data-executor aria-label="创作执行方式"><option value="platform" ${state.executor!=='agent'?'selected':''}>平台执行</option><option value="agent" ${state.executor==='agent'?'selected':''}>个人 Agent</option></select></label>`;
document.addEventListener('change',event=>{if(event.target.matches('[data-executor]')){state.executor=event.target.value;try{sessionStorage.setItem(`forge-executor-${state.session.id}`,state.executor);}catch{}document.querySelectorAll('[data-executor]').forEach(el=>el.value=state.executor);}});
async function renderProject(alive){
  const [topic,rows]=await Promise.all([api('GET',`topics/${state.projectId}?summary=1`),rawApi('GET','generation-jobs').catch(()=>[]),statusReady]);await syncPreviewTasks([topic],rows);if(!alive())return;
  const panel=state.projectPanel;
  const reports=panel==='review'?await api('GET','reviews'):[];
  if(panel==='versions'){const versions=await api('GET',`topics/${topic.id}/versions`);if(!alive())return;topic._viewer={kind:'versions',versions:Array.isArray(versions)?versions:versions.versions||[]};const version=new URLSearchParams(location.search).get('version');if(version){topic._viewer.version=await api('GET',`topics/${topic.id}/versions/${encodeURIComponent(version)}`);if(!alive())return;}}
  if(!alive())return;
  return alive.commit(async()=>{
  view.innerHTML=`<header class="project-heading"><button class="ghost" data-tab="picks">← 我的项目</button><h1>${esc(topic.data?.title||topic.subject||'未命名项目')}</h1><div class="row">${executorControl()}<button class="ghost" data-tab="agent">Agent 接入与任务</button></div><p class="muted">材料和版本保存在当前项目中。生成任务提交后可离开，回来继续查看。</p><nav class="project-tabs" aria-label="项目内容">${[['create','创作'],['play','试玩'],['review','审核'],['versions','版本']].map(([key,label])=>`<button class="ghost" data-project-panel="${key}" aria-current="${panel===key?'page':'false'}">${label}</button>`).join('')}</nav></header><section id="projectContent"></section>`;
  view.querySelectorAll('[data-project-panel]').forEach(button=>button.onclick=()=>navigateWorkspace({tab:'picks',project:String(topic.id),panel:button.dataset.projectPanel},true));
  const root=$('#projectContent');
  if(panel==='review'){
    const related=reports.filter(report=>Number(report.topic_id)===topic.id);
    const prompt=`请阅读 ${location.origin}/agent.md，审核我下载到本地的项目 ${topic.id}（${topic.data?.title||topic.subject}）的准确游戏版本，完成初评和同模型复核后回传报告。仅在确认作品与版本关联后关联项目，不要按同名猜测。`;
    root.innerHTML=`<section class="box"><h2>项目审核</h2><p>将下载的 HTML 与下面的指令交给自己的审核 Agent。</p><button class="primary" id="projectReviewPrompt">复制审核指令</button><button class="ghost" data-tab="review">打开我的审核</button><p class="muted">${related.length} 份已明确关联的报告</p>${related.map(r=>`<p>${esc(r.title)} · ${r.score == null ? '待复核' : `${r.score}/9`} · ${esc(r.created_at)}</p>`).join('')}</section>`;
    $('#projectReviewPrompt').onclick=()=>copyText(prompt);return;
  }
  if(panel==='play'&&!topic.has_product){root.innerHTML='<section class="box"><h2>还没有成品</h2><p>在创作页准备材料并开始制作，完成后即可在这里试玩。</p></section>';return;}
  if(panel==='play')topic._viewer={kind:'game'};
  const paint=()=>{if(!alive())return;patchHtml(root,topicCard(topic,'picks'));bindGamePlayers(root);};
  paint();bindCards(root,()=>[topic],paint);
  root.classList.toggle('project-materials-only',panel!=='create');
  });
}
// ---------- topic cards ----------

function artStyle(d) {
  const p = (d.palette || []).filter(hexOk);
  if (p.length >= 2) return `background: linear-gradient(135deg, ${p[0]} 0%, ${p[1]} 55%, ${p[2] || p[1]} 100%);`;
  return "";
}

function chipsHtml(t) {
  return `<div class="chips">${DIMS.filter(d=>t[d]).map((d) => `<span class="chip" title="${DIM_LABEL[d]}">${esc(t[d])}</span>`).join("")}</div>`;
}

const mechanismChecks = new Map();
const mechanismKey = (topic,index) => `${topic.id}:${index}`;
const mechanismFields = [['subject','题材'],['action','玩家动作'],['rule','核心规则'],['structure','挑战结构']];
const mechanismStateLabels = {
  no_matches:'目录中没有检索到可比较的条目', distinct:'已有结果确认存在机制区别',
  exact:'目录中已有相同机制', duplicate:'比较结果为机制重复',
  uncertain:'比较结果待核对', pending:'等待机制比较',
};
const canChooseMechanism = check => check&&!check.stale&&['distinct','no_matches'].includes(check.effective_state||check.state);
const expandReady = topic => Boolean(topic?.data?.title||Array.isArray(topic?.data?.candidates));

function mechanismBatchCard(topic) {
  const {candidates,recommended} = topic.data;
  const picks = [...new Set(Array.isArray(recommended)?recommended:[])].filter(index=>Number.isInteger(index)&&candidates[index]).slice(0,3);
  const others = candidates.map((_,index)=>index).filter(index=>!picks.includes(index));
  const candidateHtml = index => {
    const candidate=candidates[index],record=mechanismChecks.get(mechanismKey(topic,index)),check=record?.check;
    const result=check?.stale?'目录或候选已更新，请重新查重。':mechanismStateLabels[check?.effective_state||check?.state];
    const reasons=(check?.judgment?.matches||[]).filter(item=>item.reason).map(item=>`<li>${esc(item.reason)}</li>`).join('');
    return `<section class="section" id="mechanism-${topic.id}-${index}">
      <h3>${esc(candidate.title||`候选 ${index+1}`)}</h3>
      <p>${esc(candidate.logline)}</p>
      ${[['strength','创作方向'],['action','动作'],['rule','规则'],['risks','风险']].filter(([key])=>candidate[key]).map(([key,label])=>`<div class="kv"><b>${label}</b>${esc(candidate[key])}</div>`).join('')}
      <details class="topic-details"><summary>玩法与美术细节</summary>${[['subject','题材'],['structure','挑战结构'],['medium','媒介'],['controls','操作'],['core_loop','核心循环'],['progression','节奏'],['art_direction','美术'],['audio','音频']].filter(([key])=>candidate[key]).map(([key,label])=>`<div class="kv"><b>${label}</b>${esc(candidate[key])}</div>`).join('')}</details>
      ${record?.pending?`<div role="status">${progressHtml({label:'机制查重',detail:record.detail||'正在读取机制目录…',status:record.status||'waiting'})}</div>`:''}
      ${record?.error?`<p class="small bad" role="status">${esc(record.error)}</p>`:''}
      ${result?`<p class="small" role="status">${esc(result)}</p>`:''}
      ${reasons||check?.admin_resolution?.reason?`<details class="topic-details"><summary>查看比较说明</summary>${reasons?`<ul>${reasons}</ul>`:''}${check?.admin_resolution?.reason?`<p>${esc(check.admin_resolution.reason)}</p>`:''}</details>`:''}
      ${creativeV2Available()?`<div class="row"><button class="ghost small" data-act="${check&&!check.stale?'mechanismRefresh':'mechanismCheck'}" data-candidate="${index}" ${record?.pending?'disabled':''}>${check?check.stale?'重新查重':'刷新查重记录':'机制查重'}</button>${canChooseMechanism(check)?`<button class="primary small" data-act="mechanismChoose" data-candidate="${index}">选择并登记</button>`:''}</div>`:''}
    </section>`;
  };
  return `<article class="card creation-card" data-id="${topic.id}">
    <div class="art"><div class="title">${esc(topic.subject||'本轮候选')}</div></div>
    <div class="body">${chipsHtml(topic)}<p class="small muted">${candidates.length} 个候选 · ${picks.length} 个推荐</p>
      ${picks.map(candidateHtml).join('')||'<p class="muted small">这一轮没有推荐，仍可查看其他候选。</p>'}
      ${others.length?`<details class="topic-details" data-candidate-more ${topic._showAllCandidates?'open':''}><summary>查看其余 ${others.length} 个候选</summary>${others.map(candidateHtml).join('')}</details>`:''}
    </div>
    <div class="acts"><button class="ghost" data-act="versions">历史版本</button></div>
    <div class="creation-viewer-slot">${renderCardViewer(topic)}</div>
  </article>`;
}

async function trackMechanismCheck(topic,index,response,repaint) {
  const key=mechanismKey(topic,index);
  const record=mechanismChecks.get(key)||{};
  mechanismChecks.set(key,record);
  record.pending=true;
  record.error='';
  record.jobId=response.jobId;
  try {
    const result=response.pending?await observeGeneration({id:response.jobId,kind:'mechanism-check'},{
      update:patch=>{Object.assign(record,{detail:patch.detail,status:patch.status});repaint();},
    }):response;
    const checkId=result?.check_id||response.check_id;
    if(!checkId)throw new Error('任务没有返回可读取的查重记录。');
    record.check=await rawApi('GET',`mechanisms/${encodeURIComponent(checkId)}`);
  } catch(error) {
    record.error=error.message;
  } finally {
    record.pending=false;
    repaint();
  }
}

function resumeMechanismChecks(rows,topics) {
  const known=new Set();
  for(const row of rows){
    const match=row.kind==='mechanism-check'&&row.scope?.match(/:mechanism-check:(\d+):(\d+)$/);
    if(!match)continue;
    const topic=topics.find(item=>item.id===Number(match[1])),index=Number(match[2]);
    if(!topic?.data?.candidates?.[index])continue;
    const key=mechanismKey(topic,index);
    if(known.has(key)||mechanismChecks.get(key)?.pending)continue;
    known.add(key);
    if(['queued','running'].includes(row.status))void trackMechanismCheck(topic,index,{pending:true,jobId:row.id},paintDrawn);
    else if(row.status==='done'&&row.result?.check_id&&!mechanismChecks.has(key))mechanismChecks.set(key,{check:row.result});
    else if(row.status==='error'&&!mechanismChecks.has(key))mechanismChecks.set(key,{error:row.error||'查重未完成。'});
  }
}

function creationFooter(t,mode){
  const active=['queued','running'].includes(t.product_status),saved=!!t.has_product;
  const needsBrief=mode==='picks'&&creativeV2Available()&&!saved&&!active&&!t.has_brief;
  const action=saved?'viewProduct':active?'resumeProduct':needsBrief?'prepareBrief':t.product_status==='error'?'retryProduct':'makeGame';
  const label=saved?'试玩游戏':active?'制作中':needsBrief?'先准备简报':t.product_status==='error'?'重试制作':'开始制作';
  const materials=mode==='picks'?`<div class="creation-materials">${[['brief','简报','has_brief','brief_status'],['preview','样板图','has_preview','preview_status'],['assets','美术资产','has_assets','assets_status']].map(([kind,title,has,status])=>{
    const running=t[status]==='running',blocked=kind==='assets'&&!t.has_brief&&!t[has];
    return `<button class="material-link" data-act="${kind}" ${running&&!t[has]?'disabled title="任务正在后台生成"':blocked?'disabled title="先生成简报，再生成美术资产"':''}><span>${title}</span><small>${running&&!t[has]?'生成中':t[has]?'查看':t[status]==='error'?'重试':blocked?'需先生成简报':'生成'}</small></button>`;
  }).join('')}</div>`:'';
  const checks=creativeV2Available()||t.creative_version===2?'<button class="ghost" data-act="creationChecks">制作自检</button>':'';
  return `<footer class="creation-footer">${materials}<div class="creation-main-actions"><button class="primary" data-act="${action}" ${active&&!saved?'disabled':''}>${label}</button><button class="ghost" data-act="versions">历史版本</button>${checks}</div><details class="creation-more"><summary>更多操作</summary><div>${saved?`<button class="ghost" data-act="regenerateGame" ${active?'disabled':''}>${active?'新版本制作中':'重新制作游戏'}</button>`:''}${mode==='products'&&saved?`<a class="btn" href="/api/forge/topics/${t.id}/product-file">下载 HTML</a>`:''}${mode==='picks'?`<button class="ghost" data-act="${t.status==='made'?'unmake':'make'}">${t.status==='made'?'取消已制作标记':'标记为外部已制作'}</button><button class="ghost bad" data-act="reject">移出候选</button>`:''}</div></details></footer>`;
}

function topicCard(t, mode) {
  const d = t.data || {};
  if (mode==='draw'&&Array.isArray(d.candidates)) return mechanismBatchCard(t);
  if (t.status === "drawn") {
    return `<article class="card pending" data-id="${t.id}">
      <div class="art"><div class="title">…</div></div>
      <div class="body">${chipsHtml(t)}<div class="small">${t._pendingVersion ? '扩写结果已保存为待确认版本，请在历史版本中核对并选择采用。' : t._error ? `<span class="bad">${esc(t._error)}</span>` : t.expand_status === 'running' || t._inflight ? progressHtml({label:"AI 扩写中",detail:t.expand_error || "后台正在扩写选题…"}) : '选题已保存，可以开始扩写。'}</div></div>
      <div class="acts">${t._pendingVersion ? '' : t._error ? `<button class="ghost" data-act="retry">重试扩写</button>` : t.expand_status !== 'running' && !t._inflight ? `<button class="ghost" data-act="retry">开始扩写</button>` : ''}<button class="ghost" data-act="versions">历史版本</button></div>
    </article>`;
  }
  const sw = (d.palette || []).filter(hexOk).map((h) => `<span style="background:${h}" title="${esc(h)}"></span>`).join("");
  const acts = [`<button class="ghost" data-act="versions">历史版本</button>`];
  if (mode === "draw") {
    acts.push(`<button class="ghost good" data-act="like">要</button>`, `<button class="ghost bad" data-act="reject">不要</button>`);
  } else if (mode === 'picks') {
    acts.push(t.status === "made"
      ? `<button class="ghost" data-act="unmake">取消已制作</button>`
      : `<button class="ghost good" data-act="make">标记已制作</button>`);
    acts.push(`<button class="ghost bad" data-act="reject">移出候选</button>`);
  }
  if (mode === 'products') acts.push(`<button class="primary" data-act="viewProduct">查看成品</button>`);
  acts.push(`<button class="ghost" data-act="preview" ${!t.has_preview&&t.preview_status==='running'?'disabled':''}>${!t.has_preview&&t.preview_status === 'running' ? "样板图生成中" : t.has_preview ? "看样板图" : t.preview_status==='error' ? "重试样板图" : "生成样板图"}</button>`);
  acts.push(`<button class="${mode === "picks" ? "primary" : "ghost"}" data-act="brief" ${!t.has_brief&&t.brief_status === 'running'?'disabled':''}>${!t.has_brief&&t.brief_status === 'running' ? "简报生成中" : t.has_brief ? "看简报" : t.brief_status==='error' ? "重试简报" : "生成简报"}</button>`);
  if (mode === "picks" && (t.has_brief || t.brief_status === 'error')) acts.push(`<button class="ghost" data-act="assets" ${!t.has_assets&&t.assets_status === 'running'?'disabled':''}>${!t.has_assets&&t.assets_status === 'running' ? "资产生成中" : t.has_assets ? "看资产" : t.assets_status==='error' ? "重试资产" : "生成资产"}</button>`);
  const working=[['product_status','游戏制作'],['brief_status','简报生成'],['assets_status','资产生成'],['preview_status','样板图生成']].filter(([key])=>['queued','running'].includes(t[key])).map(([,label])=>label);
  return `<article class="card state-${t.status} ${mode==='picks'?'creation-card':''}" data-id="${t.id}">
    <div class="art" style="${artStyle(d)}"><div class="title"><button class="project-title" data-open-project="${t.id}">${esc(d.title||t.subject||'未命名项目')}</button></div></div>
    <div class="body">
      ${chipsHtml(t)}
      <p class="creation-logline">${esc(d.logline)}</p>
      ${t._jobProgress || t._productProgress ? `<div class="creation-job-progress" tabindex="-1" role="group" aria-label="制作任务进度">${progressHtml(t._jobProgress||t._productProgress)}</div>` : working.length?`<div class="creation-job-progress pgc-inline-wait" tabindex="-1" role="group" aria-label="制作任务进度">${progressHtml({label:working.join(' · '),detail:t.product_error||t.brief_error||t.assets_error||t.preview_error||'正在后台处理，完成后自动更新。'})}</div>`:''}
      ${t._pendingVersion ? `<p class="small">结果已保存为待确认版本，可在历史版本中查看并选择采用。</p>` : ''}
      ${t._notice||state.cardNotices.get(t.id) ? `<p class="creation-card-notice small" role="status">${esc(t._notice||state.cardNotices.get(t.id))}</p>` : ''}
      ${[['product_status','product_error','游戏制作'],['brief_status','brief_error','简报生成'],['assets_status','assets_error','资产生成'],['preview_status','preview_error','样板图生成']].filter(([status,error])=>t[status]==='error'&&t[error]).map(([,error,label])=>`<p class="small bad">${label}未完成：${esc(t[error])}${t[error.replace('_error','_status')]==='error'?` <button class="ghost small" data-act="retryJob" data-kind="${error.replace('_error','')}">重试</button>`:''}</p>`).join('')}
      ${t.status === "dup" ? `<div class="small bad">与「${esc(d.dup_of)}」撞题</div>` : ""}
      <details class="topic-details"><summary>查看玩法与美术细节</summary>${d.twist?`<div class="kv"><b>新机制</b>${esc(d.twist)}</div>`:''}${d.controls?`<div class="kv"><b>操作</b>${esc(d.controls)}</div>`:''}${sw?`<div class="swatches">${sw}</div>`:''}${[['core_loop','核心循环'],['progression','节奏'],['art_direction','美术'],['audio','音频'],['why_addictive','吸引点'],['risks','风险']].filter(([key])=>d[key]).map(([key,label])=>`<div class="kv"><b>${label}</b>${esc(d[key])}</div>`).join('')}</details>
      ${mode === "picks" ? `<details class="creation-note-fold" ${t.note || t._noteSaveError ? 'open' : ''}><summary>制作要求 <span>${t.note ? '· 已填写' : '· 可选'}</span></summary><label class="creation-note"><input class="note" type="text" data-act="note" placeholder="填写后自动保存" value="${esc(t.note)}"></label><small class="creation-note-status small ${t._noteSaveError?'bad':''}" role="status" aria-live="polite">${t._noteSavePending?'保存中…':t._noteSaveError?`保存失败：${esc(t._noteSaveError)} <button type="button" class="ghost small" data-act="retryNote">重试保存</button>`:''}</small></details>` : ""}
    </div>
    ${mode==='picks'?creationFooter(t,mode):`<div class="acts">${acts.join('')}</div>`}
    <div class="creation-viewer-slot">${renderCardViewer(t)}</div>
  </article>`;
}

function bindCards(root, list, rerender) {
  const saveNoteFromInput = (input, topic) => {
    const sequence = topic._noteSaveSequence = (topic._noteSaveSequence || 0) + 1;
    topic._noteSaveError = '';
    const statusFor = (message, error = false) => {
      topic._noteSavePending = message === '保存中…';
      topic._noteSaveError = error ? message.replace(/^保存失败：/, '') : '';
      const noteLabel = input.closest('.creation-note');
      let status = noteLabel?.parentElement.querySelector('.creation-note-status');
      if (!status) { status = document.createElement('small'); status.className = 'creation-note-status small'; status.setAttribute('role', 'status'); noteLabel?.insertAdjacentElement('afterend', status); }
      status.classList.toggle('bad', error);
      status.replaceChildren(document.createTextNode(message));
      if (error) {
        status.append(' ');
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'ghost small'; retry.dataset.act = 'retryNote'; retry.textContent = '重试保存';
        status.append(retry);
      }
      if (!message) status.remove();
    };
    statusFor('保存中…');
    void saveTopicNote(topic, input.value, sequence).then(() => {
      if (topic._noteSaveSequence !== sequence) return;
      topic._noteSaveError = '';
      statusFor('');
    }, error => {
      if (topic._noteSaveSequence !== sequence) return;
      topic._noteSaveError = error.message || '保存失败';
      statusFor(`保存失败：${topic._noteSaveError}`, true);
    });
  };
  root.addEventListener("click", async (e) => {
    const card = e.target.closest('.card');
    const id = Number(card?.dataset.id);
    const t = list().find((x) => x.id === id);
    const viewerButton = e.target.closest('[data-viewer-act],[data-viewer-version]');
    if (viewerButton && card && t) { handleCardViewerAction(e, viewerButton, card, t, repaintFor(root, rerender), root); return; }
    if (e.target.closest('[data-act="retryNote"]') && card && t) { saveNoteFromInput(card.querySelector('[data-act="note"]'), t); return; }
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const repaint = repaintFor(root, rerender);
    if (!t) return;
    if (act==='mechanismCheck'||act==='mechanismRefresh'||act==='mechanismChoose') {
      const index=Number(btn.dataset.candidate);
      if(!t.data?.candidates?.[index])return;
      const key=mechanismKey(t,index);
      if(btn.closest('[data-candidate-more]'))t._showAllCandidates=true;
      if(act==='mechanismCheck'){
        const record=mechanismChecks.get(key)||{};
        if(record.pending)return;
        record.pending=true;record.error='';record.detail='正在查询机制目录…';
        mechanismChecks.set(key,record);
        repaint();
        try {
          const response=await rawApi('POST','mechanisms/check',{topic_id:id,candidate_index:index});
          await trackMechanismCheck(t,index,response,()=>root.isConnected?repaint():paintDrawn());
        } catch(error) {
          record.pending=false;record.error=error.message;repaint();
        }
        return;
      }
      if(act==='mechanismRefresh'){
        await guard(btn,()=>trackMechanismCheck(t,index,mechanismChecks.get(key)?.check||{},repaint),'读取最新查重记录');
        return;
      }
      await guard(btn,async()=>{
        const record=mechanismChecks.get(key);
        if(!canChooseMechanism(record?.check))return;
        const check=await rawApi('GET',`mechanisms/${encodeURIComponent(record.check.check_id)}`);
        record.check=check;
        if(!canChooseMechanism(check)){repaint();return;}
        const shared=mechanismFields.map(([field,label])=>`${label}  ${check.candidate?.[field]||''}`).join('\n');
        if(!confirm(`选择此候选并创建项目？以下四项摘要会分享给其他 Star 创作者。\n\n${shared}`))return;
        let chosen;
        try { chosen=await rawApi('POST','mechanisms/choose',{topic_id:id,candidate_index:index,check_id:check.check_id}); }
        catch(error) {
          if(error.status===409)await trackMechanismCheck(t,index,check,repaint);
          throw error;
        }
        if(!chosen?.topic_id)throw new Error('登记完成后未返回项目编号，请刷新项目列表。');
        record.check={...check,stale:true};
        navigateWorkspace({tab:'picks',project:String(chosen.topic_id)});
      },'登记所选机制');
      return;
    }
    if (act === 'versions') { await openCardArtifact(btn,t,'versions',repaint,root); return; }
    if (act === 'creationChecks') { await openCardArtifact(btn,t,'creationChecks',repaint,root); return; }
    if (act === 'prepareBrief') {
      setTopicNotice(t,'请先在材料区生成简报，再开始制作。',root);
      card.querySelector('[data-act="brief"]:not(:disabled)')?.focus();
      return;
    }
    if (act === 'makeGame') {
      if (t.has_product && t.product_status !== 'running') await openCardArtifact(btn, t, 'game', repaint, root);
      else startProductJob(t, repaint, {resume:['queued', 'running'].includes(t.product_status)});
      return;
    }
    if(act==='resumeProduct'||act==='retryProduct'||act==='regenerateGame'){startProductJob(t,repaint,{resume:act==='resumeProduct',regenerate:act==='regenerateGame'});return;}
    if (act === 'viewProduct') { await openCardArtifact(btn,t,'game',repaint,root); return; }
    if (act === 'retryJob') { if(btn.dataset.kind==='product')startProductJob(t,repaint,{regenerate:!!t.has_product});else generateTopicJob(btn.dataset.kind,t,repaint,!!t[`has_${btn.dataset.kind}`]);return; }
    const job = TOPIC_JOBS[act];
    if (job) {
      if (t[job.has]) { await openCardArtifact(btn, t, act, repaint, root); return; }
      generateTopicJob(act, t, repaint, false); return;
    }
    await guard(btn, async (progress) => {
      if (act === "like" || act === "reject" || act === "make" || act === "unmake") {
        const status = { like: "liked", reject: "rejected", make: "made", unmake: "liked" }[act];
        Object.assign(t, await api("PATCH", `topics/${id}`, { status }));
        if (act === "like") setTopicNotice(t, '已加入候选', root);
        repaint();
      } else if (act === "retry") {
        await expandIds([id]);
      }
    });
  });
  root.addEventListener("change", async (e) => {
    if (e.target.dataset.act !== "note") return;
    const id = Number(e.target.closest(".card").dataset.id);
    const t = list().find((x) => x.id === id);
    saveNoteFromInput(e.target, t);
  });
  root.addEventListener('toggle',event=>{
    if(!event.target.matches?.('[data-candidate-more]'))return;
    const topic=list().find(item=>item.id===Number(event.target.closest('.card')?.dataset.id));
    if(topic)topic._showAllCandidates=event.target.open;
  },true);
  // Restore observation after a reload without starting a second model job.
  for (const [kind, job] of Object.entries(TOPIC_JOBS)) {
    for (const topic of list()) if (topic[job.status] === 'running' && !jobRequests.has(`${kind}-${topic.id}`)) {
      generateTopicJob(kind, topic, repaintFor(root, rerender), false, { resume: true });
    }
  }
  for (const topic of list()) if (['queued', 'running'].includes(topic.product_status)) {
    startProductJob(topic, repaintFor(root, rerender), {resume: true});
  }
}

const pendingNotes=new Map();
function saveTopicNote(topic,value,sequence=topic._noteSaveSequence){
  topic.note=value;
  const request=(pendingNotes.get(topic.id)||Promise.resolve()).catch(()=>{}).then(()=>rawApi('PATCH',`topics/${topic.id}`,{note:value})).then(saved=>{if(topic._noteSaveSequence===sequence){topic.note=saved.note;topic.content_revision=saved.content_revision;}});
  pendingNotes.set(topic.id,request);
  void request.then(()=>{if(pendingNotes.get(topic.id)===request)pendingNotes.delete(topic.id);},()=>{if(pendingNotes.get(topic.id)===request)pendingNotes.delete(topic.id);});
  return request;
}
async function waitForTopicNote(topic){
  const pending=pendingNotes.get(topic.id);
  if(pending)await pending;
  if(topic._noteSaveError)throw new Error('制作要求尚未保存，请先重试保存。');
}

// Background jobs that produce one artifact per topic. They share queueing,
// progress, reconnect and reclaim behaviour; only names and outputs differ.
const TOPIC_JOBS = {
  preview:{label:'生成样板图',noun:'样板图',status:'preview_status',error:'preview_error',has:'has_preview',result:'svg',output:saved=>saved?.preview_svg,read:saved=>saved?.preview_svg,done:'样板图已生成，可以预览。'},
  brief: {
    label: "制作简报", noun: "简报", status: "brief_status", error: "brief_error", has: "has_brief",
    output: (saved) => saved?.brief_md, read: (saved) => saved?.brief_export || saved?.brief_md,
    done: "简报已生成，可以预览、复制或下载。",
  },
  assets: {
    label: "生成资产", noun: "资产", status: "assets_status", error: "assets_error", has: "has_assets",
    output: (saved) => saved?.assets_html, read: (saved) => saved?.assets_html,
    done: "资产已生成，可以预览或下载。",
  },
};
const jobRequests = new Map();
function generateTopicJob(kind, topic, repaint = () => {}, regenerate = false, { resume = false } = {}) {
  const job = TOPIC_JOBS[kind];
  const key = `${kind}-${topic.id}`;
  const current = jobRequests.get(key);
    if (current?.pending) {Object.assign(topic,current.topic);if(!current.listeners.some(v=>v.topic===topic))current.listeners.push({topic,repaint});return;}
  const entry = {topic, pending:true,listeners:[{topic,repaint}]};
  entry.repaint=()=>{for(const listener of entry.listeners){Object.assign(listener.topic,entry.topic);listener.repaint();}};
  entry.task = startTask(`${job.label} · ${topic.data.title}`, {key, tray:false, detail:resume ? "正在恢复后台任务…" : "正在提交后台任务…"});
  if (current) current.task.dismiss();
  jobRequests.set(key, entry);
  topic[job.status] = 'running';
  topic[job.error] = '';
  topic._jobProgress = {label:job.label,detail:resume ? '正在恢复后台任务…' : '正在提交后台任务…',startedAt:Date.now()};
  repaint();
  const update = value => {
    const patch=typeof value==='string'?{detail:value}:value;const detail=patch.detail,status=patch.status||'running';
    topic._jobProgress = {label:job.label,detail,status,startedAt:status==='waiting'?undefined:topic._jobProgress?.startedAt || Date.now()};
    entry.task.update({detail,status});
    const card = [...view.querySelectorAll('[data-id]')].find(item => Number(item.dataset.id) === Number(topic.id));
    const slot = card?.querySelector('.creation-job-progress');
    if (slot) slot.innerHTML = progressHtml(topic._jobProgress);
  };
  void (async () => {
    try {
      if(!resume)await waitForTopicNote(topic);
      const value = await requestTopicJob(kind, topic.id, regenerate, update, resume);
      if (topic._viewer?.kind === kind && !topic._viewer.version) topic._viewer.content = value;
      if (topic._viewer?.kind === kind) topic._viewer.notice = job.done;
      topic[job.has] = 1; topic[job.status] = '';
      topic[job.error] = '';
      if (kind === 'brief' && topic.status !== 'made') topic.status = 'liked';
      topic._jobProgress = null;
      entry.pending=false;entry.task.done(job.done);
      setTopicNotice(topic, job.done);
      entry.repaint();
    } catch (error) {
      if(error.versionPending){topic[job.status]='';topic._pendingVersion=true;topic._jobProgress=null;entry.pending=false;entry.task.done(error.message);entry.repaint();return;}
      topic[job.status] = 'error';
      topic[job.error] = error.message;
      topic._jobProgress = null;
      entry.task.fail(error.message);
      entry.repaint();
    } finally { entry.pending = false; metadataReads.clear();taskReads.clear();if(jobRequests.get(key)===entry)jobRequests.delete(key); }
  })();
}
async function requestTopicJob(kind, id, regenerate = false, update = () => {}, resume = false) {
  const job = TOPIC_JOBS[kind];
  const previous=regenerate?job.output(await rawApi('GET',`topics/${id}`)):undefined;
  if(resume){
    const rows=await rawApi('GET','generation-jobs');
    const latest=rows.find(row=>row.kind===kind&&row.scope?.endsWith(`:${kind}:${id}`));
    if(latest){const value=await observeGeneration(latest,{update:state=>update(state)});if(value?.[job.result||kind])return value[job.result||kind];}
  }
  if (!resume) try {
    const queued = await rawApi("POST", `topics/${id}/${kind}${regenerate ? '?regenerate=1' : ''}`);
    const started=queued?.jobId?await observeGeneration({id:queued.jobId},{update:state=>update(state)}):queued;
    if (started?.[job.result||kind]) return started[job.result||kind];
    update(`任务已保存，后台正在生成${job.noun}。可以继续使用工作台。`);
  } catch (error) {
    if(error.versionPending)throw error;
    // The Worker writes the result before sending its response. If the relay
    // or browser timed out, recover the saved result before asking the model
    // to run again.
    if (!/超时|timeout|409|5\d\d|网络|failed to fetch|fetch failed|network/i.test(String(error?.message || error))) throw error;
    update("提交响应中断，正在向后台确认任务状态…");
  }
  const failed = `${job.noun}生成失败`;
  for (let attempt = 0; attempt < 260; attempt++) {
    await waitVisible(attempt === 0 ? 1200 : 10000);
    try {
      const saved = await api("GET", `topics/${id}`);
      if (saved?.[job.status] === 'error') throw new Error(`${failed}：${saved[job.error] || "请查看错误原因后手动重试。"}`);
      if (job.output(saved) && saved[job.status] !== 'running'&&(!regenerate||job.output(saved)!==previous)) return job.read(saved);
      update(saved?.[job.error] || `模型正在生成完整${job.noun}…`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(failed)) throw error;
      update("暂时无法读取进度，正在重新连接；后台任务会继续运行。");
    }
  }
  throw new Error(`${job.noun}仍在生成中，请稍后刷新候选列表查看结果。`);
}

// ---------- 选题台 ----------

async function renderDraw(alive) {
  await settingsReady;if(!alive())return;
  // Another device may have seeded or drawn since this page loaded.
  await refreshStatus();
  if (!alive()) return;
  if (!state.info.vocab) {
    return alive.commit(()=>{view.innerHTML = `<div class="box section"><h2>公共词库尚未准备好</h2><p>请联系管理员维护公共词库后再开始抽签。</p></div>`;});
  }
  const vocab = await loadVocab();
  if (!state.drawn.length) state.drawn = await api("GET", "topics?status=drawn,new,dup&limit=60");
  const rows=await rawApi('GET','generation-jobs').catch(()=>[]);
  await syncPreviewTasks(state.drawn,rows);
  if (!alive()) return;
  for(const t of state.drawn)if(t.expand_status==='error')t._error=t.expand_error||'扩写未完成，请重试。';
  await Promise.all(state.drawn.filter(t=>t.status==='drawn'&&!expandReady(t)&&t.expand_status!=='running'&&!t._error).map(async topic=>{
    try{const versions=await rawApi('GET',`topics/${topic.id}/versions`);topic._pendingVersion=(Array.isArray(versions)?versions:versions.versions||[]).some(version=>version.kind==='expand'&&version.disposition==='pending');}catch{}
  }));
  if (!alive()) return;
  const modern=creativeV2Available();
  const opts = (d) => vocab.filter((v) => v.dim === d && v.enabled && (modern||!v.used))
    .map((v) => `<option value="${esc(v.word)}">${esc(v.word)}</option>`).join("");
  return alive.commit(async()=>{
  view.innerHTML = executorControl()+`<div class="box section">
      <div class="row"><h2 class="grow">${modern?'发现选题':'抽签'}</h2>
        ${modern?'':`<label class="small muted">数量 <input type="number" id="drawN" min="1" max="40" value="${esc(state.settings?.draw_size || 12)}" style="width:64px"></label>`}
        <button class="primary" id="drawBtn">抽一批</button></div>
      <p class="muted small">${modern?'每轮从一组种子构思 8–12 个候选，推荐最多 3 个。选中感兴趣的机制后查重，再决定是否登记为项目。':'完整创作流程灰测中。当前可以按原流程抽取并扩写选题。'} 想指定某个维度就在下面锁定。</p>
      <div class="locks">${DIMS.map((d) => `<label class="field">${DIM_LABEL[d]}<select data-lock="${d}"><option value="">随机</option>${opts(d)}</select></label>`).join("")}</div>
      <label class="field personal-requirements">补充要求<textarea id="drawRequirements" rows="3" placeholder="如目标人群、画面风格、操作限制；用于平台生成"></textarea></label>
      <details class="custom-topic"><summary>使用自己的主题</summary><div class="row"><input id="customSubject" class="grow" maxlength="200" placeholder="输入主题，例如：午夜修补玩具"><button class="ghost" id="customDrawBtn">创建主题并扩写</button></div><p class="muted small">沿用上面的维度锁定与补充要求，创建一个个人选题。</p></details>
      <div class="progress" id="progress"></div>
      ${modern?'':'<div id="lowStock"></div>'}
    </div>
    <div class="row section"><span class="muted small grow" id="drawSummary"></span>
      <button class="ghost small" id="clearBtn">清空未处理的</button></div>
    <div class="cards" id="cards"></div>`;
  $("#drawBtn").onclick = (e) => guard(e.target, () => doDraw());
  $('#customDrawBtn').onclick = event => guard(event.target,async () => {const subject=$('#customSubject').value.trim();if(!subject)throw new Error('请填写自己的主题。');await doDraw(subject);});
  $("#clearBtn").onclick = (e) => guard(e.target, async () => {
    const left = state.drawn.filter((t) => t.status === "new" || t.status === "dup" || t.status === "drawn");
    if (!left.length) return;
    if (!confirm(`归档 ${left.length} 轮未处理的选题？`)) return;
    for (const t of left) Object.assign(t, await api("PATCH", `topics/${t.id}`, { status: "rejected" }));
    state.drawn = [];
    paintDrawn();
  });
  bindCards($("#cards"), () => state.drawn, paintDrawn);
  if(modern)resumeMechanismChecks(rows,state.drawn);
  paintDrawn();
  paintLowStock();
  const stuck = state.drawn.filter((t) => t.status === "drawn" && !expandReady(t) && t.expand_status === 'running' && !t._inflight && !t._error).map((t) => t.id);
  if (stuck.length) expandIds(stuck,{resume:true});
  });
}

function paintDrawn() {
  const box = $("#cards");
  if (!box) return;
  const shown = state.drawn.filter((t) => t.status !== "rejected" && (state.showDup || t.status !== "dup"));
  shown.sort((a,b)=>Number(expandReady(b))-Number(expandReady(a))||b.id-a.id);
  patchHtml(box,shown.map((t) => topicCard(t, "draw")).join("") || `<p class="muted">还没有选题，点"抽一批"。</p>`);
  const dups = state.drawn.filter((t) => t.status === "dup").length;
  const liked = state.drawn.filter((t) => t.status === "liked").length;
  $("#drawSummary").innerHTML = (creativeV2Available()?`${shown.length} 轮选题`:`${shown.length} 个在看 · ${liked} 个已要`) +
    (dups ? ` · <a href="#" id="dupToggle">${state.showDup ? "隐藏" : "显示"} ${dups} 个撞题</a>` : "");
  const dt = $("#dupToggle");
  if (dt) dt.onclick = (e) => { e.preventDefault(); state.showDup = !state.showDup; paintDrawn(); };
  bindGamePlayers(box);
}

// Legacy draw reserves subjects immediately.
function paintLowStock() {
  const box = $("#lowStock");
  if (!box || !state.info) return;
  const left = state.info.fresh_subjects;
  const need = 2 * (Number(state.settings?.draw_size) || 12);
  if (left >= need) return (box.innerHTML = "");
  box.innerHTML = `<p class="small bad">还没用过的题材只剩 ${left} 个（每个题材只会被抽一次）。
    <button class="ghost small" id="suggestBtn">让 AI 补充 30 个题材</button></p><div id="suggestProgress" class="pgc-inline-wait" role="status" aria-live="polite"></div>`;
  $("#suggestBtn").onclick = (e) => guard(e.target, progress => suggestWords("subject",progress));
}

async function suggestWords(dim,progress) {
  progress?.attach($('#suggestProgress'));
  progress?.update({label:'补充词库',detail:'正在提交给本人的 Agent…'});
  const r = await api("POST", "suggest", { dim, n: 30 },progress);
  toast(r?.words?.length ? `已提交 ${r.words.length} 个词库建议，等待管理员审批。` : '建议任务已保存，等待 Agent 完成并交管理员审批。', 6000);
  state.vocab = null;
  render();
}

async function doDraw(subject = '') {
  const locks = {};
  for (const s of view.querySelectorAll("select[data-lock]")) if (s.value) locks[s.dataset.lock] = s.value;
  const modern=creativeV2Available(),n=Number($('#drawN')?.value)||12;
  const fresh = await api("POST","draw",{
    ...(modern?{creative_version:2}:{n:subject?1:n}),locks,subject,
    requirements:$('#drawRequirements').value.trim(),request_id:crypto.randomUUID(),
  });
  state.drawn = fresh.concat(state.drawn).slice(0,60);
  paintDrawn();
  refreshStatus().then(paintLowStock).catch(() => {});
  await expandIds(fresh.map((t) => t.id));
}

const activeExpandPolls = new Set();
const pendingExpandIds = new Set();

async function expandIds(ids, {resume = false} = {}) {
  const unique = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!unique.length) return;
  // Submit small groups; durable tasks share the gateway start-rate limit.
  const size = Math.min(2, Math.max(1, Number(state.settings?.expand_batch) || 2));
  const chunks = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  const outcomes = new Map();
  const tasks = new Map();
  const finishPending = id => {
    const local=state.drawn.find(topic=>topic.id===id);
    if(local){local._pendingVersion=true;local._inflight=false;local._error='';local.expand_status='';}
    outcomes.set(id,'pending');
    pendingExpandIds.delete(id);
  };
  const updateTopic = (topic) => {
    if (!topic || !Number.isFinite(Number(topic.id))) return;
    if (expandReady(topic)) {
      outcomes.set(Number(topic.id), 'done');
      pendingExpandIds.delete(Number(topic.id));
    }
    const local = state.drawn.find((item) => item.id === Number(topic.id));
    if (!local) return;
    Object.assign(local, topic);
    if (expandReady(topic)) {
      local._inflight = false;
      local._error = "";
      local._pendingVersion = false;
      pendingExpandIds.delete(Number(topic.id));
    }
  };
  const progress = startTask("选题扩写", {value:0,total:unique.length,tray:false,detail:"正在提交扩写队列…"});
  let settled = false;
  const paintProgress = () => {
    const done = unique.filter(id => outcomes.get(id) === 'done').length;
    const pending = unique.filter(id => outcomes.get(id) === 'pending').length;
    const failed = unique.filter(id => outcomes.get(id) === 'error').length;
    const remaining = unique.length - done - pending - failed;
    const waitingNote = unique.map(id => state.drawn.find(t => t.id === id)).find(t => t?.expand_status === 'running' && t.expand_error)?.expand_error;
    const detail = `${done} 个已生成${pending ? ` · ${pending} 个待确认，请查看历史版本` : ''}${failed ? ` · ${failed} 个未完成` : ''}${remaining ? ` · ${remaining} 个排队或生成中` : ''}${waitingNote ? ` · ${waitingNote}` : ''}`;
    const status = remaining ? 'running' : failed ? 'error' : 'done';
    progress.update({value:done+pending+failed,detail,status});
    const p = $("#progress");
    if (p) p.innerHTML = progressHtml({label:"AI 选题扩写",value:done+pending+failed,total:unique.length,detail,status});
    if (!remaining && !settled) {
      settled = true;
      if (failed) progress.fail(detail + "，可在对应卡片重试。");
      else progress.done(detail);
    }
  };
  for (const id of unique) {
    const t = state.drawn.find((item) => item.id === id);
    if (expandReady(t)) outcomes.set(id, 'done');
    if (t && !expandReady(t)) { t._inflight = true; t._error = ""; t._pendingVersion=false; pendingExpandIds.add(id); }
  }
  paintDrawn();
  paintProgress();

  const submit = async (chunk) => {
    try {
      const result = await api("POST", "expand", { ids: chunk });
      if (Array.isArray(result)) result.forEach(updateTopic);
      else if (Array.isArray(result?.topics)) result.topics.forEach(updateTopic);
      if(Array.isArray(result?.tasks))result.tasks.forEach((task,index)=>{if(chunk[index])tasks.set(chunk[index],task);});
    } catch (error) {
      const message = String(error?.message || error);
      if (!/409|429|5\d\d|超时|timeout|网络|failed to fetch|fetch failed|network/i.test(message)) {
        for (const id of chunk) {
          const t = state.drawn.find((item) => item.id === id);
          if (t) { t._error = message; t._inflight = false; }
          outcomes.set(id, 'error');
          pendingExpandIds.delete(id);
        }
      }
    }
  };
  // Limit enqueue requests independently of background model concurrency.
  const waitingChunks = chunks.slice();
  const submitWorker = async () => { while (waitingChunks.length) await submit(waitingChunks.shift()); };
  if(!resume)await Promise.all(Array.from({ length: Math.min(4, waitingChunks.length) }, submitWorker));
  if(unique.some(id=>pendingExpandIds.has(id)&&!tasks.has(id)))try{
    const rows=await rawApi('GET','generation-jobs');
    for(const id of unique){const task=rows.find(row=>row.kind==='expand'&&row.scope?.endsWith(`:expand:${id}`));if(task&&!tasks.has(id))tasks.set(id,task);}
  }catch{}
  paintDrawn();
  paintProgress();

  const poll = async (id) => {
    while (pendingExpandIds.has(id)) {
      const task=tasks.get(id);
      try {
        if(task){
          const saved=await taskReader.read(task.id);
          if(['queued','running'].includes(saved.status))continue;
          if(saved.status==='done'&&saved.result?.disposition==='pending'){
            finishPending(id);paintDrawn();paintProgress();break;
          }
          if(saved.status==='error'){
            const local=state.drawn.find(topic=>topic.id===id);
            if(local){local._error=saved.error||'扩写未完成，请重试。';local._inflight=false;}
            outcomes.set(id,'error');pendingExpandIds.delete(id);paintDrawn();paintProgress();break;
          }
        }
        const topic = await api("GET", `topics/${id}`);
        updateTopic(topic);
        const local = state.drawn.find((item) => item.id === id);
        if (topic?.expand_status === "error" && !expandReady(topic)) {
          if (local) { local._error = topic.expand_error || "扩写失败，请点击重试。"; local._inflight = false; }
          outcomes.set(id, 'error');
          pendingExpandIds.delete(id);
        }
        if(!expandReady(topic)&&topic.expand_status!=='running'&&pendingExpandIds.has(id)){
          const response=await rawApi('GET',`topics/${id}/versions`),versions=Array.isArray(response)?response:response.versions||[];
          if(versions.some(version=>version.kind==='expand'&&version.disposition==='pending'))finishPending(id);
        }
        paintDrawn();
        paintProgress();
      } catch(error) {
        if([401,403,404].includes(error.status)){
          const local=state.drawn.find(topic=>topic.id===id);
          if(local){local._error=error.message;local._inflight=false;}
          outcomes.set(id,'error');pendingExpandIds.delete(id);paintDrawn();paintProgress();
        }
      }
      if(pendingExpandIds.has(id)&&!task)await waitVisible(10000);
    }
  };
  for (const id of unique) {
    const t = state.drawn.find((item) => item.id === id);
    if (!expandReady(t) && pendingExpandIds.has(id) && !activeExpandPolls.has(id)) {
      activeExpandPolls.add(id);
      void poll(id).finally(() => activeExpandPolls.delete(id));
    }
  }
}

// ---------- 候选 ----------

function projectActivity(topic){
  const active=['product','brief','assets','preview','expand'].some(k=>['queued','running'].includes(topic[k+'_status']));
  const failed=['product','brief','assets','preview','expand'].some(k=>topic[k+'_status']==='error');
  return {active,failed};
}
function projectSummary(topic){
  const {active,failed}=projectActivity(topic),label=active?'进行中':failed?'需处理':topic.has_product?'可试玩':'创作中';
  return `<article class="project-row" data-id="${topic.id}"><button class="project-row-open" data-open-project="${topic.id}" title="${esc(topic.data?.title||topic.subject)}"><span class="project-row-title">${esc(topic.data?.title||topic.subject)}</span><span class="project-row-description">${esc(topic.data?.logline||topic.subject)}</span></button><span class="project-row-state" data-state="${active?'working':failed?'error':topic.has_product?'product':'draft'}">${label}</span><button class="ghost project-row-action" data-open-project="${topic.id}" data-project-panel="${topic.has_product?'play':'create'}">${topic.has_product?'试玩':'继续创作'} →</button></article>`;
}

async function renderPicks(alive) {
  const [candidates,products,rows]=await Promise.all([api("GET","topics?status=liked,made&limit=500"),api("GET","products"),rawApi('GET','generation-jobs').catch(()=>[])]);
  const merged=new Map(candidates.map(t=>[t.id,t]));for(const t of products)merged.set(t.id,{...merged.get(t.id),...t});
  const list=[...merged.values()].sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));
  await syncPreviewTasks(list,rows);
  if (!alive()) return;
  return alive.commit(async()=>{
  view.innerHTML = `<header class="projects-heading"><div><h1>我的项目 <span>${list.length}</span></h1><p>从想法到成品，在项目中查看材料、试玩和版本。</p></div><button class="primary" data-tab="draw">发现新选题 →</button></header>
    <div class="project-library-links"><button class="ghost" data-tab="products">已有成品</button><button class="ghost" data-tab="games">历史导入作品</button></div>
    <div class="project-toolbar"><label class="project-search">搜索项目<input type="search" id="projectSearch" placeholder="搜索名称或题材" value="${esc(state.projectSearch||'')}"></label><label class="project-filter">项目状态<select id="projectFilter"><option value="all">全部状态</option><option value="working">进行中</option><option value="product">已有成品</option><option value="error">需处理</option></select></label><div class="project-layout" role="group" aria-label="项目显示方式"><button class="ghost" data-project-layout="list" aria-pressed="true">列表</button><button class="ghost" data-project-layout="cards" aria-pressed="false">卡片</button></div></div><div class="cards" id="pickCards"></div><div class="row project-pagination" id="projectPages" aria-label="项目分页"></div>`;
  const paint = () => {
    if(!alive())return;
    const query=$('#projectSearch').value.toLowerCase(),filter=$('#projectFilter').value;
    const matches=list.filter(t=>(t.data?.title+' '+t.subject).toLowerCase().includes(query)&& (filter==='all'||filter==='product'&&t.has_product||filter==='working'&&projectActivity(t).active||filter==='error'&&projectActivity(t).failed));
    const pages=Math.max(1,Math.ceil(matches.length/24));state.projectPage=Math.min(state.projectPage||1,pages);const shown=matches.slice((state.projectPage-1)*24,state.projectPage*24);
    state.projectSearch=query;state.projectFilter=filter;const url=new URL(location.href);for(const [key,value]of Object.entries({q:query,filter,page:String(state.projectPage),layout:state.projectLayout})){if(!value||value==='all'||value==='1'||value==='list')url.searchParams.delete(key);else url.searchParams.set(key,value);}history.replaceState(history.state,'',url);
    $('#projectPages').innerHTML=`<button class="ghost" data-project-page="${state.projectPage-1}" ${state.projectPage===1?'disabled':''}>上一页</button><span>${state.projectPage} / ${pages} · ${matches.length} 个项目</span><button class="ghost" data-project-page="${state.projectPage+1}" ${state.projectPage===pages?'disabled':''}>下一页</button>`;
    $('#projectPages').querySelectorAll('[data-project-page]').forEach(button=>button.onclick=()=>{state.projectPage=Number(button.dataset.projectPage);paint();});
    patchHtml($("#pickCards"), shown.map((t) => state.projectLayout==='cards'?topicCard(t,"picks"):projectSummary(t)).join("") || (list.length?'<div class="project-empty"><h2>没有匹配的项目</h2><p>试试其他名称，或清除搜索与状态筛选。</p><button class="ghost" id="projectReset">清除筛选</button></div>':'<div class="project-empty"><h2>从一个想法开始</h2><p>选择感兴趣的选题，材料与成品会保存在这里。</p><button class="primary" data-tab="draw">发现选题</button></div>'));
    $('#pickCards').classList.toggle('project-list',state.projectLayout!=='cards');
    view.querySelectorAll('[data-project-layout]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.projectLayout===state.projectLayout)));
    const reset=$('#projectReset');if(reset)reset.onclick=()=>{$('#projectSearch').value='';$('#projectFilter').value='all';state.projectPage=1;paint();$('#projectSearch').focus();};
    bindGamePlayers($('#pickCards'));
  };
  $('#projectFilter').value=state.projectFilter||'all';
  view.querySelectorAll('[data-project-layout]').forEach(button=>button.onclick=()=>{state.projectLayout=button.dataset.projectLayout;paint();});
  let searchTimer;$('#projectSearch').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(alive()){state.projectPage=1;paint();}},250);};
  $('#projectSearch').onkeydown=event=>{if(event.key==='Enter'){clearTimeout(searchTimer);state.projectPage=1;paint();}};
  $('#projectFilter').onchange=()=>{state.projectPage=1;paint();};
  bindCards($("#pickCards"), () => list, paint);
  paint();
  });
}

async function syncPreviewTasks(topics,loaded){
  try{const rows=loaded||await rawApi('GET','generation-jobs');for(const topic of topics){const latest=rows.find(row=>row.kind==='preview'&&row.scope?.endsWith(`:preview:${topic.id}`));if(latest)topic.preview_status=['queued','running'].includes(latest.status)?'running':latest.status==='error'?'error':'';}}
  catch{} // Listing materials remains usable if task status is temporarily unavailable.
}

async function renderProducts(alive) {
  const list = await api('GET', 'products');
  if (!alive()) return;
  const products = list.filter(topic => topic.has_product || ['queued', 'running', 'error'].includes(topic.product_status));
  return alive.commit(async()=>{
  view.innerHTML = `<div class="row section"><h2 class="grow">已有成品</h2><button class="ghost" data-tab="picks">全部项目</button><span class="muted small">${products.length} 款</span></div>
    <p class="muted small section">成品可以试玩或下载为单文件。${products.some(item => ['queued', 'running'].includes(item.product_status)) ? '正在制作的任务会在完成后自动出现。' : ''}</p>
    <div class="cards" id="productCards"></div>`;
  const paint = () => {
    if (!alive()) return;
    const cards = products.map(productCard).join('');
    patchHtml($('#productCards'),cards || `<p class="muted">还没有成品。到我的项目中选择一款游戏，开始制作。</p>`);
    bindGamePlayers($('#productCards'));
  };
  bindProductCards($('#productCards'), products, paint);
  paint();
  for (const topic of products) if (['queued', 'running'].includes(topic.product_status)) {
    startProductJob(topic, paint, {show:false, resume:true});
  }
  });
}

function productCard(topic) {
  const data = topic.data || {};
  const active=['queued','running'].includes(topic.product_status);
  return `<article class="card creation-card" data-id="${topic.id}"><div class="art" style="${artStyle(data)}"><div class="title"><button class="project-title" data-open-project="${topic.id}">${esc(data.title || 'Untitled')}</button></div><div class="score">${topic.has_product?'可试玩':active?'制作中':'未完成'}</div></div><div class="body">${chipsHtml(topic)}<p>${esc(data.logline || '')}</p>${topic._notice||state.cardNotices.get(topic.id)?`<p class="creation-card-notice small" role="status">${esc(topic._notice||state.cardNotices.get(topic.id))}</p>`:''}${topic._productProgress?`<div class="product-job-progress">${progressHtml(topic._productProgress)}</div>`:active?`<div class="product-job-progress">${progressHtml({label:topic.has_product?'正在制作新版本':'游戏制作中',detail:topic.product_error||'等待后台执行…'})}</div>`:topic.product_status==='error'?`<p class="bad small">${esc(topic.product_error||'制作未完成，可重试。')}${topic.has_product?' 现有成品仍可试玩。':''} <button class="ghost small" data-act="retryProduct">重试制作</button></p>`:''}<p class="muted small">${topic.has_product?'单文件 HTML · '+esc(topic.updated_at||''):'完成后会自动出现在这里。'}</p></div><div class="creation-viewer-slot">${renderCardViewer(topic)}</div>${creationFooter(topic,'products')}</article>`;
}

function bindProductCards(root, list, paint) {
  root.addEventListener('click', async event => {
    const card = event.target.closest('.card');
    const topic = list.find(item => item.id === Number(card?.dataset.id));
    if (!card || !topic) return;
    const repaint = repaintFor(root, paint);
    const viewerButton = event.target.closest('[data-viewer-act],[data-viewer-version]');
    if (viewerButton) { handleCardViewerAction(event, viewerButton, card, topic, repaint, root); return; }
    const button = event.target.closest('[data-act]');
    if (!button) return;
    if(button.dataset.act==='versions'){await openCardArtifact(button,topic,'versions',repaint,root);return;}
    if(button.dataset.act==='creationChecks'){await openCardArtifact(button,topic,'creationChecks',repaint,root);return;}
    if(button.dataset.act==='viewProduct'){await openCardArtifact(button,topic,'game',repaint,root);return;}
    if(button.dataset.act==='resumeProduct'){startProductJob(topic,repaint,{resume:true});return;}
    if(button.dataset.act==='retryProduct'){startProductJob(topic,repaint);return;}
    if(button.dataset.act==='regenerateGame')startProductJob(topic,repaint,{regenerate:true});
  });
}

const productRequests = new Map();
function startProductJob(topic, repaint = () => {}, {resume = false,regenerate=false} = {}) {
  regenerate=regenerate||!!topic.has_product;
  const existing = productRequests.get(topic.id);
  if (existing?.pending) {
    existing.listeners.push({topic, repaint});
    Object.assign(topic, existing.topic); repaint();
    return;
  }
  if(!resume&&creativeV2Available()&&topic.has_brief!=null&&!topic.has_brief){
    setTopicNotice(topic,'请先在材料区生成简报，再开始制作。');
    const card=view.querySelector(`[data-id="${topic.id}"]`);
    const brief=card?.querySelector('[data-act="brief"]:not(:disabled)');
    if(brief)brief.focus();
    else if(!card?.querySelector('[data-act="brief"]'))navigateWorkspace({tab:'picks',project:String(topic.id)});
    return;
  }
  const entry = {topic, pending:true,regenerate,listeners:[{topic, repaint}]};
  if(existing)existing.task.dismiss();
  entry.repaint = () => { for (const listener of entry.listeners) { Object.assign(listener.topic, entry.topic); listener.repaint(); } };
  entry.task = startTask(`AI 制作 · ${topic.data?.title || '游戏'}`, {key:`product-${topic.id}`, tray:false, detail:resume ? '正在恢复后台任务状态…' : '正在提交制作任务…'});
  entry.update = state => {
    const patch = typeof state === 'string' ? {detail:state} : state || {};
    entry.task.update(patch);
    topic._productProgress = {label:'游戏制作',detail:patch.detail || '正在后台制作…',status:patch.status||'running',startedAt:patch.status==='waiting'?undefined:topic._productProgress?.startedAt || Date.now()};
    const card = [...view.querySelectorAll('[data-id]')].find(item => Number(item.dataset.id) === Number(topic.id));
    const slot = card?.querySelector('.product-job-progress, .creation-job-progress');
    if (slot) slot.innerHTML = progressHtml(topic._productProgress);
  };
  productRequests.set(topic.id, entry);
  topic.product_status = resume ? topic.product_status : 'queued';
  topic.product_error = '';
  topic._productProgress = {label:'AI 制作',detail:resume ? '正在恢复后台任务…' : '正在提交制作任务…',startedAt:Date.now()};
  repaint();
  void (async () => {
    try {
      await statusReady;
      if(!resume&&creativeV2Available()&&topic.has_brief==null){
        const saved=await api('GET',`topics/${topic.id}?summary=1`);
        if(!saved.has_brief){
          topic.product_status=saved.product_status;
          topic.product_error=saved.product_error;
          topic._productProgress=null;
          entry.task.done('请先准备简报。');
          setTopicNotice(topic,'请先在材料区生成简报，再开始制作。');
          if(state.tab==='products')navigateWorkspace({tab:'picks',project:String(topic.id)});
          entry.repaint();
          return;
        }
      }
      if(!resume)await waitForTopicNote(topic);
      const html = await requestProductJob(topic.id, entry, resume);
      topic.has_product = 1; topic.product_status = ''; topic.product_error = ''; topic.status = 'made';
      topic._productProgress = null;
      entry.task.done('游戏已生成，可预览或下载。');
      if (topic._viewer?.kind === 'game') topic._viewer.notice = '游戏已生成，可试玩或下载。';
      setTopicNotice(topic, '游戏已生成，可试玩或下载。');
      entry.repaint();
    } catch (error) {
      if(error.versionPending){topic.product_status='';topic._pendingVersion=true;topic._productProgress=null;entry.task.done(error.message);entry.repaint();return;}
      topic.product_status = 'error'; topic.product_error = error.message;
      topic._productProgress = null;
      entry.task.fail(error.message);
      entry.repaint();
    } finally { entry.pending = false; metadataReads.clear();taskReads.clear();if(productRequests.get(topic.id)===entry)productRequests.delete(topic.id); }
  })();
}

async function requestProductJob(id, entry, resume = false) {
  const previous=entry.regenerate?(await rawApi('GET',`topics/${id}/product`)).html:null;
  if(resume){
    const rows=await rawApi('GET','generation-jobs');
    const latest=rows.find(row=>row.kind==='game'&&row.scope?.endsWith(`:game:${id}`));
    if(latest){const value=await observeGeneration(latest,{update:state=>entry.update(state)});if(value?.html)return value.html;}
  }
  if (!resume) try {
    const queued=await rawApi('POST',`topics/${id}/game${entry.regenerate?'?regenerate=1':''}`);
    const started=queued?.jobId?await observeGeneration({id:queued.jobId},{update:state=>entry.update(state)}):queued;
    if(started.html)return started.html;
    if (started.status === 'done' && started.has_product) return (await api('GET', `topics/${id}/product`)).html;
    entry.update({detail:'制作任务已保存，等待执行。'});
  } catch (error) {
    if(error.versionPending)throw error;
    if (error.status && error.status < 500) throw error;
    entry.update({detail:'提交响应中断，正在向后台确认任务状态…'});
  }
  for (let attempt = 0; ; attempt++) {
    await waitVisible(attempt === 0 ? 1200 : 10000);
    try {
      const saved = await api('GET', `topics/${id}/game`);
      Object.assign(entry.topic, saved);
      if (saved.product_status === 'error') throw Object.assign(new Error(saved.product_error || '制作失败，请重试。'), {terminal:true});
      if (saved.has_product && !['queued','running'].includes(saved.product_status)){
        const html=(await api('GET',`topics/${id}/product`)).html;
        if(!entry.regenerate||html!==previous)return html;
      }
      entry.update({detail:saved.product_error || '正在等待本次制作结果…'});
      if (!['queued', 'running'].includes(saved.product_status)) throw Object.assign(new Error('后台没有接收到制作任务，请重新开始制作。'), {terminal:true});
    } catch (error) {
      if (error.terminal || (error.status && error.status < 500)) throw error;
      entry.update({detail:'暂时无法读取进度，正在重新连接；后台任务会继续运行。'});
    }
  }
}

// ---------- 审核 ----------


import { probeGame, probeChecks } from './review-capture.js';

function checksHtml(checks) {
  const mark = { ok: "✅", warn: "⚠️", bad: "❌" };
  return `<ul class="checks">${checks.map((c) => `<li><span class="mark">${mark[c.level]}</span><span>${esc(c.text)}</span></li>`).join("")}</ul>`;
}

async function renderReview(alive) {
  const [prepared,{mountReviewWorkspace:mountReview}]=await Promise.all([prepareReviewReads(api),import('./review-workspace.js')]);if(!alive())return;
  await alive.commit(async()=>{
    const cleanup=await mountReview({view,api:prepared,alive,topics:[],awaitInitial:true,probeGame,checksHtml,probeChecks,copyText,download,openModal,setProbing:value=>{state.reviewProbing=value;}});
    if(alive())viewCleanup=cleanup;else cleanup?.();
  });
}

// ---------- 词库 ----------

async function renderVocab(alive) {
  const vocab = await loadVocab(true);
  if (!alive()) return;
  const dim = state.vocabDim || "subject";
  const rows = vocab.filter(v => v.dim === dim);
  return alive.commit(async()=>{
  view.innerHTML = `<div class="row section"><h2 class="grow">公共词库</h2><button class="ghost" id="suggestBtn">让我的 Agent 提出 30 个建议</button></div><div id="suggestProgress" class="section" role="status" aria-live="polite"></div><p class="muted small section">公共词库由管理员维护。个人喜好和已使用记录仅影响自己的抽签；Agent 的补词建议经管理员批准后才进入公共词库。</p><div class="row section">${DIMS.map(d => `<button class="${d === dim ? 'primary' : 'ghost'}" data-dim="${d}">${DIM_LABEL[d]} (${vocab.filter(v => v.dim === d).length})</button>`).join('')}</div><div class="tablewrap box"><table><thead><tr><th>词</th><th>备注</th><th>公共权重</th><th>个人学习系数</th><th>状态</th></tr></thead><tbody>${rows.map(v => `<tr><td class="${v.used ? 'used' : ''}">${esc(v.word)}</td><td>${esc(v.note)}</td><td>${esc(v.base)}</td><td>×${Number(v.factor || 1).toFixed(2)}</td><td>${v.enabled ? v.used ? '本人已使用' : '可抽取' : '已停用'}</td></tr>`).join('')}</tbody></table></div>`;
  view.querySelectorAll('[data-dim]').forEach(button => button.onclick = () => { state.vocabDim = button.dataset.dim; render(); });
  $('#suggestBtn').onclick = event => guard(event.target, progress => suggestWords(dim,progress));
  });
}

// ---------- 作品库 ----------

async function renderGames(alive) {
  const [games, vocab] = await Promise.all([api("GET", "games"), loadVocab()]);
  if (!alive()) return;
  const f = state.gameFilter || (state.gameFilter = { source: "", status: "", q: "" });
  const untagged = games.filter((g) => !g.gesture || !g.medium).length;
  const filtered = games.filter((g) =>
    (!f.source || g.source === f.source) && (!f.status || g.status === f.status) &&
    (!f.q || (g.title + g.descr + g.feedback + DIMS.map((d) => g[d]).join("")).toLowerCase().includes(f.q.toLowerCase())));
  return alive.commit(async()=>{
  view.innerHTML = `<details class="box section"><summary><b>导入个人作品历史表格</b>（.xlsx）</summary>
      <p class="small muted">总审核导出的「版本审核记录」表格：每行一条初审或终审记录。同名游戏会合并更新分数和意见，保留已有的简介和标签。组员姓名只在这台电脑上用来区分"我的"和"他人"，不会上传。</p>
      <div class="locks">
        <label class="field">表格文件<input type="file" id="sheetFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
        <label class="field">哪一位是你<select id="sheetSelf" disabled><option value="">先选择文件</option></select></label>
        <label class="field">&nbsp;<button class="primary" id="sheetImport" disabled>导入表格</button></label>
      </div>
      <p class="small muted" id="sheetInfo"></p>
    </details>
    <details class="box section"><summary><b>从 PGC 导入个人作品记录</b></summary>
      <ol class="small">
        <li>在电脑上登录 PGC 平台（creator-hub），按 F12 打开控制台。</li>
        <li>点 <button class="ghost small" id="cpSnippet">复制导出脚本</button>，粘贴到控制台回车。脚本只读取你账号能看到的作品和审核意见，不会修改任何东西。</li>
        <li>它会把结果复制到剪贴板，回来粘贴到下面，点导入。已有的作品会更新分数和意见，保留你的标签。</li>
      </ol>
      <textarea id="importBox" placeholder='{"works":[...]}'></textarea>
      <div class="row" style="margin-top:8px"><button class="primary" id="importBtn">导入</button>
        <button class="ghost" id="tagBtn" ${untagged ? "" : "disabled"}>AI 自动打标签（${untagged} 个未打）</button></div>
      <div id="tagProgress" class="pgc-inline-wait" role="status" aria-live="polite"></div>
    </details>
    <details class="box section"><summary><b>手动添加一款</b>（比如做了但没交的）</summary>
      <form id="addGame" class="locks">
        <label class="field">标题<input type="text" name="title" required></label>
        <label class="field">一句话<input type="text" name="descr"></label>
        <label class="field">状态<select name="status">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === "shelved" ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        ${DIMS.map((d) => `<label class="field">${DIM_LABEL[d]}<input type="text" name="${d}" list="dl-${d}"></label>`).join("")}
        <label class="field">美学/易玩/可玩<input type="text" name="scores" placeholder="如 3/2/2"></label>
        <label class="field">&nbsp;<button class="primary">添加</button></label>
      </form>
    </details>
    ${DIMS.map((d) => `<datalist id="dl-${d}">${vocab.filter((v) => v.dim === d).map((v) => `<option value="${esc(v.word)}">`).join("")}</datalist>`).join("")}
    <div class="row section">
      <select id="fSource"><option value="">全部来源</option><option value="mine">我的</option><option value="peer">他人</option></select>
      <select id="fStatus"><option value="">全部状态</option>${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <input type="text" id="fQ" placeholder="搜索标题/意见/标签" class="grow" value="${esc(f.q)}">
      <span class="muted small">${filtered.length} / ${games.length}</span>
    </div>
    <div class="tablewrap box"><table><thead><tr><th>作品</th><th>状态</th><th>分数</th><th>标签</th><th>审核意见</th><th></th></tr></thead><tbody>
    ${filtered.map((g) => `<tr data-id="${g.id}">
      <td><b>${esc(g.title)}</b>${g.source === "peer" ? ' <span class="pill">他人</span>' : ""}<div class="small muted">${esc(g.descr)}</div></td>
      <td><span class="pill ${esc(g.status)}">${esc(STATUS_LABEL[g.status] || g.status)}</span>${g.revisions > 1 ? `<div class="small muted">v${esc(g.revisions)}</div>` : ""}</td>
      <td>${g.score != null ? `<b>${esc(g.score)}</b><div class="small muted">${esc(g.aes)}/${esc(g.ease)}/${esc(g.play)}</div>` : "—"}</td>
      <td>${DIMS.map((d) => `<input type="text" data-f="${d}" list="dl-${d}" value="${esc(g[d])}" placeholder="${DIM_LABEL[d]}" style="width:100%;margin-bottom:2px">`).join("")}</td>
      <td class="small" style="max-width:320px">${esc(g.feedback)}</td>
      <td><span class="game-save-status small" role="status" aria-live="polite"></span><button class="ghost bad small" data-del>删</button></td></tr>`).join("")}
    </tbody></table></div>`;
  $("#fSource").value = f.source;
  $("#fStatus").value = f.status;
  $("#fSource").onchange = (e) => { f.source = e.target.value; render(); };
  $("#fStatus").onchange = (e) => { f.status = e.target.value; render(); };
  $("#fQ").onchange = (e) => { f.q = e.target.value; render(); };
  let sheetRows = null;
  const SELF_KEY = "forge_sheet_self";
  $("#sheetFile").onchange = (e) => guard(null, async () => {
    sheetRows = null;
    $("#sheetImport").disabled = true;
    const file = e.target.files[0];
    if (!file) return;
    sheetRows = await readXlsxRows(await file.arrayBuffer());
    const works = sheetToWorks(sheetRows);
    const members = listMembers(sheetRows);
    let saved = "";
    try { saved = localStorage.getItem(SELF_KEY) || ""; } catch {}
    $("#sheetSelf").innerHTML = `<option value="">都不是我（全部算他人）</option>` +
      members.map((m) => `<option value="${esc(m)}" ${m === saved ? "selected" : ""}>${esc(m)}</option>`).join("");
    $("#sheetSelf").disabled = !members.length;
    const scored = works.filter((w) => w.versions.some((v) => v.s || v.ps)).length;
    $("#sheetInfo").textContent = `读到 ${works.length} 款游戏、${works.reduce((n, w) => n + w.versions.length, 0)} 个版本，其中 ${scored} 款有评分。`;
    $("#sheetImport").disabled = false;
  }, "读取表格");
  $("#sheetImport").onclick = (e) => guard(e.target, async () => {
    if (!sheetRows) throw new Error("先选择表格文件");
    const self = $("#sheetSelf").value;
    try { localStorage.setItem(SELF_KEY, self); } catch {}
    const r = await api("POST", "import", { works: sheetToWorks(sheetRows, { self }) });
    toast(`新增 ${r.inserted}，更新 ${r.updated}，${r.untagged} 个待打标签`, 5000);
    await refreshStatus();
    render();
  }, "导入表格");
  $("#cpSnippet").onclick = () => copyText(EXPORT_SNIPPET);
  $("#importBtn").onclick = (e) => guard(e.target, async () => {
    let data;
    try { data = JSON.parse($("#importBox").value); } catch { throw new Error("粘贴的内容不是合法 JSON"); }
    const r = await api("POST", "import", data);
    toast(`新增 ${r.inserted}，更新 ${r.updated}，${r.untagged} 个待打标签`, 5000);
    await refreshStatus();
    render();
  });
  $("#tagBtn").onclick = (e) => guard(e.target, async (progress) => {
    progress.attach($('#tagProgress'));
    let left = untagged;
    progress.update({label:"AI 自动打标签",total:untagged,value:0,detail:`剩余 ${left} 个`});
    while (left > 0) {
      const r = await api("POST", "tag",undefined,progress);
      if (!r.tagged && r.remaining > 0) throw new Error(`仍有 ${r.remaining} 个未完成，请重试。`);
      left = r.remaining;
      progress.update({value:untagged-left,detail:`已完成 ${untagged-left} 个，剩余 ${left} 个`});
    }
    toast("标签打完了，可以在表格里手动修正");
    render();
  });
  $("#addGame").onsubmit = (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const [aes, ease, play] = String(fd.scores || "").split("/").map((x) => (x.trim() ? Number(x) : null));
    delete fd.scores;
    guard(e.submitter, async () => { await api("POST", "games", { ...fd, aes, ease, play }); await refreshStatus(); render(); });
  };
  const tbody = view.querySelector("tbody");
  tbody.addEventListener("change", (e) => {
    const field = e.target.dataset.f;
    if (!field) return;
    const input = e.target;
    const row = input.closest("tr");
    const id = row.dataset.id;
    const status = row.querySelector(".game-save-status");
    const sequence = Number(row.dataset.saveSequence || 0) + 1;
    row.dataset.saveSequence = String(sequence);
    clearTimeout(status.saveTimer);
    status.dataset.state = "saving";
    status.textContent = "保存中…";
    guard(null, async () => {
      try {
        await api("PATCH", `games/${id}`, { [field]: input.value.trim() });
        if (row.dataset.saveSequence !== String(sequence)) return;
        status.dataset.state = "saved";
        status.textContent = "已保存";
        status.saveTimer = setTimeout(() => {
          if (row.dataset.saveSequence === String(sequence)) {
            status.textContent = "";
            delete status.dataset.state;
          }
        }, 1800);
      } catch (error) {
        if (row.dataset.saveSequence === String(sequence)) {
          status.dataset.state = "error";
          status.textContent = "保存失败";
        }
        throw error;
      }
    });
  });
  tbody.addEventListener("click", (e) => {
    if (!e.target.matches("[data-del]")) return;
    if (!confirm("从作品库删除？删除后这个题材可能再次被抽到。")) return;
    guard(e.target, async () => { await api("DELETE", `games/${e.target.closest("tr").dataset.id}`); await refreshStatus(); render(); });
  });
  });
}

// ---------- 设置 ----------

async function renderSettings(alive) {
  const [s]=await Promise.all([api('GET','settings'),statusReady]);
  if (!alive()) return;
  return alive.commit(async()=>{
  const drawPrefs=creativeV2Available()?'':`<form id="drawPrefs" class="row"><label class="field">每次抽几个<input id="drawSizePref" type="number" min="1" max="40" value="${Number(state.settings?.draw_size || 12)}"></label><button class="ghost">保存抽签偏好</button></form>`;
  view.innerHTML = `<div class="box section"><h2>我的工作台</h2><p class="muted small">网页创作使用平台模型，游戏制作固定 Opus 5.5。审核由自己的 Agent 完成，也可独立接入创作 Agent。结果保存在个人空间。</p>${drawPrefs}</div><div class="box section"><h2>公共选题规律与雷区</h2><pre class="md">${esc(s.redlines || '暂无规则')}</pre></div><div class="box section"><h2>公共制作模板</h2><pre class="md">${esc(s.template || '暂无模板')}</pre></div><div class="box section"><h2>F 部分骨架</h2><pre class="md">${esc(s.template_f || '暂无骨架')}</pre></div><div class="row section"><button class="ghost" id="exportBtn">导出我的数据</button><button class="ghost" id="changePassword">修改密码</button><button class="ghost" id="logoutBtn">退出登录</button></div>`;
  const form=$('#drawPrefs');
  if(form)form.onsubmit = event => { event.preventDefault(); const value = Math.min(40,Math.max(1,Number($('#drawSizePref').value) || 12)); state.settings.draw_size = String(value); try {localStorage.setItem(`forge-draw-size-${state.session.id}`, String(value));} catch {} toast('个人抽签偏好已保存'); };
  $('#exportBtn').onclick = event => guard(event.target,async () => download(`pgc-personal-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(await api('GET','export'),null,2),'application/json'));
  $('#changePassword').onclick = () => {
    openModal('修改我的密码', `<form id="personalPassword" class="agent-password"><label class="field">原密码<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label class="field">新密码<input name="newPassword" type="password" autocomplete="new-password" required minlength="6" maxlength="128"></label><button class="primary" type="submit">保存新密码</button><p id="passwordMessage" role="status"></p></form>`);
    $('#personalPassword').onsubmit = event => { event.preventDefault(); guard(event.submitter, async () => { const response=await fetch('/api/auth/password',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});const data=await response.json();if(!response.ok)throw new Error(data.error||'修改失败');location.replace('/login'); }); };
  };
  $('#logoutBtn').onclick = () => guard($('#logoutBtn'), async () => { await fetch('/api/auth/logout',{method:'POST'});location.replace('/login'); });
  });
}

async function renderAgent(alive) {
  const data = await api('GET','agent/devices');
  if (!alive()) return;
  const devices = data.devices || [];
  const tasks = data.tasks || [];
  const prompt = `请阅读 ${location.origin}/forge-agent.md，使用你自己的模型连接我的 PGC 个人创作空间。首次连接时请让我生成一次性配对码并直接在本对话中询问我，收到后由你自行完成配对，不要让我打开命令窗口。领取我明确开始的任务并回传结果；不要自动筛选选题或继续下一环节。审核接入请另读 ${location.origin}/agent.md。`;
  return alive.commit(async()=>{
  view.innerHTML = `<div class="box section personal-agent"><div class="row"><h2 class="grow">我的创作 Agent</h2><button class="ghost" id="agentRefresh">刷新状态</button></div><p class="muted small">把接入指令交给自己的智能助手。它使用自己的模型完成扩写、简报、样板图、资产、制作、标签与词库建议。任务各自保存，其他成员无法领取。</p><pre class="md">${esc(prompt)}</pre><div class="row"><button class="primary" id="copyAgentInstructions">复制接入指令</button><button class="ghost" id="createAgentPairing">生成一次性配对码</button><a class="btn" href="/forge-agent.md" target="_blank" rel="noopener">查看接入说明 ↗</a></div><p id="agentPairing" role="status"></p><div class="agent-device-list">${devices.map(device=>`<div class="agent-device"><span><b>${esc(device.name)}</b><small>${device.revoked?'已撤销':device.online?'最近连接':'已授权'} · 最近连接 ${esc(device.last_seen || '尚未连接')} · 到期 ${esc(device.expires_at)}</small></span>${device.revoked?'':`<button class="ghost" data-revoke-agent="${esc(device.id)}">撤销授权</button>`}</div>`).join('')||'<p class="muted small">尚未授权 Agent。生成配对码后，按接入说明完成授权。</p>'}</div></div><div class="box section"><h2>我的任务</h2><p class="muted small">${tasks.filter(task=>task.status==='queued').length} 个等待接取 · ${tasks.filter(task=>task.status==='running').length} 个执行中</p><div class="tablewrap"><table><thead><tr><th>任务</th><th>状态</th><th>进度 / 结果</th><th>更新时间</th></tr></thead><tbody>${tasks.map(task=>`<tr><td>${esc(task.type||task.kind)} · ${esc(task.topic_id||task.id)}</td><td>${esc(task.status)}</td><td>${esc(task.detail||task.error||'等待本人的 Agent')}</td><td>${esc(task.updated_at||task.created_at)}</td></tr>`).join('')||'<tr><td colspan="4">尚无任务。到选题台开始，或在候选选题上选择下一步。</td></tr>'}</tbody></table></div></div>`;
  $('#agentRefresh').onclick = () => render();
  $('#copyAgentInstructions').onclick = () => copyText(prompt);
  $('#createAgentPairing').onclick = event => guard(event.target,async () => {const pairing=await api('POST','agent/pairing',{}); if(!alive())return; $('#agentPairing').innerHTML = `配对码 · 5 分钟内有效 <input class="agent-code" aria-label="创作 Agent 配对码" readonly value="${esc(pairing.code)}"><button class="ghost" id="copyAgentCode">复制配对码</button>`;$('#copyAgentCode').onclick=()=>copyText(pairing.code);setTimeout(()=>{if(alive())$('#agentPairing').textContent='配对码已过期，请重新生成。';},300000);});
  view.querySelectorAll('[data-revoke-agent]').forEach(button=>button.onclick=()=>guard(button,async()=>{await api('POST','agent/revoke',{id:button.dataset.revokeAgent});render();}));
  // Refresh is explicit here: replacing this view would discard an active pairing code.
  });
}

const VERSION_LABELS={expand:'扩写',brief:'简报',preview:'样板图',assets:'美术资产',game:'游戏成品',product:'游戏成品'};
// ---------- boot ----------

let settingsReady=Promise.resolve();
async function boot() {
  try {
    const response=await fetch('/api/auth/me',{cache:'no-store'});
    if(!response.ok){location.replace('/login');return;}
    state.session=await response.json();
    mountMemberShell(state.session,new URLSearchParams(location.search).get("tab")||"picks",{localTabs:true,onSquare:()=>navigateWorkspace({tab:'square'}),prepareSquare});
    if(state.session.role==='admin'){location.replace('/admin');return;}
    if(!state.session.star&&!memberOnly){location.replace('/');return;}
    if (!memberOnly) {
      // Settings and account counters must not delay the first useful page.
      state.settings={};
      statusReady=refreshStatus().catch(()=>{});
      settingsReady=api("GET","settings").then(settings=>{state.settings={...settings,...state.settings};}).catch(()=>{});
      try{state.executor=sessionStorage.getItem(`forge-executor-${state.session.id}`)||"platform";}catch{state.executor="platform";}
      try{const size=localStorage.getItem(`forge-draw-size-${state.session.id}`);if(size)state.settings.draw_size=size;}catch{}
      void rawApi('GET','generation-jobs').then(rows=>{
        for(const row of rows)if(['queued','running'].includes(row.status)&&GENERATION_LABELS[row.kind])void observeGeneration(row).catch(()=>{});
      }).catch(()=>{});
    }
    restoreWorkspace();
  } catch (e) {
    if (!$("#login").hidden) return;
    view.innerHTML = `<div class="box bad">${esc(e.message)}</div>`;
  }
}

withProgress("连接创作工作台", boot, {compact:true,tray:false});
