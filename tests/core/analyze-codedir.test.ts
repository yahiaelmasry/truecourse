import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Same socket stub as the analyze e2e test — getIO() throws with no server.
vi.mock('../../apps/dashboard/server/src/socket/handlers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/dashboard/server/src/socket/handlers')>();
  class NoopTracker {
    start() {}
    done() {}
    error() {}
    detail() {}
  }
  return {
    ...actual,
    emitAnalysisProgress: vi.fn(),
    emitAnalysisComplete: vi.fn(),
    emitViolationsReady: vi.fn(),
    emitFilesChanged: vi.fn(),
    emitAnalysisCanceled: vi.fn(),
    createSocketTracker: () => new NoopTracker(),
    createSocketLlmEstimateHandler: () => () => Promise.resolve(true),
  };
});

import { analyzeInProcess } from '../../packages/core/src/commands/analyze-in-process';
import { analyzeCoreAndFinalize } from '../../packages/core/src/commands/analyze-core';
import { readLatest, clearLatestCache } from '../../packages/core/src/lib/analysis-store';
import { withAnalyzeLifecycleLock } from '../../packages/core/src/lib/analyze-lifecycle-lock';
import {
  registerProject,
  resetRegistryStore,
  type RegistryEntry,
} from '../../packages/core/src/config/registry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/sample-js-project-negative');

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.truecourse' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

describe('analyzeInProcess with codeDir — code ≠ storage key (the EE flow)', () => {
  let codeDir: string; // the "clone" — where the code is
  let keyDir: string; // the storage key — an opaque repo identity, here a path
  let project: RegistryEntry;
  let truecourseHome: string;
  const originalHome = process.env.TRUECOURSE_HOME;

  beforeAll(async () => {
    truecourseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codedir-home-'));
    process.env.TRUECOURSE_HOME = truecourseHome;
    resetRegistryStore();
    codeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codedir-code-'));
    copyDir(FIXTURE_SRC, codeDir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    execSync('git init -q -b main', { cwd: codeDir, env });
    execSync('git add -A', { cwd: codeDir, env });
    execSync('git -c commit.gpgsign=false commit -q -m init', { cwd: codeDir, env });

    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-codedir-key-'));
    // Storage identity ≠ code, but it remains a registered project.
    project = await registerProject(keyDir, 'codedir');
    clearLatestCache();
  });

  afterAll(() => {
    clearLatestCache();
    resetRegistryStore();
    if (originalHome === undefined) delete process.env.TRUECOURSE_HOME;
    else process.env.TRUECOURSE_HOME = originalHome;
    for (const d of [codeDir, keyDir, truecourseHome]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('reads code from codeDir but stores the analysis under project.path', async () => {
    const result = await analyzeInProcess(project, {
      codeDir,
      enableLlmRulesOverride: false,
      skipStash: true,
      branch: 'main',
      commitHash: 'deadbeef',
    });
    expect(result.serviceCount).toBeGreaterThan(0); // the fixture code WAS analyzed

    // Stored under the key (keyDir), NOT under the code dir.
    const underKey = await readLatest(keyDir);
    expect(underKey).not.toBeNull();
    expect(underKey!.analysis.id).toBe(result.analysisId);
    expect(underKey!.graph.services.length).toBeGreaterThan(0);
    expect(underKey!.violations.length).toBeGreaterThan(0);

    // The code dir got no store written to it.
    expect(await readLatest(codeDir)).toBeNull();
    expect(fs.existsSync(path.join(codeDir, '.truecourse', 'LATEST.json'))).toBe(false);
  }, 30_000);

  it('keeps the storage-key lock held while the finalizer is pending', async () => {
    let enterFinalizer!: () => void;
    let allowFinalizer!: () => void;
    const finalizerEntered = new Promise<void>((resolve) => { enterFinalizer = resolve; });
    const finalizerAllowed = new Promise<void>((resolve) => { allowFinalizer = resolve; });
    const lifecycle = analyzeCoreAndFinalize(
      project,
      {
        codeDir,
        mode: 'full',
        enableLlmRulesOverride: false,
        skipStash: true,
        branch: 'main',
        commitHash: 'deadbeef',
      },
      async (core) => {
        enterFinalizer();
        await finalizerAllowed;
        return core.analysisId;
      },
    );

    await finalizerEntered;
    await expect(withAnalyzeLifecycleLock(keyDir, async () => 'nested')).rejects.toThrow(/already running|re-enter/i);
    allowFinalizer();
    await expect(lifecycle).resolves.toEqual(expect.any(String));
    await expect(withAnalyzeLifecycleLock(keyDir, async () => 'available')).resolves.toBe('available');
  }, 30_000);
});
