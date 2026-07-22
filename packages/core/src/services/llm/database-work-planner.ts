import type { DatabaseViolationContext } from './provider.js';
import {
  prepareDatabaseViolationRequest,
  type PreparedDatabaseViolationRequest,
  type PreparedLifecycleDatabaseViolationRequest,
  type PreparedNormalDatabaseViolationRequest,
} from './prepared-database-violation-request.js';
import {
  assertUniqueLlmIdentity,
  canonicalJson,
  compareCanonicalText,
  fingerprint,
  type LlmWorkComponentFingerprints,
  type LlmWorkExecutionIntent,
} from './work-identity.js';

export type DatabaseWorkExecutionIntent = LlmWorkExecutionIntent;
export type DatabaseWorkComponentFingerprints = LlmWorkComponentFingerprints;

export interface PlannedDatabaseViolationWork<
  TRequest extends PreparedDatabaseViolationRequest = PreparedDatabaseViolationRequest,
> {
  readonly workId: string;
  readonly inputFingerprint: string;
  readonly componentFingerprints: DatabaseWorkComponentFingerprints;
  readonly request: TRequest;
}

function sortCanonical<T>(values: T[]): T[] {
  return values.sort((left, right) =>
    compareCanonicalText(canonicalJson(left), canonicalJson(right)));
}

function canonicalContext(context: DatabaseViolationContext): DatabaseViolationContext {
  assertUniqueLlmIdentity(context.llmRules.map((rule) => rule.key), 'rule key');
  assertUniqueLlmIdentity(context.databases.map((database) => database.id), 'database runtime ID');
  assertUniqueLlmIdentity(
    (context.existingViolations ?? []).map((violation) => violation.id),
    'prior runtime ID',
  );
  const semanticPriorKey = ({ id: _id, ...semantic }: NonNullable<DatabaseViolationContext['existingViolations']>[number]): string =>
    canonicalJson(semantic);
  const existingViolations = (context.existingViolations ?? [])
    .map((violation) => ({ ...violation }))
    .sort((left, right) => compareCanonicalText(semanticPriorKey(left), semanticPriorKey(right)));
  const semanticPriorKeys = existingViolations.map(semanticPriorKey);
  if (semanticPriorKeys.some((key, index) => index > 0 && key === semanticPriorKeys[index - 1])) {
    throw new Error('Database work cannot assign stable aliases to duplicate semantic prior findings');
  }

  const databases = context.databases.map((database) => ({
      ...database,
      connectedServices: [...database.connectedServices].sort(compareCanonicalText),
      tables: database.tables
        ? sortCanonical(database.tables.map((table) => ({
            ...table,
            columns: sortCanonical(table.columns.map((column) => ({ ...column }))),
          })))
        : undefined,
      relations: database.relations
        ? sortCanonical(database.relations.map((relation) => ({ ...relation })))
        : undefined,
    }));
  databases.sort((left, right) => {
    const { id: _leftId, ...leftSemantic } = left;
    const { id: _rightId, ...rightSemantic } = right;
    return compareCanonicalText(canonicalJson(leftSemantic), canonicalJson(rightSemantic));
  });
  const semanticDatabaseKeys = databases.map(({ id: _id, ...semantic }) => canonicalJson(semantic));
  if (semanticDatabaseKeys.some((key, index) => index > 0 && key === semanticDatabaseKeys[index - 1])) {
    throw new Error('Database work cannot assign stable aliases to duplicate semantic databases');
  }

  return {
    databases,
    llmRules: sortCanonical(context.llmRules.map((rule) => ({ ...rule }))),
    existingViolations: context.existingViolations ? existingViolations : undefined,
  };
}

export function planDatabaseViolationWork(
  context: DatabaseViolationContext,
  mode: 'normal',
  execution: DatabaseWorkExecutionIntent,
): PlannedDatabaseViolationWork<PreparedNormalDatabaseViolationRequest>;
export function planDatabaseViolationWork(
  context: DatabaseViolationContext,
  mode: 'lifecycle',
  execution: DatabaseWorkExecutionIntent,
): PlannedDatabaseViolationWork<PreparedLifecycleDatabaseViolationRequest>;
export function planDatabaseViolationWork(
  context: DatabaseViolationContext,
  mode: 'normal' | 'lifecycle',
  execution: DatabaseWorkExecutionIntent,
): PlannedDatabaseViolationWork {
  const preparedContext = canonicalContext(context);
  const request = mode === 'normal'
    ? prepareDatabaseViolationRequest(preparedContext, 'normal')
    : prepareDatabaseViolationRequest(preparedContext, 'lifecycle');
  const databaseNames = preparedContext.databases
    .map((database) => database.name)
    .sort(compareCanonicalText);
  const ruleKeys = [...new Set(preparedContext.llmRules.map((rule) => rule.key))]
    .sort(compareCanonicalText);
  const workId = `llm.database:${fingerprint({
    version: 1,
    databaseNames,
    ruleKeys,
  })}`;

  const componentFingerprints = Object.freeze({
    repository: fingerprint(preparedContext.databases.map(({ id: _id, ...database }) => database)),
    baseline: fingerprint((preparedContext.existingViolations ?? [])
      .map(({ id: _id, ...semantic }) => semantic)),
    rules: fingerprint(preparedContext.llmRules),
    configuration: fingerprint({
      mode,
      toolPolicy: request.toolPolicy,
      timeoutMs: request.timeoutMs,
    }),
    request: fingerprint({
      stage: request.stage,
      label: request.label,
      system: request.system,
      prompt: request.prompt,
      schemaJson: request.schemaJson,
      responseFormat: request.responseFormat,
      toolPolicy: request.toolPolicy,
      timeoutMs: request.timeoutMs,
    }),
    execution: fingerprint({
      provider: execution.provider,
      requestedModel: execution.requestedModel,
    }),
    resultContract: fingerprint({
      resultContractId: request.resultContractId,
      promptAliases: request.bindings.map((binding) => binding.promptId),
    }),
  });
  const inputFingerprint = fingerprint(componentFingerprints);

  return Object.freeze({
    workId,
    inputFingerprint,
    componentFingerprints,
    request,
  });
}
