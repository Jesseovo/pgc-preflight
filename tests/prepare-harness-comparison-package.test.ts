import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, Response as MockResponse } from 'miniflare';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { prepare } from '../scripts/harness-evaluation';
import { prepareComparisonPackage } from '../scripts/prepare-harness-comparison-package';

const repo = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(repo, 'fixtures/harness-evaluation');
const version = '231f7591-370d-4f92-8356-87c346f430f6';
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
type Module = { type: 'esm'; contents: string };
const esm = (contents: string): Module => ({ type: 'esm', contents });
const original = `import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
export class OriginalPrivate extends WorkerEntrypoint { marker(){return 'original named export'} }
export class OriginalDurable extends DurableObject { fetch(){return new Response('original durable export')} }
export default {
  fetch(){return new Response('original ordinary fetch')},
  scheduled(event){return 'original scheduled ' + event.cron},
  queue(batch){return 'original queue ' + batch.queue},
};
`;

let parent: string, packaged: Awaited<ReturnType<typeof prepareComparisonPackage>>;
beforeAll(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'pgc-comparison-package-')));
  const registry = join(parent, 'registry');
  await mkdir(join(registry, 'inputs'), { recursive: true, mode: 0o700 });
  async function input(name: string, value: unknown) {
    const path = `inputs/${name}.json`, bytes = encode(value);
    await writeFile(join(registry, path), bytes, { mode: 0o600 });
    return { path, sha256: sha(bytes) };
  }
  const creation = await input('creation', { model: 'claude-opus-5-5' });
  const review = await input('review', { model: 'deepseek-flash' });
  const rules = await input('rules', { synthetic: true });
  const calibration = await input('calibration', []);
  const settings = await input('settings', {
    creationModel: { name: 'claude-opus-5-5', config: creation }, reviewModel: { name: 'deepseek-flash', config: review },
    rulesVersion: 'synthetic-smoke', rules, calibration, harnessCommit: '630303565f44c061c7ed8ad7b992dcc4e9db8929',
    harnessImage: 'registry.cloudflare.com/071443b43c7562efec975a5e964d5a9c/pgc-ccb-research@sha256:0e95a0406e8dc94b0a4eea1f2cb62ff2a31ff48261d8fca87923d99ebfcec957',
  });
  const checklist = await readFile(join(fixture, 'checklists.json'));
  const cases = await Promise.all((JSON.parse(checklist.toString()) as { id: string }[]).map(async ({ id }) => ({
    id, materials: await Promise.all(['brief.md', 'sample.svg', 'assets.html'].map(async name => ({
      path: `archive/${id}/${name}`, sha256: sha(await readFile(join(fixture, id, name))),
    }))),
  })));
  const comparisonIndex = join(parent, 'index.json');
  await writeFile(comparisonIndex, encode({ schemaVersion: 1, checklistSha256: sha(checklist), cases }), { mode: 0o600 });
  await prepare(registry, join(registry, settings.path), comparisonIndex);
  const baselineSnapshot = join(parent, 'baseline.json');
  await writeFile(join(parent, 'synthetic-worker.js'), original, { mode: 0o600 });
  await writeFile(baselineSnapshot, encode({
    worker: 'pgc-preflight', productionMutations: 0, providerRequests: 0, versionId: version,
    deployment: { id: 'synthetic-deployment', versions: [{ version_id: version, percentage: 100 }] },
    originalModule: { path: 'synthetic-worker.js', sha256: sha(original), bytes: Buffer.byteLength(original) },
  }), { mode: 0o600 });
  packaged = await prepareComparisonPackage({ registry, comparisonIndex, baselineSnapshot, out: join(parent, 'output') });
}, 30_000);
afterAll(async () => { if (parent) await rm(parent, { recursive: true, force: true }); });

