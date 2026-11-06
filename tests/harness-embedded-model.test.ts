import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddedModelRequest, EmbeddedToolResultBlock } from '../server/embedded-ccb/types';
import { EmbeddedHarnessModelError, runEmbeddedHarnessModel, type EmbeddedHarnessGatewayOptions } from '../server/harness-embedded-model';
import { createHarnessRun, getHarnessRunSummary, harnessSha256, lockHarnessModel, type HarnessDatabase } from '../server/harness-ledger';
import { encryptKey, type ModelConfig, type ModelProtocol } from '../server/settings';

const databases: DatabaseSync[] = [];
const secret = 'synthetic-settings-secret';
const providerKey = 'synthetic-private-provider-key';
const prompt = 'synthetic-private-brief';
const thought = 'synthetic-private-thinking-奏';
const proof = 'original-signature';
const opus = 'claude-opus-5-5';
const deepSeek = 'deepseek-v4-flash';
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } } as const;
const result = (tool_use_id: string): EmbeddedToolResultBlock => ({
  type: 'tool_result', tool_use_id, content: [{ type: 'text', text: 'screenshot result' }, image],
});
const tools = [{ name: 'read', description: 'Read a material', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];

const event = (type: string, fields: object = {}) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
const messageStart = (role = 'assistant', model = opus) => event('message_start', { message: {
  id: 'msg_native', type: 'message', role, model, content: [], usage: { input_tokens: 20, output_tokens: 0 },
} });
const start = (index: number, content_block: object) => event('content_block_start', { index, content_block });
const delta = (index: number, data: object) => event('content_block_delta', { index, delta: data });
const stop = (index: number) => event('content_block_stop', { index });
const ending = (reason = 'end_turn', output = 10) => event('message_delta', { delta: { stop_reason: reason }, usage: { output_tokens: output } }) +
  event('message_stop');
const text = (value: string) => start(0, { type: 'text', text: '' }) + delta(0, { type: 'text_delta', text: value }) + stop(0);
const anthropicTool = (id: string, path: string, signature = proof) => messageStart() +
  start(0, { type: 'thinking', thinking: '' }) + delta(0, { type: 'thinking_delta', thinking: thought.slice(0, 12) }) +
  delta(0, { type: 'thinking_delta', thinking: thought.slice(12) }) +
  (signature ? delta(0, { type: 'signature_delta', signature }) : '') + stop(0) +
  start(1, { type: 'redacted_thinking', data: 'cmVkYWN0ZWQ=' }) + stop(1) +
  start(2, { type: 'tool_use', id, name: 'read', input: {}, caller: { type: 'direct' } }) +
  delta(2, { type: 'input_json_delta', partial_json: '{"path":' }) +
  delta(2, { type: 'input_json_delta', partial_json: JSON.stringify(path) + '}' }) + stop(2) + ending('tool_use', 1_000);
const openAIEvent = (choices: object[], usage?: object) => `data: ${JSON.stringify({ id: 'chatcmpl-native', model: deepSeek, choices, usage })}\n\n`;
const openAIChoice = (delta: object, finish_reason: string | null = null) => openAIEvent([{ index: 0, delta, finish_reason }]);
const openAIUsage = (completion_tokens: number, reasoning_tokens: number) =>
  openAIEvent([], { prompt_tokens: 17, completion_tokens, completion_tokens_details: { reasoning_tokens } }) + 'data: [DONE]\n\n';

function stream(text: string, size = 17) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) controller.close();
      else { controller.enqueue(bytes.slice(offset, offset + size)); offset += size; }
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function setup(fetcher: typeof fetch, { protocol = 'anthropic', vision = true, total = 65_000 }:
  { protocol?: ModelProtocol; vision?: boolean; total?: number } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  for (const file of readdirSync('migrations').sort().filter(name => name.endsWith('.sql') && name < '0034')) {
    sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  const DB: HarnessDatabase = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = (args: SQLInputValue[]): ReturnType<HarnessDatabase['prepare']> => ({
        bind: (...values) => bound(values as SQLInputValue[]),
        first: async <T>() => (statement.get(...args) as T | undefined) ?? null,
        run: async () => statement.run(...args),
      });
      return bound([]);
    },
  };
  const openAI = protocol === 'openai';
  const profile = { model: openAI ? deepSeek : opus, baseUrl: openAI ? 'https://api.deepseek.com' : 'https://model.synthetic.invalid',
    protocol, encryptedKey: await encryptKey(providerKey, secret), enabled: true, updatedAt: 'initial', vision };
  const config: ModelConfig = { ...profile, activeProfile: 'default', profiles: { default: profile } };
  const model = (await lockHarnessModel(config, openAI ? 'review' : 'game'))!;
  const deadlineAt = Date.now() + 70_000;
  const { run, lease } = (await createHarnessRun(DB, { taskId: 'task-native', generation: 'generation', ownerId: 'owner', actor: 'star',
    sourceHash: 'a'.repeat(64), snapshot: { marker: 'synthetic' }, model, deadlineAt,
    limits: { maxTotalOutputTokens: total, maxModelTurns: 12 } }))!;
  const gateway: EmbeddedHarnessGatewayOptions = { DB, fetcher, loadConfig: async () => config, settingsKey: secret, authorizeRun: async () => true };
  const call = (requestId: string, request: Partial<EmbeddedModelRequest> = {}, options: Partial<EmbeddedHarnessGatewayOptions> = {},
    scope: { deadlineAt?: number; remainingOutputTokens?: number; lease?: string } = {}) =>
    runEmbeddedHarnessModel({
      kind: 'main', system: 'Locked synthetic system', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools, model: model.model, maxOutputTokens: model.maxOutputTokens, signal: new AbortController().signal, turn: 0, ...request,
    }, { run, lease, deadlineAt, requestId, ...scope }, { ...gateway, ...options });
  const requests = () => sqlite.prepare(`SELECT request_id,state,error_code,input_tokens,output_tokens,reasoning_tokens,output_cap,attempts,deadline_at
    FROM harness_requests ORDER BY rowid`).all();
  return { DB, sqlite, call, requests, deadlineAt, summary: () => getHarnessRunSummary(DB, run) };
}

