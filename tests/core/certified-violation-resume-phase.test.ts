import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmSessionLimitError } from '@truecourse/shared/llm';
import {
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import {
  certifyAnalyzeLlmRun,
  type AnalyzeLlmExecutionAdapter,
  type AnalyzeLlmExecutionOutcome,
  type CertifiedAnalyzeLlmWork,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import {
  JournaledAnalyzeSessionLimitError,
  resumeCertifiedViolationPhase,
  type CertifiedViolationResumePhaseInput,
} from '../../packages/core/src/services/llm/certified-violation-phase.js';
import type {
  CodeViolationContext,
  ServiceViolationContext,
} from '../../packages/core/src/services/llm/provider.js';

const runId = 'resume-phase-run';
const candidateAnalysisId = 'resume-phase-analysis';
const resolvedModel = 'claude-sonnet-4-5-20250929';
let repoPath: string;

const rule = {
  key: 'bugs/llm/resume-phase',
  name: 'Resume phase fixture',
  severity: 'medium' as const,
  prompt: 'Find the resume phase issue.',
};

function codeContext(domain: 'bugs' | 'security', source: 'a' | 'b'): CodeViolationContext {
  return {
    files: [{ path: 'context', content: `1: export const ${source} = 1;` }],
    sourceScopes: [{ path: `/repo/src/${source}.ts`, ranges: [{ lineStart: 1, lineEnd: 1 }] }],
    sources: [{
      path: `/repo/src/${source}.ts`,
      selection: {
        kind: 'targeted',
        functions: [{ name: source, startLine: 1, endLine: 1 }],
      },
    }],
    llmRules: [{ ...rule, key: `${domain}/llm/resume-phase` }],
    tier: 'targeted',
  };
}

const code = [
  { domain: 'bugs' as const, context: codeContext('bugs', 'a') },
  { domain: 'security' as const, context: codeContext('security', 'b') },
];

const service: ServiceViolationContext = {
  architecture: 'services',
  services: [{
    id: 'runtime-service-id',
    name: 'orders',
    type: 'backend',
    fileCount: 1,
    layers: ['api'],
  }],
  dependencies: [],
  llmRules: [{ ...rule, key: 'architecture/llm/resume-phase' }],
};

class PartialAdapter implements AnalyzeLlmExecutionAdapter {
  readonly execution = Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' });

  async execute(work: CertifiedAnalyzeLlmWork): Promise<AnalyzeLlmExecutionOutcome> {
    if (work.domain === 'security') throw new LlmSessionLimitError('7pm (Africa/Cairo)');
    return outcome(work, `initial-${work.domain}-attempt`, '2026-07-19T04:00:02.000Z', 120);
  }
}

class ResumeAdapter implements AnalyzeLlmExecutionAdapter {
  readonly execution = Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' });
  readonly calls: CertifiedAnalyzeLlmWork[] = [];
  readonly pins: string[] = [];
  flushes = 0;
  failure: unknown = null;
  flushFailure: unknown = null;

  createPinnedResumeAdapter(model: string): AnalyzeLlmExecutionAdapter {
    this.pins.push(model);
    return {
      execution: this.execution,
      resumeExecution: Object.freeze({
        ...this.execution,
        modelSelection: 'pinned' as const,
        resolvedModel: model,
      }),
      execute: async (work) => {
        this.calls.push(work);
        if (this.failure) throw this.failure;
        return outcome(work, 'resumed-security-attempt', '2026-07-19T04:00:07.000Z', 80);
      },
    };
  }

  async execute(): Promise<AnalyzeLlmExecutionOutcome> {
    throw new Error('Resume must use the pinned adapter');
  }

  flushUsage() {
    this.flushes += 1;
    if (this.flushFailure) throw this.flushFailure;
    return [{
      provider: 'transient-buffer',
      callType: 'overlapping-call',
      inputTokens: 9_999,
      outputTokens: 9_999,
      totalTokens: 19_998,
      durationMs: 9_999,
    }];
  }
}

class BootstrapResumeAdapter implements AnalyzeLlmExecutionAdapter {
  readonly execution = Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' });
  readonly requestedCalls: CertifiedAnalyzeLlmWork[] = [];
  readonly pins: string[] = [];
  flushes = 0;

  async execute(work: CertifiedAnalyzeLlmWork): Promise<AnalyzeLlmExecutionOutcome> {
    this.requestedCalls.push(work);
    return outcome(work, 'bootstrap-attempt', '2026-07-19T04:00:07.000Z', 75);
  }

  createPinnedResumeAdapter(model: string): AnalyzeLlmExecutionAdapter {
    this.pins.push(model);
    return {
      execution: this.execution,
      resumeExecution: Object.freeze({
        ...this.execution,
        modelSelection: 'pinned' as const,
        resolvedModel: model,
      }),
      execute: async (work) => outcome(
        work,
        `pinned-${work.domain}-attempt`,
        '2026-07-19T04:00:08.000Z',
        65,
      ),
    };
  }

  flushUsage() {
    this.flushes += 1;
    return [];
  }
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-resume-phase-'));
  resetAnalyzeRunStorage();
});

afterEach(() => {
  resetAnalyzeRunStorage();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('certified violation resume phase', () => {
  it('restarts a zero-checkpoint attempt on the requested model and establishes its concrete pin', async () => {
    const selectedCode = [code[0]!];
    await createZeroCheckpointBlockedAttempt(selectedCode);
    const adapter = new BootstrapResumeAdapter();

    const resumed = await resumeCertifiedViolationPhase({
      ...resumeInput(adapter, { code: selectedCode }),
      adapter,
    });

    expect(adapter.requestedCalls.map(({ domain }) => domain)).toEqual(['bugs']);
    expect(adapter.pins).toEqual([resolvedModel]);
    expect(adapter.flushes).toBe(1);
    expect(resumed.results.map(({ domain }) => domain)).toEqual(['bugs']);
    expect(resumed.usage.map(({ totalTokens }) => totalTokens)).toEqual([75]);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      state: 'running',
      counts: { total: 1, succeeded: 1, pending: 0 },
      executionAttempt: {
        number: 2,
        resume: {
          admission: 'executing',
          executionPin: {
            modelSelection: 'requested',
            resolvedModel: null,
          },
        },
      },
    });
  });

  it('reuses durable successes, executes only pending work, and accounts the journal once', async () => {
    await createBlockedAttempt();
    const adapter = new ResumeAdapter();

    const resumed = await resumeCertifiedViolationPhase(resumeInput(adapter));

    expect(adapter.pins).toEqual([resolvedModel]);
    expect(adapter.calls.map(({ domain }) => domain)).toEqual(['security']);
    expect(adapter.flushes).toBe(1);
    expect(resumed.results.map(({ domain }) => domain)).toEqual(['bugs', 'security']);
    expect(resumed.usage.map(({ totalTokens }) => totalTokens)).toEqual([120, 80]);
    expect(resumed.usage.reduce((sum, usage) => sum + usage.totalTokens, 0)).toBe(200);
  });

  it('materializes a reused finding at the durable run start time', async () => {
    await createBlockedAttempt({ service });
    const adapter = new ResumeAdapter();

    const resumed = await resumeCertifiedViolationPhase(resumeInput(adapter, { service }));

    expect(adapter.calls.map(({ domain }) => domain)).toEqual(['security']);
    expect(resumed.results).toContainEqual(expect.objectContaining({
      family: 'service',
      result: expect.objectContaining({
        violations: [expect.objectContaining({
          targetServiceId: 'runtime-service-id',
          createdAt: '2026-07-19T04:00:00.000Z',
        })],
      }),
    }));
  });

  it('re-blocks a resumed attempt with the new reset hint and preserved checkpoint', async () => {
    await createBlockedAttempt();
    const adapter = new ResumeAdapter();
    adapter.failure = new LlmSessionLimitError('tomorrow 7pm (Africa/Cairo)');

    await expect(resumeCertifiedViolationPhase(resumeInput(adapter)))
      .rejects.toBeInstanceOf(JournaledAnalyzeSessionLimitError);

    expect(adapter.flushes).toBe(1);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      state: 'blocked',
      executionAttempt: { number: 2 },
      counts: { total: 2, succeeded: 1, pending: 1 },
      blocked: { resetHint: 'tomorrow 7pm (Africa/Cairo)' },
    });
  });

  it('records an ordinary resumed provider failure without losing the prior checkpoint', async () => {
    await createBlockedAttempt();
    const adapter = new ResumeAdapter();
    const sensitiveDiagnostic = '/Users/example/private-repo provider process exited';
    const failure = new Error(sensitiveDiagnostic);
    adapter.failure = failure;

    await expect(resumeCertifiedViolationPhase(resumeInput(adapter))).rejects.toBe(failure);

    expect(adapter.flushes).toBe(1);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      state: 'failed',
      executionAttempt: { number: 2 },
      counts: { total: 2, succeeded: 1, pending: 1 },
      failure: {
        code: 'ANALYZE_LLM_FAILED',
        message: 'The LLM provider failed during analysis. Check local logs for details.',
      },
    });
    expect(fs.readFileSync(path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      `${runId}.json`,
    ), 'utf8')).not.toContain(sensitiveDiagnostic);
  });

  it('records an unformattable provider failure without replacing the thrown value', async () => {
    await createBlockedAttempt();
    const adapter = new ResumeAdapter();
    const failure = {
      toString: () => { throw new Error('hostile provider value'); },
    };
    adapter.failure = failure;

    await expect(resumeCertifiedViolationPhase(resumeInput(adapter))).rejects.toBe(failure);

    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      state: 'failed',
      failure: {
        code: 'ANALYZE_LLM_FAILED',
        message: 'The LLM provider failed during analysis. Check local logs for details.',
      },
    });
  });

  it('fails closed before provider execution when the rebuilt work plan changed', async () => {
    await createBlockedAttempt();
    const adapter = new ResumeAdapter();
    const changedCode = code.map((item, index) => index === 0
      ? {
          ...item,
          context: {
            ...item.context,
            llmRules: item.context.llmRules.map((itemRule) => ({
              ...itemRule,
              prompt: 'A changed prompt must invalidate reuse.',
            })),
          },
        }
      : item);

    await expect(resumeCertifiedViolationPhase(resumeInput(adapter, { code: changedCode })))
      .rejects.toMatchObject({ reason: 'work-plan-changed' });

    expect(adapter.calls).toEqual([]);
    expect(adapter.flushes).toBe(0);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      state: 'blocked',
      executionAttempt: { number: 1 },
      counts: { succeeded: 1, pending: 1 },
    });
  });

  it('keeps a pre-admission validation failure recoverable with zero provider calls', async () => {
    await createBlockedAttempt();
    const adapter = new ResumeAdapter();

    const failure = await resumeCertifiedViolationPhase(resumeInput(adapter, {
      admittedAt: '2026-07-19T04:00:03.000Z',
    })).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({
      message: expect.stringMatching(/admission cannot precede its activation/i),
    });
    expect(adapter.calls).toEqual([]);
    expect(adapter.flushes).toBe(1);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      state: 'running',
      executionAttempt: {
        number: 2,
        resume: { admission: 'activated', admittedAt: null },
      },
      counts: { succeeded: 1, pending: 1 },
    });
  });

  it('recovers fully checkpointed work after cleanup fails without repeating a provider call', async () => {
    await createBlockedAttempt();
    const adapter = new ResumeAdapter();
    const cleanup = new Error('provider buffer unavailable');
    adapter.flushFailure = cleanup;

    await expect(resumeCertifiedViolationPhase(resumeInput(adapter))).rejects.toBe(cleanup);
    expect(adapter.calls.map(({ domain }) => domain)).toEqual(['security']);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      state: 'running',
      executionAttempt: { resume: { admission: 'executing' } },
      counts: { succeeded: 2, pending: 0 },
    });

    adapter.flushFailure = null;
    const recovered = await resumeCertifiedViolationPhase(resumeInput(adapter, {
      activatedAt: '2099-07-19T04:00:05.000Z',
      admittedAt: '2099-07-19T04:00:06.000Z',
    }));

    expect(adapter.calls.map(({ domain }) => domain)).toEqual(['security']);
    expect(adapter.flushes).toBe(2);
    expect(recovered.results).toHaveLength(2);
    expect(recovered.usage.map(({ totalTokens }) => totalTokens)).toEqual([120, 80]);
  });

  it('reports a missing attempted run precisely before pinning a provider', async () => {
    const adapter = new ResumeAdapter();

    await expect(resumeCertifiedViolationPhase(resumeInput(adapter, {
      run: resumeRun('missing-run'),
    }))).rejects.toMatchObject({ reason: 'run-not-found' });
    expect(adapter.pins).toEqual([]);
    expect(adapter.calls).toEqual([]);
  });
});

