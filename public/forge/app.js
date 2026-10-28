// PGC Forge front end. Vanilla JS, no build step.
import { mountReviewWorkspace } from './review-workspace.js';
import { startTask, withProgress, progressHtml } from './progress.js';
import { readXlsxRows, listMembers, sheetToWorks } from './review-sheet.js';

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
const state = { session: null, tab: memberOnly ? "review" : "draw", vocab: null, settings: null, info: null, drawn: [], busy: false, showDup: false };

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const hexOk = (h) => /^#[0-9a-f]{3,8}$/i.test(String(h || "").trim());

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

async function rawApi(method, path, data) {
  const options = {signal:AbortSignal.timeout(path === 'review/jobs' && method === 'POST' ? 60000 : 30000)};
  const res = await fetch("/api/forge/" + path, {
    ...options,
    method,
    headers: { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  let out = null;
  try { out = await res.json(); } catch {}
  if (res.status === 401) {
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
const generationPolls=new Map();
const GENERATION_LABELS={preview:'生成样板图',suggest:'补充词库',tag:'自动打标签'};
function observeGeneration(row,provided) {
  if(generationPolls.has(row.id))return generationPolls.get(row.id);
  const task=provided||startTask(GENERATION_LABELS[row.kind]||'后台生成',{key:`generation-${row.id}`,retain:true,detail:row.detail||'等待后台执行…'});
  const promise=(async()=>{

    try{
      while(true){
        let saved;
        try{saved=await rawApi('GET',`generation-jobs/${row.id}`);}
        catch(error){
          if(error.status===401||error.status===403||error.status===404)throw error;
          task.update({detail:'正在重新连接，后台生成继续运行…'});
          await new Promise(resolve=>setTimeout(resolve,3500));continue;
        }
        if(saved.status==='error')throw new Error(saved.error||'生成未完成，请手动重试。');
        if(saved.status==='done'){
          let result=saved.result||{};
          if(result.version_id){
            const version=await rawApi('GET',`topics/${result.id}/versions/${encodeURIComponent(result.version_id)}`);
            if(result.disposition==='pending'){
              const pending=Object.assign(new Error('结果已保存为待确认版本，请在“历史版本”中查看并选择采用。'),{versionPending:true,topicId:result.id});
              if(!provided)task.done(pending.message,()=>showVersions({id:result.id,data:{title:'选题'}}));
              throw pending;
            }
            const content=version.content;
            result={...result,status:'done',...(version.kind==='preview'?{svg:content}:version.kind==='brief'?{brief:content}:version.kind==='assets'?{assets:content}:version.kind==='game'?{html:content,has_product:true}:{})};
          }
          if(!provided){
            const show=saved.kind==='preview'?async()=>{const t=await api('GET',`topics/${result.id}`);showPreview(t,result.svg);}:undefined;
            task.done('已完成',show);
          }
          return result;
        }
        task.update({detail:saved.detail||(saved.executor==='agent'?'等待本人的 Agent 回传…':'等待模型输出…')});
        await new Promise(resolve=>setTimeout(resolve,3500));
      }
      throw new Error('后台任务尚未结束，请稍后刷新查看。');
    }catch(error){if(!provided&&!error.versionPending)task.fail(error.message);if(error.versionPending)void showVersions({id:error.topicId,data:{title:'选题'}});throw error;}
    finally{generationPolls.delete(row.id);}
  })();
  generationPolls.set(row.id,promise);return promise;
}

async function guard(btn, fn, label) {
  if (btn) btn.disabled = true;
  try {
    return await withProgress(label || btn?.textContent?.trim() || "正在保存", fn, {compact:true});
  } catch (e) {
    toast(e.message, 4200);
  } finally {
    if (btn) btn.disabled = false;
  }
}

let modalOwner = null;
function openModal(title, html, owner = null) {
  modalOwner = owner;
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  $("#modal").hidden = false;
  if (window.frameElement) window.frameElement.scrollIntoView({ block: 'center', behavior: 'instant' });
}
$("#modalClose").onclick = () => ($("#modal").hidden = true);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });

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
    toast("已复制");
  } catch {
    toast("复制失败，请手动选择文字复制");
  }
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

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b || (memberOnly && b.dataset.tab !== "review")) return;
  if (state.reviewProbing) { toast('正在采集游戏画面，采集结束后即可切换。'); return; }
  state.tab = b.dataset.tab;
  for (const x of $("#tabs").children) x.classList.toggle("on", x === b);
  render();
});

// Each render gets a ticket; a slower render for a tab the user already left
// must not overwrite the current view.
let renderSeq = 0;
function render() {
  const seq = ++renderSeq;
  const alive = () => seq === renderSeq;
  const fn = { draw: renderDraw, picks: renderPicks, products: renderProducts, review: renderReview, vocab: renderVocab, games: renderGames, settings: renderSettings, agent: renderAgent }[state.tab];
  const label = {draw:"读取选题台",picks:"读取候选选题",products:"读取成品",review:"读取审核工作台",vocab:"读取词库",games:"读取作品库",settings:"读取公共规则",agent:"读取我的 Agent"}[state.tab];
  view.innerHTML = `<div class="pgc-inline-wait">${progressHtml({label,detail:"正在读取最新数据…"})}</div>`;
  withProgress(label, () => fn(alive), {compact:true}).catch((e) => { if (alive()) view.innerHTML = `<div class="box bad">${esc(e.message)}</div>`; });
}

// ---------- topic cards ----------

function artStyle(d) {
  const p = (d.palette || []).filter(hexOk);
  if (p.length >= 2) return `background: linear-gradient(135deg, ${p[0]} 0%, ${p[1]} 55%, ${p[2] || p[1]} 100%);`;
  return "";
}

function chipsHtml(t) {
  return `<div class="chips">${DIMS.map((d) => `<span class="chip" title="${DIM_LABEL[d]}">${esc(t[d])}</span>`).join("")}</div>`;
}

