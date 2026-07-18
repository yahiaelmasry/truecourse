import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import {
  createLLMProvider,
  type DatabaseViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import { planDatabaseViolationWork } from '../../packages/core/src/services/llm/database-work-planner.js';

const execution = {
  provider: 'claude-code',
  requestedModel: 'sonnet',
} as const;

function lifecycleContext(): DatabaseViolationContext {
  return {
    databases: [{
      id: 'runtime-orders-db',
      name: 'orders-db',
      type: 'postgres',
      driver: 'pg',
      tableCount: 1,
      connectedServices: ['orders-service', 'billing-service'],
      tables: [{
        name: 'orders',
        columns: [
          { name: 'customer_id', type: 'uuid', isForeignKey: true, referencesTable: 'customers' },
          { name: 'id', type: 'uuid', isPrimaryKey: true },
        ],
      }],
      relations: [{
        sourceTable: 'orders',
        targetTable: 'customers',
        foreignKeyColumn: 'customer_id',
      }],
    }, {
      id: 'runtime-customers-db',
      name: 'customers-db',
      type: 'postgres',
      driver: 'pg',
      tableCount: 1,
      connectedServices: ['customers-service'],
      tables: [{
        name: 'customers',
        columns: [{ name: 'id', type: 'uuid', isPrimaryKey: true }],
      }],
      relations: [],
    }],
    llmRules: [{
      key: 'database/llm/schema-review',
      name: 'Schema review',
      severity: 'high',
      prompt: 'Review database relationships.',
    }, {
      key: 'database/llm/index-review',
      name: 'Index review',
      severity: 'medium',
      prompt: 'Review database indexes.',
    }],
    existingViolations: [{
      id: 'runtime-prior-a',
      type: 'database',
      title: 'Orders need an index',
      content: 'The customer lookup is not indexed.',
      severity: 'high',
    }, {
      id: 'runtime-prior-b',
      type: 'database',
      title: 'Customers need retention',
      content: 'The schema has no retention field.',
      severity: 'medium',
    }],
  };
}

describe('database work planner', () => {
  it('keeps semantic identity and fingerprints stable across runtime IDs and input permutations', () => {
    const original = lifecycleContext();
    const permuted = lifecycleContext();
    permuted.databases[0].id = 'other-orders-runtime-id';
    permuted.databases[1].id = 'other-customers-runtime-id';
    permuted.databases.reverse();
    permuted.databases[1].connectedServices.reverse();
    permuted.databases[1].tables![0].columns.reverse();
    permuted.llmRules.reverse();
    permuted.existingViolations![0].id = 'other-prior-a';
    permuted.existingViolations![1].id = 'other-prior-b';
    permuted.existingViolations!.reverse();

    const first = planDatabaseViolationWork(original, 'lifecycle', execution);
    const second = planDatabaseViolationWork(permuted, 'lifecycle', execution);

    expect(first.workId).toMatch(/^llm\.database:sha256:[a-f0-9]{64}$/);
    expect(first.inputFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.workId).toBe(second.workId);
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.request.prompt).toBe(second.request.prompt);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.componentFingerprints)).toBe(true);

    const changedSchema = lifecycleContext();
    changedSchema.databases[0].tables![0].columns[0].type = 'text';
    const schemaPlan = planDatabaseViolationWork(changedSchema, 'lifecycle', execution);
    expect(schemaPlan.workId).toBe(first.workId);
    expect(schemaPlan.componentFingerprints.repository).not.toBe(first.componentFingerprints.repository);
    expect(schemaPlan.inputFingerprint).not.toBe(first.inputFingerprint);

    const changedPrior = lifecycleContext();
    changedPrior.existingViolations![0].content = 'Changed completed-baseline evidence.';
    const priorPlan = planDatabaseViolationWork(changedPrior, 'lifecycle', execution);
    expect(priorPlan.workId).toBe(first.workId);
    expect(priorPlan.componentFingerprints.baseline).not.toBe(first.componentFingerprints.baseline);
    expect(priorPlan.inputFingerprint).not.toBe(first.inputFingerprint);

    const changedRule = lifecycleContext();
    changedRule.llmRules[0].prompt = 'Use a stricter relationship policy.';
    const rulePlan = planDatabaseViolationWork(changedRule, 'lifecycle', execution);
    expect(rulePlan.workId).toBe(first.workId);
    expect(rulePlan.componentFingerprints.rules).not.toBe(first.componentFingerprints.rules);
    expect(rulePlan.inputFingerprint).not.toBe(first.inputFingerprint);

    const changedScope = lifecycleContext();
    changedScope.databases[0].name = 'fulfillment-db';
    expect(planDatabaseViolationWork(changedScope, 'lifecycle', execution).workId).not.toBe(first.workId);

    const changedRuleKey = lifecycleContext();
    changedRuleKey.llmRules[0].key = 'database/llm/different-scope';
    expect(planDatabaseViolationWork(changedRuleKey, 'lifecycle', execution).workId).not.toBe(first.workId);
  });

  it('fingerprints method mode, exact request/result contracts, provider, and requested model', () => {
    const context = lifecycleContext();
    const lifecycle = planDatabaseViolationWork(context, 'lifecycle', execution);
    const normal = planDatabaseViolationWork(context, 'normal', execution);

    expect(normal.workId).toBe(lifecycle.workId);
    expect(normal.componentFingerprints.configuration).not.toBe(lifecycle.componentFingerprints.configuration);
    expect(normal.componentFingerprints.request).not.toBe(lifecycle.componentFingerprints.request);
    expect(normal.componentFingerprints.resultContract).not.toBe(lifecycle.componentFingerprints.resultContract);
    expect(normal.inputFingerprint).not.toBe(lifecycle.inputFingerprint);

    const providerChanged = planDatabaseViolationWork(context, 'lifecycle', {
      provider: 'agent-mailbox',
      requestedModel: 'sonnet',
    });
    expect(providerChanged.componentFingerprints.execution).not.toBe(lifecycle.componentFingerprints.execution);
    expect(providerChanged.inputFingerprint).not.toBe(lifecycle.inputFingerprint);

    const modelChanged = planDatabaseViolationWork(context, 'lifecycle', {
      provider: 'claude-code',
      requestedModel: 'opus',
    });
    expect(modelChanged.componentFingerprints.execution).not.toBe(lifecycle.componentFingerprints.execution);
    expect(modelChanged.inputFingerprint).not.toBe(lifecycle.inputFingerprint);
  });

  it('fails closed when duplicate semantic priors cannot receive stable aliases', () => {
    const context = lifecycleContext();
    context.existingViolations!.push({
      ...context.existingViolations![0],
      id: 'duplicate-runtime-id',
    });

    expect(() => planDatabaseViolationWork(context, 'lifecycle', execution))
      .toThrow(/duplicate semantic prior findings/);
  });

  it('fails closed when duplicate semantic databases cannot receive stable aliases', () => {
    const context = lifecycleContext();
    context.databases.push({
      ...structuredClone(context.databases[0]),
      id: 'duplicate-runtime-database-id',
    });

    expect(() => planDatabaseViolationWork(context, 'lifecycle', execution))
      .toThrow(/duplicate semantic databases/);
  });

  it('forwards stable identity metadata with a unique attempt ID through the real provider call', async () => {
    const context = lifecycleContext();
    const planned = planDatabaseViolationWork(context, 'lifecycle', {
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
    });
    let captured: LlmRequest | undefined;
    const transport: LlmTransport = async (request) => {
      captured = request;
      return JSON.stringify({
        resolvedViolationIds: [],
        unchangedViolationIds: ['prev-0', 'prev-1'],
        newViolations: [],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');

    await provider.generateDatabaseViolationsWithLifecycle(context);

    expect(captured).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^llm\.database\.attempt:[a-f0-9-]{36}$/),
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      user: planned.request.prompt,
      schema: planned.request.schemaJson,
    }));
  });
});
