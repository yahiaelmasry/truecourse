import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmSessionLimitError } from '@truecourse/shared/llm';
import {
  readAnalyzeRun,
  resetAnalyzeRunStorage,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import {
  closeLogger,
  setLogTransport,
} from '../../packages/core/src/lib/logger.js';
import {
  executeCertifiedViolationPhase,
  JournaledAnalyzeSessionLimitError,
} from '../../packages/core/src/services/llm/certified-violation-phase.js';
import type {
  AnalyzeLlmExecutionAdapter,
  AnalyzeLlmExecutionOutcome,
  CertifiedAnalyzeLlmWork,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import type { ServiceViolationContext } from '../../packages/core/src/services/llm/provider.js';

const repositories: string[] = [];

afterEach(async () => {
  await closeLogger();
  resetAnalyzeRunStorage();
  for (const repository of repositories.splice(0)) {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function repository(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-certified-phase-'));
  repositories.push(value);
  return value;
}

function serviceContext(): ServiceViolationContext {
  return {
    architecture: 'modular monolith',
    services: [{
      id: 'service-orders',
      name: 'orders',
      type: 'backend',
      framework: 'express',
      fileCount: 1,
      layers: ['application'],
    }],
    dependencies: [],
    llmRules: [{
      key: 'architecture/llm/service-test',
      name: 'Service test',
      severity: 'high',
      prompt: 'Find service issues.',
    }],
  };
}

function run(repositoryKey: string, runId: string) {
  return {
    repositoryKey,
    repositoryRoot: repositoryKey,
    runId,
    candidateAnalysisId: `candidate-${runId}`,
    startedAt: '2026-07-19T00:00:00.000Z',
    source: 'cli' as const,
    branch: 'main',
    commitHash: 'abc123',
    completedBaselineId: 'completed-baseline',
  };
}

class Adapter implements AnalyzeLlmExecutionAdapter {
  readonly execution = Object.freeze({
    provider: 'claude-code',
    requestedModel: 'sonnet',
  });

  constructor(private readonly failure?: Error) {}

  async execute(work: CertifiedAnalyzeLlmWork): Promise<AnalyzeLlmExecutionOutcome> {
    if (this.failure) throw this.failure;
    return {
      family: work.family,
      domain: work.domain,
      mode: work.mode,
      workId: work.workId,
      inputFingerprint: work.inputFingerprint,
      resultContractId: work.planned.request.resultContractId,
      result: {
        violations: [{
          type: 'service',
          title: 'Service finding',
          content: 'Keep the service boundary explicit.',
          severity: 'high',
          targetServiceId: 'service-orders',
          fixPrompt: null,
          ruleKey: 'architecture/llm/service-test',
        }],
        serviceDescriptions: [{ id: 'service-orders', description: 'Orders' }],
      },
      attemptId: `test:${work.workId}`,
      completedAt: new Date().toISOString(),
      usage: null,
    };
  }
}

describe('certified violation phase', () => {
  it('begins, seals, executes, and materializes one certified phase', async () => {
    const repositoryKey = repository();
    const result = await executeCertifiedViolationPhase({
      run: run(repositoryKey, 'successful-phase'),
      analysisTimestamp: '2026-07-19T00:00:02.000Z',
      adapter: new Adapter(),
      code: [],
      service: serviceContext(),
    });

    expect(result.results).toEqual([
      expect.objectContaining({ family: 'service', mode: 'normal' }),
    ]);
    expect(result.completion).toEqual(expect.any(Object));
    await expect(readAnalyzeRun(repositoryKey, { runId: 'successful-phase' }))
      .resolves.toMatchObject({
        state: 'running',
        counts: { pending: 0, succeeded: 1 },
        resume: { available: false, reason: 'checkpoint-reuse-not-enabled' },
      });
  });

  it('blocks the journal and preserves reset information on a provider session limit', async () => {
    const repositoryKey = repository();
    const outcome = await executeCertifiedViolationPhase({
      run: run(repositoryKey, 'limited-phase'),
      analysisTimestamp: '2026-07-19T00:00:02.000Z',
      adapter: new Adapter(new LlmSessionLimitError('7pm (Africa/Cairo)')),
      code: [],
      service: serviceContext(),
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(JournaledAnalyzeSessionLimitError);
    expect(outcome).toMatchObject({
      runId: 'limited-phase',
      resetHint: '7pm (Africa/Cairo)',
    });
    await expect(readAnalyzeRun(repositoryKey, { runId: 'limited-phase' }))
      .resolves.toMatchObject({
        state: 'blocked',
        blocked: {
          reason: 'provider-session-limit',
          resetHint: '7pm (Africa/Cairo)',
        },
      });
  });

  it('marks the journal failed when certified provider execution fails', async () => {
    const repositoryKey = repository();
    const sensitiveDiagnostic = '/Users/example/private-repo provider failed';
    const failure = new Error(sensitiveDiagnostic);
    await expect(executeCertifiedViolationPhase({
      run: run(repositoryKey, 'failed-phase'),
      analysisTimestamp: '2026-07-19T00:00:02.000Z',
      adapter: new Adapter(failure),
      code: [],
      service: serviceContext(),
    })).rejects.toBe(failure);

    await expect(readAnalyzeRun(repositoryKey, { runId: 'failed-phase' }))
      .resolves.toMatchObject({
        state: 'failed',
        failure: {
          code: 'ANALYZE_LLM_FAILED',
          message: 'The LLM provider failed during analysis. Check local logs for details.',
        },
      });
    expect(fs.readFileSync(path.join(
      repositoryKey,
      '.truecourse',
      'analyses',
      'runs',
      'failed-phase.json',
    ), 'utf8')).not.toContain(sensitiveDiagnostic);
  });

  it('journals and rethrows the provider failure when diagnostic logging throws', async () => {
    const repositoryKey = repository();
    const failure = new Error('original provider failure');
    setLogTransport({
      write() { throw new Error('diagnostic transport failed'); },
    });

    await expect(executeCertifiedViolationPhase({
      run: run(repositoryKey, 'throwing-log-transport'),
      analysisTimestamp: '2026-07-19T00:00:02.000Z',
      adapter: new Adapter(failure),
      code: [],
      service: serviceContext(),
    })).rejects.toBe(failure);
    await expect(readAnalyzeRun(repositoryKey, { runId: 'throwing-log-transport' }))
      .resolves.toMatchObject({
        state: 'failed',
        failure: {
          code: 'ANALYZE_LLM_FAILED',
          message: 'The LLM provider failed during analysis. Check local logs for details.',
        },
      });
  });
});
