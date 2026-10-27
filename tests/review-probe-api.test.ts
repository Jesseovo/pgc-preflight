import { describe, it, expect, vi } from 'vitest';
import { forgeApi } from '../server/forge-api';
import {login} from '../server/settings';
import { createMember, memberLogin } from '../server/members';
import type { Member, MemberStore } from '../server/members';

async function setup() {
  const accounts: Member[] = [];
  const members: MemberStore = { list: async () => accounts, byUsername: async name => accounts.find(member => member.username === name) || null, byId: async id => accounts.find(member => member.id === id) || null, save: async member => { accounts.push(member); } };
  const env = { DB: {}, ADMIN_PASSWORD: 'fixture-password', SETTINGS_KEY: 'fixture-secret', modelStore: { get: async () => null, set: async () => {} }, captureReview: vi.fn(async () => ({ shots: [], probe: { captureMethod: 'fixture' } })) };
  const account = await createMember({ username: 'fixture', password: 'fixture-password' }, members);
  const admin=await login(env.ADMIN_PASSWORD,env);
  const adminCookie=`pgc_admin=${admin}`;
  const token = await memberLogin(account.username, 'fixture-password', members, env.SETTINGS_KEY);
  const request = (body: unknown, cookie = `pgc_member=${token}`) => new Request('https://test.invalid/api/forge/review/probe', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { env, members, account, request, adminCookie };
}
describe('审核画面采集权限与上传边界', () => {
  it('要求登录与当前审核权限，成员只能走计数队列，不能绕过次数采集或同步评分', async () => {
    const { env, members, account, request } = await setup();
    expect((await forgeApi(request({ html: '<html></html>' }, ''), env, ['review', 'probe'], members)).status).toBe(401);
    expect((await forgeApi(request({ html: '<html></html>' }), env, ['review', 'probe'], members)).status).toBe(403);
    expect((await forgeApi(request({ html: '<html></html>' }), env, ['review'], members)).status).toBe(410);
    expect(env.captureReview).toHaveBeenCalledTimes(0);
    const deletion=new Request('https://test.invalid/api/forge/reviews/1',{method:'DELETE',headers:request({}).headers});
    expect((await forgeApi(deletion,env,['reviews','1'],members)).status).toBe(403);
    expect((await forgeApi(request({}), env, ['expand'], members)).status).toBe(403);
    account.canReview = false;
    expect((await forgeApi(request({ html: '<html></html>' }), env, ['review', 'probe'], members)).status).toBe(403);
    expect(env.captureReview).toHaveBeenCalledTimes(0);
  });
  it('拒绝空文件和超限文件，不运行浏览器', async () => {
    const { env, members, request,adminCookie } = await setup();
    expect((await forgeApi(request({ html: '' },adminCookie), env, ['review', 'probe'], members)).status).toBe(400);
    expect((await forgeApi(request({ html: 'x'.repeat(8 * 1024 * 1024 + 1) },adminCookie), env, ['review', 'probe'], members)).status).toBe(413);
    expect(env.captureReview).not.toHaveBeenCalled();
  });
});
