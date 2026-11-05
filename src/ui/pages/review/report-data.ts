export const dimensions = [['aes', '美学'], ['ease', '易玩性'], ['play', '可玩性']] as const;

type Dimension = (typeof dimensions)[number][0];
type Issue = { severity: string; area: string; problem: string; evidence: string; fix: string; kind?: string; evidence_refs?: string[] };
export type HumanReview = {
  phase?: string; status?: string; decision?: string; score?: number | string | null; feedback?: string;
  workId?: string; versionId?: string; updatedAt?: string; source?: string; matchedBy?: string;
};
export type Shot = { label: string; data: string; id?: string; capturedAt?: string; source?: string; actionRefs?: (string | number)[]; actionOffsetMs?: number; requestedOffsetMs?: number };
export type ReviewReport = {
  id: number; title: string; score?: number | null; created_at?: string; job_id?: string; model?: string;
  model_executor?: string; agent_id?: string; evidence_hash?: string; human_review?: HumanReview | null;
  verdict?: string; report_schema_version?: number; assessment_status?: string;
  result?: Partial<Record<Dimension, number | null>> & {
    schema_version?: number; assessment_status?: string; verdict?: string; reviewer_comment?: string; fix_prompt?: string;
    score_reasons?: Partial<Record<Dimension, string>>; uncertainties?: string[]; strengths?: string[];
    issues?: Issue[]; optional_suggestions?: string[];
  };
  probe?: { evidenceOrigin?: string; modelExecutor?: string; captureMethod?: string; adaptive?: {
    rounds?: number; actionCount?: number; playMs?: number; modelWaitMs?: number;
    firstLook?: { observations?: string; uncertainties?: string[] };
  }; [key: string]: unknown };
  shots?: Shot[];
  rules_snapshot?: Rules | null;
  rulesSnapshot?: Rules | null;
  provenance?: Rules | null;
};
type Rules = { id?: string; version?: string; capturedAt?: string; sourceUrl?: string; contentHash?: string; passScore?: number };
type ReportWrapper = {report: ReviewReport; job?: { created_at?: string; updated_at?: string; review_mode?: string }; human_review?: HumanReview | null};

export function normalizeReport(input: ReviewReport | ReportWrapper) {
  if ('report' in input && input.report) {
    const { report, job, human_review } = input;
    return { report: human_review === undefined ? report : { ...report, human_review }, job };
  }
  return { report: input as ReviewReport, job: undefined };
}

export const list = <T,>(value: T[] | null | undefined): T[] => Array.isArray(value) ? value : [];
export const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const dimensionText = (value: unknown) => numeric(value) ? `${value} / 3` : '待判断';
export const duration = (ms: unknown) => numeric(ms) && ms >= 0 ? `${Number((ms / 1000).toFixed(1))} 秒` : '未记录';

const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' });
export function reviewDate(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '未记录';
  return dateTime.format(new Date(value));
}

export function reportTotal(report: ReviewReport) {
  if ((report.result?.assessment_status ?? report.assessment_status) === 'needs_review') return null;
  if ((report.result?.schema_version ?? report.report_schema_version) === 2 && report.result &&
    (report.result.assessment_status !== 'complete' || dimensions.some(([key]) => !numeric(report.result?.[key])))) return null;
  return numeric(report.score) ? report.score : null;
}

export function reportState(report: ReviewReport) {
  const total = reportTotal(report);
  if (total === null) return 'review';
  if ((report.result?.schema_version ?? report.report_schema_version) !== 2) return total >= 7 ? 'pass' : 'revise';
  const verdict = report.result?.verdict ?? report.verdict ?? '';
  if (/^通过/.test(verdict)) return 'pass';
  if (/^打回/.test(verdict)) return 'revise';
  return 'review';
}

export const outcomeLabels = { review: '待复核', pass: '模拟通过', revise: '建议修改' };
export const issueLabels: Record<string, string> = { confirmed: '已证实缺陷', experience: '体验评价', unverified: '待验证' };
export const humanTitle = (human?: HumanReview | null) => human?.phase === 'preliminary' ? '组长预审' : human?.phase === 'final' ? '真人终审' : '真人审核';
export const humanScore = (human?: HumanReview | null) => numeric(human?.score) || (typeof human?.score === 'string' && human.score.trim()) ? `${human.score} / 9` : '评分未提供';

export function humanState(human?: HumanReview | null) {
  if (!human) return '暂无真人审核或未关联作品';
  if (human.status === 'reviewed') {
    if (human.phase === 'final' && human.decision === 'approved') return '已通过';
    if (human.phase === 'final' && human.decision === 'rejected') return '已退回';
    return '已审核';
  }
  if (human.status === 'pending') return '暂未审核';
  if (human.status === 'unavailable') return '查询暂不可用';
  return '未关联真人审核作品';
}

export function humanFields(human?: HumanReview | null) {
  return [
    ['关联作品', human?.workId], ['投稿版本', human?.versionId],
    ['更新时间', human?.updatedAt && reviewDate(human.updatedAt)],
    ['来源（Agent 同步）', human?.source],
    ['关联依据', human?.matchedBy === 'user-confirmed' ? '用户确认' : human?.matchedBy === 'published-record' ? '发布记录' : human?.matchedBy],
  ];
}

