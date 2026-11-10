import type {
  EmbeddedAssistantBlock, EmbeddedImageBlock, EmbeddedMessage, EmbeddedQueryDeps, EmbeddedTool, EmbeddedToolResultBlock,
  EmbeddedToolResultPart, EmbeddedToolUse,
} from './types';
import { all, collectToolUses, partitionToolCalls } from './upstream';

const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const readConcurrency = 10; // CCB's default non-streaming read-only batch limit.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}
function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid embedded CCB message or tool configuration');
}
function isImage(value: unknown): value is EmbeddedImageBlock {
  return isRecord(value) && value.type === 'image' && isRecord(value.source) && value.source.type === 'base64' &&
    typeof value.source.media_type === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(value.source.media_type) &&
    typeof value.source.data === 'string' && value.source.data.length > 0;
}
function isToolResultPart(value: unknown): value is EmbeddedToolResultPart {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string' || isImage(value);
}
function isToolResultContent(value: unknown): value is string | readonly EmbeddedToolResultPart[] {
  return typeof value === 'string' || Array.isArray(value) && value.length > 0 && value.every(isToolResultPart);
}
function isAssistantBlock(value: unknown): value is EmbeddedAssistantBlock {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'text': return typeof value.text === 'string';
    case 'thinking': return typeof value.thinking === 'string' && (value.signature === undefined || typeof value.signature === 'string');
    case 'redacted_thinking': return typeof value.data === 'string' && value.data.length > 0;
    case 'tool_use':
      return typeof value.id === 'string' && identifier.test(value.id) && typeof value.name === 'string' &&
        identifier.test(value.name) && isRecord(value.input);
    default: return false;
  }
}
function isUserBlock(value: unknown): boolean {
  return isToolResultPart(value) || isRecord(value) && value.type === 'tool_result' &&
    typeof value.tool_use_id === 'string' && identifier.test(value.tool_use_id) &&
    (value.is_error === undefined || typeof value.is_error === 'boolean') && isToolResultContent(value.content);
}

export function assistantTools(content: readonly EmbeddedAssistantBlock[], seen: Set<string>) {
  assert(Array.isArray(content) && content.length > 0 && content.every(isAssistantBlock));
  const continuation = collectToolUses<EmbeddedAssistantBlock>({ message: { content } });
  for (const tool of continuation.toolUseBlocks) {
    assert(!seen.has(tool.id));
    seen.add(tool.id);
  }
  return continuation;
}

/** CCB ensureToolResultPairing's strict branch, limited to client tool blocks. */
export function verifySeedPairing(messages: readonly EmbeddedMessage[]) {
  assert(Array.isArray(messages) && messages[0]?.role === 'user' && messages.at(-1)?.role === 'user');
  const seen = new Set<string>();
  let expected = new Set<string>();
  for (const message of messages) {
    assert(isRecord(message) && Array.isArray(message.content) && message.content.length > 0);
    if (message.role === 'assistant') {
      assert(expected.size === 0);
      expected = new Set(assistantTools(message.content, seen).toolUseBlocks.map(tool => tool.id));
      continue;
    }
    assert(message.role === 'user' && message.content.every(isUserBlock));
    let ordinary = false;
    for (const block of message.content) {
      if (block.type === 'tool_result') assert(!ordinary && expected.delete(block.tool_use_id));
      else ordinary = true;
    }
    assert(expected.size === 0);
  }
  return seen;
}

export function bindTools(tools: readonly EmbeddedTool[]) {
  const bound = new Map<string, EmbeddedTool>();
  for (const tool of tools) {
    assert(typeof tool.name === 'string' && identifier.test(tool.name) && !bound.has(tool.name) && isRecord(tool.inputSchema) &&
      (tool.description === undefined || typeof tool.description === 'string') &&
      (tool.readOnly === undefined || typeof tool.readOnly === 'boolean') &&
      (tool.validateInput === undefined || typeof tool.validateInput === 'function'));
    bound.set(tool.name, { ...tool, inputSchema: structuredClone(tool.inputSchema) });
  }
  return bound;
}

/** The runner owns the signal; an ignored late response is never accepted or replayed. */
export async function untilAbort<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Embedded CCB interrupted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([stopped, work()]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

const interrupted = 'Interrupted by user';
function toolError(tool: EmbeddedToolUse, content: string): EmbeddedToolResultBlock {
  return { type: 'tool_result', tool_use_id: tool.id, content, is_error: true };
}

/** Port of CCB runTools' non-streaming route and its completion-order merge. */
export async function runTools(toolUses: readonly EmbeddedToolUse[], tools: ReadonlyMap<string, EmbeddedTool>,
  runTool: EmbeddedQueryDeps['runTool'], signal: AbortSignal) {
  const stop = new AbortController();
  const toolSignal = AbortSignal.any([signal, stop.signal]);
  let fatal = false;
  const validated = toolUses.map(use => {
    const tool = tools.get(use.name);
    let valid = Boolean(tool);
    try { if (tool?.validateInput) valid = tool.validateInput(structuredClone(use.input)) === true; }
    catch { valid = false; }
    return { use, tool, valid };
  });
  type Item = typeof validated[number];
  async function* execute({ use, tool, valid }: Item): AsyncGenerator<EmbeddedToolResultBlock, void> {
    if (toolSignal.aborted) yield toolError(use, interrupted);
    else if (!tool) yield toolError(use, `<tool_use_error>Error: No such tool available: ${use.name}</tool_use_error>`);
    else if (!valid) yield toolError(use, 'Tool input is invalid.');
    else {
      let result: EmbeddedToolResultBlock;
      try {
        const outcome = await untilAbort(() => runTool(structuredClone(use), toolSignal), toolSignal);
        assert(isRecord(outcome) && isToolResultContent(outcome.content) && (outcome.isError === undefined || typeof outcome.isError === 'boolean'));
        result = { type: 'tool_result', tool_use_id: use.id, content: structuredClone(outcome.content),
          ...(outcome.isError === true ? { is_error: true } : {}) };
      } catch {
        if (!toolSignal.aborted) { fatal = true; stop.abort(); }
        result = toolError(use, interrupted);
      }
      yield result;
    }
  }
  const batches = partitionToolCalls(validated, item => item.valid && item.tool?.readOnly === true);
  const results: EmbeddedToolResultBlock[] = [];
  for (const batch of batches) {
    if (toolSignal.aborted) break;
    const outputs = batch.isConcurrencySafe ? all(batch.blocks.map(execute), readConcurrency) : execute(batch.blocks[0]);
    for await (const result of outputs) results.push(result);
  }
  // CCB closes dangling tool-use IDs on cancellation before ending the turn.
  if (toolSignal.aborted) {
    const complete = new Set(results.map(result => result.tool_use_id));
    for (const use of toolUses) if (!complete.has(use.id)) results.push(toolError(use, interrupted));
  }
  return { results, fatal };
}
