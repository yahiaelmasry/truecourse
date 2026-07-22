import { describe, it, expect } from 'vitest';
import { PgAnalyzeLock } from '@truecourse/ee-data-store';
import type { EeDbHandle } from '@truecourse/ee-db';

/**
 * The advisory lock's correctness is its connection lifecycle: acquire + unlock
 * must run on the SAME client, and the client must always be returned to the
 * pool. A real `pg_advisory_lock` needs a live Postgres session (PGlite is a
 * single in-process connection and can't model cross-connection blocking), so
 * we drive a fake pool that records every query and release.
 */

interface QueryCall {
  client: number;
  sql: string;
  params: unknown[];
}

function fakePool(opts: { failOn?: 'lock' | 'unlock'; releaseThrows?: boolean } = {}) {
  const queries: QueryCall[] = [];
  const released: number[] = [];
  const releaseArgs: unknown[] = []; // what was passed to client.release()
  let nextClient = 0;
  const pool = {
    connect: async () => {
      const id = nextClient++;
      return {
        query: async (sql: string, params: unknown[]) => {
          queries.push({ client: id, sql, params });
          if (opts.failOn === 'lock' && sql.includes('pg_advisory_lock(')) {
            throw new Error('boom');
          }
          if (opts.failOn === 'unlock' && sql.includes('pg_advisory_unlock(')) {
            throw new Error('unlock failed');
          }
          return {};
        },
        release: (arg?: unknown) => {
          released.push(id);
          releaseArgs.push(arg);
          if (opts.releaseThrows) throw new Error('release failed');
        },
      };
    },
  } as unknown as EeDbHandle['lockPool'];
  return { pool, queries, released, releaseArgs };
}

describe('PgAnalyzeLock', () => {
  it('acquires and releases on the same connection, then returns it to the pool', async () => {
    const { pool, queries, released } = fakePool();
    const lock = new PgAnalyzeLock(pool);

    await expect(lock.withLock('acme/api', async () => {
      expect(queries).toEqual([
        { client: 0, sql: expect.stringContaining('pg_advisory_lock(hashtext($1))'), params: ['acme/api'] },
      ]);
      expect(released).toEqual([]); // still held — connection NOT returned
      return 'done';
    })).resolves.toBe('done');
    expect(queries[1]).toEqual({
      client: 0, // same connection that took the lock
      sql: expect.stringContaining('pg_advisory_unlock(hashtext($1))'),
      params: ['acme/api'],
    });
    expect(released).toEqual([0]); // connection returned exactly once
  });

  it('destroys the suspect connection if the lock query itself fails', async () => {
    const { pool, released, releaseArgs } = fakePool({ failOn: 'lock' });
    const lock = new PgAnalyzeLock(pool);
    await expect(lock.withLock('acme/api', async () => 'unreachable')).rejects.toThrow('boom');
    expect(released).toEqual([0]); // no leaked connection on failure
    expect(releaseArgs[0]).toBeInstanceOf(Error);
  });

  it('refuses a re-entrant acquire of the same key (self-deadlock guard)', async () => {
    const { pool, released } = fakePool();
    const lock = new PgAnalyzeLock(pool);
    await lock.withLock('acme/api', async () => {
      await expect(lock.withLock('acme/api', async () => 'nested')).rejects.toMatchObject({
        reason: 'reentrant',
      });
      expect(released).toEqual([]); // the held connection is untouched
    });
    expect(released).toEqual([0]);
  });

  it('destroys the connection (passes the error to release) when unlock fails', async () => {
    const { pool, released, releaseArgs } = fakePool({
      failOn: 'unlock',
      releaseThrows: true,
    });
    const lock = new PgAnalyzeLock(pool);
    // Cleanup must not replace a successful operation result when unlock fails.
    await expect(lock.withLock('acme/api', async () => 'complete')).resolves.toBe('complete');
    expect(released).toEqual([0]);
    // A suspect connection is destroyed, not returned clean: release got an Error.
    expect(releaseArgs[0]).toBeInstanceOf(Error);
  });

  it('returns the exact client and preserves the callback error', async () => {
    const { pool, released } = fakePool();
    const lock = new PgAnalyzeLock(pool);
    await expect(lock.withLock('acme/api', async () => {
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');
    expect(released).toEqual([0]);
  });

  it('preserves a callback that throws undefined while still releasing the client', async () => {
    const { pool, released } = fakePool();
    const lock = new PgAnalyzeLock(pool);
    let rejected = false;
    try {
      await lock.withLock('acme/api', async () => {
        throw undefined;
      });
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }
    expect(rejected).toBe(true);
    expect(released).toEqual([0]);
  });
});
