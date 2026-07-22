import path from 'node:path';
import {
  AnalyzeRunResetWaitUnavailableError,
  readAnalyzeRunStatus,
  waitForAnalyzeRunReset,
  type AnalyzeRunStatus,
  type AnalyzeRunResumeUnavailableReason,
} from '@truecourse/core/commands/analyze-run-status';
import {
  AnalysisResumeUnavailableError,
  AnalysisSessionLimitError,
  AnalysisStartBlockedError,
  resolveAnalyzeStartExpectationFromStatus,
  type AnalyzeInProcessResult,
  type LatestAttemptExpectation,
  type ResumeAnalyzeInProcessOptions,
} from '@truecourse/core/commands/analyze-in-process';
import { resolveRepoDir } from '@truecourse/core/config/paths';
import type { RegistryEntry } from '@truecourse/core/config/registry';
import { closeLogger, configureLogger, log } from '@truecourse/core/lib/logger';

export interface AnalyzeStatusOptions {
  cwd?: string;
  writeLine?: (line: string) => void;
}

export interface AnalyzeStartExpectationOptions {
  repositoryKey: string;
  abandonAttemptRunId?: string;
  interactive: boolean;
  readStatus?: typeof readAnalyzeRunStatus;
  confirmAbandon: (message: string) => Promise<boolean>;
}

export interface AnalyzeResumeOptions extends AnalyzeStatusOptions {
  /** Keep this CLI process open until the journal-certified provider reset. */
  waitForReset?: boolean;
  signal?: AbortSignal;
  waitForResetAction?: typeof waitForAnalyzeRunReset;
  readStatus?: typeof readAnalyzeRunStatus;
  registerProject?: (repoPath: string) => Promise<RegistryEntry>;
  configureDiagnostics?: typeof configureLogger;
  resume?: (
    project: RegistryEntry,
    options: ResumeAnalyzeInProcessOptions,
  ) => Promise<AnalyzeInProcessResult>;
}

export type AnalyzeResumeCliFailureReason =
  | AnalyzeRunResumeUnavailableReason
  | 'run-not-found'
  | 'not-latest-attempt'
  | 'completed-analysis-not-active'
  | 'diagnostics-unavailable'
  | 'execution-failed';

export class AnalyzeResumeCliError extends Error {
  constructor(
    readonly reason: AnalyzeResumeCliFailureReason,
    options?: ErrorOptions,
  ) {
    super(resumeCliFailureMessage(reason), options);
    this.name = 'AnalyzeResumeCliError';
  }
}

/** Print the latest attempted run and completed baseline without mutating either. */
export async function runAnalyzeStatus(options: AnalyzeStatusOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryKey = resolveRepoDir(cwd) ?? cwd;
  const status = await readAnalyzeRunStatus(repositoryKey);
  const writeLine = options.writeLine ?? console.log;
  for (const line of formatAnalyzeRunStatus(status)) writeLine(line);
}