function topicCard(t, mode) {
  const d = t.data || {};
  if (t.status === "drawn") {
    return `<article class="card pending" data-id="${t.id}">
      <div class="art"><div class="title">…</div></div>
      <div class="body">${chipsHtml(t)}<div class="small">${t._pendingVersion ? '扩写结果已保存为待确认版本，请在历史版本中核对并选择采用。' : t._error ? `<span class="bad">${esc(t._error)}</span>` : t.expand_status === 'running' || t._inflight ? progressHtml({label:"AI 扩写中",detail:t.expand_error || "后台正在扩写选题…"}) : '选题已保存，可以开始扩写。'}</div></div>
      <div class="acts">${t._pendingVersion ? '' : t._error ? `<button class="ghost" data-act="retry">重试扩写</button>` : t.expand_status !== 'running' && !t._inflight ? `<button class="ghost" data-act="retry">开始扩写</button>` : ''}<button class="ghost" data-act="versions">历史版本</button></div>
    </article>`;
  }
  const sc = `${t.score ?? "?"} · ${d.aes ?? "?"}/${d.ease ?? "?"}/${d.play ?? "?"}`;
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
  if (mode === 'picks') acts.unshift(`<button class="${t.has_product ? 'ghost' : 'primary'}" data-act="makeGame">${['queued', 'running'].includes(t.product_status) ? '查看制作进度' : t.has_product ? '查看成品' : t.product_status === 'error' ? '重试制作' : '开始制作'}</button>`);
  if (mode === 'products') acts.push(`<button class="primary" data-act="viewProduct">查看成品</button>`);
  acts.push(`<button class="ghost" data-act="preview">${t.has_preview ? "看样板图" : "生成样板图"}</button>`);
  acts.push(`<button class="${mode === "picks" ? "primary" : "ghost"}" data-act="brief">${t.brief_status === 'running' ? "查看生成进度" : t.has_brief ? "看简报" : "生成简报"}</button>`);
  if (mode === "picks" && t.has_brief) acts.push(`<button class="ghost" data-act="assets">${t.assets_status === 'running' ? "查看资产进度" : t.has_assets ? "看资产" : "生成资产"}</button>`);
  return `<article class="card state-${t.status}" data-id="${t.id}">
    <div class="art" style="${artStyle(d)}"><div class="title">${esc(d.title)}</div><div class="score" title="预估 美学/易玩性/可玩性">${esc(sc)}</div></div>
    <div class="body">
      ${chipsHtml(t)}
      <div>${esc(d.logline)}</div>
      ${t.brief_status === 'running' ? `<div class="pgc-inline-wait">${progressHtml({label:'制作简报',detail:'后台正在生成，可查看进度。'})}</div>` : ''}
      ${t.assets_status === 'running' ? `<div class="pgc-inline-wait">${progressHtml({label:'生成资产',detail:'后台正在生成，可查看进度。'})}</div>` : ''}
      ${mode === 'picks' && ['queued', 'running'].includes(t.product_status) ? `<div class="pgc-inline-wait">${progressHtml({label:t.product_status === 'queued' ? '等待后台制作' : '正在制作游戏',detail:t.product_error || '直接使用选题资料生成单文件 HTML，可切到成品栏目查看任务。'})}</div>` : ''}
      ${mode === 'picks' && t.product_status === 'error' ? `<div class="small bad">${esc(t.product_error || '制作未完成，可重试。')}</div>` : ''}
      ${t.status === "dup" ? `<div class="small bad">与「${esc(d.dup_of)}」撞题</div>` : ""}
      <div class="kv"><b>新机制</b>${esc(d.twist)}</div>
      <div class="kv"><b>操作</b>${esc(d.controls)}</div>
      <div class="swatches">${sw}</div>
      <details><summary>完整方案</summary>
        <div class="kv"><b>核心循环</b>${esc(d.core_loop)}</div>
        <div class="kv"><b>节奏</b>${esc(d.progression)}</div>
        <div class="kv"><b>美术</b>${esc(d.art_direction)}</div>
        <div class="kv"><b>音频</b>${esc(d.audio)}</div>
        <div class="kv"><b>成瘾点</b>${esc(d.why_addictive)}</div>
        <div class="kv"><b>风险</b>${esc(d.risks)}</div>
      </details>
      ${mode === "picks" ? `<input class="note" type="text" data-act="note" placeholder="补充要求（会写进简报），失焦自动保存" value="${esc(t.note)}">` : ""}
    </div>
    <div class="acts">${acts.join("")}</div>
  </article>`;
}

function bindCards(root, list, rerender) {
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const card = btn.closest(".card");
    const id = Number(card.dataset.id);
    const t = list().find((x) => x.id === id);
    const act = btn.dataset.act;
    if (act === 'versions') { await guard(btn, () => showVersions(t), '读取历史版本'); return; }
    const repaint = () => { if (root.isConnected) rerender(); };
    if (act === 'makeGame') {
      if (t.has_product && t.product_status !== 'running') await guard(btn, () => showSavedProduct(t), '读取游戏成品');
      else startProductJob(t, repaint, {resume:['queued', 'running'].includes(t.product_status)});
      return;
    }
    if (act === 'viewProduct') { await showSavedProduct(t); return; }
    const job = TOPIC_JOBS[act];
    if (job && (!t[job.has] || t[job.status] === 'running' || jobRequests.get(`${act}-${id}`)?.pending)) {
      generateTopicJob(act, t, repaint); return;
    }
    await guard(btn, async (progress) => {
      if (act === "like" || act === "reject" || act === "make" || act === "unmake") {
        const status = { like: "liked", reject: "rejected", make: "made", unmake: "liked" }[act];
        Object.assign(t, await api("PATCH", `topics/${id}`, { status }));
        if (act === "like") toast("已加入候选");
        rerender();
      } else if (act === "retry") {
        await expandIds([id]);
      } else if (act === "preview") {
        let svg;
        if (t.has_preview) svg = (await api("GET", `topics/${id}`)).preview_svg;
        else {
          progress.update({detail:"后台正在绘制风格样板…"});
          svg = (await api("POST", `topics/${id}/preview`,undefined,progress)).svg;
          t.has_preview = 1;
          toast("样板图好了");
          rerender();
        }
        showPreview(t, svg);
      } else if (job) {
        const saved = await api("GET", `topics/${id}`);
        if (root.isConnected) job.show(t, job.read(saved));
      }
    });
  });
  root.addEventListener("change", async (e) => {
    if (e.target.dataset.act !== "note") return;
    const id = Number(e.target.closest(".card").dataset.id);
    const t = list().find((x) => x.id === id);
    await guard(null, async () => {
      Object.assign(t, await api("PATCH", `topics/${id}`, { note: e.target.value }));
      toast("补充要求已保存；已生成的简报需要重新生成才会包含它");
    });
  });
  // Restore observation after a reload without starting a second model job.
  for (const [kind, job] of Object.entries(TOPIC_JOBS)) {
    for (const topic of list()) if (topic[job.status] === 'running' && !jobRequests.has(`${kind}-${topic.id}`)) {
      generateTopicJob(kind, topic, () => { if (root.isConnected) rerender(); }, false, { show: false, resume: true });
    }
  }
  for (const topic of list()) if (['queued', 'running'].includes(topic.product_status)) {
    startProductJob(topic, () => { if (root.isConnected) rerender(); }, {show:false, resume:true});
  }
}

