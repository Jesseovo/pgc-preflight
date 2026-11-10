import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runPairedComparisonRehearsal } from '../scripts/harness-comparison-rehearsal';

it('executes both real workflow paths with scripted boundaries and the same B review evidence', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pgc-paired-rehearsal-')));
  try {
    const out = join(parent, 'pair');
    const { result } = await runPairedComparisonRehearsal(out);
    expect(result).toMatchObject({ scope: 'synthetic-offline-paired-rehearsal', sameCreationMaterials: true, sameReviewEvidence: true,
      sameReviewRulesAndModel: true, initialAndVerificationChecked: true, scriptedForwards: 8,
      providerRequests: 0, realContainers: 0, networkOperations: 0, releaseReady: false, formalImportAllowed: false });
    expect(result.dispatches).toHaveLength(4);
    for (const item of [...result.receipts, ...result.dispatches]) {
      const bytes = await readFile(join(out, item.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.sha256);
    }
    const saved = await readFile(join(out, 'verification.json'), 'utf8');
    expect(JSON.parse(saved)).toEqual(result);
    await expect(runPairedComparisonRehearsal(out)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(out, 'verification.json'), 'utf8')).toBe(saved);
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 60_000);
