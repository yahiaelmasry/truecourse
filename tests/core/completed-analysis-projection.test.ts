import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAnalysisFilename,
  clearLatestCache,
  promoteCompletedAnalysisBaseline,
  readDiff,
  readHistory,
  writeDiff,
} from '../../packages/core/src/lib/analysis-store';
import {
  acquireAnalyzeLock,
  releaseAnalyzeLock,
} from '../../packages/core/src/lib/analyze-lock';
import {
  getProjectBySlug,
  registerProject,
  resetRegistryStore,
} from '../../packages/core/src/config/registry';
import { projectCompletedAnalysis } from '../../packages/core/src/lib/completed-analysis-projection';
import type {
  AnalysisSnapshot,
  DiffSnapshot,
  HistoryEntry,
  LatestSnapshot,
  ViolationRecord,
} from '../../packages/core/src/types/snapshot';

const originalHome = process.env.TRUECOURSE_HOME;
let home: string;
let repoPath: string;
let projectSlug: string;

const emptyGraph: AnalysisSnapshot['graph'] = {
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
};

function snapshot(id: string, createdAt: string, previousAnalysisId: string | null): AnalysisSnapshot {
  return {
    id,
    createdAt,
    branch: 'main',
    commitHash: `commit-${id}`,
    architecture: 'monolith',
    status: 'completed',
    metadata: { isDiffAnalysis: false },
    graph: emptyGraph,
    violations: { added: [], resolved: [], previousAnalysisId },
    usage: [],
  };
}

function latestFor(value: AnalysisSnapshot): LatestSnapshot {
  return {
    head: buildAnalysisFilename(value.id, value.createdAt),
    analysis: {
      id: value.id,
      createdAt: value.createdAt,
      branch: value.branch,
      commitHash: value.commitHash,
      architecture: value.architecture,
      metadata: value.metadata,
      status: 'completed',
    },
    graph: value.graph,
    violations: value.violations.added.map((violation) => ({
      ...violation,
      targetServiceName: null,
      targetModuleName: null,
      targetMethodName: null,
      targetDatabaseName: null,
    })),
  };
}

function finding(
  id: string,
  severity: ViolationRecord['severity'],
  value: AnalysisSnapshot,
): ViolationRecord {
  return {
    id,
    type: 'code',
    category: 'rule',
    subcategory: null,
    title: `Finding ${id}`,
    content: 'content',
    severity,
    status: 'new',
    targetServiceId: null,
    targetDatabaseId: null,
    targetModuleId: null,
    targetMethodId: null,
    targetTable: null,
    relatedServiceId: null,
    relatedModuleId: null,
    fixPrompt: null,
    ruleKey: 'test/rule',
    firstSeenAnalysisId: value.id,
    firstSeenAt: value.createdAt,
    previousViolationId: null,
    resolvedAt: null,
    filePath: 'src/example.ts',
    lineStart: 1,
    lineEnd: 1,
    columnStart: 1,
    columnEnd: 2,
    snippet: 'x',
    createdAt: value.createdAt,
  };
}

function historyFor(value: AnalysisSnapshot): HistoryEntry {
  const bySeverity: HistoryEntry['counts']['violations']['bySeverity'] = {
    info: 0, low: 0, medium: 0, high: 0, critical: 0,
  };
  for (const violation of value.violations.added) bySeverity[violation.severity] += 1;
  return {
    id: value.id,
    filename: buildAnalysisFilename(value.id, value.createdAt),
    createdAt: value.createdAt,
    branch: value.branch,
    commitHash: value.commitHash,
    metadata: value.metadata,
    counts: {
      services: 0,
      modules: 0,
      methods: 0,
      violations: {
        new: value.violations.added.length,
        unchanged: 0,
        resolved: value.violations.resolved.length,
        bySeverity,
      },
    },
    usage: { totalTokens: 0, totalCostUsd: '0', durationMs: 0, provider: '' },
  };
}

async function underLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
  await acquireAnalyzeLock(repoPath);
  try {
    return await operation();
  } finally {
    await releaseAnalyzeLock(repoPath);
  }
}

