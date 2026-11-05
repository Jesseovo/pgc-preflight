import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, ConfirmAction, EmptyState, ErrorState, Field, Loading, PageHeader, Tabs, Textarea } from '../../components/ui';
import { useApp } from '../../context';
import { api, useAction, useResource } from '../../lib/api';
import { ExecutorPicker, IdeaDetails, TaskProgress, TopicTags } from './common';
import { Artifact, ProjectChecks, ProjectReviews, VersionPanel } from './project-materials';
import { creatorUrl, forge, hasArtifact, isActive, isSeed, latestTask, oldStageState, stageLabels, taskProject, titleOf, type Kind, type Topic, type Version } from './model';
import type { ExecutorProps, TaskProps } from './discover';

const panels = [{id: 'create', label: '创作'}, {id: 'play', label: '试玩'}, {id: 'review', label: '审核'}, {id: 'versions', label: '版本'}, {id: 'checks', label: '制作自检'}];
const stages: {kind: Kind; description: string}[] = [
  {kind: 'expand', description: '选定的题材、核心玩法和美术方向。'},
  {kind: 'brief', description: '制作策划与具体玩法，含操作、难度与声音。'},
  {kind: 'preview', description: '独立的竖屏样板图，用于锁定画面方向。'},
  {kind: 'assets', description: '可预览的美术资产与原样复用的绘制库。'},
  {kind: 'game', description: '可独立打开的单文件 HTML。'},
];

