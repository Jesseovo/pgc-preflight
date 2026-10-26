import { afterEach, describe, expect, it, vi } from 'vitest';
import { complete } from '../server/forge-llm';
import { generateReview } from '../server/review-generation';

vi.mock('../server/forge-llm', () => ({ complete: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
const env = { SETTINGS_KEY: 'fixture', modelStore: { get: async () => null } };

describe('模型评分依据复核', () => {
  it('原始证据与草稿交给复核模型，最终采用模型复核结果并展示当前阶段', async () => {
    const draft = { aes: 1, ease: 1, play: 1, issues: ['未经证实的遮挡'] };
    const final = { aes: 2, ease: 3, play: 2, issues: [] };
    const user = [{ type: 'text', text: 'window 监听全屏拖动' }, { type: 'image', data: 'fixture-image' }];
    const onWait = vi.fn(async () => {});
    vi.mocked(complete).mockImplementationOnce(async (_env, _cfg, req) => {
      await req.onWait?.('');
      return draft;
    }).mockImplementationOnce(async (_env, _cfg, req) => {
      await req.onWait?.('');
      return final;
    });
    await expect(generateReview(env, {}, { system: '原评分标准', user, idempotencyKey: 'job', onWait })).resolves.toBe(final);
    const calls = vi.mocked(complete).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][2].user).toEqual([...user, expect.objectContaining({ text: expect.stringContaining(JSON.stringify(draft)) })]);
    expect(calls[1][2].system).toContain('原评分标准');
    expect(calls[1][2].system).toContain('评分依据复核阶段');
    expect(calls[1][2].purpose).toBe('review');
    expect(calls[1][2].deadline).toBe(calls[0][2].deadline);
    expect(calls[1][2].idempotencyKey).toBe('job-verify');
    expect(onWait).toHaveBeenLastCalledWith(expect.stringContaining('复核评分依据'));
    expect(user).toHaveLength(2);
  });

  it('复核失败不返回初稿，也不由代码补分', async () => {
    vi.mocked(complete).mockResolvedValueOnce({ aes: 3, ease: 3, play: 3 }).mockRejectedValueOnce(new Error('模型中断'));
    await expect(generateReview(env, {}, { system: 's', user: 'evidence' })).rejects.toThrow('模型中断');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('初评耗尽共享时限时不再发起第二轮请求', async () => {
    vi.useFakeTimers();
    vi.mocked(complete).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 12 * 60 * 1000);
      return { aes: 2, ease: 2, play: 2 };
    });
    await expect(generateReview(env, {}, { system: 's', user: 'evidence' })).rejects.toThrow('复核未完成');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
