import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { launchLocalBrowser } from '../server/local-browser';

// Controlled slow responses test waiting UX without spending model tokens or
// modifying team data. The actual UI modules are served unchanged.
const topic = (id: number) => ({ id, status: 'liked', subject: '光点', medium: '像素', gesture: '点击', structure: '节奏', mood: '轻快', data: { title: `进度样例 ${id}`, logline: '用于验证简报生成等待状态。' }, brief_status: '', has_brief: 0, brief_md: '' });
const topics = [topic(1), topic(2)];
let requests = 0, complete = false, fail = false, interrupt = true;
let modelTest = false;
let expansionFinished = false;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  try {
    if (url.pathname === '/api/forge/state') return json({ games: 1, vocab: 5, fresh_subjects: 100, providers: { deepseek: true }, provider: 'deepseek', model: 'deepseek-chat' });
    if (url.pathname === '/api/forge/settings') return json({ draw_size: 2 });
    if (url.pathname === '/api/forge/vocab') return json(['subject', 'medium', 'gesture', 'structure', 'mood'].map((dim, i) => ({ id: i, dim, word: '样例', enabled: 1 })));
    if (url.pathname === '/api/forge/topics') return json(url.search.includes('liked') ? topics.filter(t => t.status === 'liked') : topics.filter(t => t.status === 'drawn'));
    if (url.pathname === '/api/forge/draw') {
      topics.push(...[3, 4].map(id => ({ ...topic(id), status: 'drawn', data: {} as any })));
      return json(topics.slice(2));
    }
    if (url.pathname === '/api/forge/expand') return json({ status: 'pending' }, 202);
    if (/^\/api\/forge\/topics\/\d+\/brief$/.test(url.pathname)) {
      const t = topics[Number(url.pathname.split('/')[4]) - 1];
      requests++; t.brief_status = 'running';
      return json({ id: t.id, status: 'pending' }, 202);
    }
    if (/^\/api\/forge\/topics\/\d+$/.test(url.pathname)) {
      const t = topics[Number(url.pathname.split('/')[4]) - 1];
      if (t.id === 3) { t.data = { title: '已完成扩写', logline: '真实计数测试' }; t.status = 'new'; return json(t); }
      if (t.id === 4) return json(expansionFinished ? { ...t, expand_status: 'error', expand_error: '合成扩写失败' } : { ...t, expand_status: 'running' });
      if (interrupt) { interrupt = false; return json({ error: 'temporary connection loss' }, 503); }
      if (fail && t.id === 2) return json({ ...t, brief_status: 'error', brief_error: '合成接口错误，请重试' });
      if (complete) { t.brief_status = ''; t.has_brief = 1; t.brief_md = `# 新简报 ${requests}\n请制作这个游戏。`; }
      return json(t);
    }
    if (url.pathname.startsWith('/api/admin/')) {
      if (url.pathname.endsWith('/test')) { modelTest = true; await pause(2300); return json({ durationMs: 2300 }); }
      const profile = { baseUrl: 'https://example.com/v1', model: 'test-vision', protocol: 'openai', enabled: true, hasKey: true, updatedAt: '' };
      return json({ ...profile, activeProfile: 'deepseek', profiles: { deepseek: profile, opus: { ...profile, protocol: 'anthropic' } } });
    }
    if (url.pathname === '/api/auth/login') { await pause(1800); return json({ error: '合成登录错误' }, 401); }
    if (url.pathname === '/api/auth/me') return json({ error: 'not signed in' }, 401);
    if (url.pathname === '/test') { response.setHeader('Content-Type', 'text/html'); return response.end(await readFile('public/forge/index.html')); }
    if (url.pathname === '/host') { response.setHeader('Content-Type', 'text/html'); return response.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module">import '/forge/progress.js';document.body.insertAdjacentHTML('beforeend','<iframe title="workbench" src="/test?embedded=1" style="width:100%;height:1000px;border:0"></iframe>');</script></body></html>`); }
    const root = resolve(url.pathname.startsWith('/forge/') || url.pathname.startsWith('/artwork/') ? 'public' : 'dist');
    const pathname = ['/admin', '/login'].includes(url.pathname) ? '/index.html' : url.pathname;
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep)) throw new Error('path');
    const bytes = await readFile(file);
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'image/png');
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await launchLocalBrowser();
await mkdir('artifacts', { recursive: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1360, height: 960 });
  await page.goto(`${origin}/test`);
  await page.waitForSelector('#drawBtn');
  await page.click('[data-tab="picks"]');
  await page.waitForSelector('[data-id="1"] [data-act="brief"]');
  await page.click('[data-id="1"] [data-act="brief"]');
  await page.waitForSelector('#briefProgress [role="progressbar"]');
  assert.equal(await page.$eval('#briefProgress [role="progressbar"]', el => el.hasAttribute('aria-valuenow')), false, 'AI generation must not invent a percent');
  await page.waitForFunction('document.querySelector("#briefProgress").textContent.includes("重新连接")');
  await page.click('#modalClose');
  await page.click('[data-id="1"] [data-act="brief"]');
  assert.equal(requests, 1, 'Repeated progress clicks must not submit another model job');
  await page.waitForFunction('document.querySelector("#briefProgress time").textContent !== "已等待 0 秒"');
  await page.screenshot({ path: 'artifacts/progress-brief.png', fullPage: true });
  await page.click('#modalClose');
  await page.click('[data-tab="vocab"]');
  await page.waitForSelector('[data-task-key="brief-1"][data-task-state="running"]');
  complete = true;
  await page.waitForSelector('[data-task-key="brief-1"][data-task-state="done"]');
  assert.equal(await page.$eval('#modal', el => (el as HTMLElement).hidden), true, 'Background completion must not reopen a closed modal');
  await page.click('[data-task-key="brief-1"] button');
  await page.waitForSelector('#regenBrief');
  assert.match(await page.$eval('#modalBody pre', el => el.textContent!), /新简报 1/);
  complete = false;
  await page.click('#regenBrief');
  await page.waitForSelector('#briefProgress [role="progressbar"]');
  await page.waitForFunction('document.querySelector("#briefProgress").textContent.includes("后台")');
  complete = true;
  await page.waitForSelector('#regenBrief');
  assert.match(await page.$eval('#modalBody pre', el => el.textContent!), /新简报 2/);
  assert.equal(requests, 2);
  console.log('PASS 简报即时反馈、计时、断线恢复、重复点击去重、切栏目保留任务、完成不抢焦点、重新生成。');

  await page.click('#modalClose');
  await page.click('[data-tab="picks"]');
  await page.waitForSelector('[data-id="2"] [data-act="brief"]');
  complete = false; fail = true;
  await page.click('[data-id="2"] [data-act="brief"]');
  await page.waitForSelector('[data-task-key="brief-2"][data-task-state="error"]');
  assert.match(await page.$eval('#briefProgress', el => el.textContent!), /合成接口错误/);
  assert.equal(await page.$eval('#briefProgress [role="progressbar"]', el => el.hasAttribute('aria-valuenow')), false);
  fail = false; complete = true;
  await page.click('[data-task-key="brief-2"] button');
  await page.waitForSelector('[data-task-key="brief-2"][data-task-state="done"]');
  console.log('PASS 简报失败显示原因并能重试，不显示虚假的 100%。');

  // A fresh page observes the saved running state, without POSTing again.
  topics[0].brief_status = 'running'; complete = false;
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await mobile.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const beforeResume = requests;
  await mobile.goto(`${origin}/test`); await mobile.waitForSelector('#drawBtn');
  await mobile.click('[data-tab="picks"]');
  await mobile.waitForSelector('[data-task-key="brief-1"][data-task-state="running"]');
  await mobile.click('[data-id="1"] [data-act="brief"]');
  await mobile.waitForSelector('#briefProgress [role="progressbar"]');
  assert.equal(requests, beforeResume, 'Refreshing must observe an existing job without a new POST');
  await mobile.screenshot({ path: 'artifacts/progress-mobile.png', fullPage: true });
  assert(await mobile.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Mobile progress feedback must not overflow');
  const animation = await mobile.evaluate(async () => {
    const { startTask } = await import('/forge/progress.js' as string);
    startTask('减少动态效果测试');
    return getComputedStyle(document.querySelector('.is-indeterminate > span')!).animationName;
  });
  assert.equal(animation, 'none');
  assert.deepEqual(errors, []);
  console.log('PASS 刷新后恢复观察、手机布局、无障碍进度条与减少动态效果偏好。');
  await mobile.close(); topics[0].brief_status = ''; complete = true;

  const batch = await browser.newPage();
  await batch.goto(`${origin}/test`); await batch.waitForSelector('#drawBtn'); await batch.click('#drawBtn');
  await batch.waitForFunction('document.querySelector("#progress [role=progressbar]")?.getAttribute("aria-valuenow") === "1"');
  assert.equal(await batch.$eval('#progress [role="progressbar"]', el => el.getAttribute('aria-valuemax')), '2');
  expansionFinished = true;
  await batch.waitForSelector('#progress .is-error');
  assert.equal(await batch.$eval('#progress [role="progressbar"]', el => el.getAttribute('aria-valuenow')), '1', 'Failed expansion is not counted as a generated topic');
  assert.match(await batch.$eval('#progress', el => el.textContent!), /1 个未完成/);
  console.log('PASS 批量扩写真实完成计数，部分失败不显示全部完成。');
  await batch.close();

  const host = await browser.newPage();
  await host.goto(`${origin}/host`);
  await host.waitForFunction('document.querySelector("iframe").contentDocument.querySelector("#drawBtn")');
  const frame = host.frames().find(f => f.url().includes('/test'))!;
  await frame.evaluate(async () => {
    const { startTask } = await import('/forge/progress.js' as string);
    startTask('嵌入任务',{key:'embedded-test'});
  });
  await host.waitForSelector('[data-task-key="embedded-test"]');
  assert.equal(await frame.$('.pgc-task-tray'), null, 'Embedded tasks must appear in parent viewport, not below iframe fold');
  await host.$eval('iframe', element => element.remove());
  await host.waitForFunction('!document.querySelector("[data-task-key=embedded-test]")');
  console.log('PASS 管理页 iframe 任务进度显示在外层页面。');

  const admin = await browser.newPage();
  await admin.goto(`${origin}/admin`);
  await admin.waitForSelector('#tab-model'); await admin.click('#tab-model');
  await admin.click('#test-model');
  await admin.waitForFunction('document.querySelector(".pgc-task-tray").textContent.includes("测试模型连接")');
  assert(modelTest);
  await admin.screenshot({ path: 'artifacts/progress-admin.png', fullPage: true });
  await admin.waitForFunction('document.querySelector("#config-message").textContent.includes("连接成功")');
  const login = await browser.newPage();
  await login.goto(`${origin}/login`); await login.waitForSelector('#username');
  await login.type('#username', 'progress-test'); await login.type('#password', 'synthetic-password');
  await login.click('#member-login button');
  await login.waitForSelector('.pgc-task [data-progress-since]');
  await login.waitForFunction('document.querySelector("#login-message").textContent.includes("合成登录错误")');
  console.log('PASS 生产构建的管理页模型测试、成员登录等待与失败反馈。');
} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
