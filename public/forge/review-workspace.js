import {patchHtml} from './experience.js';
import { startTask, progressHtml } from './progress.js';
// Shared by the member workspace and the administrator's review tab.
const LIMIT = 20;
const MAX_BYTES = 8 * 1024 * 1024;
const jobs = [];
let selected = '';
let started = false;
let preparing = false;
let adding = Promise.resolve();
let refresh = () => {};
let dependencies;
const polls = new Set();
const pollWaiters = new Set();
const pause = ms => new Promise(resolve => {
  const wake = () => { clearTimeout(timer); pollWaiters.delete(wake); resolve(); };
  const timer = setTimeout(wake, ms); pollWaiters.add(wake);
});
const wakePolls = () => { for (const wake of pollWaiters) wake(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) wakePolls(); });
addEventListener('online', wakePolls);
const labels = { staged: '待开始', waiting: '等待采集', probing: '采集画面', submitting: '提交中', queued: '等待本机 Agent', running: 'Agent 评分中', done: '已完成', error: '未完成' };
const agentWaiting = job => job.modelExecutor === 'agent' && ['queued','running'].includes(job.status) && (job.stage !== 'capture' || Date.now() - job.updatedAt > 180000);
const working = job => active(job) && !agentWaiting(job) && !job.connectionLost;
const stageLabel = job => job.connectionLost ? '状态暂不可用' : agentWaiting(job) ? (job.stage === 'verify' ? '等待 Agent 复核结果' : job.stage === 'review' ? '等待 Agent 初评结果' : '等待 Agent 继续采集') : ['queued','running'].includes(job.status) && job.stage === 'capture' ? (job.status === 'queued' ? '等待采集' : '采集画面') : job.status === 'running' ? job.stage === 'verify' || /复核/.test(job.note || '') ? '模型复核' : '模型初评' : labels[job.status] || '正在处理';
const resumePrompt = job => `请重新阅读 ${location.origin}/agent.md 并更新审核工具，继续我已有的审核任务 ${job.requestId}（${job.title}）。不要重新提交游戏或新建任务。先用 status 查询：capture 阶段继续原任务采集；review 阶段读取 material 和四张真实截图，用你自己的模型完成初评并提交 draft；verify 阶段用初评的同一模型复核同一证据和草稿，再 complete 回传报告。网页不会代替你调用模型，不要只启动工具后等待。数据库暂不可用时保留本地结果，稍后用相同请求重传；如果确实无法执行，说明原因并用 fail 明确结束。最后读取 report 确认已保存。`;
const stageSteps = job => {
  const step = job.status === 'done' ? 4 : job.stage === 'capture' ? 0 : job.status === 'running' ? job.stage === 'verify' || /复核/.test(job.note || '') ? 3 : 2 : ['submitting','queued'].includes(job.status) ? 1 : -1;
  return `<ol class="rv-stage-steps" aria-label="审核流程">${['本机采集','等待 Agent','Agent 初评','Agent 复核','回传报告'].map((label,i) => `<li class="${i < step ? 'is-complete' : i === step ? 'is-current' : ''}" ${i === step ? 'aria-current="step"' : ''}><i>${i < step ? '✓' : i+1}</i><span>${label}</span></li>`).join('')}</ol>`;
};
const active = job => ['probing', 'submitting', 'queued', 'running'].includes(job.status);
const pending = job => !['done', 'error'].includes(job.status);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const date = value => { const time = new Date(value); return Number.isNaN(time.valueOf()) ? '' : time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };
const safeImage = data => typeof data === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(data) ? data : '';
const reviewError = message => /模型接口返回 409/.test(message || '') ? '模型网关返回请求冲突（409），这次未生成报告。可以重试；刷新过页面后需要重新上传原始 HTML。' : /模型接口返回 429/.test(message || '') ? '这次审核因模型接口限流（429）未完成。可点击重试，系统会按限额排队。' : message || '审核未完成，请重试。';

