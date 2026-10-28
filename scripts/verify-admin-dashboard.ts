import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { adminApi } from '../server/admin-api';
import { authApi } from '../server/auth-api';
import { configStore, memberStore } from '../server/storage';
import { hashPassword } from '../server/members';
import { login } from '../server/settings';
import { saveArtifact } from '../server/forge-workspace';
import { launchLocalBrowser } from '../server/local-browser';

// The real administrator entry and APIs, backed only by a synthetic local DB.
// --serve keeps the HTTP server alive after checking it for interactive review.
const serve = process.argv.includes('--serve');
const root = process.cwd(), temp = path.join(os.tmpdir(), `pgc-admin-dashboard-${Date.now()}`), output = path.resolve('artifacts');
process.once('exit', () => { if (path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('pgc-admin-dashboard-')) rmSync(temp, { recursive: true, force: true }); });
await Promise.all([mkdir(temp, { recursive: true }), mkdir(output, { recursive: true })]);
const sqlite = new DatabaseSync(':memory:');
for (const migration of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(await readFile(path.join('migrations', migration), 'utf8'));
const DB: any = {
  prepare(sql: string) {
    let params: any[] = [];
    const statement: any = { bind(...values: any[]) { params = values; return statement; }, first: async () => sqlite.prepare(sql).get(...params) || null, all: async () => ({ results: sqlite.prepare(sql).all(...params) }), run: async () => { const result = sqlite.prepare(sql).run(...params); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }, execute: () => sqlite.prepare(sql).run(...params) };
    return statement;
  },
  batch: async (statements: any[]) => { sqlite.exec('BEGIN'); try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
};
const now = new Date().toISOString(), memberA = 'a0000000-0000-4000-8000-000000000001', memberB = 'b0000000-0000-4000-8000-000000000002';
const secrets = { ADMIN_PASSWORD: 'local-synthetic-admin', SETTINGS_KEY: 'local-synthetic-secret' };
const password = await hashPassword('local-synthetic-member');
for (const [id, username, name, enabled, star] of [[memberA, 'lin', '林小满', 1, 1], [memberB, 'zhou', '周可可', 1, 1], ['c0000000-0000-4000-8000-000000000003', 'chen', '陈一诺', 1, 0], ['d0000000-0000-4000-8000-000000000004', 'gu', '顾遥', 0, 1]] as const) sqlite.prepare('INSERT INTO members(id,username,display_name,password_hash,password_salt,enabled,star,can_review,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, username, name, password.hash, password.salt, enabled, star, 1, now, now);
const titles = ['Pocket Bloom · 口袋花园', 'Moon Post · 月光邮局', 'Rain Radio · 雨天电台', 'Paper Orbit · 纸上轨道', 'Tiny Tide · 微光潮汐', 'Dream Parcel · 梦境包裹'];
const palette = ['#e6edd8', '#e4e8ed', '#e9e2d8', '#e6e2ef', '#dcebe5', '#f1e7d7'];
function insert(table: string, values: Record<string, any>) { sqlite.prepare(`INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values)); }
for (let i = 1; i <= 342; i++) {
  const owner = i % 2 ? memberA : memberB;
  insert('topics', { id: i, owner_id: owner, batch: 'admin-browser-fixture', subject: `合成题材 ${i}`, medium: '水彩', gesture: 'tap', structure: 'score', mood: 'calm', status: i <= 18 ? 'made' : i % 5 ? 'liked' : 'drawn', data: JSON.stringify({ title: i === 1 ? titles[0] : `${titles[i % titles.length]} ${i}`, logline: '在轻触之间完成一段小小的冒险。', core_loop: '观察 → 轻触 → 获得反馈 → 解锁新变化', controls: '单指轻触与拖动', art_direction: '暖白底色、细腻水彩和柔和鼠尾草绿', risks: '首屏需要明确提示可点击区域', aes: 3, ease: 3, play: 3, private_html: 'SOURCE_NOT_FOR_LISTS' }), requirements: '540×960 竖屏；首屏可玩；提供重开入口。', created_at: now, updated_at: now });
  insert('forge_tasks', { id: `creation-${String(i).padStart(3, '0')}`, owner_id: owner, kind: 'brief', scope: `${owner}:brief:${i}`, payload: JSON.stringify({ type: 'brief', id: i }), status: i % 11 ? 'done' : 'error', executor: i % 7 ? 'platform' : 'agent', input_snapshot: JSON.stringify({ cfg: { template: 'SYNTHETIC_INPUT' }, topic: { id: i, owner_id: owner, data: { title: `Original ${i}` } }, revision: 0, policy_revision: 0, heads: {} }), detail: i % 11 ? '简报已保存' : '执行未完成', error: i % 11 ? '' : 'model timeout: request deadline exceeded', created_at: now, updated_at: now });
}
insert('games', { id: 1, owner_id: memberB, title: '历史导入 · Wind Letter', descr: '这是一份历史导入作品的描述。', updated_at: now });
const gameHtml = (label: string, color: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${color};font:22px system-ui;color:#5e7350;touch-action:manipulation}body{display:grid;place-items:center}.stage{width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:24px}small{font-size:14px}button{font:inherit;border:1px solid #879d76;background:#ffffffaa;color:#5b754a;border-radius:50%;width:110px;height:110px;touch-action:manipulation}p{margin:0}#score{font-size:36px}</style></head><body><div class="stage"><small>${label}</small><p>让一朵小花生长</p><button id="tap" aria-label="种下种子">✿</button><p id="score">0</p><small>轻触花朵，收集光点</small></div><script>document.querySelector('#tap').addEventListener('click',()=>{document.querySelector('#score').textContent=String(Number(document.querySelector('#score').textContent)+1)});</script></body></html>`;
const save = (id: number, kind: string, content: string) => saveArtifact(DB, { owner: id % 2 ? memberA : memberB, topicId: id, kind, content, revision: 0, executor: 'platform', model: 'synthetic-fixture', force: true });
for (let i = 1; i <= 18; i++) {
  await save(i, 'preview', `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="340" viewBox="0 0 600 340"><rect width="600" height="340" fill="${palette[i % palette.length]}"/><circle cx="300" cy="175" r="76" fill="#ffffff38"/><path d="M300 248V126m0 45-34-27m34 59 38-33" stroke="#91a57e" stroke-width="9" stroke-linecap="round" fill="none"/><circle cx="300" cy="118" r="27" fill="#d8c59e"/></svg>`);
  await save(i, 'game', gameHtml('CURRENT FIXTURE VERSION', palette[i % palette.length]));
}
const oldGame = await save(1, 'game', gameHtml('IMMUTABLE OLD VERSION', '#edf0db'));
const currentGame = await save(1, 'game', gameHtml('CURRENT FIXTURE VERSION', '#e8eedb'));
await save(1, 'brief', '# F. 本款设计\n\n## F1. 核心循环\n轻触花朵，收集光点，组合新的花色。\n\n## F2. 操作\n单指轻触；每次点击立即反馈。\n\n<script>window.__unsafeBrief=1</script>');
await save(1, 'assets', '<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:#f5f7ee;display:grid;place-items:center;height:100vh;color:#7b9568;font:26px system-ui"><p>ASSET FIXTURE · ✿ ❋ ❀</p></body></html>');
sqlite.prepare('UPDATE topics SET updated_at=? WHERE id=1').run(new Date(Date.now() + 1000).toISOString());
insert('forge_tasks', { id: 'platform-active', owner_id: memberA, kind: 'game', scope: `${memberA}:game:339`, payload: JSON.stringify({ type: 'game', id: 339 }), status: 'running', executor: 'platform', detail: '正在生成游戏，已接收 8,320 字符', created_at: now, updated_at: now, started_at: now });
insert('forge_tasks', { id: 'agent-original', owner_id: memberB, kind: 'game', scope: `${memberB}:game:340`, payload: JSON.stringify({ type: 'game', id: 340 }), status: 'running', executor: 'agent', detail: '等待成员 Agent 继续回传', created_at: now, updated_at: now });
insert('review_jobs', { id: 'review-agent-original', owner_id: memberA, title: titles[0], filename: 'pocket-bloom.html', status: 'running', stage: 'review', model_executor: 'agent', created_at: now, updated_at: now });
const reviewResult = { title: titles[0], score: 8, aes: 3, ease: 3, play: 2, summary: '合成报告，仅用于测试后台路由。' };
insert('reviews', { id: 81, owner_id: memberA, title: titles[0], topic_id: 1, score: 8, result: JSON.stringify(reviewResult), probe: '{}', model_executor: 'agent', created_at: now });
const dispatches: string[] = [], modelCalls: string[] = [];
const runtime: any = { FORGE_RUNNER: { idFromName: (id: string) => id, get: (id: string) => ({ fetch: async () => { dispatches.push(id); return Response.json({ ok: true }); } }) }, CHECK_RATE_LIMIT: { limit: async () => ({ success: true }) }, FORGE_RATE_LIMIT: { limit: async () => ({ success: true }) } };
const store = configStore(DB), members = memberStore(DB), token = await login(secrets.ADMIN_PASSWORD, secrets);
assert(token);
await build({ entryPoints: [path.resolve('src/admin.ts')], bundle: true, format: 'esm', target: 'es2022', platform: 'browser', outfile: path.join(temp, 'admin.js'), logLevel: 'silent' });
type RequestRecord = { method: string; path: string; status: number };
const requests: RequestRecord[] = [], serverErrors: string[] = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; if (!url.startsWith('http://127.0.0.1:')) { modelCalls.push(new URL(url).origin); throw new Error('Synthetic verification blocks all outbound requests.'); } return nativeFetch(input, init); }) as typeof fetch;
const server = createServer(async (req, res) => {
  const origin = `http://${req.headers.host}`, url = new URL(req.url || '/', origin);
  try {
    if (url.pathname === '/__fixture') { res.writeHead(302, { 'Set-Cookie': `pgc_admin=${token}; Path=/; HttpOnly; SameSite=Strict`, Location: '/admin?view=overview' }); res.end(); return; }
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : Buffer.concat(chunks) });
      const response = await (url.pathname.startsWith('/api/admin/') ? adminApi(request, store, secrets, members, DB, runtime) : authApi(request, members, secrets));
      const result = response || new Response('not found', { status: 404 }); requests.push({ method: req.method || 'GET', path: `${url.pathname}${url.search}`, status: result.status });
      res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer())); return;
    }
    if (url.pathname === '/admin' || url.pathname === '/admin/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理员合成验收</title><link rel="stylesheet" href="/__build/admin.css"><div id="app"></div><script type="module" src="/__build/admin.js"></script></html>'); return; }
    const base = url.pathname.startsWith('/__build/') ? temp : path.resolve('public'), relative = url.pathname.startsWith('/__build/') ? url.pathname.slice('/__build/'.length) : url.pathname.slice(1), target = path.resolve(base, relative);
    if (!target.startsWith(`${base}${path.sep}`)) { res.writeHead(403); res.end(); return; }
    const content = await readFile(target), extension = path.extname(target); res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8' } as Record<string, string>)[extension] || 'application/octet-stream'); res.end(content);
  } catch (error) { const message = error instanceof Error ? error.message : String(error); if (!(error as any)?.code || (error as any).code !== 'ENOENT') serverErrors.push(message); res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`, fixtureUrl = `${base}/__fixture`;
console.log(`LOCAL_ADMIN_FIXTURE_URL=${fixtureUrl}`);
const browser = await launchLocalBrowser(), checks: string[] = [];
const wait = (page: any, selector: string) => page.waitForSelector(selector, { timeout: 15000 });
try {
  const page = await browser.newPage(), pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await browser.defaultBrowserContext().overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(fixtureUrl); await wait(page, '.adm-metrics');
  assert.equal(await page.$$eval('iframe', nodes => nodes.length), 0);
  assert(!requests.some(request => /\/api\/admin\/(config|quota)/.test(request.path)));
  assert(!requests.some(request => /\/material\/(game|brief|assets|expand)(?:\?|$)/.test(request.path)));
  checks.push('真实后台首页只读取概览和缩略图，不请求模型配置、余额或材料源代码');
  await page.screenshot({ path: path.join(output, 'admin-dashboard-desktop.png'), fullPage: true });
  await page.click('[data-metric=members]'); await wait(page, '.adm-manage'); await page.waitForFunction(() => new URL(location.href).searchParams.get('view') === 'members' && document.querySelector('#admin-view h1')?.textContent === '成员管理');
  assert(requests.some(request => request.path === '/api/admin/members')); checks.push('总览指标可进入真实成员管理页');
  await page.goBack(); await wait(page, '.adm-metrics'); await page.click(`.adm-member-link[data-member="${memberA}"]`); await wait(page, '.content-project-card');
  assert.equal(new URL(page.url()).searchParams.get('owner'), memberA); assert.equal(await page.$$eval('iframe', nodes => nodes.length), 0); checks.push('总览成员进入该成员作品并保留日期筛选');
  await page.goto(`${base}/admin?view=works&page=15`); await wait(page, '.content-project-card');
  assert.equal(await page.$$eval('.content-project-card', nodes => nodes.length), 7); assert((await page.$eval('.content-pagination', node => node.textContent))!.includes('343')); checks.push('343 个真实SQLite项目可翻到第15页，总数与尾页准确');
  const returnUrl = `${base}/admin?view=works&owner=${memberA}&page=2&layout=list`;
  await page.goto(returnUrl); await wait(page, '.content-project-card');
  const cards = await page.$$('.content-project-card'); await cards[6].scrollIntoView(); await page.evaluate(() => window.scrollBy(0, -90)); const returnScroll = await page.evaluate(() => scrollY);
  await cards[6].click(); await wait(page, '.content-tabs'); const detailUrl = page.url(); await page.reload(); await wait(page, '.content-tabs'); assert.equal(page.url(), detailUrl);
  await page.click('[data-back]'); await wait(page, '.content-project-card'); assert.equal(new URL(page.url()).searchParams.get('page'), '2'); assert.equal(new URL(page.url()).searchParams.get('owner'), memberA); await page.waitForFunction((target: number) => Math.abs(scrollY - target) < 70, {}, returnScroll); checks.push('独立作品详情可刷新，返回恢复成员/页码/布局和列表滚动位置');
  await page.click('.content-project-card'); await wait(page, '.content-tabs'); await page.goBack(); await wait(page, '.content-project-card'); checks.push('浏览器后退恢复作品列表');
  await page.goto(`${base}/admin?view=works&type=topic&id=1`); await wait(page, '.game-player iframe');
  assert.equal(await page.$$eval('iframe', nodes => nodes.length), 1); assert.equal(await page.$eval('iframe', node => node.getAttribute('sandbox')), 'allow-scripts');
  assert(!requests.some(request => request.path.includes('raw=1')));
  let stage = await page.$eval('.game-player-stage', node => { const r = node.getBoundingClientRect(); return r.width / r.height; }); assert(Math.abs(stage - 9 / 16) < .002);
  const gameFrame = await (await page.$('iframe'))!.contentFrame(); assert(gameFrame); await gameFrame.waitForSelector('#tap'); await gameFrame.click('#tap'); assert.equal(await gameFrame.$eval('#score', node => node.textContent), '1');
  await page.click('[data-player-reload]'); await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow !== null); await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('src')?.includes('/material/game/preview')); const reloaded = await (await page.$('iframe'))!.contentFrame(); assert(reloaded); await reloaded.waitForSelector('#score'); await reloaded.waitForFunction(() => document.querySelector('#score')?.textContent === '0');
  await page.click('[data-player-fullscreen]'); await page.waitForFunction(() => !!document.fullscreenElement); stage = await page.$eval('.game-player-stage', node => { const r = node.getBoundingClientRect(); return r.width / r.height; }); assert(Math.abs(stage - 9 / 16) < .002); await page.evaluate(() => document.exitFullscreen()); checks.push('共享播放器固定9:16、实际交互、重载清空状态及全屏工作');
  await page.screenshot({ path: path.join(output, 'admin-dashboard-game-desktop.png'), fullPage: true });
  for (const kind of ['preview', 'assets']) { await page.click(`[data-panel=${kind}]`); await wait(page, '.content-visual-preview iframe'); assert.equal(await page.$$eval('iframe', nodes => nodes.length), 1); assert.equal(await page.$$eval('.game-player', nodes => nodes.length), 0); }
  assert(gameFrame.detached); checks.push('样板图与资产只运行当前一个隔离iframe，切换销毁旧游戏');
  await page.click('[data-panel=brief]'); await wait(page, '.brief-document'); assert.equal(await page.$$eval('iframe', nodes => nodes.length), 0); assert.equal(await page.evaluate(() => (window as any).__unsafeBrief), undefined); assert(!requests.some(request => request.path.includes('raw=1')));
  await page.click('[data-panel=overview]'); await wait(page, '.content-design'); await page.click('[data-show-expand]'); await wait(page, '[data-expand-content] .content-design'); assert(!await page.$('[data-expand-content] pre')); checks.push('简报安全渲染，概览与方案使用可读字段，默认不展示源码');
  await page.click('[data-panel=history]'); await wait(page, `[data-version="${oldGame.id}"]`); assert.equal(await page.$$eval('iframe', nodes => nodes.length), 0); await page.click(`[data-version="${oldGame.id}"]`); await wait(page, '.game-player iframe');
  const oldSrc = await page.$eval('iframe', node => node.getAttribute('src')); assert(oldSrc?.includes(`version=${oldGame.id}`)); const oldFrame = await (await page.$('iframe'))!.contentFrame(); assert(oldFrame); await oldFrame.waitForFunction(() => document.body.textContent?.includes('IMMUTABLE OLD VERSION'));
  const oldFile = await page.$eval('[data-version-content] a[download]', node => node.getAttribute('href')); assert(oldFile?.includes(`version=${oldGame.id}`)); await page.click('.content-source summary'); await wait(page, '.content-source pre'); assert((await page.$eval('.content-source pre', node => node.textContent))!.includes('IMMUTABLE OLD VERSION')); checks.push('历史预览、下载和主动源码读取均绑定所选不可变旧版本');
  await page.click('[data-copy-project-link]'); await page.waitForSelector('#admin-notice:not([hidden])'); assert.equal(await page.$eval('#admin-notice', node => node.textContent), '作品链接已复制'); await page.waitForFunction(async () => await navigator.clipboard.readText() === location.href); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), page.url()); checks.push('作品复制链接包含当前历史标签及不可变版本编号');
  await page.goto(`${base}/admin?view=works&type=topic&id=1&panel=history&version=missing`); await wait(page, '.content-version-detail .content-empty'); assert.equal(await page.$$eval('iframe', nodes => nodes.length), 0); checks.push('不存在的历史版本显示独立不可用状态，不回退到当前游戏');
  await page.goto(`${base}/admin?view=tasks&page=14`); await wait(page, '.content-task-row'); assert((await page.$eval('.content-pagination', node => node.textContent))!.includes('345')); checks.push('345个创作/审核任务使用真实数据库分页');
  await page.goto(`${base}/admin?view=tasks&type=creation&id=agent-original`); await wait(page, '[data-copy-prompt]'); assert((await page.$eval('.content-continue pre', node => node.textContent))!.includes('agent-original')); assert.equal(await page.$$eval('[data-show-retry]', nodes => nodes.length), 0); checks.push('成员Agent任务显示原编号继续指令，平台不代执行');
  await page.goto(`${base}/admin?view=tasks&type=creation&id=creation-011`); await wait(page, '[data-show-retry]'); const before = requests.filter(request => request.method === 'POST').length; await page.click('[data-show-retry]'); assert.equal(requests.filter(request => request.method === 'POST').length, before); await page.click('[data-cancel-retry]'); await page.click('[data-show-retry]'); await page.click('[data-confirm-retry]'); await page.waitForFunction(() => new URL(location.href).searchParams.get('id') !== 'creation-011'); await wait(page, '.content-task-status'); assert.equal(requests.filter(request => request.method === 'POST' && request.path.includes('/retry')).length, 1); assert.equal(dispatches.length, 1); assert.equal((sqlite.prepare("SELECT count(*) n FROM forge_tasks WHERE retry_of='creation-011'").get() as any).n, 1); checks.push('真实重试API通过内联确认新建一次任务，执行器仅模拟调度');
  await page.goto(`${base}/admin?view=overview`); await wait(page, '.adm-metrics'); await page.click('[data-metric=tasks]'); await wait(page, '.content-task-row'); assert.equal(new URL(page.url()).searchParams.get('status'), 'active'); checks.push('总览进行中指标进入平台活动任务筛选');
  await page.focus('[name=q]'); await page.type('[name=q]', '尚未提交'); await page.$eval('[name=q]', node => node.setAttribute('data-poll-focus', 'retained')); sqlite.prepare("UPDATE forge_tasks SET detail='SYNTHETIC_POLL_UPDATED',updated_at=? WHERE id='platform-active'").run(new Date().toISOString()); await page.waitForFunction(() => document.querySelector('.content-task-list')?.textContent?.includes('SYNTHETIC_POLL_UPDATED'), { timeout: 18000 }); assert.equal(await page.$eval('[name=q]', node => (node as HTMLInputElement).value), '尚未提交'); assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-poll-focus')), 'retained'); checks.push('真实10秒轮询更新任务状态并保留未提交搜索与原输入焦点');
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await page.goto(`${base}/admin?view=overview`); await wait(page, '.adm-metrics'); await page.click('#admin-menu'); assert.equal(await page.$eval('#admin-menu', node => node.getAttribute('aria-expanded')), 'true'); await page.click('[data-admin-view=works]'); await wait(page, '.content-project-card'); assert.equal(await page.$eval('#admin-menu', node => node.getAttribute('aria-expanded')), 'false'); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'admin-dashboard-works-mobile.png'), fullPage: true }); await page.goto(`${base}/admin?view=works&type=topic&id=1`); await wait(page, '.game-player iframe'); const mobileFrame = await (await page.$('iframe'))!.contentFrame(); assert(mobileFrame); await mobileFrame.waitForSelector('#tap'); await (await mobileFrame.$('#tap'))!.tap(); assert.equal(await mobileFrame.$eval('#score', node => node.textContent), '1'); stage = await page.$eval('.game-player-stage', node => { const r = node.getBoundingClientRect(); return r.width / r.height; }); assert(Math.abs(stage - 9 / 16) < .002); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: path.join(output, 'admin-dashboard-game-mobile.png'), fullPage: true }); checks.push('手机导航可开关，作品无横向溢出，真实触摸在9:16游戏中生效');
  assert.deepEqual(pageErrors, []); assert.deepEqual(serverErrors, []); assert.deepEqual(modelCalls, []); checks.push('真实入口全流程无页面/服务异常，无外部模型或生产请求');
  const evidence = { passed: checks.length, fixture: { projects: 343, initialTasks: 345, members: 4, oldVersion: oldGame.id, currentVersion: currentGame.id }, checks, requests, modelCalls: modelCalls.length, mockedDispatches: dispatches.length };
  await writeFile(path.join(output, 'admin-dashboard-verification.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ passed: checks.length, checks, url: serve ? fixtureUrl : undefined }, null, 2));
} finally {
  await browser.close();
  if (!serve) { await new Promise<void>(resolve => server.close(() => resolve())); sqlite.close(); globalThis.fetch = nativeFetch; await rm(temp, { recursive: true, force: true }); }
}
if (serve) {
  console.log(`Interactive fixture ready: ${fixtureUrl}`);
  const close = () => { server.close(); sqlite.close(); globalThis.fetch = nativeFetch; void rm(temp, { recursive: true, force: true }).finally(() => process.exit()); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
