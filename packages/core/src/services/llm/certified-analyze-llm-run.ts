import { CODE_DOMAINS, type RuleDomain } from '@truecourse/shared';
import { isLlmSessionLimitError } from '@truecourse/shared/llm';
import { isDeepStrictEqual } from 'node:util';
import {
  activateAnalyzeRunResume,
  admitAnalyzeRunPlanExecution,
  checkpointAnalyzeRunWork,
  type AnalyzeRunView,
  type AnalyzeRunSource,
  type AnalyzeRunExecutionCompletion,
  type AnalyzeRunCheckpointWriter,
  type AnalyzeRunPlanActivation,
  type AnalyzeRunResumePlanActivation,
} from '../../lib/analyze-run-journal.js';
import { activeCompletedBaselineId, getAnalysisStore } from '../../lib/analysis-store.js';
import { readAnalyzeRunResumeCandidate } from '../../lib/analyze-run-resume-candidate.js';
import { certifyAnalyzeRunExecutionCompletion } from '../../lib/analyze-run-execution-completion.js';
import { certifyAnalyzeRunWorkCheckpoint } from '../../lib/analyze-run-work-checkpoint-certification.js';
import { certifyAnalyzeRunResumeActivation } from '../../lib/analyze-run-resume-activation-certification.js';
import type { AnalyzeLlmExecutionUsage } from './analyze-llm-execution-evidence.js';
import { log } from '../../lib/logger.js';
import type {
  CodeViolationContext,
  DatabaseViolationContext,
  ModuleViolationContext,
  ServiceViolationContext,
} from './provider.js';
import {
  planCodeViolationWork,
  type PlannedCodeViolationWork,
} from './code-work-planner.js';
import {
  planDatabaseViolationWork,
  type PlannedDatabaseViolationWork,
} from './database-work-planner.js';
import {
  planModuleViolationWork,
  type PlannedModuleViolationWork,
} from './module-work-planner.js';
import {
  planServiceViolationWork,
  type PlannedServiceViolationWork,
} from './service-work-planner.js';
import type { LlmWorkExecutionIntent } from './work-identity.js';
import { fingerprint } from './work-identity.js';

export type AnalyzeLlmWorkFamily = 'code' | 'database' | 'service' | 'module';
export type AnalyzeLlmWorkMode = 'normal' | 'lifecycle';

interface CertifiedAnalyzeLlmWorkBase {
  readonly family: AnalyzeLlmWorkFamily;
  readonly domain: RuleDomain;
  readonly mode: AnalyzeLlmWorkMode;
  readonly workId: string;
  readonly inputFingerprint: string;
}

export type CertifiedAnalyzeLlmWork =
  | (CertifiedAnalyzeLlmWorkBase & {
      readonly family: 'code';
      readonly planned: PlannedCodeViolationWork;
    })
  | (CertifiedAnalyzeLlmWorkBase & {
      readonly family: 'database';
      readonly planned: PlannedDatabaseViolationWork;
    })
  | (CertifiedAnalyzeLlmWorkBase & {
      readonly family: 'service';
      readonly planned: PlannedServiceViolationWork;
    })
  | (CertifiedAnalyzeLlmWorkBase & {
      readonly family: 'module';
      readonly planned: PlannedModuleViolationWork;
    });

export interface AnalyzeLlmPlanManifest {
  readonly version: 1;
  readonly work: readonly {
    readonly family: AnalyzeLlmWorkFamily;
    readonly domain: RuleDomain;
    readonly mode: AnalyzeLlmWorkMode;
    readonly workId: string;
    readonly inputFingerprint: string;
  }[];
}

export interface AnalyzeLlmExecutionAdapter {
  readonly execution: Readonly<LlmWorkExecutionIntent>;
  /** Exact resume-only model pin. Pending execution must enforce this value. */
  readonly resumeExecution?: Readonly<LlmWorkExecutionIntent & {
    readonly modelSelection: 'pinned';
    readonly resolvedModel: string;
  }>;
  /** Create an adapter-scoped executor that can enforce an exact resume model, when supported. */
  createPinnedResumeAdapter?(resolvedModel: string): AnalyzeLlmExecutionAdapter;
  execute(
    work: CertifiedAnalyzeLlmWork,
    options?: AnalyzeLlmExecutionOptions,
  ): Promise<AnalyzeLlmExecutionOutcome>;
}

