import { isDeepStrictEqual } from 'node:util';
import type {
  AnalysisSnapshot,
  Graph,
  LatestSnapshot,
  ViolationRecord,
  ViolationWithNames,
} from '../types/snapshot.js';

export interface CompletedAnalysisPromotion {
  /** Exact completed baseline used to compute this candidate; null for the first analysis. */
  expectedBaseline: LatestSnapshot | null;
  snapshot: AnalysisSnapshot;
  latest: LatestSnapshot;
}

export type AnalysisPromotionFaultPoint = 'after-marker' | 'after-prepare' | 'after-commit';

export interface AnalysisPromotionOptions {
  /** Deterministic fault seam used to prove recovery at the commit boundary. */
  faultInjector?: (point: AnalysisPromotionFaultPoint) => void | Promise<void>;
}

export type CompletedAnalysisPromotionResult =
  | { state: 'promoted' | 'already-promoted'; filename: string }
  | { state: 'conflict'; currentBaselineId: string | null };

/** Denormalize a violation row against the graph stored with its analysis. */
export function makeViolationDenormalizer(
  graph: Graph,
): (violation: ViolationRecord) => ViolationWithNames {
  const serviceById = new Map(graph.services.map((service) => [service.id, service.name]));
  const moduleById = new Map(graph.modules.map((module) => [module.id, module.name]));
  const methodById = new Map(graph.methods.map((method) => [method.id, method.name]));
  const databaseById = new Map(graph.databases.map((database) => [database.id, database.name]));
  return (violation) => ({
    ...violation,
    targetServiceName: violation.targetServiceId
      ? serviceById.get(violation.targetServiceId) ?? null
      : null,
    targetModuleName: violation.targetModuleId
      ? moduleById.get(violation.targetModuleId) ?? null
      : null,
    targetMethodName: violation.targetMethodId
      ? methodById.get(violation.targetMethodId) ?? null
      : null,
    targetDatabaseName: violation.targetDatabaseId
      ? databaseById.get(violation.targetDatabaseId) ?? null
      : null,
  });
}

function indexUniqueViolations(
  label: string,
  violations: readonly ViolationWithNames[],
): Map<string, ViolationWithNames> {
  const byId = new Map<string, ViolationWithNames>();
  for (const violation of violations) {
    if (byId.has(violation.id)) throw new Error(`${label} contains duplicate violation IDs`);
    byId.set(violation.id, violation);
  }
  return byId;
}

/**
 * Certify that the materialized active set contains every added finding and
 * accounts for every prior active finding as either resolved or explicitly
 * chained forward through `previousViolationId`.
 *
 * Snapshot v1 does not durably identify title-based lifecycle replacements,
 * so those promotions deliberately fail closed until that proof is added.
 */
