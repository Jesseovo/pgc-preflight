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
import {guardCheckPage,guardForgePage,guardReviewPage,guardSquarePage,guardPrivateAsset,guardDeviceScope,isPrivateAsset} from './page-access';
import {forgeApi, type ForgeJob} from './forge-api';
import {purgeReviewInputs,scheduleCloudReview} from './review-jobs';
import {captureFor} from './cloud-review-capture';
import {forgeAgentApi,forgeAgentWeb} from './forge-agent-api';
import {reviewDeviceApi,reviewDeviceWeb,deviceStatus} from './review-device-api';
import {galleryApi} from './gallery';
import {enqueueForgeTask,recoverForgeTasks,type ForgeRunnerBinding} from './forge-tasks';
export {ReviewRunner} from './review-runner';
export {ForgeRunner} from './forge-runner';

interface QueueMessage<T> { id: string; body: T; attempts?: number; ack(): void; retry(options?: { delaySeconds?: number }): void }
interface QueueBatch<T> { messages: QueueMessage<T>[] }
interface Env { ASSETS: { fetch(request: Request): Promise<Response> }; BROWSER: Parameters<typeof puppeteer.launch>[0]; CHECK_RATE_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> }; FORGE_RATE_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> }; FORGE_QUEUE: { send(message: ForgeJob): Promise<void> }; FORGE_RUNNER:ForgeRunnerBinding; REVIEW_QUEUE: { send(message: {type: 'review'; id: string}): Promise<void> }; DB:Database; ADMIN_PASSWORD:string; SETTINGS_KEY:string }
interface WorkerContext { waitUntil(promise: Promise<unknown>): void }
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