function resumeRun(selectedRunId = runId): CertifiedViolationResumePhaseInput['run'] {
  return {
    repositoryKey: repoPath,
    repositoryRoot: '/repo',
    runId: selectedRunId,
    candidateAnalysisId,
    startedAt: '2026-07-19T04:00:00.000Z',
    source: 'cli',
    branch: 'main',
    commitHash: 'resume-phase-commit',
    completedBaselineId: null,
  };
}

function resumeInput(
  adapter: CertifiedViolationResumePhaseInput['adapter'],
  overrides: Partial<CertifiedViolationResumePhaseInput> = {},
): CertifiedViolationResumePhaseInput {
  return {
    run: resumeRun(),
    adapter,
    code,
    activatedAt: '2026-07-19T04:00:05.000Z',
    admittedAt: '2026-07-19T04:00:06.000Z',
    ...overrides,
  };
}

async function createBlockedAttempt(
  overrides: Pick<CertifiedViolationResumePhaseInput, 'service'> = {},
): Promise<void> {
  const certified = certifyAnalyzeLlmRun({
    runId,
    journalKey: repoPath,
    repositoryRoot: '/repo',
    code,
    ...overrides,
  }, new PartialAdapter());
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId,
    candidateAnalysisId,
    startedAt: '2026-07-19T04:00:00.000Z',
    source: 'cli',
    branch: 'main',
    commitHash: 'resume-phase-commit',
    completedBaselineId: null,
  });
  const activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    execution: { provider: 'claude-code', requestedModel: 'sonnet' },
    runId,
    sealedAt: '2026-07-19T04:00:01.000Z',
    work: certified.manifest.work,
  });
  await expect(certified.execute(activation)).rejects.toMatchObject({
    code: 'LLM_SESSION_LIMIT',
  });
  await dispatchAnalyzeRun(repoPath, {
    kind: 'block',
    runId,
    blockedAt: '2026-07-19T04:00:04.000Z',
    resetHint: '7pm (Africa/Cairo)',
  });
}

