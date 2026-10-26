import { activeModelProfile, decryptKey } from './settings';
import { modelTransport } from './model';
import type { ModelThrottleDatabase } from './model-throttle';

export class LLMError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

export function providerStatus(_env: unknown, cfg: Record<string, string>) {
  return { anthropic: false, anthropic_compat: false, openai: Boolean(cfg.openai_model) };
}

export function activeModel(cfg: Record<string, string>) { return cfg.openai_model || cfg.anthropic_model || '（未配置）'; }

function jsonTail(schema: unknown) {
  return schema ? '\n\n只输出一个 JSON 对象，不要任何解释或代码块标记。不要尾随逗号；字符串内换行写成 \\n。它必须符合这个 JSON Schema：\n' + JSON.stringify(schema) : '';
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

export async function complete(env: { modelStore: { get(): Promise<any> }; SETTINGS_KEY: string; DB?: ModelThrottleDatabase }, _cfg: Record<string, string>, req: { system: string; user: unknown; schema?: unknown; maxTokens?: number; timeoutMs?: number; idempotencyKey?: string; onWait?: (message: string) => Promise<void> }) {
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
    // Only explicitly pending idempotent requests are retried by transport.
    // Other gateway conflicts must preserve their exact cause. Parse failures
    // get a fresh key so a non-JSON response is regenerated instead of replayed.
    const attempts = req.idempotencyKey ? 3 : 1;
    // A Queue consumer has a finite wall-clock lifetime. Leave time to persist
    // an actionable error rather than being killed during the final retry.
    const deadline = Date.now() + 12 * 60 * 1000;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const attemptKey = idempotencyKey && freshRequest ? `${idempotencyKey}-retry-${attempt}` : idempotencyKey;
      const transport = modelTransport({ baseUrl: active.profile.baseUrl, model: active.profile.model, protocol: active.profile.protocol || 'openai', apiKey }, {
        DB: env.DB, maxTokens: req.maxTokens, timeoutMs: req.timeoutMs || 90000, totalTimeoutMs: Math.max(1, deadline - Date.now()), idempotencyKey: attemptKey,
        onWait: req.onWait ? (ms, reason) => req.onWait!(ms ? `${reason === 'rate_limit' ? '模型接口限流，正在自动等待恢复' : reason === 'pending' ? '模型网关仍在处理同一请求，正在等待结果' : '同一模型的请求正在排队'}，约 ${Math.ceil(ms / 1000)} 秒后继续。` : '') : undefined,
      });
      try {
        const text = await transport(messages);
        if (!req.schema) return text;
        return parseJson(text);
      } catch (error) {
        lastError = error;
        const message = String(error instanceof Error ? error.message : error);
        const parseFailure = /模型返回的不是合法 JSON/.test(message);
        const emptyResponse = /模型没有返回可读的审核内容/.test(message);
        // HTTP 429 and explicitly pending 409 requests are retried by transport.
        // A second retry loop would multiply requests and hit the key again.
        const busy = /返回 503/.test(message);
        if (attempt + 1 >= attempts || Date.now() >= deadline || (!parseFailure && !emptyResponse && !busy)) throw error;
        if (parseFailure || emptyResponse) freshRequest = true;
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
  const tryParse = (candidate: string) => {
    try { return JSON.parse(candidate); }
    catch {
      // Claude occasionally leaves a trailing comma in otherwise valid JSON.
      // Scan outside strings so punctuation in game copy remains untouched.
      let repaired = '';
      let quoted = false;
      let escaped = false;
      for (let i = 0; i < candidate.length; i++) {
        const char = candidate[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === ',' && /^\s*[}\]]/.test(candidate.slice(i + 1))) continue;
        repaired += char;
      }
      try { return JSON.parse(repaired); } catch { return undefined; }
    }
  };
  const direct = tryParse(cleaned);
  if (direct !== undefined) return direct;
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
        const parsed = tryParse(cleaned.slice(start, end + 1));
        if (parsed !== undefined) return parsed;
        break;
      }
    }
  }
  throw new LLMError('模型返回的不是合法 JSON。', 502);
}
