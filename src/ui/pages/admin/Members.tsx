import { useRef, useState, type FormEvent } from 'react';
import type { AdminMemberOption, AdminRoute } from '../../../admin/contracts';
import type { ReviewPilotMember } from '../../../admin/pilot-members';
import { Badge, Button, Card, ConfirmAction, Dialog, EmptyState, Field, Input, PageHeader, Stat } from '../../components/ui';
import { api, useAction, useResource } from '../../lib/api';
import { adminPath, Cell, Check, DataState, Facts, post, ResponsiveTable, segment, StatusText, time, useAdminRoute } from './shared';

type Member = AdminMemberOption & { canReview: boolean; dailyReviewLimit?: number; createdAt: string; updatedAt?: string; lastActivity?: string | null };
type MembersResponse = { members: Member[] };
type PilotResponse = { members: ReviewPilotMember[] };
const pilotLabels: Record<ReviewPilotMember['binding']['status'], string> = { unlinked: '未关联', declared: '仅账号声明', linked: '已关联 · 管理员确认', stale: '关联待重新核对' };

function Limit({ value }: { value: number }) {
  return <Input name="dailyReviewLimit" type="number" min={0} max={10_000} step={1} defaultValue={value} inputMode="numeric" required />;
}

function PilotBadges({ row }: { row?: ReviewPilotMember }) {
  if (!row) return <span className="muted small">状态暂未读取</span>;
  return <div className="row"><Badge tone={row.pilotEnabled && row.accountEnabled ? 'sage' : 'neutral'}>{row.pilotEnabled ? row.accountEnabled ? '灰测已启用' : '灰测已选 · 账号停用' : '未启用灰测'}</Badge><Badge tone={row.binding.status === 'linked' ? 'sage' : row.binding.status === 'stale' ? 'warning' : 'neutral'}>{pilotLabels[row.binding.status]}</Badge></div>;
}

function CreateMember({ onClose, onCreate }: { onClose: () => void; onCreate: (member: Member) => void }) {
  const action = useAction();
  const { notify } = useAdminRoute();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      const member = await post<Member>('members', { username: data.get('username'), displayName: data.get('displayName'), password: data.get('password'), canReview: data.has('canReview'), star: data.has('star'), dailyReviewLimit: Number(data.get('dailyReviewLimit')) });
      notify('账号已开通。', 'success');
      onCreate(member);
    });
  };
  return <Dialog open onOpenChange={open => { if (!open && !action.busy) onClose(); }} title="开通成员账号">
    <form className="stack" onSubmit={submit}><fieldset className="stack" disabled={action.busy}>
      <Field label="登录账号" hint="3–32 位英文、数字、点、下划线或短横线。"><Input name="username" minLength={3} maxLength={32} pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,31}" autoComplete="off" required /></Field>
      <Field label="成员姓名"><Input name="displayName" maxLength={50} required /></Field>
      <Field label="初始密码"><Input type="password" name="password" minLength={6} maxLength={128} autoComplete="new-password" required /></Field>
      <Field label="平台历史每日额度"><Limit value={50} /></Field>
      <Check name="canReview" label="允许 Agent 审核" hint="成员使用自己的 Agent 与模型审核。" checked />
      <Check name="star" label="Star 创作权限" hint="开放个人创作工作台。" />
      <div className="row"><Button type="submit">确认开通</Button><Button variant="outline" onClick={onClose}>取消</Button></div>
    </fieldset><StatusText {...action} /></form>
  </Dialog>;
}

