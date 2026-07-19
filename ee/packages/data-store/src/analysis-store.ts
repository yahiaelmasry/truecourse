/**
 * Postgres implementation of core's `AnalysisStore` — the hosted home for the
 * analyze ("Code Quality") engine's output. Each per-analysis snapshot, the
 * mutable LATEST + diff singletons, and the append-only history index are stored
 * as jsonb rows keyed by the repoKey the caller passes as `repoPath` (the repo
 * identity, e.g. `owner/repo`). Mirrors the file store's semantics exactly — see
 * `@truecourse/core/lib/analysis-store`.
 */

import { isDeepStrictEqual } from 'node:util';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { analyses, analysisCurrent, analysisHistory, type EeDb } from '@truecourse/ee-db';
import {
  activeCompletedBaselineId,
  buildAnalysisFilename,
  type AnalysisStore,
  type EnsureHistoryEntryResult,
  type ReconcileDiffResult,
  type WrittenAnalysis,
  validateHistoryEntryForPersistence,
} from '@truecourse/core/lib/analysis-store';
import {
  certifyCompletedAnalysisLineageSnapshots,
  type CompletedAnalysisLineageCertification,
} from '@truecourse/core/lib/completed-analysis-lineage';
import {
  validateCompletedAnalysisPromotion,
  type AnalysisPromotionOptions,
  type CompletedAnalysisPromotion,
  type CompletedAnalysisPromotionResult,
} from '@truecourse/core/lib/completed-analysis-promotion';
import type {
  AnalysisSnapshot,
  DiffSnapshot,
  History,
  HistoryEntry,
  LatestSnapshot,
} from '@truecourse/core/types/snapshot';

type CurrentKind = 'latest' | 'diff';

export class PgAnalysisStore implements AnalysisStore {
  constructor(private readonly db: EeDb) {}

  // ---- mutable per-repo singletons (LATEST / diff) ----

  private async readCurrent<T>(repoKey: string, kind: CurrentKind): Promise<T | null> {
    const [row] = await this.db
      .select({ body: analysisCurrent.body })
      .from(analysisCurrent)
      .where(and(eq(analysisCurrent.repoKey, repoKey), eq(analysisCurrent.kind, kind)))
      .limit(1);
    return row ? (row.body as T) : null;
  }

