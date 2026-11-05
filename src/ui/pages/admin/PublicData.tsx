import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, ConfirmAction, Dialog, EmptyState, Field, Input, JsonDetails, Select, Table, Textarea } from '../../components/ui';
import { api, useAction, useResource } from '../../lib/api';
import { adminPath, Cell, Check, DataState, Options, Pager, post, ResponsiveTable, segment, StatusText, time, useAdminRoute } from './shared';

const dims = { subject: '题材', medium: '美术媒介', gesture: '手势', structure: '挑战结构', mood: '情绪基调' } as const;
type Dim = keyof typeof dims;
type Word = { id: number; dim: Dim; word: string; note?: string; base?: number; enabled: number | boolean };
type Suggestion = { id: string; dim: Dim; ownerName: string; created_at: string; words: ({ word: string; note?: string } | string)[] };
type Game = { id: number; title: string; owner_id: string; genre?: string; is_public: number | boolean };
type SharedData = { settings: Record<string, string>; vocab: Word[]; games: Game[]; publishableGames?: Game[]; suggestions: Suggestion[] };
type RulesVersion = { id: string; publishedAt?: string; createdAt?: string; sourceUrl: string; capturedAt: string; contentHash: string };
type RulesData = { active: RulesVersion | null; candidate: RulesVersion | null; history: RulesVersion[]; diff: { field: string; before: unknown; after: unknown }[] };
const templateFields = [['redlines', '选题规律与雷区'], ['template', '制作模板'], ['template_f', 'F 部分骨架']] as const;
const stringify = (value: unknown) => value == null ? '未记录' : typeof value === 'string' ? value || '（空）' : JSON.stringify(value, null, 2);

function Rules() {
  const [id, setId] = useState('');
  const [snapshot, setSnapshot] = useState(() => JSON.stringify({ sourceUrl: 'https://creator-hub-7mi.pages.dev/#/', capturedAt: new Date().toISOString(), rawDirection: '', rawScoring: '', scoreMin: 0, scoreMax: 3, passScore: 7, notes: '', calibrationCases: [] }, null, 2));
  const resource = useResource<RulesData>(adminPath('review-rules' + (id ? '?id=' + segment(id) : '')));
  const action = useAction();
  const { notify } = useAdminRoute();
  return <Card className="stack"><h2>AI 审核规则版本</h2>
    <p className="small muted">从已授权的 Creator Hub 首页会话采集原文。导入创建草稿，核对差异后明确发布。新任务锁定发布版，在途和历史报告保留原版。</p>
    <DataState resource={resource}>{data => <>
      <div>{data.active ? <><Badge tone="sage">当前版本</Badge> {data.active.id} · {time(data.active.publishedAt)}<JsonDetails value={data.active} label="当前规则与来源" /></> : <p>尚未发布新规则，继续使用旧版 1–3 分规则。</p>}</div>
      <details><summary>导入首页规则快照</summary>
        <form className="stack" onSubmit={event => {
          event.preventDefault();
          void action.run(async () => {
            let parsed: unknown;
            try { parsed = JSON.parse(snapshot); } catch { throw new Error('规则内容不是合法 JSON。'); }
            const result = await post<{ candidate: RulesVersion }>('review-rules', { action: 'import', snapshot: parsed });
            if (result.candidate.id === id) resource.reload(); else setId(result.candidate.id);
            notify('规则草稿已导入，请核对差异。', 'success');
          });
        }}>
          <Field label="规则 JSON 文件"><Input type="file" accept=".json,application/json" onChange={event => {
            const file = event.target.files?.[0];
            if (!file) return;
            void action.run(async () => { if (file.size > 800_000) throw new Error('规则快照过大。'); setSnapshot(await file.text()); });
          }} /></Field>
          <Field label="首页快照 JSON" hint="保留原文措辞。calibrationCases 仅接受明确公开的脱敏案例，未知参考分填写 null。"><Textarea name="snapshot" rows={12} spellCheck={false} value={snapshot} onChange={event => setSnapshot(event.target.value)} required /></Field>
          <Button type="submit" disabled={action.busy}>导入为草稿并比较</Button>
        </form>
      </details>
      {data.candidate && <section className="stack"><h3>版本 {data.candidate.id} 与当前规则比较</h3>
        <p className="small muted">来源 {data.candidate.sourceUrl} · 采集于 {time(data.candidate.capturedAt)} · SHA-256 <code>{data.candidate.contentHash}</code></p>
        {data.diff.length ? data.diff.map(row => <details key={row.field} open><summary>{row.field}</summary><div className="grid-2"><div><b>当前规则</b><pre>{stringify(row.before)}</pre></div><div><b>此版本</b><pre>{stringify(row.after)}</pre></div></div></details>) : <p>与当前规则内容一致。</p>}
        {data.candidate.publishedAt ? <p className="small muted">已发布版本只读。</p> : <form key={data.candidate.id} className="stack" onSubmit={event => {
          event.preventDefault();
          if (!data.candidate) return;
          const candidate = data.candidate.id;
          void action.run(async () => {
            await post('review-rules', { action: 'publish', id: candidate, expectedActiveId: data.active?.id ?? null });
            resource.reload();
            notify('规则已发布，新审核任务将锁定此版本。', 'success');
          });
        }}><Check label="已核对原文、差异与公开校准案例，确认发布" required /><Button type="submit" disabled={action.busy}>明确发布此规则版本</Button></form>}
      </section>}
      <details><summary>导入及发布历史 · 最近 100 份</summary>{data.history.length ? <div className="stack admin-scroll">{data.history.map(row => <div className="spread" key={row.id}>
        <span>{row.id} <small className="muted">{row.publishedAt ? '发布于 ' + time(row.publishedAt) : '草稿 · ' + time(row.createdAt)}{row.id === data.active?.id ? ' · 当前' : ''}</small></span>
        <Button variant="outline" size="sm" onClick={() => row.id === id ? resource.reload() : setId(row.id)}>查看 / 比较</Button>
      </div>)}</div> : <p className="muted">暂无规则快照。</p>}</details>
    </>}</DataState><StatusText {...action} />
  </Card>;
}

