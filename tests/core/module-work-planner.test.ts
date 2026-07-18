import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import {
  createLLMProvider,
  type ModuleViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import { planModuleViolationWork } from '../../packages/core/src/services/llm/module-work-planner.js';

const execution = {
  provider: 'claude-code',
  requestedModel: 'sonnet',
} as const;

function lifecycleContext(): ModuleViolationContext {
  return {
    modules: [{
      id: 'runtime-order-module',
      name: 'OrderHandler',
      kind: 'class',
      serviceId: 'runtime-orders-service',
      serviceName: 'orders-service',
      layerName: 'api',
      methodCount: 1,
      propertyCount: 0,
      importCount: 2,
      exportCount: 1,
      lineCount: 80,
    }, {
      id: 'runtime-payment-module',
      name: 'PaymentClient',
      kind: 'class',
      serviceId: 'runtime-payments-service',
      serviceName: 'payments-service',
      layerName: 'integration',
      methodCount: 1,
      propertyCount: 0,
      importCount: 1,
      exportCount: 1,
      lineCount: 45,
    }],
    methods: [{
      id: 'runtime-create-method',
      moduleName: 'OrderHandler',
      name: 'createOrder',
      signature: 'createOrder(input: OrderInput): Promise<Order>',
      paramCount: 1,
      returnType: 'Promise<Order>',
      isAsync: true,
      lineCount: 20,
      statementCount: 8,
      maxNestingDepth: 2,
    }, {
      id: 'runtime-charge-method',
      moduleName: 'PaymentClient',
      name: 'charge',
      signature: 'charge(order: Order): Promise<Receipt>',
      paramCount: 1,
      returnType: 'Promise<Receipt>',
      isAsync: true,
      lineCount: 12,
      statementCount: 4,
      maxNestingDepth: 1,
    }],
    moduleDependencies: [{
      sourceModule: 'OrderHandler',
      targetModule: 'PaymentClient',
      importedNames: ['Receipt', 'PaymentClient'],
    }],
    methodDependencies: [{
      callerMethod: 'createOrder',
      callerModule: 'OrderHandler',
      calleeMethod: 'charge',
      calleeModule: 'PaymentClient',
      callCount: 1,
    }],
    llmRules: [{
      key: 'module/llm/dependency-review',
      name: 'Dependency review',
      severity: 'high',
      prompt: 'Review module dependencies.',
    }, {
      key: 'module/llm/complexity-review',
      name: 'Complexity review',
      severity: 'medium',
      prompt: 'Review method complexity.',
    }],
    existingViolations: [{
      id: 'runtime-prior-a',
      type: 'module',
      title: 'Handler owns payment logic',
      content: 'The handler reaches directly into payments.',
      severity: 'high',
    }, {
      id: 'runtime-prior-b',
      type: 'function',
      title: 'Create order is complex',
      content: 'The method has too many responsibilities.',
      severity: 'medium',
    }],
  };
}

describe('module work planner', () => {
  it('keeps semantic identity and fingerprints stable across runtime IDs and input permutations', () => {
    const original = lifecycleContext();
    const permuted = lifecycleContext();
    permuted.modules[0].id = 'other-order-module-id';
    permuted.modules[0].serviceId = 'other-orders-service-id';
    permuted.modules[1].id = 'other-payment-module-id';
    permuted.modules[1].serviceId = 'other-payments-service-id';
    permuted.modules.reverse();
    permuted.methods[0].id = 'other-create-method-id';
    permuted.methods[1].id = 'other-charge-method-id';
    permuted.methods.reverse();
    permuted.moduleDependencies[0].importedNames.reverse();
    permuted.moduleDependencies.reverse();
    permuted.methodDependencies.reverse();
    permuted.llmRules.reverse();
    permuted.existingViolations![0].id = 'other-prior-a';
    permuted.existingViolations![1].id = 'other-prior-b';
    permuted.existingViolations!.reverse();

    const first = planModuleViolationWork(original, 'lifecycle', execution);
    const second = planModuleViolationWork(permuted, 'lifecycle', execution);

    expect(first.workId).toMatch(/^llm\.module:sha256:[a-f0-9]{64}$/);
    expect(first.inputFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.workId).toBe(second.workId);
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.request.prompt).toBe(second.request.prompt);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.componentFingerprints)).toBe(true);
  });

  it('separates stable scope from graph, baseline, rule, and rebinding-contract changes', () => {
    const original = planModuleViolationWork(lifecycleContext(), 'lifecycle', execution);

    const changedGraph = lifecycleContext();
    changedGraph.modules[0].propertyCount = 3;
    const graphPlan = planModuleViolationWork(changedGraph, 'lifecycle', execution);
    expect(graphPlan.workId).toBe(original.workId);
    expect(graphPlan.componentFingerprints.repository).not.toBe(original.componentFingerprints.repository);
    expect(graphPlan.inputFingerprint).not.toBe(original.inputFingerprint);

    const changedMethodDetail = lifecycleContext();
    changedMethodDetail.methods[0].lineCount = 10;
    const methodDetailPlan = planModuleViolationWork(changedMethodDetail, 'lifecycle', execution);
    expect(methodDetailPlan.workId).toBe(original.workId);
    expect(methodDetailPlan.componentFingerprints.repository).not.toBe(original.componentFingerprints.repository);

    const changedDependency = lifecycleContext();
    changedDependency.moduleDependencies[0].importedNames.push('PaymentError');
    const dependencyPlan = planModuleViolationWork(changedDependency, 'lifecycle', execution);
    expect(dependencyPlan.workId).toBe(original.workId);
    expect(dependencyPlan.componentFingerprints.repository).not.toBe(original.componentFingerprints.repository);

    const changedPrior = lifecycleContext();
    changedPrior.existingViolations![0].content = 'Changed completed-baseline evidence.';
    const priorPlan = planModuleViolationWork(changedPrior, 'lifecycle', execution);
    expect(priorPlan.workId).toBe(original.workId);
    expect(priorPlan.componentFingerprints.baseline).not.toBe(original.componentFingerprints.baseline);

    const changedRule = lifecycleContext();
    changedRule.llmRules[0].prompt = 'Use a stricter dependency policy.';
    const rulePlan = planModuleViolationWork(changedRule, 'lifecycle', execution);
    expect(rulePlan.workId).toBe(original.workId);
    expect(rulePlan.componentFingerprints.rules).not.toBe(original.componentFingerprints.rules);

    const withoutServiceBinding = lifecycleContext();
    delete withoutServiceBinding.modules[0].serviceId;
    const serviceBindingPlan = planModuleViolationWork(withoutServiceBinding, 'lifecycle', execution);
    expect(serviceBindingPlan.workId).toBe(original.workId);
    expect(serviceBindingPlan.componentFingerprints.repository).toBe(original.componentFingerprints.repository);
    expect(serviceBindingPlan.componentFingerprints.resultContract).not.toBe(original.componentFingerprints.resultContract);

    const withoutMethodBinding = lifecycleContext();
    delete withoutMethodBinding.methods[0].id;
    const methodBindingPlan = planModuleViolationWork(withoutMethodBinding, 'lifecycle', execution);
    expect(methodBindingPlan.workId).toBe(original.workId);
    expect(methodBindingPlan.componentFingerprints.repository).toBe(original.componentFingerprints.repository);
    expect(methodBindingPlan.componentFingerprints.request).not.toBe(original.componentFingerprints.request);
    expect(methodBindingPlan.componentFingerprints.resultContract).not.toBe(original.componentFingerprints.resultContract);

    const changedModuleScope = lifecycleContext();
    changedModuleScope.modules[0].name = 'FulfillmentHandler';
    expect(planModuleViolationWork(changedModuleScope, 'lifecycle', execution).workId)
      .not.toBe(original.workId);

    const changedMethodScope = lifecycleContext();
    changedMethodScope.methods[0].signature = 'createOrder(): Promise<Order>';
    expect(planModuleViolationWork(changedMethodScope, 'lifecycle', execution).workId)
      .not.toBe(original.workId);

    const changedRuleScope = lifecycleContext();
    changedRuleScope.llmRules[0].key = 'module/llm/different-scope';
    expect(planModuleViolationWork(changedRuleScope, 'lifecycle', execution).workId)
      .not.toBe(original.workId);
  });

  it('fingerprints mode, exact request/result contracts, provider, and requested model', () => {
    const context = lifecycleContext();
    const lifecycle = planModuleViolationWork(context, 'lifecycle', execution);
    const normal = planModuleViolationWork(context, 'normal', execution);

    expect(normal.workId).toBe(lifecycle.workId);
    expect(normal.componentFingerprints.configuration).not.toBe(lifecycle.componentFingerprints.configuration);
    expect(normal.componentFingerprints.request).not.toBe(lifecycle.componentFingerprints.request);
    expect(normal.componentFingerprints.resultContract).not.toBe(lifecycle.componentFingerprints.resultContract);
    expect(normal.inputFingerprint).not.toBe(lifecycle.inputFingerprint);

    const providerChanged = planModuleViolationWork(context, 'lifecycle', {
      provider: 'agent-mailbox',
      requestedModel: 'sonnet',
    });
    expect(providerChanged.componentFingerprints.execution).not.toBe(lifecycle.componentFingerprints.execution);

    const modelChanged = planModuleViolationWork(context, 'lifecycle', {
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
    expect(() => planModuleViolationWork(duplicatePriors, 'lifecycle', execution))
      .toThrow(/duplicate semantic prior findings/);

    const duplicateModules = lifecycleContext();
    duplicateModules.modules.push({
      ...structuredClone(duplicateModules.modules[0]),
      id: 'duplicate-runtime-module-id',
      serviceId: 'duplicate-runtime-service-id',
    });
    expect(() => planModuleViolationWork(duplicateModules, 'lifecycle', execution))
      .toThrow(/duplicate semantic modules/);

    const duplicateMethods = lifecycleContext();
    duplicateMethods.methods.push({
      ...structuredClone(duplicateMethods.methods[0]),
      id: 'duplicate-runtime-method-id',
    });
    expect(() => planModuleViolationWork(duplicateMethods, 'lifecycle', execution))
      .toThrow(/duplicate semantic methods/);
  });

  it('forwards stable identity metadata with a unique attempt ID through the real provider call', async () => {
    const context = lifecycleContext();
    const planned = planModuleViolationWork(context, 'normal', {
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
    });
    let captured: LlmRequest | undefined;
    const transport: LlmTransport = async (request) => {
      captured = request;
      return JSON.stringify({ violations: [] });
    };
    const provider = createLLMProvider(transport, 'sonnet');

    await provider.generateModuleViolations(context);

    expect(captured).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^llm\.module\.attempt:[a-f0-9-]{36}$/),
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      user: planned.request.prompt,
      schema: planned.request.schemaJson,
    }));
  });
});
