import { inferenceOptions } from '../src/model-options';
import type { ModelThrottleDatabase } from './model-throttle';
import { activeModelProfile, modelProfiles, type ModelConfig, type ModelPurpose, type StoredModelProfile } from './settings';
import {
  HARNESS_MAX_REPAIRS, HARNESS_MAX_REQUEST_MS, HARNESS_MAX_REQUEST_TOKENS, HARNESS_MAX_TASK_MS, HARNESS_MAX_TOTAL_TOKENS, HARNESS_MAX_TURNS,
  type HarnessFailureCode, type HarnessFinishReason, type HarnessModelPolicy, type HarnessRunIdentity, type LockedHarnessModel,
} from './harness-protocol';

type LedgerStatement = {
  bind(...values: unknown[]): LedgerStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
};
export interface HarnessDatabase extends ModelThrottleDatabase {
  prepare(sql: string): LedgerStatement;
}

type RunStatus = 'active' | 'done' | 'failed' | 'unknown';
export interface HarnessRun extends HarnessRunIdentity {
  ownerId: string;
  actor: 'star' | 'admin';
  family: 'forge' | 'review';
  sourceHash: string;
  snapshotHash: string;
  model: LockedHarnessModel;
  slot: 1 | 2;
  status: RunStatus;
  failureCode: HarnessFailureCode | null;
  startedAt: number;
  deadlineAt: number;
  endedAt: number | null;
  releasedAt: number | null;
  maxModelTurns: number;
  maxRepairs: number;
  maxTotalOutputTokens: number;
  modelTurns: number;
  outputTokens: number;
  reservedTokens: number;
}
type RunRow = {
  task_id: string; generation: string; owner_id: string; actor: HarnessRun['actor']; family: HarnessRun['family'];
  source_hash: string; snapshot_hash: string; profile_id: string; profile_hash: string; purpose: ModelPurpose;
  protocol: HarnessModelPolicy['protocol']; model: string; effort: HarnessModelPolicy['effort']; vision: number;
  per_request_cap: number; slot: HarnessRun['slot']; status: RunStatus; failure_code: HarnessFailureCode | null;
  started_at: number; deadline_at: number; ended_at: number | null; released_at: number | null;
  max_repairs: number; max_model_turns: number; total_output_cap: number; model_turns: number; output_tokens: number; reserved_tokens: number; lease_hash: string;
};
const runFields = `task_id,generation,owner_id,actor,family,source_hash,snapshot_hash,profile_id,profile_hash,purpose,
 protocol,model,effort,vision,per_request_cap,slot,status,failure_code,started_at,deadline_at,ended_at,released_at,
 max_repairs,max_model_turns,total_output_cap,model_turns,output_tokens,reserved_tokens`;
const encoder = new TextEncoder();
const hashPattern = /^[a-f0-9]{64}$/;
export const harnessIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

