import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchLocalBrowser } from '../server/local-browser';
import { captureReview } from '../server/review-probe';

// UI transport tests use synthetic model reports. The real probe is checked
// separately below; this does not claim to measure a model's review accuracy.
const tasks = new Map<string, any>();
const reports = new Map<number, any>();
let active = 0, peak = 0, id = 0;
const failOnce = new Set<string>();
const fixture = (title: string) => ({ id: ++id, title, score: 6, created_at: new Date().toISOString(), probe: {}, shots: [], result: { aes: 2, ease: 2, play: 2, verdict: '建议修改', reviewer_comment: '画面表达清楚，挑战节奏还需要一点变化。当前 2/2/2 = 6，建议完善后再次模拟审核。', strengths: ['保留清晰的视觉风格', '交互目标明确'], issues: [{ severity: '高', area: '挑战节奏', problem: '同一动作重复后缺少新的变化，继续挑战的动力不足。', evidence: '源码 update() 中每一轮均使用相同速度，开局 10 秒截图仍是相同挑战。', fix: '保留现有操作，每 15 秒加入一种新障碍，逐步提升速度并设置上限。' }, { severity: '中', area: '视觉反馈', problem: '成功和失败的画面反馈过于相似。', evidence: '成功与失败时都只有同一种颜色闪烁。', fix: '成功使用短促光点，失败使用轮廓提示，区分两种反馈。' }], fix_prompt: '请保留当前游戏的整体画风和已有操作，优先完善以下两点：\n1. 每 15 秒加入新障碍，最高速度不超过初始速度的 1.6 倍。\n2. 区分成功和失败的视觉反馈。\n修改后验证三种手机屏幕比例。' } });
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  try {
    if (url.pathname === '/api/forge/review/probe' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      return json(await captureReview(browser, JSON.parse(body).html));
    }
    if(url.pathname==='/api/forge/review/usage')return json({limit:50,remaining:50-tasks.size,used:tasks.size});
    if (url.pathname === '/api/forge/reviews') return json([...reports.values()]);
    if (/^\/api\/forge\/reviews\/\d+$/.test(url.pathname)) return json(reports.get(Number(url.pathname.split('/').at(-1))));
    if (url.pathname === '/api/forge/review/jobs' && request.method === 'GET') return json([...tasks.values()]);
    if (url.pathname === '/api/forge/review/jobs' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (tasks.has(input.request_id)) return json(tasks.get(input.request_id), 202);
      const job = { id: input.request_id, title: input.title, status: 'running', error: '', result_id: null };
      tasks.set(job.id, job); active++; peak = Math.max(peak, active);
      setTimeout(async () => {
        active--;
        if (input.title === 'Retry me' && !failOnce.has(input.title)) { failOnce.add(input.title); job.status = 'error'; job.error = '合成模型超时，请重试'; }
        else {
          const report:any = fixture(input.title);
          Object.assign(report.result, { score_reasons: { aes: '截图中视觉层级清楚，但反馈区分不足。', ease: '从源码推断触摸规则清楚，实际手感待确认。', play: '源码中挑战重复，长期节奏需要人工试玩确认。' }, uncertainties: ['未实际听音频，请人工确认背景音乐与音效。', '未完成完整试玩，请人工确认手感与长期节奏。'] });
          const evidence=input.title==='real-probe-fixture'?await captureReview(browser,input.html):{probe:{captureMethod:'fixture'},shots:[]};
          report.probe = evidence.probe; report.shots = evidence.shots; reports.set(report.id, report); job.status = 'done'; job.result_id = report.id as any;
        }
      }, 1000);
      return json(job, 202);
    }
    if (url.pathname.startsWith('/api/forge/review/jobs/')) return json(tasks.get(url.pathname.split('/').at(-1)!));
    if (url.pathname === '/real') {
      response.setHeader('Content-Type', 'text/html'); return response.end(await readFile('public/review.html', 'utf8'));
    }
    if (url.pathname === '/test') {
      let html = await readFile('public/review.html', 'utf8');
      html = html.replace('<script type="module" src="/forge/app.js"></script>', `<script type="module">
        import { mountReviewWorkspace } from '/forge/review-workspace.js';
        const api = async (method,path,data) => { const r=await fetch('/api/forge/'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)}); const out=await r.json(); if(!r.ok) throw Error(out.error); return out; };
        window.copied=[]; window.downloaded=[]; window.probeCount=0;
        const probeGame = async (html,box,log) => {
          window.probeCount++; log('采集画面…'); await new Promise(r=>setTimeout(r,30));
          return {probe:{loaded:{},errors:[],layout:{},audio:{}}, shots:[]};
        };
        await mountReviewWorkspace({view:document.querySelector('#view'),api,alive:()=>true,topics:[],probeGame,setProbing:()=>{},checksHtml:()=>'',probeChecks:()=>[],copyText:t=>window.copied.push(t),download:(name,text)=>window.downloaded.push({name,text}),openModal:()=>{}});
        window.ready=true;
      </script>`);
      response.setHeader('Content-Type', 'text/html'); return response.end(html);
    }
    const path = resolve('public', `.${url.pathname}`);
    if (!path.startsWith(resolve('public'))) { response.writeHead(404); return response.end(); }
    const text = await readFile(path);
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'image/png');
    response.end(text);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await launchLocalBrowser();