afterEach(() => databases.splice(0).forEach(database => database.close()));

describe('embedded model native gateway', () => {
  it('continues two Anthropic tool rounds without changing native roles, signed thinking, images or locked model', async () => {
    // CCB continues from actual tool blocks after a clean terminal, even when
    // the provider uses the generic stop reason.
    const first = anthropicTool('tool-one', '奏').replace('"stop_reason":"tool_use"', '"stop_reason":"end_turn"');
    const second = anthropicTool('tool-two', 'artifact');
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => stream(first, 3))
      .mockImplementationOnce(async () => stream(second)).mockImplementationOnce(async () => stream(messageStart() + text('完成') + ending()));
    const s = await setup(fetcher);
    const initial: EmbeddedModelRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    const one = await s.call('stage-0-one', { messages: initial }, { expectedModelTurns: 0 });
    expect(one).toMatchObject({ id: 'msg_native', role: 'assistant', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 1000, reasoningTokens: null } });
    expect(one.content).toEqual([
      { type: 'thinking', thinking: thought, signature: proof },
      { type: 'redacted_thinking', data: 'cmVkYWN0ZWQ=' },
      { type: 'tool_use', id: 'tool-one', name: 'read', input: { path: '奏' } },
    ]);
    const firstRound = [...initial, { role: one.role, content: one.content }, { role: 'user' as const, content: [result('tool-one')] }];
    const stageDeadlineAt = s.deadlineAt - 5_000;
    const two = await s.call('stage-0-two', { messages: firstRound, turn: 1 }, { expectedModelTurns: 1 },
      { deadlineAt: stageDeadlineAt, remainingOutputTokens: 62_000 });
    const secondRound = [...firstRound, { role: two.role, content: two.content }, { role: 'user' as const, content: [result('tool-two')] }];
    const three = await s.call('stage-0-three', { messages: secondRound, turn: 2 }, { expectedModelTurns: 2 });
    expect(three.content).toEqual([{ type: 'text', text: '完成' }]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toBe('https://model.synthetic.invalid/v1/messages');
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('x-api-key')).toBe(providerKey);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: opus, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, stream: true,
      });
    }
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).max_tokens).toBe(64_000);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ messages: firstRound, max_tokens: 62_000 });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toMatchObject({ messages: secondRound, max_tokens: 63_000 });
    expect(s.requests()).toEqual([
      expect.objectContaining({ state: 'completed', output_tokens: 1000, output_cap: 64_000, attempts: 1 }),
      expect.objectContaining({ state: 'completed', output_tokens: 1000, output_cap: 62_000, attempts: 1, deadline_at: stageDeadlineAt }),
      expect.objectContaining({ state: 'completed', output_tokens: 10, output_cap: 63_000, attempts: 1 }),
    ]);
    expect(one.diagnostics).toMatchObject({ httpStatus: 200, byteCount: new TextEncoder().encode(first).length });
    expect(one.diagnostics.chunkCount).toBeGreaterThan(10);
    expect(one.diagnostics.nativeEventCount).toBeGreaterThan(10);
    const { requestSentAt, responseHeadAt, firstByteAt, lastByteAt, nativeTerminalAt, finishedAt } = one.diagnostics;
    expect([requestSentAt, responseHeadAt, firstByteAt, lastByteAt, nativeTerminalAt, finishedAt].every(value => typeof value === 'number')).toBe(true);
    expect(requestSentAt!).toBeLessThanOrEqual(responseHeadAt!);
    expect(responseHeadAt!).toBeLessThanOrEqual(firstByteAt!);
    expect(firstByteAt!).toBeLessThanOrEqual(lastByteAt!);
    expect(lastByteAt!).toBeLessThanOrEqual(nativeTerminalAt!);
    expect(nativeTerminalAt!).toBeLessThanOrEqual(finishedAt!);
    expect(JSON.stringify([one.diagnostics, s.requests()])).not.toContain(thought);
    expect(JSON.stringify([one.diagnostics, s.requests()])).not.toContain(prompt);
    expect(JSON.stringify([one.diagnostics, s.requests()])).not.toContain(providerKey);
  });

  it('keeps DeepSeek review low, native reasoning/tool IDs and images across continuation, with per-phase output limits', async () => {
    const first = openAIChoice({ role: 'assistant', reasoning_content: thought.slice(0, 12) }) +
      openAIChoice({ reasoning_content: thought.slice(12), tool_calls: [{ index: 0, id: 'call-native', type: 'function',
        function: { name: 'read', arguments: '{"path":' } }] }) +
      openAIChoice({ tool_calls: [{ index: 0, function: { arguments: '"brief"}' } }] }, 'stop') + openAIUsage(850, 800);
    const last = openAIChoice({ role: 'assistant', content: '{"ok":' }) + openAIChoice({ content: 'true}' }, 'stop') + openAIUsage(25, 3);
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => stream(first, 2))
      .mockImplementationOnce(async () => stream(last)).mockImplementationOnce(async () => stream(last));
    const s = await setup(fetcher, { protocol: 'openai', total: 48_000 });
    const initial: EmbeddedModelRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: prompt }, image] }];
    const one = await s.call('review-0-one', { messages: initial }, { jsonOutput: true, reviewPhase: 'review', expectedModelTurns: 0 });
    expect(one).toMatchObject({ id: 'chatcmpl-native', role: 'assistant', stopReason: 'stop',
      usage: { inputTokens: 17, outputTokens: 850, reasoningTokens: 800 },
      content: [{ type: 'thinking', thinking: thought }, { type: 'tool_use', id: 'call-native', name: 'read', input: { path: 'brief' } }],
    });
    const two = await s.call('review-0-two', {
      messages: [...initial, { role: one.role, content: one.content }, { role: 'user', content: [result('call-native')] }], turn: 1,
    }, { jsonOutput: true, reviewPhase: 'review', expectedModelTurns: 1 });
    expect(two.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    await s.call('review_verify-0-one', { messages: initial, turn: 2 }, { jsonOutput: true, reviewPhase: 'review_verify', expectedModelTurns: 2 });
    const wires = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    for (const wire of wires) expect(wire).toMatchObject({
      model: deepSeek, thinking: { type: 'enabled' }, reasoning_effort: 'low', response_format: { type: 'json_object' },
      stream: true, stream_options: { include_usage: true },
    });
    expect(wires.map(wire => wire.max_tokens)).toEqual([24_000, 23_150, 24_000]);
    expect(wires[1].messages).toEqual([
      { role: 'system', content: 'Locked synthetic system' },
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
      { role: 'assistant', content: null, reasoning_content: thought, tool_calls: [
        { id: 'call-native', type: 'function', function: { name: 'read', arguments: '{"path":"brief"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call-native', content: 'screenshot result' },
      { role: 'user', content: [{ type: 'text', text: 'Images attached to tool result call-native' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
    ]);
    expect(s.requests()[0]).toMatchObject({ state: 'completed', output_tokens: 850, reasoning_tokens: 800 });
  });

  it('uses the same locked high-effort model, ledger and cap for compaction', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(messageStart() + text('summary') + ending()));
    const s = await setup(fetcher);
    const result = await s.call('stage-0-compact', { kind: 'compact', maxOutputTokens: 1000 }, {}, { remainingOutputTokens: 49 });
    expect(result.content).toEqual([{ type: 'text', text: 'summary' }]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: opus, max_tokens: 49, output_config: { effort: 'high' } });
    await expect(s.call('stage-0-wrong', { kind: 'compact', model: 'unlocked-model' })).rejects.toMatchObject({ code: 'profile_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing terminal', messageStart() + text('visible') + ending().replace(event('message_stop'), ''), 'stream_incomplete'],
    ['unsigned thinking', anthropicTool('tool-id', 'brief', ''), 'stream_invalid'],
    ['invalid tool input', anthropicTool('tool-id', 'brief').replace(JSON.stringify('{"path":'), JSON.stringify('not JSON')), 'stream_invalid'],
    ['non-assistant role', messageStart('user') + text('spoofed') + ending(), 'stream_invalid'],
    ['wrong upstream model', messageStart('assistant', 'other-model') + text('wrong') + ending(), 'stream_invalid'],
    ['usage beyond reservation', messageStart() + text('visible') + ending('end_turn', 64_001), 'stream_invalid'],
    ['native SSE error', messageStart() + event('error', { error: { type: 'overloaded_error', message: providerKey + prompt } }), 'stream_error'],
  ])('treats %s as unknown without replay or sensitive error text', async (_label, wire, code) => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(wire));
    const s = await setup(fetcher);
    const error = await s.call('stage-0-one').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(EmbeddedHarnessModelError);
    expect(error).toMatchObject({ message: code, code, diagnostics: { httpStatus: 200 } });
    expect(JSON.stringify(error)).not.toContain(providerKey);
    expect(JSON.stringify(error)).not.toContain(prompt);
    expect(s.requests()).toEqual([expect.objectContaining({ state: 'unknown', error_code: code, input_tokens: null, output_tokens: null, attempts: 1 })]);
    expect(await s.summary()).toMatchObject({ status: 'unknown', reservedTokens: 64_000 });
    await expect(s.call('stage-0-two')).rejects.toBeInstanceOf(EmbeddedHarnessModelError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports explicit truncation as a settled failure and never returns an incomplete tool', async () => {
    const truncated = messageStart() + start(0, { type: 'tool_use', id: 'tool-one', name: 'read', input: {} }) +
      delta(0, { type: 'input_json_delta', partial_json: '{"path":' }) + stop(0) + ending('max_tokens', 64_000);
    const fetcher = vi.fn<typeof fetch>(async () => stream(truncated));
    const s = await setup(fetcher);
    await expect(s.call('stage-0-one')).rejects.toMatchObject({ code: 'output_truncated', diagnostics: { nativeTerminalAt: expect.any(Number) } });
    expect(s.requests()).toEqual([expect.objectContaining({ state: 'failed', output_tokens: 64_000, attempts: 1, error_code: 'output_truncated' })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not accept an OpenAI terminator inside an unrelated named SSE event', async () => {
    const wire = openAIChoice({ role: 'assistant', content: '{}' }, 'stop') +
      openAIUsage(25, 3).replace('data: [DONE]', 'event: unrelated\ndata: [DONE]');
    const fetcher = vi.fn<typeof fetch>(async () => stream(wire));
    const s = await setup(fetcher, { protocol: 'openai' });
    await expect(s.call('review-0-one', {}, { reviewPhase: 'review' })).rejects.toMatchObject({
      code: 'stream_invalid', diagnostics: { nativeTerminalAt: null },
    });
    expect(s.requests()).toEqual([expect.objectContaining({ state: 'unknown', output_tokens: null, attempts: 1 })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains conservative reservation if the request aborts after native bytes arrive', async () => {
    const stop = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(messageStart())); },
      pull() { stop.abort(); },
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const s = await setup(fetcher);
    await expect(s.call('stage-0-one', { signal: stop.signal })).rejects.toMatchObject({
      code: 'client_disconnected', diagnostics: { byteCount: expect.any(Number), firstByteAt: expect.any(Number), nativeTerminalAt: null,
        cancelReason: 'client_disconnected' },
    });
    expect(await s.summary()).toMatchObject({ status: 'unknown', reservedTokens: 64_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('collects only bounded response header facts and hashes provider-controlled identifiers', async () => {
    const cfRay = 'a5630afadd37ccdc-LAX';
    const fetcher = vi.fn<typeof fetch>(async () => new Response(stream(messageStart() + text('safe final') + ending()).body, {
      headers: {
        'Content-Type': 'text/event-stream; private=' + providerKey,
        'Request-Id': 'malformed private text',
        'X-Request-Id': providerKey,
        'CF-Ray': cfRay,
        'Retry-After': '2',
        'Authorization': 'Bearer ' + providerKey,
        'Set-Cookie': 'private=anything',
      },
    }));
    const s = await setup(fetcher);
    const output = await s.call('stage-0-one');
    expect(output.diagnostics.responseHeaders).toEqual({
      contentType: 'text/event-stream', requestIdSha256: null, xRequestIdSha256: await harnessSha256(providerKey),
      cfRaySha256: await harnessSha256(cfRay), retryAfterMs: 2_000,
    });
    expect(output.diagnostics.cancelReason).toBeNull();
    const stored = JSON.stringify(output.diagnostics);
    for (const privateValue of [providerKey, cfRay, 'malformed private text', 'private=anything']) expect(stored).not.toContain(privateValue);
  });

  it('honors lease, deadline and vision boundaries before forwarding and never retries HTTP 429', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(providerKey, { status: 429, headers: { 'Retry-After': '1' } }));
    const s = await setup(fetcher, { vision: false });
    await expect(s.call('stage-0-bad-lease', {}, {}, { lease: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_lease' });
    await expect(s.call('stage-0-expired', {}, {}, { deadlineAt: Date.now() - 100 })).rejects.toMatchObject({ code: 'deadline' });
    await expect(s.call('stage-0-vision', { messages: [{ role: 'user', content: [image] }] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(s.call('stage-0-first')).rejects.toMatchObject({ code: 'provider_rejected', diagnostics: { httpStatus: 429 } });
    expect(s.requests()).toEqual([expect.objectContaining({ state: 'failed', attempts: 1 })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
