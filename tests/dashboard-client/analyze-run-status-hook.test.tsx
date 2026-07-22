import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeRunStatusResponse } from '@truecourse/shared';

const getAnalyzeRunStatus = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ getAnalyzeRunStatus }));

import { useAnalyzeRunStatus } from '@/hooks/useAnalyzeRunStatus';

describe('useAnalyzeRunStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getAnalyzeRunStatus.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the last readable status during a transient poll failure and recovers', async () => {
    getAnalyzeRunStatus
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
    expect(getAnalyzeRunStatus).toHaveBeenCalledTimes(3);
  });

  it('does not read the local-only endpoint when disabled', async () => {
    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1', false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getAnalyzeRunStatus).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not let an older repository response overwrite the current repository', async () => {
    let resolveRepo1!: (value: AnalyzeRunStatusResponse) => void;
    let resolveRepo2!: (value: AnalyzeRunStatusResponse) => void;
    getAnalyzeRunStatus.mockImplementation((repoId: string) => new Promise((resolve) => {
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
    getAnalyzeRunStatus
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
    getAnalyzeRunStatus
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce(status('blocked'));

    const { result } = renderHook(() => useAnalyzeRunStatus('repo-1'), { reactStrictMode: true });

    await waitFor(() => expect(result.current.status?.latestAttempt?.state).toBe('blocked'));
    expect(getAnalyzeRunStatus).toHaveBeenCalledTimes(2);
  });
});

function status(state: 'running' | 'blocked'): AnalyzeRunStatusResponse {
  return {
    latestAttempt: {
      runId: 'run-1',
      state,
      startedAt: '2026-07-22T08:00:00.000Z',
      updatedAt: '2026-07-22T08:10:00.000Z',
      source: 'dashboard',
      branch: 'main',
      commitHash: '1234567890abcdef',
      counts: { total: 2, succeeded: state === 'blocked' ? 1 : 0, pending: 1, running: 0, failed: 0 },
      lastProviderLimit: null,
      resume: {
        available: false,
        scope: 'structural',
        reason: 'run-not-resumable',
      },
    },
    activeCompletedAnalysis: null,
  };
}
