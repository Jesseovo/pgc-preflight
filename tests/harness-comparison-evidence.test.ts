import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildComparisonEvidencePack } from '../scripts/harness-comparison-evidence';
import { importRecord, prepare } from '../scripts/harness-evaluation';
import { openComparisonEvidencePack, type ComparisonEvidencePack } from '../server/harness-comparison-evidence';

const directories: string[] = [];
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const caseId = 'tap-rhythm';
const implementationCommit = 'a'.repeat(40);
const image = `registry.cloudflare.com/${'b'.repeat(32)}/research@sha256:${'c'.repeat(64)}`;

afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pgc-comparison-evidence-')));
  directories.push(directory);
  await mkdir(join(directory, 'inputs'));
  async function artifact(name: string, bytes: Buffer | string) {
    const path = `inputs/${name}`;
    await writeFile(join(directory, path), bytes);
    return { path, sha256: sha(bytes) };
  }
  const fixtureRoot = fileURLToPath(new URL('../fixtures/harness-evaluation', import.meta.url));
  const checklistBytes = await readFile(join(fixtureRoot, 'checklists.json'));
  const indexedCases = await Promise.all((JSON.parse(checklistBytes.toString()) as { id: string }[]).map(async ({ id }) => ({
    id, materials: await Promise.all(['brief.md', 'sample.svg', 'assets.html'].map(async name => ({
      path: `${id}/${name}`, sha256: sha(await readFile(join(fixtureRoot, id, name))),
    }))),
  })));
  const index = await artifact('index.json', encode({ schemaVersion: 1, checklistSha256: sha(checklistBytes), cases: indexedCases }));
  const creationConfig = await artifact('creation-config.json', encode({ model: 'claude-opus-5-5' }));
  const reviewConfig = await artifact('review-config.json', encode({ model: 'synthetic-review' }));
  const settings = await artifact('settings.json', encode({
    creationModel: { name: 'claude-opus-5-5', config: creationConfig }, reviewModel: { name: 'synthetic-review', config: reviewConfig },
    rulesVersion: 'synthetic-v2', rules: await artifact('rules.txt', 'fixture rules'), calibration: await artifact('calibration.json', '[]'),
    harnessCommit: implementationCommit, harnessImage: image,
  }));
  const indexPath = join(directory, index.path);
  const manifestSha256 = await prepare(directory, join(directory, settings.path), indexPath);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { cases: { id: string; materialSha256: string }[]; frozenAt: string };
  const clock = { startedAt: manifest.frozenAt, finishedAt: manifest.frozenAt };
  const htmlText = '\uFEFF<!doctype html><title>合成游戏</title>\r\n';
  const html = await artifact('game.html', htmlText);
  const attachment = await artifact('private-self-check.json', '{"creatorSelfCheck":"PRIVATE_SELFCHECK"}');
  await importRecord(directory, 'creation', {
    manifestSha256, caseId, arm: 'B', implementationCommit, image, materialSha256: manifest.cases[0].materialSha256,
    modelConfigSha256: creationConfig.sha256, status: 'completed', ...clock, failure: null,
    stages: [{ phase: 'build', status: 'completed', ...clock, failure: null, inputTokens: null, outputTokens: null, usageEvidence: null }],
    html, blindSafe: true, attachments: [attachment], controllerUsage: null,
  });
  const probeData = {
    captureMethod: 'browser-viewport-v1', note: null, loaded: { '9:16': null },
    observations: [
      ['9:16 首次触摸后约 10 秒', 'baseline-9:16-tap'], ['9:19.5 首次触摸前'],
      ['9:19.5 首次触摸后约 3 秒', 'baseline-9:19.5-tap'], ['9:21 首次触摸后约 10 秒', 'baseline-9:21-tap'],
    ].map(([label, ...actionRefs], index) => ({ id: `baseline-${index + 1}`, label, actionRefs, capturedAt: manifest.frozenAt, audio: null })),
  };
  const probeText = JSON.stringify(probeData, null, 1) + '\r\n';
  const probe = await artifact('original-probe.json', probeText);
  const pictureBytes = [1, 2, 3, 4].map(i => Buffer.from(i === 1 ? [137, 80, 78, 71, 13, 10, 26, 10, i] : [255, 216, 255, i]));
  const shots = await Promise.all(pictureBytes.map((bytes, index) => artifact(`view-${index + 1}`, bytes)));
  const evidenceSha256 = sha(encode({ html: html.sha256, probe: probe.sha256, shots: shots.map(shot => shot.sha256) }));
  const privateEvidence = await artifact('private-catalog.txt', 'PRIVATE_REFERENCE_ANSWER');
  await importRecord(directory, 'review-input', {
    manifestSha256, caseId, htmlSha256: html.sha256, probe, shots, evidenceSha256, blindSafe: true,
    observerId: 'synthetic-catalog-reviewer', observerType: 'independent-agent', independent: true, catalogExhaustive: true,
    catalog: [{ id: 'private-issue', observation: 'PRIVATE_CATALOG', evidence: [privateEvidence] }], catalogEvidence: [privateEvidence], disputes: [],
  });
  return { directory, indexPath, html, htmlText, probe, probeText, probeData, pictureBytes, evidenceSha256, manifestSha256 };
}

