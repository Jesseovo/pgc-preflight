import { WorkerEntrypoint } from 'cloudflare:workers';
import { isHarnessImage } from '../server/harness-protocol';

// Independent research entrypoint: no production binding, model or arbitrary target.
type Env = {
  EGRESS_PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  RESEARCH_IMAGE: string; HARNESS_RESEARCH_TOKEN: string;
};
export const egressPhases = ['positive-before', 'blocked', 'positive-after'] as const;
type Phase = typeof egressPhases[number];
const checks = ['tcp4', 'udp4', 'tcp6', 'udp6'] as const;
type Check = typeof checks[number];
type Step = 'start' | 'outbound-binding' | 'inactivity-timeout' | 'http-policy' | 'https-policy' | 'health' | 'image-check' | 'exec' | 'output' | 'parse';
export type Observation = { reached: boolean; connected: boolean; result: 'response' | 'timeout' | 'network-error' | 'invalid-response' };
type Receipt = {
  phase: Phase; image: string; startedAt: number; endedAt?: number;
  state: 'running' | 'completed' | 'failed'; enableInternet: boolean;
  observations?: Record<Check, Observation>; containerDestroyed: boolean;
  failedStep?: Step; processExitCode?: number; stdoutBytes?: number;
  error?: 'execution-failed' | 'watchdog-expired' | 'cleanup-unconfirmed'; releaseReady: false;
};
const internal = 'http://pgc-egress-probe.internal';
const maxMs = 60_000;
const tokenPattern = /^[a-f0-9]{64}$/;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const secret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
function auth(a: string | null, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function empty(request: Request) {
  if (!request.body) return true;
  const reader = request.body.getReader(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([reader.read().then(r => r.done === true, () => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 250); })]); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export default {
  async fetch(request: Request, env: Env) {
    if (!tokenPattern.test(env.HARNESS_RESEARCH_TOKEN ?? '') || !isHarnessImage(env.RESEARCH_IMAGE) ||
        !auth(request.headers.get('authorization'), 'Bearer ' + env.HARNESS_RESEARCH_TOKEN)) return json({ error: 'unauthorized' }, 401);
    const url = new URL(request.url);
    const valid = request.method === 'GET' && url.pathname === '/status' || request.method === 'POST' &&
      egressPhases.some(p => url.pathname === '/' + p);
    if (!valid || url.search || !await empty(request)) return json({ error: 'route_denied' }, 404);
    return env.EGRESS_PROBE.get(env.EGRESS_PROBE.idFromName('paired-egress')).fetch(new Request(internal + url.pathname, { method: request.method }));
  },
};

export class EgressProbeOutbound extends WorkerEntrypoint {
  fetch() { return json({ error: 'research_network_denied' }, 403); }
}

// Fixed public Cloudflare DoT and NTP canaries. Only synthetic query bytes are sent.
// No preloader is used: this specifically tests the Cloudflare native network boundary.
export const egressScript = String.raw`
import tls from 'node:tls';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
function dot(host) {
  return new Promise(resolve => {
    let done=false, connected=false, bytes=Buffer.alloc(0);
    const id=randomBytes(2), question=Buffer.from('076578616d706c6503636f6d0000010001','hex');
    const query=Buffer.concat([id,Buffer.from('01000001000000000000','hex'),question]);
    const length=Buffer.alloc(2);length.writeUInt16BE(query.length);
    const socket=tls.connect({host,port:853,servername:'one.one.one.one',rejectUnauthorized:true});
    const finish=(reached,result)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve({reached,connected,result});};
    const timer=setTimeout(()=>finish(false,'timeout'),4000);
    socket.on('connect',()=>{connected=true;});
    socket.once('secureConnect',()=>socket.write(Buffer.concat([length,query])));
    socket.on('data',chunk=>{
      bytes=Buffer.concat([bytes,chunk]);
      if(bytes.length>4096)return finish(false,'invalid-response');
      if(bytes.length<2 || bytes.length<bytes.readUInt16BE(0)+2)return;
      const answer=bytes.subarray(2,bytes.readUInt16BE(0)+2);
      const valid=socket.authorized && answer.length>=12+question.length && answer.subarray(0,2).equals(id) &&
        (answer[2]&128)!==0 && (answer[3]&15)===0 && answer.readUInt16BE(4)===1 &&
        answer.subarray(12,12+question.length).equals(question);
      finish(valid,valid?'response':'invalid-response');
    });
    socket.on('error',()=>finish(false,'network-error'));
    socket.on('end',()=>finish(false,'invalid-response'));
  });
}
function ntp(host,family) {
  return new Promise(resolve=>{
    let done=false;
    const socket=dgram.createSocket(family),packet=Buffer.alloc(48);packet[0]=0x23;
    randomBytes(8).copy(packet,40);
    const finish=(reached,result)=>{if(done)return;done=true;clearTimeout(timer);try{socket.close();}catch{}resolve({reached,connected:reached,result});};
    const timer=setTimeout(()=>finish(false,'timeout'),4000);
    socket.on('error',()=>finish(false,'network-error'));
    socket.on('message',(answer,peer)=>{
      const valid=peer.address===host && peer.port===123 && answer.length>=48 && (answer[0]&7)===4 &&
        answer[1]>0 && answer[1]<16 && answer.subarray(24,32).equals(packet.subarray(40,48));
      finish(valid,valid?'response':'invalid-response');
    });
    socket.send(packet,123,host,error=>{if(error)finish(false,'network-error');});
  });
}
const result=await Promise.all([dot('1.1.1.1'),ntp('162.159.200.1','udp4'),dot('2606:4700:4700::1111'),ntp('2606:4700:f1::1','udp6')]);
console.log(JSON.stringify(Object.fromEntries(['tcp4','udp4','tcp6','udp6'].map((key,i)=>[key,result[i]]))));
`;

export function parseEgressObservations(value: unknown): Record<Check, Observation> {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== [...checks].sort().join()) throw Error('invalid observation');
  for (const key of checks) {
    const v = (value as Record<string, any>)[key];
    if (!v || Object.keys(v).sort().join() !== 'connected,reached,result' || typeof v.reached !== 'boolean' ||
        typeof v.connected !== 'boolean' || !['response', 'timeout', 'network-error', 'invalid-response'].includes(v.result) ||
        v.reached !== (v.result === 'response') || v.reached && !v.connected) throw Error('invalid observation');
  }
  return value as Record<Check, Observation>;
}

