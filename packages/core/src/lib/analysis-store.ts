/**
 * Analysis snapshot store. The default is file-backed (OSS/local — unchanged
 * model); the enterprise edition injects a Postgres/Blob-backed impl via
 * `setAnalysisStore`. The store is keyed by `repoPath`: a filesystem path for
 * the file impl, an opaque repo identity for the EE impl.
 *
 * The interface is async so a DB-backed impl is possible; the file impl wraps
 * the synchronous `fs` calls (so OSS behaviour — incl. the LATEST mtime cache —
 * is unchanged). Path helpers below stay file-specific and synchronous.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteJson } from './atomic-write.js';
import { fingerprint } from './canonical-json.js';
import {
  validateCompletedAnalysisPromotion,
  type AnalysisPromotionOptions,
  type CompletedAnalysisPromotion,
  type CompletedAnalysisPromotionResult,
} from './completed-analysis-promotion.js';
import type {
  AnalysisSnapshot,
  DiffSnapshot,
  History,
  HistoryEntry,
  LatestSnapshot,
} from '../types/snapshot.js';

// ---------------------------------------------------------------------------
// Layout (file impl)
//   <repo>/.truecourse/
//     analyses/<iso>_<short-uuid>.json   per-analysis snapshots
//     analyses/.promotions/<filename>    local prepared-promotion markers
//     LATEST.json                         materialized current-state view
//     history.json                        summaries (append-only)
//     diff.json                           active diff against LATEST (optional)
// ---------------------------------------------------------------------------

const TRUECOURSE_DIR = '.truecourse';
const ANALYSES_DIR = 'analyses';
const PROMOTIONS_DIR = '.promotions';
const LATEST_FILE = 'LATEST.json';
const HISTORY_FILE = 'history.json';
const DIFF_FILE = 'diff.json';

function storeDir(repoPath: string): string {
  return path.join(repoPath, TRUECOURSE_DIR);
}

function analysesDir(repoPath: string): string {
  return path.join(storeDir(repoPath), ANALYSES_DIR);
}

function promotionsDir(repoPath: string): string {
  return path.join(analysesDir(repoPath), PROMOTIONS_DIR);
}

function promotionMarkerPath(repoPath: string, filename: string): string {
  return path.join(promotionsDir(repoPath), filename);
}

export function analysisFilePath(repoPath: string, filename: string): string {
  return path.join(analysesDir(repoPath), filename);
}

export function latestPath(repoPath: string): string {
  return path.join(storeDir(repoPath), LATEST_FILE);
}

export function historyPath(repoPath: string): string {
  return path.join(storeDir(repoPath), HISTORY_FILE);
}

export function diffPath(repoPath: string): string {
  return path.join(storeDir(repoPath), DIFF_FILE);
}

/**
 * Build the filename for a new analysis snapshot. Format:
 *   `YYYY-MM-DDTHH-MM-SSZ_<8-char-uuid>.json`
 * Sortable lexicographically ⇒ sortable chronologically.
 */
export function buildAnalysisFilename(analysisId: string, createdAt: string): string {
  const iso = createdAt
    .replace(/[:.]/g, '-')
    .replace(/-\d{3}Z$/, 'Z');
  const shortId = analysisId.replace(/-/g, '').slice(0, 8);
  return `${iso}_${shortId}.json`;
}

// ---------------------------------------------------------------------------
// Back-compat: default `category`/`subcategory` on snapshots written before the
// Contract Framework so downstream code can rely on the fields existing.
// ---------------------------------------------------------------------------

