import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalyzeLockError } from '../../packages/core/src/lib/analyze-lock.js';
import { withAnalyzeLifecycleLock } from '../../packages/core/src/lib/analyze-lifecycle-lock.js';

async function main(): Promise<void> {
  const [repoPath, barrierPath, holdText = '100', spawnSurvivor = 'false', releasePath = '-'] = process.argv.slice(2);

  if (!repoPath) throw new Error('repository path is required');

  if (barrierPath !== '-') {
    process.stdout.write('READY\n');
    while (!existsSync(barrierPath)) await delay(5);
  }

  try {
    await withAnalyzeLifecycleLock(repoPath, async () => {
      let survivorPid = '';
      if (spawnSurvivor === 'true') {
        const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
          detached: process.platform !== 'win32',
          stdio: 'ignore',
        });
        survivor.unref();
        survivorPid = `:${survivor.pid ?? ''}`;
      }
      process.stdout.write(`ACQUIRED${survivorPid}\n`);
      if (releasePath === '-') {
        await delay(Number(holdText));
      } else {
        while (!existsSync(releasePath)) await delay(5);
      }
    });
    process.stdout.write('RELEASED\n');
  } catch (error) {
    if (error instanceof AnalyzeLockError) {
      process.stdout.write(`BLOCKED:${error.message}\n`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}

void main();
