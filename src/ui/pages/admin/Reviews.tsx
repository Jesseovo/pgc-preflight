import { useRef, useState, type FormEvent } from 'react';
import type { AdminRoute } from '../../../admin/contracts';
import { reviewTaskStatus } from '../../../review-task-status';
import { reviewReportErrors } from '../../../../server/review-report';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select } from '../../components/ui';
import { api, downloadText, useAction, useResource } from '../../lib/api';
import { ReportView, reportText } from '../review/ReportView';
import { adminPath, Cell, DataState, day, Options, Pager, post, ResponsiveTable, segment, Status, StatusText, time, useAdminListInterval, useAdminRoute } from './shared';

type HumanReview = { phase?: string; status?: string; decision?: string; score?: number | null };
type ReviewRow = Parameters<typeof reviewTaskStatus>[0] & {
  id: string; title: string; filename: string; score: number | null; result_id: number | null;
  created_at: string; display_name?: string; username?: string; human_review?: HumanReview; quota_charged: number;
};
type ReviewSummary = { id: string; username: string; display_name: string; daily_review_limit: number | null; completed: number; active: number; failed: number; used: number };
type ReviewPage = { records: ReviewRow[]; members: ReviewSummary[]; total: number; page: number; pageSize: number };
const scopes = [['all', '全部审核'], ['members', '成员审核'], ['admin', '管理员账号审核 / 导入']] as const;
const reportPath = (id: number | string) => '/api/forge/reviews/' + segment(id);

function HumanScore({ human }: { human?: HumanReview }) {
  if (!human) return <span className="muted">未关联</span>;
  const phase = human.phase === 'preliminary' ? '组长预审' : human.phase === 'final' ? '真人终审' : '真人审核';
  return <>{human.status === 'reviewed' ? <strong>{human.score == null ? '未提供分数' : human.score + ' / 9'}</strong> : <span className="muted">{human.status === 'pending' ? '暂未审核' : human.status === 'unavailable' ? '查询暂不可用' : '未关联'}</span>}
    <small>{phase}{human.decision === 'approved' ? ' · 通过' : human.decision === 'rejected' ? ' · 未通过' : ''}</small></>;
}

export default function Reviews({ route }: { route: AdminRoute }) {
  const { update, visit, inspect } = useAdminRoute();
  const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(route.section || '') ? route.section! : day();
  const scope = scopes.some(([value]) => value === route.type) ? route.type : 'all';
  const params = new URLSearchParams({ date: selectedDay, scope, member: route.owner, page: String(route.page), status: route.status });
  if (route.from && route.to) { params.set('from', route.from); params.set('to', route.to); }
  return <ReviewActivity key={params.toString()} path={adminPath('review-activity?' + params)} route={route} selectedDay={selectedDay} scope={scope} update={update} visit={visit} inspect={inspect} />;
}

