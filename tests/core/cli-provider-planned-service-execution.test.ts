import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import { ClaudeCodeProvider } from '../../packages/core/src/services/llm/cli-provider.js';
import type { ServiceViolationContext } from '../../packages/core/src/services/llm/provider.js';
import type { PreparedServiceViolationRequest } from '../../packages/core/src/services/llm/prepared-service-violation-request.js';
import {
  planServiceViolationWork,
  type PlannedServiceViolationWork,
} from '../../packages/core/src/services/llm/service-work-planner.js';

const RULE_KEY = 'service/llm/architecture-review';

function serviceContext(mode: 'normal' | 'lifecycle'): ServiceViolationContext {
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
    dependencies: [],
    llmRules: [{
      key: RULE_KEY,
      name: 'Architecture review',
      severity: 'high',
      prompt: 'Review service boundaries.',
    }],
    existingViolations: mode === 'lifecycle' ? [{
      id: 'runtime-prior-id',
      type: 'service',
      title: 'Orders owns payment logic',
      content: 'Payment logic crosses the service boundary.',
      severity: 'high',
    }] : undefined,
  };
}

class PlannedServiceProvider extends ClaudeCodeProvider {
  executePlannedServiceForTest(
    planned: PlannedServiceViolationWork<PreparedServiceViolationRequest>,
  ) {
    return this.executePlannedServiceViolationWork(planned);
  }
}

describe('planned service violation execution', () => {
  it.each(['normal', 'lifecycle'] as const)(
    'executes the exact certified %s request without rebuilding source context',
    async (mode) => {
      const context = serviceContext(mode);
      const planned = planServiceViolationWork(context, mode, {
        provider: 'transport:unverified',
        requestedModel: 'sonnet',
      });
      const rawResult = mode === 'lifecycle'
        ? {
            resolvedViolationIds: [],
            unchangedViolationIds: ['prev-0'],
            newViolations: [],
            serviceDescriptions: [{ id: 'svc-0', description: 'Handles orders.' }],
          }
        : {
            violations: [],
            serviceDescriptions: [{ id: 'svc-0', description: 'Handles orders.' }],
          };
      let captured: LlmRequest | undefined;
      const transport: LlmTransport = async (request) => {
        captured = request;
        return JSON.stringify(rawResult);
      };
      const provider = new PlannedServiceProvider(transport, 'sonnet');

      context.architecture = 'mutated architecture';
      context.services[0].id = 'mutated-service-id';
      context.services[0].name = 'mutated-service-name';
      context.llmRules[0].key = 'mutated/llm/rule';
      if (context.existingViolations) context.existingViolations[0].id = 'mutated-prior-id';

      await expect(provider.executePlannedServiceForTest(planned)).resolves.toEqual(rawResult);
      expect(captured).toEqual({
        id: expect.stringMatching(/^llm\.service\.attempt:[a-f0-9-]{36}$/),
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
      expect(provider.flushUsage()).toHaveLength(0);
    },
  );
});