function PilotSettings({ row, onSaved }: { row: ReviewPilotMember; onSaved: (row: ReviewPilotMember) => void }) {
  const action = useAction();
  const { notify } = useAdminRoute();
  const retry = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const save = async (endpoint: 'member' | 'link' | 'unlink', fields: Record<string, unknown>, message: string) => {
    const body = { memberId: row.memberId, ...fields, expectedRevision: row.revision };
    const fingerprint = JSON.stringify([endpoint, body]);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, id: crypto.randomUUID() };
    await action.run(async () => {
      const result = await post<{ member: ReviewPilotMember }>('review-pilots/' + endpoint, { ...body, requestId: retry.current!.id });
      if (result.member?.memberId !== row.memberId) throw new Error('未收到有效保存确认，请使用当前内容重试。');
      retry.current = undefined;
      notify(message, 'success');
      onSaved(result.member);
    });
  };

  return <><div className="grid-2">
    <form key={'pilot-' + row.revision} className="stack" onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      void save('member', { pilotEnabled: fields.has('pilotEnabled'), creatorAccount: String(fields.get('creatorAccount') || '').trim() }, '灰测设置已保存。');
    }}><fieldset disabled={action.busy} className="stack">
      <h3>灰测设置</h3><Check name="pilotEnabled" label="启用灰测" checked={row.pilotEnabled} />
      <Field label="Creator 账号" hint="用户名或账号 ID，仅供管理员识别。"><Input name="creatorAccount" defaultValue={row.creatorAccount} maxLength={120} autoComplete="off" /></Field>
      <Button type="submit">保存灰测设置</Button>
    </fieldset></form>
    <form key={'link-' + row.revision} className="stack" onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      void save('link', { workId: String(fields.get('workId') || '').trim(), versionId: String(fields.get('versionId') || '').trim(), ownershipConfirmed: true }, '准确投稿版本已核对并关联。');
    }}>
      <div className="spread"><h3>核对投稿关联</h3><PilotBadges row={row} /></div>
      {row.binding.workId && <Facts items={[[ '已关联作品', row.binding.workId ], [ '准确版本', row.binding.versionId ], [ '核对时间', time(row.binding.verifiedAt) ]]} />}
      <fieldset disabled={action.busy || !row.creatorAccount} className="stack">
        <Field label="来源作品 ID"><Input name="workId" maxLength={240} pattern="[A-Za-z0-9_\-]{1,240}" required /></Field>
        <Field label="准确投稿版本 ID"><Input name="versionId" maxLength={240} pattern="[A-Za-z0-9_\-]{1,240}" required /></Field>
        <Check label="已确认该作品属于此成员" name="ownershipConfirmed" required />
        <Button type="submit" variant="outline">核对并关联</Button>
      </fieldset>
      {!row.creatorAccount && <p className="small muted">保存 Creator 账号后可核对投稿。</p>}
    </form>
  </div>
  {row.binding.workId && <div className="row"><ConfirmAction description="解除当前 Creator 投稿关联，保留灰测与账号设置。" onConfirm={() => save('unlink', {}, '投稿关联已解除。')}>解除投稿关联</ConfirmAction></div>}
  <StatusText {...action} label="正在核对或保存…" /></>;
}