function retryJob(job) {
  if (!job || !['error', 'done'].includes(job.status)) return;
  if(!dependencies?.allowUpload){dependencies.feedback('请让自己的 Agent 重新审核本地游戏并提交新报告。');return;}
  if (!job.html) {
    selected = job.id; refresh();
    dependencies.feedback('临时文件已清理，请重新选择原始 HTML 文件后开始审核。', true);
    dependencies.chooseFile?.(); return;
  }
  if (job.remoteFailed) { job.requestId = null; job.remoteFailed = false; }
  job.progress?.dismiss(); job.progress = null; job.progressSignature = ''; job.captureProgress = null; job.startedAt = Date.now();
  job.error = ''; job.status = 'waiting'; started = true; refresh(); void pump();
}
function failJobProgress(job) {
  job.error = reviewError(job.error);
  job.progress?.update({label:`审核未完成 · ${job.title}`,value:undefined,total:undefined,action:dependencies?.allowUpload?()=>retryJob(job):undefined,actionLabel:dependencies?.allowUpload?(job.html ? '重试审核' : '重新上传重试'):undefined});
  job.progress?.fail(job.error);
}
const arr = value => Array.isArray(value) ? value : [];
const icon = name => ({ file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13l-2 2 2 2m8-4 2 2-2 2m-3-5-2 8"/>', upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>', arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/>', check: '<path d="m5 12 4 4L19 6"/>', download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>', retry: '<path d="M3 11a9 9 0 1 1 2 7M3 3v8h8"/>', sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>' }[name] || '');
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon(name)}</svg>`;

const reportOrigin = report => /import|manual-admin/.test(report.model_executor || '') ? '管理员导入' : report.model_executor === 'agent' ? '成员本机 Agent' : report.model_executor === 'platform' ? '平台模型（管理员上传）' : !report.model_executor && report.probe?.modelExecutor === 'agent' ? '成员本机 Agent' : '历史报告（未记录执行来源）';
const reportEvidence = report => report.probe?.evidenceOrigin === 'member-device' ? '成员本机采集' : report.probe?.evidenceOrigin || '未单独记录';
const HUMAN_REVIEW_LABELS = { reviewed: '已审核', pending: '暂未审核', unavailable: '真人审核查询暂不可用', unlinked: '未关联真人审核作品' };
const humanReviewTitle = review => review?.phase === 'preliminary' ? '组长预审' : review?.phase === 'final' ? '真人终审' : '真人审核';
const humanReview = report => {
  const review = report.human_review;
  if (!review || typeof review !== 'object') return null;
  const score = review.score == null || review.score === '' ? '' : String(review.score);
  const feedback = String(review.feedback ?? '').trim();
  const status = Object.hasOwn(HUMAN_REVIEW_LABELS, review.status) ? review.status : score || feedback ? 'reviewed' : review.workId ? 'pending' : 'unlinked';
  return { ...review, score, feedback, status };
};
const humanReviewFields = review => [['关联作品', review.workId], ['投稿版本', review.versionId], ['更新时间', review.updatedAt], ['审核来源（Agent 同步）', review.source]].filter(([, value]) => value != null && value !== '');
const humanReviewText = report => {
  const review = humanReview(report);
  if (!review) return '暂无真人审核或未关联作品。';
  return [`审核阶段：${humanReviewTitle(review)}`, HUMAN_REVIEW_LABELS[review.status], ...(review.score ? [`${humanReviewTitle(review)}评分：${review.score}/9`] : review.status === 'reviewed' ? [`${humanReviewTitle(review)}评分：未提供`] : []), ...humanReviewFields(review).map(([label, value]) => `${label}：${value}`), ...(review.status === 'reviewed' || review.feedback ? [`审核意见：${review.feedback || '暂无真人审核意见。'}`] : [])].join('\n');
};
const humanReviewHtml = report => {
  const review = humanReview(report);
  return `<section class="rr-human-review" aria-label="真人审核"><div class="rr-section-heading"><h3>${humanReviewTitle(review)}</h3>${review?.score ? `<strong class="rr-human-score">${humanReviewTitle(review)}评分 ${esc(review.score)} / 9</strong>` : ''}</div>${review ? `<p class="rr-human-state">${HUMAN_REVIEW_LABELS[review.status]}${review.status === 'reviewed' && !review.score ? ' · 未提供评分' : ''}</p><dl>${humanReviewFields(review).map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${review.status === 'reviewed' || review.feedback ? `<p class="rr-human-feedback">${esc(review.feedback || '暂无真人审核意见。')}</p>` : ''}` : '<p class="rr-human-empty">暂无真人审核或未关联作品。</p>'}</section>`;
};
export function reportText(report) {
  const x = report.result || {};
  const reasons = [['aes', '美学'], ['ease', '易玩性'], ['play', '可玩性']].map(([key, label]) => `- ${label}：${x.score_reasons?.[key] || '旧报告未单独记录评分依据'}`).join('\n');
  const uncertainties = Array.isArray(x.uncertainties) ? x.uncertainties.map(text => `- ${text}`).join('\n') || '- 模型未额外列出待确认项' : '- 旧报告未单独记录待确认项';
  return `# ${report.title} · AI 模拟审核\n\n执行来源：${reportOrigin(report)}${report.model ? ` · 模型 ${report.model}` : ''}\n证据来源：${reportEvidence(report)}${report.agent_id ? ` · Agent ${report.agent_id}` : ''}${report.evidence_hash ? `\n证据哈希：${report.evidence_hash}` : ''}\n\n总分 ${report.score}/9 · ${x.verdict || ''}\n美学 ${x.aes}/3 · 易玩性 ${x.ease}/3 · 可玩性 ${x.play}/3\n\n${x.reviewer_comment || ''}\n\n## 真人审核\n${humanReviewText(report)}\n\n## 评分依据\n${reasons}\n\n## 待人工确认\n${uncertainties}\n\n## 亮点\n${arr(x.strengths).map(t => `- ${t}`).join('\n')}\n\n## 优先修改\n${arr(x.issues).map((i, n) => `${n + 1}. [${i.severity}] ${i.area}：${i.problem}\n   证据：${i.evidence}\n   建议：${i.fix}`).join('\n\n')}\n\n## 交给智能助手修改\n${x.fix_prompt || ''}\n\n这是基于有限证据的 AI 模拟评分，最终结果由人工确认。\n`;
}

