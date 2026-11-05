import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Select } from '../../components/ui';
import { useApp } from '../../context';
import { api, useResource } from '../../lib/api';
import { ExecutorPicker } from './common';
import { Discover } from './discover';
import { Project } from './project';
import { StyleThumbnail } from './StyleThumbnail';
import { ProductCard } from './ProductCard';
import { AgentPage, GamesPage, Preferences, TaskCenter, Vocabulary } from './secondary';
import { creatorUrl, displayDate, forge, isActive, projectState, storageGet, storageSet, titleOf, type CreatorState, type Executor, type Task, type Topic } from './model';
import './creator.css';

const tabs = new Set(['picks', 'draw', 'products', 'games', 'vocab', 'settings', 'agent', 'tasks']);
const stateLabels = { working: '进行中', product: '可试玩', error: '需处理', draft: '创作中' } as const;
const tone = { working: 'warning', product: 'sage', error: 'danger', draft: 'neutral' } as const;

export default function CreatorApp() {
  const {user} = useApp();
  return <Workspace key={user?.id ?? 'creator'} userId={user?.id ?? 'creator'}/>;
}

function Workspace({userId}: {userId: string}) {
  const {params} = useApp();
  const projectId = /^\d+$/.test(params.get('project') ?? '') ? Number(params.get('project')) : 0;
  const requested = params.get('tab') ?? 'picks';
  const page = projectId ? 'project' : tabs.has(requested) ? requested : 'picks';
  const executorKey = `forge-executor-${userId}`;
  const [executor, setExecutor] = useState<Executor>(() => storageGet(executorKey) === 'agent' ? 'agent' : 'platform');
  const changeExecutor = (value: Executor) => { setExecutor(value); storageSet(executorKey, value); };
  const [poll, setPoll] = useState<number | undefined>();
  const taskList = useResource<Task[]>(`${forge}/generation-jobs`, {interval: poll});
  const tasks = taskList.data ?? [];
  const hasPlatform = tasks.some(task => task.executor !== 'agent' && isActive(task));
  const hasAgent = tasks.some(task => task.executor === 'agent' && isActive(task));
  useEffect(() => { setPoll(hasPlatform ? 10000 : hasAgent ? 60000 : undefined); }, [hasPlatform, hasAgent]);
  const state = useResource<CreatorState>(page === 'project' || page === 'draw' ? `${forge}/state` : null);
  const taskProps = {tasks, refreshTasks: taskList.reload, tasksError: taskList.error};
  let content;
  switch (page) {
    case 'project':
      content = <Project key={projectId} id={projectId} executor={executor} onExecutor={changeExecutor} modern={state.data?.creative_v2_available} modernError={state.error} retryModern={state.reload} {...taskProps}/>;
      break;
    case 'draw':
      content = <Discover userId={userId} executor={executor} onExecutor={changeExecutor} state={state} {...taskProps}/>;
      break;
    case 'products':
    case 'picks':
      content = <ProjectLibrary key={page} products={page === 'products'} tasks={tasks} taskError={taskList.error} retryTasks={taskList.reload}/>;
      break;
    case 'games':
      content = <GamesPage userId={userId} {...taskProps}/>;
      break;
    case 'vocab':
      content = <Vocabulary {...taskProps}/>;
      break;
    case 'settings':
      content = <Preferences userId={userId} executor={executor} onExecutor={changeExecutor}/>;
      break;
    case 'agent':
      content = <AgentPage/>;
      break;
    default:
      content = <TaskCenter {...taskProps} loading={taskList.loading}/>;
  }
  return <div className="creator-workspace">{content}</div>;
}

