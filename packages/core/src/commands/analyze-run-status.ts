import { activeCompletedBaselineId, readLatest } from '../lib/analysis-store.js';
import { inspectLatestAnalyzeRun, type AnalyzeRunView } from '../lib/analyze-run-journal.js';

export type {
  AnalyzeRunResumeAvailability,
  AnalyzeRunResumeUnavailableReason,
} from '../lib/analyze-run-journal.js';

export interface ActiveCompletedAnalysisStatus {
  analysisId: string;
  createdAt: string;
  branch: string | null;
  commitHash: string | null;
}

export interface AnalyzeRunStatus {
  /** Most recent attempted run, including incomplete durable progress. */
  latestAttempt: AnalyzeRunView | null;
  /** Canonical completed findings baseline used by existing consumers. */
  activeCompletedAnalysis: ActiveCompletedAnalysisStatus | null;
}

export interface AnalyzeResetClock {
  waitUntil(resetAtMs: number, signal: AbortSignal): Promise<void>;
}

export interface AnalyzeRunResetWaitNotice {
  runId: string;
  resetAt: string;
  completed: number;
  pending: number;
  activeCompletedAnalysisId: string | null;
}

export interface AnalyzeRunResetWaitOptions {
  signal?: AbortSignal;
  clock?: AnalyzeResetClock;
  inspectStatus?: typeof readAnalyzeRunStatus;
  onWait?: (notice: AnalyzeRunResetWaitNotice) => void;
}

export type AnalyzeRunResetWaitUnavailableReason =
  | 'not-latest-attempt'
  | 'resume-unavailable'
  | 'reset-time-uncertified'
  | 'attempt-changed';

export class AnalyzeRunResetWaitUnavailableError extends Error {
  constructor(
    readonly reason: AnalyzeRunResetWaitUnavailableReason,
    readonly runId: string,
  ) {
    super(resetWaitUnavailableMessage(reason, runId));
    this.name = 'AnalyzeRunResetWaitUnavailableError';
  }
}

/**
 * Read attempted-run progress without treating partial findings as completed truth.
 * The two durable pointers are read concurrently, so this is an eventually consistent status view.
 */
export async function readAnalyzeRunStatus(repositoryKey: string): Promise<AnalyzeRunStatus> {
  const [latestAttempt, latest] = await Promise.all([
    inspectLatestAnalyzeRun(repositoryKey),
    readLatest(repositoryKey),
  ]);
  let activeCompletedId: string | null = null;
  if (latest !== null) {
    try {
      activeCompletedId = activeCompletedBaselineId(latest);
    } catch (cause) {
      throw new Error(
        'Cannot report an active completed analysis because LATEST.json is not valid completed truth',
        { cause },
      );
    }
  }
  const visibleLatestAttempt = latestAttempt !== null
    && latestAttempt.rearm !== null
    && activeCompletedId !== null
    && latestAttempt.completedBaselineId !== activeCompletedId
    ? { ...latestAttempt, rearm: null }
    : latestAttempt;
  return {
    latestAttempt: visibleLatestAttempt,
    activeCompletedAnalysis: latest && activeCompletedId
      ? {
          analysisId: activeCompletedId,
          createdAt: latest.analysis.createdAt,
          branch: latest.analysis.branch,
          commitHash: latest.analysis.commitHash,
        }
      : null,
  };
}

/**
 * Wait read-only for one exact attempted run's certified reset time.
 * Provider construction, Resume activation, and all journal writes remain post-wake work.
 */
export async function waitForAnalyzeRunReset(
  repositoryKey: string,
  runId: string,
  options: AnalyzeRunResetWaitOptions = {},
): Promise<AnalyzeRunStatus> {
  const inspectStatus = options.inspectStatus ?? readAnalyzeRunStatus;
  const signal = options.signal ?? new AbortController().signal;
  const initial = await inspectStatus(repositoryKey);
  signal.throwIfAborted();
  const attempt = requireSelectedAttempt(initial, runId);
  if (attempt.counts.pending === 0) return initial;
  const reset = requireCertifiedReset(attempt, runId);
  const clock = options.clock ?? systemAnalyzeResetClock;

  options.onWait?.({
    runId,
    resetAt: reset.resetAt,
    completed: attempt.counts.succeeded,
    pending: attempt.counts.pending,
    activeCompletedAnalysisId: initial.activeCompletedAnalysis?.analysisId ?? null,
  });
  await clock.waitUntil(reset.resetAtMs, signal);
  signal.throwIfAborted();

  const refreshed = await inspectStatus(repositoryKey);
  signal.throwIfAborted();
  const current = refreshed.latestAttempt;
  if (
    current === null
    || current.runId !== runId
    || current.revision !== attempt.revision
    || !sameProviderLimit(current.lastProviderLimit, reset.evidence)
  ) {
    throw new AnalyzeRunResetWaitUnavailableError('attempt-changed', runId);
  }
  requireCertifiedReset(requireSelectedAttempt(refreshed, runId), runId);
  return refreshed;
}

function requireSelectedAttempt(status: AnalyzeRunStatus, runId: string) {
  const attempt = status.latestAttempt;
  if (attempt === null || attempt.runId !== runId) {
    throw new AnalyzeRunResetWaitUnavailableError('not-latest-attempt', runId);
  }
  if (attempt.counts === null) {
    throw new AnalyzeRunResetWaitUnavailableError('resume-unavailable', runId);
  }
  return attempt as typeof attempt & { counts: NonNullable<typeof attempt.counts> };
}

function requireCertifiedReset(
  attempt: ReturnType<typeof requireSelectedAttempt>,
  runId: string,
) {
  if (!attempt.resume.available) {
    throw new AnalyzeRunResetWaitUnavailableError('resume-unavailable', runId);
  }
  const evidence = attempt.lastProviderLimit;
  const resetAt = evidence?.resetAt ?? null;
  const resetAtMs = resetAt === null ? Number.NaN : Date.parse(resetAt);
  if (evidence === null || resetAt === null || !Number.isFinite(resetAtMs)) {
    throw new AnalyzeRunResetWaitUnavailableError('reset-time-uncertified', runId);
  }
  return { evidence, resetAt, resetAtMs };
}

function sameProviderLimit(
  current: AnalyzeRunView['lastProviderLimit'],
  expected: NonNullable<AnalyzeRunView['lastProviderLimit']>,
): boolean {
  return current !== null
    && current.reason === expected.reason
    && current.resetHint === expected.resetHint
    && current.blockedAt === expected.blockedAt
    && current.resetAt === expected.resetAt;
}

const systemAnalyzeResetClock: AnalyzeResetClock = {
  waitUntil(resetAtMs, signal) {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
      };
      const arm = () => {
        const remaining = resetAtMs - Date.now();
        if (remaining <= 0) {
          finish();
          return;
        }
        timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      arm();
    });
  },
};

function resetWaitUnavailableMessage(
  reason: AnalyzeRunResetWaitUnavailableReason,
  runId: string,
): string {
  switch (reason) {
    case 'not-latest-attempt':
      return `Analyze Resume cannot wait because ${runId} is not the exact latest attempt`;
    case 'resume-unavailable':
      return `Analyze Resume cannot wait because run ${runId} is no longer resumable`;
    case 'reset-time-uncertified':
      return `Analyze Resume cannot wait for run ${runId}: the provider reset time is not certified`;
    case 'attempt-changed':
      return `Analyze Resume stopped because run ${runId} changed while waiting; Claude was not contacted`;
  }
}
