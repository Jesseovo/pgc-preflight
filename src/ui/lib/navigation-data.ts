import { readRoute } from '../../admin/navigation';
import type { User } from '../context';

type NavigationUser = Pick<User, 'id' | 'role' | 'star' | 'canReview'>;
type RequestMetadata = (path: string, options: { signal: AbortSignal }) => Promise<unknown>;
type CachedResource = { value: unknown; expiresAt: number; offered: boolean };
type InFlight = { controller: AbortController; promise: Promise<void> };

const METADATA_TTL = 30_000;
const CATALOG_TTL = 15_000;
const MAX_ENTRIES = 40;
const MAX_IN_FLIGHT = 12;
const forge = '/api/forge';
const reviewJobs = `${forge}/review/jobs`;
const reviewHistory = `${forge}/reviews`;
const reviewDevices = `${forge}/review/worker-status`;
const generationJobs = `${forge}/generation-jobs`;
const creatorState = `${forge}/state`;
const squareCatalog = '/api/square/games';
const resources = new Map<string, CachedResource>();
const inFlight = new Map<string, InFlight>();
let requestMetadata: RequestMetadata | undefined;
let identity = '';
let generation = 0;

export function configureNavigationData(requester: RequestMetadata) {
  if (requestMetadata && requestMetadata !== requester) clearNavigationData();
  requestMetadata = requester;
}

export function clearNavigationData() {
  generation++;
  identity = '';
  resources.clear();
  for (const { controller } of inFlight.values()) controller.abort();
  inFlight.clear();
}

function entryFor(path: string | null) {
  if (!path) return;
  const entry = resources.get(path);
  if (entry && entry.expiresAt <= Date.now()) {
    resources.delete(path);
    return;
  }
  return entry;
}

export function peekResource<T = unknown>(path: string | null): T | undefined {
  return entryFor(path)?.value as T | undefined;
}

// Handoff is consumed once. The metadata remains eligible for another route
// preparation during its TTL, and mounted readers still poll the live API.
export function consumePrefetched<T = unknown>(path: string | null): T | undefined {
  const entry = entryFor(path);
  if (!entry?.offered) return;
  entry.offered = false;
  return entry.value as T;
}

function saveResource(path: string, value: unknown) {
  const now = Date.now();
  for (const [key, item] of resources) if (item.expiresAt <= now) resources.delete(key);
  const ttl = path.startsWith(squareCatalog + '?') ? CATALOG_TTL : METADATA_TTL;
  resources.delete(path);
  resources.set(path, { value, expiresAt: now + ttl, offered: true });
  while (resources.size > MAX_ENTRIES) {
    const oldest = resources.keys().next().value;
    if (oldest === undefined) break;
    resources.delete(oldest);
  }
}

function warmResource(path: string): Promise<void> {
  const hit = entryFor(path);
  if (hit) {
    hit.offered = true;
    resources.delete(path);
    resources.set(path, hit);
    return Promise.resolve();
  }
  const previous = inFlight.get(path);
  if (previous) return previous.promise;
  const requester = requestMetadata;
  if (!requester || inFlight.size >= MAX_IN_FLIGHT || path.length > 2048) return Promise.resolve();
  const controller = new AbortController();
  const started = generation;
  const promise = Promise.resolve().then(async () => {
    if (controller.signal.aborted) return;
    const value = await requester(path, { signal: controller.signal });
    if (value && typeof value === 'object' && started === generation && !controller.signal.aborted) saveResource(path, value);
  }).catch(() => {
    // Render the destination normally. Its live reader reports the failure or
    // recovers from a transient error; no failure becomes a cached response.
  }).finally(() => {
    if (inFlight.get(path)?.promise === promise) inFlight.delete(path);
  });
  inFlight.set(path, { controller, promise });
  return promise;
}

