import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteJson } from './atomic-write.js';
import {
  inspectAnalyzeRunExecutionCompletion,
  issueAnalyzeRunExecutionCertification,
  type AnalyzeRunExecutionCertification,
  type AnalyzeRunExecutionCompletion,
} from './analyze-run-execution-completion.js';
import {
  validateCompletedAnalysisProjectionIntent,
  type CompletedAnalysisProjectionIntent,
} from './completed-analysis-projection.js';
import {
  validateCompletedAnalysisPromotion,
  type CompletedAnalysisPromotion,
} from './completed-analysis-promotion.js';
import { buildAnalysisFilename, getAnalysisStore } from './analysis-store.js';
import { getRegistryStore } from '../config/registry.js';
import type { HistoryEntry } from '../types/snapshot.js';
import {
  installPreparedAnalyzeRunFinalizationCompletionValidator,
  installPreparedAnalyzeRunFinalizationCompleter,
  installPreparedAnalyzeRunFinalizationCertifier,
  installPreparedAnalyzeRunFinalizationReader,
  type PreparedAnalyzeRunCompletion,
  type PreparedAnalyzeRunFinalization,
} from './analyze-run-finalization-recovery.js';

export type { AnalyzeRunExecutionCompletion } from './analyze-run-execution-completion.js';

const SCHEMA_VERSION = 2 as const;
const LEGACY_SCHEMA_VERSION = 1 as const;
const RUNS_DIR = path.join('.truecourse', 'analyses', 'runs');
const LATEST_ATTEMPT_FILE = 'LATEST_ATTEMPT.json';

export type AnalyzeRunSource = 'cli' | 'dashboard' | 'hosted';

export interface BeginAnalyzeRunCommand {
  kind: 'begin';
  runId: string;
  candidateAnalysisId: string;
  startedAt: string;
  source: AnalyzeRunSource;
  branch: string | null;
  commitHash: string | null;
  completedBaselineId: string | null;
}

export interface SealAnalyzeRunPlanCommand {
  kind: 'seal-plan';
  runId: string;
  sealedAt: string;
  work: Array<{
    workId: string;
    inputFingerprint: string;
  }>;
}

declare const analyzeRunPlanActivationBrand: unique symbol;

/**
 * In-process proof that the journal durably sealed one exact analyze work plan.
 * The runtime value is issued and tracked privately by this module; a caller
 * cannot manufacture a valid receipt by satisfying the TypeScript shape.
 */
export type AnalyzeRunPlanActivation = Readonly<{
  [analyzeRunPlanActivationBrand]: true;
}>;

const analyzeRunPlanActivations = new WeakMap<object, {
  storage: AnalyzeRunStorage;
  repoKey: string;
  scopeKey: string;
  runId: string;
  revision: number;
  workKey: string;
  cacheKey: string;
  claimed: boolean;
}>();
const analyzeRunPlanActivationReceipts = new WeakMap<
  AnalyzeRunStorage,
  Map<string, AnalyzeRunPlanActivation>
>();

const preparedAnalyzeRunCompletions = new WeakMap<object, {
  storage: AnalyzeRunStorage;
  repoKey: string;
  runId: string;
  revision: number;
  analysisStore: ReturnType<typeof getAnalysisStore>;
  registryStore: ReturnType<typeof getRegistryStore>;
  claimed: boolean;
}>();

export interface BlockAnalyzeRunCommand {
  kind: 'block';
  runId: string;
  blockedAt: string;
  resetHint: string;
}

export interface FailAnalyzeRunCommand {
  kind: 'fail';
  runId: string;
  failedAt: string;
  error: {
    code: string;
    message: string;
  };
}

export interface BeginFinalizeAnalyzeRunCommand {
  /** Every sealed work item has returned a successfully correlated result in this attempt. */
  runId: string;
  finalizingAt: string;
}

export interface PrepareAnalyzeRunFinalizationCommand {
  runId: string;
  preparedAt: string;
  promotion: CompletedAnalysisPromotion;
  projection: CompletedAnalysisProjectionIntent;
}

interface StoredAnalyzeRunFinalizationIntent {
  preparedAt: string;
  promotion: CompletedAnalysisPromotion;
  projection: {
    projectSlug: string;
    historyEntry: HistoryEntry;
  };
}

export type AnalyzeRunCommand =
  | BeginAnalyzeRunCommand
  | SealAnalyzeRunPlanCommand
  | BlockAnalyzeRunCommand
  | FailAnalyzeRunCommand;

export interface AnalyzeRunView {
  schemaVersion: typeof SCHEMA_VERSION;
  revision: number;
  runId: string;
  candidateAnalysisId: string;
  state: 'running' | 'blocked' | 'failed' | 'finalizing' | 'completed';
  startedAt: string;
  updatedAt: string;
  source: AnalyzeRunSource;
  branch: string | null;
  commitHash: string | null;
  completedBaselineId: string | null;
  plan: 'unsealed' | 'sealed';
  counts: null | {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
  };
  blocked: null | {
    reason: 'provider-session-limit';
    resetHint: string;
    blockedAt: string;
  };
  failure: null | {
    code: string;
    message: string;
    failedAt: string;
  };
  finalization: null | {
    finalizingAt: string;
    persistence: 'unprepared' | 'prepared';
    preparedAt: string | null;
  };
  resume: {
    available: false;
    reason: 'successful-results-not-checkpointed' | 'run-completed';
  };
}

export interface StoredAnalyzeRunWork {
  workId: string;
  inputFingerprint: string;
  state: 'pending' | 'succeeded-uncheckpointed';
}

export interface StoredAnalyzeRun {
  schemaVersion: typeof SCHEMA_VERSION;
  attemptSequence: number;
  revision: number;
  runId: string;
  candidateAnalysisId: string;
  status:
    | { state: 'running' }
    | {
        state: 'blocked';
        reason: 'provider-session-limit';
        resetHint: string;
        blockedAt: string;
      }
    | {
        state: 'failed';
        code: string;
        message: string;
        failedAt: string;
        finalizingAt: string | null;
      }
    | {
        state: 'finalizing';
        finalizingAt: string;
      }
    | {
        state: 'completed';
        finalizingAt: string;
        completedAt: string;
      };
  startedAt: string;
  updatedAt: string;
  source: AnalyzeRunSource;
  branch: string | null;
  commitHash: string | null;
  completedBaselineId: string | null;
  finalizationIntent: StoredAnalyzeRunFinalizationIntent | null;
  plan:
    | { state: 'unsealed' }
    | { state: 'sealed'; sealedAt: string; work: StoredAnalyzeRunWork[] };
}

export type NewStoredAnalyzeRun = Omit<StoredAnalyzeRun, 'attemptSequence'>;

interface LatestAttemptPointer {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
}

