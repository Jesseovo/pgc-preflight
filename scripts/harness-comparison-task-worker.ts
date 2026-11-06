/** Private B Worker composition. Public fetch is closed. Deployment bindings are separate. */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { captureFor } from '../server/cloud-review-capture';
import { cloudReviewAlarm } from '../server/cloud-review-runner';
import { creationPipelineAlarm } from '../server/forge-creation-pipeline';
import { comparisonBoundTaskKey, comparisonRunnerState, readComparisonReviewArchive, verifyComparisonReviewCheckpoint } from '../server/harness-comparison-archive';
import type { ComparisonHarnessOutboundScope } from '../server/harness-comparison-broker';
import type { ComparisonEvidenceIdentity } from '../server/harness-comparison-evidence';
import { openComparisonTaskControl, type ComparisonReleaseSeal } from '../server/harness-comparison-runner';
import { HarnessHost } from '../server/harness-host';
import { authorizeHarnessLease } from '../server/harness-ledger';
import { scopeHarnessOutbound, type HarnessOutboundScope } from '../server/harness-outbound-scope';
import type { HarnessBinding } from '../server/harness-policy';
import { HARNESS_MODEL_HEADERS } from '../server/harness-protocol';
import { createComparisonCandidateRelayClient, type ComparisonRelayFetcher } from './harness-comparison-relay-worker';

declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    constructor(ctx: unknown, env: Env);
  }
}

type Options = Parameters<typeof openComparisonTaskControl>[0];
type FrozenRuntime = Pick<Options, 'grant' | 'planBytes'> & { workerVersion: string; bundleSha256: string };
type DeployedRuntime = Options['runtime'] & { bundleSha256: string };
type Release = Awaited<ReturnType<Awaited<ReturnType<typeof openComparisonTaskControl>>['release']>>;

// These methods are RPC capabilities supplied by named private Service
// Bindings. None is a fetch handler or an ordinary value in Worker vars.
export type ComparisonAuthorityService = {
  authorizeRelease(seal: ComparisonReleaseSeal): Promise<boolean>;
  readTaskRuntime(taskId: string): Promise<FrozenRuntime | null>;
  readFrozenInput(taskId: string, sha256: string): Promise<string>;
  readEvidencePack(taskId: string, identity: ComparisonEvidenceIdentity): Promise<string>;
};
// Candidate access uses a stable Fetcher binding to the named private relay.

type ObjectId = { toString(): string };
type TaskNamespace = { idFromName(taskId: string): ObjectId; get(id: ObjectId): {
  release(seal: ComparisonReleaseSeal): Promise<Release>;
  readReviewArchive(taskId: string): ReturnType<typeof readComparisonReviewArchive>;
} };
type ObjectStorage = Parameters<typeof comparisonRunnerState>[0];
type TaskContext = { id: ObjectId; storage: ObjectStorage };
export type ComparisonTaskWorkerEnv = {
  DB: Options['database']['connection'];
  COMPARISON_DATABASE_ID?: string;
  COMPARISON_TASKS?: TaskNamespace;
  COMPARISON_AUTHORITY?: ComparisonAuthorityService;
  COMPARISON_CANDIDATE_BROKER?: ComparisonRelayFetcher;
  COMPARISON_CANDIDATE_VERSION?: string;
  COMPARISON_DEPLOYED_RUNTIME?: DeployedRuntime;
  COMPARISON_WORKER_VERSION?: { id: string };
  HARNESS_RUNNER?: HarnessBinding;
  BROWSER?: Parameters<typeof captureFor>[0]['BROWSER'];
};
type WorkerEnv = ComparisonTaskWorkerEnv;
type OutboundProps = HarnessOutboundScope & { stageDeadlineAt: number; requestIdPrefix: string; jsonOutput: boolean };
type Dependencies = { openControl: typeof openComparisonTaskControl; now: () => number };

const defaults: Dependencies = { openControl: openComparisonTaskControl, now: Date.now };
const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const versionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const generationPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const databasePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const stageForPrefix = new Map<string, ComparisonHarnessOutboundScope['stage']>([
  ['build-0-', 'build'], ['polish-0-', 'polish'], ['repair-1-', 'repair'], ['repair2-2-', 'repair2'],
  ['review-0-', 'review'], ['review_verify-0-', 'review_verify'],
]);
const toolPhaseHeader = 'x-pgc-comparison-tool-phase';
const toolDeadlineHeader = 'x-pgc-comparison-tool-deadline';

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const denied = () => new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
const unavailable = () => new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
const closed = { fetch: denied };
export default closed;

