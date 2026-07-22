export type AnalyzeRunAmbiguousExecutionEpoch = Readonly<{
  kind: 'initial' | 'resume';
  attemptNumber: number;
  activatedAt: string;
}>;

export type AnalyzeRunAmbiguousRearmEvidence = Readonly<{
  runId: string;
  runRevision: number;
  executionEpoch: AnalyzeRunAmbiguousExecutionEpoch;
  admittedAt: string;
  pendingWorkCount: number;
}>;

export type AnalyzeRunAmbiguousRearmOffer = Readonly<{
  scope: 'structural';
  mode: 'rearm-ambiguous-execution';
  requiresLatestAttempt: true;
  requiresRevalidation: true;
  evidence: AnalyzeRunAmbiguousRearmEvidence;
  checkpointedWorkCount: number;
  maxRepeatProviderCalls: number;
  requiredAcknowledgement: 'possible-duplicate-provider-charges';
}>;

export type AnalyzeRunAmbiguousRearmConsent = Readonly<{
  evidence: AnalyzeRunAmbiguousRearmEvidence;
  acceptedRisk: 'repeat-up-to-pending-provider-calls';
  acceptedMaxRepeatProviderCalls: number;
}>;

export type AnalyzeRunAmbiguousRearmConsentMismatch =
  | 'consent-required'
  | 'risk-not-accepted'
  | 'evidence-changed';

export type AnalyzeRunAmbiguousRearmWorkState =
  | 'pending'
  | 'succeeded-uncheckpointed'
  | 'succeeded-checkpointed';

export type AnalyzeRunAmbiguousRearmExecutionEpochState =
  | Readonly<{
      kind: 'initial';
      attemptNumber: number;
      activatedAt: string;
      admission: 'activated' | 'executing' | 'ambiguous';
      admittedAt: string | null;
      evidence: 'explicit' | 'legacy-inferred' | 'legacy-ambiguous';
    }>
  | Readonly<{
      kind: 'resume';
      attemptNumber: number;
      activatedAt: string;
      admission: 'activated' | 'executing';
      admittedAt: string | null;
    }>;

export interface AnalyzeRunAmbiguousRearmState {
  readonly isLatestAttempt: boolean;
  readonly admissionEvidence: 'explicit-admission-schema' | 'legacy-schema';
  readonly runId: string;
  readonly runRevision: number;
  readonly state: 'running' | 'blocked' | 'failed' | 'finalizing' | 'completed';
  readonly finalizationPresent: boolean;
  readonly executionEpoch: AnalyzeRunAmbiguousRearmExecutionEpochState;
  readonly plan:
    | Readonly<{ state: 'unsealed' }>
    | Readonly<{
        state: 'sealed';
        executionBound: boolean;
        workStates: readonly AnalyzeRunAmbiguousRearmWorkState[];
      }>;
}

/**
 * Describe the maximum duplicate-provider spend for one structurally ambiguous
 * execution. This is only an offer: the writer must still revalidate every
 * durable input and atomically prove the same latest attempt before execution.
 */
export function buildAnalyzeRunAmbiguousRearmOffer(
  state: AnalyzeRunAmbiguousRearmState,
): AnalyzeRunAmbiguousRearmOffer | null {
  if (
    !state.isLatestAttempt
    || state.admissionEvidence !== 'explicit-admission-schema'
    || state.state !== 'running'
    || state.finalizationPresent
    || state.plan.state !== 'sealed'
    || !state.plan.executionBound
    || state.plan.workStates.includes('succeeded-uncheckpointed')
    || state.executionEpoch.admission !== 'executing'
    || state.executionEpoch.admittedAt === null
    || (
      state.executionEpoch.kind === 'initial'
      && (
        state.executionEpoch.attemptNumber !== 1
        || state.executionEpoch.evidence !== 'explicit'
      )
    )
    || (
      state.executionEpoch.kind === 'resume'
      && state.executionEpoch.attemptNumber <= 1
    )
  ) {
    return null;
  }

  const pendingWorkCount = state.plan.workStates.filter((work) => work === 'pending').length;
  if (pendingWorkCount === 0) return null;
  const checkpointedWorkCount = state.plan.workStates.filter(
    (work) => work === 'succeeded-checkpointed',
  ).length;

  return {
    scope: 'structural',
    mode: 'rearm-ambiguous-execution',
    requiresLatestAttempt: true,
    requiresRevalidation: true,
    evidence: {
      runId: state.runId,
      runRevision: state.runRevision,
      executionEpoch: {
        kind: state.executionEpoch.kind,
        attemptNumber: state.executionEpoch.attemptNumber,
        activatedAt: state.executionEpoch.activatedAt,
      },
      admittedAt: state.executionEpoch.admittedAt,
      pendingWorkCount,
    },
    checkpointedWorkCount,
    maxRepeatProviderCalls: pendingWorkCount,
    requiredAcknowledgement: 'possible-duplicate-provider-charges',
  };
}

export function inspectAnalyzeRunAmbiguousRearmConsent(
  offer: AnalyzeRunAmbiguousRearmOffer | null,
  consent: AnalyzeRunAmbiguousRearmConsent | undefined,
): AnalyzeRunAmbiguousRearmConsentMismatch | null {
  if (consent === undefined) return 'consent-required';
  if (offer === null) return 'evidence-changed';
  if (
    consent.acceptedRisk !== 'repeat-up-to-pending-provider-calls'
    || !Number.isSafeInteger(consent.acceptedMaxRepeatProviderCalls)
    || consent.acceptedMaxRepeatProviderCalls < 0
    || consent.acceptedMaxRepeatProviderCalls !== offer.maxRepeatProviderCalls
  ) {
    return 'risk-not-accepted';
  }
  if (!sameEvidence(consent.evidence, offer.evidence)) {
    return 'evidence-changed';
  }
  return null;
}

function sameEvidence(
  actual: AnalyzeRunAmbiguousRearmEvidence,
  expected: AnalyzeRunAmbiguousRearmEvidence,
): boolean {
  return actual.runId === expected.runId
    && actual.runRevision === expected.runRevision
    && actual.executionEpoch.kind === expected.executionEpoch.kind
    && actual.executionEpoch.attemptNumber === expected.executionEpoch.attemptNumber
    && actual.executionEpoch.activatedAt === expected.executionEpoch.activatedAt
    && actual.admittedAt === expected.admittedAt
    && actual.pendingWorkCount === expected.pendingWorkCount;
}
