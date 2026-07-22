import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmSessionLimitError } from '@truecourse/shared/llm';
import {
  clearLatestCache,
  buildAnalysisFilename,
  getAnalysisStore,
  latestPath,
  resetAnalysisStore,
  setAnalysisStore,
  writeLatest,
} from '../../packages/core/src/lib/analysis-store.js';
import {
  type AnalyzeRunStorage,
  type StoredAnalyzeRun,
  admitAnalyzeRunResumeExecution,
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
  setAnalyzeRunStorage,
} from '../../packages/core/src/lib/analyze-run-journal.js';
import {
  certifyAnalyzeLlmRun,
  type AnalyzeLlmExecutionAdapter,
  type AnalyzeLlmExecutionOutcome,
  type AnalyzeLlmResumeIdentity,
  type CertifiedAnalyzeLlmWork,
} from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import type {
  CodeViolationContext,
  DatabaseViolationContext,
  ServiceViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import type { LatestSnapshot } from '../../packages/core/src/types/snapshot.js';
import { fingerprint } from '../../packages/core/src/lib/canonical-json.js';
import type { AnalyzeRunAmbiguousRearmOffer } from '../../packages/core/src/lib/analyze-run-ambiguous-rearm.js';

const resolvedModel = 'claude-sonnet-4-5-20250929';
const runId = 'resume-eligibility';

const rule = {
  key: 'bugs/llm/resume',
  name: 'Resume fixture',
  severity: 'medium',
  prompt: 'Find the resumability issue.',
};

const codeContext: CodeViolationContext = {
  files: [{ path: 'context', content: '1: export const resume = true;' }],
  sourceScopes: [{ path: '/repo/src/resume.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }],
  sources: [{
    path: '/repo/src/resume.ts',
    selection: {
      kind: 'targeted',
      functions: [{ name: 'resume', startLine: 1, endLine: 1 }],
    },
  }],
  llmRules: [rule],
  tier: 'targeted',
  existingViolations: [{
    id: 'prior-runtime-id',
    filePath: '/repo/src/resume.ts',
    lineStart: 1,
    lineEnd: 1,
    ruleKey: rule.key,
    severity: 'medium',
    title: 'Prior resumability issue',
    content: 'The prior finding remains active.',
  }],
};

const databaseContext: DatabaseViolationContext = {
  databases: [{
    id: 'runtime-db-1',
    name: 'app',
    type: 'postgresql',
    driver: 'pg',
    tableCount: 1,
    connectedServices: ['api'],
    tables: [{ name: 'users', columns: [{ name: 'id', type: 'uuid', isPrimaryKey: true }] }],
    relations: [],
  }],
  llmRules: [{ ...rule, key: 'database/llm/resume' }],
};

const identity: AnalyzeLlmResumeIdentity = {
  candidateAnalysisId: 'candidate-resume',
  startedAt: '2026-07-19T02:00:00.000Z',
  source: 'cli',
  branch: 'main',
  commitHash: 'resume-commit',
  completedBaselineId: 'completed-baseline',
};

let repoPath: string;

beforeEach(async () => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-certified-resume-'));
  resetAnalyzeRunStorage();
  resetAnalysisStore();
  clearLatestCache();
  await writeLatest(repoPath, latest('completed-baseline'));
});

afterEach(() => {
  resetAnalyzeRunStorage();
  resetAnalysisStore();
  clearLatestCache();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe('certified analyze resume eligibility', () => {
  it('reports a missing or non-blocked attempt without provider work', async () => {
    const { rebuilt, calls } = rebuiltRun();
    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'run-not-found' });

    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId,
      candidateAnalysisId: identity.candidateAnalysisId,
      startedAt: identity.startedAt,
      source: identity.source,
      branch: identity.branch,
      commitHash: identity.commitHash,
      completedBaselineId: identity.completedBaselineId,
    });
    const activationPlan = certifyAnalyzeLlmRun(planInput(), {
      execution: { provider: 'claude-code', requestedModel: 'sonnet' },
      async execute(work) { return successfulOutcome(work); },
    });
    await sealAnalyzeRunPlan(repoPath, {
      kind: 'seal-plan',
      execution: { provider: 'claude-code', requestedModel: 'sonnet' },
      runId,
      sealedAt: '2026-07-19T02:00:01.000Z',
      work: activationPlan.manifest.work.map(({ workId, inputFingerprint }) => ({
        workId,
        inputFingerprint,
      })),
    });
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'run-not-blocked' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('reuses only exact parsed checkpoints and leaves the blocked journal unchanged', async () => {
    const original = await createBlockedRun();
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    const compatibility = await rebuilt.inspectResumeCompatibility(identity);

    expect(compatibility).toEqual({
      compatible: true,
      requiresActivationRevalidation: true,
      resetHint: '7pm',
      counts: { total: 2, reused: 1, pending: 1 },
      reusedWorkIds: [original.codeWorkId],
      pendingWorkIds: [original.databaseWorkId],
      observed: {
        runRevision: 4,
        attemptSequence: 1,
        latestAttemptSequence: 1,
        completedBaselineFingerprint: fingerprint(latest('completed-baseline')),
        modelSelection: 'resolved',
        resolvedModel,
      },
    });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);

    resetAnalyzeRunStorage();
    await expect(rebuilt.inspectResumeCompatibility(identity)).resolves.toMatchObject({
      compatible: true,
      counts: { total: 2, reused: 1, pending: 1 },
    });
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('certifies and recovers durable activation without calling the provider', async () => {
    await createBlockedRun();
    const { rebuilt, calls } = rebuiltRun();
    const completedPath = latestPath(repoPath);
    const pointerPath = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'LATEST_ATTEMPT.json',
    );
    const completedBefore = fs.readFileSync(completedPath);
    const pointerBefore = fs.readFileSync(pointerPath);

    const activated = await rebuilt.activateResume(identity, '2026-07-19T04:00:04+02:00');

    expect(activated).toMatchObject({
      activated: true,
      counts: { total: 2, reused: 1, pending: 1 },
      view: {
        revision: 5,
        state: 'running',
        updatedAt: '2026-07-19T02:00:04.000Z',
        executionAttempt: {
          number: 2,
          activatedAt: '2026-07-19T02:00:04.000Z',
          resume: {
            admission: 'activated',
            admittedAt: null,
            resumedFrom: { resetHint: '7pm', blockedAt: '2026-07-19T02:00:03.000Z' },
            executionPin: {
              provider: 'claude-code',
              requestedModel: 'sonnet',
              modelSelection: 'resolved',
              resolvedModel,
            },
          },
        },
      },
    });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(completedPath)).toEqual(completedBefore);
    expect(fs.readFileSync(pointerPath)).toEqual(pointerBefore);

    const activatedBytes = fs.readFileSync(runFile());
    resetAnalyzeRunStorage();
    const recovered = rebuiltRun();
    await expect(recovered.rebuilt.inspectResumeCompatibility(identity)).resolves.toMatchObject({
      compatible: true,
      counts: { total: 2, reused: 1, pending: 1 },
    });
    await expect(recovered.rebuilt.activateResume(identity, '2026-07-19T03:00:00.000Z'))
      .resolves.toMatchObject({ activated: true, view: { revision: 5 } });
    expect(recovered.calls()).toBe(0);
    expect(fs.readFileSync(runFile())).toEqual(activatedBytes);
  });

  it('does not activate when provider intent changes after compatibility inspection', async () => {
    await createBlockedRun();
    let executionReads = 0;
    let providerCalls = 0;
    const adapter: AnalyzeLlmExecutionAdapter = {
      get execution() {
        executionReads += 1;
        return executionReads < 3
          ? { provider: 'claude-code', requestedModel: 'sonnet' }
          : { provider: 'claude-code', requestedModel: 'opus' };
      },
      resumeExecution: pinnedResumeExecution(),
      async execute(work) {
        providerCalls += 1;
        return successfulOutcome(work);
      },
    };
    const rebuilt = certifyAnalyzeLlmRun(planInput(), adapter);
    const before = fs.readFileSync(runFile());

    await expect(rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z'))
      .resolves.toEqual({ activated: false, reason: 'activated-execution-changed' });
    expect(providerCalls).toBe(0);
    expect(fs.readFileSync(runFile())).toEqual(before);
  });

  it('durably admits resumed execution before invoking pending work', async () => {
    await createBlockedRun();
    const { rebuilt } = rebuiltRun();
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    expect(activated.activated).toBe(true);
    if (!activated.activated) throw new Error('Expected resume activation');
    let validationCalls = 0;
    let admittedCallbacks = 0;

    const admission = await admitAnalyzeRunResumeExecution(
      activated.activation,
      repoPath,
      runId,
      rebuilt.manifest.work,
      activated.view.counts!.pending === 1
        ? [rebuilt.manifest.work.find((work) => work.family === 'database')!.workId]
        : [],
      {
        provider: 'claude-code',
        requestedModel: 'sonnet',
        modelSelection: 'resolved',
        resolvedModel,
      },
      '2026-07-19T04:00:05+02:00',
      () => { validationCalls += 1; },
      async () => {
        admittedCallbacks += 1;
        return [];
      },
    );

    expect(admission.admitted).toBe(true);
    if (!admission.admitted) throw new Error('Expected resume admission');
    expect(validationCalls).toBe(2);
    expect(admittedCallbacks).toBe(1);
    await expect(admission.execution).rejects.toThrow(/did not durably checkpoint every resumed result/);
    resetAnalyzeRunStorage();
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      revision: 6,
      state: 'running',
      updatedAt: '2026-07-19T02:00:05.000Z',
      executionAttempt: {
        number: 2,
        resume: { admission: 'executing', admittedAt: '2026-07-19T02:00:05.000Z' },
      },
    });
  });

  it.each([
    ['legacy-unbound marker', { state: 'legacy-unbound' }],
    ['different provider', { provider: 'other-provider', requestedModel: 'sonnet' }],
    ['different requested model', { provider: 'claude-code', requestedModel: 'opus' }],
  ])('does not admit resumed provider work after the sealed execution changes to a %s', async (
    _case,
    execution,
  ) => {
    await createBlockedRun();
    const { rebuilt } = rebuiltRun();
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    if (!activated.activated) throw new Error('Expected resume activation');
    const stored = readStoredRun();
    stored.plan.execution = execution;
    writeStoredRun(stored);
    let providerCalls = 0;
    const pendingWorkIds = [
      rebuilt.manifest.work.find((work) => work.family === 'database')!.workId,
    ];

    await expect(admitAnalyzeRunResumeExecution(
      activated.activation,
      repoPath,
      runId,
      rebuilt.manifest.work,
      pendingWorkIds,
      {
        provider: 'claude-code',
        requestedModel: 'sonnet',
        modelSelection: 'resolved',
        resolvedModel,
      },
      '2026-07-19T02:00:05.000Z',
      () => undefined,
      async () => {
        providerCalls += 1;
        return [];
      },
    )).resolves.toEqual({ admitted: false });
    expect(providerCalls).toBe(0);
  });

  it('revalidates sealed execution after the resumed admission write', async () => {
    let stored: StoredAnalyzeRun | null = null;
    const storage: AnalyzeRunStorage = {
      async createLatest(_repoKey, run) {
        stored = { ...run, attemptSequence: 1 };
        return stored;
      },
      async read(_repoKey, receivedRunId) {
        return stored?.runId === receivedRunId ? stored : null;
      },
      async readLatest() { return stored; },
      async inspectLatest() { return stored; },
      async compareAndSwap(_repoKey, _runId, expectedRevision, next) {
        expect(stored).toMatchObject({ revision: expectedRevision });
        stored = next;
      },
      async compareAndSwapLatest(_repoKey, _runId, expectedRevision, _attempt, _latest, next) {
        expect(stored).toMatchObject({ revision: expectedRevision });
        stored = next.plan.state === 'sealed'
          && next.executionAttempt.resume?.admission === 'executing'
          ? {
              ...next,
              plan: {
                ...next.plan,
                execution: { provider: 'other-provider', requestedModel: 'sonnet' },
              },
            }
          : next;
      },
    };
    setAnalyzeRunStorage(storage);
    await createBlockedRun();
    const { rebuilt } = rebuiltRun();
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    if (!activated.activated) throw new Error('Expected resume activation');
    let providerCalls = 0;
    const pendingWorkIds = [
      rebuilt.manifest.work.find((work) => work.family === 'database')!.workId,
    ];

    await expect(admitAnalyzeRunResumeExecution(
      activated.activation,
      repoPath,
      runId,
      rebuilt.manifest.work,
      pendingWorkIds,
      {
        provider: 'claude-code',
        requestedModel: 'sonnet',
        modelSelection: 'resolved',
        resolvedModel,
      },
      '2026-07-19T02:00:05.000Z',
      () => undefined,
      async () => {
        providerCalls += 1;
        return [];
      },
    )).rejects.toThrow(/sealed execution changed during resume admission/);
    expect(providerCalls).toBe(0);
    expect(stored).toMatchObject({
      plan: { execution: { provider: 'other-provider' } },
      executionAttempt: { resume: { admission: 'executing' } },
    });
  });

  it('leaves a conservative tombstone and makes zero calls when the post-CAS pin check fails', async () => {
    await createBlockedRun();
    const { rebuilt } = rebuiltRun();
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    if (!activated.activated) throw new Error('Expected resume activation');
    let validationCalls = 0;
    let admittedCallbacks = 0;
    const pendingWorkIds = [
      rebuilt.manifest.work.find((work) => work.family === 'database')!.workId,
    ];
    const pin = {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      modelSelection: 'resolved' as const,
      resolvedModel,
    };

    await expect(admitAnalyzeRunResumeExecution(
      activated.activation,
      repoPath,
      runId,
      rebuilt.manifest.work,
      pendingWorkIds,
      pin,
      '2026-07-19T02:00:05.000Z',
      () => {
        validationCalls += 1;
        if (validationCalls === 2) throw new Error('resume pin drifted');
      },
      async () => {
        admittedCallbacks += 1;
        return [];
      },
    )).rejects.toThrow('resume pin drifted');
    expect(validationCalls).toBe(2);
    expect(admittedCallbacks).toBe(0);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      revision: 6,
      executionAttempt: { resume: { admission: 'executing' } },
    });
    resetAnalyzeRunStorage();
    await expect(rebuiltRun().rebuilt.inspectResumeCompatibility(identity)).resolves.toEqual({
      compatible: false,
      reason: 'resume-execution-ambiguous',
    });
    await expect(admitAnalyzeRunResumeExecution(
      activated.activation,
      repoPath,
      runId,
      rebuilt.manifest.work,
      pendingWorkIds,
      pin,
      '2026-07-19T02:00:06.000Z',
      () => undefined,
      async () => [],
    )).resolves.toEqual({ admitted: false });
  });

  it('restarts a zero-checkpoint run once, then pins the concrete model for remaining work', async () => {
    await createZeroCheckpointBlockedRun();
    const requestedCalls: string[] = [];
    const pinnedCalls: string[] = [];
    const pinnedModels: string[] = [];
    const execution = Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' });
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution,
      createPinnedResumeAdapter(model) {
        pinnedModels.push(model);
        return {
          execution,
          resumeExecution: pinnedResumeExecution(model),
          async execute(work) {
            pinnedCalls.push(work.workId);
            return {
              ...successfulOutcome(work),
              completedAt: '2026-07-19T02:00:07.000Z',
            };
          },
        };
      },
      async execute(work) {
        requestedCalls.push(work.workId);
        return {
          ...successfulOutcome(work),
          completedAt: '2026-07-19T02:00:06.000Z',
        };
      },
    };
    const rebuilt = certifyAnalyzeLlmRun(planInput(), adapter);

    await expect(rebuilt.inspectResumeCompatibility(identity)).resolves.toMatchObject({
      compatible: true,
      counts: { total: 2, reused: 0, pending: 2 },
      observed: { modelSelection: 'requested', resolvedModel: null },
    });
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    expect(activated).toMatchObject({
      activated: true,
      view: {
        executionAttempt: {
          resume: {
            executionPin: { modelSelection: 'requested', resolvedModel: null },
          },
        },
      },
    });
    if (!activated.activated) throw new Error('Expected zero-checkpoint activation');

    const completed = await rebuilt.executeResume(
      activated.activation,
      '2026-07-19T02:00:05.000Z',
    );

    expect(requestedCalls).toHaveLength(1);
    expect(pinnedCalls).toHaveLength(1);
    expect(pinnedModels).toEqual([resolvedModel]);
    expect(new Set([...requestedCalls, ...pinnedCalls])).toEqual(
      new Set(rebuilt.manifest.work.map((work) => work.workId)),
    );
    expect(completed.results).toHaveLength(2);
    expect(completed.usageLedger).toHaveLength(2);
    expect(completed.usageLedger.every((entry) => entry.usage.resolvedModel === resolvedModel))
      .toBe(true);

    resetAnalyzeRunStorage();
    let recoveryCalls = 0;
    const recovered = certifyAnalyzeLlmRun(planInput(), {
      execution,
      createPinnedResumeAdapter(model) {
        return {
          execution,
          resumeExecution: pinnedResumeExecution(model),
          async execute(work) {
            recoveryCalls += 1;
            return successfulOutcome(work);
          },
        };
      },
      async execute(work) {
        recoveryCalls += 1;
        return successfulOutcome(work);
      },
    });
    await expect(recovered.inspectResumeCompatibility(identity)).resolves.toMatchObject({
      compatible: true,
      counts: { total: 2, reused: 2, pending: 0 },
      observed: { modelSelection: 'requested', resolvedModel: null },
    });
    const recoveryActivation = await recovered.activateResume(
      identity,
      '2026-07-19T02:00:04.000Z',
    );
    if (!recoveryActivation.activated) throw new Error('Expected final-checkpoint recovery');
    await expect(recovered.executeResume(
      recoveryActivation.activation,
      '2026-07-19T02:00:05.000Z',
    )).resolves.toMatchObject({ results: expect.any(Array), usageLedger: expect.any(Array) });
    expect(recoveryCalls).toBe(0);
  });

  it('preserves ordinary zero-checkpoint Resume when the provider chooses the model', async () => {
    await createZeroCheckpointBlockedRun(null);
    const execution = Object.freeze({ provider: 'claude-code', requestedModel: null });
    let requestedCalls = 0;
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution,
      createPinnedResumeAdapter(model) {
        return {
          execution,
          resumeExecution: Object.freeze({
            ...execution,
            modelSelection: 'pinned' as const,
            resolvedModel: model,
          }),
          async execute(work) {
            return {
              ...successfulOutcomeForRequestedModel(work, null),
              completedAt: '2026-07-19T02:00:07.000Z',
            };
          },
        };
      },
      async execute(work) {
        requestedCalls += 1;
        return {
          ...successfulOutcomeForRequestedModel(work, null),
          completedAt: '2026-07-19T02:00:06.000Z',
        };
      },
    };
    const rebuilt = certifyAnalyzeLlmRun(planInput(), adapter);

    await expect(rebuilt.inspectResumeCompatibility(identity)).resolves.toMatchObject({
      compatible: true,
      observed: { modelSelection: 'requested', resolvedModel: null },
    });
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    if (!activated.activated) throw new Error('Expected provider-selected-model activation');
    await expect(rebuilt.executeResume(
      activated.activation,
      '2026-07-19T02:00:05.000Z',
    )).resolves.toMatchObject({ results: expect.any(Array), usageLedger: expect.any(Array) });
    expect(requestedCalls).toBe(1);
  });

  it.each([
    ['provider', { provider: 'other-provider', requestedModel: 'sonnet' }],
    ['requested model', { provider: 'claude-code', requestedModel: 'opus' }],
  ])('rejects a changed %s before restarting a zero-checkpoint run', async (_label, execution) => {
    await createZeroCheckpointBlockedRun();
    let providerCalls = 0;
    const rebuilt = certifyAnalyzeLlmRun(planInput(), {
      execution,
      async execute(work) {
        providerCalls += 1;
        return successfulOutcome(work);
      },
    });
    const before = fs.readFileSync(runFile());

    await expect(rebuilt.inspectResumeCompatibility(identity)).resolves.toEqual({
      compatible: false,
      reason: 'checkpoint-execution-changed',
    });
    expect(providerCalls).toBe(0);
    expect(fs.readFileSync(runFile())).toEqual(before);
  });

  it('does not resume a legacy zero-checkpoint plan without bound execution intent', async () => {
    await createZeroCheckpointBlockedRun();
    const stored = readStoredRun();
    stored.schemaVersion = 6;
    delete stored.plan.execution;
    delete stored.executionAttempt.initialAdmission;
    writeStoredRun(stored);
    resetAnalyzeRunStorage();
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile());

    await expect(rebuilt.inspectResumeCompatibility(identity)).resolves.toEqual({
      compatible: false,
      reason: 'checkpoint-execution-changed',
    });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile())).toEqual(before);
  });

  it('does not checkpoint a zero-checkpoint bootstrap result without concrete model evidence', async () => {
    await createZeroCheckpointBlockedRun();
    const execution = Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' });
    const rebuilt = certifyAnalyzeLlmRun(planInput(), {
      execution,
      createPinnedResumeAdapter() {
        throw new Error('must not pin an unproven model');
      },
      async execute(work) {
        const outcome = successfulOutcome(work);
        return {
          ...outcome,
          completedAt: '2026-07-19T02:00:06.000Z',
          usage: { ...outcome.usage!, resolvedModel: null },
        };
      },
    });
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    if (!activated.activated) throw new Error('Expected zero-checkpoint activation');

    await expect(rebuilt.executeResume(
      activated.activation,
      '2026-07-19T02:00:05.000Z',
    )).rejects.toThrow(/does not establish a concrete resume model/);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      counts: { total: 2, pending: 2, succeeded: 0 },
    });
  });

  it('can block and retry when the zero-checkpoint bootstrap hits the session limit again', async () => {
    await createZeroCheckpointBlockedRun();
    const execution = Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' });
    const sessionLimit = new LlmSessionLimitError('8pm');
    const limited = certifyAnalyzeLlmRun(planInput(), {
      execution,
      createPinnedResumeAdapter: () => { throw new Error('no model was established'); },
      async execute() { throw sessionLimit; },
    });
    const activated = await limited.activateResume(identity, '2026-07-19T02:00:04.000Z');
    if (!activated.activated) throw new Error('Expected zero-checkpoint activation');
    await expect(limited.executeResume(
      activated.activation,
      '2026-07-19T02:00:05.000Z',
    )).rejects.toBe(sessionLimit);
    await dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId,
      blockedAt: '2026-07-19T02:00:06.000Z',
      resetHint: '8pm',
    });

    resetAnalyzeRunStorage();
    let calls = 0;
    const retry = certifyAnalyzeLlmRun(planInput(), {
      execution,
      createPinnedResumeAdapter(model) {
        return {
          execution,
          resumeExecution: pinnedResumeExecution(model),
          async execute(work) {
            calls += 1;
            return successfulOutcome(work);
          },
        };
      },
      async execute(work) {
        calls += 1;
        return successfulOutcome(work);
      },
    });
    await expect(retry.inspectResumeCompatibility(identity)).resolves.toMatchObject({
      compatible: true,
      resetHint: '8pm',
      counts: { reused: 0, pending: 2 },
      observed: { modelSelection: 'requested', resolvedModel: null },
    });
    expect(calls).toBe(0);
  });

  it('resumes with the derived exact pin when a later bootstrap call hits the limit', async () => {
    await createZeroCheckpointBlockedRun();
    const execution = Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' });
    const laterLimit = new LlmSessionLimitError('8pm');
    const firstAttempt = certifyAnalyzeLlmRun(planInput(), {
      execution,
      createPinnedResumeAdapter(model) {
        return {
          execution,
          resumeExecution: pinnedResumeExecution(model),
          async execute() { throw laterLimit; },
        };
      },
      async execute(work) {
        return {
          ...successfulOutcome(work),
          completedAt: '2026-07-19T02:00:06.000Z',
        };
      },
    });
    const firstActivation = await firstAttempt.activateResume(
      identity,
      '2026-07-19T02:00:04.000Z',
    );
    if (!firstActivation.activated) throw new Error('Expected zero-checkpoint activation');
    await expect(firstAttempt.executeResume(
      firstActivation.activation,
      '2026-07-19T02:00:05.000Z',
    )).rejects.toBe(laterLimit);
    await dispatchAnalyzeRun(repoPath, {
      kind: 'block',
      runId,
      blockedAt: '2026-07-19T02:00:07.000Z',
      resetHint: '8pm',
    });
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      counts: { total: 2, succeeded: 1, pending: 1 },
      executionAttempt: {
        resume: { executionPin: { modelSelection: 'requested', resolvedModel: null } },
      },
    });

    resetAnalyzeRunStorage();
    let requestedCalls = 0;
    let pinnedCalls = 0;
    const factoryModels: string[] = [];
    const retry = certifyAnalyzeLlmRun(planInput(), {
      execution,
      createPinnedResumeAdapter(model) {
        factoryModels.push(model);
        return {
          execution,
          resumeExecution: pinnedResumeExecution(model),
          async execute(work) {
            pinnedCalls += 1;
            return {
              ...successfulOutcome(work),
              completedAt: '2026-07-19T02:00:10.000Z',
            };
          },
        };
      },
      async execute(work) {
        requestedCalls += 1;
        return successfulOutcome(work);
      },
    });
    await expect(retry.inspectResumeCompatibility(identity)).resolves.toMatchObject({
      compatible: true,
      counts: { total: 2, reused: 1, pending: 1 },
      observed: { modelSelection: 'resolved', resolvedModel },
    });
    const retryActivation = await retry.activateResume(identity, '2026-07-19T02:00:08.000Z');
    expect(retryActivation).toMatchObject({
      activated: true,
      view: {
        executionAttempt: {
          number: 3,
          resume: { executionPin: { modelSelection: 'resolved', resolvedModel } },
        },
      },
    });
    if (!retryActivation.activated) throw new Error('Expected exact-pin retry activation');
    await expect(retry.executeResume(
      retryActivation.activation,
      '2026-07-19T02:00:09.000Z',
    )).resolves.toMatchObject({
      results: expect.any(Array),
      usageLedger: expect.any(Array),
    });
    expect(factoryModels).toEqual([resolvedModel, resolvedModel]);
    expect(requestedCalls).toBe(0);
    expect(pinnedCalls).toBe(1);
  });

  it('executes only pending work and returns checkpointed results in certified plan order', async () => {
    const original = await createBlockedRun();
    const { rebuilt, calls } = rebuiltRun();
    const completedBefore = fs.readFileSync(latestPath(repoPath));
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    if (!activated.activated) throw new Error('Expected resume activation');

    const resumed = await rebuilt.executeResume(
      activated.activation,
      '2026-07-19T02:00:05.000Z',
    );

    expect(calls()).toBe(1);
    expect(resumed.results.map(({ work }) => work.workId)).toEqual(
      rebuilt.manifest.work.map(({ workId }) => workId),
    );
    expect(resumed.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ work: expect.objectContaining({ workId: original.codeWorkId }) }),
      expect.objectContaining({ work: expect.objectContaining({ workId: original.databaseWorkId }) }),
    ]));
    expect(resumed.completion).toEqual(expect.any(Object));
    expect(resumed.usageLedger.map(({ workId, checkpointedAt, attemptId }) => ({
      workId,
      checkpointedAt,
      attemptId,
    }))).toEqual([
      {
        workId: rebuilt.manifest.work[0]!.workId,
        checkpointedAt: rebuilt.manifest.work[0]!.workId === original.codeWorkId
          ? '2026-07-19T02:00:02.000Z'
          : '2026-07-19T02:00:06.000Z',
        attemptId: `resume:${rebuilt.manifest.work[0]!.workId}`,
      },
      {
        workId: rebuilt.manifest.work[1]!.workId,
        checkpointedAt: rebuilt.manifest.work[1]!.workId === original.codeWorkId
          ? '2026-07-19T02:00:02.000Z'
          : '2026-07-19T02:00:06.000Z',
        attemptId: `resume:${rebuilt.manifest.work[1]!.workId}`,
      },
    ]);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      revision: 7,
      state: 'running',
      counts: { total: 2, pending: 0, succeeded: 2 },
      executionAttempt: { number: 2, resume: { admission: 'executing' } },
    });
    expect(fs.readFileSync(latestPath(repoPath))).toEqual(completedBefore);
  });

  it('finishes an all-checkpointed blocked run without another provider call', async () => {
    await createBlockedRun({ databaseSucceeds: true });
    const { rebuilt, calls } = rebuiltRun();
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    if (!activated.activated) throw new Error('Expected resume activation');
    expect(activated.counts).toEqual({ total: 2, reused: 2, pending: 0 });

    await expect(rebuilt.executeResume(
      activated.activation,
      '2026-07-19T02:00:05.000Z',
    )).resolves.toMatchObject({ results: expect.any(Array), completion: expect.any(Object) });
    expect(calls()).toBe(0);
  });

  it('recovers after the final resumed checkpoint without repeating provider work', async () => {
    await createBlockedRun();
    const first = rebuiltRun();
    const firstActivation = await first.rebuilt.activateResume(
      identity,
      '2026-07-19T02:00:04.000Z',
    );
    if (!firstActivation.activated) throw new Error('Expected resume activation');
    await first.rebuilt.executeResume(
      firstActivation.activation,
      '2026-07-19T02:00:05.000Z',
    );
    expect(first.calls()).toBe(1);
    const completedCheckpointBytes = fs.readFileSync(runFile());

    resetAnalyzeRunStorage();
    const recovered = rebuiltRun();
    const recoveredActivation = await recovered.rebuilt.activateResume(
      identity,
      '2026-07-19T03:00:00.000Z',
    );
    expect(recoveredActivation).toMatchObject({
      activated: true,
      counts: { total: 2, reused: 2, pending: 0 },
      view: { revision: 7 },
    });
    if (!recoveredActivation.activated) throw new Error('Expected recovered activation');
    await expect(recovered.rebuilt.executeResume(
      recoveredActivation.activation,
      '2026-07-19T03:00:01.000Z',
    )).resolves.toMatchObject({ results: expect.any(Array), completion: expect.any(Object) });
    expect(recovered.calls()).toBe(0);
    expect(fs.readFileSync(runFile())).toEqual(completedCheckpointBytes);
  });

  it('rejects a pending result that does not prove the activated concrete model', async () => {
    await createBlockedRun();
    let providerCalls = 0;
    const adapter: AnalyzeLlmExecutionAdapter = {
      execution: { provider: 'claude-code', requestedModel: 'sonnet' },
      resumeExecution: pinnedResumeExecution(),
      async execute(work) {
        providerCalls += 1;
        const outcome = successfulOutcome(work);
        return {
          ...outcome,
          usage: outcome.usage && { ...outcome.usage, resolvedModel: 'claude-sonnet-other' },
        };
      },
    };
    const rebuilt = certifyAnalyzeLlmRun(planInput(), adapter);
    const activated = await rebuilt.activateResume(identity, '2026-07-19T02:00:04.000Z');
    if (!activated.activated) throw new Error('Expected resume activation');

    await expect(rebuilt.executeResume(
      activated.activation,
      '2026-07-19T02:00:05.000Z',
    )).rejects.toMatchObject({ code: 'result-not-certified' });
    expect(providerCalls).toBe(1);
    await expect(readAnalyzeRun(repoPath, { runId })).resolves.toMatchObject({
      revision: 6,
      counts: { pending: 1, succeeded: 1 },
    });
  });

  it.each([
    ['candidateAnalysisId', 'other-candidate'],
    ['startedAt', '2026-07-19T02:00:00.001Z'],
    ['source', 'dashboard'],
    ['branch', 'feature/resume'],
    ['commitHash', 'other-commit'],
    ['completedBaselineId', 'other-baseline'],
  ] as const)('rejects changed run identity field %s without provider work', async (field, value) => {
    await createBlockedRun();
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility({ ...identity, [field]: value }))
      .resolves.toEqual({ compatible: false, reason: 'run-identity-changed' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('rejects a changed run-wide analysis-input fingerprint for aggregate work', async () => {
    await createBlockedArchitectureRun('sha256:analysis-input-a');
    let providerCalls = 0;
    const rebuilt = certifyAnalyzeLlmRun(architecturePlanInput('sha256:analysis-input-b'), {
      execution: { provider: 'claude-code', requestedModel: 'sonnet' },
      resumeExecution: pinnedResumeExecution(),
      async execute(work) {
        providerCalls += 1;
        return successfulOutcome(work);
      },
    });
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'work-plan-changed' });
    expect(providerCalls).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('requires the interrupted run to remain the latest attempt', async () => {
    await createBlockedRun();
    await dispatchAnalyzeRun(repoPath, {
      kind: 'begin',
      runId: 'newer-attempt',
      candidateAnalysisId: 'newer-candidate',
      startedAt: '2026-07-19T02:00:04.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'resume-commit',
      completedBaselineId: 'completed-baseline',
    });
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'not-latest-attempt' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('finds the latest attempt without repairing a missing pointer', async () => {
    await createBlockedRun();
    const pointer = path.join(
      repoPath,
      '.truecourse',
      'analyses',
      'runs',
      'LATEST_ATTEMPT.json',
    );
    fs.unlinkSync(pointer);
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity)).resolves.toMatchObject({
      compatible: true,
      counts: { total: 2, reused: 1, pending: 1 },
    });
    expect(calls()).toBe(0);
    expect(fs.existsSync(pointer)).toBe(false);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('returns a conditional mismatch when the latest attempt changes during inspection', async () => {
    await createBlockedRun();
    const originalStore = getAnalysisStore();
    let changed = false;
    setAnalysisStore(new Proxy(originalStore, {
      get(target, property, receiver) {
        if (property === 'readLatest') {
          return async (repository: string) => {
            const result = await target.readLatest(repository);
            if (!changed) {
              changed = true;
              await dispatchAnalyzeRun(repoPath, {
                kind: 'begin',
                runId: 'racing-newer-attempt',
                candidateAnalysisId: 'racing-candidate',
                startedAt: '2026-07-19T02:00:04.000Z',
                source: 'cli',
                branch: 'main',
                commitHash: 'resume-commit',
                completedBaselineId: 'completed-baseline',
              });
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }));
    const { rebuilt, calls } = rebuiltRun();

    await expect(rebuilt.inspectResumeCompatibility(identity)).resolves.toEqual({
      compatible: false,
      reason: 'run-changed-during-inspection',
    });
    expect(calls()).toBe(0);
  });

  it('requires the completed baseline to remain active', async () => {
    await createBlockedRun();
    await writeLatest(repoPath, latest('new-completed-baseline'));
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'completed-baseline-changed' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('rejects a malformed completed baseline even when its ID matches', async () => {
    await createBlockedRun();
    const malformed = latest('completed-baseline') as any;
    malformed.analysis.status = 'running';
    fs.writeFileSync(latestFile(), `${JSON.stringify(malformed, null, 2)}\n`);
    clearLatestCache();
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity)).resolves.toEqual({
      compatible: false,
      reason: 'completed-baseline-invalid',
    });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it.each([
    ['repository content', { files: [{ path: 'context', content: '1: export const resume = false;' }] }],
    ['completed baseline content', {
      existingViolations: [{
        ...codeContext.existingViolations![0],
        content: 'The completed baseline finding changed.',
      }],
    }],
    ['rules', { llmRules: [{ ...rule, prompt: 'A changed prompt must invalidate reuse.' }] }],
    ['configuration', { tier: 'full-file' as const }],
  ])('rejects a changed %s fingerprint', async (_label, overrides) => {
    await createBlockedRun();
    const { rebuilt, calls } = rebuiltRun(overrides as Partial<CodeViolationContext>);
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'work-plan-changed' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('re-parses a checkpoint through the current result contract', async () => {
    await createBlockedRun();
    mutateCheckpoint((checkpoint) => {
      checkpoint.result = { violations: 'not-an-array' };
      checkpoint.resultFingerprint = fingerprint(checkpoint.result);
    });
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'checkpoint-result-invalid' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it.each([
    ['provider', 'other-provider', 'checkpoint-execution-changed'],
    ['requestedModel', 'opus', 'checkpoint-execution-changed'],
    ['resolvedModel', null, 'checkpoint-model-unverified'],
    ['resolvedModel', 'claude-sonnet-other', 'checkpoint-model-unverified'],
  ] as const)('rejects checkpoint usage with changed %s', async (field, value, reason) => {
    await createBlockedRun();
    mutateCheckpoint((checkpoint) => {
      checkpoint.usage[field] = value;
    });
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('rejects a different concrete model selected for pending execution', async () => {
    await createBlockedRun();
    const { rebuilt, calls } = rebuiltRun({}, 'claude-sonnet-other');
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'checkpoint-model-unverified' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('rejects an adapter that cannot pin pending execution to a concrete model', async () => {
    await createBlockedRun();
    const { rebuilt, calls } = rebuiltRun({}, null);
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'checkpoint-model-unverified' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('rejects whitespace-only concrete model evidence', async () => {
    await createBlockedRun();
    mutateCheckpoint((checkpoint) => {
      checkpoint.usage.resolvedModel = '   ';
    });
    const { rebuilt, calls } = rebuiltRun({}, '   ');
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'checkpoint-model-unverified' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('rejects provider intent that drifts after the current plan is certified', async () => {
    await createBlockedRun();
    let execution = { provider: 'claude-code', requestedModel: 'sonnet' };
    let providerCalls = 0;
    const rebuilt = certifyAnalyzeLlmRun(planInput(), {
      get execution() { return execution; },
      resumeExecution: pinnedResumeExecution(),
      async execute(work) {
        providerCalls += 1;
        return successfulOutcome(work);
      },
    });
    execution = { provider: 'claude-code', requestedModel: 'opus' };
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'checkpoint-execution-changed' });
    expect(providerCalls).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('snapshots the validated pinned model before an adapter can mutate its object', async () => {
    await createBlockedRun();
    const mutablePin = { ...pinnedResumeExecution() };
    let scheduled = false;
    const rebuilt = certifyAnalyzeLlmRun(planInput(), {
      execution: { provider: 'claude-code', requestedModel: 'sonnet' },
      get resumeExecution() {
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(() => { mutablePin.resolvedModel = 'claude-mutated-after-validation'; });
        }
        return mutablePin;
      },
      async execute(work) { return successfulOutcome(work); },
    });

    await expect(rebuilt.inspectResumeCompatibility(identity)).resolves.toMatchObject({
      compatible: true,
      observed: { resolvedModel },
    });
    expect(mutablePin.resolvedModel).toBe('claude-mutated-after-validation');
  });

  it('rejects duplicate provider attempt identities across checkpoints', async () => {
    await createBlockedRun({ databaseSucceeds: true });
    const stored = readStoredRun();
    const checkpoints = stored.plan.work
      .filter((work: Record<string, unknown>) => work.state === 'succeeded-checkpointed')
      .map((work: Record<string, any>) => work.checkpoint);
    checkpoints[1].attemptId = checkpoints[0].attemptId;
    writeStoredRun(stored);
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity))
      .resolves.toEqual({ compatible: false, reason: 'duplicate-checkpoint-attempt' });
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('fails closed when checkpoint integrity is corrupt', async () => {
    await createBlockedRun();
    mutateCheckpoint((checkpoint) => {
      checkpoint.result = { violations: [{ title: 'tampered' }] };
    });
    const { rebuilt, calls } = rebuiltRun();
    const before = fs.readFileSync(runFile(), 'utf8');

    await expect(rebuilt.inspectResumeCompatibility(identity)).rejects.toThrow(
      /checkpoint fingerprint mismatch/,
    );
    expect(calls()).toBe(0);
    expect(fs.readFileSync(runFile(), 'utf8')).toBe(before);
  });

  it('certifies exact ambiguous consent, reuses checkpoints, and executes only pending work', async () => {
    const offer = await createAmbiguousRun();
    const { rebuilt, calls } = rebuiltRun();
    const activated = await rebuilt.activateAmbiguousRearm(
      identity,
      exactAmbiguousConsent(offer),
      '2026-07-19T02:00:04.000Z',
    );
    expect(activated).toMatchObject({
      activated: true,
      counts: { total: 2, reused: 1, pending: 1 },
      view: {
        executionAttempt: {
          resume: { activation: 'ambiguous-rearm', admission: 'activated' },
        },
      },
    });
    if (!activated.activated) throw new Error('expected ambiguous activation');

    const executed = await rebuilt.executeResume(
      activated.activation,
      '2026-07-19T02:00:05.000Z',
    );
    expect(calls()).toBe(1);
    expect(executed.results).toHaveLength(2);
    expect(executed.usageLedger).toHaveLength(2);
  });

  it('returns structured failures for missing and inexact ambiguous consent', async () => {
    const offer = await createAmbiguousRun();
    const missing = rebuiltRun();
    await expect(missing.rebuilt.activateAmbiguousRearm(
      identity,
      undefined,
      '2026-07-19T02:00:04.000Z',
    )).resolves.toEqual({
      activated: false,
      reason: 'ambiguous-rearm-consent-required',
    });
    expect(missing.calls()).toBe(0);

    const inexact = rebuiltRun();
    await expect(inexact.rebuilt.activateAmbiguousRearm(
      identity,
      {
        ...exactAmbiguousConsent(offer),
        acceptedMaxRepeatProviderCalls: offer.maxRepeatProviderCalls + 1,
      },
      '2026-07-19T02:00:04.000Z',
    )).resolves.toEqual({
      activated: false,
      reason: 'ambiguous-rearm-risk-not-accepted',
    });
    expect(inexact.calls()).toBe(0);
  });

  it('recovers already-durable ambiguous consent without asking again', async () => {
    const offer = await createAmbiguousRun();
    const first = rebuiltRun();
    const activated = await first.rebuilt.activateAmbiguousRearm(
      identity,
      exactAmbiguousConsent(offer),
      '2026-07-19T02:00:04.000Z',
    );
    if (!activated.activated) throw new Error('expected ambiguous activation');
    const bytes = fs.readFileSync(runFile());
    resetAnalyzeRunStorage();

    const recovered = rebuiltRun();
    const retry = await recovered.rebuilt.activateAmbiguousRearm(
      identity,
      undefined,
      '2026-07-19T03:00:00.000Z',
    );
    expect(retry).toMatchObject({ activated: true, view: { revision: 4 } });
    expect(fs.readFileSync(runFile())).toEqual(bytes);
    expect(recovered.calls()).toBe(0);
  });

  it('recovers a fully checkpointed ambiguous execution without another provider call', async () => {
    const offer = await createAmbiguousRun();
    const first = rebuiltRun();
    const activated = await first.rebuilt.activateAmbiguousRearm(
      identity,
      exactAmbiguousConsent(offer),
      '2026-07-19T02:00:04.000Z',
    );
    if (!activated.activated) throw new Error('expected ambiguous activation');
    await first.rebuilt.executeResume(
      activated.activation,
      '2026-07-19T02:00:05.000Z',
    );
    const bytes = fs.readFileSync(runFile());
    resetAnalyzeRunStorage();

    const recovered = rebuiltRun();
    const retry = await recovered.rebuilt.activateAmbiguousRearm(
      identity,
      undefined,
      '2026-07-19T03:00:00.000Z',
    );
    expect(retry).toMatchObject({
      activated: true,
      counts: { total: 2, reused: 2, pending: 0 },
    });
    expect(fs.readFileSync(runFile())).toEqual(bytes);
    if (!retry.activated) throw new Error('expected completed recovery');
    const execution = await recovered.rebuilt.executeResume(
      retry.activation,
      '2026-07-19T03:00:01.000Z',
    );
    expect(execution.results).toHaveLength(2);
    expect(recovered.calls()).toBe(0);
  });
});

function planInput(overrides: Partial<CodeViolationContext> = {}) {
  return {
    runId,
    journalKey: repoPath,
    repositoryRoot: '/repo',
    code: [{ domain: 'bugs' as const, context: { ...structuredClone(codeContext), ...overrides } }],
    database: structuredClone(databaseContext),
  };
}

function architecturePlanInput(analysisInputFingerprint: string) {
  const service: ServiceViolationContext = {
    analysisInputFingerprint,
    architecture: 'distributed services',
    services: [{
      id: 'orders',
      name: 'orders',
      type: 'backend',
      fileCount: 1,
      layers: ['api'],
    }],
    dependencies: [],
    llmRules: [{
      key: 'architecture/llm/resume',
      name: 'Resume architecture',
      severity: 'medium',
      prompt: 'Review architecture resumability.',
    }],
  };
  return {
    runId,
    journalKey: repoPath,
    repositoryRoot: '/repo',
    code: [],
    service,
  };
}

async function createBlockedArchitectureRun(analysisInputFingerprint: string): Promise<void> {
  const sessionLimit = new LlmSessionLimitError('7pm');
  const certified = certifyAnalyzeLlmRun(architecturePlanInput(analysisInputFingerprint), {
    execution: Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' }),
    async execute() { throw sessionLimit; },
  });
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId,
    candidateAnalysisId: identity.candidateAnalysisId,
    startedAt: identity.startedAt,
    source: identity.source,
    branch: identity.branch,
    commitHash: identity.commitHash,
    completedBaselineId: identity.completedBaselineId,
  });
  const activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    execution: { provider: 'claude-code', requestedModel: 'sonnet' },
    runId,
    sealedAt: '2026-07-19T02:00:01.000Z',
    work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    })),
  });
  await expect(certified.execute(
    activation,
    '2026-07-19T02:00:01.500Z',
  )).rejects.toBe(sessionLimit);
  await dispatchAnalyzeRun(repoPath, {
    kind: 'block',
    runId,
    blockedAt: '2026-07-19T02:00:03.000Z',
    resetHint: '7pm',
  });
}

async function createZeroCheckpointBlockedRun(requestedModel: string | null = 'sonnet'): Promise<void> {
  const sessionLimit = new LlmSessionLimitError('7pm');
  const certified = certifyAnalyzeLlmRun(planInput(), {
    execution: Object.freeze({ provider: 'claude-code', requestedModel }),
    async execute() { throw sessionLimit; },
  });
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId,
    candidateAnalysisId: identity.candidateAnalysisId,
    startedAt: identity.startedAt,
    source: identity.source,
    branch: identity.branch,
    commitHash: identity.commitHash,
    completedBaselineId: identity.completedBaselineId,
  });
  const activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    execution: { provider: 'claude-code', requestedModel },
    runId,
    sealedAt: '2026-07-19T02:00:01.000Z',
    work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    })),
  });
  await expect(certified.execute(
    activation,
    '2026-07-19T02:00:01.500Z',
  )).rejects.toBe(sessionLimit);
  await dispatchAnalyzeRun(repoPath, {
    kind: 'block',
    runId,
    blockedAt: '2026-07-19T02:00:03.000Z',
    resetHint: '7pm',
  });
}

async function createBlockedRun(
  options: { databaseSucceeds?: boolean } = {},
): Promise<{ codeWorkId: string; databaseWorkId: string }> {
  const sessionLimit = new LlmSessionLimitError('7pm');
  const adapter: AnalyzeLlmExecutionAdapter = {
    execution: Object.freeze({ provider: 'claude-code', requestedModel: 'sonnet' }),
    async execute(work) {
      if (work.family === 'database' && !options.databaseSucceeds) throw sessionLimit;
      return successfulOutcome(work);
    },
  };
  const certified = certifyAnalyzeLlmRun(planInput(), adapter);
  await dispatchAnalyzeRun(repoPath, {
    kind: 'begin',
    runId,
    candidateAnalysisId: identity.candidateAnalysisId,
    startedAt: identity.startedAt,
    source: identity.source,
    branch: identity.branch,
    commitHash: identity.commitHash,
    completedBaselineId: identity.completedBaselineId,
  });
  const activation = await sealAnalyzeRunPlan(repoPath, {
    kind: 'seal-plan',
    execution: { provider: 'claude-code', requestedModel: 'sonnet' },
    runId,
    sealedAt: '2026-07-19T02:00:01.000Z',
    work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    })),
  });
  if (options.databaseSucceeds) {
    await expect(certified.execute(
      activation,
      '2026-07-19T02:00:01.500Z',
    )).resolves.toMatchObject({
      results: expect.any(Array),
    });
  } else {
    await expect(certified.execute(
      activation,
      '2026-07-19T02:00:01.500Z',
    )).rejects.toBe(sessionLimit);
  }
  await dispatchAnalyzeRun(repoPath, {
    kind: 'block',
    runId,
    blockedAt: '2026-07-19T02:00:03.000Z',
    resetHint: '7pm',
  });
  return {
    codeWorkId: certified.manifest.work.find((work) => work.family === 'code')!.workId,
    databaseWorkId: certified.manifest.work.find((work) => work.family === 'database')!.workId,
  };
}

async function createAmbiguousRun(): Promise<AnalyzeRunAmbiguousRearmOffer> {
  await createBlockedRun();
  const stored = readStoredRun();
  const checkpointedAt = stored.plan.work
    .filter((item: Record<string, unknown>) => item.state === 'succeeded-checkpointed')
    .map((item: Record<string, any>) => item.checkpoint.checkpointedAt)
    .sort()
    .at(-1);
  stored.revision -= 1;
  stored.updatedAt = checkpointedAt;
  stored.status = { state: 'running' };
  writeStoredRun(stored);
  resetAnalyzeRunStorage();
  const current = await readAnalyzeRun(repoPath, 'latest-attempt');
  if (current?.rearm == null) throw new Error('expected ambiguous rearm offer');
  return current.rearm;
}

function exactAmbiguousConsent(offer: AnalyzeRunAmbiguousRearmOffer) {
  return {
    evidence: offer.evidence,
    acceptedRisk: 'repeat-up-to-pending-provider-calls' as const,
    acceptedMaxRepeatProviderCalls: offer.maxRepeatProviderCalls,
  };
}

function rebuiltRun(
  overrides: Partial<CodeViolationContext> = {},
  resumeModel: string | null = resolvedModel,
) {
  let providerCalls = 0;
  const adapter: AnalyzeLlmExecutionAdapter = {
    execution: { provider: 'claude-code', requestedModel: 'sonnet' },
    async execute(work) {
      providerCalls += 1;
      return { ...successfulOutcome(work), completedAt: '2026-07-19T02:00:06.000Z' };
    },
  };
  if (resumeModel !== null) {
    Object.assign(adapter, { resumeExecution: pinnedResumeExecution(resumeModel) });
  }
  const rebuilt = certifyAnalyzeLlmRun(planInput(overrides), adapter);
  return { rebuilt, calls: () => providerCalls };
}

function pinnedResumeExecution(model = resolvedModel) {
  return Object.freeze({
    provider: 'claude-code',
    requestedModel: 'sonnet',
    modelSelection: 'pinned' as const,
    resolvedModel: model,
  });
}

function successfulOutcome(work: CertifiedAnalyzeLlmWork): AnalyzeLlmExecutionOutcome {
  return {
    family: work.family,
    domain: work.domain,
    mode: work.mode,
    workId: work.workId,
    inputFingerprint: work.inputFingerprint,
    resultContractId: work.planned.request.resultContractId,
    result: work.mode === 'lifecycle'
      ? { newViolations: [], resolvedViolationIds: [], unchangedViolationIds: [] }
      : { violations: [] },
    attemptId: `resume:${work.workId}`,
    completedAt: '2026-07-19T02:00:02.000Z',
    usage: {
      provider: 'claude-code',
      requestedModel: 'sonnet',
      resolvedModel,
      callType: work.family,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 120,
      costUsd: '0.012',
      durationMs: 300,
    },
  };
}

function successfulOutcomeForRequestedModel(
  work: CertifiedAnalyzeLlmWork,
  requestedModel: string | null,
): AnalyzeLlmExecutionOutcome {
  const outcome = successfulOutcome(work);
  return {
    ...outcome,
    usage: outcome.usage === null ? null : { ...outcome.usage, requestedModel },
  };
}

function latest(id: string): LatestSnapshot {
  const createdAt = '2026-07-18T23:00:00.000Z';
  return {
    head: buildAnalysisFilename(id, createdAt),
    analysis: {
      id,
      createdAt,
      branch: 'main',
      commitHash: 'baseline-commit',
      architecture: 'monolith',
      metadata: null,
      status: 'completed',
    },
    graph: {
      services: [], serviceDependencies: [], layers: [], modules: [], methods: [],
      moduleDeps: [], methodDeps: [], databases: [], databaseConnections: [], flows: [],
    },
    violations: [],
  };
}

function runFile(): string {
  return path.join(repoPath, '.truecourse', 'analyses', 'runs', `${runId}.json`);
}

function latestFile(): string {
  return latestPath(repoPath);
}

function readStoredRun(): any {
  return JSON.parse(fs.readFileSync(runFile(), 'utf8'));
}

function writeStoredRun(stored: unknown): void {
  fs.writeFileSync(runFile(), `${JSON.stringify(stored, null, 2)}\n`);
}

function mutateCheckpoint(mutate: (checkpoint: any) => void): void {
  const stored = readStoredRun();
  const work = stored.plan.work.find(
    (item: { state: string }) => item.state === 'succeeded-checkpointed',
  );
  mutate(work.checkpoint);
  writeStoredRun(stored);
}
