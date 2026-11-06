import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleHarnessModelRequest, type HarnessGatewayOptions } from '../server/harness-gateway';
import { createHarnessRun, endHarnessRun, getHarnessRunSummary, lockHarnessModel, type HarnessDatabase } from '../server/harness-ledger';
import { encryptKey, type ModelConfig, type ModelProtocol } from '../server/settings';

const opened: DatabaseSync[] = [];
const secret = 'test-settings';
const key = 'private-synthetic-provider-key';
const prompt = 'private-synthetic-prompt';
const thinking = 'private-synthetic-thinking';
const idHeaders = (task: string, requestId: string, lease: string) => ({
  'Content-Type': 'application/json', Authorization: `Bearer ${lease}`,
  'x-pgc-harness-task': task, 'x-pgc-harness-generation': 'generation', 'x-pgc-harness-request-id': requestId,
});
const anthropic = {
  model: 'claude-opus-5-5', stream: true, max_tokens: 64_000,
  messages: [
    { role: 'user', content: prompt },
    { role: 'assistant', content: [
      { type: 'thinking', thinking, signature: 'original-signature' },
      { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'brief' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ] },
    ] },
  ],
  tools: [{ name: 'read', description: 'Read task data', input_schema: { type: 'object' } }],
};
const openAI = {
  model: 'deepseek-v4-flash', stream: true, max_tokens: 24_000,
  messages: [
    { role: 'user', content: prompt },
    { role: 'assistant', content: null, reasoning_content: thinking, tool_calls: [
      { id: 'tool-1', type: 'function', function: { name: 'read', arguments: '{"path":"brief"}' } },
    ] },
    { role: 'tool', tool_call_id: 'tool-1', content: 'content' },
  ],
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
};
const event = (type: string, fields: object = {}) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
const messageStart = event('message_start', { message: { usage: { input_tokens: 20, output_tokens: 0 } } });
const thinkingDelta = event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking } });
const signatureDelta = event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'original-signature' } });
const messageDelta = (stop_reason = 'tool_use', usage: object | null = { output_tokens: 900 }) => event('message_delta', { delta: { stop_reason }, usage });
const messageStop = event('message_stop');
const anthStream = messageStart + thinkingDelta + signatureDelta + messageDelta() + messageStop;
const openAIStream = [
  { choices: [{ index: 0, delta: { reasoning_content: thinking }, finish_reason: null }], usage: null },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: null },
  { choices: [], usage: { prompt_tokens: 17, completion_tokens: 850, completion_tokens_details: { reasoning_tokens: 800 } } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';

function stream(text: string, size = 19) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function setup(protocol: ModelProtocol = 'anthropic', options: Partial<HarnessGatewayOptions> = {}, vision = protocol === 'anthropic',
  baseUrl?: string, limits?: Parameters<typeof createHarnessRun>[1]['limits']) {
  const sqlite = new DatabaseSync(':memory:');
  opened.push(sqlite);
  for (const file of readdirSync('migrations').sort().filter(name => name.endsWith('.sql') && name < '0034')) {
    sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  const DB: HarnessDatabase = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) {
          const args = values as SQLInputValue[];
          return {
            ...this,
            first: async <T>() => (statement.get(...args) as T | undefined) ?? null,
            run: async () => statement.run(...args),
          };
        },
        first: async <T>() => (statement.get() as T | undefined) ?? null,
        run: async () => statement.run(),
      };
    },
  };
  const anthropicProvider = protocol === 'anthropic';
  let config: ModelConfig = {
    activeProfile: 'default', model: anthropicProvider ? anthropic.model : openAI.model,
    baseUrl: baseUrl ?? (anthropicProvider ? 'https://models.synthetic.invalid' : 'https://api.deepseek.com'),
    protocol, encryptedKey: await encryptKey(key, secret), enabled: true, updatedAt: 'initial', vision,
  };
  config = { ...config, profiles: { default: { ...config } } };
  const model = (await lockHarnessModel(config, anthropicProvider ? 'game' : 'review'))!;
  const create = (taskId: string, ownerId = 'member-a', deadlineAt?: number) =>
    createHarnessRun(DB, { taskId, ownerId, generation: 'generation', actor: 'star', sourceHash: 'a'.repeat(64), snapshot: { versions: ['v1'] }, model, deadlineAt, limits });
  const { run, lease } = (await create('task'))!;
  const path = anthropicProvider ? '/v1/messages' : '/v1/chat/completions';
  const defaultBody = anthropicProvider ? anthropic : openAI;
  const send = (requestId: string, body: object = defaultBody, extra: { task?: string; lease?: string; path?: string } = {}) =>
    handleHarnessModelRequest(new Request(`http://pgc-harness.internal${extra.path ?? path}`, {
      method: 'POST', headers: idHeaders(extra.task ?? run.taskId, requestId, extra.lease ?? lease), body: JSON.stringify(body),
    }), { DB, loadConfig: async () => config, settingsKey: secret, authorizeRun: async () => true, ...options });
  return {
    DB, sqlite, run, lease, send, create, setConfig: (next: ModelConfig) => { config = next; }, config,
    summary: () => getHarnessRunSummary(DB, run),
  };
}
afterEach(() => {
  vi.useRealTimers();
  opened.splice(0).forEach(sqlite => sqlite.close());
});

