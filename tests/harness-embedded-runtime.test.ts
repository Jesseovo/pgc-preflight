import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { embeddedHarnessCompletion, finishEmbeddedTask } from '../server/harness-embedded-runtime';
import { embeddedCaptureKey } from '../server/harness-embedded-capture';
import { clearHarnessRunnerStorage, harnessCompletion } from '../server/harness-execution';
import { CCB_ENGINE_COMMIT, EMBEDDED_CCB_VERSION, modelContractHash, type HarnessPolicy } from '../server/harness-policy';
import { cloudReviewAlarm, advanceCloudReview } from '../server/cloud-review-runner';
import { enqueueReview } from '../server/review-jobs';
import { complete } from '../server/forge-llm';
import { createHarnessRun, endHarnessRun, lockHarnessModel, releaseHarnessSlot, type HarnessRun } from '../server/harness-ledger';
import { reviewReportErrors } from '../server/review-report';
import { encryptKey, type ModelConfig } from '../server/settings';

const databases: DatabaseSync[] = [];
const taskId = 'embedded-review-fixture';
const secret = 'synthetic-settings-secret';
const model = 'deepseek-v4-flash';
const firstSource = 'a'.repeat(64);
const image = 'data:image/png;base64,aGVsbG8=';
const privateEvidence = 'synthetic-source-must-not-enter-diagnostics';
const initialText = '{"stage":"initial"}';
const verifiedText = '{"stage":"verified"}';
const stamp = () => new Date().toISOString();
type Env = Parameters<typeof embeddedHarnessCompletion>[0];

function memoryStorage() {
  let data = new Map<string, unknown>();
  let alarm: number | null = null;
  const accessor = (values: Map<string, unknown>) => ({
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
  });
  const get = async <T>(key: string) => accessor(data).get<T>(key);
  const put = async (key: string, value: unknown) => accessor(data).put(key, value);
  let queue: Promise<unknown> = Promise.resolve();
  return {
    get, put, delete: async (keys: string|string[]) => { for(const key of [keys].flat())data.delete(key); },
    list: async ({limit,startAfter}:{limit:number;startAfter?:string}) =>
      new Map([...data].sort(([a],[b])=>a<b?-1:a>b?1:0).filter(([key])=>!startAfter||key>startAfter).slice(0,limit)),
    transaction<T>(operation: (tx: ReturnType<typeof accessor> & { setAlarm(at: number): Promise<void> }) => Promise<T>) {
      const result = queue.then(async () => {
        const snapshot = new Map(data);
        let nextAlarm=alarm;
        const value = await operation({ ...accessor(snapshot), setAlarm: async at => { nextAlarm=at; } });
        data = snapshot;
        alarm=nextAlarm;
        return value;
      });
      queue = result.catch(() => {});
      return result;
    },
    deleteAll: async () => { data.clear(); },
    getAlarm: async () => alarm,
    deleteAlarm: async () => { alarm=null; },
    setAlarm: async (at: number) => { alarm = at; },
  };
}

function wireText(text: string, output = 23_000, terminal = true) {
  const chunk = (choices: object[], usage?: object) => `data: ${JSON.stringify({ id: 'synthetic-response-id', model, choices, usage })}\n\n`;
  const wire = chunk([{ index: 0, delta: { role: 'assistant', reasoning_content: 'synthetic-reasoning-never-persisted' }, finish_reason: null }]) +
    chunk([{ index: 0, delta: { content: text }, finish_reason: 'stop' }]) +
    chunk([], { prompt_tokens: 25, completion_tokens: output, completion_tokens_details: { reasoning_tokens: 2_000 } }) +
    (terminal ? 'data: [DONE]\n\n' : '');
  return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
}