test('binds the emitted modules and source receipts while keeping the package private and unactivated', async () => {
  const { output, receipt } = packaged;
  expect(JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))).toEqual(receipt);
  expect(receipt).toMatchObject({
    kind: 'unactivated-formal-comparison-package', baseVersion: version,
    authorization: null, activationAllowed: false, deployed: false, qualityAcceptance: false,
    productionMutations: 0, providerCalls: 0, resourcesCreated: 0,
    compatibilityDate: '2026-10-23', privateWorkerFlags: ['nodejs_compat', 'enable_request_signal'],
  });
  expect(receipt.workers.map(worker => worker.name)).toEqual(['A', 'B', 'relay', 'authority', 'candidate-handler']);
  expect(receipt.pinnedRuntime.implementationCommit).toBe(receipt.B);
  expect(Object.keys(receipt.pinnedRuntime.files).length).toBeGreaterThan(300);
  expect(receipt.candidateModules.map(module => module.name)).toEqual(['worker.js', 'candidate-handler.js', 'candidate-entry.js']);
  expect((await stat(output)).mode & 0o777).toBe(0o700);
  for (const item of [
    ...receipt.workers.flatMap(worker => [
      { path: worker.path, sha256: worker.sha256, bytes: worker.bytes }, { path: worker.sourcePath, sha256: worker.sourceSha256 },
    ]),
    ...receipt.candidateModules.map(module => ({ ...module, path: module.name })),
  ]) {
    const path = join(output, item.path), contents = await readFile(path);
    expect(sha(contents)).toBe(item.sha256);
    if ('bytes' in item) expect(contents.byteLength).toBe(item.bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
  expect(await readFile(join(output, 'worker.js'), 'utf8')).toBe(original);
});

