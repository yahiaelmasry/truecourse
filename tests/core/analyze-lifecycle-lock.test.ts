import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import {
  withAnalyzeLifecycleLock,
} from '../../packages/core/src/lib/analyze-lifecycle-lock.js';
import {
  FileAnalyzeLock,
} from '../../packages/core/src/lib/file-analyze-lock.js';

const repositories: string[] = [];
const fixtureChildren = new Set<ChildProcessWithoutNullStreams>();
const survivorPids = new Set<number>();
const fixture = fileURLToPath(new URL('../fixtures/analyze-lock-process.ts', import.meta.url));

afterEach(async () => {
  const closing: Promise<unknown>[] = [];
  for (const child of fixtureChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    closing.push(new Promise((resolve) => child.once('close', resolve)));
  }
  await Promise.allSettled(closing);
  fixtureChildren.clear();
  for (const pid of survivorPids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  survivorPids.clear();
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

interface RunningFixture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: () => string;
  waitFor(fragment: string): Promise<void>;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function runFixture(
  repoPath: string,
  options: {
    barrier?: string;
    holdMs?: number;
    spawnSurvivor?: boolean;
    release?: string;
  } = {},
): RunningFixture {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    fixture,
    repoPath,
    options.barrier ?? '-',
    String(options.holdMs ?? 100),
    String(options.spawnSurvivor ?? false),
    options.release ?? '-',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  fixtureChildren.add(child);
  let stdout = '';
  let stderr = '';
  const waiters = new Map<string, Array<() => void>>();
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('close', (code, signal) => {
      fixtureChildren.delete(child);
      resolve({ code, signal });
    }),
  );
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    for (const [fragment, resolves] of waiters) {
      if (!stdout.includes(fragment)) continue;
      waiters.delete(fragment);
      for (const resolve of resolves) resolve();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return {
    child,
    output: () => `${stdout}${stderr}`,
    waitFor: async (fragment) => {
      if (stdout.includes(fragment)) return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Timed out waiting for ${fragment}; output: ${stdout}${stderr}`));
        }, 10_000);
        const done = () => {
          clearTimeout(timeout);
          resolve();
        };
        const current = waiters.get(fragment) ?? [];
        current.push(done);
        waiters.set(fragment, current);
        void closePromise.then(({ code, signal }) => {
          if (stdout.includes(fragment)) return;
          clearTimeout(timeout);
          reject(new Error(
            `Child closed before ${fragment} (code ${code}, signal ${signal}); output: ${stdout}${stderr}`,
          ));
        });
      });
    },
    exited: () => closePromise,
  };
}

async function bootstrapMarker(repoPath: string): Promise<void> {
  await withAnalyzeLifecycleLock(repoPath, async () => undefined);
}

describe('analyze lifecycle lock', () => {
  it('keeps one permanent versioned marker with a stable inode across normal cycles', async () => {
    const repoPath = repository();
    const marker = path.join(repoPath, '.truecourse', '.analyze.lock');

    await expect(withAnalyzeLifecycleLock(repoPath, async () => 'first')).resolves.toBe('first');
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('TRUECOURSE_ANALYZE_LOCK\nversion=1\n');
    const firstIdentity = statSync(marker);

    await expect(withAnalyzeLifecycleLock(repoPath, async () => 'second')).resolves.toBe('second');
    const secondIdentity = statSync(marker);
    expect({ dev: secondIdentity.dev, ino: secondIdentity.ino }).toEqual({
      dev: firstIdentity.dev,
      ino: firstIdentity.ino,
    });
  });

  it('releases the repository lock when persistence fails', async () => {
    const repoPath = repository();
    await expect(withAnalyzeLifecycleLock(repoPath, async () => {
      throw new Error('persistence failed');
    })).rejects.toThrow('persistence failed');

    await expect(withAnalyzeLifecycleLock(repoPath, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('fails fast for a distinct open descriptor while the lifecycle callback is active', async () => {
    const repoPath = repository();
    const competingLock = new FileAnalyzeLock();
    await withAnalyzeLifecycleLock(repoPath, async () => {
      await expect(competingLock.withLock(repoPath, async () => 'unsafe')).rejects.toMatchObject({
        reason: 'contended',
      });
    });
  });

  it.each([
    [`${process.pid}\n2026-07-22T00:00:00.000Z\n`, 'live legacy PID marker'],
    ['99999999\n2026-07-22T00:00:00.000Z\n', 'dead legacy PID marker'],
    ['', 'empty bootstrap-crash marker'],
    ['TRUECOURSE_ANALYZE_LOCK\nversion=0\n', 'malformed marker'],
  ])('fails closed without admitting the callback for a %s', async (contents) => {
    const repoPath = repository();
    const marker = path.join(repoPath, '.truecourse', '.analyze.lock');
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, contents);
    let admitted = false;

    await expect(withAnalyzeLifecycleLock(repoPath, async () => {
      admitted = true;
    })).rejects.toThrow(/not the recognized TrueCourse native lock marker/i);
    expect(admitted).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe(contents);
  });

  it('fails closed with actionable guidance when the native binding cannot load', async () => {
    const repoPath = repository();
    const lock = new FileAnalyzeLock(() => {
      throw new Error('missing native binary');
    });
    let admitted = false;
    await expect(lock.withLock(repoPath, async () => {
      admitted = true;
    })).rejects.toThrow(
      /macOS 12\+.*Windows.*glibc-based Linux.*reinstall.*refusing to run unlocked/i,
    );
    expect(admitted).toBe(false);
  });

  it('fails closed with filesystem guidance when native tryLock throws', async () => {
    const repoPath = repository();
    const lock = new FileAnalyzeLock(() => ({
      tryLock: () => {
        throw new Error('filesystem does not support locking');
      },
    }));
    let admitted = false;
    await expect(lock.withLock(repoPath, async () => {
      admitted = true;
    })).rejects.toThrow(/common local filesystems.*will not use a stale-file fallback/i);
    expect(admitted).toBe(false);
  });

  it('fails closed with actionable guidance when the marker cannot be opened', async () => {
    const repoPath = repository();
    writeFileSync(path.join(repoPath, '.truecourse'), 'not a directory');
    let admitted = false;
    await expect(withAnalyzeLifecycleLock(repoPath, async () => {
      admitted = true;
    })).rejects.toThrow(/cannot open or initialize.*supported local filesystem.*writable/i);
    expect(admitted).toBe(false);
  });

  it('detects marker replacement before admitting the callback', async () => {
    const repoPath = repository();
    await withAnalyzeLifecycleLock(repoPath, async () => undefined);
    const marker = path.join(repoPath, '.truecourse', '.analyze.lock');
    const moved = `${marker}.moved`;
    const lock = new FileAnalyzeLock(() => ({
      tryLock: () => {
        renameSync(marker, moved);
        writeFileSync(marker, 'TRUECOURSE_ANALYZE_LOCK\nversion=1\n');
        return true;
      },
    }));
    let admitted = false;
    await expect(lock.withLock(repoPath, async () => {
      admitted = true;
    })).rejects.toThrow(/replaced or unlinked/i);
    expect(admitted).toBe(false);
  });

  it('rejects reentrant acquisition promptly and then remains usable', async () => {
    const repoPath = repository();
    const lock = new FileAnalyzeLock();
    await lock.withLock(repoPath, async () => {
      await expect(lock.withLock(repoPath, async () => 'nested')).rejects.toMatchObject({
        reason: 'reentrant',
      });
    });
    await expect(lock.withLock(repoPath, async () => 'later')).resolves.toBe('later');
  });

  it('excludes a live analyze running in a separate process', async () => {
    const repoPath = repository();
    await bootstrapMarker(repoPath);
    const holder = runFixture(repoPath, { holdMs: 60_000 });
    try {
      await holder.waitFor('ACQUIRED');
      await expect(withAnalyzeLifecycleLock(repoPath, async () => 'unsafe')).rejects.toThrow(
        /already running/i,
      );
    } finally {
      holder.child.kill('SIGTERM');
      await holder.exited();
    }
    await expect(withAnalyzeLifecycleLock(repoPath, async () => 'safe')).resolves.toBe('safe');
  });

  it('admits exactly one of two simultaneous separate-process contenders', async () => {
    const repoPath = repository();
    await bootstrapMarker(repoPath);
    const barrier = path.join(repoPath, 'go');
    const release = path.join(repoPath, 'release');
    const first = runFixture(repoPath, { barrier, release });
    const second = runFixture(repoPath, { barrier, release });
    try {
      await Promise.all([first.waitFor('READY'), second.waitFor('READY')]);
      writeFileSync(barrier, 'go');
      await Promise.all([
        Promise.any([first.waitFor('ACQUIRED'), second.waitFor('ACQUIRED')]),
        Promise.any([first.waitFor('BLOCKED'), second.waitFor('BLOCKED')]),
      ]);
      writeFileSync(release, 'release');
      const exits = await Promise.all([first.exited(), second.exited()]);
      const outputs = [first.output(), second.output()];
      expect(outputs.filter((output) => output.includes('ACQUIRED'))).toHaveLength(1);
      expect(outputs.filter((output) => output.includes('BLOCKED'))).toHaveLength(1);
      expect(exits.map(({ code }) => code).sort()).toEqual([0, 2]);
    } finally {
      first.child.kill('SIGKILL');
      second.child.kill('SIGKILL');
      await Promise.all([first.exited(), second.exited()]);
    }
  });

  it('a worker-thread separate open cannot take the held native lock', async () => {
    const repoPath = repository();
    await bootstrapMarker(repoPath);
    const marker = path.join(repoPath, '.truecourse', '.analyze.lock');
    const corePackage = path.resolve('packages/core/package.json');
    await withAnalyzeLifecycleLock(repoPath, async () => {
      const granted = await new Promise<boolean>((resolve, reject) => {
        const worker = new Worker(`
          const { parentPort, workerData } = require('node:worker_threads');
          const { createRequire } = require('node:module');
          const fs = require('node:fs');
          const native = createRequire(workerData.corePackage)('fs-native-extensions');
          const fd = fs.openSync(workerData.marker, 'r+');
          try { parentPort.postMessage(native.tryLock(fd)); }
          finally { fs.closeSync(fd); }
        `, { eval: true, workerData: { marker, corePackage } });
        const timeout = setTimeout(() => {
          void worker.terminate();
          reject(new Error('worker lock probe timed out'));
        }, 10_000);
        worker.once('message', (value) => {
          clearTimeout(timeout);
          void worker.terminate();
          resolve(value);
        });
        worker.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        worker.once('exit', (code) => {
          if (code === 0) return;
          clearTimeout(timeout);
          reject(new Error(`worker lock probe exited with code ${code}`));
        });
      });
      expect(granted).toBe(false);
    });
  });

  it('abrupt owner-process termination releases the native lock', async () => {
    const repoPath = repository();
    await bootstrapMarker(repoPath);
    const holder = runFixture(repoPath, { holdMs: 60_000 });
    try {
      await holder.waitFor('ACQUIRED');
      holder.child.kill('SIGKILL');
      await holder.exited();
      if (process.platform !== 'win32') {
        await expect(withAnalyzeLifecycleLock(repoPath, async () => 'recovered')).resolves.toBe(
          'recovered',
        );
      } else {
        // TerminateProcess can release Windows handles a moment after the child
        // reports closed. Bound only this platform-specific cleanup delay.
        const deadline = Date.now() + 2_000;
        let recovered = false;
        while (!recovered && Date.now() < deadline) {
          try {
            await withAnalyzeLifecycleLock(repoPath, async () => undefined);
            recovered = true;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        expect(recovered).toBe(true);
      }
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'SIGKILL releases native ownership while an unrelated spawned child survives',
    async () => {
      const repoPath = repository();
      await bootstrapMarker(repoPath);
      const holder = runFixture(repoPath, { holdMs: 60_000, spawnSurvivor: true });
      try {
        await holder.waitFor('ACQUIRED:');
        const match = /ACQUIRED:(\d+)/.exec(holder.output());
        expect(match).not.toBeNull();
        const survivorPid = Number(match![1]);
        survivorPids.add(survivorPid);
        holder.child.kill('SIGKILL');
        await holder.exited();
        expect(() => process.kill(survivorPid, 0)).not.toThrow();
        await expect(withAnalyzeLifecycleLock(repoPath, async () => 'recovered')).resolves.toBe(
          'recovered',
        );
      } finally {
        holder.child.kill('SIGKILL');
        await holder.exited();
        for (const pid of survivorPids) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
          const deadline = Date.now() + 2_000;
          while (Date.now() < deadline) {
            try {
              process.kill(pid, 0);
              await new Promise((resolve) => setTimeout(resolve, 10));
            } catch {
              break;
            }
          }
          survivorPids.delete(pid);
        }
      }
    },
  );

  it('does not expose key-based acquire or release operations', async () => {
    const publicLock = await import('../../packages/core/src/lib/analyze-lock.js');
    expect(publicLock).not.toHaveProperty('acquireAnalyzeLock');
    expect(publicLock).not.toHaveProperty('releaseAnalyzeLock');
  });
});