type Mechanism = { id: number | string; subject: string; action: string; rule: string; structure: string };
type MechanismCheck = { id: string; stale?: boolean; admin_resolution?: unknown; state: string };
const summaryFields = [['subject', '题材'], ['action', '玩家动作'], ['rule', '核心规则'], ['structure', '玩法结构']] as const;

function Mechanisms() {
  const { notify } = useAdminRoute();
  const action = useAction();
  const [catalog, setCatalog] = useState<Mechanism[]>([]);
  const [next, setNext] = useState<number | null>(0);
  const [check, setCheck] = useState<MechanismCheck | null>(null);
  const [checkId, setCheckId] = useState('');
  async function read(after: number, replace = false) {
    const data = await api<{ items: Mechanism[]; next?: number | null }>('/api/forge/mechanisms?after=' + after);
    setCatalog(current => replace ? data.items : [...current, ...data.items]);
    setNext(data.next ?? null);
  }
  async function readCheck(id: string) {
    const data = await api<MechanismCheck>('/api/forge/mechanisms/' + segment(id));
    setCheckId(id);
    setCheck(data);
  }
  return <Card className="stack"><h2>创作机制目录与争议复核</h2>
    <p className="small muted">目录共享题材、动作、规则和结构。历史摘要由管理员逐条发布，私人原始策划、源码及评语保留在原权限内。</p>
    {catalog.length > 0 && <Table><thead><tr>{summaryFields.map(([id, label]) => <th key={id}>{label}</th>)}</tr></thead><tbody>{catalog.map((row, index) => <tr key={row.id ?? index}>{summaryFields.map(([key]) => <td key={key}>{row[key]}</td>)}</tr>)}</tbody></Table>}
    {next === null && !catalog.length && <p className="small muted">尚未发布机制摘要。</p>}
    <div className="row"><Button variant="outline" disabled={action.busy || next === null} onClick={() => void action.run(() => read(next ?? 0))}>{next === null ? '已读取全部摘要' : catalog.length ? '读取下一页' : '读取目录'}</Button></div>
    <details><summary>发布一条历史机制摘要</summary><form className="stack" onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      const body = Object.fromEntries(new FormData(form));
      void action.run(async () => {
        await api('/api/forge/mechanisms/publish', { method: 'POST', body });
        form.reset();
        notify('机制摘要已发布。', 'success');
        await read(0, true);
      });
    }}>
      {[...summaryFields, ['reason', '发布依据（仅管理员可见）'] as const].map(([key, label]) => <Field key={key} label={label}><Textarea name={key} rows={2} maxLength={2000} required /></Field>)}
      <Check label="已核对脱敏与使用权限，确认公开四项摘要" required /><Button type="submit" disabled={action.busy}>发布摘要</Button>
    </form></details>
    <details><summary>复核机制查重争议</summary><div className="stack"><form className="toolbar" onSubmit={event => {
      event.preventDefault();
      const id = String(new FormData(event.currentTarget).get('check_id') || '').trim();
      if (id) void action.run(() => readCheck(id));
    }}><Field label="成员提供的查重记录 ID"><Input name="check_id" required /></Field><Button type="submit" variant="outline" disabled={action.busy}>读取原判断</Button></form>
    {check && <section className="stack"><div className="row"><b>{checkId}</b><Badge>{check.state}</Badge></div><JsonDetails value={check} label="原模型判断和记录" />
      {check.stale ? <p>候选或目录已更新，请成员重新查重。</p> : check.admin_resolution ? <p>已有不可覆盖的管理员裁定。</p> : ['distinct', 'duplicate', 'uncertain'].includes(check.state) ?
        <form className="stack" key={checkId} onSubmit={event => {
          event.preventDefault();
          const body = { check_id: checkId, ...Object.fromEntries(new FormData(event.currentTarget)) };
          void action.run(async () => {
            await api('/api/forge/mechanisms/resolve', { method: 'POST', body });
            notify('裁定已保存，成员可重新读取此记录。', 'success');
            await readCheck(checkId);
          });
        }}><Field label="裁定"><Select name="verdict"><option value="uncertain">仍不能确定</option><option value="distinct">机制有实质差异</option><option value="duplicate">机制重复</option></Select></Field>
          <Field label="具体原因与对照依据"><Textarea name="reason" rows={4} required /></Field><p className="small muted">裁定为追加记录，原模型判断继续保留。</p><Button type="submit" disabled={action.busy}>保存不可覆盖的裁定</Button></form> :
        <p>精确重复保留原判断。语义争议在模型给出判断后可复核。</p>}
    </section>}
    </div></details><StatusText {...action} label="正在读取或保存机制记录…" />
  </Card>;
}

