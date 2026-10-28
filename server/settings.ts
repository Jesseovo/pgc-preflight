import { modelCapabilities, type InferenceOptions } from '../src/model-options';
export type ModelProtocol = 'openai' | 'anthropic';
export type ModelProfileId = string;
// `vision: false` marks a text-only model: review then sends no screenshots.
export interface StoredModelProfile extends InferenceOptions { name?: string; baseUrl: string; model: string; protocol: ModelProtocol; encryptedKey: string; enabled: boolean; updatedAt: string; vision?: boolean }
// Stages keep their own budgets and progress, but share just two model groups.
export const MODEL_PURPOSES = ['review', 'review_verify', 'create', 'expand', 'brief', 'assets', 'preview', 'game', 'tags', 'vocab'] as const;
const MODEL_GROUPS = ['review', 'create'] as const;
export type ModelPurpose = typeof MODEL_PURPOSES[number];
export type ModelRoutes = Partial<Record<ModelPurpose, ModelProfileId>>;
// The top-level fields keep old rows and callers compatible. New rows also
// carry both encrypted profiles so switching models never requires retyping a
// key or replacing the currently active configuration.
export interface ModelConfig extends StoredModelProfile { activeProfile?: ModelProfileId; profiles?: Partial<Record<ModelProfileId, StoredModelProfile>>; routes?: ModelRoutes }
export interface ModelRuntime extends InferenceOptions { baseUrl: string; model: string; protocol?: ModelProtocol; apiKey: string }
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
export function validateModelFields(value: unknown): { baseUrl: string; model: string; protocol: ModelProtocol; apiKey: string; enabled: boolean; vision: boolean } & InferenceOptions {
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
  const capability = modelCapabilities({baseUrl, model:fields.model.trim(), protocol});
  const effort = fields.effort ?? 'auto';
  if (effort !== 'auto' && !(capability.efforts as readonly unknown[]).includes(effort)) throw new Error('该模型不支持所选思考强度，请选择自动或支持的等级。');
  const maxOutputTokens = fields.maxOutputTokens ?? 0;
  if (typeof maxOutputTokens !== 'number' || !Number.isInteger(maxOutputTokens) || maxOutputTokens !== 0 && (maxOutputTokens < 1024 || maxOutputTokens > capability.maxOutput)) throw new Error(`输出上限应为 1024–${capability.maxOutput} Token，或选择自动。`);
  return { baseUrl, model: fields.model.trim(), protocol, apiKey, enabled: fields.enabled !== false, vision: fields.vision !== false, effort: effort as InferenceOptions['effort'], maxOutputTokens };
}

const PROFILE_DEFAULTS: Record<string, Pick<StoredModelProfile, 'name' | 'baseUrl' | 'model' | 'protocol'>> = {
  deepseek: { name: 'DeepSeek', baseUrl: '', model: 'deepseek-chat', protocol: 'openai' },
  opus: { name: 'Claude Opus 5.5', baseUrl: 'https://riffle-api.pages.dev', model: 'claude-opus-5-5', protocol: 'anthropic' },
};
export const MODEL_PROFILES = ['deepseek', 'opus'] as const;
export function profileId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) throw new Error('模型配置标识不正确。');
  return value;
}

export function modelProfiles(config: ModelConfig | null): Partial<Record<ModelProfileId, StoredModelProfile>> {
  if (!config) return {};
  const profiles: Partial<Record<ModelProfileId, StoredModelProfile>> = { ...(config.profiles || {}) };
  // Upgrade the original single-profile row in memory. It is persisted with
  // the next save or switch and never exposes the encrypted key.
  if (!Object.keys(profiles).length && config.baseUrl && config.encryptedKey) {
    profiles.deepseek = {
      baseUrl: config.baseUrl, model: config.model, protocol: config.protocol || 'openai',
      encryptedKey: config.encryptedKey, enabled: config.enabled, updatedAt: config.updatedAt, vision: config.vision, effort: config.effort, maxOutputTokens:config.maxOutputTokens,
    };
  }
  return profiles;
}

