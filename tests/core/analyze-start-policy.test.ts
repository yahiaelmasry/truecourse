import { describe, expect, it } from 'vitest';
import {
  AnalysisStartBlockedError,
  classifyAnalyzeStart,
  resolveAnalyzeStartExpectationFromStatus,
} from '../../packages/core/src/commands/analyze-in-process.js';
import type { AnalyzeRunStatus } from '../../packages/core/src/commands/analyze-run-status.js';

describe('analyze start policy', () => {
  it('allows a fresh start when no incomplete attempt exists', () => {
    expect(classifyAnalyzeStart(status(null))).toEqual({
      kind: 'clear',
      reason: 'no-incomplete-attempt',
    });
    expect(resolveAnalyzeStartExpectationFromStatus(status(null))).toEqual({
      kind: 'none-incomplete',
    });
  });

  it('requires exact acknowledgement for every safely abandonable attempt', () => {
    for (const attempt of [
      run({ state: 'blocked', resumeAvailable: true }),
      run({ state: 'blocked', resumeReason: 'run-not-resumable' }),
      run({ state: 'failed', resumeReason: 'run-failed' }),
      run({ state: 'running', resumeReason: 'successful-results-not-checkpointed' }),
    ]) {
      const current = status(attempt);
      expect(classifyAnalyzeStart(current)).toEqual({ kind: 'abandonable', runId: 'run-1' });
      expect(() => resolveAnalyzeStartExpectationFromStatus(current)).toThrow(
        AnalysisStartBlockedError,
      );
      expect(resolveAnalyzeStartExpectationFromStatus(current, 'run-1')).toEqual({
        kind: 'abandon',
        runId: 'run-1',
      });
      expect(() => resolveAnalyzeStartExpectationFromStatus(current, 'stale-run')).toThrowError(
        expect.objectContaining({ reason: 'expectation-changed', runId: 'run-1' }),
      );
    }
  });

  it('fails closed for an admitted initial execution before considering supersession', () => {
    const current = status(
      run({ state: 'running', resumeReason: 'resume-execution-ambiguous', completedBaselineId: 'older' }),
      'newer',
    );
    expect(classifyAnalyzeStart(current)).toEqual({
      kind: 'blocked',
      reason: 'resume-execution-ambiguous',
      runId: 'run-1',
    });
    expect(() => resolveAnalyzeStartExpectationFromStatus(current, 'run-1')).toThrowError(
      expect.objectContaining({ reason: 'resume-execution-ambiguous' }),
    );
  });

  it.each([
    run({ state: 'running', resumeAvailable: true }),
    run({ state: 'finalizing', resumeReason: 'finalization-unprepared' }),
    run({ state: 'failed', resumeReason: 'run-failed', prepared: true }),
  ])('requires recovery instead of replacement for $state state', (attempt) => {
    const current = status(attempt);
    expect(classifyAnalyzeStart(current)).toEqual({
      kind: 'blocked',
      reason: 'recovery-required',
      runId: 'run-1',
    });
    expect(() => resolveAnalyzeStartExpectationFromStatus(current, 'run-1')).toThrowError(
      expect.objectContaining({ reason: 'recovery-required' }),
    );
  });

  it('does not let a stale acknowledgement target a completed or superseded attempt', () => {
    const completed = status(run({ state: 'completed', resumeReason: 'run-completed' }));
    expect(classifyAnalyzeStart(completed)).toEqual({ kind: 'clear', reason: 'run-completed' });
    expect(() => resolveAnalyzeStartExpectationFromStatus(completed, 'run-1')).toThrowError(
      expect.objectContaining({ reason: 'expectation-changed' }),
    );

    const superseded = status(
      run({ state: 'blocked', resumeAvailable: true, completedBaselineId: 'older' }),
      'newer',
    );
    expect(classifyAnalyzeStart(superseded)).toEqual({
      kind: 'clear',
      reason: 'attempt-superseded',
    });
    expect(resolveAnalyzeStartExpectationFromStatus(superseded)).toEqual({
      kind: 'none-incomplete',
    });
    expect(() => resolveAnalyzeStartExpectationFromStatus(superseded, 'run-1')).toThrowError(
      expect.objectContaining({ reason: 'expectation-changed' }),
    );
  });
});

function status(
  latestAttempt: AnalyzeRunStatus['latestAttempt'],
  activeCompletedId = 'baseline-1',
): AnalyzeRunStatus {
  return {
    latestAttempt,
    activeCompletedAnalysis: activeCompletedId === null
      ? null
      : {
          analysisId: activeCompletedId,
          createdAt: '2026-07-21T08:00:00.000Z',
          branch: 'main',
          commitHash: 'abc123',
        },
  };
}

function run(options: {
  state: 'running' | 'blocked' | 'failed' | 'finalizing' | 'completed';
  resumeAvailable?: boolean;
  resumeReason?: 'successful-results-not-checkpointed' | 'resume-execution-ambiguous' | 'finalization-unprepared' | 'run-failed' | 'run-not-resumable' | 'run-completed';
  completedBaselineId?: string | null;
  prepared?: boolean;
}): NonNullable<AnalyzeRunStatus['latestAttempt']> {
  return {
    schemaVersion: 8,
    revision: 1,
    runId: 'run-1',
    candidateAnalysisId: 'candidate-1',
    state: options.state,
    startedAt: '2026-07-22T08:00:00.000Z',
    updatedAt: '2026-07-22T08:10:00.000Z',
    source: 'dashboard',
    branch: 'main',
    commitHash: 'def456',
    completedBaselineId: options.completedBaselineId === undefined
      ? 'baseline-1'
      : options.completedBaselineId,
    executionAttempt: {
      number: 1,
      activatedAt: '2026-07-22T08:00:00.000Z',
      initialAdmission: {
        admission: 'executing',
        admittedAt: '2026-07-22T08:00:01.000Z',
        evidence: 'explicit',
      },
      resume: null,
    },
    plan: 'sealed',
    counts: { total: 2, pending: 1, running: 0, succeeded: 1, failed: 0 },
    blocked: options.state === 'blocked'
      ? {
          reason: 'provider-session-limit',
          resetHint: 'tomorrow',
          blockedAt: '2026-07-22T08:10:00.000Z',
        }
      : null,
    lastProviderLimit: null,
    failure: options.state === 'failed'
      ? { code: 'FAILED', message: 'failed', failedAt: '2026-07-22T08:10:00.000Z' }
      : null,
    finalization: options.state === 'finalizing' || options.prepared
      ? {
          finalizingAt: '2026-07-22T08:09:00.000Z',
          persistence: options.prepared ? 'prepared' : 'unprepared',
          preparedAt: options.prepared ? '2026-07-22T08:09:30.000Z' : null,
        }
      : null,
    resume: options.resumeAvailable
      ? {
          available: true,
          scope: 'structural',
          mode: 'resume',
          requiresLatestAttempt: true,
          requiresRevalidation: true,
        }
      : {
          available: false,
          scope: 'structural',
          reason: options.resumeReason ?? 'run-not-resumable',
        },
    rearm: null,
  };
}
