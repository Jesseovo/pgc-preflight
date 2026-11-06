/** Offline comparison planning. This module has no execution or scheduling interface. */
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFrozenComparison } from './harness-evaluation';

const root = fileURLToPath(new URL('../', import.meta.url));
const formalCommit = '630303565f44c061c7ed8ad7b992dcc4e9db8929';
const formalImage = 'registry.cloudflare.com/071443b43c7562efec975a5e964d5a9c/pgc-ccb-research@sha256:0e95a0406e8dc94b0a4eea1f2cb62ff2a31ff48261d8fca87923d99ebfcec957';
const arms = ['A', 'B'] as const;
type Arm = typeof arms[number];
type Operation = 'creation' | 'review';
type Scope = 'formal' | 'rehearsal';

function checkedPath(path: string, base?: string) {
  if (!path || path.split(/[\\/]/).includes('..')) throw new Error('Comparison paths must not traverse parent directories');
  return base ? resolve(base, path) : resolve(path);
}

function taskId(scope: Scope, manifestSha256: string, caseId: string, arm: Arm, operation: Operation) {
  const input = JSON.stringify(['pgc-harness-comparison-slot-v1', scope, manifestSha256, caseId, arm, operation]);
  const bytes = createHash('sha256').update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isExists(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

async function storePlan(directory: string, bytes: Buffer) {
  const parent = dirname(directory);
  if (await realpath(parent) !== parent) throw new Error('Plan output parent must not be a symbolic link');
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (!isExists(error)) throw error; }
  const stats = await lstat(directory);
  if (!stats.isDirectory() || (stats.mode & 0o077) || await realpath(directory) !== directory) {
    throw new Error('Plan output must be a private directory without symbolic links');
  }
  const output = join(directory, 'plan.json');
  const temporary = join(directory, `.plan-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await link(temporary, output);
  } catch (error) {
    if (!isExists(error)) throw error;
    const current = await lstat(output);
    if (!current.isFile() || (current.mode & 0o077) || !(await readFile(output)).equals(bytes)) {
      throw new Error('Existing comparison plan conflicts with the frozen inputs or is not a private regular file');
    }
  } finally {
    await unlink(temporary);
  }
  return output;
}

export async function planComparison(options: { registry: string; comparisonIndex: string; out: string; scope: Scope }) {
  const { scope } = options;
  if (scope !== 'formal' && scope !== 'rehearsal') throw new Error('Choose formal or rehearsal planning scope');
  const directory = checkedPath(options.out);
  const frozen = await readFrozenComparison(checkedPath(options.registry), checkedPath(options.comparisonIndex));
  const { settings, cases, manifestSha256, materialIndexSha256 } = frozen;
  if (scope === 'formal' && (settings.harnessCommit !== formalCommit || settings.harnessImage !== formalImage)) {
    throw new Error('Formal plan requires the pinned B implementation and image');
  }
  const source = {
    A: { implementationCommit: frozen.baseline },
    B: { implementationCommit: settings.harnessCommit, engineCommit: frozen.engine, image: settings.harnessImage },
  };
  const slots = cases.flatMap(({ id: caseId, materialSha256 }) => {
    const identity = (arm: Arm, operation: Operation) => ({ caseId, arm, operation, taskId: taskId(scope, manifestSha256, caseId, arm, operation) });
    return [
      ...arms.map(arm => ({ ...identity(arm, 'creation'), materialSha256, modelConfigSha256: settings.creationModel.config.sha256 })),
      ...arms.map(arm => ({ ...identity(arm, 'review'), modelConfigSha256: settings.reviewModel.config.sha256,
        rulesSha256: settings.rules.sha256, calibrationSha256: settings.calibration.sha256,
        requires: {
          creationTaskId: taskId(scope, manifestSha256, caseId, 'B', 'creation'),
          creationRecord: `records/creation.${caseId}.B.json`,
          reviewInputRecord: `records/review-input.${caseId}.json`,
          verification: 'required-at-execution', exactCompletedBlindSafeBHtml: true, originalOrderedBasicShots: 4,
        },
      })),
    ];
  });
  const plan = {
    schemaVersion: 1, scope, executionAllowed: false, manifestSha256, materialIndexSha256, source,
    verification: { modelProvenance: 'unverified', rulesProvenance: 'unverified', providerCompatibility: 'unverified', executionAuthorization: 'unverified' },
    workflows: frozen.workflows, settings, cases, slots,
  };
  const bytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  const output = await storePlan(directory, bytes);
  return { output, plan, planSha256: createHash('sha256').update(bytes).digest('hex') };
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    registry: { type: 'string' }, 'comparison-index': { type: 'string' }, out: { type: 'string' }, scope: { type: 'string' },
  } });
  const { registry, out, scope, 'comparison-index': index } = values;
  if (positionals.length !== 1 || positionals[0] !== 'plan' || !registry || !index || !out || (scope !== 'formal' && scope !== 'rehearsal')) {
    throw new Error('Use plan --registry <directory> --comparison-index <file> --out <directory> --scope <formal|rehearsal>');
  }
  const artifacts = join(root, 'artifacts');
  const privatePath = (path: string) => {
    const absolute = checkedPath(path, root);
    const part = relative(artifacts, absolute);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Use private paths inside artifacts/');
    return absolute;
  };
  const result = await planComparison({ registry: privatePath(registry), comparisonIndex: privatePath(index), out: privatePath(out), scope });
  process.stdout.write(JSON.stringify({ output: result.output, planSha256: result.planSha256, scope, slots: result.plan.slots.length }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Comparison planning failed'}\n`);
    process.exitCode = 1;
  });
}