type Mutate = (payload: unknown, message: string) => Promise<unknown>;
function Templates({ settings, mutate, busy }: { settings: SharedData['settings']; mutate: Mutate; busy: boolean }) {
  const [editing, setEditing] = useState<typeof templateFields[number] | null>(null);
  return <Card className="stack"><h2>公共规则与制作模板</h2>
    {templateFields.map(entry => <div key={entry[0]} className="spread"><div><b>{entry[1]}</b> <small className="muted">{(settings[entry[0]] || '').length.toLocaleString('zh-CN')} 字符</small></div><Button variant="outline" size="sm" onClick={() => setEditing(entry)}>编辑</Button></div>)}
    <details><summary>抽取与扩写默认值</summary><form className="toolbar" onSubmit={event => {
      event.preventDefault();
      void mutate({ action: 'settings', settings: Object.fromEntries(new FormData(event.currentTarget)) }, '默认值已保存。');
    }}>
      <Field label="每次抽取数量"><Input name="draw_size" type="number" min={1} max={100} step={1} defaultValue={settings.draw_size || '10'} required /></Field>
      <Field label="每批扩写数量"><Input name="expand_batch" type="number" min={1} max={100} step={1} defaultValue={settings.expand_batch || '5'} required /></Field>
      <Button type="submit" disabled={busy}>保存默认值</Button>
    </form></details>
    {editing && <Dialog open onOpenChange={open => { if (!open && !busy) setEditing(null); }} title={'编辑' + editing[1]} wide>
      <form className="stack" onSubmit={event => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get('value');
        void mutate({ action: 'settings', settings: { [editing[0]]: value } }, '公共规则已保存。').then(ok => { if (ok) setEditing(null); });
      }}><Field label={editing[1]}><Textarea name="value" rows={16} defaultValue={settings[editing[0]] || ''} spellCheck={false} /></Field><Button type="submit" disabled={busy}>保存</Button></form>
    </Dialog>}
  </Card>;
}

