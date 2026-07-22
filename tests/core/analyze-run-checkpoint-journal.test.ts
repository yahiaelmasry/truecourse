import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AnalyzeRunJournalCorruptError,
  InvalidAnalyzeRunTransitionError,
  admitAnalyzeRunPlanExecution,
  checkpointAnalyzeRunWork,
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  type AnalyzeRunCheckpointWriter,
  type AnalyzeRunPlanActivation,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import { certifyAnalyzeRunWorkCheckpoint } from '../../packages/core/src/lib/analyze-run-work-checkpoint-certification.js';
import { readAnalyzeRunResumeCandidate } from '../../packages/core/src/lib/analyze-run-resume-candidate.js';

const fingerprints = [
  `sha256:${'1'.repeat(64)}`,
  `sha256:${'2'.repeat(64)}`,
] as const;
const work = fingerprints.map((inputFingerprint, index) => ({
  workId: `work-${index + 1}`,
  inputFingerprint,
}));
const stopAfterCheckpoint = new Error('stop after checkpoint');

let repoPath: string;
let activation: AnalyzeRunPlanActivation;

beforeEach(async () => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-checkpoint-journal-'));
  resetAnalyzeRunStorage();
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId: 'checkpoint-run',
    candidateAnalysisId: 'candidate-analysis',
    startedAt: '2026-07-19T04:00:00.000Z',
    source: 'cli',
    branch: 'main',
    commitHash: 'checkpoint-commit',
    completedBaselineId: 'completed-baseline',
  });
  activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    runId: 'checkpoint-run',
    sealedAt: '2026-07-19T04:00:01.000Z',
    work,
  });
});

