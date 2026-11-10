/** Synthetic rehearsal of the historical container path. */
import type { BaselineReviewInput } from './harness-comparison-baseline';
import { absoluteLegacyPath, runLegacyComparison } from './harness-comparison-legacy-source';

type Scenario = 'success' | 'unknown-response' | 'persist-recovery';
type Phase = 'build' | 'polish' | 'review' | 'review_verify';
type ReviewEvidence = Pick<BaselineReviewInput, 'htmlSha256' | 'probeSha256' | 'shotSha256'>;
type ReviewBindings = {
  rulesSha256: string;
  rulesContentSha256: string;
  calibrationSha256: string;
  modelConfigSha256: string;
};
type Rehearsal = {
  output: string;
  reviewInput: BaselineReviewInput;
  result: {
    schemaVersion: number;
    scope: string;
    scenario: Scenario;
    caseId: string;
    implementationCommit: string;
    policyImage: string;
    sourceVerification: {
      sourceReceiptSha256: string;
      adapterSha256: string;
      sharedFixtureSha256: string;
      runtimeTreeSha256: string;
      runtimeTreeEndSha256: string;
      verifiedTrackedRuntimeFiles: number;
    };
    engineCommit: string;
    executionAllowed: false;
    formalImportAllowed: false;
    syntheticBoundaries: string[];
    creation: {
      taskId: string;
      status: string;
      stages: { stage: 'build' | 'polish'; version_id: string; content_hash: string; input_hash: string; evidence_hash: string | null }[];
      modelContractHash: string;
      versionId: string;
      stageVersionId: string;
      sha256: string;
      disposition: string;
      path: string;
    };
    review: ReviewBindings & {
      taskId: string;
      status: string;
      draftSha256: string | null;
      finalSha256: string | null;
      evidence: ReviewEvidence;
      modelContractHash: string;
      interruptedResultUnknown: boolean;
      publicationRetried: boolean;
    };
    materialSha256: Record<string, string>;
    scriptedForwards: number;
    providerRequests: 0;
    networkOperations: 0;
    realContainers: 0;
    forwardsBeforeRecovery: number;
    failedWrites: number;
    dispatches: (Partial<ReviewBindings> & {
      scope: string;
      taskId: string;
      phase: Phase;
      requestId: string;
      destination: string;
      idempotencyKeySha256: string;
      bodySha256: string;
      model: string;
      effort: string;
      outputCap: number;
      imageSha256: string[];
      at: string;
      reviewEvidence?: ReviewEvidence;
      ledger: Record<string, string | number | null>;
    })[];
    nativeReceipts: {
      taskId: string;
      runId: string;
      phase: Phase;
      envelopeSha256: string;
      inputImageSha256: string[];
      outputCap: number;
      aggregateOutputCap: number;
      maxModelTurns: number;
      maxRepairs: number;
      state: 'succeeded' | 'failed';
    }[];
    runs: {
      task_id: string;
      status: string;
      model_turns: number;
      output_tokens: number;
      reserved_tokens: number;
      released_at: number | null;
      max_model_turns: number;
      total_output_cap: number;
    }[];
    closure: { allocations: number; destructions: number };
  };
};

export async function runHarnessRehearsal({ out, scenario = 'success' }: { out: string; scenario?: Scenario }) {
  return runLegacyComparison<Rehearsal>('rehearsal', {
    out: absoluteLegacyPath(out, 'Use a fresh private rehearsal directory'), scenario,
  });
}
