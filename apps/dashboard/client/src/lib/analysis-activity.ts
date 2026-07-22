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

export function shouldClearSettledResumeProgress(
  previousMode: AnalysisActivityMode | null | undefined,
  activeMode: AnalysisActivityMode | null | undefined,
  progress: AnalysisProgress | null | undefined,
  hadPendingAction = false,
  initiated = false,
): boolean {
  return (previousMode === 'resume' || hadPendingAction || initiated)
    && activeMode === null
    && progress?.step !== 'error';
}
