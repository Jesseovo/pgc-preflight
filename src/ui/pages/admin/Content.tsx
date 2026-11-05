import { useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AdminMaterial, AdminMemberOption, AdminPage, AdminProject, AdminProjectDetail, AdminRoute, AdminTask, AdminTaskDetail, AdminVersion, MaterialKind } from '../../../admin/contracts';
import { Badge, Button, Card, ConfirmAction, EmptyState, ErrorState, Field, Input, JsonDetails, PageHeader, Select, Table, Tabs } from '../../components/ui';
import { GamePlayer } from '../../components/GamePlayer';
import { useAction, useResource } from '../../lib/api';
import { AdminListContext, adminPath, Cell, DataState, Download, Facts, MemberOptions, Options, Pager, post, ranges, ResponsiveTable, segment, Status, StatusText, time, useAdminListInterval, useAdminRoute } from './shared';

const materialLabels: Record<MaterialKind, string> = { expand: '设计方案', game: '试玩', preview: '样板图', brief: '简报', assets: '美术资产' };
const workTypes = [['all', '全部来源'], ['topic', '创作项目'], ['game', '个人作品']] as const;
const taskTypes = [['all', '全部类型'], ['creation', '创作任务'], ['review', '审核任务']] as const;
const workStates = [['all', '全部状态'], ['product', '已有成品'], ['working', '进行中'], ['error', '有失败任务'], ['selected', '待制作'], ['unselected', '待选方案'], ['archived', '已归档']] as const;
const taskStates = [['all', '全部状态'], ['active', '全部进行中'], ['waiting-agent', '等待 Agent'], ['done', '已完成'], ['error', '失败 / 中断'], ['queued', '已排队'], ['running', '执行中'], ['platform-queued', '平台排队'], ['platform-running', '平台执行'], ['agent-queued', 'Agent 待领取'], ['agent-running', 'Agent 执行中']] as const;

function listPath(route: AdminRoute) {
  const works = route.view === 'works';
  const params = new URLSearchParams({ range: route.range, page: String(route.page), pageSize: works ? '24' : '25' });
  for (const key of ['owner', 'q', 'status', 'type'] as const) if (route[key] && route[key] !== 'all') params.set(key, route[key]);
  if (route.from && route.to) { params.set('from', route.from); params.set('to', route.to); }
  if (works && route.section === 'first-products') params.set('firstProducts', '1');
  const project = route.section?.match(/^project:(topic|game):(\d+)$/);
  if (!works && project) params.set('project', project[2]);
  return adminPath((works ? 'projects?' : 'tasks?') + params);
}

const terminal = (value: string) => /success|succeed|complete|done|fail|error|expired|cancel|interrupt/.test(value);
const executorLabel = (executor: string) => executor === 'platform' ? '平台模型' : executor === 'agent' ? '成员 Agent' : '历史导入';
const taskSource = (task: AdminTask) => task.type === 'review' && task.executor === 'platform' && task.status === 'done'
  ? '后台审核记录' : executorLabel(task.executor);
const projectTitle = (project: AdminProject) => project.title || project.subject || '未命名作品';
const projectPath = (project: { type: string; id: string | number }) => 'projects/' + project.type + '/' + segment(project.id);

function ListFilters({ route, members }: { route: AdminRoute; members?: AdminMemberOption[] }) {
  const { update } = useAdminRoute();
  const works = route.view === 'works';
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    update({ q: String(data.get('q') || '').trim(), owner: String(data.get('owner') || ''), range: data.get('range') as AdminRoute['range'], type: String(data.get('type')), status: String(data.get('status')), from: undefined, to: undefined, page: 1 });
  };
  return <Card className="stack"><form key={[route.q, route.owner, route.range, route.type, route.status].join('|')} className="toolbar" onSubmit={onSubmit}>
    <Field label={works ? '搜索作品' : '搜索任务'}><Input type="search" name="q" defaultValue={route.q} placeholder={works ? '标题或题材' : '标题或任务编号'} /></Field>
    <Field label="成员"><Select name="owner" defaultValue={route.owner}><MemberOptions members={members} current={route.owner} /></Select></Field>
    <Field label="时间"><Select name="range" defaultValue={route.range}><Options items={ranges} /></Select></Field>
    <Field label={works ? '作品来源' : '任务类型'}><Select name="type" defaultValue={route.type}><Options items={works ? workTypes : taskTypes} /></Select></Field>
    <Field label="状态"><Select name="status" defaultValue={route.status}><Options items={works ? workStates : taskStates} /></Select></Field>
    <div className="row admin-filter-actions">
      <Button type="submit">应用筛选</Button>
      <Button variant="outline" type="button" onClick={() => update({ from: undefined, to: undefined, q: '', owner: '', range: 'all', type: 'all', status: 'all', page: 1, section: undefined })}>重置</Button>
    </div>
  </form>
  {(route.from && route.to || route.section) && <div className="row small muted">
    {route.from && route.to && <span>北京时间 {time(route.from)} 至 {time(route.to)}（不含结束时刻）</span>}
    {route.section === 'first-products' && <span>首次制作完成的游戏</span>}
    {route.section?.startsWith('project:') && <span>项目 #{route.section.split(':')[2]} 的任务</span>}
    <Button size="sm" variant="ghost" onClick={() => update({ from: undefined, to: undefined, section: undefined, page: 1 })}>清除限定条件</Button>
  </div>}
  </Card>;
}

