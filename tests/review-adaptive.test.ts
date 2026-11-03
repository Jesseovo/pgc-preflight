import {describe,it,expect,vi} from 'vitest';
import {AdaptivePlay,validatePlayActions,PLAY_LIMITS,validateInformedVerification} from '../scripts/review-adaptive';
import {createHash} from 'node:crypto';
import {validateReviewEvidence} from '../server/review-evidence';

describe('bounded member supplemental play',()=>{
  it('rejects injection primitives and out-of-viewport/nonfinite coordinates before execution',()=>{
    for(const value of [[{type:'eval',script:'win()'}],[{type:'tap',x:360,y:1}],[{type:'tap',x:1,y:NaN}],[{type:'tap',x:1,y:2,script:'win()'}],[{type:'drag',x:1,y:2,toX:-1,toY:2}],[{type:'wait',durationMs:30001}],[{type:'multi-touch',points:[{x:1,y:2}]}]])expect(()=>validatePlayActions(value,24)).toThrow();
    expect(()=>validatePlayActions([{type:'wait'}],0)).toThrow();
    expect(validatePlayActions([{type:'multi-touch',points:[{x:0,y:0},{x:359,y:779}],durationMs:10}],1)).toHaveLength(1);
  });
  it('locks first impression to actual initial image and gates all adaptive actions',async()=>{
    const play=new AdaptivePlay({} as any,'private source');
    await expect(play.act({hypothesis:'start',actions:[{type:'tap',x:2,y:2}]})).rejects.toThrow('初始');
    play.shots.push({label:'initial',data:'data:image/jpeg;base64,YQ=='});
    expect(()=>play.recordFirstLook({imageSha256:'wrong',observations:'seen',uncertainties:[]})).toThrow();
    play.recordFirstLook({imageSha256:createHash('sha256').update('a').digest('hex'),observations:'Visible title; start unclear',uncertainties:['No play yet']});
    expect(play.summary().firstLook.sourceBlind).toBe(true);
    expect(()=>play.recordFirstLook({})).toThrow('锁定');
    play.rounds=PLAY_LIMITS.rounds;
    await expect(play.act({hypothesis:'start',actions:[{type:'wait',durationMs:0}]})).rejects.toThrow('上限');
  });
  it('keeps source disclosure and summary gated by first-look unless explicit offline provenance is supplied',()=>{
    const play=new AdaptivePlay({} as any,'source');
    play.shots.push({label:'initial',data:'data:image/jpeg;base64,YQ=='});
    expect(()=>play.discloseSource()).toThrow('首次印象');
    expect(()=>play.summary()).toThrow('首次印象');
    expect(()=>new AdaptivePlay({} as any,'source',{} as any)).toThrow('知情核验');
  });
  it('never describes informed verification as a fresh first look and retains the same budgets',async()=>{
    const provenance={purpose:'Verify historical control claim',source_exposure:true as const,history_exposure:true,origin_session_manifest_sha256:'a'.repeat(64),claims:['Can a shot coexist with dragging?']};
    const play=new AdaptivePlay({} as any,'source',{offlineInformedVerification:provenance});
    provenance.claims.push('Mutation must not change locked provenance');
    play.verificationContext!.claims.push('Nor a mutation of exported context');
    expect(play.initialImageLabel).toContain('知情');expect(play.initialImageLabel).not.toContain('未披露源码');
    expect(()=>play.recordFirstLook({})).toThrow('知情核验');
    expect(()=>play.discloseSource()).not.toThrow();
    expect(play.summary()).toMatchObject({contextOrigin:'informed-verification',sourceBlind:false,firstLook:null,verificationContext:{claims:['Can a shot coexist with dragging?']},limits:{rounds:6,actions:24,playMs:180000,shots:12}});
    play.shots.push({label:'informed initial',data:'data:image/jpeg;base64,YQ=='});play.rounds=6;
    await expect(play.act({hypothesis:'test',actions:[{type:'wait',durationMs:0}]})).rejects.toThrow('上限');
    // A local informed summary is deliberately not valid enhanced member evidence.
    await expect(validateReviewEvidence({review_mode:'enhanced',model_executor:'agent',report_schema_version:2},{captureMethod:'browser-viewport-v2',adaptive:play.summary()},Array.from({length:5},()=>({label:'viewport',data:'data:image/jpeg;base64,YQ=='})))).rejects.toThrow();
  });
  it('preflights action, screenshot and active-time limits in informed mode too',async()=>{
    const verification={purpose:'Verify',source_exposure:true as const,history_exposure:false,origin_session_manifest_sha256:'a'.repeat(64),claims:['Control claim']};
    const play=new AdaptivePlay({} as any,'source',{offlineInformedVerification:verification});
    const act=()=>play.act({hypothesis:'test',actions:[{type:'wait',durationMs:10}]});
    play.shots.push({label:'informed',data:'data:image/jpeg;base64,YQ=='});
    play.actions=Array.from({length:24},()=>({}));await expect(act()).rejects.toThrow('动作数量');
    play.actions=[];play.shots=Array.from({length:12},()=>({label:'informed',data:'data:image/jpeg;base64,YQ=='}));await expect(act()).rejects.toThrow('上限');
    play.shots.length=1;play.playMs=179999;await expect(act()).rejects.toThrow('180');
    expect(play.actions).toEqual([]);expect(play.rounds).toBe(0);
  });
  it('requires explicit source/history exposure, an origin hash and targeted claims',()=>{
    const good={purpose:'Verify',source_exposure:true,history_exposure:false,origin_session_manifest_sha256:'b'.repeat(64),claims:['Claim']};
    expect(validateInformedVerification(good)).toEqual(good);
    for(const patch of [{purpose:''},{source_exposure:false},{history_exposure:undefined},{origin_session_manifest_sha256:'bad'},{claims:[]},{claims:['']},{sourceBlind:true}])expect(()=>validateInformedVerification({...good,...patch})).toThrow('知情核验');
  });
  it('rejects an entire over-budget round without running its first action',async()=>{
    const play=new AdaptivePlay({} as any,'source');play.firstLook={sourceBlind:true};play.shots.push({label:'initial',data:'data:image/jpeg;base64,YQ=='});play.playMs=179999;
    await expect(play.act({hypothesis:'wait',actions:[{type:'wait',durationMs:10}]})).rejects.toThrow('180');
    expect(play.actions).toEqual([]);expect(play.rounds).toBe(0);
  });
  it('counts screenshot and pause overhead until suspended and rejects exceeded evidence',async()=>{
    vi.useFakeTimers({toFake:['performance','setTimeout','clearTimeout']});
    try{
      const play=new AdaptivePlay({} as any,'source');play.playMs=179999;play.context={close:async()=>{}} as any;
      play.page={screenshot:()=>new Promise(resolve=>setTimeout(()=>resolve('YQ=='),2))} as any;play.cdp={send:async()=>{}} as any;
      (play as any).beginActive();const failure=expect(play.observe()).rejects.toThrow('180');
      await vi.advanceTimersByTimeAsync(2);await failure;expect(play.playMs).toBe(180000);expect(()=>play.summary()).toThrow('budget');
    }finally{vi.useRealTimers();}
  });
  it('validates timed paths strictly while preserving the legacy drag',()=>{
    const path=[{x:0,y:0,atMs:0,capture:true},{x:359,y:779,atMs:30000}];
    expect(validatePlayActions([{type:'drag',path}],1)).toHaveLength(1);
    expect(validatePlayActions([{type:'drag',x:1,y:2,toX:3,toY:4}],1)).toHaveLength(1);
    for(const bad of [[],[path[0]],[path[0],{...path[1],atMs:0}],[{...path[0],atMs:1},path[1]],[path[0],{...path[1],atMs:30001}],[path[0],{...path[1],capture:1}],[path[0],{...path[1],script:'bad'}],Array.from({length:33},(_,i)=>({x:1,y:1,atMs:i}))])expect(()=>validatePlayActions([{type:'drag',path:bad}],1)).toThrow();
    expect(()=>validatePlayActions([{type:'drag',path,durationMs:30000}],1)).toThrow();
    expect(()=>new AdaptivePlay({} as any,'').recordFirstLook({})).toThrow('初始');
  });
  it('preflights intermediate shots and path duration without side effects',async()=>{
    const play=new AdaptivePlay({} as any,'');play.shots=Array.from({length:11},()=>({label:'x',data:'data:image/jpeg;base64,YQ=='}));
    const action={type:'drag',path:[{x:1,y:1,atMs:0},{x:2,y:2,atMs:1000,capture:true}]};
    await expect(play.act({hypothesis:'curve',actions:[action]})).rejects.toThrow('截图');
    expect(play.actions).toEqual([]);expect(play.rounds).toBe(0);
    play.shots.length=1;play.playMs=179000;
    await expect(play.act({hypothesis:'curve',actions:[action]})).rejects.toThrow('180');
    expect(play.actions).toEqual([]);expect(play.rounds).toBe(0);
  });
  it('captures inside one uninterrupted touch and registers the action first',async()=>{
    const play=new AdaptivePlay({} as any,'');play.shots.push({label:'initial',data:'data:image/jpeg;base64,YQ=='});
    const events:string[]=[];let pressed=false;
    play.context={close:async()=>{}} as any;
    play.cdp={send:async(method:string,args:any)=>{if(method==='Input.dispatchTouchEvent'){events.push(args.type);pressed=args.type!=='touchEnd';}else events.push(method);}} as any;
    play.page={screenshot:async()=>{events.push('shot');if(play.shots.length===1){expect(pressed).toBe(true);expect(play.actions).toHaveLength(1);}return 'YQ==';}} as any;
    try{
      await play.act({hypothesis:'curve',actions:[{type:'drag',path:[{x:1,y:1,atMs:0},{x:2,y:3,atMs:1,capture:true},{x:5,y:8,atMs:2}]}]});
      expect(events.filter(x=>x==='touchStart')).toHaveLength(1);expect(events.filter(x=>x==='touchEnd')).toHaveLength(1);
      expect(events.indexOf('shot')).toBeLessThan(events.indexOf('touchEnd'));
      expect(events.slice(events.indexOf('touchStart'),events.indexOf('touchEnd'))).not.toContain('Debugger.pause');
      expect(play.shots[1].actionRefs).toEqual([1]);expect(play.shots[1].requestedOffsetMs).toBe(1);expect(play.shots[2].actionRefs).toEqual([1]);
      expect(play.actions[0].afterImageId).toBe('supplemental-3');expect(play.actions[0].error).toBe('');
    }finally{await play.close();}
  });
  it('releases the pressed touch and records failures when intermediate capture fails',async()=>{
    const play=new AdaptivePlay({} as any,'');play.shots.push({label:'initial',data:'data:image/jpeg;base64,YQ=='});
    const events:string[]=[];let screenshots=0;
    play.context={close:async()=>{}} as any;play.cdp={send:async(method:string,args:any)=>{if(method==='Input.dispatchTouchEvent')events.push(args.type);}} as any;
    play.page={screenshot:async()=>{if(screenshots++===0)throw new Error('capture failed');return 'YQ==';}} as any;
    try{await play.act({hypothesis:'curve',actions:[{type:'drag',path:[{x:1,y:1,atMs:0,capture:true},{x:2,y:3,atMs:1}]}]});expect(events).toEqual(['touchStart','touchEnd']);expect(play.actions[0].error).toContain('capture failed');}finally{await play.close();}
  });

  it('accepts continuous paths in the server evidence envelope and rejects mismatched capture references',async()=>{
    const path=[{x:1,y:1,atMs:0},{x:2,y:2,atMs:20,capture:true}];
    const probe={captureMethod:'browser-viewport-v2',adaptive:{rounds:1,actionCount:1,playMs:100,modelWaitMs:0,actions:[{type:'drag',path,round:1,hypothesis:'curve',startedAt:new Date().toISOString(),elapsedMs:30}],firstLook:{sourceBlind:true,recordedAt:new Date().toISOString(),observations:'Initial image',uncertainties:[],imageSha256:createHash('sha256').update('a').digest('hex')}}};
    const shots=Array.from({length:6},(_,i)=>({label:'viewport',data:'data:image/jpeg;base64,YQ==',id:i<4?`baseline-${i+1}`:`supplemental-${i-3}`,source:i<4?'isolated-chromium':'member-device',capturedAt:new Date().toISOString(),actionRefs:i===5?[1]:[],...(i===5?{actionOffsetMs:22,requestedOffsetMs:20}:{})}));
    const row={review_mode:'enhanced',model_executor:'agent',report_schema_version:2};
    await expect(validateReviewEvidence(row,probe,shots)).resolves.toBeUndefined();
    shots[5].requestedOffsetMs=19;await expect(validateReviewEvidence(row,probe,shots)).rejects.toThrow('轨迹');shots[5].requestedOffsetMs=20;
    path[1].atMs=0;await expect(validateReviewEvidence(row,probe,shots)).rejects.toThrow('轨迹');
  });

  it('moves a two-point ten-second trajectory by 500ms, reaching the exact endpoint only at its scheduled time',async()=>{
    vi.useFakeTimers({toFake:['performance','setTimeout','clearTimeout']});
    const play=new AdaptivePlay({} as any,'');const moves:{x:number;y:number;at:number}[]=[];const types:string[]=[];
    play.shots.push({label:'initial',data:'data:image/jpeg;base64,YQ=='});play.context={close:async()=>{}} as any;
    play.page={screenshot:async()=> 'YQ=='} as any;
    play.cdp={send:async(method:string,args:any)=>{if(method==='Input.dispatchTouchEvent'){types.push(args.type);if(args.type==='touchMove')moves.push({...args.touchPoints[0],at:performance.now()});}}} as any;
    try{
      const result=play.act({hypothesis:'move gradually',actions:[{type:'drag',path:[{x:20,y:100,atMs:0},{x:320,y:700,atMs:10000}]}]});
      await vi.advanceTimersByTimeAsync(500);
      expect(moves).toHaveLength(10);expect(moves.at(-1)).toMatchObject({x:35,y:130,at:500});expect(types).not.toContain('touchEnd');
      await vi.advanceTimersByTimeAsync(9500);await result;
      expect(moves).toHaveLength(200);expect(moves.at(-1)).toMatchObject({x:320,y:700,at:10000});
      expect(types.filter(x=>x==='touchStart')).toHaveLength(1);expect(types.filter(x=>x==='touchEnd')).toHaveLength(1);
      expect(play.actions[0].trajectoryMethod).toBe('linear-interpolation-50ms-v1');
    }finally{await play.close();vi.useRealTimers();}
  });
  it('interpolates each segment while keeping non-grid captures exact and the absolute schedule after capture overhead',async()=>{
    vi.useFakeTimers({toFake:['performance','setTimeout','clearTimeout']});
    const play=new AdaptivePlay({} as any,'');const moves:{x:number;y:number;at:number}[]=[];let screenshotCount=0;
    play.shots.push({label:'initial',data:'data:image/jpeg;base64,YQ=='});play.context={close:async()=>{}} as any;
    play.page={screenshot:async()=>{if(screenshotCount++===0)await new Promise(r=>setTimeout(r,75));return 'YQ==';}} as any;
    play.cdp={send:async(method:string,args:any)=>{if(method==='Input.dispatchTouchEvent'&&args.type==='touchMove')moves.push({...args.touchPoints[0],at:performance.now()});}} as any;
    try{
      const result=play.act({hypothesis:'curve gradually',actions:[{type:'drag',path:[{x:0,y:0,atMs:0},{x:100,y:0,atMs:125,capture:true},{x:100,y:100,atMs:250}]}]});
      await vi.advanceTimersByTimeAsync(300);await result;
      expect(moves[0]).toMatchObject({x:40,y:0,at:50});expect(moves[1]).toMatchObject({x:80,y:0,at:100});
      expect(moves[2]).toMatchObject({x:100,y:0,at:125});expect(moves.at(-1)).toMatchObject({x:100,y:100,at:250});
      expect(play.shots[1].requestedOffsetMs).toBe(125);expect(play.shots[1].actionOffsetMs).toBe(125);
    }finally{await play.close();vi.useRealTimers();}
  });

  it('bounds a maximum-duration 32-control-point path to at most 631 planned moves',async()=>{
    vi.useFakeTimers({toFake:['performance','setTimeout','clearTimeout']});
    const play=new AdaptivePlay({} as any,'');let count=0,lastAt=0,maxGap=0;
    play.shots.push({label:'initial',data:'data:image/jpeg;base64,YQ=='});play.context={close:async()=>{}} as any;play.page={screenshot:async()=> 'YQ=='} as any;
    play.cdp={send:async(method:string,args:any)=>{if(method==='Input.dispatchTouchEvent'&&args.type==='touchMove'){count++;maxGap=Math.max(maxGap,performance.now()-lastAt);lastAt=performance.now();}}} as any;
    try{
      const path=Array.from({length:32},(_,i)=>({x:i*10,y:i*20,atMs:Math.round(i*30000/31)}));
      const result=play.act({hypothesis:'bounded interpolation',actions:[{type:'drag',path}]});
      await vi.advanceTimersByTimeAsync(30000);await result;
      expect(count).toBeGreaterThanOrEqual(600);expect(count).toBeLessThanOrEqual(631);expect(maxGap).toBeLessThanOrEqual(50);expect(lastAt).toBe(30000);
    }finally{await play.close();vi.useRealTimers();}
  });

});
