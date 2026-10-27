import { describe, expect, it } from 'vitest';
import worker from '../server/worker';

describe('智能助手说明的中文编码', () => {
  it('对原本没有 charset 的静态 Markdown 补充 UTF-8，并保持正文不变', async () => {
    const text = '# PGC 游戏审核 · 智能助手接入说明\n\n仅操作本人的审核任务。';
    const env: any = {
      DB: {},
      ASSETS: { fetch: async () => new Response(text, { headers: { 'Content-Type': 'text/markdown', ETag: 'fixture' } }) },
    };
    const response = await worker.fetch(new Request('https://pgc.example/agent.md'), env, { waitUntil() {} });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('ETag')).toBe('fixture');
    expect(await response.text()).toBe(text);
  });
});
