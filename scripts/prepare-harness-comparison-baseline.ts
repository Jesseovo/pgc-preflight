/** Prepare a local, unpublished A transport adapter without altering the baseline archive. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { baselineWorkerTemplate } from './harness-comparison-baseline-worker-template';

const root = fileURLToPath(new URL('../', import.meta.url));
const commit = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const tree = '491936d02f57b9125be86e36e73e76048009d82f';
const modelPath = 'server/model.ts';
const completionPath = 'server/forge-llm.ts';
const entryPath = 'server/comparison-baseline-entry.ts';
const workerPath = 'server/comparison-baseline-worker.ts';
const sharedLayer = ['harness-comparison-runner.ts', 'harness-comparison-evidence.ts', 'harness-comparison-service.ts',
  'harness-policy.ts', 'harness-protocol.ts', 'harness-comparison-archive.ts'].map(file => 'server/' + file);
const baselineFileHashes = {
  [modelPath]: '959accf6574e5635e9b8dee08de20713676e05867775a3fef8db0a93f7b18993',
  [completionPath]: 'cf3f977e31858bc8bf088a78b75d91fe4fc4f951e1acfce46172da111e3d64d7',
};
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const subprocessEnv = { PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1' };

function uniqueReplace(source: string, before: string, after: string) {
  assert.equal(source.split(before).length, 2, 'Baseline patch anchor is missing or ambiguous');
  return source.replace(before, () => after);
}

function modelAdapter(source: string) {
  const declarations = 'export type ModelTransport = (messages: ChatMessage[]) => Promise<string>;';
  const options = 'purpose?: string; stream?: boolean } = {}): ModelTransport {\n  const throttle';
  const outbound = 'const response = await abortable(fetch(anthropic ?';
  source = uniqueReplace(source, declarations, declarations + '\n' + [
    'export const COMPARISON_PROVIDER_SENTINEL = "pgc-comparison-local-placeholder";',
    'export type ComparisonModelFetch = (url: string, init: RequestInit) => Promise<Response>;',
  ].join('\n'));
  source = uniqueReplace(source, options, [
    'purpose?: string; stream?: boolean; comparisonFetch?: ComparisonModelFetch } = {}): ModelTransport {',
    '  const comparisonFetch = options.comparisonFetch;',
    '  if (!comparisonFetch || config.apiKey !== COMPARISON_PROVIDER_SENTINEL) throw new Error("A comparison transport or placeholder is missing");',
    '  const throttle',
  ].join('\n'));
  return uniqueReplace(source, outbound, 'const response = await abortable(comparisonFetch(anthropic ?');
}

function completionAdapter(source: string) {
  source = uniqueReplace(source, "import { modelTransport, ModelOutputError } from './model';",
    "import { modelTransport, ModelOutputError, type ComparisonModelFetch } from './model';");
  source = uniqueReplace(source, 'SETTINGS_KEY: string; DB?: ModelThrottleDatabase; generation?:',
    'SETTINGS_KEY: string; DB?: ModelThrottleDatabase; comparisonFetch?: ComparisonModelFetch; generation?:');
  return uniqueReplace(source, '        DB: env.DB, maxTokens,', '        DB: env.DB, maxTokens, comparisonFetch: env.comparisonFetch,');
}

const entry = String.raw`/** A comparison-only entrypoint. No public route, provider credential or network fallback. */
import { enqueueForgeTask } from './forge-tasks';
import { creationPipelineAlarm } from './forge-creation-pipeline';
import { enqueueReview } from './review-jobs';
import { cloudReviewAlarm } from './cloud-review-runner';
import { decryptKey, encryptKey, type StoredModelProfile } from './settings';
import { COMPARISON_PROVIDER_SENTINEL, type ComparisonModelFetch } from './model';

export { enqueueForgeTask, creationPipelineAlarm, enqueueReview, cloudReviewAlarm };

type Scope = { taskId: string; ownerId: string; operation: 'creation' | 'review' };
type Stage = 'build' | 'polish' | 'repair' | 'review' | 'review_verify';
type PublicProfile = Pick<StoredModelProfile, 'name' | 'baseUrl' | 'model' | 'protocol' | 'enabled' | 'updatedAt' | 'vision' | 'effort' | 'maxOutputTokens'>;
type TrustedFetch = (identity: Readonly<Scope & { arm: 'A'; stage: Stage }>, url: string, init: RequestInit) => Promise<Response>;

