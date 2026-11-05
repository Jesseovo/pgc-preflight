import { describe, expect, it } from 'vitest';
import { guardCheckPage, guardForgePage, guardReviewPage, guardSquarePage, guardPrivateAsset, guardDeviceScope } from '../server/page-access';
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
  it('成员和管理员登录后进入各自工作台，撤销的成员会话重新登录', async () => {
    const store = memoryStore();
    const member = await createMember({ username: 'creator01', password: 'test-only-password' }, store);
    const token = await memberLogin('creator01', 'test-only-password', store, secrets.SETTINGS_KEY);
    expect(await guardCheckPage(page('/', `pgc_member=${token}`), store, secrets)).toBe(null);
    const admin = await login(secrets.ADMIN_PASSWORD, secrets);
    expect((await guardCheckPage(page('/', `pgc_admin=${admin}`), store, secrets))?.headers.get('Location')).toBe('/admin');
    await updateMember(member.id, { enabled: false }, store);
    expect((await guardCheckPage(page('/', `pgc_member=${token}`), store, secrets))?.status).toBe(302);
  });
  it('登录页、后台与静态素材保持可访问，不产生登录重定向循环', async () => {
    for (const path of ['/login', '/admin', '/artwork/pixel-cat-walk.gif', '/api/auth/me']) {
      expect(await guardCheckPage(page(path), memoryStore(), secrets)).toBe(null);
    }
  });
  it('管理员进入管理台，普通成员进入审核台，Star 进入个人 Forge', async () => {
    const store = memoryStore();
    const member = await createMember({ username: 'creator02', password: 'test-only-password' }, store);
    const memberToken = await memberLogin('creator02', 'test-only-password', store, secrets.SETTINGS_KEY);
    const adminToken = await login(secrets.ADMIN_PASSWORD, secrets);
    expect(await guardForgePage(page('/forge', `pgc_member=${memberToken}`), store, secrets)).toMatchObject({ status: 302 });
    expect((await guardForgePage(page('/forge', `pgc_member=${memberToken}`), store, secrets))?.headers.get('Location')).toBe('/');
    expect((await guardForgePage(page('/forge', `pgc_admin=${adminToken}`), store, secrets))?.headers.get('Location')).toBe('/admin');
    expect((await guardReviewPage(page('/review', `pgc_member=${memberToken}`), store, secrets))?.headers.get('Location')).toBe('/');
    await updateMember(member.id, { star: true }, store);
    expect(await guardForgePage(page('/forge', `pgc_member=${memberToken}`), store, secrets)).toBe(null);
    expect((await guardCheckPage(page('/', `pgc_member=${memberToken}`), store, secrets))?.headers.get('Location')).toBe('/forge/');
    expect((await guardReviewPage(page('/review', `pgc_member=${memberToken}`), store, secrets))?.headers.get('Location')).toBe('/forge/?tab=review');
    await updateMember(member.id, { star: false }, store);
    expect((await guardForgePage(page('/forge', `pgc_member=${memberToken}`), store, secrets))?.headers.get('Location')).toBe('/');
  });
  it('Star 可以读取个人工作台脚本，但不能读取管理员模块；撤销后即时收回', async () => {
    const store=memoryStore();
    const member=await createMember({username:'starcreator',password:'test-only-password',star:true},store);
    const token=await memberLogin('starcreator','test-only-password',store,secrets.SETTINGS_KEY),cookie=`pgc_member=${token}`;
    for(const path of ['/forge/app.js','/forge/review-sheet.js','/forge/%61pp.js','/assets/ui-creator-abc123.js','/assets/%75i-creator-abc123.js.map'])expect(await guardPrivateAsset(page(path,cookie),store,secrets),path).toBe(null);
    for(const path of ['/assets/admin-abc123.js','/assets/%61dmin-abc123.js','/assets/admin-abc123.js.map','/assets/model-panel-abc123.js','/assets/model-panel-abc123.js.map','/assets/ui-admin-abc123.js','/assets/%75i-admin-abc123.js.map'])expect((await guardPrivateAsset(page(path,cookie),store,secrets))?.status,path).toBe(403);
    await updateMember(member.id,{star:false},store);
    expect((await guardPrivateAsset(page('/forge/app.js',cookie),store,secrets))?.status).toBe(403);
    expect((await guardPrivateAsset(page('/assets/ui-creator-abc123.js',cookie),store,secrets))?.status).toBe(403);
    expect(await guardPrivateAsset(page('/forge/member-review.js',cookie),store,secrets)).toBe(null);
  });
  it('成员和未登录用户不能读取管理脚本，管理员可读，审核共享资源不受影响', async () => {
    const store = memoryStore();
    await createMember({ username: 'creator03', password: 'test-only-password' }, store);
    const memberToken = await memberLogin('creator03', 'test-only-password', store, secrets.SETTINGS_KEY);
    const adminToken = await login(secrets.ADMIN_PASSWORD, secrets);
    for (const path of ['/forge/app.js', '/forge/review-sheet.js', '/forge/%61pp.js', '/assets/admin-abc123.js', '/assets/%61dmin-abc123.js', '/assets/admin-abc123.js.map','/assets/model-panel-abc123.js','/assets/model-panel-abc123.js.map', '/assets/ui-admin-abc123.js', '/assets/%75i-admin-abc123.js.map', '/assets/ui-creator-abc123.js', '/assets/%75i-creator-abc123.js.map']) {
      for (const cookie of ['', `pgc_member=${memberToken}`]) {
        const response = await guardPrivateAsset(page(path, cookie), store, secrets);
        expect(response?.status, path).toBe(403);
        expect(response?.headers.get('Cache-Control')).toContain('no-store');
      }
      expect(await guardPrivateAsset(page(path, `pgc_admin=${adminToken}`), store, secrets)).toBe(null);
    }
    for (const path of ['/forge/member-review.js', '/forge/review-workspace.js', '/forge/review-capture.js', '/forge/style.css', '/forge/progress.js', '/assets/login-abc123.js', '/assets/ui-common-abc123.js']) {
      expect(await guardPrivateAsset(page(path), store, secrets)).toBe(null);
    }
  });
  it('设备凭据即使附带管理员会话也只能调用审核设备接口', () => {
    for (const path of ['/api/admin/config', '/api/forge/topics', '/api/forge/settings', '/api/auth/me', '/api/check']) {
      const request = new Request(`https://pgc.example${path}`, { headers: { Authorization: `Bearer ${'a'.repeat(64)}`, Cookie: 'pgc_admin=unrelated' } });
      expect(guardDeviceScope(request)?.status, path).toBe(403);
    }
    expect(guardDeviceScope(new Request('https://pgc.example/api/review-device/jobs', { headers: { Authorization: `Bearer ${'a'.repeat(64)}` } }))).toBe(null);
    expect(guardDeviceScope(new Request('https://pgc.example/api/forge-agent/jobs', { headers: { Authorization: `Bearer ${'a'.repeat(64)}` } }))).toBe(null);
    expect(guardDeviceScope(page('/api/admin/config'))).toBe(null);
  });
  it('广场全部文档别名要求登录，所有启用账号可进入，不依赖审核或Star权限', async () => {
    const store=memoryStore();
    const member=await createMember({username:'squareviewer',password:'test-only-password',canReview:false},store);
    const cookie=`pgc_member=${await memberLogin(member.username,'test-only-password',store,secrets.SETTINGS_KEY)}`;
    const adminCookie=`pgc_admin=${await login(secrets.ADMIN_PASSWORD,secrets)}`;
    for(const path of ['/square','/square/','/square.html','/square/index.html','/%73quare']){
      const anonymous=await guardSquarePage(page(path),store,secrets);
      expect(anonymous?.status,path).toBe(302);expect(anonymous?.headers.get('Location')).toBe('/login');expect(anonymous?.headers.get('Cache-Control')).toContain('no-store');
      expect(await guardSquarePage(page(path,cookie),store,secrets)).toBe(null);
      expect(await guardSquarePage(page(path,adminCookie),store,secrets)).toBe(null);
      const mixed=new Request(`https://pgc.example${path}`,{headers:{Cookie:adminCookie,Authorization:'Bearer device-only'}});
      expect((await guardSquarePage(mixed,store,secrets))?.status).toBe(403);
    }
    await updateMember(member.id,{star:true},store);
    expect(await guardSquarePage(page('/square',cookie),store,secrets)).toBe(null);
    await updateMember(member.id,{enabled:false},store);
    expect((await guardSquarePage(page('/square',cookie),store,secrets))?.headers.get('Location')).toBe('/login');
    expect(await guardSquarePage(page('/square/app.js'),store,secrets)).toBe(null);
  });
});
