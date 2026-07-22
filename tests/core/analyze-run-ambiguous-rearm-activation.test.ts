import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateAnalyzeRunAmbiguousRearm,
  AnalyzeRunJournalCorruptError,
  admitAnalyzeRunPlanExecution,
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  type AnalyzeRunPlanActivation,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import { certifyAnalyzeRunAmbiguousRearmActivation } from '../../packages/core/src/lib/analyze-run-ambiguous-rearm-activation-certification.js';
import { buildAnalysisFilename } from '../../packages/core/src/lib/analysis-store.js';
import { fingerprint } from '../../packages/core/src/lib/canonical-json.js';

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-ambiguous-rearm-activation-'));
  resetAnalyzeRunStorage();
});

afterEach(() => {
  resetAnalyzeRunStorage();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('ambiguous analyze execution activation', () => {
  it('atomically activates a checkpoint-pinned initial ambiguity without provider work', async () => {
    const runId = 'rearm-initial-run';
    const work = [
      { workId: 'analyze:v1:reused', inputFingerprint: `sha256:${'a'.repeat(64)}` },
      { workId: 'analyze:v1:pending', inputFingerprint: `sha256:${'b'.repeat(64)}` },
    ];
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId,
      candidateAnalysisId: 'rearm-initial-analysis',
      startedAt: '2026-07-22T13:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'rearm-initial-commit',
      completedBaselineId: null,
    });
    const plan = await sealAnalyzeRunPlan(repoPath, {
      kind: 'seal-plan',
      runId,
      sealedAt: '2026-07-22T13:00:01.000Z',
      execution: { provider: 'claude-code', requestedModel: 'sonnet' },
      work,
    });
    await admitInitialExecution(plan, runId, work, '2026-07-22T13:00:02.000Z');
    checkpointRaw(runId, '2026-07-22T13:00:03.000Z');
    resetAnalyzeRunStorage();

    const observed = await readAnalyzeRun(repoPath, 'latest-attempt');
    if (observed?.rearm === null || observed === null) throw new Error('expected rearm evidence');
    const command = {
        kind: 'activate-ambiguous-rearm',
        runId,
        candidateAnalysisId: 'rearm-initial-analysis',
        startedAt: '2026-07-22T13:00:00.000Z',
        source: 'cli',
        branch: 'main',
        commitHash: 'rearm-initial-commit',
        completedBaselineId: null,
        activatedAt: '2026-07-22T13:00:04.000Z',
        work,
        reusedWorkIds: ['analyze:v1:reused'],
        pendingWorkIds: ['analyze:v1:pending'],
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'resolved',
          resolvedModel: 'claude-sonnet-4-6',
        },
        consent: {
          evidence: observed.rearm.evidence,
          acceptedRisk: 'repeat-up-to-pending-provider-calls',
          acceptedMaxRepeatProviderCalls: 1,
        },
        observed: {
          runRevision: observed.revision,
          attemptSequence: 1,
          latestAttemptSequence: 1,
          completedBaselineFingerprint: null,
        },
      } as const;
    const activated = await activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation(command),
    );

    expect(activated.view).toMatchObject({
      schemaVersion: 9,
      revision: 4,
      state: 'running',
      counts: { total: 2, succeeded: 1, pending: 1 },
      executionAttempt: {
        number: 2,
        activatedAt: '2026-07-22T13:00:04.000Z',
        initialAdmission: null,
        resume: {
          activation: 'ambiguous-rearm',
          admission: 'activated',
          admittedAt: null,
          resumedFrom: null,
          executionPin: { resolvedModel: 'claude-sonnet-4-6' },
        },
      },
      rearm: null,
    });
    const stored = JSON.parse(fs.readFileSync(runFile(runId), 'utf8'));
    expect(stored).toMatchObject({
      schemaVersion: 9,
      revision: 4,
      rearmHistory: [{
        evidence: observed.rearm.evidence,
        acceptedAt: '2026-07-22T13:00:04.000Z',
        acceptedRisk: 'repeat-up-to-pending-provider-calls',
        acceptedMaxRepeatProviderCalls: 1,
        executionPin: { resolvedModel: 'claude-sonnet-4-6' },
      }],
    });
    expect(fs.existsSync(path.join(repoPath, '.truecourse', 'LATEST.json'))).toBe(false);

    const bytesAfterActivation = fs.readFileSync(runFile(runId));
    const recovered = await activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation(command),
    );
    expect(recovered.view).toEqual(activated.view);
    expect(fs.readFileSync(runFile(runId))).toEqual(bytesAfterActivation);
    expect((JSON.parse(bytesAfterActivation.toString()) as Record<string, any>).rearmHistory)
      .toHaveLength(1);
  });

  it('allows an explicit requested model without checkpoints but rejects automatic selection', async () => {
    const explicit = await createUncheckpointedAmbiguity('rearm-explicit-model', 'sonnet', 1);
    const explicitActivated = await activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...explicit.command,
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'requested',
          resolvedModel: null,
        },
      }),
    );
    expect(explicitActivated.view).toMatchObject({
      revision: 3,
      executionAttempt: {
        number: 2,
        resume: { activation: 'ambiguous-rearm', admission: 'activated' },
      },
    });

    const automatic = await createUncheckpointedAmbiguity('rearm-auto-model', null, 2);
    const before = fs.readFileSync(runFile('rearm-auto-model'));
    await expect(activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...automatic.command,
        executionPin: {
          provider: 'claude-code',
          requestedModel: null,
          modelSelection: 'requested',
          resolvedModel: null,
        },
      }),
    )).rejects.toThrow(/checkpoint model is unverified/);
    expect(fs.readFileSync(runFile('rearm-auto-model'))).toEqual(before);
  });

  it('rearms a resumed ambiguous epoch and retains its provider-limit origin', async () => {
    const runId = 'rearm-resumed-origin';
    const prepared = await createUncheckpointedAmbiguity(runId, 'sonnet', 1);
    const file = runFile(runId);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    stored.schemaVersion = 8;
    delete stored.rearmHistory;
    stored.revision = 6;
    stored.updatedAt = '2026-07-22T14:00:06.000Z';
    stored.executionAttempt = {
      number: 2,
      activatedAt: '2026-07-22T14:00:05.000Z',
      initialAdmission: null,
      resume: {
        admission: 'executing',
        admittedAt: '2026-07-22T14:00:06.000Z',
        resumedFrom: {
          reason: 'provider-session-limit',
          resetHint: 'resets at 4pm',
          blockedAt: '2026-07-22T14:00:04.000Z',
        },
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'resolved',
          resolvedModel: 'claude-sonnet-4-6',
        },
      },
    };
    const checkpointIndex = stored.plan.work.findIndex(
      (item: Record<string, unknown>) => item.workId === prepared.command.work[0]!.workId,
    );
    const result = { violations: [] };
    stored.plan.work[checkpointIndex] = {
      ...stored.plan.work[checkpointIndex],
      state: 'succeeded-checkpointed',
      checkpoint: {
        checkpointedAt: '2026-07-22T14:00:03.000Z',
        attemptId: 'initial:checkpoint',
        resultContractId: 'analyze.code@1',
        resultFingerprint: fingerprint(result),
        result,
        usage: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          resolvedModel: 'claude-sonnet-4-6',
          callType: 'code',
          inputTokens: 3,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 5,
          costUsd: null,
          durationMs: 20,
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    resetAnalyzeRunStorage();
    const observed = await readAnalyzeRun(repoPath, 'latest-attempt');
    if (observed?.rearm == null) throw new Error('expected resumed rearm evidence');
    const pendingWorkIds = prepared.command.work
      .filter((item) => item.workId !== prepared.command.work[0]!.workId)
      .map((item) => item.workId);
    const activated = await activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...prepared.command,
        activatedAt: '2026-07-22T14:00:07.000Z',
        reusedWorkIds: [prepared.command.work[0]!.workId],
        pendingWorkIds,
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'resolved',
          resolvedModel: 'claude-sonnet-4-6',
        },
        consent: {
          evidence: observed.rearm.evidence,
          acceptedRisk: 'repeat-up-to-pending-provider-calls',
          acceptedMaxRepeatProviderCalls: 1,
        },
        observed: {
          runRevision: 6,
          attemptSequence: 1,
          latestAttemptSequence: 1,
          completedBaselineFingerprint: null,
        },
      }),
    );
    expect(activated.view).toMatchObject({
      revision: 7,
      executionAttempt: {
        number: 3,
        resume: {
          activation: 'ambiguous-rearm',
          admission: 'activated',
          resumedFrom: {
            reason: 'provider-session-limit',
            blockedAt: '2026-07-22T14:00:04.000Z',
          },
        },
      },
    });
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>).rearmHistory[0])
      .toMatchObject({
        evidence: { executionEpoch: { kind: 'resume', attemptNumber: 2 } },
      });
  });

  it('retains a resumed epoch resolved-model pin even when it has no checkpoints', async () => {
    const runId = 'rearm-resumed-no-checkpoint';
    const prepared = await createUncheckpointedAmbiguity(runId, 'sonnet', 1);
    const file = runFile(runId);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    stored.schemaVersion = 8;
    delete stored.rearmHistory;
    stored.revision = 5;
    stored.updatedAt = '2026-07-22T14:00:06.000Z';
    stored.executionAttempt = {
      number: 2,
      activatedAt: '2026-07-22T14:00:05.000Z',
      initialAdmission: null,
      resume: {
        admission: 'executing',
        admittedAt: '2026-07-22T14:00:06.000Z',
        resumedFrom: {
          reason: 'provider-session-limit',
          resetHint: 'resets at 4pm',
          blockedAt: '2026-07-22T14:00:04.000Z',
        },
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'resolved',
          resolvedModel: 'claude-sonnet-4-6',
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    resetAnalyzeRunStorage();
    const observed = await readAnalyzeRun(repoPath, 'latest-attempt');
    if (observed?.rearm == null) throw new Error('expected resumed rearm evidence');
    const command = {
      ...prepared.command,
      activatedAt: '2026-07-22T14:00:07.000Z',
      executionPin: {
        provider: 'claude-code',
        requestedModel: 'sonnet',
        modelSelection: 'resolved' as const,
        resolvedModel: 'claude-sonnet-4-6',
      },
      consent: {
        evidence: observed.rearm.evidence,
        acceptedRisk: 'repeat-up-to-pending-provider-calls' as const,
        acceptedMaxRepeatProviderCalls: 2,
      },
      observed: {
        runRevision: 5,
        attemptSequence: 1,
        latestAttemptSequence: 1,
        completedBaselineFingerprint: null,
      },
    };
    await expect(activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...command,
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'requested',
          resolvedModel: null,
        },
      }),
    )).rejects.toThrow(/checkpoint model is unverified/);
    await expect(activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation(command),
    )).resolves.toMatchObject({
      view: { revision: 6, executionAttempt: { resume: { executionPin: command.executionPin } } },
    });
  });

  it('rejects stale evidence and work before the activation CAS', async () => {
    const runId = 'rearm-stale-command';
    const prepared = await createUncheckpointedAmbiguity(runId, 'sonnet', 1);
    const pin = {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      modelSelection: 'requested' as const,
      resolvedModel: null,
    };
    const before = fs.readFileSync(runFile(runId));
    await expect(activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...prepared.command,
        executionPin: pin,
        consent: {
          ...prepared.command.consent,
          evidence: {
            ...prepared.command.consent.evidence,
            runRevision: prepared.command.consent.evidence.runRevision + 1,
          },
        },
      }),
    )).rejects.toThrow(/evidence-changed/);
    await expect(activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...prepared.command,
        executionPin: pin,
        work: prepared.command.work.map((item, index) => index === 0
          ? { ...item, inputFingerprint: `sha256:${'e'.repeat(64)}` }
          : item),
      }),
    )).rejects.toThrow(/sealed work changed/);
    expect(fs.readFileSync(runFile(runId))).toEqual(before);
  });

  it('fails closed when durable rearm history is no longer self-consistent', async () => {
    const runId = 'rearm-corrupt-history';
    const prepared = await createUncheckpointedAmbiguity(runId, 'sonnet', 1);
    await activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...prepared.command,
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'requested',
          resolvedModel: null,
        },
      }),
    );
    const file = runFile(runId);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    for (const mutate of [
      (value: Record<string, any>) => { value.rearmHistory[0].evidence.pendingWorkCount = 1; },
      (value: Record<string, any>) => {
        value.rearmHistory[0].evidence.executionEpoch.attemptNumber = 2;
      },
      (value: Record<string, any>) => { value.rearmHistory[0].executionPin.provider = 'other'; },
    ]) {
      const corrupt = structuredClone(stored);
      mutate(corrupt);
      fs.writeFileSync(file, JSON.stringify(corrupt));
      resetAnalyzeRunStorage();
      await expect(readAnalyzeRun(repoPath, 'latest-attempt'))
        .rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
    }
  });

  it('keeps revision arithmetic contiguous across repeated ambiguous rearms', async () => {
    const runId = 'rearm-repeated';
    const prepared = await createUncheckpointedAmbiguity(runId, 'sonnet', 1);
    const pin = {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      modelSelection: 'requested' as const,
      resolvedModel: null,
    };
    await activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({ ...prepared.command, executionPin: pin }),
    );
    const file = runFile(runId);
    const executing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    executing.revision = 4;
    executing.updatedAt = '2026-07-22T14:00:04.000Z';
    executing.executionAttempt.resume.admission = 'executing';
    executing.executionAttempt.resume.admittedAt = '2026-07-22T14:00:04.000Z';
    fs.writeFileSync(file, JSON.stringify(executing));
    resetAnalyzeRunStorage();
    const observed = await readAnalyzeRun(repoPath, 'latest-attempt');
    if (observed?.rearm == null) throw new Error('expected second rearm evidence');
    const second = await activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...prepared.command,
        activatedAt: '2026-07-22T14:00:05.000Z',
        executionPin: pin,
        consent: {
          evidence: observed.rearm.evidence,
          acceptedRisk: 'repeat-up-to-pending-provider-calls',
          acceptedMaxRepeatProviderCalls: 2,
        },
        observed: {
          runRevision: 4,
          attemptSequence: 1,
          latestAttemptSequence: 1,
          completedBaselineFingerprint: null,
        },
      }),
    );
    expect(second.view).toMatchObject({ revision: 5, executionAttempt: { number: 3 } });
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>).rearmHistory)
      .toHaveLength(2);
  });

  it('round-trips admission, checkpoints, and repeated rearm at one legal timestamp', async () => {
    const runId = 'rearm-equal-timestamps';
    const prepared = await createUncheckpointedAmbiguity(runId, 'sonnet', 1);
    const pin = {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      modelSelection: 'requested' as const,
      resolvedModel: null,
    };
    await activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...prepared.command,
        activatedAt: '2026-07-22T14:00:02.000Z',
        executionPin: pin,
      }),
    );
    const file = runFile(runId);
    const executing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    executing.revision = 5;
    executing.updatedAt = '2026-07-22T14:00:02.000Z';
    executing.executionAttempt.resume.admission = 'executing';
    executing.executionAttempt.resume.admittedAt = '2026-07-22T14:00:02.000Z';
    const result = { violations: [] };
    executing.plan.work[0] = {
      ...executing.plan.work[0],
      state: 'succeeded-checkpointed',
      checkpoint: {
        checkpointedAt: '2026-07-22T14:00:02.000Z',
        attemptId: 'rearmed:equal-time',
        resultContractId: 'analyze.code@1',
        resultFingerprint: fingerprint(result),
        result,
        usage: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          resolvedModel: 'claude-sonnet-4-6',
          callType: 'code',
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          costUsd: null,
          durationMs: 1,
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(executing));
    resetAnalyzeRunStorage();
    const observed = await readAnalyzeRun(repoPath, 'latest-attempt');
    if (observed?.rearm == null) throw new Error('expected equal-time rearm evidence');
    const pendingWorkIds = prepared.command.work
      .filter((item) => item.workId !== executing.plan.work[0].workId)
      .map((item) => item.workId);
    await expect(activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...prepared.command,
        activatedAt: '2026-07-22T14:00:02.000Z',
        reusedWorkIds: [executing.plan.work[0].workId],
        pendingWorkIds,
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'resolved',
          resolvedModel: 'claude-sonnet-4-6',
        },
        consent: {
          evidence: observed.rearm.evidence,
          acceptedRisk: 'repeat-up-to-pending-provider-calls',
          acceptedMaxRepeatProviderCalls: 1,
        },
        observed: {
          runRevision: 5,
          attemptSequence: 1,
          latestAttemptSequence: 1,
          completedBaselineFingerprint: null,
        },
      }),
    )).resolves.toMatchObject({ view: { revision: 6, executionAttempt: { number: 3 } } });
    const correct = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    for (const mutate of [
      (value: Record<string, any>) => {
        value.rearmHistory[0].evidence.pendingWorkCount = 1;
        value.rearmHistory[0].acceptedMaxRepeatProviderCalls = 1;
        value.rearmHistory[0].evidence.runRevision = 3;
        value.rearmHistory[1].evidence.pendingWorkCount = 2;
        value.rearmHistory[1].acceptedMaxRepeatProviderCalls = 2;
        value.rearmHistory[1].evidence.runRevision = 4;
      },
      (value: Record<string, any>) => {
        value.rearmHistory[1].evidence.executionEpoch.activatedAt
          = '2026-07-22T14:00:01.500Z';
        value.rearmHistory[1].evidence.admittedAt = '2026-07-22T14:00:01.750Z';
      },
    ]) {
      const corrupt = structuredClone(correct);
      mutate(corrupt);
      fs.writeFileSync(file, JSON.stringify(corrupt));
      resetAnalyzeRunStorage();
      await expect(readAnalyzeRun(repoPath, 'latest-attempt'))
        .rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
    }
  });

  it('lets only one competing non-identical activation win the latest-attempt CAS', async () => {
    const runId = 'rearm-cas-race';
    const prepared = await createUncheckpointedAmbiguity(runId, 'sonnet', 1);
    const pin = {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      modelSelection: 'requested' as const,
      resolvedModel: null,
    };
    const outcomes = await Promise.allSettled([
      activateAnalyzeRunAmbiguousRearm(
        repoPath,
        certifyAnalyzeRunAmbiguousRearmActivation({ ...prepared.command, executionPin: pin }),
      ),
      activateAnalyzeRunAmbiguousRearm(
        repoPath,
        certifyAnalyzeRunAmbiguousRearmActivation({
          ...prepared.command,
          activatedAt: '2026-07-22T14:00:04.000Z',
          executionPin: pin,
        }),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect((JSON.parse(fs.readFileSync(runFile(runId), 'utf8')) as Record<string, any>).rearmHistory)
      .toHaveLength(1);
  });

  it('preserves an existing completed baseline and rejects a stale baseline fingerprint', async () => {
    const baseline = completedBaseline('active-baseline');
    const prepared = await createUncheckpointedAmbiguity(
      'rearm-with-baseline',
      'sonnet',
      1,
      baseline,
    );
    const latestPath = path.join(repoPath, '.truecourse', 'LATEST.json');
    const baselineBefore = fs.readFileSync(latestPath);
    const runBefore = fs.readFileSync(runFile('rearm-with-baseline'));
    const pin = {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      modelSelection: 'requested' as const,
      resolvedModel: null,
    };
    await expect(activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...prepared.command,
        executionPin: pin,
        observed: {
          ...prepared.command.observed,
          completedBaselineFingerprint: `sha256:${'f'.repeat(64)}`,
        },
      }),
    )).rejects.toThrow(/completed baseline changed/);
    expect(fs.readFileSync(runFile('rearm-with-baseline'))).toEqual(runBefore);
    await activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({ ...prepared.command, executionPin: pin }),
    );
    expect(fs.readFileSync(latestPath)).toEqual(baselineBefore);
  });

  it('does not activate a run after a newer attempt supersedes it', async () => {
    const prepared = await createUncheckpointedAmbiguity('rearm-superseded', 'sonnet', 1);
    const before = fs.readFileSync(runFile('rearm-superseded'));
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'newer-attempt',
      candidateAnalysisId: 'newer-analysis',
      startedAt: '2026-07-22T15:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'newer-commit',
      completedBaselineId: null,
    });
    await expect(activateAnalyzeRunAmbiguousRearm(
      repoPath,
      certifyAnalyzeRunAmbiguousRearmActivation({
        ...prepared.command,
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'requested',
          resolvedModel: null,
        },
      }),
    )).rejects.toThrow(/no longer the latest attempted run/);
    expect(fs.readFileSync(runFile('rearm-superseded'))).toEqual(before);
  });
});

