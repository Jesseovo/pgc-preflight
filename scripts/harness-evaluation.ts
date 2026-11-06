/** Offline registration and accounting. Judgments are supplied by independent observers. */
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { reviewReportErrors } from '../server/review-report';
import { HARNESS_CCB_COMMIT as engine, isHarnessImage } from '../server/harness-protocol';

const baseline = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = join(root, 'fixtures/harness-evaluation');
const cases = ['tap-rhythm', 'continuous-drag', 'strategy-tradeoffs', 'collision-feedback', 'difficulty-restart', 'dense-mobile'] as const;
const metrics = ['control', 'feedback', 'layout'] as const;
const materialNames = ['brief.md', 'sample.svg', 'assets.html'] as const;
const runKinds = ['creation', 'review'] as const;
const recordKinds = ['creation', 'review-input', 'review', 'creation-judgment', 'review-judgment', 'prerequisite'] as const;
const arms = ['A', 'B'] as const;
type Arm = typeof arms[number];
type RunKind = typeof runKinds[number];
type Kind = typeof recordKinds[number];
type Ref = { path: string; sha256: string };
type Checklist = { id: string; metric: 'core' | typeof metrics[number]; criterion: string };
type Model = { name: string; config: Ref };
type Settings = {
  creationModel: Model; reviewModel: Model; rulesVersion: string; rules: Ref; calibration: Ref; harnessCommit: string; harnessImage: string;
};
type FrozenCase = { id: string; checklist: Checklist[]; materials: Record<string, string>; materialSha256: string };
type Frozen = {
  schemaVersion: 1; frozenAt: string; cases: FrozenCase[]; settings: Settings | null;
  materialIndexSha256?: string;
  creation: { A: object; B: object }; review: { A: object; B: object };
  acceptance: object; prerequisitesAtFreeze: { rightsConfirmed: false; providerCompatibilityVerified: false };
};
type Mapping = { id: string; kind: RunKind; caseId: string; arm: Arm };
type RecordData = Record<string, unknown>;
type RunStatus = 'completed' | 'failed' | 'missing';
type JudgmentState = 'verified' | 'failed' | 'unknown' | 'disputed';
type Stage = {
  phase: string; status: 'completed' | 'failed'; startedAt: string; finishedAt: string;
  inputTokens: number | null; outputTokens: number | null; usageEvidence: Ref | null; failure: string | null;
};
type ControllerUsage = { turns: number; repairs: number; evidence: Ref };
type Creation = {
  image?: string; status: RunStatus; startedAt: string | null; finishedAt: string | null; failure: string | null;
  stages: Stage[]; html: Ref | null; blindSafe: boolean; attachments: Ref[]; controllerUsage: ControllerUsage | null;
};
type Critical = { id: string; observation: string; evidence: Ref[] };
type ReviewInput = { lockedAt: string; html: Ref; probe: Ref; shots: Ref[]; evidenceSha256: string; catalog: Critical[]; catalogEvidence: Ref[]; disputes: string[]; observerId: string };
type Review = {
  image?: string; status: RunStatus; startedAt: string | null; finishedAt: string | null; failure: string | null;
  initial: (Stage & { image?: string }) | null; verify: (Stage & { image?: string }) | null; initialReport: Ref | null; finalReport: Ref | null; blindSafe: boolean; attachments: Ref[];
};
type Finding = { id: string; observation: string; evidence: Ref[]; state: JudgmentState };
type CreationJudgment = {
  checks: Finding[]; criticalDefects: Finding[]; unapprovedCoreChanges: Finding[]; disputes: string[]; observerId: string;
};
type ReviewJudgment = { mandatoryRemediations: Finding[]; criticalHits: Finding[]; disputes: string[]; observerId: string };