function MemberDetail({ member, onSaved, pilot, onPilotSaved }: { member: Member; onSaved: (member: Member) => void; pilot: ReturnType<typeof useResource<PilotResponse>>; onPilotSaved: (row: ReviewPilotMember) => void }) {
  const { update, visit, notify } = useAdminRoute();
  const permissions = useAction(), quota = useAction(), password = useAction();
  const patch = (changes: unknown) => api<Member>(adminPath('members/' + segment(member.id)), { method: 'PATCH', body: changes });
  return <div className="stack">
    <Button variant="ghost" onClick={() => update({ id: undefined })}>← 返回成员列表</Button>
    <PageHeader eyebrow="成员账号" title={member.displayName} description={'@' + member.username} actions={<div className="row">
      <Button variant="outline" size="sm" onClick={() => visit('works', { owner: member.id })}>查看作品</Button>
      <Button variant="outline" size="sm" onClick={() => visit('tasks', { owner: member.id })}>查看任务</Button>
      <Button variant="outline" size="sm" onClick={() => visit('reviews', { owner: member.id })}>审核记录</Button>
    </div>} />
    <div className="row"><Badge tone={member.enabled ? 'sage' : 'warning'}>{member.enabled ? '启用中' : '已停用'}</Badge><Badge tone={member.star ? 'sage' : 'neutral'}>{member.star ? '★ Star' : '普通成员'}</Badge><Badge tone="neutral">{member.canReview ? '可审核' : '不可审核'}</Badge><span className="small muted">创建于 {time(member.createdAt)}</span></div>
    <div className="grid-2">
      <Card className="stack"><h2>账号与权限</h2><form key={[member.enabled, member.canReview, member.star].join('|')} className="stack" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const changes = Object.fromEntries((['enabled', 'canReview', 'star'] as const).filter(key => data.has(key) !== !!member[key]).map(key => [key, data.has(key)]));
        if (!Object.keys(changes).length) { notify('权限没有变化。'); return; }
        void permissions.run(async () => { onSaved(await patch(changes)); notify('成员权限已保存。', 'success'); });
      }}><fieldset className="stack" disabled={permissions.busy}>
        <Check name="enabled" label="启用账号" hint="停用后，成员及其设备立即失去访问权限。" checked={member.enabled} />
        <Check name="canReview" label="允许审核" hint="授权本人 Agent 执行审核。" checked={member.canReview} />
        <Check name="star" label="Star 创作权限" hint="撤销后保留个人材料，停止新的创作请求。" checked={member.star} />
        <p className="small muted">修改启用状态或审核权限后，成员需要重新登录。Star 权限立即生效，审核凭据继续有效。</p>
        <Button type="submit">保存权限</Button>
      </fieldset><StatusText {...permissions} /></form></Card>
      <div className="stack">
        <Card className="stack"><h2>平台历史每日额度</h2><form key={member.dailyReviewLimit} className="stack" onSubmit={event => {
          event.preventDefault();
          const dailyReviewLimit = Number(new FormData(event.currentTarget).get('dailyReviewLimit'));
          void quota.run(async () => { onSaved(await patch({ dailyReviewLimit })); notify('每日额度已保存。', 'success'); });
        }}>
          <Field label="每日平台模型审核次数" hint="0–10,000 次。本地 Agent 审核不占此额度。"><Limit value={member.dailyReviewLimit ?? 50} /></Field>
          <Button type="submit" variant="outline" disabled={quota.busy}>保存额度</Button><StatusText {...quota} />
        </form></Card>
        <Card className="stack"><h2>重置密码</h2><form className="stack" onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          void password.run(async () => {
            if (data.get('password') !== data.get('confirmPassword')) throw new Error('两次输入的密码不一致。');
            await patch({ password: data.get('password') });
            form.reset();
            notify('密码已重置，旧会话已撤销。', 'success');
          });
        }}><fieldset className="stack" disabled={password.busy}>
          <Field label="新密码"><Input name="password" type="password" autoComplete="new-password" minLength={6} maxLength={128} required /></Field>
          <Field label="再次输入"><Input name="confirmPassword" type="password" autoComplete="new-password" minLength={6} maxLength={128} required /></Field>
          <p className="small muted">重置后，成员及其设备需要重新登录或授权。</p><Button type="submit" variant="outline">重置密码</Button>
        </fieldset><StatusText {...password} /></form></Card>
      </div>
    </div>
    <Card className="stack"><div className="spread"><h2>灰测与 Creator 账号</h2><Button variant="outline" size="sm" onClick={pilot.reload}>重新读取</Button></div>
      <p className="small muted">来源站核对作品与准确投稿版本。成员归属由管理员确认，文件内容需另行核验。此关联只用于灰测管理。</p>
      <DataState resource={pilot}>{data => {
        const row = data.members.find(entry => entry.memberId === member.id);
        return row ? <PilotSettings key={member.id} row={row} onSaved={onPilotSaved} /> : <EmptyState title="未读取到此成员的灰测设置" />;
      }}</DataState>
    </Card>
  </div>;
}

