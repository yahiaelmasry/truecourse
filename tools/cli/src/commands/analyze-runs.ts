import {
  readAnalyzeRunStatus,
  type AnalyzeRunStatus,
  type AnalyzeRunResumeUnavailableReason,
} from '@truecourse/core/commands/analyze-run-status';
import {
  AnalysisStartBlockedError,
  type LatestAttemptExpectation,
} from '@truecourse/core/commands/analyze-in-process';
import { resolveRepoDir } from '@truecourse/core/config/paths';

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

/** Print the latest attempted run and completed baseline without mutating either. */
export async function runAnalyzeStatus(options: AnalyzeStatusOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryKey = resolveRepoDir(cwd) ?? cwd;
  const status = await readAnalyzeRunStatus(repositoryKey);
  const writeLine = options.writeLine ?? console.log;
  for (const line of formatAnalyzeRunStatus(status)) writeLine(line);
}

/** Resolve user intent before core atomically rechecks it under the lifecycle lock. */
export async function resolveAnalyzeStartExpectation(
  options: AnalyzeStartExpectationOptions,
): Promise<LatestAttemptExpectation | null> {
  const status = await (options.readStatus ?? readAnalyzeRunStatus)(options.repositoryKey);
  const run = status.latestAttempt;
  if (run === null || run.state === 'completed') {
    if (options.abandonAttemptRunId) {
      throw new AnalysisStartBlockedError('expectation-changed', run?.runId ?? null);
    }
    return { kind: 'none-incomplete' };
  }
  if (!run.resume.available && run.resume.reason === 'resume-execution-ambiguous') {
    throw new AnalysisStartBlockedError('resume-execution-ambiguous', run.runId);
  }
  if (attemptWasSuperseded(status)) {
    if (options.abandonAttemptRunId) {
      throw new AnalysisStartBlockedError('expectation-changed', run.runId);
    }
    return { kind: 'none-incomplete' };
  }
  if (requiresRecoveryBeforeReplacement(status)) {
    throw new AnalysisStartBlockedError('recovery-required', run.runId);
  }
  if (options.abandonAttemptRunId) {
    if (options.abandonAttemptRunId !== run.runId) {
      throw new AnalysisStartBlockedError('expectation-changed', run.runId);
    }
    return { kind: 'abandon', runId: run.runId };
  }
  if (run.resume.available) {
    throw new AnalysisStartBlockedError('resume-required', run.runId);
  }
  if (!options.interactive) {
    throw new AnalysisStartBlockedError('abandon-confirmation-required', run.runId);
  }

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
    }
    if (!run.resume.available && run.resume.reason === 'resume-execution-ambiguous') {
      lines.push(`Resume: unavailable — ${resumeUnavailableMessage(run.resume.reason)}`);
    } else if (attemptWasSuperseded(status)) {
      lines.push('Resume: unavailable — a newer completed analysis is active');
    } else if (run.resume.available) {
      const timing = run.state === 'blocked' ? ' after the provider reset' : '';
      lines.push(
        `Resume: structurally available${timing} and full revalidation; the CLI action is not available in this version`,
      );
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
      return `Saved attempted run ${selected} is structurally resumable. Inspect it with truecourse analyze status. CLI Resume is not available in this version; to explicitly start over, use --abandon-attempt ${selected}. Paid LLM calls may repeat.`;
    case 'recovery-required':
      return `Saved attempted run ${selected} has durable recovery or finalization work that must finish before another analysis starts. Inspect it with truecourse analyze status. The CLI Resume action is not available in this version; starting over is not offered because completed projections may need repair.`;
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

function requiresRecoveryBeforeReplacement(status: AnalyzeRunStatus): boolean {
  const run = status.latestAttempt;
  if (run === null || run.state === 'completed') return false;
  return (run.resume.available && run.state !== 'blocked')
    || run.finalization?.persistence === 'prepared';
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
