import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { launchLocalBrowser } from '../server/local-browser';

const game = (version: number) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#eff4e9}button{width:100%;height:50vh}</style></head><body><button id="play" onclick="this.textContent='Played ${version}'">Game ${version}</button><script>window.version=${version}</script></body></html>`;
const asset = '<!doctype html><html><body style="background:#f8ead9"><h1 id="asset">Paper Garden assets</h1></body></html>';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" fill="#789575"/></svg>';
const brief = '# 通用模板\n## A. 固定要求\n平台通用规则\n\n## F. 本款游戏设计\n### F1. 一句话\n**纸间花园**：收集随风飘落的花瓣。';

function makeTopic(id: number, hasProduct: boolean) {
  return {
    id, status: 'made', subject: '纸间花园', medium: '剪纸', gesture: '拖动', structure: '收集', mood: '安静',
    data: { title: id === 1 ? 'Paper Garden' : 'Paper Garden Two', logline: 'Catch petals in a tiny paper world.', core_loop: 'Catch falling petals', controls: 'Drag to move', twist: 'Collect petals without touching dark seeds', palette: ['#eef1df', '#789575', '#d5ac71'] },
    score: 8, note: '', has_preview: 1, has_brief: 1, has_assets: 1, has_product: Number(hasProduct),
    brief_md: brief, assets_html: asset, preview_svg: svg, brief_status: '', assets_status: '', product_status: '',
    updated_at: '2026-10-28T04:00:00Z',
  } as any;
}