function adminMetadata(search: string): string[] {
  const route = readRoute(search);
  const base = '/api/admin/';
  if (route.view === 'overview') {
    return [base + 'dashboard?' + new URLSearchParams({ range: route.range === 'all' ? '7d' : route.range, owner: route.owner })];
  }
  if (route.id) return [];
  if (route.view === 'works' || route.view === 'tasks') {
    const works = route.view === 'works';
    const params = new URLSearchParams({ range: route.range, page: String(route.page), pageSize: works ? '24' : '25' });
    for (const key of ['owner', 'q', 'status', 'type'] as const) if (route[key] && route[key] !== 'all') params.set(key, route[key]);
    if (route.from && route.to) {
      params.set('from', route.from);
      params.set('to', route.to);
    }
    if (works && route.section === 'first-products') params.set('firstProducts', '1');
    const project = route.section?.match(/^project:(topic|game):(\d+)$/);
    if (!works && project) params.set('project', project[2]);
    return [base + (works ? 'projects?' : 'tasks?') + params];
  }
  if (route.view === 'reviews') {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(route.section || '') ? route.section! : new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    const scope = ['all', 'members', 'admin'].includes(route.type) ? route.type : 'all';
    const params = new URLSearchParams({ date: day, scope, member: route.owner, page: String(route.page), status: route.status });
    if (route.from && route.to) {
      params.set('from', route.from);
      params.set('to', route.to);
    }
    return [base + 'review-activity?' + params];
  }
  return route.view === 'members' ? [base + 'members'] : [];
}

function routeMetadata(input: string | URL, user: NavigationUser): string[] {
  const origin = typeof location === 'undefined' ? 'http://navigation.invalid' : location.origin;
  const url = new URL(input, origin);
  if (url.origin !== origin || url.username || url.password) return [];
  const path = url.pathname.replace(/\/$/, '') || '/';
  const params = url.searchParams;
  if (path === '/square') {
    const pageText = params.get('page') || '1';
    const page = /^[1-9]\d{0,5}$/.test(pageText) ? pageText : '1';
    const criteria = new URLSearchParams({ q: (params.get('q') || '').slice(0, 120), page });
    if (user.role === 'admin' && params.get('scope') === 'manage') criteria.set('scope', 'manage');
    return [squareCatalog + '?' + criteria];
  }
  if (path === '/admin') return user.role === 'admin' ? adminMetadata(url.search) : [];
  if (user.role !== 'member') return [];

  const tab = params.get('tab') || 'picks';
  const root = path === '/' || path === '/index.html';
  const legacyReviewLink = root && ['report', 'reportId', 'task', 'job'].some(key => params.has(key));
  if (path === '/review' || (root && (!user.star || legacyReviewLink)) || (path === '/forge' && user.star && tab === 'review')) {
    return user.canReview ? [reviewJobs, reviewHistory, reviewDevices] : [];
  }
  if (!user.star || (path !== '/forge' && !root)) return [];

  const project = params.get('project');
  if (project && /^\d+$/.test(project) && Number.isSafeInteger(Number(project)) && Number(project) > 0) {
    const base = `${forge}/topics/${Number(project)}`;
    const paths = [`${base}?summary=1`, `${base}/versions`, generationJobs, creatorState];
    if (params.get('panel') === 'review' && user.canReview) paths.push(reviewHistory);
    return paths;
  }
  if (tab === 'draw') return [`${forge}/topics?status=drawn,new,dup&limit=60`, generationJobs, creatorState];
  if (tab === 'products') return [`${forge}/products`, generationJobs];
  if (['games', 'vocab', 'settings', 'agent', 'tasks'].includes(tab)) return [generationJobs];
  return [`${forge}/topics?status=liked,made&limit=500`, `${forge}/products`, generationJobs];
}

export async function prepareNavigation(url: string | URL, user: NavigationUser, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const nextIdentity = JSON.stringify([user.id, user.role, user.star, user.canReview]);
  if (identity !== nextIdentity) {
    clearNavigationData();
    identity = nextIdentity;
  }
  let paths: string[];
  try { paths = routeMetadata(url, user); } catch { return; }
  const preparation = Promise.all(paths.map(warmResource));
  if (!signal) { await preparation; return; }

  // A superseded view stops waiting; the shared read may still serve a newer
  // view for this identity. Clearing the cache also cancels the actual reads.
  let stopWaiting: () => void = () => {};
  const superseded = new Promise<void>(resolve => {
    stopWaiting = resolve;
    signal.addEventListener('abort', resolveOnAbort, { once: true });
    if (signal.aborted) stopWaiting();
  });
  function resolveOnAbort() { stopWaiting(); }
  try { await Promise.race([preparation, superseded]); }
  finally { signal.removeEventListener('abort', resolveOnAbort); }
}
