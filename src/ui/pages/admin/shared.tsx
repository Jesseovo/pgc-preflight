import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import type { AdminInspector, AdminMemberOption, AdminProject, AdminRoute, AdminView } from '../../../admin/contracts';
import { readRoute, routeUrl } from '../../../admin/navigation';
import { useApp } from '../../context';
import { Badge, Button, ErrorState, Loading, Table } from '../../components/ui';
import { api, copyText } from '../../lib/api';

export const adminPath = (path: string) => '/api/admin/' + path;
export const segment = (value: string | number) => encodeURIComponent(value);
export function time(value: string | number | null | undefined) {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
export const day = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export const ranges = [['all', '全部时间'], ['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天']] as const;

export const AdminListContext = createContext<{
  setProjects: (projects: AdminProject[]) => void;
  paused: boolean;
  taskRevision: number;
  refreshTasks: () => void;
} | null>(null);

export function useAdminListInterval(interval: number) {
  return useContext(AdminListContext)?.paused ? undefined : interval;
}
export type AdminDetailState = {
  focus: RefObject<HTMLElement | null>;
  entries: Map<string, { trail: AdminInspector[]; depth: number }>;
};
export const AdminDetailContext = createContext<AdminDetailState | null>(null);
const fallbackFocus: RefObject<HTMLElement | null> = { current: null };

export function useAdminRoute() {
  const { params, navigate, notify } = useApp();
  const route = readRoute(params.toString());
  const update = (change: Partial<AdminRoute>, replace = false) => {
    const next = { ...route, ...change };
    const url = routeUrl(next);
    if (location.pathname + location.search === url) return;
    navigate(url, replace);
  };
  const visit = (view: AdminView, change: Partial<AdminRoute> = {}) => navigate(routeUrl({ ...readRoute('view=' + view), ...change }));
  const detailState = useContext(AdminDetailContext);
  const returnFocus = detailState?.focus || fallbackFocus;
  const currentEntry = detailState?.entries.get(routeUrl(route));
  const trail = currentEntry?.trail || [];
  const depth = currentEntry?.depth || 0;
  const previous = trail[trail.length - 1];
  const inspect = (inspector: AdminInspector, replace = false) => {
    const same = route.inspector?.kind === inspector.kind && route.inspector.id === inspector.id && route.inspector.type === inspector.type;
    if ((!route.inspector || replace && !same) && document.activeElement instanceof HTMLElement && !document.activeElement.closest('.admin-inspector')) returnFocus.current = document.activeElement;
    const target = routeUrl({ ...route, inspector });
    if (target === routeUrl(route)) return;
    if (detailState) {
      detailState.entries.set(target, {
        trail: route.inspector && !same && !replace ? [...trail, route.inspector] : trail,
        depth: replace || same ? depth : depth + 1,
      });
      if (detailState.entries.size > 64) {
        const oldest = detailState.entries.keys().next().value;
        if (oldest) detailState.entries.delete(oldest);
      }
    }
    navigate(target, replace || same);
  };
  const back = () => {
    if (previous) history.back();
  };
  const close = () => {
    if (depth) history.go(-depth);
    else update({ inspector: undefined }, true);
  };
  return { route, update, visit, inspect, notify, copy: copyText, previous, back, close, returnFocus };
}

export function post<T>(path: string, body?: unknown) {
  return api<T>(adminPath(path), { method: 'POST', body });
}

export function Options({ items }: { items: readonly (readonly [string, string])[] }) {
  return items.map(([value, label]) => <option key={value} value={value}>{label}</option>);
}

export function MemberOptions({ members, current }: { members?: AdminMemberOption[]; current?: string }) {
  return <><option value="">全部成员</option>{current && !members?.some(member => member.id === current) && <option value={current}>指定成员</option>}{members?.map(member => <option key={member.id} value={member.id}>{member.displayName || member.username}{!member.enabled ? ' · 已停用' : ''}</option>)}</>;
}

export function Check({ name, label, hint, checked, required }: { name?: string; label: string; hint?: string; checked?: boolean; required?: boolean }) {
  return <label className="admin-check"><input type="checkbox" name={name} defaultChecked={checked} required={required} /><span>{label}{hint && <small className="muted">{hint}</small>}</span></label>;
}

export function DataState<T>({ resource, label, children }: { resource: { data: T | undefined; error: string | null; reload: () => void }; label?: string; children: (data: T) => ReactNode }) {
  return <>{resource.error && <ErrorState error={resource.error} onRetry={resource.reload} />}{resource.data !== undefined ? children(resource.data) : !resource.error && <Loading label={label} />}</>;
}

export function ResponsiveTable({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <Table className={'admin-responsive-table ' + className} role="table">{children}</Table>;
}

export function Cell({ label, wide = false, children }: { label?: string; wide?: boolean; children: ReactNode }) {
  return <td role="cell" data-wide={wide || undefined}>{label && <span className="admin-mobile-label" aria-hidden="true">{label}</span>}{children}</td>;
}

export function Status({ value, children }: { value: string; children: ReactNode }) {
  const tone = /fail|error|expired|cancel|interrupt/.test(value) ? 'danger' : /success|complete|done|ready|product/.test(value) ? 'sage' : /running|queued|active|processing/.test(value) ? 'blue' : 'neutral';
  return <Badge tone={tone}>{children}</Badge>;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="spread admin-pager"><span className="muted small">第 {page} / {pages} 页 · 共 {total} 项</span><div className="row"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</Button><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</Button></div></div>;
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return <dl className="admin-facts">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl>;
}

export function Download({ href, children }: { href: string; children: ReactNode }) {
  return <a className="admin-download" href={href} download>{children}</a>;
}

export function StatusText({ busy, error, label = '正在保存…' }: { busy: boolean; error: string | null; label?: string }) {
  return <>{busy && <p role="status" className="muted small"><progress className="admin-progress" /> {label}</p>}{error && <p role="alert" className="danger-text">{error}</p>}</>;
}
