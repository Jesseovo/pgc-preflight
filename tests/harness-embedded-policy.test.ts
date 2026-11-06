import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CCB_ENGINE_COMMIT, EMBEDDED_CCB_VERSION, HARNESS_GAME_LIMITS, modelContractHash, newHarnessPolicy,
  parseHarnessPolicy, type HarnessEnvironment, type HarnessPolicy,
} from '../server/harness-policy';
import type { ModelConfig, StoredModelProfile } from '../server/settings';

const image = 'registry.cloudflare.com/0123456789abcdef0123456789abcdef/pgc-ccb-research@sha256:' + 'a'.repeat(64);
const evidenceHash = 'b'.repeat(64);
const modelHash = 'c'.repeat(64);
const opus: StoredModelProfile = {
  model: 'claude-opus-5-5', baseUrl: 'https://riffle-api.pages.dev', protocol: 'anthropic', effort: 'low',
  encryptedKey: 'synthetic-opaque-creation-key', enabled: true, vision: true, updatedAt: 'fixture',
};
const deepseek: StoredModelProfile = {
  model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', protocol: 'openai', effort: 'low',
  encryptedKey: 'synthetic-opaque-review-key', enabled: true, vision: true, updatedAt: 'fixture',
};
const model: ModelConfig = { ...opus, activeProfile: 'opus', profiles: { opus, deepseek }, routes: { create: 'opus', review: 'deepseek' } };
const gamePolicy: HarnessPolicy = {
  version: 2, engine: 'ccb-embedded', engineCommit: CCB_ENGINE_COMMIT, coreVersion: EMBEDDED_CCB_VERSION,
  contextWindowTokens: 1_000_000, releaseHash: evidenceHash, family: 'forge', purpose: 'game', modelContractHash: modelHash,
  limits: { ...HARNESS_GAME_LIMITS },
};
let fetchTrap: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchTrap = vi.fn(() => { throw new Error('No external request'); });
  vi.stubGlobal('fetch', fetchTrap);
});
afterEach(() => {
  expect(fetchTrap).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function fixture(selected: ModelConfig = model) {
  const get = vi.fn(async () => selected);
  const member = vi.fn(async (owner: string) => owner === 'pilot-member' ? { eligible: 1 } : null);
  const prepare = vi.fn((sql: string) => {
    expect(sql).toContain('review_pilot_members');
    expect(sql).toContain('pilot_enabled=1');
    return { bind: (owner: string) => ({ first: () => member(owner) }) };
  });
  const [game, brief, review] = await Promise.all(['game', 'brief', 'review'].map(purpose =>
    modelContractHash(selected, purpose as 'game' | 'brief' | 'review')));
  const release = { engine: 'ccb-embedded', coreVersion: EMBEDDED_CCB_VERSION, coreBundleSha256: 'd'.repeat(64), engineCommit: CCB_ENGINE_COMMIT,
    rightsConfirmed: true, providerCompatibilityVerified: true, comparisonAccepted: true, isolationVerified: true,
    coreParityVerified: true, evidenceHash, compatibleModelContracts: [game, brief, review],
    contextWindows: { [game]: 1_000_000, [brief]: 800_000, [review]: 128_000 },
  };
  const env: HarnessEnvironment = { DB: { prepare }, modelStore: { get }, HARNESS_ROLLOUT: 'pilot', HARNESS_RELEASE: JSON.stringify(release) };
  return { env, get, member, prepare, release, game, brief, review };
}

describe('persisted embedded policy', () => {
  it('locks the embedded version and context independently from old container snapshots', () => {
    expect(parseHarnessPolicy(JSON.stringify(gamePolicy))).toEqual(gamePolicy);
    expect(parseHarnessPolicy({ ...gamePolicy, contextWindowTokens: 2_000_000 })).toMatchObject({ version: 2, contextWindowTokens: 2_000_000 });
    const small = { ...gamePolicy, contextWindowTokens: 8_192, limits: { ...gamePolicy.limits, maxOutputTokens: 8_191 } };
    expect(parseHarnessPolicy(small)).toEqual(small);
    const { coreVersion: _coreVersion, contextWindowTokens: _contextWindowTokens, ...common } = gamePolicy;
    const old = { ...common, version: 1, engine: 'ccb', image };
    expect(parseHarnessPolicy(JSON.stringify(old))).toEqual(old);
    expect(parseHarnessPolicy(null)).toBeNull();
  });

  it.each([
    undefined, '1000000', 8191, 2_000_001, NaN, Infinity, 100_000.5, 64_000,
  ])('rejects an invalid, unsupported or exhausted context capability (%s)', contextWindowTokens => {
    expect(() => parseHarnessPolicy({ ...gamePolicy, contextWindowTokens })).toThrow();
  });

  it('rejects mixed engine pins and inconsistent budgets at the policy boundary', () => {
    for (const patch of [{ image }, { coreVersion: 'different-core' }, { engine: 'ccb' }, { version: 1 }, { releaseHash: 'missing' }]) {
      expect(() => parseHarnessPolicy({ ...gamePolicy, ...patch })).toThrow();
    }
    for (const limits of [
      { ...gamePolicy.limits, maxOutputTokens: 64_001 },
      { ...gamePolicy.limits, maxTotalOutputTokens: 256_001 },
      { ...gamePolicy.limits, maxTotalOutputTokens: 63_999 },
      { ...gamePolicy.limits, maxModelTurns: 25 },
      { ...gamePolicy.limits, maxModelTurns: 0 },
      { ...gamePolicy.limits, maxDurationMs: 2_400_001 },
      { ...gamePolicy.limits, maxRepairs: 3 },
    ]) expect(() => parseHarnessPolicy({ ...gamePolicy, limits })).toThrow();
    const review = { ...gamePolicy, family: 'review', purpose: 'review', limits: {
      maxOutputTokens: 24_000, maxTotalOutputTokens: 48_000, maxModelTurns: 8, maxDurationMs: 720_000, maxRepairs: 0,
    } };
    expect(parseHarnessPolicy(review)).toEqual(review);
    for (const limits of [
      { ...review.limits, maxTotalOutputTokens: 47_999 },
      { ...review.limits, maxModelTurns: 1 },
      { ...review.limits, maxRepairs: 1 },
    ]) expect(() => parseHarnessPolicy({ ...review, limits })).toThrow();
    expect(() => parseHarnessPolicy({ ...review, purpose: 'review_verify' })).toThrow();
  });
});

describe('embedded pilot admission', () => {
  it('gates admission to the pilot allowlist and keeps embedded execution independent of the container binding', async () => {
    const f = await fixture();
    for (const HARNESS_ROLLOUT of [undefined, 'off', 'all', 'unknown']) {
      expect(await newHarnessPolicy({ ...f.env, HARNESS_ROLLOUT }, 'pilot-member', 'forge', 'game')).toBeNull();
    }
    expect(f.prepare).not.toHaveBeenCalled();
    expect(await newHarnessPolicy(f.env, 'ordinary-member', 'forge', 'game')).toBeNull();
    expect(f.get).not.toHaveBeenCalled();
    const container = { idFromName: vi.fn(() => { throw new Error('Container touched'); }), get: vi.fn(() => { throw new Error('Container touched'); }) };
    expect(await newHarnessPolicy({ ...f.env, HARNESS_RUNNER: container }, 'pilot-member', 'forge', 'game')).toEqual({
      ...gamePolicy, modelContractHash: f.game,
    });
    expect(await newHarnessPolicy(f.env, 'pilot-member', 'forge', 'game')).toEqual({ ...gamePolicy, modelContractHash: f.game });
    expect(container.idFromName).not.toHaveBeenCalled();
    expect(container.get).not.toHaveBeenCalled();
    const old = { ...f.release, engine: undefined, coreVersion: undefined, coreBundleSha256: undefined,
      coreParityVerified: undefined, contextWindows: undefined, image };
    await expect(newHarnessPolicy({ ...f.env, HARNESS_RELEASE: JSON.stringify(old) }, 'pilot-member', 'forge', 'game')).rejects.toThrow();
    expect(await newHarnessPolicy({ ...f.env, HARNESS_RELEASE: JSON.stringify(old), HARNESS_RUNNER: container }, 'pilot-member', 'forge', 'game'))
      .toMatchObject({ version: 1, engine: 'ccb', image, limits: HARNESS_GAME_LIMITS });
    await expect(newHarnessPolicy({ ...f.env, HARNESS_RELEASE: JSON.stringify({ ...old, engine: 'unknown-engine' }), HARNESS_RUNNER: container },
      'pilot-member', 'forge', 'game')).rejects.toThrow();
  });

  it('requires the complete release evidence before reading any model configuration', async () => {
    const f = await fixture();
    const evidence = ['rightsConfirmed', 'providerCompatibilityVerified', 'comparisonAccepted', 'isolationVerified', 'coreParityVerified'];
    for (const missing of evidence) for (const value of [undefined, false, 'true']) {
      await expect(newHarnessPolicy({ ...f.env, HARNESS_RELEASE: JSON.stringify({ ...f.release, [missing]: value }) }, 'admin', 'review', 'review'))
        .rejects.toThrow();
    }
    for (const patch of [{ evidenceHash: 'unpinned' }, { engineCommit: 'wrong-commit' }, { coreVersion: 'unverified-core' },
      { coreBundleSha256: undefined }, { coreBundleSha256: 'bad-digest' }]) {
      await expect(newHarnessPolicy({ ...f.env, HARNESS_RELEASE: JSON.stringify({ ...f.release, ...patch }) }, 'admin', 'review', 'review')).rejects.toThrow();
    }
    expect(f.get).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('requires context capability for the actual verified model and preserves purpose budgets', async () => {
    const f = await fixture();
    await expect(newHarnessPolicy({ ...f.env, HARNESS_RELEASE: JSON.stringify({ ...f.release, compatibleModelContracts: [f.game] }) }, 'admin', 'review', 'review'))
      .rejects.toThrow();
    await expect(newHarnessPolicy({ ...f.env, HARNESS_RELEASE: JSON.stringify({ ...f.release, contextWindows: { [f.game]: 1_000_000 } }) },
      'admin', 'review', 'review')).rejects.toThrow();
    expect(await newHarnessPolicy(f.env, 'admin', 'review', 'review')).toMatchObject({ version: 2, engine: 'ccb-embedded',
      contextWindowTokens: 128_000, modelContractHash: f.review, limits: {
        maxOutputTokens: 24_000, maxTotalOutputTokens: 48_000, maxModelTurns: 8, maxDurationMs: 720_000, maxRepairs: 0,
      } });
    expect(await newHarnessPolicy(f.env, 'pilot-member', 'forge', 'brief')).toMatchObject({
      contextWindowTokens: 800_000, limits: { maxOutputTokens: 64_000, maxTotalOutputTokens: 64_000, maxModelTurns: 6, maxRepairs: 0 },
    });
    expect(await newHarnessPolicy(f.env, 'pilot-member', 'forge', 'expand', 8_000)).toMatchObject({
      modelContractHash: f.brief, limits: { maxOutputTokens: 8_000, maxTotalOutputTokens: 8_000 },
    });
  });
});
