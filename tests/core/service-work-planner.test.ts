import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import {
  createLLMProvider,
  type ServiceViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import { planServiceViolationWork } from '../../packages/core/src/services/llm/service-work-planner.js';

const execution = {
  provider: 'claude-code',
  requestedModel: 'sonnet',
} as const;

function lifecycleContext(): ServiceViolationContext {
  return {
    architecture: 'distributed services',
    services: [{
      id: 'runtime-orders-service',
      name: 'orders-service',
      type: 'backend',
      framework: 'express',
      fileCount: 3,
      layers: ['domain', 'api'],
    }, {
      id: 'runtime-payments-service',
      name: 'payments-service',
      type: 'backend',
      framework: 'fastify',
      fileCount: 2,
      layers: ['integration'],
    }],
    dependencies: [{
      source: 'orders-service',
      target: 'payments-service',
      count: 2,
      type: 'http',
    }, {
      source: 'payments-service',
      target: 'orders-service',
      count: 1,
      type: 'events',
    }],
    llmRules: [{
      key: 'service/llm/boundary-review',
      name: 'Boundary review',
      severity: 'high',
      prompt: 'Review service boundaries.',
    }, {
      key: 'service/llm/dependency-review',
      name: 'Dependency review',
      severity: 'medium',
      prompt: 'Review service dependencies.',
    }],
    existingViolations: [{
      id: 'runtime-prior-a',
      type: 'service',
      title: 'Orders owns payment logic',
      content: 'Payment logic crosses the service boundary.',
      severity: 'high',
    }, {
      id: 'runtime-prior-b',
      type: 'service',
      title: 'Payments depends on orders',
      content: 'The dependency creates a cycle.',
      severity: 'medium',
    }],
  };
}

describe('service work planner', () => {
  it('keeps semantic identity and fingerprints stable across runtime IDs and input permutations', () => {
    const original = lifecycleContext();
    const permuted = lifecycleContext();
    permuted.services[0].id = 'other-orders-runtime-id';
    permuted.services[1].id = 'other-payments-runtime-id';
    permuted.services[0].layers.reverse();
    permuted.services.reverse();
    permuted.dependencies.reverse();
    permuted.llmRules.reverse();
    permuted.existingViolations![0].id = 'other-prior-a';
    permuted.existingViolations![1].id = 'other-prior-b';
    permuted.existingViolations!.reverse();

    const first = planServiceViolationWork(original, 'lifecycle', execution);
    const second = planServiceViolationWork(permuted, 'lifecycle', execution);

    expect(first.workId).toMatch(/^llm\.service:sha256:[a-f0-9]{64}$/);
    expect(first.inputFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.workId).toBe(second.workId);
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.request.prompt).toBe(second.request.prompt);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.componentFingerprints)).toBe(true);
  });

  it('separates stable scope from repository, baseline, and rule content changes', () => {
    const context = lifecycleContext();
    const original = planServiceViolationWork(context, 'lifecycle', execution);

    const changedArchitecture = lifecycleContext();
    changedArchitecture.architecture = 'event-driven services';
    const architecturePlan = planServiceViolationWork(changedArchitecture, 'lifecycle', execution);
    expect(architecturePlan.workId).toBe(original.workId);
    expect(architecturePlan.componentFingerprints.repository).not.toBe(original.componentFingerprints.repository);
    expect(architecturePlan.inputFingerprint).not.toBe(original.inputFingerprint);

    const changedDependency = lifecycleContext();
    changedDependency.dependencies[0].count = 3;
    const dependencyPlan = planServiceViolationWork(changedDependency, 'lifecycle', execution);
    expect(dependencyPlan.workId).toBe(original.workId);
    expect(dependencyPlan.componentFingerprints.repository).not.toBe(original.componentFingerprints.repository);

    const changedPrior = lifecycleContext();
    changedPrior.existingViolations![0].content = 'Changed completed-baseline evidence.';
    const priorPlan = planServiceViolationWork(changedPrior, 'lifecycle', execution);
    expect(priorPlan.workId).toBe(original.workId);
    expect(priorPlan.componentFingerprints.baseline).not.toBe(original.componentFingerprints.baseline);

    const changedRule = lifecycleContext();
    changedRule.llmRules[0].prompt = 'Use a stricter boundary policy.';
    const rulePlan = planServiceViolationWork(changedRule, 'lifecycle', execution);
    expect(rulePlan.workId).toBe(original.workId);
    expect(rulePlan.componentFingerprints.rules).not.toBe(original.componentFingerprints.rules);

    const changedServiceScope = lifecycleContext();
    changedServiceScope.services[0].name = 'fulfillment-service';
    expect(planServiceViolationWork(changedServiceScope, 'lifecycle', execution).workId)
      .not.toBe(original.workId);

    const changedRuleScope = lifecycleContext();
    changedRuleScope.llmRules[0].key = 'service/llm/different-scope';
    expect(planServiceViolationWork(changedRuleScope, 'lifecycle', execution).workId)
      .not.toBe(original.workId);
  });

  it('fingerprints method mode, exact request/result contracts, provider, and requested model', () => {
    const context = lifecycleContext();
    const lifecycle = planServiceViolationWork(context, 'lifecycle', execution);
    const normal = planServiceViolationWork(context, 'normal', execution);

    expect(normal.workId).toBe(lifecycle.workId);
    expect(normal.componentFingerprints.configuration).not.toBe(lifecycle.componentFingerprints.configuration);
    expect(normal.componentFingerprints.request).not.toBe(lifecycle.componentFingerprints.request);
    expect(normal.componentFingerprints.resultContract).not.toBe(lifecycle.componentFingerprints.resultContract);
    expect(normal.inputFingerprint).not.toBe(lifecycle.inputFingerprint);

    const providerChanged = planServiceViolationWork(context, 'lifecycle', {
      provider: 'agent-mailbox',
      requestedModel: 'sonnet',
    });
    expect(providerChanged.componentFingerprints.execution).not.toBe(lifecycle.componentFingerprints.execution);

    const modelChanged = planServiceViolationWork(context, 'lifecycle', {
      provider: 'claude-code',
      requestedModel: 'opus',
    });
    expect(modelChanged.componentFingerprints.execution).not.toBe(lifecycle.componentFingerprints.execution);
  });

  it('fails closed when duplicate semantics cannot receive stable aliases', () => {
    const duplicatePriors = lifecycleContext();
    duplicatePriors.existingViolations!.push({
      ...duplicatePriors.existingViolations![0],
      id: 'duplicate-runtime-prior-id',
    });
    expect(() => planServiceViolationWork(duplicatePriors, 'lifecycle', execution))
      .toThrow(/duplicate semantic prior findings/);

    const duplicateServices = lifecycleContext();
    duplicateServices.services.push({
      ...structuredClone(duplicateServices.services[0]),
      id: 'duplicate-runtime-service-id',
    });
    expect(() => planServiceViolationWork(duplicateServices, 'lifecycle', execution))
      .toThrow(/duplicate semantic services/);
  });

  it('rejects duplicate rule, target, and prior runtime identities', () => {
    const duplicateRules = lifecycleContext();
    duplicateRules.llmRules[1].key = duplicateRules.llmRules[0].key;
    expect(() => planServiceViolationWork(duplicateRules, 'lifecycle', execution))
      .toThrow(/duplicate rule key/);

    const duplicateServiceIds = lifecycleContext();
    duplicateServiceIds.services[1].id = duplicateServiceIds.services[0].id;
    expect(() => planServiceViolationWork(duplicateServiceIds, 'lifecycle', execution))
      .toThrow(/duplicate service runtime ID/);

    const duplicatePriorIds = lifecycleContext();
    duplicatePriorIds.existingViolations![1].id = duplicatePriorIds.existingViolations![0].id;
    expect(() => planServiceViolationWork(duplicatePriorIds, 'lifecycle', execution))
      .toThrow(/duplicate prior runtime ID/);
  });

  it('forwards stable identity metadata with a unique attempt ID through the real provider call', async () => {
    const context = lifecycleContext();
    const planned = planServiceViolationWork(context, 'normal', {
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
    });
    let captured: LlmRequest | undefined;
    const transport: LlmTransport = async (request) => {
      captured = request;
      return JSON.stringify({
        violations: [],
        serviceDescriptions: [],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');

    await provider.generateServiceViolations(context);

    expect(captured).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^llm\.service\.attempt:[a-f0-9-]{36}$/),
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      user: planned.request.prompt,
      schema: planned.request.schemaJson,
    }));
  });
});
