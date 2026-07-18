import { Buffer } from 'node:buffer';
import type { AnalysisRule, FileAnalysis, ContextRequirement, ContextTier, FileFilter, FunctionFilter } from '@truecourse/shared';
import { DATABASE_IMPORT_MAP, getAllTestPatterns } from '@truecourse/analyzer';
import type { CodeContextSource, CodeMetadataField, CodeSourceScope } from './provider.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContextBatch {
  tier: ContextTier;
  rules: { key: string; name: string; severity: string; prompt: string }[];
  content: string;
  fileCount: number;
  functionCount?: number;
  estimatedTokens: number;
  /** Exact source ranges represented by this batch. */
  sourceScopes: CodeSourceScope[];
  /** Real file paths included in this batch (full-file/legacy tiers only). */
  filePaths?: string[];
  /** Exact repository source scope represented by this batch. */
  sources: ContextBatchSource[];
}

export type ContextBatchSource = CodeContextSource;

export interface PreFlightEstimate {
  tiers: Array<{
    tier: string;
    ruleCount: number;
    fileCount: number;
    functionCount?: number;
    estimatedTokens: number;
  }>;
  totalEstimatedTokens: number;
  uniqueFileCount: number;
  uniqueRuleCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_PACKAGES = new Set(Object.keys(DATABASE_IMPORT_MAP));

const TEST_PATTERNS = getAllTestPatterns();

export const CHARS_PER_TOKEN = 4; // rough estimate for token counting
export const PROMPT_OVERHEAD_TOKENS = 500; // prompt template + instructions per LLM call
const TOKENS_PER_RULE = 50; // rule key + name + prompt line in the system message
const TOKENS_PER_FILE_PATH = 25; // "=== /path/to/file.ts ===\nRead this file..." per file in CLI mode
const MAX_CHARS_PER_BATCH = 100_000;

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

// ---------------------------------------------------------------------------
// File filter matching
// ---------------------------------------------------------------------------

function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((p) => filePath.includes(p));
}

