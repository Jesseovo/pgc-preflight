import type { AdminContext, AdminMaterial, AdminMemberOption, AdminPage, AdminProject, AdminProjectDetail, AdminRoute, AdminTask, AdminTaskDetail, AdminVersion, MaterialKind } from './contracts';
import './content.css';

type PlayerModule = { gamePlayer(url: string, title?: string): string; bindGamePlayers(root: HTMLElement): void };
type ArtifactModule = { briefDocument(text: string): string; renderMarkdown(text: string): string };
type ContentScope = { ctx: AdminContext; alive: () => boolean; clearFrames: () => void; cleanup: () => void };
const materialLabels: Record<MaterialKind, string> = { expand: '方案', game: '游戏', preview: '样板图', brief: '简报', assets: '美术资产' };
const panelLabels = { overview: '概览', game: '试玩', expand: '设计方案', preview: '样板图', brief: '简报', assets: '资产', tasks: '任务与审核', history: '历史版本', materials: '创作材料' };
const svg = (path: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  arrow: svg('<path d="m14 7-5 5 5 5"/>'), chevron: svg('<path d="m9 5 7 7-7 7"/>'),
  grid: svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>'),
  list: svg('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  game: svg('<path d="M8 8h8a4 4 0 0 1 3.9 3.1l1 4.4a2.5 2.5 0 0 1-4.2 2.3L14 15h-4l-2.7 2.8a2.5 2.5 0 0 1-4.2-2.3l1-4.4A4 4 0 0 1 8 8Z"/><path d="M8 10v4M6 12h4M16 11h.01M18 13h.01"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'),
  download: svg('<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>'),
  clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>'),
};
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error || '请求失败');
const date = (value: string | null | undefined, full = false) => {
  if (!value) return '暂无记录';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(full ? { year: 'numeric' as const } : {}) }).format(parsed);
};
const statusTone = (status: string) => /fail|error|expired|cancel/.test(status) ? 'bad' : /success|complete|done|ready|product/.test(status) ? 'good' : /running|queued|active|processing/.test(status) ? 'active' : 'neutral';
const badge = (label: string, status = '') => `<span class="content-badge content-badge-${statusTone(status)}">${esc(label)}</span>`;
const isActive = (task: AdminTask) => !/success|succeed|complete|done|fail|error|expired|cancel|interrupted/.test(task.status);
const readableTaskDetail = (task: AdminTask) => /^(?:done|success|succeeded|completed|running|queued|pending|capture|review|verify|error|failed)$/.test(task.detail) ? '' : task.detail;
const taskMode = (tasks: AdminTask[], activeCount = 0, agentCount = 0): 'active' | 'agent' | 'idle' => tasks.some(t => t.executor === 'platform' && isActive(t)) || activeCount > 0 ? 'active' : tasks.some(t => t.executor === 'agent' && isActive(t)) || agentCount > 0 ? 'agent' : 'idle';
function safeAdminUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value, location.origin); return url.origin === location.origin && url.pathname.startsWith('/api/admin/') ? `${url.pathname}${url.search}` : null; } catch { return null; }
}
function fixedVersionUrl(url: string, version?: string) {
  if (!version) return url;
  const parsed = new URL(url, location.origin); parsed.searchParams.set('version', version);
  return `${parsed.pathname}${parsed.search}`;
}
function projectPath(project: Pick<AdminProject, 'type' | 'id'>) { return `projects/${project.type}/${encodeURIComponent(project.id)}`; }
function materialPath(project: Pick<AdminProject, 'type' | 'id'>, kind: MaterialKind, version?: string) { return `${projectPath(project)}/material/${kind}${version ? `?version=${encodeURIComponent(version)}` : ''}`; }
function resourceUrl(project: Pick<AdminProject, 'type' | 'id'>, kind: MaterialKind, resource: 'preview' | 'file', version?: string) { return `/api/admin/${projectPath(project)}/material/${kind}/${resource}${version ? `?version=${encodeURIComponent(version)}` : ''}`; }
function query(route: AdminRoute, pageSize: number) {
  const params = new URLSearchParams({ range: route.range, page: String(route.page), pageSize: String(pageSize) });
  if(route.from&&route.to){params.set('from',route.from);params.set('to',route.to);}
  if(route.view==='works'&&route.section==='first-products')params.set('firstProducts','1');
  for (const key of ['owner', 'status', 'type', 'q'] as const) if (route[key] && route[key] !== 'all') params.set(key, route[key]);
  return params;
}
export function contentListRequest(route: AdminRoute): string | undefined {
  if (route.id || !['works', 'tasks'].includes(route.view)) return;
  const params = query(route, route.view === 'works' ? 24 : 25);
  const project = route.section?.match(/^project:(topic|game):(\d+)$/);
  if (route.view === 'tasks' && project) params.set('project', project[2]);
  return `${route.view === 'works' ? 'projects' : 'tasks'}?${params}`;
}
function empty(title: string, description: string) { return `<div class="content-empty">${icons.game}<h3>${esc(title)}</h3><p>${esc(description)}</p></div>`; }
function errorPanel(message: string, retry = true) { return `<div class="content-error" role="alert"><strong>暂时无法加载</strong><p>${esc(message)}</p>${retry ? '<button class="adm-button" type="button" data-content-retry>重新加载</button>' : ''}</div>`; }
function loading(message = '正在加载') { return `<div class="content-loading" role="status"><span class="content-dot"></span>${esc(message)}…</div>`; }
function pageHead(eyebrow: string, title: string, description: string) { return `<header class="adm-page-head content-page-head"><div><p class="adm-eyebrow">${eyebrow}</p><h1>${title}</h1><p class="content-intro">${description}</p></div></header>`; }
function memberOptions(members: AdminMemberOption[], selected: string) { return `<option value="">全部成员</option>${members.map(m => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.displayName || m.username)}${m.enabled ? '' : ' · 已停用'}</option>`).join('')}`; }
function selectedOptions(options: Array<[string, string]>, selected: string) { return options.map(([value, label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join(''); }
function filters(ctx: AdminContext, view: 'works' | 'tasks') {
  const route = ctx.route;
  const statuses: Array<[string, string]> = view === 'works' ? [['all', '全部状态'], ['product', '已有成品'], ['working', '进行中'], ['error', '有失败任务'], ['selected', '待制作'], ['unselected', '待选方案'], ['archived', '已归档']] : [['platform-queued','平台排队'],['platform-running','平台执行'],['agent-queued','Agent 待领取'],['agent-running','Agent 执行中'],['all', '全部状态'], ['active', '全部进行中'], ['waiting-agent', '等待 Agent'], ['done', '已完成'], ['error', '失败 / 中断'], ['queued', '已排队'], ['running', '执行中']];
  const types: Array<[string, string]> = view === 'works' ? [['', '全部来源'], ['topic', '创作项目'], ['game', '个人作品']] : [['', '全部类型'], ['creation', '创作任务'], ['review', '审核任务']];
  const count = [route.owner, route.range !== 'all', route.type && route.type !== 'all', route.status && route.status !== 'all'].filter(Boolean).length;
  return `<form class="content-filters" aria-label="${view === 'works' ? '作品' : '任务'}筛选"><label class="content-search">${icons.search}<input name="q" aria-label="搜索标题、题材或任务编号" type="search" placeholder="${view === 'works' ? '搜索作品…' : '搜索任务…'}" value="${esc(route.q)}" autocomplete="off"><button class="adm-button quiet" type="submit">搜索</button></label><details class="content-filter-menu"><summary>筛选${count ? `<span>${count}</span>` : ''}</summary><div class="content-filter-fields"><label><span>成员</span><select name="owner" aria-label="成员"><option value="${esc(route.owner)}">${route.owner ? '正在加载成员…' : '全部成员'}</option></select></label><label><span>时间范围</span><select name="range" aria-label="时间范围">${selectedOptions([['all', '全部时间'], ['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天']], route.range)}</select></label><label><span>${view === 'works' ? '作品来源' : '任务类型'}</span><select name="type" aria-label="来源或类型">${selectedOptions(types, route.type)}</select></label><label><span>状态</span><select name="status" aria-label="状态">${selectedOptions(statuses, route.status)}</select></label><div class="content-filter-actions"><button class="adm-button quiet content-clear" type="button" data-clear-filters>重置</button><button class="adm-button primary" type="submit">应用筛选</button></div></div></details></form><div class="content-active-filters" aria-label="当前筛选">${route.from&&route.to?`<span>北京时间 ${esc(new Date(route.from).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}))} 至 ${esc(new Date(route.to).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}))}（不含结束）</span>`:''}${route.owner ? '<button type="button" data-filter-clear="owner" aria-label="清除成员筛选"><span data-active-owner>指定成员</span><i aria-hidden="true">×</i></button>' : ''}${route.range !== 'all' ? `<button type="button" data-filter-clear="range" aria-label="清除时间筛选">${route.range === 'today' ? '今天' : route.range === '7d' ? '近 7 天' : '近 30 天'}<i aria-hidden="true">×</i></button>` : ''}${route.type && route.type !== 'all' ? `<button type="button" data-filter-clear="type" aria-label="清除类型筛选">${esc(types.find(([key]) => key === route.type)?.[1] || '指定类型')}<i aria-hidden="true">×</i></button>` : ''}${route.status && route.status !== 'all' && (view === 'tasks' || !['product','error','working'].includes(route.status)) ? `<button type="button" data-filter-clear="status" aria-label="清除状态筛选">${esc(statuses.find(([key]) => key === route.status)?.[1] || '指定状态')}<i aria-hidden="true">×</i></button>` : ''}</div>`;
}
function bindFilters(ctx: AdminContext) {
  const form = ctx.root.querySelector<HTMLFormElement>('.content-filters');
  if (!form) return;
  form.onsubmit = event => { event.preventDefault(); const values = new FormData(form); ctx.navigate({from:undefined,to:undefined, q: String(values.get('q') || '').trim(), owner: String(values.get('owner') || ''), range: String(values.get('range') || 'all') as AdminRoute['range'], type: String(values.get('type') || ''), status: String(values.get('status') || ''), page: 1, id: undefined }); };

  ctx.root.querySelectorAll<HTMLButtonElement>('[data-filter-clear]').forEach(button => button.onclick = () => ctx.navigate({ [button.dataset.filterClear!]: button.dataset.filterClear === 'owner' ? '' : 'all', page: 1, id: undefined }));
  form.querySelector<HTMLButtonElement>('[data-clear-filters]')!.onclick = () => ctx.navigate({from:undefined,to:undefined, q: '', owner: '', range: 'all', type: '', status: 'all', page: 1, id: undefined, section: undefined });
}
function updateMembers(ctx: AdminContext, members: AdminMemberOption[]) {
  const select = ctx.root.querySelector<HTMLSelectElement>('[name="owner"]');
  if (select && document.activeElement !== select) select.innerHTML = memberOptions(members, ctx.route.owner);
  const ownerLabel = ctx.root.querySelector<HTMLElement>('[data-active-owner]');
  if (ownerLabel) ownerLabel.textContent = members.find(member => member.id === ctx.route.owner)?.displayName || '指定成员';
}
function pagination<T>(data: AdminPage<T>) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize)), first = data.total ? (data.page - 1) * data.pageSize + 1 : 0, last = Math.min(data.total, data.page * data.pageSize);
  return `<div class="content-pagination"><span>${first}–${last} / 共 ${data.total} 项</span><div><button class="adm-button quiet" type="button" data-page="${data.page - 1}"${data.page <= 1 ? ' disabled' : ''}>上一页</button><span>${data.page} / ${pages}</span><button class="adm-button quiet" type="button" data-page="${data.page + 1}"${data.page >= pages ? ' disabled' : ''}>下一页</button></div></div>`;
}
function bindPagination(ctx: AdminContext) { ctx.root.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => button.onclick = () => ctx.navigate({ page: Number(button.dataset.page) })); }
function replaceResults(host: HTMLElement, html: string) {
  const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
  const key = focused ? ['data-task-id', 'data-project-id', 'data-page', 'data-content-retry'].find(name => focused.hasAttribute(name)) : null;
  const value = key && focused ? focused.getAttribute(key) : null;
  host.innerHTML = html;
  if (key) {
    const target = Array.from(host.querySelectorAll<HTMLElement>(`[${key}]`)).find(node => node.getAttribute(key) === value);
    target?.focus({ preventScroll: true });
  }
}
function updated(root: HTMLElement, value: string) { const node = root.querySelector<HTMLElement>('[data-content-updated]'); if (node) node.textContent = `更新于 ${date(value)} · 北京时间`; }
function renderTasks(tasks: AdminTask[], compact = false) {
  if (!tasks.length) return empty('暂无任务', '当前筛选下没有任务记录。');
  return `<div class="content-task-list${compact ? ' content-task-list-compact' : ''}">${tasks.map(task => `<button type="button" class="content-task-row" data-task-id="${esc(task.id)}" data-task-type="${task.type}"><span class="content-task-kind ${task.type === 'review' ? 'content-task-review' : ''}">${task.type === 'review' ? '审' : '创'}</span><span class="content-task-main"><span class="content-task-title">${esc(task.title || task.kindLabel)} <span class="content-task-id">#${esc(task.id.slice(0, 8))}</span></span><span class="content-task-meta">${esc(task.ownerName)}<i>·</i>${esc(task.kindLabel)}<i>·</i>${task.executor === 'platform' ? '平台执行' : '成员 Agent'}</span>${task.error ? `<span class="content-task-error">${esc(humanError(task.error))}</span>` : readableTaskDetail(task) ? `<span class="content-task-detail">${esc(readableTaskDetail(task))}</span>` : ''}</span><span class="content-task-state">${badge(task.statusLabel, task.status)}<time datetime="${esc(task.updatedAt)}">${date(task.updatedAt)}</time></span>${icons.chevron}</button>`).join('')}</div>`;
}
function bindTasks(ctx: AdminContext, target: ParentNode = ctx.root) { target.querySelectorAll<HTMLButtonElement>('[data-task-id]').forEach(button => button.onclick = () => ctx.navigate({ view: 'tasks', id: button.dataset.taskId, type: button.dataset.taskType, panel: undefined, version: undefined })); }
function humanError(value: string) {
  if (/KEY_QUEUE_FULL|queue.full|no.available.slot/i.test(value)) return '模型服务繁忙，任务未能完成。';
  if (/timeout|timed.out|deadline|超时/i.test(value)) return '执行超时，任务已停止。';
  if (/token|truncat|length.limit|max_tokens/i.test(value)) return '生成内容未完成，任务已停止。';
  if (/429|rate.limit/i.test(value)) return '模型服务限流，任务未完成。';
  if (/permission|forbidden|disabled|star|权限|停用/i.test(value)) return '执行权限发生变化，任务已停止。';
  if (/interrupt|unknown|stale|失联|中断/i.test(value)) return '任务执行中断，需要人工确认后继续。';
  if (/invalid|parse|format|格式/i.test(value)) return '返回结果不完整或格式不符合要求。';
  return value.length <= 130 ? value : '任务未能完成，请展开技术详情查看原因。';
}

/** Lists never load artifact source or create a preview frame. */
async function mountWorksList(scope: ContentScope) {
  const { ctx } = scope;
  ctx.root.innerHTML = `${pageHead('CONTENT', '作品', '查看全站创作进展、材料与成品。')}<section class="content-collection"><nav class="content-quick-views" aria-label="作品快捷视图">${[['all','全部'],['product','可试玩'],['error','待处理'],['working','创作中']].map(([status,label]) => `<button type="button" data-work-status="${status}" aria-current="${(ctx.route.status || 'all') === status ? 'page' : 'false'}">${label}</button>`).join('')}</nav>${filters(ctx, 'works')}${ctx.route.section==='first-products'?'<div class="content-filter-note">仅查看所选期间首次制作完成的游戏<button class="adm-button quiet" data-clear-first-products type="button">查看全部作品</button></div>':''}<div class="content-list-bar"><p data-content-total aria-live="polite">作品正在加载</p><div class="content-layout" aria-label="显示方式"><button type="button" data-layout="grid" aria-label="卡片视图" aria-pressed="${ctx.route.layout !== 'list'}">${icons.grid}</button><button type="button" data-layout="list" aria-label="列表视图" aria-pressed="${ctx.route.layout === 'list'}">${icons.list}</button></div></div><div data-content-results>${loading('正在加载作品')}</div><p class="content-updated" data-content-updated></p><p class="content-refresh-error" data-refresh-error role="status" hidden></p></section>`;
  bindFilters(ctx);
  ctx.root.querySelectorAll<HTMLButtonElement>('[data-work-status]').forEach(button => button.onclick = () => ctx.navigate({ status: button.dataset.workStatus, page: 1, id: undefined, section: undefined }));
  const clearFirst=ctx.root.querySelector<HTMLButtonElement>('[data-clear-first-products]');if(clearFirst)clearFirst.onclick=()=>ctx.navigate({section:undefined,from:undefined,to:undefined,range:'all',page:1});
  ctx.root.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach(button => button.onclick = () => ctx.navigate({ layout: button.dataset.layout as 'grid' | 'list' }, true));
  let hasData = false;
  const load = async () => {
    try {
      const data = await ctx.api<AdminPage<AdminProject>>(contentListRequest(ctx.route)!);
      if (!scope.alive()) return;
      hasData = true; updateMembers(ctx, data.members); updated(ctx.root, data.updatedAt);
      ctx.setProjects?.(data.items);
      ctx.root.querySelector('[data-content-total]')!.textContent = `${data.total} 个作品${ctx.route.q || ctx.route.owner || (ctx.route.status && ctx.route.status !== 'all') || (ctx.route.type && ctx.route.type !== 'all') ? ' · 筛选结果' : ''}`;
      replaceResults(ctx.root.querySelector<HTMLElement>('[data-content-results]')!, data.items.length ? `<div class="content-projects content-projects-${ctx.route.layout || 'grid'}">${data.items.map(projectCard).join('')}</div>${pagination(data)}` : empty('没有找到作品', '调整成员、状态或搜索条件后再试。'));
      ctx.root.querySelectorAll<HTMLButtonElement>('[data-project-id]').forEach(button => button.onclick = () => ctx.navigate({ view: 'works', type: button.dataset.projectType, id: button.dataset.projectId, panel: button.dataset.panel, version: undefined }));
      ctx.root.querySelectorAll<HTMLImageElement>('.content-thumb img').forEach(img => img.onerror = () => { img.hidden = true; img.closest('.content-thumb')?.classList.add('content-thumb-unavailable'); });
      bindPagination(ctx);
      ctx.root.querySelector<HTMLElement>('[data-refresh-error]')!.hidden = true;
      ctx.setRefresh(load, data.activeCount ? 'active' : data.waitingAgentCount ? 'agent' : 'idle');
    } catch (error) {
      if (!scope.alive()) return;
      if (hasData) { const node = ctx.root.querySelector<HTMLElement>('[data-refresh-error]')!; node.hidden = false; node.textContent = `更新失败，仍显示上次结果。${errorText(error)}`; }
      else { ctx.root.querySelector('[data-content-results]')!.innerHTML = errorPanel(errorText(error)); ctx.root.querySelector<HTMLButtonElement>('[data-content-retry]')!.onclick = load; }
    }
  };
  ctx.setRefresh(load, 'idle'); await load();
}
function projectCard(project: AdminProject) {
  const thumb = safeAdminUrl(project.thumbnailUrl);
  const available = (Object.keys(materialLabels) as MaterialKind[]).filter(kind => project.materials[kind]);
  return `<button type="button" class="content-project-card" data-project-id="${project.id}" data-project-type="${project.type}" data-panel="${project.materials.game ? 'game' : 'overview'}"><div class="content-thumb${thumb ? '' : ' content-thumb-empty'}">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async">` : icons.game}</div><div class="content-project-info"><div class="content-project-top"><span class="content-owner">${esc(project.ownerName)}</span>${badge(project.statusLabel, project.status)}</div><h2>${esc(project.title || project.subject || '未命名作品')}</h2><p class="content-project-summary">${esc(project.summary || project.subject || '暂无作品简介')}</p><div class="content-material-chips" title="${esc(available.map(kind => materialLabels[kind]).join('、'))}">${available.length ? `${available.length} 项材料` : '材料待补充'}</div><footer><time datetime="${esc(project.updatedAt)}">${date(project.updatedAt)}</time><span>${project.failedTasks ? `<em>${project.failedTasks} 项失败</em>` : project.activeTasks ? `${project.activeTasks} 项进行中` : project.materials.game ? '试玩' : '查看详情'} ${icons.chevron}</span></footer></div></button>`;
}

