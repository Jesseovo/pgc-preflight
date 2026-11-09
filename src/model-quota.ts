const rightCodeOrigins = new Set([
  'https://api.site',
  'https://rightapi.io',
  'https://rightapi.ai',
  'https://www.rightapi.ai',
  'https://right.codes',
  'https://www.right.codes',
]);

export function quotaProvider(profile: { baseUrl: string; model: string }) {
  let url: URL;
  try { url = new URL(profile.baseUrl); } catch { return undefined; }
  if (url.username || url.password) return undefined;
  if (rightCodeOrigins.has(url.origin)) return 'rightcode';
  if (url.origin === 'https://riffle-api.pages.dev' && /^claude-opus-5-5$/i.test(profile.model)) return 'riffle';
  return undefined;
}

type QuotaPeriod = {
  remaining?: number | null;
  limit?: number | null;
  used?: number | null;
  available?: number | null;
  resetAt?: string;
  unknownRequests?: number | null;
};

export type ModelQuota = { profile: string; queriedAt: string } & (
  | { currency: 'USD'; balance: number }
  | {
    currency: 'CNY';
    available?: number | null;
    daily: QuotaPeriod;
    total: QuotaPeriod;
    reservations: { amount?: number | null; requests?: number | null };
    requestsPerMinute?: number | null;
    pendingReviewRequests?: number | null;
    updatedAt?: string;
  }
);