export interface AnalyzeLlmExecutionOptions {
  /** Fires only after the provider concurrency limiter admits this work item. */
  readonly onStart?: () => void;
}

export interface AnalyzeLlmWorkProgressObserver {
  readonly onWorkStart?: (work: CertifiedAnalyzeLlmWork) => void | Promise<void>;
  readonly onWorkDone?: (
    work: CertifiedAnalyzeLlmWork,
    state: Readonly<{ started: boolean; ok: boolean }>,
  ) => void | Promise<void>;
}

/** Raw parsed provider output echoed with the certified work identity that produced it. */
export interface AnalyzeLlmExecutionOutcome {
  readonly family: AnalyzeLlmWorkFamily;
  readonly domain: RuleDomain;
  readonly mode: AnalyzeLlmWorkMode;
  readonly workId: string;
  readonly inputFingerprint: string;
  readonly resultContractId: string;
  readonly result: unknown;
  readonly attemptId: string;
  readonly completedAt: string;
  readonly usage: AnalyzeLlmExecutionUsage | null;
}

export interface CertifiedAnalyzeLlmRun {
  readonly manifest: AnalyzeLlmPlanManifest;
  inspectResumeCompatibility(
    identity: AnalyzeLlmResumeIdentity,
  ): Promise<AnalyzeLlmResumeCompatibility>;
  activateResume(
    identity: AnalyzeLlmResumeIdentity,
    activatedAt: string,
  ): Promise<AnalyzeLlmResumeActivationResult>;
  execute(
    activation: AnalyzeRunPlanActivation,
    observer?: AnalyzeLlmWorkProgressObserver,
  ): Promise<CertifiedAnalyzeLlmExecution>;
}

export interface AnalyzeLlmResumeIdentity {
  readonly candidateAnalysisId: string;
  readonly startedAt: string;
  readonly source: AnalyzeRunSource;
  readonly branch: string | null;
  readonly commitHash: string | null;
  readonly completedBaselineId: string | null;
}

export type AnalyzeLlmResumeIncompatibility =
  | 'run-not-found'
  | 'not-latest-attempt'
  | 'run-not-blocked'
  | 'run-changed-during-inspection'
  | 'run-identity-changed'
  | 'completed-baseline-changed'
  | 'completed-baseline-invalid'
  | 'inspection-storage-changed'
  | 'work-plan-changed'
  | 'uncheckpointed-success'
  | 'checkpoint-contract-changed'
  | 'checkpoint-result-invalid'
  | 'checkpoint-execution-changed'
  | 'checkpoint-model-unverified'
  | 'duplicate-checkpoint-attempt'
  | 'activated-execution-changed';

export type AnalyzeLlmResumeCompatibility =
  | Readonly<{
      compatible: false;
      reason: AnalyzeLlmResumeIncompatibility;
    }>
  | Readonly<{
      compatible: true;
      /** Inspection is advisory; resume activation must atomically revalidate every observation. */
      requiresActivationRevalidation: true;
      resetHint: string;
      counts: Readonly<{ total: number; reused: number; pending: number }>;
      reusedWorkIds: readonly string[];
      pendingWorkIds: readonly string[];
      observed: Readonly<{
        runRevision: number;
        attemptSequence: number;
        latestAttemptSequence: number;
        completedBaselineFingerprint: string | null;
        resolvedModel: string;
      }>;
    }>;

export type AnalyzeLlmResumeActivationResult =
  | Readonly<{
      activated: false;
      reason: AnalyzeLlmResumeIncompatibility;
    }>
  | Readonly<{
      activated: true;
      view: AnalyzeRunView;
      counts: Readonly<{ total: number; reused: number; pending: number }>;
      activation: AnalyzeRunResumePlanActivation;
    }>;

interface AnalyzeLlmResumeInspection {
  readonly compatibility: AnalyzeLlmResumeCompatibility;
  readonly durableActivatedAt: string | null;
}