describe('private harness model gateway', () => {
  it('preserves native Anthropic tool, image, thinking signature and fragmented SSE bytes', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(anthStream));
    const s = await setup('anthropic', { fetcher });
    const response = await s.send('build-1');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe(anthStream);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://models.synthetic.invalid/v1/messages');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBe(key);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-pgc-harness-task')).toBeNull();
    expect(headers.get('idempotency-key')).toMatch(/^pgc-harness-[a-f0-9]{64}$/);
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(String(init?.body))).toEqual({ ...anthropic, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(await s.summary()).toMatchObject({ modelTurns: 1, outputTokens: 900, reservedTokens: 0 });
    for (const table of ['harness_runs', 'harness_requests', 'harness_events', 'model_runs']) {
      const persisted = JSON.stringify(s.sqlite.prepare(`SELECT * FROM ${table}`).all());
      for (const sensitive of [s.lease, key, prompt, thinking, 'original-signature']) expect(persisted).not.toContain(sensitive);
    }
    expect((await s.send('build-1')).status).toBe(409);
    expect((await s.send('build-1', { ...anthropic, max_tokens: 1000 })).status).toBe(409);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves Chat Completions tool call history and accounts reasoning once in total output', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(openAIStream));
    const s = await setup('openai', { fetcher });
    const response = await s.send('review-1');
    expect(await response.text()).toBe(openAIStream);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + key);
    expect(JSON.parse(String(init?.body))).toEqual({ ...openAI, stream_options: { include_usage: true }, reasoning_effort: 'low', thinking: { type: 'enabled' } });
    expect(await s.summary()).toMatchObject({ modelTurns: 1, outputTokens: 850 });
    expect(s.sqlite.prepare('SELECT input_tokens,output_tokens,reasoning_tokens FROM harness_requests').get())
      .toEqual({ input_tokens: 17, output_tokens: 850, reasoning_tokens: 800 });
  });

  it('locks official DeepSeek JSON mode at the structured stage boundary before reserving a model turn', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(openAIStream));
    const s = await setup('openai', { fetcher, jsonOutput: true, requestIdPrefix: 'review_verify-0-' });
    expect((await s.send('review-0-unscoped')).status).toBe(401);
    for (const response_format of [{ type: 'text' }, { type: 'json_schema' }, { type: 'json_object', extra: true }]) {
      expect((await s.send('review_verify-0-invalid', { ...openAI, response_format })).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await s.summary()).toMatchObject({ modelTurns: 0, reservedTokens: 0 });
    expect(await (await s.send('review_verify-0-valid')).text()).toBe(openAIStream);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      ...openAI, response_format: { type: 'json_object' }, stream_options: { include_usage: true },
      reasoning_effort: 'low', thinking: { type: 'enabled' },
    });
  });

  it.each([[false, 'https://api.deepseek.com'], [true, 'https://models.synthetic.invalid']])(
    'does not let the caller enable JSON mode outside the locked official DeepSeek JSON contract (%s, %s)',
    async (jsonOutput, baseUrl) => {
      const fetcher = vi.fn<typeof fetch>(async () => stream(openAIStream));
      const s = await setup('openai', { fetcher, jsonOutput }, false, baseUrl);
      expect((await s.send('bad-format', { ...openAI, response_format: { type: 'json_object' } })).status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await (await s.send('plain-format')).text()).toBe(openAIStream);
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).not.toHaveProperty('response_format');
    },
  );

  it('rejects other routes, models, effort, oversized controls and remote tools before forwarding', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(anthStream));
    const s = await setup('anthropic', { fetcher });
    expect((await s.send('bad', anthropic, { path: '/v1/models' })).status).toBe(404);
    for (const overrides of [
      { model: 'auxiliary-model' }, { max_tokens: 64_001 }, { stream: false }, { output_config: { effort: 'low' } },
      { thinking: { type: 'enabled', budget_tokens: 1000 } },
      { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://external.invalid' } }] }] },
    ]) expect((await s.send('bad', { ...anthropic, ...overrides })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await s.summary()).toMatchObject({ modelTurns: 0, reservedTokens: 0 });
  });

  it('rejects cross-owner lease reuse and rechecks authorization just before provider fetch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(anthStream));
    let calls = 0;
    const s = await setup('anthropic', { fetcher, authorizeRun: async () => ++calls === 1 });
    const other = (await s.create('other', 'member-b'))!;
    expect((await s.send('wrong', anthropic, { task: other.run.taskId })).status).toBe(401);
    expect((await s.send('revoked')).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await s.summary()).toMatchObject({ status: 'failed', failureCode: 'authorization_revoked' });
  });

  it('rejects disabled or changed profiles without sending the new provider key', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(anthStream));
    const s = await setup('anthropic', { fetcher });
    s.setConfig({ ...s.config, profiles: { default: { ...s.config, enabled: false } } });
    expect((await s.send('disabled')).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not forward image evidence under a text-only model', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(anthStream));
    const s = await setup('anthropic', { fetcher }, false);
    expect((await s.send('no-vision')).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not follow redirects or expose upstream error bodies, headers or credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(key + prompt, { status: 307, headers: { Location: 'https://different.invalid' } }));
    const s = await setup('anthropic', { fetcher });
    const response = await s.send('redirect');
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(new RegExp(key + '|' + prompt));
    expect(response.headers.get('location')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await s.summary()).toMatchObject({ status: 'failed', failureCode: 'provider_redirect', reservedTokens: 0 });
  });

  it.each([
    { label: 'native error frame', text: messageStart + event('error', { error: { type: 'overloaded_error', message: key + prompt } }), code: 'stream_error' },
    { label: 'missing terminal frame', text: messageStart + messageDelta(), code: 'stream_incomplete' },
    { label: 'missing final usage', text: messageStart + messageDelta('tool_use', null) + messageStop, code: 'stream_incomplete' },
    { label: 'usage over the reserved cap', text: messageStart + messageDelta('tool_use', { output_tokens: 64_001 }) + messageStop, code: 'stream_invalid' },
  ])('latches $label as unknown and blocks all fresh model calls', async ({ text, code }) => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(text));
    const s = await setup('anthropic', { fetcher });
    const response = await s.send('failure');
    await expect(response.text()).rejects.toThrow(code);
    expect(await s.summary()).toMatchObject({ status: 'unknown', failureCode: code, outputTokens: 0, reservedTokens: 64_000 });
    expect((await s.send('replacement')).status).toBe(401);
    expect(await endHarnessRun(s.DB, s.run, 'done')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: '24k reservation keeps its original wire limit', declaredCap: 24_000, outputCap: 24_000, priorOutput: 0, wireLimit: 12 * 1024 * 1024 },
    { label: '64k declaration clamped to 24k by earlier usage', declaredCap: 64_000, outputCap: 24_000, priorOutput: 40_000, wireLimit: 12 * 1024 * 1024 },
    { label: '64k reservation still has a cumulative wire limit', declaredCap: 64_000, outputCap: 64_000, priorOutput: 0, wireLimit: 64 * 1024 * 1024 },
  ])('latches unknown when a $label is exceeded', async ({ declaredCap, outputCap, priorOutput, wireLimit }) => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const frame = encode(event('ping', { metadata: 'x'.repeat(63 * 1024) }));
    const opening = encode(messageStart);
    const count = Math.floor((wireLimit - opening.length) / frame.length) + 1;
    let reads = 0;
    const canceled = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      pull(controller) {
        if (reads === 0) controller.enqueue(opening);
        else if (reads <= count) controller.enqueue(frame);
        else controller.close();
        reads++;
      },
      cancel: canceled,
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const s = await setup('anthropic', { fetcher }, true, undefined, priorOutput ? { maxTotalOutputTokens: 64_000, maxModelTurns: 2 } : undefined);
    if (priorOutput) {
      const earlier = messageStart + messageDelta('end_turn', { output_tokens: priorOutput }) + messageStop;
      fetcher.mockImplementationOnce(async () => stream(earlier));
      expect(await (await s.send('previous-paid-stage')).text()).toBe(earlier);
    }
    const response = await s.send('too-many-wire-bytes', { ...anthropic, max_tokens: declaredCap });
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ max_tokens: outputCap });
    const reader = response.body!.getReader();
    let forwarded = 0;
    await expect((async () => {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        forwarded += result.value.byteLength;
      }
    })()).rejects.toThrow('stream_limit');
    expect(forwarded).toBe(opening.length + (count - 1) * frame.length);
    expect(reads).toBe(count + 1);
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(await s.summary()).toMatchObject({ status: 'unknown', failureCode: 'stream_limit', outputTokens: priorOutput, reservedTokens: outputCap });
    expect(fetcher).toHaveBeenCalledTimes(priorOutput ? 2 : 1);
  });

  it('retains the per-event limit with an extended cumulative wire budget', async () => {
    const oversizeFrame = ':' + 'x'.repeat(2 * 1024 * 1024) + '\n\n';
    const fetcher = vi.fn<typeof fetch>(async () => stream(messageStart + oversizeFrame, 32 * 1024));
    const s = await setup('anthropic', { fetcher });
    const response = await s.send('large-single-frame');
    await expect(response.text()).rejects.toThrow('stream_limit');
    expect(await s.summary()).toMatchObject({ status: 'unknown', failureCode: 'stream_limit', reservedTokens: 64_000 });
  });

  it.each([
    { label: 'blank frames before the terminator', prefix: messageStart, frame: '\n' },
    { label: 'comment frames after the terminator', prefix: anthStream, frame: ': keepalive\n\n' },
  ])('bounds a single read flooded with $label', async ({ prefix, frame }) => {
    const encode = new TextEncoder();
    let read = 0;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      pull(controller) {
        if (read === 0) controller.enqueue(encode.encode(prefix));
        else if (read === 1) controller.enqueue(encode.encode(frame.repeat(65_537)));
        else controller.close();
        read++;
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const s = await setup('anthropic', { fetcher });
    const response = await s.send('frame-flood');
    await expect(response.text()).rejects.toThrow('stream_limit');
    expect(await s.summary()).toMatchObject({ status: 'unknown', failureCode: 'stream_limit', outputTokens: 0, reservedTokens: 64_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds the held terminal tail without releasing it before settlement', async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const comment = encode(':' + 'x'.repeat(1024 * 1024) + '\n\n');
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      pull(controller) {
        if (reads === 0) controller.enqueue(encode(anthStream));
        else if (reads <= 12) controller.enqueue(comment);
        else controller.close();
        reads++;
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const s = await setup('anthropic', { fetcher });
    const reader = (await s.send('terminal-tail')).body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).not.toContain('message_stop');
    await expect(reader.read()).rejects.toThrow('stream_limit');
    expect(await s.summary()).toMatchObject({ status: 'unknown', reservedTokens: 64_000 });
  });

  it('records known truncation and consumed output without forwarding a successful terminal frame', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => stream(messageStart + messageDelta('max_tokens', { output_tokens: 64_000 }) + messageStop));
    const s = await setup('anthropic', { fetcher });
    const response = await s.send('truncation');
    await expect(response.text()).rejects.toThrow('output_truncated');
    expect(await s.summary()).toMatchObject({ status: 'failed', failureCode: 'output_truncated', outputTokens: 64_000, reservedTokens: 0 });
  });

  it('treats HTTP 409 and stream failures as possibly paid and never replays them', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'REQUEST_OUTCOME_UNCERTAIN', message: key } }, { status: 409 }));
    const s = await setup('anthropic', { fetcher });
    const response = await s.send('unknown');
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(key);
    expect(await s.summary()).toMatchObject({ status: 'unknown', failureCode: 'provider_unknown' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds and meters a definitely rejected 503 retry using the original upstream key', async () => {
    vi.useFakeTimers();
    const rejection = { error: { code: 'KEY_QUEUE_FULL', message: '测'.repeat(6500) } };
    const errorResponse = vi.fn(() => { throw new Error('Synthetic telemetry failure'); });
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Response.json(rejection, { status: 503 }))
      .mockImplementationOnce(async () => stream(anthStream));
    const s = await setup('anthropic', { fetcher, nativeObserver: {
      sent() {}, head() {}, bytes() {}, event() {}, complete() {}, errorResponse,
    } });
    const pending = s.send('safe-retry');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5000);
    const response = await pending;
    expect(await response.text()).toBe(anthStream);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(errorResponse).toHaveBeenCalledExactlyOnceWith({ category: 'KEY_QUEUE_FULL', bodyState: 'parsed',
      bytesObserved: new TextEncoder().encode(JSON.stringify(rejection)).byteLength });
    const idempotencyKeys = fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('idempotency-key'));
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(await s.summary()).toMatchObject({ modelTurns: 2, outputTokens: 900, reservedTokens: 0 });
  });
});

