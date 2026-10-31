import { identity } from './members';
import type { MemberStore } from './members';
import type { AppSecrets } from './settings';

// 成员审核页只加载这些共享资源，其余工作台资源需要管理员会话。
const reviewAssets = new Set([
  '/forge/navigation.js', '/forge/square-route.js', '/forge/member-shell.js', '/forge/member-shell.css',
  '/forge/experience.js', '/forge/experience.css',
  '/forge/member-review.js', '/forge/review-workspace.js', '/forge/review-workspace.css',
  '/forge/review-capture.js', '/forge/style.css', '/forge/progress.js', '/forge/progress.css',
]);
export function isPrivateAsset(request: Request): boolean {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return true; }
  return pathname.startsWith('/forge/') && !reviewAssets.has(pathname)
    || /^\/assets\/(?:admin|model-panel)-[^/]+\.js(?:\.map)?$/.test(pathname);
}
export async function guardPrivateAsset(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  if (!isPrivateAsset(request)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.role === 'admin') return null;
  if(user?.star && !/^\/assets\/(?:admin|model-panel)-/.test(decodeURIComponent(new URL(request.url).pathname))) return null;
  return new Response('无权访问此资源。', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}

// 即使请求同时带有网页会话，设备凭据也不能升级成其他接口的权限。
export function guardDeviceScope(request: Request): Response | null {
  if (!/^Bearer\s/i.test(request.headers.get('Authorization') || '')) return null;
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith('/api/') || pathname.startsWith('/api/review-device/') || pathname.startsWith('/api/forge-agent/')) return null;
  return Response.json({ error: '此凭据仅用于本人 AI 审核。' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

// Gate the document itself so the upload workspace never flashes before login.
export async function guardCheckPage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/', '/index.html'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  // The root is the member review surface after login. Administrators use
  // the management console. Star members use their personal workbench.
  if (user?.role === 'member' && user.star) return new Response(null,{status:302,headers:{Location:'/forge/', 'Cache-Control':'private, no-store',Vary:'Cookie'}});
  if (user?.role === 'member') return null;
  if (user?.role === 'admin') return new Response(null, { status: 302, headers: { Location: '/admin', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}

export async function guardForgePage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/forge', '/forge/', '/forge/index.html'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.star) return null;
  return new Response(null, { status: 302, headers: { Location: user?.role==='admin'?'/admin':user?'/':'/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}

export async function guardReviewPage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/review', '/review/'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.role === 'member') return new Response(null, { status: 302, headers: { Location: user.star?'/forge/':'/', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  if (user?.role === 'admin') return new Response(null, { status: 302, headers: { Location: '/admin', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}

// The square is shared by every enabled, signed-in account, independently of
// creation/review permissions. Gate all document aliases before serving assets.
export async function guardSquarePage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  let pathname:string;
  try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return null; }
  if (!['/square', '/square/', '/square.html', '/square/index.html'].includes(pathname)) return null;
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
  if (request.headers.has('Authorization')) return new Response('请使用网页登录游戏广场。', { status: 403, headers });
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  return user ? null : new Response(null, { status: 302, headers: { ...headers, Location: '/login' } });
}
