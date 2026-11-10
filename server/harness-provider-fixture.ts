import { canonicalHarness, harnessHash } from './harness-policy';
import type { ProviderResearchManifest } from './harness-provider-research';

export const OPUS_RESEARCH_FIXTURE_ID = 'ccb-opus-provider-v2';
export const OPUS_RESEARCH_PURPOSE = 'game';
export const OPUS_RESEARCH_PHASE = 'build';
export const OPUS_RESEARCH_MODEL = 'claude-opus-5-5';
export const OPUS_RESEARCH_TURN_CAP = 2;
export const OPUS_RESEARCH_OUTPUT_CAP = 64_000;
export const OPUS_RESEARCH_TOTAL_CAP = OPUS_RESEARCH_OUTPUT_CAP * OPUS_RESEARCH_TURN_CAP;
export const OPUS_RESEARCH_TOOL = 'mcp__pgc_workspace__write';
export const OPUS_RESEARCH_FINAL = 'Synthetic color fixture saved.';
export const OPUS_RESEARCH_HTML = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><button>0</button><script>document.querySelector("button").onclick=e=>e.target.textContent=String(Number(e.target.textContent)+1)</script></body></html>';
const recordFor = (first: string, last: string) => JSON.stringify({
  requirements: [{ id: 'fixture-colors', text: `First image ${first}; last image ${last}.`, status: 'implemented' }],
  decisions: [], coreChanges: [],
});
export const OPUS_RESEARCH_RECORD = recordFor('red', 'blue');
const systemPrompt = 'This is a bounded compatibility fixture using synthetic data. Follow the requested single tool call and final sentence. Do not modify the seeded game.';
const prompt = `Inspect the dominant colors of the first and last of the sixteen synthetic PNGs. Call ${OPUS_RESEARCH_TOOL} once, with path record.json and content exactly this one-line JSON after replacing FIRST and LAST with lowercase English color names: ${recordFor('FIRST', 'LAST')} Do not call any other tool. After the write returns, reply exactly: ${OPUS_RESEARCH_FINAL}`;

// Deterministic 16×16 solid-color synthetic PNGs. No game evidence or
// production material is included in this fixture.
const pngs = [
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNg+M9AGhrVMKph+GoAAJHq/wEkpOWMAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4/5+BJESa6lENoxqGlAYAH+L+EED8VJoAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4z/CfJMQwqmFUw/DVAAAg0/4QF5nKuAAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNg+P+fNDSqYVTD8NUAACHE/hB8pgd4AAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4X89AEiJN9aiGUQ1DSgMAFGZ+EFqR6hMAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOoZ/hPEmIY1TCqYfhqAACVSH4QoGbpMQAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGOo/89AEiJN9aiGUQ1DSgMAlFd+EPvKdvgAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4z1BPEmIY1TCqYfhqAACVV34QfxWcbwAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNg+F9PGhrVMKph+GoAAJZIfhDF9c00AAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4X19PEmIY1TCqYfhqAAAYxP0QyZe25AAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNgqP9PGhrVMKph+GoAABZIfhApeREPAAAAAElFTkSuQmCC",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOo//+fJMQwqmFUw/DVAAAkMX0fWaGP5wAAAABJRU5ErkJggg==",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR4nGOIJxEwjGoY1TB8NQAAhJwdEHsmCpgAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFElEQVR4nGP4TyJgGNUwqmH4agAAr639H708R/EAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNgYPhPIhrVMKph2GoAAJLb/wFh5Z4RAAAAAElFTkSuQmCC"
] as const;
const toBytes = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0));
const fileHash = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');

export async function opusResearchFixtureMaterial() {
  const imagePaths = pngs.map((_, i) => `input/color-${String(i + 1).padStart(2, '0')}.png`);
  const files = [
    { path: 'input/game.html', content: OPUS_RESEARCH_HTML, encoding: 'utf8', sha256: await harnessHash(OPUS_RESEARCH_HTML) },
    ...await Promise.all(pngs.map(async (content, i) =>
      ({ path: imagePaths[i], content, encoding: 'base64', sha256: await fileHash(toBytes(content)) }))),
  ];
  return { prompt, systemPrompt, imagePaths, files };
}

export async function opusResearchFixtureSourceHash() {
  return harnessHash(canonicalHarness(await opusResearchFixtureMaterial()));
}

export async function opusResearchFixtureEnvelope(identity: { runId: string; taskId: string; generation: string }, deadlineAt: number) {
  return {
    ...identity, phase: OPUS_RESEARCH_PHASE, purpose: OPUS_RESEARCH_PURPOSE, protocol: 'anthropic',
    model: OPUS_RESEARCH_MODEL, effort: 'high', vision: true, deadlineAt,
    maxOutputTokens: OPUS_RESEARCH_OUTPUT_CAP, maxTotalOutputTokens: OPUS_RESEARCH_TOTAL_CAP,
    maxModelTurns: OPUS_RESEARCH_TURN_CAP, maxRepairs: 0, repair: 0, outputPath: 'game.html',
    ...await opusResearchFixtureMaterial(),
  };
}

