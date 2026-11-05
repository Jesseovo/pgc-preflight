import { describe, expect, it } from 'vitest';
import { workspaceResponse } from '../harness/workspace.mjs';
import { canonicalHarness, harnessHash } from '../server/harness-policy';
import type { HarnessRun } from '../server/harness-ledger';
import {
  OPUS_RESEARCH_MODEL, OPUS_RESEARCH_OUTPUT_CAP, OPUS_RESEARCH_RECORD, OPUS_RESEARCH_TOOL,
  OPUS_RESEARCH_TOTAL_CAP, OPUS_RESEARCH_TURN_CAP, OPUS_RESEARCH_WIRE,
  matchOpusResearchRequest, opusResearchFixtureManifest, opusResearchFixtureMaterial, opusResearchFixtureSourceHash,
} from '../server/harness-provider-fixture';

const startedAt = Date.parse('2026-11-05T12:00:00Z');
const model = {
  model: OPUS_RESEARCH_MODEL, protocol: 'anthropic', purpose: 'game', effort: 'high', vision: true,
  maxOutputTokens: OPUS_RESEARCH_OUTPUT_CAP, profileId: 'synthetic', profileHash: 'a'.repeat(64),
} as const;
const run: HarnessRun = {
  taskId: 'synthetic-task', generation: 'synthetic-generation', actor: 'admin', family: 'forge', ownerId: 'admin',
  sourceHash: OPUS_RESEARCH_WIRE.sourceHash, snapshotHash: 'b'.repeat(64), model, slot: 1, status: 'active',
  failureCode: null, startedAt, deadlineAt: startedAt + 60_000, endedAt: null, releasedAt: null, maxRepairs: 0,
  maxTotalOutputTokens: OPUS_RESEARCH_TOTAL_CAP, maxModelTurns: OPUS_RESEARCH_TURN_CAP, modelTurns: 0,
  outputTokens: 0, reservedTokens: 0,
};
const firstId = 'build-0-00000000-0000-4000-8000-000000000001';
const nextId = 'build-0-00000000-0000-4000-8000-000000000002';
const cache = { type: 'ephemeral' };
const assistant = [
  { type: 'thinking', thinking: 'Synthetic provider-originated reasoning.', signature: 'synthetic-signature' },
  { type: 'text', text: 'Writing the synthetic record.' },
  { type: 'tool_use', id: 'toolu_variable_01', name: OPUS_RESEARCH_TOOL, input: { path: 'record.json', content: OPUS_RESEARCH_RECORD } },
];
const dateReminder = `<system-reminder>
As you answer the user's questions, you can use the following context:
# currentDate
Today's date is 2026-11-05.

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
`;

async function bodyFixture(continued = false) {
  const fixture = await opusResearchFixtureMaterial();
  const listed = await workspaceResponse({ run: { purpose: 'game', vision: true } },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '');
  if (!listed || !('result' in listed) || !Array.isArray(listed.result.tools)) throw new Error('Workspace fixture tools unavailable');
  const workspaceTools = listed.result.tools as { name: string; description: string; inputSchema: object }[];
  const tools = workspaceTools.map(tool => ({
    name: `mcp__pgc_workspace__${tool.name}`, description: tool.description, input_schema: tool.inputSchema,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const prefix = {
    role: 'user', content: [
      { type: 'text', text: dateReminder },
      ...fixture.files.slice(1).map(file => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: file.content } })),
      { type: 'text', text: fixture.prompt, ...(!continued && { cache_control: cache }) },
    ],
  };
  return {
    model: OPUS_RESEARCH_MODEL, max_tokens: OPUS_RESEARCH_OUTPUT_CAP, stream: true,
    thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, tools,
    system: [
      { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: cache },
      { type: 'text', text: fixture.systemPrompt, cache_control: cache },
    ],
    messages: [
      prefix,
      ...(continued ? [
        { role: 'assistant', content: structuredClone(assistant) },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_variable_01', cache_control: cache,
          content: [{ type: 'text', text: JSON.stringify({ path: 'record.json', sha256: OPUS_RESEARCH_WIRE.recordSha256 }) }] }] },
      ] : []),
    ],
  };
}

const matchFirst = (body: Record<string, unknown>, patch: Partial<HarnessRun> = {}) =>
  matchOpusResearchRequest(body, model, { requestId: firstId, run: { ...run, ...patch }, readPriorAssistantDigest: async () => null });
