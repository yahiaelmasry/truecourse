import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  analysisFilePath,
  appendHistory,
  buildAnalysisFilename,
  clearLatestCache,
  deleteAnalysis,
  deleteDiff,
  deleteLatest,
  diffPath,
  ensureHistoryEntry,
  historyPath,
  latestPath,
  listAnalyses,
  promoteCompletedAnalysisBaseline,
  reconcileDiffWithLatest,
  readAnalysis,
  readDiff,
  readHistory,
  readLatest,
  removeFromHistory,
  writeAnalysis,
  writeDiff,
  writeLatest,
} from '../../packages/core/src/lib/analysis-store';
import {
  acquireAnalyzeLock,
  AnalyzeLockError,
  atomicWriteJson,
  releaseAnalyzeLock,
} from '../../packages/core/src/lib/atomic-write';
import type {
  AnalysisSnapshot,
  DiffSnapshot,
  HistoryEntry,
  LatestSnapshot,
  ViolationRecord,
  ViolationWithNames,
} from '../../packages/core/src/types/snapshot';

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-store-'));
  clearLatestCache();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(): AnalysisSnapshot {
  const id = randomUUID();
  return {
    id,
    createdAt: '2026-04-17T14:23:45.123Z',
    branch: 'main',
    commitHash: 'abc1234',
    architecture: 'monolith',
    status: 'completed',
    metadata: { isDiffAnalysis: false },
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
    violations: {
      added: [],
      resolved: [],
      previousAnalysisId: null,
    },
    usage: [],
  };
}

function makeLatest(snapshot: AnalysisSnapshot, head: string): LatestSnapshot {
  return {
    head,
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
  };
}

function makeViolation(
  id: string,
  status: ViolationRecord['status'],
  createdAt: string,
  overrides: Partial<ViolationRecord> = {},
): ViolationRecord {
  return {
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
    firstSeenAt: '2026-04-16T00:00:00.000Z',
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
  };
}

function withNames(violation: ViolationRecord): ViolationWithNames {
  return {
    ...violation,
    targetServiceName: null,
    targetModuleName: null,
    targetMethodName: null,
    targetDatabaseName: null,
  };
}

// ---------------------------------------------------------------------------
// atomic-write
// ---------------------------------------------------------------------------

describe('atomicWriteJson', () => {
  it('creates parent directories and writes valid JSON', () => {
    const target = path.join(repoPath, 'nested/dir/file.json');
    atomicWriteJson(target, { hello: 'world' });
    expect(fs.existsSync(target)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ hello: 'world' });
  });

  it('leaves no tmp files behind after a successful write', () => {
    const target = path.join(repoPath, 'file.json');
    atomicWriteJson(target, { a: 1 });
    const leftover = fs.readdirSync(repoPath).filter((name) => name.startsWith('file.json.tmp'));
    expect(leftover).toEqual([]);
  });

  it('overwrites an existing file atomically', () => {
    const target = path.join(repoPath, 'file.json');
    atomicWriteJson(target, { v: 1 });
    atomicWriteJson(target, { v: 2 });
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ v: 2 });
  });
});

