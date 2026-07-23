import path from 'node:path';
import type {
  CodeContextSource,
  CodeSourceScope,
  CodeViolationContext,
} from './provider.js';
import {
  bindCodeSourceHeaderAliases,
  prepareCodeViolationRequest,
  type PreparedCodeViolationRequest,
} from './prepared-code-violation-request.js';
import {
  assertUniqueLlmIdentity,
  canonicalJson,
  compareCanonicalText as compareText,
  fingerprint,
  type LlmWorkComponentFingerprints,
  type LlmWorkExecutionIntent,
} from './work-identity.js';

export interface CodeWorkExecutionIntent extends LlmWorkExecutionIntent {
  readonly provider: string;
  readonly requestedModel: string | null;
  readonly repositoryRoot?: string | null;
}

export type CodeWorkComponentFingerprints = LlmWorkComponentFingerprints;

export interface PlannedCodeViolationWork {
  readonly workId: string;
  readonly inputFingerprint: string;
  readonly componentFingerprints: CodeWorkComponentFingerprints;
  readonly request: PreparedCodeViolationRequest;
}

function normalizeRepositoryPath(filePath: string, repositoryRoot?: string | null): string {
  const normalizePortablePath = (value: string): string => {
    const portable = value.replaceAll('\\', '/');
    const driveAbsolute = /^([a-z]):(\/.*)$/i.exec(portable);
    if (driveAbsolute) {
      return `${driveAbsolute[1].toLowerCase()}:${path.posix.normalize(driveAbsolute[2])}`;
    }
    return path.posix.normalize(portable);
  };
  const isAbsolute = (value: string): boolean => path.posix.isAbsolute(value) || /^[a-z]:\//i.test(value);
  const portableInput = filePath.replaceAll('\\', '/');

  // Check before normalization: `C:temp/../foo.ts` otherwise collapses to
  // `foo.ts` and loses the drive-relative process-state dependency.
  if (/^[a-z]:(?!\/)/i.test(portableInput)) {
    throw new Error(`Code work path is outside repository root: ${filePath}`);
  }

  const normalizedPath = normalizePortablePath(filePath);

  if (repositoryRoot == null) {
    if (isAbsolute(normalizedPath)
      || normalizedPath === '..'
      || normalizedPath.startsWith('../')) {
      throw new Error(`Code work path is outside repository root: ${filePath}`);
    }
    return normalizedPath.replace(/^\.\//, '');
  }

  const normalizedRoot = normalizePortablePath(repositoryRoot);

  if (!isAbsolute(normalizedPath)) {
    if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
      throw new Error(`Code work path is outside repository root: ${filePath}`);
    }
    return normalizedPath.replace(/^\.\//, '');
  }

  if (normalizedPath === normalizedRoot) return '.';
  const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(rootPrefix)) {
    throw new Error(`Code work path is outside repository root: ${filePath}`);
  }
  return normalizedPath.slice(rootPrefix.length);
}

