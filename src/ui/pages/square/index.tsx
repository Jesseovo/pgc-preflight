import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Play, Search } from 'lucide-react';
import { Badge, Button, Card, ConfirmAction, Dialog, EmptyState, ErrorState, Input, Loading, PageHeader, Tabs } from '../../components/ui';
import { GamePlayer } from '../../components/GamePlayer';
import { useApp } from '../../context';
import { api, useAction, useResource } from '../../lib/api';
import './square.css';

type Game = { id: string; title: string; author?: string; score?: number | null; approvedAt?: string | null; cover?: string; hidden: boolean; visible: boolean };
type Catalog = { items: Game[]; page: number; pageSize: number; total: number; hasMore: boolean };
const endpoint = '/api/square/games';
const day = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const scoreLabel = (score?: number | null) => typeof score === 'number' && Number.isFinite(score) ? `真人终审 ${score} / 9` : '真人评分未提供';
const approvedDate = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? day.format(new Date(value)) : '通过时间未提供';

function coverUrl(value?: string) {
  if (!value) return;
  try {
    const url = new URL(value, location.origin);
    if (url.origin === location.origin && !url.username && !url.password) return url.href;
  } catch {}
}

function GameCover({ cover }: { cover?: string }) {
  const src = coverUrl(cover);
  const [failed, setFailed] = useState(false);
  return <div className={`square-cover${src && !failed ? ' has-cover' : ''}`}>
    {src && !failed ? <img alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} src={src}/> :
      <img src="/artwork/pixel-console.svg" width="68" height="54" loading="lazy" alt=""/>}
  </div>;
}

function PlayGame({ id, close }: { id: string; close: () => void }) {
  const [data, setData] = useState<{ game: Game; preview: string }>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const path = `${endpoint}/${encodeURIComponent(id)}`;
    const preview = path + '/preview';
    setData(undefined);
    setError('');
    const load = async () => {
      try {
        const game = await api<Game>(path, { signal });
        if (!game?.visible) throw new Error('这款游戏暂时无法试玩，可能已被下架。');
        const response = await fetch(preview, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal });
        if (response.status === 401) window.dispatchEvent(new Event('pgc-session-expired'));
        if (response.status === 404) throw new Error('这款游戏暂时无法试玩，可能已被下架。');
        if (!response.ok || !response.headers.get('Content-Type')?.toLowerCase().startsWith('text/html')) throw new Error('游戏文件暂时无法载入，请稍后重试。');
        if (!controller.signal.aborted) setData({ game, preview });
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message || '这款游戏暂时无法试玩。');
      }
    };
    void load();
    return () => controller.abort();
  }, [id, revision]);

  return <Dialog open onOpenChange={open => { if (!open) close(); }} title={data?.game.title || '试玩游戏'}
    description={data && `${data.game.author || '成员'} · ${scoreLabel(data.game.score)} · ${approvedDate(data.game.approvedAt)}`} wide>
    <div className="square-play">
      {error ? <ErrorState error={error} onRetry={() => setRevision(value => value + 1)}/> :
        data ? <GamePlayer src={data.preview} title={data.game.title || '游戏试玩'} versionKey={data.game.id}/> : <Loading label="正在确认作品可试玩"/>}
    </div>
  </Dialog>;
}