export function egressVerdict(receipts: Receipt[]): Record<Check, boolean | null> {
  return Object.fromEntries(checks.map(key => {
    const [before, blocked, after] = egressPhases.map(phase => receipts.find(r => r.phase === phase));
    // Unknown controls, malformed responses or unconfirmed cleanup cannot establish denial.
    if (receipts.length !== 3 || receipts.some((r, i) => r.phase !== egressPhases[i] ||
          !Number.isSafeInteger(r.startedAt) || !Number.isSafeInteger(r.endedAt) || r.endedAt! < r.startedAt ||
          i > 0 && r.startedAt < receipts[i - 1].endedAt!) ||
        ![before, blocked, after].every(r => r?.state === 'completed' && r.containerDestroyed) ||
        before?.enableInternet !== true || blocked?.enableInternet !== false || after?.enableInternet !== true ||
        before?.image !== blocked?.image || after?.image !== blocked?.image) return [key, null];
    const b = before!.observations?.[key], n = blocked!.observations?.[key], a = after!.observations?.[key];
    if (n?.reached || n?.connected) return [key, false];
    if (!b?.reached || !a?.reached || !n || !['timeout', 'network-error'].includes(n.result)) return [key, null];
    return [key, true];
  })) as Record<Check, boolean | null>;
}