it('executes the ledger and native streaming fetch in workerd with local-only outbound dispatch', async () => {
  const [{ build }, { Miniflare, Response: MockResponse }, { resolve }] = await Promise.all([
    import('esbuild'), import('miniflare'), import('node:path'),
  ]);
  const { sqlite } = await setup();
  const schema = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`).all() as Array<{ sql: string }>;
  const entry = await build({
    stdin: {
      contents: `
        import {handleHarnessModelRequest} from ${JSON.stringify(resolve('server/harness-gateway.ts'))};
        import {createHarnessRun,lockHarnessModel,getHarnessRunSummary} from ${JSON.stringify(resolve('server/harness-ledger.ts'))};
        import {encryptKey} from ${JSON.stringify(resolve('server/settings.ts'))};
        let config;
        const id={taskId:'workerd-task',generation:'generation'};
        export default {async fetch(request,env,ctx){
          const path=new URL(request.url).pathname;
          if(path==='/init') {
            config={model:'claude-opus-5-5',baseUrl:'https://models.synthetic.invalid',protocol:'anthropic',
              activeProfile:'opus',enabled:true,updatedAt:'initial',encryptedKey:await encryptKey(${JSON.stringify(key)},${JSON.stringify(secret)})};
            const model=await lockHarnessModel(config,'game');
            return Response.json(await createHarnessRun(env.DB,{...id,ownerId:'member-a',actor:'star',
              sourceHash:'a'.repeat(64),snapshot:{versions:['v1']},model}));
          }
          if(path==='/summary')return Response.json(await getHarnessRunSummary(env.DB,id));
          return handleHarnessModelRequest(request,{DB:env.DB,loadConfig:async()=>config,settingsKey:${JSON.stringify(secret)},
            authorizeRun:async()=>true,waitUntil:promise=>ctx.waitUntil(promise)});
        }};
      `,
      loader: 'ts',
      resolveDir: process.cwd(),
    },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  });
  const calls: Array<{ url: string; key: string | null }> = [];
  let upstreamStatus = 200;
  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: [{
    config: {
      name: 'harness-gateway-workerd', compatibilityDate: '2026-10-23', env: { DB: { type: 'd1', id: 'synthetic-harness-db' } },
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: entry.outputFiles[0].text } } },
    },
    dev: { outboundService: { type: 'fetcher', handler(request) {
      calls.push({ url: request.url, key: request.headers.get('x-api-key') });
      if (request.url !== 'https://models.synthetic.invalid/v1/messages') return new MockResponse('unmatched', { status: 418 });
      return upstreamStatus === 200
        ? new MockResponse(anthStream, { headers: { 'Content-Type': 'text/event-stream' } })
        : new MockResponse(key, { status: upstreamStatus, headers: { Location: 'https://redirect.synthetic.invalid' } });
    } } },
  }] });
  try {
    await runtime.ready;
    const d1 = await runtime.getD1Database('DB');
    await d1.batch(schema.map(({ sql }) => d1.prepare(sql)));
    const init = await runtime.dispatchFetch('https://pgc.synthetic.invalid/init');
    expect(init.status).toBe(200);
    const { lease } = await init.json() as { lease: string };
    const request = (id: string) => runtime.dispatchFetch('https://pgc.synthetic.invalid/v1/messages', {
      method: 'POST', body: JSON.stringify(anthropic), headers: idHeaders('workerd-task', id, lease),
    });
    expect(await (await request('build-1')).text()).toBe(anthStream);
    expect((await request('build-1')).status).toBe(409);
    upstreamStatus = 307;
    const redirect = await request('build-2');
    expect(redirect.status).toBe(502);
    expect(await redirect.text()).not.toContain(key);
    expect(calls).toEqual(Array.from({ length: 2 }, () => ({ url: 'https://models.synthetic.invalid/v1/messages', key })));
    const summary = await runtime.dispatchFetch('https://pgc.synthetic.invalid/summary');
    expect(await summary.json()).toMatchObject({ status: 'failed', failureCode: 'provider_redirect', modelTurns: 2, outputTokens: 900 });
  } finally {
    await runtime.dispose();
  }
}, 30_000);

it('withholds the terminal event until upstream EOF and durable usage settlement', async () => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const encode = new TextEncoder();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
    start(controller) {
      upstream = controller;
      controller.enqueue(encode.encode(anthStream));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const s = await setup('anthropic', { fetcher });
  const reader = (await s.send('must-settle')).body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe(anthStream.slice(0, -messageStop.length));
  const terminal = reader.read();
  expect(await s.summary()).toMatchObject({ status: 'active', outputTokens: 0, reservedTokens: 64_000 });
  upstream.close();
  expect(new TextDecoder().decode((await terminal).value)).toBe(messageStop);
  expect(await s.summary()).toMatchObject({ status: 'active', outputTokens: 900, reservedTokens: 0 });
  expect((await reader.read()).done).toBe(true);
});

it('latches a dropped downstream connection after model dispatch', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(messageStart)); },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const s = await setup('anthropic', { fetcher });
  const reader = (await s.send('dropped')).body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(await s.summary()).toMatchObject({ status: 'unknown', failureCode: 'client_disconnected' });
  expect((await s.send('replacement')).status).toBe(401);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('applies the trusted outbound phase prefix and deadline independently of container fields', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => stream(anthStream));
  const s = await setup('anthropic', { fetcher, requestIdPrefix: 'polish-0-', deadlineAt: 1 });
  expect((await s.send('build-0-call')).status).toBe(401);
  expect((await s.send('polish-0-call')).status).toBe(504);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await s.summary()).toMatchObject({ status: 'active', modelTurns: 0 });
});
