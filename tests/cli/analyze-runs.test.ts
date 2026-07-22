import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { AnalyzeRunStatus } from '../../packages/core/src/commands/analyze-run-status.js';
import {
  formatAnalyzeRunStatus,
  runAnalyzeStatus,
} from '../../tools/cli/src/commands/analyze-runs.js';

describe('analyze run CLI status', () => {
  it('shows the interrupted latest run separately from the active completed baseline', () => {
    expect(formatAnalyzeRunStatus(blockedStatus())).toEqual([
      'Latest run: run-interrupted · blocked · 1/2 LLM checks complete · 1 pending',
      'Provider reported reset: tomorrow 8pm (Africa/Cairo) (advisory)',
      'Resume: structurally available after the provider reset and full revalidation; the CLI action is not available in this version',
      'Active completed analysis: analysis-completed · 2026-07-19T09:00:00.000Z · main@abc1234',
    ]);
  });

  it('reads status without creating analysis state in a fresh repository', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-status-'));
    const lines: string[] = [];
    try {
      await runAnalyzeStatus({ cwd: repoPath, writeLine: (line) => lines.push(line) });
      expect(lines).toEqual(['Latest run: none', 'Active completed analysis: none']);
      expect(fs.existsSync(path.join(repoPath, '.truecourse'))).toBe(false);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('registers `truecourse analyze status` as a read-only command', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-status-command-'));
    try {
      const output = execFileSync(
        process.execPath,
        ['--import', createRequire(import.meta.url).resolve('tsx'), path.resolve('tools/cli/src/index.ts'), 'analyze', 'status'],
        { cwd: repoPath, encoding: 'utf8', timeout: 10_000 },
      );
      expect(output.trim().split('\n')).toEqual(['Latest run: none', 'Active completed analysis: none']);
      expect(fs.existsSync(path.join(repoPath, '.truecourse'))).toBe(false);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('preserves the existing analyze options when status becomes a subcommand', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', createRequire(import.meta.url).resolve('tsx'), path.resolve('tools/cli/src/index.ts'), 'analyze', '--help'],
      { encoding: 'utf8', timeout: 10_000 },
    );

    expect(output).toContain('--diff');
    expect(output).toContain('--llm');
    expect(output).toContain('status');
  });

  it('explains when a blocked run cannot establish a verified model for Resume', () => {
    const status = blockedStatus();
    status.latestAttempt!.resume = { available: false, reason: 'successful-results-not-checkpointed' };
    expect(formatAnalyzeRunStatus(status)).toContain(
      'Resume: unavailable — no verified successful checkpoint can establish the original model',
    );
    expect(formatAnalyzeRunStatus(status).join('\n')).not.toContain('structurally available');
  });

  it('retains the provider reset report after a saved run enters recovery', () => {
    const status = blockedStatus();
    status.latestAttempt!.state = 'running';
    status.latestAttempt!.blocked = null;
    status.latestAttempt!.executionAttempt = {
      number: 2,
      activatedAt: '2026-07-19T10:00:03.000Z',
      resume: {
        admission: 'activated',
        admittedAt: null,
        resumedFrom: {
          reason: 'provider-session-limit',
          resetHint: 'tomorrow 8pm (Africa/Cairo)',
          blockedAt: '2026-07-19T10:00:02.000Z',
        },
        executionPin: {
          provider: 'claude-code',
          requestedModel: 'sonnet',
          modelSelection: 'requested',
          resolvedModel: null,
        },
      },
    };

    expect(formatAnalyzeRunStatus(status)).toContain(
      'Provider reported reset: tomorrow 8pm (Africa/Cairo) (advisory)',
    );
  });
});

function blockedStatus(): AnalyzeRunStatus {
  return {
    latestAttempt: {
      schemaVersion: 7,
      revision: 3,
      runId: 'run-interrupted',
      candidateAnalysisId: 'analysis-incomplete',
      state: 'blocked',
      startedAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:02.000Z',
      source: 'cli',
      branch: 'main',
      commitHash: 'def456789',
      completedBaselineId: 'analysis-completed',
      executionAttempt: { number: 1, activatedAt: '2026-07-19T10:00:00.000Z', resume: null },
      plan: 'sealed',
      counts: { total: 2, pending: 1, running: 0, succeeded: 1, failed: 0 },
      blocked: {
        reason: 'provider-session-limit',
        resetHint: 'tomorrow 8pm (Africa/Cairo)',
        blockedAt: '2026-07-19T10:00:02.000Z',
      },
      lastProviderLimit: {
        reason: 'provider-session-limit',
        resetHint: 'tomorrow 8pm (Africa/Cairo)',
        blockedAt: '2026-07-19T10:00:02.000Z',
      },
      failure: null,
      finalization: null,
      resume: {
        available: true,
        scope: 'structural',
        mode: 'resume',
        requiresLatestAttempt: true,
        requiresRevalidation: true,
      },
    },
    activeCompletedAnalysis: {
      analysisId: 'analysis-completed',
      createdAt: '2026-07-19T09:00:00.000Z',
      branch: 'main',
      commitHash: 'abc123456',
    },
  };
}
