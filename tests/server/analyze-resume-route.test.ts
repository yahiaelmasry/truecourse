import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { Express } from 'express';

const doubles = vi.hoisted(() => ({
  capabilities: ['local-filesystem'] as string[],
  readAnalyzeRunStatus: vi.fn(),
  resumeAnalyzeInProcess: vi.fn(),
  withLogger: vi.fn(async (_config, run: () => Promise<unknown>) => run()),
  createSocketTracker: vi.fn(() => ({ start() {}, done() {}, error() {}, detail() {} })),
  emitAnalysisComplete: vi.fn(),
  emitAnalysisProgress: vi.fn(),
  emitViolationsReady: vi.fn(),
  errorHandler: vi.fn(),
}));

vi.mock('@truecourse/core/commands/analyze-run-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/commands/analyze-run-status')>();
  return { ...actual, readAnalyzeRunStatus: doubles.readAnalyzeRunStatus };
});

vi.mock('@truecourse/core/commands/analyze-in-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/commands/analyze-in-process')>();
  return { ...actual, resumeAnalyzeInProcess: doubles.resumeAnalyzeInProcess };
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

vi.mock('../../apps/dashboard/server/src/middleware/error.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/dashboard/server/src/middleware/error.js')>();
  return {
    ...actual,
    errorHandler: (
      error: Parameters<typeof actual.errorHandler>[0],
      request: Parameters<typeof actual.errorHandler>[1],
      response: Parameters<typeof actual.errorHandler>[2],
      next: Parameters<typeof actual.errorHandler>[3],
    ) => {
      doubles.errorHandler(error, request, response, next);
      return actual.errorHandler(error, request, response, next);
    },
  };
});

import { createApp } from '../../apps/dashboard/server/src/app.js';
import { setupTestFixture, teardownTestFixture, type TestFixture } from '../helpers/test-db.js';
import { isAnalysisActive } from '@truecourse/core/services/analysis-registry';
import {
  AnalysisResumeUnavailableError,
  AnalysisSessionLimitError,
} from '@truecourse/core/commands/analyze-in-process';
import { LlmSessionLimitError } from '@truecourse/shared/llm';
import { writeLatest } from '../../packages/core/src/lib/analysis-store.js';
import type { LatestSnapshot } from '../../packages/core/src/types/snapshot.js';