async function createZeroCheckpointBlockedAttempt(
  selectedCode: CertifiedViolationResumePhaseInput['code'],
): Promise<void> {
  const limiter: AnalyzeLlmExecutionAdapter = {
    execution: { provider: 'claude-code', requestedModel: 'sonnet' },
    createPinnedResumeAdapter: () => {
      throw new Error('Initial execution must not create a resume pin');
    },
    execute: async () => {
      throw new LlmSessionLimitError('7pm (Africa/Cairo)');
    },
  };
  const certified = certifyAnalyzeLlmRun({
    runId,
    journalKey: repoPath,
    repositoryRoot: '/repo',
    code: selectedCode,
  }, limiter);
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId,
    candidateAnalysisId,
    startedAt: '2026-07-19T04:00:00.000Z',
    source: 'cli',
    branch: 'main',
    commitHash: 'resume-phase-commit',
    completedBaselineId: null,
  });
  const activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    execution: { provider: 'claude-code', requestedModel: 'sonnet' },
    runId,
    sealedAt: '2026-07-19T04:00:01.000Z',
    work: certified.manifest.work,
  });
  await expect(certified.execute(activation)).rejects.toMatchObject({
    code: 'LLM_SESSION_LIMIT',
  });
  await dispatchAnalyzeRun(repoPath, {
    kind: 'block',
    runId,
    blockedAt: '2026-07-19T04:00:04.000Z',
    resetHint: '7pm (Africa/Cairo)',
  });
}

function outcome(
  work: CertifiedAnalyzeLlmWork,
  attemptId: string,
  completedAt: string,
  totalTokens: number,
): AnalyzeLlmExecutionOutcome {
  return {
    family: work.family,
    domain: work.domain,
    mode: work.mode,
    workId: work.workId,
    inputFingerprint: work.inputFingerprint,
    resultContractId: work.planned.request.resultContractId,
    result: work.family === 'service'
      ? {
          violations: [{
            type: 'service',
            title: 'Resume service issue',
            content: 'The service result must keep the original run timestamp.',
            severity: 'medium',
            targetServiceId: 'svc-0',
            targetModuleId: null,
            targetMethodId: null,
            targetServiceName: null,
            targetModuleName: null,
            targetMethodName: null,
            fixPrompt: null,
            ruleKey: 'architecture/llm/resume-phase',
          }],
          serviceDescriptions: [],
        }
      : { violations: [] },
    attemptId,
    completedAt,
    usage: {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      resolvedModel,
      callType: work.family,
      inputTokens: totalTokens - 20,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens,
      costUsd: null,
      durationMs: 500,
    },
  };
}
