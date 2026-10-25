export type ModelProtocol = 'openai' | 'anthropic';
export type ModelProfileId = 'deepseek' | 'opus';
export interface StoredModelProfile { baseUrl: string; model: string; protocol: ModelProtocol; encryptedKey: string; enabled: boolean; updatedAt: string }
// The top-level fields keep old rows and callers compatible. New rows also
// carry both encrypted profiles so switching models never requires retyping a
// key or replacing the currently active configuration.
export interface ModelConfig extends StoredModelProfile { activeProfile?: ModelProfileId; profiles?: Partial<Record<ModelProfileId, StoredModelProfile>> }
export interface ModelRuntime { baseUrl: string; model: string; protocol?: ModelProtocol; apiKey: string }
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
export function validateModelFields(value: unknown): { baseUrl: string; model: string; protocol: ModelProtocol; apiKey: string; enabled: boolean } {
  const fields = value as Record<string, unknown>;
  if (!fields || typeof fields !== 'object') throw new Error('请填写模型配置。');
  if (typeof fields.baseUrl !== 'string' || typeof fields.model !== 'string') throw new Error('请填写接口地址和模型名称。');
  const protocol: ModelProtocol = fields.protocol === 'anthropic' ? 'anthropic' : 'openai';
  let baseUrl = fields.baseUrl.trim().replace(/\/+$/, '');
  baseUrl = protocol === 'anthropic'
    ? baseUrl.replace(/\/v1\/messages$/, '').replace(/\/v1$/, '')
    : baseUrl.replace(/\/chat\/completions$/, '');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('接口地址格式不正确。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) throw new Error('模型接口需要使用公开的 HTTPS 地址。');
  if (!fields.model.trim() || fields.model.length > 150) throw new Error('模型名称不能为空或过长。');
  if (fields.apiKey !== undefined && typeof fields.apiKey !== 'string') throw new Error('API Key 格式不正确。');
  const apiKey = String(fields.apiKey || '').trim();
  if (apiKey.length > 2000) throw new Error('API Key 过长。');
  return { baseUrl, model: fields.model.trim(), protocol, apiKey, enabled: fields.enabled !== false };
}

const PROFILE_DEFAULTS: Record<ModelProfileId, Pick<StoredModelProfile, 'baseUrl' | 'model' | 'protocol'>> = {
  deepseek: { baseUrl: '', model: 'deepseek-chat', protocol: 'openai' },
  opus: { baseUrl: 'https://riffle-api.pages.dev', model: 'claude-opus-5-5', protocol: 'anthropic' },
};
export const MODEL_PROFILES = ['deepseek', 'opus'] as const;

export function modelProfiles(config: ModelConfig | null): Partial<Record<ModelProfileId, StoredModelProfile>> {
  if (!config) return {};
  const profiles: Partial<Record<ModelProfileId, StoredModelProfile>> = { ...(config.profiles || {}) };
  // Upgrade the original single-profile row in memory. It is persisted with
  // the next save or switch and never exposes the encrypted key.
  if (!profiles.deepseek && config.baseUrl && config.encryptedKey) {
    profiles.deepseek = {
      baseUrl: config.baseUrl, model: config.model, protocol: config.protocol || 'openai',
      encryptedKey: config.encryptedKey, enabled: config.enabled, updatedAt: config.updatedAt,
    };
  }
  return profiles;
}

export function activeModelProfile(config: ModelConfig | null): { id: ModelProfileId; profile: StoredModelProfile } | null {
  const profiles = modelProfiles(config);
  const preferred: ModelProfileId = config?.activeProfile && profiles[config.activeProfile] ? config.activeProfile : profiles.deepseek ? 'deepseek' : 'opus';
  const profile = profiles[preferred];
  return profile ? { id: preferred, profile } : null;
}

function configWithProfiles(profiles: Partial<Record<ModelProfileId, StoredModelProfile>>, activeProfile: ModelProfileId): ModelConfig {
  const active = profiles[activeProfile] || profiles.deepseek || profiles.opus;
  if (!active) throw new Error('请先保存至少一个模型配置。');
  return { ...active, activeProfile, profiles };
}

export async function resolveModel(config: ModelConfig | null, secret: string): Promise<ModelRuntime | null> {
  const active = activeModelProfile(config);
  if (!active?.profile.enabled || !active.profile.encryptedKey) return null;
  return { baseUrl: active.profile.baseUrl, model: active.profile.model, protocol: active.profile.protocol || 'openai', apiKey: await decryptKey(active.profile.encryptedKey, secret) };
}
export async function saveConfig(body: unknown, store: ConfigStore, secret: string): Promise<ModelConfig> {
  const fields = validateModelFields(body);
  const previous = await store.get();
  const requested = (body as Record<string, unknown>)?.profile;
  const profileId: ModelProfileId = requested === 'opus' ? 'opus' : 'deepseek';
  const profiles = modelProfiles(previous);
  const current = profiles[profileId];
  if (!fields.apiKey && !current?.encryptedKey) throw new Error('首次配置需要填写 API Key。');
  if (!fields.apiKey && current && (fields.baseUrl !== current.baseUrl || fields.protocol !== current.protocol)) throw new Error('更换接口地址或协议时，请重新填写 API Key，避免把旧密钥发送到新地址。');
  const updatedAt = new Date().toISOString();
  profiles[profileId] = { baseUrl: fields.baseUrl, model: fields.model, protocol: fields.protocol, enabled: fields.enabled, encryptedKey: fields.apiKey ? await encryptKey(fields.apiKey, secret) : current!.encryptedKey, updatedAt };
  const active = previous?.activeProfile || (previous ? 'deepseek' : profileId);
  const config = configWithProfiles(profiles, active);
  await store.set(config);
  return config;
}
export async function activateProfile(profileId: unknown, store: ConfigStore): Promise<ModelConfig> {
  const id: ModelProfileId = profileId === 'opus' ? 'opus' : 'deepseek';
  const previous = await store.get();
  const profiles = modelProfiles(previous);
  if (!profiles[id]?.encryptedKey) throw new Error('这个模型还没有保存 API Key，请先保存配置。');
  const config = configWithProfiles(profiles, id);
  await store.set(config);
  return config;
}
export function publicConfig(config: ModelConfig | null) {
  const active = activeModelProfile(config);
  const profiles = modelProfiles(config);
  const publicProfiles = Object.fromEntries(MODEL_PROFILES.map(id => {
    const p = profiles[id];
    return [id, p ? { baseUrl: p.baseUrl, model: p.model, protocol: p.protocol || PROFILE_DEFAULTS[id].protocol, enabled: p.enabled, hasKey: !!p.encryptedKey, updatedAt: p.updatedAt } : { ...PROFILE_DEFAULTS[id], enabled: true, hasKey: false, updatedAt: '' }];
  }));
  return { baseUrl: active?.profile.baseUrl || '', model: active?.profile.model || '', protocol: active?.profile.protocol || 'openai', enabled: active?.profile.enabled ?? true, hasKey: !!active?.profile.encryptedKey, updatedAt: active?.profile.updatedAt || '', activeProfile: active?.id || 'deepseek', profiles: publicProfiles };
}

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
