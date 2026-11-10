import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createComparisonSseTransport } from '../scripts/harness-comparison-stream';
import {
  COMPARISON_LEDGER_SCHEMA, comparisonAdmittedSlotsSha256, openComparisonLedger,
  type ComparisonAdmittedSlot, type ComparisonLedgerDatabase, type ComparisonStreamFrame,
} from '../scripts/harness-comparison-ledger';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const contract = 'a'.repeat(64);
const genericError = 'Comparison supplier stream could not be verified';
const sse = (body: BodyInit) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const input = (signal = new AbortController().signal) => ({
  body: encoder.encode('locked request bytes'), idempotencyKey: 'original-request', deadlineAt: 1_800_000_000_000,
  taskId: 'task-A', requestId: 'request-A', stage: 'review' as const, signal,
});

type Protocol = 'anthropic' | 'openai';
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn(() => { throw new Error('Unapproved network request'); });
  vi.stubGlobal('fetch', network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function adapter(protocol: Protocol, response: Response) {
  const fetchResponse = vi.fn<Parameters<typeof createComparisonSseTransport>[0]['fetchResponse']>(async () => response);
  return { transport: createComparisonSseTransport({ kind: 'synthetic', modelContractHash: contract, protocol, fetchResponse }), fetchResponse };
}

async function reader(protocol: Protocol, response: Response) {
  const reply = await adapter(protocol, response).transport.open(input());
  if (reply.kind !== 'stream') throw new Error('Expected stream');
  return reply.frames.getReader();
}

function synthetic() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; }, cancel });
  return { stream, writer, cancel };
}

async function collect(frames: ReadableStreamDefaultReader<ComparisonStreamFrame>) {
  const result = [];
  for (let item = await frames.read(); !item.done; item = await frames.read()) result.push(item.value);
  return result;
}

function splitBytes(text: string) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  });
}

const done = 'data: [DONE]\r\n\r\n';
const progress = 'data: {"choices":[{"index":0,"delta":{"content":"动作🎮 [DONE]","reasoning_content":"private reasoning"}}]}\r\n\r\n';
const openAiFinish = (reason: string) => `data: {"choices":[{"index":0,"finish_reason":"${reason}","delta":{}}],"usage":null}\r\n\r\n`;
const openAiUsage = 'data: {"choices":[],\r\ndata: "usage":{"prompt_tokens":30,"completion_tokens":21,"completion_tokens_details":{"reasoning_tokens":13},"max_tokens":1,"output_tokens":1}}\r\n\r\n';
const anthropicStart = 'event: message_start\rdata: {"type":"message_start","message":{"usage":{"input_tokens":41,"output_tokens":2}}}\r\r';
const anthropicProgress = 'event: content_block_delta\rdata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private 💭"}}\r\r';
const anthropicFinish = (reason: string) => `event: message_delta\rdata: {"type":"message_delta","delta":{"stop_reason":"${reason}"},"usage":{"output_tokens":27,"reasoning_tokens":19,"max_tokens":1}}\r\r`;
const anthropicDone = 'event: message_stop\rdata: {"type":"message_stop"}\r\r';

it('preserves exact fragmented OpenAI bytes and accounts only native completion_tokens', async () => {
  const ordinary = ['\uFEFF: synthetic heartbeat\r\n\r\n', progress, openAiFinish('tool_calls'), openAiUsage];
  const terminal = done + ': end comment\r\n\r\n\r\n';
  const frames = await collect(await reader('openai', sse(splitBytes(ordinary.join('') + terminal))));
  expect(frames.map(frame => [frame.kind, decoder.decode(frame.bytes)])).toEqual([
    ...ordinary.map(bytes => ['data', bytes]), ['terminal', terminal],
  ]);
  expect(frames.at(-1)).toMatchObject({ outcome: { state: 'completed', inputTokens: 30, outputTokens: 21 } });
});

it('preserves exact fragmented Anthropic CR-only bytes and accounts the final native output_tokens', async () => {
  const ping = 'event: ping\rdata: {"type":"ping"}\r\r';
  const ordinary = [anthropicStart, ping, anthropicProgress, anthropicFinish('end_turn')];
  const frames = await collect(await reader('anthropic', sse(splitBytes(ordinary.join('') + anthropicDone))));
  expect(frames.map(frame => [frame.kind, decoder.decode(frame.bytes)])).toEqual([
    ...ordinary.map(bytes => ['data', bytes]), ['terminal', anthropicDone],
  ]);
  expect(frames.at(-1)).toMatchObject({ outcome: { state: 'completed', inputTokens: 41, outputTokens: 27 } });
});

