import { expect, it, vi } from 'vitest';
import { runEmbeddedQuery } from '../server/embedded-ccb';
import type { EmbeddedModelRequest } from '../server/embedded-ccb/types';
import { PLAY_LIMITS, validatePlayActions } from '../src/review-play-actions';
import {
  EmbeddedWorkspaceArtifactPersistenceError, openEmbeddedWorkspace,
  type EmbeddedWorkspaceFile, type EmbeddedWorkspaceResult, type EmbeddedWorkspaceStorage,
} from '../server/harness-embedded-workspace';
import type { HarnessBrowserEvidence } from '../server/harness-tools';
import { harnessHash } from '../server/harness-policy';

const clock = 1_800_000_000_000;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=';
const game = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><script>let play = 1;</script></body></html>';

function memory(): EmbeddedWorkspaceStorage {
  let data = new Map<string, unknown>(), tail: Promise<unknown> = Promise.resolve();
  const access = (target: Map<string, unknown>) => ({
    async get<T>(key: string) { return structuredClone(target.get(key)) as T | undefined; },
    async put<T>(key: string, value: T) { target.set(key, structuredClone(value)); },
    async delete(key: string) { target.delete(key); },
  });
  return {
    get: <T>(key: string) => access(data).get<T>(key),
    put: <T>(key: string, value: T) => access(data).put(key, value),
    async transaction<T>(work: Parameters<EmbeddedWorkspaceStorage['transaction']>[0]) {
      const operation = tail.then(async () => {
        const snapshot = new Map(data);
        const result = await work(access(snapshot));
        data = snapshot;
        return result as T;
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
}
const textFile = async (path: string, content: string): Promise<EmbeddedWorkspaceFile> =>
  ({ path, encoding: 'utf8', content, sha256: await harnessHash(content) });
async function imageFile(path = 'input/frame.png'): Promise<EmbeddedWorkspaceFile> {
  const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { path, encoding: 'base64', content: png, sha256 };
}
const args = (id: string, name: string, value: unknown = {}) => ({ id, name, arguments: value });
const text = (result: EmbeddedWorkspaceResult) => {
  const block = result.content[0];
  if (block.type !== 'text') throw new Error('Expected tool metadata text');
  return JSON.parse(block.text);
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(extra: Partial<Parameters<typeof openEmbeddedWorkspace>[0]> = {}) {
  const options = { taskId: 'task-1', runId: 'phase-1', purpose: 'game', deadlineAt: clock + 10_000, storage: memory(),
    now: () => clock, authorize: () => true, files: [await textFile('input/materials.json', '{"user":"frozen materials"}')], ...extra };
  return { options, workspace: await openEmbeddedWorkspace(options) };
}

it('reads the complete UTF-8 material with exact adjacent UTF-16 ranges and exposes original input images', async () => {
  const material = '{"user":"' + 'a'.repeat(19_990) + '🐈' + '汉字'.repeat(8000) + '"}';
  expect(material.charCodeAt(19_999)).toBeGreaterThanOrEqual(0xd800);
  const file = await textFile('input/materials.json', material), image = await imageFile();
  const { workspace } = await fixture({ files: [file, image], imagePaths: [image.path] });
  const result = await Promise.all([
    workspace.call(args('list', 'list')),
    workspace.call(args('a', 'read', { path: file.path, offset: 0 })),
    workspace.call(args('b', 'read', { path: file.path, offset: 20_000 })),
  ]);
  const [list, a, b] = result.map(text);
  expect(list.readChunkUtf16).toBe(20_000);
  expect(list.files).toContainEqual({ path: file.path, encoding: 'utf8', sha256: file.sha256,
    utf8Bytes: new TextEncoder().encode(material).length, utf16Length: material.length });
  expect(a.range.end).toBe(20_001);
  expect(a.range.end).toBe(b.range.start);
  expect(a.nextOffset).toBe(b.range.start);
  expect(a.content + b.content).toBe(material);
  expect(workspace.initialImages).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }]);
  expect((await workspace.call(args('bad', 'write', { path: file.path, content: '{}', expectedSha256: file.sha256 }))).is_error).toBe(true);
  expect((await workspace.call(args('image', 'read', { path: image.path }))).is_error).toBe(true);
  expect((await workspace.call(args('offset', 'read', { path: file.path, offset: 999_999 }))).is_error).toBe(true);
  expect(workspace.tools.filter(tool => tool.readOnly).map(tool => tool.name)).toEqual(['list', 'read']);
});

it('rejects invalid source hashes, excessive UTF-8 bytes, noncanonical image bytes and unsupported images', async () => {
  const image = await imageFile(), material = await textFile('input/materials.json', '{}');
  const oversized = await textFile('input/materials.json', '界'.repeat(700_000));
  await expect(fixture({ files: [oversized] })).rejects.toThrow(/material limit|exceeds limits/);
  await expect(fixture({ files: [{ ...material, sha256: '0'.repeat(64) }] })).rejects.toThrow(/SHA-256/);
  await expect(fixture({ files: [material, { ...image, content: png + '=' }], imagePaths: [image.path] })).rejects.toThrow(/base64/);
  await expect(fixture({ files: [material, image], imagePaths: [image.path], vision: false })).rejects.toThrow(/image inventory/);
  const large = await textFile('input/file-0.txt', 'x'.repeat(2 * 1024 * 1024));
  const six = Array.from({ length: 6 }, (_, index) => ({ ...large, path: 'input/file-' + index + '.txt' }));
  await expect(fixture({ files: [material, ...six] })).rejects.toThrow(/exceeds limits/);
});

it('persistently seeds only the prior game and enforces write/patch CAS and replay identity', async () => {
  const material = await textFile('input/materials.json', '{}'), previous = await textFile('input/game.html', game);
  const { options, workspace } = await fixture({ files: [material, previous] });
  expect(await workspace.readArtifact('game.html')).toEqual({ ...previous, path: 'game.html' });
  const patch = args('patch-1', 'patch', { path: 'game.html', expectedSha256: previous.sha256, oldText: 'play = 1', newText: 'play = 2' });
  const saved = text(await workspace.call(patch));
  const record = args('write-1', 'write', { path: 'record.json', content: '{"answer":2}', expectedSha256: null });
  const recordSaved = text(await workspace.call(record));
  expect(saved.sha256).toBe(await harnessHash(game.replace('play = 1', 'play = 2')));
  expect((await workspace.call(args('stale', 'patch', { ...patch.arguments as object, oldText: 'play = 2' }))).is_error).toBe(true);
  expect((await workspace.call(args('other', 'write', { path: '../game.html', content: 'bad', expectedSha256: null }))).is_error).toBe(true);
  expect((await workspace.call(args('missing', 'write', { path: 'record.json', content: 'bad' }))).is_error).toBe(true);
  expect((await workspace.call(args('wrong-id', 'patch', { path: 'game.html', expectedSha256: saved.sha256, oldText: '<', newText: 'bad' }))).is_error).toBe(true);
  await workspace.close();
  const reopened = await openEmbeddedWorkspace(options);
  expect(text(await reopened.call(patch))).toEqual(saved);
  expect(text(await reopened.call(record))).toEqual(recordSaved);
  await expect(reopened.call(args('write-1', 'write', { path: 'record.json', content: 'different', expectedSha256: null })))
    .rejects.toThrow('Tool call ID is bound to a different write.');
  expect((await reopened.readOutputs()).map(file => file.sha256)).toEqual([saved.sha256, recordSaved.sha256]);
  await expect(openEmbeddedWorkspace({ ...options, files: [await textFile('input/materials.json', '{"changed":true}')] })).rejects.toThrow(/different immutable input/);
  const other = await openEmbeddedWorkspace({ ...options, runId: 'phase-2' });
  expect((await other.readOutputs()).map(file => file.sha256)).toEqual([previous.sha256]);
});

it('keeps an unconfirmed archive retry tied to one durable artifact and stops subsequent mutations', async () => {
  const archive = vi.fn<NonNullable<Parameters<typeof openEmbeddedWorkspace>[0]['onArtifact']>>()
    .mockRejectedValueOnce(new Error('private archive failure')).mockResolvedValue(undefined);
  const { options, workspace } = await fixture({ onArtifact: archive });
  const payload = args('keep-id', 'write', { path: 'game.html', content: game, expectedSha256: null });
  await expect(workspace.call(payload)).rejects.toBeInstanceOf(EmbeddedWorkspaceArtifactPersistenceError);
  const artifact = await workspace.readArtifact('game.html');
  expect(artifact?.content).toBe(game);
  await expect(workspace.call(args('new-id', 'write', { path: 'record.json', content: '{}', expectedSha256: null })))
    .rejects.toBeInstanceOf(EmbeddedWorkspaceArtifactPersistenceError);
  expect(archive).toHaveBeenCalledOnce();
  await workspace.close();
  const reopened = await openEmbeddedWorkspace(options);
  const replayed = await reopened.call(payload);
  expect(replayed.is_error).toBeUndefined();
  expect(text(replayed)).toEqual({ path: 'game.html', sha256: artifact?.sha256 });
  expect(archive.mock.calls[0]).toEqual(archive.mock.calls[1]);
  expect(archive.mock.calls[1][0]).toEqual(artifact);
  expect(archive.mock.calls[1][1]).toMatch(/^tool-[a-f0-9]{48}$/);
  expect(await reopened.call(payload)).toEqual(replayed);
  expect(archive).toHaveBeenCalledTimes(2);
});

it('shards a complete large artifact without splitting a surrogate pair or exceeding its byte cap', async () => {
  const { workspace } = await fixture({ purpose: 'review' });
  const content = 'x'.repeat(23_999) + '🐈' + 'x'.repeat(2 * 1024 * 1024 - 24_003);
  expect(new TextEncoder().encode(content).byteLength).toBe(2 * 1024 * 1024);
  const save = (id: string, content: string) => workspace.call(args(id, 'write', { path: 'result.txt', content, expectedSha256: null }));
  expect((await save('too-large', content + 'x')).is_error).toBe(true);
  const exact = await save('exact', content);
  expect(exact.is_error).toBeUndefined();
  const [artifact] = await workspace.readOutputs();
  expect(artifact.content).toBe(content);
  expect(artifact.sha256).toBe(text(exact).sha256);
});

it('closes the browser promptly and waits for an in-flight artifact archive before returning', async () => {
  const entered = deferred(), archived = deferred(), browserClosed = deferred();
  const browser = { execute: vi.fn(), readResults: vi.fn(async () => []), close: vi.fn(async () => { browserClosed.resolve(); }) };
  const { workspace } = await fixture({ browser, async onArtifact() { entered.resolve(); await archived.promise; } });
  const write = workspace.call(args('write', 'write', { path: 'game.html', content: game, expectedSha256: null })).catch(error => error);
  await entered.promise;
  let closed = false;
  const close = workspace.close().then(() => { closed = true; });
  await browserClosed.promise;
  expect(closed).toBe(false);
  archived.resolve();
  await close;
  expect(await write).toMatchObject({ message: 'Workspace tool is no longer available.' });
  expect((await workspace.readArtifact('game.html'))?.content).toBe(game);
});

it('prepares exact browser bytes, keeps reads parallel, and does not reuse stale play evidence', async () => {
  const image = await imageFile(), entered = deferred(), unblock = deferred();
  const browser = {
    execute: vi.fn(async (value: unknown, deadlineAt: number) => {
      expect(deadlineAt).toBe(clock + 10_000);
      const { name, arguments: input } = value as { name: string; arguments: { inputHash: string; html?: string } };
      if (name === 'play-start') { entered.resolve(); await unblock.promise; }
      const count = name === 'capture' ? 4 : name === 'play-start' ? 1 : 0;
      return { tool: name, inputHash: input.inputHash, sessionId: 'session-1', evidenceHash: 'e'.repeat(64),
        shots: Array.from({ length: count }, (_, index) => ({ id: 'shot-' + index, data: 'data:image/png;base64,' + png, sha256: image.sha256 })),
      } as unknown as HarnessBrowserEvidence;
    }),
    readResults: vi.fn(async () => []), close: vi.fn(async () => {}),
  };
  const { workspace } = await fixture({ browser });
  const external = game.replace('<head>', '<head><script src="https://example.invalid/tool.js"></script>');
  const original = text(await workspace.call(args('create', 'write', { path: 'game.html', content: external, expectedSha256: null })));
  const startPromise = workspace.call(args('start', 'play-start'));
  await entered.promise;
  const prepared = await harnessHash(game);
  let writeDone = false;
  const edit = workspace.call(args('edit', 'patch', { path: 'game.html', oldText: 'play = 1', newText: 'play = 2', expectedSha256: prepared }))
    .then(result => { writeDone = true; return result; });
  const list = text(await workspace.call(args('list', 'list')));
  expect(list.files.find((file: { path: string }) => file.path === 'game.html').sha256).toBe(prepared);
  expect(writeDone).toBe(false);
  unblock.resolve();
  const started = await startPromise;
  expect(started.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
  expect(text(started).workspacePreparation).toEqual({ path: 'game.html', beforeSha256: original.sha256, afterSha256: prepared });
  expect(text(started).shots[0]).not.toHaveProperty('data');
  expect((await edit).is_error).toBeUndefined();
  expect((await workspace.call(args('stale', 'play-act', { sessionId: 'session-1', round: { actions: [] } }))).is_error).toBe(true);
  expect((await workspace.call(args('stale-finish', 'play-finish', { sessionId: 'session-1' }))).is_error).toBe(true);
  await expect(workspace.call(args('start', 'play-start'))).rejects.toThrow('Browser evidence is locked to a different game.html.');
  expect((await workspace.call(args('close', 'play-close', { sessionId: 'session-1' }))).is_error).toBeUndefined();
  expect(browser.execute.mock.calls[1][0]).toMatchObject({ name: 'play-close', arguments: { inputHash: prepared } });
  const captured = await workspace.call(args('capture', 'capture'));
  expect(captured.content.slice(1)).toEqual(Array(4).fill(started.content[1]));
  expect(text(captured).inputHash).toBe(await harnessHash(game.replace('play = 1', 'play = 2')));
  expect(browser.execute.mock.calls.map(([value]) => (value as { name: string }).name)).toEqual(['play-start', 'play-close', 'capture']);
  await workspace.close();
  await workspace.close();
  expect(browser.close).toHaveBeenCalledOnce();
});

it('returns no partial evidence for a bad original image and checks live permission and deadlines', async () => {
  let allowed = true, now = clock;
  const controller = new AbortController();
  const browser = {
    execute: vi.fn(async (value: unknown) => {
      const { arguments: input } = value as { arguments: { inputHash: string } };
      return { tool: 'play-start', inputHash: input.inputHash, sessionId: 'session-1',
        shots: [{ id: 'invalid', data: 'data:image/png;base64,' + png, sha256: '0'.repeat(64) }],
      } as unknown as HarnessBrowserEvidence;
    }),
    readResults: vi.fn(async () => []), close: vi.fn(async () => {}),
  };
  const { workspace } = await fixture({ browser, now: () => now, authorize: () => allowed, signal: controller.signal });
  await workspace.call(args('write', 'write', { path: 'game.html', content: game, expectedSha256: null }));
  await expect(workspace.call(args('bad-shot', 'play-start'))).rejects.toThrow('Original viewport image could not be verified.');
  allowed = false;
  await expect(workspace.call(args('unauthorized', 'capture'))).rejects.toThrow('Workspace tool is not authorized.');
  allowed = true;
  now = clock + 10_000;
  await expect(workspace.call(args('expired', 'list'))).rejects.toThrow('Workspace tool is no longer available.');
  expect(browser.execute).toHaveBeenCalledOnce();
  controller.abort();
  await workspace.close();
  expect(browser.close).toHaveBeenCalledOnce();
  expect((await workspace.readArtifact('game.html'))?.content).toBe(game);
  const { workspace: review } = await fixture({ purpose: 'review', vision: false, browser });
  expect(review.tools.map(tool => tool.name)).toEqual(['list', 'read', 'write', 'patch']);
  expect((await review.call(args('bad-output', 'write', { path: 'game.html', content: game, expectedSha256: null }))).is_error).toBe(true);
  expect((await review.call(args('result', 'write', { path: 'result.txt', content: '{}', expectedSha256: null }))).is_error).toBeUndefined();
});

it('exposes the accepted play action forms in the model tool schema', async () => {
  const { workspace } = await fixture({ browser: { execute: vi.fn(), readResults: vi.fn(), close: vi.fn() } });
  const play = workspace.tools.find(tool => tool.name === 'play-act')!;
  const coordinates = {
    x: { type: 'number', minimum: 0, exclusiveMaximum: 360 },
    y: { type: 'number', minimum: 0, exclusiveMaximum: 780 },
  };
  const duration = { type: 'integer', minimum: 0, maximum: 30_000 };
  expect(play.inputSchema).toMatchObject({
    required: ['sessionId', 'round'],
    properties: {
      round: {
        required: ['hypothesis', 'actions'], additionalProperties: false,
        properties: {
          hypothesis: { type: 'string', maxLength: 2000 },
          actions: {
            type: 'array', minItems: 1, maxItems: PLAY_LIMITS.actions,
            items: { oneOf: [
              { required: ['type', 'x', 'y'], properties: { type: { enum: ['tap', 'hold'] }, ...coordinates, durationMs: duration } },
              { required: ['type', 'x', 'y', 'toX', 'toY'],
                properties: { type: { enum: ['drag'] }, ...coordinates, toX: coordinates.x, toY: coordinates.y, durationMs: duration } },
              { required: ['type', 'path'], additionalProperties: false, properties: { type: { enum: ['drag'] }, path: {
                minItems: 2, maxItems: 32, items: { required: ['x', 'y', 'atMs'], additionalProperties: false,
                  properties: { ...coordinates, atMs: duration, capture: { type: 'boolean' } } },
              } } },
              { required: ['type', 'points'], properties: { type: { enum: ['multi-touch'] }, points: {
                minItems: 2, maxItems: 5, items: { required: ['x', 'y'], properties: coordinates },
              }, durationMs: duration } },
              { required: ['type'], properties: { type: { enum: ['wait', 'restart'] }, durationMs: duration } },
            ] },
          },
        },
      },
    },
  });
  expect(validatePlayActions([
    { type: 'tap', x: 359.5, y: 779.5 }, { type: 'hold', x: 0, y: 0, durationMs: 300 },
    { type: 'drag', x: 0, y: 0, toX: 80, toY: 40 },
    { type: 'drag', path: [{ x: 10, y: 20, atMs: 0 }, { x: 30, y: 40, atMs: 400, capture: true }] },
    { type: 'multi-touch', points: [{ x: 20, y: 30 }, { x: 50, y: 60 }] },
    { type: 'wait', durationMs: 100 }, { type: 'restart' },
  ], PLAY_LIMITS.actions)).toHaveLength(7);
  await workspace.close();
});

it('lets the model correct an invalid play round without spending a browser action', async () => {
  const image = await imageFile();
  const browser = {
    execute: vi.fn(async (value: unknown) => {
      const { name, arguments: input } = value as { name: string; arguments: { inputHash: string } };
      return { tool: name, inputHash: input.inputHash, sessionId: 'owned-session',
        shots: [{ id: name, data: 'data:image/png;base64,' + png, sha256: image.sha256 }],
      } as unknown as HarnessBrowserEvidence;
    }),
    readResults: vi.fn(async () => []), close: vi.fn(async () => {}),
  };
  const { workspace } = await fixture({ browser });
  const written = text(await workspace.call(args('write', 'write', { path: 'game.html', content: game, expectedSha256: null })));
  await workspace.call(args('open', 'play-start'));
  const usage = { inputTokens: 10, outputTokens: 5 };
  const action = (id: string, fields: object) => ({
    content: [{ type: 'tool_use' as const, id, name: 'play-act',
      input: { sessionId: 'owned-session', round: { hypothesis: 'Drag moves the game token.', actions: [fields] } } }],
    stopReason: 'tool_use', usage,
  });
  const validDrag = { type: 'drag', x: 90, y: 450, toX: 170, toY: 450, durationMs: 200 };
  const callModel = vi.fn(async (request: EmbeddedModelRequest) => {
    const previous = request.messages.at(-1)!.content[0];
    if (request.turn === 1) return action('invalid', { ...validDrag, toX: 540 });
    if (request.turn === 2) {
      expect(previous).toMatchObject({ type: 'tool_result', tool_use_id: 'invalid', is_error: true });
      expect(browser.execute).toHaveBeenCalledOnce();
      return action('corrected', validDrag);
    }
    expect(previous).toMatchObject({
      type: 'tool_result', tool_use_id: 'corrected',
      content: [expect.objectContaining({ type: 'text' }), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }],
    });
    expect(previous).not.toHaveProperty('is_error');
    return { content: [{ type: 'text' as const, text: 'Completed the corrected test.' }], stopReason: 'end_turn', usage };
  });
  const result = await runEmbeddedQuery({
    system: 'Synthetic workspace play check', model: 'synthetic', contextWindow: 128_000, maxOutputTokens: 2000,
    maxTotalOutputTokens: 4000, maxModelTurns: 3, signal: new AbortController().signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Test the original session' }] }], tools: workspace.tools,
  }, {
    callModel,
    runTool: async (call, signal) => {
      const value = await workspace.call(args(call.id, call.name, call.input), signal);
      return { content: value.content, isError: value.is_error };
    },
  });
  expect(result.reason).toBe('completed');
  expect(result.usage.modelCalls).toBe(3);
  expect(browser.execute).toHaveBeenCalledTimes(2);
  expect(browser.execute.mock.calls[1][0]).toMatchObject({
    name: 'play-act', arguments: { inputHash: written.sha256, sessionId: 'owned-session', round: { actions: [validDrag] } },
  });
  await workspace.close();
});

it.each([409, 410, 502])('terminates on a DO read failure or browser status %s without exposing error details', async status => {
  const image = await imageFile();
  const browser = {
    execute: vi.fn(async (value: unknown) => {
      const { arguments: input } = value as { arguments: { inputHash: string } };
      return { tool: 'play-start', inputHash: input.inputHash, sessionId: 'owned-session',
        shots: [{ id: 'verified', data: 'data:image/png;base64,' + png, sha256: image.sha256 }],
      } as unknown as HarnessBrowserEvidence;
    }),
    readResults: vi.fn(async () => []), close: vi.fn(async () => {}),
  };
  const { workspace, options } = await fixture({ browser });
  await workspace.call(args('write', 'write', { path: 'game.html', content: game, expectedSha256: null }));
  await workspace.call(args('open', 'play-start'));
  browser.execute.mockRejectedValueOnce(Object.assign(new Error('private browser response'), { status }));
  await expect(workspace.call(args('lost', 'play-act', { sessionId: 'owned-session', round: { hypothesis: 'Button responds.', actions: [{ type: 'tap', x: 80, y: 100 }] } })))
    .rejects.toThrow(/^Workspace tool could not complete safely\.$/);
  vi.spyOn(options.storage, 'transaction').mockRejectedValueOnce(new Error('private DO error'));
  await expect(workspace.call(args('broken-storage', 'list'))).rejects.toThrow(/^Workspace tool could not complete safely\.$/);
  await workspace.close();
});

it('does not start another model turn when workspace authority is revoked', async () => {
  let allowed = true;
  const { workspace } = await fixture({ authorize: () => allowed });
  const callModel = vi.fn(async () => {
    allowed = false;
    return { content: [{ type: 'tool_use' as const, id: 'denied', name: 'list', input: {} }],
      stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } };
  });
  const result = await runEmbeddedQuery({
    system: 'Synthetic workspace authorization check', model: 'synthetic', contextWindow: 128_000, maxOutputTokens: 2000,
    maxTotalOutputTokens: 4000, maxModelTurns: 3, signal: new AbortController().signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'List files' }] }], tools: workspace.tools,
  }, {
    callModel,
    runTool: async (call, signal) => {
      const value = await workspace.call(args(call.id, call.name, call.input), signal);
      return { content: value.content, isError: value.is_error };
    },
  });
  expect(result.reason).toBe('tool_error');
  expect(callModel).toHaveBeenCalledOnce();
  await workspace.close();
});

