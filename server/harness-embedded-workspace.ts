import { cleanGameHtml } from '../harness/game-html.mjs';
import { PLAY_LIMITS, validateHarnessPlayRound, type PlayAction } from '../src/review-play-actions';
import { canonicalHarness, harnessHash } from './harness-policy';
import type { HarnessBrowserEvidence, HarnessTools } from './harness-tools';

export type EmbeddedWorkspaceFile = { path: string; encoding: 'utf8' | 'base64'; content: string; sha256: string };
export type EmbeddedWorkspaceImage = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type EmbeddedWorkspaceResult = {
  content: ({ type: 'text'; text: string } | EmbeddedWorkspaceImage)[];
  is_error?: true;
};
type Store = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
  delete?(key: string): Promise<unknown>;
};
export type EmbeddedWorkspaceStorage = Store & { transaction<T>(operation: (tx: Store) => Promise<T>): Promise<T> };
type Browser = Pick<HarnessTools, 'execute' | 'readResults' | 'close'>;
type Arguments = Record<string, unknown>;
type Artifact = EmbeddedWorkspaceFile & { encoding: 'utf8' };
type ArtifactIndex = Pick<Artifact, 'path' | 'sha256'> & { utf8Bytes: number; utf16Length: number; parts: number };
type Prepared = { path: 'game.html'; beforeSha256: string; afterSha256: string };
type BrowserCall = { requestSha256: string; inputHash: string; preparation?: Prepared; archivePending?: true };
type WriteCall = { requestSha256: string; path: string; sha256: string; status: 'pending' | 'done' };
const mutationQueues = new WeakMap<EmbeddedWorkspaceStorage, Map<string, Promise<unknown>>>();

const fileBytes = 2 * 1024 * 1024;
const inputBytes = 12 * 1024 * 1024;
const imageCharacters = 3 * 1024 * 1024;
const readChunkUtf16 = 20_000;
const storageChunkUtf16 = 24_000;
const pathPattern = /^(?:input\/)?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const mediaTypes: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
});
const imageUrl = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
const encoder = new TextEncoder();
const string = { type: 'string' };
const shaSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const remoteTools = new Set<string>(['capture', 'play-start', 'play-act', 'play-finish', 'play-close']);
const objectSchema = (properties: Arguments, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, properties: Arguments = {}, required: string[] = [], readOnly = false) => ({
  name, description, inputSchema: objectSchema(properties, required), readOnly,
});
const touchPoint = {
  x: { type: 'number', minimum: 0, exclusiveMaximum: 360 },
  y: { type: 'number', minimum: 0, exclusiveMaximum: 780 },
};
const milliseconds = { type: 'integer', minimum: 0, maximum: 30_000 };
const actionSchema = (types: PlayAction['type'][], properties: Arguments, required: string[]) =>
  objectSchema({ type: { enum: types }, ...properties }, ['type', ...required]);
