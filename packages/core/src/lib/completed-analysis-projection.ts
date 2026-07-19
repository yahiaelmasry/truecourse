import { isDeepStrictEqual } from 'node:util';
import {
  ensureLastAnalyzed,
  getRegistryStore,
  validateLastAnalyzedTimestamp,
  type EnsureLastAnalyzedResult,
} from '../config/registry.js';
import type {
  AnalysisSnapshot,
  HistoryEntry,
  UsageRecord,
  ViolationSeverity,
} from '../types/snapshot.js';
import {
  activeCompletedBaselineId,
  buildAnalysisFilename,
  certifyCompletedAnalysisLineage,
  ensureHistoryEntry,
  readLatest,
  reconcileDiffWithLatest,
  validateHistoryEntryForPersistence,
  type EnsureHistoryEntryResult,
  type ReconcileDiffResult,
} from './analysis-store.js';

export interface CompletedAnalysisProjectionIntent {
  projectSlug: string;
  promotedSnapshot: AnalysisSnapshot;
  historyEntry: HistoryEntry;
}

export type CompletedAnalysisProjectionFaultPoint =
  | 'after-history'
  | 'after-diff'
  | 'after-registry';

export interface CompletedAnalysisProjectionOptions {
  faultInjector?: (
    point: CompletedAnalysisProjectionFaultPoint,
  ) => void | Promise<void>;
}

export interface CompletedAnalysisProjectionResult {
  activeAnalysisId: string;
  generations: number;
  history: EnsureHistoryEntryResult;
  diff: ReconcileDiffResult;
  registry: EnsureLastAnalyzedResult;
}

const severities: ViolationSeverity[] = ['info', 'low', 'medium', 'high', 'critical'];

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function summarizeUsage(usage: readonly UsageRecord[]): HistoryEntry['usage'] {
  let totalTokens = 0;
  let durationMs = 0;
  let totalCost = 0;
  let hasCost = false;
  for (const record of usage) {
    if (
      record.provider.trim().length === 0
      || record.callType.trim().length === 0
      || !canonicalTimestamp(record.createdAt)
      || !nonnegativeInteger(record.inputTokens)
      || !nonnegativeInteger(record.outputTokens)
      || !nonnegativeInteger(record.cacheReadTokens)
      || !nonnegativeInteger(record.cacheWriteTokens)
      || !nonnegativeInteger(record.totalTokens)
      || !nonnegativeInteger(record.durationMs)
      || (record.costUsd !== null && (
        record.costUsd.trim().length === 0
        || !Number.isFinite(Number(record.costUsd))
        || Number(record.costUsd) < 0
      ))
    ) {
      throw new Error('Promoted snapshot contains invalid usage accounting');
    }
    totalTokens += record.totalTokens;
    durationMs += record.durationMs;
    if (!Number.isSafeInteger(totalTokens) || !Number.isSafeInteger(durationMs)) {
      throw new Error('Promoted snapshot contains invalid usage accounting');
    }
    if (record.costUsd !== null) {
      const value = Number(record.costUsd);
      totalCost += value;
      if (!Number.isFinite(totalCost)) throw new Error('Promoted snapshot contains invalid usage accounting');
      hasCost = true;
    }
  }
  return {
    totalTokens,
    totalCostUsd: hasCost ? totalCost.toFixed(6) : '0',
    durationMs,
    provider: usage[0]?.provider ?? '',
  };
}

