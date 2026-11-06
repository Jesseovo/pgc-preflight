/**
 * Offline release preparation for a fully adjudicated embedded comparison.
 * --evidence binds the frozen comparison, raw core bundle, two real provider
 * receipts, the matching Worker isolation receipt and pinned source parity.
 * Evidence references point to SHA-256-checked files in the registry's inputs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { inferenceOptions } from '../src/model-options';
import { CCB_ENGINE_COMMIT, canonicalHarness, EMBEDDED_CCB_VERSION } from '../server/harness-policy';
import { report, type EmbeddedComparisonIdentity } from './harness-evaluation';

const root = fileURLToPath(new URL('../', import.meta.url));
const hashPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const identityKeys = ['engine', 'coreVersion', 'coreBundleSha256'];
const pinKeys = ['schemaVersion', ...identityKeys, 'engineCommit', 'implementationCommit', 'manifestSha256'];
const workflows = ['creation', 'review'] as const;
const isolationChecks = ['existingWorkerAndRunner', 'noContainers', 'noExecutionServices', 'taskOwnership', 'browserIsolation',
  'exactBrowserClosure', 'noProviderKeyExport', 'terminalCleanup'] as const;
const parityChecks = ['pinnedUpstream', 'toolContinuation', 'contextCompaction', 'boundedAccounting'] as const;

type Data = Record<string, unknown>;
type Ref = { path: string; sha256: string };
type Workflow = typeof workflows[number];
type Release = EmbeddedComparisonIdentity & {
  engineCommit: string; rightsConfirmed: boolean; providerCompatibilityVerified: boolean; comparisonAccepted: boolean;
  isolationVerified: boolean; coreParityVerified: boolean; evidenceHash: string;
  compatibleModelContracts: string[]; contextWindows: Record<string, number>;
};
type BaseConfig = {
  $schema: string; name: string; main: string; assets: { directory: string };
  compatibility_flags: string[];
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { tag: string; new_sqlite_classes?: string[] }[];
  browser: { binding: string }; d1_databases: { migrations_dir: string }[];
  vars: Record<string, unknown>; [key: string]: unknown;
};

class ReleaseError extends Error {}
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ReleaseError(message);
}
function object(value: unknown, keys: readonly string[], label: string): Data {
  need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key)), `Invalid ${label}`);
  return value as Data;
}
function digest(value: unknown): value is string { return typeof value === 'string' && hashPattern.test(value); }
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function inside(parent: string, candidate: string) {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}
async function privateFile(path: string) {
  const state = await lstat(path);
  need(await realpath(path) === path && state.isFile() && (state.mode & 0o077) === 0 && state.size <= 32 * 1024 * 1024,
    'Release evidence must be a private regular file');
  return readFile(path);
}
function parse(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ReleaseError('Invalid release evidence JSON'); }
}
async function checkedFile(evaluation: string, value: unknown) {
  const ref = object(value, ['path', 'sha256'], 'evidence reference');
  need(typeof ref.path === 'string' && ref.path.startsWith('inputs/') && !ref.path.split('/').includes('..') &&
    digest(ref.sha256), 'Evidence reference must name a hashed private input');
  const path = resolve(evaluation, ref.path);
  need(inside(join(evaluation, 'inputs'), path), 'Evidence reference escapes the private inputs');
  const bytes = await privateFile(path);
  need(sha(bytes) === ref.sha256, 'Release evidence bytes differ from the recorded SHA-256');
  return { path: ref.path, sha256: ref.sha256, bytes };
}
async function supportingEvidence(evaluation: string, value: unknown) {
  need(Array.isArray(value) && value.length > 0 && value.length <= 24, 'Verification requires supporting evidence references');
  const files = await Promise.all(value.map(ref => checkedFile(evaluation, ref)));
  need(new Set(files.map(file => file.sha256)).size === files.length, 'Duplicate supporting evidence');
}

function profileContract(profile: Data, workflow: Workflow) {
  const { baseUrl, model, protocol, vision, effort, maxOutputTokens } = profile;
  need(profile.enabled === true && typeof model === 'string' && model.length > 0 && typeof baseUrl === 'string' &&
    typeof vision === 'boolean' && (protocol === 'anthropic' || protocol === 'openai') &&
    typeof effort === 'string' && ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) &&
    typeof maxOutputTokens === 'number' && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 0,
  'Invalid frozen public model profile');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ReleaseError('Invalid frozen model endpoint'); }
  need(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname),
    'Frozen model endpoint must be public HTTPS without embedded credentials');
  need(workflow !== 'creation' || (model === 'claude-opus-5-5' && protocol === 'anthropic' && vision),
    'Embedded creation requires the locked visual Opus profile');
  const requested = workflow === 'creation' ? 64_000 : /deepseek/i.test(model) ? 24_000 : 16_000;
  const cap = inferenceOptions({ baseUrl, model, protocol, maxOutputTokens }, workflow === 'creation' ? 'game' : 'review', requested).maxTokens;
  return { protocol, cap, hash: sha(canonicalHarness({ baseUrl, model, protocol, vision,
    effort: workflow === 'creation' ? 'high' : effort, maxOutputTokens })) };
}

function pinMatches(record: Data, pin: Data) {
  return pinKeys.every(key => record[key] === pin[key]);
}
function observedAfterFreeze(value: unknown, frozenAt: string) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    Date.parse(value) >= Date.parse(frozenAt) && Date.parse(value) <= Date.now();
}

async function validateEmbeddedHarnessRelease(options: {
  evaluation: string; evidence: string; implementationCommit: string;
}): Promise<Release> {
  const evaluation = resolve(options.evaluation);
  const state = await lstat(evaluation);
  need(await realpath(evaluation) === evaluation && state.isDirectory() && (state.mode & 0o077) === 0 &&
    commitPattern.test(options.implementationCommit), 'Invalid evaluated embedded commit or private registry');
  const result = await report(evaluation);
  const identity = result.registration.embeddedComparison;
  need(identity && result.registration.materialIndexSha256, 'Release requires an archived embedded comparison registry');
  need(result.quality === 'passed' && result.releaseReady && result.prerequisites.rightsConfirmed &&
    result.prerequisites.providerCompatibilityVerified, 'The complete embedded comparison and its prerequisites must pass');

  const manifestBytes = await privateFile(join(evaluation, 'manifest.json'));
  need(sha(manifestBytes) === result.manifestSha256, 'Registry changed after embedded evaluation');
  const manifest = parse(manifestBytes) as { settings: { harnessCommit: string; creationModel: { name: string; config: Ref };
    reviewModel: { name: string; config: Ref } }; frozenAt: string };
  need(manifest.settings.harnessCommit === options.implementationCommit, 'Release must use the exact evaluated implementation commit');
  const pin: Data = { schemaVersion: 1, ...identity, engineCommit: CCB_ENGINE_COMMIT,
    implementationCommit: options.implementationCommit, manifestSha256: result.manifestSha256 };
  const evidenceBytes = await privateFile(resolve(options.evidence));
  const evidence = object(parse(evidenceBytes), [...pinKeys, 'coreBundle', 'providerReceipts', 'isolationReceipt', 'parityReceipt'], 'embedded release evidence');
  need(pinMatches(evidence, pin), 'Release evidence differs from the frozen embedded identity');
  const bundle = await checkedFile(evaluation, evidence.coreBundle);
  need(bundle.sha256 === identity.coreBundleSha256 && bundle.bytes.length > 0, 'Core bundle does not match the evaluated bytes');

  const provider = result.prerequisiteEvidence.provider as { evidence: Ref[] };
  const acceptedProvider = new Map(provider.evidence.map(ref => [ref.path, ref.sha256]));
  need(Array.isArray(evidence.providerReceipts) && evidence.providerReceipts.length === workflows.length,
    'Verify both locked model workflows with real provider receipts');
  const contextWindows: Record<string, number> = {};
  const seen = new Set<Workflow>();
  const requestIds = new Set<string>();
  let workerVersion: string | undefined;
  for (const value of evidence.providerReceipts) {
    const receipt = await checkedFile(evaluation, value);
    need(acceptedProvider.get(receipt.path) === receipt.sha256, 'Provider receipt was not accepted as a comparison prerequisite');
    const row = object(parse(receipt.bytes), [...pinKeys, 'kind', 'workflow', 'verifiedAt', 'workerVersion', 'modelConfigSha256',
      'modelContractSha256', 'contextWindowTokens', 'nativeRequests', 'evidence'], 'embedded provider receipt');
    need(pinMatches(row, pin) && row.kind === 'embedded-real-provider' && observedAfterFreeze(row.verifiedAt, manifest.frozenAt) &&
      typeof row.workerVersion === 'string' && uuidPattern.test(row.workerVersion) &&
      (workerVersion === undefined || workerVersion === row.workerVersion), 'Provider receipt did not run on the verified embedded Worker');
    workerVersion = row.workerVersion;
    need(row.workflow === 'creation' || row.workflow === 'review', 'Unknown model verification workflow');
    need(!seen.has(row.workflow), 'Duplicate model verification workflow');
    seen.add(row.workflow);
    const locked = row.workflow === 'creation' ? manifest.settings.creationModel : manifest.settings.reviewModel;
    const config = await checkedFile(evaluation, locked.config);
    const profile = object(parse(config.bytes), ['name', 'baseUrl', 'model', 'protocol', 'enabled', 'vision', 'effort', 'maxOutputTokens', 'updatedAt'],
      'frozen public model profile');
    const contract = profileContract(profile, row.workflow);
    const window = row.contextWindowTokens;
    need(profile.model === locked.name && row.modelConfigSha256 === config.sha256 && row.modelContractSha256 === contract.hash &&
      typeof window === 'number' && Number.isSafeInteger(window) && window > contract.cap && window >= 8192 && window <= 2_000_000 &&
      (contextWindows[contract.hash] === undefined || contextWindows[contract.hash] === window),
    'Provider verification does not match the frozen public model contract and context window');
    need(Array.isArray(row.nativeRequests) && row.nativeRequests.length > 0 && row.nativeRequests.length <= 24,
      'Provider verification requires actual native request receipts');
    for (const request of row.nativeRequests) {
      const native = object(request, ['requestSha256', 'httpStatus', 'attempts', 'terminal', 'outputTokens'], 'native request receipt');
      need(digest(native.requestSha256) && !requestIds.has(native.requestSha256) && native.httpStatus === 200 && native.attempts === 1 &&
        native.terminal === (contract.protocol === 'anthropic' ? 'message_stop' : 'done') &&
        typeof native.outputTokens === 'number' && Number.isSafeInteger(native.outputTokens) &&
        native.outputTokens > 0 && native.outputTokens <= contract.cap, 'Native provider stream was incomplete, repeated or over budget');
      requestIds.add(native.requestSha256);
    }
    await supportingEvidence(evaluation, row.evidence);
    contextWindows[contract.hash] = window;
  }

  const isolationFile = await checkedFile(evaluation, evidence.isolationReceipt);
  const isolation = object(parse(isolationFile.bytes), [...pinKeys, 'kind', 'verifiedAt', 'workerVersion', 'providerRequests', 'checks', 'evidence'],
    'embedded isolation receipt');
  need(pinMatches(isolation, pin) && isolation.kind === 'embedded-runtime-isolation' && isolation.workerVersion === workerVersion &&
    isolation.providerRequests === 0 && observedAfterFreeze(isolation.verifiedAt, manifest.frozenAt),
  'Isolation receipt did not verify the same embedded Worker');
  const isolationVerified = Object.values(object(isolation.checks, isolationChecks, 'isolation checks')).every(value => value === true);
  need(isolationVerified, 'All embedded isolation checks must pass');
  await supportingEvidence(evaluation, isolation.evidence);

  const parityFile = await checkedFile(evaluation, evidence.parityReceipt);
  const parity = object(parse(parityFile.bytes), [...pinKeys, 'kind', 'verifiedAt', 'checks', 'evidence'], 'embedded core parity receipt');
  need(pinMatches(parity, pin) && parity.kind === 'embedded-core-parity' && observedAfterFreeze(parity.verifiedAt, manifest.frozenAt),
    'Parity receipt does not bind the exact frozen embedded core');
  const coreParityVerified = Object.values(object(parity.checks, parityChecks, 'parity checks')).every(value => value === true);
  need(coreParityVerified, 'All embedded core parity checks must pass');
  await supportingEvidence(evaluation, parity.evidence);

  return { ...identity, engineCommit: CCB_ENGINE_COMMIT,
    rightsConfirmed: result.prerequisites.rightsConfirmed, providerCompatibilityVerified: result.prerequisites.providerCompatibilityVerified,
    comparisonAccepted: result.quality === 'passed' && result.releaseReady, isolationVerified, coreParityVerified,
    evidenceHash: sha(JSON.stringify({ evidenceSha256: sha(evidenceBytes), reportSha256: sha(JSON.stringify(result)) })),
    compatibleModelContracts: Object.keys(contextWindows).sort(), contextWindows };
}

function buildEmbeddedHarnessConfig(base: BaseConfig, repository: string, outputDir: string, release: Release) {
  need(base.main === 'server/worker.ts' && ['containers', 'services', 'env', 'exports'].every(key => !Object.hasOwn(base, key)) &&
    base.browser?.binding === 'BROWSER' && ['CONTROL_PLANE', 'FORGE_RUNNER', 'REVIEW_RUNNER'].every(name =>
      base.durable_objects?.bindings.some(binding => binding.name === name)) &&
    !base.durable_objects.bindings.some(binding => binding.name === 'HARNESS_RUNNER' || binding.class_name === 'HarnessRunner'),
  'Embedded release requires the existing Worker, Runner and Browser configuration');
  need(release.engine === 'ccb-embedded' && release.coreVersion === EMBEDDED_CCB_VERSION && digest(release.coreBundleSha256) &&
    release.rightsConfirmed && release.providerCompatibilityVerified && release.comparisonAccepted && release.isolationVerified &&
    release.coreParityVerified && digest(release.evidenceHash), 'Embedded release gates are incomplete');
  const rebase = (path: string) => relative(outputDir, resolve(repository, path));
  return { ...base, $schema: rebase(base.$schema), main: rebase(base.main),
    assets: { ...base.assets, directory: rebase(base.assets.directory) },
    d1_databases: base.d1_databases.map(database => ({ ...database, migrations_dir: rebase(database.migrations_dir) })),
    vars: { ...base.vars, HARNESS_ROLLOUT: 'off', HARNESS_RELEASE: JSON.stringify(release) } };
}

export async function prepareEmbeddedHarnessConfig(options: {
  evaluation: string; evidence: string; implementationCommit: string; base: BaseConfig; repository: string; outputDir: string;
}) {
  const release = await validateEmbeddedHarnessRelease(options);
  return { release, config: buildEmbeddedHarnessConfig(options.base, options.repository, options.outputDir, release) };
}

function cleanCommit() {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  need(commitPattern.test(commit) && !git(['status', '--porcelain', '--untracked-files=all']),
    'Prepare embedded release from the clean evaluated commit');
  return commit;
}

async function main() {
  const { values } = parseArgs({ options: { evaluation: { type: 'string' }, evidence: { type: 'string' }, out: { type: 'string' } } });
  need(values.evaluation && values.evidence && values.out, 'Provide --evaluation, --evidence and --out');
  const artifacts = join(root, 'artifacts');
  const evaluation = resolve(root, values.evaluation), evidence = resolve(root, values.evidence), output = resolve(root, values.out);
  need(await realpath(artifacts) === artifacts && dirname(evaluation) === artifacts && dirname(output) === artifacts &&
    evaluation !== output && inside(artifacts, evidence), 'Use distinct private directories under artifacts/');
  const commit = cleanCommit();
  const base = parse(await readFile(join(root, 'wrangler.jsonc'))) as BaseConfig;
  const { config, release } = await prepareEmbeddedHarnessConfig({ evaluation, evidence, implementationCommit: commit,
    base, repository: root, outputDir: output });
  need(cleanCommit() === commit, 'Repository changed during embedded release preparation');
  await mkdir(output, { mode: 0o700 });
  const path = join(output, 'wrangler.embedded-harness.jsonc');
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ path, rollout: 'off', evidenceHash: release.evidenceHash, modelCalls: 0 }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write((error instanceof ReleaseError ? error.message : 'Embedded release evidence could not be verified') + '\n');
    process.exitCode = 1;
  });
}
