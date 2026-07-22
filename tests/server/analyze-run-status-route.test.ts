import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

const readAnalyzeRunStatus = vi.hoisted(() => vi.fn());
const capabilities = vi.hoisted(() => ({ value: ['local-filesystem'] as string[] }));

vi.mock('@truecourse/core/commands/analyze-run-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@truecourse/core/commands/analyze-run-status')>();
  return { ...actual, readAnalyzeRunStatus };
});

vi.mock('../../apps/dashboard/server/src/ee-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/dashboard/server/src/ee-loader.js')>();
  return { ...actual, getCapabilities: () => capabilities.value };
});

import { createApp } from '../../apps/dashboard/server/src/app.js';
import { setupTestFixture, teardownTestFixture, type TestFixture } from '../helpers/test-db.js';
import { getRegistryPath } from '../../packages/core/src/config/paths.js';

describe('dashboard analyze-run status route', () => {
  let app: Express;
  let fixture: TestFixture;

  beforeEach(async () => {
    readAnalyzeRunStatus.mockReset();
    capabilities.value = ['local-filesystem'];
    fixture = await setupTestFixture();
    app = createApp({ serveStatic: false });
  });

  afterEach(async () => {
    await teardownTestFixture(fixture.project.slug);
  });

  it('reports the latest certified attempt separately from completed truth', async () => {
    const registryBefore = fs.readFileSync(getRegistryPath());
    const repositoryBefore = snapshotTree(path.join(fixture.repoPath, '.truecourse'));
    readAnalyzeRunStatus.mockResolvedValueOnce({
      latestAttempt: {
        runId: 'attempt-2',
        candidateAnalysisId: 'candidate-analysis',
        completedBaselineId: 'completed-analysis',
        state: 'running',
        startedAt: '2026-07-22T08:00:00.000Z',
        updatedAt: '2026-07-22T09:00:00.000Z',
        source: 'dashboard',
        branch: 'feature/resume',
        commitHash: 'def456',
        counts: { total: 100, succeeded: 60, pending: 40, running: 0, failed: 0 },
        blocked: null,
        lastProviderLimit: {
          reason: 'provider-session-limit',
          resetHint: 'tomorrow 8pm (Africa/Cairo)',
          blockedAt: '2026-07-22T08:45:00.000Z',
          resetAt: '2026-07-23T17:00:00.000Z',
        },
        finalization: null,
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
        createdAt: '2026-07-21T09:00:00.000Z',
        branch: 'main',
        commitHash: 'abc123',
      },
    });

    const response = await request(app)
      .get(`/api/repos/${fixture.project.slug}/analyses/status`)
      .expect(200);

    expect(response.body).toEqual({
      activeMode: null,
      latestAttempt: {
        runId: 'attempt-2',
        state: 'running',
        startedAt: '2026-07-22T08:00:00.000Z',
        updatedAt: '2026-07-22T09:00:00.000Z',
        source: 'dashboard',
        branch: 'feature/resume',
        commitHash: 'def456',
        counts: { total: 100, succeeded: 60, pending: 40, running: 0, failed: 0 },
        lastProviderLimit: {
          resetHint: 'tomorrow 8pm (Africa/Cairo)',
          blockedAt: '2026-07-22T08:45:00.000Z',
          resetAt: '2026-07-23T17:00:00.000Z',
        },
        resume: {
          available: true,
          scope: 'structural',
          mode: 'resume',
          requiresLatestAttempt: true,
          requiresRevalidation: true,
        },
        startOver: {
          available: false,
          reason: 'recovery-required',
        },
      },
      activeCompletedAnalysis: {
        analysisId: 'completed-analysis',
        createdAt: '2026-07-21T09:00:00.000Z',
        branch: 'main',
        commitHash: 'abc123',
      },
    });
    expect(readAnalyzeRunStatus).toHaveBeenCalledWith(fixture.repoPath);
    expect(fs.readFileSync(getRegistryPath())).toEqual(registryBefore);
    expect(snapshotTree(path.join(fixture.repoPath, '.truecourse'))).toEqual(repositoryBefore);
  });

  it.each([
    {
      name: 'blocked resumable',
      attempt: attemptedRun({ state: 'blocked', resumeAvailable: true }),
      expected: {
        available: true,
        requiresExactAttempt: true,
        mayRepeatPaidCalls: true,
      },
    },
    {
      name: 'ambiguous execution',
      attempt: attemptedRun({ state: 'running', resumeReason: 'resume-execution-ambiguous' }),
      expected: { available: false, reason: 'resume-execution-ambiguous' },
    },
    {
      name: 'failed prepared finalization',
      attempt: attemptedRun({ state: 'failed', resumeReason: 'run-failed', prepared: true }),
      expected: { available: false, reason: 'recovery-required' },
    },
    {
      name: 'superseded attempt',
      attempt: attemptedRun({
        state: 'blocked',
        resumeAvailable: true,
        completedBaselineId: 'older-analysis',
      }),
      expected: { available: false, reason: 'attempt-superseded' },
    },
  ])('projects authoritative Start over safety for $name', async ({ attempt, expected }) => {
    readAnalyzeRunStatus.mockResolvedValueOnce({
      latestAttempt: attempt,
      activeCompletedAnalysis: {
        analysisId: 'completed-analysis',
        createdAt: '2026-07-21T09:00:00.000Z',
        branch: 'main',
        commitHash: 'abc123',
      },
    });

    const response = await request(app)
      .get(`/api/repos/${fixture.project.slug}/analyses/status`)
      .expect(200);

    expect(response.body.latestAttempt.startOver).toEqual(expected);
  });

  it('does not expose local attempted-run storage without filesystem capability', async () => {
    capabilities.value = [];
    const registryBefore = fs.readFileSync(getRegistryPath());
    const repositoryBefore = snapshotTree(path.join(fixture.repoPath, '.truecourse'));

    await request(app)
      .get(`/api/repos/${fixture.project.slug}/analyses/status`)
      .expect(404);

    expect(readAnalyzeRunStatus).not.toHaveBeenCalled();
    expect(fs.readFileSync(getRegistryPath())).toEqual(registryBefore);
    expect(snapshotTree(path.join(fixture.repoPath, '.truecourse'))).toEqual(repositoryBefore);
  });
});

function attemptedRun(options: {
  state: 'running' | 'blocked' | 'failed';
  resumeAvailable?: boolean;
  resumeReason?: 'resume-execution-ambiguous' | 'run-failed';
  prepared?: boolean;
  completedBaselineId?: string;
}) {
  return {
    runId: 'attempt-2',
    candidateAnalysisId: 'candidate-analysis',
    completedBaselineId: options.completedBaselineId ?? 'completed-analysis',
    state: options.state,
    startedAt: '2026-07-22T08:00:00.000Z',
    updatedAt: '2026-07-22T09:00:00.000Z',
    source: 'dashboard',
    branch: 'feature/resume',
    commitHash: 'def456',
    counts: { total: 100, succeeded: 60, pending: 40, running: 0, failed: 0 },
    blocked: null,
    lastProviderLimit: null,
    finalization: options.prepared
      ? {
          finalizingAt: '2026-07-22T08:50:00.000Z',
          persistence: 'prepared',
          preparedAt: '2026-07-22T08:55:00.000Z',
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

function snapshotTree(root: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  if (!fs.existsSync(root)) return snapshot;
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) snapshot.set(path.relative(root, absolute), fs.readFileSync(absolute));
    }
  };
  visit(root);
  return snapshot;
}
