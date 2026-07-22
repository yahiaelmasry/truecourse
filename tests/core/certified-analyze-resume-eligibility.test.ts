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
  admitAnalyzeRunResumeExecution,
  dispatchAnalyzeRun,
  readAnalyzeRun,
  resetAnalyzeRunStorage,
  sealAnalyzeRunPlan,
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
    runId,
    sealedAt: '2026-07-19T02:00:01.000Z',
    work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    })),
  });
  await expect(certified.execute(activation)).rejects.toBe(sessionLimit);
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
    runId,
    sealedAt: '2026-07-19T02:00:01.000Z',
    work: certified.manifest.work.map(({ workId, inputFingerprint }) => ({
      workId,
      inputFingerprint,
    })),
  });
  if (options.databaseSucceeds) {
    await expect(certified.execute(activation)).resolves.toMatchObject({
      results: expect.any(Array),
    });
  } else {
    await expect(certified.execute(activation)).rejects.toBe(sessionLimit);
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
