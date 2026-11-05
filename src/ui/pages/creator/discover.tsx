import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, ConfirmAction, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Select, Textarea } from '../../components/ui';
import { useApp } from '../../context';
import { api, useAction, useResource } from '../../lib/api';
import { ExecutorPicker, IdeaDetails, TaskProgress, TopicTags } from './common';
import { PaletteCard } from './PaletteCard';
import { creatorUrl, dimensionLabels, dims, forge, isActive, isSeed, latestTask, storageGet, storageSet, titleOf, type CreatorState, type Dim, type Executor, type Idea, type MechanismCheck, type Rules, type Task, type Topic } from './model';

export type TaskProps = {tasks: Task[]; refreshTasks: () => void; tasksError: string | null};
export type ExecutorProps = {executor: Executor; onExecutor: (value: Executor) => void};
type StateResource = {data: CreatorState | null | undefined; loading: boolean; error: string | null; reload: () => void};
const checkLabels: Record<string, string> = {
  no_matches: '目录没有检索到可比较条目', distinct: '比较确认存在机制区别', exact: '目录中已有相同机制', duplicate: '机制重复',
  uncertain: '待核对，暂不能登记', pending: '等待机制比较',
};

export function Discover({userId, executor, onExecutor, state, tasks, refreshTasks, tasksError}: TaskProps & ExecutorProps & {userId: string; state: StateResource}) {
  const {navigate, notify} = useApp();
  const rules = useResource<Rules>(`${forge}/settings`);
  const vocab = useResource<import('./model').Word[]>(`${forge}/vocab`);
  const source = useResource<Topic[]>(`${forge}/topics?status=drawn,new,dup&limit=60`);
  const [requirements, setRequirements] = useState('');
  const [subject, setSubject] = useState('');
  const [locks, setLocks] = useState<Partial<Record<Dim, string>>>({});
  const [size, setSize] = useState<string | null>(() => storageGet(`forge-draw-size-${userId}`, true) || null);
  const drawSize = size ?? rules.data?.draw_size ?? '12';
  const [selected, setSelected] = useState<number[]>([]);
  const [generated, setGenerated] = useState<Topic[]>([]);
  const drawAction = useAction();
  const expandAction = useAction();
  const archiveAction = useAction();
  const request = useRef<{key: string; id: string} | null>(null);
  const modern = state.data?.creative_v2_available;
  const recent = tasks.filter(task => task.kind === 'expand' && !isActive(task)).map(task => `${task.id}:${task.status}`).join(',');
  const previousRecent = useRef(recent);
  useEffect(() => {
    if (previousRecent.current === recent) return;
    previousRecent.current = recent;
    source.reload();
  }, [recent]);
  const topics = [...new Map([...generated, ...(source.data || [])].map(topic => [topic.id, topic])).values()].sort((a, b) => b.id - a.id);
  useEffect(() => {
    if (source.data) setGenerated(items => items.filter(item => !source.data?.some(topic => topic.id === item.id)));
  }, [source.data]);
  const drawable = typeof modern === 'boolean' && Boolean(rules.data && vocab.data) && !drawAction.busy;
  const selectable = topics.filter(topic => !topic.data?.title && !topic.data?.candidates && !isActive(latestTask(tasks, topic.id, 'expand')) && !['queued', 'running'].includes(topic.expand_status || '') && (modern || !isSeed(topic)));
  const selectedTopics = selectable.filter(topic => selected.includes(topic.id));
  const expand = (targets: Topic[]) => expandAction.run(async () => {
    if (tasksError) throw new Error('请先刷新任务状态，再提交扩写。');
    const query = new URLSearchParams({executor});
    const ids = targets.slice(0, 40);
    try {
      const legacy = ids.filter(topic => !isSeed(topic));
      const seeds = ids.filter(isSeed);
      if (legacy.length) await api(`${forge}/expand?${query}`, {method: 'POST', body: {ids: legacy.map(topic => topic.id)}});
      if (seeds.length) {
        query.set('creative_version', '2');
        await api(`${forge}/expand?${query}`, {method: 'POST', body: {ids: seeds.map(topic => topic.id)}});
      }
      setSelected([]);
      notify('已提交扩写，请查看实际任务与执行方式。', 'success');
    } finally { refreshTasks(); source.reload(); }
  });
  const draw = (custom: boolean) => drawAction.run(async () => {
    const input = {subject: custom ? subject.trim() : '', locks, requirements: requirements.trim(), ...(modern ? {creative_version: 2} : {n: custom ? 1 : Number(drawSize)})};
    const key = JSON.stringify(input);
    if (request.current?.key !== key) request.current = {key, id: crypto.randomUUID()};
    const rows = await api<Topic[]>(`${forge}/draw`, {method: 'POST', body: {...input, request_id: request.current.id}});
    request.current = null;
    setGenerated(previous => [...rows, ...previous]);
    setSelected(rows.map(topic => topic.id));
    source.reload();
    state.reload();
    vocab.reload();
    notify(rows.length ? `已创建 ${rows.length} 个待扩写选题` : '没有抽到可用题材，请调整锁定条件。', rows.length ? 'success' : 'info');
  });
  const updateStatus = async (topic: Topic, status: string) => {
    await api(`${forge}/topics/${topic.id}`, {method: 'PATCH', body: {status}});
    setGenerated(previous => previous.filter(item => item.id !== topic.id));
    source.reload();
  };
  const errors = [{error: state.error, retry: state.reload}, {error: rules.error, retry: rules.reload}, {error: vocab.error, retry: vocab.reload}, {error: source.error, retry: source.reload}, {error: tasksError, retry: refreshTasks}];
  return <section className="page creator-page">
    <PageHeader title="发现选题" eyebrow="灵感抽屉" description="用词库抽出灵感，或带上自己的主题。每一步都由你发起。"
      actions={<Button variant="outline" onClick={() => navigate(creatorUrl({tab: 'picks'}))}>我的项目</Button>}/>
    <div className="creator-draw-board">
      <Card className="creator-draw-form"><div className="spread row"><h2>抽一张灵感纸</h2><Badge tone={modern ? 'sage' : 'neutral'}>{modern ? '机制候选' : modern === false ? '原版抽签' : '读取规则'}</Badge></div>
        <p className="muted">{modern ? '先保存种子，再扩写 8–12 个方案。推荐最多三项，选定前按候选查重。' : '锁定想保留的维度，其他维度随机抽取。'}</p>
        <div className="creator-locks">{dims.map(dim => <Field key={dim} label={dimensionLabels[dim]}><Select value={locks[dim] || ''} onChange={event => setLocks({...locks, [dim]: event.target.value})}>
          <option value="">随机</option>{vocab.data?.filter(word => word.dim === dim && word.enabled && (modern || !word.used)).map(word => <option key={word.id} value={word.word}>{word.word}</option>)}
        </Select></Field>)}</div>
        <Field label="补充创作要求" hint="随选题保存，供后续创作任务读取。"><Textarea rows={3} maxLength={12000} value={requirements} onChange={event => setRequirements(event.target.value)} placeholder="想服务的玩家、操作限制、美术氛围…"/></Field>
        <form className="row" onSubmit={event => {event.preventDefault(); void draw(false);}}>
          {modern === false && <Field label="数量"><Input className="creator-count" type="number" inputMode="numeric" min={1} max={40} step={1} required value={drawSize} onChange={event => setSize(event.target.value)}/></Field>}
          <Button type="submit" disabled={!drawable}>{drawAction.busy ? '保存中…' : '抽一批'}</Button>
        </form>
        <form className="row creator-custom" onSubmit={event => {event.preventDefault(); void draw(true);}}><Field label="也可以用自己的主题"><Input maxLength={200} value={subject} onChange={event => setSubject(event.target.value)} placeholder="例如：午夜修补玩具"/></Field><Button type="submit" variant="outline" disabled={!drawable || !subject.trim()}>创建自定义选题</Button></form>
      </Card>
      <Card className="creator-draw-guide"><div className="creator-step-no">01—03</div><h2>从灵感到项目</h2><ol><li>抽签或自定义一个主题。</li><li>明确发起扩写，比较玩法和实现风险。</li><li>{modern ? '查看查重记录，选择并登记机制。' : '将想做的选题加入项目。'}</li></ol>
        <ExecutorPicker value={executor} onChange={onExecutor}/>
        {modern === false && typeof state.data?.fresh_subjects === 'number' && <p className="small muted">公共词库可抽题材 · {state.data.fresh_subjects}</p>}
        <Button size="sm" variant="ghost" onClick={() => navigate(creatorUrl({tab: 'settings'}))}>查看规则与抽签偏好 →</Button>
      </Card>
    </div>
    {errors.map(({error, retry}, index) => error && <ErrorState key={index} error={error} onRetry={retry}/>)}
    <div className="spread row"><h2 className="section-title">我的候选 <small>{topics.length}</small></h2><div className="row">
      {selectable.length > 0 && <><Button size="sm" variant="ghost" onClick={() => setSelected(selectedTopics.length ? [] : selectable.slice(0, 40).map(topic => topic.id))}>{selectedTopics.length ? '取消选择' : '选择待扩写项'}</Button><Button size="sm" disabled={!selectedTopics.length || expandAction.busy || Boolean(tasksError)} onClick={() => void expand(selectedTopics)}>开始扩写{selectedTopics.length ? ` · ${selectedTopics.length}` : ''}</Button></>}
      {topics.length > 0 && <ConfirmAction title="归档未处理选题" description={`将当前列表中未处理的 ${topics.length} 个选题归档。正在执行的选题会保留。`} variant="outline" onConfirm={async () => {await archiveAction.run(async () => {
        const idle = topics.filter(topic => !isActive(latestTask(tasks, topic.id, 'expand')) && !['queued', 'running'].includes(topic.expand_status || ''));
        for (const topic of idle) await updateStatus(topic, 'rejected');
      });}}>归档未处理选题</ConfirmAction>}
    </div></div>
    {source.loading && !topics.length ? <Loading label="正在读取候选"/> : !topics.length && !source.error ? <EmptyState title="灵感抽屉是空的" description="抽一批或填写自己的主题，就能在这里比较和选择。"/> : null}
    <div className="creator-round-grid">{topics.map(topic => <CandidateRound key={topic.id} topic={topic} userId={userId} tasks={tasks} refreshTasks={refreshTasks} modern={modern === true} executor={executor}
      checked={selected.includes(topic.id)} setChecked={checked => setSelected(previous => checked ? [...new Set([...previous, topic.id])] : previous.filter(id => id !== topic.id))}
      eligible={selectable.includes(topic)} expandDisabled={expandAction.busy || Boolean(tasksError)} onExpand={() => void expand([topic])} onStatus={status => updateStatus(topic, status)}/>)}</div>
  </section>;
}

