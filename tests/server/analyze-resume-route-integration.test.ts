import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import type { Express } from 'express';

const socketDoubles = vi.hoisted(() => ({
  emitAnalysisComplete: vi.fn(),
  emitAnalysisProgress: vi.fn(),
  emitViolationsReady: vi.fn(),
}));

vi.mock('../../apps/dashboard/server/src/socket/handlers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/dashboard/server/src/socket/handlers.js')>();
  return {
    ...actual,
    createSocketTracker: () => ({ start() {}, done() {}, error() {}, detail() {} }),
    emitAnalysisComplete: socketDoubles.emitAnalysisComplete,
    emitAnalysisProgress: socketDoubles.emitAnalysisProgress,
    emitViolationsReady: socketDoubles.emitViolationsReady,
  };
});

import { createApp } from '../../apps/dashboard/server/src/app.js';
import { analyzeInProcess } from '@truecourse/core/commands/analyze-in-process';
import { readAnalyzeRunStatus } from '@truecourse/core/commands/analyze-run-status';
import { resetAnalyzeRunStorage } from '../../packages/core/src/lib/analyze-run-journal.js';
import { resetAnalysisStore } from '../../packages/core/src/lib/analysis-store.js';
import { ClaudeCodeProvider } from '../../packages/core/src/services/llm/cli-provider.js';
import { writeProjectConfig } from '../../packages/core/src/config/project-config.js';
import { setupTestFixture, teardownTestFixture, type TestFixture } from '../helpers/test-db.js';

class EmptyDirectClaudeProvider extends ClaudeCodeProvider {
  protected async spawnCLI(): Promise<string> {
    return JSON.stringify({
      structured_output: { violations: [], serviceDescriptions: [] },
    });
  }
}

describe('dashboard Analyze Resume route integration', () => {
  let app: Express;
  let fixture: TestFixture;

  beforeEach(async () => {
    resetAnalyzeRunStorage();
    resetAnalysisStore();
    socketDoubles.emitAnalysisComplete.mockReset();
    socketDoubles.emitAnalysisProgress.mockReset();
    socketDoubles.emitViolationsReady.mockReset();
    fixture = await setupTestFixture();
    fs.writeFileSync(path.join(fixture.repoPath, 'package.json'), JSON.stringify({
      name: 'dashboard-resume-route-fixture',
      type: 'module',
    }));
    fs.mkdirSync(path.join(fixture.repoPath, 'src'));
    fs.writeFileSync(
      path.join(fixture.repoPath, 'src', 'orders.ts'),
      'export class OrdersService { list(): string[] { return []; } }\n',
    );
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture.repoPath, env: gitEnv });
    execFileSync('git', ['add', '-A'], { cwd: fixture.repoPath, env: gitEnv });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], {
      cwd: fixture.repoPath,
      env: gitEnv,
    });
    await writeProjectConfig(fixture.repoPath, { enabledCategories: ['architecture'] });
    app = createApp({ serveStatic: false });
  });

  afterEach(async () => {
    await teardownTestFixture(fixture.project.slug);
    resetAnalyzeRunStorage();
    resetAnalysisStore();
  });

  it('idempotently resumes a real completed journal without replacing completed truth', async () => {
    await analyzeInProcess(fixture.project, {
      source: 'dashboard',
      provider: new EmptyDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    });
    const status = await readAnalyzeRunStatus(fixture.repoPath);
    expect(status.latestAttempt).toMatchObject({
      state: 'completed',
      resume: { available: false, reason: 'run-completed' },
    });
    expect(status.activeCompletedAnalysis?.analysisId).toBe(
      status.latestAttempt?.candidateAnalysisId,
    );
    const latestPath = path.join(fixture.repoPath, '.truecourse', 'LATEST.json');
    const completedTruthBefore = fs.readFileSync(latestPath);

    await request(app)
      .post(`/api/repos/${fixture.project.slug}/analyses/${status.latestAttempt!.runId}/resume`)
      .expect(202);

    await vi.waitFor(() => {
      expect(socketDoubles.emitAnalysisComplete).toHaveBeenCalledWith(
        fixture.project.slug,
        status.latestAttempt!.candidateAnalysisId,
      );
    });
    expect(fs.readFileSync(latestPath)).toEqual(completedTruthBefore);
    await expect(readAnalyzeRunStatus(fixture.repoPath)).resolves.toMatchObject({
      latestAttempt: { state: 'completed' },
      activeCompletedAnalysis: { analysisId: status.latestAttempt!.candidateAnalysisId },
    });
  }, 30_000);
});