function ProjectLibrary({products, tasks, taskError, retryTasks}: {products: boolean; tasks: Task[]; taskError: string | null; retryTasks: () => void}) {
  const {params, navigate} = useApp();
  const projects = useResource<Topic[]>(products ? null : `${forge}/topics?status=liked,made&limit=500`);
  const games = useResource<Topic[]>(`${forge}/products`);
  const activeTaskIds = useRef(new Set<string>());
  useEffect(() => {
    const relevant = tasks.filter(task => ['expand', 'brief', 'preview', 'assets', 'game'].includes(task.kind));
    const finished = relevant.some(task => !isActive(task) && activeTaskIds.current.has(task.id));
    activeTaskIds.current = new Set(relevant.filter(isActive).map(task => task.id));
    if (finished) {
      if (!products) projects.reload();
      games.reload();
    }
  }, [tasks, products, projects.reload, games.reload]);
  const merged = new Map<number, Topic>((projects.data ?? []).map(topic => [topic.id, topic]));
  for (const topic of games.data ?? []) merged.set(topic.id, {...merged.get(topic.id), ...topic});
  const all = [...merged.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '') || b.id - a.id);
  const q = params.get('q') || '';
  const requestedFilter = params.get('filter');
  const filter = requestedFilter && Object.hasOwn(stateLabels, requestedFilter) ? requestedFilter : 'all';
  const cards = products || params.get('layout') !== 'list';
  const matches = all.filter(topic => `${titleOf(topic)} ${topic.subject ?? ''} ${topic.data?.logline ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()) && (filter === 'all' || (filter === 'product' ? Boolean(topic.has_product) : projectState(topic, tasks) === filter)));
  const pages = Math.max(1, Math.ceil(matches.length / 24));
  const current = Math.max(1, Math.min(pages, Number.parseInt(params.get('page') || '1', 10) || 1));
  const update = (change: Record<string, string | null>, replace = true) => {
    const next = new URLSearchParams(params);
    next.set('tab', products ? 'products' : 'picks');
    Object.entries(change).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    navigate(creatorUrl(next), replace);
  };
  const open = (id: number, panel = 'create') => update({project: String(id), panel}, false);
  const error = projects.error || games.error;
  return <section className="page creator-page">
    <PageHeader title={products ? '游戏成品' : '我的项目'} eyebrow={products ? '作品架' : '个人创作工作台'}
      description={products ? '点击封面或名称即可试玩。制作材料、历史版本与下载保存在项目里。' : `${cards?'点击封面或名称':'点击项目名称'}继续创作。选题、制作材料和历史版本都保存在项目里。`}
      actions={<Button onClick={() => navigate(creatorUrl({tab: 'draw'}))}>发现新选题 →</Button>}/>
    <Card className="creator-filter"><div className="creator-toolbar">
      <Field label="搜索项目"><Input type="search" placeholder="名称、题材或一句话概念" value={q} onChange={event => update({q: event.target.value, page: null})}/></Field>
      <Field label="状态"><Select value={filter} onChange={event => update({filter: event.target.value === 'all' ? null : event.target.value, page: null})}><option value="all">全部状态</option><option value="working">进行中</option><option value="product">已有成品</option><option value="error">需处理</option><option value="draft">创作中</option></Select></Field>
      {!products&&<div role="group" aria-label="项目显示方式" className="row"><Button variant={cards ? 'ghost' : 'secondary'} size="sm" aria-pressed={!cards} onClick={() => update({layout: 'list'})}>列表</Button><Button variant={cards ? 'secondary' : 'ghost'} size="sm" aria-pressed={cards} onClick={() => update({layout: 'cards'})}>卡片</Button></div>}
    </div></Card>
    {error && <ErrorState error={error} onRetry={() => { if (!products) projects.reload(); games.reload(); }}/>}
    {taskError && <ErrorState error={taskError} onRetry={retryTasks}/>}
    {!all.length && (projects.loading || games.loading) && <Loading label="正在读取项目"/>}
    {all.length > 0 || (!error && !projects.loading && !games.loading) ? <>
      {matches.length ? <div className={cards ? 'creator-card-grid' : 'creator-project-list'}>
        {matches.slice((current - 1) * 24, current * 24).map(topic => {
          if(products)return <ProductCard key={topic.id} topic={topic} onProject={()=>open(topic.id)}/>;
          const status = projectState(topic, tasks);
          return <article key={topic.id} className={cards ? 'creator-project-card' : 'creator-project-row'}>
            {cards && <div className="creator-project-mast"><span>项目 {String(topic.id).padStart(3, '0')}</span><Badge tone={tone[status]}>{stateLabels[status]}</Badge></div>}
            <StyleThumbnail topic={topic} onContinue={cards?()=>open(topic.id):undefined}/>
            <div className="creator-row-copy"><button className="creator-title-link" onClick={() => open(topic.id)}>{titleOf(topic)}</button><p>{topic.data?.logline || topic.subject || '等待补充概念'}</p>{cards && <small className="muted">{displayDate(topic.updated_at)}</small>}</div>
            {!cards && <Badge tone={tone[status]}>{stateLabels[status]}</Badge>}
            {cards ? Boolean(topic.has_product)&&<Button variant="ghost" size="sm" onClick={()=>open(topic.id,'play')}>试玩成品 →</Button> : <Button variant="ghost" size="sm" onClick={()=>open(topic.id)}>继续创作 →</Button>}
          </article>;
        })}
      </div> : <EmptyState title={q || filter !== 'all' ? '没有匹配的项目' : products ? '还没有游戏成品' : '从一个想法开始'} description={q || filter !== 'all' ? '试试其他关键词或状态。' : '发现一个想做的选题，开始整理材料。'}
        action={<Button variant="outline" onClick={() => q || filter !== 'all' ? update({q: null, filter: null, page: null}) : navigate(creatorUrl({tab: 'draw'}))}>{q || filter !== 'all' ? '清除筛选' : '发现选题'}</Button>}/>}
      {matches.length > 0 && <nav className="row creator-pager" aria-label="项目分页"><Button variant="outline" size="sm" disabled={current <= 1} onClick={() => update({page: String(current - 1)})}>上一页</Button><span className="small muted">第 {current} / {pages} 页 · {matches.length} 个项目</span><Button variant="outline" size="sm" disabled={current >= pages} onClick={() => update({page: String(current + 1)})}>下一页</Button></nav>}
    </> : null}
  </section>;
}
