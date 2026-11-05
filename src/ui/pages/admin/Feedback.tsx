import { useRef, useState, type FormEvent } from 'react';
import type { FeedbackAssessmentSummary } from '../../../../server/creator-feedback-assessment';
import type { AdminRoute } from '../../../admin/contracts';
import { Badge, Button, Card, EmptyState, Field, Input, JsonDetails, PageHeader, Select, Table, Textarea } from '../../components/ui';
import { api, downloadText, useAction, useResource } from '../../lib/api';
import { adminPath, Cell, DataState, Facts, Options, post, ResponsiveTable, segment, StatusText, time, useAdminRoute } from './shared';

const base = 'creator-feedback';
const path = (suffix: string) => adminPath(base + suffix);
function protectedResource<T>(resource: ReturnType<typeof useResource<T>>) {
  return resource.error ? { ...resource, data: undefined } : resource;
}
const label = (value: unknown) => value == null ? '未知' : value === '' ? '（原文为空）' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const decision = (value: unknown) => value === 'approved' ? '通过' : value === 'rejected' ? '退回' : value === 'preapproved' ? '预审通过' : '尚无有效结论';
const statuses = [['unverified', '待核验'], ['declared', '管理员已声明'], ['excluded', '已排除']] as const;
const verification = (value?: string | null) => statuses.find(([key]) => key === value)?.[1] || '待核验';
const executor = (value?: string | null) => value === 'platform' ? '管理员平台' : value === 'agent' ? '成员 Agent' : value === 'manual-admin' ? '管理员手动导入' : '执行来源未知';
const gates: Record<string, string> = { configuration_unknown: '配置未记录', incomplete_telemetry: '计时不完整', incomplete_window: '窗口不完整', insufficient_sample: '样本不足', pending: '仍有任务执行', passed: '达到耗时目标', not_met: '尚未达到' };
const syncLabels: Record<string, string> = { ready: '已就绪', syncing: '同步中', backoff: '等待重试', auth_revoked: '授权已撤销', disabled: '未启用' };
const decisionReasons: Record<string, string> = {
  version_missing: '准确版本不存在', game_deleted: '来源作品已删除', version_withdrawn: '此投稿版本已撤回',
  no_binary_version_status: '此版本尚无明确通过或退回状态', no_deciding_review_reference: '缺少有效审核记录引用',
  multiple_effective_decisions: '存在多条有效审核，需人工核对', deciding_review_reference_missing_or_duplicate: '审核引用缺失或重复',
  review_version_mismatch: '审核与投稿版本不匹配', not_deciding_review: '该记录不是审核决定', decision_not_effective: '审核已失效、撤销或重开',
  no_binary_review_decision: '审核未明确通过或退回', version_decision_conflict: '版本状态与审核结论冲突',
};
type SyncStatus = { enabled: boolean; configured: boolean; status: string; phase: string; complete: boolean; scopeRevision?: number; lastSuccessAt?: number; lastAttemptAt?: number; nextRunAt?: number; errorCode?: string; failures?: number };
type Link = { jobId: string; title: string; ownerName: string; workId: string; versionId: string; verificationStatus: string; measuredFiles: number; artifactVersionId?: string };
type Links = { items: Link[]; nextAfter: string | null };
type MetricRow = { executor: string; mode: string; model?: string; effort?: string; configHash?: string; started: number; completed: number; failed: number; unresolved: number; onTimeRate?: number | null; completedOnly?: { p50Ms?: number; p95Ms?: number }; gate: string };
type Metrics = { accuracy?: { status?: string }; latency?: MetricRow[]; timingCoverage?: unknown; stages?: unknown; transport?: unknown; interpretation?: unknown };
type SourceReview = { id: string; revision: number; stage: string; decision?: string; total: unknown; feedback: unknown; scores?: { name: string; score: unknown; max: unknown }[]; deleted?: boolean; revoked?: boolean; reopened?: boolean; effective?: boolean };
type FeedbackJob = {
  jobId: string; title: string; workId: string; versionId: string; complete: boolean; generation: number; inputHash?: string; matchedBy: string;
  version?: { ruleVersion?: unknown }; reviewHistory: unknown; aiRules: unknown; reviews: SourceReview[];
  ai?: { decision?: string; model?: string; executor?: string; score?: number | null; dimensions?: Record<string, number | null>; report?: AiReport };
  creation?: { artifactVersionId: string; uploadHash: string; recordedAt: string };
  platform?: { decision?: string; reviewerRole?: string; reviewId?: string; reasons?: string[] };
  comparison?: { state?: string; decidingReviewRevision?: number; totals?: { ai?: number | null; platform?: number | null }; scoreDifferences?: { name: string; ai: number | null; platform: number | null; platformMax?: number | null; delta: number | null }[] };
  assessment?: FeedbackAssessmentSummary;
};
type AiReport = {
  verdict?: string; reviewer_comment?: string; score_reasons?: Record<string, string>; issues?: { kind?: string; severity?: string; area?: string; problem?: string; evidence?: string; evidence_refs?: string[]; fix?: string }[];
  optional_suggestions?: unknown[]; uncertainties?: unknown[]; strengths?: unknown[]; fix_prompt?: string;
};
const dimLabels = [['aes', '美学'], ['ease', '易玩性'], ['play', '可玩性']] as const;

