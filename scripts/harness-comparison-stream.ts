import type { ComparisonStreamFrame, ComparisonStreamingTransport } from './harness-comparison-ledger';

type Protocol = 'anthropic' | 'openai';
type OpenInput = Parameters<ComparisonStreamingTransport['open']>[0];
type Outcome = Extract<ComparisonStreamFrame, { kind: 'terminal' }>['outcome'];

const maxFrameBytes = 2 * 1024 * 1024;
const maxResponseBytes = 12 * 1024 * 1024;
const finishReasons: Record<Protocol, readonly string[]> = {
  anthropic: ['end_turn', 'tool_use', 'stop_sequence', 'max_tokens', 'refusal', 'pause_turn'],
  openai: ['stop', 'tool_calls', 'function_call', 'length', 'content_filter'],
};
const truncated = new Set(['max_tokens', 'length']);
const rejected = new Set(['refusal', 'pause_turn', 'content_filter']);

function invalid(): never {
  throw new Error('Comparison supplier stream could not be verified');
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function tokens(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}

function frameFields(text: string) {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (name === 'event') event = value;
    if (name === 'data') data.push(value);
  }
  return { event, data: data.length ? data.join('\n') : undefined };
}

class NativeUsage {
  terminal = false;
  private started = false;
  private finishReason?: string;
  private finalOutput = false;
  private input: number | null = null;
  private output: number | null = null;
  private reasoning: number | null = null;

  constructor(private readonly protocol: Protocol) {}

  private usage(value: unknown, afterFinish: boolean) {
    if (value == null) return;
    if (!record(value)) return invalid();
    const anthropic = this.protocol === 'anthropic';
    const input = tokens(anthropic ? value.input_tokens : value.prompt_tokens);
    const output = tokens(anthropic ? value.output_tokens : value.completion_tokens);
    const details = value.completion_tokens_details;
    if (!anthropic && details != null && !record(details)) return invalid();
    const reasoning = anthropic || !record(details) ? null : tokens(details.reasoning_tokens);
    if (output !== null && this.output !== null && output < this.output) return invalid();
    this.input = input ?? this.input;
    this.output = output ?? this.output;
    this.reasoning = reasoning ?? this.reasoning;
    if (afterFinish && output !== null) this.finalOutput = true;
  }

  private finish(reason: unknown) {
    if (reason == null) return;
    if (typeof reason !== 'string' || !finishReasons[this.protocol].includes(reason) ||
        this.finishReason && this.finishReason !== reason) return invalid();
    this.finishReason = reason;
  }

  accept({ event, data }: ReturnType<typeof frameFields>) {
    if (event === 'error' || this.terminal && (data !== undefined || event !== undefined)) return invalid();
    if (data === undefined) return;
    if (this.protocol === 'openai') {
      if (event !== undefined && event !== 'message') return invalid();
      if (data === '[DONE]') { this.terminal = true; return; }
    }

    const value: unknown = JSON.parse(data);
    if (!record(value) || value.type === 'error' || value.error != null) return invalid();
    if (this.protocol === 'anthropic') {
      if (typeof value.type !== 'string' || event !== undefined && event !== value.type) return invalid();
      if (value.type === 'message_start') {
        if (this.started || !record(value.message)) return invalid();
        this.started = true;
        this.usage(value.message.usage, false);
      } else if (value.type === 'message_delta') {
        if (!this.started || !record(value.delta)) return invalid();
        this.finish(value.delta.stop_reason);
        this.usage(value.usage, Boolean(this.finishReason));
      } else if (value.type === 'message_stop') {
        if (!this.started) return invalid();
        this.terminal = true;
      }
      return;
    }

    if (!Array.isArray(value.choices) || value.choices.length > 1) return invalid();
    const choice: unknown = value.choices[0];
    if (choice !== undefined) {
      if (!record(choice) || choice.index !== undefined && choice.index !== 0) return invalid();
      this.finish(choice.finish_reason);
    }
    this.usage(value.usage, Boolean(this.finishReason));
  }

  outcome(): Outcome {
    if (!this.terminal || !this.finishReason || !this.finalOutput || this.output === null ||
        this.reasoning !== null && this.reasoning > this.output) return invalid();
    // Native output totals already include reasoning tokens.
    const usage = { inputTokens: this.input, outputTokens: this.output };
    if (truncated.has(this.finishReason)) return { state: 'failed', failureCode: 'truncated', ...usage };
    if (rejected.has(this.finishReason)) return { state: 'failed', failureCode: 'invalid-response', ...usage };
    return { state: 'completed', ...usage };
  }
}

