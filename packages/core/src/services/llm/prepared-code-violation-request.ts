import type { CodeViolationContext } from './provider.js';
import { buildCodeTemplateVars, getPrompt } from './prompts.js';
import {
  serializePreparedRequestSchema,
  type PreparedLlmRequest,
  type PreparedPromptBinding,
} from './prepared-request.js';
import {
  CodeViolationLifecycleOutputSchema,
  CodeViolationOutputSchema,
} from './schemas.js';

export interface PreparedCodeOwnership {
  readonly tier: 'metadata' | 'targeted' | 'full-file';
  readonly fileCount: number;
  readonly ruleKeys: readonly string[];
  readonly sourceScopes: readonly {
    readonly path: string;
    readonly ranges: readonly { readonly lineStart: number; readonly lineEnd: number }[];
  }[];
  readonly priorFindings: readonly {
    readonly ruleKey: string;
    readonly filePath: string;
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly title: string;
  }[];
}

/** Maps stable prompt-local paths back to the repository paths they represent. */
export interface PreparedCodeSourceBinding {
  readonly promptPath: string;
  readonly runtimePath: string;
}

export type CodeViolationOutput = ReturnType<typeof CodeViolationOutputSchema.parse>;
export type CodeViolationLifecycleOutput = ReturnType<typeof CodeViolationLifecycleOutputSchema.parse>;

export type PreparedCodeViolationRequest =
  | (PreparedLlmRequest<CodeViolationOutput> & {
      readonly stage: 'analyze.code';
      readonly label: 'code';
      readonly resultContractId: 'analyze.code@1';
      readonly system: '';
      readonly responseFormat: 'json';
      readonly timeoutMs: 300_000;
      readonly bindings: readonly PreparedPromptBinding[];
      readonly sourceBindings: readonly PreparedCodeSourceBinding[];
      readonly ownership: PreparedCodeOwnership;
    })
  | (PreparedLlmRequest<CodeViolationLifecycleOutput> & {
      readonly stage: 'analyze.code-lifecycle';
      readonly label: 'code-lifecycle';
      readonly resultContractId: 'analyze.code-lifecycle@1';
      readonly system: '';
      readonly responseFormat: 'json';
      readonly timeoutMs: 300_000;
      readonly bindings: readonly PreparedPromptBinding[];
      readonly sourceBindings: readonly PreparedCodeSourceBinding[];
      readonly ownership: PreparedCodeOwnership;
    });