function checkedSeal(input: ComparisonReleaseSeal) {
  requireThat(input && typeof input === 'object' && Object.keys(input).length === 5 &&
    typeof input.taskId === 'string' && taskIdPattern.test(input.taskId) && [input.slotSha256, input.admissionSha256, input.inputSha256, input.policySha256]
      .every(value => typeof value === 'string' && digestPattern.test(value)), 'Invalid comparison release seal');
  return { taskId: input.taskId, slotSha256: input.slotSha256, admissionSha256: input.admissionSha256,
    inputSha256: input.inputSha256, policySha256: input.policySha256 };
}

function privateAuthority(env: WorkerEnv) {
  const authority = env.COMPARISON_AUTHORITY;
  requireThat(authority && typeof authority.authorizeRelease === 'function' && typeof authority.readTaskRuntime === 'function' &&
    typeof authority.readFrozenInput === 'function' && typeof authority.readEvidencePack === 'function',
  'Private comparison authority is unavailable');
  return authority;
}

function verifiedCandidate(env: WorkerEnv) {
  const candidate = env.COMPARISON_CANDIDATE_BROKER;
  const version = env.COMPARISON_CANDIDATE_VERSION;
  requireThat(candidate && typeof candidate.fetch === 'function' && typeof version === 'string' && versionPattern.test(version),
    'Private comparison candidate broker is unavailable');
  return { candidate: createComparisonCandidateRelayClient(candidate), version };
}

function deployedRuntime(env: WorkerEnv, approved: FrozenRuntime) {
  const actualVersion = env.COMPARISON_WORKER_VERSION?.id, deployed = env.COMPARISON_DEPLOYED_RUNTIME;
  requireThat(typeof actualVersion === 'string' && versionPattern.test(actualVersion) && actualVersion === approved.workerVersion &&
    deployed && typeof deployed.bundleSha256 === 'string' && digestPattern.test(deployed.bundleSha256) &&
    deployed.bundleSha256 === approved.bundleSha256,
  'Independently attested comparison Worker version or bundle is unavailable');
  const { implementationCommit, runtimeTreeSha256, image } = deployed;
  return { implementationCommit, runtimeTreeSha256, image };
}

/** Private control RPC routes to the fixed object; no supplied object ID is accepted. */
export async function routeComparisonRelease(env: WorkerEnv, input: ComparisonReleaseSeal) {
  const seal = checkedSeal(input);
  privateAuthority(env);
  requireThat(env.COMPARISON_TASKS, 'Private comparison task namespace is unavailable');
  return env.COMPARISON_TASKS.get(env.COMPARISON_TASKS.idFromName(seal.taskId)).release(seal);
}

