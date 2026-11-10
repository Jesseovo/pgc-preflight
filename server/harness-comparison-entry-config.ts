/** Deployment-only wiring shared by comparison entrypoints. Contains no provider credentials. */
import type { openComparisonAuthority } from './harness-comparison-registry';
import { canonicalHarness, harnessHash } from './harness-policy';
import type { ComparisonServiceContext } from './harness-comparison-service';
import type { Database } from './storage';

type AuthorityOptions = Parameters<typeof openComparisonAuthority>[0];
type Arm = 'A' | 'B';
type DatabaseIds = Record<Arm | 'ledger' | 'nonce', string>;
type Resource = { size: number; text(): Promise<string> };

export type ComparisonDeployment = Pick<AuthorityOptions, 'grant' | 'slots' | 'runnerGrants' | 'planBytes' | 'attestation'> & {
  schemaVersion: 1;
  databases: DatabaseIds;
  contexts: Record<Arm, ComparisonServiceContext>;
};
export type ComparisonBootstrap = {
  runId: string; planSha256: string; manifestSha256: string; authorizationSha256: string; ledgerDatabaseId: string;
};
export type ComparisonResearchBindings = {
  COMPARISON_BOOTSTRAP?: string;
  COMPARISON_DATABASE_IDS?: string;
  COMPARISON_A_DB?: AuthorityOptions['databases']['A']['connection'];
  COMPARISON_B_DB?: AuthorityOptions['databases']['B']['connection'];
  COMPARISON_LEDGER_DB?: AuthorityOptions['databases']['ledger']['connection'] & Database;
  COMPARISON_NONCE_DB?: AuthorityOptions['databases']['nonce']['connection'];
  COMPARISON_MATERIALS?: { get(key: string): Promise<Resource | null> };
};

