import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Field, Select } from '../../components/ui';
import { copyText } from '../../lib/api';
import { dimensionLabels, dims, displayDate, isActive, stageLabels, taskStatus, type Executor, type Idea, type Task, type Topic } from './model';

export function ExecutorPicker({value, onChange}: {value: Executor; onChange: (value: Executor) => void}) {
  return <Field label="创作执行方式"><Select value={value} onChange={event => onChange(event.target.value as Executor)}><option value="platform">平台执行</option><option value="agent">个人 Agent</option></Select></Field>;
}

export function CopyButton({value, children}: {value: string; children: ReactNode}) {
  return <Button size="sm" variant="outline" onClick={() => void copyText(value)}>{children}</Button>;
}

export function TopicTags({topic}: {topic: Topic}) {
  return <div className="row creator-tags">{dims.filter(dim => topic[dim]).map(dim => <Badge key={dim} tone="neutral">{dimensionLabels[dim]} · {topic[dim]}</Badge>)}</div>;
}

const ideaFields = {logline: '一句话概念', strength: '创作方向', action: '故事动作', rule: '规则', controls: '操作', core_loop: '核心循环', twist: '新机制', progression: '节奏', art_direction: '美术方向', audio: '音频', why_addictive: '吸引力', risks: '风险', dup_of: '可能相似的作品'} as const;
export function IdeaDetails({idea, compact = false, paletteShown = false}: {idea: Idea; compact?: boolean; paletteShown?: boolean}) {
  const entries = (Object.entries(ideaFields) as [keyof typeof ideaFields, string][]).filter(([key]) => idea[key] && (!compact || key !== 'logline'));
  return <><dl className="creator-facts">{entries.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{idea[key]}</dd></div>)}</dl>
    {!paletteShown && Array.isArray(idea.palette) && <div className="row creator-palette">{idea.palette.filter(color => /^#[\da-f]{6}$/i.test(color)).map((color, index) => <span key={`${color}-${index}`}><i style={{backgroundColor: color}}/>{color}</span>)}</div>}
    {idea.keywords?.length ? <p className="small muted">机制关键词 · {idea.keywords.join('、')}</p> : null}
  </>;
}

export function TaskProgress({task}: {task: Task}) {
  const active = isActive(task);
  const waiting = task.executor === 'agent';
  const label = taskStatus(task);
  const message = task.error || (task.detail === label ? '' : task.detail);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, waiting]);
  const started = Date.parse(task.started_at || task.created_at || '');
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : null;
  return <div className="creator-task-progress">
    <div className="row"><Badge tone={task.status === 'error' ? 'danger' : active ? 'warning' : 'sage'}>{label}</Badge>{task.executor && <span className="small muted">{task.executor === 'agent' ? '个人 Agent' : '平台'}</span>}
      {task.phase && task.phase !== 'done' && <span className="small">{task.phase.split(':').map(phase => stageLabels[phase] || ({model: '模型生成', ready: '准备材料', output: '保存阶段结果', captured: '采集已保存', publish: '保存最终版本'} as Record<string, string>)[phase] || phase).join(' · ')}</span>}
      {active && !waiting && seconds !== null && <span className="small muted" aria-label="经过时间">{Math.floor(seconds / 60)} 分 {seconds % 60} 秒</span>}
    </div>
    {active && !waiting && task.executor === 'platform' && <progress aria-label="后台创作任务进度"/>}
    {message && <p className={task.error ? 'small danger-text' : 'small muted'}>{message}</p>}
    {task.updated_at && <small className="muted">最近更新 {displayDate(task.updated_at)}</small>}
  </div>;
}

export function Note({children}: {children: ReactNode}) {
  return <Card className="creator-note">{children}</Card>;
}
