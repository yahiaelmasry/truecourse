import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import { ClaudeCodeProvider } from '../../packages/core/src/services/llm/cli-provider.js';
import type { ModuleViolationContext } from '../../packages/core/src/services/llm/provider.js';
import type { PreparedModuleViolationRequest } from '../../packages/core/src/services/llm/prepared-module-violation-request.js';
import {
  planModuleViolationWork,
  type PlannedModuleViolationWork,
} from '../../packages/core/src/services/llm/module-work-planner.js';

const RULE_KEY = 'module/llm/dependency-review';

function moduleContext(mode: 'normal' | 'lifecycle'): ModuleViolationContext {
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
      importCount: 1,
      exportCount: 1,
    }],
    methods: [{
      id: 'runtime-method-id',
      moduleName: 'OrderHandler',
      name: 'createOrder',
      signature: 'createOrder(): void',
      paramCount: 0,
      isAsync: false,
    }],
    moduleDependencies: [],
    methodDependencies: [],
    llmRules: [{
      key: RULE_KEY,
      name: 'Dependency review',
      severity: 'high',
      prompt: 'Review module dependencies.',
    }],
    existingViolations: mode === 'lifecycle' ? [{
      id: 'runtime-prior-id',
      type: 'module',
      title: 'Handler owns payment logic',
      content: 'The handler reaches directly into payments.',
      severity: 'high',
    }] : undefined,
  };
}

class PlannedModuleProvider extends ClaudeCodeProvider {
  executePlannedModuleForTest(
    planned: PlannedModuleViolationWork<PreparedModuleViolationRequest>,
  ) {
    return this.executePlannedModuleViolationWork(planned);
  }
}

describe('planned module violation execution', () => {
  it.each(['normal', 'lifecycle'] as const)(
    'executes the exact certified %s request without rebuilding source context',
    async (mode) => {
      const context = moduleContext(mode);
      const planned = planModuleViolationWork(context, mode, {
        provider: 'transport:unverified',
        requestedModel: 'sonnet',
      });
      const rawResult = mode === 'lifecycle'
        ? {
            resolvedViolationIds: [],
            unchangedViolationIds: ['prev-0'],
            newViolations: [],
          }
        : { violations: [] };
      let captured: LlmRequest | undefined;
      const transport: LlmTransport = async (request) => {
        captured = request;
        return JSON.stringify(rawResult);
      };
      const provider = new PlannedModuleProvider(transport, 'sonnet');

      context.modules[0].id = 'mutated-module-id';
      context.modules[0].serviceId = 'mutated-service-id';
      context.methods[0].id = 'mutated-method-id';
      context.llmRules[0].key = 'mutated/llm/rule';
      if (context.existingViolations) context.existingViolations[0].id = 'mutated-prior-id';

      await expect(provider.executePlannedModuleForTest(planned)).resolves.toEqual(rawResult);
      expect(captured).toEqual({
        id: expect.stringMatching(/^llm\.module\.attempt:[a-f0-9-]{36}$/),
        workId: planned.workId,
        inputFingerprint: planned.inputFingerprint,
        stage: planned.request.stage,
        user: planned.request.prompt,
        system: planned.request.system,
        schema: planned.request.schemaJson,
        responseFormat: planned.request.responseFormat,
        model: 'sonnet',
        timeoutMs: planned.request.timeoutMs,
      });
      expect(captured?.user).not.toContain('mutated');
    },
  );
});
