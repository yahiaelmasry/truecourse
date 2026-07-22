/**
 * Postgres implementation of core's `AnalyzeLock` using session-level
 * `pg_advisory_lock`. Unlike the file lock (a lockfile on a throwaway clone that
 * each run recreates), this serializes two analyses of the SAME repo even across
 * separate clones/processes: the callback waits until the advisory lock is free.
 *
 * The lock is session-scoped, so acquire + unlock must run on the SAME
 * connection — a dedicated pool client stays private for the callback lifetime
 * and is returned after unlock. The key is hashed to an advisory-lock id via Postgres
 * `hashtext` (a rare hash collision merely makes two unrelated repos serialize —
 * harmless).
 */

import type { Pool, PoolClient } from '@truecourse/ee-db';
import {
  AnalyzeLockError,
  type AnalyzeLock,
} from '@truecourse/core/lib/analyze-lock';

function destroyClient(client: PoolClient, cause: unknown): void {
  const error = cause instanceof Error
    ? cause
    : new Error('Postgres analyze-lock session became unsafe', { cause });
  try {
    client.release(error);
  } catch {
    // The client is already unusable. Cleanup must not replace the callback or
    // acquisition error that explains why this session is being destroyed.
  }
}

export class PgAnalyzeLock implements AnalyzeLock {
  private readonly held = new Set<string>();

  constructor(private readonly pool: Pool) {}

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // Re-entrant acquire would be a self-deadlock: the second `pg_advisory_lock`
    // runs on a DIFFERENT pooled connection (a separate session), so it would
    // block forever waiting on the lock this same process already holds. Fail
    // fast instead — like the file lock, a key held by us is a caller bug.
    if (this.held.has(key)) {
      throw new AnalyzeLockError(
        `Cannot re-enter the analyze lock for ${key} while this process already holds it.`,
        { reason: 'reentrant' },
      );
    }
    this.held.add(key);
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.held.delete(key);
      throw error;
    }
    try {
      try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      } catch (error) {
        // A rejected acquire is ambiguous: Postgres may have taken the
        // session-scoped lock before the reply/connection failed. Destroy that
        // exact session so it can never return to the pool with a hidden lock.
        destroyClient(client, error);
        throw error;
      }
      try {
        return await operation();
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
          client.release();
        } catch (error) {
          // A broken session is destroyed. Closing that exact session releases
          // its advisory lock, and cleanup never replaces the callback result.
          destroyClient(client, error);
        }
      }
    } finally {
      this.held.delete(key);
    }
  }
}
