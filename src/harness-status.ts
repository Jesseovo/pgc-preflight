export interface PublicHarnessUsage {
  outputTokens: number;
  modelTurns: number;
  reservedTokens: number;
  status: 'active' | 'done' | 'failed' | 'unknown';
  failureCode: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface PublicHarnessTask {
  engine: 'ccb';
  usage: PublicHarnessUsage | null;
}

export function harnessUsageLabel(harness: PublicHarnessTask): string {
  const usage = harness.usage;
  if (!usage) return '模型用量待记录';
  const unknown = usage.status === 'unknown' ? ' · 另有请求用量未知' : '';
  return `已确认输出 ${usage.outputTokens.toLocaleString('zh-CN')} Token · 已提交 ${usage.modelTurns} 个模型请求${unknown}`;
}
