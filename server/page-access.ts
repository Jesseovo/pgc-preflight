import { identity } from './members';
import type { MemberStore } from './members';
import type { AppSecrets } from './settings';

// Gate the document itself so the upload workspace never flashes before login.
export async function guardCheckPage(request: Request, members: MemberStore, secrets: AppSecrets): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!['/', '/index.html'].includes(pathname) || !['GET', 'HEAD'].includes(request.method)) return null;
  if (await identity(request.headers.get('Cookie'), members, secrets)) return null;
  return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}
