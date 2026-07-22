import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteJson } from './atomic-write.js';
import { fingerprint } from './canonical-json.js';
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
import {
  activeCompletedBaselineId,
  buildAnalysisFilename,
  getAnalysisStore,
} from './analysis-store.js';
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
import {
  inspectAnalyzeRunWorkCheckpointCertification,
  type AnalyzeRunWorkCheckpointCertification,
} from './analyze-run-work-checkpoint-certification.js';
import { installAnalyzeRunResumeCandidateReader } from './analyze-run-resume-candidate.js';
import type { AnalyzeLlmExecutionUsage } from '../services/llm/analyze-llm-execution-evidence.js';
import { validateLlmWorkExecutionIntent } from '../services/llm/work-identity.js';
import {
  inspectAnalyzeRunResumeActivationCertification,
  type AnalyzeRunResumeActivationCertification,
} from './analyze-run-resume-activation-certification.js';
import {
  buildAnalyzeRunAmbiguousRearmOffer,
  inspectAnalyzeRunAmbiguousRearmConsent,
  type AnalyzeRunAmbiguousRearmConsent,
  type AnalyzeRunAmbiguousRearmEvidence,
  type AnalyzeRunAmbiguousRearmExecutionEpochState,
  type AnalyzeRunAmbiguousRearmOffer,
} from './analyze-run-ambiguous-rearm.js';
import {
  inspectAnalyzeRunAmbiguousRearmActivationCertification,
  type AnalyzeRunAmbiguousRearmActivationCertification,
} from './analyze-run-ambiguous-rearm-activation-certification.js';
import { certifyClaudeSessionResetAt } from '@truecourse/shared/llm';

export type { AnalyzeRunExecutionCompletion } from './analyze-run-execution-completion.js';

const SCHEMA_VERSION = 9 as const;
const INITIAL_ADMISSION_SCHEMA_VERSION = 8 as const;
const SEALED_EXECUTION_SCHEMA_VERSION = 7 as const;
const REQUESTED_MODEL_PIN_SCHEMA_VERSION = 6 as const;
const RESUME_ADMISSION_SCHEMA_VERSION = 5 as const;
const EXECUTION_ATTEMPT_SCHEMA_VERSION = 4 as const;
const CHECKPOINT_SCHEMA_VERSION = 3 as const;
const LEGACY_SCHEMA_VERSION = 1 as const;
const PREVIOUS_SCHEMA_VERSION = 2 as const;
const RUNS_DIR = path.join('.truecourse', 'analyses', 'runs');
const LATEST_ATTEMPT_FILE = 'LATEST_ATTEMPT.json';

function isSupportedSchemaVersion(
  value: unknown,
): value is 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  return value === LEGACY_SCHEMA_VERSION
    || value === PREVIOUS_SCHEMA_VERSION
    || value === CHECKPOINT_SCHEMA_VERSION
    || value === EXECUTION_ATTEMPT_SCHEMA_VERSION
    || value === RESUME_ADMISSION_SCHEMA_VERSION
    || value === REQUESTED_MODEL_PIN_SCHEMA_VERSION
    || value === SEALED_EXECUTION_SCHEMA_VERSION
    || value === INITIAL_ADMISSION_SCHEMA_VERSION
    || value === SCHEMA_VERSION;
}

export type AnalyzeRunSource = 'cli' | 'dashboard' | 'hosted';

export type AnalyzeRunResumeUnavailableReason =
  | 'successful-results-not-checkpointed'
  | 'checkpoint-execution-unbound'
  | 'resume-execution-ambiguous'
  | 'finalization-unprepared'
  | 'run-failed'
  | 'run-not-resumable'
  | 'run-completed';

export type AnalyzeRunResumeAvailability =
  | Readonly<{
      /**
       * Structurally eligible only. The caller must also prove this is the exact latest
       * attempt; production then revalidates every durable input before admission.
       */
      available: true;
      scope: 'structural';
      mode: 'resume';
      requiresLatestAttempt: true;
      requiresRevalidation: true;
    }>
  | Readonly<{
      available: false;
      scope: 'structural';
      reason: AnalyzeRunResumeUnavailableReason;
    }>;

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
  execution: AnalyzeRunExecutionIntent;
  work: Array<{
    workId: string;
    inputFingerprint: string;
  }>;
}

export interface AnalyzeRunExecutionIntent {
  provider: string;
  requestedModel: string | null;
}

declare const analyzeRunPlanActivationBrand: unique symbol;
declare const analyzeRunCheckpointWriterBrand: unique symbol;
declare const analyzeRunResumePlanActivationBrand: unique symbol;

/**
 * In-process proof that the journal durably sealed one exact analyze work plan.
 * The runtime value is issued and tracked privately by this module; a caller
 * cannot manufacture a valid receipt by satisfying the TypeScript shape.
 */
export type AnalyzeRunPlanActivation = Readonly<{
  [analyzeRunPlanActivationBrand]: true;
}>;

export type AnalyzeRunCheckpointWriter = Readonly<{
  [analyzeRunCheckpointWriterBrand]: true;
}>;

export type AnalyzeRunResumePlanActivation = Readonly<{
  [analyzeRunResumePlanActivationBrand]: true;
}>;

const analyzeRunPlanActivations = new WeakMap<object, {
  storage: AnalyzeRunStorage;
  repoKey: string;
  scopeKey: string;
  runId: string;
  revision: number;
  workKey: string;
  execution: AnalyzeRunExecutionIntent;
  cacheKey: string;
  claimed: boolean;
}>();
const analyzeRunPlanActivationReceipts = new WeakMap<
  AnalyzeRunStorage,
  Map<string, AnalyzeRunPlanActivation>
>();

const analyzeRunCheckpointWriters = new WeakMap<object, {
  storage: AnalyzeRunStorage;
  repoKey: string;
  runId: string;
  workKey: string;
  execution: AnalyzeRunExecutionIntent;
  sealedAt: string;
  active: boolean;
}>();

const analyzeRunResumePlanActivations = new WeakMap<object, {
  storage: AnalyzeRunStorage;
  repoKey: string;
  runId: string;
  revision: number;
  workKey: string;
  execution: AnalyzeRunExecutionIntent;
  pendingWorkIds: readonly string[];
  reusedWorkIds: readonly string[];
  executionPin: AnalyzeRunResumeExecutionPin;
  attemptSequence: number;
  mode:
    | 'activated'
    | 'ambiguous-activated'
    | 'executing-complete-provider-session-limit'
    | 'executing-complete-ambiguous-rearm';
  claimed: boolean;
}>();

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

export interface CheckpointAnalyzeRunWorkCommand {
  workId: string;
  inputFingerprint: string;
  checkpointedAt: string;
  attemptId: string;
  resultContractId: string;
  result: unknown;
  usage: AnalyzeLlmExecutionUsage | null;
}

export interface AnalyzeRunWorkCheckpoint {
  checkpointedAt: string;
  attemptId: string;
  resultContractId: string;
  resultFingerprint: string;
  result: unknown;
  usage: AnalyzeLlmExecutionUsage | null;
}

export interface AnalyzeRunCheckpointEvidence {
  readonly workId: string;
  readonly inputFingerprint: string;
  readonly checkpointedAt: string;
  readonly attemptId: string;
  readonly usage: Readonly<AnalyzeLlmExecutionUsage> | null;
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

export interface BeginPreparedAnalyzeRunFinalizationCommand
  extends PrepareAnalyzeRunFinalizationCommand {
  finalizingAt: string;
}

export interface ActivateAnalyzeRunResumeCommand extends Omit<BeginAnalyzeRunCommand, 'kind'> {
  kind: 'activate-resume';
  activatedAt: string;
  work: readonly { readonly workId: string; readonly inputFingerprint: string }[];
  reusedWorkIds: readonly string[];
  pendingWorkIds: readonly string[];
  executionPin: Readonly<AnalyzeRunResumeExecutionPin>;
  observed: Readonly<{
    runRevision: number;
    attemptSequence: number;
    latestAttemptSequence: number;
    completedBaselineFingerprint: string | null;
  }>;
}

export interface ActivateAnalyzeRunAmbiguousRearmCommand
  extends Omit<ActivateAnalyzeRunResumeCommand, 'kind'> {
  kind: 'activate-ambiguous-rearm';
  consent: AnalyzeRunAmbiguousRearmConsent;
}

export type ActivateAnalyzeRunResumeResult = Readonly<{
  view: AnalyzeRunView;
  activation: AnalyzeRunResumePlanActivation;
}>;

export type ActivateAnalyzeRunAmbiguousRearmResult = ActivateAnalyzeRunResumeResult;

interface AnalyzeRunResumeExecutionBasePin {
  provider: string;
  requestedModel: string | null;
}

export type AnalyzeRunResumeExecutionPin = AnalyzeRunResumeExecutionBasePin & (
  | { modelSelection: 'requested'; resolvedModel: null }
  | { modelSelection: 'resolved'; resolvedModel: string }
);

export type AnalyzeRunInitialAdmission =
  | Readonly<{
      admission: 'activated';
      admittedAt: null;
      evidence: 'explicit' | 'legacy-inferred';
    }>
  | Readonly<{
      admission: 'executing';
      admittedAt: string;
      evidence: 'explicit';
    }>
  | Readonly<{
      admission: 'executing';
      admittedAt: null;
      evidence: 'legacy-inferred';
    }>
  | Readonly<{
      admission: 'ambiguous';
      admittedAt: null;
      evidence: 'legacy-ambiguous';
    }>;

export interface AnalyzeRunExecutionAttempt {
  number: number;
  activatedAt: string;
  initialAdmission: AnalyzeRunInitialAdmission | null;
  resume: null | {
    activation: 'provider-session-limit' | 'ambiguous-rearm';
    admission: 'activated' | 'executing';
    admittedAt: string | null;
    resumedFrom: null | {
      reason: 'provider-session-limit';
      resetHint: string;
      blockedAt: string;
    };
    executionPin: AnalyzeRunResumeExecutionPin;
  };
}

export interface AnalyzeRunAmbiguousRearmRecord {
  evidence: AnalyzeRunAmbiguousRearmEvidence;
  acceptedAt: string;
  acceptedRisk: 'repeat-up-to-pending-provider-calls';
  acceptedMaxRepeatProviderCalls: number;
  executionPin: AnalyzeRunResumeExecutionPin;
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
  executionAttempt: AnalyzeRunExecutionAttempt;
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
  /** Most recent durable provider-limit report, retained after Resume activation. */
  lastProviderLimit: null | {
    reason: 'provider-session-limit';
    resetHint: string;
    blockedAt: string;
    /** Certified UTC instant derived from the durable hint + block timestamp. */
    resetAt: string | null;
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
  resume: AnalyzeRunResumeAvailability;
  /** Exact-latest structural risk evidence; execution still requires full revalidation. */
  rearm: AnalyzeRunAmbiguousRearmOffer | null;
}

export type StoredAnalyzeRunWork = {
  workId: string;
  inputFingerprint: string;
  state: 'pending' | 'succeeded-uncheckpointed';
} | {
  workId: string;
  inputFingerprint: string;
  state: 'succeeded-checkpointed';
  checkpoint: AnalyzeRunWorkCheckpoint;
};

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
  executionAttempt: AnalyzeRunExecutionAttempt;
  rearmHistory: AnalyzeRunAmbiguousRearmRecord[];
  finalizationIntent: StoredAnalyzeRunFinalizationIntent | null;
  plan:
    | { state: 'unsealed' }
    | {
        state: 'sealed';
        sealedAt: string;
        execution: AnalyzeRunExecutionIntent | null;
        work: StoredAnalyzeRunWork[];
      };
}

const sourceAnalyzeRunSchemaVersions = new WeakMap<
  StoredAnalyzeRun,
  ParsedLatestAttemptPointer['schemaVersion']
>();

export type NewStoredAnalyzeRun = Omit<StoredAnalyzeRun, 'attemptSequence'>;

interface LatestAttemptPointer {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
}

interface ParsedLatestAttemptPointer {
  schemaVersion:
    | typeof LEGACY_SCHEMA_VERSION
    | typeof PREVIOUS_SCHEMA_VERSION
    | typeof CHECKPOINT_SCHEMA_VERSION
    | typeof EXECUTION_ATTEMPT_SCHEMA_VERSION
    | typeof RESUME_ADMISSION_SCHEMA_VERSION
    | typeof REQUESTED_MODEL_PIN_SCHEMA_VERSION
    | typeof SEALED_EXECUTION_SCHEMA_VERSION
    | typeof INITIAL_ADMISSION_SCHEMA_VERSION
    | typeof SCHEMA_VERSION;
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

export class AnalyzeRunLatestAttemptConflictError extends Error {
  constructor(runId: string) {
    super(`Analyze run ${runId} is no longer the latest attempted run`);
    this.name = 'AnalyzeRunLatestAttemptConflictError';
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
  /** Read-only latest lookup. It must not repair or publish a pointer. */
  inspectLatest(repoKey: string): Promise<StoredAnalyzeRun | null>;
  compareAndSwap(
    repoKey: string,
    runId: string,
    expectedRevision: number,
    next: StoredAnalyzeRun,
  ): Promise<void>;
  /** Atomically compare the target revision and semantic latest attempt before writing. */
  compareAndSwapLatest(
    repoKey: string,
    runId: string,
    expectedRevision: number,
    expectedAttemptSequence: number,
    expectedLatestAttemptSequence: number,
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
      atomicWriteJson(file, serializeStoredRun(stored));
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

  async inspectLatest(repoPath: string): Promise<StoredAnalyzeRun | null> {
    const canonicalPath = canonicalRepoPath(repoPath);
    const runs = readAllRuns(canonicalPath);
    return runs.length === 0 ? null : latestStoredRun(runs);
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
      atomicWriteJson(runPath(canonicalPath, runId), serializeStoredRun(next));
    });
  }