describe('portable same-evidence comparison pack', () => {
  it('packages exact bytes from a frozen B creation without private adjudication, and replays independent copies', async () => {
    const run = await setup();
    const { serialized, identity } = await buildComparisonEvidencePack(run.directory, run.indexPath, caseId);
    expect(identity).toEqual({ caseId, manifestSha256: run.manifestSha256, evidenceSha256: run.evidenceSha256, packSha256: sha(serialized) });
    expect(serialized).not.toMatch(/PRIVATE_|private-self-check|private-catalog|observerId|inputs\//);
    const pack = JSON.parse(serialized) as ComparisonEvidencePack;
    expect(pack.html.text).toBe(run.htmlText);
    expect(pack.probe.json).toBe(run.probeText);
    const left = await openComparisonEvidencePack(serialized, identity), right = await openComparisonEvidencePack(serialized, identity);
    expect(left.html).toBe(run.htmlText);
    const capture = await left.captureReview(left.html), counterpart = await right.captureReview(right.html);
    expect(capture).toEqual(counterpart);
    expect(capture.probe).toEqual(run.probeData);
    for (const [i, shot] of capture.shots.entries()) {
      expect(shot).toMatchObject({ source: 'isolated-chromium', label: run.probeData.observations[i].label });
      expect(Buffer.from(shot.data.split(',')[1], 'base64')).toEqual(run.pictureBytes[i]);
    }
    capture.shots[0].actionRefs.push('mutation');
    capture.probe.observations[1].label = 'mutation';
    expect(await left.captureReview(left.html)).toEqual(counterpart);
    await expect(right.captureReview(right.html.trim())).rejects.toThrow('Runner HTML differs');
  });

  it('rejects independent manifest/case identities and physical file drift before export', async () => {
    const run = await setup();
    const pack = await buildComparisonEvidencePack(run.directory, run.indexPath, caseId);
    await expect(openComparisonEvidencePack(pack.serialized, { ...pack.identity, caseId: 'dense-mobile' })).rejects.toThrow('trusted admission');
    await expect(openComparisonEvidencePack(pack.serialized, { ...pack.identity, manifestSha256: 'd'.repeat(64) })).rejects.toThrow('trusted admission');
    await expect(buildComparisonEvidencePack(run.directory, run.indexPath, 'unregistered')).rejects.toThrow('outside the frozen');
    await writeFile(join(run.directory, run.html.path), '<title>Substituted</title>');
    await expect(buildComparisonEvidencePack(run.directory, run.indexPath, caseId)).rejects.toThrow('File hash mismatch');
  });

  it('rejects byte, order, shape, label and supplemental-source tampering', async () => {
    const run = await setup();
    const { serialized, identity } = await buildComparisonEvidencePack(run.directory, run.indexPath, caseId);
    const tamper = async (change: (pack: ComparisonEvidencePack) => void, error: string) => {
      const pack = JSON.parse(serialized) as ComparisonEvidencePack;
      change(pack);
      const changed = JSON.stringify(pack) + '\n';
      await expect(openComparisonEvidencePack(changed, identity)).rejects.toThrow('package SHA-256');
      await expect(openComparisonEvidencePack(changed, { ...identity, packSha256: sha(changed) })).rejects.toThrow(error);
    };
    await tamper(pack => { pack.html.text += 'changed'; }, 'HTML SHA-256');
    await tamper(pack => { pack.probe.json += ' '; }, 'probe SHA-256');
    await tamper(pack => { pack.shots[0].data = `data:image/png;base64,${Buffer.concat([run.pictureBytes[0], Buffer.from([9])]).toString('base64')}`; }, 'screenshot SHA-256');
    await tamper(pack => { [pack.shots[0], pack.shots[1]] = [pack.shots[1], pack.shots[0]]; }, 'screenshot order');
    await tamper(pack => { pack.shots.push(pack.shots[0]); }, 'exactly four');
    await tamper(pack => { Object.assign(pack, { supplementalSource: 'private source' }); }, 'Unexpected or missing');
    await tamper(pack => {
      const probe = JSON.parse(pack.probe.json);
      probe.observations[0].label = 'different label';
      pack.probe.json = encode(probe);
      pack.probe.sha256 = sha(pack.probe.json);
    }, 'viewport order, labels');
    await tamper(pack => {
      const probe = JSON.parse(pack.probe.json);
      probe.observations[0].audio = { source: 'private answer' };
      pack.probe.json = encode(probe);
      pack.probe.sha256 = sha(pack.probe.json);
    }, 'Unexpected or missing');
    await tamper(pack => {
      pack.html.text += 'resealed byte change';
      pack.html.sha256 = sha(pack.html.text);
    }, 'bundle SHA-256');
  });
});
