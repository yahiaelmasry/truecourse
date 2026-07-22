export type AnalyzeRunResumeUnavailableReason =
  | 'successful-results-not-checkpointed'
  | 'checkpoint-execution-unbound'
  | 'resume-execution-ambiguous'
  | 'finalization-unprepared'
  | 'run-failed'
  | 'run-not-resumable'
  | 'run-completed';

export type AnalysisActivityMode = 'analysis' | 'resume';

export interface AnalyzeResumeAcceptedResponse {
  message: 'Analysis Resume started';
  repoId: string;
  runId: string;
  mode: 'resume';
}

export type AnalyzeRunResumeStatus =
  | {
      available: true;
      scope: 'structural';
      mode: 'resume';
      requiresLatestAttempt: true;
      requiresRevalidation: true;
    }
  | {
      available: false;
      scope: 'structural';
      reason: AnalyzeRunResumeUnavailableReason;
    };

export interface AnalyzeRunStatusResponse {
  /** In-process server activity; durable attempted-run state remains authoritative. */
  activeMode: AnalysisActivityMode | null;
  /** Informational latest attempted run; actions must revalidate it before admission. */
  latestAttempt: {
    runId: string;
    state: 'running' | 'blocked' | 'failed' | 'finalizing' | 'completed';
    startedAt: string;
    updatedAt: string;
    source: 'cli' | 'dashboard' | 'hosted';
    branch: string | null;
    commitHash: string | null;
    counts: {
      total: number;
      succeeded: number;
      pending: number;
      running: number;
      failed: number;
    } | null;
    lastProviderLimit: {
      resetHint: string;
      blockedAt: string;
    } | null;
    resume: AnalyzeRunResumeStatus;
  } | null;
  /** Canonical completed findings baseline used by existing consumers. */
  activeCompletedAnalysis: {
    analysisId: string;
    createdAt: string;
    branch: string | null;
    commitHash: string | null;
  } | null;
}
