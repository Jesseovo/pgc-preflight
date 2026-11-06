import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
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
});