export function activeModelProfile(config: ModelConfig | null, purpose?: ModelPurpose): { id: ModelProfileId; profile: StoredModelProfile } | null {
  const profiles = modelProfiles(config);
  const group = purpose === 'review' || purpose === 'review_verify' ? 'review' : 'create';
  const routed = purpose ? config?.routes?.[group] : undefined;
  if (purpose === 'game') {
    // Production must remain on Opus even when other creation tasks use a
    // different provider. Reuse any enabled Opus profile and its saved Key.
    const ids = [...new Set([routed, config?.activeProfile, 'opus', ...Object.keys(profiles)])];
    for (const id of ids) {
      const profile = id ? profiles[id] : undefined;
      if (profile?.enabled && profile.encryptedKey && profile.protocol === 'anthropic' && /^claude-opus-5-5$/i.test(profile.model)) return { id: id!, profile };
    }
    return null;
  }
  if (routed && profiles[routed]) return { id: routed, profile: profiles[routed]! };
  const preferred = config?.activeProfile && profiles[config.activeProfile] ? config.activeProfile : Object.keys(profiles)[0];
  const profile = profiles[preferred];
  return profile ? { id: preferred, profile } : null;
}

function configWithProfiles(profiles: Partial<Record<ModelProfileId, StoredModelProfile>>, activeProfile: ModelProfileId, routes?: ModelRoutes): ModelConfig {
  if (!profiles[activeProfile]) activeProfile = Object.keys(profiles)[0];
  const active = profiles[activeProfile];
  if (!active) throw new Error('请先保存至少一个模型配置。');
  return { ...active, activeProfile, profiles, ...(routes && Object.keys(routes).length ? { routes } : {}) };
}

export async function saveRoutes(body: unknown, store: ConfigStore): Promise<ModelConfig> {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const previous = await store.get();
  const profiles = modelProfiles(previous);
  const routes: ModelRoutes = Object.fromEntries(MODEL_GROUPS.filter(group => previous?.routes?.[group]).map(group => [group, previous!.routes![group]]));
  for (const purpose of MODEL_GROUPS) {
    const value = raw[purpose];
    if (!Object.hasOwn(raw, purpose)) continue;
    if (value === '' || value == null) { delete routes[purpose]; continue; }
    const id = profileId(value);
    if (!profiles[id]?.encryptedKey) throw new Error('模型用途设置不正确：该模型还没有保存 API Key，不能分配用途。');
    if (!profiles[id]?.enabled) throw new Error('请先启用模型，再分配用途。');
    routes[purpose] = id;
  }
  const active = Object.hasOwn(raw, 'activeProfile') ? profileId(raw.activeProfile) : previous?.activeProfile || 'deepseek';
  if (!profiles[active]?.enabled || !profiles[active]?.encryptedKey) throw new Error('默认模型需要已启用并保存 API Key。');
  const config = configWithProfiles(profiles, active, routes);
  await store.set(config);
  return config;
}

