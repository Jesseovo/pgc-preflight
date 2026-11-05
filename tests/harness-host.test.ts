import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeHarnessTask, HarnessHost, harnessMaterialFiles, harnessResultText, readHarnessPrivate,
} from '../server/harness-host';
import { finishHarnessRequest, forwardHarnessRequest, getHarnessRun, reserveHarnessRequest, type HarnessDatabase } from '../server/harness-ledger';
import { harnessCompletion, harnessExecutionFor } from '../server/harness-execution';
import { canonicalHarness, CCB_ENGINE_COMMIT, harnessHash, modelContractHash, newHarnessPolicy, type HarnessPolicy } from '../server/harness-policy';
import type { ModelConfig } from '../server/settings';
import { buildHarnessConfig } from '../scripts/prepare-harness-release';

const tool = vi.hoisted(() => ({ close: vi.fn(async () => {}), execute: vi.fn(async (_body: unknown, _deadline: number) => ({ ok: true })) }));
vi.mock('../server/harness-tools', () => ({ HarnessTools: class { close = tool.close; execute = tool.execute; } }));

const opened: DatabaseSync[] = [];
const sourceHash = '1'.repeat(64);
const accountId = '1'.repeat(32);
const imageReference = `registry.cloudflare.com/${accountId}/pgc-harness-fixture@sha256:${sourceHash}`;
const requestHash = '2'.repeat(64);
const html = '<!doctype html><html lang="zh"><title>合成</title></html>';
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVQYV2NgAAIAAAUAAYoz4wQAAAAASUVORK5CYII=';
const secondImage = '/9j/2Q==';
const profile = {
  protocol: 'anthropic' as const, model: 'claude-opus-5-5', baseUrl: 'https://riffle-api.pages.dev', effort: 'high' as const,
  encryptedKey: 'synthetic-encrypted-key', updatedAt: 'fixture', enabled: true, vision: true,
};
const config: ModelConfig = { ...profile, activeProfile: 'opus', profiles: { opus: profile } };

class MemoryStorage {
  values = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { return this.values.delete(key); }
  async deleteAll() { this.values.clear(); }
  async transaction<T>(callback: (tx: this) => Promise<T>) { return callback(this); }
  async setAlarm(time: number) { this.alarmAt = time; }
  async deleteAlarm() { this.alarmAt = null; }
}

type Envelope = { runId: string; taskId: string; generation: string; phase: string; imagePaths?: string[]; files: { path: string; content: string; sha256: string }[] };
type StartBody = { envelope: Envelope; envelopeSha256: string; lease: string };
type Meta = { taskId: string; generation: string; createdAt: number; phase: string; state: string };
const file = async (path: string, content: string) => ({ path, content, encoding: 'utf8', sha256: await harnessHash(content) });

function mockedContainer() {
  let startBody: StartBody | null = null;
  let output: unknown = null;
  let failedCleanup = false;
  const state = {
    running: false,
    images: { ccb: imageReference },
    start: vi.fn((_options: unknown) => { state.running = true; startBody = null; output = null; }),
    interceptAllOutboundHttp: vi.fn(async (_outbound: unknown) => {}),
    interceptOutboundHttps: vi.fn(async (_host: string, _outbound: unknown) => {}),
    setInactivityTimeout: vi.fn(async (_timeout: number) => {}),
    destroy: vi.fn(async () => {
      if (failedCleanup) throw new Error('synthetic container teardown outage');
      state.running = false;
    }),
    getTcpPort: vi.fn((_port: number) => ({ fetch: fetchRuntime })),
  };
  const fetchRuntime = vi.fn(async (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/start') {
      startBody = await request.json() as StartBody;
      return Response.json({ state: 'running' }, { status: 202 });
    }
    if (pathname === '/v1/status') {
      return startBody ? Response.json({ runId: startBody.envelope.runId, state: output ? 'succeeded' : 'running' }) :
        Response.json({ error: 'no current run' }, { status: 404 });
    }
    if (pathname === '/v1/result') return Response.json({ runId: startBody?.envelope.runId, state: 'succeeded', files: output });
    return Response.json({}, { status: 404 });
  });
  return {
    state, fetchRuntime,
    get body() { return startBody; },
    setOutput(value: unknown) { output = value; },
    setCleanupFailure(value: boolean) { failedCleanup = value; },
    posts: () => fetchRuntime.mock.calls.filter(([request]) => request.method === 'POST' && new URL(request.url).pathname === '/v1/start'),
  };
}

