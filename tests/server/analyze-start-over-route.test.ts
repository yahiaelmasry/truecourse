import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

const doubles = vi.hoisted(() => ({
  capabilities: ['local-filesystem'] as string[],
  analyzeInProcess: vi.fn(),
  readAnalyzeRunStatus: vi.fn(),
  emitAnalysisProgress: vi.fn(),
  withLogger: vi.fn(async (_config, run: () => Promise<unknown>) => run()),
}));

vi.mock('@truecourse/core/commands/analyze-in-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/commands/analyze-in-process')>();
  return { ...actual, analyzeInProcess: doubles.analyzeInProcess };
});

vi.mock('@truecourse/core/commands/analyze-run-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/commands/analyze-run-status')>();
  return { ...actual, readAnalyzeRunStatus: doubles.readAnalyzeRunStatus };
});

vi.mock('@truecourse/core/services/llm/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/services/llm/provider')>();
  return { ...actual, createLLMProvider: vi.fn(() => undefined) };
});

vi.mock('@truecourse/core/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/lib/logger')>();
  return { ...actual, withLogger: doubles.withLogger };
});

vi.mock('../../apps/dashboard/server/src/socket/handlers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/dashboard/server/src/socket/handlers.js')>();
  return {
    ...actual,
    createSocketStashConfirmHandler: () => () => Promise.resolve('stash'),
    createSocketTracker: () => ({ start() {}, done() {}, error() {}, detail() {} }),
    emitAnalysisCanceled: vi.fn(),
    emitAnalysisComplete: vi.fn(),
    emitAnalysisProgress: doubles.emitAnalysisProgress,
    emitViolationsReady: vi.fn(),
  };
});

vi.mock('../../apps/dashboard/server/src/ee-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/dashboard/server/src/ee-loader.js')>();
  return { ...actual, getCapabilities: () => doubles.capabilities };
});

import { createApp } from '../../apps/dashboard/server/src/app.js';
import { setupTestFixture, teardownTestFixture, type TestFixture } from '../helpers/test-db.js';
import { AnalysisStartBlockedError } from '@truecourse/core/commands/analyze-in-process';
import { isAnalysisActive } from '@truecourse/core/services/analysis-registry';

