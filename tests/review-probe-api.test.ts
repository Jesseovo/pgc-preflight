import { describe, it, expect, vi } from 'vitest';
import { forgeApi } from '../server/forge-api';
import { createMember, memberLogin } from '../server/members';
import type { Member, MemberStore } from '../server/members';

async function setup() {
  const accounts: Member[] = [];
  const members: MemberStore = { list: async () => accounts, byUsername: async name => accounts.find(member => member.username === name) || null, byId: async id => accounts.find(member => member.id === id) || null, save: async member => { accounts.push(member); } };
  const env = { DB: {}, ADMIN_PASSWORD: 'fixture-password', SETTINGS_KEY: 'fixture-secret', modelStore: { get: async () => null, set: async () => {} }, captureReview: vi.fn(async () => ({ shots: [], probe: { captureMethod: 'fixture' } })) };
  const account = await createMember({ username: 'fixture', password: 'fixture-password' }, members);
  const token = await memberLogin(account.username, 'fixture-password', members, env.SETTINGS_KEY);
  const request = (body: unknown, cookie = `pgc_member=${token}`) => new Request('https://test.invalid/api/forge/review/probe', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { env, members, account, request };
}
describe('审核画面采集权限与上传边界', () => {
  it('要求登录与当前审核权限，成员可以采集但不能访问创作接口', async () => {
    const { env, members, account, request } = await setup();
    expect((await forgeApi(request({ html: '<html></html>' }, ''), env, ['review', 'probe'], members)).status).toBe(401);
    expect((await forgeApi(request({ html: '<html></html>' }), env, ['review', 'probe'], members)).status).toBe(200);
    expect(env.captureReview).toHaveBeenCalledTimes(1);
    expect((await forgeApi(request({}), env, ['expand'], members)).status).toBe(403);
    account.canReview = false;
    expect((await forgeApi(request({ html: '<html></html>' }), env, ['review', 'probe'], members)).status).toBe(403);
    expect(env.captureReview).toHaveBeenCalledTimes(1);
  });
  it('拒绝空文件和超限文件，不运行浏览器', async () => {
    const { env, members, request } = await setup();
    expect((await forgeApi(request({ html: '' }), env, ['review', 'probe'], members)).status).toBe(400);
    expect((await forgeApi(request({ html: 'x'.repeat(8 * 1024 * 1024 + 1) }), env, ['review', 'probe'], members)).status).toBe(413);
    expect(env.captureReview).not.toHaveBeenCalled();
  });
});