/** Unit-testable DO implementation; callback injection is never a deployment binding. */
export function createComparisonTaskObject(ctx: TaskContext, env: WorkerEnv, dependencies: Dependencies = defaults) {
  const capability = Object.freeze({});
  const runnerState = comparisonRunnerState(ctx.storage, dependencies.now);
  let pending: Promise<unknown> = Promise.resolve();

  function serial<T>(work: () => Promise<T>) {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  }

  function fixedObject(taskId: string) {
    requireThat(taskIdPattern.test(taskId) && env.COMPARISON_TASKS &&
      ctx.id.toString() === env.COMPARISON_TASKS.idFromName(taskId).toString(),
    'Comparison task does not belong to this Durable Object');
  }

  async function controller(taskId: string) {
    fixedObject(taskId);
    const authority = privateAuthority(env);
    const { candidate, version } = verifiedCandidate(env);
    const databaseId = env.COMPARISON_DATABASE_ID;
    const harness = env.HARNESS_RUNNER;
    requireThat(typeof databaseId === 'string' && databasePattern.test(databaseId) && env.DB &&
      typeof harness?.idFromName === 'function' && typeof harness.get === 'function',
    'Isolated comparison database or Harness namespace is unavailable');
    const config = await authority.readTaskRuntime(taskId);
    requireThat(config, 'Private formal runtime is unavailable for this task');
    // Deployment supplies this pin separately from the approved grant. The
    // operator must read back the exact package assigned to version_metadata.
    const runtime = deployedRuntime(env, config);
    return dependencies.openControl({ grant: config.grant, planBytes: config.planBytes, authority: capability, runtime,
      database: { scope: 'isolated-comparison', id: databaseId, connection: env.DB },
      failedHarnessRunner: harness,
      alarms: { creation: creationPipelineAlarm, review: cloudReviewAlarm },
      loadFrozenInput: hash => authority.readFrozenInput(taskId, hash),
      loadEvidencePack: identity => authority.readEvidencePack(taskId, identity),
      bindVerifiedBroker: async scope => {
        if (scope.taskId !== taskId) return null;
        const attested = await candidate.readVerifiedProfile(scope, version);
        if (!attested || attested.candidateVersion !== version) return null;
        const { scopeSha256, profileId, profile } = attested;
        return { scopeSha256, profileId, profile, harnessRunner: harness };
      },
      captureCreation: env.BROWSER ? captureFor({ DB: env.DB, BROWSER: env.BROWSER, creationCaptureStrict: true }) : undefined,
      now: dependencies.now,
    });
  }

  return {
    release(input: ComparisonReleaseSeal) {
      const seal = checkedSeal(input);
      return serial(async () => {
        fixedObject(seal.taskId);
        requireThat(await privateAuthority(env).authorizeRelease(seal) === true, 'Private comparison authority refused release');
        const control = await controller(seal.taskId);
        await ctx.storage.transaction(async tx => {
          const existing = await tx.get<string>(comparisonBoundTaskKey);
          requireThat(existing === undefined || existing === seal.taskId, 'Comparison Durable Object is already bound to another task');
          if (existing === undefined) await tx.put(comparisonBoundTaskKey, seal.taskId);
        });
        const result = await control.release(capability, seal);
        if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(dependencies.now() + 100);
        return result;
      });
    },
    readReviewArchive(taskId: string) {
      fixedObject(taskId);
      return readComparisonReviewArchive(ctx.storage, taskId);
    },
    alarm() {
      return serial(async () => {
        const taskId = await ctx.storage.get<string>(comparisonBoundTaskKey);
        if (taskId === undefined) return;
        const control = await controller(taskId);
        await verifyComparisonReviewCheckpoint(ctx.storage, taskId);
        // Expired grants fail closed here. Do not clear sealed checkpoints:
        // a distinct recovery operation must independently prove seal time.
        await control.bindTask(capability, taskId, runnerState).alarm();
      });
    },
  };
}

/** Scope requests from the exact HarnessHost outbound export. Tools stay local. */
export async function comparisonHarnessOutbound(request: Request, props: OutboundProps, env: WorkerEnv, now = Date.now) {
  const stage = stageForPrefix.get(props?.requestIdPrefix);
  if (!stage || typeof props.taskId !== 'string' || !taskIdPattern.test(props.taskId) ||
    typeof props.generation !== 'string' || !generationPattern.test(props.generation) ||
    typeof props.lease !== 'string' || !digestPattern.test(props.lease) ||
    !Number.isSafeInteger(props.stageDeadlineAt) || props.stageDeadlineAt <= now() || typeof props.jsonOutput !== 'boolean') return denied();
  const scoped = scopeHarnessOutbound(request, props);
  if (!scoped) return denied();
  const path = new URL(scoped.url).pathname;
  const review = stage === 'review' || stage === 'review_verify';
  if (props.jsonOutput !== review) return denied();
  const tools = path === '/v1/tools';
  if (tools ? review : !review && path !== '/v1/messages') return denied();
  if (!tools) {
    const requestId = scoped.headers.get(HARNESS_MODEL_HEADERS.requestId);
    if (!requestId || !generationPattern.test(requestId) || !requestId.startsWith(props.requestIdPrefix)) return denied();
  }
  try {
    const { taskId, generation, lease, stageDeadlineAt, requestIdPrefix, jsonOutput } = props;
    const approved = await privateAuthority(env).readTaskRuntime(taskId);
    if (!approved) return unavailable();
    deployedRuntime(env, approved);
    if (stageDeadlineAt <= now() || scoped.signal.aborted) return denied();
    if (tools) {
      const binding = env.HARNESS_RUNNER;
      if (!binding) return unavailable();
      const modelPhase = stage + ':model';
      const run = await authorizeHarnessLease(env.DB, { taskId, generation }, lease, {
        now: now(),
        async authorizeRun(run) {
          if (run.family !== 'forge' || run.actor !== 'star' || run.model.purpose !== 'game' || !run.model.vision ||
              stageDeadlineAt > run.deadlineAt) return false;
          return Boolean(await env.DB.prepare(`SELECT 1 FROM forge_tasks t JOIN members m ON m.id=t.owner_id
            WHERE t.id=? AND t.owner_id=? AND t.status='running' AND t.executor='platform' AND t.kind='game'
              AND t.creative_version=2 AND t.harness_policy IS NOT NULL AND t.phase IN (?,?) AND m.enabled=1 AND m.star=1`)
            .bind(taskId, run.ownerId, modelPhase, stage === 'build' ? 'build:waiting' : modelPhase).first());
        },
      });
      if (!run || stageDeadlineAt <= now() || scoped.signal.aborted) return denied();
      const headers = new Headers(scoped.headers);
      headers.set(toolPhaseHeader, stage);
      headers.set(toolDeadlineHeader, String(stageDeadlineAt));
      return await binding.get(binding.idFromName(taskId)).fetch(new Request('http://harness/tools', new Request(scoped, { headers })));
    }
    const { candidate, version } = verifiedCandidate(env);
    const response = await candidate.forwardHarness(scoped, { taskId, generation, lease, stageDeadlineAt, requestIdPrefix, jsonOutput, stage }, version);
    if (response.headers.get('x-pgc-comparison-broker-version') !== version || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      return unavailable();
    }
    return response;
  } catch {
    return unavailable();
  }
}

