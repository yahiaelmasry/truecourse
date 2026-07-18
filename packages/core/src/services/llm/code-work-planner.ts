import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type {
  CodeContextSource,
  CodeSourceScope,
  CodeViolationContext,
} from './provider.js';
import {
  prepareCodeViolationRequest,
  type PreparedCodeViolationRequest,
} from './prepared-code-violation-request.js';

export interface CodeWorkExecutionIntent {
  readonly provider: string;
  readonly requestedModel: string | null;
  readonly repositoryRoot?: string | null;
}

export interface CodeWorkComponentFingerprints {
  readonly repository: string;
  readonly baseline: string;
  readonly rules: string;
  readonly configuration: string;
  readonly request: string;
  readonly execution: string;
  readonly resultContract: string;
}

export interface PlannedCodeViolationWork {
  readonly workId: string;
  readonly inputFingerprint: string;
  readonly componentFingerprints: CodeWorkComponentFingerprints;
  readonly request: PreparedCodeViolationRequest;
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareText(left, right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function normalizeRepositoryPath(filePath: string, repositoryRoot?: string | null): string {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const normalizedRoot = repositoryRoot?.replaceAll('\\', '/').replace(/\/$/, '');
  if (!normalizedRoot) return normalizedPath;
  if (normalizedPath === normalizedRoot) return '.';
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

function canonicalRanges(ranges: CodeSourceScope['ranges']): Array<{ lineStart: number; lineEnd: number }> {
  return ranges
    .map(({ lineStart, lineEnd }) => ({ lineStart, lineEnd }))
    .sort((left, right) => left.lineStart - right.lineStart || left.lineEnd - right.lineEnd);
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
  return supplied.map((source) => ({
    path: normalizeRepositoryPath(source.path, repositoryRoot),
    selection: source.selection.kind === 'metadata'
      ? { kind: 'metadata' as const, fields: [...source.selection.fields].sort(compareText) }
      : source.selection.kind === 'targeted'
        ? {
            kind: 'targeted' as const,
            functions: source.selection.functions
              .map((fn) => ({ ...fn }))
              .sort((left, right) =>
                left.startLine - right.startLine
                || left.endLine - right.endLine
                || compareText(left.name, right.name)),
          }
        : { ...source.selection },
  })).sort((left, right) => compareText(left.path, right.path));
}

function canonicalSourceScopes(
  sourceScopes: CodeSourceScope[],
  repositoryRoot?: string | null,
): Array<{ path: string; ranges: Array<{ lineStart: number; lineEnd: number }> }> {
  return sourceScopes.map((scope) => ({
    path: normalizeRepositoryPath(scope.path, repositoryRoot),
    ranges: canonicalRanges(scope.ranges),
  })).sort((left, right) => compareText(left.path, right.path));
}

function canonicalContext(context: CodeViolationContext): CodeViolationContext {
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

  const existingViolations = context.existingViolations?.map((violation) => ({ ...violation }))
    .sort((left, right) => compareText(semanticPriorKey(left), semanticPriorKey(right)));
  if (existingViolations) {
    const semanticKeys = existingViolations.map(semanticPriorKey);
    if (semanticKeys.some((key, index) => index > 0 && key === semanticKeys[index - 1])) {
      throw new Error('Code work cannot assign stable aliases to duplicate semantic prior findings');
    }
  }

  return {
    files: context.files.map((file) => ({ ...file }))
      .sort((left, right) => compareText(left.path, right.path) || compareText(left.content, right.content)),
    sourceScopes: context.sourceScopes.map((scope) => ({
      path: scope.path,
      ranges: canonicalRanges(scope.ranges),
    })).sort((left, right) =>
      compareText(left.path, right.path) || compareText(canonicalJson(left.ranges), canonicalJson(right.ranges))),
    sources: context.sources?.map((source) => ({
      path: source.path,
      selection: source.selection.kind === 'metadata'
        ? { kind: 'metadata' as const, fields: [...source.selection.fields].sort(compareText) }
        : source.selection.kind === 'targeted'
          ? {
              kind: 'targeted' as const,
              functions: source.selection.functions.map((fn) => ({ ...fn })).sort((left, right) =>
                left.startLine - right.startLine
                || left.endLine - right.endLine
                || compareText(left.name, right.name)),
            }
          : { kind: 'full-file' as const },
    })).sort((left, right) =>
      compareText(left.path, right.path) || compareText(canonicalJson(left.selection), canonicalJson(right.selection))),
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
  const preparedContext = canonicalContext(context);
  const request = prepareCodeViolationRequest(preparedContext);
  const repositoryRoot = execution.repositoryRoot;
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
        content: file.content,
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