async function setup() {
  const sqlite = new DatabaseSync(':memory:');
  opened.push(sqlite);
  for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${name}`, 'utf8'));
  }
  const db: HarnessDatabase = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      function bound(values: SQLInputValue[] = []) {
        return {
          bind: (...args: unknown[]) => bound(args as SQLInputValue[]),
          first: async <T>() => (statement.get(...values) as T | undefined) ?? null,
          run: async () => statement.run(...values),
        };
      }
      return bound();
    },
  };
  sqlite.exec(`INSERT INTO members(id,username,display_name,password_hash,password_salt,created_at,updated_at,star)
    VALUES ('owner','owner','owner','fixture','fixture','now','now',1),('other','other','other','fixture','fixture','now','now',1),
      ('plain','plain','plain','fixture','fixture','now','now',0)`);
  const storage = new MemoryStorage();
  const container = mockedContainer();
  const harnessOutbound = vi.fn((data: unknown) => data);
  const host = new HarnessHost({ storage, container: container.state, exports: { HarnessOutbound: harnessOutbound } }, { DB: db });
  const gamePolicy: HarnessPolicy = {
    version: 1, engine: 'ccb', engineCommit: CCB_ENGINE_COMMIT, image: imageReference, releaseHash: 'e'.repeat(64),
    family: 'forge', purpose: 'game', modelContractHash: await modelContractHash(config, 'game'),
    limits: { maxOutputTokens: 64_000, maxTotalOutputTokens: 256_000, maxModelTurns: 24, maxDurationMs: 2_400_000, maxRepairs: 2 },
  };
  const reviewPolicy: HarnessPolicy = {
    ...gamePolicy, family: 'review', purpose: 'review', modelContractHash: await modelContractHash(config, 'review'),
    limits: { maxOutputTokens: 24_000, maxTotalOutputTokens: 48_000, maxModelTurns: 8, maxDurationMs: 720_000, maxRepairs: 0 },
  };
  function forge(taskId: string, ownerId = 'owner', executor = 'platform', policy: HarnessPolicy | null = gamePolicy) {
    sqlite.prepare(`INSERT INTO forge_tasks(id,kind,scope,payload,status,owner_id,executor,harness_policy,created_at,updated_at)
      VALUES (?,'game',?,'{}','running',?,?,?,'now','now')`).run(taskId, `scope-${taskId}`, ownerId, executor, policy ? JSON.stringify(policy) : null);
  }
  function review(taskId: string, ownerId: string, modelExecutor = 'platform', executor = 'cloud') {
    sqlite.prepare(`INSERT INTO review_jobs(id,owner_id,title,status,model_executor,executor,harness_policy,created_at,updated_at)
      VALUES (?,?,'synthetic','running',?,?,?,'now','now')`).run(taskId, ownerId, modelExecutor, executor, JSON.stringify(reviewPolicy));
  }
  const taskDeadlineAt = Date.now() + 600_000;
  async function payload(phase = 'build', overrides: Record<string, unknown> = {}) {
    const materials = { system: 'Synthetic system prompt', user: ['Synthetic input', { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] };
    const input = {
      taskId: 'game', ownerId: 'owner', family: 'forge', phase, purpose: 'game', taskDeadlineAt,
      deadlineAt: Date.now() + 300_000, sourceHash, policy: gamePolicy, config, materials, maxTokens: 64_000, ...overrides,
    };
    return { ...input, materialHash: await harnessHash(canonicalHarness(input.materials)) };
  }
  function send(path: string, body?: unknown, headers: Record<string, string> = {}) {
    return host.fetch(new Request(`http://harness${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }
  function readPhase(path: '/status' | '/result', input: { phase: string; materialHash: string }) {
    return send(`${path}?phase=${input.phase}&material=${input.materialHash}`);
  }
  async function paidRequest(phase: string, settle = true) {
    const meta = (await storage.get<Meta>('meta'))!;
    const request = { taskId: meta.taskId, generation: meta.generation, requestId: `${phase}-0-turn` };
    expect(await reserveHarnessRequest(db, request, requestHash, 40)).toMatchObject({ status: 'reserved' });
    expect(await forwardHarnessRequest(db, request)).toBe(true);
    if (settle) expect(await finishHarnessRequest(db, request, { state: 'completed', outputTokens: 27, finishReason: 'end_turn' })).toBe(true);
    return request;
  }
  return { db, sqlite, storage, container, harnessOutbound, host, gamePolicy, reviewPolicy, forge, review, payload, send, readPhase, paidRequest };
}

