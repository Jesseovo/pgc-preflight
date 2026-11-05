import { useEffect, useState } from 'react';
import { BriefDocument } from './brief';
import { GamePlayer } from '../../components/GamePlayer';
import { Badge, Button, Card, ConfirmAction, EmptyState, ErrorState, Field, JsonDetails, Loading, Select } from '../../components/ui';
import { useApp } from '../../context';
import { api, downloadText, useAction, useResource } from '../../lib/api';
import { CopyButton, IdeaDetails } from './common';
import { creatorUrl, displayDate, forge, safeFilename, stageLabels, titleOf, type Idea, type Kind, type Topic, type Version } from './model';

const assetType: Record<Kind, {extension: string; mime: string}> = {
  expand: {extension: 'json', mime: 'application/json'}, brief: {extension: 'md', mime: 'text/markdown'}, preview: {extension: 'svg', mime: 'image/svg+xml'},
  assets: {extension: 'html', mime: 'text/html'}, game: {extension: 'html', mime: 'text/html'},
};

function DownloadLink({href, children}: {href: string; children: string}) {
  return <a className="creator-download" href={href} download>{children} ↓</a>;
}

function useArtifactText(path: string | null, label: string) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setError('');
    setText('');
    void fetch(path, {signal: controller.signal, credentials: 'same-origin', cache: 'no-store'}).then(response => {
      if (!response.ok) throw new Error(`无法读取${label}。`);
      return response.text();
    }).then(setText).catch((err: Error) => {if (!controller.signal.aborted) setError(err.message);});
    return () => controller.abort();
  }, [path, label, retry]);
  return {text, error, reload: () => setRetry(value => value + 1)};
}

