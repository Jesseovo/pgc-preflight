import puppeteer from '@cloudflare/puppeteer';
import type { Browser } from 'puppeteer-core';
import { AdaptivePlay, PLAY_LIMITS, plannedPlayActionMs, playActionCaptureCount, validatePlayActions } from '../scripts/review-adaptive';
import { acquireBrowser, connectAcquiredBrowser } from './browser-capacity';
import { captureFor } from './cloud-review-capture';
import { canonicalHarness, harnessHash } from './harness-policy';
import { problem } from './review-device-state';

const stateKey = 'harness-browser-state';
const maxInvocations = 32;
const maxEvidenceCharacters = 12 * 1024 * 1024;
const htmlLimit = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const toolNames = ['capture', 'play-start', 'play-act', 'play-finish', 'play-close'] as const;
type ToolName = typeof toolNames[number];
type JSONRecord = Record<string, unknown>;
type Shot = AdaptivePlay['shots'][number];
type Session = { id: string; inputHash: string; browserId?: string };
type ToolState = {
  shots: number;
  rounds: number;
  actions: number;
  activeMs: number;
  attempts: number;
  session?: Session;
};
type Invocation = { hash: string; status: 'started' | 'done' | 'failed'; parts?: number };
type Store = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};
type ToolStorage = Store & { transaction<T>(operation: (tx: Store) => Promise<T>): Promise<T> };
type ToolEnv = { DB: unknown; BROWSER: Parameters<typeof puppeteer.acquire>[0] };
type ToolDependencies = {
  capture: ReturnType<typeof captureFor>;
  launch: (deadlineAt: number, acquired: (browserId: string) => Promise<void>) => Promise<Browser>;
  closeOwn: (browserId: string) => Promise<void>;
  play: (browser: Browser, html: string, inputHash: string, activeMs: number) => Pick<AdaptivePlay, 'start' | 'act' | 'summary' | 'close' | 'shots' | 'playMs' | 'closed'>;
};
type ToolInput = { name: ToolName; id: string; args: JSONRecord; inputHash: string; actions: ReturnType<typeof validatePlayActions> };
type Live = { session: Session; browser: Browser; play: ReturnType<ToolDependencies['play']> };

const freshState = (): ToolState => ({ shots: 0, rounds: 0, actions: 0, activeMs: 0, attempts: 0 });
const isObject = (value: unknown): value is JSONRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: JSONRecord, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identifier = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);

function toolDependencies(env: ToolEnv): ToolDependencies {
  return {
    capture: captureFor({ ...env, creationCaptureStrict: true }),
    async launch(deadlineAt, acquired) {
      const remaining = () => deadlineAt - Date.now();
      if (remaining() <= 0) throw new Error('Browser deadline reached');
      return await acquireBrowser(env.DB, () => puppeteer.limits(env.BROWSER), () =>
        connectAcquiredBrowser(async () => {
          if (remaining() <= 0) throw new Error('Browser deadline reached');
          const result = await puppeteer.acquire(env.BROWSER, {
            recording: false, guardrails: { allowedDomains: [] },
            keep_alive: Math.max(1_000, Math.min(60_000, remaining())),
          });
          try {
            await acquired(result.sessionId);
          } catch (error) {
            void puppeteer.connect(env.BROWSER, result.sessionId).then(browser => browser.close()).catch(() => {});
            throw error;
          }
          return result;
        }, id => puppeteer.connect(env.BROWSER, id)), undefined, Math.min(240_000, remaining())) as unknown as Browser;
    },
    async closeOwn(browserId) {
      try {
        const browser = await puppeteer.connect(env.BROWSER, browserId);
        await browser.close();
      } catch (error) {
        // Only an explicit missing/closed response for this same ID confirms
        // it is already gone. A generic connection failure remains ambiguous.
        if (!/session (?:not found|already closed)|\b404\b/i.test(String(error))) throw error;
      }
    },
    play: (browser, html, inputHash, activeMs) => new AdaptivePlay(browser, html, {
      creationInputHash: inputHash, creationActiveBudgetMs: activeMs, denyExternal: true,
    }),
  };
}