  async compareAndSwapLatest(
    repoPath: string,
    runId: string,
    expectedRevision: number,
    expectedAttemptSequence: number,
    expectedLatestAttemptSequence: number,
    next: StoredAnalyzeRun,
  ): Promise<void> {
    const canonicalPath = canonicalRepoPath(repoPath);
    await this.serialize(canonicalPath, async () => {
      const runs = readAllRuns(canonicalPath);
      const current = runs.find((run) => run.runId === runId);
      if (!current) throw new AnalyzeRunNotFoundError(runId);
      if (current.revision !== expectedRevision) {
        throw new AnalyzeRunRevisionConflictError(runId, expectedRevision, current.revision);
      }
      const latest = latestStoredRun(runs);
      if (
        current.attemptSequence !== expectedAttemptSequence
        || latest.runId !== runId
        || latest.attemptSequence !== expectedLatestAttemptSequence
      ) {
        throw new AnalyzeRunLatestAttemptConflictError(runId);
      }
      atomicWriteJson(runPath(canonicalPath, runId), serializeStoredRun(next));
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

installAnalyzeRunResumeCandidateReader(async (repoKey, runId) => {
  const storage = activeStorage;
  const durableRepoKey = activationScopeKey(repoKey, storage);
  const current = await storage.read(durableRepoKey, validateRunId(runId));
  assertAnalyzeRunStorage(storage);
  if (!current) return null;
  const latest = await storage.inspectLatest(durableRepoKey);
  assertAnalyzeRunStorage(storage);
  const plan = current.plan.state === 'unsealed'
    ? 'unsealed' as const
    : Object.freeze({
        sealedAt: current.plan.sealedAt,
        execution: current.plan.execution === null
          ? null
          : Object.freeze({ ...current.plan.execution }),
        work: Object.freeze(current.plan.work.map((item) => Object.freeze(
          item.state === 'succeeded-checkpointed'
            ? {
                workId: item.workId,
                inputFingerprint: item.inputFingerprint,
                state: item.state,
                checkpoint: structuredClone(item.checkpoint),
              }
            : {
                workId: item.workId,
                inputFingerprint: item.inputFingerprint,
                state: item.state,
              },
        ))),
      });
  return Object.freeze({
    storageIdentity: storage,
    isLatestAttempt: latest?.runId === current.runId,
    attemptSequence: current.attemptSequence,
    latestAttemptSequence: latest?.attemptSequence ?? 0,
    revision: current.revision,
    runId: current.runId,
    candidateAnalysisId: current.candidateAnalysisId,
    state: current.status.state,
    startedAt: current.startedAt,
    source: current.source,
    branch: current.branch,
    commitHash: current.commitHash,
    completedBaselineId: current.completedBaselineId,
    executionAttempt: structuredClone(current.executionAttempt),
    blocked: current.status.state === 'blocked'
      ? Object.freeze({
          resetHint: current.status.resetHint,
          blockedAt: current.status.blockedAt,
        })
      : null,
    plan,
  });
});

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
    executionAttempt: {
      number: 1,
      activatedAt: validateTimestamp(command.startedAt, 'startedAt'),
      initialAdmission: {
        admission: 'activated',
        admittedAt: null,
        evidence: 'explicit',
      },
      resume: null,
    },
    rearmHistory: [],
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
  const expectedExecution = normalizeSealPlanExecution(command.execution);
  let stored = await storage.read(durableRepoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (
    stored?.status.state === 'running' &&
    stored.plan.state === 'sealed'
  ) {
    if (
      activationWorkKey(stored.plan.work) !== activationWorkKey(expectedWork)
      || !isDeepStrictEqual(stored.plan.execution, expectedExecution)
    ) {
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
    stored.plan.state !== 'sealed' ||
    stored.revision !== 1 ||
    activationWorkKey(stored.plan.work) !== activationWorkKey(expectedWork) ||
    !isDeepStrictEqual(stored.plan.execution, expectedExecution)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${command.runId} sealed plan changed during activation`,
    );
  }
  if (stored.plan.execution === null) {
    throw new AnalyzeRunJournalCorruptError(
      `Analyze run ${command.runId} has no bound sealed execution intent`,
    );
  }
  const workKey = activationWorkKey(stored.plan.work);
  const execution = Object.freeze({ ...stored.plan.execution });
  const cacheKey = JSON.stringify([
    durableRepoKey,
    stored.runId,
    stored.revision,
    workKey,
    execution,
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
    execution,
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

export type AnalyzeRunResumeAdmission<T> =
  | { readonly admitted: false }
  | {
      readonly admitted: true;
      readonly execution: Promise<Readonly<{
        result: T;
        certification: AnalyzeRunExecutionCertification;
        checkpoints: readonly AnalyzeRunCheckpointEvidence[];
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
  admittedAt: string,
  validate: () => void,
  admit: (checkpointWriter: AnalyzeRunCheckpointWriter) => Promise<T>,
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
    stored.executionAttempt.number === 1 &&
    stored.executionAttempt.initialAdmission?.admission === 'activated' &&
    stored.executionAttempt.initialAdmission.evidence === 'explicit' &&
    isDeepStrictEqual(stored.plan.execution, activation.execution) &&
    activation.workKey === activationWorkKey(stored.plan.work)
  );
  if (!stillExecutable || !stored || stored.plan.state !== 'sealed') return { admitted: false };
  if (analyzeRunPlanActivations.get(receipt) !== activation || activation.claimed) {
    return { admitted: false };
  }
  validate();
  activation.claimed = true;
  let checkpointBinding: {
    storage: AnalyzeRunStorage;
    repoKey: string;
    runId: string;
    workKey: string;
    execution: AnalyzeRunExecutionIntent;
    sealedAt: string;
    active: boolean;
  } | undefined;
  try {
    const canonicalAdmittedAt = canonicalTimestamp(admittedAt, 'admittedAt');
    if (
      new Date(canonicalAdmittedAt).toISOString() !== canonicalAdmittedAt
      || Date.parse(canonicalAdmittedAt) < Date.parse(stored.updatedAt)
    ) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} initial execution admission has invalid chronology`,
      );
    }
    const admitted: StoredAnalyzeRun = {
      ...stored,
      revision: stored.revision + 1,
      updatedAt: canonicalAdmittedAt,
      executionAttempt: {
        ...stored.executionAttempt,
        initialAdmission: {
          admission: 'executing',
          admittedAt: canonicalAdmittedAt,
          evidence: 'explicit',
        },
      },
    };
    await storage.compareAndSwap(
      activation.repoKey,
      activation.runId,
      stored.revision,
      admitted,
    );
    assertAnalyzeRunStorage(storage);
    const durablyAdmitted = await storage.read(activation.repoKey, activation.runId);
    assertAnalyzeRunStorage(storage);
    if (
      !durablyAdmitted
      || durablyAdmitted.status.state !== 'running'
      || durablyAdmitted.plan.state !== 'sealed'
      || durablyAdmitted.revision !== admitted.revision
      || durablyAdmitted.executionAttempt.initialAdmission?.admission !== 'executing'
      || durablyAdmitted.executionAttempt.initialAdmission.evidence !== 'explicit'
      || !isDeepStrictEqual(durablyAdmitted.plan.execution, activation.execution)
      || activation.workKey !== activationWorkKey(durablyAdmitted.plan.work)
    ) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${activation.runId} sealed execution changed during provider admission`,
      );
    }
    validate();
    const checkpointWriter = Object.freeze({}) as AnalyzeRunCheckpointWriter;
    checkpointBinding = {
      storage,
      repoKey: activation.repoKey,
      runId: activation.runId,
      workKey: activation.workKey,
      execution: activation.execution,
      sealedAt: durablyAdmitted.plan.sealedAt,
      active: true,
    };
    analyzeRunCheckpointWriters.set(checkpointWriter, checkpointBinding);
    analyzeRunPlanActivations.delete(receipt);
    analyzeRunPlanActivationReceipts.get(storage)?.delete(activation.cacheKey);
    const admittedExecution = admit(checkpointWriter);
    const execution = admittedExecution.then(async (result) => {
      checkpointBinding!.active = false;
      const completed = await storage.read(activation.repoKey, activation.runId);
      assertAnalyzeRunStorage(storage);
      if (
        !completed
        || completed.status.state !== 'running'
        || completed.plan.state !== 'sealed'
        || !isDeepStrictEqual(completed.plan.execution, activation.execution)
        || completed.plan.work.some((item) => item.state !== 'succeeded-checkpointed')
        || activation.workKey !== activationWorkKey(completed.plan.work)
      ) {
        throw new InvalidAnalyzeRunTransitionError(
          `Analyze run ${activation.runId} did not durably checkpoint every certified result`,
        );
      }
      const certification = issueAnalyzeRunExecutionCertification({
        storage,
        scopeKey: activation.scopeKey,
        runId: activation.runId,
        revision: completed.revision,
        workKey: activation.workKey,
        execution: activation.execution,
      });
      return Object.freeze({ result, certification });
    }, (error) => {
      checkpointBinding!.active = false;
      throw error;
    });
    return { admitted: true, execution };
  } catch (error) {
    if (checkpointBinding) checkpointBinding.active = false;
    const current = await storage.read(activation.repoKey, activation.runId);
    assertAnalyzeRunStorage(storage);
    if (current?.revision === activation.revision) {
      activation.claimed = false;
    } else {
      analyzeRunPlanActivations.delete(receipt);
      analyzeRunPlanActivationReceipts.get(storage)?.delete(activation.cacheKey);
    }
    throw error;
  }
}

/**
 * Atomically activate one exact latest blocked attempt for certified resume,
 * or recover a receipt for an already durable certified activation/completion.
 * This transition does not admit or call a provider. The caller must retain
 * the repository lifecycle lock through the later admission/finalization flow.
 */
export async function activateAnalyzeRunResume(
  repoKey: string,
  certification: AnalyzeRunResumeActivationCertification,
): Promise<ActivateAnalyzeRunResumeResult> {
  const command = inspectAnalyzeRunResumeActivationCertification(certification);
  if (!command) {
    throw new InvalidAnalyzeRunTransitionError('Analyze resume activation is not certified');
  }
  const storage = activeStorage;
  const durableRepoKey = activationScopeKey(repoKey, storage);
  const runId = validateRunId(command.runId);
  const current = await storage.read(durableRepoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  const latest = await storage.inspectLatest(durableRepoKey);
  assertAnalyzeRunStorage(storage);
  const recoveringActivated = current.status.state === 'running'
    && current.executionAttempt.number > 1
    && (
      current.executionAttempt.resume?.activation === 'provider-session-limit'
      || current.executionAttempt.resume?.activation === 'ambiguous-rearm'
    )
    && current.executionAttempt.resume?.admission === 'activated';
  const recoveringCompletedExecution = current.status.state === 'running'
    && current.executionAttempt.number > 1
    && (
      current.executionAttempt.resume?.activation === 'provider-session-limit'
      || current.executionAttempt.resume?.activation === 'ambiguous-rearm'
    )
    && current.executionAttempt.resume?.admission === 'executing'
    && current.plan.state === 'sealed'
    && current.plan.work.every((work) => work.state === 'succeeded-checkpointed');
  const recoveringDurableAttempt = recoveringActivated || recoveringCompletedExecution;
  const blockedStatus = current.status.state === 'blocked' ? current.status : null;
  if (
    (!blockedStatus && !recoveringDurableAttempt)
    || current.plan.state !== 'sealed'
    || current.finalizationIntent !== null
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot activate analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }
  if (
    latest?.runId !== current.runId
    || latest.attemptSequence !== current.attemptSequence
    || command.observed.runRevision !== current.revision
    || command.observed.attemptSequence !== current.attemptSequence
    || command.observed.latestAttemptSequence !== latest.attemptSequence
  ) {
    throw new AnalyzeRunLatestAttemptConflictError(runId);
  }
  const expectedIdentity = {
    candidateAnalysisId: requireNonEmpty(command.candidateAnalysisId, 'candidateAnalysisId'),
    startedAt: validateTimestamp(command.startedAt, 'startedAt'),
    source: validateSource(command.source),
    branch: validateNullableString(command.branch, 'branch'),
    commitHash: validateNullableString(command.commitHash, 'commitHash'),
    completedBaselineId: validateNullableString(
      command.completedBaselineId,
      'completedBaselineId',
    ),
  };
  if (!isDeepStrictEqual(expectedIdentity, {
    candidateAnalysisId: current.candidateAnalysisId,
    startedAt: current.startedAt,
    source: current.source,
    branch: current.branch,
    commitHash: current.commitHash,
    completedBaselineId: current.completedBaselineId,
  })) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} resume identity changed before activation`,
    );
  }
  if (activationWorkKey(command.work) !== activationWorkKey(current.plan.work)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} sealed work changed before resume activation`,
    );
  }
  const pendingWorkIds = current.plan.work
    .filter((work) => work.state === 'pending')
    .map((work) => work.workId);
  const reusedWorkIds = current.plan.work
    .filter((work) => work.state === 'succeeded-checkpointed')
    .map((work) => work.workId);
  if (
    current.plan.work.some((work) => work.state === 'succeeded-uncheckpointed')
    || !isDeepStrictEqual([...command.pendingWorkIds].sort(), [...pendingWorkIds].sort())
    || !isDeepStrictEqual([...command.reusedWorkIds].sort(), [...reusedWorkIds].sort())
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} resume work partition changed before activation`,
    );
  }
  const executionPinBase = normalizeExecutionIntent(command.executionPin);
  const executionPin: AnalyzeRunResumeExecutionPin = command.executionPin.modelSelection === 'requested'
    && command.executionPin.resolvedModel === null
    ? { ...executionPinBase, modelSelection: 'requested', resolvedModel: null }
    : command.executionPin.modelSelection === 'resolved'
      ? {
          ...executionPinBase,
          modelSelection: 'resolved',
          resolvedModel: requireNonEmpty(
            command.executionPin.resolvedModel,
            'executionPin.resolvedModel',
          ),
        }
      : (() => {
          throw new InvalidAnalyzeRunTransitionError('Invalid resume model selection');
        })();
  if (
    (executionPin.modelSelection === 'resolved'
      && executionPin.resolvedModel.trim() !== executionPin.resolvedModel)
  ) {
    throw new InvalidAnalyzeRunTransitionError('Resume execution pin contains surrounding whitespace');
  }
  if (
    current.plan.execution === null
    || !isDeepStrictEqual(current.plan.execution, executionPinBase)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} sealed execution changed before resume activation`,
    );
  }
  const sealedExecution = Object.freeze({ ...current.plan.execution });
  if (
    recoveringDurableAttempt
    && !isDeepStrictEqual(current.executionAttempt.resume?.executionPin, executionPin)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} activated execution pin changed before recovery`,
    );
  }

