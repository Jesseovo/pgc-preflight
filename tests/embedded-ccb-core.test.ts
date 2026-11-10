import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getEmbeddedExecutionPrompt, runEmbeddedQuery, type EmbeddedAssistantBlock, type EmbeddedImageBlock, type EmbeddedModelRequest,
  type EmbeddedModelResponse, type EmbeddedQueryDeps, type EmbeddedQueryInput,
} from '../server/embedded-ccb';
import { compactSummary } from '../server/embedded-ccb/compact';
import { verifySeedPairing } from '../server/embedded-ccb/messages';
import { groupMessagesByApiRound, partitionToolCalls } from '../server/embedded-ccb/upstream';
import provenance from '../docs/ccb-embedded-core-provenance.json';
import frozenUpstream from './fixtures/embedded-ccb-upstream.json';

const text = (value: string) => ({ type: 'text' as const, text: value });
const tool = (name: string, id: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use' as const, id, name, input });
const reply = (content: EmbeddedAssistantBlock[], stopReason = 'end_turn', outputTokens: number | null = 4,
  id?: string): EmbeddedModelResponse => ({ content, stopReason, usage: { inputTokens: 7, outputTokens }, id });
function request(extra: Partial<EmbeddedQueryInput> = {}): EmbeddedQueryInput {
  return { system: 'same task system', model: 'one-locked-model', contextWindow: 100_000,
    maxOutputTokens: 100, maxTotalOutputTokens: 400, maxModelTurns: 8, signal: new AbortController().signal,
    messages: [{ role: 'user', content: [text('Original immutable task')] }],
    tools: [
      { name: 'read', inputSchema: { type: 'object' }, readOnly: true },
      { name: 'write', inputSchema: { type: 'object' } },
    ], ...extra };
}
function mockHost(...responses: EmbeddedModelResponse[]) {
  const callModel = vi.fn<EmbeddedQueryDeps['callModel']>();
  for (const response of responses) callModel.mockResolvedValueOnce(response);
  const runTool = vi.fn<EmbeddedQueryDeps['runTool']>(async () => ({ content: 'workspace data' }));
  return { callModel, runTool };
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn(() => { throw new Error('No provider or network calls'); });
  vi.stubGlobal('fetch', network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('follows native tool blocks with signed thinking intact and merges read results in upstream completion order', async () => {
  const thinking = { type: 'thinking' as const, thinking: 'private upstream thought', signature: 'native-signature' };
  const redacted = { type: 'redacted_thinking' as const, data: 'opaque-native-block' };
  const firstBlocks = [thinking, redacted, tool('read', 'slow'), tool('read', 'fast'), tool('write', 'write'),
    tool('read', 'after'), tool('missing', 'missing')];
  const host = mockHost(reply(firstBlocks, 'end_turn', 5, 'assistant-1'),
    reply([thinking, text('Finished exact result')], 'tool_use', 9, 'assistant-2'));
  const slow = gate(), bothReads = gate(), order: string[] = [];
  host.runTool.mockImplementation(async use => {
    order.push(use.id);
    if (use.id === 'slow') await slow.wait;
    if (use.id === 'fast') bothReads.release();
    return { content: use.id };
  });
  const onTransition = vi.fn();
  const running = runEmbeddedQuery(request(), { ...host, onTransition });
  await bothReads.wait;
  expect(order).toEqual(['slow', 'fast']);
  await Promise.resolve();
  slow.release();
  const finished = await running;
  expect(order).toEqual(['slow', 'fast', 'write', 'after']);
  expect(host.callModel).toHaveBeenCalledTimes(2);
  const next = host.callModel.mock.calls[1][0];
  expect(next.messages).toEqual([
    { role: 'user', content: [text('Original immutable task')] }, { role: 'assistant', content: firstBlocks },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'fast', content: 'fast' }, { type: 'tool_result', tool_use_id: 'slow', content: 'slow' },
      { type: 'tool_result', tool_use_id: 'write', content: 'write' }, { type: 'tool_result', tool_use_id: 'after', content: 'after' },
      { type: 'tool_result', tool_use_id: 'missing', content: '<tool_use_error>Error: No such tool available: missing</tool_use_error>', is_error: true },
    ] },
  ]);
  expect(next.tools).toEqual([{ name: 'read', input_schema: { type: 'object' } }, { name: 'write', input_schema: { type: 'object' } }]);
  expect(onTransition).toHaveBeenCalledExactlyOnceWith({ reason: 'next_turn', turn: 2, tools: 5 });
  expect(finished).toEqual({ reason: 'completed', finalAssistant: { role: 'assistant', content: [text('Finished exact result')] },
    turns: 2, usage: { inputTokens: 14, outputTokens: 14, accountedOutputTokens: 14, modelCalls: 2, compactionCalls: 0 } });
});