export interface CertifiedAnalyzeLlmExecution {
  readonly results: readonly {
    readonly work: CertifiedAnalyzeLlmWork;
    readonly result: unknown;
  }[];
  readonly completion: AnalyzeRunExecutionCompletion;
}

export interface AnalyzeLlmPlanInput {
  readonly runId: string;
  readonly journalKey: string;
  readonly repositoryRoot: string;
  readonly code: readonly {
    readonly domain: RuleDomain;
    readonly context: CodeViolationContext;
  }[];
  readonly database?: DatabaseViolationContext;
  readonly service?: ServiceViolationContext;
  readonly module?: ModuleViolationContext;
}

export type AnalyzeLlmPlanErrorCode =
  | 'provider-not-certifiable'
  | 'invalid-context'
  | 'request-preparation-failed'
  | 'duplicate-work-id'
  | 'read-snapshot-unavailable'
  | 'plan-not-activated'
  | 'already-executed'
  | 'result-not-certified';

export class AnalyzeLlmPlanError extends Error {
  constructor(
    readonly code: AnalyzeLlmPlanErrorCode,
    message: string,
    readonly family?: AnalyzeLlmWorkFamily,
    readonly domain?: RuleDomain,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AnalyzeLlmPlanError';
  }
}

export function certifyAnalyzeLlmRun(
  input: AnalyzeLlmPlanInput,
  adapter: AnalyzeLlmExecutionAdapter,
): CertifiedAnalyzeLlmRun {
  const runId = validateRunId(input.runId);
  const journalKey = validateJournalKey(input.journalKey);
  const execution = validateExecution(adapter.execution);
  const work: CertifiedAnalyzeLlmWork[] = [];

  for (const candidate of input.code) {
    work.push(certify('code', candidate.domain, () => {
      validateCodeDomain(candidate.domain, candidate.context);
      const planned = planCodeViolationWork(candidate.context, {
        ...execution,
        repositoryRoot: input.repositoryRoot,
      });
      if (planned.request.toolPolicy === 'read') {
        throw new AnalyzeLlmPlanError(
          'read-snapshot-unavailable',
          'Read-enabled analyze work requires a certified repository snapshot',
          'code',
          candidate.domain,
        );
      }
      return Object.freeze({
        family: 'code' as const,
        domain: candidate.domain,
        mode: modeFor(candidate.context.existingViolations),
        workId: planned.workId,
        inputFingerprint: planned.inputFingerprint,
        planned,
      });
    }));
  }

  if (input.database) {
    const mode = modeFor(input.database.existingViolations);
    work.push(certify('database', 'database', () => {
      validateAggregateDomain('database', 'database', input.database!.llmRules);
      const planned = mode === 'lifecycle'
        ? planDatabaseViolationWork(input.database!, 'lifecycle', execution)
        : planDatabaseViolationWork(input.database!, 'normal', execution);
      return Object.freeze({
        family: 'database' as const,
        domain: 'database',
        mode,
        workId: planned.workId,
        inputFingerprint: planned.inputFingerprint,
        planned,
      });
    }));
  }

  if (input.service) {
    const mode = modeFor(input.service.existingViolations);
    work.push(certify('service', 'architecture', () => {
      validateAggregateDomain('service', 'architecture', input.service!.llmRules);
      const planned = mode === 'lifecycle'
        ? planServiceViolationWork(input.service!, 'lifecycle', execution)
        : planServiceViolationWork(input.service!, 'normal', execution);
      return Object.freeze({
        family: 'service' as const,
        domain: 'architecture',
        mode,
        workId: planned.workId,
        inputFingerprint: planned.inputFingerprint,
        planned,
      });
    }));
  }

  if (input.module) {
    const mode = modeFor(input.module.existingViolations);
    work.push(certify('module', 'architecture', () => {
      validateAggregateDomain('module', 'architecture', input.module!.llmRules);
      const planned = mode === 'lifecycle'
        ? planModuleViolationWork(input.module!, 'lifecycle', execution)
        : planModuleViolationWork(input.module!, 'normal', execution);
      return Object.freeze({
        family: 'module' as const,
        domain: 'architecture',
        mode,
        workId: planned.workId,
        inputFingerprint: planned.inputFingerprint,
        planned,
      });
    }));
  }

  if (work.length === 0) {
    throw new AnalyzeLlmPlanError('invalid-context', 'Analyze LLM plan contains no eligible work');
  }
  work.sort((left, right) => Buffer.from(left.workId).compare(Buffer.from(right.workId)));
  if (new Set(work.map((item) => item.workId)).size !== work.length) {
    throw new AnalyzeLlmPlanError('duplicate-work-id', 'Analyze LLM plan contains duplicate work IDs');
  }

  const manifest = Object.freeze({
    version: 1 as const,
    work: Object.freeze(work.map((item) => Object.freeze({
      family: item.family,
      domain: item.domain,
      mode: item.mode,
      workId: item.workId,
      inputFingerprint: item.inputFingerprint,
    }))),
  });
  const certifiedWork = Object.freeze([...work]);
  let executed = false;

  return Object.freeze({
    manifest,
    inspectResumeCompatibility: async (identity: AnalyzeLlmResumeIdentity) =>
      (await inspectResumePlan(identity)).compatibility,
    async activateResume(identity: AnalyzeLlmResumeIdentity, activatedAt: string) {
      const inspection = await inspectResumePlan(identity);
      const compatibility = inspection.compatibility;
      if (!compatibility.compatible) {
        return Object.freeze({ activated: false as const, reason: compatibility.reason });
      }
      if (!resumeExecutionMatches(adapter, execution, compatibility.observed.resolvedModel)) {
        return Object.freeze({
          activated: false as const,
          reason: 'activated-execution-changed' as const,
        });
      }
      const activated = await activateAnalyzeRunResume(journalKey, certifyAnalyzeRunResumeActivation({
        kind: 'activate-resume',
        runId,
        ...identity,
        activatedAt: inspection.durableActivatedAt ?? activatedAt,
        work: manifest.work.map(({ workId, inputFingerprint }) => ({
          workId,
          inputFingerprint,
        })),
        reusedWorkIds: compatibility.reusedWorkIds,
        pendingWorkIds: compatibility.pendingWorkIds,
        executionPin: {
          provider: execution.provider,
          requestedModel: execution.requestedModel,
          resolvedModel: compatibility.observed.resolvedModel,
        },
        observed: {
          runRevision: compatibility.observed.runRevision,
          attemptSequence: compatibility.observed.attemptSequence,
          latestAttemptSequence: compatibility.observed.latestAttemptSequence,
          completedBaselineFingerprint: compatibility.observed.completedBaselineFingerprint,
        },
      }));
      return Object.freeze({
        activated: true as const,
        view: activated.view,
        counts: compatibility.counts,
        activation: activated.activation,
      });
    },
    async execute(
      activation: AnalyzeRunPlanActivation,
      observer?: AnalyzeLlmWorkProgressObserver,
    ) {
      if (executed) {
        throw new AnalyzeLlmPlanError('already-executed', 'Certified analyze LLM run already executed');
      }
      const admission = await admitAnalyzeRunPlanExecution(
        activation,
        journalKey,
        runId,
        manifest.work,
        () => {
          assertExecutionMatches(execution, adapter.execution);
        },
        (checkpointWriter) => {
          executed = true;
          return executeCertifiedWork(observer, checkpointWriter);
        },
      );
      if (!admission.admitted) {
        throw new AnalyzeLlmPlanError(
          'plan-not-activated',
          'Certified analyze LLM plan was not durably activated for this run',
        );
      }

      const completed = await admission.execution;
      return Object.freeze({
        results: completed.result,
        completion: certifyAnalyzeRunExecutionCompletion(completed.certification),
      });
    },
  });

  async function inspectResumePlan(
    identity: AnalyzeLlmResumeIdentity,
  ): Promise<AnalyzeLlmResumeInspection> {
    const candidate = await readAnalyzeRunResumeCandidate(journalKey, runId);
    if (!candidate) return incompatibleInspection('run-not-found');
    if (!candidate.isLatestAttempt) return incompatibleInspection('not-latest-attempt');
    const recoveringActivated = candidate.state === 'running'
      && candidate.executionAttempt.number > 1
      && candidate.executionAttempt.resume?.admission === 'activated';
    if (
      (
        (candidate.state !== 'blocked' || candidate.blocked === null)
        && !recoveringActivated
      )
      || candidate.plan === 'unsealed'
    ) {
      return incompatibleInspection('run-not-blocked');
    }
    if (!sameResumeIdentity(candidate, identity)) return incompatibleInspection('run-identity-changed');

    const analysisStore = getAnalysisStore();
    const completed = await analysisStore.readLatest(journalKey);
    if (getAnalysisStore() !== analysisStore) {
      return incompatibleInspection('inspection-storage-changed');
    }
    let completedBaselineId: string | null;
    let completedBaselineFingerprint: string | null;
    try {
      completedBaselineId = completed === null ? null : activeCompletedBaselineId(completed);
      completedBaselineFingerprint = completed === null ? null : fingerprint(completed);
    } catch {
      return incompatibleInspection('completed-baseline-invalid');
    }
    if (completedBaselineId !== candidate.completedBaselineId) {
      return incompatibleInspection('completed-baseline-changed');
    }

    let currentExecution: Readonly<LlmWorkExecutionIntent>;
    try {
      currentExecution = validateExecution(adapter.execution);
    } catch {
      return incompatibleInspection('checkpoint-execution-changed');
    }
    if (
      currentExecution.provider !== execution.provider
      || currentExecution.requestedModel !== execution.requestedModel
    ) {
      return incompatibleInspection('checkpoint-execution-changed');
    }
    const resumeExecution = adapter.resumeExecution;
    if (
      !resumeExecution
      || resumeExecution.modelSelection !== 'pinned'
      || resumeExecution.provider !== execution.provider
      || resumeExecution.requestedModel !== execution.requestedModel
      || typeof resumeExecution.resolvedModel !== 'string'
      || resumeExecution.resolvedModel.trim().length === 0
      || resumeExecution.resolvedModel.trim() !== resumeExecution.resolvedModel
    ) {
      return incompatibleInspection('checkpoint-model-unverified');
    }
    const resolvedModel = resumeExecution.resolvedModel;
    if (
      recoveringActivated
      && !isDeepStrictEqual(candidate.executionAttempt.resume?.executionPin, {
        provider: execution.provider,
        requestedModel: execution.requestedModel,
        resolvedModel,
      })
    ) {
      return incompatibleInspection('activated-execution-changed');
    }

    const currentManifest = manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    }));
    const storedManifest = candidate.plan.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    }));
    if (!isDeepStrictEqual(storedManifest, currentManifest)) {
      return incompatibleInspection('work-plan-changed');
    }

    const attempts = new Set<string>();
    const reused: { work: CertifiedAnalyzeLlmWork; result: unknown }[] = [];
    const pending: CertifiedAnalyzeLlmWork[] = [];
    for (let index = 0; index < certifiedWork.length; index += 1) {
      const item = certifiedWork[index]!;
      const stored = candidate.plan.work[index]!;
      if (stored.state === 'pending') {
        pending.push(item);
        continue;
      }
      if (stored.state === 'succeeded-uncheckpointed') {
        return incompatibleInspection('uncheckpointed-success');
      }
      const checkpoint = stored.checkpoint;
      if (
        checkpoint.resultContractId !== item.planned.request.resultContractId
        || checkpoint.resultFingerprint !== fingerprint(checkpoint.result)
      ) {
        return incompatibleInspection('checkpoint-contract-changed');
      }
      if (attempts.has(checkpoint.attemptId)) {
        return incompatibleInspection('duplicate-checkpoint-attempt');
      }
      attempts.add(checkpoint.attemptId);
      const usage = checkpoint.usage;
      if (
        usage === null
        || usage.provider !== execution.provider
        || usage.requestedModel !== execution.requestedModel
        || usage.callType !== item.family
        || usage.totalTokens !== usage.inputTokens + usage.outputTokens
      ) {
        return incompatibleInspection('checkpoint-execution-changed');
      }
      if (
        usage.resolvedModel === null
        || usage.resolvedModel.trim().length === 0
        || usage.resolvedModel !== resolvedModel
      ) {
        return incompatibleInspection('checkpoint-model-unverified');
      }
      let result: unknown;
      try {
        result = item.planned.request.parse(checkpoint.result);
      } catch {
        return incompatibleInspection('checkpoint-result-invalid');
      }
      reused.push(Object.freeze({ work: item, result }));
    }

    const candidateAfter = await readAnalyzeRunResumeCandidate(journalKey, runId);
    if (
      !candidateAfter
      || candidateAfter.storageIdentity !== candidate.storageIdentity
      || candidateAfter.revision !== candidate.revision
      || candidateAfter.attemptSequence !== candidate.attemptSequence
      || candidateAfter.latestAttemptSequence !== candidate.latestAttemptSequence
      || !candidateAfter.isLatestAttempt
    ) {
      return incompatibleInspection('run-changed-during-inspection');
    }
    if (getAnalysisStore() !== analysisStore) {
      return incompatibleInspection('inspection-storage-changed');
    }
    const completedAfter = await analysisStore.readLatest(journalKey);
    if (getAnalysisStore() !== analysisStore) {
      return incompatibleInspection('inspection-storage-changed');
    }
    let completedBaselineFingerprintAfter: string | null;
    try {
      if (completedAfter !== null) activeCompletedBaselineId(completedAfter);
      completedBaselineFingerprintAfter = completedAfter === null
        ? null
        : fingerprint(completedAfter);
    } catch {
      return incompatibleInspection('completed-baseline-invalid');
    }
    if (completedBaselineFingerprintAfter !== completedBaselineFingerprint) {
      return incompatibleInspection('completed-baseline-changed');
    }
    const resetHint = candidate.blocked?.resetHint
      ?? candidate.executionAttempt.resume!.resumedFrom.resetHint;
    const compatibility = Object.freeze({
      compatible: true,
      requiresActivationRevalidation: true,
      resetHint,
      counts: Object.freeze({
        total: certifiedWork.length,
        reused: reused.length,
        pending: pending.length,
      }),
      reusedWorkIds: Object.freeze(reused.map(({ work: item }) => item.workId)),
      pendingWorkIds: Object.freeze(pending.map((item) => item.workId)),
      observed: Object.freeze({
        runRevision: candidate.revision,
        attemptSequence: candidate.attemptSequence,
        latestAttemptSequence: candidate.latestAttemptSequence,
        completedBaselineFingerprint,
        resolvedModel,
      }),
    });
    return Object.freeze({
      compatibility,
      durableActivatedAt: recoveringActivated ? candidate.executionAttempt.activatedAt : null,
    });
  }

  async function executeCertifiedWork(
    observer?: AnalyzeLlmWorkProgressObserver,
    checkpointWriter?: AnalyzeRunCheckpointWriter,
  ): Promise<readonly {
    readonly work: CertifiedAnalyzeLlmWork;
    readonly result: unknown;
  }[]> {
    const settled = await Promise.allSettled(certifiedWork.map(async (item) => {
      let started = false;
      let ok = false;
      let startNotification = Promise.resolve();
      try {
        const outcome = await adapter.execute(item, {
          onStart: () => {
            if (started) return;
            started = true;
            startNotification = notifyProgressObserver(
              'start',
              item,
              () => observer?.onWorkStart?.(item),
            );
          },
        });
        const certified = certifyExecutionOutcome(item, outcome, execution);
        if (!checkpointWriter) {
          throw new AnalyzeLlmPlanError('plan-not-activated', 'Analyze checkpoint writer is missing');
        }
        await checkpointAnalyzeRunWork(certifyAnalyzeRunWorkCheckpoint(checkpointWriter, {
          workId: item.workId,
          inputFingerprint: item.inputFingerprint,
          checkpointedAt: certified.completedAt,
          attemptId: certified.attemptId,
          resultContractId: certified.resultContractId,
          result: certified.result,
          usage: certified.usage,
        }));
        ok = true;
        return { work: item, result: certified.result };
      } finally {
        await startNotification;
        await notifyProgressObserver('done', item, () =>
          observer?.onWorkDone?.(item, Object.freeze({ started, ok })));
      }
    }));
    const rejected = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && isLlmSessionLimitError(result.reason),
    ) ?? settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
    return settled.map((result) =>
      (result as PromiseFulfilledResult<{
        work: CertifiedAnalyzeLlmWork;
        result: unknown;
      }>).value);
  }
}

