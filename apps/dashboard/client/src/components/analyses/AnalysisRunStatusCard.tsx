import { useRef, useState } from 'react';
import { Clock, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import type {
  AnalyzeRunResumeUnavailableReason,
  AnalyzeRunAmbiguousRearmOffer,
  AnalyzeRunAmbiguousRearmConsent,
  AnalyzeRunStartOverUnavailableReason,
  AnalyzeRunStatusResponse,
} from '@truecourse/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface AnalysisRunStatusCardProps {
  status: AnalyzeRunStatusResponse;
  resumeRunId: string | null;
  resumeError: string | null;
  rearmRunId: string | null;
  rearmError: string | null;
  startOverRunId: string | null;
  startOverError: string | null;
  onResume: (runId: string) => Promise<void>;
  onRearm: (runId: string, consent: AnalyzeRunAmbiguousRearmConsent) => Promise<void>;
  onStartOver: (runId: string) => Promise<void>;
}

const unavailableMessages: Record<AnalyzeRunResumeUnavailableReason, string> = {
  'successful-results-not-checkpointed': 'successful results were not saved as reusable checkpoints',
  'checkpoint-execution-unbound': 'the saved checkpoints are not bound to a verified execution',
  'resume-execution-ambiguous': 'a previously admitted provider call may still be incomplete',
  'finalization-unprepared': 'this run cannot be finalized safely from its saved state',
  'run-failed': 'this run failed and is not eligible for Resume',
  'run-not-resumable': 'this run is not in a resumable state',
  'run-completed': 'this run is already completed',
};

const startOverUnavailableMessages: Record<AnalyzeRunStartOverUnavailableReason, string> = {
  'resume-execution-ambiguous': 'a previously admitted provider call may still be incomplete',
  'recovery-required': 'durable recovery or finalization must be resumed first',
  'run-completed': 'this run is already completed',
  'attempt-superseded': 'a newer completed analysis has already superseded this attempt',
};

