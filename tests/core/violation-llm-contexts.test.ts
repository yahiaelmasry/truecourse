import { describe, expect, it } from 'vitest';
import {
  buildViolationLlmContexts,
  generateViolations,
  generateViolationsWithLifecycle,
  mergeViolationLlmResults,
  type ViolationGenerationInput,
} from '../../packages/core/src/services/violation.service.js';
import type {
  AllViolationsInput,
  LLMProvider,
} from '../../packages/core/src/services/llm/provider.js';

function input(): ViolationGenerationInput {
  return {
    architecture: 'distributed services',
    services: [{
      id: 'service-orders',
      name: 'orders',
      type: 'backend',
      framework: 'express',
      fileCount: 3,
      layerSummary: [{ layer: 'api' }, { layer: 'domain' }, { ignored: true }],
    }],
    dependencies: [{
      sourceServiceName: 'orders',
      targetServiceName: 'payments',
      dependencyCount: null,
      dependencyType: null,
    }],
    databases: [{
      id: 'database-orders',
      name: 'orders-db',
      type: 'postgresql',
      driver: 'pg',
      tableCount: 0,
      connectedServices: ['orders'],
    }],
    modules: [{
      id: 'module-handler',
      name: 'OrderHandler',
      kind: 'class',
      serviceName: 'orders',
      layerName: 'api',
      methodCount: 1,
      propertyCount: 0,
      importCount: 0,
      exportCount: 1,
    }],
    methods: [{
      id: 'method-create',
      moduleName: 'OrderHandler',
      name: 'create',
      signature: 'create(): void',
      paramCount: 0,
      isAsync: false,
    }],
    moduleDependencies: [],
    methodDependencies: [],
    llmRules: [
      { key: 'architecture/llm/service', name: 'Service', severity: 'high', prompt: 'service', category: 'service' },
      { key: 'database/llm/schema', name: 'Database', severity: 'medium', prompt: 'database', category: 'database' },
      { key: 'architecture/llm/module', name: 'Module', severity: 'low', prompt: 'module', category: 'module' },
      { key: 'bugs/llm/code', name: 'Code', severity: 'high', prompt: 'code', category: 'code' },
    ],
    existingServiceViolations: [{
      id: 'prior-service',
      type: 'service',
      title: 'Prior service issue',
      content: 'Still relevant.',
      severity: 'high',
    }],
    existingDatabaseViolations: [{
      id: 'prior-database',
      type: 'database',
      title: 'Prior database issue',
      content: 'Still relevant.',
      severity: 'medium',
    }],
    existingModuleViolations: [{
      id: 'prior-module',
      type: 'module',
      title: 'Prior module issue',
      content: 'Still relevant.',
      severity: 'low',
    }],
  };
}

describe('violation LLM context construction', () => {
  it('builds the same complete contexts before normal or lifecycle execution', () => {
    const normal = buildViolationLlmContexts(input(), 'normal');
    const lifecycle = buildViolationLlmContexts(input(), 'lifecycle');

    expect(normal.service).toEqual(expect.objectContaining({
      architecture: 'distributed services',
      services: [expect.objectContaining({
        id: 'service-orders',
        name: 'orders',
        layers: ['api', 'domain'],
      })],
      dependencies: [{ source: 'orders', target: 'payments', count: 0, type: undefined }],
      llmRules: [expect.objectContaining({ key: 'architecture/llm/service' })],
    }));
    expect(normal.database).toEqual(expect.objectContaining({
      databases: [expect.objectContaining({ id: 'database-orders' })],
      llmRules: [expect.objectContaining({ key: 'database/llm/schema' })],
    }));
    expect(normal.module).toEqual(expect.objectContaining({
      modules: [expect.objectContaining({
        id: 'module-handler',
        serviceId: 'service-orders',
      })],
      methods: [expect.objectContaining({ id: 'method-create' })],
      llmRules: [expect.objectContaining({ key: 'architecture/llm/module' })],
    }));
    expect(normal.service).not.toHaveProperty('existingViolations');
    expect(normal.database).not.toHaveProperty('existingViolations');
    expect(normal.module).not.toHaveProperty('existingViolations');

    expect(lifecycle.service.existingViolations).toEqual(input().existingServiceViolations);
    expect(lifecycle.database?.existingViolations).toEqual(input().existingDatabaseViolations);
    expect(lifecycle.module?.existingViolations).toEqual(input().existingModuleViolations);
  });

  it('omits optional database and module work when the repository has none', () => {
    const withoutOptionalWork = input();
    withoutOptionalWork.databases = [];
    withoutOptionalWork.modules = [];

    expect(buildViolationLlmContexts(withoutOptionalWork, 'normal')).toEqual(expect.objectContaining({
      database: undefined,
      module: undefined,
    }));
  });

  it('delegates normal and lifecycle execution with the exact prebuilt contexts', async () => {
    let normalInput: AllViolationsInput | undefined;
    let lifecycleInput: AllViolationsInput | undefined;
    const provider = {
      async generateAllViolations(contexts: AllViolationsInput) {
        normalInput = contexts;
        return {};
      },
      async generateAllViolationsWithLifecycle(contexts: AllViolationsInput) {
        lifecycleInput = contexts;
        return {
          resolvedViolationIds: [],
          unchangedViolationIds: [],
          newViolations: [],
          serviceDescriptions: [],
        };
      },
    } as LLMProvider;
    const generationInput = input();

    await generateViolations(generationInput, undefined, provider);
    await generateViolationsWithLifecycle(generationInput, undefined, provider);

    expect(normalInput).toEqual(expect.objectContaining(
      buildViolationLlmContexts(generationInput, 'normal'),
    ));
    expect(lifecycleInput).toEqual(expect.objectContaining(
      buildViolationLlmContexts(generationInput, 'lifecycle'),
    ));
  });
});