function incompatible(reason: AnalyzeLlmResumeIncompatibility): AnalyzeLlmResumeCompatibility {
  return Object.freeze({ compatible: false, reason });
}

function incompatibleInspection(
  reason: AnalyzeLlmResumeIncompatibility,
): AnalyzeLlmResumeInspection {
  return Object.freeze({
    compatibility: incompatible(reason),
    durableActivatedAt: null,
  });
}

function resumeExecutionMatches(
  adapter: AnalyzeLlmExecutionAdapter,
  expected: Readonly<LlmWorkExecutionIntent>,
  resolvedModel: string,
): boolean {
  let current: Readonly<LlmWorkExecutionIntent>;
  try {
    current = validateExecution(adapter.execution);
  } catch {
    return false;
  }
  const resume = adapter.resumeExecution;
  return current.provider === expected.provider
    && current.requestedModel === expected.requestedModel
    && resume?.modelSelection === 'pinned'
    && resume.provider === expected.provider
    && resume.requestedModel === expected.requestedModel
    && resume.resolvedModel === resolvedModel;
}

function sameResumeIdentity(
  candidate: Readonly<{
    candidateAnalysisId: string;
    startedAt: string;
    source: AnalyzeRunSource;
    branch: string | null;
    commitHash: string | null;
    completedBaselineId: string | null;
  }>,
  identity: AnalyzeLlmResumeIdentity,
): boolean {
  return isDeepStrictEqual({
    candidateAnalysisId: candidate.candidateAnalysisId,
    startedAt: candidate.startedAt,
    source: candidate.source,
    branch: candidate.branch,
    commitHash: candidate.commitHash,
    completedBaselineId: candidate.completedBaselineId,
  }, {
    candidateAnalysisId: identity.candidateAnalysisId,
    startedAt: identity.startedAt,
    source: identity.source,
    branch: identity.branch,
    commitHash: identity.commitHash,
    completedBaselineId: identity.completedBaselineId,
  });
}

