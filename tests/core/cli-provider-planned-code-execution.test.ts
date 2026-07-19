import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import { ClaudeCodeProvider } from '../../packages/core/src/services/llm/cli-provider.js';
import type { CodeViolationContext } from '../../packages/core/src/services/llm/provider.js';
import type { PlannedCodeViolationWork } from '../../packages/core/src/services/llm/code-work-planner.js';
import { planCodeViolationWork } from '../../packages/core/src/services/llm/code-work-planner.js';

const RULE_KEY = 'reliability/llm/async-boundary';

function codeContext(mode: 'normal' | 'lifecycle'): CodeViolationContext {
  return {
    files: [{
      path: 'context',
      content: [
        '=== src/orders.ts ===',
        '--- placeOrder (lines 1-3) ---',
        '1: export async function placeOrder() {',
        '2:   await saveOrder();',
        '3: }',
      ].join('\n'),
    }],
    sourceScopes: [{
      path: 'src/orders.ts',
      ranges: [{ lineStart: 1, lineEnd: 3 }],
    }],
    llmRules: [{
      key: RULE_KEY,
      name: 'Async boundary',
      severity: 'high',
      prompt: 'Review async error handling.',
    }],
    tier: 'targeted',
    existingViolations: mode === 'lifecycle' ? [{
      id: 'runtime-prior-id',
      filePath: 'src/orders.ts',
      lineStart: 1,
      lineEnd: 3,
      ruleKey: RULE_KEY,
      severity: 'high',
      title: 'Missing async boundary',
      content: 'The call has no error boundary.',
    }] : undefined,
  };
}

class PlannedCodeProvider extends ClaudeCodeProvider {
  executePlannedCodeForTest(planned: PlannedCodeViolationWork) {
    return this.executePlannedCodeViolationWork(planned);
  }
}

describe('planned code violation execution', () => {
  it.each(['normal', 'lifecycle'] as const)(
    'executes and certifies the exact %s request without rebuilding source context',
    async (mode) => {
      const context = codeContext(mode);
      const planned = planCodeViolationWork(context, {
        provider: 'transport:unverified',
        requestedModel: 'sonnet',
      });
      const rawResult = mode === 'lifecycle'
        ? {
            resolvedViolationIds: [],
            unchangedViolationIds: ['cv-0'],
            newViolations: [],
          }
        : { violations: [] };
      let captured: LlmRequest | undefined;
      const transport: LlmTransport = async (request) => {
        captured = request;
        return JSON.stringify(rawResult);
      };
      const provider = new PlannedCodeProvider(transport, 'sonnet');

      context.files[0].content = 'mutated content';
      context.sourceScopes[0].path = 'src/mutated.ts';
      context.llmRules[0].key = 'mutated/llm/rule';
      if (context.existingViolations) context.existingViolations[0].id = 'mutated-prior-id';

      await expect(provider.executePlannedCodeForTest(planned)).resolves.toEqual(rawResult);
      expect(captured).toEqual({
        id: expect.stringMatching(/^llm\.code\.attempt:[a-f0-9-]{36}$/),
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
