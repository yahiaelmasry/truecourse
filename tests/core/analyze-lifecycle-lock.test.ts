import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireAnalyzeLock,
  releaseAnalyzeLock,
} from '../../packages/core/src/lib/atomic-write.js';
import {
  withAnalyzeLifecycleLock,
} from '../../packages/core/src/lib/analyze-lifecycle-lock.js';

const repositories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function repository(): string {
  const created = mkdtempSync(path.join(tmpdir(), 'truecourse-analyze-lifecycle-'));
  repositories.push(created);
  return created;
}

describe('analyze lifecycle lock', () => {
  it('retains the repository lock until the supplied persistence operation settles', async () => {
    const repoPath = repository();
    const entered = deferred();
    const allowPersistence = deferred();
    const lifecycle = withAnalyzeLifecycleLock(repoPath, async () => {
      entered.resolve();
      await allowPersistence.promise;
      return 'persisted';
    });

    await entered.promise;
    await expect(acquireAnalyzeLock(repoPath)).rejects.toThrow(/already running/i);

    allowPersistence.resolve();
    await expect(lifecycle).resolves.toBe('persisted');
    await expect(acquireAnalyzeLock(repoPath)).resolves.toBeUndefined();
    await releaseAnalyzeLock(repoPath);
  });

  it('releases the repository lock when persistence fails', async () => {
    const repoPath = repository();
    await expect(withAnalyzeLifecycleLock(repoPath, async () => {
      throw new Error('persistence failed');
    })).rejects.toThrow('persistence failed');

    await expect(acquireAnalyzeLock(repoPath)).resolves.toBeUndefined();
    await releaseAnalyzeLock(repoPath);
  });
});
