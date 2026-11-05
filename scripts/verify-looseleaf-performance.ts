import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { findChrome } from '../server/local-browser';
import { startPreview } from './preview-looseleaf';

type BuildMode = 'legacy' | 'looseleaf';
type View = 'works' | 'overview' | 'tasks' | 'reviews';
type Sample = {
  firstReadyMs: number;
  coldAssets: { requests: number; bodyBytes: number; totalRequests: number; totalBodyBytes: number; largest: { pathname: string; bytes: number }[] };
  coldApiGets: number;
  navigationMs: Record<View, number>;
  sameDocumentSwitches: number;
  navigationApiGets: number;
  nextWorksPageMs: number;
  listResponseMs: number;
};
const selectors: Record<BuildMode, Record<View, string>> = {
  legacy: { works: '#admin-view [data-project-id]', overview: '#admin-view .adm-chart', tasks: '#admin-view [data-task-id]', reviews: '#admin-view [data-report]' },
  looseleaf: { works: '.admin-works-table tbody .admin-summary-link', overview: 'svg.admin-chart', tasks: '.admin-task-table tbody .admin-summary-link', reviews: '.admin-app tbody .admin-summary-link' },
};
const navNames: Record<View, string> = { works: '作品', overview: '总览', tasks: '任务', reviews: '审核' };
const titles: Record<View, string> = { works: '作品', overview: '团队总览', tasks: '任务', reviews: '审核记录' };
const views: View[] = ['overview', 'tasks', 'reviews', 'works'];
const median = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  const center = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[center] : (ordered[center - 1] + ordered[center]) / 2;
};
const rounded = (number: number) => Math.round(number * 10) / 10;

function summary(samples: Sample[]) {
  const med = (read: (sample: Sample) => number) => rounded(median(samples.map(read)));
  return {
    firstReadyMs: med(row => row.firstReadyMs),
    coldAssetRequests: med(row => row.coldAssets.requests),
    coldAssetBodyBytes: med(row => row.coldAssets.bodyBytes),
    coldStaticRequests: med(row => row.coldAssets.totalRequests),
    coldStaticBodyBytes: med(row => row.coldAssets.totalBodyBytes),
    coldApiGets: med(row => row.coldApiGets),
    switchMs: Object.fromEntries(views.map(view => [view, med(row => row.navigationMs[view])])),
    sameDocumentSwitches: med(row => row.sameDocumentSwitches),
    navigationApiGets: med(row => row.navigationApiGets),
    nextWorksPageMs: med(row => row.nextWorksPageMs),
    listResponseMs: med(row => row.listResponseMs),
  };
}

function fromEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const input = process.env[name];
  const value = input == null ? fallback : Number(input);
  assert(Number.isInteger(value) && value >= minimum && value <= maximum, name + ' out of range');
  return value;
}

function navigationTarget(page: Page, mode: BuildMode, view: View) {
  return mode === 'legacy' ? page.locator('[data-admin-view="' + view + '"]').first() : page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: navNames[view], exact: true });
}

async function ready(page: Page, mode: BuildMode, view: View) {
  await page.waitForFunction(({ selector, title }) => {
    const element = document.querySelector(selector);
    return !!element?.getClientRects().length && Array.from(document.querySelectorAll('main h1')).some(heading => heading.textContent?.trim() === title);
  }, { selector: selectors[mode][view], title: titles[view] }, { timeout: 15_000 });
}

