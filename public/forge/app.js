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
const state = { tab: memberOnly ? "review" : "draw", vocab: null, settings: null, info: null, drawn: [], busy: false, showDup: false };

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

async function api(method, path, data) {
  const options = path === 'review/jobs' && method === 'POST' ? { signal: AbortSignal.timeout(60000) } : {};
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

async function guard(btn, fn, label) {
  if (btn) btn.disabled = true;
  try {
    return await withProgress(label || btn?.textContent?.trim() || "正在保存", fn);
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
  const ok = i.providers[i.provider];
  $("#status").innerHTML = `${esc(i.games)} 款作品 · ${esc(i.vocab)} 个词 · 模型 <b>${esc(i.model)}</b>${ok ? "" : ' <span class="bad">（未配置 key）</span>'}`;
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
  const fn = { draw: renderDraw, picks: renderPicks, review: renderReview, vocab: renderVocab, games: renderGames, settings: renderSettings }[state.tab];
  const label = {draw:"读取选题台",picks:"读取候选选题",review:"读取审核工作台",vocab:"读取词库",games:"读取作品库",settings:"读取设置"}[state.tab];
  view.innerHTML = `<div class="pgc-inline-wait">${progressHtml({label,detail:"正在读取最新数据…"})}</div>`;
  withProgress(label, () => fn(alive)).catch((e) => { if (alive()) view.innerHTML = `<div class="box bad">${esc(e.message)}</div>`; });
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
      <div class="body">${chipsHtml(t)}<div class="small">${t._error ? `<span class="bad">${esc(t._error)}</span>` : progressHtml({label:"AI 扩写中",detail:t.expand_error || "后台排队与生成中…"})}</div></div>
      ${t._error ? `<div class="acts"><button class="ghost" data-act="retry">重试</button></div>` : ""}
    </article>`;
  }
  const sc = `${t.score ?? "?"} · ${d.aes ?? "?"}/${d.ease ?? "?"}/${d.play ?? "?"}`;
  const sw = (d.palette || []).filter(hexOk).map((h) => `<span style="background:${h}" title="${esc(h)}"></span>`).join("");
  const acts = [];
  if (mode === "draw") {
    acts.push(`<button class="ghost good" data-act="like">要</button>`, `<button class="ghost bad" data-act="reject">不要</button>`);
  } else {
    acts.push(t.status === "made"
      ? `<button class="ghost" data-act="unmake">取消已制作</button>`
      : `<button class="ghost good" data-act="make">标记已制作</button>`);
    acts.push(`<button class="ghost bad" data-act="reject">移出候选</button>`);
  }
  acts.push(`<button class="ghost" data-act="preview">${t.has_preview ? "看样板图" : "生成样板图"}</button>`);
  acts.push(`<button class="${mode === "picks" ? "primary" : "ghost"}" data-act="brief">${t.brief_status === 'running' ? "查看生成进度" : t.has_brief ? "看简报" : "生成简报"}</button>`);
  if (mode === "picks" && t.has_brief) acts.push(`<button class="ghost" data-act="assets">${t.assets_status === 'running' ? "查看资产进度" : t.has_assets ? "看资产" : "生成资产"}</button>`);
  return `<article class="card state-${t.status}" data-id="${t.id}">
    <div class="art" style="${artStyle(d)}"><div class="title">${esc(d.title)}</div><div class="score" title="预估 美学/易玩性/可玩性">${esc(sc)}</div></div>
    <div class="body">
      ${chipsHtml(t)}
      <div>${esc(d.logline)}</div>
      ${t.brief_status === 'running' ? `<div class="pgc-inline-wait">${progressHtml({label:'制作简报',detail:'后台排队或生成中，可查看进度。'})}</div>` : ''}
      ${t.assets_status === 'running' ? `<div class="pgc-inline-wait">${progressHtml({label:'生成资产',detail:'后台排队或生成中，可查看进度。'})}</div>` : ''}
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
    const repaint = () => { if (root.isConnected) rerender(); };
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
          progress.update({detail:"模型正在绘制风格样板，返回后会展示图片。"});
          svg = (await api("POST", `topics/${id}/preview`)).svg;
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
  openModal(`${entry.topic.data.title} · ${job.label}`, `<p class="muted small">${job.noun}在后台生成。可以关闭窗口或切换栏目，右下角会保留任务进度。</p><div id="${kind}Progress" class="pgc-inline-wait"></div>`, entry);
  entry.task.attach($(`#${kind}Progress`));
}
function generateTopicJob(kind, topic, repaint = () => {}, regenerate = false, { show = true, resume = false } = {}) {
  const job = TOPIC_JOBS[kind];
  const key = `${kind}-${topic.id}`;
  const current = jobRequests.get(key);
  if (current?.pending) { showJobProgress(kind, current); return; }
  const entry = {topic, pending:true};
  entry.task = startTask(`${job.label} · ${topic.data.title}`, {key, retain:true, detail:resume ? "已恢复后台任务，正在读取生成状态…" : "正在提交后台…", action:() => showJobProgress(kind, entry), actionLabel:"查看进度"});
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
      topic[job.status] = 'error';
      entry.task.fail(error.message);
      entry.task.update({action:() => generateTopicJob(kind, topic, repaint, regenerate),actionLabel:"重试 / 继续等待"});
      repaint();
    } finally { entry.pending = false; }
  })();
}
async function requestTopicJob(kind, id, regenerate = false, update = () => {}, resume = false) {
  const job = TOPIC_JOBS[kind];
  if (!resume) try {
    const started = await api("POST", `topics/${id}/${kind}${regenerate ? '?regenerate=1' : ''}`);
    if (started?.[kind]) return started[kind];
    update(`后台已接收，正在排队或生成${job.noun}。可以继续使用工作台。`);
  } catch (error) {
    // The Worker writes the result before sending its response. If the relay
    // or browser timed out, recover the saved result before asking the model
    // to run again.
    if (!/超时|timeout|409|5\d\d|网络|failed to fetch|fetch failed|network/i.test(String(error?.message || error))) throw error;
    update("提交响应中断，正在向后台确认任务状态…");
  }
  let reclaimed = false;
  const failed = `${job.noun}生成失败`;
  for (let attempt = 0; attempt < 210; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1200 : 3500));
    try {
      const saved = await api("GET", `topics/${id}`);
      if (saved?.[job.status] === 'error') throw new Error(`${failed}：${saved[job.error] || "请重试或切换模型。"}`);
      if (job.output(saved) && saved[job.status] !== 'running') return job.read(saved);
      update(saved?.[job.error] || `后台排队或生成中，正在等待完整${job.noun}返回。`);
      // A waitUntil task can be cut off by the edge while the model gateway is
      // still working. Re-submit once after the lease expires so the server
      // can reclaim the stale job instead of polling forever.
      if (!reclaimed && attempt >= 28 && saved?.[job.status] === 'running') {
        reclaimed = true;
        update("正在确认后台任务并恢复等待…");
        await api("POST", `topics/${id}/${kind}`);
      }
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
    progress.update({label:"重新生成样板图",detail:"模型正在绘制新的风格样板…"});
    const r = await api("POST", `topics/${t.id}/preview`);
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
  if (!state.info.games && !state.info.vocab) {
    view.innerHTML = `<div class="box section"><h2>第一次使用</h2>
      <p>数据库是空的。点下面的按钮载入内置知识库：你在 PGC 上的全部作品和审核意见、其他创作者的 36 款审核记录、以及 5 个维度约 260 个词的词库。</p>
      <button class="primary" id="seedBtn">初始化知识库</button></div>`;
    $("#seedBtn").onclick = (e) => guard(e.target, async () => {
      await api("POST", "seed");
      await refreshStatus();
      toast("知识库已载入");
      render();
    });
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
      <div class="progress" id="progress"></div>
      <div id="lowStock"></div>
    </div>
    <div class="row section"><span class="muted small grow" id="drawSummary"></span>
      <button class="ghost small" id="clearBtn">清空未处理的</button></div>
    <div class="cards" id="cards"></div>`;
  $("#drawBtn").onclick = (e) => guard(e.target, doDraw);
  $("#clearBtn").onclick = (e) => guard(e.target, async () => {
    const left = state.drawn.filter((t) => t.status === "new" || t.status === "dup" || t.status === "drawn");
    if (!left.length) return;
    if (!confirm(`把 ${left.length} 个未处理的选题都标记为"不要"？这会稍微降低它们组合里各个词的权重。`)) return;
    for (const t of left) Object.assign(t, await api("PATCH", `topics/${t.id}`, { status: "rejected" }));
    state.drawn = [];
    paintDrawn();
  });
  bindCards($("#cards"), () => state.drawn, paintDrawn);
  paintDrawn();
  paintLowStock();
  const stuck = state.drawn.filter((t) => t.status === "drawn" && !t._inflight && !t._error).map((t) => t.id);
  if (stuck.length) expandIds(stuck);
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
  $("#suggestBtn").onclick = (e) => guard(e.target, () => suggestWords("subject"));
}

async function suggestWords(dim) {
  const r = await api("POST", "suggest", { dim, n: 30 });
  state.vocab = null;
  await refreshStatus();
  toast(`新增 ${r.added} 个：${r.words.slice(0, 8).join("、")}${r.added > 8 ? "…" : ""}`, 6000);
  render();
}

async function doDraw() {
  const locks = {};
  for (const s of view.querySelectorAll("select[data-lock]")) if (s.value) locks[s.dataset.lock] = s.value;
  const n = Number($("#drawN").value) || 12;
  const fresh = await api("POST", "draw", { n, locks });
  state.drawn = fresh.concat(state.drawn.filter((t) => t.status !== "drawn"));
  paintDrawn();
  refreshStatus().then(paintLowStock).catch(() => {});
  await expandIds(fresh.map((t) => t.id));
}

const activeExpandPolls = new Set();
const pendingExpandIds = new Set();

async function expandIds(ids) {
  const unique = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!unique.length) return;
  // Queue consumers serialize the actual model calls. Submit every batch up
  // front so a 12-topic draw is queued as 12 small jobs instead of waiting for
  // one browser request to finish before the next one can even start.
  const slowModel = /opus|claude/i.test(String(state.info?.model || ""));
  const size = slowModel ? 1 : Math.min(2, Math.max(1, Number(state.settings?.expand_batch) || 2));
  const chunks = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  const outcomes = new Map();
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
      pendingExpandIds.delete(Number(topic.id));
    }
  };
  const progress = startTask("选题扩写", {value:0,total:unique.length,detail:"正在提交扩写队列…"});
  let settled = false;
  const paintProgress = () => {
    const done = unique.filter(id => outcomes.get(id) === 'done').length;
    const failed = unique.filter(id => outcomes.get(id) === 'error').length;
    const remaining = unique.length - done - failed;
    const waitingNote = unique.map(id => state.drawn.find(t => t.id === id)).find(t => t?.expand_status === 'running' && t.expand_error)?.expand_error;
    const detail = `${done} 个已生成${failed ? ` · ${failed} 个未完成` : ''}${remaining ? ` · ${remaining} 个排队或生成中` : ''}${waitingNote ? ` · ${waitingNote}` : ''}`;
    const status = remaining ? 'running' : failed ? 'error' : 'done';
    progress.update({value:done,detail,status});
    const p = $("#progress");
    if (p) p.innerHTML = progressHtml({label:slowModel ? "Opus 选题扩写" : "AI 选题扩写",value:done,total:unique.length,detail,status});
    if (!remaining && !settled) {
      settled = true;
      if (failed) progress.fail(detail + "，可在对应卡片重试。");
      else progress.done(detail);
    }
  };
  for (const id of unique) {
    const t = state.drawn.find((item) => item.id === id);
    if (t?.data?.title) outcomes.set(id, 'done');
    if (t && !t.data?.title) { t._inflight = true; t._error = ""; pendingExpandIds.add(id); }
  }
  paintDrawn();
  paintProgress();

  const submit = async (chunk) => {
    try {
      const result = await api("POST", "expand", { ids: chunk });
      if (Array.isArray(result)) result.forEach(updateTopic);
      else if (Array.isArray(result?.topics)) result.topics.forEach(updateTopic);
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
  // Keep the HTTP enqueue burst small; the queue, rather than the browser,
  // controls model concurrency.
  const waitingChunks = chunks.slice();
  const submitWorker = async () => { while (waitingChunks.length) await submit(waitingChunks.shift()); };
  await Promise.all(Array.from({ length: Math.min(4, waitingChunks.length) }, submitWorker));
  paintDrawn();
  paintProgress();

  const poll = async (id) => {
    const deadline = Date.now() + (slowModel ? 30 * 60 * 1000 : 10 * 60 * 1000);
    while (Date.now() < deadline && pendingExpandIds.has(id)) {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      try {
        const topic = await api("GET", `topics/${id}`);
        updateTopic(topic);
        const local = state.drawn.find((item) => item.id === id);
        if (topic?.expand_status === "error" && !topic.data?.title) {
          if (local) { local._error = topic.expand_error || "扩写失败，请点击重试。"; local._inflight = false; }
          outcomes.set(id, 'error');
          pendingExpandIds.delete(id);
        }
        paintDrawn();
        paintProgress();
      } catch {}
    }
    if (pendingExpandIds.has(id)) {
      const local = state.drawn.find((item) => item.id === id);
      if (local) { local._error = "任务仍在队列中，点击重试可继续等待。"; local._inflight = false; }
      outcomes.set(id, 'error');
      pendingExpandIds.delete(id);
      paintDrawn();
      paintProgress();
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
    <p class="muted small section">生成简报后整段复制给 Claude Code 制作。做完记得点"标记已制作"，它就会进入去重库，再也不会被抽到。</p>
    <div class="cards" id="pickCards"></div>`;
  const paint = () => {
    const shown = list.filter((t) => t.status === "liked" || t.status === "made");
    $("#pickCards").innerHTML = shown.map((t) => topicCard(t, "picks")).join("") || `<p class="muted">还没有候选，去选题台点"要"。</p>`;
  };
  bindCards($("#pickCards"), () => list, paint);
  paint();
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
  const rows = vocab.filter((v) => v.dim === dim);
  view.innerHTML = `<div class="row section">${DIMS.map((d) => `<button class="${d === dim ? "primary" : "ghost"}" data-dim="${d}">${DIM_LABEL[d]} (${vocab.filter((v) => v.dim === d).length})</button>`).join("")}</div>
    <div class="box section"><form class="row" id="addVocab">
      <input type="text" name="word" placeholder="新词" required class="grow">
      <input type="text" name="note" placeholder="备注（可选）" class="grow">
      <input type="number" name="base" value="1" step="0.1" min="0" style="width:72px" title="手动权重">
      <button class="primary">添加到${DIM_LABEL[dim]}</button>
      ${dim === "subject" || dim === "medium" ? `<button type="button" class="ghost" id="suggestBtn">AI 补充 30 个</button>` : ""}</form>
      <p class="muted small" style="margin:8px 0 0">实际抽中概率 ∝ 手动权重 × 学习系数。学习系数来自用到这个词的游戏的审核分数（≥7 分越高越多），以及你在选题台点"要/不要"的记录。${dim === "subject" ? "划线的题材已经做过，不会再被抽到。" : ""}</p>
    </div>
    <div class="tablewrap box"><table><thead><tr><th>词</th><th>备注</th><th>手动权重</th><th>学习系数</th><th>实际</th><th>启用</th><th></th></tr></thead>
    <tbody>${rows.map((v) => {
      const cls = v.factor > 1.02 ? "factor-up" : v.factor < 0.98 ? "factor-down" : "muted";
      const why = [v.n ? `${v.n} 款均 ${v.avg.toFixed(1)}` : "", v.likes ? `要 ${v.likes}` : "", v.rejects ? `不要 ${v.rejects}` : ""].filter(Boolean).join(" · ");
      return `<tr data-id="${v.id}"><td class="${v.used ? "used" : ""}">${esc(v.word)}</td>
        <td><input type="text" data-f="note" value="${esc(v.note)}"></td>
        <td><input type="number" data-f="base" value="${esc(v.base)}" step="0.1" min="0"></td>
        <td class="${cls}">×${v.factor.toFixed(2)} <span class="small muted">${esc(why)}</span></td>
        <td>${(v.base * v.factor).toFixed(2)}</td>
        <td><input type="checkbox" data-f="enabled" ${v.enabled ? "checked" : ""}></td>
        <td><button class="ghost bad small" data-del>删</button></td></tr>`;
    }).join("")}</tbody></table></div>`;
  view.querySelectorAll("button[data-dim]").forEach((b) => (b.onclick = () => { state.vocabDim = b.dataset.dim; render(); }));
  if ($("#suggestBtn")) $("#suggestBtn").onclick = (e) => guard(e.target, () => suggestWords(dim));
  $("#addVocab").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    guard(e.submitter, async () => {
      await api("POST", "vocab", { dim, word: f.get("word"), note: f.get("note"), base: Number(f.get("base")) });
      state.vocab = null;
      render();
    });
  };
  view.querySelector("tbody").addEventListener("change", (e) => {
    const tr = e.target.closest("tr");
    const f = e.target.dataset.f;
    if (!f) return;
    const val = f === "enabled" ? (e.target.checked ? 1 : 0) : f === "base" ? Number(e.target.value) : e.target.value;
    guard(null, async () => { await api("PATCH", `vocab/${tr.dataset.id}`, { [f]: val }); state.vocab = null; toast("已保存"); });
  });
  view.querySelector("tbody").addEventListener("click", (e) => {
    if (!e.target.matches("[data-del]")) return;
    const tr = e.target.closest("tr");
    if (!confirm("删除这个词？")) return;
    guard(e.target, async () => { await api("DELETE", `vocab/${tr.dataset.id}`); state.vocab = null; render(); });
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
  view.innerHTML = `<details class="box section" open><summary><b>导入总审核的审核记录表格</b>（.xlsx）</summary>
      <p class="small muted">总审核导出的「版本审核记录」表格：每行一条初审或终审记录。同名游戏会合并更新分数和意见，保留已有的简介和标签。组员姓名只在这台电脑上用来区分"我的"和"他人"，不会上传。</p>
      <div class="locks">
        <label class="field">表格文件<input type="file" id="sheetFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
        <label class="field">哪一位是你<select id="sheetSelf" disabled><option value="">先选择文件</option></select></label>
        <label class="field">&nbsp;<button class="primary" id="sheetImport" disabled>导入表格</button></label>
      </div>
      <p class="small muted" id="sheetInfo"></p>
    </details>
    <details class="box section"><summary><b>从 PGC 导入最新审核结果</b></summary>
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
      const r = await api("POST", "tag");
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
  const s = (state.settings = await api("GET", "settings"));
  if (!alive()) return;
  view.innerHTML = `<form id="setForm">
    <div class="box section forge-model-notice"><div class="section-label"><span>审核模型</span><span class="small-tag">ADMIN ONLY</span></div>
      <h2>${esc(state.info?.model || "未配置")}</h2>
      <p class="muted small">选题扩写、简报、标签和模拟审核统一使用管理员在 <a href="/admin">/admin</a> 配置的模型。Forge 不再重复保存模型地址或密钥。</p>
      <p class="small ${state.info?.providers?.[state.info?.provider] ? "good" : "bad"}">${state.info?.providers?.[state.info?.provider] ? "模型已启用" : "尚未配置可用模型，请先到 /admin 保存并启用"}</p>
    </div>
    <div class="box section"><h2>选题工作流</h2>
      <div class="locks">
        <label class="field">每次抽几个<input type="number" name="draw_size" min="1" max="40"></label>
        <label class="field">每次 AI 调用扩写几个<input type="number" name="expand_batch" min="1" max="2"></label>
      </div>
    </div>
    <div class="box section"><h2>选题规律与雷区</h2>
      <p class="muted small">扩写和简报都会读这段。收到新的审核意见后，把新规律补进来。</p>
      <textarea name="redlines" style="min-height:280px"></textarea></div>
    <div class="box section"><h2>制作模板（固定部分 A–G）</h2>
      <p class="muted small">简报 = 这段 + AI 填好的 F 部分。</p>
      <textarea name="template" style="min-height:320px"></textarea></div>
    <div class="box section"><h2>F 部分骨架</h2><textarea name="template_f" style="min-height:240px"></textarea></div>
    <div class="row section"><button class="primary">保存设置</button>
      <button type="button" class="ghost" id="exportBtn">导出全部数据（备份）</button>
      <button type="button" class="ghost" id="logoutBtn">在这台设备上退出</button></div>
  </form>`;
  const form = $("#setForm");
  for (const [k, v] of Object.entries(s)) if (form.elements[k]) form.elements[k].value = v;
  form.onsubmit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    guard(e.submitter, async () => {
      state.settings = await api("PUT", "settings", data);
      await refreshStatus();
      toast("设置已保存");
      const y = scrollY;
      await renderSettings(() => true);
      scrollTo(0, y);
    });
  };
  $("#exportBtn").onclick = (e) => guard(e.target, async () => {
    const data = await api("GET", "export");
    download(`pgc-forge-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
  });
  $("#logoutBtn").onclick = async () => { try { await withProgress('退出登录', () => fetch('/api/admin/logout', { method: 'POST' })); } finally { location.assign('/admin'); } };
}

// ---------- boot ----------

async function boot() {
  try {
    if (!memberOnly) {
      await refreshStatus();
      state.settings = await api("GET", "settings");
    }
    render();
  } catch (e) {
    if (!$("#login").hidden) return;
    view.innerHTML = `<div class="box bad">${esc(e.message)}</div>`;
  }
}

withProgress("连接创作工作台", boot);