export default function Members({ route }: { route: AdminRoute }) {
  const { update } = useAdminRoute();
  const resource = useResource<MembersResponse>(adminPath('members'));
  const pilot = useResource<PilotResponse>(adminPath('review-pilots'));
  const [query, setQuery] = useState(route.q);
  const updateMember = (member: Member) => resource.setData(current => current && { members: current.members.map(row => row.id === member.id ? { ...row, ...member } : row) });
  const updatePilot = (row: ReviewPilotMember) => pilot.setData(current => current && { members: current.members.map(entry => entry.memberId === row.memberId ? row : entry) });

  return <DataState resource={resource} label="正在读取成员…">{data => {
    if (route.id) {
      const member = data.members.find(row => row.id === route.id);
      return member ? <MemberDetail key={member.id} member={member} onSaved={updateMember} pilot={pilot} onPilotSaved={updatePilot} /> :
        <EmptyState title="成员不存在" action={<Button onClick={() => update({ id: undefined })}>返回成员列表</Button>} />;
    }
    const shown = data.members.filter(member => (!route.owner || route.owner === member.id) && (member.displayName + ' ' + member.username).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    return <section className="stack">
      <PageHeader eyebrow="成员与权限" title="成员管理" description="管理账号、审核权限、Star 和 Creator 灰测设置。" actions={<Button onClick={() => update({ panel: 'create' })}>开通成员账号</Button>} />
      <div className="stats-grid admin-member-stats"><Stat label="全部成员" value={data.members.length} /><Stat label="启用中" value={data.members.filter(row => row.enabled).length} /><Stat label="启用的 Star" value={data.members.filter(row => row.enabled && row.star).length} /></div>
      <form className="toolbar" onSubmit={event => { event.preventDefault(); update({ q: query.trim(), page: 1 }); }}>
        <Field label="搜索成员"><Input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="姓名或登录账号" /></Field>
        <Button type="submit">搜索</Button><Button variant="outline" onClick={() => { resource.reload(); pilot.reload(); }}>刷新</Button>
        {route.owner && <Button variant="ghost" onClick={() => update({ owner: '' })}>显示全部成员</Button>}
      </form>
      {pilot.error && <p className="small danger-text" role="alert">灰测状态暂不可用。{pilot.error}</p>}
      <Card>{shown.length ? <ResponsiveTable className="admin-members-table"><thead role="rowgroup"><tr role="row"><th>成员</th><th>权限</th><th>账号状态</th><th>灰测与 Creator</th><th>最近活动</th><th>操作</th></tr></thead><tbody role="rowgroup">
        {shown.map(member => <tr role="row" key={member.id}>
          <Cell wide><button className="admin-summary-link" onClick={() => update({ id: member.id, panel: undefined })}>{member.displayName}</button><small className="muted">@{member.username}</small></Cell>
          <Cell label="权限"><div className="row"><Badge tone={member.star ? 'sage' : 'neutral'}>{member.star ? '★ Star' : '普通成员'}</Badge><Badge tone="neutral">{member.canReview ? '可审核' : '不可审核'}</Badge></div></Cell>
          <Cell label="账号状态"><Badge tone={member.enabled ? 'sage' : 'warning'}>{member.enabled ? '启用中' : '已停用'}</Badge></Cell>
          <Cell label="灰测与 Creator" wide><PilotBadges row={pilot.data?.members.find(row => row.memberId === member.id)} /></Cell><Cell label="最近活动">{time(member.lastActivity)}</Cell>
          <Cell><Button variant="outline" size="sm" onClick={() => update({ id: member.id, panel: undefined })}>管理</Button></Cell>
        </tr>)}
      </tbody></ResponsiveTable> : <EmptyState title={query ? '没有匹配的成员' : '暂无成员记录'} />}</Card>
      {route.panel === 'create' && <CreateMember onClose={() => update({ panel: undefined })} onCreate={member => { resource.setData(current => ({ members: [...(current?.members || []), member] })); pilot.reload(); update({ id: member.id, panel: undefined }); }} />}
    </section>;
  }}</DataState>;
}
