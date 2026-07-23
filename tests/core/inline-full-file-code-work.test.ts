import { describe, expect, it } from 'vitest';
import { compileInlineFullFileCodeWork } from '../../packages/core/src/services/llm/inline-full-file-code-work.js';
import { materializePlannedViolationResult } from '../../packages/core/src/services/llm/planned-violation-result.js';
import type { CertifiedAnalyzeLlmWork } from '../../packages/core/src/services/llm/certified-analyze-llm-run.js';
import type { CodeViolationContext } from '../../packages/core/src/services/llm/provider.js';

const execution = {
  provider: 'claude-code',
  requestedModel: 'sonnet',
  repositoryRoot: '/checkout/one',
} as const;

function context(root: string, content = 'export const order = true;'): CodeViolationContext {
  const sourcePath = `${root}/src/orders.ts`;
  return {
    files: [{ path: sourcePath, content }],
    sourceScopes: [{ path: sourcePath, ranges: [{ lineStart: 1, lineEnd: 1 }] }],
    sources: [{ path: sourcePath, selection: { kind: 'full-file' } }],
    llmRules: [{ key: 'bugs/llm/review', name: 'Review', severity: 'high', prompt: 'Review it.' }],
    tier: 'full-file',
  };
}

describe('inline full-file code work compiler', () => {
  it('creates a portable tool-free request while retaining the runtime result binding', () => {
    const compiled = compileInlineFullFileCodeWork(context('/checkout/one'), execution);
    const relocated = compileInlineFullFileCodeWork(context('/different/checkout'), {
      ...execution,
      repositoryRoot: '/different/checkout',
    });

    expect(compiled.request.toolPolicy).toBe('none');
    expect(compiled.request.prompt).toContain('=== src/orders.ts ===\n1: export const order = true;');
    expect(compiled.request.prompt).not.toContain('/checkout/one');
    expect(compiled.request.sourceBindings).toEqual([
      { promptPath: 'src/orders.ts', runtimePath: '/checkout/one/src/orders.ts' },
    ]);
    expect(relocated.request.sourceBindings).toEqual([
      { promptPath: 'src/orders.ts', runtimePath: '/different/checkout/src/orders.ts' },
    ]);
    expect(compiled.workId).toBe(relocated.workId);
    expect(compiled.inputFingerprint).toBe(relocated.inputFingerprint);
  });

  it('binds the exact supplied content into the request fingerprint', () => {
    const initial = compileInlineFullFileCodeWork(context('/checkout/one'), execution);
    const changed = compileInlineFullFileCodeWork(
      context('/checkout/one', 'export const order = false;'),
      execution,
    );

    expect(changed.workId).toBe(initial.workId);
    expect(changed.inputFingerprint).not.toBe(initial.inputFingerprint);
  });

  it('keeps template-looking text from supplied source literal', () => {
    const compiled = compileInlineFullFileCodeWork(
      context('/checkout/one', "export const marker = '{{existingViolations}}';"),
      execution,
    );

    expect(compiled.request.prompt).toContain("export const marker = '{{existingViolations}}';");
  });

  it('rejects source selections that are not complete files', () => {
    const invalid = context('/checkout/one');
    invalid.sources = [{
      path: '/checkout/one/src/orders.ts',
      selection: { kind: 'targeted', functions: [] },
    }];

    expect(() => compileInlineFullFileCodeWork(invalid, execution))
      .toThrow(/full-file source selections/i);
  });

  it('rejects a full-file context when no repository-root bindings can be resolved', () => {
    expect(() => compileInlineFullFileCodeWork(context('src'), {
      provider: 'claude-code', requestedModel: 'sonnet',
    })).toThrow(/exact Read source bindings/i);
  });

  it('materializes an inline prompt path back to its runtime checkout file', () => {
    const planned = compileInlineFullFileCodeWork(context('/checkout/one'), execution);
    const work = {
      family: 'code', domain: 'bugs', mode: 'normal',
      workId: planned.workId, inputFingerprint: planned.inputFingerprint, planned,
    } as CertifiedAnalyzeLlmWork;

    const materialized = materializePlannedViolationResult({
      work,
      result: { violations: [{
        ruleKey: 'bugs/llm/review', filePath: 'src/orders.ts', lineStart: 1, lineEnd: 1,
        severity: 'high', title: 'Issue', content: 'Fix it.', fixPrompt: null,
      }] },
    }, { createId: () => 'unused', createdAt: () => '2026-07-23T00:00:00.000Z' });

    expect(materialized.result).toEqual({
      violations: [expect.objectContaining({ filePath: '/checkout/one/src/orders.ts' })],
    });
  });

  it('accepts repository-relative source paths with a portable Windows root', () => {
    const relative = context('');
    relative.files[0].path = 'src/orders.ts';
    relative.sourceScopes[0].path = 'src/orders.ts';
    relative.sources![0].path = 'src/orders.ts';

    expect(compileInlineFullFileCodeWork(relative, {
      provider: 'claude-code', requestedModel: 'sonnet', repositoryRoot: 'C:/checkout',
    }).request.sourceBindings).toEqual([
      { promptPath: 'src/orders.ts', runtimePath: 'C:/checkout/src/orders.ts' },
    ]);
  });

  it('matches Windows source paths and a differently-cased root portably', () => {
    const compiled = compileInlineFullFileCodeWork(context('c:\\checkout'), {
      provider: 'claude-code', requestedModel: 'sonnet', repositoryRoot: 'C:\\checkout',
    });

    expect(compiled.request.sourceBindings).toEqual([
      { promptPath: 'src/orders.ts', runtimePath: 'C:/checkout/src/orders.ts' },
    ]);
  });

  it('keeps a Windows drive root absolute in its result binding', () => {
    const compiled = compileInlineFullFileCodeWork(context('C:'), {
      provider: 'claude-code', requestedModel: 'sonnet', repositoryRoot: 'C:/',
    });

    expect(compiled.request.sourceBindings).toEqual([
      { promptPath: 'src/orders.ts', runtimePath: 'C:/src/orders.ts' },
    ]);
  });
});
