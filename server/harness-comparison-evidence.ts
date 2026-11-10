/** Research-only replay. This module deliberately has no storage or network access. */
export type ComparisonEvidenceIdentity = {
  caseId: string;
  manifestSha256: string;
  evidenceSha256: string;
  packSha256: string;
};

type ComparisonShot = { id: string; sha256: string; data: string };
export type ComparisonEvidencePack = {
  schemaVersion: 1;
  caseId: string;
  manifestSha256: string;
  evidenceSha256: string;
  captureOrigin: 'isolated-chromium';
  html: { text: string; sha256: string };
  probe: { json: string; sha256: string };
  shots: ComparisonShot[];
};

type BasicObservation = { id: string; label: string; capturedAt: string; actionRefs: string[] };
type Fields = Record<string, unknown>;
const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hashPattern = /^[a-f0-9]{64}$/;
const maxArtifactBytes = 8 * 1024 * 1024;
const maxPackBytes = 64 * 1024 * 1024;
const expectedFrames = [
  { label: '9:16 首次触摸后约 10 秒', actionRefs: ['baseline-9:16-tap'] },
  { label: '9:19.5 首次触摸前', actionRefs: [] },
  { label: '9:19.5 首次触摸后约 3 秒', actionRefs: ['baseline-9:19.5-tap'] },
  { label: '9:21 首次触摸后约 10 秒', actionRefs: ['baseline-9:21-tap'] },
];