const placeholderSettingsKey = (taskId: string) => 'pgc-comparison-placeholder-config-v1:' + taskId;
export async function verifyBaselineCheckpointProfile(taskId: string, profile: StoredModelProfile) {
  return await decryptKey(profile.encryptedKey, placeholderSettingsKey(taskId)).catch(() => null) === COMPARISON_PROVIDER_SENTINEL;
}
export async function createBaselineTaskAdapter(scope: Scope, profile: PublicProfile, trustedFetch: TrustedFetch) {
  const { taskId, ownerId, operation } = scope;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(taskId) || !ownerId ||
      (operation !== 'creation' && operation !== 'review') || (operation === 'review' && ownerId !== 'admin') || typeof trustedFetch !== 'function') {
    throw new Error('Invalid private baseline task binding');
  }
  if (Object.keys(profile).some(key => !['name', 'baseUrl', 'model', 'protocol', 'enabled', 'updatedAt', 'vision', 'effort', 'maxOutputTokens'].includes(key))) {
    throw new Error('A comparison profile accepts only public model settings');
  }
  // Archived runner checkpoints retain the encrypted placeholder profile across alarms.
  // This derived value is stable for a task and deliberately is not a credential.
  const settingsKey = placeholderSettingsKey(taskId);
  const selected = { ...profile, encryptedKey: await encryptKey(COMPARISON_PROVIDER_SENTINEL, settingsKey) };
  const route = operation === 'creation' ? 'create' : 'review';
  const config = { ...selected, activeProfile: 'comparison', profiles: { comparison: selected }, routes: { [route]: 'comparison' } };

  const comparisonFetch: ComparisonModelFetch = (url, init) => {
    const key = new Headers(init.headers).get('Idempotency-Key') ?? '';
    const prefix = (operation === 'creation' ? 'pgc-create-' : 'pgc-review-') + taskId + (operation === 'creation' ? ':' : '-');
    if (!key.startsWith(prefix)) throw new Error('A comparison request is outside the bound task');
    const suffix = key.slice(prefix.length);
    const creation = /^(build|polish|repair)-[a-f0-9]{24}$/.exec(suffix);
    const review = /^(verify-)?[a-f0-9]{24}(?:-retry-[1-9][0-9]*)?$/.exec(suffix);
    const stage = operation === 'creation' ? creation?.[1] as Stage | undefined : review ? (review[1] ? 'review_verify' : 'review') : undefined;
    if (!stage) throw new Error('A comparison request has an invalid stage identity');
    return trustedFetch(Object.freeze({ arm: 'A', taskId, ownerId, operation, stage }), url, init);
  };
  const environment = <Env extends object>(env: Env) => ({ ...env, ownerId, SETTINGS_KEY: settingsKey,
    modelStore: { get: async () => structuredClone(config) }, comparisonFetch });
  const requireOperation = (expected: Scope['operation']) => {
    if (operation !== expected) throw new Error('A comparison task has a different operation');
  };
  return Object.freeze({
    environment,
    enqueueForgeTask(env: Parameters<typeof enqueueForgeTask>[0], job: Parameters<typeof enqueueForgeTask>[1]) {
      requireOperation('creation');
      if (job.type !== 'game') throw new Error('A comparison creation must use the game workflow');
      return enqueueForgeTask(environment(env), job, taskId);
    },
    creationPipelineAlarm(state: unknown, env: object) {
      requireOperation('creation');
      return creationPipelineAlarm(state, environment(env), taskId);
    },
    enqueueReview(env: Parameters<typeof enqueueReview>[0], payload: { title?: string; html: string }) {
      requireOperation('review');
      return enqueueReview({ ...environment(env), modelExecutor: 'platform' }, { ...payload, request_id: taskId }, ownerId);
    },
    cloudReviewAlarm(state: unknown, env: object) {
      requireOperation('review');
      return cloudReviewAlarm(state, { ...environment(env), modelExecutor: 'platform' }, taskId);
    },
  });
}
`;

function difference(before: string, after: string, path: string, added = false) {
  try {
    execFileSync('diff', ['-u', '-L', added ? '/dev/null' : 'a/' + path, '-L', 'b/' + path, before, after], { env: subprocessEnv });
  } catch (error) {
    const result = error as { status?: number; stdout?: Buffer };
    if (result.status === 1 && result.stdout?.length) return result.stdout.toString();
    throw error;
  }
  throw new Error('Baseline adapter did not change its pinned source');
}

export function prepareComparisonBaseline({ out }: { out: string }) {
  assert(out && !out.split(/[\\/]/).includes('..'), 'Use a fresh private adapter directory');
  const output = resolve(out);
  assert.equal(realpathSync(dirname(output)), dirname(output), 'Adapter parent must not use symbolic links');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, env: subprocessEnv, maxBuffer: 30 * 1024 * 1024 });
  assert.equal(git(['rev-parse', commit + '^{tree}']).toString().trim(), tree, 'Baseline tree differs from its pin');
  const archive = git(['archive', '--format=tar', commit]);
  mkdirSync(output, { mode: 0o700 });
  const archivePath = join(output, 'baseline.tar');
  writeFileSync(archivePath, archive, { flag: 'wx', mode: 0o600 });
  const source = join(output, 'source');
  mkdirSync(source, { mode: 0o700 });
  execFileSync('tar', ['-xf', archivePath, '-C', source], { env: subprocessEnv });
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'pgc-baseline-adapter-diff-'));
  try {
    const changes = ([ [modelPath, modelAdapter], [completionPath, completionAdapter] ] as const).map(([path, adapt]) => {
      const destination = join(source, path);
      const original = readFileSync(destination);
      const originalSha256 = sha(original);
      assert.equal(originalSha256, baselineFileHashes[path], 'Archived adapter input bytes differ from their pin');
      const updated = adapt(original.toString('utf8'));
      const originalPath = join(temporary, path.replace('/', '-'));
      writeFileSync(originalPath, original, { flag: 'wx', mode: 0o600 });
      writeFileSync(destination, updated);
      return { path, originalSha256, generatedSha256: sha(updated), patch: difference(originalPath, destination, path) };
    });
    const additions = [
      { path: entryPath, bytes: Buffer.from(entry) },
      { path: workerPath, bytes: Buffer.from(baselineWorkerTemplate) },
      ...sharedLayer.map(path => ({ path, bytes: readFileSync(join(root, path)) })),
    ].map(({ path, bytes }) => {
      const destination = join(source, path);
      writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
      return { path, sha256: sha(bytes), patch: difference('/dev/null', destination, path, true) };
    });
    const patch = [...changes, ...additions].map(change => change.patch).join('');
    writeFileSync(join(output, 'adapter.patch'), patch, { flag: 'wx', mode: 0o600 });
    const manifest = {
      schemaVersion: 1, scope: 'unpublished-comparison-baseline-adapter', executionAuthorized: false, deploymentPerformed: false, providerRequests: 0,
      implementationCommit: commit, tree, archiveSha256: sha(archive), adapterPatchSha256: sha(patch),
      preparerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      entry: { path: entryPath, sha256: sha(entry) },
      workerEntry: { path: workerPath, sha256: sha(baselineWorkerTemplate) },
      comparisonLayer: additions.filter(value => sharedLayer.includes(value.path)).map(({ path, sha256 }) => ({ path, sha256 })),
      changes: changes.map(({ patch: ignored, ...change }) => change),
    };
    const notes = [
      '# A comparison transport adapter',
      '',
      'baseline.tar is the unmodified pinned Git archive. The source directory is a generated private copy.',
      'adapter.patch changes only the fetch boundary, passes the task transport through completion, and adds the private runner entry.',
      'The private Worker entry exports the fixed task Durable Object and an authority-gated control service. All HTTP entrypoints deny requests.',
      'It accepts an independently pinned Worker version, isolated database and signed candidate service scope. It needs separately provisioned private bindings before execution.',
      'The broker independently validates the allowed destination, provider model and ledger identity. It replaces the non-secret placeholder with its server-held credential and returns the original streaming response.',
      'This package is preparation only. It does not establish provider compatibility, formal evaluation readiness or authorization.',
      '',
    ].join('\n');
    writeFileSync(join(output, 'README.md'), notes, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { output, source, entry: join(source, entryPath), workerEntry: join(source, workerPath), manifest };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
    assert(positionals.length === 1 && positionals[0] === 'prepare' && values.out && !values.out.split(/[\\/]/).includes('..'),
      'Use prepare --out <private directory inside artifacts/>');
    const path = resolve(root, values.out), part = relative(join(root, 'artifacts'), path);
    assert(part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part), 'Use a private output inside artifacts/');
    const result = prepareComparisonBaseline({ out: path });
    process.stdout.write(JSON.stringify({ output: result.output, ...result.manifest }) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'Baseline adapter preparation failed') + '\n');
    process.exitCode = 1;
  }
}