afterEach(() => {
  vi.restoreAllMocks();
  tool.close.mockClear();
  tool.execute.mockClear();
  opened.splice(0).forEach(db => db.close());
});

describe('harness platform policy and authorization', () => {
  it('keeps legacy tasks and unconfigured rollout on the original execution path', async () => {
    const { db, sqlite, gamePolicy } = await setup();
    const get = vi.fn(async () => config);
    const binding = { idFromName: (name: string) => name, get: () => ({ fetch: vi.fn() }) };
    const release: Parameters<typeof buildHarnessConfig>[2] = {
      engineCommit: CCB_ENGINE_COMMIT, image: imageReference, rightsConfirmed: true, comparisonAccepted: true,
      isolationVerified: true, providerCompatibilityVerified: true, evidenceHash: gamePolicy.releaseHash,
      compatibleModelContracts: [gamePolicy.modelContractHash],
    };
    const base = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
    const generated = buildHarnessConfig({ ...base, account_id: accountId }, process.cwd(), release);
    expect(generated.containers[0].images.ccb.image).toBe(release.image);
    expect(JSON.parse(generated.vars.HARNESS_RELEASE).image).toBe(release.image);
    expect(generated.vars.HARNESS_ROLLOUT).toBe('off');
    const env = { DB: db, modelStore: { get }, HARNESS_RUNNER: binding, HARNESS_RELEASE: generated.vars.HARNESS_RELEASE };
    for (const HARNESS_ROLLOUT of [undefined, 'off', 'all', 'unknown']) {
      expect(await newHarnessPolicy({ ...env, HARNESS_ROLLOUT }, 'owner', 'forge', 'game')).toBeNull();
    }
    expect(harnessExecutionFor({ id: 'old', owner_id: 'owner', executor: 'platform' }, 'forge', 'build', sourceHash, Date.now() + 1000)).toBeUndefined();
    expect(() => harnessExecutionFor({ id: 'device', executor: 'agent', harness_policy: gamePolicy }, 'forge', 'build', sourceHash, Date.now() + 1000)).toThrow();
    expect(() => harnessExecutionFor({ id: 'device', model_executor: 'agent', harness_policy: { ...gamePolicy, family: 'review', purpose: 'review' } }, 'review', 'review', sourceHash, Date.now() + 1000)).toThrow();
    expect(await newHarnessPolicy({ ...env, HARNESS_ROLLOUT: 'pilot' }, 'owner', 'forge', 'game')).toBeNull();
    expect(get).not.toHaveBeenCalled();
    sqlite.exec("INSERT INTO review_pilot_members(member_id,pilot_enabled,creator_account,revision,updated_at) VALUES('owner',1,'',1,'now')");
    await expect(newHarnessPolicy({ ...env, HARNESS_ROLLOUT: 'pilot', HARNESS_RELEASE: '{}' }, 'owner', 'forge', 'game')).rejects.toThrow();
    for (const providerCompatibilityVerified of [undefined, false]) {
      await expect(newHarnessPolicy({
        ...env, HARNESS_ROLLOUT: 'pilot', HARNESS_RELEASE: JSON.stringify({ ...release, providerCompatibilityVerified }),
      }, 'owner', 'forge', 'game')).rejects.toThrow();
    }
    expect(get).not.toHaveBeenCalled();
    for (const image of [undefined, 'registry.cloudflare.com/example/repo:latest', imageReference.replace('@sha256:', ':'), imageReference + '\n']) {
      await expect(newHarnessPolicy({
        ...env, HARNESS_ROLLOUT: 'pilot', HARNESS_RELEASE: JSON.stringify({ ...release, image }),
      }, 'owner', 'forge', 'game')).rejects.toThrow();
    }
    expect(get).not.toHaveBeenCalled();
    expect(() => harnessExecutionFor({ id: 'unbound', executor: 'platform', harness_policy: { ...gamePolicy, image: undefined } },
      'forge', 'build', sourceHash, Date.now() + 1000)).toThrow();
    expect(await newHarnessPolicy({ ...env, HARNESS_ROLLOUT: 'pilot' }, 'owner', 'forge', 'game')).toEqual(gamePolicy);
  });

  it('requires the exact active platform owner and separates admin, device and member paths', async () => {
    const { db, sqlite, forge, review, payload, send, container } = await setup();
    forge('game');
    forge('personal-agent', 'owner', 'agent');
    forge('non-star', 'plain');
    forge('legacy', 'owner', 'platform', null);
    review('admin-cloud', 'admin');
    review('admin-device', 'admin', 'agent', 'device');
    review('member-cloud', 'owner');
    const allowed = (taskId: string, ownerId: string, family: 'forge' | 'review') =>
      authorizeHarnessTask({ DB: db }, { taskId, ownerId, family });
    expect(await allowed('game', 'owner', 'forge')).toBe(true);
    expect(await allowed('game', 'other', 'forge')).toBe(false);
    expect(await allowed('personal-agent', 'owner', 'forge')).toBe(false);
    expect(await allowed('non-star', 'plain', 'forge')).toBe(false);
    expect(await allowed('legacy', 'owner', 'forge')).toBe(false);
    expect(await allowed('admin-cloud', 'admin', 'review')).toBe(true);
    expect(await allowed('admin-device', 'admin', 'review')).toBe(false);
    expect(await allowed('member-cloud', 'owner', 'review')).toBe(false);
    expect((await send('/start', await payload('build', { ownerId: 'other' }))).status).toBe(403);
    sqlite.exec("UPDATE members SET enabled=0 WHERE id='owner'");
    expect((await send('/start', await payload())).status).toBe(403);
    expect(container.state.start).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT count(*) AS count FROM harness_runs').get()).toEqual({ count: 0 });
  });
});

