import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { findChrome } from '../server/local-browser';
import { startPreview } from './preview-looseleaf';

type Role = 'none' | 'admin' | 'star' | 'member';
type Route = { role: Role; name: string; path: string; ready: string; screenshot?: boolean };
const routes: Route[] = [
  { role: 'none', name: '登录', path: '/login', ready: '欢迎回来' },
  { role: 'admin', name: '团队总览', path: '/admin?view=overview', ready: '团队总览', screenshot: true },
  { role: 'admin', name: '作品', path: '/admin?view=works', ready: '作品' },
  { role: 'admin', name: '作品试玩详情', path: '/admin?view=works&status=product&inspect=project&inspectType=topic&inspectId=1&inspectPanel=game', ready: '作品详情' },
  { role: 'admin', name: '任务', path: '/admin?view=tasks', ready: '任务' },
  { role: 'admin', name: '审核记录', path: '/admin?view=reviews', ready: '审核记录' },
  { role: 'admin', name: '审核报告', path: '/admin?view=reviews&id=82', ready: '强制整改 · 已证实缺陷' },
  { role: 'admin', name: '反馈闭环', path: '/admin?view=feedback', ready: '反馈闭环' },
  { role: 'admin', name: '成员管理', path: '/admin?view=members', ready: '成员管理' },
  { role: 'admin', name: '模型设置', path: '/admin?view=settings', ready: '平台设置' },
  { role: 'admin', name: '公共资料', path: '/admin?view=settings&section=public', ready: '公共资料' },
  { role: 'admin', name: '手动上传', path: '/admin?view=settings&section=upload', ready: '手动上传' },
  { role: 'admin', name: '广场管理', path: '/square?scope=manage', ready: '广场作品管理' },
  { role: 'star', name: '我的项目', path: '/forge/', ready: '我的项目', screenshot: true },
  { role: 'star', name: '项目材料', path: '/forge/?project=1&panel=create', ready: 'Pocket Bloom · 口袋花园' },
  { role: 'star', name: '项目试玩', path: '/forge/?project=1&panel=play', ready: 'Pocket Bloom · 口袋花园' },
  { role: 'star', name: '发现选题', path: '/forge/?tab=draw', ready: '发现选题' },
  { role: 'star', name: '创作任务', path: '/forge/?tab=tasks', ready: '创作任务' },
  { role: 'star', name: '游戏成品', path: '/forge/?tab=products', ready: '游戏成品' },
  { role: 'star', name: '历史作品', path: '/forge/?tab=games', ready: '历史作品' },
  { role: 'star', name: '公共词库', path: '/forge/?tab=vocab', ready: '公共词库' },
  { role: 'star', name: '规则与偏好', path: '/forge/?tab=settings', ready: '规则与偏好' },
  { role: 'star', name: '创作 Agent', path: '/forge/?tab=agent', ready: '我的创作 Agent' },
  { role: 'star', name: '审核报告详情', path: '/forge/?tab=review&report=82', ready: '强制整改 · 已证实缺陷', screenshot: true },
  { role: 'star', name: '审核历史', path: '/forge/?tab=review&reviewTab=history', ready: 'Paper Orbit · 精确版本 v3' },
  { role: 'member', name: '成员审核', path: '/?task=member-waiting', ready: '复制继续审核指令' },
  { role: 'member', name: '审核设备', path: '/?tab=devices', ready: '连接审核 Agent' },
  { role: 'member', name: '账号与安全', path: '/account', ready: '账号与安全' },
  { role: 'member', name: '广场', path: '/square', ready: '全部作品' },
  { role: 'member', name: '广场试玩', path: '/square?game=a0000000-0000-4000-8000-000000000099', ready: '隔离试玩 · 9:16' },
];
const viewports = [
  { width: 320, height: 720 }, { width: 390, height: 844 }, { width: 768, height: 1024 },
  { width: 1024, height: 800 }, { width: 1440, height: 1000 }, { width: 844, height: 390 },
];
const artifacts = resolve('artifacts/looseleaf-verification');
await mkdir(artifacts, { recursive: true });
const built = process.env.PGC_UI_BUILD === '1';
const app = await startPreview(0, { mode: built ? 'looseleaf' : 'dev' });
const measurements: unknown[] = [];
const failures: string[] = [];
const workflow: string[] = [];
const runtimeErrors: { engine: string; path: string; error: string }[] = [];
const developmentMessages: string[] = [];
const browserOutbound = new Set<string>();
const requested = process.env.PGC_UI_ENGINE;
const engines = [
  { name: 'chromium', launch: () => chromium.launch({ executablePath: findChrome() || undefined }) },
  { name: 'webkit', launch: () => webkit.launch() },
].filter(engine => !requested || engine.name === requested);
const selectedRoutes = routes.filter(route => !process.env.PGC_UI_ROUTE || route.path.includes(process.env.PGC_UI_ROUTE));
const deadline = 12_000;