it('releases progress while the supplier is open and withholds the exact terminator until clean EOF', async () => {
  const supplier = synthetic();
  const frames = await reader('openai', sse(supplier.stream));
  supplier.writer.enqueue(encoder.encode(progress));
  expect(decoder.decode((await frames.read()).value?.bytes)).toBe(progress);
  supplier.writer.enqueue(encoder.encode(openAiFinish('stop') + openAiUsage + done));
  expect((await frames.read()).value?.kind).toBe('data');
  expect((await frames.read()).value?.kind).toBe('data');
  let terminalReleased = false;
  const last = frames.read().then(result => { terminalReleased = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(terminalReleased).toBe(false);
  supplier.writer.close();
  expect((await last).value).toMatchObject({ kind: 'terminal', bytes: encoder.encode(done) });
  await expect(frames.read()).resolves.toEqual({ done: true, value: undefined });
});

it.each([
  ['openai', openAiFinish('length') + openAiUsage + done, 'truncated', 21],
  ['anthropic', anthropicStart + anthropicFinish('max_tokens') + anthropicDone, 'truncated', 27],
  ['openai', openAiFinish('content_filter') + openAiUsage + done, 'invalid-response', 21],
  ['anthropic', anthropicStart + anthropicFinish('refusal') + anthropicDone, 'invalid-response', 27],
] as const)('classifies %s truncated or refused output as failed with exact known usage', async (protocol, body, failureCode, outputTokens) => {
  const frames = await collect(await reader(protocol, sse(body)));
  expect(frames.at(-1)).toMatchObject({ kind: 'terminal', outcome: { state: 'failed', failureCode, outputTokens } });
});

it('keeps unavailable input usage null with exact output usage and end marker', async () => {
  const data = 'data: {"choices":[{"finish_reason":"stop"}],"usage":{"completion_tokens":0}}\n\n';
  const frames = await collect(await reader('openai', sse(data + done)));
  expect(frames.at(-1)).toMatchObject({ outcome: { state: 'completed', inputTokens: null, outputTokens: 0 } });
});

it.each([
  ['missing terminal', 'openai', openAiFinish('stop') + openAiUsage],
  ['incomplete terminal frame', 'openai', openAiFinish('stop') + openAiUsage + 'data: [DONE]\r\n'],
  ['non-native done event', 'openai', openAiFinish('stop') + openAiUsage + 'event: other\ndata: [DONE]\n\n'],
  ['done-looking JSON text', 'openai', progress + openAiFinish('stop') + openAiUsage],
  ['missing finish reason', 'openai', openAiUsage + done],
  ['unrelated budget fields', 'openai', openAiFinish('stop') + 'data: {"choices":[],"usage":{"output_tokens":1,"max_tokens":1}}\n\n' + done],
  ['nonfinal usage only', 'openai', openAiUsage + openAiFinish('stop') + done],
  ['reasoning greater than total', 'openai', openAiFinish('stop') + openAiUsage.replace('"reasoning_tokens":13', '"reasoning_tokens":22') + done],
  ['usage decreases', 'openai', openAiFinish('stop') + openAiUsage + openAiUsage.replace('"completion_tokens":21', '"completion_tokens":20') + done],
  ['fractional usage', 'openai', openAiFinish('stop') + openAiUsage.replace('"completion_tokens":21', '"completion_tokens":2.1') + done],
  ['data after done', 'openai', openAiFinish('stop') + openAiUsage + done + progress],
  ['duplicate terminal', 'openai', openAiFinish('stop') + openAiUsage + done + done],
  ['provider error after done', 'openai', openAiFinish('stop') + openAiUsage + done + 'event: error\n\n'],
  ['provider error body', 'openai', 'data: {"error":{"message":"private error"}}\n\n'],
  ['malformed JSON', 'openai', 'data: {"secret: private malformed fragment}\n\n'],
  ['missing Anthropic start', 'anthropic', anthropicFinish('end_turn') + anthropicDone],
  ['mismatched Anthropic event', 'anthropic', anthropicStart + anthropicFinish('end_turn') + anthropicDone.replace('event: message_stop', 'event: ping')],
  ['Anthropic initial usage only', 'anthropic', anthropicStart + anthropicFinish('end_turn').replace(',"usage":{"output_tokens":27,"reasoning_tokens":19,"max_tokens":1}', '') + anthropicDone],
  ['Anthropic error event', 'anthropic', anthropicStart + 'event: error\ndata: {"type":"error","error":{"message":"private error"}}\n\n'],
] as const)('keeps usage unknown for %s', async (_name, protocol, body) => {
  await expect(collect(await reader(protocol, sse(body)))).rejects.toThrow(genericError);
});

it('normalizes source read failures after a valid terminator as unknown', async () => {
  const supplier = synthetic();
  const frames = await reader('openai', sse(supplier.stream));
  supplier.writer.enqueue(encoder.encode(openAiFinish('stop') + openAiUsage + done));
  await frames.read();
  await frames.read();
  const tail = frames.read();
  supplier.writer.error(new Error('private stream failure'));
  await expect(tail).rejects.toThrow(genericError);
});

it('cancels the original reader without forwarding a partial frame', async () => {
  const supplier = synthetic();
  const frames = await reader('openai', sse(supplier.stream));
  const pending = frames.read();
  supplier.writer.enqueue(encoder.encode('data: private partial frame'));
  await frames.cancel('private cancel reason');
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(supplier.cancel).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(supplier.stream.locked).toBe(false);
});

it('bounds bytes per frame and across the response, and rejects invalid UTF-8', async () => {
  const oversized = ':' + 'x'.repeat(2 * 1024 * 1024) + '\n\n';
  await expect(collect(await reader('openai', sse(oversized)))).rejects.toThrow(genericError);
  const ordinary = ':' + 'x'.repeat(1024 * 1024) + '\n\n';
  await expect(collect(await reader('openai', sse(ordinary.repeat(12))))).rejects.toThrow(genericError);
  await expect(collect(await reader('openai', sse(new Uint8Array([58, 0xc3, 10, 10]))))).rejects.toThrow(genericError);
});

it('passes the fixed provider callback original request data and emits only controlled response metadata', async () => {
  const response = new Response(openAiFinish('stop') + openAiUsage + done, {
    status: 201, statusText: 'Private status', headers: {
      'content-type': 'text/event-stream; key=private', 'set-cookie': 'private', authorization: 'private',
    },
  });
  const { transport, fetchResponse } = adapter('openai', response);
  const request = input();
  const reply = await transport.open(request);
  expect(transport).toMatchObject({ kind: 'synthetic', modelContractHash: contract });
  expect(fetchResponse).toHaveBeenCalledExactlyOnceWith(request);
  if (reply.kind !== 'stream') throw new Error('Expected stream');
  expect(reply.head).toMatchObject({ status: 201, statusText: '', body: null });
  expect(Object.fromEntries(reply.head.headers)).toEqual({
    'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  });
  await expect(collect(reply.frames.getReader())).resolves.toHaveLength(3);
});

it.each([[401, 401], [429, 429], [302, 502]])('maps explicit HTTP %i rejection to safe status %i', async (status, expected) => {
  const supplier = synthetic();
  const response = new Response(supplier.stream, { status, statusText: 'Private upstream text', headers: { 'x-private': 'secret' } });
  const reply = await adapter('openai', response).transport.open(input());
  if (reply.kind !== 'rejected') throw new Error('Expected rejection');
  expect(reply.response).toMatchObject({ status: expected, statusText: '', body: null });
  expect(Object.fromEntries(reply.response.headers)).toEqual({ 'cache-control': 'no-store' });
  expect(reply.outcome).toEqual({ state: 'failed', failureCode: 'provider-rejected', inputTokens: null, outputTokens: null });
  expect(supplier.cancel).toHaveBeenCalledOnce();
});

it.each([200, 408, 409, 500, 503])('keeps ambiguous HTTP %i responses unknown', async status => {
  const supplier = synthetic();
  const response = new Response(supplier.stream, { status });
  await expect(adapter('openai', response).transport.open(input())).rejects.toThrow(genericError);
  expect(supplier.cancel).toHaveBeenCalledOnce();
});

it('cancels a late supplier response after abort and normalizes private upstream exceptions', async () => {
  const supplier = synthetic();
  const controller = new AbortController();
  const { transport } = adapter('openai', sse(supplier.stream));
  const late = transport.open(input(controller.signal));
  controller.abort('private abort reason');
  await expect(late).rejects.toThrow(genericError);
  expect(supplier.cancel).toHaveBeenCalledOnce();
  const broken = createComparisonSseTransport({ kind: 'synthetic', modelContractHash: contract, protocol: 'openai',
    async fetchResponse() { throw new Error('private exception'); },
  });
  await expect(broken.open(input())).rejects.toThrow(genericError);
});

it('withholds native termination at the SQL barrier and retains the full cap on an invalid next stream', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of COMPARISON_LEDGER_SCHEMA) db.exec(sql);
    let entered!: () => void, commit!: () => void;
    const settlementEntered = new Promise<void>(resolve => { entered = resolve; });
    const commitSettlement = new Promise<void>(resolve => { commit = resolve; });
    const connection: ComparisonLedgerDatabase = {
      prepare(sql) {
        const statement = db.prepare(sql);
        const query = (values: (string | number | null)[]) => ({
          bind: (...bound: (string | number | null)[]) => query(bound),
          async first<T>() {
            if (sql.includes('SET state=?,failure_code=')) { entered(); await commitSettlement; }
            return (statement.get(...values) ?? null) as T | null;
          },
        });
        return query([]);
      },
    };
    const digest = (value: string) => value.repeat(64);
    const slot: ComparisonAdmittedSlot = {
      slotId: 'slot-A', ownerId: 'owner-A', taskId: 'task-A', caseId: 'case-A', arm: 'A', operation: 'review',
      sourceSha256: digest('b'), evidenceSha256: digest('c'), modelConfigSha256: digest('d'),
      stages: { review: { transportId: 'fixture', modelContractHash: contract, protocol: 'openai', model: 'deepseek-flash',
        effort: null, stream: true, jsonMode: false, maxOutputTokens: 60 } },
    };
    const slots = [slot], authority = {}, now = 1_800_000_000_000;
    const supplier = synthetic();
    const fetchResponse = vi.fn<Parameters<typeof createComparisonSseTransport>[0]['fetchResponse']>()
      .mockResolvedValueOnce(sse(supplier.stream)).mockResolvedValueOnce(sse(openAiFinish('stop') + openAiUsage));
    const transport = createComparisonSseTransport({ kind: 'synthetic', modelContractHash: contract, protocol: 'openai', fetchResponse });
    const ledger = await openComparisonLedger({
      database: { scope: 'isolated-comparison', id: 'local-d1', connection },
      grant: { schemaVersion: 1, purpose: 'isolated-comparison', scope: 'rehearsal', runId: 'native-sse-test',
        ledgerDatabaseId: 'local-d1', planSha256: digest('e'), manifestSha256: digest('f'),
        admittedSlotsSha256: await comparisonAdmittedSlotsSha256(slots), authorizationSha256: digest('1'),
        maxRequests: 3, maxOutputTokens: 100, notBefore: now - 1, deadlineAt: now + 60_000 },
      slots, authorities: new Map([['slot-A', authority]]), streamingTransports: new Map([['fixture', transport]]), now: () => now,
    });
    const bound = ledger.bindSlot(authority, 'slot-A');
    const request = (requestId: string) => ({
      requestId, stage: 'review' as const,
      body: encoder.encode(JSON.stringify({ model: 'deepseek-flash', stream: true, max_tokens: 60,
        messages: [{ role: 'user', content: 'private synthetic source' }] })),
    });
    const first = await bound.dispatchStream(request('stream-one'));
    if (!first.dispatched || !first.response) throw new Error('Expected stream');
    const stream = first.response.body!.getReader();
    supplier.writer.enqueue(encoder.encode(progress));
    expect(decoder.decode((await stream.read()).value)).toBe(progress);
    supplier.writer.enqueue(encoder.encode(openAiFinish('stop') + openAiUsage + done));
    supplier.writer.close();
    expect(decoder.decode((await stream.read()).value)).toBe(openAiFinish('stop'));
    expect(decoder.decode((await stream.read()).value)).toBe(openAiUsage);
    let tailReleased = false;
    const tail = stream.read().then(result => { tailReleased = true; return result; });
    await settlementEntered;
    expect(tailReleased).toBe(false);
    expect(await bound.read('stream-one')).toMatchObject({ state: 'forwarding', accountedOutputTokens: 60 });
    commit();
    expect(decoder.decode((await tail).value)).toBe(done);
    await expect(first.completion).resolves.toMatchObject({ state: 'completed', accountedOutputTokens: 21 });
    const second = await bound.dispatchStream(request('stream-two'));
    if (!second.dispatched || !second.response) throw new Error('Expected stream');
    await expect(second.response.text()).rejects.toThrow('without a verified terminal frame');
    await expect(second.completion).resolves.toMatchObject({ state: 'unknown', outputTokens: null, accountedOutputTokens: 60 });
    await expect(bound.dispatchStream(request('stream-two'))).resolves.toMatchObject({ dispatched: false });
    await expect(ledger.budget()).resolves.toMatchObject({ accountedOutputTokens: 81, unknownRequests: 1 });
    expect(fetchResponse).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(db.prepare('SELECT * FROM comparison_dispatch_attempts').all())).not.toMatch(/private|\[DONE\]/);
  } finally {
    db.close();
  }
});
