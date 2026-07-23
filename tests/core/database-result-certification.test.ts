import { describe, expect, it } from 'vitest';
import type { DatabaseViolationContext } from '../../packages/core/src/services/llm/provider.js';
import { prepareDatabaseViolationRequest } from '../../packages/core/src/services/llm/prepared-database-violation-request.js';
import { certifyDatabaseViolationResult } from '../../packages/core/src/services/llm/database-result-certification.js';

const RULE_KEY = 'database/llm/schema-review';

function context(mode: 'normal' | 'lifecycle'): DatabaseViolationContext {
  return {
    databases: [{
      id: 'runtime-orders',
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
    }, {
      id: 'runtime-customers',
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
      key: RULE_KEY,
      name: 'Schema review',
      severity: 'high',
      prompt: 'Review database schemas.',
    }],
    existingViolations: mode === 'lifecycle' ? [{
      id: 'runtime-prior',
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

function finding(overrides: Record<string, unknown> = {}) {
  return {
    type: 'database' as const,
    title: 'Orders have no retention policy',
    content: 'Order rows are retained indefinitely.',
    severity: 'high' as const,
    targetDatabaseId: 'db-0',
    targetTable: 'orders',
    fixPrompt: null,
    ruleKey: RULE_KEY,
    ...overrides,
  };
}

describe('database result certification', () => {
  it('accepts owned normal and lifecycle results in prompt-alias space', () => {
    const normal = prepareDatabaseViolationRequest(context('normal'), 'normal');
    const lifecycle = prepareDatabaseViolationRequest(context('lifecycle'), 'lifecycle');

    expect(() => certifyDatabaseViolationResult(normal, {
      violations: [finding(), finding({
        title: 'Customers have no retention policy',
        targetDatabaseId: 'db-1',
        targetTable: 'customers',
      })],
    })).not.toThrow();
    expect(() => certifyDatabaseViolationResult(lifecycle, {
      resolvedViolationIds: [],
      unchangedViolationIds: ['prev-0'],
      newViolations: [finding()],
    })).not.toThrow();
  });

  it.each([
    ['unowned rule', finding({ ruleKey: 'database/llm/foreign' }), /rule/],
    ['unknown database alias', finding({ targetDatabaseId: 'db-99' }), /Database/],
    ['wrong database table', finding({ targetTable: 'customers' }), /table/],
    ['table without a database', finding({ targetDatabaseId: null }), /table/],
  ] as const)('rejects a new finding with %s', (_case, invalid, message) => {
    const request = prepareDatabaseViolationRequest(context('normal'), 'normal');

    expect(() => certifyDatabaseViolationResult(request, { violations: [invalid] }))
      .toThrow(message);
  });

  it('allows a database-wide finding only when both target fields are null', () => {
    const request = prepareDatabaseViolationRequest(context('normal'), 'normal');

    expect(() => certifyDatabaseViolationResult(request, {
      violations: [finding({ targetDatabaseId: null, targetTable: null })],
    })).not.toThrow();
  });

  it('rejects the same new finding more than once', () => {
    const request = prepareDatabaseViolationRequest(context('normal'), 'normal');
    const duplicate = finding();

    expect(() => certifyDatabaseViolationResult(request, {
      violations: [duplicate, { ...duplicate }],
    })).toThrow(/same new finding/);
  });

  it.each([
    ['omitted prior', { resolvedViolationIds: [], unchangedViolationIds: [] }],
    ['foreign prior', { resolvedViolationIds: [], unchangedViolationIds: ['prev-99'] }],
    ['overlapping prior', { resolvedViolationIds: ['prev-0'], unchangedViolationIds: ['prev-0'] }],
    ['duplicated prior', { resolvedViolationIds: [], unchangedViolationIds: ['prev-0', 'prev-0'] }],
  ] as const)('rejects a lifecycle result with an %s partition', (_case, partition) => {
    const request = prepareDatabaseViolationRequest(context('lifecycle'), 'lifecycle');

    expect(() => certifyDatabaseViolationResult(request, {
      ...partition,
      newViolations: [],
    })).toThrow(/exact partition/);
  });

  it('rejects reintroducing a classified prior finding as new', () => {
    const request = prepareDatabaseViolationRequest(context('lifecycle'), 'lifecycle');

    expect(() => certifyDatabaseViolationResult(request, {
      resolvedViolationIds: [],
      unchangedViolationIds: ['prev-0'],
      newViolations: [finding({
        title: 'A cosmetically different title',
        content: '  THE ORDERS LOOKUP IS NOT   INDEXED. ',
      })],
    })).toThrow(/reintroduce/);
  });

  it('allows the same title when the rule-owned database target is different', () => {
    const request = prepareDatabaseViolationRequest(context('lifecycle'), 'lifecycle');

    expect(() => certifyDatabaseViolationResult(request, {
      resolvedViolationIds: [],
      unchangedViolationIds: ['prev-0'],
      newViolations: [finding({
        title: 'Orders need an index',
        content: 'The orders lookup is not indexed.',
        targetDatabaseId: 'db-1',
        targetTable: 'customers',
      })],
    })).not.toThrow();
  });
});