function patchViolations<T extends { category?: string; subcategory?: string | null }>(
  rows: T[] | undefined,
): void {
  if (!rows) return;
  for (const v of rows) {
    if (v.category === undefined) v.category = 'rule';
    if (v.subcategory === undefined) v.subcategory = null;
  }
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface WrittenAnalysis {
  filename: string;
  snapshot: AnalysisSnapshot;
}

export type EnsureHistoryEntryResult = 'inserted' | 'present';
export type ReconcileDiffResult = 'absent' | 'current' | 'removed-stale';

export function validateHistoryEntryForPersistence(entry: HistoryEntry): void {
  let persisted: unknown;
  try {
    persisted = JSON.parse(JSON.stringify(entry));
  } catch {
    throw new Error('History entry must be exactly JSON-round-trippable');
  }
  if (!isDeepStrictEqual(persisted, entry)) {
    throw new Error('History entry must be exactly JSON-round-trippable');
  }
}

export function activeCompletedBaselineId(latest: LatestSnapshot | null): string {
  const analysis = latest?.analysis;
  const createdAt = analysis?.createdAt;
  const canonicalTimestamp = typeof createdAt === 'string'
    && !Number.isNaN(Date.parse(createdAt))
    && new Date(createdAt).toISOString() === createdAt;
  if (
    !latest
    || !analysis
    || analysis.status !== 'completed'
    || typeof analysis.id !== 'string'
    || analysis.id.length === 0
    || !canonicalTimestamp
    || latest.head !== buildAnalysisFilename(analysis.id, createdAt)
  ) {
    throw new Error('Cannot reconcile diff without an active completed baseline');
  }
  return analysis.id;
}

interface StoredCompletedAnalysisPromotion {
  schemaVersion: 1;
  filename: string;
  analysisId: string;
  expectedBaselineId: string | null;
  expectedBaselineFingerprint: string | null;
  promotionFingerprint: string;
}

/** Pluggable analysis store. File-backed by default; EE injects Postgres/Blob. */
export interface AnalysisStore {
  readLatest(repoPath: string): Promise<LatestSnapshot | null>;
  writeLatest(repoPath: string, latest: LatestSnapshot): Promise<void>;
  deleteLatest(repoPath: string): Promise<void>;
  writeAnalysis(repoPath: string, snapshot: AnalysisSnapshot): Promise<WrittenAnalysis>;
  promoteCompletedAnalysisBaseline(
    repoPath: string,
    promotion: CompletedAnalysisPromotion,
    options?: AnalysisPromotionOptions,
  ): Promise<CompletedAnalysisPromotionResult>;
  readAnalysis(repoPath: string, filename: string): Promise<AnalysisSnapshot | null>;
  listAnalyses(repoPath: string): Promise<string[]>;
  findAnalysisFilename(repoPath: string, analysisId: string): Promise<string | null>;
  deleteAnalysis(repoPath: string, filename: string): Promise<void>;
  readHistory(repoPath: string): Promise<History>;
  appendHistory(repoPath: string, entry: HistoryEntry): Promise<void>;
  /**
   * Idempotently inserts an entry while the caller holds the repository
   * lifecycle lock. The lock is required across the full recovery operation.
   */
  ensureHistoryEntry(
    repoPath: string,
    entry: HistoryEntry,
  ): Promise<EnsureHistoryEntryResult>;
  removeFromHistory(repoPath: string, analysisId: string): Promise<void>;
  readDiff(repoPath: string): Promise<DiffSnapshot | null>;
  writeDiff(repoPath: string, diff: DiffSnapshot): Promise<void>;
  deleteDiff(repoPath: string): Promise<void>;
  /**
   * Reconcile the canonical diff against the current completed LATEST while
   * holding the repository lifecycle lock. Never use this for PR-scoped diffs.
   */
  reconcileDiffWithLatest(repoPath: string): Promise<ReconcileDiffResult>;
}

// ---------------------------------------------------------------------------
// File-backed default impl (OSS) — synchronous fs under an async surface.
// LATEST.json is mtime-cached so repeated reads cost a stat.
// ---------------------------------------------------------------------------

const latestCache = new Map<string, { mtime: number; data: LatestSnapshot }>();

class FileAnalysisStore implements AnalysisStore {
  private readLatestUncached(repoPath: string): LatestSnapshot | null {
    const file = latestPath(repoPath);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as LatestSnapshot;
    patchViolations(data.violations);
    return data;
  }

  private readStoredPromotion(
    repoPath: string,
    filename: string,
  ): StoredCompletedAnalysisPromotion | null {
    const file = promotionMarkerPath(repoPath, filename);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredCompletedAnalysisPromotion;
  }

  private readAnalysisUnpatched(repoPath: string, filename: string): AnalysisSnapshot | null {
    const file = analysisFilePath(repoPath, filename);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as AnalysisSnapshot;
  }

  private removePromotionMarker(repoPath: string, filename: string): void {
    try {
      fs.unlinkSync(promotionMarkerPath(repoPath, filename));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async readLatest(repoPath: string): Promise<LatestSnapshot | null> {
    const file = latestPath(repoPath);
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        latestCache.delete(repoPath);
        return null;
      }
      throw err;
    }
    const cached = latestCache.get(repoPath);
    if (cached && cached.mtime === mtime) return cached.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as LatestSnapshot;
    patchViolations(data.violations);
    latestCache.set(repoPath, { mtime, data });
    return data;
  }

  async writeLatest(repoPath: string, latest: LatestSnapshot): Promise<void> {
    atomicWriteJson(latestPath(repoPath), latest);
    latestCache.delete(repoPath);
  }

  async deleteLatest(repoPath: string): Promise<void> {
    try {
      fs.unlinkSync(latestPath(repoPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    latestCache.delete(repoPath);
  }

  async writeAnalysis(repoPath: string, snapshot: AnalysisSnapshot): Promise<WrittenAnalysis> {
    const filename = buildAnalysisFilename(snapshot.id, snapshot.createdAt);
    atomicWriteJson(analysisFilePath(repoPath, filename), snapshot);
    return { filename, snapshot };
  }

  /**
   * Commit a completed baseline under the repository analyze lock.
   *
   * The durable marker makes the prepared snapshot invisible to canonical
   * enumeration before LATEST is replaced. LATEST is the sole commit point.
   * After it changes, recovery only moves forward and removes the marker.
   */
  async promoteCompletedAnalysisBaseline(
    repoPath: string,
    promotion: CompletedAnalysisPromotion,
    options: AnalysisPromotionOptions = {},
  ): Promise<CompletedAnalysisPromotionResult> {
    const filename = buildAnalysisFilename(promotion.snapshot.id, promotion.snapshot.createdAt);
    validateCompletedAnalysisPromotion(promotion, filename);
    const current = this.readLatestUncached(repoPath);

    if (current?.analysis.id === promotion.snapshot.id) {
      const storedSnapshot = this.readAnalysisUnpatched(repoPath, filename);
      if (!storedSnapshot || !isDeepStrictEqual(storedSnapshot, promotion.snapshot)) {
        throw new Error('Committed analysis snapshot does not match the promotion candidate');
      }
      if (!isDeepStrictEqual(current, promotion.latest)) {
        throw new Error('Committed LATEST does not match the promotion candidate');
      }
      this.removePromotionMarker(repoPath, filename);
      return { state: 'already-promoted', filename };
    }

    const currentBaselineId = current?.analysis.id ?? null;
    if (!isDeepStrictEqual(current, promotion.expectedBaseline)) {
      return { state: 'conflict', currentBaselineId };
    }

    const marker: StoredCompletedAnalysisPromotion = {
      schemaVersion: 1,
      filename,
      analysisId: promotion.snapshot.id,
      expectedBaselineId: promotion.expectedBaseline?.analysis.id ?? null,
      expectedBaselineFingerprint: promotion.expectedBaseline
        ? fingerprint(promotion.expectedBaseline)
        : null,
      promotionFingerprint: fingerprint(promotion),
    };
    const existingMarker = this.readStoredPromotion(repoPath, filename);
    if (existingMarker && !isDeepStrictEqual(existingMarker, marker)) {
      throw new Error('Prepared promotion marker does not match the promotion candidate');
    }
    if (!existingMarker) {
      atomicWriteJson(promotionMarkerPath(repoPath, filename), marker);
      await options.faultInjector?.('after-marker');
    }

    const existingSnapshot = this.readAnalysisUnpatched(repoPath, filename);
    if (existingSnapshot && !isDeepStrictEqual(existingSnapshot, promotion.snapshot)) {
      throw new Error('Prepared analysis snapshot does not match the promotion candidate');
    }
    if (!existingSnapshot) atomicWriteJson(analysisFilePath(repoPath, filename), promotion.snapshot);

    await options.faultInjector?.('after-prepare');

    // Recheck immediately before the commit point. The lifecycle lock prevents
    // cooperating writers from racing; this also fails closed for stray ones.
    const beforeCommit = this.readLatestUncached(repoPath);
    const beforeCommitId = beforeCommit?.analysis.id ?? null;
    if (!isDeepStrictEqual(beforeCommit, promotion.expectedBaseline)) {
      if (beforeCommitId === promotion.snapshot.id && isDeepStrictEqual(beforeCommit, promotion.latest)) {
        this.removePromotionMarker(repoPath, filename);
        return { state: 'already-promoted', filename };
      }
      return { state: 'conflict', currentBaselineId: beforeCommitId };
    }

    await this.writeLatest(repoPath, promotion.latest);
    await options.faultInjector?.('after-commit');
    this.removePromotionMarker(repoPath, filename);
    return { state: 'promoted', filename };
  }

  async readAnalysis(repoPath: string, filename: string): Promise<AnalysisSnapshot | null> {
    const file = analysisFilePath(repoPath, filename);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as AnalysisSnapshot;
    patchViolations(data.violations?.added);
    return data;
  }

  async listAnalyses(repoPath: string): Promise<string[]> {
    const dir = analysesDir(repoPath);
    if (!fs.existsSync(dir)) return [];
    const committedHead = this.readLatestUncached(repoPath)?.head ?? null;
    const prepared = fs.existsSync(promotionsDir(repoPath))
      ? new Set(fs.readdirSync(promotionsDir(repoPath)).filter((name) => name.endsWith('.json')))
      : new Set<string>();
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .filter((name) => !prepared.has(name) || name === committedHead)
      .sort();
  }

  async findAnalysisFilename(repoPath: string, analysisId: string): Promise<string | null> {
    for (const name of (await this.listAnalyses(repoPath)).reverse()) {
      const snap = await this.readAnalysis(repoPath, name);
      if (snap?.id === analysisId) return name;
    }
    return null;
  }

  async deleteAnalysis(repoPath: string, filename: string): Promise<void> {
    try {
      fs.unlinkSync(analysisFilePath(repoPath, filename));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async readHistory(repoPath: string): Promise<History> {
    const file = historyPath(repoPath);
    if (!fs.existsSync(file)) return { analyses: [] };
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as History;
  }

  async appendHistory(repoPath: string, entry: HistoryEntry): Promise<void> {
    const history = await this.readHistory(repoPath);
    history.analyses.push(entry);
    atomicWriteJson(historyPath(repoPath), history);
  }

  /** Idempotent, recovery-safe history insertion under the analyze lock. */
  async ensureHistoryEntry(
    repoPath: string,
    entry: HistoryEntry,
  ): Promise<EnsureHistoryEntryResult> {
    validateHistoryEntryForPersistence(entry);
    const history = await this.readHistory(repoPath);
    const matching = history.analyses.filter((candidate) => candidate.id === entry.id);
    if (matching.length > 0) {
      if (matching.length !== 1 || !isDeepStrictEqual(matching[0], entry)) {
        throw new Error('History entry conflicts with the stored analysis ID');
      }
      return 'present';
    }
    history.analyses.push(entry);
    history.analyses.sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
    atomicWriteJson(historyPath(repoPath), history);
    return 'inserted';
  }

  async removeFromHistory(repoPath: string, analysisId: string): Promise<void> {
    const history = await this.readHistory(repoPath);
    const next = history.analyses.filter((a) => a.id !== analysisId);
    if (next.length === history.analyses.length) return;
    atomicWriteJson(historyPath(repoPath), { analyses: next });
  }

  async readDiff(repoPath: string): Promise<DiffSnapshot | null> {
    const file = diffPath(repoPath);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as DiffSnapshot;
    patchViolations(data.newViolations);
    patchViolations(data.resolvedViolations);
    return data;
  }

  async writeDiff(repoPath: string, diff: DiffSnapshot): Promise<void> {
    atomicWriteJson(diffPath(repoPath), diff);
  }

  async deleteDiff(repoPath: string): Promise<void> {
    try {
      fs.unlinkSync(diffPath(repoPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async reconcileDiffWithLatest(repoPath: string): Promise<ReconcileDiffResult> {
    const baselineId = activeCompletedBaselineId(this.readLatestUncached(repoPath));
    const diff = await this.readDiff(repoPath);
    if (!diff) return 'absent';
    if (diff.baseAnalysisId === baselineId) return 'current';
    await this.deleteDiff(repoPath);
    return 'removed-stale';
  }
}

// ---------------------------------------------------------------------------
// Active store registry + public delegators (same names as before, now async).
// ---------------------------------------------------------------------------

let active: AnalysisStore = new FileAnalysisStore();

/** The active analysis store (file-backed unless EE installed a Postgres one). */
export function getAnalysisStore(): AnalysisStore {
  return active;
}
/** Install an analysis store (e.g. the enterprise Postgres/Blob impl). */
export function setAnalysisStore(store: AnalysisStore): void {
  active = store;
}
/** Restore the file-backed default (tests). */
export function resetAnalysisStore(): void {
  active = new FileAnalysisStore();
}

export const readLatest = (repoPath: string): Promise<LatestSnapshot | null> =>
  active.readLatest(repoPath);
export const writeLatest = (repoPath: string, latest: LatestSnapshot): Promise<void> =>
  active.writeLatest(repoPath, latest);
export const deleteLatest = (repoPath: string): Promise<void> =>
  active.deleteLatest(repoPath);
export const writeAnalysis = (repoPath: string, snapshot: AnalysisSnapshot): Promise<WrittenAnalysis> =>
  active.writeAnalysis(repoPath, snapshot);
export const promoteCompletedAnalysisBaseline = (
  repoPath: string,
  promotion: CompletedAnalysisPromotion,
  options?: AnalysisPromotionOptions,
): Promise<CompletedAnalysisPromotionResult> =>
  active.promoteCompletedAnalysisBaseline(repoPath, promotion, options);
export const readAnalysis = (repoPath: string, filename: string): Promise<AnalysisSnapshot | null> =>
  active.readAnalysis(repoPath, filename);
export const listAnalyses = (repoPath: string): Promise<string[]> =>
  active.listAnalyses(repoPath);
export const findAnalysisFilename = (repoPath: string, analysisId: string): Promise<string | null> =>
  active.findAnalysisFilename(repoPath, analysisId);
export const deleteAnalysis = (repoPath: string, filename: string): Promise<void> =>
  active.deleteAnalysis(repoPath, filename);
export const readHistory = (repoPath: string): Promise<History> =>
  active.readHistory(repoPath);
export const appendHistory = (repoPath: string, entry: HistoryEntry): Promise<void> =>
  active.appendHistory(repoPath, entry);
/** Call only while holding the repository lifecycle lock. */
export const ensureHistoryEntry = (
  repoPath: string,
  entry: HistoryEntry,
): Promise<EnsureHistoryEntryResult> =>
  active.ensureHistoryEntry(repoPath, entry);
export const removeFromHistory = (repoPath: string, analysisId: string): Promise<void> =>
  active.removeFromHistory(repoPath, analysisId);
export const readDiff = (repoPath: string): Promise<DiffSnapshot | null> =>
  active.readDiff(repoPath);
export const writeDiff = (repoPath: string, diff: DiffSnapshot): Promise<void> =>
  active.writeDiff(repoPath, diff);
export const deleteDiff = (repoPath: string): Promise<void> =>
  active.deleteDiff(repoPath);
/** Call only for the canonical repository key while holding its lifecycle lock. */
export const reconcileDiffWithLatest = (repoPath: string): Promise<ReconcileDiffResult> =>
  active.reconcileDiffWithLatest(repoPath);

/** Clear the LATEST.json in-memory cache (tests). File impl only. */
export function clearLatestCache(): void {
  latestCache.clear();
}
