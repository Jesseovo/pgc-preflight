/** Offline packaging only. Does not create authorization, resources, or model requests. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareComparisonBaseline } from './prepare-harness-comparison-baseline';
import { readFrozenComparison } from './harness-evaluation';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const builtins = new Set(builtinModules.map(value => value.replace(/^node:/, '')));
const pinnedB = '630303565f44c061c7ed8ad7b992dcc4e9db8929';
const pinnedImage = 'registry.cloudflare.com/071443b43c7562efec975a5e964d5a9c/pgc-ccb-research@sha256:0e95a0406e8dc94b0a4eea1f2cb62ff2a31ff48261d8fca87923d99ebfcec957';

async function privateFile(path: string) {
  assert.equal(await realpath(path), path, 'Package input cannot be a symbolic link');
  const info = await stat(path);
  assert(info.isFile(), 'Package input must be a regular file');
  return readFile(path);
}

export async function prepareComparisonPackage(options: {
  registry: string; comparisonIndex: string; baselineSnapshot: string; out: string;
}) {
  for (const path of Object.values(options)) assert(path && !path.split(/[\\/]/).includes('..'), 'Package paths must not traverse parents');
  const directory = resolve(options.out), baselinePath = resolve(options.baselineSnapshot);
  assert.equal(await realpath(dirname(directory)), dirname(directory), 'Package parent must be a real private directory');
  const parentInfo = await stat(dirname(directory));
  assert.equal(parentInfo.mode & 0o077, 0, 'Package parent must be private');
  const frozen = await readFrozenComparison(resolve(options.registry), resolve(options.comparisonIndex));
  assert.equal(frozen.settings.harnessCommit, pinnedB, 'Formal packaging requires the frozen B implementation');
  assert.equal(frozen.settings.harnessImage, pinnedImage, 'Formal packaging requires the verified immutable image');
  async function verifyRuntime() {
    const tree = execFileSync('/usr/bin/git', ['ls-tree', '-rz', pinnedB, '--', 'server', 'src', 'harness', 'migrations',
      'fixtures/harness-evaluation', 'package-lock.json', 'scripts/review-adaptive.ts', 'scripts/review-capture.ts'], {
      cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1' },
    });
    const files = await Promise.all(tree.split('\0').filter(Boolean).map(async item => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(item);
      assert(match, 'Invalid pinned runtime entry');
      const bytes = await privateFile(join(root, match[3]));
      assert.equal(createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'), match[2],
        `Pinned B source changed: ${match[3]}`);
      return [match[3], sha(bytes)] as const;
    }));
    assert(files.some(([file]) => file === 'server/harness-host.ts'));
    return { implementationCommit: pinnedB, runtimeTreeSha256: sha(JSON.stringify(files)), files: Object.fromEntries(files) };
  }
  const pinnedRuntime = await verifyRuntime();
  const baselineBytes = await privateFile(baselinePath), baseline = JSON.parse(baselineBytes.toString('utf8'));
  assert.equal(baseline.worker, 'pgc-preflight');
  assert.equal(baseline.productionMutations, 0);
  assert.equal(baseline.providerRequests, 0);
  assert.equal(baseline.deployment?.versions?.length, 1);
  assert.equal(baseline.deployment.versions[0].percentage, 100);
  assert.equal(baseline.deployment.versions[0].version_id, baseline.versionId);
  assert.match(baseline.versionId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const modulePath = baseline.originalModule?.path;
  assert(typeof modulePath === 'string' && !isAbsolute(modulePath) && !modulePath.split(/[\\/]/).includes('..'));
  const original = await privateFile(resolve(dirname(baselinePath), modulePath));
  assert.equal(sha(original), baseline.originalModule.sha256);
  assert.equal(original.byteLength, baseline.originalModule.bytes);
  await mkdir(directory, { mode: 0o700 }); // Deliberately refuses to overwrite a prior package.
  const git = (args: string[]) => execFileSync('/usr/bin/git', args, {
    cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_NO_REPLACE_OBJECTS: '1' },
  }).trim();
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const sourceWorkingTreeClean = git(['status', '--porcelain']).length === 0;
  const A = prepareComparisonBaseline({ out: join(directory, 'A-source') });
  assert.equal(A.manifest.implementationCommit, frozen.baseline);
  const entries = [
    ['A', A.workerEntry],
    ['B', join(root, 'scripts/harness-comparison-task-worker.ts')],
    ['relay', join(root, 'scripts/harness-comparison-relay-worker.ts')],
    ['authority', join(root, 'scripts/harness-comparison-authority-worker.ts')],
    ['candidate-handler', join(root, 'scripts/harness-comparison-candidate-entry.ts')],
  ] as const;
  async function bundle(name: string, entry: string) {
    const compiled = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, metafile: true,
      format: 'esm', platform: 'neutral', target: 'es2022', conditions: ['workerd'], mainFields: ['browser', 'module', 'main'], nodePaths: [join(root, 'node_modules')],
      legalComments: 'inline', external: ['cloudflare:workers', 'node:*'], plugins: [{ name: 'explicit-worker-node-builtins',
        setup(build) { build.onResolve({ filter: /^[A-Za-z_]/ }, args => builtins.has(args.path)
          ? { path: 'node:' + args.path, external: true } : undefined); },
      }] });
    assert.equal(compiled.outputFiles.length, 1, 'Expected a single Worker module');
    const bytes = compiled.outputFiles[0].contents, path = name + '.js';
    await writeFile(join(directory, path), bytes, { flag: 'wx', mode: 0o600 });
    const inputs = await Promise.all(Object.keys(compiled.metafile!.inputs).sort().map(async path => {
      const file = resolve(root, path), bytes = await readFile(file);
      return { path: relative(root, file), sha256: sha(bytes), bytes: bytes.byteLength };
    }));
    const provenance = { entry: relative(root, entry), inputs };
    const sourcePath = name + '-sources.json', sourceBytes = encode(provenance);
    await writeFile(join(directory, sourcePath), sourceBytes, { flag: 'wx', mode: 0o600 });
    return { name, path, sha256: sha(bytes), bytes: bytes.byteLength, sourcePath, sourceSha256: sha(sourceBytes) };
  }
  const compiled = await Promise.allSettled(entries.map(([name, entry]) => bundle(name, entry)));
  const workers: Awaited<ReturnType<typeof bundle>>[] = [];
  const failures: unknown[] = [];
  for (const result of compiled) {
    if (result.status === 'rejected') failures.push(result.reason);
    else workers.push(result.value);
  }
  if (failures.length) throw new AggregateError(failures, 'Comparison Worker packaging failed; no activation manifest was emitted');
  await writeFile(join(directory, 'worker.js'), original, { flag: 'wx', mode: 0o600 });
  const candidateEntry = `import original from './worker.js';\nexport * from './worker.js';\nimport { fetchComparisonCandidate } from './candidate-handler.js';\nexport default { ...original, fetch: fetchComparisonCandidate };\n`;
  await writeFile(join(directory, 'candidate-entry.js'), candidateEntry, { flag: 'wx', mode: 0o600 });
  const candidate = workers.find(value => value.name === 'candidate-handler')!;
  const candidateModules = [
    { name: 'worker.js', sha256: sha(original), bytes: original.byteLength },
    { name: 'candidate-handler.js', sha256: candidate.sha256, bytes: candidate.bytes },
    { name: 'candidate-entry.js', sha256: sha(candidateEntry), bytes: new TextEncoder().encode(candidateEntry).byteLength },
  ];
  assert.deepEqual(await verifyRuntime(), pinnedRuntime, 'Pinned runtime changed during packaging');
  const receipt = { schemaVersion: 1, kind: 'unactivated-formal-comparison-package', preparedAt: new Date().toISOString(),
    sourceCommit, sourceWorkingTreeClean, baselineSnapshotSha256: sha(baselineBytes),
    baseVersion: baseline.versionId, baseDeployment: baseline.deployment.id, manifestSha256: frozen.manifestSha256,
    materialIndexSha256: frozen.materialIndexSha256, A: A.manifest, B: frozen.settings.harnessCommit, pinnedRuntime,
    engineCommit: frozen.engine, image: frozen.settings.harnessImage, workers, candidateModules,
    compatibilityDate: '2026-10-23', privateWorkerFlags: ['nodejs_compat', 'enable_request_signal'],
    productionMutations: 0, providerCalls: 0, resourcesCreated: 0, activationAllowed: false, deployed: false,
    authorization: null,
    requiredBeforeActivation: [
      'Separate explicit formal model-request and output-token allowance; prior compatibility grant exhausted',
      'Clean committed adapter source and successful exact-commit validation',
      'Current production module, bindings, assets and routing independently revalidated before temporary deployment',
      'Isolated A/B/global ledger databases, original paused admission, immutable materials and disabled authorization row verified',
      'Actual candidate/A/B Worker versions and bundle digests independently read back and bound to the signed contexts',
      'Private authority, relay, task Durable Objects, fixed container digest, Browser and stable request-signal bindings verified',
      'Original Worker receives 100% ordinary traffic; zero-percent candidate only receives signed research requests',
      'Real isolated service/DO composition verified before enabling any provider request',
    ],
    requiredAfterExecution: ['Export and hash all private results including failures and unknown outcomes',
      'Stop research execution and restore original-only routing', 'Independently verify removal of temporary resources'],
    qualityAcceptance: false,
  };
  await writeFile(join(directory, 'package.json'), encode(receipt), { flag: 'wx', mode: 0o600 });
  return { output: directory, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    registry: { type: 'string' }, 'comparison-index': { type: 'string' }, baseline: { type: 'string' }, out: { type: 'string' },
  } });
  assert(positionals.length === 1 && positionals[0] === 'prepare' && values.registry && values['comparison-index'] && values.baseline && values.out,
    'Use prepare --registry PRIVATE_DIR --comparison-index PRIVATE_JSON --baseline PRIVATE_JSON --out NEW_PRIVATE_DIR');
  const output = resolve(values.out), part = relative(join(root, 'artifacts'), output);
  assert(part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep), 'Output must be inside ignored private artifacts');
  const result = await prepareComparisonPackage({ registry: values.registry, comparisonIndex: values['comparison-index'],
    baselineSnapshot: values.baseline, out: output });
  process.stdout.write(encode({ output: result.output, workers: result.receipt.workers.length, activationAllowed: false, providerCalls: 0 }));
}
