import type { ModelRuntime } from './settings';

export interface ModelThrottleDatabase { prepare(sql: string): { bind(...values: unknown[]): { first(): Promise<any>; run(): Promise<any> } } }
export type ModelWait = (milliseconds: number, reason: 'pace' | 'rate_limit') => Promise<void> | void;
export function pauseModel(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function createModelThrottle(DB: ModelThrottleDatabase | undefined, config: ModelRuntime) {
  // This gateway explicitly limits each key to 10 requests/minute. Spread
  // starts across all consumers and admin tests, keeping review concurrency.
  const interval = new URL(config.baseUrl).hostname === 'riffle-api.pages.dev' ? 7000 : 0;
  const key = crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${new URL(config.baseUrl).origin}|${config.apiKey}`))
    .then(bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''));
  return {
    async wait(signal: AbortSignal, onWait?: ModelWait) {
      if (!DB || !interval) return;
      const id = await key;
      const reserve = async () => {
        const now = Date.now();
        const reservation = await DB.prepare(`INSERT INTO model_throttle (id, next_at, cooldown_until) VALUES (?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET next_at = max(model_throttle.next_at, model_throttle.cooldown_until, ?) + ? RETURNING next_at`)
          .bind(id, now + interval, now, interval).first();
        return Number(reservation.next_at) - interval;
      };
      let available = await reserve();
      while (true) {
        const row = await DB.prepare('SELECT cooldown_until FROM model_throttle WHERE id = ?').bind(id).first();
        // A 429 from a different consumer invalidates existing reservations.
        // Reserve distinct new turns instead of waking every waiter at once.
        if (Number(row?.cooldown_until || 0) > available) available = await reserve();
        const wait = available - Date.now();
        if (wait <= 0) return;
        await onWait?.(wait, row?.cooldown_until > Date.now() ? 'rate_limit' : 'pace');
        await pauseModel(wait, signal);
      }
    },
    async cooldown(milliseconds: number) {
      if (!DB) return;
      const until = Date.now() + milliseconds;
      await DB.prepare(`INSERT INTO model_throttle (id, next_at, cooldown_until) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET cooldown_until = max(model_throttle.cooldown_until, excluded.cooldown_until), next_at = max(model_throttle.next_at, excluded.next_at)`)
        .bind(await key, until, until).run();
    },
  };
}
