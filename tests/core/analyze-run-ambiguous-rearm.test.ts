import { describe, expect, it } from 'vitest';
import {
  buildAnalyzeRunAmbiguousRearmOffer,
  inspectAnalyzeRunAmbiguousRearmConsent,
  type AnalyzeRunAmbiguousRearmState,
} from '../../packages/core/src/lib/analyze-run-ambiguous-rearm.js';

describe('ambiguous analyze execution rearm policy', () => {
  it('bounds an exact-latest admitted initial execution by every still-pending call', () => {
    expect(buildAnalyzeRunAmbiguousRearmOffer(state())).toEqual({
      scope: 'structural',
      mode: 'rearm-ambiguous-execution',
      requiresLatestAttempt: true,
      requiresRevalidation: true,
      evidence: {
        runId: 'run-1',
        runRevision: 4,
        executionEpoch: {
          kind: 'initial',
          attemptNumber: 1,
          activatedAt: '2026-07-22T08:00:00.000Z',
        },
        admittedAt: '2026-07-22T08:00:01.000Z',
        pendingWorkCount: 2,
      },
      checkpointedWorkCount: 1,
      maxRepeatProviderCalls: 2,
      requiredAcknowledgement: 'possible-duplicate-provider-charges',
    });
  });

  it('binds a resumed execution offer to its distinct durable epoch', () => {
    expect(buildAnalyzeRunAmbiguousRearmOffer(state({
      runRevision: 9,
      executionEpoch: {
        kind: 'resume',
        attemptNumber: 2,
        activatedAt: '2026-07-22T09:00:00.000Z',
        admission: 'executing',
        admittedAt: '2026-07-22T09:00:01.000Z',
      },
    }))).toMatchObject({
      evidence: {
        runRevision: 9,
        executionEpoch: {
          kind: 'resume',
          attemptNumber: 2,
          activatedAt: '2026-07-22T09:00:00.000Z',
        },
        admittedAt: '2026-07-22T09:00:01.000Z',
      },
      maxRepeatProviderCalls: 2,
    });
  });

  it.each([
    ['not latest', { isLatestAttempt: false }],
    ['legacy schema', { admissionEvidence: 'legacy-schema' as const }],
    ['not running', { state: 'blocked' as const }],
    ['already finalizing', { finalizationPresent: true }],
    ['unsealed', { plan: { state: 'unsealed' as const } }],
    ['unbound', {
      plan: {
        state: 'sealed' as const,
        executionBound: false,
        workStates: ['pending'] as const,
      },
    }],
    ['uncheckpointed success', {
      plan: {
        state: 'sealed' as const,
        executionBound: true,
        workStates: ['succeeded-uncheckpointed', 'pending'] as const,
      },
    }],
    ['not admitted', {
      executionEpoch: {
        kind: 'initial' as const,
        attemptNumber: 1,
        activatedAt: '2026-07-22T08:00:00.000Z',
        admission: 'activated' as const,
        admittedAt: null,
        evidence: 'explicit' as const,
      },
    }],
    ['legacy admission', {
      executionEpoch: {
        kind: 'initial' as const,
        attemptNumber: 1,
        activatedAt: '2026-07-22T08:00:00.000Z',
        admission: 'executing' as const,
        admittedAt: null,
        evidence: 'legacy-inferred' as const,
      },
    }],
    ['fully checkpointed', {
      plan: {
        state: 'sealed' as const,
        executionBound: true,
        workStates: ['succeeded-checkpointed'] as const,
      },
    }],
  ])('does not offer rearm when the %s invariant is absent', (_case, overrides) => {
    expect(buildAnalyzeRunAmbiguousRearmOffer(state(overrides))).toBeNull();
  });

  it('requires the exact risk literal, bound, and observed evidence', () => {
    const offer = buildAnalyzeRunAmbiguousRearmOffer(state());
    if (offer === null) throw new Error('expected a rearm offer');
    const consent = {
      evidence: structuredClone(offer.evidence),
      acceptedRisk: 'repeat-up-to-pending-provider-calls' as const,
      acceptedMaxRepeatProviderCalls: 2,
    };

    expect(inspectAnalyzeRunAmbiguousRearmConsent(offer, undefined)).toBe('consent-required');
    expect(inspectAnalyzeRunAmbiguousRearmConsent(offer, {
      ...consent,
      acceptedRisk: 'different-risk' as typeof consent.acceptedRisk,
    })).toBe('risk-not-accepted');
    expect(inspectAnalyzeRunAmbiguousRearmConsent(offer, {
      ...consent,
      acceptedMaxRepeatProviderCalls: 1,
    })).toBe('risk-not-accepted');
    expect(inspectAnalyzeRunAmbiguousRearmConsent(offer, {
      ...consent,
      acceptedMaxRepeatProviderCalls: Number.POSITIVE_INFINITY,
    })).toBe('risk-not-accepted');
    expect(inspectAnalyzeRunAmbiguousRearmConsent(offer, {
      ...consent,
      acceptedMaxRepeatProviderCalls: 2.5,
    })).toBe('risk-not-accepted');

    for (const evidence of [
      { ...consent.evidence, runId: 'changed' },
      { ...consent.evidence, runRevision: 5 },
      {
        ...consent.evidence,
        executionEpoch: { ...consent.evidence.executionEpoch, kind: 'resume' as const },
      },
      {
        ...consent.evidence,
        executionEpoch: { ...consent.evidence.executionEpoch, attemptNumber: 2 },
      },
      {
        ...consent.evidence,
        executionEpoch: {
          ...consent.evidence.executionEpoch,
          activatedAt: '2026-07-22T08:00:02.000Z',
        },
      },
      { ...consent.evidence, admittedAt: '2026-07-22T08:00:02.000Z' },
      { ...consent.evidence, pendingWorkCount: 1 },
    ]) {
      expect(inspectAnalyzeRunAmbiguousRearmConsent(offer, {
        ...consent,
        evidence,
      })).toBe('evidence-changed');
    }
  });

  it('rejects old consent when a new checkpoint changes the revision and pending bound', () => {
    const observed = buildAnalyzeRunAmbiguousRearmOffer(state());
    if (observed === null) throw new Error('expected a rearm offer');
    const consent = {
      evidence: observed.evidence,
      acceptedRisk: 'repeat-up-to-pending-provider-calls' as const,
      acceptedMaxRepeatProviderCalls: observed.maxRepeatProviderCalls,
    };
    const current = buildAnalyzeRunAmbiguousRearmOffer(state({
      runRevision: 5,
      plan: {
        state: 'sealed',
        executionBound: true,
        workStates: ['succeeded-checkpointed', 'succeeded-checkpointed', 'pending'],
      },
    }));

    expect(inspectAnalyzeRunAmbiguousRearmConsent(current, consent)).toBe('risk-not-accepted');
    expect(inspectAnalyzeRunAmbiguousRearmConsent(null, consent)).toBe('evidence-changed');
  });
});

function state(
  overrides: Partial<AnalyzeRunAmbiguousRearmState> = {},
): AnalyzeRunAmbiguousRearmState {
  return {
    isLatestAttempt: true,
    admissionEvidence: 'explicit-admission-schema',
    runId: 'run-1',
    runRevision: 4,
    state: 'running',
    finalizationPresent: false,
    executionEpoch: {
      kind: 'initial',
      attemptNumber: 1,
      activatedAt: '2026-07-22T08:00:00.000Z',
      admission: 'executing',
      admittedAt: '2026-07-22T08:00:01.000Z',
      evidence: 'explicit',
    },
    plan: {
      state: 'sealed',
      executionBound: true,
      workStates: ['succeeded-checkpointed', 'pending', 'pending'],
    },
    ...overrides,
  };
}
