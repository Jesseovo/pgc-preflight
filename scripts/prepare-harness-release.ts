/** Produce a private rollout-off configuration after recorded release gates pass. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { report } from './harness-evaluation';
import { HARNESS_CCB_COMMIT as CCB_ENGINE_COMMIT, isHarnessImage } from '../server/harness-protocol';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const className = 'HarnessRunner';
const binding = 'HARNESS_RUNNER';
const migration = 'v4-ccb-harness';
const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

type BaseConfig = {
  $schema: string; name: string; account_id: string; main: string;
  compatibility_flags: string[];
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { tag: string; new_sqlite_classes?: string[] }[];
  assets: { directory: string };
  d1_databases: { migrations_dir: string; migrations_pattern?: string }[];
  vars: Record<string, unknown>;
  containers?: unknown[];
  exports?: unknown;
  env?: unknown;
  [key: string]: unknown;
};
type Release = {
  engineCommit: string; image: string; rightsConfirmed: true; providerCompatibilityVerified: true;
  comparisonAccepted: true; isolationVerified: true; evidenceHash: string; compatibleModelContracts: string[];
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function isInside(parent: string, path: string) {
  const part = relative(parent, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function configuredPath(directory: string, original: string) {
  requireCondition(typeof original === 'string' && original.length > 0, 'Base Wrangler path is missing');
  return relative(directory, resolve(root, original));
}
function digest(value: unknown): value is string { return typeof value === 'string' && digestPattern.test(value); }
export function buildHarnessConfig(base: BaseConfig, outputDir: string, release: Release) {
  requireCondition(base.main === 'server/worker.ts' && !base.containers && !base.exports && !base.env,
    'Base Wrangler shape changed; review the generated configuration before proceeding');
  requireCondition(typeof base.account_id === 'string' && isHarnessImage(release.image, base.account_id), 'Use a digest-pinned image from this account’s Cloudflare managed registry');
  requireCondition(!base.durable_objects.bindings.some(row => row.name === binding || row.class_name === className) &&
    !base.migrations.some(row => row.tag === migration || row.new_sqlite_classes?.includes(className)), 'Harness binding or migration already exists in base configuration');
  return {
    ...base,
    $schema: configuredPath(outputDir, base.$schema),
    main: configuredPath(outputDir, 'server/harness-worker.ts'),
    compatibility_flags: [...new Set([...base.compatibility_flags, 'enable_ctx_exports'])],
    durable_objects: { ...base.durable_objects, bindings: [...base.durable_objects.bindings, { name: binding, class_name: className }] },
    migrations: [...base.migrations, { tag: migration, new_sqlite_classes: [className] }],
    assets: { ...base.assets, directory: configuredPath(outputDir, base.assets.directory) },
    d1_databases: base.d1_databases.map(database => ({
      ...database,
      migrations_dir: configuredPath(outputDir, database.migrations_dir),
      ...(database.migrations_pattern ? { migrations_pattern: configuredPath(outputDir, database.migrations_pattern) } : {}),
    })),
    vars: { ...base.vars, HARNESS_ROLLOUT: 'off', HARNESS_RELEASE: JSON.stringify(release) },
    containers: [{
      class_name: className, scheduling_policy: 'durable_object',
      images: { ccb: { image: release.image } }, observability: { logs: { enabled: false } },
    }],
  };
}

function object(value: unknown, keys: readonly string[], label: string) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  const data = value as Record<string, unknown>;
  requireCondition(Object.keys(data).length === keys.length && keys.every(key => Object.hasOwn(data, key)), `Unexpected fields in ${label}`);
  return data;
}
async function privateFile(artifacts: string, path: string) {
  requireCondition(isInside(artifacts, path) && await realpath(path) === path && (await lstat(path)).isFile(),
    'Release evidence must be a regular private file under artifacts/');
  return readFile(path);
}
function currentCommit() {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  requireCondition(commitPattern.test(commit) && !git(['status', '--porcelain', '--untracked-files=all']),
    'Prepare release from the clean evaluated PGC commit');
  return commit;
}

async function main() {
  const { values } = parseArgs({
    options: { evaluation: { type: 'string' }, evidence: { type: 'string' }, out: { type: 'string' } },
  });
  requireCondition(values.evaluation && values.evidence && values.out, 'Provide --evaluation, --evidence and --out; see docs/ccb-harness-deployment.md');
  const artifacts = join(root, 'artifacts');
  requireCondition(await realpath(artifacts) === artifacts, 'Use a private, non-symlink artifacts directory');
  const evaluation = resolve(root, values.evaluation);
  const output = resolve(root, values.out);
  requireCondition(dirname(evaluation) === artifacts && await realpath(evaluation) === evaluation && dirname(output) === artifacts && output !== evaluation,
    'Use separate private evaluation and output directories directly under artifacts/');
  const evidenceBytes = await privateFile(artifacts, resolve(root, values.evidence));
  const evidence = object(JSON.parse(evidenceBytes.toString('utf8')), [
    'engineCommit', 'implementationCommit', 'manifestSha256', 'image', 'compatibleModels', 'isolationChecks', 'isolationEvidence',
  ], 'release evidence');
  const isolation = object(evidence.isolationChecks, [
    'linuxImage', 'nonRoot', 'nativeGateway', 'directEgressDenied', 'secretsIsolated', 'crossTaskDenied', 'terminalCleanup',
  ], 'isolation checks');
  requireCondition(evidence.engineCommit === CCB_ENGINE_COMMIT && Object.values(isolation).every(value => value === true),
    'Actual isolation verification and pinned CCB evidence are required');
  const commit = currentCommit();
  requireCondition(evidence.implementationCommit === commit, 'Release evidence must match the current evaluated PGC commit');

  const results = await report(evaluation);
  const manifest = JSON.parse((await privateFile(artifacts, join(evaluation, 'manifest.json'))).toString('utf8'));
  requireCondition(manifest.settings?.harnessCommit === commit && manifest.creation?.B?.engineCommit === CCB_ENGINE_COMMIT &&
    manifest.review?.B?.engineCommit === CCB_ENGINE_COMMIT && manifest.settings?.harnessImage === evidence.image &&
    manifest.creation?.B?.image === evidence.image && manifest.review?.B?.image === evidence.image &&
    results.manifestSha256 === evidence.manifestSha256, 'The comparison must evaluate the exact PGC revision, CCB revision and container image');
  requireCondition(results.quality === 'passed' && results.releaseReady && results.prerequisites.rightsConfirmed && results.prerequisites.providerCompatibilityVerified,
    'Independent comparison, production rights and provider compatibility must all pass');
  async function checkedFile(value: unknown) {
    const file = object(value, ['path', 'sha256'], 'release evidence file');
    requireCondition(typeof file.path === 'string' && !isAbsolute(file.path) && digest(file.sha256), 'Invalid release evidence file');
    const bytes = await privateFile(artifacts, resolve(artifacts, file.path));
    requireCondition(sha(bytes) === file.sha256, 'Release evidence file SHA-256 does not match');
    return { bytes, sha256: file.sha256 };
  }
  const provider = results.prerequisiteEvidence.provider as { evidence: { sha256: string }[] };
  const acceptedProviderEvidence = new Set(provider.evidence.map(file => file.sha256));
  requireCondition(Array.isArray(evidence.compatibleModels) && evidence.compatibleModels.length > 0 && evidence.compatibleModels.length <= 24,
    'Provide the actually verified model contracts');
  const contracts: string[] = [];
  for (const item of evidence.compatibleModels) {
    const model = object(item, ['contractSha256', 'evidence'], 'compatible model');
    const receipt = await checkedFile(model.evidence);
    const data = object(JSON.parse(receipt.bytes.toString('utf8')), [
      'contractSha256', 'engineCommit', 'implementationCommit', 'image', 'providerVerification', 'streamingVerified',
    ], 'model compatibility receipt');
    requireCondition(digest(model.contractSha256) && data.contractSha256 === model.contractSha256 &&
      data.engineCommit === CCB_ENGINE_COMMIT && data.implementationCommit === commit && data.image === evidence.image &&
      data.streamingVerified === true && acceptedProviderEvidence.has(receipt.sha256),
      'Compatible model must be backed by the accepted exact-image provider receipt');
    await checkedFile(data.providerVerification);
    contracts.push(model.contractSha256);
  }
  requireCondition(new Set(contracts).size === contracts.length, 'Duplicate compatible model contracts');
  requireCondition(Array.isArray(evidence.isolationEvidence) && evidence.isolationEvidence.length > 0 && evidence.isolationEvidence.length <= 24,
    'Provide the isolation evidence files');
  for (const item of evidence.isolationEvidence) await checkedFile(item);

  const base = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8')) as BaseConfig;
  requireCondition(typeof base.account_id === 'string' && isHarnessImage(evidence.image, base.account_id), 'Use a digest-pinned image from this account’s Cloudflare managed registry');
  await access(join(root, 'server/harness-worker.ts'));
  const release: Release = {
    engineCommit: CCB_ENGINE_COMMIT, image: evidence.image, rightsConfirmed: true, providerCompatibilityVerified: true,
    comparisonAccepted: true, isolationVerified: true,
    evidenceHash: sha(JSON.stringify({ evidenceSha256: sha(evidenceBytes), evaluationSha256: sha(JSON.stringify(results)) })),
    compatibleModelContracts: contracts,
  };
  const config = buildHarnessConfig(base, output, release);
  await mkdir(output, { mode: 0o700 });
  const path = join(output, 'wrangler.harness.jsonc');
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ path, rollout: 'off', evidenceHash: release.evidenceHash }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const message = error instanceof SyntaxError ? 'Private release or evaluation JSON is malformed' :
      error instanceof Error ? error.message : 'Harness release preparation failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
