import { activeModelProfile, decryptKey } from './settings';
import type { ModelConfig, ModelPurpose } from './settings';
import { modelTransport, ModelOutputError } from './model';
import type { ModelThrottleDatabase } from './model-throttle';
import { inferenceOptions } from '../src/model-options';

export class LLMError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

export function providerStatus(_env: unknown, cfg: Record<string, string>) {
  return { anthropic: false, anthropic_compat: false, openai: Boolean(cfg.openai_model) };
}

export function activeModel(cfg: Record<string, string>) { return cfg.openai_model || cfg.anthropic_model || '（未配置）'; }

function jsonTail(schema: unknown) {
  return schema ? '\n\n只输出一个 JSON 数据对象，不要返回 Schema、解释或代码块，不要用 report/data/result 再包一层。根对象直接包含顶层 properties 定义的字段；嵌套对象保持 Schema 规定的层级。严格按字段类型输出；字符串必须是字符串，字符串数组只能包含字符串，空列表用 []。不要尾随逗号；字符串内换行写成 \\n。它必须符合这个 JSON Schema：\n' + JSON.stringify(schema) : '';
}

// A text-only model gets a note in place of the screenshots, so the report
// says its visual judgement rests on the source and the run log.
export function withoutImages(user: unknown) {
  if (typeof user === 'string') return user;
  const parts = user as Array<Record<string, string>>;
  const images = parts.filter(part => part.type === 'image').length;
  // Drop the "截图：…" captions that only introduced an image.
  const rest = parts.filter((part, i) => part.type !== 'image' && parts[i + 1]?.type !== 'image');
  return images ? [{ type: 'text', text: `（当前审核模型不能看图片，${images} 张截图没有发送。美学请依据源码里的绘制代码和运行记录判断，并在报告里说明这一点。）` }, ...rest] : rest;
}