// Cloudflare wrappers. Their factories and control decisions above can be
// exercised in Node without constructing a WorkerEntrypoint or a container.
export class ComparisonTaskControl extends WorkerEntrypoint<WorkerEnv> {
  fetch() { return denied(); }
  release(seal: ComparisonReleaseSeal) { return routeComparisonRelease(this.env, seal); }
  readReviewArchive(taskId: string) {
    const tasks = this.env.COMPARISON_TASKS;
    requireThat(typeof taskId === 'string' && taskIdPattern.test(taskId) && tasks, 'Private comparison task namespace is unavailable');
    return tasks.get(tasks.idFromName(taskId)).readReviewArchive(taskId);
  }
}

export class ComparisonTaskRunner extends DurableObject<WorkerEnv> {
  #task: ReturnType<typeof createComparisonTaskObject>;
  constructor(ctx: TaskContext, env: WorkerEnv) {
    super(ctx, env);
    this.#task = createComparisonTaskObject(ctx, env);
  }
  fetch() { return denied(); }
  release(seal: ComparisonReleaseSeal) { return this.#task.release(seal); }
  readReviewArchive(taskId: string) { return this.#task.readReviewArchive(taskId); }
  alarm() { return this.#task.alarm(); }
}

export class HarnessRunner extends HarnessHost {
  #serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly context: Pick<TaskContext, 'storage'>, private readonly bindings: WorkerEnv) {
    super(context, bindings);
  }

  fetch(request: Request) {
    // Hold the same research lock for /start and /tools. A new stage cannot
    // replace the Host checkpoint between this check and the tool execution.
    const operation = this.#serial.then(async () => {
      if (new URL(request.url).pathname === '/tools') {
        try {
          const taskId = request.headers.get(HARNESS_MODEL_HEADERS.task);
          const generation = request.headers.get(HARNESS_MODEL_HEADERS.generation);
          const phase = request.headers.get(toolPhaseHeader);
          const deadlineAt = Number(request.headers.get(toolDeadlineHeader));
          if (!taskId || !taskIdPattern.test(taskId) || !generation || !generationPattern.test(generation) ||
              !phase || !Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now() || request.signal.aborted) return denied();
          const runtime = await privateAuthority(this.bindings).readTaskRuntime(taskId);
          if (!runtime) return unavailable();
          deployedRuntime(this.bindings, runtime);
          const meta = await this.context.storage.get<{
            taskId: string; generation: string; phase: string; stageDeadlineAt: number; state: string;
          }>('meta');
          if (!meta || meta.taskId !== taskId || meta.generation !== generation || meta.phase !== phase ||
              meta.stageDeadlineAt !== deadlineAt || meta.state !== 'running' || deadlineAt <= Date.now() || request.signal.aborted) return denied();
        } catch { return unavailable(); }
      }
      return super.fetch(request);
    });
    this.#serial = operation.catch(() => {});
    return operation;
  }
}

export class HarnessOutbound extends WorkerEntrypoint<WorkerEnv, OutboundProps> {
  fetch(request: Request) { return comparisonHarnessOutbound(request, this.ctx.props, this.env); }
}