/** Resume one exact latest attempted run; core revalidates before provider admission. */
export async function runAnalyzeResume(
  runId: string,
  options: AnalyzeResumeOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryKey = resolveRepoDir(cwd) ?? cwd;
  let loggerConfigured = false;
  try {
    (options.configureDiagnostics ?? configureLogger)({
      filePath: path.join(repositoryKey, '.truecourse', 'logs', 'analyze.log'),
    });
    loggerConfigured = true;
  } catch (error) {
    throw new AnalyzeResumeCliError('diagnostics-unavailable', { cause: error });
  }
  try {
    const readStatus = options.readStatus ?? readAnalyzeRunStatus;
    let waited = false;
    const status = options.waitForReset
      ? await waitForResetBeforeResume(repositoryKey, runId, options, (notice) => {
          waited = true;
          const baseline = notice.activeCompletedAnalysisId ?? 'none';
          const completed = notice.completed;
          const pending = notice.pending;
          (options.writeLine ?? console.log)(
            `Waiting to resume exact run ${runId} until certified provider reset ${notice.resetAt}. Saved run contains ${completed} durable successful LLM ${plural(completed, 'checkpoint')}; ${pending} pending ${plural(pending, 'check')} ${pending === 1 ? 'remains' : 'remain'}. Active completed analysis ${baseline} stays canonical. Claude will not be contacted before reset. Press Ctrl+C to cancel this process-bound wait.`,
          );
        })
      : await readStatus(repositoryKey);
    if (waited) {
      (options.writeLine ?? console.log)(
        'Certified provider reset reached. Exact run identity, journal revision, and reset evidence were unchanged; continuing with normal Resume revalidation.',
      );
    }
    const run = selectAnalyzeResumeRun(status, runId);
    const writeLine = options.writeLine ?? console.log;
    const completed = run.counts!.succeeded;
    const pending = run.counts!.pending;
    const baseline = status.activeCompletedAnalysis?.analysisId ?? 'none';

    writeLine(`Resume requested for exact run ${runId}.`);
    writeLine(
      `Saved run contains ${completed} durable successful LLM ${plural(completed, 'checkpoint')}; ${pending} pending ${plural(pending, 'check')} ${pending === 1 ? 'remains' : 'remain'}. Active completed analysis ${baseline} stays canonical until Resume finishes.`,
    );
    if (run.lastProviderLimit) {
      writeLine(
        `Provider reset report: ${run.lastProviderLimit.resetHint} (advisory; the provider remains authoritative).`,
      );
    }
    if (pending > 0) {
      writeLine(
        'Revalidating repository, completed baseline, rules, configuration, prompts/schemas, provider, and model before pending work is admitted.',
      );
    } else {
      writeLine('No provider calls are pending; recovering durable execution/finalization state.');
    }

    const register = options.registerProject
      ?? (await import('@truecourse/core/config/registry')).registerProject;
    const resume = options.resume
      ?? (await import('@truecourse/core/commands/analyze-in-process')).resumeAnalyzeInProcess;
    const project = await register(repositoryKey);
    const result = await resume(project, {
      runId,
      onProgress: (progress) => {
        if (progress.detail) writeLine(`Resume: ${progress.detail}`);
      },
    });
    if (completed > 0) {
      writeLine(
        `Revalidated and reused ${completed} successful LLM ${plural(completed, 'checkpoint')}.`,
      );
    }
    writeLine(`Resume complete: ${result.analysisId} is now the active completed analysis.`);
  } catch (error) {
    if (
      error instanceof AnalyzeResumeCliError
      || error instanceof AnalysisResumeUnavailableError
      || error instanceof AnalysisSessionLimitError
      || error instanceof AnalyzeRunResetWaitUnavailableError
      || isAbortError(error)
    ) {
      throw error;
    }
    try {
      log.error(`[CLI] Analysis Resume failed: ${localFailureDiagnostic(error)}`, error);
    } catch {
      // Diagnostic failure must not expose or replace the original failure.
    }
    throw new AnalyzeResumeCliError('execution-failed', { cause: error });
  } finally {
    if (loggerConfigured) {
      try {
        await closeLogger();
      } catch {
        // Closing diagnostics must not replace the Resume result or failure.
      }
    }
  }
}

async function waitForResetBeforeResume(
  repositoryKey: string,
  runId: string,
  options: AnalyzeResumeOptions,
  onWait: NonNullable<Parameters<typeof waitForAnalyzeRunReset>[2]>['onWait'],
): Promise<AnalyzeRunStatus> {
  const controller = options.signal ? null : new AbortController();
  const signal = options.signal ?? controller!.signal;
  const onSigint = () => {
    controller!.abort(new DOMException('Analysis Resume wait cancelled', 'AbortError'));
  };
  if (controller) process.once('SIGINT', onSigint);
  try {
    return await (options.waitForResetAction ?? waitForAnalyzeRunReset)(repositoryKey, runId, {
      signal,
      onWait,
    });
  } finally {
    if (controller) process.removeListener('SIGINT', onSigint);
  }
}

