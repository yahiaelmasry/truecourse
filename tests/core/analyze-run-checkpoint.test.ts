import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmSessionLimitError } from '@truecourse/shared/llm';
import {
  AnalyzeRunJournalCorruptError,
  InvalidAnalyzeRunTransitionError,
  admitAnalyzeRunPlanExecution,
  checkpointAnalyzeRunWork,
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  type AnalyzeRunPlanActivation,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import {
  certifyAnalyzeLlmRun,
  type AnalyzeLlmExecutionAdapter,
  type AnalyzeLlmExecutionOutcome,
  type CertifiedAnalyzeLlmWork,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import type { CodeViolationContext } from '../../packages/core/src/services/llm/provider.js';
import {
  JournaledAnalyzeSessionLimitError,
  executeCertifiedViolationPhase,
} from '../../packages/core/src/services/llm/certified-violation-phase.js';

let repoPath: string;
let activation: AnalyzeRunPlanActivation;
let adapter: CheckpointAdapter;
let certified: ReturnType<typeof certifyAnalyzeLlmRun>;

const providerFailure = new Error('stop after preserving sibling checkpoint');
const rule = {
  key: 'bugs/llm/checkpoint',
  name: 'Checkpoint rule',
  severity: 'medium' as const,
  prompt: 'Find the checkpoint issue.',
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
    llmRules: [{ ...rule, key: `${domain}/llm/checkpoint` }],
    tier: 'targeted',
  };
}

class CheckpointAdapter implements AnalyzeLlmExecutionAdapter {
  readonly execution = Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' });
  failDomain: CertifiedAnalyzeLlmWork['domain'] | null = 'security';
  failure: Error = providerFailure;
  completionForDomain = new Map<CertifiedAnalyzeLlmWork['domain'], string>([
    ['bugs', '2026-07-19T04:00:02.000Z'],
    ['security', '2026-07-19T04:00:03.000Z'],
  ]);

  async execute(work: CertifiedAnalyzeLlmWork): Promise<AnalyzeLlmExecutionOutcome> {
    if (work.domain === this.failDomain) throw this.failure;
    return {
      family: work.family,
      domain: work.domain,
      mode: work.mode,
      workId: work.workId,
      inputFingerprint: work.inputFingerprint,
      resultContractId: work.planned.request.resultContractId,
      result: { violations: [] },
      attemptId: `attempt-${work.domain}`,
      completedAt: this.completionForDomain.get(work.domain)!,
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
    };
  }
}

beforeEach(async () => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-analyze-checkpoint-'));
  resetAnalyzeRunStorage();
  adapter = new CheckpointAdapter();
  certified = certifyAnalyzeLlmRun({
    runId: 'checkpoint-run',
    journalKey: repoPath,
    repositoryRoot: '/repo',
    code: [
      { domain: 'bugs', context: codeContext('bugs', 'a') },
      { domain: 'security', context: codeContext('security', 'b') },
    ],
  }, adapter);
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId: 'checkpoint-run',
    candidateAnalysisId: 'checkpoint-analysis',
    startedAt: '2026-07-19T04:00:00.000Z',
    source: 'cli',
    branch: 'main',
    commitHash: 'checkpoint-commit',
    completedBaselineId: 'completed-baseline',
  });
  activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    execution: { provider: 'claude-code', requestedModel: 'sonnet' },
    runId: 'checkpoint-run',
    sealedAt: '2026-07-19T04:00:01.000Z',
    work: certified.manifest.work,
  });
});

