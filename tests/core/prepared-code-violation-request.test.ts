import { describe, expect, it } from 'vitest';
import type { LlmRequest, LlmTransport } from '../../packages/shared/src/llm/transport.js';
import { createLLMProvider, type CodeViolationContext } from '../../packages/core/src/services/llm/provider.js';
import {
  INLINE_FULL_FILE_SOURCE_DELIVERY,
  prepareCodeViolationRequest,
  prepareInlineFullFileCodeViolationRequest,
} from '../../packages/core/src/services/llm/prepared-code-violation-request.js';
import { planCodeViolationWork } from '../../packages/core/src/services/llm/code-work-planner.js';

function targetedContext(withPrior = false): CodeViolationContext {
  return {
    files: [{
      path: 'context',
      content: [
        '=== src/orders.ts ===',
        '--- placeOrder (lines 1-3) ---',
        '1: export async function placeOrder() {',
        '2:   await saveOrder();',
        '3: }',
      ].join('\n'),
    }],
    sourceScopes: [{
      path: 'src/orders.ts',
      ranges: [{ lineStart: 1, lineEnd: 3 }],
    }],
    llmRules: [{
      key: 'reliability/llm/async-boundary',
      name: 'Async boundary',
      severity: 'high',
      prompt: 'Review async error handling.',
    }],
    tier: 'targeted',
    existingViolations: withPrior ? [{
      id: 'runtime-prior-id',
      filePath: 'src/orders.ts',
      lineStart: 1,
      lineEnd: 3,
      ruleKey: 'reliability/llm/async-boundary',
      severity: 'high',
      title: 'Missing async boundary',
      content: 'The call has no error boundary.',
    }] : undefined,
  };
}

