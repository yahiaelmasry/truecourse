/**
 * Thin wrapper over `analyzeCore` + `persistFullAnalysis`. Exists for
 * backwards compatibility — CLI and routes import `analyzeInProcess` from
 * `@truecourse/core/commands/analyze-in-process`, and this keeps that surface stable even as
 * the internal split becomes core-compute vs mode-specific-persist.
 */

import {
  readLatest,
  removeFromHistory,
} from '../lib/analysis-store.js';
import type { RegistryEntry } from '../config/registry.js';
import type { LLMProvider } from '../services/llm/provider.js';
import type { LlmTransport } from '@truecourse/shared/llm';
import type { StepTracker } from '../progress.js';
import {
  analyzeCoreAndFinalize,
  type AnalyzeCoreResult,
  type LlmEstimate,
} from './analyze-core.js';
import {
  createAnalyzeCoreRearmAuthorization,
  type AnalyzeCoreRearmAuthorization,
} from '../lib/analyze-core-rearm-authorization.js';
import {
  buildFullAnalysisFinalizationPlan,
  persistFullAnalysis,
  type PersistFullResult,
} from './analyze-persist.js';
import {
  beginPreparedAnalyzeRunFinalization,
  dispatchAnalyzeRun,
  readAnalyzeRun,
} from '../lib/analyze-run-journal.js';
import { finalizePreparedAnalyzeRun } from '../lib/analyze-run-finalization.js';
import {
  CertifiedViolationResumeUnavailableError,
  JournaledAnalyzeSessionLimitError,
} from '../services/llm/certified-violation-phase.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import {
  isLlmSessionLimitError,
  LlmSessionLimitError,
} from '@truecourse/shared/llm';
import {
  bucketDuration,
  bucketFileCount,
  detectLanguages,
  trackEvent,
  type TelemetrySource,
} from '../services/telemetry.service.js';
import {
  readAnalyzeRunStatus,
  type AnalyzeRunStatus,
} from './analyze-run-status.js';
import type { AnalyzeRunAmbiguousRearmConsent } from '../lib/analyze-run-ambiguous-rearm.js';

export type { LlmEstimate };
export type {
  AnalyzeRunAmbiguousRearmConsent,
  AnalyzeRunAmbiguousRearmEvidence,
  AnalyzeRunAmbiguousRearmOffer,
} from '../lib/analyze-run-ambiguous-rearm.js';

export type LatestAttemptExpectation =
  | Readonly<{ kind: 'none-incomplete' }>
  | Readonly<{ kind: 'abandon'; runId: string }>;

export type AnalysisStartBlockedReason =
  | 'resume-required'
  | 'recovery-required'
  | 'resume-execution-ambiguous'
  | 'abandon-confirmation-required'
  | 'expectation-changed';

export class AnalysisStartBlockedError extends Error {
  constructor(
    readonly reason: AnalysisStartBlockedReason,
    readonly runId: string | null,
  ) {
    super(`Analysis start blocked: ${reason}${runId === null ? '' : ` (${runId})`}`);
    this.name = 'AnalysisStartBlockedError';
  }
}

export type AnalyzeStartDisposition =
  | Readonly<{
      kind: 'clear';
      reason: 'no-incomplete-attempt' | 'run-completed' | 'attempt-superseded';
    }>
  | Readonly<{ kind: 'abandonable'; runId: string }>
  | Readonly<{
      kind: 'blocked';
      reason: 'resume-execution-ambiguous' | 'recovery-required';
      runId: string;
    }>;

/**
 * Classify whether a new full analysis may replace the latest saved attempt.
 * Adapters use this for presentation; the lifecycle-locked start path applies
 * the same policy again before any compute or provider work begins.
 */
