export type AnalyzeRunResumeUnavailableReason =
  | 'successful-results-not-checkpointed'
  | 'checkpoint-execution-unbound'
  | 'resume-execution-ambiguous'
  | 'finalization-unprepared'
  | 'run-failed'
  | 'run-not-resumable'
  | 'run-completed';

export type AnalysisActivityMode = 'analysis' | 'resume' | 'rearm';

export interface AnalyzeResumeAcceptedResponse {
  message: 'Analysis Resume started';
  repoId: string;
  runId: string;
  mode: 'resume';
}

export interface AnalyzeRearmAcceptedResponse {
  message: 'Analysis Rearm started';
  repoId: string;
  runId: string;
  mode: 'rearm';
}

export interface AnalyzeRunAmbiguousRearmEvidence {
  runId: string;
  runRevision: number;
  executionEpoch: {
    kind: 'initial' | 'resume';
    attemptNumber: number;
    activatedAt: string;
  };
  admittedAt: string;
  pendingWorkCount: number;
}

export interface AnalyzeRunAmbiguousRearmOffer {
  scope: 'structural';
  mode: 'rearm-ambiguous-execution';
  requiresLatestAttempt: true;
  requiresRevalidation: true;
  evidence: AnalyzeRunAmbiguousRearmEvidence;
  checkpointedWorkCount: number;
  maxRepeatProviderCalls: number;
  requiredAcknowledgement: 'possible-duplicate-provider-charges';
}

export interface AnalyzeRunAmbiguousRearmConsent {
  evidence: AnalyzeRunAmbiguousRearmEvidence;
  acceptedRisk: 'repeat-up-to-pending-provider-calls';
  acceptedMaxRepeatProviderCalls: number;
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

export type AnalyzeRunStartOverUnavailableReason =
  | 'resume-execution-ambiguous'
  | 'recovery-required'
  | 'run-completed'
  | 'attempt-superseded';

export type AnalyzeRunStartOverStatus =
  | {
      available: true;
      requiresExactAttempt: true;
      mayRepeatPaidCalls: true;
    }
  | {
      available: false;
      reason: AnalyzeRunStartOverUnavailableReason;
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
      /** Strictly certified UTC instant; null when provider wording is not trustworthy. */
      resetAt: string | null;
    } | null;
    resume: AnalyzeRunResumeStatus;
    /** Exact bounded duplicate-charge offer; null unless Core certifies it structurally safe to present. */
    rearm: AnalyzeRunAmbiguousRearmOffer | null;
    /** Server-classified replacement safety; clients must not infer this from state. */
    startOver: AnalyzeRunStartOverStatus;
  } | null;
  /** Canonical completed findings baseline used by existing consumers. */
  activeCompletedAnalysis: {
    analysisId: string;
    createdAt: string;
    branch: string | null;
    commitHash: string | null;
  } | null;
}
