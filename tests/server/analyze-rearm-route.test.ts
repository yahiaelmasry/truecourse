import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

const doubles = vi.hoisted(() => ({
  capabilities: ['local-filesystem'] as string[],
  readAnalyzeRunStatus: vi.fn(),
  rearmAnalyzeInProcess: vi.fn(),
  withLogger: vi.fn(async (_config, run: () => Promise<unknown>) => run()),
  createSocketTracker: vi.fn(() => ({ start() {}, done() {}, error() {}, detail() {} })),
  emitAnalysisComplete: vi.fn(),
  emitAnalysisProgress: vi.fn(),
  emitViolationsReady: vi.fn(),
}));

vi.mock('@truecourse/core/commands/analyze-run-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/commands/analyze-run-status')>();
  return { ...actual, readAnalyzeRunStatus: doubles.readAnalyzeRunStatus };
});

vi.mock('@truecourse/core/commands/analyze-in-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/commands/analyze-in-process')>();
  return { ...actual, rearmAnalyzeInProcess: doubles.rearmAnalyzeInProcess };
});

vi.mock('@truecourse/core/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/lib/logger')>();
  return { ...actual, withLogger: doubles.withLogger };
});

vi.mock('../../apps/dashboard/server/src/socket/handlers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/dashboard/server/src/socket/handlers.js')>();
  return {
    ...actual,
    createSocketTracker: doubles.createSocketTracker,
    emitAnalysisComplete: doubles.emitAnalysisComplete,
    emitAnalysisProgress: doubles.emitAnalysisProgress,
    emitViolationsReady: doubles.emitViolationsReady,
  };
});

vi.mock('../../apps/dashboard/server/src/ee-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/dashboard/server/src/ee-loader.js')>();
  return { ...actual, getCapabilities: () => doubles.capabilities };
});

import { createApp } from '../../apps/dashboard/server/src/app.js';
import { setupTestFixture, teardownTestFixture, type TestFixture } from '../helpers/test-db.js';
import { isAnalysisActive } from '@truecourse/core/services/analysis-registry';
import { AnalysisRearmUnavailableError } from '@truecourse/core/commands/analyze-in-process';

