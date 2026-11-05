import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,expect,it} from 'vitest';
import {adminPublishMechanismSummary,adminResolveMechanism,chooseMechanism,listMechanisms,mechanismCheckStatus,mechanismMatches,prepareMechanismExpansion,recordMechanismJudgment} from '../server/forge-mechanisms';
import {prepareArtifact,reserveDraw,saveArtifact} from '../server/forge-workspace';

const databases:DatabaseSync[]=[];
afterEach(()=>{for(const sqlite of databases.splice(0))sqlite.close();});
const platform={executor:'platform'} as const;
function setup(){
  const sqlite=new DatabaseSync(':memory:');
  databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(name=>name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const DB={
    prepare(sql:string){
      const statement=(...params:any[])=>{
        const query=()=>sqlite.prepare(sql);
        const execute=()=>{
          const result=query().run(...params);
          return {meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};
        };
        return {first:async()=>query().get(...params)||null,all:async()=>({results:query().all(...params)}),run:async()=>execute(),execute};
      };
      return {...statement(),bind:statement};
    },
    async batch(statements:{execute:()=>unknown}[]){
      sqlite.exec('BEGIN');
      try{const result=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return result;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  };
  for(const id of ['a','b']){
    sqlite.prepare(`INSERT INTO members(id,username,display_name,password_hash,password_salt,star,created_at,updated_at)
      VALUES(?,?,?,'hash','salt',1,'now','now')`).run(id,id,id);
  }
  for(const [dim,word] of [['medium','pixel'],['gesture','tap'],['structure','rhythm'],['mood','calm']])
    sqlite.prepare('INSERT INTO vocab(dim,word) VALUES(?,?)').run(dim,word);
  sqlite.exec(`INSERT INTO games(title,subject,descr,owner_id) VALUES('PRIVATE_HISTORY','shared motif','PRIVATE_DESCRIPTION','b')`);
  return {sqlite,DB};
}
const card=(index:number,overrides:Record<string,unknown>={})=>({
  subject:'shared motif',action:`Tap when signal ${index} appears`,rule:`Match the pulse ${index} to avoid losing a life`,structure:'timing trials',
  title:`PRIVATE_CARD ${index}`,logline:'Steer signals in a timing challenge.',medium:'pixel',gesture:'tap',mood:'calm',
  core_loop:'Read cue, tap, adjust timing.',controls:'Tap the target.',twist:'Signals reflect from walls.',progression:'Add echo patterns.',
  art_direction:'Off-register pixels.',audio:'Synth clicks.',why_addictive:'Practice new timing windows.',risks:'Mistiming costs a life.',
  strength:'Playability through timing variation.',palette:['#303030','#206021','#ffffff'],keywords:['timing','pulse','echo'],...overrides,
});
const expansion=(overrides:Record<string,unknown>={})=>({candidates:[card(0,overrides),...Array.from({length:7},(_,index)=>card(index+1))],recommended:[0,1,2]});
async function seed(s:ReturnType<typeof setup>,owner:string,overrides:Record<string,unknown>={}){
  const [topic]=await reserveDraw(s.DB,owner,{creative_version:2,request_id:crypto.randomUUID(),subject:'shared motif',requirements:'PRIVATE_REQUIREMENTS'});
  const content=await prepareArtifact('expand',expansion(overrides),{topic});
  const version=await saveArtifact(s.DB,{owner,topicId:topic.id,kind:'expand',content,revision:0,executor:'platform',model:'generator'});
  return {topic,version,target:{topic_id:topic.id,candidate_index:0}};
}
function judgment(check:Awaited<ReturnType<typeof mechanismMatches>>,verdict:'distinct'|'duplicate'|'uncertain'){
  return {matches:check.matches.map(match=>({
    match_id:match.id,verdict,reason:'Actual model comparison of how players time inputs and what consequences follow.',
    evidence:(verdict==='uncertain'?[]:['action','rule'] as const).map(field=>({
      field,candidate_quote:check.candidate[field],catalog_quote:match[field],
    })),
  }))};
}
describe('versioned creative mechanism registry',()=>{
  it('draws private seeds idempotently and validates candidate and recommendation counts',async()=>{
    const s=setup(),request_id=crypto.randomUUID();
    const data={request_id,creative_version:2,subject:'shared motif'};
    const [first,second]=await Promise.all([reserveDraw(s.DB,'a',data),reserveDraw(s.DB,'a',data)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject([{subject:'shared motif',creative_version:2,status:'drawn'}]);
    await expect(reserveDraw(s.DB,'a',{...data,subject:'another motif'})).rejects.toMatchObject({status:409});
    await expect(reserveDraw(s.DB,'a',{request_id,subject:'shared motif'})).rejects.toMatchObject({status:409});
    await expect(reserveDraw(s.DB,'b',{request_id,subject:'shared motif'})).rejects.toMatchObject({status:409});
    expect(()=>prepareMechanismExpansion({...expansion(),recommended:[0,1,2,3]})).toThrow('最多推荐');
    expect(()=>prepareMechanismExpansion({...expansion(),candidates:[card(0)]})).toThrow('8–12');
    expect(await listMechanisms(s.DB)).toEqual({revision:0,items:[],next:null});
  });

  it('keeps unselected cards and private history out of the catalogue',async()=>{
    const s=setup(),a=await seed(s,'a');
    await expect(mechanismMatches(s.DB,'b',a.target,platform)).rejects.toMatchObject({status:404});
    expect(await listMechanisms(s.DB)).toEqual({revision:0,items:[],next:null});
    const check=await mechanismMatches(s.DB,'a',a.target,platform);
    expect(check.state).toBe('no_matches');
    const target={...a.target,check_id:check.check_id};
    const chosen=await chooseMechanism(s.DB,'a',target);
    expect(await chooseMechanism(s.DB,'a',target)).toEqual(chosen);
    expect(s.sqlite.prepare('SELECT owner_id,status,score,origin,requirements FROM topics WHERE id=?').get(chosen.topic_id))
      .toEqual({owner_id:'a',status:'liked',score:null,origin:'mechanism-choice',requirements:'PRIVATE_REQUIREMENTS'});
    expect(s.sqlite.prepare('SELECT status,score FROM topics WHERE id=?').get(a.topic.id)).toEqual({status:'drawn',score:null});
    const catalogue=await listMechanisms(s.DB);
    expect(catalogue.items).toEqual([{id:1,subject:'shared motif',action:card(0).action,rule:card(0).rule,structure:card(0).structure}]);
    expect(JSON.stringify(catalogue)).not.toContain('PRIVATE');
  });

  it('atomically excludes identical action/rule/structure regardless of title or subject',async()=>{
    const s=setup(),a=await seed(s,'a'),b=await seed(s,'b',{subject:'different motif',action:'TAP when signal 0 appears!'});
    const [one,two]=await Promise.all([mechanismMatches(s.DB,'a',a.target,platform),mechanismMatches(s.DB,'b',b.target,platform)]);
    const result=await Promise.allSettled([
      chooseMechanism(s.DB,'a',{...a.target,check_id:one.check_id}),
      chooseMechanism(s.DB,'b',{...b.target,check_id:two.check_id}),
    ]);
    expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect(result.find(item=>item.status==='rejected')).toMatchObject({reason:{status:409}});
    expect(s.sqlite.prepare("SELECT count(*) n FROM topics WHERE origin='mechanism-choice'").get()).toMatchObject({n:1});
    const [owner,target]=result[0].status==='rejected'?['a',a.target] as const:['b',b.target] as const;
    expect((await mechanismMatches(s.DB,owner,target,platform)).state).toBe('exact');
  });

  it('requires model comparisons for retrieved similarities and allows the same subject with distinct rules',async()=>{
    const s=setup(),a=await seed(s,'a'),b=await seed(s,'b',{rule:'Match the pulse to gain energy. Mistiming inverts controls.'});
    const one=await mechanismMatches(s.DB,'a',a.target,platform);
    await chooseMechanism(s.DB,'a',{...a.target,check_id:one.check_id});
    const two=await mechanismMatches(s.DB,'b',b.target,platform);
    expect(two).toMatchObject({state:'pending',matches:[{id:1}]});
    await expect(chooseMechanism(s.DB,'b',{...b.target,check_id:two.check_id})).rejects.toMatchObject({status:409});
    const fabricated=judgment(two,'distinct');
    fabricated.matches[0].evidence[0].candidate_quote='no such text';
    await expect(recordMechanismJudgment(s.DB,'b',{check_id:two.check_id,judgment:fabricated,model:'test'},platform)).rejects.toThrow('原文');
    const claims=judgment(two,'distinct');
    expect(await recordMechanismJudgment(s.DB,'b',{check_id:two.check_id,judgment:claims,model:'test'},platform))
      .toMatchObject({state:'distinct',model:{provenance:'platform-executed'}});
    await chooseMechanism(s.DB,'b',{...b.target,check_id:two.check_id});
    const catalogue=await listMechanisms(s.DB,{limit:1});
    expect(catalogue).toMatchObject({revision:2,items:[{subject:'shared motif'}],next:1});
    expect((await listMechanisms(s.DB,{after:catalogue.next!})).items).toMatchObject([{subject:'shared motif'}]);
  });

  it('rejects stale directory checks even for distinct signatures',async()=>{
    const s=setup(),a=await seed(s,'a'),b=await seed(s,'b',{rule:'A click freezes moving obstacles but spends energy.'});
    const one=await mechanismMatches(s.DB,'a',a.target,platform);
    const two=await mechanismMatches(s.DB,'b',b.target,platform);
    await chooseMechanism(s.DB,'a',{...a.target,check_id:one.check_id});
    await expect(chooseMechanism(s.DB,'b',{...b.target,check_id:two.check_id})).rejects.toThrow('目录已更新');
    const current=await mechanismMatches(s.DB,'b',b.target,platform);
    expect(current.revision).toBe(1);
    await recordMechanismJudgment(s.DB,'b',{check_id:current.check_id,judgment:judgment(current,'duplicate'),model:'test'},platform);
    await expect(chooseMechanism(s.DB,'b',{...b.target,check_id:current.check_id})).rejects.toThrow('重复');
  });

  it('binds a model comparison to the device and current candidate version',async()=>{
    const s=setup(),a=await seed(s,'a'),b=await seed(s,'b',{rule:'Freezing objects costs energy.'});
    const one=await mechanismMatches(s.DB,'a',a.target,platform);
    await chooseMechanism(s.DB,'a',{...a.target,check_id:one.check_id});
    for(const id of ['device-one','device-two'])s.sqlite.prepare(`INSERT INTO forge_agents(id,owner_id,session_version,token_hash,pairing_hash,name,expires_at,created_at)
      VALUES(?,'b',1,?,?,'device','2100-01-01','now')`).run(id,id,id);
    const source={executor:'agent',deviceId:'device-one'} as const;
    const two=await mechanismMatches(s.DB,'b',b.target,source);
    const report={check_id:two.check_id,judgment:judgment(two,'distinct'),model:'declared-model'};
    await expect(recordMechanismJudgment(s.DB,'b',report,{...source,deviceId:'device-two'})).rejects.toMatchObject({status:403});
    expect(await recordMechanismJudgment(s.DB,'b',report,source)).toMatchObject({model:{provenance:'member-agent-declared'}});
    s.sqlite.prepare('UPDATE topics SET content_revision=content_revision+1 WHERE id=?').run(b.topic.id);
    await expect(chooseMechanism(s.DB,'b',{...b.target,check_id:two.check_id})).rejects.toMatchObject({status:409});
  });

  it('publishes only explicitly submitted historical summaries and indexes them',async()=>{
    const s=setup(),a=await seed(s,'a');
    const {subject,action,rule,structure}=card(0);
    const published=await adminPublishMechanismSummary(s.DB,{subject,action,rule,structure,reason:'PRIVATE_ADMIN_REASON'});
    expect(published).toEqual({revision:1,item:{id:1,subject,action,rule,structure}});
    await expect(adminPublishMechanismSummary(s.DB,{subject:'other subject',action,rule,structure,reason:'already present'})).rejects.toMatchObject({status:409});
    expect(await listMechanisms(s.DB)).toEqual({revision:1,items:[published.item],next:null});
    const exact=await mechanismMatches(s.DB,'a',a.target,platform);
    expect(exact.state).toBe('exact');
    await expect(adminResolveMechanism(s.DB,{check_id:exact.check_id,verdict:'distinct',reason:'cannot overrule the signature'})).rejects.toMatchObject({status:409});
    await expect(chooseMechanism(s.DB,'a',{...a.target,check_id:exact.check_id})).rejects.toMatchObject({status:409});
    const b=await seed(s,'b',{rule:'Tap to spend an energy charge and restore an obstacle.'});
    expect(await mechanismMatches(s.DB,'b',b.target,platform)).toMatchObject({state:'pending',matches:[published.item]});
  });

  it('keeps immutable administrator decisions separate and checks their catalogue revision',async()=>{
    const s=setup(),a=await seed(s,'a'),b=await seed(s,'b',{rule:'Tap to spend an energy charge and restore an obstacle.'});
    const baseline=await mechanismMatches(s.DB,'a',a.target,platform);
    await chooseMechanism(s.DB,'a',{...a.target,check_id:baseline.check_id});
    const two=await mechanismMatches(s.DB,'b',b.target,platform);
    await recordMechanismJudgment(s.DB,'b',{check_id:two.check_id,judgment:judgment(two,'duplicate'),model:'test'},platform);
    const decision={check_id:two.check_id,verdict:'distinct' as const,reason:'Restoring obstacles spends a charge, which changes the risk and reward.'};
    const resolved=await adminResolveMechanism(s.DB,decision);
    expect(resolved).toMatchObject({state:'duplicate',effective_state:'distinct',admin_resolution:{verdict:'distinct'},model:{name:'test'}});
    expect(await adminResolveMechanism(s.DB,decision)).toEqual(resolved);
    await expect(adminResolveMechanism(s.DB,{...decision,verdict:'duplicate'})).rejects.toThrow('不能覆盖');
    await expect(mechanismCheckStatus(s.DB,'a',two.check_id)).rejects.toMatchObject({status:404});
    const {subject,action,structure}=card(0);
    await adminPublishMechanismSummary(s.DB,{subject,action,structure,rule:'Risk an extra charge to speed up the next cue.',reason:'Published summary'});
    expect(await mechanismCheckStatus(s.DB,'b',two.check_id)).toMatchObject({stale:true,effective_state:'distinct'});
    await expect(chooseMechanism(s.DB,'b',{...b.target,check_id:two.check_id})).rejects.toThrow('目录已更新');
    const fresh=await mechanismMatches(s.DB,'b',b.target,platform);
    await recordMechanismJudgment(s.DB,'b',{check_id:fresh.check_id,judgment:judgment(fresh,'duplicate'),model:'test'},platform);
    await adminResolveMechanism(s.DB,{...decision,check_id:fresh.check_id});
    await expect(chooseMechanism(s.DB,'b',{...b.target,check_id:fresh.check_id})).resolves.toMatchObject({revision:3});
  });
});