async function parseInput(value: unknown): Promise<ToolInput> {
  if (!isObject(value) || !exact(value, ['name', 'id', 'arguments']) || !identifier(value.id) ||
      !toolNames.includes(value.name as ToolName) || !isObject(value.arguments)) {
    throw problem('浏览器工具请求无效。');
  }
  const name = value.name as ToolName;
  const args = value.arguments;
  const inputHash = args.inputHash;
  if (typeof inputHash !== 'string' || !hashPattern.test(inputHash)) throw problem('浏览器工具需要锁定 HTML 的 SHA-256。');
  let actions: ReturnType<typeof validatePlayActions> = [];
  if (name === 'capture' || name === 'play-start') {
    if (!exact(args, ['inputHash', 'html']) || typeof args.html !== 'string' || !args.html.trim() ||
        encoder.encode(args.html).length > htmlLimit || await harnessHash(args.html) !== inputHash) {
      throw problem('浏览器工具的 HTML 与锁定版本不符。');
    }
  } else {
    if (!identifier(args.sessionId) || !exact(args, name === 'play-act' ? ['inputHash', 'sessionId', 'round'] : ['inputHash', 'sessionId'])) {
      throw problem('浏览器工具需要原试玩会话编号。');
    }
    if (name === 'play-act') {
      if (!isObject(args.round) || !exact(args.round, ['hypothesis', 'actions']) ||
          typeof args.round.hypothesis !== 'string' || !args.round.hypothesis.trim() || args.round.hypothesis.length > 2000) {
        throw problem('试玩动作需要明确待验证假设。');
      }
      try {
        actions = validatePlayActions(args.round.actions, PLAY_LIMITS.actions);
      } catch (error) {
        throw problem(error instanceof Error ? error.message : '试玩动作不符合约束。');
      }
    }
  }
  return { name, id: value.id, args, inputHash, actions };
}

function within<T>(promise: Promise<T>, deadlineAt: number, expired: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired();
        reject(problem('隔离浏览器工具已超时，未提交证据。', 504));
      }, Math.max(0, deadlineAt - Date.now()));
    }),
  ]).finally(() => clearTimeout(timer));
}