export const OPUS_RESEARCH_TOOLS = Object.freeze([
  "mcp__pgc_workspace__capture",
  "mcp__pgc_workspace__list",
  "mcp__pgc_workspace__patch",
  "mcp__pgc_workspace__play-act",
  "mcp__pgc_workspace__play-close",
  "mcp__pgc_workspace__play-finish",
  "mcp__pgc_workspace__play-start",
  "mcp__pgc_workspace__read",
  "mcp__pgc_workspace__write"
] as const);

// Historical fixture pins. The v1 provider receipt belongs to this contract.
// CCB moves the cache marker from the original user text to the tool result
// on continuation, so the two user message pins differ.
export const OPUS_RESEARCH_WIRE_V1 = Object.freeze({
  sourceHash: '0a829fc3511ab49d5260b67fa83af9292a4d54d198bae1c6365ec1c0cb789258',
  systemSha256: 'fcd85cf61753fcd6bab4202e3cf1b706d2f4d7a0af36321e8095d92d25284685',
  toolsSha256: 'a5a1a5ef2ecab24c1c5cf8a1bd006efae81b0f7631acabca44f94a18ba46ac78',
  initialUserSha256: 'aa5b6df7b8cc4921e8f63915e537569f7ddb4aa373d995ab3ddb033a36c293e2',
  continuationUserSha256: 'bbc29e9a3dcf3986f32425e3b1d8ca6636c5c8ceaf5b673126e288641d6fb9a7',
  recordSha256: '696cfd07697b733b42f71c3c583dff56f2f0b52d38848235a865201f930cfc34',
  imageSha256: Object.freeze([
    "5503ff8fef5a4d87e1fe0bdc07254b11153a86debfa97500641c7abbf93357ef",
    "02face63fb127d0d7e89afe1b247bbebbe5411dfa7b2342d8e39e749445b3af0",
    "0559e37c84506263614b8669f2721d24d1cb12c891acb276f8bc07e43e9f9352",
    "ce76d1f8d81a101f330842f76ec0fee826feaa5fbc17d6bacb8b83205c7e6d72",
    "4819d47a4fd4dc156d3e2216255b5084a8021a68e55eb4846d3595daf7c4bb09",
    "bd4b6efec896aaac8622309fbb523252f69e2058af2ad7c4dc5aa6caf637b905",
    "b7810135a9b068433c1c7206e2802511ae5bd74065d0f7e4cfb7be3a3aaed3eb",
    "0e7ae4b1211a3e782c8742929d16a72da14b65a143cc36ba63c9aa849ae88a93",
    "aefe98955205523cc9e613a4f1f6fa2fff2677e61e3d6453af8c4beb7c505f27",
    "c452e796f49eaf1ccdd85ef4b7d0e7026cb413a81cde7827b0088e6376053223",
    "7dff81733b720b30ac7af51da2afd61342537307765a2b38418039656136b999",
    "9563cabdc00d252f302a8133a940e81fc9f825e99020ed517b6146beb60a1d6d",
    "de6b60569d28686aa1c8df56aa51a721e9e2934904fc74b6b6242055d27ca3ad",
    "1569701982529b257be3eef3d9e2d72e2cd355c8224aa12e2daa08fd67dd7f7e",
    "430c4a11827d224f42606ed8672beea2793f385db93046a3fdf27b71873ca409",
    "860b34e8ed68cf917160b8aadc8c3083688d30a8de968443fcb4654a1aadbbed"
  ] as const),
});

// Captured with pinned CCB 963e001 and Node 24.16 against the local scripted
// gateway. The revised workspace descriptions changed the native tools array.
export const OPUS_RESEARCH_WIRE = Object.freeze({
  ...OPUS_RESEARCH_WIRE_V1,
  toolsSha256: '16fb2396e986895668ee5a4d06ec83e74b0f14b05f98833d28509047eda09289',
});

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = (value: unknown) => harnessHash(canonicalHarness(value));
const exact = (a: unknown, b: unknown) => canonicalHarness(a) === canonicalHarness(b);
const requestIdPattern = /^build-0-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const toolIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const dateLine = /(^|\n)Today's date is (\d{4}-\d{2}-\d{2})\.(?=\n)/g;

async function userDigest(message: unknown, start: number, deadline: number) {
  if (!exactKeys(message, ['role', 'content']) || message.role !== 'user' || !Array.isArray(message.content) ||
      message.content.length !== OPUS_RESEARCH_WIRE.imageSha256.length + 2) return null;
  const [reminder, ...blocks] = message.content;
  if (!exactKeys(reminder, ['type', 'text']) || reminder.type !== 'text' || typeof reminder.text !== 'string') return null;
  const dates = [...reminder.text.matchAll(dateLine)];
  // The CCB-generated date is the only dynamic part of the locked first
  // user message. Accept a date only when the authorized run covers it.
  const allowedDates = [start, deadline].map(value => new Date(value).toISOString().slice(0, 10));
  if (dates.length !== 1 || !allowedDates.includes(dates[0][2])) return null;
  return digest({ ...message, content: [
    { ...reminder, text: reminder.text.replace(dateLine, "$1Today's date is <UTC_DATE>.") }, ...blocks,
  ] });
}