export function codeViolationToolPolicy(
  context: CodeViolationContext,
): PreparedCodeViolationRequest['toolPolicy'] {
  return context.files.length > 0 && context.files.every((file) => file.path !== 'context')
    ? 'read'
    : 'none';
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function prepareSourceBindings(
  context: CodeViolationContext,
  toolPolicy: PreparedCodeViolationRequest['toolPolicy'],
): readonly PreparedCodeSourceBinding[] {
  if (toolPolicy === 'read') return Object.freeze([]);
  const paths = [...new Set(context.sourceScopes.map((scope) => scope.path))].sort(compareText);
  return Object.freeze(paths.map((runtimePath, index) => Object.freeze({
    promptPath: `file-${index}`,
    runtimePath,
  })));
}

/** Replace generated code-context header paths only; source text is left untouched. */
export function bindCodeSourceHeaderAliases(
  content: string,
  sourceBindings: readonly PreparedCodeSourceBinding[],
): string {
  if (sourceBindings.length === 0) return content;
  const longestPathsFirst = [...sourceBindings].sort(
    (left, right) => right.runtimePath.length - left.runtimePath.length
      || compareText(left.runtimePath, right.runtimePath),
  );
  return content.split('\n').map((line) => {
    for (const { promptPath, runtimePath } of longestPathsFirst) {
      const prefix = `=== ${runtimePath}`;
      if (!line.startsWith(prefix)) continue;
      const suffix = line.slice(prefix.length);
      if (suffix === ' ===' || /^ \(lines \d+-\d+\) ===$/.test(suffix)) {
        return `=== ${promptPath}${suffix}`;
      }
    }
    return line;
  }).join('\n');
}

function bindSourceAliases(
  context: CodeViolationContext,
  sourceBindings: readonly PreparedCodeSourceBinding[],
): CodeViolationContext {
  if (sourceBindings.length === 0) return context;
  const promptPathByRuntime = new Map(
    sourceBindings.map(({ promptPath, runtimePath }) => [runtimePath, promptPath]),
  );
  return {
    ...context,
    files: context.files.map((file) => ({
      path: promptPathByRuntime.get(file.path) ?? file.path,
      content: bindCodeSourceHeaderAliases(file.content, sourceBindings),
    })),
    sourceScopes: context.sourceScopes.map((scope) => ({
      ...scope,
      path: promptPathByRuntime.get(scope.path) ?? scope.path,
    })),
    sources: context.sources?.map((source) => ({
      ...source,
      path: promptPathByRuntime.get(source.path) ?? source.path,
    })),
    existingViolations: context.existingViolations?.map((violation) => ({
      ...violation,
      filePath: promptPathByRuntime.get(violation.filePath) ?? violation.filePath,
    })),
  };
}

/**
 * Capture every provider-independent input used by one code-check request.
 * The returned snapshot can later be fingerprinted without reconstructing the
 * prompt or schema inside a provider adapter.
 */
export function prepareCodeViolationRequest(
  context: CodeViolationContext,
): PreparedCodeViolationRequest {
  const lifecycle = (context.existingViolations?.length ?? 0) > 0;
  const toolPolicy = codeViolationToolPolicy(context);
  const sourceBindings = prepareSourceBindings(context, toolPolicy);
  const promptContext = bindSourceAliases(context, sourceBindings);
  const promptName = context.tier === 'metadata'
    ? lifecycle ? 'violations-code-metadata-lifecycle' : 'violations-code-metadata'
    : context.tier === 'targeted'
      ? lifecycle ? 'violations-code-targeted-lifecycle' : 'violations-code-targeted'
      : lifecycle ? 'violations-code-lifecycle' : 'violations-code';
  const { vars, idMap } = buildCodeTemplateVars(promptContext, { useFilePaths: toolPolicy === 'read' });
  const bindings = Object.freeze(
    [...idMap.entries()].map(([promptId, runtimeId]) =>
      Object.freeze({ promptId, runtimeId })),
  );
  const ownership = Object.freeze({
    tier: promptContext.tier ?? 'full-file',
    fileCount: promptContext.files.length,
    ruleKeys: Object.freeze(promptContext.llmRules.map((rule) => rule.key)),
    sourceScopes: Object.freeze(promptContext.sourceScopes.map((scope) => Object.freeze({
      path: scope.path,
      ranges: Object.freeze(scope.ranges.map((range) => Object.freeze({
        lineStart: range.lineStart,
        lineEnd: range.lineEnd,
      }))),
    }))),
    priorFindings: Object.freeze((promptContext.existingViolations ?? []).map((violation) => Object.freeze({
      ruleKey: violation.ruleKey,
      filePath: violation.filePath,
      lineStart: violation.lineStart,
      lineEnd: violation.lineEnd,
      title: violation.title,
    }))),
  });
  const common = {
    system: '',
    prompt: getPrompt(promptName, vars),
    responseFormat: 'json',
    toolPolicy,
    timeoutMs: 300_000,
    bindings,
    sourceBindings,
    ownership,
  } as const;

  if (lifecycle) {
    const parse = CodeViolationLifecycleOutputSchema.parse.bind(CodeViolationLifecycleOutputSchema);
    return Object.freeze({
      ...common,
      stage: 'analyze.code-lifecycle',
      label: 'code-lifecycle',
      schemaJson: serializePreparedRequestSchema(CodeViolationLifecycleOutputSchema),
      resultContractId: 'analyze.code-lifecycle@1',
      parse: Object.freeze((value: unknown) => parse(value)),
    });
  }

  const parse = CodeViolationOutputSchema.parse.bind(CodeViolationOutputSchema);
  return Object.freeze({
    ...common,
    stage: 'analyze.code',
    label: 'code',
    schemaJson: serializePreparedRequestSchema(CodeViolationOutputSchema),
    resultContractId: 'analyze.code@1',
    parse: Object.freeze((value: unknown) => parse(value)),
  });
}
