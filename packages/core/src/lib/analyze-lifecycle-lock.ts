import { acquireAnalyzeLock, releaseAnalyzeLock } from './atomic-write.js';

/** Hold the repository-wide analyze lock for one complete compute/persist lifecycle. */
export async function withAnalyzeLifecycleLock<T>(
  repositoryKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  await acquireAnalyzeLock(repositoryKey);
  try {
    return await operation();
  } finally {
    await releaseAnalyzeLock(repositoryKey);
  }
}
