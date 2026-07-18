import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import {
  createLLMProvider,
  type ModuleViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import { prepareModuleViolationRequest } from '../../packages/core/src/services/llm/prepared-module-violation-request.js';

const RULE_KEY = 'module/llm/dependency-review';

function moduleContext(withPrior = false): ModuleViolationContext {
  return {
    modules: [{
      id: 'runtime-module-id',
      name: 'OrderHandler',
      kind: 'class',
      serviceId: 'runtime-service-id',
      serviceName: 'orders-service',
      layerName: 'api',
      methodCount: 1,
      propertyCount: 0,
      importCount: 2,
      exportCount: 1,
      lineCount: 80,
    }],
    methods: [{
      id: 'runtime-method-id',
      moduleName: 'OrderHandler',
      name: 'createOrder',
      signature: 'createOrder(input: OrderInput): Promise<Order>',
      paramCount: 1,
      returnType: 'Promise<Order>',
      isAsync: true,
      lineCount: 20,
      statementCount: 8,
      maxNestingDepth: 2,
    }],
    moduleDependencies: [{
      sourceModule: 'OrderHandler',
      targetModule: 'PaymentClient',
      importedNames: ['PaymentClient'],
    }],
    methodDependencies: [{
      callerMethod: 'createOrder',
      callerModule: 'OrderHandler',
      calleeMethod: 'charge',
      calleeModule: 'PaymentClient',
      callCount: 1,
    }],
    llmRules: [{
      key: RULE_KEY,
      name: 'Dependency review',
      severity: 'high',
      prompt: 'Review module dependencies.',
    }],
    existingViolations: withPrior ? [{
      id: 'runtime-prior-id',
      type: 'module',
      title: 'Handler owns payment logic',
      content: 'The handler reaches directly into payments.',
      severity: 'high',
    }] : undefined,
  };
}

describe('prepared module violation requests', () => {
  it('freezes a provider-independent lifecycle request, ownership snapshot, and runtime bindings', () => {
    const context = moduleContext(true);
    const prepared = prepareModuleViolationRequest(context, 'lifecycle');
    const originalPrompt = prepared.prompt;

    context.modules[0].id = 'mutated-module-id';
    context.modules[0].serviceId = 'mutated-service-id';
    context.methods[0].id = 'mutated-method-id';
    context.moduleDependencies[0].importedNames[0] = 'MutatedImport';
    context.llmRules[0].key = 'mutated/llm/rule';
    context.existingViolations![0].id = 'mutated-prior-id';
    context.existingViolations![0].title = 'Mutated prior title';

    expect(prepared).toEqual(expect.objectContaining({
      stage: 'analyze.module-lifecycle',
      label: 'module-lifecycle',
      responseFormat: 'json',
      toolPolicy: 'none',
      resultContractId: 'analyze.module-lifecycle@1',
      prompt: originalPrompt,
      bindings: [
        { promptId: 'mod-0', runtimeId: 'runtime-module-id' },
        { promptId: 'mth-0', runtimeId: 'runtime-method-id' },
        { promptId: 'prev-0', runtimeId: 'runtime-prior-id' },
      ],
      moduleServiceBindings: [{
        moduleRuntimeId: 'runtime-module-id',
        serviceRuntimeId: 'runtime-service-id',
      }],
    }));
    expect(prepared.schemaJson).toContain('unchangedViolationIds');
    expect(prepared.prompt).toContain('[id: mod-0]');
    expect(prepared.prompt).toContain('[id: mth-0]');
    expect(prepared.prompt).toContain('[id: prev-0]');
    expect(prepared.prompt).not.toContain('runtime-module-id');
    expect(prepared.prompt).not.toContain('runtime-method-id');
    expect(prepared.prompt).not.toContain('runtime-prior-id');
    expect(prepared.prompt).not.toContain('mutated');
    expect(prepared.ownership).toEqual(expect.objectContaining({
      moduleNames: ['OrderHandler'],
      methods: [{ moduleName: 'OrderHandler', name: 'createOrder' }],
      ruleKeys: [RULE_KEY],
      priorFindings: [expect.objectContaining({ title: 'Handler owns payment logic' })],
    }));
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.bindings)).toBe(true);
    expect(Object.isFrozen(prepared.moduleServiceBindings)).toBe(true);
    expect(Object.isFrozen(prepared.ownership)).toBe(true);
    expect(Object.isFrozen(prepared.ownership.methods[0])).toBe(true);
    expect(Object.isFrozen(prepared.ownership.priorFindings[0])).toBe(true);
  });

  it('makes the provider execute the exact prepared normal request with a unique attempt identity', async () => {
    const context = moduleContext(true);
    const expected = prepareModuleViolationRequest(context, 'normal');
    let captured: LlmRequest | undefined;
    const transport: LlmTransport = async (request) => {
      captured = request;
      return JSON.stringify({
        violations: [{
          type: 'function',
          title: 'Handler owns payment logic',
          content: 'The handler reaches directly into payments.',
          severity: 'high',
          targetModuleId: 'mod-0',
          targetMethodId: 'mth-0',
          fixPrompt: 'Move payment access behind an adapter.',
          ruleKey: RULE_KEY,
        }],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');

    await expect(provider.generateModuleViolations(context)).resolves.toEqual({
      violations: [expect.objectContaining({
        targetServiceId: 'runtime-service-id',
        targetModuleId: 'runtime-module-id',
        targetMethodId: 'runtime-method-id',
      })],
    });
    expect(captured).toEqual({
      id: expect.stringMatching(/^llm\.module\.attempt:[a-f0-9-]{36}$/),
      workId: undefined,
      inputFingerprint: undefined,
      stage: 'analyze.module',
      user: expected.prompt,
      system: expected.system,
      schema: expected.schemaJson,
      responseFormat: expected.responseFormat,
      model: 'sonnet',
      timeoutMs: expected.timeoutMs,
    });
  });

  it('maps an in-flight lifecycle result through the prepared binding snapshots', async () => {
    const context = moduleContext(true);
    const expected = prepareModuleViolationRequest(context, 'lifecycle');
    let captured: LlmRequest | undefined;
    let started!: () => void;
    let release!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const canFinish = new Promise<void>((resolve) => { release = resolve; });
    const transport: LlmTransport = async (request) => {
      captured = request;
      started();
      await canFinish;
      return JSON.stringify({
        resolvedViolationIds: [],
        unchangedViolationIds: ['prev-0'],
        newViolations: [{
          type: 'function',
          title: 'Handler owns payment logic',
          content: 'The handler reaches directly into payments.',
          severity: 'high',
          targetServiceId: null,
          targetModuleId: 'mod-0',
          targetMethodId: 'mth-0',
          targetServiceName: 'orders-service',
          targetModuleName: 'OrderHandler',
          targetMethodName: 'createOrder',
          fixPrompt: 'Move payment access behind an adapter.',
          ruleKey: RULE_KEY,
        }],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');
    const execution = provider.generateAllViolationsWithLifecycle({ module: context });

    await didStart;
    context.modules[0].id = 'mutated-module-id';
    context.modules[0].serviceId = 'mutated-service-id';
    context.methods[0].id = 'mutated-method-id';
    context.llmRules[0].key = 'mutated/llm/rule';
    context.existingViolations![0].id = 'mutated-prior-id';
    release();

    await expect(execution).resolves.toEqual({
      resolvedViolationIds: [],
      unchangedViolationIds: ['runtime-prior-id'],
      newViolations: [expect.objectContaining({
        targetServiceId: 'runtime-service-id',
        targetModuleId: 'runtime-module-id',
        targetMethodId: 'runtime-method-id',
        ruleKey: RULE_KEY,
      })],
      serviceDescriptions: [],
    });
    expect(captured).toEqual({
      id: expect.stringMatching(/^llm\.module\.attempt:[a-f0-9-]{36}$/),
      workId: undefined,
      inputFingerprint: undefined,
      stage: 'analyze.module-lifecycle',
      user: expected.prompt,
      system: expected.system,
      schema: expected.schemaJson,
      responseFormat: expected.responseFormat,
      model: 'sonnet',
      timeoutMs: expected.timeoutMs,
    });
  });
});