function MetricsCard({ resource }: { resource: ReturnType<typeof useResource<Metrics>> }) {
  const elapsed = (ms?: number) => typeof ms === 'number' && Number.isFinite(ms) ? (ms / 1000).toFixed(1) + ' 秒' : '未测';
  return <Card className="stack"><h2>质量与时长目标</h2>
    <p className="small muted">有效结论一致率目标 ≥80%。常规 3 分钟、复杂 5 分钟为时长目标；完成样本的时长只覆盖已完成任务。</p>
    <DataState resource={resource}>{data => <>
      <Badge tone="warning">{!data.accuracy || data.accuracy.status === 'not_measured' ? '一致率未测 · 未验收' : '一致率尚未验收'}</Badge>
      {data.latency?.length ? <ResponsiveTable className="admin-metrics-table"><thead role="rowgroup"><tr role="row"><th>执行路径 / 模式</th><th>已开始 / 完成 / 失败 / 未结束</th><th>按时率</th><th>P50 / P95（仅完成）</th><th>验收</th></tr></thead><tbody role="rowgroup">{data.latency.map((row, index) => <tr role="row" key={index}>
        <Cell wide>{executor(row.executor)} / {row.mode === 'basic' ? '基础' : row.mode === 'enhanced' ? '增强' : row.mode}<small className="muted">{row.model || '模型未知'}</small>
          <details><summary>配置摘要</summary><p>思考强度 {label(row.effort)}</p><p>配置标识 <code>{row.configHash || '未记录'}</code></p>{row.executor === 'agent' && <p className="small muted">成员模型参数为设备声明。服务端起止墙钟单独记录。</p>}</details></Cell>
        <Cell label="已开始 / 完成 / 失败 / 未结束" wide>{row.started} / {row.completed} / {row.failed} / {row.unresolved}</Cell><Cell label="按时率">{typeof row.onTimeRate === 'number' ? (row.onTimeRate * 100).toFixed(1) + '%' : '未测'}</Cell>
        <Cell label="P50 / P95（仅完成）">{elapsed(row.completedOnly?.p50Ms)} / {elapsed(row.completedOnly?.p95Ms)}</Cell><Cell label="验收">{gates[row.gate] || '未验收'}</Cell>
      </tr>)}</tbody></ResponsiveTable> : <p className="small muted">尚无可展示的计时数据。</p>}
      <JsonDetails label="计时覆盖、阶段与传输记录" value={{ timingCoverage: data.timingCoverage, stages: data.stages, transport: data.transport, interpretation: data.interpretation }} />
    </>}</DataState>
  </Card>;
}