export async function resolveModel(config: ModelConfig | null, secret: string): Promise<ModelRuntime | null> {
  const active = activeModelProfile(config);
  if (!active?.profile.enabled || !active.profile.encryptedKey) return null;
  return { ...active.profile, apiKey: await decryptKey(active.profile.encryptedKey, secret) };
}
export async function saveConfig(body: unknown, store: ConfigStore, secret: string): Promise<ModelConfig> {
  const fields = validateModelFields(body);
  const previous = await store.get();
  const requested = (body as Record<string, unknown>)?.profile;
  const id = profileId(requested ?? 'deepseek');
  const profiles = modelProfiles(previous);
  const current = profiles[id];
  if (!current && Object.keys(profiles).length >= 24) throw new Error('最多保存 24 个模型配置。');
  const name = String((body as Record<string, unknown>).name ?? current?.name ?? PROFILE_DEFAULTS[id]?.name ?? fields.model).trim();
  if (!name || name.length > 60) throw new Error('显示名称需要 1–60 个字符。');
  if (!fields.apiKey && !current?.encryptedKey) throw new Error('首次配置需要填写 API Key。');
  if (!fields.apiKey && current && (fields.baseUrl !== current.baseUrl || fields.protocol !== current.protocol)) throw new Error('更换接口地址或协议时，请重新填写 API Key，避免把旧密钥发送到新地址。');
  const updatedAt = new Date().toISOString();
  profiles[id] = { name, baseUrl: fields.baseUrl, model: fields.model, protocol: fields.protocol, enabled: fields.enabled, vision: fields.vision, effort:fields.effort, maxOutputTokens:fields.maxOutputTokens, encryptedKey: fields.apiKey ? await encryptKey(fields.apiKey, secret) : current!.encryptedKey, updatedAt };
  const active = previous?.activeProfile || (previous ? Object.keys(profiles)[0] : id);
  const config = configWithProfiles(profiles, active, previous?.routes);
  await store.set(config);
  return config;
}
export async function activateProfile(value: unknown, store: ConfigStore): Promise<ModelConfig> {
  const id = profileId(value);
  const previous = await store.get();
  const profiles = modelProfiles(previous);
  if (!profiles[id]?.encryptedKey) throw new Error('这个模型还没有保存 API Key，请先保存配置。');
  if (!profiles[id]?.enabled) throw new Error('请先启用这个模型。');
  const config = configWithProfiles(profiles, id, previous?.routes);
  await store.set(config);
  return config;
}
export async function deleteProfile(value: unknown, store: ConfigStore): Promise<ModelConfig> {
  const id = profileId(value);
  const previous = await store.get();
  const profiles = modelProfiles(previous);
  if (!profiles[id]) throw new Error('模型配置不存在。');
  if ([activeModelProfile(previous)?.id, ...MODEL_GROUPS.map(group => activeModelProfile(previous, group)?.id), activeModelProfile(previous, 'game')?.id].includes(id)) throw new Error('该模型正在被使用，请先更换对应模型；游戏制作需要保留可用的 Opus 5.5 配置。');
  delete profiles[id];
  const config = configWithProfiles(profiles, previous!.activeProfile || Object.keys(profiles)[0], previous?.routes);
  await store.set(config);
  return config;
}
export function publicConfig(config: ModelConfig | null) {
  const active = activeModelProfile(config);
  const profiles = modelProfiles(config);
  const publicProfiles = Object.fromEntries([...new Set([...MODEL_PROFILES, ...Object.keys(profiles)])].map(id => {
    const p = profiles[id];
    return [id, p ? { name: p.name || PROFILE_DEFAULTS[id]?.name || p.model, baseUrl: p.baseUrl, model: p.model, protocol: p.protocol || 'openai', enabled: p.enabled, vision: p.vision !== false, effort:p.effort || 'auto', maxOutputTokens:p.maxOutputTokens || 0, hasKey: !!p.encryptedKey, keySuffix:'', updatedAt: p.updatedAt } : { ...PROFILE_DEFAULTS[id], enabled: true, vision: true, hasKey: false, keySuffix:'', updatedAt: '' }];
  }));
  const routes = Object.fromEntries(MODEL_GROUPS.map(group => [group, config?.routes?.[group] || '']));
  const effective = Object.fromEntries(MODEL_PURPOSES.map(purpose => [purpose, activeModelProfile(config, purpose)?.id || '']));
  return { baseUrl: active?.profile.baseUrl || '', model: active?.profile.model || '', protocol: active?.profile.protocol || 'openai', enabled: active?.profile.enabled ?? true, hasKey: !!active?.profile.encryptedKey, updatedAt: active?.profile.updatedAt || '', activeProfile: active?.id || 'deepseek', profiles: publicProfiles, routes, effective };
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