export function classifyAnalyzeStart(status: AnalyzeRunStatus): AnalyzeStartDisposition {
  const run = status.latestAttempt;
  if (run === null) return { kind: 'clear', reason: 'no-incomplete-attempt' };
  if (run.state === 'completed') return { kind: 'clear', reason: 'run-completed' };

  // An admitted provider call is fail-closed even if a newer baseline exists:
  // supersession cannot prove that the paid call stopped.
  if (!run.resume.available && run.resume.reason === 'resume-execution-ambiguous') {
    return { kind: 'blocked', reason: 'resume-execution-ambiguous', runId: run.runId };
  }

  const activeCompletedId = status.activeCompletedAnalysis?.analysisId ?? null;
  const superseded = activeCompletedId !== null
    && run.completedBaselineId !== activeCompletedId
    && run.candidateAnalysisId !== activeCompletedId;
  if (superseded) return { kind: 'clear', reason: 'attempt-superseded' };

  const requiresRecovery = (
    (run.resume.available && run.state !== 'blocked')
    || run.state === 'finalizing'
    || run.finalization?.persistence === 'prepared'
  );
  if (requiresRecovery) {
    return { kind: 'blocked', reason: 'recovery-required', runId: run.runId };
  }
  return { kind: 'abandonable', runId: run.runId };
}

/** Resolve an adapter's exact replacement intent against one status snapshot. */
export function resolveAnalyzeStartExpectationFromStatus(
  status: AnalyzeRunStatus,
  abandonAttemptRunId?: string,
): LatestAttemptExpectation {
  const disposition = classifyAnalyzeStart(status);
  if (disposition.kind === 'clear') {
    if (abandonAttemptRunId !== undefined) {
      throw new AnalysisStartBlockedError(
        'expectation-changed',
        status.latestAttempt?.runId ?? null,
      );
    }
    return { kind: 'none-incomplete' };
  }
  if (disposition.kind === 'blocked') {
    throw new AnalysisStartBlockedError(disposition.reason, disposition.runId);
  }
  if (abandonAttemptRunId === undefined) {
    const run = status.latestAttempt!;
    throw new AnalysisStartBlockedError(
      run.resume.available ? 'resume-required' : 'abandon-confirmation-required',
      run.runId,
    );
  }
  if (abandonAttemptRunId !== disposition.runId) {
    throw new AnalysisStartBlockedError('expectation-changed', disposition.runId);
  }
  return { kind: 'abandon', runId: disposition.runId };
}

export interface AnalyzeInProcessOptions {
  /**
   * Where the code lives (defaults to `project.path`). The hosted edition sets
   * this to a clone so storage keys off `project.path` (the repo identity) while
   * the analysis reads the cloned working tree.
   */
  codeDir?: string;
  branch?: string | null;
  commitHash?: string | null;
  /** Skip all git commands (branch detection, commit hash, diff). */
  skipGit?: boolean;
  /**
   * Analyze the working tree as-is instead of stashing dirty changes first.
   * The CLI sets this from `--no-stash` (or after the user declines the
   * stash prompt). Defaults to `false` (stash if dirty).
   */
  skipStash?: boolean;
  enabledCategoriesOverride?: string[];
  enableLlmRulesOverride?: boolean;
  tracker?: StepTracker;
  onProgress?: (progress: { detail?: string }) => void;
  onLlmEstimate?: (estimate: LlmEstimate) => Promise<boolean>;
  onLlmResolved?: (proceed: boolean) => void;
  provider?: LLMProvider;
  /** LLM transport for the auto-created provider (cli default; agent for headless). */
  transport?: LlmTransport;
  /**
   * Model for the auto-created provider, as chosen in the analyze model picker.
   * Omit to let Claude Code pick (the pre-picker behavior).
   */
  selectedModel?: string;
  signal?: AbortSignal;
  /**
   * Adapter that triggered this run. Auto-emitted in the telemetry payload so
   * we can attribute analyses to CLI vs dashboard. Omit to skip telemetry.
   */
  source?: TelemetrySource;
  /**
   * Exact incomplete latest attempt the user acknowledged replacing. Opt-in
   * adapters must obtain this from a read-only status check; core rechecks it
   * under the repository lifecycle lock before any analysis work starts.
   */
  latestAttemptExpectation?: LatestAttemptExpectation;
}

export interface ResumeAnalyzeInProcessOptions extends Pick<
  AnalyzeInProcessOptions,
  'codeDir' | 'tracker' | 'onProgress' | 'provider' | 'transport' | 'signal'