async function setup(responses: Array<() => Response> = [() => wireText(initialText), () => wireText(verifiedText, 24_000)]) {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  for (const file of readdirSync('migrations').sort().filter(name => name.endsWith('.sql'))) {
    sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  const DB = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      function bound(args: SQLInputValue[]) {
        return { bind: (...values: unknown[]) => bound(values as SQLInputValue[]),
          first: async <T>() => (statement.get(...args) as T | undefined) ?? null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => ({ meta: statement.run(...args) }),
        };
      }
      return bound([]);
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const profile = { model, baseUrl: 'https://api.deepseek.com', protocol: 'openai' as const,
    encryptedKey: await encryptKey('synthetic-provider-key', secret), enabled: true, updatedAt: stamp(), vision: true };
  const config: ModelConfig = { ...profile, activeProfile: 'default', profiles: { default: profile }, routes: { review: 'default' } };
  sqlite.prepare('INSERT INTO settings(id,value,updated_at) VALUES(?,?,?)').run('model', JSON.stringify(config), stamp());
  const policy: HarnessPolicy = { version: 2, engine: 'ccb-embedded', engineCommit: CCB_ENGINE_COMMIT, coreVersion: EMBEDDED_CCB_VERSION,
    contextWindowTokens: 130_000, releaseHash: 'b'.repeat(64), family: 'review', purpose: 'review',
    modelContractHash: await modelContractHash(config, 'review'),
    limits: { maxOutputTokens: 24_000, maxTotalOutputTokens: 48_000, maxModelTurns: 8, maxDurationMs: 720_000, maxRepairs: 0 } };
  sqlite.prepare(`INSERT INTO review_jobs(id,owner_id,title,status,executor,model_executor,created_at,updated_at,harness_policy)
    VALUES (?,?,?,'running','cloud','platform',?,?,?)`).run(taskId, 'admin', 'Synthetic only', stamp(), stamp(), JSON.stringify(policy));
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    const response = responses.shift();
    if (!response) throw new Error('Unexpected provider invocation');
    return response();
  });
  vi.stubGlobal('fetch', fetcher);
  const storage = memoryStorage();
  const BROWSER = {
    closeSession: vi.fn(async (_id: string) => ({ status: 'unconfirmed' })),
    getSession: vi.fn(async (id: string) => ({ sessionId: id })),
  };
  const deadlineAt = Date.now() + 120_000;
  const makeEnv = (phase: 'review' | 'review_verify', sourceHash = firstSource, selectedStorage = storage): Env => ({
    DB, SETTINGS_KEY: secret, BROWSER, modelStore: { get: async () => config }, harnessStorage: selectedStorage,
    harnessExecution: { taskId, ownerId: 'admin', family: 'review', phase, policy, sourceHash, deadlineAt },
  });
  const baseEvidence = [{ type: 'text', text: privateEvidence }, { type: 'image_url', image_url: { url: image } }];
  const input = (phase: 'review' | 'review_verify', extra: unknown[] = []) => ({
    system: 'Locked review instructions',
    user: [...baseEvidence, ...(phase === 'review_verify' ? [{ type: 'text', text: initialText }] : []), ...extra],
    schema: { type: 'object' }, deadline: deadlineAt, maxTokens: 24_000, purpose: phase,
    prepareResult(text: string) {
      const value = JSON.parse(text) as { stage?: string };
      if (value.stage !== 'initial' && value.stage !== 'verified') throw new Error('Invalid synthetic report');
      return JSON.stringify(value);
    },
  });
  const run = () => sqlite.prepare('SELECT * FROM harness_runs WHERE task_id=?').get(taskId);
  const requests = () => sqlite.prepare('SELECT generation,request_id,output_cap,input_tokens,output_tokens,state FROM harness_requests ORDER BY rowid').all();
  return { DB, sqlite, fetcher, storage, BROWSER, input, makeEnv, run, requests, config };
}

afterEach(() => {
  vi.unstubAllGlobals();
  databases.splice(0).forEach(database => database.close());
});

