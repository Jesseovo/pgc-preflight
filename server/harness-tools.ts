import puppeteer from '@cloudflare/puppeteer';
import type { Browser } from 'puppeteer-core';
import { AdaptivePlay, PLAY_LIMITS, plannedPlayActionMs, playActionCaptureCount, validatePlayActions } from '../scripts/review-adaptive';
import { acquireBrowser, connectAcquiredBrowser } from './browser-capacity';
import { acquireTrackedBrowser, BrowserAcquireRateLimit, captureFor, closeCaptureBrowser, supportsBrowserSessionControl } from './cloud-review-capture';
import { canonicalHarness, harnessHash } from './harness-policy';
import { problem } from './review-device-state';

const stateKey = 'harness-browser-state';
const pendingCaptureKey = 'harness-browser-pending-capture';
const completedKey = 'harness-browser-completed';
const invocationKey = (id: string) => `harness-browser-call:${id}`;
const maxInvocations = 32;
const maxEvidenceCharacters = 12 * 1024 * 1024;
const htmlLimit = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const toolNames = ['capture', 'play-start', 'play-act', 'play-finish', 'play-close'] as const;
type ToolName = typeof toolNames[number];
type JSONRecord = Record<string, unknown>;
type Shot = Omit<AdaptivePlay['shots'][number], 'actionRefs'> & { actionRefs?: (string | number)[] };
type Session = { id: string; inputHash: string; browserId?: string; acquisitionStarted?: boolean; cancelled?: true; shotIds?: [string, string][]; actionIds?: string[] };
type PendingCapture = { invocationId: string; browserId?: string; cancelled?: true };
export type HarnessBrowserEvidence = JSONRecord & {
  evidenceId: string;
  evidenceHash: string;
  tool: ToolName;
  origin: 'harness-browser-tool';
  contextOrigin: 'creator-self-check';
  sourceBlind: false;
  inputHash: string;
  shots: (Omit<Shot, 'id' | 'actionRefs'> & { id: string; sourceId: string; sha256: string; actionRefs: string[] })[];
  actions: (JSONRecord & { id: string; sourceId: string | number })[];
};
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
  launch: (deadlineAt: number, acquired: (browserId: string) => Promise<void>, acquiring: () => Promise<void>, rejected: () => Promise<void>) => Promise<Browser>;
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
    async launch(deadlineAt, acquired, acquiring, rejected) {
      const remaining = () => deadlineAt - Date.now();
      if (!supportsBrowserSessionControl(env.BROWSER)) throw new Error('试玩服务缺少按会话确认关闭的能力。');
      if (remaining() <= 0) throw new Error('Browser deadline reached');
      return await acquireBrowser(env.DB, () => puppeteer.limits(env.BROWSER), () =>
        connectAcquiredBrowser(async () => {
          if (remaining() <= 0) throw new Error('Browser deadline reached');
          await acquiring();
          const result = await acquireTrackedBrowser(() => puppeteer.acquire(env.BROWSER, {
            recording: false, guardrails: { allowedDomains: [] },
            keep_alive: Math.max(10_000, Math.min(60_000, remaining())),
          }), rejected, '试玩浏览器申请结果未确认。');
          if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new Error('试玩浏览器缺少会话编号。');
          try {
            await acquired(result.sessionId);
          } catch (error) {
            await closeCaptureBrowser(env.BROWSER, result.sessionId).catch(() => {});
            throw error;
          }
          return result;
        }, id => {
          if (remaining() <= 0) throw new Error('Browser deadline reached');
          return puppeteer.connect(env.BROWSER, id);
        }).catch(error => {
          if (error instanceof BrowserAcquireRateLimit) throw error;
          throw new Error('试玩浏览器申请结果未确认。');
        }), undefined, Math.min(240_000, remaining())) as unknown as Browser;
    },
    closeOwn: browserId => closeCaptureBrowser(env.BROWSER, browserId),
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

