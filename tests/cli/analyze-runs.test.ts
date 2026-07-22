import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyzeRunStatus } from '../../packages/core/src/commands/analyze-run-status.js';
import { AnalysisStartBlockedError } from '../../packages/core/src/commands/analyze-in-process.js';
import {
  formatAnalysisStartBlockedError,
  formatAnalyzeRunStatus,
  resolveAnalyzeStartExpectation,
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
        { cwd: repoPath, encoding: 'utf8', timeout: 30_000 },
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
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(output).toContain('--diff');
    expect(output).toContain('--llm');
    expect(output).toContain('--abandon-attempt <run-id>');
    expect(output).toContain('status');
  });

  it('rejects abandonment input for a diff analysis', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        path.resolve('tools/cli/src/index.ts'),
        'analyze',
        '--diff',
        '--abandon-attempt',
        'run-interrupted',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      '--abandon-attempt applies only to a full analysis, not --diff',
    );
  });

  it('rejects abandonment input for the read-only status subcommand', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        path.resolve('tools/cli/src/index.ts'),
        'analyze',
        'status',
        '--abandon-attempt',
        'run-interrupted',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      '--abandon-attempt applies only to a full analysis, not status',
    );
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

  it('directs a resumable attempt toward recovery without prompting for replacement', async () => {
    const confirmAbandon = vi.fn(async () => true);

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      readStatus: async () => blockedStatus(),
      interactive: true,
      confirmAbandon,
    })).rejects.toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'resume-required',
      runId: 'run-interrupted',
    });
    expect(confirmAbandon).not.toHaveBeenCalled();
  });

  it('explains the unavailable CLI Resume action and exact paid-call fallback', () => {
    const message = formatAnalysisStartBlockedError(
      new AnalysisStartBlockedError('resume-required', 'run-interrupted'),
    );

    expect(message).toContain('CLI Resume is not available in this version');
    expect(message).toContain('--abandon-attempt run-interrupted');
    expect(message).toMatch(/paid LLM calls may repeat/i);
  });

  it('accepts an exact explicit start-over override for resumable work', async () => {
    const confirmAbandon = vi.fn(async () => true);

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      abandonAttemptRunId: 'run-interrupted',
      readStatus: async () => blockedStatus(),
      interactive: false,
      confirmAbandon,
    })).resolves.toEqual({ kind: 'abandon', runId: 'run-interrupted' });
    expect(confirmAbandon).not.toHaveBeenCalled();
  });

  it('does not offer start-over while durable finalization needs recovery', async () => {
    const status = blockedStatus();
    status.latestAttempt!.state = 'finalizing';
    status.latestAttempt!.blocked = null;
    status.latestAttempt!.counts = {
      total: 2,
      pending: 0,
      running: 0,
      succeeded: 2,
      failed: 0,
    };
    status.latestAttempt!.finalization = {
      finalizingAt: '2026-07-19T10:00:03.000Z',
      persistence: 'prepared',
      preparedAt: '2026-07-19T10:00:04.000Z',
    };
    status.activeCompletedAnalysis!.analysisId = status.latestAttempt!.candidateAnalysisId;

    const error = await resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      abandonAttemptRunId: 'run-interrupted',
      readStatus: async () => status,
      interactive: false,
      confirmAbandon: async () => true,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'recovery-required',
      runId: 'run-interrupted',
    });
    expect(formatAnalysisStartBlockedError(error as AnalysisStartBlockedError))
      .not.toContain('--abandon-attempt');
  });

  it('does not offer start-over for a legacy finalizing attempt without recovery input', async () => {
    const status = blockedStatus();
    status.latestAttempt!.state = 'finalizing';
    status.latestAttempt!.blocked = null;
    status.latestAttempt!.counts = {
      total: 2,
      pending: 0,
      running: 0,
      succeeded: 2,
      failed: 0,
    };
    status.latestAttempt!.finalization = {
      finalizingAt: '2026-07-19T10:00:03.000Z',
      persistence: 'unprepared',
      preparedAt: null,
    };
    status.latestAttempt!.resume = {
      available: false,
      scope: 'structural',
      reason: 'finalization-unprepared',
    };

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      abandonAttemptRunId: 'run-interrupted',
      readStatus: async () => status,
      interactive: false,
      confirmAbandon: async () => true,
    })).rejects.toMatchObject({
      name: 'AnalysisStartBlockedError',
      reason: 'recovery-required',
      runId: 'run-interrupted',
    });
  });

  it('blocks an execution-ambiguous attempt even with exact replacement input', async () => {
    const status = blockedStatus();
    status.latestAttempt!.state = 'running';
    status.latestAttempt!.blocked = null;
    status.latestAttempt!.resume = {
      available: false,
      scope: 'structural',
      reason: 'resume-execution-ambiguous',
    };

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      abandonAttemptRunId: 'run-interrupted',
      readStatus: async () => status,
      interactive: true,
      confirmAbandon: async () => true,
    })).rejects.toMatchObject({
      reason: 'resume-execution-ambiguous',
      runId: 'run-interrupted',
    });
  });

  it('requires explicit exact consent before replacing non-resumable work', async () => {
    const status = blockedStatus();
    status.latestAttempt!.resume = {
      available: false,
      scope: 'structural',
      reason: 'run-not-resumable',
    };
    const confirmAbandon = vi.fn(async () => true);

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      readStatus: async () => status,
      interactive: false,
      confirmAbandon,
    })).rejects.toMatchObject({
      reason: 'abandon-confirmation-required',
      runId: 'run-interrupted',
    });
    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      abandonAttemptRunId: 'run-interrupted',
      readStatus: async () => status,
      interactive: false,
      confirmAbandon,
    })).resolves.toEqual({ kind: 'abandon', runId: 'run-interrupted' });
    expect(confirmAbandon).not.toHaveBeenCalled();
  });

  it('records interactive replacement only after warning that paid calls may repeat', async () => {
    const status = blockedStatus();
    status.latestAttempt!.resume = {
      available: false,
      scope: 'structural',
      reason: 'run-failed',
    };
    const messages: string[] = [];

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      readStatus: async () => status,
      interactive: true,
      confirmAbandon: async (message) => {
        messages.push(message);
        return true;
      },
    })).resolves.toEqual({ kind: 'abandon', runId: 'run-interrupted' });
    expect(messages.join('\n')).toMatch(/paid LLM calls may repeat/i);
    expect(messages.join('\n')).toMatch(/active completed analysis.*stays canonical/i);
  });

  it('rejects a stale explicit replacement identity before prompting', async () => {
    const status = blockedStatus();
    status.latestAttempt!.resume = {
      available: false,
      scope: 'structural',
      reason: 'run-failed',
    };
    const confirmAbandon = vi.fn(async () => true);

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      abandonAttemptRunId: 'older-run',
      readStatus: async () => status,
      interactive: true,
      confirmAbandon,
    })).rejects.toMatchObject({ reason: 'expectation-changed' });
    expect(confirmAbandon).not.toHaveBeenCalled();
  });

  it('proceeds with an absence expectation when no incomplete attempt exists', async () => {
    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      readStatus: async () => ({ latestAttempt: null, activeCompletedAnalysis: null }),
      interactive: false,
      confirmAbandon: async () => false,
    })).resolves.toEqual({ kind: 'none-incomplete' });
  });

  it('does not repeatedly block on an attempt superseded by a newer completed baseline', async () => {
    const status = blockedStatus();
    status.activeCompletedAnalysis!.analysisId = 'newer-completed-analysis';

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      readStatus: async () => status,
      interactive: false,
      confirmAbandon: async () => false,
    })).resolves.toEqual({ kind: 'none-incomplete' });
    expect(formatAnalyzeRunStatus(status)).toContain(
      'Latest run: completed analysis newer-completed-analysis',
    );
    expect(formatAnalyzeRunStatus(status)).toContain(
      'Superseded saved LLM attempt: run-interrupted · blocked · 1/2 LLM checks complete · 1 pending',
    );
    expect(formatAnalyzeRunStatus(status)).not.toContain(
      'Latest run: run-interrupted · blocked · 1/2 LLM checks complete · 1 pending',
    );
    expect(formatAnalyzeRunStatus(status)).toContain(
      'Resume: unavailable — a newer completed analysis is active',
    );
  });

  it('does not mistake a missing completed baseline for supersession', async () => {
    const status = blockedStatus();
    status.activeCompletedAnalysis = null;

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      readStatus: async () => status,
      interactive: false,
      confirmAbandon: async () => false,
    })).rejects.toMatchObject({
      reason: 'resume-required',
      runId: 'run-interrupted',
    });
    expect(formatAnalyzeRunStatus(status)).toContain(
      'Latest run: run-interrupted · blocked · 1/2 LLM checks complete · 1 pending',
    );
    expect(formatAnalyzeRunStatus(status)).toContain('Active completed analysis: none');
  });

  it('keeps a superseded execution-ambiguous attempt fail-closed', async () => {
    const status = blockedStatus();
    status.activeCompletedAnalysis!.analysisId = 'newer-completed-analysis';
    status.latestAttempt!.state = 'running';
    status.latestAttempt!.blocked = null;
    status.latestAttempt!.resume = {
      available: false,
      scope: 'structural',
      reason: 'resume-execution-ambiguous',
    };

    await expect(resolveAnalyzeStartExpectation({
      repositoryKey: '/repo',
      readStatus: async () => status,
      interactive: false,
      confirmAbandon: async () => true,
    })).rejects.toMatchObject({
      reason: 'resume-execution-ambiguous',
      runId: 'run-interrupted',
    });
    expect(formatAnalyzeRunStatus(status)).toContain(
      'Resume: unavailable — a previously admitted provider call may still be incomplete',
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