function openProject(project: AdminProject) {
  return { kind: 'project' as const, id: String(project.id), type: project.type, panel: project.materials.game ? 'game' : 'overview' };
}

function projectThumbnail(project: AdminProject) {
  return project.materials.preview && project.thumbnailUrl?.startsWith('/api/admin/') ? project.thumbnailUrl : null;
}

function ProjectThumbnail({ src, title, onOpen, cover = false }: { src: string; title: string; onOpen: () => void; cover?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <button type="button" className={'admin-thumbnail' + (cover ? ' admin-cover' : '')}
    aria-label={title + (failed ? '，缩略图加载失败，查看样板图' : '，查看样板图')} onClick={onOpen}>
    {failed ? <span className="admin-thumbnail-error">缩略图不可用</span> : <img alt="" src={src} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
  </button>;
}

export function ProjectCard({ project, fromOverview = false }: { project: AdminProject; fromOverview?: boolean }) {
  const { inspect, visit, route } = useAdminRoute();
  const thumb = projectThumbnail(project);
  function open(panel?: string) {
    const inspector = { ...openProject(project), ...(panel ? { panel } : {}) };
    if (fromOverview) visit('works', { owner: route.owner, status: 'product', inspector });
    else inspect(inspector, !!route.inspector);
  }
  return <Card className="stack">
    {thumb ? <ProjectThumbnail key={thumb} src={thumb} title={projectTitle(project)} onOpen={() => open('preview')} cover /> :
      <div className="admin-cover"><span>暂无样板图</span></div>}
    <div className="spread small"><span className="muted">{project.ownerName}</span><Status value={project.status}>{project.statusLabel}</Status></div>
    <h3>{projectTitle(project)}</h3><p className="small muted admin-clamp">{project.summary || project.subject || '暂无作品简介'}</p>
    <div className="spread"><span className="small muted">{time(project.updatedAt)}</span><Button variant="outline" size="sm" onClick={() => open()}>{project.materials.game ? '试玩' : '详情'}</Button></div>
  </Card>;
}

export function Works({ route }: { route: AdminRoute }) {
  const { update, inspect, route: current } = useAdminRoute();
  const resource = useResource<AdminPage<AdminProject>>(listPath(route), { interval: useAdminListInterval(60_000) });
  const setProjects = useContext(AdminListContext)?.setProjects;
  useEffect(() => { setProjects?.(resource.data?.items || []); }, [resource.data, setProjects]);
  return <section className="stack">
    <PageHeader eyebrow="团队内容" title="作品" description="查看全站创作项目、成品与成员导入的个人作品。" actions={<Button variant="outline" onClick={resource.reload}>刷新</Button>} />
    <Tabs items={[{ id: 'all', label: '全部' }, { id: 'product', label: '可试玩' }, { id: 'error', label: '待处理' }, { id: 'working', label: '创作中' }]} value={route.status} onChange={status => update({ status, page: 1, section: undefined })} />
    <ListFilters route={route} members={resource.data?.members} />
    <div className="spread"><span className="muted small">作品列表</span><Tabs items={[{ id: 'list', label: '列表' }, { id: 'grid', label: '卡片' }]} value={route.layout || 'list'} onChange={layout => update({ layout: layout as 'list' | 'grid' }, true)} /></div>
    <DataState resource={resource} label="正在读取作品…">{data => <>
      {data.items.length ? route.layout === 'grid' ? <div className="grid-3">{data.items.map(project => <ProjectCard key={project.type + project.id} project={project} />)}</div> :
        <Card><Table className="admin-works-table"><thead><tr><th>作品</th><th>成员</th><th>来源</th><th>状态</th><th>可用材料</th><th>更新时间</th></tr></thead><tbody>{data.items.map(project => {
          const thumb = projectThumbnail(project);
          return <tr key={project.type + project.id} data-selected={current.inspector?.kind === 'project' && current.inspector?.type === project.type && current.inspector.id === String(project.id) || undefined}>
          <td><div className="admin-work-name">
            {thumb && <ProjectThumbnail key={thumb} src={thumb} title={projectTitle(project)} onOpen={() => inspect({ ...openProject(project), panel: 'preview' }, !!current.inspector)} />}
            <div><button className="admin-summary-link" onClick={() => inspect(openProject(project), !!current.inspector)}>{projectTitle(project)}</button>{project.subject && <small className="muted">{project.subject}</small>}</div>
          </div></td>
          <td>{project.ownerName}</td><td>{project.type === 'topic' ? '创作项目' : '个人作品'}</td>
          <td><Status value={project.status}>{project.statusLabel}</Status>{project.failedTasks > 0 && <small className="danger-text">{project.failedTasks} 项失败</small>}</td>
          <td>{Object.entries(project.materials).filter(([, available]) => available).map(([kind]) => materialLabels[kind as MaterialKind]).join(' · ') || '待补充'}</td>
          <td>{time(project.updatedAt)}</td>
        </tr>;
        })}</tbody></Table></Card> : <EmptyState title="未找到作品" description="可以调整成员、状态或时间筛选。" />}
      <Pager {...data} onPage={page => update({ page })} />
      <p className="small muted">更新于 {time(data.updatedAt)} · 北京时间</p>
    </>}</DataState>
  </section>;
}

export function TaskTable({ tasks, empty = '暂无任务', fromOverview = false }: { tasks: AdminTask[]; empty?: string; fromOverview?: boolean }) {
  const { inspect, route, visit } = useAdminRoute();
  return tasks.length ? <ResponsiveTable className="admin-task-table"><thead role="rowgroup"><tr role="row"><th>任务</th><th>执行来源</th><th>当前状态</th><th>更新</th></tr></thead><tbody role="rowgroup">{tasks.map(task => <tr role="row" key={task.type + task.id} data-selected={route.inspector?.kind === 'task' && route.inspector.type === task.type && route.inspector.id === task.id || undefined}>
    <Cell wide><button className="admin-summary-link" onClick={() => {
      const inspector = { kind: 'task' as const, id: task.id, type: task.type };
      if (fromOverview) visit('tasks', { q: task.id, owner: route.owner, inspector });
      else inspect(inspector);
    }}>{task.title || task.kindLabel}</button><small className="muted">{task.ownerName} · {task.kindLabel} · #{task.id.slice(0, 8)}</small></Cell>
    <Cell label="执行来源">{taskSource(task)}</Cell>
    <Cell label="当前状态"><Status value={task.status}>{task.statusLabel}</Status>{(task.error || task.detail) && <small className={task.error ? 'danger-text admin-clamp' : 'muted admin-clamp'}>{task.error || task.detail}</small>}</Cell><Cell label="更新" wide>{time(task.updatedAt)}</Cell>
  </tr>)}</tbody></ResponsiveTable> : <EmptyState title={empty} />;
}

export function Tasks({ route }: { route: AdminRoute }) {
  const { update } = useAdminRoute();
  const [interval, setInterval] = useState(60_000);
  const resource = useResource<AdminPage<AdminTask>>(listPath(route), { interval: useAdminListInterval(interval) });
  const revision = useContext(AdminListContext)?.taskRevision;
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (lastRevision.current !== revision) { lastRevision.current = revision; resource.reload(); }
  }, [revision, resource.reload]);
  if (resource.data) {
    const next = resource.data.activeCount ? 10_000 : 60_000;
    if (next !== interval) setInterval(next);
  }
  return <section className="stack">
    <PageHeader eyebrow="团队活动" title="任务" description="跟进平台执行与成员 Agent 的持久任务状态。" actions={<Button variant="outline" onClick={resource.reload}>刷新</Button>} />
    <ListFilters route={route} members={resource.data?.members} />
    <DataState resource={resource} label="正在读取任务…">{data => <>
      <div className="row"><Badge tone="blue">{data.activeCount} 平台活动任务</Badge><Badge tone="neutral">{data.waitingAgentCount} 等待 Agent</Badge></div>
      <Card><TaskTable tasks={data.items} /></Card>
      <Pager {...data} onPage={page => update({ page })} />
      <p className="small muted">更新于 {time(data.updatedAt)} · 北京时间</p>
    </>}</DataState>
  </section>;
}

