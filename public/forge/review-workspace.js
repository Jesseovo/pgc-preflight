import { startTask, withProgress, progressHtml } from './progress.js';
// Shared by the member workspace and the administrator's review tab.
const LIMIT = 20;
const MAX_BYTES = 8 * 1024 * 1024;
const jobs = [];
let selected = '';
let concurrency = 3;
let started = false;
let preparing = false;
let adding = Promise.resolve();
let refresh = () => {};
let dependencies;
const polls = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const labels = { staged: '待开始', waiting: '等待采集', probing: '采集画面', submitting: '提交中', queued: '等待模型', running: 'AI 评分中', done: '已完成', error: '未完成' };
const active = job => ['probing', 'submitting', 'queued', 'running'].includes(job.status);
const pending = job => !['done', 'error'].includes(job.status);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const date = value => { const time = new Date(value); return Number.isNaN(time.valueOf()) ? '' : time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };
const safeImage = data => typeof data === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(data) ? data : '';
const arr = value => Array.isArray(value) ? value : [];
const icon = name => ({ file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13l-2 2 2 2m8-4 2 2-2 2m-3-5-2 8"/>', upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>', arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/>', check: '<path d="m5 12 4 4L19 6"/>', download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>', retry: '<path d="M3 11a9 9 0 1 1 2 7M3 3v8h8"/>', sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>' }[name] || '');
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon(name)}</svg>`;

export function reportText(report) {
  const x = report.result || {};
  return `# ${report.title} · AI 模拟审核\n\n总分 ${report.score}/9 · ${x.verdict || ''}\n美学 ${x.aes}/3 · 易玩性 ${x.ease}/3 · 可玩性 ${x.play}/3\n\n${x.reviewer_comment || ''}\n\n## 亮点\n${arr(x.strengths).map(t => `- ${t}`).join('\n')}\n\n## 优先修改\n${arr(x.issues).map((i, n) => `${n + 1}. [${i.severity}] ${i.area}：${i.problem}\n   证据：${i.evidence}\n   建议：${i.fix}`).join('\n\n')}\n\n## 交给 Agent 修改\n${x.fix_prompt || ''}\n\n这是 AI 模拟评分，最终结果由人工确认。\n`;
}

