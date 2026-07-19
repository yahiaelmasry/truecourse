import { describe, expect, it } from 'vitest';
import type { LlmTransport } from '../../packages/shared/src/llm/transport.js';
import { ClaudeCodeProvider } from '../../packages/core/src/services/llm/cli-provider.js';
import {
  createLLMProvider,
  type CodeViolationContext,
  type DatabaseViolationContext,
  type ModuleViolationContext,
  type ServiceViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import type { CertifiedAnalyzeLlmWork } from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import { planCodeViolationWork } from '../../packages/core/src/services/llm/code-work-planner.js';
import { planDatabaseViolationWork } from '../../packages/core/src/services/llm/database-work-planner.js';
import { planModuleViolationWork } from '../../packages/core/src/services/llm/module-work-planner.js';
import { planServiceViolationWork } from '../../packages/core/src/services/llm/service-work-planner.js';

class AlternateCliProvider extends ClaudeCodeProvider {
  get providerId(): string { return 'alternate-cli'; }
}

const serviceContext: ServiceViolationContext = {
  architecture: 'distributed services',
  services: [{
    id: 'runtime-service-id',
    name: 'orders-service',
    type: 'backend',
    framework: 'express',
    fileCount: 3,
    layers: ['api', 'domain'],
  }],
  dependencies: [],
  llmRules: [{
    key: 'architecture/llm/service-review',
    name: 'Service review',
    severity: 'high',
    prompt: 'Review service boundaries.',
  }],
};

const databaseContext: DatabaseViolationContext = {
  databases: [{
    id: 'runtime-database-id',
    name: 'orders-db',
    type: 'postgres',
    driver: 'pg',
    tableCount: 0,
    connectedServices: ['orders-service'],
  }],
  llmRules: [{
    key: 'database/llm/schema-review',
    name: 'Schema review',
    severity: 'high',
    prompt: 'Review the database schema.',
  }],
};

const moduleContext: ModuleViolationContext = {
  modules: [{
    id: 'runtime-module-id',
    name: 'OrderHandler',
    kind: 'class',
    serviceId: 'runtime-service-id',
    serviceName: 'orders-service',
    layerName: 'api',
    methodCount: 0,
    propertyCount: 0,
    importCount: 0,
    exportCount: 1,
  }],
  methods: [],
  moduleDependencies: [],
  methodDependencies: [],
  llmRules: [{
    key: 'architecture/llm/module-review',
    name: 'Module review',
    severity: 'high',
    prompt: 'Review module boundaries.',
  }],
};

const codeContext: CodeViolationContext = {
  files: [{ path: 'context', content: '1: export const order = 1;' }],
  sourceScopes: [{ path: 'src/orders.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }],
  llmRules: [{
    key: 'bugs/llm/code-review',
    name: 'Code review',
    severity: 'high',
    prompt: 'Review the code.',
  }],
  tier: 'targeted',
};

function withPrior<T extends ServiceViolationContext | DatabaseViolationContext | ModuleViolationContext>(
  context: T,
): T {
  const lifecycle = structuredClone(context);
  lifecycle.existingViolations = [{
    id: 'runtime-prior-id',
    type: 'service',
    title: 'Prior issue',
    content: 'The prior issue remains relevant.',
    severity: 'high',
  }];
  return lifecycle;
}

function lifecycleCodeContext(): CodeViolationContext {
  const lifecycle = structuredClone(codeContext);
  lifecycle.existingViolations = [{
    id: 'runtime-prior-id',
    filePath: 'src/orders.ts',
    lineStart: 1,
    lineEnd: 1,
    ruleKey: 'bugs/llm/code-review',
    severity: 'high',
    title: 'Prior code issue',
    content: 'The prior code issue remains relevant.',
  }];
  return lifecycle;
}

describe('CLI certified analyze execution adapter', () => {
  it('exposes a certifiable intent only for direct Claude Code execution', () => {
    expect(new ClaudeCodeProvider(undefined, 'opus[1m]').execution).toEqual({
      provider: 'claude-code',
      requestedModel: 'opus[1m]',
    });
    expect(new AlternateCliProvider(undefined, 'alternate-model').execution).toEqual({
      provider: 'alternate-cli',
      requestedModel: 'alternate-model',
    });
  });

  it('executes every exact family/mode contract and returns correlated raw aliases', async () => {
    const resultsByStage: Record<string, unknown> = {
      'analyze.code': { violations: [] },
      'analyze.code-lifecycle': {
        resolvedViolationIds: [], unchangedViolationIds: ['cv-0'], newViolations: [],
      },
      'analyze.database': { violations: [] },
      'analyze.database-lifecycle': {
        resolvedViolationIds: [], unchangedViolationIds: ['prev-0'], newViolations: [],
      },
      'analyze.service': {
        violations: [], serviceDescriptions: [{ id: 'svc-0', description: 'Handles orders.' }],
      },
      'analyze.service-lifecycle': {
        resolvedViolationIds: [], unchangedViolationIds: ['prev-0'], newViolations: [],
        serviceDescriptions: [{ id: 'svc-0', description: 'Handles orders.' }],
      },
      'analyze.module': { violations: [] },
      'analyze.module-lifecycle': {
        resolvedViolationIds: [], unchangedViolationIds: ['prev-0'], newViolations: [],
      },
    };
    const transport: LlmTransport = async (request) =>
      JSON.stringify(resultsByStage[request.stage]);
    const provider = createLLMProvider(transport, 'sonnet');
    const execution = provider.execution;
    const plans = [
      ['code', 'bugs', 'normal', planCodeViolationWork(codeContext, execution)],
      ['code', 'bugs', 'lifecycle', planCodeViolationWork(lifecycleCodeContext(), execution)],
      ['database', 'database', 'normal', planDatabaseViolationWork(databaseContext, 'normal', execution)],
      ['database', 'database', 'lifecycle', planDatabaseViolationWork(withPrior(databaseContext), 'lifecycle', execution)],
      ['service', 'architecture', 'normal', planServiceViolationWork(serviceContext, 'normal', execution)],
      ['service', 'architecture', 'lifecycle', planServiceViolationWork(withPrior(serviceContext), 'lifecycle', execution)],
      ['module', 'architecture', 'normal', planModuleViolationWork(moduleContext, 'normal', execution)],
      ['module', 'architecture', 'lifecycle', planModuleViolationWork(withPrior(moduleContext), 'lifecycle', execution)],
    ] as const;
    const work = plans.map(([family, domain, mode, planned]) => Object.freeze({
      family,
      domain,
      mode,
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      planned,
    }) as CertifiedAnalyzeLlmWork);

    expect(execution).toEqual({
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
    });
    const started: string[] = [];
    const outcomes = await Promise.all(work.map((item) => provider.execute(item, {
      onStart: () => started.push(`${item.family}:${item.mode}`),
    })));
    expect(started.sort()).toEqual(work.map((item) => `${item.family}:${item.mode}`).sort());
    expect(outcomes.map(({ family, mode, resultContractId, result }) => ({
      family, mode, resultContractId, result,
    }))).toEqual(plans.map(([family, , mode, planned]) => ({
      family,
      mode,
      resultContractId: planned.request.resultContractId,
      result: resultsByStage[planned.request.stage],
    })));
  });
});