  const analysisStore = getAnalysisStore();
  const baselineFingerprint = await readActiveCompletedBaselineFingerprint(
    analysisStore,
    durableRepoKey,
    current.completedBaselineId,
  );
  if (
    getAnalysisStore() !== analysisStore
    || baselineFingerprint !== command.observed.completedBaselineFingerprint
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} completed baseline changed before activation`,
    );
  }
  const requestedActivationAt = canonicalTimestamp(command.activatedAt, 'activatedAt');
  const activatedAt = recoveringDurableAttempt
    ? current.executionAttempt.activatedAt
    : requestedActivationAt;
  if (
    recoveringDurableAttempt
      ? requestedActivationAt !== activatedAt
      : Date.parse(activatedAt) < Date.parse(current.updatedAt)
        || Date.parse(activatedAt) < Date.parse(blockedStatus!.blockedAt)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} resume activation does not match its durable chronology`,
    );
  }
  const next: StoredAnalyzeRun = recoveringDurableAttempt
    ? current
    : {
        ...current,
        schemaVersion: SCHEMA_VERSION,
        revision: current.executionAttempt.number === 1
          ? 4 + reusedWorkIds.length
          : current.revision + 1,
        updatedAt: activatedAt,
        status: { state: 'running' },
        executionAttempt: {
          number: current.executionAttempt.number + 1,
          activatedAt,
          initialAdmission: null,
          resume: {
            activation: 'provider-session-limit',
            admission: 'activated',
            admittedAt: null,
            resumedFrom: {
              reason: 'provider-session-limit',
              resetHint: blockedStatus!.resetHint,
              blockedAt: blockedStatus!.blockedAt,
            },
            executionPin,
          },
        },
      };

  const baselineFingerprintBeforeCas = await readActiveCompletedBaselineFingerprint(
    analysisStore,
    durableRepoKey,
    current.completedBaselineId,
  );
  if (
    activeStorage !== storage
    || getAnalysisStore() !== analysisStore
    || baselineFingerprintBeforeCas !== baselineFingerprint
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} storage or completed baseline changed before activation`,
    );
  }
  if (recoveringDurableAttempt) {
    const currentBeforeReceipt = await storage.read(durableRepoKey, runId);
    assertAnalyzeRunStorage(storage);
    const latestBeforeReceipt = await storage.inspectLatest(durableRepoKey);
    assertAnalyzeRunStorage(storage);
    if (
      currentBeforeReceipt?.revision !== current.revision
      || latestBeforeReceipt?.runId !== runId
      || latestBeforeReceipt.attemptSequence !== current.attemptSequence
    ) {
      throw new AnalyzeRunLatestAttemptConflictError(runId);
    }
  } else {
    await storage.compareAndSwapLatest(
      durableRepoKey,
      runId,
      current.revision,
      current.attemptSequence,
      latest.attemptSequence,
      next,
    );
  }
  assertAnalyzeRunStorage(storage);
  const activatedStored = await storage.read(durableRepoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!activatedStored || !isDeepStrictEqual(activatedStored, next)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} durable state changed during resume activation`,
    );
  }
  const activation = Object.freeze({}) as AnalyzeRunResumePlanActivation;
  analyzeRunResumePlanActivations.set(activation, {
    storage,
    repoKey: durableRepoKey,
    runId,
    revision: next.revision,
    workKey: activationWorkKey(current.plan.work),
    execution: sealedExecution,
    pendingWorkIds: Object.freeze([...pendingWorkIds]),
    reusedWorkIds: Object.freeze([...reusedWorkIds]),
    executionPin,
    attemptSequence: next.attemptSequence,
    mode: recoveringCompletedExecution
      ? next.executionAttempt.resume?.activation === 'ambiguous-rearm'
        ? 'executing-complete-ambiguous-rearm'
        : 'executing-complete-provider-session-limit'
      : next.executionAttempt.resume?.activation === 'ambiguous-rearm'
        ? 'ambiguous-activated'
        : 'activated',
    claimed: false,
  });
  return Object.freeze({ view: toView(next), activation });
}

/**
 * Atomically accept one exact duplicate-spend consent and rearm the ambiguous
 * latest execution epoch. This transition records intent only: provider work
 * remains impossible until a later admission consumes the opaque receipt.
 */
export async function activateAnalyzeRunAmbiguousRearm(
  repoKey: string,
  certification: AnalyzeRunAmbiguousRearmActivationCertification,
): Promise<ActivateAnalyzeRunAmbiguousRearmResult> {
  const command = inspectAnalyzeRunAmbiguousRearmActivationCertification(certification);
  if (!command) {
    throw new InvalidAnalyzeRunTransitionError('Analyze ambiguous rearm activation is not certified');
  }
  const storage = activeStorage;
  const durableRepoKey = activationScopeKey(repoKey, storage);
  const runId = validateRunId(command.runId);
  const current = await storage.read(durableRepoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  const latest = await storage.inspectLatest(durableRepoKey);
  assertAnalyzeRunStorage(storage);
  const requestedActivatedAt = canonicalTimestamp(command.activatedAt, 'activatedAt');
  const recoveryRecord = current.rearmHistory.at(-1);
  const recoveringDurableActivation = current.status.state === 'running'
    && current.plan.state === 'sealed'
    && current.finalizationIntent === null
    && current.revision === command.observed.runRevision + 1
    && current.executionAttempt.resume?.activation === 'ambiguous-rearm'
    && current.executionAttempt.resume.admission === 'activated'
    && current.executionAttempt.activatedAt === requestedActivatedAt
    && recoveryRecord?.acceptedAt === requestedActivatedAt
    && isDeepStrictEqual(recoveryRecord.evidence, command.consent.evidence)
    && recoveryRecord.acceptedRisk === command.consent.acceptedRisk
    && recoveryRecord.acceptedMaxRepeatProviderCalls
      === command.consent.acceptedMaxRepeatProviderCalls;
  if (
    latest?.runId !== current.runId
    || latest.attemptSequence !== current.attemptSequence
    || (!recoveringDurableActivation && command.observed.runRevision !== current.revision)
    || command.observed.attemptSequence !== current.attemptSequence
    || command.observed.latestAttemptSequence !== latest.attemptSequence
  ) {
    throw new AnalyzeRunLatestAttemptConflictError(runId);
  }
  if (
    current.status.state !== 'running'
    || current.plan.state !== 'sealed'
    || current.finalizationIntent !== null
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot rearm analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }

  const offer = recoveringDurableActivation ? null : toView(current, true).rearm;
  const consentMismatch = recoveringDurableActivation
    ? null
    : inspectAnalyzeRunAmbiguousRearmConsent(offer, command.consent);
  if (consentMismatch !== null) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} ambiguous rearm consent was rejected: ${consentMismatch}`,
    );
  }
  const expectedIdentity = {
    candidateAnalysisId: requireNonEmpty(command.candidateAnalysisId, 'candidateAnalysisId'),
    startedAt: validateTimestamp(command.startedAt, 'startedAt'),
    source: validateSource(command.source),
    branch: validateNullableString(command.branch, 'branch'),
    commitHash: validateNullableString(command.commitHash, 'commitHash'),
    completedBaselineId: validateNullableString(
      command.completedBaselineId,
      'completedBaselineId',
    ),
  };
  if (!isDeepStrictEqual(expectedIdentity, {
    candidateAnalysisId: current.candidateAnalysisId,
    startedAt: current.startedAt,
    source: current.source,
    branch: current.branch,
    commitHash: current.commitHash,
    completedBaselineId: current.completedBaselineId,
  })) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} identity changed before ambiguous rearm activation`,
    );
  }
  if (activationWorkKey(command.work) !== activationWorkKey(current.plan.work)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} sealed work changed before ambiguous rearm activation`,
    );
  }
  const pendingWorkIds = current.plan.work
    .filter((work) => work.state === 'pending')
    .map((work) => work.workId);
  const reusedWorkIds = current.plan.work
    .filter((work) => work.state === 'succeeded-checkpointed')
    .map((work) => work.workId);
  if (
    current.plan.work.some((work) => work.state === 'succeeded-uncheckpointed')
    || !isDeepStrictEqual([...command.pendingWorkIds].sort(), [...pendingWorkIds].sort())
    || !isDeepStrictEqual([...command.reusedWorkIds].sort(), [...reusedWorkIds].sort())
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} work partition changed before ambiguous rearm activation `
      + `(pending=${pendingWorkIds.join(',')}; reused=${reusedWorkIds.join(',')})`,
    );
  }
  const executionPin = normalizeResumeExecutionPin(command.executionPin);
  const executionPinBase = normalizeExecutionIntent(executionPin);
  if (
    current.plan.execution === null
    || !isDeepStrictEqual(current.plan.execution, executionPinBase)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} sealed execution changed before ambiguous rearm activation`,
    );
  }
  validateAmbiguousRearmModelPin(
    current.plan.work,
    current.plan.execution,
    current.executionAttempt,
    executionPin,
    runId,
  );
  if (
    recoveringDurableActivation
    && (
      !isDeepStrictEqual(current.executionAttempt.resume?.executionPin, executionPin)
      || !isDeepStrictEqual(recoveryRecord?.executionPin, executionPin)
      || current.executionAttempt.number
        !== command.consent.evidence.executionEpoch.attemptNumber + 1
    )
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} durable ambiguous rearm recovery changed`,
    );
  }

  const analysisStore = getAnalysisStore();
  const baselineFingerprint = await readActiveCompletedBaselineFingerprint(
    analysisStore,
    durableRepoKey,
    current.completedBaselineId,
  );
  if (
    getAnalysisStore() !== analysisStore
    || baselineFingerprint !== command.observed.completedBaselineFingerprint
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} completed baseline changed before ambiguous rearm activation`,
    );
  }
  const activatedAt = recoveringDurableActivation
    ? current.executionAttempt.activatedAt
    : requestedActivatedAt;
  if (
    recoveringDurableActivation
      ? current.updatedAt !== activatedAt
      : Date.parse(activatedAt) < Date.parse(current.updatedAt)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} ambiguous rearm activation predates durable progress`,
    );
  }
  const sourceResume = current.executionAttempt.resume;
  const next: StoredAnalyzeRun = recoveringDurableActivation ? current : {
    ...current,
    schemaVersion: SCHEMA_VERSION,
    revision: current.revision + 1,
    updatedAt: activatedAt,
    executionAttempt: {
      number: current.executionAttempt.number + 1,
      activatedAt,
      initialAdmission: null,
      resume: {
        activation: 'ambiguous-rearm',
        admission: 'activated',
        admittedAt: null,
        resumedFrom: sourceResume?.resumedFrom ?? null,
        executionPin,
      },
    },
    rearmHistory: [
      ...current.rearmHistory,
      {
        evidence: structuredClone(command.consent.evidence),
        acceptedAt: activatedAt,
        acceptedRisk: command.consent.acceptedRisk,
        acceptedMaxRepeatProviderCalls: command.consent.acceptedMaxRepeatProviderCalls,
        executionPin,
      },
    ],
  };

  const baselineFingerprintBeforeCas = await readActiveCompletedBaselineFingerprint(
    analysisStore,
    durableRepoKey,
    current.completedBaselineId,
  );
  if (
    activeStorage !== storage
    || getAnalysisStore() !== analysisStore
    || baselineFingerprintBeforeCas !== baselineFingerprint
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} storage or completed baseline changed before ambiguous rearm activation`,
    );
  }
  if (recoveringDurableActivation) {
    const currentBeforeReceipt = await storage.read(durableRepoKey, runId);
    assertAnalyzeRunStorage(storage);
    const latestBeforeReceipt = await storage.inspectLatest(durableRepoKey);
    assertAnalyzeRunStorage(storage);
    if (
      !currentBeforeReceipt
      || !isDeepStrictEqual(currentBeforeReceipt, current)
      || latestBeforeReceipt?.runId !== runId
      || latestBeforeReceipt.attemptSequence !== current.attemptSequence
    ) {
      throw new AnalyzeRunLatestAttemptConflictError(runId);
    }
  } else {
    await storage.compareAndSwapLatest(
      durableRepoKey,
      runId,
      current.revision,
      current.attemptSequence,
      latest.attemptSequence,
      next,
    );
  }
  assertAnalyzeRunStorage(storage);
  const activatedStored = await storage.read(durableRepoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!activatedStored || !isDeepStrictEqual(activatedStored, next)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} durable state changed during ambiguous rearm activation`,
    );
  }
  const activation = Object.freeze({}) as AnalyzeRunResumePlanActivation;
  analyzeRunResumePlanActivations.set(activation, {
    storage,
    repoKey: durableRepoKey,
    runId,
    revision: next.revision,
    workKey: activationWorkKey(current.plan.work),
    execution: current.plan.execution,
    pendingWorkIds: Object.freeze([...pendingWorkIds]),
    reusedWorkIds: Object.freeze([...reusedWorkIds]),
    executionPin,
    attemptSequence: next.attemptSequence,
    mode: 'ambiguous-activated',
    claimed: false,
  });
  return Object.freeze({ view: toView(next, true), activation });
}

function normalizeResumeExecutionPin(value: Readonly<AnalyzeRunResumeExecutionPin>): AnalyzeRunResumeExecutionPin {
  const base = normalizeExecutionIntent(value);
  if (value.modelSelection === 'requested' && value.resolvedModel === null) {
    return { ...base, modelSelection: 'requested', resolvedModel: null };
  }
  if (value.modelSelection === 'resolved') {
    const resolvedModel = requireNonEmpty(value.resolvedModel, 'executionPin.resolvedModel');
    if (resolvedModel.trim() !== resolvedModel) {
      throw new InvalidAnalyzeRunTransitionError(
        'Resume execution pin contains surrounding whitespace',
      );
    }
    return { ...base, modelSelection: 'resolved', resolvedModel };
  }
  throw new InvalidAnalyzeRunTransitionError('Invalid resume model selection');
}

