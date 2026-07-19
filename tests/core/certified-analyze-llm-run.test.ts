import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
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
  dispatchAnalyzeRun,
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
    return outcomeFor(work, { ok: true });
  }
}

function outcomeFor(
  work: CertifiedAnalyzeLlmWork,
  result: unknown,
): AnalyzeLlmExecutionOutcome {
  return {
    family: work.family,
    domain: work.domain,
    mode: work.mode,
    workId: work.workId,
    inputFingerprint: work.inputFingerprint,
    resultContractId: work.planned.request.resultContractId,
    result,
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
    runId,
    sealedAt: '2026-07-19T00:00:01.000Z',
    work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    })),
  });
}

describe('certified analyze LLM run', () => {
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
    expect(executionResults.map(({ result }) => result)).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
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
    await expect(certified.execute(activation)).resolves.toHaveLength(1);
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
    await expect(first.execute(activation)).resolves.toHaveLength(1);
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
    await expect(rightful.execute(foreignActivation)).resolves.toHaveLength(1);
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

  it('rejects unverified provider identity and read-enabled work before execution', () => {
    const unverified: AnalyzeLlmExecutionAdapter = {
      execution: Object.freeze({
        provider: 'transport:unverified',
        requestedModel: 'opus[1m]',
      }),
      async execute(work) { return outcomeFor(work, { ok: true }); },
    };

    expect(() => certifyAnalyzeLlmRun({
      runId: 'unverified-provider',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: codeContext }],
    }, unverified)).toThrow(expect.objectContaining({ code: 'provider-not-certifiable' }));

    expect(() => certifyAnalyzeLlmRun({
      runId: 'live-read',
      journalKey: journalRepository,
      repositoryRoot: '/repo',
      code: [{ domain: 'bugs', context: fullFileCodeContext }],
    }, new RecordingAdapter())).toThrow(expect.objectContaining({
      code: 'read-snapshot-unavailable',
      family: 'code',
    }));
  });

  it('revalidates provider intent after durable activation', async () => {
    let execution = { provider: 'claude-code', requestedModel: 'opus[1m]' };
    const calls: CertifiedAnalyzeLlmWork[] = [];
    const adapter: AnalyzeLlmExecutionAdapter = {
      get execution() { return execution; },
      async execute(work) { calls.push(work); return outcomeFor(work, { ok: true }); },
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
    await expect(certified.execute(activation)).resolves.toHaveLength(1);
    expect(calls).toHaveLength(1);
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
      async compareAndSwap(_receivedRepoKey, _runId, expectedRevision, next) {
        if (expectedRevision === 1) {
          markAdmissionStarted();
          await admissionGate;
        }
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
          return outcomeFor(work, { ok: true });
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
