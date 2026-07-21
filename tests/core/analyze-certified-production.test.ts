import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARCHITECTURE_LLM_RULES } from '../../packages/analyzer/src/index.js';
import { analyzeInProcess } from '../../packages/core/src/commands/analyze-in-process.js';
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
  readHistory,
  readLatest,
  resetAnalysisStore,
  setAnalysisStore,
} from '../../packages/core/src/lib/analysis-store.js';
import {
  readAnalyzeRun,
  resetAnalyzeRunStorage,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import { ClaudeCodeProvider } from '../../packages/core/src/services/llm/cli-provider.js';
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

class LimitedDirectClaudeProvider extends ClaudeCodeProvider {
  protected async spawnCLI(): Promise<string> {
    throw new LlmSessionLimitError('7pm (Africa/Cairo)');
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
      error: { code: 'LLM_SESSION_LIMIT', resetHint: '7pm (Africa/Cairo)' },
    });
    expect(outcome.error instanceof Error ? outcome.error.message : '').toMatch(
      /saved as the latest attempted run.*LATEST\.json was not updated.*successful LLM calls.*may be repeated/is,
    );
    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      state: 'blocked',
      blocked: { reason: 'provider-session-limit', resetHint: '7pm (Africa/Cairo)' },
      counts: { pending: expect.any(Number), succeeded: 0 },
      resume: { available: false, reason: 'successful-results-not-checkpointed' },
    });
    expect(digest(latestPath)).toBe(latestBefore);
    expect(digest(historyPath)).toBe(historyBefore);
    expect(await listAnalyses(workDir)).toEqual(analysesBefore);
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
      error: { message: 'injected invalid finalization projection' },
    });
    await expect(readAnalyzeRun(workDir, 'latest-attempt')).resolves.toMatchObject({
      state: 'failed',
      failure: { code: 'ANALYZE_FINALIZATION_FAILED' },
    });
    expect(fs.readFileSync(latestPath)).toEqual(latestBefore);
    await expect(readLatest(workDir)).resolves.toMatchObject({
      analysis: { id: baseline.analysisId, status: 'completed' },
    });
  }, 30_000);
});