function validateAmbiguousRearmModelPin(
  work: readonly StoredAnalyzeRunWork[],
  execution: AnalyzeRunExecutionIntent,
  sourceAttempt: AnalyzeRunExecutionAttempt,
  pin: AnalyzeRunResumeExecutionPin,
  runId: string,
): void {
  const checkpointed = work.filter(
    (item): item is Extract<StoredAnalyzeRunWork, { state: 'succeeded-checkpointed' }> =>
      item.state === 'succeeded-checkpointed',
  );
  const checkpointUsage = checkpointed
    .map((item) => item.checkpoint.usage)
    .filter((usage): usage is AnalyzeLlmExecutionUsage => usage !== null);
  if (checkpointed.length > 0) {
    const resolvedModels = new Set(checkpointUsage.map((usage) => usage.resolvedModel));
    if (
      checkpointUsage.length !== checkpointed.length
      || checkpointUsage.some((usage) =>
        usage.provider !== execution.provider
        || usage.requestedModel !== execution.requestedModel
        || usage.resolvedModel === null)
      || resolvedModels.size !== 1
      || pin.modelSelection !== 'resolved'
      || pin.resolvedModel !== checkpointUsage[0]!.resolvedModel
    ) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} checkpoint model cannot certify ambiguous rearm`,
      );
    }
    return;
  }
  if (sourceAttempt.number > 1) {
    const durablePin = sourceAttempt.resume?.executionPin;
    if (
      durablePin === undefined
      || !isDeepStrictEqual(pin, durablePin)
      || (
        durablePin.modelSelection === 'requested'
        && execution.requestedModel === null
      )
    ) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} checkpoint model is unverified for ambiguous rearm`,
      );
    }
    return;
  }
  if (
    execution.requestedModel === null
    || pin.modelSelection !== 'requested'
    || pin.resolvedModel !== null
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} checkpoint model is unverified for ambiguous rearm`,
    );
  }
}

/**
 * Durably admit one activated resume attempt before synchronously starting only
 * its pending provider work. The execution profile is revalidated on both sides
 * of the admission CAS so a changed provider/model can never receive a call.
 */
export async function admitAnalyzeRunResumeExecution<T>(
  receipt: AnalyzeRunResumePlanActivation,
  repoKey: string,
  runId: string,
  work: readonly { readonly workId: string; readonly inputFingerprint: string }[],
  pendingWorkIds: readonly string[],
  executionPin: Readonly<AnalyzeRunResumeExecutionPin>,
  admittedAt: string,
  validate: () => void,
  admit: (checkpointWriter: AnalyzeRunCheckpointWriter) => Promise<T>,
): Promise<AnalyzeRunResumeAdmission<T>> {
  if ((typeof receipt !== 'object' && typeof receipt !== 'function') || receipt === null) {
    return { admitted: false };
  }
  const activation = analyzeRunResumePlanActivations.get(receipt);
  if (!activation) return { admitted: false };
  const storage = activeStorage;
  const ownershipMatches = activation.storage === storage
    && activation.repoKey === activationScopeKey(repoKey, storage)
    && activation.runId === runId
    && activation.workKey === activationWorkKey(work)
    && isDeepStrictEqual(activation.executionPin, executionPin)
    && isDeepStrictEqual([...activation.pendingWorkIds].sort(), [...pendingWorkIds].sort());
  if (!ownershipMatches) return { admitted: false };

  const stored = await storage.read(activation.repoKey, activation.runId);
  assertAnalyzeRunStorage(storage);
  const durablePending = stored?.plan.state === 'sealed'
    ? stored.plan.work.filter((item) => item.state === 'pending').map((item) => item.workId)
    : [];
  const durableReused = stored?.plan.state === 'sealed'
    ? stored.plan.work
        .filter((item) => item.state === 'succeeded-checkpointed')
        .map((item) => item.workId)
    : [];
  const activatedResumeKind = activation.mode === 'activated'
    ? 'provider-session-limit'
    : activation.mode === 'ambiguous-activated'
      ? 'ambiguous-rearm'
      : null;
  const completedExecutionKind = activation.mode === 'executing-complete-provider-session-limit'
    ? 'provider-session-limit'
    : activation.mode === 'executing-complete-ambiguous-rearm'
      ? 'ambiguous-rearm'
      : null;
  const activatedIsExecutable = activatedResumeKind !== null
    && stored?.status.state === 'running'
    && stored.plan.state === 'sealed'
    && stored.revision === activation.revision
    && stored.attemptSequence === activation.attemptSequence
    && stored.executionAttempt.resume?.activation === activatedResumeKind
    && stored.executionAttempt.resume?.admission === 'activated'
    && isDeepStrictEqual(stored.executionAttempt.resume.executionPin, activation.executionPin)
    && isDeepStrictEqual(stored.plan.execution, activation.execution)
    && activation.workKey === activationWorkKey(stored.plan.work)
    && isDeepStrictEqual([...activation.pendingWorkIds].sort(), [...durablePending].sort())
    && isDeepStrictEqual([...activation.reusedWorkIds].sort(), [...durableReused].sort());
  const completedExecutionIsRecoverable = completedExecutionKind !== null
    && stored?.status.state === 'running'
    && stored.plan.state === 'sealed'
    && stored.revision === activation.revision
    && stored.attemptSequence === activation.attemptSequence
    && stored.executionAttempt.resume?.activation === completedExecutionKind
    && stored.executionAttempt.resume?.admission === 'executing'
    && isDeepStrictEqual(stored.executionAttempt.resume.executionPin, activation.executionPin)
    && isDeepStrictEqual(stored.plan.execution, activation.execution)
    && activation.workKey === activationWorkKey(stored.plan.work)
    && durablePending.length === 0
    && activation.pendingWorkIds.length === 0
    && isDeepStrictEqual([...activation.reusedWorkIds].sort(), [...durableReused].sort());
  const stillExecutable = activatedIsExecutable || completedExecutionIsRecoverable;
  if (!stillExecutable || !stored || stored.plan.state !== 'sealed') return { admitted: false };
  const durableResume = stored.executionAttempt.resume;
  if (!durableResume || analyzeRunResumePlanActivations.get(receipt) !== activation) {
    return { admitted: false };
  }
  if (activation.claimed) return { admitted: false };

  validate();
  let executing = stored;
  if (activatedResumeKind !== null) {
    const canonicalAdmittedAt = canonicalTimestamp(admittedAt, 'admittedAt');
    if (Date.parse(canonicalAdmittedAt) < Date.parse(stored.updatedAt)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} execution admission cannot precede its activation`,
      );
    }
    executing = {
      ...stored,
      revision: stored.revision + 1,
      updatedAt: canonicalAdmittedAt,
      executionAttempt: {
        ...stored.executionAttempt,
        resume: {
          ...durableResume,
          admission: 'executing',
          admittedAt: canonicalAdmittedAt,
        },
      },
    };
  }
  activation.claimed = true;
  let checkpointBinding: {
    storage: AnalyzeRunStorage;
    repoKey: string;
    runId: string;
    workKey: string;
    execution: AnalyzeRunExecutionIntent;
    sealedAt: string;
    active: boolean;
  } | undefined;
  try {
    if (activatedResumeKind !== null) {
      await storage.compareAndSwapLatest(
        activation.repoKey,
        activation.runId,
        stored.revision,
        activation.attemptSequence,
        activation.attemptSequence,
        executing,
      );
      assertAnalyzeRunStorage(storage);
    }
    const durablyExecuting = await storage.read(activation.repoKey, activation.runId);
    assertAnalyzeRunStorage(storage);
    if (!durablyExecuting || !isDeepStrictEqual(durablyExecuting, executing)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${activation.runId} sealed execution changed during resume admission`,
      );
    }
    validate();
    const checkpointWriter = Object.freeze({}) as AnalyzeRunCheckpointWriter;
    checkpointBinding = {
      storage,
      repoKey: activation.repoKey,
      runId: activation.runId,
      workKey: activation.workKey,
      execution: activation.execution,
      sealedAt: durablyExecuting.plan.state === 'sealed'
        ? durablyExecuting.plan.sealedAt
        : stored.plan.sealedAt,
      active: true,
    };
    analyzeRunCheckpointWriters.set(checkpointWriter, checkpointBinding);
    analyzeRunResumePlanActivations.delete(receipt);
    const admittedExecution = admit(checkpointWriter);
    const execution = admittedExecution.then(async (result) => {
      checkpointBinding!.active = false;
      const completed = await storage.read(activation.repoKey, activation.runId);
      assertAnalyzeRunStorage(storage);
      if (
        !completed
        || completed.status.state !== 'running'
        || completed.plan.state !== 'sealed'
        || !isDeepStrictEqual(completed.plan.execution, activation.execution)
        || completed.plan.work.some((item) => item.state !== 'succeeded-checkpointed')
        || activation.workKey !== activationWorkKey(completed.plan.work)
      ) {
        throw new InvalidAnalyzeRunTransitionError(
          `Analyze run ${activation.runId} did not durably checkpoint every resumed result`,
        );
      }
      const certification = issueAnalyzeRunExecutionCertification({
        storage,
        scopeKey: activationScopeKey(repoKey, storage),
        runId: activation.runId,
        revision: completed.revision,
        workKey: activation.workKey,
        execution: activation.execution,
      });
      return Object.freeze({
        result,
        certification,
        checkpoints: completedCheckpointEvidence(completed.plan.work),
      });
    }, (error) => {
      checkpointBinding!.active = false;
      throw error;
    });
    return { admitted: true, execution };
  } catch (error) {
    if (checkpointBinding) checkpointBinding.active = false;
    const current = await storage.read(activation.repoKey, activation.runId);
    assertAnalyzeRunStorage(storage);
    if (current?.revision === activation.revision) {
      activation.claimed = false;
    } else {
      analyzeRunResumePlanActivations.delete(receipt);
    }
    throw error;
  }
}

function completedCheckpointEvidence(
  work: readonly StoredAnalyzeRunWork[],
): readonly AnalyzeRunCheckpointEvidence[] {
  return Object.freeze(work.map((item) => {
    if (item.state !== 'succeeded-checkpointed') {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze work ${item.workId} has no durable completion checkpoint`,
      );
    }
    return Object.freeze({
      workId: item.workId,
      inputFingerprint: item.inputFingerprint,
      checkpointedAt: item.checkpoint.checkpointedAt,
      attemptId: item.checkpoint.attemptId,
      usage: item.checkpoint.usage === null
        ? null
        : Object.freeze({ ...item.checkpoint.usage }),
    });
  }));
}

async function readActiveCompletedBaselineFingerprint(
  store: ReturnType<typeof getAnalysisStore>,
  repoKey: string,
  expectedBaselineId: string | null,
): Promise<string | null> {
  const latest = await store.readLatest(repoKey);
  if (latest === null) {
    if (expectedBaselineId !== null) {
      throw new InvalidAnalyzeRunTransitionError('Completed baseline disappeared before resume');
    }
    return null;
  }
  let baselineId: string;
  try {
    baselineId = activeCompletedBaselineId(latest);
  } catch {
    throw new InvalidAnalyzeRunTransitionError('Completed baseline is invalid before resume');
  }
  if (baselineId !== expectedBaselineId) {
    throw new InvalidAnalyzeRunTransitionError('Completed baseline changed before resume');
  }
  return fingerprint(latest);
}

export async function readAnalyzeRun(
  repoKey: string,
  selector: 'latest-attempt' | { runId: string },
): Promise<AnalyzeRunView | null> {
  const stored = selector === 'latest-attempt'
    ? await activeStorage.readLatest(repoKey)
    : await activeStorage.read(repoKey, validateRunId(selector.runId));
  return stored ? toView(stored, selector === 'latest-attempt') : null;
}

/** Inspect the newest durable attempt without repairing or rewriting its pointer. */
export async function inspectLatestAnalyzeRun(repoKey: string): Promise<AnalyzeRunView | null> {
  const stored = await activeStorage.inspectLatest(repoKey);
  return stored ? toView(stored, true) : null;
}

