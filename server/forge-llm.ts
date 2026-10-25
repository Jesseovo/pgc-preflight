import { activeModelProfile, decryptKey } from './settings';
import { modelTransport } from './model';

export class LLMError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

export function providerStatus(_env: unknown, cfg: Record<string, string>) {
  return { anthropic: false, anthropic_compat: false, openai: Boolean(cfg.openai_model) };
}

export function activeModel(cfg: Record<string, string>) { return cfg.openai_model || cfg.anthropic_model || '（未配置）'; }

function jsonTail(schema: unknown) {
  return schema ? '\n\n只输出一个 JSON 对象，不要任何解释或代码块标记。它必须符合这个 JSON Schema：\n' + JSON.stringify(schema) : '';
}

function toMessages(system: string, user: unknown, schema: unknown) {
  const parts = typeof user === 'string' ? [{ type: 'text', text: user }] : user as Array<Record<string, string>>;
  const content = (parts || []).map(part => part.type === 'image'
    ? { type: 'image_url', image_url: { url: part.data } }
    : { type: 'text', text: part.text || '' });
  if (schema) content.push({ type: 'text', text: jsonTail(schema) });
  return [{ role: 'system', content: system }, { role: 'user', content }];
}

async function keyedRequestId(base: string | undefined, messages: unknown) {
  if (!base) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(messages));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const suffix = Array.from(digest.slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${base}-${suffix}`;
}

export async function complete(env: { modelStore: { get(): Promise<any> }; SETTINGS_KEY: string }, _cfg: Record<string, string>, req: { system: string; user: unknown; schema?: unknown; maxTokens?: number; timeoutMs?: number; idempotencyKey?: string }) {
  const configured = await env.modelStore.get();
  const active = activeModelProfile(configured);
  if (!active?.profile.enabled || !active.profile.encryptedKey) throw new LLMError('管理员尚未配置并启用审核模型。', 503);
  let apiKey: string;
  try { apiKey = await decryptKey(active.profile.encryptedKey, env.SETTINGS_KEY); }
  catch { throw new LLMError('审核模型密钥无法读取，请在管理页重新保存配置。', 503); }
  try {
    const messages = toMessages(req.system, req.user, req.schema) as any;
    const idempotencyKey = await keyedRequestId(req.idempotencyKey, messages);
    let lastError: unknown;
    let freshRequest = false;
    // Riffle uses 409 while the same API key is already processing another
    // idempotent request. Parse failures get a fresh idempotency key so a
    // truncated or non-JSON model response is regenerated instead of replayed.
    const attempts = req.idempotencyKey ? 5 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const attemptKey = idempotencyKey && freshRequest ? `${idempotencyKey}-retry-${attempt}` : idempotencyKey;
      const transport = modelTransport({ baseUrl: active.profile.baseUrl, model: active.profile.model, protocol: active.profile.protocol || 'openai', apiKey }, { maxTokens: req.maxTokens, timeoutMs: req.timeoutMs || 90000, idempotencyKey: attemptKey });
      try {
        const text = await transport(messages);
        if (!req.schema) return text;
        return parseJson(text);
      } catch (error) {
        lastError = error;
        const message = String(error instanceof Error ? error.message : error);
        const parseFailure = /模型返回的不是合法 JSON/.test(message);
        const emptyResponse = /模型没有返回可读的审核内容/.test(message);
        const busy = /返回 409|\b409\b/.test(message);
        if (attempt + 1 >= attempts || (!parseFailure && !emptyResponse && !busy)) throw error;
        freshRequest = parseFailure || emptyResponse;
        await new Promise(resolve => setTimeout(resolve, parseFailure || emptyResponse ? 1200 : 5000 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('模型调用失败。');
  } catch (error) {
    if (error instanceof LLMError) throw error;
    throw new LLMError(error instanceof Error ? error.message : '模型调用失败。');
  }
}

export function parseJson(text: string): any {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); }
  catch {
    // Models sometimes add a short preamble, a trailing sentence, or a
    // second example object around the requested JSON. Find balanced objects
    // while respecting quoted braces instead of slicing from the first `{` to
    // the last `}`, which can make an otherwise valid response unparsable.
    for (let start = 0; start < cleaned.length; start++) {
      if (cleaned[start] !== '{') continue;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let end = start; end < cleaned.length; end++) {
        const char = cleaned[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') { quoted = true; continue; }
        if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
          try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { break; }
        }
      }
    }
    throw new LLMError('模型返回的不是合法 JSON。', 502);
  }
}
