import { harnessSha256, type HarnessDatabase, type HarnessRequestIdentity } from './harness-ledger';
import { canonicalHarness } from './harness-policy';
import type { HarnessFailureCode, HarnessRunIdentity } from './harness-protocol';
import { DEEPSEEK_RESEARCH_FIXTURE_ID } from './harness-provider-deepseek-fixture';

const maxBytes = 1024 * 1024;
const maxBlocks = 32;
const bad = () => new Error('research_assistant_digest_failed');
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export type ProviderResearchAssistantReceipt = HarnessRequestIdentity & { assistantSha256: string };

export function providerResearchAssistantDigest(content: readonly unknown[]) {
  return harnessSha256(canonicalHarness(content));
}

/** Stage a digest in the isolated research database. Only published digests can authorize continuations. */
export async function recordProviderResearchAssistantDigest(db: HarnessDatabase, receipt: ProviderResearchAssistantReceipt) {
  const result = await db.prepare(`INSERT INTO provider_research_assistant_digests(task_id,generation,request_id,assistant_sha256)
    SELECT r.task_id,r.generation,r.request_id,? FROM harness_requests r
    JOIN harness_runs run ON run.task_id=r.task_id AND run.generation=r.generation
    WHERE r.task_id=? AND r.generation=? AND r.request_id=? AND r.state='completed' AND run.status='active'
      AND (r.finish_reason='tool_use' AND run.protocol='anthropic'
        OR r.finish_reason='tool_calls' AND run.protocol='openai' AND run.model='deepseek-flash' AND run.purpose='review'
          AND json_extract(run.snapshot,'$.fixtureId')=?)
    ON CONFLICT DO NOTHING RETURNING request_id`)
    .bind(receipt.assistantSha256, receipt.taskId, receipt.generation, receipt.requestId, DEEPSEEK_RESEARCH_FIXTURE_ID).first<{ request_id: string }>();
  if (!result) throw bad();
}

export async function publishProviderResearchAssistantDigest(db: HarnessDatabase, receipt: ProviderResearchAssistantReceipt) {
  const result = await db.prepare(`UPDATE provider_research_assistant_digests SET published=1
    WHERE task_id=? AND generation=? AND request_id=? AND assistant_sha256=? AND published=0
      AND EXISTS(SELECT 1 FROM harness_runs WHERE task_id=? AND generation=? AND status='active')
    RETURNING request_id`)
    .bind(receipt.taskId, receipt.generation, receipt.requestId, receipt.assistantSha256, receipt.taskId, receipt.generation).first();
  if (!result) throw bad();
}

export async function revokeProviderResearchAssistantDigest(db: HarnessDatabase, identity: HarnessRequestIdentity) {
  await db.prepare('DELETE FROM provider_research_assistant_digests WHERE task_id=? AND generation=? AND request_id=?')
    .bind(identity.taskId, identity.generation, identity.requestId).run();
}

export async function readProviderResearchPriorAssistantDigest(db: HarnessDatabase, run: HarnessRunIdentity): Promise<ProviderResearchAssistantReceipt | null> {
  const result = await db.prepare(`SELECT d.request_id,d.assistant_sha256 FROM provider_research_assistant_digests d
    JOIN harness_runs run ON run.task_id=d.task_id AND run.generation=d.generation
    WHERE d.task_id=? AND d.generation=? AND run.status='active' AND d.published=1
      AND (SELECT count(*) FROM provider_research_assistant_digests WHERE task_id=? AND generation=? AND published=1)=1`)
    .bind(run.taskId, run.generation, run.taskId, run.generation).first<{ request_id: string; assistant_sha256: string }>();
  return result ? { taskId: run.taskId, generation: run.generation, requestId: result.request_id, assistantSha256: result.assistant_sha256 } : null;
}