export function Artifact({topic, kind, version, live = false}: {topic: Topic; kind: Kind; version?: Version; live?: boolean}) {
  const [showSource, setShowSource] = useState(false);
  const action = useAction();
  const base = `${forge}/topics/${topic.id}`;
  const versionUrl = version ? `${base}/versions/${encodeURIComponent(version.id)}` : null;
  const liveBrief = kind === 'brief' && (live || !version);
  const content = useResource<Version>(versionUrl && !liveBrief && (kind === 'brief' || kind === 'expand' || showSource) && !version?.content ? versionUrl : null);
  const oldPreview = useResource<Topic>(kind === 'preview' && !version ? base : null);
  const oldGame = useResource<{html: string}>(kind === 'game' && !version && showSource ? `${base}/product` : null);
  const brief = useArtifactText(liveBrief ? `${base}/brief` : null, '当前简报');
  const oldAssets = useArtifactText(kind === 'assets' && !version && showSource ? `${base}/assets` : null, '资产源码');
  const text = liveBrief ? brief.text : version?.content ?? content.data?.content ?? (kind === 'preview' ? oldPreview.data?.preview_svg : kind === 'game' ? oldGame.data?.html : kind === 'assets' ? oldAssets.text : undefined);
  const title = titleOf(topic);
  const versionDownload = () => action.run(async () => {
    const artifact = assetType[kind];
    const value = text ?? (versionUrl ? (await api<Version>(versionUrl)).content : undefined);
    if (!value) throw new Error('此版本没有可下载的内容。');
    downloadText(`${safeFilename(title)}-${version ? version.id : kind}.${artifact.extension}`, value, artifact.mime);
  });
  const error = content.error || oldPreview.error || oldGame.error || brief.error || oldAssets.error;
  const retry = () => {if (content.error) content.reload(); if (oldPreview.error) oldPreview.reload(); if (oldGame.error) oldGame.reload(); if (brief.error) brief.reload(); if (oldAssets.error) oldAssets.reload();};
  let idea: Idea | undefined = topic.data;
  if (kind === 'expand' && version) {
    try {idea = text ? JSON.parse(text) as Idea : undefined;} catch {idea = undefined;}
  }
  const previewSrc = versionUrl ? `${versionUrl}/preview` : kind === 'game' ? `${base}/product-preview` : `${base}/assets-preview`;
  return <div className="creator-artifact stack" key={version?.id || kind}>
    {version && <div className="row"><small className="muted">版本 {version.id}</small>{version.stale && <Badge tone="warning">上游内容已变化</Badge>}</div>}
    {error && <ErrorState error={error} onRetry={retry}/>}
    {kind === 'game' && <GamePlayer src={previewSrc} title={title} versionKey={version?.id || String(topic.id)}/>}
    {(kind === 'assets' || (kind === 'preview' && version)) && <iframe className={`creator-artifact-frame ${kind === 'preview' ? 'creator-style-frame' : ''}`} src={previewSrc} sandbox="allow-scripts" referrerPolicy="no-referrer" title={`${title} · ${stageLabels[kind]}`}/>}
    {kind === 'preview' && !version && text && <img className="creator-style-image" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} alt={`${title}的风格样板图`}/>}
    {kind === 'brief' && (text ? <BriefDocument text={text}/> : !error && <Loading label="正在读取简报"/>)}
    {kind === 'expand' && (idea ? idea.candidates ? <div className="stack"><p className="small muted">{idea.candidates.length} 个候选。要查重或登记，请回到「发现选题」。</p>{idea.candidates.map((candidate, index) => <details className="creator-disclosure" key={index}><summary>{candidate.title || `候选 ${index + 1}`}{idea?.recommended?.includes(index) ? ' · 推荐' : ''}</summary><IdeaDetails idea={candidate}/></details>)}</div> : <IdeaDetails idea={idea}/> : !error && <Loading label="正在读取扩写内容"/>)}
    <div className="row">
      {liveBrief ? <DownloadLink href={`${base}/brief`}>下载简报 Markdown</DownloadLink>
        : version ? <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void versionDownload()}>下载 {assetType[kind].extension.toUpperCase()} ↓</Button>
        : kind === 'game' ? <DownloadLink href={`${base}/product-file`}>下载成品 HTML</DownloadLink>
        : kind === 'assets' ? <DownloadLink href={`${base}/assets`}>下载资产 HTML</DownloadLink>
        : kind === 'preview' && text ? <Button size="sm" variant="outline" onClick={() => downloadText(`${safeFilename(title)}-style.svg`, text, 'image/svg+xml')}>下载 SVG ↓</Button> : null}
      {kind === 'brief' && text && <CopyButton value={text}>复制简报</CopyButton>}
      {kind !== 'brief' && kind !== 'expand' && <Button size="sm" variant="ghost" onClick={() => setShowSource(open => !open)}>{showSource ? '收起源码' : '查看源码'}</Button>}
    </div>
    {showSource && (text ? <div className="stack"><pre className="creator-code">{text}</pre><div><CopyButton value={text}>复制源码</CopyButton></div></div> : !error && <Loading label="正在读取源码"/>)}
  </div>;
}

