import { isDeepStrictEqual } from 'node:util';
import type { AnalysisSnapshot, LatestSnapshot } from '../types/snapshot.js';

export interface StoredCompletedAnalysisSnapshot {
  filename: string;
  snapshot: AnalysisSnapshot;
}

export interface CompletedAnalysisLineageCertification {
  activeAnalysisId: string;
  /** Zero for the active snapshot, one for its parent, and so on. */
  generations: number;
}

export class PromotedAnalysisNotInLineageError extends Error {
  constructor() {
    super('Promoted snapshot is not in the active completed-analysis lineage');
    this.name = 'PromotedAnalysisNotInLineageError';
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateJsonIdentity(snapshot: AnalysisSnapshot): void {
  let persisted: unknown;
  try {
    persisted = JSON.parse(JSON.stringify(snapshot));
  } catch {
    throw new Error('Promoted snapshot must be exactly JSON-round-trippable');
  }
  if (!isDeepStrictEqual(persisted, snapshot)) {
    throw new Error('Promoted snapshot must be exactly JSON-round-trippable');
  }
}

function validateStoredSnapshot(
  requestedId: string,
  stored: StoredCompletedAnalysisSnapshot,
  buildFilename: (analysisId: string, createdAt: string) => string,
): void {
  const { snapshot, filename } = stored;
  const previousId = snapshot.violations?.previousAnalysisId;
  if (
    snapshot.status !== 'completed'
    || snapshot.id !== requestedId
    || snapshot.id.length === 0
    || !isCanonicalTimestamp(snapshot.createdAt)
    || (previousId !== null && (typeof previousId !== 'string' || previousId.length === 0))
    || buildFilename(snapshot.id, snapshot.createdAt) !== filename
  ) {
    throw new Error('Completed-analysis lineage contains an invalid snapshot');
  }
}

function exactCandidate(
  candidates: readonly StoredCompletedAnalysisSnapshot[],
): StoredCompletedAnalysisSnapshot {
  if (candidates.length === 0) {
    throw new Error('Completed-analysis lineage is missing an ancestor snapshot');
  }
  if (candidates.length !== 1) {
    throw new Error('Completed-analysis lineage contains duplicate analysis IDs');
  }
  return candidates[0];
}

/**
 * Prove that an exact promoted snapshot is the active completed analysis or a
 * backward-reachable committed ancestor. The resolver deliberately bypasses
 * canonical enumeration so an old crash marker cannot hide a real ancestor.
 * The exact target is the proof anchor: links older than it are not required,
 * because supported history deletion may have removed those snapshots.
 */
export function certifyCompletedAnalysisLineageSnapshots(
  latest: LatestSnapshot,
  promotedSnapshot: AnalysisSnapshot,
  storedSnapshots: readonly StoredCompletedAnalysisSnapshot[],
  buildFilename: (analysisId: string, createdAt: string) => string,
): CompletedAnalysisLineageCertification {
  validateJsonIdentity(promotedSnapshot);

  const candidatesById = new Map<string, StoredCompletedAnalysisSnapshot[]>();
  for (const storedSnapshot of storedSnapshots) {
    const candidates = candidatesById.get(storedSnapshot.snapshot.id) ?? [];
    candidates.push(storedSnapshot);
    candidatesById.set(storedSnapshot.snapshot.id, candidates);
  }

  const activeAnalysisId = latest.analysis.id;
  let stored = exactCandidate(candidatesById.get(activeAnalysisId) ?? []);
  validateStoredSnapshot(activeAnalysisId, stored, buildFilename);
  if (
    stored.filename !== latest.head
    || !isDeepStrictEqual(latest.analysis, {
      id: stored.snapshot.id,
      createdAt: stored.snapshot.createdAt,
      branch: stored.snapshot.branch,
      commitHash: stored.snapshot.commitHash,
      architecture: stored.snapshot.architecture,
      metadata: stored.snapshot.metadata,
      status: stored.snapshot.status,
    })
    || !isDeepStrictEqual(latest.graph, stored.snapshot.graph)
  ) {
    throw new Error('Active completed baseline does not match its lineage snapshot');
  }

  const visited = new Set<string>();
  let generations = 0;
  while (true) {
    const { snapshot } = stored;
    if (visited.has(snapshot.id)) {
      throw new Error('Completed-analysis lineage contains a cycle');
    }
    visited.add(snapshot.id);

    if (snapshot.id === promotedSnapshot.id) {
      if (!isDeepStrictEqual(snapshot, promotedSnapshot)) {
        throw new Error('Stored lineage snapshot does not exactly match the promoted snapshot');
      }
      return { activeAnalysisId, generations };
    }

    const previousId = snapshot.violations.previousAnalysisId;
    if (previousId === null) {
      throw new PromotedAnalysisNotInLineageError();
    }
    stored = exactCandidate(candidatesById.get(previousId) ?? []);
    validateStoredSnapshot(previousId, stored, buildFilename);
    generations += 1;
  }
}
