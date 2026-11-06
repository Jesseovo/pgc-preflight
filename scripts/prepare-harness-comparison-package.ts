/** Offline packaging of the frozen historical container comparison. */
import assert from 'node:assert/strict';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { absoluteLegacyPath, runLegacyComparison } from './harness-comparison-legacy-source';
import type { prepareComparisonBaseline } from './prepare-harness-comparison-baseline';

type Package = {
  output: string;
  receipt: {
    schemaVersion: number;
    kind: 'unactivated-formal-comparison-package';
    preparedAt: string;
    sourceCommit: string;
    sourceWorkingTreeClean: boolean;
    baselineSnapshotSha256: string;
    baseVersion: string;
    baseDeployment: string;
    manifestSha256: string;
    materialIndexSha256: string;
    A: ReturnType<typeof prepareComparisonBaseline>['manifest'];
    B: string;
    pinnedRuntime: { implementationCommit: string; runtimeTreeSha256: string; files: Record<string, string> };
    engineCommit: string;
    image: string;
    workers: { name: string; path: string; sha256: string; bytes: number; sourcePath: string; sourceSha256: string }[];
    candidateModules: { name: string; sha256: string; bytes: number }[];
    compatibilityDate: string;
    privateWorkerFlags: string[];
    productionMutations: 0;
    providerCalls: 0;
    resourcesCreated: 0;
    activationAllowed: false;
    deployed: false;
    authorization: null;
    requiredBeforeActivation: string[];
    requiredAfterExecution: string[];
    qualityAcceptance: false;
  };
};

export async function prepareComparisonPackage(options: {
  registry: string; comparisonIndex: string; baselineSnapshot: string; out: string;
}) {
  return runLegacyComparison<Package>('package', Object.fromEntries(Object.entries(options).map(([name, path]) =>
    [name, absoluteLegacyPath(path, 'Package paths must not traverse parents')])));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    registry: { type: 'string' }, 'comparison-index': { type: 'string' }, baseline: { type: 'string' }, out: { type: 'string' },
  } });
  assert(positionals.length === 1 && positionals[0] === 'prepare' && values.registry && values['comparison-index'] && values.baseline && values.out,
    'Use prepare --registry PRIVATE_DIR --comparison-index PRIVATE_JSON --baseline PRIVATE_JSON --out NEW_PRIVATE_DIR');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const output = absoluteLegacyPath(values.out, 'Package paths must not traverse parents');
  const part = relative(join(root, 'artifacts'), output);
  assert(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep), 'Output must be inside ignored private artifacts');
  const result = await prepareComparisonPackage({ registry: values.registry, comparisonIndex: values['comparison-index'],
    baselineSnapshot: values.baseline, out: output });
  process.stdout.write(JSON.stringify({ output: result.output, workers: result.receipt.workers.length, activationAllowed: false, providerCalls: 0 }, null, 2) + '\n');
}
