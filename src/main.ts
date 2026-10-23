import { createIcons, icons } from 'lucide';
import './style.css';
import type { CheckReport, Status } from './types';
import { MAX_BATCH, MAX_FILE_BYTES, makeReportText } from '../server/policy';

type Job = { id: string; file: File; state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'; report?: CheckReport; error?: string };
const jobs: Job[] = [];
let selectedId = '';
let processing = false;
let paused = false;
let dragDepth = 0;
let currentAbort: AbortController | undefined;
let currentUser: {displayName:string;role:'admin'|'member';canReview:boolean}|null=null;
const labels: Record<Status, string> = { pass: '基础检查通过', issue: '发现基础问题', review: '需人工确认' };
const icon = (name: string, cls = '') => `<i data-lucide="${name}" class="${cls}" aria-hidden="true"></i>`;
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header class="header"><div class="header-inner">
    <a class="brand" href="/" aria-label="PGC Preflight 首页"><img src="/favicon.svg" alt="" width="34" height="34"/><span>PGC <b>Preflight</b></span><span class="beta">BETA</span></a>
    <div class="header-right"><span class="service" id="service"><span class="service-dot"></span>正在连接检查服务</span><span id="user-menu"></span><button class="icon-button" id="scope-button" title="检查范围" aria-label="查看检查范围">${icon('circle-help')}</button></div>
  </div></header>
  <main>
    <section class="intro"><div><div class="eyebrow"><span></span> GAME CHECK, BEFORE YOU SHIP</div><h1>上传前，先过一遍<span>。</span></h1><p>把基础问题留在提交前，把时间留给好游戏。</p></div><div class="intro-note">${icon('scan-line')}<span>基础体检<br><b>人工终审</b></span></div></section>
    <section class="workspace" aria-label="游戏检查工作台">
      <div class="upload-panel">
        <div class="section-label"><span><b>01</b> 添加游戏</span><span class="muted">支持批量检查</span></div>
        <div class="dropzone" id="dropzone">
          <div class="file-illustration" aria-hidden="true"><div class="mini-file back-file">${icon('code-xml')}</div><div class="mini-file front-file">${icon('gamepad-2')}<span>HTML</span><div class="file-check">${icon('check')}</div></div></div>
          <h2>把游戏拖到这里</h2><p>一次放入多个 HTML，剩下的交给我们</p>
          <button class="primary-button" id="choose-files">${icon('plus')} 选择游戏文件</button>
          <div class="upload-meta">.html / .htm <span>·</span> 单个 ≤ 8 MB <span>·</span> 每批最多 20 个</div>
          <input type="file" id="file-input" accept=".html,.htm,text/html" multiple hidden />
        </div>
        <div class="upload-bottom"><span>${icon('shield-check')}文件仅用于本次检查，不长期保存</span><button class="text-button" id="demo-button">没有文件？试试示例 ${icon('arrow-up-right')}</button></div>
      </div>
      <aside class="scope-panel"><div class="section-label"><span><b>02</b> 我们会检查</span><span class="small-tag">BASIC</span></div>
        <div class="scope-items">
          ${[['monitor-check','打开与加载','白屏、缺失资源、加载异常'],['mouse-pointer-2','开始与操作','能否进入，输入是否有响应'],['smartphone','手机显示','关键文字、按钮是否明显出界'],['rotate-ccw','基础流程','已到达页面的结束与重试']].map(([i,t,d])=>`<div class="scope-item"><div class="scope-icon">${icon(i)}</div><div><h3>${t}</h3><p>${d}</p></div></div>`).join('')}
        </div><div class="human-note">${icon('user-round-check')}<p>手感、美感、好不好玩<br><b>留给人来判断。</b></p></div>
      </aside>
    </section>
    <div class="access-banner" id="access-banner" hidden></div>
    <section class="results" aria-label="检查结果">
      <div class="results-heading"><div><h2>检查队列 <span id="queue-count">00</span></h2><p id="queue-caption">添加文件后，检查会自动开始</p></div><div class="queue-actions"><button class="subtle-button" id="pause-button" hidden>${icon('pause')}暂停队列</button><button class="subtle-button" id="export-button" hidden>${icon('download')}导出报告</button><button class="icon-button" id="clear-button" title="清空已完成项目" aria-label="清空已完成项目" hidden>${icon('list-x')}</button></div></div>
      <div id="queue-content"><div class="empty-state"><div class="empty-line"></div><div class="empty-icon">${icon('list-checks')}</div><p>好游戏，从少一个小问题开始。</p><span>你的检查结果会出现在这里</span><div class="empty-line"></div></div></div>
    </section>
    <footer><span>PGC Preflight <span class="footer-separator">/</span> 给创作者的一次轻量检查</span><span>模型检查，人工终审 <a href="/admin" class="admin-link" aria-label="模型管理">${icon('settings-2')}</a></span></footer>
  </main>
  <div id="toast" role="status" aria-live="polite"></div>
  <dialog id="scope-dialog"><div class="dialog-heading"><h2>检查到哪里？</h2><button class="icon-button" id="close-scope" aria-label="关闭">${icon('x')}</button></div><p>大模型查看实际游戏画面和运行记录，自主决定基本操作，再给出审核结论。程序负责浏览器取证，不用固定规则给游戏打分。</p><ul><li>模型检查加载、脚本异常、缺失资源和明显的文字或按钮显示问题。</li><li>模型识别开始与重试入口；无法确认操作是否生效时，交给人工。</li><li>只覆盖本次实际到达的页面，不强制通关。</li><li>需要在管理页配置支持图片输入的模型；未配置时不会生成审核结论。</li><li>检查环境仅放行常用公共 CDN；其他外部依赖需结合环境限制判断。</li></ul><div class="dialog-note">基础检查通过 ≠ 最终审核通过。<br>不评价操作手感、美术、趣味性或难度。</div></dialog>
  <dialog id="image-dialog"><button class="icon-button image-close" id="close-image" aria-label="关闭截图">${icon('x')}</button><img id="full-image" alt="游戏检查截图" /></dialog>
  <dialog id="password-dialog"><div class="dialog-heading"><h2>修改我的密码</h2><button class="icon-button" id="close-password" aria-label="关闭密码修改">${icon('x')}</button></div><form id="password-form"><label for="current-password">原密码</label><input id="current-password" type="password" autocomplete="current-password" required maxlength="128"/><label for="next-password">新密码</label><input id="next-password" type="password" autocomplete="new-password" minlength="6" maxlength="128" required/><button class="primary-button" type="submit">保存新密码</button><p id="password-message" class="form-message" role="status"></p></form></dialog>
`;
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const refreshIcons = () => createIcons({ icons, attrs: { 'stroke-width': 1.7 } });
refreshIcons();

$('#choose-files').addEventListener('click', () => $<HTMLInputElement>('#file-input').click());
$('#file-input').addEventListener('change', event => { const input = event.target as HTMLInputElement; addFiles([...input.files || []]); input.value = ''; });
$('#demo-button').addEventListener('click', () => addFiles([
  new File([demoHtml(false)], 'orbit-demo.html', { type: 'text/html' }),
  new File([demoHtml(true)], 'broken-demo.html', { type: 'text/html' }),
]));
$('#scope-button').addEventListener('click', () => $<HTMLDialogElement>('#scope-dialog').showModal());
$('#close-scope').addEventListener('click', () => $<HTMLDialogElement>('#scope-dialog').close());
$('#close-image').addEventListener('click', () => $<HTMLDialogElement>('#image-dialog').close());
$('#close-password').addEventListener('click',()=>$<HTMLDialogElement>('#password-dialog').close());
$('#password-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$<HTMLButtonElement>('#password-form button');button.disabled=true;
  try{const response=await fetch('/api/auth/password',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:$<HTMLInputElement>('#current-password').value,newPassword:$<HTMLInputElement>('#next-password').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'修改失败。');toast('密码已更新，请重新登录。');setTimeout(()=>location.assign('/login'),1200);}
  catch(error){$('#password-message').textContent=error instanceof Error?error.message:'修改失败。';}finally{button.disabled=false;}
});
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
$('#pause-button').addEventListener('click', () => { paused = !paused; renderQueue(); if (!paused) void runQueue(); });
$('#clear-button').addEventListener('click', () => { for (let i = jobs.length - 1; i >= 0; i--) if (!['running','queued'].includes(jobs[i].state)) jobs.splice(i, 1); renderQueue(); });
$('#export-button').addEventListener('click', () => download(jobs.filter(job => job.report).map(job => makeReportText(job.report!)).join('\n\n---\n\n'), 'pgc-preflight-report.md', 'text/markdown'));
document.addEventListener('dragenter', event => { event.preventDefault(); if (event.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropzone').classList.add('drag-over'); } });
document.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').classList.remove('drag-over'); } });
document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('#dropzone').classList.remove('drag-over'); addFiles([...event.dataTransfer?.files || []]); });
window.addEventListener('beforeunload', event => { if (jobs.some(job => job.state === 'running' || job.state === 'queued')) { event.preventDefault(); event.returnValue = ''; } });

function addFiles(files: File[]) {
  if(!currentUser){toast('请先使用管理员开通的账号登录。');$('#access-banner').scrollIntoView({block:'center',behavior:'smooth'});return;}
  if(!currentUser.canReview){toast('当前账号没有检查权限，请联系管理员。');return;}
  const errors: string[] = [];
  let added = 0;
  for (const file of files) {
    if (!/\.html?$/i.test(file.name)) { errors.push(`${file.name}：仅支持 HTML 文件`); continue; }
    if (!file.size) { errors.push(`${file.name}：文件为空`); continue; }
    if (file.size > MAX_FILE_BYTES) { errors.push(`${file.name}：超过 8 MB`); continue; }
    if (jobs.filter(job => ['queued','running'].includes(job.state)).length >= MAX_BATCH) { errors.push('待检查文件最多 20 个，请等待本批完成'); break; }
    if (jobs.some(job => job.file.name === file.name && job.file.size === file.size && job.file.lastModified === file.lastModified)) { errors.push(`${file.name}：已在队列中`); continue; }
    jobs.push({ id: crypto.randomUUID(), file, state: 'queued' }); added++;
  }
  if (errors.length) toast(errors.slice(0, 2).join('；'));
  if (added) { selectedId ||= jobs[0].id; renderQueue(); void runQueue(); }
}

async function runQueue() {
  if (processing || paused) return;
  processing = true;
  while (!paused) {
    const job = jobs.find(item => item.state === 'queued');
    if (!job) break;
    job.state = 'running';
    currentAbort = new AbortController();
    renderQueue();
    const timeout = setTimeout(() => currentAbort?.abort('timeout'), 180000);
    try {
      const response = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: job.file.name, html: await job.file.text() }), signal: currentAbort.signal });
      const result = await response.json() as CheckReport & { error?: string };
      if (!response.ok) throw new Error(result.error || `服务返回 ${response.status}，请重试。`);
      if (job.state as string !== 'cancelled') { job.report = result; job.state = 'done'; }
    } catch (error) {
      if (job.state as string !== 'cancelled') { job.state = 'error'; job.error = currentAbort.signal.aborted ? '本次请求超时，请重试。' : error instanceof Error ? error.message : '网络连接失败，请重试。'; }
    } finally { clearTimeout(timeout); currentAbort = undefined; renderQueue(); }
  }
  processing = false;
  renderQueue();
}

function renderQueue() {
  const completed = jobs.filter(job => job.state === 'done').length;
  const pending = jobs.filter(job => job.state === 'queued').length;
  const running = jobs.some(job => job.state === 'running');
  $('#queue-count').textContent = String(jobs.length).padStart(2, '0');
  $('#queue-caption').textContent = jobs.length ? `${completed} 个已完成${running ? ' · 正在检查 1 个' : ''}${pending ? ` · ${pending} 个${paused ? '已暂停' : '等待中'}` : ''}` : '添加文件后，检查会自动开始';
  $('#pause-button').hidden = !pending && !running;
  $('#pause-button').innerHTML = `${icon(paused ? 'play' : 'pause')}${paused ? '继续队列' : '暂停队列'}`;
  $('#export-button').hidden = completed === 0;
  $('#clear-button').hidden = !jobs.some(job => !['running','queued'].includes(job.state));
  if (!jobs.length) { $('#queue-content').innerHTML = '<div class="empty-state"><div class="empty-icon">'+icon('list-checks')+'</div><p>好游戏，从少一个小问题开始。</p><span>你的检查结果会出现在这里</span></div>'; refreshIcons(); return; }
  if (!jobs.some(job => job.id === selectedId)) selectedId = jobs[0].id;
  const selected = jobs.find(job => job.id === selectedId)!;
  $('#queue-content').innerHTML = `<div class="result-workspace"><div class="file-list" aria-label="文件列表">${jobs.map(job => {
    const status = job.report?.status;
    const stateClass = status || job.state;
    const stateText = job.state === 'done' ? labels[status!] : { queued: '等待检查', running: '检查中', error: '检查未完成', cancelled: '已取消' }[job.state];
    return `<button class="file-row ${job.id === selectedId ? 'selected' : ''}" data-select="${job.id}" aria-pressed="${job.id === selectedId}"><div class="file-type">${icon('file-code-2')}</div><div class="file-info"><strong>${escape(job.file.name)}</strong><span>${formatSize(job.file.size)}${job.report ? ` · ${(job.report.durationMs/1000).toFixed(1)}s` : ''}</span></div><span class="status-pill ${stateClass}">${job.state === 'running' ? '<span class="spinner"></span>' : '<span class="status-dot"></span>'}${stateText}</span>${icon('chevron-right','row-arrow')}</button>`;
  }).join('')}</div><div class="report-panel">${renderJob(selected)}</div></div>`;
  document.querySelectorAll<HTMLButtonElement>('[data-select]').forEach(button => button.addEventListener('click', () => { selectedId = button.dataset.select!; renderQueue(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-retry]').forEach(button => button.addEventListener('click', () => { const job = jobs.find(item => item.id === button.dataset.retry)!; job.state = 'queued'; job.error = undefined; renderQueue(); void runQueue(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach(button => button.addEventListener('click', () => { const job = jobs.find(item => item.id === button.dataset.cancel)!; const wasRunning = job.state === 'running'; job.state = 'cancelled'; if (wasRunning) currentAbort?.abort(); renderQueue(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(makeReportText(selected.report!)); toast('检查报告已复制'); } catch { download(makeReportText(selected.report!), 'pgc-report.md', 'text/markdown'); toast('无法直接复制，已下载报告'); } }));
  document.querySelectorAll<HTMLButtonElement>('[data-image]').forEach(button => button.addEventListener('click', () => { const item = selected.report!.evidence.find(item => item.id === button.dataset.image)!; $<HTMLImageElement>('#full-image').src = item.image; $<HTMLImageElement>('#full-image').alt = item.label; $<HTMLDialogElement>('#image-dialog').showModal(); }));
  refreshIcons();
}

function renderJob(job: Job): string {
    if (!job.report) return `<div class="job-placeholder"><div class="placeholder-icon ${job.state}">${job.state === 'running' ? '<span class="big-spinner"></span>' : icon(job.state === 'error' ? 'cloud-off' : job.state === 'cancelled' ? 'circle-pause' : 'hourglass')}</div><h3>${{ queued: paused ? '队列已暂停' : '排队中，很快就好', running: '模型正在给游戏做基础体检', error: '这次没能完成检查', cancelled: '已取消本次检查', done: '' }[job.state]}</h3><p>${job.state === 'error' ? escape(job.error || '') : job.state === 'running' ? '模型正在查看画面、操作游戏并分析运行记录，通常需要几十秒' : job.state === 'queued' ? '每个游戏单独运行，按加入顺序依次检查' : '文件仍保留在当前页面，可以重新检查'}</p>${['error','cancelled'].includes(job.state) ? `<button class="subtle-button" data-retry="${job.id}">${icon('rotate-ccw')}重新检查</button>` : `<button class="text-button" data-cancel="${job.id}">取消这个文件</button>`}</div>`;
  const report = job.report;
  const issues = report.findings.filter(item => item.status !== 'pass');
  const passes = report.findings.filter(item => item.status === 'pass');
  return `<div class="report-heading"><div><div class="eyebrow">CHECK REPORT</div><h3>${escape(report.title)}</h3></div><button class="subtle-button" data-copy="true">${icon('copy')}复制报告</button></div>
    <div class="verdict ${report.status}">${icon(report.status === 'issue' ? 'circle-alert' : report.status === 'review' ? 'scan-eye' : 'circle-check')}<div><strong>${labels[report.status]}</strong><p>${report.status === 'issue' ? '先处理下面的问题，再提交人工审核。' : report.status === 'review' ? '部分项目无法自动确认，请结合截图人工查看。' : '本次覆盖范围内未发现基础故障，可以提交人工审核。'}</p></div></div>
    ${issues.length ? `<div class="finding-list">${issues.map(item => findingMarkup(item)).join('')}</div>` : ''}
    ${report.evidence.length ? `<div class="evidence-heading">实际运行截图 <span>点击放大</span></div><div class="evidence-grid">${report.evidence.map(item => `<button class="evidence-card" data-image="${item.id}"><div class="screenshot-wrap"><img src="${item.image}" alt="${escape(item.label)}" loading="lazy" /></div><span>${escape(item.label)}</span></button>`).join('')}</div>` : ''}
    ${passes.length ? `<details class="coverage" open><summary>${icon('check-check')}已完成 ${passes.length} 项基础检查</summary><div>${passes.map(item=>findingMarkup(item)).join('')}</div></details>` : ''}
    <details class="coverage"><summary>${icon('scan')}操作记录与未覆盖项目</summary><div class="coverage-content"><h4>本次操作</h4>${report.actions.length ? `<ul>${report.actions.map(action=>`<li>${escape(action)}</li>`).join('')}</ul>` : '<p>尚未完成操作。</p>'}<h4>未覆盖 / 需人工判断</h4><ul>${report.uncovered.map(item=>`<li>${escape(item)}</li>`).join('')}</ul><p class="engine">${escape(report.engine)}</p></div></details>
    <div class="report-footnote">${icon('info')}本次体检不代替最终审核，游戏质量由人工判断。</div>`;
}
function findingMarkup(item: CheckReport['findings'][number]) { return `<div class="finding ${item.status}"><div class="finding-symbol">${icon(item.status === 'issue' ? 'circle-alert' : item.status === 'review' ? 'circle-help' : 'check')}</div><div><h4>${escape(item.title)}</h4><p>${escape(item.detail)}</p>${item.steps ? `<div class="repro">复现 / 处理：${escape(item.steps)}</div>` : ''}</div></div>`; }
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
function download(text: string, filename: string, type: string) { const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url), 1000); }
async function healthCheck() { try { const response = await fetch('/api/health'); if (!response.ok) throw new Error();const data=await response.json(); $('#service').innerHTML = data.configured?'<span class="service-dot online"></span>审核模型已就绪':'<span class="service-dot offline"></span><a href="/admin">待配置审核模型</a>'; } catch { $('#service').innerHTML = '<span class="service-dot offline"></span>服务暂不可用，可稍后重试'; } }
void healthCheck();
void loadIdentity();

async function loadIdentity(){
  const banner=$('#access-banner');
  try{
    const response=await fetch('/api/auth/me');
    if(!response.ok)throw new Error();
    currentUser=await response.json();
    $('#user-menu').innerHTML=`<details class="user-dropdown"><summary>${icon('user-round')}<span>${escape(currentUser!.displayName)}</span></summary><div>${currentUser!.role==='admin'?'<a href="/admin">管理后台</a>':'<button id="change-password">修改密码</button>'}<button id="user-logout">退出登录</button></div></details>`;
    $('#change-password')?.addEventListener('click',()=>$<HTMLDialogElement>('#password-dialog').showModal());
    $('#user-logout').addEventListener('click',async()=>{try{await fetch(currentUser!.role==='admin'?'/api/admin/logout':'/api/auth/logout',{method:'POST'});}finally{location.assign('/login');}});
    if(!currentUser!.canReview){banner.hidden=false;banner.innerHTML=`${icon('lock-keyhole')}<span>你的账号尚未开通检查权限，请联系管理员。</span>`;}
    else banner.hidden=true;
  }catch{
    currentUser=null;
    $('#user-menu').innerHTML='<a class="login-link" href="/login">成员登录</a>';
    banner.hidden=false;banner.innerHTML=`${icon('users')}<span>检查需要团队账号。<a href="/login">成员登录</a><span class="banner-divider">/</span><a href="/admin">管理员登录</a></span>`;
  }
  refreshIcons();
}

function demoHtml(broken: boolean) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${broken ? '出界与异常示例' : 'Orbit · 交互示例'}</title><style>*{box-sizing:border-box}body{margin:0;background:#101e1b;color:#eef6df;font:16px system-ui;min-height:100dvh;display:grid;place-items:center;text-align:center;overflow:hidden}main{width:100%;padding:30px}h1{font-size:36px;letter-spacing:-1px}p{color:#a8bcb2;line-height:1.7}button{border:0;border-radius:30px;padding:15px 36px;background:#cfefa2;color:#173c2e;font:600 17px system-ui;margin-top:20px}.orb{width:140px;height:140px;border:1px solid #648875;border-radius:50%;margin:40px auto;position:relative}.orb:after{content:'';position:absolute;width:22px;height:22px;background:#cfefa2;border-radius:50%;top:25px;left:0;box-shadow:0 0 30px #cfefa240}.tag{font-size:11px;letter-spacing:3px;color:#82a48d}${broken ? 'h1{width:800px;white-space:nowrap;text-align:left}' : ''}</style><main><span class="tag">PGC / SAMPLE</span><div class="orb"></div><h1>${broken ? '这是一段超出手机屏幕的标题文字' : 'A little orbit.'}</h1><p id="message">${broken ? '这是用于验证错误检测的合成示例。' : '轻触开始，进入示例交互。'}</p><button id="start">开始游戏</button></main><script>document.querySelector('#start').onclick=function(){${broken ? "throw new Error('DEMO: 游戏开始时发生脚本异常')" : "this.remove();document.querySelector('#message').textContent='已进入游戏。这个示例用于验证基本界面切换。';setTimeout(()=>{const b=document.createElement('button');b.textContent='重新开始';b.onclick=()=>location.reload();document.querySelector('main').append(b)},300)"}};</script></html>`;
}
