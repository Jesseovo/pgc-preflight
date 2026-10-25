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

export async function complete(env: { modelStore: { get(): Promise<any> }; SETTINGS_KEY: string }, _cfg: Record<string, string>, req: { system: string; user: unknown; schema?: unknown; maxTokens?: number }) {
  const configured = await env.modelStore.get();
  const active = activeModelProfile(configured);
  if (!active?.profile.enabled || !active.profile.encryptedKey) throw new LLMError('管理员尚未配置并启用审核模型。', 503);
  let apiKey: string;
  try { apiKey = await decryptKey(active.profile.encryptedKey, env.SETTINGS_KEY); }
  catch { throw new LLMError('审核模型密钥无法读取，请在管理页重新保存配置。', 503); }
  try {
    const transport = modelTransport({ baseUrl: active.profile.baseUrl, model: active.profile.model, protocol: active.profile.protocol || 'openai', apiKey }, { maxTokens: req.maxTokens, timeoutMs: active.profile.protocol === 'anthropic' ? 120000 : 90000 });
    const text = await transport(toMessages(req.system, req.user, req.schema) as any);
    if (!req.schema) return text;
    return parseJson(text);
  } catch (error) {
    if (error instanceof LLMError) throw error;
    throw new LLMError(error instanceof Error ? error.message : '模型调用失败。');
  }
}

export function parseJson(text: string): any {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); }
  catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
    }
    throw new LLMError('模型返回的不是合法 JSON。', 502);
  }
}
