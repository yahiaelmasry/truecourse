import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AnalyzeRunStorage,
  type StoredAnalyzeRun,
  AnalyzeRunJournalCorruptError,
  beginFinalizeAnalyzeRun,
  dispatchAnalyzeRun,
  prepareAnalyzeRunFinalization,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  setAnalyzeRunStorage,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import {
  buildAnalysisFilename,
  clearLatestCache,
  getAnalysisStore,
  promoteCompletedAnalysisBaseline,
  readHistory,
  readLatest,
  resetAnalysisStore,
  setAnalysisStore,
  type AnalysisStore,
} from '../../packages/core/src/lib/analysis-store.js';
import { finalizePreparedAnalyzeRun } from '../../packages/core/src/lib/analyze-run-finalization.js';
import { withAnalyzeLifecycleLock } from '../../packages/core/src/lib/analyze-lifecycle-lock.js';
import {
  getProjectBySlug,
  getRegistryStore,
  registerProject,
  resetRegistryStore,
  setRegistryStore,
  type RegistryStore,
} from '../../packages/core/src/config/registry.js';
import {
  certifyAnalyzeLlmRun,
  type AnalyzeLlmExecutionAdapter,
  type AnalyzeLlmExecutionOutcome,
  type CertifiedAnalyzeLlmWork,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import type { CodeViolationContext } from '../../packages/core/src/services/llm/provider.js';
import type {
  AnalysisSnapshot,
  HistoryEntry,
  LatestSnapshot,
} from '../../packages/core/src/types/snapshot.js';

const originalHome = process.env.TRUECOURSE_HOME;
let home: string;
let repoPath: string;
let projectSlug: string;
const extraPaths: string[] = [];

const graph: AnalysisSnapshot['graph'] = {
  services: [], serviceDependencies: [], layers: [], modules: [], methods: [],
  moduleDeps: [], methodDeps: [], databases: [], databaseConnections: [], flows: [],
};

const codeContext: CodeViolationContext = {
  files: [{ path: 'context', content: '1: export const finalizationFixture = true;' }],
  sourceScopes: [{ path: 'src/finalization.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }],
  sources: [{
    path: 'src/finalization.ts',
    selection: {
      kind: 'targeted',
      functions: [{ name: 'finalizationFixture', startLine: 1, endLine: 1 }],
    },
  }],
  llmRules: [{
    key: 'bugs/llm/finalization-fixture',
    name: 'Finalization fixture',
    severity: 'medium',
    prompt: 'Return the fixture result.',
  }],
  tier: 'targeted',
};

function snapshot(id: string, createdAt: string, previousAnalysisId: string | null): AnalysisSnapshot {
  return {
    id,
    createdAt,
    branch: 'main',
    commitHash: `commit-${id}`,
    architecture: 'monolith',
    status: 'completed',
    metadata: null,
    graph,
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
    violations: [],
  };
}

function historyFor(value: AnalysisSnapshot): HistoryEntry {
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
        new: 0,
        unchanged: 0,
        resolved: 0,
        bySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
      },
    },
    usage: { totalTokens: 0, totalCostUsd: '0', durationMs: 0, provider: '' },
  };
}

function referenceJournalAdapter(
  readStored: () => StoredAnalyzeRun | null,
  writeStored: (run: StoredAnalyzeRun) => void,
  onRead?: () => void,
): AnalyzeRunStorage {
  return {
    async createLatest(_repoKey, run) {
      const stored = { ...run, attemptSequence: 1 };
      writeStored(stored);
      return stored;
    },
    async read(_repoKey, runId) {
      const stored = readStored();
      onRead?.();
      return stored?.runId === runId ? stored : null;
    },
    async readLatest() {
      const stored = readStored();
      onRead?.();
      return stored;
    },
    async inspectLatest() {
      return readStored();
    },
    async compareAndSwap(_repoKey, _runId, expectedRevision, next) {
      const stored = readStored();
      if (stored?.revision !== expectedRevision) throw new Error('unexpected revision conflict');
      writeStored(next);
    },
  };
}

