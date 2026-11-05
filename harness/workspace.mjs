import { fileEntry, LIMITS, sha256 } from './envelope.mjs';

const string = { type: 'string' };
const integer = { type: 'integer', minimum: 0 };
const remoteTools = new Set(['capture', 'play-start', 'play-act', 'play-finish', 'play-close']);
const tools = [
  { name: 'list', description: 'List private task files and artifact paths.', properties: {}, required: [] },
  { name: 'read', description: 'Read UTF-8 text using zero-based character offsets. Read successive chunks using nextOffset. Images are included directly in the user message.', properties: { path: string, offset: integer }, required: ['path'] },
  { name: 'write', description: 'Write a complete UTF-8 artifact to an allowed output path.', properties: { path: string, content: string }, required: ['path', 'content'] },
  { name: 'patch', description: 'Replace one exact, unique UTF-8 string in an existing output artifact. Include enough context to identify exactly one occurrence.', properties: { path: string, oldText: string, newText: string }, required: ['path', 'oldText', 'newText'] },
  { name: 'capture', description: 'Capture and probe the exact current game.html in an isolated mobile browser. Inspect the returned original viewport images and probe evidence.', properties: {}, required: [] },
  { name: 'play-start', description: 'Start an isolated mobile play session for the exact current game.html and return its first viewport image.', properties: {}, required: [] },
  { name: 'play-act', description: 'Perform one bounded play round against the original session. Specify actions such as tap (x,y), hold, drag with optional timed path points, multi-touch, wait, or restart per the platform play schema.', properties: { sessionId: string, round: { type: 'object' } }, required: ['sessionId', 'round'] },
  { name: 'play-finish', description: 'Finish a mobile play session and lock its evidence.', properties: { sessionId: string }, required: ['sessionId'] },
  { name: 'play-close', description: 'Close the isolated mobile play session.', properties: { sessionId: string }, required: ['sessionId'] },
].map(({ name, description, properties, required }) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
}));

function selectedTools(run) {
  return tools.filter(tool => !remoteTools.has(tool.name) || (run.purpose === 'game' && run.vision !== false));
}

export function permittedTools(run) {
  return new Set(selectedTools(run).map(({ name }) => `mcp__pgc_workspace__${name}`));
}

export async function workspaceResponse(context, request, gateway) {
  const id = request?.id ?? null;
  const respond = result => ({ jsonrpc: '2.0', id, result });
  const error = message => ({ jsonrpc: '2.0', id, error: { code: -32602, message } });
  const output = (value, isError = false) => respond({
    isError,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  });
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error('Invalid request');
  if (request.method === 'notifications/initialized' && id === null) return null;
  if (request.method === 'initialize') {
    return respond({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'pgc-workspace', version: '1.0.0' },
    });
  }
  if (request.method === 'ping') return respond({});
  if (request.method === 'tools/list') return respond({ tools: selectedTools(context.run) });
  if (request.method !== 'tools/call') return error('Unsupported method');
  const { name, arguments: args } = request.params ?? {};
  const tool = selectedTools(context.run).find(candidate => candidate.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args) ||
      !tool.inputSchema.required.every(key => Object.hasOwn(args, key)) ||
      !Object.entries(args).every(([key, value]) => {
        const type = tool.inputSchema.properties[key]?.type;
        if (type === 'string') return typeof value === 'string';
        if (type === 'integer') return Number.isSafeInteger(value) && value >= 0;
        return type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value);
      })) return error('Invalid tool arguments');

  if (remoteTools.has(name)) {
    try {
      return respond(await browserTool(context, gateway, name, id, args));
    } catch {
      return output({ error: 'Browser tool could not complete with verified evidence' }, true);
    }
  }
  if (name === 'list') {
    return output({
      files: [...context.files.values()].map(({ path, encoding, sha256 }) => ({ path, encoding, sha256 })),
      writable: context.outputs,
    });
  }
  const entry = context.files.get(args.path);
  if (name === 'read') {
    if (entry?.encoding !== 'utf8') return output({ error: 'Readable text file not found' }, true);
    const offset = args.offset ?? 0;
    if (offset > entry.content.length) return output({ error: 'Invalid offset' }, true);
    let end = Math.min(offset + 20_000, entry.content.length);
    const code = entry.content.charCodeAt(end - 1);
    if (end < entry.content.length && code >= 0xd800 && code <= 0xdbff) end++;
    return output({ content: entry.content.slice(offset, end), nextOffset: end < entry.content.length ? end : null, sha256: entry.sha256 });
  }
  if (!context.outputs.includes(args.path)) return output({ error: 'Path is outside the writable artifacts' }, true);
  let content = args.content;
  if (name === 'patch') {
    const position = entry?.content.indexOf(args.oldText) ?? -1;
    if (!args.oldText || position < 0 || entry.content.indexOf(args.oldText, position + 1) !== -1) {
      return output({ error: 'Patch must match exactly one occurrence' }, true);
    }
    content = entry.content.slice(0, position) + args.newText + entry.content.slice(position + args.oldText.length);
  }
  if (Buffer.byteLength(content) > LIMITS.fileBytes) return output({ error: 'File exceeds the artifact limit' }, true);
  const saved = fileEntry(args.path, content);
  context.files.set(args.path, saved);
  return output({ path: saved.path, sha256: saved.sha256 });
}