  private async writeCurrent(repoKey: string, kind: CurrentKind, body: unknown): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insert(analysisCurrent)
      .values({ repoKey, kind, body, updatedAt: now })
      .onConflictDoUpdate({
        target: [analysisCurrent.repoKey, analysisCurrent.kind],
        set: { body, updatedAt: now },
      });
  }

  private async deleteCurrent(repoKey: string, kind: CurrentKind): Promise<void> {
    await this.db
      .delete(analysisCurrent)
      .where(and(eq(analysisCurrent.repoKey, repoKey), eq(analysisCurrent.kind, kind)));
  }

  readLatest(repoKey: string): Promise<LatestSnapshot | null> {
    return this.readCurrent<LatestSnapshot>(repoKey, 'latest');
  }
  writeLatest(repoKey: string, latest: LatestSnapshot): Promise<void> {
    return this.writeCurrent(repoKey, 'latest', latest);
  }
  deleteLatest(repoKey: string): Promise<void> {
    return this.deleteCurrent(repoKey, 'latest');
  }

  readDiff(repoKey: string): Promise<DiffSnapshot | null> {
    return this.readCurrent<DiffSnapshot>(repoKey, 'diff');
  }
  writeDiff(repoKey: string, diff: DiffSnapshot): Promise<void> {
    return this.writeCurrent(repoKey, 'diff', diff);
  }
  deleteDiff(repoKey: string): Promise<void> {
    return this.deleteCurrent(repoKey, 'diff');
  }
  async reconcileDiffWithLatest(repoKey: string): Promise<ReconcileDiffResult> {
    const baselineId = activeCompletedBaselineId(await this.readLatest(repoKey));
    const diff = await this.readDiff(repoKey);
    if (!diff) return 'absent';
    if (diff.baseAnalysisId === baselineId) return 'current';
    await this.deleteDiff(repoKey);
    return 'removed-stale';
  }

  // ---- per-analysis snapshots ----

  async writeAnalysis(repoKey: string, snapshot: AnalysisSnapshot): Promise<WrittenAnalysis> {
    const filename = buildAnalysisFilename(snapshot.id, snapshot.createdAt);
    await this.db
      .insert(analyses)
      .values({ repoKey, filename, analysisId: snapshot.id, snapshot, createdAt: snapshot.createdAt })
      .onConflictDoUpdate({
        target: [analyses.repoKey, analyses.filename],
        set: { analysisId: snapshot.id, snapshot, createdAt: snapshot.createdAt },
      });
    return { filename, snapshot };
  }

  /**
   * Transactional equivalent of the file store's completed-baseline commit.
   * Callers must hold the repository lifecycle lock. Snapshot preparation and
   * the LATEST replacement commit together, so no hidden marker is needed.
   */
  async promoteCompletedAnalysisBaseline(
    repoKey: string,
    promotion: CompletedAnalysisPromotion,
    options: AnalysisPromotionOptions = {},
  ): Promise<CompletedAnalysisPromotionResult> {
    const filename = buildAnalysisFilename(promotion.snapshot.id, promotion.snapshot.createdAt);
    validateCompletedAnalysisPromotion(promotion, filename);
    const result = await this.db.transaction(async (tx): Promise<CompletedAnalysisPromotionResult> => {
      const [currentRow] = await tx
        .select({ body: analysisCurrent.body })
        .from(analysisCurrent)
        .where(and(eq(analysisCurrent.repoKey, repoKey), eq(analysisCurrent.kind, 'latest')))
        .limit(1);
      const current = currentRow ? currentRow.body as LatestSnapshot : null;

      if (current?.analysis.id === promotion.snapshot.id) {
        const [snapshotRow] = await tx
          .select({ snapshot: analyses.snapshot })
          .from(analyses)
          .where(and(eq(analyses.repoKey, repoKey), eq(analyses.filename, filename)))
          .limit(1);
        if (!snapshotRow || !isDeepStrictEqual(snapshotRow.snapshot, promotion.snapshot)) {
          throw new Error('Committed analysis snapshot does not match the promotion candidate');
        }
        if (!isDeepStrictEqual(current, promotion.latest)) {
          throw new Error('Committed LATEST does not match the promotion candidate');
        }
        return { state: 'already-promoted', filename };
      }

      const currentBaselineId = current?.analysis.id ?? null;
      if (!isDeepStrictEqual(current, promotion.expectedBaseline)) {
        return { state: 'conflict', currentBaselineId };
      }

      const now = new Date().toISOString();
      const swapped = promotion.expectedBaseline === null
        ? await tx
            .insert(analysisCurrent)
            .values({ repoKey, kind: 'latest', body: promotion.latest, updatedAt: now })
            .onConflictDoNothing()
            .returning({ body: analysisCurrent.body })
        : await tx
            .update(analysisCurrent)
            .set({ body: promotion.latest, updatedAt: now })
            .where(and(
              eq(analysisCurrent.repoKey, repoKey),
              eq(analysisCurrent.kind, 'latest'),
              sql`${analysisCurrent.body} = ${JSON.stringify(promotion.expectedBaseline)}::jsonb`,
            ))
            .returning({ body: analysisCurrent.body });

      if (swapped.length === 0) {
        const [observedRow] = await tx
          .select({ body: analysisCurrent.body })
          .from(analysisCurrent)
          .where(and(eq(analysisCurrent.repoKey, repoKey), eq(analysisCurrent.kind, 'latest')))
          .limit(1);
        const observed = observedRow ? observedRow.body as LatestSnapshot : null;
        if (observed?.analysis.id === promotion.snapshot.id && isDeepStrictEqual(observed, promotion.latest)) {
          const [snapshotRow] = await tx
            .select({ snapshot: analyses.snapshot })
            .from(analyses)
            .where(and(eq(analyses.repoKey, repoKey), eq(analyses.filename, filename)))
            .limit(1);
          if (!snapshotRow || !isDeepStrictEqual(snapshotRow.snapshot, promotion.snapshot)) {
            throw new Error('Committed analysis snapshot does not match the promotion candidate');
          }
          return { state: 'already-promoted', filename };
        }
        return { state: 'conflict', currentBaselineId: observed?.analysis.id ?? null };
      }

      const [existingSnapshot] = await tx
        .select({ snapshot: analyses.snapshot })
        .from(analyses)
        .where(and(eq(analyses.repoKey, repoKey), eq(analyses.filename, filename)))
        .limit(1);
      if (existingSnapshot && !isDeepStrictEqual(existingSnapshot.snapshot, promotion.snapshot)) {
        throw new Error('Prepared analysis snapshot does not match the promotion candidate');
      }
      if (!existingSnapshot) {
        await tx.insert(analyses).values({
          repoKey,
          filename,
          analysisId: promotion.snapshot.id,
          snapshot: promotion.snapshot,
          createdAt: promotion.snapshot.createdAt,
        });
      }

      await options.faultInjector?.('after-prepare');
      return { state: 'promoted', filename };
    });

    if (result.state === 'promoted') await options.faultInjector?.('after-commit');
    return result;
  }

  async certifyCompletedAnalysisLineage(
    repoKey: string,
    promotedSnapshot: AnalysisSnapshot,
  ): Promise<CompletedAnalysisLineageCertification> {
    const latest = await this.readLatest(repoKey);
    activeCompletedBaselineId(latest);
    const rows = await this.db
      .select({ filename: analyses.filename, snapshot: analyses.snapshot })
      .from(analyses)
      .where(eq(analyses.repoKey, repoKey))
      .orderBy(asc(analyses.filename));
    return certifyCompletedAnalysisLineageSnapshots(
      latest!,
      promotedSnapshot,
      rows.map((row) => ({
        filename: row.filename,
        snapshot: row.snapshot as AnalysisSnapshot,
      })),
      buildAnalysisFilename,
    );
  }

  async readAnalysis(repoKey: string, filename: string): Promise<AnalysisSnapshot | null> {
    const [row] = await this.db
      .select({ snapshot: analyses.snapshot })
      .from(analyses)
      .where(and(eq(analyses.repoKey, repoKey), eq(analyses.filename, filename)))
      .limit(1);
    return row ? (row.snapshot as AnalysisSnapshot) : null;
  }

  /** Filenames for the repo, oldest-first (ISO-prefixed → lexicographically sortable). */
  async listAnalyses(repoKey: string): Promise<string[]> {
    const rows = await this.db
      .select({ filename: analyses.filename })
      .from(analyses)
      .where(eq(analyses.repoKey, repoKey))
      .orderBy(asc(analyses.filename));
    return rows.map((r) => r.filename);
  }

  async findAnalysisFilename(repoKey: string, analysisId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ filename: analyses.filename })
      .from(analyses)
      .where(and(eq(analyses.repoKey, repoKey), eq(analyses.analysisId, analysisId)))
      .orderBy(desc(analyses.filename))
      .limit(1);
    return row ? row.filename : null;
  }

  async deleteAnalysis(repoKey: string, filename: string): Promise<void> {
    await this.db
      .delete(analyses)
      .where(and(eq(analyses.repoKey, repoKey), eq(analyses.filename, filename)));
  }

  // ---- append-only history index ----

  async readHistory(repoKey: string): Promise<History> {
    const rows = await this.db
      .select({ entry: analysisHistory.entry })
      .from(analysisHistory)
      .where(eq(analysisHistory.repoKey, repoKey))
      .orderBy(
        asc(analysisHistory.createdAt),
        asc(analysisHistory.analysisId),
        asc(analysisHistory.id),
      );
    return { analyses: rows.map((r) => r.entry as HistoryEntry) };
  }

  async appendHistory(repoKey: string, entry: HistoryEntry): Promise<void> {
    await this.db
      .insert(analysisHistory)
      .values({ repoKey, analysisId: entry.id, entry, createdAt: entry.createdAt });
  }

  /** Idempotent, recovery-safe history insertion under the repository lock. */
  async ensureHistoryEntry(
    repoKey: string,
    entry: HistoryEntry,
  ): Promise<EnsureHistoryEntryResult> {
    validateHistoryEntryForPersistence(entry);
    const matching = await this.db
      .select({ entry: analysisHistory.entry })
      .from(analysisHistory)
      .where(and(
        eq(analysisHistory.repoKey, repoKey),
        eq(analysisHistory.analysisId, entry.id),
      ));
    if (matching.length > 0) {
      if (matching.length !== 1 || !isDeepStrictEqual(matching[0].entry, entry)) {
        throw new Error('History entry conflicts with the stored analysis ID');
      }
      return 'present';
    }
    await this.db
      .insert(analysisHistory)
      .values({ repoKey, analysisId: entry.id, entry, createdAt: entry.createdAt });
    return 'inserted';
  }

  async removeFromHistory(repoKey: string, analysisId: string): Promise<void> {
    await this.db
      .delete(analysisHistory)
      .where(and(eq(analysisHistory.repoKey, repoKey), eq(analysisHistory.analysisId, analysisId)));
  }
}