export function VersionPanel({topic, versions, loading, selected, onSelect, onChecks, onRestored}: {
  topic: Topic; versions: Version[]; loading: boolean; selected: string; onSelect: (id: string) => void; onChecks: () => void; onRestored: () => void;
}) {
  const {notify} = useApp();
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const restore = useAction();
  const visible = versions.filter(version => (!kind || version.kind === kind) && (!status || status === version.disposition));
  const version = versions.find(item => item.id === selected);
  if (loading && !versions.length) return <Loading label="正在读取历史版本"/>;
  if (!versions.length) return <EmptyState title="还没有版本记录" description="每次创作的结果会各自保存。采用和恢复都会写入一份新记录。"/>;
  return <div className="creator-project-columns creator-version-columns">
    <Card className="creator-version-list">
      <div className="spread row"><h2>版本记录</h2><Badge tone="neutral">{versions.length} 份</Badge></div>
      <div className="grid-2"><Field label="产物"><Select value={kind} onChange={event => setKind(event.target.value)}><option value="">全部产物</option>{Object.keys(assetType).map(key => <option value={key} key={key}>{stageLabels[key]}</option>)}</Select></Field>
        <Field label="版本状态"><Select value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option><option value="current">当前</option><option value="pending">待采用</option><option value="historical">历史</option></Select></Field></div>
      {visible.length ? visible.map(item => <button className="creator-version-option" type="button" key={item.id} aria-pressed={item.id === selected} onClick={() => onSelect(item.id)}>
        <span><b>{stageLabels[item.kind] || item.kind}</b><small>{displayDate(item.created_at)}</small></span><span><VersionStatus version={item}/>{item.stale && <small className="danger-text">上游已更新</small>}</span>
      </button>) : <p className="small muted">没有匹配的版本。</p>}
    </Card>
    {selected && !version ? <ErrorState error="没有找到这个项目版本。" onRetry={onRestored}/> : version ? <Card className="creator-version-detail" key={version.id}>
      <div className="spread row"><h2>{stageLabels[version.kind] || version.kind}</h2><VersionStatus version={version}/></div>
      <p className="small muted">{displayDate(version.created_at)} · {({agent: '个人 Agent', platform: '平台', restore: '恢复', migration: '旧记录'} as Record<string, string>)[version.executor] || version.executor}{version.model ? ` · ${version.model}` : ''}</p>
      {version.stale && <p className="creator-callout" role="status">此版本生成时使用的上游材料或公共规则已更新。采用前请核对锁定的输入版本。</p>}
      {version.disposition === 'pending' && version.kind === 'game' && <p className="creator-callout">这可能是中途保存的制作阶段，或包含暂缓需求、未验证问题与核心改动的交付。采用前，请试玩并核对制作自检。</p>}
      <VersionInputs version={version} onSelect={id => {if (versions.some(item => item.id === id)) onSelect(id);}} known={new Set(versions.map(item => item.id))}/>
      <Artifact topic={topic} kind={version.kind} version={version}/>
      <div className="row">
        {version.kind === 'game' && <Button size="sm" variant="outline" onClick={onChecks}>核对制作自检</Button>}
        {!version.current && version.disposition !== 'current' && <ConfirmAction title={version.disposition === 'pending' ? '采用这个结果' : '恢复历史版本'} description={version.kind === 'game'
          ? '此操作会将准确的 HTML 保存为一个新当前版本。请先检查阶段记录、延期需求和未解决的核心改动。'
          : '此操作会从这份内容创建新当前版本，原记录会保留。'} onConfirm={async () => {await restore.run(async () => {
          await api(`${forge}/topics/${topic.id}/restore`, {method: 'POST', body: {version_id: version.id}});
          notify('已保存为新的当前版本', 'success'); onRestored(); onSelect('');
        });}}>{version.disposition === 'pending' ? '采用此结果' : '恢复此版本'}</ConfirmAction>}
      </div>
    </Card> : <EmptyState title="选择一份版本" description="在这里预览、下载、核对上游输入，或确认采用。"/>}
  </div>;
}

function VersionStatus({version}: {version: Version}) {
  if (version.current ?? version.disposition === 'current') return <Badge tone="sage">当前版本</Badge>;
  return <Badge tone={version.disposition === 'pending' ? 'warning' : 'neutral'}>{version.disposition === 'pending' ? '待采用' : '历史版本'}</Badge>;
}

function VersionInputs({version, known, onSelect}: {version: Version; known: Set<string>; onSelect: (id: string) => void}) {
  let inputs: Record<string, string> = {};
  try {inputs = typeof version.input_versions === 'string' ? JSON.parse(version.input_versions) : version.input_versions || {};} catch { /* Historical records can lack input metadata. */ }
  if (!Object.keys(inputs).length && !version.restored_from) return null;
  return <details className="creator-disclosure"><summary>锁定的输入版本</summary><dl className="creator-facts">
    {Object.entries({...inputs, ...(version.restored_from ? {restored: version.restored_from} : {})}).map(([key, id]) => <div key={key}><dt>{stageLabels[key] || (key === 'restored' ? '原恢复版本' : key === 'candidate_batch' ? '候选轮次' : key)}</dt><dd>
      {known.has(id) ? <button className="creator-title-link" onClick={() => onSelect(id)}>{id}</button> : <code>{id}</code>}
    </dd></div>)}
  </dl></details>;
}

