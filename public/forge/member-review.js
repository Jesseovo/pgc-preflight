import { mountReviewWorkspace } from './review-workspace.js';
import { probeChecks } from './review-capture.js';
import { withProgress, progressHtml } from './progress.js';

// 成员专用入口，只包含本人的审核工作台。
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, data) {
  const response = await fetch('/api/forge/' + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(60000),
  });
  let value;
  try { value = await response.json(); } catch { throw new Error('审核服务暂时无响应，请稍后重试。'); }
  if (response.status === 401) location.replace('/login');
  if (!response.ok) throw Object.assign(new Error(value.error || '请求未完成，请稍后重试。'), { status: response.status });
  return value;
}
function toast(message) {
  const node = $('#toast'); node.textContent = message; node.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 3500);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { toast('复制失败，请手动选择文字复制。'); }
}
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function openModal(title, html) {
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').hidden = false;
}
$('#modalClose').onclick = () => { $('#modal').hidden = true; };
$('#modal').onclick = event => { if (event.target === $('#modal')) $('#modal').hidden = true; };
$('#loginForm').onsubmit = event => { event.preventDefault(); location.replace('/login'); };
$('#view').innerHTML = progressHtml({ label: '正在连接审核工作台', detail: '正在读取本人的审核记录…' });
withProgress('连接审核工作台', () => mountReviewWorkspace({
  view: $('#view'), api, alive: () => true, topics: [],
  setProbing: () => {}, probeChecks, copyText, download, openModal,
  checksHtml: checks => `<ul class="checks">${checks.map(check => `<li><span>${check.level === 'ok' ? '✓' : '·'}</span><span>${escape(check.text)}</span></li>`).join('')}</ul>`,
})).catch(error => { $('#view').textContent = error.message; });