export function reviewHtml(report) {
  const x = report.result || {};
  const passed = report.score >= 7;
  const issues = arr(x.issues).slice().sort((a, b) => (['高', '中', '低'].indexOf(a.severity) + 1 || 4) - (['高', '中', '低'].indexOf(b.severity) + 1 || 4));
  const shots = arr(report.shots).filter(s => safeImage(s.data));
  return `<article class="review-report" aria-label="${esc(report.title)}的审核报告">
    <header class="rr-header"><div><span class="rr-kicker">AI 模拟审核报告</span><h2>${esc(report.title)}</h2><div class="rr-meta"><span class="rr-verdict ${passed ? 'is-pass' : 'is-revise'}">${svg(passed ? 'check' : 'retry')}${passed ? '模拟通过' : '建议修改'}</span><time>${esc(date(report.created_at))}</time></div></div><div class="rr-total"><strong>${esc(report.score)}</strong><span>/ 9</span><small>通过线 7 分</small></div></header>
    <p class="rr-legacy-note">执行来源：${esc(reportOrigin(report))}${report.model ? ` · 模型 ${esc(report.model)}` : ''}<br>证据来源：${esc(reportEvidence(report))}${report.agent_id ? ` · Agent ${esc(report.agent_id)}` : ''}${report.evidence_hash ? `<br>证据哈希：${esc(report.evidence_hash)}` : ''}</p><div class="rr-scores">${[['aes', '美学', '视觉与风格'], ['ease', '易玩性', '规则与操作'], ['play', '可玩性', '机制与挑战']].map(([k, title, caption], index) => `<section><span class="rr-score-label"><i>0${index + 1}</i>${title}</span><div class="rr-score-value"><b>${esc(x[k])}<small> / 3</small></b><span class="rr-segments" aria-hidden="true">${[1, 2, 3].map(n => `<i class="${n <= Number(x[k]) ? 'filled' : ''}"></i>`).join('')}</span></div><p>${caption}</p></section>`).join('')}</div>
    <section class="rr-comment"><span>${svg('sparkle')}审核意见</span><p>${esc(x.reviewer_comment)}</p>${x.verdict ? `<small>模型结论 · ${esc(x.verdict)}</small>` : ''}</section>
    ${humanReviewHtml(report)}
    <nav class="rr-report-nav" aria-label="报告内容"><button type="button" data-report-jump=".rr-reasons">评分依据</button><button type="button" data-report-jump=".rr-issues">修改建议 <b>${issues.length}</b></button><button type="button" data-report-jump=".rr-agent">智能助手指令 ↗</button>${shots.length ? '<button type="button" data-report-jump=".rr-evidence">画面证据</button>' : ''}</nav>
    ${x.score_reasons ? `<section class="rr-reasons"><h3>为什么是这个分数</h3><dl>${[['aes', '美学'], ['ease', '易玩性'], ['play', '可玩性']].map(([key, label]) => `<div><dt>${label}<b>${esc(x[key])} / 3</b></dt><dd>${esc(x.score_reasons[key])}</dd></div>`).join('')}</dl></section>` : '<p class="rr-legacy-note">旧报告未单独记录评分依据，可让自己的 Agent 重新审核获取新版报告。</p>'}
    ${arr(x.uncertainties).length ? `<section class="rr-uncertainties"><h3>待人工确认</h3><ul>${x.uncertainties.map(text => `<li>${esc(text)}</li>`).join('')}</ul></section>` : ''}
    ${arr(x.strengths).length ? `<section class="rr-strengths"><h3>值得保留</h3><ul>${x.strengths.map(s => `<li>${svg('check')}<span>${esc(s)}</span></li>`).join('')}</ul></section>` : ''}
    <section class="rr-issues"><div class="rr-section-heading"><h3>优先修改 <span>${issues.length.toString().padStart(2, '0')}</span></h3><small>从影响最大的地方开始</small></div>${issues.map((issue, i) => `<article class="rr-issue"><div class="rr-issue-number">${String(i + 1).padStart(2, '0')}</div><div class="rr-issue-body"><div class="rr-issue-title"><span class="rr-severity ${issue.severity === '高' ? 'high' : issue.severity === '中' ? 'medium' : 'low'}">${esc(issue.severity)}优先级</span><h4>${esc(issue.area)}</h4></div><p>${esc(issue.problem)}</p><dl><div><dt>观察证据</dt><dd>${esc(issue.evidence)}</dd></div><div><dt>建议改法</dt><dd>${esc(issue.fix)}</dd></div></dl></div></article>`).join('') || '<p class="rr-empty-note">本次模拟未提出需要修改的问题。</p>'}</section>
    <section class="rr-agent"><div class="rr-section-heading"><div><span class="rr-kicker">下一步</span><h3>把修改，交给智能助手。</h3></div><button type="button" class="rr-button rr-button-dark" data-copy-fix>${svg('copy')}复制修改指令</button></div><p>复制下面这段，交给制作游戏的 AI 继续完善。</p><details><summary>展开完整修改指令 <span>↗</span></summary><pre>${esc(x.fix_prompt || '本次没有生成修改指令。')}</pre></details></section>
    ${shots.length ? `<section class="rr-evidence"><div class="rr-section-heading"><h3>画面证据 <span>${String(shots.length).padStart(2, '0')}</span></h3><small>点击查看原图</small></div><div class="rr-shot-grid">${shots.map((shot, i) => `<button type="button" class="rr-shot" data-shot="${i}"><span><img src="${esc(shot.data)}" alt="${esc(shot.label)}" loading="lazy"></span><b>${esc(shot.label)}</b></button>`).join('')}</div></section>` : ''}
    ${report.probe ? '<details class="rr-diagnostics"><summary>查看运行采集记录</summary><div data-report-checks></div></details>' : ''}
    <footer class="rr-footer"><span>AI 模拟评分 · 人工最终确认</span><div><button type="button" class="rr-button" data-copy-report>${svg('copy')}复制报告</button><button type="button" class="rr-button" data-download-report>${svg('download')}下载 .md</button></div></footer>
  </article>`;
}

let polling = false;
async function pollJob(job) {
  polls.add(job.requestId);
  if (polling) return;
  polling = true;
  let errors = 0;
  try {
    while (polls.size && dependencies?.isActive()) {
      if (document.hidden) { await pause(60000); continue; }
      try {
        // One request covers the whole batch; never one timer per game.
        const remoteJobs = await dependencies.api('GET', 'review/jobs');
        errors = 0;
        let completed = false;
        for (const requestId of [...polls]) {
        const job = jobs.find(item => item.requestId === requestId);
        if (!job || !['queued','running','submitting'].includes(job.status)) { polls.delete(requestId); continue; }
        const remote = remoteJobs.find(item => item.id === requestId) || await dependencies.api('GET', `review/jobs/${requestId}`);
        if (remote.status === 'done') {
          job.result = await dependencies.api('GET', `reviews/${remote.result_id}`);
        }
        job.connectionLost = false;
        job.modelExecutor = remote.model_executor;
        job.updatedAt = Date.parse(remote.updated_at) || Date.now();
        job.status = remote.status;
        job.stage = remote.stage;
        job.error = remote.status === 'error' ? reviewError(remote.error) : remote.error;
        job.remoteFailed = remote.status === 'error';
        job.note = agentWaiting(job) ? `平台尚未收到${job.stage === 'verify' ? '复核报告' : '初评结果'}。请在原 Agent 对话中继续此任务；停留网页不会继续审核。最近任务活动：${date(remote.updated_at)}` : remote.error || '等待审核执行器处理';
        if (remote.status === 'done') {
          job.note = '报告已生成';
          job.html = null;
          job.file = null;
          job.prepared = null;
          if (!jobs.find(item => item.id === selected)?.result) selected = job.id;
          completed = true;
        }
        if (job.status === 'done') { job.progress?.update({label:`审核完成 · ${job.title}`}); job.progress?.done('审核报告已生成'); }
        if (job.status === 'error') failJobProgress(job);
        if (['done', 'error'].includes(job.status)) { polls.delete(requestId); void dependencies.updateUsage?.(); }
        }
        if(completed)void dependencies.updateHistory?.();
        refresh();
      } catch (error) {
        // A transient poll failure must never resubmit a model request.
        errors++;
        for (const job of jobs.filter(item => polls.has(item.requestId))) {
          job.connectionLost = true;
          job.note = '暂时无法读取任务状态，不能确认是否仍在执行。保留原任务，连接恢复后自动查询；不要重复提交游戏。';
        }
        refresh();
      }
      if(polls.size)await pause(errors ? Math.min(60000,15000*2**(errors-1)) : jobs.some(job => polls.has(job.requestId)&&working(job)) ? 10000 : 60000);
    }
  } finally {
    polling = false;
    polls.clear();
    void pump();
  }
}