// Background jobs that produce one artifact per topic. They share queueing,
// progress, reconnect and reclaim behaviour; only names and outputs differ.
const TOPIC_JOBS = {
  brief: {
    label: "制作简报", noun: "简报", status: "brief_status", error: "brief_error", has: "has_brief",
    output: (saved) => saved?.brief_md, read: (saved) => saved?.brief_export || saved?.brief_md,
    done: "简报已生成，可以复制或下载。", show: (t, md) => showBrief(t, md),
  },
  assets: {
    label: "生成资产", noun: "资产", status: "assets_status", error: "assets_error", has: "has_assets",
    output: (saved) => saved?.assets_html, read: (saved) => saved?.assets_html,
    done: "资产已生成，可以预览或下载。", show: (t, html) => showAssets(t, html),
  },
};
const jobRequests = new Map();
function showJobProgress(kind, entry) {
  const job = TOPIC_JOBS[kind];
  openModal(`${entry.topic.data.title} · ${job.label}`, `<p class="muted small">${job.noun}由平台模型生成。可以关闭窗口或切换栏目，右下角会保留任务进度。</p><div id="${kind}Progress" class="pgc-inline-wait"></div>`, entry);
  entry.task.attach($(`#${kind}Progress`));
}
function generateTopicJob(kind, topic, repaint = () => {}, regenerate = false, { show = true, resume = false } = {}) {
  const job = TOPIC_JOBS[kind];
  const key = `${kind}-${topic.id}`;
  const current = jobRequests.get(key);
  if (current?.pending) { showJobProgress(kind, current); return; }
  const entry = {topic, pending:true};
  entry.task = startTask(`${job.label} · ${topic.data.title}`, {key, retain:true, detail:resume ? "已恢复后台任务，正在读取生成状态…" : "正在提交后台任务…", action:() => showJobProgress(kind, entry), actionLabel:"查看进度"});
  if (current) current.task.dismiss();
  jobRequests.set(key, entry);
  topic[job.status] = 'running'; repaint(); if (show) showJobProgress(kind, entry);
  void (async () => {
    try {
      const value = await requestTopicJob(kind, topic.id, regenerate, detail => entry.task.update({detail}), resume);
      topic[job.has] = 1; topic[job.status] = '';
      if (kind === 'brief' && topic.status !== 'made') topic.status = 'liked';
      entry.task.done(job.done, () => job.show(topic, value));
      repaint();
      if (modalOwner === entry && !$("#modal").hidden) job.show(topic, value);
    } catch (error) {
      if(error.versionPending){topic[job.status]='';entry.task.done(error.message,()=>showVersions(topic));repaint();return;}
      topic[job.status] = 'error';
      entry.task.fail(error.message);
      entry.task.update({action:() => generateTopicJob(kind, topic, repaint, regenerate),actionLabel:"重试 / 继续等待"});
      repaint();
    } finally { entry.pending = false; }
  })();
}
async function requestTopicJob(kind, id, regenerate = false, update = () => {}, resume = false) {
  const job = TOPIC_JOBS[kind];
  if(resume){
    const rows=await rawApi('GET','generation-jobs');
    const latest=rows.find(row=>row.kind===kind&&row.scope?.endsWith(`:${kind}:${id}`));
    if(latest){const value=await observeGeneration(latest,{update:state=>update(state.detail)});if(value?.[kind])return value[kind];}
  }
  if (!resume) try {
    const queued = await rawApi("POST", `topics/${id}/${kind}${regenerate ? '?regenerate=1' : ''}`);
    const started=queued?.jobId?await observeGeneration({id:queued.jobId},{update:state=>update(state.detail)}):queued;
    if (started?.[kind]) return started[kind];
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
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1200 : 3500));
    try {
      const saved = await api("GET", `topics/${id}`);
      if (saved?.[job.status] === 'error') throw new Error(`${failed}：${saved[job.error] || "请查看错误原因后手动重试。"}`);
      if (job.output(saved) && saved[job.status] !== 'running') return job.read(saved);
      update(saved?.[job.error] || `模型正在生成完整${job.noun}…`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(failed)) throw error;
      update("暂时无法读取进度，正在重新连接；后台任务会继续运行。");
    }
  }
  throw new Error(`${job.noun}仍在生成中，请稍后刷新候选列表查看结果。`);
}

function showPreview(t, svg) {
  const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  openModal(`${t.data.title} · 风格样板`, `<img class="preview" style="max-width:360px;margin:0 auto" src="${src}" alt="">
    <div class="row" style="margin-top:10px"><button class="ghost" id="dlSvg">下载 SVG</button>
    <button class="ghost" id="regenSvg">重新生成</button></div>`);
  $("#dlSvg").onclick = () => download(`${t.data.title}.svg`, svg, "image/svg+xml");
  $("#regenSvg").onclick = (e) => guard(e.target, async (progress) => {
    progress.update({label:"重新生成样板图",detail:"后台正在绘制新样板…"});
    const r = await api("POST", `topics/${t.id}/preview`,undefined,progress);
    showPreview(t, r.svg);
  });
}

function showBrief(t, md) {
  openModal(`${t.data.title} · 制作简报`, `<p class="muted small">整段复制给 Claude Code（或任何能写代码的模型）即可开工。</p>
    <div class="row" style="margin-bottom:8px"><button class="primary" id="cpBrief">复制简报</button>
    <a class="btn" id="dlBrief" href="/api/forge/topics/${t.id}/brief" download style="text-decoration:none">下载 .md</a><button class="ghost" id="regenBrief">重新生成</button></div>
    <pre class="md">${esc(md)}</pre>`);
  $("#cpBrief").onclick = () => copyText(md);
  $("#regenBrief").onclick = () => generateTopicJob('brief', t, () => {}, true);
}

