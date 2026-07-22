import { describe, expect, it } from 'vitest';
import {
  mergeCertifiedArchitectureResults,
  selectCertifiedArchitectureContexts,
} from '../../packages/core/src/services/llm/certified-architecture-phase.js';
import type { CertifiedViolationPhaseResult } from '../../packages/core/src/services/llm/certified-violation-phase.js';
import type {
  ModuleViolationContext,
  ServiceViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import type { ViolationGenerationInput } from '../../packages/core/src/services/violation.service.js';

const serviceRule = {
  key: 'architecture/llm/service-test',
  name: 'Service test',
  severity: 'high' as const,
  prompt: 'Find service issues.',
};
const moduleRule = {
  key: 'architecture/llm/module-test',
  name: 'Module test',
  severity: 'medium' as const,
  prompt: 'Find module issues.',
};

function service(llmRules = [serviceRule]): ServiceViolationContext {
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
    llmRules,
  };
}

function module(llmRules = [moduleRule]): ModuleViolationContext {
  return {
    modules: [{
      id: 'module-orders',
      name: 'Orders',
      kind: 'class',
      serviceId: 'service-orders',
      serviceName: 'orders',
      layerName: 'application',
      methodCount: 1,
      propertyCount: 0,
      importCount: 0,
      exportCount: 1,
    }],
    methods: [{
      id: 'method-create',
      moduleName: 'Orders',
      name: 'create',
      signature: 'create(): void',
      paramCount: 0,
      isAsync: false,
    }],
    moduleDependencies: [],
    methodDependencies: [],
    llmRules,
  };
}

function generationInput(): ViolationGenerationInput {
  return {
    architecture: 'modular monolith',
    services: [{
      id: 'service-orders',
      name: 'orders',
      type: 'backend',
      framework: 'express',
      fileCount: 1,
      layerSummary: [{ layer: 'application' }],
    }],
    dependencies: [],
    databases: [],
    modules: [{
      id: 'module-orders',
      name: 'Orders',
      kind: 'class',
      serviceName: 'orders',
      layerName: 'application',
      methodCount: 1,
      propertyCount: 0,
      importCount: 0,
      exportCount: 1,
    }],
    methods: [{
      id: 'method-create',
      moduleName: 'Orders',
      name: 'create',
      signature: 'create(): void',
      paramCount: 0,
      isAsync: false,
    }],
    moduleDependencies: [],
    methodDependencies: [],
    llmRules: [serviceRule, moduleRule],
  };
}

function phase(
  results: CertifiedViolationPhaseResult['results'],
): CertifiedViolationPhaseResult {
  return {
    runId: 'run-1',
    results,
    completion: {} as CertifiedViolationPhaseResult['completion'],
  };
}

describe('certified architecture family selection', () => {
  it('omits a disabled module family while retaining service work', () => {
    expect(selectCertifiedArchitectureContexts({
      service: service(),
      module: module([]),
    })).toEqual({ service: service(), module: undefined });
  });

  it('omits a disabled service family while retaining module work', () => {
    expect(selectCertifiedArchitectureContexts({
      service: service([]),
      module: module(),
    })).toEqual({ service: undefined, module: module() });
  });

  it('returns no eligible phase when neither aggregate family owns a rule', () => {
    expect(selectCertifiedArchitectureContexts({
      service: service([]),
      module: module([]),
    })).toBeNull();
  });
});

describe('certified architecture result merging', () => {
  it('supports a normal module-only certified result', () => {
    const result = mergeCertifiedArchitectureResults(generationInput(), phase([{
      family: 'module',
      domain: 'architecture',
      mode: 'normal',
      workId: 'module-work',
      inputFingerprint: 'module-input',
      result: {
        violations: [{
          type: 'module',
          title: 'Module finding',
          content: 'Keep module boundaries explicit.',
          severity: 'medium',
          targetServiceId: 'service-orders',
          targetModuleId: 'module-orders',
          targetMethodId: 'method-create',
        }],
      },
    }]), 'normal');

    expect(result).toMatchObject({
      violations: [expect.objectContaining({
        targetServiceId: 'service-orders',
        targetModuleId: 'module-orders',
        targetMethodId: 'method-create',
      })],
      serviceDescriptions: [],
    });
  });

  it('merges mixed lifecycle modes and clears targets outside the graph', () => {
    const result = mergeCertifiedArchitectureResults(generationInput(), phase([
      {
        family: 'service',
        domain: 'architecture',
        mode: 'normal',
        workId: 'service-work',
        inputFingerprint: 'service-input',
        result: {
          violations: [{
            type: 'service',
            title: 'Unknown service',
            content: 'Unknown target.',
            severity: 'high',
            targetServiceId: 'service-foreign',
          }],
          serviceDescriptions: [{ id: 'service-foreign', description: 'Foreign' }],
        },
      },
      {
        family: 'module',
        domain: 'architecture',
        mode: 'lifecycle',
        workId: 'module-work',
        inputFingerprint: 'module-input',
        result: {
          resolvedViolationIds: [],
          unchangedViolationIds: [],
          newViolations: [{
            type: 'module',
            title: 'Unknown module',
            content: 'Unknown target.',
            severity: 'medium',
            targetServiceId: 'service-foreign',
            targetModuleId: 'module-foreign',
            targetMethodId: 'method-foreign',
            targetServiceName: null,
            targetModuleName: null,
            targetMethodName: null,
            fixPrompt: null,
            ruleKey: 'architecture/llm/module-test',
          }],
        },
      },
    ]), 'lifecycle');

    expect(result).toMatchObject({
      serviceDescriptions: [],
      newViolations: [
        expect.objectContaining({ title: 'Unknown service', targetServiceId: null }),
        expect.objectContaining({
          title: 'Unknown module',
          targetServiceId: null,
          targetModuleId: null,
          targetMethodId: null,
        }),
      ],
    });
  });
});