describe('dashboard Analyze Rearm route', () => {
  let app: Express;
  let fixture: TestFixture;

  beforeEach(async () => {
    doubles.capabilities = ['local-filesystem'];
    doubles.readAnalyzeRunStatus.mockReset();
    doubles.readAnalyzeRunStatus.mockResolvedValue(rearmableStatus());
    doubles.rearmAnalyzeInProcess.mockReset();
    doubles.withLogger.mockReset();
    doubles.withLogger.mockImplementation(async (_config, run: () => Promise<unknown>) => run());
    doubles.createSocketTracker.mockClear();
    doubles.emitAnalysisComplete.mockReset();
    doubles.emitAnalysisProgress.mockReset();
    doubles.emitViolationsReady.mockReset();
    fixture = await setupTestFixture();
    app = createApp({ serveStatic: false });
  });

  afterEach(async () => {
    await teardownTestFixture(fixture.project.slug);
  });

  it('denies hosted access before parsing or reading local attempted-run storage', async () => {
    doubles.capabilities = [];
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/rearm`)
      .send({})
      .expect(404);
    expect(doubles.readAnalyzeRunStatus).not.toHaveBeenCalled();
    expect(doubles.rearmAnalyzeInProcess).not.toHaveBeenCalled();
  });

  it('rejects invalid consent before reading status or admitting work', async () => {
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/rearm`)
      .send({ consent: {} })
      .expect(400);
    expect(doubles.readAnalyzeRunStatus).not.toHaveBeenCalled();
    expect(doubles.rearmAnalyzeInProcess).not.toHaveBeenCalled();
  });

  it('rejects an unacknowledged risk literal before reading status or admitting work', async () => {
    const body = rearmRequest() as { consent: { acceptedRisk: string } };
    body.consent.acceptedRisk = 'accept-any-duplicate-charge';
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/rearm`)
      .send(body)
      .expect(400);
    expect(doubles.readAnalyzeRunStatus).not.toHaveBeenCalled();
    expect(doubles.rearmAnalyzeInProcess).not.toHaveBeenCalled();
  });

  it.each([
    ['non-latest attempt', () => ({ ...rearmableStatus(), latestAttempt: { ...rearmableStatus().latestAttempt, runId: 'newer-run' } })],
    ['changed completed baseline', () => ({ ...rearmableStatus(), activeCompletedAnalysis: { ...rearmableStatus().activeCompletedAnalysis, analysisId: 'newer-baseline' } })],
    ['missing certified offer', () => ({ ...rearmableStatus(), latestAttempt: { ...rearmableStatus().latestAttempt, rearm: null } })],
  ])('rejects a $0 before logger setup or Core admission', async (_name, status) => {
    doubles.readAnalyzeRunStatus.mockResolvedValueOnce(status());
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/rearm`)
      .send(rearmRequest())
      .expect(409);
    expect(doubles.withLogger).not.toHaveBeenCalled();
    expect(doubles.rearmAnalyzeInProcess).not.toHaveBeenCalled();
  });

  it.each([
    ['run identity', (request: ReturnType<typeof rearmRequest>) => { request.consent.evidence.runId = 'different-run'; }],
    ['run revision', (request: ReturnType<typeof rearmRequest>) => { request.consent.evidence.runRevision += 1; }],
    ['epoch kind', (request: ReturnType<typeof rearmRequest>) => { request.consent.evidence.executionEpoch.kind = 'resume'; }],
    ['epoch attempt', (request: ReturnType<typeof rearmRequest>) => { request.consent.evidence.executionEpoch.attemptNumber += 1; }],
    ['epoch activation time', (request: ReturnType<typeof rearmRequest>) => { request.consent.evidence.executionEpoch.activatedAt = '2026-07-22T10:00:00.000Z'; }],
    ['admission time', (request: ReturnType<typeof rearmRequest>) => { request.consent.evidence.admittedAt = '2026-07-22T10:01:00.000Z'; }],
    ['pending bound', (request: ReturnType<typeof rearmRequest>) => { request.consent.evidence.pendingWorkCount += 1; }],
    ['repeat-call bound', (request: ReturnType<typeof rearmRequest>) => { request.consent.acceptedMaxRepeatProviderCalls += 1; }],
  ])('rejects a stale echoed $0 before Core admission', async (_name, mutate) => {
    const body = rearmRequest();
    mutate(body);
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/rearm`)
      .send(body)
      .expect(409);
    expect(doubles.rearmAnalyzeInProcess).not.toHaveBeenCalled();
  });

  it('admits exact consent, marks rearm active, and protects it from duplicate, replacement, and cancellation', async () => {
    const execution = deferred<{ analysisId: string }>();
    doubles.rearmAnalyzeInProcess.mockReturnValueOnce(execution.promise);

    const accepted = await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/rearm`)
      .send(rearmRequest())
      .expect(202);

    expect(accepted.body).toEqual({
      message: 'Analysis Rearm started', repoId: fixture.project.slug, runId: 'interrupted-run', mode: 'rearm',
    });
    expect(doubles.rearmAnalyzeInProcess).toHaveBeenCalledWith(
      expect.objectContaining({ path: fixture.repoPath }),
      expect.objectContaining({ runId: 'interrupted-run', consent: rearmRequest().consent }),
    );
    expect(doubles.rearmAnalyzeInProcess.mock.calls[0]?.[1]).not.toHaveProperty('signal');

    expect((await request(app).get(`/api/repos/${fixture.project.slug}/analyses/status`).expect(200)).body.activeMode).toBe('rearm');
    await request(app).post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/rearm`).send(rearmRequest()).expect(409);
    await request(app).post(`/api/repos/${fixture.project.slug}/analyses`).send({ mode: 'full' }).expect(409);
    await request(app).post(`/api/repos/${fixture.project.slug}/analyses/cancel`).expect(409);

    execution.resolve({ analysisId: 'rearmed-analysis' });
    await vi.waitFor(() => {
      expect(doubles.emitViolationsReady).toHaveBeenCalledWith(fixture.project.slug, 'rearmed-analysis');
      expect(doubles.emitAnalysisComplete).toHaveBeenCalledWith(fixture.project.slug, 'rearmed-analysis');
      expect(isAnalysisActive(fixture.project.slug)).toBe(false);
    });
  });

  it('reports production revalidation failure after acceptance and releases ownership', async () => {
    doubles.rearmAnalyzeInProcess.mockRejectedValueOnce(new AnalysisRearmUnavailableError('work-plan-changed'));
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/rearm`)
      .send(rearmRequest())
      .expect(202);
    await vi.waitFor(() => {
      expect(doubles.emitAnalysisProgress).toHaveBeenCalledWith(
        fixture.project.slug,
        expect.objectContaining({ step: 'error', detail: expect.stringMatching(/No provider work was admitted/i) }),
        'rearm',
      );
      expect(isAnalysisActive(fixture.project.slug)).toBe(false);
    });
  });
});

function rearmableStatus() {
  return {
    latestAttempt: {
      runId: 'interrupted-run', candidateAnalysisId: 'candidate-analysis', completedBaselineId: 'completed-analysis',
      state: 'blocked', startedAt: '2026-07-22T08:00:00.000Z', updatedAt: '2026-07-22T09:00:00.000Z',
      source: 'dashboard', branch: 'main', commitHash: 'def456',
      counts: { total: 2, succeeded: 1, pending: 1, running: 0, failed: 0 }, blocked: null, lastProviderLimit: null, finalization: null,
      resume: { available: false, scope: 'structural', reason: 'resume-execution-ambiguous' },
      rearm: rearmOffer(),
    },
    activeCompletedAnalysis: { analysisId: 'completed-analysis', createdAt: '2026-07-21T08:00:00.000Z', branch: 'main', commitHash: 'abc123' },
  };
}

function rearmOffer() {
  return {
    scope: 'structural' as const, mode: 'rearm-ambiguous-execution' as const, requiresLatestAttempt: true as const, requiresRevalidation: true as const,
    evidence: {
      runId: 'interrupted-run', runRevision: 4,
      executionEpoch: { kind: 'initial' as const, attemptNumber: 1, activatedAt: '2026-07-22T08:30:00.000Z' },
      admittedAt: '2026-07-22T08:31:00.000Z', pendingWorkCount: 1,
    },
    checkpointedWorkCount: 1, maxRepeatProviderCalls: 1,
    requiredAcknowledgement: 'possible-duplicate-provider-charges' as const,
  };
}

function rearmRequest() {
  const offer = rearmOffer();
  return {
    consent: {
      evidence: structuredClone(offer.evidence),
      acceptedRisk: 'repeat-up-to-pending-provider-calls' as const,
      acceptedMaxRepeatProviderCalls: offer.maxRepeatProviderCalls,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