it('archives the normalized HTML before browser use and resumes only the exact pending preparation', async () => {
  const image = await imageFile();
  const browser = {
    execute: vi.fn(async (value: unknown) => {
      const { arguments: input } = value as { arguments: { inputHash: string; html: string } };
      expect(input.html).toBe(game);
      return { tool: 'capture', inputHash: input.inputHash,
        shots: Array.from({ length: 4 }, (_, index) => ({ id: 'fixture-' + index, data: 'data:image/png;base64,' + png, sha256: image.sha256 })),
      } as unknown as HarnessBrowserEvidence;
    }),
    readResults: vi.fn(async () => []), close: vi.fn(async () => {}),
  };
  const archive = vi.fn<NonNullable<Parameters<typeof openEmbeddedWorkspace>[0]['onArtifact']>>()
    .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private archive ambiguity')).mockResolvedValue(undefined);
  const { options, workspace } = await fixture({ browser, onArtifact: archive });
  const source = game.replace('<head>', '<head><script src="https://example.invalid/tool.js"></script>');
  const original = text(await workspace.call(args('original', 'write', { path: 'game.html', content: source, expectedSha256: null })));
  const capture = args('capture-normalized', 'capture');
  await expect(workspace.call(capture)).rejects.toBeInstanceOf(EmbeddedWorkspaceArtifactPersistenceError);
  const prepared = await workspace.readArtifact('game.html');
  expect(prepared?.content).toBe(game);
  expect(browser.execute).not.toHaveBeenCalled();
  await expect(workspace.call(args('unrelated-capture', 'capture'))).rejects.toBeInstanceOf(EmbeddedWorkspaceArtifactPersistenceError);
  expect(archive).toHaveBeenCalledTimes(2);
  await workspace.close();
  const reopened = await openEmbeddedWorkspace(options);
  const result = await reopened.call(capture);
  expect(text(result).workspacePreparation).toEqual({ path: 'game.html', beforeSha256: original.sha256, afterSha256: prepared?.sha256 });
  expect(archive.mock.calls[1]).toEqual(archive.mock.calls[2]);
  expect(archive.mock.calls[2][0]).toEqual(prepared);
  expect(archive).toHaveBeenCalledBefore(browser.execute);
  expect(browser.execute).toHaveBeenCalledOnce();
  await reopened.close();
});
