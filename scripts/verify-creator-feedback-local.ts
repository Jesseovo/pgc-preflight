/** Local-only provider integration probe. Token is accepted from stdin, never argv/env/files. */
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,mkdirSync,chmodSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {CreatorFeedbackClient} from '../server/creator-feedback-client';
import {runFeedbackSync,readFeedbackGame,readFeedbackReviewHistory,readFeedbackStatus,readFeedbackRules} from '../server/creator-feedback-sync';

process.umask(0o077);
const dir=resolve(process.argv[2]||'artifacts/creator-feedback-local');
mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
let token='';for await(const chunk of process.stdin){token+=chunk.toString();if(token.length>4096)throw new Error('Credential input too large.');}token=token.trim();
if(!token)throw new Error('Dedicated credential required on stdin.');
const started=Date.now(),sql=new DatabaseSync(join(dir,'feedback.sqlite'));
chmodSync(join(dir,'feedback.sqlite'),0o600);
sql.exec('CREATE TABLE IF NOT EXISTS local_migration_log(name TEXT PRIMARY KEY)');
for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort()){
 if(sql.prepare('SELECT name FROM local_migration_log WHERE name=?').get(name))continue;
 sql.exec('BEGIN');try{sql.exec(readFileSync(`migrations/${name}`,'utf8'));sql.prepare('INSERT INTO local_migration_log VALUES(?)').run(name);sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}
}
const DB:any={prepare(query:string){let params:any[]=[];const s:any={bind(...p:any[]){params=p;return s;},first:async()=>sql.prepare(query).get(...params)||null,all:async()=>({results:sql.prepare(query).all(...params)}),run:async()=>s.execute(),execute(){const r=sql.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}};}};return s;},batch:async(ss:any[])=>{sql.exec('BEGIN');try{const r=ss.map(s=>s.execute());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
const tables=(sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'creator_feedback_%' ORDER BY name").all() as {name:string}[]).map(t=>t.name);
const preserved=tables.map(t=>JSON.stringify(sql.prepare(`SELECT * FROM ${t}`).all()));
const requests:Record<string,number>={},statuses:Record<string,number>={},shapes:Record<string,string[]>={};
const fetcher:typeof fetch=async(input,init)=>{
 const url=new URL(String(input)),path=url.pathname.replace('/api/integrations/feedback/v1','');
 if(url.origin!=='https://creator-hub-7mi.pages.dev'||!/^(\/contract|\/snapshots|\/games|\/changes|\/rules)$/.test(path))throw new Error('Probe endpoint blocked.');
 requests[path]=(requests[path]||0)+1;
 const response=await fetch(input,init);statuses[response.status]=(statuses[response.status]||0)+1;
 return response;
};
const client=new CreatorFeedbackClient(token,{fetcher});
const env={DB,CREATOR_FEEDBACK_ENABLED:'true',CREATOR_FEEDBACK_TOKEN:token};token='';
const save=(name:string,value:unknown)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
let contract:any=null,complete=false,steps=0,failed:string|null=null;
try{
 contract=await client.contract();save('contract.json',contract);
 for(;steps<250;steps++){
  const before:any=await readFeedbackStatus(DB);
  const delay=Math.max(0,(before.nextRunAt||0)-Date.now());
  if(delay>0)await new Promise(r=>setTimeout(r,Math.min(delay,60_000)));
  if((before.nextRunAt||0)>Date.now())continue;
  const result=await runFeedbackSync(env,{client});
  if(result.status==='auth_revoked'||result.status==='backoff'){failed=result.errorCode;break;}
  if(steps%10===0)process.stdout.write(JSON.stringify({phase:result.phase,games:sql.prepare('SELECT count(*) n FROM creator_feedback_games').get()!.n,steps})+'\n');
  if(before.phase==='delta'&&result.phase==='delta'&&(result.nextRunAt||0)-Date.now()>60_000){complete=true;break;}
 }
}catch{failed='probe_failed';}
const ids=(sql.prepare('SELECT game_id FROM creator_feedback_games ORDER BY game_id').all() as any[]).map(r=>r.game_id);
let versions=0,reviews=0,reviewRevisions=0,comments=0,archived=0,emptyFeedback=0,unscored=0,zeroScore=0,unknownRole=0,unknownRule=0;
const stages:Record<string,number>={},versionIds=new Set<string>();
const exportedGames=[];
for(const id of ids){const game=await readFeedbackGame(DB,id),reviewHistory=await readFeedbackReviewHistory(DB,id);exportedGames.push({game,reviewHistory});for(const key of ['versions','reviews','comments'])for(const row of game[key])shapes[key]=[...new Set([...(shapes[key]||[]),...Object.keys(row)])].sort();versions+=game.versions.length;reviews+=game.reviews.length;comments+=game.comments.length;archived+=Number(game.archived);for(const v of game.versions){versionIds.add(v.id);unknownRule+=Number(v.ruleVersion===null);}for(const r of game.reviews){stages[r.stage]=(stages[r.stage]||0)+1;emptyFeedback+=Number(r.feedback==='');unscored+=Number(!r.scored);zeroScore+=Number(r.scores.some((s:any)=>s.score===0));unknownRole+=Number(r.reviewerRole===null);}reviewRevisions+=reviewHistory.length;}
const evidence={verifiedAt:new Date().toISOString(),localOnly:true,complete,failed,elapsedMs:Date.now()-started,steps,requests,statuses,shapes,counts:{games:ids.length,versions,uniqueVersions:versionIds.size,reviews,reviewRevisions,comments,archived,emptyFeedback,unscored,zeroScore,unknownRole,unknownRule,stages},status:await readFeedbackStatus(DB),source:{scopeRevision:contract?.scopeRevision,historySince:contract?.historySince,historyGaps:contract?.historyGaps,fileVersionCount:contract?.fileVersionCount},existingTablesUnchanged:tables.every((t,i)=>JSON.stringify(sql.prepare(`SELECT * FROM ${t}`).all())===preserved[i]),modelCalls:0,fileDownloads:0,limitations:['Local Node SQLite adapter, not a deployed D1/DO execution.','No source game/review mutations used to test live change events.','Initial full snapshot plus delta read does not establish production 15-minute SLA.']};
save('verification.json',evidence);process.stdout.write(JSON.stringify(evidence)+'\n');
save('feedback-export.json',{schemaVersion:1,exportedAt:evidence.verifiedAt,complete,source:'https://creator-hub-7mi.pages.dev/api/integrations/feedback/v1',contract,status:evidence.status,rules:await readFeedbackRules(DB),interpretation:'Source judgments only, not independently reproduced defect labels. No automatic publication.',games:exportedGames});
env.CREATOR_FEEDBACK_TOKEN='';sql.close();if(!complete)process.exitCode=1;