// The asset file is model-generated HTML: preview it only in an opaque-origin
// sandbox, never in the workbench origin.
function showAssets(t, html) {
  openModal(`${t.data.title} · 美术资产`, `<p class="muted small">上面是合成的游戏画面（概念图），下面是逐个资产。确认后下载 HTML，和简报一起交给 Claude Code；简报里已写明要原样使用其中的 GAME_ASSETS。</p>
    <div class="row" style="margin-bottom:8px"><a class="btn primary" id="dlAssets" href="/api/forge/topics/${t.id}/assets" download style="text-decoration:none">下载资产 HTML</a>
    <button class="ghost" id="regenAssets">重新生成</button><span class="muted small">${Math.round(html.length / 1024)} KB</span></div>
    <iframe class="assets-frame" sandbox="allow-scripts" title="美术资产预览"></iframe>`);
  $("#modalBody .assets-frame").srcdoc = html;
  $("#regenAssets").onclick = () => generateTopicJob('assets', t, () => {}, true);
}

// ---------- 选题台 ----------

async function renderDraw(alive) {
  // Another device may have seeded or drawn since this page loaded.
  await refreshStatus();
  if (!alive()) return;
  if (!state.info.vocab) {
    view.innerHTML = `<div class="box section"><h2>公共词库尚未准备好</h2><p>请联系管理员维护公共词库后再开始抽签。</p></div>`;
    return;
  }
  const vocab = await loadVocab();
  if (!state.drawn.length) state.drawn = await api("GET", "topics?status=drawn,new,dup&limit=60");
  if (!alive()) return;
  const opts = (d) => vocab.filter((v) => v.dim === d && v.enabled && !v.used)
    .map((v) => `<option value="${esc(v.word)}">${esc(v.word)}</option>`).join("");
  view.innerHTML = `<div class="box section">
      <div class="row"><h2 class="grow">抽签</h2>
        <label class="small muted">数量 <input type="number" id="drawN" min="1" max="40" value="${esc(state.settings?.draw_size || 12)}" style="width:64px"></label>
        <button class="primary" id="drawBtn">抽一批</button></div>
      <p class="muted small">按历史审核分数加权随机组合五个维度，自动跳过做过的题材和重复组合，再交给 AI 扩写、打分、查重。想指定某个维度就在下面锁定。</p>
      <div class="locks">${DIMS.map((d) => `<label class="field">${DIM_LABEL[d]}<select data-lock="${d}"><option value="">随机</option>${opts(d)}</select></label>`).join("")}</div>
      <label class="field personal-requirements">补充要求<textarea id="drawRequirements" rows="3" placeholder="如目标人群、画面风格、操作限制；用于平台生成"></textarea></label>
      <details class="custom-topic"><summary>使用自己的主题</summary><div class="row"><input id="customSubject" class="grow" maxlength="200" placeholder="输入主题，例如：午夜修补玩具"><button class="ghost" id="customDrawBtn">创建主题并扩写</button></div><p class="muted small">沿用上面的维度锁定与补充要求，创建一个个人选题。</p></details>
      <div class="progress" id="progress"></div>
      <div id="lowStock"></div>
    </div>
    <div class="row section"><span class="muted small grow" id="drawSummary"></span>
      <button class="ghost small" id="clearBtn">清空未处理的</button></div>
    <div class="cards" id="cards"></div>`;
  $("#drawBtn").onclick = (e) => guard(e.target, () => doDraw());
  $('#customDrawBtn').onclick = event => guard(event.target,async () => {const subject=$('#customSubject').value.trim();if(!subject)throw new Error('请填写自己的主题。');await doDraw(subject);});
  $("#clearBtn").onclick = (e) => guard(e.target, async () => {
    const left = state.drawn.filter((t) => t.status === "new" || t.status === "dup" || t.status === "drawn");
    if (!left.length) return;
    if (!confirm(`把 ${left.length} 个未处理的选题都标记为"不要"？这会稍微降低它们组合里各个词的权重。`)) return;
    for (const t of left) Object.assign(t, await api("PATCH", `topics/${t.id}`, { status: "rejected" }));
    state.drawn = [];
    paintDrawn();
  });
  bindCards($("#cards"), () => state.drawn, paintDrawn);
  for(const t of state.drawn)if(t.expand_status==='error')t._error=t.expand_error||'扩写未完成，请重试。';
  await Promise.all(state.drawn.filter(t=>t.status==='drawn'&&t.expand_status!=='running'&&!t._error).map(async topic=>{
    try{const versions=await rawApi('GET',`topics/${topic.id}/versions`);topic._pendingVersion=(Array.isArray(versions)?versions:versions.versions||[]).some(version=>version.kind==='expand'&&version.disposition==='pending');}catch{}
  }));
  if (!alive()) return;
  paintDrawn();
  paintLowStock();
  const stuck = state.drawn.filter((t) => t.status === "drawn" && t.expand_status === 'running' && !t._inflight && !t._error).map((t) => t.id);
  if (stuck.length) expandIds(stuck,{resume:true});
}

function paintDrawn() {
  const box = $("#cards");
  if (!box) return;
  const shown = state.drawn.filter((t) => t.status !== "rejected" && (state.showDup || t.status !== "dup"));
  shown.sort((a, b) => (a.status === "drawn") - (b.status === "drawn") || (b.score || 0) - (a.score || 0));
  box.innerHTML = shown.map((t) => topicCard(t, "draw")).join("") || `<p class="muted">还没有选题，点"抽一批"。</p>`;
  const dups = state.drawn.filter((t) => t.status === "dup").length;
  const liked = state.drawn.filter((t) => t.status === "liked").length;
  $("#drawSummary").innerHTML = `${shown.length} 个在看 · ${liked} 个已要` +
    (dups ? ` · <a href="#" id="dupToggle">${state.showDup ? "隐藏" : "显示"} ${dups} 个撞题</a>` : "");
  const dt = $("#dupToggle");
  if (dt) dt.onclick = (e) => { e.preventDefault(); state.showDup = !state.showDup; paintDrawn(); };
}

