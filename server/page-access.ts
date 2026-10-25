import { identity } from './members';
import type { MemberStore } from './members';
import type { AppSecrets } from './settings';

// Gate the document itself so the upload workspace never flashes before login.
export async function guardCheckPage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/', '/index.html'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  // The root is the member review surface after login. Administrators use
  // the unified control room; the old Forge URL remains available as a
  // compatibility route for the embedded workbench.
  if (user?.role === 'member') return null;
  if (user?.role === 'admin') return new Response(null, { status: 302, headers: { Location: '/admin', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}

export async function guardForgePage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/forge', '/forge/', '/forge/index.html'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.role === 'admin') return null;
  return new Response(null, { status: 302, headers: { Location: user ? '/' : '/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}

export async function guardReviewPage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/review', '/review/'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.role === 'member') return new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  if (user?.role === 'admin') return new Response(null, { status: 302, headers: { Location: '/admin', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}
