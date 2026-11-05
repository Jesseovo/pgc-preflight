import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../server/worker';
import { createMember, memberLogin, type Member, type MemberStore } from '../server/members';
import { login } from '../server/settings';
import { workbenchAssetPath } from '../server/ui-entry';

const origin = 'https://pgc.example';
const secrets = { ADMIN_PASSWORD: 'fixture-admin-only', SETTINGS_KEY: 'fixture-test-only' };
const shell = '<!doctype html><div id="app"></div><script type="module" src="/assets/ui-entry-test.js"></script>';
const accounts = new Map<string, Member>();
const reads: { path: string; method: string; cookie: string | null; etag: string | null }[] = [];
const store: MemberStore = {
  list: async () => [...accounts.values()],
  byId: async id => accounts.get(id) ?? null,
  byUsername: async username => [...accounts.values()].find(member => member.username === username) ?? null,
  save: async member => { accounts.set(member.id, member); },
};
const DB = {
  prepare: () => ({
    bind: (id: string) => ({ first: async () => {
      const member = accounts.get(id);
      return member ? {
        id: member.id, username: member.username, display_name: member.displayName, password_hash: member.passwordHash,
        password_salt: member.passwordSalt, enabled: Number(member.enabled), can_review: Number(member.canReview),
        star: Number(!!member.star), session_version: member.sessionVersion, daily_review_limit: member.dailyReviewLimit,
        created_at: member.createdAt, updated_at: member.updatedAt,
      } : null;
    } }),
  }),
};
const cookies: Record<'admin' | 'member' | 'star' | 'disabled', string> = { admin: '', member: '', star: '', disabled: '' };

beforeAll(async () => {
  cookies.admin = 'pgc_admin=' + await login(secrets.ADMIN_PASSWORD, secrets);
  for (const name of ['member', 'star', 'disabled'] as const) {
    const member = await createMember({ username: name, password: 'fixture-member-password', star: name === 'star', canReview: false }, store);
    cookies[name] = 'pgc_member=' + await memberLogin(name, 'fixture-member-password', store, secrets.SETTINGS_KEY);
    if (name === 'disabled') accounts.set(member.id, { ...member, enabled: false });
  }
});

let shellAvailable = true;
const ASSETS = {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    reads.push({ path, method: request.method, cookie: request.headers.get('Cookie'), etag: request.headers.get('If-None-Match') });
    if (path === workbenchAssetPath) {
      return shellAvailable ? new Response(shell, { headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: 'fixture-shell' } }) :
        Response.redirect(origin + '/_workbench', 308);
    }
    return new Response('fixture asset', { headers: { 'Content-Type': 'text/javascript' } });
  },
};

const request = (path: string, cookie = '', method = 'GET', headers: Record<string, string> = {}) =>
  worker.fetch(new Request(origin + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }),
    { ...secrets, DB, ASSETS } as any, { waitUntil() {} });

beforeEach(() => { reads.length = 0; shellAvailable = true; });

