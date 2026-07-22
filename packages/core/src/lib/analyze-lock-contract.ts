export type AnalyzeLockErrorReason = 'contended' | 'reentrant' | 'unsafe';

export interface AnalyzeLockErrorOptions extends ErrorOptions {
  reason?: AnalyzeLockErrorReason;
}

export class AnalyzeLockError extends Error {
  readonly reason: AnalyzeLockErrorReason;

  constructor(message: string, options: AnalyzeLockErrorOptions = {}) {
    super(message, options);
    this.name = 'AnalyzeLockError';
    this.reason = options.reason ?? 'unsafe';
  }
}

/** Pluggable analyze lock. File-backed (fail-fast) by default; EE injects Postgres (waits). */
export interface AnalyzeLock {
  /** Hold the lock for exactly one callback. The file implementation fails fast
   * on contention; the EE implementation waits until its session owns the lock. */
  withLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
}