export default function SquareApp() {
  const { user, pathname, params, navigate, notify } = useApp();
  const query = (params.get('q') || '').slice(0, 120);
  const pageText = params.get('page') || '1';
  const page = /^[1-9]\d{0,5}$/.test(pageText) ? Number(pageText) : 1;
  const manage = user.role === 'admin' && params.get('scope') === 'manage';
  const rawId = params.get('game');
  const selected = rawId && /^[a-f0-9-]{1,100}$/i.test(rawId) ? rawId : null;
  const [search, setSearch] = useState(query);
  const playerTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => setSearch(query), [query]);
  const criteria = new URLSearchParams({ q: query, page: String(page) });
  if (manage) criteria.set('scope', 'manage');
  const path = `${endpoint}?${criteria}`;
  const result = useResource<Catalog>(path);
  const visibility = useAction();
  const data = result.data;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const setRoute = (patch: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    const text = next.toString();
    navigate(pathname + (text ? '?' + text : ''), replace);
  };
  const submitSearch = (value: string) => setRoute({ q: value.trim() || null, page: null, game: null });
  const selectPage = (target: number) => {
    setRoute({ page: target > 1 ? String(target) : null, game: null });
    requestAnimationFrame(() => document.getElementById('square-results')?.scrollIntoView({ block: 'start' }));
  };
  const setVisibility = async (game: Game) => {
    await visibility.run(async () => {
      if (!manage || user.role !== 'admin') return;
      const changed = await api<Game>(`${endpoint}/${encodeURIComponent(game.id)}/visibility`, { method: 'POST', body: { hidden: !game.hidden } });
      result.setData(current => current ? { ...current, items: current.items.map(item => item.id === game.id ? changed : item) } : current);
      result.reload();
      notify(game.hidden ? '已取消手动下架，公开状态以当前终审结论为准。' : '游戏已下架。', 'success');
    });
  };

  return <div className="page square-page stack">
    <PageHeader eyebrow="PGC PREFLIGHT / GALLERY" title="游戏广场" description="试玩已通过真人终审的投稿版本，查看作者与通过记录。"/>
    {user.role === 'admin' && <Tabs value={manage ? 'manage' : 'browse'} items={[{ id: 'browse', label: '浏览广场' }, { id: 'manage', label: '管理可见性' }]}
      onChange={scope => setRoute({ scope: scope === 'manage' ? 'manage' : null, page: null, game: null })}/>}
    <section className="stack" id="square-results" aria-label="广场作品">
      <form className="toolbar square-search" role="search" onSubmit={event => { event.preventDefault(); submitSearch(search); }}>
        <label className="square-search-input"><Search size={17} aria-hidden="true"/><Input type="search" aria-label="搜索游戏标题或作者" placeholder="搜索标题或作者" maxLength={120} value={search}
          onChange={event => setSearch(event.target.value)}/></label>
        <Button type="submit">搜索</Button>
        {query && <Button variant="ghost" onClick={() => submitSearch('')}>清除搜索</Button>}
      </form>
      {result.error && <ErrorState error={result.error} onRetry={result.reload}/>}
      {result.loading && !data && <Loading label="正在读取游戏广场"/>}
      {data && <div className="spread square-count"><h2>{query ? `“${query}”的搜索结果` : manage ? '广场作品管理' : '全部作品'}</h2><span className="muted small">{data.total} 款游戏</span></div>}
      {data && data.items.length === 0 && <EmptyState title={query ? '没有找到相关游戏' : '本页没有游戏'}
        description={query ? '可以试试其他标题或作者。' : '真人终审通过的游戏版本会出现在这里。'}
        action={page > 1 ? <Button onClick={() => selectPage(1)}>返回第一页</Button> : query ? <Button onClick={() => submitSearch('')}>查看全部游戏</Button> : undefined}/>}
      {data && !!data.items.length && <div className="square-grid">
        {data.items.map(game => <Card className="square-card" key={game.id}>
          <GameCover key={game.cover || ''} cover={game.cover}/>
          <div className="square-card-content stack">
            <div className="spread square-card-title"><h3>{game.title || '未命名游戏'}</h3>{!game.visible && <Badge tone="warning">{game.hidden ? '已下架' : '暂不可见'}</Badge>}</div>
            <p className="muted small">{game.author || '成员'}</p>
            <div className="row square-card-meta"><Badge tone={typeof game.score === 'number' ? 'sage' : 'neutral'}>{scoreLabel(game.score)}</Badge><small className="muted">{approvedDate(game.approvedAt)}</small></div>
            <div className="row square-card-actions">
              {game.visible && <Button size="sm" variant="outline" onClick={event => { playerTrigger.current = event.currentTarget; setRoute({ game: game.id }); }} aria-label={`试玩：${game.title || '未命名游戏'}`}><Play size={14}/>试玩</Button>}
              {manage && <ConfirmAction title={game.hidden ? '取消手动下架' : '从广场下架'} variant={game.hidden ? 'outline' : 'destructive'}
                description={game.hidden ? '取消手动下架后，此投稿版本仍须通过当前真人终审才能公开。' : '下架后，这个投稿版本将从成员广场隐藏。'}
                onConfirm={() => setVisibility(game)}>{game.hidden ? <Eye size={14}/> : <EyeOff size={14}/>} {game.hidden ? '取消下架' : '下架'}</ConfirmAction>}
            </div>
          </div>
        </Card>)}
      </div>}
      {data && (pageCount > 1 || page > 1) && <nav className="row square-pagination" aria-label="广场分页">
        <Button variant="outline" onClick={() => selectPage(Math.max(1, page - 1))} disabled={page <= 1 || result.loading}><ArrowLeft size={15}/>上一页</Button>
        <span className="muted small">第 {data.page} / {pageCount} 页</span>
        <Button variant="outline" onClick={() => selectPage(page + 1)} disabled={!data.hasMore || result.loading}>下一页<ArrowRight size={15}/></Button>
      </nav>}
      {visibility.error && <p className="danger-text" role="alert">{visibility.error}</p>}
    </section>
    {selected && <PlayGame key={selected} id={selected} close={() => {
      setRoute({ game: null }, true);
      setTimeout(() => playerTrigger.current?.focus({ preventScroll: true }), 0);
    }}/>}
  </div>;
}
