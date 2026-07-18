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

type CodeViolationOutput = ReturnType<typeof CodeViolationOutputSchema.parse>;
type CodeViolationLifecycleOutput = ReturnType<typeof CodeViolationLifecycleOutputSchema.parse>;

export type PreparedCodeViolationRequest =
  | (PreparedLlmRequest<CodeViolationOutput> & {
      readonly stage: 'analyze.code';
      readonly label: 'code';
      readonly resultContractId: 'analyze.code@1';
      readonly system: '';
      readonly responseFormat: 'json';
      readonly timeoutMs: 300_000;
      readonly bindings: readonly PreparedPromptBinding[];
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
      readonly ownership: PreparedCodeOwnership;
    });

/**
 * Capture every provider-independent input used by one code-check request.
 * The returned snapshot can later be fingerprinted without reconstructing the
 * prompt or schema inside a provider adapter.
 */
export function prepareCodeViolationRequest(
  context: CodeViolationContext,
): PreparedCodeViolationRequest {
  const lifecycle = (context.existingViolations?.length ?? 0) > 0;
  const fullFile = context.files.length > 0 && context.files.every((file) => file.path !== 'context');
  const promptName = context.tier === 'metadata'
    ? lifecycle ? 'violations-code-metadata-lifecycle' : 'violations-code-metadata'
    : context.tier === 'targeted'
      ? lifecycle ? 'violations-code-targeted-lifecycle' : 'violations-code-targeted'
      : lifecycle ? 'violations-code-lifecycle' : 'violations-code';
  const { vars, idMap } = buildCodeTemplateVars(context, { useFilePaths: fullFile });
  const bindings = Object.freeze(
    [...idMap.entries()].map(([promptId, runtimeId]) =>
      Object.freeze({ promptId, runtimeId })),
  );
  const ownership = Object.freeze({
    tier: context.tier ?? 'full-file',
    fileCount: context.files.length,
    ruleKeys: Object.freeze(context.llmRules.map((rule) => rule.key)),
    sourceScopes: Object.freeze(context.sourceScopes.map((scope) => Object.freeze({
      path: scope.path,
      ranges: Object.freeze(scope.ranges.map((range) => Object.freeze({
        lineStart: range.lineStart,
        lineEnd: range.lineEnd,
      }))),
    }))),
    priorFindings: Object.freeze((context.existingViolations ?? []).map((violation) => Object.freeze({
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
    toolPolicy: fullFile ? 'read' : 'none',
    timeoutMs: 300_000,
    bindings,
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
