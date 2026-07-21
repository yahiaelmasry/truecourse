import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentTransport,
  type LlmRequest,
  type LlmTransport,
} from '../../packages/shared/src/llm/transport.js';
import {
  createLLMProvider,
  type CodeViolationContext,
} from '../../packages/core/src/services/llm/provider.js';
import { planCodeViolationWork } from '../../packages/core/src/services/llm/code-work-planner.js';

function lifecycleContext(root = '/checkout/one'): CodeViolationContext {
  const filePath = `${root}/src/orders.ts`;
  return {
    files: [{
      path: filePath,
      content: 'export async function placeOrder() { await saveOrder(); }',
    }],
    sourceScopes: [{ path: filePath, ranges: [{ lineStart: 1, lineEnd: 1 }] }],
    sources: [{ path: filePath, selection: { kind: 'full-file' } }],
    llmRules: [{
      key: 'reliability/llm/async-boundary',
      name: 'Async boundary',
      severity: 'high',
      prompt: 'Review async error handling.',
    }],
    tier: 'full-file',
    existingViolations: [{
      id: 'runtime-finding-a',
      filePath,
      lineStart: 1,
      lineEnd: 1,
      ruleKey: 'reliability/llm/async-boundary',
      severity: 'high',
      title: 'Missing async boundary',
      content: 'The call has no error boundary.',
    }],
  };
}

function addSecondSemanticInput(context: CodeViolationContext, root = '/checkout/one'): void {
  const filePath = `${root}/src/customers.ts`;
  context.files.push({ path: filePath, content: 'export function findCustomer() { return loadCustomer(); }' });
  context.sourceScopes.push({ path: filePath, ranges: [{ lineStart: 1, lineEnd: 1 }] });
  context.sources!.push({ path: filePath, selection: { kind: 'full-file' } });
  context.llmRules.push({
    key: 'security/llm/customer-access',
    name: 'Customer access',
    severity: 'critical',
    prompt: 'Review customer authorization.',
  });
  context.existingViolations!.push({
    id: 'runtime-finding-b',
    filePath,
    lineStart: 1,
    lineEnd: 1,
    ruleKey: 'security/llm/customer-access',
    severity: 'critical',
    title: 'Missing customer authorization',
    content: 'The lookup has no access check.',
  });
}

const execution = {
  provider: 'claude-code',
  requestedModel: 'sonnet',
} as const;