// Every drawn subject is used up for good, so warn before the pool runs dry.
function paintLowStock() {
  const box = $("#lowStock");
  if (!box || !state.info) return;
  const left = state.info.fresh_subjects;
  const need = 2 * (Number(state.settings?.draw_size) || 12);
  if (left >= need) return (box.innerHTML = "");
  box.innerHTML = `<p class="small bad">还没用过的题材只剩 ${left} 个（每个题材只会被抽一次）。
    <button class="ghost small" id="suggestBtn">让 AI 补充 30 个题材</button></p>`;
  $("#suggestBtn").onclick = (e) => guard(e.target, progress => suggestWords("subject",progress));
}

async function suggestWords(dim,progress) {
  progress?.update({detail:'建议任务已交给你自己的 Agent，结果需管理员批准后进入公共词库。'});
  const r = await api("POST", "suggest", { dim, n: 30 },progress);
  toast(r?.words?.length ? `已提交 ${r.words.length} 个词库建议，等待管理员审批。` : '建议任务已保存，等待 Agent 完成并交管理员审批。', 6000);
  state.vocab = null;
  render();
}

async function doDraw(subject = '') {
  const locks = {};
  for (const s of view.querySelectorAll("select[data-lock]")) if (s.value) locks[s.dataset.lock] = s.value;
  const n = Number($("#drawN").value) || 12;
  const fresh = await api("POST", "draw", { n:subject?1:n, locks, subject, requirements:$('#drawRequirements').value.trim(), request_id:crypto.randomUUID() });
  state.drawn = fresh.concat(state.drawn.filter((t) => t.status !== "drawn"));
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
    if (topic.data?.title) {
      outcomes.set(Number(topic.id), 'done');
      pendingExpandIds.delete(Number(topic.id));
    }
    const local = state.drawn.find((item) => item.id === Number(topic.id));
    if (!local) return;
    Object.assign(local, topic);
    if (topic.data?.title) {
      local._inflight = false;
      local._error = "";
      local._pendingVersion = false;
      pendingExpandIds.delete(Number(topic.id));
    }
  };
  const progress = startTask("选题扩写", {value:0,total:unique.length,detail:"正在提交扩写队列…"});
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
    if (t?.data?.title) outcomes.set(id, 'done');
    if (t && !t.data?.title) { t._inflight = true; t._error = ""; t._pendingVersion=false; pendingExpandIds.add(id); }
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
      try {
        const task=tasks.get(id);
        if(task){
          const saved=await rawApi('GET',`generation-jobs/${task.id}`);
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
        if (topic?.expand_status === "error" && !topic.data?.title) {
          if (local) { local._error = topic.expand_error || "扩写失败，请点击重试。"; local._inflight = false; }
          outcomes.set(id, 'error');
          pendingExpandIds.delete(id);
        }
        if(!topic.data?.title&&topic.expand_status!=='running'&&pendingExpandIds.has(id)){
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
      if(pendingExpandIds.has(id))await new Promise(resolve=>setTimeout(resolve,3500));
    }
  };
  for (const id of unique) {
    const t = state.drawn.find((item) => item.id === id);
    if (!t?.data?.title && pendingExpandIds.has(id) && !activeExpandPolls.has(id)) {
      activeExpandPolls.add(id);
      void poll(id).finally(() => activeExpandPolls.delete(id));
    }
  }
}

// ---------- 候选 ----------

async function renderPicks(alive) {
  const list = await api("GET", "topics?status=liked,made&limit=200");
  if (!alive()) return;
  view.innerHTML = `<div class="row section"><h2 class="grow">候选选题</h2><span class="muted small">${list.length} 个</span></div>
    <p class="muted small section">点击“开始制作”，平台使用 Opus 5.5 生成可试玩的单文件游戏，完成后在“成品”栏目查看。</p>
    <div class="cards" id="pickCards"></div>`;
  const paint = () => {
    const shown = list.filter((t) => t.status === "liked" || t.status === "made");
    $("#pickCards").innerHTML = shown.map((t) => topicCard(t, "picks")).join("") || `<p class="muted">还没有候选，去选题台点"要"。</p>`;
  };
  bindCards($("#pickCards"), () => list, paint);
  paint();
}

async function renderProducts(alive) {
  const list = await api('GET', 'products');
  if (!alive()) return;
  const products = list.filter(topic => topic.has_product || ['queued', 'running', 'error'].includes(topic.product_status));
  view.innerHTML = `<div class="row section"><h2 class="grow">成品</h2><span class="muted small">${products.length} 款</span></div>
    <p class="muted small section">生成的可试玩首版保存在这里，可试玩或下载为单文件。${products.some(item => ['queued', 'running'].includes(item.product_status)) ? '正在制作的任务会在完成后自动出现。' : ''}</p>
    <div class="cards" id="productCards"></div>`;
  const paint = () => {
    if (!alive()) return;
    const cards = products.map(topic => ['queued', 'running'].includes(topic.product_status)
      ? `<article class="card pending" data-id="${topic.id}"><div class="art"><div class="title">${esc(topic.data?.title || '制作中')}</div></div><div class="body">${progressHtml({label:'游戏制作中',detail:topic.product_error || '等待后台执行。页面关闭后可恢复查看任务。'})}</div><div class="acts"><button class="ghost" data-act="resumeProduct">查看进度</button></div></article>`
      : topic.product_status === 'error'
        ? `<article class="card" data-id="${topic.id}"><div class="art"><div class="title">${esc(topic.data?.title || '制作未完成')}</div></div><div class="body"><p class="bad">${esc(topic.product_error || '制作失败，可重试。')}</p></div><div class="acts"><button class="primary" data-act="retryProduct">重试制作</button></div></article>`
        : productCard(topic)).join('');
    $('#productCards').innerHTML = cards || `<p class="muted">还没有成品。到候选栏目选中一款游戏，点击“开始制作”。</p>`;
  };
  bindProductCards($('#productCards'), products, paint);
  paint();
  for (const topic of products) if (['queued', 'running'].includes(topic.product_status)) {
    startProductJob(topic, paint, {show:false, resume:true});
  }
}

