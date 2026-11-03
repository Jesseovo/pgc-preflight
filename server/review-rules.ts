import {canonicalJson,digest,problem,stamp} from './review-device-state';

export type ReviewCalibrationCase={id:string;title:string;evidence:string;score:{aes:number|null;ease:number|null;play:number|null}|null;rationale:string};
export type ReviewRulesSnapshot={schemaVersion:2;id:string;contentHash:string;sourceUrl:string;capturedAt:string;rawDirection:string;rawScoring:string;scoreMin:0;scoreMax:3;passScore:7;notes:string;calibrationCases:ReviewCalibrationCase[];publishedAt:string};
type RuleContent=Omit<ReviewRulesSnapshot,'schemaVersion'|'id'|'contentHash'|'publishedAt'>;
const SOURCE='https://creator-hub-7mi.pages.dev/#/';
const text=(value:unknown,name:string,max:number,optional=false)=>{
  if(optional&&value===undefined)return '';
  if(typeof value!=='string'||(!optional&&!value.trim())||value.length>max)throw problem(`${name} 格式不正确或超长。`);
  return value; // Raw MUST/preference wording is preserved byte for byte.
};
function content(value:any):RuleContent{
  if(!value||typeof value!=='object'||Array.isArray(value))throw problem('规则快照必须是对象。');
  const allowed=['sourceUrl','capturedAt','rawDirection','rawScoring','scoreMin','scoreMax','passScore','notes','calibrationCases'];
  if(Object.keys(value).some(k=>!allowed.includes(k)))throw problem('规则快照包含未知字段；请仅导入规则及明确整理的公开校准案例。');
  if(value.sourceUrl!==SOURCE)throw problem('规则来源必须是指定的 Creator Hub 首页。');
  if(typeof value.capturedAt!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value.capturedAt)||!Number.isFinite(Date.parse(value.capturedAt)))throw problem('capturedAt 必须是有效 ISO 时间。');
  for(const [k,n]of Object.entries({scoreMin:0,scoreMax:3,passScore:7}))if(value[k]!==undefined&&value[k]!==n)throw problem('评分范围必须为 0–3，参考通过分为 7。');
  const rawCases=value.calibrationCases??[];
  if(!Array.isArray(rawCases)||rawCases.length>30)throw problem('校准案例最多 30 份。');
  const cases=rawCases.map((c:any):ReviewCalibrationCase=>{
    if(!c||typeof c!=='object'||Object.keys(c).some(k=>!['id','title','evidence','score','rationale'].includes(k)))throw problem('校准案例只接受明确整理的公开证据、评分与理由，不接收私人审核意见。');
    if(c.score!==null&&(!c.score||typeof c.score!=='object'||Array.isArray(c.score)||Object.keys(c.score).sort().join(',')!=='aes,ease,play'||Object.values(c.score).some(v=>v!==null&&(!Number.isInteger(v)||Number(v)<0||Number(v)>3))))throw problem('案例 score 必须显式为 null 或包含完整三维 0–3 整数 / null 的对象。');
    return {id:text(c.id,'案例编号',100),title:text(c.title,'案例标题',200),evidence:text(c.evidence,'公开证据',12000),score:c.score===null?null:{aes:c.score.aes,ease:c.score.ease,play:c.score.play},rationale:text(c.rationale,'校准理由',6000)};
  });
  if(new Set(cases.map(c=>c.id)).size!==cases.length)throw problem('校准案例编号不能重复。');
  return {sourceUrl:SOURCE,capturedAt:value.capturedAt,rawDirection:text(value.rawDirection,'方向规则',100000),rawScoring:text(value.rawScoring,'评分规则',100000),scoreMin:0,scoreMax:3,passScore:7,notes:text(value.notes,'备注',10000,true),calibrationCases:cases};
}
export function parseReviewRulesSnapshot(input:unknown):ReviewRulesSnapshot{
  const v=typeof input==='string'?JSON.parse(input):input as any;
  if(!v||v.schemaVersion!==2||typeof v.id!=='string'||!v.id||v.id.length>100||typeof v.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(v.contentHash)||typeof v.publishedAt!=='string'||!Number.isFinite(Date.parse(v.publishedAt)))throw problem('已发布规则快照不完整。');
  if(['scoreMin','scoreMax','passScore','notes','calibrationCases'].some(key=>!Object.hasOwn(v,key)))throw problem('已发布规则快照缺少锁定字段。');
  const {schemaVersion,id,contentHash,publishedAt,...rest}=v;
  return {schemaVersion,id,contentHash,publishedAt,...content(rest)};
}
export function validateReviewRulesSnapshot(input:unknown):input is ReviewRulesSnapshot{try{parseReviewRulesSnapshot(input);return true;}catch{return false;}}
function snapshot(row:any){return {schemaVersion:2,id:row.id,contentHash:row.content_hash,...JSON.parse(row.snapshot),publishedAt:row.published_at||null};}
export async function getActiveReviewRules(DB:any):Promise<ReviewRulesSnapshot|null>{
  const row=await DB.prepare('SELECT v.* FROM review_rule_head h JOIN review_rule_versions v ON v.id=h.version_id WHERE h.id=1').first();
  return row?verifiedPublishedRow(row):null;
}
async function verifiedPublishedRow(row:any):Promise<ReviewRulesSnapshot>{
  const rules=parseReviewRulesSnapshot(snapshot(row));
  if(await digest(canonicalJson(content(JSON.parse(row.snapshot))))!==rules.contentHash)throw problem('已发布规则内容哈希校验失败。',409);
  return rules;
}
// Manual imports must name the exact published historical version, never infer
// provenance from whichever version happens to be active at import time.
export async function resolvePublishedReviewRulesSnapshot(DB:any,input:unknown):Promise<ReviewRulesSnapshot>{
  let supplied:ReviewRulesSnapshot;
  try{supplied=parseReviewRulesSnapshot(input);}catch{throw problem('v2 报告需要完整的已发布 rules_snapshot。');}
  const row=await DB.prepare('SELECT * FROM review_rule_versions WHERE id=? AND published_at IS NOT NULL').bind(supplied.id).first();
  if(!row)throw problem('规则版本尚未发布或不存在。',409);
  const published=await verifiedPublishedRow(row);
  if(canonicalJson(supplied)!==canonicalJson(published))throw problem('规则快照与已发布版本不一致。',409);
  return published;
}
export function reviewRulesDiff(active:any,candidate:any){
  const fields=['sourceUrl','capturedAt','rawDirection','rawScoring','scoreMin','scoreMax','passScore','notes','calibrationCases'];
  return fields.filter(field=>canonicalJson(active?.[field]??null)!==canonicalJson(candidate[field])).map(field=>({field,before:active?.[field]??null,after:candidate[field]}));
}
export async function reviewRulesAdmin(request:Request,DB:any){
  const url=new URL(request.url);
  const active=await getActiveReviewRules(DB);
  if(request.method==='GET'){
    const rows=(await DB.prepare('SELECT id,content_hash,created_at,published_at FROM review_rule_versions ORDER BY created_at DESC,id DESC LIMIT 100').all()).results||[];
    const id=url.searchParams.get('id');
    const row=id?await DB.prepare('SELECT * FROM review_rule_versions WHERE id=?').bind(id).first():null;
    if(id&&!row)throw problem('规则版本不存在。',404);
    const candidate=row?snapshot(row):null;
    return {active,history:rows.map((r:any)=>({id:r.id,contentHash:r.content_hash,createdAt:r.created_at,publishedAt:r.published_at})),candidate,diff:candidate?reviewRulesDiff(active,candidate):[]};
  }
  if(request.method!=='POST')throw problem('请使用 GET 或 POST。',405);
  if(!request.headers.get('Content-Type')?.includes('application/json'))throw problem('请使用 JSON。',415);
  if(Number(request.headers.get('Content-Length')||0)>800000)throw problem('规则快照过大。',413);
  const raw=await request.text();if(new TextEncoder().encode(raw).length>800000)throw problem('规则快照过大。',413);
  let b:any;try{b=JSON.parse(raw);}catch{throw problem('规则内容不是合法 JSON。');}
  if(!b||typeof b!=='object'||Array.isArray(b))throw problem('规则操作必须是对象。');
  if(b.action==='import'){
    const data=content(b.snapshot),hash=await digest(canonicalJson(data)),id=crypto.randomUUID(),at=stamp();
    await DB.prepare('INSERT INTO review_rule_versions(id,content_hash,snapshot,created_at) VALUES(?,?,?,?)').bind(id,hash,canonicalJson(data),at).run();
    const candidate={schemaVersion:2,id,contentHash:hash,...data,publishedAt:null};
    return {candidate,active,diff:reviewRulesDiff(active,candidate)};
  }
  if(b.action==='publish'){
    if(typeof b.id!=='string'||!(b.expectedActiveId===null||typeof b.expectedActiveId==='string'))throw problem('发布需要版本编号和 expectedActiveId（首次为 null）。');
    const row=await DB.prepare('SELECT * FROM review_rule_versions WHERE id=?').bind(b.id).first();if(!row)throw problem('规则版本不存在。',404);
    if(active?.id===b.id)return {active};
    if(row.published_at)throw problem('历史发布版本不可重新发布；请导入新草稿。',409);
    const validated=content(JSON.parse(row.snapshot));
    if(await digest(canonicalJson(validated))!==row.content_hash)throw problem('规则草稿哈希校验失败。',409);
    const at=stamp();
    await DB.batch([
      DB.prepare('UPDATE review_rule_versions SET published_at=? WHERE id=? AND published_at IS NULL AND (SELECT version_id FROM review_rule_head WHERE id=1) IS ?').bind(at,b.id,b.expectedActiveId),
      DB.prepare('UPDATE review_rule_head SET version_id=? WHERE id=1 AND version_id IS ? AND EXISTS(SELECT 1 FROM review_rule_versions WHERE id=? AND published_at=?)').bind(b.id,b.expectedActiveId,b.id,at),
    ]);
    const published=await getActiveReviewRules(DB);
    if(published?.id!==b.id)throw problem('活动规则已变化，请重新查看差异后发布。',409);
    return {active:published};
  }
  throw problem('不支持的规则操作。');
}
