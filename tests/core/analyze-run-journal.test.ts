import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AnalyzeRunStorage,
  type AnalyzeRunExecutionCompletion,
  type StoredAnalyzeRun,
  AnalyzeRunAlreadyExistsError,
  AnalyzeRunJournalCorruptError,
  AnalyzeRunLatestAttemptConflictError,
  AnalyzeRunRevisionConflictError,
  InvalidAnalyzeRunTransitionError,
  activateAnalyzeRunResume,
  beginFinalizeAnalyzeRun,
  dispatchAnalyzeRun,
  prepareAnalyzeRunFinalization,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  setAnalyzeRunStorage,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import { certifyAnalyzeRunResumeActivation } from '../../packages/core/src/lib/analyze-run-resume-activation-certification.js';
import { fingerprint } from '../../packages/core/src/lib/canonical-json.js';
import {
  certifyPreparedAnalyzeRunFinalization,
  completePreparedAnalyzeRunFinalization,
  readPreparedAnalyzeRunFinalization,
} from '../../packages/core/src/lib/analyze-run-finalization-recovery.js';
import { buildAnalysisFilename } from '../../packages/core/src/lib/analysis-store.js';
import type {
  AnalysisSnapshot,
  HistoryEntry,
  LatestSnapshot,
} from '../../packages/core/src/types/snapshot.js';
import {
  certifyAnalyzeLlmRun,
  type AnalyzeLlmExecutionAdapter,
  type AnalyzeLlmExecutionOutcome,
  type CertifiedAnalyzeLlmExecution,
  type CertifiedAnalyzeLlmWork,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import type { CodeViolationContext } from '../../packages/core/src/services/llm/provider.js';

let repoPath: string;

const certifiedCodeContext: CodeViolationContext = {
  files: [{ path: 'context', content: '1: export const journalFixture = true;' }],
  sourceScopes: [{ path: '/repo/src/journal.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }],
  sources: [{
    path: '/repo/src/journal.ts',
    selection: {
      kind: 'targeted',
      functions: [{ name: 'journalFixture', startLine: 1, endLine: 1 }],
    },
  }],
  llmRules: [{
    key: 'bugs/llm/journal-fixture',
    name: 'Journal fixture',
    severity: 'medium',
    prompt: 'Return the fixture result.',
  }],
  tier: 'targeted',
};

async function certifySuccessfulExecution(
  repository: string,
  runId: string,
  sealedAt = '2026-07-19T01:30:01.000Z',
): Promise<CertifiedAnalyzeLlmExecution> {
  let providerCalls = 0;
  const completedAt = new Date(Date.parse(sealedAt) + 1).toISOString();
  const adapter: AnalyzeLlmExecutionAdapter = {
    execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
    async execute(work: CertifiedAnalyzeLlmWork): Promise<AnalyzeLlmExecutionOutcome> {
      providerCalls += 1;
      return {
        family: work.family,
        domain: work.domain,
        mode: work.mode,
        workId: work.workId,
        inputFingerprint: work.inputFingerprint,
        resultContractId: work.planned.request.resultContractId,
        result: { violations: [] },
        attemptId: `test:${work.workId}`,
        completedAt,
        usage: null,
      };
    },
  };
  const certified = certifyAnalyzeLlmRun({
    runId,
    journalKey: repository,
    repositoryRoot: '/repo',
    code: [{ domain: 'bugs', context: certifiedCodeContext }],
  }, adapter);
  const activation = await sealAnalyzeRunPlan(repository, {
    kind: 'seal-plan',
    runId,
    sealedAt,
    work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    })),
  });
  const execution = await certified.execute(activation);
  if (providerCalls !== 1) {
    throw new Error(`Expected one certified provider call, got ${providerCalls}`);
  }
  return execution;
}

function finalizationPayload(candidateAnalysisId: string) {
  const createdAt = '2026-07-19T01:30:03.000Z';
  const graph: AnalysisSnapshot['graph'] = {
    services: [], serviceDependencies: [], layers: [], modules: [], methods: [],
    moduleDeps: [], methodDeps: [], databases: [], databaseConnections: [], flows: [],
  };
  const snapshot: AnalysisSnapshot = {
    id: candidateAnalysisId,
    createdAt,
    branch: 'main',
    commitHash: 'abc456',
    architecture: 'monolith',
    status: 'completed',
    metadata: null,
    graph,
    violations: { added: [], resolved: [], previousAnalysisId: null },
    usage: [],
  };
  const filename = buildAnalysisFilename(snapshot.id, snapshot.createdAt);
  const latest: LatestSnapshot = {
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
    graph,
    violations: [],
  };
  const historyEntry: HistoryEntry = {
    id: snapshot.id,
    filename,
    createdAt: snapshot.createdAt,
    branch: snapshot.branch,
    commitHash: snapshot.commitHash,
    metadata: snapshot.metadata,
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
  return {
    promotion: { expectedBaseline: null, snapshot, latest },
    projection: { projectSlug: 'projection-repo', promotedSnapshot: snapshot, historyEntry },
  };
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-analyze-run-journal-'));
  resetAnalyzeRunStorage();
});