export function reviewHtml(report) {
  const x = report.result || {};
  const passed = report.score >= 7;
  const issues = arr(x.issues).slice().sort((a, b) => (['高', '中', '低'].indexOf(a.severity) + 1 || 4) - (['高', '中', '低'].indexOf(b.severity) + 1 || 4));
  const shots = arr(report.shots).filter(s => safeImage(s.data));
  return `<article class="review-report" aria-label="${esc(report.title)}的审核报告">
    <header class="rr-header"><div><span class="rr-kicker">THE REVIEW / AI 模拟报告</span><h2>${esc(report.title)}</h2><div class="rr-meta"><span class="rr-verdict ${passed ? 'is-pass' : 'is-revise'}">${svg(passed ? 'check' : 'retry')}${passed ? '模拟通过' : '建议修改'}</span><time>${esc(date(report.created_at))}</time></div></div><div class="rr-total"><strong>${esc(report.score)}</strong><span>/ 9</span><small>通过线 7 分</small></div></header>
    <div class="rr-scores">${[['aes', '美学', '视觉与风格'], ['ease', '易玩性', '规则与操作'], ['play', '可玩性', '机制与挑战']].map(([k, title, caption], index) => `<section><span class="rr-score-label"><i>0${index + 1}</i>${title}</span><div class="rr-score-value"><b>${esc(x[k])}<small> / 3</small></b><span class="rr-segments" aria-hidden="true">${[1, 2, 3].map(n => `<i class="${n <= Number(x[k]) ? 'filled' : ''}"></i>`).join('')}</span></div><p>${caption}</p></section>`).join('')}</div>
    <section class="rr-comment"><span>${svg('sparkle')}审核意见</span><p>${esc(x.reviewer_comment)}</p>${x.verdict ? `<small>模型结论 · ${esc(x.verdict)}</small>` : ''}</section>
    ${arr(x.strengths).length ? `<section class="rr-strengths"><h3>值得保留</h3><ul>${x.strengths.map(s => `<li>${svg('check')}<span>${esc(s)}</span></li>`).join('')}</ul></section>` : ''}
    <section class="rr-issues"><div class="rr-section-heading"><h3>优先修改 <span>${issues.length.toString().padStart(2, '0')}</span></h3><small>从影响最大的地方开始</small></div>${issues.map((issue, i) => `<article class="rr-issue"><div class="rr-issue-number">${String(i + 1).padStart(2, '0')}</div><div class="rr-issue-body"><div class="rr-issue-title"><span class="rr-severity ${issue.severity === '高' ? 'high' : issue.severity === '中' ? 'medium' : 'low'}">${esc(issue.severity)}优先级</span><h4>${esc(issue.area)}</h4></div><p>${esc(issue.problem)}</p><dl><div><dt>观察证据</dt><dd>${esc(issue.evidence)}</dd></div><div><dt>建议改法</dt><dd>${esc(issue.fix)}</dd></div></dl></div></article>`).join('') || '<p class="rr-empty-note">本次模拟未提出需要修改的问题。</p>'}</section>
    <section class="rr-agent"><div class="rr-section-heading"><div><span class="rr-kicker">NEXT STEP</span><h3>把修改，交给 Agent。</h3></div><button type="button" class="rr-button rr-button-dark" data-copy-fix>${svg('copy')}复制修改指令</button></div><p>复制下面这段，交给制作游戏的 AI 继续完善。</p><details><summary>展开完整修改指令 <span>↗</span></summary><pre>${esc(x.fix_prompt || '本次没有生成修改指令。')}</pre></details></section>
    ${shots.length ? `<section class="rr-evidence"><div class="rr-section-heading"><h3>画面证据 <span>${String(shots.length).padStart(2, '0')}</span></h3><small>点击查看原图</small></div><div class="rr-shot-grid">${shots.map((shot, i) => `<button type="button" class="rr-shot" data-shot="${i}"><span><img src="${esc(shot.data)}" alt="${esc(shot.label)}" loading="lazy"></span><b>${esc(shot.label)}</b></button>`).join('')}</div></section>` : ''}
    ${report.probe ? '<details class="rr-diagnostics"><summary>查看运行采集记录</summary><div data-report-checks></div></details>' : ''}
    <footer class="rr-footer"><span>AI 模拟评分 · 人工最终确认</span><div><button type="button" class="rr-button" data-copy-report>${svg('copy')}复制报告</button><button type="button" class="rr-button" data-download-report>${svg('download')}下载 .md</button></div></footer>
  </article>`;
}

async function pollJob(job) {
  if (polls.has(job.requestId)) return;
  const requestId = job.requestId;
  let missing = 0;
  polls.add(requestId);
  try {
    while (job.requestId === requestId && ['queued', 'running', 'submitting'].includes(job.status)) {
      try {
        const remote = await dependencies.api('GET', `review/jobs/${requestId}`);
        missing = 0;
        if (remote.status === 'done') {
          job.result = await dependencies.api('GET', `reviews/${remote.result_id}`);
        }
        job.status = remote.status;
        job.error = remote.error;
        job.remoteFailed = remote.status === 'error';
        job.note = remote.status === 'running' ? '模型正在结合画面、源码与校准样本评分' : '后台排队中，可继续添加游戏';
        if (remote.status === 'done') {
          job.note = '报告已生成';
          job.html = null;
          job.file = null;
          job.prepared = null;
          if (!jobs.find(item => item.id === selected)?.result) selected = job.id;
          void dependencies.updateHistory?.();
        }
        if (job.status === 'done') job.progress?.done('审核报告已生成');
        if (job.status === 'error') job.progress?.fail(job.error || '审核未完成，请重试。');
        refresh();
        if (['done', 'error'].includes(job.status)) break;
      } catch (error) {
        if (error.status === 404 && ++missing >= 3) {
          job.status = 'error'; job.error = '后台没有找到这次任务，请重试提交。'; job.remoteFailed = true; job.progress?.fail(job.error);
          refresh(); break;
        }
        // A transient poll failure must never resubmit a model request.
        job.note = '正在重新连接后台，任务会继续运行';
        refresh();
      }
      await pause(3500);
    }
  } finally {
    polls.delete(requestId);
    void pump();
  }
}

