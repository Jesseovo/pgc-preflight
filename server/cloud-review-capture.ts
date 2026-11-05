import puppeteer from '@cloudflare/puppeteer';
import type { Browser } from 'puppeteer-core';
import { acquireBrowser,connectAcquiredBrowser } from './browser-capacity';
import { captureReview } from './review-probe';
import {recordReviewTiming} from './review-timing';

export function captureFor(env: any) {
  return async (html: string, onWait?: (message: string) => Promise<void>, deadlineAt?: number, creation?: { activeBudgetMs: number }) => {
    if (creation && (env.creationCaptureStrict !== true || !Number.isSafeInteger(creation.activeBudgetMs) || creation.activeBudgetMs < 1)) {
      throw new Error('无效的制作补测时间预算。');
    }
    const remaining = () => (deadlineAt ?? Infinity) - Date.now();
    const checkDeadline = () => {
      if (remaining() <= 0) throw new Error('制作任务已到达总时限，采集未完成。');
    };
    let browser: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started=Date.now();let status:'ok'|'error'='error';
      try {
        checkDeadline();
        browser = await acquireBrowser(env.DB, () => puppeteer.limits(env.BROWSER), () => {
          checkDeadline();
          const acquire = () => env.creationCaptureStrict === true
            ? puppeteer.acquire(env.BROWSER, { guardrails: { allowedDomains: [] }, recording: false })
            : puppeteer.acquire(env.BROWSER);
          return connectAcquiredBrowser(acquire, id => puppeteer.connect(env.BROWSER,id), onWait);
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
        timer = setTimeout(() => { void browser?.close().catch(() => {}); }, Math.max(0, captureDeadline - Date.now()));
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
      await browser?.close().catch(() => {});
    }
  };
}
