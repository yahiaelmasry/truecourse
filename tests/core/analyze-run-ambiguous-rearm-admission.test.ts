import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateAnalyzeRunAmbiguousRearm,
  admitAnalyzeRunPlanExecution,
  admitAnalyzeRunResumeExecution,
  checkpointAnalyzeRunWork,
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  type AnalyzeRunCheckpointWriter,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import { certifyAnalyzeRunAmbiguousRearmActivation } from '../../packages/core/src/lib/analyze-run-ambiguous-rearm-activation-certification.js';
import { certifyAnalyzeRunWorkCheckpoint } from '../../packages/core/src/lib/analyze-run-work-checkpoint-certification.js';

const runId = 'ambiguous-rearm-admission';
const work = [
  { workId: 'analyze:v1:reused', inputFingerprint: `sha256:${'a'.repeat(64)}` },
  { workId: 'analyze:v1:pending', inputFingerprint: `sha256:${'b'.repeat(64)}` },
] as const;
const executionPin = {
  provider: 'claude-code',
  requestedModel: 'sonnet',
  modelSelection: 'resolved' as const,
  resolvedModel: 'claude-sonnet-4-6',
};

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-ambiguous-rearm-admission-'));
  resetAnalyzeRunStorage();
});

afterEach(() => {
  resetAnalyzeRunStorage();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('ambiguous analyze execution admission', () => {
  it('durably admits attempt N+1 before executing and checkpoints only pending work', async () => {
    const activation = await createAmbiguousActivation();
    let callbacks = 0;

    const admission = await admitAnalyzeRunResumeExecution(
      activation,
      repoPath,
      runId,
      work,
      [work[1].workId],
      executionPin,
      '2026-07-22T13:00:05.000Z',
      () => undefined,
      async (writer) => {
        callbacks += 1;
        await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
          revision: 5,
          state: 'running',
          counts: { total: 2, succeeded: 1, pending: 1 },
          executionAttempt: {
            number: 2,
            resume: {
              activation: 'ambiguous-rearm',
              admission: 'executing',
              admittedAt: '2026-07-22T13:00:05.000Z',
            },
          },
        });
        await checkpoint(writer, 1, '2026-07-22T13:00:06.000Z');
        return ['pending-result'];
      },
    );

    expect(admission.admitted).toBe(true);
    if (!admission.admitted) throw new Error('expected ambiguous rearm admission');
    await expect(admission.execution).resolves.toMatchObject({
      result: ['pending-result'],
      checkpoints: expect.arrayContaining([
        expect.objectContaining({ workId: work[0].workId, attemptId: 'attempt-1' }),
        expect.objectContaining({ workId: work[1].workId, attemptId: 'attempt-2' }),
      ]),
    });
    expect(callbacks).toBe(1);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      revision: 6,
      counts: { total: 2, succeeded: 2, pending: 0 },
      executionAttempt: {
        number: 2,
        resume: { activation: 'ambiguous-rearm', admission: 'executing' },
      },
    });
    expect(fs.existsSync(path.join(repoPath, '.truecourse', 'LATEST.json'))).toBe(false);
  });

  it('does not consume the receipt when the requested pending partition is not exact', async () => {
    const activation = await createAmbiguousActivation();
    let callbacks = 0;

    await expect(admitAnalyzeRunResumeExecution(
      activation,
      repoPath,
      runId,
      work,
      work.map((item) => item.workId),
      executionPin,
      '2026-07-22T13:00:05.000Z',
      () => undefined,
      async () => { callbacks += 1; },
    )).resolves.toEqual({ admitted: false });

    const stopped = new Error('stop after exact admission');
    const exact = await admitAnalyzeRunResumeExecution(
      activation,
      repoPath,
      runId,
      work,
      [work[1].workId],
      executionPin,
      '2026-07-22T13:00:05.000Z',
      () => undefined,
      async () => {
        callbacks += 1;
        throw stopped;
      },
    );
    expect(exact.admitted).toBe(true);
    if (!exact.admitted) throw new Error('expected exact admission');
    await expect(exact.execution).rejects.toBe(stopped);
    expect(callbacks).toBe(1);
  });

  it('admits an ambiguous rearm receipt only once under concurrent callers', async () => {
    const activation = await createAmbiguousActivation();
    const stopped = new Error('stop the winning execution');
    let callbacks = 0;
    const admit = () => admitAnalyzeRunResumeExecution(
      activation,
      repoPath,
      runId,
      work,
      [work[1].workId],
      executionPin,
      '2026-07-22T13:00:05.000Z',
      () => undefined,
      async () => {
        callbacks += 1;
        throw stopped;
      },
    );

    const admissions = await Promise.all([admit(), admit()]);
    expect(admissions.filter((entry) => entry.admitted)).toHaveLength(1);
    expect(callbacks).toBe(1);
    const winner = admissions.find((entry) => entry.admitted);
    if (!winner?.admitted) throw new Error('expected one winning admission');
    await expect(winner.execution).rejects.toBe(stopped);
  });

  it('does not cross-admit the receipt when the durable activation kind changes', async () => {
    const activation = await createAmbiguousActivation();
    const file = path.join(repoPath, '.truecourse', 'analyses', 'runs', `${runId}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
    stored.executionAttempt.resume.activation = 'provider-session-limit';
    stored.executionAttempt.resume.resumedFrom = {
      reason: 'provider-session-limit',
      resetHint: '7pm',
      blockedAt: '2026-07-22T13:00:03.500Z',
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    let callbacks = 0;

    await expect(admitAnalyzeRunResumeExecution(
      activation,
      repoPath,
      runId,
      work,
      [work[1].workId],
      executionPin,
      '2026-07-22T13:00:05.000Z',
      () => undefined,
      async () => { callbacks += 1; },
    )).resolves.toEqual({ admitted: false });
    expect(callbacks).toBe(0);
  });
});

async function createAmbiguousActivation() {
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId,
    candidateAnalysisId: 'ambiguous-rearm-analysis',
    startedAt: '2026-07-22T13:00:00.000Z',
    source: 'cli',
    branch: 'main',
    commitHash: 'ambiguous-rearm-commit',
    completedBaselineId: null,
  });
  const plan = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    runId,
    sealedAt: '2026-07-22T13:00:01.000Z',
    execution: { provider: 'claude-code', requestedModel: 'sonnet' },
    work,
  });
  const stopped = new Error('leave initial provider execution ambiguous');
  const initial = await admitAnalyzeRunPlanExecution(
    plan,
    repoPath,
    runId,
    work,
    '2026-07-22T13:00:02.000Z',
    () => undefined,
    async (writer) => {
      await checkpoint(writer, 0, '2026-07-22T13:00:03.000Z');
      throw stopped;
    },
  );
  if (!initial.admitted) throw new Error('expected initial admission');
  await expect(initial.execution).rejects.toBe(stopped);

  const observed = await readAnalyzeRun(repoPath, 'latest-attempt');
  if (observed?.rearm == null) throw new Error('expected ambiguous rearm offer');
  const activated = await activateAnalyzeRunAmbiguousRearm(
    repoPath,
    certifyAnalyzeRunAmbiguousRearmActivation({
      kind: 'activate-ambiguous-rearm',
      runId,
      candidateAnalysisId: 'ambiguous-rearm-analysis',
      startedAt: '2026-07-22T13:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'ambiguous-rearm-commit',
      completedBaselineId: null,
      activatedAt: '2026-07-22T13:00:04.000Z',
      work,
      reusedWorkIds: [work[0].workId],
      pendingWorkIds: [work[1].workId],
      executionPin,
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
    }),
  );
  return activated.activation;
}

function checkpoint(
  writer: AnalyzeRunCheckpointWriter,
  index: 0 | 1,
  checkpointedAt: string,
) {
  return checkpointAnalyzeRunWork(certifyAnalyzeRunWorkCheckpoint(writer, {
    ...work[index],
    checkpointedAt,
    attemptId: `attempt-${index + 1}`,
    resultContractId: 'analyze.code@1',
    result: { violations: [{ title: `finding-${index + 1}` }] },
    usage: {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      resolvedModel: executionPin.resolvedModel,
      callType: 'code',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      totalTokens: 120,
      costUsd: '0.0123',
      durationMs: 500,
    },
  }));
}