function SourceCache() {
  const [resourceType, setResourceType] = useState(''), [cursor, setCursor] = useState(''), [id, setId] = useState('');
  const gameList = useResource<{ games: { game_id: string; last_sequence: number }[]; nextAfter?: string | null; complete: boolean }>(resourceType === 'games' ? path('/games?' + new URLSearchParams({ limit: '20', after: cursor })) : null);
  const game = useResource<{ game: { id: string; title?: string; versions?: unknown[] }; reviewHistory: unknown; complete: boolean }>(resourceType === 'games' && id ? path('/game?id=' + segment(id)) : null);
  const data = useResource<unknown>(resourceType === 'rules' || resourceType === 'contract' ? path('/' + resourceType) : null);
  return <Card className="stack"><h2>授权来源缓存</h2><p className="small muted">读取当前缓存。候选规则仍需在平台设置中导入、核对和明确发布。</p>
    <div className="row">
      <Button variant={resourceType === 'games' ? 'secondary' : 'outline'} size="sm" onClick={() => setResourceType('games')}>授权作品</Button>
      <Button variant={resourceType === 'rules' ? 'secondary' : 'outline'} size="sm" onClick={() => setResourceType('rules')}>候选规则</Button>
      <Button variant={resourceType === 'contract' ? 'secondary' : 'outline'} size="sm" onClick={() => setResourceType('contract')}>来源契约</Button>
    </div>
    {resourceType === 'games' && <><form className="toolbar" onSubmit={event => { event.preventDefault(); setId(String(new FormData(event.currentTarget).get('work') || '').trim()); }}><Field label="按作品编号读取"><Input name="work" required placeholder="game_…" /></Field><Button type="submit" size="sm" variant="outline">读取准确作品</Button></form>
      <DataState resource={protectedResource(gameList)}>{result => <>{result.games.length ? <Table><thead><tr><th>授权作品编号</th><th>最新序号</th></tr></thead><tbody>{result.games.map(item => <tr key={item.game_id}><td><button className="admin-summary-link" onClick={() => setId(item.game_id)}>{item.game_id}</button></td><td>{item.last_sequence}</td></tr>)}</tbody></Table> : <EmptyState title="缓存暂无可读取的作品" />}
        <div className="row"><Button variant="outline" size="sm" disabled={!cursor} onClick={() => setCursor('')}>第一页</Button><Button variant="outline" size="sm" disabled={!result.nextAfter} onClick={() => setCursor(result.nextAfter || '')}>下一页</Button></div>
      </>}</DataState>
      {id && <DataState resource={protectedResource(game)} label="正在读取来源作品…">{result => <section className="stack"><h3>{result.game.title || result.game.id || id}</h3><JsonDetails value={result.game} label="来源作品与准确版本" /><JsonDetails value={result.reviewHistory} label="来源审核修订历史" /></section>}</DataState>}
    </>}
    {(resourceType === 'rules' || resourceType === 'contract') && <DataState resource={protectedResource(data)}>{result => <JsonDetails label={resourceType === 'rules' ? '查看候选规则原文' : '查看来源契约'} value={result} />}</DataState>}
  </Card>;
}

function LinkForm({ enabled, jobId, onLinked }: { enabled: boolean; jobId?: string; onLinked: (id: string) => void }) {
  const action = useAction();
  const { notify } = useAdminRoute();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    void action.run(async () => {
      const data = await post<{ jobId: string }>(base + '/link', fields);
      notify('准确投稿关联已保存。', 'success');
      onLinked(data.jobId);
    });
  };
  return <Card className="stack"><details open={!jobId}><summary>建立准确版本关联</summary><form className="stack" onSubmit={submit}>
    <fieldset disabled={!enabled || action.busy} className="stack"><div className="grid-2">
      <Field label="已有 AI 任务编号"><Input name="jobId" defaultValue={jobId} maxLength={200} required /></Field>
      <Field label="来源作品编号"><Input name="workId" maxLength={200} required /></Field>
      <Field label="准确投稿版本编号"><Input name="versionId" maxLength={200} required /></Field>
      <Field label="编号依据"><Select name="matchedBy"><option value="published-record">已有投稿记录</option><option value="user-confirmed">用户明确确认</option></Select></Field>
    </div><p className="small muted">用于未绑定成品版本的原审核任务。关联固定后不可换绑，文件一致性与作品归属另行核验。</p>
    <Button type="submit">验证并关联</Button></fieldset>
    <StatusText {...action} label="正在核对准确投稿版本…" />
  </form></details></Card>;
}

function TextList({ title, rows }: { title: string; rows?: unknown[] }) {
  return <section><h4>{title}</h4>{Array.isArray(rows) ? rows.length ? <ul>{rows.map((row, index) => <li className="admin-prose" key={index}>{label(row)}</li>)}</ul> : <p className="small muted">原报告未列出。</p> : <p className="small muted">未知。</p>}</section>;
}

