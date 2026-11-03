import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const topics = new Map(Array.from({length:60},(_,i)=>[i+1,makeTopic(i+1,i!==1)]));
const products = new Map([[1, game(1)]]);
const posts: Array<{ kind: string; id: number; regenerate: string | null }> = [];
const jobs: any[] = [];
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

let apiReads=0;
const before=process.argv.includes('--baseline');
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  const parts = url.pathname.split('/');
  const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const preview = (content: string) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'" }); res.end(content); };
  try {
    if(url.pathname.startsWith('/api/')&&req.method==='GET'){apiReads++;await new Promise(resolve=>setTimeout(resolve,100));}
    if(url.pathname==='/api/forge/review/worker-status')return json({devices:[],online:false});
    if(url.pathname==='/api/forge/review/jobs'||url.pathname==='/api/forge/reviews')return json([]);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/api/auth/me') return json({ id: 'fixture-star', role: 'member', star: true, canReview: true, displayName: '交互验证' });
    if (url.pathname === '/api/forge/state') return json({ games: 2, vocab: 5 });
    if (url.pathname === '/api/forge/settings') return json({ draw_size: 2 });
    if (url.pathname === '/api/forge/vocab') return json([]);
    if (url.pathname === '/api/forge/topics' || url.pathname === '/api/forge/products') return json([...topics.values()]);
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

    const publicRoot = resolve(before?'artifacts/experience-baseline/public':'public');
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

try {
  const page=await browser.newPage(), errors:string[]=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.setViewport({width:1440,height:1000});
  const initial=performance.now();await page.goto(origin+'/test?tab=draw');await page.waitForSelector('#drawBtn');
  const initialMs=performance.now()-initial;
  const times:number[]=[];
  for(let i=0;i<6;i++){
    const t=performance.now();await page.click('[data-tab=picks]');await page.waitForSelector('#pickCards');times.push(performance.now()-t);
    await page.click('[data-tab=products]');await page.waitForSelector('#productCards');
  }
  const result:any={fixture:'60 synthetic projects, 100ms API latency',initialMs,warmProjectSwitchMs:times.slice(1),apiReads,domNodes:await page.$$eval('*',nodes=>nodes.length),checks:[]};
  if(!before){
    await page.click('[data-tab=picks]');await page.waitForSelector('#pickCards');
    assert.equal(await page.$$eval('#pickCards .project-row',nodes=>nodes.length),24);
    assert(await page.$eval('.project-row',node=>node.getBoundingClientRect().width)>800,'Project rows use the available workspace width');
    await page.screenshot({path:'artifacts/experience-star-projects.png'});
    const stability=await page.evaluate(async()=>{
      const {patchHtml}=await import('/forge/experience.js' as string);
      const root=document.createElement('section');document.body.append(root);
      patchHtml(root,'<input id="typing" value="initial"><iframe id="stable-game" src="about:blank"></iframe><p>waiting</p>');
      const input=root.querySelector('input')!,frame=root.querySelector('iframe')!;input.value='unsaved text';input.focus();
      patchHtml(root,'<input id="typing" value="initial"><iframe id="stable-game" src="about:blank"></iframe><p>done</p>');
      const result=input===root.querySelector('input')&&input.value==='unsaved text'&&document.activeElement===input&&frame===root.querySelector('iframe');
      const rows=Array.from({length:1000},(_,i)=>`<p data-id="${i}">Row ${i}</p>`);patchHtml(root,rows.join(''));
      const identities=new Map([...root.children].map(node=>[node.getAttribute('data-id'),node]));
      patchHtml(root,rows.reverse().join(''));
      const reordered=[...root.children].every((node,index)=>identities.get(String(999-index))===node);
      root.remove();return result&&reordered;
    });assert(stability,'Background updates retain input, focus and iframe identity');
    await page.click('[data-open-project="1"]');await page.waitForSelector('#projectContent');
    assert.equal(new URL(page.url()).searchParams.get('project'),'1');
    await page.select('[data-executor]','agent');await page.reload();await page.waitForSelector('[data-executor]');
    assert.equal(await page.$eval('[data-executor]',node=>(node as HTMLSelectElement).value),'agent');
    await page.click('[data-project-panel=play]');await page.waitForSelector('#projectContent iframe');
    const frame=await(await page.$('#projectContent iframe'))!.contentFrame();await frame!.waitForSelector('#play');await frame!.click('#play');
    assert((await frame!.content()).includes('Played 1'));assert.equal(await frame!.evaluate('typeof parent.document').catch(()=>'blocked'),'blocked');
    await page.screenshot({path:'artifacts/experience-star-player.png'});
    await page.click('[data-project-panel=versions]');await page.waitForSelector('[data-viewer-version]');
    assert.equal(await page.$$eval('#projectContent iframe',nodes=>nodes.length),0);
    await page.click('[data-viewer-version=game-1]');await page.waitForSelector('#projectContent iframe');
    await page.click('[data-tab=review]');await page.waitForSelector('.review-setup');
    assert(!await page.$eval('.review-setup',node=>(node as HTMLDetailsElement).open),'Connection help is collapsed until requested');
    assert.equal(await page.$$eval('#rvChoose',nodes=>nodes.length),0);
    await page.screenshot({path:'artifacts/experience-review-desktop.png'});
    await page.setViewport({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.screenshot({path:'artifacts/experience-review-mobile.png'});
    await page.click('[data-tab=picks]');await page.waitForSelector('#pickCards');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    topics.get(1)!.data.title='LongProjectTitle'.repeat(12)+' · 长标题测试';
    topics.get(3)!.expand_status='running';topics.get(4)!.expand_status='error';
    await page.reload();await page.waitForSelector('#pickCards');
    for(const width of [360,390,768,1024,1280]){
      await page.setViewport({width,height:844});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Project list fits at ${width}px`);
      const fits=await page.$$eval('.project-toolbar input,.project-toolbar select,.project-layout,.project-row-state,.project-row-action',nodes=>nodes.every(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;}));
      assert(fits,`Search, filters and project actions remain visible at ${width}px`);
    }
    await page.setViewport({width:390,height:844});
    await page.screenshot({path:'artifacts/experience-projects-mobile.png',fullPage:true});
    await page.click('[data-project-layout=cards]');
    assert.equal(await page.$eval('[data-project-layout=cards]',node=>node.getAttribute('aria-pressed')),'true');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Cards with long names fit mobile');
    await page.type('#projectSearch','no-such-project');await page.keyboard.press('Enter');await page.waitForSelector('#projectReset');
    assert.match(await page.$eval('#pickCards',node=>node.textContent!),/没有匹配/);
    await page.click('#projectReset');assert.equal(await page.$$eval('#pickCards .card',nodes=>nodes.length),24);
    assert.equal(await page.$eval('#projectSearch',node=>node===document.activeElement),true,'Reset returns focus to search');
    await page.click('[data-project-layout=list]');
    await page.select('#projectFilter','working');
    assert.equal(await page.$$eval('#pickCards [data-id]',nodes=>nodes.map(node=>(node as HTMLElement).dataset.id).join(',')),'3','In-progress filtering includes expansion tasks');
    await page.select('#projectFilter','error');
    assert.equal(await page.$$eval('#pickCards [data-id]',nodes=>nodes.map(node=>(node as HTMLElement).dataset.id).join(',')),'4','Needs-attention filtering includes failed expansion tasks');
    await page.setViewport({width:360,height:640});
    await page.click('.member-tools>summary');await page.click('.member-tools [data-tab=settings]');await page.waitForSelector('#changePassword');
    assert(!await page.$eval('.member-tools',node=>(node as HTMLDetailsElement).open),'Selecting a secondary page closes compact navigation');
    await page.click('#changePassword');await page.waitForSelector('#modal:not([hidden])');
    await page.$eval('#modalTitle',node=>node.textContent='LongDialogTitle'.repeat(16));
    assert(await page.$eval('#modalClose',node=>{const r=node.getBoundingClientRect();return r.right<=innerWidth&&r.left>=0&&r.bottom<=innerHeight&&r.top>=0;}),'A long dialog title cannot push the close button off-screen');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Open dialog cannot overflow the page');
    await page.keyboard.press('Escape');
    assert(await page.$eval('#changePassword',node=>node===document.activeElement),'Closing a dialog restores focus');
    assert.equal(posts.length,0);assert.equal(errors.length,0,errors.join('\n'));
    result.checks=['24-item bounded list','input, focus and player DOM retained across updates','project deep link and refresh','executor preference restored','actual playable sandbox','immutable version preview','leaving game destroys iframe','review onboarding without invalid upload','360–1280px long-title list, controls and cards','filter reset and selected view state','expansion task status filters','compact secondary navigation and long modal title','zero generation POSTs','no browser errors'];
  }
  await writeFile(`artifacts/experience-${before?'before':'after'}.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {await browser.close();server.close();}
