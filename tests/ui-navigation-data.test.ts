import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearNavigationData, configureNavigationData, consumePrefetched, peekResource, prepareNavigation } from '../src/ui/lib/navigation-data';

const member = {id: 'member', role: 'member', star: false, canReview: true} as const;
const star = {id: 'star', role: 'member', star: true, canReview: true} as const;
const admin = {id: 'admin', role: 'admin', star: false, canReview: true} as const;
const catalog = '/api/square/games?q=&page=1';
const jobs = '/api/forge/review/jobs';

beforeEach(clearNavigationData);
afterEach(() => { clearNavigationData(); vi.useRealTimers(); });

describe('navigation metadata handoff', () => {
  it('uses a single concurrent request and consumes each prepared handoff once', async () => {
    const value = {items: []};
    const request = vi.fn(async () => value);
    configureNavigationData(request);
    await Promise.all([prepareNavigation('/square', member), prepareNavigation('/square?game=abcdef', member)]);
    expect(request).toHaveBeenCalledExactlyOnceWith(catalog, {signal: expect.any(AbortSignal)});
    expect(peekResource(catalog)).toBe(value);
    expect(consumePrefetched(catalog)).toBe(value);
    expect(consumePrefetched(catalog)).toBeUndefined();
    await prepareNavigation('/square', member);
    expect(request).toHaveBeenCalledTimes(1);
    expect(consumePrefetched(catalog)).toBe(value);
  });

  it('does not cache failures and expires catalog and other metadata independently', async () => {
    vi.useFakeTimers();
    const request = vi.fn<Parameters<typeof configureNavigationData>[0]>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockImplementation(async path => ({path}));
    configureNavigationData(request);
    await prepareNavigation('/square', member);
    expect(peekResource(catalog)).toBeUndefined();
    await prepareNavigation('/square', member);
    await prepareNavigation('/', member);
    expect(peekResource(catalog)).toEqual({path: catalog});
    expect(peekResource(jobs)).toEqual({path: jobs});
    vi.advanceTimersByTime(15_000);
    expect(peekResource(catalog)).toBeUndefined();
    expect(peekResource(jobs)).toEqual({path: jobs});
    vi.advanceTimersByTime(15_000);
    expect(peekResource(jobs)).toBeUndefined();
  });

  it('clears on an account change and cannot repopulate from a late prior response', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    let oldSignal: AbortSignal | undefined;
    configureNavigationData(vi.fn<Parameters<typeof configureNavigationData>[0]>()
      .mockImplementationOnce((_path, {signal}) => {
        oldSignal = signal;
        return new Promise(resolve => { resolveOld = resolve; });
      })
      .mockResolvedValue({owner: 'new'}));
    const old = prepareNavigation('/square', member);
    await Promise.resolve();
    await prepareNavigation('/square', star);
    expect(oldSignal?.aborted).toBe(true);
    resolveOld({owner: 'old'});
    await old;
    expect(peekResource(catalog)).toEqual({owner: 'new'});
    clearNavigationData();
    expect(peekResource(catalog)).toBeUndefined();
  });

  it('a canceled view returns promptly while concurrent navigation can reuse its authorized read', async () => {
    let finish: (value: unknown) => void = () => {};
    const request = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    configureNavigationData(request);
    const cancel = new AbortController();
    const first = prepareNavigation('/square', member, cancel.signal);
    const second = prepareNavigation('/square', member);
    cancel.abort();
    await first;
    expect(request).toHaveBeenCalledTimes(1);
    expect(peekResource(catalog)).toBeUndefined();
    finish({items: []});
    await second;
    expect(consumePrefetched(catalog)).toEqual({items: []});
  });

  it('prepares bounded list metadata for the intended role and keeps details out', async () => {
    const request = vi.fn(async (_path: string) => ({}));
    configureNavigationData(request);
    await prepareNavigation('/forge/?tab=project&project=19&panel=versions&version=one', star);
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/api/forge/topics/19?summary=1', '/api/forge/topics/19/versions', '/api/forge/generation-jobs', '/api/forge/state',
    ]);
    request.mockClear();
    await prepareNavigation('/admin?view=works&inspect=project&inspectType=topic&inspectId=5&owner=member&range=today', admin);
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/admin/projects?range=today&page=1&pageSize=24&owner=member']);
    request.mockClear();
    for (const url of ['/admin?view=settings', '/admin?view=feedback', '/admin?view=reviews&id=19', 'https://external.invalid/square']) await prepareNavigation(url, admin);
    await prepareNavigation('/admin?view=works', member);
    await prepareNavigation('/review?report=12', {...member, canReview: false});
    expect(request).not.toHaveBeenCalled();
  });

  it('evicts older entries when many distinct searches are prepared', async () => {
    configureNavigationData(async () => ({items: []}));
    for (let n = 1; n <= 45; n++) await prepareNavigation('/square?page=' + n, member);
    expect(peekResource(catalog)).toBeUndefined();
    expect(peekResource('/api/square/games?q=&page=45')).toEqual({items: []});
  });
});