it('permits an explicit recoverable workspace tool result, but stops on a thrown persistence error', async () => {
  const first = reply([tool('write', 'edit')], 'tool_calls');
  const recoverable = mockHost(first, reply([text('Recovered')], 'stop'));
  recoverable.runTool.mockResolvedValueOnce({ content: 'Patch context does not match.', isError: true });
  await expect(runEmbeddedQuery(request(), recoverable)).resolves.toMatchObject({ reason: 'completed', turns: 2 });
  expect(recoverable.callModel.mock.calls[1][0].messages.at(-1)).toEqual({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'edit', content: 'Patch context does not match.', is_error: true },
  ] });
  const fatal = mockHost(reply([tool('write', 'edit'), tool('write', 'forbidden-next')], 'tool_use'));
  fatal.runTool.mockRejectedValueOnce(new Error('private storage body'));
  const result = await runEmbeddedQuery(request(), fatal);
  expect(result).toMatchObject({ reason: 'tool_error', finalAssistant: null, turns: 1 });
  expect(JSON.stringify(result)).not.toContain('private storage body');
  expect(fatal.callModel).toHaveBeenCalledOnce();
  expect(fatal.runTool).toHaveBeenCalledOnce();
});

it('cancels an in-flight read, leaves the next mutation untouched, and does not pay again', async () => {
  const controller = new AbortController(), entered = gate();
  const host = mockHost(reply([tool('read', 'reading'), tool('write', 'never')], 'tool_use'));
  let readSignal: AbortSignal | undefined;
  host.runTool.mockImplementation(async (_tool, signal) => {
    readSignal = signal;
    entered.release();
    return new Promise(() => {});
  });
  const running = runEmbeddedQuery(request({ signal: controller.signal }), host);
  await entered.wait;
  controller.abort();
  await expect(running).resolves.toMatchObject({ reason: 'aborted_tools', turns: 1, finalAssistant: null });
  expect(readSignal?.aborted).toBe(true);
  expect(host.callModel).toHaveBeenCalledOnce();
  expect(host.runTool).toHaveBeenCalledOnce();
});

it('reserves unknown usage, preserves the exact stop limit, and does not execute truncated tool calls', async () => {
  const host = mockHost(reply([tool('read', 'one')], 'tool_use', null), reply([tool('write', 'no')], 'max_tokens', 30));
  const result = await runEmbeddedQuery(request({ maxTotalOutputTokens: 130 }), host);
  expect(host.callModel.mock.calls.map(([call]) => call.maxOutputTokens)).toEqual([100, 30]);
  expect(host.runTool).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ reason: 'output_limit', finalAssistant: null, usage: {
    inputTokens: 14, outputTokens: null, accountedOutputTokens: 130, modelCalls: 2, compactionCalls: 0,
  } });
  const unknown = mockHost();
  unknown.callModel.mockRejectedValueOnce(new Error('uncertain provider connection'));
  await expect(runEmbeddedQuery(request(), unknown)).resolves.toMatchObject({ reason: 'model_error', turns: 1,
    usage: { inputTokens: null, outputTokens: null, accountedOutputTokens: 100 } });
  expect(unknown.callModel).toHaveBeenCalledOnce();
});

