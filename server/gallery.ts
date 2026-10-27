import {identity} from './members';
import {memberStore} from './storage';
import {canonicalJson,digest,problem,stamp} from './review-device-state';

type Env={DB:any;ADMIN_PASSWORD:string;SETTINGS_KEY:string};
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const json=(value:any,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff'}});
const previewHeaders={'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
const finalWhere="status='reviewed' AND phase='final'";
const latestFinal=(alias:string)=>`SELECT id FROM review_human_reviews WHERE owner_id=${alias}.owner_id AND work_id=${alias}.work_id AND version_id=${alias}.version_id AND ${finalWhere} ORDER BY source_updated_at DESC,id DESC LIMIT 1`;
// Listing and search must never scan every HTML blob.  The publishing
// transaction sets is_complete only after checking the part count and byte
// length; preview performs the full ordered/hash check before serving source.
const complete="g.is_complete=1 AND (SELECT COUNT(*) FROM gallery_game_html p WHERE p.game_id=g.id)=g.part_count";
const eligible=`h.decision='approved' AND ${complete}`;
const visible=`(${eligible} AND g.hidden=0)`;
const selection=`SELECT g.id,g.title,g.work_id,g.version_id,g.hidden,COALESCE(m.display_name,CASE WHEN g.owner_id='admin' THEN '超级管理员' ELSE '成员' END) AS author,h.score,h.source_updated_at AS approved_at,CASE WHEN ${visible} THEN 1 ELSE 0 END AS visible FROM gallery_games g LEFT JOIN members m ON m.id=g.owner_id LEFT JOIN review_human_reviews h ON h.id=(${latestFinal('g')})`;
function item(r:any){return {id:r.id,title:r.title,author:r.author,score:r.score,approvedAt:r.approved_at,workId:r.work_id,versionId:r.version_id,hidden:!!r.hidden,visible:!!r.visible};}

async function authorizedJob(DB:any,device:any,id:string,lease?:string){
  const current=await DB.prepare(`SELECT d.id FROM review_devices d LEFT JOIN members m ON m.id=d.owner_id
    WHERE d.id=? AND d.owner_id=? AND d.session_version=? AND d.revoked=0 AND d.expires_at>?
    AND (d.owner_id='admin' OR (m.enabled=1 AND m.can_review=1 AND CAST(m.session_version AS TEXT)=d.session_version))`).bind(device.id,device.owner_id,device.session_version,stamp()).first();
  if(!current)throw problem('设备配对已失效，请重新配对。',401);
  const job=await DB.prepare("SELECT * FROM review_jobs WHERE id=? AND owner_id=? AND executor='device' AND owner_hidden=0").bind(id,device.owner_id).first();
  if(!job)throw problem('审核任务不存在。',404);
  if(!['queued','running','done'].includes(job.status))throw problem('此任务不能发布到游戏广场。',409);
  if(job.worker_id||job.lease){if(job.worker_id!==device.id||job.lease!==lease)throw problem('仅原任务设备可发布，请使用原租约。',409);}
  else if(job.status!=='queued')throw problem('任务原租约不存在。',409);
  return job;
}
async function approval(DB:any,job:any){
  const human=await DB.prepare("SELECT * FROM review_human_reviews WHERE job_id=? AND owner_id=? AND is_current=1").bind(job.id,job.owner_id).first();
  if(!human||human.status!=='reviewed'||human.phase!=='final'||human.decision!=='approved'||!human.work_id||!human.version_id)throw problem('只有明确通过真人终审的作品版本可进入游戏广场。',409);
  const latest=await DB.prepare(`SELECT decision FROM review_human_reviews WHERE owner_id=? AND work_id=? AND version_id=? AND ${finalWhere} ORDER BY source_updated_at DESC,id DESC LIMIT 1`).bind(job.owner_id,human.work_id,human.version_id).first();
  if(latest?.decision!=='approved')throw problem('此作品版本的最新终审尚未通过。',409);
  return human;
}
async function gameReceipt(DB:any,id:string){const row=await DB.prepare(`${selection} WHERE g.id=?`).bind(id).first();return row?item(row):null;}

export async function publishGalleryGame(DB:any,device:any,b:any){
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['id','requestId','lease','html'].includes(k)))throw problem('广场发布包含不支持的字段。');
  if(!uuid(b.id)||!uuid(b.requestId)||b.lease!==undefined&&!uuid(b.lease))throw problem('广场发布任务、请求或租约标识不正确。');
  if(typeof b.html!=='string'||!b.html.trim())throw problem('缺少待发布的原版 HTML。');
  const bytes=new TextEncoder().encode(b.html).length;
  if(bytes>8*1024*1024)throw problem('单个 HTML 不能超过 8 MB。',413);
  const job=await authorizedJob(DB,device,b.id,b.lease),human=await approval(DB,job),contentHash=await digest(b.html);
  if(!job.input_hash||job.input_hash!==contentHash)throw problem('广场文件必须与此任务原上传 HTML 完全一致。',409);
  const hash=await digest(canonicalJson({id:job.id,contentHash})),old=await DB.prepare('SELECT * FROM gallery_publish_requests WHERE owner_id=? AND request_id=?').bind(device.owner_id,b.requestId).first();
  if(old){if(old.payload_hash!==hash)throw problem('同一广场发布请求不能更换任务或文件。',409);return {ok:true,gallery:await gameReceipt(DB,old.game_id)};}
  const existing=await DB.prepare('SELECT id,content_hash FROM gallery_games WHERE owner_id=? AND work_id=? AND version_id=?').bind(job.owner_id,human.work_id,human.version_id).first();
  if(existing&&existing.content_hash!==contentHash)throw problem('已发布的作品版本不能替换文件，请使用新的作品版本。',409);
  const parts:string[]=[];
  for(let i=0;i<b.html.length;){let end=Math.min(i+120000,b.html.length);if(end<b.html.length&&/[\uD800-\uDBFF]/.test(b.html[end-1]))end--;parts.push(b.html.slice(i,end));i=end;}
  const id=existing?.id||crypto.randomUUID(),now=stamp();
  const gate=`j.id=? AND j.owner_id=? AND j.executor='device' AND j.owner_hidden=0 AND j.status IN ('queued','running','done') AND j.input_hash=?
    AND ((j.status='queued' AND j.worker_id IS NULL AND j.lease IS NULL) OR (j.worker_id=? AND j.lease=?))
    AND h.id=? AND h.is_current=1 AND h.status='reviewed' AND h.phase='final' AND h.decision='approved'
    AND (SELECT decision FROM review_human_reviews WHERE id=(${latestFinal('h')}))='approved'
    AND EXISTS(SELECT 1 FROM review_devices d LEFT JOIN members m ON m.id=d.owner_id WHERE d.id=? AND d.owner_id=j.owner_id AND d.revoked=0 AND d.expires_at>? AND d.session_version=? AND (d.owner_id='admin' OR (m.enabled=1 AND m.can_review=1 AND CAST(m.session_version AS TEXT)=d.session_version)))`;
  const gateParams=[job.id,device.owner_id,contentHash,device.id,b.lease??null,human.id,device.id,now,device.session_version];
  const permitted=`EXISTS(SELECT 1 FROM review_jobs j JOIN review_human_reviews h ON h.job_id=j.id AND h.owner_id=j.owner_id WHERE ${gate})`;
  const gameParams=[job.owner_id,human.work_id,human.version_id,contentHash];
  const fragmentWrites=[];
  // Keep each bind below D1's 100-parameter limit and the entire 8 MB upload
  // below the Free plan's per-request query limit. Values stay in small parts.
  for(let start=0;start<parts.length;start+=30){
    const chunk=parts.slice(start,start+30);
    fragmentWrites.push(DB.prepare(`INSERT OR IGNORE INTO gallery_game_html(game_id,part,data)
      SELECT g.id,p.column1,p.column2 FROM gallery_games g CROSS JOIN (VALUES ${chunk.map(()=>'(?,?)').join(',')}) p
      WHERE g.owner_id=? AND g.work_id=? AND g.version_id=? AND g.content_hash=? AND g.is_complete=0 AND ${permitted}`)
      .bind(...chunk.flatMap((data,offset)=>[start+offset,data]),...gameParams,...gateParams));
  }
  // All file parts and the acknowledgement commit together. No HTML is stored
  // unless the original device lease and the exact approval still hold.
  await DB.batch([
    DB.prepare(`INSERT OR IGNORE INTO gallery_games(id,owner_id,work_id,version_id,job_id,title,content_hash,part_count,byte_length,created_at)
      SELECT ?,j.owner_id,h.work_id,h.version_id,j.id,j.title,?,?,?,? FROM review_jobs j JOIN review_human_reviews h ON h.job_id=j.id AND h.owner_id=j.owner_id
      WHERE ${gate}`).bind(id,contentHash,parts.length,bytes,now,...gateParams),
    ...fragmentWrites,
    DB.prepare(`UPDATE gallery_games AS g SET is_complete=1 WHERE g.owner_id=? AND g.work_id=? AND g.version_id=? AND g.content_hash=?
      AND (SELECT COUNT(*) FROM gallery_game_html p WHERE p.game_id=g.id)=?
      AND (SELECT COALESCE(SUM(length(CAST(p.data AS BLOB))),0) FROM gallery_game_html p WHERE p.game_id=g.id)=?
      AND ${permitted}`).bind(...gameParams,parts.length,bytes,...gateParams),
    DB.prepare(`INSERT OR IGNORE INTO gallery_publish_requests(owner_id,request_id,job_id,game_id,payload_hash,created_at)
      SELECT g.owner_id,?,?,g.id,?,? FROM gallery_games g
      WHERE g.owner_id=? AND g.work_id=? AND g.version_id=? AND g.content_hash=? AND g.is_complete=1
        AND ${permitted}`).bind(b.requestId,job.id,hash,now,...gameParams,...gateParams),
  ]);
  const saved=await DB.prepare('SELECT * FROM gallery_publish_requests WHERE owner_id=? AND request_id=?').bind(device.owner_id,b.requestId).first();
  if(!saved)throw problem('作品版本、终审或任务租约已改变，未发布游戏。',409);
  if(saved.payload_hash!==hash)throw problem('同一广场发布请求不能更换任务或文件。',409);
  return {ok:true,gallery:await gameReceipt(DB,saved.game_id)};
}

