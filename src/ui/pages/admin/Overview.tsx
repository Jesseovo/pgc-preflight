import { useState } from 'react';
import type { AdminDashboard, AdminRoute } from '../../../admin/contracts';
import { readRoute, routeUrl } from '../../../admin/navigation';
import { Badge, Button, Card, EmptyState, Field, PageHeader, Select, Stat, Table, Tabs } from '../../components/ui';
import { useApp } from '../../context';
import { useResource } from '../../lib/api';
import { adminPath, Cell, DataState, MemberOptions, ranges, ResponsiveTable, time, useAdminListInterval, useAdminRoute } from './shared';
import { ProjectCard, TaskTable } from './Content';

const metricLabels = { products: '新增成品', reviews: '审核完成' };
type Metric = keyof typeof metricLabels;
const groupLabels: Record<string, string> = { 'platform-queued': '平台排队', 'platform-running': '平台执行', 'agent-queued': 'Agent 待领取', 'agent-running': 'Agent 执行中' };

function chartUrl(metric: Metric, from: string, to: string, owner: string) {
  return routeUrl({ ...readRoute('view=' + (metric === 'products' ? 'works' : 'reviews')), from, to, owner, status: metric === 'products' ? 'product' : 'done', section: metric === 'products' ? 'first-products' : undefined });
}

function Trend({ data, metric, owner }: { data: AdminDashboard; metric: Metric; owner: string }) {
  const { navigate } = useApp();
  const rows = data.trend;
  const top = Math.max(1, ...rows.map(row => row[metric]));
  const x = (i: number) => 30 + i * 540 / Math.max(1, rows.length - 1);
  const y = (n: number) => 125 - n * 105 / top;
  const label = (iso: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...(data.range === 'today' ? { hour: '2-digit', hourCycle: 'h23' as const } : { month: 'numeric', day: 'numeric' }) }).format(new Date(iso));
  return <Card className="stack">
    <h3>{metricLabels[metric]}</h3>
    <p className="small muted">{metric === 'products' ? '按项目首次完成成品计款' : '按审核任务完成次数统计'} · 北京时间</p>
    {rows.length ? <><svg className="admin-chart" viewBox="0 0 600 153" role="group" aria-label={metricLabels[metric] + '趋势'}>
      <path d="M30 20V125H570" fill="none" stroke="currentColor" opacity=".3" />
      <text x="3" y="24">{top}</text><text x="9" y="130">0</text>
      <polyline points={rows.map((row, i) => x(i) + ',' + y(row[metric])).join(' ')} stroke="currentColor" strokeWidth="2" fill="none" />
      {rows.map((row, i) => <a key={row.from} href={chartUrl(metric, row.from, row.to, owner)} aria-label={label(row.from) + '，' + row[metric] + '，查看记录'} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(chartUrl(metric, row.from, row.to, owner));
      }}>
        <title>{label(row.from)} · {row[metric]}</title><circle cx={x(i)} cy={y(row[metric])} r="10" fill="transparent" /><circle cx={x(i)} cy={y(row[metric])} r="3.5" fill="currentColor" />
      </a>)}
      <text x="30" y="148">{label(rows[0].from)}</text><text x="570" y="148" textAnchor="end">{label(rows[rows.length - 1].from)}</text>
    </svg><details><summary>查看数值和记录</summary><div className="admin-scroll"><Table><thead><tr><th>时间</th><th>{metricLabels[metric]}</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.from}><td>{label(row.from)}</td><td><a className="admin-summary-link" href={chartUrl(metric, row.from, row.to, owner)}>{row[metric]} 项</a></td></tr>)}
    </tbody></Table></div></details></> : <p className="small muted">没有趋势数据。</p>}
  </Card>;
}

function DashboardCharts({ data, owner }: { data: AdminDashboard; owner: string }) {
  const { visit } = useAdminRoute();
  const [metric, setMetric] = useState<Metric>('products');
  const [expanded, setExpanded] = useState(false);
  const rows = [...data.progress].sort((a, b) => b[metric] - a[metric] || a.id.localeCompare(b.id));
  const maximum = Math.max(1, ...rows.map(row => row[metric]));
  const taskMax = Math.max(1, ...data.taskGroups.map(row => row.count));
  return <section className="stack"><h2>产出与任务进度</h2>
    <div className="grid-2"><Trend data={data} metric="products" owner={owner} /><Trend data={data} metric="reviews" owner={owner} />
      <Card className="stack"><div className="spread admin-chart-filter"><h3>成员贡献</h3><Select aria-label="贡献指标" value={metric} onChange={event => setMetric(event.target.value as Metric)}><option value="products">新增成品</option><option value="reviews">审核完成</option></Select></div>
        {(expanded ? rows : rows.slice(0, 10)).map(row => <a className="admin-bar" key={row.id} href={chartUrl(metric, data.window.from, data.window.to, row.id)}><span>{row.displayName}</span><meter min={0} max={maximum} value={row[metric]} aria-label={row.displayName} /><b>{row[metric]}</b></a>)}
        {!rows.length && <p className="small muted">暂无成员记录。</p>}
        {rows.length > 10 && <Button variant="outline" size="sm" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '显示全部成员'}</Button>}
      </Card>
      <Card className="stack"><h3>当前任务</h3><p className="small muted">按当前持久状态统计</p>{data.taskGroups.map(row => <button className="admin-bar" key={row.key} onClick={() => visit('tasks', { owner, status: row.key })}><span>{groupLabels[row.key] || row.key}</span><meter min={0} max={taskMax} value={row.count} aria-label={groupLabels[row.key]} /><b>{row.count}</b></button>)}</Card>
    </div>
  </section>;
}