it('fails closed on invalid seed pairing and on repeated generated tool-use IDs', async () => {
  const host = mockHost(reply([tool('read', 'same')], 'tool_use'), reply([tool('write', 'same')], 'tool_use'));
  await expect(runEmbeddedQuery(request({ messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'orphan', content: 'orphan' },
  ] }] }), host)).rejects.toThrow(/Invalid embedded CCB/);
  expect(host.callModel).not.toHaveBeenCalled();
  await expect(runEmbeddedQuery(request(), host)).resolves.toMatchObject({ reason: 'model_error', turns: 2 });
  expect(host.runTool).toHaveBeenCalledOnce();
});

it('uses the same locked model to compact whole older rounds, preserves all evidence, and counts that call', async () => {
  const image: EmbeddedImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c2VlZA==' } };
  const observed: EmbeddedImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'b2JzZXJ2ZWQ=' } };
  const secondObserved: EmbeddedImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c2Vjb25k' } };
  const seed = [{ role: 'user' as const, content: [text('完整原始材料'), image] }];
  const old = { type: 'thinking' as const, thinking: 'old hidden', signature: 'old signature' };
  const recent = { type: 'thinking' as const, thinking: 'latest hidden', signature: 'latest signature' };
  const host = mockHost(reply([old, tool('read', 'older')], 'tool_use', 10),
    reply([recent, tool('read', 'recent')], 'tool_use', 11),
    reply([text('<analysis>private summary thinking</analysis><summary>Exact reference: read/older</summary>')], 'end_turn', 12),
    reply([text('Final')], 'end_turn', 13));
  host.runTool.mockResolvedValueOnce({ content: [text('Original tool evidence'), observed, secondObserved] });
  const onTransition = vi.fn();
  const result = await runEmbeddedQuery(request({ messages: seed, contextWindow: 1_000, maxModelTurns: 4 }), {
    ...host, onTransition, estimateTokens: wire => 50 + 300 * wire.messages.filter(message => message.role === 'assistant').length,
  });
  expect(host.callModel.mock.calls.map(([call]) => [call.kind, call.model, call.turn])).toEqual([
    ['main', 'one-locked-model', 1], ['main', 'one-locked-model', 2], ['compact', 'one-locked-model', 3], ['main', 'one-locked-model', 3],
  ]);
  const compact = host.callModel.mock.calls[2][0], last = host.callModel.mock.calls[3][0];
  expect(compact.tools).toEqual([]);
  expect(JSON.stringify(compact.messages)).not.toMatch(/old hidden|old signature|完整原始材料/);
  expect(compact.messages[0].content).toContainEqual(observed);
  expect(last.messages[0]).toEqual(seed[0]);
  expect(last.messages[1].content).toContainEqual(observed);
  expect(last.messages[1].content.slice(-4)).toEqual([
    text('Original workspace image from tool older, result part 1'), observed,
    text('Original workspace image from tool older, result part 2'), secondObserved,
  ]);
  expect(last.messages[2]).toEqual({ role: 'assistant', content: [recent, tool('read', 'recent')] });
  expect(JSON.stringify(last.messages)).not.toMatch(/old hidden|private summary thinking/);
  expect(onTransition.mock.calls.map(([event]) => event.reason)).toEqual(['next_turn', 'next_turn', 'autocompact']);
  expect(result).toMatchObject({ reason: 'completed', turns: 3,
    usage: { modelCalls: 4, compactionCalls: 1, outputTokens: 46, accountedOutputTokens: 46 } });
});

