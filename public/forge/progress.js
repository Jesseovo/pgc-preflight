// Shared waiting feedback for the workbench, login and administration pages.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function elapsed(since, until = Date.now()) {
  const seconds = Math.max(0, Math.floor((until - since) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}
export function progressHtml({ label = '正在处理', detail = '', value, total, status = 'running', startedAt, finishedAt } = {}) {
  const known = Number.isFinite(value) && Number.isFinite(total) && total > 0;
  const percent = known ? Math.max(0, Math.min(100, value / total * 100)) : 0;
  const showElapsed = Number.isFinite(startedAt) && status === 'running';
  const waitedMinutes = showElapsed ? Math.floor((Date.now() - startedAt) / 60000) : 0;
  const elapsedText = waitedMinutes ? `约 ${waitedMinutes} 分钟` : '';
  const elapsedMarkup = showElapsed ? `<time data-progress-since="${startedAt}" aria-label="${elapsedText ? `已等待 ${escape(elapsedText)}` : '任务正在处理中'}">${elapsedText ? `已等待 ${escape(elapsedText)}` : ''}</time>` : '';
  return `<div class="pgc-progress is-${status}"><div class="pgc-progress-heading"><strong>${escape(label)}</strong><span>${known ? `${value} / ${total}` : status === 'running' ? '处理中' : status === 'waiting' ? '等待继续' : status === 'done' ? '已完成' : '未完成'}</span></div><div class="pgc-progress-track ${known ? 'is-counted' : status === 'running' ? 'is-indeterminate' : ''}" role="progressbar" aria-label="${escape(label)}" ${known ? `aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${value}"` : ''} aria-valuetext="${escape(detail || label)}"><span style="${known ? `transform:scaleX(${percent / 100})` : ''}"></span></div><div class="pgc-progress-caption"><span>${escape(detail)}</span>${elapsedMarkup}</div></div>`;
}

function installStyles(doc) {
  if (doc.querySelector('[data-pgc-progress-style]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('./progress.css', import.meta.url).href;
  link.dataset.pgcProgressStyle = ''; doc.head.append(link);
}
let host = window;
try { if (parent !== window && parent.location.origin === location.origin) host = parent; } catch {}
installStyles(document);
if(!document.querySelector('link[href="/forge/experience.css"]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/forge/experience.css';document.head.append(link);}
installStyles(host.document);

function createService() {
  const doc = host.document;
  const tasks = new Map();
  const documents = new Map([[doc, null]]);
  let tray;
  let frameObserver;
  let collapsed = true;
  let userToggled = false;
  const paint = () => {
    for (const [document, frame] of documents) if (frame && !frame.isConnected) { documents.delete(document); for (const task of tasks.values()) if (task.owner === document) tasks.delete(task.id); }
    const visibleTasks = [...tasks.values()].filter(task => task.tray === true && !task.views.size);
    if (!tray && !visibleTasks.length) {
      for (const task of tasks.values()) {
        for (const view of task.views) {
          if (!view.isConnected) task.views.delete(view);
          else { const html = progressHtml(task); if (view.__progressHtml !== html) { view.innerHTML = html; view.__progressHtml = html; } }
        }
      }
      return;
    }
    if (!tray) {
      tray = doc.createElement('aside'); tray.className = 'pgc-task-tray'; tray.setAttribute('aria-label', '任务进度');
      doc.body.append(tray);
      tray.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.fold !== undefined) { userToggled = true; collapsed = !collapsed; paint(); return; }
        const task = tasks.get(button.dataset.task);
        if (button.dataset.dismiss !== undefined) { tasks.delete(task?.id); paint(); }
        else task?.action?.();
      });
    }
    tray.hidden = !visibleTasks.length;
    const running = visibleTasks.filter(t => t.status === 'running').length;
    tray.innerHTML = `<button type="button" class="pgc-task-toggle" data-fold aria-expanded="${!collapsed}"><span><i class="${running ? 'is-running' : ''}"></i>${running ? `${running} 个任务进行中` : '任务进度'}</span><span>${collapsed ? '展开 +' : '收起 −'}</span></button><div class="pgc-task-list" ${collapsed ? 'hidden' : ''}>${visibleTasks.sort((a, b) => (b.status === 'running') - (a.status === 'running')).map(task => `<section class="pgc-task" data-task-state="${task.status}" data-task-key="${escape(task.key)}">${progressHtml(task)}<div class="pgc-task-actions">${task.action ? `<button type="button" data-task="${task.id}">${escape(task.actionLabel || '查看')}</button>` : ''}${task.status !== 'running' ? `<button type="button" data-task="${task.id}" data-dismiss aria-label="关闭 ${escape(task.label)}">关闭</button>` : ''}</div></section>`).join('')}</div>`;
    for (const task of tasks.values()) {
      for (const view of task.views) {
        if (!view.isConnected) task.views.delete(view);
        else { const html = progressHtml(task); if (view.__progressHtml !== html) { view.innerHTML = html; view.__progressHtml = html; } }
      }
    }
  };
  return {
    register(document) {
      const frame=document.defaultView?.frameElement || null;documents.set(document,frame);
      if(frame&&!frameObserver){frameObserver=new host.MutationObserver(()=>{if([...documents.values()].some(frame=>frame&&!frame.isConnected)){paint();if(![...documents.values()].some(Boolean)){frameObserver.disconnect();frameObserver=null;}}});frameObserver.observe(doc.body,{childList:true,subtree:true});}
    },
    start(label, options = {}) {
      if (options.compact && !userToggled) collapsed = true;
      const task = { id: host.crypto.randomUUID(), key: options.key || '', label, detail: '请求已发出，请稍候。', status: 'running', startedAt: Date.now(), views: new Set(), ...options };
      const handle = {
        update(patch) { Object.assign(task, patch); paint(); },
        attach(element) { if (element) { task.views.add(element); element.innerHTML = progressHtml(task); } },
        done(detail = '处理完成', action) {
          Object.assign(task, { status: 'done', detail, finishedAt: Date.now(), ...(task.total ? { value: task.total } : {}), ...(action ? { action, actionLabel: '查看结果' } : {}) }); paint();
          host.setTimeout(() => { tasks.delete(task.id); paint(); }, Date.now() - task.startedAt < 500 ? 700 : 2500);
        },
        fail(detail) {
          Object.assign(task, { status: 'error', detail, finishedAt: Date.now() }); paint();
          if (task.tray !== true) host.setTimeout(() => { tasks.delete(task.id); paint(); }, 6000);
        },
        dismiss() { tasks.delete(task.id); paint(); },
      };
      tasks.set(task.id, task); paint();
      return handle;
    },
  };
}
const service = host.__pgcProgress || (host.__pgcProgress = createService());
service.register(document);
export const startTask = (label, options) => service.start(label, { ...options, owner: document });
export async function withProgress(label, work, options) {
  const task = startTask(label, { tray: false, ...options });
  try { const result = await work(task); task.done(); return result; }
  catch (error) { task.fail(error?.message || '操作未完成，请重试。'); throw error; }
}
