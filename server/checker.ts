import type { Browser, Page } from 'puppeteer-core';
import type { CheckInput, CheckReport, Evidence } from '../src/types';
import { RESOURCE_HOSTS, resourceAllowed } from './policy';
import { parseDecision, REVIEW_PROMPT } from './model';
import type { ChatMessage, ModelAction, ModelTransport } from './model';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const MAX_ACTIONS = 6;
const TIME_BUDGET = 150000;

/** The program gathers evidence and executes bounded actions. Only the model judges the game. */
export async function inspectGame(browser: Browser, input: CheckInput, askModel: ModelTransport): Promise<CheckReport> {
  const started = Date.now();
  const report: CheckReport = {
    id: crypto.randomUUID(), filename: input.filename, title: input.filename.replace(/\.html?$/i, ''),
    status: 'review', startedAt: new Date(started).toISOString(), durationMs: 0,
    findings: [], evidence: [], actions: [],
    uncovered: ['真实手机触控、操作手感、画面美感、难度与趣味性', '未实际到达的关卡、结算与其他游戏分支'],
    engine: '视觉大模型审核 · Chromium 浏览器取证 · model-v1',
  };
  const origin = `https://game-${report.id}.invalid`;
  const logs = { errors: [] as string[], localResources: [] as string[], restrictedResources: [] as string[], failedResources: [] as string[] };
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  let expired = false;
  let gotoError = '';
  const deadline = setTimeout(() => { expired = true; void context.close().catch(() => {}); }, TIME_BUDGET);
  try {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.setRequestInterception(true);
    const allowedSources = [...RESOURCE_HOSTS].map(host => `https://${host}`).join(' ');
    page.on('request', request => {
      const url = request.url();
      if (url === `${origin}/index.html` && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        void request.respond({ status:200, contentType:'text/html; charset=utf-8', headers:{
          'Content-Security-Policy': `default-src 'self' data: blob: ${allowedSources}; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${allowedSources}; style-src 'self' 'unsafe-inline' ${allowedSources}; connect-src ${allowedSources}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin`,
          'Referrer-Policy':'no-referrer',
        }, body:input.html }).catch(()=>{});
      } else if (url.startsWith(`${origin}/`)) {
        if (!url.endsWith('/favicon.ico')) logs.localResources.push(url.slice(origin.length));
        void request.abort().catch(()=>{});
      } else if (request.isNavigationRequest() || !resourceAllowed(url)) {
        logs.restrictedResources.push(resourceLabel(url)); void request.abort().catch(()=>{});
      } else void request.continue().catch(()=>{});
    });
    page.on('pageerror', error => logs.errors.push(String(error instanceof Error?error.message:error).slice(0,350)));
    page.on('response', response => { if(response.status()>=400) logs.failedResources.push(`${response.status()} ${resourceLabel(response.url())}`); });
    page.on('requestfailed', request => { if(resourceAllowed(request.url())&&!request.url().startsWith(origin)) logs.failedResources.push(resourceLabel(request.url())); });
    page.on('console', message => { const text=message.text(); if(/content security policy/i.test(text)){ const url=text.match(/https?:\/\/[^\s'"<>]+/)?.[0]; if(url&&!url.startsWith(origin)) logs.restrictedResources.push(resourceLabel(url)); } });
    page.on('dialog', dialog => { void dialog.dismiss().catch(()=>{}); });
    page.on('popup', popup => { if(popup) void popup.close().catch(()=>{}); });
    try { await page.goto(`${origin}/index.html`,{waitUntil:'domcontentloaded',timeout:10000}); }
    catch(error) { gotoError=String(error instanceof Error?error.message:error).slice(0,200); }
    await pause(750);

    const capture = async (label:string) => {
      const viewport=page.viewport()!;
      const id=`observation-${report.evidence.length}`;
      const image=await page.screenshot({type:'jpeg',quality:60,encoding:'base64'});
      const evidence:Evidence={id,label,width:viewport.width,height:viewport.height,image:`data:image/jpeg;base64,${image}`};
      report.evidence.push(evidence);
      const dom=await page.evaluate(`(() => {
        const controls=[...document.querySelectorAll('button,[role="button"],a,input,canvas')].slice(0,60).map(el=>{
          const r=el.getBoundingClientRect(),s=getComputedStyle(el);
          return {tag:el.tagName,text:(el.getAttribute('aria-label')||el.innerText||el.value||'').slice(0,80),rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},display:s.display,visibility:s.visibility,opacity:s.opacity};
        });
        return {title:document.title,text:(document.body?.innerText||'').slice(0,2500),layoutWidth:document.documentElement.clientWidth,layoutHeight:document.documentElement.clientHeight,controls};
      })()`);
      return {evidence,observation:{id,label,viewport,dom,logs:{errors:[...new Set(logs.errors)].slice(0,12),localResources:[...new Set(logs.localResources)].slice(0,12),restrictedResources:[...new Set(logs.restrictedResources)].slice(0,12),failedResources:[...new Set(logs.failedResources)].slice(0,12)},gotoError}};
    };
    const wide=await capture('初始画面 · 390 × 844');
    await page.setViewport({width:360,height:780,deviceScaleFactor:1,isMobile:true,hasTouch:true});
    await pause(200);
    const narrow=await capture('初始画面 · 360 × 780');
    await page.setViewport({width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});

    const messages:ChatMessage[]=[
      {role:'system',content:REVIEW_PROMPT},
      {role:'user',content:[
        {type:'text',text:JSON.stringify({filename:input.filename,instructions:input.instructions||'未提供，由你结合截图和源码识别基本操作。',source:input.html.slice(0,90000),sourceTruncated:input.html.length>90000,observations:[wide.observation,narrow.observation],currentViewport:{width:390,height:844},note:'下面两张图片分别为 observation-0 和 observation-1。已恢复 390×844，后续坐标基于此尺寸。'})},
        {type:'image_url',image_url:{url:wide.evidence.image}},
        {type:'image_url',image_url:{url:narrow.evidence.image}},
      ]},
    ];
    let actions=0;
    let repairs=0;
    for(let round=0;round<MAX_ACTIONS+4;round++) {
      if(expired) throw new Error('检查达到时间上限。');
      const raw=await askModel(messages);
      messages.push({role:'assistant',content:raw});
      try {
        const decision=parseDecision(raw);
        if('report' in decision) {
          const result=decision.report;
          if(result.findings.some(f=>f.evidenceId&&!report.evidence.some(e=>e.id===f.evidenceId))) throw new Error('报告引用了不存在的截图编号。');
          if(result.status==='pass'&&result.findings.some(f=>f.status!=='pass')) throw new Error('总体通过与待确认/问题条目矛盾，请重新给出一致的结论。');
          report.title=result.title.slice(0,120)||report.title;
          report.status=result.status;
          report.findings=result.findings;
          report.uncovered=[...new Set([...report.uncovered,...result.uncovered])];
          break;
        }
        if(actions>=MAX_ACTIONS) { messages.push({role:'user',content:'操作预算已用完，请根据现有证据只输出 report；无法验证的项目写 review。'}); continue; }
        await executeAction(page,decision.action);
        actions++;
        report.actions.push(`${actions}. ${decision.reason}`);
        await pause(250);
        const next=await capture(`操作 ${actions} 后 · ${page.viewport()!.width} × ${page.viewport()!.height}`);
        messages.push({role:'user',content:[{type:'text',text:JSON.stringify({lastAction:decision.action,observation:next.observation,remainingActions:MAX_ACTIONS-actions})},{type:'image_url',image_url:{url:next.evidence.image}}]});
      } catch(error) {
        if(++repairs>2) throw new Error('模型多次未能返回有效操作或报告，请在管理页测试模型兼容性。');
        messages.push({role:'user',content:`返回结构或操作无效：${String(error instanceof Error?error.message:error).slice(0,200)}。请修正 JSON，不要编造已执行的操作。`});
      }
    }
    if(!report.findings.length) throw new Error('模型未在操作预算内给出审核结论。');
  } catch(error) {
    // This is an execution failure, not a rule-based judgment about the game.
    report.status='review';
    report.findings=[{category:'runtime',status:'review',title:'模型审核未完成',detail:expired?'检查达到时间上限，请重试或人工确认。':String(error instanceof Error?error.message:error).slice(0,300)}];
    report.uncovered.push('本次未获得完整模型审核结论，不能据此判断游戏通过或不合格。');
  } finally { clearTimeout(deadline); await context.close().catch(()=>{}); }
  report.durationMs=Date.now()-started;
  return report;
}

function resourceLabel(raw:string) { try{const u=new URL(raw);return`${u.hostname}${u.pathname}`.slice(0,160);}catch{return raw.slice(0,100);} }
async function executeAction(page:Page,action:ModelAction) {
  const viewport=page.viewport()!;
  const point=(x:unknown,y:unknown)=>{if(typeof x!=='number'||typeof y!=='number'||!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=viewport.width||y>=viewport.height)throw new Error('操作坐标超出当前画面。');return[x,y]as const;};
  const duration=(ms:number|undefined)=>Math.max(100,Math.min(1500,Number.isFinite(ms)?ms!:500));
  if(action.type==='tap'){const[x,y]=point(action.x,action.y);await page.touchscreen.tap(x,y);}
  else if(action.type==='hold'){const[x,y]=point(action.x,action.y);await page.touchscreen.touchStart(x,y);await pause(duration(action.ms));await page.touchscreen.touchEnd();}
  else if(action.type==='swipe'){
    const[x,y]=point(action.x,action.y),[toX,toY]=point(action.toX,action.toY);
    await page.touchscreen.touchStart(x,y);
    for(let i=1;i<=8;i++){await page.touchscreen.touchMove(x+(toX-x)*i/8,y+(toY-y)*i/8);await pause(duration(action.ms)/8);}
    await page.touchscreen.touchEnd();
  }else if(action.type==='key'){
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space','Enter'].includes(action.key||''))throw new Error('不支持这个按键。');
    await page.keyboard.press(action.key as 'Enter');
  }else if(action.type==='wait')await pause(duration(action.ms));
  else if(action.type==='resize'){
    if(!((action.width===360&&action.height===780)||(action.width===390&&action.height===844)))throw new Error('仅支持 360×780 或 390×844。');
    await page.setViewport({width:action.width,height:action.height,deviceScaleFactor:1,isMobile:true,hasTouch:true});
  }
}