function CandidateRound({topic, userId, tasks, refreshTasks, modern, executor, checked, setChecked, eligible, expandDisabled, onExpand, onStatus}: {
  topic: Topic; userId: string; tasks: Task[]; refreshTasks: () => void; modern: boolean; executor: Executor; checked: boolean; setChecked: (checked: boolean) => void;
  eligible: boolean; expandDisabled: boolean; onExpand: () => void; onStatus: (status: string) => Promise<void>;
}) {
  const {navigate, notify} = useApp();
  const update = useAction();
  const task = latestTask(tasks, topic.id, 'expand');
  const ideas = topic.data?.candidates;
  const chosen = [...new Set(topic.data?.recommended ?? [])].filter(index => Number.isInteger(index) && ideas?.[index]).slice(0, 3);
  const others = ideas?.map((_, index) => index).filter(index => !chosen.includes(index)) ?? [];
  const openVersions = () => navigate(creatorUrl({tab: 'draw', project: topic.id, panel: 'versions'}));
  const card = (index: number, recommended: boolean) => ideas?.[index] && <MechanismCard key={index} topic={topic} index={index} idea={ideas[index]} recommended={recommended} userId={userId} tasks={tasks} refreshTasks={refreshTasks} modern={modern} executor={executor}/>;
  return <Card className={`creator-round ${ideas ? 'is-mechanism-batch' : 'is-idea-card'}`}>
    <div className="spread row creator-round-head"><div><div className="creator-kicker">{isSeed(topic) ? '机制候选轮次' : '选题卡'} · #{topic.id}</div><h3>{titleOf(topic)}</h3></div><Button variant="ghost" size="sm" onClick={openVersions}>历史版本</Button></div>
    <TopicTags topic={topic}/>
    {task ? <TaskProgress task={task}/> : topic.expand_error ? <p className="danger-text">{topic.expand_error}</p> : null}
    {task?.result?.disposition === 'pending' && <Button variant="outline" size="sm" onClick={openVersions}>查看待采用结果</Button>}
    {ideas ? <>
      <p className="small muted">{ideas.length} 个完整方案 · {chosen.length} 个推荐</p>
      {chosen.length > 0 && <div className="creator-card-grid">{chosen.map(index => card(index, true))}</div>}
      {others.length > 0 && <details className="creator-disclosure"><summary>比较其他 {others.length} 个方案</summary><div className="creator-card-grid">{others.map(index => card(index, false))}</div></details>}
    </> : topic.data?.title ? <>
    {topic.data.logline && <p className="creator-idea-logline">{topic.data.logline}</p>}
    {topic.data.core_loop && <div className="creator-idea-loop"><b>核心循环</b><p>{topic.data.core_loop}</p></div>}
    <PaletteCard idea={topic.data}/>
    <details className="creator-disclosure"><summary>玩法、美术与风险</summary><IdeaDetails idea={{...topic.data, core_loop: undefined}} compact paletteShown/></details>
    <div className="row creator-idea-actions"><Button disabled={update.busy} onClick={() => void update.run(async () => {
      await onStatus('liked'); notify('已加入我的项目', 'success'); navigate(creatorUrl({tab: 'picks', project: topic.id}));
    })}>加入我的项目</Button><Button variant="ghost" disabled={update.busy} onClick={() => void update.run(() => onStatus('rejected'))}>归档</Button></div></> : <div className="row">
      {eligible && <><label className="row small"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)}/>加入扩写批次</label><Button size="sm" variant="outline" disabled={expandDisabled} onClick={onExpand}>{task?.status === 'error' ? '重新扩写' : '开始扩写'}</Button></>}
      {!eligible && !task && <span className="small muted">等待可用的创作流程或任务状态。</span>}
    </div>}
  </Card>;
}