interface ParsedLatestAttemptPointer {
  schemaVersion: typeof LEGACY_SCHEMA_VERSION | typeof SCHEMA_VERSION;
  runId: string;
}

export class AnalyzeRunJournalCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeRunJournalCorruptError';
  }
}

export class AnalyzeRunAlreadyExistsError extends Error {
  constructor(runId: string) {
    super(`Analyze run already exists: ${runId}`);
    this.name = 'AnalyzeRunAlreadyExistsError';
  }
}

export class AnalyzeRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Analyze run was not found: ${runId}`);
    this.name = 'AnalyzeRunNotFoundError';
  }
}

export class AnalyzeRunRevisionConflictError extends Error {
  constructor(runId: string, expected: number, actual: number) {
    super(`Analyze run ${runId} revision conflict: expected ${expected}, found ${actual}`);
    this.name = 'AnalyzeRunRevisionConflictError';
  }
}

export class InvalidAnalyzeRunTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAnalyzeRunTransitionError';
  }
}

export interface AnalyzeRunStorage {
  /**
   * Storage implementations must make sequence allocation and compare-and-swap atomic for a
   * repository. The default file adapter relies on the repository-wide analyze lock for
   * cross-process exclusion and additionally serializes canonical repository paths in-process.
   * `createLatest` atomically allocates a repository-monotonic attempt sequence and publishes it.
   */
  createLatest(repoKey: string, run: NewStoredAnalyzeRun): Promise<StoredAnalyzeRun>;
  read(repoKey: string, runId: string): Promise<StoredAnalyzeRun | null>;
  readLatest(repoKey: string): Promise<StoredAnalyzeRun | null>;
  compareAndSwap(
    repoKey: string,
    runId: string,
    expectedRevision: number,
    next: StoredAnalyzeRun,
  ): Promise<void>;
}

class FileAnalyzeRunStorage implements AnalyzeRunStorage {
  private readonly mutationTails = new Map<string, Promise<void>>();

  async createLatest(repoPath: string, run: NewStoredAnalyzeRun): Promise<StoredAnalyzeRun> {
    const canonicalPath = canonicalRepoPath(repoPath);
    return this.serialize(canonicalPath, async () => {
      validateLatestPointerTarget(canonicalPath);
      const file = runPath(canonicalPath, run.runId);
      if (fs.existsSync(file)) {
        const existing = parseStoredRun(readJson(file), file, run.runId);
        if (!sameBeginIdentity(existing, run)) {
          throw new AnalyzeRunAlreadyExistsError(run.runId);
        }
        const latest = latestStoredRun(readAllRuns(canonicalPath));
        writeLatestPointer(canonicalPath, latest.runId);
        return existing;
      }

      const runs = readAllRuns(canonicalPath);
      const stored: StoredAnalyzeRun = {
        ...run,
        attemptSequence: runs.reduce(
          (maximum, existing) => Math.max(maximum, existing.attemptSequence),
          0,
        ) + 1,
      };
      atomicWriteJson(file, stored);
      writeLatestPointer(canonicalPath, stored.runId);
      return stored;
    });
  }

  async read(repoPath: string, runId: string): Promise<StoredAnalyzeRun | null> {
    const canonicalPath = canonicalRepoPath(repoPath);
    const file = runPath(canonicalPath, runId);
    if (!fs.existsSync(file)) return null;
    return parseStoredRun(readJson(file), file, runId);
  }

  async readLatest(repoPath: string): Promise<StoredAnalyzeRun | null> {
    const canonicalPath = canonicalRepoPath(repoPath);
    return this.serialize(canonicalPath, async () => {
      const file = pointerPath(canonicalPath);
      let pointer: ParsedLatestAttemptPointer | null = null;
      if (fs.existsSync(file)) {
        pointer = parseLatestPointer(readJson(file), file);
        if (!(await this.read(canonicalPath, pointer.runId))) {
          throw new AnalyzeRunJournalCorruptError(
            `Latest analyze-run pointer references a missing run: ${pointer.runId}`,
          );
        }
      }

      const runs = readAllRuns(canonicalPath);
      if (runs.length === 0) return null;
      const latest = latestStoredRun(runs);

      if (pointer?.runId !== latest.runId || pointer.schemaVersion !== SCHEMA_VERSION) {
        writeLatestPointer(canonicalPath, latest.runId);
      }
      return latest;
    });
  }

  async compareAndSwap(
    repoPath: string,
    runId: string,
    expectedRevision: number,
    next: StoredAnalyzeRun,
  ): Promise<void> {
    const canonicalPath = canonicalRepoPath(repoPath);
    await this.serialize(canonicalPath, async () => {
      const current = await this.read(canonicalPath, runId);
      if (!current) throw new AnalyzeRunNotFoundError(runId);
      if (current.revision !== expectedRevision) {
        throw new AnalyzeRunRevisionConflictError(runId, expectedRevision, current.revision);
      }
      atomicWriteJson(runPath(canonicalPath, runId), next);
    });
  }

  private async serialize<T>(repoPath: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(repoPath) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.mutationTails.set(repoPath, tail);

    await previous;
    try {
      return await mutation();
    } finally {
      release();
      if (this.mutationTails.get(repoPath) === tail) {
        this.mutationTails.delete(repoPath);
      }
    }
  }
}

let activeStorage: AnalyzeRunStorage = new FileAnalyzeRunStorage();

export function setAnalyzeRunStorage(storage: AnalyzeRunStorage): void {
  activeStorage = storage;
}

export function resetAnalyzeRunStorage(): void {
  activeStorage = new FileAnalyzeRunStorage();
}

installPreparedAnalyzeRunFinalizationReader(async (repoKey, runId) => {
  const storage = activeStorage;
  const current = await storage.read(repoKey, validateRunId(runId));
  assertAnalyzeRunStorage(storage);
  if (!current?.finalizationIntent) return null;
  return JSON.parse(JSON.stringify({
    preparedAt: current.finalizationIntent.preparedAt,
    promotion: current.finalizationIntent.promotion,
    projection: {
      ...current.finalizationIntent.projection,
      promotedSnapshot: current.finalizationIntent.promotion.snapshot,
    },
  })) as PreparedAnalyzeRunFinalization;
});

installPreparedAnalyzeRunFinalizationCertifier(async (repoKey, runId) => {
  const storage = activeStorage;
  const repositoryKey = activationScopeKey(repoKey, storage);
  const current = await storage.read(repositoryKey, validateRunId(runId));
  assertAnalyzeRunStorage(storage);
  if (!current) return null;
  if (current.status.state === 'completed') {
    return { state: 'completed', repositoryKey, completed: toView(current) };
  }
  if (!current.finalizationIntent || current.status.state !== 'finalizing') return null;
  const prepared = JSON.parse(JSON.stringify({
    preparedAt: current.finalizationIntent.preparedAt,
    promotion: current.finalizationIntent.promotion,
    projection: {
      ...current.finalizationIntent.projection,
      promotedSnapshot: current.finalizationIntent.promotion.snapshot,
    },
  })) as PreparedAnalyzeRunFinalization;
  const completion = Object.freeze({}) as PreparedAnalyzeRunCompletion;
  preparedAnalyzeRunCompletions.set(completion, {
    storage,
    repoKey: repositoryKey,
    runId: current.runId,
    revision: current.revision,
    analysisStore: getAnalysisStore(),
    registryStore: getRegistryStore(),
    claimed: false,
  });
  return { state: 'prepared', repositoryKey, prepared, completion };
});

installPreparedAnalyzeRunFinalizationCompleter(async (repoKey, command) => {
  const runId = validateRunId(command.runId);
  const completedAt = validateTimestamp(command.completedAt, 'completedAt');
  const certification = preparedAnalyzeRunCompletions.get(command.completion);
  if (
    !certification
    || certification.claimed
    || certification.storage !== activeStorage
    || certification.repoKey !== activationScopeKey(repoKey, certification.storage)
    || certification.runId !== runId
    || certification.analysisStore !== getAnalysisStore()
    || certification.registryStore !== getRegistryStore()
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} prepared-finalization storage changed or certification is invalid`,
    );
  }
  const storage = certification.storage;
  const current = await storage.read(repoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (
    certification.analysisStore !== getAnalysisStore()
    || certification.registryStore !== getRegistryStore()
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} persistence storage changed before journal completion`,
    );
  }
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  if (current.status.state === 'completed') {
    if (current.status.completedAt !== completedAt) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} was completed with a different completion time`,
      );
    }
    return toView(current);
  }
  if (
    current.status.state !== 'finalizing'
    || current.plan.state !== 'sealed'
    || current.finalizationIntent === null
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot complete analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }
  if (current.revision !== certification.revision) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} changed after its prepared finalization was certified`,
    );
  }
  if (Date.parse(completedAt) < Date.parse(current.finalizationIntent.preparedAt)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} completion cannot precede prepared finalization`,
    );
  }
  const next: StoredAnalyzeRun = {
    ...current,
    revision: current.revision + 1,
    updatedAt: completedAt,
    status: {
      state: 'completed',
      finalizingAt: current.status.finalizingAt,
      completedAt,
    },
  };
  certification.claimed = true;
  try {
    await storage.compareAndSwap(repoKey, runId, current.revision, next);
    assertAnalyzeRunStorage(storage);
    return toView(next);
  } catch (error) {
    certification.claimed = false;
    throw error;
  }
});