export class EgressProbeRunner {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private ctx: any, private env: Env) {}
  fetch(request: Request): Promise<Response> {
    if (request.method === 'GET') return this.fetchWork(request);
    const operation = this.serial.then(() => this.fetchWork(request));
    this.serial = operation.catch(() => {}); return operation;
  }
  private async fetchWork(request: Request): Promise<Response> {
    const url = new URL(request.url), storage = this.ctx.storage;
    if (url.origin !== internal || url.search) return json({ error: 'denied' }, 403);
    if (request.method === 'GET' && url.pathname === '/status') {
      const receipts: Receipt[] = await storage.get('receipts') ?? [];
      return json({ receipts, verdict: egressVerdict(receipts), active: await storage.get('active') ?? null, releaseReady: false });
    }
    const phase = egressPhases.find(p => url.pathname === '/' + p);
    if (request.method !== 'POST' || !phase || !await empty(request)) return json({ error: 'denied' }, 403);
    if (this.ctx.container?.images?.ccb !== this.env.RESEARCH_IMAGE) return json({ error: 'image_mismatch' }, 409);
    const receipt: Receipt = { phase, image: this.env.RESEARCH_IMAGE, startedAt: Date.now(), state: 'running',
      enableInternet: phase !== 'blocked', containerDestroyed: false, releaseReady: false };
    const claimed = await storage.transaction(async (tx: any) => {
      const previous: Receipt[] = await tx.get('receipts') ?? [];
      if (await tx.get('active') || egressPhases[previous.length] !== phase || previous.some(r => !r.containerDestroyed || r.state !== 'completed')) return false;
      await tx.put('active', phase); await tx.put('receipts', [...previous, receipt]); await tx.setAlarm(Date.now() + maxMs); return true;
    });
    if (!claimed) return json({ error: 'already_started_or_wrong_order' }, 409);
    const stillActive = async () => {
      if (Date.now() >= receipt.startedAt + maxMs || await storage.get('active') !== phase) throw Error('expired');
    };
    let step: Step = 'start';
    try {
      const container = this.ctx.container;
      if (container.running) throw Error();
      const control = secret();
      await container.start({ image: receipt.image, instance: 'standard-1', enableInternet: receipt.enableInternet,
        env: { PGC_HARNESS_CONTROL_TOKEN: control, PGC_HARNESS_GATEWAY_URL: 'http://pgc-harness.internal' } });
      await stillActive();
      // Same HTTP policy on both controls and blocked phase; only native internet changes.
      step = 'outbound-binding';
      const denied = this.ctx.exports.EgressProbeOutbound({ props: {} });
      step = 'http-policy'; await container.interceptAllOutboundHttp(denied);
      step = 'https-policy'; await container.interceptOutboundHttps('*', denied);
      step = 'inactivity-timeout'; await container.setInactivityTimeout(maxMs);
      step = 'health';
      const readyBy = Date.now() + 18_000; let ready = false;
      while (Date.now() < readyBy) {
        try {
          const response = await container.getTcpPort(8080).fetch(new Request('http://container/v1/health', {
            headers: { Authorization: 'Bearer ' + control }, signal: AbortSignal.timeout(1500),
          }));
          const value = await response.json(); if (response.ok && value.status === 'ready') { ready = true; break; }
        } catch { /* readiness reads only */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!ready) throw Error();
      step = 'image-check';
      if ((await container.inspect())?.image !== receipt.image) throw Error();
      await stillActive();
      const abort = new AbortController();
      let exited = false, timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          if (!exited) { try { abort.abort(); } catch { /* Native exec may have just exited. */ } }
          reject(Error('probe_output_deadline'));
        }, 8000);
      });
      try {
        step = 'exec';
        const process = await Promise.race([container.exec(['node', '--input-type=module', '-e', egressScript], {
          signal: abort.signal, stderr: 'ignore',
        }), deadline]);
        // Do not abort an exited process, but keep the output RPC independently bounded.
        void process.exitCode.then(() => { exited = true; }, () => { exited = true; });
        step = 'output';
        const output = await Promise.race([process.output(), deadline]);
        receipt.processExitCode = output.exitCode; receipt.stdoutBytes = output.stdout.byteLength;
        if (output.exitCode !== 0 || output.stdout.byteLength > 4096) throw Error();
        step = 'parse';
        receipt.observations = parseEgressObservations(JSON.parse(new TextDecoder().decode(output.stdout)));
      } finally { clearTimeout(timeout); }
    } catch { receipt.error = 'execution-failed'; receipt.failedStep = step; }
    await this.cleanup(receipt);
    return json(receipt, receipt.state === 'completed' ? 200 : 502);
  }
  private async cleanup(receipt: Receipt) {
    if (Date.now() >= receipt.startedAt + maxMs) receipt.error ??= 'watchdog-expired';
    try {
      if (this.ctx.container.running) await this.ctx.container.destroy();
      receipt.containerDestroyed = !this.ctx.container.running && await this.ctx.container.inspect() === null;
    } catch { receipt.containerDestroyed = false; }
    if (!receipt.containerDestroyed) receipt.error ??= 'cleanup-unconfirmed';
    receipt.state = receipt.error ? 'failed' : 'completed'; receipt.endedAt = Date.now();
    await this.ctx.storage.transaction(async (tx: any) => {
      if (await tx.get('active') !== receipt.phase) return;
      const records: Receipt[] = await tx.get('receipts') ?? [];
      await tx.put('receipts', records.map(r => r.phase === receipt.phase ? receipt : r));
      if (receipt.containerDestroyed) { await tx.delete('active'); await tx.deleteAlarm(); }
      else await tx.setAlarm(Date.now() + 5000);
    });
  }
  alarm(): Promise<void> {
    const operation = this.serial.then(() => this.alarmWork());
    this.serial = operation.catch(() => {}); return operation;
  }
  private async alarmWork() {
    const phase = await this.ctx.storage.get('active'); if (!phase) return;
    const records: Receipt[] = await this.ctx.storage.get('receipts') ?? [];
    const receipt = records.find(r => r.phase === phase); if (!receipt) return;
    receipt.error ??= 'watchdog-expired'; await this.cleanup(receipt);
  }
}