/** Persist one schema-validated provider success before the run may become terminal. */
export async function checkpointAnalyzeRunWork(
  certification: AnalyzeRunWorkCheckpointCertification,
): Promise<AnalyzeRunView> {
  const certified = inspectAnalyzeRunWorkCheckpointCertification(certification);
  if (!certified) {
    throw new InvalidAnalyzeRunTransitionError('Analyze work checkpoint is not certified');
  }
  const { writer, command } = certified;
  const binding = analyzeRunCheckpointWriters.get(writer);
  if (!binding || !binding.active || binding.storage !== activeStorage) {
    throw new InvalidAnalyzeRunTransitionError('Analyze checkpoint writer is invalid or inactive');
  }
  const { storage, repoKey, runId } = binding;
  const workId = requireNonEmpty(command.workId, 'workId');
  const inputFingerprint = validateFingerprint(command.inputFingerprint);
  const validatedCheckpoint = validateWorkCheckpoint(command);
  const checkpoint = validatedCheckpoint;

  for (;;) {
    const current = await storage.read(repoKey, runId);
    assertAnalyzeRunStorage(storage);
    if (!current) throw new AnalyzeRunNotFoundError(runId);
    if (current.status.state !== 'running' || current.plan.state !== 'sealed') {
      throw new InvalidAnalyzeRunTransitionError(
        `Cannot checkpoint analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
      );
    }
    if (
      current.executionAttempt.number === 1
      && current.executionAttempt.initialAdmission?.admission !== 'executing'
    ) {
      throw new InvalidAnalyzeRunTransitionError(
        `Cannot checkpoint analyze run ${runId} before initial execution is durably admitted`,
      );
    }
    if (
      current.executionAttempt.number > 1
      && current.executionAttempt.resume?.admission !== 'executing'
    ) {
      throw new InvalidAnalyzeRunTransitionError(
        `Cannot checkpoint analyze run ${runId} before resumed execution is durably admitted`,
      );
    }
    if (Date.parse(checkpoint.checkpointedAt) < Date.parse(current.executionAttempt.activatedAt)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} checkpoint cannot precede its execution attempt`,
      );
    }
    if (
      current.executionAttempt.number === 1
      && current.executionAttempt.initialAdmission?.admission === 'executing'
      && current.executionAttempt.initialAdmission.admittedAt !== null
      && Date.parse(checkpoint.checkpointedAt)
        < Date.parse(current.executionAttempt.initialAdmission.admittedAt)
    ) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} checkpoint cannot precede initial execution admission`,
      );
    }
    if (
      current.executionAttempt.number > 1
      && Date.parse(checkpoint.checkpointedAt)
        < Date.parse(current.executionAttempt.resume!.admittedAt!)
    ) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} checkpoint cannot precede resumed execution admission`,
      );
    }
    if (binding.workKey !== activationWorkKey(current.plan.work)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId}'s sealed plan changed after checkpoint admission`,
      );
    }
    if (!isDeepStrictEqual(binding.execution, current.plan.execution)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId}'s sealed execution changed after checkpoint admission`,
      );
    }
    if (Date.parse(checkpoint.checkpointedAt) < Date.parse(current.plan.sealedAt)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} checkpoint cannot precede its sealed plan`,
      );
    }
    const index = current.plan.work.findIndex((item) => item.workId === workId);
    const existing = current.plan.work[index];
    if (!existing || existing.inputFingerprint !== inputFingerprint) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze work ${workId} does not match run ${runId}'s sealed plan`,
      );
    }
    if (existing.state === 'succeeded-checkpointed') {
      if (isDeepStrictEqual(existing.checkpoint, checkpoint)) return toView(current);
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze work ${workId} already has different checkpoint evidence`,
      );
    }
    if (existing.state !== 'pending') {
      throw new InvalidAnalyzeRunTransitionError(`Analyze work ${workId} is not checkpointable`);
    }
    const work = [...current.plan.work];
    work[index] = { workId, inputFingerprint, state: 'succeeded-checkpointed', checkpoint };
    const updatedAt = new Date(Math.max(
      Date.parse(current.updatedAt),
      Date.parse(checkpoint.checkpointedAt),
    )).toISOString();
    const next: StoredAnalyzeRun = {
      ...current,
      revision: current.revision + 1,
      updatedAt,
      plan: { ...current.plan, work },
    };
    try {
      await storage.compareAndSwap(repoKey, runId, current.revision, next);
      assertAnalyzeRunStorage(storage);
      return toView(next);
    } catch (error) {
      if (error instanceof AnalyzeRunRevisionConflictError) continue;
      throw error;
    }
  }
}

function toView(run: StoredAnalyzeRun, isLatestAttempt = false): AnalyzeRunView {
  const counts = run.plan.state === 'sealed'
    ? {
        total: run.plan.work.length,
        pending: run.plan.work.filter((work) => work.state === 'pending').length,
        running: 0,
        succeeded: run.plan.work.filter((work) => work.state !== 'pending').length,
        failed: 0,
      }
    : null;
  const hasSafeSealedPlan = run.plan.state === 'sealed'
    && run.plan.execution !== null
    && !run.plan.work.some((work) => work.state === 'succeeded-uncheckpointed');
  const recoveringActivated = run.status.state === 'running'
    && run.executionAttempt.number > 1
    && run.executionAttempt.resume?.activation === 'provider-session-limit'
    && run.executionAttempt.resume?.admission === 'activated'
    && hasSafeSealedPlan;
  const recoveringCompletedExecution = run.status.state === 'running'
    && run.executionAttempt.number > 1
    && run.executionAttempt.resume?.activation === 'provider-session-limit'
    && run.executionAttempt.resume?.admission === 'executing'
    && run.plan.state === 'sealed'
    && run.plan.execution !== null
    && !run.plan.work.some((work) => work.state === 'succeeded-uncheckpointed')
    && run.plan.work.every((work) => work.state === 'succeeded-checkpointed');
  const recoveringPreparedFinalization = run.status.state === 'finalizing'
    && run.finalizationIntent !== null;
  const canAttemptResume = (
    (run.status.state === 'blocked' && hasSafeSealedPlan)
    || recoveringActivated
    || recoveringCompletedExecution
    || recoveringPreparedFinalization
  );
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
    executionAttempt: structuredClone(run.executionAttempt),
    plan: run.plan.state,
    counts,
    blocked: run.status.state === 'blocked'
      ? {
          reason: run.status.reason,
          resetHint: run.status.resetHint,
          blockedAt: run.status.blockedAt,
        }
      : null,
    lastProviderLimit: run.status.state === 'blocked'
      ? {
          reason: run.status.reason,
          resetHint: run.status.resetHint,
          blockedAt: run.status.blockedAt,
          resetAt: certifyClaudeSessionResetAt(run.status.resetHint, run.status.blockedAt),
        }
      : run.executionAttempt.resume?.resumedFrom == null
        ? null
        : {
            ...structuredClone(run.executionAttempt.resume.resumedFrom),
            resetAt: certifyClaudeSessionResetAt(
              run.executionAttempt.resume.resumedFrom.resetHint,
              run.executionAttempt.resume.resumedFrom.blockedAt,
            ),
          },
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
    resume: canAttemptResume
      ? {
          available: true,
          scope: 'structural',
          mode: 'resume',
          requiresLatestAttempt: true,
          requiresRevalidation: true,
        }
      : {
          available: false,
          scope: 'structural',
          reason: resumeUnavailableReason(run),
        },
    rearm: buildAnalyzeRunAmbiguousRearmOffer({
      isLatestAttempt,
      admissionEvidence: (sourceAnalyzeRunSchemaVersions.get(run) ?? SCHEMA_VERSION)
          >= INITIAL_ADMISSION_SCHEMA_VERSION
        ? 'explicit-admission-schema'
        : 'legacy-schema',
      runId: run.runId,
      runRevision: run.revision,
      state: run.status.state,
      finalizationPresent: run.finalizationIntent !== null,
      executionEpoch: ambiguousRearmExecutionEpoch(run.executionAttempt),
      plan: run.plan.state === 'unsealed'
        ? { state: 'unsealed' }
        : {
            state: 'sealed',
            executionBound: run.plan.execution !== null,
            workStates: run.plan.work.map((work) => work.state),
          },
    }),
  };
}

function ambiguousRearmExecutionEpoch(
  attempt: AnalyzeRunExecutionAttempt,
): AnalyzeRunAmbiguousRearmExecutionEpochState {
  if (attempt.number === 1) {
    return {
      kind: 'initial',
      attemptNumber: attempt.number,
      activatedAt: attempt.activatedAt,
      admission: attempt.initialAdmission?.admission ?? 'ambiguous',
      admittedAt: attempt.initialAdmission?.admittedAt ?? null,
      evidence: attempt.initialAdmission?.evidence ?? 'legacy-ambiguous',
    };
  }
  return {
    kind: 'resume',
    attemptNumber: attempt.number,
    activatedAt: attempt.activatedAt,
    admission: attempt.resume?.admission ?? 'activated',
    admittedAt: attempt.resume?.admittedAt ?? null,
  };
}

function resumeUnavailableReason(run: StoredAnalyzeRun): AnalyzeRunResumeUnavailableReason {
  if (run.status.state === 'completed') return 'run-completed';
  if (run.status.state === 'failed') return 'run-failed';
  if (run.status.state === 'finalizing') return 'finalization-unprepared';
  if (
    run.status.state === 'running'
    && (
      run.executionAttempt.resume?.admission === 'executing'
      || (
        run.executionAttempt.number === 1
        && (
          run.executionAttempt.initialAdmission?.admission === 'executing'
          || run.executionAttempt.initialAdmission?.admission === 'ambiguous'
        )
      )
    )
    && run.plan.state === 'sealed'
    && run.plan.work.some((work) => work.state !== 'succeeded-checkpointed')
  ) {
    return 'resume-execution-ambiguous';
  }
  if (run.plan.state === 'sealed' && run.plan.execution === null) {
    return 'checkpoint-execution-unbound';
  }
  if (
    run.plan.state === 'sealed'
    && run.plan.work.some((work) => work.state === 'succeeded-uncheckpointed')
  ) {
    return 'successful-results-not-checkpointed';
  }
  return 'run-not-resumable';
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
    isDeepStrictEqual(certified.execution, current.plan.execution) &&
    current.plan.work.every((item) => item.state !== 'pending')
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
    certified.workKey !== activationWorkKey(current.plan.work) ||
    !isDeepStrictEqual(certified.execution, current.plan.execution) ||
    current.plan.work.some((item) => item.state !== 'succeeded-checkpointed')
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze execution completion does not certify run ${runId}'s current sealed plan`,
    );
  }
  if (
    Date.parse(finalizingAt) < Date.parse(current.plan.sealedAt)
    || Date.parse(finalizingAt) < Date.parse(current.updatedAt)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} finalization cannot precede its latest durable progress`,
    );
  }
  const next: StoredAnalyzeRun = {
    ...current,
    revision: current.revision + 1,
    updatedAt: finalizingAt,
    status: { state: 'finalizing', finalizingAt },
    finalizationIntent: null,
    plan: current.plan,
  };
  certified.claimed = true;
  try {
    await storage.compareAndSwap(repoKey, runId, current.revision, next);
    assertAnalyzeRunStorage(storage);
    const durablyFinalizing = await storage.read(repoKey, runId);
    assertAnalyzeRunStorage(storage);
    if (!durablyFinalizing || !isDeepStrictEqual(durablyFinalizing, next)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} sealed execution changed during finalization`,
      );
    }
    return toView(durablyFinalizing);
  } catch (error) {
    certified.claimed = false;
    throw error;
  }
}

/**
 * Atomically bind certified execution completion and its exact recovery input.
 * The durable revision advances by two logical lifecycle steps in one CAS so a
 * process cannot expose a finalizing run without the intent needed to recover it.
 */
