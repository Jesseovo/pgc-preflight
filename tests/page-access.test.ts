import { describe, expect, it } from 'vitest';
import { guardCheckPage } from '../server/page-access';
import { createMember, memberLogin, updateMember } from '../server/members';
import type { Member, MemberStore } from '../server/members';
import { login } from '../server/settings';

const secrets = { ADMIN_PASSWORD: 'test-only-admin', SETTINGS_KEY: 'test-only-secret' };
function memoryStore(): MemberStore {
  const all: Member[] = [];
  return {
    list: async () => all,
    byId: async id => all.find(member => member.id === id) || null,
    byUsername: async username => all.find(member => member.username === username) || null,
    save: async member => { const index = all.findIndex(item => item.id === member.id); if (index < 0) all.push(member); else all[index] = member; },
  };
}
const page = (path = '/', cookie = '') => new Request(`https://pgc.example${path}`, { headers: { Cookie: cookie } });

describe('检查台的登录前置', () => {
  it('直接打开首页或 index.html 会跳到登录页且不缓存重定向', async () => {
    for (const path of ['/', '/?from=team', '/index.html']) {
      const response = await guardCheckPage(page(path), memoryStore(), secrets);
      expect(response?.status).toBe(302);
      expect(response?.headers.get('Location')).toBe('/login');
      expect(response?.headers.get('Cache-Control')).toContain('no-store');
      expect(response?.headers.get('Vary')).toBe('Cookie');
    }
  });
  it('成员和管理员登录后能进入检查台，撤销的成员会话重新登录', async () => {
    const store = memoryStore();
    const member = await createMember({ username: 'creator01', password: 'test-only-password' }, store);
    const token = await memberLogin('creator01', 'test-only-password', store, secrets.SETTINGS_KEY);
    expect(await guardCheckPage(page('/', `pgc_member=${token}`), store, secrets)).toBe(null);
    const admin = await login(secrets.ADMIN_PASSWORD, secrets);
    expect(await guardCheckPage(page('/', `pgc_admin=${admin}`), store, secrets)).toBe(null);
    await updateMember(member.id, { enabled: false }, store);
    expect((await guardCheckPage(page('/', `pgc_member=${token}`), store, secrets))?.status).toBe(302);
  });
  it('登录页、后台与静态素材保持可访问，不产生登录重定向循环', async () => {
    for (const path of ['/login', '/admin', '/artwork/pixel-cat-walk.gif', '/api/auth/me']) {
      expect(await guardCheckPage(page(path), memoryStore(), secrets)).toBe(null);
    }
  });
});
