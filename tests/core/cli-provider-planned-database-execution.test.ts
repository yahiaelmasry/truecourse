import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import { ClaudeCodeProvider } from '../../packages/core/src/services/llm/cli-provider.js';
import type { DatabaseViolationContext } from '../../packages/core/src/services/llm/provider.js';
import type { PreparedDatabaseViolationRequest } from '../../packages/core/src/services/llm/prepared-database-violation-request.js';
import {
  planDatabaseViolationWork,
  type PlannedDatabaseViolationWork,
} from '../../packages/core/src/services/llm/database-work-planner.js';

const RULE_KEY = 'database/llm/schema-review';

function databaseContext(mode: 'normal' | 'lifecycle'): DatabaseViolationContext {
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
    existingViolations: mode === 'lifecycle' ? [{
      id: 'runtime-prior-id',
      type: 'database',
      title: 'Orders need an index',
      content: 'The orders lookup is not indexed.',
      severity: 'high',
    }] : undefined,
  };
}

class PlannedDatabaseProvider extends ClaudeCodeProvider {
  executePlannedDatabaseForTest(
    planned: PlannedDatabaseViolationWork<PreparedDatabaseViolationRequest>,
  ) {
    return this.executePlannedDatabaseViolationWork(planned);
  }
}

describe('planned database violation execution', () => {
  it.each(['normal', 'lifecycle'] as const)(
    'executes the exact certified %s request without rebuilding source context',
    async (mode) => {
      const context = databaseContext(mode);
      const planned = planDatabaseViolationWork(context, mode, {
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
      const provider = new PlannedDatabaseProvider(transport, 'sonnet');

      context.databases[0].id = 'mutated-database-id';
      context.databases[0].name = 'mutated-database-name';
      context.databases[0].tables![0].columns[0].name = 'mutated-column';
      context.llmRules[0].key = 'mutated/llm/rule';
      if (context.existingViolations) context.existingViolations[0].id = 'mutated-prior-id';

      await expect(provider.executePlannedDatabaseForTest(planned)).resolves.toEqual(rawResult);
      expect(captured).toEqual({
        id: expect.stringMatching(/^llm\.database\.attempt:[a-f0-9-]{36}$/),
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
