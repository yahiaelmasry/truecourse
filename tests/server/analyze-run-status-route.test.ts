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
        createdAt: '2026-07-21T09:00:00.000Z',
        branch: 'main',
        commitHash: 'abc123',
      },
    });

    const response = await request(app)
      .get(`/api/repos/${fixture.project.slug}/analyses/status`)
      .expect(200);

    expect(response.body).toEqual({
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
        createdAt: '2026-07-21T09:00:00.000Z',
        branch: 'main',
        commitHash: 'abc123',
      },
    });
    expect(readAnalyzeRunStatus).toHaveBeenCalledWith(fixture.repoPath);
    expect(fs.readFileSync(getRegistryPath())).toEqual(registryBefore);
    expect(snapshotTree(path.join(fixture.repoPath, '.truecourse'))).toEqual(repositoryBefore);
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
