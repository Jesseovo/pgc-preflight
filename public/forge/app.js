// PGC Forge front end. Vanilla JS, no build step.

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
  const res = await fetch("/api/forge/" + path, {
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

async function guard(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 4200);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openModal(title, html) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  $("#modal").hidden = false;
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
  fn(alive).catch((e) => { if (alive()) view.innerHTML = `<div class="box bad">${esc(e.message)}</div>`; });
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
      <div class="body">${chipsHtml(t)}<div class="small">${t._error ? `<span class="bad">${esc(t._error)}</span>` : "AI 扩写中…"}</div></div>
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
  acts.push(`<button class="${mode === "picks" ? "primary" : "ghost"}" data-act="brief">${t.has_brief ? "看简报" : "生成简报"}</button>`);
  return `<article class="card state-${t.status}" data-id="${t.id}">
    <div class="art" style="${artStyle(d)}"><div class="title">${esc(d.title)}</div><div class="score" title="预估 美学/易玩性/可玩性">${esc(sc)}</div></div>
    <div class="body">
      ${chipsHtml(t)}
      <div>${esc(d.logline)}</div>
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
    await guard(btn, async () => {
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
          toast("正在画样板图，约 30–60 秒…", 60000);
          svg = (await api("POST", `topics/${id}/preview`)).svg;
          t.has_preview = 1;
          toast("样板图好了");
          rerender();
        }
        showPreview(t, svg);
      } else if (act === "brief") {
        let md;
        if (t.has_brief) md = (await api("GET", `topics/${id}`)).brief_md;
        else {
          toast("正在写简报，约 1–2 分钟…", 120000);
          md = (await api("POST", `topics/${id}/brief`)).brief;
          t.has_brief = 1;
          if (t.status !== "made") t.status = "liked";
          toast("简报好了");
          rerender();
        }
        showBrief(t, md);
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
}

function showPreview(t, svg) {
  const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  openModal(`${t.data.title} · 风格样板`, `<img class="preview" style="max-width:360px;margin:0 auto" src="${src}" alt="">
    <div class="row" style="margin-top:10px"><button class="ghost" id="dlSvg">下载 SVG</button>
    <button class="ghost" id="regenSvg">重新生成</button></div>`);
  $("#dlSvg").onclick = () => download(`${t.data.title}.svg`, svg, "image/svg+xml");
  $("#regenSvg").onclick = (e) => guard(e.target, async () => {
    toast("重新生成中…", 60000);
    const r = await api("POST", `topics/${t.id}/preview`);
    showPreview(t, r.svg);
  });
}

function showBrief(t, md) {
  openModal(`${t.data.title} · 制作简报`, `<p class="muted small">整段复制给 Claude Code（或任何能写代码的模型）即可开工。</p>
    <div class="row" style="margin-bottom:8px"><button class="primary" id="cpBrief">复制简报</button>
    <button class="ghost" id="dlBrief">下载 .md</button><button class="ghost" id="regenBrief">重新生成</button></div>
    <pre class="md">${esc(md)}</pre>`);
  $("#cpBrief").onclick = () => copyText(md);
  $("#dlBrief").onclick = () => download(`${t.data.title}-brief.md`, md);
  $("#regenBrief").onclick = (e) => guard(e.target, async () => {
    toast("重新生成中…", 120000);
    const r = await api("POST", `topics/${t.id}/brief`);
    showBrief(t, r.brief);
  });
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
  toast(`AI 正在想新的${DIM_LABEL[dim]}，约 30 秒…`, 60000);
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

async function expandIds(ids) {
  // Keep model calls small enough for the slower Opus gateway. DeepSeek can
  // run two combos per call; Opus is deliberately one combo per call and
  // serialized to avoid a burst of gateway timeouts and rate-limit responses.
  const slowModel = /opus|claude/i.test(String(state.info?.model || ""));
  const size = slowModel ? 1 : Math.min(2, Math.max(1, Number(state.settings?.expand_batch) || 2));
  const chunks = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  let done = 0;
  const prog = () => {
    const p = $("#progress");
    if (!p) return;
    if (done >= chunks.length) { p.textContent = ""; return; }
    p.textContent = slowModel
      ? `Opus 扩写中 ${done}/${chunks.length} 批（每批约 1–3 分钟）…`
      : `AI 扩写中 ${done}/${chunks.length} 批…`;
  };
  prog();
  for (const id of ids) { const t = state.drawn.find((x) => x.id === id); if (t) { t._inflight = true; delete t._error; } }
  paintDrawn();
  const recover = async (chunk, maxWaitMs = 10000) => {
    // A proxy can drop the browser response after the Worker has finished
    // writing D1. A 409 from the relay means the same idempotent request is
    // still running; keep reading D1 instead of starting a duplicate call.
    const deadline = Date.now() + maxWaitMs;
    let first = true;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, first ? 1200 : 3500));
      first = false;
      const recovered = [];
      for (const id of chunk) {
        try {
          const topic = await api("GET", `topics/${id}`);
          if (topic?.data?.title) recovered.push(topic);
        } catch {}
      }
      if (recovered.length === chunk.length) return recovered;
    }
    return null;
  };
  const expandChunk = async (chunk) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await api("POST", "expand", { ids: chunk }); }
      catch (e) {
        const message = String(e?.message || e);
        if (!/超时|timeout|409|429|5\d\d|网络|failed to fetch|fetch failed|network/i.test(message)) throw e;
        const recovered = await recover(chunk, /409|正在处理/i.test(message) ? 90000 : 10000);
        if (recovered) return recovered;
        if (attempt) throw e;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    throw new Error("扩写未完成");
  };
  const worker = async () => {
    while (chunks.length) {
      const chunk = chunks.shift();
      try {
        const updated = await expandChunk(chunk);
        for (const u of updated) {
          const i = state.drawn.findIndex((x) => x.id === u.id);
          if (i >= 0) state.drawn[i] = u;
        }
      } catch (e) {
        for (const id of chunk) { const t = state.drawn.find((x) => x.id === id); if (t) { t._error = e.message; t._inflight = false; } }
      }
      done++;
      prog();
      paintDrawn();
    }
  };
  const total = chunks.length;
  await Promise.all(Array.from({ length: slowModel ? 1 : Math.min(2, total) }, worker));
  done = total;
  prog();
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

const FRAMES = [
  { ratio: "9:16", w: 360, h: 640 },
  { ratio: "9:19.5", w: 360, h: 780 },
  { ratio: "9:21", w: 360, h: 840 },
];
const START_PAGE_RE = /tap to (start|play|begin)|click to (start|play)|press (start|any)|start game|play now|开始游戏|点击开始/i;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Probe messages come back from sandboxed frames; match them by window.
const probeFrames = new Map();
addEventListener("message", (e) => {
  const f = probeFrames.get(e.source);
  const m = e.data;
  if (!f || !m || !m.__forge) return;
  if (m.type === "ready") f.onReady();
  else if (m.type === "reply" && f.pending.has(m.data.id)) {
    f.pending.get(m.data.id)(m.data);
    f.pending.delete(m.data.id);
  }
});

function ask(f, cmd, ms = 8000) {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    f.pending.set(id, resolve);
    f.win.postMessage({ __forge: true, cmd, id }, "*");
    setTimeout(() => { if (f.pending.delete(id)) resolve(null); }, ms);
  });
}

function injectProbe(html, probeSrc) {
  const tag = "<script>" + probeSrc.replace(/<\/script/gi, "<\\/script") + "</script>";
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + tag);
  return tag + html;
}

// Runs the game in three phone frames and collects everything a reviewer would notice.
async function probeGame(html, box, log) {
  state.probeSrc ||= await (await fetch(new URL("probe.js", import.meta.url))).text();
  const doc = injectProbe(html, state.probeSrc);
  // All three phones must stay on screen: browsers pause animation in
  // sandboxed frames that are scrolled out of view.
  const k = Math.max(0.2, Math.min(0.5, (box.clientWidth - 2 * 8 - 3 * 4) / (3 * 360)));
  box.innerHTML = FRAMES.map((f, i) => `<div class="phone"><div class="screen" style="width:${360 * k}px;height:${f.h * k}px"><iframe data-i="${i}" sandbox="allow-scripts" style="height:${f.h}px;transform:scale(${k})" title="${f.ratio}"></iframe></div><div class="cap">${f.ratio}</div></div>`).join("");
  box.scrollIntoView({ block: "nearest" });
  let wasHidden = document.hidden;
  const onVis = () => { if (document.hidden) wasHidden = true; };
  document.addEventListener("visibilitychange", onVis);
  const frames = FRAMES.map((spec, i) => {
    const el = box.querySelector(`iframe[data-i="${i}"]`);
    const f = { spec, el, pending: new Map() };
    f.ready = new Promise((r) => (f.onReady = r));
    el.srcdoc = doc;
    f.win = el.contentWindow;
    probeFrames.set(f.win, f);
    return f;
  });
  try {
    log("等待游戏加载…");
    const loaded = await Promise.all(frames.map((f) => Promise.race([f.ready.then(() => true), wait(8000).then(() => false)])));
    await wait(1500);
    const shots = [];
    const snapAll = async (label) => {
      const out = {};
      for (const f of frames) {
        const r = await ask(f, "snap");
        out[f.spec.ratio] = r;
        if (r && r.img) shots.push({ label: `${f.spec.ratio} ${label}`, data: r.img, ratio: f.spec.ratio, when: label });
      }
      return out;
    };
    log("截取开局前画面…");
    const before = await snapAll("开局前");
    const readyReports = (await Promise.all(frames.map((f) => ask(f, "report")))).map((r) => r && r.report);
    log("模拟第一次触摸…");
    frames.forEach((f) => ask(f, "tap", 500));
    await wait(3000);
    log("开局后 3 秒…");
    const mid = await ask(frames[1], "snap");
    if (mid && mid.img) shots.push({ label: "9:19.5 开局后 3 秒", data: mid.img, ratio: "9:19.5", when: "开局后 3 秒" });
    await wait(7000);
    log("开局后 10 秒…");
    const after = await snapAll("开局后 10 秒");
    const reports = (await Promise.all(frames.map((f) => ask(f, "report")))).map((r) => r && r.report);
    log("偷懒策略机器人试玩…");
    const bots = await ask(frames[0], "bots", 30000);
    const main = reports[1] || reports[0] || {};
    const errors = [...new Set(reports.flatMap((r) => (r ? r.errors : [])))];
    const probe = {
      loaded: Object.fromEntries(frames.map((f, i) => [f.spec.ratio, loaded[i]])),
      layout: Object.fromEntries(frames.map((f) => [f.spec.ratio, {
        ...(after[f.spec.ratio] && after[f.spec.ratio].layout),
        flatBandsBefore: before[f.spec.ratio] && before[f.spec.ratio].bands,
        flatBandsAfter: after[f.spec.ratio] && after[f.spec.ratio].bands,
      }])),
      errors,
      probeNotes: [...new Set(reports.flatMap((r) => (r ? r.probeNotes || [] : [])))],
      audio: { contexts: main.audioContexts, sourceStarts: main.audioStarts, startsLaterThan1_5s: main.audioStartsLater, spanSec: main.audioSpanSec, halfSecondSlotsWithAudio_1to9s: main.audioSlots },
      startPageSuspect: readyReports.some((r) => r && START_PAGE_RE.test(r.domText || "")),
      cjkVisible: reports.some((r) => r && r.cjkVisible),
      hasGameHook: !!main.hasGAME,
      lazyBots: bots && bots.bots,
      pageWasHidden: wasHidden,
      note: "截图和触摸都是脚本模拟的：开局时在屏幕中下方点一次，之后不再操作，所以「开局后 10 秒」可能已经是失败画面，这本身不算问题。flatBands 是顶部/底部 5% 区域里单一颜色的占比，接近 1 可能是黑边，也可能只是纯色背景或结算面板。音频启动次数只是 BGM 的间接证据（一条长循环音轨只会启动 1 次）。",
    };
    return { probe, shots };
  } finally {
    document.removeEventListener("visibilitychange", onVis);
    frames.forEach((f) => probeFrames.delete(f.win));
  }
}

// Plain-language checklist from the probe numbers.
function probeChecks(p) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  if (p.pageWasHidden) add("bad", "体检过程中页面被切到了后台，游戏会被浏览器暂停，下面的结果不可信。请保持页面在前台重跑一次");
  const notLoaded = Object.entries(p.loaded).filter(([, v]) => !v).map(([k]) => k);
  if (notLoaded.length) add("bad", `页面没有正常加载完成（${notLoaded.join("、")}）`);
  if (p.errors.length) add("bad", `运行时报错 ${p.errors.length} 条：${p.errors.slice(0, 2).join("；")}`);
  else add("ok", "运行 10 秒没有报错");
  const bars = Object.entries(p.layout).filter(([, l]) => !l.canvas || l.coverW < 0.98 || l.coverH < 0.98);
  // A band that is flat both before and after the first tap is likely a letterbox the game draws itself.
  const flat = (b) => b && (b.top > 0.97 || b.bottom > 0.97);
  const bands = Object.entries(p.layout).filter(([, l]) => l.canvas && flat(l.flatBandsBefore) && flat(l.flatBandsAfter));
  if (bars.length) add("bad", `画布没有铺满屏幕：${bars.map(([k, l]) => `${k}（覆盖 ${Math.round((l.coverW || 0) * 100)}%×${Math.round((l.coverH || 0) * 100)}%）`).join("、")}`);
  else if (bands.length) add("warn", `画布铺满了，但 ${bands.map(([k]) => k).join("、")} 的顶部或底部始终是一整条纯色，可能是游戏自己画的黑边，看截图确认`);
  else add("ok", "三种比例都铺满屏幕");
  if (p.startPageSuspect) add("bad", "开局前的页面文字像开始页（Tap to Start 之类）");
  const a = p.audio;
  if (!a.contexts) add("bad", "没有创建 AudioContext：没有任何声音");
  else if (a.halfSecondSlotsWithAudio_1to9s >= 5) add("ok", `开局后 1–9 秒里有 ${a.halfSecondSlotsWithAudio_1to9s} 个半秒时段在出声，大概率有 BGM`);
  else add("warn", `开局后 1–9 秒里只有 ${a.halfSecondSlotsWithAudio_1to9s || 0} 个半秒时段在出声，可能没有 BGM（如果 BGM 是单条长循环音轨，这条可以忽略）`);
  if (p.cjkVisible) add("warn", "页面上有中文文字（平台面向海外，要求全英文）");
  if (!p.hasGameHook) add("warn", "没有 window.GAME 测试接口，跳过了偷懒策略测试");
  else if (p.lazyBots) {
    for (const [name, r] of Object.entries(p.lazyBots)) {
      const label = { idle: "完全不操作", tapSpam: "一直乱点" }[name] || name;
      if (r.error) add("warn", `${label} 测试出错：${r.error}`);
      else if (r.survivedSec >= r.limitSec) add("bad", `${label} 坚持了 ${r.limitSec} 秒都没死，缺少失败压力`);
      else add("ok", `${label} 在 ${r.survivedSec} 秒失败`);
    }
  }
  return out;
}

function checksHtml(checks) {
  const mark = { ok: "✅", warn: "⚠️", bad: "❌" };
  return `<ul class="checks">${checks.map((c) => `<li><span class="mark">${mark[c.level]}</span><span>${esc(c.text)}</span></li>`).join("")}</ul>`;
}

function reviewHtml(r) {
  const x = r.result;
  const shots = (r.shots || []).map((s) => `<figure><img src="${esc(s.data)}" alt=""><figcaption>${esc(s.label)}</figcaption></figure>`).join("");
  return `<div class="box section">
    <div class="verdict"><div class="bigscore">${esc(r.score)}<small> / 9</small></div>
      <div><div><b>美学 ${esc(x.aes)} · 易玩性 ${esc(x.ease)} · 可玩性 ${esc(x.play)}</b></div>
      <span class="pill ${r.score >= 7 ? "approved" : "rejected"}">${esc(x.verdict)}</span> <span class="small muted">${esc(r.title)} · ${esc(String(r.created_at).slice(0, 16).replace("T", " "))}</span></div></div>
    <p class="quote">${esc(x.reviewer_comment)}</p>
    ${x.strengths && x.strengths.length ? `<p class="small"><b>亮点：</b>${x.strengths.map(esc).join("；")}</p>` : ""}
    <h3>问题清单</h3>
    ${(x.issues || []).map((i) => `<div class="issue"><span class="sev sev-${esc(i.severity)}">${esc(i.severity)}</span><b>${esc(i.area)}</b>：${esc(i.problem)}
      <div class="small muted">证据：${esc(i.evidence)}</div><div class="small">改法：${esc(i.fix)}</div></div>`).join("") || `<p class="muted">没有发现问题。</p>`}
    <div class="row" style="margin:12px 0 6px"><h3 class="grow">修改提示词</h3><button class="primary" data-copy-fix>复制</button></div>
    <pre class="md">${esc(x.fix_prompt)}</pre>
    ${r.probe ? `<details><summary>自动体检</summary>${checksHtml(probeChecks(r.probe))}</details>` : ""}
    ${shots ? `<h3 style="margin-top:12px">截图</h3><div class="shots">${shots}</div>` : ""}
  </div>`;
}

async function renderReview(alive) {
  const [history, topics] = memberOnly
    ? [await api("GET", "reviews"), []]
    : await Promise.all([api("GET", "reviews"), api("GET", "topics?status=liked,made&limit=200")]);
  if (!alive()) return;
  view.innerHTML = `<section class="review-intro"><div><div class="eyebrow"><span></span>GAME CHECK, BEFORE YOU SHIP</div><h1>上传前，先过一遍<span>。</span></h1><p>把基础问题留在提交前，把时间留给好游戏。</p></div><div class="review-cat-note" aria-hidden="true">✦<br><b>AI<br>PREVIEW</b></div></section>
    <section class="review-workspace">
      <div class="review-upload-panel">
        <div class="section-label"><span><i class="step-number">01</i>添加游戏</span><b>支持单个 HTML</b></div>
        <div class="review-dropzone" id="rvDropzone">
          <div class="review-file-illustration" aria-hidden="true"><div class="review-monitor"><span></span><span></span><span></span></div><div class="review-check">✓</div></div>
          <h2>把游戏拖到这里</h2>
          <p>一次放入一个 HTML，接下来交给我们</p>
          <button type="button" class="primary-button" id="rvChoose"><span class="review-plus">＋</span>选择游戏文件</button>
          <input type="file" id="rvFile" accept=".html,.htm,text/html" hidden>
          <div class="upload-meta"><span>.html / .htm</span><span>单个 ≤ 8 MB</span><span>AI 模拟审核</span></div>
          <div class="review-file-name" id="rvFileName">还未选择文件</div>
        </div>
        <div class="review-fields">
          <label class="field">游戏名<input type="text" id="rvTitle" placeholder="自动读取 HTML title"></label>
          <label class="field">对应的选题（可选）<select id="rvTopic"><option value="">不关联</option>${topics.map((t) => `<option value="${t.id}">${esc(t.data.title)}</option>`).join("")}</select></label>
        </div>
        <div class="review-action-row"><span class="progress" id="rvLog"></span><button type="button" class="primary-button" id="rvGo" disabled>开始审核</button></div>
      </div>
      <aside class="review-scope-panel"><div class="section-label"><span><i class="step-number">02</i>我们会检查</span><span class="small-tag">BASIC</span></div>
        <div class="scope-items"><div class="scope-item"><div class="scope-icon">▣</div><div><h3>打开与加载</h3><p>白屏、缺失资源、加载异常</p></div></div><div class="scope-item"><div class="scope-icon">⌁</div><div><h3>开始与操作</h3><p>能否进入，输入是否有响应</p></div></div><div class="scope-item"><div class="scope-icon">▯</div><div><h3>手机显示</h3><p>关键文字、按钮是否明显出界</p></div></div><div class="scope-item"><div class="scope-icon">↻</div><div><h3>基础流程</h3><p>是否能到达结算与重试</p></div></div></div>
        <div class="human-note"><span class="review-human-icon">♧</span><p><b>手感、美感、好不好玩</b><br>留给人工审核判断</p></div>
      </aside>
    </section>
    <section class="review-live" id="rvLive"><div class="progress" id="rvLiveHint">上传 HTML 后，体检结果会显示在这里。</div><div class="phones" id="rvPhones"></div><div id="rvChecks"></div></section>
    <div id="rvResult"></div>
    <section class="review-history"><div class="results-heading"><div><h2>审核记录 <span>${history.length}</span></h2><p>点击一条记录查看完整报告</p></div></div>
      ${history.length ? `<table><tbody>${history.map((h) => `<tr data-rid="${h.id}" style="cursor:pointer"><td><b>${esc(h.title)}</b></td><td>${esc(h.score)}/9</td><td><span class="pill ${h.score >= 7 ? "approved" : "rejected"}">${esc(h.verdict)}</span></td><td class="small muted">${esc(String(h.created_at).slice(0, 16).replace("T", " "))}</td></tr>`).join("")}</tbody></table>` : `<p class="muted small">还没有记录。</p>`}
    </section>`;
  let html = "";
  const acceptFile = async (file) => {
    if (!file) return;
    html = await file.text();
    const t = /<title>([^<]*)<\/title>/i.exec(html);
    $("#rvTitle").value = (t && t[1].trim()) || file.name.replace(/\.html?$/i, "");
    $("#rvFileName").textContent = file.name;
    $("#rvDropzone").classList.add("has-file");
    $("#rvGo").disabled = false;
  };
  $("#rvChoose").onclick = () => $("#rvFile").click();
  $("#rvFile").onchange = async (e) => acceptFile(e.target.files[0]);
  $("#rvDropzone").ondragover = (e) => { e.preventDefault(); $("#rvDropzone").classList.add("drag-over"); };
  $("#rvDropzone").ondragleave = () => $("#rvDropzone").classList.remove("drag-over");
  $("#rvDropzone").ondrop = async (e) => { e.preventDefault(); $("#rvDropzone").classList.remove("drag-over"); await acceptFile(e.dataTransfer.files[0]); };
  const showResult = (r) => {
    $("#rvResult").innerHTML = reviewHtml(r);
    $("#rvResult [data-copy-fix]").onclick = () => copyText(r.result.fix_prompt);
    $("#rvResult").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("#rvGo").onclick = (e) => guard(e.target, async () => {
    const log = (s) => ($("#rvLog").textContent = s);
    $("#rvChecks").innerHTML = "";
    $("#rvResult").innerHTML = "";
    const { probe, shots } = await probeGame(html, $("#rvPhones"), log);
    $("#rvChecks").innerHTML = `<h3 style="margin:12px 0 6px">自动体检</h3>` + checksHtml(probeChecks(probe));
    if (probe.pageWasHidden) return log("页面在体检时被切到了后台，已跳过 AI 审核。保持页面在前台，再点一次开始审核。");
    log("AI 审核中，约 1–2 分钟…");
    const pick = (ratio, when) => shots.find((s) => s.ratio === ratio && s.when === when);
    const send = [pick("9:19.5", "开局前"), pick("9:19.5", "开局后 3 秒"), pick("9:16", "开局后 10 秒"), pick("9:21", "开局后 10 秒")]
      .filter(Boolean).map(({ label, data }) => ({ label, data }));
    try {
      const r = await api("POST", "review", { title: $("#rvTitle").value.trim(), topic_id: Number($("#rvTopic").value) || null, html, probe, shots: send });
      log("");
      showResult(r);
    } catch (err) {
      log("AI 审核失败：" + err.message + "（上面的自动体检结果仍然有效）");
      throw err;
    }
  });
  view.querySelector("tbody")?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-rid]");
    if (tr) guard(null, async () => showResult(await api("GET", `reviews/${tr.dataset.rid}`)));
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
  view.innerHTML = `<details class="box section"><summary><b>从 PGC 导入最新审核结果</b></summary>
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
  $("#cpSnippet").onclick = () => copyText(EXPORT_SNIPPET);
  $("#importBtn").onclick = (e) => guard(e.target, async () => {
    let data;
    try { data = JSON.parse($("#importBox").value); } catch { throw new Error("粘贴的内容不是合法 JSON"); }
    const r = await api("POST", "import", data);
    toast(`新增 ${r.inserted}，更新 ${r.updated}，${r.untagged} 个待打标签`, 5000);
    await refreshStatus();
    render();
  });
  $("#tagBtn").onclick = (e) => guard(e.target, async () => {
    let left = untagged;
    while (left > 0) {
      toast(`AI 打标签中，还剩 ${left} 个…`, 60000);
      const r = await api("POST", "tag");
      if (!r.tagged) break;
      left = r.remaining;
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
  $("#logoutBtn").onclick = async () => { try { await fetch('/api/admin/logout', { method: 'POST' }); } finally { location.assign('/admin'); } };
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

boot();
