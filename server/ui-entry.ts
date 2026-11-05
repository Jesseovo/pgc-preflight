import { identity, type MemberStore } from './members';
import { guardCheckPage, guardForgePage, guardReviewPage, guardSquarePage, privatePageHeaders, pageRedirect } from './page-access';
import type { AppSecrets } from './settings';

export const workbenchAssetPath = '/_workbench.html';
const internalPaths = new Set(['/_workbench', '/_workbench/', workbenchAssetPath, '/_workbench/index.html', '/ui', '/ui/', '/ui.html', '/ui/index.html']);

const documents: ReadonlyMap<string, string> = new Map([
  ['/', '/'], ['/index.html', '/'],
  ['/login', '/login'], ['/login/', '/login'], ['/login.html', '/login'], ['/login/index.html', '/login'],
  ['/account', '/account'], ['/account/', '/account'], ['/account.html', '/account'], ['/account/index.html', '/account'],
  ['/admin', '/admin'], ['/admin/', '/admin'], ['/admin.html', '/admin'], ['/admin/index.html', '/admin'],
  ['/admin-login', '/admin'], ['/admin-login/', '/admin'], ['/admin-login.html', '/admin'],
  ['/forge', '/forge/'], ['/forge/', '/forge/'], ['/forge.html', '/forge/'], ['/forge/index.html', '/forge/'],
  ['/review', '/review'], ['/review/', '/review'], ['/review.html', '/review'], ['/review/index.html', '/review'],
  ['/square', '/square'], ['/square/', '/square'], ['/square.html', '/square'], ['/square/index.html', '/square'],
]);

type Assets = { fetch(request: Request): Promise<Response> };

export async function serveWorkbench(request: Request, members: MemberStore, secrets: AppSecrets, assets: Assets): Promise<Response | null> {
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('请求路径无效。', { status: 400, headers: privatePageHeaders });
  }
  if (internalPaths.has(pathname)) return new Response(null, { status: 404, headers: privatePageHeaders });

  const canonical = documents.get(pathname);
  if (!canonical) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { ...privatePageHeaders, Allow: 'GET, HEAD' } });
  }

  const canonicalRequest = url.pathname === canonical ? request : new Request(new URL(canonical + url.search, url), request);
  let blocked: Response | null = null;
  if (canonical === '/') blocked = await guardCheckPage(canonicalRequest, members, secrets);
  if (canonical === '/forge/') blocked = await guardForgePage(canonicalRequest, members, secrets);
  if (canonical === '/review') blocked = await guardReviewPage(canonicalRequest, members, secrets);
  if (canonical === '/square') blocked = await guardSquarePage(canonicalRequest, members, secrets);
  if (canonical === '/account' && !await identity(request.headers.get('Cookie'), members, secrets)) blocked = pageRedirect('/login');
  if (blocked) return blocked;
  if (url.pathname !== canonical) return pageRedirect(canonical + url.search);

  // Fetch the exact built shell through the binding. Public requests cannot
  // retrieve this path directly, and no cookies or validators go to the asset.
  const shell = await assets.fetch(new Request(new URL(workbenchAssetPath, url), { method: request.method }));
  if (shell.status !== 200 || !shell.headers.get('Content-Type')?.toLowerCase().startsWith('text/html')) {
    return new Response('工作台暂时无法加载，请稍后重试。', { status: 503, headers: privatePageHeaders });
  }
  const headers = new Headers(shell.headers);
  for (const [name, value] of Object.entries(privatePageHeaders)) headers.set(name, value);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(request.method === 'HEAD' ? null : shell.body, { status: 200, headers });
}