function ReviewActivity({ path, route, selectedDay, scope, update, visit, inspect }: {
  path: string; route: AdminRoute; selectedDay: string; scope: string;
  update: ReturnType<typeof useAdminRoute>['update']; visit: ReturnType<typeof useAdminRoute>['visit']; inspect: ReturnType<typeof useAdminRoute>['inspect'];
}) {
  const [interval, setInterval] = useState(60_000);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const resource = useResource<ReviewPage>(path, { interval: useAdminListInterval(interval) });
  const action = useAction();
  if (resource.data) {
    const next = resource.data.records.some(row => row.model_executor === 'platform' && ['queued', 'running'].includes(row.status)) ? 10_000 : 60_000;
    if (next !== interval) setInterval(next);
  }

  function exportBatch() {
    void action.run(async () => {
      const reports: string[] = [];
      for (const id of selected) reports.push(reportText(await api(reportPath(id))));
      downloadText('PGC-审核报告-' + selectedDay + '.md', reports.join('\n\n---\n\n'), 'text/markdown;charset=utf-8');
    });
  }

  return <section className="stack">
    <PageHeader eyebrow="模拟审核" title="审核记录" description="按北京时间查询审核记录。AI 模拟评分与真人审核分别显示。" actions={<div className="row"><Button variant="outline" onClick={resource.reload}>刷新记录</Button><Button onClick={() => visit('settings', { section: 'upload' })}>上传或导入</Button></div>} />
    <Card className="stack"><div className="toolbar">
      <Field label="审核日期 · 北京时间"><Input type="date" value={selectedDay} onChange={event => { if (event.target.value) update({ section: event.target.value, from: undefined, to: undefined, page: 1 }); }} /></Field>
      <Field label="记录范围"><Select value={scope} onChange={event => update({ type: event.target.value, owner: '', page: 1 })}><Options items={scopes} /></Select></Field>
      <Field label="成员"><Select value={route.owner} onChange={event => update({ owner: event.target.value, page: 1 })}>
        <option value="">全部成员</option>{route.owner && !resource.data?.members.some(member => member.id === route.owner) && <option value={route.owner}>指定成员</option>}
        {resource.data?.members.map(member => <option key={member.id} value={member.id}>{member.display_name} · @{member.username}</option>)}
      </Select></Field>
      <Field label="审核状态"><Select value={route.status === 'done' ? 'done' : 'all'} onChange={event => update({ status: event.target.value, page: 1 })}><option value="all">全部状态</option><option value="done">已完成</option></Select></Field>
      <Field label="搜索本页"><Input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="标题、文件名或成员" /></Field>
    </div>
    {route.from && route.to && <div className="row small muted"><span>完成时间 {time(route.from)} 至 {time(route.to)}（不含结束时刻）</span><Button variant="ghost" size="sm" onClick={() => update({ from: undefined, to: undefined, status: 'all', page: 1 })}>清除时间范围</Button></div>}
    </Card>
    <DataState resource={resource} label="正在读取审核记录…">{data => {
      const visible = data.records.filter(row => [row.title, row.filename, row.username, row.display_name, row.id].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
      return <>
        <Card><details><summary>按成员查看统计</summary><div className="stack admin-scroll">
          {data.members.filter(member => !route.owner || member.id === route.owner).map(member => <button key={member.id} className="admin-summary-link" onClick={() => update({ owner: member.id, page: 1 })}>{member.display_name} · {member.completed} 完成 · {member.active} 进行中 · {member.failed} 未完成 <small className="muted">{member.daily_review_limit === null ? '管理员不占成员额度' : route.from ? '范围内平台调用 ' + member.used + ' 次' : '平台 ' + member.used + ' / ' + member.daily_review_limit + ' 次'}</small></button>)}
        </div></details></Card>
        <div className="spread"><div className="row"><Badge tone="sage">{data.records.filter(row => row.status === 'done').length} 本页完成</Badge><Badge tone="blue">{data.records.filter(row => ['queued', 'running'].includes(row.status)).length} 本页进行中</Badge></div>
          <Button variant="outline" disabled={!selected.length || action.busy} onClick={exportBatch}>导出所选报告{selected.length ? '（' + selected.length + '）' : ''}</Button></div>
        <StatusText {...action} label="正在读取所选报告…" />
        <Card>{visible.length ? <ResponsiveTable className="admin-review-table"><thead role="rowgroup"><tr role="row"><th>选择</th><th>时间 / 成员</th><th>游戏 / 来源</th><th>审核状态</th><th>AI 模拟评分</th><th>真人审核</th><th>平台次数</th></tr></thead><tbody role="rowgroup">{visible.map(row => {
          const state = reviewTaskStatus(row), id = row.result_id;
          const open = () => id != null ? inspect({ kind: 'report', id: String(id) }) : inspect({ kind: 'task', id: row.id, type: 'review' });
          return <tr role="row" key={row.id}><Cell wide>{id != null && <label className="admin-row-select"><input type="checkbox" aria-label={'选择 ' + row.title} checked={selected.includes(id)} onChange={event => setSelected(values => event.target.checked ? [...values, id] : values.filter(value => value !== id))} /><span className="admin-mobile-label" aria-hidden="true">选择报告</span></label>}</Cell>
            <Cell label="时间 / 成员">{time(row.created_at)}<small className="muted">{row.display_name || row.username || '已删除成员'}</small></Cell>
            <Cell wide><button className="admin-summary-link" onClick={open}>{row.title}</button><small className="muted">{row.filename || '未记录文件名'} · {row.model_executor === 'agent' ? '成员 Agent' : row.model_executor === 'platform' ? '平台模型' : row.model_executor === 'manual-admin' ? '管理员手动导入' : '来源未知'}</small></Cell>
            <Cell label="审核状态" wide><Status value={row.status}>{state.label}</Status>{state.detail && <small className="admin-clamp muted">{state.detail}</small>}</Cell>
            <Cell label="AI 模拟评分">{id != null ? <button className="admin-summary-link" onClick={open}>{row.score == null ? '待复核' : row.score + ' / 9'}</button> : '—'}</Cell>
            <Cell label="真人审核"><HumanScore human={row.human_review} /></Cell><Cell label="平台次数">{row.quota_charged ? '1 次' : '不占平台额度'}</Cell>
          </tr>;
        })}</tbody></ResponsiveTable> : <EmptyState title="暂无符合条件的审核记录" />}</Card>
        <Pager {...data} onPage={page => update({ page })} />
      </>;
    }}</DataState>
  </section>;
}

export function AdminReport({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const resource = useResource<any>(reportPath(id));
  const { update, visit } = useAdminRoute();
  return <section className="stack">
    {!embedded && <Button variant="ghost" onClick={() => update({ id: undefined })}>← 返回审核记录</Button>}
    <DataState resource={resource} label="正在读取审核报告…">{data => {
      const jobId = data.job?.id || data.report?.job_id || data.job_id;
      return <><ReportView report={data} embedded={embedded} />{jobId && <div className="row"><Button variant="outline" onClick={() => visit('feedback', { id: jobId })}>查看准确投稿反馈</Button></div>}</>;
    }}</DataState>
  </section>;
}

function UploadForm({ kind, members }: { kind: 'html' | 'report'; members?: { id: string; displayName: string; username: string }[] }) {
  const { notify, visit } = useAdminRoute();
  const action = useAction();
  const requestIds = useRef<string[]>([]);
  const [progress, setProgress] = useState('');
  const [results, setResults] = useState<{ name: string; id?: string; error?: string }[]>([]);
  const html = kind === 'html';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const files = fields.getAll('file').filter((file): file is File => file instanceof File);
    const title = String(fields.get('title') || '').trim();
    void action.run(async () => {
      setResults([]);
      const rows: typeof results = [];
      for (const [index, file] of files.entries()) {
        setProgress('正在处理第 ' + (index + 1) + ' / ' + files.length + ' 份文件');
        try {
          if (!file.size || file.size > (html ? 8 : 12) * 1024 * 1024) throw new Error(html ? '文件为空或超过 8 MB。' : '文件为空或超过 12 MB。');
          if (!(html ? /\.html?$/i : /\.json$/i).test(file.name)) throw new Error(html ? '请选择 .html 或 .htm 文件。' : '请选择 .json 报告。');
          const raw = await file.text();
          const request_id = requestIds.current[index] ||= crypto.randomUUID();
          if (html) {
            if (!/<(?:!doctype\s+html|html|head|body|canvas|script|div)\b/i.test(raw)) throw new Error('文件中没有可识别的 HTML 内容。');
            const inferredTitle = raw.match(/<title\s*>([^<]{1,120})<\/title\s*>/i)?.[1].trim();
            const result = await post<{ id?: string; job_id?: string }>('review-upload', { html: raw, title: (files.length === 1 && title) || inferredTitle || file.name, filename: file.name, request_id });
            const id = result.id || result.job_id;
            if (!id) throw new Error('未收到任务编号，请重试同一份文件。');
            rows.push({ name: file.name, id: String(id) });
          } else {
            let report;
            try { report = JSON.parse(raw); } catch { throw new Error('文件不是合法 JSON。'); }
            if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('报告需要为 JSON 对象。');
            const result = report.result || report;
            const errors = reviewReportErrors(result, { schemaVersion: result.schema_version === 2 ? 2 : 1 });
            if (errors.length) throw new Error('报告字段不完整：' + errors.join('、'));
            if (report.shots !== undefined && !Array.isArray(report.shots)) throw new Error('画面证据 shots 必须为数组。');
            const imported = await post<{ id: number }>('review-import', { title: title || report.title || file.name, filename: report.filename || file.name, request_id, result, probe: report.probe, shots: report.shots || [], owner_id: fields.get('owner'), rules_snapshot: report.rules_snapshot });
            rows.push({ name: file.name, id: String(imported.id) });
          }
        } catch (error) {
          rows.push({ name: file.name, error: error instanceof Error ? error.message : '未能完成提交。' });
        }
        setResults([...rows]);
      }
      setProgress('');
      if (rows.length && rows.every(row => !row.error)) {
        form.reset();
        requestIds.current = [];
        notify(html ? '平台审核任务已提交。' : '报告已标记为管理员手动导入。', 'success');
      }
    });
  }

  return <Card className="stack"><h2>{html ? '上传 HTML 并审核' : '导入已有审核报告'}</h2><form className="stack admin-upload-form" onSubmit={submit} onChange={() => { requestIds.current = []; setResults([]); }}>
    <fieldset disabled={action.busy} className="stack">
      <Field label={html ? 'HTML 游戏文件' : '报告 JSON'} hint={html ? '每款游戏为一个 HTML 文件，单份最大 8 MB。' : '最多 12 MB。v2 报告需附真实已发布规则快照。'}><Input type="file" name="file" accept={html ? '.html,.htm,text/html' : '.json,application/json'} multiple={html} required /></Field>
      <Field label="标题（可选）" hint={html ? '批量上传时采用各游戏的原始标题。' : undefined}><Input name="title" maxLength={120} /></Field>
      {!html && <Field label="归属成员"><Select name="owner"><option value="admin">管理员</option>{members?.map(member => <option key={member.id} value={member.id}>{member.displayName} · @{member.username}</option>)}</Select></Field>}
      <Button type="submit">{html ? '明确提交平台模型审核' : '校验并导入'}</Button>
    </fieldset>
    <StatusText {...action} label={progress || '正在校验文件…'} />
  </form>
  {results.length > 0 && <ul className="stack">{results.map((result, index) => <li className="spread" key={index}><span>{result.name}</span>{result.error ? <span className="danger-text" role="alert">{result.error}</span> : <Button variant="outline" size="sm" onClick={() => html ? visit('tasks', { type: 'review', id: result.id }) : visit('reviews', { id: result.id })}>{html ? '查看审核任务' : '查看导入报告'}</Button>}</li>)}</ul>}
  </Card>;
}

export function Uploads() {
  const members = useResource<{ members: { id: string; displayName: string; username: string }[] }>(adminPath('members'));
  const { visit } = useAdminRoute();
  return <section className="stack">
    <Card className="admin-upload-intro"><p>提交 HTML 会调用平台模型。管理员手动导入的报告会单独标记来源。</p><Button variant="outline" size="sm" onClick={() => visit('tasks', { type: 'review' })}>打开审核任务</Button></Card>
    <div className="grid-2"><UploadForm kind="html" /><DataState resource={members}>{data => <UploadForm kind="report" members={data.members} />}</DataState></div>
  </section>;
}
