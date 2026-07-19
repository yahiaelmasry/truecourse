/**
 * Mode-specific persistence for `analyzeCore` results.
 *
 * Full analyze writes `analyses/*.json` (delta) + `LATEST.json` (materialized
 * view) + appends `history.json` + deletes any stale `diff.json` + bumps
 * `lastAnalyzed`. Diff writes only `diff.json` with hydrated resolved rows
 * and affected-node keys for the dashboard.
 *
 * Keeping persistence separate from computation means `analyze-core.ts` stays
 * free of disk IO (easy to test) and both modes share the exact same
 * up-to-the-point-of-write semantics.
 */

import path from 'node:path';
import { log } from '../lib/logger.js';
import type { RegistryEntry } from '../config/registry.js';
import {
  buildAnalysisFilename,
  writeDiff,
  promoteCompletedAnalysisBaseline,
} from '../lib/analysis-store.js';
import {
  projectCompletedAnalysis,
  type CompletedAnalysisProjectionIntent,
} from '../lib/completed-analysis-projection.js';
import {
  makeViolationDenormalizer,
  type CompletedAnalysisPromotion,
} from '../lib/completed-analysis-promotion.js';
import { PromotedAnalysisNotInLineageError } from '../lib/completed-analysis-lineage.js';
import type {
  AnalysisSnapshot,
  DiffSnapshot,
  HistoryEntry,
  LatestSnapshot,
  ViolationRecord,
  ViolationSeverity,
  ViolationWithNames,
} from '../types/snapshot.js';
import type { runViolationPipeline } from '../services/violation-pipeline.service.js';
import type { AnalyzeCoreResult } from './analyze-core.js';

// ---------------------------------------------------------------------------
// Full analyze — writes analyses/*.json, LATEST.json, history.json; clears diff.json
// ---------------------------------------------------------------------------

export interface PersistFullResult {
  analysisId: string;
  filename: string;
  serviceCount: number;
  fileCount: number;
  architecture: string;
  durationMs: number;
  violationsSummary: { total: number; bySeverity: Record<string, number> };
}

export interface FullAnalysisFinalizationPlan {
  filename: string;
  promotion: CompletedAnalysisPromotion;
  projection: CompletedAnalysisProjectionIntent;
  result: Omit<PersistFullResult, 'durationMs'>;
}

/**
 * Build the exact completed-baseline and projection payloads for one full run.
 * The legacy writer consumes this plan now; the recovery-safe run finalizer can
 * consume it when production journal wiring is enabled, without reconstructing
 * analysis state after provider work.
 */
export function buildFullAnalysisFinalizationPlan(
  project: RegistryEntry,
  core: AnalyzeCoreResult,
): FullAnalysisFinalizationPlan {
  const filename = buildAnalysisFilename(core.analysisId, core.now);

  const snapshot = persistedJson<AnalysisSnapshot>({
    id: core.analysisId,
    createdAt: core.now,
    branch: core.branch,
    commitHash: core.commitHash,
    architecture: core.architecture,
    status: 'completed',
    metadata: core.metadata,
    graph: core.graph,
    violations: {
      added: core.pipelineResult.added,
      resolved: core.pipelineResult.resolvedRefs,
      previousAnalysisId: core.previousAnalysisId,
    },
    usage: core.usage,
  }, 'Analysis snapshot');

  const latest = persistedJson(buildLatestSnapshot(
    snapshot,
    filename,
    core.pipelineResult.unchanged,
    core.pipelineResult.added,
  ), 'LATEST snapshot');
  const historyEntry = buildHistoryEntry(snapshot, filename, core.pipelineResult);
  const { bySeverity, total } = summarizeActiveViolations(latest.violations);

  return {
    filename,
    promotion: {
      expectedBaseline: core.latestBaseline,
      snapshot,
      latest,
    },
    projection: {
      projectSlug: project.slug,
      promotedSnapshot: snapshot,
      historyEntry,
    },
    result: {
      analysisId: core.analysisId,
      filename,
      serviceCount: core.graph.services.length,
      fileCount: core.analysisResult.fileAnalyses?.length ?? 0,
      architecture: core.architecture,
      violationsSummary: { total, bySeverity },
    },
  };
}

