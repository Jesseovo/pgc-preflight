import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cloudReviewAlarm } from '../server/cloud-review-runner';
import { creationPipelineAlarm } from '../server/forge-creation-pipeline';
import { HarnessHost } from '../server/harness-host';
import { HARNESS_MODEL_HEADERS } from '../server/harness-protocol';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {
    constructor(protected ctx: unknown, protected env: unknown) {}
  },
}));

import worker, { ComparisonTaskControl, ComparisonTaskRunner, HarnessOutbound, HarnessRunner, comparisonHarnessOutbound,
  createComparisonTaskObject, routeComparisonRelease } from '../scripts/harness-comparison-task-worker';

type Env = Parameters<typeof routeComparisonRelease>[0];
type Context = Parameters<typeof createComparisonTaskObject>[0];
type Dependencies = NonNullable<Parameters<typeof createComparisonTaskObject>[2]>;
type Options = Parameters<Dependencies['openControl']>[0];
const taskId = '00000000-0000-8000-8000-000000000001';
const other = '00000000-0000-8000-8000-000000000002';
const version = '00000000-0000-4000-8000-000000000003';
const lease = 'f'.repeat(64);
const bundleSha256 = '7'.repeat(64);
const now = 1_800_000_000_000;
const seal = { taskId, slotSha256: 'a'.repeat(64), admissionSha256: 'b'.repeat(64), inputSha256: 'c'.repeat(64), policySha256: 'd'.repeat(64) };
const receipt = { taskId, releaseSha256: 'e'.repeat(64), releasedAt: now };
const props = { taskId, generation: 'generation-1', lease, stageDeadlineAt: now + 60_000, requestIdPrefix: 'review_verify-0-', jsonOutput: true };

