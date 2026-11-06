import { harnessHash, canonicalHarness } from './harness-policy';
import type { ProviderResearchManifest } from './harness-provider-research';

export const DEEPSEEK_RESEARCH_FIXTURE_ID = 'ccb-deepseek-review-tool-v1';
export const DEEPSEEK_RESEARCH_MODEL = 'deepseek-flash';
export const DEEPSEEK_RESEARCH_PHASE = 'review';
export const DEEPSEEK_RESEARCH_OUTPUT_CAP = 8192;
export const DEEPSEEK_RESEARCH_TURN_CAP = 2;
export const DEEPSEEK_RESEARCH_TOTAL_CAP = DEEPSEEK_RESEARCH_OUTPUT_CAP * DEEPSEEK_RESEARCH_TURN_CAP;
export const DEEPSEEK_RESEARCH_READ = 'mcp__pgc_workspace__read';
export const DEEPSEEK_RESEARCH_PATH = 'input/marker.txt';
export const DEEPSEEK_RESEARCH_MARKER = 'PGC-SYNTHETIC-REVIEW-314';
export const DEEPSEEK_RESEARCH_RESULT = { first: 'red', last: 'blue', marker: DEEPSEEK_RESEARCH_MARKER };
export const DEEPSEEK_RESEARCH_CONTRACT = '5f7ffb37f6256cf96cdc82e22af47106dac4b73c4dccefa52abe49ef055aae92';
export const DEEPSEEK_RESEARCH_TOOLS = Object.freeze([
  'mcp__pgc_workspace__list', 'mcp__pgc_workspace__patch', DEEPSEEK_RESEARCH_READ, 'mcp__pgc_workspace__write',
]);

// Captured from the pinned CCB OpenAI adapter with a loopback-only scripted gateway.
export const DEEPSEEK_RESEARCH_WIRE = Object.freeze({
  sourceHash: '20b2bd50dc8885014dd08a4b1244d2ceb397def3e415ceaf3536849403e5e7b7',
  systemSha256: '9cd430385a82bbf918ec01b3cedbebb178ab4ccf03cf88ca37abe99e1ec70297',
  userSha256: '32a862d8c633aba8b3411026a7557ac3533b2551da57b1cb50a9c298a8e78bc2',
  toolsSha256: '6652600646191952b78c999369dd514de57e435accceab55f6fcdd3b11dbe7e5',
  markerSha256: 'e00929657735d0538c6af36e451a544eb33777bfb336ad071ca0c842d0027407',
});
const exact = (left: unknown, right: unknown) => canonicalHarness(left) === canonicalHarness(right);
const digest = (value: unknown) => harnessHash(canonicalHarness(value));
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const toolIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const requestIdPattern = /^review-0-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const dateLine = /(^|\n)Today's date is (\d{4}-\d{2}-\d{2})\.(?=\n)/g;
const readArguments = JSON.stringify({ path: DEEPSEEK_RESEARCH_PATH });
const markerToolResult = JSON.stringify({
  path: DEEPSEEK_RESEARCH_PATH, encoding: 'utf8', sha256: DEEPSEEK_RESEARCH_WIRE.markerSha256,
  utf8Bytes: DEEPSEEK_RESEARCH_MARKER.length, utf16Length: DEEPSEEK_RESEARCH_MARKER.length,
  range: { start: 0, end: DEEPSEEK_RESEARCH_MARKER.length }, content: DEEPSEEK_RESEARCH_MARKER, nextOffset: null,
});

export function deepSeekResearchResultMatches(text: unknown): boolean {
  try { return typeof text === 'string' && exact(JSON.parse(text), DEEPSEEK_RESEARCH_RESULT); }
  catch { return false; }
}

export function deepSeekResearchAssistant(content: string | null, reasoning: string, id: unknown, name: unknown, args: string) {
  if (typeof id !== 'string' || !toolIdPattern.test(id) || name !== DEEPSEEK_RESEARCH_READ ||
      !exact(JSON.parse(args), { path: DEEPSEEK_RESEARCH_PATH })) throw new Error('deepseek_fixture_tool_mismatch');
  return {
    role: 'assistant', content, reasoning_content: reasoning,
    tool_calls: [{ id, type: 'function', function: { name, arguments: readArguments } }],
  };
}