function noteFailure(context: string, error: unknown) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  failures.push(`${context}: ${message}`);
  console.error(failures.at(-1));
}

async function isolateBrowserContext(context: BrowserContext) {
  const local = new URL(app.url);
  await context.routeWebSocket(url => url.hostname === local.hostname, () => {});
  await context.route(url => (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== local.origin, async route => {
    browserOutbound.add(new URL(route.request().url()).origin);
    await route.abort();
  });
}

async function signIn(context: BrowserContext, role: Role) {
  const page = await context.newPage();
  await page.goto(`${app.url}/__preview?role=${role}`, { waitUntil: 'domcontentloaded' });
  await page.close();
}

async function awaitReady(page: Page, route: Route) {
  await page.goto(app.url + route.path, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(({ expected, modal }) => {
    const content = (modal ? document.querySelector<HTMLElement>('[role=dialog]') : document.getElementById('main-content')) || document.body;
    return content.innerText.includes(expected) && !Array.from(content.querySelectorAll('.loading-state')).some(element => element.getClientRects().length);
  }, { expected: route.ready, modal: route.path.includes('/square?game=') }, { timeout: deadline });
  await page.evaluate(async () => { await document.fonts.ready; });
}

async function viewportMeasurement(page: Page) {
  return page.evaluate(async () => {
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    const width = document.documentElement.clientWidth;
    const overflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - width;
    const offenders = overflow <= 1 ? [] : Array.from(document.body.querySelectorAll<HTMLElement>('*')).flatMap(element => {
      if (!element.getClientRects().length) return [];
      const rect = element.getBoundingClientRect();
      if (rect.right <= width + 1) return [];
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(parent).overflowX)) return [];
      }
      const ancestry = [];
      for (let node = element.parentElement; node && ancestry.length < 4; node = node.parentElement) {
        ancestry.push({ className: typeof node.className === 'string' ? node.className : '', width: Math.round(node.getBoundingClientRect().width) });
      }
      return [{ element: element.tagName.toLowerCase(), className: typeof element.className === 'string' ? element.className : '', right: Math.round(rect.right), ancestry }];
    }).slice(0, 10);
    return { width, height: innerHeight, overflow, offenders };
  });
}

async function testLayout(browser: Browser, engine: string) {
  const contexts = new Map<Role, BrowserContext>();
  try {
    for (const route of selectedRoutes) {
      let context = contexts.get(route.role);
      if (!context) {
        context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
        contexts.set(route.role, context);
        await isolateBrowserContext(context);
        await signIn(context, route.role);
      }
      const page = await context.newPage();
      page.on('pageerror', error => {
        if (/WebSocket closed without opened/.test(error.message)) developmentMessages.push(`${engine}: ${error.message}`);
        else runtimeErrors.push({ engine, path: route.path, error: error.message });
      });
      try {
        await awaitReady(page, route);
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          const result = await viewportMeasurement(page);
          measurements.push({ engine, role: route.role, path: route.path, textScale: 100, ...result });
          if (result.overflow > 1) noteFailure(`${engine} ${route.path} ${viewport.width}×${viewport.height}`, `document overflow ${result.overflow}px ${JSON.stringify(result.offenders)}`);
          if (route.screenshot && [390, 1440].includes(viewport.width)) {
            await page.screenshot({ path: resolve(artifacts, `${engine}-${route.role}-${route.name}-${viewport.width}.png`), animations: 'disabled' });
          }
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => {
          const elements = Array.from(document.body.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,label,button,a,span,strong,small,li,td,th,dt,dd,summary,input,select,textarea'));
          const sizes = elements.map(element => parseFloat(getComputedStyle(element).fontSize));
          elements.forEach((element, index) => {
            if (Number.isFinite(sizes[index])) element.style.setProperty('font-size', `${sizes[index] * 2}px`, 'important');
          });
        });
        const textResult = await viewportMeasurement(page);
        measurements.push({ engine, role: route.role, path: route.path, textScale: 200, ...textResult });
        if (textResult.overflow > 1) noteFailure(`${engine} ${route.path} 200% text`, `document overflow ${textResult.overflow}px ${JSON.stringify(textResult.offenders)}`);
      } catch (error) {
        noteFailure(`${engine} ${route.path}`, error);
      } finally {
        await page.close();
      }
    }
  } finally {
    await Promise.all([...contexts.values()].map(context => context.close()));
  }
}

