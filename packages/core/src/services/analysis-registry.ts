import type { ChildProcess } from 'node:child_process';
import type { AnalysisActivityMode } from '@truecourse/shared';

// ---------------------------------------------------------------------------
// Analysis Registry — tracks active analyses for cancellation support
// ---------------------------------------------------------------------------

interface ActiveAnalysis {
  analysisId: string;
  abortController: AbortController;
  childProcesses: Set<ChildProcess>;
  mode: AnalysisActivityMode;
}

const activeAnalyses = new Map<string, ActiveAnalysis>();

/** Atomically claim a repository only when no analysis handler owns it. */
export function tryRegisterAnalysis(
  repoId: string,
  analysisId: string,
  mode: AnalysisActivityMode = 'analysis',
): AbortController | null {
  if (activeAnalyses.has(repoId)) return null;
  const abortController = new AbortController();
  activeAnalyses.set(repoId, {
    analysisId,
    abortController,
    childProcesses: new Set(),
    mode,
  });
  return abortController;
}

/** Register a child process for an active analysis (for cleanup on cancel). */
export function registerChildProcess(repoId: string, child: ChildProcess): void {
  const entry = activeAnalyses.get(repoId);
  if (entry) entry.childProcesses.add(child);
}

/** Unregister a child process when it exits naturally. */
export function unregisterChildProcess(repoId: string, child: ChildProcess): void {
  const entry = activeAnalyses.get(repoId);
  if (entry) entry.childProcesses.delete(child);
}

/** Signal an active analysis while its handler retains ownership for cleanup. */
export type CancelAnalysisResult = 'canceled' | 'not-found' | 'protected';

export function cancelAnalysis(repoId: string): CancelAnalysisResult {
  const entry = activeAnalyses.get(repoId);
  if (!entry) return 'not-found';
  if (entry.mode === 'resume') return 'protected';

  entry.abortController.abort();
  for (const child of entry.childProcesses) {
    if (!child.killed) child.kill('SIGTERM');
  }
  return 'canceled';
}

/** Release a repository only for the handler that currently owns it. */
export function unregisterAnalysis(repoId: string, owner: AbortController): void {
  if (activeAnalyses.get(repoId)?.abortController !== owner) return;
  activeAnalyses.delete(repoId);
}

/** Check if an analysis is active for a repo. */
export function isAnalysisActive(repoId: string): boolean {
  return activeAnalyses.has(repoId);
}

export function getActiveAnalysisMode(repoId: string): AnalysisActivityMode | null {
  return activeAnalyses.get(repoId)?.mode ?? null;
}