async function submit(job) {
  job.status = 'submitting';
  job.note = '正在提交游戏源码和截图…';
  job.requestId ||= crypto.randomUUID();
  refresh();
  try {
    const result = await dependencies.api('POST', 'review/jobs', { ...job.prepared, html: job.html, title: job.title, topic_id: job.topicId || null, request_id: job.requestId });
    job.status = result.status === 'error' ? 'error' : 'queued';
    if (result.status === 'error') { job.error = result.error; job.remoteFailed = true; }
    job.note = '后台已接收，等待模型评分';
    void pollJob(job);
  } catch (error) {
    // Check the idempotent job before offering retry if the enqueue response
    // was lost. Clicking retry later also uses this ID until failure is known.
    try {
      const result = await dependencies.api('GET', `review/jobs/${job.requestId}`);
      job.status = result.status === 'error' ? 'error' : 'queued';
      if (result.status === 'error') { job.error = result.error; job.remoteFailed = true; }
      else void pollJob(job);
    } catch { job.status = 'error'; job.error = error.message; }
  }
  if (job.status === 'error') job.progress?.fail(job.error);
  refresh();
}

async function pump() {
  if (!started || preparing || !dependencies) return;
  preparing = true;
  try {
    while (activeCount() < concurrency) {
      const job = jobs.find(item => item.status === 'waiting');
      if (!job) break;
      job.startedAt ||= Date.now();
      job.progress ||= startTask(`AI 审核 · ${job.title}`, {detail:'准备采集游戏画面…',startedAt:job.startedAt});
      try {
        if (!job.prepared) {
          job.status = 'probing';
          refresh();
          dependencies.setProbing(true);
          const { probe, shots } = await dependencies.probeGame(job.html, dependencies.captureBox(), (message, value, total) => { job.note = message; job.captureProgress = {value,total}; refresh(); });
          if (probe.pageWasHidden) throw new Error('采集时页面进入了后台，请保持页面在前台后重试。');
          const pick = (ratio, when) => shots.find(shot => shot.ratio === ratio && shot.when === when);
          job.prepared = { probe, shots: [pick('9:19.5', '开局前'), pick('9:19.5', '开局后 3 秒'), pick('9:16', '开局后 10 秒'), pick('9:21', '开局后 10 秒')].filter(Boolean).map(({ label, data }) => ({ label, data })) };
        }
        dependencies.setProbing(false);
        dependencies.clearCapture();
        await submit(job);
      } catch (error) {
        job.status = 'error';
        job.error = error.message;
        job.progress?.fail(job.error);
        dependencies.setProbing(false);
        dependencies.clearCapture();
        refresh();
      }
    }
  } finally { preparing = false; }
}
const activeCount = () => jobs.filter(active).length;

