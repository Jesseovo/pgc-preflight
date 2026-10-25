import { identity } from './members';
import type { MemberStore } from './members';
import type { AppSecrets } from './settings';

// Gate the document itself so the upload workspace never flashes before login.
export async function guardCheckPage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/', '/index.html'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.role === 'member') return new Response(null, { status: 302, headers: { Location: '/review', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
  if (user) return null;
  return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}

export async function guardForgePage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/forge', '/forge/', '/forge/index.html'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  const user = await identity(request.headers.get('Cookie'), members, secrets);
  if (user?.role === 'admin') return null;
  return new Response(null, { status: 302, headers: { Location: user ? '/review' : '/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}

export async function guardReviewPage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/review', '/review/'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  if (await identity(request.headers.get('Cookie'), members, secrets)) return null;
  return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}
