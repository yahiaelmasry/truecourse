import { describe, expect, it } from 'vitest';
import {
  isActiveAnalysisProgress,
  getAnalysisProgressActivity,
  isSettledRearmActivity,
  isSettledResumeActivity,
  isSettledStartOverActivity,
  shouldClearSettledRunProgress,
} from '@/lib/analysis-activity';

describe('dashboard analysis activity presentation', () => {
  it('keeps Resume failure details visible after protected ownership settles', () => {
    const progress = {
      mode: 'resume' as const,
      step: 'error',
      percent: -1,
      detail: 'Provider limit reached; reset Jul 23 at 8:00 PM',
    };

    expect(isActiveAnalysisProgress(progress)).toBe(false);
    expect(shouldClearSettledRunProgress('resume', null, progress)).toBe(false);
  });

  it('clears non-error Resume progress after protected ownership settles', () => {
    const progress = { mode: 'resume' as const, step: 'analyze', percent: 60 };

    expect(isActiveAnalysisProgress(progress)).toBe(true);
    expect(shouldClearSettledRunProgress('resume', null, progress)).toBe(true);
  });

  it('preserves initiated Resume evidence through hidden status and settles on authoritative null', () => {
    expect(isSettledResumeActivity({
      statusAvailable: false,
      activeMode: undefined,
      previousMode: 'resume',
      hadPendingAction: false,
      initiated: true,
    })).toBe(false);
    expect(isSettledResumeActivity({
      statusAvailable: true,
      activeMode: null,
      previousMode: 'resume',
      hadPendingAction: false,
      initiated: true,
    })).toBe(true);
    expect(shouldClearSettledRunProgress(
      undefined,
      null,
      { mode: 'resume', step: 'analyze', percent: 100 },
      false,
      true,
    )).toBe(true);
  });

  it('settles an initiated Start over from authoritative analysis ownership', () => {
    expect(isSettledStartOverActivity({
      statusAvailable: false,
      activeMode: undefined,
      previousMode: 'analysis',
      hadPendingAction: false,
      initiated: true,
    })).toBe(false);
    expect(isSettledStartOverActivity({
      statusAvailable: true,
      activeMode: null,
      previousMode: 'analysis',
      hadPendingAction: false,
      initiated: true,
    })).toBe(true);
    expect(isSettledStartOverActivity({
      statusAvailable: true,
      activeMode: 'analysis',
      previousMode: null,
      hadPendingAction: false,
      initiated: true,
    })).toBe(false);
  });

  it('settles a terminal server-emitted rearm without clearing its failure detail', () => {
    const progress = {
      mode: 'rearm' as const,
      step: 'error',
      percent: -1,
      detail: 'Revalidation failed after admission',
    };

    expect(isSettledRearmActivity({
      statusAvailable: true,
      activeMode: null,
      previousMode: 'rearm',
      hadPendingAction: false,
    })).toBe(true);
    expect(isActiveAnalysisProgress(progress)).toBe(false);
    expect(shouldClearSettledRunProgress('rearm', null, progress)).toBe(false);
  });

  it('presents a server-emitted rearm as cancellation-protected work', () => {
    expect(getAnalysisProgressActivity({
      progress: { mode: 'rearm', step: 'analyze', percent: 60 },
      activeMode: null,
      rearmRunId: null,
    })).toEqual({
      isResume: false,
      isRearm: true,
      isProtected: true,
      label: 'Rearming analysis...',
    });
    expect(getAnalysisProgressActivity({
      progress: { mode: 'rearm', step: 'error', percent: -1 },
      activeMode: null,
      rearmRunId: null,
    }).label).toBe('Analyze Rearm stopped');
  });
});