afterEach(() => {
  resetAnalyzeRunStorage();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function checkpoint(
  writer: AnalyzeRunCheckpointWriter,
  index: number,
  checkpointedAt = `2026-07-19T04:00:0${index + 2}.000Z`,
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
      resolvedModel: 'claude-sonnet-4-5-20250929',
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

async function admit<T>(
  execute: (writer: AnalyzeRunCheckpointWriter) => Promise<T>,
) {
  const admission = await admitAnalyzeRunPlanExecution(
    activation,
    repoPath,
    'checkpoint-run',
    work,
    () => {},
    execute,
  );
  if (!admission.admitted) throw new Error('expected sealed plan admission');
  return { execution: admission.execution };
}

function runFile(): string {
  return path.join(
    repoPath,
    '.truecourse',
    'analyses',
    'runs',
    'checkpoint-run.json',
  );
}

describe('durable analyze-run work checkpoints', () => {
  it('persists a detached result and exact usage without claiming Resume', async () => {
    const { execution } = await admit(async (writer) => {
      await checkpoint(writer, 0);
      throw stopAfterCheckpoint;
    });
    await expect(execution).rejects.toBe(stopAfterCheckpoint);

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      schemaVersion: 6,
      revision: 3,
      state: 'running',
      counts: { total: 2, pending: 1, succeeded: 1 },
      resume: { available: false, reason: 'checkpoint-reuse-not-enabled' },
    });
    const stored = JSON.parse(fs.readFileSync(runFile(), 'utf8'));
    expect(stored.plan.work[0]).toMatchObject({
      state: 'succeeded-checkpointed',
      checkpoint: {
        attemptId: 'attempt-1',
        resultContractId: 'analyze.code@1',
        result: { violations: [{ title: 'finding-1' }] },
        usage: { provider: 'claude-code', totalTokens: 120 },
      },
    });
  });

  it('reads a detached latest candidate without repairing the latest pointer', async () => {
    const { execution } = await admit(async (writer) => {
      await checkpoint(writer, 0);
      throw stopAfterCheckpoint;
    });
    await expect(execution).rejects.toBe(stopAfterCheckpoint);
    const pointer = path.join(path.dirname(runFile()), 'LATEST_ATTEMPT.json');
    fs.rmSync(pointer);

    const candidate = await readAnalyzeRunResumeCandidate(repoPath, 'checkpoint-run');
    expect(candidate).toMatchObject({
      isLatestAttempt: true,
      revision: 3,
      state: 'running',
      plan: {
        work: [
          {
            state: 'succeeded-checkpointed',
            checkpoint: { result: { violations: [{ title: 'finding-1' }] } },
          },
          { state: 'pending' },
        ],
      },
    });
    expect(fs.existsSync(pointer)).toBe(false);

    const storedResult = candidate?.plan === 'unsealed'
      ? null
      : candidate?.plan.work[0]?.state === 'succeeded-checkpointed'
        ? candidate.plan.work[0].checkpoint.result as { violations: { title: string }[] }
        : null;
    storedResult!.violations[0]!.title = 'mutated outside the journal';
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRunResumeCandidate(repoPath, 'checkpoint-run')).resolves.toMatchObject({
      plan: {
        work: [
          { checkpoint: { result: { violations: [{ title: 'finding-1' }] } } },
          { state: 'pending' },
        ],
      },
    });
  });

  it('rejects forged checkpoint proof and leaves the admitted plan pending', async () => {
    let rejection: unknown;
    const { execution } = await admit(async () => {
      try {
        await checkpointAnalyzeRunWork({} as never);
      } catch (error) {
        rejection = error;
      }
      throw stopAfterCheckpoint;
    });
    await expect(execution).rejects.toBe(stopAfterCheckpoint);

    expect(rejection).toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      revision: 2,
      counts: { pending: 2, succeeded: 0 },
    });
  });

  it('preserves concurrent checkpoints through compare-and-swap retries', async () => {
    const { execution } = await admit(async (writer) => {
      await Promise.all([checkpoint(writer, 0), checkpoint(writer, 1)]);
      return 'done';
    });
    await execution;

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      revision: 4,
      counts: { total: 2, pending: 0, succeeded: 2 },
    });
  });

  it('keeps partial counts when blocked and rejects a backdated terminal transition', async () => {
    const { execution } = await admit(async (writer) => {
      await checkpoint(writer, 0);
      throw stopAfterCheckpoint;
    });
    await expect(execution).rejects.toBe(stopAfterCheckpoint);

    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId: 'checkpoint-run',
      blockedAt: '2026-07-19T04:00:01.500Z',
      resetHint: '7pm (Africa/Cairo)',
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId: 'checkpoint-run',
      blockedAt: '2026-07-19T04:00:04.000Z',
      resetHint: '7pm (Africa/Cairo)',
    })).resolves.toMatchObject({
      state: 'blocked',
      counts: { total: 2, pending: 1, succeeded: 1 },
      blocked: { resetHint: '7pm (Africa/Cairo)' },
    });
  });

  it('rejects certified completion until every planned result is checkpointed', async () => {
    const { execution } = await admit(async () => 'legacy-result');
    await expect(execution).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      state: 'running',
      revision: 2,
      counts: { pending: 2, succeeded: 0 },
    });
  });

  it('rejects checkpoint state masquerading as the previous journal schema', async () => {
    const { execution } = await admit(async (writer) => {
      await checkpoint(writer, 0);
      throw stopAfterCheckpoint;
    });
    await expect(execution).rejects.toBe(stopAfterCheckpoint);
    const stored = JSON.parse(fs.readFileSync(runFile(), 'utf8')) as { schemaVersion: number };
    stored.schemaVersion = 2;
    fs.writeFileSync(runFile(), JSON.stringify(stored), 'utf8');
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, { runId: 'checkpoint-run' }))
      .rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
  });

  it('rejects checkpoint usage whose persisted token total was altered', async () => {
    const { execution } = await admit(async (writer) => {
      await checkpoint(writer, 0);
      throw stopAfterCheckpoint;
    });
    await expect(execution).rejects.toBe(stopAfterCheckpoint);
    const stored = JSON.parse(fs.readFileSync(runFile(), 'utf8')) as {
      plan: { work: { checkpoint?: { usage?: { totalTokens: number } } }[] };
    };
    stored.plan.work[0].checkpoint!.usage!.totalTokens = 999;
    fs.writeFileSync(runFile(), JSON.stringify(stored), 'utf8');
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, { runId: 'checkpoint-run' }))
      .rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
  });
});