async function userDigest(message: unknown, start: number, deadline: number) {
  if (!exactKeys(message, ['role', 'content']) || message.role !== 'user' || !Array.isArray(message.content) ||
      message.content.length !== 3) return null;
  const [reminder, ...images] = message.content;
  if (!exactKeys(reminder, ['type', 'text']) || reminder.type !== 'text' || typeof reminder.text !== 'string') return null;
  const dates = [...reminder.text.matchAll(dateLine)];
  if (dates.length !== 1 || ![start, deadline].some(value => new Date(value).toISOString().slice(0, 10) === dates[0][2])) return null;
  return digest({ ...message, content: [{ ...reminder, text: reminder.text.replace(dateLine, "$1Today's date is <UTC_DATE>.") }, ...images] });
}

export const matchDeepSeekResearchRequest: ProviderResearchManifest['requestMatches'] = async (body, model, context) => {
  try {
    const { run, requestId, readPriorAssistantDigest } = context;
    if (!requestIdPattern.test(requestId) || run.status !== 'active' || run.family !== 'review' ||
        run.actor !== 'admin' || run.ownerId !== 'admin' || run.sourceHash !== DEEPSEEK_RESEARCH_WIRE.sourceHash ||
        run.maxModelTurns !== DEEPSEEK_RESEARCH_TURN_CAP || run.maxTotalOutputTokens !== DEEPSEEK_RESEARCH_TOTAL_CAP ||
        run.maxRepairs !== 0 || run.reservedTokens !== 0 || (run.modelTurns !== 0 && run.modelTurns !== 1) ||
        model.protocol !== 'openai' || model.purpose !== 'review' || model.model !== DEEPSEEK_RESEARCH_MODEL ||
        model.vision !== true || model.effort !== 'low' || model.maxOutputTokens !== DEEPSEEK_RESEARCH_OUTPUT_CAP ||
        !exactKeys(body, ['model', 'max_tokens', 'stream', 'stream_options', 'messages', 'tools']) ||
        body.model !== DEEPSEEK_RESEARCH_MODEL || body.stream !== true || body.max_tokens !== DEEPSEEK_RESEARCH_OUTPUT_CAP ||
        !exact(body.stream_options, { include_usage: true }) || !Array.isArray(body.messages) ||
        body.messages.length !== (run.modelTurns === 0 ? 2 : 4)) return false;
    const [system, user, assistant, tool] = body.messages;
    const [systemHash, userHash, toolsHash] = await Promise.all([
      digest(system), userDigest(user, run.startedAt, run.deadlineAt), digest(body.tools),
    ]);
    if (systemHash !== DEEPSEEK_RESEARCH_WIRE.systemSha256 || userHash !== DEEPSEEK_RESEARCH_WIRE.userSha256 ||
        toolsHash !== DEEPSEEK_RESEARCH_WIRE.toolsSha256) return false;
    if (run.modelTurns === 0) return true;
    if (!exactKeys(assistant, ['role', 'content', 'reasoning_content', 'tool_calls']) ||
        (assistant.content !== null && typeof assistant.content !== 'string') || typeof assistant.reasoning_content !== 'string' ||
        !Array.isArray(assistant.tool_calls) || assistant.tool_calls.length !== 1) return false;
    const call = assistant.tool_calls[0];
    if (!exactKeys(call, ['id', 'type', 'function']) || !exactKeys(call.function, ['name', 'arguments']) ||
        typeof call.function.arguments !== 'string' ||
        !exact(assistant, deepSeekResearchAssistant(assistant.content, assistant.reasoning_content, call.id, call.function.name, call.function.arguments)) ||
        !exact(tool, { role: 'tool', tool_call_id: call.id, content: markerToolResult })) return false;
    const prior = await readPriorAssistantDigest();
    return prior !== null && await digest([assistant]) === prior;
  } catch { return false; }
};

