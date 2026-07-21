import { randomUUID } from 'node:crypto';
import type { RuleDomain } from '@truecourse/shared';
import {
  isLlmSessionLimitError,
  LlmSessionLimitError,
} from '@truecourse/shared/llm';
import {
  dispatchAnalyzeRun,
  readAnalyzeRun,
  sealAnalyzeRunPlan,
  type AnalyzeRunExecutionCompletion,
  type AnalyzeRunSource,
} from '../../lib/analyze-run-journal.js';
import {
  certifyAnalyzeLlmRun,
  type AnalyzeLlmExecutionAdapter,
  type AnalyzeLlmWorkProgressObserver,
} from './certified-analyze-llm-run.js';
import {
  materializePlannedViolationResult,
  type MaterializedPlannedViolationResult,
} from './planned-violation-result.js';
import type {
  CodeViolationContext,
  DatabaseViolationContext,
  ModuleViolationContext,
  ServiceViolationContext,
} from './provider.js';

export interface CertifiedViolationPhaseRun {
  repositoryKey: string;
  repositoryRoot: string;
  runId: string;
  candidateAnalysisId: string;
  startedAt: string;
  source: AnalyzeRunSource;
  branch: string | null;
  commitHash: string | null;
  completedBaselineId: string | null;
}

export interface CertifiedViolationPhaseInput {
  run: CertifiedViolationPhaseRun;
  analysisTimestamp: string;
  adapter: AnalyzeLlmExecutionAdapter;
  code: readonly { domain: RuleDomain; context: CodeViolationContext }[];
  database?: DatabaseViolationContext;
  service?: ServiceViolationContext;
  module?: ModuleViolationContext;
  observer?: AnalyzeLlmWorkProgressObserver;
}

export interface CertifiedViolationPhaseResult {
  runId: string;
  results: readonly MaterializedPlannedViolationResult[];
  completion: AnalyzeRunExecutionCompletion;
}

export class JournaledAnalyzeSessionLimitError extends LlmSessionLimitError {
  constructor(error: LlmSessionLimitError, readonly runId: string) {
    super(error.resetHint);
    this.name = 'JournaledAnalyzeSessionLimitError';
  }
}

/** Certify, durably activate, and execute one complete eligible LLM phase. */
export async function executeCertifiedViolationPhase(
  input: CertifiedViolationPhaseInput,
): Promise<CertifiedViolationPhaseResult> {
  const certified = certifyAnalyzeLlmRun({
    runId: input.run.runId,
    journalKey: input.run.repositoryKey,
    repositoryRoot: input.run.repositoryRoot,
    code: input.code,
    database: input.database,
    service: input.service,
    module: input.module,
  }, input.adapter);

  let begun = false;
  try {
    await dispatchAnalyzeRun(input.run.repositoryKey, {
      kind: 'begin',
      runId: input.run.runId,
      candidateAnalysisId: input.run.candidateAnalysisId,
      startedAt: input.run.startedAt,
      source: input.run.source,
      branch: input.run.branch,
      commitHash: input.run.commitHash,
      completedBaselineId: input.run.completedBaselineId,
    });
    begun = true;
    const sealedAt = timestampAtOrAfter(input.run.startedAt);
    const activation = await sealAnalyzeRunPlan(input.run.repositoryKey, {
      kind: 'seal-plan',
      runId: input.run.runId,
      sealedAt,
      work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
        workId,
        inputFingerprint,
      })),
    });
    const execution = await certified.execute(activation, input.observer);
    const results = execution.results.map((outcome) =>
      materializePlannedViolationResult(outcome, {
        createId: randomUUID,
        createdAt: () => input.analysisTimestamp,
      }));
    return Object.freeze({
      runId: input.run.runId,
      results: Object.freeze(results),
      completion: execution.completion,
    });
  } catch (error) {
    if (begun) {
      const latest = await readAnalyzeRun(input.run.repositoryKey, { runId: input.run.runId });
      const failedAt = timestampAtOrAfter(latest?.updatedAt ?? input.run.startedAt);
      if (isLlmSessionLimitError(error)) {
        await dispatchAnalyzeRun(input.run.repositoryKey, {
          kind: 'block',
          runId: input.run.runId,
          blockedAt: failedAt,
          resetHint: error.resetHint ?? 'reset time unavailable',
        });
        throw new JournaledAnalyzeSessionLimitError(error, input.run.runId);
      } else {
        await dispatchAnalyzeRun(input.run.repositoryKey, {
          kind: 'fail',
          runId: input.run.runId,
          failedAt,
          error: {
            code: 'ANALYZE_LLM_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    throw error;
  }
}

function timestampAtOrAfter(notBefore: string): string {
  return new Date(Math.max(Date.now(), Date.parse(notBefore))).toISOString();
}
