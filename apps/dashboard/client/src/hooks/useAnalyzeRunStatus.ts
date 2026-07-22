import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalyzeRunAmbiguousRearmConsent, AnalyzeRunStatusResponse } from '@truecourse/shared';
import * as api from '@/lib/api';

const STATUS_POLL_MS = 2_000;

export function useAnalyzeRunStatus(repoId: string, enabled = true) {
  const [status, setStatus] = useState<AnalyzeRunStatusResponse | null>(null);
  const [statusRepoId, setStatusRepoId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [resumeRunId, setResumeRunId] = useState<string | null>(null);
  const [resumeFailure, setResumeFailure] = useState<{ runId: string; message: string } | null>(null);
  const [rearmRunId, setRearmRunId] = useState<string | null>(null);
  const [rearmFailure, setRearmFailure] = useState<{ runId: string; message: string } | null>(null);
  const [startOverRunId, setStartOverRunId] = useState<string | null>(null);
  const [startOverFailure, setStartOverFailure] = useState<{ runId: string; message: string } | null>(null);
  const requestSequence = useRef(0);
  const inFlight = useRef<{ repoId: string; requestId: number } | null>(null);
  const resumeSequence = useRef(0);
  const rearmSequence = useRef(0);
  const startOverSequence = useRef(0);
  const currentRepoId = useRef(repoId);
  currentRepoId.current = repoId;
  const resumeAction = useRef<{
    repoId: string;
    runId: string;
    actionId: number;
    phase: 'posting' | 'reconciling';
  } | null>(null);
  const rearmAction = useRef<{
    repoId: string; runId: string; actionId: number; phase: 'posting' | 'reconciling';
  } | null>(null);
  const startOverAction = useRef<{
    repoId: string;
    runId: string;
    actionId: number;
    phase: 'posting' | 'reconciling';
  } | null>(null);

  const refetch = useCallback(async (background = false, force = false) => {
    if (!enabled || !repoId) return;
    if (!force && inFlight.current?.repoId === repoId) return;
    if (force) {
      requestSequence.current += 1;
      inFlight.current = null;
    }
    const requestId = ++requestSequence.current;
    inFlight.current = { repoId, requestId };
    if (!background) setIsLoading(true);

    try {
      const nextStatus = await api.getAnalyzeRunStatus(repoId);
      if (requestId !== requestSequence.current) return;
      setStatus(nextStatus);
      setStatusRepoId(repoId);
      setError(null);
      const action = resumeAction.current;
      if (action?.repoId === repoId && action.phase === 'reconciling') {
        resumeAction.current = null;
        setResumeRunId(null);
      }
      const replacement = startOverAction.current;
      if (replacement?.repoId === repoId && replacement.phase === 'reconciling') {
        startOverAction.current = null;
        setStartOverRunId(null);
      }
      const rearm = rearmAction.current;
      if (rearm?.repoId === repoId && rearm.phase === 'reconciling') {
        rearmAction.current = null;
        setRearmRunId(null);
      }
      return nextStatus;
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : 'Unable to read analyze-run status');
    } finally {
      if (!background && requestId === requestSequence.current) setIsLoading(false);
      if (inFlight.current?.requestId === requestId) inFlight.current = null;
    }
  }, [enabled, repoId]);

  const resume = useCallback(async (runId: string): Promise<void> => {
    if (!enabled || !repoId) throw new Error('Analyze Resume is unavailable.');
    if (
      resumeAction.current?.repoId === repoId
      || startOverAction.current?.repoId === repoId
      || rearmAction.current?.repoId === repoId
    ) return;

    const actionId = ++resumeSequence.current;
    const action = { repoId, runId, actionId, phase: 'posting' as const };
    resumeAction.current = action;
    requestSequence.current += 1;
    inFlight.current = null;
    setResumeRunId(runId);
    setResumeFailure(null);

    try {
      await api.resumeAnalyzeRun(repoId, runId);
      if (resumeSequence.current !== actionId || resumeAction.current !== action) return;
      resumeAction.current = { ...action, phase: 'reconciling' };
      await refetch(true, true);
    } catch (cause) {
      if (resumeSequence.current !== actionId || resumeAction.current?.actionId !== actionId) {
        if (currentRepoId.current === repoId) throw cause;
        return;
      }
      resumeAction.current = null;
      setResumeRunId(null);
      setResumeFailure({
        runId,
        message: cause instanceof Error ? cause.message : 'Unable to start Analyze Resume',
      });
      await refetch(true, true);
      throw cause;
    }
  }, [enabled, refetch, repoId]);

  const rearm = useCallback(async (
    runId: string,
    consent: AnalyzeRunAmbiguousRearmConsent,
  ): Promise<void> => {
    if (!enabled || !repoId) throw new Error('Analyze Rearm is unavailable.');
    if (resumeAction.current?.repoId === repoId || startOverAction.current?.repoId === repoId || rearmAction.current?.repoId === repoId) return;
    const actionId = ++rearmSequence.current;
    const action = { repoId, runId, actionId, phase: 'posting' as const };
    rearmAction.current = action;
    requestSequence.current += 1;
    inFlight.current = null;
    setRearmRunId(runId);
    setRearmFailure(null);
    try {
      await api.rearmAnalyzeRun(repoId, runId, consent);
      if (rearmSequence.current !== actionId || rearmAction.current !== action) return;
      rearmAction.current = { ...action, phase: 'reconciling' };
      await refetch(true, true);
    } catch (cause) {
      if (rearmSequence.current !== actionId || rearmAction.current?.actionId !== actionId) {
        if (currentRepoId.current === repoId) throw cause;
        return;
      }
      rearmAction.current = null;
      setRearmRunId(null);
      setRearmFailure({ runId, message: cause instanceof Error ? cause.message : 'Unable to start Analyze Rearm' });
      await refetch(true, true);
      throw cause;
    }
  }, [enabled, refetch, repoId]);

  const startOver = useCallback(async (runId: string): Promise<void> => {
    if (!enabled || !repoId) throw new Error('Analyze Start over is unavailable.');
    if (
      resumeAction.current?.repoId === repoId
      || startOverAction.current?.repoId === repoId
      || rearmAction.current?.repoId === repoId
    ) return;

    const actionId = ++startOverSequence.current;
    const action = { repoId, runId, actionId, phase: 'posting' as const };
    startOverAction.current = action;
    requestSequence.current += 1;
    inFlight.current = null;
    setStartOverRunId(runId);
    setStartOverFailure(null);

    try {
      await api.analyzeRepo(repoId, { abandonAttemptRunId: runId });
      if (startOverSequence.current !== actionId || startOverAction.current !== action) return;
      startOverAction.current = { ...action, phase: 'reconciling' };
      await refetch(true, true);
    } catch (cause) {
      if (
        startOverSequence.current !== actionId
        || startOverAction.current?.actionId !== actionId
      ) {
        if (currentRepoId.current === repoId) throw cause;
        return;
      }
      startOverAction.current = null;
      setStartOverRunId(null);
      setStartOverFailure({
        runId,
        message: cause instanceof Error ? cause.message : 'Unable to start replacement analysis',
      });
      await refetch(true, true);
      throw cause;
    }
  }, [enabled, refetch, repoId]);

  useEffect(() => {
    if (!enabled || !repoId) {
      requestSequence.current += 1;
      inFlight.current = null;
      setStatus(null);
      setStatusRepoId(null);
      setIsLoading(false);
      setError(null);
      resumeSequence.current += 1;
      resumeAction.current = null;
      setResumeRunId(null);
      setResumeFailure(null);
      rearmSequence.current += 1;
      rearmAction.current = null;
      setRearmRunId(null);
      setRearmFailure(null);
      startOverSequence.current += 1;
      startOverAction.current = null;
      setStartOverRunId(null);
      setStartOverFailure(null);
      return;
    }

    setError(null);
    setResumeRunId(null);
    setResumeFailure(null);
    setRearmRunId(null);
    setRearmFailure(null);
    setStartOverRunId(null);
    setStartOverFailure(null);
    void refetch();
    const timer = window.setInterval(() => void refetch(true), STATUS_POLL_MS);
    return () => {
      window.clearInterval(timer);
      requestSequence.current += 1;
      inFlight.current = null;
      resumeSequence.current += 1;
      resumeAction.current = null;
      rearmSequence.current += 1;
      rearmAction.current = null;
      startOverSequence.current += 1;
      startOverAction.current = null;
    };
  }, [enabled, refetch, repoId]);

  return {
    status: statusRepoId === repoId ? status : null,
    isLoading,
    error,
    refetch,
    resume,
    resumeRunId,
    resumeError: resumeFailure && statusRepoId === repoId
      && status?.latestAttempt?.runId === resumeFailure.runId
      ? resumeFailure.message
      : null,
    rearm,
    rearmRunId,
    rearmError: rearmFailure && statusRepoId === repoId && status?.latestAttempt?.runId === rearmFailure.runId
      ? rearmFailure.message
      : null,
    startOver,
    startOverRunId,
    startOverError: startOverFailure && statusRepoId === repoId
      && status?.latestAttempt?.runId === startOverFailure.runId
      ? startOverFailure.message
      : null,
  };
}
