import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { COMPARISON_SERVICE_NONCE_SCHEMA, createComparisonServiceHandler } from '../server/harness-comparison-service';
import { canonicalHarness, CCB_ENGINE_COMMIT, modelContractHash } from '../server/harness-policy';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareComparisonBaseline } from '../scripts/prepare-harness-comparison-baseline';

const repo = fileURLToPath(new URL('../', import.meta.url));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const firstId = '44444444-4444-8444-8444-444444444444';
const secondId = '55555555-5555-8555-8555-555555555555';
const reviewProfile = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', protocol: 'openai', enabled: true,
  updatedAt: '2026-11-06T00:00:00.000Z', vision: true, effort: 'low', maxOutputTokens: 24_000 };
const opusProfile = { ...reviewProfile, baseUrl: 'https://riffle-api.pages.dev', model: 'claude-opus-5-5', protocol: 'anthropic', effort: 'high', maxOutputTokens: 64_000 };

function stream(events: unknown[]) {
  const data = new TextEncoder().encode(events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('private adapter from the pinned A archive', () => {
  let temporary: string, prepared: ReturnType<typeof prepareComparisonBaseline>;
  let entry: any, complete: any, model: any;
  beforeAll(async () => {
    temporary = mkdtempSync(join(realpathSync(tmpdir()), 'pgc-prepare-a-test-'));
    symlinkSync(join(repo, 'node_modules'), join(temporary, 'node_modules'));
    // The generated source can find dependencies without writing into the archive tree.
    prepared = prepareComparisonBaseline({ out: join(temporary, 'prepared') });
    entry = await import(pathToFileURL(prepared.entry).href);
    complete = (await import(pathToFileURL(join(prepared.source, 'server/forge-llm.ts')).href)).complete;
    model = await import(pathToFileURL(join(prepared.source, 'server/model.ts')).href);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => rmSync(temporary, { force: true, recursive: true }));

  it('keeps the Git archive byte-identical and produces a reviewable, separately hashed patch', () => {
    const archive = readFileSync(join(prepared.output, 'baseline.tar'));
    expect(archive.equals(execFileSync('git', ['archive', '--format=tar', '8afbf81c85c785f5d2d071dda9ecedba510b42ab'], { cwd: repo, maxBuffer: 10 * 1024 * 1024 }))).toBe(true);
    const patch = join(prepared.output, 'adapter.patch');
    expect(prepared.manifest).toMatchObject({ implementationCommit: '8afbf81c85c785f5d2d071dda9ecedba510b42ab',
      tree: '491936d02f57b9125be86e36e73e76048009d82f', archiveSha256: sha(archive), adapterPatchSha256: sha(readFileSync(patch)),
      executionAuthorized: false, deploymentPerformed: false, providerRequests: 0,
    });
    const original = join(temporary, 'untouched');
    mkdirSync(original);
    execFileSync('tar', ['-xf', join(prepared.output, 'baseline.tar'), '-C', original]);
    execFileSync('git', ['apply', '--check', patch], { cwd: original });
    execFileSync('git', ['apply', patch], { cwd: original });
    expect(execFileSync('diff', ['-rq', original, prepared.source]).toString()).toBe('');
    for (const file of ['server/model.ts', 'server/forge-llm.ts', 'server/comparison-baseline-entry.ts', 'migrations/0032_forge_creation_pipeline.sql']) {
      expect(readFileSync(join(original, file))).toEqual(readFileSync(join(prepared.source, file)));
    }
    expect(statSync(prepared.output).mode & 0o777).toBe(0o700);
    expect(() => prepareComparisonBaseline({ out: prepared.output })).toThrow('EEXIST');
    for (const name of ['enqueueForgeTask', 'creationPipelineAlarm', 'enqueueReview', 'cloudReviewAlarm']) expect(entry[name]).toBeTypeOf('function');
  });

  it('keeps Anthropic and DeepSeek streaming wires, task identities and original idempotency keys separate', async () => {
    const direct = vi.fn(() => { throw new Error('Direct network disabled'); });
    vi.stubGlobal('fetch', direct);
    const calls: { identity: any; url: string; init: RequestInit; started: boolean }[] = [];
    let startedReview = false;
    const review = await entry.createBaselineTaskAdapter({ taskId: firstId, ownerId: 'admin', operation: 'review' }, reviewProfile,
      async (identity: unknown, url: string, init: RequestInit) => {
        calls.push({ identity, url, init, started: startedReview });
        return stream([{ choices: [{ delta: { content: '{"score":1}' } }] }, { choices: [{ finish_reason: 'stop' }] }, '[DONE]']);
      });
    const creation = await entry.createBaselineTaskAdapter({ taskId: secondId, ownerId: 'star', operation: 'creation' }, opusProfile,
      async (identity: unknown, url: string, init: RequestInit) => {
        calls.push({ identity, url, init, started: true });
        return stream([{ type: 'content_block_delta', delta: { type: 'text_delta', text: '<html></html>' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]);
      });
    const [result, html] = await Promise.all([
      complete(review.environment({}), {}, { system: 'System', user: 'Review', schema: { type: 'object' }, purpose: 'review_verify',
        idempotencyKey: `pgc-review-${firstId}-verify`, onStart: async () => { startedReview = true; } }),
      complete(creation.environment({}), {}, { system: 'System', user: 'Creation', purpose: 'game', maxTokens: 64_000,
        outputEffort: 'high', idempotencyKey: `pgc-create-${secondId}:polish`, requiredProfile: 'opus' }),
    ]);
    expect(result).toEqual({ score: 1 });
    expect(html).toBe('<html></html>');
    expect(calls).toHaveLength(2);
    const a = calls.find(call => call.identity.taskId === firstId)!;
    const b = calls.find(call => call.identity.taskId === secondId)!;
    expect(a.identity).toEqual({ arm: 'A', taskId: firstId, ownerId: 'admin', operation: 'review', stage: 'review_verify' });
    expect(b.identity).toEqual({ arm: 'A', taskId: secondId, ownerId: 'star', operation: 'creation', stage: 'polish' });
    expect(a.url).toBe('https://api.deepseek.com/chat/completions');
    expect(b.url).toBe('https://riffle-api.pages.dev/v1/messages');
    expect(JSON.parse(String(a.init.body))).toMatchObject({ model: 'deepseek-flash', stream: true, max_tokens: 24_000,
      thinking: { type: 'enabled' }, reasoning_effort: 'low', response_format: { type: 'json_object' }, stream_options: { include_usage: true } });
    expect(JSON.parse(String(b.init.body))).toMatchObject({ model: 'claude-opus-5-5', stream: true, max_tokens: 64_000,
      thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    const openai = new Headers(a.init.headers), anthropic = new Headers(b.init.headers);
    expect(openai.get('Authorization')).toBe(`Bearer ${model.COMPARISON_PROVIDER_SENTINEL}`);
    expect(anthropic.get('x-api-key')).toBe(model.COMPARISON_PROVIDER_SENTINEL);
    expect(openai.get('Idempotency-Key')).toMatch(new RegExp(`^pgc-review-${firstId}-verify-[a-f0-9]{24}$`));
    expect(anthropic.get('Idempotency-Key')).toMatch(new RegExp(`^pgc-create-${secondId}:polish-[a-f0-9]{24}$`));
    expect(calls.every(call => call.started && call.init.signal instanceof AbortSignal && call.init.redirect === 'manual')).toBe(true);
    expect(direct).not.toHaveBeenCalled();
  });

  it('fails closed without the private transport, without the sentinel, or after broker rejection', async () => {
    const direct = vi.fn();
    vi.stubGlobal('fetch', direct);
    const broker = vi.fn(async (_identity: unknown, url: string, init: RequestInit) => {
      if (url !== 'https://api.deepseek.com/chat/completions' || JSON.parse(String(init.body)).model !== 'deepseek-flash') {
        throw new Error('Broker denied destination or model');
      }
      throw new Error('unexpected allowed request');
    });
    expect(() => model.modelTransport({ ...reviewProfile, apiKey: model.COMPARISON_PROVIDER_SENTINEL })).toThrow('transport or placeholder');
    expect(() => model.modelTransport({ ...reviewProfile, apiKey: 'synthetic-non-placeholder' }, { comparisonFetch: broker })).toThrow('transport or placeholder');
    const scope = { taskId: firstId, ownerId: 'admin', operation: 'review' };
    const adapted = await entry.createBaselineTaskAdapter(scope, { ...reviewProfile, baseUrl: 'https://unapproved.invalid' }, broker);
    const request = { system: 'System', user: 'Review', purpose: 'review', idempotencyKey: `pgc-review-${firstId}` };
    await expect(complete(adapted.environment({}), {}, request)).rejects.toThrow('Broker denied destination or model');
    const wrongModel = await entry.createBaselineTaskAdapter(scope, { ...reviewProfile, model: 'deepseek-v4-flash' }, broker);
    await expect(complete(wrongModel.environment({}), {}, request)).rejects.toThrow('Broker denied destination or model');
    await expect(complete(adapted.environment({}), {}, { ...request, idempotencyKey: `pgc-review-${secondId}` })).rejects.toThrow('outside the bound task');
    await expect(entry.createBaselineTaskAdapter(scope, { ...reviewProfile, encryptedKey: 'synthetic' }, broker)).rejects.toThrow('only public model settings');
    expect(broker).toHaveBeenCalledTimes(2);
    expect(direct).not.toHaveBeenCalled();
  });

  it('recovers the archived encrypted placeholder across adapter restarts and carries stream cancellation', async () => {
    const direct = vi.fn();
    vi.stubGlobal('fetch', direct);
    const { decryptKey } = await import(pathToFileURL(join(prepared.source, 'server/settings.ts')).href);
    const scope = { taskId: firstId, ownerId: 'admin', operation: 'review' };
    let transportSignal: AbortSignal | null | undefined;
    const broker = vi.fn(async (_identity: unknown, _url: string, init: RequestInit) => {
      transportSignal = init.signal;
      return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const original = await entry.createBaselineTaskAdapter(scope, reviewProfile, broker);
    const resumed = await entry.createBaselineTaskAdapter(scope, reviewProfile, broker);
    const configFromCheckpoint = await original.environment({}).modelStore.get();
    const runtime = resumed.environment({});
    expect(await decryptKey(configFromCheckpoint.encryptedKey, runtime.SETTINGS_KEY)).toBe(model.COMPARISON_PROVIDER_SENTINEL);
    await expect(complete({ ...runtime, modelStore: { get: async () => configFromCheckpoint } }, {}, {
      system: 'System', user: 'Review', purpose: 'review', idempotencyKey: `pgc-review-${firstId}`, deadline: Date.now() + 100,
    })).rejects.toThrow('模型响应超时');
    expect(broker).toHaveBeenCalledTimes(1);
    expect(transportSignal?.aborted).toBe(true);
    expect(direct).not.toHaveBeenCalled();
  });
  it('bundles the private A Worker and runs the archived review through a signed synthetic candidate', async () => {
    const bundle = await build({ entryPoints: [prepared.workerEntry], bundle: true, write: false, format: 'esm', metafile: true,
      platform: 'neutral', mainFields: ['browser', 'module', 'main'], conditions: ['workerd', 'browser'],
      external: ['node:*'], plugins: [{ name: 'offline-cloudflare', setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class DurableObject {}\n' +
          'export class WorkerEntrypoint { constructor(ctx,env){this.env=env;} }' }));
      } }] });
    expect(Object.keys(bundle.metafile.inputs).some(path => path.includes('harness-host.ts'))).toBe(false);
    const bundlePath = join(temporary, 'archived-a-worker.mjs');
    writeFileSync(bundlePath, bundle.outputFiles[0].contents, { flag: 'wx' });
    const worker = await import(pathToFileURL(bundlePath).href);
    expect(worker.default.fetch().status).toBe(403);
    const direct = vi.fn(() => { throw new Error('Direct network disabled'); });
    vi.stubGlobal('fetch', direct);
    const sqlite = new DatabaseSync(':memory:'), nonces = new DatabaseSync(':memory:');
    try {
      for (const file of readdirSync(join(prepared.source, 'migrations')).filter(name => name.endsWith('.sql')).sort()) {
        sqlite.exec(readFileSync(join(prepared.source, 'migrations', file), 'utf8'));
      }
      sqlite.exec('CREATE TABLE comparison_arm(id,plan_sha,arm,implementation);' +
        'CREATE TABLE comparison_admissions(task_id PRIMARY KEY,identity_sha,identity_json,state,input_sha,policy_sha,created_at);' +
        'CREATE TABLE comparison_schedule_requests(task_id PRIMARY KEY,requested_at);');
      nonces.exec(COMPARISON_SERVICE_NONCE_SCHEMA);
      function statement(sql: string, values: any[] = []): any {
        return { bind: (...args: any[]) => statement(sql, args), first: async () => sqlite.prepare(sql).get(...values) ?? null,
          all: async () => ({ results: sqlite.prepare(sql).all(...values) }), run: async () => {
            const value = sqlite.prepare(sql).run(...values);
            return { meta: { changes: Number(value.changes), last_row_id: Number(value.lastInsertRowid) } };
          } };
      }
      const DB = { prepare: statement, async batch(statements: ReturnType<typeof statement>[]) {
        sqlite.exec('BEGIN');
        try {
          const result = await Promise.all(statements.map(item => item.run()));
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      } };
      const at = Date.now(), iso = new Date(at).toISOString();
      const h = (value: string) => sha(Buffer.from(value)), hc = (value: unknown) => h(canonicalHarness(value));
      const manifestSha256 = 'a'.repeat(64), commit = prepared.manifest.implementationCommit;
      const caseIds = ['tap-rhythm', 'continuous-drag', 'strategy-tradeoffs', 'collision-feedback', 'difficulty-restart', 'dense-mobile'];
      const idFor = (n: number) => '00000000-0000-8000-8000-' + String(n).padStart(12, '0');
      const ruleContent = { sourceUrl: 'https://creator-hub-7mi.pages.dev/#/', capturedAt: iso,
        rawDirection: 'Synthetic directions', rawScoring: 'Synthetic scoring', scoreMin: 0, scoreMax: 3, passScore: 7,
        notes: '', calibrationCases: [] };
      const rules = { schemaVersion: 2, id: 'synthetic-a-review-rules', contentHash: hc(ruleContent), publishedAt: iso, ...ruleContent };
      const modelConfigSha256 = h(JSON.stringify(reviewProfile));
      const slots = caseIds.flatMap((caseId, index) => [
        { taskId: idFor(index * 4), arm: 'A', operation: 'creation', caseId, modelConfigSha256 },
        { taskId: idFor(index * 4 + 1), arm: 'B', operation: 'creation', caseId, modelConfigSha256 },
        ...['A', 'B'].map((arm, offset) => ({ taskId: idFor(index * 4 + 2 + offset), arm, operation: 'review', caseId,
          modelConfigSha256, rulesSha256: h(JSON.stringify(rules)), calibrationSha256: h('[]'), requires: { creationTaskId: idFor(index * 4 + 1) } })),
      ]);
      const slot = slots[2], taskId = slot.taskId;
      const planBytes = JSON.stringify({ schemaVersion: 1, scope: 'formal', executionAllowed: false, manifestSha256,
        source: { A: { implementationCommit: commit }, B: { implementationCommit: 'b'.repeat(40), engineCommit: CCB_ENGINE_COMMIT } },
        cases: caseIds.map(id => ({ id })), slots });
      const planSha256 = h(planBytes);
      const html = '<!doctype html><title>Synthetic exact B review</title>';
      const observations = [
        ['9:16 首次触摸后约 10 秒', 'baseline-9:16-tap'], ['9:19.5 首次触摸前'],
        ['9:19.5 首次触摸后约 3 秒', 'baseline-9:19.5-tap'], ['9:21 首次触摸后约 10 秒', 'baseline-9:21-tap'],
      ].map(([label, ...actionRefs], index) => ({ id: 'baseline-' + (index + 1), label, actionRefs, capturedAt: iso }));
      const probe = JSON.stringify({ captureMethod: 'browser-viewport-v1', observations });
      const shots = observations.map((entry, index) => {
        const bytes = Buffer.from([255, 216, 255, index]);
        return { id: entry.id, sha256: sha(bytes), data: 'data:image/jpeg;base64,' + bytes.toString('base64') };
      });
      const htmlSha256 = h(html), evidenceSha256 = h(JSON.stringify({ html: htmlSha256, probe: h(probe), shots: shots.map(shot => shot.sha256) }, null, 2) + '\n');
      const pack = JSON.stringify({ schemaVersion: 1, caseId: slot.caseId, manifestSha256, evidenceSha256, captureOrigin: 'isolated-chromium',
        html: { text: html, sha256: htmlSha256 }, probe: { json: probe, sha256: h(probe) }, shots });
      const packSha256 = h(pack);
      const profile = { ...reviewProfile, protocol: 'openai' as const, effort: 'low' as const, encryptedKey: 'synthetic-marker' };
      const contract = await modelContractHash({ ...profile, activeProfile: 'comparison', profiles: { comparison: profile } }, 'review');
      const admission = canonicalHarness({ schemaVersion: 1, scope: 'formal', planSha256, manifestSha256, slot, ownerId: 'admin',
        sourceHash: htmlSha256, evidenceHash: evidenceSha256, packHash: packSha256, modelContractHash: contract, harnessPolicy: null });
      const seal = { taskId, slotSha256: hc(slot), admissionSha256: h(admission), policySha256: hc(null),
        inputSha256: hc({ inputHash: htmlSha256, rulesSnapshot: rules, evidenceSha256, packSha256 }) };
      sqlite.prepare('INSERT INTO comparison_arm VALUES(1,?,?,?)').run(planSha256, 'A', commit);
      sqlite.prepare("INSERT INTO comparison_admissions VALUES(?,?,?,'paused',?,?,?)")
        .run(taskId, seal.admissionSha256, admission, seal.inputSha256, seal.policySha256, iso);
      sqlite.prepare('INSERT INTO comparison_schedule_requests VALUES(?,?)').run(taskId, iso);
      sqlite.prepare(`INSERT INTO review_jobs(id,owner_id,title,filename,usage_day,created_at,updated_at,status,stage,executor,model_executor,
        input_ready,input_hash,rules_snapshot,report_schema_version,review_mode)
        VALUES(?,'admin',?,?,'2026-11-06',?,?,'queued','capture','cloud','platform',1,?,?,2,'basic')`)
        .run(taskId, slot.caseId, slot.caseId + '.html', iso, iso, htmlSha256, JSON.stringify(rules));
      sqlite.prepare('INSERT INTO review_inputs(job_id,part,data,created_at) VALUES(?,0,?,?)')
        .run(taskId, JSON.stringify({ html, title: slot.caseId, topic_id: null }), iso);
      const runtime = { implementationCommit: commit, runtimeTreeSha256: 'c'.repeat(64), image: null, bundleSha256: sha(Buffer.from(bundle.outputFiles[0].contents)) };
      const grant = { schemaVersion: 1, purpose: 'isolated-comparison', scope: 'formal', authorizationSha256: 'd'.repeat(64),
        dispatchGrantSha256: 'e'.repeat(64), runnerDatabaseId: 'isolated-a', planSha256, manifestSha256, implementationCommit: commit,
        runtimeTreeSha256: runtime.runtimeTreeSha256, image: null, notBefore: at - 60_000, deadlineAt: at + 600_000,
        maxRequests: 60, maxOutputTokens: 1_000_000 };
      const version = '00000000-0000-4000-8000-000000000099', workerVersion = '00000000-0000-4000-8000-000000000098';
      const authKey = 'f'.repeat(64);
      const context = { runId: 'isolated-a-run', runnerGrantSha256: hc(grant), authorizationSha256: grant.authorizationSha256,
        dispatchGrantSha256: grant.dispatchGrantSha256, runnerDatabaseId: grant.runnerDatabaseId,
        planSha256, manifestSha256, nonceDatabaseId: 'comparison-nonces', candidateVersion: version,
        notBefore: grant.notBefore, deadlineAt: grant.deadlineAt, taskIds: [taskId] };
      const report = { schema_version: 2, assessment_status: 'complete', aes: 1, ease: 2, play: 1, verdict: '打回',
        score_reasons: { aes: 'synthetic', ease: 'synthetic', play: 'synthetic' }, uncertainties: [], issues: [], strengths: [],
        reviewer_comment: 'synthetic report', fix_prompt: '', optional_suggestions: [] };
      const handle = vi.fn(async (call: Parameters<Parameters<typeof createComparisonServiceHandler>[0]['handle']>[0]) => {
        if (call.kind !== 'baseline') throw Error('Only signed baseline path is permitted');
        expect(call.scope.taskId).toBe(taskId);
        expect(call.url).toBe('https://api.deepseek.com/chat/completions');
        const body = JSON.parse(String(call.init.body));
        const images = body.messages.at(-1).content.filter((part: any) => part.type === 'image_url');
        expect(images.map((part: any) => part.image_url.url)).toEqual(shots.map(shot => shot.data));
        const stageReport = { ...report, reviewer_comment: 'synthetic ' + call.scope.stage };
        return stream([{ choices: [{ delta: { content: JSON.stringify(stageReport) } }] },
          { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 51, completion_tokens: 22 } }, '[DONE]']);
      });
      const relay = createComparisonServiceHandler({ context, authKey, executingVersion: version, handle,
        nonceDatabase: { scope: 'isolated-comparison', id: context.nonceDatabaseId, connection: { prepare(sql) {
          return { bind: (...args) => ({ first: async () => nonces.prepare(sql).get(...args) ?? null }) };
        } } } });
      const values = new Map<string, unknown>(), phases: string[] = [];
      let alarm: number | null = null;
      const storage = {
        get: async (key: string) => structuredClone(values.get(key)),
        put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); if (key === 'runner:cloudPhase') phases.push(String(value)); },
        delete: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) values.delete(key); },
        list: async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
        getAlarm: async () => alarm, setAlarm: async (value: number) => { alarm = value; }, deleteAlarm: async () => { alarm = null; },
        transaction: async (work: (tx: any) => Promise<unknown>) => work(storage),
      };
      const verifyCompletedBArtifact = vi.fn(async (proof: any) => proof.taskId === idFor(1) && proof.sourceSha256 === htmlSha256 &&
        proof.evidenceSha256 === evidenceSha256 && proof.packSha256 === packSha256);
      const frozen = new Map([JSON.stringify(reviewProfile), JSON.stringify(rules), '[]'].map(bytes => [h(bytes), bytes]));
      const id = (name: string) => ({ toString: () => 'archive-a:' + name });
      const env = { DB, COMPARISON_DATABASE_ID: grant.runnerDatabaseId, COMPARISON_WORKER_VERSION: { id: workerVersion },
        COMPARISON_DEPLOYED_RUNTIME: runtime, COMPARISON_SERVICE_CONTEXT: context, COMPARISON_SERVICE_AUTH: authKey,
        COMPARISON_TASKS: { idFromName: id, get: () => task },
        COMPARISON_AUTHORITY: { authorizeRelease: async () => true,
          readTaskRuntime: async () => ({ grant, planBytes, workerVersion, bundleSha256: runtime.bundleSha256 }),
          readFrozenInput: async (_task: string, hash: string) => frozen.get(hash), readEvidencePack: async () => pack,
          verifyCompletedBArtifact } };
      const task = worker.createBaselineTaskObject({ id: id(taskId), storage }, env, relay);
      await expect(worker.createBaselineTaskObject({ id: id(otherId()), storage }, env, relay).release(seal)).rejects.toThrow(/does not belong/);
      await expect(worker.createBaselineTaskObject({ id: id(taskId), storage }, { ...env, COMPARISON_SERVICE_AUTH: undefined }, relay)
        .release(seal)).rejects.toThrow(/signed baseline candidate/i);
      const release = await new worker.ComparisonTaskControl({}, env).release(seal);
      expect(release).toMatchObject({ taskId });
      expect(alarm).not.toBeNull();
      const restarted = worker.createBaselineTaskObject({ id: id(taskId), storage }, env, relay);
      await restarted.alarm();
      expect(sqlite.prepare('SELECT status FROM review_jobs').get()).toEqual({ status: 'done' });
      expect(handle.mock.calls.map(([call]) => call.kind === 'baseline' && call.scope.stage)).toEqual(['review', 'review_verify']);
      expect(phases).toContain('draft-ready');
      expect(phases).toContain('final-ready');
      expect(values.get('comparison:bound-task')).toBe(taskId);
      expect([...values.keys()].filter(key => key.startsWith('runner:'))).toEqual([]);
      const archive = await new worker.ComparisonTaskControl({}, env).readReviewArchive(taskId);
      expect(archive).toMatchObject([
        { taskId, stage: 'review', report: { reviewer_comment: 'synthetic review' } },
        { taskId, stage: 'review_verify', report: { reviewer_comment: 'synthetic review_verify' } },
      ]);
      expect(archive[0].materialRef).toBe(archive[1].materialRef);
      expect(sqlite.prepare('SELECT policy_sha FROM comparison_execution_releases').get()).toEqual({ policy_sha: hc(null) });
      expect(await restarted.release(seal)).toEqual(release);
      await restarted.alarm();
      expect(handle).toHaveBeenCalledTimes(2);
      const readOnly = worker.createBaselineTaskObject({ id: id(taskId), storage },
        { ...env, COMPARISON_AUTHORITY: undefined, COMPARISON_SERVICE_AUTH: undefined }, relay);
      expect(await readOnly.readReviewArchive(taskId)).toEqual(archive);
      expect(verifyCompletedBArtifact).toHaveBeenCalled();
      expect(direct).not.toHaveBeenCalled();

      function otherId() { return idFor(11); }
    } finally {
      sqlite.close(); nonces.close();
    }
  });

});