afterEach(() => {
  resetAnalyzeRunStorage();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('analyze run journal', () => {
  it('exports the hosted storage seam through the core package', async () => {
    const exported = await import('@truecourse/core/lib/analyze-run-journal');

    expect(exported).toEqual(expect.objectContaining({
      dispatchAnalyzeRun: expect.any(Function),
      readAnalyzeRun: expect.any(Function),
      setAnalyzeRunStorage: expect.any(Function),
    }));
    expect(exported).not.toHaveProperty('certifyAnalyzeRunExecutionCompletion');
    expect(exported).not.toHaveProperty('readPreparedAnalyzeRunFinalization');
  });

  it('delegates lifecycle commands through an installed hosted storage adapter', async () => {
    const repoKey = 'hosted:repo-42';
    let stored: StoredAnalyzeRun | null = null;
    const storage: AnalyzeRunStorage = {
      async createLatest(receivedRepoKey, run) {
        expect(receivedRepoKey).toBe(repoKey);
        stored = { ...run, attemptSequence: 42 };
        return stored;
      },
      async read(receivedRepoKey, runId) {
        expect(receivedRepoKey).toBe(repoKey);
        return stored?.runId === runId ? stored : null;
      },
      async readLatest(receivedRepoKey) {
        expect(receivedRepoKey).toBe(repoKey);
        return stored;
      },
      async inspectLatest(receivedRepoKey) {
        expect(receivedRepoKey).toBe(repoKey);
        return stored;
      },
      async compareAndSwap(receivedRepoKey, runId, expectedRevision, next) {
        expect(receivedRepoKey).toBe(repoKey);
        expect(stored).toMatchObject({ runId, revision: expectedRevision });
        stored = next;
      },
      async compareAndSwapLatest(receivedRepoKey, runId, expectedRevision, _attempt, _latest, next) {
        expect(receivedRepoKey).toBe(repoKey);
        expect(stored).toMatchObject({ runId, revision: expectedRevision });
        stored = next;
      },
    };
    setAnalyzeRunStorage(storage);

    await dispatchAnalyzeRun(repoKey, {
      kind: 'begin',
      runId: 'hosted-run',
      candidateAnalysisId: 'hosted-analysis',
      startedAt: '2026-07-19T00:30:00.000Z',
      source: 'hosted',
      branch: null,
      commitHash: null,
      completedBaselineId: 'hosted-completed-baseline',
    });
    const execution = await certifySuccessfulExecution(
      repoKey,
      'hosted-run',
      '2026-07-19T00:30:01.000Z',
    );
    const sealed = await readAnalyzeRun(repoKey, 'latest-attempt');

    expect(sealed).toMatchObject({
      runId: 'hosted-run',
      revision: 3,
      plan: 'sealed',
      counts: { total: 1, pending: 0, succeeded: 1 },
    });
    const finalizing = await beginFinalizeAnalyzeRun(repoKey, {
      runId: 'hosted-run',
      finalizingAt: '2026-07-19T00:30:02.000Z',
    }, execution.completion);
    await expect(readAnalyzeRun(repoKey, 'latest-attempt')).resolves.toEqual(finalizing);
  });

  it('does not cross storage adapters when the active adapter changes during plan sealing', async () => {
    const repoKey = 'hosted:storage-swap';
    let storedA: StoredAnalyzeRun | null = null;
    let storedB: StoredAnalyzeRun | null = null;
    let swapOnRead = false;
    let writesA = 0;
    let writesB = 0;
    const storageB: AnalyzeRunStorage = {
      async createLatest(_key, run) {
        storedB = { ...run, attemptSequence: 1 };
        return storedB;
      },
      async read() { return storedB; },
      async readLatest() { return storedB; },
      async inspectLatest() { return storedB; },
      async compareAndSwap(_key, _runId, _revision, next) {
        writesB += 1;
        storedB = next;
      },
      async compareAndSwapLatest(_key, _runId, _revision, _attempt, _latest, next) {
        writesB += 1;
        storedB = next;
      },
    };
    const storageA: AnalyzeRunStorage = {
      async createLatest(_key, run) {
        storedA = { ...run, attemptSequence: 1 };
        return storedA;
      },
      async read() {
        if (swapOnRead) {
          swapOnRead = false;
          setAnalyzeRunStorage(storageB);
        }
        return storedA;
      },
      async readLatest() { return storedA; },
      async inspectLatest() { return storedA; },
      async compareAndSwap(_key, _runId, _revision, next) {
        writesA += 1;
        storedA = next;
      },
      async compareAndSwapLatest(_key, _runId, _revision, _attempt, _latest, next) {
        writesA += 1;
        storedA = next;
      },
    };
    setAnalyzeRunStorage(storageA);
    await dispatchAnalyzeRun(repoKey, {
      kind: 'begin',
      runId: 'storage-swap-run',
      candidateAnalysisId: 'storage-swap-analysis',
      startedAt: '2026-07-19T00:40:00.000Z',
      source: 'hosted',
      branch: null,
      commitHash: null,
      completedBaselineId: null,
    });
    swapOnRead = true;

    await expect(sealAnalyzeRunPlan(repoKey, {
      kind: 'seal-plan',
      runId: 'storage-swap-run',
      sealedAt: '2026-07-19T00:40:01.000Z',
      work: [{ workId: 'analyze:v1:swap', inputFingerprint: `sha256:${'c'.repeat(64)}` }],
    })).rejects.toThrow(/storage changed during plan activation/);
    expect(writesA).toBe(0);
    expect(writesB).toBe(0);
    expect(storedA?.plan.state).toBe('unsealed');
    expect(storedB).toBeNull();
  });

  it('durably exposes a new running attempt without changing the completed baseline', async () => {
    const truecourseDir = path.join(repoPath, '.truecourse');
    const latestPath = path.join(truecourseDir, 'LATEST.json');
    fs.mkdirSync(truecourseDir, { recursive: true });
    fs.writeFileSync(latestPath, '{"completed":"baseline-sentinel"}\n');
    const latestBefore = fs.readFileSync(latestPath, 'utf8');

    const begun = await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'run-2026-07-19',
      candidateAnalysisId: 'analysis-2026-07-19',
      startedAt: '2026-07-19T00:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc123',
      completedBaselineId: 'completed-analysis-1',
    });

    expect(begun).toEqual({
      schemaVersion: 5,
      revision: 0,
      runId: 'run-2026-07-19',
      candidateAnalysisId: 'analysis-2026-07-19',
      state: 'running',
      startedAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc123',
      completedBaselineId: 'completed-analysis-1',
      executionAttempt: {
        number: 1,
        activatedAt: '2026-07-19T00:00:00.000Z',
        resume: null,
      },
      plan: 'unsealed',
      counts: null,
      blocked: null,
      failure: null,
      finalization: null,
      resume: {
        available: false,
        reason: 'successful-results-not-checkpointed',
      },
    });

    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toEqual(begun);
    expect(fs.readFileSync(latestPath, 'utf8')).toBe(latestBefore);
  });

  it('seals the certified plan and derives pending counts from its work records', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'run-with-plan',
      candidateAnalysisId: 'analysis-with-plan',
      startedAt: '2026-07-19T01:00:00.000Z',
      source: 'dashboard',
      branch: 'feature/run-journal',
      commitHash: 'def456',
      completedBaselineId: null,
    });

    const sealed = await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'run-with-plan',
      sealedAt: '2026-07-19T01:00:01.000Z',
      work: [
        { workId: 'analyze:v1:service', inputFingerprint: `sha256:${'a'.repeat(64)}` },
        { workId: 'analyze:v1:module', inputFingerprint: `sha256:${'b'.repeat(64)}` },
      ],
    });

    expect(sealed).toMatchObject({
      revision: 1,
      state: 'running',
      updatedAt: '2026-07-19T01:00:01.000Z',
      plan: 'sealed',
      counts: {
        total: 2,
        pending: 2,
        running: 0,
        succeeded: 0,
        failed: 0,
      },
    });

    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toEqual(sealed);
  });

  it('preserves valid offset timestamp text across v4 reads and legacy normalization', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'offset-timestamp-run',
      candidateAnalysisId: 'offset-timestamp-analysis',
      startedAt: '2026-07-19T02:00:00+02:00',
      source: 'cli',
      branch: 'main',
      commitHash: 'offset-commit',
      completedBaselineId: null,
    });
    const sealed = await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'offset-timestamp-run',
      sealedAt: '2026-07-19T02:00:01+02:00',
      work: [{ workId: 'analyze:v1:offset', inputFingerprint: `sha256:${'e'.repeat(64)}` }],
    });
    expect(sealed.updatedAt).toBe('2026-07-19T02:00:01+02:00');
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'offset-timestamp-run' }))
      .resolves.toEqual(sealed);

    const file = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'offset-timestamp-run.json',
    );
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    legacy.schemaVersion = 3;
    delete legacy.executionAttempt;
    fs.writeFileSync(file, JSON.stringify(legacy));
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'offset-timestamp-run' }))
      .resolves.toMatchObject({
        schemaVersion: 5,
        updatedAt: '2026-07-19T02:00:01+02:00',
        executionAttempt: { number: 1, activatedAt: '2026-07-19T02:00:00+02:00', resume: null },
      });
  });

  it('durably records certified finalizing work without changing the completed baseline', async () => {
    const truecourseDir = path.join(repoPath, '.truecourse');
    const latestPath = path.join(truecourseDir, 'LATEST.json');
    fs.mkdirSync(truecourseDir, { recursive: true });
    fs.writeFileSync(latestPath, '{"completed":"baseline-sentinel"}\n');
    const latestBefore = fs.readFileSync(latestPath, 'utf8');
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'successful-run',
      candidateAnalysisId: 'candidate-analysis',
      startedAt: '2026-07-19T01:30:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: 'previous-completed-analysis',
    });
    const execution = await certifySuccessfulExecution(repoPath, 'successful-run');

    const finalizing = await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'successful-run',
      finalizingAt: '2026-07-19T01:30:02.000Z',
    }, execution.completion);

    expect(finalizing).toMatchObject({
      revision: 4,
      state: 'finalizing',
      candidateAnalysisId: 'candidate-analysis',
      completedBaselineId: 'previous-completed-analysis',
      counts: { total: 1, pending: 0, running: 0, succeeded: 1, failed: 0 },
      finalization: {
        finalizingAt: '2026-07-19T01:30:02.000Z',
      },
      resume: { available: false, reason: 'checkpoint-reuse-not-enabled' },
    });
    const journalPath = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'successful-run.json',
    );
    expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toMatchObject({
      plan: {
        work: [
          { state: 'succeeded-checkpointed' },
        ],
      },
    });
    await expect(beginFinalizeAnalyzeRun(repoPath, {
      runId: 'successful-run',
      finalizingAt: '2026-07-19T01:30:02.000Z',
    }, execution.completion)).resolves.toEqual(finalizing);
    expect(fs.readFileSync(latestPath, 'utf8')).toBe(latestBefore);

    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toEqual(finalizing);
  });

  it('durably prepares exact finalization recovery input without changing analysis projections', async () => {
    const truecourseDir = path.join(repoPath, '.truecourse');
    const latestPath = path.join(truecourseDir, 'LATEST.json');
    const historyPath = path.join(truecourseDir, 'history.json');
    const diffPath = path.join(truecourseDir, 'diff.json');
    fs.mkdirSync(truecourseDir, { recursive: true });
    fs.writeFileSync(latestPath, '{"completed":"baseline-sentinel"}\n');
    fs.writeFileSync(historyPath, '{"analyses":[]}\n');
    fs.writeFileSync(diffPath, '{"id":"diff-sentinel"}\n');
    const projectionBytes = [latestPath, historyPath, diffPath].map((file) => fs.readFileSync(file));

    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'prepared-finalization-run',
      candidateAnalysisId: 'prepared-finalization-analysis',
      startedAt: '2026-07-19T01:30:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(repoPath, 'prepared-finalization-run');
    await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'prepared-finalization-run',
      finalizingAt: '2026-07-19T01:30:02.000Z',
    }, execution.completion);
    const payload = finalizationPayload('prepared-finalization-analysis');

    const prepared = await prepareAnalyzeRunFinalization(repoPath, {
      runId: 'prepared-finalization-run',
      preparedAt: '2026-07-19T01:30:04.000Z',
      ...payload,
    });
    expect(prepared).toMatchObject({
      schemaVersion: 5,
      revision: 5,
      state: 'finalizing',
      finalization: {
        finalizingAt: '2026-07-19T01:30:02.000Z',
        persistence: 'prepared',
        preparedAt: '2026-07-19T01:30:04.000Z',
      },
    });

    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toEqual(prepared);
    await expect(readPreparedAnalyzeRunFinalization(
      repoPath,
      'prepared-finalization-run',
    )).resolves.toEqual({ preparedAt: '2026-07-19T01:30:04.000Z', ...payload });
    expect([latestPath, historyPath, diffPath].map((file) => fs.readFileSync(file)))
      .toEqual(projectionBytes);
  });

  it('rejects a prepared payload whose durable candidate identity was replaced', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'corrupt-prepared-run',
      candidateAnalysisId: 'corrupt-prepared-analysis',
      startedAt: '2026-07-19T01:30:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(repoPath, 'corrupt-prepared-run');
    await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'corrupt-prepared-run',
      finalizingAt: '2026-07-19T01:30:02.000Z',
    }, execution.completion);
    await prepareAnalyzeRunFinalization(repoPath, {
      runId: 'corrupt-prepared-run',
      preparedAt: '2026-07-19T01:30:04.000Z',
      ...finalizationPayload('corrupt-prepared-analysis'),
    });

    const runFile = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'corrupt-prepared-run.json',
    );
    const stored = JSON.parse(fs.readFileSync(runFile, 'utf8')) as Record<string, unknown>;
    const replacement = finalizationPayload('different-valid-analysis');
    stored.finalizationIntent = {
      preparedAt: '2026-07-19T01:30:04.000Z',
      promotion: replacement.promotion,
      projection: {
        projectSlug: replacement.projection.projectSlug,
        historyEntry: replacement.projection.historyEntry,
      },
    };
    fs.writeFileSync(runFile, JSON.stringify(stored), 'utf8');

    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'corrupt-prepared-run' }))
      .rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
  });

  it('makes exact finalization preparation retries stable and rejects changed retries', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'retried-preparation-run',
      candidateAnalysisId: 'retried-preparation-analysis',
      startedAt: '2026-07-19T01:31:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'retried-preparation-run',
      '2026-07-19T01:31:01.000Z',
    );
    await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'retried-preparation-run',
      finalizingAt: '2026-07-19T01:31:02.000Z',
    }, execution.completion);
    const command = {
      runId: 'retried-preparation-run',
      preparedAt: '2026-07-19T01:31:04.000Z',
      ...finalizationPayload('retried-preparation-analysis'),
    };

    const first = await prepareAnalyzeRunFinalization(repoPath, command);
    const runFile = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'retried-preparation-run.json',
    );
    const firstBytes = fs.readFileSync(runFile);

    await expect(prepareAnalyzeRunFinalization(repoPath, command)).resolves.toEqual(first);
    expect(fs.readFileSync(runFile)).toEqual(firstBytes);
    await expect(prepareAnalyzeRunFinalization(repoPath, {
      ...command,
      preparedAt: '2026-07-19T01:31:05.000Z',
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(readAnalyzeRun(repoPath, { runId: command.runId })).resolves.toEqual(first);
  });

  it('detaches prepared recovery input from callers with a reference-retaining hosted adapter', async () => {
    const repoKey = 'hosted:detached-finalization';
    let stored: StoredAnalyzeRun | null = null;
    const storage: AnalyzeRunStorage = {
      async createLatest(_key, run) {
        stored = { ...run, attemptSequence: 1 };
        return stored;
      },
      async read(_key, runId) { return stored?.runId === runId ? stored : null; },
      async readLatest() { return stored; },
      async inspectLatest() { return stored; },
      async compareAndSwap(_key, _runId, expectedRevision, next) {
        if (stored?.revision !== expectedRevision) {
          throw new AnalyzeRunRevisionConflictError(
            next.runId,
            expectedRevision,
            stored?.revision ?? -1,
          );
        }
        stored = next;
      },
      async compareAndSwapLatest(_key, _runId, expectedRevision, _attempt, _latest, next) {
        if (stored?.revision !== expectedRevision) {
          throw new AnalyzeRunRevisionConflictError(
            next.runId,
            expectedRevision,
            stored?.revision ?? -1,
          );
        }
        stored = next;
      },
    };
    setAnalyzeRunStorage(storage);
    await dispatchAnalyzeRun(repoKey, {
      kind: 'begin',
      runId: 'detached-finalization-run',
      candidateAnalysisId: 'detached-finalization-analysis',
      startedAt: '2026-07-19T01:31:10.000Z',
      source: 'hosted',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(
      repoKey,
      'detached-finalization-run',
      '2026-07-19T01:31:11.000Z',
    );
    await beginFinalizeAnalyzeRun(repoKey, {
      runId: 'detached-finalization-run',
      finalizingAt: '2026-07-19T01:31:12.000Z',
    }, execution.completion);
    const payload = finalizationPayload('detached-finalization-analysis');
    await prepareAnalyzeRunFinalization(repoKey, {
      runId: 'detached-finalization-run',
      preparedAt: '2026-07-19T01:31:13.000Z',
      ...payload,
    });

    payload.promotion.snapshot.architecture = 'microservices';
    payload.projection.historyEntry.id = 'caller-mutated';
    const recovered = await readPreparedAnalyzeRunFinalization(
      repoKey,
      'detached-finalization-run',
    );
    expect(recovered).not.toBeNull();
    expect(recovered?.promotion.snapshot.architecture).toBe('monolith');
    expect(recovered?.projection.historyEntry.id).toBe('detached-finalization-analysis');

    if (recovered) {
      recovered.promotion.snapshot.architecture = 'microservices';
      recovered.projection.historyEntry.id = 'recovery-mutated';
    }
    await expect(readPreparedAnalyzeRunFinalization(repoKey, 'detached-finalization-run'))
      .resolves.toMatchObject({
        promotion: { snapshot: { architecture: 'monolith' } },
        projection: { historyEntry: { id: 'detached-finalization-analysis' } },
      });
  });

  it('rejects preparation input that is backdated, mismatched, or not exactly JSON-safe', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'invalid-preparation-run',
      candidateAnalysisId: 'invalid-preparation-analysis',
      startedAt: '2026-07-19T01:32:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'invalid-preparation-run',
      '2026-07-19T01:32:01.000Z',
    );
    const finalizing = await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'invalid-preparation-run',
      finalizingAt: '2026-07-19T01:32:02.000Z',
    }, execution.completion);
    const payload = finalizationPayload('invalid-preparation-analysis');

    await expect(prepareAnalyzeRunFinalization(repoPath, {
      runId: 'invalid-preparation-run',
      preparedAt: '2026-07-19T01:32:01.000Z',
      ...payload,
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(prepareAnalyzeRunFinalization(repoPath, {
      runId: 'invalid-preparation-run',
      preparedAt: '2026-07-19T01:32:03.000Z',
      ...finalizationPayload('another-candidate'),
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(prepareAnalyzeRunFinalization(repoPath, {
      runId: 'invalid-preparation-run',
      preparedAt: '2026-07-19T01:32:03.000Z',
      ...payload,
      ignoredByJson: undefined,
    } as never)).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(readAnalyzeRun(repoPath, { runId: 'invalid-preparation-run' }))
      .resolves.toEqual(finalizing);
  });

  it('preserves prepared recovery input through a later finalization failure', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'failed-prepared-run',
      candidateAnalysisId: 'failed-prepared-analysis',
      startedAt: '2026-07-19T01:33:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'failed-prepared-run',
      '2026-07-19T01:33:01.000Z',
    );
    await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'failed-prepared-run',
      finalizingAt: '2026-07-19T01:33:02.000Z',
    }, execution.completion);
    const preparedPayload = finalizationPayload('failed-prepared-analysis');
    const prepared = await prepareAnalyzeRunFinalization(repoPath, {
      runId: 'failed-prepared-run',
      preparedAt: '2026-07-19T01:33:04.000Z',
      ...preparedPayload,
    });

    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'failed-prepared-run',
      failedAt: '2026-07-19T01:33:03.000Z',
      error: { code: 'FINALIZE_FAILED', message: 'Projection write failed.' },
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(readAnalyzeRun(repoPath, { runId: 'failed-prepared-run' }))
      .resolves.toEqual(prepared);

    const failed = await dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'failed-prepared-run',
      failedAt: '2026-07-19T01:33:05.000Z',
      error: { code: 'FINALIZE_FAILED', message: 'Projection write failed.' },
    });
    expect(failed).toMatchObject({
      revision: 6,
      state: 'failed',
      finalization: {
        finalizingAt: '2026-07-19T01:33:02.000Z',
        persistence: 'prepared',
        preparedAt: '2026-07-19T01:33:04.000Z',
      },
    });

    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'failed-prepared-run' }))
      .resolves.toEqual(failed);
    await expect(readPreparedAnalyzeRunFinalization(repoPath, 'failed-prepared-run'))
      .resolves.toEqual({ preparedAt: '2026-07-19T01:33:04.000Z', ...preparedPayload });

    const runFile = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'failed-prepared-run.json',
    );
    const corrupt = JSON.parse(fs.readFileSync(runFile, 'utf8')) as {
      finalizationIntent: { preparedAt: string };
    };
    corrupt.finalizationIntent.preparedAt = '2026-07-19T01:33:01.000Z';
    fs.writeFileSync(runFile, JSON.stringify(corrupt), 'utf8');
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'failed-prepared-run' }))
      .rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
  });

  it('allows only one of concurrent preparation and failure to commit', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'concurrent-finalization-run',
      candidateAnalysisId: 'concurrent-finalization-analysis',
      startedAt: '2026-07-19T01:34:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'concurrent-finalization-run',
      '2026-07-19T01:34:01.000Z',
    );
    await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'concurrent-finalization-run',
      finalizingAt: '2026-07-19T01:34:02.000Z',
    }, execution.completion);

    const outcomes = await Promise.allSettled([
      prepareAnalyzeRunFinalization(repoPath, {
        runId: 'concurrent-finalization-run',
        preparedAt: '2026-07-19T01:34:03.000Z',
        ...finalizationPayload('concurrent-finalization-analysis'),
      }),
      dispatchAnalyzeRun(repoPath, {
        kind: 'fail',
        runId: 'concurrent-finalization-run',
        failedAt: '2026-07-19T01:34:03.000Z',
        error: { code: 'FINALIZE_FAILED', message: 'Concurrent finalization failure.' },
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) =>
      outcome.status === 'rejected' && outcome.reason instanceof AnalyzeRunRevisionConflictError,
    )).toHaveLength(1);
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'concurrent-finalization-run' }))
      .resolves.toMatchObject({ revision: 5 });
  });

  it('reads and safely migrates schema-v1 finalizing state and latest pointer', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'legacy-finalizing-run',
      candidateAnalysisId: 'legacy-finalizing-analysis',
      startedAt: '2026-07-19T01:35:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'legacy-finalizing-run',
      '2026-07-19T01:35:01.000Z',
    );
    await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'legacy-finalizing-run',
      finalizingAt: '2026-07-19T01:35:02.000Z',
    }, execution.completion);
    const runsDir = path.join(repoPath, '.truecourse', 'analyses', 'runs');
    const runFile = path.join(runsDir, 'legacy-finalizing-run.json');
    const pointerFile = path.join(runsDir, 'LATEST_ATTEMPT.json');
    const legacy = JSON.parse(fs.readFileSync(runFile, 'utf8')) as Record<string, unknown>;
    legacy.schemaVersion = 1;
    legacy.revision = 2;
    const legacyPlan = legacy.plan as { work: Array<Record<string, unknown>> };
    legacyPlan.work = legacyPlan.work.map(({ checkpoint: _checkpoint, ...item }) => ({
      ...item,
      state: 'succeeded-uncheckpointed',
    }));
    delete legacy.finalizationIntent;
    fs.writeFileSync(runFile, JSON.stringify(legacy), 'utf8');
    fs.writeFileSync(pointerFile, JSON.stringify({
      schemaVersion: 1,
      runId: 'legacy-finalizing-run',
    }), 'utf8');
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      schemaVersion: 5,
      revision: 3,
      state: 'finalizing',
      finalization: { persistence: 'unprepared', preparedAt: null },
    });
    expect(JSON.parse(fs.readFileSync(pointerFile, 'utf8'))).toEqual({
      schemaVersion: 5,
      runId: 'legacy-finalizing-run',
    });
    await expect(prepareAnalyzeRunFinalization(repoPath, {
      runId: 'legacy-finalizing-run',
      preparedAt: '2026-07-19T01:35:03.000Z',
      ...finalizationPayload('legacy-finalizing-analysis'),
    })).resolves.toMatchObject({
      schemaVersion: 5,
      revision: 4,
      finalization: { persistence: 'prepared' },
    });
    expect(JSON.parse(fs.readFileSync(runFile, 'utf8'))).toMatchObject({
      schemaVersion: 5,
      revision: 4,
      finalizationIntent: { preparedAt: '2026-07-19T01:35:03.000Z' },
    });
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'legacy-finalizing-run' }))
      .resolves.toMatchObject({ revision: 4, state: 'finalizing' });
    const certifiedPrepared = await certifyPreparedAnalyzeRunFinalization(
      repoPath,
      'legacy-finalizing-run',
    );
    if (certifiedPrepared?.state !== 'prepared') throw new Error('expected prepared migration');
    await expect(completePreparedAnalyzeRunFinalization(repoPath, {
      runId: 'legacy-finalizing-run',
      completedAt: '2026-07-19T01:35:04.000Z',
      completion: certifiedPrepared.completion,
    })).resolves.toMatchObject({ revision: 5, state: 'completed' });
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'legacy-finalizing-run' }))
      .resolves.toMatchObject({ revision: 5, state: 'completed' });
  });

  it('migrates a schema-v1 finalizing failure to a readable schema-v5 revision', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'legacy-finalizing-failure',
      candidateAnalysisId: 'legacy-finalizing-failure-analysis',
      startedAt: '2026-07-19T01:36:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc456',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'legacy-finalizing-failure',
      '2026-07-19T01:36:01.000Z',
    );
    await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'legacy-finalizing-failure',
      finalizingAt: '2026-07-19T01:36:02.000Z',
    }, execution.completion);
    const runFile = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'legacy-finalizing-failure.json',
    );
    const legacy = JSON.parse(fs.readFileSync(runFile, 'utf8')) as Record<string, unknown>;
    legacy.schemaVersion = 1;
    legacy.revision = 2;
    const legacyPlan = legacy.plan as { work: Array<Record<string, unknown>> };
    legacyPlan.work = legacyPlan.work.map(({ checkpoint: _checkpoint, ...item }) => ({
      ...item,
      state: 'succeeded-uncheckpointed',
    }));
    delete legacy.finalizationIntent;
    fs.writeFileSync(runFile, JSON.stringify(legacy), 'utf8');
    resetAnalyzeRunStorage();

    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'legacy-finalizing-failure',
      failedAt: '2026-07-19T01:36:03.000Z',
      error: { code: 'FINALIZE_FAILED', message: 'Legacy finalization failed.' },
    })).resolves.toMatchObject({ schemaVersion: 5, revision: 4, state: 'failed' });
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'legacy-finalizing-failure' }))
      .resolves.toMatchObject({ schemaVersion: 5, revision: 4, state: 'failed' });
  });

  it.each([[1, 2], [2, 2], [3, 3]] as const)(
    'normalizes a schema-v%s blocked attempt to execution attempt one without rewriting its run file',
    async (schemaVersion, normalizedRevision) => {
      await dispatchAnalyzeRun(repoPath, {
        kind: 'begin',
        runId: 'legacy-blocked-attempt',
        candidateAnalysisId: 'legacy-blocked-analysis',
        startedAt: '2026-07-19T01:36:00.000Z',
        source: 'cli',
        branch: 'main',
        commitHash: 'legacy-blocked-commit',
        completedBaselineId: null,
      });
      await dispatchAnalyzeRun(repoPath, {
        kind: 'seal-plan',
        runId: 'legacy-blocked-attempt',
        sealedAt: '2026-07-19T01:36:01.000Z',
        work: [{ workId: 'analyze:v1:legacy', inputFingerprint: `sha256:${'d'.repeat(64)}` }],
      });
      await dispatchAnalyzeRun(repoPath, {
        kind: 'block',
        runId: 'legacy-blocked-attempt',
        blockedAt: '2026-07-19T01:36:02.000Z',
        resetHint: '7pm',
      });
      const file = path.join(
        repoPath,
        '.truecourse',
        'analyses',
        'runs',
        'legacy-blocked-attempt.json',
      );
      const legacy = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      legacy.schemaVersion = schemaVersion;
      delete legacy.executionAttempt;
      if (schemaVersion === 1) delete legacy.finalizationIntent;
      fs.writeFileSync(file, JSON.stringify(legacy));
      const bytesBefore = fs.readFileSync(file);
      resetAnalyzeRunStorage();

      await expect(readAnalyzeRun(repoPath, { runId: 'legacy-blocked-attempt' }))
        .resolves.toMatchObject({
          schemaVersion: 5,
          revision: normalizedRevision,
          state: 'blocked',
          executionAttempt: {
            number: 1,
            activatedAt: '2026-07-19T01:36:00.000Z',
            resume: null,
          },
        });
      expect(fs.readFileSync(file)).toEqual(bytesBefore);
    },
  );

  it.each([
    ['blocked', 3, 4],
    ['finalizing', 3, 4],
    ['prepared', 4, 5],
    ['completed', 5, 6],
  ] as const)(
    'normalizes the pre-admission schema-v3 %s lineage to the admitted schema-v5 revision',
    async (state, legacyRevision, normalizedRevision) => {
      const candidateAnalysisId = `schema-v3-${state}-analysis`;
      const runId = `schema-v3-${state}`;
      const startedAt = '2026-07-19T01:38:00.000Z';
      const sealedAt = '2026-07-19T01:38:01.000Z';
      const finalizingAt = '2026-07-19T01:38:02.000Z';
      const preparedAt = '2026-07-19T01:38:03.000Z';
      const completedAt = '2026-07-19T01:38:04.000Z';
      await dispatchAnalyzeRun(repoPath, {
        kind: 'begin',
        runId,
        candidateAnalysisId,
        startedAt,
        source: 'cli',
        branch: 'main',
        commitHash: 'abc456',
        completedBaselineId: null,
      });
      const execution = await certifySuccessfulExecution(repoPath, runId, sealedAt);
      await beginFinalizeAnalyzeRun(repoPath, { runId, finalizingAt }, execution.completion);
      await prepareAnalyzeRunFinalization(repoPath, {
        runId,
        preparedAt,
        ...finalizationPayload(candidateAnalysisId),
      });
      const prepared = await certifyPreparedAnalyzeRunFinalization(repoPath, runId);
      if (prepared?.state !== 'prepared') throw new Error('expected prepared schema-v3 fixture');
      await completePreparedAnalyzeRunFinalization(repoPath, {
        runId,
        completedAt,
        completion: prepared.completion,
      });
      const file = path.join(repoPath, '.truecourse', 'analyses', 'runs', `${runId}.json`);
      const legacy = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
      legacy.schemaVersion = 3;
      legacy.revision = legacyRevision;
      delete legacy.executionAttempt;
      if (state === 'blocked') {
        legacy.status = {
          state: 'blocked',
          reason: 'provider-session-limit',
          resetHint: '7pm',
          blockedAt: finalizingAt,
        };
        legacy.updatedAt = finalizingAt;
        legacy.finalizationIntent = null;
      } else if (state === 'finalizing') {
        legacy.status = { state: 'finalizing', finalizingAt };
        legacy.updatedAt = finalizingAt;
        legacy.finalizationIntent = null;
      } else if (state === 'prepared') {
        legacy.status = { state: 'finalizing', finalizingAt };
        legacy.updatedAt = preparedAt;
      }
      fs.writeFileSync(file, JSON.stringify(legacy));
      const bytesBefore = fs.readFileSync(file);
      resetAnalyzeRunStorage();

      await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
        schemaVersion: 5,
        revision: normalizedRevision,
        state: state === 'prepared' ? 'finalizing' : state,
        executionAttempt: { number: 1, activatedAt: startedAt, resume: null },
      });
      expect(fs.readFileSync(file)).toEqual(bytesBefore);
    },
  );

  it('normalizes a schema-v4 execution attempt to schema v5 without rewriting it', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'schema-v4-attempt',
      candidateAnalysisId: 'schema-v4-analysis',
      startedAt: '2026-07-19T01:36:30.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'schema-v4-commit',
      completedBaselineId: null,
    });
    const file = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'schema-v4-attempt.json',
    );
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    stored.schemaVersion = 4;
    delete stored.executionAttempt.resume;
    fs.writeFileSync(file, JSON.stringify(stored));
    const bytesBefore = fs.readFileSync(file);
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, { runId: 'schema-v4-attempt' }))
      .resolves.toMatchObject({
        schemaVersion: 5,
        executionAttempt: {
          number: 1,
          activatedAt: '2026-07-19T01:36:30.000Z',
          resume: null,
        },
      });
    expect(fs.readFileSync(file)).toEqual(bytesBefore);
  });

  it('atomically activates the exact latest blocked partition without touching completed truth', async () => {
    const baseline = finalizationPayload('activation-baseline').promotion.latest;
    const truecourseDir = path.join(repoPath, '.truecourse');
    fs.mkdirSync(truecourseDir, { recursive: true });
    const latestPath = path.join(truecourseDir, 'LATEST.json');
    fs.writeFileSync(latestPath, JSON.stringify(baseline));
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'activate-partial-run',
      candidateAnalysisId: 'activate-partial-analysis',
      startedAt: '2026-07-19T01:38:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'activation-commit',
      completedBaselineId: baseline.analysis.id,
    });
    const work = [
      { workId: 'analyze:v1:pending', inputFingerprint: `sha256:${'a'.repeat(64)}` },
      { workId: 'analyze:v1:reused', inputFingerprint: `sha256:${'b'.repeat(64)}` },
    ];
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'activate-partial-run',
      sealedAt: '2026-07-19T01:38:01.000Z',
      work,
    });
    const runPath = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'activate-partial-run.json',
    );
    const stored = JSON.parse(fs.readFileSync(runPath, 'utf8')) as Record<string, any>;
    const result = { violations: [] };
    const reused = stored.plan.work.find((item: Record<string, unknown>) =>
      item.workId === 'analyze:v1:reused');
    Object.assign(reused, {
      state: 'succeeded-checkpointed',
      checkpoint: {
        checkpointedAt: '2026-07-19T01:38:02.000Z',
        attemptId: 'attempt:reused',
        resultContractId: 'result:v1',
        resultFingerprint: fingerprint(result),
        result,
        usage: null,
      },
    });
    stored.revision = 4;
    stored.updatedAt = '2026-07-19T01:38:03.000Z';
    stored.status = {
      state: 'blocked',
      reason: 'provider-session-limit',
      resetHint: 'resets at 3am',
      blockedAt: '2026-07-19T01:38:03.000Z',
    };
    fs.writeFileSync(runPath, JSON.stringify(stored));
    resetAnalyzeRunStorage();
    const latestAttemptPath = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'LATEST_ATTEMPT.json',
    );
    const completedBefore = fs.readFileSync(latestPath);
    const attemptedBefore = fs.readFileSync(latestAttemptPath);

    const activated = await activateAnalyzeRunResume(repoPath, certifyAnalyzeRunResumeActivation({
      kind: 'activate-resume',
      runId: 'activate-partial-run',
      candidateAnalysisId: 'activate-partial-analysis',
      startedAt: '2026-07-19T01:38:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'activation-commit',
      completedBaselineId: baseline.analysis.id,
      activatedAt: '2026-07-19T03:38:04+02:00',
      work,
      reusedWorkIds: ['analyze:v1:reused'],
      pendingWorkIds: ['analyze:v1:pending'],
      executionPin: {
        provider: 'claude-code',
        requestedModel: 'opus[1m]',
        resolvedModel: 'claude-opus-4-8',
      },
      observed: {
        runRevision: 4,
        attemptSequence: 1,
        latestAttemptSequence: 1,
        completedBaselineFingerprint: fingerprint(baseline),
      },
    }));

    expect(activated.view).toMatchObject({
      schemaVersion: 5,
      revision: 5,
      state: 'running',
      updatedAt: '2026-07-19T01:38:04.000Z',
      counts: { total: 2, pending: 1, succeeded: 1 },
      executionAttempt: {
        number: 2,
        activatedAt: '2026-07-19T01:38:04.000Z',
        resume: {
          admission: 'activated',
          admittedAt: null,
          resumedFrom: {
            resetHint: 'resets at 3am',
            blockedAt: '2026-07-19T01:38:03.000Z',
          },
          executionPin: { resolvedModel: 'claude-opus-4-8' },
        },
      },
    });
    expect(fs.readFileSync(latestPath)).toEqual(completedBefore);
    expect(fs.readFileSync(latestAttemptPath)).toEqual(attemptedBefore);
    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId: 'activate-partial-run',
      blockedAt: '2026-07-19T01:38:05.000Z',
      resetHint: 'later',
    })).rejects.toThrow(/before resumed execution is durably admitted/);
    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'activate-partial-run',
      failedAt: '2026-07-19T01:38:05.000Z',
      error: { code: 'NOT_ADMITTED', message: 'Not admitted.' },
    })).rejects.toThrow(/before resumed execution is durably admitted/);

    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId: 'activate-partial-run' }))
      .resolves.toEqual(activated.view);
  });

  it('rejects forged activation proof and a run that is no longer the latest attempt', async () => {
    await expect(activateAnalyzeRunResume(
      repoPath,
      {} as Parameters<typeof activateAnalyzeRunResume>[1],
    )).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);

    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'stale-activation-run',
      candidateAnalysisId: 'stale-activation-analysis',
      startedAt: '2026-07-19T01:39:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'stale-activation-commit',
      completedBaselineId: null,
    });
    const work = [{ workId: 'analyze:v1:stale', inputFingerprint: `sha256:${'d'.repeat(64)}` }];
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'stale-activation-run',
      sealedAt: '2026-07-19T01:39:01.000Z',
      work,
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId: 'stale-activation-run',
      blockedAt: '2026-07-19T01:39:02.000Z',
      resetHint: 'later',
    });
    const certification = certifyAnalyzeRunResumeActivation({
      kind: 'activate-resume',
      runId: 'stale-activation-run',
      candidateAnalysisId: 'stale-activation-analysis',
      startedAt: '2026-07-19T01:39:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'stale-activation-commit',
      completedBaselineId: null,
      activatedAt: '2026-07-19T01:39:03.000Z',
      work,
      reusedWorkIds: [],
      pendingWorkIds: ['analyze:v1:stale'],
      executionPin: {
        provider: 'claude-code',
        requestedModel: 'opus[1m]',
        resolvedModel: 'claude-opus-4-8',
      },
      observed: {
        runRevision: 2,
        attemptSequence: 1,
        latestAttemptSequence: 1,
        completedBaselineFingerprint: null,
      },
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'newer-attempt',
      candidateAnalysisId: 'newer-analysis',
      startedAt: '2026-07-19T01:39:03.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'newer-commit',
      completedBaselineId: null,
    });

    await expect(activateAnalyzeRunResume(repoPath, certification))
      .rejects.toBeInstanceOf(AnalyzeRunLatestAttemptConflictError);
    await expect(readAnalyzeRun(repoPath, { runId: 'stale-activation-run' }))
      .resolves.toMatchObject({ state: 'blocked', revision: 2 });
  });

  it.each([[1, 2], [2, 2], [3, 3]] as const)(
    'activates a schema-v%s blocked run into the canonical admitted-lineage revision',
    async (schemaVersion, observedRevision) => {
      const runId = `activate-schema-${schemaVersion}`;
      const work = [{
        workId: `analyze:v1:schema-${schemaVersion}`,
        inputFingerprint: `sha256:${String(schemaVersion).repeat(64)}`,
      }];
      await dispatchAnalyzeRun(repoPath, {
        kind: 'begin',
        runId,
        candidateAnalysisId: `${runId}-analysis`,
        startedAt: '2026-07-19T01:39:10.000Z',
        source: 'cli',
        branch: 'main',
        commitHash: `schema-${schemaVersion}-commit`,
        completedBaselineId: null,
      });
      await dispatchAnalyzeRun(repoPath, {
        kind: 'seal-plan',
        runId,
        sealedAt: '2026-07-19T01:39:11.000Z',
        work,
      });
      await dispatchAnalyzeRun(repoPath, {
        kind: 'block',
        runId,
        blockedAt: '2026-07-19T01:39:12.000Z',
        resetHint: 'later',
      });
      const file = path.join(
        repoPath,
        '.truecourse',
        'analyses',
        'runs',
        `${runId}.json`,
      );
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
      stored.schemaVersion = schemaVersion;
      delete stored.executionAttempt;
      if (schemaVersion === 1) delete stored.finalizationIntent;
      fs.writeFileSync(file, JSON.stringify(stored));
      resetAnalyzeRunStorage();

      const activated = await activateAnalyzeRunResume(repoPath, certifyAnalyzeRunResumeActivation({
        kind: 'activate-resume',
        runId,
        candidateAnalysisId: `${runId}-analysis`,
        startedAt: '2026-07-19T01:39:10.000Z',
        source: 'cli',
        branch: 'main',
        commitHash: `schema-${schemaVersion}-commit`,
        completedBaselineId: null,
        activatedAt: '2026-07-19T01:39:13.000Z',
        work,
        reusedWorkIds: [],
        pendingWorkIds: [work[0]!.workId],
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'opus[1m]',
          resolvedModel: 'claude-opus-4-8',
        },
        observed: {
          runRevision: observedRevision,
          attemptSequence: 1,
          latestAttemptSequence: 1,
          completedBaselineFingerprint: null,
        },
      }));

      expect(activated.view).toMatchObject({
        schemaVersion: 5,
        revision: 4,
        state: 'running',
        executionAttempt: { number: 2, resume: { admission: 'activated' } },
      });
      resetAnalyzeRunStorage();
      await expect(readAnalyzeRun(repoPath, { runId })).resolves.toEqual(activated.view);
    },
  );

  it.each([
    ['activated', 4, null, '2026-07-19T01:37:03.000Z'],
    ['executing', 5, '2026-07-19T01:37:04.000Z', '2026-07-19T01:37:04.000Z'],
  ] as const)('reads the reserved schema-v5 resumed %s crash state', async (
    admission,
    revision,
    admittedAt,
    updatedAt,
  ) => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: `reserved-${admission}`,
      candidateAnalysisId: `reserved-${admission}-analysis`,
      startedAt: '2026-07-19T01:37:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'reserved-resume-commit',
      completedBaselineId: null,
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: `reserved-${admission}`,
      sealedAt: '2026-07-19T01:37:01.000Z',
      work: [{ workId: 'analyze:v1:reserved', inputFingerprint: `sha256:${'c'.repeat(64)}` }],
    });
    const file = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      `reserved-${admission}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    stored.revision = revision;
    stored.status = { state: 'running' };
    stored.updatedAt = updatedAt;
    stored.executionAttempt = {
      number: 2,
      activatedAt: '2026-07-19T01:37:03.000Z',
      resume: {
        admission,
        admittedAt,
        resumedFrom: {
          reason: 'provider-session-limit',
          resetHint: 'resets 3am',
          blockedAt: '2026-07-19T01:37:02.000Z',
        },
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'opus[1m]',
          resolvedModel: 'claude-opus-4-8',
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    const bytesBefore = fs.readFileSync(file);
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, { runId: `reserved-${admission}` }))
      .resolves.toMatchObject({
        schemaVersion: 5,
        revision,
        state: 'running',
        executionAttempt: {
          number: 2,
          resume: {
            admission,
            admittedAt,
            executionPin: { resolvedModel: 'claude-opus-4-8' },
          },
        },
      });
    expect(fs.readFileSync(file)).toEqual(bytesBefore);
  });

  it('rejects a schema-v5 run whose resume admission chronology is impossible', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'unreachable-attempt',
      candidateAnalysisId: 'unreachable-attempt-analysis',
      startedAt: '2026-07-19T01:37:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'unreachable-attempt-commit',
      completedBaselineId: null,
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'unreachable-attempt',
      sealedAt: '2026-07-19T01:37:01.000Z',
      work: [{ workId: 'analyze:v1:unreachable', inputFingerprint: `sha256:${'c'.repeat(64)}` }],
    });
    const file = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'unreachable-attempt.json',
    );
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.executionAttempt = {
      number: 2,
      activatedAt: '2026-07-19T01:37:02.000Z',
      resume: {
        admission: 'activated',
        admittedAt: '2026-07-19T01:37:03.000Z',
        resumedFrom: {
          reason: 'provider-session-limit',
          resetHint: 'later',
          blockedAt: '2026-07-19T01:37:01.000Z',
        },
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'opus[1m]',
          resolvedModel: 'claude-opus-4-8',
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, { runId: 'unreachable-attempt' }))
      .rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
  });

  it('requires a completion receipt bound to the exact run and sealed plan', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'exact-finalize-run',
      candidateAnalysisId: 'exact-finalize-analysis',
      startedAt: '2026-07-19T01:40:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'def789',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'exact-finalize-run',
      '2026-07-19T01:40:01.000Z',
    );

    await expect(beginFinalizeAnalyzeRun(repoPath, {
      runId: 'exact-finalize-run',
      finalizingAt: '2026-07-19T01:40:02.000Z',
    }, {} as AnalyzeRunExecutionCompletion)).rejects.toBeInstanceOf(
      InvalidAnalyzeRunTransitionError,
    );
    await expect(beginFinalizeAnalyzeRun(repoPath, {
      runId: 'another-run',
      finalizingAt: '2026-07-19T01:40:02.000Z',
    }, execution.completion)).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(beginFinalizeAnalyzeRun(repoPath, {
      runId: 'exact-finalize-run',
      finalizingAt: '2026-07-19T01:39:59.000Z',
    }, execution.completion)).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      revision: 3,
      state: 'running',
      counts: { pending: 0, succeeded: 1 },
    });
    await expect(beginFinalizeAnalyzeRun(repoPath, {
      runId: 'exact-finalize-run',
      finalizingAt: '2026-07-19T01:40:02.000Z',
    }, execution.completion)).resolves.toMatchObject({ revision: 4, state: 'finalizing' });
  });

  it('records a finalization failure without forgetting successful checkpointed calls', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'finalization-failure-run',
      candidateAnalysisId: 'finalization-failure-analysis',
      startedAt: '2026-07-19T01:55:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '765cba',
      completedBaselineId: 'safe-baseline',
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'finalization-failure-run',
      '2026-07-19T01:55:01.000Z',
    );
    await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'finalization-failure-run',
      finalizingAt: '2026-07-19T01:55:02.000Z',
    }, execution.completion);

    const failed = await dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'finalization-failure-run',
      failedAt: '2026-07-19T01:55:03.000Z',
      error: { code: 'ANALYSIS_PERSIST_FAILED', message: 'Could not persist the candidate.' },
    });

    expect(failed).toMatchObject({
      revision: 5,
      state: 'failed',
      completedBaselineId: 'safe-baseline',
      counts: { total: 1, pending: 0, running: 0, succeeded: 1, failed: 0 },
      failure: {
        code: 'ANALYSIS_PERSIST_FAILED',
        failedAt: '2026-07-19T01:55:03.000Z',
      },
      finalization: { finalizingAt: '2026-07-19T01:55:02.000Z' },
      resume: { available: false, reason: 'checkpoint-reuse-not-enabled' },
    });
  });

  it('does not lose a competing finalization or execution failure', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'finalization-race-run',
      candidateAnalysisId: 'finalization-race-analysis',
      startedAt: '2026-07-19T01:58:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '765fed',
      completedBaselineId: null,
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'finalization-race-run',
      '2026-07-19T01:58:01.000Z',
    );

    const outcomes = await Promise.allSettled([
      beginFinalizeAnalyzeRun(repoPath, {
        runId: 'finalization-race-run',
        finalizingAt: '2026-07-19T01:58:02.000Z',
      }, execution.completion),
      dispatchAnalyzeRun(repoPath, {
        kind: 'fail',
        runId: 'finalization-race-run',
        failedAt: '2026-07-19T01:58:02.000Z',
        error: { code: 'ANALYZE_FAILED', message: 'Competing execution failure.' },
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) =>
      outcome.status === 'rejected' && outcome.reason instanceof AnalyzeRunRevisionConflictError,
    )).toHaveLength(1);
    const latest = await readAnalyzeRun(repoPath, 'latest-attempt');
    expect(latest).toMatchObject({ revision: 4 });
    expect(latest?.counts).toEqual(
      latest?.state === 'finalizing'
        ? { total: 1, pending: 0, running: 0, succeeded: 1, failed: 0 }
        : { total: 1, pending: 1, running: 0, succeeded: 0, failed: 0 },
    );
  });

  it('blocks a sealed run with the raw reset hint and keeps unfinished work pending', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'blocked-run',
      candidateAnalysisId: 'blocked-analysis',
      startedAt: '2026-07-19T02:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'fedcba',
      completedBaselineId: 'completed-analysis-2',
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'blocked-run',
      sealedAt: '2026-07-19T02:00:01.000Z',
      work: [
        { workId: 'analyze:v1:service', inputFingerprint: `sha256:${'c'.repeat(64)}` },
      ],
    });

    const blocked = await dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId: 'blocked-run',
      blockedAt: '2026-07-19T02:00:02.000Z',
      resetHint: '7pm (Africa/Cairo)',
    });

    expect(blocked).toMatchObject({
      revision: 2,
      state: 'blocked',
      updatedAt: '2026-07-19T02:00:02.000Z',
      plan: 'sealed',
      counts: {
        total: 1,
        pending: 1,
        running: 0,
        succeeded: 0,
        failed: 0,
      },
      blocked: {
        reason: 'provider-session-limit',
        resetHint: '7pm (Africa/Cairo)',
        blockedAt: '2026-07-19T02:00:02.000Z',
      },
      resume: {
        available: false,
        reason: 'successful-results-not-checkpointed',
      },
    });

    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toEqual(blocked);
  });

  it('durably records an ordinary failure before the LLM plan is sealed', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'failed-before-plan-run',
      candidateAnalysisId: 'failed-before-plan-analysis',
      startedAt: '2026-07-19T02:30:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc789',
      completedBaselineId: 'completed-analysis-3',
    });

    const failed = await dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'failed-before-plan-run',
      failedAt: '2026-07-19T02:30:01.000Z',
      error: {
        code: 'ANALYZE_FAILED',
        message: 'Project-aware C# analysis requires a restored solution.',
      },
    } as never);

    expect(failed).toMatchObject({
      revision: 1,
      state: 'failed',
      plan: 'unsealed',
      counts: null,
      failure: {
        code: 'ANALYZE_FAILED',
        message: 'Project-aware C# analysis requires a restored solution.',
        failedAt: '2026-07-19T02:30:01.000Z',
      },
      resume: {
        available: false,
        reason: 'successful-results-not-checkpointed',
      },
    });
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toEqual(failed);
  });

  it('reads schema-v1 failure records written before finalization metadata existed', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'legacy-failed-run',
      candidateAnalysisId: 'legacy-failed-analysis',
      startedAt: '2026-07-19T02:35:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'legacy123',
      completedBaselineId: null,
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'legacy-failed-run',
      failedAt: '2026-07-19T02:35:01.000Z',
      error: { code: 'ANALYZE_FAILED', message: 'Legacy ordinary failure.' },
    });
    const file = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'legacy-failed-run.json',
    );
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      schemaVersion: number;
      status: Record<string, unknown>;
      finalizationIntent?: unknown;
    };
    legacy.schemaVersion = 1;
    delete legacy.status.finalizingAt;
    delete legacy.finalizationIntent;
    fs.writeFileSync(file, JSON.stringify(legacy));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      runId: 'legacy-failed-run',
      state: 'failed',
      finalization: null,
    });
    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'run-after-legacy-failure',
      candidateAnalysisId: 'analysis-after-legacy-failure',
      startedAt: '2026-07-19T02:35:02.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'legacy456',
      completedBaselineId: null,
    })).resolves.toMatchObject({ runId: 'run-after-legacy-failure', state: 'running' });
  });

  it('keeps certified pending counts visible when a planned run fails', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'failed-after-plan-run',
      candidateAnalysisId: 'failed-after-plan-analysis',
      startedAt: '2026-07-19T02:45:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'def789',
      completedBaselineId: null,
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'failed-after-plan-run',
      sealedAt: '2026-07-19T02:45:01.000Z',
      work: [{ workId: 'analyze:v1:code', inputFingerprint: `sha256:${'5'.repeat(64)}` }],
    });

    const failed = await dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'failed-after-plan-run',
      failedAt: '2026-07-19T02:45:02.000Z',
      error: { code: 'ANALYZE_FAILED', message: 'LLM work failed before completion.' },
    });

    expect(failed).toMatchObject({
      revision: 2,
      state: 'failed',
      plan: 'sealed',
      counts: { total: 1, pending: 1, succeeded: 0, failed: 0 },
      resume: { available: false, reason: 'successful-results-not-checkpointed' },
    });
  });

  it('reads the schema-v1 finalization states reserved for the next lifecycle writer', async () => {
    const runId = 'reserved-finalization-run';
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId,
      candidateAnalysisId: 'reserved-finalization-analysis',
      startedAt: '2026-07-19T02:50:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'reserved123',
      completedBaselineId: 'safe-baseline',
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId,
      sealedAt: '2026-07-19T02:50:01.000Z',
      work: [{ workId: 'analyze:v1:reserved', inputFingerprint: `sha256:${'a'.repeat(64)}` }],
    });
    const file = path.join(repoPath, '.truecourse', 'analyses', 'runs', `${runId}.json`);
    const sealed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const plan = sealed.plan as { state: string; sealedAt: string; work: Array<Record<string, unknown>> };
    const finalizingAt = '2026-07-19T02:50:02.000Z';
    const finalizing = {
      ...sealed,
      revision: 3,
      updatedAt: finalizingAt,
      status: { state: 'finalizing', finalizingAt },
      plan: { ...plan, work: plan.work.map((item) => ({ ...item, state: 'succeeded-uncheckpointed' })) },
    };
    fs.writeFileSync(file, JSON.stringify(finalizing));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      revision: 3,
      state: 'finalizing',
      counts: { pending: 0, succeeded: 1 },
      finalization: { finalizingAt },
    });

    const failedAt = '2026-07-19T02:50:03.000Z';
    fs.writeFileSync(file, JSON.stringify({
      ...finalizing,
      revision: 4,
      updatedAt: failedAt,
      status: {
        state: 'failed',
        code: 'ANALYSIS_PERSIST_FAILED',
        message: 'The newer writer could not persist the candidate.',
        failedAt,
        finalizingAt,
      },
    }));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      revision: 4,
      state: 'failed',
      counts: { pending: 0, succeeded: 1 },
      finalization: { finalizingAt },
    });
  });

  it('rejects failure timestamps that precede the run or its sealed plan', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'backdated-failure-run',
      candidateAnalysisId: 'backdated-failure-analysis',
      startedAt: '2026-07-19T03:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'ghi789',
      completedBaselineId: null,
    });

    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'backdated-failure-run',
      failedAt: '2026-07-19T02:59:59.000Z',
      error: { code: 'ANALYZE_FAILED', message: 'Backdated failure.' },
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
  });

  it('rejects a plan timestamp that precedes the run', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'backdated-plan-run',
      candidateAnalysisId: 'backdated-plan-analysis',
      startedAt: '2026-07-19T03:05:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'pqr789',
      completedBaselineId: null,
    });

    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'backdated-plan-run',
      sealedAt: '2026-07-19T03:04:59.000Z',
      work: [{ workId: 'analyze:v1:service', inputFingerprint: `sha256:${'7'.repeat(64)}` }],
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
  });

  it('rejects impossible running-state revisions and timestamps from durable storage', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'impossible-running-history-run',
      candidateAnalysisId: 'impossible-running-history-analysis',
      startedAt: '2026-07-19T03:10:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'stu789',
      completedBaselineId: null,
    });
    const file = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'impossible-running-history-run.json',
    );
    const begun = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...begun, updatedAt: '2026-07-19T03:10:01.000Z' }));
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );

    fs.writeFileSync(file, JSON.stringify(begun));
    resetAnalyzeRunStorage();
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'impossible-running-history-run',
      sealedAt: '2026-07-19T03:10:01.000Z',
      work: [{ workId: 'analyze:v1:database', inputFingerprint: `sha256:${'8'.repeat(64)}` }],
    });
    const sealed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...sealed, revision: 3 }));
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );
  });

  it('rejects an impossible unsealed failure revision from durable storage', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'impossible-failure-revision-run',
      candidateAnalysisId: 'impossible-failure-revision-analysis',
      startedAt: '2026-07-19T03:15:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'jkl789',
      completedBaselineId: null,
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'impossible-failure-revision-run',
      failedAt: '2026-07-19T03:15:01.000Z',
      error: { code: 'ANALYZE_FAILED', message: 'Ordinary failure.' },
    });
    const file = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'impossible-failure-revision-run.json',
    );
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.revision = 2;
    fs.writeFileSync(file, JSON.stringify(stored));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );
  });

  it('rejects an impossible sealed failure revision from durable storage', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'impossible-sealed-failure-revision-run',
      candidateAnalysisId: 'impossible-sealed-failure-revision-analysis',
      startedAt: '2026-07-19T03:30:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'mno789',
      completedBaselineId: null,
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'impossible-sealed-failure-revision-run',
      sealedAt: '2026-07-19T03:30:01.000Z',
      work: [{ workId: 'analyze:v1:module', inputFingerprint: `sha256:${'6'.repeat(64)}` }],
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'impossible-sealed-failure-revision-run',
      failedAt: '2026-07-19T03:30:02.000Z',
      error: { code: 'ANALYZE_FAILED', message: 'Ordinary failure.' },
    });
    const file = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'impossible-sealed-failure-revision-run.json',
    );
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.revision = 4;
    fs.writeFileSync(file, JSON.stringify(stored));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );
  });

  it('rejects impossible finalizing lifecycle records from durable storage', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'impossible-finalizing-run',
      candidateAnalysisId: 'impossible-finalizing-analysis',
      startedAt: '2026-07-19T03:40:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'aaa999',
      completedBaselineId: 'older-baseline',
    });
    const execution = await certifySuccessfulExecution(
      repoPath,
      'impossible-finalizing-run',
      '2026-07-19T03:40:01.000Z',
    );
    await beginFinalizeAnalyzeRun(repoPath, {
      runId: 'impossible-finalizing-run',
      finalizingAt: '2026-07-19T03:40:02.000Z',
    }, execution.completion);
    const file = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'impossible-finalizing-run.json',
    );
    const finalizing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const successfulPlan = finalizing.plan as {
      state: string;
      sealedAt: string;
      work: Array<Record<string, unknown>>;
    };
    fs.writeFileSync(file, JSON.stringify({
      ...finalizing,
      plan: {
        ...successfulPlan,
        work: successfulPlan.work.map((item) => ({ ...item, state: 'pending' })),
      },
    }));
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );

    fs.writeFileSync(file, JSON.stringify({
      ...finalizing,
      status: {
        ...(finalizing.status as Record<string, unknown>),
        finalizingAt: '2026-07-19T03:39:59.000Z',
      },
    }));
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );

    fs.writeFileSync(file, JSON.stringify({
      ...finalizing,
      revision: 2,
    }));
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );

    fs.writeFileSync(file, JSON.stringify({
      ...finalizing,
      plan: { state: 'unsealed' },
    }));
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );
  });

  it('rejects one of two competing transitions instead of losing an update', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'concurrent-run',
      candidateAnalysisId: 'concurrent-analysis',
      startedAt: '2026-07-19T03:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '123abc',
      completedBaselineId: null,
    });

    const outcomes = await Promise.allSettled([
      dispatchAnalyzeRun(repoPath, {
        kind: 'seal-plan',
        runId: 'concurrent-run',
        sealedAt: '2026-07-19T03:00:01.000Z',
        work: [{ workId: 'analyze:v1:service', inputFingerprint: `sha256:${'d'.repeat(64)}` }],
      }),
      dispatchAnalyzeRun(repoPath, {
        kind: 'seal-plan',
        runId: 'concurrent-run',
        sealedAt: '2026-07-19T03:00:02.000Z',
        work: [{ workId: 'analyze:v1:module', inputFingerprint: `sha256:${'e'.repeat(64)}` }],
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) =>
      outcome.status === 'rejected' && outcome.reason instanceof AnalyzeRunRevisionConflictError,
    )).toHaveLength(1);
  });

  it('recovers the latest durable run when a crash loses the pointer update', async () => {
    const begun = await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'orphaned-latest-run',
      candidateAnalysisId: 'orphaned-latest-analysis',
      startedAt: '2026-07-19T04:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '456def',
      completedBaselineId: null,
    });
    fs.unlinkSync(path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'LATEST_ATTEMPT.json',
    ));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toEqual(begun);
  });

  it('idempotently repairs the latest pointer when begin is retried after that crash', async () => {
    const command = {
      kind: 'begin' as const,
      runId: 'retried-orphaned-run',
      candidateAnalysisId: 'retried-orphaned-analysis',
      startedAt: '2026-07-19T04:30:00.000Z',
      source: 'cli' as const,
      branch: 'main',
      commitHash: '654fed',
      completedBaselineId: null,
    };
    const begun = await dispatchAnalyzeRun(repoPath, command);
    const latestAttemptPath = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'LATEST_ATTEMPT.json',
    );
    fs.unlinkSync(latestAttemptPath);
    resetAnalyzeRunStorage();

    await expect(dispatchAnalyzeRun(repoPath, command)).resolves.toEqual(begun);
    expect(JSON.parse(fs.readFileSync(latestAttemptPath, 'utf8'))).toEqual({
      schemaVersion: 5,
      runId: command.runId,
    });
  });

  it('fails closed instead of masking a pointer to a missing latest run', async () => {
    const command = {
      kind: 'begin' as const,
      candidateAnalysisId: 'missing-latest-analysis',
      startedAt: '2026-07-19T04:45:00.000Z',
      source: 'cli' as const,
      branch: 'main',
      commitHash: 'aaa111',
      completedBaselineId: null,
    };
    await dispatchAnalyzeRun(repoPath, { ...command, runId: 'preserved-first-run' });
    await dispatchAnalyzeRun(repoPath, { ...command, runId: 'missing-second-run' });
    const runsPath = path.join(repoPath, '.truecourse', 'analyses', 'runs');
    fs.unlinkSync(path.join(runsPath, 'missing-second-run.json'));

    await expect(dispatchAnalyzeRun(repoPath, {
      ...command,
      runId: 'must-not-mask-third-run',
    })).rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
    expect(fs.existsSync(path.join(runsPath, 'must-not-mask-third-run.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(runsPath, 'LATEST_ATTEMPT.json'), 'utf8'))).toEqual({
      schemaVersion: 5,
      runId: 'missing-second-run',
    });
  });

  it('recovers the latest attempt by durable creation order instead of caller timestamps', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'first-created-run',
      candidateAnalysisId: 'first-created-analysis',
      startedAt: '2026-07-19T10:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '111aaa',
      completedBaselineId: null,
    });
    const second = await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'second-created-run',
      candidateAnalysisId: 'second-created-analysis',
      startedAt: '2026-07-19T08:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '222bbb',
      completedBaselineId: null,
    });
    fs.unlinkSync(path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'LATEST_ATTEMPT.json',
    ));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toEqual(second);
  });

  it('does not rewind the latest pointer when an older begin is retried late', async () => {
    const firstCommand = {
      kind: 'begin' as const,
      runId: 'delayed-first-run',
      candidateAnalysisId: 'delayed-first-analysis',
      startedAt: '2026-07-19T08:00:00.000Z',
      source: 'cli' as const,
      branch: 'main',
      commitHash: '333ccc',
      completedBaselineId: null,
    };
    await dispatchAnalyzeRun(repoPath, firstCommand);
    const second = await dispatchAnalyzeRun(repoPath, {
      ...firstCommand,
      runId: 'current-second-run',
      candidateAnalysisId: 'current-second-analysis',
      startedAt: '2026-07-19T09:00:00.000Z',
    });

    await dispatchAnalyzeRun(repoPath, firstCommand);

    expect(JSON.parse(fs.readFileSync(path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'LATEST_ATTEMPT.json',
    ), 'utf8'))).toEqual({
      schemaVersion: 5,
      runId: second.runId,
    });

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toEqual(second);
  });

  it('rejects a conflicting begin that reuses an existing run identity', async () => {
    const command = {
      kind: 'begin' as const,
      runId: 'conflicting-retry-run',
      candidateAnalysisId: 'original-candidate',
      startedAt: '2026-07-19T09:15:00.000Z',
      source: 'cli' as const,
      branch: 'main',
      commitHash: '999ccc',
      completedBaselineId: null,
    };
    await dispatchAnalyzeRun(repoPath, command);

    await expect(dispatchAnalyzeRun(repoPath, {
      ...command,
      candidateAnalysisId: 'different-candidate',
    })).rejects.toBeInstanceOf(AnalyzeRunAlreadyExistsError);
  });

  it('returns the evolved run when its original begin command is retried', async () => {
    const begin = {
      kind: 'begin' as const,
      runId: 'evolved-retry-run',
      candidateAnalysisId: 'evolved-retry-analysis',
      startedAt: '2026-07-19T09:20:00.000Z',
      source: 'cli' as const,
      branch: 'main',
      commitHash: 'bbb222',
      completedBaselineId: null,
    };
    await dispatchAnalyzeRun(repoPath, begin);
    const sealed = await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: begin.runId,
      sealedAt: '2026-07-19T09:20:01.000Z',
      work: [{ workId: 'analyze:v1:database', inputFingerprint: `sha256:${'3'.repeat(64)}` }],
    });

    await expect(dispatchAnalyzeRun(repoPath, begin)).resolves.toEqual(sealed);
  });

  it('rejects an empty certified LLM work plan', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'empty-plan-run',
      candidateAnalysisId: 'empty-plan-analysis',
      startedAt: '2026-07-19T09:30:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '444ddd',
      completedBaselineId: null,
    });

    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'empty-plan-run',
      sealedAt: '2026-07-19T09:30:01.000Z',
      work: [],
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
  });

  it('reserves the latest-attempt pointer name from run IDs', async () => {
    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'LATEST_ATTEMPT',
      candidateAnalysisId: 'reserved-name-analysis',
      startedAt: '2026-07-19T10:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '555eee',
      completedBaselineId: null,
    })).rejects.toThrow(/reserved/i);
  });

  it('runtime-validates begin commands before writing a journal', async () => {
    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'invalid-source-run',
      candidateAnalysisId: 'invalid-source-analysis',
      startedAt: 'not-a-timestamp',
      source: 'unsupported' as never,
      branch: 'main',
      commitHash: '666fff',
      completedBaselineId: null,
    })).rejects.toThrow();
    expect(fs.existsSync(path.join(repoPath, '.truecourse', 'analyses', 'runs'))).toBe(false);
  });

  it('rejects unknown command kinds and non-string identities before writing', async () => {
    const base = {
      runId: 'runtime-shape-run',
      candidateAnalysisId: 'runtime-shape-analysis',
      startedAt: '2026-07-19T10:30:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc999',
      completedBaselineId: null,
    };

    await expect(dispatchAnalyzeRun(repoPath, {
      ...base,
      kind: 'unexpected',
    } as never)).rejects.toThrow(/command kind/i);
    await expect(dispatchAnalyzeRun(repoPath, {
      ...base,
      kind: 'begin',
      candidateAnalysisId: 42,
    } as never)).rejects.toThrow(/candidateAnalysisId/i);
    expect(fs.existsSync(path.join(repoPath, '.truecourse', 'analyses', 'runs'))).toBe(false);
  });

  it('fails closed when a hosted run has no hosted storage adapter', async () => {
    const hostedRepoKey = path.join(repoPath, 'hosted-storage-must-not-use-filesystem');
    await expect(dispatchAnalyzeRun(hostedRepoKey, {
      kind: 'begin',
      runId: 'unconfigured-hosted-run',
      candidateAnalysisId: 'unconfigured-hosted-analysis',
      startedAt: '2026-07-19T10:45:00.000Z',
      source: 'hosted',
      branch: null,
      commitHash: null,
      completedBaselineId: null,
    })).rejects.toThrow(/hosted storage adapter/i);
    expect(fs.existsSync(hostedRepoKey)).toBe(false);
  });

  it('serializes aliased paths as the same repository', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'aliased-concurrent-run',
      candidateAnalysisId: 'aliased-concurrent-analysis',
      startedAt: '2026-07-19T11:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '777aaa',
      completedBaselineId: null,
    });

    const outcomes = await Promise.allSettled([
      dispatchAnalyzeRun(repoPath, {
        kind: 'seal-plan',
        runId: 'aliased-concurrent-run',
        sealedAt: '2026-07-19T11:00:01.000Z',
        work: [{ workId: 'analyze:v1:service', inputFingerprint: `sha256:${'1'.repeat(64)}` }],
      }),
      dispatchAnalyzeRun(`${repoPath}${path.sep}.`, {
        kind: 'seal-plan',
        runId: 'aliased-concurrent-run',
        sealedAt: '2026-07-19T11:00:02.000Z',
        work: [{ workId: 'analyze:v1:module', inputFingerprint: `sha256:${'2'.repeat(64)}` }],
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) =>
      outcome.status === 'rejected' && outcome.reason instanceof AnalyzeRunRevisionConflictError,
    )).toHaveLength(1);
  });

  it('reports malformed persisted work as journal corruption', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'corrupt-work-run',
      candidateAnalysisId: 'corrupt-work-analysis',
      startedAt: '2026-07-19T05:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '789abc',
      completedBaselineId: null,
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'corrupt-work-run',
      sealedAt: '2026-07-19T05:00:01.000Z',
      work: [{ workId: 'analyze:v1:service', inputFingerprint: `sha256:${'f'.repeat(64)}` }],
    });
    const runPath = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'corrupt-work-run.json',
    );
    const stored = JSON.parse(fs.readFileSync(runPath, 'utf8')) as {
      plan: { work: Array<{ inputFingerprint: string }> };
    };
    stored.plan.work[0].inputFingerprint = 'not-a-fingerprint';
    fs.writeFileSync(runPath, JSON.stringify(stored));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );
  });

  it('rejects a persisted blocked run whose certified plan was never sealed', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'impossible-blocked-run',
      candidateAnalysisId: 'impossible-blocked-analysis',
      startedAt: '2026-07-19T06:00:00.000Z',
      source: 'dashboard',
      branch: 'main',
      commitHash: '987cba',
      completedBaselineId: null,
    });
    const runPath = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'impossible-blocked-run.json',
    );
    const stored = JSON.parse(fs.readFileSync(runPath, 'utf8')) as Record<string, unknown>;
    stored.status = {
      state: 'blocked',
      reason: 'provider-session-limit',
      resetHint: '7pm (Africa/Cairo)',
      blockedAt: '2026-07-19T06:00:01.000Z',
    };
    fs.writeFileSync(runPath, JSON.stringify(stored));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );
  });

  it('rejects a persisted sealed plan with no certified LLM work', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'corrupt-empty-plan-run',
      candidateAnalysisId: 'corrupt-empty-plan-analysis',
      startedAt: '2026-07-19T11:30:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'ccc333',
      completedBaselineId: null,
    });
    await dispatchAnalyzeRun(repoPath, {
      kind: 'seal-plan',
      runId: 'corrupt-empty-plan-run',
      sealedAt: '2026-07-19T11:30:01.000Z',
      work: [{ workId: 'analyze:v1:code', inputFingerprint: `sha256:${'4'.repeat(64)}` }],
    });
    const file = path.join(repoPath, '.truecourse', 'analyses', 'runs', 'corrupt-empty-plan-run.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      plan: { work: unknown[] };
    };
    stored.plan.work = [];
    fs.writeFileSync(file, JSON.stringify(stored));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );
  });

  it('rejects a journal whose filename and embedded run identity disagree', async () => {
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'filename-run',
      candidateAnalysisId: 'filename-analysis',
      startedAt: '2026-07-19T12:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: '888bbb',
      completedBaselineId: null,
    });
    const file = path.join(repoPath, '.truecourse', 'analyses', 'runs', 'filename-run.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    stored.runId = 'embedded-other-run';
    fs.writeFileSync(file, JSON.stringify(stored));
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, { runId: 'filename-run' })).rejects.toBeInstanceOf(
      AnalyzeRunJournalCorruptError,
    );
  });
});
