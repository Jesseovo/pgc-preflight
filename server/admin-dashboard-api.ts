import {explicitWindow} from './admin-time-window';
import {identity} from './members';
import {memberStore} from './storage';
import {problem} from './review-device-state';
import {artifactColumns} from './forge-workspace';
import {scheduleForgeTask,type ForgeTask} from './forge-tasks';
import type {AdminDashboard,AdminMaterial,AdminMemberOption,AdminPage,AdminProject,AdminProjectDetail,AdminRange,AdminTask,AdminTaskDetail,AdminVersion,MaterialKind} from '../src/admin/contracts';

const all=async(DB:any,sql:string,...p:any[]):Promise<any[]> => (await DB.prepare(sql).bind(...p).all()).results||[];
const first=(DB:any,sql:string,...p:any[]):Promise<any> => DB.prepare(sql).bind(...p).first();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const at=()=>new Date().toISOString();
const kindLabels:Record<string,string>={expand:'扩写',game:'游戏制作',preview:'样板图',brief:'简报',assets:'美术资产',suggest:'补词建议',tag:'作品标签',review:'AI 审核'};
const projectLabels:Record<string,string>={product:'已有成品',working:'创作中',error:'需要处理',unselected:'未入选',archived:'已移出',selected:'待制作'};
const activeSql="status IN ('queued','running','pending','capture','review','verify')";
const activeTaskProjection=`WITH active_tasks AS (
 SELECT id,owner_id,kind,executor,status,updated_at FROM forge_tasks WHERE ${activeSql}
 UNION ALL
 SELECT id,owner_id,'review' kind,CASE WHEN model_executor='agent' THEN 'agent' ELSE 'platform' END executor,status,updated_at FROM review_jobs WHERE ${activeSql}
)`;
const terminal=(status:string)=>['done','error','failed','cancelled','expired'].includes(status);
const safeJson=(value:string|null|undefined)=>{try{return JSON.parse(value||'{}');}catch{return {};}};
const text=(value:unknown,max=300)=>typeof value==='string'?value.slice(0,max):'';
function taskStatusLabel(r:any):string {
  return r.executor==='agent'&&!terminal(r.status)?'等待 Agent':({queued:'排队中',running:'执行中',pending:'待执行',capture:'采集证据',review:'审核中',verify:'复核中',done:'已完成',error:'失败',failed:'失败',expired:'已过期',cancelled:'已取消'} as Record<string,string>)[r.status]||r.status;
}

// Calendar ranges start at midnight in Beijing; ISO comparisons use UTC on both sides.
export function adminDateBounds(range:AdminRange,now=Date.now()):[string,string]|null {
  if(range==='all')return null;
  const day=86400000,midnight=Math.floor((now+8*3600000)/day)*day-8*3600000;
  return [new Date(midnight-({'today':1,'7d':7,'30d':30}[range]-1)*day).toISOString(),new Date(midnight+day).toISOString()];
}
function rangeValue(value:string|null,allowAll=true):AdminRange {
  if(value&&['today','7d','30d',...(allowAll?['all']:[])].includes(value))return value as AdminRange;
  if(value)throw problem('日期范围不正确。');
  return allowAll?'all':'7d';
}
function paging(p:URLSearchParams){
  const parse=(v:string|null,fallback:number,max:number)=>{if(v===null)return fallback;const n=Number(v);if(!Number.isInteger(n)||n<1||n>max)throw problem('分页参数不正确。');return n;};
  return {page:parse(p.get('page'),1,1000000),pageSize:parse(p.get('pageSize'),24,100)};
}
function filters(p:URLSearchParams,column='updated_at',allowAll=true){
  const clauses:string[]=[],params:any[]=[],owner=p.get('owner')||'',bounds=explicitWindow(p)||adminDateBounds(rangeValue(p.get('range'),allowAll));
  if(owner){clauses.push('owner_id=?');params.push(owner);}
  if(bounds){clauses.push(`${column}>=? AND ${column}<?`);params.push(...bounds);}
  return {clauses,params};
}
async function memberOptions(DB:any):Promise<AdminMemberOption[]> {
  return (await all(DB,'SELECT id,display_name,username,enabled,star FROM members ORDER BY display_name,id')).map(m=>({id:m.id,displayName:m.display_name,username:m.username,enabled:!!m.enabled,star:!!m.star}));
}

