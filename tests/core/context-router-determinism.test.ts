import { describe, expect, it } from 'vitest';
import type { AnalysisRule, FileAnalysis } from '@truecourse/shared';
import { routeContext } from '../../packages/core/src/services/llm/context-router.js';

function targetedRule(key: string): AnalysisRule {
  return {
    key,
    name: key,
    severity: 'high',
    prompt: `Check ${key}.`,
    category: 'code',
    type: 'llm',
    contextRequirement: {
      tier: 'targeted',
      fileFilter: { languages: ['typescript'] },
      functionFilter: { isAsync: true },
    },
  } as unknown as AnalysisRule;
}

function functionAnalysis(name: string, startLine: number, endLine: number) {
  return {
    name,
    isAsync: true,
    isExported: true,
    params: [],
    returnType: 'Promise<void>',
    location: { startLine, endLine },
  };
}

function fileAnalysis(filePath: string, functions: ReturnType<typeof functionAnalysis>[]): FileAnalysis {
  return {
    filePath,
    language: 'typescript',
    functions,
    classes: [],
    imports: [],
    exports: [],
    calls: [],
    httpCalls: [],
    routeRegistrations: [],
  } as unknown as FileAnalysis;
}

describe('context router determinism', () => {
  it('produces the same targeted work when rule, file, and function inputs are permuted', () => {
    const aPath = '/repo/src/a.ts';
    const zPath = '/repo/src/z.ts';
    const aContent = [
      'export async function alpha() {',
      '  await saveAlpha();',
      '}',
      '',
      'export async function beta() {',
      '  await saveBeta();',
      '}',
    ].join('\n');
    const zContent = [
      'export async function zebra() {',
      '  await saveZebra();',
      '}',
    ].join('\n');
    const alpha = functionAnalysis('alpha', 1, 3);
    const beta = functionAnalysis('beta', 5, 7);
    const zebra = functionAnalysis('zebra', 1, 3);
    const a = fileAnalysis(aPath, [alpha, beta]);
    const aPermuted = fileAnalysis(aPath, [beta, alpha]);
    const z = fileAnalysis(zPath, [zebra]);
    const firstRule = targetedRule('reliability/llm/async-boundary');
    const secondRule = targetedRule('security/llm/async-boundary');
    const contents = new Map([
      [zPath, { content: zContent, lineCount: 3 }],
      [aPath, { content: aContent, lineCount: 7 }],
    ]);

    const first = routeContext(
      [secondRule, firstRule],
      [z, aPermuted],
      contents,
    );
    const second = routeContext(
      [firstRule, secondRule],
      [a, z],
      new Map([...contents.entries()].reverse()),
    );

    expect(first).toEqual(second);
    expect(first[0]?.rules.map((rule) => rule.key)).toEqual([
      'reliability/llm/async-boundary',
      'security/llm/async-boundary',
    ]);
    expect(first[0]?.sources.map((source) => source.path)).toEqual([aPath, zPath]);
    expect(first[0]?.sources[0]).toEqual({
      path: aPath,
      selection: {
        kind: 'targeted',
        functions: [
          { name: 'alpha', startLine: 1, endLine: 3 },
          { name: 'beta', startLine: 5, endLine: 7 },
        ],
      },
    });
  });

  it('canonicalizes set-like context filters and metadata collections before rendering', () => {
    const filePath = '/repo/src/orders.ts';
    const rule = (key: string, languages: string[], metadataFields: Array<'imports' | 'exports'>) => ({
      key,
      name: key,
      severity: 'medium',
      prompt: `Check ${key}.`,
      category: 'code',
      type: 'llm',
      contextRequirement: {
        tier: 'metadata',
        fileFilter: {
          languages,
          hasImportsFrom: ['./db.js', './audit.js'],
        },
        metadataFields,
      },
    }) as unknown as AnalysisRule;
    const analysis = (reverse: boolean) => ({
      filePath,
      language: 'typescript',
      functions: [],
      classes: [],
      imports: reverse
        ? [{ source: './db.js' }, { source: './audit.js' }]
        : [{ source: './audit.js' }, { source: './db.js' }],
      exports: reverse
        ? [{ name: 'saveOrder', isDefault: false }, { name: 'Order', isDefault: false }]
        : [{ name: 'Order', isDefault: false }, { name: 'saveOrder', isDefault: false }],
      calls: [],
      httpCalls: [],
      routeRegistrations: [],
    }) as unknown as FileAnalysis;
    const contents = new Map([
      [filePath, { content: "import './db.js';\nimport './audit.js';\n", lineCount: 2 }],
    ]);

    const first = routeContext(
      [
        rule('security/llm/imports', ['typescript', 'javascript'], ['exports', 'imports']),
        rule('architecture/llm/imports', ['javascript', 'typescript'], ['imports', 'exports']),
      ],
      [analysis(false)],
      contents,
    );
    const second = routeContext(
      [
        rule('architecture/llm/imports', ['typescript', 'javascript'], ['exports', 'imports']),
        rule('security/llm/imports', ['javascript', 'typescript'], ['imports', 'exports']),
      ],
      [analysis(true)],
      contents,
    );

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]?.rules.map((entry) => entry.key)).toEqual([
      'architecture/llm/imports',
      'security/llm/imports',
    ]);
  });
});