async function verifyReviewAndSquare(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' });
  await isolateBrowserContext(context);
  const page = await context.newPage();
  page.setDefaultTimeout(deadline);
  const go = (path: string) => page.goto(app.url + path, { waitUntil: 'domcontentloaded' });
  const text = (value: string) => page.waitForFunction(expected => document.body.innerText.includes(expected), value, { timeout: deadline });
  try {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2aQAAAAASUVORK5CYII=';
    app.sqlite.prepare('UPDATE reviews SET shots=? WHERE id=82').run(JSON.stringify([{ id: 'shot-1', label: '合成原图', data: dataUri }]));
    await go('/__preview?role=star');
    await go('/forge/?tab=review&report=82');
    await text('强制整改 · 已证实缺陷');
    const scores = await page.locator('.review-dimensions').innerText();
    assert.match(scores, /美学\s+0 \/ 3/);
    assert.match(scores, /易玩性\s+待判断/);
    assert.match(scores, /可玩性\s+2 \/ 3/);
    assert.equal(await page.evaluate(() => (window as any).__sourceExecuted), undefined);
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.equal(await page.locator('[data-pgc-progress-style]').count(), 0);
    const [reportExport] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '下载报告', exact: true }).click(),
    ]);
    assert.match(reportExport.suggestedFilename(), /-review\.md$/);
    const exportText = await readFile(await reportExport.path(), 'utf8');
    assert.match(exportText, /美学 0 \/ 3/);
    assert.match(exportText, /易玩性 待判断/);
    assert.match(exportText, /&lt;img/);
    const [fixExport] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '下载指令', exact: true }).click(),
    ]);
    assert.match(fixExport.suggestedFilename(), /-fix\.txt$/);
    assert.match(await readFile(await fixExport.path(), 'utf8'), /只修复已确认的窄屏按钮遮挡/);
    await page.getByRole('button', { name: 'shot-1', exact: true }).first().click();
    await page.locator('[role=dialog] .review-lightbox').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.review-lightbox').waitFor({ state: 'hidden' });
    await go('/forge/?tab=review&report=81');
    await text('真人终审');
    assert.match(await page.locator('.review-total').innerText(), /模拟通过[\s\S]*8 \/ 9/);
    assert.match(await page.locator('.review-human').innerText(), /已通过[\s\S]*8 \/ 9/);
    await go('/forge/?tab=review&reviewTab=history');
    await page.getByLabel('审核结果', { exact: true }).selectOption('review');
    assert.equal(await page.locator('.review-history-table tbody tr').count(), 1);
    const [batchExport] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出筛选结果', exact: true }).click(),
    ]);
    const batchText = await readFile(await batchExport.path(), 'utf8');
    assert.match(batchText, /Paper Orbit/);
    assert.doesNotMatch(batchText, /Pocket Bloom/);
    workflow.push('v1/v2, 0/null, score and human decision separation, issue groups, safe text and filtered exports, linked original evidence');
    await go('/forge/?tab=review&task=waiting-verify');
    await text('复制继续审核指令');
    assert.equal(await page.locator('.review-job-detail progress').count(), 0);
    assert.match(await page.locator('.review-job-message pre').textContent() || '', /waiting-verify/);
    workflow.push('waiting verification does not tick and resumes original task');

    await go('/square?q=Pocket');
    await page.getByRole('button', { name: '试玩：Pocket Bloom · 口袋花园' }).click();
    const frame = page.locator('.player-viewport iframe');
    await frame.waitFor();
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
    const outside = await frame.boundingBox();
    assert(outside && Math.abs(outside.width / outside.height - 9 / 16) < .01);
    const inside = await page.frameLocator('.player-viewport iframe').locator('#tap').evaluate(element => element.getBoundingClientRect().toJSON());
    await page.touchscreen.tap(outside.x + (inside.x + inside.width / 2) * outside.width / 540, outside.y + (inside.y + inside.height / 2) * outside.height / 960);
    assert.equal(await page.frameLocator('.player-viewport iframe').locator('#score').textContent(), '1');
    await frame.evaluate(element => { element.dataset.qaStable = 'true'; });
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await frame.getAttribute('data-qa-stable'), 'true');
    await page.locator('[role=dialog] [data-slot=dialog-close]').click();
    await frame.waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).searchParams.get('q'), 'Pocket');
    assert.equal(new URL(page.url()).searchParams.has('game'), false);
    await page.getByRole('button', { name: '试玩：Pocket Bloom · 口袋花园' }).click();
    await frame.waitFor();
    await page.goBack();
    await frame.waitFor({ state: 'detached' });
    const sidebar = page.getByRole('navigation', { name: '主导航', exact: true });
    await sidebar.getByRole('link', { name: '独立审核', exact: true }).click();
    await page.waitForURL('**/forge/?tab=review');
    await sidebar.getByRole('link', { name: '游戏广场', exact: true }).click();
    await page.waitForURL('**/square?q=Pocket');
    assert.equal(await page.getByRole('searchbox', { name: '搜索游戏标题或作者' }).inputValue(), 'Pocket');
    workflow.push('authorized isolated 9:16 gallery, trusted touch, stable resize, close/back cleanup and sidebar query retention');

    await go('/__preview?role=member');
    await go('/?tab=devices');
    await text('连接审核 Agent');
    await page.getByRole('button', { name: '生成一次性配对码', exact: true }).click();
    const pairing = page.getByRole('textbox', { name: '一次性配对码', exact: true });
    await pairing.waitFor();
    assert.equal((await pairing.inputValue()).length, 40);
    await page.reload();
    await text('连接审核 Agent');
    assert.equal(await pairing.count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'devices');
    await go('/?report=82');
    await text('审核记录不存在');
    workflow.push('real device pairing, ephemeral code, member report ownership guard');
  } finally {
    await context.close();
  }
}