export function reportOrigin(report: ReviewReport) {
  const executor = report.model_executor || report.probe?.modelExecutor;
  if (executor === 'agent') return '成员本机 Agent';
  if (executor === 'platform') return '平台模型（管理员上传）';
  if (executor && /import|manual-admin/.test(executor)) return '管理员导入';
  return '历史报告（执行来源未记录）';
}

export function reportFields(report: ReviewReport) {
  const rules = report.rules_snapshot || report.rulesSnapshot || report.provenance;
  const origin = report.probe?.evidenceOrigin;
  return [
    ['执行来源', reportOrigin(report)], ['模型', report.model], ['报告日期', report.created_at && reviewDate(report.created_at)],
    ['证据来源', origin === 'member-device' ? '成员本机采集' : origin === 'admin-upload' ? '管理员导入' : origin || '未单独记录'],
    ['Agent 编号', report.agent_id], ['原任务', report.job_id], ['证据哈希', report.evidence_hash],
    ['规则快照', rules?.id], ['规则版本', rules?.version], ['规则来源', rules?.sourceUrl],
    ['规则采集时间', rules?.capturedAt && reviewDate(rules.capturedAt)], ['规则哈希', rules?.contentHash],
    ['报告结构', (report.result?.schema_version ?? report.report_schema_version) === 2 ? 'v2' : 'v1（历史）'],
  ];
}

export function timingFields(report: ReviewReport, job?: ReportWrapper['job']) {
  const adaptive = report.probe?.adaptive;
  return [
    ['提交时间', job?.created_at && reviewDate(job.created_at)],
    ['任务更新', job?.updated_at && reviewDate(job.updated_at)],
    ['采集方式', report.probe?.captureMethod === 'browser-viewport-v2' ? '增强试玩' : report.probe?.captureMethod === 'browser-viewport-v1' ? '基础采集' : job?.review_mode === 'basic' ? '基础采集' : job?.review_mode === 'enhanced' ? '增强试玩' : undefined],
    ['补测实际运行', numeric(adaptive?.playMs) ? duration(adaptive.playMs) : undefined],
    ['补测暂停墙钟时间（含工具和模型等待）', numeric(adaptive?.modelWaitMs) ? duration(adaptive.modelWaitMs) : undefined],
    ['补测轮次', adaptive?.rounds], ['补测动作', adaptive?.actionCount],
  ];
}

export const reportFilename = (title: string, suffix: string, extension = 'md') => `${(title || '游戏').replace(/[^\p{L}\p{N}._-]+/gu, '-')}-${suffix}.${extension}`;

export function safeShots(report: ReviewReport) {
  return list(report.shots).filter(shot => typeof shot?.data === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(shot.data));
}

export function reportText(input: ReviewReport | ReportWrapper) {
  const { report, job } = normalizeReport(input);
  const result = report.result;
  const total = reportTotal(report);
  const human = report.human_review;
  const lines = (values: [string, unknown][] | (unknown[])[]) => values.filter(([, value]) => value != null && value !== '').map(([label, value]) => `- ${label} · ${value}`).join('\n');
  const bullets = (values?: string[]) => list(values).map(value => `- ${value}`).join('\n') || '未列出。';
  return [
    `# ${report.title} · AI 模拟审核`,
    lines([...reportFields(report), ...timingFields(report, job)]),
    `总分 ${total == null ? '待复核' : `${total} / 9`} · ${result?.verdict || outcomeLabels[reportState(report)]}`,
    dimensions.map(([key, label]) => `${label} ${dimensionText(result?.[key])}`).join(' · '),
    result?.reviewer_comment,
    `## ${humanTitle(human)}\n${humanState(human)}${human?.status === 'reviewed' ? ` · ${humanScore(human)}` : ''}\n${lines(humanFields(human))}\n${human?.feedback || ''}`,
    `## 评分依据\n${lines(dimensions.map(([key, label]) => [label, result?.score_reasons?.[key] || '旧报告未单独记录评分依据']))}`,
    `## 待人工确认\n${bullets(result?.uncertainties)}`,
    `## 值得保留\n${bullets(result?.strengths)}`,
    `## 问题与体验评价\n${list(result?.issues).map((issue, index) => `${index + 1}. [${issueLabels[issue.kind || ''] || '历史问题'} · ${issue.severity}] ${issue.area} · ${issue.problem}\n   证据 · ${issue.evidence}${list(issue.evidence_refs).length ? `（${issue.evidence_refs?.join('、')}）` : ''}\n   ${issue.kind === 'unverified' ? '验证方法' : issue.kind === 'confirmed' ? '强制整改' : '建议'} · ${issue.fix}`).join('\n\n') || '未列出。'}`,
    `## 可选优化\n${bullets(result?.optional_suggestions)}`,
    `## 交给智能助手修改\n${result?.fix_prompt || '未提供修改指令。'}`,
    'AI 模拟审核基于有限证据，最终结果由人工确认。',
  ].filter(Boolean).join('\n\n').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!) + '\n';
}
