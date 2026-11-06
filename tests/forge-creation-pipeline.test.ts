import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {advanceCreationPipeline,completeAgentCreation,creationChecks,creationEvidence,creationPipelineAlarm,lockCreationCapture,recordAgentCreationStage,validateAgentCreationCompletion,validateCreationOutput} from '../server/forge-creation-pipeline';
import {digest,canonicalJson} from '../server/review-device-state';
import {complete} from '../server/forge-llm';
import {encryptKey} from '../server/settings';
import {CCB_ENGINE_COMMIT,EMBEDDED_CCB_VERSION,modelContractHash} from '../server/harness-policy';

vi.mock('../server/forge-llm',async original=>({...await original<typeof import('../server/forge-llm')>(),complete:vi.fn()}));
const databases:DatabaseSync[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.resetAllMocks();vi.restoreAllMocks();vi.unstubAllGlobals();});
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
  const snapshot={topic,revision:0,policy_revision:0,heads:{},cfg:{},creative_version:2,platform_creation_policy:{version:1,effort:'high',maxTokens:64000}};
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
    expect(request.maxTokens).toBe(64000);
    expect(request.requiredProfile).toBe('opus');
    expect(request.outputEffort).toBe('high');
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
    expect(s.env.captureReview).not.toHaveBeenCalled();
    await creationPipelineAlarm(s.state,s.env,s.id);
    expect(s.row().status).toBe('running');
    expect(complete).toHaveBeenCalledTimes(1);
    for(let i=0;i<8&&s.row().status==='running';i++){const before=vi.mocked(complete).mock.calls.length;await creationPipelineAlarm(s.state,s.env,s.id);expect(vi.mocked(complete).mock.calls.length-before).toBeLessThanOrEqual(1);}
    expect(s.row()).toMatchObject({status:'done',phase:'done'});
    expect(complete).toHaveBeenCalledTimes(2);
    expect(s.env.captureReview).toHaveBeenCalledTimes(2);
    const records=await creationChecks(s.DB,'owner',1);
    expect(records.find((row:any)=>row.stage==='polish').self_check).toMatchObject({judgedInputHash:await digest(html('build')),outputHash:await digest(html('polish'))});
    await creationPipelineAlarm(s.state,s.env,s.id);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('keeps an already queued pre-upgrade task at its original output ceiling',async()=>{
    const s=setup('platform'),snapshot=JSON.parse(s.row().input_snapshot);
    delete snapshot.platform_creation_policy;
    s.sqlite.prepare('UPDATE forge_tasks SET input_snapshot=? WHERE id=?').run(JSON.stringify(snapshot),s.id);
    vi.mocked(complete).mockImplementationOnce(async(_runtime,_cfg,request)=>{
      expect(request.maxTokens).toBe(32768);
      expect(request.outputEffort).toBe('high');
      return output('build');
    });
    await creationPipelineAlarm(s.state,s.env,s.id);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(s.row().status).toBe('running');
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

function enableHarness(s: ReturnType<typeof setup>, limits: Partial<typeof import('../server/harness-policy').HARNESS_GAME_LIMITS> = {}) {
  const policy = {
    version: 1, engine: 'ccb', engineCommit: '963e0013184ecc1521289a0fc7d5da4bb6e45356',
    image: `registry.cloudflare.com/${'1'.repeat(32)}/fixture@sha256:${'2'.repeat(64)}`, releaseHash: 'a'.repeat(64),
    family: 'forge', purpose: 'game', modelContractHash: 'b'.repeat(64),
    limits: { maxOutputTokens: 64_000, maxTotalOutputTokens: 256_000, maxModelTurns: 24, maxDurationMs: 40 * 60_000, maxRepairs: 2, ...limits },
  };
  s.sqlite.prepare('UPDATE forge_tasks SET harness_policy=? WHERE id=?').run(JSON.stringify(policy), s.id);
  const finish = vi.fn(async (_request: Request) => Response.json({ ok: true }));
  const env = { ...s.env, HARNESS_RUNNER: { idFromName: (id: string) => id, get: () => ({ fetch: finish }) } };
  return { env, finish, policy };
}

async function allocateHarnessFixture(runtime: Parameters<typeof complete>[0]){
  const execution=runtime.harnessExecution;
  if(execution?.onAllocated){
    const startedAt=execution.deadlineAt-execution.policy.limits.maxDurationMs;
    await execution.onAllocated({startedAt,taskDeadlineAt:execution.deadlineAt,stageDeadlineAt:Math.min(execution.deadlineAt,startedAt+12*60_000)});
  }
}

describe('opt-in harness game stages', () => {
  it('shares a locked source and deadline, reuses the four actual images, and caps evidenced repairs at two', async () => {
    const s = setup('platform');
    const { env, finish, policy } = enableHarness(s);
    const deadlineByStage: number[] = [];
    const phases: string[] = [];
    const sourceHash = await digest(s.row().input_snapshot);
    vi.mocked(complete).mockImplementation(async (runtime, _cfg, request) => {
      await allocateHarnessFixture(runtime);
      const execution = runtime.harnessExecution!;
      const stage = execution.phase;
      phases.push(stage);
      deadlineByStage.push(execution.deadlineAt);
      expect(execution).toMatchObject({ taskId: s.id, ownerId: 'owner', sourceHash, policy });
      expect(runtime.generation!.capacityReserved).toBe(false);
      expect(runtime.generation!.deadline).toBeLessThanOrEqual(execution.deadlineAt);
      expect(runtime.generation!.deadline - Date.now()).toBeLessThanOrEqual(12 * 60_000);
      expect(request).toMatchObject({ maxTokens: 64_000, outputEffort: 'high', maxAttempts: 1 });
      await runtime.generation!.onStart();
      if (stage === 'build') return output(stage);
      const previous = { polish: 'build', repair: 'polish', repair2: 'repair' }[stage]!;
      expect(execution.previousHtml).toBe(html(previous));
      expect((request.user as any[]).filter(part => part.type === 'image')).toHaveLength(4);
      expect(JSON.stringify(request.user)).toContain(`原图证据 ID：${previous}:shot-2`);
      const needsRepair = selfCheck([finding({ resolved: false, evidenceRefs: [`${previous}:shot-2`] })], true);
      if (stage === 'repair2') {
        expect(request.validate!(output(stage, { selfCheck: needsRepair }))).toContain('selfCheck');
        return output(stage, { selfCheck: selfCheck() });
      }
      const result = output(stage, { selfCheck: needsRepair });
      expect(request.validate!(result)).toEqual([]);
      return result;
    });
    for (let i = 0; i < 12 && ['queued','running'].includes(s.row().status); i++) await creationPipelineAlarm(s.state, env, s.id);
    expect(phases).toEqual(['build', 'polish', 'repair', 'repair2']);
    expect(new Set(deadlineByStage).size).toBe(1);
    expect(s.row()).toMatchObject({ status: 'done', phase: 'done' });
    expect(s.env.captureReview).toHaveBeenCalledTimes(4);
    for (const stage of phases) {
      const capture = await creationEvidence(s.DB, 'owner', 1, s.id, stage);
      expect(capture.shots).toHaveLength(4);
      expect(capture.shots[0].data).toBe('data:image/jpeg;base64,YQ==');
    }
    expect(finish).toHaveBeenCalledTimes(1);
    expect(await finish.mock.calls[0][0].json()).toEqual({ outcome: 'completed' });
  });

  it('keeps the completed stage when actual browser work exceeds the shared task deadline', async () => {
    vi.useFakeTimers();
    try {
      const s = setup('platform');
      const { env, finish } = enableHarness(s, { maxDurationMs: 2_000 });
      vi.mocked(complete).mockImplementationOnce(async runtime => {
        await allocateHarnessFixture(runtime);
        await runtime.generation!.onStart();
        return output('build');
      });
      await creationPipelineAlarm(s.state, env, s.id);
      s.env.captureReview.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 2_001);
        return raw();
      });
      await creationPipelineAlarm(s.state, env, s.id);
      expect(s.row()).toMatchObject({ status: 'error', error: expect.stringContaining('总时限') });
      expect(s.sqlite.prepare('SELECT stage,evidence_hash FROM forge_creation_stages').get()).toEqual({ stage: 'build', evidence_hash: null });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(await finish.mock.calls[0][0].json()).toEqual({ outcome: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects the second repair on the member Agent protocol', async () => {
    const s = setup();
    const result = output('repair2', { selfCheck: selfCheck() });
    await expect(recordAgentCreationStage(s.DB, s.row(), await stagePayload('repair2', result))).rejects.toThrow('阶段或模型名称无效');
    await expect(validateAgentCreationCompletion(s.DB, s.row(), 'repair2')).rejects.toThrow('至少包含 build 和 polish');
  });

  it('fails a restarted in-flight harness phase closed without another model call', async () => {
    const s = setup('platform');
    const { env, finish } = enableHarness(s);
    await advanceCreationPipeline(s.state, env, s.id);
    const cp = JSON.parse(await s.storage.get('creation:0'));
    await s.storage.put('creation:0', JSON.stringify({ ...cp, phase: 'started' }));
    await creationPipelineAlarm(s.state, env, s.id);
    expect(s.row()).toMatchObject({ status: 'error', error: expect.stringContaining('模型结果未知') });
    expect(complete).not.toHaveBeenCalled();
    expect(await finish.mock.calls[0][0].json()).toEqual({ outcome: 'failed' });
  });
});

it('retains stage artifacts but waits for a durable harness finish before publishing', async () => {
  const s = setup('platform');
  const { env, finish } = enableHarness(s);
  finish.mockImplementationOnce(async () => Response.json({ error: 'settlement unavailable' }, { status: 503 }));
  vi.mocked(complete).mockImplementation(async runtime => {
    await allocateHarnessFixture(runtime);
    await runtime.generation!.onStart();
    return runtime.harnessExecution!.phase === 'build' ? output('build') : output('polish', { selfCheck: selfCheck() });
  });
  for (let i = 0; i < 8 && finish.mock.calls.length === 0; i++) await creationPipelineAlarm(s.state, env, s.id);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(s.row().status).toBe('running');
  expect(s.sqlite.prepare('SELECT stage FROM forge_creation_stages ORDER BY stage').all()).toEqual([{ stage: 'build' }, { stage: 'polish' }]);
  expect(s.sqlite.prepare('SELECT product_html FROM topics WHERE id=1').get()).toEqual({ product_html: null });
  const checkpoint=JSON.parse(await s.storage.get('creation:0'));
  const clock=vi.spyOn(Date,'now').mockReturnValue(checkpoint.harnessDeadlineAt+1);
  try{await creationPipelineAlarm(s.state,env,s.id);}finally{clock.mockRestore();}
  expect(s.row().status).toBe('done');
  expect(complete).toHaveBeenCalledTimes(2);
  expect(finish).toHaveBeenCalledTimes(2);
});

it('keeps definite capacity waits outside the shared game deadline without marking a model start',async()=>{
  vi.useFakeTimers();
  try{
    const s=setup('platform');
    const {env}=enableHarness(s);
    const {HarnessCapacityWait}=await import('../server/harness-execution');
    let expectedDeadline=0;
    vi.mocked(complete)
      .mockImplementationOnce(async()=>{throw new HarnessCapacityWait('等待隔离执行名额…');})
      .mockImplementationOnce(async runtime=>{
        expectedDeadline=runtime.harnessExecution!.deadlineAt;
        await allocateHarnessFixture(runtime);
        await runtime.generation!.onStart();
        return output('build');
      })
      .mockImplementationOnce(async runtime=>{
        expect(runtime.harnessExecution!.deadlineAt).toBe(expectedDeadline);
        await runtime.generation!.onStart();
        return output('polish',{selfCheck:selfCheck()});
      });
    await creationPipelineAlarm(s.state,env,s.id);
    expect(s.row()).toMatchObject({status:'running',phase:'build:waiting',started_at:null,model_started_at:null});
    expect(JSON.parse(await s.storage.get('creation:0')).phase).toBe('ready');
    expect(s.alarm.at).toBe(Date.now()+5000);
    vi.setSystemTime(Date.now()+41*60_000);
    const allocatedAt=Date.now();
    for(let i=0;i<7&&s.row().status==='running';i++)await creationPipelineAlarm(s.state,env,s.id);
    expect(s.row()).toMatchObject({status:'done',started_at:new Date(allocatedAt).toISOString()});
    expect(expectedDeadline).toBe(allocatedAt+40*60_000);
    expect(complete).toHaveBeenCalledTimes(3);
  }finally{vi.useRealTimers();}
});

async function toolEvidence(htmlText:string, letter='a'){
  const evidenceId=`tool-${letter.repeat(64)}`,id=`${evidenceId}:shot:1`;
  const record={evidenceId,tool:'play-start',origin:'harness-browser-tool',contextOrigin:'creator-self-check',sourceBlind:false,
    inputHash:await digest(htmlText),shots:[{id,label:'实际浏览器补图',data:'data:image/jpeg;base64,YQ==',sha256:await digest('a'),actionRefs:[]}],actions:[]};
  return {...record,evidenceHash:await digest(canonicalJson(record))};
}

it('retains verified supplemental browser evidence and exposes exact versions and original images',async()=>{
  const s=setup('platform');
  const {env}=enableHarness(s);
  const prior=await toolEvidence(html('build'));
  const extra=await toolEvidence(html('polish'),'b');
  vi.mocked(complete).mockImplementation(async(runtime,_cfg,request)=>{
    await allocateHarnessFixture(runtime);
    await runtime.generation!.onStart();
    const execution=runtime.harnessExecution!;
    if(execution.phase==='build'){
      await execution.onEvidence!([prior]);
      return output('build');
    }
    expect((request.user as any[]).filter(part=>part.type==='image')).toHaveLength(5);
    expect(JSON.stringify(request.user)).toContain(prior.shots[0].id);
    expect(JSON.stringify(request.user)).toContain(prior.inputHash);
    await expect(execution.onEvidence!([extra])).rejects.toThrow('不能省略或替换');
    await execution.onEvidence!([prior,extra]);
    const supported=output('polish',{selfCheck:selfCheck([finding({evidenceRefs:[extra.shots[0].id]})])});
    expect(request.validate!(supported)).toEqual([]);
    const fake=output('polish',{selfCheck:selfCheck([finding({evidenceRefs:[extra.shots[0].id+'-invented']})])});
    expect(request.validate!(fake)).toContain('selfCheck.findings');
    return supported;
  });
  for(let i=0;i<8&&['queued','running'].includes(s.row().status);i++)await creationPipelineAlarm(s.state,env,s.id);
  expect(s.row()).toMatchObject({status:'done'});
  const records=await creationChecks(s.DB,'owner',1);
  const polish=records.find((record:any)=>record.stage==='polish');
  expect(polish.self_check.harnessEvidence).toEqual([
    expect.objectContaining({evidenceId:prior.evidenceId,inputHash:prior.inputHash,evidenceHash:prior.evidenceHash,matchesOutput:false}),
    expect.objectContaining({evidenceId:extra.evidenceId,inputHash:extra.inputHash,evidenceHash:extra.evidenceHash,matchesOutput:true}),
  ]);
  expect(JSON.stringify(polish)).not.toContain('data:image');
  const capture=await creationEvidence(s.DB,'owner',1,s.id,'polish');
  expect(capture.shots).toHaveLength(4);
  expect(capture.harnessEvidence).toEqual([prior,extra]);
  expect(capture.hash).not.toBe((await lockCreationCapture(raw(),'polish',html('polish'))).hash);
  await expect(creationEvidence(s.DB,'other',1,s.id,'polish')).rejects.toMatchObject({status:404});
  s.sqlite.prepare("UPDATE forge_creation_evidence SET content=replace(content,'YQ==','Yg==') WHERE task_id=? AND stage='polish' AND part=-1").run(s.id);
  await expect(creationEvidence(s.DB,'owner',1,s.id,'polish')).rejects.toMatchObject({status:409});
});

it('keeps intermediate evidence on its own hash and denies automatic repair based on it alone',async()=>{
  const s=setup('platform');
  const {env}=enableHarness(s);
  const interim=await toolEvidence(html('intermediate'));
  vi.mocked(complete).mockImplementation(async runtime=>{
    await allocateHarnessFixture(runtime);
    await runtime.generation!.onStart();
    const execution=runtime.harnessExecution!;
    if(execution.phase==='build')return output('build');
    await execution.onEvidence!([interim]);
    return output('polish',{selfCheck:selfCheck([finding({resolved:false,evidenceRefs:[interim.shots[0].id]})],true)});
  });
  for(let i=0;i<7&&['queued','running'].includes(s.row().status);i++)await creationPipelineAlarm(s.state,env,s.id);
  expect(s.row()).toMatchObject({status:'error',error:expect.stringContaining('current HTML version')});
  expect(complete).toHaveBeenCalledTimes(2);
  expect(s.sqlite.prepare("SELECT count(*) n FROM forge_creation_stages WHERE stage='repair'").get()).toEqual({n:0});
});

it('rejects injected supplements and their references on the member protocol while preserving its baseline',async()=>{
  const s=setup();
  const member=s.row();
  const tool=await toolEvidence(html('build'));
  const build=await stagePayload('build',output('build'));
  await expect(recordAgentCreationStage(s.DB,member,{...build,capture:{...build.capture,harnessEvidence:[tool]}})).rejects.toThrow('不能回传平台 Harness');
  await recordAgentCreationStage(s.DB,member,build);
  const stored=await creationEvidence(s.DB,'owner',1,s.id,'build');
  expect(stored).not.toHaveProperty('harnessEvidence');
  expect(stored.hash).toBe((await lockCreationCapture(raw(),'build',html('build'))).hash);
  const polish=await stagePayload('polish',output('polish',{selfCheck:selfCheck([finding({evidenceRefs:[tool.shots[0].id]})])}));
  await expect(recordAgentCreationStage(s.DB,member,polish)).rejects.toThrow('selfCheck.findings');
});

it('keeps genuine supplemental originals available when the independent baseline capture fails',async()=>{
  const s=setup('platform');
  const {env}=enableHarness(s);
  const supplemental=await toolEvidence(html('build'));
  vi.mocked(complete).mockImplementationOnce(async runtime=>{
    await allocateHarnessFixture(runtime);
    await runtime.generation!.onStart();
    await runtime.harnessExecution!.onEvidence!([supplemental]);
    return output('build');
  });
  s.env.captureReview.mockRejectedValue(new Error('Synthetic capture failure'));
  await creationPipelineAlarm(s.state,env,s.id);
  await creationPipelineAlarm(s.state,env,s.id);
  expect(s.row()).toMatchObject({status:'error',error:expect.stringContaining('采集未完成')});
  const evidence=await creationEvidence(s.DB,'owner',1,s.id,'build');
  expect(evidence).toMatchObject({hash:null,shots:[],harnessEvidence:[supplemental]});
  expect(complete).toHaveBeenCalledTimes(1);
});


it('restores a sealed embedded build after the outer checkpoint fails and keeps the stage at task expiry', async()=>{
  const s=setup('platform');
  const actual=await vi.importActual<typeof import('../server/forge-llm')>('../server/forge-llm');
  vi.mocked(complete).mockImplementation(actual.complete);
  s.profile.baseUrl='https://riffle-api.pages.dev';
  s.profile.encryptedKey=await encryptKey('synthetic-opus-key',s.env.SETTINGS_KEY);
  const config=await s.env.modelStore.get();
  s.sqlite.prepare('INSERT INTO settings(id,value,updated_at) VALUES(?,?,?)').run('model',JSON.stringify(config),new Date().toISOString());
  const policy={version:2,engine:'ccb-embedded',engineCommit:CCB_ENGINE_COMMIT,coreVersion:EMBEDDED_CCB_VERSION,
    contextWindowTokens:200_000,releaseHash:'a'.repeat(64),family:'forge',purpose:'game',modelContractHash:await modelContractHash(config,'game'),
    limits:{maxOutputTokens:64_000,maxTotalOutputTokens:256_000,maxModelTurns:24,maxDurationMs:40*60_000,maxRepairs:2}};
  s.sqlite.prepare('UPDATE forge_tasks SET harness_policy=? WHERE id=?').run(JSON.stringify(policy),s.id);
  const {html:game,...record}=output('Sealed build');
  const event=(type:string,value={})=>`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
  const start=(id:string)=>event('message_start',{message:{id,role:'assistant',model:'claude-opus-5-5',content:[],usage:{input_tokens:10,output_tokens:0}}});
  const stop=(reason:string)=>event('message_delta',{delta:{stop_reason:reason},usage:{output_tokens:20}})+event('message_stop');
  const writes=[['game.html',game],['record.json',JSON.stringify(record)]].map(([path,content],index)=>
    event('content_block_start',{index,content_block:{type:'tool_use',id:`fixture-write-${index}`,name:'write',input:{path,content,expectedSha256:null}}})+
    event('content_block_stop',{index})).join('');
  const acknowledgement=event('content_block_start',{index:0,content_block:{type:'text',text:'Saved both files.'}})+event('content_block_stop',{index:0});
  const bodies=[start('synthetic-tool-turn')+writes+stop('tool_use'),start('synthetic-final-turn')+acknowledgement+stop('end_turn')];
  let now=Date.now();
  const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
  const fetcher=vi.fn(async(url:URL)=>{
    expect(String(url)).toBe('https://riffle-api.pages.dev/v1/messages');
    const body=bodies.shift();if(!body)throw new Error('Unexpected provider invocation');
    now+=8000; // Advance beyond Riffle's shared start interval without a real wait.
    return new Response(body,{headers:{'content-type':'text/event-stream'}});
  });
  vi.stubGlobal('fetch',fetcher);
  const put=s.storage.put;
  const failures=vi.spyOn(s.storage,'put').mockImplementation(async(key,value)=>{
    if(key==='creation:0'&&typeof value==='string'&&JSON.parse(value).phase==='output')throw new Error('Synthetic outer checkpoint interruption');
    return put(key,value);
  });
  await creationPipelineAlarm(s.state,s.env,s.id);
  expect(s.row(),s.row().error).toMatchObject({status:'running'});
  expect(JSON.parse(await s.storage.get('creation:0')).phase).toBe('started');
  const meta=await s.storage.get('embedded-harness-meta');
  expect(meta).toMatchObject({state:'succeeded',phase:'build'});
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(s.sqlite.prepare('SELECT count(*) AS count FROM forge_creation_stages').get()).toMatchObject({count:0});
  failures.mockRestore();

  now=meta.deadlineAt+1;
  try{
    await creationPipelineAlarm(s.state,s.env,s.id);
    await creationPipelineAlarm(s.state,s.env,s.id);
  }finally{clock.mockRestore();}
  expect(s.row()).toMatchObject({status:'error',error:expect.stringContaining('总时限')});
  expect(s.sqlite.prepare('SELECT stage,content_hash,evidence_hash FROM forge_creation_stages').all()).toEqual([
    {stage:'build',content_hash:await digest(game),evidence_hash:null},
  ]);
  expect(s.env.captureReview).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