describe('analyze lock', () => {
  it('acquires and releases cleanly', async () => {
    await acquireAnalyzeLock(repoPath);
    expect(fs.existsSync(path.join(repoPath, '.truecourse/.analyze.lock'))).toBe(true);
    await releaseAnalyzeLock(repoPath);
    expect(fs.existsSync(path.join(repoPath, '.truecourse/.analyze.lock'))).toBe(false);
  });

  it('rejects a second acquire while held (file lock fail-fasts)', async () => {
    await acquireAnalyzeLock(repoPath);
    await expect(acquireAnalyzeLock(repoPath)).rejects.toThrowError(AnalyzeLockError);
    await releaseAnalyzeLock(repoPath);
  });

  it('release on a non-existent lock is a no-op', async () => {
    await expect(releaseAnalyzeLock(repoPath)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// filename builder
// ---------------------------------------------------------------------------

describe('buildAnalysisFilename', () => {
  it('is lexicographically sortable in chronological order', () => {
    const a = buildAnalysisFilename(randomUUID(), '2026-04-17T14:23:45.123Z');
    const b = buildAnalysisFilename(randomUUID(), '2026-04-17T14:30:10.456Z');
    const c = buildAnalysisFilename(randomUUID(), '2026-04-18T08:00:00.000Z');
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it('includes an 8-char UUID suffix to avoid same-second collisions', () => {
    const iso = '2026-04-17T14:23:45.123Z';
    const a = buildAnalysisFilename('11111111-2222-3333-4444-555555555555', iso);
    const b = buildAnalysisFilename('99999999-8888-7777-6666-555555555555', iso);
    expect(a).not.toEqual(b);
    expect(a.endsWith('_11111111.json')).toBe(true);
    expect(b.endsWith('_99999999.json')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// per-analysis snapshots
// ---------------------------------------------------------------------------

describe('analysis round-trip', () => {
  it('writes, reads back, and lists', async () => {
    const s1 = makeSnapshot();
    const s2 = { ...makeSnapshot(), createdAt: '2026-04-17T14:30:10.000Z' };
    const { filename: f1 } = await writeAnalysis(repoPath, s1);
    const { filename: f2 } = await writeAnalysis(repoPath, s2);

    expect(await readAnalysis(repoPath, f1)).toEqual(s1);
    expect(await readAnalysis(repoPath, f2)).toEqual(s2);
    expect(await listAnalyses(repoPath)).toEqual([f1, f2]);   // chronological order
    expect(fs.existsSync(analysisFilePath(repoPath, f1))).toBe(true);
  });

  it('readAnalysis returns null for missing files', async () => {
    expect(await readAnalysis(repoPath, 'does-not-exist.json')).toBeNull();
  });

  it('listAnalyses returns [] when the dir is absent', async () => {
    expect(await listAnalyses(repoPath)).toEqual([]);
  });

  it('deleteAnalysis removes the file; double-delete is safe', async () => {
    const s = makeSnapshot();
    const { filename } = await writeAnalysis(repoPath, s);
    await deleteAnalysis(repoPath, filename);
    expect(await readAnalysis(repoPath, filename)).toBeNull();
    await expect(deleteAnalysis(repoPath, filename)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LATEST.json
// ---------------------------------------------------------------------------

describe('LATEST round-trip', () => {
  it('returns null before any write', async () => {
    expect(await readLatest(repoPath)).toBeNull();
  });

  it('round-trips', async () => {
    const s = makeSnapshot();
    const latest = makeLatest(s, 'head.json');
    await writeLatest(repoPath, latest);
    expect(await readLatest(repoPath)).toEqual(latest);
  });

  it('invalidates the in-memory cache when the file changes on disk', async () => {
    const s = makeSnapshot();
    const v1 = makeLatest(s, 'head-1.json');
    await writeLatest(repoPath, v1);
    expect(await readLatest(repoPath)).toEqual(v1);

    const v2 = makeLatest(s, 'head-2.json');
    // Bump the file mtime forward so cache invalidation triggers even
    // when the two writes land within the same OS-reported millisecond
    // (common on fast tests; Linux's ext4 has sub-ms resolution but macOS APFS reports ms).
    const future = new Date(Date.now() + 1000);
    await writeLatest(repoPath, v2);
    fs.utimesSync(latestPath(repoPath), future, future);

    expect(await readLatest(repoPath)).toEqual(v2);
  });

  it('deleteLatest clears the file and cache', async () => {
    await writeLatest(repoPath, makeLatest(makeSnapshot(), 'h.json'));
    expect(fs.existsSync(latestPath(repoPath))).toBe(true);
    await deleteLatest(repoPath);
    expect(fs.existsSync(latestPath(repoPath))).toBe(false);
    expect(await readLatest(repoPath)).toBeNull();
  });

  it('recovers from a deleted file on next read', async () => {
    await writeLatest(repoPath, makeLatest(makeSnapshot(), 'h.json'));
    await readLatest(repoPath);                     // populate cache
    fs.unlinkSync(latestPath(repoPath));       // sneak a delete past the store
    expect(await readLatest(repoPath)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// completed-baseline promotion
// ---------------------------------------------------------------------------

describe('completed-baseline promotion', () => {
  it('promotes a prepared snapshot only when the expected baseline still matches', async () => {
    const previous = makeSnapshot();
    const { filename: previousFilename } = await writeAnalysis(repoPath, previous);
    const previousLatest = makeLatest(previous, previousFilename);
    await writeLatest(repoPath, previousLatest);

    const candidate = {
      ...makeSnapshot(),
      createdAt: '2026-04-17T14:30:10.000Z',
      violations: { added: [], resolved: [], previousAnalysisId: previous.id },
    };
    const candidateFilename = buildAnalysisFilename(candidate.id, candidate.createdAt);
    const candidateLatest = makeLatest(candidate, candidateFilename);

    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline: previousLatest,
      snapshot: candidate,
      latest: candidateLatest,
    })).resolves.toEqual({ state: 'promoted', filename: candidateFilename });

    expect(await readLatest(repoPath)).toEqual(candidateLatest);
    expect(await readAnalysis(repoPath, candidateFilename)).toEqual(candidate);
    expect(await listAnalyses(repoPath)).toEqual([previousFilename, candidateFilename]);
  });

  it('rejects a stale expected baseline without exposing or committing the candidate', async () => {
    const current = makeSnapshot();
    const { filename: currentFilename } = await writeAnalysis(repoPath, current);
    const currentLatest = makeLatest(current, currentFilename);
    await writeLatest(repoPath, currentLatest);

    const staleBaselineId = randomUUID();
    const staleSnapshot = { ...makeSnapshot(), id: staleBaselineId };
    const staleLatest = makeLatest(
      staleSnapshot,
      buildAnalysisFilename(staleSnapshot.id, staleSnapshot.createdAt),
    );
    const candidate = {
      ...makeSnapshot(),
      createdAt: '2026-04-17T14:30:10.000Z',
      violations: { added: [], resolved: [], previousAnalysisId: staleBaselineId },
    };
    const candidateFilename = buildAnalysisFilename(candidate.id, candidate.createdAt);

    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline: staleLatest,
      snapshot: candidate,
      latest: makeLatest(candidate, candidateFilename),
    })).resolves.toEqual({ state: 'conflict', currentBaselineId: current.id });

    expect(await readLatest(repoPath)).toEqual(currentLatest);
    expect(await readAnalysis(repoPath, candidateFilename)).toBeNull();
    expect(await listAnalyses(repoPath)).toEqual([currentFilename]);
  });

  it('rejects a same-ID baseline whose completed content changed after planning', async () => {
    const previous = makeSnapshot();
    const { filename: previousFilename } = await writeAnalysis(repoPath, previous);
    const expectedBaseline = makeLatest(previous, previousFilename);
    const changedBaseline = {
      ...expectedBaseline,
      analysis: { ...expectedBaseline.analysis, metadata: { enrichedAfterPlanning: true } },
    };
    await writeLatest(repoPath, changedBaseline);

    const candidate = {
      ...makeSnapshot(),
      createdAt: '2026-04-17T14:30:10.000Z',
      violations: { added: [], resolved: [], previousAnalysisId: previous.id },
    };
    const candidateFilename = buildAnalysisFilename(candidate.id, candidate.createdAt);
    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline,
      snapshot: candidate,
      latest: makeLatest(candidate, candidateFilename),
    })).resolves.toEqual({ state: 'conflict', currentBaselineId: previous.id });

    expect(await readLatest(repoPath)).toEqual(changedBaseline);
    expect(await readAnalysis(repoPath, candidateFilename)).toBeNull();
  });

  it('rejects a materialized LATEST that drops an unresolved baseline finding', async () => {
    const previous = makeSnapshot();
    const { filename: previousFilename } = await writeAnalysis(repoPath, previous);
    const previousLatest = makeLatest(previous, previousFilename);
    const carriedPrevious = withNames(makeViolation(
      'carry-old',
      'new',
      previous.createdAt,
    ));
    const resolvedPrevious = withNames(makeViolation(
      'resolve-old',
      'new',
      previous.createdAt,
      { title: 'Resolved finding' },
    ));
    previousLatest.violations = [carriedPrevious, resolvedPrevious];
    await writeLatest(repoPath, previousLatest);

    const candidate = {
      ...makeSnapshot(),
      createdAt: '2026-04-17T14:30:10.000Z',
    };
    const added = makeViolation('added-new', 'new', candidate.createdAt, {
      firstSeenAnalysisId: candidate.id,
      firstSeenAt: candidate.createdAt,
      title: carriedPrevious.title,
    });
    candidate.violations = {
      added: [added],
      resolved: [{ id: resolvedPrevious.id, resolvedAt: candidate.createdAt }],
      previousAnalysisId: previous.id,
    };
    const candidateFilename = buildAnalysisFilename(candidate.id, candidate.createdAt);
    const incompleteLatest = makeLatest(candidate, candidateFilename);
    incompleteLatest.violations = [withNames(added)];

    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline: previousLatest,
      snapshot: candidate,
      latest: incompleteLatest,
    })).rejects.toThrow('Candidate LATEST omits an unresolved baseline violation');

    expect(await readLatest(repoPath)).toEqual(previousLatest);
    expect(await readAnalysis(repoPath, candidateFilename)).toBeNull();

    const selfChained = withNames(makeViolation(
      carriedPrevious.id,
      'unchanged',
      candidate.createdAt,
      {
        firstSeenAnalysisId: carriedPrevious.firstSeenAnalysisId,
        firstSeenAt: carriedPrevious.firstSeenAt,
        previousViolationId: carriedPrevious.id,
      },
    ));
    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline: previousLatest,
      snapshot: candidate,
      latest: { ...incompleteLatest, violations: [withNames(added), selfChained] },
    })).rejects.toThrow('Candidate LATEST reuses a baseline violation ID');

    const carried = withNames(makeViolation('carry-new', 'unchanged', candidate.createdAt, {
      firstSeenAnalysisId: carriedPrevious.firstSeenAnalysisId,
      firstSeenAt: carriedPrevious.firstSeenAt,
      previousViolationId: carriedPrevious.id,
    }));
    const completeLatest = { ...incompleteLatest, violations: [withNames(added), carried] };
    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline: previousLatest,
      snapshot: candidate,
      latest: completeLatest,
    })).resolves.toEqual({ state: 'promoted', filename: candidateFilename });
    expect(await readLatest(repoPath)).toEqual(completeLatest);
  });

  it('keeps a prepared candidate invisible when execution stops before the commit point', async () => {
    const previous = makeSnapshot();
    const { filename: previousFilename } = await writeAnalysis(repoPath, previous);
    const previousLatest = makeLatest(previous, previousFilename);
    await writeLatest(repoPath, previousLatest);

    const candidate = {
      ...makeSnapshot(),
      createdAt: '2026-04-17T14:30:10.000Z',
      violations: { added: [], resolved: [], previousAnalysisId: previous.id },
    };
    const candidateFilename = buildAnalysisFilename(candidate.id, candidate.createdAt);
    const promotion = {
      expectedBaseline: previousLatest,
      snapshot: candidate,
      latest: makeLatest(candidate, candidateFilename),
    };

    await expect(promoteCompletedAnalysisBaseline(repoPath, promotion, {
      faultInjector: (point) => {
        if (point === 'after-prepare') throw new Error('injected pre-commit stop');
      },
    })).rejects.toThrow('injected pre-commit stop');

    expect(await readLatest(repoPath)).toEqual(previousLatest);
    expect(await readAnalysis(repoPath, candidateFilename)).toEqual(candidate);
    expect(await listAnalyses(repoPath)).toEqual([previousFilename]);

    await expect(promoteCompletedAnalysisBaseline(repoPath, promotion)).resolves.toEqual({
      state: 'promoted',
      filename: candidateFilename,
    });
    expect(await readLatest(repoPath)).toEqual(promotion.latest);
    expect(await listAnalyses(repoPath)).toEqual([previousFilename, candidateFilename]);
  });

  it('recovers when execution stops after binding the marker but before writing the snapshot', async () => {
    const candidate = { ...makeSnapshot(), metadata: { values: [] } };
    const candidateFilename = buildAnalysisFilename(candidate.id, candidate.createdAt);
    const promotion = {
      expectedBaseline: null,
      snapshot: candidate,
      latest: makeLatest(candidate, candidateFilename),
    };

    await expect(promoteCompletedAnalysisBaseline(repoPath, promotion, {
      faultInjector: (point) => {
        if (point === 'after-marker') throw new Error('injected marker-only stop');
      },
    })).rejects.toThrow('injected marker-only stop');

    expect(await readLatest(repoPath)).toBeNull();
    expect(await readAnalysis(repoPath, candidateFilename)).toBeNull();
    expect(await listAnalyses(repoPath)).toEqual([]);

    const nonJsonSnapshot = { ...candidate, metadata: { values: [undefined] } };
    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      ...promotion,
      snapshot: nonJsonSnapshot,
      latest: makeLatest(nonJsonSnapshot, candidateFilename),
    })).rejects.toThrow('Completed-baseline promotion must be exactly JSON-round-trippable');

    const changedSnapshot = { ...candidate, metadata: { values: [null] } };
    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      ...promotion,
      snapshot: changedSnapshot,
      latest: makeLatest(changedSnapshot, candidateFilename),
    })).rejects.toThrow('Prepared promotion marker does not match the promotion candidate');

    await expect(promoteCompletedAnalysisBaseline(repoPath, promotion)).resolves.toEqual({
      state: 'promoted',
      filename: candidateFilename,
    });
    expect(await readLatest(repoPath)).toEqual(promotion.latest);
  });

  it('promotes a legacy baseline after applying the same violation defaults used by public reads', async () => {
    const previous = makeSnapshot();
    const { filename: previousFilename } = await writeAnalysis(repoPath, previous);
    const previousLatest = makeLatest(previous, previousFilename);
    const legacy = withNames(makeViolation('legacy-old', 'new', previous.createdAt));
    delete (legacy as Partial<ViolationRecord>).category;
    delete (legacy as Partial<ViolationRecord>).subcategory;
    previousLatest.violations = [legacy];
    await writeLatest(repoPath, previousLatest);
    const normalizedBaseline = await readLatest(repoPath);
    expect(normalizedBaseline?.violations[0]).toMatchObject({ category: 'rule', subcategory: null });

    const candidate = {
      ...makeSnapshot(),
      createdAt: '2026-04-17T14:30:10.000Z',
      violations: { added: [], resolved: [], previousAnalysisId: previous.id },
    };
    const candidateFilename = buildAnalysisFilename(candidate.id, candidate.createdAt);
    const latest = makeLatest(candidate, candidateFilename);
    latest.violations = [withNames(makeViolation('legacy-new', 'unchanged', candidate.createdAt, {
      firstSeenAnalysisId: normalizedBaseline!.violations[0].firstSeenAnalysisId,
      firstSeenAt: normalizedBaseline!.violations[0].firstSeenAt,
      previousViolationId: legacy.id,
    }))];

    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline: normalizedBaseline,
      snapshot: candidate,
      latest,
    })).resolves.toEqual({ state: 'promoted', filename: candidateFilename });
  });

  it('recognizes an exact retry after the commit point without rolling the candidate back', async () => {
    const previous = makeSnapshot();
    const { filename: previousFilename } = await writeAnalysis(repoPath, previous);
    const previousLatest = makeLatest(previous, previousFilename);
    await writeLatest(repoPath, previousLatest);

    const candidate = {
      ...makeSnapshot(),
      createdAt: '2026-04-17T14:30:10.000Z',
      violations: { added: [], resolved: [], previousAnalysisId: previous.id },
    };
    const candidateFilename = buildAnalysisFilename(candidate.id, candidate.createdAt);
    const promotion = {
      expectedBaseline: previousLatest,
      snapshot: candidate,
      latest: makeLatest(candidate, candidateFilename),
    };

    await expect(promoteCompletedAnalysisBaseline(repoPath, promotion, {
      faultInjector: (point) => {
        if (point === 'after-commit') throw new Error('injected post-commit stop');
      },
    })).rejects.toThrow('injected post-commit stop');

    expect(await readLatest(repoPath)).toEqual(promotion.latest);
    expect(await listAnalyses(repoPath)).toEqual([previousFilename, candidateFilename]);

    const observedPoints: string[] = [];
    await expect(promoteCompletedAnalysisBaseline(repoPath, promotion, {
      faultInjector: (point) => { observedPoints.push(point); },
    })).resolves.toEqual({ state: 'already-promoted', filename: candidateFilename });
    expect(observedPoints).toEqual([]);
    expect(await readLatest(repoPath)).toEqual(promotion.latest);
  });

  it('keeps a committed ancestor visible after a later promotion', async () => {
    const first = makeSnapshot();
    const firstFilename = buildAnalysisFilename(first.id, first.createdAt);
    const firstPromotion = {
      expectedBaseline: null,
      snapshot: first,
      latest: makeLatest(first, firstFilename),
    };
    await expect(promoteCompletedAnalysisBaseline(repoPath, firstPromotion, {
      faultInjector: (point) => {
        if (point === 'after-commit') throw new Error('injected first post-commit stop');
      },
    })).rejects.toThrow('injected first post-commit stop');

    const second = {
      ...makeSnapshot(),
      createdAt: '2026-04-17T14:30:10.000Z',
      violations: { added: [], resolved: [], previousAnalysisId: first.id },
    };
    const secondFilename = buildAnalysisFilename(second.id, second.createdAt);
    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline: firstPromotion.latest,
      snapshot: second,
      latest: makeLatest(second, secondFilename),
    })).resolves.toEqual({ state: 'promoted', filename: secondFilename });

    expect(await listAnalyses(repoPath)).toEqual([firstFilename, secondFilename]);
    await expect(promoteCompletedAnalysisBaseline(repoPath, firstPromotion)).resolves.toEqual({
      state: 'conflict',
      currentBaselineId: second.id,
    });
    expect(await listAnalyses(repoPath)).toEqual([firstFilename, secondFilename]);
  });

  it('rejects an unsafe committed-baseline head before marker cleanup', async () => {
    const unsafeId = '/../../s';
    const createdAt = '2026-04-17T14:23:45.123Z';
    const unsafeHead = '2026-04-17T14-23-45Z_/../../s.json';
    const unsafeBaseline = makeLatest({ ...makeSnapshot(), id: unsafeId, createdAt }, unsafeHead);
    await writeLatest(repoPath, unsafeBaseline);

    const sentinel = analysisFilePath(repoPath, 's.json');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'must remain', 'utf-8');

    const candidate = {
      ...makeSnapshot(),
      createdAt: '2026-04-17T14:30:10.000Z',
      violations: { added: [], resolved: [], previousAnalysisId: unsafeId },
    };
    const candidateFilename = buildAnalysisFilename(candidate.id, candidate.createdAt);
    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline: unsafeBaseline,
      snapshot: candidate,
      latest: makeLatest(candidate, candidateFilename),
    })).rejects.toThrow('Analysis identity does not produce a safe filename');

    expect(fs.readFileSync(sentinel, 'utf-8')).toBe('must remain');
    expect(await readLatest(repoPath)).toEqual(unsafeBaseline);
  });

  it('fails closed when the candidate LATEST does not identify its snapshot', async () => {
    const candidate = makeSnapshot();
    const latest = makeLatest(candidate, 'wrong-head.json');

    await expect(promoteCompletedAnalysisBaseline(repoPath, {
      expectedBaseline: null,
      snapshot: candidate,
      latest,
    })).rejects.toThrow('Candidate LATEST head does not match its analysis filename');

    expect(await readLatest(repoPath)).toBeNull();
    expect(await listAnalyses(repoPath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// history.json
// ---------------------------------------------------------------------------

function makeHistoryEntry(id: string, createdAt: string): HistoryEntry {
  return {
    id,
    filename: `${createdAt.replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')}_${id.slice(0, 8)}.json`,
    createdAt,
    branch: 'main',
    commitHash: 'abc',
    metadata: { isDiffAnalysis: false },
    counts: {
      services: 3,
      modules: 45,
      methods: 320,
      violations: {
        new: 5,
        unchanged: 180,
        resolved: 9,
        bySeverity: { info: 0, low: 32, medium: 120, high: 40, critical: 2 },
      },
    },
    usage: { totalTokens: 120000, totalCostUsd: '0.45', durationMs: 45000, provider: 'claude-code' },
  };
}

describe('history.json round-trip', () => {
  it('starts empty and appends in order', async () => {
    expect(await readHistory(repoPath)).toEqual({ analyses: [] });

    const e1 = makeHistoryEntry(randomUUID(), '2026-04-17T14:23:45.000Z');
    const e2 = makeHistoryEntry(randomUUID(), '2026-04-17T14:30:10.000Z');
    await appendHistory(repoPath, e1);
    await appendHistory(repoPath, e2);

    expect((await readHistory(repoPath)).analyses).toEqual([e1, e2]);
    expect(fs.existsSync(historyPath(repoPath))).toBe(true);
  });

  it('removeFromHistory drops matching entries; no-op if absent', async () => {
    const e1 = makeHistoryEntry(randomUUID(), '2026-04-17T14:23:45.000Z');
    await appendHistory(repoPath, e1);
    await removeFromHistory(repoPath, 'not-there');
    expect((await readHistory(repoPath)).analyses).toEqual([e1]);
    await removeFromHistory(repoPath, e1.id);
    expect((await readHistory(repoPath)).analyses).toEqual([]);
  });

  it('ensures one exact entry and keeps out-of-order recovery chronological', async () => {
    const later = makeHistoryEntry('later', '2026-04-18T00:00:00.000Z');
    const earlier = makeHistoryEntry('earlier', '2026-04-17T00:00:00.000Z');

    await expect(ensureHistoryEntry(repoPath, later)).resolves.toBe('inserted');
    await expect(ensureHistoryEntry(repoPath, earlier)).resolves.toBe('inserted');
    await expect(ensureHistoryEntry(repoPath, earlier)).resolves.toBe('present');

    expect((await readHistory(repoPath)).analyses).toEqual([earlier, later]);
  });

  it('fails closed when the same analysis ID has different history content', async () => {
    const entry = makeHistoryEntry('same-id', '2026-04-17T00:00:00.000Z');
    await ensureHistoryEntry(repoPath, entry);

    await expect(ensureHistoryEntry(repoPath, {
      ...entry,
      branch: 'different-branch',
    })).rejects.toThrow('History entry conflicts with the stored analysis ID');
    expect((await readHistory(repoPath)).analyses).toEqual([entry]);
  });

  it('rejects history entries that persistence would change', async () => {
    const entry = makeHistoryEntry('non-json-entry', '2026-04-17T00:00:00.000Z');
    entry.metadata = { values: [undefined] };

    await expect(ensureHistoryEntry(repoPath, entry)).rejects.toThrow(
      'History entry must be exactly JSON-round-trippable',
    );
    expect((await readHistory(repoPath)).analyses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// diff.json
// ---------------------------------------------------------------------------

function makeDiff(baseAnalysisId: string): DiffSnapshot {
  return {
    id: randomUUID(),
    baseAnalysisId,
    createdAt: '2026-04-17T14:45:10.000Z',
    branch: 'feature',
    commitHash: 'xyz',
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
    changedFiles: [{ path: 'src/foo.ts', status: 'modified' }],
    newViolations: [],
    resolvedViolations: [],
    affectedNodeIds: { services: [], layers: [], modules: [], methods: [] },
    summary: { newCount: 0, unchangedCount: 0, resolvedCount: 0 },
  };
}

describe('diff.json lifecycle', () => {
  it('reads null when absent, round-trips when written, deletes cleanly', async () => {
    expect(await readDiff(repoPath)).toBeNull();
    const d = makeDiff(randomUUID());
    await writeDiff(repoPath, d);
    expect(await readDiff(repoPath)).toEqual(d);
    expect(fs.existsSync(diffPath(repoPath))).toBe(true);
    await deleteDiff(repoPath);
    expect(await readDiff(repoPath)).toBeNull();
    await expect(deleteDiff(repoPath)).resolves.toBeUndefined();   // double-delete safe
  });

  it('removes only a diff stale against the active completed baseline', async () => {
    const first = makeSnapshot();
    await writeLatest(repoPath, makeLatest(first, buildAnalysisFilename(first.id, first.createdAt)));

    await writeDiff(repoPath, makeDiff('older-baseline'));
    await expect(reconcileDiffWithLatest(repoPath)).resolves.toBe('removed-stale');
    await expect(reconcileDiffWithLatest(repoPath)).resolves.toBe('absent');

    await writeDiff(repoPath, makeDiff(first.id));
    await expect(reconcileDiffWithLatest(repoPath)).resolves.toBe('current');

    const second = { ...makeSnapshot(), createdAt: '2026-04-18T14:23:45.123Z' };
    await writeLatest(repoPath, makeLatest(second, buildAnalysisFilename(second.id, second.createdAt)));
    const current = makeDiff(second.id);
    await writeDiff(repoPath, current);

    // A delayed repair from the first promotion must preserve the newer diff.
    await expect(reconcileDiffWithLatest(repoPath)).resolves.toBe('current');
    expect(await readDiff(repoPath)).toEqual(current);

    await writeDiff(repoPath, makeDiff(first.id));
    await expect(reconcileDiffWithLatest(repoPath)).resolves.toBe('removed-stale');
    expect(await readDiff(repoPath)).toBeNull();
  });

  it('fails closed without a trustworthy completed baseline', async () => {
    const diff = makeDiff('missing-baseline');
    await writeDiff(repoPath, diff);

    await expect(reconcileDiffWithLatest(repoPath)).rejects.toThrow(
      'Cannot reconcile diff without an active completed baseline',
    );
    expect(await readDiff(repoPath)).toEqual(diff);

    const corrupt = makeLatest(makeSnapshot(), 'wrong-head.json');
    await writeLatest(repoPath, corrupt);
    await expect(reconcileDiffWithLatest(repoPath)).rejects.toThrow(
      'Cannot reconcile diff without an active completed baseline',
    );
    expect(await readDiff(repoPath)).toEqual(diff);
  });
});