export function AnalysisRunStatusCard({
  status,
  resumeRunId,
  resumeError,
  rearmRunId,
  rearmError,
  startOverRunId,
  startOverError,
  onResume,
  onRearm,
  onStartOver,
}: AnalysisRunStatusCardProps) {
  const attempt = status.latestAttempt;
  const completed = status.activeCompletedAnalysis;
  const [confirmation, setConfirmation] = useState<{
    runId: string;
    savedSuccesses: number;
    completedAnalysisId: string | null;
  } | null>(null);
  const [rearmConfirmation, setRearmConfirmation] = useState<{
    runId: string; offer: AnalyzeRunAmbiguousRearmOffer;
  } | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const confirmingRef = useRef(false);

  const confirmStartOver = async () => {
    if (!confirmation || confirmingRef.current || status.activeMode !== null) return;
    confirmingRef.current = true;
    setIsConfirming(true);
    setConfirmationError(null);
    try {
      await onStartOver(confirmation.runId);
      setConfirmation(null);
    } catch (cause) {
      setConfirmationError(
        cause instanceof Error ? cause.message : 'Unable to start replacement analysis',
      );
    } finally {
      confirmingRef.current = false;
      setIsConfirming(false);
    }
  };
  const confirmRearm = async () => {
    if (!rearmConfirmation || confirmingRef.current || status.activeMode !== null) return;
    confirmingRef.current = true;
    setIsConfirming(true);
    setConfirmationError(null);
    const { runId, offer } = rearmConfirmation;
    try {
      await onRearm(runId, {
        evidence: structuredClone(offer.evidence),
        acceptedRisk: 'repeat-up-to-pending-provider-calls',
        acceptedMaxRepeatProviderCalls: offer.maxRepeatProviderCalls,
      });
      setRearmConfirmation(null);
    } catch (cause) {
      setConfirmationError(cause instanceof Error ? cause.message : 'Unable to start Analyze Rearm');
    } finally {
      confirmingRef.current = false;
      setIsConfirming(false);
    }
  };

  return (
    <div className="mb-4 grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-2">
      <section aria-label="Latest run">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Latest run
          </div>
          {attempt && (
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {attempt.state}
            </span>
          )}
        </div>

        {attempt ? (
          <div className="space-y-2 text-xs">
            <div className="font-mono text-[11px] text-muted-foreground break-all">{attempt.runId}</div>
            <div className="text-[11px] text-muted-foreground">
              {attempt.source} · {attempt.branch ?? 'detached'}@{attempt.commitHash?.slice(0, 7) ?? 'unknown'}
              {' · '}updated {formatDateTime(attempt.updatedAt)}
            </div>
            {attempt.counts && (
              <div>
                <div className="font-medium text-foreground">
                  {attempt.counts.succeeded}/{attempt.counts.total} LLM checks complete
                </div>
                <div className="text-muted-foreground">
                  {attempt.counts.pending} pending
                  {attempt.counts.running > 0 ? ` · ${attempt.counts.running} running` : ''}
                  {attempt.counts.failed > 0 ? ` · ${attempt.counts.failed} failed` : ''}
                </div>
              </div>
            )}
            {attempt.lastProviderLimit && (
              <div className="space-y-1 text-muted-foreground">
                <div className="flex items-start gap-1.5">
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {attempt.state === 'blocked' ? 'Provider session limit' : 'Last provider limit'}:
                    {' '}reset {attempt.lastProviderLimit.resetHint}
                  </span>
                </div>
                {attempt.lastProviderLimit.resetAt && (
                  <div className="font-mono text-[10px]">
                    Verified reset time: {attempt.lastProviderLimit.resetAt}
                  </div>
                )}
              </div>
            )}
            {attempt.resume.available ? (
              <div className="space-y-2 rounded-md bg-muted/60 p-2 text-[11px] leading-4 text-muted-foreground">
                <button
                  type="button"
                  disabled={
                    resumeRunId === attempt.runId
                    || startOverRunId !== null
                    || rearmRunId !== null
                    || status.activeMode !== null
                  }
                  onClick={() => void onResume(attempt.runId)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resumeRunId === attempt.runId || status.activeMode === 'resume' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  {resumeRunId === attempt.runId
                    ? 'Starting Resume…'
                    : status.activeMode === 'resume'
                      ? 'Resuming…'
                      : status.activeMode === 'analysis'
                        ? 'Another analysis is running'
                        : 'Resume'}
                </button>
                <div>
                  Resume revalidates saved inputs and checkpoints before reuse, then runs only
                  pending work. The active completed analysis remains trustworthy until promotion.
                </div>
                <div>
                  CLI fallback:
                  {' '}<code className="break-all text-foreground">truecourse analyze resume {attempt.runId}</code>
                </div>
                {resumeError && (
                  <div className="text-destructive" role="alert">{resumeError}</div>
                )}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">
                Resume unavailable — {unavailableMessages[attempt.resume.reason]}.
              </div>
            )}
            {attempt.rearm && (
              <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] leading-4 text-muted-foreground">
                <Button type="button" size="sm" variant="outline"
                  disabled={status.activeMode !== null || resumeRunId !== null || startOverRunId !== null || rearmRunId !== null}
                  onClick={() => { setRearmConfirmation({ runId: attempt.runId, offer: structuredClone(attempt.rearm!) }); setConfirmationError(null); }}>
                  {(rearmRunId === attempt.runId || status.activeMode === 'rearm') && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {rearmRunId === attempt.runId
                    ? 'Starting Analyze Rearm…'
                    : status.activeMode === 'rearm'
                      ? 'Rearming…'
                      : 'Rearm ambiguous execution'}
                </Button>
                {rearmRunId === attempt.runId && (
                  <div role="status">Analyze Rearm was accepted. Refreshing Latest run…</div>
                )}
                <div>One prior provider call may have completed without a durable receipt. At most {attempt.rearm.maxRepeatProviderCalls} provider {attempt.rearm.maxRepeatProviderCalls === 1 ? 'call' : 'calls'} may repeat; {attempt.rearm.checkpointedWorkCount} saved {attempt.rearm.checkpointedWorkCount === 1 ? 'check' : 'checks'} remain eligible for reuse after revalidation.</div>
                {rearmError && <div className="text-destructive" role="alert">{rearmError}</div>}
              </div>
            )}
            {attempt.startOver.available ? (
              <div className="space-y-2 rounded-md border border-destructive/25 bg-destructive/5 p-2 text-[11px] leading-4 text-muted-foreground">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    status.activeMode !== null
                    || resumeRunId !== null
                    || startOverRunId !== null
                    || rearmRunId !== null
                  }
                  onClick={() => {
                    setConfirmation({
                      runId: attempt.runId,
                      savedSuccesses: attempt.counts?.succeeded ?? 0,
                      completedAnalysisId: completed?.analysisId ?? null,
                    });
                    setConfirmationError(null);
                  }}
                >
                  {startOverRunId === attempt.runId && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {startOverRunId === attempt.runId ? 'Starting over…' : 'Start over'}
                </Button>
                <div>
                  Start a new full analysis only after confirming this exact run. Saved successful
                  work will not be reused, so paid LLM calls may repeat.
                </div>
                {startOverError && (
                  <div className="text-destructive" role="alert">{startOverError}</div>
                )}
              </div>
            ) : attempt.startOver.reason !== 'run-completed' ? (
              <div className="text-[11px] text-muted-foreground">
                Start over unavailable — {startOverUnavailableMessages[attempt.startOver.reason]}.
              </div>
            ) : null}
            {attempt.state !== 'completed' && (
              <div className="text-[11px] text-muted-foreground">
                Partial findings from this run do not replace the active completed analysis.
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No attempted run has been saved.</div>
        )}
      </section>

      <section
        aria-label="Active completed analysis"
        className="border-t border-border pt-3 md:border-l md:border-t-0 md:pl-4 md:pt-0"
      >
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          Active completed analysis
        </div>
        {completed ? (
          <div className="space-y-1 text-xs">
            <div className="break-all font-mono font-medium text-foreground">{completed.analysisId}</div>
            <div className="text-muted-foreground">
              {completed.branch ?? 'detached'}@{completed.commitHash?.slice(0, 7) ?? 'unknown'}
            </div>
            <div className="text-[11px] text-muted-foreground">
              This remains the trustworthy findings baseline until another run completes and is promoted.
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">No completed analysis yet.</div>
        )}
      </section>

      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !isConfirming) {
            setConfirmation(null);
            setConfirmationError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start over this run?</DialogTitle>
            <DialogDescription>
              This acknowledgement is bound to the exact attempted run shown below.
            </DialogDescription>
          </DialogHeader>
          {confirmation && (
            <div className="space-y-3 text-sm">
              <code className="block break-all rounded bg-muted px-2 py-1.5 text-xs">
                {confirmation.runId}
              </code>
              <p>
                Starting over will not reuse {confirmation.savedSuccesses} successful LLM
                {' '}{confirmation.savedSuccesses === 1 ? 'check' : 'checks'} recorded in this attempt,
                so paid calls may repeat.
              </p>
              <p>
                Active completed analysis {confirmation.completedAnalysisId ?? 'none'} remains
                trustworthy and canonical until the replacement analysis completes.
              </p>
              {(confirmationError || startOverError) && (
                <div className="text-destructive" role="alert">
                  {confirmationError ?? startOverError}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isConfirming}
              onClick={() => setConfirmation(null)}
            >
              Keep saved run
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isConfirming || status.activeMode !== null || startOverRunId !== null || rearmRunId !== null}
              onClick={() => void confirmStartOver()}
            >
              {isConfirming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Start over and analyze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={rearmConfirmation !== null} onOpenChange={(open) => { if (!open && !isConfirming) { setRearmConfirmation(null); setConfirmationError(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rearm this ambiguous execution?</DialogTitle><DialogDescription>This acknowledgement is bound to the exact run and execution evidence shown here.</DialogDescription></DialogHeader>
          {rearmConfirmation && (
            <div className="space-y-3 text-sm">
              <dl className="space-y-1 rounded bg-muted px-2 py-1.5 text-xs">
                <div><dt className="inline text-muted-foreground">Attempt run ID: </dt><dd className="inline break-all font-mono">{rearmConfirmation.runId}</dd></div>
                <div><dt className="inline text-muted-foreground">Submitted evidence run ID: </dt><dd className="inline break-all font-mono">{rearmConfirmation.offer.evidence.runId}</dd></div>
                <div><dt className="inline text-muted-foreground">Revision: </dt><dd className="inline">{rearmConfirmation.offer.evidence.runRevision}</dd></div>
                <div><dt className="inline text-muted-foreground">Execution epoch: </dt><dd className="inline">{rearmConfirmation.offer.evidence.executionEpoch.kind} #{rearmConfirmation.offer.evidence.executionEpoch.attemptNumber}, activated {rearmConfirmation.offer.evidence.executionEpoch.activatedAt}</dd></div>
                <div><dt className="inline text-muted-foreground">Admitted: </dt><dd className="inline font-mono">{rearmConfirmation.offer.evidence.admittedAt}</dd></div>
                <div><dt className="inline text-muted-foreground">Pending work: </dt><dd className="inline">{rearmConfirmation.offer.evidence.pendingWorkCount}</dd></div>
              </dl>
              <p>Up to {rearmConfirmation.offer.maxRepeatProviderCalls} provider {rearmConfirmation.offer.maxRepeatProviderCalls === 1 ? 'call may' : 'calls may'} repeat. Completed checkpoints can be reused only after full revalidation.</p>
              <p>The active completed analysis remains the trustworthy baseline until this run fully completes and is promoted.</p>
              {(confirmationError || rearmError) && <div className="text-destructive" role="alert">{confirmationError ?? rearmError}</div>}
            </div>
          )}
          <DialogFooter><Button type="button" variant="outline" disabled={isConfirming} onClick={() => setRearmConfirmation(null)}>Keep saved run</Button><Button type="button" disabled={isConfirming || status.activeMode !== null || rearmRunId !== null} onClick={() => void confirmRearm()}>{isConfirming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Acknowledge and rearm</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
