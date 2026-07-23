import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { LlmSessionLimitError } from '@truecourse/shared/llm';
import {
  AnalyzeLlmPlanError,
  certifyAnalyzeLlmRun,
  type AnalyzeLlmPlanInput,
  type AnalyzeLlmExecutionAdapter,
  type AnalyzeLlmExecutionOutcome,
  type CertifiedAnalyzeLlmWork,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import {
  type AnalyzeRunStorage,
  type StoredAnalyzeRun,
  beginFinalizeAnalyzeRun,
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  setAnalyzeRunStorage,
  type AnalyzeRunPlanActivation,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import type {
  CodeViolationContext,
  DatabaseViolationContext,
  ModuleViolationContext,
  ServiceViolationContext,
} from '../../packages/core/src/services/llm/provider.js';

const rule = {
  key: 'bugs/llm/test',
  name: 'Test rule',
  severity: 'medium',
  prompt: 'Find the test issue.',
};

const codeContext: CodeViolationContext = {
  files: [{ path: 'context', content: '1: export const a = 1;' }],
  sourceScopes: [{ path: '/repo/src/a.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }],
  sources: [{
    path: '/repo/src/a.ts',
    selection: {
      kind: 'targeted',
      functions: [{ name: 'a', startLine: 1, endLine: 1 }],
    },
  }],
  llmRules: [rule],
  tier: 'targeted',
};

const fullFileCodeContext: CodeViolationContext = {
  ...structuredClone(codeContext),
  files: [{ path: '/repo/src/a.ts', content: 'export const a = 1;' }],
  sources: [{ path: '/repo/src/a.ts', selection: { kind: 'full-file' } }],
  tier: 'full-file',
};

const databaseContext: DatabaseViolationContext = {
  databases: [{
    id: 'runtime-db-1',
    name: 'app',
    type: 'postgresql',
    driver: 'pg',
    tableCount: 1,
    connectedServices: ['api'],
    tables: [{ name: 'users', columns: [{ name: 'id', type: 'uuid', isPrimaryKey: true }] }],
    relations: [],
  }],
  llmRules: [{ ...rule, key: 'database/llm/test' }],
};

const serviceContext: ServiceViolationContext = {
  architecture: 'monolith',
  services: [{
    id: 'runtime-service-1',
    name: 'api',
    type: 'backend',
    framework: 'express',
    fileCount: 1,
    layers: ['application'],
  }],
  dependencies: [],
  llmRules: [{ ...rule, key: 'architecture/llm/service-test' }],
};

const invalidLateModuleContext: ModuleViolationContext = {
  modules: [
    {
      id: 'runtime-module-1',
      name: 'Users',
      kind: 'class',
      serviceId: 'runtime-service-1',
      serviceName: 'api',
      layerName: 'application',
      methodCount: 0,
      propertyCount: 0,
      importCount: 0,
      exportCount: 1,
    },
    {
      id: 'runtime-module-2',
      name: 'Users',
      kind: 'class',
      serviceId: 'runtime-service-2',
      serviceName: 'api',
      layerName: 'application',
      methodCount: 0,
      propertyCount: 0,
      importCount: 0,
      exportCount: 1,
    },
  ],
  methods: [],
  moduleDependencies: [],
  methodDependencies: [],
  llmRules: [{ ...rule, key: 'architecture/llm/module-test' }],
};

const validLifecycleModuleContext: ModuleViolationContext = {
  ...invalidLateModuleContext,
  modules: [invalidLateModuleContext.modules[0]],
  existingViolations: [{
    id: 'runtime-prior-module-1',
    type: 'module',
    title: 'Prior module issue',
    content: 'The prior module issue remains relevant.',
    severity: 'medium',
  }],
};

class RecordingAdapter implements AnalyzeLlmExecutionAdapter {
  readonly execution = Object.freeze({
    provider: 'claude-code',
    requestedModel: 'opus[1m]',
  });
  readonly calls: CertifiedAnalyzeLlmWork[] = [];

  async execute(work: CertifiedAnalyzeLlmWork): Promise<AnalyzeLlmExecutionOutcome> {
    this.calls.push(work);
    return outcomeFor(work);
  }
}

function validResultFor(work: CertifiedAnalyzeLlmWork): unknown {
  if (work.mode === 'normal') {
    return work.family === 'service'
      ? { violations: [], serviceDescriptions: [] }
      : { violations: [] };
  }
  const lifecycle = {
    newViolations: [],
    resolvedViolationIds: [],
    unchangedViolationIds: work.family === 'database'
      ? work.planned.request.ownership.priorFindings.map((finding) => finding.promptId)
      : [],
  };
  return work.family === 'service'
    ? { ...lifecycle, serviceDescriptions: [] }
    : lifecycle;
}

function outcomeFor(
  work: CertifiedAnalyzeLlmWork,
  result: unknown = validResultFor(work),
): AnalyzeLlmExecutionOutcome {
  return {
    family: work.family,
    domain: work.domain,
    mode: work.mode,
    workId: work.workId,
    inputFingerprint: work.inputFingerprint,
    resultContractId: work.planned.request.resultContractId,
    result,
    attemptId: `test:${work.workId}`,
    completedAt: new Date().toISOString(),
    usage: null,
  };
}

const journalRepository = mkdtempSync(path.join(tmpdir(), 'truecourse-certified-run-'));
const temporaryRepositories: string[] = [journalRepository];
let runSequence = 0;

afterAll(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

afterEach(() => {
  resetAnalyzeRunStorage();
});

async function activate(
  certified: ReturnType<typeof certifyAnalyzeLlmRun>,
  runId: string,
  repository = journalRepository,
): Promise<AnalyzeRunPlanActivation> {
  runSequence += 1;
  await dispatchAnalyzeRun(repository, {
    kind: 'begin',
    runId,
    candidateAnalysisId: `candidate-${runSequence}`,
    startedAt: '2026-07-19T00:00:00.000Z',
    source: 'cli',
    branch: 'main',
    commitHash: 'abc123',
    completedBaselineId: 'completed-baseline',
  });
  return sealAnalyzeRunPlan(repository, {
    kind: 'seal-plan',
    execution: { provider: 'claude-code', requestedModel: 'opus[1m]' },
    runId,
    sealedAt: '2026-07-19T00:00:01.000Z',
    work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    })),
  });
}

describe('certified analyze LLM run', () => {
  it('records explicit initial execution admission before the provider callback', async () => {
    const providerFailure = new Error('provider callback stopped');
    let observedDuringProvider: Awaited<ReturnType<typeof readAnalyzeRun>> = null;
    const certified = certifyAnalyzeLlmRun({
      runId: 'initial-admission-order',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute() {
        observedDuringProvider = await readAnalyzeRun(
          journalRepository,
          { runId: 'initial-admission-order' },
        );
        throw providerFailure;
      },
    });
    const activation = await activate(certified, 'initial-admission-order');

    await expect(certified.execute(activation)).rejects.toBe(providerFailure);
    expect(observedDuringProvider).toMatchObject({
      schemaVersion: 9,
      revision: 2,
      state: 'running',
      executionAttempt: {
        number: 1,
        initialAdmission: {
          admission: 'executing',
          admittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
          evidence: 'explicit',
        },
      },
      counts: { pending: 1, succeeded: 0 },
      resume: { available: false, reason: 'resume-execution-ambiguous' },
    });
  });

  it('spends no provider calls when a later work family cannot be certified', () => {
    const adapter = new RecordingAdapter();

    expect(() => certifyAnalyzeLlmRun({
      runId: 'planning-failure',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
      database: databaseContext,
      service: serviceContext,
      module: invalidLateModuleContext,
    }, adapter)).toThrow(expect.objectContaining<Partial<AnalyzeLlmPlanError>>({
      code: 'request-preparation-failed',
      family: 'module',
    }));
    expect(adapter.calls).toEqual([]);
  });

  it('rejects a code domain label that disagrees with its rule keys', () => {
    const adapter = new RecordingAdapter();

    expect(() => certifyAnalyzeLlmRun({
      runId: 'domain-mismatch',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'security', context: codeContext }],
    }, adapter)).toThrow(expect.objectContaining({
      code: 'invalid-context',
      family: 'code',
      domain: 'security',
    }));

    const architecture = structuredClone(codeContext);
    architecture.llmRules = [{ ...rule, key: 'architecture/llm/test' }];
    expect(() => certifyAnalyzeLlmRun({
      runId: 'ineligible-code-domain',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'architecture', context: architecture }],
    }, adapter)).toThrow(expect.objectContaining({ code: 'invalid-context' }));

    const mixed = structuredClone(codeContext);
    mixed.llmRules.push({ ...rule, key: 'security/llm/test' });
    expect(() => certifyAnalyzeLlmRun({
      runId: 'mixed-code-domains',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: mixed }],
    }, adapter)).toThrow(expect.objectContaining({ code: 'invalid-context' }));
    expect(adapter.calls).toEqual([]);
  });

  it('rejects empty or cross-domain aggregate rule sets before provider admission', () => {
    const adapter = new RecordingAdapter();
    const invalidCases: Array<{
      runId: string;
      family: 'database' | 'service' | 'module';
      input: Pick<AnalyzeLlmPlanInput, 'database' | 'service' | 'module'>;
    }> = [
      {
        runId: 'empty-database-rules',
        family: 'database',
        input: { database: { ...structuredClone(databaseContext), llmRules: [] } },
      },
      {
        runId: 'cross-domain-service-rules',
        family: 'service',
        input: {
          service: {
            ...structuredClone(serviceContext),
            llmRules: [{ ...rule, key: 'database/llm/not-architecture' }],
          },
        },
      },
      {
        runId: 'cross-domain-module-rules',
        family: 'module',
        input: {
          module: {
            ...structuredClone(validLifecycleModuleContext),
            llmRules: [{ ...rule, key: 'bugs/llm/not-architecture' }],
          },
        },
      },
    ];

    for (const { runId, family, input } of invalidCases) {
      expect(() => certifyAnalyzeLlmRun({
        runId,
        journalKey: journalRepository,
        repositoryRoot: '/repo',
        code: [],
        ...input,
      }, adapter)).toThrow(expect.objectContaining({
        code: 'invalid-context',
        family,
      }));
    }
    expect(adapter.calls).toEqual([]);
  });

  it('certifies every request before executing the exact frozen multi-family plan', async () => {
    const adapter = new RecordingAdapter();
    const firstCode = structuredClone(codeContext);
    const secondCode = structuredClone(codeContext);
    secondCode.files = [{ path: 'context', content: '1: export const b = 2;' }];
    secondCode.sourceScopes = [{ path: '/repo/src/b.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }];
    secondCode.sources = [{
      path: '/repo/src/b.ts',
      selection: {
        kind: 'targeted',
        functions: [{ name: 'b', startLine: 1, endLine: 1 }],
      },
    }];
    secondCode.llmRules = [{ ...rule, key: 'security/llm/test' }];
    const lifecycleDatabase = structuredClone(databaseContext);
    lifecycleDatabase.existingViolations = [{
      id: 'runtime-prior-db-1',
      type: 'database',
      title: 'Prior database issue',
      content: 'The prior database issue remains relevant.',
      severity: 'medium',
      ruleKey: 'database/llm/test',
      targetDatabaseName: 'app',
      targetTable: 'users',
    }];
    const service = structuredClone(serviceContext);
    const module = structuredClone(validLifecycleModuleContext);

    const certified = certifyAnalyzeLlmRun({
      runId: 'complete-plan',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [
        { domain: 'bugs', context: firstCode },
        { domain: 'security', context: secondCode },
      ],
      database: lifecycleDatabase,
      service,
      module,
    }, adapter);

    expect(adapter.calls).toEqual([]);
    expect(certified.manifest.work).toHaveLength(5);
    expect(certified.manifest.work.map(({ family, domain, mode }) => ({ family, domain, mode })))
      .toEqual(expect.arrayContaining([
        { family: 'code', domain: 'bugs', mode: 'normal' },
        { family: 'code', domain: 'security', mode: 'normal' },
        { family: 'database', domain: 'database', mode: 'lifecycle' },
        { family: 'service', domain: 'architecture', mode: 'normal' },
        { family: 'module', domain: 'architecture', mode: 'lifecycle' },
      ]));

    firstCode.files[0].content = 'MUTATED AFTER CERTIFICATION';
    lifecycleDatabase.databases[0].name = 'MUTATED_AFTER_CERTIFICATION';
    service.services[0].name = 'MUTATED_AFTER_CERTIFICATION';
    module.modules[0].name = 'MUTATED_AFTER_CERTIFICATION';

    const activation = await activate(certified, 'complete-plan');
    expect(adapter.calls).toEqual([]);
    const executionResults = await certified.execute(activation);

    expect(adapter.calls).toHaveLength(5);
    expect(executionResults.results.map(({ result }) => result)).toEqual(
      adapter.calls.map((work) => validResultFor(work)),
    );
    expect(adapter.calls.map(({ workId, inputFingerprint }) => ({ workId, inputFingerprint })))
      .toEqual(certified.manifest.work.map(({ workId, inputFingerprint }) => ({
        workId,
        inputFingerprint,
      })));
    for (const call of adapter.calls) {
      expect(Object.isFrozen(call)).toBe(true);
      expect(Object.isFrozen(call.planned.request)).toBe(true);
      expect(Object.isFrozen(call.planned.request.bindings)).toBe(true);
      expect(Object.isFrozen(call.planned.request.ownership)).toBe(true);
      expect(call.planned.request.parse).toEqual(expect.any(Function));
      expect(call.planned.request.prompt).not.toContain('MUTATED_AFTER_CERTIFICATION');
    }
    expect(adapter.calls.map((call) => ({
      family: call.family,
      mode: call.mode,
      stage: call.planned.request.stage,
      resultContractId: call.planned.request.resultContractId,
    }))).toEqual(expect.arrayContaining([
      { family: 'code', mode: 'normal', stage: 'analyze.code', resultContractId: 'analyze.code@1' },
      { family: 'database', mode: 'lifecycle', stage: 'analyze.database-lifecycle', resultContractId: 'analyze.database-lifecycle@1' },
      { family: 'service', mode: 'normal', stage: 'analyze.service', resultContractId: 'analyze.service@1' },
      { family: 'module', mode: 'lifecycle', stage: 'analyze.module-lifecycle', resultContractId: 'analyze.module-lifecycle@1' },
    ]));
  });

  it('executes each opposite lifecycle mode with its certified request contract', async () => {
    const adapter = new RecordingAdapter();
    const lifecycleCode = structuredClone(codeContext);
    lifecycleCode.existingViolations = [{
      id: 'runtime-prior-code-1',
      filePath: '/repo/src/a.ts',
      lineStart: 1,
      lineEnd: 1,
      ruleKey: rule.key,
      title: 'Prior code issue',
      content: 'The prior code issue remains relevant.',
      severity: 'medium',
    }];
    const lifecycleService = structuredClone(serviceContext);
    lifecycleService.existingViolations = [{
      id: 'runtime-prior-service-1',
      type: 'service',
      title: 'Prior service issue',
      content: 'The prior service issue remains relevant.',
      severity: 'medium',
    }];
    const normalModule = structuredClone(validLifecycleModuleContext);
    delete normalModule.existingViolations;
    const certified = certifyAnalyzeLlmRun({
      runId: 'opposite-lifecycle-modes',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: lifecycleCode }],
      database: databaseContext,
      service: lifecycleService,
      module: normalModule,
    }, adapter);
    const activation = await activate(certified, 'opposite-lifecycle-modes');

    await certified.execute(activation);

    expect(adapter.calls.map((call) => ({
      family: call.family,
      mode: call.mode,
      stage: call.planned.request.stage,
      resultContractId: call.planned.request.resultContractId,
    }))).toEqual(expect.arrayContaining([
      { family: 'code', mode: 'lifecycle', stage: 'analyze.code-lifecycle', resultContractId: 'analyze.code-lifecycle@1' },
      { family: 'database', mode: 'normal', stage: 'analyze.database', resultContractId: 'analyze.database@1' },
      { family: 'service', mode: 'lifecycle', stage: 'analyze.service-lifecycle', resultContractId: 'analyze.service-lifecycle@1' },
      { family: 'module', mode: 'normal', stage: 'analyze.module', resultContractId: 'analyze.module@1' },
    ]));
  });

  it.each([
    ['family', 'database'],
    ['domain', 'security'],
    ['mode', 'lifecycle'],
    ['workId', 'forged-work-id'],
    ['inputFingerprint', 'sha256:forged'],
    ['resultContractId', 'analyze.database@1'],
  ] as const)('rejects an adapter result with a mismatched %s', async (field, forgedValue) => {
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(work) {
        return {
          ...outcomeFor(work, { violations: [] }),
          [field]: forgedValue,
        };
      },
    };
    const runId = `mismatched-result-${field}`;
    const certified = certifyAnalyzeLlmRun({
      runId,
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, runId);

    await expect(certified.execute(activation)).rejects.toMatchObject({
      code: 'result-not-certified',
      family: 'code',
      domain: 'bugs',
    });
  });

  it('rejects a result that does not satisfy the exact planned response contract', async () => {
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(work) {
        return outcomeFor(work, { notViolations: [] });
      },
    };
    const certified = certifyAnalyzeLlmRun({
      runId: 'invalid-result-contract',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, 'invalid-result-contract');

    await expect(certified.execute(activation)).rejects.toMatchObject({
      code: 'result-not-certified',
      family: 'code',
      domain: 'bugs',
    });
  });

  it('rejects unowned database output before writing a durable checkpoint', async () => {
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(work) {
        return outcomeFor(work, {
          violations: [{
            type: 'database',
            title: 'Foreign database result',
            content: 'This result names a rule outside the planned database work.',
            severity: 'high',
            targetDatabaseId: 'db-0',
            targetTable: 'users',
            fixPrompt: null,
            ruleKey: 'database/llm/foreign',
          }],
        });
      },
    };
    const runId = 'database-result-ownership';
    const certified = certifyAnalyzeLlmRun({
      runId,
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [],
      database: databaseContext,
    }, adapter);
    const activation = await activate(certified, runId);

    await expect(certified.execute(activation)).rejects.toMatchObject({
      code: 'result-not-certified',
      family: 'database',
      domain: 'database',
    });
    await expect(readAnalyzeRun(journalRepository, { runId })).resolves.toMatchObject({
      plan: 'sealed',
      counts: { total: 1, pending: 1, running: 0, succeeded: 0, failed: 0 },
    });
  });

  it.each([
    ['provider', { provider: 'other-provider' }],
    ['requested model', { requestedModel: 'other-model' }],
    ['call type', { callType: 'service' }],
    ['token total', { totalTokens: 999 }],
    ['negative input tokens', { inputTokens: -1, totalTokens: 1 }],
    ['fractional output tokens', { outputTokens: 1.5, totalTokens: 11.5 }],
    ['negative cache read tokens', { cacheReadTokens: -1 }],
    ['infinite cache write tokens', { cacheWriteTokens: Number.POSITIVE_INFINITY }],
    ['negative duration', { durationMs: -1 }],
    ['invalid cost', { costUsd: 'not-a-number' }],
    ['empty resolved model', { resolvedModel: '' }],
  ] as const)('rejects checkpoint usage with invalid %s evidence', async (_case, override) => {
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(work) {
        return {
          ...outcomeFor(work),
          usage: {
            provider: 'claude-code',
            requestedModel: 'opus[1m]',
            resolvedModel: null,
            callType: 'code',
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 12,
            costUsd: null,
            durationMs: 20,
            ...override,
          },
        };
      },
    };
    const runId = `invalid-usage-${String(_case).replaceAll(' ', '-')}`;
    const certified = certifyAnalyzeLlmRun({
      runId,
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, runId);

    await expect(certified.execute(activation)).rejects.toMatchObject({
      code: 'result-not-certified',
      family: 'code',
      domain: 'bugs',
    });
  });

  it('rejects a non-canonical completion timestamp', async () => {
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(work) {
        return {
          ...outcomeFor(work),
          completedAt: 'July 19, 2026 04:00:02 UTC',
        };
      },
    };
    const certified = certifyAnalyzeLlmRun({
      runId: 'invalid-completion-timestamp',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, 'invalid-completion-timestamp');

    await expect(certified.execute(activation)).rejects.toMatchObject({
      code: 'result-not-certified',
      family: 'code',
      domain: 'bugs',
    });
  });

  it.each([
    ['null', null],
    ['primitive', 'not-an-outcome'],
    ['missing result', 'identity-only'],
  ] as const)('rejects a malformed %s adapter outcome', async (_case, malformed) => {
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(work) {
        if (malformed === 'identity-only') {
          const { result: _result, ...identity } = outcomeFor(work, { violations: [] });
          return identity as AnalyzeLlmExecutionOutcome;
        }
        return malformed as unknown as AnalyzeLlmExecutionOutcome;
      },
    };
    const runId = `malformed-result-${_case.replace(' ', '-')}`;
    const certified = certifyAnalyzeLlmRun({
      runId,
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, runId);

    await expect(certified.execute(activation)).rejects.toMatchObject({
      code: 'result-not-certified',
      family: 'code',
      domain: 'bugs',
    });
  });

  it('rejects a forged activation receipt without spending provider calls', async () => {
    const adapter = new RecordingAdapter();
    const certified = certifyAnalyzeLlmRun({
      runId: 'forged-activation',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);

    await expect(certified.execute({} as AnalyzeRunPlanActivation)).rejects.toMatchObject({
      code: 'plan-not-activated',
    });
    expect(adapter.calls).toEqual([]);
    const activation = await activate(certified, 'forged-activation');
    await expect(certified.execute(activation)).resolves.toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ result: { violations: [] } })]),
      completion: expect.any(Object),
    });
    expect(adapter.calls).toHaveLength(1);
  });

  it('recovers one executable receipt for an exact already-sealed manifest', async () => {
    const adapter = new RecordingAdapter();
    const runId = 'recover-sealed-activation';
    const certified = certifyAnalyzeLlmRun({
      runId,
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: structuredClone(codeContext) }],
    }, adapter);
    runSequence += 1;
    await dispatchAnalyzeRun(journalRepository, {
      kind: 'begin',
      runId,
      candidateAnalysisId: `candidate-${runSequence}`,
      startedAt: '2026-07-19T00:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc123',
      completedBaselineId: 'completed-baseline',
    });
    const sealCommand = {
      kind: 'seal-plan' as const,
      execution: { provider: 'claude-code', requestedModel: 'opus[1m]' },
      runId,
      sealedAt: '2026-07-19T00:00:01.000Z',
      work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
        workId,
        inputFingerprint,
      })),
    };
    await dispatchAnalyzeRun(journalRepository, sealCommand);

    const [first, second] = await Promise.all([
      sealAnalyzeRunPlan(journalRepository, sealCommand),
      sealAnalyzeRunPlan(journalRepository, sealCommand),
    ]);
    expect(first).toBe(second);

    const settled = await Promise.allSettled([
      certified.execute(first),
      certified.execute(second),
    ]);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(adapter.calls).toHaveLength(1);

    const recovered = certifyAnalyzeLlmRun({
      runId,
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: structuredClone(codeContext) }],
    }, adapter);
    expect(recovered.manifest.work).toEqual(certified.manifest.work);
    await expect(sealAnalyzeRunPlan(journalRepository, sealCommand))
      .rejects.toThrow(/already admitted/i);
    expect(adapter.calls).toHaveLength(1);

    await expect(sealAnalyzeRunPlan(journalRepository, {
      ...sealCommand,
      work: [{
        ...sealCommand.work[0],
        inputFingerprint: `sha256:${'f'.repeat(64)}`,
      }],
    })).rejects.toThrow(/sealed manifest/i);
  });

  it('rejects a durable receipt issued for a different run', async () => {
    const firstAdapter = new RecordingAdapter();
    const first = certifyAnalyzeLlmRun({
      runId: 'receipt-source-run',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, firstAdapter);
    const activation = await activate(first, 'receipt-source-run');
    const adapter = new RecordingAdapter();
    const other = certifyAnalyzeLlmRun({
      runId: 'receipt-target-run',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);

    await expect(other.execute(activation)).rejects.toMatchObject({
      code: 'plan-not-activated',
    });
    expect(adapter.calls).toEqual([]);
    await expect(first.execute(activation)).resolves.toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ result: { violations: [] } })]),
      completion: expect.any(Object),
    });
    expect(firstAdapter.calls).toHaveLength(1);
  });

  it('rejects an identical run receipt issued by a different repository journal', async () => {
    const foreignRepository = mkdtempSync(path.join(tmpdir(), 'truecourse-certified-foreign-'));
    temporaryRepositories.push(foreignRepository);
    const adapter = new RecordingAdapter();
    const certified = certifyAnalyzeLlmRun({
      runId: 'same-run-and-plan',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const foreignActivation = await activate(
      certified,
      'same-run-and-plan',
      foreignRepository,
    );

    await expect(certified.execute(foreignActivation)).rejects.toMatchObject({
      code: 'plan-not-activated',
    });
    expect(adapter.calls).toEqual([]);

    const rightfulAdapter = new RecordingAdapter();
    const rightful = certifyAnalyzeLlmRun({
      runId: 'same-run-and-plan',
      journalKey: foreignRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, rightfulAdapter);
    await expect(rightful.execute(foreignActivation)).resolves.toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ result: { violations: [] } })]),
      completion: expect.any(Object),
    });
    expect(rightfulAdapter.calls).toHaveLength(1);
  });

  it('rejects a receipt after its sealed run becomes terminal', async () => {
    const adapter = new RecordingAdapter();
    const certified = certifyAnalyzeLlmRun({
      runId: 'terminal-before-execution',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, 'terminal-before-execution');
    await dispatchAnalyzeRun(journalRepository, {
      kind: 'fail',
      runId: 'terminal-before-execution',
      failedAt: '2026-07-19T00:00:02.000Z',
      error: { code: 'LLM_FAILED', message: 'Execution was cancelled before provider start.' },
    });

    await expect(certified.execute(activation)).rejects.toMatchObject({
      code: 'plan-not-activated',
    });
    expect(adapter.calls).toEqual([]);
  });

  it('validates a file receipt through its original canonical repository after a symlink retarget', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'truecourse-certified-symlink-'));
    temporaryRepositories.push(parent);
    const firstRepository = path.join(parent, 'first');
    const secondRepository = path.join(parent, 'second');
    const alias = path.join(parent, 'alias');
    mkdirSync(firstRepository);
    mkdirSync(secondRepository);
    symlinkSync(firstRepository, alias);
    const adapter = new RecordingAdapter();
    const certified = certifyAnalyzeLlmRun({
      runId: 'retargeted-alias',
      journalKey: firstRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, 'retargeted-alias', alias);
    await dispatchAnalyzeRun(secondRepository, {
      kind: 'begin',
      runId: 'retargeted-alias',
      candidateAnalysisId: 'foreign-candidate',
      startedAt: '2026-07-19T00:00:00.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'abc123',
      completedBaselineId: 'completed-baseline',
    });
    await dispatchAnalyzeRun(secondRepository, {
      kind: 'seal-plan',
      execution: { provider: 'claude-code', requestedModel: 'opus[1m]' },
      runId: 'retargeted-alias',
      sealedAt: '2026-07-19T00:00:01.000Z',
      work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
        workId,
        inputFingerprint,
      })),
    });
    await dispatchAnalyzeRun(firstRepository, {
      kind: 'fail',
      runId: 'retargeted-alias',
      failedAt: '2026-07-19T00:00:02.000Z',
      error: { code: 'LLM_FAILED', message: 'Original journal became terminal.' },
    });
    unlinkSync(alias);
    symlinkSync(secondRepository, alias);

    await expect(certified.execute(activation)).rejects.toMatchObject({
      code: 'plan-not-activated',
    });
    expect(adapter.calls).toEqual([]);
  });

  it('rejects unverified provider identity and compiles full-file work before execution', async () => {
    const unverified: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({
        provider: 'transport:unverified',
        requestedModel: 'opus[1m]',
      }),
      async execute(work) { return outcomeFor(work); },
    };

    expect(() => certifyAnalyzeLlmRun({
      runId: 'unverified-provider',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, unverified)).toThrow(expect.objectContaining({ code: 'provider-not-certifiable' }));

    const adapter = new RecordingAdapter();
    const certified = certifyAnalyzeLlmRun({
      runId: 'live-read',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: fullFileCodeContext }],
    }, adapter);

    expect(certified.manifest.work).toEqual([expect.objectContaining({
      family: 'code',
      workId: expect.stringMatching(/^llm\.code:/),
    })]);
    await certified.execute(await activate(certified, 'inline-full-file'));
    expect(adapter.calls).toEqual([expect.objectContaining({
      family: 'code',
      planned: expect.objectContaining({
        request: expect.objectContaining({
          toolPolicy: 'none',
          sourceBindings: [{ promptPath: 'src/a.ts', runtimePath: '/repo/src/a.ts' }],
          prompt: expect.stringContaining('=== src/a.ts ===\n1: export const a = 1;'),
        }),
      }),
    })]);
  });

  it.each([
    { provider: ' claude-code', requestedModel: 'opus[1m]' },
    { provider: 'claude-code ', requestedModel: 'opus[1m]' },
    { provider: 'claude-code', requestedModel: '' },
    { provider: 'claude-code', requestedModel: ' opus[1m]' },
    { provider: 'claude-code', requestedModel: 'opus[1m] ' },
  ])('rejects execution intent that cannot be sealed and resumed: %j', (execution) => {
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution,
      async execute(work) { return outcomeFor(work); },
    };

    expect(() => certifyAnalyzeLlmRun({
      runId: 'invalid-execution-intent',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter)).toThrow(expect.objectContaining({ code: 'provider-not-certifiable' }));
  });

  it('revalidates provider intent after durable activation', async () => {
    let execution = { provider: 'claude-code', requestedModel: 'opus[1m]' };
    const calls: CertifiedAnalyzeLlmWork[] = [];
    const adapter: AnalyzeLlmExecutionAdapter = {
      get execution() { return execution; },
      async execute(work) { calls.push(work); return outcomeFor(work); },
    };
    const certified = certifyAnalyzeLlmRun({
      runId: 'provider-drift',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, 'provider-drift');
    execution = { provider: 'claude-code', requestedModel: 'sonnet' };

    await expect(certified.execute(activation)).rejects.toMatchObject({
      code: 'provider-not-certifiable',
    });
    expect(calls).toEqual([]);
    execution = { provider: 'claude-code', requestedModel: 'opus[1m]' };
    await expect(certified.execute(activation)).resolves.toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ result: { violations: [] } })]),
      completion: expect.any(Object),
    });
    expect(calls).toHaveLength(1);
  });

  it('does not issue an activation receipt when storage changes the sealed execution write', async () => {
    const repoKey = 'hosted:sealed-execution-write-drift';
    let stored: StoredAnalyzeRun | null = null;
    const storage: AnalyzeRunStorage = {
      async createLatest(_receivedRepoKey, run) {
        stored = { ...run, attemptSequence: 1 };
        return stored;
      },
      async read(_receivedRepoKey, runId) {
        return stored?.runId === runId ? stored : null;
      },
      async readLatest() { return stored; },
      async inspectLatest() { return stored; },
      async compareAndSwap(_receivedRepoKey, _runId, expectedRevision, next) {
        expect(stored).toMatchObject({ revision: expectedRevision });
        stored = expectedRevision === 0 && next.plan.state === 'sealed'
          ? {
              ...next,
              plan: {
                ...next.plan,
                execution: { provider: 'other-provider', requestedModel: 'other-model' },
              },
            }
          : next;
      },
      async compareAndSwapLatest(_receivedRepoKey, _runId, expectedRevision, _attempt, _latest, next) {
        expect(stored).toMatchObject({ revision: expectedRevision });
        stored = next;
      },
    };
    setAnalyzeRunStorage(storage);
    const adapter = new RecordingAdapter();
    const certified = certifyAnalyzeLlmRun({
      runId: 'sealed-execution-write-drift',
      journalKey: repoKey,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);

    await expect(activate(certified, 'sealed-execution-write-drift', repoKey))
      .rejects.toThrow(/sealed plan changed during activation/);
    expect(adapter.calls).toEqual([]);
  });

  it('revalidates provider intent after the durable admission write', async () => {
    const repoKey = 'hosted:provider-admission-drift';
    let stored: StoredAnalyzeRun | null = null;
    let releaseAdmission!: () => void;
    let markAdmissionStarted!: () => void;
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const admissionStarted = new Promise<void>((resolve) => { markAdmissionStarted = resolve; });
    const storage: AnalyzeRunStorage = {
      async createLatest(_receivedRepoKey, run) {
        stored = { ...run, attemptSequence: 1 };
        return stored;
      },
      async read(_receivedRepoKey, runId) {
        return stored?.runId === runId ? stored : null;
      },
      async readLatest() { return stored; },
      async inspectLatest() { return stored; },
      async compareAndSwap(_receivedRepoKey, _runId, expectedRevision, next) {
        if (expectedRevision === 1) {
          markAdmissionStarted();
          await admissionGate;
        }
        expect(stored).toMatchObject({ revision: expectedRevision });
        stored = next;
      },
      async compareAndSwapLatest(_receivedRepoKey, _runId, expectedRevision, _attempt, _latest, next) {
        expect(stored).toMatchObject({ revision: expectedRevision });
        stored = next;
      },
    };
    setAnalyzeRunStorage(storage);
    let execution = { provider: 'claude-code', requestedModel: 'opus[1m]' };
    const calls: CertifiedAnalyzeLlmWork[] = [];
    const adapter: AnalyzeLlmExecutionAdapter = {
      get execution() { return execution; },
      async execute(work) {
        calls.push(work);
        return { ok: true };
      },
    };
    const certified = certifyAnalyzeLlmRun({
      runId: 'provider-admission-drift',
      journalKey: repoKey,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, 'provider-admission-drift', repoKey);

    const result = certified.execute(activation);
    await admissionStarted;
    execution = { provider: 'claude-code', requestedModel: 'sonnet' };
    releaseAdmission();

    await expect(result).rejects.toMatchObject({ code: 'provider-not-certifiable' });
    expect(calls).toEqual([]);
    expect(stored).toMatchObject({ revision: 2, status: { state: 'running' } });
  });

  it('revalidates the sealed execution identity after the durable admission write', async () => {
    const repoKey = 'hosted:durable-execution-admission-drift';
    let stored: StoredAnalyzeRun | null = null;
    const storage: AnalyzeRunStorage = {
      async createLatest(_receivedRepoKey, run) {
        stored = { ...run, attemptSequence: 1 };
        return stored;
      },
      async read(_receivedRepoKey, runId) {
        return stored?.runId === runId ? stored : null;
      },
      async readLatest() { return stored; },
      async inspectLatest() { return stored; },
      async compareAndSwap(_receivedRepoKey, _runId, expectedRevision, next) {
        expect(stored).toMatchObject({ revision: expectedRevision });
        stored = expectedRevision === 1 && next.plan.state === 'sealed'
          ? {
              ...next,
              plan: {
                ...next.plan,
                execution: { provider: 'other-provider', requestedModel: 'opus[1m]' },
              },
            }
          : next;
      },
      async compareAndSwapLatest(_receivedRepoKey, _runId, expectedRevision, _attempt, _latest, next) {
        expect(stored).toMatchObject({ revision: expectedRevision });
        stored = next;
      },
    };
    setAnalyzeRunStorage(storage);
    const calls: CertifiedAnalyzeLlmWork[] = [];
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: { provider: 'claude-code', requestedModel: 'opus[1m]' },
      async execute(work) {
        calls.push(work);
        return outcomeFor(work);
      },
    };
    const certified = certifyAnalyzeLlmRun({
      runId: 'durable-execution-admission-drift',
      journalKey: repoKey,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, 'durable-execution-admission-drift', repoKey);

    await expect(certified.execute(activation)).rejects.toThrow(
      /sealed execution changed during provider admission/,
    );
    expect(calls).toEqual([]);
    expect(stored).toMatchObject({
      revision: 2,
      plan: { execution: { provider: 'other-provider' } },
    });
  });

  it('does not finalize after the certified sealed execution identity changes', async () => {
    const runId = 'completion-execution-drift';
    const certified = certifyAnalyzeLlmRun({
      runId,
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, new RecordingAdapter());
    const activation = await activate(certified, runId);
    const execution = await certified.execute(activation);
    const file = path.join(
      journalRepository,
      '.truecourse',
      'analyses',
      'runs',
      `${runId}.json`,
    );
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      plan: { execution: unknown };
    };
    stored.plan.execution = { provider: 'other-provider', requestedModel: 'opus[1m]' };
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    const before = readFileSync(file);

    await expect(beginFinalizeAnalyzeRun(journalRepository, {
      runId,
      finalizingAt: '2026-07-19T00:00:03.000Z',
    }, execution.completion)).rejects.toThrow(/does not certify.*current sealed plan/);
    expect(readFileSync(file)).toEqual(before);
  });

  it('drains admitted siblings before preserving the provider failure', async () => {
    const providerFailure = new Error('provider failed');
    let releaseCode!: () => void;
    const codeGate = new Promise<void>((resolve) => { releaseCode = resolve; });
    let codeDrained = false;
    const calls: CertifiedAnalyzeLlmWork[] = [];
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(work) {
        calls.push(work);
        if (work.family === 'code') {
          await codeGate;
          codeDrained = true;
          return outcomeFor(work);
        }
        throw providerFailure;
      },
    };
    const certified = certifyAnalyzeLlmRun({
      runId: 'drain-peers',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
      database: databaseContext,
    }, adapter);
    const activation = await activate(certified, 'drain-peers');
    let returned = false;
    const executionPromise = certified.execute(activation).finally(() => { returned = true; });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(returned).toBe(false);
    releaseCode();
    await expect(executionPromise).rejects.toBe(providerFailure);
    expect(codeDrained).toBe(true);
  });

  it('preserves a definite session limit over an ordinary sibling failure', async () => {
    const ordinaryFailure = new Error('ordinary provider failure');
    const sessionLimit = new LlmSessionLimitError('7pm');
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(work) {
        if (work.family === 'code') throw ordinaryFailure;
        throw sessionLimit;
      },
    };
    const certified = certifyAnalyzeLlmRun({
      runId: 'session-limit-precedence',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
      database: databaseContext,
    }, adapter);
    const activation = await activate(certified, 'session-limit-precedence');

    await expect(certified.execute(activation)).rejects.toBe(sessionLimit);
  });

  it('reports limiter admission and settlement for every certified work item', async () => {
    const providerFailure = new Error('queued work stopped by provider circuit');
    const progress: Array<{
      event: 'start' | 'done';
      family: CertifiedAnalyzeLlmWork['family'];
      started?: boolean;
      ok?: boolean;
    }> = [];
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(work, options?: { onStart?: () => void }) {
        if (work.family === 'code') {
          options?.onStart?.();
          return outcomeFor(work);
        }
        throw providerFailure;
      },
    };
    const certified = certifyAnalyzeLlmRun({
      runId: 'work-progress',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
      database: databaseContext,
    }, adapter);
    const activation = await activate(certified, 'work-progress');

    await expect(certified.execute(activation, {
      onWorkStart: (work) => progress.push({ event: 'start', family: work.family }),
      onWorkDone: (work, state) => progress.push({
        event: 'done', family: work.family, started: state.started, ok: state.ok,
      }),
    })).rejects.toBe(providerFailure);

    expect(progress).toEqual(expect.arrayContaining([
      { event: 'start', family: 'code' },
      { event: 'done', family: 'code', started: true, ok: true },
      { event: 'done', family: 'database', started: false, ok: false },
    ]));
    expect(progress).toHaveLength(3);
  });

  it('does not let a progress observer mask a provider session limit', async () => {
    const sessionLimit = new LlmSessionLimitError('7pm');
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({ provider: 'claude-code', requestedModel: 'opus[1m]' }),
      async execute(_work, options) {
        options?.onStart?.();
        throw sessionLimit;
      },
    };
    const certified = certifyAnalyzeLlmRun({
      runId: 'observer-session-limit',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, 'observer-session-limit');

    await expect(certified.execute(activation, {
      onWorkStart: async () => { throw new Error('start observer failed'); },
      onWorkDone: async () => { throw new Error('done observer failed'); },
    })).rejects.toBe(sessionLimit);
  });

  it('admits a durable activation receipt only once under concurrent execution', async () => {
    const adapter = new RecordingAdapter();
    const certified = certifyAnalyzeLlmRun({
      runId: 'concurrent-admission',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, adapter);
    const activation = await activate(certified, 'concurrent-admission');

    const outcomes = await Promise.allSettled([
      certified.execute(activation),
      certified.execute(activation),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(adapter.calls).toHaveLength(1);
  });
});