const topicIdSql="CASE WHEN json_valid(f.payload) THEN COALESCE(json_extract(f.payload,'$.id'),json_extract(f.payload,'$.ids[0]')) END";
// Unary + on the correlated topic ID removes INTEGER affinity, allowing SQLite
// to seek the matching JSON expression index rather than scan an owner's tasks.
const taskProjection=`WITH task_meta AS (
 SELECT f.id,'creation' AS type,f.kind,f.owner_id,COALESCE(m.display_name,CASE WHEN f.owner_id='admin' THEN '历史管理员档案' ELSE '已移除成员' END) owner_name,
 ${topicIdSql} project_id,CASE WHEN f.kind IN ('expand','game','preview','brief','assets') THEN 'topic' ELSE NULL END project_type,
 COALESCE(CASE WHEN json_valid(t.data) THEN json_extract(t.data,'$.title') END,t.subject,'') title,
 f.executor,f.status,f.detail,f.error,f.created_at,f.updated_at,f.started_at,NULL result_id,f.retry_of,f.requested_by,
 (CASE WHEN json_valid(f.input_snapshot) THEN json_type(f.input_snapshot,'$.cfg')='object' AND (f.kind NOT IN ('expand','game','preview','brief','assets') OR (t.id IS NOT NULL AND json_extract(f.input_snapshot,'$.topic.id')=t.id AND json_extract(f.input_snapshot,'$.topic.owner_id')=f.owner_id)) ELSE 0 END) source_available,
 CASE WHEN f.owner_id='admin' OR (m.enabled=1 AND m.star=1) THEN 1 ELSE 0 END owner_eligible
 FROM forge_tasks f LEFT JOIN members m ON m.id=f.owner_id
 LEFT JOIN topics t ON t.id=${topicIdSql} AND t.owner_id=f.owner_id AND f.kind IN ('expand','game','preview','brief','assets')
 UNION ALL
 SELECT r.id,'review','review',r.owner_id,COALESCE(m.display_name,CASE WHEN r.owner_id='admin' THEN '超级管理员' ELSE '已移除成员' END),
 COALESCE(r.topic_id,v.topic_id),CASE WHEN COALESCE(r.topic_id,v.topic_id) IS NOT NULL THEN 'topic' ELSE NULL END,r.title,
 CASE WHEN r.model_executor='agent' THEN 'agent' ELSE 'platform' END,r.status,
 CASE WHEN r.model_executor='agent' AND r.status NOT IN ('done','error') THEN '等待成员 Agent 回传' ELSE r.stage END,r.error,r.created_at,r.updated_at,r.model_started_at,r.result_id,NULL,NULL,
 (r.input_ready=1 AND EXISTS(SELECT 1 FROM review_inputs i WHERE i.job_id=r.id)),1
 FROM review_jobs r LEFT JOIN members m ON m.id=r.owner_id LEFT JOIN reviews v ON v.id=r.result_id AND v.owner_id=r.owner_id
)`;
function taskDto(r:any):AdminTask {
  const agent=r.executor==='agent',failed=r.status==='error',source=!!r.source_available,supported=['expand','brief','preview','assets','game','suggest','tag'].includes(r.kind);
  let retryReason='';
  if(r.type==='review')retryReason=source?'请重新上传文件并发起审核。':'原始审核文件已清理，请重新上传文件。';
  else if(agent)retryReason='Agent 任务请由原成员的 Agent 继续处理。';
  else if(!supported)retryReason='此任务请重新提交。';
  else if(!failed)retryReason='只有失败的平台任务可以重试。';
  else if(!source)retryReason='原始创作输入已不存在，无法重试。';
  else if(!r.owner_eligible)retryReason='成员已停用或 Star 权限已撤销。';
  const statusLabel=taskStatusLabel(r);
  return {id:r.id,type:r.type,kind:r.kind,kindLabel:kindLabels[r.kind]||r.kind,ownerId:r.owner_id,ownerName:r.owner_name,projectId:r.project_type?r.project_id:null,projectType:r.project_type,title:text(r.title,160)||kindLabels[r.kind]||r.kind,executor:agent?'agent':'platform',status:r.status,statusLabel,detail:text(r.detail,700),error:text(r.error,700),createdAt:r.created_at,updatedAt:r.updated_at,startedAt:r.started_at||null,resultId:r.result_id||null,canRetry:r.type==='creation'&&supported&&failed&&!agent&&source&&!!r.owner_eligible,retryReason,retryOf:r.retry_of||null,requestedBy:r.requested_by||null};
}