export function Project({id, executor, onExecutor, modern, modernError, retryModern, tasks, refreshTasks, tasksError}: TaskProps & ExecutorProps & {
  id: number; modern?: boolean; modernError: string | null; retryModern: () => void;
}) {
  const {params, navigate, notify, user} = useApp();
  const base = `${forge}/topics/${id}`;
  const summary = useResource<Topic>(`${base}?summary=1`);
  const versions = useResource<Version[]>(`${base}/versions`);
  const action = useAction();
  const saveNote = useAction();
  const [notes, setNotes] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Kind | null>(null);
  const [watchBaseline, setWatchBaseline] = useState('');
  const topic = summary.data;
  const allVersions = versions.data || [];
  const requestedPanel = params.get('panel') || '';
  const panel = panels.some(item => item.id === requestedPanel) ? requestedPanel : params.has('version') ? 'versions' : 'create';
  const selectedVersion = params.get('version') || '';
  const material = stages.some(stage => stage.kind === params.get('material')) ? params.get('material') as Kind : null;
  const current = (kind: Kind) => allVersions.find(version => version.kind === kind && (version.current ?? version.disposition === 'current'));
  const related = tasks.filter(task => taskProject(task) === id);
  const outcomes = related.filter(task => !isActive(task)).map(task => `${task.id}:${task.status}`).join(',');
  const previousOutcomes = useRef(outcomes);
  const reload = () => {summary.reload(); versions.reload();};
  useEffect(() => {
    if (outcomes === previousOutcomes.current) return;
    previousOutcomes.current = outcomes;
    reload();
  }, [outcomes]);
  useEffect(() => {
    if (!submitted) return;
    const match = latestTask(tasks, id, submitted);
    if (match && `${match.id}:${match.status}` !== watchBaseline) setSubmitted(null);
  }, [submitted, watchBaseline, tasks, id]);
  const updateUrl = (values: Record<string, string | null>, replace = true) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) if (value) next.set(key, value); else next.delete(key);
    navigate(creatorUrl(next), replace);
  };
  const selectPanel = (value: string) => updateUrl({panel: value, version: null, material: null});
  const back = () => updateUrl({project: null, panel: null, version: null, material: null, ...(params.get('tab') === 'project' ? {tab: 'picks'} : {})}, false);
  const start = (kind: Kind, regenerate: boolean) => action.run(async () => {
    if (tasksError) throw new Error('请先刷新任务状态。');
    if (notes !== null) throw new Error('请先保存或撤销编辑中的制作备注。');
    const query = new URLSearchParams({executor});
    if ((modern && kind !== 'expand') || (topic && isSeed(topic))) query.set('creative_version', '2');
    if (regenerate) query.set('regenerate', '1');
    const match = latestTask(tasks, id, kind);
    const endpoint = kind === 'expand' ? `${forge}/expand` : `${base}/${kind}`;
    try {
      const response = await api<{pending?: boolean; jobId?: string; status?: string; tasks?: {executor?: string}[]} | Topic[]>(`${endpoint}?${query}`, {method: 'POST', body: kind === 'expand' ? {ids: [id]} : {}});
      if (!Array.isArray(response) && (response.pending || response.jobId)) {
        setWatchBaseline(match ? `${match.id}:${match.status}` : '');
        setSubmitted(kind);
      }
      notify(`${stageLabels[kind]}已提交，执行方式以任务记录为准。`, 'success');
    } finally {refreshTasks(); reload();}
  });
  const patchStatus = (status: string) => action.run(async () => {
    await api(base, {method: 'PATCH', body: {status}});
    notify('项目状态已保存', 'success');
    reload();
    if (status === 'rejected') back();
  });
  if (!topic) return <section className="page creator-page">
    <div><Button variant="ghost" onClick={back}>← 返回项目列表</Button></div>
    {summary.error ? <ErrorState error={summary.error} onRetry={summary.reload}/> : <Loading label="正在读取项目"/>}
  </section>;
  const title = titleOf(topic);
  const hasDesign = Boolean(topic.data?.title);
  const seed = isSeed(topic);
  const modernProject = Boolean(modern || topic.creative_version === 2 || seed);
  const modernLocked = modern === false && topic.creative_version === 2;
  const productVersion = current('game');
  const pending = allVersions.filter(version => version.disposition === 'pending');
  return <section className="page creator-page">
    <div className="row"><Button size="sm" variant="ghost" onClick={back}>← {params.get('tab') === 'draw' ? '发现选题' : params.get('tab') === 'products' ? '游戏成品' : '我的项目'}</Button><span className="small muted">项目 #{id}</span></div>
    <PageHeader title={title} eyebrow={seed ? '选题种子' : '项目工作纸'} description={topic.data?.logline || topic.subject} actions={<ExecutorPicker value={executor} onChange={onExecutor}/>}/>
    <TopicTags topic={topic}/>
    <Tabs items={panels.map(item => item.id === 'versions' && pending.length ? {...item, count: pending.length} : item)} value={panel} onChange={selectPanel}/>
    {summary.error && <ErrorState error={summary.error} onRetry={summary.reload}/>}
    {versions.error && <ErrorState error={versions.error} onRetry={versions.reload}/>}
    {tasksError && <ErrorState error={tasksError} onRetry={refreshTasks}/>}
    {modernError && <ErrorState error={modernError} onRetry={retryModern}/>}
    {panel === 'create' && <>
      {seed ? <EmptyState title="请先选定一个机制" description="查重与登记操作在候选轮次中完成。" action={<Button onClick={() => navigate(creatorUrl({tab: 'draw'}))}>回到发现选题</Button>}/> : <>
        <div className="creator-project-columns">
          <Card className="creator-stage-card"><div className="spread row"><h2>创作材料</h2><Badge tone="neutral">{modernProject ? '完整创作指导' : '原创作流程'}</Badge></div>
            {modernLocked && <p className="small muted">当前账号的完整创作灰测已关闭。已保存的材料与版本仍可浏览。</p>}
            {stages.map(({kind, description}, index) => {
              const task = latestTask(tasks, id, kind);
              const legacy = oldStageState(topic, kind);
              const active = isActive(task) || !task && ['queued', 'running'].includes(legacy.status || '') || submitted === kind;
              const error = task?.error || (legacy.status === 'error' ? legacy.error : '');
              const ready = Boolean(hasArtifact(topic, kind));
              const v = current(kind);
              const allowed = !modernLocked && typeof modern === 'boolean' && (kind === 'expand' ? !ready : hasDesign && (
                kind === 'assets' ? Boolean(topic.has_brief) : kind === 'game' ? ['liked', 'made'].includes(topic.status) && (!modernProject || Boolean(topic.has_brief)) : true));
              const disabled = active || action.busy || Boolean(tasksError) || notes !== null;
              return <div className="creator-stage" key={kind}>
                <div className="creator-stage-head"><span className="creator-stage-number">{String(index + 1).padStart(2, '0')}</span><div><h3>{stageLabels[kind]}</h3><p className="small muted">{description}</p></div>
                  {v?.stale ? <Badge tone="warning">上游已更新</Badge> : ready ? <Badge tone="sage">已保存</Badge> : null}</div>
                {task && (active || error || task.result?.disposition === 'pending') && <TaskProgress task={task}/>}
                {!task && active && <p className="small muted" role="status">已提交，正在读取持久状态。<Button size="sm" variant="ghost" onClick={() => {refreshTasks(); reload();}}>刷新任务状态</Button></p>}
                {!task && error && <p className="small danger-text">{error}</p>}
                {task?.result?.disposition === 'pending' && <Button size="sm" variant="outline" onClick={() => updateUrl({panel: 'versions', version: task.result?.version_id || null})}>核对待采用结果</Button>}
                <div className="row">
                  {ready && <Button size="sm" variant="outline" onClick={() => kind === 'game' ? selectPanel('play') : updateUrl({material: material === kind ? null : kind})}>{kind === 'game' ? '试玩' : material === kind ? '收起材料' : '查看材料'}</Button>}
                  {allowed && (!ready || kind !== 'expand') && (ready
                    ? disabled ? <Button size="sm" variant="outline" disabled>{active ? '有任务进行中' : '生成新版本'}</Button> : <ConfirmAction title={`重新生成${stageLabels[kind]}`} variant="outline" description="提交一个新创作任务。已保存的结果仍可在版本记录查看。" onConfirm={async () => {await start(kind, true);}}>生成新版本</ConfirmAction>
                    : <Button size="sm" disabled={disabled} onClick={() => void start(kind, false)}>{error ? '明确重试' : `开始${kind === 'game' ? '制作' : stageLabels[kind]}`}</Button>)}
                </div>
                {material === kind && ready && (versions.loading && !versions.data ? <Loading label="正在读取材料版本"/> : <Artifact key={`${v?.id || kind}:${kind === 'brief' && Boolean(topic.has_assets)}`} topic={topic} kind={kind} version={v} live/>)}
              </div>;
            })}
          </Card>
          <div className="stack">
            <Card className="creator-side-card"><h2>项目备注</h2>{topic.requirements && <><p className="small muted">起始创作要求</p><p className="creator-prewrap">{topic.requirements}</p></>}
              <form className="stack" onSubmit={event => {event.preventDefault(); void saveNote.run(async () => {
                if (notes === null) return;
                const updated = await api<Topic>(base, {method: 'PATCH', body: {note: notes}});
                summary.setData({...topic, note: updated.note});
                setNotes(null); notify('制作备注已保存', 'success');
                reload();
              });}}>
                <Field label="补充制作要求" hint="保存后参与后续任务锁定。在途结果可保留为待采用版本。"><Textarea rows={5} maxLength={12000} value={notes ?? topic.note ?? ''} onChange={event => setNotes(event.target.value)}/></Field>
                <div className="row"><Button type="submit" size="sm" disabled={notes === null || saveNote.busy}>保存备注</Button>{notes !== null && <Button type="button" variant="ghost" size="sm" onClick={() => setNotes(null)}>撤销编辑</Button>}</div>
              </form>
            </Card>
            <Card className="creator-side-card"><h2>项目操作</h2>
              <div className="action-list">
                <Button variant="ghost" size="sm" onClick={() => navigate(creatorUrl({tab: 'tasks', projectFilter: id}))}>查看此项目的任务 →</Button>
                <Button variant="ghost" size="sm" onClick={() => navigate(creatorUrl({tab: 'agent'}))}>创作 Agent 接入 →</Button>
                {['liked', 'made'].includes(topic.status) ? <Button variant="outline" size="sm" disabled={action.busy} onClick={() => void patchStatus(topic.status === 'made' ? 'liked' : 'made')}>{topic.status === 'made' ? '取消已制作标记' : '标记为外部已制作'}</Button> : hasDesign && <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void patchStatus('liked')}>加入我的项目</Button>}
                <ConfirmAction title="移出项目" description="将选题归档，已保存的材料和不可变版本会保留。" variant="destructive" onConfirm={async () => {await patchStatus('rejected');}}>移出候选</ConfirmAction>
              </div>
            </Card>
          </div>
        </div>
      </>}
    </>}
    {panel === 'play' && (topic.has_product
      ? versions.loading && !versions.data ? <Loading label="正在读取成品版本"/> : <Card className="creator-play-card"><Artifact key={productVersion?.id || 'game'} topic={topic} kind="game" version={productVersion}/></Card>
      : <EmptyState title="还没有采用的游戏成品" description="可以在创作页开始制作，或者查看历史版本中等待采用的结果。" action={<Button onClick={() => selectPanel(pending.length ? 'versions' : 'create')}>{pending.length ? '查看待采用版本' : '回到创作材料'}</Button>}/>)}
    {panel === 'versions' && <VersionPanel topic={topic} versions={allVersions} loading={versions.loading} selected={selectedVersion} onSelect={version => updateUrl({version: version || null})} onChecks={() => selectPanel('checks')} onRestored={reload}/>}
    {panel === 'checks' && <ProjectChecks id={id} onVersion={version => updateUrl({panel: 'versions', version})}/>}
    {panel === 'review' && (user?.canReview ? <ProjectReviews topic={topic} versions={allVersions}/> : <EmptyState title="当前账号未开通 AI 模拟审核" description="创作材料与制作自检仍可在项目中查看。"/>)}
  </section>;
}
