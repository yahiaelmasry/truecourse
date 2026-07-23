import type {
  DatabaseLifecycleViolationOutput,
  DatabaseViolationOutput,
  PreparedDatabaseViolationRequest,
} from './prepared-database-violation-request.js';

type DatabaseFinding = DatabaseViolationOutput['violations'][number];

/**
 * Certifies that a schema-valid database result belongs to its exact prepared
 * request before it can become durable checkpoint evidence.
 */
export function certifyDatabaseViolationResult(
  request: PreparedDatabaseViolationRequest,
  result: unknown,
): DatabaseViolationOutput | DatabaseLifecycleViolationOutput {
  const parsed = request.parse(result) as DatabaseViolationOutput | DatabaseLifecycleViolationOutput;
  const allowedRules = new Set(request.ownership.ruleKeys);
  const targets = new Map(request.ownership.databases.map((database) => [
    database.promptId,
    new Set(database.tableNames),
  ]));
  const findings = 'newViolations' in parsed ? parsed.newViolations : parsed.violations;
  const seenFindings = new Set<string>();

  for (const finding of findings) {
    certifyFindingOwnership(finding, allowedRules, targets);
    const duplicateKey = [
      finding.ruleKey,
      finding.targetDatabaseId ?? '',
      finding.targetTable ?? '',
      finding.title,
    ].join('\0');
    if (seenFindings.has(duplicateKey)) {
      throw new Error('Database result cannot contain the same new finding more than once');
    }
    seenFindings.add(duplicateKey);
  }

  if ('newViolations' in parsed) {
    certifyLifecyclePartition(request, parsed);
    certifyNoPriorFindingCollision(request, parsed.newViolations, targets);
  }
  return parsed;
}

function certifyFindingOwnership(
  finding: DatabaseFinding,
  allowedRules: ReadonlySet<string>,
  targets: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  if (!allowedRules.has(finding.ruleKey)) {
    throw new Error(`Database result rule "${finding.ruleKey}" is not owned by the originating work`);
  }
  if (finding.targetDatabaseId === null) {
    if (finding.targetTable !== null) {
      throw new Error('Database result cannot name a table without an owned database target');
    }
    return;
  }
  const tables = targets.get(finding.targetDatabaseId);
  if (!tables) {
    throw new Error(`Database result target "${finding.targetDatabaseId}" is not owned by the originating work`);
  }
  if (finding.targetTable !== null && !tables.has(finding.targetTable)) {
    throw new Error(`Database result table "${finding.targetTable}" is not owned by database "${finding.targetDatabaseId}"`);
  }
}

function certifyLifecyclePartition(
  request: PreparedDatabaseViolationRequest,
  result: DatabaseLifecycleViolationOutput,
): void {
  const expectedIds = new Set(request.ownership.priorFindings.map((finding) => finding.promptId));
  const classifiedIds = [...result.resolvedViolationIds, ...result.unchangedViolationIds];
  const classifiedSet = new Set(classifiedIds);
  if (
    classifiedIds.length !== expectedIds.size
    || classifiedSet.size !== expectedIds.size
    || !classifiedIds.every((id) => expectedIds.has(id))
  ) {
    throw new Error('Database lifecycle result must be an exact partition of the originating previous IDs');
  }
}

function certifyNoPriorFindingCollision(
  request: PreparedDatabaseViolationRequest,
  findings: readonly DatabaseFinding[],
  targets: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const databaseNameByPromptId = new Map(
    request.ownership.databases.map((database) => [database.promptId, database.databaseName]),
  );
  const priorKeys = new Set(request.ownership.priorFindings.map((finding) => {
    if (finding.ruleKey === null) throw new Error('Database lifecycle prior is missing stable rule ownership');
    return findingIdentity({
      ruleKey: finding.ruleKey,
      databaseName: finding.targetDatabaseName,
      tableName: finding.targetTable,
      content: finding.content,
    });
  }));
  if (findings.some((finding) => {
    if (finding.targetDatabaseId !== null && !targets.has(finding.targetDatabaseId)) {
      throw new Error('Database lifecycle finding lost its certified target ownership');
    }
    return priorKeys.has(findingIdentity({
      ruleKey: finding.ruleKey,
      databaseName: finding.targetDatabaseId === null
        ? null
        : databaseNameByPromptId.get(finding.targetDatabaseId) ?? null,
      tableName: finding.targetTable,
      content: finding.content,
    }));
  })) {
    throw new Error('Database lifecycle result cannot classify a previous finding and reintroduce it as new');
  }
}

function findingIdentity(input: Readonly<{
  ruleKey: string;
  databaseName: string | null;
  tableName: string | null;
  content: string;
}>): string {
  return [
    input.ruleKey,
    input.databaseName ?? '',
    input.tableName ?? '',
    input.content.toLowerCase().trim().replace(/\s+/g, ' '),
  ].join('\0');
}