/** Resolve user intent before core atomically rechecks it under the lifecycle lock. */
export async function resolveAnalyzeStartExpectation(
  options: AnalyzeStartExpectationOptions,
): Promise<LatestAttemptExpectation | null> {
  const status = await (options.readStatus ?? readAnalyzeRunStatus)(options.repositoryKey);
  try {
    return resolveAnalyzeStartExpectationFromStatus(status, options.abandonAttemptRunId);
  } catch (error) {
    if (
      !(error instanceof AnalysisStartBlockedError)
      || error.reason !== 'abandon-confirmation-required'
      || !options.interactive
    ) {
      throw error;
    }
  }

  const run = status.latestAttempt!;
  const baseline = status.activeCompletedAnalysis?.analysisId ?? 'none';
  const confirmed = await options.confirmAbandon(
    `Paid LLM calls may repeat when starting over. Active completed analysis ${baseline} stays canonical until a new analysis succeeds. Replace attempted run ${run.runId} and start over?`,
  );
  return confirmed ? { kind: 'abandon', runId: run.runId } : null;
}

/** Compose deterministic terminal lines for attempted and completed analysis state. */
export function formatAnalyzeRunStatus(status: AnalyzeRunStatus): string[] {
  const lines: string[] = [];
  const run = status.latestAttempt;
  if (!run) {
    lines.push('Latest run: none');
  } else {
    const progress = run.counts
      ? ` · ${run.counts.succeeded}/${run.counts.total} LLM checks complete · ${run.counts.pending} pending`
      : '';
    if (attemptWasSuperseded(status)) {
      lines.push(`Latest run: completed analysis ${status.activeCompletedAnalysis!.analysisId}`);
      lines.push(`Superseded saved LLM attempt: ${run.runId} · ${run.state}${progress}`);
    } else {
      lines.push(`Latest run: ${run.runId} · ${run.state}${progress}`);
    }
    if (run.lastProviderLimit) {
      lines.push(`Provider reported reset: ${run.lastProviderLimit.resetHint} (advisory)`);
      if (run.lastProviderLimit.resetAt) {
        lines.push(`Verified reset time: ${run.lastProviderLimit.resetAt}`);
      }
    }
    if (!run.resume.available && run.resume.reason === 'resume-execution-ambiguous') {
      lines.push(`Resume: unavailable — ${resumeUnavailableMessage(run.resume.reason)}`);
    } else if (attemptWasSuperseded(status)) {
      lines.push('Resume: unavailable — a newer completed analysis is active');
    } else if (run.resume.available) {
      const timing = run.state === 'blocked' ? ' after the provider reset' : '';
      lines.push(
        `Resume: truecourse analyze resume ${run.runId}${timing} (repository, baseline, rules, configuration, prompts/schemas, provider, and model will be revalidated)`,
      );
      if (run.lastProviderLimit?.resetAt && (run.counts?.pending ?? 0) > 0) {
        lines.push(
          `Wait for reset: truecourse analyze resume ${run.runId} --wait-for-reset (cancellable; Claude is not contacted before the certified reset time)`,
        );
      }
    } else {
      lines.push(`Resume: unavailable — ${resumeUnavailableMessage(run.resume.reason)}`);
    }
  }

  const completed = status.activeCompletedAnalysis;
  if (!completed) {
    lines.push('Active completed analysis: none');
  } else {
    const branch = completed.branch ?? 'detached';
    const commit = completed.commitHash?.slice(0, 7) ?? 'unknown';
    lines.push(
      `Active completed analysis: ${completed.analysisId} · ${completed.createdAt} · ${branch}@${commit}`,
    );
  }
  return lines;
}