export default function Overview({ route }: { route: AdminRoute }) {
  const { update, visit } = useAdminRoute();
  const range = route.range === 'all' ? '7d' : route.range;
  const resource = useResource<AdminDashboard>(adminPath('dashboard?' + new URLSearchParams({ range, owner: route.owner })), { interval: useAdminListInterval(60_000) });
  return <section className="stack">
    <PageHeader eyebrow="团队概览" title="团队总览" description="查看成员产出、当前任务与需要关注的事项。" actions={<Button variant="outline" onClick={resource.reload}>刷新</Button>} />
    <div className="spread">
      <Tabs items={ranges.slice(1).map(([id, label]) => ({ id, label }))} value={range} onChange={value => update({ range: value as AdminRoute['range'] })} />
      <Field label="成员"><Select value={route.owner} onChange={event => update({ owner: event.target.value })}><MemberOptions members={resource.data?.members} current={route.owner} /></Select></Field>
    </div>
    <DataState resource={resource}>{data => <>
      <div className="stats-grid admin-overview-stats">
        <button onClick={() => visit('members', { owner: route.owner })}><Stat label="有产出成员" value={data.metrics.productiveMembers} /></button>
        <button onClick={() => visit('works', { owner: route.owner, range, status: 'product', section: 'first-products' })}><Stat label="新增成品" value={data.metrics.newProducts} /></button>
        <button onClick={() => visit('tasks', { owner: route.owner, status: 'active' })}><Stat label="进行中任务" value={data.metrics.activeTasks} note="平台任务" /></button>
        <button onClick={() => visit('tasks', { owner: route.owner, range, status: 'error' })}><Stat label="失败任务" value={data.metrics.failedTasks} /></button>
      </div>
      <DashboardCharts data={data} owner={route.owner} />
      <Card className="stack"><div className="spread"><h2>成员进展</h2><Button variant="outline" size="sm" onClick={() => visit('members')}>管理成员</Button></div>
        {data.progress.length ? <ResponsiveTable className="admin-team-table"><thead role="rowgroup"><tr role="row"><th>成员</th><th>创作产出</th><th>审核完成</th><th>当前进展</th><th>最近活动</th></tr></thead><tbody role="rowgroup">{data.progress.map(member => <tr role="row" key={member.id}>
          <Cell wide><button className="admin-summary-link" onClick={() => visit('members', { id: member.id })}>{member.displayName}</button><small>@{member.username} {member.star ? ' · Star' : ''}{!member.enabled ? ' · 停用' : ''}</small></Cell>
          <Cell label="创作产出"><button className="admin-summary-link" onClick={() => visit('works', { owner: member.id, range })}>{member.creations} 次 · {member.products} 款成品</button></Cell>
          <Cell label="审核完成"><a className="admin-summary-link" href={chartUrl('reviews', data.window.from, data.window.to, member.id)}>{member.reviews} 次</a></Cell>
          <Cell label="当前进展" wide>{member.currentTask ? <button className="admin-summary-link" onClick={() => visit('tasks', { owner: member.id, status: member.activeTasks ? 'active' : 'waiting-agent' })}>{member.currentTask}</button> : '暂无进行中任务'}</Cell><Cell label="最近活动" wide>{time(member.lastActivity)}</Cell>
        </tr>)}</tbody></ResponsiveTable> : <EmptyState title="没有成员进展" description="可以调整日期或成员筛选。" />}
      </Card>
      <Card className="stack"><div className="spread"><h2>需要关注</h2><Button variant="outline" size="sm" onClick={() => visit('tasks', { owner: route.owner })}>全部任务</Button></div>
        <TaskTable tasks={data.attention.slice(0, 4)} empty="目前没有待处理异常" fromOverview />
        {data.waitingAgentCount > 0 && <Badge tone="blue">{data.waitingAgentCount} 个任务等待成员 Agent 回传</Badge>}
      </Card>
      <section className="stack"><div className="spread"><h2>最新成品</h2><Button variant="outline" size="sm" onClick={() => visit('works', { owner: route.owner, status: 'product' })}>全部成品</Button></div>
        {data.latestProducts.length ? <div className="grid-3">{data.latestProducts.map(project => <ProjectCard key={project.id} project={project} fromOverview />)}</div> : <EmptyState title="这段时间还没有新增成品" />}
      </section>
      <p className="small muted">更新于 {time(data.updatedAt)} · 北京时间</p>
    </>}</DataState>
  </section>;
}