function AIReport({ ai }: { ai: FeedbackJob['ai'] }) {
  const report = ai?.report;
  return <article className="stack"><h3>AI 原报告</h3>
    {ai ? <><div className="row"><Badge tone="blue">{decision(ai.decision)}</Badge><span>{ai.model || '模型未知'} · {executor(ai.executor)}</span></div>
      <p>总分 {label(ai.score)} · {dimLabels.map(([id, title]) => title + ' ' + label(ai.dimensions?.[id])).join(' / ')}</p>
      {report && <><section><h4>原结论与审核意见</h4><p className="admin-prose">{label(report.verdict)}</p><p className="admin-prose">{label(report.reviewer_comment)}</p></section>
        <section><h4>三维评分理由</h4><Facts items={dimLabels.map(([id, title]) => [title, label(report.score_reasons?.[id])])} /></section>
        <section className="stack"><h4>问题与修改</h4>
          {report.issues?.length ? report.issues.map((issue, index) => <details key={index} className="admin-divider"><summary>{issue.kind === 'confirmed' ? '已确认问题' : issue.kind === 'experience' ? '体验评价' : issue.kind === 'unverified' ? '待验证' : '原报告问题'} · {label(issue.area)} · {label(issue.severity)}</summary>
            <p className="admin-prose">{label(issue.problem)}</p><Facts items={[[ '证据', label(issue.evidence) ], [ '原始引用', issue.evidence_refs?.join('、') || '未记录' ], [ issue.kind === 'unverified' ? '验证方法' : '修改或建议', label(issue.fix) ]]} /></details>) : <p className="small muted">原报告未列出问题。</p>}
        </section>
        <TextList title="可选建议" rows={report.optional_suggestions} /><TextList title="待验证事项" rows={report.uncertainties} />
        <details><summary>优点与完整修改指令</summary><TextList title="优点" rows={report.strengths} /><p className="admin-prose">{label(report.fix_prompt)}</p></details>
        <JsonDetails label="原始 AI 报告 JSON" value={report} />
      </>}
    </> : <p className="small muted">尚无 AI 报告。</p>}
  </article>;
}

function SourceReviewCard({ review, selected }: { review: SourceReview; selected: boolean }) {
  const states = [review.deleted && '已删除', review.revoked && '已撤销', review.reopened && '已重开'].filter(Boolean).join('、') || (review.effective ? '当前有效' : '历史记录 · 当前无效');
  const stage = review.stage === 'decision_review' ? '审核决定' : review.stage === 'pre_review' ? '初审意见' : label(review.stage);
  return <details className="admin-divider" open={selected || undefined}><summary>{stage} · {decision(review.decision)} · 修订 {review.revision} · {states}</summary>
    <div className="stack"><p>总分 {label(review.total)}</p><p>{review.scores?.map(row => row.name + ' ' + label(row.score) + ' / ' + label(row.max)).join(' · ') || '原分数数组为空'}</p>
      <h4>审核意见原文</h4><p className="admin-prose">{label(review.feedback)}</p><JsonDetails label="原始审核字段" value={review} /></div>
  </details>;
}

