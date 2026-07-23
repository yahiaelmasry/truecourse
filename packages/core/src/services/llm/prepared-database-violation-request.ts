import { config } from '../../config/index.js';
import type { DatabaseViolationContext } from './provider.js';
import { buildDatabaseTemplateVars, getPrompt } from './prompts.js';
import {
  serializePreparedRequestSchema,
  type PreparedLlmRequest,
  type PreparedPromptBinding,
} from './prepared-request.js';
import {
  DatabaseLifecycleViolationOutputSchema,
  DatabaseViolationOutputSchema,
} from './schemas.js';

export interface PreparedDatabaseOwnership {
  readonly databases: readonly {
    readonly promptId: string;
    readonly databaseName: string;
    readonly tableNames: readonly string[];
  }[];
  readonly ruleKeys: readonly string[];
  readonly priorFindings: readonly {
    readonly promptId: string;
    readonly type: string;
    readonly title: string;
    readonly content: string;
    readonly severity: string;
    readonly ruleKey: string | null;
    readonly targetDatabaseName: string | null;
    readonly targetTable: string | null;
  }[];
}

export type DatabaseViolationOutput = ReturnType<typeof DatabaseViolationOutputSchema.parse>;
export type DatabaseLifecycleViolationOutput = ReturnType<typeof DatabaseLifecycleViolationOutputSchema.parse>;

interface PreparedDatabaseRequestMetadata {
  readonly system: '';
  readonly responseFormat: 'json';
  readonly toolPolicy: 'none';
  readonly bindings: readonly PreparedPromptBinding[];
  readonly ownership: PreparedDatabaseOwnership;
}

export type PreparedNormalDatabaseViolationRequest =
  PreparedLlmRequest<DatabaseViolationOutput>
  & PreparedDatabaseRequestMetadata
  & {
    readonly stage: 'analyze.database';
    readonly label: 'database';
    readonly resultContractId: 'analyze.database@1';
  };

export type PreparedLifecycleDatabaseViolationRequest =
  PreparedLlmRequest<DatabaseLifecycleViolationOutput>
  & PreparedDatabaseRequestMetadata
  & {
    readonly stage: 'analyze.database-lifecycle';
    readonly label: 'database-lifecycle';
    readonly resultContractId: 'analyze.database-lifecycle@1';
  };

export type PreparedDatabaseViolationRequest =
  | PreparedNormalDatabaseViolationRequest
  | PreparedLifecycleDatabaseViolationRequest;

/** Capture every provider-independent input used by one database-check request. */
export function prepareDatabaseViolationRequest(
  context: DatabaseViolationContext,
  mode: 'normal',
): PreparedNormalDatabaseViolationRequest;
export function prepareDatabaseViolationRequest(
  context: DatabaseViolationContext,
  mode: 'lifecycle',
): PreparedLifecycleDatabaseViolationRequest;
export function prepareDatabaseViolationRequest(
  context: DatabaseViolationContext,
  mode: 'normal' | 'lifecycle',
): PreparedDatabaseViolationRequest {
  const lifecycle = mode === 'lifecycle';
  if (lifecycle && (context.existingViolations ?? []).some((violation) =>
    typeof violation.ruleKey !== 'string' || violation.ruleKey.trim().length === 0)) {
    throw new Error('Database lifecycle prior is missing stable rule ownership');
  }
  const { vars, idMap } = buildDatabaseTemplateVars(context);
  const bindings = Object.freeze(
    [...idMap.entries()].map(([promptId, runtimeId]) =>
      Object.freeze({ promptId, runtimeId })),
  );
  const databaseBindings = bindings.filter(({ promptId }) => promptId.startsWith('db-'));
  const priorBindings = bindings.filter(({ promptId }) => promptId.startsWith('prev-'));
  if (
    new Set(databaseBindings.map(({ runtimeId }) => runtimeId)).size !== databaseBindings.length
    || new Set(priorBindings.map(({ runtimeId }) => runtimeId)).size !== priorBindings.length
  ) {
    throw new Error('Database request cannot bind one runtime ID to multiple prompt aliases');
  }
  const ownership = Object.freeze({
    databases: Object.freeze(context.databases.map((database, index) => Object.freeze({
      promptId: databaseBindings[index]!.promptId,
      databaseName: database.name,
      tableNames: Object.freeze((database.tables ?? []).map((table) => table.name)),
    }))),
    ruleKeys: Object.freeze(context.llmRules.map((rule) => rule.key)),
    priorFindings: Object.freeze((context.existingViolations ?? []).map((violation, index) => Object.freeze({
      promptId: priorBindings[index]!.promptId,
      type: violation.type,
      title: violation.title,
      content: violation.content,
      severity: violation.severity,
      ruleKey: violation.ruleKey ?? null,
      targetDatabaseName: violation.targetDatabaseName ?? null,
      targetTable: violation.targetTable ?? null,
    }))),
  });
  const common = {
    system: '',
    prompt: getPrompt(
      lifecycle ? 'violations-database-lifecycle' : 'violations-database',
      vars,
    ),
    responseFormat: 'json',
    toolPolicy: 'none',
    timeoutMs: config.claudeCodeTimeoutMs,
    bindings,
    ownership,
  } as const;

  if (lifecycle) {
    const parse = DatabaseLifecycleViolationOutputSchema.parse.bind(DatabaseLifecycleViolationOutputSchema);
    return Object.freeze({
      ...common,
      stage: 'analyze.database-lifecycle',
      label: 'database-lifecycle',
      schemaJson: serializePreparedRequestSchema(DatabaseLifecycleViolationOutputSchema),
      resultContractId: 'analyze.database-lifecycle@1',
      parse: Object.freeze((value: unknown) => parse(value)),
    });
  }

  const parse = DatabaseViolationOutputSchema.parse.bind(DatabaseViolationOutputSchema);
  return Object.freeze({
    ...common,
    stage: 'analyze.database',
    label: 'database',
    schemaJson: serializePreparedRequestSchema(DatabaseViolationOutputSchema),
    resultContractId: 'analyze.database@1',
    parse: Object.freeze((value: unknown) => parse(value)),
  });
}
