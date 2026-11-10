import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').trim();
const researchObjects = [
  'harness_runs', 'harness_live_slots', 'harness_owner_runs',
  'harness_requests', 'harness_one_live_model_call', 'harness_request_recovery',
  'harness_events', 'harness_run_events',
  'harness_debit_reservation', 'harness_finalize_reservation', 'harness_debit_retry', 'harness_model_telemetry',
];

/** Bootstrap only an empty, isolated research D1. This is not a production migration. */
export function providerResearchSchema(): string {
  const telemetry = read('../migrations/0013_model_runs.sql');
  const modelColumns = read('../migrations/0027_review_timing.sql').match(/^ALTER TABLE model_runs ADD COLUMN [a-z_]+ (?:INTEGER|TEXT);$/gm) ?? [];
  if (!['first_response_ms', 'attempts'].every(column => modelColumns.some(line => line.includes(`COLUMN ${column} `)))) {
    throw new Error('Research telemetry prerequisites changed');
  }
  const mixed = read('../migrations/0033_harness.sql');
  const start = mixed.indexOf('CREATE TABLE harness_runs (');
  if (start < 0 || mixed.slice(0, start).trim() !== [
    'ALTER TABLE forge_tasks ADD COLUMN harness_policy TEXT;',
    'ALTER TABLE review_jobs ADD COLUMN harness_policy TEXT;',
  ].join('\n')) throw new Error('Research ledger migration boundaries changed');
  const ledger = mixed.slice(start);
  const objects = [...ledger.matchAll(/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER) ([a-z_]+)/gm)].map(match => match[1]);
  if (JSON.stringify(objects) !== JSON.stringify(researchObjects) ||
      /^(?:ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|ATTACH|PRAGMA)\b/m.test(ledger)) {
    throw new Error('Unexpected SQL in research ledger schema');
  }
  return [
    '-- Isolated CCB provider research only. Never apply to the production database.',
    telemetry,
    modelColumns.join('\n'),
    ledger,
    read('./harness-provider-research-ledger.sql'),
  ].join('\n\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(providerResearchSchema());
}