installPreparedAnalyzeRunFinalizationCompletionValidator((completion) => {
  const certification = preparedAnalyzeRunCompletions.get(completion);
  if (
    !certification
    || !certification.claimed
    || certification.storage !== activeStorage
    || certification.analysisStore !== getAnalysisStore()
    || certification.registryStore !== getRegistryStore()
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      'Analyze-run finalization storage changed after journal completion',
    );
  }
});

/**
 * Apply one run-lifecycle command. Callers using the default file adapter must hold the
 * repository-wide analyze lock for the complete begin/plan/execute/finalize lifecycle.
 */
export async function dispatchAnalyzeRun(
  repoKey: string,
  command: AnalyzeRunCommand,
): Promise<AnalyzeRunView> {
  const storage = activeStorage;
  if (
    !isRecord(command) ||
    !['begin', 'seal-plan', 'block', 'fail'].includes(String(command.kind))
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Invalid analyze-run command kind: ${String(isRecord(command) ? command.kind : undefined)}`,
    );
  }
  if (command.kind === 'seal-plan') {
    return sealPlan(repoKey, command, storage);
  }
  if (command.kind === 'block') {
    return blockRun(repoKey, command, storage);
  }
  if (command.kind === 'fail') {
    return failRun(repoKey, command, storage);
  }
  const source = validateSource(command.source);
  if (source === 'hosted' && storage instanceof FileAnalyzeRunStorage) {
    throw new InvalidAnalyzeRunTransitionError(
      'A hosted analyze run requires an explicitly installed hosted storage adapter',
    );
  }
  const run: NewStoredAnalyzeRun = {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    runId: validateRunId(command.runId),
    candidateAnalysisId: requireNonEmpty(command.candidateAnalysisId, 'candidateAnalysisId'),
    status: { state: 'running' },
    startedAt: validateTimestamp(command.startedAt, 'startedAt'),
    updatedAt: validateTimestamp(command.startedAt, 'startedAt'),
    source,
    branch: validateNullableString(command.branch, 'branch'),
    commitHash: validateNullableString(command.commitHash, 'commitHash'),
    completedBaselineId: validateNullableString(command.completedBaselineId, 'completedBaselineId'),
    finalizationIntent: null,
    plan: { state: 'unsealed' },
  };
  const stored = await storage.createLatest(repoKey, run);
  return toView(stored);
}

/**
 * Seal a certified plan and return a one-use activation receipt only after the
 * storage compare-and-swap succeeds. Execution consumes this receipt so a
 * no-op callback cannot bypass durable plan activation.
 */
export async function sealAnalyzeRunPlan(
  repoKey: string,
  command: SealAnalyzeRunPlanCommand,
): Promise<AnalyzeRunPlanActivation> {
  const storage = activeStorage;
  const durableRepoKey = activationScopeKey(repoKey, storage);
  const runId = validateRunId(command.runId);
  const expectedWork = normalizeSealPlanWork(command, runId);
  let stored = await storage.read(durableRepoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (
    stored?.status.state === 'running' &&
    stored.plan.state === 'sealed'
  ) {
    if (activationWorkKey(stored.plan.work) !== activationWorkKey(expectedWork)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} already has a different sealed manifest`,
      );
    }
    if (stored.revision !== 1) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} sealed execution was already admitted`,
      );
    }
  } else {
    await sealPlan(durableRepoKey, command, storage);
    assertAnalyzeRunStorage(storage);
    stored = await storage.read(durableRepoKey, runId);
    assertAnalyzeRunStorage(storage);
  }
  if (
    !stored ||
    stored.status.state !== 'running' ||
    stored.plan.state !== 'sealed'
  ) {
    throw new AnalyzeRunJournalCorruptError(
      `Analyze run ${command.runId} was not sealed and running after plan activation`,
    );
  }
  const workKey = activationWorkKey(stored.plan.work);
  const cacheKey = JSON.stringify([
    durableRepoKey,
    stored.runId,
    stored.revision,
    workKey,
  ]);
  let receipts = analyzeRunPlanActivationReceipts.get(storage);
  if (!receipts) {
    receipts = new Map();
    analyzeRunPlanActivationReceipts.set(storage, receipts);
  }
  const existing = receipts.get(cacheKey);
  if (existing && analyzeRunPlanActivations.has(existing)) return existing;

  const receipt = Object.freeze({}) as AnalyzeRunPlanActivation;
  analyzeRunPlanActivations.set(receipt, {
    storage,
    repoKey: durableRepoKey,
    scopeKey: durableRepoKey,
    runId: stored.runId,
    revision: stored.revision,
    workKey,
    cacheKey,
    claimed: false,
  });
  receipts.set(cacheKey, receipt);
  return receipt;
}

export type AnalyzeRunPlanAdmission<T> =
  | { readonly admitted: false }
  | {
      readonly admitted: true;
      readonly execution: Promise<Readonly<{
        result: T;
        certification: AnalyzeRunExecutionCertification;
      }>>;
    };

/**
 * @internal
 * Validate durable state and synchronously admit provider work in the same
 * continuation. A rejected ownership/profile check leaves the receipt intact.
 * The caller must also hold the repository lifecycle lock required by the
 * storage contract so another process cannot publish a terminal transition
 * between the durable read and this in-process admission callback.
 */
export async function admitAnalyzeRunPlanExecution<T>(
  receipt: AnalyzeRunPlanActivation,
  repoKey: string,
  runId: string,
  work: readonly { readonly workId: string; readonly inputFingerprint: string }[],
  validate: () => void,
  admit: () => Promise<T>,
): Promise<AnalyzeRunPlanAdmission<T>> {
  if ((typeof receipt !== 'object' && typeof receipt !== 'function') || receipt === null) {
    return { admitted: false };
  }
  const activation = analyzeRunPlanActivations.get(receipt);
  if (!activation) return { admitted: false };
  const storage = activeStorage;
  const ownershipMatches = (
    activation.storage === storage &&
    activation.scopeKey === activationScopeKey(repoKey, storage) &&
    activation.runId === runId &&
    activation.workKey === activationWorkKey(work)
  );
  if (!ownershipMatches) return { admitted: false };

  const stored = await storage.read(activation.repoKey, activation.runId);
  assertAnalyzeRunStorage(storage);
  const stillExecutable = (
    stored?.status.state === 'running' &&
    stored.plan.state === 'sealed' &&
    stored.revision === activation.revision &&
    activation.workKey === activationWorkKey(stored.plan.work)
  );
  if (!stillExecutable) return { admitted: false };
  if (analyzeRunPlanActivations.get(receipt) !== activation || activation.claimed) {
    return { admitted: false };
  }
  validate();
  activation.claimed = true;
  try {
    const admitted: StoredAnalyzeRun = {
      ...stored,
      revision: stored.revision + 1,
    };
    await storage.compareAndSwap(
      activation.repoKey,
      activation.runId,
      stored.revision,
      admitted,
    );
    assertAnalyzeRunStorage(storage);
    validate();
    const admittedExecution = admit();
    analyzeRunPlanActivations.delete(receipt);
    analyzeRunPlanActivationReceipts.get(storage)?.delete(activation.cacheKey);
    const execution = admittedExecution.then((result) => {
      const certification = issueAnalyzeRunExecutionCertification({
        storage,
        scopeKey: activation.scopeKey,
        runId: activation.runId,
        revision: admitted.revision,
        workKey: activation.workKey,
      });
      return Object.freeze({ result, certification });
    });
    return { admitted: true, execution };
  } catch (error) {
    const current = await storage.read(activation.repoKey, activation.runId);
    assertAnalyzeRunStorage(storage);
    if (current?.revision === activation.revision) activation.claimed = false;
    throw error;
  }
}

export async function readAnalyzeRun(
  repoKey: string,
  selector: 'latest-attempt' | { runId: string },
): Promise<AnalyzeRunView | null> {
  const stored = selector === 'latest-attempt'
    ? await activeStorage.readLatest(repoKey)
    : await activeStorage.read(repoKey, validateRunId(selector.runId));
  return stored ? toView(stored) : null;
}

function toView(run: StoredAnalyzeRun): AnalyzeRunView {
  const counts = run.plan.state === 'sealed'
    ? {
        total: run.plan.work.length,
        pending: run.plan.work.filter((work) => work.state === 'pending').length,
        running: 0,
        succeeded: run.plan.work.filter((work) => work.state === 'succeeded-uncheckpointed').length,
        failed: 0,
      }
    : null;
  return {
    schemaVersion: run.schemaVersion,
    revision: run.revision,
    runId: run.runId,
    candidateAnalysisId: run.candidateAnalysisId,
    state: run.status.state,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    source: run.source,
    branch: run.branch,
    commitHash: run.commitHash,
    completedBaselineId: run.completedBaselineId,
    plan: run.plan.state,
    counts,
    blocked: run.status.state === 'blocked'
      ? {
          reason: run.status.reason,
          resetHint: run.status.resetHint,
          blockedAt: run.status.blockedAt,
        }
      : null,
    failure: run.status.state === 'failed'
      ? {
          code: run.status.code,
          message: run.status.message,
          failedAt: run.status.failedAt,
      }
      : null,
    finalization: run.status.state === 'finalizing' || run.status.state === 'completed'
      ? {
          finalizingAt: run.status.finalizingAt,
          persistence: run.finalizationIntent === null ? 'unprepared' : 'prepared',
          preparedAt: run.finalizationIntent?.preparedAt ?? null,
        }
      : run.status.state === 'failed' && run.status.finalizingAt !== null
        ? {
            finalizingAt: run.status.finalizingAt,
            persistence: run.finalizationIntent === null ? 'unprepared' : 'prepared',
            preparedAt: run.finalizationIntent?.preparedAt ?? null,
          }
        : null,
    resume: {
      available: false,
      reason: run.status.state === 'completed'
        ? 'run-completed'
        : 'successful-results-not-checkpointed',
    },
  };
}

export async function beginFinalizeAnalyzeRun(
  repoKey: string,
  command: BeginFinalizeAnalyzeRunCommand,
  completion: AnalyzeRunExecutionCompletion,
): Promise<AnalyzeRunView> {
  if (
    (typeof completion !== 'object' && typeof completion !== 'function') ||
    completion === null
  ) {
    throw new InvalidAnalyzeRunTransitionError('Invalid analyze execution completion receipt');
  }
  const certified = inspectAnalyzeRunExecutionCompletion(completion);
  if (!certified) {
    throw new InvalidAnalyzeRunTransitionError('Invalid analyze execution completion receipt');
  }
  const storage = activeStorage;
  const runId = validateRunId(command.runId);
  const scopeMatches = (
    certified.storage === storage &&
    certified.scopeKey === activationScopeKey(repoKey, storage) &&
    certified.runId === runId
  );
  if (!scopeMatches) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze execution completion does not belong to run ${runId}`,
    );
  }
  const current = await storage.read(repoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  const finalizingAt = validateTimestamp(command.finalizingAt, 'finalizingAt');
  if (
    current.status.state === 'finalizing' &&
    current.plan.state === 'sealed' &&
    current.revision === certified.revision + 1 &&
    current.status.finalizingAt === finalizingAt &&
    certified.workKey === activationWorkKey(current.plan.work) &&
    current.plan.work.every((item) => item.state === 'succeeded-uncheckpointed')
  ) {
    certified.claimed = true;
    return toView(current);
  }
  if (current.status.state !== 'running' || current.plan.state !== 'sealed') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot finalize analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }
  if (
    certified.claimed ||
    certified.revision !== current.revision ||
    certified.workKey !== activationWorkKey(current.plan.work)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze execution completion does not certify run ${runId}'s current sealed plan`,
    );
  }
  if (Date.parse(finalizingAt) < Date.parse(current.plan.sealedAt)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} finalization cannot precede its sealed plan`,
    );
  }
  const next: StoredAnalyzeRun = {
    ...current,
    revision: current.revision + 1,
    updatedAt: finalizingAt,
    status: { state: 'finalizing', finalizingAt },
    finalizationIntent: null,
    plan: {
      ...current.plan,
      work: current.plan.work.map((item) => ({
        ...item,
        state: 'succeeded-uncheckpointed',
      })),
    },
  };
  certified.claimed = true;
  try {
    await storage.compareAndSwap(repoKey, runId, current.revision, next);
    assertAnalyzeRunStorage(storage);
    return toView(next);
  } catch (error) {
    certified.claimed = false;
    throw error;
  }
}

/**
 * Durably bind the exact recovery input before completed-baseline promotion.
 * This command changes only the attempted-run journal.
 */
export async function prepareAnalyzeRunFinalization(
  repoKey: string,
  command: PrepareAnalyzeRunFinalizationCommand,
): Promise<AnalyzeRunView> {
  const storage = activeStorage;
  const runId = validateRunId(command.runId);
  const preparedAt = validateTimestamp(command.preparedAt, 'preparedAt');
  const current = await storage.read(repoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  if (current.status.state !== 'finalizing' || current.plan.state !== 'sealed') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot prepare finalization for analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }

  let persisted: unknown;
  try {
    persisted = JSON.parse(JSON.stringify(command));
  } catch {
    throw new InvalidAnalyzeRunTransitionError('Analyze finalization intent must be exactly JSON-round-trippable');
  }
  if (!isDeepStrictEqual(persisted, command)) {
    throw new InvalidAnalyzeRunTransitionError('Analyze finalization intent must be exactly JSON-round-trippable');
  }

  const detachedCommand = persisted as PrepareAnalyzeRunFinalizationCommand;
  const filename = buildAnalysisFilename(
    detachedCommand.promotion.snapshot.id,
    detachedCommand.promotion.snapshot.createdAt,
  );
  validateCompletedAnalysisPromotion(detachedCommand.promotion, filename);
  validateCompletedAnalysisProjectionIntent(detachedCommand.projection);
  const expectedBaselineId = detachedCommand.promotion.expectedBaseline?.analysis.id ?? null;
  if (
    detachedCommand.promotion.snapshot.id !== current.candidateAnalysisId
    || expectedBaselineId !== current.completedBaselineId
    || detachedCommand.promotion.snapshot.branch !== current.branch
    || detachedCommand.promotion.snapshot.commitHash !== current.commitHash
    || !isDeepStrictEqual(
      detachedCommand.projection.promotedSnapshot,
      detachedCommand.promotion.snapshot,
    )
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze finalization intent does not match run ${runId}`,
    );
  }
  if (Date.parse(preparedAt) < Date.parse(current.status.finalizingAt)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} finalization preparation cannot precede finalizing`,
    );
  }

  const storedIntent: StoredAnalyzeRunFinalizationIntent = {
    preparedAt,
    promotion: detachedCommand.promotion,
    projection: {
      projectSlug: detachedCommand.projection.projectSlug,
      historyEntry: detachedCommand.projection.historyEntry,
    },
  };
  if (current.finalizationIntent !== null) {
    if (!isDeepStrictEqual(current.finalizationIntent, storedIntent)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} already has a different prepared finalization intent`,
      );
    }
    return toView(current);
  }

  const next: StoredAnalyzeRun = {
    ...current,
    schemaVersion: SCHEMA_VERSION,
    revision: current.revision + 1,
    updatedAt: preparedAt,
    finalizationIntent: storedIntent,
  };
  await storage.compareAndSwap(repoKey, runId, current.revision, next);
  assertAnalyzeRunStorage(storage);
  return toView(next);
}

