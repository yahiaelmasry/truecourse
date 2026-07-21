import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { atomicWriteJson } from './atomic-write.js';

const SCHEMA_VERSION = 1 as const;
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
  state: 'running' | 'blocked' | 'failed';
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
  resume: {
    available: false;
    reason: 'successful-results-not-checkpointed';
  };
}

export interface StoredAnalyzeRunWork {
  workId: string;
  inputFingerprint: string;
  state: 'pending';
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
      };
  startedAt: string;
  updatedAt: string;
  source: AnalyzeRunSource;
  branch: string | null;
  commitHash: string | null;
  completedBaselineId: string | null;
  plan:
    | { state: 'unsealed' }
    | { state: 'sealed'; sealedAt: string; work: StoredAnalyzeRunWork[] };
}

export type NewStoredAnalyzeRun = Omit<StoredAnalyzeRun, 'attemptSequence'>;

interface LatestAttemptPointer {
  schemaVersion: typeof SCHEMA_VERSION;
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
      let pointer: LatestAttemptPointer | null = null;
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

      if (pointer?.runId !== latest.runId) {
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

/**
 * Apply one run-lifecycle command. Callers using the default file adapter must hold the
 * repository-wide analyze lock for the complete begin/plan/execute/finalize lifecycle.
 */
export async function dispatchAnalyzeRun(
  repoKey: string,
  command: AnalyzeRunCommand,
): Promise<AnalyzeRunView> {
  if (!isRecord(command) || !['begin', 'seal-plan', 'block', 'fail'].includes(String(command.kind))) {
    throw new InvalidAnalyzeRunTransitionError(
      `Invalid analyze-run command kind: ${String(isRecord(command) ? command.kind : undefined)}`,
    );
  }
  if (command.kind === 'seal-plan') {
    return sealPlan(repoKey, command);
  }
  if (command.kind === 'block') {
    return blockRun(repoKey, command);
  }
  if (command.kind === 'fail') {
    return failRun(repoKey, command);
  }

  const source = validateSource(command.source);
  if (source === 'hosted' && activeStorage instanceof FileAnalyzeRunStorage) {
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
    plan: { state: 'unsealed' },
  };
  const stored = await activeStorage.createLatest(repoKey, run);
  return toView(stored);
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
        succeeded: 0,
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
    resume: {
      available: false,
      reason: 'successful-results-not-checkpointed',
    },
  };
}

async function failRun(
  repoKey: string,
  command: FailAnalyzeRunCommand,
): Promise<AnalyzeRunView> {
  const runId = validateRunId(command.runId);
  const current = await activeStorage.read(repoKey, runId);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  if (current.status.state !== 'running') {
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
    (current.plan.state === 'sealed' && Date.parse(failedAt) < Date.parse(current.plan.sealedAt))
  ) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${runId} failure cannot precede its start or sealed plan`,
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
    },
  };
  await activeStorage.compareAndSwap(repoKey, runId, current.revision, next);
  return toView(next);
}

async function blockRun(
  repoKey: string,
  command: BlockAnalyzeRunCommand,
): Promise<AnalyzeRunView> {
  const runId = validateRunId(command.runId);
  const current = await activeStorage.read(repoKey, runId);
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
  await activeStorage.compareAndSwap(repoKey, runId, current.revision, next);
  return toView(next);
}

async function sealPlan(
  repoKey: string,
  command: SealAnalyzeRunPlanCommand,
): Promise<AnalyzeRunView> {
  const runId = validateRunId(command.runId);
  const current = await activeStorage.read(repoKey, runId);
  if (!current) throw new AnalyzeRunNotFoundError(runId);
  if (current.status.state !== 'running' || current.plan.state !== 'unsealed') {
    throw new InvalidAnalyzeRunTransitionError(
      `Cannot seal plan for analyze run ${runId} from ${current.status.state}/${current.plan.state}`,
    );
  }

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
  await activeStorage.compareAndSwap(repoKey, runId, current.revision, next);
  return toView(next);
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

function parseLatestPointer(value: unknown, file: string): LatestAttemptPointer {
  try {
    if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.runId !== 'string') {
      throw new AnalyzeRunJournalCorruptError(`Invalid latest analyze-run pointer: ${file}`);
    }
    return { schemaVersion: SCHEMA_VERSION, runId: validateRunId(value.runId) };
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
    value.schemaVersion !== SCHEMA_VERSION ||
    !Number.isSafeInteger(value.attemptSequence) ||
    (value.attemptSequence as number) < 1 ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.runId !== 'string' ||
    typeof value.candidateAnalysisId !== 'string' ||
    !isRecord(value.status) ||
    !['running', 'blocked', 'failed'].includes(String(value.status.state)) ||
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
  const terminalAt = status.state === 'blocked'
    ? status.blockedAt
    : status.state === 'failed'
      ? status.failedAt
      : null;
  const terminalTimestampIsImpossible = terminalAt !== null && (
    Date.parse(terminalAt) < Date.parse(value.startedAt) ||
    (plan.state === 'sealed' && Date.parse(terminalAt) < Date.parse(plan.sealedAt))
  );
  const lifecycleIsReachable = plan.state === 'unsealed'
    ? (
      (status.state === 'running' && revision === 0 && value.updatedAt === value.startedAt) ||
      (status.state === 'failed' && revision === 1 && status.failedAt === value.updatedAt)
    )
    : (
      Date.parse(plan.sealedAt) >= Date.parse(value.startedAt) && (
        (status.state === 'running' && [1, 2].includes(revision) && value.updatedAt === plan.sealedAt) ||
        (status.state === 'blocked' && [2, 3].includes(revision) && status.blockedAt === value.updatedAt) ||
        (status.state === 'failed' && [2, 3].includes(revision) && status.failedAt === value.updatedAt)
      )
    );
  if (!lifecycleIsReachable || terminalTimestampIsImpossible) {
    throw new AnalyzeRunJournalCorruptError(`Impossible analyze-run lifecycle state: ${file}`);
  }
  /*
    Schema v1 reserves revision 2 for running/sealed execution admission and revision 3 for its
    terminal transitions so a later writer can add admission without making its journals unreadable
    by this initial reader. Future work-result/finalization commands must migrate or extend the
    durable schema together with these invariants.
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
    plan,
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
    return {
      state: 'failed',
      code: validateErrorCode(value.code),
      message: validatePublicErrorMessage(value.message),
      failedAt: validateTimestamp(value.failedAt, 'failedAt'),
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
  const work = value.work.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.workId !== 'string' ||
      typeof item.inputFingerprint !== 'string' ||
      item.state !== 'pending'
    ) {
      throw new AnalyzeRunJournalCorruptError(`Invalid analyze-run work record: ${file}`);
    }
    return {
      workId: requireNonEmpty(item.workId, 'workId'),
      inputFingerprint: validateFingerprint(item.inputFingerprint),
      state: 'pending' as const,
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
