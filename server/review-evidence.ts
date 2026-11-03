import {problem} from './review-device-state';

const jpeg=(s:any)=>s&&typeof s.label==='string'&&s.label.length<=500&&typeof s.data==='string'&&/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(s.data);
const integer=(v:any,max:number)=>Number.isInteger(v)&&v>=0&&v<=max;
const timestamp=(v:any)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
// This validates a member's declared evidence envelope, not its authenticity or
// the game's behavior. Only a reviewing model may draw a review conclusion.
export async function validateReviewEvidence(row:any,probe:any,shots:any){
  if(!Array.isArray(shots)||shots.some(s=>!jpeg(s)))throw problem('需要完整浏览器视口 JPEG 截图及采集记录。');
  if(row.review_mode!=='enhanced'){
    if(probe?.captureMethod!=='browser-viewport-v1'||shots.length!==4)throw problem('基础采集需要四张完整浏览器视口截图。');
    return;
  }
  if(row.model_executor!=='agent'||row.report_schema_version!==2||probe?.captureMethod!=='browser-viewport-v2'||shots.length<5||shots.length>16)throw problem('增强取证需要四张基础图及最多十二张补测图。');
  const a=probe.adaptive,f=a?.firstLook;
  if(!a||!integer(a.rounds,6)||!integer(a.actionCount,24)||!integer(a.playMs,180000)||!integer(a.modelWaitMs,86400000)||!Array.isArray(a.actions)||a.actions.length!==a.actionCount)throw problem('增强试玩轮次、动作或实际时长超出边界。');
  if(!f||f.sourceBlind!==true||!timestamp(f.recordedAt)||typeof f.observations!=='string'||!f.observations.trim()||f.observations.length>5000||!Array.isArray(f.uncertainties)||f.uncertainties.length>20||f.uncertainties.some((v:any)=>typeof v!=='string'||v.length>1000))throw problem('缺少未披露源码时的首次上手观察。');
  for(let i=0;i<shots.length;i++){
    const s=shots[i],supplement=i>=4;
    if(s.id!==`${supplement?'supplemental':'baseline'}-${supplement?i-3:i+1}`||!timestamp(s.capturedAt)||s.source!==(supplement?'member-device':'isolated-chromium')||!Array.isArray(s.actionRefs)||s.actionRefs.some((ref:any)=>supplement?(!Number.isInteger(ref)||ref<1||ref>a.actionCount):(typeof ref!=='string'||!/^baseline-9:(16|19\.5|21)-tap$/.test(ref))))throw problem('每张原图需要明确的编号、采集时间、来源和动作关联。');
  }
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(shots[4].data.split(',')[1]),c=>c.charCodeAt(0))))).map(v=>v.toString(16).padStart(2,'0')).join('');
  if(f.imageSha256!==hash)throw problem('首次上手观察没有关联原始截图。');
  let elapsed=0,previousRound=0;
  for(const action of a.actions){
    if(!action||!['tap','drag','hold','multi-touch','wait','restart'].includes(action.type)||!Number.isInteger(action.round)||action.round<1||action.round>a.rounds||action.round<previousRound||typeof action.hypothesis!=='string'||!action.hypothesis.trim()||action.hypothesis.length>2000||!timestamp(action.startedAt)||!integer(action.elapsedMs,180000))throw problem('补测动作记录不完整。');
    const point=(p:any)=>p&&Number.isFinite(p.x)&&p.x>=0&&p.x<360&&Number.isFinite(p.y)&&p.y>=0&&p.y<780;
    if(['tap','hold'].includes(action.type)&&!point(action)||action.type==='drag'&&action.path===undefined&&(!point(action)||!point({x:action.toX,y:action.toY}))||action.type==='multi-touch'&&(!Array.isArray(action.points)||action.points.length<2||action.points.length>5||action.points.some((p:any)=>!point(p))))throw problem('补测动作坐标越界。');
    if(action.path!==undefined&&(action.type!=='drag'||['x','y','toX','toY','durationMs'].some(k=>k in action)||!Array.isArray(action.path)||action.path.length<2||action.path.length>32||action.path.some((p:any,i:number)=>!point(p)||!integer(p.atMs,30000)||(i===0?p.atMs!==0:p.atMs<=action.path[i-1].atMs)||p.capture!==undefined&&typeof p.capture!=='boolean'||Object.keys(p).some(k=>!['x','y','atMs','capture'].includes(k)))))throw problem('补测连续轨迹格式或时间越界。');
    if(action.durationMs!==undefined&&!integer(action.durationMs,30000))throw problem('补测动作时长越界。');
    elapsed+=action.elapsedMs;previousRound=action.round;
  }
  for(const shot of shots.slice(4)){
    if(shot.actionOffsetMs!==undefined||shot.requestedOffsetMs!==undefined){
      const action=a.actions[shot.actionRefs[0]-1];
      if(shot.actionRefs.length!==1||!integer(shot.actionOffsetMs,180000)||!integer(shot.requestedOffsetMs,30000)||action?.type!=='drag'||!action.path?.some((p:any)=>p.capture===true&&p.atMs===shot.requestedOffsetMs))throw problem('连续触摸截图需要关联对应动作及轨迹采集时间点。');
    }
  }
  if(elapsed>a.playMs)throw problem('补测实际时长与动作记录不一致。');
}
