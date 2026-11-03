import {reviewRulesAdmin,resolvePublishedReviewRulesSnapshot} from './review-rules';
import {identity,publicMember} from './members';
import {memberStore} from './storage';
import {digest,canonicalJson,problem,stamp} from './review-device-state';
import {publicSettings} from './forge-workspace';
import {publicCreatorTask} from './forge-agent-api';
import {reviewReportErrors,reportScore} from './review-report';
import {enqueueReview,recoverInterruptedReviews} from './review-jobs';
import {withHumanReviews} from './human-review';
import {reviewDay} from './review-usage';

const paths=new Set(['/api/admin/review-rules','/api/admin/workspace','/api/admin/public-data','/api/admin/review-upload','/api/admin/review-import']);
const json=(v:any,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const all=async(DB:any,sql:string,...p:any[])=>(await DB.prepare(sql).bind(...p).all()).results||[];
async function body(request:Request){
  if(!request.headers.get('Content-Type')?.includes('application/json'))throw problem('请使用 JSON。',415);
  if(Number(request.headers.get('Content-Length')||0)>13*1024*1024)throw problem('文件过大。',413);
  const text=await request.text();if(new TextEncoder().encode(text).length>13*1024*1024)throw problem('文件过大。',413);
  try{return JSON.parse(text);}catch{throw problem('内容不是合法 JSON。');}
}
export async function adminWorkspaceApi(request:Request,env:any):Promise<Response|null>{
  const url=new URL(request.url);if(!paths.has(url.pathname))return null;
  try{
    if(request.headers.has('Authorization'))throw problem('设备凭据不能访问管理接口。',403);
    const store=memberStore(env.DB),user=await identity(request.headers.get('Cookie'),store,env),DB=env.DB;
    if(user?.role!=='admin')throw problem('仅超级管理员可操作。',403);
    if(request.method!=='GET'&&request.headers.get('Origin')!==url.origin)throw problem('请求来源不匹配。',403);
    if(url.pathname.endsWith('/review-rules'))return json(await reviewRulesAdmin(request,DB));
    if(url.pathname.endsWith('/workspace')&&request.method==='GET'){
      const owner=url.searchParams.get('owner')||'';
      await recoverInterruptedReviews(env,owner||undefined);
      const [topics,games,tasks,agents,suggestions,members,reviewJobs,reviews,products]=await Promise.all([
        all(DB,"SELECT id,owner_id,subject,status,data,score,origin,requirements,content_revision,created_at,updated_at,brief_md IS NOT NULL AS has_brief,assets_html IS NOT NULL AS has_assets,product_html IS NOT NULL AS has_product FROM topics WHERE (?='' OR owner_id=?) ORDER BY id DESC LIMIT 300",owner,owner),
        all(DB,"SELECT * FROM games WHERE (?='' OR owner_id=?) ORDER BY id DESC LIMIT 300",owner,owner),
        all(DB,"SELECT * FROM forge_tasks WHERE (?='' OR owner_id=?) ORDER BY created_at DESC LIMIT 300",owner,owner),
        all(DB,"SELECT id,owner_id,name,revoked,expires_at,last_seen,'creation' AS scope FROM forge_agents WHERE (?='' OR owner_id=?) UNION ALL SELECT id,owner_id,name,revoked,expires_at,last_seen,'review' AS scope FROM review_devices WHERE (?='' OR owner_id=?)",owner,owner,owner,owner),
        all(DB,"SELECT * FROM vocab_suggestions WHERE (?='' OR owner_id=?) ORDER BY created_at DESC LIMIT 200",owner,owner),store.list(),
        all(DB,"SELECT id,owner_id,title,filename,status,stage,error,result_id,model_executor,quota_charged,created_at,updated_at FROM review_jobs WHERE (?='' OR owner_id=?) ORDER BY created_at DESC LIMIT 200",owner,owner),
        all(DB,"SELECT id,owner_id,job_id,title,score,model_executor,agent_id,model,created_at FROM reviews WHERE (?='' OR owner_id=?) ORDER BY id DESC LIMIT 200",owner,owner),
        all(DB,"SELECT id,owner_id,subject,data,updated_at,1 AS has_product,product_status,product_error FROM topics WHERE product_html IS NOT NULL AND trim(product_html)<>'' AND (?='' OR owner_id=?) ORDER BY updated_at DESC,id DESC LIMIT 300",owner,owner),
      ]);
      return json({topics:topics.map((t:any)=>({...t,data:JSON.parse(t.data)})),products:products.map((t:any)=>({...t,data:JSON.parse(t.data)})),games,tasks:tasks.map(publicCreatorTask),agents:agents.map((d:any)=>({...d,online:!d.revoked&&Date.parse(d.expires_at)>Date.now()&&Date.now()-Date.parse(d.last_seen||'')<90000})),suggestions:suggestions.map((s:any)=>({...s,words:JSON.parse(s.words)})),members:members.map(publicMember),reviewJobs:await withHumanReviews(DB,reviewJobs,true),reviews:await withHumanReviews(DB,reviews)});
    }
    if(url.pathname.endsWith('/public-data')){
      if(request.method==='GET'){
        const [settings,vocab,games,publishableGames,suggestions]=await Promise.all([
          publicSettings(DB),all(DB,'SELECT * FROM vocab ORDER BY dim,id'),all(DB,'SELECT * FROM games WHERE is_public=1 ORDER BY id'),
          all(DB,'SELECT id,ext_id,title,descr,status,score,aes,ease,play,revisions,feedback,subject,medium,gesture,structure,mood,source,updated_at,owner_id,is_public FROM games ORDER BY updated_at DESC,id DESC'),
          all(DB,"SELECT s.id,s.owner_id,COALESCE(m.display_name,'历史管理员档案') ownerName,s.dim,s.words,s.status,s.created_at,s.updated_at FROM vocab_suggestions s LEFT JOIN members m ON m.id=s.owner_id WHERE s.status='pending' ORDER BY s.created_at DESC,s.id DESC"),
        ]);
        return json({settings,vocab,games,publishableGames,suggestions:suggestions.map((s:any)=>({...s,words:JSON.parse(s.words)}))});
      }
      if(request.method!=='POST')throw problem('请使用 GET 或 POST。',405);
      const b=await body(request),at=stamp();
      if(b.action==='settings'){
        const allowed=['redlines','template','template_f','draw_size','expand_batch'];
        if(!b.settings||typeof b.settings!=='object'||Object.keys(b.settings).some(k=>!allowed.includes(k)))throw problem('公共设置字段不正确。');
        await DB.batch(Object.entries(b.settings).map(([k,v])=>DB.prepare('INSERT INTO settings(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(k,String(v),at)));
      }else if(b.action==='vocab-add'){
        if(!['subject','medium','gesture','structure','mood'].includes(b.dim)||typeof b.word!=='string'||!b.word.trim()||b.word.length>160)throw problem('词条格式不正确。');
        await DB.prepare('INSERT OR IGNORE INTO vocab(dim,word,note,base) VALUES(?,?,?,?)').bind(b.dim,b.word.trim(),String(b.note||'').slice(0,2000),Number.isFinite(Number(b.base))?Math.max(0,Number(b.base)):1).run();
      }else if(b.action==='vocab-update'){
        const keys=['word','note','base','enabled'].filter(k=>b[k]!==undefined);if(!keys.length)throw problem('没有修改字段。');
        await DB.prepare(`UPDATE vocab SET ${keys.map(k=>`${k}=?`).join(',')} WHERE id=?`).bind(...keys.map(k=>k==='enabled'?Number(!!b[k]):k==='base'?Math.max(0,Number(b[k])||0):String(b[k]).slice(0,k==='note'?2000:160)),b.id).run();
      }else if(b.action==='vocab-delete')await DB.prepare('DELETE FROM vocab WHERE id=?').bind(b.id).run();
      else if(b.action==='publish-game')await DB.prepare('UPDATE games SET is_public=? WHERE id=?').bind(b.is_public===false?0:1,b.id).run();
      else if(['suggestion-approve','suggestion-reject'].includes(b.action)){
        const suggestion=await DB.prepare('SELECT * FROM vocab_suggestions WHERE id=?').bind(b.id).first();if(!suggestion)throw problem('建议不存在。',404);
        await DB.batch([
          ...(b.action==='suggestion-approve'?JSON.parse(suggestion.words).map((w:any)=>DB.prepare("INSERT OR IGNORE INTO vocab(dim,word,note,base) SELECT ?,?,?,1 WHERE EXISTS(SELECT 1 FROM vocab_suggestions WHERE id=? AND status='pending')").bind(suggestion.dim,w.word.trim(),String(w.note||'').slice(0,2000),b.id)):[]),
          DB.prepare("UPDATE vocab_suggestions SET status=?,updated_at=? WHERE id=? AND status='pending'").bind(b.action==='suggestion-approve'?'approved':'rejected',at,b.id),
        ]);
      }else throw problem('不支持的管理操作。');
      return json({ok:true});
    }
    if(request.method!=='POST')throw problem('请使用 POST。',405);
    const b=await body(request);
    if(url.pathname.endsWith('/review-upload'))return json(await enqueueReview({...env,reviewExecutor:undefined,modelExecutor:'platform'},b,'admin'),202);
    // Manual imports carry their source; they cannot masquerade as Agent or platform execution.
    if(!/^[a-f0-9-]{36}$/.test(b.request_id||''))throw problem('导入需要 request_id UUID。');
    const schemaVersion:1|2=b.result?.schema_version===2?2:1;
    if(b.report_schema_version!==undefined&&b.report_schema_version!==schemaVersion)throw problem('报告 schema 版本声明不匹配。');
    if(b.model_executor!==undefined&&b.model_executor!=='manual-admin')throw problem('手动导入只能声明 manual-admin 来源。');
    const rules=schemaVersion===2?await resolvePublishedReviewRulesSnapshot(DB,b.rules_snapshot):null;
    if(schemaVersion===1&&b.rules_snapshot!=null)throw problem('旧版报告不能附加新版规则归属。');
    const rulesText=rules?canonicalJson(rules):null;
    const errors=reviewReportErrors(b.result,{schemaVersion});if(errors.length)throw problem(`报告格式不完整：${errors.join(', ')}`);
    const owner=b.owner_id||'admin';if(owner!=='admin'&&!await store.byId(owner))throw problem('成员不存在。',404);
    const hash=await digest(canonicalJson({owner,title:b.title||'管理员导入',filename:b.filename||'',result:b.result,probe:b.probe||{},shots:b.shots||[],...(rules?{rules_snapshot:rules}:{})}));
    const prior=await DB.prepare('SELECT * FROM review_jobs WHERE id=?').bind(b.request_id).first();
    if(prior){if(prior.model_executor!=='manual-admin'||prior.local_result_hash!==hash)throw problem('请求编号已用于其他内容。',409);return json({id:prior.result_id,job_id:prior.id});}
    const at=stamp();
    await DB.batch([
      DB.prepare("INSERT OR IGNORE INTO review_jobs(id,owner_id,title,filename,status,stage,usage_day,created_at,updated_at,quota_charged,input_ready,model_executor,local_result_hash,rules_snapshot,report_schema_version,review_mode) VALUES(?,?,?,?,'done','done',?,?,?,0,0,'manual-admin',?,?,?,?)").bind(b.request_id,owner,String(b.title||'管理员导入').slice(0,120),String(b.filename||'').slice(0,200),reviewDay(),at,at,hash,rulesText,schemaVersion,schemaVersion===2?'full':'basic'),
      DB.prepare("INSERT OR IGNORE INTO reviews(owner_id,title,score,result,probe,shots,created_at,job_id,model_executor,rules_snapshot) SELECT owner_id,title,?,?,?,?,?,id,'manual-admin',rules_snapshot FROM review_jobs WHERE id=? AND local_result_hash=? AND model_executor='manual-admin'").bind(reportScore(b.result),canonicalJson(b.result),JSON.stringify({...b.probe,evidenceOrigin:'admin-upload',modelExecutor:'manual-admin'}),JSON.stringify(b.shots||[]),at,b.request_id,hash),
      DB.prepare('UPDATE review_jobs SET result_id=(SELECT id FROM reviews WHERE job_id=?) WHERE id=? AND local_result_hash=?').bind(b.request_id,b.request_id,hash),
    ]);
    const done=await DB.prepare('SELECT * FROM review_jobs WHERE id=?').bind(b.request_id).first();if(done.local_result_hash!==hash)throw problem('请求编号冲突。',409);
    return json({id:done.result_id,job_id:done.id},201);
  }catch(e){return json({error:(e as Error).message},(e as any).status||500);}
}