async function seal(input: ToolInput, result: JSONRecord, sourceShots: Shot[] = [], session?: Session): Promise<HarnessBrowserEvidence> {
  const { id: callId, inputHash, name: tool } = input;
  const evidenceId = `tool-${await harnessHash(canonicalHarness([callId, inputHash]))}`;
  const shotIds = new Map(session?.shotIds);
  const priorActions = session?.actionIds ?? [];
  const actionIds = new Map<string | number, string>(priorActions.map((id, index) => [index + 1, id]));
  const probe = isObject(result.probe) ? result.probe : null;
  const summary = isObject(result.summary) ? result.summary : null;
  const rawActions: unknown[] = Array.isArray(probe?.actions) ? probe.actions : Array.isArray(summary?.actions) ? summary.actions : [];
  const shotSources = sourceShots.map((shot, index) => {
    if (typeof shot.id !== 'string' || shotIds.has(shot.id)) throw new Error('Invalid source viewport identifier');
    const id = `${evidenceId}:shot:${index + 1}`;
    shotIds.set(shot.id, id);
    return { sourceId: shot.id, id };
  });
  const actionSources = rawActions.map((action, index) => {
    if (!isObject(action)) throw new Error('Invalid source action');
    const sourceId = probe ? action.id : index + 1;
    if (typeof sourceId !== 'string' && typeof sourceId !== 'number') throw new Error('Invalid source action identifier');
    if (index < priorActions.length) return { sourceId, id: priorActions[index] };
    if (actionIds.has(sourceId)) throw new Error('Duplicate source action identifier');
    const id = `${evidenceId}:action:${index - priorActions.length + 1}`;
    actionIds.set(sourceId, id);
    return { sourceId, id };
  });
  const shotRef = (value: unknown) => {
    const id = typeof value === 'string' ? shotIds.get(value) : undefined;
    if (!id) throw new Error('Unresolved source viewport reference');
    return id;
  };
  const actionRefs = (values: unknown): string[] => {
    if (!Array.isArray(values)) return [];
    return values.map(value => {
      const id = actionIds.get(value);
      if (!id) throw new Error('Unresolved source action reference');
      return id;
    });
  };
  const images = await Promise.all(sourceShots.map(async (shot, index) => {
    const match = /^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(shot.data);
    if (!match) throw new Error('Invalid browser viewport image');
    const bytes = Uint8Array.from(atob(match[1]), code => code.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { ...shot, ...shotSources[index], actionRefs: actionRefs(shot.actionRefs), sha256 };
  }));
  const actions = rawActions.map((value, index) => {
    const action = value as JSONRecord;
    return {
      ...action, ...actionSources[index],
      ...(typeof action.beforeImageId === 'string' && action.beforeImageId ? { beforeImageId: shotRef(action.beforeImageId) } : {}),
      ...(typeof action.afterImageId === 'string' && action.afterImageId ? { afterImageId: shotRef(action.afterImageId) } : {}),
    };
  });
  const observations = Array.isArray(probe?.observations) ? probe.observations.map(value => {
    if (!isObject(value)) throw new Error('Invalid source observation');
    return { ...value, id: shotRef(value.id), sourceId: value.id, actionRefs: actionRefs(value.actionRefs) };
  }) : undefined;
  if (session) {
    session.shotIds = [...shotIds];
    if (summary) session.actionIds = actionSources.map(action => action.id);
  }
  const evidence = {
    ...result,
    evidenceId, tool, origin: 'harness-browser-tool' as const, contextOrigin: 'creator-self-check' as const,
    sourceBlind: false as const, inputHash, shots: images, actions: actions.slice(priorActions.length),
    ...(probe && { probe: { ...probe, actions, ...(observations && { observations }) } }),
    ...(summary && { summary: { ...summary, actions } }),
  };
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

  async readResults(): Promise<HarnessBrowserEvidence[]> {
    const completed = await this.storage.get<string[]>(completedKey) ?? [];
    if (!Array.isArray(completed) || completed.length > maxInvocations || new Set(completed).size !== completed.length ||
        !completed.every(identifier)) throw new Error('Invalid completed browser evidence index');
    const results = [];
    for (const id of completed) {
      const key = invocationKey(id);
      const invocation = await this.storage.get<Invocation>(key);
      if (invocation?.status !== 'done' || !invocation.parts) throw new Error('Missing completed browser evidence');
      results.push(await this.readResult(key, invocation.parts));
    }
    return results;
  }

  async execute(value: unknown, deadlineAt: number): Promise<HarnessBrowserEvidence> {
    if (this.closing || this.busy) throw problem('该任务已有浏览器工具正在处理。', 409);
    this.busy = true;
    try {
      if (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt) throw problem('任务已到达总时限。', 504);
      const input = await parseInput(value);
      const key = invocationKey(input.id);
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
      if (await this.storage.get<PendingCapture | null>(pendingCaptureKey)) throw problem('原截图浏览器关闭尚未确认。', 503);
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
        ...(opening && { session: { id: crypto.randomUUID(), inputHash, acquisitionStarted: false } }),
      };
      // A loss after this checkpoint consumes the reservation. Only a verified
      // completion can release unused active time, and actions are never replayed.
      await this.storage.transaction(async tx => {
        const latest = await tx.get<ToolState>(stateKey) ?? freshState();
        if (this.closing || latest.attempts !== saved.attempts || await tx.get(key) || await tx.get(pendingCaptureKey)) throw problem('工具调用已中止。', 409);
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
        await this.saveResult(input.id, hash, state, result);
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
    deadlineAt: number, closed: () => boolean): Promise<HarnessBrowserEvidence> {
    const { name, args, inputHash } = input;
    if (name === 'capture') {
      let closureConfirmed = false;
      const result = await this.deps.capture(args.html as string, undefined, deadlineAt, { activeBudgetMs: remaining }, {
        acquiring: async () => this.storage.transaction(async tx => {
          const pending = await tx.get(pendingCaptureKey);
          if (pending || closed()) throw problem('工具调用已中止。', 409);
          await tx.put<PendingCapture>(pendingCaptureKey, { invocationId: input.id });
          if (closed()) throw problem('工具调用已中止。', 409);
        }),
        rejected: async () => {
          const cancelled = await this.storage.transaction(async tx => {
            const pending = await tx.get<PendingCapture>(pendingCaptureKey);
            if (pending?.invocationId !== input.id || pending.browserId) throw new Error('截图浏览器拒绝记录不匹配。');
            await tx.put(pendingCaptureKey, null);
            return pending.cancelled;
          });
          if (cancelled || closed()) throw problem('工具调用已中止。', 409);
        },
        acquired: async browserId => {
          const cancelled = await this.storage.transaction(async tx => {
            const pending = await tx.get<PendingCapture>(pendingCaptureKey);
            if (pending?.invocationId !== input.id || pending.browserId) throw new Error('截图浏览器申请记录不匹配。');
            await tx.put<PendingCapture>(pendingCaptureKey, { ...pending, browserId });
            return pending.cancelled;
          });
          // Persist even if the deadline or close won the race. The capture
          // finally block and the next host cleanup can address this exact ID.
          if (cancelled || closed()) throw problem('工具调用已中止。', 409);
        },
        closed: async browserId => {
          await this.clearCapture(input.id, browserId);
          closureConfirmed = true;
        },
      });
      if (!closureConfirmed || result.shots.length !== shotCount || !('captureRuntimeMs' in result)) throw new Error('Incomplete three-ratio capture');
      return seal(input, {
        contextOrigin: 'creator-self-check', sourceBlind: false, captureRuntimeMs: result.captureRuntimeMs, probe: result.probe,
      }, result.shots as unknown as Shot[]);
    }
    const session = state.session!;
    if (name === 'play-start') {
      const browser = await this.deps.launch(deadlineAt, async browserId => {
        const cancelled = await this.storage.transaction(async tx => {
          const latest = await tx.get<ToolState>(stateKey);
          const pending = latest?.session;
          if (!latest || pending?.id !== session.id || pending.acquisitionStarted !== true || pending.browserId) throw new Error('试玩浏览器申请记录不匹配。');
          await tx.put(stateKey, { ...latest, session: { ...pending, browserId } });
          return pending.cancelled;
        });
        session.browserId = browserId;
        if (cancelled || closed()) throw problem('工具调用已中止。', 409);
      }, async () => {
        await this.storage.transaction(async tx => {
          const latest = await tx.get<ToolState>(stateKey);
          const pending = latest?.session;
          if (!latest || pending?.id !== session.id || pending.cancelled || pending.acquisitionStarted !== false || closed()) throw problem('工具调用已中止。', 409);
          await tx.put(stateKey, { ...latest, session: { ...pending, acquisitionStarted: true } });
          if (closed()) throw problem('工具调用已中止。', 409);
        });
        session.acquisitionStarted = true;
      }, async () => {
        const cancelled = await this.storage.transaction(async tx => {
          const latest = await tx.get<ToolState>(stateKey);
          const pending = latest?.session;
          if (!latest || pending?.id !== session.id || pending.acquisitionStarted !== true || pending.browserId) throw new Error('试玩浏览器拒绝记录不匹配。');
          await tx.put(stateKey, { ...latest, session: { ...pending, acquisitionStarted: false } });
          return pending.cancelled;
        });
        session.acquisitionStarted = false;
        if (cancelled || closed()) throw problem('工具调用已中止。', 409);
      });
      if (closed()) {
        await browser.disconnect().catch(() => {});
        if (session.browserId) await this.deps.closeOwn(session.browserId).catch(() => {});
        throw problem('工具调用已中止。', 409);
      }
      const play = this.deps.play(browser, args.html as string, inputHash, remaining);
      this.live = { session, browser, play };
      await play.start();
      if (play.shots.length !== 1) throw new Error('Missing initial browser viewport');
      return seal(input, { sessionId: session.id, contextOrigin: 'creator-self-check', sourceBlind: false, viewport: { width: 360, height: 780 }, playMs: play.playMs }, play.shots, session);
    }
    if (name === 'play-close') {
      await this.retireSession();
      return seal(input, { sessionId: session.id, closed: true });
    }
    const play = this.live!.play;
    if (name === 'play-finish') {
      const summary = play.summary();
      if (!await this.closeLive()) throw new Error('Browser close not confirmed');
      return seal(input, { sessionId: session.id, summary }, [], session);
    }
    const offset = play.shots.length;
    await play.act(args.round);
    const shots = play.shots.slice(offset);
    if (!shots.length || shots.length > shotCount) throw new Error('Browser screenshot reservation mismatch');
    return seal(input, { sessionId: session.id, summary: play.summary() }, shots, session);
  }

  private async saveResult(id: string, hash: string, state: ToolState, result: HarnessBrowserEvidence) {
    const key = invocationKey(id);
    const text = JSON.stringify(result);
    if (text.length > maxEvidenceCharacters) throw new Error('Browser evidence exceeds storage limit');
    await this.storage.transaction(async tx => {
      if (this.closing) throw problem('工具调用已中止。', 409);
      if (state.session) {
        const latest = (await tx.get<ToolState>(stateKey))?.session;
        if (latest?.id !== state.session.id || latest.cancelled) throw problem('工具调用已中止。', 409);
      }
      const completed = await tx.get<string[]>(completedKey) ?? [];
      if (completed.length >= maxInvocations || completed.includes(id)) throw new Error('Invalid completed browser evidence index');
      let parts = 0;
      for (let offset = 0; offset < text.length; offset += 24000) {
        await tx.put(`${key}:${parts++}`, text.slice(offset, offset + 24000));
      }
      await tx.put(stateKey, state);
      await tx.put<Invocation>(key, { hash, status: 'done', parts });
      await tx.put(completedKey, [...completed, id]);
    });
  }

  private async readResult(key: string, parts: number): Promise<HarnessBrowserEvidence> {
    if (!Number.isSafeInteger(parts) || parts < 1 || parts > Math.ceil(maxEvidenceCharacters / 24000)) {
      throw problem('原工具调用的证据不完整；不会重新执行。', 409);
    }
    const chunks = [];
    for (let i = 0; i < parts; i++) {
      const part = await this.storage.get<string>(`${key}:${i}`);
      if (typeof part !== 'string') throw problem('原工具调用的证据不完整；不会重新执行。', 409);
      chunks.push(part);
    }
    const result = JSON.parse(chunks.join('')) as HarnessBrowserEvidence;
    const { evidenceHash, ...evidence } = result;
    if (!hashPattern.test(evidenceHash) || await harnessHash(canonicalHarness(evidence)) !== evidenceHash) {
      throw problem('原工具调用的证据摘要不一致；不会重新执行。', 409);
    }
    return result;
  }

  private async closeLive() {
    const live = this.live;
    this.live = undefined;
    if (!live) return false;
    const browserClosed = live.session.browserId ? this.deps.closeOwn(live.session.browserId).then(() => true, () => false) : Promise.resolve(false);
    await live.play.close().catch(() => {});
    await live.browser.disconnect().catch(() => {});
    return browserClosed;
  }

  private async clearCapture(invocationId: string, browserId: string) {
    await this.storage.transaction(async tx => {
      const pending = await tx.get<PendingCapture>(pendingCaptureKey);
      if (!pending) return;
      if (pending.invocationId !== invocationId || pending.browserId !== browserId) throw new Error('截图浏览器关闭记录不匹配。');
      await tx.put(pendingCaptureKey, null);
    });
  }

  private async retireCapture() {
    const pending = await this.storage.transaction(async tx => {
      const capture = await tx.get<PendingCapture>(pendingCaptureKey);
      if (capture && !capture.cancelled) await tx.put<PendingCapture>(pendingCaptureKey, { ...capture, cancelled: true });
      return capture;
    });
    if (!pending) return;
    if (!pending.browserId) throw problem('截图浏览器申请结果尚未确认。', 503);
    const browserId = pending.browserId;
    const closed = await within(this.deps.closeOwn(browserId), Date.now() + 5000, () => {}).then(() => true, () => false);
    if (!closed) throw problem('截图浏览器关闭尚未确认。', 503);
    await this.clearCapture(pending.invocationId, browserId);
  }

  private async retireSession() {
    const session = await this.storage.transaction(async tx => {
      const state = await tx.get<ToolState>(stateKey);
      if (!state?.session) return;
      if (!state.session.cancelled) await tx.put(stateKey, { ...state, session: { ...state.session, cancelled: true } });
      return state.session;
    });
    if (session && !session.browserId && session.acquisitionStarted !== false) throw problem('试玩浏览器申请结果尚未确认。', 503);
    if (session && this.live && this.live.session.id !== session.id) throw problem('试玩浏览器关闭记录不匹配。', 503);
    const close = this.live ? this.closeLive() : session?.browserId ? this.deps.closeOwn(session.browserId).then(() => true, () => false) : null;
    if (close && !await within(close, Date.now() + 5000, () => {}).catch(() => false)) throw problem('隔离浏览器关闭尚未确认。', 503);
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
    return this.closePromise ??= this.retireCapture().then(() => this.retireSession()).catch(error => {
      this.closePromise = undefined;
      throw error;
    });
  }
}
