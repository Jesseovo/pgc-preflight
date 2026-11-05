import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Link2, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, ConfirmAction, EmptyState, ErrorState, Input, Loading } from '../../components/ui';
import { useApp } from '../../context';
import { api, copyText, useAction } from '../../lib/api';
import { reviewDate } from './report-data';

export type Device = { id: string; name: string; online: boolean; revoked: boolean | number; last_seen?: string; expires_at: string };
export type DeviceStatus = { online: boolean; devices: Device[] };
type Pairing = { code: string; expiresAt: string };
export const activeDevices = (value?: DeviceStatus) => (value?.devices ?? []).filter(device => !device.revoked && Date.parse(device.expires_at) > Date.now());
export const setupPrompt = () => `请阅读 ${location.origin}/agent.md，连接我的审核账号。首次连接时请在当前对话向我询问一次性配对码，并在后台完成配对。请使用你自己的模型审核我提供的本地 HTML，采集真实画面，完成初评和同模型同证据复核并回传中文报告。如已获得本人 Creator Hub 授权，请查询准确作品和投稿版本的真人审核结果并回填。没有结果时照常完成 AI 审核。`;

function PairingCode({ pairing, onExpire }: { pairing: Pairing; onExpire: () => void }) {
  const [now, setNow] = useState(Date.now);
  const seconds = Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000));
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);
  useEffect(() => { if (seconds === 0) onExpire(); }, [seconds, onExpire]);
  if (!seconds) return null;
  return <div className="review-pairing stack">
    <label className="stack"><strong>一次性配对码</strong><Input aria-label="一次性配对码" value={pairing.code} readOnly onFocus={event => event.currentTarget.select()}/></label>
    <div className="spread"><small className="muted">剩余 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} · 仅交给你的 Agent</small>
      <Button variant="outline" size="sm" onClick={() => void copyText(pairing.code)}><Copy size={14}/>复制配对码</Button></div>
  </div>;
}

export function ReviewDevices({ data, loading, error, reload }: { data?: DeviceStatus; loading: boolean; error: string | null; reload: () => void }) {
  const { notify } = useApp();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [expired, setExpired] = useState(false);
  const [baseline, setBaseline] = useState<string[]>([]);
  const action = useAction();
  const devices = activeDevices(data);
  const paired = pairing && devices.some(device => !baseline.includes(device.id));
  useEffect(() => { if (paired) setPairing(null); }, [paired]);

  const generate = () => void action.run(async () => {
    const value = await api<Pairing>('/api/forge/review/device/pairing', { method: 'POST', body: {} });
    setBaseline(devices.map(device => device.id));
    setExpired(false);
    setPairing(value);
  });

  const revoke = (id: string) => action.run(async () => {
    await api('/api/forge/review/device/revoke', { method: 'POST', body: { id } });
    notify('设备授权已撤销。', 'success');
    reload();
  });

  return <div className="stack review-device-page">
    <Card className="review-device-card stack">
      <div className="spread"><h2 className="row"><Link2 size={19}/>连接审核 Agent</h2>
        <Badge tone={data?.online ? 'sage' : 'neutral'}>{data?.online ? '最近已连接' : devices.length ? '已授权' : data ? '未连接' : '等待状态'}</Badge></div>
      <ol className="review-device-steps">
        <li>把接入指令复制给你的 Agent。</li>
        <li>首次连接时生成配对码，并在原对话交给 Agent。配对码有效期 5 分钟。</li>
        <li>将本地 HTML 交给 Agent 审核，完成后回到任务页查看报告。</li>
      </ol>
      <div className="row">
        <Button onClick={() => void copyText(setupPrompt())}><Copy size={15}/>复制接入指令</Button>
        <Button variant="outline" onClick={generate} disabled={action.busy || devices.length >= 3}>{pairing ? '重新生成配对码' : '生成一次性配对码'}</Button>
        <a className="review-link" href="/agent.md" target="_blank" rel="noopener noreferrer">接入说明 <ExternalLink size={14}/></a>
      </div>
      <p className="muted small">每个账号最多授权 3 台审核设备，有效期 30 天。审核与创作分别配对。</p>
      {action.error && <p className="danger-text" role="alert">{action.error}</p>}
      {pairing && !paired && <PairingCode key={pairing.expiresAt} pairing={pairing} onExpire={() => { setPairing(null); setExpired(true); }}/>}
      {expired && <p className="muted" role="status">配对码已过期，可重新生成。</p>}
      <details className="review-disclosure"><summary>查看完整接入指令</summary><pre>{setupPrompt()}</pre></details>
    </Card>
    <Card className="review-device-card stack">
      <div className="spread"><h2>已授权设备 <span className="muted small">{devices.length} / 3</span></h2>
        <Button size="sm" variant="outline" onClick={reload} disabled={loading}><RefreshCw size={14}/>刷新状态</Button></div>
      {error && <ErrorState error={error} onRetry={reload}/>}
      {loading && !data ? <Loading label="正在读取设备状态"/> : !error && devices.length === 0 ?
        <EmptyState title="尚未授权审核设备" description="在上方完成首次配对后，设备会显示在这里。"/> :
        devices.map(device => <div className="spread review-device-row" key={device.id}>
          <div><div className="row"><strong>{device.name}</strong><Badge tone={device.online ? 'sage' : 'neutral'}>{device.online ? '最近已连接' : '已授权'}</Badge></div>
            <p className="muted small">授权至 {reviewDate(device.expires_at)}{device.last_seen && ` · 最近连接 ${reviewDate(device.last_seen)}`}</p></div>
          <ConfirmAction title="撤销审核设备授权" description="撤销后，这台设备如需再次使用审核功能，须重新配对。" variant="destructive" onConfirm={async () => { await revoke(device.id); }}>撤销授权</ConfirmAction>
        </div>)}
    </Card>
  </div>;
}