describe('harness evidence and result binding', () => {
  it('preserves each original evidence byte sequence and ordering in the container envelope', async () => {
    const materials = {
      system: 'Synthetic evidence', previousHtml: html,
      user: ['first label', `data:image/png;base64,${image}`, 'second label',
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: secondImage } }],
    };
    const packed = await harnessMaterialFiles(materials);
    expect(packed.imagePaths).toEqual(['input/image-1.png', 'input/image-2.jpg']);
    for (const [index, original] of [image, secondImage].entries()) {
      const item = packed.files[index];
      expect(item).toMatchObject({ path: packed.imagePaths[index], encoding: 'base64', content: original });
      expect(item.sha256).toEqual(await crypto.subtle.digest('SHA-256', Buffer.from(original, 'base64')).then(bytes => Buffer.from(bytes).toString('hex')));
    }
    expect(JSON.parse(packed.files[2].content).user).toEqual([
      'first label', { imagePath: packed.imagePaths[0] }, 'second label', { imagePath: packed.imagePaths[1] },
    ]);
    expect(packed.files[2].content).not.toContain(image);
    expect(packed.files[3]).toMatchObject({ path: 'input/game.html', content: html, sha256: await harnessHash(html) });
  });

  it('rejects non-hashed or modified results and rechecks the stored result on the execution client', async () => {
    const { gamePolicy } = await setup();
    const result = await file('result.txt', 'locked result');
    expect(await harnessResultText({ state: 'succeeded', files: [result] }, 'review')).toBe('locked result');
    await expect(harnessResultText({ state: 'succeeded', text: 'unhashed', files: [] }, 'review')).rejects.toThrow('harness_result_missing');
    await expect(harnessResultText({ state: 'succeeded', files: [{ ...result, content: 'tampered' }] }, 'review')).rejects.toThrow('harness_result_hash');
    await expect(harnessResultText({ state: 'succeeded', files: [result, result] }, 'review')).rejects.toThrow('harness_result_hash');
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/start') return Response.json({ state: 'running' });
      if (url.pathname === '/status') return Response.json({ state: 'succeeded' });
      return Response.json({ text: 'tampered', materialHash: url.searchParams.get('material'), outputHash: result.sha256 });
    });
    const deadlineAt = Date.now() + 10000;
    const execution = harnessExecutionFor({ id: 'task', owner_id: 'owner', executor: 'platform', harness_policy: gamePolicy },
      'forge', 'build', sourceHash, deadlineAt)!;
    await expect(harnessCompletion({
      harnessExecution: execution, modelStore: { get: async () => config },
      HARNESS_RUNNER: { idFromName: name => name, get: () => ({ fetch }) },
    }, { system: 'Synthetic system', user: 'Synthetic input', purpose: 'game' })).rejects.toThrow('Harness 结果与锁定材料不符');
    expect(fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(['/start', '/status', '/result']);
  });
});