export async function harnessSha256(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toRun(row: RunRow): HarnessRun {
  return {
    taskId: row.task_id, generation: row.generation, ownerId: row.owner_id, actor: row.actor, family: row.family,
    sourceHash: row.source_hash, snapshotHash: row.snapshot_hash,
    model: {
      profileId: row.profile_id, profileHash: row.profile_hash, purpose: row.purpose, protocol: row.protocol,
      model: row.model, effort: row.effort, vision: Boolean(row.vision), maxOutputTokens: row.per_request_cap,
    },
    slot: row.slot, status: row.status, failureCode: row.failure_code, startedAt: row.started_at,
    deadlineAt: row.deadline_at, endedAt: row.ended_at, releasedAt: row.released_at,
    maxRepairs: row.max_repairs, maxModelTurns: row.max_model_turns, maxTotalOutputTokens: row.total_output_cap, modelTurns: row.model_turns, outputTokens: row.output_tokens, reservedTokens: row.reserved_tokens,
  };
}

async function profileHash(profile: StoredModelProfile): Promise<string> {
  return harnessSha256(JSON.stringify([
    profile.baseUrl, profile.model, profile.protocol, profile.encryptedKey, profile.enabled,
    profile.vision !== false, profile.effort ?? 'auto', profile.maxOutputTokens ?? 0,
  ]));
}

export async function lockHarnessModel(config: ModelConfig | null, purpose: ModelPurpose, existingMaxTokens?: number): Promise<LockedHarnessModel | null> {
  const selected = activeModelProfile(config, purpose);
  if (!selected?.profile.enabled || !selected.profile.encryptedKey) return null;
  const { profile } = selected;
  const inferred = inferenceOptions(profile, purpose, purpose === 'game' ? HARNESS_MAX_REQUEST_TOKENS : existingMaxTokens);
  if (purpose === 'game' && inferred.capability.kind !== 'adaptive') return null;
  return {
    profileId: selected.id, profileHash: await profileHash(profile), purpose, protocol: profile.protocol, model: profile.model,
    effort: purpose === 'game' ? 'high' : inferred.effort, vision: profile.vision !== false,
    maxOutputTokens: Math.min(HARNESS_MAX_REQUEST_TOKENS, inferred.maxTokens),
  };
}

export async function readLockedHarnessProfile(config: ModelConfig | null, policy: LockedHarnessModel): Promise<StoredModelProfile | null> {
  const profile = modelProfiles(config)[policy.profileId];
  if (!profile?.enabled || !profile.encryptedKey || !sameDigest(await profileHash(profile), policy.profileHash)) return null;
  return profile;
}

export async function createHarnessRun(db: HarnessDatabase, input: HarnessRunIdentity & {
  ownerId: string; actor: HarnessRun['actor']; sourceHash: string; snapshot: unknown; model: LockedHarnessModel; now?: number;
  deadlineAt?: number; family?: HarnessRun['family'];
  limits?: { maxTotalOutputTokens: number; maxModelTurns: number; maxRepairs?: number };
}): Promise<{ run: HarnessRun; lease: string } | null> {
  if (!harnessIdentifier(input.taskId) || !harnessIdentifier(input.generation) || !harnessIdentifier(input.ownerId) ||
      !hashPattern.test(input.sourceHash)) throw new Error('Invalid harness identity');
  const snapshot = JSON.stringify(input.snapshot);
  if (!snapshot || encoder.encode(snapshot).length > 64 * 1024) throw new Error('Invalid harness snapshot');
  const lease = hex(crypto.getRandomValues(new Uint8Array(32)));
  const [leaseHash, snapshotHash] = await Promise.all([harnessSha256(lease), harnessSha256(snapshot)]);
  const now = input.now ?? Date.now();
  const deadline = Math.min(input.deadlineAt ?? Infinity, now + HARNESS_MAX_TASK_MS);
  if (deadline <= now) return null;
  const model = input.model;
  const family = input.family ?? (model.purpose === 'review' || model.purpose === 'review_verify' ? 'review' : 'forge');
  const row = await db.prepare(`WITH slots(slot) AS (VALUES (1),(2)), next_slot AS (
    SELECT slot FROM slots WHERE NOT EXISTS (SELECT 1 FROM harness_runs WHERE harness_runs.slot=slots.slot AND released_at IS NULL)
    ORDER BY slot LIMIT 1
  ) INSERT INTO harness_runs (task_id,generation,owner_id,actor,family,source_hash,snapshot_hash,snapshot,profile_id,
    profile_hash,purpose,protocol,model,effort,vision,per_request_cap,total_output_cap,max_model_turns,max_repairs,lease_hash,started_at,deadline_at,slot)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,slot FROM next_slot WHERE 1
    ON CONFLICT DO NOTHING RETURNING ${runFields}`)
    .bind(input.taskId,input.generation,input.ownerId,input.actor,family,input.sourceHash,snapshotHash,snapshot,model.profileId,
      model.profileHash,model.purpose,model.protocol,model.model,model.effort,Number(model.vision),model.maxOutputTokens,
      input.limits?.maxTotalOutputTokens ?? HARNESS_MAX_TOTAL_TOKENS,input.limits?.maxModelTurns ?? HARNESS_MAX_TURNS,
      input.limits?.maxRepairs ?? (model.purpose === 'game' ? HARNESS_MAX_REPAIRS : 0),leaseHash,now,deadline).first<RunRow>();
  return row ? { run: toRun(row), lease } : null;
}

export async function getHarnessRun(db: HarnessDatabase, id: HarnessRunIdentity): Promise<HarnessRun | null> {
  const row = await db.prepare(`SELECT ${runFields} FROM harness_runs WHERE task_id=? AND generation=?`)
    .bind(id.taskId, id.generation).first<RunRow>();
  return row ? toRun(row) : null;
}

export async function getHarnessRunSummary(db: HarnessDatabase, id: HarnessRunIdentity) {
  const run = await getHarnessRun(db, id);
  if (!run) return null;
  const { status, failureCode, startedAt, deadlineAt, endedAt, modelTurns, outputTokens, reservedTokens } = run;
  return { status, failureCode, startedAt, deadlineAt, endedAt, modelTurns, outputTokens, reservedTokens };
}

export async function hasCompletedHarnessPhaseRequest(db: HarnessDatabase, id: HarnessRunIdentity, requestIdPrefix: string) {
  if (!harnessIdentifier(requestIdPrefix)) return false;
  const row = await db.prepare(`SELECT 1 AS found FROM harness_requests
    WHERE task_id=? AND generation=? AND state='completed' AND substr(request_id,1,?)=? LIMIT 1`)
    .bind(id.taskId,id.generation,requestIdPrefix.length,requestIdPrefix).first<{ found: number }>();
  return row !== null;
}

export async function authorizeHarnessLease(db: HarnessDatabase, id: HarnessRunIdentity, lease: string, options: {
  authorizeRun: (run: HarnessRun) => Promise<boolean>; now?: number;
}): Promise<HarnessRun | null> {
  if (!harnessIdentifier(id.taskId) || !harnessIdentifier(id.generation) || !hashPattern.test(lease)) return null;
  const [row, hash] = await Promise.all([
    db.prepare(`SELECT ${runFields},lease_hash FROM harness_runs WHERE task_id=? AND generation=?`)
      .bind(id.taskId, id.generation).first<RunRow>(),
    harnessSha256(lease),
  ]);
  if (!row || !sameDigest(row.lease_hash, hash) || row.status !== 'active' || row.deadline_at <= (options.now ?? Date.now())) return null;
  const run = toRun(row);
  return await options.authorizeRun(run) ? run : null;
}

export async function endHarnessRun(db: HarnessDatabase, id: HarnessRunIdentity, outcome: 'done' | 'failed',
  failureCode: HarnessFailureCode = 'runtime_failed', now = Date.now()): Promise<boolean> {
  const row = await db.prepare(`UPDATE harness_runs SET
    status=CASE WHEN ?='failed' AND EXISTS (SELECT 1 FROM harness_requests
      WHERE task_id=? AND generation=? AND state='forwarded') THEN 'unknown' ELSE ? END,
    failure_code=?,ended_at=?
    WHERE task_id=? AND generation=? AND status='active' AND (
      ?='failed' OR (deadline_at>? AND model_turns>0 AND reserved_tokens=0)
    ) RETURNING task_id`)
    .bind(outcome,id.taskId,id.generation,outcome,outcome === 'failed' ? failureCode : null,
      now,id.taskId,id.generation,outcome,now).first<{ task_id: string }>();
  if (outcome === 'failed') {
    await db.prepare(`UPDATE harness_requests SET state=CASE WHEN state='forwarded' THEN 'unknown' ELSE 'failed' END,
      error_code=?,finished_at=? WHERE task_id=? AND generation=? AND state IN ('reserved','forwarded')`)
      .bind(failureCode, now, id.taskId, id.generation).run();
  }
  if (row) return true;
  const current = await getHarnessRun(db, id);
  return outcome === 'done' ? current?.status === 'done' : current?.status === 'failed' || current?.status === 'unknown';
}

// Call only after the container host confirms this run's container is gone.
export async function releaseHarnessSlot(db: HarnessDatabase, id: HarnessRunIdentity, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE harness_runs SET released_at=? WHERE task_id=? AND generation=? AND status!='active' AND released_at IS NULL")
    .bind(now, id.taskId, id.generation).run();
}

type HarnessEvent = 'started' | 'booted' | 'browser' | 'repair' | 'artifact' | 'cleanup';
export async function recordHarnessEvent(db: HarnessDatabase, id: HarnessRunIdentity, event: HarnessEvent,
  value: number | null = null, now = Date.now()): Promise<boolean> {
  if (event === 'repair' && value !== 1 && value !== 2) return false;
  const row = await db.prepare(`INSERT INTO harness_events(task_id,generation,event,value,created_at)
    SELECT task_id,generation,?,?,? FROM harness_runs WHERE task_id=? AND generation=?
    AND (?='cleanup' OR (status='active' AND deadline_at>?))
    AND (?!='repair' OR (?<=max_repairs AND ?=1+(SELECT count(*) FROM harness_events WHERE task_id=? AND generation=? AND event='repair')))
    RETURNING id`)
    .bind(event,value,now,id.taskId,id.generation,event,now,event,value,value,id.taskId,id.generation).first<{ id: number }>();
  return row !== null;
}

type RequestState = 'reserved' | 'forwarded' | 'completed' | 'failed' | 'unknown';
export interface HarnessRequestIdentity extends HarnessRunIdentity { requestId: string }
interface RequestRow { body_hash: string; state: RequestState; deadline_at: number }

export async function reserveHarnessRequest(db: HarnessDatabase, id: HarnessRequestIdentity, bodyHash: string,
  outputCap: number, now = Date.now(), requestStartedAt = now, allowedUntil = Infinity): Promise<
  { status: 'reserved'; deadlineAt: number; outputCap: number } |
  { status: 'duplicate'; previous: RequestState } |
  { status: 'conflict' | 'blocked' }
> {
  // A crash after forwarding must latch the old request before accepting new IDs.
  await db.prepare(`UPDATE harness_requests SET state=CASE WHEN state='forwarded' THEN 'unknown' ELSE 'failed' END,
    error_code='deadline',finished_at=? WHERE task_id=? AND generation=? AND deadline_at<=? AND state IN ('reserved','forwarded')`)
    .bind(now,id.taskId,id.generation,now).run();
  const requestDeadline = Math.min(requestStartedAt + HARNESS_MAX_REQUEST_MS, allowedUntil);
  const row = await db.prepare(`INSERT INTO harness_requests(task_id,generation,request_id,body_hash,output_cap,created_at,deadline_at)
    SELECT task_id,generation,?,?,min(?,total_output_cap-output_tokens-reserved_tokens),?,min(deadline_at,?)
    FROM harness_runs WHERE task_id=? AND generation=? AND status='active' AND deadline_at>? AND model_turns<max_model_turns
    AND ?>0 AND ?<=per_request_cap AND output_tokens+reserved_tokens<total_output_cap AND ?>?
    ON CONFLICT DO NOTHING RETURNING deadline_at,output_cap`)
    .bind(id.requestId,bodyHash,outputCap,requestStartedAt,requestDeadline,id.taskId,id.generation,now,
      outputCap,outputCap,requestDeadline,now).first<{ deadline_at: number; output_cap: number }>();
  if (row) return { status: 'reserved', deadlineAt: row.deadline_at, outputCap: row.output_cap };
  const previous = await db.prepare('SELECT body_hash,state,deadline_at FROM harness_requests WHERE task_id=? AND generation=? AND request_id=?')
    .bind(id.taskId,id.generation,id.requestId).first<RequestRow>();
  if (!previous) return { status: 'blocked' };
  return previous.body_hash === bodyHash ? { status: 'duplicate', previous: previous.state } : { status: 'conflict' };
}

export async function forwardHarnessRequest(db: HarnessDatabase, id: HarnessRequestIdentity, now = Date.now()): Promise<boolean> {
  const row = await db.prepare(`UPDATE harness_requests SET state='forwarded',forwarded_at=?,attempts=attempts+1
    WHERE task_id=? AND generation=? AND request_id=? AND state='reserved' AND deadline_at>? AND attempts<2
    AND EXISTS (SELECT 1 FROM harness_runs WHERE task_id=? AND generation=? AND status='active'
      AND (harness_requests.attempts=0 OR model_turns<max_model_turns))
    RETURNING request_id`).bind(now,id.taskId,id.generation,id.requestId,now,id.taskId,id.generation).first<{ request_id: string }>();
  return row !== null;
}

// Only the owner of the original in-flight request may reuse its idempotency
// key, after an explicit provider rejection known to precede execution.
export async function rearmHarnessRequest(db: HarnessDatabase, id: HarnessRequestIdentity): Promise<boolean> {
  const row = await db.prepare(`UPDATE harness_requests SET state='reserved'
    WHERE task_id=? AND generation=? AND request_id=? AND state='forwarded' AND attempts=1
    RETURNING request_id`).bind(id.taskId,id.generation,id.requestId).first<{ request_id: string }>();
  return row !== null;
}

interface RequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  characters?: number;
  finishReason?: HarnessFinishReason;
}
export async function finishHarnessRequest(db: HarnessDatabase, id: HarnessRequestIdentity, outcome: {
  state: 'completed' | 'failed' | 'unknown'; errorCode?: HarnessFailureCode; httpStatus?: number; firstResponseMs?: number;
} & RequestUsage, now = Date.now()): Promise<boolean> {
  const row = await db.prepare(`UPDATE harness_requests SET state=?,finished_at=?,http_status=?,first_response_ms=?,
    input_tokens=?,output_tokens=?,reasoning_tokens=?,characters=?,finish_reason=?,error_code=?
    WHERE task_id=? AND generation=? AND request_id=?
    AND (state='forwarded' OR (state='reserved' AND ?='failed'))
    AND (?!='completed' OR deadline_at>?) RETURNING request_id`)
    .bind(outcome.state,now,outcome.httpStatus??null,outcome.firstResponseMs??null,outcome.inputTokens??null,
      outcome.outputTokens??null,outcome.reasoningTokens??null,outcome.characters??null,outcome.finishReason??null,outcome.errorCode??null,
      id.taskId,id.generation,id.requestId,outcome.state,outcome.state,now).first<{ request_id: string }>();
  return row !== null;
}
