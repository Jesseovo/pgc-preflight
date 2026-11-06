export type EmbeddedTextBlock = { type: 'text'; text: string };
export type EmbeddedImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type EmbeddedToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type EmbeddedThinking = { type: 'thinking'; thinking: string; signature?: string };
export type EmbeddedRedactedThinking = { type: 'redacted_thinking'; data: string };
export type EmbeddedToolResultPart = EmbeddedTextBlock | EmbeddedImageBlock;
export type EmbeddedToolResultBlock = {
  type: 'tool_result'; tool_use_id: string; content: string | readonly EmbeddedToolResultPart[]; is_error?: boolean;
};
export type EmbeddedAssistantBlock = EmbeddedTextBlock | EmbeddedToolUse | EmbeddedThinking | EmbeddedRedactedThinking;
export type EmbeddedUserBlock = EmbeddedTextBlock | EmbeddedImageBlock | EmbeddedToolResultBlock;
export type EmbeddedBlock = EmbeddedAssistantBlock | EmbeddedUserBlock;
export type EmbeddedMessage = { role: 'assistant'; content: readonly EmbeddedAssistantBlock[] } |
  { role: 'user'; content: readonly EmbeddedUserBlock[] };

export type EmbeddedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  validateInput?(input: Record<string, unknown>): boolean;
};
export type EmbeddedNativeTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};
export type EmbeddedModelRequest = {
  kind: 'main' | 'compact';
  system: string;
  messages: readonly EmbeddedMessage[];
  tools: readonly EmbeddedNativeTool[];
  model: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  turn: number;
};
export type EmbeddedModelResponse = {
  id?: string;
  content: readonly EmbeddedAssistantBlock[];
  stopReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
};
export type EmbeddedQueryInput = {
  system: string;
  messages: readonly EmbeddedMessage[];
  tools: readonly EmbeddedTool[];
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  maxTotalOutputTokens: number;
  maxModelTurns: number;
  signal: AbortSignal;
};
export type EmbeddedQueryReason = Extract<Terminal['reason'], 'completed' | 'max_turns' | 'blocking_limit' | 'prompt_too_long' |
  'model_error' | 'aborted_streaming' | 'aborted_tools'> | 'tool_error' | 'output_limit';
export type EmbeddedQueryUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  accountedOutputTokens: number;
  modelCalls: number;
  compactionCalls: number;
};
export type EmbeddedQueryResult = {
  reason: EmbeddedQueryReason;
  finalAssistant: { role: 'assistant'; content: EmbeddedTextBlock[] } | null;
  turns: number;
  usage: EmbeddedQueryUsage;
};
export type EmbeddedQueryTransition =
  | (Extract<Continue, { reason: 'next_turn' }> & { turn: number; tools: number })
  | { reason: 'autocompact'; turn: number; compactedRounds: number };
export type EmbeddedTokenInput = Pick<EmbeddedModelRequest, 'system' | 'messages' | 'tools'>;
export type EmbeddedQueryDeps = {
  callModel(request: EmbeddedModelRequest): Promise<EmbeddedModelResponse>;
  runTool(toolUse: EmbeddedToolUse, signal: AbortSignal): Promise<{
    content: string | readonly EmbeddedToolResultPart[];
    isError?: boolean;
  }>;
  estimateTokens?(input: EmbeddedTokenInput): number;
  onTransition?(transition: EmbeddedQueryTransition): void;
};
import type { Continue, Terminal } from './transitions';

