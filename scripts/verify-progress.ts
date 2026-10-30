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
let adminSignedIn = false;
let expansionFinished = false;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  try {
    if (url.pathname === '/api/forge/state') return json({ games: 1, vocab: 5, fresh_subjects: 100, providers: { deepseek: true }, provider: 'deepseek', model: 'deepseek-chat' });
    if (url.pathname === '/api/forge/settings') return json({ draw_size: 2 });
    if (url.pathname === '/api/forge/generation-jobs') return json([]);
    if (url.pathname === '/api/forge/products') return json([]);
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
      if (url.pathname.endsWith('/login')) { adminSignedIn = true; return json({ ok: true }); }
      if (!adminSignedIn) return json({ error: 'not signed in' }, 401);
      if (url.pathname.endsWith('/test')) { modelTest = true; await pause(2300); return json({ durationMs: 2300 }); }
      const profile = { name: 'Synthetic model', baseUrl: 'https://example.com/v1', model: 'test-vision', protocol: 'openai', enabled: true, hasKey: true, updatedAt: '' };
      return json({ ...profile, activeProfile: 'deepseek', profiles: { deepseek: profile, opus: { ...profile, protocol: 'anthropic' } }, routes: {}, effective: {} });
    }
    if (url.pathname === '/api/auth/login') { await pause(1800); return json({ error: '合成登录错误' }, 401); }
    if (url.pathname === '/api/auth/me') return request.headers.referer?.includes('/login')?json({error:'not signed in'},401):json({id:'fixture-star',role:'member',star:true,canReview:true,displayName:'进度验证'});
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
  await page.goto(`${origin}/test?tab=draw&layout=cards`);
  await page.waitForSelector('#drawBtn');
  await page.click('[data-tab="picks"]');
  await page.waitForSelector('[data-id="1"] [data-act="brief"]');
  await page.click('[data-id="1"] [data-act="brief"]');
  await page.waitForSelector('[data-id="1"] .creation-job-progress [role="progressbar"]');
  assert.equal(await page.$eval('[data-id="1"] .creation-job-progress [role="progressbar"]', el => el.hasAttribute('aria-valuenow')), false, 'AI generation must not invent a percent');
  assert.equal(await page.$eval(':focus', el => el.classList.contains('creation-job-progress')), true, 'Keyboard focus should move to the owning card progress when its action becomes disabled');
  await page.waitForFunction(() => document.querySelector('[data-id="1"] .creation-job-progress')?.textContent?.includes('重新连接'));
  assert.equal(await page.$eval('[data-id="1"] [data-act="brief"]', el => (el as HTMLButtonElement).disabled), true, 'A running generation action must be disabled');
  assert.equal(requests, 1, 'Repeated progress clicks must not submit another model job');
  await page.screenshot({ path: 'artifacts/progress-brief.png', fullPage: true });
  await page.click('[data-tab="vocab"]');
  assert.equal(await page.evaluate(() => { const tray = document.querySelector('.pgc-task-tray'); return !tray || getComputedStyle(tray).display === 'none'; }), true, 'Inline creation progress must not show a global task tray');
  await page.click('[data-tab="picks"]');
  await page.waitForSelector('[data-id="1"] .creation-job-progress [role="progressbar"]');
  await page.click('[data-tab="vocab"]');
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-tab="vocab"]')?.focus());
  complete = true;
  // The first status read deliberately returns 503. Let the client pass its
  // bounded reconnect delay before asserting background completion.
  await page.waitForFunction(() => document.querySelector('[data-tab="vocab"]') === document.activeElement);
  await new Promise<void>((resolve, reject) => { const deadline=Date.now()+30000;const check=()=>topics[0].has_brief?resolve():Date.now()>deadline?reject(new Error('Background brief did not finish')):setTimeout(check,100);check(); });
  assert.equal(topics[0].has_brief, 1, 'The background generation must finish while another tab is active');
  assert.equal(await page.$eval(':focus', el => el.getAttribute('data-tab')), 'vocab', 'Background completion must not steal keyboard focus');
  assert.equal(await page.evaluate(() => { const tray = document.querySelector('.pgc-task-tray'); return !tray || getComputedStyle(tray).display === 'none'; }), true, 'Background completion must not show a global task tray');
  await page.click('[data-tab="picks"]');
  await page.waitForFunction(() => document.querySelector('[data-id="1"] [data-act="brief"] small')?.textContent?.includes('查看'));
  await page.click('[data-id="1"] [data-act="brief"]');
  await page.waitForSelector('[data-id="1"] .creation-viewer');
  assert.match(await page.$eval('[data-id="1"] .brief-document', el => el.textContent!), /新简报 1/);
  assert.equal(await page.$eval('#modal', el => (el as HTMLElement).hidden), true, 'The artifact must open in the card without a modal');
  await page.screenshot({ path: 'artifacts/progress-brief.png', fullPage: true });
  complete = false;
  await page.click('[data-id="1"] .creation-viewer [data-viewer-act="regenerate"]');
  await page.waitForFunction(() => document.querySelector('[data-id="1"] .creation-job-progress [role="progressbar"]'));
  await page.waitForFunction(() => document.querySelector('[data-id="1"] .creation-viewer .brief-document')?.textContent?.includes('新简报 2'), { timeout: 5000 }).catch(() => {});
  complete = true;
  await page.waitForFunction(() => document.querySelector('[data-id="1"] .creation-viewer .brief-document')?.textContent?.includes('新简报 2'));
  assert.equal(requests, 2);
  console.log('PASS 卡片内进度、断线恢复、重复点击去重、切栏目保留任务、后台完成不抢焦点、卡片内预览和重新生成。');

  await page.waitForSelector('[data-id="2"] [data-act="brief"]');
  complete = false; fail = true;
  await page.click('[data-id="2"] [data-act="brief"]');
  await page.waitForSelector('[data-id="2"] .small.bad button[data-act="retryJob"]');
  assert.match(await page.$eval('[data-id="2"]', el => el.textContent!), /合成接口错误/);
  assert.equal(await page.$('[data-id="2"] .creation-job-progress'), null, 'A failed job should show its actionable error instead of a stale progress bar');
  assert.equal(await page.evaluate(() => { const tray = document.querySelector('.pgc-task-tray'); return !tray || getComputedStyle(tray).display === 'none'; }), true, 'Failed card generation must not show a global task tray');
  fail = false; complete = true;
  await page.click('[data-id="2"] .small.bad button[data-act="retryJob"]');
  await page.waitForFunction(() => document.querySelector('[data-id="2"] .creation-card-notice')?.textContent?.includes('简报已生成'));
  assert.match(topics[1].brief_md, /新简报/);
  console.log('PASS 卡片内失败原因与重试，不显示虚假的 100%。');

  // A fresh page observes the saved running state, without POSTing again.
  topics[0].brief_status = 'running'; complete = false;
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await mobile.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const beforeResume = requests;
  await mobile.goto(`${origin}/test?tab=draw&layout=cards`); await mobile.waitForSelector('#drawBtn');
  await mobile.click('[data-tab="picks"]');
  await mobile.waitForSelector('[data-id="1"] .creation-job-progress [role="progressbar"]');
  assert.equal(requests, beforeResume, 'Refreshing must observe an existing job without a new POST');
  assert.equal(await mobile.evaluate(() => { const tray = document.querySelector('.pgc-task-tray'); return !tray || getComputedStyle(tray).display === 'none'; }), true, 'Restored creation progress must remain inside its card');
  await mobile.screenshot({ path: 'artifacts/progress-mobile.png', fullPage: true });
  assert(await mobile.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Mobile progress feedback must not overflow');
  const animation = await mobile.evaluate(async () => {
    const { startTask } = await import('/forge/progress.js' as string);
    startTask('减少动态效果测试',{tray:true});
    return getComputedStyle(document.querySelector('.is-indeterminate > span')!).animationName;
  });
  assert.equal(animation, 'none');
  assert.deepEqual(errors, []);
  console.log('PASS 刷新后恢复观察、手机布局、无障碍进度条与减少动态效果偏好。');
  await mobile.close(); topics[0].brief_status = ''; complete = true;

  const batch = await browser.newPage();
  await batch.goto(`${origin}/test?tab=draw&layout=cards`); await batch.waitForSelector('#drawBtn'); await batch.click('#drawBtn');
  await batch.waitForFunction('document.querySelector("#progress [role=progressbar]")?.getAttribute("aria-valuenow") === "1"');
  assert.equal(await batch.$eval('#progress [role="progressbar"]', el => el.getAttribute('aria-valuemax')), '2');
  expansionFinished = true;
  await batch.waitForSelector('#progress .is-error');
  assert.equal(await batch.$eval('#progress [role="progressbar"]', el => el.getAttribute('aria-valuenow')), '2', 'Progress counts settled jobs, including explicit failures');
  assert.match(await batch.$eval('#progress', el => el.textContent!), /1 个已生成/);
  assert.match(await batch.$eval('#progress', el => el.textContent!), /1 个未完成/);
  console.log('PASS 批量扩写真实完成计数，部分失败不显示全部完成。');
  await batch.close();

  const host = await browser.newPage();
  await host.goto(`${origin}/host`);
  await host.waitForFunction('document.querySelector("iframe").contentDocument.querySelector("#pickCards")');
  const frame = host.frames().find(f => f.url().includes('/test'))!;
  await frame.evaluate(async () => {
    const { startTask } = await import('/forge/progress.js' as string);
    startTask('嵌入任务',{key:'embedded-test',tray:true});
  });
  await host.waitForSelector('[data-task-key="embedded-test"]');
  assert.equal(await frame.$('.pgc-task-tray'), null, 'Embedded tasks must appear in parent viewport, not below iframe fold');
  await host.$eval('iframe', element => element.remove());
  await host.waitForFunction('!document.querySelector("[data-task-key=embedded-test]")');
  console.log('PASS 管理页 iframe 任务进度显示在外层页面。');

  const admin = await browser.newPage();
  await admin.goto(`${origin}/admin`);
  await admin.waitForSelector('#admin-password');
  assert.equal(await admin.$('.pgc-task[data-task-state="error"]'), null, 'The expected initial login gate must not leave a failed task');
  await admin.type('#admin-password', 'synthetic-admin'); await admin.click('#login-form button');
  await admin.waitForSelector('#tab-settings'); await admin.click('#tab-settings');
  await admin.waitForSelector('[data-settings="model"]'); await admin.click('[data-settings="model"]');
  await admin.waitForSelector('[data-profile="deepseek"]');await admin.click('[data-profile="deepseek"]');
  await admin.click('#test-model');
  await admin.waitForFunction('document.querySelector("#config-message").textContent.includes("连接成功")');
  assert(modelTest);
  await admin.screenshot({ path: 'artifacts/progress-admin.png', fullPage: true });
  const login = await browser.newPage();
  await login.goto(`${origin}/login`); await login.waitForSelector('#username');
  await login.type('#username', 'progress-test'); await login.type('#password', 'synthetic-password');
  await login.click('#member-login button');
  await login.waitForSelector('#member-login button:disabled');
  assert.equal(await login.$eval('#login-message',node=>node.textContent),'正在登录…');
  await login.waitForFunction('document.querySelector("#login-message").textContent.includes("合成登录错误")');
  console.log('PASS 生产构建的管理页模型测试、成员登录等待与失败反馈。');
} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