it('anchors context to observed model usage and preserves the last model call for main work', async () => {
  const measured = (id: string, inputTokens: number) => ({ ...reply([tool('read', id)], 'tool_use'),
    usage: { inputTokens, outputTokens: 4 } });
  const estimateTokens: EmbeddedQueryDeps['estimateTokens'] = wire => 50 + 50 * wire.messages.filter(message => message.role === 'assistant').length;
  const compacting = mockHost(measured('one', 800), measured('two', 870), reply([text('<summary>Earlier observations.</summary>')]), reply([text('Finished')]));
  await expect(runEmbeddedQuery(request({ contextWindow: 1_000, maxModelTurns: 4 }), { ...compacting, estimateTokens }))
    .resolves.toMatchObject({ reason: 'completed', turns: 3, usage: { modelCalls: 4, compactionCalls: 1 } });
  expect(compacting.callModel.mock.calls.map(([call]) => call.kind)).toEqual(['main', 'main', 'compact', 'main']);

  const lastCall = mockHost(measured('one', 800), measured('two', 870), reply([text('Finished without unnecessary compaction')]));
  await expect(runEmbeddedQuery(request({ contextWindow: 1_000, maxModelTurns: 3 }), { ...lastCall, estimateTokens }))
    .resolves.toMatchObject({ reason: 'completed', turns: 3, usage: { modelCalls: 3, compactionCalls: 0 } });
  expect(lastCall.callModel.mock.calls.map(([call]) => call.kind)).toEqual(['main', 'main', 'main']);

  const over = mockHost(measured('one', 800), measured('two', 900));
  await expect(runEmbeddedQuery(request({ contextWindow: 1_000, maxModelTurns: 3 }), { ...over, estimateTokens }))
    .resolves.toMatchObject({ reason: 'blocking_limit', turns: 2, usage: { modelCalls: 2, compactionCalls: 0 } });
  expect(over.callModel).toHaveBeenCalledTimes(2);
});

it('keeps the original CCB execution and verification guidance within the PGC workspace contract', () => {
  const game = getEmbeddedExecutionPrompt('game');
  expect(game).toContain("do not propose changes to code you haven't read");
  expect(game).toContain('Before reporting a task complete, verify it actually works');
  expect(game).toContain('game.html and record.json');
  expect(game).toContain('localized changes');
  const review = getEmbeddedExecutionPrompt('review');
  expect(review).toContain('full locked materials and evidence');
  expect(review).not.toMatch(/game\.html|record\.json|use patch|use write/);
  expect(game + review).not.toMatch(/Bash|Git|ExecuteExtraTool|subagent|WebSearch|npm/);
});

it('will not truncate immutable materials or schedule another model at the exact turn cap', async () => {
  const oversized = mockHost();
  await expect(runEmbeddedQuery(request({ contextWindow: 1_000 }), { ...oversized, estimateTokens: () => 901 }))
    .resolves.toMatchObject({ reason: 'blocking_limit', turns: 0 });
  expect(oversized.callModel).not.toHaveBeenCalled();
  const capped = mockHost(reply([tool('read', 'first')], 'tool_use'));
  await expect(runEmbeddedQuery(request({ maxModelTurns: 1 }), capped)).resolves.toMatchObject({ reason: 'max_turns', turns: 1 });
  expect(capped.callModel).toHaveBeenCalledOnce();
});

it('lets a clean native no-tool turn complete without exporting thinking or inventing text', async () => {
  const host = mockHost(reply([{ type: 'thinking', thinking: 'private draft', signature: 'signed' }], 'end_turn'));
  await expect(runEmbeddedQuery(request(), host)).resolves.toMatchObject({
    reason: 'completed', finalAssistant: { role: 'assistant', content: [] }, turns: 1,
  });
  expect(host.runTool).not.toHaveBeenCalled();
});

