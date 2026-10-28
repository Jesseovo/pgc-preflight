import puppeteer from '@cloudflare/puppeteer';
import type { Browser } from 'puppeteer-core';
import { acquireBrowser,connectAcquiredBrowser } from './browser-capacity';
import { captureReview } from './review-probe';

export function captureFor(env: any) {
  return async (html: string, onWait?: (message: string) => Promise<void>) => {
    let browser;
    try {
      browser = await acquireBrowser(env.DB, () => puppeteer.limits(env.BROWSER), () => connectAcquiredBrowser(()=>puppeteer.acquire(env.BROWSER),id=>puppeteer.connect(env.BROWSER,id),onWait), onWait);
      await onWait?.('正在采集三种手机比例的真实游戏画面…');
      return await captureReview(browser as unknown as Browser, html);
    } finally { await browser?.close().catch(() => {}); }
  };
}
