/** Named private data authority for the comparison task Workers. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  loadComparisonDeployment, comparisonEntryExact, comparisonEntryHash, comparisonEntryRequire, comparisonEntryTask,
  type ComparisonResearchBindings,
} from '../server/harness-comparison-entry-config';
import type { ComparisonEvidenceIdentity } from '../server/harness-comparison-evidence';
import { openComparisonAuthority, openComparisonBaselineAuthority } from '../server/harness-comparison-registry';
import type { ComparisonReleaseSeal } from '../server/harness-comparison-runner';

type Baseline = Awaited<ReturnType<typeof openComparisonBaselineAuthority>>;
type CompletedB = Parameters<Baseline['verifyCompletedBArtifact']>[0];
const closed = () => new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
const unavailable = () => new Error('Comparison authority unavailable');
const casePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const validCase = (value: unknown) => typeof value === 'string' && casePattern.test(value);

export default { fetch: closed };

function releaseSeal(seal: ComparisonReleaseSeal) {
  return comparisonEntryExact(seal, ['taskId', 'slotSha256', 'admissionSha256', 'inputSha256', 'policySha256']) && comparisonEntryTask(seal.taskId) &&
    [seal.slotSha256, seal.admissionSha256, seal.inputSha256, seal.policySha256].every(comparisonEntryHash);
}

function evidenceIdentity(value: ComparisonEvidenceIdentity) {
  return comparisonEntryExact(value, ['caseId', 'manifestSha256', 'evidenceSha256', 'packSha256']) && validCase(value.caseId) &&
    [value.manifestSha256, value.evidenceSha256, value.packSha256].every(comparisonEntryHash);
}

async function authority(env: ComparisonResearchBindings, arm: 'A' | 'B') {
  const { shared, contexts } = await loadComparisonDeployment(env);
  return { open: () => arm === 'A' ? openComparisonBaselineAuthority(shared) : openComparisonAuthority(shared),
    allows: (taskId: unknown) => comparisonEntryTask(taskId) && contexts[arm].taskIds.includes(taskId), contexts, shared };
}

class AuthorityMethods extends WorkerEntrypoint<ComparisonResearchBindings> {
  readonly #arm: 'A' | 'B';

  constructor(ctx: unknown, env: ComparisonResearchBindings, arm: 'A' | 'B') {
    super(ctx, env);
    this.#arm = arm;
  }

  fetch() { return closed(); }

  async authorizeRelease(seal: ComparisonReleaseSeal) {
    try {
      if (!releaseSeal(seal)) return false;
      const service = await authority(this.env, this.#arm);
      return service.allows(seal.taskId) && await (await service.open()).authorizeRelease(seal) === true;
    } catch { return false; }
  }

  async readTaskRuntime(taskId: string) {
    try {
      if (!comparisonEntryTask(taskId)) return null;
      const service = await authority(this.env, this.#arm);
      return service.allows(taskId) ? await (await service.open()).readTaskRuntime(taskId) : null;
    } catch { return null; }
  }

  async readFrozenInput(taskId: string, digest: string) {
    try {
      comparisonEntryRequire(comparisonEntryTask(taskId) && comparisonEntryHash(digest));
      const service = await authority(this.env, this.#arm);
      comparisonEntryRequire(service.allows(taskId));
      return await (await service.open()).readFrozenInput(taskId, digest);
    } catch { throw unavailable(); }
  }

  async readEvidencePack(taskId: string, identity: ComparisonEvidenceIdentity) {
    try {
      comparisonEntryRequire(comparisonEntryTask(taskId) && evidenceIdentity(identity));
      const service = await authority(this.env, this.#arm);
      comparisonEntryRequire(service.allows(taskId));
      return await (await service.open()).readEvidencePack(taskId, identity);
    } catch { throw unavailable(); }
  }
}

export class ComparisonAuthority extends AuthorityMethods {
  constructor(ctx: unknown, env: ComparisonResearchBindings) { super(ctx, env, 'B'); }
}

export class ComparisonBaselineAuthority extends AuthorityMethods {
  constructor(ctx: unknown, env: ComparisonResearchBindings) { super(ctx, env, 'A'); }

  async verifyCompletedBArtifact(input: CompletedB) {
    try {
      comparisonEntryRequire(comparisonEntryExact(input, ['taskId', 'caseId', 'planSha256', 'manifestSha256',
        'sourceSha256', 'evidenceSha256', 'packSha256']) && comparisonEntryTask(input.taskId) && validCase(input.caseId) &&
        [input.planSha256, input.manifestSha256, input.sourceSha256, input.evidenceSha256, input.packSha256].every(comparisonEntryHash));
      const { shared, contexts } = await authority(this.env, 'A');
      if (!contexts.B.taskIds.includes(input.taskId)) return false;
      return await (await openComparisonBaselineAuthority(shared)).verifyCompletedBArtifact(input) === true;
    } catch { return false; }
  }
}