let dragDepth = 0;
document.addEventListener('dragenter', event => {
  if (dependencies?.isActive() && event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; dependencies.highlight(true); }
});
document.addEventListener('dragover', event => {
  if (dependencies?.isActive() && event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
});
document.addEventListener('dragleave', event => {
  if (dependencies?.isActive() && --dragDepth <= 0) { dragDepth = 0; dependencies.highlight(false); }
});
document.addEventListener('drop', event => {
  if (!dependencies?.isActive() || !event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth = 0;
  dependencies.highlight(false);
  void addFiles([...event.dataTransfer.files]);
});
addEventListener('beforeunload', event => {
  if (jobs.some(job => ['staged', 'waiting', 'probing', 'submitting'].includes(job.status))) { event.preventDefault(); event.returnValue = ''; }
});

function addFiles(files) {
  adding = adding.then(() => withProgress('读取游戏文件', async progress => {
    const rejected = [];
    let added = 0;
    progress.update({value:0,total:files.length});
    for (const [index,file] of files.entries()) {
      progress.update({value:index,total:files.length,detail:`读取 ${file.name} · ${index+1}/${files.length}`});
      if (!/\.html?$/i.test(file.name)) { rejected.push(`${file.name}：只支持 HTML`); continue; }
      if (!file.size || file.size > MAX_BYTES) { rejected.push(`${file.name}：文件为空或超过 8 MB`); continue; }
      if (jobs.filter(pending).length >= LIMIT) { rejected.push('每批最多 20 个待审核游戏'); break; }
      const signature = `${file.name}:${file.size}:${file.lastModified}`;
      if (jobs.some(job => job.signature === signature)) { rejected.push(`${file.name}：已在列表中`); continue; }
      const html = await file.text();
      const title = new DOMParser().parseFromString(html, 'text/html').querySelector('title')?.textContent?.trim() || file.name.replace(/\.html?$/i, '');
      const job = { id: crypto.randomUUID(), signature, file, filename: file.name, bytes: file.size, html, title, topicId: dependencies.topicId(), status: started ? 'waiting' : 'staged', startedAt:started ? Date.now() : null, note: '', error: '' };
      jobs.push(job);
      selected ||= job.id;
      added++;
    }
    dependencies.feedback(rejected.join('；') || (added ? `已添加 ${added} 个游戏，准备好后开始审核。` : '没有添加新文件。'), !!rejected.length);
    refresh();
    void pump();
  })).catch(error => dependencies.feedback(`文件读取失败：${error.message}`, true));
  return adding;
}

export async function mountReviewWorkspace(options) {
  const { view, api, alive, topics, probeGame, setProbing, checksHtml, probeChecks, copyText, download, openModal } = options;
  view.innerHTML = `<div class="review-page"><section class="review-intro"><div><div class="eyebrow"><span></span>PGC AI SIMULATION REVIEW</div><h1>下一款好游戏，准备出发<span>。</span></h1><p>一次上传，逐个体验。让每一份修改建议都有据可依。</p><div class="review-intro-tags"><span>多文件拖放</span><i>·</i><span>3 路 AI 并发</span><i>·</i><span>独立评分报告</span></div></div><img class="review-mascot" src="/artwork/pixel-cat.png" width="74" height="74" alt=""></section>
    <section class="review-workspace"><div class="review-upload-panel"><div class="section-label"><span><i class="step-number">01</i>添加游戏</span><b>每批最多 20 个</b></div><div class="review-dropzone" id="rvDropzone"><div class="review-file-illustration" aria-hidden="true"><div class="review-monitor"><span></span><span></span><span></span></div><div class="review-check">✓</div></div><h2>把游戏们，一起拖进来。</h2><p>支持拖到页面任意位置，也可以选择多个文件</p><button type="button" class="rr-button rr-button-dark" id="rvChoose">${svg('upload')}选择游戏文件</button><input type="file" id="rvFile" accept=".html,.htm,text/html" multiple hidden><div class="upload-meta"><span>.html / .htm</span><span>单个 ≤ 8 MB</span><span>支持多选</span></div></div><p class="rv-feedback" id="rvFeedback" role="status" aria-live="polite">文件只用于审核，评分完成后可在历史记录中查看报告。</p><div class="review-action-row"><label class="rv-concurrency">AI 并发<select id="rvConcurrency" aria-label="AI 审核并发数"><option value="1">1 路</option><option value="2">2 路</option><option value="3" selected>3 路</option></select></label>${topics.length ? `<label class="rv-topic">关联选题<select id="rvTopic"><option value="">不关联</option>${topics.map(t => `<option value="${t.id}">${esc(t.data.title)}</option>`).join('')}</select></label>` : ''}<button type="button" class="rr-button rr-button-dark" id="rvGo" disabled>开始审核 ${svg('arrow')}</button></div></div>
    <aside class="review-scope-panel"><div class="section-label"><span><i class="step-number">02</i>同一份审核标准</span></div><div class="rv-criteria">${[['01', '美学', '画面协调、风格表达、视觉反馈'], ['02', '易玩性', '规则理解、上手门槛、操作引导'], ['03', '可玩性', '机制趣味、挑战节奏、重玩动力']].map(([n, t, d]) => `<div><span>${n}</span><section><h3>${t}<small>3 分</small></h3><p>${d}</p></section></div>`).join('')}</div><div class="rv-threshold"><strong>7<span> / 9</span></strong><div><b>模拟通过线</b><p>2 + 2 + 2 = 6，仍需修改</p></div></div><p class="rv-scope-foot">沿用 Forge 真实审核校准样本<br>AI 模拟评分 · 人工最终确认</p></aside></section>
    <section class="rv-batch" id="rvBatch" hidden><div class="rv-batch-heading"><div><span class="rr-kicker">REVIEW QUEUE</span><h2>这一批，逐个变好。<span id="rvQueueCount"></span></h2></div><div class="rv-batch-actions"><span id="rvBatchStats" role="status" aria-live="polite"></span><button type="button" class="rr-button" id="rvClear">清除已结束</button></div></div><div id="rvBatchMeter"></div><div class="rv-results-grid"><div class="rv-job-list" id="rvJobs" aria-label="审核任务"></div><div id="rvResult" class="rv-selected" aria-live="polite"></div></div></section>
    <section class="rv-capture" id="rvCapture" hidden><div class="rr-section-heading"><h3>采集游戏画面</h3><span id="rvCaptureTitle"></span></div><p>正在运行三种手机比例，请保持此页面在前台。已提交的 AI 审核会同时在后台进行。</p><div class="phones" id="rvPhones"></div></section>
    <section class="review-history"><div class="rr-section-heading"><div><span class="rr-kicker">PREVIOUS REVIEWS</span><h2>每一次迭代，都有迹可循。</h2></div><button type="button" class="rr-button" id="rvRefreshHistory">刷新记录</button></div><div id="rvHistory"><p class="rr-empty-note">正在读取审核记录…</p></div></section></div>`;
  const root = view.querySelector('.review-page');
  const $ = selector => root.querySelector(selector);
  const current = () => alive() && root.isConnected;
  let renderedId = '';
  let renderedResult;
  dependencies = { api, probeGame, setProbing, isActive: current,
    topicId: () => Number($('#rvTopic')?.value) || null,
    highlight: yes => $('#rvDropzone')?.classList.toggle('drag-over', yes),
    feedback: (message, error) => { if (current()) { $('#rvFeedback').textContent = message; $('#rvFeedback').classList.toggle('is-error', error); } },
    captureBox: () => { $('#rvCapture').hidden = false; $('#rvCaptureTitle').textContent = jobs.find(job => job.status === 'probing')?.title || ''; return $('#rvPhones'); },
    clearCapture: () => { if (current()) { $('#rvPhones').replaceChildren(); $('#rvCapture').hidden = true; } },
  };
  const showResult = report => {
    $('#rvResult').innerHTML = reviewHtml(report);
    $('#rvResult [data-copy-fix]').onclick = () => copyText(report.result.fix_prompt);
    $('#rvResult [data-copy-report]').onclick = () => copyText(reportText(report));
    $('#rvResult [data-download-report]').onclick = () => download(`${report.title.replace(/[^\p{L}\p{N}._-]+/gu, '-')}-review.md`, reportText(report));
    const checks = $('#rvResult [data-report-checks]');
    if (checks) { try { checks.innerHTML = checksHtml(probeChecks(report.probe)); } catch { checks.textContent = '这份旧报告没有完整的采集记录。'; } }
    const shots = arr(report.shots).filter(s => safeImage(s.data));
    $('#rvResult').querySelectorAll('[data-shot]').forEach(button => { button.onclick = () => { const shot = shots[Number(button.dataset.shot)]; openModal(shot.label, `<img class="rr-lightbox" src="${esc(shot.data)}" alt="${esc(shot.label)}">`); }; });
  };
  const jobProgress = job => ({label:labels[job.status] || '正在处理',detail:job.note || '等待前面的游戏完成采集…',startedAt:job.startedAt,...(job.status === 'probing' ? job.captureProgress : {})});
  refresh = () => {
    for (const job of jobs.filter(active)) {
      const signature = JSON.stringify([job.status,job.note,job.captureProgress]);
      if (job.progress && signature !== job.progressSignature) {
        job.progressSignature = signature;
        job.progress.update({...jobProgress(job),label:`${labels[job.status]} · ${job.title}`,value:job.status === 'probing' ? job.captureProgress?.value : undefined,total:job.status === 'probing' ? job.captureProgress?.total : undefined});
      }
    }
    if (!current()) return;
    $('#rvBatch').hidden = !jobs.length;
    const staged = jobs.filter(job => job.status === 'staged').length;
    const done = jobs.filter(job => job.status === 'done').length;
    const errors = jobs.filter(job => job.status === 'error').length;
    $('#rvQueueCount').textContent = String(jobs.length).padStart(2, '0');
    $('#rvBatchStats').textContent = `${done} 已完成${activeCount() ? ` · ${activeCount()} 进行中` : ''}${errors ? ` · ${errors} 未完成` : ''}`;
    $('#rvBatchMeter').innerHTML = progressHtml({label:'本批报告',value:done,total:jobs.length,status:jobs.some(job => pending(job) && job.status !== 'staged') ? 'running' : errors ? 'error' : done === jobs.length ? 'done' : 'running',detail:`${done} 个报告已生成${errors ? ` · ${errors} 个未完成，可单独重试` : ''}${jobs.length-done-errors ? ` · ${jobs.length-done-errors} 个待完成` : ''}`});
    $('#rvGo').disabled = !staged;
    $('#rvGo').innerHTML = `${staged ? `开始审核 ${staged} 个` : started ? '添加游戏继续审核' : '开始审核'} ${svg('arrow')}`;
    $('#rvClear').disabled = !done && !errors;
    if (!jobs.some(job => job.id === selected)) selected = jobs[0]?.id || '';
    $('#rvJobs').innerHTML = jobs.map(job => `<article class="rv-job ${job.id === selected ? 'is-selected' : ''}" data-job="${job.id}"><button type="button" class="rv-job-select" data-select="${job.id}" aria-pressed="${job.id === selected}"><span class="rv-file-icon">${svg(job.status === 'done' ? 'check' : 'file')}</span><span class="rv-job-info"><b>${esc(job.title)}</b><small>${esc(job.filename || '后台任务')}${job.bytes ? ` · ${size(job.bytes)}` : ''}</small><span class="rv-job-status ${active(job) ? 'is-active' : job.status}">${active(job) ? '<i class="rv-spinner"></i>' : '<i></i>'}${labels[job.status] || '处理中'}${job.result ? ` · ${job.result.score}/9` : ''}</span>${active(job) || job.status === 'waiting' ? progressHtml(jobProgress(job)) : ''}</span></button>${job.status === 'staged' ? `<button type="button" class="rv-job-remove" data-remove="${job.id}" aria-label="移除 ${esc(job.title)}">×</button>` : ''}${job.status === 'error' ? `<button type="button" class="rv-job-retry" data-retry="${job.id}">${svg('retry')}重试</button>` : ''}</article>`).join('');
    const job = jobs.find(item => item.id === selected) || jobs[0];
    if (!job) { $('#rvResult').innerHTML = ''; renderedId = ''; renderedResult = null; return; }
    selected = job.id;
    if (job.result) {
      if (renderedId !== job.id || renderedResult !== job.result) { showResult(job.result); renderedId = job.id; renderedResult = job.result; }
    } else {
      renderedResult = null;
      renderedId = '';
      $('#rvResult').innerHTML = `<div class="rv-result-placeholder ${job.status === 'error' ? 'is-error' : ''}"><span class="rv-placeholder-icon">${active(job) ? '<i class="rv-spinner"></i>' : svg(job.status === 'error' ? 'retry' : 'sparkle')}</span><span class="rr-kicker">${job.status === 'error' ? 'LET’S TRY AGAIN' : 'A BETTER GAME, ONE STEP AWAY'}</span><h3>${esc(job.title)}</h3><p>${esc(job.status === 'error' ? job.error : job.note || (job.status === 'staged' ? '文件已准备好，点击「开始审核」一起出发。' : '等待前面的任务，随后自动开始。'))}</p>${job.status === 'error' ? '<small>这次未完成审核，没有给游戏打分。</small>' : '<div class="rv-placeholder-steps"><span>采集画面</span><i>→</i><span>AI 评分</span><i>→</i><span>修改建议</span></div>'}${active(job) || job.status === 'waiting' ? progressHtml(jobProgress(job)) : ''}</div>`;
    }
  };
  $('#rvChoose').onclick = () => $('#rvFile').click();
  $('#rvFile').onchange = event => { const files = [...event.target.files]; event.target.value = ''; void addFiles(files); };
  $('#rvConcurrency').value = String(concurrency);
  $('#rvConcurrency').onchange = event => { concurrency = Number(event.target.value); void pump(); };
  $('#rvGo').onclick = () => { started = true; for (const job of jobs) if (job.status === 'staged') { job.status = 'waiting'; job.startedAt = Date.now(); } refresh(); void pump(); };
  $('#rvJobs').onclick = event => {
    const select = event.target.closest('[data-select]');
    if (select) { selected = select.dataset.select; refresh(); }
    const remove = event.target.closest('[data-remove]');
    if (remove) { const index = jobs.findIndex(job => job.id === remove.dataset.remove && job.status === 'staged'); if (index >= 0) jobs.splice(index, 1); refresh(); }
    const retry = event.target.closest('[data-retry]');
    if (retry) {
      const job = jobs.find(item => item.id === retry.dataset.retry);
      if (!job?.html) { dependencies.feedback('请重新拖入原始 HTML 文件，再开始审核。', true); job.signature = ''; return; }
      // Known model failures start a new attempt. An uncertain submit failure
      // keeps the old ID, so recovery cannot call the model twice.
      if (job.remoteFailed) { job.requestId = null; job.remoteFailed = false; }
      job.progress?.dismiss(); job.progress = null; job.progressSignature = ''; job.captureProgress = null; job.startedAt = Date.now();
      job.error = ''; job.status = 'waiting'; started = true; refresh(); void pump();
    }
  };
  $('#rvClear').onclick = () => { for (let i = jobs.length - 1; i >= 0; i--) if (['done', 'error'].includes(jobs[i].status)) jobs.splice(i, 1); refresh(); };
  const history = async () => {
    try {
      const list = await withProgress('读取审核记录', () => api('GET', 'reviews'));
      if (!current()) return;
      $('#rvHistory').innerHTML = list.length ? list.map(report => `<button type="button" class="rv-history-item" data-history="${report.id}"><span class="rv-history-mark ${report.score >= 7 ? 'is-pass' : ''}">${svg(report.score >= 7 ? 'check' : 'file')}</span><b>${esc(report.title)}</b><span class="rv-history-score">${esc(report.score)}<small>/9</small></span><span class="rr-verdict ${report.score >= 7 ? 'is-pass' : 'is-revise'}">${report.score >= 7 ? '模拟通过' : '建议修改'}</span><time>${esc(date(report.created_at))}</time><span>↗</span></button>`).join('') : '<p class="rr-empty-note">还没有历史报告。上传第一款游戏，开始一次模拟审核。</p>';
    } catch (error) { if (current()) $('#rvHistory').textContent = `记录暂时无法读取：${error.message}`; }
  };
  $('#rvHistory').onclick = async event => {
    const button = event.target.closest('[data-history]');
    if (!button) return;
    button.disabled = true;
    try {
      const report = await withProgress('读取审核报告', () => api('GET', `reviews/${button.dataset.history}`));
      if (!current()) return;
      let job = jobs.find(item => item.result?.id === report.id);
      if (!job) { job = { id: `history-${report.id}`, title: report.title, result: report, status: 'done' }; jobs.push(job); }
      selected = job.id; refresh();
      $('#rvBatch').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    } catch (error) { dependencies.feedback(error.message, true); } finally { button.disabled = false; }
  };
  $('#rvRefreshHistory').onclick = () => void history();
  dependencies.updateHistory = history;
  refresh();
  void history();
  try {
    const remote = await withProgress('恢复后台审核任务', () => api('GET', 'review/jobs'));
    for (const item of remote) {
      if (!['queued', 'running'].includes(item.status) || jobs.some(job => job.requestId === item.id)) continue;
      const job = { id: item.id, requestId: item.id, title: item.title, status: item.status, note: '恢复后台审核任务' };
      job.startedAt = Date.parse(item.created_at) || Date.now();
      job.progress = startTask(`AI 审核 · ${job.title}`,{detail:job.note,startedAt:job.startedAt});
      jobs.push(job); selected ||= job.id; started = true; void pollJob(job);
    }
    refresh();
  } catch { /* Older history still renders if job recovery is temporarily unavailable. */ }
}