export async function autoPublishGalleryGame(DB:any,device:any,jobId:string,lease?:string){
  // Rejected/unknown/preliminary records need no source and never persist it.
  const job=await authorizedJob(DB,device,jobId,lease);
  let human:any;try{human=await approval(DB,job);}catch(error){if((error as any).status===409)return {};throw error;}
  const existing=await DB.prepare('SELECT id,content_hash,is_complete FROM gallery_games WHERE owner_id=? AND work_id=? AND version_id=?').bind(job.owner_id,human.work_id,human.version_id).first();
  if(existing&&existing.content_hash!==job.input_hash&&job.input_hash)return {gallery_message:'已发布的作品版本不能替换文件，请核对原作品和版本。'};
  if(existing?.is_complete&&existing.content_hash===job.input_hash)return {gallery:await gameReceipt(DB,existing.id)};
  const {results}=await DB.prepare('SELECT data FROM review_inputs WHERE job_id=? ORDER BY part').bind(job.id).all();
  if(!results?.length)return {gallery_pending:true,gallery_message:'真人终审已通过；原临时文件已清理，请用 gallery 命令上传本地原版。'};
  const input=JSON.parse(results.map((r:any)=>r.data).join(''));
  if(!job.input_hash){const hash=await digest(input.html);await DB.prepare('UPDATE review_jobs SET input_hash=? WHERE id=? AND input_hash IS NULL').bind(hash,job.id).run();}
  const result=await publishGalleryGame(DB,device,{id:job.id,requestId:job.id,...(lease?{lease}:{}),html:input.html});
  return {gallery:result.gallery};
}

