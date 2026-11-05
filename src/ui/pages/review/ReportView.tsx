import { useId, useRef, useState } from 'react';
import { Copy, Download, Images } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState, JsonDetails, Stat } from '../../components/ui';
import { useApp } from '../../context';
import { copyText, downloadText } from '../../lib/api';
import {
  dimensionText, dimensions, duration, humanFields, humanScore, humanState, humanTitle, issueLabels, list,
  normalizeReport, numeric, outcomeLabels, reportFields, reportFilename, reportState, reportText, reportTotal,
  reviewDate, safeShots, timingFields, type HumanReview, type Shot,
} from './report-data';
import './review.css';

export { reportText } from './report-data';

export function ReviewOutcome({ report }: { report: Parameters<typeof reportState>[0] }) {
  const outcome = reportState(report);
  return <Badge tone={outcome === 'pass' ? 'sage' : 'warning'}>{outcomeLabels[outcome]}</Badge>;
}

export function ReviewFields({ items }: { items: readonly (readonly unknown[])[] }) {
  const entries = items.filter(([, value]) => value != null && value !== '');
  return <dl className="review-fields">{entries.map(([label, value]) => <div key={String(label)}>
    <dt>{String(label)}</dt><dd>{String(value)}</dd>
  </div>)}</dl>;
}

export function HumanReviewSummary({ human }: { human?: HumanReview | null }) {
  return <section className="review-human stack" aria-label={humanTitle(human)}>
    <div className="spread"><h3>{humanTitle(human)}</h3><Badge tone={human?.status === 'reviewed' ? 'sage' : 'neutral'}>{humanState(human)}</Badge></div>
    {human?.status === 'reviewed' && <strong>{humanScore(human)}</strong>}
    {human && <ReviewFields items={humanFields(human)}/>}
    {human?.feedback && <p className="review-body-text">{human.feedback}</p>}
  </section>;
}

function TextList({ title, items, empty }: { title: string; items?: string[]; empty?: string }) {
  const entries = list(items);
  if (!entries.length && !empty) return null;
  return <section className="review-block">
    <h3>{title}</h3>
    {entries.length ? <ul>{entries.map((entry, index) => <li key={index}>{entry}</li>)}</ul> : <p className="muted">{empty}</p>}
  </section>;
}