async function failRun(
  repoKey: string,
  command: FailAnalyzeRunCommand,
  storage: AnalyzeRunStorage,
): Promise<AnalyzeRunView> {
  const runId = validateRunId(command.runId);
  const current = await storage.read(repoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  if (current.status.state !== 'running' && current.status.state !== 'finalizing') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot fail analyze run ${runId} from ${current.status.state}`,
    );
  }
  if (!isRecord(command.error)) {
    throw new InvalidAnalyzeRunTransitionError(`Analyze run ${runId} has an invalid public error`);
  }

  const failedAt = validateTimestamp(command.failedAt, 'failedAt');
  if (
    Date.parse(failedAt) < Date.parse(current.startedAt) ||
    (current.plan.state === 'sealed' && Date.parse(failedAt) < Date.parse(current.plan.sealedAt)) ||
    (
      current.status.state === 'finalizing' &&
      Date.parse(failedAt) < Date.parse(current.status.finalizingAt)
    ) || (
      current.finalizationIntent !== null &&
      Date.parse(failedAt) < Date.parse(current.finalizationIntent.preparedAt)
    )
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} failure cannot precede its start, sealed plan, or prepared finalization`,
    );
  }
  const next: StoredAnalyzeRun = {
    ...current,
    revision: current.revision + 1,
    updatedAt: failedAt,
    status: {
      state: 'failed',
      code: validateErrorCode(command.error.code),
      message: validatePublicErrorMessage(command.error.message),
      failedAt,
      finalizingAt: current.status.state === 'finalizing'
        ? current.status.finalizingAt
        : null,
    },
  };
  await storage.compareAndSwap(repoKey, runId, current.revision, next);
  assertAnalyzeRunStorage(storage);
  return toView(next);
}