/** Read one complete SSE frame at a time and retain the exact wire bytes. */
class ByteFrames {
  private chunk: Uint8Array = new Uint8Array();
  private offset = 0;
  private done = false;
  private total = 0;
  private buffer = new Uint8Array(1024);
  private size = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private append(byte: number) {
    if (this.size === maxFrameBytes) return invalid();
    if (this.size === this.buffer.length) {
      const expanded = new Uint8Array(this.buffer.length * 2);
      expanded.set(this.buffer);
      this.buffer = expanded;
    }
    this.buffer[this.size++] = byte;
  }

  async next(): Promise<Uint8Array | null> {
    let lineBytes = 0;
    let cr = false;
    while (true) {
      if (this.offset === this.chunk.length && !this.done) {
        const part = await this.reader.read();
        this.done = part.done;
        if (!part.done) {
          if (!(part.value instanceof Uint8Array)) return invalid();
          this.total += part.value.length;
          if (this.total > maxResponseBytes) return invalid();
          this.chunk = part.value;
          this.offset = 0;
          if (!this.chunk.length) continue;
        }
      }
      const byte = this.done ? undefined : this.chunk[this.offset];
      if (cr && byte !== 10) {
        if (lineBytes === 0) break;
        lineBytes = 0;
      }
      if (byte === undefined) {
        if (this.size !== 0) return invalid();
        return null;
      }
      this.offset++;
      this.append(byte);
      cr = byte === 13;
      if (byte === 10) {
        if (lineBytes === 0) break;
        lineBytes = 0;
      } else if (!cr) {
        lineBytes++;
      }
    }
    const frame = this.buffer.slice(0, this.size);
    this.size = 0;
    return frame;
  }
}

function responseFrames(body: ReadableStream<Uint8Array>, protocol: Protocol) {
  const reader = body.getReader();
  const frames = new ByteFrames(reader);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const usage = new NativeUsage(protocol);
  let first = true;
  let released = false;
  function release(cancel: boolean) {
    if (released) return;
    released = true;
    if (cancel) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new ReadableStream<ComparisonStreamFrame>({
    async pull(controller) {
      try {
        let held: Uint8Array = new Uint8Array();
        let heldBytes = 0;
        while (true) {
          const bytes = await frames.next();
          if (released) return;
          if (bytes === null) {
            const outcome = usage.outcome();
            release(false);
            controller.enqueue({ kind: 'terminal', bytes: held.subarray(0, heldBytes), outcome });
            controller.close();
            return;
          }
          const text = decoder.decode(bytes);
          usage.accept(frameFields(first ? text.replace(/^\uFEFF/, '') : text));
          first = false;
          if (!usage.terminal) {
            controller.enqueue({ kind: 'data', bytes });
            return;
          }
          // Match the gateway's clean EOF requirement. Keep the sole terminal
          // plus trailing comments/empty frames out of the client stream.
          const end = heldBytes + bytes.length;
          if (end > maxFrameBytes) return invalid();
          if (end > held.length) {
            const expanded = new Uint8Array(Math.min(maxFrameBytes, Math.max(end, held.length * 2)));
            expanded.set(held);
            held = expanded;
          }
          held.set(bytes, heldBytes);
          heldBytes = end;
        }
      } catch {
        if (!released) {
          release(true);
          controller.error(new Error('Comparison supplier stream could not be verified'));
        }
      }
    },
    cancel() { release(true); },
  }, { highWaterMark: 0 });
}

/** Register this transport under the approved route's transport ID. The host
 * supplies one fixed provider request implementation with manual redirects
 * and owns its credential. */
export function createComparisonSseTransport(options: {
  kind: ComparisonStreamingTransport['kind'];
  modelContractHash: string;
  protocol: Protocol;
  fetchResponse(input: OpenInput): Promise<Response>;
}): ComparisonStreamingTransport {
  const { kind, modelContractHash, protocol, fetchResponse } = options;
  if (protocol !== 'anthropic' && protocol !== 'openai') return invalid();
  return {
    kind, modelContractHash,
    async open(input) {
      if (input.signal.aborted) return invalid();
      let response: Response;
      try { response = await fetchResponse(input); } catch { return invalid(); }
      if (input.signal.aborted || response.redirected || !response.ok || !response.body ||
          !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        if (input.signal.aborted || response.redirected) return invalid();
        const status = response.status;
        const redirect = status >= 300 && status < 400;
        // The existing gateway treats HTTP 408/409 and 5xx as potentially paid.
        if (!redirect && !(status >= 400 && status < 500 && status !== 408 && status !== 409)) return invalid();
        return {
          kind: 'rejected',
          response: new Response(null, { status: redirect ? 502 : status, headers: { 'cache-control': 'no-store' } }),
          outcome: { state: 'failed', failureCode: 'provider-rejected', inputTokens: null, outputTokens: null },
        };
      }
      return {
        kind: 'stream',
        head: new Response(null, { status: response.status, headers: {
          'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        } }),
        frames: responseFrames(response.body, protocol),
      };
    },
  };
}
