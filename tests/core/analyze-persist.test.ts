import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistFullAnalysis } from '../../packages/core/src/commands/analyze-persist.js';
import type { AnalyzeCoreResult } from '../../packages/core/src/commands/analyze-core.js';
import {
  getProjectBySlug,
  registerProject,
  resetRegistryStore,
} from '../../packages/core/src/config/registry.js';
import {
  buildAnalysisFilename,
  clearLatestCache,
  readAnalysis,
  readDiff,
  readHistory,
  readLatest,
  removeFromHistory,
  resetAnalysisStore,
  writeAnalysis,
  writeDiff,
  writeLatest,
} from '../../packages/core/src/lib/analysis-store.js';
import type {
  AnalysisSnapshot,
  DiffSnapshot,
  LatestSnapshot,
} from '../../packages/core/src/types/snapshot.js';

const repositories: string[] = [];
const originalHome = process.env.TRUECOURSE_HOME;
let truecourseHome: string;

function graph(): AnalyzeCoreResult['graph'] {
  return {
    services: [], serviceDependencies: [], layers: [], modules: [], methods: [],
    moduleDeps: [], methodDeps: [], databases: [], databaseConnections: [], flows: [],
  };
}

function coreResult(): AnalyzeCoreResult {
  return {
    mode: 'full',
    analysisId: 'candidate-analysis',
    now: '2026-07-19T12:00:00.000Z',
    branch: 'main',
    commitHash: 'candidate123',
    architecture: 'monolith',
    metadata: { stable: 'metadata', omittedByJson: undefined },
    graph: graph(),
    changedFiles: [],
    pipelineResult: {
      serviceDescriptions: [], added: [], resolved: [], unchanged: [], resolvedRefs: [],
    },
    usage: [],
    latestBaseline: null,
    previousAnalysisId: null,
    analysisResult: { fileAnalyses: [] } as AnalyzeCoreResult['analysisResult'],
  };
}

function completedBaseline(): { snapshot: AnalysisSnapshot; latest: LatestSnapshot } {
  const snapshot: AnalysisSnapshot = {
    id: 'safe-baseline',
    createdAt: '2026-07-18T12:00:00.000Z',
    branch: 'main',
    commitHash: 'baseline123',
    architecture: 'monolith',
    status: 'completed',
    metadata: null,
    graph: graph(),
    violations: { added: [], resolved: [], previousAnalysisId: null },
    usage: [],
  };
  const filename = buildAnalysisFilename(snapshot.id, snapshot.createdAt);
  return {
    snapshot,
    latest: {
      head: filename,
      analysis: {
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        branch: snapshot.branch,
        commitHash: snapshot.commitHash,
        architecture: snapshot.architecture,
        metadata: snapshot.metadata,
        status: 'completed',
      },
      graph: snapshot.graph,
      violations: [],
    },
  };
}

beforeEach(() => {
  truecourseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-analyze-persist-home-'));
  process.env.TRUECOURSE_HOME = truecourseHome;
  resetAnalysisStore();
  resetRegistryStore();
});

afterEach(() => {
  clearLatestCache();
  resetAnalysisStore();
  resetRegistryStore();
  if (originalHome === undefined) delete process.env.TRUECOURSE_HOME;
  else process.env.TRUECOURSE_HOME = originalHome;
  fs.rmSync(truecourseHome, { recursive: true, force: true });
  for (const repository of repositories.splice(0)) {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

describe('full analysis persistence', () => {
  it('promotes a first completed analysis before updating its secondary projections', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-analyze-persist-'));
    repositories.push(repoPath);
    const project = await registerProject(repoPath, 'First analysis');
    const core = coreResult();

    const result = await persistFullAnalysis(project, core, Date.now());

    await expect(readAnalysis(repoPath, result.filename)).resolves.toMatchObject({ id: core.analysisId });
    await expect(readLatest(repoPath)).resolves.toMatchObject({
      analysis: { id: core.analysisId, metadata: { stable: 'metadata' } },
    });
    await expect(readHistory(repoPath)).resolves.toMatchObject({
      analyses: [expect.objectContaining({ id: core.analysisId })],
    });
    await expect(getProjectBySlug(project.slug)).resolves.toMatchObject({
      lastAnalyzed: core.now,
    });

    const currentDiff = {
      id: 'current-diff',
      baseAnalysisId: core.analysisId,
    } as DiffSnapshot;
    await writeDiff(repoPath, currentDiff);

    await expect(persistFullAnalysis(project, core, Date.now())).resolves.toMatchObject({
      analysisId: core.analysisId,
    });
    await expect(readHistory(repoPath)).resolves.toMatchObject({
      analyses: [expect.objectContaining({ id: core.analysisId })],
    });
    await expect(readDiff(repoPath)).resolves.toEqual(currentDiff);
  });

  it('does not replace a completed baseline that changed after analysis started', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-analyze-persist-'));
    repositories.push(repoPath);
    const project = await registerProject(repoPath, 'Stale analysis');
    const baseline = completedBaseline();
    await writeAnalysis(repoPath, baseline.snapshot);
    await writeLatest(repoPath, baseline.latest);
    const core = coreResult();
    const candidateFilename = buildAnalysisFilename(core.analysisId, core.now);

    await expect(persistFullAnalysis(project, core, Date.now())).rejects.toThrow(/baseline changed/i);

    await expect(readLatest(repoPath)).resolves.toEqual(baseline.latest);
    await expect(readAnalysis(repoPath, candidateFilename)).resolves.toBeNull();
    await expect(readHistory(repoPath)).resolves.toEqual({ analyses: [] });
  });

  it('repairs a committed ancestor after a newer analysis becomes active', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-analyze-persist-'));
    repositories.push(repoPath);
    const project = await registerProject(repoPath, 'Delayed projection');
    const first = coreResult();
    await persistFullAnalysis(project, first, Date.now());

    const firstLatest = await readLatest(repoPath);
    const second = coreResult();
    second.analysisId = 'newer-analysis';
    second.now = '2026-07-20T12:00:00.000Z';
    second.commitHash = 'newer456';
    second.latestBaseline = firstLatest;
    second.previousAnalysisId = first.analysisId;
    await persistFullAnalysis(project, second, Date.now());

    await removeFromHistory(repoPath, first.analysisId);
    const currentDiff = {
      id: 'newer-diff',
      baseAnalysisId: second.analysisId,
    } as DiffSnapshot;
    await writeDiff(repoPath, currentDiff);

    await expect(persistFullAnalysis(project, first, Date.now())).resolves.toMatchObject({
      analysisId: first.analysisId,
    });
    await expect(readLatest(repoPath)).resolves.toMatchObject({
      analysis: { id: second.analysisId },
    });
    await expect(readHistory(repoPath)).resolves.toMatchObject({
      analyses: [
        expect.objectContaining({ id: first.analysisId }),
        expect.objectContaining({ id: second.analysisId }),
      ],
    });
    await expect(readDiff(repoPath)).resolves.toEqual(currentDiff);
    await expect(getProjectBySlug(project.slug)).resolves.toMatchObject({
      lastAnalyzed: second.now,
    });
  });
});
