import {
  readAnalyzeRunStatus,
  type AnalyzeRunStatus,
  type AnalyzeRunResumeUnavailableReason,
} from '@truecourse/core/commands/analyze-run-status';
import { resolveRepoDir } from '@truecourse/core/config/paths';

export interface AnalyzeStatusOptions {
  cwd?: string;
  writeLine?: (line: string) => void;
}

/** Print the latest attempted run and completed baseline without mutating either. */
export async function runAnalyzeStatus(options: AnalyzeStatusOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const repositoryKey = resolveRepoDir(cwd) ?? cwd;
  const status = await readAnalyzeRunStatus(repositoryKey);
  const writeLine = options.writeLine ?? console.log;
  for (const line of formatAnalyzeRunStatus(status)) writeLine(line);
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
    lines.push(`Latest run: ${run.runId} · ${run.state}${progress}`);
    if (run.lastProviderLimit) {
      lines.push(`Provider reported reset: ${run.lastProviderLimit.resetHint} (advisory)`);
    }
    if (run.resume.available) {
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