const playRoundSchema = objectSchema({
  hypothesis: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
  actions: {
    type: 'array', minItems: 1, maxItems: PLAY_LIMITS.actions,
    items: { oneOf: [
      actionSchema(['tap', 'hold'], { ...touchPoint, durationMs: milliseconds }, ['x', 'y']),
      actionSchema(['drag'], { ...touchPoint, toX: touchPoint.x, toY: touchPoint.y, durationMs: milliseconds }, ['x', 'y', 'toX', 'toY']),
      actionSchema(['drag'], { path: {
        type: 'array', minItems: 2, maxItems: 32,
        description: 'First atMs must be 0. Later times must strictly increase. Each capture: true uses one additional screenshot.',
        items: objectSchema({ ...touchPoint, atMs: milliseconds, capture: { type: 'boolean' } }, ['x', 'y', 'atMs']),
      } }, ['path']),
      actionSchema(['multi-touch'], { points: {
        type: 'array', minItems: 2, maxItems: 5, items: objectSchema(touchPoint, ['x', 'y']),
      }, durationMs: milliseconds }, ['points']),
      actionSchema(['wait', 'restart'], { durationMs: milliseconds }, []),
    ] },
  },
}, ['hypothesis', 'actions']);
const definitions = [
  tool('list', 'List task files, lengths, SHA-256 values, text read chunk size, and writable output paths.', {}, [], true),
  tool('read', 'Read text by zero-based UTF-16 offset. Use nextOffset or parallel multiples of the listed read chunk size. Read the complete input/materials.json. Images are supplied separately.',
    { path: string, offset: { type: 'integer', minimum: 0 } }, ['path'], true),
  tool('write', 'Write a complete UTF-8 artifact. Use expectedSha256 null only for a new file. For an existing file, copy its current SHA-256 from list/read or the prior write result.',
    { path: string, content: string, expectedSha256: { anyOf: [shaSchema, { type: 'null' }] } }, ['path', 'content', 'expectedSha256']),
  tool('patch', 'Replace one exact, unique UTF-8 string in an existing artifact. Copy expectedSha256 from the current file.',
    { path: string, oldText: string, newText: string, expectedSha256: shaSchema }, ['path', 'oldText', 'newText', 'expectedSha256']),
  tool('capture', 'Prepare game.html and capture its exact prepared version in an isolated mobile browser. Inspect the returned original viewport images.'),
  tool('play-start', 'Prepare game.html and start an isolated mobile play session on the exact prepared version. Returns the first original viewport image.'),
  tool('play-act', 'Perform one bounded round in the original play session. Use 360×780 viewport coordinates and durationMs for milliseconds. Choose either a drag path or the start and end coordinates. All rounds share the remaining play and screenshot limits.',
    { sessionId: string, round: playRoundSchema }, ['sessionId', 'round']),
  tool('play-finish', 'Finish the original session and lock its evidence.', { sessionId: string }, ['sessionId']),
  tool('play-close', 'Close the original isolated play session.', { sessionId: string }, ['sessionId']),
];

