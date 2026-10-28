import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { launchLocalBrowser } from '../server/local-browser';
import type { AdminProject, AdminTask } from '../src/admin/contracts';

// Synthetic browser checks for the admin content module. No model or live API.
const project: AdminProject = { id: 41, type: 'topic', ownerId: 'm1', ownerName: '林小满', title: 'Pocket Bloom · 口袋花园', subject: '花园与节奏', summary: '用轻触让种子萌芽，在有限空间里组合一座不断生长的口袋花园。', status: 'product', statusLabel: '已有成品', updatedAt: '2026-10-28T08:30:00Z', createdAt: '2026-10-27T08:30:00Z', materials: { expand: true, game: true, brief: true, preview: true, assets: true }, thumbnailUrl: '/api/admin/projects/topic/41/material/preview/thumbnail', activeTasks: 1, failedTasks: 0 };
const task: AdminTask = { id: 'task-platform-41', type: 'creation', kind: 'game', kindLabel: '游戏制作', ownerId: 'm1', ownerName: '林小满', projectId: 41, projectType: 'topic', title: project.title, executor: 'platform', status: 'running', statusLabel: '制作中', detail: '正在生成游戏，已接收 8,320 字符', error: '', createdAt: project.createdAt!, updatedAt: project.updatedAt, startedAt: project.createdAt, canRetry: false, retryReason: '' };
const agent = { ...task, id: 'task-agent-42', title: 'Moon Post · 月光邮局', executor: 'agent', status: 'pending', statusLabel: '等待 Agent', detail: '等待原成员 Agent 继续' };
const failed = { ...task, id: 'task-failed-43', title: 'Rain Radio · 雨天电台', status: 'error', statusLabel: '失败', error: 'model timeout: request deadline exceeded', detail: '任务已停止', canRetry: true, retryReason: '沿用原始输入创建一次新任务。' };
const versions = [{ id: 'immutable-old-41', kind: 'game', created_at: '2026-10-27T08:30:00Z', executor: 'platform', model: 'test-model', current: false, disposition: 'accepted' }, { id: 'immutable-new-41', kind: 'game', created_at: project.updatedAt, executor: 'platform', current: true, disposition: 'accepted' }];
const members = [{ id: 'm1', displayName: '林小满', username: 'lin', enabled: true, star: true }];
const requests: string[] = [];
const temp = path.join(os.tmpdir(), `pgc-admin-content-${Date.now()}`);
await mkdir(temp, { recursive: true });
const artifacts = path.resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const entry = `import {mountContent} from './src/admin/content';
let controller=new AbortController(),cleanup,version=0;
window.__route={view:'works',owner:'',q:'',status:'all',type:'all',range:'all',page:1};
window.__mount=async changes=>{const own=++version;controller.abort();cleanup?.();controller=new AbortController();window.__route={...window.__route,...changes};
const result=await mountContent({root:document.querySelector('main'),route:{...window.__route},signal:controller.signal,
api:async(path,method='GET',body)=>{const response=await fetch('/api/admin/'+path,{method,body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;},
navigate:changes=>{window.__mount(changes);},setRefresh:callback=>{window.__refresh=callback;},notice:message=>{window.__notice=message;}});if(own===version)cleanup=result;else result?.();};
await window.__mount({});`;
await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'admin-content-harness.ts' }, bundle: true, format: 'esm', platform: 'browser', outfile: path.join(temp, 'bundle.js'), logLevel: 'silent' });
const demoGame = (label: string) => `<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:#eaf0da;color:#617c4b;text-align:center;display:grid;place-items:center;height:100vh;font:16px system-ui"><div><p>${label}</p><button onclick="this.textContent='已点击'">点一下</button></div></body></html>`;
let failLists = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  const send = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith('/api/')) requests.push(`${req.method} ${url.pathname}${url.search}`);
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><style>*{box-sizing:border-box}body{font:13px/1.5 system-ui;background:#fbfcf8;color:#506046;margin:0}main{max-width:1130px;margin:auto;padding:35px 35px 70px}.adm-eyebrow{font-size:9px;color:#a0ad8e;letter-spacing:1.5px}.adm-button{border:1px solid #dfe6d7;border-radius:5px;padding:7px 11px;background:white;color:#748967;cursor:pointer;font:inherit;font-size:11px;text-decoration:none}.adm-button.primary{background:#7d976b;color:white}.adm-button.quiet{background:transparent}.adm-button:disabled{opacity:.45;cursor:default}@media(max-width:600px){main{padding:22px 17px}}</style><main></main><script type="module" src="/bundle.js"></script></html>`); return; }
  if (url.pathname === '/bundle.js' || url.pathname === '/bundle.css') { res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript'); res.end(await readFile(path.join(temp, url.pathname.slice(1)))); return; }
  if (url.pathname.startsWith('/forge/')) { res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript'); res.end(await readFile(path.resolve('public', url.pathname.slice(1)))); return; }
  if (url.pathname === '/api/admin/projects') { if (failLists) { send({ error: '模拟断线' }, 503); return; } send({ items: Array.from({ length: 8 }, (_, i) => ({ ...project, id: 41 + i, title: [project.title, 'Moon Post · 月光邮局', 'Rain Radio · 雨天电台', 'Paper Orbit · 纸上轨道'][i % 4], activeTasks: i ? 0 : 1, materials: { ...project.materials, game: i % 3 !== 2 }, statusLabel: i % 3 !== 2 ? '已有成品' : '待制作' })), total: 32, page: 1, pageSize: 24, members, activeCount: 1, waitingAgentCount: 0, updatedAt: project.updatedAt }); return; }
  if (url.pathname === '/api/admin/projects/topic/41') { send({ project, overview: { title: project.title, logline: project.summary, core_loop: '播种 → 收集光点 → 组合花朵 → 解锁新的小空间', controls: '轻触或拖动', art_direction: '柔和水彩、暖白底色与鼠尾草绿', requirements: '保持 9:16 竖屏；首屏立即可玩。', injected: '<img onerror="alert(1)">' }, versions, relatedReviews: [{ id: 81, title: 'Pocket Bloom 初评', score: 8, createdAt: project.updatedAt }] }); return; }
  const material = url.pathname.match(/^\/api\/admin\/projects\/topic\/41\/material\/(\w+)(?:\/(\w+))?$/);
  if (material) {
    const [, kind, action] = material;
    if (action === 'thumbnail') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="340"><rect width="600" height="340" fill="#edf1e2"/><circle cx="300" cy="180" r="60" fill="#d3dfba"/><path d="M300 235V125m0 45-30-25m30 55 35-30" fill="none" stroke="#90a576" stroke-width="8"/><circle cx="300" cy="120" r="24" fill="#e0cda5"/></svg>'); return; }
    if (action === 'preview') { res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"); res.end(demoGame(url.searchParams.get('version') === 'immutable-old-41' ? 'IMMUTABLE OLD VERSION' : 'CURRENT VERSION')); return; }
    const version = url.searchParams.get('version') || 'immutable-new-41', base = `/api/admin/projects/topic/41/material/${kind}`, suffix = url.searchParams.has('version') ? `?version=${version}` : '';
    send({ kind, available: true, versionId: version, previewUrl: `${base}/preview${suffix}`, downloadUrl: `${base}/file${suffix}`, ...(['brief', 'expand'].includes(kind) || url.searchParams.get('raw') === '1' ? { content: kind === 'brief' ? '# F. 本款设计\n\n## F1 玩法\n轻触种子，开始生长。\n\n<script>window.__unsafe=1</script>' : kind === 'expand' ? JSON.stringify({ title: project.title, core_loop: '点击种子，收集光点', controls: '单指轻触' }) : '<!doctype html><p>RAW SOURCE</p>' } : {}) }); return;
  }
  if (url.pathname === '/api/admin/tasks') { if (failLists) { send({ error: '模拟断线' }, 503); return; } send({ items: [task, agent, failed], total: 3, page: 1, pageSize: 25, members, activeCount: 1, waitingAgentCount: 1, updatedAt: project.updatedAt }); return; }
  const taskId = url.pathname.match(/^\/api\/admin\/tasks\/creation\/([^/]+)(\/retry)?$/);
  if (taskId) { if (taskId[2]) { send({ task: { ...task, id: 'retry-new-44' } }); return; } const selected = taskId[1] === failed.id ? failed : taskId[1] === agent.id ? agent : task; send({ task: selected, retryTaskId: null, sourceAvailable: true, continuePrompt: selected.executor === 'agent' ? `请继续原创作任务 ${selected.id}，不要新建任务。` : null }); return; }
  res.writeHead(404); res.end('not found');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw Error('server address');
const browser = await launchLocalBrowser();
const checks: string[] = [];
try {
  const page = await browser.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1320, height: 1000 });
  await page.goto(`http://127.0.0.1:${address.port}/`); await page.waitForSelector('.content-project-card');
  assert.equal(await page.$$eval('iframe', nodes => nodes.length), 0); assert(!requests.some(r => /\/material\/(game|assets|brief|expand)(?:[? ]|$)/.test(r))); checks.push('作品列表仅获取摘要与缩略图，不加载材料或 iframe');
  await page.screenshot({ path: path.join(artifacts, 'admin-content-works-desktop.png'), fullPage: true });
  await page.focus('[name=q]'); await page.type('[name=q]', '未提交的搜索'); await page.evaluate(() => (window as any).__refresh());
  assert.equal(await page.$eval('[name=q]', node => (node as HTMLInputElement).value), '未提交的搜索'); assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'q'); checks.push('轮询保留搜索输入与焦点');
  failLists = true; await page.evaluate(() => (window as any).__refresh()); assert.equal(await page.$$eval('.content-project-card', nodes => nodes.length), 8); assert(await page.$eval('[data-refresh-error]', node => !node.hasAttribute('hidden'))); failLists = false; checks.push('请求失败保留上次列表并标记过期状态');
  await page.evaluate(() => (window as any).__mount({ view: 'works', id: '41', type: 'topic', q: '', panel: 'game' })); await page.waitForSelector('.game-player iframe');
  assert.equal(await page.$eval('iframe', node => node.getAttribute('sandbox')), 'allow-scripts'); assert.equal(await page.$eval('iframe', node => node.getAttribute('referrerpolicy')), 'no-referrer');
  const box = await page.$eval('.game-player-stage', node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height }; }); assert(Math.abs(box.width / box.height - 9 / 16) < .002); checks.push('游戏使用共享播放器、9:16 舞台与无同源权限 sandbox');
  await page.screenshot({ path: path.join(artifacts, 'admin-content-game-desktop.png'), fullPage: true });
  assert(!requests.some(r => r.includes('raw=1'))); await page.click('.content-source summary'); await page.waitForSelector('.content-source pre'); assert(requests.some(r => r.includes('raw=1'))); checks.push('HTML 源码仅在主动展开时读取');
  await page.click('[data-panel=history]'); await page.waitForSelector('[data-version="immutable-old-41"]'); assert.equal(await page.$$eval('iframe', nodes => nodes.length), 0); await page.click('[data-version="immutable-old-41"]'); await page.waitForSelector('iframe'); assert((await page.$eval('iframe', node => node.getAttribute('src')))!.includes('version=immutable-old-41')); checks.push('切换移除 iframe；历史预览固定不可变版本编号');
  await page.click('[data-panel=brief]'); await page.waitForSelector('.brief-document'); assert.equal(await page.$$eval('iframe', nodes => nodes.length), 0); assert.equal(await page.evaluate(() => (window as any).__unsafe), undefined); checks.push('简报转义 HTML，不执行文档脚本');
  await page.evaluate(() => (window as any).__mount({ view: 'tasks', id: undefined, type: 'all', panel: undefined, version: undefined })); await page.waitForSelector('.content-task-row'); assert((await page.$eval('[data-task-counts]', node => node.textContent))!.includes('1 平台执行中')); assert((await page.$eval('[data-task-counts]', node => node.textContent))!.includes('1 等待 Agent')); checks.push('平台执行与等待 Agent 数量独立显示');
  await page.setViewport({ width: 390, height: 844 }); await page.screenshot({ path: path.join(artifacts, 'admin-content-tasks-mobile.png'), fullPage: true }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.click('[data-task-id="task-failed-43"]'); await page.waitForSelector('[data-show-retry]'); assert(!requests.some(r => r.startsWith('POST '))); await page.click('[data-show-retry]'); assert(!requests.some(r => r.startsWith('POST '))); await page.click('[data-cancel-retry]'); assert(!requests.some(r => r.startsWith('POST '))); await page.click('[data-show-retry]'); await page.click('[data-confirm-retry]'); await page.waitForFunction(() => (window as any).__route.id === 'retry-new-44'); assert.equal(requests.filter(r => r.startsWith('POST ')).length, 1); checks.push('重试需内联确认，取消零请求，确认仅创建一次新任务');
  await page.evaluate(() => (window as any).__mount({ view: 'tasks', id: 'task-agent-42', type: 'creation' })); await page.waitForSelector('[data-copy-prompt]'); assert.equal(await page.$$eval('[data-show-retry]', nodes => nodes.length), 0); checks.push('Agent 任务显示原编号继续指令，不提供平台重试');
  await page.evaluate(() => (window as any).__mount({ view: 'works', id: '41', type: 'topic', panel: 'overview' })); await page.waitForSelector('.content-design'); await page.screenshot({ path: path.join(artifacts, 'admin-content-overview-mobile.png'), fullPage: true }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); checks.push('手机任务与作品详情无横向溢出');
  assert.deepEqual(errors, []); checks.push('浏览器无页面脚本错误');
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { await browser.close(); server.close(); await rm(temp, { recursive: true, force: true }); }