export function validateCompletedAnalysisMaterialization(
  promotion: CompletedAnalysisPromotion,
): void {
  const baseline = promotion.expectedBaseline?.violations ?? [];
  const candidate = promotion.latest.violations;
  const baselineById = indexUniqueViolations('Expected baseline', baseline);
  const candidateById = indexUniqueViolations('Candidate LATEST', candidate);

  const resolvedIds = new Set<string>();
  for (const resolved of promotion.snapshot.violations.resolved) {
    if (resolvedIds.has(resolved.id)) {
      throw new Error('Candidate snapshot contains duplicate resolved violation IDs');
    }
    if (!baselineById.has(resolved.id)) {
      throw new Error('Candidate snapshot resolves a violation absent from the expected baseline');
    }
    resolvedIds.add(resolved.id);
  }

  const denormalize = makeViolationDenormalizer(promotion.snapshot.graph);
  const addedIds = new Set<string>();
  for (const added of promotion.snapshot.violations.added) {
    if (addedIds.has(added.id)) {
      throw new Error('Candidate snapshot contains duplicate added violation IDs');
    }
    if (baselineById.has(added.id)) {
      throw new Error('Candidate snapshot reuses a baseline violation ID as an added violation');
    }
    addedIds.add(added.id);
    if (!isDeepStrictEqual(candidateById.get(added.id), denormalize(added))) {
      throw new Error('Candidate LATEST does not exactly materialize its added violations');
    }
  }

  const chainedByPreviousId = new Map<string, ViolationWithNames>();
  for (const violation of candidate) {
    const internallyDenormalized = denormalize(violation);
    if (!isDeepStrictEqual(violation, internallyDenormalized)) {
      throw new Error('Candidate LATEST contains violation names inconsistent with its graph');
    }
    if (baselineById.has(violation.id)) {
      throw new Error('Candidate LATEST reuses a baseline violation ID');
    }
    if (addedIds.has(violation.id)) continue;
    if (violation.status !== 'unchanged' || !violation.previousViolationId) {
      throw new Error('Candidate LATEST contains an unaccounted active violation');
    }
    if (chainedByPreviousId.has(violation.previousViolationId)) {
      throw new Error('Candidate LATEST carries one prior violation forward more than once');
    }
    chainedByPreviousId.set(violation.previousViolationId, violation);
  }

  for (const previous of baseline) {
    if (resolvedIds.has(previous.id)) {
      if (chainedByPreviousId.has(previous.id)) {
        throw new Error('Candidate LATEST carries forward a resolved violation');
      }
      continue;
    }
    const carried = chainedByPreviousId.get(previous.id);
    if (!carried) throw new Error('Candidate LATEST omits an unresolved baseline violation');
    if (
      carried.firstSeenAnalysisId !== previous.firstSeenAnalysisId
      || carried.firstSeenAt !== previous.firstSeenAt
      || carried.ruleKey !== previous.ruleKey
      || carried.type !== previous.type
      || carried.createdAt !== promotion.snapshot.createdAt
      || carried.resolvedAt !== null
    ) {
      throw new Error('Candidate LATEST contains an invalid carried violation chain');
    }
    chainedByPreviousId.delete(previous.id);
  }
  if (chainedByPreviousId.size > 0) {
    throw new Error('Candidate LATEST carries a violation absent from the expected baseline');
  }
}

/** Validate immutable facts shared by the file and hosted promotion stores. */
export function validateCompletedAnalysisPromotion(
  promotion: CompletedAnalysisPromotion,
  filename: string,
): void {
  const { expectedBaseline, snapshot, latest } = promotion;
  const expectedBaselineId = expectedBaseline?.analysis.id ?? null;

  let persisted: unknown;
  try {
    persisted = JSON.parse(JSON.stringify(promotion));
  } catch {
    throw new Error('Completed-baseline promotion must be exactly JSON-round-trippable');
  }
  if (!isDeepStrictEqual(persisted, promotion)) {
    throw new Error('Completed-baseline promotion must be exactly JSON-round-trippable');
  }

  if (snapshot.status !== 'completed' || latest.analysis.status !== 'completed') {
    throw new Error('Completed-baseline promotion requires completed snapshots');
  }
  if (snapshot.violations.previousAnalysisId !== expectedBaselineId) {
    throw new Error('Candidate snapshot does not identify the expected baseline');
  }
  if (latest.head !== filename) {
    throw new Error('Candidate LATEST head does not match its analysis filename');
  }
  const latestIdentity = {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    branch: snapshot.branch,
    commitHash: snapshot.commitHash,
    architecture: snapshot.architecture,
    metadata: snapshot.metadata,
    status: snapshot.status,
  };
  if (!isDeepStrictEqual(latest.analysis, latestIdentity)) {
    throw new Error('Candidate LATEST analysis does not match its snapshot');
  }
  if (!isDeepStrictEqual(latest.graph, snapshot.graph)) {
    throw new Error('Candidate LATEST graph does not match its snapshot');
  }
  validateCompletedAnalysisMaterialization(promotion);
}