test('boots the actual emitted Worker packages, denies default access, and preserves the original named exports and trigger handlers', async () => {
  const { output, receipt } = packaged;
  const artifact = (path: string) => readFile(join(output, path), 'utf8');
  const artifacts = Object.fromEntries(await Promise.all(receipt.workers.map(async worker => [worker.name, esm(await artifact(worker.path))])));
  const candidateModules = Object.fromEntries(await Promise.all(receipt.candidateModules.map(async module => [module.name, esm(await artifact(module.name))])));
  const flags = { compatibilityDate: receipt.compatibilityDate, compatibilityFlags: receipt.privateWorkerFlags };
  const noOutbound = vi.fn(() => new MockResponse(null, { status: 418 }));
  const dev = { outboundService: { type: 'fetcher' as const, handler: noOutbound } };
  const single = (name: string, main: Module) => ({ name, ...flags, manifest: { mainModule: 'index.js', modules: { 'index.js': main } } });
  const durable = (exportName: string) => ({ [exportName]: { type: 'durable-object' as const, storage: 'sqlite' as const } });
  const caller = esm(`export default {async fetch(_request, env) {
    const internal = name => 'https://synthetic-package.invalid/' + name;
    const task = env.A_TASKS.get(env.A_TASKS.idFromName('synthetic'));
    const harness = env.B_TASKS.get(env.B_TASKS.idFromName('synthetic'));
    const original = env.ORIGINAL_DO.get(env.ORIGINAL_DO.idFromName('synthetic'));
    return Response.json({
      aControl: (await env.A_CONTROL.fetch(internal('a'))).status,
      bControl: (await env.B_CONTROL.fetch(internal('b'))).status,
      aTask: (await task.fetch(internal('a-task'))).status,
      bTask: (await harness.fetch(internal('b-task'))).status,
      relay: (await env.RELAY.fetch(internal('relay'))).status,
      aAuthority: await env.A_AUTHORITY.readTaskRuntime('invalid'),
      bAuthority: await env.B_AUTHORITY.readTaskRuntime('invalid'),
      bArtifact: await env.A_AUTHORITY.verifyCompletedBArtifact({}),
      originalNamed: await env.ORIGINAL_NAMED.marker(),
      originalDurable: await (await original.fetch(internal('original'))).text(),
    });
  }};`);
  const triggerProbe = esm(`import candidate from './candidate-entry.js';
import original from './worker.js';
export default {async fetch(request, env, ctx) {
  return Response.json({
    fetchReplaced: candidate.fetch !== original.fetch,
    scheduledPreserved: candidate.scheduled === original.scheduled,
    queuePreserved: candidate.queue === original.queue,
    scheduled: await candidate.scheduled({cron:'* * * * *'}, env, ctx),
    queue: await candidate.queue({queue:'synthetic'}, env, ctx),
  });
}};`);
  const candidate = { name: 'pack-candidate', ...flags, exports: durable('OriginalDurable'),
    manifest: { mainModule: 'candidate-entry.js', modules: candidateModules } };
  const config = [
    { config: { ...single('caller', caller), env: {
      A_CONTROL: { type: 'worker' as const, worker: 'pack-a', exportName: 'ComparisonTaskControl' },
      B_CONTROL: { type: 'worker' as const, worker: 'pack-b', exportName: 'ComparisonTaskControl' },
      A_TASKS: { type: 'durable-object' as const, worker: 'pack-a', exportName: 'ComparisonTaskRunner' },
      B_TASKS: { type: 'durable-object' as const, worker: 'pack-b', exportName: 'ComparisonTaskRunner' },
      RELAY: { type: 'worker' as const, worker: 'pack-relay', exportName: 'ComparisonCandidateRelay' },
      A_AUTHORITY: { type: 'worker' as const, worker: 'pack-authority', exportName: 'ComparisonBaselineAuthority' },
      B_AUTHORITY: { type: 'worker' as const, worker: 'pack-authority', exportName: 'ComparisonAuthority' },
      ORIGINAL_NAMED: { type: 'worker' as const, worker: 'pack-candidate', exportName: 'OriginalPrivate' },
      ORIGINAL_DO: { type: 'durable-object' as const, worker: 'pack-candidate', exportName: 'OriginalDurable' },
    } }, dev },
    { config: { ...single('pack-a', artifacts.A), exports: durable('ComparisonTaskRunner') }, dev },
    { config: { ...single('pack-b', artifacts.B), exports: { ...durable('ComparisonTaskRunner'), ...durable('HarnessRunner') } }, dev },
    { config: single('pack-relay', artifacts.relay), dev },
    { config: single('pack-authority', artifacts.authority), dev },
    { config: candidate, dev },
    { config: { name: 'trigger-probe', ...flags, manifest: { mainModule: 'probe.js',
      modules: { ...candidateModules, 'probe.js': triggerProbe } } }, dev },
  ];
  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, workers: config });
  try {
    type LocalFetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };
    const local = async (name: string) => await runtime.getWorker(name) as unknown as LocalFetcher;
    for (const name of ['pack-a', 'pack-b', 'pack-relay', 'pack-authority', 'pack-candidate']) {
      const result = await (await local(name)).fetch('https://pgc.ovoxin.top/login');
      expect(result.status, name).toBe(403);
      expect(await result.text(), name).toBe('');
    }
    const unsigned = await (await local('pack-candidate')).fetch('https://pgc.ovoxin.top/api/__harness-comparison/profile', { method: 'POST' });
    expect(unsigned.status).toBe(503);
    expect(await unsigned.text()).toBe('');
    const named = await runtime.dispatchFetch('http://local.test');
    expect(await named.json()).toEqual({
      aControl: 403, bControl: 403, aTask: 403, bTask: 403, relay: 403,
      aAuthority: null, bAuthority: null, bArtifact: false,
      originalNamed: 'original named export', originalDurable: 'original durable export',
    });
    const triggers = await (await local('trigger-probe')).fetch('http://local.test');
    expect(await triggers.json()).toEqual({
      fetchReplaced: true, scheduledPreserved: true, queuePreserved: true,
      scheduled: 'original scheduled * * * * *', queue: 'original queue synthetic',
    });
    expect(noOutbound).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
}, 30_000);