async function submit(job) {
  job.status = 'submitting';
  job.note = '正在上传，随后由你的智能助手采集画面…';
  job.requestId ||= crypto.randomUUID();
  refresh();
  try {
    const result = await dependencies.api('POST', 'review/jobs', { html: job.html, title: job.title, filename:job.filename, topic_id: job.topicId || null, request_id: job.requestId });
    job.stage = result.stage;
    job.status = result.status === 'error' ? 'error' : 'queued';
    if (result.status === 'error') { job.error = result.error; job.remoteFailed = true; }
    job.note = '已接收，等待你的智能助手完成本机采集、初评与复核后回传报告';
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
  if (job.status === 'error') failJobProgress(job);
  void dependencies.updateUsage?.();
  refresh();
}

async function pump() {
  if (!started || preparing || !dependencies) return;
  preparing = true;
  try {
    while (jobs.some(item => item.status === 'waiting')) {
      const job = jobs.find(item => item.status === 'waiting');
      if (!job) break;
      job.startedAt ||= Date.now();
      job.progress ||= startTask(`AI 审核 · ${job.title}`, {key:`review-${job.id}`,compact:true,tray:false,detail:'准备上传游戏…',startedAt:job.startedAt});
      try {
        await submit(job);
      } catch (error) {
        job.status = 'error';
        job.error = error.message;
        failJobProgress(job);
        dependencies.setProbing(false);
        dependencies.clearCapture();
        refresh();
      }
    }
  } finally { preparing = false; }
}
const activeCount = () => jobs.filter(working).length;
function withReviewProgress(label,work,delay=350){
  const task=startTask(label,{compact:true,tray:false});
  let timer,element;
  timer=setTimeout(()=>{
    if(!dependencies?.isActive())return;
    const slot=dependencies.progressRoot?.();
    if(!slot)return;
    element=document.createElement('div');
    slot.hidden=false;
    slot.append(element);
    task.attach(element);
  },delay);
  return Promise.resolve().then(()=>work(task)).then(result=>{task.done();return result;},error=>{task.fail(error?.message);throw error;}).finally(()=>{
    clearTimeout(timer);
    task.dismiss();
    element?.remove();
    const slot=dependencies?.progressRoot?.();
    if(slot)slot.hidden=!slot.childElementCount;
  });
}

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
  if(!dependencies?.allowUpload){dependencies?.feedback('请把本地 HTML 交给自己的 Agent，由它完成审核和提交。');return Promise.resolve();}
  adding = adding.then(() => withReviewProgress('读取游戏文件', async progress => {
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
  const allowUpload = options.allowUpload === true;
  view.innerHTML = `<div class="review-page"><section class="review-intro"><div><div class="eyebrow"><span></span>AI 游戏模拟审核</div><h1>我的审核</h1><p>连接自己的 Agent，使用它的模型采集真实画面、完成初评与复核，并回传修改建议。</p><div class="review-intro-tags"><span>本机 Agent 执行</span><i>·</i><span>自有模型</span><i>·</i><span>双轮评分核对</span></div></div><img class="review-mascot" src="/artwork/pixel-cat.png" width="74" height="74" alt=""></section><div class="rv-inline-progress" id="rvInlineProgress" aria-live="polite" hidden></div>
    <section class="review-workspace"><div class="review-upload-panel"><div class="section-label"><span><i class="step-number">01</i>添加游戏</span><b>每批最多 20 个</b></div><div class="review-dropzone" id="rvDropzone"><div class="review-file-illustration" aria-hidden="true"><div class="review-monitor"><span></span><span></span><span></span></div><div class="review-check">✓</div></div><h2>把游戏们，一起拖进来。</h2><p>支持拖到页面任意位置，也可以选择多个文件</p><button type="button" class="rr-button rr-button-dark" id="rvChoose">${svg('upload')}选择游戏文件</button><input type="file" id="rvFile" accept=".html,.htm,text/html" multiple hidden><div class="upload-meta"><span>.html / .htm</span><span>单个 ≤ 8 MB</span><span>支持多选</span></div></div><p class="rv-feedback" id="rvFeedback" role="status" aria-live="polite">每个游戏计 1 次，含初评与复核。北京时间零点重置；模型调用前的平台失败退回次数。</p><div class="review-action-row"><span class="rv-quota" id="rvQuota" role="status">正在读取今日次数…</span>${topics.length ? `<label class="rv-topic">关联选题<select id="rvTopic"><option value="">不关联</option>${topics.map(t => `<option value="${t.id}">${esc(t.data.title)}</option>`).join('')}</select></label>` : ''}<button type="button" class="rr-button rr-button-dark" id="rvGo" disabled>开始审核 ${svg('arrow')}</button></div></div>
    <aside class="review-scope-panel"><div class="section-label"><span><i class="step-number">02</i>同一份审核标准</span></div><div class="rv-criteria">${[['01', '美学', '画面协调、风格表达、视觉反馈'], ['02', '易玩性', '规则理解、上手门槛、操作引导'], ['03', '可玩性', '机制趣味、挑战节奏、重玩动力']].map(([n, t, d]) => `<div><span>${n}</span><section><h3>${t}<small>3 分</small></h3><p>${d}</p></section></div>`).join('')}</div><div class="rv-threshold"><strong>7<span> / 9</span></strong><div><b>模拟通过线</b><p>2 + 2 + 2 = 6，仍需修改</p></div></div><p class="rv-scope-foot">沿用平台真实审核校准样本<br>AI 模拟评分 · 人工最终确认</p></aside></section>
    <section class="rv-batch" id="rvBatch" hidden><div class="rv-batch-heading"><div><span class="rr-kicker">审核队列</span><h2>审核任务<span id="rvQueueCount"></span></h2></div><div class="rv-batch-actions"><span id="rvBatchStats" role="status" aria-live="polite"></span><button type="button" class="rr-button" id="rvRetryAll" disabled>重试失败</button><button type="button" class="rr-button" id="rvExportAll" disabled>导出报告</button><button type="button" class="rr-button" id="rvClear">清除已结束</button></div></div><div id="rvOverview" class="rv-overview"></div><div id="rvBatchMeter"></div><div class="rv-results-grid"><div class="rv-job-list" id="rvJobs" aria-label="审核任务"></div><div id="rvResult" class="rv-selected" aria-live="polite"></div></div></section>
    <section class="rv-capture" id="rvCapture" hidden><div class="rr-section-heading"><h3>采集游戏画面</h3><span id="rvCaptureTitle"></span></div><p>Agent 正在本机浏览器采集三种手机比例的完整画面，随后由它自己的模型审核。</p><div class="phones" id="rvPhones"></div></section>
    <section class="review-history"><div class="rr-section-heading"><div><span class="rr-kicker">历史审核记录</span><h2>审核记录</h2></div><button type="button" class="rr-button" id="rvRefreshHistory">刷新记录</button></div><div class="rv-history-tools"><label><span>搜索记录</span><input type="search" id="rvHistorySearch" placeholder="搜索游戏名称" autocomplete="off"></label><label><span>审核结果</span><select id="rvHistoryFilter"><option value="all">全部结果</option><option value="pass">模拟通过 · ≥ 7 分</option><option value="revise">建议修改 · &lt; 7 分</option></select></label><span id="rvHistoryCount" role="status"></span></div><div id="rvHistory"><p class="rr-empty-note">正在读取审核记录…</p></div></section></div>`;
  const root = view.querySelector('.review-page');
  const $ = selector => root.querySelector(selector);
  const current = () => alive() && root.isConnected;
  if(!allowUpload){
    $('#rvDropzone').innerHTML='<div class="review-file-illustration" aria-hidden="true"><div class="review-monitor"><span></span><span></span><span></span></div><div class="review-check">✓</div></div><h2>让你的 Agent 来审核。</h2><p>把本地 HTML 游戏交给自己的智能助手。Agent 使用自己的模型，完成画面采集、初评与复核，再将报告回传到这里。</p>';
    $('.review-upload-panel .section-label').innerHTML='<span><i class="step-number">01</i>连接自己的 Agent</span><b>本机执行</b>';
    $('#rvFeedback').textContent='网页用于查看进度与报告。审核由自己的 Agent 提交，审核模型由自己的 Agent 提供。';
    $('#rvGo').remove();
    $('#rvRetryAll').remove();
  }
  if(!allowUpload){
    const workspace=$('.review-workspace');const setup=document.createElement('details');setup.className='review-setup';
    setup.innerHTML='<summary>开始新审核 · Agent 接入与设备</summary>';workspace.before(setup);setup.append(workspace);
    $('.review-intro p').textContent='查看执行进度与修改建议，继续尚未完成的审核。';
    $('#rvDropzone').innerHTML='<h2>开始一次审核</h2><ol><li>复制接入指令，交给自己的 Agent。</li><li>首次使用时生成配对码，在 Agent 对话中完成授权。</li><li>把本地 HTML 交给 Agent，完成后回到这里查看报告。</li></ol>';
  }
  let renderedId = '';
  let renderedResult;
  const stableHtml=patchHtml;
  dependencies = { allowUpload, api, probeGame, setProbing, isActive: current, progressRoot: () => $('#rvInlineProgress'),
    chooseFile: () => { if (current() && allowUpload) $('#rvFile')?.click(); },
    topicId: () => Number($('#rvTopic')?.value) || null,
    highlight: yes => $('#rvDropzone')?.classList.toggle('drag-over', yes),
    feedback: (message, error) => { if (current()) { $('#rvFeedback').textContent = message; $('#rvFeedback').classList.toggle('is-error', error); } },
    captureBox: () => { $('#rvCapture').hidden = false; $('#rvCaptureTitle').textContent = jobs.find(job => job.status === 'probing')?.title || ''; return $('#rvPhones'); },
    clearCapture: () => { if (current()) { $('#rvPhones').replaceChildren(); $('#rvCapture').hidden = true; } },
  };
  const showResult = report => {
    $('#rvResult').innerHTML = reviewHtml(report);
    const source=$('#rvResult .rr-legacy-note');if(source){const details=document.createElement('details');details.className='rr-source-details';details.innerHTML='<summary>执行来源与技术信息</summary>';source.before(details);details.append(source);}
    const issues=$('#rvResult .rr-issues'),reasons=$('#rvResult .rr-reasons');if(issues&&reasons)reasons.before(issues);
    $('#rvResult [data-copy-fix]').onclick = () => copyText(report.result.fix_prompt);
    $('#rvResult [data-copy-report]').onclick = () => copyText(reportText(report));
    $('#rvResult [data-download-report]').onclick = () => download(`${report.title.replace(/[^\p{L}\p{N}._-]+/gu, '-')}-review.md`, reportText(report));
    $('#rvResult').querySelectorAll('[data-report-jump]').forEach(button => { button.onclick = () => $('#rvResult').querySelector(button.dataset.reportJump)?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'}); });
    const checks = $('#rvResult [data-report-checks]');
    if (checks) { try { checks.innerHTML = checksHtml(probeChecks(report.probe)); } catch { checks.textContent = '这份旧报告没有完整的采集记录。'; } }
    const shots = arr(report.shots).filter(s => safeImage(s.data));
    $('#rvResult').querySelectorAll('[data-shot]').forEach(button => { button.onclick = () => { const shot = shots[Number(button.dataset.shot)]; openModal(shot.label, `<img class="rr-lightbox" src="${esc(shot.data)}" alt="${esc(shot.label)}">`); }; });
  };
  const jobProgress = job => ({label:stageLabel(job),detail:job.note || '等待前面的游戏完成采集…',status:agentWaiting(job)||job.connectionLost?'waiting':'running',startedAt:agentWaiting(job)||job.connectionLost?undefined:job.startedAt,...(job.status === 'probing' ? job.captureProgress : {})});
  refresh = () => {
    for (const job of jobs.filter(active)) {
      const signature = JSON.stringify([job.status,job.note,job.captureProgress,agentWaiting(job),job.connectionLost]);
      if (job.progress && signature !== job.progressSignature) {
        job.progressSignature = signature;
        job.progress.update({...jobProgress(job),label:`${stageLabel(job)} · ${job.title}`,value:job.status === 'probing' ? job.captureProgress?.value : undefined,total:job.status === 'probing' ? job.captureProgress?.total : undefined});
      }
    }
    if (!current()) return;
    $('#rvBatch').hidden = !jobs.length;
    const staged = jobs.filter(job => job.status === 'staged').length;
    const done = jobs.filter(job => job.status === 'done').length;
    const errors = jobs.filter(job => job.status === 'error').length;
    $('#rvQueueCount').textContent = String(jobs.length).padStart(2, '0');
    $('#rvBatchStats').textContent = `${done} 已完成${activeCount() ? ` · ${activeCount()} 进行中` : ''}${errors ? ` · ${errors} 未完成` : ''}`;
    stableHtml($('#rvBatchMeter'), progressHtml({label:'本批报告',value:done,total:jobs.length,status:activeCount() ? 'running' : jobs.some(pending) ? 'waiting' : errors ? 'error' : 'done',detail:`${done} 个报告已生成${errors ? ` · ${errors} 个未完成，可单独重试` : ''}${jobs.length-done-errors ? ` · ${jobs.length-done-errors} 个待完成` : ''}`}));
    if($('#rvGo'))$('#rvGo').disabled = !staged;
    if($('#rvGo'))$('#rvGo').innerHTML = `${staged ? `开始审核 ${staged} 个` : started ? '添加游戏继续审核' : '开始审核'} ${svg('arrow')}`;
    $('#rvClear').disabled = !done && !errors;
    if($('#rvRetryAll'))$('#rvRetryAll').disabled = !jobs.some(job => job.status === 'error' && job.html);
    $('#rvExportAll').disabled = !jobs.some(job => job.result);
    stableHtml($('#rvOverview'), [['已完成',done],['进行中',activeCount()],['待处理',jobs.length-done-errors-activeCount()],['未完成',errors]].map(([label,count]) => `<div><b>${count}</b><span>${label}</span></div>`).join(''));
    if (!jobs.some(job => job.id === selected)) selected = jobs[0]?.id || '';
    stableHtml($('#rvJobs'), jobs.map(job => `<article class="rv-job ${job.id === selected ? 'is-selected' : ''}" data-job="${job.id}"><button type="button" class="rv-job-select" data-select="${job.id}" aria-pressed="${job.id === selected}"><span class="rv-file-icon">${svg(job.status === 'done' ? 'check' : 'file')}</span><span class="rv-job-info"><b>${esc(job.title)}</b><small>${esc(job.filename || '后台任务')}${job.bytes ? ` · ${size(job.bytes)}` : ''}</small><span class="rv-job-status ${working(job) ? 'is-active' : job.status}">${working(job) ? '<i class="rv-spinner"></i>' : '<i></i>'}${stageLabel(job)}${job.result ? ` · ${job.result.score}/9` : ''}</span>${active(job) || job.status === 'waiting' ? progressHtml(jobProgress(job)) : ''}</span></button>${['staged','done','error'].includes(job.status) ? `<button type="button" class="rv-job-remove" data-remove="${job.id}" aria-label="移除 ${esc(job.title)}" title="移除任务">×</button>` : ''}${allowUpload && job.status === 'error' ? `<button type="button" class="rv-job-retry" data-retry="${job.id}">${svg('retry')}重试</button>` : ''}</article>`).join(''));
    const job = jobs.find(item => item.id === selected) || jobs[0];
    if (!job) { $('#rvResult').innerHTML = ''; renderedId = ''; renderedResult = null; return; }
    selected = job.id;
    if (job.result) {
      if (renderedId !== job.id || renderedResult !== job.result) { showResult(job.result); renderedId = job.id; renderedResult = job.result; }
    } else {
      renderedResult = null;
      renderedId = '';
      $('#rvResult').innerHTML = `<div class="rv-result-placeholder ${job.status === 'error' ? 'is-error' : ''}"><span class="rv-placeholder-icon">${working(job) ? '<i class="rv-spinner"></i>' : svg(job.status === 'error' ? 'retry' : 'sparkle')}</span><span class="rr-kicker">${job.status === 'error' ? 'LET’S TRY AGAIN' : 'A BETTER GAME, ONE STEP AWAY'}</span><h3>${esc(job.title)}</h3><p>${esc(job.status === 'error' ? job.error : job.note || (job.status === 'staged' ? '文件已准备好，点击「开始审核」一起出发。' : '等待前面的任务，随后自动开始。'))}</p>${job.status === 'error' ? '<small>这次未完成审核，没有给游戏打分。</small>' : stageSteps(job)}${agentWaiting(job)?'<button type="button" class="rr-button rr-button-dark" id="rvResumeAgent">复制继续审核指令</button>':''}${active(job) || job.status === 'waiting' ? progressHtml(jobProgress(job)) : ''}</div>`;
      if($('#rvResumeAgent'))$('#rvResumeAgent').onclick=()=>copyText(resumePrompt(job));
    }
  };
  if(allowUpload)$('#rvChoose').onclick = () => $('#rvFile').click();
  if(allowUpload)$('#rvFile').onchange = event => { const files = [...event.target.files]; event.target.value = ''; void addFiles(files); };
  if(allowUpload)$('#rvGo').onclick = () => { started = true; for (const job of jobs) if (job.status === 'staged') { job.status = 'waiting'; job.startedAt = Date.now(); } refresh(); void pump(); };
  const removeJob = async job => {
    if (!job) return;
    if (job.requestId) {
      try { await api('DELETE', `review/jobs/${job.requestId}`); }
      catch (error) { if (error.status !== 404 || job.status !== 'error') throw error; }
    }
    job.progress?.dismiss();
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
    refresh();
  };
  $('#rvJobs').onclick = async event => {
    const select = event.target.closest('[data-select]');
    if (select) { selected = select.dataset.select; refresh(); }
    const remove = event.target.closest('[data-remove]');
    if (remove) { remove.disabled = true; try { await removeJob(jobs.find(job => job.id === remove.dataset.remove)); } catch (error) { dependencies.feedback(`移除失败：${error.message}`, true); remove.disabled = false; } }
    const retry = event.target.closest('[data-retry]');
    if (retry) retryJob(jobs.find(item => item.id === retry.dataset.retry));
  };
  $('#rvClear').onclick = async () => {
    const button = $('#rvClear'); button.disabled = true;
    const results = await Promise.allSettled(jobs.filter(job => ['done','error'].includes(job.status)).map(removeJob));
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) dependencies.feedback(`${failed.length} 个任务移除失败，请重试。`, true);
    refresh();
  };
  if(allowUpload)$('#rvRetryAll').onclick = () => {
    const failed = jobs.filter(job => job.status === 'error');
    const retryable = failed.filter(job => job.html);
    retryable.forEach(retryJob);
    dependencies.feedback(`已重新排队 ${retryable.length} 个任务，重新审核按新的一次计算。${failed.length > retryable.length ? `另有 ${failed.length-retryable.length} 个临时文件已清理，需要重新上传。` : ''}`);
  };
  $('#rvExportAll').onclick = () => {
    const reports = [...new Map(jobs.filter(job => job.result).map(job => [job.result.id ?? job.id,job.result])).values()];
    download(`reviews-${new Date().toISOString().slice(0,10)}.md`, reports.map(reportText).join('\n\n---\n\n'));
    dependencies.feedback(`已导出 ${reports.length} 份已加载的报告。`);
  };
  let historyItems = [];
  const renderHistory = () => {
    const query = $('#rvHistorySearch').value.trim().toLocaleLowerCase();
    const filter = $('#rvHistoryFilter').value;
    const list = historyItems.filter(report => String(report.title).toLocaleLowerCase().includes(query) && (filter === 'all' || (filter === 'pass' ? report.score >= 7 : report.score < 7)));
    $('#rvHistoryCount').textContent = `${list.length} / ${historyItems.length} 份报告`;
    $('#rvHistory').innerHTML = list.length ? list.map(report => `<div class="rv-history-row"><button type="button" class="rv-history-item" data-history="${report.id}"><span class="rv-history-mark ${report.score >= 7 ? 'is-pass' : ''}">${svg(report.score >= 7 ? 'check' : 'file')}</span><b>${esc(report.title)}</b><span class="rv-history-score">${esc(report.score)}<small>/9</small></span><span class="rr-verdict ${report.score >= 7 ? 'is-pass' : 'is-revise'}">${report.score >= 7 ? '模拟通过' : '建议修改'}</span><time>${esc(date(report.created_at))}</time><span>↗</span></button>${!allowUpload ? `<button type="button" class="rv-history-remove" data-delete-history="${report.id}" aria-label="删除 ${esc(report.title)} 的审核记录" title="删除审核记录">×</button>` : ''}</div>`).join('') : `<p class="rr-empty-note">${historyItems.length ? '没有匹配的报告，试试其他名称或结果。' : '还没有历史报告。连接自己的 Agent，审核第一款本地游戏。'}</p>`;
  };
  $('#rvHistorySearch').oninput = renderHistory;
  $('#rvHistoryFilter').onchange = renderHistory;
  const history = async () => {
    try {
      const list = await withReviewProgress('读取审核记录', () => api('GET', 'reviews'));
      if (!current()) return;
      historyItems = list; renderHistory();
    } catch (error) { if (current()) $('#rvHistory').textContent = `记录暂时无法读取：${error.message}`; }
  };
  $('#rvHistory').onclick = async event => {
    const remove = event.target.closest('[data-delete-history]');
    if (remove) {
      if (!confirm('从你的审核记录中移除这份报告？管理员仍可查看原始记录。')) return;
      remove.disabled = true;
      try {
        await api('DELETE', `reviews/${remove.dataset.deleteHistory}`);
        historyItems = historyItems.filter(report => String(report.id) !== remove.dataset.deleteHistory);
        for (let i = jobs.length - 1; i >= 0; i--) if (String(jobs[i].result?.id) === remove.dataset.deleteHistory) { jobs[i].progress?.dismiss(); jobs.splice(i, 1); }
        renderHistory(); refresh();
      } catch (error) { dependencies.feedback(`删除失败：${error.message}`, true); remove.disabled = false; }
      return;
    }
    const button = event.target.closest('[data-history]');
    if (!button) return;
    button.disabled = true;
    try {
      const report = await withReviewProgress('读取审核报告', () => api('GET', `reviews/${button.dataset.history}`));
      if (!current()) return;
      let job = jobs.find(item => item.result?.id === report.id);
      if (!job) { job = { id: `history-${report.id}`, title: report.title, result: report, status: 'done' }; jobs.push(job); }
      else { job.result = report; job.title = report.title; }
      selected = job.id; refresh();
      $('#rvBatch').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    } catch (error) { dependencies.feedback(error.message, true); } finally { button.disabled = false; }
  };
  $('#rvRefreshHistory').onclick = () => void history();
  dependencies.updateHistory = history;
  dependencies.updateUsage = async () => {if(current())$('#rvQuota').textContent='审核由自己的 Agent 与模型执行';};
  $('#rvQuota').insertAdjacentHTML('afterend','<span id="rvWorkerStatus" class="rv-quota" role="status">正在读取智能助手授权状态…</span>');
  $('#rvDropzone').closest('.review-upload-panel').insertAdjacentHTML('beforeend',`<details class="rv-device"><summary>智能助手接入</summary><div class="rv-agent-prompt"><b>复制给智能助手</b><p id="rvAgentText">请阅读 ${location.origin}/agent.md，连接我的审核账号。首次连接时请让我生成一次性配对码并直接在本对话中询问我，收到后由你自行完成配对，不要让我打开命令窗口。使用你自己的模型采集并审核指定的本地 HTML 游戏，完成初评和同模型复核后提交中文报告。提交游戏时，使用你已有的 creator-hub 授权查询本人准确作品和投稿版本的真人分数与意见；没有结果时照常完成 AI 审核，有结果后再回填。</p><button class="rr-button" id="rvCopyAgent">复制接入指令</button></div><div class="rv-device-actions"><button class="rr-button" id="rvPair">生成一次性配对码</button><a class="rr-button" href="/agent.md" target="_blank" rel="noopener">查看接入说明 ↗</a></div><p>首次使用需授权，配对码 5 分钟内有效。</p><div id="rvPairCode" role="status"></div><div id="rvDevices"></div></details>`);
  $('#rvPair').onclick=async()=>{
    const button=$('#rvPair');button.disabled=true;
    try{const value=await withReviewProgress('生成本机配对码',()=>api('POST','review/device/pairing',{}));if(!current())return;$('#rvPairCode').innerHTML=`<label>配对码 · 5 分钟内一次有效<input type="text" readonly value="${esc(value.code)}" aria-label="配对码"></label><button class="rr-button" id="rvCopyCode">复制配对码</button>`;$('#rvCopyCode').onclick=()=>copyText(value.code);setTimeout(()=>{if(current())$('#rvPairCode').replaceChildren();},300000);}
    catch(error){dependencies.feedback(error.message,true);}finally{button.disabled=false;}
  };
  $('#rvCopyAgent').onclick=()=>copyText($('#rvAgentText').textContent);
  const workerStatus=async()=>{
    if(!current())return;
    try{const status=await api('GET','review/worker-status');if(!current())return;const authorized=status.devices.filter(d=>!d.revoked&&Date.parse(d.expires_at)>Date.now());const setup=$('.review-setup');if(setup&&!setup.dataset.initialized){setup.open=!authorized.length;setup.dataset.initialized='true';if(!authorized.length)$('.rv-device').open=true;}$('#rvWorkerStatus').textContent=status.online?'智能助手最近已连接 · 本机采集与模型审核':authorized.length?'智能助手已授权 · 按需执行即可':'尚未授权智能助手 · 展开下方接入';$('#rvDevices').innerHTML=authorized.map(d=>`<div class="rv-device-row"><span><b>${esc(d.name)}</b> · ${d.online?'最近已连接':'已授权'}<small>授权至 ${esc(date(d.expires_at))}${d.last_seen?' · 最近连接 '+esc(date(d.last_seen)):''}</small></span><button class="rr-button" data-revoke="${esc(d.id)}">撤销授权</button></div>`).join('')||'<p>尚未授权设备，让智能助手按接入说明完成一次配对。</p>';}
    catch{if(current())$('#rvWorkerStatus').textContent='智能助手授权状态暂时无法读取';}
  };
  $('#rvDevices').onclick=async event=>{const button=event.target.closest('[data-revoke]');if(!button)return;button.disabled=true;try{await withReviewProgress('撤销智能助手授权',()=>api('POST','review/device/revoke',{id:button.dataset.revoke}));await workerStatus();}catch(error){dependencies.feedback(error.message,true);button.disabled=false;}};
  void workerStatus();
  const workerTimer=setInterval(()=>{if(!current()){clearInterval(workerTimer);return;}if(!document.hidden)void workerStatus();},60000);
  refresh();
  void dependencies.updateUsage();
  void history();
  try {
    const remote = await withReviewProgress('恢复后台审核任务', () => api('GET', 'review/jobs'));
    for (const item of remote) {
      if (!['queued', 'running', 'error'].includes(item.status) || jobs.some(job => job.requestId === item.id)) continue;
      const job = { id: item.id, requestId: item.id, title: item.title, filename:item.filename, stage:item.stage, status: item.status,modelExecutor:item.model_executor,updatedAt:Date.parse(item.updated_at)||Date.now(),error:reviewError(item.error),remoteFailed:item.status==='error',note: '正在读取原任务的最新状态' };
      job.startedAt = Date.parse(item.created_at) || Date.now();
      job.progress = startTask(`AI 审核 · ${job.title}`,{key:`review-${job.id}`,compact:true,tray:false,detail:job.note,startedAt:job.startedAt});
      jobs.push(job); selected ||= job.id;
      if (item.status === 'error') {
        failJobProgress(job);
        job.progress.update({finishedAt:Date.parse(item.updated_at) || Date.now()});
      } else { started = true; void pollJob(job); }
    }
    refresh();
  } catch { /* Older history still renders if job recovery is temporarily unavailable. */ }
  // Returning from another workbench tab must restart the shared observer.
  for(const job of jobs.filter(active))void pollJob(job);
}