class WorkspaceError extends Error {}
class WorkspaceInputError extends Error {}
export class EmbeddedWorkspaceArtifactPersistenceError extends Error {
  constructor() { super('Workspace artifact archive is unconfirmed.'); }
}
function requireWorkspace(value: unknown, message: string): asserts value {
  if (!value) throw new WorkspaceError(message);
}
function requireInput(value: unknown, message: string): asserts value {
  if (!value) throw new WorkspaceInputError(message);
}
const object = (value: unknown): value is Arguments => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Arguments, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = (value: unknown): value is string => typeof value === 'string' && hashPattern.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && identifier.test(value);
const textResult = (value: unknown): EmbeddedWorkspaceResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function base64Bytes(content: string) {
  requireWorkspace(/^(?:[A-Za-z0-9+/]+={0,2})?$/.test(content), 'Invalid base64 file.');
  let binary: string;
  try { binary = atob(content); } catch { throw new WorkspaceError('Invalid base64 file.'); }
  requireWorkspace(btoa(binary) === content, 'Invalid base64 file.');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
const nativeImage = (media_type: string, data: string): EmbeddedWorkspaceImage => ({ type: 'image', source: { type: 'base64', media_type, data } });

async function shaBytes(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function textBoundary(content: string, offset: number) {
  const previous = content.charCodeAt(offset - 1), next = content.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? offset + 1 : offset;
}
function validArguments(name: string, value: unknown): value is Arguments {
  if (!object(value)) return false;
  if (name === 'list' || name === 'capture' || name === 'play-start') return exact(value, []);
  if (name === 'read') return (exact(value, ['path']) || exact(value, ['path', 'offset']) &&
    Number.isSafeInteger(value.offset) && (value.offset as number) >= 0) && typeof value.path === 'string';
  if (name === 'write') return exact(value, ['path', 'content', 'expectedSha256']) && typeof value.path === 'string' &&
    typeof value.content === 'string' && (value.expectedSha256 === null || hash(value.expectedSha256));
  if (name === 'patch') return exact(value, ['path', 'oldText', 'newText', 'expectedSha256']) && typeof value.path === 'string' &&
    typeof value.oldText === 'string' && typeof value.newText === 'string' && hash(value.expectedSha256);
  if (name === 'play-act') return exact(value, ['sessionId', 'round']) && id(value.sessionId) && object(value.round);
  return (name === 'play-finish' || name === 'play-close') && exact(value, ['sessionId']) && id(value.sessionId);
}

async function lockInputs(files: readonly EmbeddedWorkspaceFile[], outputs: readonly string[]) {
  requireWorkspace(Array.isArray(files) && files.length <= 24, 'Invalid workspace material count.');
  const locked = new Map<string, { file: EmbeddedWorkspaceFile; bytes: number }>();
  let total = 0;
  for (const entry of files) {
    requireWorkspace(object(entry) && exact(entry, ['path', 'encoding', 'content', 'sha256']) &&
      typeof entry.path === 'string' && pathPattern.test(entry.path) && !locked.has(entry.path) && !outputs.includes(entry.path) &&
      (entry.encoding === 'utf8' || entry.encoding === 'base64') && typeof entry.content === 'string' && hash(entry.sha256),
    'Invalid workspace material.');
    requireWorkspace(entry.content.length <= (entry.encoding === 'utf8' ? fileBytes : Math.ceil(fileBytes / 3) * 4),
      'File exceeds the material limit.');
    const bytes = entry.encoding === 'utf8' ? encoder.encode(entry.content) : base64Bytes(entry.content);
    total += bytes.byteLength;
    requireWorkspace(bytes.byteLength <= fileBytes && total <= inputBytes && await shaBytes(bytes) === entry.sha256,
      'Workspace material exceeds limits or differs from its SHA-256.');
    const { path, encoding, content, sha256 } = entry;
    locked.set(path, { file: { path, encoding, content, sha256 }, bytes: bytes.byteLength });
  }
  requireWorkspace(locked.get('input/materials.json')?.file.encoding === 'utf8', 'Missing complete input/materials.json.');
  return locked;
}

async function browserResult(evidence: HarnessBrowserEvidence, name: string, inputHash: string, preparation?: Prepared): Promise<EmbeddedWorkspaceResult> {
  requireWorkspace(evidence.tool === name && evidence.inputHash === inputHash && Array.isArray(evidence.shots) &&
    evidence.shots.length <= 12 && (name !== 'capture' || evidence.shots.length === 4) &&
    (name !== 'play-start' || evidence.shots.length === 1), 'Browser evidence does not match this artifact.');
  const images: EmbeddedWorkspaceImage[] = [];
  const shots = [];
  for (const shot of evidence.shots) {
    const image = imageUrl.exec(shot.data);
    requireWorkspace(image && image[2].length <= imageCharacters &&
      await shaBytes(base64Bytes(image[2])) === shot.sha256, 'Original viewport image could not be verified.');
    const { data, ...metadata } = shot;
    images.push(nativeImage(image[1], image[2]));
    shots.push({ ...metadata, imageNumber: images.length });
  }
  const text = JSON.stringify({ ...evidence, shots, ...(preparation && { workspacePreparation: preparation }) });
  requireWorkspace(encoder.encode(text).byteLength + images.reduce((bytes, image) => bytes + image.source.data.length, 0) <= 15 * 1024 * 1024,
    'Browser evidence exceeds the response limit.');
  return { content: [{ type: 'text', text }, ...images] };
}

export async function openEmbeddedWorkspace(options: {
  taskId: string;
  runId: string;
  purpose: string;
  vision?: boolean;
  deadlineAt: number;
  files: readonly EmbeddedWorkspaceFile[];
  imagePaths?: readonly string[];
  storage: EmbeddedWorkspaceStorage;
  authorize: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
  browser?: Browser;
  onArtifact?: (file: Artifact, invocationId: string) => Promise<void>;
  now?: () => number;
}) {
  const { taskId, runId, purpose, vision, deadlineAt, storage, browser, onArtifact, authorize, signal: stageSignal, now = Date.now } = options;
  requireWorkspace(id(taskId) && id(runId) && id(purpose) && Number.isSafeInteger(deadlineAt) && deadlineAt > 0 &&
    (vision === undefined || typeof vision === 'boolean'), 'Invalid workspace scope.');
  const game = purpose === 'game', outputs = game ? ['game.html', 'record.json'] : ['result.txt'];
  const inputs = await lockInputs(options.files, outputs);
  const imagePaths = options.imagePaths ?? [];
  requireWorkspace(Array.isArray(imagePaths) && imagePaths.length <= (game ? 16 : 12) &&
    new Set(imagePaths).size === imagePaths.length && (vision !== false || !imagePaths.length), 'Invalid workspace image inventory.');
  const initialImages = imagePaths.map(path => {
    const input = inputs.get(path)?.file;
    const extension = typeof path === 'string' ? path.split('.').at(-1) : undefined;
    const media = extension && Object.hasOwn(mediaTypes, extension) ? mediaTypes[extension] : undefined;
    requireWorkspace(media && input?.encoding === 'base64' && input.content.length > 0, 'Invalid locked image.');
    return nativeImage(media, input.content);
  });
  const tools = definitions.filter(definition => !remoteTools.has(definition.name) || (game && vision !== false && browser))
    .map(definition => structuredClone(definition));
  const prefix = 'embedded-workspace:' + await harnessHash(canonicalHarness([taskId, runId])) + ':';
  const scopeSha256 = await harnessHash(canonicalHarness({ taskId, runId, purpose, vision: vision !== false, deadlineAt,
    files: [...inputs.values()].map(({ file: { path, encoding, sha256 } }) => ({ path, encoding, sha256 })),
    imagePaths, archive: Boolean(onArtifact),
  }));
  const artifactKey = (path: string) => prefix + 'file:' + path;
  const writeKey = (callId: string) => prefix + 'write:' + callId;
  const browserKey = (callId: string) => prefix + 'browser:' + callId;
  const sessionKey = (sessionId: string) => prefix + 'session:' + sessionId;
  const pendingKey = prefix + 'pending-artifact';
  const invocationId = async (callId: string) => 'tool-' + (await harnessHash(canonicalHarness([taskId, runId, callId]))).slice(0, 48);

  let closed = false, closing: Promise<void> | undefined;
  let queue = mutationQueues.get(storage);
  if (!queue) mutationQueues.set(storage, queue = new Map());
  const mutations = queue;
  function serial<T>(operation: () => Promise<T>) {
    const result = (mutations.get(taskId) ?? Promise.resolve()).then(operation);
    const tail = result.catch(() => {});
    mutations.set(taskId, tail);
    void tail.then(() => { if (mutations.get(taskId) === tail) mutations.delete(taskId); });
    return result;
  }
  function requireLive(signal?: AbortSignal) {
    requireWorkspace(!closed && !stageSignal?.aborted && !signal?.aborted && now() < deadlineAt, 'Workspace tool is no longer available.');
  }
  async function requireAuthorized(signal?: AbortSignal) {
    requireLive(signal);
    requireWorkspace(await authorize() === true, 'Workspace tool is not authorized.');
    requireLive(signal);
  }

  async function loadArtifact(tx: Store, path: string): Promise<Artifact | undefined> {
    const key = artifactKey(path), info = await tx.get<ArtifactIndex>(key);
    if (!info) return;
    requireWorkspace(info.path === path && hash(info.sha256) && Number.isSafeInteger(info.parts) &&
      info.parts >= 0 && info.parts <= Math.ceil(fileBytes / storageChunkUtf16), 'Workspace artifact index is invalid.');
    const chunks = [];
    for (let index = 0; index < info.parts; index++) {
      const chunk = await tx.get<string>(key + ':' + index);
      requireWorkspace(typeof chunk === 'string' && chunk.length > 0 && chunk.length <= storageChunkUtf16 + 1,
        'Workspace artifact data is incomplete.');
      chunks.push(chunk);
    }
    const content = chunks.join('');
    const bytes = encoder.encode(content);
    requireWorkspace(content.length === info.utf16Length && bytes.byteLength === info.utf8Bytes && bytes.byteLength <= fileBytes &&
      await shaBytes(bytes) === info.sha256, 'Workspace artifact does not match its SHA-256.');
    return { path, encoding: 'utf8', content, sha256: info.sha256 };
  }

  async function saveArtifact(tx: Store, file: Artifact) {
    const key = artifactKey(file.path), before = await tx.get<ArtifactIndex>(key);
    const utf8Bytes = encoder.encode(file.content).byteLength;
    requireWorkspace(utf8Bytes <= fileBytes, 'File exceeds the artifact limit.');
    let parts = 0;
    for (let offset = 0; offset < file.content.length;) {
      const end = textBoundary(file.content, Math.min(offset + storageChunkUtf16, file.content.length));
      await tx.put(key + ':' + parts++, file.content.slice(offset, end));
      offset = end;
    }
    for (let index = parts; index < (before?.parts ?? 0); index++) {
      if (tx.delete) await tx.delete(key + ':' + index);
      else await tx.put(key + ':' + index, '');
    }
    await tx.put<ArtifactIndex>(key, { path: file.path, sha256: file.sha256, utf8Bytes, utf16Length: file.content.length, parts });
  }
  function readArtifact(path: string) {
    requireWorkspace(outputs.includes(path), 'Path is outside the writable artifacts.');
    return storage.transaction(tx => loadArtifact(tx, path));
  }
  async function readOutputs() {
    return storage.transaction(async tx => {
      const files: Artifact[] = [];
      for (const path of outputs) {
        const file = await loadArtifact(tx, path);
        if (file) files.push(file);
      }
      return files;
    });
  }
  const scopeKey = prefix + 'scope';
  const knownScope = await storage.get<string>(scopeKey);
  if (knownScope === undefined) await requireAuthorized();
  await storage.transaction(async tx => {
    const existing = await tx.get<string>(scopeKey);
    requireWorkspace(existing === undefined || existing === scopeSha256, 'Workspace is bound to different immutable input.');
    if (existing !== undefined) return;
    requireLive();
    const previous = inputs.get('input/game.html')?.file;
    if (game && previous?.encoding === 'utf8') await saveArtifact(tx, { ...previous, path: 'game.html', encoding: 'utf8' });
    await tx.put(scopeKey, scopeSha256);
  });

  async function list() {
    const files = [...inputs.values()].map(({ file: { path, encoding, sha256, content }, bytes }) =>
      ({ path, encoding, sha256, ...(encoding === 'utf8' ? { utf8Bytes: bytes, utf16Length: content.length } : { bytes }) }));
    return storage.transaction(async tx => {
      for (const path of outputs) {
        const info = await tx.get<ArtifactIndex>(artifactKey(path));
        if (info) {
          requireWorkspace(info.path === path && hash(info.sha256) && Number.isSafeInteger(info.utf8Bytes) &&
            Number.isSafeInteger(info.utf16Length) && info.utf16Length >= 0 && info.utf8Bytes >= info.utf16Length && info.utf8Bytes <= fileBytes,
          'Workspace artifact index is invalid.');
          files.push({ path, encoding: 'utf8', sha256: info.sha256, utf8Bytes: info.utf8Bytes, utf16Length: info.utf16Length });
        }
      }
      return textResult({ files, writable: outputs, readChunkUtf16 });
    });
  }
  async function read(args: Arguments) {
    const path = args.path as string;
    const entry = inputs.get(path)?.file ?? (outputs.includes(path) ? await readArtifact(path) : undefined);
    requireInput(entry?.encoding === 'utf8', 'Readable text file not found.');
    const offset = (args.offset ?? 0) as number;
    requireInput(offset <= entry.content.length, 'Invalid offset.');
    const start = textBoundary(entry.content, offset);
    const end = textBoundary(entry.content, Math.min(offset + readChunkUtf16, entry.content.length));
    return textResult({ path, encoding: 'utf8', sha256: entry.sha256, utf8Bytes: encoder.encode(entry.content).byteLength,
      utf16Length: entry.content.length, range: { start, end }, content: entry.content.slice(start, end),
      nextOffset: end < entry.content.length ? end : null });
  }
  async function write(callId: string, name: string, args: Arguments, signal?: AbortSignal) {
    const path = args.path as string;
    requireInput(outputs.includes(path), 'Path is outside the writable artifacts.');
    const requestSha256 = await harnessHash(canonicalHarness([name, args]));
    await requireAuthorized(signal);
    const { record, artifact } = await storage.transaction(async tx => {
      requireLive(signal);
      const pending = await tx.get<string | null>(pendingKey);
      if (pending && pending !== callId) throw new EmbeddedWorkspaceArtifactPersistenceError();
      const known = await tx.get<WriteCall>(writeKey(callId));
      requireWorkspace(!await tx.get(browserKey(callId)), 'Tool call ID is already bound.');
      if (pending && known?.requestSha256 !== requestSha256) throw new EmbeddedWorkspaceArtifactPersistenceError();
      if (known) {
        requireWorkspace(known.requestSha256 === requestSha256, 'Tool call ID is bound to a different write.');
        if (known.status === 'done' && !pending) return { record: known };
        const artifact = await loadArtifact(tx, path);
        if (known.status !== 'pending' || pending !== callId || artifact?.sha256 !== known.sha256) {
          throw new EmbeddedWorkspaceArtifactPersistenceError();
        }
        return { record: known, artifact };
      }
      if (pending) throw new EmbeddedWorkspaceArtifactPersistenceError();
      const current = await loadArtifact(tx, path);
      requireInput((current?.sha256 ?? null) === args.expectedSha256, 'Artifact SHA-256 changed. Read the current file before editing.');
      let content = args.content as string;
      if (name === 'patch') {
        const oldText = args.oldText as string, original = current!.content;
        const position = original.indexOf(oldText);
        requireInput(oldText && position >= 0 && original.indexOf(oldText, position + 1) < 0, 'Patch must match exactly one occurrence.');
        content = original.slice(0, position) + args.newText + original.slice(position + oldText.length);
      }
      requireInput(content.length <= fileBytes && encoder.encode(content).byteLength <= fileBytes, 'File exceeds the artifact limit.');
      const sha256 = await harnessHash(content);
      requireLive(signal);
      const artifact: Artifact = { path, encoding: 'utf8', content, sha256 };
      const record: WriteCall = { requestSha256, path, sha256, status: onArtifact ? 'pending' : 'done' };
      await saveArtifact(tx, artifact);
      await tx.put(writeKey(callId), record);
      if (onArtifact) await tx.put(pendingKey, callId);
      return { record, ...(onArtifact && { artifact }) };
    });
    if (artifact) {
      try {
        await onArtifact!({ ...artifact }, await invocationId(callId));
        await storage.transaction(async tx => {
          const pending = await tx.get<WriteCall>(writeKey(callId));
          if (pending?.status !== 'pending' || pending.requestSha256 !== requestSha256 || pending.sha256 !== artifact.sha256 ||
              await tx.get(pendingKey) !== callId) throw new EmbeddedWorkspaceArtifactPersistenceError();
          await tx.put<WriteCall>(writeKey(callId), { ...record, status: 'done' });
          await tx.put(pendingKey, null);
        });
      } catch { throw new EmbeddedWorkspaceArtifactPersistenceError(); }
    }
    return textResult({ path: record.path, sha256: record.sha256 });
  }

  async function runBrowser(callId: string, name: string, args: Arguments, signal?: AbortSignal) {
    requireWorkspace(browser, 'Browser tool is unavailable.');
    const opening = name === 'capture' || name === 'play-start';
    const requestSha256 = await harnessHash(canonicalHarness([name, args]));
    const invocation = await invocationId(callId);
    await requireAuthorized(signal);
    const { record, html, prepared } = await storage.transaction(async tx => {
      requireLive(signal);
      const pending = await tx.get<string | null>(pendingKey);
      const known = await tx.get<BrowserCall>(browserKey(callId));
      if ((pending || known?.archivePending) &&
        (pending !== callId || !known?.archivePending || known.requestSha256 !== requestSha256 || !onArtifact)) {
        throw new EmbeddedWorkspaceArtifactPersistenceError();
      }
      requireWorkspace(!await tx.get(writeKey(callId)) && (!known || known.requestSha256 === requestSha256), 'Tool call ID is already bound.');
      const current = await loadArtifact(tx, 'game.html');
      let inputHash: string, html: string | undefined, preparation: Prepared | undefined, prepared: Artifact | undefined;
      if (opening) {
        requireInput(current, 'Write a complete game.html before requesting browser evidence.');
        requireWorkspace(!known || known.inputHash === current.sha256, 'Browser evidence is locked to a different game.html.');
        try { html = cleanGameHtml(current.content); }
        catch { throw new WorkspaceInputError('game.html is not ready for browser evidence.'); }
        requireWorkspace(cleanGameHtml(html) === html, 'HTML preparation is not stable.');
        inputHash = html === current.content ? current.sha256 : await harnessHash(html);
        requireWorkspace(!known || known.inputHash === inputHash, 'Prepared HTML changed for a locked browser invocation.');
        if (known?.archivePending) {
          if (known.preparation?.afterSha256 !== inputHash) throw new EmbeddedWorkspaceArtifactPersistenceError();
          prepared = current;
        } else if (inputHash !== current.sha256) {
          preparation = { path: 'game.html', beforeSha256: current.sha256, afterSha256: inputHash };
          requireLive(signal);
          prepared = { path: 'game.html', encoding: 'utf8', content: html, sha256: inputHash };
          await saveArtifact(tx, prepared);
        }
      } else {
        const bound = await tx.get<string>(sessionKey(args.sessionId as string));
        requireInput(hash(bound), 'Unknown original play session ID.');
        requireWorkspace(!known || known.inputHash === bound, 'Tool call ID is already bound to another artifact.');
        requireInput(name === 'play-close' || current?.sha256 === bound,
          'Original play session does not match the current game.html. Close it before opening another.');
        if (name === 'play-act') {
          // Reject malformed model input before reserving a browser action.
          // Failures from the actual browser call still stop the stage.
          try { validateHarnessPlayRound(args.round); }
          catch (error) { throw new WorkspaceInputError(error instanceof Error ? error.message : 'Invalid play round.'); }
        }
        inputHash = bound;
      }
      const record: BrowserCall = known ?? { requestSha256, inputHash, ...(preparation && { preparation }),
        ...(prepared && onArtifact && { archivePending: true }) };
      if (!known) {
        await tx.put(browserKey(callId), record);
        if (record.archivePending) await tx.put(pendingKey, callId);
      }
      return { record, html, prepared };
    });
    if (prepared && onArtifact) {
      try {
        await onArtifact({ ...prepared }, invocation);
        await storage.transaction(async tx => {
          const pending = await tx.get<BrowserCall>(browserKey(callId));
          if (!pending?.archivePending || pending.requestSha256 !== requestSha256 || pending.inputHash !== prepared.sha256 ||
              await tx.get(pendingKey) !== callId) throw new EmbeddedWorkspaceArtifactPersistenceError();
          const { archivePending, ...complete } = pending;
          await tx.put(browserKey(callId), complete);
          await tx.put(pendingKey, null);
        });
      } catch { throw new EmbeddedWorkspaceArtifactPersistenceError(); }
    }
    await requireAuthorized(signal);
    const evidence = await browser.execute({ name, id: invocation, arguments: { ...args, inputHash: record.inputHash,
      ...(html !== undefined && { html }) } }, deadlineAt);
    const result = await browserResult(evidence, name, record.inputHash, record.preparation);
    await requireAuthorized(signal);
    if (name === 'play-start') {
      requireWorkspace(id(evidence.sessionId), 'Missing original play session ID.');
      const key = sessionKey(evidence.sessionId);
      await storage.transaction(async tx => {
        requireLive(signal);
        const previous = await tx.get<string>(key);
        requireWorkspace(previous === undefined || previous === record.inputHash, 'Play session is already bound to another artifact.');
        if (previous === undefined) await tx.put(key, record.inputHash);
      });
    }
    return result;
  }

  async function call(input: { id: string; name: string; arguments: unknown }, signal?: AbortSignal): Promise<EmbeddedWorkspaceResult> {
    try {
      const { id: callId, name, arguments: raw } = input;
      requireInput(id(callId) && tools.some(tool => tool.name === name) && validArguments(name, raw), 'Invalid tool arguments.');
      const args = structuredClone(raw);
      if (name === 'list' || name === 'read') {
        await requireAuthorized(signal);
        const result = name === 'list' ? await list() : await read(args);
        await requireAuthorized(signal);
        return result;
      }
      return await serial(async () => {
        const result = remoteTools.has(name) ? await runBrowser(callId, name, args, signal) : await write(callId, name, args, signal);
        await requireAuthorized(signal);
        return result;
      });
    } catch (error) {
      if (error instanceof WorkspaceInputError) return { ...textResult({ error: error.message }), is_error: true };
      if (error instanceof WorkspaceError || error instanceof EmbeddedWorkspaceArtifactPersistenceError) throw error;
      throw new WorkspaceError('Workspace tool could not complete safely.');
    }
  }

  const onAbort = () => { void close().catch(() => {}); };
  function close() {
    closed = true;
    stageSignal?.removeEventListener('abort', onAbort);
    const pending = mutations.get(taskId);
    return closing ??= Promise.allSettled([Promise.resolve().then(() => browser?.close()), pending]).then(([browserResult]) => {
      if (browserResult.status === 'rejected') throw browserResult.reason;
    }).catch(error => { closing = undefined; throw error; });
  }
  if (stageSignal?.aborted) onAbort();
  else stageSignal?.addEventListener('abort', onAbort, { once: true });
  return { tools, initialImages, call, readArtifact, readOutputs, readBrowserEvidence: () => browser?.readResults() ?? Promise.resolve([]), close };
}