async function createUncheckpointedAmbiguity(
  runId: string,
  requestedModel: string | null,
  attemptSequence: number,
  baseline?: ReturnType<typeof completedBaseline>,
) {
  const work = [
    { workId: `${runId}:one`, inputFingerprint: `sha256:${'c'.repeat(64)}` },
    { workId: `${runId}:two`, inputFingerprint: `sha256:${'d'.repeat(64)}` },
  ];
  if (baseline !== undefined) {
    const truecourseDir = path.join(repoPath, '.truecourse');
    fs.mkdirSync(truecourseDir, { recursive: true });
    fs.writeFileSync(path.join(truecourseDir, 'LATEST.json'), JSON.stringify(baseline));
  }
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId,
    candidateAnalysisId: `${runId}-analysis`,
    startedAt: '2026-07-22T14:00:00.000Z',
    source: 'cli',
    branch: 'main',
    commitHash: `${runId}-commit`,
    completedBaselineId: baseline?.analysis.id ?? null,
  });
  const activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    runId,
    sealedAt: '2026-07-22T14:00:01.000Z',
    execution: { provider: 'claude-code', requestedModel },
    work,
  });
  await admitInitialExecution(activation, runId, work, '2026-07-22T14:00:02.000Z');
  const observed = await readAnalyzeRun(repoPath, 'latest-attempt');
  if (observed?.rearm == null) throw new Error('expected rearm evidence');
  return {
    command: {
      kind: 'activate-ambiguous-rearm' as const,
      runId,
      candidateAnalysisId: `${runId}-analysis`,
      startedAt: '2026-07-22T14:00:00.000Z',
      source: 'cli' as const,
      branch: 'main',
      commitHash: `${runId}-commit`,
      completedBaselineId: baseline?.analysis.id ?? null,
      activatedAt: '2026-07-22T14:00:03.000Z',
      work,
      reusedWorkIds: [] as const,
      pendingWorkIds: work.map((item) => item.workId),
      consent: {
        evidence: observed.rearm.evidence,
        acceptedRisk: 'repeat-up-to-pending-provider-calls' as const,
        acceptedMaxRepeatProviderCalls: 2,
      },
      observed: {
        runRevision: observed.revision,
        attemptSequence,
        latestAttemptSequence: attemptSequence,
        completedBaselineFingerprint: baseline === undefined ? null : fingerprint(baseline),
      },
    },
  };
}