export async function beginPreparedAnalyzeRunFinalization(
  repoKey: string,
  command: BeginPreparedAnalyzeRunFinalizationCommand,
  completion: AnalyzeRunExecutionCompletion,
): Promise<AnalyzeRunView> {
  if (
    (typeof completion !== 'object' && typeof completion !== 'function')
    || completion === null
  ) {
    throw new InvalidAnalyzeRunTransitionError('Invalid analyze execution completion receipt');
  }
  const certified = inspectAnalyzeRunExecutionCompletion(completion);
  if (!certified) {
    throw new InvalidAnalyzeRunTransitionError('Invalid analyze execution completion receipt');
  }
  const storage = activeStorage;
  const detached = detachExactJson(command, 'Analyze finalization intent');
  const runId = validateRunId(detached.runId);
  if (
    certified.storage !== storage
    || certified.scopeKey !== activationScopeKey(repoKey, storage)
    || certified.runId !== runId
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze execution completion does not belong to run ${runId}`,
    );
  }
  const current = await storage.read(repoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!current) throw new AnalyzeRunNotFoundError(runId);

  const finalizingAt = validateTimestamp(detached.finalizingAt, 'finalizingAt');
  const preparedAt = validateTimestamp(detached.preparedAt, 'preparedAt');
  const storedIntent = buildStoredFinalizationIntent(
    current,
    detached,
    finalizingAt,
  );
  const retryMatches = (
    current.status.state === 'finalizing'
    && current.plan.state === 'sealed'
    && current.revision === certified.revision + 2
    && current.status.finalizingAt === finalizingAt
    && isDeepStrictEqual(current.finalizationIntent, storedIntent)
    && certified.workKey === activationWorkKey(current.plan.work)
    && isDeepStrictEqual(certified.execution, current.plan.execution)
    && current.plan.work.every((item) => item.state !== 'pending')
  );
  if (retryMatches) {
    certified.claimed = true;
    return toView(current);
  }
  if (current.status.state !== 'running' || current.plan.state !== 'sealed') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot prepare finalization for analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }
  if (
    certified.claimed
    || certified.revision !== current.revision
    || certified.workKey !== activationWorkKey(current.plan.work)
    || !isDeepStrictEqual(certified.execution, current.plan.execution)
    || current.plan.work.some((item) => item.state !== 'succeeded-checkpointed')
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze execution completion does not certify run ${runId}'s current sealed plan`,
    );
  }
  if (
    Date.parse(finalizingAt) < Date.parse(current.plan.sealedAt)
    || Date.parse(finalizingAt) < Date.parse(current.updatedAt)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} finalization cannot precede its latest durable progress`,
    );
  }
  if (Date.parse(preparedAt) < Date.parse(finalizingAt)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} finalization preparation cannot precede finalizing`,
    );
  }

  const next: StoredAnalyzeRun = {
    ...current,
    schemaVersion: SCHEMA_VERSION,
    revision: current.revision + 2,
    updatedAt: preparedAt,
    status: { state: 'finalizing', finalizingAt },
    finalizationIntent: storedIntent,
    plan: current.plan,
  };
  certified.claimed = true;
  try {
    await storage.compareAndSwap(repoKey, runId, current.revision, next);
    assertAnalyzeRunStorage(storage);
    const durablyPrepared = await storage.read(repoKey, runId);
    assertAnalyzeRunStorage(storage);
    if (!durablyPrepared || !isDeepStrictEqual(durablyPrepared, next)) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${runId} sealed execution changed during finalization`,
      );
    }
    return toView(durablyPrepared);
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
  const detachedCommand = detachExactJson(command, 'Analyze finalization intent');
  const runId = validateRunId(detachedCommand.runId);
  const preparedAt = validateTimestamp(detachedCommand.preparedAt, 'preparedAt');
  const current = await storage.read(repoKey, runId);
  assertAnalyzeRunStorage(storage);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  if (current.status.state !== 'finalizing' || current.plan.state !== 'sealed') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot prepare finalization for analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }

  const storedIntent = buildStoredFinalizationIntent(
    current,
    detachedCommand,
    current.status.finalizingAt,
  );
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

function detachExactJson<T>(value: T, label: string): T {
  let persisted: unknown;
  try {
    persisted = JSON.parse(JSON.stringify(value));
  } catch {
    throw new InvalidAnalyzeRunTransitionError(
      `${label} must be exactly JSON-round-trippable`,
    );
  }
  if (!isDeepStrictEqual(persisted, value)) {
    throw new InvalidAnalyzeRunTransitionError(
      `${label} must be exactly JSON-round-trippable`,
    );
  }
  return persisted as T;
}

function buildStoredFinalizationIntent(
  current: StoredAnalyzeRun,
  command: PrepareAnalyzeRunFinalizationCommand,
  finalizingAt: string,
): StoredAnalyzeRunFinalizationIntent {
  const preparedAt = validateTimestamp(command.preparedAt, 'preparedAt');
  const filename = buildAnalysisFilename(
    command.promotion.snapshot.id,
    command.promotion.snapshot.createdAt,
  );
  validateCompletedAnalysisPromotion(command.promotion, filename);
  validateCompletedAnalysisProjectionIntent(command.projection);
  const expectedBaselineId = command.promotion.expectedBaseline?.analysis.id ?? null;
  if (
    command.promotion.snapshot.id !== current.candidateAnalysisId
    || expectedBaselineId !== current.completedBaselineId
    || command.promotion.snapshot.branch !== current.branch
    || command.promotion.snapshot.commitHash !== current.commitHash
    || !isDeepStrictEqual(command.projection.promotedSnapshot, command.promotion.snapshot)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze finalization intent does not match run ${current.runId}`,
    );
  }
  if (Date.parse(preparedAt) < Date.parse(finalizingAt)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${current.runId} finalization preparation cannot precede finalizing`,
    );
  }
  return {
    preparedAt,
    promotion: command.promotion,
    projection: {
      projectSlug: command.projection.projectSlug,
      historyEntry: command.projection.historyEntry,
    },
  };
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
  if (current.executionAttempt.resume?.admission === 'activated') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot fail analyze run ${runId} before resumed execution is durably admitted`,
    );
  }
  if (!isRecord(command.error)) {
    throw new InvalidAnalyzeRunTransitionError(`Analyze run ${runId} has an invalid public error`);
  }

  const failedAt = validateTimestamp(command.failedAt, 'failedAt');
  if (
    Date.parse(failedAt) < Date.parse(current.startedAt) ||
    Date.parse(failedAt) < Date.parse(current.updatedAt) ||
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
      `Analyze run ${runId} failure cannot precede its latest durable progress`,
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
  if (current.executionAttempt.resume?.admission === 'activated') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot block analyze run ${runId} before resumed execution is durably admitted`,
    );
  }
  if (
    current.executionAttempt.number === 1
    && current.executionAttempt.initialAdmission?.admission !== 'executing'
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot block analyze run ${runId} before initial execution is durably admitted`,
    );
  }

  const blockedAt = validateTimestamp(command.blockedAt, 'blockedAt');
  if (
    Date.parse(blockedAt) < Date.parse(current.startedAt) ||
    Date.parse(blockedAt) < Date.parse(current.plan.sealedAt) ||
    Date.parse(blockedAt) < Date.parse(current.updatedAt)
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} block cannot precede its latest durable progress`,
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
  const execution = normalizeSealPlanExecution(command.execution);

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
      execution,
      work,
    },
  };
  await storage.compareAndSwap(repoKey, runId, current.revision, next);
  assertAnalyzeRunStorage(storage);
  return toView(next);
}

function normalizeSealPlanExecution(execution: unknown): AnalyzeRunExecutionIntent {
  return normalizeExecutionIntent(execution);
}

function normalizeExecutionIntent(execution: unknown): AnalyzeRunExecutionIntent {
  try {
    return { ...validateLlmWorkExecutionIntent(execution) };
  } catch {
    throw new InvalidAnalyzeRunTransitionError('Analyze run has an invalid LLM execution intent');
  }
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

function canonicalTimestamp(value: unknown, field: string): string {
  return new Date(Date.parse(validateTimestamp(value, field))).toISOString();
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
      || !isSupportedSchemaVersion(value.schemaVersion)
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
    !isSupportedSchemaVersion(value.schemaVersion) ||
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
  const schemaVersion = value.schemaVersion as ParsedLatestAttemptPointer['schemaVersion'];
  const plan = parseStoredPlan(value.plan, file, schemaVersion);
  const rearmHistory = schemaVersion === SCHEMA_VERSION
    ? parseStoredAmbiguousRearmHistory(value.rearmHistory, file)
    : [];
  if (
    (
      value.schemaVersion === CHECKPOINT_SCHEMA_VERSION
      || value.schemaVersion === EXECUTION_ATTEMPT_SCHEMA_VERSION
      || value.schemaVersion === RESUME_ADMISSION_SCHEMA_VERSION
      || value.schemaVersion === REQUESTED_MODEL_PIN_SCHEMA_VERSION
      || value.schemaVersion === SEALED_EXECUTION_SCHEMA_VERSION
      || value.schemaVersion === INITIAL_ADMISSION_SCHEMA_VERSION
      || value.schemaVersion === SCHEMA_VERSION
    )
    && !Object.hasOwn(value, 'finalizationIntent')
  ) {
    throw new AnalyzeRunJournalCorruptError(
      `Schema-v${value.schemaVersion} run is missing finalization intent state: ${file}`,
    );
  }
  const finalizationIntent = value.schemaVersion === LEGACY_SCHEMA_VERSION
    ? (() => {
        if (value.finalizationIntent !== undefined && value.finalizationIntent !== null) {
          throw new AnalyzeRunJournalCorruptError(`Schema-v1 run contains v2 finalization intent: ${file}`);
        }
        return null;
      })()
    : parseStoredFinalizationIntent(value.finalizationIntent, file);
  const startedAt = validateTimestamp(value.startedAt, 'startedAt');
  const legacyExecutionAttempt = (
    value.schemaVersion === SEALED_EXECUTION_SCHEMA_VERSION
    || value.schemaVersion === REQUESTED_MODEL_PIN_SCHEMA_VERSION
  )
    ? parseStoredSchemaV7ExecutionAttempt(value.executionAttempt, file)
    : value.schemaVersion === RESUME_ADMISSION_SCHEMA_VERSION
      ? parseStoredSchemaV5ExecutionAttempt(value.executionAttempt, file)
    : value.schemaVersion === EXECUTION_ATTEMPT_SCHEMA_VERSION
      ? parseStoredSchemaV4ExecutionAttempt(value.executionAttempt, file)
      : { number: 1, activatedAt: startedAt, initialAdmission: null, resume: null };
  const executionAttempt = value.schemaVersion === SCHEMA_VERSION
    ? parseStoredSchemaV9ExecutionAttempt(value.executionAttempt, file)
    : value.schemaVersion === INITIAL_ADMISSION_SCHEMA_VERSION
      ? parseStoredExecutionAttempt(value.executionAttempt, file)
    : {
        ...legacyExecutionAttempt,
        initialAdmission: inferLegacyInitialAdmission({
          schemaVersion: schemaVersion as Exclude<
            ParsedLatestAttemptPointer['schemaVersion'],
            typeof SCHEMA_VERSION
          >,
          revision,
          status,
          plan,
          executionAttempt: legacyExecutionAttempt,
        }),
      };
  if (Date.parse(executionAttempt.activatedAt) < Date.parse(startedAt)) {
    throw new AnalyzeRunJournalCorruptError(`Analyze execution attempt predates its run: ${file}`);
  }
  if (executionAttempt.number === 1 && executionAttempt.activatedAt !== startedAt) {
    throw new AnalyzeRunJournalCorruptError(
      `Initial analyze execution attempt does not match its run start: ${file}`,
    );
  }
  if (
    executionAttempt.number === 1
    && executionAttempt.initialAdmission?.admission === 'executing'
    && executionAttempt.initialAdmission.admittedAt !== null
    && (
      Date.parse(executionAttempt.initialAdmission.admittedAt) < Date.parse(startedAt)
      || (
        plan.state === 'sealed'
        && Date.parse(executionAttempt.initialAdmission.admittedAt) < Date.parse(plan.sealedAt)
      )
    )
  ) {
    throw new AnalyzeRunJournalCorruptError(
      `Initial analyze execution admission has impossible chronology: ${file}`,
    );
  }
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
    Date.parse(terminalAt) < Date.parse(executionAttempt.activatedAt) ||
    (plan.state === 'sealed' && Date.parse(terminalAt) < Date.parse(plan.sealedAt))
  );
  const checkpointCount = plan.state === 'sealed'
    ? plan.work.filter((work) => work.state === 'succeeded-checkpointed').length
    : 0;
  const checkpointLifecycle = plan.state === 'sealed'
    && plan.work.every((work) => work.state === 'pending' || work.state === 'succeeded-checkpointed');
  const checkpointUpdatedAt = plan.state === 'sealed'
    ? plan.work.reduce(
        (latest, work) => work.state === 'succeeded-checkpointed'
          && Date.parse(work.checkpoint.checkpointedAt) >= Date.parse(latest)
          ? work.checkpoint.checkpointedAt
          : latest,
        plan.sealedAt,
      )
    : value.startedAt;
  const rearmHistoryIsReachable = validateStoredAmbiguousRearmHistory({
    history: rearmHistory,
    runId: value.runId,
    startedAt,
    plan,
    executionAttempt,
  });
  const checkpointTimestampsAreReachable = plan.state !== 'sealed'
    || plan.work.every((work) => work.state !== 'succeeded-checkpointed'
      || Date.parse(work.checkpoint.checkpointedAt) >= Date.parse(plan.sealedAt));
  const terminalPredatesCheckpoint = terminalAt !== null
    && Date.parse(terminalAt) < Date.parse(checkpointUpdatedAt);
  const allCheckpointed = plan.state === 'sealed'
    && plan.work.every((work) => work.state === 'succeeded-checkpointed');
  const allLegacySucceeded = executionAttempt.number === 1
    && plan.state === 'sealed'
    && plan.work.every((work) => work.state === 'succeeded-uncheckpointed');
  const preAdmissionSchema3Revision = schemaVersion === CHECKPOINT_SCHEMA_VERSION
    && plan.state === 'sealed'
    && checkpointLifecycle
    && (
      (status.state === 'running' && checkpointCount > 0 && revision === 1 + checkpointCount)
      || (status.state === 'blocked' && revision === 2 + checkpointCount)
      || (
        status.state === 'failed'
        && status.finalizingAt === null
        && revision === 2 + checkpointCount
      )
      || (
        allCheckpointed
        && status.state === 'finalizing'
        && revision === 2 + checkpointCount + (finalizationIntent === null ? 0 : 1)
      )
      || (
        allCheckpointed
        && status.state === 'completed'
        && revision === 4 + checkpointCount
      )
      || (
        allCheckpointed
        && status.state === 'failed'
        && status.finalizingAt !== null
        && revision === 3 + checkpointCount + (finalizationIntent === null ? 0 : 1)
      )
  );
  const lifecycleRevision = preAdmissionSchema3Revision ? revision + 1 : revision;
  const resumeAdmission = executionAttempt.resume?.admission ?? null;
  const initialAdmittedAt = executionAttempt.initialAdmission?.admittedAt ?? null;
  const resumedCheckpointTimestampsAreReachable = executionAttempt.number === 1
    ? plan.state !== 'sealed'
      || plan.work.every((work) => work.state !== 'succeeded-checkpointed'
        || initialAdmittedAt === null
        || Date.parse(work.checkpoint.checkpointedAt)
          >= Date.parse(initialAdmittedAt))
    : plan.state !== 'sealed'
    || plan.work.every((work) => {
      if (work.state !== 'succeeded-checkpointed') return true;
      const checkpointedAt = Date.parse(work.checkpoint.checkpointedAt);
      const priorEpochCutoff = executionAttempt.resume!.activation === 'ambiguous-rearm'
        ? rearmHistory.at(-1)?.acceptedAt
        : executionAttempt.resume!.resumedFrom?.blockedAt;
      if (priorEpochCutoff === undefined) return false;
      if (checkpointedAt <= Date.parse(priorEpochCutoff)) return true;
      return resumeAdmission === 'executing'
        && checkpointedAt >= Date.parse(executionAttempt.resume!.admittedAt!);
    });
  const initialCheckpointAdmissionIsReachable = executionAttempt.number > 1
    || checkpointCount === 0
    || executionAttempt.initialAdmission?.admission === 'executing';
  const initialRunningRevision = executionAttempt.initialAdmission?.admission === 'activated'
    || executionAttempt.initialAdmission?.admission === 'ambiguous'
    ? 1
    : 2 + checkpointCount;
  const resumedActivationRevision = 1
    + (3 * (executionAttempt.number - 1))
    - rearmHistory.length
    + checkpointCount;
  const runningRevision = executionAttempt.number === 1
    ? initialRunningRevision
    : resumedActivationRevision + (resumeAdmission === 'executing' ? 1 : 0);
  const finalizingRevision = allCheckpointed
    ? runningRevision + 1
    : schemaVersion === LEGACY_SCHEMA_VERSION
      ? 2
      : 3;
  const runningUpdatedAt = executionAttempt.number === 1
    ? executionAttempt.initialAdmission?.admission === 'activated'
      || executionAttempt.initialAdmission?.admission === 'ambiguous'
      || executionAttempt.initialAdmission?.admittedAt === null
      ? checkpointUpdatedAt
      : Date.parse(checkpointUpdatedAt) > Date.parse(initialAdmittedAt!)
        ? checkpointUpdatedAt
        : initialAdmittedAt!
    : resumeAdmission === 'activated'
      ? executionAttempt.activatedAt
      : Date.parse(checkpointUpdatedAt) > Date.parse(executionAttempt.resume!.admittedAt!)
        ? checkpointUpdatedAt
        : executionAttempt.resume!.admittedAt!;
  const executionCanBeTerminal = executionAttempt.number === 1
    || resumeAdmission === 'executing';
  const executionCanComplete = executionAttempt.number === 1
    ? executionAttempt.initialAdmission?.admission !== 'activated'
    : resumeAdmission === 'executing';
  const terminalFollowsAdmission = terminalAt === null
    || (
      executionAttempt.number === 1
        ? initialAdmittedAt === null
          || Date.parse(terminalAt) >= Date.parse(initialAdmittedAt)
        : Date.parse(terminalAt) >= Date.parse(executionAttempt.resume!.admittedAt!)
    );
  const nonFinalTerminalRevisionIsReachable = executionAttempt.number === 1
    ? lifecycleRevision === 2 || lifecycleRevision === initialRunningRevision + 1
    : lifecycleRevision === runningRevision + 1;
  const lifecycleIsReachable = plan.state === 'unsealed'
    ? (
      executionAttempt.number === 1
      && executionAttempt.activatedAt === value.startedAt
      && executionAttempt.resume === null
      && (
        schemaVersion !== SCHEMA_VERSION
        || executionAttempt.initialAdmission?.admission === 'activated'
      )
      && finalizationIntent === null && (
      (status.state === 'running' && lifecycleRevision === 0 && value.updatedAt === value.startedAt) ||
      (
        status.state === 'failed' &&
        status.finalizingAt === null &&
        lifecycleRevision === 1 &&
        status.failedAt === value.updatedAt
      )
      )
    )
    : (
      Date.parse(plan.sealedAt) >= Date.parse(value.startedAt) && (
        (
          status.state === 'running' &&
          finalizationIntent === null && (
            (
              executionAttempt.number === 1
              && executionAttempt.resume === null
              && (
                schemaVersion !== SCHEMA_VERSION
                || (
                  executionAttempt.initialAdmission?.admission === 'activated'
                  && executionAttempt.initialAdmission.evidence === 'explicit'
                )
              )
              && lifecycleRevision === 1
              && value.updatedAt === plan.sealedAt
              && plan.work.every((work) => work.state === 'pending')
            )
            || (
              checkpointLifecycle
              && (
                executionAttempt.number > 1
                || (
                  executionAttempt.initialAdmission?.admission === 'executing'
                  && (
                    schemaVersion !== SCHEMA_VERSION
                    || executionAttempt.initialAdmission.evidence === 'explicit'
                  )
                )
              )
              && lifecycleRevision === runningRevision
              && value.updatedAt === runningUpdatedAt
            )
          )
        ) ||
        (
          status.state === 'blocked' &&
          executionCanComplete &&
          finalizationIntent === null &&
          nonFinalTerminalRevisionIsReachable &&
          status.blockedAt === value.updatedAt &&
          checkpointLifecycle
        ) ||
        (
          status.state === 'failed' &&
          executionCanBeTerminal &&
          (
            (
              finalizationIntent === null &&
              nonFinalTerminalRevisionIsReachable &&
              status.finalizingAt === null &&
              checkpointLifecycle
            ) ||
            (
              executionCanComplete &&
              lifecycleRevision === finalizingRevision + (finalizationIntent === null ? 1 : 2) &&
              status.finalizingAt !== null &&
              Date.parse(status.finalizingAt) >= Date.parse(plan.sealedAt) &&
              Date.parse(status.failedAt) >= Date.parse(status.finalizingAt) &&
              (finalizationIntent === null
                || (
                  Date.parse(finalizationIntent.preparedAt) >= Date.parse(status.finalizingAt)
                  && Date.parse(status.failedAt) >= Date.parse(finalizationIntent.preparedAt)
                )) &&
              (allCheckpointed || allLegacySucceeded)
            )
          ) &&
          status.failedAt === value.updatedAt
        ) ||
        (
          status.state === 'finalizing' &&
          executionCanComplete &&
          lifecycleRevision === finalizingRevision + (finalizationIntent === null ? 0 : 1) &&
          (finalizationIntent === null
            ? status.finalizingAt === value.updatedAt
            : finalizationIntent.preparedAt === value.updatedAt
              && Date.parse(finalizationIntent.preparedAt) >= Date.parse(status.finalizingAt)) &&
          (allCheckpointed || allLegacySucceeded)
        ) || (
          status.state === 'completed' &&
          executionCanComplete &&
          lifecycleRevision === finalizingRevision + 2 &&
          finalizationIntent !== null &&
          status.completedAt === value.updatedAt &&
          Date.parse(status.finalizingAt) >= Date.parse(plan.sealedAt) &&
          Date.parse(finalizationIntent.preparedAt) >= Date.parse(status.finalizingAt) &&
          Date.parse(status.completedAt) >= Date.parse(finalizationIntent.preparedAt) &&
          (allCheckpointed || allLegacySucceeded)
        )
      )
    );
  if (
    !lifecycleIsReachable
    || terminalTimestampIsImpossible
    || !checkpointTimestampsAreReachable
    || !rearmHistoryIsReachable
    || !resumedCheckpointTimestampsAreReachable
    || !initialCheckpointAdmissionIsReachable
    || terminalPredatesCheckpoint
    || !terminalFollowsAdmission
  ) {
    throw new AnalyzeRunJournalCorruptError(`Impossible analyze-run lifecycle state: ${file}`);
  }
  /*
    The exact revision matrix above intentionally describes only the current commands:
    begin, seal-plan, durable initial execution admission, successful-result checkpoint,
    block, reserved resume activation/admission, fail, begin-finalize,
    prepare-finalization, and certified completion.
  */

  const normalizedRevision = schemaVersion === LEGACY_SCHEMA_VERSION && (
    status.state === 'finalizing'
    || status.state === 'completed'
    || (status.state === 'failed' && status.finalizingAt !== null)
  )
    ? revision + 1
    : lifecycleRevision;

  const stored: StoredAnalyzeRun = {
    schemaVersion: SCHEMA_VERSION,
    attemptSequence: value.attemptSequence as number,
    revision: normalizedRevision,
    runId: validateRunId(value.runId),
    candidateAnalysisId: requireNonEmpty(value.candidateAnalysisId, 'candidateAnalysisId'),
    status,
    startedAt,
    updatedAt: validateTimestamp(value.updatedAt, 'updatedAt'),
    source: validateSource(value.source),
    branch: value.branch,
    commitHash: value.commitHash,
    completedBaselineId: value.completedBaselineId,
    executionAttempt,
    rearmHistory,
    finalizationIntent,
    plan,
  };
  sourceAnalyzeRunSchemaVersions.set(stored, schemaVersion);
  return stored;
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

function inferLegacyInitialAdmission(input: Readonly<{
  schemaVersion: Exclude<ParsedLatestAttemptPointer['schemaVersion'], typeof SCHEMA_VERSION>;
  revision: number;
  status: StoredAnalyzeRun['status'];
  plan: StoredAnalyzeRun['plan'];
  executionAttempt: AnalyzeRunExecutionAttempt;
}>): AnalyzeRunInitialAdmission | null {
  if (input.executionAttempt.number > 1) return null;
  if (input.plan.state === 'unsealed') {
    return { admission: 'activated', admittedAt: null, evidence: 'legacy-inferred' };
  }

  const checkpointCount = input.plan.work.filter(
    (work) => work.state === 'succeeded-checkpointed',
  ).length;
  if (input.schemaVersion === LEGACY_SCHEMA_VERSION) {
    if (input.status.state === 'running' && input.revision >= 2) {
      return { admission: 'executing', admittedAt: null, evidence: 'legacy-inferred' };
    }
    if (checkpointCount > 0 || input.revision >= 3) {
      return { admission: 'executing', admittedAt: null, evidence: 'legacy-inferred' };
    }
    return { admission: 'ambiguous', admittedAt: null, evidence: 'legacy-ambiguous' };
  }

  if (input.schemaVersion === PREVIOUS_SCHEMA_VERSION) {
    return input.revision === 1
      ? { admission: 'activated', admittedAt: null, evidence: 'legacy-inferred' }
      : { admission: 'executing', admittedAt: null, evidence: 'legacy-inferred' };
  }

  if (input.schemaVersion === CHECKPOINT_SCHEMA_VERSION) {
    if (input.revision === 1 && checkpointCount === 0) {
      return { admission: 'ambiguous', admittedAt: null, evidence: 'legacy-ambiguous' };
    }
    return { admission: 'executing', admittedAt: null, evidence: 'legacy-inferred' };
  }

  return input.revision === 1
    ? { admission: 'activated', admittedAt: null, evidence: 'legacy-inferred' }
    : { admission: 'executing', admittedAt: null, evidence: 'legacy-inferred' };
}

function parseStoredExecutionAttempt(
  value: unknown,
  file: string,
): StoredAnalyzeRun['executionAttempt'] {
  if (!isRecord(value) || !Object.hasOwn(value, 'initialAdmission')) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze execution attempt: ${file}`);
  }
  const legacyShape = parseStoredSchemaV7ExecutionAttempt(value, file);
  if (legacyShape.number === 1) {
    return {
      ...legacyShape,
      initialAdmission: parseStoredInitialAdmission(value.initialAdmission, file),
    };
  }
  if (value.initialAdmission !== null) {
    throw new AnalyzeRunJournalCorruptError(
      `Resumed analyze attempt contains initial admission state: ${file}`,
    );
  }
  const resumedAdmittedAt = legacyShape.resume?.admittedAt ?? null;
  if (
    resumedAdmittedAt !== null
    && new Date(resumedAdmittedAt).toISOString() !== resumedAdmittedAt
  ) {
    throw new AnalyzeRunJournalCorruptError(
      `Resumed execution admission timestamp is not canonical UTC: ${file}`,
    );
  }
  return { ...legacyShape, initialAdmission: null };
}