async function verifyFullscreenFallback(browser: Browser) {
  const gamePath = '/square?game=a0000000-0000-4000-8000-000000000099';
  for (const mode of ['missing', 'denied'] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await isolateBrowserContext(context);
    await context.addInitScript(failure => {
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: failure === 'missing' ? undefined : function (this: Element) {
          this.setAttribute('data-qa-fullscreen-requested', 'true');
          return Promise.reject(new DOMException('Synthetic fullscreen denial', 'NotAllowedError'));
        },
      });
    }, mode);
    try {
      await signIn(context, 'member');
      const page = await context.newPage();
      page.setDefaultTimeout(deadline);
      page.on('pageerror', error => runtimeErrors.push({ engine: 'chromium', path: gamePath, error: error.message }));
      await page.goto(app.url + gamePath, { waitUntil: 'domcontentloaded' });
      const frame = page.locator('.player-viewport iframe');
      await frame.waitFor();
      const fullscreen = page.getByRole('button', { name: '全屏试玩', exact: true });
      if (mode === 'missing') {
        assert.equal(await fullscreen.count(), 0);
      } else {
        await frame.evaluate(element => { element.dataset.qaFullscreenStable = 'true'; });
        await fullscreen.click();
        await page.locator('.notice').filter({ hasText: '当前浏览器未能进入全屏，仍可在播放器内试玩。' }).waitFor();
        assert.equal(await page.locator('.game-player').getAttribute('data-qa-fullscreen-requested'), 'true');
        assert.equal(await page.evaluate(() => document.fullscreenElement), null);
        assert.equal(await frame.getAttribute('data-qa-fullscreen-stable'), 'true');
      }
      const game = page.frameLocator('.player-viewport iframe');
      await game.locator('#tap').waitFor();
      await page.getByRole('button', { name: '重新开始试玩', exact: true }).click();
      await game.locator('#tap').waitFor();
      await page.locator('[role=dialog] [data-slot=dialog-close]').click();
      await frame.waitFor({ state: 'detached' });
    } finally {
      await context.close();
    }
  }
  workflow.push('simulated missing/denied fullscreen API, control and notice fallback, restart and close still work');
}

