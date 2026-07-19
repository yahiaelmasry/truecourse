import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema, MIGRATIONS_DIR, type EeDb } from '@truecourse/ee-db';
import { PgAnalysisStore } from '../../ee/packages/data-store/src/index';
import type {
  AnalysisSnapshot,
  LatestSnapshot,
  HistoryEntry,
  DiffSnapshot,
  ViolationRecord,
  ViolationWithNames,
} from '@truecourse/core/types/snapshot';
import { buildAnalysisFilename } from '@truecourse/core/lib/analysis-store';

const REPO = 'workspace-1/my-repo';

let client: PGlite;
let db: EeDb;

beforeEach(async () => {
  client = new PGlite();
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS_DIR });
  db = d as unknown as EeDb;
});
afterEach(async () => {
  await client.close();
});

/** A minimal AnalysisSnapshot (only the fields the store round-trips). */
const snap = (id: string, createdAt: string): AnalysisSnapshot =>
  ({
    id,
    createdAt,
    branch: 'main',
    commitHash: id,
    architecture: 'monolith',
    status: 'completed',
    metadata: null,
    graph: {
      services: [],
      serviceDependencies: [],
      layers: [],
      modules: [],
      methods: [],
      moduleDeps: [],
      methodDeps: [],
      databases: [],
      databaseConnections: [],
      flows: [],
    },
    violations: { added: [], resolved: [], previousAnalysisId: null },
    usage: [],
  }) as unknown as AnalysisSnapshot;

const latestFor = (snapshot: AnalysisSnapshot): LatestSnapshot => ({
  head: buildAnalysisFilename(snapshot.id, snapshot.createdAt),
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
  violations: [],
});

const violation = (
  id: string,
  status: ViolationRecord['status'],
  createdAt: string,
  overrides: Partial<ViolationRecord> = {},
): ViolationRecord => ({
  id,
  type: 'code',
  category: 'rule',
  subcategory: null,
  title: `Finding ${id}`,
  content: 'finding content',
  severity: 'high',
  status,
  targetServiceId: null,
  targetDatabaseId: null,
  targetModuleId: null,
  targetMethodId: null,
  targetTable: null,
  relatedServiceId: null,
  relatedModuleId: null,
  fixPrompt: null,
  ruleKey: 'test/rule',
  firstSeenAnalysisId: 'first-analysis',
  firstSeenAt: '2025-12-31T00:00:00.000Z',
  previousViolationId: null,
  resolvedAt: null,
  filePath: 'src/example.ts',
  lineStart: 1,
  lineEnd: 1,
  columnStart: 1,
  columnEnd: 5,
  snippet: 'value',
  createdAt,
  ...overrides,
});

const withNames = (row: ViolationRecord): ViolationWithNames => ({
  ...row,
  targetServiceName: null,
  targetModuleName: null,
  targetMethodName: null,
  targetDatabaseName: null,
});

