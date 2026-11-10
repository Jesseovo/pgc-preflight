import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { openComparisonEvidencePack, type ComparisonEvidencePack } from '../server/harness-comparison-evidence';
import { lockedReviewCapture, readFrozenComparison } from './harness-evaluation';

type Ref = { path: string; sha256: string };
type LockedInput = {
  caseId: string; manifestSha256: string; evidenceSha256: string; blindSafe: boolean;
  html: Ref; htmlSha256: string; probe: Ref; shots: Ref[];
};

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function readRegular(path: string) {
  if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error('Comparison evidence paths must be regular files without symbolic links');
  return readFile(path);
}

async function readOriginal(directory: string, ref: Ref) {
  if (typeof ref?.path !== 'string' || !ref.path.startsWith('inputs/') || ref.path.split('/').includes('..')) {
    throw new Error('Original comparison evidence must stay inside private inputs');
  }
  const file = resolve(directory, ref.path);
  const inside = relative(join(directory, 'inputs'), file);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) throw new Error('Original comparison evidence must stay inside private inputs');
  const bytes = await readRegular(file);
  if (sha(bytes) !== ref.sha256) throw new Error('Original comparison evidence SHA-256 mismatch');
  return utf8.decode(bytes);
}

/** Package only the evidence already locked for review. Nothing here executes a Runner. */
export async function buildComparisonEvidencePack(directory: string, indexPath: string, caseId: string) {
  const root = resolve(directory);
  const registration = await readFrozenComparison(root, indexPath);
  const registered = registration.cases.find(row => row.id === caseId);
  if (!registered) throw new Error('Case is outside the frozen comparison registration');
  const records = join(root, 'records');
  const inputFile = join(records, `review-input.${registered.id}.json`);
  if (dirname(inputFile) !== records) throw new Error('Invalid comparison case path');
  const rawInput = await readRegular(inputFile);
  const input = JSON.parse(rawInput.toString('utf8')) as LockedInput;
  if (input?.caseId !== registered.id || input.manifestSha256 !== registration.manifestSha256 || input.blindSafe !== true ||
    input.html?.sha256 !== input.htmlSha256 || !Array.isArray(input.shots) || input.shots.length !== 4) {
    throw new Error('Comparison review input is not locked to this frozen registration');
  }
  const capture = await lockedReviewCapture(root, registered.id);
  const [html, probe] = await Promise.all([readOriginal(root, input.html), readOriginal(root, input.probe)]);
  const validated = await capture(html);
  if (!isDeepStrictEqual(validated.probe, JSON.parse(probe)) || !(await readRegular(inputFile)).equals(rawInput)) {
    throw new Error('Comparison review input changed during packaging');
  }
  const pack: ComparisonEvidencePack = {
    schemaVersion: 1, caseId: registered.id, manifestSha256: registration.manifestSha256, evidenceSha256: input.evidenceSha256,
    captureOrigin: 'isolated-chromium', html: { text: html, sha256: input.html.sha256 }, probe: { json: probe, sha256: input.probe.sha256 },
    shots: validated.shots.map((shot, index) => ({ id: shot.id, sha256: input.shots[index].sha256, data: shot.data })),
  };
  const serialized = JSON.stringify(pack) + '\n';
  const identity = { caseId: pack.caseId, manifestSha256: pack.manifestSha256, evidenceSha256: pack.evidenceSha256, packSha256: sha(serialized) };
  await openComparisonEvidencePack(serialized, identity);
  return { serialized, identity };
}
