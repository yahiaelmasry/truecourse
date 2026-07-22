import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAnalyzeRunStatus } from '../../packages/core/src/commands/analyze-run-status.js';
import {
  buildAnalysisFilename,
  clearLatestCache,
  resetAnalysisStore,
  writeLatest,
} from '../../packages/core/src/lib/analysis-store.js';
import {
  dispatchAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import type { LatestSnapshot } from '../../packages/core/src/types/snapshot.js';

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-analyze-status-'));
  clearLatestCache();
  resetAnalysisStore();
  resetAnalyzeRunStorage();
});

afterEach(() => {
  resetAnalyzeRunStorage();
  resetAnalysisStore();
  clearLatestCache();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('analyze run status', () => {
  it('keeps the latest interrupted attempt separate from the active completed analysis', async () => {
    const completed = completedLatest();
    await writeLatest(repoPath, completed);
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'latest-attempt-1',
      candidateAnalysisId: 'incomplete-analysis-2',
      startedAt: '2026-07-19T10:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'def456',
      completedBaselineId: completed.analysis.id,
    });
    await sealAnalyzeRunPlan(repoPath, {
      kind: 'seal-plan',
      runId: 'latest-attempt-1',
      sealedAt: '2026-07-19T10:00:01.000Z',
      execution: {
        provider: 'claude-cli',
        requestedModel: 'sonnet',
        promptSchemaVersion: 'test-prompt-v1',
        outputSchemaVersion: 'test-output-v1',
      },
      work: [
        { workId: 'analyze:v1:service', inputFingerprint: `sha256:${'a'.repeat(64)}` },
        { workId: 'analyze:v1:module', inputFingerprint: `sha256:${'b'.repeat(64)}` },
      ],
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId: 'latest-attempt-1',
      blockedAt: '2026-07-19T10:00:02.000Z',
      resetHint: 'tomorrow 8pm (Africa/Cairo)',
    });

    const latestPath = path.join(repoPath, '.truecourse', 'LATEST.json');
    const runPath = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'latest-attempt-1.json',
    );
    const pointerPath = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'LATEST_ATTEMPT.json',
    );
    const durableBefore = [latestPath, runPath, pointerPath].map((file) => fs.readFileSync(file));

    await expect(readAnalyzeRunStatus(repoPath)).resolves.toMatchObject({
      latestAttempt: {
        runId: 'latest-attempt-1',
        candidateAnalysisId: 'incomplete-analysis-2',
        state: 'blocked',
        counts: { total: 2, succeeded: 0, pending: 2 },
        blocked: { resetHint: 'tomorrow 8pm (Africa/Cairo)' },
        lastProviderLimit: { resetHint: 'tomorrow 8pm (Africa/Cairo)' },
        resume: { available: true, mode: 'resume', requiresRevalidation: true },
      },
      activeCompletedAnalysis: {
        analysisId: 'completed-analysis-1',
        createdAt: '2026-07-19T09:00:00.000Z',
        branch: 'main',
        commitHash: 'abc123',
      },
    });
    expect([latestPath, runPath, pointerPath].map((file) => fs.readFileSync(file)))
      .toEqual(durableBefore);
  });

  it('refuses to label an invalid LATEST snapshot as completed truth', async () => {
    const invalid = completedLatest();
    invalid.head = 'wrong-analysis.json';
    await writeLatest(repoPath, invalid);

    await expect(readAnalyzeRunStatus(repoPath)).rejects.toThrow(
      /LATEST\.json is not valid completed truth/,
    );
  });

  it.each(['missing', 'legacy'] as const)(
    'does not repair a %s latest-attempt pointer while inspecting status',
    async (pointerCase) => {
      await dispatchAnalyzeRun(repoPath, {
        kind: 'begin',
        runId: `pointer-${pointerCase}-run`,
        candidateAnalysisId: `pointer-${pointerCase}-analysis`,
        startedAt: '2026-07-19T11:00:00.000Z',
        source: 'cli',
        branch: 'main',
        commitHash: 'pointer123',
        completedBaselineId: null,
      });
      const pointerPath = path.join(
        repoPath,
        '.truecourse',
        'analyses',
        'runs',
        'LATEST_ATTEMPT.json',
      );
      if (pointerCase === 'missing') {
        fs.rmSync(pointerPath);
      } else {
        fs.writeFileSync(pointerPath, JSON.stringify({
          schemaVersion: 6,
          runId: 'pointer-legacy-run',
        }));
      }
      const pointerBefore = fs.existsSync(pointerPath) ? fs.readFileSync(pointerPath) : null;

      await expect(readAnalyzeRunStatus(repoPath)).resolves.toMatchObject({
        latestAttempt: { runId: `pointer-${pointerCase}-run` },
        activeCompletedAnalysis: null,
      });

      expect(fs.existsSync(pointerPath)).toBe(pointerBefore !== null);
      if (pointerBefore !== null) expect(fs.readFileSync(pointerPath)).toEqual(pointerBefore);
    },
  );
});

function completedLatest(): LatestSnapshot {
  return {
    head: buildAnalysisFilename('completed-analysis-1', '2026-07-19T09:00:00.000Z'),
    analysis: {
      id: 'completed-analysis-1',
      createdAt: '2026-07-19T09:00:00.000Z',
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