export const matchOpusResearchRequest: ProviderResearchManifest['requestMatches'] = async (body, model, context) => {
  const { requestId, run, readPriorAssistantDigest } = context;
  try {
    if (!requestIdPattern.test(requestId) || run.status !== 'active' || run.family !== 'forge' || run.actor !== 'admin' ||
        run.sourceHash !== OPUS_RESEARCH_WIRE.sourceHash || run.maxModelTurns !== OPUS_RESEARCH_TURN_CAP ||
        run.maxTotalOutputTokens !== OPUS_RESEARCH_TOTAL_CAP || run.maxRepairs !== 0 || run.reservedTokens !== 0 ||
        (run.modelTurns !== 0 && run.modelTurns !== 1) ||
        model.protocol !== 'anthropic' || model.model !== OPUS_RESEARCH_MODEL || model.purpose !== OPUS_RESEARCH_PURPOSE ||
        model.effort !== 'high' || model.vision !== true || model.maxOutputTokens !== OPUS_RESEARCH_OUTPUT_CAP ||
        !exactKeys(body, ['model', 'messages', 'system', 'tools', 'max_tokens', 'stream', 'thinking', 'output_config']) ||
        body.model !== OPUS_RESEARCH_MODEL || body.stream !== true || body.max_tokens !== OPUS_RESEARCH_OUTPUT_CAP ||
        !exact(body.thinking, { type: 'adaptive' }) || !exact(body.output_config, { effort: 'high' }) ||
        !Array.isArray(body.messages) || body.messages.length !== (run.modelTurns === 0 ? 1 : 3)) return false;
    const [system, tools, user] = await Promise.all([
      digest(body.system), digest(body.tools), userDigest(body.messages[0], run.startedAt, run.deadlineAt),
    ]);
    if (system !== OPUS_RESEARCH_WIRE.systemSha256 || tools !== OPUS_RESEARCH_WIRE.toolsSha256 ||
        user !== (run.modelTurns === 0 ? OPUS_RESEARCH_WIRE.initialUserSha256 : OPUS_RESEARCH_WIRE.continuationUserSha256)) return false;
    if (run.modelTurns === 0) return true;

    const [, assistant, toolResult] = body.messages;
    if (!exactKeys(assistant, ['role', 'content']) || assistant.role !== 'assistant' ||
        !Array.isArray(assistant.content) || !assistant.content.length || assistant.content.length > 16) return false;
    const toolUse = assistant.content.at(-1);
    if (!assistant.content.slice(0, -1).every(block => isObject(block) &&
        ['text', 'thinking', 'redacted_thinking'].includes(String(block.type))) ||
        !exactKeys(toolUse, ['type', 'id', 'name', 'input']) || toolUse.type !== 'tool_use' ||
        typeof toolUse.id !== 'string' || !toolIdPattern.test(toolUse.id) || toolUse.name !== OPUS_RESEARCH_TOOL ||
        !exact(toolUse.input, { path: 'record.json', content: OPUS_RESEARCH_RECORD })) return false;
    if (!exact(toolResult, { role: 'user', content: [{
      type: 'tool_result', tool_use_id: toolUse.id, cache_control: { type: 'ephemeral' },
      content: [{ type: 'text', text: JSON.stringify({ path: 'record.json', sha256: OPUS_RESEARCH_WIRE.recordSha256 }) }],
    }] })) return false;

    // Provider-authored reasoning is streamed normally, then bound to the
    // prior completed request by its digest. The matcher stores no text.
    const prior = await readPriorAssistantDigest();
    return typeof prior === 'string' && shaPattern.test(prior) && await digest(assistant.content) === prior;
  } catch {
    return false;
  }
};

export function opusResearchFixtureManifest(input: Pick<ProviderResearchManifest,
  'taskId' | 'generation' | 'modelContractHash' | 'notBefore' | 'expiresAt'>): ProviderResearchManifest {
  return {
    ...input,
    fixtureId: OPUS_RESEARCH_FIXTURE_ID, sourceHash: OPUS_RESEARCH_WIRE.sourceHash,
    purpose: OPUS_RESEARCH_PURPOSE, phase: OPUS_RESEARCH_PHASE,
    maxRequestOutputTokens: OPUS_RESEARCH_OUTPUT_CAP, maxTotalOutputTokens: OPUS_RESEARCH_TOTAL_CAP,
    maxModelTurns: OPUS_RESEARCH_TURN_CAP, toolNames: OPUS_RESEARCH_TOOLS, requestMatches: matchOpusResearchRequest,
  };
}
