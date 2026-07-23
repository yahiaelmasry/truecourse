import path from 'node:path';
import type { CodeViolationContext } from './provider.js';
import { buildCodeTemplateVars, formatInlineCodeFileList, getPrompt } from './prompts.js';
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

export const INLINE_FULL_FILE_SOURCE_DELIVERY = Object.freeze({ kind: 'inline-full-file@1' as const });
export interface InlineFullFileSourceDelivery {
  readonly contract: typeof INLINE_FULL_FILE_SOURCE_DELIVERY;
  readonly sourceBindings: readonly PreparedCodeSourceBinding[];
  readonly fileList: string;
}

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
  inline?: InlineFullFileSourceDelivery,
): PreparedCodeViolationRequest['toolPolicy'] {
  if (inline?.contract === INLINE_FULL_FILE_SOURCE_DELIVERY) return 'none';
  return context.files.length > 0 && context.files.every((file) => file.path !== 'context')
    ? 'read'
    : 'none';
}

function snapshotInlineFullFileContext(context: CodeViolationContext): CodeViolationContext {
  const sources = context.sources;
  return {
    analysisInputFingerprint: context.analysisInputFingerprint,
    files: context.files.map((file) => ({ path: file.path, content: file.content })),
    sourceScopes: context.sourceScopes.map((scope) => ({
      path: scope.path,
      ranges: scope.ranges.map((range) => ({ lineStart: range.lineStart, lineEnd: range.lineEnd })),
    })),
    sources: sources?.map((source) => ({
      path: source.path,
      selection: source.selection.kind === 'metadata'
        ? { kind: 'metadata', fields: [...source.selection.fields] }
        : source.selection.kind === 'targeted'
          ? {
              kind: 'targeted',
              functions: source.selection.functions.map((fn) => ({ ...fn })),
            }
          : { kind: 'full-file' },
    })),
    llmRules: context.llmRules.map((rule) => ({ ...rule })),
    tier: context.tier,
    existingViolations: context.existingViolations?.map((violation) => ({ ...violation })),
  };
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function isPortableAbsolutePath(value: string): boolean {
  const portable = value.replaceAll('\\', '/');
  return path.posix.isAbsolute(portable) || /^[a-z]:\//i.test(portable);
}

function portableRepositoryRoot(repositoryRoot: string): string {
  const portable = repositoryRoot.replaceAll('\\', '/');
  if (/^[a-z]:\/+$/i.test(portable)) return `${portable.slice(0, 2)}/`;
  return portable.replace(/\/+$/, '') || '/';
}

/** Build a runtime binding without making a Windows drive root host-dependent. */
export function runtimePathForRepositoryRoot(repositoryRoot: string, promptPath: string): string {
  const portableRoot = portableRepositoryRoot(repositoryRoot);
  if (!isPortableAbsolutePath(portableRoot)) {
    throw new Error(`Read-enabled code work requires an absolute repository root: ${repositoryRoot}`);
  }
  if (/^[a-z]:\//i.test(portableRoot)) {
    return `${portableRoot}${portableRoot.endsWith('/') ? '' : '/'}${promptPath}`;
  }
  return path.resolve(repositoryRoot, promptPath);
}

function runtimePathForPortablePrompt(repositoryRoot: string, promptPath: string): string {
  if (promptPath === '.' || promptPath === '..' || promptPath.startsWith('../')) {
    throw new Error(`Read-enabled code source is outside the repository root: ${promptPath}`);
  }
  return runtimePathForRepositoryRoot(repositoryRoot, promptPath);
}

function prepareReadSourceBindings(
  context: CodeViolationContext,
  repositoryRoot?: string | null,
): readonly PreparedCodeSourceBinding[] {
  if (!repositoryRoot) return Object.freeze([]);
  const promptPaths = [...new Set(context.sourceScopes.map((scope) => scope.path))].sort(compareText);
  const expectedPaths = new Set(promptPaths);
  const files = context.files.map((file) => file.path);
  const sources = context.sources?.map((source) => source.path) ?? promptPaths;
  if (
    files.length !== expectedPaths.size
    || sources.length !== expectedPaths.size
    || files.some((filePath) => !expectedPaths.has(filePath))
    || sources.some((sourcePath) => !expectedPaths.has(sourcePath))
  ) {
    throw new Error('Read-enabled code prompt and ownership source sets do not match');
  }
  if ((context.existingViolations ?? []).some((violation) => !expectedPaths.has(violation.filePath))) {
    throw new Error('Read-enabled code lifecycle prior is outside its source set');
  }
  return Object.freeze(promptPaths.map((promptPath) => Object.freeze({
    promptPath,
    runtimePath: runtimePathForPortablePrompt(repositoryRoot, promptPath),
  })));
}

function prepareSourceBindings(
  context: CodeViolationContext,
  toolPolicy: PreparedCodeViolationRequest['toolPolicy'],
  repositoryRoot?: string | null,
  inline?: InlineFullFileSourceDelivery,
): readonly PreparedCodeSourceBinding[] {
  if (inline) return Object.freeze(inline.sourceBindings.map((binding) => Object.freeze({ ...binding })));
  if (toolPolicy === 'read') return prepareReadSourceBindings(context, repositoryRoot);
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
  repositoryRoot?: string | null,
): PreparedCodeViolationRequest {
  return prepareCodeViolationRequestInternal(context, repositoryRoot);
}

/** @internal Inline delivery is compiler/planner-owned and is not a general preparation option. */
export function prepareInlineFullFileCodeViolationRequest(
  context: CodeViolationContext,
  repositoryRoot: string,
  inline: InlineFullFileSourceDelivery,
): PreparedCodeViolationRequest {
  const snapshot = snapshotInlineFullFileContext(context);
  const delivery: InlineFullFileSourceDelivery = Object.freeze({
    contract: inline.contract,
    fileList: inline.fileList,
    sourceBindings: Object.freeze(inline.sourceBindings.map((binding) => Object.freeze({
      promptPath: binding.promptPath,
      runtimePath: binding.runtimePath,
    }))),
  });
  if (delivery.contract !== INLINE_FULL_FILE_SOURCE_DELIVERY) {
    throw new Error('Inline code delivery requires the compiler-owned contract');
  }
  if (!(/^(?:\/|[a-z]:\/)/i.test(repositoryRoot.replaceAll('\\', '/')))) {
    throw new Error('Inline code delivery requires an absolute repository root');
  }
  const sources = snapshot.sources ?? snapshot.sourceScopes.map((scope) => ({
    path: scope.path, selection: { kind: 'full-file' as const },
  }));
  if (snapshot.tier !== 'full-file' || sources.some((source) => source.selection.kind !== 'full-file')) {
    throw new Error('Inline code delivery requires complete full-file sources');
  }
  const safeRelativePath = (value: string): boolean => {
    const portable = value.replaceAll('\\', '/');
    return portable.length > 0
      && portable !== '.'
      && !path.posix.isAbsolute(portable)
      && !/^[a-z]:\//i.test(portable)
      && !/^[a-z]:(?!\/)/i.test(portable)
      && portable !== '..'
      && !portable.startsWith('../')
      && path.posix.normalize(portable) === portable;
  };
  const sameExactPaths = (values: readonly string[], expected: readonly string[]): boolean => {
    const sorted = [...values].sort(compareText);
    return sorted.length === expected.length
      && new Set(sorted).size === sorted.length
      && sorted.every((value, index) => value === expected[index]);
  };
  const paths = snapshot.files.map((file) => file.path).sort(compareText);
  if (
    paths.length === 0
    || !paths.every(safeRelativePath)
    || !sameExactPaths(snapshot.sourceScopes.map((scope) => scope.path), paths)
    || !sameExactPaths(sources.map((source) => source.path), paths)
  ) {
    throw new Error('Inline code delivery requires exact non-empty repository-relative file, source, and scope sets');
  }
  if ((snapshot.existingViolations ?? []).some((violation) => !paths.includes(violation.filePath))) {
    throw new Error('Inline code delivery lifecycle prior is outside its source set');
  }
  const scopeOwnsRange = (filePath: string, lineStart: number, lineEnd: number): boolean =>
    snapshot.sourceScopes.some((scope) => scope.path === filePath && scope.ranges.some((range) =>
      lineStart >= range.lineStart && lineEnd <= range.lineEnd));
  if ((snapshot.existingViolations ?? []).some((violation) =>
    !scopeOwnsRange(violation.filePath, violation.lineStart, violation.lineEnd))) {
    throw new Error('Inline code delivery lifecycle prior is outside its owned source range');
  }
  const expectedBindings = paths.map((promptPath) => ({
    promptPath,
    runtimePath: runtimePathForRepositoryRoot(repositoryRoot, promptPath),
  }));
  if (JSON.stringify(delivery.sourceBindings) !== JSON.stringify(expectedBindings)) {
    throw new Error('Inline code delivery bindings do not match its full-file sources');
  }
  const expectedFileList = formatInlineCodeFileList(snapshot.files);
  if (delivery.fileList !== expectedFileList) {
    throw new Error('Inline code delivery text does not match its full-file sources');
  }
  return prepareCodeViolationRequestInternal(snapshot, repositoryRoot, delivery);
}

function prepareCodeViolationRequestInternal(
  context: CodeViolationContext,
  repositoryRoot?: string | null,
  inline?: InlineFullFileSourceDelivery,
): PreparedCodeViolationRequest {
  const lifecycle = (context.existingViolations?.length ?? 0) > 0;
  const toolPolicy = codeViolationToolPolicy(context, inline);
  const sourceBindings = prepareSourceBindings(context, toolPolicy, repositoryRoot, inline);
  const promptContext = bindSourceAliases(context, sourceBindings);
  const promptName = context.tier === 'metadata'
    ? lifecycle ? 'violations-code-metadata-lifecycle' : 'violations-code-metadata'
    : context.tier === 'targeted'
      ? lifecycle ? 'violations-code-targeted-lifecycle' : 'violations-code-targeted'
      : lifecycle ? 'violations-code-lifecycle' : 'violations-code';
  const { vars, idMap } = buildCodeTemplateVars(promptContext, {
    useFilePaths: toolPolicy === 'read',
    preframedInlineContent: inline?.fileList,
  });
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