const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const task = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const databaseNames = ['A', 'B', 'ledger', 'nonce'];
const maxPartBytes = 96 * 1024;
const maxParts = 2_048;
const maxDeploymentBytes = 1024 * 1024;
const encoder = new TextEncoder();
export const COMPARISON_ENTRY_LEDGER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS comparison_service_deployments (
    run_id TEXT PRIMARY KEY, deployment_sha TEXT NOT NULL, deployment_json TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS comparison_deployment_no_replace
    BEFORE INSERT ON comparison_service_deployments WHEN EXISTS(
      SELECT 1 FROM comparison_service_deployments WHERE run_id=NEW.run_id
    ) BEGIN SELECT RAISE(ABORT,'Immutable comparison deployment'); END`,
  ...['UPDATE', 'DELETE'].map(operation => `CREATE TRIGGER IF NOT EXISTS comparison_deployment_no_${operation.toLowerCase()}
    BEFORE ${operation} ON comparison_service_deployments BEGIN SELECT RAISE(ABORT,'Immutable comparison deployment'); END`),
  `CREATE TABLE IF NOT EXISTS comparison_service_grants (
    run_id TEXT PRIMARY KEY, grant_sha TEXT NOT NULL, deployment_sha TEXT NOT NULL, authorization_sha TEXT NOT NULL, plan_sha TEXT NOT NULL,
    candidate_version TEXT NOT NULL, not_before INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
  )`,
  `CREATE TABLE IF NOT EXISTS comparison_material_blobs (
    material_key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, part_count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS comparison_material_chunks (
    material_key TEXT NOT NULL REFERENCES comparison_material_blobs(material_key), part INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(material_key, part)
  )`,
] as const;
export const comparisonEntryUnavailable = () => new Error('Comparison deployment unavailable');
export function comparisonEntryRequire(value: unknown): asserts value { if (!value) throw comparisonEntryUnavailable(); }
export function comparisonEntryExact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
export function comparisonEntryJson<T>(text: unknown, max: number): T {
  comparisonEntryRequire(typeof text === 'string' && text.length > 0 && text.length <= max);
  try { return JSON.parse(text) as T; } catch { throw comparisonEntryUnavailable(); }
}
export function comparisonEntryHash(value: unknown): value is string { return typeof value === 'string' && hash.test(value); }
export function comparisonEntryTask(value: unknown): value is string { return typeof value === 'string' && task.test(value); }

function contextSnapshot(value: ComparisonServiceContext) {
  return canonicalHarness({ ...value, taskIds: [...value.taskIds].sort() });
}
export function sameComparisonContext(a: ComparisonServiceContext, b: ComparisonServiceContext) {
  return contextSnapshot(a) === contextSnapshot(b);
}

export function materialStoreFromLedger(db: Database) {
  return {
    async get(key: string): Promise<Resource | null> {
      const match = /^(frozen\/|evidence\/[0-9a-f-]{36}\/)([a-f0-9]{64})$/.exec(key);
      comparisonEntryRequire(match && (match[1] === 'frozen/' || comparisonEntryTask(match[1].slice(9, -1))));
      const digest = match[2], limit = match[1] === 'frozen/' ? 512 * 1024 : 64 * 1024 * 1024;
      const row = await db.prepare('SELECT sha256,byte_length,part_count FROM comparison_material_blobs WHERE material_key=?')
        .bind(key).first<{ sha256: string; byte_length: number; part_count: number }>();
      if (!row) return null;
      const { byte_length: size, part_count: count } = row;
      comparisonEntryRequire(row.sha256 === digest && Number.isSafeInteger(size) && size > 0 && size <= limit &&
        Number.isSafeInteger(count) && count > 0 && count <= maxParts && size <= count * maxPartBytes);
      return {
        size,
        async text() {
          const actual = await db.prepare('SELECT count(*) AS count FROM comparison_material_chunks WHERE material_key=?')
            .bind(key).first<{ count: number }>();
          comparisonEntryRequire(actual?.count === count);
          let readBytes = 0;
          const chunks: string[] = [];
          for (let start = 0; start < count; start += 16) {
            const end = Math.min(count, start + 16);
            const { results } = await db.prepare(`SELECT part,data FROM comparison_material_chunks
              WHERE material_key=? AND part>=? AND part<? AND length(CAST(data AS BLOB)) BETWEEN 1 AND ? ORDER BY part`)
              .bind(key, start, end, maxPartBytes).all<{ part: number; data: string }>();
            comparisonEntryRequire(results.length === end - start);
            for (const [offset, part] of results.entries()) {
              comparisonEntryRequire(part.part === start + offset && typeof part.data === 'string');
              readBytes += encoder.encode(part.data).byteLength;
              comparisonEntryRequire(readBytes <= size);
              chunks.push(part.data);
            }
          }
          const material = chunks.join('');
          comparisonEntryRequire(readBytes === size && await harnessHash(material) === digest);
          return material;
        },
      };
    },
  };
}

export async function loadComparisonDeployment(env: ComparisonResearchBindings, candidate?: {
  production: Database; executingVersion: string;
}) {
  const bootstrap = comparisonEntryJson<ComparisonBootstrap>(env.COMPARISON_BOOTSTRAP, 4 * 1024);
  const readback = comparisonEntryJson<DatabaseIds & { production?: string }>(env.COMPARISON_DATABASE_IDS, 4 * 1024);
  comparisonEntryRequire(comparisonEntryExact(bootstrap, ['runId', 'planSha256', 'manifestSha256', 'authorizationSha256', 'ledgerDatabaseId']) &&
    typeof bootstrap.runId === 'string' && id.test(bootstrap.runId) &&
    [bootstrap.planSha256, bootstrap.manifestSha256, bootstrap.authorizationSha256].every(comparisonEntryHash) &&
    comparisonEntryExact(readback, candidate ? [...databaseNames, 'production'] : databaseNames) &&
    databaseNames.every(name => typeof readback[name as keyof DatabaseIds] === 'string' && id.test(readback[name as keyof DatabaseIds])) &&
    bootstrap.ledgerDatabaseId === readback.ledger);
  const { A, B, ledger, nonce } = readback;
  const a = env.COMPARISON_A_DB, b = env.COMPARISON_B_DB, global = env.COMPARISON_LEDGER_DB;
  const replay = nonce === ledger ? global : env.COMPARISON_NONCE_DB;
  comparisonEntryRequire(a && b && global && replay && [a, b, global, replay].every(db => typeof db.prepare === 'function') &&
    new Set([A, B, ledger]).size === 3 && new Set([a, b, global]).size === 3 &&
    nonce !== A && nonce !== B && replay !== a && replay !== b &&
    (nonce === ledger ? env.COMPARISON_NONCE_DB === undefined || env.COMPARISON_NONCE_DB === global : replay !== global) &&
    (!candidate || typeof readback.production === 'string' && id.test(readback.production) &&
      ![A, B, ledger, nonce].includes(readback.production) && candidate.production && typeof candidate.production.prepare === 'function' &&
      ![a, b, global, replay].includes(candidate.production) && uuid.test(candidate.executingVersion)));

  const stored = await global.prepare(`SELECT deployment_sha, deployment_json FROM comparison_service_deployments
    WHERE run_id=? AND length(CAST(deployment_json AS BLOB)) BETWEEN 1 AND ?`)
    .bind(bootstrap.runId, maxDeploymentBytes).first<{ deployment_sha: string; deployment_json: string }>();
  comparisonEntryRequire(stored && comparisonEntryHash(stored.deployment_sha) && typeof stored.deployment_json === 'string' &&
    encoder.encode(stored.deployment_json).byteLength <= maxDeploymentBytes && await harnessHash(stored.deployment_json) === stored.deployment_sha);
  const deploymentSha256 = stored.deployment_sha;
  const config = comparisonEntryJson<ComparisonDeployment>(stored.deployment_json, maxDeploymentBytes);
  comparisonEntryRequire(comparisonEntryExact(config, ['schemaVersion', 'grant', 'slots', 'runnerGrants', 'planBytes', 'attestation', 'databases', 'contexts']) &&
    config.schemaVersion === 1 && comparisonEntryExact(config.databases, databaseNames) &&
    databaseNames.every(name => config.databases[name as keyof DatabaseIds] === readback[name as keyof DatabaseIds]) &&
    comparisonEntryExact(config.contexts, ['A', 'B']) &&
    config.attestation && typeof config.attestation.authorizedCandidateVersion === 'string' && uuid.test(config.attestation.authorizedCandidateVersion) &&
    config.attestation.executingCandidateVersion === config.attestation.authorizedCandidateVersion &&
    (!candidate || config.attestation.authorizedCandidateVersion === candidate.executingVersion));
  const materials = env.COMPARISON_MATERIALS ?? materialStoreFromLedger(global);
  comparisonEntryRequire(typeof materials.get === 'function');
  const databases: AuthorityOptions['databases'] = {
    A: { id: A, connection: a }, B: { id: B, connection: b }, ledger: { id: ledger, connection: global },
    nonce: { id: nonce, connection: replay },
  };
  const grant = config.grant;
  comparisonEntryRequire(grant && grant.scope === 'formal' && grant.ledgerDatabaseId === ledger &&
    grant.runId === bootstrap.runId && grant.planSha256 === bootstrap.planSha256 &&
    grant.manifestSha256 === bootstrap.manifestSha256 && grant.authorizationSha256 === bootstrap.authorizationSha256 &&
    comparisonEntryExact(config.runnerGrants, ['A', 'B']) && Array.isArray(config.slots) && config.slots.length <= 24);
  for (const arm of ['A', 'B'] as const) {
    const ctx = config.contexts[arm], runner = config.runnerGrants[arm];
    const expectedTasks = config.slots.filter(slot => slot.arm === arm).map(slot => slot.taskId).sort();
    comparisonEntryRequire(ctx && runner && ctx.candidateVersion === config.attestation.authorizedCandidateVersion &&
      ctx.nonceDatabaseId === nonce && ctx.runnerDatabaseId === config.databases[arm] && runner.runnerDatabaseId === config.databases[arm] &&
      ctx.runId === grant.runId && ctx.authorizationSha256 === grant.authorizationSha256 && ctx.planSha256 === grant.planSha256 &&
      ctx.manifestSha256 === grant.manifestSha256 && ctx.dispatchGrantSha256 === runner.dispatchGrantSha256 &&
      ctx.notBefore === grant.notBefore && ctx.deadlineAt === grant.deadlineAt &&
      Array.isArray(ctx.taskIds) && expectedTasks.length > 0 && expectedTasks.length === ctx.taskIds.length &&
      expectedTasks.every(comparisonEntryTask) && new Set(expectedTasks).size === expectedTasks.length &&
      [...ctx.taskIds].sort().every((value, index) => value === expectedTasks[index]));
  }
  const tasks = [...config.contexts.A.taskIds, ...config.contexts.B.taskIds];
  comparisonEntryRequire(new Set(tasks).size === tasks.length);

  async function readMaterial(key: string, limit: number) {
    const value = await materials.get(key);
    comparisonEntryRequire(value && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= limit);
    const text = await value.text();
    comparisonEntryRequire(typeof text === 'string' && text.length > 0 && text.length <= value.size);
    return text;
  }
  const shared: AuthorityOptions = {
    async authorizeGrant(context) {
      if (!sameComparisonContext(context, config.contexts.A) && !sameComparisonContext(context, config.contexts.B)) return false;
      const now = Date.now();
      const row = await global.prepare(`SELECT run_id FROM comparison_service_grants
        WHERE run_id=? AND grant_sha=? AND deployment_sha=? AND authorization_sha=? AND plan_sha=? AND candidate_version=?
          AND not_before=? AND deadline_at=? AND enabled=1 AND not_before<=? AND deadline_at>?`)
        .bind(context.runId, context.dispatchGrantSha256, deploymentSha256, context.authorizationSha256, context.planSha256, context.candidateVersion,
          context.notBefore, context.deadlineAt, now, now).first<{ run_id: string }>();
      return row?.run_id === context.runId;
    },
    grant, slots: config.slots, runnerGrants: config.runnerGrants, planBytes: config.planBytes, attestation: config.attestation, databases,
    async loadFrozenInput(digest) {
      comparisonEntryRequire(comparisonEntryHash(digest));
      return readMaterial('frozen/' + digest, 512 * 1024);
    },
    async loadEvidencePack(taskId, identity) {
      comparisonEntryRequire(tasks.includes(taskId) && comparisonEntryHash(identity.packSha256));
      return readMaterial('evidence/' + taskId + '/' + identity.packSha256, 64 * 1024 * 1024);
    },
  };
  return { shared, contexts: config.contexts, productionId: readback.production, deploymentSha256 };
}
