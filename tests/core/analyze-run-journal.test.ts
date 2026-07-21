import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AnalyzeRunStorage,
  type StoredAnalyzeRun,
  AnalyzeRunAlreadyExistsError,
  AnalyzeRunJournalCorruptError,
  AnalyzeRunRevisionConflictError,
  InvalidAnalyzeRunTransitionError,
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  setAnalyzeRunStorage,
} from '../../packages/core/src/lib/analyze-run-journal.js';

let repoPath: string;

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
      async compareAndSwap(receivedRepoKey, runId, expectedRevision, next) {
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
    const sealed = await dispatchAnalyzeRun(repoKey, {
      kind: 'seal-plan',
      runId: 'hosted-run',
      sealedAt: '2026-07-19T00:30:01.000Z',
      work: [{ workId: 'analyze:v1:hosted', inputFingerprint: `sha256:${'0'.repeat(64)}` }],
    });

    expect(sealed).toMatchObject({
      runId: 'hosted-run',
      revision: 1,
      plan: 'sealed',
      counts: { total: 1, pending: 1 },
    });
    await expect(readAnalyzeRun(repoKey, 'latest-attempt')).resolves.toEqual(sealed);
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
      async compareAndSwap(_key, _runId, _revision, next) {
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
      async compareAndSwap(_key, _runId, _revision, next) {
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
      schemaVersion: 1,
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
      schemaVersion: 1,
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
      schemaVersion: 1,
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
      schemaVersion: 1,
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
