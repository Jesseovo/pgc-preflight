import puppeteer from '@cloudflare/puppeteer';
import type { Browser } from 'puppeteer-core';
import { acquireBrowser,connectAcquiredBrowser } from './browser-capacity';
import { captureReview } from './review-probe';
import {recordReviewTiming} from './review-timing';

export type CaptureBrowserLifecycle = {
  acquiring(): Promise<void>;
  acquired(sessionId: string): Promise<void>;
  closed(sessionId: string): Promise<void>;
};

type BrowserSessionControl = {
  closeSession?: (sessionId: string) => Promise<{ status?: string } | string>;
  getSession?: (sessionId: string) => Promise<{ sessionId?: string; endTime?: number } | null>;
};

export function supportsBrowserSessionControl(binding: unknown) {
  const control = binding as BrowserSessionControl | undefined;
  return typeof control?.closeSession === 'function' && typeof control.getSession === 'function';
}

export async function closeCaptureBrowser(binding: Parameters<typeof puppeteer.acquire>[0], sessionId: string) {
  const control = binding as BrowserSessionControl;
  const result = await control.closeSession?.(sessionId).catch(() => undefined);
  const status = typeof result === 'string' ? result : result?.status;
  if (status === 'closed') return;
  const checks = status === 'closing' ? 3 : 1;
  for (let attempt = 0; attempt < checks; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    const session = await control.getSession?.(sessionId);
    if (session === null || session?.sessionId === sessionId && typeof session.endTime === 'number' && Number.isFinite(session.endTime) && session.endTime > 0) return;
  }
  throw new Error('截图浏览器关闭尚未确认。');
}

export function captureFor(env: any) {
  return async (html: string, onWait?: (message: string) => Promise<void>, deadlineAt?: number, creation?: { activeBudgetMs: number }, lifecycle?: CaptureBrowserLifecycle) => {
    if (creation && (env.creationCaptureStrict !== true || !Number.isSafeInteger(creation.activeBudgetMs) || creation.activeBudgetMs < 1)) {
      throw new Error('无效的制作补测时间预算。');
    }
    if (lifecycle && !supportsBrowserSessionControl(env.BROWSER)) {
      throw new Error('截图服务缺少按会话确认关闭的能力。');
    }
    const remaining = () => (deadlineAt ?? Infinity) - Date.now();
    const checkDeadline = () => {
      if (remaining() <= 0) throw new Error('制作任务已到达总时限，采集未完成。');
    };
    let browser: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
    let sessionId: string | undefined;
    let closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = async () => {
      if (!lifecycle) return browser?.close().catch(() => {});
      if (!sessionId) return;
      const id = sessionId;
      // Puppeteer can suppress a CDP Browser.close error. Only the exact
      // session's management result can retire the durable capture marker.
      return closing ??= closeCaptureBrowser(env.BROWSER, id).then(() => lifecycle.closed(id));
    };
    try {
      const started=Date.now();let status:'ok'|'error'='error';
      try {
        checkDeadline();
        browser = await acquireBrowser(env.DB, () => puppeteer.limits(env.BROWSER), () => {
          checkDeadline();
          const acquire = async () => {
            if (!lifecycle) return env.creationCaptureStrict === true
              ? puppeteer.acquire(env.BROWSER, { guardrails: { allowedDomains: [] }, recording: false })
              : puppeteer.acquire(env.BROWSER);
            await lifecycle.acquiring();
            // A lost acquire response may have allocated a browser. Keep its
            // marker and bypass the launch gate's ordinary rate-limit retry.
            const result = await puppeteer.acquire(env.BROWSER, {
              guardrails: { allowedDomains: [] }, recording: false,
              keep_alive: Math.max(10_000, Math.min(60_000, remaining())),
            }).catch(() => { throw new Error('截图浏览器申请结果未确认。'); });
            if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new Error('截图浏览器缺少会话编号。');
            sessionId = result.sessionId;
            await lifecycle.acquired(sessionId);
            return result;
          };
          return connectAcquiredBrowser(acquire, id => {
            if (lifecycle) checkDeadline();
            return puppeteer.connect(env.BROWSER,id);
          }, onWait);
        }, onWait, Math.min(240_000, remaining()));
        checkDeadline();
        status = 'ok';
      }
      finally{if(env.reviewJobId)await recordReviewTiming(env.DB,{jobId:env.reviewJobId,eventId:crypto.randomUUID(),phase:'browser_start',origin:'server',startedAt:new Date(started).toISOString(),durationMs:Math.max(0,Date.now()-started),status}).catch(()=>{});}
      await onWait?.('正在采集三种手机比例的真实游戏画面…');
      checkDeadline();
      const captureStarted = performance.now();
      const captureDeadline = creation ? Math.min(deadlineAt ?? Infinity, Date.now() + creation.activeBudgetMs) : deadlineAt;
      if (captureDeadline !== undefined) {
        timer = setTimeout(() => { void close().catch(() => {}); }, Math.max(0, captureDeadline - Date.now()));
      }
      const connected = browser as unknown as Browser;
      const result = captureDeadline !== undefined
        ? await captureReview(connected, html, { denyExternal: env.creationCaptureStrict === true, deadlineAt: captureDeadline })
        : env.creationCaptureStrict === true ? await captureReview(connected, html, { denyExternal: true }) : await captureReview(connected, html);
      if (!creation) return result;
      const captureRuntimeMs = Math.ceil(performance.now() - captureStarted);
      if (captureRuntimeMs > creation.activeBudgetMs || Date.now() >= captureDeadline!) {
        throw new Error('制作补测已达到实际浏览器运行时限，未提交截图。');
      }
      return { ...result, captureRuntimeMs };
    } finally {
      clearTimeout(timer);
      await close();
    }
  };
}
