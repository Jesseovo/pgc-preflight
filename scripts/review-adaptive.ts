import type {Browser, BrowserContext, Page, CDPSession} from 'puppeteer-core';
import {createHash} from 'node:crypto';
import {RESOURCE_HOSTS, resourceAllowed} from '../server/policy';

export const PLAY_LIMITS={rounds:6,actions:24,playMs:180000,shots:12,idleMs:10*60000};
export type InformedVerification={purpose:string;source_exposure:true;history_exposure:boolean;origin_session_manifest_sha256:string;claims:string[]};
// Explicitly offline provenance. Member callers never pass this constructor option.
export function validateInformedVerification(value:unknown):InformedVerification{
  const v=value as InformedVerification;
  if(!v||typeof v.purpose!=='string'||!v.purpose.trim()||v.purpose.length>5000||v.source_exposure!==true||typeof v.history_exposure!=='boolean'||typeof v.origin_session_manifest_sha256!=='string'||!/^[a-f0-9]{64}$/.test(v.origin_session_manifest_sha256)||!Array.isArray(v.claims)||!v.claims.length||v.claims.length>24||v.claims.some(c=>typeof c!=='string'||!c.trim()||c.length>5000)||Object.keys(v).some(k=>!['purpose','source_exposure','history_exposure','origin_session_manifest_sha256','claims'].includes(k)))throw new Error('知情核验需要 purpose、source_exposure: true、history_exposure、原清单 SHA-256 和非空 claims 字符串列表。');
  return {...v,claims:[...v.claims]};
}
type Point={x:number;y:number};
export type DragPoint=Point&{atMs:number;capture?:boolean};
export type PlayAction={type:'tap'|'hold'|'drag'|'multi-touch'|'wait'|'restart';x?:number;y?:number;toX?:number;toY?:number;durationMs?:number;points?:Point[];path?:DragPoint[]};
export function validatePlayActions(value:unknown,remaining:number):PlayAction[]{
  if(!Array.isArray(value)||!value.length||value.length>remaining)throw new Error('动作数量超出剩余额度。');
  const point=(x:unknown,y:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<360&&typeof y==='number'&&Number.isFinite(y)&&y>=0&&y<780;
  for(const a of value){
    if(!a||!['tap','hold','drag','multi-touch','wait','restart'].includes(a.type))throw new Error('仅允许可信触摸、等待及重载动作。');
    const allowed=['type','durationMs',...(['tap','hold','drag'].includes(a.type)?['x','y']:[]),...(a.type==='drag'?['toX','toY','path']:[]),...(a.type==='multi-touch'?['points']:[])];
    if(Object.keys(a).some(k=>!allowed.includes(k)))throw new Error('动作含不支持的字段。');
    if(a.durationMs!==undefined&&(!Number.isInteger(a.durationMs)||a.durationMs<0||a.durationMs>30000))throw new Error('动作时间须为 0–30000 毫秒整数。');
    if(a.path!==undefined){
      if(a.type!=='drag'||['x','y','toX','toY','durationMs'].some(k=>k in a)||!Array.isArray(a.path)||a.path.length<2||a.path.length>32||a.path.some((p:any,i:number)=>!p||!point(p.x,p.y)||!Number.isInteger(p.atMs)||p.atMs<0||p.atMs>30000||(i===0?p.atMs!==0:p.atMs<=a.path[i-1].atMs)||p.capture!==undefined&&typeof p.capture!=='boolean'||Object.keys(p).some(k=>!['x','y','atMs','capture'].includes(k))))throw new Error('连续拖动需要 2–32 个坐标时间点，首点为 0，严格递增且末点不超过 30000 毫秒；不能混用旧拖动字段。');
    }
    if(['tap','hold'].includes(a.type)&&!point(a.x,a.y)||a.type==='drag'&&a.path===undefined&&(!point(a.x,a.y)||!point(a.toX,a.toY)))throw new Error('触摸坐标必须在 360×780 视口内。');
    if(a.type==='multi-touch'&&(!Array.isArray(a.points)||a.points.length<2||a.points.length>5||a.points.some((p:any)=>!p||!point(p.x,p.y)||Object.keys(p).some(k=>!['x','y'].includes(k)))))throw new Error('多点触摸需要 2–5 个视口内坐标。');
  }
  return value;
}
export const playActionCaptureCount=(actions:PlayAction[])=>actions.reduce((n,a)=>n+(a.path?.filter(p=>p.capture).length??0),1);
export const plannedPlayActionMs=(actions:PlayAction[])=>actions.reduce((n,a)=>n+(a.type==='restart'?12000:(a.path?.at(-1)?.atMs??a.durationMs??(a.type==='tap'?0:500)))+100,0);
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
// At most 600 regular moves plus 31 non-grid control points in 30 seconds.
// Original control points remain exact, including their capture requests.
function interpolateDrag(path:DragPoint[]):DragPoint[]{
  const samples=new Map(path.map(p=>[p.atMs,p]));let segment=1;
  for(let atMs=50;atMs<path.at(-1)!.atMs;atMs+=50){
    if(samples.has(atMs))continue;
    while(path[segment].atMs<atMs)segment++;
    const from=path[segment-1],to=path[segment],fraction=(atMs-from.atMs)/(to.atMs-from.atMs);
    samples.set(atMs,{atMs,x:from.x+(to.x-from.x)*fraction,y:from.y+(to.y-from.y)*fraction});
  }
  return [...samples.values()].sort((a,b)=>a.atMs-b.atMs);
}

export class AdaptivePlay {
  context?:BrowserContext;page?:Page;cdp?:CDPSession;
  shots:{label:string;data:string;id?:string;capturedAt?:string;source?:string;actionRefs?:number[];actionOffsetMs?:number;requestedOffsetMs?:number}[]=[];actions:any[]=[];errors:string[]=[];resources:string[]=[];
  firstLook:any=null;sourceDisclosure:any=null;rounds=0;playMs=0;modelWaitMs=0;lastOutput:number|null=null;closed=false;
  loadAttempts:{attempt:number;startedAt:string;elapsedMs:number;error:string}[]=[];
  private activeSince:number|null=null;private activeDeadline:ReturnType<typeof setTimeout>|undefined;private exceeded=false;
  private readonly verification:InformedVerification|null;
  private readonly creationHash:string|null;
  private readonly denyExternal:boolean;
  private readonly activeLimitMs:number;
  constructor(private browser:Browser,private html:string,options?:{offlineInformedVerification?:InformedVerification;creationInputHash?:string;denyExternal?:boolean;creationActiveBudgetMs?:number}){
    if(options!==undefined&&(!options||typeof options!=='object'||
      (options.offlineInformedVerification!==undefined)===(options.creationInputHash!==undefined)||
      Object.keys(options).some(k=>!(options.creationInputHash!==undefined?['creationInputHash','creationActiveBudgetMs','denyExternal']:['offlineInformedVerification']).includes(k)))){
      throw new Error('知情核验或制作自检必须声明唯一来源。');
    }
    this.verification=options?.offlineInformedVerification!==undefined?validateInformedVerification(options.offlineInformedVerification):null;
    this.creationHash=options?.creationInputHash??null;
    if(options?.creationInputHash!==undefined&&(typeof this.creationHash!=='string'||!/^[a-f0-9]{64}$/.test(this.creationHash)||options.denyExternal!==undefined&&options.denyExternal!==true))throw new Error('制作自检需要锁定 HTML SHA-256 并禁用外部网络。');
    this.denyExternal=this.creationHash!==null;
    this.activeLimitMs=options?.creationActiveBudgetMs??PLAY_LIMITS.playMs;
    if(!Number.isSafeInteger(this.activeLimitMs)||this.activeLimitMs<1||this.activeLimitMs>PLAY_LIMITS.playMs||options?.creationActiveBudgetMs!==undefined&&!this.creationHash)throw new Error('Invalid creation play budget');
  }
  get verificationContext(){return this.verification?{...this.verification,claims:[...this.verification.claims],contextOrigin:'informed-verification' as const,sourceBlind:false as const}:null;}
  get initialImageLabel(){return this.creationHash?'制作自检初始视口（已接触源码，非盲评）':this.verification?'知情定向核验初始视口（已接触源码；不是盲评首次印象）':'首次印象（未触摸、未披露源码）';}
  private beginActive(){
    if(this.activeSince!==null)return;
    if(this.closed||this.playMs>=this.activeLimitMs)throw new Error('实际活跃渲染已达到 180 秒。');
    this.activeSince=performance.now();this.activeDeadline=setTimeout(()=>{this.exceeded=true;void this.close();},this.activeLimitMs-this.playMs);
  }
  private endActive(){if(this.activeSince!==null){this.playMs+=Math.ceil(performance.now()-this.activeSince);this.activeSince=null;}clearTimeout(this.activeDeadline);if(this.exceeded||this.playMs>this.activeLimitMs)throw new Error('活跃渲染超出 180 秒，采集失败；不能发布此证据。');}
  async start(){
    // A failed navigation gets one fresh context. It never retries a game action.
    for(let attempt=0;attempt<2;attempt++){
      const clock=performance.now(),startedAt=new Date().toISOString();
      try{await this.open();const shot=await this.observe(this.initialImageLabel);this.loadAttempts.push({attempt:attempt+1,startedAt,elapsedMs:Math.ceil(performance.now()-clock),error:''});return shot;}
      catch(e){this.loadAttempts.push({attempt:attempt+1,startedAt,elapsedMs:Math.ceil(performance.now()-clock),error:String(e).slice(0,300)});await this.context?.close().catch(()=>{});this.endActive();if(attempt||this.closed)throw e;}
    }
    throw new Error('无法加载游戏。');
  }
  private async open(){
    this.context=await this.browser.createBrowserContext();this.page=await this.context.newPage();
    const page=this.page,origin=`https://play-${crypto.randomUUID()}.invalid`,url=`${origin}/index.html`;
    await page.setViewport({width:360,height:780,deviceScaleFactor:1,isMobile:true,hasTouch:true});
    await page.setRequestInterception(true);
    const sources=this.denyExternal?'':[...RESOURCE_HOSTS].map(h=>`https://${h}`).join(' ');
    page.on('request',request=>{
      if(request.url()===url&&request.isNavigationRequest()&&request.frame()===page.mainFrame())void request.respond({status:200,contentType:'text/html; charset=utf-8',headers:{'Content-Security-Policy':`default-src 'self' data: blob: ${sources}; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${sources}; style-src 'self' 'unsafe-inline' ${sources}; connect-src ${sources||"'none'"}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin`,'Referrer-Policy':'no-referrer'},body:this.html}).catch(()=>{});
      else if(request.isNavigationRequest()||request.url().startsWith(origin)||(this.denyExternal&&!/^(data:|blob:)/.test(request.url()))||!resourceAllowed(request.url())){if(this.resources.length<30)this.resources.push(request.url().replace(/[?#].*$/,'').slice(0,180));void request.abort().catch(()=>{});}
      else void request.continue().catch(()=>{});
    });
    page.on('pageerror',error=>{if(this.errors.length<30)this.errors.push(String(error).slice(0,300));});
    page.on('console',message=>{if(/content security policy/i.test(message.text())){const blocked=message.text().match(/https?:\/\/[^\s'"<>]+/)?.[0];if(blocked&&!blocked.startsWith(origin)&&this.resources.length<30)this.resources.push(blocked.replace(/[?#].*$/,'').slice(0,180));}});
    page.on('dialog',dialog=>{void dialog.dismiss().catch(()=>{});});page.on('popup',popup=>{void popup?.close().catch(()=>{});});
    this.beginActive();await page.goto(url,{waitUntil:'load',timeout:12000});await pause(1000);this.cdp=await page.createCDPSession();await this.cdp.send('Animation.enable');
  }
  private async freeze(frozen:boolean){
    // Lifecycle freezing leaves trusted touch dispatch blocked on some Chrome
    // versions. Debugger pause/disable suspends JS without inspecting its state,
    // and disable cancels a pending pause even on an otherwise idle static page.
    if(!frozen)await this.cdp!.send('Debugger.disable');
    await this.cdp!.send('Animation.setPlaybackRate',{playbackRate:frozen?0:1});
    if(frozen){await this.cdp!.send('Debugger.enable');await this.cdp!.send('Debugger.pause');}
  }
  private async capture(label:string,actionRefs:number[],timing?:{actionOffsetMs:number;requestedOffsetMs:number}){
    if(this.closed||!this.page)throw new Error('试玩会话已关闭。');
    if(this.shots.length>=PLAY_LIMITS.shots)throw new Error('补充截图已达上限。');
    const capturedAt=new Date().toISOString();
    const data=await this.page.screenshot({type:'jpeg',quality:80,encoding:'base64'}),id=`supplemental-${this.shots.length+1}`;
    const shot={id,capturedAt,source:this.creationHash?'isolated-chromium':'member-device',actionRefs,...timing,label:`${id} 9:19.5 ${label}`,data:`data:image/jpeg;base64,${data}`};this.shots.push(shot);
    return {...shot,imageSha256:createHash('sha256').update(Buffer.from(data,'base64')).digest('hex'),width:360,height:780};
  }
  async observe(label='补充观察'){
    const shot=await this.capture(label,this.actions.length?[this.actions.length]:[]);
    await this.freeze(true);this.endActive();
    if(this.lastOutput!==null)this.modelWaitMs+=Math.max(0,performance.now()-this.lastOutput);this.lastOutput=performance.now();
    return shot;
  }
  recordFirstLook(value:any){
    if(this.verification)throw new Error('知情核验不能记录盲评首次印象。');
    if(this.creationHash)throw new Error('制作自检不能记录盲评首次印象。');
    if(this.firstLook)throw new Error('首次印象已锁定。');
    if(!this.shots.length)throw new Error('必须先采集初始完整视口图片。');
    const hash=createHash('sha256').update(Buffer.from(this.shots[0].data.split(',')[1],'base64')).digest('hex');
    if(!value||value.imageSha256!==hash||typeof value.observations!=='string'||!value.observations.trim()||value.observations.length>5000||!Array.isArray(value.uncertainties)||value.uncertainties.length>20||value.uncertainties.some((x:any)=>typeof x!=='string'||x.length>1000))throw new Error('首次印象需要原图 SHA-256、观察描述与不确定项列表。');
    this.firstLook={imageSha256:hash,observations:value.observations,uncertainties:value.uncertainties,sourceBlind:true,recordedAt:new Date().toISOString(),preDisclosureActionCount:this.actions.length};return {accepted:true};
  }
  discloseSource(){if(!this.firstLook&&!this.verification&&!this.creationHash)throw new Error('首次印象尚未记录。');this.sourceDisclosure??={recordedAt:new Date().toISOString(),actionCount:this.actions.length};}
  async act(value:any){
    if(!this.shots.length)throw new Error('必须先实际查看初始完整视口图片。');
    if(this.rounds>=PLAY_LIMITS.rounds||this.shots.length>=PLAY_LIMITS.shots)throw new Error('试玩轮次或截图已达上限。');
    if(typeof value?.hypothesis!=='string'||!value.hypothesis.trim()||value.hypothesis.length>2000)throw new Error('每轮需要 Agent 提出的待验证假设。');
    const actions=validatePlayActions(value.actions,PLAY_LIMITS.actions-this.actions.length);
    const captures=playActionCaptureCount(actions);
    if(this.shots.length+captures>PLAY_LIMITS.shots)throw new Error('连续动作及轮末截图将超出十二张补充截图上限。');
    const cost=plannedPlayActionMs(actions);
    if(this.playMs+cost>this.activeLimitMs)throw new Error('实际试玩时间将超过 180 秒。');
    if(this.lastOutput!==null)this.modelWaitMs+=Math.max(0,performance.now()-this.lastOutput);this.lastOutput=null;this.rounds++;
    this.beginActive();
    try{await this.freeze(false);const roundRecords:any[]=[];for(const action of actions){const clock=performance.now();const record={round:this.rounds,hypothesis:value.hypothesis,...action,...(action.path?{trajectoryMethod:'linear-interpolation-50ms-v1'}:{}),beforeImageId:`supplemental-${this.shots.length}`,afterImageId:'',startedAt:new Date().toISOString(),elapsedMs:0,error:''};this.actions.push(record);roundRecords.push(record);try{await this.execute(action,this.actions.length);}catch(e){record.error=String(e).slice(0,300);}record.elapsedMs=Math.floor(performance.now()-clock);if(record.error)break;}
      const shot=await this.observe(`第 ${this.rounds} 轮后`);for(const record of roundRecords)record.afterImageId=shot.id;return {...shot,rounds:this.rounds,actionCount:this.actions.length,playMs:this.playMs};
    }catch(e){await this.close();throw e;}
  }
  private async execute(a:PlayAction,actionRef:number){
    const duration=a.durationMs??500;
    if(a.type==='wait'){await pause(duration);return;}
    if(a.type==='restart'){await this.page!.reload({waitUntil:'load',timeout:12000});return;}
    if(a.type==='tap'){await this.page!.touchscreen.tap(a.x!,a.y!);if(a.durationMs)await pause(a.durationMs);return;}
    const points=a.type==='multi-touch'?a.points!:a.path?[a.path[0]]:[{x:a.x!,y:a.y!}];
    const touchPoints=points.map((p,id)=>({x:p.x,y:p.y,id,radiusX:1,radiusY:1,force:1}));
    const gestureClock=performance.now();
    await this.cdp!.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints});
    try{if(a.path){for(const [index,p] of interpolateDrag(a.path).entries()){const remaining=p.atMs-(performance.now()-gestureClock);if(remaining>0)await pause(remaining);if(index)await this.cdp!.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...touchPoints[0],x:p.x,y:p.y}]});if(p.capture)await this.capture(`连续触摸 ${actionRef} 的 ${p.atMs}ms 点（未松手）`,[actionRef],{actionOffsetMs:Math.floor(performance.now()-gestureClock),requestedOffsetMs:p.atMs});}}else if(a.type==='drag'){const steps=10;for(let step=1;step<=steps;step++){await pause(duration/steps);await this.cdp!.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...touchPoints[0],x:a.x!+(a.toX!-a.x!)*step/steps,y:a.y!+(a.toY!-a.y!)*step/steps}]});}}else await pause(duration);}
    finally{await this.cdp!.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  }
  summary(){if(this.exceeded)throw new Error('Play budget exceeded; evidence cannot be published.');if(!this.firstLook&&!this.verification&&!this.creationHash)throw new Error('首次印象尚未记录。');return {...(this.verification?{verificationContext:this.verificationContext,contextOrigin:'informed-verification',sourceBlind:false}:this.creationHash?{contextOrigin:'creator-self-check',sourceBlind:false,inputHash:this.creationHash}:{}),firstLook:this.firstLook,sourceDisclosure:this.sourceDisclosure,rounds:this.rounds,actionCount:this.actions.length,playMs:this.playMs,modelWaitMs:Math.round(this.modelWaitMs+(this.lastOutput===null?0:Math.max(0,performance.now()-this.lastOutput))),actions:this.actions,loadAttempts:this.loadAttempts,errors:this.errors,resources:this.resources,limits:PLAY_LIMITS,waitingPolicy:'javascript-and-animation-paused',note:'Agent 选择动作与假设；等待时冻结渲染任务和 CSS 动画。恢复后的系统时钟跳变仍可能影响游戏，恢复瞬间的死亡或状态跳变不可作为难度、节奏或输入成败证据。截图变化不是操作有效的证明；等待和未覆盖内容不能直接扣分。音频未监听。'};}
  async close(){this.closed=true;await this.context?.close().catch(()=>{});try{this.endActive();}catch{this.exceeded=true;}}
}
