import { useState, type FormEvent } from 'react';
import type { ModelView } from '../../../model-panel';
import { modelCapabilities, type ThinkingEffort } from '../../../model-options';
import { Badge, Button, Card, ConfirmAction, Dialog, EmptyState, Field, Input, Select, Stat } from '../../components/ui';
import { api, useAction, useResource } from '../../lib/api';
import { adminPath, Cell, DataState, Facts, post, ResponsiveTable, segment, StatusText, time, useAdminRoute } from './shared';

type Profile = ModelView['profiles'][string];
type Role = 'review' | 'create';
type QuotaPeriod = { remaining?: number | null; limit?: number | null; used?: number | null; resetAt?: string };
type Quota = { available?: number | null; daily: QuotaPeriod; total: QuotaPeriod; reservations: { amount?: number; requests?: number }; queriedAt: string; requestsPerMinute?: number; pendingReviewRequests?: number };
type QuotaRead = { value?: Quota; error?: string };
type ModelRun = { model: string; purpose: string; status: string; effort?: string; max_tokens?: number; input_tokens?: number | null; output_tokens?: number | null; first_text_ms?: number | null; elapsed_ms?: number; finish_reason?: string; error?: string; created_at: string };
const effortLabels: Record<ThinkingEffort, string> = { auto: '自动', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
const purposes: Record<string, string> = { review: '审核初评', review_verify: '评分复核', expand: '选题扩写', brief: '制作简报', preview: '样板图', assets: '美术资产', game: '游戏制作', tags: '打标', vocab: '补充词库' };
const riffle = (profile: Profile) => profile.hasKey && /^https:\/\/riffle-api\.pages\.dev(?:\/|$)/i.test(profile.baseUrl) && /^claude-opus-5-5$/i.test(profile.model);
const money = (amount: number | null | undefined) => amount === null ? '未设上限' : typeof amount === 'number' ? amount.toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' }) : '未提供';
const seconds = (ms?: number | null) => ms == null ? '未提供' : (ms / 1000).toFixed(1) + ' 秒';

function QuotaDetails({ value }: { value: Quota }) {
  return <div className="stack">
    <div className="stats-grid"><Stat label="当前可用" value={money(value.available)} /><Stat label="今日剩余 / 上限" value={money(value.daily.remaining) + ' / ' + money(value.daily.limit)} /><Stat label="总剩余 / 上限" value={money(value.total.remaining) + ' / ' + money(value.total.limit)} /></div>
    <Facts items={[[ '今日已用', money(value.daily.used) ], [ '累计已用', money(value.total.used) ], [ '在途预占', money(value.reservations.amount) + ' · ' + (value.reservations.requests ?? '未知') + ' 笔' ], [ '请求限制', value.requestsPerMinute == null ? '未提供' : value.requestsPerMinute + ' 次 / 分钟' ], [ '每日重置', time(value.daily.resetAt) ], [ '待核算请求', value.pendingReviewRequests ], [ '查询时间', time(value.queriedAt) ]]} />
    <p className="small muted">当前可用已扣除在途预占，未结算用量可能使余额变化。</p>
  </div>;
}

function ModelEditor({ id, profile, existing, active, onClose, onSaved, quota, onQuota }: { id: string; profile: Profile; existing: boolean; active: boolean; onClose: () => void; onSaved: (value: ModelView) => void; quota?: QuotaRead; onQuota: (quota: QuotaRead) => void }) {
  const action = useAction();
  const { notify } = useAdminRoute();
  const [fields, setFields] = useState({ name: profile.name || '', baseUrl: profile.baseUrl, model: profile.model, protocol: profile.protocol, enabled: profile.enabled, vision: profile.vision !== false, effort: profile.effort || 'auto', maxOutputTokens: profile.maxOutputTokens || 0 });
  const [showKey, setShowKey] = useState(false);
  const [testNote, setTestNote] = useState('');
  const cap = modelCapabilities(fields);
  const effort = cap.efforts.some(value => value === fields.effort) ? fields.effort : 'auto';
  const change = <K extends keyof typeof fields,>(key: K, value: typeof fields[K]) => setFields(current => ({ ...current, [key]: value }));
  const payload = (form: HTMLFormElement) => ({ profile: id, ...fields, effort, apiKey: String(new FormData(form).get('apiKey') || '') });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = payload(event.currentTarget);
    void action.run(async () => {
      const value = await api<ModelView>(adminPath('config'), { method: 'PUT', body });
      notify('模型配置已保存。', 'success');
      onSaved(value);
    });
  };

  return <Dialog open onOpenChange={open => { if (!open && !action.busy) onClose(); }} title={existing ? '编辑模型' : '添加模型'} wide>
    <form className="stack" onSubmit={submit}><fieldset className="stack" disabled={action.busy}>
      <div className="grid-2">
        <Field label="显示名称"><Input value={fields.name} onChange={event => change('name', event.target.value)} maxLength={60} required /></Field>
        <Field label="接口协议"><Select value={fields.protocol} onChange={event => change('protocol', event.target.value as Profile['protocol'])}><option value="openai">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></Select></Field>
      </div>
      <Field label="接口地址" hint="服务商提供的 HTTPS 接口地址。"><Input type="url" value={fields.baseUrl} onChange={event => change('baseUrl', event.target.value)} autoComplete="off" placeholder="https://api.example.com/v1" required /></Field>
      <Field label="模型 ID"><Input value={fields.model} onChange={event => change('model', event.target.value)} maxLength={150} required /></Field>
      <div className="grid-2">
        <Field label="思考强度"><Select value={effort} onChange={event => change('effort', event.target.value as ThinkingEffort)}><option value="auto">自动</option>{cap.efforts.map(value => <option key={value} value={value}>{effortLabels[value]}</option>)}</Select></Field>
        <Field label="单次输出上限（Token）" hint={'0 使用任务默认值。此接口上限 ' + cap.maxOutput.toLocaleString('zh-CN') + '。'}><Input type="number" value={fields.maxOutputTokens} onChange={event => change('maxOutputTokens', Number(event.target.value))} min={0} max={cap.maxOutput} step={1} required /></Field>
      </div>
      <Field label="API Key" hint={profile.hasKey ? '留空保留已加密的 Key。更换接口地址或协议时须重新填写。' : '此配置使用的 Key。'}><Input type={showKey ? 'text' : 'password'} name="apiKey" maxLength={2000} autoComplete="new-password" required={!profile.hasKey} /></Field>
      <div className="row"><Button variant="ghost" size="sm" onClick={() => setShowKey(!showKey)}>{showKey ? '隐藏本次输入' : '显示本次输入'}</Button>{profile.hasKey && <Badge tone="sage">Key 已加密保存</Badge>}</div>
      <div className="grid-2">
        <label className="admin-check"><input type="checkbox" checked={fields.enabled} onChange={event => change('enabled', event.target.checked)} /><span>启用</span></label>
        <label className="admin-check"><input type="checkbox" checked={fields.vision} onChange={event => change('vision', event.target.checked)} /><span>支持图片<small className="muted">关闭后，审核只用源码和日志判断视觉内容。</small></span></label>
      </div>
      <div className="row">
        <Button type="submit">保存模型</Button>
        <Button variant="outline" onClick={event => {
          const form = event.currentTarget.form;
          if (!form?.reportValidity()) return;
          const body = payload(form);
          setTestNote('');
          void action.run(async () => {
            const result = await post<{ vision?: boolean | null }>('test', body);
            if (body.vision && result.vision === false) { change('vision', false); setTestNote('文字连接成功，图片输入不可用。图片选项已取消，保存后生效。'); }
            else setTestNote(!body.vision ? '文字连接成功。' : result.vision === null ? '文字连接成功，图片测试暂未完成。' : '文字与图片输入均连接成功。');
          });
        }}>测试连接{fields.vision ? '与图片' : ''}</Button>
        {profile.updatedAt && !active && <ConfirmAction variant="destructive" description="删除此模型配置及其保存的 Key。" onConfirm={async () => {
          const value = await api<ModelView>(adminPath('config/profile'), { method: 'DELETE', body: { profile: id } });
          notify('模型配置已删除。', 'success');
          onSaved(value);
        }}>删除配置</ConfirmAction>}
      </div>
      {active && <p className="small muted">当前用途仍在使用此配置。切换用途后可删除。</p>}
      {testNote && <p role="status">{testNote}</p>}
    </fieldset><StatusText {...action} label="正在处理模型配置…" /></form>
    {riffle(profile) && <section className="stack"><div className="spread"><h3>Opus Key 预算</h3><Button variant="outline" size="sm" disabled={action.busy} onClick={() => void action.run(async () => {
      try { onQuota({ value: await api<Quota>(adminPath('quota?profile=' + segment(id))) }); }
      catch (error) { onQuota({ value: quota?.value, error: error instanceof Error ? error.message : '余额查询失败。' }); }
    })}>查询已保存 Key</Button></div>
      {quota?.error && <p className="danger-text" role="alert">{quota.error}</p>}
      {quota?.value ? <QuotaDetails value={quota.value} /> : <p className="small muted">查询人民币预算、在途预占及请求限制。</p>}
    </section>}
  </Dialog>;
}

