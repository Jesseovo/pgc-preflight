/** Private DO archive for completed comparison reports. */
import { canonicalHarness, harnessHash } from './harness-policy';

const runnerPrefix = 'runner:';
const archivePrefix = 'comparison:review-archive:';
export const comparisonBoundTaskKey = 'comparison:bound-task';
const partLength = 30_000;
const partLimit = 64;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const stages = ['review', 'review_verify'] as const;
type Stage = typeof stages[number];
type Report = Record<string, unknown>;
type Receipt = { taskId: string; stage: Stage; materialRef: string; sealedAt: number; reportSha256: string };
export type ComparisonArchivedReview = Receipt & { sealSha256: string; report: Report };
type ArchiveHeader = Receipt & { sealSha256: string; parts: number };

type StorageAccess = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; limit: number }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
};
type Storage = StorageAccess & { transaction<T>(operation: (tx: StorageAccess) => Promise<T>): Promise<T> };
const stageForPhase = (phase: unknown): Stage | undefined =>
  phase === 'draft-ready' ? 'review' : phase === 'final-ready' ? 'review_verify' : undefined;

const invalidArchive = () => new Error('Comparison review archive is incomplete or invalid');
function need(value: unknown): asserts value { if (!value) throw invalidArchive(); }
function object(value: unknown): value is Report {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function parseArchive(text: string): unknown {
  try { return JSON.parse(text); } catch { throw invalidArchive(); }
}

async function readParts(storage: StorageAccess, prefix: string, count: unknown) {
  need(typeof count === 'number' && Number.isSafeInteger(count) && count >= 1 && count <= partLimit);
  const parts: string[] = [];
  for (let index = 0; index < count; index++) {
    const part = await storage.get<string>(prefix + ':' + index);
    need(typeof part === 'string' && part.length > 0 && part.length <= partLength);
    parts.push(part);
  }
  return parts.join('');
}

async function readStage(storage: StorageAccess, taskId: string, stage: Stage): Promise<ComparisonArchivedReview | undefined> {
  const key = archivePrefix + stage;
  const header = await storage.get<ArchiveHeader>(key);
  if (header === undefined) return;
  need(object(header) && Object.keys(header).length === 7);
  const { taskId: savedTaskId, stage: savedStage, materialRef, sealedAt, reportSha256, sealSha256, parts } = header;
  need(savedTaskId === taskId && savedStage === stage && typeof materialRef === 'string' && uuid.test(materialRef) &&
    Number.isSafeInteger(sealedAt) && sealedAt > 0 && typeof reportSha256 === 'string' && sha.test(reportSha256));
  const receipt: Receipt = { taskId, stage, materialRef, sealedAt, reportSha256 };
  need(sealSha256 === await harnessHash(canonicalHarness(receipt)));
  const text = await readParts(storage, key, parts);
  need(await harnessHash(text) === reportSha256);
  const report = parseArchive(text);
  need(object(report));
  return { ...receipt, sealSha256, report };
}

async function checkpointReport(storage: StorageAccess, stage: Stage) {
  need(await storage.get(runnerPrefix + 'cloudCheckpointVersion') === 2);
  const prefix = runnerPrefix + 'cloudState';
  const state = parseArchive(await readParts(storage, prefix, await storage.get(prefix + 'Parts')));
  const field = stage === 'review' ? 'draft' : 'result';
  need(object(state) && Object.keys(state).length === 3 && state.version === 2 &&
    typeof state.materialRef === 'string' && uuid.test(state.materialRef) && object(state[field]));
  const text = JSON.stringify(state[field]);
  return { text, materialRef: state.materialRef, reportSha256: await harnessHash(text) };
}

async function archiveCheckpoint(storage: StorageAccess, stage: Stage, now: () => number) {
  const taskId = await storage.get<string>(comparisonBoundTaskKey);
  need(typeof taskId === 'string' && uuid.test(taskId));
  const { text, materialRef, reportSha256 } = await checkpointReport(storage, stage);
  const existing = await readStage(storage, taskId, stage);
  if (existing) {
    need(existing.materialRef === materialRef && existing.reportSha256 === reportSha256);
    return;
  }
  const sealedAt = now();
  need(Number.isSafeInteger(sealedAt) && sealedAt > 0);
  if (stage === 'review_verify') {
    const draft = await readStage(storage, taskId, 'review');
    need(draft && draft.materialRef === materialRef && draft.sealedAt <= sealedAt);
  }
  const receipt: Receipt = { taskId, stage, materialRef, sealedAt, reportSha256 };
  const key = archivePrefix + stage;
  const parts = Math.ceil(text.length / partLength);
  need(parts > 0 && parts <= partLimit);
  for (let index = 0; index < parts; index++) {
    await storage.put(key + ':' + index, text.slice(index * partLength, (index + 1) * partLength));
  }
  const header: ArchiveHeader = { ...receipt, sealSha256: await harnessHash(canonicalHarness(receipt)), parts };
  await storage.put(key, header);
}

export async function readComparisonReviewArchive(storage: Storage, taskId: string) {
  return storage.transaction(async tx => {
    need(await tx.get(comparisonBoundTaskKey) === taskId);
    const [draft, final] = await Promise.all(stages.map(stage => readStage(tx, taskId, stage)));
    need(!final || draft && draft.materialRef === final.materialRef && draft.sealedAt <= final.sealedAt);
    return [draft, final].filter((value): value is ComparisonArchivedReview => value !== undefined);
  });
}

export async function verifyComparisonReviewCheckpoint(storage: Storage, taskId: string) {
  await storage.transaction(async tx => {
    const stage = stageForPhase(await tx.get(runnerPrefix + 'cloudPhase'));
    if (!stage) return;
    const saved = await readStage(tx, taskId, stage);
    const current = await checkpointReport(tx, stage);
    need(saved && saved.materialRef === current.materialRef && saved.reportSha256 === current.reportSha256);
    if (stage === 'review_verify') {
      const draft = await readStage(tx, taskId, 'review');
      need(draft && draft.materialRef === saved.materialRef && draft.sealedAt <= saved.sealedAt);
    }
  });
}

function scopedStorage(storage: StorageAccess) {
  return {
    get<T>(key: string) { return storage.get<T>(runnerPrefix + key); },
    put(key: string, value: unknown) { return storage.put(runnerPrefix + key, value); },
    delete(key: string) { return storage.delete(runnerPrefix + key); },
    async deleteAll() {
      for (;;) {
        const items = await storage.list({ prefix: runnerPrefix, limit: 128 });
        if (items.size === 0) return;
        await storage.delete([...items.keys()]);
      }
    },
    getAlarm() { return storage.getAlarm(); },
    setAlarm(at: number | Date) { return storage.setAlarm(at); },
    deleteAlarm() { return storage.deleteAlarm(); },
  };
}

/** Capture the report inside the original checkpoint transaction before its phase can advance. */
export function comparisonRunnerState(storage: Storage, now = Date.now) {
  return { storage: {
    ...scopedStorage(storage),
    transaction<T>(operation: (tx: ReturnType<typeof scopedStorage>) => Promise<T>) {
      return storage.transaction(async raw => {
        const tx = scopedStorage(raw);
        let sealedStage: Stage | undefined;
        const result = await operation({ ...tx, put(key, value) {
          if (key === 'cloudPhase') sealedStage = stageForPhase(value);
          return tx.put(key, value);
        } });
        if (sealedStage) await archiveCheckpoint(raw, sealedStage, now);
        return result;
      });
    },
  } };
}
