import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local-only packaging. This command has no network/deployment operations and
// accepts no credentials. Apply only after separate approval and revalidation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const deepSeek = args.length === 5 && args[4] === '--deepseek-review';
if (args.length !== (deepSeek ? 5 : 4) || args[0] !== '--baseline' || args[2] !== '--out') {
  throw new Error('Expected --baseline PRIVATE_BASELINE_DIR --out PRIVATE_PACKAGE_DIR [--deepseek-review]');
}
const baselineDir = resolve(args[1]);
const out = resolve(args[3]);
if (![baselineDir, out].every(path => path.startsWith(root + '/artifacts/')) || baselineDir === out) throw new Error('Only separate private artifact directories are allowed');
const baseline = JSON.parse(await readFile(resolve(baselineDir, 'baseline.json'), 'utf8'));
const original = baseline.version;
if (baseline.worker !== 'pgc-preflight' || baseline.productionChanged !== false || baseline.deployment.versions.length !== 1 ||
    baseline.deployment.versions[0].percentage !== 100 || baseline.deployment.versions[0].version_id !== original.id ||
    original.mainModule !== 'worker.js' || !Array.isArray(original.modules) || original.modules.length !== 1 ||
    original.modules[0].name !== 'worker.js' || original.modules[0].contentType !== 'application/javascript+module' ||
    original.migrationTag !== 'v3-creator-feedback') throw new Error('Unexpected production baseline; review before packaging');
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
await mkdir(out, { recursive: true, mode: 0o700 });
const bytes = await readFile(resolve(baselineDir, 'modules/worker.js'));
if (sha256(bytes) !== original.modules[0].sha256 || bytes.length !== original.modules[0].bytes) throw new Error('Original module hash mismatch');
const compiled = await build({
  entryPoints: [resolve(root, deepSeek ? 'scripts/harness-provider-deepseek-candidate-entry.ts' : 'scripts/harness-provider-candidate-entry.ts')], bundle: true, write: false,
  format: 'esm', target: 'es2022', platform: 'neutral', conditions: ['workerd'], legalComments: 'inline',
});
if (compiled.outputFiles.length !== 1) throw new Error('Unexpected candidate bundle');
const source = compiled.outputFiles[0].contents;
const entry = `import original from './worker.js';\nexport * from './worker.js';\nimport { fetchResearchCandidate } from './research-handler.js';\nexport default { ...original, fetch: fetchResearchCandidate };\n`;
const modules = [
  { name: 'worker.js', content: bytes, source: 'exact-production-baseline' },
  { name: 'research-handler.js', content: source, source: 'restricted-research-handler' },
  { name: 'research-entry.js', content: Buffer.from(entry), source: 'research-only-fetch-original-triggers-and-exports' },
];
for (const module of modules) await writeFile(resolve(out, module.name), module.content, { mode: 0o600 });
const receipt = {
  schemaVersion: 1, recordedAt: new Date().toISOString(), worker: baseline.worker,
  baseVersion: original.id, baseDeployment: baseline.deployment.id, mainModule: 'research-entry.js',
  productionChanged: false, deployed: false, providerCalls: 0, ...(deepSeek && { fixture: 'ccb-deepseek-review-tool-v1' }),
  modules: modules.map(module => ({ name: module.name, source: module.source, bytes: module.content.length, sha256: sha256(module.content), contentType: 'application/javascript+module' })),
  requiredOriginalBindings: original.bindings.map((binding: { name: string; type: string }) => ({ name: binding.name, type: binding.type })),
  addedBindings: ['HARNESS_RESEARCH_DB', 'PGC_RESEARCH_AUTH', 'PGC_RESEARCH_VERSION', 'PGC_RESEARCH_MANIFEST'],
  productionWrites: ['model_throttle', 'model_slots'],
  requiredBeforeUpload: ['user approval for research deployment configuration', 'active and latest versions both equal baseVersion', 'no ongoing platform model calls', 'new secret never persisted locally', 'isolated database ID differs from production'],
  requiredAfterUpload: ['all original module bytes and binding resources equal baseline', 'asset routing config and directly fetched asset bytes equal baseline', 'no new named exports or DO migration', 'exact A100/B0 readback', 'signed executing-version response before paid requests'],
  rollback: { method: 'POST', endpoint: `/accounts/<account>/workers/scripts/${baseline.worker}/deployments`,
    body: { strategy: 'percentage', versions: [{ version_id: original.id, percentage: 100 }] }, force: false,
    caveat: 'Version changes may restart active Durable Objects; stop new research calls and verify baseline before cleanup.' },
};
await writeFile(resolve(out, 'candidate-package.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ package: resolve(out, 'candidate-package.json'), baseVersion: original.id, moduleCount: modules.length, deployed: false }));