// CI executes the checked-in original source excerpts. A local checkout adds
// a whole-file and byte-range fidelity check without altering the test oracle.
const upstream = new URL('../artifacts/ccb-harness-20261105/ccb/', import.meta.url);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function original(name: keyof typeof frozenUpstream.fragments) {
  const entry = frozenUpstream.fragments[name];
  const fragment = entry.lines.join('\n') + '\n';
  expect(frozenUpstream.commit).toBe(provenance.source.commit);
  expect(entry.fileSha256).toBe(provenance.sources[entry.path as keyof typeof provenance.sources].sha256);
  expect(sha(fragment)).toBe(entry.fragmentSha256);
  expect(entry.endLine - entry.startLine + 1).toBe(entry.lines.length);
  expect(entry.endByte - entry.startByte).toBe(Buffer.byteLength(fragment));
  if (existsSync(upstream)) {
    const bytes = readFileSync(new URL(entry.path, upstream));
    expect(sha(bytes)).toBe(entry.fileSha256);
    expect(bytes.subarray(entry.startByte, entry.endByte).toString()).toBe(fragment);
  }
  return fragment;
}
function evaluate<T>(source: string, name: string, globals: Record<string, unknown> = {}) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(globals), js.replace(/\bexport /g, '') + '\nreturn ' + name)(...Object.values(globals)) as T;
}

