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
  return {
    latestAttempt,
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