async function notifyProgressObserver(
  event: 'start' | 'done',
  work: CertifiedAnalyzeLlmWork,
  notify: () => void | Promise<void> | undefined,
): Promise<void> {
  try {
    await notify();
  } catch (error) {
    log.warn(
      `[LLM] Analyze work ${event} observer failed for ${work.workId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function certifyExecutionOutcome(
  work: CertifiedAnalyzeLlmWork,
  outcome: AnalyzeLlmExecutionOutcome,
  execution: Readonly<LlmWorkExecutionIntent>,
): AnalyzeLlmExecutionOutcome {
  const matches = (
    outcome !== null &&
    typeof outcome === 'object' &&
    outcome.family === work.family &&
    outcome.domain === work.domain &&
    outcome.mode === work.mode &&
    outcome.workId === work.workId &&
    outcome.inputFingerprint === work.inputFingerprint &&
    outcome.resultContractId === work.planned.request.resultContractId &&
    Object.prototype.hasOwnProperty.call(outcome, 'result') &&
    typeof outcome.attemptId === 'string' &&
    outcome.attemptId.length > 0 &&
    isCanonicalUtcTimestamp(outcome.completedAt)
  );
  if (!matches) {
    throw new AnalyzeLlmPlanError(
      'result-not-certified',
      `Analyze ${work.family} result does not match its certified work identity`,
      work.family,
      work.domain,
    );
  }
  const usage = outcome.usage;
  if (usage !== null && !isValidExecutionUsage(usage, execution, work.family)) {
    throw new AnalyzeLlmPlanError(
      'result-not-certified',
      `Analyze ${work.family} usage does not match its certified execution intent`,
      work.family,
      work.domain,
    );
  }
  let result: unknown;
  try {
    result = work.planned.request.parse(outcome.result);
  } catch (error) {
    throw new AnalyzeLlmPlanError(
      'result-not-certified',
      `Analyze ${work.family} result does not satisfy ${work.planned.request.resultContractId}`,
      work.family,
      work.domain,
      { cause: error },
    );
  }
  return Object.freeze({ ...outcome, result });
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function isValidExecutionUsage(
  value: unknown,
  execution: Readonly<LlmWorkExecutionIntent>,
  family: AnalyzeLlmWorkFamily,
): value is AnalyzeLlmExecutionUsage {
  if (value === null || typeof value !== 'object') return false;
  const usage = value as Record<string, unknown>;
  const integerKeys = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'totalTokens',
    'durationMs',
  ] as const;
  const costUsd = usage.costUsd;
  return usage.provider === execution.provider
    && usage.requestedModel === execution.requestedModel
    && usage.callType === family
    && (usage.resolvedModel === null || (
      typeof usage.resolvedModel === 'string' && usage.resolvedModel.length > 0
    ))
    && integerKeys.every((key) => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)
    && usage.totalTokens === Number(usage.inputTokens) + Number(usage.outputTokens)
    && (costUsd === null || (
      typeof costUsd === 'string'
      && costUsd.trim().length > 0
      && Number.isFinite(Number(costUsd))
      && Number(costUsd) >= 0
    ));
}

function certify<T extends CertifiedAnalyzeLlmWork>(
  family: AnalyzeLlmWorkFamily,
  domain: RuleDomain,
  prepare: () => T,
): T {
  try {
    return prepare();
  } catch (error) {
    if (error instanceof AnalyzeLlmPlanError) throw error;
    throw new AnalyzeLlmPlanError(
      'request-preparation-failed',
      `Could not certify ${family} analyze LLM work: ${error instanceof Error ? error.message : String(error)}`,
      family,
      domain,
      { cause: error },
    );
  }
}

function modeFor(existing: readonly unknown[] | undefined): AnalyzeLlmWorkMode {
  return existing && existing.length > 0 ? 'lifecycle' : 'normal';
}

function validateCodeDomain(domain: RuleDomain, context: CodeViolationContext): void {
  const matches = (
    CODE_DOMAINS.includes(domain) &&
    context.llmRules.length > 0 &&
    context.llmRules.every((rule) => rule.key.slice(0, rule.key.indexOf('/')) === domain)
  );
  if (!matches) {
    throw new AnalyzeLlmPlanError(
      'invalid-context',
      `Analyze code domain ${domain} must match every eligible rule key`,
      'code',
      domain,
    );
  }
}

function validateAggregateDomain(
  family: 'database' | 'service' | 'module',
  domain: 'database' | 'architecture',
  rules: readonly { readonly key: string }[],
): void {
  if (
    rules.length === 0 ||
    !rules.every((rule) => rule.key.startsWith(`${domain}/`))
  ) {
    throw new AnalyzeLlmPlanError(
      'invalid-context',
      `Analyze ${family} work requires at least one ${domain} rule and no cross-domain rules`,
      family,
      domain,
    );
  }
}

function validateExecution(execution: Readonly<LlmWorkExecutionIntent>): Readonly<LlmWorkExecutionIntent> {
  if (
    typeof execution.provider !== 'string' ||
    execution.provider.length === 0 ||
    execution.provider === 'transport:unverified' ||
    (execution.requestedModel !== null && (
      typeof execution.requestedModel !== 'string' || execution.requestedModel.length === 0
    ))
  ) {
    throw new AnalyzeLlmPlanError(
      'provider-not-certifiable',
      'Analyze LLM provider/model intent is not certifiable',
    );
  }
  return Object.freeze({
    provider: execution.provider,
    requestedModel: execution.requestedModel,
  });
}

function validateRunId(runId: string): string {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new AnalyzeLlmPlanError('invalid-context', 'Analyze LLM run ID is required');
  }
  return runId;
}

function validateJournalKey(journalKey: string): string {
  if (typeof journalKey !== 'string' || journalKey.length === 0) {
    throw new AnalyzeLlmPlanError('invalid-context', 'Analyze LLM journal key is required');
  }
  return journalKey;
}

function assertExecutionMatches(
  certified: Readonly<LlmWorkExecutionIntent>,
  current: Readonly<LlmWorkExecutionIntent>,
): void {
  validateExecution(current);
  if (
    current.provider !== certified.provider ||
    current.requestedModel !== certified.requestedModel
  ) {
    throw new AnalyzeLlmPlanError(
      'provider-not-certifiable',
      'Analyze LLM execution intent changed after certification',
    );
  }
}