> {
  /** Exact durable attempted run selected by the user. */
  runId: string;
}

export interface RearmAnalyzeInProcessOptions extends ResumeAnalyzeInProcessOptions {
  /** Exact bounded repeat-call consent; omit only to recover already-durable consent. */
  consent?: AnalyzeRunAmbiguousRearmConsent | undefined;
}

export type AnalysisResumeUnavailableReason =
  | CertifiedViolationResumeUnavailableError['reason']
  | 'finalization-unprepared'
  | 'run-failed'
  | 'completed-analysis-not-active';

export class AnalysisResumeUnavailableError extends Error {
  constructor(
    readonly reason: AnalysisResumeUnavailableReason,
    options?: ErrorOptions,
  ) {
    super(`Analyze Resume is unavailable: ${reason}`, options);
    this.name = 'AnalysisResumeUnavailableError';
  }
}

export type AnalysisRearmUnavailableReason = AnalysisResumeUnavailableReason;

export class AnalysisRearmUnavailableError extends Error {
  constructor(
    readonly reason: AnalysisRearmUnavailableReason,
    options?: ErrorOptions,
  ) {
    super(`Analyze Rearm is unavailable: ${reason}`, options);
    this.name = 'AnalysisRearmUnavailableError';
  }
}

export type AnalyzeInProcessResult = PersistFullResult;

export class AnalysisSessionLimitError extends LlmSessionLimitError {
  readonly runId: string | null;

  constructor(error: LlmSessionLimitError) {
    super(error.resetHint);
    this.name = 'AnalysisSessionLimitError';
    this.runId = error instanceof JournaledAnalyzeSessionLimitError ? error.runId : null;
    this.message = error instanceof JournaledAnalyzeSessionLimitError
      ? `${this.message} The interrupted run was saved as the latest attempted run and any successful LLM results were checkpointed, but LATEST.json was not updated and the previous completed analysis remains unchanged. The durable attempt can be inspected and, when eligible, resumed through the core API after the provider limit resets. Starting a replacement may repeat paid calls.`
      : `${this.message} The interrupted run was not saved, so LATEST.json was not updated and any previous completed analysis remains unchanged. Successful LLM calls from this interrupted run cannot be resumed yet and may be repeated when you rerun.`;
  }
}

export async function analyzeInProcess(
  project: RegistryEntry,
  options: AnalyzeInProcessOptions = {},
): Promise<AnalyzeInProcessResult> {
  const startedAt = Date.now();
  log.info(
    `[LLM] Provider: claude-code, model: ${
      options.selectedModel || config.claudeCodeModel || 'default (chosen by Claude Code)'
    }, maxConcurrency: ${config.claudeCodeMaxConcurrency}`,
  );
  let core!: AnalyzeCoreResult;
  let result: PersistFullResult;
  const startExpectation = options.latestAttemptExpectation;
  try {
    result = await analyzeCoreAndFinalize(
      project,
      { ...options, mode: 'full', journalFullRun: true },
      async (computed) => {
        core = computed;
        const finalized = await finalizeCertifiedAnalysis(project, computed, startedAt);
        if (finalized) return finalized;
        return persistFullAnalysis(project, computed, startedAt);
      },
      startExpectation === undefined
        ? undefined
        : () => validateLatestAttemptExpectation(project.path, startExpectation),
    );
  } catch (error) {
    if (isLlmSessionLimitError(error)) throw new AnalysisSessionLimitError(error);
    throw error;
  }

  if (options.source) {
    await trackEvent('analyze', {
      source: options.source,
      mode: 'full',
      serviceCount: result.serviceCount,
      fileCountRange: bucketFileCount(result.fileCount),
      languages: detectLanguages(core.analysisResult),
      architecture: result.architecture,
      durationRange: bucketDuration(result.durationMs),
    });
  }

  return result;
}

