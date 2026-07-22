import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readAnalyzeRunStatus,
  waitForAnalyzeRunReset,
} from '../../packages/core/src/commands/analyze-run-status.js';
import {
  buildAnalysisFilename,
  clearLatestCache,
  resetAnalysisStore,
  writeLatest,
} from '../../packages/core/src/lib/analysis-store.js';
import {
  admitAnalyzeRunPlanExecution,
  dispatchAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  type AnalyzeRunPlanActivation,
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
    const activation = await sealAnalyzeRunPlan(repoPath, {
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
    await admitInitialExecutionForTest(
      activation,
      'latest-attempt-1',
      [
        { workId: 'analyze:v1:service', inputFingerprint: `sha256:${'a'.repeat(64)}` },
        { workId: 'analyze:v1:module', inputFingerprint: `sha256:${'b'.repeat(64)}` },
      ],
      '2026-07-19T10:00:01.500Z',
    );
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
        lastProviderLimit: {
          resetHint: 'tomorrow 8pm (Africa/Cairo)',
          resetAt: '2026-07-20T17:00:00.000Z',
        },
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

  it('waits for the certified provider reset and returns the unchanged exact attempt', async () => {
    const status = await createWaitableStatus('tomorrow 8pm (Africa/Cairo)');
    const clock = { waitUntil: vi.fn(async () => undefined) };
    const inspectStatus = vi.fn(async () => structuredClone(status));
    const onWait = vi.fn();

    await expect(waitForAnalyzeRunReset(repoPath, 'waited-attempt-1', {
      clock,
      inspectStatus,
      onWait,
    })).resolves.toMatchObject({
      latestAttempt: {
        runId: 'waited-attempt-1',
        revision: 3,
        lastProviderLimit: { resetAt: '2026-07-20T17:00:00.000Z' },
      },
      activeCompletedAnalysis: { analysisId: 'completed-analysis-1' },
    });
    expect(clock.waitUntil).toHaveBeenCalledWith(
      1_784_566_800_000,
      expect.any(AbortSignal),
    );
    expect(inspectStatus).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenCalledWith({
      runId: 'waited-attempt-1',
      resetAt: '2026-07-20T17:00:00.000Z',
      completed: 0,
      pending: 1,
      activeCompletedAnalysisId: 'completed-analysis-1',
    });
  });

  it('does not invent a timer from an uncertified provider reset hint', async () => {
    const status = await createWaitableStatus('6:40pm');
    const clock = { waitUntil: vi.fn(async () => undefined) };

    await expect(waitForAnalyzeRunReset(repoPath, 'waited-attempt-1', {
      clock,
      inspectStatus: async () => structuredClone(status),
    })).rejects.toMatchObject({ reason: 'reset-time-uncertified' });
    expect(clock.waitUntil).not.toHaveBeenCalled();
  });

  it('fails closed when the certified reset evidence changes while waiting', async () => {
    const status = await createWaitableStatus('tomorrow 8pm (Africa/Cairo)');
    const changed = structuredClone(status);
    changed.latestAttempt!.lastProviderLimit!.resetHint = 'tomorrow 9pm (Africa/Cairo)';
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(changed);

    await expect(waitForAnalyzeRunReset(repoPath, 'waited-attempt-1', {
      clock: { waitUntil: async () => undefined },
      inspectStatus,
    })).rejects.toMatchObject({ reason: 'attempt-changed' });
    expect(inspectStatus).toHaveBeenCalledTimes(2);
  });

  it('cancels a process-bound wait without a post-wake status read', async () => {
    const status = await createWaitableStatus('tomorrow 8pm (Africa/Cairo)');
    status.latestAttempt!.lastProviderLimit!.resetAt = '2099-07-20T17:00:00.000Z';
    const inspectStatus = vi.fn(async () => structuredClone(status));
    const controller = new AbortController();

    const waiting = waitForAnalyzeRunReset(repoPath, 'waited-attempt-1', {
      signal: controller.signal,
      inspectStatus,
    });
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(inspectStatus).toHaveBeenCalledOnce();
  });

  it('does not return zero-pending recovery after cancellation during the initial status read', async () => {
    const status = await createWaitableStatus('tomorrow 8pm (Africa/Cairo)');
    status.latestAttempt!.counts = {
      total: 1,
      pending: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
    };
    const controller = new AbortController();
    let resolveStatus!: (value: typeof status) => void;
    const inspectStatus = vi.fn(() => new Promise<typeof status>((resolve) => {
      resolveStatus = resolve;
    }));

    const waiting = waitForAnalyzeRunReset(repoPath, 'waited-attempt-1', {
      signal: controller.signal,
      inspectStatus,
    });
    await vi.waitFor(() => expect(inspectStatus).toHaveBeenCalledOnce());
    controller.abort();
    resolveStatus(status);

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not continue after cancellation during the authoritative post-wake reread', async () => {
    const status = await createWaitableStatus('tomorrow 8pm (Africa/Cairo)');
    const controller = new AbortController();
    let resolveRefreshed!: (value: typeof status) => void;
    const inspectStatus = vi.fn()
      .mockResolvedValueOnce(status)
      .mockImplementationOnce(() => new Promise<typeof status>((resolve) => {
        resolveRefreshed = resolve;
      }));

    const waiting = waitForAnalyzeRunReset(repoPath, 'waited-attempt-1', {
      signal: controller.signal,
      clock: { waitUntil: async () => undefined },
      inspectStatus,
    });
    await vi.waitFor(() => expect(inspectStatus).toHaveBeenCalledTimes(2));
    controller.abort();
    resolveRefreshed(status);

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns zero-pending recovery immediately without reset evidence or a timer', async () => {
    const status = await createWaitableStatus('tomorrow 8pm (Africa/Cairo)');
    status.latestAttempt!.counts = {
      total: 1,
      pending: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
    };
    status.latestAttempt!.lastProviderLimit = null;
    const clock = { waitUntil: vi.fn(async () => undefined) };
    const inspectStatus = vi.fn(async () => structuredClone(status));

    await expect(waitForAnalyzeRunReset(repoPath, 'waited-attempt-1', {
      clock,
      inspectStatus,
    })).resolves.toEqual(status);
    expect(clock.waitUntil).not.toHaveBeenCalled();
    expect(inspectStatus).toHaveBeenCalledOnce();
  });
});

async function createWaitableStatus(resetHint: string): Promise<Awaited<ReturnType<typeof readAnalyzeRunStatus>>> {
  const completed = completedLatest();
  await writeLatest(repoPath, completed);
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId: 'waited-attempt-1',
    candidateAnalysisId: 'incomplete-analysis-2',
    startedAt: '2026-07-19T10:00:00.000Z',
    source: 'cli',
    branch: 'main',
    commitHash: 'def456',
    completedBaselineId: completed.analysis.id,
  });
  const activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    runId: 'waited-attempt-1',
    sealedAt: '2026-07-19T10:00:01.000Z',
    execution: {
      provider: 'claude-cli',
      requestedModel: 'sonnet',
      promptSchemaVersion: 'test-prompt-v1',
      outputSchemaVersion: 'test-output-v1',
    },
    work: [
      { workId: 'analyze:v1:service', inputFingerprint: `sha256:${'a'.repeat(64)}` },
    ],
  });
  await admitInitialExecutionForTest(
    activation,
    'waited-attempt-1',
    [{ workId: 'analyze:v1:service', inputFingerprint: `sha256:${'a'.repeat(64)}` }],
    '2026-07-19T10:00:01.500Z',
  );
  await dispatchAnalyzeRun(repoPath, {
    kind: 'block',
    runId: 'waited-attempt-1',
    blockedAt: '2026-07-19T10:00:02.000Z',
    resetHint,
  });
  return readAnalyzeRunStatus(repoPath);
}

async function admitInitialExecutionForTest(
  activation: AnalyzeRunPlanActivation,
  runId: string,
  work: readonly { readonly workId: string; readonly inputFingerprint: string }[],
  admittedAt: string,
): Promise<void> {
  const stopped = new Error('stop after initial admission');
  const admission = await admitAnalyzeRunPlanExecution(
    activation,
    repoPath,
    runId,
    work,
    admittedAt,
    () => undefined,
    async () => { throw stopped; },
  );
  if (!admission.admitted) throw new Error('expected initial execution admission');
  await expect(admission.execution).rejects.toBe(stopped);
}

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