function Assessment({ detail, onUpdated }: { detail: FeedbackJob; onUpdated: (assessment: FeedbackAssessmentSummary) => void }) {
  const action = useAction();
  const { notify } = useAdminRoute();
  const pending = useRef<{ fingerprint: string; requestId: string } | undefined>(undefined);
  const fileRequest = useRef<string | undefined>(undefined);
  const assessment = detail.assessment;
  const saved = assessment?.latestDeclaration?.declaration;
  const context = { jobId: detail.jobId, generation: detail.generation };

  function declaration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const payload = { ...fields, sourceArtifactHash: fields.sourceArtifactHash || null, sourceRuleId: fields.sourceRuleId || null, pgcRuleId: fields.pgcRuleId || null, ...context };
    const fingerprint = JSON.stringify(payload);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, requestId: crypto.randomUUID() };
    const requestId = pending.current.requestId;
    void action.run(async () => {
      const data = await post<{ assessment: FeedbackAssessmentSummary }>(base + '/assessment', { ...payload, requestId });
      pending.current = undefined;
      onUpdated(data.assessment);
      notify('核验声明已追加。', 'success');
    });
  }

  function measure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get('file');
    void action.run(async () => {
      if (!(file instanceof File) || file.size < 1 || file.size > 8 * 1024 * 1024) throw new Error('请选择 1 字节至 8 MB 的本地文件。');
      const requestId = fileRequest.current ||= crypto.randomUUID();
      const params = new URLSearchParams({ jobId: detail.jobId, generation: String(detail.generation), requestId });
      const data = await api<{ assessment: FeedbackAssessmentSummary }>(path('/file-evidence?' + params), { method: 'POST', body: file.slice(0, file.size, 'application/octet-stream') });
      fileRequest.current = undefined;
      form.reset();
      onUpdated(data.assessment);
      notify('实际文件摘要已保存。', 'success');
    });
  }

  return <Card className="stack"><h2>核验资料与缺口</h2><p>PGC 原输入 SHA-256 <code>{detail.inputHash || '未知'}</code></p>
    <ul>{assessment?.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
    <p className="small muted">声明记录管理员依据，文件测量记录实际字节。来源投稿的文件绑定仍需独立证据。</p>
    <form className="stack" onSubmit={declaration} key={assessment?.latestDeclaration?.id || 'initial'}>
      <fieldset disabled={action.busy} className="stack"><div className="grid-2">
        <Field label="声明状态"><Select name="status" defaultValue={saved?.status || 'unverified'}><Options items={statuses} /></Select></Field>
        <Field label="文件关系"><Select name="fileRelation" defaultValue={saved?.fileRelation || 'unknown'}><Options items={[[ 'unknown', '未知' ], [ 'same-bytes', '声明原样字节' ], [ 'transformed', '声明转换产物' ]]} /></Select></Field>
        <Field label="来源产物 SHA-256（声明）"><Input name="sourceArtifactHash" defaultValue={saved?.sourceArtifactHash ?? ''} pattern="[a-f0-9]{64}" maxLength={64} /></Field>
        <Field label="规则关系"><Select name="ruleRelation" defaultValue={saved?.ruleRelation || 'unknown'}><Options items={[[ 'unknown', '未知' ], [ 'admin-inspected', '管理员已核对' ]]} /></Select></Field>
        <Field label="来源规则编号"><Input name="sourceRuleId" defaultValue={saved?.sourceRuleId ?? ''} maxLength={200} /></Field>
        <Field label="PGC 规则编号"><Input name="pgcRuleId" defaultValue={saved?.pgcRuleId ?? ''} maxLength={200} /></Field>
      </div>
      <Field label="引用或记录位置"><Input name="reference" defaultValue={saved?.reference || ''} maxLength={500} /></Field>
      <Field label="核对 / 排除依据"><Textarea name="note" defaultValue={saved?.note || ''} maxLength={2000} rows={3} /></Field>
      <Button type="submit">追加声明记录</Button></fieldset>
    </form>
    <form className="stack admin-divider" onSubmit={measure}><fieldset className="stack" disabled={action.busy}>
      <Field label="实际文件字节测量" hint="最多 8 MB。只保存摘要和字节数，上传文件内容不执行，也不永久保存。"><Input type="file" name="file" accept=".html,.htm" required onChange={() => { fileRequest.current = undefined; }} /></Field>
      <Button variant="outline" type="submit">计算并保存摘要</Button></fieldset>
    </form>
    <StatusText {...action} label="正在核验与保存…" />
    {!!assessment?.files.length && <Table><thead><tr><th>实际测量</th><th>与 PGC 输入</th><th>SHA-256</th></tr></thead><tbody>{assessment.files.map(record => <tr key={record.id}><td>{time(record.createdAt)}<small>{record.file?.bytes ?? '未知'} 字节</small></td><td>{record.file?.inputHashMatches === true ? '一致' : record.file?.inputHashMatches === false ? '不同' : '原摘要未知'}</td><td><code>{record.file?.sha256 || '未知'}</code></td></tr>)}</tbody></Table>}
    <JsonDetails label="管理员核验历史 · 最近 100 条" value={assessment?.history || []} />
  </Card>;
}