async function blockRun(
  repoKey: string,
  command: BlockAnalyzeRunCommand,
  storage: AnalyzeRunStorage,
): Promise<AnalyzeRunView> {
  const runId = validateRunId(command.runId);
  const current = await storage.read(repoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  if (current.status.state !== 'running' || current.plan.state !== 'sealed') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot block analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }

  const blockedAt = validateTimestamp(command.blockedAt, 'blockedAt');
  if (
    Date.parse(blockedAt) < Date.parse(current.startedAt) ||
    Date.parse(blockedAt) < Date.parse(current.plan.sealedAt)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} block cannot precede its start or sealed plan`,
    );
  }
  const next: StoredAnalyzeRun = {
    ...current,
    revision: current.revision + 1,
    updatedAt: blockedAt,
    status: {
      state: 'blocked',
      reason: 'provider-session-limit',
      resetHint: requireNonEmpty(command.resetHint, 'resetHint'),
      blockedAt,
    },
  };
  await storage.compareAndSwap(repoKey, runId, current.revision, next);
  assertAnalyzeRunStorage(storage);
  return toView(next);
}

async function sealPlan(
  repoKey: string,
  command: SealAnalyzeRunPlanCommand,
  storage: AnalyzeRunStorage,
): Promise<AnalyzeRunView> {
  const runId = validateRunId(command.runId);
  const current = await storage.read(repoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  if (current.status.state !== 'running' || current.plan.state !== 'unsealed') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot seal plan for analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }

  const work = normalizeSealPlanWork(command, runId);

  const sealedAt = validateTimestamp(command.sealedAt, 'sealedAt');
  if (Date.parse(sealedAt) < Date.parse(current.startedAt)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} plan cannot be sealed before the run starts`,
    );
  }
  const next: StoredAnalyzeRun = {
    ...current,
    revision: current.revision + 1,
    updatedAt: sealedAt,
    plan: {
      state: 'sealed',
      sealedAt,
      work,
    },
  };
  await storage.compareAndSwap(repoKey, runId, current.revision, next);
  assertAnalyzeRunStorage(storage);
  return toView(next);
}