describe('dashboard Analyze Start over route', () => {
  let app: Express;
  let fixture: TestFixture;

  beforeEach(async () => {
    doubles.capabilities = ['local-filesystem'];
    doubles.analyzeInProcess.mockReset();
    doubles.analyzeInProcess.mockResolvedValue({ analysisId: 'replacement-analysis' });
    doubles.readAnalyzeRunStatus.mockReset();
    doubles.readAnalyzeRunStatus.mockResolvedValue(status(null));
    doubles.emitAnalysisProgress.mockReset();
    doubles.withLogger.mockReset();
    doubles.withLogger.mockImplementation(async (_config, run: () => Promise<unknown>) => run());
    fixture = await setupTestFixture();
    app = createApp({ serveStatic: false });
  });

  afterEach(async () => {
    await teardownTestFixture(fixture.project.slug);
  });

  it('passes a no-incomplete-attempt expectation for an ordinary local full analysis', async () => {
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(202);

    await vi.waitFor(() => {
      expect(doubles.analyzeInProcess).toHaveBeenCalledWith(
        expect.objectContaining({ path: fixture.repoPath }),
        expect.objectContaining({ latestAttemptExpectation: { kind: 'none-incomplete' } }),
      );
    });
  });

  it('requires the exact latest attempt before accepting replacement work', async () => {
    doubles.readAnalyzeRunStatus.mockResolvedValue(status(run({ state: 'blocked', resumeAvailable: true })));

    const missing = await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(409);
    expect(missing.body.error).toMatch(/resume.*start over.*paid/i);

    const stale = await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full', abandonAttemptRunId: 'older-run' })
      .expect(409);
    expect(stale.body.error).toMatch(/changed.*refresh/i);
    expect(doubles.analyzeInProcess).not.toHaveBeenCalled();
    expect(isAnalysisActive(fixture.project.slug)).toBe(false);
  });

  it.each([
    run({ state: 'blocked', resumeAvailable: true }),
    run({ state: 'failed', resumeReason: 'run-failed' }),
    run({ state: 'running', resumeReason: 'successful-results-not-checkpointed' }),
  ])('accepts exact Start over for safely abandonable $state work', async (attempt) => {
    doubles.readAnalyzeRunStatus.mockResolvedValue(status(attempt));

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full', abandonAttemptRunId: 'run-1' })
      .expect(202);

    await vi.waitFor(() => {
      expect(doubles.analyzeInProcess).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          latestAttemptExpectation: { kind: 'abandon', runId: 'run-1' },
        }),
      );
    });
  });

  it.each([
    {
      name: 'ambiguous provider execution',
      attempt: run({ state: 'running', resumeReason: 'resume-execution-ambiguous' }),
      message: /provider call.*in flight.*blocked/i,
    },
    {
      name: 'active Resume recovery',
      attempt: run({ state: 'running', resumeAvailable: true }),
      message: /must.*resume.*start over.*not.*offered/i,
    },
    {
      name: 'unprepared finalization',
      attempt: run({ state: 'finalizing', resumeReason: 'finalization-unprepared' }),
      message: /must.*resume.*start over.*not.*offered/i,
    },
    {
      name: 'failed prepared finalization',
      attempt: run({ state: 'failed', resumeReason: 'run-failed', prepared: true }),
      message: /must.*resume.*start over.*not.*offered/i,
    },
  ])('fails closed before 202 for $name', async ({ attempt, message }) => {
    doubles.readAnalyzeRunStatus.mockResolvedValue(status(attempt));

    const response = await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full', abandonAttemptRunId: 'run-1' })
      .expect(409);

    expect(response.body.error).toMatch(message);
    expect(doubles.analyzeInProcess).not.toHaveBeenCalled();
  });

  it('allows a fresh start past a superseded attempt but rejects its stale acknowledgement', async () => {
    doubles.readAnalyzeRunStatus.mockResolvedValue(status(
      run({ state: 'blocked', resumeAvailable: true, completedBaselineId: 'older-baseline' }),
    ));

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(202);
    await vi.waitFor(() => expect(doubles.analyzeInProcess).toHaveBeenCalledTimes(1));
    expect(doubles.analyzeInProcess).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ latestAttemptExpectation: { kind: 'none-incomplete' } }),
    );

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full', abandonAttemptRunId: 'run-1' })
      .expect(409);
  });

  it('rejects local attempted-run acknowledgement on a hosted dashboard', async () => {
    doubles.capabilities = [];

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full', abandonAttemptRunId: 'run-1' })
      .expect(404);

    expect(doubles.readAnalyzeRunStatus).not.toHaveBeenCalled();
    expect(doubles.analyzeInProcess).not.toHaveBeenCalled();
  });

  it('reports a locked revalidation race after acceptance without starting replacement work', async () => {
    doubles.readAnalyzeRunStatus.mockResolvedValue(status(null));
    doubles.analyzeInProcess.mockRejectedValueOnce(
      new AnalysisStartBlockedError('expectation-changed', 'new-run'),
    );

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(202);

    await vi.waitFor(() => {
      expect(doubles.emitAnalysisProgress).toHaveBeenCalledWith(
        fixture.project.slug,
        expect.objectContaining({
          step: 'error',
          detail: expect.stringMatching(/did not start.*changed.*refresh.*analyses/i),
        }),
      );
      expect(isAnalysisActive(fixture.project.slug)).toBe(false);
    });
  });
});

function status(latestAttempt: ReturnType<typeof run> | null) {
  return {
    latestAttempt,
    activeCompletedAnalysis: {
      analysisId: 'baseline-1',
      createdAt: '2026-07-21T08:00:00.000Z',
      branch: 'main',
      commitHash: 'abc123',
    },
  };
}

function run(options: {
  state: 'running' | 'blocked' | 'failed' | 'finalizing';
  resumeAvailable?: boolean;
  resumeReason?: 'successful-results-not-checkpointed' | 'resume-execution-ambiguous' | 'finalization-unprepared' | 'run-failed';
  completedBaselineId?: string;
  prepared?: boolean;
}) {
  return {
    runId: 'run-1',
    candidateAnalysisId: 'candidate-1',
    completedBaselineId: options.completedBaselineId ?? 'baseline-1',
    state: options.state,
    startedAt: '2026-07-22T08:00:00.000Z',
    updatedAt: '2026-07-22T08:10:00.000Z',
    source: 'dashboard',
    branch: 'main',
    commitHash: 'def456',
    counts: { total: 2, pending: 1, running: 0, succeeded: 1, failed: 0 },
    blocked: null,
    lastProviderLimit: null,
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
          reason: options.resumeReason ?? 'run-failed',
        },
  };
}
