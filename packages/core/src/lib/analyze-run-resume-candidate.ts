import type { AnalyzeLlmExecutionUsage } from '../services/llm/analyze-llm-execution-evidence.js';

export interface AnalyzeRunResumeCheckpointCandidate {
  readonly checkpointedAt: string;
  readonly attemptId: string;
  readonly resultContractId: string;
  readonly resultFingerprint: string;
  readonly result: unknown;
  readonly usage: AnalyzeLlmExecutionUsage | null;
}

interface AnalyzeRunResumeWorkIdentity {
  readonly workId: string;
  readonly inputFingerprint: string;
}

export type AnalyzeRunResumeWorkCandidate =
  | Readonly<AnalyzeRunResumeWorkIdentity & { state: 'pending' }>
  | Readonly<AnalyzeRunResumeWorkIdentity & { state: 'succeeded-uncheckpointed' }>
  | Readonly<AnalyzeRunResumeWorkIdentity & {
      state: 'succeeded-checkpointed';
      checkpoint: AnalyzeRunResumeCheckpointCandidate;
    }>;

export interface AnalyzeRunResumeCandidate {
  readonly storageIdentity: object;
  readonly isLatestAttempt: boolean;
  readonly attemptSequence: number;
  readonly latestAttemptSequence: number;
  readonly revision: number;
  readonly runId: string;
  readonly candidateAnalysisId: string;
  readonly state: 'running' | 'blocked' | 'failed' | 'finalizing' | 'completed';
  readonly startedAt: string;
  readonly source: 'cli' | 'dashboard' | 'hosted';
  readonly branch: string | null;
  readonly commitHash: string | null;
  readonly completedBaselineId: string | null;
  readonly executionAttempt: Readonly<{
    number: number;
    activatedAt: string;
    resume: null | Readonly<{
      admission: 'activated' | 'executing';
      admittedAt: string | null;
      resumedFrom: Readonly<{
        reason: 'provider-session-limit';
        resetHint: string;
        blockedAt: string;
      }>;
      executionPin: Readonly<{
        provider: string;
        requestedModel: string | null;
        resolvedModel: string;
      }>;
    }>;
  }>;
  readonly blocked: null | Readonly<{
    resetHint: string;
    blockedAt: string;
  }>;
  readonly plan: 'unsealed' | Readonly<{
    sealedAt: string;
    work: readonly AnalyzeRunResumeWorkCandidate[];
  }>;
}

type AnalyzeRunResumeCandidateReader = (
  repoKey: string,
  runId: string,
) => Promise<AnalyzeRunResumeCandidate | null>;

let reader: AnalyzeRunResumeCandidateReader | null = null;

/** @internal Installed by the journal so the LLM planner cannot mutate run state. */
export function installAnalyzeRunResumeCandidateReader(
  next: AnalyzeRunResumeCandidateReader,
): void {
  reader = next;
}

/** @internal Read one detached attempted-run snapshot for compatibility inspection. */
export async function readAnalyzeRunResumeCandidate(
  repoKey: string,
  runId: string,
): Promise<AnalyzeRunResumeCandidate | null> {
  if (!reader) throw new Error('Analyze-run resume candidate reader is not installed');
  return reader(repoKey, runId);
}
