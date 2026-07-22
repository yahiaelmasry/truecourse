import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RuleDomain } from '../../packages/shared/src/index.js';
import {
  materializePlannedViolationResult,
  type MaterializedPlannedViolationResult,
  type PlannedViolationResultRequest,
} from '../../packages/core/src/services/llm/planned-violation-result.js';
import type {
  CertifiedAnalyzeLlmWork,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import { planCodeViolationWork } from '../../packages/core/src/services/llm/code-work-planner.js';
import { planDatabaseViolationWork } from '../../packages/core/src/services/llm/database-work-planner.js';
import { planModuleViolationWork } from '../../packages/core/src/services/llm/module-work-planner.js';
import { planServiceViolationWork } from '../../packages/core/src/services/llm/service-work-planner.js';
import type {
  CodeViolationContext,
  DatabaseViolationContext,
  ModuleViolationContext,
  ServiceViolationContext,
} from '../../packages/core/src/services/llm/provider.js';

const execution = { provider: 'claude-code', requestedModel: 'sonnet' } as const;
const rule = { key: 'architecture/llm/review', name: 'Review', severity: 'high', prompt: 'Review it.' };
const prior = { id: 'runtime-prior-id', type: 'service', title: 'Prior', content: 'Prior issue.', severity: 'high' };

const serviceContext: ServiceViolationContext = {
  architecture: 'services',
  services: [{
    id: 'runtime-service-id', name: 'orders', type: 'backend', fileCount: 1, layers: ['api'],
  }],
  dependencies: [],
  llmRules: [rule],
};

const databaseContext: DatabaseViolationContext = {
  databases: [{
    id: 'runtime-database-id', name: 'orders-db', type: 'postgres', driver: 'pg',
    tableCount: 0, connectedServices: ['orders'],
  }],
  llmRules: [{ ...rule, key: 'database/llm/review' }],
};

const moduleContext: ModuleViolationContext = {
  modules: [{
    id: 'runtime-module-id', name: 'OrderHandler', kind: 'class',
    serviceId: 'runtime-service-id', serviceName: 'orders', layerName: 'api',
    methodCount: 1, propertyCount: 0, importCount: 0, exportCount: 1,
  }],
  methods: [{
    id: 'runtime-method-id', moduleName: 'OrderHandler', name: 'handle',
    signature: 'handle(): void', paramCount: 0, isAsync: false,
  }],
  moduleDependencies: [],
  methodDependencies: [],
  llmRules: [rule],
};

const codeContext: CodeViolationContext = {
  files: [{ path: 'src/orders.ts', content: 'export const order = 1;' }],
  sourceScopes: [{ path: 'src/orders.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }],
  sources: [{
    path: 'src/orders.ts',
    selection: { kind: 'targeted', functions: [{ name: 'order', startLine: 1, endLine: 1 }] },
  }],
  llmRules: [{ ...rule, key: 'bugs/llm/review' }],
  tier: 'targeted',
};

function withPrior<T extends ServiceViolationContext | DatabaseViolationContext | ModuleViolationContext>(
  context: T,
): T {
  return { ...structuredClone(context), existingViolations: [prior] };
}

function lifecycleCodeContext(): CodeViolationContext {
  return {
    ...structuredClone(codeContext),
    existingViolations: [{
      id: 'runtime-prior-id', filePath: 'src/orders.ts', lineStart: 1, lineEnd: 1,
      ruleKey: 'bugs/llm/review', severity: 'high', title: 'Prior', content: 'Prior issue.',
    }],
  };
}

function certified(
  family: CertifiedAnalyzeLlmWork['family'],
  domain: RuleDomain,
  mode: CertifiedAnalyzeLlmWork['mode'],
  planned: CertifiedAnalyzeLlmWork['planned'],
): CertifiedAnalyzeLlmWork {
  return {
    family,
    domain,
    mode,
    workId: planned.workId,
    inputFingerprint: planned.inputFingerprint,
    planned,
  } as CertifiedAnalyzeLlmWork;
}

describe('planned violation result materialization', () => {
  it('keeps family, mode, plan, and mapped-result types correlated', () => {
    type ServiceNormal = Extract<PlannedViolationResultRequest, {
      family: 'service'; mode: 'normal';
    }>;
    type ServiceLifecycleOutput = Extract<MaterializedPlannedViolationResult, {
      family: 'service'; mode: 'lifecycle';
    }>;
    type InvalidServiceDatabasePair = Extract<ServiceNormal, {
      planned: ReturnType<typeof planDatabaseViolationWork>;
    }>;

    expectTypeOf<ServiceNormal['planned']['request']['resultContractId']>()
      .toEqualTypeOf<'analyze.service@1'>();
    expectTypeOf<ServiceLifecycleOutput['mode']>().toEqualTypeOf<'lifecycle'>();
    expectTypeOf<ServiceLifecycleOutput['result']>()
      .toHaveProperty('resolvedViolationIds');
    expectTypeOf<InvalidServiceDatabasePair>().toEqualTypeOf<never>();
  });

  it('rejects a certified mode that disagrees with the request contract', () => {
    const work = certified(
      'service',
      'architecture',
      'lifecycle',
      planServiceViolationWork(serviceContext, 'normal', execution),
    );

    expect(() => materializePlannedViolationResult(
      { work, result: { violations: [], serviceDescriptions: [] } },
      { createId: () => 'unused', createdAt: () => '2026-07-19T12:00:00.000Z' },
    )).toThrow(/mode lifecycle does not match analyze\.service@1/i);
  });

  it('rejects a request contract owned by a different work family', () => {
    const work = certified(
      'service',
      'architecture',
      'normal',
      planDatabaseViolationWork(databaseContext, 'normal', execution),
    );

    expect(() => materializePlannedViolationResult(
      { work, result: { violations: [] } },
      { createId: () => 'unused', createdAt: () => '2026-07-19T12:00:00.000Z' },
    )).toThrow(/service work cannot materialize result contract analyze\.database@1/i);
  });

  it('maps all eight certified family/mode contracts without replanning', () => {
    let nextId = 0;
    const options = {
      createId: () => `finding-${nextId++}`,
      createdAt: () => '2026-07-19T12:00:00.000Z',
    };
    const codeFinding = {
      ruleKey: 'bugs/llm/review', filePath: 'src/orders.ts', lineStart: 1, lineEnd: 1,
      severity: 'high', title: 'Code issue', content: 'Fix code.', fixPrompt: null,
    };
    const databaseFinding = {
      type: 'database' as const, title: 'DB issue', content: 'Fix database.', severity: 'high' as const,
      targetDatabaseId: 'db-0', targetTable: 'orders', fixPrompt: null,
      ruleKey: 'database/llm/review',
    };
    const serviceFinding = {
      type: 'service' as const, title: 'Service issue', content: 'Fix service.', severity: 'high' as const,
      targetServiceId: 'svc-0', targetModuleId: null, targetMethodId: null,
      targetServiceName: null, targetModuleName: null, targetMethodName: null,
      fixPrompt: null, ruleKey: 'architecture/llm/review',
    };
    const moduleFinding = {
      type: 'function' as const, title: 'Module issue', content: 'Fix module.', severity: 'high' as const,
      targetServiceId: null, targetModuleId: 'mod-0', targetMethodId: 'mth-0',
      targetServiceName: null, targetModuleName: null, targetMethodName: null,
      fixPrompt: null, ruleKey: 'architecture/llm/review',
    };

    const cases = [
      {
        work: certified('code', 'bugs', 'normal', planCodeViolationWork(codeContext, execution)),
        raw: { violations: [codeFinding] },
        expected: {
          family: 'code', mode: 'normal',
          result: { violations: [{ ...codeFinding, sourceTier: 'targeted' }] },
        },
      },
      {
        work: certified('code', 'bugs', 'lifecycle', planCodeViolationWork(lifecycleCodeContext(), execution)),
        raw: { resolvedViolationIds: [], unchangedViolationIds: ['cv-0'], newViolations: [codeFinding] },
        expected: {
          family: 'code', mode: 'lifecycle',
          result: {
            violations: [{ ...codeFinding, sourceTier: 'targeted' }],
            resolvedViolationIds: [], unchangedViolationIds: ['runtime-prior-id'],
          },
        },
      },
      {
        work: certified('database', 'database', 'normal', planDatabaseViolationWork(databaseContext, 'normal', execution)),
        raw: { violations: [databaseFinding] },
        expected: {
          family: 'database', mode: 'normal',
          result: { violations: [expect.objectContaining({
            id: 'finding-0', targetDatabaseId: 'runtime-database-id', createdAt: options.createdAt(),
          })] },
        },
      },
      {
        work: certified('database', 'database', 'lifecycle', planDatabaseViolationWork(withPrior(databaseContext), 'lifecycle', execution)),
        raw: { resolvedViolationIds: ['prev-0'], unchangedViolationIds: [], newViolations: [databaseFinding] },
        expected: {
          family: 'database', mode: 'lifecycle',
          result: {
            resolvedViolationIds: ['runtime-prior-id'], unchangedViolationIds: [],
            newViolations: [expect.objectContaining({ targetDatabaseId: 'runtime-database-id' })],
          },
        },
      },
      {
        work: certified('service', 'architecture', 'normal', planServiceViolationWork(serviceContext, 'normal', execution)),
        raw: { violations: [serviceFinding], serviceDescriptions: [{ id: 'svc-0', description: 'Orders.' }] },
        expected: {
          family: 'service', mode: 'normal',
          result: {
            violations: [expect.objectContaining({
              id: 'finding-1', targetServiceId: 'runtime-service-id', createdAt: options.createdAt(),
            })],
            serviceDescriptions: [{ id: 'runtime-service-id', description: 'Orders.' }],
          },
        },
      },
      {
        work: certified('service', 'architecture', 'lifecycle', planServiceViolationWork(withPrior(serviceContext), 'lifecycle', execution)),
        raw: {
          resolvedViolationIds: [], unchangedViolationIds: ['prev-0'], newViolations: [serviceFinding],
          serviceDescriptions: [{ id: 'svc-0', description: 'Orders.' }],
        },
        expected: {
          family: 'service', mode: 'lifecycle',
          result: {
            resolvedViolationIds: [], unchangedViolationIds: ['runtime-prior-id'],
            newViolations: [expect.objectContaining({ targetServiceId: 'runtime-service-id' })],
            serviceDescriptions: [{ id: 'runtime-service-id', description: 'Orders.' }],
          },
        },
      },
      {
        work: certified('module', 'architecture', 'normal', planModuleViolationWork(moduleContext, 'normal', execution)),
        raw: { violations: [moduleFinding] },
        expected: {
          family: 'module', mode: 'normal',
          result: { violations: [expect.objectContaining({
            id: 'finding-2', targetServiceId: 'runtime-service-id',
            targetModuleId: 'runtime-module-id', targetMethodId: 'runtime-method-id',
            createdAt: options.createdAt(),
          })] },
        },
      },
      {
        work: certified('module', 'architecture', 'lifecycle', planModuleViolationWork(withPrior(moduleContext), 'lifecycle', execution)),
        raw: { resolvedViolationIds: ['prev-0'], unchangedViolationIds: [], newViolations: [moduleFinding] },
        expected: {
          family: 'module', mode: 'lifecycle',
          result: {
            resolvedViolationIds: ['runtime-prior-id'], unchangedViolationIds: [],
            newViolations: [expect.objectContaining({
              targetServiceId: 'runtime-service-id', targetModuleId: 'runtime-module-id',
              targetMethodId: 'runtime-method-id',
            })],
          },
        },
      },
    ];

    for (const candidate of cases) {
      expect(materializePlannedViolationResult({
        work: candidate.work,
        result: candidate.raw,
      }, options)).toEqual(expect.objectContaining(candidate.expected));
    }
  });

  it('maps a prompt-local targeted code finding back to its runtime path', () => {
    const targetedPromptContext: CodeViolationContext = {
      ...codeContext,
      files: [{ path: 'context', content: '=== src/orders.ts (lines 1-1) ===\n1: export const order = 1;' }],
    };
    const work = certified('code', 'bugs', 'normal', planCodeViolationWork(targetedPromptContext, execution));

    const materialized = materializePlannedViolationResult(
      {
        work,
        result: {
          violations: [{
            ruleKey: 'bugs/llm/review', filePath: 'file-0', lineStart: 1, lineEnd: 1,
            severity: 'high', title: 'Code issue', content: 'Fix code.', fixPrompt: null,
          }],
        },
      },
      { createId: () => 'unused', createdAt: () => '2026-07-19T12:00:00.000Z' },
    );

    expect(materialized.result).toEqual({
      violations: [expect.objectContaining({ filePath: 'src/orders.ts' })],
    });
  });
});
