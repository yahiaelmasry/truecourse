import { createRequire } from 'node:module';

export interface NativeFileLock {
  tryLock(fd: number): boolean;
}

export type NativeFileLockLoader = () => NativeFileLock;

const require = createRequire(import.meta.url);

/** Load the CommonJS native addon only when an OSS analyze lock is requested. */
export const loadNativeFileLock: NativeFileLockLoader = () => {
  const candidate = require('fs-native-extensions') as Partial<NativeFileLock>;
  if (typeof candidate.tryLock !== 'function') {
    throw new TypeError('fs-native-extensions does not expose tryLock(fd)');
  }
  return { tryLock: candidate.tryLock.bind(candidate) };
};