async function mountTasksList(scope: ContentScope) {
  const { ctx } = scope;
  const projectFilter = ctx.route.section?.match(/^project:(topic|game):(\d+)$/);
  ctx.root.innerHTML = `${pageHead('ACTIVITY', '任务', '跟进平台执行与成员 Agent 的任务状态。')}<section class="content-collection">${filters(ctx, 'tasks')}${projectFilter ? `<div class="content-filter-note">仅查看项目 #${esc(projectFilter[2])} 的任务<button class="adm-button quiet" data-clear-project type="button">显示全部任务</button></div>` : ''}<div class="content-list-bar"><p data-content-total aria-live="polite">任务正在加载</p><p class="content-task-counts" data-task-counts></p></div><div data-content-results>${loading('正在加载任务')}</div><p class="content-updated" data-content-updated></p><p class="content-refresh-error" data-refresh-error role="status" hidden></p></section>`;
  bindFilters(ctx);
  const clear = ctx.root.querySelector<HTMLButtonElement>('[data-clear-project]'); if (clear) clear.onclick = () => ctx.navigate({ section: undefined, page: 1 });
  let hasData = false;
  const load = async () => {
    try {
      const data = await ctx.api<AdminPage<AdminTask>>(contentListRequest(ctx.route)!);
      if (!scope.alive()) return;
      hasData = true; updateMembers(ctx, data.members); updated(ctx.root, data.updatedAt);
      ctx.root.querySelector('[data-content-total]')!.textContent = `${data.total} 项任务`;
      ctx.root.querySelector('[data-task-counts]')!.innerHTML = `<span><i class="content-status-dot"></i>${data.activeCount} 平台执行中</span><span>${data.waitingAgentCount} 等待 Agent</span>`;
      replaceResults(ctx.root.querySelector<HTMLElement>('[data-content-results]')!, renderTasks(data.items) + (data.total ? pagination(data) : ''));
      bindTasks(ctx); bindPagination(ctx); ctx.root.querySelector<HTMLElement>('[data-refresh-error]')!.hidden = true;
      ctx.setRefresh(load, taskMode(data.items, data.activeCount, data.waitingAgentCount));
    } catch (error) {
      if (!scope.alive()) return;
      if (hasData) { const node = ctx.root.querySelector<HTMLElement>('[data-refresh-error]')!; node.hidden = false; node.textContent = `更新失败，仍显示上次结果。${errorText(error)}`; }
      else { ctx.root.querySelector('[data-content-results]')!.innerHTML = errorPanel(errorText(error)); ctx.root.querySelector<HTMLButtonElement>('[data-content-retry]')!.onclick = load; }
    }
  };
  ctx.setRefresh(load, 'idle'); await load();
}