const matchNext = async (body: Record<string, unknown>, prior?: string | null, patch: Partial<HarnessRun> = {}) => {
  const digest = prior === undefined ? await harnessHash(canonicalHarness(assistant)) : prior;
  return matchOpusResearchRequest(body, model, { requestId: nextId, run: { ...run, modelTurns: 1, outputTokens: 10, ...patch },
    readPriorAssistantDigest: async () => digest });
};

describe('pinned Opus provider research fixture', () => {
  it('matches exactly two frozen requests with sixteen distinct original PNGs and a correlated tool use', async () => {
    const manifest = opusResearchFixtureManifest({ ...run, modelContractHash: 'c'.repeat(64),
      notBefore: startedAt, expiresAt: run.deadlineAt });
    expect(manifest).toMatchObject({
      purpose: 'game', phase: 'build', maxRequestOutputTokens: 64_000, maxTotalOutputTokens: 128_000, maxModelTurns: 2,
    });
    const materials = await opusResearchFixtureMaterial();
    expect(await opusResearchFixtureSourceHash()).toBe(OPUS_RESEARCH_WIRE.sourceHash);
    expect(materials.files.slice(1).map(file => file.sha256)).toEqual(OPUS_RESEARCH_WIRE.imageSha256);
    expect(new Set(OPUS_RESEARCH_WIRE.imageSha256).size).toBe(16);
    expect(await matchFirst(await bodyFixture())).toBe(true);
    expect(await matchNext(await bodyFixture(true))).toBe(true);
  });

  it('rejects changed initial system, tool schema, prompt, image order, date, or native model options', async () => {
    const mutations: ((body: any) => void)[] = [
      body => { body.system[1].text += ' extra'; },
      body => { body.tools[0].description += ' extra'; },
      body => { body.messages[0].content.at(-1).text += ' extra'; },
      body => { body.messages[0].content[1].source.data = body.messages[0].content[2].source.data; },
      body => { body.messages[0].content[0].text = dateReminder.replace('2026-11-05', '2026-11-07'); },
      body => { body.messages[0].content[0].text += 'unapproved data'; },
      body => { body.output_config.effort = 'low'; },
      body => { body.thinking.display = 'omitted'; },
      body => { body.max_tokens = 63_999; },
      body => { body.metadata = { external: true }; },
    ];
    const original = await bodyFixture();
    for (const mutate of mutations) {
      const body = structuredClone(original);
      mutate(body);
      expect(await matchFirst(body)).toBe(false);
    }
    expect(await matchFirst(original, { reservedTokens: 64_000 })).toBe(false);
    expect(await matchFirst(original, { sourceHash: 'd'.repeat(64) })).toBe(false);
  });

  it('accepts a provider-originated opaque thinking block only with its exact prior digest', async () => {
    const body = await bodyFixture(true) as any;
    body.messages[1].content = [
      { type: 'redacted_thinking', data: 'opaque-synthetic-provider-data' },
      body.messages[1].content[2],
    ];
    const providerDigest = await harnessHash(canonicalHarness(body.messages[1].content));
    expect(await matchNext(body, providerDigest)).toBe(true);
    body.messages[1].content[0].data += '-changed';
    expect(await matchNext(body, providerDigest)).toBe(false);
  });

  it('rejects uncorrelated reasoning, extra turns, unexpected tools and invented results', async () => {
    const original = await bodyFixture(true);
    expect(await matchNext(original, null)).toBe(false);
    expect(await matchNext(original, 'd'.repeat(64))).toBe(false);
    expect(await matchNext(original, undefined, { modelTurns: 2 })).toBe(false);
    const mutations: ((body: any) => void)[] = [
      body => { body.messages[1].content[0].thinking = 'changed after the provider replied'; },
      body => { body.messages[1].content[2].id = 'another-tool-id'; },
      body => { body.messages[1].content[2].input.path = 'game.html'; },
      body => { body.messages[1].content[2].input.content += ' '; },
      body => { body.messages[2].content[0].content[0].text = 'invented workspace result'; },
      body => { body.messages[2].content[0].tool_use_id = 'another-tool-id'; },
      body => { body.messages[2].content[0].content.push(body.messages[0].content[1]); },
      body => { body.messages.push({ role: 'user', content: 'arbitrary follow-up' }); },
    ];
    for (const mutate of mutations) {
      const body = structuredClone(original);
      mutate(body);
      expect(await matchNext(body)).toBe(false);
    }
    const wrongTool = structuredClone(original) as any;
    wrongTool.messages[1].content[2].name = 'mcp__pgc_workspace__read';
    expect(await matchNext(wrongTool, await harnessHash(canonicalHarness(wrongTool.messages[1].content)))).toBe(false);
  });
});
