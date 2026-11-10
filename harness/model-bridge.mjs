import { once } from 'node:events';
import { permittedTools } from './workspace.mjs';

export function parseGatewayURL(raw, allowFixture = false) {
  const url = new URL(raw);
  const internal = url.protocol === 'http:' && url.host === 'pgc-harness.internal';
  const fixture = allowFixture && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!internal && !fixture && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid model gateway configuration');
  }
  return url.href.replace(/\/$/, '');
}

export async function readBody(request, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    if ((bytes += chunk.length) > limit) throw new Error('Request exceeds limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function reply(response, status, body) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export async function bridgeModel(context, request, response, gateway, stop) {
  const { run } = context;
  const path = run.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const id = request.headers['x-pgc-ccb-turn'];
  if (request.method !== 'POST' || ![path, `${path}?beta=true`].includes(request.url) ||
      typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) {
    return reply(response, 403, { error: 'Operation denied' });
  }
  if (context.activeModel || context.modelIds.has(id) || context.modelIds.size >= run.maxModelTurns ||
      (context.modelIds.size > 0 && !context.canContinue)) {
    return reply(response, 409, { error: 'Model turn already submitted or run exhausted' });
  }
  context.activeModel = true;
  context.canContinue = false;
  try {
    const raw = await readBody(request, 32 * 1024 * 1024);
    const body = JSON.parse(raw.toString('utf8'));
    const remaining = run.maxTotalOutputTokens - context.outputTokens;
    if (context.abort.signal.aborted) throw new Error('Run ended');
    if (!body || body.model !== run.model || body.stream !== true ||
        !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || remaining < 1 ||
        !Array.isArray(body.messages) || (body.tools !== undefined &&
          (!Array.isArray(body.tools) || !body.tools.every(tool => {
            const name = run.protocol === 'anthropic'
              ? (tool?.type === undefined || tool.type === 'custom') && tool?.name
              : tool?.type === 'function' && tool.function?.name;
            return permittedTools(run).has(name);
          })))) {
      return stop('model_request_denied', () => reply(response, 400, { error: 'Model request denied' }));
    }

    const headers = {
      authorization: `Bearer ${context.lease}`,
      'content-type': 'application/json',
      'x-pgc-harness-task': run.taskId,
      'x-pgc-harness-generation': String(run.generation),
      'x-pgc-harness-request-id': `${run.phase.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}-${run.repair}-${id}`,
    };
    if (run.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    context.modelIds.add(id);
    body.max_tokens = Math.min(body.max_tokens, run.maxOutputTokens, remaining);
    // Remove CCB session metadata and overlapping transport flags. The
    // platform gateway applies the locked model profile to the native body.
    delete body.thinking;
    delete body.output_config;
    if (run.protocol === 'anthropic') {
      delete body.metadata;
      delete body.betas;
      if (Array.isArray(body.system) && body.system[0]?.text?.startsWith('x-anthropic-billing-header:')) body.system.shift();
      if (run.purpose === 'game') {
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort: 'high' };
      }
    } else {
      delete body.enable_thinking;
      delete body.chat_template_kwargs;
    }
    const upstream = await fetch(`${gateway}${path}`, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: context.abort.signal,
    });
    if (!upstream.ok || !upstream.body || !upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
      await upstream.body?.cancel();
      return stop('model_request_failed', () => reply(response, 502, { error: 'Model gateway did not return a stream' }));
    }

    const stream = inspectStream(run.protocol, permittedTools(run));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const finalChunks = [];
    let finalBytes = 0;
    for await (const chunk of upstream.body) {
      stream.push(chunk);
      if (stream.terminal) {
        if ((finalBytes += chunk.length) > 4 * 1024 * 1024) throw new Error('Terminal data exceeds limit');
        finalChunks.push(chunk);
      } else if (!response.write(chunk)) {
        await once(response, 'drain', { signal: context.abort.signal });
      }
    }
    const terminal = stream.finish();
    if (terminal.usage > body.max_tokens || terminal.reason === 'max_tokens' || terminal.reason === 'length') {
      throw new Error('Model output limit reached');
    }
    context.outputTokens += terminal.usage;
    context.canContinue = terminal.reason === 'tool_use' || terminal.reason === 'tool_calls';
    response.end(Buffer.concat(finalChunks));
  } catch {
    if (response.headersSent) response.destroy();
    return stop('model_stream_incomplete', () => reply(response, 502, { error: 'Model stream incomplete' }));
  } finally {
    context.activeModel = false;
  }
}

export function inspectStream(protocol, allowedTools) {
  const decoder = new TextDecoder();
  let pending = '';
  let data = [];
  let dataBytes = 0;
  let terminal = false;
  let usage;
  let reason;
  const functions = new Map();

  function event() {
    if (!data.length) return;
    const value = data.join('\n');
    data = [];
    dataBytes = 0;
    if (terminal) throw new Error('Unexpected event after model stream termination');
    if (value === '[DONE]' && protocol === 'openai') {
      terminal = true;
      return;
    }
    const parsed = JSON.parse(value);
    if (parsed.type === 'error' || parsed.error) throw new Error('Model stream returned an error');
    if (protocol === 'anthropic') {
      if (parsed.type === 'content_block_start') {
        const block = parsed.content_block;
        if (!block || !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type) ||
            block.type === 'tool_use' && !allowedTools.has(block.name)) throw new Error('Model tool denied');
      }
      if (parsed.type === 'message_delta') {
        if (parsed.delta?.stop_reason) reason = parsed.delta.stop_reason;
        if (Number.isSafeInteger(parsed.usage?.output_tokens)) usage = parsed.usage.output_tokens;
      }
      if (parsed.type === 'message_stop') terminal = true;
    } else {
      const choice = parsed.choices?.[0];
      if (choice?.delta?.function_call) throw new Error('Legacy model function denied');
      for (const tool of choice?.delta?.tool_calls ?? []) {
        if (!Number.isSafeInteger(tool.index) || tool.index < 0 || tool.index > 24 ||
            tool.type !== undefined && tool.type !== 'function') throw new Error('Model tool denied');
        const name = (functions.get(tool.index) ?? '') + (tool.function?.name ?? '');
        if (![...allowedTools].some(candidate => candidate.startsWith(name))) throw new Error('Model tool denied');
        functions.set(tool.index, name);
      }
      const stop = choice?.finish_reason;
      if (stop) {
        if ([...functions.values()].some(name => !allowedTools.has(name))) throw new Error('Model tool denied');
        reason = stop;
      }
      if (Number.isSafeInteger(parsed.usage?.completion_tokens)) usage = parsed.usage.completion_tokens;
    }
  }

  function feed(text) {
    pending += text;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (!line) event();
      if (line.startsWith('data:')) {
        if ((dataBytes += line.length) > 4 * 1024 * 1024) throw new Error('Model event exceeds limit');
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (pending.length > 4 * 1024 * 1024) throw new Error('Model event exceeds limit');
  }

  return {
    get terminal() { return terminal; },
    push(chunk) { feed(decoder.decode(chunk, { stream: true })); },
    finish() {
      feed(decoder.decode() + '\n\n');
      if (!terminal || !Number.isSafeInteger(usage) || usage < 0 ||
          !['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'stop', 'tool_calls', 'length'].includes(reason)) {
        throw new Error('Model stream missing terminal usage or outcome');
      }
      return { usage, reason };
    },
  };
}
