import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {advanceCreationPipeline,completeAgentCreation,creationChecks,creationEvidence,creationPipelineAlarm,lockCreationCapture,recordAgentCreationStage,validateAgentCreationCompletion,validateCreationOutput} from '../server/forge-creation-pipeline';
import {digest} from '../server/review-device-state';
import {complete} from '../server/forge-llm';

vi.mock('../server/forge-llm',()=>({complete:vi.fn()}));
const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.resetAllMocks();});
const html=(name:string)=>`<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>${name}<script>document.body.onclick=()=>{}</script></body></html>`;
const at='2026-11-05T00:00:00.000Z';
const output=(name:string,extra={})=>({html:html(name),requirements:[{id:'goal',text:'Show the goal',status:'implemented'}],decisions:[],coreChanges:[],...extra});
const finding=(extra={})=>({id:'issue',kind:'confirmed',phenomenon:'Shows an overlap',trigger:'After touch',evidenceRefs:['build:shot-2'],cause:'layout',minimalChange:'Move the hint',retest:'Repeat the action',coreChange:false,resolved:true,...extra});
const selfCheck=(findings:any[]=[],requestRepair=false)=>({findings,unverified:['Sound is unverified'],changes:[],requestRepair});
const raw=(encoded='YQ==')=>{
  const actions=['9:16','9:19.5','9:21'].map((ratio,i)=>({id:`tap-${i+1}`,ratio,type:'tap',startedAt:at}));
  const shots=[1,2,3,4].map(i=>({id:`shot-${i}`,label:`Full viewport ${i}`,capturedAt:at,actionRefs:i===1?[]:[actions[i-2].id],data:`data:image/jpeg;base64,${encoded}`}));
  return {shots,probe:{captureMethod:'browser-viewport-v1',actions,observations:shots.map(({data,...observation})=>observation)}};
};
const stagePayload=async(stage:string,result:any,model:string|null=null,encoded?:string)=>({stage,model,output:result,capture:{...raw(encoded),inputHash:await digest(result.html)}});

