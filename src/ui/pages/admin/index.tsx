import { Suspense, useEffect, useRef, useState } from 'react';
import { baseRoute, inspectorRoute, readRoute, routeUrl } from '../../../admin/navigation';
import type { AdminProject, AdminRoute } from '../../../admin/contracts';
import { Button, Loading } from '../../components/ui';
import { AdminDetailContext, AdminListContext, type AdminDetailState, useAdminRoute } from './shared';
import { screen } from '../../lib/screen';
import './admin.css';

const Overview = screen(() => import('./Overview'));
const Works = screen(async () => ({ default: (await import('./Content')).Works }));
const Tasks = screen(async () => ({ default: (await import('./Content')).Tasks }));
const Project = screen(async () => ({ default: (await import('./Content')).ProjectDetail }));
const Task = screen(async () => ({ default: (await import('./Content')).TaskDetail }));
const Reviews = screen(() => import('./Reviews'));
const Report = screen(async () => ({ default: (await import('./Reviews')).AdminReport }));
const Feedback = screen(() => import('./Feedback'));
const Members = screen(() => import('./Members'));
const Settings = screen(() => import('./Settings'));

export function preloadAdminRoute(search: string) {
  const route = readRoute(search);
  const main = route.view === 'overview' ? Overview : route.view === 'works' ? (route.id ? Project : Works) :
    route.view === 'tasks' ? (route.id ? Task : Tasks) : route.view === 'reviews' ? (route.id ? Report : Reviews) :
    route.view === 'feedback' ? Feedback : route.view === 'members' ? Members : Settings;
  const detail = route.inspector?.kind === 'project' ? Project : route.inspector?.kind === 'task' ? Task : route.inspector?.kind === 'report' ? Report : undefined;
  return Promise.all([main.preload(), detail?.preload()]).then(() => undefined);
}

function Main({ route }: { route: AdminRoute }) {
  if (route.view === 'overview') return <Overview route={route} />;
  if (route.view === 'works') return route.id ? <Project key={route.type + route.id} route={route} /> : <Works route={route} />;
  if (route.view === 'tasks') return route.id ? <Task key={route.type + route.id} route={route} /> : <Tasks route={route} />;
  if (route.view === 'reviews') return route.id ? <Report key={route.id} id={route.id} /> : <Reviews route={route} />;
  if (route.view === 'feedback') return <Feedback route={route} />;
  if (route.view === 'members') return <Members route={route} />;
  return <Settings route={route} />;
}

function Inspector({ projects, compact, focused, onFocus, onClose }: {
  projects: AdminProject[]; compact: boolean; focused: boolean; onFocus: () => void; onClose: () => void;
}) {
  const { route, inspect, previous, back } = useAdminRoute();
  const target = route.inspector!;
  const detail = inspectorRoute(target);
  const panel = useRef<HTMLElement>(null);
  const exit = useRef<HTMLButtonElement>(null);
  const changeKey = [target.kind, target.type, target.id].join(':');
  const sequence = projects.filter(row => route.status !== 'product' || row.materials.game);
  const index = target.kind === 'project' ? sequence.findIndex(row => row.id.toString() === target.id && row.type === target.type) : -1;
  const title = target.kind === 'project' ? '作品详情' : target.kind === 'task' ? '任务详情' : '审核报告';

  useEffect(() => { if (compact) exit.current?.focus({ preventScroll: true }); }, [compact]);
  useEffect(() => { panel.current?.scrollTo(0, 0); }, [changeKey]);

  const move = (offset: number) => {
    const project = sequence[index + offset];
    if (project) inspect({ kind: 'project', id: String(project.id), type: project.type, panel: project.materials.game ? 'game' : 'overview' }, true);
  };

  return <aside ref={panel} className="admin-inspector" role={compact ? 'dialog' : 'region'} aria-modal={compact || undefined} aria-label={title} onKeyDown={event => {
    if (event.key !== 'Tab' || !compact) return;
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), iframe, summary, [tabindex="0"]') || []).filter(node => node.getClientRects().length > 0);
    if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1]?.focus(); }
    if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0]?.focus(); }
  }}>
    <header className="spread admin-inspector-header">
      <div className="row"><strong>{title}</strong>{previous && <Button variant="ghost" size="sm" onClick={back}>返回上一层</Button>}</div>
      <div className="row">
        {index >= 0 && !previous && <><span className="small muted">{index + 1} / {sequence.length}</span><Button variant="outline" size="sm" disabled={!index} onClick={() => move(-1)}>上一款</Button><Button variant="outline" size="sm" disabled={index >= sequence.length - 1} onClick={() => move(1)}>下一款</Button></>}
        {!compact && <Button variant="ghost" size="sm" aria-pressed={focused} onClick={onFocus}>{focused ? '退出专注' : '专注查看'}</Button>}
        <a className="admin-download" href={routeUrl(detail)} target="_blank" rel="noopener">打开完整页面 ↗</a>
        <Button ref={exit} variant="outline" size="sm" aria-label="关闭详情" onClick={onClose}>关闭</Button>
      </div>
    </header>
    <div className="admin-inspector-body"><Suspense fallback={<Loading label="正在读取详情…" />}>
      {detail.view === 'works' && <Project key={changeKey} route={detail} embedded />}
      {detail.view === 'tasks' && <Task key={changeKey} route={detail} embedded />}
      {detail.view === 'reviews' && detail.id && <Report key={changeKey} id={detail.id} embedded />}
    </Suspense></div>
  </aside>;
}

const compactQuery = '(max-width: 900px)';

export default function AdminApp() {
  const state = useRef<AdminDetailState>({ focus: { current: null }, entries: new Map() });
  return <AdminDetailContext.Provider value={state.current}><AdminLayout /></AdminDetailContext.Provider>;
}

function AdminLayout() {
  const { route, close, returnFocus } = useAdminRoute();
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [compact, setCompact] = useState(() => matchMedia(compactQuery).matches);
  const [focused, setFocused] = useState(false);
  const [taskRevision, setTaskRevision] = useState(0);
  const open = !!route.inspector;
  useEffect(() => {
    const media = matchMedia(compactQuery);
    const onChange = () => setCompact(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    if (open && compact) {
      const overflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = overflow; };
    }
  }, [open, compact]);
  useEffect(() => {
    if (open) return;
    setFocused(false);
    const element = returnFocus.current;
    if (element?.isConnected) element.focus({ preventScroll: true });
    returnFocus.current = null;
  }, [open, returnFocus]);
  useEffect(() => {
    if (!open) return;
    function keydown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"][data-state="open"]')) return;
      event.preventDefault();
      close();
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [open, close]);

  return <AdminListContext.Provider value={{ setProjects, paused: open && compact, taskRevision, refreshTasks: () => setTaskRevision(value => value + 1) }}>
    <div className={'page admin-app' + (open ? ' has-inspector' : '') + (focused ? ' focus-inspector' : '')}>
      <div className="admin-main" inert={open && (compact || focused)}>
        <Suspense fallback={<Loading label="正在打开管理页面…" />}><Main route={baseRoute(route)} /></Suspense>
      </div>
      {open && <Inspector projects={route.view === 'works' ? projects : []} compact={compact} focused={focused} onFocus={() => setFocused(!focused)} onClose={close} />}
    </div>
  </AdminListContext.Provider>;
}
