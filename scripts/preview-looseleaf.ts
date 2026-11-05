// Local synthetic preview. No production credentials, outbound network or model execution.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createServer as createViteServer, type ViteDevServer} from 'vite';
import {adminApi} from '../server/admin-api';
import {authApi} from '../server/auth-api';
import {forgeApi} from '../server/forge-api';
import {forgeAgentWeb} from '../server/forge-agent-api';
import {reviewDeviceWeb} from '../server/review-device-api';
import {galleryApi} from '../server/gallery';
import {configStore,memberStore} from '../server/storage';
import {hashPassword,memberLogin} from '../server/members';
import {login} from '../server/settings';
import {saveArtifact} from '../server/forge-workspace';
import {digest,canonicalJson} from '../server/review-device-state';

type PreviewOptions = { mode?: 'dev' | 'legacy' | 'looseleaf'; assetDir?: string; apiDelayMs?: number };
const workbenchRoutes = new Set(['/', '/login', '/admin', '/admin/', '/forge', '/forge/', '/review', '/square', '/square/', '/account', '/index.html', '/ui.html']);
const mime: Record<string,string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };

function staticPage(mode: 'legacy' | 'looseleaf', pathname: string, cookie: string) {
  if (mode === 'looseleaf') return '/ui.html';
  if (pathname.startsWith('/forge')) return '/forge/index.html';
  if (pathname.startsWith('/square')) return '/square.html';
  if (pathname === '/review' || pathname === '/' && cookie.includes('pgc_member=')) return '/review.html';
  return '/index.html';
}

