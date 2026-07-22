import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

const doubles = vi.hoisted(() => ({
  analyzeInProcess: vi.fn(),
  withLogger: vi.fn(async (_config, run: () => Promise<unknown>) => run()),
}));

vi.mock('@truecourse/core/commands/analyze-in-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/commands/analyze-in-process')>();
  return { ...actual, analyzeInProcess: doubles.analyzeInProcess };
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
    emitAnalysisProgress: vi.fn(),
    emitViolationsReady: vi.fn(),
  };
});

import { createApp } from '../../apps/dashboard/server/src/app.js';
import { setupTestFixture, teardownTestFixture, type TestFixture } from '../helpers/test-db.js';
import {
  cancelAnalysis,
  isAnalysisActive,
  tryRegisterAnalysis,
  unregisterAnalysis,
} from '../../packages/core/src/services/analysis-registry.js';

describe('dashboard analysis ownership', () => {
  let app: Express;
  let fixture: TestFixture;

  beforeEach(async () => {
    doubles.analyzeInProcess.mockReset();
    doubles.withLogger.mockReset();
    doubles.withLogger.mockImplementation(async (_config, run: () => Promise<unknown>) => run());
    fixture = await setupTestFixture();
    app = createApp({ serveStatic: false });
  });

  afterEach(async () => {
    await teardownTestFixture(fixture.project.slug);
  });

  it('keeps a canceled run owned until its handler finishes', async () => {
    const abortObserved = deferred<void>();
    const finishCanceledRun = deferred<void>();
    const finishLoggerCleanup = deferred<void>();
    const loggerCleanupStarted = deferred<void>();
    doubles.withLogger.mockImplementationOnce(async (_config, run: () => Promise<unknown>) => {
      await run();
      loggerCleanupStarted.resolve();
      await finishLoggerCleanup.promise;
    });
    doubles.analyzeInProcess.mockImplementationOnce(async (_project, options) => {
      const signal = (options as { signal: AbortSignal }).signal;
      if (signal.aborted) abortObserved.resolve();
      else {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
          abortObserved.resolve();
          resolve();
        }, { once: true }));
      }
      await finishCanceledRun.promise;
      throw new DOMException('canceled', 'AbortError');
    });

    const initialAccepted = await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' });
    expect(initialAccepted.status, JSON.stringify(initialAccepted.body)).toBe(202);
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(409);

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/cancel`)
      .expect(200);
    await abortObserved.promise;

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(409);

    finishCanceledRun.resolve();
    await loggerCleanupStarted.promise;

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(409);

    finishLoggerCleanup.resolve();
    await vi.waitFor(() => expect(isAnalysisActive(fixture.project.slug)).toBe(false));
    doubles.analyzeInProcess.mockResolvedValueOnce({ analysisId: 'next-analysis' });
    const accepted = await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  });

  it('releases ownership when logger setup fails before acceptance', async () => {
    doubles.withLogger.mockImplementationOnce(async () => {
      throw new Error('logger setup failed');
    });

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(500);

    doubles.analyzeInProcess.mockResolvedValueOnce({ analysisId: 'after-logger-failure' });
    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses`)
      .send({ mode: 'full' })
      .expect(202);
  });

  it('allows only the exact owner to release a repository claim', () => {
    const owner = tryRegisterAnalysis('repo-owned', 'first');
    expect(owner).not.toBeNull();
    unregisterAnalysis('repo-owned', new AbortController());
    expect(tryRegisterAnalysis('repo-owned', 'second')).toBeNull();
    unregisterAnalysis('repo-owned', owner!);
    expect(cancelAnalysis('repo-owned')).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
