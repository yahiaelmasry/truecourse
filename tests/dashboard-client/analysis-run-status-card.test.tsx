import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyzeRunStatusResponse } from '@truecourse/shared';
import { AnalysisRunStatusCard } from '@/components/analyses/AnalysisRunStatusCard';
import { AnalysesPanel } from '@/components/analyses/AnalysesPanel';

const blockedStatus: AnalyzeRunStatusResponse = {
  activeMode: null,
  latestAttempt: {
    runId: 'run-blocked-123',
    state: 'blocked',
    startedAt: '2026-07-22T08:00:00.000Z',
    updatedAt: '2026-07-22T08:10:00.000Z',
    source: 'dashboard',
    branch: 'main',
    commitHash: '1234567890abcdef',
    counts: { total: 100, succeeded: 60, pending: 39, running: 0, failed: 1 },
    lastProviderLimit: {
      resetHint: 'Jul 23 at 8:00 PM (Africa/Cairo)',
      blockedAt: '2026-07-22T08:10:00.000Z',
    },
    resume: {
      available: true,
      scope: 'structural',
      mode: 'resume',
      requiresLatestAttempt: true,
      requiresRevalidation: true,
    },
  },
  activeCompletedAnalysis: {
    analysisId: 'analysis-safe-456',
    createdAt: '2026-07-21T08:00:00.000Z',
    branch: 'main',
    commitHash: 'abcdef1234567890',
  },
};

describe('AnalysisRunStatusCard', () => {
  it('keeps the baseline distinct and starts Resume for the exact attempted run', async () => {
    const onResume = vi.fn(async () => undefined);
    render(
      <AnalysisRunStatusCard
        status={blockedStatus}
        resumeRunId={null}
        resumeError={null}
        onResume={onResume}
      />,
    );

    expect(screen.getByRole('region', { name: 'Latest run' })).toHaveTextContent('blocked');
    expect(screen.getByText('60/100 LLM checks complete')).toBeInTheDocument();
    expect(screen.getByText(/39 pending · 1 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Jul 23 at 8:00 PM/)).toBeInTheDocument();
    expect(screen.getByText('truecourse analyze resume run-blocked-123')).toBeInTheDocument();

    const completed = screen.getByRole('region', { name: 'Active completed analysis' });
    expect(completed).toHaveTextContent('analysis-safe-456');
    expect(completed).toHaveTextContent('trustworthy findings baseline');
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledWith('run-blocked-123');
    expect(screen.getByText(/revalidates saved inputs and checkpoints before reuse/i)).toBeInTheDocument();
    expect(screen.getByText(/CLI fallback/i)).toBeInTheDocument();
  });

  it.each([
    ['resume', null, 'Resuming…'],
    ['analysis', null, 'Another analysis is running'],
    [null, 'run-blocked-123', 'Starting Resume…'],
  ] as const)('disables the action for activeMode=%s and starting=%s', (activeMode, resumeRunId, label) => {
    render(
      <AnalysisRunStatusCard
        status={{ ...blockedStatus, activeMode }}
        resumeRunId={resumeRunId}
        resumeError={null}
        onResume={async () => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: label })).toBeDisabled();
  });

  it('reports admission errors beside the exact Resume action', () => {
    render(
      <AnalysisRunStatusCard
        status={blockedStatus}
        resumeRunId={null}
        resumeError="The selected attempted run is no longer the latest."
        onResume={async () => undefined}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/no longer the latest/i);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
  });

  it('explains why dashboard Resume is unavailable without inventing an action', () => {
    render(
      <AnalysisRunStatusCard
        status={{
          ...blockedStatus,
          latestAttempt: {
            ...blockedStatus.latestAttempt!,
            state: 'running',
            resume: {
              available: false,
              scope: 'structural',
              reason: 'resume-execution-ambiguous',
            },
          },
        }}
        resumeRunId={null}
        resumeError={null}
        onResume={async () => undefined}
      />,
    );

    expect(screen.getByText(/provider call may still be incomplete/i)).toBeInTheDocument();
    expect(screen.queryByText(/truecourse analyze resume/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([
    ['successful-results-not-checkpointed', /not saved as reusable checkpoints/i],
    ['checkpoint-execution-unbound', /not bound to a verified execution/i],
    ['resume-execution-ambiguous', /provider call may still be incomplete/i],
    ['finalization-unprepared', /cannot be finalized safely/i],
    ['run-failed', /failed and is not eligible/i],
    ['run-not-resumable', /not in a resumable state/i],
    ['run-completed', /already completed/i],
  ] as const)('explains %s without rendering a dashboard action', (reason, message) => {
    render(
      <AnalysisRunStatusCard
        status={{
          ...blockedStatus,
          latestAttempt: {
            ...blockedStatus.latestAttempt!,
            resume: { available: false, scope: 'structural', reason },
          },
        }}
        resumeRunId={null}
        resumeError={null}
        onResume={async () => undefined}
      />,
    );

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows an interrupted attempt when no completed analysis rows exist', () => {
    render(
      <AnalysesPanel
        analyses={[]}
        isLoading={false}
        onSelectAnalysis={() => undefined}
        onDeleteAnalysis={async () => undefined}
        repoId="repo-1"
        runStatus={blockedStatus}
        runStatusLoading={false}
        runStatusError={null}
        resumeRunId={null}
        resumeError={null}
        onResume={async () => undefined}
      />,
    );

    expect(screen.getByRole('region', { name: 'Latest run' })).toHaveTextContent('run-blocked-123');
    expect(screen.getByText(/No completed analyses yet/i)).toBeInTheDocument();
  });

  it('reports a read failure neutrally without claiming analysis is paused', () => {
    render(
      <AnalysesPanel
        analyses={[]}
        isLoading={false}
        onSelectAnalysis={() => undefined}
        onDeleteAnalysis={async () => undefined}
        repoId="repo-1"
        runStatus={null}
        runStatusLoading={false}
        runStatusError="temporary disconnect"
        resumeRunId={null}
        resumeError={null}
        onResume={async () => undefined}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Attempted-run status is unavailable');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/paused/i);
    expect(screen.getByText(/No completed analyses yet/i)).toBeInTheDocument();
  });
});