async function measure(browser: Browser, mode: BuildMode, assetDir: string, rounds: number, apiDelayMs: number) {
  const fixture = await startPreview(0, { mode, assetDir, apiDelayMs });
  const samples: Sample[] = [];
  try {
    for (let index = 0; index < rounds; index++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const baseline = fixture.requests.length;
      try {
        const started = performance.now();
        await page.goto(fixture.url + '/__preview?role=admin', { waitUntil: 'domcontentloaded' });
        await ready(page, mode, 'works');
        const firstReadyMs = performance.now() - started;
        const coldAssets = await page.evaluate(() => {
          const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
          const staticResources = resources.filter(row => row.transferSize > 0 && new URL(row.name).origin === location.origin && !new URL(row.name).pathname.startsWith('/api/'));
          const assets = staticResources.filter(row => /\.(?:js|css)$/.test(new URL(row.name).pathname));
          return {
            requests: assets.length,
            bodyBytes: assets.reduce((sum, row) => sum + row.encodedBodySize, 0),
            totalRequests: staticResources.length,
            totalBodyBytes: staticResources.reduce((sum, row) => sum + row.encodedBodySize, 0),
            largest: staticResources.map(row => ({ pathname: new URL(row.name).pathname, bytes: row.encodedBodySize })).sort((a, b) => b.bytes - a.bytes).slice(0, 6),
          };
        });
        assert(coldAssets.requests && coldAssets.bodyBytes, mode + ' should load built assets');
        const reads = () => fixture.requests.slice(baseline).filter(item => item.method === 'GET' && item.path.startsWith('/api/')).length;
        const coldApiGets = reads();
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        const navigationMs = {} as Record<View, number>;
        let sameDocumentSwitches = 0;
        for (const view of views) {
          const before = performance.now();
          await navigationTarget(page, mode, view).click();
          await page.waitForURL(url => (url.searchParams.get('view') || 'works') === view);
          await ready(page, mode, view);
          navigationMs[view] = performance.now() - before;
          if (await page.evaluate(() => performance.timeOrigin) === timeOrigin) sameDocumentSwitches++;
        }
        const navigationApiGets = reads() - coldApiGets;
        const firstItem = (await page.locator(selectors[mode].works).first().textContent())?.trim();
        const nextButton = mode === 'legacy' ? page.locator('#admin-view [data-page="2"]').last() : page.getByRole('button', { name: '下一页', exact: true });
        const beforeNext = performance.now();
        const network = page.waitForResponse(response => {
          const url = new URL(response.url());
          return response.request().method() === 'GET' && url.pathname === '/api/admin/projects' && url.searchParams.get('page') === '2' && response.ok();
        });
        await nextButton.click();
        const response = await network;
        await ready(page, mode, 'works');
        await page.waitForFunction(({ selector, firstItem }) => {
          const row = document.querySelector(selector);
          return row && row.textContent?.trim() !== firstItem;
        }, { selector: selectors[mode].works, firstItem });
        const nextWorksPageMs = performance.now() - beforeNext;
        const listResponseMs = await page.evaluate(url => {
          const entries = performance.getEntriesByName(url) as PerformanceResourceTiming[];
          return entries.at(-1)?.duration ?? -1;
        }, response.url());
        assert(listResponseMs >= apiDelayMs, mode + ' list sample must include fixture delay');
        assert.deepEqual(errors, [], mode + ' browser page errors');
        samples.push({ firstReadyMs, coldAssets, coldApiGets, navigationMs, sameDocumentSwitches, navigationApiGets, nextWorksPageMs, listResponseMs });
      } finally { await context.close(); }
    }
    assert.deepEqual(fixture.outbound, [], 'fixture never reaches external services');
    assert.deepEqual(fixture.dispatches, [], 'navigation never dispatches tasks');
    assert.equal(fixture.requests.some(row => row.method !== 'GET'), false, 'performance path is read-only');
    return { samples, median: summary(samples) };
  } finally { await fixture.close(); }
}

const rounds = fromEnv('PGC_PERF_ROUNDS', 5, 1, 20);
const apiDelayMs = fromEnv('PGC_PERF_API_DELAY_MS', 100, 0, 1000);
const output = path.resolve('artifacts/looseleaf-ui-performance.json');
const dir = await mkdtemp(path.join(os.tmpdir(), 'pgc-ui-perf-'));
let browser: Browser | undefined;
try {
  const legacy = path.join(dir, 'legacy'), looseleaf = path.join(dir, 'looseleaf');
  await build({ configFile: path.resolve('vite.config.ts'), logLevel: 'warn', build: { outDir: legacy, emptyOutDir: true } });
  await build({ configFile: path.resolve('vite.ui.config.ts'), logLevel: 'warn', build: { outDir: looseleaf, emptyOutDir: true } });
  browser = await chromium.launch({ executablePath: findChrome() });
  const results = {
    generatedAt: new Date().toISOString(),
    rounds,
    apiDelayMs,
    scenarios: [
      'Cold browser context, synthetic administrator login redirect to first works list row',
      'Warm sidebar switches from works to overview, tasks, reviews and back to works',
      'Warm works next page until the first row changes, and matching projects request duration',
    ],
    limits: [
      'Same isolated SQLite seed and injected API response delay for both built entries. No CDN, compression, production credentials, browser rendering, or live model requests.',
      'Encoded body bytes cover JavaScript/CSS and, separately, all network-transferred same-origin static resources completed by the first ready checkpoint. Cached entries, the document, API bodies and HTTP overhead are excluded.',
      'Single Chromium installation and local machine. These medians measure this test route only, not production latency percentiles or model speed.',
    ],
    legacy: await measure(browser, 'legacy', legacy, rounds, apiDelayMs),
    looseleaf: await measure(browser, 'looseleaf', looseleaf, rounds, apiDelayMs),
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(results, null, 2) + '\n');
  console.table({ legacy: { ...results.legacy.median, switchMs: JSON.stringify(results.legacy.median.switchMs) }, looseleaf: { ...results.looseleaf.median, switchMs: JSON.stringify(results.looseleaf.median.switchMs) } });
  console.log('Saved performance results to ' + output);
} finally {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
}