async function validateLatestAttemptExpectation(
  repositoryKey: string,
  expectation: LatestAttemptExpectation,
): Promise<Readonly<{ handled: false }>> {
  const status = await readAnalyzeRunStatus(repositoryKey);
  const disposition = classifyAnalyzeStart(status);
  if (disposition.kind === 'blocked' && disposition.reason === 'resume-execution-ambiguous') {
    throw new AnalysisStartBlockedError(disposition.reason, disposition.runId);
  }
  if (disposition.kind === 'clear') {
    if (expectation.kind === 'none-incomplete') return { handled: false };
    throw new AnalysisStartBlockedError(
      'expectation-changed',
      status.latestAttempt?.runId ?? null,
    );
  }
  if (
    expectation.kind !== 'abandon'
    || expectation.runId !== disposition.runId
  ) {
    throw new AnalysisStartBlockedError('expectation-changed', disposition.runId);
  }
  if (disposition.kind === 'blocked') {
    throw new AnalysisStartBlockedError(disposition.reason, disposition.runId);
  }
  return { handled: false };
}

/** Resume one explicitly selected durable full-analysis attempt. */
export async function resumeAnalyzeInProcess(
  project: RegistryEntry,
  options: ResumeAnalyzeInProcessOptions,
): Promise<AnalyzeInProcessResult> {
  return recoverAnalyzeInProcess(project, options, {
    kind: 'resume',
    runId: options.runId,
  }, 'resume');
}

/** Rearm one explicitly selected ambiguous full-analysis attempt. */
export async function rearmAnalyzeInProcess(
  project: RegistryEntry,
  options: RearmAnalyzeInProcessOptions,
): Promise<AnalyzeInProcessResult> {
  return recoverAnalyzeInProcess(project, options, {
    kind: 'rearm',
    authorization: createAnalyzeCoreRearmAuthorization({
      runId: options.runId,
      consent: options.consent,
    }),
  }, 'rearm');
}

type AnalyzeRecoverySelection =
  | Readonly<{ kind: 'resume'; runId: string }>
  | Readonly<{ kind: 'rearm'; authorization: AnalyzeCoreRearmAuthorization }>;

async function recoverAnalyzeInProcess(
  project: RegistryEntry,
  options: ResumeAnalyzeInProcessOptions,
  selection: AnalyzeRecoverySelection,
  recoveryKind: 'resume' | 'rearm',
): Promise<AnalyzeInProcessResult> {
  const { runId, codeDir, tracker, onProgress, provider, transport, signal } = options;
  const startedAt = Date.now();
  try {
    return await analyzeCoreAndFinalize(
      project,
      {
        skipStash: true,
        codeDir,
        tracker,
        onProgress,
        provider,
        transport,
        signal,
        mode: 'full',
        resumeFullRunId: selection.kind === 'resume' ? selection.runId : undefined,
        enableLlmRulesOverride: true,
      },
      async (computed) => {
        const finalized = await finalizeCertifiedAnalysis(project, computed, startedAt);
        if (!finalized) {
          throw new AnalysisResumeUnavailableError('work-plan-changed');
        }
        return finalized;
      },
      () => recoverPreparedAnalyzeRun(project, runId, startedAt),
      selection.kind === 'rearm' ? selection.authorization : undefined,
    );
  } catch (error) {
    if (isLlmSessionLimitError(error)) throw new AnalysisSessionLimitError(error);
    if (recoveryKind === 'rearm' && error instanceof AnalysisResumeUnavailableError) {
      throw new AnalysisRearmUnavailableError(error.reason, { cause: error });
    }
    if (error instanceof CertifiedViolationResumeUnavailableError) {
      throw recoveryKind === 'rearm'
        ? new AnalysisRearmUnavailableError(error.reason, { cause: error })
        : new AnalysisResumeUnavailableError(error.reason, { cause: error });
    }
    throw error;
  }
}

// Re-export so the route can detect and remove a specific analysis's history entry.
export { removeFromHistory };

