import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyzeRunStatus } from '../../packages/core/src/commands/analyze-run-status.js';
import { AnalysisStartBlockedError } from '../../packages/core/src/commands/analyze-in-process.js';
import {
  AnalyzeRearmCliError,
  AnalyzeResumeCliError,
  formatAnalysisStartBlockedError,
  formatAnalyzeRunStatus,
  resolveAnalyzeStartExpectation,
  runAnalyzeRearm,
  runAnalyzeResume,
  runAnalyzeStatus,
} from '../../tools/cli/src/commands/analyze-runs.js';

describe('analyze run CLI status', () => {
  it('shows the interrupted latest run separately from the active completed baseline', () => {
    expect(formatAnalyzeRunStatus(blockedStatus())).toEqual([
      'Latest run: run-interrupted · blocked · 1/2 LLM checks complete · 1 pending',
      'Provider reported reset: tomorrow 8pm (Africa/Cairo) (advisory)',
      'Verified reset time: 2026-07-20T17:00:00.000Z',
      'Resume: truecourse analyze resume run-interrupted after the provider reset (repository, baseline, rules, configuration, prompts/schemas, provider, and model will be revalidated)',
      'Wait for reset: truecourse analyze resume run-interrupted --wait-for-reset (cancellable; Claude is not contacted before the certified reset time)',
      'Active completed analysis: analysis-completed · 2026-07-19T09:00:00.000Z · main@abc1234',
    ]);
  });

  it('shows the exact bounded ambiguous-rearm acknowledgement beside the safe baseline', () => {
    expect(formatAnalyzeRunStatus(ambiguousStatus())).toEqual([
      'Latest run: run-interrupted · running · 1/2 LLM checks complete · 1 pending',
      'Resume: unavailable — a previously admitted provider call may still be incomplete',
      'Rearm: truecourse analyze rearm run-interrupted --accept-possible-duplicate-provider-charges 1 (may repeat up to 1 provider call; 1 successful checkpoint is eligible for reuse if revalidation succeeds)',
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
    expect(output).toContain('resume');
  });

  it('registers `truecourse analyze resume <run-id>` as an explicit action', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        path.resolve('tools/cli/src/index.ts'),
        'analyze',
        'resume',
        '--help',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(output).toContain('Usage: truecourse analyze resume [options] <run-id>');
    expect(output).toContain('Resume one exact latest attempted run');
    expect(output).toContain('--wait-for-reset');
  });

  it('registers `truecourse analyze rearm <run-id>` with an exact duplicate-charge acknowledgement', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        path.resolve('tools/cli/src/index.ts'),
        'analyze',
        'rearm',
        '--help',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(output).toContain('Usage: truecourse analyze rearm [options] <run-id>');
    expect(output).toContain('Rearm one exact ambiguous attempted run');
    expect(output).toContain('--accept-possible-duplicate-provider-charges <count>');
  });

  it('rejects every explicit parent full-analysis option for Resume', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        path.resolve('tools/cli/src/index.ts'),
        'analyze',
        '--no-llm',
        '--no-stash',
        '--llm-transport',
        'agent',
        '--io',
        '/tmp/resume-mailbox',
        '--install-skills',
        'resume',
        'run-interrupted',
        '--abandon-attempt',
        'run-interrupted',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(result.status).toBe(1);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('Resume cannot be combined with full-analysis options');
    expect(output).toContain('--no-llm');
    expect(output).toContain('--no-stash');
    expect(output).toContain('--llm-transport');
    expect(output).toContain('--io');
    expect(output).toContain('--install-skills');
    expect(output).toContain('--abandon-attempt');
  });

  it('resumes one exact run without probing the provider before core revalidation', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-'));
    const lines: string[] = [];
    const resume = vi.fn(async () => ({
      analysisId: 'analysis-incomplete',
      filename: 'analysis-incomplete.json',
      serviceCount: 1,
      fileCount: 1,
      architecture: 'monolith',
      durationMs: 100,
      violationsSummary: { total: 0, bySeverity: {} },
    }));
    const listenersBefore = process.listeners('SIGINT');

    try {
      await runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        writeLine: (line) => lines.push(line),
        readStatus: async () => blockedStatus(),
        registerProject: async () => ({ path: repoPath }) as never,
        resume,
      });

      expect(resume).toHaveBeenCalledWith(
        expect.objectContaining({ path: repoPath }),
        expect.objectContaining({ runId: 'run-interrupted' }),
      );
      expect(resume.mock.calls[0]![1]).not.toHaveProperty('signal');
      expect(process.listeners('SIGINT')).toEqual(listenersBefore);
      expect(lines).toContain(
        'Saved run contains 1 durable successful LLM checkpoint; 1 pending check remains. Active completed analysis analysis-completed stays canonical until Resume finishes.',
      );
      expect(lines).toContain(
        'Revalidating repository, completed baseline, rules, configuration, prompts/schemas, provider, and model before pending work is admitted.',
      );
      expect(lines.at(-1)).toBe(
        'Resume complete: analysis-incomplete is now the active completed analysis.',
      );
      expect(lines).toContain('Revalidated and reused 1 successful LLM checkpoint.');
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('requires an exact bounded acknowledgement before registering or rearming', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-rearm-consent-'));
    const rearm = vi.fn();
    const registerProject = vi.fn();
    const configureDiagnostics = vi.fn();
    try {
      await expect(runAnalyzeRearm('run-interrupted', {
        cwd: repoPath,
        readStatus: async () => ambiguousStatus(),
        registerProject,
        rearm,
        configureDiagnostics,
      })).rejects.toMatchObject({
        name: 'AnalyzeRearmCliError',
        reason: 'consent-required',
      } satisfies Partial<AnalyzeRearmCliError>);
      expect(registerProject).not.toHaveBeenCalled();
      expect(rearm).not.toHaveBeenCalled();
      expect(configureDiagnostics).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('rejects a stale or broader duplicate-call acknowledgement before registering or rearming', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-rearm-bound-'));
    const rearm = vi.fn();
    const registerProject = vi.fn();
    try {
      await expect(runAnalyzeRearm('run-interrupted', {
        cwd: repoPath,
        acceptedMaxRepeatProviderCalls: 2,
        readStatus: async () => ambiguousStatus(),
        registerProject,
        rearm,
      })).rejects.toMatchObject({
        name: 'AnalyzeRearmCliError',
        reason: 'risk-not-accepted',
      } satisfies Partial<AnalyzeRearmCliError>);
      expect(registerProject).not.toHaveBeenCalled();
      expect(rearm).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('passes the exact status-bound consent to Core only after explaining duplicate exposure', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-rearm-'));
    const lines: string[] = [];
    const rearm = vi.fn(async () => ({
      analysisId: 'analysis-incomplete',
      filename: 'analysis-incomplete.json',
      serviceCount: 1,
      fileCount: 1,
      architecture: 'monolith',
      durationMs: 100,
      violationsSummary: { total: 0, bySeverity: {} },
    }));
    try {
      await runAnalyzeRearm('run-interrupted', {
        cwd: repoPath,
        acceptedMaxRepeatProviderCalls: 1,
        writeLine: (line) => lines.push(line),
        readStatus: async () => ambiguousStatus(),
        registerProject: async () => ({ path: repoPath }) as never,
        rearm,
      });

      expect(rearm).toHaveBeenCalledWith(
        expect.objectContaining({ path: repoPath }),
        expect.objectContaining({
          runId: 'run-interrupted',
          consent: {
            acceptedRisk: 'repeat-up-to-pending-provider-calls',
            acceptedMaxRepeatProviderCalls: 1,
            evidence: ambiguousStatus().latestAttempt!.rearm!.evidence,
          },
        }),
      );
      expect(lines).toContain(
        'An earlier provider call may have completed without a durable checkpoint. You accepted repeating up to 1 provider call.',
      );
      expect(lines).toContain(
        'Revalidating repository, completed baseline, rules, configuration, prompts/schemas, provider, and model before any rearm work is admitted.',
      );
      expect(lines.at(-1)).toBe(
        'Analyze Rearm complete: analysis-incomplete is now the active completed analysis.',
      );
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('waits read-only for the certified reset before registration or Resume execution', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-wait-'));
    let wake!: () => void;
    const waitForResetAction = vi.fn((_repositoryKey, _runId, options) => (
      new Promise<AnalyzeRunStatus>((resolve) => {
        options.onWait?.({
          runId: 'run-interrupted',
          resetAt: '2026-07-20T17:00:00.000Z',
          completed: 1,
          pending: 1,
          activeCompletedAnalysisId: 'analysis-completed',
        });
        wake = () => resolve(blockedStatus());
      })
    ));
    const readStatus = vi.fn(async () => blockedStatus());
    const registerProject = vi.fn(async () => ({ path: repoPath }) as never);
    const listenersBefore = new Set(process.listeners('SIGINT'));
    let waitHandlerPresentDuringResume = true;
    const resume = vi.fn(async () => {
      waitHandlerPresentDuringResume = process.listeners('SIGINT')
        .some((listener) => !listenersBefore.has(listener));
      return {
        analysisId: 'analysis-incomplete',
        filename: 'analysis-incomplete.json',
        serviceCount: 1,
        fileCount: 1,
        architecture: 'monolith',
        durationMs: 100,
        violationsSummary: { total: 0, bySeverity: {} },
      };
    });
    const lines: string[] = [];

    try {
      const running = runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        waitForReset: true,
        waitForResetAction,
        readStatus,
        registerProject,
        resume,
        writeLine: (line) => lines.push(line),
      });
      await vi.waitFor(() => expect(waitForResetAction).toHaveBeenCalledOnce());

      expect(waitForResetAction).toHaveBeenCalledWith(
        repoPath,
        'run-interrupted',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(readStatus).not.toHaveBeenCalled();
      expect(registerProject).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(process.listeners('SIGINT').some((listener) => !listenersBefore.has(listener)))
        .toBe(true);
      expect(lines).toContain(
        'Waiting to resume exact run run-interrupted until certified provider reset 2026-07-20T17:00:00.000Z. Saved run contains 1 durable successful LLM checkpoint; 1 pending check remains. Active completed analysis analysis-completed stays canonical. Claude will not be contacted before reset. Press Ctrl+C to cancel this process-bound wait.',
      );

      wake();
      await running;

      expect(readStatus).not.toHaveBeenCalled();
      expect(registerProject).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledOnce();
      expect(waitHandlerPresentDuringResume).toBe(false);
      expect(lines).toContain(
        'Certified provider reset reached. Exact run identity, journal revision, and reset evidence were unchanged; continuing with normal Resume revalidation.',
      );
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('continues zero-pending recovery without announcing or arming a wait', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-no-wait-'));
    const status = blockedStatus();
    status.latestAttempt!.state = 'finalizing';
    status.latestAttempt!.blocked = null;
    status.latestAttempt!.lastProviderLimit = null;
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
    const waitForResetAction = vi.fn(async () => status);
    const resume = vi.fn(async () => ({
      analysisId: 'analysis-incomplete',
      filename: 'analysis-incomplete.json',
      serviceCount: 1,
      fileCount: 1,
      architecture: 'monolith',
      durationMs: 100,
      violationsSummary: { total: 0, bySeverity: {} },
    }));
    const lines: string[] = [];

    try {
      await runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        waitForReset: true,
        waitForResetAction,
        registerProject: async () => ({ path: repoPath }) as never,
        resume,
        writeLine: (line) => lines.push(line),
      });

      expect(waitForResetAction).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledOnce();
      expect(lines.join('\n')).not.toContain('Waiting to resume');
      expect(lines).toContain(
        'No provider calls are pending; recovering durable execution/finalization state.',
      );
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('aborts the process-bound wait before registration or Resume execution', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-cancel-wait-'));
    const controller = new AbortController();
    const registerProject = vi.fn();
    const resume = vi.fn();
    const waitForResetAction = vi.fn((_repositoryKey, _runId, options) => (
      new Promise<never>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      })
    ));

    try {
      const waiting = runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        waitForReset: true,
        signal: controller.signal,
        waitForResetAction,
        registerProject,
        resume,
      });
      await vi.waitFor(() => expect(waitForResetAction).toHaveBeenCalledOnce());
      controller.abort();

      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
      expect(registerProject).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('does not install a graceful SIGINT handler while provider work is active', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-sigint-'));
    const listenersBefore = new Set(process.listeners('SIGINT'));
    let finish!: () => void;
    const resume = vi.fn(() => new Promise<never>((resolve) => {
      finish = () => resolve({
        analysisId: 'analysis-incomplete',
        filename: 'analysis-incomplete.json',
        serviceCount: 1,
        fileCount: 1,
        architecture: 'monolith',
        durationMs: 100,
        violationsSummary: { total: 0, bySeverity: {} },
      } as never);
    }));

    try {
      const running = runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        writeLine: () => undefined,
        readStatus: async () => blockedStatus(),
        registerProject: async () => ({ path: repoPath }) as never,
        resume,
      });
      await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());

      expect(process.listeners('SIGINT').filter((listener) => !listenersBefore.has(listener)))
        .toEqual([]);
      finish();
      await running;
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('recovers a fully checkpointed run through the same core Resume path', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-finalize-'));
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
    const resume = vi.fn(async () => ({
      analysisId: 'analysis-incomplete',
      filename: 'analysis-incomplete.json',
      serviceCount: 1,
      fileCount: 1,
      architecture: 'monolith',
      durationMs: 100,
      violationsSummary: { total: 0, bySeverity: {} },
    }));
    const lines: string[] = [];

    try {
      await runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        writeLine: (line) => lines.push(line),
        readStatus: async () => status,
        registerProject: async () => ({ path: repoPath }) as never,
        resume,
      });

      expect(resume).toHaveBeenCalledOnce();
      expect(lines).toContain(
        'No provider calls are pending; recovering durable execution/finalization state.',
      );
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('rejects a non-latest selected run before registration or execution', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-nonlatest-'));
    const registerProject = vi.fn();
    const resume = vi.fn();

    try {
      await expect(runAnalyzeResume('older-run', {
        cwd: repoPath,
        readStatus: async () => blockedStatus(),
        registerProject,
        resume,
      })).rejects.toMatchObject({
        name: 'AnalyzeResumeCliError',
        reason: 'not-latest-attempt',
      });
      expect(registerProject).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('rejects unavailable and superseded runs before provider work', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-unavailable-'));
    const ambiguous = blockedStatus();
    ambiguous.latestAttempt!.state = 'running';
    ambiguous.latestAttempt!.blocked = null;
    ambiguous.latestAttempt!.resume = {
      available: false,
      scope: 'structural',
      reason: 'resume-execution-ambiguous',
    };
    const superseded = blockedStatus();
    superseded.activeCompletedAnalysis!.analysisId = 'newer-analysis';
    const registerProject = vi.fn();
    const resume = vi.fn();

    try {
      await expect(runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        readStatus: async () => ambiguous,
        registerProject,
        resume,
      })).rejects.toMatchObject({ reason: 'resume-execution-ambiguous' });
      await expect(runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        readStatus: async () => superseded,
        registerProject,
        resume,
      })).rejects.toMatchObject({ reason: 'completed-analysis-not-active' });
      expect(registerProject).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('keeps raw Resume failures in the local log and returns safe guidance', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-error-'));
    const raw = 'secret provider stderr /private/repo/token-123';

    try {
      const error = await runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        writeLine: () => undefined,
        readStatus: async () => blockedStatus(),
        registerProject: async () => ({ path: repoPath }) as never,
        resume: async () => { throw new Error(raw); },
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AnalyzeResumeCliError);
      expect(error).toMatchObject({ reason: 'execution-failed' });
      expect((error as Error).message).not.toContain(raw);
      expect((error as Error).message).toMatch(/local analyze log/i);
      expect(fs.readFileSync(path.join(repoPath, '.truecourse', 'logs', 'analyze.log'), 'utf8'))
        .toContain(raw);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('logs a raw status-read failure locally and returns safe guidance', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-status-error-'));
    const raw = 'corrupt journal /private/repo/secret-run.json';
    const registerProject = vi.fn();

    try {
      const error = await runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        writeLine: () => undefined,
        readStatus: async () => { throw new Error(raw); },
        registerProject,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        name: 'AnalyzeResumeCliError',
        reason: 'execution-failed',
      });
      expect((error as Error).message).not.toContain(raw);
      expect(registerProject).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(repoPath, '.truecourse', 'logs', 'analyze.log'), 'utf8'))
        .toContain(raw);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('logs a raw registration failure locally before returning safe guidance', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'truecourse-cli-resume-register-error-'));
    const raw = 'registration failed with /private/repo/secret-config.json';
    const resume = vi.fn();

    try {
      const error = await runAnalyzeResume('run-interrupted', {
        cwd: repoPath,
        writeLine: () => undefined,
        readStatus: async () => blockedStatus(),
        registerProject: async () => { throw new Error(raw); },
        resume,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        name: 'AnalyzeResumeCliError',
        reason: 'execution-failed',
      });
      expect((error as Error).message).not.toContain(raw);
      expect(resume).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(repoPath, '.truecourse', 'logs', 'analyze.log'), 'utf8'))
        .toContain(raw);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('reports accurately when local diagnostics cannot be configured', async () => {
    const raw = 'diagnostics path contains secret-token';
    const readStatus = vi.fn();

    const error = await runAnalyzeResume('run-interrupted', {
      cwd: '/repo',
      readStatus,
      configureDiagnostics: () => { throw new Error(raw); },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'AnalyzeResumeCliError',
      reason: 'diagnostics-unavailable',
    });
    expect((error as Error).message).not.toContain(raw);
    expect((error as Error).message).toMatch(/could not be configured/i);
    expect((error as Error).message).not.toMatch(/check the local analyze log/i);
    expect(readStatus).not.toHaveBeenCalled();
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

    expect(message).toContain('truecourse analyze resume run-interrupted');
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
      schemaVersion: 8,
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
      executionAttempt: {
        number: 1,
        activatedAt: '2026-07-19T10:00:00.000Z',
        initialAdmission: {
          admission: 'executing',
          admittedAt: '2026-07-19T10:00:01.000Z',
          evidence: 'explicit',
        },
        resume: null,
      },
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
        resetAt: '2026-07-20T17:00:00.000Z',
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

function ambiguousStatus(): AnalyzeRunStatus {
  const status = blockedStatus();
  const attempt = status.latestAttempt!;
  attempt.state = 'running';
  attempt.blocked = null;
  attempt.lastProviderLimit = null;
  attempt.resume = {
    available: false,
    scope: 'structural',
    reason: 'resume-execution-ambiguous',
  };
  attempt.rearm = {
    scope: 'structural',
    mode: 'rearm-ambiguous-execution',
    requiresLatestAttempt: true,
    requiresRevalidation: true,
    evidence: {
      runId: attempt.runId,
      runRevision: attempt.revision,
      executionEpoch: {
        kind: 'initial',
        attemptNumber: 1,
        activatedAt: attempt.executionAttempt.activatedAt,
      },
      admittedAt: attempt.executionAttempt.initialAdmission!.admittedAt,
      pendingWorkCount: attempt.counts!.pending,
    },
    checkpointedWorkCount: attempt.counts!.succeeded,
    maxRepeatProviderCalls: attempt.counts!.pending,
    requiredAcknowledgement: 'possible-duplicate-provider-charges',
  };
  return status;
}