function normalizeSealPlanWork(
  command: SealAnalyzeRunPlanCommand,
  runId: string,
): StoredAnalyzeRunWork[] {
  if (!Array.isArray(command.work)) {
    throw new InvalidAnalyzeRunTransitionError(`Analyze run ${runId} has an invalid LLM work plan`);
  }
  const work = command.work.map((item) => {
    if (!isRecord(item)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} contains an invalid LLM work item`,
      );
    }
    return {
      workId: requireNonEmpty(item.workId, 'workId'),
      inputFingerprint: validateFingerprint(item.inputFingerprint),
      state: 'pending' as const,
    };
  }).sort((a, b) => Buffer.from(a.workId).compare(Buffer.from(b.workId)));
  if (new Set(work.map((item) => item.workId)).size !== work.length) {
    throw new InvalidAnalyzeRunTransitionError(`Analyze run ${runId} contains duplicate work IDs`);
  }
  if (work.length === 0) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} cannot seal an empty LLM work plan without an explicit disposition`,
    );
  }
  return work;
}

function activationWorkKey(
  work: readonly { readonly workId: string; readonly inputFingerprint: string }[],
): string {
  return JSON.stringify(work.map(({ workId, inputFingerprint }) => ({
    workId,
    inputFingerprint,
  })).sort((left, right) => Buffer.from(left.workId).compare(Buffer.from(right.workId))));
}

function activationScopeKey(repoKey: string, storage: AnalyzeRunStorage): string {
  return storage instanceof FileAnalyzeRunStorage ? canonicalRepoPath(repoKey) : repoKey;
}

function assertAnalyzeRunStorage(storage: AnalyzeRunStorage): void {
  if (activeStorage !== storage) {
    throw new InvalidAnalyzeRunTransitionError(
      'Analyze run storage changed during plan activation',
    );
  }
}

function runsDir(repoPath: string): string {
  return path.join(repoPath, RUNS_DIR);
}

function canonicalRepoPath(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pointerPath(repoPath: string): string {
  return path.join(runsDir(repoPath), LATEST_ATTEMPT_FILE);
}

function runPath(repoPath: string, runId: string): string {
  return path.join(runsDir(repoPath), `${validateRunId(runId)}.json`);
}

function validateRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid analyze run ID: ${String(value)}`);
  }
  if (value.toUpperCase() === 'LATEST_ATTEMPT') {
    throw new Error(`Analyze run ID is reserved: ${value}`);
  }
  return value;
}

function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid timestamp`);
  }
  return value;
}

function validateSource(value: unknown): AnalyzeRunSource {
  if (value !== 'cli' && value !== 'dashboard' && value !== 'hosted') {
    throw new Error(`Invalid analyze run source: ${String(value)}`);
  }
  return value;
}

function validateNullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${field} must be a string or null`);
  }
  return value;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid analyze work fingerprint: ${String(value)}`);
  }
  return value;
}

function validateErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`Invalid public analyze-run error code: ${String(value)}`);
  }
  return value;
}