async function prepareRun(
  runId: string,
  candidate: AnalysisSnapshot,
  expectedBaseline: LatestSnapshot | null,
): Promise<void> {
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId,
    candidateAnalysisId: candidate.id,
    startedAt: '2026-07-19T10:00:00.000Z',
    source: 'cli',
    branch: candidate.branch,
    commitHash: candidate.commitHash,
    completedBaselineId: expectedBaseline?.analysis.id ?? null,
  });
  const adapter: AnalyzeLlmExecutionAdapter = {
    execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
    async execute(work: CertifiedAnalyzeLlmWork): Promise<AnalyzeLlmExecutionOutcome> {
      return {
        family: work.family,
        domain: work.domain,
        mode: work.mode,
        workId: work.workId,
        inputFingerprint: work.inputFingerprint,
        resultContractId: work.planned.request.resultContractId,
        result: { violations: [] },
        attemptId: `test:${work.workId}`,
        completedAt: '2026-07-19T10:00:01.500Z',
        usage: null,
      };
    },
  };
  const certified = certifyAnalyzeLlmRun({
    runId,
    journalKey: repoPath,
    repositoryRoot: repoPath,
    code: [{ domain: 'bugs', context: codeContext }],
  }, adapter);
  const activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    execution: { provider: 'claude-code', requestedModel: 'opus[1m]' },
    runId,
    sealedAt: '2026-07-19T10:00:01.000Z',
    work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    })),
  });
  const execution = await certified.execute(activation, '2026-07-19T10:00:01.250Z');
  await beginFinalizeAnalyzeRun(repoPath, {
    runId,
    finalizingAt: '2026-07-19T10:00:02.000Z',
  }, execution.completion);
  await prepareAnalyzeRunFinalization(repoPath, {
    runId,
    preparedAt: '2026-07-19T10:00:03.000Z',
    promotion: {
      expectedBaseline,
      snapshot: candidate,
      latest: latestFor(candidate),
    },
    projection: {
      projectSlug,
      promotedSnapshot: candidate,
      historyEntry: historyFor(candidate),
    },
  });
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-finalization-home-'));
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-finalization-repo-'));
  process.env.TRUECOURSE_HOME = home;
  resetAnalyzeRunStorage();
  resetAnalysisStore();
  resetRegistryStore();
  clearLatestCache();
  projectSlug = (await registerProject(repoPath, 'Finalization Repo')).slug;
});

afterEach(() => {
  resetAnalyzeRunStorage();
  resetAnalysisStore();
  resetRegistryStore();
  clearLatestCache();
  if (originalHome === undefined) delete process.env.TRUECOURSE_HOME;
  else process.env.TRUECOURSE_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repoPath, { recursive: true, force: true });
  for (const extraPath of extraPaths.splice(0)) {
    fs.rmSync(extraPath, { recursive: true, force: true });
  }
});

