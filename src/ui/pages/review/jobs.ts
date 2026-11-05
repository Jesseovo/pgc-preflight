import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { scheduleRead } from '../../lib/polling';
import { consumePrefetched, peekResource } from '../../lib/navigation-data';
import type { HumanReview } from './report-data';

export type ReviewJob = {
  id: string; title: string; filename?: string; status: string; stage?: string; model_executor?: string;
  error?: string; model?: string; result_id?: number | null; created_at?: string; updated_at?: string;
  review_mode?: string; report_schema_version?: number; input_hash?: string; artifactVersionId?: string;
  quota_charged?: number; human_review?: HumanReview | null;
};

const endpoint = '/api/forge/review/jobs';
export const runningJob = (job: ReviewJob) => job.status === 'queued' || job.status === 'running';
export const endedJob = (job: ReviewJob) => job.status === 'done' || job.status === 'error';
export const activelyWorking = (job: ReviewJob, now = Date.now()) => job.status === 'running' &&
  (job.model_executor !== 'agent' || (job.stage === 'capture' && now - Date.parse(job.updated_at || '') < 180_000));
export const agentWaiting = (job: ReviewJob) => job.model_executor === 'agent' && runningJob(job) && !activelyWorking(job);

export function stageLabel(job: ReviewJob, disconnected = false) {
  if (job.status === 'done') return '已完成';
  if (job.status === 'error') return '未完成';
  if (disconnected) return '状态暂不可用';
  if (agentWaiting(job)) {
    if (job.stage === 'verify') return '等待 Agent 复核结果';
    if (job.stage === 'review') return '等待 Agent 初评结果';
    return job.status === 'queued' ? '等待 Agent 领取' : '等待 Agent 继续采集';
  }
  if (job.status === 'queued') return '等待采集';
  if (job.stage === 'capture') return '采集画面';
  if (job.stage === 'verify') return '模型复核';
  return '模型初评';
}

export function resumePrompt(job: ReviewJob) {
  return `请重新阅读 ${location.origin}/agent.md 并更新审核工具，继续我已有的审核任务 ${job.id}（${job.title}）。沿用原任务编号，先用 status 查询。capture 阶段继续采集。review 阶段读取 material 和全部已锁定原图，用你自己的模型完成初评并提交 draft。verify 阶段用初评的同一模型复核同一证据和草稿，再 complete 回传报告。数据库暂不可用时保留本地结果，稍后用原请求重传。确实无法执行时，说明原因并用 fail 明确结束。最后读取 report 确认已保存。`;
}

export function useReviewJobs(onCompletion: () => void, enabled: boolean) {
  const [jobs, setJobs] = useState<ReviewJob[] | undefined>(() => enabled ? peekResource<ReviewJob[]>(endpoint) : undefined);
  const firstRead = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let controller: AbortController | undefined;
    let cancelRead: (() => void) | undefined;
    let last: ReviewJob[] | undefined;
    let failures = 0;
    const read = async () => {
      cancelRead = undefined;
      if (document.hidden || controller || disposed || !navigator.onLine) return;
      controller = new AbortController();
      try {
        const prepared = firstRead.current ? consumePrefetched<ReviewJob[]>(endpoint) : undefined;
        firstRead.current = false;
        const rows = prepared ?? await api<ReviewJob[]>(endpoint, { signal: controller.signal });
        if (disposed) return;
        if (!Array.isArray(rows)) throw new Error('审核服务返回了无效的任务列表。');
        const previousStatus = new Map(last?.map(job => [job.id, job.status]));
        if (last && rows.some(job => job.status === 'done' && previousStatus.get(job.id) !== 'done')) onCompletion();
        last = rows;
        failures = 0;
        setJobs(rows);
        if (navigator.onLine) setError(null);
      } catch (failure) {
        if (!disposed) {
          failures++;
          setError((failure as Error).message || '暂时无法读取任务。');
        }
      } finally {
        controller = undefined;
        if (!disposed) {
          const interval = failures ? Math.min(60_000, 15_000 * 2 ** (failures - 1)) :
            last?.some(job => activelyWorking(job)) ? 10_000 : 60_000;
          cancelRead = scheduleRead(() => void read(), interval);
        }
      }
    };
    const wake = () => {
      cancelRead?.();
      cancelRead = controller ? undefined : scheduleRead(() => void read(), 0);
    };
    const disconnect = () => setError('网络连接已断开。');
    if (!navigator.onLine) disconnect();
    wake();
    window.addEventListener('online', wake);
    window.addEventListener('offline', disconnect);
    return () => {
      disposed = true;
      cancelRead?.();
      controller?.abort();
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', disconnect);
    };
  }, [revision, onCompletion, enabled]);

  return { jobs, setJobs, error, refresh };
}

export const jobPath = (id: string) => `${endpoint}/${encodeURIComponent(id)}`;