let debugPage:any;
await mkdir('artifacts', { recursive: true });
try {
  const page = await browser.newPage();debugPage=page;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${origin}/test`);
  await page.waitForFunction('window.ready');
  const accepted = await page.evaluate(() => {
    const transfer = new DataTransfer();
    ['First game', 'Second game', 'Retry me', 'Fourth game'].forEach((title, i) => transfer.items.add(new File([`<title>${title}</title><canvas></canvas>`], `game-${i}.html`, { type: 'text/html' })));
    transfer.items.add(new File(['no'], 'wrong.txt', { type: 'text/plain' }));
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    document.body.dispatchEvent(event); return event.defaultPrevented;
  });
  assert(accepted, 'Dropping files outside the zone must not navigate away');
  await page.waitForFunction('document.querySelectorAll("[data-job]").length === 4');
  assert.match(await page.$eval('#rvFeedback', el => el.textContent!), /wrong.txt/);
  await page.click('#rvGo');
  await page.waitForFunction('document.querySelectorAll(".rv-job-status.done").length === 3 && document.querySelectorAll(".rv-job-status.error").length === 1', { timeout: 20000 });
  assert.equal(peak, 4, 'All uploaded jobs enter the background queue without a browser-side model cap');
  await page.waitForSelector('.pgc-task[data-task-state="error"]');
  assert(await page.$('.pgc-task-toggle[aria-expanded="false"]'),'Review progress stays compact so batch actions remain reachable');
  assert.match(await page.$eval('.pgc-task[data-task-state="error"]', el => el.textContent!), /审核未完成.*重试审核/s);
  assert.equal(await page.$('.pgc-task[data-task-state="error"] [data-progress-since]'), null, 'Failed tasks must stop their elapsed clock');
  await page.click('#rvRetryAll');
  await page.waitForFunction('document.querySelectorAll(".rv-job-status.done").length === 4', { timeout: 12000 });
  assert.equal(await page.evaluate('window.probeCount'), 0, 'All evidence is captured server-side; browser never probes or bypasses quota');
  assert.match(await page.$eval('#rvQuota',el=>el.textContent!),/今日剩余/);
  await page.click('[data-select]');
  assert.match(await page.$eval('.rr-reasons', el => el.textContent!), /为什么是这个分数.*实际手感待确认/s);
  assert.match(await page.$eval('.rr-uncertainties', el => el.textContent!), /未实际听音频/);
  await page.click('[data-copy-fix]');
  assert.match(String(await page.evaluate('window.copied[0]')), /每 15 秒/);
  await page.click('#rvExportAll');
  const exported=await page.evaluate('window.downloaded[0]') as {name:string;text:string};
  assert.match(exported.name,/reviews-.*\.md$/);
  for(const title of ['First game','Second game','Retry me','Fourth game'])assert(exported.text.includes(title));
  await page.select('#rvHistoryFilter','pass');
  assert.equal(await page.$$eval('[data-history]',items=>items.length),0);
  await page.select('#rvHistoryFilter','revise');
  await page.type('#rvHistorySearch','Second');
  assert.equal(await page.$$eval('[data-history]',items=>items.length),1);
  await page.$eval('#rvHistorySearch',el=>{(el as HTMLInputElement).value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.select('#rvHistoryFilter','all');
  await page.click('[data-report-jump=".rr-issues"]');
  await page.waitForFunction('document.querySelector(".rr-issues").getBoundingClientRect().top < innerHeight');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/review-desktop.png', fullPage: true });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.waitForFunction('window.ready && document.querySelector("[data-history]")');
  await page.click('[data-history]');
  await page.waitForSelector('.review-report');
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; scrollTo(0, 0); });
  await page.screenshot({ path: 'artifacts/review-mobile.png', fullPage: true });
  assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Mobile layout must not overflow');
  assert.deepEqual(errors, []);
  console.log('PASS 页面任意位置拖入多文件、无效格式提示、后台并发、逐项失败重试、后台采集、复制修改指令、手机布局。');

  const recoveryId = crypto.randomUUID();
  tasks.set(recoveryId, { id: recoveryId, title: 'Recovered failure', status: 'error', error: '模型接口返回 409。请在管理页检查模型配置、额度和图片输入支持。', result_id: null, created_at: new Date(Date.now() - 900000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString() });
  const recovery = await browser.newPage();
  await recovery.setViewport({ width: 1440, height: 1000 });
  await recovery.goto(`${origin}/test`); await recovery.waitForFunction('window.ready');
  const recoveredTask = `.pgc-task[data-task-key="review-${recoveryId}"][data-task-state="error"]`;
  await recovery.waitForSelector(recoveredTask);
  assert.match(await recovery.$eval(recoveredTask, el => el.textContent!), /请求冲突（409）.*重新上传重试/s);
  assert.doesNotMatch(await recovery.$eval(recoveredTask, el => el.textContent!), /AI 评分中|检查模型配置/);
  await recovery.click('.pgc-task-toggle[aria-expanded="false"]');
  const chooser = recovery.waitForFileChooser();
  await recovery.click(`${recoveredTask} button`);
  await (await chooser).cancel();
  assert.match(await recovery.$eval('#rvFeedback', el => el.textContent!), /重新选择原始 HTML/);
  await recovery.screenshot({ path: 'artifacts/review-retry.png', fullPage: true });
  await recovery.click('.pgc-task-toggle[aria-expanded="true"]');
  await recovery.click('#rvClear');
  assert.equal(await recovery.$('.pgc-task[data-task-state="error"]'), null, 'Clearing failed jobs also clears stale tray entries');
  await recovery.close(); tasks.delete(recoveryId);
  console.log('PASS 失败任务面板直接重试、刷新后恢复失败记录、旧409提示纠正、重新上传选择器、清理残留任务。');

  const upload = await browser.newPage();
  await upload.goto(`${origin}/test`); await upload.waitForFunction('window.ready');
  await upload.evaluate(() => {
    const transfer = new DataTransfer();
    for (let i = 0; i < 22; i++) transfer.items.add(new File([`<title>Batch ${i}</title>`], `batch-${i}.html`, { type: 'text/html' }));
    const input = document.querySelector<HTMLInputElement>('#rvFile')!; input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await upload.waitForFunction('document.querySelectorAll(".rv-job-status.staged").length === 20');
  assert.match(await upload.$eval('#rvFeedback', el => el.textContent!), /最多 20/);
  assert.equal(await upload.$eval('#rvFile', el => (el as HTMLInputElement).multiple), true);
  await upload.evaluate(() => { document.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.click()); });
  await upload.close();
  console.log('PASS 文件选择器可多选，每批上限 20 个，待开始文件可单独移除。');

  const real = await browser.newPage();
  const runtimeErrors: string[] = [];
  real.on('pageerror', error => runtimeErrors.push(String(error)));
  await real.setViewport({ width: 1440, height: 1000 });
  await real.goto(`${origin}/real`); await real.waitForSelector('#rvFile');
  await real.evaluate(() => {
    const html = '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;overflow:hidden}canvas{display:block}</style><canvas id="game"></canvas><script>const c=document.querySelector("canvas");c.width=innerWidth;c.height=innerHeight;const ctx=c.getContext("2d");function draw(){ctx.fillStyle="#edf3e6";ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle="#607e58";ctx.beginPath();ctx.arc(c.width/2,c.height/2,50,0,7);ctx.fill();requestAnimationFrame(draw)}draw();</script></html>';
    const transfer = new DataTransfer(); transfer.items.add(new File([html], 'real-probe-fixture.html', { type: 'text/html' }));
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await real.waitForSelector('[data-job]'); await real.click('#rvGo');
  await real.waitForFunction('document.querySelector(".review-report")', { timeout: 90000 });
  const latest = [...reports.values()].find(report => report.title === 'real-probe-fixture');
  assert(latest); assert.equal(latest.shots.length, 4); assert(latest.shots.every((shot: any) => shot.data.startsWith('data:image/')));
  assert.equal(Object.keys(latest.probe.loaded).length, 3);
  assert.equal(await real.$$eval('#rvPhones iframe', elements => elements.length), 0, 'Game frames must be disposed after capture');
  await real.evaluate(() => scrollTo(0, 0));
  await real.screenshot({ path: 'artifacts/review-real-probe.png', fullPage: true });
  assert.deepEqual(runtimeErrors, []);
  assert.equal(latest.probe.captureMethod, 'browser-viewport-v1');
  console.log('PASS 真实上传入口 + 三种比例独立浏览器页面 + 4 张完整视口截图 + 后台报告。');
} catch(error) { console.log(await debugPage.evaluate('({feedback:document.querySelector("#rvFeedback")?.textContent,statuses:[...document.querySelectorAll(".rv-job-status")].map(e=>e.textContent)})'));await debugPage.screenshot({path:'artifacts/review-verification-failure.png',fullPage:true});throw error;
} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