async function seal(inputHash: string, result: JSONRecord, shots: Shot[] = []) {
  const images = await Promise.all(shots.map(async shot => {
    const match = /^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(shot.data);
    if (!match) throw new Error('Invalid browser viewport image');
    const bytes = Uint8Array.from(atob(match[1]), code => code.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { ...shot, sha256 };
  }));
  const evidence = { inputHash, ...result, shots: images };
  return { ...evidence, evidenceHash: await harnessHash(canonicalHarness(evidence)) };
}

export class HarnessTools {
  private readonly deps: ToolDependencies;
  private live?: Live;
  private busy = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private generation = 0;

  constructor(env: ToolEnv, private readonly storage: ToolStorage, deps?: ToolDependencies) {
    this.deps = deps ?? toolDependencies(env);
  }

  async execute(value: unknown, deadlineAt: number): Promise<JSONRecord> {
    if (this.closing || this.busy) throw problem('该任务已有浏览器工具正在处理。', 409);
    this.busy = true;
    try {
      if (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt) throw problem('任务已到达总时限。', 504);
      const input = await parseInput(value);
      const key = `harness-browser-call:${input.id}`;
      const hash = await harnessHash(canonicalHarness(value));
      const known = await this.storage.get<Invocation>(key);
      if (known) {
        if (known.hash !== hash) throw problem('工具调用编号已锁定到另一份材料。', 409);
        if (known.status !== 'done' || !known.parts) throw problem('原工具调用未留下完整证据；不会重复执行。', 409);
        return this.readResult(key, known.parts);
      }

      const saved = await this.storage.get<ToolState>(stateKey) ?? freshState();
      const { name, args, inputHash } = input;
      const opening = name === 'play-start';
      const acting = name === 'play-act';
      const capturing = name === 'capture';
      const reservingTime = opening || acting || capturing;
      const remaining = PLAY_LIMITS.playMs - saved.activeMs;
      if (opening || capturing) {
        if (saved.session) throw problem('已有锁定的试玩会话，请先结束或关闭该会话。', 409);
      } else {
        if (!saved.session || saved.session.id !== args.sessionId || saved.session.inputHash !== inputHash) {
          throw problem('原试玩会话或锁定的 HTML 不匹配。', 409);
        }
        if (name !== 'play-close' && (!this.live || this.live.session.id !== saved.session.id || this.live.play.closed)) {
          throw problem('原隔离试玩会话已失去，不能从新的浏览器假装恢复。', 410);
        }
      }
      const { actions } = input;
      const shotCount = capturing ? 4 : opening ? 1 : acting ? playActionCaptureCount(actions) : 0;
      if (saved.attempts >= maxInvocations || saved.shots + shotCount > PLAY_LIMITS.shots || saved.actions + actions.length > PLAY_LIMITS.actions ||
          acting && saved.rounds >= PLAY_LIMITS.rounds || reservingTime && (remaining < 1 || plannedPlayActionMs(actions) >= remaining)) {
        throw problem('已达到该任务共享的试玩或补图额度。', 409);
      }
      const state: ToolState = {
        ...saved, attempts: saved.attempts + 1,
        shots: saved.shots + shotCount,
        rounds: saved.rounds + Number(acting),
        actions: saved.actions + actions.length,
        activeMs: reservingTime ? PLAY_LIMITS.playMs : saved.activeMs,
        ...(opening && { session: { id: crypto.randomUUID(), inputHash } }),
      };
      // A loss after this checkpoint consumes the reservation. Only a verified
      // completion can release unused active time, and actions are never replayed.
      await this.storage.transaction(async tx => {
        const latest = await tx.get<ToolState>(stateKey) ?? freshState();
        if (this.closing || latest.attempts !== saved.attempts || await tx.get(key)) throw problem('工具调用已中止。', 409);
        await tx.put(stateKey, state);
        await tx.put<Invocation>(key, { hash, status: 'started' });
      });
      const generation = this.generation;
      const closed = () => generation !== this.generation || this.closing || Date.now() >= deadlineAt;
      const before = this.live?.play.playMs ?? 0;
      try {
        if (closed()) throw problem('工具调用已中止。', 409);
        const result = await within(this.perform(input, state, remaining, shotCount, deadlineAt, closed), deadlineAt, () => {
          this.generation++;
          void this.closeLive().catch(() => {});
        });
        if (closed()) throw problem('工具调用已中止。', 409);
        if (reservingTime) {
          const consumed = capturing ? result.captureRuntimeMs : (this.live?.play.playMs ?? before) - before;
          if (typeof consumed !== 'number' || !Number.isSafeInteger(consumed) || consumed < 1 || consumed > remaining) throw new Error('Invalid browser active time');
          state.activeMs = saved.activeMs + consumed;
        }
        if (name === 'play-finish' || name === 'play-close') delete state.session;
        await this.saveResult(key, hash, state, result);
        return result;
      } catch (error) {
        if (!capturing) await within(this.closeLive(), Math.min(deadlineAt, Date.now() + 5000), () => {}).catch(() => {});
        // Keep the persisted session identifier on ambiguity so only an
        // explicit close can retire it. No evidence is returned for this call.
        await this.storage.transaction(async tx => {
          if ((await tx.get<Invocation>(key))?.status === 'started') await tx.put<Invocation>(key, { hash, status: 'failed' });
        });
        if (typeof (error as { status?: unknown })?.status === 'number') throw error;
        throw problem('隔离浏览器工具未取得可验证证据。', 502);
      }
    } finally {
      this.busy = false;
    }
  }

  private async perform(input: ToolInput, state: ToolState, remaining: number, shotCount: number,
    deadlineAt: number, closed: () => boolean): Promise<JSONRecord> {
    const { name, args, inputHash } = input;
    if (name === 'capture') {
      const result = await this.deps.capture(args.html as string, undefined, deadlineAt, { activeBudgetMs: remaining });
      if (result.shots.length !== shotCount || !('captureRuntimeMs' in result)) throw new Error('Incomplete three-ratio capture');
      return seal(inputHash, {
        contextOrigin: 'creator-self-check', sourceBlind: false, captureRuntimeMs: result.captureRuntimeMs, probe: result.probe,
      }, result.shots as unknown as Shot[]);
    }
    const session = state.session!;
    if (name === 'play-start') {
      const browser = await this.deps.launch(deadlineAt, async browserId => {
        if (closed()) throw problem('工具调用已中止。', 409);
        session.browserId = browserId;
        await this.storage.put(stateKey, state);
      });
      if (closed()) {
        await browser.close().catch(() => {});
        throw problem('工具调用已中止。', 409);
      }
      const play = this.deps.play(browser, args.html as string, inputHash, remaining);
      this.live = { session, browser, play };
      await play.start();
      if (play.shots.length !== 1) throw new Error('Missing initial browser viewport');
      return seal(inputHash, { sessionId: session.id, contextOrigin: 'creator-self-check', sourceBlind: false, viewport: { width: 360, height: 780 }, playMs: play.playMs }, play.shots);
    }
    if (name === 'play-close') {
      const closed = this.live ? await this.closeLive() : session.browserId
        ? await this.deps.closeOwn(session.browserId).then(() => true, () => false) : true;
      if (!closed) throw problem('隔离浏览器关闭尚未确认。', 503);
      return seal(inputHash, { sessionId: session.id, closed: true });
    }
    const play = this.live!.play;
    if (name === 'play-finish') {
      const summary = play.summary();
      if (!await this.closeLive()) throw new Error('Browser close not confirmed');
      return seal(inputHash, { sessionId: session.id, summary });
    }
    const offset = play.shots.length;
    await play.act(args.round);
    const shots = play.shots.slice(offset);
    if (!shots.length || shots.length > shotCount) throw new Error('Browser screenshot reservation mismatch');
    return seal(inputHash, { sessionId: session.id, summary: play.summary() }, shots);
  }

  private async saveResult(key: string, hash: string, state: ToolState, result: JSONRecord) {
    const text = JSON.stringify(result);
    if (text.length > maxEvidenceCharacters) throw new Error('Browser evidence exceeds storage limit');
    await this.storage.transaction(async tx => {
      if (this.closing) throw problem('工具调用已中止。', 409);
      let parts = 0;
      for (let offset = 0; offset < text.length; offset += 24000) {
        await tx.put(`${key}:${parts++}`, text.slice(offset, offset + 24000));
      }
      await tx.put(stateKey, state);
      await tx.put<Invocation>(key, { hash, status: 'done', parts });
    });
  }

  private async readResult(key: string, parts: number) {
    const chunks = [];
    for (let i = 0; i < parts; i++) {
      const part = await this.storage.get<string>(`${key}:${i}`);
      if (typeof part !== 'string') throw problem('原工具调用的证据不完整；不会重新执行。', 409);
      chunks.push(part);
    }
    return JSON.parse(chunks.join('')) as JSONRecord;
  }

  private async closeLive() {
    const live = this.live;
    this.live = undefined;
    if (!live) return false;
    const browserClosed = live.browser.close().then(() => true, () => false);
    await live.play.close().catch(() => {});
    return browserClosed;
  }

  private async retireSession() {
    const session = (await this.storage.get<ToolState>(stateKey))?.session;
    let closed = false;
    if (this.live) closed = await within(this.closeLive(), Date.now() + 5000, () => {}).catch(() => false);
    if (!closed && session?.browserId) {
      const browserId = session.browserId;
      closed = await within(this.deps.closeOwn(browserId), Date.now() + 5000, () => {}).then(() => true, () => false);
      if (!closed) throw problem('隔离浏览器关闭尚未确认。', 503);
    }
    if (!session) return;
    await this.storage.transaction(async tx => {
      const state = await tx.get<ToolState>(stateKey);
      if (state?.session?.id === session.id) {
        delete state.session;
        await tx.put(stateKey, state);
      }
    });
  }

  close() {
    this.closing = true;
    this.generation++;
    return this.closePromise ??= this.retireSession().catch(error => {
      this.closePromise = undefined;
      throw error;
    });
  }
}