function completedBaseline(id: string) {
  const createdAt = '2026-07-22T12:00:00.000Z';
  const graph = {
    services: [], serviceDependencies: [], layers: [], modules: [], methods: [],
    moduleDeps: [], methodDeps: [], databases: [], databaseConnections: [], flows: [],
  };
  return {
    head: buildAnalysisFilename(id, createdAt),
    analysis: {
      id,
      createdAt,
      branch: 'main',
      commitHash: `${id}-commit`,
      architecture: 'monolith',
      metadata: null,
      status: 'completed',
    },
    graph,
    violations: [],
  };
}

async function admitInitialExecution(
  activation: AnalyzeRunPlanActivation,
  runId: string,
  work: readonly { readonly workId: string; readonly inputFingerprint: string }[],
  admittedAt: string,
): Promise<void> {
  const stopped = new Error('stop after initial admission');
  const admitted = await admitAnalyzeRunPlanExecution(
    activation,
    repoPath,
    runId,
    work,
    admittedAt,
    () => undefined,
    async () => { throw stopped; },
  );
  if (!admitted.admitted) throw new Error('expected initial admission');
  await expect(admitted.execution).rejects.toBe(stopped);
}

function checkpointRaw(runId: string, checkpointedAt: string): void {
  const file = runFile(runId);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  const result = { violations: [] };
  stored.revision = 3;
  stored.updatedAt = checkpointedAt;
  const index = stored.plan.work.findIndex(
    (item: Record<string, unknown>) => item.workId === 'analyze:v1:reused',
  );
  stored.plan.work[index] = {
    ...stored.plan.work[index],
    state: 'succeeded-checkpointed',
    checkpoint: {
      checkpointedAt,
      attemptId: 'initial:reused',
      resultContractId: 'analyze.code@1',
      resultFingerprint: fingerprint(result),
      result,
      usage: {
        provider: 'claude-code',
        requestedModel: 'sonnet',
        resolvedModel: 'claude-sonnet-4-6',
        callType: 'code',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: '0.01',
        durationMs: 100,
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(stored));
}

function runFile(runId: string): string {
  return path.join(repoPath, '.truecourse', 'analyses', 'runs', `${runId}.json`);
}