function setup(executor='agent'){
  const sqlite=new DatabaseSync(':memory:');databases.push(sqlite);
  for(const file of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));
  const insertMember=sqlite.prepare("INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,star) VALUES(?,?,?,'fixture','fixture','now','now',1)");
  for(const id of ['owner','other'])insertMember.run(id,id,id);
  sqlite.prepare("INSERT INTO forge_agents(id,owner_id,session_version,token_hash,pairing_hash,name,expires_at,created_at) VALUES('device','owner',1,'fixture','fixture','Fixture',?,'now')").run(new Date(Date.now()+86400000).toISOString());
  sqlite.exec("INSERT INTO topics(id,owner_id,batch,subject,medium,gesture,structure,mood,created_at,updated_at,brief_md) VALUES(1,'owner','fixture','fixture','fixture','fixture','fixture','fixture','now','now','Complete brief')");
  const topic={id:1,data:{title:'Fixture',logline:'Fixture loop',twist:'Fixture trade-off',art_direction:'Fixture art'},brief_md:'Complete brief',requirements:'Keep the goal'};
  const snapshot={topic,revision:0,policy_revision:0,heads:{},cfg:{},creative_version:2};
  const id=crypto.randomUUID(),now=new Date().toISOString();
  sqlite.prepare("INSERT INTO forge_tasks(id,kind,scope,payload,status,owner_id,executor,input_snapshot,created_at,updated_at,creative_version,device_id,receipt_hash) VALUES(?,'game','owner:game:1','{\"type\":\"game\",\"id\":1}',?,'owner',?,?,?,?,2,?,?)")
    .run(id,executor==='agent'?'running':'queued',executor,JSON.stringify(snapshot),now,now,executor==='agent'?'device':null,executor==='agent'?'receipt-hash':null);
  let failWrite='';
  const DB={prepare(sql:string){
    let values:any[]=[];
    const statement={bind(...v:any[]){values=v;return statement;},first:async()=>sqlite.prepare(sql).get(...values)||null,
      all:async()=>({results:sqlite.prepare(sql).all(...values)}),run:async()=>statement.execute(),execute:()=>{
        if(failWrite&&sql.includes(failWrite)){failWrite='';throw new Error('Synthetic transient database failure');}
        return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};
      }};
    return statement;
  },batch:async(statements:any[])=>{
    if(statements.length>100)throw new Error('D1 statement limit');
    sqlite.exec('BEGIN');try{const out=statements.map(s=>s.execute());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
  const data=new Map<string,any>(),alarm={at:0},storage:any={
    get:async(key:string)=>data.get(key),put:async(key:string,value:any)=>{data.set(key,value);},
    delete:async(key:string)=>{data.delete(key);},deleteAll:async()=>{data.clear();},
    setAlarm:async(value:number)=>{alarm.at=value;},transaction:async(fn:any)=>fn(storage),
  };
  const profile={baseUrl:'https://fixture.invalid',model:'claude-opus-5-5',protocol:'anthropic',encryptedKey:'fixture',enabled:true,vision:true};
  const env={DB,modelStore:{get:vi.fn(async()=>({activeProfile:'opus',profiles:{opus:profile}}))},SETTINGS_KEY:'fixture',captureReview:vi.fn(async()=>raw())};
  const row=()=>sqlite.prepare('SELECT * FROM forge_tasks WHERE id=?').get(id) as any;
  return {sqlite,DB,env,storage,state:{storage},id,row,alarm,profile,failWriteOnce:(snippet:string)=>{failWrite=snippet;}};
}
function modelOutput(build:any,polish:any){
  vi.mocked(complete).mockImplementation(async(runtime,_cfg,request)=>{
    await runtime.generation?.onStart();
    const result=runtime.generation?.id.endsWith(':build')?build:polish;
    expect(request.maxAttempts).toBe(1);
    expect(request.requiredProfile).toBe('opus');
    expect(request.validate?.(result)).toEqual([]);
    if(runtime.generation?.id.endsWith(':polish'))expect((request.user as any[]).filter(part=>part.type==='image')).toHaveLength(4);
    return result;
  });
}

describe('staged creation evidence and publication',()=>{
  it('locks raw screenshot bytes and rejects missing, duplicate or invented evidence references',async()=>{
    const capture=await lockCreationCapture(raw(),'build',html('build'));
    expect(capture.shots[0]).toMatchObject({id:'build:shot-1',hash:await digest('a')});
    expect(capture).toMatchObject({inputHash:await digest(html('build')),listeningVerified:false});
    const duplicate=raw();duplicate.shots[1].id=duplicate.shots[0].id;
    await expect(lockCreationCapture(duplicate,'build',html('build'))).rejects.toThrow('编号');
    expect(validateCreationOutput(output('polish',{selfCheck:selfCheck([finding({evidenceRefs:['build:invented']})])}),'polish',capture)).toContain('selfCheck.findings');
    expect(validateCreationOutput(output('repair',{selfCheck:selfCheck([],true)}),'repair',capture)).toContain('selfCheck');
    expect(validateCreationOutput(output('polish',{requirements:[{id:'other',text:'Other',status:'implemented'}],selfCheck:selfCheck()}),'polish',capture,output('build'))).toContain('requirements must retain prior IDs');
    expect(validateCreationOutput(output('polish',{selfCheck:selfCheck()}),'polish',capture,output('build',{coreChanges:['changed core']}))).toContain('coreChanges must retain prior changes');
  });

  it('accepts one concurrent evidence variant and retains immutable, owner-scoped stages',async()=>{
    const s=setup(),row=s.row(),build=output('build');
    const [first,second]=await Promise.all([stagePayload('build',build,null,'YQ=='),stagePayload('build',build,null,'Yg==')]);
    const race=await Promise.allSettled([recordAgentCreationStage(s.DB,row,first),recordAgentCreationStage(s.DB,row,second)]);
    expect(race.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect(race.filter(x=>x.status==='rejected')).toHaveLength(1);
    expect(s.sqlite.prepare('SELECT count(*) n FROM artifact_versions').get()).toEqual({n:1});
    const accepted=race[0].status==='fulfilled'?first:second;
    const saved=await recordAgentCreationStage(s.DB,row,accepted);
    const capture=await creationEvidence(s.DB,'owner',1,s.id,'build');
    expect(capture).toMatchObject({hash:saved.evidence_hash,origin:'member-device'});
    expect(capture.shots[0].data).toBe(accepted.capture.shots[0].data);
    expect((await creationChecks(s.DB,'owner',1))[0].self_check.model).toBeNull();
    await expect(creationEvidence(s.DB,'other',1,s.id,'build')).rejects.toMatchObject({status:404});
    await expect(recordAgentCreationStage(s.DB,row,{...accepted,model:'replaced'})).rejects.toMatchObject({status:409});
  });

  it('rejects early completion and unverified repair, and saves a confirmed core change pending',async()=>{
    const s=setup(),row=s.row(),build=output('build');
    await expect(validateAgentCreationCompletion(s.DB,row,'polish')).rejects.toMatchObject({status:409});
    await recordAgentCreationStage(s.DB,row,await stagePayload('build',build));
    const polished=output('polish',{selfCheck:selfCheck([finding({coreChange:true})])});
    await expect(recordAgentCreationStage(s.DB,row,{...await stagePayload('polish',polished),capture:{...raw(),inputHash:'f'.repeat(64)}})).rejects.toMatchObject({status:409});
    const saved=await recordAgentCreationStage(s.DB,row,await stagePayload('polish',polished,'local-fixture'));
    await expect(validateAgentCreationCompletion(s.DB,row,'polish','other')).rejects.toMatchObject({status:409});
    await expect(recordAgentCreationStage(s.DB,row,await stagePayload('repair',output('repair',{selfCheck:selfCheck()})))).rejects.toMatchObject({status:409});
    const [a,b]=await Promise.all([completeAgentCreation(s.DB,row,'polish','local-fixture'),completeAgentCreation(s.DB,row,'polish','local-fixture')]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({disposition:'pending',stage_version_id:saved.version_id,self_check_status:'needs-attention'});
    expect(s.sqlite.prepare('SELECT input_revision FROM artifact_versions WHERE task_id=?').get(s.id)).toEqual({input_revision:0});
    expect(s.sqlite.prepare('SELECT product_html FROM topics WHERE id=1').get()).toEqual({product_html:null});
  });

  it('does not save new stages after the original credential is revoked',async()=>{
    const s=setup(),row=s.row();
    s.sqlite.exec("UPDATE forge_agents SET revoked=1 WHERE id='device'");
    await expect(recordAgentCreationStage(s.DB,row,await stagePayload('build',output('build')))).rejects.toMatchObject({status:409});
    expect(s.sqlite.prepare('SELECT count(*) n FROM artifact_versions').get()).toEqual({n:0});
  });

  it('keeps the newest project content when the snapshot revision changes',async()=>{
    const s=setup(),row=s.row(),existing=html('existing');
    s.sqlite.prepare('UPDATE topics SET content_revision=1,product_html=? WHERE id=1').run(existing);
    await recordAgentCreationStage(s.DB,row,await stagePayload('build',output('build')));
    await recordAgentCreationStage(s.DB,row,await stagePayload('polish',output('polish',{selfCheck:selfCheck()})));
    expect(await completeAgentCreation(s.DB,row,'polish')).toMatchObject({disposition:'pending'});
    expect(s.sqlite.prepare('SELECT product_html FROM topics WHERE id=1').get()).toEqual({product_html:existing});
  });

  it('allows one evidenced repair and locks its final evidence before completion',async()=>{
    const s=setup(),row=s.row();
    await recordAgentCreationStage(s.DB,row,await stagePayload('build',output('build')));
    const polish=await recordAgentCreationStage(s.DB,row,await stagePayload('polish',output('polish',{selfCheck:selfCheck([finding({resolved:false})],true)})));
    expect(polish.nextMaterials?.stage).toBe('repair');
    await expect(validateAgentCreationCompletion(s.DB,row,'polish')).rejects.toMatchObject({status:409});
    const repair=await recordAgentCreationStage(s.DB,row,await stagePayload('repair',output('repair',{selfCheck:selfCheck([finding({evidenceRefs:['polish:shot-2']})])})));
    expect(repair.nextMaterials).toBeNull();
    expect(repair).toMatchObject({complete:{result:{stage:'repair'},model:null}});
    const corrupt=s.sqlite.prepare("SELECT content FROM forge_creation_evidence WHERE task_id=? AND stage='repair' AND part=0").get(s.id) as {content:string};
    s.sqlite.prepare("UPDATE forge_creation_evidence SET content=? WHERE task_id=? AND stage='repair' AND part=0").run(corrupt.content.replace('YQ==','Yg=='),s.id);
    await expect(validateAgentCreationCompletion(s.DB,row,'repair')).rejects.toMatchObject({status:409});
  });

  it('resumes a saved model output after D1 failure and never repeats a paid stage',async()=>{
    const s=setup('platform');
    modelOutput(output('build'),output('polish',{selfCheck:selfCheck()}));
    s.failWriteOnce('INSERT OR IGNORE INTO forge_creation_stages');
    await creationPipelineAlarm(s.state,s.env,s.id);
    expect(s.row().status).toBe('running');
    expect(complete).toHaveBeenCalledTimes(1);
    await creationPipelineAlarm(s.state,s.env,s.id);
    expect(s.row()).toMatchObject({status:'done',phase:'done'});
    expect(complete).toHaveBeenCalledTimes(2);
    expect(s.env.captureReview).toHaveBeenCalledTimes(2);
    const records=await creationChecks(s.DB,'owner',1);
    expect(records.find((row:any)=>row.stage==='polish').self_check).toMatchObject({judgedInputHash:await digest(html('build')),outputHash:await digest(html('polish'))});
    await creationPipelineAlarm(s.state,s.env,s.id);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('rejects vision-disabled profiles and waits only 24 hours for a model slot',async()=>{
    const noVision=setup('platform');noVision.profile.vision=false;
    await creationPipelineAlarm(noVision.state,noVision.env,noVision.id);
    expect(noVision.row()).toMatchObject({status:'error',error:expect.stringContaining('视觉')});
    const expired=setup('platform');
    expect(await advanceCreationPipeline(expired.state,expired.env,expired.id)).toBe(true);
    expired.sqlite.prepare('UPDATE forge_tasks SET created_at=? WHERE id=?').run('2000-01-01T00:00:00Z',expired.id);
    await creationPipelineAlarm(expired.state,expired.env,expired.id);
    expect(expired.row()).toMatchObject({status:'error',error:expect.stringContaining('24 小时')});
    expect(complete).not.toHaveBeenCalled();
  });

  it('fails an interrupted started stage without asking the model again',async()=>{
    const s=setup('platform');
    await advanceCreationPipeline(s.state,s.env,s.id);
    const state=JSON.parse(await s.storage.get('creation:0'));
    await s.storage.put('creation:0',JSON.stringify({...state,phase:'started'}));
    await creationPipelineAlarm(s.state,s.env,s.id);
    expect(s.row()).toMatchObject({status:'error',error:expect.stringContaining('模型结果未知')});
    expect(complete).not.toHaveBeenCalled();
    expect(s.env.captureReview).not.toHaveBeenCalled();
  });

  it('rechecks Star at the paid transport boundary after the model slot was selected',async()=>{
    const s=setup('platform'),charged=vi.fn();
    vi.mocked(complete).mockImplementationOnce(async runtime=>{
      s.sqlite.exec("UPDATE members SET star=0 WHERE id='owner'");
      await runtime.generation?.onStart();
      charged();
      return output('unexpected');
    });
    await creationPipelineAlarm(s.state,s.env,s.id);
    expect(s.row()).toMatchObject({status:'error',model_started_at:null,error:expect.stringContaining('Star')});
    expect(charged).not.toHaveBeenCalled();
    expect(s.env.captureReview).not.toHaveBeenCalled();
  });
});
