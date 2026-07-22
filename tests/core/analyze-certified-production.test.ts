import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARCHITECTURE_LLM_RULES } from '../../packages/analyzer/src/index.js';
import { analyzeCore } from '../../packages/core/src/commands/analyze-core.js';
import {
  AnalysisStartBlockedError,
  AnalysisResumeUnavailableError,
  analyzeInProcess,
  resumeAnalyzeInProcess,
} from '../../packages/core/src/commands/analyze-in-process.js';
import {
  registerProject,
  resetRegistryStore,
  getProjectBySlug,
  unregisterProject,
  type RegistryEntry,
} from '../../packages/core/src/config/registry.js';
import {
  clearLatestCache,
  getAnalysisStore,
  listAnalyses,
  readAnalysis,
  readHistory,
  readLatest,
  resetAnalysisStore,
  setAnalysisStore,
} from '../../packages/core/src/lib/analysis-store.js';
import {
  beginFinalizeAnalyzeRun,
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import { ClaudeCodeProvider } from '../../packages/core/src/services/llm/cli-provider.js';
import type {
  AnalyzeLlmExecutionOptions,
  AnalyzeLlmExecutionOutcome,
  CertifiedAnalyzeLlmWork,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import { LlmSessionLimitError } from '../../packages/shared/src/llm/transport.js';
import { writeProjectConfig } from '../../packages/core/src/config/project-config.js';

const originalHome = process.env.TRUECOURSE_HOME;

class EmptyDirectClaudeProvider extends ClaudeCodeProvider {
  protected async spawnCLI(): Promise<string> {
    return JSON.stringify({
      structured_output: { violations: [], serviceDescriptions: [] },
    });
  }
}

class FutureCompletedDirectClaudeProvider extends EmptyDirectClaudeProvider {
  override async execute(
    work: CertifiedAnalyzeLlmWork,
    options?: AnalyzeLlmExecutionOptions,
  ): Promise<AnalyzeLlmExecutionOutcome> {
    return {
      ...await super.execute(work, options),
      completedAt: '2099-07-19T04:00:02.000Z',
    };
  }
}

class LimitedDirectClaudeProvider extends ClaudeCodeProvider {
  protected async spawnCLI(): Promise<string> {
    throw new LlmSessionLimitError('7pm (Africa/Cairo)');
  }
}

class PartiallyLimitedDirectClaudeProvider extends ClaudeCodeProvider {
  constructor() {
    super(undefined, 'sonnet');
  }

  protected async spawnCLI(
    _prompt: string,
    _schema: string,
    options?: { stage?: string },
  ): Promise<string> {
    if (options?.stage === 'analyze.module') {
      throw new LlmSessionLimitError('7pm (Africa/Cairo)');
    }
    return JSON.stringify({
      structured_output: { violations: [], serviceDescriptions: [] },
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: { 'claude-sonnet-4-5-20250929': { inputTokens: 100 } },
      total_cost_usd: 0.0123,
    });
  }
}

class ResumingDirectClaudeProvider extends ClaudeCodeProvider {
  readonly stages: string[] = [];
  readonly modelOverrides: (string | undefined)[] = [];

  constructor() {
    super(undefined, 'sonnet');
  }

  protected async spawnCLI(
    _prompt: string,
    _schema: string,
    options?: { stage?: string; modelOverride?: string },
  ): Promise<string> {
    this.stages.push(options?.stage ?? 'unknown');
    this.modelOverrides.push(options?.modelOverride);
    const resolvedModel = options?.modelOverride ?? 'claude-sonnet-4-5-20250929';
    return JSON.stringify({
      structured_output: { violations: [] },
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: { [resolvedModel]: { inputTokens: 100 } },
      total_cost_usd: 0.0123,
    });
  }
}

class NeverCallDirectClaudeProvider extends ClaudeCodeProvider {
  calls = 0;

  constructor() {
    super(undefined, 'sonnet');
  }

  protected async spawnCLI(): Promise<string> {
    this.calls += 1;
    throw new Error('Provider must not be called');
  }
}

class ResumeLimitedDirectClaudeProvider extends ClaudeCodeProvider {
  readonly stages: string[] = [];

  constructor() {
    super(undefined, 'sonnet');
  }

  protected async spawnCLI(
    _prompt: string,
    _schema: string,
    options?: { stage?: string },
  ): Promise<string> {
    this.stages.push(options?.stage ?? 'unknown');
    throw new LlmSessionLimitError('tomorrow 8pm (Africa/Cairo)');
  }
}

class CleanupFailingResumingProvider extends ResumingDirectClaudeProvider {
  override flushUsage(): never {
    throw new Error('injected provider cleanup failure');
  }
}

class ModuleFindingDirectClaudeProvider extends ClaudeCodeProvider {
  protected async spawnCLI(
    _prompt: string,
    _schema: string,
    options?: { stage?: string },
  ): Promise<string> {
    const violations = options?.stage === 'analyze.module'
      ? [{
          type: 'module',
          title: 'Module-only prior finding',
          content: 'This finding exercises a module lifecycle with a normal service result.',
          severity: 'high',
          targetModuleId: null,
          targetMethodId: null,
          fixPrompt: null,
          ruleKey: 'architecture/llm/module-boundaries',
        }]
      : [];
    return JSON.stringify({
      structured_output: { violations, serviceDescriptions: [] },
    });
  }
}

class MixedModeDirectClaudeProvider extends ClaudeCodeProvider {
  protected async spawnCLI(
    _prompt: string,
    _schema: string,
    options?: { stage?: string },
  ): Promise<string> {
    const structuredOutput = options?.stage === 'analyze.module-lifecycle'
      ? {
          resolvedViolationIds: [],
          unchangedViolationIds: [],
          newViolations: [{
            type: 'module',
            title: 'Unknown lifecycle module target',
            content: 'The lifecycle result points outside the current graph.',
            severity: 'high',
            targetServiceId: null,
            targetModuleId: 'mod-999',
            targetMethodId: null,
            targetServiceName: null,
            targetModuleName: null,
            targetMethodName: null,
            fixPrompt: null,
            ruleKey: 'architecture/llm/module-boundaries',
          }],
        }
      : { violations: [], serviceDescriptions: [] };
    return JSON.stringify({ structured_output: structuredOutput });
  }
}

class InvalidTargetDirectClaudeProvider extends ClaudeCodeProvider {
  protected async spawnCLI(
    _prompt: string,
    _schema: string,
    options?: { stage?: string },
  ): Promise<string> {
    const violations = options?.stage === 'analyze.service'
      ? [{
          type: 'service',
          title: 'Unknown service target',
          content: 'The provider returned an ID outside the analyzed graph.',
          severity: 'high',
          targetServiceId: 'svc-999',
          fixPrompt: null,
          ruleKey: 'architecture/llm/service-boundaries',
        }]
      : [];
    return JSON.stringify({
      structured_output: { violations, serviceDescriptions: [] },
    });
  }
}

class RecordingFamilyDirectClaudeProvider extends ClaudeCodeProvider {
  readonly stages: string[] = [];

  protected async spawnCLI(
    _prompt: string,
    _schema: string,
    options?: { stage?: string },
  ): Promise<string> {
    if (options?.stage) this.stages.push(options.stage);
    return JSON.stringify({
      structured_output: options?.stage === 'analyze.service'
        ? { violations: [], serviceDescriptions: [] }
        : { violations: [] },
    });
  }
}

describe('certified full analyze production path', () => {
  let workDir: string;
  let truecourseHome: string;
  let project: RegistryEntry;

  beforeEach(async () => {
    truecourseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-certified-production-home-'));
    process.env.TRUECOURSE_HOME = truecourseHome;
    resetRegistryStore();
    resetAnalyzeRunStorage();
    resetAnalysisStore();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-certified-production-repo-'));
    fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({
      name: 'certified-production-fixture',
      type: 'module',
    }));
    fs.mkdirSync(path.join(workDir, 'src'));
    fs.writeFileSync(
      path.join(workDir, 'src', 'orders.ts'),
      'export class OrdersService { list(): string[] { return []; } }\n',
    );
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    execSync('git init -q -b main', { cwd: workDir, env });
    execSync('git add -A', { cwd: workDir, env });
    execSync('git -c commit.gpgsign=false commit -q -m init', { cwd: workDir, env });
    project = await registerProject(workDir);
    await writeProjectConfig(workDir, { enabledCategories: ['architecture'] });
    clearLatestCache();
  });

  afterEach(async () => {
    if (project) await unregisterProject(project.slug);
    resetAnalyzeRunStorage();
    resetAnalysisStore();
    resetRegistryStore();
    clearLatestCache();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(truecourseHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.TRUECOURSE_HOME;
    else process.env.TRUECOURSE_HOME = originalHome;
  });

  it('completes a direct-CLI architecture-only attempt after promoting its completed analysis', async () => {
    const result = await analyzeInProcess(project, {
      source: 'cli',
      provider: new EmptyDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    });

    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      candidateAnalysisId: result.analysisId,
      state: 'completed',
      counts: { pending: 0, succeeded: expect.any(Number) },
      resume: { available: false, reason: 'run-completed' },
    });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: result.analysisId, status: 'completed' },
    });
    await expect(readHistory(workDir)).resolves.toMatchObject({
      analyses: [expect.objectContaining({ id: result.analysisId })],
    });
    await expect(getProjectBySlug(project.slug)).resolves.toMatchObject({
      lastAnalyzed: expect.any(String),
    });
  }, 30_000);

  it('rechecks and permits exact CLI replacement of a structurally resumable attempt', async () => {
    await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new LimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const interrupted = await readAnalyzeRun(workDir, 'latest-attempt');

    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'none-incomplete' },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).rejects.toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'expectation-changed',
      runId: interrupted?.runId,
    });
    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'abandon', runId: interrupted!.runId },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).resolves.toMatchObject({ analysisId: expect.any(String) });
    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      runId: interrupted?.runId,
      state: 'blocked',
    });
  }, 30_000);

  it('does not guard adapters that have not yet exposed an attempted-run recovery action', async () => {
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new LimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });

    await expect(analyzeInProcess(project, {
      source: 'dashboard',
      enableLlmRulesOverride: false,
      skipStash: true,
    })).resolves.toMatchObject({ analysisId: expect.any(String) });
  }, 30_000);

  it('requires exact consent to replace a non-resumable incomplete attempt', async () => {
    await dispatchAnalyzeRun(workDir, {
      kind: 'begin',
      runId: 'non-resumable-attempt',
      candidateAnalysisId: 'non-resumable-analysis',
      startedAt: '2026-07-19T10:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'old',
      completedBaselineId: null,
    });

    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'none-incomplete' },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).rejects.toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'expectation-changed',
      runId: 'non-resumable-attempt',
    });
    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'abandon', runId: 'wrong-attempt' },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).rejects.toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'expectation-changed',
    });

    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'abandon', runId: 'non-resumable-attempt' },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).resolves.toMatchObject({ analysisId: expect.any(String) });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { status: 'completed' },
    });

    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'none-incomplete' },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).resolves.toMatchObject({ analysisId: expect.any(String) });
  }, 30_000);

  it('blocks replacement of a legacy finalizing attempt whose recovery intent is absent', async () => {
    const computed = await analyzeCore(project, {
      mode: 'full',
      journalFullRun: true,
      source: 'cli',
      provider: new EmptyDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      skipStash: true,
    });
    const certified = computed.pipelineResult.certifiedLlmExecution;
    expect(certified).not.toBeNull();
    if (!certified) throw new Error('Expected a certified LLM execution');
    await beginFinalizeAnalyzeRun(workDir, {
      runId: certified.runId,
      finalizingAt: '2099-07-19T10:00:03.000Z',
    }, certified.completion);

    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'abandon', runId: certified.runId },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).rejects.toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'recovery-required',
      runId: certified.runId,
    });
  }, 30_000);

  it('rejects exact replacement of a durable execution-ambiguous attempt', async () => {
    await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');

    resetAnalyzeRunStorage();
    await analyzeCore(project, {
      mode: 'full',
      resumeFullRunId: blocked!.runId,
      provider: new ResumingDirectClaudeProvider(),
      skipStash: true,
      enableLlmRulesOverride: true,
    });

    const runPath = path.join(
      workDir,
      '.truecourse',
      'analyses',
      'runs',
      `${blocked!.runId}.json`,
    );
    const stored = JSON.parse(fs.readFileSync(runPath, 'utf8')) as {
      revision: number;
      updatedAt: string;
      executionAttempt: { resume: { admittedAt: string } };
      plan: {
        work: Array<{
          state: string;
          checkpoint?: { checkpointedAt: string };
        }>;
      };
    };
    const admittedAt = stored.executionAttempt.resume.admittedAt;
    const resumedCheckpoint = stored.plan.work.find(
      (item) => item.checkpoint && item.checkpoint.checkpointedAt >= admittedAt,
    );
    expect(resumedCheckpoint).toBeDefined();
    resumedCheckpoint!.state = 'pending';
    delete resumedCheckpoint!.checkpoint;
    stored.revision -= 1;
    stored.updatedAt = admittedAt;
    fs.writeFileSync(runPath, `${JSON.stringify(stored, null, 2)}\n`);
    resetAnalyzeRunStorage();

    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      runId: blocked!.runId,
      state: 'running',
      resume: { available: false, reason: 'resume-execution-ambiguous' },
    });
    const newerBaseline = await analyzeInProcess(project, {
      source: 'dashboard',
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: newerBaseline.analysisId, status: 'completed' },
    });
    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'abandon', runId: blocked!.runId },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).rejects.toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'resume-execution-ambiguous',
      runId: blocked!.runId,
    });
  }, 30_000);

  it('rechecks an observed absence of incomplete attempts inside the lifecycle lock', async () => {
    await dispatchAnalyzeRun(workDir, {
      kind: 'begin',
      runId: 'concurrent-attempt',
      candidateAnalysisId: 'concurrent-analysis',
      startedAt: '2026-07-19T10:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'concurrent',
      completedBaselineId: null,
    });

    const error = await analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'none-incomplete' },
      enableLlmRulesOverride: false,
      skipStash: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnalysisStartBlockedError);
    expect(error).toMatchObject({
      reason: 'expectation-changed',
      runId: 'concurrent-attempt',
    });
  }, 30_000);

  it('does not treat disappearance of an expected completed baseline as supersession', async () => {
    await dispatchAnalyzeRun(workDir, {
      kind: 'begin',
      runId: 'missing-baseline-attempt',
      candidateAnalysisId: 'missing-baseline-candidate',
      startedAt: '2026-07-19T10:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'old',
      completedBaselineId: 'disappeared-analysis',
    });

    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'none-incomplete' },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).rejects.toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'expectation-changed',
      runId: 'missing-baseline-attempt',
    });
    await expect(readLatest(workDir)).resolves.toBeNull();
  }, 30_000);

  it('blocks a direct-CLI attempt with reset information without replacing the completed baseline', async () => {
    await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    const latestPath = path.join(workDir, '.truecourse', 'LATEST.json');
    const historyPath = path.join(workDir, '.truecourse', 'history.json');
    const digest = (file: string): string =>
      createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const latestBefore = digest(latestPath);
    const historyBefore = digest(historyPath);
    const analysesBefore = await listAnalyses(workDir);

    const outcome = await analyzeInProcess(project, {
      source: 'cli',
      provider: new LimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    }).then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: 'LLM_SESSION_LIMIT',
        resetHint: '7pm (Africa/Cairo)',
        runId: expect.any(String),
      },
    });
    expect(outcome.error instanceof Error ? outcome.error.message : '').toMatch(
      /successful LLM results were checkpointed.*LATEST\.json was not updated.*durable attempt can be inspected.*resumed through the core API.*Starting a replacement may repeat paid calls/is,
    );
    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      state: 'blocked',
      blocked: { reason: 'provider-session-limit', resetHint: '7pm (Africa/Cairo)' },
      counts: { pending: expect.any(Number), succeeded: 0 },
      resume: { available: true, mode: 'resume', requiresRevalidation: true },
    });
    expect(digest(latestPath)).toBe(latestBefore);
    expect(digest(historyPath)).toBe(historyBefore);
    expect(await listAnalyses(workDir)).toEqual(analysesBefore);
  }, 30_000);

  it('keeps a successful sibling checkpoint when another work item reaches the session limit', async () => {
    const baseline = await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });

    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({
      code: 'LLM_SESSION_LIMIT',
      resetHint: '7pm (Africa/Cairo)',
    });

    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      state: 'blocked',
      counts: { total: 2, pending: 1, succeeded: 1 },
      resume: { available: true, mode: 'resume', requiresRevalidation: true },
    });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: baseline.analysisId, status: 'completed' },
    });
  }, 30_000);

  it('rejects a missing selected attempt before analysis or provider work', async () => {
    const provider = new NeverCallDirectClaudeProvider();

    await expect(analyzeCore(project, {
      mode: 'full',
      resumeFullRunId: 'missing-run',
      provider,
      skipStash: true,
      enableLlmRulesOverride: true,
    })).rejects.toMatchObject({ reason: 'run-not-found' });
    expect(provider.calls).toBe(0);
    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toBeNull();
  });

  it('reports unavailable public Resume states through one typed command error', async () => {
    const provider = new NeverCallDirectClaudeProvider();
    const failure = await resumeAnalyzeInProcess(project, {
      runId: 'missing-run',
      provider,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AnalysisResumeUnavailableError);
    expect(failure).toMatchObject({ reason: 'run-not-found' });
    expect(provider.calls).toBe(0);
  });

  it('reconstructs the selected attempt, executes only pending work, and leaves completed truth unchanged', async () => {
    const baseline = await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');

    resetAnalyzeRunStorage();
    const provider = new ResumingDirectClaudeProvider();
    const resumed = await analyzeCore(project, {
      mode: 'full',
      resumeFullRunId: blocked!.runId,
      provider,
      skipStash: true,
      enableLlmRulesOverride: true,
    });

    expect(resumed.analysisId).toBe(blocked!.candidateAnalysisId);
    expect(resumed.pipelineResult.certifiedLlmExecution).toMatchObject({
      runId: blocked!.runId,
      usage: [
        expect.objectContaining({ totalTokens: 120 }),
        expect.objectContaining({ totalTokens: 120 }),
      ],
    });
    expect(provider.stages).toEqual(['analyze.module']);
    expect(provider.modelOverrides).toEqual(['claude-sonnet-4-5-20250929']);
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'running',
      executionAttempt: { number: 2, resume: { admission: 'executing' } },
      counts: { total: 2, succeeded: 2, pending: 0 },
    });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: baseline.analysisId },
    });
  }, 30_000);

  it('resumes pending production work and atomically promotes the completed candidate', async () => {
    const baseline = await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: baseline.analysisId },
    });

    resetAnalyzeRunStorage();
    const provider = new ResumingDirectClaudeProvider();
    const resumed = await resumeAnalyzeInProcess(project, {
      runId: blocked!.runId,
      provider,
    });

    expect(resumed.analysisId).toBe(blocked!.candidateAnalysisId);
    expect(provider.stages).toEqual(['analyze.module']);
    expect(provider.modelOverrides).toEqual(['claude-sonnet-4-5-20250929']);
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'completed',
      counts: { total: 2, succeeded: 2, pending: 0 },
    });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: resumed.analysisId, status: 'completed' },
    });
    await expect(readAnalysis(workDir, resumed.filename)).resolves.toMatchObject({
      id: resumed.analysisId,
      usage: [
        expect.objectContaining({ totalTokens: 120 }),
        expect.objectContaining({ totalTokens: 120 }),
      ],
    });
  }, 30_000);

  it('rejects a dirty working-tree reconstruction before a provider call', async () => {
    await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');
    fs.appendFileSync(path.join(workDir, 'src', 'orders.ts'), '// uncommitted change\n');

    resetAnalyzeRunStorage();
    const provider = new NeverCallDirectClaudeProvider();
    await expect(analyzeCore(project, {
      mode: 'full',
      resumeFullRunId: blocked!.runId,
      provider,
      skipStash: true,
      enableLlmRulesOverride: true,
    })).rejects.toMatchObject({ reason: 'work-plan-changed' });

    expect(provider.calls).toBe(0);
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'blocked',
      revision: blocked!.revision,
      counts: { succeeded: 1, pending: 1 },
    });
  }, 30_000);

  it('rejects attempts to bypass repository validation with a spoofed old git identity', async () => {
    await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');
    fs.appendFileSync(path.join(workDir, 'src', 'orders.ts'), '// committed drift\n');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    execSync('git add -A', { cwd: workDir, env });
    execSync('git -c commit.gpgsign=false commit -q -m changed', { cwd: workDir, env });

    resetAnalyzeRunStorage();
    const provider = new NeverCallDirectClaudeProvider();
    await expect(analyzeCore(project, {
      mode: 'full',
      resumeFullRunId: blocked!.runId,
      provider,
      skipStash: true,
      skipGit: true,
      branch: blocked!.branch,
      commitHash: blocked!.commitHash,
      enableLlmRulesOverride: true,
    })).rejects.toMatchObject({ reason: 'work-plan-changed' });

    expect(provider.calls).toBe(0);
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'blocked',
      revision: blocked!.revision,
      counts: { succeeded: 1, pending: 1 },
    });
  }, 30_000);

  it('derives actual HEAD instead of trusting supplied identity hints during reconstruction', async () => {
    await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');
    fs.writeFileSync(path.join(workDir, 'README.md'), 'docs-only clean commit\n');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    execSync('git add -A', { cwd: workDir, env });
    execSync('git -c commit.gpgsign=false commit -q -m docs', { cwd: workDir, env });

    resetAnalyzeRunStorage();
    const provider = new NeverCallDirectClaudeProvider();
    await expect(analyzeCore(project, {
      mode: 'full',
      resumeFullRunId: blocked!.runId,
      provider,
      skipStash: true,
      branch: blocked!.branch,
      commitHash: blocked!.commitHash,
      enableLlmRulesOverride: true,
    })).rejects.toMatchObject({ reason: 'run-identity-changed' });

    expect(provider.calls).toBe(0);
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'blocked',
      revision: blocked!.revision,
      counts: { succeeded: 1, pending: 1 },
    });
  }, 30_000);

  it('rejects configuration drift before a reconstructed provider call', async () => {
    await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');
    await writeProjectConfig(workDir, {
      enabledCategories: ['architecture'],
      disabledRules: ['architecture/deterministic/god-service'],
    });

    resetAnalyzeRunStorage();
    const provider = new NeverCallDirectClaudeProvider();
    await expect(analyzeCore(project, {
      mode: 'full',
      resumeFullRunId: blocked!.runId,
      provider,
      skipStash: true,
      enableLlmRulesOverride: true,
    })).rejects.toMatchObject({ reason: 'work-plan-changed' });

    expect(provider.calls).toBe(0);
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'blocked',
      revision: blocked!.revision,
      counts: { succeeded: 1, pending: 1 },
    });
  }, 30_000);

  it('rejects completed-baseline drift before a reconstructed provider call', async () => {
    await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');
    const newerBaseline = await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });

    resetAnalyzeRunStorage();
    const provider = new NeverCallDirectClaudeProvider();
    await expect(analyzeCore(project, {
      mode: 'full',
      resumeFullRunId: blocked!.runId,
      provider,
      skipStash: true,
      enableLlmRulesOverride: true,
    })).rejects.toMatchObject({ reason: 'run-identity-changed' });

    expect(provider.calls).toBe(0);
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'blocked',
      revision: blocked!.revision,
      counts: { succeeded: 1, pending: 1 },
    });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: newerBaseline.analysisId },
    });
  }, 30_000);

  it('re-blocks the selected attempt when its pending provider work reaches the limit again', async () => {
    const baseline = await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');

    resetAnalyzeRunStorage();
    const provider = new ResumeLimitedDirectClaudeProvider();
    const failure = await resumeAnalyzeInProcess(project, {
      runId: blocked!.runId,
      provider,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'LLM_SESSION_LIMIT',
      resetHint: 'tomorrow 8pm (Africa/Cairo)',
    });
    expect(failure instanceof Error ? failure.message : '').toMatch(
      /saved as the latest attempted run.*durable attempt can be inspected.*resumed through the core API.*Starting a replacement may repeat paid calls/is,
    );

    expect(provider.stages).toEqual(['analyze.module']);
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'blocked',
      executionAttempt: { number: 2 },
      blocked: { resetHint: 'tomorrow 8pm (Africa/Cairo)' },
      counts: { total: 2, succeeded: 1, pending: 1 },
    });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: baseline.analysisId },
    });
  }, 30_000);

  it('finalizes fully checkpointed reconstruction recovery without another provider call', async () => {
    const baseline = await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    await expect(analyzeInProcess(project, {
      source: 'cli',
      provider: new PartiallyLimitedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    })).rejects.toMatchObject({ code: 'LLM_SESSION_LIMIT' });
    const blocked = await readAnalyzeRun(workDir, 'latest-attempt');

    resetAnalyzeRunStorage();
    await expect(resumeAnalyzeInProcess(project, {
      runId: blocked!.runId,
      provider: new CleanupFailingResumingProvider(),
    })).rejects.toThrow('injected provider cleanup failure');
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'running',
      executionAttempt: { resume: { admission: 'executing' } },
      counts: { total: 2, succeeded: 2, pending: 0 },
    });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: baseline.analysisId },
    });

    resetAnalyzeRunStorage();
    const provider = new NeverCallDirectClaudeProvider();
    const recovered = await resumeAnalyzeInProcess(project, {
      runId: blocked!.runId,
      provider,
    });

    expect(provider.calls).toBe(0);
    await expect(readAnalyzeRun(workDir, { runId: blocked!.runId })).resolves.toMatchObject({
      state: 'completed',
      counts: { total: 2, succeeded: 2, pending: 0 },
    });
    await expect(readAnalysis(workDir, recovered.filename)).resolves.toMatchObject({
      usage: [
        expect.objectContaining({ totalTokens: 120 }),
        expect.objectContaining({ totalTokens: 120 }),
      ],
    });
  }, 30_000);

  it('does not create an attempted LLM run when the user declines the estimate', async () => {
    const result = await analyzeInProcess(project, {
      source: 'cli',
      provider: new EmptyDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => false,
      skipStash: true,
    });

    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toBeNull();
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: result.analysisId, status: 'completed' },
    });
  }, 30_000);

  it('journals a service-only architecture rule plan without admitting empty module work', async () => {
    await writeProjectConfig(workDir, {
      disabledRules: ARCHITECTURE_LLM_RULES
        .filter((rule) => rule.category === 'module')
        .map((rule) => rule.key),
    });
    const provider = new RecordingFamilyDirectClaudeProvider();

    const result = await analyzeInProcess(project, {
      source: 'cli',
      provider,
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    });

    expect(provider.stages).toEqual(['analyze.service']);
    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      candidateAnalysisId: result.analysisId,
      state: 'completed',
      counts: { pending: 0, succeeded: 1 },
    });
  }, 30_000);

  it('journals a module-only architecture rule plan without admitting empty service work', async () => {
    await writeProjectConfig(workDir, {
      disabledRules: ARCHITECTURE_LLM_RULES
        .filter((rule) => rule.category === 'service')
        .map((rule) => rule.key),
    });
    const provider = new RecordingFamilyDirectClaudeProvider();

    const result = await analyzeInProcess(project, {
      source: 'cli',
      provider,
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    });

    expect(provider.stages).toEqual(['analyze.module']);
    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      candidateAnalysisId: result.analysisId,
      state: 'completed',
      counts: { pending: 0, succeeded: 1 },
    });
  }, 30_000);

  it('handles a normal service result beside a module lifecycle result', async () => {
    await analyzeInProcess(project, {
      source: 'cli',
      provider: new ModuleFindingDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    });

    const result = await analyzeInProcess(project, {
      source: 'cli',
      provider: new MixedModeDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    });

    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      candidateAnalysisId: result.analysisId,
      state: 'completed',
    });
    expect((await readLatest(workDir))?.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Module-only prior finding', status: 'unchanged' }),
        expect.objectContaining({
          title: 'Unknown lifecycle module target',
          targetModuleId: null,
        }),
      ]),
    );
  }, 30_000);

  it('clears provider target IDs that are outside the analyzed graph', async () => {
    await analyzeInProcess(project, {
      source: 'cli',
      provider: new InvalidTargetDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    });

    expect((await readLatest(workDir))?.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Unknown service target',
          targetServiceId: null,
          targetServiceName: null,
        }),
      ]),
    );
  }, 30_000);

  it('keeps prepared finalization recoverable when promotion reports an ambiguous failure', async () => {
    const baseStore = getAnalysisStore();
    const faultingStore = new Proxy(baseStore, {
      get(target, property, receiver) {
        if (property === 'promoteCompletedAnalysisBaseline') {
          return async (...args: Parameters<typeof target.promoteCompletedAnalysisBaseline>) => {
            await target.promoteCompletedAnalysisBaseline(...args);
            throw new Error('injected ambiguous promotion response');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    setAnalysisStore(faultingStore);

    const outcome = await analyzeInProcess(project, {
      source: 'cli',
      provider: new EmptyDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    }).then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: { message: 'injected ambiguous promotion response' },
    });
    const attempted = await readAnalyzeRun(workDir, 'latest-attempt');
    expect(attempted).toMatchObject({
      state: 'finalizing',
      finalization: { persistence: 'prepared' },
    });
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: attempted?.candidateAnalysisId, status: 'completed' },
    });

    setAnalysisStore(baseStore);
    resetAnalyzeRunStorage();
    await expect(analyzeInProcess(project, {
      latestAttemptExpectation: { kind: 'abandon', runId: attempted!.runId },
      enableLlmRulesOverride: false,
      skipStash: true,
    })).rejects.toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'recovery-required',
      runId: attempted!.runId,
    });

    const provider = new NeverCallDirectClaudeProvider();
    const recovered = await resumeAnalyzeInProcess(project, {
      runId: attempted!.runId,
      provider,
    });

    expect(provider.calls).toBe(0);
    expect(recovered.analysisId).toBe(attempted?.candidateAnalysisId);
    await expect(readAnalyzeRun(workDir, { runId: attempted!.runId })).resolves.toMatchObject({
      state: 'completed',
      finalization: { persistence: 'prepared' },
    });
    expect((await readHistory(workDir)).analyses.filter(
      (analysis) => analysis.id === recovered.analysisId,
    )).toHaveLength(1);
  }, 30_000);

  it('fails the attempted run when its finalization plan cannot be built', async () => {
    const baseline = await analyzeInProcess(project, {
      enableLlmRulesOverride: false,
      skipStash: true,
    });
    const latestPath = path.join(workDir, '.truecourse', 'LATEST.json');
    const latestBefore = fs.readFileSync(latestPath);
    let slugReads = 0;
    const invalidFinalizationProject = new Proxy(project, {
      get(target, property, receiver) {
        if (property === 'slug' && ++slugReads === 2) {
          throw new Error('injected invalid finalization projection');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const outcome = await analyzeInProcess(invalidFinalizationProject, {
      source: 'cli',
      provider: new FutureCompletedDirectClaudeProvider(),
      enabledCategoriesOverride: ['architecture'],
      enableLlmRulesOverride: true,
      onLlmEstimate: async () => true,
      skipStash: true,
    }).then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: { message: 'injected invalid finalization projection' },
    });
    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      state: 'failed',
      updatedAt: '2099-07-19T04:00:02.000Z',
      failure: {
        code: 'ANALYZE_FINALIZATION_FAILED',
        failedAt: '2099-07-19T04:00:02.000Z',
      },
    });
    expect(fs.readFileSync(latestPath)).toEqual(latestBefore);
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: baseline.analysisId, status: 'completed' },
    });
  }, 30_000);
});
