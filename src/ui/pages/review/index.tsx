import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ClipboardCheck, Copy, Download, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, ConfirmAction, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Progress, Select, Stat, Table, Tabs } from '../../components/ui';
import { useApp } from '../../context';
import { elapsed } from '../../../progress';
import { api, copyText, downloadText, useAction, useResource } from '../../lib/api';
import { ReportView, ReviewFields, ReviewOutcome, HumanReviewSummary } from './ReportView';
import { ReviewDevices, activeDevices, type DeviceStatus } from './ReviewDevices';
import { activelyWorking, agentWaiting, endedJob, jobPath, resumePrompt, runningJob, stageLabel, useReviewJobs, type ReviewJob } from './jobs';
import { humanScore, humanTitle, reportOrigin, reportState, reportText, reportTotal, reviewDate, type ReviewReport } from './report-data';
import './review.css';

const reportPath = (id?: number | string | null) => id ? `/api/forge/reviews/${encodeURIComponent(id)}` : null;
const jobTone = (job: ReviewJob, disconnected: boolean) => job.status === 'done' ? 'sage' :
  job.status === 'error' || disconnected ? 'danger' : activelyWorking(job) ? 'blue' : 'warning';

function JobProgress({ job, disconnected }: { job: ReviewJob; disconnected: boolean }) {
  const working = !disconnected && activelyWorking(job);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!working) return;
    const tick = () => { if (!document.hidden) setNow(Date.now()); };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [working, job.id]);
  const started = Date.parse(job.created_at || '');
  if (!working) return null;
  return <Progress label={stageLabel(job)} detail={Number.isFinite(started) ? `提交后 ${elapsed(started, now)}` : undefined}/>;
}

function JobDetail({ job, disconnected, onRemove }: { job: ReviewJob; disconnected: boolean; onRemove: () => Promise<void> }) {
  const reportId = job.status === 'done' ? job.result_id : null;
  const report = useResource<ReviewReport>(reportPath(reportId));
  const waiting = agentWaiting(job);
  const status = stageLabel(job, disconnected);
  const capture = job.stage === 'capture';
  return <Card className="review-job-detail stack">
    <div className="spread"><div><p className="review-eyebrow">审核任务</p><h2>{job.title || '未命名游戏'}</h2></div>
      <Badge tone={jobTone(job, disconnected && !endedJob(job))}>{status}</Badge></div>
    <ReviewFields items={[
      ['任务编号', job.id], ['文件名', job.filename], ['提交日期', reviewDate(job.created_at)],
      [endedJob(job) ? '结束日期' : '最近活动', reviewDate(job.updated_at)],
      ['执行来源', job.model_executor === 'agent' ? '成员本机 Agent' : job.model_executor === 'platform' ? '平台模型' : job.model_executor === 'manual-admin' ? '管理员导入' : '未记录'],
      ['审核模式', job.review_mode === 'enhanced' ? '增强试玩' : job.review_mode === 'basic' ? '基础采集' : null], ['模型', job.model],
    ]}/>
    {job.status === 'error' && <div className="review-job-message error" role="status"><strong>{job.error || '本次审核未完成。'}</strong><p>此任务未发布评分。若要重新审核，请在你的 Agent 对话中提供原 HTML，明确发起新任务。</p></div>}
    {disconnected && !endedJob(job) && <div className="review-job-message error" role="status">暂时无法读取任务状态，连接恢复后将继续查询原任务。</div>}
    {waiting && <div className="review-job-message stack">
      <p>{capture ? '请在原 Agent 对话中领取或继续采集。' : '平台尚未收到该阶段的结果，请在原 Agent 对话中继续审核。'}</p>
      <div><Button size="sm" onClick={() => void copyText(resumePrompt(job))}><Copy size={14}/>复制继续审核指令</Button></div>
      <details className="review-disclosure"><summary>查看完整继续指令</summary><pre>{resumePrompt(job)}</pre></details>
    </div>}
    {!disconnected && job.status === 'queued' && !waiting && <p className="muted">后台已记录任务，等待采集。</p>}
    <JobProgress job={job} disconnected={disconnected}/>
    {!reportId && job.human_review && <HumanReviewSummary human={job.human_review}/>}
    {reportId && (report.error ? <ErrorState error={report.error} onRetry={report.reload}/> :
      report.data && String(report.data.id) === String(reportId) ? <ReportView report={{ report: report.data, job }} embedded/> :
      <Loading label="正在读取审核报告"/>)}
    {job.status === 'done' && !reportId && <p className="muted">此任务没有关联的报告编号。</p>}
    {endedJob(job) && <div className="review-job-actions">
      <ConfirmAction title="移除审核任务" description="从任务列表移除这项已结束任务，已发布报告仍可在审核记录中查看。" variant="destructive" onConfirm={onRemove}>移除任务</ConfirmAction>
    </div>}
  </Card>;
}