describe('violation LLM result merging', () => {
  it('combines family results and preserves valid graph targets', () => {
    const result = mergeViolationLlmResults(input(), {
      service: {
        violations: [{
          type: 'service',
          title: 'Service finding',
          content: 'Service content',
          severity: 'high',
          targetServiceId: 'service-orders',
        }],
        serviceDescriptions: [
          { id: 'service-orders', description: 'Orders service' },
        ],
      },
      database: {
        violations: [{
          type: 'database',
          title: 'Database finding',
          content: 'Database content',
          severity: 'medium',
          targetDatabaseId: 'database-orders',
        }],
      },
      module: {
        violations: [{
          type: 'module',
          title: 'Module finding',
          content: 'Module content',
          severity: 'low',
          targetServiceId: 'service-orders',
          targetModuleId: 'module-handler',
          targetMethodId: 'method-create',
        }],
      },
    });

    expect(result.violations).toHaveLength(3);
    expect(result.violations[0]).toMatchObject({ targetServiceId: 'service-orders' });
    expect(result.violations[1]).toMatchObject({ targetDatabaseId: 'database-orders' });
    expect(result.violations[2]).toMatchObject({
      targetServiceId: 'service-orders',
      targetModuleId: 'module-handler',
      targetMethodId: 'method-create',
    });
    expect(result.serviceDescriptions).toEqual([
      { id: 'service-orders', description: 'Orders service' },
    ]);
  });

  it('clears provider targets and descriptions outside the analyzed graph', () => {
    const result = mergeViolationLlmResults(input(), {
      service: {
        violations: [{
          type: 'service',
          title: 'Unknown service',
          content: 'Unknown target',
          severity: 'high',
          targetServiceId: 'service-foreign',
        }],
        serviceDescriptions: [
          { id: 'service-foreign', description: 'Foreign service' },
        ],
      },
      database: {
        violations: [{
          type: 'database',
          title: 'Unknown database',
          content: 'Unknown target',
          severity: 'medium',
          targetDatabaseId: 'database-foreign',
        }],
      },
      module: {
        violations: [{
          type: 'module',
          title: 'Unknown module',
          content: 'Unknown targets',
          severity: 'low',
          targetServiceId: 'service-foreign',
          targetModuleId: 'module-foreign',
          targetMethodId: 'method-foreign',
        }],
      },
    });

    expect(result.violations[0].targetServiceId).toBeUndefined();
    expect(result.violations[1].targetDatabaseId).toBeUndefined();
    expect(result.violations[2].targetServiceId).toBeUndefined();
    expect(result.violations[2].targetModuleId).toBeUndefined();
    expect(result.violations[2].targetMethodId).toBeUndefined();
    expect(result.serviceDescriptions).toEqual([]);
  });
});