function RecentRuns() {
  const [open, setOpen] = useState(false);
  const resource = useResource<{ runs: ModelRun[] }>(open ? adminPath('runs') : null);
  return <Card className="stack"><div className="spread"><div><h2>最近模型调用</h2><p className="small muted">最近 30 次调用的耗时、用量与结束原因。</p></div><Button variant="outline" size="sm" onClick={() => open ? resource.reload() : setOpen(true)}>{open ? '刷新记录' : '读取记录'}</Button></div>
    {open && <DataState resource={resource}>{data => data.runs.length ? <ResponsiveTable className="admin-model-runs"><thead role="rowgroup"><tr role="row"><th>用途 / 模型</th><th>状态 / 耗时</th><th>Token</th><th>结束原因</th></tr></thead><tbody role="rowgroup">{data.runs.map((run, index) => <tr role="row" key={index}>
      <Cell wide>{purposes[run.purpose] || run.purpose}<small className="muted">{run.model} · {time(run.created_at)}</small></Cell>
      <Cell label="状态 / 耗时"><Badge tone={run.status === 'ok' ? 'sage' : 'warning'}>{run.status === 'ok' ? '已完整接收' : '未完成'}</Badge><small className="muted">{seconds(run.elapsed_ms)} · 首字 {seconds(run.first_text_ms)}</small></Cell>
      <Cell label="Token" wide>输入 {run.input_tokens ?? '未提供'} · 输出 {run.output_tokens ?? '未提供'} / {run.max_tokens ?? '未提供'}<small className="muted">思考强度 {run.effort || '未记录'}</small></Cell>
      <Cell label="结束原因" wide>{run.finish_reason || '未记录'}{run.error && <small className="danger-text">{run.error}</small>}</Cell>
    </tr>)}</tbody></ResponsiveTable> : <EmptyState title="暂无调用记录" />}</DataState>}
  </Card>;
}