afterEach(() => {
  resetAnalyzeRunStorage();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

async function executePartialRun(): Promise<void> {
  await expect(certified.execute(activation)).rejects.toBe(providerFailure);
}

function runFile(): string {
  return path.join(repoPath, '.truecourse', 'analyses', 'runs', 'checkpoint-run.json');
}

describe('analyze run successful-result checkpoints', () => {
  it('durably records a parser-certified result and usage without claiming Resume', async () => {
    await executePartialRun();

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      state: 'running',
      counts: { total: 2, pending: 1, succeeded: 1 },
      resume: { available: false, reason: 'checkpoint-reuse-not-enabled' },
    });
    const stored = JSON.parse(fs.readFileSync(runFile(), 'utf8'));
    expect(stored.plan.work.find((item: { state: string }) => item.state === 'succeeded-checkpointed'))
      .toMatchObject({
        checkpoint: {
          attemptId: 'attempt-bugs',
          resultContractId: 'analyze.code@1',
          result: { violations: [] },
          usage: {
            provider: 'claude-code',
            requestedModel: 'sonnet',
            resolvedModel: 'claude-sonnet-4-5-20250929',
            totalTokens: 120,
          },
        },
      });
  });

  it('does not let a public admission writer forge successful evidence', async () => {
    let rejection: unknown;
    const admission = await admitAnalyzeRunPlanExecution(
      activation,
      repoPath,
      'checkpoint-run',
      certified.manifest.work,
      () => {},
      async (writer) => {
        try {
          await checkpointAnalyzeRunWork(writer as never);
        } catch (error) {
          rejection = error;
        }
        throw providerFailure;
      },
    );
    if (!admission.admitted) throw new Error('expected sealed plan admission');
    await expect(admission.execution).rejects.toBe(providerFailure);

    expect(rejection).toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      revision: 2,
      counts: { pending: 2, succeeded: 0 },
    });
  });

  it('preserves concurrent certified checkpoints for every successful work item', async () => {
    adapter.failDomain = null;
    await certified.execute(activation);

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      counts: { total: 2, pending: 0, succeeded: 2 },
      resume: { available: false, reason: 'checkpoint-reuse-not-enabled' },
    });
  });

  it('keeps successful evidence and honest counts when the remaining work is blocked', async () => {
    await executePartialRun();
    const blocked = await dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId: 'checkpoint-run',
      blockedAt: '2026-07-19T04:00:04.000Z',
      resetHint: '7pm (Africa/Cairo)',
    });

    expect(blocked).toMatchObject({
      state: 'blocked',
      counts: { total: 2, pending: 1, succeeded: 1 },
      blocked: { resetHint: '7pm (Africa/Cairo)' },
      resume: { available: false, reason: 'checkpoint-reuse-not-enabled' },
    });
  });

  it('rejects terminal transitions that predate the latest successful checkpoint', async () => {
    await executePartialRun();

    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId: 'checkpoint-run',
      blockedAt: '2026-07-19T04:00:01.500Z',
      resetHint: '7pm (Africa/Cairo)',
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
    await expect(dispatchAnalyzeRun(repoPath, {
      kind: 'fail',
      runId: 'checkpoint-run',
      failedAt: '2026-07-19T04:00:01.500Z',
      error: { code: 'ANALYZE_FAILED', message: 'Backdated failure.' },
    })).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);
  });

  it('rejects completion evidence before the sealed plan without mutating the journal', async () => {
    adapter.failDomain = null;
    adapter.completionForDomain.set('bugs', '2026-07-19T04:00:00.500Z');
    adapter.completionForDomain.set('security', '2026-07-19T04:00:00.500Z');
    await expect(certified.execute(activation)).rejects.toBeInstanceOf(InvalidAnalyzeRunTransitionError);

    await expect(readAnalyzeRun(repoPath, 'latest-attempt')).resolves.toMatchObject({
      revision: 2,
      counts: { pending: 2, succeeded: 0 },
    });
  });

  it('blocks after future-dated durable progress without masking the session limit', async () => {
    const futureAdapter = new CheckpointAdapter();
    futureAdapter.failure = new LlmSessionLimitError('7pm (Africa/Cairo)');
    futureAdapter.completionForDomain.set('bugs', '2099-07-19T04:00:02.000Z');

    await expect(executeCertifiedViolationPhase({
      run: {
        repositoryKey: repoPath,
        repositoryRoot: '/repo',
        runId: 'future-checkpoint-run',
        candidateAnalysisId: 'future-checkpoint-analysis',
        startedAt: '2026-07-19T04:10:00.000Z',
        source: 'cli',
        branch: 'main',
        commitHash: 'future-checkpoint-commit',
        completedBaselineId: 'completed-baseline',
      },
      analysisTimestamp: '2026-07-19T04:10:00.000Z',
      adapter: futureAdapter,
      code: [
        { domain: 'bugs', context: codeContext('bugs', 'a') },
        { domain: 'security', context: codeContext('security', 'b') },
      ],
    })).rejects.toBeInstanceOf(JournaledAnalyzeSessionLimitError);

    await expect(readAnalyzeRun(repoPath, { runId: 'future-checkpoint-run' })).resolves.toMatchObject({
      state: 'blocked',
      updatedAt: '2099-07-19T04:00:02.000Z',
      counts: { pending: 1, succeeded: 1 },
      blocked: { resetHint: '7pm (Africa/Cairo)' },
    });
  });

  it('rejects checkpoint state masquerading as an older journal schema', async () => {
    await executePartialRun();
    const stored = JSON.parse(fs.readFileSync(runFile(), 'utf8')) as { schemaVersion: number };
    stored.schemaVersion = 2;
    fs.writeFileSync(runFile(), JSON.stringify(stored), 'utf8');
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(repoPath, { runId: 'checkpoint-run' }))
      .rejects.toBeInstanceOf(AnalyzeRunJournalCorruptError);
  });
});