let fetchTrap: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchTrap = vi.fn(() => { throw new Error('Worker composition must never use global fetch'); });
  vi.stubGlobal('fetch', fetchTrap);
});
afterEach(() => {
  expect(fetchTrap).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function memory() {
  let values = new Map<string, unknown>(), alarm: number | null = null;
  const setAlarm = vi.fn(async (at: number | Date) => { alarm = Number(at); });
  const erase = async (input: string | string[]) => typeof input === 'string'
    ? values.delete(input) : input.filter(key => values.delete(key)).length;
  const storage: Context['storage'] = {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(key, value) { values.set(key, structuredClone(value)); },
    delete: erase as Context['storage']['delete'],
    async list<T>({ prefix, limit }: { prefix: string; limit: number }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>;
    },
    async getAlarm() { return alarm; },
    setAlarm,
    async deleteAlarm() { alarm = null; },
    async transaction(operation) {
      const original = structuredClone(values), previousAlarm = alarm;
      try { return await operation(storage); }
      catch (error) { values = original; alarm = previousAlarm; throw error; }
    },
  };
  return { storage, setAlarm };
}

function setup() {
  const store = memory();
  const objectId = (id: string) => ({ toString: () => 'worker-object:' + id });
  const authority: NonNullable<Env['COMPARISON_AUTHORITY']> = {
    authorizeRelease: vi.fn(async () => true),
    readTaskRuntime: vi.fn(async () => ({ grant: {} as Options['grant'], planBytes: 'frozen', workerVersion: other, bundleSha256 })),
    readFrozenInput: vi.fn(async () => 'frozen input'),
    readEvidencePack: vi.fn(async () => 'sealed evidence'),
  };
  const forward = vi.fn<NonNullable<Env['COMPARISON_CANDIDATE_BROKER']>['forwardHarness']>()
    .mockImplementation(async () => new Response('original stream bytes', { headers: { 'x-pgc-comparison-broker-version': version } }));
  const readVerifiedProfile = vi.fn<NonNullable<Env['COMPARISON_CANDIDATE_BROKER']>['readVerifiedProfile']>()
    .mockResolvedValue(null);
  const harnessFetch = vi.fn<(request: Request) => Promise<Response>>().mockResolvedValue(new Response(null, { status: 202 }));
  const harnessGet = vi.fn(() => ({ fetch: harnessFetch }));
  const namespaceGet = vi.fn((_id: { toString(): string }) => ({ release: object.release }));
  const env: Env = {
    DB: { prepare() { throw new Error('Fixture did not wire a real task database'); } },
    COMPARISON_TASKS: { idFromName: vi.fn(objectId), get: namespaceGet },
    COMPARISON_DATABASE_ID: 'research-b',
    COMPARISON_AUTHORITY: authority, COMPARISON_CANDIDATE_BROKER: { forwardHarness: forward, readVerifiedProfile },
    COMPARISON_CANDIDATE_VERSION: version,
    COMPARISON_WORKER_VERSION: { id: other },
    COMPARISON_DEPLOYED_RUNTIME: { implementationCommit: 'a'.repeat(40), runtimeTreeSha256: 'b'.repeat(64),
      image: 'private-pinned-image', bundleSha256 },
    HARNESS_RUNNER: { idFromName: name => name, get: harnessGet },
  };
  const coreRelease = vi.fn<Awaited<ReturnType<Dependencies['openControl']>>['release']>().mockResolvedValue(receipt);
  const coreAlarm = vi.fn<ReturnType<Awaited<ReturnType<Dependencies['openControl']>>['bindTask']>['alarm']>()
    .mockResolvedValue({ state: 'invoked', taskId });
  const bindTask = vi.fn<Awaited<ReturnType<Dependencies['openControl']>>['bindTask']>().mockReturnValue({ alarm: coreAlarm });
  const openControl = vi.fn<Dependencies['openControl']>().mockResolvedValue({ release: coreRelease, bindTask });
  const deps = { openControl, now: () => now };
  const context = { id: objectId(taskId), storage: store.storage };
  const object = createComparisonTaskObject(context, env, deps);
  return { store, env, object, context, objectId, authority, deps, openControl, coreRelease, bindTask, coreAlarm, namespaceGet,
    forward, readVerifiedProfile, harnessGet, harnessFetch };
}

function modelRequest(path = '/v1/chat/completions', headers: Record<string, string> = {}) {
  return new Request('http://pgc-harness.internal' + path, { method: 'POST', body: '{"model":"deepseek-flash"}',
    headers: { 'content-type': 'application/json', [HARNESS_MODEL_HEADERS.requestId]: 'review_verify-0-turn-1', ...headers } });
}

test('ordinary Worker and DO fetch are closed, and release requires the named private service', async () => {
  const s = setup();
  expect(worker.fetch().status).toBe(403);
  expect(new ComparisonTaskControl({}, s.env).fetch().status).toBe(403);
  expect(new ComparisonTaskRunner(s.context, s.env).fetch().status).toBe(403);
  expect(HarnessRunner.prototype).toBeInstanceOf(HarnessHost);
  await expect(routeComparisonRelease({ ...s.env, COMPARISON_AUTHORITY: undefined }, seal)).rejects.toThrow(/authority is unavailable/);
  expect(s.namespaceGet).not.toHaveBeenCalled();
  vi.mocked(s.authority.authorizeRelease).mockResolvedValueOnce(false);
  await expect(routeComparisonRelease(s.env, seal)).rejects.toThrow(/refused release/);
  expect(s.coreRelease).not.toHaveBeenCalled();
  expect(await s.store.storage.get('comparison:bound-task')).toBeUndefined();
});

test('private control routes by fixed task ID and alarm recovers that ID after reopening the object', async () => {
  const s = setup();
  await s.object.alarm();
  expect(s.coreAlarm).not.toHaveBeenCalled();
  const control = new ComparisonTaskControl({}, s.env);
  await expect(control.release(seal)).resolves.toEqual(receipt);
  await expect(control.release(seal)).resolves.toEqual(receipt);
  expect(s.namespaceGet.mock.calls.map(([id]) => id.toString())).toEqual(['worker-object:' + taskId, 'worker-object:' + taskId]);
  expect(await s.store.storage.get('comparison:bound-task')).toBe(taskId);
  expect(s.store.setAlarm).toHaveBeenCalledExactlyOnceWith(now + 100);
  await expect(s.object.release({ ...seal, taskId: other })).rejects.toThrow(/does not belong/);
  const forgedInstance = createComparisonTaskObject({ ...s.context, id: s.objectId(other) }, s.env, s.deps);
  await expect(forgedInstance.release(seal)).rejects.toThrow(/does not belong/);
  await expect(forgedInstance.alarm()).rejects.toThrow(/does not belong/);
  const reopened = createComparisonTaskObject(s.context, s.env, s.deps);
  await reopened.alarm();
  expect(s.bindTask.mock.calls[0][1]).toBe(taskId);
  expect(s.coreAlarm).toHaveBeenCalledTimes(1);
  expect(s.openControl.mock.calls.at(-1)?.[0].alarms).toEqual({ creation: creationPipelineAlarm, review: cloudReviewAlarm });
  expect(s.openControl.mock.calls.at(-1)?.[0].database).toMatchObject({ scope: 'isolated-comparison', id: 'research-b' });
  expect(s.openControl.mock.calls.at(-1)?.[0].runtime).toEqual({ implementationCommit: 'a'.repeat(40),
    runtimeTreeSha256: 'b'.repeat(64), image: 'private-pinned-image' });
  await s.store.storage.put('comparison:bound-task', other);
  await expect(reopened.release(seal)).rejects.toThrow(/already bound/);
});

test('runner storage transaction and cleanup preserve the permanent object binding', async () => {
  const s = setup();
  await s.object.release(seal);
  await s.object.alarm();
  const state = s.bindTask.mock.calls[0][2] as unknown as { storage: Context['storage'] & { deleteAll(): Promise<void> } };
  await state.storage.put('creation:0', 'checkpoint');
  await expect(state.storage.transaction(async tx => {
    await tx.put('creation:0', 'partial transaction');
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(await state.storage.get('creation:0')).toBe('checkpoint');
  expect(await s.store.storage.get('runner:creation:0')).toBe('checkpoint');
  expect(await state.storage.get('comparison:bound-task')).toBeUndefined();
  await s.store.storage.put('comparison:metadata', 'persistent');
  await state.storage.deleteAll();
  expect(await state.storage.get('creation:0')).toBeUndefined();
  expect(await s.store.storage.get('comparison:bound-task')).toBe(taskId);
  expect(await s.store.storage.get('comparison:metadata')).toBe('persistent');
});

test('missing runtime or mismatched candidate profile cannot schedule a task', async () => {
  const s = setup();
  const missing = createComparisonTaskObject(s.context, { ...s.env, COMPARISON_CANDIDATE_BROKER: undefined }, s.deps);
  await expect(missing.release(seal)).rejects.toThrow(/candidate broker is unavailable/);
  const missingDb = createComparisonTaskObject(s.context, { ...s.env, COMPARISON_DATABASE_ID: undefined }, s.deps);
  await expect(missingDb.release(seal)).rejects.toThrow(/database or Harness namespace/);
  const wrongVersion = createComparisonTaskObject(s.context, { ...s.env, COMPARISON_WORKER_VERSION: { id: version } }, s.deps);
  await expect(wrongVersion.release(seal)).rejects.toThrow(/attested comparison Worker version/);
  const wrongBundle = createComparisonTaskObject(s.context, { ...s.env,
    COMPARISON_DEPLOYED_RUNTIME: { ...s.env.COMPARISON_DEPLOYED_RUNTIME!, bundleSha256: '8'.repeat(64) } }, s.deps);
  await expect(wrongBundle.release(seal)).rejects.toThrow(/attested comparison Worker version/);
  vi.mocked(s.authority.readTaskRuntime).mockResolvedValueOnce(null);
  await expect(s.object.release(seal)).rejects.toThrow(/formal runtime is unavailable/);
  s.coreRelease.mockImplementationOnce(async () => {
    const bind = s.openControl.mock.calls.at(-1)?.[0].bindVerifiedBroker!;
    const scope = { taskId } as Parameters<typeof bind>[0];
    expect(await bind({ ...scope, taskId: other })).toBeNull();
    expect(await bind(scope)).toBeNull();
    throw new Error('No verified candidate profile');
  });
  s.readVerifiedProfile.mockResolvedValueOnce({ candidateVersion: other } as NonNullable<Awaited<ReturnType<typeof s.readVerifiedProfile>>>);
  await expect(s.object.release(seal)).rejects.toThrow(/No verified candidate profile/);
  expect(s.readVerifiedProfile).toHaveBeenCalledExactlyOnceWith({ taskId }, version);
  expect(s.store.setAlarm).not.toHaveBeenCalled();
});

test('model outbound preserves exact scope and only returns the pinned broker version', async () => {
  const s = setup();
  const response = await comparisonHarnessOutbound(modelRequest(), props, s.env, () => now);
  expect(await response.text()).toBe('original stream bytes');
  const [forwarded, scope, expected] = s.forward.mock.calls[0];
  expect(expected).toBe(version);
  expect(scope).toEqual({ ...props, stage: 'review_verify' });
  expect(await forwarded.text()).toBe('{"model":"deepseek-flash"}');
  expect(forwarded.headers.get('authorization')).toBe(`Bearer ${lease}`);
  expect(forwarded.headers.get(HARNESS_MODEL_HEADERS.task)).toBe(taskId);
  expect(forwarded.headers.get(HARNESS_MODEL_HEADERS.generation)).toBe('generation-1');
  expect((await comparisonHarnessOutbound(modelRequest(), { ...props, stageDeadlineAt: now }, s.env, () => now)).status).toBe(403);
  expect((await comparisonHarnessOutbound(modelRequest('/v1/chat/completions?spoof=1'), props, s.env, () => now)).status).toBe(403);
  expect((await comparisonHarnessOutbound(modelRequest(undefined, { [HARNESS_MODEL_HEADERS.task]: other }), props, s.env, () => now)).status).toBe(403);
  expect((await comparisonHarnessOutbound(modelRequest(undefined, { [HARNESS_MODEL_HEADERS.requestId]: 'review-0-other' }), props, s.env, () => now)).status).toBe(403);
  expect((await comparisonHarnessOutbound(modelRequest(), { ...props, jsonOutput: false }, s.env, () => now)).status).toBe(403);
  expect((await comparisonHarnessOutbound(new Request('https://api.deepseek.com/chat/completions', { method: 'POST' }),
    props, s.env, () => now)).status).toBe(403);
  expect(s.forward).toHaveBeenCalledTimes(1);
  expect((await comparisonHarnessOutbound(modelRequest(), props, { ...s.env, COMPARISON_CANDIDATE_BROKER: undefined }, () => now)).status).toBe(503);
  expect((await comparisonHarnessOutbound(modelRequest(), props, { ...s.env, COMPARISON_WORKER_VERSION: { id: version } },
    () => now)).status).toBe(503);
  expect(s.forward).toHaveBeenCalledTimes(1);
  s.forward.mockResolvedValueOnce(new Response('unverified', { headers: { 'x-pgc-comparison-broker-version': other } }));
  expect((await comparisonHarnessOutbound(modelRequest(), props, s.env, () => now)).status).toBe(503);
  s.forward.mockResolvedValueOnce(new Response(null, { status: 302,
    headers: { 'x-pgc-comparison-broker-version': version, Location: 'https://example.invalid/' } }));
  expect((await comparisonHarnessOutbound(modelRequest(), props, s.env, () => now)).status).toBe(503);
  const outbound = new HarnessOutbound({ props: { ...props, stageDeadlineAt: Date.now() + 60_000 } }, s.env);
  expect((await outbound.fetch(modelRequest())).status).toBe(200);
});

test('only creation tools reach the same local Harness DO and never the candidate model service', async () => {
  const s = setup();
  const request = () => modelRequest('/v1/tools');
  expect((await comparisonHarnessOutbound(request(), props, s.env, () => now)).status).toBe(403);
  const creation = { ...props, requestIdPrefix: 'build-0-', jsonOutput: false };
  expect((await comparisonHarnessOutbound(request(), creation, s.env, () => now)).status).toBe(202);
  expect(s.harnessGet).toHaveBeenCalledExactlyOnceWith(taskId);
  const tool = s.harnessFetch.mock.calls[0][0];
  expect(tool.url).toBe('http://harness/tools');
  expect(tool.headers.get('authorization')).toBe(`Bearer ${lease}`);
  expect(s.forward).not.toHaveBeenCalled();
});


test('a lost alarm write can recover the same released task without changing its durable binding', async () => {
  const s = setup();
  s.store.setAlarm.mockRejectedValueOnce(new Error('Synthetic alarm write interruption'));
  await expect(s.object.release(seal)).rejects.toThrow(/alarm write interruption/);
  expect(await s.store.storage.get('comparison:bound-task')).toBe(taskId);
  expect(await s.store.storage.getAlarm()).toBeNull();
  const reopened = createComparisonTaskObject(s.context, s.env, s.deps);
  await expect(reopened.release(seal)).resolves.toEqual(receipt);
  expect(await s.store.storage.getAlarm()).toBe(now + 100);
  expect(s.coreRelease.mock.calls.map(([, value]) => value)).toEqual([seal, seal]);
  expect(s.coreAlarm).not.toHaveBeenCalled();
});

test('the authenticated model relay returns streaming bytes before the final chunk exists', async () => {
  const s = setup();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  s.forward.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; controller.enqueue(encoder.encode('first')); },
  }), { headers: { 'x-pgc-comparison-broker-version': version, 'content-type': 'text/event-stream' } }));
  const response = await comparisonHarnessOutbound(modelRequest(), props, s.env, () => now);
  const reader = response.body!.getReader();
  expect(decoder.decode((await reader.read()).value)).toBe('first');
  controller.enqueue(encoder.encode('final'));
  controller.close();
  expect(decoder.decode((await reader.read()).value)).toBe('final');
  expect((await reader.read()).done).toBe(true);
  expect(s.forward).toHaveBeenCalledTimes(1);
});