function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown, allowed: readonly string[], label: string): RecordData {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  const result = value as RecordData;
  need(Object.keys(result).every(key => allowed.includes(key)), `Unexpected fields in ${label}`);
  return result;
}
function str(value: unknown, label: string) {
  need(typeof value === 'string' && value.trim() && value.length <= 6000, `Missing or invalid ${label}`);
  return value;
}
function list(value: unknown, label: string) {
  need(Array.isArray(value) && value.length <= 256, `Invalid ${label}`);
  return value as unknown[];
}
function hash(value: unknown, label: string) {
  need(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `Invalid SHA-256 for ${label}`);
  return value;
}
function date(value: unknown, label: string) {
  const time = str(value, label);
  need(Number.isFinite(Date.parse(time)), `Invalid time for ${label}`);
  return time;
}
function code(value: unknown, label: string) {
  const id = str(value, label);
  need(/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(id), `Invalid identifier for ${label}`);
  return id;
}
function unique<T extends { id: string }>(rows: T[], label: string) {
  need(new Set(rows.map(row => row.id)).size === rows.length, `Duplicate ${label}`);
  return rows;
}
function sha(bytes: Buffer | string) { return createHash('sha256').update(bytes).digest('hex'); }
function jsonBytes(value: unknown) { return JSON.stringify(value, null, 2) + '\n'; }
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')); }
async function store(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, jsonBytes(value), { mode: 0o600, flag: 'wx' });
  try { await link(temporary, path); } finally { await unlink(temporary); }
}
function within(parent: string, path: string) {
  const part = relative(parent, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
async function fileBytes(directory: string, path: string) {
  const incoming = join(directory, 'inputs');
  const file = resolve(directory, path);
  need(within(incoming, file) && await realpath(file) === file && (await lstat(file)).isFile(), 'Input must be a regular file inside the private inputs directory');
  return readFile(file);
}
async function reference(directory: string, value: unknown, label: string) {
  const data = object(value, ['path', 'sha256'], label);
  const path = str(data.path, label);
  need(path.startsWith('inputs/') && !path.split('/').includes('..'), `Invalid private path for ${label}`);
  const digest = hash(data.sha256, label);
  need(sha(await fileBytes(directory, path)) === digest, `File hash mismatch for ${label}`);
  return { path, sha256: digest };
}
async function refs(directory: string, value: unknown, label: string, minimum = 0) {
  const entries = await Promise.all(list(value, label).map(entry => reference(directory, entry, label)));
  need(entries.length >= minimum && new Set(entries.map(entry => entry.sha256)).size === entries.length, `Missing or repeated evidence for ${label}`);
  return entries;
}
async function model(directory: string, value: unknown): Promise<Model> {
  const data = object(value, ['name', 'config'], 'model');
  return { name: code(data.name, 'model name'), config: await reference(directory, data.config, 'model configuration snapshot') };
}
async function settings(directory: string, value: unknown): Promise<Settings> {
  const data = object(value, ['creationModel', 'reviewModel', 'rulesVersion', 'rules', 'calibration', 'harnessCommit', 'harnessImage'], 'settings');
  const creationModel = await model(directory, data.creationModel);
  need(creationModel.name === 'claude-opus-5-5', 'Creation requires the locked Claude Opus 5.5 model');
  const harnessCommit = str(data.harnessCommit, 'harness implementation commit');
  need(/^[a-f0-9]{40}$/.test(harnessCommit), 'Use the full harness implementation commit');
  const harnessImage = data.harnessImage;
  need(isHarnessImage(harnessImage), 'Freeze the exact Cloudflare registry image digest');
  return {
    creationModel, reviewModel: await model(directory, data.reviewModel), rulesVersion: code(data.rulesVersion, 'rules version'), harnessCommit, harnessImage,
    rules: await reference(directory, data.rules, 'rules snapshot'),
    calibration: await reference(directory, data.calibration, 'calibration snapshot'),
  };
}
function fixedPaths(directory: string) {
  return {
    manifest: join(directory, 'manifest.json'),
    seal: join(directory, 'registration.json'),
    mapping: join(directory, 'mapping.private.json'),
    records: join(directory, 'records'),
    blind: join(directory, 'blind'),
    materials: join(directory, 'materials'),
  };
}
async function materialRegistration(checklistBytes: Buffer, indexPath?: string) {
  if (!indexPath) return null;
  const bytes = await readFile(indexPath);
  const index = JSON.parse(bytes.toString('utf8')) as RecordData;
  need(index?.schemaVersion === 1 && index.checklistSha256 === sha(checklistBytes), 'Archived checklist differs from the evaluation fixtures');
  const archived = unique(list(index.cases, 'archived cases').map(raw => {
    const row = object(raw, ['id', 'materials', 'creation', 'review', 'adjudication'], 'archived case');
    const materials = unique(list(row.materials, 'archived materials').map(value => {
      const ref = object(value, ['path', 'sha256'], 'archived material');
      return { id: basename(str(ref.path, 'archived material path')), sha256: hash(ref.sha256, 'archived material') };
    }), 'archived material name');
    need(materials.length === materialNames.length && materialNames.every(name => materials.some(ref => ref.id === name)), 'Archived case requires the exact three registered materials');
    return { id: code(row.id, 'archived case ID'), materials };
  }), 'archived case');
  need(archived.length === cases.length && cases.every(id => archived.some(row => row.id === id)), 'Archive must cover the same six registered cases');
  return { sha256: sha(bytes), cases: new Map(archived.map(row => [row.id, new Map(row.materials.map(ref => [ref.id, ref.sha256]))])) };
}
export async function prepare(directory: string, settingsPath?: string, indexPath?: string) {
  const paths = fixedPaths(directory);
  const lock = settingsPath ? await settings(directory, await json(settingsPath)) : null;
  const checklistBytes = await readFile(join(fixtureRoot, 'checklists.json'));
  const archive = await materialRegistration(checklistBytes, indexPath);
  const registered = JSON.parse(checklistBytes.toString('utf8')) as FrozenCase[];
  need(JSON.stringify(registered.map(item => item.id)) === JSON.stringify(cases), 'Synthetic case registry changed');
  const materialBytes = new Map<string, Buffer>();
  for (const { id } of registered) {
    for (const name of materialNames) {
      const bytes = await readFile(join(fixtureRoot, id, name));
      need(!archive || archive.cases.get(id)?.get(name) === sha(bytes), `Archived material differs for ${id}/${name}`);
      materialBytes.set(`${id}/${name}`, bytes);
    }
  }
  await mkdir(paths.records, { mode: 0o700 });
  await mkdir(paths.blind, { mode: 0o700 });
  await mkdir(paths.materials, { mode: 0o700 });
  const frozenCases: FrozenCase[] = [];
  for (const { id, checklist } of registered) {
    const dir = join(paths.materials, id);
    await mkdir(dir, { mode: 0o700 });
    const materials: Record<string, string> = {};
    for (const name of materialNames) {
      const bytes = materialBytes.get(`${id}/${name}`)!;
      await writeFile(join(dir, name), bytes, { mode: 0o600, flag: 'wx' });
      materials[name] = sha(bytes);
    }
    frozenCases.push({ id, checklist, materials, materialSha256: sha(jsonBytes(materials)) });
  }
  const manifest: Frozen = {
    schemaVersion: 1, frozenAt: new Date().toISOString(), settings: lock, cases: frozenCases,
    ...(archive ? { materialIndexSha256: archive.sha256 } : {}),
    creation: {
      A: { implementationCommit: baseline, path: 'published-platform-v2', thinking: 'adaptive', effort: 'high', requestMaxOutputTokens: 64_000 },
      B: { implementationCommit: lock?.harnessCommit ?? null, engineCommit: engine, image: lock?.harnessImage ?? null, thinking: 'adaptive', effort: 'high', requestMaxOutputTokens: 64_000,
        taskMaxOutputTokens: 256_000, taskMaxMs: 2_400_000, maxTurns: 24, maxRepairs: 2 },
    },
    review: {
      A: { implementationCommit: baseline, path: 'original-admin', mode: 'basic' },
      B: { implementationCommit: lock?.harnessCommit ?? null, engineCommit: engine, image: lock?.harnessImage ?? null, path: 'new-admin', mode: 'basic' },
    },
    acceptance: {
      selectReviewHtml: 'B output for each of the six registered cases; no substitution',
      completedCreationRequiredB: 6, allBCoreRequirementsVerified: true, metrics,
      strictImprovementInAtLeastOneMetric: true, otherMetricsNoWorse: true,
      criticalDefectsNoWorse: true, unapprovedCoreChangesNoWorse: true,
      unsupportedMandatoryNoWorse: true, confirmedCriticalHitsNoWorse: true,
      unknownOrDisputedJudgmentsBlock: true, confirmedControlCeilingBlocksImprovement: true,
    },
    prerequisitesAtFreeze: { rightsConfirmed: false, providerCompatibilityVerified: false },
  };
  const mapping = cases.flatMap(caseId => runKinds.flatMap(kind => arms.map(arm => ({ id: randomUUID(), kind, caseId, arm }))));
  await store(paths.manifest, manifest);
  await store(paths.mapping, mapping);
  const seal = { manifestSha256: sha(jsonBytes(manifest)), mappingSha256: sha(jsonBytes(mapping)) };
  await store(paths.seal, seal);
  return seal.manifestSha256;
}

async function openRegistry(directory: string) {
  const paths = fixedPaths(directory);
  const manifestBytes = await readFile(paths.manifest);
  const mappingBytes = await readFile(paths.mapping);
  const manifestSha256 = sha(manifestBytes);
  const seal = await json(paths.seal) as { manifestSha256: string; mappingSha256: string };
  need(seal.manifestSha256 === manifestSha256 && seal.mappingSha256 === sha(mappingBytes), 'Frozen registration or blind mapping has changed');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Frozen;
  const mapping = JSON.parse(mappingBytes.toString('utf8')) as Mapping[];
  if (manifest.settings) await settings(directory, manifest.settings);
  for (const item of manifest.cases) {
    for (const name of materialNames) {
      need(sha(await readFile(join(paths.materials, item.id, name))) === item.materials[name], 'Frozen material hash mismatch');
    }
  }
  return { directory, paths, manifest, manifestSha256, mapping };
}
type Registry = Awaited<ReturnType<typeof openRegistry>>;
function oneCase(registry: Registry, caseId: unknown) {
  const item = registry.manifest.cases.find(row => row.id === caseId);
  need(item, 'Case is outside the frozen registry');
  return item;
}
function oneArm(arm: unknown): Arm {
  need(arm === 'A' || arm === 'B', 'Unknown arm');
  return arm;
}
function provenance(registry: Registry, value: unknown) {
  need(registry.manifest.settings, 'Freeze model and rules snapshots before importing actual results');
  const record = value as RecordData;
  need(record.manifestSha256 === registry.manifestSha256, 'Import does not reference the frozen manifest');
  return registry.manifest.settings;
}
function statusOf(value: unknown): RunStatus {
  need(value === 'completed' || value === 'failed' || value === 'missing', 'Invalid run status');
  return value;
}
function timing(value: RecordData, earliest: string) {
  const status = statusOf(value.status);
  const startedAt = value.startedAt === null ? null : date(value.startedAt, 'start time');
  const finishedAt = value.finishedAt === null ? null : date(value.finishedAt, 'finish time');
  need((startedAt === null) === (finishedAt === null), 'Start and finish must both be known or explicitly null');
  if (startedAt && finishedAt) {
    need(Date.parse(earliest) <= Date.parse(startedAt) && Date.parse(startedAt) <= Date.parse(finishedAt), 'Run predates registration or finish predates start');
  }
  const failure = status === 'completed' ? null : code(value.failure, 'failure code');
  need(status !== 'completed' || (value.failure === null && startedAt && finishedAt), 'Completed run needs actual timing and no failure');
  need(status !== 'missing' || startedAt === null, 'Missing run cannot include execution timing');
  return { status, startedAt, finishedAt, failure };
}
function usage(value: unknown, label: string) {
  need(value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0), `Invalid actual ${label} token count`);
  return value as number | null;
}
async function stage(registry: Registry, value: RecordData, window: ReturnType<typeof timing>) {
  const { status, startedAt, finishedAt, failure } = timing(value, window.startedAt ?? registry.manifest.frozenAt);
  need(status !== 'missing' && startedAt && finishedAt && window.finishedAt && Date.parse(finishedAt) <= Date.parse(window.finishedAt),
    'Stage timing is outside the actual run window');
  const inputTokens = usage(value.inputTokens, 'input');
  const outputTokens = usage(value.outputTokens, 'output');
  const usageEvidence = value.usageEvidence === null ? null : await reference(registry.directory, value.usageEvidence, 'usage evidence');
  need((inputTokens === null && outputTokens === null) || usageEvidence, 'Actual token totals require an evidence reference');
  return { phase: code(value.phase, 'phase'), status, startedAt, finishedAt, failure, inputTokens, outputTokens, usageEvidence };
}
const stageKeys = ['phase', 'status', 'startedAt', 'finishedAt', 'failure', 'inputTokens', 'outputTokens', 'usageEvidence'];

function implementation(registry: Registry, arm: Arm) {
  return arm === 'A' ? baseline : registry.manifest.settings?.harnessCommit;
}
function armImage(registry: Registry, arm: Arm, image: unknown) {
  const locked = arm === 'B' ? registry.manifest.settings?.harnessImage : undefined;
  need(image === locked, 'Run image differs from the frozen arm');
}

async function creation(registry: Registry, raw: unknown) {
  const data = object(raw, ['manifestSha256', 'caseId', 'arm', 'implementationCommit', 'image', 'materialSha256', 'modelConfigSha256',
    'status', 'startedAt', 'finishedAt', 'failure', 'stages', 'html', 'blindSafe', 'attachments', 'controllerUsage'], 'creation run');
  const frozen = provenance(registry, data);
  const item = oneCase(registry, data.caseId);
  const arm = oneArm(data.arm);
  armImage(registry, arm, data.image);
  need(data.implementationCommit === implementation(registry, arm) && data.materialSha256 === item.materialSha256 &&
    data.modelConfigSha256 === frozen.creationModel.config.sha256, 'Creation does not use the frozen implementation, material or model');
  const window = timing(data, registry.manifest.frozenAt);
  const stages = await Promise.all(list(data.stages, 'creation stages').map(value => stage(registry, object(value, stageKeys, 'creation stage'), window)));
  const html = data.html === null ? null : await reference(registry.directory, data.html, 'exact delivered HTML');
  const attachments = await refs(registry.directory, data.attachments, 'private creation attachments');
  let controllerUsage: ControllerUsage | null = null;
  if (data.controllerUsage !== null) {
    const counters = object(data.controllerUsage, ['turns', 'repairs', 'evidence'], 'controller usage');
    const turns = usage(counters.turns, 'turn');
    const repairs = usage(counters.repairs, 'repair');
    need(arm === 'B' && turns !== null && repairs !== null, 'Harness counters must be actual B controller values');
    controllerUsage = { turns, repairs, evidence: await reference(registry.directory, counters.evidence, 'controller counter evidence') };
  }
  need(typeof data.blindSafe === 'boolean' && (!data.blindSafe || html), 'Blind disclosure needs an exact HTML artifact');
  if (data.blindSafe && html) {
    const source = (await fileBytes(registry.directory, html.path)).toString('utf8');
    need(!/pgc:check|creationSelfCheck|creator[_ -]self[_ -]?check/i.test(source), 'Embedded creator self-check disqualifies this artifact from blind disclosure');
  }
  need(window.status !== 'completed' || (html && stages.length > 0), 'Completed creation needs its actual stages and exact HTML');
  need(window.status !== 'missing' || (!html && stages.length === 0 && !controllerUsage), 'Missing creation cannot include execution artifacts');
  return { ...data, caseId: item.id, arm, ...window, stages, html, attachments, controllerUsage, blindSafe: data.blindSafe } as Creation & { caseId: string; arm: Arm };
}
async function finding(directory: string, raw: unknown, label: string): Promise<Finding> {
  const data = object(raw, ['id', 'observation', 'state', 'evidence'], label);
  const state = data.state;
  need(state === 'verified' || state === 'failed' || state === 'unknown' || state === 'disputed', `Invalid independent judgment for ${label}`);
  const evidence = await refs(directory, data.evidence, label, state === 'verified' || state === 'failed' ? 1 : 0);
  return { id: code(data.id, label), observation: str(data.observation, label), state, evidence };
}
async function findings(directory: string, raw: unknown, label: string) {
  return unique(await Promise.all(list(raw, label).map(value => finding(directory, value, label))), label);
}
function disputes(value: unknown) { return list(value, 'unresolved disputes').map(item => str(item, 'unresolved dispute')); }
function independent(data: RecordData) {
  need(data.independent === true, 'Independent human or Agent adjudication must be attested');
  need(data.observerType === 'human' || data.observerType === 'independent-agent', 'Unknown adjudicator type');
  return code(data.observerId, 'opaque adjudicator ID').toLowerCase();
}
function recordPath(registry: Registry, kind: Kind, key: string) {
  return join(registry.paths.records, `${kind}.${key}.json`);
}
async function load<T>(registry: Registry, kind: Kind, key: string): Promise<T | null> {
  try { return await json(recordPath(registry, kind, key)) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function runKey(caseId: string, arm: Arm) { return `${caseId}.${arm}`; }

async function reviewInput(registry: Registry, raw: unknown) {
  const data = object(raw, ['manifestSha256', 'caseId', 'htmlSha256', 'probe', 'shots', 'evidenceSha256', 'blindSafe',
    'observerId', 'observerType', 'independent', 'catalogExhaustive', 'catalog', 'catalogEvidence', 'disputes'], 'paired review input');
  provenance(registry, data);
  const { id } = oneCase(registry, data.caseId);
  const selected = await load<Creation>(registry, 'creation', runKey(id, 'B'));
  need(selected?.status === 'completed' && selected.html && selected.html.sha256 === data.htmlSha256 && selected.blindSafe,
    'Paired review requires the exact blind-safe completed B HTML; no substitute');
  const html = await reference(registry.directory, selected.html, 'selected review HTML');
  const probe = await reference(registry.directory, data.probe, 'locked basic probe');
  await readBasicProbe(registry.directory, probe);
  const shots = await Promise.all(list(data.shots, 'locked viewport screenshots').map(value => reference(registry.directory, value, 'locked viewport screenshot')));
  need(shots.length === 4 && data.blindSafe === true, 'Paired basic review requires four blind-safe original viewport screenshots');
  for (const shot of shots) imageExtension(await fileBytes(registry.directory, shot.path));
  const evidenceSha256 = sha(jsonBytes({ html: html.sha256, probe: probe.sha256, shots: shots.map(shot => shot.sha256) }));
  need(data.evidenceSha256 === evidenceSha256, 'Review evidence bundle SHA-256 mismatch');
  const observerId = independent(data);
  need(data.catalogExhaustive === true, 'Lock the independent critical-issue catalog before reviewing predictions');
  const catalogEvidence = await refs(registry.directory, data.catalogEvidence, 'critical catalog coverage evidence', 1);
  const catalog = unique(await Promise.all(list(data.catalog, 'critical catalog').map(async rawCritical => {
    const critical = object(rawCritical, ['id', 'observation', 'evidence'], 'critical issue');
    return { id: code(critical.id, 'critical issue'), observation: str(critical.observation, 'critical observation'),
      evidence: await refs(registry.directory, critical.evidence, 'critical issue evidence', 1) };
  })), 'critical issue');
  const lockedAt = new Date().toISOString();
  need(Date.parse(selected.finishedAt!) <= Date.parse(lockedAt), 'Review input cannot be locked before the selected creation finishes');
  return { ...data, caseId: id, observerId, lockedAt, html, probe, shots, evidenceSha256, catalog, catalogEvidence, disputes: disputes(data.disputes) };
}

async function review(registry: Registry, raw: unknown) {
  const data = object(raw, ['manifestSha256', 'caseId', 'arm', 'implementationCommit', 'image', 'status', 'startedAt', 'finishedAt',
    'failure', 'initial', 'verify', 'initialReport', 'finalReport', 'blindSafe', 'attachments'], 'review run');
  const frozen = provenance(registry, data);
  const { id } = oneCase(registry, data.caseId);
  const arm = oneArm(data.arm);
  armImage(registry, arm, data.image);
  need(data.implementationCommit === implementation(registry, arm), 'Review implementation differs from the frozen arm');
  const input = await load<ReviewInput>(registry, 'review-input', id);
  const window = timing(data, input?.lockedAt ?? registry.manifest.frozenAt);
  need(window.status === 'missing' || input, 'Lock the same exact HTML and evidence for both arms before importing review runs');
  const initialReport = data.initialReport === null ? null : await reference(registry.directory, data.initialReport, 'initial report');
  async function phase(rawPhase: unknown, phaseName: 'initial' | 'verify') {
    if (rawPhase === null) return null;
    const info = object(rawPhase, [...stageKeys, 'htmlSha256', 'evidenceSha256', 'modelConfigSha256', 'rulesSha256', 'calibrationSha256', 'image',
      ...(phaseName === 'verify' ? ['initialReportSha256'] : [])], 'review stage');
    armImage(registry, arm, info.image);
    need(input && info.phase === phaseName && info.htmlSha256 === input.html.sha256 && info.evidenceSha256 === input.evidenceSha256 &&
      info.modelConfigSha256 === frozen.reviewModel.config.sha256 && info.rulesSha256 === frozen.rules.sha256 &&
      info.calibrationSha256 === frozen.calibration.sha256, 'Review stage must use the same locked HTML, evidence, rules, calibration and model');
    need(phaseName !== 'verify' || (initialReport && info.initialReportSha256 === initialReport.sha256),
      'Verify must consume the exact initial report from this run');
    return { ...info, ...await stage(registry, info, window) };
  }
  const initial = await phase(data.initial, 'initial');
  const verify = await phase(data.verify, 'verify');
  const finalReport = data.finalReport === null ? null : await reference(registry.directory, data.finalReport, 'final report');
  need(!verify || (initial?.status === 'completed' && initialReport && Date.parse(verify.startedAt) >= Date.parse(initial.finishedAt)), 'Verify requires a prior completed initial report');
  need((initial?.status === 'completed') === Boolean(initialReport) && (verify?.status === 'completed') === Boolean(finalReport),
    'Report artifacts must match the finished stage');
  need(window.status !== 'completed' || (initialReport && finalReport), 'Completed review needs both actual report stages');
  for (const report of [initialReport, finalReport]) {
    if (!report) continue;
    const content: unknown = JSON.parse((await fileBytes(registry.directory, report.path)).toString('utf8'));
    need(reviewReportErrors(content, { schemaVersion: 2 }).length === 0, 'Finished review stage requires a structurally valid v2 report artifact');
  }
  need(window.status !== 'missing' || (!initial && !verify), 'Missing review cannot include execution stages');
  const attachments = await refs(registry.directory, data.attachments, 'private review attachments');
  need(typeof data.blindSafe === 'boolean' && (!data.blindSafe || finalReport), 'Blind disclosure needs an actual final report');
  return { ...data, caseId: id, arm, ...window, initial, verify, initialReport, finalReport, attachments, blindSafe: data.blindSafe } as Review & { caseId: string; arm: Arm };
}

async function verifyReferences(registry: Registry, data: unknown): Promise<void> {
  if (data === null || typeof data !== 'object') return;
  if (Object.hasOwn(data, 'path') && Object.hasOwn(data, 'sha256')) {
    await reference(registry.directory, data, 'saved record');
    return;
  }
  for (const value of Object.values(data)) await verifyReferences(registry, value);
}
function mappingFor(registry: Registry, id: unknown, kind: RunKind) {
  const mapping = registry.mapping.find(item => item.id === id && item.kind === kind);
  need(mapping, 'Unknown blind packet ID');
  return mapping;
}
function imageExtension(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg';
  throw new Error('Viewport evidence must be original PNG or JPEG bytes');
}
type BasicObservation = { id: string; label: string; capturedAt: string; actionRefs: string[] };
async function readBasicProbe(directory: string, ref: Ref) {
  const bytes = await fileBytes(directory, ref.path);
  need(sha(bytes) === ref.sha256, 'File hash mismatch for the basic Chromium probe');
  const probe = JSON.parse(bytes.toString('utf8')) as
    { captureMethod?: string; observations?: BasicObservation[] } | null;
  need(probe?.captureMethod === 'browser-viewport-v1', 'Use the original basic Chromium capture probe');
  need(Array.isArray(probe.observations) && probe.observations.length === 4 && probe.observations.every((shot, index) =>
    shot?.id === `baseline-${index + 1}` && typeof shot.label === 'string' && shot.label.trim() &&
    typeof shot.capturedAt === 'string' && Number.isFinite(Date.parse(shot.capturedAt)) &&
    Array.isArray(shot.actionRefs) && shot.actionRefs.every(ref => typeof ref === 'string')),
  'Basic Chromium probe must identify all four original viewport screenshots in order');
  return { ...probe, observations: probe.observations };
}
/** Local research Runner injection. Material integrity is checked before either arm sees it. */
export async function lockedReviewCapture(directory: string, caseId: string) {
  const registry = await openRegistry(directory);
  const item = oneCase(registry, caseId);
  const input = await load<ReviewInput>(registry, 'review-input', item.id);
  need(input, 'Lock the review input before replay');
  const selected = await load<Creation>(registry, 'creation', runKey(item.id, 'B'));
  need(selected?.status === 'completed' && selected.blindSafe && selected.html?.sha256 === input.html.sha256,
    'Paired review requires the exact blind-safe completed B HTML; no substitute');
  await reference(directory, input.html, 'locked review HTML');
  const probe = await readBasicProbe(directory, input.probe);
  need(input.shots.length === 4 && input.evidenceSha256 === sha(jsonBytes({
    html: input.html.sha256, probe: input.probe.sha256, shots: input.shots.map(shot => shot.sha256),
  })), 'Review evidence bundle SHA-256 mismatch');
  const shots = await Promise.all(input.shots.map(async (shot, index) => {
    const bytes = await fileBytes(directory, shot.path);
    need(sha(bytes) === shot.sha256, 'File hash mismatch for replayed viewport screenshot');
    const type = imageExtension(bytes) === 'jpg' ? 'jpeg' : 'png';
    const { id, label, capturedAt, actionRefs } = probe.observations[index];
    return { id, label, capturedAt, actionRefs, source: 'isolated-chromium', data: `data:image/${type};base64,${bytes.toString('base64')}` };
  }));
  return async (html: string) => {
    need(sha(html) === input.html.sha256, 'Runner HTML differs from the locked review input');
    return structuredClone({ probe, shots });
  };
}
type BlindPacket = { packetId: string; files: Record<string, string> };
export async function packet(directory: string, kind: RunKind, caseId: string, arm: Arm) {
  const registry = await openRegistry(directory);
  const item = oneCase(registry, caseId);
  const row = registry.mapping.find(entry => entry.kind === kind && entry.caseId === caseId && entry.arm === arm)!;
  const key = runKey(item.id, arm);
  const files = new Map<string, Buffer>();
  async function add(name: string, file: Ref) {
    await reference(directory, file, name);
    files.set(name, await fileBytes(directory, file.path));
  }
  if (kind === 'creation') {
    const run = await load<Creation>(registry, kind, key);
    need(run?.status === 'completed' && run.html && run.blindSafe, 'Completed blind-safe creation required');
    await add('game.html', run.html);
    for (const name of materialNames) files.set(name, await readFile(join(registry.paths.materials, item.id, name)));
    files.set('checklist.json', Buffer.from(jsonBytes(item.checklist)));
  } else {
    const run = await load<Review>(registry, kind, key);
    const input = await load<ReviewInput>(registry, 'review-input', item.id);
    need(run?.status === 'completed' && run.finalReport && run.blindSafe && input, 'Completed blind-safe review and locked input required');
    await add('game.html', input.html);
    await add('report.json', run.finalReport);
    await add('probe.json', input.probe);
    for (const [index, shot] of input.shots.entries()) {
      const extension = imageExtension(await fileBytes(directory, shot.path));
      await add(`viewport-${index + 1}.${extension}`, shot);
    }
    const catalog = [];
    for (const [issueIndex, issue] of input.catalog.entries()) {
      const evidence: string[] = [];
      for (const [index, ref] of issue.evidence.entries()) {
        const extension = /\.(png|jpe?g|txt|json)$/i.exec(ref.path)?.[1].toLowerCase();
        need(extension, 'Blind catalog evidence must be PNG, JPEG, text or JSON');
        const name = `catalog-${issueIndex + 1}-${index + 1}.${extension}`;
        await add(name, ref);
        evidence.push(name);
      }
      catalog.push({ id: issue.id, observation: issue.observation, evidence });
    }
    files.set('critical-catalog.json', Buffer.from(jsonBytes(catalog)));
  }
  const manifest: BlindPacket = { packetId: row.id, files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha(bytes)])) };
  const path = join(registry.paths.blind, row.id);
  await mkdir(path, { mode: 0o700 });
  for (const [name, bytes] of files) await writeFile(join(path, name), bytes, { mode: 0o600, flag: 'wx' });
  await store(join(path, 'packet.json'), manifest);
  return { packetId: row.id, packetSha256: sha(jsonBytes(manifest)) };
}
async function validatePacket(registry: Registry, id: string, expected: unknown) {
  const directory = join(registry.paths.blind, id);
  const bytes = await readFile(join(directory, 'packet.json'));
  need(sha(bytes) === expected, 'Judgment must refer to the disclosed blind packet SHA-256');
  const manifest = JSON.parse(bytes.toString('utf8')) as BlindPacket;
  const names = Object.keys(manifest.files);
  const actualNames = await readdir(directory);
  need(manifest.packetId === id && actualNames.length === names.length + 1, 'Unexpected blind packet contents');
  for (const name of names) {
    need(/^[a-z0-9.-]+$/.test(name) && name !== '.' && name !== '..', 'Invalid blind packet entry');
    const file = join(directory, name);
    need((await lstat(file)).isFile() && sha(await readFile(file)) === manifest.files[name], 'Blind packet contents changed after disclosure');
  }
  return manifest;
}
const judgmentKeys = ['manifestSha256', 'packetId', 'packetSha256', 'observerId', 'observerType', 'independent', 'blind',
  'coverageComplete', 'coverageEvidence', 'disputes'];