function ModelLibrary({ config, onSaved }: { config: ModelView; onSaved: (value: ModelView) => void }) {
  const action = useAction(), balances = useAction();
  const { notify } = useAdminRoute();
  const [editor, setEditor] = useState<{ id: string; profile: Profile } | null>(null);
  const [quotas, setQuotas] = useState<Record<string, QuotaRead>>({});
  const [pending, setPending] = useState<Partial<Record<Role, string>>>({});
  const effective: Record<Role, string> = { review: config.effective.review || config.activeProfile, create: config.effective.create || config.activeProfile };
  const entries = Object.entries(config.profiles);
  const name = (id: string) => config.profiles[id]?.name || config.profiles[id]?.model || id;
  const eligible = (id: string) => !!config.profiles[id]?.enabled && !!config.profiles[id]?.hasKey;
  const count = entries.filter(([, profile]) => profile.hasKey).length;
  function saveRoutes(next: Record<Role, string>) {
    void action.run(async () => {
      const value = await post<ModelView>('config/routes', { ...next, activeProfile: next.create });
      setPending({});
      onSaved(value);
      notify('两组模型用途已保存。', 'success');
    });
  }
  function refreshBalances() {
    void balances.run(async () => {
      for (const [id, profile] of entries) {
        if (!riffle(profile)) continue;
        try {
          const value = await api<Quota>(adminPath('quota?profile=' + segment(id)));
          setQuotas(current => ({ ...current, [id]: { value } }));
        } catch (error) {
          setQuotas(current => ({ ...current, [id]: { value: current[id]?.value, error: error instanceof Error ? error.message : '余额查询失败。' } }));
        }
      }
    });
  }
  return <div className="stack">
    <Card className="stack"><div className="spread"><div><h2>模型配置</h2><p className="small muted">每份配置独立保存一个 Key。平台游戏制作使用可用的 Claude Opus 5.5。</p></div><div className="row">
      <Button variant="outline" size="sm" disabled={balances.busy || !entries.some(([, profile]) => riffle(profile))} onClick={refreshBalances}>刷新余额</Button>
      <Button size="sm" disabled={count >= 24} onClick={() => {
        const active = config.profiles[config.activeProfile];
        setEditor({ id: 'model-' + crypto.randomUUID(), profile: { name: '', baseUrl: active?.baseUrl || '', model: active?.model || '', protocol: active?.protocol || 'openai', enabled: true, vision: active?.vision, hasKey: false, updatedAt: '' } });
      }}>添加模型</Button>
    </div></div><p className="small muted">{count} / 24 份已配置</p>
    <StatusText {...balances} label="正在查询已保存 Key 的余额…" />
    {entries.length ? <ResponsiveTable className="admin-model-table"><thead role="rowgroup"><tr role="row"><th>配置 / 接口</th><th>状态</th><th>余额</th><th>用途</th><th>操作</th></tr></thead><tbody role="rowgroup">{entries.map(([id, profile]) => <tr role="row" key={id}>
      <Cell wide><b>{name(id)}</b><small className="muted">{profile.model} · {profile.protocol}</small><small className="muted">{profile.baseUrl || '地址未填写'}</small></Cell>
      <Cell label="状态"><Badge tone={eligible(id) ? 'sage' : 'neutral'}>{!profile.hasKey ? '待配置 Key' : profile.enabled ? '启用' : '停用'}</Badge>{profile.vision !== false && <small className="muted">支持图片</small>}</Cell>
      <Cell label="余额">{quotas[id]?.value ? <><span>可用 {money(quotas[id].value?.available)}</span><small className="muted">总剩余 {money(quotas[id].value?.total.remaining)}</small></> : <span className="muted small">{riffle(profile) ? '余额待查询' : '余额暂不支持'}</span>}{quotas[id]?.error && <small className="danger-text">{quotas[id].error}</small>}</Cell>
      <Cell label="用途" wide><div className="row">{effective.create === id && <Badge tone="sage">创作首选</Badge>}{effective.review === id && <Badge tone="blue">审核使用中</Badge>}{riffle(profile) && profile.enabled && <Badge>制作池</Badge>}</div></Cell>
      <Cell wide><div className="row"><Button size="sm" variant="ghost" onClick={() => setEditor({ id, profile })}>编辑</Button>
        <Button size="sm" variant="outline" disabled={action.busy || !eligible(id) || effective.create === id || !eligible(effective.review)} onClick={() => saveRoutes({ ...effective, create: id })}>用于创作</Button>
        <Button size="sm" variant="outline" disabled={action.busy || !eligible(id) || effective.review === id || !eligible(effective.create)} onClick={() => saveRoutes({ ...effective, review: id })}>用于审核</Button></div></Cell>
    </tr>)}</tbody></ResponsiveTable> : <EmptyState title="暂无模型配置" />}
    </Card>
    <Card className="stack"><h2>模型用途</h2><p className="small muted">两组选择一起保存。其他功能的模型同时作为旧版兼容默认。</p><form className="stack" onSubmit={event => { event.preventDefault(); saveRoutes({ ...effective, ...pending }); }}>
      <div className="grid-2">{([['review', 'AI 审核', '模拟初评与同模型复核'], ['create', '其他功能', '扩写、简报、样板图、资产等。游戏制作固定使用 Opus 5.5。']] as const).map(([role, label, hint]) => <Field key={role} label={label} hint={hint}>
        <Select value={pending[role] || effective[role]} onChange={event => setPending(current => ({ ...current, [role]: event.target.value }))}>
          {entries.map(([id, profile]) => <option key={id} value={id} disabled={!eligible(id)}>{name(id)}{!profile.hasKey ? ' · 待配置' : !profile.enabled ? ' · 停用' : ''}</option>)}
        </Select></Field>)}</div>
      <Button type="submit" disabled={action.busy || !eligible(pending.review || effective.review) || !eligible(pending.create || effective.create)}>保存两组模型用途</Button>
    </form><StatusText {...action} /></Card>
    <RecentRuns />
    {editor && <ModelEditor key={editor.id} id={editor.id} profile={editor.profile} existing={!!config.profiles[editor.id]} active={effective.review === editor.id || effective.create === editor.id || config.activeProfile === editor.id}
      onClose={() => setEditor(null)} onSaved={value => { setQuotas(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== editor.id))); onSaved(value); setEditor(null); }}
      quota={quotas[editor.id]} onQuota={value => setQuotas(current => ({ ...current, [editor.id]: value }))} />}
  </div>;
}

export default function Models() {
  const resource = useResource<ModelView>(adminPath('config'));
  return <DataState resource={resource} label="正在读取模型配置…">{config => <ModelLibrary config={config} onSaved={resource.setData} />}</DataState>;
}
