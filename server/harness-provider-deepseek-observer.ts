import { DEEPSEEK_RESEARCH_MODEL, deepSeekResearchAssistant, deepSeekResearchResultMatches } from './harness-provider-deepseek-fixture';

const invalid = () => new Error('deepseek_fixture_stream_invalid');
const maxBytes = 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function deepSeekResearchAssistantFrames(first: boolean) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reasoning: string[] = [];
  const text: string[] = [];
  const argumentsParts: string[] = [];
  let pending = '';
  let data: string[] = [];
  let bytes = 0;
  let completionId: string | undefined;
  let tool: { id: string; name: string } | undefined;
  let reason: string | undefined;
  let done = false;

  function event() {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (done) throw invalid();
    if (payload === '[DONE]') { done = true; return; }
    const value: unknown = JSON.parse(payload);
    if (!object(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
        completionId !== undefined && completionId !== value.id ||
        value.model !== DEEPSEEK_RESEARCH_MODEL || value.error != null || !Array.isArray(value.choices) ||
        value.choices.length > 1) throw invalid();
    completionId ??= value.id;
    if (!value.choices.length) return; // The gateway separately verifies native usage.
    const choice = value.choices[0];
    if (reason || !object(choice) || choice.index !== 0 || !object(choice.delta)) throw invalid();
    const delta = choice.delta;
    if (delta.role != null && delta.role !== 'assistant' || delta.function_call != null || delta.refusal != null) throw invalid();
    if (delta.reasoning_content != null) {
      if (typeof delta.reasoning_content !== 'string' || tool && delta.reasoning_content !== '') throw invalid();
      reasoning.push(delta.reasoning_content);
    }
    if (delta.content != null) {
      if (typeof delta.content !== 'string' || tool && delta.content !== '') throw invalid();
      if (delta.content !== '') text.push(delta.content);
    }
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 1) throw invalid();
      if (delta.tool_calls.length) {
        const call = delta.tool_calls[0];
        if (!first || !object(call) || call.index !== 0 || !object(call.function) ||
            (call.function.arguments != null && typeof call.function.arguments !== 'string')) throw invalid();
        if (!tool) {
          if (call.type !== 'function' || typeof call.id !== 'string' || typeof call.function.name !== 'string') throw invalid();
          tool = { id: call.id, name: call.function.name };
        } else if (call.id != null || call.type != null || call.function.name != null) throw invalid();
        argumentsParts.push((call.function.arguments as string | undefined) ?? '');
      }
    }
    if (choice.finish_reason != null) {
      const expected = first ? 'tool_calls' : 'stop';
      if (choice.finish_reason !== expected) throw invalid();
      reason = expected;
    }
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
    get ending() { return reason !== undefined; },
    push(chunk: Uint8Array) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw invalid();
      feed(decoder.decode(chunk, { stream: true }));
    },
    finish() {
      feed(decoder.decode(), true);
      if (!done || !reason || pending || data.length) throw invalid();
      if (!first) {
        if (!deepSeekResearchResultMatches(text.join(''))) throw invalid();
        return null;
      }
      if (!tool || !reasoning.length) throw invalid();
      return [deepSeekResearchAssistant(text.join('') || null, reasoning.join(''), tool.id, tool.name, argumentsParts.join(''))];
    },
  };
}
