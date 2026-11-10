import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createModelThrottle, retryAfterMs } from '../server/model-throttle';
import { ModelHttpError, modelTransport } from '../server/model';
import { complete } from '../server/forge-llm';
import { encryptKey } from '../server/settings';

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  sqlite.exec(readFileSync('migrations/0007_model_throttle.sql', 'utf8'));sqlite.exec(readFileSync('migrations/0023_model_slots.sql', 'utf8'));
  return { sqlite, DB: { prepare(sql: string) { return { bind(...params: any[]) { return {
    first: async () => sqlite.prepare(sql).get(...params), run: async () => sqlite.prepare(sql).run(...params),
  }; } }; } } };
}
const config = { baseUrl: 'https://riffle-api.pages.dev', model: 'fixture', protocol: 'anthropic' as const, apiKey: 'test-key-never-persist' };

describe('模型限流与恢复', () => {
  it('跨任务共享同一 Key 的排队时刻，模型并发保留且一分钟启动不超过十次', async () => {
    vi.useFakeTimers();
    const { DB, sqlite } = setup(); const starts: number[] = [];
    const initial = Date.now();
    const tasks = Array.from({ length: 12 }, () => createModelThrottle(DB, config).wait(new AbortController().signal).then(() => starts.push(Date.now())));
    await vi.waitFor(() => expect(Number((sqlite.prepare('SELECT next_at FROM model_throttle').get() as any)?.next_at || 0)).toBeGreaterThanOrEqual(initial + 84000));
    await vi.advanceTimersByTimeAsync(80000); await Promise.all(tasks);
    expect(starts).toHaveLength(12);
    expect(starts.every((stamp, i) => !i || stamp - starts[i - 1] >= 7000)).toBe(true);
    expect(starts.filter(stamp => stamp < starts[0] + 60000)).toHaveLength(9);
    const persisted = sqlite.prepare('SELECT * FROM model_throttle').all();
    expect(persisted).toHaveLength(1); expect(JSON.stringify(persisted)).not.toContain(config.apiKey);
  });

  it('一个任务收到429后，其他等待任务遵守共享冷却，并错开恢复', async () => {
    vi.useFakeTimers();
    const { DB } = setup(); const first = createModelThrottle(DB, config);
    const signal = new AbortController().signal; await first.wait(signal);
    const queue = () => {
      let queued!: () => void;
      const waiting = new Promise<void>(resolve => { queued = resolve; });
      // Web Crypto runs outside the fake clock. Resolve after onWait so the
      // throttle installs its timer before the test advances time.
      const started = createModelThrottle(DB, config).wait(signal, () => queueMicrotask(queued)).then(() => Date.now());
      return { waiting, started };
    };
    const second = queue();
    await second.waiting;
    await vi.advanceTimersByTimeAsync(1000);
    const start = Date.now(); await first.cooldown(18000);
    const third = queue();
    await third.waiting;
    await vi.advanceTimersByTimeAsync(50000);
    const [secondAt, thirdAt] = await Promise.all([second.started, third.started]);
    expect(Math.min(secondAt, thirdAt)).toBeGreaterThanOrEqual(start + 18000);
    expect(Math.abs(secondAt - thirdAt)).toBeGreaterThanOrEqual(7000);
  });

  it('HTTP429遵守Retry-After并保留幂等键，成功后返回真实结果', async () => {
    vi.useFakeTimers(); const seen: number[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(Date.now()); expect((init!.headers as any)['Idempotency-Key']).toBe('same-request');
      return seen.length === 1 ? Response.json({ error: { code: 'KEY_RATE_LIMIT', message: '每分钟10次上限' } }, { status: 429, headers: { 'Retry-After': '18' } }) : Response.json({ content: [{ type: 'text', text: 'READY' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const waiting = vi.fn();
    const result = modelTransport(config, { idempotencyKey: 'same-request', onWait: waiting })([]);
    await vi.advanceTimersByTimeAsync(17999); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await expect(result).resolves.toBe('READY');
    expect(seen[1] - seen[0]).toBe(18000); expect(waiting).toHaveBeenCalledWith(18000, 'rate_limit');
  });

  it('重试有上限，complete不再叠加一层429重试；密钥不进入错误提示', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({ error: { code: 'KEY_RATE_LIMIT', message: `key ${config.apiKey} reached limit` } }, { status: 429, headers: { 'Retry-After': '1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const encryptedKey = await encryptKey(config.apiKey, 'fixture-secret');
    const result = complete({ SETTINGS_KEY: 'fixture-secret', modelStore: { get: async () => ({ ...config, encryptedKey, enabled: true }) } }, {}, { system: 'test', user: 'test', idempotencyKey: 'same-request' });
    const check = expect(result).rejects.toThrow(/模型接口限流.*\[REDACTED\]/);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5000); await check;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('额度耗尽不反复重试；Retry-After支持秒数与HTTP日期', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: 'insufficient_quota', message: '额度不足' } }, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(modelTransport(config)([])).rejects.toBeInstanceOf(ModelHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const now = Date.parse('2026-10-26T09:00:00Z');
    expect(retryAfterMs('18', now)).toBe(18000);
    expect(retryAfterMs('Mon, 26 Oct 2026 09:01:00 GMT', now)).toBe(60000);
    expect(retryAfterMs('invalid', now)).toBeUndefined();
  });

  it('409保留网关原因；额度预占冲突不能被当成重复请求反复重试', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { code: 'KEY_BUDGET_RESERVED', message: '可用额度被其他请求预占，请等待结算。' } }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(modelTransport(config)([])).rejects.toThrow(/请求冲突（409）.*可用额度被其他请求预占.*KEY_BUDGET_RESERVED/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('明确的同一请求仍在处理会等待并使用原幂等键取回结果', async () => {
    vi.useFakeTimers(); const waiting = vi.fn();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init!.headers as any)['Idempotency-Key']).toBe('pending-request');
      return fetchMock.mock.calls.length === 1
        ? Response.json({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: '请求仍在处理' } }, { status: 409, headers: { 'Retry-After': '12' } })
        : Response.json({ content: [{ type: 'text', text: 'READY' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = modelTransport(config, { idempotencyKey:'pending-request', onWait:waiting })([]);
    await vi.advanceTimersByTimeAsync(11999); expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await expect(result).resolves.toBe('READY');
    expect(waiting).toHaveBeenCalledWith(12000, 'pending');
  });

  it('同一请求慢于四次轮询时继续等原结果，仍遵守总期限', async () => {
    vi.useFakeTimers();
    const fetchMock=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      expect((init?.headers as any)['Idempotency-Key']).toBe('slow-request');
      return fetchMock.mock.calls.length<=6
        ? Response.json({error:{code:'REQUEST_IN_PROGRESS',message:'still processing'}},{status:409,headers:{'Retry-After':'15'}})
        : Response.json({content:[{type:'text',text:'READY'}]});
    });
    vi.stubGlobal('fetch',fetchMock);
    const result=modelTransport(config,{idempotencyKey:'slow-request',totalTimeoutMs:120000})([]);
    await vi.advanceTimersByTimeAsync(90000);
    await expect(result).resolves.toBe('READY');
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it.each(['REQUEST_OUTCOME_UNCERTAIN','KEY_BUDGET_RESERVED','UNKNOWN_REQUEST_PENDING'])('冲突 %s 不被当作可恢复排队',async(code)=>{
    const fetchMock=vi.fn(async()=>Response.json({error:{code,message:'cannot replay'}},{status:409}));
    vi.stubGlobal('fetch',fetchMock);
    await expect(modelTransport(config,{idempotencyKey:'uncertain-request'})([])).rejects.toMatchObject({code});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('503 只在传输层最多重试三次，不在 complete 外层叠加',async()=>{
    vi.useFakeTimers();
    const fetchMock=vi.fn(async()=>Response.json({error:{code:'service_unavailable',message:'busy'}},{status:503,headers:{'Retry-After':'1'}}));
    vi.stubGlobal('fetch',fetchMock);
    const encryptedKey=await encryptKey(config.apiKey,'fixture-secret');
    const result=complete({SETTINGS_KEY:'fixture-secret',modelStore:{get:async()=>({...config,encryptedKey,enabled:true})}}, {}, {system:'test',user:'test',idempotencyKey:'same-request'});
    const check=expect(result).rejects.toThrow('503');
    await vi.waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5000);await check;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('没有幂等键的 409 不重发；待处理请求到期后结束等待',async()=>{
    vi.useFakeTimers();
    const fetchMock=vi.fn(async()=>Response.json({error:{code:'REQUEST_IN_PROGRESS'}},{status:409,headers:{'Retry-After':'10'}}));
    vi.stubGlobal('fetch',fetchMock);
    await expect(modelTransport(config)([])).rejects.toMatchObject({upstreamStatus:409});
    expect(fetchMock).toHaveBeenCalledTimes(1);fetchMock.mockClear();
    const result=modelTransport(config,{idempotencyKey:'pending-request',totalTimeoutMs:25000})([]);
    const check=expect(result).rejects.toMatchObject({upstreamStatus:409});
    await vi.advanceTimersByTimeAsync(25000);await check;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('流式错误和被截断的正文不能作为成功内容返回', async () => {
    const stream = (tail: string) => new Response(`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\ndata: ${tail}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    vi.stubGlobal('fetch', vi.fn(async () => stream('{"type":"error","error":{"type":"api_error"}}')));
    await expect(modelTransport(config)([])).rejects.toThrow('模型流式生成被接口中断');
    vi.stubGlobal('fetch', vi.fn(async () => stream('{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}')));
    await expect(modelTransport(config)([])).rejects.toThrow('内容不完整');
  });
});