async function judgment(registry: Registry, raw: unknown, kind: RunKind) {
  const fields = kind === 'creation' ? ['checks', 'criticalDefects', 'unapprovedCoreChanges'] : ['mandatoryRemediations', 'criticalHits'];
  const data = object(raw, [...judgmentKeys, ...fields], 'independent judgment');
  provenance(registry, data);
  const observerId = independent(data);
  need(data.blind === true && data.coverageComplete === true, 'Independent blinded judgment and complete coverage must be attested');
  const row = mappingFor(registry, data.packetId, kind);
  const manifest = await validatePacket(registry, row.id, data.packetSha256);
  const coverageEvidence = await refs(registry.directory, data.coverageEvidence, 'judgment coverage evidence', 1);
  const common = { ...data, observerId, coverageEvidence, disputes: disputes(data.disputes) };
  const key = runKey(row.caseId, row.arm);
  if (kind === 'creation') {
    const run = await load<Creation>(registry, kind, key);
    need(run?.html?.sha256 === manifest.files['game.html'], 'Judged HTML differs from the imported run');
    const checks = await findings(registry.directory, data.checks, 'preregistered requirement');
    const registered = oneCase(registry, row.caseId).checklist.map(check => check.id);
    need(checks.length === registered.length && checks.every(check => registered.includes(check.id)), 'Include one judgment for every preregistered requirement');
    return { key: row.id, caseId: row.caseId, observerId, value: { ...common, checks,
      criticalDefects: await findings(registry.directory, data.criticalDefects, 'critical defect'),
      unapprovedCoreChanges: await findings(registry.directory, data.unapprovedCoreChanges, 'unapproved core change') } };
  }
  const run = await load<Review>(registry, kind, key);
  const input = await load<ReviewInput>(registry, 'review-input', row.caseId);
  need(input && run?.finalReport?.sha256 === manifest.files['report.json'] && input.html.sha256 === manifest.files['game.html'],
    'Judged report or HTML differs from the locked pair');
  const criticalHits = await findings(registry.directory, data.criticalHits, 'critical hit');
  need(criticalHits.length === input.catalog.length && criticalHits.every(hit => input.catalog.some(issue => issue.id === hit.id)),
    'Include a hit or miss for every independently confirmed critical issue');
  return { key: row.id, caseId: row.caseId, observerId, value: { ...common, criticalHits,
    mandatoryRemediations: await findings(registry.directory, data.mandatoryRemediations, 'mandatory remediation') } };
}
async function prerequisite(registry: Registry, raw: unknown) {
  const data = object(raw, ['manifestSha256', 'name', 'confirmed', 'observerId', 'confirmedAt', 'evidence'], 'prerequisite');
  provenance(registry, data);
  need(data.name === 'rightsConfirmed' || data.name === 'providerCompatibilityVerified', 'Unknown prerequisite');
  need(data.confirmed === true && Date.parse(date(data.confirmedAt, 'confirmation time')) >= Date.parse(registry.manifest.frozenAt),
    'Prerequisite must be explicitly confirmed with dated evidence');
  code(data.observerId, 'opaque confirmer ID');
  const evidence = await refs(registry.directory, data.evidence, 'prerequisite evidence', 1);
  return { key: data.name, value: { ...data, evidence } };
}
export async function importRecord(directory: string, kind: Kind, value: unknown) {
  const registry = await openRegistry(directory);
  let record: { key: string; value: unknown };
  let observer: { caseId: string; observerId: string } | undefined;
  if (kind === 'creation' || kind === 'review') {
    const run = await (kind === 'creation' ? creation(registry, value) : review(registry, value));
    record = { key: runKey(run.caseId, run.arm), value: run };
  } else if (kind === 'review-input') {
    const input = await reviewInput(registry, value);
    record = { key: input.caseId, value: input };
    observer = input;
  } else if (kind === 'prerequisite') {
    record = await prerequisite(registry, value);
  } else {
    const judged = await judgment(registry, value, kind === 'creation-judgment' ? 'creation' : 'review');
    record = judged;
    observer = judged;
  }
  const slot = recordPath(registry, kind, record.key);
  if (observer) {
    const claim = join(registry.paths.records, `observer.${observer.caseId}.${observer.observerId}.json`);
    try { await store(claim, { kind, slot: record.key }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Use a different independent observer for each packet and the critical catalog of this case');
      throw error;
    }
    try { await store(slot, record.value); }
    catch (error) { await unlink(claim); throw error; }
  } else {
    await store(slot, record.value);
  }
  return record.key;
}
const emptyRun = { status: 'missing', startedAt: null, finishedAt: null, failure: 'record-not-imported' } as const;
function coverage<T extends Finding>(judgments: T[]) {
  return {
    denominator: judgments.length,
    verified: judgments.filter(finding => finding.state === 'verified').length,
    failed: judgments.filter(finding => finding.state === 'failed').length,
    unresolved: judgments.filter(finding => finding.state === 'unknown' || finding.state === 'disputed').length,
  };
}
function elapsedMs(run: typeof emptyRun | Creation | Review) {
  return run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
}
function budget(run: typeof emptyRun | Creation) {
  if (run.status !== 'completed' || !('stages' in run)) return null;
  const duration = elapsedMs(run);
  const outputs = run.stages.map(stage => stage.outputTokens);
  if (duration === null || !run.controllerUsage || outputs.some(value => value === null)) return null;
  const { turns, repairs } = run.controllerUsage;
  return duration <= 2_400_000 && turns > 0 && turns <= 24 && turns <= run.stages.length && repairs <= 2 &&
    outputs.every(value => value! <= 64_000) && outputs.reduce<number>((sum, value) => sum + value!, 0) <= 256_000;
}
type RunSummary = {
  arm: Arm;
  creation: Creation | typeof emptyRun; creationElapsedMs: number | null; withinHarnessBudget: boolean | null;
  review: Review | typeof emptyRun; reviewElapsedMs: number | null;
  creationJudgment: (CreationJudgment & { packetSha256: string }) | null;
  reviewJudgment: (ReviewJudgment & { packetSha256: string }) | null;
};
export async function report(directory: string) {
  const registry = await openRegistry(directory);
  const rows: { caseId: string; reviewInput: ReviewInput | null; runs: RunSummary[] }[] = [];
  for (const item of registry.manifest.cases) {
    const input = await load<ReviewInput>(registry, 'review-input', item.id);
    const runs = await Promise.all(arms.map(async arm => {
      const key = runKey(item.id, arm);
      const savedCreation = await load<Creation>(registry, 'creation', key);
      const savedReview = await load<Review>(registry, 'review', key);
      if (savedCreation) armImage(registry, arm, savedCreation.image);
      if (savedReview) armImage(registry, arm, savedReview.image);
      for (const stage of [savedReview?.initial, savedReview?.verify]) {
        if (stage) armImage(registry, arm, stage.image);
      }
      const created = savedCreation ?? emptyRun;
      const reviewed = savedReview ?? emptyRun;
      const createId = registry.mapping.find(row => row.caseId === item.id && row.arm === arm && row.kind === 'creation')!.id;
      const reviewId = registry.mapping.find(row => row.caseId === item.id && row.arm === arm && row.kind === 'review')!.id;
      const creationJudgment = await load<CreationJudgment & { packetSha256: string }>(registry, 'creation-judgment', createId);
      const reviewJudgment = await load<ReviewJudgment & { packetSha256: string }>(registry, 'review-judgment', reviewId);
      if (creationJudgment) await validatePacket(registry, createId, creationJudgment.packetSha256);
      if (reviewJudgment) await validatePacket(registry, reviewId, reviewJudgment.packetSha256);
      return { arm, creation: created, creationElapsedMs: elapsedMs(created), withinHarnessBudget: arm === 'B' ? budget(created) : null,
        review: reviewed, reviewElapsedMs: elapsedMs(reviewed), creationJudgment, reviewJudgment };
    }));
    const observers = [input?.observerId, ...runs.flatMap(run => [run.creationJudgment?.observerId, run.reviewJudgment?.observerId])]
      .filter((id): id is string => typeof id === 'string').map(id => id.toLowerCase());
    need(new Set(observers).size === observers.length, 'Saved same-case evidence reuses an independent observer');
    rows.push({ caseId: item.id, reviewInput: input, runs });
  }
  const rights = await load(registry, 'prerequisite', 'rightsConfirmed');
  const provider = await load(registry, 'prerequisite', 'providerCompatibilityVerified');
  await verifyReferences(registry, { rows, rights, provider });

  const byArm = arms.map(arm => {
    const runs = rows.map(row => row.runs.find(run => run.arm === arm)!);
    const stateCounts = (kind: RunKind) => ({
      denominator: cases.length,
      completed: runs.filter(run => run[kind].status === 'completed').length,
      failed: runs.filter(run => run[kind].status === 'failed').length,
      missing: runs.filter(run => run[kind].status === 'missing').length,
    });
    const checkCoverage = (metric: Checklist['metric']) => {
      const required = registry.manifest.cases.flatMap(item => item.checklist.filter(check => check.metric === metric));
      const judgments = runs.flatMap((run, index) => {
        const ids = registry.manifest.cases[index].checklist.filter(check => check.metric === metric).map(check => check.id);
        return run.creationJudgment?.checks.filter(check => ids.includes(check.id)) ?? [];
      });
      return { ...coverage(judgments), denominator: required.length, missing: required.length - judgments.length };
    };
    const criticalDefects = coverage(runs.flatMap(run => run.creationJudgment?.criticalDefects ?? []));
    const coreChanges = coverage(runs.flatMap(run => run.creationJudgment?.unapprovedCoreChanges ?? []));
    const mandatory = coverage(runs.flatMap(run => run.reviewJudgment?.mandatoryRemediations ?? []));
    const criticalHits = coverage(runs.flatMap(run => run.reviewJudgment?.criticalHits ?? []));
    const catalogDenominator = rows.reduce((count, row) => count + (row.reviewInput?.catalog.length ?? 0), 0);
    return { arm, creation: stateCounts('creation'), review: stateCounts('review'),
      adjudicatedCreations: runs.filter(run => run.creationJudgment).length, adjudicatedReviews: runs.filter(run => run.reviewJudgment).length,
      core: checkCoverage('core'), metrics: Object.fromEntries(metrics.map(metric => [metric, checkCoverage(metric)])),
      criticalDefects, coreChanges, mandatory, criticalHits: { ...criticalHits, denominator: catalogDenominator, missing: catalogDenominator - criticalHits.denominator } };
  });
  const [a, b] = byArm;
  const unresolved = rows.some(row => row.reviewInput?.disputes.length || row.runs.some(run => {
    const creation = run.creationJudgment;
    const review = run.reviewJudgment;
    return creation?.disputes.length || review?.disputes.length ||
      [...(creation?.checks ?? []), ...(creation?.criticalDefects ?? []), ...(creation?.unapprovedCoreChanges ?? []),
        ...(review?.mandatoryRemediations ?? []), ...(review?.criticalHits ?? [])]
        .some(finding => finding.state === 'unknown' || finding.state === 'disputed');
  }));
  const compared = Boolean(registry.manifest.settings) && !unresolved && rows.every(row => row.reviewInput) &&
    byArm.every(arm => arm.adjudicatedCreations === cases.length && arm.adjudicatedReviews === cases.length);
  const controlCeiling = compared ? metrics.every(metric => a.metrics[metric].verified === a.metrics[metric].denominator) : null;
  const improved = compared ? metrics.filter(metric => b.metrics[metric].verified > a.metrics[metric].verified) : [];
  const check = {
    completeIndependentComparisons: compared,
    sixFullCreationB: b.creation.completed === cases.length,
    knownHarnessBudget: rows.every(row => row.runs[1].withinHarnessBudget !== null),
    withinHarnessBudget: rows.every(row => row.runs[1].withinHarnessBudget === true),
    allBCoreRequirementsVerified: b.core.verified === b.core.denominator,
    criticalDefectsNoWorse: compared && b.criticalDefects.verified <= a.criticalDefects.verified,
    unapprovedCoreChangesNoWorse: compared && b.coreChanges.verified <= a.coreChanges.verified,
    improvedAtLeastOneQualityMetric: controlCeiling === false && improved.length > 0,
    otherQualityMetricsNoWorse: compared && metrics.every(metric => b.metrics[metric].verified >= a.metrics[metric].verified),
    unsupportedMandatoryNoWorse: compared && b.mandatory.failed <= a.mandatory.failed,
    confirmedCriticalHitsNoWorse: compared && b.criticalHits.verified >= a.criticalHits.verified,
  };
  const prereqs = { rightsConfirmed: Boolean(rights), providerCompatibilityVerified: Boolean(provider) };
  const quality = !compared || !check.knownHarnessBudget ? 'not-ready' : Object.values(check).every(Boolean) ? 'passed' : 'failed';
  return { manifestSha256: registry.manifestSha256, cases: rows, arms: byArm,
    registration: { settingsFrozen: Boolean(registry.manifest.settings), materialIndexSha256: registry.manifest.materialIndexSha256 ?? null },
    registered: { creationRuns: 12, reviewPairs: 6, reviewRuns: 12 }, prerequisites: prereqs,
    prerequisiteEvidence: { rights, provider }, controlCeiling, improvedQualityMetrics: improved, checks: check, quality,
    releaseReady: quality === 'passed' && Object.values(prereqs).every(Boolean), modelCalls: 0,
    interpretation: 'This compares two configured workflows with different budgets. It does not isolate a harness effect or estimate production review accuracy.' };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true, options: { out: { type: 'string' }, settings: { type: 'string' }, 'comparison-index': { type: 'string' }, input: { type: 'string' }, save: { type: 'string' } },
  });
  const [command, argument, caseId, arm] = positionals;
  const parent = join(root, 'artifacts');
  await mkdir(parent, { mode: 0o700, recursive: true });
  need(await realpath(parent) === parent, 'Private artifacts directory must not be a symbolic link');
  const directory = resolve(root, values.out ?? 'artifacts/ccb-harness-evaluation');
  need(dirname(directory) === parent, 'Use a private run directory directly below artifacts/');
  await mkdir(directory, { mode: 0o700, recursive: true });
  need(await realpath(directory) === directory, 'Private run directory must not be a symbolic link');
  if (command === 'prepare') {
    await mkdir(join(directory, 'inputs'), { mode: 0o700, recursive: true });
    process.stdout.write(jsonBytes({ manifestSha256: await prepare(directory, values.settings, values['comparison-index']), modelCalls: 0 }));
  } else if (command === 'import' && recordKinds.includes(argument as Kind) && values.input) {
    await importRecord(directory, argument as Kind, await json(values.input));
    process.stdout.write(jsonBytes({ imported: argument, modelCalls: 0 }));
  } else if (command === 'packet' && runKinds.includes(argument as RunKind) && caseId) {
    process.stdout.write(jsonBytes(await packet(directory, argument as RunKind, caseId, oneArm(arm))));
  } else if (command === 'report') {
    const result = await report(directory);
    const name = code(values.save ?? 'evaluation.json', 'report file name');
    need(name.endsWith('.json'), 'Report filename must end in .json');
    await store(join(directory, name), result);
    process.stdout.write(jsonBytes({ output: join(directory, name), ...result.registration, quality: result.quality, releaseReady: result.releaseReady, modelCalls: 0 }));
  } else {
    throw new Error('Use prepare, import, packet or report. See docs/ccb-harness-evaluation.md.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Evaluation command failed'}\n`);
    process.exitCode = 1;
  });
}