async function finalizeCertifiedAnalysis(
  project: RegistryEntry,
  computed: AnalyzeCoreResult,
  startedAt: number,
): Promise<PersistFullResult | null> {
  const certified = computed.pipelineResult.certifiedLlmExecution;
  if (!certified) return null;
  try {
    const plan = buildFullAnalysisFinalizationPlan(project, computed);
    const executedAttempt = await readAnalyzeRun(project.path, { runId: certified.runId });
    const finalizingAt = timestampAtOrAfter(executedAttempt?.updatedAt ?? computed.now);
    const preparedAt = timestampAtOrAfter(finalizingAt);
    await beginPreparedAnalyzeRunFinalization(project.path, {
      runId: certified.runId,
      finalizingAt,
      preparedAt,
      promotion: plan.promotion,
      projection: plan.projection,
    }, certified.completion);
    await finalizePreparedAnalyzeRun(project.path, {
      runId: certified.runId,
      completedAt: timestampAtOrAfter(preparedAt),
    });
    return {
      ...plan.result,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const attempted = await readAnalyzeRun(
      project.path,
      { runId: certified.runId },
    ).catch(() => null);
    const recoverable = attempted?.finalization?.persistence === 'prepared';
    if (
      attempted
      && !recoverable
      && (attempted.state === 'running' || attempted.state === 'finalizing')
    ) {
      await dispatchAnalyzeRun(project.path, {
        kind: 'fail',
        runId: certified.runId,
        failedAt: timestampAtOrAfter(attempted.updatedAt),
        error: {
          code: 'ANALYZE_FINALIZATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    throw error;
  }
}

async function recoverPreparedAnalyzeRun(
  project: RegistryEntry,
  runId: string,
  startedAt: number,
): Promise<
  | Readonly<{ handled: true; result: PersistFullResult }>
  | Readonly<{ handled: false }>
> {
  const attempted = await readAnalyzeRun(project.path, { runId });
  if (!attempted) throw new AnalysisResumeUnavailableError('run-not-found');
  const latestAttempt = await readAnalyzeRun(project.path, 'latest-attempt');
  if (latestAttempt?.runId !== runId) {
    throw new AnalysisResumeUnavailableError('not-latest-attempt');
  }
  if (attempted.state === 'completed') {
    return {
      handled: true,
      result: await completedAnalyzeResult(project.path, attempted.candidateAnalysisId, startedAt),
    };
  }
  if (attempted.state === 'finalizing') {
    if (attempted.finalization?.persistence !== 'prepared') {
      throw new AnalysisResumeUnavailableError('finalization-unprepared');
    }
    await finalizePreparedAnalyzeRun(project.path, {
      runId,
      completedAt: timestampAtOrAfter(attempted.updatedAt),
    });
    return {
      handled: true,
      result: await completedAnalyzeResult(project.path, attempted.candidateAnalysisId, startedAt),
    };
  }
  if (attempted.state === 'failed') {
    throw new AnalysisResumeUnavailableError('run-failed');
  }
  return { handled: false };
}

async function completedAnalyzeResult(
  repositoryKey: string,
  analysisId: string,
  startedAt: number,
): Promise<PersistFullResult> {
  const latest = await readLatest(repositoryKey);
  if (!latest || latest.analysis.id !== analysisId) {
    throw new AnalysisResumeUnavailableError('completed-analysis-not-active');
  }
  const bySeverity: Record<string, number> = {};
  for (const violation of latest.violations) {
    bySeverity[violation.severity] = (bySeverity[violation.severity] ?? 0) + 1;
  }
  const analyzedFiles = latest.analysis.metadata?.analyzedFiles;
  const fileCount = typeof analyzedFiles === 'number'
    && Number.isSafeInteger(analyzedFiles)
    && analyzedFiles >= 0
    ? analyzedFiles
    : new Set(latest.graph.modules.map((module) => module.filePath)).size;
  return {
    analysisId,
    filename: latest.head,
    serviceCount: latest.graph.services.length,
    fileCount,
    architecture: latest.analysis.architecture,
    durationMs: Date.now() - startedAt,
    violationsSummary: {
      total: latest.violations.length,
      bySeverity,
    },
  };
}

function timestampAtOrAfter(notBefore: string): string {
  return new Date(Math.max(Date.now(), Date.parse(notBefore))).toISOString();
}
