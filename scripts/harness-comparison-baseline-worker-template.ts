/** This source is written into the private archived-A adapter copy. */
export const baselineWorkerTemplate = String.raw`/** Private archived A composition. There is no public execution endpoint. */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { captureFor } from './cloud-review-capture';
import { createBaselineTaskAdapter, verifyBaselineCheckpointProfile } from './comparison-baseline-entry';
import { comparisonBoundTaskKey, comparisonRunnerState, readComparisonReviewArchive, verifyComparisonReviewCheckpoint } from './harness-comparison-archive';
import { openComparisonTaskControl, type ComparisonReleaseSeal } from './harness-comparison-runner';
import { canonicalHarness, harnessHash } from './harness-policy';
import { COMPARISON_SERVICE_BASELINE_PATH, COMPARISON_SERVICE_ORIGIN, createComparisonServiceClient,
  type ComparisonServiceContext } from './harness-comparison-service';

type Options = Parameters<typeof openComparisonTaskControl>[0];
type Authority = {
  authorizeRelease(seal: ComparisonReleaseSeal): Promise<boolean>;
  readTaskRuntime(taskId: string): Promise<Pick<Options, 'grant' | 'planBytes'> & { workerVersion: string; bundleSha256: string } | null>;
  readFrozenInput(taskId: string, digest: string): Promise<string>;
  readEvidencePack: (taskId: string, identity: Parameters<NonNullable<Options['loadEvidencePack']>>[0]) => Promise<string>;
  verifyCompletedBArtifact: NonNullable<Options['baseline']>['verifyBArtifact'];
};
type Env = {
  DB: Options['database']['connection']; BROWSER?: Parameters<typeof captureFor>[0]['BROWSER'];
  COMPARISON_TASKS?: { idFromName(name: string): { toString(): string }; get(id: unknown): {
    release(seal: ComparisonReleaseSeal): Promise<unknown>;
    readReviewArchive(taskId: string): ReturnType<typeof readComparisonReviewArchive>;
  } };
  COMPARISON_DATABASE_ID?: string;
  COMPARISON_AUTHORITY?: Authority;
  COMPARISON_WORKER_VERSION?: { id: string };
  COMPARISON_DEPLOYED_RUNTIME?: Options['runtime'] & { bundleSha256: string };
  COMPARISON_SERVICE_CONTEXT?: ComparisonServiceContext;
  COMPARISON_SERVICE_AUTH?: string;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const taskPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const archivedA = '8afbf81c85c785f5d2d071dda9ecedba510b42ab';
function need(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const deny = () => new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
export default { fetch: deny };

function checkedSeal(value: ComparisonReleaseSeal) {
  need(value && typeof value.taskId === 'string' && taskPattern.test(value.taskId) && Object.keys(value).length === 5 &&
    [value.slotSha256, value.admissionSha256, value.inputSha256, value.policySha256]
      .every(digest => typeof digest === 'string' && hash.test(digest)), 'Invalid baseline release seal');
  return { ...value };
}

function authority(env: Env) {
  const service = env.COMPARISON_AUTHORITY;
  need(service && typeof service.authorizeRelease === 'function' && typeof service.readTaskRuntime === 'function' &&
    typeof service.readFrozenInput === 'function' && typeof service.readEvidencePack === 'function' &&
    typeof service.verifyCompletedBArtifact === 'function', 'Private baseline authority is unavailable');
  return service;
}

/** Local factories can use a trapped relay; deployed bindings contain no JS callback vars. */
export function createBaselineTaskObject(ctx: { id: { toString(): string }; storage: Parameters<typeof comparisonRunnerState>[0] }, env: Env,
  fetchCandidate: (request: Request) => Promise<Response> = request => fetch(request)) {
  const capability = Object.freeze({});
  const state = comparisonRunnerState(ctx.storage);
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>) {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  }
  function exactObject(taskId: string) {
    need(taskPattern.test(taskId) && env.COMPARISON_TASKS &&
      ctx.id.toString() === env.COMPARISON_TASKS.idFromName(taskId).toString(),
    'Baseline task does not belong to this Durable Object');
  }

  async function controller(taskId: string) {
    exactObject(taskId);
    const auth = authority(env), bootstrap = await auth.readTaskRuntime(taskId), runtime = env.COMPARISON_DEPLOYED_RUNTIME;
    const version = env.COMPARISON_WORKER_VERSION?.id, databaseId = env.COMPARISON_DATABASE_ID;
    need(bootstrap && runtime && typeof version === 'string' && uuid.test(version) && version === bootstrap.workerVersion &&
      hash.test(runtime.bundleSha256) && runtime.bundleSha256 === bootstrap.bundleSha256 &&
      runtime.implementationCommit === archivedA && runtime.image === null &&
      typeof databaseId === 'string' && databaseId === bootstrap.grant.runnerDatabaseId,
    'Independently attested archived A runtime is unavailable');
    const { grant, planBytes } = bootstrap, context = env.COMPARISON_SERVICE_CONTEXT;
    const serviceAuth = env.COMPARISON_SERVICE_AUTH;
    need(context && typeof serviceAuth === 'string' && hash.test(serviceAuth) && context.runnerDatabaseId === databaseId &&
      context.runnerGrantSha256 === await harnessHash(canonicalHarness(grant)) &&
      context.authorizationSha256 === grant.authorizationSha256 && context.dispatchGrantSha256 === grant.dispatchGrantSha256 &&
      context.planSha256 === grant.planSha256 && context.manifestSha256 === grant.manifestSha256 &&
      context.notBefore === grant.notBefore && context.deadlineAt === grant.deadlineAt && context.taskIds.includes(taskId),
    'Signed baseline candidate transport is unavailable for this grant');
    const client = createComparisonServiceClient({ context, authKey: serviceAuth, fetcher(request) {
      need(request.url === COMPARISON_SERVICE_ORIGIN + COMPARISON_SERVICE_BASELINE_PATH && request.method === 'POST' &&
        request.redirect === 'manual', 'Baseline may only use the fixed signed candidate route');
      return fetchCandidate(request);
    } });
    return openComparisonTaskControl({ authority: capability, grant, planBytes,
      runtime: { implementationCommit: runtime.implementationCommit, runtimeTreeSha256: runtime.runtimeTreeSha256, image: null },
      database: { scope: 'isolated-comparison', id: databaseId, connection: env.DB },
      loadFrozenInput: digest => auth.readFrozenInput(taskId, digest), loadEvidencePack: identity => auth.readEvidencePack(taskId, identity),
      captureCreation: env.BROWSER ? captureFor({ DB: env.DB, BROWSER: env.BROWSER, creationCaptureStrict: true }) : undefined,
      baseline: {
        verifyBArtifact: input => auth.verifyCompletedBArtifact(input),
        verifyCheckpointProfile: verifyBaselineCheckpointProfile,
        async run({ scope, profile, state, env, allowForward }) {
          const adapter = await createBaselineTaskAdapter(scope, profile, (identity, url, init) => {
            need(allowForward && Date.now() < grant.deadlineAt && identity.taskId === taskId,
              'Baseline model forwarding is blocked for this invocation');
            return client.forwardBaseline(identity, url, init, context.candidateVersion);
          });
          if (scope.operation === 'creation') return adapter.creationPipelineAlarm(state, env);
          return adapter.cloudReviewAlarm(state, env);
        },
      },
    });
  }

  return {
    release(input: ComparisonReleaseSeal) {
      const seal = checkedSeal(input);
      return serial(async () => {
        exactObject(seal.taskId);
        need(await authority(env).authorizeRelease(seal) === true, 'Private baseline authority refused release');
        const control = await controller(seal.taskId);
        await ctx.storage.transaction(async tx => {
          const previous = await tx.get(comparisonBoundTaskKey);
          need(previous === undefined || previous === seal.taskId, 'Baseline object is already bound to another task');
          if (previous === undefined) await tx.put(comparisonBoundTaskKey, seal.taskId);
        });
        const result = await control.release(capability, seal);
        if (await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 100);
        return result;
      });
    },
    readReviewArchive(taskId: string) {
      exactObject(taskId);
      return readComparisonReviewArchive(ctx.storage, taskId);
    },
    alarm() {
      return serial(async () => {
        const taskId = await ctx.storage.get<string>(comparisonBoundTaskKey);
        if (taskId === undefined) return;
        const control = await controller(taskId);
        await verifyComparisonReviewCheckpoint(ctx.storage, taskId);
        // An expired grant retains checkpoints for separate verified recovery.
        await control.bindTask(capability, taskId, state).alarm();
      });
    },
  };
}

export class ComparisonTaskControl extends WorkerEntrypoint<Env> {
  fetch() { return deny(); }
  async release(input: ComparisonReleaseSeal) {
    const seal = checkedSeal(input);
    authority(this.env);
    need(this.env.COMPARISON_TASKS, 'Private baseline task namespace is unavailable');
    return this.env.COMPARISON_TASKS.get(this.env.COMPARISON_TASKS.idFromName(seal.taskId)).release(seal);
  }
  readReviewArchive(taskId: string) {
    const tasks = this.env.COMPARISON_TASKS;
    need(typeof taskId === 'string' && taskPattern.test(taskId) && tasks, 'Private baseline task namespace is unavailable');
    return tasks.get(tasks.idFromName(taskId)).readReviewArchive(taskId);
  }
}

export class ComparisonTaskRunner extends DurableObject<Env> {
  #task: ReturnType<typeof createBaselineTaskObject>;
  constructor(ctx: ConstructorParameters<typeof createBaselineTaskObject>[0], env: Env) {
    super(ctx, env);
    this.#task = createBaselineTaskObject(ctx, env);
  }
  fetch() { return deny(); }
  release(seal: ComparisonReleaseSeal) { return this.#task.release(seal); }
  readReviewArchive(taskId: string) { return this.#task.readReviewArchive(taskId); }
  alarm() { return this.#task.alarm(); }
}
`;