describe('harness phase recovery, ledger and cleanup', () => {
  it('serializes concurrent alarm and result reads, pins material and never replays completed phases', async () => {
    const { db, storage, container, host, forge, payload, send, readPhase, paidRequest, harnessOutbound } = await setup();
    forge('game');
    const build = await payload();
    expect((await send('/start', await payload('polish'))).status).toBe(409);
    const [one, duplicate] = await Promise.all([send('/start', build), send('/start', build)]);
    expect(one.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ state: 'running' });
    expect(container.posts()).toHaveLength(1);
    expect(container.body?.envelopeSha256).toBe(await harnessHash(canonicalHarness(container.body!.envelope)));
    expect(container.body?.envelope.imagePaths).toEqual(['input/image-1.png']);
    expect(container.state.start).toHaveBeenCalledWith(expect.objectContaining({
      enableInternet: false, instance: 'standard-1', image: imageReference,
      env: { PGC_HARNESS_CONTROL_TOKEN: expect.any(String), PGC_HARNESS_GATEWAY_URL: 'http://pgc-harness.internal' },
    }));
    expect(JSON.stringify(container.state.start.mock.calls)).not.toContain(profile.encryptedKey);
    expect(harnessOutbound).toHaveBeenCalledWith({ props: expect.objectContaining({ requestIdPrefix: 'build-0-', lease: container.body?.lease }) });
    expect((await send('/start', await payload('build', { materials: { system: 'Changed material' } }))).status).toBe(409);
    const id = await paidRequest('build');
    expect((await send('/finish', { outcome: 'completed' })).status).toBe(409);
    expect(await getHarnessRun(db, id)).toMatchObject({ status: 'active', releasedAt: null });
    container.setOutput([await file('game.html', html), await file('record.json', '{}')]);
    const [, statusResponse, resultResponse] = await Promise.all([host.alarm(), readPhase('/status', build), readPhase('/result', build)]);
    expect(await statusResponse.json()).toMatchObject({ state: 'succeeded', usage: { modelTurns: 1, outputTokens: 27, reservedTokens: 0 } });
    const result = await resultResponse.json() as { text: string; materialHash: string; outputHash: string };
    expect(result.text).toContain(html);
    expect(result.materialHash).toBe(build.materialHash);
    expect(result.outputHash).toBe(await harnessHash(result.text));
    expect(container.fetchRuntime.mock.calls.filter(([req]) => new URL(req.url).pathname === '/v1/result')).toHaveLength(1);
    expect(container.state.destroy).toHaveBeenCalledTimes(1);
    expect(tool.close).toHaveBeenCalled();
    expect((await send('/finish', { outcome: 'completed' })).status).toBe(409);

    const polish = await payload('polish');
    expect((await send('/start', polish)).status).toBe(200);
    const replay = await send('/start', build);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'harness_phase_conflict' });
    await paidRequest('polish');
    container.setOutput([await file('game.html', html), await file('record.json', '{}')]);
    expect((await readPhase('/result', polish)).ok).toBe(true);
    expect((await send('/start', build)).status).toBe(409);
    expect(container.posts()).toHaveLength(2);
    expect((await send('/finish', { outcome: 'completed' })).ok).toBe(true);
    await send('/cancel', { reason: 'late-client-timeout' });
    await send('/finish', { outcome: 'failed' });
    expect((await storage.get<Meta>('meta'))?.state).toBe('completed');
    expect((await send('/finish', { outcome: 'completed' })).ok).toBe(true);
    expect(await getHarnessRun(db, id)).toMatchObject({ status: 'done', modelTurns: 2, outputTokens: 54, releasedAt: expect.any(Number) });
    expect(await readHarnessPrivate(storage, 'result:build')).not.toBeNull();
    expect(await readHarnessPrivate(storage, 'result:polish')).not.toBeNull();
  });

  it('rejects starts on a changed image while preserving the already completed phase', async () => {
    const { db, sqlite, container, forge, payload, send, readPhase, paidRequest } = await setup();
    forge('game');
    const build = await payload();
    const updatedImage = `registry.cloudflare.com/${accountId}/pgc-harness-fixture@sha256:${'f'.repeat(64)}`;
    container.state.images.ccb = updatedImage;
    const missingImage = await send('/start', build);
    expect(missingImage.status).toBe(409);
    expect(await missingImage.json()).toEqual({ error: 'harness_image_conflict' });
    expect(sqlite.prepare('SELECT count(*) AS count FROM harness_runs').get()).toEqual({ count: 0 });
    expect(container.state.start).not.toHaveBeenCalled();

    container.state.images.ccb = imageReference;
    expect((await send('/start', build)).ok).toBe(true);
    const id = await paidRequest('build');
    expect(JSON.parse((sqlite.prepare('SELECT snapshot FROM harness_runs').get() as { snapshot: string }).snapshot).image)
      .toBe(imageReference);
    container.setOutput([await file('game.html', html), await file('record.json', '{}')]);
    expect((await readPhase('/result', build)).ok).toBe(true);

    container.state.images.ccb = updatedImage;
    expect(await (await send('/start', build)).json()).toMatchObject({ state: 'succeeded' });
    const next = await send('/start', await payload('polish'));
    expect(next.status).toBe(409);
    expect(await next.json()).toEqual({ error: 'harness_image_conflict' });
    expect(container.posts()).toHaveLength(1);
    expect(await getHarnessRun(db, id)).toMatchObject({ status: 'active', modelTurns: 1 });
  });

  it('reconciles a final checkpoint when the business row completes before the alarm and finish race', async () => {
    const { db, sqlite, storage, container, host, forge, payload, send, readPhase, paidRequest } = await setup();
    forge('game');
    let completed: Awaited<ReturnType<typeof paidRequest>> | undefined;
    for (const phase of ['build', 'polish']) {
      const input = await payload(phase);
      expect((await send('/start', input)).ok).toBe(true);
      completed = await paidRequest(phase);
      container.setOutput([await file('game.html', html), await file('record.json', '{}')]);
      expect((await readPhase('/result', input)).ok).toBe(true);
    }
    sqlite.exec("UPDATE forge_tasks SET status='done' WHERE id='game'");
    const [, finished] = await Promise.all([host.alarm(), send('/finish', { outcome: 'completed' })]);
    expect(finished.ok).toBe(true);
    expect(await getHarnessRun(db, completed!)).toMatchObject({ status: 'done', releasedAt: expect.any(Number) });
    expect(container.posts()).toHaveLength(2);

    const meta = (await storage.get<Meta>('meta'))!;
    vi.spyOn(Date, 'now').mockReturnValue(meta.createdAt + 86_400_000);
    await host.alarm();
    expect(storage.values.size).toBe(0);
    expect(await getHarnessRun(db, completed!)).toMatchObject({ status: 'done', releasedAt: expect.any(Number) });
  });

  it('uses the ledger to reject a restarted host with lost private state and a prior paid request', async () => {
    const { db, storage, container, forge, payload, send, paidRequest } = await setup();
    forge('game');
    const build = await payload();
    expect((await send('/start', build)).ok).toBe(true);
    const id = await paidRequest('build', false);
    await storage.deleteAll();

    const response = await send('/start', build);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'harness_prior_execution_unknown' });
    expect(container.posts()).toHaveLength(1);
    expect(container.state.running).toBe(false);
    expect(await getHarnessRun(db, id)).toMatchObject({ status: 'unknown', releasedAt: expect.any(Number) });
  });

  it('holds the slot while teardown fails and retries cleanup on the alarm with the business row still running', async () => {
    const { db, sqlite, container, host, forge, payload, send, paidRequest } = await setup();
    forge('game');
    const build = await payload();
    expect((await send('/start', build)).ok).toBe(true);
    const id = await paidRequest('build', false);
    container.setCleanupFailure(true);
    expect((await send('/finish', { outcome: 'failed' })).status).toBe(503);
    expect(await getHarnessRun(db, id)).toMatchObject({ status: 'unknown', releasedAt: null });
    expect(container.state.running).toBe(true);
    expect(sqlite.prepare("SELECT status FROM forge_tasks WHERE id='game'").get()).toEqual({ status: 'running' });

    container.setCleanupFailure(false);
    await host.alarm();
    expect(container.state.running).toBe(false);
    expect(await getHarnessRun(db, id)).toMatchObject({ status: 'unknown', releasedAt: expect.any(Number) });
    expect(container.posts()).toHaveLength(1);
  });

  it('preserves the original admin image bytes in both review phases and finalizes after verify', async () => {
    const { db, container, review, reviewPolicy, payload, send, readPhase, paidRequest } = await setup();
    review('admin-job', 'admin');
    const shared = { taskId: 'admin-job', ownerId: 'admin', family: 'review', policy: reviewPolicy, maxTokens: 24_000 };
    const initial = await payload('review', { ...shared, purpose: 'review' });
    const verify = await payload('review_verify', {
      ...shared, purpose: 'review_verify',
      materials: { ...initial.materials, user: [...initial.materials.user, 'Synthetic initial report for verification'] },
    });
    expect(verify.materialHash).not.toBe(initial.materialHash);
    expect((await send('/start', verify)).status).toBe(409);
    expect((await send('/start', initial)).ok).toBe(true);
    const original = container.body!.envelope.files.find(item => item.path === 'input/image-1.png');
    const id = await paidRequest('review');
    container.setOutput([await file('result.txt', 'synthetic initial report')]);
    expect(await (await readPhase('/result', initial)).json()).toMatchObject({ text: 'synthetic initial report' });
    expect((await send('/finish', { outcome: 'completed' })).status).toBe(409);
    expect((await send('/start', verify)).ok).toBe(true);
    expect(container.body!.envelope.files.find(item => item.path === 'input/image-1.png')).toEqual(original);
    await paidRequest('review_verify');
    container.setOutput([await file('result.txt', 'synthetic verified report')]);
    expect(await (await readPhase('/result', verify)).json()).toMatchObject({ text: 'synthetic verified report' });
    expect((await send('/finish', { outcome: 'completed' })).ok).toBe(true);
    expect(await getHarnessRun(db, id)).toMatchObject({ status: 'done', modelTurns: 2, releasedAt: expect.any(Number) });
  });

  it('revokes tool access and marks a forwarded model request unknown without starting another phase', async () => {
    const { db, sqlite, container, host, forge, payload, send, paidRequest } = await setup();
    forge('game');
    const build = await payload();
    expect((await send('/start', build)).ok).toBe(true);
    const lease = container.body!.lease;
    const browser = { name: 'capture', arguments: {} };
    expect((await send('/tools', browser, { authorization: 'Bearer wrong' })).status).toBe(403);
    expect((await send('/tools', browser, { authorization: `Bearer ${lease}` })).ok).toBe(true);
    const id = await paidRequest('build', false);
    sqlite.exec("UPDATE members SET star=0 WHERE id='owner'");
    expect((await send('/tools', browser, { authorization: `Bearer ${lease}` })).status).toBe(403);
    await host.alarm();
    expect(await getHarnessRun(db, id)).toMatchObject({ status: 'unknown', releasedAt: expect.any(Number) });
    expect((await send('/start', build)).status).toBe(403);
    expect(container.posts()).toHaveLength(1);
    expect(container.state.running).toBe(false);
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });
});