let playerModule: Promise<PlayerModule> | undefined;
let artifactModule: Promise<ArtifactModule> | undefined;
function players() {
  if (!document.querySelector('link[data-admin-game-player]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/forge/game-player.css'; link.dataset.adminGamePlayer = ''; document.head.append(link); }
  const url = '/forge/game-player.js';
  return playerModule ||= import(/* @vite-ignore */ url) as Promise<PlayerModule>;
}
function artifacts() { const url = '/forge/artifact-view.js'; return artifactModule ||= import(/* @vite-ignore */ url) as Promise<ArtifactModule>; }
const designFields: Array<[string[], string]> = [
  [['title', 'name'], '标题'], [['logline', 'one_liner', 'oneLiner'], '一句话概念'], [['summary', 'description', 'descr', 'concept'], '设计概述'],
  [['subject', 'theme'], '题材'], [['genre', 'game_type'], '类型'], [['twist', 'innovation'], '独特机制'], [['core_loop', 'coreLoop', 'gameplay', 'mechanic', 'mechanics'], '核心玩法'],
  [['controls', 'input', 'interaction'], '操作方式'], [['art_direction', 'artDirection', 'visual_style', 'visualStyle'], '美术方向'], [['color_palette', 'palette'], '配色'],
  [['progression', 'pacing'], '节奏与成长'], [['audio', 'sound'], '声音'], [['why_addictive', 'appeal'], '吸引点'], [['requirements', 'production_requirements', 'productionRequirements'], '制作要求'], [['risks', 'risk'], '注意事项'], [['notes', 'note', 'memo'], '备注'],
];
function readableValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(readableValue).filter(Boolean).join('\n');
  return '';
}
function parseDesign(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function designDocument(value: unknown) {
  let data = parseDesign(value); if (!data) return '';
  for (const key of ['candidate', 'design', 'expand', 'expanded', 'proposal']) { const nested = parseDesign(data[key]); if (nested) data = { ...data, ...nested }; }
  const sections = designFields.flatMap(([keys, label]) => { const value = keys.map(key => readableValue(data![key])).find(Boolean); return value ? [`<section class="content-design-field"><h3>${label}</h3><p>${esc(value)}</p></section>`] : []; });
  return sections.length ? `<article class="content-design">${sections.join('')}</article>` : '';
}
function versionKind(version: AdminVersion): MaterialKind | null { const kind = version.kind === 'product' ? 'game' : version.kind; return kind in materialLabels ? kind as MaterialKind : null; }
function versionLabel(version: AdminVersion) { return `${versionKind(version) ? materialLabels[versionKind(version)!] : '材料'} · ${date(version.created_at, true)}`; }
function projectHeader(detail: AdminProjectDetail, panel: string) {
  const { project } = detail;
  const primary = project.materials.game ? 'game' : 'overview';
  const materials: Array<[string,string]> = [
    ...(project.materials.game ? [['overview','设计说明'] as [string,string]] : []),
    ...(['expand','brief','preview','assets'] as MaterialKind[]).filter(kind => project.materials[kind]).map(kind => [kind,materialLabels[kind]] as [string,string]),
    ...(detail.versions.length ? [['history',`历史版本（${detail.versions.length}）`] as [string,string]] : []),
  ];
  const inMaterials = materials.some(([key]) => key === panel) || panel === 'materials';
  const firstMaterial = materials[0]?.[0] || 'materials';
  return `<button type="button" class="content-back" data-back>${icons.arrow} 返回作品</button><header class="content-detail-head"><div><h1>${esc(project.title || project.subject || '未命名作品')}</h1><p class="content-detail-meta"><span>${esc(project.ownerName)}</span>${badge(project.statusLabel, project.status)}</p></div><div class="content-detail-actions"><button class="adm-button quiet" type="button" data-copy-project-link>复制链接</button>${project.materials.game ? `<a class="adm-button" href="${resourceUrl(project, 'game', 'file')}" download>${icons.download} 下载</a>` : ''}</div></header><nav class="content-tabs" aria-label="作品详情"><button type="button" data-panel="${primary}" aria-current="${panel === primary ? 'page' : 'false'}">${project.materials.game ? '试玩' : '作品概览'}</button><button type="button" data-project-section="materials" data-material-default="${firstMaterial}" aria-current="${inMaterials ? 'page' : 'false'}">创作材料</button><button type="button" data-panel="tasks" aria-current="${panel === 'tasks' ? 'page' : 'false'}">任务与审核${project.activeTasks ? `<span>${project.activeTasks}</span>` : ''}</button></nav>${inMaterials && materials.length ? `<label class="content-material-switch"><span>查看</span><select data-material-select aria-label="查看材料或历史版本">${selectedOptions(materials,panel)}</select></label>` : ''}<div data-detail-content class="content-detail-content"></div><p class="content-refresh-error" data-refresh-error role="status" hidden></p>`;
}
function detailPanel(detail: AdminProjectDetail, routePanel?: string) { return routePanel && routePanel in panelLabels ? routePanel : detail.project.materials.game ? 'game' : 'overview'; }
async function mountProject(scope: ContentScope) {
  const { ctx } = scope;
  let detail: AdminProjectDetail | null = null;
  const type = ctx.route.type === 'game' ? 'game' : 'topic';
  const path = `projects/${type}/${encodeURIComponent(ctx.route.id!)}`;
  ctx.root.innerHTML = loading('正在加载作品');
  const load = async () => {
    try {
      const next = await ctx.api<AdminProjectDetail>(path);
      if (!scope.alive()) return;
      if (detail) {
        detail = next;
        const meta = ctx.root.querySelector('.content-detail-meta');
        if (meta) meta.innerHTML = `<span>${esc(next.project.ownerName)}</span><i>·</i><span>更新于 ${date(next.project.updatedAt, true)}</span>${badge(next.project.statusLabel, next.project.status)}`;
        ctx.root.querySelector<HTMLElement>('[data-refresh-error]')!.hidden = true;
      } else {
        detail = next; ctx.root.innerHTML = projectHeader(next, detailPanel(next, ctx.route.panel));
        ctx.root.querySelector<HTMLButtonElement>('[data-back]')!.onclick = () => ctx.navigate({ id: undefined, panel: undefined, version: undefined });
        ctx.root.querySelector<HTMLButtonElement>('[data-copy-project-link]')!.onclick = async () => { try { await navigator.clipboard.writeText(location.href); if (scope.alive()) ctx.notice('作品链接已复制'); } catch { if (scope.alive()) ctx.notice('复制失败，请复制浏览器地址栏中的链接。', true); } };
        ctx.root.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button => button.onclick = () => ctx.navigate({ panel: button.dataset.panel, version: undefined }));
        ctx.root.querySelector<HTMLButtonElement>('[data-project-section=materials]')!.onclick = () => ctx.navigate({ panel: ctx.root.querySelector<HTMLButtonElement>('[data-material-default]')!.dataset.materialDefault, version: undefined });
        const materialSelect = ctx.root.querySelector<HTMLSelectElement>('[data-material-select]');
        if (materialSelect) materialSelect.onchange = () => ctx.navigate({ panel: materialSelect.value, version: undefined });
        await renderProjectPanel(scope, next, detailPanel(next, ctx.route.panel));
      }
      if (!scope.alive()) return;
      ctx.setRefresh(load, next.project.activeTasks ? 'active' : next.project.status === 'working' ? 'agent' : 'idle');
    } catch (error) {
      if (!scope.alive()) return;
      if (detail) { const node = ctx.root.querySelector<HTMLElement>('[data-refresh-error]')!; node.hidden = false; node.textContent = `状态更新失败，仍显示已加载内容。${errorText(error)}`; }
      else { ctx.root.innerHTML = `<button class="content-back" data-back type="button">${icons.arrow} 返回作品</button>${errorPanel(errorText(error))}`; ctx.root.querySelector<HTMLButtonElement>('[data-back]')!.onclick = () => ctx.navigate({ id: undefined, panel: undefined, version: undefined }); ctx.root.querySelector<HTMLButtonElement>('[data-content-retry]')!.onclick = load; }
    }
  };
  ctx.setRefresh(load, 'idle'); await load();
}
async function renderProjectPanel(scope: ContentScope, detail: AdminProjectDetail, panel: string) {
  const { ctx } = scope, host = ctx.root.querySelector<HTMLElement>('[data-detail-content]')!;
  scope.clearFrames();
  if (panel === 'materials') { host.innerHTML = empty('暂无创作材料', '生成的方案、简报、美术材料和历史版本会出现在这里。'); return; }
  if (panel === 'overview') {
    host.innerHTML = `<div class="content-overview"><section class="content-overview-main"><div class="content-section-heading"><h2>设计概览</h2>${detail.project.materials.expand ? '<button class="adm-button quiet" type="button" data-show-expand>查看方案</button>' : ''}</div>${designDocument(detail.overview) || (detail.project.summary ? `<article class="content-design"><section class="content-design-field"><h3>作品简介</h3><p>${esc(detail.project.summary)}</p></section></article>` : empty('暂无设计概览', '此作品还没有可读的设计说明。'))}<div data-expand-content></div></section><aside class="content-overview-aside"><section class="content-facts"><h2>作品信息</h2><dl><div><dt>成员</dt><dd>${esc(detail.project.ownerName)}</dd></div><div><dt>来源</dt><dd>${detail.project.type === 'topic' ? '创作项目' : '个人作品'}</dd></div><div><dt>题材</dt><dd>${esc(detail.project.subject || '未填写')}</dd></div><div><dt>创建</dt><dd>${date(detail.project.createdAt, true)}</dd></div><div><dt>进行中</dt><dd>${detail.project.activeTasks} 项任务</dd></div><div><dt>失败任务</dt><dd>${detail.project.failedTasks} 项</dd></div></dl></section><section class="content-related"><h2>关联审核</h2>${detail.relatedReviews.length ? detail.relatedReviews.map(review => `<button type="button" data-review-id="${review.id}"><span>${esc(review.title)}</span><small>${date(review.createdAt)}${review.score == null ? '' : ` · ${review.score} 分`}</small>${icons.chevron}</button>`).join('') : '<p>暂无关联审核报告</p>'}</section></aside></div>`;
    host.querySelectorAll<HTMLButtonElement>('[data-review-id]').forEach(button => button.onclick = () => ctx.navigate({ view: 'reviews', id: button.dataset.reviewId, panel: undefined, version: undefined }));
    const expand = host.querySelector<HTMLButtonElement>('[data-show-expand]');
    if (expand) expand.onclick = async () => { expand.disabled = true; const target = host.querySelector<HTMLElement>('[data-expand-content]')!; await renderMaterial(scope, detail.project, 'expand', target); if (scope.alive()) expand.hidden = true; };
    return;
  }
  if (panel === 'history') { await renderHistory(scope, detail, host); return; }
  if (panel === 'tasks') {
    host.innerHTML = `<section class="content-project-reviews"><div class="content-section-heading"><h2>审核报告</h2></div><div class="content-related">${detail.relatedReviews.length ? detail.relatedReviews.map(review => `<button type="button" data-review-id="${review.id}"><span>${esc(review.title)}</span><small>${date(review.createdAt)}${review.score == null ? '' : ` · ${review.score} 分`}</small>${icons.chevron}</button>`).join('') : '<p>暂无关联审核报告</p>'}</div></section><div class="content-section-heading"><div><h2>相关任务</h2><p>当前作品的创作与审核记录</p></div><button class="adm-button quiet" type="button" data-all-project-tasks>查看全部</button></div><div data-project-tasks>${loading('正在加载任务')}</div>`;
    host.querySelectorAll<HTMLButtonElement>('[data-review-id]').forEach(button => button.onclick = () => ctx.navigate({ view: 'reviews', id: button.dataset.reviewId, panel: undefined, version: undefined }));
    host.querySelector<HTMLButtonElement>('[data-all-project-tasks]')!.onclick = () => ctx.navigate({ view: 'tasks', id: undefined, type: '', section: `project:${detail.project.type}:${detail.project.id}`, page: 1 });
    const target = host.querySelector<HTMLElement>('[data-project-tasks]')!;
    try { const result = await ctx.api<AdminPage<AdminTask>>(`tasks?project=${detail.project.id}&range=all&page=1&pageSize=25`); if (!scope.alive()) return; target.innerHTML = renderTasks(result.items, true); bindTasks(ctx, target); }
    catch (error) { if (scope.alive()) target.innerHTML = errorPanel(errorText(error), false); }
    return;
  }
  await renderMaterial(scope, detail.project, panel as MaterialKind, host);
}
async function renderMaterial(scope: ContentScope, project: AdminProject, kind: MaterialKind, host: HTMLElement, version?: AdminVersion) {
  const { ctx } = scope;
  host.innerHTML = loading(`正在加载${materialLabels[kind]}`);
  try {
    const material = await ctx.api<AdminMaterial>(materialPath(project, kind, version?.id));
    if (!scope.alive() || !host.isConnected) return;
    if (!material.available) { host.innerHTML = empty(version ? '此版本材料不可用' : `暂无${materialLabels[kind]}`, version ? '所选历史版本没有可读取的材料。' : `该作品尚未生成${materialLabels[kind]}。`); return; }
    const immutableVersion = version?.id;
    if (immutableVersion && material.versionId && material.versionId !== immutableVersion) throw new Error('返回的材料版本与所选历史版本不一致。');
    const download = fixedVersionUrl(safeAdminUrl(material.downloadUrl) || resourceUrl(project, kind, 'file', immutableVersion), immutableVersion);
    host.innerHTML = `<div class="content-section-heading"><div><h2>${version ? '历史' : ''}${materialLabels[kind]}</h2>${version ? `<p>${esc(versionLabel(version))} <code>${esc(version.id)}</code>${version.current ? ' · 当前采用' : ''}</p>` : `<p>${kind === 'game' ? '固定 9:16 竖屏 · 仅运行当前打开的作品' : kind === 'expand' ? '创作方案与设计说明' : '当前采用的材料'}</p>`}</div><a class="adm-button quiet" href="${esc(download)}" download>${icons.download} 下载${kind === 'brief' || kind === 'expand' ? '文档' : '文件'}</a></div><div class="content-material-stage" data-material-stage></div><details class="content-source"><summary>${kind === 'brief' || kind === 'expand' ? '查看原文' : '查看源码'}</summary><div data-source-content></div></details>`;
    const stage = host.querySelector<HTMLElement>('[data-material-stage]')!;
    if (kind === 'brief') { const module = await artifacts(); if (!scope.alive() || !host.isConnected) return; stage.innerHTML = typeof material.content === 'string' && material.content.trim() ? module.briefDocument(material.content) : empty('简报内容不可用', '当前记录没有可阅读的正文，可下载原文件检查。'); }
    else if (kind === 'expand') {
      const rendered = designDocument(material.content);
      stage.innerHTML = rendered || empty('暂无可读设计字段', '方案已保存，可通过下方“查看原文”检查原始内容。');
    } else {
      const preview = fixedVersionUrl(safeAdminUrl(material.previewUrl) || resourceUrl(project, kind, 'preview', immutableVersion), immutableVersion);
      if (kind === 'game') { const module = await players(); if (!scope.alive() || !host.isConnected) return; stage.innerHTML = module.gamePlayer(preview, version ? '历史游戏试玩' : '游戏试玩'); module.bindGamePlayers(stage); }
      else stage.innerHTML = `<div class="content-visual-preview"><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="${version ? '历史' : ''}${materialLabels[kind]}预览" src="${esc(preview)}"></iframe></div>`;
    }
    if (!scope.alive() || !host.isConnected) return;
    const disclosure = host.querySelector<HTMLDetailsElement>('.content-source')!, source = host.querySelector<HTMLElement>('[data-source-content]')!;
    let fetched = false;
    disclosure.ontoggle = async () => {
      if (!disclosure.open || fetched) return;
      fetched = true;
      if (kind === 'brief' || kind === 'expand') source.innerHTML = `<pre><code>${esc(material.content || '当前记录没有原文。')}</code></pre>`;
      else {
        source.innerHTML = loading('正在读取源码');
        try { const path = materialPath(project, kind, immutableVersion); const raw = await ctx.api<AdminMaterial>(`${path}${path.includes('?') ? '&' : '?'}raw=1`); if (!scope.alive() || !source.isConnected) return; source.innerHTML = raw.content ? `<pre><code>${esc(raw.content)}</code></pre>` : '<p>当前记录没有可读取的源码。</p>'; }
        catch (error) { if (scope.alive() && source.isConnected) { fetched = false; source.innerHTML = `<p class="content-inline-error">${esc(errorText(error))}，关闭后重新展开以重试。</p>`; } }
      }
    };
  } catch (error) { if (scope.alive() && host.isConnected) { host.innerHTML = errorPanel(errorText(error)); host.querySelector<HTMLButtonElement>('[data-content-retry]')!.onclick = () => renderMaterial(scope, project, kind, host, version); } }
}
async function renderHistory(scope: ContentScope, detail: AdminProjectDetail, host: HTMLElement) {
  const { ctx } = scope;
  if (!detail.versions.length) { host.innerHTML = empty('暂无历史版本', '生成或导入的材料版本会保留在这里。'); return; }
  const selected = ctx.route.version ? detail.versions.find(v => v.id === ctx.route.version) : undefined;
  host.innerHTML = `<div class="content-history"><aside class="content-version-list" aria-label="历史版本"><h2>历史版本 <span>${detail.versions.length}</span></h2><p>按保存时间查看独立版本</p>${detail.versions.map(version => `<button type="button" data-version="${esc(version.id)}" aria-current="${version.id === selected?.id ? 'true' : 'false'}"><span>${versionKind(version) ? materialLabels[versionKind(version)!] : esc(version.kind)}${version.current ? '<em>当前采用</em>' : ''}${version.stale ? '<em class="content-stale">输入已更新</em>' : ''}</span><time datetime="${esc(version.created_at)}">${date(version.created_at, true)}</time><small>${version.executor === 'platform' ? '平台' : version.executor === 'agent' ? '成员 Agent' : '历史导入'}${version.model ? ` · ${esc(version.model)}` : ''}</small></button>`).join('')}</aside><section class="content-version-detail" data-version-content>${selected ? '' : ctx.route.version ? empty('未找到此历史版本', '该版本可能已不可用，请选择左侧其他版本。') : empty('选择一个历史版本', '点击左侧记录，查看该版本的材料与保存信息。')}</section></div>`;
  host.querySelectorAll<HTMLButtonElement>('[data-version]').forEach(button => button.onclick = () => ctx.navigate({ panel: 'history', version: button.dataset.version }));
  if (selected) {
    const target = host.querySelector<HTMLElement>('[data-version-content]')!;
    const kind = versionKind(selected);
    if (kind) await renderMaterial(scope, detail.project, kind, target, selected);
    else target.innerHTML = empty('该版本暂不支持预览', '请联系维护人员检查原始材料类型。');
  }
}