function WordEditor({ word, onClose, mutate, busy }: { word?: Word; onClose: () => void; mutate: Mutate; busy: boolean }) {
  async function save(payload: unknown, message: string) {
    if (await mutate(payload, message)) onClose();
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void save({ action: word ? 'vocab-update' : 'vocab-add', ...(word ? { id: word.id, enabled: fields.has('enabled') } : { dim: fields.get('dim') }), word: String(fields.get('word') || '').trim(), note: fields.get('note'), base: Number(fields.get('base')) }, '公共词条已保存。');
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }} title={word ? '编辑词条' : '添加词条'}>
    <form className="stack" onSubmit={submit}><fieldset className="stack" disabled={busy}>
      <Field label="维度"><Select name="dim" defaultValue={word?.dim} disabled={!!word}><Options items={Object.entries(dims)} /></Select></Field>
      <Field label="词条"><Input name="word" defaultValue={word?.word} maxLength={160} required /></Field>
      <Field label="备注"><Textarea name="note" defaultValue={word?.note} rows={3} maxLength={2000} /></Field>
      <Field label="权重"><Input name="base" type="number" min={0} step=".1" defaultValue={word?.base ?? 1} required /></Field>
      {word && <Check name="enabled" label="启用词条" hint="停用后保留记录并停止抽取。" checked={!!word.enabled} />}
      <div className="row"><Button type="submit">保存词条</Button>
        {word && <ConfirmAction variant="destructive" description={'删除公共词条「' + word.word + '」。'} onConfirm={() => save({ action: 'vocab-delete', id: word.id }, '词条已删除。')}>删除词条</ConfirmAction>}
      </div>
    </fieldset></form>
  </Dialog>;
}

function Vocabulary({ data, mutate, busy }: { data: SharedData; mutate: Mutate; busy: boolean }) {
  const [dim, setDim] = useState('');
  const [q, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<Word | true | null>(null);
  const filtered = data.vocab.filter(row => (!dim || row.dim === dim) && (row.word + ' ' + (row.note || '')).toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()));
  const size = 40, current = Math.min(page, Math.max(1, Math.ceil(filtered.length / size)));
  return <Card className="stack"><div className="spread"><h2>公共词库</h2><Button size="sm" onClick={() => setEditor(true)}>添加词条</Button></div>
    <div className="toolbar"><Field label="维度"><Select value={dim} onChange={event => { setDim(event.target.value); setPage(1); }}><option value="">全部维度</option><Options items={Object.entries(dims)} /></Select></Field>
      <Field label="搜索词条"><Input type="search" value={q} placeholder="词条或备注" onChange={event => { setQuery(event.target.value); setPage(1); }} /></Field></div>
    {filtered.length ? <ResponsiveTable className="admin-vocabulary-table"><thead role="rowgroup"><tr role="row"><th>词条</th><th>维度</th><th>备注</th><th>权重</th><th>状态</th><th>操作</th></tr></thead><tbody role="rowgroup">{filtered.slice((current - 1) * size, current * size).map(word => <tr role="row" key={word.id}>
      <Cell wide><b>{word.word}</b></Cell><Cell label="维度">{dims[word.dim] || word.dim}</Cell><Cell label="备注" wide>{word.note || '—'}</Cell><Cell label="权重">{word.base ?? 1}</Cell><Cell label="状态"><Badge tone={word.enabled ? 'sage' : 'neutral'}>{word.enabled ? '启用' : '停用'}</Badge></Cell><Cell><Button variant="outline" size="sm" onClick={() => setEditor(word)}>编辑</Button></Cell>
    </tr>)}</tbody></ResponsiveTable> : <EmptyState title="暂无匹配的词条" />}
    <Pager page={current} pageSize={size} total={filtered.length} onPage={setPage} />
    {editor && <WordEditor word={editor === true ? undefined : editor} busy={busy} mutate={mutate} onClose={() => setEditor(null)} />}
  </Card>;
}