export async function galleryApi(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url),match=/^\/api\/square\/games(?:\/([a-f0-9-]+)(?:\/(preview|visibility))?)?$/.exec(url.pathname);
  if(!url.pathname.startsWith('/api/square/'))return null;
  try{
    if(request.headers.has('Authorization'))throw problem('设备凭据不能访问游戏广场。',403);
    const user=await identity(request.headers.get('Cookie'),memberStore(env.DB),env);
    if(!user)throw problem('请先登录后浏览游戏广场。',401);
    if(!match)throw problem('广场接口不存在。',404);
    const [,id,action]=match,DB=env.DB;
    if(action==='visibility'){
      if(user.role!=='admin')throw problem('仅超级管理员可调整广场展示。',403);
      if(request.method!=='POST')throw problem('请使用 POST。',405);
      if(request.headers.get('Origin')!==url.origin)throw problem('请求来源不匹配。',403);
      if(!request.headers.get('Content-Type')?.includes('application/json'))throw problem('请使用 JSON。',415);
      const text=await request.text();if(text.length>1000)throw problem('请求内容过大。',413);
      let b:any;try{b=JSON.parse(text);}catch{throw problem('内容不是合法 JSON。');}
      if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>k!=='hidden')||typeof b.hidden!=='boolean')throw problem('请提供 hidden 布尔值。');
      const changed=await DB.prepare('UPDATE gallery_games SET hidden=? WHERE id=? RETURNING id').bind(Number(b.hidden),id).first();
      if(!changed)throw problem('广场游戏不存在。',404);
      return json(await gameReceipt(DB,id));
    }
    if(request.method!=='GET'&&!(request.method==='HEAD'&&action==='preview'))throw problem('请使用 GET。',405);
    const manage=url.searchParams.get('scope')==='manage';
    if(manage&&user.role!=='admin')throw problem('仅超级管理员可查看广场管理列表。',403);
    if(id){
      const row=await DB.prepare(`${selection} WHERE g.id=? AND ${visible}`).bind(id).first();
      if(!row)throw problem('广场游戏不存在。',404);
      if(action!=='preview')return json(item(row));
      if(request.method==='HEAD'){
        const parts=await DB.prepare('SELECT COUNT(*) AS n,MIN(part) AS first,MAX(part) AS last FROM gallery_game_html WHERE game_id=?').bind(id).first();
        if(!parts?.n||Number(parts.first)!==0||Number(parts.last)!==Number(parts.n)-1)throw problem('广场文件不完整。',404);
        return new Response(null,{headers:previewHeaders});
      }
      const game=await DB.prepare('SELECT content_hash,part_count FROM gallery_games WHERE id=?').bind(id).first();
      const {results}=await DB.prepare('SELECT part,data FROM gallery_game_html WHERE game_id=? ORDER BY part').bind(id).all();
      const html=(results||[]).map((p:any)=>p.data).join('');
      if(results.length!==game.part_count||results.some((p:any,i:number)=>p.part!==i)||await digest(html)!==game.content_hash)throw problem('广场文件不完整。',404);
      return new Response(html,{headers:previewHeaders});
    }
    const pageText=url.searchParams.get('page')||'1';if(!/^[1-9]\d{0,5}$/.test(pageText))throw problem('广场页码不正确。');
    const page=Number(pageText),pageSize=12,q=(url.searchParams.get('q')||'').trim().slice(0,120),pattern=`%${q.replace(/[\\%_]/g,'\\$&')}%`;
    const where=`${manage?'1=1':visible} AND (g.title LIKE ? ESCAPE '\\' OR COALESCE(m.display_name,'') LIKE ? ESCAPE '\\')`;
    const [rows,total]=await Promise.all([DB.prepare(`${selection} WHERE ${where} ORDER BY h.source_updated_at DESC,g.created_at DESC,g.id DESC LIMIT ? OFFSET ?`).bind(pattern,pattern,pageSize,(page-1)*pageSize).all(),DB.prepare(`SELECT COUNT(*) AS n FROM gallery_games g LEFT JOIN members m ON m.id=g.owner_id LEFT JOIN review_human_reviews h ON h.id=(${latestFinal('g')}) WHERE ${where}`).bind(pattern,pattern).first()]);
    const count=Number(total?.n||0);return json({items:(rows.results||[]).map(item),page,pageSize,total:count,hasMore:page*pageSize<count});
  }catch(error){return json({error:(error as Error).message||'游戏广场请求失败。'},(error as any).status||500);}
}