function validatePublicErrorMessage(value: unknown): string {
  const message = requireNonEmpty(value, 'public error message');
  if (message.length > 4096 || message.includes('\0')) {
    throw new Error('Public analyze-run error message is unsafe or too long');
  }
  return message;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new AnalyzeRunJournalCorruptError(
      `Could not read analyze-run journal ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseLatestPointer(value: unknown, file: string): ParsedLatestAttemptPointer {
  try {
    if (
      !isRecord(value)
      || (value.schemaVersion !== LEGACY_SCHEMA_VERSION && value.schemaVersion !== SCHEMA_VERSION)
      || typeof value.runId !== 'string'
    ) {
      throw new AnalyzeRunJournalCorruptError(`Invalid latest analyze-run pointer: ${file}`);
    }
    return {
      schemaVersion: value.schemaVersion as ParsedLatestAttemptPointer['schemaVersion'],
      runId: validateRunId(value.runId),
    };
  } catch (error) {
    throw asCorruption(error, `Invalid latest analyze-run pointer: ${file}`);
  }
}

function parseStoredRun(value: unknown, file: string, expectedRunId?: string): StoredAnalyzeRun {
  try {
    const run = parseStoredRunUnchecked(value, file);
    if (expectedRunId !== undefined && run.runId !== expectedRunId) {
      throw new AnalyzeRunJournalCorruptError(
        `Analyze-run filename identity ${expectedRunId} does not match stored run ${run.runId}: ${file}`,
      );
    }
    return run;
  } catch (error) {
    throw asCorruption(error, `Invalid analyze-run journal: ${file}`);
  }
}

function parseStoredRunUnchecked(value: unknown, file: string): StoredAnalyzeRun {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== LEGACY_SCHEMA_VERSION && value.schemaVersion !== SCHEMA_VERSION) ||
    !Number.isSafeInteger(value.attemptSequence) ||
    (value.attemptSequence as number) < 1 ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.runId !== 'string' ||
    typeof value.candidateAnalysisId !== 'string' ||
    !isRecord(value.status) ||
    !['running', 'blocked', 'failed', 'finalizing', 'completed'].includes(String(value.status.state)) ||
    typeof value.startedAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !['cli', 'dashboard', 'hosted'].includes(String(value.source)) ||
    !isNullableString(value.branch) ||
    !isNullableString(value.commitHash) ||
    !isNullableString(value.completedBaselineId) ||
    !isRecord(value.plan) ||
    !['unsealed', 'sealed'].includes(String(value.plan.state))
  ) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze-run journal: ${file}`);
  }

  const revision = value.revision as number;
  const status = parseStoredStatus(value.status, file);
  const plan = parseStoredPlan(value.plan, file);
  if (value.schemaVersion === SCHEMA_VERSION && !Object.hasOwn(value, 'finalizationIntent')) {
    throw new AnalyzeRunJournalCorruptError(`Schema-v2 run is missing finalization intent state: ${file}`);
  }
  const finalizationIntent = value.schemaVersion === LEGACY_SCHEMA_VERSION
    ? (() => {
        if (value.finalizationIntent !== undefined && value.finalizationIntent !== null) {
          throw new AnalyzeRunJournalCorruptError(`Schema-v1 run contains v2 finalization intent: ${file}`);
        }
        return null;
      })()
    : parseStoredFinalizationIntent(value.finalizationIntent, file);
  if (finalizationIntent !== null) {
    const expectedBaselineId = finalizationIntent.promotion.expectedBaseline?.analysis.id ?? null;
    if (
      finalizationIntent.promotion.snapshot.id !== value.candidateAnalysisId
      || expectedBaselineId !== value.completedBaselineId
      || finalizationIntent.promotion.snapshot.branch !== value.branch
      || finalizationIntent.promotion.snapshot.commitHash !== value.commitHash
    ) {
      throw new AnalyzeRunJournalCorruptError(
        `Prepared finalization intent does not match its analyze run: ${file}`,
      );
    }
  }
  const terminalAt = status.state === 'blocked'
    ? status.blockedAt
    : status.state === 'failed'
      ? status.failedAt
      : status.state === 'finalizing'
        ? status.finalizingAt
        : status.state === 'completed'
          ? status.completedAt
        : null;
  const terminalTimestampIsImpossible = terminalAt !== null && (
    Date.parse(terminalAt) < Date.parse(value.startedAt) ||
    (plan.state === 'sealed' && Date.parse(terminalAt) < Date.parse(plan.sealedAt))
  );
  const lifecycleIsReachable = plan.state === 'unsealed'
    ? (
      finalizationIntent === null && (
      (status.state === 'running' && revision === 0 && value.updatedAt === value.startedAt) ||
      (
        status.state === 'failed' &&
        status.finalizingAt === null &&
        revision === 1 &&
        status.failedAt === value.updatedAt
      )
      )
    )
    : (
      Date.parse(plan.sealedAt) >= Date.parse(value.startedAt) && (
        (
          status.state === 'running' &&
          finalizationIntent === null &&
          [1, 2].includes(revision) &&
          value.updatedAt === plan.sealedAt &&
          plan.work.every((work) => work.state === 'pending')
        ) ||
        (
          status.state === 'blocked' &&
          finalizationIntent === null &&
          [2, 3].includes(revision) &&
          status.blockedAt === value.updatedAt &&
          plan.work.every((work) => work.state === 'pending')
        ) ||
        (
          status.state === 'failed' &&
          (
            (
              finalizationIntent === null &&
              [2, 3].includes(revision) &&
              status.finalizingAt === null &&
              plan.work.every((work) => work.state === 'pending')
            ) ||
            (
              revision === (finalizationIntent === null ? 4 : 5) &&
              status.finalizingAt !== null &&
              Date.parse(status.finalizingAt) >= Date.parse(plan.sealedAt) &&
              Date.parse(status.failedAt) >= Date.parse(status.finalizingAt) &&
              (finalizationIntent === null
                || (
                  Date.parse(finalizationIntent.preparedAt) >= Date.parse(status.finalizingAt)
                  && Date.parse(status.failedAt) >= Date.parse(finalizationIntent.preparedAt)
                )) &&
              plan.work.every((work) => work.state === 'succeeded-uncheckpointed')
            )
          ) &&
          status.failedAt === value.updatedAt
        ) ||
        (
          status.state === 'finalizing' &&
          revision === (finalizationIntent === null ? 3 : 4) &&
          (finalizationIntent === null
            ? status.finalizingAt === value.updatedAt
            : finalizationIntent.preparedAt === value.updatedAt
              && Date.parse(finalizationIntent.preparedAt) >= Date.parse(status.finalizingAt)) &&
          plan.work.every((work) => work.state === 'succeeded-uncheckpointed')
        ) || (
          status.state === 'completed' &&
          revision === 5 &&
          finalizationIntent !== null &&
          status.completedAt === value.updatedAt &&
          Date.parse(status.finalizingAt) >= Date.parse(plan.sealedAt) &&
          Date.parse(finalizationIntent.preparedAt) >= Date.parse(status.finalizingAt) &&
          Date.parse(status.completedAt) >= Date.parse(finalizationIntent.preparedAt) &&
          plan.work.every((work) => work.state === 'succeeded-uncheckpointed')
        )
      )
    );
  if (!lifecycleIsReachable || terminalTimestampIsImpossible) {
    throw new AnalyzeRunJournalCorruptError(`Impossible analyze-run lifecycle state: ${file}`);
  }
  /*
    Schema v2 retains revision 2 for durable execution admission. Terminal execution states and
    unprepared finalization use revision 3; preparing finalization advances to revision 4. A
    finalization failure advances to revision 4 when unprepared or revision 5 when prepared, while
    certified completion advances a prepared run to revision 5. The admission tombstone prevents
    a consumed plan from issuing another receipt. Future work-result commands must migrate or
    extend the durable schema with these invariants.
  */

  return {
    schemaVersion: SCHEMA_VERSION,
    attemptSequence: value.attemptSequence as number,
    revision,
    runId: validateRunId(value.runId),
    candidateAnalysisId: requireNonEmpty(value.candidateAnalysisId, 'candidateAnalysisId'),
    status,
    startedAt: validateTimestamp(value.startedAt, 'startedAt'),
    updatedAt: validateTimestamp(value.updatedAt, 'updatedAt'),
    source: validateSource(value.source),
    branch: value.branch,
    commitHash: value.commitHash,
    completedBaselineId: value.completedBaselineId,
    finalizationIntent,
    plan,
  };
}