const projectProjection=`WITH project_meta AS (
 SELECT t.id,'topic' type,t.owner_id,COALESCE(m.display_name,CASE WHEN t.owner_id='admin' THEN '历史管理员档案' ELSE '已移除成员' END) owner_name,
 COALESCE(CASE WHEN json_valid(t.data) THEN json_extract(t.data,'$.title') END,t.subject,'未命名选题') title,t.subject,
 COALESCE(CASE WHEN json_valid(t.data) THEN COALESCE(json_extract(t.data,'$.logline'),json_extract(t.data,'$.core_loop')) END,'') summary,
 t.status original_status,t.created_at,t.updated_at,
 (json_valid(t.data) AND json_extract(CASE WHEN json_valid(t.data) THEN t.data ELSE '{}' END,'$.title') IS NOT NULL) has_expand,
 (t.product_html IS NOT NULL AND trim(t.product_html)<>'') has_game,(t.preview_svg IS NOT NULL AND trim(t.preview_svg)<>'') has_preview,
 (t.brief_md IS NOT NULL AND trim(t.brief_md)<>'') has_brief,(t.assets_html IS NOT NULL AND trim(t.assets_html)<>'') has_assets,
 (SELECT count(*) FROM forge_tasks f WHERE f.owner_id=t.owner_id AND ${topicIdSql}=+t.id AND f.kind IN ('expand','game','preview','brief','assets') AND f.executor='platform' AND f.status IN ('queued','running')) active_tasks,
 (SELECT count(*) FROM forge_tasks f WHERE f.owner_id=t.owner_id AND ${topicIdSql}=+t.id AND f.kind IN ('expand','game','preview','brief','assets') AND f.executor='agent' AND f.status IN ('queued','running')) waiting_tasks,
 (SELECT count(*) FROM forge_tasks f WHERE f.owner_id=t.owner_id AND ${topicIdSql}=+t.id AND f.kind IN ('expand','game','preview','brief','assets') AND f.status='error') failed_tasks,
 (t.expand_status='error' OR t.brief_status='error' OR t.assets_status='error' OR t.product_status='error' OR EXISTS(SELECT 1 FROM forge_tasks f WHERE f.owner_id=t.owner_id AND ${topicIdSql}=+t.id AND f.kind IN ('expand','game','preview','brief','assets') AND f.status='error')) has_error
 FROM topics t LEFT JOIN members m ON m.id=t.owner_id
 UNION ALL
 SELECT g.id,'game',g.owner_id,COALESCE(m.display_name,CASE WHEN g.owner_id='admin' THEN '历史管理员档案' ELSE '已移除成员' END),g.title,g.subject,g.descr,g.status,NULL,COALESCE(g.updated_at,''),0,0,0,0,0,0,0,0,0
 FROM games g LEFT JOIN members m ON m.id=g.owner_id
), projects AS (SELECT *,CASE WHEN type='game' THEN 'historical' WHEN original_status IN ('rejected','archived','dismissed') THEN 'archived' WHEN active_tasks+waiting_tasks>0 THEN 'working' WHEN has_error THEN 'error' WHEN has_game THEN 'product' WHEN original_status IN ('drawn','new','dup') THEN 'unselected' ELSE 'selected' END status FROM project_meta)`;
function projectDto(r:any):AdminProject {
  return {id:r.id,type:r.type,ownerId:r.owner_id,ownerName:r.owner_name,title:text(r.title,160),subject:text(r.subject,200),summary:text(r.summary),status:r.status,statusLabel:r.type==='game'?'历史导入':projectLabels[r.status]||r.status,updatedAt:r.updated_at,createdAt:r.created_at||null,materials:{expand:!!r.has_expand,game:!!r.has_game,preview:!!r.has_preview,brief:!!r.has_brief,assets:!!r.has_assets},thumbnailUrl:r.has_preview?`/api/admin/projects/topic/${r.id}/material/preview/thumbnail`:null,activeTasks:r.active_tasks,failedTasks:r.failed_tasks};
}
async function projectRow(DB:any,type:string,id:number){
  const row=await first(DB,`${projectProjection} SELECT * FROM projects WHERE type=? AND id=?`,type,id);
  if(!row)throw problem('作品不存在。',404);return row;
}
async function projectPage(DB:any,p:URLSearchParams):Promise<AdminPage<AdminProject>> {
  const firstProducts=p.get('firstProducts')==='1',dateFilters=new URLSearchParams(p);if(firstProducts){dateFilters.set('range','all');dateFilters.delete('from');dateFilters.delete('to');}
  const {clauses,params}=filters(dateFilters),{page,pageSize}=paging(p),status=p.get('status')||'all',type=p.get('type')||'all',q=(p.get('q')||'').trim().slice(0,200);
  if(firstProducts){
    const bounds=explicitWindow(p)||adminDateBounds(rangeValue(p.get('range')));
    clauses.push("type='topic' AND has_game=1 AND EXISTS(SELECT 1 FROM artifact_versions v WHERE v.owner_id=projects.owner_id AND v.topic_id=projects.id AND v.kind='game' AND v.disposition<>'pending')");
    if(bounds){clauses.push("(SELECT min(v.created_at) FROM artifact_versions v WHERE v.owner_id=projects.owner_id AND v.topic_id=projects.id AND v.kind='game' AND v.disposition<>'pending')>=? AND (SELECT min(v.created_at) FROM artifact_versions v WHERE v.owner_id=projects.owner_id AND v.topic_id=projects.id AND v.kind='game' AND v.disposition<>'pending')<?");params.push(...bounds);}
  }
  if(!['all','product','working','error','unselected','archived','selected'].includes(status)||!['all','topic','game'].includes(type))throw problem('作品筛选条件不正确。');
  if(status==='product')clauses.push('has_game=1');
  else if(status!=='all'){clauses.push('status=?');params.push(status);}if(type!=='all'){clauses.push('type=?');params.push(type);}
  if(q){clauses.push("(instr(lower(title),lower(?))>0 OR instr(lower(subject),lower(?))>0 OR instr(lower(summary),lower(?))>0)");params.push(q,q,q);}
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'',base=`${projectProjection} SELECT * FROM projects ${where}`;
  const [counts,items,members]=await Promise.all([first(DB,`${projectProjection} SELECT count(*) total,COALESCE(sum(active_tasks),0) active_count,COALESCE(sum(waiting_tasks),0) waiting_count FROM projects ${where}`,...params),all(DB,`${base} ORDER BY updated_at DESC,type,id DESC LIMIT ? OFFSET ?`,...params,pageSize,(page-1)*pageSize),memberOptions(DB)]);
  return {items:items.map(projectDto),total:counts.total,page,pageSize,members,updatedAt:at(),activeCount:counts.active_count,waitingAgentCount:counts.waiting_count};
}
function taskWhere(p:URLSearchParams){
  const f=filters(p,'updated_at'),status=p.get('status')||'all',type=p.get('type')||'all',q=(p.get('q')||'').trim().slice(0,200),project=p.get('project');
  if(!['all','creation','review'].includes(type))throw problem('任务类型不正确。');if(type!=='all'){f.clauses.push('type=?');f.params.push(type);}
  if(['platform-queued','platform-running','agent-queued','agent-running'].includes(status)){const [executor,stage]=status.split('-');f.clauses.push(`executor=? AND ${activeSql} AND status ${stage==='queued'?'IN':'NOT IN'} ('queued','pending')`);f.params.push(executor);}
  else if(status==='active')f.clauses.push(`executor='platform' AND ${activeSql}`);
  else if(['waiting-agent','waiting_agent','agent'].includes(status))f.clauses.push(`executor='agent' AND ${activeSql}`);
  else if(status!=='all'){if(!['queued','running','pending','capture','review','verify','done','error','failed','expired','cancelled'].includes(status))throw problem('任务状态不正确。');f.clauses.push('status=?');f.params.push(status);}
  if(project){if(!/^\d+$/.test(project))throw problem('作品编号不正确。');f.clauses.push("project_type='topic' AND project_id=?");f.params.push(Number(project));}
  if(q){f.clauses.push('(instr(lower(title),lower(?))>0 OR instr(lower(id),lower(?))>0)');f.params.push(q,q);}
  return {...f,where:f.clauses.length?`WHERE ${f.clauses.join(' AND ')}`:''};
}
async function taskPage(DB:any,p:URLSearchParams):Promise<AdminPage<AdminTask>> {
  const {where,params}=taskWhere(p),{page,pageSize}=paging(p);
  const [counts,rows,members]=await Promise.all([first(DB,`${taskProjection} SELECT count(*) total,COALESCE(sum(executor='platform' AND ${activeSql}),0) active_count,COALESCE(sum(executor='agent' AND ${activeSql}),0) waiting_count FROM task_meta ${where}`,...params),all(DB,`${taskProjection} SELECT * FROM task_meta ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,...params,pageSize,(page-1)*pageSize),memberOptions(DB)]);
  return {items:rows.map(taskDto),total:counts.total,page,pageSize,members,updatedAt:at(),activeCount:counts.active_count,waitingAgentCount:counts.waiting_count};
}
async function taskDetail(DB:any,type:string,id:string):Promise<AdminTaskDetail> {
  const row=await first(DB,`${taskProjection} SELECT * FROM task_meta WHERE type=? AND id=?`,type,id);if(!row)throw problem('任务不存在。',404);
  const retry=row.type==='creation'?await first(DB,'SELECT id FROM forge_tasks WHERE retry_of=?',id):null;
  return {task:taskDto(row),retryTaskId:retry?.id||null,sourceAvailable:!!row.source_available,continuePrompt:row.executor==='agent'&&!terminal(row.status)?row.type==='creation'?`请继续原创作任务 ${id}，沿用原设备授权和任务回执，读取当前状态并完成结果回传，不要新建任务。`:`请继续原审核任务 ${id}，沿用原设备授权和租约，完成材料读取、初评、同模型复核及结果回传，不要新建审核任务。`:null};
}
async function projectDetail(DB:any,type:string,id:number):Promise<AdminProjectDetail> {
  const row=await projectRow(DB,type,id),project=projectDto(row);
  if(type==='game'){
    const game=await first(DB,'SELECT ext_id,descr,status,score,aes,ease,play,revisions,feedback,medium,gesture,structure,mood,source,is_public FROM games WHERE id=?',id);
    return {project,overview:game,versions:[],relatedReviews:[]};
  }
  const fields=['title','logline','summary','twist','core_loop','controls','art_direction','progression','audio','why_addictive','risks','genre','mechanic','color_palette'];
  const topic=await first(DB,`SELECT subject,medium,gesture,structure,mood,score,origin,requirements,note,content_revision,${fields.map(k=>`CASE WHEN json_valid(data) THEN json_extract(data,'$.${k}') END ${k}`).join(',')} FROM topics WHERE id=?`,id);
  const [versions,reviews,heads,policy]=await Promise.all([all(DB,'SELECT id,kind,executor,model,disposition,input_versions,policy_revision,restored_from,created_at FROM artifact_versions WHERE topic_id=? AND owner_id=? ORDER BY created_at DESC,id DESC',id,row.owner_id),all(DB,'SELECT id,title,score,created_at FROM reviews WHERE topic_id=? AND owner_id=? ORDER BY created_at DESC,id DESC',id,row.owner_id),all(DB,'SELECT kind,version_id FROM artifact_heads WHERE topic_id=?',id),first(DB,'SELECT revision FROM workspace_policy_revision WHERE id=1')]);
  const current=Object.fromEntries(heads.map(h=>[h.kind,h.version_id])),deps:Record<string,string[]>={expand:[],brief:['expand'],preview:['expand','brief'],assets:['expand','brief','preview'],game:['expand','brief','preview','assets']};
  return {project,overview:topic,versions:versions.map((v:any):AdminVersion=>({id:v.id,kind:v.kind,created_at:v.created_at,executor:v.executor,model:v.model||'',current:current[v.kind]===v.id,disposition:v.disposition,restored_from:v.restored_from,stale:v.policy_revision!==policy.revision||(deps[v.kind]||[]).some(k=>(safeJson(v.input_versions)[k]||null)!==(current[k]||null))})),relatedReviews:reviews.map(r=>({id:r.id,title:r.title,score:r.score,createdAt:r.created_at}))};
}

const sandbox="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'";
async function material(DB:any,url:URL,type:string,id:number,kind:MaterialKind,action?:string):Promise<Response> {
  const row=await projectRow(DB,type,id);if(type!=='topic')throw problem('历史导入作品不包含平台创作材料。',404);
  const version=url.searchParams.get('version');let source:any;
  if(version)source=await first(DB,'SELECT id,content FROM artifact_versions WHERE id=? AND owner_id=? AND topic_id=? AND kind=?',version,row.owner_id,id,kind);
  else source=await first(DB,`SELECT ${artifactColumns[kind]} content,(SELECT version_id FROM artifact_heads WHERE topic_id=topics.id AND kind=?) id FROM topics WHERE id=? AND owner_id=?`,kind,id,row.owner_id);
  const available=!!source?.content?.trim()&&(kind!=='expand'||!!safeJson(source.content).title);
  if(!available){if(action||version)throw problem('材料或版本不存在。',404);return json({kind,available:false} satisfies AdminMaterial);}
  const content=String(source.content),query=version?`?version=${encodeURIComponent(version)}`:'',base=`/api/admin/projects/topic/${id}/material/${kind}`;
  if(action==='thumbnail'){
    if(kind!=='preview')throw problem('此材料没有缩略图。',404);
    return new Response(content,{headers:{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:;"}});
  }
  if(action==='preview'){
    if(!['preview','game','assets'].includes(kind))throw problem('此材料没有可视预览。');
    const html=kind==='preview'?`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#f8faf7;display:grid;place-items:center}img{display:block;max-width:100%;max-height:100vh}</style></head><body><img alt="风格样板" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}"></body></html>`:content;
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':sandbox}});
  }
  if(action==='file'){
    const ext=kind==='preview'?'svg':kind==='brief'?'md':kind==='expand'?'json':'html',filename=`${text(row.title,80)||'pgc'}-${kind}.${ext}`;
    return new Response(content,{headers:{'Content-Type':ext==='svg'?'image/svg+xml; charset=utf-8':ext==='html'?'text/html; charset=utf-8':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="pgc-${kind}.${ext}"; filename*=UTF-8''${encodeURIComponent(filename)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':'sandbox'}});
  }
  if(action)throw problem('接口不存在。',404);
  const result:AdminMaterial={kind,available:true,downloadUrl:`${base}/file${query}`,versionId:source.id||undefined};
  if(['preview','game','assets'].includes(kind))result.previewUrl=`${base}/preview${query}`;
  if(kind==='expand'||kind==='brief'||url.searchParams.get('raw')==='1')result.content=content;
  return json(result);
}

async function retryCreation(env:any,id:string):Promise<AdminTask> {
  const DB=env.DB,row:ForgeTask&{retry_of?:string}=await first(DB,'SELECT * FROM forge_tasks WHERE id=?',id);if(!row)throw problem('任务不存在。',404);
  const prior=await first(DB,'SELECT id FROM forge_tasks WHERE retry_of=?',id);if(prior)return (await taskDetail(DB,'creation',prior.id)).task;
  if(row.executor!=='platform'||row.status!=='error')throw problem('只能重试失败的平台创作任务。',409);
  const detail=await taskDetail(DB,'creation',id);if(!detail.task.canRetry)throw problem(detail.task.retryReason,409);
  if(!env.FORGE_RUNNER)throw problem('后台创作服务尚未就绪。',503);
  const snapshot=safeJson(row.input_snapshot),job=safeJson(row.payload),owner=row.owner_id||'admin',newId=crypto.randomUUID(),stamp=at();
  if(!snapshot.cfg||!job.type||job.type!==row.kind||!['expand','brief','preview','assets','game','suggest','tag'].includes(job.type))throw problem('原始创作输入不完整，无法重试。',409);
  const topicId=job.type==='expand'?job.ids?.[0]:job.id;
  if(artifactColumns[job.type]&&(!snapshot.topic||Number(snapshot.topic.id)!==Number(topicId)||snapshot.topic.owner_id!==owner))throw problem('原始创作输入的所属成员不匹配。',409);
  // requestId is an execution/idempotency identity, not a creation input.
  const payload=job.type==='game'?JSON.stringify({...job,requestId:newId}):row.payload;
  const topicGuard=artifactColumns[job.type]?' AND EXISTS(SELECT 1 FROM topics WHERE id=? AND owner_id=?)':'';
  const insert=DB.prepare(`INSERT OR IGNORE INTO forge_tasks(id,kind,scope,payload,status,detail,created_at,updated_at,owner_id,executor,input_snapshot,retry_of,requested_by) SELECT ?,kind,scope,?,'queued','等待后台执行…',?,?,owner_id,'platform',input_snapshot,id,'admin' FROM forge_tasks WHERE id=? AND status='error' AND executor='platform' AND NOT EXISTS(SELECT 1 FROM forge_tasks WHERE retry_of=?) AND (owner_id='admin' OR EXISTS(SELECT 1 FROM members m WHERE m.id=forge_tasks.owner_id AND m.enabled=1 AND m.star=1))${topicGuard}`).bind(newId,payload,stamp,stamp,id,id,...(topicGuard?[topicId,owner]:[]));
  const statements=[insert];
  if(['expand','brief','assets','game'].includes(job.type)){
    const column=job.type==='game'?'product':job.type;
    statements.push(DB.prepare(`UPDATE topics SET ${column}_status=?,${column}_error='等待后台执行…',updated_at=?${job.type==='game'?',product_request_id=?':''} WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM forge_tasks WHERE id=? AND status='queued')`).bind(job.type==='game'?'queued':'running',stamp,...(job.type==='game'?[newId]:[]),topicId,owner,newId));
  }
  await DB.batch(statements);
  const retry=await first(DB,"SELECT * FROM forge_tasks WHERE retry_of=? OR (scope=? AND status IN ('queued','running')) ORDER BY CASE WHEN retry_of=? THEN 0 ELSE 1 END,created_at DESC LIMIT 1",id,row.scope,id);
  if(!retry)throw problem('重试未创建，请刷新后再试。',409);
  if(retry.retry_of===id)await scheduleForgeTask(env,retry);
  return (await taskDetail(DB,'creation',retry.id)).task;
}

async function dashboard(DB:any,p:URLSearchParams):Promise<AdminDashboard> {
  const range=rangeValue(p.get('range'),false),owner=p.get('owner')||'',bounds=adminDateBounds(range)!,params=[bounds[0],bounds[1],owner,owner];
  const [members,creationCounts,reviewCounts,productCounts,activeCounts,active,attention,products]=await Promise.all([
    memberOptions(DB),
    all(DB,"SELECT owner_id,sum(status='done' AND updated_at>=? AND updated_at<?) n,max(updated_at) last_activity FROM forge_tasks WHERE (?='' OR owner_id=?) GROUP BY owner_id",...params),
    all(DB,"SELECT owner_id,sum(status='done' AND updated_at>=? AND updated_at<?) n,max(updated_at) last_activity FROM review_jobs WHERE (?='' OR owner_id=?) GROUP BY owner_id",...params),
    all(DB,"SELECT owner_id,count(*) n FROM (SELECT v.owner_id,v.topic_id,min(v.created_at) first_at FROM artifact_versions v JOIN topics t ON t.id=v.topic_id AND t.owner_id=v.owner_id AND t.product_html IS NOT NULL AND trim(t.product_html)<>'' WHERE v.kind='game' AND v.disposition<>'pending' GROUP BY v.owner_id,v.topic_id) WHERE first_at>=? AND first_at<? AND (?='' OR owner_id=?) GROUP BY owner_id",...params),
    all(DB,`${activeTaskProjection} SELECT owner_id,sum(executor='platform') platform_count,sum(executor='agent') agent_count FROM active_tasks WHERE (?='' OR owner_id=?) GROUP BY owner_id`,owner,owner),
    all(DB,`${activeTaskProjection}, active_ranked AS (SELECT owner_id,kind,executor,status,updated_at,row_number() OVER(PARTITION BY owner_id ORDER BY CASE WHEN executor='platform' THEN 0 ELSE 1 END,updated_at DESC,id DESC) member_rank FROM active_tasks WHERE (?='' OR owner_id=?)) SELECT owner_id,kind,executor,status,updated_at FROM active_ranked WHERE member_rank=1 ORDER BY CASE WHEN executor='platform' THEN 0 ELSE 1 END,updated_at DESC`,owner,owner),
    all(DB,`${taskProjection} SELECT * FROM task_meta WHERE status='error' AND updated_at>=? AND updated_at<? AND (?='' OR owner_id=?) ORDER BY updated_at DESC LIMIT 8`,...params),
    all(DB,`${projectProjection}, first_products AS (SELECT owner_id,topic_id,min(created_at) first_at FROM artifact_versions WHERE kind='game' AND disposition<>'pending' GROUP BY owner_id,topic_id) SELECT p.* FROM projects p JOIN first_products f ON p.type='topic' AND f.topic_id=p.id AND f.owner_id=p.owner_id WHERE p.has_game=1 AND f.first_at>=? AND f.first_at<? AND (?='' OR p.owner_id=?) ORDER BY f.first_at DESC,p.id DESC LIMIT 6`,...params),
  ]);
  const step=range==='today'?3600000:86400000,start=Date.parse(bounds[0]);
  const [productTrend,reviewTrend,taskStates]=await Promise.all([
    all(DB,`SELECT CAST((CAST(strftime('%s',first_at) AS INTEGER)*1000-?)/? AS INTEGER) bucket,count(*) n FROM (SELECT v.owner_id,v.topic_id,min(v.created_at) first_at FROM artifact_versions v JOIN topics t ON t.id=v.topic_id AND t.owner_id=v.owner_id AND t.product_html IS NOT NULL AND trim(t.product_html)<>'' WHERE v.kind='game' AND v.disposition<>'pending' GROUP BY v.owner_id,v.topic_id) WHERE first_at>=? AND first_at<? AND (?='' OR owner_id=?) GROUP BY bucket`,start,step,...params),
    all(DB,`SELECT CAST((CAST(strftime('%s',updated_at) AS INTEGER)*1000-?)/? AS INTEGER) bucket,count(*) n FROM review_jobs WHERE status='done' AND updated_at>=? AND updated_at<? AND (?='' OR owner_id=?) GROUP BY bucket`,start,step,...params),
    all(DB,`${activeTaskProjection} SELECT executor,CASE WHEN status IN ('queued','pending') THEN 'queued' ELSE 'running' END stage,count(*) n FROM active_tasks WHERE (?='' OR owner_id=?) GROUP BY executor,stage`,owner,owner),
  ]);
  const trend=Array.from({length:Math.round((Date.parse(bounds[1])-start)/step)},(_,i)=>({from:new Date(start+i*step).toISOString(),to:new Date(start+(i+1)*step).toISOString(),products:productTrend.find(r=>r.bucket===i)?.n||0,reviews:reviewTrend.find(r=>r.bucket===i)?.n||0}));
  const taskGroups=['platform-queued','platform-running','agent-queued','agent-running'].map(key=>({key,count:taskStates.find(r=>r.executor+'-'+r.stage===key)?.n||0}));
  const failures=await first(DB,`${taskProjection} SELECT count(*) n FROM task_meta WHERE status='error' AND updated_at>=? AND updated_at<? AND (?='' OR owner_id=?)`,...params);
  const byOwner=(rows:any[],id:string)=>rows.find(r=>r.owner_id===id),progress=members.filter(m=>!owner||m.id===owner).map(m=>{
    const creations=byOwner(creationCounts,m.id),reviews=byOwner(reviewCounts,m.id),counts=byOwner(activeCounts,m.id),current=active.find(t=>t.owner_id===m.id),last=[creations?.last_activity,reviews?.last_activity,current?.updated_at].filter(Boolean).sort().at(-1)||null;
    return {id:m.id,displayName:m.displayName,username:m.username,star:m.star,enabled:m.enabled,creations:creations?.n||0,reviews:reviews?.n||0,products:byOwner(productCounts,m.id)?.n||0,activeTasks:counts?.platform_count||0,currentTask:current?`${kindLabels[current.kind]||current.kind} · ${taskStatusLabel(current)}`:null,lastActivity:last};
  });
  return {trend,taskGroups,window:{from:bounds[0],to:bounds[1]},range,timeZone:'Asia/Shanghai',updatedAt:at(),members,metrics:{productiveMembers:progress.filter(m=>m.creations+m.reviews+m.products>0).length,newProducts:productCounts.reduce((n,r)=>n+r.n,0),failedTasks:failures.n,activeTasks:activeCounts.reduce((n,r)=>n+r.platform_count,0)},progress,latestProducts:products.map(projectDto),attention:attention.map(taskDto),waitingAgentCount:activeCounts.reduce((n,r)=>n+r.agent_count,0)};
}

export async function adminDashboardApi(request:Request,env:any):Promise<Response|null> {
  const url=new URL(request.url),path=url.pathname;
  if(!/^\/api\/admin\/(dashboard|projects|tasks)(\/|$)/.test(path))return null;
  try {
    if(request.headers.has('Authorization'))throw problem('设备凭据不能访问管理接口。',403);
    if(!env.DB)throw problem('管理数据服务尚未就绪。',503);
    if((await identity(request.headers.get('Cookie'),memberStore(env.DB),env))?.role!=='admin')throw problem('仅超级管理员可操作。',403);
    if(request.method!=='GET'&&request.headers.get('Origin')!==url.origin)throw problem('请求来源不匹配。',403);
    if(path==='/api/admin/dashboard'&&request.method==='GET')return json(await dashboard(env.DB,url.searchParams));
    if(path==='/api/admin/projects'&&request.method==='GET')return json(await projectPage(env.DB,url.searchParams));
    if(path==='/api/admin/tasks'&&request.method==='GET')return json(await taskPage(env.DB,url.searchParams));
    const project=path.match(/^\/api\/admin\/projects\/(topic|game)\/(\d+)(?:\/material\/(expand|game|preview|brief|assets)(?:\/(preview|file|thumbnail))?)?$/);
    if(project&&request.method==='GET')return project[3]?await material(env.DB,url,project[1],Number(project[2]),project[3] as MaterialKind,project[4]):json(await projectDetail(env.DB,project[1],Number(project[2])));
    const task=path.match(/^\/api\/admin\/tasks\/(creation|review)\/([^/]+)(\/retry)?$/);
    if(task&&!task[3]&&request.method==='GET')return json(await taskDetail(env.DB,task[1],decodeURIComponent(task[2])));
    if(task&&task[3]&&task[1]==='creation'&&request.method==='POST')return json({task:await retryCreation(env,decodeURIComponent(task[2]))},202);
    throw problem('接口不存在。',404);
  }catch(error){return json({error:(error as Error).message},(error as any).status||500);}
}