describe('prepared analyze-run finalization', () => {
  it.each(['after-promotion', 'after-projection'] as const)(
    'repairs an interrupted %s attempt before marking it completed',
    async (faultPoint) => {
      const candidate = snapshot('analysis-a', '2026-07-19T09:59:00.000Z', null);
      await prepareRun('run-a', candidate, null);

      await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
        repoPath,
        { runId: 'run-a', completedAt: '2026-07-19T10:00:04.000Z' },
        {
          faultInjector(point) {
            if (point === faultPoint) throw new Error(`injected ${faultPoint}`);
          },
        },
      ))).rejects.toThrow(`injected ${faultPoint}`);
      await expect(readAnalyzeRun(repoPath, { runId: 'run-a' })).resolves.toMatchObject({
        revision: 5,
        state: 'finalizing',
        finalization: { persistence: 'prepared' },
      });
      expect((await readLatest(repoPath))?.analysis.id).toBe(candidate.id);

      const completed = await withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
        repoPath,
        { runId: 'run-a', completedAt: '2026-07-19T10:00:04.000Z' },
      ));
      expect(completed).toMatchObject({
        revision: 6,
        state: 'completed',
        updatedAt: '2026-07-19T10:00:04.000Z',
        resume: { available: false, reason: 'run-completed' },
      });
      expect((await readHistory(repoPath)).analyses).toEqual([historyFor(candidate)]);
      expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBe(candidate.createdAt);

      resetAnalyzeRunStorage();
      await expect(readAnalyzeRun(repoPath, { runId: 'run-a' })).resolves.toEqual(completed);
      await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
        repoPath,
        { runId: 'run-a', completedAt: '2026-07-19T10:00:04.000Z' },
      ))).resolves.toEqual(completed);
      await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
        repoPath,
        { runId: 'run-a', completedAt: '2026-07-19T10:00:05.000Z' },
      ))).rejects.toThrow(/different completion time/i);
    },
  );

  it('completes a delayed committed ancestor without replacing the newer baseline', async () => {
    const first = snapshot('analysis-a', '2026-07-19T09:58:00.000Z', null);
    await prepareRun('run-a', first, null);
    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-a', completedAt: '2026-07-19T10:00:04.000Z' },
      { faultInjector: (point) => {
        if (point === 'after-promotion') throw new Error('crash after A promotion');
      } },
    ))).rejects.toThrow('crash after A promotion');

    const second = snapshot('analysis-b', '2026-07-19T09:59:00.000Z', first.id);
    await withAnalyzeLifecycleLock(repoPath, async () => {
      await promoteCompletedAnalysisBaseline(repoPath, {
        expectedBaseline: latestFor(first),
        snapshot: second,
        latest: latestFor(second),
      });
    });

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-a', completedAt: '2026-07-19T10:00:04.000Z' },
    ))).resolves.toMatchObject({ state: 'completed', revision: 6 });
    expect((await readLatest(repoPath))?.analysis.id).toBe(second.id);
    expect((await readHistory(repoPath)).analyses).toEqual([historyFor(first)]);
    expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBe(second.createdAt);
  });

  it('rejects invalid completion time before changing the completed baseline or projections', async () => {
    const candidate = snapshot('analysis-invalid-time', '2026-07-19T09:59:00.000Z', null);
    await prepareRun('run-invalid-time', candidate, null);

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-invalid-time', completedAt: '2026-07-19T10:00:02.000Z' },
    ))).rejects.toThrow(/cannot precede prepared finalization/i);
    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-invalid-time', completedAt: 'not-a-time' },
    ))).rejects.toThrow(/valid timestamp/i);

    expect(await readLatest(repoPath)).toBeNull();
    expect((await readHistory(repoPath)).analyses).toEqual([]);
    expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBeUndefined();
    await expect(readAnalyzeRun(repoPath, { runId: 'run-invalid-time' })).resolves.toMatchObject({
      revision: 5,
      state: 'finalizing',
    });
  });

  it('recognizes an ambiguous response after the completed journal commit', async () => {
    const candidate = snapshot('analysis-completion-response', '2026-07-19T09:59:00.000Z', null);
    await prepareRun('run-completion-response', candidate, null);

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-completion-response', completedAt: '2026-07-19T10:00:04.000Z' },
      { faultInjector: (point) => {
        if (point === 'after-completion') throw new Error('ambiguous completed response');
      } },
    ))).rejects.toThrow('ambiguous completed response');
    await expect(readAnalyzeRun(repoPath, { runId: 'run-completion-response' }))
      .resolves.toMatchObject({ state: 'completed', revision: 6 });

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-completion-response', completedAt: '2026-07-19T10:00:04.000Z' },
    ))).resolves.toMatchObject({ state: 'completed', revision: 6 });

    const runFile = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'run-completion-response.json',
    );
    const corrupt = JSON.parse(fs.readFileSync(runFile, 'utf8')) as { revision: number };
    corrupt.revision = 4;
    fs.writeFileSync(runFile, JSON.stringify(corrupt), 'utf8');
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'run-completion-response' }))
      .rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
  });

  it.each(['analysis', 'registry', 'journal'] as const)(
    'fails closed when the %s store changes after journal completion',
    async (storeKind) => {
      const candidate = snapshot(
        `post-completion-${storeKind}`,
        '2026-07-19T09:59:00.000Z',
        null,
      );
      const runId = `run-post-completion-${storeKind}`;
      await prepareRun(runId, candidate, null);

      await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
        repoPath,
        { runId, completedAt: '2026-07-19T10:00:04.000Z' },
        { faultInjector(point) {
          if (point !== 'after-completion') return;
          if (storeKind === 'analysis') {
            setAnalysisStore(new Proxy(getAnalysisStore(), {}) as AnalysisStore);
          } else if (storeKind === 'registry') {
            setRegistryStore(new Proxy(getRegistryStore(), {}) as RegistryStore);
          } else {
            resetAnalyzeRunStorage();
          }
        } },
      ))).rejects.toThrow(/storage changed/i);
      await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
        state: 'completed',
        revision: 6,
      });
    },
  );

  it('leaves a prepared attempt incomplete when the active baseline is unrelated', async () => {
    const candidate = snapshot('analysis-candidate', '2026-07-19T09:58:00.000Z', null);
    await prepareRun('run-unrelated', candidate, null);
    const unrelated = snapshot('analysis-unrelated', '2026-07-19T09:59:00.000Z', null);
    await withAnalyzeLifecycleLock(repoPath, async () => {
      await promoteCompletedAnalysisBaseline(repoPath, {
        expectedBaseline: null,
        snapshot: unrelated,
        latest: latestFor(unrelated),
      });
    });

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-unrelated', completedAt: '2026-07-19T10:00:04.000Z' },
    ))).rejects.toThrow(/not in the active completed-analysis lineage/i);
    expect((await readLatest(repoPath))?.analysis.id).toBe(unrelated.id);
    expect((await readHistory(repoPath)).analyses).toEqual([]);
    expect((await getProjectBySlug(projectSlug))?.lastAnalyzed).toBeUndefined();
    await expect(readAnalyzeRun(repoPath, { runId: 'run-unrelated' })).resolves.toMatchObject({
      state: 'finalizing',
      revision: 5,
    });
  });

  it('does not complete through a different journal storage than the prepared read', async () => {
    let storedA: StoredAnalyzeRun | null = null;
    let storedB: StoredAnalyzeRun | null = null;
    const storageA = referenceJournalAdapter(() => storedA, (run) => { storedA = run; });
    const storageB = referenceJournalAdapter(() => storedB, (run) => { storedB = run; });
    setAnalyzeRunStorage(storageA);
    const candidate = snapshot('analysis-storage-swap', '2026-07-19T09:59:00.000Z', null);
    await prepareRun('run-storage-swap', candidate, null);
    storedB = JSON.parse(JSON.stringify(storedA)) as StoredAnalyzeRun;

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-storage-swap', completedAt: '2026-07-19T10:00:04.000Z' },
      { faultInjector: (point) => {
        if (point === 'after-projection') setAnalyzeRunStorage(storageB);
      } },
    ))).rejects.toThrow(/storage changed/i);
    expect(storedA).toMatchObject({ revision: 5, status: { state: 'finalizing' } });
    expect(storedB).toMatchObject({ revision: 5, status: { state: 'finalizing' } });
  });

  it('does not return completed from a journal storage that became inactive during its read', async () => {
    let storedA: StoredAnalyzeRun | null = null;
    let storedB: StoredAnalyzeRun | null = null;
    let swapOnRead = false;
    let storageB!: AnalyzeRunStorage;
    const storageA = referenceJournalAdapter(
      () => storedA,
      (run) => { storedA = run; },
      () => {
        if (swapOnRead) {
          swapOnRead = false;
          setAnalyzeRunStorage(storageB);
        }
      },
    );
    storageB = referenceJournalAdapter(() => storedB, (run) => { storedB = run; });
    setAnalyzeRunStorage(storageA);
    const candidate = snapshot('analysis-completed-swap', '2026-07-19T09:59:00.000Z', null);
    await prepareRun('run-completed-swap', candidate, null);
    await withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-completed-swap', completedAt: '2026-07-19T10:00:04.000Z' },
    ));
    const completedA = JSON.parse(JSON.stringify(storedA)) as StoredAnalyzeRun;
    storedB = {
      ...completedA,
      revision: 5,
      updatedAt: '2026-07-19T10:00:03.000Z',
      status: { state: 'finalizing', finalizingAt: '2026-07-19T10:00:02.000Z' },
    };
    swapOnRead = true;
    setAnalyzeRunStorage(storageA);

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-completed-swap', completedAt: '2026-07-19T10:00:04.000Z' },
    ))).rejects.toThrow(/storage changed/i);
    expect(storedB).toMatchObject({ revision: 5, status: { state: 'finalizing' } });
  });

  it('does not continue finalization after the analysis store changes', async () => {
    const candidate = snapshot('analysis-store-change', '2026-07-19T09:59:00.000Z', null);
    await prepareRun('run-analysis-store-change', candidate, null);
    const underlying = getAnalysisStore();
    const alternate = new Proxy(underlying, {}) as AnalysisStore;
    const swapping = new Proxy(underlying, {
      get(target, property, receiver) {
        if (property !== 'promoteCompletedAnalysisBaseline') {
          return Reflect.get(target, property, receiver);
        }
        return async (...args: Parameters<AnalysisStore['promoteCompletedAnalysisBaseline']>) => {
          const result = await target.promoteCompletedAnalysisBaseline(...args);
          setAnalysisStore(alternate);
          return result;
        };
      },
    }) as AnalysisStore;
    setAnalysisStore(swapping);

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-analysis-store-change', completedAt: '2026-07-19T10:00:04.000Z' },
    ))).rejects.toThrow(/persistence storage changed/i);
    expect((await readLatest(repoPath))?.analysis.id).toBe(candidate.id);
    expect((await readHistory(repoPath)).analyses).toEqual([]);
    await expect(readAnalyzeRun(repoPath, { runId: 'run-analysis-store-change' }))
      .resolves.toMatchObject({ state: 'finalizing', revision: 5 });
  });

  it('does not continue projection after the registry store changes', async () => {
    const candidate = snapshot('registry-store-change', '2026-07-19T09:59:00.000Z', null);
    await prepareRun('run-registry-store-change', candidate, null);
    const underlying = getRegistryStore();
    const alternate = new Proxy(underlying, {}) as RegistryStore;
    const swapping = new Proxy(underlying, {
      get(target, property, receiver) {
        if (property !== 'getProjectByPath') return Reflect.get(target, property, receiver);
        return async (repoKey: string) => {
          const result = await target.getProjectByPath(repoKey);
          setRegistryStore(alternate);
          return result;
        };
      },
    }) as RegistryStore;
    setRegistryStore(swapping);

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      repoPath,
      { runId: 'run-registry-store-change', completedAt: '2026-07-19T10:00:04.000Z' },
    ))).rejects.toThrow(/projection storage changed/i);
    expect((await readLatest(repoPath))?.analysis.id).toBe(candidate.id);
    expect((await readHistory(repoPath)).analyses).toEqual([]);
    await expect(readAnalyzeRun(repoPath, { runId: 'run-registry-store-change' }))
      .resolves.toMatchObject({ state: 'finalizing', revision: 5 });
  });

  it.each(['analysis', 'registry'] as const)(
    'does not commit the journal when the %s store changes during the completion read',
    async (storeKind) => {
      let stored: StoredAnalyzeRun | null = null;
      let swapDuringCompletionRead = false;
      const analysisStore = getAnalysisStore();
      const registryStore = getRegistryStore();
      const alternateAnalysis = new Proxy(analysisStore, {}) as AnalysisStore;
      const alternateRegistry = new Proxy(registryStore, {}) as RegistryStore;
      const journal = referenceJournalAdapter(
        () => stored,
        (run) => { stored = run; },
        () => {
          if (!swapDuringCompletionRead) return;
          swapDuringCompletionRead = false;
          if (storeKind === 'analysis') setAnalysisStore(alternateAnalysis);
          else setRegistryStore(alternateRegistry);
        },
      );
      setAnalyzeRunStorage(journal);
      const candidate = snapshot(
        `completion-read-${storeKind}`,
        '2026-07-19T09:59:00.000Z',
        null,
      );
      await prepareRun(`run-completion-read-${storeKind}`, candidate, null);

      await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
        repoPath,
        {
          runId: `run-completion-read-${storeKind}`,
          completedAt: '2026-07-19T10:00:04.000Z',
        },
        { faultInjector: (point) => {
          if (point === 'after-projection') swapDuringCompletionRead = true;
        } },
      ))).rejects.toThrow(/persistence storage changed/i);
      expect(stored).toMatchObject({ revision: 5, status: { state: 'finalizing' } });
    },
  );

  it('pins file recovery to the repository behind a path alias', async () => {
    const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-finalization-alias-'));
    const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-finalization-other-'));
    extraPaths.push(aliasRoot, otherRepo);
    const alias = path.join(aliasRoot, 'repo');
    fs.symlinkSync(repoPath, alias, 'dir');
    const candidate = snapshot('analysis-alias', '2026-07-19T09:59:00.000Z', null);
    await prepareRun('run-alias', candidate, null);

    await expect(withAnalyzeLifecycleLock(repoPath, () => finalizePreparedAnalyzeRun(
      alias,
      { runId: 'run-alias', completedAt: '2026-07-19T10:00:04.000Z' },
      { faultInjector: (point) => {
        if (point === 'after-promotion') {
          fs.unlinkSync(alias);
          fs.symlinkSync(otherRepo, alias, 'dir');
        }
      } },
    ))).resolves.toMatchObject({ state: 'completed', revision: 6 });
    expect((await readLatest(repoPath))?.analysis.id).toBe(candidate.id);
    expect(await readLatest(otherRepo)).toBeNull();
  });
});
