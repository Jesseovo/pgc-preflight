import { afterEach, describe, expect, it, vi } from 'vitest';
import { complete } from '../server/forge-llm';
import { encryptKey } from '../server/settings';
import { reviewReportErrors } from '../server/review-report';
import { REVIEW_SCHEMA } from '../server/forge/prompts.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const report = () => ({ aes: 3, ease: 2, play: 2, score_reasons: { aes: '截图配色协调', ease: '截图提示清楚', play: '源码机制推断，尚未完整试玩' }, uncertainties: ['未验证真实手感'], verdict: '通过', reviewer_comment: '合成审核', strengths: ['合成优点'], issues: [], fix_prompt: '合成修改指令' });
async function setup() {
  const encryptedKey = await encryptKey('fixture-key', 'fixture-secret');
  const env = { SETTINGS_KEY: 'fixture-secret', modelStore: { get: async () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', encryptedKey, enabled: true }) } };
  const onWait = vi.fn();
  return { onWait, run: () => complete(env, {}, { system: 'fixture', user: 'fixture', schema: REVIEW_SCHEMA, validate: reviewReportErrors, purpose: 'review', maxTokens: 8192, idempotencyKey: 'fixture-review', onWait }) };
}
const json = (value: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });

describe('审核输出校验与恢复', () => {
  it('只无损转换合法数字字符串，不补默认分数，不接受越界或残缺的问题条目', () => {
    const valid = { ...report(), aes: '3', ease: ' 2 ' };
    expect(reviewReportErrors(valid)).toEqual([]);
    expect(valid.aes).toBe(3);
    const broken = { ...report(), aes: 4, play: undefined, issues: [{ problem: 'partial' }] };
    expect(reviewReportErrors(broken)).toEqual(expect.arrayContaining(['aes', 'play', 'issues[0].evidence', 'issues[0].fix']));
    expect(broken.play).toBeUndefined();
  });

  it('缺少评分依据或待验证列表时拒绝报告，不补写理由', () => {
    const broken = { ...report(), score_reasons: { aes: '', ease: '观察', play: undefined }, uncertainties: undefined };
    expect(reviewReportErrors(broken)).toEqual(expect.arrayContaining(['score_reasons.aes', 'score_reasons.play', 'uncertainties']));
    expect(broken.score_reasons.play).toBeUndefined();
  });

  it('缺字段的JSON会把具体格式问题交回模型，使用新幂等键获取完整评分报告', async () => {
    vi.useFakeTimers();
    const { run, onWait } = await setup();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (fetchMock.mock.calls.length === 1) return json({ aes: 2 });
      expect(body.messages.at(-1).content).toContain('reviewer_comment');
      return json(report());
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = run();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toEqual(report());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenCalledWith(expect.stringContaining('重新生成（2/3）'));
    expect(fetchMock.mock.calls[0][1]?.headers).not.toEqual(fetchMock.mock.calls[1][1]?.headers);
  });

  it('思考耗尽额度会增加预算重生成，始终不向报告泄露思考文本', async () => {
    vi.useFakeTimers();
    const { run } = await setup();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) return Response.json({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'private reasoning' } }] });
      expect(JSON.parse(String(init?.body)).max_tokens).toBe(16384);
      expect(String(init?.body)).not.toContain('private reasoning');
      return json(report());
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = run();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toEqual(report());
  });

  it('连续残缺报告只尝试三次，失败时不保存一个伪造的成功结果', async () => {
    vi.useFakeTimers();
    const { run } = await setup();
    const fetchMock = vi.fn(async () => json({ aes: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = run();
    const check = expect(result).rejects.toThrow('模型评分报告字段不完整');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1500);
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('不自动重发结果未知的断流请求，防止重复消费', async () => {
    const { run } = await setup();
    const fetchMock = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"{}"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(run()).rejects.toThrow('连接提前结束');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
