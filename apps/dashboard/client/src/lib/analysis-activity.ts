import type { AnalysisActivityMode } from '@truecourse/shared';
import type { AnalysisProgress } from '@/hooks/useSocket';

export function isActiveAnalysisProgress(
  progress: AnalysisProgress | null | undefined,
): boolean {
  return progress !== null && progress !== undefined && progress.step !== 'error';
}

export function isSettledResumeActivity(options: {
  statusAvailable: boolean;
  activeMode: AnalysisActivityMode | null | undefined;
  previousMode: AnalysisActivityMode | null | undefined;
  hadPendingAction: boolean;
  initiated: boolean;
}): boolean {
  return options.statusAvailable
    && options.activeMode === null
    && (
      options.previousMode === 'resume'
      || options.hadPendingAction
      || options.initiated
    );
}

export function isSettledStartOverActivity(options: {
  statusAvailable: boolean;
  activeMode: AnalysisActivityMode | null | undefined;
  previousMode: AnalysisActivityMode | null | undefined;
  hadPendingAction: boolean;
  initiated: boolean;
}): boolean {
  return options.statusAvailable
    && options.activeMode === null
    && (
      options.previousMode === 'analysis'
      || options.hadPendingAction
      || options.initiated
    );
}

export function isSettledRearmActivity(options: {
  statusAvailable: boolean;
  activeMode: AnalysisActivityMode | null | undefined;
  previousMode: AnalysisActivityMode | null | undefined;
  hadPendingAction: boolean;
}): boolean {
  return options.statusAvailable
    && options.activeMode === null
    && (options.previousMode === 'rearm' || options.hadPendingAction);
}

export function shouldClearSettledRunProgress(
  previousMode: AnalysisActivityMode | null | undefined,
  activeMode: AnalysisActivityMode | null | undefined,
  progress: AnalysisProgress | null | undefined,
  hadPendingAction = false,
  initiated = false,
): boolean {
  return (previousMode === 'resume' || previousMode === 'rearm' || hadPendingAction || initiated)
    && activeMode === null
    && progress?.step !== 'error';
}

export function getAnalysisProgressActivity(options: {
  progress: AnalysisProgress | null | undefined;
  activeMode: AnalysisActivityMode | null | undefined;
  rearmRunId: string | null;
}): { isResume: boolean; isRearm: boolean; isProtected: boolean; label: string } {
  const isResume = options.progress?.mode === 'resume';
  const isRearm = options.progress?.mode === 'rearm'
    || options.activeMode === 'rearm'
    || options.rearmRunId !== null;
  const isProtected = isResume || isRearm;
  const label = options.progress?.step === 'error'
    ? isRearm ? 'Analyze Rearm stopped' : isResume ? 'Resume stopped' : 'Analysis failed'
    : isRearm ? 'Rearming analysis...'
      : isResume ? 'Resuming analysis...'
        : 'Analyzing...';
  return { isResume, isRearm, isProtected, label };
}
