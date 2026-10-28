import {afterEach,describe,it,expect,vi} from 'vitest';
import {modelQuota} from '../server/model-quota';
import {saveConfig,login,type ModelConfig} from '../server/settings';
import {adminApi} from '../server/admin-api';
afterEach(()=>vi.unstubAllGlobals());
async function setup(baseUrl='https://riffle-api.pages.dev'){
  let config:ModelConfig|null=null;const secrets={ADMIN_PASSWORD:'fixture-admin',SETTINGS_KEY:'fixture-secret'};
  const store={get:async()=>config,set:async(c:ModelConfig)=>{config=c;}};
  await saveConfig({profile:'opus',baseUrl,protocol:'anthropic',model:'claude-opus-5-5',apiKey:'private-fixture-key'},store,secrets.SETTINGS_KEY);
  const members:any={};const cookie=`pgc_admin=${await login(secrets.ADMIN_PASSWORD,secrets)}`;
  return {store,secrets,call:(headers:Record<string,string>={Cookie:cookie})=>adminApi(new Request('https://quota.test/api/admin/quota?profile=opus',{headers}),store,secrets,members)};
}
const quota={object:'key_quota',currency:'CNY',available:22,daily:{limit:100,used:3,remaining:97,available:22,reset_at:'2026-10-28T16:00:00Z'},total:{limit:1000,used:100,remaining:900},reservations:{amount:75,requests:2},requests_per_minute:10,name:'PRIVATE_NAME',apiKey:'private-fixture-key',extra:{token:'PRIVATE_TOKEN'}};
describe('管理员 Opus Key 余额',()=>{
  it('仅管理员 Cookie 可查询，设备不能借管理员 Cookie 扩权',async()=>{
    const s=await setup(),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    expect((await s.call({}))?.status).toBe(401);
    expect((await s.call({Authorization:'Bearer device',Cookie:'pgc_admin=invalid'}))?.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('用服务端已保存 Key 请求固定地址，只透传白名单金额与限制',async()=>{
    const s=await setup(),fetcher=vi.fn(async(_url:any,init:any)=>{expect(new Headers(init.headers).get('Authorization')).toBe('Bearer private-fixture-key');expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);return Response.json(quota);});vi.stubGlobal('fetch',fetcher);
    const response=await s.call(),data=await response!.json();expect(data).toMatchObject({currency:'CNY',available:22,daily:{remaining:97},total:{remaining:900},requestsPerMinute:10});
    expect(fetcher.mock.calls[0][0]).toBe('https://riffle-api.pages.dev/v1/quota');expect(JSON.stringify(data)).not.toMatch(/PRIVATE|private-fixture|encryptedKey|apiKey/);expect(response?.headers.get('Cache-Control')).toBe('no-store');
  });
  it('其他地址不能复用 Key 进行余额查询',async()=>{
    const s=await setup('https://riffle-api.pages.dev.attacker.test'),fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(modelQuota(s.store,s.secrets.SETTINGS_KEY,'opus')).rejects.toThrow('仅支持');expect(fetcher).not.toHaveBeenCalled();
  });
  it('上游失败与错误结构不能伪装零余额，也不回显上游私密错误',async()=>{
    const s=await setup(),fetcher=vi.fn(async()=>new Response('PRIVATE_UPSTREAM_KEY',{status:502}));vi.stubGlobal('fetch',fetcher);
    await expect(modelQuota(s.store,s.secrets.SETTINGS_KEY,'opus')).rejects.toThrow('HTTP 502');
    fetcher.mockImplementation(async()=>Response.json({currency:'CNY',available:0}));await expect(modelQuota(s.store,s.secrets.SETTINGS_KEY,'opus')).rejects.toThrow('缺少预算');
  });
});
