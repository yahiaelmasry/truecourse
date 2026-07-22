import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalyzeRunStatusResponse } from '@truecourse/shared';
import * as api from '@/lib/api';

const STATUS_POLL_MS = 2_000;

export function useAnalyzeRunStatus(repoId: string, enabled = true) {
  const [status, setStatus] = useState<AnalyzeRunStatusResponse | null>(null);
  const [statusRepoId, setStatusRepoId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const inFlight = useRef<{ repoId: string; requestId: number } | null>(null);

  const refetch = useCallback(async (background = false) => {
    if (!enabled || !repoId) return;
    if (inFlight.current?.repoId === repoId) return;
    const requestId = ++requestSequence.current;
    inFlight.current = { repoId, requestId };
    if (!background) setIsLoading(true);

    try {
      const nextStatus = await api.getAnalyzeRunStatus(repoId);
      if (requestId !== requestSequence.current) return;
      setStatus(nextStatus);
      setStatusRepoId(repoId);
      setError(null);
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : 'Unable to read analyze-run status');
    } finally {
      if (!background && requestId === requestSequence.current) setIsLoading(false);
      if (inFlight.current?.requestId === requestId) inFlight.current = null;
    }
  }, [enabled, repoId]);

  useEffect(() => {
    if (!enabled || !repoId) {
      requestSequence.current += 1;
      inFlight.current = null;
      setStatus(null);
      setStatusRepoId(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    setError(null);
    void refetch();
    const timer = window.setInterval(() => void refetch(true), STATUS_POLL_MS);
    return () => {
      window.clearInterval(timer);
      requestSequence.current += 1;
      inFlight.current = null;
    };
  }, [enabled, refetch, repoId]);

  return {
    status: statusRepoId === repoId ? status : null,
    isLoading,
    error,
    refetch,
  };
}
