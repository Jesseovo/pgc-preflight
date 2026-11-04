import {afterEach,it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const since='2026-11-04T00:00:00.000Z';
const task={jobId:'job-failed',ownerId:'synthetic-owner',createdAt:'2026-11-04T00:01:00.000Z',updatedAt:'2026-11-04T00:02:00.000Z',status:'error',executor:'agent',mode:'basic',inputHash:'a'.repeat(64),startedAt:'2026-11-04T00:01:01.000Z',finishedAt:'2026-11-04T00:02:00.000Z',outcome:'error',model:null,effort:null,configHash:null,configurationOrigin:null,reportId:null,reportCreatedAt:null,reportHash:null,report:null,reportHashBasis:'stored-result-utf8',reportParseError:false,evidenceHash:null,link:null};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'pgc-natural-'));dirs.push(root);
 const policy=join(root,'policy.json'),snapshot=join(root,'snapshot.json');
 await writeFile(policy,JSON.stringify({schemaVersion:1,kind:'prospective_natural_submission_collection_policy',userChoice:'gray_members_future_real_submissions',frozenAt:since}));
 const snap={schemaVersion:1,kind:'natural-review-snapshot',since,capturedAt:'2026-11-04T00:03:00.000Z',complete:true,totalObserved:1,truncated:false,tasks:[task]};await writeFile(snapshot,JSON.stringify(snap));
 const run=(out:string,previous?:string)=>execFileSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/collect-natural-reviews.ts'),'--policy',policy,'--snapshot',snapshot,...previous?['--previous',previous]:[],'--out',join(root,out)],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 return {root,policy,snapshot,snap,run};
}
it('writes private observations without dropping a failed unlinked task and refuses overwrite',async()=>{
 const f=await fixture();f.run('first');const path=join(f.root,'first/ledger.json'),raw=await readFile(path,'utf8'),ledger=JSON.parse(raw);
 expect(ledger.tasks).toHaveLength(1);expect(ledger.accuracy).toBeNull();expect(ledger.status).toBe('collecting_not_evaluated');
 expect((await stat(path)).mode&0o777).toBe(0o600);expect((await stat(join(f.root,'first'))).mode&0o777).toBe(0o700);
 expect(()=>f.run('first')).toThrow();expect(await readFile(path,'utf8')).toBe(raw);
 f.snap.capturedAt='2026-11-04T00:04:00.000Z';f.snap.tasks=[];f.snap.totalObserved=0;await writeFile(f.snapshot,JSON.stringify(f.snap));f.run('second',path);
 const next=JSON.parse(await readFile(join(f.root,'second/ledger.json'),'utf8'));expect(next.tasks).toHaveLength(1);expect(next.tasks[0].missingFromLatest).toBe(true);expect(next.accuracy).toBeNull();
});
it('rejects changed policy or an observation window predating collection without creating output',async()=>{
 const f=await fixture();f.run('first');await writeFile(f.policy,JSON.stringify({schemaVersion:1,kind:'prospective_natural_submission_collection_policy',userChoice:'gray_members_future_real_submissions',frozenAt:since,changed:true}));
 expect(()=>f.run('changed',join(f.root,'first/ledger.json'))).toThrow();await expect(stat(join(f.root,'changed'))).rejects.toThrow();
 f.snap.since='2026-11-03T00:00:00.000Z';await writeFile(f.snapshot,JSON.stringify(f.snap));expect(()=>f.run('wrong-window')).toThrow();await expect(stat(join(f.root,'wrong-window'))).rejects.toThrow();
});