interface Finding { id: string; kind: string; phenomenon: string; trigger?: string; cause?: string; minimalChange?: string; retest?: string; evidenceRefs?: string[]; coreChange?: boolean; resolved?: boolean }
interface CheckRecord {
  task_id: string; stage: string; version_id?: string; content_hash?: string; evidence_hash?: string; created_at?: string;
  self_check?: {model?: string; coreChanges?: string[]; decisions?: string[]; requirements?: {id: string; text: string; status: string; reason?: string; evidence?: string}[];
    judgedInputHash?: string; judgedEvidenceHash?: string;
    selfCheck?: {findings?: Finding[]; unverified?: string[]; changes?: string[]; requestRepair?: boolean}};
}
interface Evidence { shots?: {data: string; label?: string; id: string}[]; probe?: unknown }

export function ProjectChecks({id, onVersion}: {id: number; onVersion: (id: string) => void}) {
  const source = useResource<CheckRecord[]>(`${forge}/topics/${id}/creation-checks`);
  return <div className="stack">
    <Card className="creator-note"><h2>制作自检</h2><p>模型在各制作阶段回传需求、自检和采集引用。创作阶段记录与独立 AI 审核和真人终审分别保存。</p></Card>
    {source.error && <ErrorState error={source.error} onRetry={source.reload}/>}
    {source.loading && !source.data ? <Loading label="正在读取制作阶段"/> : source.data?.length ? source.data.map(record => <CreationRecord key={`${record.task_id}-${record.stage}`} topicId={id} record={record} onVersion={onVersion}/>)
      : !source.error && <EmptyState title="暂无制作阶段记录" description="完成新版制作阶段后，自检和原始采集将分开保存。"/>}
  </div>;
}

