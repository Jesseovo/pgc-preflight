import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({
  maxOutputTokens: 64_000,
  maxTotalOutputTokens: 256_000,
  maxModelTurns: 24,
  maxRepairs: 2,
  durationMs: 40 * 60_000,
  fileBytes: 2 * 1024 * 1024,
  inputBytes: 12 * 1024 * 1024,
  promptBytes: 512 * 1024,
});
const hashPattern = /^[a-f0-9]{64}$/;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const modelName = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,199}$/;
const relativePath = /^(?:input\/)?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const imageTypes = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}`;
  }
  return JSON.stringify(value);
}

function object(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function string(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function prompt(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= LIMITS.promptBytes;
}

export function fileEntry(path, content) {
  return { path, content, encoding: 'utf8', sha256: sha256(content) };
}

export function validateStart(input, now) {
  if (!object(input, ['envelope', 'envelopeSha256', 'lease']) ||
      !string(input.envelopeSha256, hashPattern) || !string(input.lease, /^[\w.~-]{24,512}$/)) return null;
  const env = input.envelope;
  if (!object(env, [
    'runId', 'taskId', 'generation', 'phase', 'purpose', 'protocol', 'model', 'effort',
    'deadlineAt', 'maxOutputTokens', 'maxTotalOutputTokens', 'maxModelTurns', 'maxRepairs', 'repair',
    'prompt', 'systemPrompt', 'files',
  ], ['imagePaths', 'outputPath', 'vision'])) return null;
  if (![env.runId, env.taskId, env.phase, env.purpose].every(value => string(value, identifier)) ||
      !string(env.model, modelName) ||
      !(integer(env.generation, 1, Number.MAX_SAFE_INTEGER) || string(env.generation, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)) ||
      (env.vision !== undefined && typeof env.vision !== 'boolean') ||
      !['anthropic', 'openai'].includes(env.protocol) ||
      !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(env.effort) ||
      !integer(env.deadlineAt, now + 1, now + LIMITS.durationMs) ||
      !integer(env.maxOutputTokens, 1, LIMITS.maxOutputTokens) ||
      !integer(env.maxTotalOutputTokens, env.maxOutputTokens, LIMITS.maxTotalOutputTokens) ||
      !integer(env.maxModelTurns, 1, LIMITS.maxModelTurns) ||
      !integer(env.maxRepairs, 0, LIMITS.maxRepairs) ||
      !integer(env.repair, 0, env.maxRepairs) ||
      !prompt(env.prompt) || !prompt(env.systemPrompt) ||
      !Array.isArray(env.files) || env.files.length > 24) return null;

  const game = env.purpose === 'game';
  if (game && (env.protocol !== 'anthropic' || env.model !== 'claude-opus-5-5' || env.effort !== 'high')) return null;
  const outputs = game ? ['game.html', 'record.json'] : [env.outputPath ?? 'result.txt'];
  if ((game && env.outputPath !== undefined && env.outputPath !== 'game.html') ||
      !outputs.every(path => string(path, relativePath) && !path.startsWith('input/'))) return null;

  const files = new Map();
  let bytes = 0;
  for (const entry of env.files) {
    if (!object(entry, ['path', 'content', 'encoding', 'sha256']) ||
        !string(entry.path, relativePath) || files.has(entry.path) || outputs.includes(entry.path) ||
        !['utf8', 'base64'].includes(entry.encoding) || typeof entry.content !== 'string' ||
        !string(entry.sha256, hashPattern)) return null;
    const buffer = Buffer.from(entry.content, entry.encoding);
    if ((entry.encoding === 'base64' && buffer.toString('base64') !== entry.content) ||
        buffer.length > LIMITS.fileBytes || (bytes += buffer.length) > LIMITS.inputBytes ||
        sha256(buffer) !== entry.sha256) return null;
    files.set(entry.path, entry);
  }

  const images = [];
  if (env.imagePaths !== undefined) {
    if (env.vision === false || !Array.isArray(env.imagePaths) || env.imagePaths.length > (game ? 16 : 12) ||
        new Set(env.imagePaths).size !== env.imagePaths.length) return null;
    for (const path of env.imagePaths) {
      const entry = files.get(path);
      const mediaType = typeof path === 'string' ? imageTypes[path.split('.').at(-1)] : null;
      if (typeof mediaType !== 'string' || entry?.encoding !== 'base64') return null;
      images.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: entry.content } });
    }
  }
  if (sha256(canonical(env)) !== input.envelopeSha256) return null;
  const { files: _files, imagePaths: _imagePaths, ...run } = env;
  // A later game phase may patch a copy of the hash-locked prior HTML in place.
  const previous = files.get('input/game.html');
  if (game && previous?.encoding === 'utf8') files.set('game.html', fileEntry('game.html', previous.content));
  return { run: Object.freeze({ ...run, generation: String(run.generation) }), files, images, outputs, envelopeSha256: input.envelopeSha256, lease: input.lease };
}
