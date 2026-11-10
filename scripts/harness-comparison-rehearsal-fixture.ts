/** Shared public model and rule snapshots for the synthetic paired rehearsal only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const frozenAt = '2026-11-06T00:00:00.000Z';
const rulesId = 'synthetic-comparison-rules-v2';
const rules = {
  sourceUrl: 'https://creator-hub-7mi.pages.dev/#/', capturedAt: frozenAt,
  rawDirection: 'Synthetic direction for rehearsal', rawScoring: 'Synthetic scoring for rehearsal',
  scoreMin: 0, scoreMax: 3, passScore: 7, notes: '', calibrationCases: [],
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export const syntheticComparisonReviewModel = Object.freeze({
  model: 'deepseek-flash', protocol: 'openai', baseUrl: 'https://api.deepseek.com', vision: true, enabled: true,
  effort: 'low', maxOutputTokens: 24_000, updatedAt: frozenAt,
} as const);

type FixtureDatabase = {
  prepare(sql: string): { bind(...params: string[]): { run(): Promise<unknown> } };
};

export async function seedSyntheticComparisonReviewRules(DB: FixtureDatabase, canonicalJson: (value: unknown) => string,
  getActive: () => Promise<unknown>) {
  const content = canonicalJson(rules);
  const rulesContentSha256 = sha(content);
  await DB.prepare('INSERT INTO review_rule_versions(id,content_hash,snapshot,created_at,published_at) VALUES(?,?,?,?,?)')
    .bind(rulesId, rulesContentSha256, content, frozenAt, frozenAt).run();
  await DB.prepare('UPDATE review_rule_head SET version_id=? WHERE id=1').bind(rulesId).run();
  const active = canonicalJson(await getActive());
  assert.equal(active, canonicalJson({ schemaVersion: 2, id: rulesId, contentHash: rulesContentSha256, publishedAt: frozenAt, ...rules }));
  return { rulesSha256: sha(active), rulesContentSha256, calibrationSha256: sha(canonicalJson(rules.calibrationCases)),
    modelConfigSha256: sha(canonicalJson(syntheticComparisonReviewModel)) };
}