function Comparison({ detail, onUpdated }: { detail: FeedbackJob; onUpdated: (assessment: FeedbackAssessmentSummary) => void }) {
  const action = useAction();
  const { comparison, platform, creation } = detail;
  return <div className="stack">
    <Card className="stack"><div className="spread"><h2>{detail.title || detail.jobId}</h2><Button variant="outline" size="sm" disabled={action.busy} onClick={() => void action.run(async () => {
      const data = await api(path('/export?jobId=' + segment(detail.jobId)));
      downloadText('creator-feedback-' + detail.jobId + '.json', JSON.stringify(data, null, 2), 'application/json');
    })}>导出 JSON</Button></div>
      <Facts items={[[ '原审核任务', detail.jobId ], [ '准确投稿', detail.workId + ' / ' + detail.versionId ], [ '编号依据', detail.matchedBy === 'user-confirmed' ? '用户明确确认' : '已有投稿记录' ], [ '来源缓存', detail.complete ? '增量阶段' : '全量尚未完成' ]]} />
      {creation && <Facts items={[[ '成品版本', creation.artifactVersionId ], [ 'Agent 投稿声明 SHA-256', <code>{creation.uploadHash}</code> ], [ '声明时间', time(creation.recordedAt) ], [ '来源文件摘要', '上游未提供' ]]} />}
      <div className="row"><Badge tone={comparison?.state === 'match' ? 'sage' : 'warning'}>{comparison?.state === 'match' ? '结论一致' : comparison?.state === 'different' ? '结论存在差异' : '暂不可比较'}</Badge><Badge>{verification(detail.assessment?.status)}</Badge><Badge tone="warning">严格评估条件未满足</Badge></div>
      <div className="grid-2">
        <AIReport ai={detail.ai} />
        <article className="stack"><h3>Creator Hub 有效投稿结论</h3>
          <p>{decision(platform?.decision)} · {platform?.reviewerRole === 'leader' ? '组长' : platform?.reviewerRole === 'admin' ? '管理员' : '历史角色未知'}</p>
          {!!platform?.reasons?.length && <p className="small muted">{platform.reasons.map(reason => decisionReasons[reason] || '来源状态需要进一步核对').join(' · ')}</p>}
          <p className="small muted">有效退回可来自组长。管理员终审按来源审核阶段单独识别。</p>
          {detail.reviews?.length ? detail.reviews.map(review => <SourceReviewCard key={review.id + ':' + review.revision} review={review} selected={review.id === platform?.reviewId && review.revision === comparison?.decidingReviewRevision} />) : <p className="small muted">此准确版本暂无来源审核。</p>}
        </article>
      </div>
      <Table className="admin-comparison-table"><thead><tr><th>维度</th><th>AI</th><th>平台</th><th>差值 · 数值对照</th></tr></thead><tbody>
        <tr><td>总分</td><td>{label(comparison?.totals?.ai)}</td><td>{label(comparison?.totals?.platform)}</td><td>—</td></tr>
        {comparison?.scoreDifferences?.map(row => <tr key={row.name}><td>{row.name}</td><td>{label(row.ai)}</td><td>{label(row.platform)}{row.platformMax !== undefined ? ' / ' + label(row.platformMax) : ''}</td><td>{label(row.delta)}</td></tr>)}
      </tbody></Table>
      <JsonDetails label="原始来源修订历史与规则" value={{ reviewHistory: detail.reviewHistory, sourceRuleVersion: detail.version?.ruleVersion, aiRules: detail.aiRules }} />
      <StatusText {...action} label="正在准备导出…" />
    </Card>
    <Assessment detail={detail} onUpdated={onUpdated} />
  </div>;
}