function Suggestions({ suggestions, mutate, busy }: { suggestions: Suggestion[]; mutate: Mutate; busy: boolean }) {
  return <Card className="stack"><div className="spread"><h2>词库建议审批</h2><Badge tone="warning">{suggestions.length} 待审批</Badge></div>
    {suggestions.length ? suggestions.map(row => <section key={row.id} className="stack admin-divider"><p className="small muted">{dims[row.dim] || row.dim} · {row.ownerName} · {time(row.created_at)}</p>
      <ul>{row.words.map((word, i) => <li key={i}>{typeof word === 'string' ? word : <><b>{word.word}</b>{word.note && ' · ' + word.note}</>}</li>)}</ul>
      <div className="row"><Button size="sm" disabled={busy} onClick={() => void mutate({ action: 'suggestion-approve', id: row.id }, '建议已批准并加入公共词库。')}>批准</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate({ action: 'suggestion-reject', id: row.id }, '建议已拒绝。')}>拒绝</Button></div>
    </section>) : <EmptyState title="暂无待审批建议" />}
  </Card>;
}

function Cases({ games, mutate }: { games: Game[]; mutate: Mutate }) {
  const { inspect } = useAdminRoute();
  const [q, setQuery] = useState(''), [page, setPage] = useState(1);
  const members = useResource<{ members: { id: string; displayName: string }[] }>(adminPath('members'));
  const names = new Map(members.data?.members.map(row => [row.id, row.displayName]));
  const filtered = games.filter(game => (game.title + ' ' + (names.get(game.owner_id) || game.owner_id)).toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()));
  return <Card className="stack"><h2>公共案例</h2><p className="small muted">由管理员明确发布现有作品后，成员才会在公共案例库看到该作品。</p>
    <Field label="搜索可发布作品"><Input type="search" value={q} onChange={event => { setQuery(event.target.value); setPage(1); }} /></Field>
    {filtered.length ? <ResponsiveTable className="admin-case-table"><thead role="rowgroup"><tr role="row"><th>作品</th><th>归属</th><th>公开状态</th><th>操作</th></tr></thead><tbody role="rowgroup">{filtered.slice((page - 1) * 25, page * 25).map(game => <tr role="row" key={game.id}>
      <Cell wide><button className="admin-summary-link" onClick={() => inspect({ kind: 'project', type: 'game', id: String(game.id), panel: 'overview' })}>{game.title || '未命名作品'}</button></Cell><Cell label="归属">{names.get(game.owner_id) || (game.owner_id === 'admin' ? '管理员历史资料' : game.owner_id)}</Cell>
      <Cell label="公开状态"><Badge tone={game.is_public ? 'sage' : 'neutral'}>{game.is_public ? '公共案例' : '未公开'}</Badge></Cell>
      <Cell wide><ConfirmAction description={game.is_public ? '从公共案例库撤下此作品。' : '确认这份作品已获准作为团队共享案例发布。'} onConfirm={() => mutate({ action: 'publish-game', id: game.id, is_public: !game.is_public }, game.is_public ? '已取消公开。' : '作品已发布到公共案例库。')}>{game.is_public ? '取消公开' : '发布为公共案例'}</ConfirmAction></Cell>
    </tr>)}</tbody></ResponsiveTable> : <EmptyState title="暂无匹配的案例" />}
    <Pager page={page} pageSize={25} total={filtered.length} onPage={setPage} />
  </Card>;
}

export default function PublicData() {
  const resource = useResource<SharedData>(adminPath('public-data'));
  const action = useAction();
  const { notify } = useAdminRoute();
  const mutate: Mutate = (payload, message) => action.run(async () => {
    await post('public-data', payload);
    notify(message, 'success');
    resource.reload();
    return true;
  });
  return <section className="stack">
    <Rules /><Mechanisms />
    <DataState resource={resource} label="正在读取公共资料…">{data => <>
      <StatusText {...action} />
      <Templates settings={data.settings} mutate={mutate} busy={action.busy} />
      <Vocabulary data={data} mutate={mutate} busy={action.busy} />
      <Suggestions suggestions={data.suggestions || []} mutate={mutate} busy={action.busy} />
      <Cases games={data.publishableGames || data.games} mutate={mutate} />
    </>}</DataState>
  </section>;
}