describe('PgAnalysisStore (analyses / analysis_current / analysis_history)', () => {
  it('writeAnalysis → readAnalysis / listAnalyses / findAnalysisFilename round-trip', async () => {
    const store = new PgAnalysisStore(db);
    expect(await store.listAnalyses(REPO)).toEqual([]);

    const s1 = snap('a1', '2026-01-01T00:00:00.000Z');
    const s2 = snap('a2', '2026-01-02T00:00:00.000Z');
    const w1 = await store.writeAnalysis(REPO, s1);
    const w2 = await store.writeAnalysis(REPO, s2);
    expect(w1.filename).toBe(buildAnalysisFilename('a1', s1.createdAt));

    // Oldest-first, ISO-prefixed → lexicographically sortable.
    expect(await store.listAnalyses(REPO)).toEqual([w1.filename, w2.filename]);
    expect((await store.readAnalysis(REPO, w2.filename))?.id).toBe('a2');
    expect(await store.findAnalysisFilename(REPO, 'a1')).toBe(w1.filename);
    expect(await store.findAnalysisFilename(REPO, 'nope')).toBeNull();

    await store.deleteAnalysis(REPO, w1.filename);
    expect(await store.listAnalyses(REPO)).toEqual([w2.filename]);
  });

  it('LATEST + diff are mutable per-repo singletons', async () => {
    const store = new PgAnalysisStore(db);
    expect(await store.readLatest(REPO)).toBeNull();

    const l1 = { head: 'analyses/x.json', analysis: { id: 'a1' }, graph: {}, violations: [] } as unknown as LatestSnapshot;
    await store.writeLatest(REPO, l1);
    expect((await store.readLatest(REPO) as { analysis: { id: string } }).analysis.id).toBe('a1');

    // overwrite (singleton, not append)
    const l2 = { head: 'analyses/y.json', analysis: { id: 'a2' }, graph: {}, violations: [] } as unknown as LatestSnapshot;
    await store.writeLatest(REPO, l2);
    expect((await store.readLatest(REPO) as { analysis: { id: string } }).analysis.id).toBe('a2');

    await store.deleteLatest(REPO);
    expect(await store.readLatest(REPO)).toBeNull();

    // diff is an independent singleton
    expect(await store.readDiff(REPO)).toBeNull();
    await store.writeDiff(REPO, { id: 'd1', baseAnalysisId: 'a1' } as unknown as DiffSnapshot);
    expect((await store.readDiff(REPO) as { id: string }).id).toBe('d1');
    await store.deleteDiff(REPO);
    expect(await store.readDiff(REPO)).toBeNull();
  });

  it('reconciles only diffs stale against the active completed baseline', async () => {
    const store = new PgAnalysisStore(db);
    const first = snap('a1', '2026-01-01T00:00:00.000Z');
    await store.writeLatest(REPO, latestFor(first));
    await store.writeDiff(REPO, { id: 'old', baseAnalysisId: 'older' } as unknown as DiffSnapshot);

    await expect(store.reconcileDiffWithLatest(REPO)).resolves.toBe('removed-stale');
    await expect(store.reconcileDiffWithLatest(REPO)).resolves.toBe('absent');

    const second = snap('a2', '2026-01-02T00:00:00.000Z');
    await store.writeLatest(REPO, latestFor(second));
    const current = { id: 'current', baseAnalysisId: second.id } as unknown as DiffSnapshot;
    await store.writeDiff(REPO, current);
    // A delayed repair for the first promotion must preserve the newer diff.
    await expect(store.reconcileDiffWithLatest(REPO)).resolves.toBe('current');
    expect(await store.readDiff(REPO)).toEqual(current);

    await store.writeDiff(REPO, {
      id: 'old-repair',
      baseAnalysisId: first.id,
    } as unknown as DiffSnapshot);
    await expect(store.reconcileDiffWithLatest(REPO)).resolves.toBe('removed-stale');
    expect(await store.readDiff(REPO)).toBeNull();
  });

  it('preserves a diff when no completed baseline exists', async () => {
    const store = new PgAnalysisStore(db);
    const diff = { id: 'orphan', baseAnalysisId: 'missing' } as unknown as DiffSnapshot;
    await store.writeDiff(REPO, diff);

    await expect(store.reconcileDiffWithLatest(REPO)).rejects.toThrow(
      'Cannot reconcile diff without an active completed baseline',
    );
    expect(await store.readDiff(REPO)).toEqual(diff);

    const corrupt = latestFor(snap('corrupt', '2026-01-01T00:00:00.000Z'));
    corrupt.head = 'wrong-head.json';
    await store.writeLatest(REPO, corrupt);
    await expect(store.reconcileDiffWithLatest(REPO)).rejects.toThrow(
      'Cannot reconcile diff without an active completed baseline',
    );
    expect(await store.readDiff(REPO)).toEqual(diff);
  });

  it('promotes the completed baseline transactionally and rejects a stale expectation', async () => {
    const store = new PgAnalysisStore(db);
    const previous = snap('a1', '2026-01-01T00:00:00.000Z');
    await store.writeAnalysis(REPO, previous);
    const previousLatest = latestFor(previous);
    const carriedPrevious = withNames(violation('carry-old', 'new', previous.createdAt));
    const resolvedPrevious = withNames(violation('resolve-old', 'new', previous.createdAt, {
      title: 'Resolved finding',
    }));
    previousLatest.violations = [carriedPrevious, resolvedPrevious];
    await store.writeLatest(REPO, previousLatest);

    const candidate = {
      ...snap('a2', '2026-01-02T00:00:00.000Z'),
    };
    const added = violation('added-new', 'new', candidate.createdAt, {
      firstSeenAnalysisId: candidate.id,
      firstSeenAt: candidate.createdAt,
      title: 'New finding',
    });
    candidate.violations = {
      added: [added],
      resolved: [{ id: resolvedPrevious.id, resolvedAt: candidate.createdAt }],
      previousAnalysisId: previous.id,
    };
    const candidateLatest = latestFor(candidate);
    candidateLatest.violations = [
      withNames(added),
      withNames(violation('carry-new', 'unchanged', candidate.createdAt, {
        firstSeenAnalysisId: carriedPrevious.firstSeenAnalysisId,
        firstSeenAt: carriedPrevious.firstSeenAt,
        previousViolationId: carriedPrevious.id,
      })),
    ];
    await expect(store.promoteCompletedAnalysisBaseline(REPO, {
      expectedBaseline: previousLatest,
      snapshot: candidate,
      latest: candidateLatest,
    })).resolves.toEqual({
      state: 'promoted',
      filename: buildAnalysisFilename(candidate.id, candidate.createdAt),
    });

    const staleBaselineSnapshot = snap('stale-baseline', '2025-12-30T00:00:00.000Z');
    const staleBaseline = latestFor(staleBaselineSnapshot);
    const stale = {
      ...snap('a3', '2026-01-03T00:00:00.000Z'),
      violations: { added: [], resolved: [], previousAnalysisId: staleBaselineSnapshot.id },
    };
    await expect(store.promoteCompletedAnalysisBaseline(REPO, {
      expectedBaseline: staleBaseline,
      snapshot: stale,
      latest: latestFor(stale),
    })).resolves.toEqual({ state: 'conflict', currentBaselineId: candidate.id });
    expect((await store.readLatest(REPO))?.analysis.id).toBe(candidate.id);
    expect(await store.readAnalysis(REPO, buildAnalysisFilename(stale.id, stale.createdAt))).toBeNull();
  });

  it('rolls back a pre-commit fault and recognizes a retry after a post-commit fault', async () => {
    const store = new PgAnalysisStore(db);
    const previous = snap('a1', '2026-01-01T00:00:00.000Z');
    await store.writeAnalysis(REPO, previous);
    const previousLatest = latestFor(previous);
    await store.writeLatest(REPO, previousLatest);

    const candidate = {
      ...snap('a2', '2026-01-02T00:00:00.000Z'),
      violations: { added: [], resolved: [], previousAnalysisId: previous.id },
    };
    const promotion = {
      expectedBaseline: previousLatest,
      snapshot: candidate,
      latest: latestFor(candidate),
    };
    const filename = buildAnalysisFilename(candidate.id, candidate.createdAt);

    await expect(store.promoteCompletedAnalysisBaseline(REPO, promotion, {
      faultInjector: (point) => {
        if (point === 'after-prepare') throw new Error('injected transaction rollback');
      },
    })).rejects.toThrow('injected transaction rollback');
    expect((await store.readLatest(REPO))?.analysis.id).toBe(previous.id);
    expect(await store.readAnalysis(REPO, filename)).toBeNull();

    await expect(store.promoteCompletedAnalysisBaseline(REPO, promotion, {
      faultInjector: (point) => {
        if (point === 'after-commit') throw new Error('injected ambiguous commit');
      },
    })).rejects.toThrow('injected ambiguous commit');
    expect((await store.readLatest(REPO))?.analysis.id).toBe(candidate.id);
    await expect(store.promoteCompletedAnalysisBaseline(REPO, promotion)).resolves.toEqual({
      state: 'already-promoted',
      filename,
    });
  });

  it('atomically admits only one of two promotions from the same completed baseline', async () => {
    const firstStore = new PgAnalysisStore(db);
    const secondStore = new PgAnalysisStore(db);
    const previous = snap('a1', '2026-01-01T00:00:00.000Z');
    await firstStore.writeAnalysis(REPO, previous);
    const previousLatest = latestFor(previous);
    await firstStore.writeLatest(REPO, previousLatest);

    const first = {
      ...snap('a2', '2026-01-02T00:00:00.000Z'),
      violations: { added: [], resolved: [], previousAnalysisId: previous.id },
    };
    const second = {
      ...snap('a3', '2026-01-03T00:00:00.000Z'),
      violations: { added: [], resolved: [], previousAnalysisId: previous.id },
    };
    const results = await Promise.all([
      firstStore.promoteCompletedAnalysisBaseline(REPO, {
        expectedBaseline: previousLatest,
        snapshot: first,
        latest: latestFor(first),
      }),
      secondStore.promoteCompletedAnalysisBaseline(REPO, {
        expectedBaseline: previousLatest,
        snapshot: second,
        latest: latestFor(second),
      }),
    ]);

    expect(results.map((result) => result.state).sort()).toEqual(['conflict', 'promoted']);
    const currentId = (await firstStore.readLatest(REPO))?.analysis.id;
    expect([first.id, second.id]).toContain(currentId);
    const losing = currentId === first.id ? second : first;
    expect(await firstStore.readAnalysis(
      REPO,
      buildAnalysisFilename(losing.id, losing.createdAt),
    )).toBeNull();
  });

  it('appendHistory accumulates; removeFromHistory drops by analysis id', async () => {
    const store = new PgAnalysisStore(db);
    expect((await store.readHistory(REPO)).analyses).toEqual([]);

    const entry = (id: string): HistoryEntry =>
      ({ id, filename: `f-${id}`, createdAt: '2026-01-01T00:00:00.000Z' } as unknown as HistoryEntry);
    await store.appendHistory(REPO, entry('a1'));
    await store.appendHistory(REPO, entry('a2'));
    expect((await store.readHistory(REPO)).analyses.map((e) => e.id)).toEqual(['a1', 'a2']);

    await store.removeFromHistory(REPO, 'a1');
    expect((await store.readHistory(REPO)).analyses.map((e) => e.id)).toEqual(['a2']);
  });

  it('ensures one exact history entry and orders late recovery by analysis time', async () => {
    const store = new PgAnalysisStore(db);
    const entry = (id: string, createdAt: string): HistoryEntry => ({
      id,
      filename: `f-${id}`,
      createdAt,
    } as unknown as HistoryEntry);
    const later = entry('later', '2026-01-02T00:00:00.000Z');
    const earlier = entry('earlier', '2026-01-01T00:00:00.000Z');

    await expect(store.ensureHistoryEntry(REPO, later)).resolves.toBe('inserted');
    await expect(store.ensureHistoryEntry(REPO, earlier)).resolves.toBe('inserted');
    await expect(store.ensureHistoryEntry(REPO, earlier)).resolves.toBe('present');
    expect((await store.readHistory(REPO)).analyses).toEqual([earlier, later]);

    await expect(store.ensureHistoryEntry(REPO, {
      ...earlier,
      filename: 'conflicting.json',
    })).rejects.toThrow('History entry conflicts with the stored analysis ID');
  });

  it('rejects history entries that jsonb persistence would change', async () => {
    const store = new PgAnalysisStore(db);
    const entry = {
      id: 'non-json-entry',
      filename: 'non-json-entry.json',
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: { values: [undefined] },
    } as unknown as HistoryEntry;

    await expect(store.ensureHistoryEntry(REPO, entry)).rejects.toThrow(
      'History entry must be exactly JSON-round-trippable',
    );
    expect((await store.readHistory(REPO)).analyses).toEqual([]);
  });

  it('keys by repoKey — a different repo sees nothing', async () => {
    const store = new PgAnalysisStore(db);
    await store.writeAnalysis(REPO, snap('a1', '2026-01-01T00:00:00.000Z'));
    expect(await store.listAnalyses('other-org/other-repo')).toEqual([]);
  });
});
