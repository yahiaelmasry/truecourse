import { withAnalyzeLock } from './analyze-lock.js';

/** Hold the repository-wide analyze lock for one complete compute/persist lifecycle. */
export async function withAnalyzeLifecycleLock<T>(
  repositoryKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withAnalyzeLock(repositoryKey, operation);
}
