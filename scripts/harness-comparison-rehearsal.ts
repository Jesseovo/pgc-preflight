/** One paired functional rehearsal. Scripted outputs are never quality/evaluation records. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBaselineRehearsal } from './harness-comparison-baseline';
import { runHarnessRehearsal } from './harness-comparison-harness-rehearsal';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const bindingKeys = ['rulesSha256', 'rulesContentSha256', 'calibrationSha256', 'modelConfigSha256'] as const;

export async function runPairedComparisonRehearsal(out: string) {
  assert(out && !out.split(/[\\/]/).includes('..'), 'Use a fresh private rehearsal path');
  const directory = resolve(out);
  assert.equal(await realpath(dirname(directory)), dirname(directory), 'Rehearsal parent must be a real directory');
  await mkdir(directory, { mode: 0o700 });
  const B = await runHarnessRehearsal({ out: join(directory, 'B') });
  const A = runBaselineRehearsal({ out: join(directory, 'A'), reviewInput: B.reviewInput });
  assert.equal(A.result.caseId, B.result.caseId);
  assert.deepEqual(A.result.materialSha256, B.result.materialSha256, 'Creation materials differed between arms');
  assert.equal(B.result.creation.sha256, B.result.review.evidence.htmlSha256, 'Review must use exact B artifact bytes');
  assert.equal(A.result.review.inputOrigin, 'shared-synthetic');
  assert.deepEqual(A.result.review.evidence, B.result.review.evidence, 'Review HTML, probe or ordered images differ');
  const bindings = Object.fromEntries(bindingKeys.map(key => {
    const a = A.result.review[key], b = B.result.review[key];
    assert.equal(a, b, `Review ${key} differs`);
    assert.match(a, /^[a-f0-9]{64}$/);
    return [key, a];
  }));
  for (const result of [A.result, B.result]) {
    assert.equal(result.creation.status, 'done'); assert.equal(result.review.status, 'done');
    assert.equal(result.providerRequests, 0); assert.equal(result.networkOperations, 0);
    assert.equal(result.formalImportAllowed, false); assert.equal(result.scriptedForwards, 4);
  }
  const dispatches = await Promise.all(['A','B'].flatMap(arm => [3,4].map(async index => {
    const path = `${arm}/dispatch-${index}.json`, bytes = await readFile(join(directory, path));
    const dispatch = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(dispatch.reviewEvidence, B.result.review.evidence, 'Actual review dispatch changed evidence');
    for (const key of bindingKeys) assert.equal(dispatch[key], bindings[key], `Actual dispatch changed ${key}`);
    assert.deepEqual(dispatch.imageSha256, B.result.review.evidence.shotSha256, 'Actual model image order differs');
    assert.equal(dispatch.effort, 'low'); assert.equal(dispatch.outputCap, 24_000);
    return { path, sha256: sha(bytes) };
  })));
  const receipts = await Promise.all(['A','B'].flatMap(arm => ['verification.json','artifact.html','initial-draft.json','final-report.json'].map(async name => {
    const path = `${arm}/${name}`, bytes = await readFile(join(directory, path)); return { path, sha256: sha(bytes) };
  })));
  const sourceBytes = await readFile(join(directory, 'B/source.json'));
  assert.equal(sha(sourceBytes), B.result.sourceVerification.sourceReceiptSha256, 'B source receipt changed');
  receipts.push({ path: 'B/source.json', sha256: sha(sourceBytes) });
  const result = { schemaVersion: 1, scope: 'synthetic-offline-paired-rehearsal', caseId: A.result.caseId,
    providerRequests: 0, networkOperations: 0, realContainers: 0, scriptedForwards: 8,
    sameCreationMaterials: true, sameReviewEvidence: true, sameReviewRulesAndModel: true,
    initialAndVerificationChecked: true, evidence: B.result.review.evidence, bindings,
    source: { A: A.provenance, B: { implementationCommit: B.result.implementationCommit, engineCommit: B.result.engineCommit,
      policyImage: B.result.policyImage, verification: B.result.sourceVerification, nativeAndEngineSimulated: true } },
    dispatches, receipts, formalImportAllowed: false, executionAllowed: false, releaseReady: false,
    limits: ['Scripted provider outputs and capture; no game quality measurement.', 'B container/CCB boundary is simulated.',
      'Shared comparison grant ledger and live transport have separate tests and are not exercised by this pair.'],
  };
  const temporary = join(directory, `.result-${randomUUID()}.tmp`);
  await writeFile(temporary, encoded(result), { flag: 'wx', mode: 0o600 });
  try { await link(temporary, join(directory, 'verification.json')); } finally { await unlink(temporary); }
  return { output: directory, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, flag, output, ...extra] = process.argv.slice(2);
  const root = resolve(fileURLToPath(new URL('../artifacts/', import.meta.url)));
  const path = output && resolve(output), within = path && relative(root, path);
  if (command !== 'run' || flag !== '--out' || !within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || extra.length) {
    process.stderr.write('Use run --out <fresh directory inside artifacts/>. This command is synthetic-only.\n'); process.exitCode = 1;
  } else runPairedComparisonRehearsal(path).then(({ output, result }) => process.stdout.write(JSON.stringify({ output, ...result }) + '\n'))
    .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Paired rehearsal failed'}\n`); process.exitCode = 1; });
}
