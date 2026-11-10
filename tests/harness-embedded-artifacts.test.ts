import {DatabaseSync} from 'node:sqlite';
import {afterEach,expect,it} from 'vitest';
import {archiveEmbeddedArtifact,purgeEmbeddedArtifacts} from '../server/harness-embedded-artifacts';
import {harnessHash} from '../server/harness-policy';

const opened:DatabaseSync[]=[];
afterEach(()=>opened.splice(0).forEach(db=>db.close()));
function setup(){
  const sqlite=new DatabaseSync(':memory:');opened.push(sqlite);
  sqlite.exec('CREATE TABLE harness_embedded_artifacts(task_id,generation,phase,path,content_hash,part,content,created_at,PRIMARY KEY(task_id,generation,phase,path,content_hash,part))');
  const DB={prepare(sql:string){return {bind(...args:any[]){const q=sqlite.prepare(sql);return {
    first:async()=>q.get(...args),run:async()=>q.run(...args),
  };}}},async batch(parts:{run:()=>Promise<unknown>}[]){sqlite.exec('BEGIN');try{for(const part of parts)await part.run();sqlite.exec('COMMIT');}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const identity={taskId:'synthetic',generation:'generation',phase:'build'};
  const file=async(content:string)=>({path:'game.html',content,sha256:await harnessHash(content)});
  const content=()=>sqlite.prepare('SELECT content FROM harness_embedded_artifacts ORDER BY part').all().map(row=>row.content).join('');
  return {sqlite,DB,identity,file,content};
}
it('keeps Unicode bytes and immutable versions, with exact duplicate saves idempotent',async()=>{
  const s=setup(),original='x'.repeat(23999)+'🐈'+'y'.repeat(24000),file=await s.file(original);
  await archiveEmbeddedArtifact(s.DB,s.identity,file);await archiveEmbeddedArtifact(s.DB,s.identity,file);
  expect(s.content()).toBe(original);expect(await harnessHash(s.content())).toBe(file.sha256);
  expect(s.sqlite.prepare('SELECT count(*) n FROM harness_embedded_artifacts').get()).toMatchObject({n:3});
  const next=await s.file(original+' changed');await archiveEmbeddedArtifact(s.DB,s.identity,next);
  expect(s.sqlite.prepare('SELECT count(DISTINCT content_hash) n FROM harness_embedded_artifacts').get()).toMatchObject({n:2});
  await expect(archiveEmbeddedArtifact(s.DB,s.identity,{...file,content:'wrong'})).rejects.toThrow('invalid');
});
it('does not leave a partially archived revision when one D1 chunk fails',async()=>{
  const s=setup(),file=await s.file('x'.repeat(50000));
  s.sqlite.exec("CREATE TRIGGER fail_chunk BEFORE INSERT ON harness_embedded_artifacts WHEN NEW.part=1 BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
  await expect(archiveEmbeddedArtifact(s.DB,s.identity,file)).rejects.toThrow('synthetic write failure');
  expect(s.sqlite.prepare('SELECT count(*) n FROM harness_embedded_artifacts').get()).toMatchObject({n:0});
});
it('expires temporary workspace content at 24 hours without removing fresh revisions',async()=>{
  const s=setup(),now=Date.now();
  await archiveEmbeddedArtifact(s.DB,s.identity,await s.file('old'));
  s.sqlite.prepare('UPDATE harness_embedded_artifacts SET created_at=?').run(now-86400000);
  await archiveEmbeddedArtifact(s.DB,s.identity,await s.file('fresh'));
  await purgeEmbeddedArtifacts(s.DB,now);
  expect(s.content()).toBe('fresh');
});
