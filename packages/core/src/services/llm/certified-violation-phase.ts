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
  type AnalyzeLlmResumeIncompatibility,
  type AnalyzeLlmWorkProgressObserver,
  type CertifiedAnalyzeLlmWork,
} from './certified-analyze-llm-run.js';
import { executeCertifiedAnalyzeLlmResumeWithUsage } from './certified-analyze-resume-usage.js';
import { log } from '../../lib/logger.js';
import {
  materializePlannedViolationResult,
  type MaterializedPlannedViolationResult,
} from './planned-violation-result.js';
import type {
  CodeViolationContext,
  DatabaseViolationContext,
  ModuleViolationContext,
  LLMProvider,
  ServiceViolationContext,
} from './provider.js';
import type { UsageRecord } from '../../types/snapshot.js';

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

export interface CertifiedViolationResumePhaseInput extends Omit<CertifiedViolationPhaseInput, 'adapter' | 'analysisTimestamp'> {
  adapter: AnalyzeLlmExecutionAdapter & Pick<LLMProvider, 'flushUsage'>;
  activatedAt: string;
  admittedAt: string;
}

export interface CertifiedViolationResumePhaseResult extends CertifiedViolationPhaseResult {
  usage: readonly UsageRecord[];
}

export class CertifiedViolationResumeUnavailableError extends Error {
  constructor(readonly reason: AnalyzeLlmResumeIncompatibility) {
    super(`Certified analyze Resume is unavailable: ${reason}`);
    this.name = 'CertifiedViolationResumeUnavailableError';
  }
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
  const certified = certifyViolationPhase(input, input.adapter);

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
      execution: input.adapter.execution,
      work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
        workId,
        inputFingerprint,
      })),
    });
    const execution = await certified.execute(activation, input.observer);
    const results = materializeViolationPhaseResults(
      execution.results,
      input.analysisTimestamp,
    );
    return Object.freeze({
      runId: input.run.runId,
      results: Object.freeze(results),
      completion: execution.completion,
    });
  } catch (error) {
    if (begun) {
      await terminateCertifiedViolationPhase(input.run, error, input.run.startedAt);
    }
    throw error;
  }
}

/** Rebuild, revalidate, and execute one explicitly selected durable LLM Resume. */
export async function resumeCertifiedViolationPhase(
  input: CertifiedViolationResumePhaseInput,
): Promise<CertifiedViolationResumePhaseResult> {
  // Compatibility inspection chooses a concrete pinned adapter when durable
  // checkpoint evidence exists. With zero checkpoints it deliberately keeps
  // the requested-model adapter so executeResume can establish and checkpoint
  // the first concrete model before pinning the remaining work.
  const certified = certifyViolationPhase(input, input.adapter);
  const activated = await certified.activateResume({
    candidateAnalysisId: input.run.candidateAnalysisId,
    startedAt: input.run.startedAt,
    source: input.run.source,
    branch: input.run.branch,
    commitHash: input.run.commitHash,
    completedBaselineId: input.run.completedBaselineId,
  }, input.activatedAt);
  if (!activated.activated) {
    throw new CertifiedViolationResumeUnavailableError(activated.reason);
  }
  try {
    const accounted = await executeCertifiedAnalyzeLlmResumeWithUsage(
      () => certified.executeResume(activated.activation, input.admittedAt, input.observer),
      input.adapter,
    );
    const results = materializeViolationPhaseResults(
      accounted.execution.results,
      input.run.startedAt,
    );
    return Object.freeze({
      runId: input.run.runId,
      results: Object.freeze(results),
      completion: accounted.execution.completion,
      usage: accounted.usage,
    });
  } catch (error) {
    const latest = await readAnalyzeRun(input.run.repositoryKey, { runId: input.run.runId });
    const admitted = latest?.state === 'running'
      && latest.executionAttempt.resume?.admission === 'executing';
    const fullyCheckpointed = latest?.counts?.pending === 0;
    if (!admitted || fullyCheckpointed) throw error;
    return terminateCertifiedViolationPhase(input.run, error, input.admittedAt);
  }
}

function certifyViolationPhase(
  input: Pick<CertifiedViolationPhaseInput, 'run' | 'code' | 'database' | 'service' | 'module'>,
  adapter: AnalyzeLlmExecutionAdapter,
) {
  return certifyAnalyzeLlmRun({
    runId: input.run.runId,
    journalKey: input.run.repositoryKey,
    repositoryRoot: input.run.repositoryRoot,
    code: input.code,
    database: input.database,
    service: input.service,
    module: input.module,
  }, adapter);
}

function materializeViolationPhaseResults(
  outcomes: readonly {
    readonly work: CertifiedAnalyzeLlmWork;
    readonly result: unknown;
  }[],
  analysisTimestamp: string,
): readonly MaterializedPlannedViolationResult[] {
  return outcomes.map((outcome) =>
    materializePlannedViolationResult(outcome, {
      createId: randomUUID,
      createdAt: () => analysisTimestamp,
    }));
}

async function terminateCertifiedViolationPhase(
  run: CertifiedViolationPhaseRun,
  error: unknown,
  notBefore: string,
): Promise<never> {
  const latest = await readAnalyzeRun(run.repositoryKey, { runId: run.runId });
  const terminalAt = timestampAtOrAfter(latest?.updatedAt ?? notBefore);
  if (isLlmSessionLimitError(error)) {
    await dispatchAnalyzeRun(run.repositoryKey, {
      kind: 'block',
      runId: run.runId,
      blockedAt: terminalAt,
      resetHint: error.resetHint ?? 'reset time unavailable',
    });
    throw new JournaledAnalyzeSessionLimitError(error, run.runId);
  }
  try {
    log.error(
      `[LLM] Certified analyze LLM phase failed: ${localProviderFailureDiagnostic(error)}`,
      error,
    );
  } catch {
    // Diagnostics must never replace the provider failure or prevent journal termination.
  }
  await dispatchAnalyzeRun(run.repositoryKey, {
    kind: 'fail',
    runId: run.runId,
    failedAt: terminalAt,
    error: {
      code: 'ANALYZE_LLM_FAILED',
      message: 'The LLM provider failed during analysis. Check local logs for details.',
    },
  });
  throw error;
}

function localProviderFailureDiagnostic(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'provider failure could not be formatted';
  }
}

function timestampAtOrAfter(notBefore: string): string {
  return new Date(Math.max(Date.now(), Date.parse(notBefore))).toISOString();
}