it('starts the game clock at actual allocation after an explicit full-capacity refusal',async()=>{
  const {db,sqlite,forge,payload,send,container,storage,gamePolicy}=await setup();
  const {createHarnessRun,endHarnessRun,lockHarnessModel,releaseHarnessSlot}=await import('../server/harness-ledger');
  const model=(await lockHarnessModel(config,'game'))!;
  const holders=await Promise.all(['holder-a','holder-b'].map(taskId=>createHarnessRun(db,{
    taskId,generation:'fixture',ownerId:'owner',actor:'star',sourceHash,snapshot:{},model,
  })));
  expect(holders.every(Boolean)).toBe(true);
  forge('game');
  const input=await payload('build',{startWindow:'allocation',deadlineAt:0,taskDeadlineAt:0});
  expect((await send('/start',input)).status).toBe(429);
  expect(await storage.get('meta')).toBeUndefined();
  expect(container.posts()).toHaveLength(0);
  expect(sqlite.prepare("SELECT 1 FROM harness_runs WHERE task_id='game'").get()).toBeUndefined();
  const released=holders[0]!.run;
  await endHarnessRun(db,released,'failed');
  await releaseHarnessSlot(db,released);
  const allocation=await send('/start',input);
  expect(allocation.status).toBe(200);
  const clock=await allocation.json() as {startedAt:number;taskDeadlineAt:number;stageDeadlineAt:number};
  expect(clock.taskDeadlineAt-clock.startedAt).toBe(gamePolicy.limits.maxDurationMs);
  expect(clock.stageDeadlineAt-clock.startedAt).toBe(12*60_000);
  const run=await getHarnessRun(db,container.body!.envelope);
  expect(run).toMatchObject({startedAt:clock.startedAt,deadlineAt:clock.taskDeadlineAt});
  expect((await send('/start',input)).status).toBe(400);
  expect(container.posts()).toHaveLength(1);
});

