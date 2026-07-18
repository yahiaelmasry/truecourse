import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import {
  createLLMProvider,
  type ServiceViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import { prepareServiceViolationRequest } from '../../packages/core/src/services/llm/prepared-service-violation-request.js';

const RULE_KEY = 'service/llm/architecture-review';

function serviceContext(withPrior = false): ServiceViolationContext {
  return {
    architecture: 'distributed services',
    services: [{
      id: 'runtime-service-id',
      name: 'orders-service',
      type: 'backend',
      framework: 'express',
      fileCount: 3,
      layers: ['api', 'domain'],
    }],
    dependencies: [{
      source: 'orders-service',
      target: 'payments-service',
      count: 2,
      type: 'http',
    }],
    llmRules: [{
      key: RULE_KEY,
      name: 'Architecture review',
      severity: 'high',
      prompt: 'Review service boundaries.',
    }],
    existingViolations: withPrior ? [{
      id: 'runtime-prior-id',
      type: 'service',
      title: 'Orders owns payment logic',
      content: 'Payment logic crosses the service boundary.',
      severity: 'high',
    }] : undefined,
  };
}

describe('prepared service violation requests', () => {
  it('freezes a provider-independent lifecycle request, ownership snapshot, and runtime bindings', () => {
    const context = serviceContext(true);
    const prepared = prepareServiceViolationRequest(context, 'lifecycle');
    const originalPrompt = prepared.prompt;

    context.architecture = 'mutated architecture';
    context.services[0].id = 'mutated-service-id';
    context.services[0].layers[0] = 'mutated-layer';
    context.dependencies[0].target = 'mutated-target';
    context.llmRules[0].key = 'mutated/llm/rule';
    context.existingViolations![0].id = 'mutated-prior-id';
    context.existingViolations![0].title = 'Mutated prior title';

    expect(prepared).toEqual(expect.objectContaining({
      stage: 'analyze.service-lifecycle',
      label: 'service-lifecycle',
      responseFormat: 'json',
      toolPolicy: 'none',
      resultContractId: 'analyze.service-lifecycle@1',
      prompt: originalPrompt,
      bindings: [
        { promptId: 'svc-0', runtimeId: 'runtime-service-id' },
        { promptId: 'prev-0', runtimeId: 'runtime-prior-id' },
      ],
    }));
    expect(prepared.schemaJson).toContain('unchangedViolationIds');
    expect(prepared.prompt).toContain('[id: svc-0]');
    expect(prepared.prompt).toContain('[id: prev-0]');
    expect(prepared.prompt).not.toContain('runtime-service-id');
    expect(prepared.prompt).not.toContain('runtime-prior-id');
    expect(prepared.prompt).not.toContain('mutated');
    expect(prepared.ownership).toEqual(expect.objectContaining({
      architecture: 'distributed services',
      serviceNames: ['orders-service'],
      ruleKeys: [RULE_KEY],
      priorFindings: [expect.objectContaining({ title: 'Orders owns payment logic' })],
    }));
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.bindings)).toBe(true);
    expect(Object.isFrozen(prepared.ownership)).toBe(true);
    expect(Object.isFrozen(prepared.ownership.priorFindings[0])).toBe(true);
  });

  it('makes the provider execute the exact prepared normal request with a unique attempt identity', async () => {
    const context = serviceContext(true);
    const expected = prepareServiceViolationRequest(context, 'normal');
    let captured: LlmRequest | undefined;
    const transport: LlmTransport = async (request) => {
      captured = request;
      return JSON.stringify({
        violations: [{
          type: 'service',
          title: 'Orders owns payment logic',
          content: 'Payment logic crosses the service boundary.',
          severity: 'high',
          targetServiceId: 'svc-0',
          fixPrompt: 'Move the payment logic.',
          ruleKey: RULE_KEY,
        }],
        serviceDescriptions: [{
          id: 'svc-0',
          description: 'Handles orders.',
        }],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');

    await expect(provider.generateServiceViolations(context)).resolves.toEqual({
      violations: [expect.objectContaining({ targetServiceId: 'runtime-service-id' })],
      serviceDescriptions: [{
        id: 'runtime-service-id',
        description: 'Handles orders.',
      }],
    });
    expect(captured).toEqual({
      id: expect.stringMatching(/^llm\.service\.attempt:[a-f0-9-]{36}$/),
      workId: undefined,
      inputFingerprint: undefined,
      stage: 'analyze.service',
      user: expected.prompt,
      system: expected.system,
      schema: expected.schemaJson,
      responseFormat: expected.responseFormat,
      model: 'sonnet',
      timeoutMs: expected.timeoutMs,
    });
  });

  it('maps an in-flight lifecycle result through the prepared binding snapshot', async () => {
    const context = serviceContext(true);
    const expected = prepareServiceViolationRequest(context, 'lifecycle');
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
          type: 'service',
          title: 'Orders calls payments directly',
          content: 'The dependency bypasses the expected integration seam.',
          severity: 'high',
          targetServiceId: 'svc-0',
          targetModuleId: null,
          targetMethodId: null,
          targetServiceName: 'orders-service',
          targetModuleName: null,
          targetMethodName: null,
          fixPrompt: 'Route payment calls through the integration adapter.',
          ruleKey: RULE_KEY,
        }],
        serviceDescriptions: [{
          id: 'svc-0',
          description: 'Handles orders.',
        }],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');
    const execution = provider.generateAllViolationsWithLifecycle({ service: context });

    await didStart;
    context.services[0].id = 'mutated-service-id';
    context.services[0].name = 'mutated-service';
    context.llmRules[0].key = 'mutated/llm/rule';
    context.existingViolations![0].id = 'mutated-prior-id';
    release();

    await expect(execution).resolves.toEqual({
      resolvedViolationIds: [],
      unchangedViolationIds: ['runtime-prior-id'],
      newViolations: [expect.objectContaining({
        targetServiceId: 'runtime-service-id',
        ruleKey: RULE_KEY,
      })],
      serviceDescriptions: [{
        id: 'runtime-service-id',
        description: 'Handles orders.',
      }],
    });
    expect(captured).toEqual({
      id: expect.stringMatching(/^llm\.service\.attempt:[a-f0-9-]{36}$/),
      workId: undefined,
      inputFingerprint: undefined,
      stage: 'analyze.service-lifecycle',
      user: expected.prompt,
      system: expected.system,
      schema: expected.schemaJson,
      responseFormat: expected.responseFormat,
      model: 'sonnet',
      timeoutMs: expected.timeoutMs,
    });
  });
});
