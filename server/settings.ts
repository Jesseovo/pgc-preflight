export interface ModelConfig { baseUrl: string; model: string; encryptedKey: string; enabled: boolean; updatedAt: string }
export interface ModelRuntime { baseUrl: string; model: string; apiKey: string }
export interface ConfigStore { get(): Promise<ModelConfig | null>; set(config: ModelConfig): Promise<void> }
export interface AppSecrets { ADMIN_PASSWORD: string; SETTINGS_KEY: string }

const encoder = new TextEncoder();
function toBase64(bytes: Uint8Array): string { let s = ''; for (const byte of bytes) s += String.fromCharCode(byte); return btoa(s); }
function fromBase64(text: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(text), char => char.charCodeAt(0)); }
async function encryptionKey(secret: string) { return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function encryptKey(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(value));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}
export async function decryptKey(value: string, secret: string): Promise<string> {
  const [iv, ciphertext] = value.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await encryptionKey(secret), fromBase64(ciphertext)));
}
export function validateModelFields(value: unknown): { baseUrl: string; model: string; apiKey: string; enabled: boolean } {
  const fields = value as Record<string, unknown>;
  if (!fields || typeof fields !== 'object') throw new Error('请填写模型配置。');
  if (typeof fields.baseUrl !== 'string' || typeof fields.model !== 'string') throw new Error('请填写接口地址和模型名称。');
  const baseUrl = fields.baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('接口地址格式不正确。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) throw new Error('模型接口需要使用公开的 HTTPS 地址。');
  if (!fields.model.trim() || fields.model.length > 150) throw new Error('模型名称不能为空或过长。');
  if (fields.apiKey !== undefined && typeof fields.apiKey !== 'string') throw new Error('API Key 格式不正确。');
  const apiKey = String(fields.apiKey || '').trim();
  if (apiKey.length > 2000) throw new Error('API Key 过长。');
  return { baseUrl, model: fields.model.trim(), apiKey, enabled: fields.enabled !== false };
}
export async function resolveModel(config: ModelConfig | null, secret: string): Promise<ModelRuntime | null> {
  if (!config?.enabled || !config.encryptedKey) return null;
  return { baseUrl: config.baseUrl, model: config.model, apiKey: await decryptKey(config.encryptedKey, secret) };
}
export async function saveConfig(body: unknown, store: ConfigStore, secret: string): Promise<ModelConfig> {
  const fields = validateModelFields(body);
  const previous = await store.get();
  if (!fields.apiKey && !previous?.encryptedKey) throw new Error('首次配置需要填写 API Key。');
  if (!fields.apiKey && previous && fields.baseUrl !== previous.baseUrl) throw new Error('更换接口地址时请重新填写 API Key，避免把旧密钥发送到新地址。');
  const config = { baseUrl: fields.baseUrl, model: fields.model, enabled: fields.enabled, encryptedKey: fields.apiKey ? await encryptKey(fields.apiKey, secret) : previous!.encryptedKey, updatedAt: new Date().toISOString() };
  await store.set(config);
  return config;
}
export function publicConfig(config: ModelConfig | null) { return config ? { baseUrl: config.baseUrl, model: config.model, enabled: config.enabled, hasKey: !!config.encryptedKey, updatedAt: config.updatedAt } : { baseUrl: '', model: '', enabled: true, hasKey: false, updatedAt: '' }; }

async function hmac(text: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
async function sameSecret(a: string, b: string): Promise<boolean> { const x = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(a))); const y = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(b))); let diff = 0; for (let i=0;i<x.length;i++) diff |= x[i] ^ y[i]; return diff === 0; }
export async function login(password: string, secrets: AppSecrets): Promise<string | null> {
  if (!secrets.ADMIN_PASSWORD || !await sameSecret(password, secrets.ADMIN_PASSWORD)) return null;
  const expires = String(Date.now() + 8 * 60 * 60 * 1000);
  return `${expires}.${await hmac(expires, `${secrets.SETTINGS_KEY}:${secrets.ADMIN_PASSWORD}`)}`;
}
export async function authorized(cookie: string | null, secrets: AppSecrets): Promise<boolean> {
  if (!secrets.ADMIN_PASSWORD || !secrets.SETTINGS_KEY) return false;
  const token = cookie?.match(/(?:^|;\s*)pgc_admin=([^;]+)/)?.[1];
  if (!token) return false;
  const [expires, signature] = token.split('.');
  if (!expires || !signature || Number(expires) <= Date.now() || Number(expires) > Date.now() + 8*60*60*1000) return false;
  return sameSecret(signature, await hmac(expires, `${secrets.SETTINGS_KEY}:${secrets.ADMIN_PASSWORD}`));
}