const topics = new Map([[1, makeTopic(1, true)], [2, makeTopic(2, false)]]);
const products = new Map([[1, game(1)]]);
const posts: Array<{ kind: string; id: number; regenerate: string | null }> = [];
const jobs: any[] = [];
const workflowRequests: Array<{route:string;query:URLSearchParams;body:any}>=[];
const cards=Array.from({length:8},(_,index)=>({
  title:`Mechanism ${index+1}`,logline:'Follow the paper signal.',strength:'The clue and gesture use the same rhythm.',
  subject:'纸信号',action:'Tap twice to match the pulse',rule:`Match the cue number ${index+1}`,structure:'节奏试炼',
  risks:'Fast cues may need a longer warning.',
}));
const fixtureCheck={check_id:'check-fixture',state:'uncertain',effective_state:'distinct',stale:false,candidate:cards[0],admin_resolution:{reason:'已核对规则差异'}};
const fixtureEvidence={
  shots:Array.from({length:4},(_,i)=>({id:`build:baseline-${i+1}`,label:`原始画面 ${i+1}`,data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVQImWNgAAAAAgABSK+kcQAAAABJRU5ErkJggg=='})),
  probe:{captureMethod:'browser-viewport-v1'},
};
let v2Available=true;
const versions = new Map<number, any[]>([[1, [
  { id: 'game-1', kind: 'game', content: game(1), current: false, disposition: 'historical' },
  { id: 'brief-1', kind: 'brief', content: brief, current: true, disposition: 'current' },
  { id: 'asset-1', kind: 'assets', content: asset, current: true, disposition: 'current' },
]], [2, []]]);
let sequence = 0;
let restored = 0;
let delayNextTopicRead = 0;

function finish(kind: string, topicId: number, outcome: 'done' | 'error' = 'done') {
  const job = [...jobs].reverse().find(item => item.kind === kind && item.topicId === topicId);
  assert(job, `Expected a ${kind} task for topic ${topicId}`);
  if (outcome === 'error') {
    job.status = 'error'; job.error = '合成失败：测试旧成品保留';
    if (kind === 'game') { topics.get(topicId)!.product_status = 'error'; topics.get(topicId)!.product_error = job.error; }
    return;
  }
  const content = kind === 'game' ? game(2) : kind === 'brief' ? brief.replace('纸间花园', '全新花园') + '\n### F2. 新美术\n透明纸片与金色花蕊。' : svg;
  const kindVersions = versions.get(topicId)!;
  kindVersions.filter(item => item.kind === kind).forEach(item => { item.current = false; item.disposition = 'historical'; });
  const version = { id: `${kind}-${job.id}`, kind, content, current: true, disposition: 'current' };
  kindVersions.unshift(version);
  job.status = 'done'; job.result = { id: topicId, version_id: version.id, disposition: 'current' };
  const topic = topics.get(topicId)!;
  if (kind === 'game') { products.set(topicId, content); topic.has_product = 1; topic.product_status = ''; }
  if (kind === 'brief') { topic.brief_md = content; topic.brief_status = ''; }
  if (kind === 'preview') { topic.preview_svg = content; topic.preview_status = ''; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  const parts = url.pathname.split('/');
  const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const preview = (content: string) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'" }); res.end(content); };
  const requestBody=async()=>{let text='';for await(const chunk of req)text+=chunk;return JSON.parse(text);};
  try {
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/api/auth/me') return json({ id: 'fixture-star', role: 'member', star: true, canReview: true, displayName: '交互验证' });
    if (url.pathname === '/api/forge/state') return json({ games: 2, vocab: 5, creative_v2_available:v2Available });
    if (url.pathname === '/api/forge/settings') return json({ draw_size: 2 });
    if (url.pathname === '/api/forge/vocab') return json([{dim:'subject',word:'曾使用的题材',enabled:true,used:true}]);
    if (url.pathname === '/api/forge/topics' || url.pathname === '/api/forge/products') return json([...topics.values()].filter(topic=>{
      const status=url.searchParams.get('status');
      return !status||status.split(',').includes(topic.status);
    }));
    if(req.method==='POST'&&['draw','expand','mechanisms/check','mechanisms/choose'].some(route=>url.pathname===`/api/forge/${route}`)){
      const route=url.pathname.slice('/api/forge/'.length),body=await requestBody();
      workflowRequests.push({route,query:url.searchParams,body});
      if(route==='draw'){
        const seed={...makeTopic(3,false),status:'drawn',data:{},creative_version:2};
        topics.set(3,seed);versions.set(3,[]);return json([seed]);
      }
      if(route==='expand'){
        const seed=topics.get(3)!;
        seed.data={candidates:cards,recommended:[0,1,2]};
        return json({pending:true,topics:[seed]});
      }
      if(route==='mechanisms/check'){
        jobs.push({id:'mechanism-fixture',kind:'mechanism-check',scope:'fixture:mechanism-check:3:0',executor:'agent',status:'done',result:fixtureCheck});
        return json({pending:true,jobId:'mechanism-fixture',executor:'agent'});
      }
      const chosen={...makeTopic(4,false),status:'liked',creative_version:2,has_brief:0,data:cards[0],score:null};
      topics.set(4,chosen);return json({topic_id:4});
    }
    if(url.pathname==='/api/forge/mechanisms/check-fixture')return json(fixtureCheck);
    if (url.pathname === '/api/forge/generation-jobs') return json([...jobs].reverse().map(({ topicId: _topicId, ...job }) => job));
    if (url.pathname.startsWith('/api/forge/generation-jobs/')) return json(jobs.find(job => job.id === parts[4]));

    const topicMatch = url.pathname.match(/^\/api\/forge\/topics\/(\d+)(?:\/(.*))?$/);
    if (topicMatch) {
      const id = Number(topicMatch[1]), tail = topicMatch[2] || '', topic = topics.get(id);
      if (!topic) return json({ error: 'missing topic' }, 404);
      if (tail === '' && req.method === 'PATCH') {
        let body = ''; for await (const chunk of req) body += chunk;
        topic.note = JSON.parse(body).note; await new Promise(resolve => setTimeout(resolve, 30)); return json(topic);
      }
      if (tail === '') {
        if (delayNextTopicRead) { const delay = delayNextTopicRead; delayNextTopicRead = 0; await new Promise(resolve => setTimeout(resolve, delay)); }
        return json(topic);
      }
      if (tail === 'versions' && req.method === 'GET') return json((versions.get(id) || []).map(({ content: _content, ...version }) => version));
      if(tail==='creation-checks'&&id===1)return json([{stage:'build',task_id:'creation-fixture',version_id:'version-fixture',
        content_hash:'content-fixture',evidence_hash:'evidence-fixture',self_check:{model:'fixture model',selfCheck:{findings:[],unverified:['未试听']}}}]);
      if(tail==='creation-checks/creation-fixture/build'&&id===1)return json(fixtureEvidence);
      const versionMatch = tail.match(/^versions\/([^/]+)(?:\/(preview))?$/);
      if (versionMatch) {
        const version = (versions.get(id) || []).find(item => item.id === versionMatch[1]);
        if (!version) return json({ error: 'missing version' }, 404);
        return versionMatch[2] ? preview(version.content) : json(version);
      }
      if (tail === 'restore' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const version = (versions.get(id) || []).find(item => item.id === JSON.parse(body).version_id);
        assert(version); products.set(id, version.content); topic.has_product = 1; restored++;
        return json({ ok: true });
      }
      if (tail === 'product') return json({ html: products.get(id) || '' });
      if (tail === 'product-preview') return preview(products.get(id) || '');
      if (tail === 'assets-preview') return preview(topic.assets_html);
      if (tail === 'game' && req.method === 'GET') return json({ has_product: topic.has_product, product_status: topic.product_status, product_error: topic.product_error });
      const kind = tail.match(/^(game|brief|preview|assets)$/)?.[1];
      if (kind && req.method === 'POST') {
        const regenerate = url.searchParams.get('regenerate');
        assert.equal(url.searchParams.get('creative_version'),'2');
        if (topic.has_product && kind === 'game') assert.equal(regenerate, '1', 'Regenerating an existing game must create a new version');
        posts.push({ kind, id, regenerate });
        const idForJob = `job-${++sequence}`;
        const job = { id: idForJob, topicId: id, kind, status: 'running', detail: '模型正在生成新版本…', scope: `fixture:${kind === 'game' ? 'game' : kind}: ${id}`, created_at: new Date().toISOString() };
        // Match the production scope suffix expected by the UI.
        job.scope = `fixture:${kind}:${id}`;
        jobs.push(job);
        if (kind === 'game') topic.product_status = 'running';
        if (kind === 'brief') topic.brief_status = 'running';
        if (kind === 'preview') topic.preview_status = 'running';
        if (kind === 'assets') topic.assets_status = 'running';
        return json({ pending: true, jobId: idForJob });
      }
    }

    const publicRoot = resolve('public');
    const file = resolve(publicRoot, '.' + (['/test','/forge/'].includes(url.pathname) ? '/forge/index.html' : url.pathname));
    if (!file.startsWith(publicRoot + sep)) throw new Error('path');
    const bytes = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream');
    res.end(bytes);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (error as Error).message }));
  }
});

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await launchLocalBrowser();
await mkdir('artifacts', { recursive: true });