function assertUnique(values: readonly string[], description: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Code work contains duplicate ${description}: ${value}`);
    seen.add(value);
  }
}

function canonicalRanges(ranges: CodeSourceScope['ranges']): Array<{ lineStart: number; lineEnd: number }> {
  const canonical = ranges
    .map(({ lineStart, lineEnd }) => ({ lineStart, lineEnd }))
    .sort((left, right) => left.lineStart - right.lineStart || left.lineEnd - right.lineEnd);
  assertUnique(canonical.map(({ lineStart, lineEnd }) => `${lineStart}:${lineEnd}`), 'code source range');
  return canonical;
}

function canonicalSelection(selection: CodeContextSource['selection']): CodeContextSource['selection'] {
  if (selection.kind === 'metadata') {
    return { kind: 'metadata', fields: [...selection.fields].sort(compareText) };
  }
  if (selection.kind === 'targeted') {
    return {
      kind: 'targeted',
      functions: selection.functions
        .map((fn) => ({ ...fn }))
        .sort((left, right) =>
          left.startLine - right.startLine
          || left.endLine - right.endLine
          || compareText(left.name, right.name)),
    };
  }
  return { kind: 'full-file' };
}

function canonicalSources(
  context: CodeViolationContext,
  repositoryRoot?: string | null,
): CodeContextSource[] {
  const fallbackSelection = (): CodeContextSource['selection'] => {
    if (context.tier === 'metadata') return { kind: 'metadata', fields: [] };
    if (context.tier === 'targeted') return { kind: 'targeted', functions: [] };
    return { kind: 'full-file' };
  };
  const supplied: CodeContextSource[] = context.sources ?? context.sourceScopes.map((scope) => ({
    path: scope.path,
    selection: fallbackSelection(),
  }));
  const canonical = supplied.map((source) => ({
    path: normalizeRepositoryPath(source.path, repositoryRoot),
    selection: canonicalSelection(source.selection),
  })).sort((left, right) => compareText(left.path, right.path));
  assertUnique(canonical.map((source) => source.path), 'code source path');
  return canonical;
}

function canonicalSourceScopes(
  sourceScopes: CodeSourceScope[],
  repositoryRoot?: string | null,
): Array<{ path: string; ranges: Array<{ lineStart: number; lineEnd: number }> }> {
  const canonical = sourceScopes.map((scope) => ({
    path: normalizeRepositoryPath(scope.path, repositoryRoot),
    ranges: canonicalRanges(scope.ranges),
  })).sort((left, right) => compareText(left.path, right.path));
  assertUnique(canonical.map((scope) => scope.path), 'code source-scope path');
  return canonical;
}

function canonicalContext(
  context: CodeViolationContext,
  repositoryRoot?: string | null,
): CodeViolationContext {
  assertUniqueLlmIdentity(context.llmRules.map((rule) => rule.key), 'rule key');
  assertUniqueLlmIdentity(
    (context.existingViolations ?? []).map((violation) => violation.id),
    'prior runtime ID',
  );
  const semanticPriorKey = (violation: NonNullable<CodeViolationContext['existingViolations']>[number]): string =>
    canonicalJson({
      filePath: violation.filePath,
      lineStart: violation.lineStart,
      lineEnd: violation.lineEnd,
      ruleKey: violation.ruleKey,
      severity: violation.severity,
      title: violation.title,
      content: violation.content,
    });

  const existingViolations = context.existingViolations?.map((violation) => ({
    ...violation,
    filePath: normalizeRepositoryPath(violation.filePath, repositoryRoot),
  }))
    .sort((left, right) => compareText(semanticPriorKey(left), semanticPriorKey(right)));
  if (existingViolations) {
    const semanticKeys = existingViolations.map(semanticPriorKey);
    if (semanticKeys.some((key, index) => index > 0 && key === semanticKeys[index - 1])) {
      throw new Error('Code work cannot assign stable aliases to duplicate semantic prior findings');
    }
  }

  const files = context.files.map((file) => ({
    ...file,
    path: normalizeRepositoryPath(file.path, repositoryRoot),
  }))
    .sort((left, right) => compareText(left.path, right.path) || compareText(left.content, right.content));
  assertUnique(files.map((file) => file.path), 'code file path');
  const sourceScopes = canonicalSourceScopes(context.sourceScopes, repositoryRoot);
  const sources = context.sources ? canonicalSources(context, repositoryRoot) : undefined;

  return {
    analysisInputFingerprint: context.analysisInputFingerprint,
    files,
    sourceScopes,
    sources,
    llmRules: context.llmRules.map((rule) => ({ ...rule }))
      .sort((left, right) => compareText(left.key, right.key) || compareText(canonicalJson(left), canonicalJson(right))),
    tier: context.tier,
    existingViolations,
  };
}

/**
 * Prepare and certify the stable identity of one real code-check work unit.
 * This function only plans execution; durable storage and reuse remain outside
 * this module until a journal can validate every component fingerprint.
 */
export function planCodeViolationWork(
  context: CodeViolationContext,
  execution: CodeWorkExecutionIntent,
): PlannedCodeViolationWork {
  const repositoryRoot = execution.repositoryRoot;
  const preparedContext = canonicalContext(context, repositoryRoot);
  const request = prepareCodeViolationRequest(preparedContext, repositoryRoot);
  const sources = canonicalSources(preparedContext, repositoryRoot);
  const sourceScopes = canonicalSourceScopes(preparedContext.sourceScopes, repositoryRoot);
  const ruleKeys = [...new Set(preparedContext.llmRules.map((rule) => rule.key))].sort(compareText);
  const workId = `llm.code:${fingerprint({
    version: 1,
    tier: preparedContext.tier ?? 'full-file',
    ruleKeys,
    sources,
    sourceScopes,
  })}`;

  const componentFingerprints = Object.freeze({
    repository: fingerprint({
      files: preparedContext.files.map((file) => ({
        path: normalizeRepositoryPath(file.path, repositoryRoot),
        content: bindCodeSourceHeaderAliases(file.content, request.sourceBindings),
      })).sort((left, right) => compareText(left.path, right.path)),
      sources,
      sourceScopes,
    }),
    baseline: fingerprint((preparedContext.existingViolations ?? []).map((violation) => ({
      filePath: normalizeRepositoryPath(violation.filePath, repositoryRoot),
      lineStart: violation.lineStart,
      lineEnd: violation.lineEnd,
      ruleKey: violation.ruleKey,
      severity: violation.severity,
      title: violation.title,
      content: violation.content,
    })).sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)))),
    rules: fingerprint(preparedContext.llmRules.map((rule) => ({ ...rule }))
      .sort((left, right) => compareText(left.key, right.key))),
    configuration: fingerprint({
      tier: preparedContext.tier ?? 'full-file',
      selections: sources.map((source) => source.selection),
      toolPolicy: request.toolPolicy,
      timeoutMs: request.timeoutMs,
      analysisInputFingerprint: preparedContext.analysisInputFingerprint ?? null,
    }),
    request: fingerprint({
      stage: request.stage,
      label: request.label,
      system: request.system,
      prompt: request.prompt,
      schemaJson: request.schemaJson,
      responseFormat: request.responseFormat,
      toolPolicy: request.toolPolicy,
      timeoutMs: request.timeoutMs,
    }),
    execution: fingerprint({
      provider: execution.provider,
      requestedModel: execution.requestedModel,
    }),
    resultContract: fingerprint({
      resultContractId: request.resultContractId,
      promptAliases: request.bindings.map((binding) => binding.promptId).sort(compareText),
      sourceAliases: request.sourceBindings.map((binding) => binding.promptPath),
    }),
  });

  const inputFingerprint = fingerprint(componentFingerprints);
  return Object.freeze({
    workId,
    inputFingerprint,
    componentFingerprints,
    request,
  });
}
