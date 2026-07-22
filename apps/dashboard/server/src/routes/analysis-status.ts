import { Router, type Request, type Response, type NextFunction } from 'express';
import type {
  AnalyzeRunResumeStatus,
  AnalyzeRunStartOverStatus,
  AnalyzeRunStatusResponse,
} from '@truecourse/shared';
import { createAppError } from '@truecourse/core/lib/errors';
import { resolveProjectForRequest } from '@truecourse/core/config/current-project';
import { classifyAnalyzeStart } from '@truecourse/core/commands/analyze-in-process';
import {
  readAnalyzeRunStatus,
  type AnalyzeRunStatus,
} from '@truecourse/core/commands/analyze-run-status';
import { getActiveAnalysisMode } from '@truecourse/core/services/analysis-registry';
import { getCapabilities } from '../ee-loader.js';

const router: Router = Router();

/** Read attempted progress without touching recency state or authorizing an action. */
router.get('/:id/analyses/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!getCapabilities().includes('local-filesystem')) {
      throw createAppError('Not found', 404);
    }
    const repo = await resolveProjectForRequest(req.params.id as string);
    res.json(toAnalyzeRunStatusResponse(await readAnalyzeRunStatus(repo.path), req.params.id as string));
  } catch (error) {
    next(error);
  }
});

function toAnalyzeRunStatusResponse(
  status: AnalyzeRunStatus,
  repoId: string,
): AnalyzeRunStatusResponse {
  const attempt = status.latestAttempt;
  const completed = status.activeCompletedAnalysis;
  return {
    activeMode: getActiveAnalysisMode(repoId),
    latestAttempt: attempt
      ? {
          runId: attempt.runId,
          state: attempt.state,
          startedAt: attempt.startedAt,
          updatedAt: attempt.updatedAt,
          source: attempt.source,
          branch: attempt.branch,
          commitHash: attempt.commitHash,
          counts: attempt.counts
            ? {
                total: attempt.counts.total,
                succeeded: attempt.counts.succeeded,
                pending: attempt.counts.pending,
                running: attempt.counts.running,
                failed: attempt.counts.failed,
              }
            : null,
          lastProviderLimit: attempt.lastProviderLimit
            ? {
                resetHint: attempt.lastProviderLimit.resetHint,
                blockedAt: attempt.lastProviderLimit.blockedAt,
              }
            : null,
          resume: toResumeStatus(attempt.resume),
          startOver: toStartOverStatus(status),
        }
      : null,
    activeCompletedAnalysis: completed
      ? {
          analysisId: completed.analysisId,
          createdAt: completed.createdAt,
          branch: completed.branch,
          commitHash: completed.commitHash,
        }
      : null,
  };
}

function toStartOverStatus(status: AnalyzeRunStatus): AnalyzeRunStartOverStatus {
  const disposition = classifyAnalyzeStart(status);
  if (disposition.kind === 'abandonable') {
    return {
      available: true,
      requiresExactAttempt: true,
      mayRepeatPaidCalls: true,
    };
  }
  if (disposition.kind === 'blocked') {
    return { available: false, reason: disposition.reason };
  }
  return {
    available: false,
    reason: disposition.reason === 'attempt-superseded'
      ? 'attempt-superseded'
      : 'run-completed',
  };
}

function toResumeStatus(
  resume: NonNullable<AnalyzeRunStatus['latestAttempt']>['resume'],
): AnalyzeRunResumeStatus {
  return resume.available
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
        reason: resume.reason,
      };
}

export default router;