function parseStoredSchemaV9ExecutionAttempt(
  value: unknown,
  file: string,
): StoredAnalyzeRun['executionAttempt'] {
  if (!isRecord(value) || !Object.hasOwn(value, 'initialAdmission')) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze execution attempt: ${file}`);
  }
  if (value.number === 1) return parseStoredExecutionAttempt(value, file);
  if (
    !Number.isSafeInteger(value.number)
    || (value.number as number) <= 1
    || typeof value.activatedAt !== 'string'
    || value.initialAdmission !== null
    || !isRecord(value.resume)
    || (
      value.resume.activation !== 'provider-session-limit'
      && value.resume.activation !== 'ambiguous-rearm'
    )
    || (value.resume.admission !== 'activated' && value.resume.admission !== 'executing')
  ) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze resume admission state: ${file}`);
  }
  const activatedAt = validateTimestamp(value.activatedAt, 'executionAttempt.activatedAt');
  const admittedAt = value.resume.admittedAt === null
    ? null
    : validateTimestamp(value.resume.admittedAt, 'executionAttempt.resume.admittedAt');
  if (
    (value.resume.admission === 'activated' && admittedAt !== null)
    || (value.resume.admission === 'executing' && admittedAt === null)
    || (admittedAt !== null && new Date(admittedAt).toISOString() !== admittedAt)
  ) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze resume admission timestamp: ${file}`);
  }
  const resumedFrom = value.resume.resumedFrom === null
    ? null
    : parseStoredProviderLimit(value.resume.resumedFrom, file);
  if (
    value.resume.activation === 'provider-session-limit' && resumedFrom === null
  ) {
    throw new AnalyzeRunJournalCorruptError(`Provider-limit resume is missing its limit record: ${file}`);
  }
  if (
    (resumedFrom !== null && Date.parse(resumedFrom.blockedAt) > Date.parse(activatedAt))
    || (admittedAt !== null && Date.parse(admittedAt) < Date.parse(activatedAt))
  ) {
    throw new AnalyzeRunJournalCorruptError(`Impossible analyze resume chronology: ${file}`);
  }
  return {
    number: value.number as number,
    activatedAt,
    initialAdmission: null,
    resume: {
      activation: value.resume.activation,
      admission: value.resume.admission,
      admittedAt,
      resumedFrom,
      executionPin: parseStoredResumeExecutionPin(value.resume.executionPin, file),
    },
  };
}

function parseStoredProviderLimit(
  value: unknown,
  file: string,
): NonNullable<NonNullable<AnalyzeRunExecutionAttempt['resume']>['resumedFrom']> {
  if (!isRecord(value) || value.reason !== 'provider-session-limit') {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze resume provider limit: ${file}`);
  }
  return {
    reason: 'provider-session-limit',
    resetHint: requireNonEmpty(value.resetHint, 'resetHint'),
    blockedAt: validateTimestamp(value.blockedAt, 'executionAttempt.resume.resumedFrom.blockedAt'),
  };
}

function parseStoredResumeExecutionPin(
  value: unknown,
  file: string,
): AnalyzeRunResumeExecutionPin {
  if (!isRecord(value)) {
    throw new AnalyzeRunJournalCorruptError(`Invalid resume execution pin: ${file}`);
  }
  const pinBase = {
    provider: requireNonEmpty(value.provider, 'executionPin.provider'),
    requestedModel: validateNullableString(value.requestedModel, 'executionPin.requestedModel'),
  };
  if (value.modelSelection === 'requested' && value.resolvedModel === null) {
    return { ...pinBase, modelSelection: 'requested', resolvedModel: null };
  }
  if (value.modelSelection === 'resolved') {
    const resolvedModel = requireNonEmpty(value.resolvedModel, 'executionPin.resolvedModel');
    if (resolvedModel.trim() !== resolvedModel) {
      throw new AnalyzeRunJournalCorruptError(`Invalid resolved resume model: ${file}`);
    }
    return { ...pinBase, modelSelection: 'resolved', resolvedModel };
  }
  throw new AnalyzeRunJournalCorruptError(`Invalid resume model selection: ${file}`);
}

function parseStoredAmbiguousRearmHistory(
  value: unknown,
  file: string,
): AnalyzeRunAmbiguousRearmRecord[] {
  if (!Array.isArray(value)) {
    throw new AnalyzeRunJournalCorruptError(`Invalid ambiguous rearm history: ${file}`);
  }
  return value.map((entry) => {
    if (
      !isRecord(entry)
      || !isRecord(entry.evidence)
      || !isRecord(entry.evidence.executionEpoch)
      || entry.acceptedRisk !== 'repeat-up-to-pending-provider-calls'
      || !Number.isSafeInteger(entry.acceptedMaxRepeatProviderCalls)
      || (entry.acceptedMaxRepeatProviderCalls as number) < 0
      || typeof entry.evidence.runId !== 'string'
      || !Number.isSafeInteger(entry.evidence.runRevision)
      || (entry.evidence.runRevision as number) < 0
      || (entry.evidence.executionEpoch.kind !== 'initial'
        && entry.evidence.executionEpoch.kind !== 'resume')
      || !Number.isSafeInteger(entry.evidence.executionEpoch.attemptNumber)
      || (entry.evidence.executionEpoch.attemptNumber as number) < 1
      || !Number.isSafeInteger(entry.evidence.pendingWorkCount)
      || (entry.evidence.pendingWorkCount as number) < 1
    ) {
      throw new AnalyzeRunJournalCorruptError(`Invalid ambiguous rearm history: ${file}`);
    }
    const epochActivatedAt = canonicalTimestamp(
      entry.evidence.executionEpoch.activatedAt,
      'rearmHistory.evidence.executionEpoch.activatedAt',
    );
    const admittedAt = canonicalTimestamp(
      entry.evidence.admittedAt,
      'rearmHistory.evidence.admittedAt',
    );
    const acceptedAt = canonicalTimestamp(entry.acceptedAt, 'rearmHistory.acceptedAt');
    if (
      epochActivatedAt !== entry.evidence.executionEpoch.activatedAt
      || admittedAt !== entry.evidence.admittedAt
      || acceptedAt !== entry.acceptedAt
    ) {
      throw new AnalyzeRunJournalCorruptError(
        `Ambiguous rearm history contains non-canonical timestamps: ${file}`,
      );
    }
    const evidence: AnalyzeRunAmbiguousRearmEvidence = {
      runId: validateRunId(entry.evidence.runId),
      runRevision: entry.evidence.runRevision as number,
      executionEpoch: {
        kind: entry.evidence.executionEpoch.kind,
        attemptNumber: entry.evidence.executionEpoch.attemptNumber as number,
        activatedAt: epochActivatedAt,
      },
      admittedAt,
      pendingWorkCount: entry.evidence.pendingWorkCount as number,
    };
    if (
      Date.parse(evidence.admittedAt) < Date.parse(evidence.executionEpoch.activatedAt)
      || Date.parse(acceptedAt) < Date.parse(evidence.admittedAt)
    ) {
      throw new AnalyzeRunJournalCorruptError(`Impossible ambiguous rearm chronology: ${file}`);
    }
    return {
      evidence,
      acceptedAt,
      acceptedRisk: 'repeat-up-to-pending-provider-calls',
      acceptedMaxRepeatProviderCalls: entry.acceptedMaxRepeatProviderCalls as number,
      executionPin: parseStoredResumeExecutionPin(entry.executionPin, file),
    };
  });
}