function need(condition: unknown, error: string): asserts condition {
  if (!condition) throw new Error(error);
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Fields {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid comparison evidence shape');
  const result = value as Fields;
  need(required.every(key => Object.hasOwn(result, key)) && Object.keys(result).every(key => required.includes(key) || optional.includes(key)),
    'Unexpected or missing comparison evidence fields');
  return result;
}
function sha(value: unknown) {
  need(typeof value === 'string' && hashPattern.test(value), 'Invalid comparison evidence SHA-256');
  return value;
}
async function hash(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function text(value: unknown, maxBytes: number) {
  need(typeof value === 'string' && value.length > 0 && value.length <= maxBytes, 'Invalid comparison evidence text');
  const bytes = encoder.encode(value);
  need(bytes.length <= maxBytes && utf8.decode(bytes) === value, 'Comparison evidence text is oversized or has invalid UTF-8');
  return bytes;
}
function json(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new Error('Invalid comparison evidence JSON'); }
}
function nullable(value: unknown, valid: (value: unknown) => boolean) {
  need(value == null || valid(value), 'Unexpected value in basic Chromium probe');
}
const stringValue = (value: unknown) => typeof value === 'string';
const numberValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const boolValue = (value: unknown) => typeof value === 'boolean';
const stringList = (value: unknown) => Array.isArray(value) && value.every(stringValue);
function optionalRows(value: unknown, allowed: string[]) {
  if (value == null) return [];
  need(Array.isArray(value), 'Unexpected array in basic Chromium probe');
  return value.map(row => fields(row, [], allowed));
}

function validateObservationMetadata(shot: Fields) {
  for (const key of ['title', 'domText']) nullable(shot[key], stringValue);
  nullable(shot.elapsedMs, numberValue);
  nullable(shot.errors, stringList);
  for (const canvas of optionalRows(shot.canvases, ['x', 'y', 'width', 'height', 'bufferWidth', 'bufferHeight'])) {
    for (const value of Object.values(canvas)) nullable(value, numberValue);
  }
  if (shot.audio == null) return;
  const audio = fields(shot.audio, [], ['contextStates', 'sourceStarts', 'media', 'measuredListening']);
  nullable(audio.contextStates, stringList);
  nullable(audio.sourceStarts, numberValue);
  nullable(audio.measuredListening, boolValue);
  for (const media of optionalRows(audio.media, ['paused', 'muted', 'volume', 'currentTime', 'readyState'])) {
    for (const key of ['paused', 'muted']) nullable(media[key], boolValue);
    for (const key of ['volume', 'currentTime', 'readyState']) nullable(media[key], numberValue);
  }
}

function validateProbeMetadata(data: Fields) {
  const ratios = ['9:16', '9:19.5', '9:21'];
  nullable(data.errors, stringList);
  nullable(data.note, stringValue);
  if (data.loaded != null) for (const value of Object.values(fields(data.loaded, [], ratios))) nullable(value, boolValue);
  if (data.resources != null) {
    for (const resource of Object.values(fields(data.resources, [], ratios))) {
      if (resource == null) continue;
      for (const value of Object.values(fields(resource, [], ['missing', 'restricted', 'failed']))) nullable(value, stringList);
    }
  }
  for (const row of optionalRows(data.loadErrors, ['ratio', 'error'])) {
    nullable(row.ratio, stringValue);
    nullable(row.error, stringValue);
  }
  for (const action of optionalRows(data.actions, ['id', 'startedAt', 'ratio', 'type', 'x', 'y', 'target', 'count', 'note'])) {
    for (const key of ['id', 'startedAt', 'ratio', 'type', 'note']) nullable(action[key], stringValue);
    for (const key of ['x', 'y', 'count']) nullable(action[key], numberValue);
    if (action.target != null) for (const value of Object.values(fields(action.target, [], ['tag', 'text']))) nullable(value, stringValue);
  }
}

function probe(value: string) {
  const data = fields(json(value), ['captureMethod', 'observations'], ['loaded', 'errors', 'actions', 'resources', 'loadErrors', 'note']);
  need(data.captureMethod === 'browser-viewport-v1' && Array.isArray(data.observations) && data.observations.length === 4,
    'Comparison requires four original basic Chromium observations');
  validateProbeMetadata(data);
  const observations = data.observations.map((value, index) => {
    const shot = fields(value, ['id', 'label', 'capturedAt', 'actionRefs'], ['elapsedMs', 'errors', 'title', 'domText', 'canvases', 'audio']);
    const expected = expectedFrames[index];
    need(shot.id === `baseline-${index + 1}` && shot.label === expected.label && typeof shot.capturedAt === 'string' &&
      Number.isFinite(Date.parse(shot.capturedAt)) && Array.isArray(shot.actionRefs) && shot.actionRefs.length === expected.actionRefs.length &&
      shot.actionRefs.every((ref, i) => ref === expected.actionRefs[i]), 'Comparison viewport order, labels or action references differ from basic Chromium capture');
    validateObservationMetadata(shot);
    return shot as BasicObservation;
  });
  // The original probe is returned unmodified. Null observations and omitted
  // fields keep their distinct meanings instead of becoming default values.
  return { ...data, observations };
}

function image(value: unknown) {
  need(typeof value === 'string' && value.length <= Math.ceil(maxArtifactBytes / 3) * 4 + 32, 'Invalid comparison screenshot size');
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  need(match, 'Comparison requires original PNG or JPEG screenshot data');
  let binary: string;
  try { binary = atob(match[2]); } catch { throw new Error('Invalid comparison screenshot encoding'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const signature = match[1] === 'png' ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
  need(bytes.length <= maxArtifactBytes && signature.every((byte, index) => bytes[index] === byte) && btoa(binary) === match[2],
    'Comparison screenshot MIME or byte encoding differs');
  return { data: value, bytes };
}

/** The identity must come from trusted admission state, outside the pack. */
export async function openComparisonEvidencePack(serialized: string, expected: ComparisonEvidenceIdentity) {
  const trusted = fields(expected, ['caseId', 'manifestSha256', 'evidenceSha256', 'packSha256']);
  need(typeof trusted.caseId === 'string' && /^[a-z0-9-]{1,64}$/.test(trusted.caseId), 'Invalid comparison case identity');
  const manifestSha256 = sha(trusted.manifestSha256), evidenceSha256 = sha(trusted.evidenceSha256);
  need(await hash(text(serialized, maxPackBytes)) === sha(trusted.packSha256), 'Comparison evidence package SHA-256 mismatch');
  const pack = fields(json(serialized), ['schemaVersion', 'caseId', 'manifestSha256', 'evidenceSha256', 'captureOrigin', 'html', 'probe', 'shots']);
  need(pack.schemaVersion === 1 && pack.captureOrigin === 'isolated-chromium' && pack.caseId === trusted.caseId &&
    pack.manifestSha256 === manifestSha256 && pack.evidenceSha256 === evidenceSha256, 'Comparison evidence does not match trusted admission');
  const html = fields(pack.html, ['text', 'sha256']), originalProbe = fields(pack.probe, ['json', 'sha256']);
  const htmlHash = sha(html.sha256), probeHash = sha(originalProbe.sha256);
  const htmlBytes = text(html.text, maxArtifactBytes), probeBytes = text(originalProbe.json, maxArtifactBytes);
  need((html.text as string).trim() && await hash(htmlBytes) === htmlHash, 'Comparison HTML SHA-256 mismatch');
  need(await hash(probeBytes) === probeHash, 'Comparison probe SHA-256 mismatch');
  const parsedProbe = probe(originalProbe.json as string);
  need(Array.isArray(pack.shots) && pack.shots.length === 4, 'Comparison requires exactly four original screenshots');
  const shotHashes: string[] = [];
  const shots = await Promise.all(pack.shots.map(async (value, index) => {
    const shot = fields(value, ['id', 'sha256', 'data']);
    const { id, label, capturedAt, actionRefs } = parsedProbe.observations[index];
    need(shot.id === id, 'Comparison screenshot order differs from the frozen probe');
    const { data, bytes } = image(shot.data);
    const digest = sha(shot.sha256);
    need(await hash(bytes) === digest, 'Comparison screenshot SHA-256 mismatch');
    shotHashes[index] = digest;
    return { id, label, capturedAt, actionRefs, source: 'isolated-chromium' as const, data };
  }));
  const originalBundle = JSON.stringify({ html: htmlHash, probe: probeHash, shots: shotHashes }, null, 2) + '\n';
  need(await hash(encoder.encode(originalBundle)) === evidenceSha256, 'Comparison evidence bundle SHA-256 mismatch');
  return {
    html: html.text as string,
    async captureReview(receivedHtml: string) {
      need(receivedHtml === html.text, 'Runner HTML differs from the locked comparison input');
      return structuredClone({ probe: parsedProbe, shots });
    },
  };
}