async function promote(value: AnalysisSnapshot, expectedBaseline: LatestSnapshot | null): Promise<void> {
  await underLifecycleLock(async () => {
    await promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline,
      snapshot: value,
      latest: latestFor(value),
    });
  });
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-projection-home-'));
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-projection-repo-'));
  process.env.TRUECOURSE_HOME = home;
  clearLatestCache();
  resetRegistryStore();
  projectSlug = (await registerProject(repoPath, 'Projection Repo')).slug;
});

afterEach(() => {
  resetRegistryStore();
  clearLatestCache();
  if (originalHome === undefined) delete process.env.TRUECOURSE_HOME;
  else process.env.TRUECOURSE_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('completed-analysis projection coordinator', () => {
  it('projects history, current diff state, and registry idempotently', async () => {
    const current = snapshot('current-analysis', '2026-05-02T00:00:00.000Z', null);
    await promote(current, null);
    const staleDiff = { id: 'stale', baseAnalysisId: 'older' } as DiffSnapshot;
    await writeDiff(repoPath, staleDiff);

    const intent = { projectSlug, promotedSnapshot: current, historyEntry: historyFor(current) };
    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, intent))).resolves.toEqual({
      activeAnalysisId: current.id,
      generations: 0,
      history: 'inserted',
      diff: 'removed-stale',
      registry: 'updated',
    });
    expect((await readHistory(repoPath)).analyses).toEqual([intent.historyEntry]);
    expect(await readDiff(repoPath)).toBeNull();
    expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBe(current.createdAt);

    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, intent))).resolves.toEqual({
      activeAnalysisId: current.id,
      generations: 0,
      history: 'present',
      diff: 'absent',
      registry: 'present',
    });
  });

  it('normalizes a hosted repository-key alias to the registry slug', async () => {
    const current = snapshot('hosted-analysis', '2026-05-02T00:00:00.000Z', null);
    await promote(current, null);

    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, {
      projectSlug: repoPath,
      promotedSnapshot: current,
      historyEntry: historyFor(current),
    }))).resolves.toMatchObject({
      activeAnalysisId: current.id,
      registry: 'updated',
    });
    expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBe(current.createdAt);
  });

  it.each(['after-history', 'after-diff', 'after-registry'] as const)(
    'recovers exactly after an injected %s stop',
    async (faultPoint) => {
      const current = snapshot(`analysis-${faultPoint}`, '2026-05-02T00:00:00.000Z', null);
      await promote(current, null);
      await writeDiff(repoPath, { id: 'stale', baseAnalysisId: 'older' } as DiffSnapshot);
      const intent = { projectSlug, promotedSnapshot: current, historyEntry: historyFor(current) };

      await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, intent, {
        faultInjector: (point) => {
          if (point === faultPoint) throw new Error(`injected ${faultPoint}`);
        },
      }))).rejects.toThrow(`injected ${faultPoint}`);

      expect((await readHistory(repoPath)).analyses).toEqual([intent.historyEntry]);
      expect(await readDiff(repoPath)).toEqual(
        faultPoint === 'after-history' ? { id: 'stale', baseAnalysisId: 'older' } : null,
      );
      expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBe(
        faultPoint === 'after-registry' ? current.createdAt : undefined,
      );

      await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, intent))).resolves.toMatchObject({
        activeAnalysisId: current.id,
        generations: 0,
      });
      expect((await readHistory(repoPath)).analyses).toEqual([intent.historyEntry]);
      expect(await readDiff(repoPath)).toBeNull();
      expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBe(current.createdAt);
    },
  );

  it('repairs an older committed target without regressing current projections', async () => {
    const first = snapshot('analysis-a', '2026-05-01T00:00:00.000Z', null);
    await promote(first, null);
    const second = snapshot('analysis-b', '2026-05-02T00:00:00.000Z', first.id);
    await promote(second, latestFor(first));
    const currentDiff = { id: 'current-diff', baseAnalysisId: second.id } as DiffSnapshot;
    await writeDiff(repoPath, currentDiff);

    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, {
      projectSlug,
      promotedSnapshot: first,
      historyEntry: historyFor(first),
    }))).resolves.toEqual({
      activeAnalysisId: second.id,
      generations: 1,
      history: 'inserted',
      diff: 'current',
      registry: 'updated',
    });
    expect(await readDiff(repoPath)).toEqual(currentDiff);
    expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBe(second.createdAt);
  });

  it('rejects invalid intent, foreign lineage, and wrong registry mapping before mutation', async () => {
    const current = snapshot('analysis-current', '2026-05-02T00:00:00.000Z', null);
    await promote(current, null);
    const staleDiff = { id: 'stale', baseAnalysisId: 'older' } as DiffSnapshot;
    await writeDiff(repoPath, staleDiff);
    const historyEntry = historyFor(current);

    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, {
      projectSlug,
      promotedSnapshot: current,
      historyEntry: {
        ...historyEntry,
        counts: { ...historyEntry.counts, services: 1 },
      },
    }))).rejects.toThrow('History entry does not match the promoted snapshot');

    const foreign = snapshot('analysis-foreign', '2026-05-01T00:00:00.000Z', null);
    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, {
      projectSlug,
      promotedSnapshot: foreign,
      historyEntry: historyFor(foreign),
    }))).rejects.toThrow('Promoted snapshot is not in the active completed-analysis lineage');

    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, {
      projectSlug: 'wrong-project',
      promotedSnapshot: current,
      historyEntry,
    }))).rejects.toThrow('Projection project does not match the repository key');

    expect((await readHistory(repoPath)).analyses).toEqual([]);
    expect(await readDiff(repoPath)).toEqual(staleDiff);
    expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBeUndefined();
  });

  it('rejects false active counts and severity buckets before mutation', async () => {
    const current = snapshot('analysis-counts', '2026-05-02T00:00:00.000Z', null);
    current.violations.added = [finding('critical-finding', 'critical', current)];
    await promote(current, null);
    const staleDiff = { id: 'stale', baseAnalysisId: 'older' } as DiffSnapshot;
    await writeDiff(repoPath, staleDiff);
    const correct = historyFor(current);

    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, {
      projectSlug,
      promotedSnapshot: current,
      historyEntry: {
        ...correct,
        counts: {
          ...correct.counts,
          violations: {
            ...correct.counts.violations,
            bySeverity: { info: 1, low: 0, medium: 0, high: 0, critical: 0 },
          },
        },
      },
    }))).rejects.toThrow('History entry does not match the promoted snapshot');

    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, {
      projectSlug,
      promotedSnapshot: current,
      historyEntry: {
        ...correct,
        counts: {
          ...correct.counts,
          violations: {
            ...correct.counts.violations,
            unchanged: 1,
            bySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 2 },
          },
        },
      },
    }))).rejects.toThrow('History entry does not match the promoted snapshot');

    expect((await readHistory(repoPath)).analyses).toEqual([]);
    expect(await readDiff(repoPath)).toEqual(staleDiff);
    expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBeUndefined();
  });

  it('rejects malformed per-call usage before mutation', async () => {
    const current = snapshot('analysis-usage', '2026-05-02T00:00:00.000Z', null);
    current.usage = [{
      provider: 'claude-code',
      callType: 'analyze.code',
      inputTokens: -1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: '',
      durationMs: 1,
      createdAt: current.createdAt,
    }];
    await promote(current, null);
    const staleDiff = { id: 'stale', baseAnalysisId: 'older' } as DiffSnapshot;
    await writeDiff(repoPath, staleDiff);

    await expect(underLifecycleLock(() => projectCompletedAnalysis(repoPath, {
      projectSlug,
      promotedSnapshot: current,
      historyEntry: {
        ...historyFor(current),
        usage: { totalTokens: 0, totalCostUsd: '0', durationMs: 1, provider: 'claude-code' },
      },
    }))).rejects.toThrow('Promoted snapshot contains invalid usage accounting');

    expect((await readHistory(repoPath)).analyses).toEqual([]);
    expect(await readDiff(repoPath)).toEqual(staleDiff);
    expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBeUndefined();
  });
});
