/**
 * Analyze lock — prevents two analyze runs against the same repo at once (they
 * would corrupt the shared `LATEST`/history). File-backed by default (a native
 * kernel lock on a permanent marker under `.truecourse/`, fail-fast); the
 * enterprise edition
 * injects a Postgres `pg_advisory_lock` impl via `setAnalyzeLock`, keyed by the
 * repo IDENTITY rather than a path — so two analyses of the same repo serialize
 * even though each runs on its own throwaway clone (the file lock would sit on a
 * different clone each time and never collide).
 *
 * The key is the storage identity (`project.path`): a filesystem path in OSS, an
 * opaque `owner/repo` in EE. The file impl maps it to a lockfile path; the EE
 * impl hashes it to an advisory-lock id.
 */

import { FileAnalyzeLock } from './file-analyze-lock.js';
import type { AnalyzeLock } from './analyze-lock-contract.js';
export { AnalyzeLockError, type AnalyzeLock } from './analyze-lock-contract.js';

let active: AnalyzeLock = new FileAnalyzeLock();

/** The active analyze lock (file-backed unless EE installed a Postgres one). */
export function getAnalyzeLock(): AnalyzeLock {
  return active;
}
/** Install an analyze lock (e.g. the enterprise `pg_advisory_lock` impl). */
export function setAnalyzeLock(lock: AnalyzeLock): void {
  active = lock;
}
/** Restore the file-backed default (tests). */
export function resetAnalyzeLock(): void {
  active = new FileAnalyzeLock();
}

export const withAnalyzeLock = <T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> => active.withLock(key, operation);