async function mountTaskDetail(scope: ContentScope) {
  const { ctx } = scope, type = ctx.route.type === 'review' ? 'review' : 'creation';
  ctx.root.innerHTML = loading('正在加载任务');
  let hasData = false, previous = '', latest: AdminTaskDetail | null = null;
  const load = async () => {
    try {
      const detail = await ctx.api<AdminTaskDetail>(`tasks/${type}/${encodeURIComponent(ctx.route.id!)}`);
      if (!scope.alive()) return;
      latest = detail;
      if (!hasData) {
        ctx.root.innerHTML = `<button type="button" class="content-back" data-back>${icons.arrow} 返回任务</button><header class="content-detail-head"><div><p class="adm-eyebrow">${detail.task.type === 'review' ? '审核任务' : '创作任务'}</p><h1>${esc(detail.task.title || detail.task.kindLabel)}</h1><p class="content-detail-meta">${esc(detail.task.ownerName)} <i>·</i> ${esc(detail.task.kindLabel)} <i>·</i> ${detail.task.executor === 'platform' ? '平台执行' : '成员 Agent'}</p></div></header><div class="content-task-detail-grid"><section class="content-task-detail-main"><div data-task-live aria-live="polite"></div><div data-task-actions></div></section><aside class="content-facts"><h2>任务信息</h2><dl data-task-facts></dl></aside></div><p class="content-refresh-error" data-refresh-error role="status" hidden></p>`;
        ctx.root.querySelector<HTMLButtonElement>('[data-back]')!.onclick = () => ctx.navigate({ id: undefined });
        hasData = true;
      }
      const stateKey = JSON.stringify([detail.task.status, detail.task.updatedAt, detail.task.detail, detail.task.error, detail.task.canRetry, detail.retryTaskId, detail.continuePrompt]);
      if (stateKey !== previous) {
        previous = stateKey;
        updateTaskDetail(scope, detail);
      }
      ctx.root.querySelector<HTMLElement>('[data-refresh-error]')!.hidden = true;
      ctx.setRefresh(load, taskMode([detail.task]));
    } catch (error) {
      if (!scope.alive()) return;
      if (hasData) { const node = ctx.root.querySelector<HTMLElement>('[data-refresh-error]')!; node.hidden = false; node.textContent = `更新失败，仍显示上次状态。${errorText(error)}`; }
      else { ctx.root.innerHTML = `<button type="button" class="content-back" data-back>${icons.arrow} 返回任务</button>${errorPanel(errorText(error))}`; ctx.root.querySelector<HTMLButtonElement>('[data-back]')!.onclick = () => ctx.navigate({ id: undefined }); ctx.root.querySelector<HTMLButtonElement>('[data-content-retry]')!.onclick = load; }
    }
  };
  const updateTaskDetail = (scope: ContentScope, detail: AdminTaskDetail) => {
    const task = detail.task, active = isActive(task);
    const live = ctx.root.querySelector<HTMLElement>('[data-task-live]')!;
    const technicalOpen = live.querySelector<HTMLDetailsElement>('.content-technical')?.open;
    const technicalFocus = live.querySelector('.content-technical summary') === document.activeElement;
    live.innerHTML = `<section class="content-task-status"><div>${badge(task.statusLabel, task.status)}<span class="content-updated">${date(task.updatedAt, true)}</span></div><h2>${task.error ? esc(humanError(task.error)) : active && task.executor === 'agent' ? '等待成员 Agent 继续执行' : active && task.executor === 'platform' ? task.status === 'queued' ? '任务已排队' : '平台正在执行任务' : /success|succeed|complete|done/.test(task.status) ? '任务已完成' : '任务已结束'}</h2><p>${esc(readableTaskDetail(task) || (active && task.executor === 'agent' ? '平台不会代替成员 Agent 调用模型。成员可在原会话继续此任务。' : active ? '进度会自动更新，可离开此页后再回来查看。' : '查看关联作品或任务结果了解详情。'))}</p>${task.error ? `<details class="content-technical"><summary>技术详情</summary><pre>${esc(task.error)}</pre></details>` : ''}</section>`;
    const technical = live.querySelector<HTMLDetailsElement>('.content-technical');
    if (technical) { technical.open = !!technicalOpen; if (technicalFocus) technical.querySelector<HTMLElement>('summary')!.focus({ preventScroll: true }); }
    const facts = ctx.root.querySelector<HTMLElement>('[data-task-facts]')!;
    facts.innerHTML = `<div><dt>任务编号</dt><dd><code>${esc(task.id)}</code></dd></div><div><dt>执行方式</dt><dd>${task.executor === 'platform' ? '平台模型' : '成员 Agent'}</dd></div><div><dt>提交时间</dt><dd>${date(task.createdAt, true)}</dd></div><div><dt>开始时间</dt><dd>${date(task.startedAt, true)}</dd></div><div><dt>最近更新</dt><dd>${date(task.updatedAt, true)}</dd></div>${task.retryOf ? `<div><dt>重试自</dt><dd><button class="content-text-button" type="button" data-original-task>${esc(task.retryOf.slice(0, 12))}</button></dd></div>` : ''}${task.requestedBy ? `<div><dt>重试发起人</dt><dd>${esc(task.requestedBy)}</dd></div>` : ''}`;
    const original = facts.querySelector<HTMLButtonElement>('[data-original-task]'); if (original) original.onclick = () => ctx.navigate({ id: task.retryOf!, type: task.type });
    // Retain the confirmation and copy controls while polling to preserve focus.
    const actions = ctx.root.querySelector<HTMLElement>('[data-task-actions]')!;
    const actionKey = JSON.stringify([task.canRetry, task.resultId, task.projectId, detail.retryTaskId, detail.continuePrompt, detail.sourceAvailable, task.retryReason]);
    if (actions.dataset.key === actionKey) return;
    actions.dataset.key = actionKey;
    actions.innerHTML = `<div class="content-task-links">${task.projectId != null && task.projectType ? '<button class="adm-button" type="button" data-open-project>查看关联作品</button>' : ''}${task.type === 'review' && task.resultId ? '<button class="adm-button primary" type="button" data-open-report>查看审核报告</button>' : ''}${detail.retryTaskId ? '<button class="adm-button" type="button" data-open-retry>查看重试任务</button>' : ''}</div>${task.executor === 'agent' && detail.continuePrompt ? `<section class="content-continue"><h2>在成员 Agent 中继续</h2><p>将下面的指令发送给执行该任务的成员 Agent，继续原编号任务。</p><pre>${esc(detail.continuePrompt)}</pre><button class="adm-button" type="button" data-copy-prompt>复制继续指令</button></section>` : ''}${task.canRetry && task.type === 'creation' ? `<section class="content-retry-box"><h2>重新执行任务</h2><p>${esc(task.retryReason || '确认后将创建一个新的任务编号，并再次使用平台模型。')}</p><button class="adm-button" type="button" data-show-retry>重试任务</button><div class="content-retry-confirm" data-retry-confirm hidden><p>确认重新执行「${esc(task.kindLabel)}」？这会创建新任务，并可能产生模型费用。</p><div><button class="adm-button primary" type="button" data-confirm-retry>确认重试</button><button class="adm-button quiet" type="button" data-cancel-retry>取消</button></div><p class="content-inline-error" data-retry-error role="alert" hidden></p></div></section>` : ''}`;
    if (!active && !task.canRetry && !detail.retryTaskId && /error|failed|expired|cancel|interrupt/.test(task.status)) {
      const note = document.createElement('section'); note.className = 'content-retry-box';
      note.innerHTML = `<h2>${detail.sourceAvailable ? '后续处理' : '原始材料不可用'}</h2><p>${esc(task.retryReason || '此任务无法直接继续，请从原始材料重新发起。')}</p>`;
      actions.append(note);
    }
    const project = actions.querySelector<HTMLButtonElement>('[data-open-project]'); if (project) project.onclick = () => ctx.navigate({ view: 'works', id: String(task.projectId), type: task.projectType!, panel: 'overview', version: undefined });
    const report = actions.querySelector<HTMLButtonElement>('[data-open-report]'); if (report) report.onclick = () => ctx.navigate({ view: 'reviews', id: String(task.resultId), panel: undefined, version: undefined });
    const retried = actions.querySelector<HTMLButtonElement>('[data-open-retry]'); if (retried) retried.onclick = () => ctx.navigate({ id: detail.retryTaskId!, type: 'creation' });
    const copy = actions.querySelector<HTMLButtonElement>('[data-copy-prompt]'); if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(latest?.continuePrompt || detail.continuePrompt!); if (scope.alive()) ctx.notice('继续指令已复制'); } catch { if (scope.alive()) ctx.notice('复制失败，请手动选择并复制指令。', true); } };
    const show = actions.querySelector<HTMLButtonElement>('[data-show-retry]'), confirm = actions.querySelector<HTMLElement>('[data-retry-confirm]');
    if (show && confirm) {
      show.onclick = () => { show.hidden = true; confirm.hidden = false; confirm.querySelector<HTMLButtonElement>('[data-confirm-retry]')!.focus(); };
      confirm.querySelector<HTMLButtonElement>('[data-cancel-retry]')!.onclick = () => { confirm.hidden = true; show.hidden = false; show.focus(); };
      confirm.querySelector<HTMLButtonElement>('[data-confirm-retry]')!.onclick = async () => {
        const button = confirm.querySelector<HTMLButtonElement>('[data-confirm-retry]')!;
        button.disabled = true; button.textContent = '正在创建…'; confirm.querySelector<HTMLButtonElement>('[data-cancel-retry]')!.disabled = true;
        try { const result = await ctx.api<{ task: AdminTask }>(`tasks/creation/${encodeURIComponent(task.id)}/retry`, 'POST'); if (!scope.alive()) return; ctx.notice('已创建重试任务'); ctx.navigate({ type: 'creation', id: result.task.id }); }
        catch (error) { if (!scope.alive()) return; button.disabled = false; button.textContent = '确认重试'; confirm.querySelector<HTMLButtonElement>('[data-cancel-retry]')!.disabled = false; const message = confirm.querySelector<HTMLElement>('[data-retry-error]')!; message.hidden = false; message.textContent = errorText(error); }
      };
    }
  };
  ctx.setRefresh(load, 'idle'); await load();
}

export async function mountContent(ctx: AdminContext): Promise<() => void> {
  let disposed = false;
  const clearFrames = () => ctx.root.querySelectorAll<HTMLIFrameElement>('iframe').forEach(frame => { frame.src = 'about:blank'; frame.remove(); });
  const cleanup = () => { if (disposed) return; disposed = true; clearFrames(); ctx.setRefresh(null); ctx.signal.removeEventListener('abort', cleanup); };
  const scope: ContentScope = { ctx, alive: () => !disposed && !ctx.signal.aborted, clearFrames, cleanup };
  ctx.signal.addEventListener('abort', cleanup, { once: true });
  if (ctx.signal.aborted) { cleanup(); return cleanup; }
  if (ctx.route.view === 'works') { if (ctx.route.id) await mountProject(scope); else await mountWorksList(scope); }
  else if (ctx.route.view === 'tasks') { if (ctx.route.id) await mountTaskDetail(scope); else await mountTasksList(scope); }
  return cleanup;
}