describe('生产统一工作台入口', () => {
  it('以同一精确 HTML 资源提供登录和授权页面，并保留 GET/HEAD 缓存边界', async () => {
    const paths = [
      ['/login', ''], ['/admin', ''], ['/admin', cookies.admin],
      ['/', cookies.member], ['/forge/', cookies.star], ['/account', cookies.member], ['/account', cookies.admin],
      ['/square', cookies.member], ['/square', cookies.star], ['/square', cookies.admin],
    ];
    for (const [path, cookie] of paths) {
      const response = await request(path, cookie, 'GET', { 'If-None-Match': 'legacy-shell' });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('Cache-Control'), path).toBe('private, no-store');
      expect(response.headers.get('Vary'), path).toBe('Cookie');
      expect(response.headers.get('X-Content-Type-Options'), path).toBe('nosniff');
      expect(await response.text(), path).toBe(shell);
    }
    const head = await request('/square', cookies.member, 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(reads).toHaveLength(paths.length + 1);
    expect(reads.every(({ path, cookie, etag }) => path === workbenchAssetPath && !cookie && !etag)).toBe(true);
    expect(reads.at(-1)?.method).toBe('HEAD');
  });

  it('规范化别名并保留角色、审核任务和报告的深链接', async () => {
    const redirects = [
      ['/index.html?reviewQ=orbit', cookies.member, '/?reviewQ=orbit'],
      ['/index.html?report=82', cookies.star, '/forge/?report=82&tab=review'],
      ['/?task=old-job&reviewTab=tasks', cookies.star, '/forge/?task=old-job&reviewTab=tasks&tab=review'],
      ['/?tab=history&reviewQ=orbit', cookies.star, '/forge/?tab=review&reviewQ=orbit&reviewTab=history'],
      ['/review.html?reportId=81', cookies.star, '/forge/?reportId=81&tab=review'],
      ['/review/?tab=devices', cookies.star, '/forge/?tab=review&reviewTab=devices'],
      ['/review?task=old-job', cookies.member, '/?task=old-job'],
      ['/forge/?tab=review&reviewTab=history', cookies.member, '/?reviewTab=history'],
      ['/forge/index.html?project=13', cookies.star, '/forge/?project=13'],
      ['/admin/index.html?view=reviews&id=82', cookies.admin, '/admin?view=reviews&id=82'],
      ['/admin-login.html?view=settings', '', '/admin?view=settings'],
      ['/login.html?from=bookmark', '', '/login?from=bookmark'],
      ['/account/index.html?from=menu', cookies.member, '/account?from=menu'],
      ['/square/index.html?q=orbit&page=2&game=abc', cookies.member, '/square?q=orbit&page=2&game=abc'],
      ['/%73quare?q=orbit', cookies.member, '/square?q=orbit'],
    ];
    for (const [path, cookie, target] of redirects) {
      const response = await request(path, cookie);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('Location'), path).toBe(target);
      expect(response.headers.get('Cache-Control'), path).toContain('no-store');
    }
    expect(reads).toHaveLength(0);
  });

  it('先拒绝匿名和已停用会话，再读取工作台资产', async () => {
    for (const path of ['/', '/index.html', '/forge', '/review.html', '/square', '/square.html', '/account', '/account.html']) {
      for (const cookie of ['', cookies.disabled]) {
        const response = await request(path, cookie);
        expect(response.status, path).toBe(302);
        expect(response.headers.get('Location'), path).toBe('/login');
      }
    }
    for (const path of ['/square', '/square.html', '/square/index.html', '/%73quare']) {
      const response = await request(path, cookies.admin, 'GET', { Authorization: 'Bearer synthetic-device' });
      expect(response.status, path).toBe(403);
    }
    const posted = await request('/account', cookies.member, 'POST');
    expect(posted.status).toBe(405);
    expect(posted.headers.get('Allow')).toBe('GET, HEAD');
    expect(reads).toHaveLength(0);
  });

  it('禁止公开获取内部 HTML，并拒绝将资产重定向透传成页面响应', async () => {
    for (const path of [workbenchAssetPath, '/%5fworkbench.html', '/_workbench', '/ui', '/ui.html']) {
      for (const cookie of ['', cookies.admin]) {
        expect((await request(path, cookie)).status, path).toBe(404);
      }
    }
    expect(reads).toHaveLength(0);
    shellAvailable = false;
    const failed = await request('/login');
    expect(failed.status).toBe(503);
    expect(failed.headers.has('Location')).toBe(false);
  });

  it('旧和新命名空间的管理、创作脚本按当前角色鉴权', async () => {
    for (const [paths, allowed] of [
      [['/assets/admin-old.js', '/assets/ui-admin-Models-test.js', '/assets/%75i-admin-Models-test.js.map'], [cookies.admin]],
      [['/forge/review-sheet.js', '/assets/ui-creator-Project-test.js', '/assets/%75i-creator-Project-test.js.map'], [cookies.admin, cookies.star]],
    ] as const) {
      for (const path of paths) {
        for (const cookie of ['', cookies.member, cookies.star, cookies.admin, cookies.disabled]) {
          const response = await request(path, cookie);
          expect(response.status, path).toBe(allowed.includes(cookie) ? 200 : 403);
          expect(response.headers.get('Cache-Control'), path).toContain('no-store');
          expect(response.headers.get('Vary'), path).toBe('Cookie');
        }
      }
    }
    for (const path of ['/assets/ui-shared-test.js', '/forge/progress.js', '/agent/review-agent.mjs']) {
      expect((await request(path)).status, path).toBe(200);
    }
  });

  it('设备凭据和 API 优先于工作台与静态资源', async () => {
    for (const path of ['/api/auth/me', '/api/admin/config', '/api/forge/topics', '/api/square/games']) {
      const denied = await request(path, cookies.admin, 'GET', { Authorization: 'Bearer synthetic-device' });
      expect(denied.status, path).toBe(403);
      expect(denied.headers.get('Content-Type'), path).toContain('application/json');
    }
    const unknown = await request('/api/not-a-real-endpoint', cookies.admin);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('Content-Type')).toContain('application/json');
    expect(reads).toHaveLength(0);
  });
});
