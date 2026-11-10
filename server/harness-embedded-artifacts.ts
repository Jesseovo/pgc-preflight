import {harnessHash} from './harness-policy';

/** Temporary private workspace history. Formal versions still use artifact_versions. */
export async function archiveEmbeddedArtifact(DB:any, id:{taskId:string;generation:string;phase:string}, file:{path:string;content:string;sha256:string}) {
  if(!['game.html','record.json','result.txt'].includes(file.path)||new TextEncoder().encode(file.content).length>2*1024*1024||await harnessHash(file.content)!==file.sha256)throw new Error('embedded_artifact_invalid');
  const seen=await DB.prepare('SELECT 1 FROM harness_embedded_artifacts WHERE task_id=? AND generation=? AND phase=? AND path=? AND content_hash=? LIMIT 1')
    .bind(id.taskId,id.generation,id.phase,file.path,file.sha256).first();
  if(seen)return;
  const total=await DB.prepare('SELECT coalesce(sum(length(CAST(content AS BLOB))),0) AS bytes FROM harness_embedded_artifacts WHERE task_id=? AND generation=?').bind(id.taskId,id.generation).first();
  if((total?.bytes??0)+new TextEncoder().encode(file.content).length>12*1024*1024)throw new Error('embedded_artifact_storage_limit');
  const at=Date.now(),parts=[];
  // One task runner serializes mutations; the D1 batch commits all chunks or none.
  for(let start=0,part=0;start<file.content.length||part===0;part++){
    let end=Math.min(file.content.length,start+24000);
    // A D1 text value is UTF-8 encoded separately; don't split surrogate pairs.
    if(end<file.content.length&&/[\uD800-\uDBFF]/.test(file.content[end-1]))end--;
    parts.push(DB.prepare(`INSERT OR IGNORE INTO harness_embedded_artifacts
      (task_id,generation,phase,path,content_hash,part,content,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(id.taskId,id.generation,id.phase,file.path,file.sha256,part,file.content.slice(start,end),at));
    start=end;
  }
  await DB.batch(parts);
}

export async function purgeEmbeddedArtifacts(DB:any, now=Date.now()) {
  try{await DB.prepare('DELETE FROM harness_embedded_artifacts WHERE created_at<=?').bind(now-86400000).run();}
  catch(error){if(!/no such table:\s*harness_embedded_artifacts\b/i.test(String(error)))throw error;}
}
