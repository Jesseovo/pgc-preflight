import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { forgeApi, processForgeJob } from '../server/forge-api';
import { saveConfig, saveRoutes } from '../server/settings';
import type { ConfigStore, ModelConfig } from '../server/settings';
import type { MemberStore } from '../server/members';
import { hashPassword, memberLogin } from '../server/members';
import { login } from '../server/settings';

const secrets = { ADMIN_PASSWORD: 'fixture-admin', SETTINGS_KEY: 'fixture-secret' };
const members: MemberStore = { list: async () => [], byId: async () => null, byUsername: async () => null, save: async () => {} };
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>start()</script></body></html>';
const databases: DatabaseSync[] = [];
afterEach(() => { vi.unstubAllGlobals(); databases.splice(0).forEach(db => db.close()); });

async function setup({ model = 'claude-opus-5-5', status = 'liked', product = '' } = {}) {
  let config: ModelConfig | null = null;
  const modelStore: ConfigStore = { get: async () => config, set: async value => { config = value; } };
  await saveConfig({ profile: 'opus', protocol: 'anthropic', baseUrl: 'https://fixture.example', model, apiKey: 'test-only-key' }, modelStore, secrets.SETTINGS_KEY);
  const sqlite = new DatabaseSync(':memory:'); databases.push(sqlite);
  for (const file of ['0003_forge', '0005_forge_jobs', '0008_forge_assets', '0009_products']) sqlite.exec(readFileSync(`migrations/${file}.sql`, 'utf8'));
  sqlite.exec('CREATE TABLE settings (id TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  sqlite.prepare("INSERT INTO topics (id,batch,subject,medium,gesture,structure,mood,status,data,product_html,created_at,updated_at) VALUES (9,'test','light','pixel','tap','rhythm','calm',?,?,?,?,?)").run(status, JSON.stringify({ title: 'Tiny Garden', logline: 'A test game' }), product || null, new Date().toISOString(), new Date().toISOString());
  const send = vi.fn(async (_message: any) => {});
  const DB = { prepare: (sql: string) => ({ bind: (...values: any[]) => {
    const statement = sqlite.prepare(sql);
    return { first: async () => statement.get(...values) || null, all: async () => ({ results: statement.all(...values) }),
      run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } }) };
  } }) };
  const token = await login(secrets.ADMIN_PASSWORD, secrets);
  const env = { ...secrets, modelStore, DB, FORGE_QUEUE: { send } } as any;
  const request = (method: string, route: string[]) => forgeApi(new Request(`https://pgc.example/api/forge/${route.join('/')}`, { method, headers: { Cookie: `pgc_admin=${token}` } }), env, route, members);
  const row = () => sqlite.prepare('SELECT * FROM topics WHERE id = 9').get() as Record<string, any>;
  return { sqlite, row, send, request, env };
}

