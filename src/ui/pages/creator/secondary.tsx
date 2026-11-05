import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Card, ConfirmAction, Dialog, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Select, Stat, Table, Tabs, Textarea } from '../../components/ui';
import { useApp } from '../../context';
import { api, downloadText, useAction, useResource } from '../../lib/api';
import { CopyButton, ExecutorPicker, TaskProgress } from './common';
import { creatorUrl, dimensionLabels, dims, displayDate, forge, isActive, stageLabels, storageGet, storageSet, taskProject, type Dim, type Rules, type Task, type Word } from './model';
import type { ExecutorProps, TaskProps } from './discover';

export function Preferences({userId, executor, onExecutor}: ExecutorProps & {userId: string}) {
  const {notify} = useApp();
  const source = useResource<Rules>(`${forge}/settings`);
  const key = `forge-draw-size-${userId}`;
  const [size, setSize] = useState<string | null>(() => storageGet(key, true) || null);
  const drawSize = size ?? source.data?.draw_size ?? '12';
  const action = useAction();
  return <section className="page creator-page">
    <PageHeader title="规则与偏好" eyebrow="工作台设置" description="公共规范由管理员维护。个人抽签偏好只保存在当前浏览器。"/>
    <Card className="creator-secondary-card"><h2>个人创作偏好</h2>
      <div className="creator-project-columns"><form className="stack" onSubmit={event => {
        event.preventDefault();
        const value = Number(drawSize);
        setSize(String(value)); storageSet(key, String(value), true); notify('抽签偏好已保存', 'success');
      }}><Field label="原版抽签每次数量" hint="机制候选每次保留一组种子。"><Input type="number" inputMode="numeric" min={1} max={40} step={1} required value={drawSize} onChange={event => setSize(event.target.value)}/></Field>
        <div><Button type="submit" size="sm">保存偏好</Button></div>
      </form><div className="stack"><ExecutorPicker value={executor} onChange={onExecutor}/><p className="small muted">平台游戏制作使用 Claude Opus 5.5。个人 Agent 由你选择模型和工具。</p></div></div>
    </Card>
    {source.error && <ErrorState error={source.error} onRetry={source.reload}/>}
    {source.loading && !source.data ? <Loading label="正在读取公共规则"/> : source.data && <Card className="creator-secondary-card">
      <h2>公共创作规范</h2>
      {([{label: '选题规律与雷区', value: source.data.redlines}, {label: '制作模板', value: source.data.template}, {label: '简报 F 部分骨架', value: source.data.template_f}]).map(rule => <details className="creator-disclosure" key={rule.label}><summary>{rule.label}</summary><p className="creator-prewrap">{rule.value || '暂无内容'}</p></details>)}
    </Card>}
    <div><Button variant="outline" disabled={action.busy} onClick={() => void action.run(async () => {
      const data = await api(`${forge}/export`);
      downloadText(`pgc-personal-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
    })}>导出我的数据</Button></div>
  </section>;
}

export function Vocabulary({tasks, refreshTasks, tasksError}: TaskProps) {
  const {navigate, notify} = useApp();
  const [dim, setDim] = useState<Dim>('subject');
  const [q, setQ] = useState('');
  const source = useResource<Word[]>(`${forge}/vocab`);
  const [count, setCount] = useState('30');
  const action = useAction();
  const task = tasks.find(row => row.kind === 'suggest' && row.scope?.endsWith(`:suggest:${dim}`));
  const canSuggest = dim === 'subject' || dim === 'medium';
  const words = source.data || [];
  const filtered = words.filter(word => word.dim === dim && `${word.word} ${word.note || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  return <section className="page creator-page">
    <PageHeader title="公共词库" eyebrow="灵感索引" description="公共词库由管理员维护。个人学习系数来自你自己的记录。"
      actions={<Button variant="outline" onClick={() => navigate(creatorUrl({tab: 'draw'}))}>去发现选题</Button>}/>
    <Tabs items={dims.map(id => ({id, label: dimensionLabels[id], count: words.filter(word => word.dim === id).length}))} value={dim} onChange={id => setDim(id as Dim)}/>
    <Card className="creator-secondary-card"><div className="creator-toolbar">
      <Field label="搜索词语"><Input type="search" value={q} onChange={event => setQ(event.target.value)} placeholder="词语或备注"/></Field>
      {canSuggest && <form className="row" onSubmit={event => {event.preventDefault(); void action.run(async () => {
        try {
          await api(`${forge}/suggest`, {method: 'POST', body: {dim, n: Number(count)}});
          notify('已登记词库建议任务，等待个人 Agent 接单。', 'success');
        } finally {refreshTasks();}
      });}}><Field label="建议词数量"><Input className="creator-count" type="number" min={5} max={60} value={count} onChange={event => setCount(event.target.value)} required/></Field><Button type="submit" disabled={action.busy || isActive(task) || Boolean(tasksError)}>请我的 Agent 补词</Button></form>}
    </div>
      {canSuggest && <p className="small muted">建议需要管理员审批后才会进入公共词库。</p>}
      {task && <TaskProgress task={task}/>}
      {task?.status === 'done' && task.result?.suggested != null && <p className="small muted">本次建议 · {task.result.suggested} 条</p>}
    </Card>
    {tasksError && <ErrorState error={tasksError} onRetry={refreshTasks}/>}
    {source.error && <ErrorState error={source.error} onRetry={source.reload}/>}
    {source.loading && !source.data ? <Loading label="正在读取词库"/> : filtered.length ? <Card><Table><thead><tr><th>词语</th><th>备注</th><th>公共权重</th><th>个人学习系数</th><th>状态</th></tr></thead><tbody>
      {filtered.map(word => <tr key={word.id}><td><b>{word.word}</b></td><td>{word.note || '—'}</td><td>{word.base ?? '—'}</td><td>{typeof word.factor === 'number' ? `×${word.factor.toFixed(2)}` : '—'}</td><td><Badge tone={!word.enabled ? 'neutral' : word.used ? 'warning' : 'sage'}>{!word.enabled ? '已停用' : word.used ? '题材已占用' : '可抽取'}</Badge></td></tr>)}
    </tbody></Table></Card> : !source.error && <EmptyState title="没有匹配的词语"/>}
  </section>;
}

interface Device {id: string; name: string; revoked?: boolean | number; online?: boolean; expires_at?: string; last_seen?: string}
interface AgentResponse {devices: Device[]; tasks: Task[]}
interface Pairing {code: string; expiresAt: string}
export function AgentPage() {
  const {navigate, notify} = useApp();
  const source = useResource<AgentResponse>(`${forge}/agent/devices`);
  const action = useAction();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [expired, setExpired] = useState(false);
  const prompt = `请阅读 ${location.origin}/forge-agent.md，使用你自己的模型连接我的 PGC 个人创作空间。首次连接时，请直接在本对话中向我询问一次性配对码，收到后自行完成配对。只领取我明确开始的任务并回传结果，等我决定下一步。审核 Agent 请单独阅读 ${location.origin}/agent.md。`;
  useEffect(() => {
    if (!pairing) return;
    const time = Date.parse(pairing.expiresAt) - Date.now();
    const timeout = window.setTimeout(() => {setPairing(null); setExpired(true);}, Math.max(0, Number.isFinite(time) ? time : 300000));
    return () => clearTimeout(timeout);
  }, [pairing]);
  return <section className="page creator-page">
    <PageHeader title="我的创作 Agent" eyebrow="连接个人助手" description="独立授权创作设备，由它使用自己的模型领取你明确发起的创作任务。"
      actions={<Button variant="outline" onClick={() => navigate(creatorUrl({tab: 'tasks'}))}>查看创作任务</Button>}/>
    <div className="creator-project-columns">
      <Card className="creator-secondary-card"><h2>首次接入</h2><ol><li>把接入指令交给你的智能助手。</li><li>当它向你询问时，生成一次性配对码。</li><li>在当前对话中提供配对码，由助手完成配对。</li></ol>
        <details className="creator-disclosure"><summary>查看创作 Agent 接入指令</summary><p className="creator-prewrap">{prompt}</p></details>
        <div className="row"><CopyButton value={prompt}>复制接入指令</CopyButton><a className="creator-download" href="/forge-agent.md" target="_blank" rel="noopener noreferrer">接入文档 ↗</a></div>
        <p className="small muted">配对码有效期 5 分钟。每个创作设备授权 30 天，同时最多 3 台。</p>
        <Button disabled={action.busy} onClick={() => void action.run(async () => {setPairing(await api<Pairing>(`${forge}/agent/pairing`, {method: 'POST', body: {}})); setExpired(false);})}>{pairing ? '生成新配对码' : '生成一次性配对码'}</Button>
        {pairing && <div className="creator-callout stack" role="status"><Field label="创作 Agent 配对码"><Input autoComplete="off" readOnly value={pairing.code} onFocus={event => event.currentTarget.select()}/></Field><div className="row"><CopyButton value={pairing.code}>复制配对码</CopyButton><small className="muted">有效至 {displayDate(pairing.expiresAt)}</small></div></div>}
        {expired && <p className="small muted" role="status">配对码已过期，可以重新生成。</p>}
      </Card>
      <Card className="creator-secondary-card"><div className="spread row"><h2>创作设备</h2><Button size="sm" variant="ghost" onClick={source.reload}>刷新</Button></div>
        {source.error && <ErrorState error={source.error} onRetry={source.reload}/>}
        {source.loading && !source.data ? <Loading label="正在读取设备"/> : source.data?.devices.length ? source.data.devices.map(device => <div className="creator-device" key={device.id}>
          <div><b>{device.name}</b><p className="small muted">最近连接 {displayDate(device.last_seen)}<br/>有效至 {displayDate(device.expires_at)}</p></div>
          <Badge tone={device.online ? 'sage' : 'neutral'}>{device.revoked ? '已撤销' : device.online ? '最近连接' : device.expires_at && Date.parse(device.expires_at) <= Date.now() ? '已过期' : '已授权'}</Badge>
          {!device.revoked && <ConfirmAction title="撤销创作设备" description="撤销后此设备的创作授权立即失效。" variant="destructive" onConfirm={async () => {
            await api(`${forge}/agent/revoke`, {method: 'POST', body: {id: device.id}}); source.reload(); notify('创作设备已撤销', 'success');
          }}>撤销授权</ConfirmAction>}
        </div>) : !source.error && <EmptyState title="尚未授权创作设备"/>}
      </Card>
    </div>
  </section>;
}

export function TaskCenter({tasks, refreshTasks, tasksError, loading}: TaskProps & {loading: boolean}) {
  const {params, navigate} = useApp();
  const historicalAgent = useResource<AgentResponse>(`${forge}/agent/devices`);
  const focusedId = params.get('task') || '';
  const focused = useResource<Task>(focusedId && !tasks.some(row => row.id === focusedId) ? `${forge}/generation-jobs/${encodeURIComponent(focusedId)}` : null);
  const [lookup, setLookup] = useState(focusedId);
  const filter = ['queued','running','done','error'].includes(params.get('status') || '') ? params.get('status')! : '';
  const executor = ['platform','agent'].includes(params.get('executor') || '') ? params.get('executor')! : '';
  const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
  const projectFilter = Number(params.get('projectFilter')) || 0;
  const combined = new Map((historicalAgent.data?.tasks || []).map(task => [task.id, task]));
  tasks.forEach(task => combined.set(task.id, task));
  if (focused.data?.id === focusedId) combined.set(focusedId, focused.data);
  const all = [...combined.values()].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || (b.created_at || '').localeCompare(a.created_at || ''));
  const matches = all.filter(row => (!projectFilter || taskProject(row) === projectFilter) && (!focusedId || row.id === focusedId) && (!filter || row.status === filter) && (!executor || row.executor === executor));
  const pages=Math.max(1,Math.ceil(matches.length/20)),current=Math.min(page,pages);
  useEffect(()=>setLookup(focusedId),[focusedId]);
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.delete('page');
    navigate(creatorUrl(next), true);
  };
  return <section className="page creator-page">
    <PageHeader title="创作任务" eyebrow="进度与回传" description="按任务查看实际执行方式、阶段、错误与结果。已知的旧任务可按编号读取。"
      actions={<Button variant="outline" onClick={() => {refreshTasks(); historicalAgent.reload(); if (focusedId) focused.reload();}}>刷新任务</Button>}/>
    <div className="stats-grid creator-task-stats"><Stat label="等待平台或 Agent" value={tasks.filter(task => task.status === 'queued').length}/><Stat label="执行或等待回传" value={tasks.filter(task => task.status === 'running').length}/><Stat label="最近未完成" value={tasks.filter(task => task.status === 'error').length}/></div>
    <Card className="creator-secondary-card creator-task-filter"><div className="creator-toolbar">
      <form className="row creator-task-search" onSubmit={event => {event.preventDefault(); update('task', lookup.trim());}}><Field label="任务编号"><Input type="search" placeholder="输入任务编号" value={lookup} onChange={event => setLookup(event.target.value)}/></Field><Button type="submit" variant="outline">查找</Button></form>
      <Field label="状态"><Select value={filter} onChange={event => update('status',event.target.value)}><option value="">全部状态</option><option value="queued">等待</option><option value="running">执行或回传</option><option value="done">已完成</option><option value="error">未完成</option></Select></Field>
      <Field label="执行方式"><Select value={executor} onChange={event => update('executor',event.target.value)}><option value="">全部方式</option><option value="platform">平台</option><option value="agent">个人 Agent</option></Select></Field>
    </div>
      {(projectFilter > 0 || focusedId) && <div className="row">{projectFilter > 0 && <Button size="sm" variant="ghost" onClick={() => update('projectFilter', '')}>清除项目 #{projectFilter} 筛选 ×</Button>}{focusedId && <Button size="sm" variant="ghost" onClick={() => {setLookup(''); update('task', '');}}>返回任务列表 ×</Button>}</div>}
    </Card>
    {tasksError && <ErrorState error={tasksError} onRetry={refreshTasks}/>}
    {historicalAgent.error && <ErrorState error={historicalAgent.error} onRetry={historicalAgent.reload}/>}
    {focused.error && focusedId && <ErrorState error={focused.error} onRetry={focused.reload}/>}
    {(loading || focused.loading) && !matches.length ? <Loading label="正在读取任务"/> : matches.length ? <div className="creator-task-list">{matches.slice((current-1)*20,current*20).map(task => {
      const id = taskProject(task);
      return <Card key={task.id} className="creator-task-row"><div><h3>{stageLabels[task.kind] || task.kind}</h3><p className="small muted"><code>{task.id}</code></p><p className="small muted">创建于 {displayDate(task.created_at)}</p></div><TaskProgress task={task}/>
        <div className="row">{id > 0 && <Button size="sm" variant="outline" onClick={() => navigate(creatorUrl({tab: 'picks', project: id, ...(task.result?.version_id ? {panel: 'versions', version: task.result.version_id} : {})}))}>{task.result?.version_id ? '查看结果版本' : '打开项目'}</Button>}</div>
      </Card>;
    })}</div> : !tasksError && !focused.error && <EmptyState title="没有匹配的任务" description="创作任务提交后会显示在这里。"/>}
    {pages>1&&<nav className="row creator-pager" aria-label="创作任务分页"><Button size="sm" variant="outline" disabled={current<=1} onClick={()=>update('page',String(current-1))}>上一页</Button><span className="small muted">第 {current} / {pages} 页 · {matches.length} 个任务</span><Button size="sm" variant="outline" disabled={current>=pages} onClick={()=>update('page',String(current+1))}>下一页</Button></nav>}
  </section>;
}

type Game = Partial<Record<Dim, string>> & {id: number; ext_id?: string; title: string; descr?: string; source?: string; status?: string; feedback?: string; score?: number | null; aes?: number | null; ease?: number | null; play?: number | null; revisions?: number};
const historyStatus: Record<string, string> = {approved: '已通过', preapproved: '组长已通过', pending: '待审核', rejected: '需修改', dropped: '自己删掉', shelved: '做了没交', local: '本地'};
const exportSnippet = `(async()=>{const read=async u=>{const r=await fetch(u);if(!r.ok)throw Error('读取失败 '+r.status);return r.json();};const works=[];const seen=new Set();const scores=x=>x?JSON.parse(x).map(k=>k.score).join('/'):null;for(const q of ['','&status=deleted']){for(let p=1;p<30;p++){const page=await read('/api/works?page='+p+q);for(const w of page.works||[]){if(seen.has(w.id))continue;seen.add(w.id);const d=await read('/api/works/'+encodeURIComponent(w.id));works.push({id:w.id,title:w.title,desc:w.description,status:w.status,deleted:w.deleted,source:'mine',versions:(d.versions||[]).map(v=>({r:v.revision,s:scores(v.scores),ps:scores(v.pre_scores),fb:v.feedback,pfb:v.pre_feedback}))});}if(!page.pagination||p>=page.pagination.totalPages)break;}}const out=JSON.stringify({works});try{copy(out);console.log('已复制 '+works.length+' 款作品');}catch(e){console.log(out);}})();`;

export function GamesPage({userId, tasks, refreshTasks, tasksError}: TaskProps & {userId: string}) {
  const {notify} = useApp();
  const source = useResource<Game[]>(`${forge}/games`);
  const vocab = useResource<Word[]>(`${forge}/vocab`);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [origin, setOrigin] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Game | null | undefined>();
  const tag = useAction();
  const exportAction = useAction();
  const all = source.data || [];
  const untagged = all.filter(game => !game.gesture || !game.medium).length;
  const matches = all.filter(game => (!status || game.status === status) && (!origin || game.source === origin) && [game.title, game.descr, game.feedback, ...dims.map(dim => game[dim])].join(' ').toLowerCase().includes(q.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(matches.length / 24));
  const currentPage = Math.min(page, pages);
  const task = tasks.find(task => task.kind === 'tag');
  const lastTagged = task?.status === 'done' ? task.id : '';
  useEffect(() => {if (lastTagged) source.reload();}, [lastTagged, source.reload]);
  return <section className="page creator-page creator-history">
    <PageHeader title="历史作品" eyebrow="个人档案" description="整理过去的作品和标签。导入的是个人历史资料。"
      actions={<Button onClick={() => setEditing(null)}>手动添加作品</Button>}/>
    <ImportHistory userId={userId} onSaved={source.reload}/>
    <Card className="creator-secondary-card creator-history-filter">
      <div className="creator-toolbar">
        <Field label="搜索作品"><Input type="search" value={q} onChange={event => {setQ(event.target.value); setPage(1);}} placeholder="标题、意见或标签"/></Field>
        <Field label="状态"><Select value={status} onChange={event => {setStatus(event.target.value); setPage(1);}}><option value="">全部状态</option>{Object.entries(historyStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
        <Field label="来源"><Select value={origin} onChange={event => {setOrigin(event.target.value); setPage(1);}}><option value="">全部来源</option><option value="mine">我的</option><option value="peer">他人历史参考</option></Select></Field>
      </div>
      <div className="row"><Button variant="outline" size="sm" disabled={exportAction.busy} onClick={() => void exportAction.run(async () => {
        const data = await api<{games: Game[]}>(`${forge}/export`);
        downloadText(`pgc-games-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data.games, null, 2), 'application/json');
      })}>导出历史作品 JSON</Button><Button variant="outline" size="sm" disabled={tag.busy || !untagged || isActive(task) || Boolean(tasksError)} onClick={() => void tag.run(async () => {
        try {await api(`${forge}/tag`, {method: 'POST', body: {}}); notify('已提交个人作品标签任务', 'success');} finally {refreshTasks();}
      })}>请我的 Agent 打标签 · {untagged} 个待打</Button></div>
      {task && <TaskProgress task={task}/>}
    </Card>
    {tasksError && <ErrorState error={tasksError} onRetry={refreshTasks}/>}
    {source.error && <ErrorState error={source.error} onRetry={source.reload}/>}
    {source.loading && !source.data ? <Loading label="正在读取历史作品"/> : matches.length ? <Card className="creator-history-results"><Table><thead><tr><th>作品</th><th>状态</th><th>历史分数</th><th>标签</th><th>历史意见</th><th>操作</th></tr></thead><tbody>
      {matches.slice((currentPage - 1) * 24, currentPage * 24).map(game => <tr key={game.id}><td data-label="作品"><b>{game.title}</b>{game.descr && <p className="small muted">{game.descr}</p>}</td><td data-label="状态"><Badge tone="neutral">{historyStatus[game.status || ''] || game.status || '未记录'}</Badge>{game.revisions && game.revisions > 1 ? <p className="small muted">{game.revisions} 版</p> : null}</td>
        <td data-label="历史分数">{game.score ?? '—'}<p className="small muted">{[game.aes, game.ease, game.play].map(value => value ?? '—').join('/')}</p></td><td data-label="标签">{dims.map(dim => game[dim]).filter(Boolean).join(' · ') || '—'}</td><td data-label="历史意见" className="creator-history-feedback">{game.feedback || '—'}</td><td data-label="操作"><Button variant="ghost" size="sm" onClick={() => setEditing(game)}>编辑</Button></td></tr>)}
    </tbody></Table></Card> : !source.error && <EmptyState title="没有匹配的历史作品"/>}
    {pages > 1 && <div className="row creator-pager"><Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</Button><span className="small muted">{currentPage} / {pages} 页</span><Button variant="outline" size="sm" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
    {editing !== undefined && <GameEditor key={editing?.id || 'new'} game={editing} vocab={vocab.data || []} close={() => setEditing(undefined)} onSaved={source.reload}/>}
  </section>;
}

function GameEditor({game, vocab, close, onSaved}: {game: Game | null; vocab: Word[]; close: () => void; onSaved: () => void}) {
  const {notify} = useApp();
  const action = useAction();
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const [aes, ease, play] = ['aes', 'ease', 'play'].map(key => values[key] === '' ? null : Number(values[key]));
    const score = aes === null || ease === null || play === null ? null : aes + ease + play;
    void action.run(async () => {
      if (!String(values.title).trim()) throw new Error('请填写作品标题。');
      await api(`${forge}/games${game ? `/${game.id}` : ''}`, {method: game ? 'PATCH' : 'POST', body: {...values, aes, ease, play, score}});
      onSaved(); close(); notify('历史作品已保存', 'success');
    });
  };
  return <Dialog open onOpenChange={open => {if (!open && !action.busy) close();}} title={game ? '编辑历史作品' : '添加历史作品'} wide>
    <form className="stack" onSubmit={save}>
      <div className="grid-2"><Field label="作品标题"><Input name="title" defaultValue={game?.title} required maxLength={200}/></Field><Field label="作品状态"><Select name="status" defaultValue={game?.status || 'shelved'}>{Object.entries(historyStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field></div>
      <Field label="一句话介绍"><Input name="descr" defaultValue={game?.descr} maxLength={300}/></Field>
      <div className="grid-2">{dims.map(dim => <Field label={dimensionLabels[dim]} key={dim}><Input name={dim} list={`creator-history-${dim}`} defaultValue={game?.[dim]}/></Field>)}<Field label="来源"><Select name="source" defaultValue={game?.source || 'mine'}><option value="mine">我的</option><option value="peer">他人历史参考</option></Select></Field></div>
      {dims.map(dim => <datalist key={dim} id={`creator-history-${dim}`}>{vocab.filter(word => word.dim === dim && word.enabled).map(word => <option key={word.id} value={word.word}/>)}</datalist>)}
      <div className="grid-3">{(['aes', 'ease', 'play'] as const).map((key, index) => <Field key={key} label={['美学', '易玩性', '可玩性'][index]}><Input type="number" name={key} min={0} max={3} step="any" defaultValue={game?.[key] ?? ''}/></Field>)}</div>
      <Field label="历史审核意见"><Textarea rows={4} name="feedback" maxLength={1200} defaultValue={game?.feedback}/></Field>
      <div className="row"><Button type="submit" disabled={action.busy}>保存作品</Button><Button variant="ghost" onClick={close}>取消</Button>
        {game && <ConfirmAction title="删除历史作品" description="将此个人历史记录从作品库删除。" variant="destructive" onConfirm={async () => {
          await api(`${forge}/games/${game.id}`, {method: 'DELETE'}); onSaved(); close(); notify('历史作品已删除', 'success');
        }}>删除</ConfirmAction>}</div>
    </form>
  </Dialog>;
}

type SheetModule = typeof import('../../../../public/forge/review-sheet.js');
function ImportHistory({userId, onSaved}: {userId: string; onSaved: () => void}) {
  const {notify} = useApp();
  const [json, setJson] = useState('');
  const [sheet, setSheet] = useState<{module: SheetModule; rows: Awaited<ReturnType<SheetModule['readXlsxRows']>>; members: string[]; works: number} | null>(null);
  const memberKey = `forge-sheet-self-${userId}`;
  const [self, setSelf] = useState(() => storageGet(memberKey, true) || '');
  const action = useAction();
  const load = useAction();
  const importWorks = async (data: {works: unknown[]}) => {
    const result = await api<{inserted: number; updated: number; untagged: number}>(`${forge}/import`, {method: 'POST', body: data});
    notify(`新增 ${result.inserted} · 更新 ${result.updated} · ${result.untagged} 个待打标签`, 'success');
    onSaved();
  };
  return <Card className="creator-secondary-card creator-import-card">
    <details className="creator-disclosure"><summary>导入 Creator Hub 作品 JSON</summary><p className="small muted">粘贴自己的作品历史 JSON，或在已登录的 Creator Hub 页面运行只读导出脚本。已有作品保留个人标签。</p>
      <div><CopyButton value={exportSnippet}>复制 Creator Hub 导出脚本</CopyButton></div>
      <form className="stack" onSubmit={event => {event.preventDefault(); void action.run(async () => {
        let value: {works?: unknown[]};
        try {value = JSON.parse(json);} catch {throw new Error('请检查 JSON 格式。');}
        if (!Array.isArray(value?.works)) throw new Error('JSON 中需要 works 数组。');
        await importWorks({works: value.works}); setJson('');
      });}}><Field label="作品 JSON"><Textarea rows={5} value={json} onChange={event => setJson(event.target.value)} placeholder={'{"works": […]}'}/></Field>
        <div><Button type="submit" size="sm" disabled={action.busy || !json.trim()}>导入作品记录</Button></div></form>
    </details>
    <details className="creator-disclosure"><summary>导入版本审核记录表格（.xlsx）</summary>
      <p className="small muted">在浏览器读取「版本审核记录」。选择自己的姓名后，姓名只用于本地标记作品来源。</p>
      <Field label="历史表格"><Input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={load.busy} onChange={event => {
        const file = event.currentTarget.files?.[0];
        if (!file) return;
        setSheet(null);
        void load.run(async () => {
          const url = new URL('/forge/review-sheet.js', location.origin).href;
          const module: SheetModule = await import(/* @vite-ignore */ url);
          const rows = await module.readXlsxRows(await file.arrayBuffer());
          const members = module.listMembers(rows);
          setSheet({module, rows, members, works: module.sheetToWorks(rows).length});
        });
      }}/></Field>
      {load.error && <ErrorState error={load.error}/>}
      {sheet && <form className="row creator-import-actions" onSubmit={event => {event.preventDefault(); void action.run(async () => {
        await importWorks({works: sheet.module.sheetToWorks(sheet.rows, {self})});
        storageSet(memberKey, self, true); setSheet(null);
      });}}>
        <Field label="哪一位是你"><Select value={sheet.members.includes(self) ? self : ''} onChange={event => setSelf(event.target.value)}><option value="">全部保存为历史参考</option>{sheet.members.map(name => <option key={name}>{name}</option>)}</Select></Field>
        <Button size="sm" type="submit" disabled={action.busy || !sheet.works}>导入 {sheet.works} 款</Button>
      </form>}
    </details>
    {action.error && <ErrorState error={action.error}/>}
  </Card>;
}