function validateStoredAmbiguousRearmHistory(input: Readonly<{
  history: readonly AnalyzeRunAmbiguousRearmRecord[];
  runId: unknown;
  startedAt: string;
  plan: StoredAnalyzeRun['plan'];
  executionAttempt: AnalyzeRunExecutionAttempt;
}>): boolean {
  const { history, plan, executionAttempt } = input;
  if (history.length === 0) {
    return executionAttempt.resume?.activation !== 'ambiguous-rearm';
  }
  if (plan.state !== 'sealed') return false;
  let previousAttempt = 0;
  let previousAcceptedAt = Number.NEGATIVE_INFINITY;
  let previousCheckpointCount = 0;
  for (const [index, record] of history.entries()) {
    const epoch = record.evidence.executionEpoch;
    const checkpointCountAtAcceptance = plan.work.length - record.evidence.pendingWorkCount;
    const currentCheckpointCount = plan.work.filter(
      (work) => work.state === 'succeeded-checkpointed',
    ).length;
    const expectedRevision = 1
      + (3 * (epoch.attemptNumber - 1))
      - index
      + checkpointCountAtAcceptance
      + 1;
    if (
      record.evidence.runId !== input.runId
      || epoch.attemptNumber >= executionAttempt.number
      || record.acceptedMaxRepeatProviderCalls !== record.evidence.pendingWorkCount
      || record.evidence.pendingWorkCount > plan.work.length
      || checkpointCountAtAcceptance > currentCheckpointCount
      || checkpointCountAtAcceptance < previousCheckpointCount
      || (epoch.kind === 'initial') !== (epoch.attemptNumber === 1)
      || (epoch.kind === 'initial' && epoch.activatedAt !== input.startedAt)
      || (
        epoch.kind === 'resume'
        && Date.parse(epoch.activatedAt) < Date.parse(plan.sealedAt)
      )
      || Date.parse(record.evidence.admittedAt) < Date.parse(plan.sealedAt)
      || Date.parse(record.acceptedAt) > Date.parse(executionAttempt.activatedAt)
      || epoch.attemptNumber <= previousAttempt
      || Date.parse(epoch.activatedAt) < previousAcceptedAt
      || Date.parse(record.acceptedAt) < previousAcceptedAt
      || record.evidence.runRevision !== expectedRevision
      || plan.execution === null
      || record.executionPin.provider !== plan.execution.provider
      || record.executionPin.requestedModel !== plan.execution.requestedModel
    ) return false;
    previousAttempt = epoch.attemptNumber;
    previousAcceptedAt = Date.parse(record.acceptedAt);
    previousCheckpointCount = checkpointCountAtAcceptance;
  }
  if (executionAttempt.resume?.activation !== 'ambiguous-rearm') return true;
  const last = history.at(-1)!;
  return last.evidence.executionEpoch.attemptNumber === executionAttempt.number - 1
    && last.acceptedAt === executionAttempt.activatedAt
    && isDeepStrictEqual(last.executionPin, executionAttempt.resume.executionPin);
}

function parseStoredInitialAdmission(
  value: unknown,
  file: string,
): AnalyzeRunInitialAdmission {
  if (!isRecord(value) || typeof value.admission !== 'string') {
    throw new AnalyzeRunJournalCorruptError(`Invalid initial execution admission: ${file}`);
  }
  if (
    value.admission === 'activated'
    && value.admittedAt === null
    && (value.evidence === 'explicit' || value.evidence === 'legacy-inferred')
  ) {
    return {
      admission: 'activated',
      admittedAt: null,
      evidence: value.evidence,
    };
  }
  if (
    value.admission === 'executing'
    && value.evidence === 'explicit'
    && typeof value.admittedAt === 'string'
  ) {
    const admittedAt = validateTimestamp(
      value.admittedAt,
      'executionAttempt.initialAdmission.admittedAt',
    );
    if (new Date(admittedAt).toISOString() !== admittedAt) {
      throw new AnalyzeRunJournalCorruptError(
        `Initial execution admission timestamp is not canonical UTC: ${file}`,
      );
    }
    return { admission: 'executing', admittedAt, evidence: 'explicit' };
  }
  if (
    value.admission === 'executing'
    && value.admittedAt === null
    && value.evidence === 'legacy-inferred'
  ) {
    return { admission: 'executing', admittedAt: null, evidence: 'legacy-inferred' };
  }
  if (
    value.admission === 'ambiguous'
    && value.admittedAt === null
    && value.evidence === 'legacy-ambiguous'
  ) {
    return { admission: 'ambiguous', admittedAt: null, evidence: 'legacy-ambiguous' };
  }
  throw new AnalyzeRunJournalCorruptError(`Invalid initial execution admission: ${file}`);
}

function parseStoredSchemaV7ExecutionAttempt(
  value: unknown,
  file: string,
): StoredAnalyzeRun['executionAttempt'] {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.number)
    || (value.number as number) < 1
    || typeof value.activatedAt !== 'string'
  ) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze execution attempt: ${file}`);
  }
  const number = value.number as number;
  const activatedAt = validateTimestamp(value.activatedAt, 'executionAttempt.activatedAt');
  if (number === 1) {
    if (value.resume !== null) {
      throw new AnalyzeRunJournalCorruptError(`Initial analyze attempt contains resume state: ${file}`);
    }
    return { number, activatedAt, initialAdmission: null, resume: null };
  }
  if (
    !isRecord(value.resume)
    || (value.resume.admission !== 'activated' && value.resume.admission !== 'executing')
    || !isRecord(value.resume.resumedFrom)
    || value.resume.resumedFrom.reason !== 'provider-session-limit'
    || !isRecord(value.resume.executionPin)
  ) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze resume admission state: ${file}`);
  }
  const admittedAt = value.resume.admittedAt === null
    ? null
    : validateTimestamp(value.resume.admittedAt, 'executionAttempt.resume.admittedAt');
  if (
    (value.resume.admission === 'activated' && admittedAt !== null)
    || (value.resume.admission === 'executing' && admittedAt === null)
  ) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze resume admission timestamp: ${file}`);
  }
  const blockedAt = validateTimestamp(
    value.resume.resumedFrom.blockedAt,
    'executionAttempt.resume.resumedFrom.blockedAt',
  );
  const pinBase = {
    provider: requireNonEmpty(value.resume.executionPin.provider, 'executionPin.provider'),
    requestedModel: validateNullableString(
      value.resume.executionPin.requestedModel,
      'executionPin.requestedModel',
    ),
  };
  let executionPin: AnalyzeRunResumeExecutionPin;
  if (
    value.resume.executionPin.modelSelection === 'requested'
    && value.resume.executionPin.resolvedModel === null
  ) {
    executionPin = { ...pinBase, modelSelection: 'requested', resolvedModel: null };
  } else if (value.resume.executionPin.modelSelection === 'resolved') {
    const resolvedModel = requireNonEmpty(
      value.resume.executionPin.resolvedModel,
      'executionPin.resolvedModel',
    );
    if (resolvedModel.trim() !== resolvedModel) {
      throw new AnalyzeRunJournalCorruptError(`Invalid resolved resume model: ${file}`);
    }
    executionPin = { ...pinBase, modelSelection: 'resolved', resolvedModel };
  } else {
    throw new AnalyzeRunJournalCorruptError(`Invalid resume model selection: ${file}`);
  }
  if (
    Date.parse(blockedAt) > Date.parse(activatedAt)
    || (admittedAt !== null && Date.parse(admittedAt) < Date.parse(activatedAt))
  ) {
    throw new AnalyzeRunJournalCorruptError(`Impossible analyze resume chronology: ${file}`);
  }
  return {
    number,
    activatedAt,
    initialAdmission: null,
    resume: {
      activation: 'provider-session-limit',
      admission: value.resume.admission,
      admittedAt,
      resumedFrom: {
        reason: 'provider-session-limit',
        resetHint: requireNonEmpty(value.resume.resumedFrom.resetHint, 'resetHint'),
        blockedAt,
      },
      executionPin,
    },
  };
}

function parseStoredSchemaV5ExecutionAttempt(
  value: unknown,
  file: string,
): StoredAnalyzeRun['executionAttempt'] {
  if (!isRecord(value) || value.number === 1) {
    return parseStoredSchemaV7ExecutionAttempt(value, file);
  }
  if (!isRecord(value.resume) || !isRecord(value.resume.executionPin)) {
    throw new AnalyzeRunJournalCorruptError(`Invalid schema-v5 execution attempt: ${file}`);
  }
  return parseStoredSchemaV7ExecutionAttempt({
    ...value,
    resume: {
      ...value.resume,
      executionPin: {
        ...value.resume.executionPin,
        modelSelection: 'resolved',
      },
    },
  }, file);
}

function parseStoredSchemaV4ExecutionAttempt(
  value: unknown,
  file: string,
): StoredAnalyzeRun['executionAttempt'] {
  if (
    !isRecord(value)
    || value.number !== 1
    || typeof value.activatedAt !== 'string'
    || Object.hasOwn(value, 'resume')
  ) {
    throw new AnalyzeRunJournalCorruptError(`Invalid schema-v4 execution attempt: ${file}`);
  }
  return {
    number: 1,
    activatedAt: validateTimestamp(value.activatedAt, 'executionAttempt.activatedAt'),
    initialAdmission: null,
    resume: null,
  };
}

function validateWorkCheckpoint(command: CheckpointAnalyzeRunWorkCommand): AnalyzeRunWorkCheckpoint {
  const result = jsonStableCopy(command.result, 'checkpoint result');
  return {
    checkpointedAt: validateCanonicalCheckpointTimestamp(command.checkpointedAt),
    attemptId: requireNonEmpty(command.attemptId, 'attemptId'),
    resultContractId: requireNonEmpty(command.resultContractId, 'resultContractId'),
    resultFingerprint: fingerprint(result),
    result,
    usage: command.usage === null ? null : validateCheckpointUsage(command.usage),
  };
}

function validateCanonicalCheckpointTimestamp(value: unknown): string {
  let timestamp: string;
  try {
    timestamp = validateTimestamp(value, 'checkpointedAt');
  } catch (error) {
    throw new InvalidAnalyzeRunTransitionError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new InvalidAnalyzeRunTransitionError('checkpointedAt must be a canonical UTC timestamp');
  }
  return timestamp;
}

function parseWorkCheckpoint(value: unknown, file: string): AnalyzeRunWorkCheckpoint {
  if (!isRecord(value)) {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze-run checkpoint: ${file}`);
  }
  let parsed: ReturnType<typeof validateWorkCheckpoint>;
  try {
    parsed = validateWorkCheckpoint({
      workId: 'stored',
      inputFingerprint: `sha256:${'0'.repeat(64)}`,
      checkpointedAt: value.checkpointedAt as string,
      attemptId: value.attemptId as string,
      resultContractId: value.resultContractId as string,
      result: value.result,
      usage: value.usage as AnalyzeLlmExecutionUsage | null,
    });
  } catch {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze-run checkpoint: ${file}`);
  }
  if (value.resultFingerprint !== parsed.resultFingerprint) {
    throw new AnalyzeRunJournalCorruptError(`Analyze-run checkpoint fingerprint mismatch: ${file}`);
  }
  return parsed;
}

function validateCheckpointUsage(value: AnalyzeLlmExecutionUsage): AnalyzeLlmExecutionUsage {
  if (!isRecord(value)) throw new InvalidAnalyzeRunTransitionError('Invalid checkpoint usage');
  const integerKeys = [
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'durationMs',
  ] as const;
  if (
    typeof value.provider !== 'string' || value.provider.length === 0
    || (value.requestedModel !== null && (typeof value.requestedModel !== 'string' || value.requestedModel.length === 0))
    || (value.resolvedModel !== null && (typeof value.resolvedModel !== 'string' || value.resolvedModel.length === 0))
    || typeof value.callType !== 'string' || value.callType.length === 0
    || integerKeys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || value.totalTokens !== value.inputTokens + value.outputTokens
    || (value.costUsd !== null && (typeof value.costUsd !== 'string' || value.costUsd.length === 0 || !Number.isFinite(Number(value.costUsd)) || Number(value.costUsd) < 0))
  ) {
    throw new InvalidAnalyzeRunTransitionError('Invalid checkpoint usage');
  }
  return { ...value };
}

function jsonStableCopy(value: unknown, label: string): unknown {
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new InvalidAnalyzeRunTransitionError(`${label} is not JSON-stable: ${String(error)}`);
  }
  if (!isDeepStrictEqual(copy, value)) {
    throw new InvalidAnalyzeRunTransitionError(`${label} is not JSON-stable`);
  }
  return copy;
}

function parseStoredPlan(
  value: Record<string, unknown>,
  file: string,
  schemaVersion: ParsedLatestAttemptPointer['schemaVersion'],
): StoredAnalyzeRun['plan'] {
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
      (state !== 'pending' && state !== 'succeeded-uncheckpointed' && state !== 'succeeded-checkpointed')
    ) {
      throw new AnalyzeRunJournalCorruptError(`Invalid analyze-run work record: ${file}`);
    }
    const base = {
      workId: requireNonEmpty(item.workId, 'workId'),
      inputFingerprint: validateFingerprint(item.inputFingerprint),
    };
    if (state === 'succeeded-checkpointed') {
      if (
        schemaVersion !== CHECKPOINT_SCHEMA_VERSION
        && schemaVersion !== RESUME_ADMISSION_SCHEMA_VERSION
        && schemaVersion !== REQUESTED_MODEL_PIN_SCHEMA_VERSION
        && schemaVersion !== SEALED_EXECUTION_SCHEMA_VERSION
        && schemaVersion !== INITIAL_ADMISSION_SCHEMA_VERSION
        && schemaVersion !== SCHEMA_VERSION
      ) {
        throw new AnalyzeRunJournalCorruptError(
          `Schema-v${schemaVersion} run contains checkpoint state: ${file}`,
        );
      }
      return { ...base, state, checkpoint: parseWorkCheckpoint(item.checkpoint, file) };
    }
    return { ...base, state };
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
    execution: schemaVersion === SCHEMA_VERSION
      || schemaVersion === INITIAL_ADMISSION_SCHEMA_VERSION
      || schemaVersion === SEALED_EXECUTION_SCHEMA_VERSION
      ? parseStoredExecutionIntentOrLegacyNull(value, file)
      : null,
    work,
  };
}

function parseStoredExecutionIntentOrLegacyNull(
  plan: Record<string, unknown>,
  file: string,
): AnalyzeRunExecutionIntent | null {
  if (!Object.hasOwn(plan, 'execution')) {
    throw new AnalyzeRunJournalCorruptError(`Missing analyze-run execution intent: ${file}`);
  }
  if (
    isRecord(plan.execution)
    && plan.execution.state === 'legacy-unbound'
    && Object.keys(plan.execution).length === 1
  ) {
    return null;
  }
  return parseStoredExecutionIntent(plan.execution, file);
}

function parseStoredExecutionIntent(
  value: unknown,
  file: string,
): AnalyzeRunExecutionIntent {
  try {
    return { ...validateLlmWorkExecutionIntent(value) };
  } catch {
    throw new AnalyzeRunJournalCorruptError(`Invalid analyze-run execution intent: ${file}`);
  }
}

function serializeStoredRun(run: StoredAnalyzeRun): StoredAnalyzeRun | Record<string, unknown> {
  if (run.plan.state !== 'sealed' || run.plan.execution !== null) return run;
  return {
    ...run,
    plan: {
      ...run.plan,
      execution: { state: 'legacy-unbound' },
    },
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