describe('Opus 制作任务与成品接口', () => {
  it('开始制作只入队一次，任务状态接口不会带回整份 HTML', async () => {
    const { send, request } = await setup();
    const first = await request('POST', ['topics', '9', 'game']);
    const second = await request('POST', ['topics', '9', 'game']);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'pending' });
    expect(await second.json()).toMatchObject({ status: 'pending' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'game', id: 9, requestId: expect.any(String) });
    const status = await request('GET', ['topics', '9', 'game']);
    const state = await status.json();
    expect(state).toMatchObject({ product_status: 'queued', has_product: false });
    expect(state).not.toHaveProperty('product_html');
  });

  it('排队超过旧租约不会重发，未登录和成员不能制作', async () => {
    const { sqlite, env, request, send } = await setup();
    await request('POST', ['topics', '9', 'game']);
    sqlite.prepare('UPDATE topics SET updated_at = ?').run(new Date(Date.now() - 120000).toISOString());
    expect(await (await request('POST', ['topics', '9', 'game'])).json()).toMatchObject({ status: 'pending' });
    expect(send).toHaveBeenCalledTimes(1);
    const denied = await forgeApi(new Request('https://pgc.example/api/forge/products'), env, ['products'], members);
    expect(denied.status).toBe(401);
    const credentials = await hashPassword('fixture-member');
    const member = {id:'fixture',username:'fixture',displayName:'Fixture',enabled:true,canReview:true,passwordHash:credentials.hash,passwordSalt:credentials.salt,sessionVersion:1,createdAt:'',updatedAt:''};
    const memberStore: MemberStore = {...members,byId:async()=>member,byUsername:async()=>member};
    const memberToken = await memberLogin('fixture', 'fixture-member', memberStore, secrets.SETTINGS_KEY);
    const requestAsMember = new Request('https://pgc.example/api/forge/topics/9/game', {method:'POST',headers:{Cookie:`pgc_member=${memberToken}`}});
    expect((await forgeApi(requestAsMember,env,['topics','9','game'],memberStore)).status).toBe(403);
  });

  it('没有简报也直接制作游戏，不隐式生成长简报；重复消费不再调用模型', async () => {
    const { env, request, row, send } = await setup();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.system).toContain('HTML Canvas games');
      expect(JSON.stringify(body.messages)).toContain('Tiny Garden');
      expect(JSON.stringify(body.messages)).toContain('A test game');
      return Response.json({ content: [{ type: 'text', text: html }], stop_reason: 'end_turn' });
    });
    vi.stubGlobal('fetch', fetcher);
    await request('POST', ['topics', '9', 'game']);
    const job = send.mock.calls[0][0];
    await processForgeJob(env, job);
    expect(row()).toMatchObject({ status: 'made', product_status: '', product_html: html });
    expect(row().brief_md).toBeNull();
    await processForgeJob(env, job);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const call of fetcher.mock.calls) expect(JSON.parse(String((call[1] as RequestInit).body)).output_config).toEqual({effort:'low'});
    const list = await (await request('GET', ['products'])).json();
    expect(list[0]).toMatchObject({ id: 9, has_product: 1 });
    expect(list[0]).not.toHaveProperty('product_html');
  });

  it('失败可明确重试，旧消息不能覆盖新任务', async () => {
    const { sqlite, env, request, row, send } = await setup();
    sqlite.exec("UPDATE topics SET brief_md = 'Existing brief'");
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('fixture error', { status: 400 }))
      .mockResolvedValueOnce(Response.json({ content: [{ type: 'text', text: html }], stop_reason: 'end_turn' }));
    vi.stubGlobal('fetch', fetcher);
    await request('POST', ['topics', '9', 'game']);
    const old = send.mock.calls[0][0];
    await expect(processForgeJob(env, old)).rejects.toThrow();
    expect(row()).toMatchObject({ product_status: 'error', product_html: null });
    await processForgeJob(env, old);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await request('POST', ['topics', '9', 'game']);
    const fresh = send.mock.calls[1][0];
    expect(fresh.requestId).not.toBe(old.requestId);
    await processForgeJob(env, old);
    expect(row().product_status).toBe('queued');
    await processForgeJob(env, fresh);
    expect(row().product_html).toBe(html);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('其他功能切换模型后制作仍使用 Opus，停用 Opus 或非候选游戏不能制作', async () => {
    const game = await setup();
    await saveConfig({profile:'game-writer',baseUrl:'https://writer.example/v1',model:'game-model',apiKey:'game-only-key'},game.env.modelStore,secrets.SETTINGS_KEY);
    await saveRoutes({create:'game-writer'},game.env.modelStore);
    const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{
      expect(url).toBe('https://fixture.example/v1/messages');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('test-only-key');
      const body=JSON.parse(String(init?.body));
      expect(body.model).toBe('claude-opus-5-5');
      expect(body.output_config).toEqual({effort:'low'});
      return Response.json({content:[{type:'text',text:html}],stop_reason:'end_turn'});
    });
    vi.stubGlobal('fetch',fetcher);
    expect((await game.request('POST',['topics','9','game'])).status).toBe(200);
    await processForgeJob(game.env,game.send.mock.calls[0][0]);
    expect(game.row().product_html).toBe(html);
    const disabled=await setup();
    await saveConfig({profile:'opus',protocol:'anthropic',baseUrl:'https://fixture.example',model:'claude-opus-5-5',enabled:false},disabled.env.modelStore,secrets.SETTINGS_KEY);
    await saveConfig({profile:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'test-deepseek-key'},disabled.env.modelStore,secrets.SETTINGS_KEY);
    await saveRoutes({activeProfile:'deepseek',create:'deepseek'},disabled.env.modelStore);
    const denied = await disabled.request('POST',['topics','9','game']);
    expect(denied.status).toBe(409);
    expect((await denied.json()).error).toContain('Opus 5.5');
    expect(disabled.send).not.toHaveBeenCalled();
    const notCandidate = await setup({ status: 'new' });
    expect((await notCandidate.request('POST', ['topics', '9', 'game'])).status).toBe(409);
    expect(notCandidate.send).not.toHaveBeenCalled();
  });

  it('游戏超出输出预算时明确失败，不在后台付费重跑整款游戏', async () => {
    const { sqlite, env, request, row, send } = await setup();
    sqlite.exec("UPDATE topics SET brief_md = 'Existing brief'");
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).max_tokens).toBe(32768);
      expect(JSON.parse(String(init?.body)).output_config).toEqual({effort:'low'});
      expect(JSON.parse(String(init?.body)).thinking).toEqual({type:'adaptive'});
      return Response.json({ content: [{ type: 'text', text: html }], stop_reason: 'max_tokens' });
    });
    vi.stubGlobal('fetch', fetcher);
    await request('POST', ['topics', '9', 'game']);
    await expect(processForgeJob(env, send.mock.calls[0][0])).rejects.toThrow('长度上限');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ product_status: 'error', product_html: null });
    expect(row().product_error).toContain('游戏生成的输出额度');
  });

  it('已生成成品可以安全预览并单独读取源码', async () => {
    const { request } = await setup({ status: 'made', product: html });
    const preview = await request('GET', ['topics', '9', 'product-preview']);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
    expect(await preview.text()).toBe(html);
    const saved = await request('GET', ['topics', '9', 'product']);
    expect(await saved.json()).toEqual({ id: 9, html });
  });
});