function productCard(topic) {
  const data = topic.data || {};
  return `<article class="card" data-id="${topic.id}"><div class="art" style="${artStyle(data)}"><div class="title">${esc(data.title || 'Untitled')}</div><div class="score">可试玩</div></div><div class="body">${chipsHtml(topic)}<p>${esc(data.logline || '')}</p><p class="muted small">单文件 HTML · ${esc(topic.updated_at || '')}</p></div><div class="acts"><button class="primary" data-act="viewProduct">查看成品</button><button class="ghost" data-act="versions">历史版本</button><a class="btn" href="/api/forge/topics/${topic.id}/product-file">下载 HTML</a></div></article>`;
}

function bindProductCards(root, list, paint) {
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const topic = list.find(item => item.id === Number(button.closest('[data-id]').dataset.id));
    if(button.dataset.act==='versions' && topic){await guard(button,()=>showVersions(topic),'读取历史版本');return;}
    if (button.dataset.act === 'viewProduct' && topic) await guard(button, () => showSavedProduct(topic), '读取游戏成品');
    if (button.dataset.act === 'resumeProduct' && topic) startProductJob(topic, paint, {resume:true});
    if (button.dataset.act === 'retryProduct' && topic) startProductJob(topic, paint);
  });
}

const productRequests = new Map();
function productProgress(topic, entry) {
  openModal(`${topic.data?.title || '游戏'} · AI 制作`, `<p class="muted small">先制作包含核心玩法和美术方向的可试玩首版，后期扩展留待迭代。任务已保存，平台 Opus 会在后台完成制作。可关闭此窗口或切换栏目，右下角会保留任务进度。</p><div id="productProgress" class="pgc-inline-wait"></div>`, entry);
  entry.task.attach($('#productProgress'));
}

function startProductJob(topic, repaint = () => {}, {show = true, resume = false} = {}) {
  const existing = productRequests.get(topic.id);
  if (existing?.pending) {
    existing.listeners.push({topic, repaint});
    Object.assign(topic, existing.topic); repaint();
    if (show) productProgress(topic, existing);
    return;
  }
  const entry = {topic, pending:true, listeners:[{topic, repaint}]};
  entry.repaint = () => { for (const listener of entry.listeners) { Object.assign(listener.topic, entry.topic); listener.repaint(); } };
  entry.task = startTask(`AI 制作 · ${topic.data?.title || '游戏'}`, {key:`product-${topic.id}`, retain:true, detail:resume ? '正在恢复后台任务状态…' : '正在提交制作任务…', action:() => productProgress(topic, entry), actionLabel:'查看进度'});
  productRequests.set(topic.id, entry);
  topic.product_status = resume ? topic.product_status : 'queued';
  repaint(); if (show) productProgress(topic, entry);
  void (async () => {
    try {
      const html = await requestProductJob(topic.id, entry, resume);
      topic.has_product = 1; topic.product_status = ''; topic.product_error = ''; topic.status = 'made';
      entry.task.done('游戏已生成，可预览或下载。', () => showProduct(topic, html));
      entry.repaint();
      if (modalOwner === entry && !$('#modal').hidden) showProduct(topic, html);
    } catch (error) {
      if(error.versionPending){topic.product_status='';entry.task.done(error.message,()=>showVersions(topic));entry.repaint();return;}
      topic.product_status = 'error'; topic.product_error = error.message;
      entry.task.fail(error.message);
      entry.task.update({action:() => startProductJob(topic, repaint), actionLabel:'重试制作'});
      entry.repaint();
    } finally { entry.pending = false; }
  })();
}

async function requestProductJob(id, entry, resume = false) {
  if(resume){
    const rows=await rawApi('GET','generation-jobs');
    const latest=rows.find(row=>row.kind==='game'&&row.scope?.endsWith(`:game:${id}`));
    if(latest){const value=await observeGeneration(latest,{update:state=>entry.task.update(state)});if(value?.html)return value.html;}
  }
  if (!resume) try {
    const queued=await rawApi('POST',`topics/${id}/game`);
    const started=queued?.jobId?await observeGeneration({id:queued.jobId},entry.task):queued;
    if(started.html)return started.html;
    if (started.status === 'done' && started.has_product) return (await api('GET', `topics/${id}/product`)).html;
    entry.task.update({detail:'后台已接收，Opus 将根据选题资料制作可试玩首版。'});
  } catch (error) {
    if(error.versionPending)throw error;
    if (error.status && error.status < 500) throw error;
    entry.task.update({detail:'提交响应中断，正在向后台确认任务状态…'});
  }
  for (let attempt = 0; ; attempt++) {
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 1200 : 4000));
    try {
      const saved = await api('GET', `topics/${id}/game`);
      Object.assign(entry.topic, saved);
      if (saved.product_status === 'error') throw Object.assign(new Error(saved.product_error || '制作失败，请重试。'), {terminal:true});
      if (saved.has_product && saved.product_status !== 'running') return (await api('GET', `topics/${id}/product`)).html;
      entry.task.update({detail:saved.product_error || 'Opus 正在制作 HTML 游戏，等待完整版本…'});
      entry.repaint();
      if (!['queued', 'running'].includes(saved.product_status)) throw Object.assign(new Error('后台没有接收到制作任务，请重新开始制作。'), {terminal:true});
    } catch (error) {
      if (error.terminal || (error.status && error.status < 500)) throw error;
      entry.task.update({detail:'暂时无法读取进度，正在重新连接；后台任务会继续运行。'});
    }
  }
}

async function showSavedProduct(topic) {
  const saved = topic.product_html ? {html:topic.product_html} : await api('GET', `topics/${topic.id}/product`);
  showProduct(topic, saved.html);
}

function showProduct(topic, html) {
  openModal(`${topic.data?.title || '游戏'} · 成品`, `<p class="muted small">单文件游戏，在隔离环境中预览。外部网络连接已禁用。</p><div class="row" style="margin-bottom:10px"><button class="primary" id="downloadProduct">下载 HTML</button><button class="ghost" id="copyProductPrompt">复制 HTML</button></div><iframe class="product-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${esc(topic.data?.title || '游戏')}成品预览" src="/api/forge/topics/${topic.id}/product-preview"></iframe>`);
  $('#downloadProduct').onclick = () => download(`${topic.data?.title || 'game'}.html`, html, 'text/html');
  $('#copyProductPrompt').onclick = () => copyText(html);
}

// ---------- 审核 ----------


import { probeGame, probeChecks } from './review-capture.js';

