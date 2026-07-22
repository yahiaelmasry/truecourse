import { describe, expect, it } from 'vitest';
import type { AnalysisRule } from '@truecourse/shared';
import {
  fingerprintCertifiedAnalysisInputs,
} from '../../packages/core/src/services/llm/certified-analysis-input-fingerprint.js';
import { planModuleViolationWork } from '../../packages/core/src/services/llm/module-work-planner.js';
import type {
  ModuleViolationContext,
  ServiceViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import { planServiceViolationWork } from '../../packages/core/src/services/llm/service-work-planner.js';

const execution = { provider: 'claude-code', requestedModel: 'sonnet' } as const;
const baseRule: AnalysisRule = {
  key: 'architecture/deterministic/example',
  category: 'service',
  domain: 'architecture',
  name: 'Example rule',
  description: 'Example deterministic rule',
  enabled: true,
  severity: 'medium',
  type: 'deterministic',
};
const secondRule: AnalysisRule = {
  ...baseRule,
  key: 'architecture/llm/second',
  name: 'Second rule',
  type: 'llm',
  prompt: 'Review the architecture.',
};

function fingerprint(overrides: Partial<Parameters<typeof fingerprintCertifiedAnalysisInputs>[0]> = {}) {
  return fingerprintCertifiedAnalysisInputs({
    enabledCategories: ['architecture', 'bugs'],
    enableLlmRules: true,
    disabledRules: ['disabled/b', 'disabled/a'],
    rules: [baseRule, secondRule],
    ...overrides,
  });
}

describe('certified analysis input fingerprint', () => {
  it('is stable across non-semantic category, disabled-rule, and rule ordering', () => {
    expect(fingerprint()).toBe(fingerprint({
      enabledCategories: ['bugs', 'architecture'],
      disabledRules: ['disabled/a', 'disabled/b'],
      rules: [secondRule, baseRule],
    }));
  });

  it.each([
    ['enabled categories', { enabledCategories: ['architecture'] }],
    ['LLM enablement', { enableLlmRules: false }],
    ['disabled rules', { disabledRules: ['disabled/a'] }],
    ['rule engine', { rules: [{ ...baseRule, engine: 'roslyn-host' }, secondRule] }],
    ['rule context', {
      rules: [{
        ...baseRule,
        contextRequirement: { tier: 'targeted', fileFilter: { hasDbCalls: true } },
      }, secondRule],
    }],
    ['language support', {
      rules: [{
        ...baseRule,
        languageSupport: {
          javascript: { status: 'supported' },
          python: { status: 'unsupported', reason: 'fixture' },
          csharp: { status: 'unsupported', reason: 'fixture' },
        },
      }, secondRule],
    }],
    ['rule severity', { rules: [{ ...baseRule, severity: 'high' }, secondRule] }],
    ['LLM prompt', { rules: [baseRule, { ...secondRule, prompt: 'Changed prompt.' }] }],
  ] as const)('changes when %s changes', (_case, overrides) => {
    expect(fingerprint(overrides)).not.toBe(fingerprint());
  });

  it('threads the run-wide fingerprint through aggregate work identity', () => {
    const service: ServiceViolationContext = {
      architecture: 'services',
      services: [{
        id: 'orders',
        name: 'orders',
        type: 'backend',
        fileCount: 1,
        layers: ['api'],
      }],
      dependencies: [],
      llmRules: [{
        key: 'architecture/llm/service',
        name: 'Service rule',
        severity: 'medium',
        prompt: 'Review services.',
      }],
    };
    const module: ModuleViolationContext = {
      modules: [{
        id: 'orders-module',
        name: 'OrdersModule',
        kind: 'class',
        serviceName: 'orders',
        layerName: 'api',
        methodCount: 1,
        propertyCount: 0,
        importCount: 0,
        exportCount: 1,
      }],
      methods: [],
      moduleDependencies: [],
      methodDependencies: [],
      llmRules: [{
        key: 'architecture/llm/module',
        name: 'Module rule',
        severity: 'medium',
        prompt: 'Review modules.',
      }],
    };

    const firstService = planServiceViolationWork(
      { ...service, analysisInputFingerprint: 'sha256:first' },
      'normal',
      execution,
    );
    const secondService = planServiceViolationWork(
      { ...service, analysisInputFingerprint: 'sha256:second' },
      'normal',
      execution,
    );
    const firstModule = planModuleViolationWork(
      { ...module, analysisInputFingerprint: 'sha256:first' },
      'normal',
      execution,
    );
    const secondModule = planModuleViolationWork(
      { ...module, analysisInputFingerprint: 'sha256:second' },
      'normal',
      execution,
    );

    expect(secondService.componentFingerprints.configuration)
      .not.toBe(firstService.componentFingerprints.configuration);
    expect(secondService.workId).toBe(firstService.workId);
    expect(secondService.inputFingerprint).not.toBe(firstService.inputFingerprint);
    expect(secondModule.componentFingerprints.configuration)
      .not.toBe(firstModule.componentFingerprints.configuration);
    expect(secondModule.workId).toBe(firstModule.workId);
    expect(secondModule.inputFingerprint).not.toBe(firstModule.inputFingerprint);
  });
});