function validateProjectionIntent(intent: CompletedAnalysisProjectionIntent): void {
  let persisted: unknown;
  try {
    persisted = JSON.parse(JSON.stringify(intent));
  } catch {
    throw new Error('Completed-analysis projection intent must be exactly JSON-round-trippable');
  }
  if (!isDeepStrictEqual(persisted, intent)) {
    throw new Error('Completed-analysis projection intent must be exactly JSON-round-trippable');
  }
  if (intent.projectSlug.length === 0) {
    throw new Error('Completed-analysis projection requires a project slug');
  }

  const { promotedSnapshot: snapshot, historyEntry: entry } = intent;
  validateHistoryEntryForPersistence(entry);
  const counts = entry.counts;
  const violationCounts = counts?.violations;
  if (
    entry.id !== snapshot.id
    || entry.filename !== buildAnalysisFilename(snapshot.id, snapshot.createdAt)
    || entry.createdAt !== snapshot.createdAt
    || entry.branch !== snapshot.branch
    || entry.commitHash !== snapshot.commitHash
    || !isDeepStrictEqual(entry.metadata, snapshot.metadata)
    || counts?.services !== snapshot.graph.services.length
    || counts?.modules !== snapshot.graph.modules.length
    || counts?.methods !== snapshot.graph.methods.length
    || violationCounts?.new !== snapshot.violations.added.length
    || violationCounts?.resolved !== snapshot.violations.resolved.length
    || !nonnegativeInteger(violationCounts?.unchanged)
    || !nonnegativeInteger(violationCounts?.new)
    || !nonnegativeInteger(violationCounts?.resolved)
  ) {
    throw new Error('History entry does not match the promoted snapshot');
  }

  const bySeverity = violationCounts.bySeverity;
  const addedBySeverity = Object.fromEntries(
    severities.map((severity) => [severity, 0]),
  ) as Record<ViolationSeverity, number>;
  for (const added of snapshot.violations.added) {
    if (!severities.includes(added.severity)) {
      throw new Error('Promoted snapshot contains an invalid violation severity');
    }
    addedBySeverity[added.severity] += 1;
  }
  if (
    !isDeepStrictEqual(Object.keys(bySeverity).sort(), [...severities].sort())
    || severities.some((severity) => !nonnegativeInteger(bySeverity[severity]))
    || severities.some((severity) => bySeverity[severity] < addedBySeverity[severity])
    || severities.reduce((sum, severity) => sum + bySeverity[severity], 0)
      !== violationCounts.new + violationCounts.unchanged
    || (snapshot.violations.previousAnalysisId === null && violationCounts.unchanged !== 0)
    || !isDeepStrictEqual(entry.usage, summarizeUsage(snapshot.usage))
  ) {
    throw new Error('History entry does not match the promoted snapshot');
  }
}

function validateActiveHistoryCounts(
  intent: CompletedAnalysisProjectionIntent,
  latest: NonNullable<Awaited<ReturnType<typeof readLatest>>>,
): void {
  const bySeverity = Object.fromEntries(
    severities.map((severity) => [severity, 0]),
  ) as Record<ViolationSeverity, number>;
  for (const violation of latest.violations) {
    if (!severities.includes(violation.severity)) {
      throw new Error('Active completed baseline contains an invalid violation severity');
    }
    bySeverity[violation.severity] += 1;
  }
  const expectedUnchanged = latest.violations.length - intent.promotedSnapshot.violations.added.length;
  if (
    expectedUnchanged < 0
    || intent.historyEntry.counts.violations.unchanged !== expectedUnchanged
    || !isDeepStrictEqual(intent.historyEntry.counts.violations.bySeverity, bySeverity)
  ) {
    throw new Error('History entry does not match the active completed baseline');
  }
}

/**
 * Repair completed-analysis projections while the caller holds the repository
 * lifecycle lock. Every mutation is idempotent; exact retry is the recovery
 * protocol after any ambiguous stop.
 */
export async function projectCompletedAnalysis(
  repoKey: string,
  intent: CompletedAnalysisProjectionIntent,
  options: CompletedAnalysisProjectionOptions = {},
): Promise<CompletedAnalysisProjectionResult> {
  if (repoKey.length === 0) throw new Error('Completed-analysis projection requires a repository key');
  validateProjectionIntent(intent);

  const lineage = await certifyCompletedAnalysisLineage(repoKey, intent.promotedSnapshot);
  const latest = await readLatest(repoKey);
  const activeAnalysisId = activeCompletedBaselineId(latest);
  if (activeAnalysisId !== lineage.activeAnalysisId) {
    throw new Error('Active completed baseline changed during projection preflight');
  }
  if (lineage.generations === 0) validateActiveHistoryCounts(intent, latest!);

  const registry = getRegistryStore();
  if (!registry.ensureLastAnalyzed) {
    throw new Error('Active registry store does not support monotonic projection');
  }
  const project = await registry.getProjectBySlug(intent.projectSlug);
  if (!project || project.path !== repoKey) {
    throw new Error('Projection project does not match the repository key');
  }
  if (project.lastAnalyzed) {
    validateLastAnalyzedTimestamp(project.lastAnalyzed, 'Stored lastAnalyzed');
  }

  const history = await ensureHistoryEntry(repoKey, intent.historyEntry);
  await options.faultInjector?.('after-history');
  const diff = await reconcileDiffWithLatest(repoKey);
  await options.faultInjector?.('after-diff');
  const registryResult = await ensureLastAnalyzed(intent.projectSlug, latest!.analysis.createdAt);
  await options.faultInjector?.('after-registry');

  return {
    activeAnalysisId,
    generations: lineage.generations,
    history,
    diff,
    registry: registryResult,
  };
}
