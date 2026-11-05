import type { ThinkingEffort } from '../src/model-options';
import type { ModelProtocol, ModelPurpose } from './settings';

export const HARNESS_CCB_COMMIT = '963e0013184ecc1521289a0fc7d5da4bb6e45356';
const imageReference = /^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9]+(?:(?:[._/]|__|-+)[a-z0-9]+)*@sha256:[a-f0-9]{64}$/;
export function isHarnessImage(value: unknown, accountId?: string): value is string {
  return typeof value === 'string' && value === value.trim() && imageReference.test(value) &&
    (accountId === undefined || value.startsWith(`registry.cloudflare.com/${accountId}/`));
}
export const HARNESS_MAX_TASK_MS = 40 * 60_000;
export const HARNESS_MAX_REQUEST_MS = 12 * 60_000;
export const HARNESS_MAX_REQUEST_TOKENS = 64_000;
export const HARNESS_MAX_TOTAL_TOKENS = 256_000;
export const HARNESS_MAX_TURNS = 24;
export const HARNESS_MAX_REPAIRS = 2;
export const HARNESS_MODEL_HEADERS = {
  task: 'x-pgc-harness-task',
  generation: 'x-pgc-harness-generation',
  requestId: 'x-pgc-harness-request-id',
} as const;

export interface HarnessModelPolicy {
  purpose: ModelPurpose;
  protocol: ModelProtocol;
  model: string;
  effort: ThinkingEffort;
  vision: boolean;
  maxOutputTokens: number;
}
export interface LockedHarnessModel extends HarnessModelPolicy {
  profileId: string;
  profileHash: string;
}
export interface HarnessRunIdentity {
  taskId: string;
  generation: string;
}

export type HarnessFailureCode =
  | 'authorization_revoked' | 'profile_unavailable' | 'deadline' | 'capacity'
  | 'provider_redirect' | 'provider_rejected' | 'provider_unknown' | 'stream_error'
  | 'stream_incomplete' | 'stream_invalid' | 'stream_limit' | 'output_truncated'
  | 'output_rejected' | 'client_disconnected' | 'interrupted' | 'runtime_failed';
export type HarnessFinishReason =
  | 'end_turn' | 'tool_use' | 'stop_sequence' | 'max_tokens' | 'refusal' | 'pause_turn'
  | 'stop' | 'tool_calls' | 'function_call' | 'length' | 'content_filter';
