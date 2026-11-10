/**
 * Embedded host for CCB's bounded, non-streaming-tool-execution query path.
 * All provider and workspace side effects remain behind the host callbacks.
 */
import {
  autoCompactThreshold, compactOutputLimit, compactSummary, estimateEmbeddedTokens, planCompaction, projectMessages,
  type WorkMessage, type WorkingSummary,
} from './compact';
import { assistantTools, bindTools, isRecord, runTools, untilAbort, verifySeedPairing } from './messages';
import { nextToolTurn } from './upstream';
import type {
  EmbeddedModelResponse, EmbeddedQueryDeps, EmbeddedQueryInput, EmbeddedQueryReason, EmbeddedQueryResult, EmbeddedQueryTransition,
  EmbeddedQueryUsage, EmbeddedTextBlock, EmbeddedTokenInput,
} from './types';
export type * from './types';
export { getEmbeddedExecutionPrompt } from './prompt';

type ModelStep = { response: EmbeddedModelResponse } | { reason: EmbeddedQueryReason };
type QueryState = {
  work: WorkMessage[];
  summary: WorkingSummary | null;
  previousContextTokens: number | null;
  // Same logical turn counter as query.ts. A compact call consumes its own
  // model budget while still preparing the pending main turn.
  turnCount: number;
  transition?: EmbeddedQueryTransition;
};
const normalStopReasons = new Set(['end_turn', 'stop', 'stop_sequence', 'tool_use', 'tool_calls']);
const outputLimitReasons = new Set(['max_tokens', 'length']);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const actualTokens = (value: unknown): value is number | null => value === null ||
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const addKnown = (sum: number | null, value: number | null) => sum === null || value === null ? null : sum + value;