describe('embedded runtime in the existing task scope', () => {
  it('reuses one cumulative ledger across initial and verification, preserves the source, and reads same-phase seals idempotently', async () => {
    const s = await setup();
    const initial = s.makeEnv('review');
    const request = s.input('review');
    expect(await embeddedHarnessCompletion(initial, request)).toBe(initialText);
    expect(await embeddedHarnessCompletion(initial, request)).toBe(initialText);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    await expect(embeddedHarnessCompletion(initial, s.input('review', [{ type: 'text', text: 'different input' }]))).rejects.toThrow('材料');
    await expect(embeddedHarnessCompletion(s.makeEnv('review_verify', 'c'.repeat(64)), s.input('review_verify'))).rejects.toThrow('检查点');
    expect(s.fetcher).toHaveBeenCalledTimes(1);

    const verification = s.makeEnv('review_verify');
    expect(await embeddedHarnessCompletion(verification, s.input('review_verify'))).toBe(verifiedText);
    expect(await embeddedHarnessCompletion(verification, s.input('review_verify'))).toBe(verifiedText);
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    const requestWires = s.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requestWires.map(wire => wire.max_tokens)).toEqual([24_000, 24_000]);
    for (const wire of requestWires) {
      expect(wire).toMatchObject({ model, reasoning_effort: 'low' });
      expect(JSON.stringify(wire.messages)).toContain(privateEvidence);
      expect(JSON.stringify(wire.messages)).toContain(image);
    }
    expect(requestWires[0].messages[0]).toEqual(requestWires[1].messages[0]);
    expect(requestWires[0].messages[1].content.at(-1)).toEqual(requestWires[1].messages[1].content.at(-1));
    const initialMaterial = JSON.parse(requestWires[0].messages[1].content[0].text);
    const verifyMaterial = JSON.parse(requestWires[1].messages[1].content[0].text);
    expect(verifyMaterial.user.slice(0, initialMaterial.user.length)).toEqual(initialMaterial.user);
    expect(s.run()).toMatchObject({ source_hash: firstSource, status: 'active', model_turns: 2, output_tokens: 47_000, reserved_tokens: 0 });
    const requests = s.requests();
    expect(requests[0]).toMatchObject({ request_id: expect.stringMatching(/^review-0-/), output_tokens: 23_000, state: 'completed' });
    expect(requests[1]).toMatchObject({ request_id: expect.stringMatching(/^review_verify-0-/), output_tokens: 24_000, state: 'completed' });
    expect(requests[0].generation).toBe(requests[1].generation);
    const diagnostics = JSON.stringify(s.sqlite.prepare('SELECT measurements,failure_code FROM harness_embedded_diagnostics').all());
    expect(diagnostics).toContain('nativeTerminalAt');
    expect(diagnostics).not.toContain(privateEvidence);
    expect(diagnostics).not.toContain('synthetic-reasoning-never-persisted');
    expect(diagnostics).not.toContain('synthetic-provider-key');
    await finishEmbeddedTask(verification, taskId, 'completed');
    expect(s.run()).toMatchObject({ status: 'done', released_at: expect.any(Number) });
    await clearHarnessRunnerStorage(verification, s.storage, taskId);
    await expect(finishEmbeddedTask(verification, taskId, 'completed')).resolves.toBeUndefined();
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not recreate a lost context or forward another request after interrupted paid work', async () => {
    const s = await setup([() => wireText(initialText, 23_000, false)]);
    const env = s.makeEnv('review');
    await expect(embeddedHarnessCompletion(env, s.input('review'))).rejects.toThrow();
    expect(s.run()).toMatchObject({ status: 'unknown', reserved_tokens: 24_000, output_tokens: 0, model_turns: 1 });
    expect(s.requests()).toEqual([expect.objectContaining({ state: 'unknown', output_tokens: null, input_tokens: null })]);
    await expect(embeddedHarnessCompletion(env, s.input('review'))).rejects.toThrow();
    const newStorage = memoryStorage();
    await expect(embeddedHarnessCompletion(s.makeEnv('review', firstSource, newStorage), s.input('review'))).rejects.toThrow();
    await expect(embeddedHarnessCompletion(s.makeEnv('review_verify'), s.input('review_verify'))).rejects.toThrow();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.requests()).toHaveLength(1);
  });

  it('reconciles an allocation whose meta write failed without dispatching or allocating another generation', async () => {
    const s = await setup([]);
    const env = s.makeEnv('review');
    const save = s.storage.put;
    const put = vi.spyOn(s.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'embedded-harness-meta') throw new Error('Synthetic interrupted storage write');
      return save(key, value);
    });
    await expect(embeddedHarnessCompletion(env, s.input('review'))).rejects.toThrow('Synthetic interrupted storage write');
    put.mockRestore();
    const allocated = s.run();
    expect(allocated).toMatchObject({ status: 'active', model_turns: 0, released_at: null });
    expect(await s.storage.get('embedded-harness-allocation')).toMatchObject({ taskId, generation: allocated?.generation });
    expect(await s.storage.get('embedded-harness-meta')).toBeUndefined();
    await clearHarnessRunnerStorage(env, s.storage, taskId);
    expect(s.run()).toMatchObject({ generation: allocated?.generation, status: 'failed', model_turns: 0, released_at: expect.any(Number) });
    expect(await s.storage.get('embedded-harness-allocation')).toBeUndefined();
    await expect(embeddedHarnessCompletion(env, s.input('review'))).rejects.toThrow('未创建第二次执行');
    expect(s.requests()).toHaveLength(0);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.BROWSER.closeSession).not.toHaveBeenCalled();
  });

  it('keeps original browser identity and slot while exact remote closure is unconfirmed', async () => {
    const s = await setup([() => wireText(initialText)]);
    const env = s.makeEnv('review');
    const pendingKey = 'harness-browser-pending-capture';
    const browserId = 'owned-browser-session';
    await expect(embeddedHarnessCompletion(env, { ...s.input('review'), onStart: async () => {
      await s.storage.put(pendingKey, { invocationId: 'owned-capture', browserId });
    } })).rejects.toThrow('关闭尚未确认');
    expect(s.run()).toMatchObject({ status: 'failed', released_at: null });
    expect(await s.storage.get(pendingKey)).toMatchObject({ browserId, cancelled: true });
    expect(await s.storage.get('embedded-harness-meta')).toMatchObject({ taskId });
    await expect(clearHarnessRunnerStorage(env, s.storage, taskId)).rejects.toThrow('关闭尚未确认');
    expect(await s.storage.getAlarm()).toEqual(expect.any(Number));
    expect(await s.storage.get(pendingKey)).toMatchObject({ browserId });
    expect(s.BROWSER.closeSession.mock.calls.every(([id]) => id === browserId)).toBe(true);
    await s.storage.put('jobId',taskId);
    await s.storage.put('cloudImmutable:private:0','private raw source');
    for(let i=0;i<140;i++)await s.storage.put('embedded-workspace:private:'+i,'private content');
    const age=vi.spyOn(Date,'now').mockReturnValue(Date.now()+86400001);
    try{await expect(clearHarnessRunnerStorage(env,s.storage,taskId)).rejects.toThrow('关闭尚未确认');}
    finally{age.mockRestore();}
    expect(await s.storage.get(pendingKey)).toMatchObject({browserId});
    expect(await s.storage.get('embedded-harness-meta')).toMatchObject({taskId,lease:''});
    expect(await s.storage.get('embedded-cleanup-only')).toBe(true);
    expect([...(await s.storage.list({limit:500})).keys()]).toEqual([
      'embedded-cleanup-only','embedded-cleanup-since','embedded-harness-allocation',
      'embedded-harness-meta',pendingKey,'jobId',
    ]);
    expect(s.run()).toMatchObject({released_at:null});
    s.BROWSER.closeSession.mockResolvedValue({ status: 'closed' });
    await clearHarnessRunnerStorage(env, s.storage, taskId);
    expect(s.run()).toMatchObject({ status: 'failed', released_at: expect.any(Number) });
    expect(await s.storage.get(pendingKey)).toBeUndefined();
    expect(await s.storage.get('embedded-harness-meta')).toBeUndefined();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });

  it('cannot start the model or erase the original baseline marker while browser closure is unknown', async () => {
    const s = await setup([]);
    const env = s.makeEnv('review');
    const session = 'original-baseline-browser';
    await s.storage.put(embeddedCaptureKey, { id: 'original-baseline', browserId: session });
    await expect(embeddedHarnessCompletion(env, s.input('review'))).rejects.toThrow('关闭尚未确认');
    await expect(clearHarnessRunnerStorage(env, s.storage, taskId)).rejects.toThrow('关闭尚未确认');
    expect(await s.storage.get(embeddedCaptureKey)).toEqual({ id: 'original-baseline', browserId: session, cancelled: true });
    expect(await s.storage.getAlarm()).toEqual(expect.any(Number));
    expect(s.run()).toBeUndefined();
    expect(s.requests()).toEqual([]);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.BROWSER.closeSession.mock.calls).toEqual([[session], [session]]);
  });

  it('checks current encrypted profile and current owner permission before paid forwarding', async () => {
    const s = await setup([]);
    const env = s.makeEnv('review');
    const rotated = { ...s.config, profiles: { default: { ...s.config.profiles!.default,
      encryptedKey: await encryptKey('rotated-synthetic-key', secret) } } };
    s.sqlite.prepare('UPDATE settings SET value=? WHERE id=?').run(JSON.stringify(rotated), 'model');
    await expect(embeddedHarnessCompletion(env, s.input('review'))).rejects.toThrow();
    expect(s.requests()).toHaveLength(0);
    s.sqlite.prepare('UPDATE review_jobs SET owner_id=? WHERE id=?').run('other-member', taskId);
    await expect(embeddedHarnessCompletion(env, s.input('review'))).rejects.toThrow('权限');
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it('rejects unvalidated raw review output before archiving or sealing it', async () => {
    const raw = '{"unexpected":"raw provider output should not be stored"}';
    const s = await setup([() => wireText(raw)]);
    await expect(embeddedHarnessCompletion(s.makeEnv('review'), s.input('review'))).rejects.toThrow('Invalid synthetic report');
    expect(s.sqlite.prepare('SELECT path FROM harness_embedded_artifacts').all()).toEqual([]);
    expect(await s.storage.get('embedded-result:review:parts')).toBeUndefined();
    expect(JSON.stringify(s.sqlite.prepare('SELECT measurements,failure_code FROM harness_embedded_diagnostics').all())).not.toContain(raw);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not echo a model-supplied report field name into an embedded task error', async () => {
    const privateField = 'synthetic source excerpt embedded as a field name';
    const raw = JSON.stringify({ schema_version: 2, [privateField]: 'not a known report field' });
    const s = await setup([() => wireText(raw)]);
    const error = await complete(s.makeEnv('review'), {}, {
      ...s.input('review'), validate: value => reviewReportErrors(value, { schemaVersion: 2 }),
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('未保存原始输出');
    expect((error as Error).message).not.toContain(privateField);
    expect(s.sqlite.prepare('SELECT path FROM harness_embedded_artifacts').all()).toEqual([]);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });

  it('waits on a confirmed occupied slot, then dispatches only once for the original review', async () => {
    const s = await setup([() => wireText(initialText)]);
    const model = (await lockHarnessModel(s.config, 'review'))!;
    const occupied: HarnessRun[] = [];
    for (const taskId of ['capacity-a', 'capacity-b']) {
      occupied.push((await createHarnessRun(s.DB, { taskId, generation: 'capacity-test', ownerId: 'admin', actor: 'admin',
        sourceHash: firstSource, snapshot: {}, model, deadlineAt: Date.now() + 60_000 }))!.run);
    }
    let waits = 0;
    vi.useFakeTimers();
    try {
      const completion = embeddedHarnessCompletion(s.makeEnv('review'), { ...s.input('review'), onWait: async message => {
        if (message !== '等待内嵌任务执行名额…') return;
        expect(s.fetcher).not.toHaveBeenCalled();
        expect(s.run()).toBeUndefined();
        await endHarnessRun(s.DB, occupied[0], 'failed');
        await releaseHarnessSlot(s.DB, occupied[0]);
        waits++;
      } });
      const observed = expect(completion).resolves.toBe(initialText);
      await vi.waitFor(() => expect(waits).toBe(1));
      await vi.advanceTimersByTimeAsync(5000);
      await observed;
    } finally { vi.useRealTimers(); }
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.requests()).toHaveLength(1);
    expect(s.run()).toMatchObject({ task_id: taskId, model_turns: 1 });
  });

  it('does not seal an on-time model result if evidence handling crosses the stage deadline', async () => {
    const s = await setup([() => wireText(initialText)]);
    const env = s.makeEnv('review');
    const request = s.input('review');
    const clock = vi.spyOn(Date, 'now');
    env.harnessExecution!.onEvidence = async () => { clock.mockReturnValue(request.deadline + 1); };
    try {
      await expect(embeddedHarnessCompletion(env, request)).rejects.toThrow('阶段已超时');
    } finally { clock.mockRestore(); }
    expect(await s.storage.get('embedded-result:review:parts')).toBeUndefined();
    expect(s.run()).toMatchObject({ status: 'failed', released_at: expect.any(Number) });
    expect(s.requests()).toEqual([expect.objectContaining({ state: 'completed', output_tokens: 23_000 })]);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
});


it('recovers sealed review and verification after outer checkpoint failures without replaying either model request', async () => {
  const initial = { aes: 2, ease: 2, play: 2, verdict: '打回', score_reasons: { aes: '图像证据', ease: '运行记录', play: '源码推断' },
    uncertainties: ['长期节奏'], issues: [], strengths: [], reviewer_comment: '初稿', fix_prompt: '验证后再修改' };
  const final = { ...initial, play: 3, verdict: '通过', reviewer_comment: '复核完成' };
  const s = await setup([() => wireText(JSON.stringify(initial)), () => wireText(JSON.stringify(final))]);
  const config = s.makeEnv('review');
  const jobId = crypto.randomUUID(), capture = { probe: { captureMethod: 'browser-viewport-v1', note: 'Synthetic capture' },
    shots: Array.from({length:4},(_,i)=>({id:`shot-${i}`,label:`Synthetic ${i}`,data:image})) };
  const env = { ...config, modelExecutor:'platform' as const, REVIEW_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch:async()=>Response.json({ok:true})})},
    captureReview: vi.fn(async (_html:string,_wait?:unknown,_deadline?:number,_options?:unknown,lifecycle?:any)=>{
      if(!lifecycle)throw new Error('Missing synthetic capture lifecycle');
      await lifecycle.acquiring();await lifecycle.acquired('fixture-owned-browser');await lifecycle.closed('fixture-owned-browser');
      return capture;
    }) };
  await enqueueReview(env,{ request_id:jobId, title:'Synthetic review recovery', html:'<!doctype html><title>Synthetic review</title><canvas></canvas>' },'admin');
  s.sqlite.prepare('UPDATE review_jobs SET harness_policy=? WHERE id=?').run(JSON.stringify(config.harnessExecution!.policy),jobId);
  const state={storage:s.storage},run=()=>cloudReviewAlarm(state,env,jobId);
  await advanceCloudReview(state,env,jobId);
  expect(await s.storage.get('cloudPhase')).toBe('prepared');
  expect(s.sqlite.prepare('SELECT status,model_execution_started_at FROM review_jobs WHERE id=?').get(jobId)).toEqual({status:'running',model_execution_started_at:null});
  const originalTransaction=s.storage.transaction;
  const failedStages=new Set(['draft-ready','final-ready']);
  const transactions=vi.spyOn(s.storage,'transaction').mockImplementation(operation=>originalTransaction(tx=>operation({...tx,
    put:async(key,value)=>{
      if(key==='cloudPhase'&&typeof value==='string'&&failedStages.delete(value))throw new Error('Synthetic outer checkpoint transaction failure');
      await tx.put(key,value);
    },
  })));
  await run();
  const running=s.sqlite.prepare('SELECT status,error,model_execution_started_at FROM review_jobs WHERE id=?').get(jobId);
  expect(running,JSON.stringify({running,forward:s.fetcher.mock.calls.length,pending:[...failedStages]})).toMatchObject({status:'running'});
  expect(await s.storage.get('cloudPhase')).toBe('review-started');
  expect(await s.storage.get('embedded-harness-meta')).toMatchObject({state:'succeeded',phase:'review'});
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  await run();
  expect(await s.storage.get('cloudPhase')).toBe('verify-started');
  const meta=await s.storage.get<{deadlineAt:number}>('embedded-harness-meta');
  expect(meta).toMatchObject({state:'succeeded',phase:'review_verify'});
  expect(s.fetcher).toHaveBeenCalledTimes(2);
  expect(s.sqlite.prepare('SELECT count(*) AS count FROM reviews WHERE job_id=?').get(jobId)).toMatchObject({count:0});
  const clock=vi.spyOn(Date,'now').mockReturnValue(meta!.deadlineAt+1);
  try{await run();}finally{clock.mockRestore();transactions.mockRestore();}
  expect(s.fetcher).toHaveBeenCalledTimes(2);
  expect(env.captureReview).toHaveBeenCalledTimes(1);
  expect(s.sqlite.prepare('SELECT status FROM review_jobs WHERE id=?').get(jobId)).toMatchObject({status:'done'});
  const published=s.sqlite.prepare('SELECT result,shots FROM reviews WHERE job_id=?').get(jobId) as {result:string;shots:string};
  expect(JSON.parse(published.result)).toMatchObject({reviewer_comment:'复核完成'});
  expect(JSON.parse(published.shots)).toEqual(capture.shots);
});


it('fails sealed-only recovery closed for mismatched material or a corrupted saved output', async () => {
  const s=await setup([()=>wireText(initialText)]);
  const env=s.makeEnv('review');
  await embeddedHarnessCompletion(env,s.input('review'));
  env.harnessExecution!.recoverSealed=true;
  await expect(harnessCompletion(env,s.input('review',[{type:'text',text:'Different material'}]))).rejects.toThrow('锁定结果无法核验');
  expect(await harnessCompletion(env,s.input('review'))).toBe(initialText);
  const chunk=await s.storage.get<string>('embedded-result:review:0');
  const sealed=JSON.parse(chunk!);
  await s.storage.put('embedded-result:review:0',JSON.stringify({...sealed,text:verifiedText}));
  await expect(harnessCompletion(env,s.input('review'))).rejects.toThrow('锁定结果无法核验');
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
