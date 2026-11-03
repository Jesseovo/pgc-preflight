import {describe,it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {acquireCaptureLock,exportShots,allowCommand,loadFrozenBaseline,loadInformedVerification,offlineContextArtifact} from '../scripts/review-offline-session';

import {AdaptivePlay} from '../scripts/review-adaptive';

describe('offline review session boundaries',()=>{
  it('serializes local captures and releases only its own lock',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'pgc-session-test-')),path=join(dir,'capture.lock');
    try{const release=await acquireCaptureLock(path);await expect(acquireCaptureLock(path)).rejects.toThrow('已有');await release();const next=await acquireCaptureLock(path);await release();await expect(acquireCaptureLock(path)).rejects.toThrow('已有');await next();}finally{await rm(dir,{recursive:true,force:true});}
  });
  it('recovers a dead pid and makes the lock private',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'pgc-session-test-')),path=join(dir,'capture.lock');
    try{await writeFile(path,JSON.stringify({pid:2147483647,id:'dead'}));const release=await acquireCaptureLock(path);expect((await stat(path)).mode&0o777).toBe(0o600);await release();}finally{await rm(dir,{recursive:true,force:true});}
  });
  it('exports every intermediate gesture image with exact byte hashes and no data URI',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'pgc-session-test-'));
    try{const shots=await exportShots(dir,['a','b','c'].map((s,i)=>({id:`supplemental-${i+1}`,label:s,data:`data:image/jpeg;base64,${Buffer.from(s).toString('base64')}`,actionOffsetMs:i*500})));
      expect(shots).toHaveLength(3);for(const [i,shot]of shots.entries()){expect(shot).not.toHaveProperty('data');expect(shot.actionOffsetMs).toBe(i*500);expect(shot.imageSha256).toBe(createHash('sha256').update(await readFile(shot.path)).digest('hex'));expect((await stat(shot.path)).mode&0o777).toBe(0o600);}
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('reuses exactly four frozen basic originals and rejects changed input or image bytes',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'pgc-session-test-'));
    try{const screenshots=await exportShots(dir,['a','b','c','d'].map((s)=>({label:s,data:`data:image/jpeg;base64,${Buffer.from(s).toString('base64')}`})));
      const baselinePath=join(dir,'baseline.json');await writeFile(baselinePath,JSON.stringify({inputHash:'expected',contextOrigin:'independent-basic-capture',screenshots,probe:{},source:'not exported by loader'}));
      await expect(loadFrozenBaseline(baselinePath,'different',dir)).rejects.toThrow('输入哈希');
      const loaded=await loadFrozenBaseline(baselinePath,'expected',dir);expect(loaded.screenshots.map(s=>s.imageSha256)).toEqual(screenshots.map(s=>s.imageSha256));expect(loaded).not.toHaveProperty('source');
      await writeFile(screenshots[0].path,'changed');await expect(loadFrozenBaseline(baselinePath,'expected',dir)).rejects.toThrow('原图哈希');
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('loads explicit exposure provenance and selects a separate manifest context artifact',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'pgc-session-test-')),path=join(dir,'context.json');
    const input={purpose:'Reproduce a historical control issue',source_exposure:true,history_exposure:true,origin_session_manifest_sha256:'a'.repeat(64),claims:['Does dragging interrupt a shot?']};
    try{
      await writeFile(path,JSON.stringify(input));
      const verification=await loadInformedVerification(path);
      const play=new AdaptivePlay({} as any,'source',{offlineInformedVerification:verification});
      expect(offlineContextArtifact(play)).toEqual({contextOrigin:'informed-verification',sourceBlind:false,filename:'verification-context.json',value:{...input,contextOrigin:'informed-verification',sourceBlind:false}});
      expect(offlineContextArtifact(new AdaptivePlay({} as any,'source'))).toEqual({contextOrigin:'source-blind-adaptive',sourceBlind:true,filename:'first-look.json',value:null});
      await writeFile(path,JSON.stringify({...input,source_exposure:false}));
      await expect(loadInformedVerification(path)).rejects.toThrow('知情核验');
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('rejects navigation, eval and platform/model commands',()=>{
    for(const action of ['navigate','eval','fetch','review','complete','http://example.com'])expect(()=>allowCommand(action)).toThrow();
    for(const action of ['first-look','act','observe','analyze','finish','close'])expect(()=>allowCommand(action)).not.toThrow();
  });
});