function MechanismCard({topic, index, idea, recommended, userId, tasks, refreshTasks, modern, executor}: {
  topic: Topic; index: number; idea: Idea; recommended: boolean; userId: string; tasks: Task[]; refreshTasks: () => void; modern: boolean; executor: Executor;
}) {
  const {navigate, notify} = useApp();
  const storageKey = `forge-mechanism-${userId}-${topic.id}-${index}`;
  const task = tasks.find(row => row.kind === 'mechanism-check' && row.scope?.endsWith(`:mechanism-check:${topic.id}:${index}`));
  const [checkId, setCheckId] = useState(() => storageGet(storageKey) || task?.result?.check_id || '');
  const observedTask = useRef(task?.result?.check_id);
  const [chosenId, setChosenId] = useState(() => storageGet(`${storageKey}-project`) ?? '');
  const action = useAction();
  const taskResult = task?.result?.check_id;
  useEffect(() => {
    if (taskResult && taskResult !== observedTask.current) {
      observedTask.current = taskResult;
      setCheckId(taskResult);
    }
  }, [taskResult]);
  const currentId = checkId;
  const check = useResource<MechanismCheck>(currentId ? `${forge}/mechanisms/${encodeURIComponent(currentId)}` : null);
  const result = check.data?.check_id === currentId ? check.data : undefined;
  const status = result?.effective_state || result?.state || '';
  const canChoose = result && !result.stale && ['no_matches', 'distinct'].includes(status);
  useEffect(() => { if (currentId) storageSet(storageKey, currentId); }, [currentId, storageKey]);
  const start = () => action.run(async () => {
    try {
      const response = await api<MechanismCheck & {pending?: boolean}>(`${forge}/mechanisms/check?executor=${executor}`, {method: 'POST', body: {topic_id: topic.id, candidate_index: index}});
      if (response.check_id) setCheckId(response.check_id);
      if (!response.pending) check.setData(response);
      notify(response.pending ? '已登记查重任务' : '已读取查重结果', 'success');
    } finally {refreshTasks();}
  });
  const choose = () => action.run(async () => {
    if (!result) return;
    try {
      const saved = await api<{topic_id: number}>(`${forge}/mechanisms/choose`, {method: 'POST', body: {topic_id: topic.id, candidate_index: index, check_id: result.check_id}});
      storageSet(`${storageKey}-project`, String(saved.topic_id));
      setChosenId(String(saved.topic_id));
      notify('机制已登记为项目', 'success');
      navigate(creatorUrl({tab: 'picks', project: saved.topic_id}));
    } finally {check.reload();}
  });
  return <article className="creator-mechanism">
    <div className="spread row"><small className="creator-kicker">候选 {String(index + 1).padStart(2, '0')}</small>{recommended && <Badge tone="sage">推荐</Badge>}</div>
    <h4>{idea.title || `候选 ${index + 1}`}</h4><p className="creator-idea-logline">{idea.logline}</p>
    {idea.core_loop && <div className="creator-idea-loop"><b>核心循环</b><p>{idea.core_loop}</p></div>}
    <PaletteCard idea={idea}/>
    <details className="creator-disclosure"><summary>机制、美术与风险</summary><IdeaDetails idea={{...idea, core_loop: undefined}} compact paletteShown/></details>
    {task && <TaskProgress task={task}/>}
    {check.loading && currentId && !result && <Loading label="正在读取查重结果"/>}
    {check.error && <ErrorState error={check.error} onRetry={check.reload}/>}
    {result && <p role="status"><Badge tone={canChoose ? 'sage' : status === 'duplicate' || status === 'exact' ? 'danger' : 'warning'}>{result.stale ? '目录或候选已更新，请重新查重' : checkLabels[status] || status}</Badge></p>}
    {result?.model && <p className="small muted">{result.model.executor === 'agent' ? 'Agent 声明模型' : '平台执行模型'} · {result.model.name}</p>}
    {(result?.judgment?.matches?.some(match => match.reason) || result?.admin_resolution?.reason) && <details className="creator-disclosure"><summary>比较依据与处理说明</summary>
      {result?.judgment?.matches?.map((match, n) => match.reason && <p key={n}>{match.reason}</p>)}{result?.admin_resolution?.reason && <p>管理员处理 · {result.admin_resolution.reason}</p>}
    </details>}
    {chosenId ? <Button variant="outline" size="sm" onClick={() => navigate(creatorUrl({tab: 'picks', project: chosenId}))}>打开已登记项目</Button> : modern && <div className="row">
      <Button variant="outline" size="sm" disabled={action.busy || isActive(task)} onClick={() => result && !result.stale && task?.status !== 'error' ? check.reload() : void start()}>{result && !result.stale && task?.status !== 'error' ? '刷新查重记录' : result || task?.status === 'error' ? '重新查重' : '机制查重'}</Button>
      {canChoose && <ConfirmAction title="登记机制" description="将这一候选登记为项目。登记结果保留为原始扩写版本，后续环节由你另外开始。" onConfirm={async () => {await choose();}}>选择并登记</ConfirmAction>}
    </div>}
  </article>;
}