/** Mirrors pinned CCB's block assembly. Frames and reasoning remain transient. */
function assistantBlocks() {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const content: Record<string, unknown>[] = [];
  let pending = '';
  let data: string[] = [];
  let bytes = 0;
  let started = false;
  let stopped = false;
  let active: { block: Record<string, unknown>; field: string; deltas: string[] } | undefined;
  let stopReason: string | undefined;

  function event() {
    if (!data.length) return;
    const value: unknown = JSON.parse(data.join('\n'));
    data = [];
    if (!isObject(value) || stopped) throw bad();
    if (value.type === 'ping') return;
    if (value.type === 'message_start') {
      if (started || !isObject(value.message) || value.message.role !== 'assistant' ||
          !Array.isArray(value.message.content) || value.message.content.length !== 0) throw bad();
      started = true;
      return;
    }
    if (!started) throw bad();
    if (value.type === 'message_delta') {
      if (active || !isObject(value.delta)) throw bad();
      if (value.delta.stop_reason != null) {
        if (stopReason || typeof value.delta.stop_reason !== 'string') throw bad();
        stopReason = value.delta.stop_reason;
      }
      return;
    }
    if (value.type === 'message_stop') {
      if (active || !stopReason) throw bad();
      stopped = true;
      return;
    }
    if (stopReason || value.index !== content.length || content.length >= maxBlocks) throw bad();
    if (value.type === 'content_block_start') {
      if (active || !isObject(value.content_block)) throw bad();
      const block = { ...value.content_block };
      const field = block.type === 'text' ? 'text' : block.type === 'thinking' ? 'thinking' : block.type === 'tool_use' ? 'input' : '';
      if (!field && (block.type !== 'redacted_thinking' || typeof block.data !== 'string')) throw bad();
      if (block.type === 'tool_use') {
        if (typeof block.id !== 'string' || typeof block.name !== 'string') throw bad();
        if (Object.hasOwn(block, 'caller')) {
          const { caller } = block;
          if (!isObject(caller) || Object.keys(caller).length !== 1 || caller.type !== 'direct') throw bad();
          // Pinned CCB strips caller from its continuation with tool search disabled.
          delete block.caller;
        }
      }
      if (block.type === 'thinking') block.signature = '';
      active = { block, field, deltas: [] };
      return;
    }
    if (!active) throw bad();
    if (value.type === 'content_block_delta') {
      if (!isObject(value.delta)) throw bad();
      const { delta } = value;
      if (active.field === 'thinking' && delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        active.block.signature = delta.signature;
        return;
      }
      const deltaField = active.field === 'input' ? 'partial_json' : active.field;
      const deltaType = active.field === 'input' ? 'input_json_delta' : `${active.field}_delta`;
      const text = delta[deltaField];
      if (!active.field || delta.type !== deltaType || typeof text !== 'string') throw bad();
      active.deltas.push(text);
      return;
    }
    if (value.type !== 'content_block_stop') throw bad();
    if (active.field) {
      const text = active.deltas.join('');
      const reconstructed = active.field === 'input' ? JSON.parse(text || '{}') : text;
      if (active.field === 'input' && !isObject(reconstructed)) throw bad();
      active.block[active.field] = reconstructed;
    }
    content.push(active.block);
    active = undefined;
  }

  function feed(text: string, final = false) {
    const endOfLine = /\r\n|[\r\n]/g;
    endOfLine.lastIndex = pending.length - Number(pending.endsWith('\r'));
    pending += text;
    let offset = 0;
    for (let match = endOfLine.exec(pending); match; match = endOfLine.exec(pending)) {
      const end = endOfLine.lastIndex;
      if (!final && match[0] === '\r' && end === pending.length) break;
      const line = pending.slice(offset, match.index);
      offset = end;
      if (!line) event();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    pending = pending.slice(offset);
  }

  return {
    get ending() { return stopReason !== undefined; },
    push(chunk: Uint8Array) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw bad();
      feed(decoder.decode(chunk, { stream: true }));
    },
    finish() {
      feed(decoder.decode(), true);
      if (!stopped || pending || data.length) throw bad();
      if (stopReason !== 'tool_use') return null;
      if (!content.some(block => block.type === 'tool_use')) throw bad();
      return content;
    },
  };
}

interface ObservationOptions {
  record(receipt: ProviderResearchAssistantReceipt): Promise<void>;
  publish(receipt: ProviderResearchAssistantReceipt): Promise<void>;
  fail(code: HarnessFailureCode): Promise<void>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

type AssistantFrames = { readonly ending: boolean; push(chunk: Uint8Array): void; finish(): readonly unknown[] | null };

export function observeProviderResearchAssistant(response: Response, identity: HarnessRequestIdentity, signal: AbortSignal,
  options: ObservationOptions, assistant: AssistantFrames = assistantBlocks()): Response {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) return response;
  const reader = response.body.getReader();
  const tail: Uint8Array[] = [];
  let delivered = false;
  let closing: Promise<void> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const stop = (code: HarnessFailureCode) => {
    if (delivered || closing) return closing;
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    closing = options.fail(code).catch(() => {}).then(() => {
      try { streamController.error(bad()); } catch { /* Downstream already cancelled. */ }
    });
    options.waitUntil?.(closing);
    return closing;
  };
  const abort = () => { void stop('client_disconnected'); };
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        while (!closing) {
          const { done, value } = await reader.read();
          if (closing) return;
          signal.throwIfAborted();
          if (done) {
            const content = assistant.finish();
            if (content) {
              const assistantSha256 = await providerResearchAssistantDigest(content);
              if (closing) return;
              signal.throwIfAborted();
              const receipt = { taskId: identity.taskId, generation: identity.generation, requestId: identity.requestId, assistantSha256 };
              await options.record(receipt);
              if (closing) return;
              signal.throwIfAborted();
              await options.publish(receipt);
            }
            if (closing) return;
            signal.throwIfAborted();
            for (const chunk of tail) controller.enqueue(chunk);
            controller.close();
            delivered = true;
            signal.removeEventListener('abort', abort);
            reader.releaseLock();
            return;
          }
          assistant.push(value);
          // The caller can send its continuation as soon as it sees the terminal event.
          if (assistant.ending) tail.push(value);
          else { controller.enqueue(value); return; }
        }
      } catch {
        await stop(signal.aborted ? 'client_disconnected' : 'stream_invalid');
      }
    },
    cancel() {
      return stop('client_disconnected');
    },
  }), { status: response.status, headers: response.headers });
}
