import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeRunStatusResponse } from '@truecourse/shared';

const api = vi.hoisted(() => ({
  getAnalyzeRunStatus: vi.fn(),
  resumeAnalyzeRun: vi.fn(),
}));

vi.mock('@/lib/api', () => api);

import { useAnalyzeRunStatus } from '@/hooks/useAnalyzeRunStatus';

describe('useAnalyzeRunStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getAnalyzeRunStatus.mockReset();
    api.resumeAnalyzeRun.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the last readable status during a transient poll failure and recovers', async () => {
    api.getAnalyzeRunStatus
      .mockResolvedValueOnce(status('running'))
      .mockRejectedValueOnce(new Error('temporary disconnect'))
      .mockResolvedValueOnce(status('blocked'));

    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1'));
    await waitFor(() => expect(result.current.status?.latestAttempt?.state).toBe('running'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.status?.latestAttempt?.state).toBe('running');
    expect(result.current.error).toBe('temporary disconnect');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(result.current.status?.latestAttempt?.state).toBe('blocked'));
    expect(result.current.error).toBeNull();
    expect(api.getAnalyzeRunStatus).toHaveBeenCalledTimes(3);
  });

  it('does not read the local-only endpoint when disabled', async () => {
    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1', false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(api.getAnalyzeRunStatus).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not let an older repository response overwrite the current repository', async () => {
    let resolveRepo1!: (value: AnalyzeRunStatusResponse) => void;
    let resolveRepo2!: (value: AnalyzeRunStatusResponse) => void;
    api.getAnalyzeRunStatus.mockImplementation((repoId: string) => new Promise((resolve) => {
      if (repoId === 'repo-1') resolveRepo1 = resolve;
      if (repoId === 'repo-2') resolveRepo2 = resolve;
    }));

    const { result, rerender } = renderHook(
      ({ repoId }) => useAnalyzeRunStatus(repoId),
      { initialProps: { repoId: 'repo-1' } },
    );
    rerender({ repoId: 'repo-2' });

    await act(async () => resolveRepo2(status('blocked')));
    await waitFor(() => expect(result.current.status?.latestAttempt?.state).toBe('blocked'));
    await act(async () => resolveRepo1(status('running')));

    expect(result.current.status?.latestAttempt?.state).toBe('blocked');
  });

  it('does not carry a read error into a different repository', async () => {
    api.getAnalyzeRunStatus
      .mockRejectedValueOnce(new Error('repo-1 unavailable'))
      .mockReturnValueOnce(new Promise(() => undefined));

    const { result, rerender } = renderHook(
      ({ repoId }) => useAnalyzeRunStatus(repoId),
      { initialProps: { repoId: 'repo-1' } },
    );
    await waitFor(() => expect(result.current.error).toBe('repo-1 unavailable'));

    rerender({ repoId: 'repo-2' });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.status).toBeNull();
  });

  it('starts a fresh request when StrictMode replays the polling effect', async () => {
    api.getAnalyzeRunStatus
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce(status('blocked'));

    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1'), { reactStrictMode: true });

    await waitFor(() => expect(result.current.status?.latestAttempt?.state).toBe('blocked'));
    expect(api.getAnalyzeRunStatus).toHaveBeenCalledTimes(2);
  });

  it('suppresses duplicate Resume clicks before React state updates', async () => {
    api.getAnalyzeRunStatus.mockResolvedValue(status('blocked', null, true));
    const resume = deferred<void>();
    api.resumeAnalyzeRun.mockReturnValue(resume.promise);
    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.resume('run-1');
      void result.current.resume('run-1');
    });

    expect(api.resumeAnalyzeRun).toHaveBeenCalledTimes(1);
    expect(api.resumeAnalyzeRun).toHaveBeenCalledWith('repo-1', 'run-1');
    expect(result.current.resumeRunId).toBe('run-1');
    resume.resolve();
    await act(async () => first);
  });

  it('reconciles an accepted Resume through a forced authoritative status read', async () => {
    api.getAnalyzeRunStatus
      .mockResolvedValueOnce(status('blocked', null, true))
      .mockResolvedValueOnce(status('running', 'resume', true));
    api.resumeAnalyzeRun.mockResolvedValue({
      message: 'Analysis Resume started',
      repoId: 'repo-1',
      runId: 'run-1',
      mode: 'resume',
    });
    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => result.current.resume('run-1'));

    expect(api.getAnalyzeRunStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status?.activeMode).toBe('resume');
    expect(result.current.resumeRunId).toBeNull();
    expect(result.current.resumeError).toBeNull();
  });

  it('keeps an admission error visible while refreshing durable status', async () => {
    api.getAnalyzeRunStatus.mockResolvedValue(status('blocked', null, true));
    api.resumeAnalyzeRun.mockRejectedValue(new Error('The selected run is no longer latest'));
    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.resume('run-1');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(result.current.resumeRunId).toBeNull();
    await waitFor(() => expect(result.current.resumeError).toMatch(/no longer latest/i));
    expect(api.getAnalyzeRunStatus).toHaveBeenCalledTimes(2);
  });

  it('does not attach an old run rejection to a newer latest attempt', async () => {
    api.getAnalyzeRunStatus
      .mockResolvedValueOnce(status('blocked', null, true, 'run-1'))
      .mockResolvedValueOnce(status('blocked', null, true, 'run-2'));
    api.resumeAnalyzeRun.mockRejectedValue(new Error('run-1 is no longer latest'));
    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1'));
    await waitFor(() => expect(result.current.status?.latestAttempt?.runId).toBe('run-1'));

    await act(async () => {
      try {
        await result.current.resume('run-1');
      } catch {
        // The initiating page handles the global error; this hook scopes inline copy.
      }
    });

    expect(result.current.status?.latestAttempt?.runId).toBe('run-2');
    expect(result.current.resumeError).toBeNull();
  });

  it('keeps an accepted action disabled until a failed reconciliation later succeeds', async () => {
    api.getAnalyzeRunStatus
      .mockResolvedValueOnce(status('blocked', null, true))
      .mockRejectedValueOnce(new Error('status temporarily unavailable'))
      .mockResolvedValueOnce(status('running', 'resume', true));
    api.resumeAnalyzeRun.mockResolvedValue({
      message: 'Analysis Resume started',
      repoId: 'repo-1',
      runId: 'run-1',
      mode: 'resume',
    });
    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1'));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(async () => result.current.resume('run-1'));
    expect(result.current.resumeRunId).toBe('run-1');
    expect(result.current.error).toBe('status temporarily unavailable');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(result.current.resumeRunId).toBeNull());
    expect(result.current.status?.activeMode).toBe('resume');
  });

  it('ignores an old repository Resume completion after navigation', async () => {
    const oldResume = deferred<void>();
    api.getAnalyzeRunStatus.mockImplementation(async (repoId: string) =>
      status('blocked', null, true, repoId === 'repo-1' ? 'run-1' : 'run-2'));
    api.resumeAnalyzeRun.mockReturnValue(oldResume.promise);
    const { result, rerender } = renderHook(
      ({ repoId }) => useAnalyzeRunStatus(repoId),
      { initialProps: { repoId: 'repo-1' } },
    );
    await waitFor(() => expect(result.current.status?.latestAttempt?.runId).toBe('run-1'));

    let oldAction!: Promise<void>;
    await act(async () => {
      oldAction = result.current.resume('run-1');
    });
    rerender({ repoId: 'repo-2' });
    await waitFor(() => expect(result.current.status?.latestAttempt?.runId).toBe('run-2'));
    oldResume.resolve();
    await act(async () => oldAction);

    expect(result.current.status?.latestAttempt?.runId).toBe('run-2');
    expect(result.current.resumeRunId).toBeNull();
    expect(result.current.resumeError).toBeNull();
  });

  it('still rejects to the initiating page when the action becomes stale while hidden', async () => {
    api.getAnalyzeRunStatus.mockResolvedValue(status('blocked', null, true));
    const lateFailure = deferred<void>();
    api.resumeAnalyzeRun.mockReturnValue(lateFailure.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useAnalyzeRunStatus('repo-1', enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.status).not.toBeNull());

    let action!: Promise<void>;
    await act(async () => {
      action = result.current.resume('run-1');
    });
    rerender({ enabled: false });
    lateFailure.reject(new Error('Resume admission failed after tab change'));

    await expect(action).rejects.toThrow(/admission failed after tab change/i);
    expect(result.current.resumeRunId).toBeNull();
    expect(result.current.resumeError).toBeNull();
  });
});

function status(
  state: 'running' | 'blocked',
  activeMode: AnalyzeRunStatusResponse['activeMode'] = null,
  resumable = false,
  runId = 'run-1',
): AnalyzeRunStatusResponse {
  return {
    activeMode,
    latestAttempt: {
      runId,
      state,
      startedAt: '2026-07-22T08:00:00.000Z',
      updatedAt: '2026-07-22T08:10:00.000Z',
      source: 'dashboard',
      branch: 'main',
      commitHash: '1234567890abcdef',
      counts: { total: 2, succeeded: state === 'blocked' ? 1 : 0, pending: 1, running: 0, failed: 0 },
      lastProviderLimit: null,
      resume: resumable
        ? {
            available: true,
            scope: 'structural',
            mode: 'resume',
            requiresLatestAttempt: true,
            requiresRevalidation: true,
          }
        : {
            available: false,
            scope: 'structural',
            reason: 'run-not-resumable',
          },
    },
    activeCompletedAnalysis: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