function HistoryTable({ reports, onSelect, onRemove }: { reports: ReviewReport[]; onSelect: (id: number) => void; onRemove: (id: number) => Promise<void> }) {
  if (!reports.length) return null;
  return <Table className="review-history-table" aria-label="审核记录">
    <thead><tr><th>游戏</th><th>AI 模拟审核</th><th>真人审核</th><th>日期</th><th><span className="sr-only">操作</span></th></tr></thead>
    <tbody>{reports.map(report => {
      const total = reportTotal(report);
      const human = report.human_review;
      return <tr key={report.id}>
        <td><button className="link-button review-title-button" type="button" onClick={() => onSelect(report.id)}>{report.title || '未命名游戏'}</button><small className="muted">{reportOrigin(report)}</small></td>
        <td data-label="AI 模拟审核"><div className="row">{total !== null && <strong>{total} / 9</strong>}<ReviewOutcome report={report}/></div></td>
        <td data-label="真人审核">{human?.status === 'reviewed' ? <><span>{humanTitle(human)}</span><small className="muted">{humanScore(human)}</small></> : <span className="muted">暂无结果</span>}</td>
        <td data-label="日期">{reviewDate(report.created_at)}</td>
        <td><span className="review-record-remove"><ConfirmAction title="移除审核记录" description="从个人审核记录中移除这份报告。管理员仍可查看原始记录。" variant="destructive" onConfirm={() => onRemove(report.id)}>移除记录</ConfirmAction></span></td>
      </tr>;
    })}</tbody>
  </Table>;
}

