/** Private offline observations only: no source API, model, enrollment or score changes. */
import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {mergeNaturalReviewObservations} from '../server/review-observation';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
async function input(path:string){
 const bytes=await readFile(resolve(path));let value:any;
 try{value=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('输入文件不是完整 JSON。');}
 return {value,hash:sha(bytes)};
}
async function main(){
 const args=process.argv.slice(2),options=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){
  if(!['--policy','--snapshot','--previous','--out'].includes(args[i])||options.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('用法: collect-natural-reviews.ts --policy PRIVATE_POLICY --snapshot PRIVATE_SNAPSHOT [--previous PRIVATE_LEDGER] --out NEW_PRIVATE_DIRECTORY');
  options.set(args[i],args[i+1]);
 }
 if(!options.has('--policy')||!options.has('--snapshot')||!options.has('--out'))throw new Error('必须提供收集口径、完整快照文件及新的私有输出目录。');
 const policy=await input(options.get('--policy')!),snapshot=await input(options.get('--snapshot')!);
 if(policy.value.schemaVersion!==1||policy.value.kind!=='prospective_natural_submission_collection_policy'||policy.value.userChoice!=='gray_members_future_real_submissions')throw new Error('需要已固定的自然投稿收集口径，不能用历史回放清单替代。');
 const previous=options.has('--previous')?await input(options.get('--previous')!):null;
 const ledger=await mergeNaturalReviewObservations(policy.hash,policy.value.frozenAt,snapshot.value,previous?.value);
 // A new directory prevents accidentally replacing any prior observation.
 const out=resolve(options.get('--out')!);await mkdir(out,{mode:0o700});await chmod(out,0o700);
 const bytes=JSON.stringify(ledger,null,2)+'\n';
 await writeFile(join(out,'ledger.json'),bytes,{mode:0o600,flag:'wx'});
 await writeFile(join(out,'receipt.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),privacy:'local_private_do_not_publish',policySha256:policy.hash,snapshotSha256:snapshot.hash,previousLedgerSha256:previous?.hash??null,ledgerSha256:sha(bytes),modelCalls:0,fileDownloads:0,accuracy:null,status:'collecting_not_evaluated',boundary:'连续保存候选任务与来源观察；不认证来源、灰测成员资格、文件绑定、规则可比性或质量结论，不自动成为80%验收结果。'},null,2)+'\n',{mode:0o600,flag:'wx'});
 process.stdout.write(JSON.stringify({output:out,status:'collecting_not_evaluated',accuracy:null,modelCalls:0,fileDownloads:0})+'\n');
}
main().catch(error=>{process.stderr.write((error instanceof Error?error.message:'私有观察记录未完成。')+'\n');process.exitCode=1;});