function checksHtml(checks) {
  const mark = { ok: "✅", warn: "⚠️", bad: "❌" };
  return `<ul class="checks">${checks.map((c) => `<li><span class="mark">${mark[c.level]}</span><span>${esc(c.text)}</span></li>`).join("")}</ul>`;
}

async function renderReview(alive) {
  const topics = memberOnly ? [] : await api("GET", "topics?status=liked,made&limit=200");
  if (!alive()) return;
  await mountReviewWorkspace({ view, api, alive, topics, probeGame, checksHtml, probeChecks, copyText, download, openModal,
    setProbing: value => { state.reviewProbing = value; },
  });
}

// ---------- 词库 ----------

async function renderVocab(alive) {
  const vocab = await loadVocab(true);
  if (!alive()) return;
  const dim = state.vocabDim || "subject";
  const rows = vocab.filter(v => v.dim === dim);
  view.innerHTML = `<div class="row section"><h2 class="grow">公共词库</h2><button class="ghost" id="suggestBtn">让我的 Agent 提出 30 个建议</button></div><p class="muted small section">公共词库由管理员维护。个人喜好和已使用记录仅影响自己的抽签；Agent 的补词建议经管理员批准后才进入公共词库。</p><div class="row section">${DIMS.map(d => `<button class="${d === dim ? 'primary' : 'ghost'}" data-dim="${d}">${DIM_LABEL[d]} (${vocab.filter(v => v.dim === d).length})</button>`).join('')}</div><div class="tablewrap box"><table><thead><tr><th>词</th><th>备注</th><th>公共权重</th><th>个人学习系数</th><th>状态</th></tr></thead><tbody>${rows.map(v => `<tr><td class="${v.used ? 'used' : ''}">${esc(v.word)}</td><td>${esc(v.note)}</td><td>${esc(v.base)}</td><td>×${Number(v.factor || 1).toFixed(2)}</td><td>${v.enabled ? v.used ? '本人已使用' : '可抽取' : '已停用'}</td></tr>`).join('')}</tbody></table></div>`;
  view.querySelectorAll('[data-dim]').forEach(button => button.onclick = () => { state.vocabDim = button.dataset.dim; render(); });
  $('#suggestBtn').onclick = event => guard(event.target, progress => suggestWords(dim,progress));
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
      <td><button class="ghost bad small" data-del>删</button></td></tr>`).join("")}
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
    const id = e.target.closest("tr").dataset.id;
    guard(null, async () => { await api("PATCH", `games/${id}`, { [field]: e.target.value.trim() }); toast("已保存"); });
  });
  tbody.addEventListener("click", (e) => {
    if (!e.target.matches("[data-del]")) return;
    if (!confirm("从作品库删除？删除后这个题材可能再次被抽到。")) return;
    guard(e.target, async () => { await api("DELETE", `games/${e.target.closest("tr").dataset.id}`); await refreshStatus(); render(); });
  });
}

// ---------- 设置 ----------

async function renderSettings(alive) {
  const s = await api('GET', 'settings');
  if (!alive()) return;
  view.innerHTML = `<div class="box section"><h2>我的工作台</h2><p class="muted small">创作与审核由自己的 Agent 使用它的模型完成。每一步由你开始，结果保存在个人空间。</p><form id="drawPrefs" class="row"><label class="field">每次抽几个<input id="drawSizePref" type="number" min="1" max="40" value="${Number(state.settings?.draw_size || 12)}"></label><button class="ghost">保存抽签偏好</button></form></div><div class="box section"><h2>公共选题规律与雷区</h2><pre class="md">${esc(s.redlines || '暂无规则')}</pre></div><div class="box section"><h2>公共制作模板</h2><pre class="md">${esc(s.template || '暂无模板')}</pre></div><div class="box section"><h2>F 部分骨架</h2><pre class="md">${esc(s.template_f || '暂无骨架')}</pre></div><div class="row section"><button class="ghost" id="exportBtn">导出我的数据</button><button class="ghost" id="changePassword">修改密码</button><button class="ghost" id="logoutBtn">退出登录</button></div>`;
  $('#drawPrefs').onsubmit = event => { event.preventDefault(); const value = Math.min(40,Math.max(1,Number($('#drawSizePref').value) || 12)); state.settings.draw_size = String(value); try {localStorage.setItem(`forge-draw-size-${state.session.id}`, String(value));} catch {} toast('个人抽签偏好已保存'); };
  $('#exportBtn').onclick = event => guard(event.target,async () => download(`pgc-personal-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(await api('GET','export'),null,2),'application/json'));
  $('#changePassword').onclick = () => {
    openModal('修改我的密码', `<form id="personalPassword" class="agent-password"><label class="field">原密码<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label class="field">新密码<input name="newPassword" type="password" autocomplete="new-password" required minlength="6" maxlength="128"></label><button class="primary" type="submit">保存新密码</button><p id="passwordMessage" role="status"></p></form>`);
    $('#personalPassword').onsubmit = event => { event.preventDefault(); guard(event.submitter, async () => { const response=await fetch('/api/auth/password',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});const data=await response.json();if(!response.ok)throw new Error(data.error||'修改失败');location.replace('/login'); }); };
  };
  $('#logoutBtn').onclick = () => guard($('#logoutBtn'), async () => { await fetch('/api/auth/logout',{method:'POST'});location.replace('/login'); });
}