const imageData = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

async function browserTool(context, gateway, name, id, args) {
  if (context.abort.signal.aborted || (typeof id !== 'number' && typeof id !== 'string') ||
      context.browserToolIds.has(id) || context.browserToolIds.size >= 32) throw new Error('Browser tool denied');
  const { run } = context;
  const opening = name === 'capture' || name === 'play-start';
  const entry = opening ? context.files.get('game.html') : null;
  const inputHash = opening ? entry?.sha256 : context.browserSessions.get(args.sessionId);
  const { browserBudget } = context;
  if (!inputHash || (opening && browserBudget.screenshots >= 12) ||
      (name === 'capture' && (browserBudget.captures >= 3 || browserBudget.screenshots > 8))) throw new Error('Browser tool input unavailable');

  const invocation = `tool-${sha256(JSON.stringify([run.runId, id])).slice(0, 48)}`;
  context.browserToolIds.add(id);
  if (name === 'capture') browserBudget.captures++;
  const response = await fetch(`${gateway}/v1/tools`, {
    method: 'POST', redirect: 'manual', signal: context.abort.signal,
    headers: {
      authorization: `Bearer ${context.lease}`,
      'content-type': 'application/json',
      'x-pgc-harness-task': run.taskId,
      'x-pgc-harness-generation': run.generation,
    },
    body: JSON.stringify({
      name, id: invocation,
      arguments: { ...args, inputHash, ...(entry && { html: entry.content }) },
    }),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Browser tool request failed');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    if ((bytes += chunk.length) > 15 * 1024 * 1024) throw new Error('Browser evidence exceeds limit');
    chunks.push(chunk);
  }
  const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.inputHash !== inputHash) {
    throw new Error('Browser evidence does not match task material');
  }
  if (name === 'play-start') {
    if (typeof evidence.sessionId !== 'string') throw new Error('Missing browser session');
    context.browserSessions.set(evidence.sessionId, inputHash);
  }
  if (name === 'play-finish' || name === 'play-close') context.browserSessions.delete(args.sessionId);

  const images = [];
  const metadata = JSON.parse(JSON.stringify(evidence, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.data !== 'string') return value;
    const raw = imageData.exec(value.data);
    const mediaType = raw?.[1] ?? value.mimeType ?? value.mediaType;
    const data = raw?.[2] ?? value.data;
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mediaType) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > 3 * 1024 * 1024 || images.length >= 12) {
      throw new Error('Invalid original image');
    }
    const buffer = Buffer.from(data, 'base64');
    if (buffer.toString('base64') !== data) throw new Error('Invalid image encoding');
    const digest = sha256(buffer);
    if (value.sha256 !== undefined && value.sha256 !== digest) throw new Error('Original image hash mismatch');
    images.push({ type: 'image', data, mimeType: mediaType });
    const { data: _data, ...details } = value;
    return { ...details, sha256: digest, imageNumber: images.length };
  }));
  browserBudget.screenshots += images.length;
  if (browserBudget.screenshots > 12) throw new Error('Original screenshot budget exceeded');
  if ((name === 'capture' || name === 'play-start') && images.length === 0) throw new Error('Missing original viewport images');
  return { content: [{ type: 'text', text: JSON.stringify(metadata) }, ...images] };
}
