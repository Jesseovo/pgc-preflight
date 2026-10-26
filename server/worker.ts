import puppeteer from '@cloudflare/puppeteer';
import type { Browser } from 'puppeteer-core';
import { inspectGame } from './checker';
import { MAX_REQUEST_BYTES, validateInput } from './policy';
import { adminApi } from './admin-api';
import { resolveModel } from './settings';
import { modelTransport } from './model';
import {configStore,memberStore} from './storage';
import type {Database} from './storage';
import {authApi} from './auth-api';
import {identity} from './members';
import {guardCheckPage,guardForgePage,guardReviewPage} from './page-access';
import {forgeApi, processForgeJob, type ForgeJob} from './forge-api';

interface QueueMessage<T> { body: T; attempts?: number; ack(): void; retry(options?: { delaySeconds?: number }): void }
interface QueueBatch<T> { messages: QueueMessage<T>[] }
interface Env { ASSETS: { fetch(request: Request): Promise<Response> }; BROWSER: Parameters<typeof puppeteer.launch>[0]; CHECK_RATE_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> }; FORGE_RATE_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> }; FORGE_QUEUE: { send(message: ForgeJob): Promise<void> }; DB:Database; ADMIN_PASSWORD:string; SETTINGS_KEY:string }
interface WorkerContext { waitUntil(promise: Promise<unknown>): void }
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export default {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    const url = new URL(request.url);
    const store=configStore(env.DB),members=memberStore(env.DB);
    if(url.pathname.startsWith('/api/admin/')){
      if(request.method!=='GET'){const rate=await env.CHECK_RATE_LIMIT.limit({key:`admin:${request.headers.get('CF-Connecting-IP')||'unknown'}`});if(!rate.success)return json({error:'操作较频繁，请一分钟后重试。'},429);}
      return (await adminApi(request,store,env,members))!;
    }
    if(url.pathname.startsWith('/api/auth/')){
      if(request.method!=='GET'){const rate=await env.CHECK_RATE_LIMIT.limit({key:`auth:${request.headers.get('CF-Connecting-IP')||'unknown'}`});if(!rate.success)return json({error:'登录操作较频繁，请稍后重试。'},429);}
      return(await authApi(request,members,env))!;
    }
    if(url.pathname.startsWith('/api/forge/')){
      if(request.method!=='GET'){const rate=await env.FORGE_RATE_LIMIT.limit({key:`forge:${request.headers.get('CF-Connecting-IP')||'unknown'}`});if(!rate.success)return json({error:'操作较频繁，请一分钟后重试。'},429);}
      const route=url.pathname.slice('/api/forge/'.length).split('/').filter(Boolean);
      return forgeApi(request,{DB:env.DB,ADMIN_PASSWORD:env.ADMIN_PASSWORD,SETTINGS_KEY:env.SETTINGS_KEY,modelStore:store,FORGE_QUEUE:env.FORGE_QUEUE},route,members,ctx);
    }
    if (url.pathname === '/api/health') {const config=await store.get();return json({ ok:true,configured:!!config?.enabled&&!!config?.encryptedKey,engine:'vision-model',version:'0.2.0',maxFileMB:8,maxBatch:20 });}
    if (url.pathname === '/api/check') {
      if (request.method !== 'POST') return json({ error: '请使用 POST 提交游戏文件。' }, 405);
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: '请求来源不匹配。' }, 403);
      if (!request.headers.get('Content-Type')?.includes('application/json')) return json({ error: '请求需要使用 JSON 格式。' }, 415);
      const user=await identity(request.headers.get('Cookie'),members,env);
      if(!user)return json({error:'请先使用管理员开通的账号登录。'},401);
      if(!user.canReview)return json({error:'当前账号未开通检查权限，请联系管理员。'},403);
      const rate = await env.CHECK_RATE_LIMIT.limit({ key: `check:${user.id}` });
      if (!rate.success) return json({ error: '检查请求较多，请稍等一分钟再重试。' }, 429);
      let input;
      try { input = validateInput(await readLimitedJson(request)); }
      catch (error) { return json({ error: error instanceof Error ? error.message : '文件内容无法读取。' }, 400); }
      let browser;
      try {
        const model=await resolveModel(await store.get(),env.SETTINGS_KEY);
        if(!model)return json({error:'管理员尚未配置审核模型。请先在 /admin 中保存并启用支持图片输入的模型。'},503);
        browser = await puppeteer.launch(env.BROWSER);
        const report = await inspectGame(browser as unknown as Browser, input, modelTransport(model));
        return json(report);
      } catch (error) {
        // Do not publish platform exception details or uploaded source in logs.
        const message = String(error instanceof Error ? error.message : error);
        if (/429|limit|quota|concurrent|too many/i.test(message)) return json({ error: '检查服务当前繁忙或已达到今日浏览器额度，请稍后重试。' }, 429);
        return json({ error: '检查浏览器暂时无法启动，请稍后重试。文件没有被判定为不合格。' }, 503);
      } finally { await browser?.close().catch(() => {}); }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: '接口不存在。' }, 404);
    const redirect = await guardForgePage(request, members, env) || await guardReviewPage(request, members, env) || await guardCheckPage(request, members, env);
    if (redirect) return redirect;
    if (url.pathname === '/forge') return env.ASSETS.fetch(new Request(new URL('/forge/index.html', url), request));
    // Cloudflare Assets clean URLs redirect a direct `/review.html` fetch to
    // `/review`. Read the canonical asset path here so a member visiting `/`
    // does not bounce between the two guarded routes.
    if (url.pathname === '/review') return env.ASSETS.fetch(new Request(new URL('/review', url), request));
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const user = await identity(request.headers.get('Cookie'), members, env);
      if (user?.role === 'member') return env.ASSETS.fetch(new Request(new URL('/review', url), request));
    }
    return env.ASSETS.fetch(request);
  },
  async queue(batch: QueueBatch<ForgeJob>, env: Env): Promise<void> {
    const forgeEnv = { DB: env.DB, ADMIN_PASSWORD: env.ADMIN_PASSWORD, SETTINGS_KEY: env.SETTINGS_KEY, modelStore: configStore(env.DB) };
    for (const message of batch.messages) {
      try {
        await processForgeJob(forgeEnv, message.body);
        message.ack();
      } catch {
        if ((message.attempts || 1) >= 3) message.ack();
        else message.retry({ delaySeconds: Math.min(60, 10 * (message.attempts || 1)) });
      }
    }
  },
};

async function readLimitedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('Content-Length')) > MAX_REQUEST_BYTES) throw new Error('请求内容过大。');
  if (!request.body) throw new Error('请求内容为空。');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) { await reader.cancel(); throw new Error('请求内容过大。'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally { reader.releaseLock(); }
}
