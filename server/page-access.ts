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
const adminChunk = /^\/assets\/(?:admin|model-panel|ui-admin)-[^/]+\.js(?:\.map)?$/;
const creatorChunk = /^\/assets\/ui-creator-[^/]+\.js(?:\.map)?$/;
export const privatePageHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function assetScope(request: Request): 'admin' | 'creator' | null {
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return 'admin'; }
  if (adminChunk.test(pathname)) return 'admin';
  if (creatorChunk.test(pathname) || pathname.startsWith('/forge/') && !reviewAssets.has(pathname)) return 'creator';
  return null;
}
export function isPrivateAsset(request: Request): boolean {
  return assetScope(request) !== null;
}
export async function guardPrivateAsset(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const scope = assetScope(request);
  if (!scope) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.role === 'admin' || scope === 'creator' && user?.star) return null;
  return new Response('无权访问此资源。', { status: 403, headers: { ...privatePageHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
}

// 即使请求同时带有网页会话，设备凭据也不能升级成其他接口的权限。
export function guardDeviceScope(request: Request): Response | null {
  if (!/^Bearer\s/i.test(request.headers.get('Authorization') || '')) return null;
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith('/api/') || pathname.startsWith('/api/review-device/') || pathname.startsWith('/api/forge-agent/')) return null;
  return Response.json({ error: '此凭据仅用于本人 AI 审核。' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

export function pageRedirect(location: string) {
  return new Response(null, { status: 302, headers: { ...privatePageHeaders, Location: location } });
}

const reviewTabs = new Set(['tasks', 'history', 'devices']);
function reviewDestination(url: URL, star: boolean) {
  const params = new URLSearchParams(url.search);
  const tab = params.get('tab') || '';
  if (star) {
    if (reviewTabs.has(tab) && !params.has('reviewTab')) params.set('reviewTab', tab);
    params.set('tab', 'review');
  } else if (tab === 'review') params.delete('tab');
  const query = params.toString();
  return (star ? '/forge/' : '/') + (query ? '?' + query : '');
}

// Gate the document itself so the upload workspace never flashes before login.
export async function guardCheckPage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['/', '/index.html'].includes(url.pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.role === 'member' && user.star) {
    const tab = url.searchParams.get('tab') || '';
    const review = tab === 'review' || reviewTabs.has(tab) || ['report', 'reportId', 'task', 'job', 'reviewTab'].some(key => url.searchParams.has(key));
    return pageRedirect(review ? reviewDestination(url, true) : '/forge/' + url.search);
  }
  if (user?.role === 'member') return null;
  return pageRedirect(user?.role === 'admin' ? '/admin' + url.search : '/login');
}

export async function guardForgePage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['/forge', '/forge/', '/forge/index.html'].includes(url.pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.star) return null;
  if (user?.role === 'admin') return pageRedirect('/admin' + url.search);
  if (user?.role === 'member') return pageRedirect(reviewDestination(url, false));
  return pageRedirect('/login');
}

export async function guardReviewPage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['/review', '/review/'].includes(url.pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.role === 'member') return pageRedirect(reviewDestination(url, !!user.star));
  return pageRedirect(user?.role === 'admin' ? '/admin' + url.search : '/login');
}

// The square is shared by every enabled, signed-in account, independently of
// creation/review permissions. Gate all document aliases before serving assets.
export async function guardSquarePage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  let pathname:string;
  try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return null; }
  if (!['/square', '/square/', '/square.html', '/square/index.html'].includes(pathname)) return null;
  if (request.headers.has('Authorization')) return new Response('请使用网页登录游戏广场。', { status: 403, headers: privatePageHeaders });
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  return user ? null : pageRedirect('/login');
}