/** Add adapter-specific recovery guidance to the core's structured block reason. */
export function formatAnalysisStartBlockedError(error: AnalysisStartBlockedError): string {
  const selected = error.runId ?? 'the previously observed run';
  switch (error.reason) {
    case 'resume-required':
      return `Saved attempted run ${selected} is structurally resumable. Run truecourse analyze resume ${selected} to revalidate and reuse completed work. To explicitly start over instead, use --abandon-attempt ${selected}; paid LLM calls may repeat.`;
    case 'recovery-required':
      return `Saved attempted run ${selected} has durable recovery or finalization work that must finish before another analysis starts. Run truecourse analyze resume ${selected}; starting over is not offered because completed projections may need repair.`;
    case 'resume-execution-ambiguous':
      return `Saved attempted run ${selected} may still have an admitted provider call in flight. Starting over is blocked to avoid repeating a paid call.`;
    case 'abandon-confirmation-required':
      return `Saved attempted run ${selected} is incomplete. Starting over requires exact acknowledgement because paid LLM calls may repeat. Review truecourse analyze status, then use --abandon-attempt ${selected}.`;
    case 'expectation-changed':
      return `The saved attempted run changed before starting over. Review ${selected} with truecourse analyze status and try again.`;
  }
}

function attemptWasSuperseded(status: AnalyzeRunStatus): boolean {
  const run = status.latestAttempt;
  if (run === null || run.state === 'completed') return false;
  const activeCompletedId = status.activeCompletedAnalysis?.analysisId ?? null;
  return activeCompletedId !== null
    && run.completedBaselineId !== activeCompletedId
    && run.candidateAnalysisId !== activeCompletedId;
}

function selectAnalyzeResumeRun(
  status: AnalyzeRunStatus,
  runId: string,
): NonNullable<AnalyzeRunStatus['latestAttempt']> {
  const run = status.latestAttempt;
  if (run === null) throw new AnalyzeResumeCliError('run-not-found');
  if (run.runId !== runId) throw new AnalyzeResumeCliError('not-latest-attempt');

  const activeCompletedId = status.activeCompletedAnalysis?.analysisId ?? null;
  const recoveringPromotedCandidate = run.candidateAnalysisId === activeCompletedId
    && (run.state === 'finalizing' || run.state === 'completed');
  if (!recoveringPromotedCandidate && run.completedBaselineId !== activeCompletedId) {
    throw new AnalyzeResumeCliError('completed-analysis-not-active');
  }
  if (run.state !== 'completed' && !run.resume.available) {
    throw new AnalyzeResumeCliError(run.resume.reason);
  }
  if (run.counts === null) throw new AnalyzeResumeCliError('run-not-resumable');
  return run;
}

function resumeCliFailureMessage(reason: AnalyzeResumeCliFailureReason): string {
  switch (reason) {
    case 'run-not-found':
      return 'Analyze Resume requires an existing latest attempted run.';
    case 'not-latest-attempt':
      return 'Analyze Resume requires the exact latest attempted run; inspect truecourse analyze status and try again.';
    case 'completed-analysis-not-active':
      return 'Analyze Resume is unavailable because the completed-analysis baseline changed or disappeared.';
    case 'diagnostics-unavailable':
      return 'Analysis Resume could not start because local diagnostics could not be configured. No status revalidation or provider work was attempted.';
    case 'execution-failed':
      return 'Analysis Resume failed. Inspect truecourse analyze status; when local diagnostics were available, details were written to the local analyze log. The active completed analysis remains canonical unless status reports completion.';
    default:
      return `Analyze Resume is unavailable: ${resumeUnavailableMessage(reason)}`;
  }
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function localFailureDiagnostic(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'failure could not be formatted';
  }
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}

function resumeUnavailableMessage(reason: AnalyzeRunResumeUnavailableReason): string {
  switch (reason) {
    case 'successful-results-not-checkpointed':
      return 'no verified successful checkpoint can establish the original model';
    case 'checkpoint-execution-unbound':
      return 'the saved plan does not bind a provider and model request';
    case 'resume-execution-ambiguous':
      return 'a previously admitted provider call may still be incomplete';
    case 'finalization-unprepared':
      return 'the finalization plan was not durably prepared';
    case 'run-failed':
      return 'this run has failed';
    case 'run-not-resumable':
      return 'this run is not in a resumable state';
    case 'run-completed':
      return 'this run is already completed';
  }
}
