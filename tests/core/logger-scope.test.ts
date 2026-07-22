import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeLogger,
  configureLogger,
  log,
  withLogger,
} from '../../packages/core/src/lib/logger.js';

let root: string | null = null;

afterEach(async () => {
  await closeLogger();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('owned logger scopes', () => {
  it('removes the requested scope when concurrent runs finish out of order', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-logger-scope-'));
    configureLogger({ filePath: path.join(root, 'base.log') });
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const first = withLogger({ filePath: path.join(root, 'first.log') }, async () => {
      await releaseFirst.promise;
      log.info('message from first repository');
    });
    const second = withLogger({ filePath: path.join(root, 'second.log') }, async () => {
      await releaseSecond.promise;
      log.info('message from second repository');
    });

    releaseFirst.resolve();
    await first;
    releaseSecond.resolve();
    await second;
    await closeLogger();

    expect(fs.readFileSync(path.join(root, 'first.log'), 'utf8')).toContain('message from first');
    expect(fs.readFileSync(path.join(root, 'second.log'), 'utf8')).toContain('message from second');
  });

  it('keeps interleaved repository logs in their own async scope', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-logger-concurrent-'));
    configureLogger({ filePath: path.join(root, 'base.log') });
    const firstReady = deferred<void>();
    const secondReady = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();

    const firstRun = withLogger({ filePath: path.join(root, 'first.log') }, async () => {
      firstReady.resolve();
      await releaseFirst.promise;
      log.info('message from first repository');
    });
    const secondRun = withLogger({ filePath: path.join(root, 'second.log') }, async () => {
      secondReady.resolve();
      await releaseSecond.promise;
      log.info('message from second repository');
    });

    await Promise.all([firstReady.promise, secondReady.promise]);
    releaseFirst.resolve();
    await firstRun;
    releaseSecond.resolve();
    await secondRun;

    const firstLog = fs.readFileSync(path.join(root, 'first.log'), 'utf8');
    const secondLog = fs.readFileSync(path.join(root, 'second.log'), 'utf8');
    expect(firstLog).toContain('message from first repository');
    expect(firstLog).not.toContain('message from second repository');
    expect(secondLog).toContain('message from second repository');
    expect(secondLog).not.toContain('message from first repository');
  });

  it('rejects an asynchronous file-open failure before returning a scope', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-logger-open-failure-'));
    const directoryPath = path.join(root, 'not-a-log-file');
    fs.mkdirSync(directoryPath);

    await expect(withLogger({ filePath: directoryPath }, async () => undefined)).rejects.toMatchObject({
      code: expect.stringMatching(/EISDIR|EACCES/),
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