const designFields: [string, string[]][] = [
  ['一句话概念', ['logline', 'one_liner', 'oneLiner']], ['设计概述', ['summary', 'description', 'descr', 'concept']], ['题材', ['subject', 'theme']], ['类型', ['genre', 'game_type']],
  ['独特机制', ['twist', 'innovation']], ['核心玩法', ['core_loop', 'coreLoop', 'gameplay', 'mechanic', 'mechanics']], ['操作方式', ['controls', 'input', 'interaction']], ['美术方向', ['art_direction', 'artDirection', 'visual_style', 'visualStyle']],
  ['配色', ['color_palette', 'palette']], ['节奏与成长', ['progression', 'pacing']], ['声音', ['audio', 'sound']], ['吸引点', ['why_addictive', 'appeal']],
  ['制作要求', ['requirements', 'production_requirements']], ['注意事项', ['risks', 'risk']], ['备注', ['note', 'notes']], ['历史反馈', ['feedback']],
];

function designText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(designText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return '';
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function Design({ value, fallback }: { value: unknown; fallback?: string }) {
  const base = object(value);
  const design = Object.assign({}, base, ...['candidate', 'design', 'expand', 'expanded', 'proposal'].map(key => object(base[key])));
  const fields = designFields.map(([label, names]) => ({ label, value: names.map(name => designText(design[name])).find(Boolean) })).filter(field => field.value);
  return fields.length ? <div className="stack">{fields.map(field => <section key={field.label}><h3>{field.label}</h3><p className="admin-prose">{field.value}</p></section>)}</div> : <p className="admin-prose">{fallback || '当前记录没有可读的设计字段。'}</p>;
}

function Brief({ text }: { text: string }) {
  const headings = text.split(/\r?\n(?=#{1,6}\s)/);
  return <article className="stack">{headings.map((section, index) => {
    const match = section.match(/^#{1,6}\s+([^\n]+)\n?([\s\S]*)$/);
    return match ? <section key={index}><h3>{match[1].trim()}</h3>{match[2].trim() && <div className="admin-prose">{match[2].trim()}</div>}</section> : <div className="admin-prose" key={index}>{section.trim()}</div>;
  })}</article>;
}

function MaterialSource({ path, text }: { path: string; text?: string }) {
  const [open, setOpen] = useState(false);
  const resource = useResource<AdminMaterial>(open && text === undefined ? path + (path.includes('?') ? '&' : '?') + 'raw=1' : null);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{text === undefined ? '查看源码' : '查看原文'}</summary>
    {open && (text !== undefined ? <pre>{text || '当前记录没有可读取的原文。'}</pre> : <DataState resource={resource} label="正在读取源码…">{data => <pre>{data.content || '当前记录没有可读取的源码。'}</pre>}</DataState>)}
  </details>;
}

function SamplePreview({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <EmptyState title="样板图暂时无法预览" description="可下载此版本的原文件。" />
    : <img className="admin-material-image" src={src} alt={title + '样板图预览'} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function Material({ project, kind, version }: { project: AdminProject; kind: MaterialKind; version?: AdminVersion }) {
  const base = adminPath(projectPath(project) + '/material/' + kind);
  const query = version ? '?version=' + segment(version.id) : '';
  const resource = useResource<AdminMaterial>(base + query);
  return <DataState resource={resource} label={'正在读取' + materialLabels[kind] + '…'}>{material => {
    if (!material.available) return <EmptyState title={'暂无' + materialLabels[kind]} description="该记录暂无可读取的材料。" />;
    if (version && material.versionId !== version.id) return <ErrorState error="返回的材料版本与所选历史版本不一致。" onRetry={resource.reload} />;
    const locked = version?.id || material.versionId;
    const resolvedQuery = locked ? '?version=' + segment(locked) : '';
    return <div className="stack"><div className="spread"><div><h2>{version ? '历史' : ''}{materialLabels[kind]}</h2>
      {version ? <small className="muted">{time(version.created_at)} · {version.id}</small> : kind === 'game' && <small className="muted">9:16 竖屏 · 隔离试玩</small>}</div>
      <Download href={base + '/file' + resolvedQuery}>{kind === 'brief' || kind === 'expand' ? '下载文档' : '下载文件'}</Download>
    </div>
    {kind === 'game' ? <GamePlayer src={base + '/preview' + resolvedQuery} title={projectTitle(project)} versionKey={locked} /> :
      kind === 'preview' ? <SamplePreview key={base + resolvedQuery} src={base + '/thumbnail' + resolvedQuery} title={projectTitle(project)} /> :
      kind === 'assets' ? <iframe className="admin-visual" title={materialLabels[kind] + '预览'} sandbox="allow-scripts" referrerPolicy="no-referrer" src={base + '/preview' + resolvedQuery} /> :
      kind === 'brief' ? <Card>{material.content ? <Brief text={material.content} /> : <p>简报正文不可用，可下载原文件检查。</p>}</Card> :
      <Card><Design value={material.content} /></Card>}
    <MaterialSource key={resolvedQuery} path={base + resolvedQuery} text={kind === 'expand' || kind === 'brief' ? material.content || '' : undefined} /></div>;
  }}</DataState>;
}

function RelatedReviews({ reviews }: { reviews: AdminProjectDetail['relatedReviews'] }) {
  const { inspect } = useAdminRoute();
  return <Card className="stack"><h2>关联审核</h2>{reviews.length ? reviews.map(review => <div className="spread" key={review.id}>
    <button className="admin-summary-link" onClick={() => inspect({ kind: 'report', id: String(review.id) })}>{review.title}</button>
    <span className="small muted">{review.score ?? '待复核'}{review.score != null ? ' 分' : ''} · {time(review.createdAt)}</span>
  </div>) : <p className="muted">暂无关联审核报告。</p>}</Card>;
}

function ProjectTasks({ project, reviews }: { project: AdminProject; reviews: AdminProjectDetail['relatedReviews'] }) {
  const { visit } = useAdminRoute();
  const resource = useResource<AdminPage<AdminTask>>(adminPath('tasks?project=' + project.id + '&range=all&page=1&pageSize=25'), { interval: project.activeTasks ? 10_000 : 60_000 });
  return <div className="stack"><RelatedReviews reviews={reviews} /><Card className="stack"><div className="spread"><h2>相关任务</h2><Button variant="outline" size="sm" onClick={() => visit('tasks', { section: 'project:' + project.type + ':' + project.id })}>查看全部</Button></div>
    <DataState resource={resource}>{data => <TaskTable tasks={data.items} />}</DataState></Card></div>;
}

function History({ detail, selectedId, onSelect }: { detail: AdminProjectDetail; selectedId?: string; onSelect: (id: string) => void }) {
  const version = detail.versions.find(row => row.id === selectedId);
  const kind = (version?.kind === 'product' ? 'game' : version?.kind) as MaterialKind | undefined;
  return <div className="admin-split">
    <Card className="stack"><h2>版本列表</h2>
      {detail.versions.length ? <div className="admin-scroll stack">{detail.versions.map(row => <button key={row.id} className="admin-version" data-version={row.id} aria-pressed={row.id === selectedId} onClick={() => onSelect(row.id)}>
        <b>{materialLabels[(row.kind === 'product' ? 'game' : row.kind) as MaterialKind] || row.kind}</b>
        <span className="row">{row.current && <Badge tone="sage">当前采用</Badge>}{row.disposition === 'pending' && <Badge tone="blue">待采用</Badge>}{row.stale && <Badge tone="warning">输入已更新</Badge>}</span>
        <small className="muted">{time(row.created_at)} · {executorLabel(row.executor)}{row.model ? ' · ' + row.model : ''}</small>
      </button>)}</div> : <p className="muted">暂无版本。</p>}
    </Card>
    {version && kind && materialLabels[kind] ? <div className="stack"><Material key={version.id} project={detail.project} kind={kind} version={version} />
      {version.restored_from && <p className="small muted">恢复自 {version.restored_from}</p>}</div> : <EmptyState title={selectedId ? '未找到可预览的版本' : '选择一个历史版本'} description="历史材料、预览与下载均按选定版本读取。" />}
  </div>;
}

export function ProjectDetail({ route, embedded = false }: { route: AdminRoute; embedded?: boolean }) {
  const { update, inspect, copy } = useAdminRoute();
  const path = adminPath(projectPath({ id: route.id || '', type: route.type === 'game' ? 'game' : 'topic' }));
  const resource = useResource<AdminProjectDetail>(path, { interval: 60_000 });
  function select(panel: string, version?: string) {
    if (embedded) inspect({ kind: 'project', id: route.id!, type: route.type === 'game' ? 'game' : 'topic', panel, version });
    else update({ panel, version });
  }
  return <section className="stack">
    {!embedded && <Button variant="ghost" onClick={() => update({ id: undefined, panel: undefined, version: undefined })}>← 返回作品</Button>}
    <DataState resource={resource} label="正在读取作品详情…">{detail => {
      const { project } = detail;
      const primary = project.materials.game ? 'game' : 'overview';
      const materials: [string, string][] = [
        ...(project.materials.game ? [['overview', '设计概览'] as [string, string]] : []),
        ...Object.entries(materialLabels).filter(([kind]) => kind !== 'game' && project.materials[kind as MaterialKind]),
        ['history', '历史版本' + (detail.versions.length ? '（' + detail.versions.length + '）' : '')],
      ];
      const tabs = [{ id: primary, label: project.materials.game ? '试玩' : '作品概览' }, { id: 'materials', label: '创作材料' }, { id: 'tasks', label: '任务与审核' }];
      const panel = route.panel === 'materials' ? materials[0][0] : route.panel && [primary, 'tasks', ...materials.map(([id]) => id)].includes(route.panel) ? route.panel : primary;
      const section = panel === primary || panel === 'tasks' ? panel : 'materials';
      return <>
        <PageHeader title={projectTitle(project)} description={project.ownerName + ' · ' + project.statusLabel} actions={<div className="row"><Button variant="outline" size="sm" onClick={() => void copy(location.href)}>复制链接</Button>{project.materials.game && (panel === 'overview' || panel === 'tasks') && <Download href={adminPath(projectPath(project) + '/material/game/file')}>下载成品</Download>}</div>} />
        <Tabs items={tabs} value={section} onChange={value => select(value === 'materials' ? materials[0][0] : value)} />
        {section === 'materials' && <Field label="查看材料或历史版本"><Select value={panel} onChange={event => select(event.target.value)}><Options items={materials} /></Select></Field>}
        {panel === 'overview' ? <div className="grid-2"><Card className="stack"><h2>设计概览</h2><Design value={detail.overview} fallback={project.summary} /><JsonDetails label="完整作品信息" value={detail.overview} /></Card><div className="stack"><Card className="stack"><h2>作品信息</h2>
          <Facts items={[[ '成员', project.ownerName ], [ '来源', project.type === 'topic' ? '创作项目' : '个人作品' ], [ '题材', project.subject || '未填写' ], [ '创建时间', time(project.createdAt) ], [ '更新时间', time(project.updatedAt) ], [ '进行中任务', project.activeTasks ], [ '失败任务', project.failedTasks ]]} />
        </Card><RelatedReviews reviews={detail.relatedReviews} /></div></div> : panel === 'tasks' ? <ProjectTasks project={project} reviews={detail.relatedReviews} /> :
          panel === 'history' ? <History detail={detail} selectedId={route.version} onSelect={id => select('history', id)} /> :
          <Material key={path + panel} project={project} kind={panel as MaterialKind} />}
      </>;
    }}</DataState>
  </section>;
}

export function TaskDetail({ route, embedded = false }: { route: AdminRoute; embedded?: boolean }) {
  const { update, inspect, visit, notify, copy } = useAdminRoute();
  const type = route.type === 'review' ? 'review' : 'creation';
  const path = 'tasks/' + type + '/' + segment(route.id || '');
  const refreshTasks = useContext(AdminListContext)?.refreshTasks;
  const [interval, setInterval] = useState(60_000);
  const resource = useResource<AdminTaskDetail>(adminPath(path), { interval });
  const action = useAction();
  if (resource.data) {
    const { task } = resource.data;
    const next = task.executor === 'platform' && !terminal(task.status) ? 10_000 : 60_000;
    if (next !== interval) setInterval(next);
  }
  const openTask = (id: string) => embedded ? inspect({ kind: 'task', id, type }) : update({ id, type });
  return <section className="stack">
    {!embedded && <Button variant="ghost" onClick={() => update({ id: undefined })}>← 返回任务</Button>}
    <DataState resource={resource} label="正在读取任务详情…">{detail => {
      const { task } = detail, active = !terminal(task.status);
      return <>
        <PageHeader eyebrow={type === 'review' ? '审核任务' : '创作任务'} title={task.title || task.kindLabel} description={[task.ownerName, task.kindLabel, taskSource(task)].join(' · ')} actions={<Button variant="outline" size="sm" onClick={resource.reload}>刷新</Button>} />
        <div className="grid-2"><div className="stack"><Card className="stack"><div className="row"><Status value={task.status}>{task.statusLabel}</Status><span className="small muted">更新于 {time(task.updatedAt)}</span></div>
          <h2>{task.error ? '任务未完成' : active && task.executor === 'agent' ? '等待成员 Agent' : task.status === 'queued' ? '任务已排队' : active ? '平台任务进行中' : '任务已结束'}</h2>
          <p className="admin-prose">{task.detail || (active && task.executor === 'agent' ? '状态会随原设备的领取或结果回传更新。' : '可查看关联作品和结果了解详情。')}</p>
          {active && task.executor === 'platform' && <progress aria-label={task.statusLabel} />}
          {task.error && <details><summary>失败原因</summary><pre>{task.error}</pre></details>}
          <div className="row">
            {task.projectId != null && task.projectType && <Button variant="outline" onClick={() => inspect({ kind: 'project', id: String(task.projectId), type: task.projectType || 'topic' })}>关联作品</Button>}
            {task.resultId != null && type === 'review' && <Button onClick={() => inspect({ kind: 'report', id: String(task.resultId) })}>审核报告</Button>}
            {detail.retryTaskId && <Button variant="outline" onClick={() => openTask(detail.retryTaskId!)}>查看重试任务</Button>}
          </div>
        </Card>
        {detail.continuePrompt && <Card className="stack"><h2>在成员 Agent 中继续</h2><p className="small muted">将指令交给原任务的成员 Agent，在原设备继续。</p><pre>{detail.continuePrompt}</pre><Button variant="outline" onClick={() => void copy(detail.continuePrompt!)}>复制继续指令</Button></Card>}
        {!active && !detail.retryTaskId && (task.canRetry || task.error) && <Card className="stack"><h2>{task.canRetry ? '重新执行任务' : '后续处理'}</h2>
          <p>{task.retryReason || '确认后使用原始创作输入，创建新的平台任务。'}</p>
          {task.canRetry && type === 'creation' ? <ConfirmAction description="确认后创建新的任务编号并重新请求平台模型，可能产生模型费用。" onConfirm={async () => {
            const result = await action.run(() => post<{ task: AdminTask }>(path + '/retry'));
            if (result) { refreshTasks?.(); notify('已创建重试任务。', 'success'); openTask(result.task.id); }
          }}>重试任务</ConfirmAction> : type === 'review' && task.executor === 'platform' && <Button variant="outline" onClick={() => visit('settings', { section: 'upload' })}>重新上传原文件</Button>}
          <StatusText {...action} label="正在创建重试任务…" /></Card>}
        </div><Card className="stack"><h2>任务信息</h2>
          <Facts items={[[ '任务编号', <code>{task.id}</code> ], [ '执行来源', taskSource(task) ], [ '提交时间', time(task.createdAt) ], [ '开始时间', time(task.startedAt) ], [ '最近更新', time(task.updatedAt) ], [ '原始材料', detail.sourceAvailable ? '可用' : '不可用' ], ...(task.retryOf ? [['重试自', <button className="admin-summary-link" onClick={() => openTask(task.retryOf!)}>{task.retryOf}</button>] as [string, React.ReactNode]] : []), ...(task.requestedBy ? [['重试发起人', task.requestedBy] as [string, React.ReactNode]] : [])]} />
        </Card></div>
      </>;
    }}</DataState>
  </section>;
}