it('returns a reschedule signal only for an explicit capacity refusal and does not mark a model start',async()=>{
  const {gamePolicy}=await setup();
  const {HarnessCapacityWait}=await import('../server/harness-execution');
  const request={system:'Synthetic',user:'Locked',purpose:'game' as const,onStart:vi.fn(async()=>{})};
  const execution=harnessExecutionFor({id:'game',owner_id:'owner',executor:'platform',harness_policy:gamePolicy},
    'forge','build',sourceHash,Date.now()+2_400_000)!;
  execution.onAllocated=vi.fn(async()=>{});
  const fetch=vi.fn()
    .mockResolvedValueOnce(Response.json({error:'harness_capacity'},{status:429}))
    .mockResolvedValueOnce(Response.json({error:'unexpected_rate_limit'},{status:429}));
  const env={harnessExecution:execution,modelStore:{get:async()=>config},HARNESS_RUNNER:{idFromName:(id:string)=>id,get:()=>({fetch})}};
  await expect(harnessCompletion(env,request)).rejects.toBeInstanceOf(HarnessCapacityWait);
  await expect(harnessCompletion(env,request)).rejects.toThrow('unexpected_rate_limit');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(request.onStart).not.toHaveBeenCalled();
  expect(execution.onAllocated).not.toHaveBeenCalled();
});
