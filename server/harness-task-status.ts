import { publicHarnessPolicy } from './harness-policy';
import type { HarnessFailureCode } from './harness-protocol';

import type { PublicHarnessUsage } from '../src/harness-status';
export type { PublicHarnessUsage } from '../src/harness-status';

type TaskRow = { id: string; owner_id?: string; harness_policy?: string | null };
type RunRow = {
  task_id: string; owner_id: string; status: PublicHarnessUsage['status']; failure_code: HarnessFailureCode | null;
  started_at: number; ended_at: number | null; model_turns: number; output_tokens: number; reserved_tokens: number;
};
type Database = { prepare(query: string): { bind(...values: unknown[]): { all<T>(): Promise<{ results?: T[] }> } } };

export function publicHarnessFields(rawPolicy: string | null | undefined, usage?: PublicHarnessUsage) {
  const policy = rawPolicy ? publicHarnessPolicy(rawPolicy) : null;
  if (!policy) return {};
  const { maxOutputTokens, maxTotalOutputTokens, maxModelTurns, maxDurationMs, maxRepairs } = policy.limits;
  return { harness: { version: policy.version, engine: policy.engine,...(policy.engine==='ccb-embedded'?{coreVersion:policy.coreVersion}:{}),
    limits: { maxOutputTokens, maxTotalOutputTokens, maxModelTurns, maxDurationMs, maxRepairs }, usage: usage ?? null } };
}

/** The supplied task rows have already passed the caller's ownership check. */
export async function readPublicHarnessUsage(DB: Database, family: 'forge' | 'review', tasks: readonly TaskRow[]) {
  const owners = new Map(tasks.filter(task => task.harness_policy && task.owner_id).map(task => [task.id, task.owner_id]));
  const ids = [...owners.keys()];
  const summaries = new Map<string, PublicHarnessUsage>();
  for (let start = 0; start < ids.length; start += 90) {
    const group = ids.slice(start, start + 90);
    // Only actual dispatch attempts count in the public view. The internal
    // budget also counts reservations that stopped before provider dispatch.
    const batch = await DB.prepare(`SELECT r.task_id,r.owner_id,r.status,r.failure_code,r.started_at,r.ended_at,r.output_tokens,r.reserved_tokens,
      coalesce((SELECT sum(q.attempts) FROM harness_requests q WHERE q.task_id=r.task_id AND q.generation=r.generation),0) AS model_turns
      FROM harness_runs r WHERE r.family=? AND r.task_id IN (${group.map(() => '?').join(',')})`)
      .bind(family,...group).all<RunRow>().catch(() => null);
    for (const run of batch?.results ?? []) {
      if (owners.get(run.task_id) !== run.owner_id) continue;
      summaries.set(run.task_id, {
        status: run.status, failureCode: run.failure_code, startedAt: run.started_at, endedAt: run.ended_at,
        modelTurns: run.model_turns, outputTokens: run.output_tokens, reservedTokens: run.reserved_tokens,
      });
    }
  }
  return summaries;
}

/** Keep the narrow list projection usable while migrating legacy databases. */
export async function withOptionalHarnessPolicy<T>(read: (projection: string) => Promise<T>): Promise<T> {
  try {
    return await read(',harness_policy');
  } catch (error) {
    if (!/no such column:\s*(?:[a-z]+\.)?harness_policy\b/i.test(String(error))) throw error;
    return read('');
  }
}
