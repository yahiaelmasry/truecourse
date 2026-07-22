import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Analysis Registry — tracks active analyses for cancellation support
// ---------------------------------------------------------------------------

interface ActiveAnalysis {
  analysisId: string;
  abortController: AbortController;
  childProcesses: Set<ChildProcess>;
}

const activeAnalyses = new Map<string, ActiveAnalysis>();

/** Atomically claim a repository only when no analysis handler owns it. */
export function tryRegisterAnalysis(repoId: string, analysisId: string): AbortController | null {
  if (activeAnalyses.has(repoId)) return null;
  const abortController = new AbortController();
  activeAnalyses.set(repoId, {
    analysisId,
    abortController,
    childProcesses: new Set(),
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
export function cancelAnalysis(repoId: string): boolean {
  const entry = activeAnalyses.get(repoId);
  if (!entry) return false;

  entry.abortController.abort();
  for (const child of entry.childProcesses) {
    if (!child.killed) child.kill('SIGTERM');
  }
  return true;
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