const app = {
  async fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    const url = new URL(request.url);
    const deviceBoundary=guardDeviceScope(request);
    if(deviceBoundary)return deviceBoundary;
    // Gallery browsing is a member-session surface backed by D1. Route it
    // before the generic control-plane proxy so its auth and admin checks run.
    if(url.pathname.startsWith('/api/square/'))return (await galleryApi(request,env)) || json({error:'接口不存在。'},404);
    // The ordinary Free Worker only routes API traffic. JSON processing and
    // control-plane work use the free SQLite Durable Object CPU allowance.
    if(url.pathname.startsWith('/api/')&&(env as any).CONTROL_PLANE){
      const binding=(env as any).CONTROL_PLANE;
      return binding.get(binding.idFromName('review-control-v1')).fetch(request);
    }
    const store=configStore(env.DB),members=memberStore(env.DB);
    if(url.pathname.startsWith('/api/forge-agent/')){
      if(url.pathname.endsWith('/pair')){const rate=await env.CHECK_RATE_LIMIT.limit({key:`forge-pair:${request.headers.get('CF-Connecting-IP')||'unknown'}`});if(!rate.success)return json({error:'配对操作较多，请稍后重试。'},429);}
      return forgeAgentApi(request,{...env,modelStore:store});
    }
    if(url.pathname.startsWith('/api/forge/agent/'))return forgeAgentWeb(request,{...env,modelStore:store});
    if(url.pathname.startsWith('/api/review-device/')){
      if(url.pathname.endsWith('/pair')){const rate=await env.CHECK_RATE_LIMIT.limit({key:`pair:${request.headers.get('CF-Connecting-IP')||'unknown'}`});if(!rate.success)return json({error:'配对操作较多，请稍后重试。'},429);}
      return reviewDeviceApi(request,{...env,modelStore:store});
    }
    if(url.pathname.startsWith('/api/forge/review/device/'))return reviewDeviceWeb(request,{...env,modelStore:store});
    if(url.pathname==='/api/admin/review-workers'){
      const user=await identity(request.headers.get('Cookie'),members,env);
      return user?.role==='admin'?json(await deviceStatus(env.DB)):json({error:'请先以管理员登录。'},403);
    }
    if(url.pathname.startsWith('/api/admin/')){
      if(request.method!=='GET'){const rate=await env.CHECK_RATE_LIMIT.limit({key:`admin:${request.headers.get('CF-Connecting-IP')||'unknown'}`});if(!rate.success)return json({error:'操作较频繁，请一分钟后重试。'},429);}
      return (await adminApi(request,store,env,members,env.DB,{captureReview:captureFor(env)}))!;
    }
    if(url.pathname.startsWith('/api/auth/')){
      if(request.method!=='GET'){const rate=await env.CHECK_RATE_LIMIT.limit({key:`auth:${request.headers.get('CF-Connecting-IP')||'unknown'}`});if(!rate.success)return json({error:'登录操作较频繁，请稍后重试。'},429);}
      return(await authApi(request,members,env))!;
    }
    if(url.pathname.startsWith('/api/forge/')){
      if(request.method!=='GET'){const rate=await env.FORGE_RATE_LIMIT.limit({key:`forge:${request.headers.get('CF-Connecting-IP')||'unknown'}`});if(!rate.success)return json({error:'操作较频繁，请一分钟后重试。'},429);}
      const route=url.pathname.slice('/api/forge/'.length).split('/').filter(Boolean);
      return forgeApi(request,{DB:env.DB,ADMIN_PASSWORD:env.ADMIN_PASSWORD,SETTINGS_KEY:env.SETTINGS_KEY,modelStore:store,FORGE_RUNNER:env.FORGE_RUNNER,REVIEW_QUEUE:env.REVIEW_QUEUE,
        reviewExecutor:'device',
      },route,members,ctx);
    }
    if (url.pathname === '/api/health') {const config=await store.get();return json({ ok:true,configured:!!config?.enabled&&!!config?.encryptedKey,engine:'vision-model',version:'0.2.0',maxFileMB:8,maxBatch:20 });}
    if (url.pathname === '/api/check') {
      if (request.method !== 'POST') return json({ error: '请使用 POST 提交游戏文件。' }, 405);
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return json({ error: '请求来源不匹配。' }, 403);
      if (!request.headers.get('Content-Type')?.includes('application/json')) return json({ error: '请求需要使用 JSON 格式。' }, 415);
      const user=await identity(request.headers.get('Cookie'),members,env);
      if(!user)return json({error:'请先使用管理员开通的账号登录。'},401);
      if(user.role!=='admin')return json({error:'请在审核工作台提交游戏，系统会自动核算每日次数。'},403);
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
        const report = await inspectGame(browser as unknown as Browser, input, modelTransport(model,{DB:env.DB}));
        return json(report);
      } catch (error) {
        // Do not publish platform exception details or uploaded source in logs.
        const message = String(error instanceof Error ? error.message : error);
        if (/429|limit|quota|concurrent|too many/i.test(message)) return json({ error: '检查服务当前繁忙或已达到今日浏览器额度，请稍后重试。' }, 429);
        return json({ error: '检查浏览器暂时无法启动，请稍后重试。文件没有被判定为不合格。' }, 503);
      } finally { await browser?.close().catch(() => {}); }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: '接口不存在。' }, 404);
    if(['/agent.md','/forge-agent.md'].includes(url.pathname)){
      const response=await env.ASSETS.fetch(request),headers=new Headers(response.headers);
      headers.set('Content-Type','text/plain; charset=utf-8');headers.set('X-Content-Type-Options','nosniff');
      headers.set('Cache-Control','no-cache');
      return new Response(response.body,{status:response.status,headers});
    }
    const redirect = await guardSquarePage(request, members, env) || await guardForgePage(request, members, env) || await guardReviewPage(request, members, env) || await guardCheckPage(request, members, env);
    if (redirect) return redirect;
    const privateAsset=await guardPrivateAsset(request,members,env);
    if(privateAsset)return privateAsset;
    if(['/square','/square/','/square.html','/square/index.html'].includes(decodeURIComponent(url.pathname))){
      if(url.pathname!=='/square')return new Response(null,{status:302,headers:{Location:'/square','Cache-Control':'private, no-store',Vary:'Cookie'}});
      const response=await env.ASSETS.fetch(new Request(new URL('/square',url),request));
      const headers=new Headers(response.headers);headers.set('Cache-Control','private, no-store');headers.set('Vary','Cookie');
      return new Response(response.body,{status:response.status,headers});
    }
    if(['/admin','/admin/'].includes(url.pathname)){
      const user=await identity(request.headers.get('Cookie'),members,env);
      if(user?.role!=='admin'){
        const response=await env.ASSETS.fetch(new Request(new URL('/admin-login',url),request));
        const headers=new Headers(response.headers);headers.set('Cache-Control','private, no-store');headers.set('Vary','Cookie');
        return new Response(response.body,{status:response.status,headers});
      }
    }
    if (url.pathname === '/forge') return env.ASSETS.fetch(new Request(new URL('/forge/index.html', url), request));
    // Cloudflare Assets clean URLs redirect a direct `/review.html` fetch to
    // `/review`. Read the canonical asset path here so a member visiting `/`
    // does not bounce between the two guarded routes.
    if (url.pathname === '/review') return env.ASSETS.fetch(new Request(new URL('/review', url), request));
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const user = await identity(request.headers.get('Cookie'), members, env);
      if (user?.role === 'member') return env.ASSETS.fetch(new Request(new URL('/review', url), request));
    }
    const response=await env.ASSETS.fetch(request);
    if(isPrivateAsset(request)||['/admin','/admin/'].includes(url.pathname)){
      const headers=new Headers(response.headers);headers.set('Cache-Control','private, no-store');headers.set('Vary','Cookie');
      return new Response(response.body,{status:response.status,headers});
    }
    return response;
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    if((env as any).CONTROL_PLANE){
      const binding=(env as any).CONTROL_PLANE;
      const response=await binding.get(binding.idFromName('review-control-v1')).fetch(new Request('https://internal/__maintenance',{method:'POST'}));
      if(!response.ok)throw new Error('Review maintenance unavailable');
      return;
    }
    await purgeReviewInputs(env);
    await recoverForgeTasks({...env,modelStore:configStore(env.DB)});
    await env.DB.prepare("DELETE FROM forge_tasks WHERE executor='platform' AND status IN ('done','error') AND updated_at < ?").bind(new Date(Date.now()-30*86400000).toISOString()).run();
    await env.DB.prepare('DELETE FROM model_runs WHERE created_at < ?').bind(new Date(Date.now()-30*86400000).toISOString()).run();
    await env.DB.prepare("UPDATE topics SET product_status = 'error', product_error = '制作进程意外中断，未保存完整成品；请检查后重试。', updated_at = ? WHERE product_status = 'running' AND updated_at < ? AND NOT EXISTS(SELECT 1 FROM forge_tasks WHERE forge_tasks.owner_id=topics.owner_id AND executor='agent' AND scope=topics.owner_id||':game:'||topics.id AND status IN ('queued','running'))")
      .bind(new Date().toISOString(), new Date(Date.now() - 15 * 60 * 1000).toISOString()).run();
  },
  async queue(batch: QueueBatch<ForgeJob>, env: Env): Promise<void> {
    const forgeEnv = { DB: env.DB, ADMIN_PASSWORD: env.ADMIN_PASSWORD, SETTINGS_KEY: env.SETTINGS_KEY, modelStore: configStore(env.DB),FORGE_RUNNER:env.FORGE_RUNNER,captureReview:captureFor(env) };
    for (const message of batch.messages) {
      try {
        // Old queued creation messages only dispatch alarms. Never run long
        // model streams (or replay them) in an ordinary Free Queue consumer.
        if(message.body.type==='review'){
          const job=await env.DB.prepare('SELECT executor,model_executor,status FROM review_jobs WHERE id=?').bind(message.body.id).first() as any;
          if(job?.executor==='cloud'&&job.model_executor==='platform'&&['queued','running'].includes(job.status))await scheduleCloudReview({...env,REVIEW_QUEUE:undefined} as any,message.body.id);
        }
        else {
          const jobs:ForgeJob[]=message.body.type==='expand' ? message.body.ids.map(id=>({type:'expand',ids:[id]})) : [message.body];
          for(const job of jobs){
            // Queue re-delivery must keep the ID even after a task finishes.
            const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${message.id}:${JSON.stringify(job)}`)));
            const hex=Array.from(digest.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
            const taskId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
            await enqueueForgeTask(forgeEnv,job,taskId);
          }
        }
        message.ack();
      } catch {
        if ((message.attempts || 1) >= 3) message.ack();
        else message.retry({ delaySeconds: message.body.type === 'review' ? 800 : Math.min(60, 10 * (message.attempts || 1)) });
      }
    }
  },
};

export default app;
// JSON control requests use the free SQLite DO CPU budget. Each game's model
// execution runs in its own alarm object, separately from this control plane.
export class ReviewControlPlane {
  constructor(private state:WorkerContext,private env:Env){}
  async fetch(request:Request){
    const env={...this.env,CONTROL_PLANE:undefined} as Env;
    if(request.url==='https://internal/__maintenance'){
      await app.scheduled({},env);return new Response('ok');
    }
    return app.fetch(request,env,this.state);
  }
}

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
