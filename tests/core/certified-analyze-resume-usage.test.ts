import { afterEach, describe, expect, it } from 'vitest';
import { LlmSessionLimitError } from '@truecourse/shared/llm';
import {
  executeCertifiedAnalyzeLlmResumeWithUsage,
} from '../../packages/core/src/services/llm/certified-analyze-resume-usage.js';
import type {
  AnalyzeLlmCheckpointUsageEntry,
  CertifiedAnalyzeLlmResumeExecution,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import {
  closeLogger,
  setLogTransport,
  type LogLevel,
} from '../../packages/core/src/lib/logger.js';

afterEach(async () => {
  await closeLogger();
});

describe('certified analyze resume usage', () => {
  it('uses the durable ledger once and preserves each original checkpoint timestamp', async () => {
    const execution = resumeExecution([
      usageEntry('work-1', 'attempt-1', '2026-07-19T02:00:02.000Z', {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        totalTokens: 125,
        costUsd: '0.012300',
        durationMs: 400,
      }),
      usageEntry('work-2', 'attempt-2', '2026-07-19T04:00:06.000Z', {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        durationMs: 300,
      }),
    ]);
    let flushes = 0;

    const accounted = await executeCertifiedAnalyzeLlmResumeWithUsage(
      () => Promise.resolve(execution),
      {
        flushUsage: () => {
          flushes += 1;
          return [{
            provider: 'transient-overlap',
            callType: 'must-not-double-count',
            inputTokens: 9_999,
            outputTokens: 9_999,
            totalTokens: 19_998,
            durationMs: 9_999,
          }];
        },
      },
    );

    expect(accounted.execution).toBe(execution);
    expect(flushes).toBe(1);
    expect(accounted.usage).toEqual([
      {
        provider: 'claude-code',
        callType: 'code',
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        totalTokens: 125,
        costUsd: '0.012300',
        durationMs: 400,
        createdAt: '2026-07-19T02:00:02.000Z',
      },
      {
        provider: 'claude-code',
        callType: 'code',
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 100,
        costUsd: null,
        durationMs: 300,
        createdAt: '2026-07-19T04:00:06.000Z',
      },
    ]);
  });

  it('rejects duplicate provider attempts instead of double-counting them', async () => {
    const execution = resumeExecution([
      usageEntry('work-1', 'attempt-1', '2026-07-19T02:00:02.000Z'),
      usageEntry('work-2', 'attempt-1', '2026-07-19T02:00:03.000Z'),
    ]);
    let flushes = 0;

    await expect(executeCertifiedAnalyzeLlmResumeWithUsage(
      () => Promise.resolve(execution),
      { flushUsage: () => { flushes += 1; return []; } },
    )).rejects.toThrow('Duplicate certified resume usage attempt: attempt-1');
    expect(flushes).toBe(1);
  });

  it('drains transient usage without replacing a session-limit reset hint', async () => {
    const limit = new LlmSessionLimitError('7pm (Africa/Cairo)');
    const cleanup = new Error('provider buffer unavailable');
    const logged: Array<{ level: LogLevel; message: string; error: unknown }> = [];
    let flushes = 0;
    setLogTransport({
      write: (level, message, error) => logged.push({ level, message, error }),
    });

    await expect(executeCertifiedAnalyzeLlmResumeWithUsage(
      () => Promise.reject(limit),
      {
        flushUsage: () => {
          flushes += 1;
          throw cleanup;
        },
      },
    )).rejects.toBe(limit);
    expect(flushes).toBe(1);
    expect(logged).toEqual([{
      level: 'ERROR',
      message: '[LLM] Failed to discard transient usage after certified resume: provider buffer unavailable',
      error: cleanup,
    }]);
  });
});

function usageEntry(
  workId: string,
  attemptId: string,
  checkpointedAt: string,
  overrides: Partial<AnalyzeLlmCheckpointUsageEntry['usage']> = {},
): AnalyzeLlmCheckpointUsageEntry {
  return {
    workId,
    inputFingerprint: `sha256:${workId === 'work-1' ? '1' : '2'}`.padEnd(71, workId === 'work-1' ? '1' : '2'),
    checkpointedAt,
    attemptId,
    usage: {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      resolvedModel: 'claude-sonnet-4-5-20250929',
      callType: 'code',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: null,
      durationMs: 100,
      ...overrides,
    },
  };
}

function resumeExecution(
  usageLedger: readonly AnalyzeLlmCheckpointUsageEntry[],
): CertifiedAnalyzeLlmResumeExecution {
  return {
    results: [],
    completion: {} as CertifiedAnalyzeLlmResumeExecution['completion'],
    usageLedger,
  };
}