export function routedModel(config: ModelConfig | null, purpose: ModelPurpose) {
  return activeModelProfile(config, purpose)?.profile.model || '';
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

export async function complete(env: { modelStore: { get(): Promise<any> }; SETTINGS_KEY: string; DB?: ModelThrottleDatabase; generation?: {id:string;deadline:number;capacityReserved?:boolean;onUncertain?():void;onStart():Promise<void>;onWait(message:string):Promise<void>} }, _cfg: Record<string, string>, req: { system: string; user: unknown; schema?: unknown; normalize?: (value:any)=>any; validate?: (value: any) => string[]; maxTokens?: number; timeoutMs?: number; deadline?: number; idempotencyKey?: string; onWait?: (message: string) => Promise<void>; onStart?: () => Promise<void>; onProgress?: (characters: number) => Promise<void>; maxAttempts?: number; outputEffort?: 'low'; purpose?: ModelPurpose; requiredProfile?: 'opus'; outputFormat?: 'html' }) {
  const configured = await env.modelStore.get();
  const active = activeModelProfile(configured, req.purpose || 'create');
  if (req.requiredProfile && (!active || active.profile.protocol !== 'anthropic' || !/^claude-opus-5-5$/i.test(active.profile.model))) throw new LLMError('游戏制作必须使用 Claude Opus 5.5，请在管理页保存并启用对应配置。', 409);
  if (!active?.profile.enabled || !active.profile.encryptedKey) throw new LLMError(req.purpose === 'review' ? '管理员尚未配置并启用审核模型。' : '管理员尚未配置并启用创作模型。', 503);
  if(env.generation){
    const original=req, task=env.generation;
    req={...req,idempotencyKey:`pgc-create-${task.id}`,deadline:Math.min(req.deadline??Infinity,task.deadline),maxAttempts:req.maxAttempts??3,
      timeoutMs:Math.max(req.timeoutMs||90000,/opus|claude/i.test(active.profile.model)?300000:180000),
      onStart:async()=>{await task.onStart();await original.onStart?.();},
      onWait:async(message)=>{await task.onWait(message);await original.onWait?.(message);},
    };
  }
  if (active.profile.vision === false) req = { ...req, user: withoutImages(req.user) };
  let apiKey: string;
  try { apiKey = await decryptKey(active.profile.encryptedKey, env.SETTINGS_KEY); }
  catch { throw new LLMError('审核模型密钥无法读取，请在管理页重新保存配置。', 503); }
  try {
    const messages = toMessages(req.system, req.user, req.schema) as any;
    let retryHint = '';
    const inference = inferenceOptions(active.profile, req.purpose, req.maxTokens);
    let maxTokens = inference.maxTokens;
    let lastError: unknown;
    let freshRequest = false;
    // Only explicitly pending idempotent requests are retried by transport.
    // Other gateway conflicts must preserve their exact cause. Completed but
    // unusable outputs get a fresh key and format feedback for regeneration.
    const attempts = req.maxAttempts ?? (req.idempotencyKey ? 3 : 1);
    // A Queue consumer has a finite wall-clock lifetime. Leave time to persist
    // an actionable error rather than being killed during the final retry.
    const deadline = Math.min(req.deadline ?? Infinity, Date.now() + 12 * 60 * 1000);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (Date.now() >= deadline) throw new LLMError('模型处理时限已到，本次未生成完整报告，请重试。', 504);
      const attemptMessages = retryHint ? [...messages, { role: 'user', content: retryHint }] : messages;
      const idempotencyKey = await keyedRequestId(req.idempotencyKey, attemptMessages);
      const attemptKey = idempotencyKey && freshRequest ? `${idempotencyKey}-retry-${attempt}` : idempotencyKey;
      const stream = req.purpose === 'game' || req.purpose === 'assets';
      const remaining = Math.max(1, deadline - Date.now());
      const runId=crypto.randomUUID();
      const transport = modelTransport({ ...active.profile, apiKey }, {
        DB: env.DB, maxTokens,
        // A non-streaming request has no activity until the entire artifact
        // is ready. It must use the durable task deadline, not the 5-minute
        // idle timer intended for streams that send keep-alives.
        timeoutMs: env.generation && !stream ? remaining : req.timeoutMs || 90000,
        totalTimeoutMs: remaining, idempotencyKey: attemptKey,
        json: Boolean(req.schema), purpose:req.purpose, outputEffort:req.outputEffort,
        // Riffle's Anthropic stream relay can fail with an upstream 503 before
        // any text arrives. Keep streaming only for long artifacts that need
        // live heartbeats; bounded admin generations use one JSON response.
        stream,
        onStart: req.onStart, capacityReserved:env.generation?.capacityReserved,onUncertain:env.generation?.onUncertain,
        onProgress: req.onProgress,
        onActivity: req.onWait ? (phase, characters) => req.onWait!(phase === 'thinking' ? '模型正在思考，连接正常，尚未输出正文…' : `模型正在输出，已接收 ${characters.toLocaleString('en-US')} 个字符…`) : undefined,
        onMetrics: async metrics => {
          if (!env.DB) return;
          await env.DB.prepare('INSERT INTO model_runs (id,profile_id,model,purpose,status,effort,max_tokens,input_tokens,output_tokens,reasoning_tokens,first_text_ms,elapsed_ms,characters,finish_reason,error,created_at,capacity_wait_ms,throttle_wait_ms,retry_wait_ms,request_ms,first_response_ms,first_text_from_request_ms,first_text_kind,attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .bind(runId,active.id,active.profile.model,req.purpose || 'create',metrics.status,metrics.effort,metrics.maxTokens,metrics.inputTokens,metrics.outputTokens,metrics.reasoningTokens,metrics.firstTextMs,metrics.elapsedMs,metrics.characters,metrics.finishReason,metrics.error,new Date().toISOString(),metrics.capacityWaitMs,metrics.throttleWaitMs,metrics.retryWaitMs,metrics.requestMs,metrics.firstResponseMs,metrics.firstTextFromRequestMs,metrics.firstTextKind,metrics.attempts).run();
        },
        onWait: req.onWait ? (ms, reason) => req.onWait!(ms ? `${reason === 'rate_limit' ? '模型接口限流，正在自动等待恢复' : reason === 'unavailable' ? '模型上游暂时繁忙，正在等待恢复' : reason === 'pending' ? '模型网关仍在处理同一请求，正在等待结果' : '同一模型的请求正在排队'}，约 ${Math.ceil(ms / 1000)} 秒后继续。` : '') : undefined,
      });
      try {
        const text = await transport(attemptMessages);
        if (!req.schema) return text;
        const parsed = parseJson(text),value=req.normalize?req.normalize(parsed):parsed;
        const errors = req.validate?.(value) || [];
        if (errors.length){
          const known=new Set(['report','result','data','final_report','review','final','scores','aes','ease','play','score_reasons','uncertainties','verdict','reviewer_comment','fix_prompt','strengths','issues','properties','type','required','verification','$schema']);
          const shape=value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).slice(0,12).map(k=>known.has(k)?k:'[其他字段]').join(','):Array.isArray(value)?'array':typeof value;
          throw new ModelOutputError(`模型评分报告字段不完整或格式错误：${errors.join('、')}。根结构：${shape}`, 'format');
        }
        return value;
      } catch (error) {
        lastError = error;
        const message = String(error instanceof Error ? error.message : error);
        const parseFailure = !env.generation && /模型返回的不是合法 JSON/.test(message);
        const outputFailure = !env.generation && error instanceof ModelOutputError && error.kind !== 'incomplete';
        if(env.DB&&(parseFailure||outputFailure)){
          // A completed HTTP stream can still be an unusable report. Log only
          // structural field names, never source, provider output or reasoning.
          const detail=error instanceof ModelOutputError&&error.kind==='format'?message.slice(0,250):parseFailure?'模型返回的不是合法 JSON。':`模型输出未通过校验（${(error as ModelOutputError).kind}）。`;
          await env.DB.prepare("UPDATE model_runs SET status='error',error=? WHERE id=?").bind(detail,runId).run().catch(()=>{});
        }
        // All HTTP retry decisions belong to transport. A second retry loop
        // would multiply 503 calls and replay interrupted paid generations.
        if (attempt + 1 >= attempts || deadline - Date.now() < 30000 || (!parseFailure && !outputFailure)) throw error;
        if (parseFailure || outputFailure) {
          freshRequest = true;
          retryHint = req.outputFormat === 'html'
            ? `上次输出不完整：${message} 请重新输出完整自包含 HTML 游戏，缩减实现以适应输出预算，保留完整核心循环。只输出 HTML，不要 JSON、解释或 Markdown。`
            : req.schema ? `上次生成未能交付完整报告：${message} 请根据原始材料重新生成完整 JSON 对象，严格使用给定字段和类型，内容简洁，保留所有必需字段；不要输出思考过程、Markdown 或解释。不得编造分数或证据。`
              : `上次输出不完整：${message} 请按原始要求重新完整输出，内容简洁，不要改成 JSON。`;
          if (error instanceof ModelOutputError && error.kind === 'truncated') {
            // Review stages already receive their full 24k contract budget.
            // Only a deliberately smaller direct call may grow once; never
            // turn a production stage into an unbounded paid retry.
            const reviewCap = req.purpose === 'review' || req.purpose === 'review_verify'
              ? Math.min(24000, Math.max(req.maxTokens ?? inference.maxTokens, 1) * 2)
              : maxTokens * 2;
            maxTokens = Math.min(inference.capability.maxOutput, active.profile.maxOutputTokens || inference.capability.maxOutput, reviewCap);
          }
          await req.onWait?.(`模型报告未完整生成，正在重新生成（${attempt + 2}/${attempts}）。`);
        } else await req.onWait?.('模型接口暂不可用，正在等待恢复。');
        await new Promise(resolve => setTimeout(resolve, parseFailure || outputFailure ? 1200 : 5000 * (attempt + 1)));
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