export function deepSeekResearchFixtureManifest({ taskId, generation, modelContractHash, notBefore, expiresAt }: Pick<ProviderResearchManifest,
  'taskId' | 'generation' | 'modelContractHash' | 'notBefore' | 'expiresAt'>): ProviderResearchManifest {
  if (modelContractHash !== DEEPSEEK_RESEARCH_CONTRACT) throw new Error('deepseek_fixture_model_contract_mismatch');
  return {
    taskId, generation, modelContractHash, notBefore, expiresAt, fixtureId: DEEPSEEK_RESEARCH_FIXTURE_ID,
    sourceHash: DEEPSEEK_RESEARCH_WIRE.sourceHash,
    purpose: 'review', phase: DEEPSEEK_RESEARCH_PHASE, maxRequestOutputTokens: DEEPSEEK_RESEARCH_OUTPUT_CAP,
    maxTotalOutputTokens: DEEPSEEK_RESEARCH_TOTAL_CAP, maxModelTurns: DEEPSEEK_RESEARCH_TURN_CAP,
    toolNames: DEEPSEEK_RESEARCH_TOOLS, requestMatches: matchDeepSeekResearchRequest,
  };
}

export function isDeepSeekResearchManifest(manifest: ProviderResearchManifest) {
  return manifest.fixtureId === DEEPSEEK_RESEARCH_FIXTURE_ID && manifest.modelContractHash === DEEPSEEK_RESEARCH_CONTRACT &&
    manifest.requestMatches === matchDeepSeekResearchRequest && manifest.sourceHash === DEEPSEEK_RESEARCH_WIRE.sourceHash &&
    manifest.purpose === 'review' && manifest.phase === DEEPSEEK_RESEARCH_PHASE &&
    manifest.maxModelTurns === DEEPSEEK_RESEARCH_TURN_CAP && manifest.maxRequestOutputTokens === DEEPSEEK_RESEARCH_OUTPUT_CAP &&
    manifest.maxTotalOutputTokens === DEEPSEEK_RESEARCH_TOTAL_CAP && exact(manifest.toolNames, DEEPSEEK_RESEARCH_TOOLS);
}

const systemPrompt = 'This compatibility fixture uses only synthetic materials. Perform the single requested tool read, then return the exact requested JSON object.';
const prompt = `Inspect the dominant colors of the first and last PNG. Call ${DEEPSEEK_RESEARCH_READ} once with path ${DEEPSEEK_RESEARCH_PATH} and no offset. After the tool returns, reply with exactly one JSON object such as {"first":"color","last":"color","marker":"value"}. Use lowercase English color names and the exact file content as the marker. Do not call any other tool.`;
const pngs = [
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNgYPhPIhrVMKph2GoAAJLb/wFh5Z4RAAAAAElFTkSuQmCC',
];

export async function deepSeekResearchFixtureMaterial() {
  const imagePaths = pngs.map((_, index) => `input/color-${index + 1}.png`);
  const files = [
    { path: DEEPSEEK_RESEARCH_PATH, content: DEEPSEEK_RESEARCH_MARKER, encoding: 'utf8', sha256: await harnessHash(DEEPSEEK_RESEARCH_MARKER) },
    ...await Promise.all(pngs.map(async (content, index) => {
      const bytes = Uint8Array.from(atob(content), character => character.charCodeAt(0));
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return { path: imagePaths[index], content, encoding: 'base64', sha256: Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') };
    })),
  ];
  return { systemPrompt, prompt, imagePaths, files };
}

export async function deepSeekResearchFixtureSourceHash() {
  return harnessHash(canonicalHarness(await deepSeekResearchFixtureMaterial()));
}

export async function deepSeekResearchFixtureEnvelope(identity: { runId: string; taskId: string; generation: string }, deadlineAt: number) {
  return {
    ...identity, phase: DEEPSEEK_RESEARCH_PHASE, purpose: 'review', protocol: 'openai', model: DEEPSEEK_RESEARCH_MODEL,
    effort: 'low', vision: true, deadlineAt, maxOutputTokens: DEEPSEEK_RESEARCH_OUTPUT_CAP,
    maxTotalOutputTokens: DEEPSEEK_RESEARCH_TOTAL_CAP, maxModelTurns: DEEPSEEK_RESEARCH_TURN_CAP,
    maxRepairs: 0, repair: 0, outputPath: 'result.txt', ...await deepSeekResearchFixtureMaterial(),
  };
}
