export const PLAY_LIMITS={rounds:6,actions:24,playMs:180000,shots:12,idleMs:10*60000};

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

export function validateHarnessPlayRound(value: unknown) {
  const round = value as Record<string, unknown> | null;
  if (!round || typeof round !== 'object' || Array.isArray(round) || Object.keys(round).length !== 2 ||
      !Object.hasOwn(round, 'hypothesis') || !Object.hasOwn(round, 'actions') ||
      typeof round.hypothesis !== 'string' || !round.hypothesis.trim() || round.hypothesis.length > 2000) {
    throw new Error('试玩动作需要明确待验证假设。');
  }
  return validatePlayActions(round.actions, PLAY_LIMITS.actions);
}
