import path from 'node:path';
import type { CodeViolationContext } from './provider.js';
import {
  INLINE_FULL_FILE_SOURCE_DELIVERY,
  runtimePathForRepositoryRoot,
  type PreparedCodeSourceBinding,
} from './prepared-code-violation-request.js';
import {
  planCodeViolationWork,
  type CodeWorkExecutionIntent,
  type PlannedCodeViolationWork,
} from './code-work-planner.js';
import { formatInlineCodeFileList } from './prompts.js';

function portablePath(value: string): string {
  const portable = path.posix.normalize(value.replaceAll('\\', '/'));
  const drive = /^([a-z]):(\/.*)$/i.exec(portable);
  return drive ? `${drive[1].toLowerCase()}:${drive[2]}` : portable;
}

function runtimePath(repositoryRoot: string, filePath: string): string {
  const portableFile = portablePath(filePath);
  if (/^(?:\/|[a-z]:\/)/i.test(portableFile)) return portableFile;
  return runtimePathForRepositoryRoot(repositoryRoot, portableFile);
}

function fullFileList(
  context: CodeViolationContext,
  repositoryRoot: string,
  bindings: readonly PreparedCodeSourceBinding[],
): string {
  const contentByRuntimePath = new Map(context.files.map((file) => [
    portablePath(runtimePath(repositoryRoot, file.path)),
    file.content,
  ]));
  return bindings.map(({ promptPath, runtimePath }) => {
    const content = contentByRuntimePath.get(portablePath(runtimePath));
    if (content === undefined) throw new Error(`Inline full-file source has no captured content: ${promptPath}`);
    return { path: promptPath, content };
  }).map((file) => formatInlineCodeFileList([file])).join('\n\n');
}

/** Compile already-supplied full-file text into an immutable request requiring no provider tools. */
export function compileInlineFullFileCodeWork(
  context: CodeViolationContext,
  execution: CodeWorkExecutionIntent,
): PlannedCodeViolationWork {
  if (context.tier !== 'full-file') {
    throw new Error('Inline code compilation requires a full-file context tier');
  }
  if ((context.sources ?? context.sourceScopes.map((scope) => ({ path: scope.path, selection: { kind: 'full-file' as const } })))
    .some((source) => source.selection.kind !== 'full-file')) {
    throw new Error('Inline code compilation requires full-file source selections');
  }
  const captured = planCodeViolationWork(context, execution);
  if (captured.request.toolPolicy !== 'read') {
    throw new Error('Inline code compilation requires a Read-enabled full-file source plan');
  }
  const sourceBindings = captured.request.sourceBindings;
  if (sourceBindings.length !== context.files.length || sourceBindings.length === 0) {
    throw new Error('Inline code compilation requires exact Read source bindings');
  }
  const fileList = fullFileList(context, execution.repositoryRoot!, sourceBindings);
  return planCodeViolationWork(context, execution, {
    contract: INLINE_FULL_FILE_SOURCE_DELIVERY,
    sourceBindings,
    fileList,
  });
}