describe('CCB 963e0013184ecc1521289a0fc7d5da4bb6e45356 behavior references', () => {
  const rounds = [
    { type: 'user' as const, tag: 'prompt' },
    { type: 'assistant' as const, message: { id: 'first' }, tag: 'tool-a' },
    { type: 'user' as const, tag: 'result-a' },
    { type: 'assistant' as const, message: { id: 'first' }, tag: 'tool-b' },
    { type: 'user' as const, tag: 'result-b' },
    { type: 'assistant' as const, message: { id: 'second' }, tag: 'followup' },
  ];
  const cases = [{ name: 'read', input: {} }, { name: 'read', input: {} }, { name: 'write', input: {} },
    { name: 'read', input: {} }, { name: 'read', input: { invalid: true } }, { name: 'read', input: {} }];
  const inputIsValid = (input: Record<string, unknown>) => input.invalid !== true;
  const selected = () => partitionToolCalls(cases, call => call.name === 'read' && inputIsValid(call.input));
  it('matches frozen interleaved API-round and mutation barrier observations', () => {
    expect(groupMessagesByApiRound(rounds).map(group => group.map(item => item.tag))).toEqual(provenance.behaviorFixtures.apiRoundGroups);
    expect(selected().map(group => [group.isConcurrencySafe, group.blocks.length])).toEqual(provenance.behaviorFixtures.toolBatches);
  });
  it('runs the pinned original round grouping and tool partition against the same inputs', () => {
    const fn = evaluate<(messages: typeof rounds) => (typeof rounds)[]>(original('apiRounds'), 'groupMessagesByApiRound');
    expect(groupMessagesByApiRound(rounds)).toEqual(fn(rounds));
    const partition = evaluate<(blocks: typeof cases, context: unknown) => ReturnType<typeof selected>>(
      original('toolPartition'),
      'partitionToolCalls', { findToolByName: (tools: { name: string }[], name: string) => tools.find(item => item.name === name) },
    );
    const tools = ['read', 'write'].map(name => ({ name, isConcurrencySafe: () => name === 'read',
      inputSchema: { safeParse: (input: Record<string, unknown>) => ({ success: inputIsValid(input), data: input }) } }));
    expect(selected()).toEqual(partition(cases, { options: { tools } }));
  });
  it('runs original query.ts main-path statements as the oracle for continuation, transcript and max turns', async () => {
    const round = evaluate<(content: EmbeddedAssistantBlock[], messagesForQuery: unknown[], toolResults: unknown[],
      turnCount: number, maxTurns: number) => Generator<unknown, { reason?: string; turnCount?: number;
        messages?: { type: string; message: { content: unknown } }[]; transition?: { reason: string } }>>(
      `function* round(content, messagesForQuery, toolResults, turnCount, maxTurns) {
        const assistantMessage = { type: 'assistant', message: { content } };
        const assistantMessages = [assistantMessage], toolUseBlocks = [];
        let needsFollowUp = false;
        ${original('queryToolAccumulation')}
        if (!needsFollowUp) { ${original('queryCompleted')} }
        const nextTurnCount = turnCount + 1;
        const toolUseContextWithQueryTracking = null, tracking = null, nextPendingToolUseSummary = null, stopHookActive = null;
        ${original('queryNextTurn')}
        return next;
      }`,
      'round', { createAttachmentMessage: (message: unknown) => message, queryCheckpoint: () => {} },
    );
    function observe(content: EmbeddedAssistantBlock[], maxTurns: number) {
      const seed = { type: 'user', message: { content: [text('Original immutable task')] } };
      const results = [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'workspace data' }] } }];
      const execution = round(content, [seed], results, 1, maxTurns);
      let step = execution.next();
      while (!step.done) step = execution.next();
      return step.value;
    }
    const action = [tool('read', 'one')], thinkingOnly = [{ type: 'thinking' as const, thinking: 'private', signature: 'native' }];
    const expectedNext = observe(action, 2);
    const host = mockHost(reply(action, 'end_turn'), reply([text('finished')], 'tool_use'));
    const transition = vi.fn();
    await expect(runEmbeddedQuery(request({ maxModelTurns: 2 }), { ...host, onTransition: transition })).resolves.toMatchObject({ reason: 'completed' });
    expect(expectedNext).toMatchObject({ turnCount: 2, transition: { reason: 'next_turn' } });
    expect(transition).toHaveBeenCalledExactlyOnceWith({ ...expectedNext.transition, turn: expectedNext.turnCount, tools: 1 });
    expect(host.callModel.mock.calls[1][0].messages).toEqual(expectedNext.messages?.map(message =>
      ({ role: message.type, content: message.message.content })));
    expect(observe(action, 1)).toMatchObject({ reason: 'max_turns', turnCount: 2 });
    await expect(runEmbeddedQuery(request({ maxModelTurns: 1 }), mockHost(reply(action, 'tool_use')))).resolves.toMatchObject({ reason: 'max_turns', turns: 1 });
    expect(observe(thinkingOnly, 2)).toEqual({ reason: 'completed' });
    await expect(runEmbeddedQuery(request(), mockHost(reply(thinkingOnly)))).resolves.toMatchObject({ reason: 'completed', finalAssistant: { content: [] } });
  });
  it('matches upstream strict pairing and compaction formatting on retained cases', () => {
    const pair = evaluate<(ids: string[], next: unknown) => void>(`function check(toolUseIds, nextMsg) {
      ${original('pairingSets')}
      if (missingIds.length || orphanedIds.length || hasDuplicateToolResults) {
        const messageTypes = [];
        ${original('pairingStrictStop')}
      }
    }`, 'check', { getStrictToolResultPairing: () => true });
    const valid = [
      { role: 'user' as const, content: [text('Pinned prompt')] },
      { role: 'assistant' as const, content: [tool('read', 'one'), tool('read', 'two')] },
      { role: 'user' as const, content: [
        { type: 'tool_result' as const, tool_use_id: 'two', content: 'completed first' },
        { type: 'tool_result' as const, tool_use_id: 'one', content: 'completed second' },
      ] },
    ];
    const toUpstream = ({ role, content }: typeof valid[number]) => ({ type: role, message: { content } });
    expect(() => pair(['one', 'two'], toUpstream(valid[2]))).not.toThrow();
    expect([...verifySeedPairing(valid)]).toEqual(['one', 'two']);
    const missing = [valid[0], valid[1], { role: 'user' as const, content: [text('Missing tool results')] }];
    expect(() => pair(['one', 'two'], toUpstream(missing[2]))).toThrow(/strict mode/);
    expect(() => verifySeedPairing(missing)).toThrow(/Invalid embedded CCB/);
    const format = evaluate<(value: string) => string>(original('compactSummary'), 'formatCompactSummary');
    const summary = '<analysis>private scratchpad</analysis>\n<summary>Path exact.html\n\n\nPending test.</summary>';
    expect(compactSummary(summary)).toBe(format(summary));
  });
});