export async function startPreview(port=8790, options: PreviewOptions = {}){
const mode = options.mode || 'dev';
const assetRoot = path.resolve(options.assetDir || (mode === 'legacy' ? 'dist' : 'dist-ui'));
const sqlite = new DatabaseSync(':memory:');
for (const migration of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(await readFile(path.join('migrations', migration), 'utf8'));
const DB: any = {
  prepare(sql: string) {
    let params: any[] = [];
    const statement: any = { bind(...values: any[]) { params = values; return statement; }, first: async () => sqlite.prepare(sql).get(...params) || null, all: async () => ({ results: sqlite.prepare(sql).all(...params) }), run: async () => { const result = sqlite.prepare(sql).run(...params); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }, execute: () => sqlite.prepare(sql).run(...params) };
    return statement;
  },
  batch: async (statements: any[]) => { sqlite.exec('BEGIN'); try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
};
const now = new Date().toISOString(), memberA = 'a0000000-0000-4000-8000-000000000001', memberB = 'b0000000-0000-4000-8000-000000000002';
const secrets = { ADMIN_PASSWORD: 'local-synthetic-admin', SETTINGS_KEY: 'local-synthetic-secret' };
const password = await hashPassword('local-synthetic-member');
for (const [id, username, name, enabled, star] of [[memberA, 'lin', '林小满', 1, 1], [memberB, 'zhou', '周可可', 1, 1], ['c0000000-0000-4000-8000-000000000003', 'chen', '陈一诺', 1, 0], ['d0000000-0000-4000-8000-000000000004', 'gu', '顾遥', 0, 1]] as const) sqlite.prepare('INSERT INTO members(id,username,display_name,password_hash,password_salt,enabled,star,can_review,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, username, name, password.hash, password.salt, enabled, star, 1, now, now);
const titles = ['Pocket Bloom · 口袋花园', 'Moon Post · 月光邮局', 'Rain Radio · 雨天电台', 'Paper Orbit · 纸上轨道', 'Tiny Tide · 微光潮汐', 'Dream Parcel · 梦境包裹'];
const palette = ['#e6edd8', '#e4e8ed', '#e9e2d8', '#e6e2ef', '#dcebe5', '#f1e7d7'];
function insert(table: string, values: Record<string, any>) { sqlite.prepare(`INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values)); }
for (let i = 1; i <= 342; i++) {
  const owner = i % 2 ? memberA : memberB;
  insert('topics', { id: i, owner_id: owner, batch: 'admin-browser-fixture', subject: `合成题材 ${i}`, medium: '水彩', gesture: 'tap', structure: 'score', mood: 'calm', status: i <= 18 ? 'made' : i % 5 ? 'liked' : 'drawn', data: JSON.stringify({ title: i === 1 ? titles[0] : `${titles[i % titles.length]} ${i}`, logline: '在轻触之间完成一段小小的冒险。', core_loop: '观察 → 轻触 → 获得反馈 → 解锁新变化', controls: '单指轻触与拖动', art_direction: '暖白底色、细腻水彩和柔和鼠尾草绿', ...(i % 4 ? {palette: [palette[i % palette.length], '#91A57E', '#D8C59E', '#344238']} : {}), risks: '首屏需要明确提示可点击区域', aes: 3, ease: 3, play: 3, private_html: 'SOURCE_NOT_FOR_LISTS' }), requirements: '540×960 竖屏；首屏可玩；提供重开入口。', created_at: now, updated_at: now });
  insert('forge_tasks', { id: `creation-${String(i).padStart(3, '0')}`, owner_id: owner, kind: 'brief', scope: `${owner}:brief:${i}`, payload: JSON.stringify({ type: 'brief', id: i }), status: i % 11 ? 'done' : 'error', executor: i % 7 ? 'platform' : 'agent', input_snapshot: JSON.stringify({ cfg: { template: 'SYNTHETIC_INPUT' }, topic: { id: i, owner_id: owner, data: { title: `Original ${i}` } }, revision: 0, policy_revision: 0, heads: {} }), detail: i % 11 ? '简报已保存' : '执行未完成', error: i % 11 ? '' : 'model timeout: request deadline exceeded', created_at: now, updated_at: now });
}
insert('games', { id: 1, owner_id: memberB, title: '历史导入 · Wind Letter', descr: '这是一份历史导入作品的描述。', updated_at: now });
const gameHtml = (label: string, color: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${color};font:22px system-ui;color:#5e7350;touch-action:manipulation}body{display:grid;place-items:center}.stage{width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:24px}small{font-size:14px}button{font:inherit;border:1px solid #879d76;background:#ffffffaa;color:#5b754a;border-radius:50%;width:110px;height:110px;touch-action:manipulation}p{margin:0}#score{font-size:36px}</style></head><body><div class="stage"><small>${label}</small><p>让一朵小花生长</p><button id="tap" aria-label="种下种子">✿</button><p id="score">0</p><small>轻触花朵，收集光点</small></div><script>document.querySelector('#tap').addEventListener('click',()=>{document.querySelector('#score').textContent=String(Number(document.querySelector('#score').textContent)+1)});</script></body></html>`;
const save = (id: number, kind: string, content: string) => saveArtifact(DB, { owner: id % 2 ? memberA : memberB, topicId: id, kind, content, revision: 0, executor: 'platform', model: 'synthetic-fixture', force: true });
for (let i = 1; i <= 18; i++) {
  await save(i, 'preview', `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="340" viewBox="0 0 600 340"><rect width="600" height="340" fill="${palette[i % palette.length]}"/><circle cx="300" cy="175" r="76" fill="#ffffff38"/><path d="M300 248V126m0 45-34-27m34 59 38-33" stroke="#91a57e" stroke-width="9" stroke-linecap="round" fill="none"/><circle cx="300" cy="118" r="27" fill="#d8c59e"/></svg>`);
  await save(i, 'game', gameHtml('CURRENT FIXTURE VERSION', palette[i % palette.length]));
}
const oldGame = await save(1, 'game', gameHtml('IMMUTABLE OLD VERSION', '#edf0db'));
const currentGame = await save(1, 'game', gameHtml('CURRENT FIXTURE VERSION', '#e8eedb'));
await save(1, 'brief', '# F. 本款设计\n\n## F1. 核心循环\n轻触花朵，收集光点，组合新的花色。\n\n## F2. 操作\n单指轻触；每次点击立即反馈。\n\n<script>window.__unsafeBrief=1</script>');
await save(1, 'assets', '<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:#f5f7ee;display:grid;place-items:center;height:100vh;color:#7b9568;font:26px system-ui"><p>ASSET FIXTURE · ✿ ❋ ❀</p></body></html>');
sqlite.prepare('UPDATE topics SET updated_at=? WHERE id=1').run(new Date(Date.now() + 1000).toISOString());
insert('forge_tasks', { id: 'platform-active', owner_id: memberA, kind: 'game', scope: `${memberA}:game:339`, payload: JSON.stringify({ type: 'game', id: 339 }), status: 'running', executor: 'platform', detail: '正在生成游戏，已接收 8,320 字符', created_at: now, updated_at: now, started_at: now });
insert('forge_tasks', { id: 'agent-original', owner_id: memberB, kind: 'game', scope: `${memberB}:game:340`, payload: JSON.stringify({ type: 'game', id: 340 }), status: 'running', executor: 'agent', detail: '等待成员 Agent 继续回传', created_at: now, updated_at: now });
insert('review_jobs', { id: 'review-agent-original', owner_id: memberA, topic_id: 1, result_id: 81, title: titles[0], filename: 'pocket-bloom.html', status: 'done', stage: 'done', model_executor: 'agent', created_at: now, updated_at: now });
const reviewResult = { title: titles[0], score: 8, aes: 3, ease: 3, play: 2, summary: '合成报告，仅用于测试后台路由。', reviewer_comment: '合成游戏的交互清楚，后续可继续丰富挑战变化。', score_reasons: {aes: '画面与配色协调。', ease: '轻触操作可立即获得反馈。', play: '基础循环完整，长期挑战仍待验证。'}, uncertainties: ['此合成报告仅用于测试界面。'], issues: [] };
insert('reviews', { id: 81, owner_id: memberA, job_id: 'review-agent-original', title: titles[0], topic_id: 1, score: 8, result: JSON.stringify(reviewResult), probe: '{}', model_executor: 'agent', created_at: now });
const rulesContent={sourceUrl:'https://creator-hub-7mi.pages.dev/#/',capturedAt:now,rawDirection:'合成规则：玩法目标明确，保留核心机制。必须可独立游玩；尽量避免重复体验。',rawScoring:'合成规则：美学、易玩性、可玩性各 0–3 分。未知维度保留 null。',scoreMin:0,scoreMax:3,passScore:7,notes:'仅用于界面与交互验证。',calibrationCases:[]};
const rules={schemaVersion:2,id:'synthetic-rules',contentHash:await digest(canonicalJson(rulesContent)),...rulesContent,publishedAt:now};
insert('review_rule_versions',{id:rules.id,content_hash:rules.contentHash,snapshot:JSON.stringify(rulesContent),created_at:now,published_at:now});sqlite.prepare('UPDATE review_rule_head SET version_id=? WHERE id=1').run(rules.id);
const v2={schema_version:2,assessment_status:'needs_review',aes:0,ease:null,play:2,verdict:'待复核',reviewer_comment:'操作反馈清楚；本轮证据不足以判断持续拖动体验。\n<img src=x onerror="window.__sourceExecuted=true">',score_reasons:{aes:'合成零分，用于验证 0 与未知的不同展示。',ease:'本轮未获得连续触摸证据，保留未知。',play:'已观察到基础循环及失败重开。'},uncertainties:['无听音证据。'],strengths:['已有核心机制可保留。'],issues:[{kind:'confirmed',severity:'中',area:'布局',problem:'合成窄屏条件下重开按钮被遮挡。',evidence:'合成视口 320×568 的底部布局记录。',evidence_refs:['shot-1'],fix:'调整按钮容器内边距，在相同窄屏复测。'},{kind:'experience',severity:'低',area:'引导',problem:'首次操作提示存在体验歧义。',evidence:'首次查看时尝试了两个操作方向。',evidence_refs:['shot-1'],fix:'可选：提示明确目标方向。'},{kind:'unverified',severity:'低',area:'操作',problem:'持续拖动时的状态切换尚未确认。',evidence:'本轮仅进行了短触摸。',evidence_refs:[],fix:'连续拖动穿过状态变化并保留中途截图。'}],optional_suggestions:['可以提高次要提示的对比度。'],fix_prompt:'只修复已确认的窄屏按钮遮挡，保留原核心机制。'};
insert('review_jobs',{id:'review-v2',owner_id:memberA,topic_id:1,result_id:82,title:'Paper Orbit · 精确版本 v3',filename:'paper-orbit-v3.html',status:'done',stage:'done',model_executor:'agent',report_schema_version:2,rules_snapshot:JSON.stringify(rules),input_hash:'a'.repeat(64),created_at:now,updated_at:now});
insert('reviews',{id:82,owner_id:memberA,job_id:'review-v2',title:'Paper Orbit · 精确版本 v3',topic_id:1,score:null,result:JSON.stringify(v2),probe:'{}',shots:JSON.stringify([{id:'shot-1',label:'合成测试图，仅验证原图弹窗',data:'data:image/png;base64,'+(await readFile('public/artwork/pixel-cat.png')).toString('base64')}]),rules_snapshot:JSON.stringify(rules),model_executor:'agent',created_at:now});
for(const[id,owner,status,stage]of[['waiting-review',memberA,'running','review'],['waiting-verify',memberA,'running','verify'],['failed-capture',memberA,'error','capture'],['member-waiting','c0000000-0000-4000-8000-000000000003','running','review']])insert('review_jobs',{id,owner_id:owner,title:'合成审核任务 · '+id,filename:'synthetic.html',status,stage,model_executor:'agent',error:status==='error'?'浏览器采集未完成，请保留原任务继续。':'',created_at:now,updated_at:now});
const feedbackToken='synthetic-preview-only';
sqlite.prepare("UPDATE creator_feedback_state SET generation=1,credential_hash=?,scope_revision=3,status='ready',phase='delta',cursor='3:2',last_success_at=? WHERE id=1").run(await digest(feedbackToken),Date.now());
const sourceGame={id:'game_synthetic',authorId:'author_synthetic',title:'Paper Orbit · 纸上轨道',description:'合成反馈资料',status:'rejected',revision:2,createdAt:now,updatedAt:now,archived:false,deleted:false,textRedacted:true,idNamespace:'integration_pseudonym',versions:[{id:'version_synthetic',revision:1,title:'Paper Orbit v3',description:'',submittedAt:now,updateNote:'作者声称已调整提示，尚需独立验证。',withdrawn:false,ruleVersion:null,status:null,statusSource:null,finalReviewId:null,files:{html:{bytes:42}},fileAccess:false}],reviews:[{id:'review_synthetic',versionId:'version_synthetic',stage:'decision_review',revision:1,eventSequence:2,reviewerId:'reviewer_synthetic',reviewerRole:'leader',scores:[{name:'美学',description:'',max:3,score:0},{name:'易玩性',description:'',max:3,score:null},{name:'可玩性',description:'',max:3,score:2}],total:null,decision:'rejected',feedback:'合成组长意见：需要核验窄屏布局，不代表已独立复现。',createdAt:now,recordedAt:now,scored:true,historicalBaseline:true,deleted:false,reopened:false,revoked:false,effective:true}],comments:[]};
insert('creator_feedback_games',{game_id:sourceGame.id,last_sequence:2,updated_at:Date.now()});
insert('creator_feedback_chunks',{kind:'game',entity_id:sourceGame.id,game_id:sourceGame.id,part:0,payload:JSON.stringify(sourceGame)});
insert('creator_feedback_chunks',{kind:'rules',entity_id:'candidate',game_id:null,part:0,payload:JSON.stringify({rules:[],historicalCoverage:'unknown'})});
insert('creator_feedback_chunks',{kind:'contract',entity_id:'current',game_id:null,part:0,payload:JSON.stringify({contract:{version:1,scopeRevision:3,dataset:'ordinary_games',authorScope:'all',fileVersionCount:0,idNamespace:'integration_pseudonym',historySince:null,pollingSeconds:120,snapshotsExpireHours:24,pagination:{defaultLimit:20,maxLimit:50},rateLimit:{requestsPerMinute:120}},fetchedAt:now,source:'synthetic-local-fixture'})});
insert('creator_feedback_links',{task_id:'review-v2',owner_id:memberA,known_work_id:'source-work-synthetic',known_submission_id:'source-version-synthetic',game_id:sourceGame.id,version_id:'version_synthetic',matched_by:'published-record',scope_revision:3,created_at:now});
insert('review_human_reviews',{job_id:'review-agent-original',owner_id:memberA,device_id:'synthetic-device',request_id:'synthetic-request',payload_hash:'a'.repeat(64),work_id:'gallery-work',version_id:'gallery-version',score:8,feedback:'合成终审已通过',source_updated_at:now,source:'agent',status:'reviewed',phase:'final',matched_by:'user-confirmed',display_rank:2,is_current:1,created_at:now,decision:'approved'});
const galleryHtml=gameHtml('GALLERY SYNTHETIC VERSION','#e8eedb');
insert('gallery_games',{id:'a0000000-0000-4000-8000-000000000099',owner_id:memberA,work_id:'gallery-work',version_id:'gallery-version',job_id:'review-agent-original',title:'Pocket Bloom · 口袋花园',content_hash:await digest(galleryHtml),part_count:1,byte_length:Buffer.byteLength(galleryHtml),is_complete:1,created_at:now});
insert('gallery_game_html',{game_id:'a0000000-0000-4000-8000-000000000099',part:0,data:galleryHtml});

const requests:{method:string;path:string;status:number}[]=[],outbound:string[]=[],dispatches:string[]=[];
const nativeFetch=globalThis.fetch;
globalThis.fetch=(async(input:any,init?:RequestInit)=>{const value=typeof input==='string'?input:input instanceof URL?input.href:input.url;const target=new URL(value);if(target.hostname!=='127.0.0.1'&&target.hostname!=='localhost'){outbound.push(target.origin);throw Error('独立预览禁止外部网络和真实模型调用。');}return nativeFetch(input,init);}) as typeof fetch;
const store=configStore(DB),members=memberStore(DB),adminToken=await login(secrets.ADMIN_PASSWORD,secrets);
const credentials:Record<string,string>={admin:`pgc_admin=${adminToken}`,star:`pgc_member=${await memberLogin('lin','local-synthetic-member',members,secrets.SETTINGS_KEY)}`,member:`pgc_member=${await memberLogin('chen','local-synthetic-member',members,secrets.SETTINGS_KEY)}`};
const runner={idFromName:(id:string)=>id,get:(id:string)=>({fetch:async()=>{dispatches.push(id);return Response.json({scheduled:true});}})};
const runtime={FORGE_RUNNER:runner,REVIEW_QUEUE:{send:async()=>{throw Error('预览不执行真实审核模型。');}},CREATOR_FEEDBACK_RUNNER:runner,CREATOR_FEEDBACK_ENABLED:'true',CREATOR_FEEDBACK_TOKEN:feedbackToken};
const env={DB,...secrets,...runtime,CREATIVE_V2_ROLLOUT:'all',modelStore:store,reviewExecutor:'device' as const};
let vite: ViteDevServer | undefined;
const server=createServer(async(req,res)=>{
 const origin=`http://${req.headers.host}`,url=new URL(req.url||'/',origin);
 try{
  if(url.pathname==='/__preview'){
   const role=url.searchParams.get('role');
   if(role){res.writeHead(302,{'Set-Cookie':['pgc_member=; Path=/; Max-Age=0','pgc_admin=; Path=/; Max-Age=0',...(credentials[role]?[credentials[role]+'; Path=/; HttpOnly; SameSite=Strict']:[])],Location:role==='admin'?'/admin':role==='star'?'/forge/':'/login'});res.end();return;}
   res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PGC 独立预览</title><style>body{font:16px system-ui;background:#f4f7ef;color:#36523b;max-width:720px;margin:10vh auto;padding:24px}a{display:block;background:white;border:1px solid #d8e2ce;border-radius:5px;padding:20px;margin:14px 0;color:inherit}p{line-height:1.8}</style><h1>PGC Preflight 独立预览</h1><p>所有作品、任务、审核和成员都是合成数据。原生产前端保持不变；本预览不执行真实模型或连接上游资料。</p><a href="?role=star">进入 Star 创作工作台</a><a href="?role=member">进入普通成员审核</a><a href="?role=admin">进入管理员后台</a><a href="?role=none">查看登录页</a><p>本地测试账号：lin / chen<br>本地测试密码：local-synthetic-member</p></html>');return;
  }
  if(url.pathname==='/__preview/metrics'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({requests,outbound,dispatches}));return;}
  if(url.pathname.startsWith('/api/')){
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const headers=new Headers();for(const[key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
   const request=new Request(url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method||'GET')?undefined:Buffer.concat(chunks)});
   let response:Response|null;
   if(url.pathname.startsWith('/api/admin/'))response=await adminApi(request,store,{...secrets,...runtime},members,DB,runtime);
   else if(url.pathname.startsWith('/api/auth/'))response=await authApi(request,members,secrets);
   else if(url.pathname.startsWith('/api/forge/review/device/'))response=await reviewDeviceWeb(request,env);
   else if(url.pathname.startsWith('/api/forge/agent/'))response=await forgeAgentWeb(request,env);
   else if(url.pathname.startsWith('/api/square/'))response=await galleryApi(request,env);
   else if(url.pathname.startsWith('/api/forge/'))response=await forgeApi(request,env,url.pathname.slice('/api/forge/'.length).split('/').filter(Boolean),members);
   else response=null;
   if (options.apiDelayMs) await new Promise<void>(resolve => setTimeout(resolve, options.apiDelayMs));
   const result=response||Response.json({error:'接口不存在。'},{status:404});requests.push({method:req.method||'GET',path:url.pathname+url.search,status:result.status});res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));return;
  }
  if (mode !== 'dev') {
   const relative = workbenchRoutes.has(url.pathname) ? staticPage(mode, url.pathname, req.headers.cookie || '') : decodeURIComponent(url.pathname);
   const file = path.resolve(assetRoot, '.' + relative);
   if (!file.startsWith(assetRoot + path.sep)) { res.writeHead(404).end(); return; }
   const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT' || error.code === 'EISDIR') return null; throw error; });
   if (!bytes) { res.writeHead(404).end(); return; }
   const type = mime[path.extname(file)] || 'application/octet-stream';
   res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=300' });
   res.end(bytes);
   return;
  }
  if (!vite) { res.writeHead(503).end(); return; }
  if (workbenchRoutes.has(url.pathname)) {
   const html=(await readFile('ui.html','utf8')).replace('<html lang="zh-CN">','<html lang="zh-CN" data-preview="true">');res.setHeader('Content-Type','text/html;charset=utf-8');res.end(await vite.transformIndexHtml(url.pathname,html));return;
  }
  vite.middlewares(req,res,()=>{res.writeHead(404);res.end('Not found');});
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error instanceof Error?error.message:'预览请求失败。'}));}
});
if (mode === 'dev') vite = await createViteServer({configFile:path.resolve('vite.ui.config.ts'),server:{middlewareMode:true,hmr:{server}},appType:'custom'});
await new Promise<void>(resolve=>server.listen(port,'127.0.0.1',resolve));const address=server.address() as {port:number};
return{url:`http://127.0.0.1:${address.port}`,requests,outbound,dispatches,DB,sqlite,close:async()=>{await vite?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));sqlite.close();globalThis.fetch=nativeFetch;}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve('scripts/preview-looseleaf.ts')){
 const preview=await startPreview(Number(process.env.PGC_UI_PORT)||8790);console.log(`PGC_LOOSELEAF_PREVIEW=${preview.url}/__preview`);
 const close=async()=>{await preview.close();process.exit(0);};process.once('SIGINT',close);process.once('SIGTERM',close);
}
