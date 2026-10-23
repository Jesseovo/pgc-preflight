import type { CheckInput } from '../src/types';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_BATCH = 20;
export const RESOURCE_HOSTS = new Set([
  'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'esm.sh',
  'cdn.tailwindcss.com', 'threejs.org', 'ajax.googleapis.com',
]);
export function resourceAllowed(raw: string): boolean {
  if (/^(data:|blob:|about:blank$)/i.test(raw)) return true;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (!url.port || url.port === '443') && RESOURCE_HOSTS.has(url.hostname);
  } catch { return false; }
}
export function validateInput(value: unknown): CheckInput {
  if (!value || typeof value !== 'object') throw new Error('请选择 HTML 游戏文件。');
  const input = value as Record<string, unknown>;
  if (typeof input.filename !== 'string' || !/\.html?$/i.test(input.filename)) throw new Error('仅支持 .html 或 .htm 文件。');
  if (input.filename.length > 180) throw new Error('文件名过长，请缩短后重试。');
  if (typeof input.html !== 'string' || !input.html.trim()) throw new Error('文件内容为空。');
  if (new TextEncoder().encode(input.html).length > MAX_FILE_BYTES) throw new Error('单个文件不能超过 8 MB。');
  if (!/<(?:!doctype\s+html|html|head|body|canvas|script|div|main|button)\b/i.test(input.html)) throw new Error('没有识别到 HTML 页面内容，请检查文件。');
  if (input.instructions !== undefined && typeof input.instructions !== 'string') throw new Error('操作说明格式不正确。');
  if (typeof input.instructions === 'string' && input.instructions.length > 1000) throw new Error('操作说明请控制在 1000 字以内。');
  return { filename: input.filename, html: input.html, instructions: input.instructions as string | undefined };
}
export function makeReportText(report: import('../src/types').CheckReport): string {
  const labels = { pass: '基础检查通过，待人工审核', issue: '发现基础问题', review: '需人工确认' };
  return [
    `# ${report.filename} · ${labels[report.status]}`,
    `检查时间：${report.startedAt}｜用时 ${(report.durationMs / 1000).toFixed(1)} 秒`,
    '', ...report.findings.map(item => `- [${{ pass: '正常', issue: '问题', review: '待确认' }[item.status]}] ${item.title}\n  ${item.detail}${item.steps ? `\n  复现：${item.steps}` : ''}`),
    '', '## 未覆盖', ...report.uncovered.map(item => `- ${item}`),
    '', '本报告仅检查基础故障；操作手感、画面美感、玩法趣味性和最终审核由人工判断。',
  ].join('\n');
}
