import {afterEach,describe,it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const dirs:string[]=[];afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const h='a'.repeat(64),e='e'.repeat(64);
const report=(yes:boolean)=>({schema_version:2,assessment_status:'complete',aes:yes?3:2,ease:2,play:2,score_reasons:{aes:'Synthetic',ease:'Synthetic',play:'Synthetic'},uncertainties:[],verdict:yes?'通过':'打回',reviewer_comment:'Synthetic',strengths:[],issues:[],fix_prompt:'无需强制修改',optional_suggestions:[]});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'pgc-outcome-'));dirs.push(root);
 const cases=Array.from({length:100},(_,i)=>({caseId:`case-${i}`,workId:`game-${i}`,versionId:`version-${i}`,split:'holdout',executor:'agent',mode:'basic',modelConfigHash:h,rulesHash:h,calibrationHash:h,inputHash:h}));
 const games=cases.map((c,i)=>{const yes=i<50;return {game:{id:c.workId,deleted:false,archived:false,status:yes?'approved':'rejected',versions:[{id:c.versionId,status:yes?'approved':'rejected',withdrawn:false,ruleVersion:1,finalReviewId:`review-${i}`,fileAccess:false}],reviews:[{id:`review-${i}`,versionId:c.versionId,revision:1,stage:'decision_review',reviewerRole:null,effective:true,deleted:false,revoked:false,reopened:false,decision:yes?'approved':'rejected'}]}};});
 const source=join(root,'source.json'),registry=join(root,'registry.json');
 await writeFile(source,JSON.stringify({complete:true,contract:{scopeRevision:3},games}));await writeFile(registry,JSON.stringify({cases}));
 const run=(cmd:string,options:string[])=>execFileSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/review-outcome-eval.ts'),cmd,'--source',source,...options],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 run('freeze',['--registry',registry,'--out',join(root,'frozen')]);
 const manifest=join(root,'frozen/manifest.json'),manifestHash=sha(await readFile(manifest,'utf8'));
 const predictions={manifestSha256:manifestHash,cases:cases.map((c,i)=>({caseId:c.caseId,finishedAt:new Date(Date.now()+1000).toISOString(),inputHash:h,evidenceHash:e,rulesHash:h,calibrationHash:h,prediction:{status:'done',report:report(i<50),modelConfigHash:h}}))};
 const audits={manifestSha256:manifestHash,cases:cases.map(c=>({caseId:c.caseId,evidenceHash:e,qualification:{status:'verified',auditId:`synthetic-${c.caseId}`,reasons:[]},quality:{audited:true,unsupportedMandatory:0,incorrectReasons:0,criticalRegression:false,unknownIncreaseExplained:true}}))};
 const pp=join(root,'predictions.json'),ap=join(root,'audits.json');
 const evaluate=async(name:string)=>{await writeFile(pp,JSON.stringify(predictions));await writeFile(ap,JSON.stringify(audits));run('evaluate',['--manifest',manifest,'--predictions',pp,'--audits',ap,'--out',join(root,name)]);return JSON.parse(await readFile(join(root,name,'evaluation.json'),'utf8'));};
 return {root,run,registry,manifest,predictions,audits,evaluate};
}
describe('offline evaluation registration integrity',()=>{
 it('keeps deleted prediction records as missing in the preregistered denominator',async()=>{const f=await fixture();f.predictions.cases.splice(0,10);const result=await f.evaluate('missing');expect(result.enrolled).toBe(100);expect(result.predictionsProvided).toBe(90);expect(result.metrics[0]).toMatchObject({denominator:100,correct:90,missing:10});expect(result.metrics[0].acceptance.passed).toBe(false);});
 it('rejects a modified registration digest and changed evidence',async()=>{const f=await fixture();f.predictions.manifestSha256='f'.repeat(64);await expect(f.evaluate('tamper')).rejects.toThrow();f.predictions.manifestSha256=f.audits.manifestSha256;f.audits.cases[0].evidenceHash='b'.repeat(64);await expect(f.evaluate('evidence')).rejects.toThrow();});
 it('rejects reports from before registration and does not overwrite frozen files',async()=>{const f=await fixture();f.predictions.cases[0].finishedAt='2020-01-01T00:00:00Z';await expect(f.evaluate('early')).rejects.toThrow();expect(()=>f.run('freeze',['--registry',f.registry,'--out',join(f.root,'frozen')])).toThrow();});
 it('reports missing independent audits as unverified, not a perfect score',async()=>{const f=await fixture();f.audits.cases=[];const r=await f.evaluate('unverified');expect(r.metrics[0].accuracy).toBeNull();expect(r.metrics[0].acceptance.passed).toBe(false);expect(r.qualificationBoundary).toContain('不认证');});
});