function matchesFileFilter(
  fa: FileAnalysis,
  filter: FileFilter,
  fileContent?: string,
): boolean {
  if (filter.hasAsyncFunctions !== undefined) {
    const hasAsync = fa.functions.some((f) => f.isAsync) ||
      fa.classes.some((c) => c.methods.some((m) => m.isAsync));
    if (filter.hasAsyncFunctions !== hasAsync) return false;
  }

  if (filter.hasRouteHandlers !== undefined) {
    const hasRoutes = (fa.routeRegistrations?.length ?? 0) > 0;
    if (filter.hasRouteHandlers !== hasRoutes) return false;
  }

  if (filter.hasDbCalls !== undefined) {
    const hasDb = fa.imports.some((i) => DB_PACKAGES.has(i.source));
    if (filter.hasDbCalls !== hasDb) return false;
  }

  if (filter.hasCatchBlocks !== undefined) {
    // Simple heuristic: check if source contains 'catch' keyword
    const hasCatch = fileContent ? /\bcatch\s*\(/.test(fileContent) : false;
    if (filter.hasCatchBlocks !== hasCatch) return false;
  }

  if (filter.hasImportsFrom) {
    const hasImport = fa.imports.some((i) =>
      filter.hasImportsFrom!.some((s) => i.source.includes(s)),
    );
    if (!hasImport) return false;
  }

  if (filter.hasCallsTo) {
    const hasCall = fa.calls.some((c) =>
      filter.hasCallsTo!.some((t) => c.callee.includes(t)),
    );
    if (!hasCall) return false;
  }

  if (filter.isTestFile !== undefined) {
    if (filter.isTestFile !== isTestFile(fa.filePath)) return false;
  }

  if (filter.languages) {
    if (!filter.languages.includes(fa.language)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Function filter matching & extraction
// ---------------------------------------------------------------------------

interface ExtractedFunction {
  name: string;
  body: string;
  startLine: number;
  endLine: number;
}

function matchesFunctionFilter(
  fn: { name: string; isAsync: boolean; params: { name: string; type?: string }[]; location: { startLine: number; endLine: number } },
  filter: FunctionFilter,
  fa: FileAnalysis,
  contentLines?: string[],
): boolean {
  if (filter.isAsync !== undefined && filter.isAsync !== fn.isAsync) return false;

  if (filter.isRouteHandler) {
    const handlerNames = new Set(
      (fa.routeRegistrations || []).map((r) => r.handlerName),
    );
    if (!handlerNames.has(fn.name)) return false;
  }

  if (filter.containsCatchBlock && contentLines) {
    const fnLines = contentLines.slice(fn.location.startLine - 1, fn.location.endLine);
    const fnBody = fnLines.join('\n');
    if (!/\bcatch\s*\(/.test(fnBody)) return false;
  }

  if (filter.callsAny) {
    const fnCalls = fa.calls.filter(
      (c) =>
        c.callerFunction === fn.name ||
        (c.location.startLine >= fn.location.startLine &&
          c.location.endLine <= fn.location.endLine),
    );
    const hasMatchingCall = fnCalls.some((c) =>
      filter.callsAny!.some((t) => c.callee.includes(t)),
    );
    if (!hasMatchingCall) return false;
  }

  return true;
}

function extractTargetedFunctions(
  content: string,
  fa: FileAnalysis,
  filter: FunctionFilter,
): ExtractedFunction[] {
  const contentLines = content.split('\n');
  const results: ExtractedFunction[] = [];

  // Collect all functions: top-level + class methods
  const allFunctions: typeof fa.functions = [
    ...fa.functions,
    ...fa.classes.flatMap((c) => c.methods),
  ];

  for (const fn of allFunctions) {
    if (matchesFunctionFilter(fn, filter, fa, contentLines)) {
      const startIdx = Math.max(0, fn.location.startLine - 1);
      const endIdx = Math.min(contentLines.length, fn.location.endLine);
      const body = contentLines.slice(startIdx, endIdx).join('\n');
      results.push({
        name: fn.name,
        body,
        startLine: fn.location.startLine,
        endLine: fn.location.endLine,
      });
    }
  }

  return results.sort((left, right) =>
    left.startLine - right.startLine
    || left.endLine - right.endLine
    || compareText(left.name, right.name));
}

// ---------------------------------------------------------------------------
// Metadata summary builder
// ---------------------------------------------------------------------------

export type MetadataField = CodeMetadataField;

function buildMetadataSummary(fa: FileAnalysis, fields: MetadataField[], lineCount: number): string {
  const parts: string[] = [`=== ${fa.filePath} (lines 1-${Math.max(1, lineCount)}) ===`];

  for (const field of fields) {
    switch (field) {
      case 'functions': {
        const fns = fa.functions.map((f) => {
          const tags: string[] = [];
          if (f.isAsync) tags.push('async');
          if (f.isExported) tags.push('exported');
          const params = f.params.map((p) => `${p.name}${p.type ? ': ' + p.type : ''}`).join(', ');
          const ret = f.returnType ? `: ${f.returnType}` : '';
          return `${f.name}(${params})${ret}${tags.length ? ' [' + tags.join(', ') + ']' : ''}`;
        }).sort(compareText);
        if (fns.length) parts.push(`Functions: ${fns.join(', ')}`);
        break;
      }
      case 'classes': {
        const cls = fa.classes.map((c) => {
          const methods = c.methods.map((m) => m.name).sort(compareText).join(', ');
          return `${c.name}${c.superClass ? ' extends ' + c.superClass : ''} { ${methods} }`;
        }).sort(compareText);
        if (cls.length) parts.push(`Classes: ${cls.join(', ')}`);
        break;
      }
      case 'imports': {
        const imps = fa.imports.map((i) => i.source).sort(compareText);
        if (imps.length) parts.push(`Imports: ${imps.join(', ')}`);
        break;
      }
      case 'exports': {
        const exps = fa.exports
          .map((e) => (e.isDefault ? `default ${e.name}` : e.name))
          .sort(compareText);
        if (exps.length) parts.push(`Exports: ${exps.join(', ')}`);
        break;
      }
      case 'calls': {
        const uniqueCallees = uniqueSorted(fa.calls.map((c) => c.callee));
        if (uniqueCallees.length) parts.push(`Calls: ${uniqueCallees.slice(0, 30).join(', ')}${uniqueCallees.length > 30 ? ` (+${uniqueCallees.length - 30} more)` : ''}`);
        break;
      }
      case 'httpCalls': {
        const http = fa.httpCalls.map((h) => `${h.method} ${h.url}`).sort(compareText);
        if (http.length) parts.push(`HTTP calls: ${http.join(', ')}`);
        break;
      }
      case 'routeRegistrations': {
        const routes = (fa.routeRegistrations || [])
          .map((r) => `${r.httpMethod} ${r.path}`)
          .sort(compareText);
        if (routes.length) parts.push(`Routes: ${routes.join(', ')}`);
        break;
      }
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Rule grouping
// ---------------------------------------------------------------------------

interface RuleDto {
  key: string;
  name: string;
  severity: string;
  prompt: string;
}

interface GroupedRules {
  metadata: { rules: RuleDto[]; requirement: ContextRequirement }[];
  targeted: { rules: RuleDto[]; requirement: ContextRequirement }[];
  fullFile: { rules: RuleDto[]; requirement: ContextRequirement }[];
}

function normalizeFileFilter(filter: FileFilter | undefined): FileFilter | undefined {
  if (!filter) return undefined;
  const normalized: FileFilter = {
    ...(filter.hasAsyncFunctions === undefined ? {} : { hasAsyncFunctions: filter.hasAsyncFunctions }),
    ...(filter.hasRouteHandlers === undefined ? {} : { hasRouteHandlers: filter.hasRouteHandlers }),
    ...(filter.hasDbCalls === undefined ? {} : { hasDbCalls: filter.hasDbCalls }),
    ...(filter.hasCatchBlocks === undefined ? {} : { hasCatchBlocks: filter.hasCatchBlocks }),
    ...(filter.hasImportsFrom === undefined ? {} : { hasImportsFrom: uniqueSorted(filter.hasImportsFrom) }),
    ...(filter.hasCallsTo === undefined ? {} : { hasCallsTo: uniqueSorted(filter.hasCallsTo) }),
    ...(filter.isTestFile === undefined ? {} : { isTestFile: filter.isTestFile }),
    ...(filter.languages === undefined ? {} : { languages: uniqueSorted(filter.languages) }),
  };
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function normalizeFunctionFilter(filter: FunctionFilter | undefined): FunctionFilter | undefined {
  if (!filter) return undefined;
  const normalized: FunctionFilter = {
    ...(filter.isAsync === undefined ? {} : { isAsync: filter.isAsync }),
    ...(filter.isRouteHandler === undefined ? {} : { isRouteHandler: filter.isRouteHandler }),
    ...(filter.containsCatchBlock === undefined ? {} : { containsCatchBlock: filter.containsCatchBlock }),
    ...(filter.callsAny === undefined ? {} : { callsAny: uniqueSorted(filter.callsAny) }),
  };
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function normalizeContextRequirement(requirement: ContextRequirement): ContextRequirement {
  const fileFilter = normalizeFileFilter(requirement.fileFilter);
  const functionFilter = normalizeFunctionFilter(requirement.functionFilter);
  return {
    tier: requirement.tier,
    ...(fileFilter ? { fileFilter } : {}),
    ...(functionFilter ? { functionFilter } : {}),
    ...(requirement.metadataFields === undefined
      ? {}
      : { metadataFields: uniqueSorted(requirement.metadataFields) as MetadataField[] }),
  };
}

function contextKey(req: ContextRequirement): string {
  return JSON.stringify({
    tier: req.tier,
    ff: req.fileFilter ?? null,
    fnf: req.functionFilter ?? null,
    mf: req.metadataFields === undefined
      ? { kind: 'default' }
      : { kind: 'explicit', fields: req.metadataFields },
  });
}

function groupRulesByContext(rules: AnalysisRule[]): GroupedRules {
  const result: GroupedRules = { metadata: [], targeted: [], fullFile: [] };
  const groups = new Map<string, { rules: RuleDto[]; requirement: ContextRequirement }>();

  const orderedRules = [...rules].sort((left, right) => {
    const byKey = compareText(left.key, right.key);
    if (byKey !== 0) return byKey;
    return compareText(
      JSON.stringify([left.name, left.severity, left.prompt ?? '']),
      JSON.stringify([right.name, right.severity, right.prompt ?? '']),
    );
  });

  for (const rule of orderedRules) {
    if (!rule.contextRequirement) continue;

    const dto: RuleDto = { key: rule.key, name: rule.name, severity: rule.severity, prompt: rule.prompt! };
    const requirement = normalizeContextRequirement(rule.contextRequirement);
    const key = contextKey(requirement);
    let group = groups.get(key);
    if (!group) {
      group = { rules: [], requirement };
      groups.set(key, group);
    }
    group.rules.push(dto);
  }

  for (const group of groups.values()) {
    switch (group.requirement.tier) {
      case 'metadata':
        result.metadata.push(group);
        break;
      case 'targeted':
        result.targeted.push(group);
        break;
      case 'full-file':
        result.fullFile.push(group);
        break;
    }
  }

  for (const tier of [result.metadata, result.targeted, result.fullFile]) {
    tier.sort((left, right) => compareText(contextKey(left.requirement), contextKey(right.requirement)));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

function buildMetadataContent(
  group: { rules: RuleDto[]; requirement: ContextRequirement },
  fileAnalyses: FileAnalysis[],
  fileContents: Map<string, { content: string; lineCount: number }>,
): {
  content: string;
  fileCount: number;
  sourceScopes: CodeSourceScope[];
  sources: ContextBatchSource[];
} {
  const matching = fileAnalyses.filter((fa) => {
    if (!group.requirement.fileFilter) return true;
    const fc = fileContents.get(fa.filePath);
    return matchesFileFilter(fa, group.requirement.fileFilter, fc?.content);
  });

  const fields = (group.requirement.metadataFields || ['functions', 'imports', 'exports']) as MetadataField[];
  const summaries = matching.map((fa) =>
    buildMetadataSummary(fa, fields, fileContents.get(fa.filePath)?.lineCount ?? 1),
  );
  const sourceScopes = matching.map((fa) => ({
    path: fa.filePath,
    ranges: [{ lineStart: 1, lineEnd: Math.max(1, fileContents.get(fa.filePath)?.lineCount ?? 1) }],
  }));

  return {
    content: summaries.join('\n\n'),
    fileCount: matching.length,
    sourceScopes,
    sources: matching.map((fa) => ({
      path: fa.filePath,
      selection: { kind: 'metadata', fields },
    })),
  };
}

function buildTargetedContent(
  group: { rules: RuleDto[]; requirement: ContextRequirement },
  fileAnalyses: FileAnalysis[],
  fileContents: Map<string, { content: string; lineCount: number }>,
): {
  content: string;
  fileCount: number;
  functionCount: number;
  sourceScopes: CodeSourceScope[];
  sources: ContextBatchSource[];
} {
  const filter = group.requirement.functionFilter || {};
  let totalFunctions = 0;
  const parts: string[] = [];
  const sources: ContextBatchSource[] = [];
  const sourceScopes: CodeSourceScope[] = [];

  for (const fa of fileAnalyses) {
    const fc = fileContents.get(fa.filePath);
    if (!fc) continue;

    if (group.requirement.fileFilter && !matchesFileFilter(fa, group.requirement.fileFilter, fc.content)) {
      continue;
    }

    const extracted = extractTargetedFunctions(fc.content, fa, filter);
    if (extracted.length === 0) continue;

    totalFunctions += extracted.length;
    const fileParts = [`=== ${fa.filePath} ===`];
    for (const fn of extracted) {
      const numbered = fn.body
        .split('\n')
        .map((line, i) => `${fn.startLine + i}: ${line}`)
        .join('\n');
      fileParts.push(`--- ${fn.name} (lines ${fn.startLine}-${fn.endLine}) ---\n${numbered}`);
    }
    parts.push(fileParts.join('\n'));
    sources.push({
      path: fa.filePath,
      selection: {
        kind: 'targeted',
        functions: extracted.map(({ name, startLine, endLine }) => ({ name, startLine, endLine })),
      },
    });
    sourceScopes.push({
      path: fa.filePath,
      ranges: extracted.map((fn) => ({ lineStart: fn.startLine, lineEnd: fn.endLine })),
    });
  }

  return {
    content: parts.join('\n\n'),
    fileCount: parts.length,
    functionCount: totalFunctions,
    sourceScopes,
    sources,
  };
}

function buildFullFileContent(
  group: { rules: RuleDto[]; requirement: ContextRequirement },
  fileAnalyses: FileAnalysis[],
  fileContents: Map<string, { content: string; lineCount: number }>,
): {
  content: string;
  fileCount: number;
  filePaths: string[];
  sourceScopes: CodeSourceScope[];
  sources: ContextBatchSource[];
} {
  const parts: string[] = [];
  const filePaths: string[] = [];
  const sourceScopes: CodeSourceScope[] = [];

  for (const fa of fileAnalyses) {
    const fc = fileContents.get(fa.filePath);
    if (!fc) continue;

    if (group.requirement.fileFilter && !matchesFileFilter(fa, group.requirement.fileFilter, fc.content)) {
      continue;
    }

    const numbered = fc.content
      .split('\n')
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n');
    parts.push(`=== ${fa.filePath} ===\n${numbered}`);
    filePaths.push(fa.filePath);
    sourceScopes.push({
      path: fa.filePath,
      ranges: [{ lineStart: 1, lineEnd: Math.max(1, fc.lineCount) }],
    });
  }

  return {
    content: parts.join('\n\n'),
    fileCount: parts.length,
    filePaths,
    sourceScopes,
    sources: filePaths.map((filePath) => ({
      path: filePath,
      selection: { kind: 'full-file' },
    })),
  };
}

// ---------------------------------------------------------------------------
// Batch splitting — ensures no single batch exceeds MAX_CHARS_PER_BATCH
// ---------------------------------------------------------------------------

function splitIntoBatches(
  tier: ContextTier,
  rules: RuleDto[],
  content: string,
  fileCount: number,
  sourceScopes: CodeSourceScope[],
  functionCount?: number,
  filePaths?: string[],
  sources: ContextBatchSource[] = [],
): ContextBatch[] {
  if (content.length === 0) return [];

  const estimatedTokens = Math.ceil(content.length / CHARS_PER_TOKEN);

  if (content.length <= MAX_CHARS_PER_BATCH) {
    return [{
      tier,
      rules,
      content,
      fileCount,
      functionCount,
      estimatedTokens,
      sourceScopes,
      filePaths,
      sources,
    }];
  }

  // Split content by file sections (=== delimiter)
  const sections = content.split(/(?=^=== )/m);
  const batches: ContextBatch[] = [];
  let currentContent = '';
  let currentFileCount = 0;
  let currentFilePaths: string[] = [];
  let currentSources: ContextBatchSource[] = [];
  let currentSourceScopes: CodeSourceScope[] = [];

  const targetedFunctionCount = (batchSources: ContextBatchSource[]): number | undefined => {
    if (tier !== 'targeted') return undefined;
    return batchSources.reduce(
      (sum, source) => sum + (source.selection.kind === 'targeted' ? source.selection.functions.length : 0),
      0,
    );
  };

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    if (currentContent.length + section.length > MAX_CHARS_PER_BATCH && currentContent.length > 0) {
      batches.push({
        tier,
        rules,
        content: currentContent,
        fileCount: currentFileCount,
        functionCount: targetedFunctionCount(currentSources),
        estimatedTokens: Math.ceil(currentContent.length / CHARS_PER_TOKEN),
        sourceScopes: currentSourceScopes,
        filePaths: currentFilePaths.length > 0 ? currentFilePaths : undefined,
        sources: currentSources,
      });
      currentContent = '';
      currentFileCount = 0;
      currentFilePaths = [];
      currentSources = [];
      currentSourceScopes = [];
    }
    currentContent += (currentContent ? '\n\n' : '') + section;
    currentFileCount++;
    if (filePaths && filePaths[si]) currentFilePaths.push(filePaths[si]);
    if (sources[si]) currentSources.push(sources[si]);
    if (sourceScopes[si]) currentSourceScopes.push(sourceScopes[si]);
  }

  if (currentContent.length > 0) {
    batches.push({
      tier,
      rules,
      content: currentContent,
      fileCount: currentFileCount,
      functionCount: targetedFunctionCount(currentSources),
      estimatedTokens: Math.ceil(currentContent.length / CHARS_PER_TOKEN),
      sourceScopes: currentSourceScopes,
      filePaths: currentFilePaths.length > 0 ? currentFilePaths : undefined,
      sources: currentSources,
    });
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * When the aggregated LLM context exceeds V8's ~512MB string cap, re-throw
 * with the names of the largest in-scope files attached, so the user can
 * add them to `.truecourseignore`.
 *
 * The trigger is almost always a minified bundle, vendored lib, or generated
 * file expanding into a huge pile of extracted function bodies.
 */
function translateContextRangeError(
  err: unknown,
  fileContents: Map<string, { content: string; lineCount: number }>,
): never {
  if (!(err instanceof RangeError) || !err.message.includes('Invalid string length')) {
    throw err;
  }
  const sized = [...fileContents.entries()]
    .map(([filePath, fc]) => ({
      filePath,
      sizeKb: Math.round(fc.content.length / 1024),
      lineCount: fc.lineCount,
      // long single lines are a strong minified-bundle signal
      maxLineLength: fc.lineCount > 0 ? Math.round(fc.content.length / fc.lineCount) : 0,
    }))
    .sort((a, b) => b.sizeKb - a.sizeKb)
    .slice(0, 5);

  const list = sized
    .map((f) => {
      const minHint = f.maxLineLength > 5_000 ? ' [likely minified]' : '';
      return `  - ${f.filePath} (${f.sizeKb} KB, ${f.lineCount} lines)${minHint}`;
    })
    .join('\n');

  const suggestions = sized.slice(0, 3).map((f) => `  ${f.filePath}`).join('\n');

  throw new Error(
    `LLM context exceeded V8's max string length (~512 MB) while preparing rule batches. ` +
      `This is almost always caused by minified bundles, vendored libraries, or generated files.\n\n` +
      `Largest files in scope:\n${list}\n\n` +
      `Add the offending paths to \`.truecourseignore\` at the repo root, e.g.:\n${suggestions}`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function estimateContext(
  rules: AnalysisRule[],
  fileAnalyses: FileAnalysis[],
  fileContents: Map<string, { content: string; lineCount: number }>,
  options?: { useFilePaths?: boolean },
): PreFlightEstimate {
  try {
    return estimateContextInner(rules, fileAnalyses, fileContents, options);
  } catch (err) {
    translateContextRangeError(err, fileContents);
  }
}

function estimateContextInner(
  rules: AnalysisRule[],
  fileAnalyses: FileAnalysis[],
  fileContents: Map<string, { content: string; lineCount: number }>,
  options?: { useFilePaths?: boolean },
): PreFlightEstimate {
  const grouped = groupRulesByContext(rules);
  const orderedFileAnalyses = [...fileAnalyses].sort((left, right) => compareText(left.filePath, right.filePath));
  const tiers: PreFlightEstimate['tiers'] = [];
  const useFilePaths = options?.useFilePaths ?? false;

  // Helper: each context group's rules may span N domains.
  // The pipeline splits each group into N separate LLM calls (one per domain),
  // each getting the same content but only that domain's rules.
  // So overhead = domainCount × PROMPT_OVERHEAD, content is shared but sent N times.
  function estimateGroupTokens(contentTokens: number, rulesList: RuleDto[]): number {
    const domains = new Set(rulesList.map((r) => r.key.split('/')[0]));
    const domainCount = domains.size;
    return (contentTokens + PROMPT_OVERHEAD_TOKENS) * domainCount + (rulesList.length * TOKENS_PER_RULE);
  }

  // Metadata tiers — always inline content (summaries)
  for (const group of grouped.metadata) {
    const { content, fileCount } = buildMetadataContent(group, orderedFileAnalyses, fileContents);
    if (fileCount > 0) {
      const contentTokens = Math.ceil(content.length / CHARS_PER_TOKEN);
      tiers.push({
        tier: 'metadata',
        ruleCount: group.rules.length,
        fileCount,
        estimatedTokens: estimateGroupTokens(contentTokens, group.rules),
      });
    }
  }

  // Targeted tiers — always inline content (function extracts)
  for (const group of grouped.targeted) {
    const { content, fileCount, functionCount } = buildTargetedContent(group, orderedFileAnalyses, fileContents);
    if (fileCount > 0) {
      const contentTokens = Math.ceil(content.length / CHARS_PER_TOKEN);
      tiers.push({
        tier: 'targeted',
        ruleCount: group.rules.length,
        fileCount,
        functionCount,
        estimatedTokens: estimateGroupTokens(contentTokens, group.rules),
      });
    }
  }

  // Full-file tiers — CLI mode sends file paths only, API mode inlines content
  for (const group of grouped.fullFile) {
    const { content, fileCount } = buildFullFileContent(group, orderedFileAnalyses, fileContents);
    if (fileCount > 0) {
      const contentTokens = useFilePaths
        ? fileCount * TOKENS_PER_FILE_PATH
        : Math.ceil(content.length / CHARS_PER_TOKEN);
      tiers.push({
        tier: 'full-file',
        ruleCount: group.rules.length,
        fileCount,
        estimatedTokens: estimateGroupTokens(contentTokens, group.rules),
      });
    }
  }

  const uniqueRules = new Set<string>();
  for (const group of [...grouped.metadata, ...grouped.targeted, ...grouped.fullFile]) {
    for (const r of group.rules) uniqueRules.add(r.key);
  }

  return {
    tiers,
    totalEstimatedTokens: tiers.reduce((sum, t) => sum + t.estimatedTokens, 0),
    uniqueFileCount: fileContents.size,
    uniqueRuleCount: uniqueRules.size,
  };
}

export function routeContext(
  rules: AnalysisRule[],
  fileAnalyses: FileAnalysis[],
  fileContents: Map<string, { content: string; lineCount: number }>,
): ContextBatch[] {
  try {
    return routeContextInner(rules, fileAnalyses, fileContents);
  } catch (err) {
    translateContextRangeError(err, fileContents);
  }
}

function routeContextInner(
  rules: AnalysisRule[],
  fileAnalyses: FileAnalysis[],
  fileContents: Map<string, { content: string; lineCount: number }>,
): ContextBatch[] {
  const grouped = groupRulesByContext(rules);
  const batches: ContextBatch[] = [];
  const orderedFileAnalyses = [...fileAnalyses].sort((left, right) => compareText(left.filePath, right.filePath));

  // Build file analysis lookup by path
  const faByPath = new Map<string, FileAnalysis>();
  for (const fa of orderedFileAnalyses) {
    faByPath.set(fa.filePath, fa);
  }

  // Metadata batches
  for (const group of grouped.metadata) {
    const { content, fileCount, sourceScopes, sources } = buildMetadataContent(group, orderedFileAnalyses, fileContents);
    if (fileCount > 0) {
      batches.push(...splitIntoBatches('metadata', group.rules, content, fileCount, sourceScopes, undefined, undefined, sources));
    }
  }

  // Targeted batches
  for (const group of grouped.targeted) {
    const { content, fileCount, functionCount, sourceScopes, sources } = buildTargetedContent(group, orderedFileAnalyses, fileContents);
    if (fileCount > 0) {
      batches.push(...splitIntoBatches('targeted', group.rules, content, fileCount, sourceScopes, functionCount, undefined, sources));
    }
  }

  // Full-file batches
  for (const group of grouped.fullFile) {
    const { content, fileCount, filePaths, sourceScopes, sources } = buildFullFileContent(group, orderedFileAnalyses, fileContents);
    if (fileCount > 0) {
      batches.push(...splitIntoBatches('full-file', group.rules, content, fileCount, sourceScopes, undefined, filePaths, sources));
    }
  }

  return batches;
}