export function ReportView({ report: input, embedded = false }: { report: any; embedded?: boolean }) {
  const { user } = useApp();
  const [shot, setShot] = useState<Shot | null>(null);
  const shotTrigger = useRef<HTMLButtonElement | null>(null);
  const sectionId = useId();
  if (!input) return <EmptyState title="暂无审核报告" description="报告回传后会显示评分、审核意见和画面证据。"/>;
  const { report, job } = normalizeReport(input);
  const result = report.result;
  if (!result) return <EmptyState title="暂无报告正文" description="请选择已发布的报告。"/>;
  const total = reportTotal(report);
  const showVerdict = result.verdict && (total !== null || result.verdict.trim() !== outcomeLabels.review);
  const issues = list(result.issues);
  const hasKinds = result.schema_version === 2;
  const sections = hasKinds ? [
    { key: 'confirmed', title: '强制整改 · 已证实缺陷', items: issues.filter(issue => issue.kind === 'confirmed') },
    { key: 'experience', title: '体验评价', items: issues.filter(issue => issue.kind === 'experience') },
    { key: 'unverified', title: '待验证问题', items: issues.filter(issue => issue.kind === 'unverified') },
  ] : [{ key: 'legacy', title: '历史问题与建议', items: issues }];
  const shots = safeShots(report);
  const threshold = (report.rules_snapshot || report.rulesSnapshot || report.provenance)?.passScore;
  const copyReport = () => void copyText(reportText(input));
  const downloadReport = () => downloadText(reportFilename(report.title, 'review'), reportText(input), 'text/markdown;charset=utf-8');
  const screenshot = (ref: string) => shots.find(item => item.id === ref || item.label === ref);
  const openShot = (image: Shot, trigger: HTMLButtonElement) => {
    shotTrigger.current = trigger;
    setShot(image);
  };
  const closeShot = () => {
    setShot(null);
    requestAnimationFrame(() => shotTrigger.current?.focus({ preventScroll: true }));
  };
  const facts = reportFields(report);
  const timing = timingFields(report, job);
  const firstLook = report.probe?.adaptive?.firstLook;
  const filename = report.title || '未命名游戏';
  const titleId = `${sectionId}-title`;

  return <article className={`review-report stack${embedded ? ' review-report-embedded' : ''}`} aria-labelledby={titleId}>
    <header className="spread review-report-header">
      <div><p className="review-eyebrow">AI 模拟审核报告</p><h2 id={titleId}>{filename}</h2><p className="muted small">{reviewDate(report.created_at)}</p></div>
      <div className="review-total">{total !== null && <ReviewOutcome report={report}/>}<strong>{total === null ? '总分待复核' : `${total} / 9`}</strong>
        {numeric(threshold) && <span className="muted small">模拟通过线 {threshold} 分</span>}</div>
    </header>
    <div className="grid-3 review-dimensions">
      {dimensions.map(([key, label]) => <Stat key={key} label={label} value={dimensionText(result[key])}/>)}
    </div>
    <section className="review-block review-comment">
      <h3>审核意见</h3>
      <p className="review-body-text">{result.reviewer_comment || '未提供审核意见。'}</p>
      {showVerdict && <p className="muted small">模型结论 · {result.verdict}</p>}
    </section>
    <HumanReviewSummary human={report.human_review}/>
    <section className="review-block">
      <h3>评分依据</h3>
      {result.score_reasons ? <ReviewFields items={dimensions.map(([key, label]) => [label, result.score_reasons?.[key] || '未记录'])}/> :
        <p className="muted">旧报告未单独记录评分依据。</p>}
    </section>
    <TextList title="待人工确认" items={result.uncertainties} empty={result.uncertainties ? '模型未额外列出待确认项。' : '旧报告未单独记录待确认项。'}/>
    <TextList title="值得保留" items={result.strengths}/>
    <div className="review-block">
      <h3>问题与体验评价</h3>
      {issues.length === 0 && <p className="muted">报告未列出问题。</p>}
      {sections.filter(section => section.items.length).map(section => <section className="review-issue-group" key={section.key}>
        <h4>{section.title} <span className="muted">· {section.items.length}</span></h4>
        {section.items.map((issue, index) => <div className="review-issue" key={index}>
          <div className="row"><Badge tone={issue.severity === '高' ? 'danger' : issue.severity === '中' ? 'warning' : 'neutral'}>{issue.severity}优先级</Badge>
            {issue.kind && <Badge tone="neutral">{issueLabels[issue.kind]}</Badge>} <strong>{issue.area}</strong></div>
          <p className="review-body-text">{issue.problem}</p>
          <ReviewFields items={[[ '观察证据', issue.evidence ], [issue.kind === 'unverified' ? '验证方法' : issue.kind === 'experience' ? '可选改善' : '建议改法', issue.fix]]}/>
          {!!list(issue.evidence_refs).length && <div className="row review-evidence-refs"><span className="muted small">证据引用</span>
            {list(issue.evidence_refs).map((ref, i) => {
              const image = screenshot(ref);
              return image ? <Button key={i} size="sm" variant="outline" onClick={event => openShot(image, event.currentTarget)}>{ref}</Button> : <Badge key={i} tone="neutral">{ref}</Badge>;
            })}
          </div>}
        </div>)}
      </section>)}
    </div>
    <TextList title="可选优化" items={result.optional_suggestions}/>
    <section className="review-block">
      <div className="spread review-prompt-head"><h3>交给智能助手修改</h3>{result.fix_prompt && <div className="row">
        <Button size="sm" variant="outline" onClick={() => void copyText(result.fix_prompt!)}><Copy size={14}/>复制修改指令</Button>
        <Button size="sm" variant="outline" onClick={() => downloadText(reportFilename(report.title, 'fix', 'txt'), result.fix_prompt!)}><Download size={14}/>下载指令</Button>
      </div>}</div>
      {result.fix_prompt ? <details className="review-disclosure"><summary>展开完整修改指令</summary><pre>{result.fix_prompt}</pre></details> :
        <p className="muted">本次报告未提供修改指令。</p>}
    </section>
    {!!shots.length && <section className="review-block">
      <div className="spread"><h3 className="row"><Images size={17}/>画面证据</h3><span className="muted small">{shots.length} 张 · 点击查看原图</span></div>
      <div className="review-shots">{shots.map((image, index) => <button className="review-shot" type="button" key={image.id ?? index} onClick={event => openShot(image, event.currentTarget)}>
        <span><img src={image.data} alt="" loading="lazy"/></span><strong>{image.label || `原始截图 ${index + 1}`}</strong>
      </button>)}</div>
    </section>}
    {report.probe && <details className="review-disclosure">
      <summary>查看运行采集记录</summary>
      {report.probe.captureMethod === 'browser-viewport-v1' || report.probe.captureMethod === 'browser-viewport-v2' ?
        <p>基础证据为浏览器完整视口截图，包含 DOM、CSS 和全部 Canvas 图层。短时试玩的操作和节奏观察有限。采集未验证听感。</p> :
        <p>这份历史报告未记录完整视口采集方式。</p>}
      <ReviewFields items={timing}/>
      {firstLook?.observations && <section><h4>源盲首次上手观察</h4><p className="review-body-text">{firstLook.observations}</p><TextList title="首次上手待验证" items={firstLook.uncertainties}/></section>}
      <ReviewFields items={[
        ...Object.entries((report.probe.loaded || {}) as Record<string, unknown>).map(([ratio, loaded]) => [`${ratio} 加载事件`, loaded === true ? '已完成' : '采集时限内未完成']),
        ['运行日志', Array.isArray(report.probe.errors) ? report.probe.errors.join('\n') : null],
      ]}/>
      {report.probe.resources != null && <JsonDetails label="资源加载记录" value={report.probe.resources}/>}
      {user?.role === 'admin' && <JsonDetails label="原始采集元数据" value={report.probe}/>}
    </details>}
    <details className="review-disclosure">
      <summary>执行来源、日期与规则</summary>
      <ReviewFields items={facts}/>
      {!report.probe && <ReviewFields items={timing}/>}
    </details>
    <footer className="spread review-report-footer">
      <p className="muted small">AI 模拟审核基于有限证据，最终结果由人工确认。</p>
      <div className="row"><Button size="sm" variant="outline" onClick={copyReport}><Copy size={14}/>复制报告</Button>
        <Button size="sm" variant="outline" onClick={downloadReport}><Download size={14}/>下载报告</Button></div>
    </footer>
    {shot && <Dialog open onOpenChange={open => { if (!open) closeShot(); }} title={shot.label || '原始截图'} wide>
      <div className="review-evidence-body">
        <img className="review-lightbox" src={shot.data} alt={shot.label || '原始截图'}/>
        <ReviewFields items={[[ '证据编号', shot.id ], ['采集日期', shot.capturedAt && reviewDate(shot.capturedAt)], ['来源', shot.source],
          ['关联动作', shot.actionRefs?.join('、')], ['实际时点', numeric(shot.actionOffsetMs) ? duration(shot.actionOffsetMs) : null],
          ['计划时点', numeric(shot.requestedOffsetMs) ? duration(shot.requestedOffsetMs) : null]]}/>
      </div>
    </Dialog>}
  </article>;
}