function ReviewWorkspace() {
  const { pathname, params, navigate, notify } = useApp();
  const tabKey = pathname.startsWith('/forge') ? 'reviewTab' : 'tab';
  const tabParam = params.get(tabKey) || params.get('reviewTab');
  const explicitTab = tabParam && ['tasks', 'history', 'devices'].includes(tabParam) ? tabParam : null;
  const reportParam = params.get('report') || params.get('reportId');
  const reportId = reportParam && /^[1-9]\d*$/.test(reportParam) ? reportParam : null;
  const selectedId = params.get('task') || params.get('job');
  const history = useResource<ReviewReport[]>('/api/forge/reviews');
  const observer = useReviewJobs(history.reload, true);
  const devices = useResource<DeviceStatus>('/api/forge/review/worker-status', { interval: 60_000 });
  const [query, setQuery] = useState(params.get('reviewQ') || '');
  const [filter, setFilter] = useState(params.get('reviewResult') || 'all');
  const remove = useAction();
  const exporting = useAction();
  const jobs = observer.jobs || [];
  const hasDevice = activeDevices(devices.data).length > 0;
  const tab = reportId ? 'history' : selectedId ? 'tasks' : explicitTab || (devices.data && !hasDevice && !jobs.length && !history.data?.length ? 'devices' : 'tasks');
  const selected = jobs.find(job => job.id === selectedId);
  const missing = !!selectedId && !!observer.jobs && !selected;
  const focusedJob = useResource<ReviewJob>(missing ? jobPath(selectedId) : null);
  const job = selected || (focusedJob.data?.id === selectedId ? focusedJob.data : undefined);
  const focusedReport = useResource<ReviewReport>(reportPath(reportId));
  const report = String(focusedReport.data?.id) === reportId ? focusedReport.data : undefined;
  const historyItems = (history.data || []).filter(item =>
    (item.title || '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (filter === 'all' || reportState(item) === filter));
  const completed = jobs.filter(item => item.status === 'done');
  const failed = jobs.filter(item => item.status === 'error');
  const ended = jobs.filter(endedJob);
  const watching = jobs.filter(runningJob);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const storedQuery = params.get('reviewQ');
  const storedFilter = params.get('reviewResult');
  useEffect(() => { setQuery(storedQuery || ''); }, [storedQuery]);
  useEffect(() => { setFilter(storedFilter || 'all'); }, [storedFilter]);
  const setRoute = (patch: Record<string, string | null>, replace = false) => {
    const search = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) search.set(key, value); else search.delete(key);
    }
    const text = search.toString();
    navigate(pathname + (text ? '?' + text : ''), replace);
  };
  const historyFilters = { reviewQ: query || null, reviewResult: filter === 'all' ? null : filter };
  const switchTab = (next: string) => {
    if (next === tab && !selectedId && !reportId) return;
    setFocusTarget(null);
    setRoute({ ...historyFilters, [tabKey]: next, task: null, job: null, report: null, reportId: null });
  };
  useEffect(() => {
    if (!focusTarget) return;
    let targetId: string;
    if (focusTarget === 'task-list' && tab === 'tasks' && !selectedId) targetId = 'review-task-panel';
    else if (focusTarget === 'history-list' && tab === 'history' && !reportId) targetId = 'review-history-panel';
    else if (focusTarget === `task:${selectedId}` || focusTarget === `report:${reportId}`) targetId = 'review-detail-focus';
    else return;
    let focusFrame = 0;
    const layoutFrame = requestAnimationFrame(() => {
      focusFrame = requestAnimationFrame(() => {
        const focus = document.getElementById(targetId);
        focus?.focus({ preventScroll: true });
        if (window.matchMedia('(max-width: 800px)').matches) focus?.scrollIntoView({ block: 'start' });
        setFocusTarget(null);
      });
    });
    return () => { cancelAnimationFrame(layoutFrame); cancelAnimationFrame(focusFrame); };
  }, [selectedId, reportId, focusTarget, tab]);
  const chooseTask = (id: string) => {
    setFocusTarget(`task:${id}`);
    setRoute({ task: id, job: null, report: null, reportId: null, [tabKey]: 'tasks' });
  };
  const chooseReport = (id: number) => {
    setFocusTarget(`report:${id}`);
    setRoute({ ...historyFilters, report: String(id), reportId: null, [tabKey]: 'history', task: null, job: null });
  };
  const removeJobs = async (items: ReviewJob[]) => {
    await remove.run(async () => {
      const results = await Promise.allSettled(items.map(item => api(jobPath(item.id), { method: 'DELETE' })));
      const removed = new Set(items.filter((_, index) => results[index].status === 'fulfilled').map(item => item.id));
      observer.setJobs(current => current?.filter(item => !removed.has(item.id)));
      if (selectedId && removed.has(selectedId)) setRoute({ task: null, job: null }, true);
      observer.refresh();
      if (removed.size) notify(`已移除 ${removed.size} 项审核任务。`, 'success');
      if (removed.size !== items.length) {
        const failure = results.find(result => result.status === 'rejected');
        throw new Error(failure?.status === 'rejected' && items.length === 1 ? (failure.reason as Error).message : `${items.length - removed.size} 项任务移除失败，请重试。`);
      }
    });
  };
  const removeReport = async (id: number) => {
    await remove.run(async () => {
      await api(reportPath(id)!, { method: 'DELETE' });
      history.setData(items => items?.filter(item => item.id !== id));
      observer.setJobs(items => items?.filter(item => item.result_id !== id));
      history.reload();
      observer.refresh();
      if (String(id) === reportId) setRoute({ report: null, reportId: null }, true);
      notify('已从个人审核记录移除。', 'success');
    });
  };
  const exportReports = (ids: number[]) => void exporting.run(async () => {
    const idsToRead = [...new Set(ids)];
    const reports: string[] = [];
    for (let start = 0; start < idsToRead.length; start += 4) {
      const results = await Promise.allSettled(idsToRead.slice(start, start + 4).map(id => api<ReviewReport>(reportPath(id)!)));
      for (const result of results) if (result.status === 'fulfilled' && result.value?.result) reports.push(reportText(result.value));
    }
    if (!reports.length) throw new Error('没有可导出的报告，请刷新后重试。');
    downloadText(`reviews-${new Date().toISOString().slice(0, 10)}.md`, reports.join('\n\n---\n\n'), 'text/markdown;charset=utf-8');
    notify(`已导出 ${reports.length} 份报告。`, 'success');
    if (reports.length !== idsToRead.length) throw new Error(`${idsToRead.length - reports.length} 份报告未能读取。`);
  });
  const updateHistoryFilter = (value: string) => {
    setFilter(value);
    setRoute({ ...historyFilters, reviewResult: value === 'all' ? null : value }, true);
  };

  const taskFocused = tab === 'tasks' && !!selectedId;
  return <div className={`page review-page stack${taskFocused ? ' review-focused-task' : ''}`}>
    <PageHeader eyebrow="PGC PREFLIGHT / REVIEW" title="我的审核"/>
    <Tabs items={[{ id: 'tasks', label: '审核任务', count: observer.jobs?.length }, { id: 'history', label: '审核记录', count: history.data?.length }, { id: 'devices', label: '接入与设备' }]} value={tab} onChange={switchTab}/>
    {tab === 'devices' && <section aria-label="接入与设备"><ReviewDevices data={devices.data} loading={devices.loading} error={devices.error} reload={devices.reload}/></section>}
    {tab === 'tasks' && <section id="review-task-panel" className="stack" aria-label="审核任务" tabIndex={-1}>
      <div className="review-summary">
        <Stat label="等待与执行" value={observer.jobs ? watching.length : '—'}/>
        <Stat label="近期已完成" value={observer.jobs ? completed.length : '—'}/>
        <Stat label="近期未完成" value={observer.jobs ? failed.length : '—'}/>
        <Stat label="审核设备" value={devices.data ? `${activeDevices(devices.data).length} / 3` : '—'} note={devices.data?.online ? '最近已连接' : undefined}/>
      </div>
      <div className="row review-view-actions review-task-actions" role="group" aria-label="任务操作">
        <Button size="sm" variant="outline" onClick={observer.refresh}><RefreshCw size={14}/>刷新任务</Button>
        <Button size="sm" variant="outline" disabled={!completed.some(item => item.result_id) || exporting.busy} onClick={() => exportReports(completed.flatMap(item => item.result_id ? [item.result_id] : []))}><Download size={14}/>{exporting.busy ? '导出中…' : '导出报告'}</Button>
        {!!ended.length && <ConfirmAction title="清除已结束任务" description={`从任务列表移除 ${ended.length} 项已结束任务。审核记录保留。`} variant="destructive" onConfirm={() => removeJobs(ended)}>清除已结束</ConfirmAction>}
      </div>
      {taskFocused && <div className="review-task-back"><Button variant="ghost" onClick={() => { setFocusTarget('task-list'); setRoute({ task: null, job: null }, true); }}><ArrowLeft size={16}/>返回任务列表</Button></div>}
      {observer.error && <ErrorState error={`暂时无法读取任务状态。 ${observer.error}`} onRetry={observer.refresh}/>}
      {!observer.jobs && !observer.error && <Loading label="正在读取审核任务"/>}
      {observer.jobs && !jobs.length && !selectedId && <EmptyState title="暂无审核任务" description="将本地 HTML 交给你的 Agent，任务会在提交后显示。"
        action={<Button onClick={() => switchTab('devices')}>查看接入与设备<ArrowRight size={15}/></Button>}/>}
      {(jobs.length > 0 || selectedId) && <div className="review-task-layout">
        <div className="review-task-list stack">
          {!!jobs.length && <Progress label="报告完成数" value={completed.length} total={jobs.length} status={watching.length ? 'waiting' : failed.length ? 'error' : 'done'}/>}
          {jobs.map(item => <button className="review-task-button" key={item.id} type="button" aria-pressed={job?.id === item.id} onClick={() => chooseTask(item.id)}>
            <ClipboardCheck size={16}/><span><strong>{item.title || '未命名游戏'}</strong><small>{item.filename || reviewDate(item.created_at)}</small></span>
            <Badge tone={jobTone(item, !!observer.error && !endedJob(item))}>{stageLabel(item, !!observer.error)}</Badge>
          </button>)}
        </div>
        <div className="review-detail-focus" id="review-detail-focus" tabIndex={-1}>
          {job ? <JobDetail key={job.id} job={job} disconnected={!!observer.error} onRemove={() => removeJobs([job])}/> :
            focusedJob.error ? <ErrorState error={focusedJob.error} onRetry={focusedJob.reload}/> : selectedId ? <Loading label="正在读取任务详情"/> : <EmptyState title="选择审核任务" description="点击一项任务可查看阶段、继续指令或报告。"/>}
        </div>
      </div>}
    </section>}
    {tab === 'history' && <section id="review-history-panel" className="stack" aria-label="审核记录" tabIndex={-1}>
      {reportId ? <>
        <div><Button variant="ghost" onClick={() => { setFocusTarget('history-list'); setRoute({ report: null, reportId: null }); }}><ArrowLeft size={16}/>返回审核记录</Button></div>
        <div className="review-detail-focus" id="review-detail-focus" tabIndex={-1}>
          {focusedReport.error ? <ErrorState error={focusedReport.error} onRetry={focusedReport.reload}/> : report ?
            <Card><ReportView key={report.id} report={report}/></Card> : <Loading label="正在读取审核报告"/>}
        </div>
      </> : <>
        <div className="toolbar review-history-tools">
          <Field label="搜索记录"><Input type="search" placeholder="搜索游戏名称" value={query} onChange={event => setQuery(event.target.value)} onBlur={() => { if ((params.get('reviewQ') || '') !== query) setRoute({ reviewQ: query || null }, true); }}/></Field>
          <Field label="审核结果"><Select value={filter} onChange={event => updateHistoryFilter(event.target.value)}>
            <option value="all">全部结果</option><option value="pass">模拟通过</option><option value="revise">建议修改</option><option value="review">待复核</option>
          </Select></Field>
          <p className="muted small">{historyItems.length} / {history.data?.length || 0} 份报告</p>
          <div className="row review-view-actions" role="group" aria-label="记录操作">
            <Button variant="outline" size="sm" onClick={history.reload} disabled={history.loading}><RefreshCw size={14}/>刷新记录</Button>
            <Button variant="outline" size="sm" onClick={() => exportReports(historyItems.map(item => item.id))} disabled={!historyItems.length || exporting.busy}><Download size={14}/>{exporting.busy ? '导出中…' : '导出筛选结果'}</Button>
          </div>
        </div>
        {history.error && <ErrorState error={history.error} onRetry={history.reload}/>}
        {history.loading && !history.data && <Loading label="正在读取审核记录"/>}
        {history.data && !historyItems.length && <EmptyState title={history.data.length ? '没有符合条件的报告' : '暂无审核记录'} description={history.data.length ? '试试其他游戏名称或审核结果。' : 'Agent 回传完成的报告会显示在这里。'}/>}
        <HistoryTable reports={historyItems} onSelect={chooseReport} onRemove={removeReport}/>
      </>}
    </section>}
    {remove.error && <p className="danger-text" role="alert">{remove.error}</p>}
    {exporting.error && <p className="danger-text" role="alert">{exporting.error}</p>}
  </div>;
}

export default function ReviewApp() {
  const { user, navigate } = useApp();
  if (!user.canReview && user.role !== 'admin') return <div className="page"><PageHeader title="我的审核"/>
    <EmptyState title="当前账号暂无审核权限" action={<Button onClick={() => navigate('/square')}>打开游戏广场</Button>}/></div>;
  return <ReviewWorkspace/>;
}