function CreationRecord({topicId, record, onVersion}: {topicId: number; record: CheckRecord; onVersion: (id: string) => void}) {
  const [show, setShow] = useState(false);
  const evidence = useResource<Evidence>(show ? `${forge}/topics/${topicId}/creation-checks/${encodeURIComponent(record.task_id)}/${encodeURIComponent(record.stage)}` : null);
  const check = record.self_check;
  const findings = check?.selfCheck?.findings || [];
  const unknown = check?.selfCheck?.unverified || [];
  return <Card className="creator-check stack">
    <div className="spread row"><div><h3>{stageLabels[record.stage] || record.stage}</h3><p className="small muted">{displayDate(record.created_at)}{check?.model ? ` · ${check.model}` : ''}</p></div>
      <div className="row">{record.version_id && <Button variant="outline" size="sm" onClick={() => onVersion(record.version_id!)}>打开此阶段版本</Button>}
        {record.evidence_hash && <Button variant="outline" size="sm" onClick={() => setShow(open => !open)}>{show ? '收起原始采集' : '查看本阶段原始采集'}</Button>}</div></div>
    {check?.coreChanges?.length ? <div className="creator-callout"><strong>核心改动 · 待你核对</strong><ul>{check.coreChanges.map((change, index) => <li key={index}>{change}</li>)}</ul></div> : null}
    {check?.requirements?.length ? <details className="creator-disclosure" open={check.requirements.some(item => item.status === 'deferred') || undefined}><summary>制作需求清单</summary><ul>{check.requirements.map(item => <li key={item.id}><b>{item.id}</b> · {item.text} <Badge tone={item.status === 'implemented' ? 'neutral' : 'warning'}>{({implemented: '模型声明已实现', unverified: '待验证', deferred: '已暂缓'} as Record<string, string>)[item.status] || item.status}</Badge>{item.reason && <p>{item.reason}</p>}{item.evidence && <p className="small muted">引用 · {item.evidence}</p>}</li>)}</ul></details> : null}
    {findings.length > 0 && <div><h4>模型自检发现</h4><ul>{findings.map(finding => <li key={finding.id}><Badge tone={finding.kind === 'confirmed' ? 'sage' : 'warning'}>{({confirmed: '自检确认', experience: '体验', unverified: '待验证'} as Record<string, string>)[finding.kind] || finding.kind}</Badge> {finding.phenomenon}
      {finding.coreChange && <strong> · 涉及核心改动</strong>}{finding.resolved === false && <strong> · 未解决</strong>}
      <details className="creator-disclosure"><summary>触发、证据与复测</summary><dl className="creator-facts">
        {Object.entries({触发: finding.trigger, 原因: finding.cause, 最小改动: finding.minimalChange, 复测: finding.retest, 引用: finding.evidenceRefs?.join('、')}).filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl></details></li>)}</ul></div>}
    {unknown.length > 0 && <p><b>未验证</b> · {unknown.join('、')}</p>}
    {check?.decisions?.length ? <details className="creator-disclosure"><summary>补充决定</summary><ul>{check.decisions.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : null}
    <details className="creator-disclosure"><summary>内容摘要与证据引用</summary><dl className="creator-facts">
      {Object.entries({成品摘要: record.content_hash, 本阶段采集摘要: record.evidence_hash, 自检依据的输入摘要: check?.judgedInputHash, 自检依据的采集摘要: check?.judgedEvidenceHash}).filter(([, hash]) => hash).map(([label, hash]) => <div key={label}><dt>{label}</dt><dd><code>{hash}</code></dd></div>)}
    </dl></details>
    {show && <div className="stack">
      {evidence.error ? <ErrorState error={evidence.error} onRetry={evidence.reload}/> : evidence.loading && !evidence.data ? <Loading label="正在读取原始采集"/> : null}
      {evidence.data && <><div className="creator-card-grid">{evidence.data.shots?.filter(shot => /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(shot.data)).map(shot => <figure key={shot.id} className="creator-evidence">
        <img src={shot.data} alt={shot.label || '原始视口截图'} loading="lazy"/><figcaption>{shot.label || '原始视口截图'} · {shot.id}</figcaption>
      </figure>)}</div><JsonDetails value={evidence.data.probe} label="采集动作、日志与视口记录"/></>}
    </div>}
    <JsonDetails value={check} label="查看自检原始记录"/>
  </Card>;
}

interface HumanReview {status?: string; phase?: string; decision?: string; score?: number | null; workId?: string; versionId?: string; work_id?: string; version_id?: string}
interface ReportSummary {id: number; job_id?: string; title: string; topic_id?: number; score?: number | null; verdict?: string; created_at?: string; human_review?: HumanReview}
interface ReviewJob {id: string; result_id?: number; artifactVersionId?: string; input_hash?: string; human_review?: HumanReview}

export function ProjectReviews({topic, versions}: {topic: Topic; versions: Version[]}) {
  const {navigate, params} = useApp();
  const reports = useResource<ReportSummary[]>(`${forge}/reviews`);
  const [focus, setFocus] = useState<number | null>(null);
  const [chosen, setChosen] = useState('');
  const games = versions.filter(version => version.kind === 'game');
  const version = games.find(item => item.id === chosen) || games.find(item => item.current) || games[0];
  const related = reports.data?.filter(report => Number(report.topic_id) === topic.id) || [];
  const record = related.find(report => report.id === focus);
  const details = useResource<ReviewJob>(record?.job_id ? `${forge}/review/jobs/${encodeURIComponent(record.job_id)}` : null);
  const job = details.data?.id === record?.job_id ? details.data : undefined;
  const exactVersion = job?.artifactVersionId;
  const title = titleOf(topic);
  const download = useAction();
  const prompt = version ? `请阅读 ${location.origin}/agent.md，用你自己的模型审核我下载的《${title}》原始 HTML。请对该文件执行 review <原始HTML文件> --artifact-version ${version.id}，完成初评和同模型同证据复核后回传报告。成品版本与文件 SHA-256 由平台校验。只有我明确提交到 Creator Hub、并能提供实际投稿编号和原始文件摘要时，再按接入说明使用 record-submission。不要按标题猜测投稿。` : '';
  const openVersion = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('panel', 'versions');
    next.set('version', id);
    navigate(creatorUrl(next));
  };
  return <div className="creator-project-columns">
    <Card className="creator-review-card stack"><div className="spread row"><h2>项目的 AI 审核</h2><Button variant="ghost" size="sm" onClick={() => navigate(creatorUrl({tab: 'review'}))}>我的审核 →</Button></div>
      <p className="muted">下载选定版本并交给审核 Agent。它会独立采集和复核，审核任务会校验上传文件的 SHA-256。</p>
      {version ? <><Field label="要审核的准确成品版本"><Select value={version.id} onChange={event => setChosen(event.target.value)}>{games.map(item => <option value={item.id} key={item.id}>{item.current ? '当前' : item.disposition === 'pending' ? '待采用' : '历史'} · {displayDate(item.created_at)} · {item.id}</option>)}</Select></Field>
        <div className="row"><Button variant="outline" size="sm" disabled={download.busy} onClick={() => void download.run(async () => {
          const artifact = await api<Version>(`${forge}/topics/${topic.id}/versions/${encodeURIComponent(version.id)}`);
          if (!artifact.content) throw new Error('此版本没有可下载的 HTML。');
          downloadText(`${safeFilename(title)}-${version.id}.html`, artifact.content, 'text/html');
        })}>下载此版本的原始 HTML</Button><CopyButton value={prompt}>复制准确版本的审核指令</CopyButton></div>
        <details className="creator-disclosure"><summary>查看指令</summary><p className="creator-prewrap">{prompt}</p></details>
      </> : <p className="creator-callout">还没有可选的成品版本。</p>}
      <details className="creator-disclosure"><summary>Creator Hub 准确投稿与真人结论</summary><p>实际投稿后，在原审核 Agent 会话中提供准确的作品编号、投稿版本编号和文件摘要。由原设备在原任务上回填。真人结论与 AI 报告分别记录。</p></details>
    </Card>
    <Card className="creator-review-card stack"><h2>项目相关报告</h2>
      {reports.error && <ErrorState error={reports.error} onRetry={reports.reload}/>}
      {reports.loading && !reports.data ? <Loading label="正在读取项目报告"/> : !related.length && !reports.error ? <p className="muted">暂无明确关联到此项目的报告。</p> : null}
      {related.map(report => <article key={report.id} className="creator-report-row">
        <div className="spread row"><b>{report.title}</b><Badge tone="neutral">{report.score == null ? '待复核' : `${report.score}/9`}</Badge></div>
        <p className="small muted">{displayDate(report.created_at)}{report.verdict ? ` · ${report.verdict}` : ''}</p>
        <div className="row"><Button size="sm" variant="ghost" onClick={() => navigate(creatorUrl({tab: 'review', reviewTab: 'history', report: report.id}))}>打开报告</Button>
          {report.job_id && <Button size="sm" variant="outline" onClick={() => setFocus(focus === report.id ? null : report.id)}>{focus === report.id ? '收起关联' : '核对版本关联'}</Button>}</div>
        {focus === report.id && <div className="creator-callout">
          {details.error ? <ErrorState error={details.error} onRetry={details.reload}/> : details.loading || !job ? <Loading label="正在读取原审核任务"/> : <>
            {exactVersion && job.result_id === report.id ? <><p><b>锁定成品版本</b> <code>{exactVersion}</code></p><p><b>原审核文件摘要</b> <code>{job.input_hash || '未记录'}</code></p>
              {games.some(item => item.id === exactVersion) && <Button size="sm" variant="ghost" onClick={() => openVersion(exactVersion)}>打开准确成品版本</Button>}</>
              : <p>这份报告只关联到项目，原任务未确认成品版本。</p>}
            {(job.human_review || report.human_review) && <HumanResult value={(job.human_review || report.human_review)!}/>}
          </>}
        </div>}
      </article>)}
    </Card>
  </div>;
}

function HumanResult({value}: {value: HumanReview}) {
  return <div><p><b>真人结论</b> · {value.phase === 'final' ? '终审' : value.phase === 'preliminary' ? '组长预审' : value.phase || '阶段未记录'} · {value.decision === 'approved' ? '通过' : value.decision === 'rejected' ? '退回' : value.status || '等待结果'}{value.score != null ? ` · ${value.score}/9` : ''}</p>
    {(value.workId || value.work_id) && <p className="small muted">Creator Hub 作品 {value.workId || value.work_id} · 投稿版本 {value.versionId || value.version_id || '未记录'}</p>}</div>;
}