export async function persistFullAnalysis(
  project: RegistryEntry,
  core: AnalyzeCoreResult,
  startedAt: number,
): Promise<PersistFullResult> {
  const plan = buildFullAnalysisFinalizationPlan(project, core);

  const promotion = await promoteCompletedAnalysisBaseline(project.path, plan.promotion);
  if (promotion.state === 'conflict') {
    try {
      await projectCompletedAnalysis(project.path, plan.projection);
    } catch (error) {
      if (!(error instanceof PromotedAnalysisNotInLineageError)) throw error;
      throw new Error(
        `Completed analysis baseline changed before promotion (current: ${promotion.currentBaselineId ?? 'none'})`,
      );
    }
  } else {
    await projectCompletedAnalysis(project.path, plan.projection);
  }

  return {
    ...plan.result,
    durationMs: Date.now() - startedAt,
  };
}

/** Match the JSON persistence contract while keeping store validation strict. */
function persistedJson<T>(value: T, label: string): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('value is not serializable');
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new Error(
      `${label} could not be converted to its persisted JSON form: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Diff analyze — writes diff.json
// ---------------------------------------------------------------------------

export interface PersistDiffResult {
  diff: DiffSnapshot;
  isStale: boolean;
}

export async function persistDiffAnalysis(
  project: RegistryEntry,
  core: AnalyzeCoreResult,
): Promise<PersistDiffResult> {
  if (!core.latestBaseline) {
    throw new Error('Diff persist requires a latestBaseline — analyzeCore should have enforced this.');
  }

  const diff = buildDiffSnapshot(project.path, core, core.latestBaseline);

  await writeDiff(project.path, diff);
  log.info(
    `[Diff] Done — ${diff.summary.newCount} new, ${diff.summary.unchangedCount} unchanged, ${diff.summary.resolvedCount} resolved across ${diff.changedFiles.length} changed files`,
  );

  return { diff, isStale: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLatestSnapshot(
  snapshot: AnalysisSnapshot,
  filename: string,
  unchanged: ViolationRecord[],
  added: ViolationRecord[],
): LatestSnapshot {
  const denormalize = makeViolationDenormalizer(snapshot.graph);
  return {
    head: filename,
    analysis: {
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      branch: snapshot.branch,
      commitHash: snapshot.commitHash,
      architecture: snapshot.architecture,
      metadata: snapshot.metadata,
      status: 'completed',
    },
    graph: snapshot.graph,
    violations: [...added.map(denormalize), ...unchanged.map(denormalize)],
  };
}

function summarizeActiveViolations(
  violations: ViolationWithNames[],
): { total: number; bySeverity: Record<string, number> } {
  const bySeverity: Record<string, number> = {};
  let total = 0;
  for (const v of violations) {
    bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
    total++;
  }
  return { total, bySeverity };
}

function buildHistoryEntry(
  snapshot: AnalysisSnapshot,
  filename: string,
  pipeline: Awaited<ReturnType<typeof runViolationPipeline>>,
): HistoryEntry {
  const bySeverity: Record<ViolationSeverity, number> = {
    info: 0, low: 0, medium: 0, high: 0, critical: 0,
  };
  for (const v of [...pipeline.added, ...pipeline.unchanged]) {
    bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
  }

  const totalTokens = snapshot.usage.reduce((s, u) => s + u.totalTokens, 0);
  const totalDurationMs = snapshot.usage.reduce((s, u) => s + u.durationMs, 0);
  let totalCostSum = 0;
  let anyCost = false;
  for (const u of snapshot.usage) {
    if (u.costUsd) {
      const n = Number(u.costUsd);
      if (!Number.isNaN(n)) { totalCostSum += n; anyCost = true; }
    }
  }
  const provider = snapshot.usage.length > 0 ? snapshot.usage[0].provider : '';

  return {
    id: snapshot.id,
    filename,
    createdAt: snapshot.createdAt,
    branch: snapshot.branch,
    commitHash: snapshot.commitHash,
    metadata: snapshot.metadata,
    counts: {
      services: snapshot.graph.services.length,
      modules: snapshot.graph.modules.length,
      methods: snapshot.graph.methods.length,
      violations: {
        new: pipeline.added.length,
        unchanged: pipeline.unchanged.length,
        resolved: pipeline.resolved.length,
        bySeverity,
      },
    },
    usage: {
      totalTokens,
      totalCostUsd: anyCost ? totalCostSum.toFixed(6) : '0',
      durationMs: totalDurationMs,
      provider,
    },
  };
}

function buildDiffSnapshot(
  repoPath: string,
  core: AnalyzeCoreResult,
  baseline: LatestSnapshot,
): DiffSnapshot {
  const { graph, changedFiles, pipelineResult } = core;
  const denormalize = makeViolationDenormalizer(graph);

  const newViolations = pipelineResult.added.map(denormalize);

  // Resolved rows: hydrate full rows from baseline LATEST using the ids we got back.
  const latestById = new Map(baseline.violations.map((v) => [v.id, v]));
  const resolvedViolations = pipelineResult.resolvedRefs
    .map((r) => latestById.get(r.id))
    .filter((v): v is ViolationWithNames => !!v);

  // Compute affected node IDs as NAME-based keys (the dashboard looks them up
  // by name, not UUID — UUIDs regenerate every analysis). Module filePaths
  // are absolute inside the target repo.
  const changedAbs = new Set(changedFiles.map((c) => path.resolve(repoPath, c.path)));
  const matchesChanged = (p: string | null | undefined) =>
    !!p && (changedAbs.has(p) || changedAbs.has(path.resolve(repoPath, p)));

  const affectedModules = graph.modules.filter((m) => matchesChanged(m.filePath));
  const affectedModuleIdSet = new Set(affectedModules.map((m) => m.id));

  const serviceNameById = new Map(graph.services.map((s) => [s.id, s.name]));
  const layerKeyById = new Map(
    graph.layers.map((l) => [l.id, `${l.serviceName}::${l.layer}`]),
  );

  const affectedServices = new Set<string>();
  const affectedLayers = new Set<string>();
  const affectedModuleKeys = new Set<string>();
  for (const mod of affectedModules) {
    const svcName = serviceNameById.get(mod.serviceId);
    if (svcName) {
      affectedServices.add(svcName);
      affectedModuleKeys.add(`${svcName}::${mod.name}`);
    }
    const layerKey = layerKeyById.get(mod.layerId);
    if (layerKey) affectedLayers.add(layerKey);
  }

  const moduleNameById = new Map(graph.modules.map((m) => [m.id, m.name]));
  const affectedMethodKeys: string[] = [];
  for (const method of graph.methods) {
    if (!affectedModuleIdSet.has(method.moduleId)) continue;
    const modName = moduleNameById.get(method.moduleId);
    const mod = graph.modules.find((m) => m.id === method.moduleId);
    const svcName = mod ? serviceNameById.get(mod.serviceId) : undefined;
    if (svcName && modName) affectedMethodKeys.push(`${svcName}::${modName}::${method.name}`);
  }

  return {
    id: core.analysisId,
    baseAnalysisId: baseline.analysis.id,
    createdAt: core.now,
    branch: core.branch,
    commitHash: core.commitHash,
    graph,
    changedFiles,
    newViolations,
    resolvedViolations,
    affectedNodeIds: {
      services: [...affectedServices],
      layers: [...affectedLayers],
      modules: [...affectedModuleKeys],
      methods: affectedMethodKeys,
    },
    summary: {
      newCount: newViolations.length,
      unchangedCount: pipelineResult.unchanged.length,
      resolvedCount: resolvedViolations.length,
    },
    usage: core.usage,
  };
}