function parseStoredFinalizationIntent(
  value: unknown,
  file: string,
): StoredAnalyzeRunFinalizationIntent | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || typeof value.preparedAt !== 'string'
    || !isRecord(value.promotion)
    || !isRecord(value.projection)
    || typeof value.projection.projectSlug !== 'string'
    || !isRecord(value.projection.historyEntry)
  ) {
    throw new AnalyzeRunJournalCorruptError(`Invalid prepared finalization intent: ${file}`);
  }
  const preparedAt = validateTimestamp(value.preparedAt, 'preparedAt');
  const promotion = value.promotion as unknown as CompletedAnalysisPromotion;
  const projection = {
    projectSlug: value.projection.projectSlug,
    promotedSnapshot: promotion.snapshot,
    historyEntry: value.projection.historyEntry as unknown as HistoryEntry,
  };
  validateCompletedAnalysisPromotion(
    promotion,
    buildAnalysisFilename(promotion.snapshot.id, promotion.snapshot.createdAt),
  );
  validateCompletedAnalysisProjectionIntent(projection);
  return {
    preparedAt,
    promotion,
    projection: {
      projectSlug: projection.projectSlug,
      historyEntry: projection.historyEntry,
    },
  };
}

function asCorruption(error: unknown, context: string): AnalyzeRunJournalCorruptError {
  if (error instanceof AnalyzeRunJournalCorruptError) return error;
  return new AnalyzeRunJournalCorruptError(
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function parseStoredStatus(value: Record<string, unknown>, file: string): StoredAnalyzeRun['status'] {
  if (value.state === 'running') return { state: 'running' };
  if (value.state === 'failed') {
    const finalizingAt = value.finalizingAt === null || value.finalizingAt === undefined
      ? null
      : validateTimestamp(value.finalizingAt, 'finalizingAt');
    return {
      state: 'failed',
      code: validateErrorCode(value.code),
      message: validatePublicErrorMessage(value.message),
      failedAt: validateTimestamp(value.failedAt, 'failedAt'),
      finalizingAt,
    };
  }
  if (value.state === 'finalizing') {
    return {
      state: 'finalizing',
      finalizingAt: validateTimestamp(value.finalizingAt, 'finalizingAt'),
    };
  }
  if (value.state === 'completed') {
    return {
      state: 'completed',
      finalizingAt: validateTimestamp(value.finalizingAt, 'finalizingAt'),
      completedAt: validateTimestamp(value.completedAt, 'completedAt'),
    };
  }
  if (
    value.state !== 'blocked' ||
    value.reason !== 'provider-session-limit' ||
    typeof value.resetHint !== 'string' ||
    typeof value.blockedAt !== 'string'
  ) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze-run status: ${file}`);
  }
  return {
    state: 'blocked',
    reason: 'provider-session-limit',
    resetHint: requireNonEmpty(value.resetHint, 'resetHint'),
    blockedAt: validateTimestamp(value.blockedAt, 'blockedAt'),
  };
}

function parseStoredPlan(value: Record<string, unknown>, file: string): StoredAnalyzeRun['plan'] {
  if (value.state === 'unsealed') return { state: 'unsealed' };
  if (value.state !== 'sealed' || typeof value.sealedAt !== 'string' || !Array.isArray(value.work)) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze-run plan: ${file}`);
  }
  const work = value.work.map<StoredAnalyzeRunWork>((item) => {
    const state = isRecord(item) ? item.state : undefined;
    if (
      !isRecord(item) ||
      typeof item.workId !== 'string' ||
      typeof item.inputFingerprint !== 'string' ||
      (state !== 'pending' && state !== 'succeeded-uncheckpointed')
    ) {
      throw new AnalyzeRunJournalCorruptError(`Invalid analyze-run work record: ${file}`);
    }
    return {
      workId: requireNonEmpty(item.workId, 'workId'),
      inputFingerprint: validateFingerprint(item.inputFingerprint),
      state,
    };
  });
  if (new Set(work.map((item) => item.workId)).size !== work.length) {
    throw new AnalyzeRunJournalCorruptError(`Duplicate work IDs in analyze-run journal: ${file}`);
  }
  if (work.length === 0) {
    throw new AnalyzeRunJournalCorruptError(`Empty LLM work plan in analyze-run journal: ${file}`);
  }
  return {
    state: 'sealed',
    sealedAt: validateTimestamp(value.sealedAt, 'sealedAt'),
    work,
  };
}

function readAllRuns(repoPath: string): StoredAnalyzeRun[] {
  const dir = runsDir(repoPath);
  if (!fs.existsSync(dir)) return [];
  const runs: StoredAnalyzeRun[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === LATEST_ATTEMPT_FILE || !name.endsWith('.json')) continue;
    const expectedRunId = name.slice(0, -'.json'.length);
    const file = path.join(dir, name);
    runs.push(parseStoredRun(readJson(file), file, expectedRunId));
  }
  if (new Set(runs.map((run) => run.attemptSequence)).size !== runs.length) {
    throw new AnalyzeRunJournalCorruptError(
      `Duplicate analyze-run attempt sequences in journal: ${dir}`,
    );
  }
  const sequences = runs.map((run) => run.attemptSequence).sort((a, b) => a - b);
  if (sequences.some((sequence, index) => sequence !== index + 1)) {
    throw new AnalyzeRunJournalCorruptError(
      `Non-contiguous analyze-run attempt sequences in journal: ${dir}`,
    );
  }
  return runs;
}

function latestStoredRun(runs: StoredAnalyzeRun[]): StoredAnalyzeRun {
  return runs.reduce((latest, run) =>
    run.attemptSequence > latest.attemptSequence ? run : latest);
}

function writeLatestPointer(repoPath: string, runId: string): void {
  atomicWriteJson(pointerPath(repoPath), {
    schemaVersion: SCHEMA_VERSION,
    runId,
  } satisfies LatestAttemptPointer);
}

function validateLatestPointerTarget(repoPath: string): void {
  const file = pointerPath(repoPath);
  if (!fs.existsSync(file)) return;
  const pointer = parseLatestPointer(readJson(file), file);
  const target = runPath(repoPath, pointer.runId);
  if (!fs.existsSync(target)) {
    throw new AnalyzeRunJournalCorruptError(
      `Latest analyze-run pointer references a missing run: ${pointer.runId}`,
    );
  }
  parseStoredRun(readJson(target), target, pointer.runId);
}

function sameBeginIdentity(existing: StoredAnalyzeRun, input: NewStoredAnalyzeRun): boolean {
  return isDeepStrictEqual(
    {
      schemaVersion: existing.schemaVersion,
      runId: existing.runId,
      candidateAnalysisId: existing.candidateAnalysisId,
      startedAt: existing.startedAt,
      source: existing.source,
      branch: existing.branch,
      commitHash: existing.commitHash,
      completedBaselineId: existing.completedBaselineId,
    },
    {
      schemaVersion: input.schemaVersion,
      runId: input.runId,
      candidateAnalysisId: input.candidateAnalysisId,
      startedAt: input.startedAt,
      source: input.source,
      branch: input.branch,
      commitHash: input.commitHash,
      completedBaselineId: input.completedBaselineId,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
