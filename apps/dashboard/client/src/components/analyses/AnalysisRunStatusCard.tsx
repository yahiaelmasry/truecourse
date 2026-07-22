import { Clock, ShieldCheck } from 'lucide-react';
import type {
  AnalyzeRunResumeUnavailableReason,
  AnalyzeRunStatusResponse,
} from '@truecourse/shared';

interface AnalysisRunStatusCardProps {
  status: AnalyzeRunStatusResponse;
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

export function AnalysisRunStatusCard({ status }: AnalysisRunStatusCardProps) {
  const attempt = status.latestAttempt;
  const completed = status.activeCompletedAnalysis;

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
              <div className="flex items-start gap-1.5 text-muted-foreground">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {attempt.state === 'blocked' ? 'Provider session limit' : 'Last provider limit'}:
                  {' '}reset {attempt.lastProviderLimit.resetHint}
                </span>
              </div>
            )}
            {attempt.resume.available ? (
              <div className="rounded-md bg-muted/60 p-2 text-[11px] leading-4 text-muted-foreground">
                <div>Structurally resumable. The CLI revalidates saved inputs before admission:</div>
                <code className="mt-1 block break-all text-foreground">
                  truecourse analyze resume {attempt.runId}
                </code>
                <div className="mt-1">Dashboard Resume is not available yet.</div>
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground">
                Resume unavailable — {unavailableMessages[attempt.resume.reason]}.
              </div>
            )}
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
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