export default function Feedback({ route }: { route: AdminRoute }) {
  const { update, visit, notify } = useAdminRoute();
  const status = useResource<SyncStatus>(path('/status'));
  const metrics = useResource<Metrics>(adminPath('review-metrics?days=7'));
  const enabled = !!status.data?.enabled && !!status.data?.configured;
  const ready = enabled && !status.error && status.data?.status !== 'auth_revoked';
  const links = useResource<Links>(ready ? path('/links?' + new URLSearchParams({ limit: '20', after: route.section || '' })) : null);
  const job = useResource<FeedbackJob>(ready && route.id ? path('/job?jobId=' + segment(route.id)) : null);
  const action = useAction();
  function refresh() { status.reload(); metrics.reload(); links.reload(); job.reload(); }
  return <section className="stack">
    <PageHeader eyebrow="Creator Hub" title="反馈闭环" description="对照独立 AI 审核和准确投稿的真人反馈。成品关联由原设备在明确投稿后回填。" actions={<div className="row">
      <Button variant="outline" onClick={refresh}>刷新</Button>
      <Button disabled={!enabled || action.busy} onClick={() => void action.run(async () => {
        const result = await post<{ scheduled?: boolean }>(base + '/sync', {});
        notify(result.scheduled ? '已唤醒调度，继续遵守原退避时间。' : '尚未配置同步调度器。');
        status.reload();
      })}>唤醒同步</Button>
    </div>} />
    <div className="row"><Button variant="outline" size="sm" onClick={() => visit('members')}>管理灰测成员与 Creator 账号</Button></div>
    <Card className="stack"><h2>同步状态</h2><DataState resource={status}>{data => <>
      <div className="row"><Badge tone={data.enabled ? 'sage' : 'warning'}>{data.enabled ? '已启用' : '未启用'}</Badge><Badge>{data.configured ? '专用凭据已配置' : '专用凭据未配置'}</Badge><Badge>{syncLabels[data.status] || data.status}</Badge><Badge>{data.phase === 'delta' ? '增量同步' : data.phase === 'snapshot' ? '全量同步' : '阶段未知'}</Badge></div>
      <Facts items={[[ '全量进度', data.complete ? '已完成' : '尚未完成' ], [ '最近成功', time(data.lastSuccessAt) ], [ '最近尝试', time(data.lastAttemptAt || undefined) ], [ '计划下次运行', time(data.nextRunAt || undefined) ], [ '连续失败', data.failures ], [ '受控错误代码', data.errorCode || '无' ]]} />
    </>}</DataState><StatusText {...action} label="正在唤醒同步…" /></Card>
    <MetricsCard resource={metrics} />
    <LinkForm key={route.id || 'unlinked'} enabled={ready} jobId={route.id} onLinked={id => { links.reload(); if (route.id === id) job.reload(); else update({ id }); }} />
    <Card className="stack"><h2>已关联任务</h2>{ready ? <DataState resource={protectedResource(links)}>{data => <>
      {data.items.length ? <ResponsiveTable className="admin-feedback-table"><thead role="rowgroup"><tr role="row"><th>任务 / 成员</th><th>准确版本</th><th>核验</th><th>操作</th></tr></thead><tbody role="rowgroup">{data.items.map(row => <tr role="row" key={row.jobId}>
        <Cell wide>{row.title || row.jobId}<small className="muted">{row.ownerName} · {row.jobId}</small></Cell><Cell label="准确版本">{row.versionId}{row.artifactVersionId && <small className="muted">成品 {row.artifactVersionId}</small>}</Cell>
        <Cell label="核验">{verification(row.verificationStatus)} · {row.measuredFiles} 份文件测量</Cell><Cell wide><Button variant="outline" size="sm" onClick={() => update({ id: row.jobId })}>查看对照</Button></Cell>
      </tr>)}</tbody></ResponsiveTable> : <EmptyState title="暂无可读取的准确投稿关联" />}
      <div className="row"><Button variant="outline" size="sm" disabled={!route.section} onClick={() => update({ section: undefined, id: undefined })}>回到第一页</Button><Button variant="outline" size="sm" disabled={!data.nextAfter} onClick={() => update({ section: data.nextAfter || undefined, id: undefined })}>下一页</Button></div>
    </>}</DataState> : <p className="small muted">同步启用且专用凭据可用后，可查询授权关联。</p>}</Card>
    {ready && route.id && <section className="stack" aria-label="反馈详情"><div className="row"><Button size="sm" variant="ghost" onClick={() => update({ id: undefined })}>关闭对照</Button></div>
      <DataState resource={protectedResource(job)} label="正在读取准确投稿对照…">{detail => <Comparison key={detail.jobId + ':' + detail.generation} detail={detail} onUpdated={assessment => {
        job.setData(current => current?.jobId === detail.jobId && current.generation === detail.generation ? { ...current, assessment } : current);
        links.reload();
      }} />}</DataState>
    </section>}
    {ready && <SourceCache key={status.data?.scopeRevision} />}
  </section>;
}
