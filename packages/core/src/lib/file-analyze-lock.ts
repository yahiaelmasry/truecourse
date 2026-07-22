import fs from 'node:fs';
import path from 'node:path';
import { AnalyzeLockError, type AnalyzeLock } from './analyze-lock-contract.js';
import {
  loadNativeFileLock,
  type NativeFileLockLoader,
} from './native-file-lock.js';

const LOCK_FILENAME = '.analyze.lock';
const NATIVE_MARKER = 'TRUECOURSE_ANALYZE_LOCK\nversion=1\n';

function lockPath(repoKey: string): string {
  return path.join(repoKey, '.truecourse', LOCK_FILENAME);
}

function invalidMarkerError(key: string): AnalyzeLockError {
  const file = lockPath(key);
  return new AnalyzeLockError(
    `Cannot safely acquire the analyze lock for ${key}: ${file} is not the recognized ` +
      'TrueCourse native lock marker. It may be a legacy PID marker or an interrupted ' +
      'marker initialization. Verify that no analyze process is running, then move this ' +
      'unrecognized marker aside and retry. Never edit, replace, or unlink a valid native marker.',
  );
}

async function openMarker(key: string): Promise<fs.promises.FileHandle> {
  const file = lockPath(key);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  try {
    const handle = await fs.promises.open(file, 'wx+');
    try {
      await handle.writeFile(NATIVE_MARKER, 'utf8');
      await handle.sync();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return fs.promises.open(file, 'r+');
  }
}

async function assertNativeMarker(
  key: string,
  handle: fs.promises.FileHandle,
): Promise<void> {
  const descriptorStat = await handle.stat();
  if (!descriptorStat.isFile() || descriptorStat.size !== Buffer.byteLength(NATIVE_MARKER)) {
    throw invalidMarkerError(key);
  }
  const contents = Buffer.alloc(descriptorStat.size);
  const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
  if (bytesRead !== contents.length || contents.toString('utf8') !== NATIVE_MARKER) {
    throw invalidMarkerError(key);
  }
}

async function assertPathIdentity(
  key: string,
  handle: fs.promises.FileHandle,
): Promise<void> {
  const file = lockPath(key);
  let descriptorStat: fs.Stats;
  let pathStat: fs.Stats;
  try {
    [descriptorStat, pathStat] = await Promise.all([handle.stat(), fs.promises.lstat(file)]);
  } catch (error) {
    throw new AnalyzeLockError(
      `Cannot safely admit analyze work for ${key}: the permanent native lock marker ` +
        `${file} changed after it was opened. Restore the original marker; never replace or unlink it.`,
      { cause: error },
    );
  }
  if (
    !descriptorStat.isFile()
    || !pathStat.isFile()
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino
    || descriptorStat.nlink < 1
  ) {
    throw new AnalyzeLockError(
      `Cannot safely admit analyze work for ${key}: the permanent native lock marker ` +
        `${file} was replaced or unlinked. Restore the original marker; never replace or unlink it.`,
    );
  }
}

export class FileAnalyzeLock implements AnalyzeLock {
  private readonly heldKeys = new Set<string>();

  constructor(private readonly loadNative: NativeFileLockLoader = loadNativeFileLock) {}

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.heldKeys.has(key)) {
      throw new AnalyzeLockError(
        `Cannot re-enter the analyze lock for ${key} while this process already holds it.`,
        { reason: 'reentrant' },
      );
    }
    this.heldKeys.add(key);
    let handle: fs.promises.FileHandle | undefined;
    try {
      try {
        handle = await openMarker(key);
      } catch (error) {
        throw new AnalyzeLockError(
          `TrueCourse cannot open or initialize ${lockPath(key)}. Check that the repository ` +
            'is on a supported local filesystem and that its .truecourse directory is writable; refusing to run unlocked.',
          { cause: error },
        );
      }
      await assertNativeMarker(key, handle);

      let nativeLock;
      try {
        nativeLock = this.loadNative();
      } catch (error) {
        throw new AnalyzeLockError(
          'TrueCourse cannot load its native analyze-lock binding. Supported targets are ' +
            'macOS 12+ (x64/arm64), Windows (x64/arm64), and glibc-based Linux ' +
            '(x64/arm64); musl/Alpine and other targets must use a supported environment. ' +
            `If this target is supported, reinstall TrueCourse before analyzing ${key}; refusing to run unlocked.`,
          { cause: error },
        );
      }

      let acquired: boolean;
      try {
        acquired = nativeLock.tryLock(handle.fd);
      } catch (error) {
        throw new AnalyzeLockError(
          `The operating system could not lock ${lockPath(key)} on this filesystem. ` +
            'TrueCourse supports native locking on common local filesystems and will not use a stale-file fallback.',
          { cause: error },
        );
      }
      if (!acquired) {
        throw new AnalyzeLockError(`Another analyze is already running for ${key}.`, {
          reason: 'contended',
        });
      }

      await assertNativeMarker(key, handle);
      await assertPathIdentity(key, handle);
      return await operation();
    } finally {
      if (handle) await handle.close();
      this.heldKeys.delete(key);
    }
  }
}