describe('code work planner', () => {
  it('rejects repository inputs that escape the certified root', () => {
    expect(() => planCodeViolationWork(lifecycleContext('/checkout/one'), execution))
      .toThrow(/outside repository root/);

    const outsideFile = lifecycleContext('/checkout/one');
    outsideFile.files[0].path = '/checkout/other/orders.ts';
    expect(() => planCodeViolationWork(outsideFile, {
      ...execution,
      repositoryRoot: '/checkout/one',
    })).toThrow(/outside repository root/);

    const traversal = lifecycleContext('/checkout/one');
    traversal.sources![0].path = '../outside.ts';
    expect(() => planCodeViolationWork(traversal, {
      ...execution,
      repositoryRoot: '/checkout/one',
    })).toThrow(/outside repository root/);

    for (const driveRelativePath of ['C:outside.ts', 'C:temp/../outside.ts']) {
      const driveRelativeMutations: Array<(context: CodeViolationContext) => void> = [
        (context) => { context.files[0].path = driveRelativePath; },
        (context) => { context.sources![0].path = driveRelativePath; },
        (context) => { context.sourceScopes[0].path = driveRelativePath; },
        (context) => { context.existingViolations![0].filePath = driveRelativePath; },
      ];
      for (const mutate of driveRelativeMutations) {
        const driveRelative = lifecycleContext('/checkout/one');
        mutate(driveRelative);
        expect(() => planCodeViolationWork(driveRelative, {
          ...execution,
          repositoryRoot: '/checkout/one',
        })).toThrow(/outside repository root/);
      }
    }

    const driveAbsoluteTraversalMutations: Array<(context: CodeViolationContext) => void> = [
      (context) => { context.files[0].path = 'C:/repo/../../outside.ts'; },
      (context) => { context.sources![0].path = 'C:/repo/../../outside.ts'; },
      (context) => { context.sourceScopes[0].path = 'C:/repo/../../outside.ts'; },
      (context) => { context.existingViolations![0].filePath = 'C:/repo/../../outside.ts'; },
    ];
    for (const mutate of driveAbsoluteTraversalMutations) {
      const driveAbsoluteTraversal = lifecycleContext('C:/repo');
      mutate(driveAbsoluteTraversal);
      expect(() => planCodeViolationWork(driveAbsoluteTraversal, {
        ...execution,
        repositoryRoot: 'C:/repo',
      })).toThrow(/outside repository root/);
    }
  });

  it('rejects duplicate paths and ranges after repository-path normalization', () => {
    const duplicateFiles = lifecycleContext('/checkout/one');
    duplicateFiles.files.push({
      ...duplicateFiles.files[0],
      path: '\\checkout\\one\\src\\orders.ts',
    });
    expect(() => planCodeViolationWork(duplicateFiles, {
      ...execution,
      repositoryRoot: '/checkout/one',
    })).toThrow(/duplicate code file path/);

    const duplicateSources = lifecycleContext('/checkout/one');
    duplicateSources.sources!.push({
      ...duplicateSources.sources![0],
      path: '\\checkout\\one\\src\\orders.ts',
    });
    expect(() => planCodeViolationWork(duplicateSources, {
      ...execution,
      repositoryRoot: '/checkout/one',
    })).toThrow(/duplicate code source path/);

    const duplicateScopes = lifecycleContext('/checkout/one');
    duplicateScopes.sourceScopes.push({
      path: '\\checkout\\one\\src\\orders.ts',
      ranges: [{ lineStart: 1, lineEnd: 1 }],
    });
    expect(() => planCodeViolationWork(duplicateScopes, {
      ...execution,
      repositoryRoot: '/checkout/one',
    })).toThrow(/duplicate code source-scope path/);

    const duplicateRanges = lifecycleContext('/checkout/one');
    duplicateRanges.sourceScopes[0].ranges.push({ lineStart: 1, lineEnd: 1 });
    expect(() => planCodeViolationWork(duplicateRanges, {
      ...execution,
      repositoryRoot: '/checkout/one',
    })).toThrow(/duplicate code source range/);
  });

  it('normalizes equivalent Windows and POSIX checkout paths to the same identity', () => {
    const posix = planCodeViolationWork(lifecycleContext('/checkout/one'), {
      ...execution,
      repositoryRoot: '/checkout/one',
    });
    const windowsContext = lifecycleContext('C:\\checkout\\one');
    const windows = planCodeViolationWork(windowsContext, {
      ...execution,
      repositoryRoot: 'C:\\checkout\\one',
    });

    expect(windows.workId).toBe(posix.workId);
    expect(windows.inputFingerprint).toBe(posix.inputFingerprint);
  });

  it('preserves the filesystem root as a certified repository root', () => {
    const planned = planCodeViolationWork(lifecycleContext('/'), {
      ...execution,
      repositoryRoot: '/',
    });

    expect(planned.request.ownership.sourceScopes[0].path).toBe('src/orders.ts');
  });

  it('keeps semantic work identity independent of checkout roots, runtime IDs, and mutable inputs', () => {
    const original = lifecycleContext('/checkout/one');
    addSecondSemanticInput(original, '/checkout/one');
    const relocated = lifecycleContext('/different/checkout');
    addSecondSemanticInput(relocated, '/different/checkout');
    relocated.existingViolations![0].id = 'different-runtime-id';

    const first = planCodeViolationWork(original, {
      ...execution,
      repositoryRoot: '/checkout/one',
    });
    const second = planCodeViolationWork(relocated, {
      ...execution,
      repositoryRoot: '/different/checkout',
    });

    expect(first.workId).toMatch(/^llm\.code:sha256:[a-f0-9]{64}$/);
    expect(first.workId).toBe(second.workId);
    expect(first.inputFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.componentFingerprints)).toBe(true);

    const runtimeAliasOnly = lifecycleContext('/checkout/one');
    addSecondSemanticInput(runtimeAliasOnly, '/checkout/one');
    runtimeAliasOnly.existingViolations![0].id = 'another-runtime-id';
    runtimeAliasOnly.existingViolations![1].id = 'one-more-runtime-id';
    runtimeAliasOnly.files.reverse();
    runtimeAliasOnly.sourceScopes.reverse();
    runtimeAliasOnly.sources!.reverse();
    runtimeAliasOnly.llmRules.reverse();
    runtimeAliasOnly.existingViolations!.reverse();
    expect(planCodeViolationWork(runtimeAliasOnly, {
      ...execution,
      repositoryRoot: '/checkout/one',
    }).inputFingerprint).toBe(first.inputFingerprint);

    const changedSource = lifecycleContext('/checkout/one');
    addSecondSemanticInput(changedSource, '/checkout/one');
    changedSource.files[0].content += '\n// changed';
    const sourcePlan = planCodeViolationWork(changedSource, {
      ...execution,
      repositoryRoot: '/checkout/one',
    });
    expect(sourcePlan.workId).toBe(first.workId);
    expect(sourcePlan.componentFingerprints.repository).not.toBe(first.componentFingerprints.repository);
    expect(sourcePlan.inputFingerprint).not.toBe(first.inputFingerprint);

    const changedPrior = lifecycleContext('/checkout/one');
    addSecondSemanticInput(changedPrior, '/checkout/one');
    changedPrior.existingViolations![0].content = 'Changed completed-baseline evidence.';
    const priorPlan = planCodeViolationWork(changedPrior, {
      ...execution,
      repositoryRoot: '/checkout/one',
    });
    expect(priorPlan.workId).toBe(first.workId);
    expect(priorPlan.componentFingerprints.baseline).not.toBe(first.componentFingerprints.baseline);
    expect(priorPlan.inputFingerprint).not.toBe(first.inputFingerprint);

    const changedRule = lifecycleContext('/checkout/one');
    addSecondSemanticInput(changedRule, '/checkout/one');
    changedRule.llmRules[0].prompt = 'Use a stricter async boundary policy.';
    const rulePlan = planCodeViolationWork(changedRule, {
      ...execution,
      repositoryRoot: '/checkout/one',
    });
    expect(rulePlan.workId).toBe(first.workId);
    expect(rulePlan.componentFingerprints.rules).not.toBe(first.componentFingerprints.rules);
    expect(rulePlan.inputFingerprint).not.toBe(first.inputFingerprint);

    const changedScope = lifecycleContext('/checkout/one');
    addSecondSemanticInput(changedScope, '/checkout/one');
    changedScope.sourceScopes[0].ranges[0].lineEnd = 2;
    expect(planCodeViolationWork(changedScope, {
      ...execution,
      repositoryRoot: '/checkout/one',
    }).workId).not.toBe(first.workId);

    const changedRuleKey = lifecycleContext('/checkout/one');
    addSecondSemanticInput(changedRuleKey, '/checkout/one');
    changedRuleKey.llmRules[0].key = 'reliability/llm/different-scope';
    expect(planCodeViolationWork(changedRuleKey, {
      ...execution,
      repositoryRoot: '/checkout/one',
    }).workId).not.toBe(first.workId);
  });

  it('fingerprints configuration, request/result contracts, provider, and requested model', () => {
    const context = lifecycleContext();
    const base = planCodeViolationWork(context, { ...execution, repositoryRoot: '/checkout/one' });

    const metadataContext = lifecycleContext();
    metadataContext.tier = 'metadata';
    metadataContext.sources = metadataContext.sources!.map((source) => ({
      ...source,
      selection: { kind: 'metadata', fields: ['functions'] },
    }));
    const configured = planCodeViolationWork(metadataContext, {
      ...execution,
      repositoryRoot: '/checkout/one',
    });
    expect(configured.componentFingerprints.configuration).not.toBe(base.componentFingerprints.configuration);
    expect(configured.inputFingerprint).not.toBe(base.inputFingerprint);

    const firstRunContext = lifecycleContext();
    delete firstRunContext.existingViolations;
    const firstRun = planCodeViolationWork(firstRunContext, {
      ...execution,
      repositoryRoot: '/checkout/one',
    });
    expect(firstRun.componentFingerprints.request).not.toBe(base.componentFingerprints.request);
    expect(firstRun.componentFingerprints.resultContract).not.toBe(base.componentFingerprints.resultContract);
    expect(firstRun.inputFingerprint).not.toBe(base.inputFingerprint);

    const providerChanged = planCodeViolationWork(context, {
      provider: 'agent-mailbox',
      requestedModel: 'sonnet',
      repositoryRoot: '/checkout/one',
    });
    expect(providerChanged.componentFingerprints.execution).not.toBe(base.componentFingerprints.execution);
    expect(providerChanged.inputFingerprint).not.toBe(base.inputFingerprint);

    const modelChanged = planCodeViolationWork(context, {
      provider: 'claude-code',
      requestedModel: 'opus',
      repositoryRoot: '/checkout/one',
    });
    expect(modelChanged.componentFingerprints.execution).not.toBe(base.componentFingerprints.execution);
    expect(modelChanged.inputFingerprint).not.toBe(base.inputFingerprint);
  });

  it('fails closed when duplicate semantic priors cannot receive stable runtime-independent aliases', () => {
    const context = lifecycleContext();
    context.existingViolations!.push({
      ...context.existingViolations![0],
      id: 'duplicate-runtime-id',
    });

    expect(() => planCodeViolationWork(context, {
      ...execution,
      repositoryRoot: '/checkout/one',
    })).toThrow(/duplicate semantic prior findings/);
  });

  it('forwards the planner-owned work ID through the real provider transport call', async () => {
    const context = lifecycleContext();
    const planned = planCodeViolationWork(context, {
      provider: 'transport:unverified',
      requestedModel: execution.requestedModel,
      repositoryRoot: '/checkout/one',
    });
    let captured: LlmRequest | undefined;
    const transport: LlmTransport = async (request) => {
      captured = request;
      return JSON.stringify({
        resolvedViolationIds: [],
        unchangedViolationIds: ['cv-0'],
        newViolations: [],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');
    provider.setRepoPath('/checkout/one');

    await provider.generateCodeViolations(context);

    expect(captured).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^llm\.code\.attempt:[a-f0-9-]{36}$/),
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
    }));
  });

  it('never gives full-file mailbox calls a reusable response key without a read-set receipt', async () => {
    const io = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-code-work-'));
    const original = lifecycleContext();
    const changed = lifecycleContext();
    changed.files[0].content += '\n// repository changed';
    const originalPlan = planCodeViolationWork(original, {
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
      repositoryRoot: '/checkout/one',
    });
    const changedPlan = planCodeViolationWork(changed, {
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
      repositoryRoot: '/checkout/one',
    });
    expect(changedPlan.workId).toBe(originalPlan.workId);
    expect(changedPlan.inputFingerprint).not.toBe(originalPlan.inputFingerprint);

    const provider = createLLMProvider(agentTransport(io, { pollMs: 5 }), 'sonnet');
    provider.setRepoPath('/checkout/one');
    const originalExecution = provider.generateCodeViolations(original);
    const requestDir = path.join(io, 'requests');
    for (let attempt = 0; attempt < 200 && fs.readdirSync(requestDir).length < 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const originalRequestFile = fs.readdirSync(requestDir)[0];
    fs.writeFileSync(
      path.join(io, 'responses', originalRequestFile),
      JSON.stringify({
        text: JSON.stringify({
          resolvedViolationIds: [],
          unchangedViolationIds: ['cv-0'],
          newViolations: [],
        }),
      }),
    );
    await originalExecution;

    const changedExecution = provider.generateCodeViolations(changed);
    for (let attempt = 0; attempt < 200 && fs.readdirSync(requestDir).length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const requestFiles = fs.readdirSync(requestDir);
    expect(requestFiles).toHaveLength(2);
    const changedRequestFile = requestFiles.find((file) => file !== originalRequestFile)!;
    const mailboxRequest = JSON.parse(fs.readFileSync(path.join(requestDir, changedRequestFile), 'utf8'));
    expect(mailboxRequest).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^llm\.code\.attempt_[a-f0-9-]{36}$/),
      workId: changedPlan.workId,
      inputFingerprint: changedPlan.inputFingerprint,
    }));
    fs.writeFileSync(
      path.join(io, 'responses', changedRequestFile),
      JSON.stringify({
        text: JSON.stringify({
          resolvedViolationIds: [],
          unchangedViolationIds: ['cv-0'],
          newViolations: [],
        }),
      }),
    );

    await expect(changedExecution).resolves.toEqual({
      violations: [],
      resolvedViolationIds: [],
      unchangedViolationIds: ['runtime-finding-a'],
    });
  });
});