async function renderAgent(alive) {
  const data = await api('GET','agent/devices');
  if (!alive()) return;
  const devices = data.devices || [];
  const tasks = data.tasks || [];
  const prompt = `请阅读 ${location.origin}/forge-agent.md，使用你自己的模型连接我的 PGC 个人创作空间。首次连接时请让我生成一次性配对码并直接在本对话中询问我，收到后由你自行完成配对，不要让我打开命令窗口。领取我明确开始的任务并回传结果；不要自动筛选选题或继续下一环节。审核接入请另读 ${location.origin}/agent.md。`;
  view.innerHTML = `<div class="box section personal-agent"><div class="row"><h2 class="grow">我的创作 Agent</h2><button class="ghost" id="agentRefresh">刷新状态</button></div><p class="muted small">把接入指令交给自己的智能助手。它使用自己的模型完成扩写、简报、样板图、资产、制作、标签与词库建议。任务各自保存，其他成员无法领取。</p><pre class="md">${esc(prompt)}</pre><div class="row"><button class="primary" id="copyAgentInstructions">复制接入指令</button><button class="ghost" id="createAgentPairing">生成一次性配对码</button><a class="btn" href="/forge-agent.md" target="_blank" rel="noopener">查看接入说明 ↗</a></div><p id="agentPairing" role="status"></p><div class="agent-device-list">${devices.map(device=>`<div class="agent-device"><span><b>${esc(device.name)}</b><small>${device.revoked?'已撤销':device.online?'最近连接':'已授权'} · 最近连接 ${esc(device.last_seen || '尚未连接')} · 到期 ${esc(device.expires_at)}</small></span>${device.revoked?'':`<button class="ghost" data-revoke-agent="${esc(device.id)}">撤销授权</button>`}</div>`).join('')||'<p class="muted small">尚未授权 Agent。生成配对码后，按接入说明完成授权。</p>'}</div></div><div class="box section"><h2>我的任务</h2><p class="muted small">${tasks.filter(task=>task.status==='queued').length} 个等待接取 · ${tasks.filter(task=>task.status==='running').length} 个执行中</p><div class="tablewrap"><table><thead><tr><th>任务</th><th>状态</th><th>进度 / 结果</th><th>更新时间</th></tr></thead><tbody>${tasks.map(task=>`<tr><td>${esc(task.type||task.kind)} · ${esc(task.topic_id||task.id)}</td><td>${esc(task.status)}</td><td>${esc(task.detail||task.error||'等待本人的 Agent')}</td><td>${esc(task.updated_at||task.created_at)}</td></tr>`).join('')||'<tr><td colspan="4">尚无任务。到选题台开始，或在候选选题上选择下一步。</td></tr>'}</tbody></table></div></div>`;
  $('#agentRefresh').onclick = () => render();
  $('#copyAgentInstructions').onclick = () => copyText(prompt);
  $('#createAgentPairing').onclick = event => guard(event.target,async () => {const pairing=await api('POST','agent/pairing',{}); if(!alive())return; $('#agentPairing').innerHTML = `配对码 · 5 分钟内有效 <input class="agent-code" aria-label="创作 Agent 配对码" readonly value="${esc(pairing.code)}"><button class="ghost" id="copyAgentCode">复制配对码</button>`;$('#copyAgentCode').onclick=()=>copyText(pairing.code);setTimeout(()=>{if(alive())$('#agentPairing').textContent='配对码已过期，请重新生成。';},300000);});
  view.querySelectorAll('[data-revoke-agent]').forEach(button=>button.onclick=()=>guard(button,async()=>{await api('POST','agent/revoke',{id:button.dataset.revokeAgent});render();}));
  const timer=setInterval(()=>{if(!alive()){clearInterval(timer);return;}if(!document.hidden)render();},20000);
}

const VERSION_LABELS={expand:'扩写',brief:'简报',preview:'样板图',assets:'美术资产',game:'游戏成品',product:'游戏成品'};
async function showVersions(topic) {
  const response=await api('GET',`topics/${topic.id}/versions`);
  const versions=Array.isArray(response)?response:response.versions||[];
  openModal(`${topic.data?.title || '选题'} · 历史版本`, `<p class="muted small">上游内容更新后，旧结果仍保留。恢复历史内容会创建新的当前版本，后续任务从新版本继续。</p><div class="version-list">${versions.map(version=>`<div class="version-row"><span><b>${esc(VERSION_LABELS[version.kind]||version.kind)}</b><small>${esc(version.created_at)} · ${version.executor==='agent'?'我的 Agent':esc(version.executor||'历史记录')}${version.model?' · '+esc(version.model):''}</small><small>${version.current||version.disposition==='current'?'当前版本':version.disposition==='pending'?'待确认结果':'历史版本'}${version.stale?' · 上游版本已变化':''}</small></span><button class="ghost" data-version="${esc(version.id)}">查看 / 恢复</button></div>`).join('')||'<p>还没有版本记录。</p>'}</div>`);
  $('#modalBody').querySelectorAll('[data-version]').forEach(button=>button.onclick=()=>guard(button,async()=>{
    const version=await api('GET',`topics/${topic.id}/versions/${encodeURIComponent(button.dataset.version)}`);
    const content=typeof version.content==='string'?version.content:JSON.stringify(version.content,null,2);
    openModal(`${VERSION_LABELS[version.kind]||version.kind} · ${version.created_at||'历史版本'}`,`<div class="row section"><button class="ghost" id="backToVersions">返回版本列表</button><button class="ghost" id="copyVersion">复制内容</button><button class="primary" id="restoreVersion">${version.disposition==='pending'?'采用此结果':'恢复此版本'}</button></div>${version.stale?'<p class="small bad">生成时使用的上游内容已变化，采用前请核对。</p>':''}<pre class="md">${esc(content)}</pre>`);
    $('#backToVersions').onclick=()=>showVersions(topic);
    $('#copyVersion').onclick=()=>copyText(content);
    $('#restoreVersion').onclick=event=>guard(event.target,async()=>{await api('POST',`topics/${topic.id}/restore`,{version_id:version.id});toast('版本已恢复，依赖旧内容的产物仍可在历史中查看。');state.drawn=[];$('#modal').hidden=true;render();});
  }));
}

// ---------- boot ----------

async function boot() {
  try {
    const response=await fetch('/api/auth/me',{cache:'no-store'});
    if(!response.ok){location.replace('/login');return;}
    state.session=await response.json();
    if(state.session.role==='admin'){location.replace('/admin');return;}
    if(!state.session.star&&!memberOnly){location.replace('/');return;}
    if (!memberOnly) {
      await refreshStatus();
      state.settings = await api("GET", "settings");
      try{const size=localStorage.getItem(`forge-draw-size-${state.session.id}`);if(size)state.settings.draw_size=size;}catch{}
      void rawApi('GET','generation-jobs').then(rows=>{
        for(const row of rows)if(['queued','running'].includes(row.status)&&GENERATION_LABELS[row.kind])void observeGeneration(row).catch(()=>{});
      }).catch(()=>{});
    }
    render();
  } catch (e) {
    if (!$("#login").hidden) return;
    view.innerHTML = `<div class="box bad">${esc(e.message)}</div>`;
  }
}

withProgress("连接创作工作台", boot, {compact:true});