describe('prepared code violation requests', () => {
  it('rejects direct inline preparation with an absolute or incomplete source set', () => {
    const context: CodeViolationContext = {
      files: [{ path: '/checkout/src/orders.ts', content: 'export const order = true;' }],
      sourceScopes: [],
      sources: [],
      llmRules: [{ key: 'bugs/llm/review', name: 'Review', severity: 'high', prompt: 'Review it.' }],
      tier: 'full-file',
    };
    const delivery = {
      contract: INLINE_FULL_FILE_SOURCE_DELIVERY,
      sourceBindings: [{ promptPath: 'src/orders.ts', runtimePath: '/checkout/src/orders.ts' }],
      fileList: '=== src/orders.ts ===\n1: export const order = true;',
    };

    expect(() => prepareInlineFullFileCodeViolationRequest(context, '/checkout', delivery))
      .toThrow(/exact non-empty repository-relative file, source, and scope sets/i);
  });

  it('rejects an inline lifecycle prior outside the owned source set', () => {
    const context: CodeViolationContext = {
      files: [{ path: 'src/orders.ts', content: 'export const order = true;' }],
      sourceScopes: [{ path: 'src/orders.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }],
      sources: [{ path: 'src/orders.ts', selection: { kind: 'full-file' } }],
      llmRules: [{ key: 'bugs/llm/review', name: 'Review', severity: 'high', prompt: 'Review it.' }],
      tier: 'full-file',
      existingViolations: [{
        id: 'prior', filePath: '../secret.ts', lineStart: 1, lineEnd: 1,
        ruleKey: 'bugs/llm/review', severity: 'high', title: 'Prior', content: 'Prior issue.',
      }],
    };
    const delivery = {
      contract: INLINE_FULL_FILE_SOURCE_DELIVERY,
      sourceBindings: [{ promptPath: 'src/orders.ts', runtimePath: '/checkout/src/orders.ts' }],
      fileList: '=== src/orders.ts ===\n1: export const order = true;',
    };

    expect(() => prepareInlineFullFileCodeViolationRequest(context, '/checkout', delivery))
      .toThrow(/lifecycle prior is outside its source set/i);
  });

  it('rejects an inline lifecycle prior outside its owned source range', () => {
    const context: CodeViolationContext = {
      files: [{ path: 'src/orders.ts', content: 'first\nsecond\nthird' }],
      sourceScopes: [{ path: 'src/orders.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }],
      sources: [{ path: 'src/orders.ts', selection: { kind: 'full-file' } }],
      llmRules: [{ key: 'bugs/llm/review', name: 'Review', severity: 'high', prompt: 'Review it.' }],
      tier: 'full-file',
      existingViolations: [{
        id: 'prior', filePath: 'src/orders.ts', lineStart: 3, lineEnd: 3,
        ruleKey: 'bugs/llm/review', severity: 'high', title: 'Prior', content: 'Prior issue.',
      }],
    };
    const delivery = {
      contract: INLINE_FULL_FILE_SOURCE_DELIVERY,
      sourceBindings: [{ promptPath: 'src/orders.ts', runtimePath: '/checkout/src/orders.ts' }],
      fileList: '=== src/orders.ts ===\n1: first\n2: second\n3: third',
    };

    expect(() => prepareInlineFullFileCodeViolationRequest(context, '/checkout', delivery))
      .toThrow(/lifecycle prior is outside its owned source range/i);
  });

  it('snapshots inline delivery fields before validating them', () => {
    const context: CodeViolationContext = {
      files: [{ path: 'src/orders.ts', content: 'export const order = true;' }],
      sourceScopes: [{ path: 'src/orders.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }],
      sources: [{ path: 'src/orders.ts', selection: { kind: 'full-file' } }],
      llmRules: [{ key: 'bugs/llm/review', name: 'Review', severity: 'high', prompt: 'Review it.' }],
      tier: 'full-file',
    };
    let sourceBindingReads = 0;
    const delivery = {
      contract: INLINE_FULL_FILE_SOURCE_DELIVERY,
      get sourceBindings() {
        sourceBindingReads += 1;
        return sourceBindingReads === 1
          ? [{ promptPath: 'src/orders.ts', runtimePath: '/checkout/src/orders.ts' }]
          : [];
      },
      get fileList() {
        return '=== src/orders.ts ===\n1: export const order = true;';
      },
    };

    const prepared = prepareInlineFullFileCodeViolationRequest(context, '/checkout', delivery);

    expect(sourceBindingReads).toBe(1);
    expect(prepared.sourceBindings).toEqual([
      { promptPath: 'src/orders.ts', runtimePath: '/checkout/src/orders.ts' },
    ]);
  });

  it('uses one context snapshot for inline validation and ownership', () => {
    let sourceScopeReads = 0;
    const context = {
      files: [{ path: 'src/orders.ts', content: 'export const order = true;' }],
      get sourceScopes() {
        sourceScopeReads += 1;
        return sourceScopeReads === 1
          ? [{ path: 'src/orders.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }]
          : [{ path: '../outside.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] }];
      },
      sources: [{ path: 'src/orders.ts', selection: { kind: 'full-file' as const } }],
      llmRules: [{ key: 'bugs/llm/review', name: 'Review', severity: 'high', prompt: 'Review it.' }],
      tier: 'full-file' as const,
    } satisfies CodeViolationContext;
    const delivery = {
      contract: INLINE_FULL_FILE_SOURCE_DELIVERY,
      sourceBindings: [{ promptPath: 'src/orders.ts', runtimePath: '/checkout/src/orders.ts' }],
      fileList: '=== src/orders.ts ===\n1: export const order = true;',
    };

    const prepared = prepareInlineFullFileCodeViolationRequest(context, '/checkout', delivery);

    expect(sourceScopeReads).toBe(1);
    expect(prepared.ownership.sourceScopes).toEqual([
      { path: 'src/orders.ts', ranges: [{ lineStart: 1, lineEnd: 1 }] },
    ]);
  });

  it('freezes a provider-independent targeted lifecycle request and its runtime bindings', () => {
    const context = targetedContext(true);
    const prepared = prepareCodeViolationRequest(context);
    const originalPrompt = prepared.prompt;

    context.files[0].content = 'mutated after preparation';
    context.llmRules[0].prompt = 'mutated rule';
    context.existingViolations![0].id = 'mutated-runtime-id';

    expect(prepared).toEqual(expect.objectContaining({
      stage: 'analyze.code-lifecycle',
      label: 'code-lifecycle',
      responseFormat: 'json',
      toolPolicy: 'none',
      timeoutMs: 300_000,
      resultContractId: 'analyze.code-lifecycle@1',
      prompt: originalPrompt,
      bindings: [{ promptId: 'cv-0', runtimeId: 'runtime-prior-id' }],
    }));
    expect(prepared.schemaJson).toContain('resolvedViolationIds');
    expect(prepared.prompt).toContain('[id: cv-0]');
    expect(prepared.prompt).not.toContain('runtime-prior-id');
    expect(prepared.prompt).not.toContain('mutated');
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.bindings)).toBe(true);
    expect(Object.isFrozen(prepared.bindings[0])).toBe(true);
    expect(Object.isFrozen(prepared.ownership)).toBe(true);
    expect(Object.isFrozen(prepared.ownership.sourceScopes)).toBe(true);
    expect(Object.isFrozen(prepared.ownership.sourceScopes[0].ranges[0])).toBe(true);
  });

  it('uses stable prompt-local source aliases for non-Read code work', () => {
    const prepared = prepareCodeViolationRequest(targetedContext());

    expect(prepared.sourceBindings).toEqual([
      { promptPath: 'file-0', runtimePath: 'src/orders.ts' },
    ]);
    expect(prepared.prompt).toContain('file-0');
    expect(prepared.prompt).not.toContain('src/orders.ts');
  });

  it('includes certified analysis configuration in the code work fingerprint', () => {
    const base = targetedContext();
    const changed = { ...targetedContext(), analysisInputFingerprint: 'sha256:changed' };
    const execution = { provider: 'claude-code', requestedModel: 'sonnet' } as const;

    const first = planCodeViolationWork(base, execution);
    const second = planCodeViolationWork(changed, execution);

    expect(second.inputFingerprint).not.toBe(first.inputFingerprint);
  });

  it('makes the provider execute the exact prepared targeted request', async () => {
    const context = targetedContext();
    const planned = planCodeViolationWork(context, {
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
    });
    const expected = planned.request;
    let captured: LlmRequest | undefined;
    const transport: LlmTransport = async (request) => {
      captured = request;
      return JSON.stringify({ violations: [] });
    };
    const provider = createLLMProvider(transport, 'sonnet');

    await expect(provider.generateCodeViolations(context)).resolves.toEqual({ violations: [] });

    expect(captured).toEqual({
      id: expect.stringMatching(/^llm\.code\.attempt:[a-f0-9-]{36}$/),
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      stage: expected.stage,
      user: expected.prompt,
      system: expected.system,
      schema: expected.schemaJson,
      responseFormat: expected.responseFormat,
      model: 'sonnet',
      timeoutMs: expected.timeoutMs,
    });
  });

  it('certifies an in-flight lifecycle result against the prepared ownership snapshot', async () => {
    const context = targetedContext(true);
    const planned = planCodeViolationWork(context, {
      provider: 'transport:unverified',
      requestedModel: 'sonnet',
    });
    const expected = planned.request;
    let captured: LlmRequest | undefined;
    let started!: () => void;
    let release!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const canFinish = new Promise<void>((resolve) => { release = resolve; });
    const transport: LlmTransport = async (request) => {
      captured = request;
      started();
      await canFinish;
      return JSON.stringify({
        resolvedViolationIds: [],
        unchangedViolationIds: ['cv-0'],
        newViolations: [{
          ruleKey: 'reliability/llm/async-boundary',
          filePath: 'file-0',
          lineStart: 1,
          lineEnd: 3,
          severity: 'high',
          title: 'A second async problem',
          content: 'The function also loses cancellation.',
          fixPrompt: null,
        }],
      });
    };
    const provider = createLLMProvider(transport, 'sonnet');
    const execution = provider.generateCodeViolations(context);

    await didStart;
    context.tier = 'metadata';
    context.llmRules[0].key = 'mutated/llm/rule';
    context.sourceScopes[0].path = 'src/mutated.ts';
    context.existingViolations![0].title = 'Mutated prior title';
    release();

    await expect(execution).resolves.toEqual({
      violations: [expect.objectContaining({
        ruleKey: 'reliability/llm/async-boundary',
        filePath: 'src/orders.ts',
        sourceTier: 'targeted',
      })],
      resolvedViolationIds: [],
      unchangedViolationIds: ['runtime-prior-id'],
    });
    expect(captured).toEqual({
      id: expect.stringMatching(/^llm\.code\.attempt:[a-f0-9-]{36}$/),
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      stage: expected.stage,
      user: expected.prompt,
      system: expected.system,
      schema: expected.schemaJson,
      responseFormat: expected.responseFormat,
      model: 'sonnet',
      timeoutMs: expected.timeoutMs,
    });
  });
});
