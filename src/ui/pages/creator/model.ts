import type { PublicHarnessTask } from '../../../harness-status';

export const forge = '/api/forge';
export const dims = ['subject', 'medium', 'gesture', 'structure', 'mood'] as const;
export type Dim = typeof dims[number];
export const dimensionLabels = { subject: '题材', medium: '美术媒介', gesture: '手势', structure: '挑战结构', mood: '情绪基调' };
export const stageLabels: Record<string, string> = { expand: '扩写', brief: '简报', preview: '样板图', assets: '美术资产', game: '游戏成品', product: '游戏成品', build: '制作', polish: '精修', repair: '定向修复', repair2: '第二次定向修复', capture: '采集', suggest: '词库建议', tag: '作品打标签', 'mechanism-check': '机制查重' };
export type Kind = 'expand' | 'brief' | 'preview' | 'assets' | 'game';
export type Executor = 'agent' | 'platform';
export type Idea = Partial<Record<Dim | 'title' | 'logline' | 'core_loop' | 'controls' | 'twist' | 'progression' | 'art_direction' | 'audio' | 'why_addictive' | 'risks' | 'strength' | 'action' | 'rule' | 'dup_of', string>> & {
  palette?: string[];
  keywords?: string[];
  candidates?: Idea[];
  recommended?: number[];
};
export type Topic = Partial<Record<Dim, string>> & {
  id: number;
  status: string;
  creative_version?: number;
  origin?: string;
  data?: Idea;
  note?: string;
  requirements?: string;
  created_at?: string;
  updated_at?: string;
  has_brief?: boolean | number;
  has_preview?: boolean | number;
  has_assets?: boolean | number;
  has_product?: boolean | number;
  expand_status?: string;
  expand_error?: string;
  brief_status?: string;
  brief_error?: string;
  assets_status?: string;
  assets_error?: string;
  product_status?: string;
  product_error?: string;
  brief_export?: string;
  brief_md?: string;
  preview_svg?: string;
};
export interface CreatorState { creative_v2_available?: boolean; fresh_subjects?: number; vocab?: number }
export interface Rules { draw_size?: string | number; redlines?: string; template?: string; template_f?: string }
export interface Word { id: number; dim: Dim; word: string; enabled: number; note?: string; base?: number; factor?: number; used?: boolean }
export interface Task {
  id: string;
  kind: string;
  scope?: string;
  status: string;
  executor?: Executor;
  harness?: PublicHarnessTask;
  detail?: string;
  error?: string;
  phase?: string;
  created_at?: string;
  started_at?: string;
  updated_at?: string;
  result?: { version_id?: string; check_id?: string; disposition?: string; id?: number; suggested?: number; tagged?: number; added?: number; remaining?: number } | null;
}
export interface Version {
  id: string;
  kind: Kind;
  executor: string;
  model?: string;
  disposition: string;
  current?: boolean;
  stale?: boolean;
  input_versions?: Record<string, string> | string;
  restored_from?: string;
  created_at?: string;
  content?: string;
}
export interface MechanismCheck {
  check_id: string;
  state: string;
  effective_state?: string;
  stale?: boolean;
  model?: { executor: Executor; name: string };
  judgment?: { matches?: { reason?: string }[] };
  admin_resolution?: { reason?: string };
}

export const titleOf = (topic: Topic) => topic.data?.title || topic.subject || `项目 ${topic.id}`;
export const isSeed = (topic: Topic) => topic.origin === 'mechanism-seed';
export const isActive = (task?: Task) => task?.status === 'queued' || task?.status === 'running';
export const taskStatus = (task: Task) => task.status === 'queued' ? task.executor === 'agent' ? '等待 Agent 接单' : '平台排队'
  : task.status === 'running' ? task.executor === 'agent' ? '等待 Agent 回传' : '平台执行中'
  : task.status === 'done' ? task.result?.disposition === 'pending' ? '完成 · 待采用' : '已完成' : task.status === 'error' ? '未完成' : task.status;
export const taskProject = (task: Task) => Number(task.scope?.match(/:(?:expand|brief|preview|assets|game|mechanism-check):(\d+)(?::\d+)?$/)?.[1] || task.scope?.match(/^game:(\d+)$/)?.[1] || task.result?.id || 0);
export const latestTask = (tasks: Task[], topicId: number, kind: Kind) => tasks.find(task => task.kind === kind && taskProject(task) === topicId);
export const displayDate = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : value || '—';
export const safeFilename = (value: string) => value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100);
export const hasArtifact = (topic: Topic, kind: Kind) => ({
  expand: Boolean(topic.data?.title || topic.data?.candidates), brief: topic.has_brief, preview: topic.has_preview, assets: topic.has_assets, game: topic.has_product,
})[kind];
export function oldStageState(topic: Topic, kind: Kind) {
  switch (kind) {
    case 'game': return { status: topic.product_status, error: topic.product_error };
    case 'expand': return { status: topic.expand_status, error: topic.expand_error };
    case 'brief': return { status: topic.brief_status, error: topic.brief_error };
    case 'assets': return { status: topic.assets_status, error: topic.assets_error };
    default: return {};
  }
}
export function projectState(topic: Topic, tasks: Task[]) {
  const latest = Object.keys({ expand: 1, brief: 1, preview: 1, assets: 1, game: 1 }).map(kind => latestTask(tasks, topic.id, kind as Kind) ?? oldStageState(topic, kind as Kind));
  if (latest.some(task => task.status === 'queued' || task.status === 'running')) return 'working';
  if (latest.some(task => task.status === 'error')) return 'error';
  return topic.has_product ? 'product' : 'draft';
}
export function creatorUrl(params: URLSearchParams | Record<string, string | number>) {
  const query = params instanceof URLSearchParams ? params : new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  return '/forge/' + (query.size ? '?' + query.toString() : '');
}
export function storageGet(key: string, local = false) {
  try { return (local ? localStorage : sessionStorage).getItem(key); } catch { return null; }
}
export function storageSet(key: string, value: string, local = false) {
  try { (local ? localStorage : sessionStorage).setItem(key, value); } catch { /* Storage can be disabled. */ }
}