describe('dashboard Analyze Resume route', () => {
  let app: Express;
  let fixture: TestFixture;

  beforeEach(async () => {
    doubles.capabilities = ['local-filesystem'];
    doubles.readAnalyzeRunStatus.mockReset();
    doubles.readAnalyzeRunStatus.mockResolvedValue(resumableStatus());
    doubles.resumeAnalyzeInProcess.mockReset();
    doubles.withLogger.mockReset();
    doubles.withLogger.mockImplementation(async (_config, run: () => Promise<unknown>) => run());
    doubles.createSocketTracker.mockClear();
    doubles.emitAnalysisComplete.mockReset();
    doubles.emitAnalysisProgress.mockReset();
    doubles.emitViolationsReady.mockReset();
    doubles.errorHandler.mockClear();
    fixture = await setupTestFixture();
    app = createApp({ serveStatic: false });
  });

  afterEach(async () => {
    await teardownTestFixture(fixture.project.slug);
  });

  it('denies hosted access before reading local attempted-run storage', async () => {
    doubles.capabilities = [];

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(404);

    expect(doubles.readAnalyzeRunStatus).not.toHaveBeenCalled();
    expect(doubles.resumeAnalyzeInProcess).not.toHaveBeenCalled();
  });

  it('rejects an unavailable or non-latest attempt before accepting work', async () => {
    doubles.readAnalyzeRunStatus.mockResolvedValueOnce(unavailableStatus());
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(409);

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/older-run/resume`)
      .expect(409);

    expect(doubles.withLogger).not.toHaveBeenCalled();
    expect(doubles.resumeAnalyzeInProcess).not.toHaveBeenCalled();
  });

  it('rejects a run whose completed baseline is no longer active', async () => {
    const status = resumableStatus();
    doubles.readAnalyzeRunStatus.mockResolvedValueOnce({
      ...status,
      activeCompletedAnalysis: {
        ...status.activeCompletedAnalysis,
        analysisId: 'newer-completed-analysis',
      },
    });

    const response = await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(409);

    expect(response.body.error).toMatch(/active completed analysis changed/i);
    expect(doubles.resumeAnalyzeInProcess).not.toHaveBeenCalled();
  });

  it('admits prepared finalization recovery after the candidate became active', async () => {
    const status = resumableStatus();
    doubles.readAnalyzeRunStatus.mockResolvedValueOnce({
      ...status,
      latestAttempt: {
        ...status.latestAttempt,
        state: 'finalizing',
        counts: null,
      },
      activeCompletedAnalysis: {
        ...status.activeCompletedAnalysis,
        analysisId: 'candidate-analysis',
      },
    });
    doubles.resumeAnalyzeInProcess.mockResolvedValueOnce({ analysisId: 'candidate-analysis' });

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(202);

    await vi.waitFor(() => {
      expect(doubles.emitAnalysisComplete).toHaveBeenCalledWith(
        fixture.project.slug,
        'candidate-analysis',
      );
    });
  });

  it('admits an idempotent retry when the completed candidate is already active', async () => {
    const status = resumableStatus();
    doubles.readAnalyzeRunStatus.mockResolvedValueOnce({
      ...status,
      latestAttempt: {
        ...status.latestAttempt,
        state: 'completed',
        resume: {
          available: false,
          scope: 'structural',
          reason: 'run-completed',
        },
      },
      activeCompletedAnalysis: {
        ...status.activeCompletedAnalysis,
        analysisId: 'candidate-analysis',
      },
    });
    doubles.resumeAnalyzeInProcess.mockResolvedValueOnce({ analysisId: 'candidate-analysis' });

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(202);

    await vi.waitFor(() => {
      expect(doubles.emitAnalysisComplete).toHaveBeenCalledWith(
        fixture.project.slug,
        'candidate-analysis',
      );
    });
  });

  it('accepts one exact Resume while protecting it from duplicate, replacement, and cancellation', async () => {
    const execution = deferred<{ analysisId: string }>();
    doubles.resumeAnalyzeInProcess.mockReturnValueOnce(execution.promise);
    await writeLatest(fixture.repoPath, completedLatest());
    const latestPath = path.join(fixture.repoPath, '.truecourse', 'LATEST.json');
    const completedBaselineBefore = fs.readFileSync(latestPath);

    const accepted = await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(202);

    expect(accepted.body).toEqual({
      message: 'Analysis Resume started',
      repoId: fixture.project.slug,
      runId: 'interrupted-run',
      mode: 'resume',
    });
    expect(doubles.resumeAnalyzeInProcess).toHaveBeenCalledWith(
      expect.objectContaining({ path: fixture.repoPath }),
      expect.objectContaining({ runId: 'interrupted-run' }),
    );
    const resumeOptions = doubles.resumeAnalyzeInProcess.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(resumeOptions).not.toHaveProperty('signal');

    const activeStatus = await request(app)
      .get(`/api/repos/${fixture.project.slug}/analyses/status`)
      .expect(200);
    expect(activeStatus.body.activeMode).toBe('resume');

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(409);
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(409);
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/cancel`)
      .expect(409);
    expect(fs.readFileSync(latestPath)).toEqual(completedBaselineBefore);

    execution.resolve({ analysisId: 'resumed-analysis' });
    await vi.waitFor(() => {
      expect(doubles.emitViolationsReady).toHaveBeenCalledWith(
        fixture.project.slug,
        'resumed-analysis',
      );
      expect(doubles.emitAnalysisComplete).toHaveBeenCalledWith(
        fixture.project.slug,
        'resumed-analysis',
      );
      expect(isAnalysisActive(fixture.project.slug)).toBe(false);
    });
  });

  it('keeps ownership until request-scoped logger cleanup completes', async () => {
    const cleanupStarted = deferred<void>();
    const finishCleanup = deferred<void>();
    doubles.withLogger.mockImplementationOnce(async (_config, run: () => Promise<unknown>) => {
      await run();
      cleanupStarted.resolve();
      await finishCleanup.promise;
    });
    doubles.resumeAnalyzeInProcess.mockResolvedValueOnce({ analysisId: 'resumed-analysis' });

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(202);
    await cleanupStarted.promise;

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(409);

    finishCleanup.resolve();
    await vi.waitFor(() => expect(isAnalysisActive(fixture.project.slug)).toBe(false));
  });

  it('communicates production revalidation failure after acceptance and releases ownership', async () => {
    doubles.resumeAnalyzeInProcess.mockRejectedValueOnce(
      new AnalysisResumeUnavailableError('work-plan-changed'),
    );

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(202);

    await vi.waitFor(() => {
      expect(doubles.emitAnalysisProgress).toHaveBeenCalledWith(
        fixture.project.slug,
        expect.objectContaining({
          step: 'error',
          detail: expect.stringMatching(/revalidation.*work-plan-changed/i),
        }),
        'resume',
      );
      expect(isAnalysisActive(fixture.project.slug)).toBe(false);
    });
  });

  it('surfaces provider reset information when Resume reaches another session limit', async () => {
    doubles.resumeAnalyzeInProcess.mockRejectedValueOnce(
      new AnalysisSessionLimitError(
        new LlmSessionLimitError('Jul 23 at 8:00 PM (Africa/Cairo)'),
      ),
    );

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(202);

    await vi.waitFor(() => {
      expect(doubles.emitAnalysisProgress).toHaveBeenCalledWith(
        fixture.project.slug,
        expect.objectContaining({
          step: 'error',
          detail: expect.stringMatching(/Jul 23 at 8:00 PM.*LATEST\.json.*completed analysis remains unchanged.*Resume paused again/i),
        }),
        'resume',
      );
    });
  });

  it('releases the repository when logger setup fails before acceptance', async () => {
    doubles.withLogger.mockRejectedValueOnce(new Error('logger setup failed'));

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(500);

    expect(doubles.resumeAnalyzeInProcess).not.toHaveBeenCalled();
    expect(isAnalysisActive(fixture.project.slug)).toBe(false);
  });

  it('does not re-enter HTTP error handling when logger teardown fails after acceptance', async () => {
    doubles.withLogger.mockImplementationOnce(async (_config, run: () => Promise<unknown>) => {
      await run();
      throw new Error('logger teardown failed');
    });
    doubles.resumeAnalyzeInProcess.mockResolvedValueOnce({ analysisId: 'resumed-analysis' });

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/interrupted-run/resume`)
      .expect(202);

    await vi.waitFor(() => expect(isAnalysisActive(fixture.project.slug)).toBe(false));
    expect(doubles.errorHandler).not.toHaveBeenCalled();
  });
});

function resumableStatus() {
  return {
    latestAttempt: {
      runId: 'interrupted-run',
      candidateAnalysisId: 'candidate-analysis',
      completedBaselineId: 'completed-analysis',
      state: 'blocked',
      startedAt: '2026-07-22T08:00:00.000Z',
      updatedAt: '2026-07-22T09:00:00.000Z',
      source: 'dashboard',
      branch: 'main',
      commitHash: 'def456',
      counts: { total: 2, succeeded: 1, pending: 1, running: 0, failed: 0 },
      lastProviderLimit: {
        reason: 'provider-session-limit',
        resetHint: 'Jul 23 at 8:00 PM (Africa/Cairo)',
        blockedAt: '2026-07-22T09:00:00.000Z',
      },
      resume: {
        available: true,
        scope: 'structural',
        mode: 'resume',
        requiresLatestAttempt: true,
        requiresRevalidation: true,
      },
    },
    activeCompletedAnalysis: {
      analysisId: 'completed-analysis',
      createdAt: '2026-07-21T08:00:00.000Z',
      branch: 'main',
      commitHash: 'abc123',
    },
  };
}

function unavailableStatus() {
  const status = resumableStatus();
  return {
    ...status,
    latestAttempt: {
      ...status.latestAttempt,
      resume: {
        available: false,
        scope: 'structural',
        reason: 'run-not-resumable',
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function completedLatest(): LatestSnapshot {
  return {
    head: 'analysis-completed.json',
    analysis: {
      id: 'completed-analysis',
      createdAt: '2026-07-21T08:00:00.000Z',
      branch: 'main',
      commitHash: 'abc123',
      architecture: 'monolith',
      metadata: null,
      status: 'completed',
    },
    graph: {
      services: [],
      serviceDependencies: [],
      layers: [],
      modules: [],
      methods: [],
      moduleDeps: [],
      methodDeps: [],
      databases: [],
      databaseConnections: [],
      flows: [],
    },
    violations: [],
  };
}