async function waitForPost(kind: string, id: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (posts.some(post => post.kind === kind && post.id === id)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`No ${kind} request was sent for topic ${id}`);
}

async function checkPlayer(page: any, selector: string, expected: string) {
  const iframe = await page.waitForSelector(selector, { visible: true });
  const box = await iframe.boundingBox(); assert(box);
  assert(Math.abs(box.width / box.height - 9 / 16) < 0.003, 'Game player must retain its 9:16 ratio');
  const frame = await iframe.contentFrame(); assert(frame);
  await frame.waitForSelector('#play'); await frame.click('#play');
  assert.equal(await frame.$eval('#play', (element: any) => element.textContent), `Played ${expected}`);
  assert.equal(await frame.evaluate('typeof parent.document').catch(() => 'blocked'), 'blocked', 'Game must stay origin-isolated');
  assert.equal(await iframe.evaluate((element: any) => element.getAttribute('sandbox')), 'allow-scripts');
  return iframe;
}

try {
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('response', response => { if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  await page.setViewport({ width: 1360, height: 980 });
  const firstCard = '[data-id="1"]';
  const openProducts=()=>page.$eval('#view [data-tab=products]',button=>(button as HTMLButtonElement).click());
  const v2Only=process.argv.includes('--v2-only');
  if(!v2Only){
  await page.goto(origin + '/test?tab=draw&layout=cards'); await page.waitForSelector('#drawBtn');
  await page.click('[data-tab=picks]'); await page.waitForSelector('.creation-card');
  assert.equal(await page.$$eval('.creation-card', cards => cards.length), 2);
  assert.equal(await page.$$eval('.creation-main-actions .primary', buttons => buttons.length), 2);
  assert.equal(await page.$$eval('.creation-materials .material-link', buttons => buttons.length), 6);
  assert.equal(await page.$$eval('.creation-note-fold:not([open])', notes => notes.length), 2, 'Optional production notes should stay collapsed until requested');
  await page.screenshot({ path: 'artifacts/creation-cards-desktop.png', fullPage: true });

  // Reading a material should expand inside its card, without a blocking dialog.
  await page.click(`${firstCard} [data-act=brief]`); await page.waitForSelector(`${firstCard} .brief-document`);
  assert.match(await page.$eval(`${firstCard} .brief-document`, (element: any) => element.textContent), /纸间花园/);
  assert.equal(await page.$eval('#modal', (element: any) => element.hidden), true, 'Viewing material must not open a modal');
  assert.equal(await page.$eval(`${firstCard} .brief-contract`, (element: any) => element.open), false);
  await page.screenshot({ path: 'artifacts/creation-brief-readable.png', fullPage: true });

  // Starting another version shows progress in the owning card and creates one job.
  await page.click(`${firstCard} [data-viewer-act=regenerate]`); await waitForPost('brief', 1);
  assert.equal(posts.filter(post => post.kind === 'brief' && post.id === 1).length, 1);
  assert.equal(await page.$eval('#modal', (element: any) => element.hidden), true);
  assert(await page.$(`${firstCard} .creation-job-progress`), 'Progress should remain beside the card being changed');
  assert.equal(await page.evaluate(() => { const tray = document.querySelector('.pgc-task-tray'); return !tray || getComputedStyle(tray).display === 'none'; }), true, 'The task tray should stay visually hidden in the creator workspace');
  assert.equal(await page.$eval('#toast', (element: any) => (element as HTMLDivElement).hidden), true, 'Creator actions should not surface a floating toast');
  finish('brief', 1);
  await page.waitForFunction(() => document.querySelector('[data-id="1"] .brief-document')?.textContent?.includes('全新花园'));
  assert.equal(await page.$eval('#modal', (element: any) => element.hidden), true);

  // Preview, assets and game run in the card; closing the viewer removes frames.
  await page.click(`${firstCard} [data-act=preview]`); await page.waitForSelector(`${firstCard} .creation-viewer img.preview`);
  assert((await page.$eval(`${firstCard} img.preview`, (element: any) => element.getAttribute('src')))?.startsWith('data:image/svg+xml'));
  await page.click(`${firstCard} [data-viewer-act=close]`); assert.equal(await page.$(`${firstCard} .creation-viewer`), null);
  await page.click(`${firstCard} [data-act=assets]`); const assetFrame = await page.waitForSelector(`${firstCard} iframe.assets-frame`);
  const assetContent = await assetFrame!.contentFrame(); await assetContent!.waitForSelector('#asset');
  await page.click(`${firstCard} [data-viewer-act=close]`); assert.equal(await page.$(`${firstCard} iframe.assets-frame`), null, 'Closing the viewer should unload its iframe');

  // Historical game version is playable, isolated, and restorable without a model request.
  await page.click(`${firstCard} [data-act=versions]`); await page.waitForSelector(`${firstCard} [data-viewer-version=game-1]`);
  await page.click(`${firstCard} [data-viewer-version=game-1]`);
  await checkPlayer(page, `${firstCard} iframe.product-frame`, '1');
  await page.screenshot({ path: 'artifacts/creation-history-playable.png', fullPage: true });
  assert.equal(await page.$eval('#modal', (element: any) => element.hidden), true);
  await page.click(`${firstCard} [data-viewer-act=close]`); assert.equal(await page.$(`${firstCard} iframe.product-frame`), null);
  await page.click(`${firstCard} [data-act=versions]`); await page.waitForSelector(`${firstCard} [data-viewer-version=game-1]`);
  await page.click(`${firstCard} [data-viewer-version=game-1]`); await page.waitForSelector(`${firstCard} [data-viewer-act=restore]:not(:disabled)`);
  const beforeRestore = posts.length;
  await page.click(`${firstCard} [data-viewer-act=restore]`); await page.waitForSelector('#pickCards'); await page.waitForFunction(() => (document.querySelector('#modal') as HTMLDivElement | null)?.hidden);
  assert.equal(restored, 1); assert.equal(posts.length, beforeRestore, 'Restoring a version must not call a model');

  // A failed remake leaves the previous build available to play.
  await page.goto(origin+'/forge/?tab=products&layout=cards'); await page.waitForSelector('#productCards [data-id="1"] [data-act=viewProduct]');
  await page.click('[data-id="1"] .creation-more summary'); await page.click('[data-id="1"] [data-act=regenerateGame]');
  await waitForPost('game', 1); finish('game', 1, 'error');
  await page.waitForFunction(() => document.querySelector('[data-id="1"] .bad.small')?.textContent?.includes('合成失败'));
  await page.click('[data-id="1"] [data-act=viewProduct]');
  await checkPlayer(page, '[data-id="1"] iframe.product-frame', '1');
  await page.click('[data-id="1"] [data-viewer-act=close]');

  // Start a first game, reload while it is running, and ensure recovery never submits a duplicate.
  await page.click('[data-tab=picks]'); await page.waitForSelector('[data-id="2"] [data-act=makeGame]');
  await page.click('[data-id="2"] [data-act=makeGame]'); await waitForPost('game', 2);
  assert.equal(posts.filter(post => post.kind === 'game' && post.id === 2).length, 1);
  await page.reload(); await page.waitForSelector('#pickCards'); await openProducts();
  await page.waitForSelector('[data-id="2"] .product-job-progress');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(posts.filter(post => post.kind === 'game' && post.id === 2).length, 1, 'Reload recovery must not resubmit a running game');
  finish('game', 2);
  await page.waitForSelector('[data-id="2"] [data-act=viewProduct]');
  await page.click('[data-id="2"] [data-act=viewProduct]'); await checkPlayer(page, '[data-id="2"] iframe.product-frame', '2');
  await page.click('[data-id="2"] [data-viewer-act=close]');

  // Late material reads must not open an old card after switching sections.
  delayNextTopicRead = 350;
  await page.click('[data-tab=picks]'); await page.waitForSelector('[data-id="1"] [data-act=brief]');
  await page.click('[data-id="1"] [data-act=brief]'); await openProducts();
  await page.waitForSelector('[data-id="1"] [data-act=viewProduct]'); await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(await page.$('.creation-viewer'), null, 'A late reply must not reopen a viewer in another section');

  // Touch-sized controls and no horizontal overflow at common phone dimensions.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.click('[data-tab=picks]'); await page.waitForSelector('.creation-card');
  assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
  await page.screenshot({ path: 'artifacts/creation-cards-mobile.png', fullPage: true });
  const touchHeight = await page.$eval('.creation-materials .material-link', (element: any) => element.getBoundingClientRect().height);
  assert(touchHeight >= 36, 'Material buttons should remain comfortable to tap');
  }

  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.goto(origin+'/forge/?tab=picks&layout=cards');
  await page.waitForSelector(`${firstCard} [data-act=creationChecks]`);
  await page.click(`${firstCard} [data-act=creationChecks]`);
  await page.waitForFunction(()=>document.querySelector('[data-viewer-kind=creationChecks]')?.textContent?.includes('未试听'));
  await page.click('[data-viewer-act=creation-evidence]');
  await page.waitForFunction(()=>document.querySelectorAll('[data-viewer-kind=creationChecks] figure img').length===4);
  assert(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
  await page.click('[data-viewer-act=creation-checks-back]');
  assert(await page.$('[data-viewer-act=creation-evidence]'));

  await page.click('[data-tab=draw]');await page.waitForSelector('#drawBtn');
  assert.equal(await page.$('#drawN'),null);
  assert(await page.$('[data-lock=subject] option[value="曾使用的题材"]'));
  await page.select('[data-executor]','agent');
  await page.click('#drawBtn');
  await page.waitForSelector('#mechanism-3-0 [data-act=mechanismCheck]');
  assert.equal(workflowRequests[0].body.creative_version,2);
  assert.equal(workflowRequests[1].query.get('creative_version'),'2');
  assert.equal(workflowRequests[1].query.get('executor'),'agent');
  assert.equal(await page.$$eval('[data-candidate-more]:not([open]) section',nodes=>nodes.length),5);
  assert.equal(await page.$('[data-id="3"] [data-act=mechanismChoose]'),null);
  await page.click('#mechanism-3-0 [data-act=mechanismCheck]');
  await page.waitForSelector('#mechanism-3-0 [data-act=mechanismChoose]');
  assert.equal(workflowRequests[2].query.get('executor'),'agent');
  assert.match(await page.$eval('#mechanism-3-0',node=>node.textContent||''),/已有结果确认存在机制区别/);
  const dialog=new Promise<string>(resolve=>page.once('dialog',value=>{resolve(value.message());void value.accept();}));
  await page.click('#mechanism-3-0 [data-act=mechanismChoose]');
  assert.match(await dialog,/四项摘要会分享给其他 Star 创作者/);
  await page.waitForSelector('#projectContent [data-act=prepareBrief]');
  assert.equal(workflowRequests[3].body.check_id,'check-fixture');
  const postCount=posts.length;
  await page.click('#projectContent [data-act=prepareBrief]');
  assert.equal(posts.length,postCount,'The prerequisite action should not call a model.');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-act')),'brief');

  v2Available=false;
  await page.goto(origin+'/test?tab=draw');await page.waitForSelector('#drawN');
  assert.match(await page.$eval('#view',node=>node.textContent||''),/完整创作流程灰测中/);
  assert.equal(await page.$('[data-lock=subject] option[value="曾使用的题材"]'),null);
  assert.equal(await page.$('[data-act=mechanismCheck]'),null);
  assert.deepEqual(errors, []);
  console.log('PASS 阶段原图、灰测入口、机制查重执行方、管理员判定、明确登记、简报前置与手机布局。');
  if(!v2Only)console.log('PASS 原材料预览、隔离试玩、历史恢复与任务恢复。');
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