export async function runEmbeddedQuery(input: EmbeddedQueryInput, deps: EmbeddedQueryDeps): Promise<EmbeddedQueryResult> {
  const { signal, model, system, contextWindow, maxOutputTokens, maxTotalOutputTokens, maxModelTurns } = input;
  if (typeof system !== 'string' || typeof model !== 'string' || !model.trim() ||
    ![contextWindow, maxOutputTokens, maxTotalOutputTokens, maxModelTurns].every(positive) || maxOutputTokens >= contextWindow ||
    !signal || typeof signal.throwIfAborted !== 'function' || typeof deps.callModel !== 'function' || typeof deps.runTool !== 'function') {
    throw new Error('Invalid embedded CCB query limits or host');
  }
  const seed = structuredClone(input.messages);
  const seenToolIds = verifySeedPairing(seed);
  const tools = bindTools(input.tools);
  const nativeTools = [...tools.values()].map(tool => ({ name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}), input_schema: tool.inputSchema }));
  const responseIds = new Set<string>();
  const usage: EmbeddedQueryUsage = { inputTokens: 0, outputTokens: 0, accountedOutputTokens: 0, modelCalls: 0, compactionCalls: 0 };
  let turns = 0;
  const remaining = () => maxTotalOutputTokens - usage.accountedOutputTokens;
  const outputCap = () => Math.min(maxOutputTokens, remaining());
  const stop = (reason: EmbeddedQueryReason, content?: EmbeddedTextBlock[]): EmbeddedQueryResult => ({
    reason, finalAssistant: content ? { role: 'assistant', content } : null, turns, usage: { ...usage },
  });
  const reportTransition = (event: EmbeddedQueryTransition) => {
    try { deps.onTransition?.(event); } catch { /* Telemetry is outside query state. */ }
  };
  function estimate(request: EmbeddedTokenInput) {
    try {
      const count = deps.estimateTokens ? deps.estimateTokens(structuredClone(request)) : estimateEmbeddedTokens(request);
      return Number.isSafeInteger(count) && count >= 0 ? count : Infinity;
    } catch { return Infinity; }
  }
  function estimateMain(request: EmbeddedTokenInput, previousContextTokens: number | null) {
    const estimated = estimate(request);
    if (previousContextTokens === null || !Number.isFinite(estimated)) return estimated;
    // CCB anchors to the last API usage and estimates what was appended after
    // it. Embedded batches put all unmeasured tool results in one final message.
    const beforeToolResults = estimate({ ...request, messages: request.messages.slice(0, -1) });
    return Math.max(estimated, previousContextTokens + Math.max(0, estimated - beforeToolResults));
  }
  async function call(kind: 'main' | 'compact', request: EmbeddedTokenInput, cap: number, turn: number): Promise<ModelStep> {
    if (signal.aborted) return { reason: 'aborted_streaming' };
    if (usage.modelCalls >= maxModelTurns) return { reason: 'max_turns' };
    if (cap <= 0 || cap > remaining()) return { reason: 'blocking_limit' };
    usage.modelCalls++;
    if (kind === 'compact') usage.compactionCalls++;
    else turns++;
    usage.accountedOutputTokens += cap;
    let response: EmbeddedModelResponse;
    try {
      response = await untilAbort(() => deps.callModel({ ...structuredClone(request), kind, model, maxOutputTokens: cap, signal, turn }), signal);
      if (!isRecord(response) || !isRecord(response.usage) ||
        !actualTokens(response.usage.inputTokens) || !actualTokens(response.usage.outputTokens)) throw new Error('Invalid model usage');
    } catch {
      usage.inputTokens = null;
      usage.outputTokens = null;
      return { reason: signal.aborted ? 'aborted_streaming' : 'model_error' };
    }
    usage.inputTokens = addKnown(usage.inputTokens, response.usage.inputTokens);
    usage.outputTokens = addKnown(usage.outputTokens, response.usage.outputTokens);
    if (response.usage.outputTokens !== null) usage.accountedOutputTokens += response.usage.outputTokens - cap;
    if ((response.usage.outputTokens ?? 0) > cap) return { reason: 'model_error' };
    if (outputLimitReasons.has(response.stopReason ?? '')) return { reason: 'output_limit' };
    if (!normalStopReasons.has(response.stopReason ?? '')) return { reason: 'model_error' };
    return { response };
  }

  let state: QueryState = { work: [], summary: null, previousContextTokens: null, turnCount: 1 };
  for (;;) {
    if (signal.aborted) return stop('aborted_streaming');
    if (usage.modelCalls >= maxModelTurns) return stop('max_turns');
    if (outputCap() <= 0) return stop('blocking_limit');

    // query.ts: assemble the messages for this API round, check proactive
    // compaction, and commit the replacement only before the next main call.
    const mainRequest = (): EmbeddedTokenInput => ({
      system, messages: projectMessages(seed, state.summary, state.work), tools: nativeTools,
    });
    let request = mainRequest();
    let estimated = estimateMain(request, state.previousContextTokens);
    const threshold = Math.min(autoCompactThreshold(contextWindow, outputCap()), contextWindow - outputCap());
    // Unlike the CLI, compact calls count against the host's total cap. Leave
    // room for the pending main turn before spending a call on compaction.
    if (estimated >= threshold && maxModelTurns - usage.modelCalls >= 2 && remaining() > 1) {
      const compact = planCompaction(state.work, state.summary);
      if (compact) {
        const cap = Math.min(compactOutputLimit, outputCap(), remaining() - 1, contextWindow - estimate(compact.request));
        if (cap <= 0) return stop('prompt_too_long');
        const summarized = await call('compact', compact.request, cap, state.turnCount);
        if ('reason' in summarized) return stop(summarized.reason);
        let summary: string | null;
        try {
          if (assistantTools(summarized.response.content, new Set()).needsFollowUp) return stop('model_error');
          summary = compactSummary(summarized.response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
        } catch { return stop('model_error'); }
        if (!summary) return stop('model_error');
        state = { ...state, work: compact.recent, summary: { text: summary, images: compact.images }, previousContextTokens: null,
          transition: { reason: 'autocompact', turn: state.turnCount, compactedRounds: compact.compactedRounds } };
        request = mainRequest();
        const compressed = estimate(request);
        if (compressed >= estimated) return stop('prompt_too_long');
        estimated = compressed;
        reportTransition(state.transition!);
      }
    }
    if (estimated + outputCap() > contextWindow) return stop('blocking_limit');
    const modeled = await call('main', request, outputCap(), state.turnCount);
    if ('reason' in modeled) return stop(modeled.reason);

    const { response } = modeled;
    let assistant: WorkMessage & { type: 'assistant' }, continuation;
    try {
      const content = structuredClone(response.content);
      continuation = assistantTools(content, seenToolIds);
      if (response.id !== undefined && (typeof response.id !== 'string' || !response.id || responseIds.has(response.id))) {
        return stop('model_error');
      }
      if (response.id !== undefined) responseIds.add(response.id);
      // Preserve provider ID boundaries without letting a provider ID collide
      // with the local substitute used when the protocol supplies no ID.
      const id = response.id === undefined ? 'turn:' + state.turnCount : 'provider:' + response.id;
      assistant = { type: 'assistant', message: { id }, wire: { role: 'assistant', content } };
    } catch { return stop('model_error'); }

    // query.ts: actual tool_use blocks, not stop_reason, determine whether
    // another round is needed. Stage-specific deliverables are checked by the host.
    const { needsFollowUp, toolUseBlocks } = continuation;
    if (!needsFollowUp) {
      const content = assistant.wire.content.filter((block): block is EmbeddedTextBlock => block.type === 'text')
        .map(block => ({ type: 'text' as const, text: block.text }));
      return stop('completed', content);
    }
    const { results, fatal } = await runTools(toolUseBlocks, tools, deps.runTool, signal);
    if (signal.aborted) return stop('aborted_tools');
    if (fatal) return stop('tool_error');
    const advanced = nextToolTurn<WorkMessage>(state.work, [assistant], [{ type: 'user', wire: { role: 'user', content: results } }],
      state.turnCount, maxModelTurns);
    if ('reason' in advanced) return stop(advanced.reason);
    const { inputTokens, outputTokens } = response.usage;
    const contextTokens = addKnown(inputTokens, outputTokens);
    const next: QueryState = {
      ...state,
      work: advanced.messages,
      turnCount: advanced.turnCount,
      previousContextTokens: contextTokens && Number.isSafeInteger(contextTokens) ? contextTokens : null,
      transition: { ...advanced.transition, turn: advanced.turnCount, tools: toolUseBlocks.length },
    };
    reportTransition(next.transition!);
    state = next;
  }
}