async function verifyReviewTransport(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
  await isolateBrowserContext(context);
  const page = await context.newPage();
  page.setDefaultTimeout(deadline);
  const navigations: string[] = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  const owner = 'a0000000-0000-4000-8000-000000000001';
  const now = new Date().toISOString();
  app.sqlite.prepare('INSERT INTO review_devices(id,owner_id,session_version,token_hash,pairing_hash,name,expires_at,last_seen,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('qa-device', owner, '0', 'synthetic', 'synthetic', '合成审核设备', new Date(Date.now() + 3_600_000).toISOString(), now, now);
  app.sqlite.prepare('INSERT INTO review_jobs(id,owner_id,title,filename,status,stage,model_executor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('qa-capture', owner, '活动采集合成任务', 'capture.html', 'running', 'capture', 'agent', now, now);

  let faults = 0;
  let reads = 0;
  await page.route('**/api/forge/review/jobs', async route => {
    reads++;
    if (faults) {
      faults--;
      await route.fulfill({ status: 503, json: { error: '合成连接故障' } });
    } else await route.continue();
  });
  await page.addInitScript(() => {
    (window as any).qaIntervals = [];
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });
  await page.route('**/src/ui/lib/polling.ts*', async route => {
    const response = await route.fetch();
    const original = await response.text();
    const instrumented = original.replace(/(export function scheduleRead\(read, delay\) \{)/,
      '$1 if (new Error().stack?.includes("/pages/review/jobs.ts")) { window.qaIntervals.push(delay); delay *= .025; }');
    assert.notEqual(instrumented, original, 'test scheduler hook must be applied');
    await route.fulfill({ response, body: instrumented });
  });
  const go = (path: string) => page.goto(app.url + path, { waitUntil: 'domcontentloaded' });
  const text = (value: string) => page.waitForFunction(expected => document.body.innerText.includes(expected), value, { timeout: deadline });
  const confirm = () => page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  try {
    await go('/__preview?role=star');
    await go('/forge/?tab=review&task=qa-capture');
    await text('活动采集合成任务');
    await page.waitForFunction(() => (window as any).qaIntervals.includes(10000) && document.querySelector('.review-job-detail progress:not([value])'));
    faults = 3;
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await page.getByRole('alert').filter({ hasText: '合成连接故障' }).waitFor();
    assert.equal(await page.locator('.review-job-detail progress').count(), 0);
    await page.waitForFunction(() => [15000, 30000, 60000].every(ms => (window as any).qaIntervals.includes(ms)));
    await page.getByRole('alert').filter({ hasText: '合成连接故障' }).waitFor({ state: 'hidden' });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    // Requests that were already dispatched can still reach the fixture while hidden.
    await new Promise(resolve => setTimeout(resolve, 75));
    const before = reads;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await page.evaluate(() => document.hidden), true, JSON.stringify(navigations));
    assert.equal(reads, before, 'the hidden page must not dispatch another review batch');
    app.sqlite.prepare("UPDATE review_jobs SET stage='verify',updated_at=? WHERE id='qa-capture'").run(now);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      (window as any).qaIntervals.length = 0;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await text('等待 Agent 复核结果');
    await page.waitForFunction(() => (window as any).qaIntervals.includes(60000));
    assert.equal(await page.locator('.review-job-detail progress').count(), 0);
    workflow.push('10s active and 60s waiting, hidden pause, 15/30/60 backoff, no ticking on polling failure');

    await go('/forge/?tab=review&reviewTab=devices');
    await text('合成审核设备');
    await page.getByRole('button', { name: '撤销授权', exact: true }).click();
    await confirm();
    await page.getByText('合成审核设备', { exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual({ ...app.sqlite.prepare("SELECT revoked FROM review_devices WHERE id='qa-device'").get() }, { revoked: 1 });

    await go('/forge/?tab=review&task=failed-capture');
    await page.getByRole('button', { name: '移除任务', exact: true }).click();
    await confirm();
    await page.locator('.review-job-detail').waitFor({ state: 'hidden' });
    assert.deepEqual({ ...app.sqlite.prepare("SELECT owner_hidden FROM review_jobs WHERE id='failed-capture'").get() }, { owner_hidden: 1 });
    await go('/forge/?tab=review&reviewTab=history');
    const report = page.getByRole('row').filter({ hasText: 'Paper Orbit · 精确版本 v3' });
    await report.getByRole('button', { name: '移除记录', exact: true }).click();
    await confirm();
    await report.waitFor({ state: 'hidden' });
    assert.deepEqual({ ...app.sqlite.prepare('SELECT owner_hidden FROM reviews WHERE id=82').get() }, { owner_hidden: 1 });
    workflow.push('device revocation, ended task removal and report removal verified through SQLite');

    await go('/__preview?role=admin');
    await go('/square?scope=manage');
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await confirm();
    const restore = page.getByRole('button', { name: '取消下架', exact: true });
    await restore.waitFor();
    assert.deepEqual({ ...app.sqlite.prepare('SELECT hidden FROM gallery_games LIMIT 1').get() }, { hidden: 1 });
    await go('/square');
    await text('本页没有游戏');
    await go('/square?scope=manage');
    await restore.click();
    await confirm();
    await page.getByRole('button', { name: '试玩：Pocket Bloom · 口袋花园' }).waitFor();
    assert.deepEqual({ ...app.sqlite.prepare('SELECT hidden FROM gallery_games LIMIT 1').get() }, { hidden: 0 });
    assert.equal(await page.locator('a[download]').count(), 0);
    workflow.push('admin hide/restore with live eligibility and no download action');
  } finally {
    await context.close();
  }
}

try {
  assert(engines.length, 'PGC_UI_ENGINE must be chromium or webkit');
  assert(selectedRoutes.length, 'PGC_UI_ROUTE did not match a route');
  for (const engine of engines) {
    const browser = await engine.launch();
    try { if (process.env.PGC_UI_WORKFLOW !== 'only') await testLayout(browser, engine.name); }
    finally { await browser.close(); }
  }
  const passive = app.requests.slice();
  const accidentalMutations = passive.filter(request => !['GET', 'HEAD'].includes(request.method));
  if (accidentalMutations.length) noteFailure('read-only route coverage', JSON.stringify(accidentalMutations));
  const apiFailures = [...new Set(passive.filter(request => request.status >= 400 && !(request.status === 401 && request.path === '/api/auth/me')).map(request => `${request.status} ${request.path}`))];
  if (apiFailures.length) noteFailure('principal routes', JSON.stringify(apiFailures));
  if (!process.env.PGC_UI_ROUTE && engines.some(engine => engine.name === 'chromium')) {
    const browser = await engines.find(engine => engine.name === 'chromium')!.launch();
    try { await verifyReviewAndSquare(browser); await verifyFullscreenFallback(browser); if (!built) await verifyReviewTransport(browser); }
    catch (error) { noteFailure('review and square workflows', error); }
    finally { await browser.close(); }
  }
  if (runtimeErrors.length) noteFailure('uncaught page errors', JSON.stringify(runtimeErrors));
  if (app.outbound.length || app.dispatches.length || browserOutbound.size) {
    noteFailure('preview isolation', JSON.stringify({ outbound: app.outbound, browserOutbound: [...browserOutbound], dispatches: app.dispatches }));
  }
  const result = { passed: failures.length === 0, built, browsers: engines.map(engine => engine.name), testedRoutes: selectedRoutes.length,
    passiveRequests: passive.length, measurements, workflow, failures, runtimeErrors, developmentMessages: [...new Set(developmentMessages)],
    outbound: app.outbound, browserOutbound: [...browserOutbound], dispatches: app.dispatches };
  const metricsFile = process.env.PGC_UI_WORKFLOW === 'only' ? 'metrics-workflow.json' : built ? 'metrics-build.json' : requested || process.env.PGC_UI_ROUTE ? 'metrics-subset.json' : 'metrics.json';
  await writeFile(resolve(artifacts, metricsFile), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, browsers: result.browsers, measurements: measurements.length, workflow, failures: failures.length, evidence: artifacts }));
  if (failures.length) process.exitCode = 1;
} finally {
  await app.close();
}
