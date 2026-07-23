import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import {
  createLLMProvider,
  type DatabaseViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import { prepareDatabaseViolationRequest } from '../../packages/core/src/services/llm/prepared-database-violation-request.js';
import { planDatabaseViolationWork } from '../../packages/core/src/services/llm/database-work-planner.js';

const RULE_KEY = 'database/llm/schema-review';

function databaseContext(withPrior = false): DatabaseViolationContext {
  return {
    databases: [{
      id: 'runtime-database-id',
      name: 'orders-db',
      type: 'postgres',
      driver: 'pg',
      tableCount: 1,
      connectedServices: ['orders-service'],
      tables: [{
        name: 'orders',
        columns: [{ name: 'id', type: 'uuid', isPrimaryKey: true }],
      }],
      relations: [],
    }],
    llmRules: [{
      key: RULE_KEY,
      name: 'Schema review',
      severity: 'high',
      prompt: 'Review the database schema.',
    }],
    existingViolations: withPrior ? [{
      id: 'runtime-prior-id',
      type: 'database',
      title: 'Orders need an index',
      content: 'The orders lookup is not indexed.',
      severity: 'high',
      ruleKey: RULE_KEY,
      targetDatabaseName: 'orders-db',
      targetTable: 'orders',
    }] : undefined,
  };
}

describe('prepared database violation requests', () => {
  it('freezes a provider-independent lifecycle request, ownership snapshot, and runtime bindings', () => {
    const context = databaseContext(true);
    const prepared = prepareDatabaseViolationRequest(context, 'lifecycle');
    const originalPrompt = prepared.prompt;

    context.databases[0].id = 'mutated-database-id';
    context.databases[0].tables![0].columns[0].name = 'mutated-column';
    context.llmRules[0].key = 'mutated/llm/rule';
    context.existingViolations![0].id = 'mutated-prior-id';
    context.existingViolations![0].title = 'Mutated prior title';

    expect(prepared).toEqual(expect.objectContaining({
      stage: 'analyze.database-lifecycle',
      label: 'database-lifecycle',
      responseFormat: 'json',
      toolPolicy: 'none',
      resultContractId: 'analyze.database-lifecycle@1',
      prompt: originalPrompt,
      bindings: [
        { promptId: 'db-0', runtimeId: 'runtime-database-id' },
        { promptId: 'prev-0', runtimeId: 'runtime-prior-id' },
      ],
    }));
    expect(prepared.schemaJson).toContain('unchangedViolationIds');
    expect(prepared.prompt).toContain('[id: db-0]');
    expect(prepared.prompt).toContain('[id: prev-0]');
    expect(prepared.prompt).not.toContain('runtime-database-id');
    expect(prepared.prompt).not.toContain('runtime-prior-id');
    expect(prepared.prompt).not.toContain('mutated');
    expect(prepared.ownership).toEqual(expect.objectContaining({
      databases: [expect.objectContaining({ promptId: 'db-0', databaseName: 'orders-db' })],
      ruleKeys: [RULE_KEY],
      priorFindings: [expect.objectContaining({ title: 'Orders need an index' })],
    }));
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.bindings)).toBe(true);
    expect(Object.isFrozen(prepared.ownership)).toBe(true);
    expect(Object.isFrozen(prepared.ownership.priorFindings[0])).toBe(true);
  });

  it.each([
    ['database IDs', (context: DatabaseViolationContext) => {
      context.databases.push({
        ...structuredClone(context.databases[0]),
        name: 'archive-db',
      });
    }],
    ['prior IDs', (context: DatabaseViolationContext) => {
      context.existingViolations!.push({
        ...context.existingViolations![0],
        title: 'Different prior finding',
      });
    }],
  ] as const)('fails closed when duplicate %s would own multiple prompt aliases', (_case, arrange) => {
    const context = databaseContext(true);
    arrange(context);

    expect(() => prepareDatabaseViolationRequest(context, 'lifecycle'))
      .toThrow(/one runtime ID/);
  });

  it('allows database and prior aliases to share a runtime value across typed namespaces', () => {
    const context = databaseContext(true);
    context.existingViolations![0].id = context.databases[0].id;

    expect(prepareDatabaseViolationRequest(context, 'lifecycle').bindings).toEqual([
      { promptId: 'db-0', runtimeId: 'runtime-database-id' },
      { promptId: 'prev-0', runtimeId: 'runtime-database-id' },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ] as const)('rejects a lifecycle prior with %s rule ownership before execution', (_case, ruleKey) => {
    const context = databaseContext(true);
    context.existingViolations![0].ruleKey = ruleKey;

    expect(() => prepareDatabaseViolationRequest(context, 'lifecycle'))
      .toThrow(/missing stable.*ownership/);
  });

  it('retains stable prior ownership when that rule is no longer active', () => {
    const context = databaseContext(true);
    context.existingViolations![0].ruleKey = 'database/llm/inactive';

    expect(prepareDatabaseViolationRequest(context, 'lifecycle').ownership.priorFindings[0])
      .toEqual(expect.objectContaining({ ruleKey: 'database/llm/inactive' }));
  });

  it('makes the provider execute the exact prepared normal request', async () => {
    const context = databaseContext(true);
    const planned = planDatabaseViolationWork(context, 'normal', {
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
    });
    const expected = planned.request;
    let captured: LlmRequest | undefined;
    const transport: LlmTransport = async (request) => {
      captured = request;
      return JSON.stringify({
        violations: [{
          type: 'database',
          title: 'Orders need an index',
          content: 'The orders lookup is not indexed.',
          severity: 'high',
          targetDatabaseId: 'db-0',
          targetTable: 'orders',
          fixPrompt: 'Add an index.',
          ruleKey: RULE_KEY,
        }],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');

    await expect(provider.generateDatabaseViolations(context)).resolves.toEqual({
      violations: [expect.objectContaining({ targetDatabaseId: 'runtime-database-id' })],
    });
    expect(captured).toEqual({
      id: expect.stringMatching(/^llm\.database\.attempt:[a-f0-9-]{36}$/),
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      stage: expected.stage,
      user: expected.prompt,
      system: expected.system,
      schema: expected.schemaJson,
      responseFormat: expected.responseFormat,
      model: 'sonnet',
      timeoutMs: expected.timeoutMs,
    });
  });

  it('maps an in-flight lifecycle result through the prepared binding snapshot', async () => {
    const context = databaseContext(true);
    const planned = planDatabaseViolationWork(context, 'lifecycle', {
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
    });
    const expected = planned.request;
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
          type: 'database',
          title: 'Orders need a foreign key',
          content: 'The customer reference is not constrained.',
          severity: 'high',
          targetDatabaseId: 'db-0',
          targetTable: 'orders',
          fixPrompt: 'Add the foreign key.',
          ruleKey: RULE_KEY,
        }],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');
    const execution = provider.generateDatabaseViolationsWithLifecycle(context);

    await didStart;
    context.databases[0].id = 'mutated-database-id';
    context.databases[0].name = 'mutated-db';
    context.llmRules[0].key = 'mutated/llm/rule';
    context.existingViolations![0].id = 'mutated-prior-id';
    release();

    await expect(execution).resolves.toEqual({
      resolvedViolationIds: [],
      unchangedViolationIds: ['runtime-prior-id'],
      newViolations: [expect.objectContaining({
        targetDatabaseId: 'runtime-database-id',
        ruleKey: RULE_KEY,
      })],
    });
    expect(captured).toEqual({
      id: expect.stringMatching(/^llm\.database\.attempt:[a-f0-9-]{36}$/),
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      stage: expected.stage,
      user: expected.prompt,
      system: expected.system,
      schema: expected.schemaJson,
      responseFormat: expected.responseFormat,
      model: 'sonnet',
      timeoutMs: expected.timeoutMs,
    });
  });

  it('keeps the called lifecycle method authoritative when there are no previous violations', async () => {
    const context = databaseContext();
    const expected = prepareDatabaseViolationRequest(context, 'lifecycle');
    let captured: LlmRequest | undefined;
    const transport: LlmTransport = async (request) => {
      captured = request;
      return JSON.stringify({
        resolvedViolationIds: [],
        unchangedViolationIds: [],
        newViolations: [],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');

    await expect(provider.generateDatabaseViolationsWithLifecycle(context)).resolves.toEqual({
      resolvedViolationIds: [],
      unchangedViolationIds: [],
      newViolations: [],
    });
    expect(captured).toEqual(expect.objectContaining({
      stage: expected.stage,
      user: expected.prompt,
      schema: expected.schemaJson,
    }));
  });
});
