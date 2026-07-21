/**
 * Thin wrapper over `analyzeCore` + `persistFullAnalysis`. Exists for
 * backwards compatibility — CLI and routes import `analyzeInProcess` from
 * `@truecourse/core/commands/analyze-in-process`, and this keeps that surface stable even as
 * the internal split becomes core-compute vs mode-specific-persist.
 */

import { removeFromHistory } from '../lib/analysis-store.js';
import type { RegistryEntry } from '../config/registry.js';
import type { LLMProvider } from '../services/llm/provider.js';
import type { LlmTransport } from '@truecourse/shared/llm';
import type { StepTracker } from '../progress.js';
import { analyzeCoreAndFinalize, type AnalyzeCoreResult, type LlmEstimate } from './analyze-core.js';
import {
  buildFullAnalysisFinalizationPlan,
  persistFullAnalysis,
  type PersistFullResult,
} from './analyze-persist.js';
import {
  beginFinalizeAnalyzeRun,
  dispatchAnalyzeRun,
  prepareAnalyzeRunFinalization,
  readAnalyzeRun,
} from '../lib/analyze-run-journal.js';
import { finalizePreparedAnalyzeRun } from '../lib/analyze-run-finalization.js';
import { JournaledAnalyzeSessionLimitError } from '../services/llm/certified-violation-phase.js';
import { config } from '../config/index.js';
import { log } from '../lib/logger.js';
import {
  isLlmSessionLimitError,
  LlmSessionLimitError,
} from '@truecourse/shared/llm';
import {
  bucketDuration,
  bucketFileCount,
  detectLanguages,
  trackEvent,
  type TelemetrySource,
} from '../services/telemetry.service.js';

export type { LlmEstimate };

export interface AnalyzeInProcessOptions {
  /**
   * Where the code lives (defaults to `project.path`). The hosted edition sets
   * this to a clone so storage keys off `project.path` (the repo identity) while
   * the analysis reads the cloned working tree.
   */
  codeDir?: string;
  branch?: string | null;
  commitHash?: string | null;
  /** Skip all git commands (branch detection, commit hash, diff). */
  skipGit?: boolean;
  /**
   * Analyze the working tree as-is instead of stashing dirty changes first.
   * The CLI sets this from `--no-stash` (or after the user declines the
   * stash prompt). Defaults to `false` (stash if dirty).
   */
  skipStash?: boolean;
  enabledCategoriesOverride?: string[];
  enableLlmRulesOverride?: boolean;
  tracker?: StepTracker;
  onProgress?: (progress: { detail?: string }) => void;
  onLlmEstimate?: (estimate: LlmEstimate) => Promise<boolean>;
  onLlmResolved?: (proceed: boolean) => void;
  provider?: LLMProvider;
  /** LLM transport for the auto-created provider (cli default; agent for headless). */
  transport?: LlmTransport;
  /**
   * Model for the auto-created provider, as chosen in the analyze model picker.
   * Omit to let Claude Code pick (the pre-picker behavior).
   */
  selectedModel?: string;
  signal?: AbortSignal;
  /**
   * Adapter that triggered this run. Auto-emitted in the telemetry payload so
   * we can attribute analyses to CLI vs dashboard. Omit to skip telemetry.
   */
  source?: TelemetrySource;
}

export type AnalyzeInProcessResult = PersistFullResult;

export class AnalysisSessionLimitError extends LlmSessionLimitError {
  constructor(error: LlmSessionLimitError) {
    super(error.resetHint);
    this.name = 'AnalysisSessionLimitError';
    this.message = error instanceof JournaledAnalyzeSessionLimitError
      ? `${this.message} The interrupted run and any successful LLM results were checkpointed as the latest attempted run, but LATEST.json was not updated and the previous completed analysis remains unchanged. Resume and checkpoint reuse are not enabled yet, so starting a new run may repeat those calls.`
      : `${this.message} The interrupted run was not saved, so LATEST.json was not updated and any previous completed analysis remains unchanged. Successful LLM calls from this interrupted run cannot be resumed yet and may be repeated when you rerun.`;
  }
}

export async function analyzeInProcess(
  project: RegistryEntry,
  options: AnalyzeInProcessOptions = {},
): Promise<AnalyzeInProcessResult> {
  const startedAt = Date.now();
  log.info(
    `[LLM] Provider: claude-code, model: ${
      options.selectedModel || config.claudeCodeModel || 'default (chosen by Claude Code)'
    }, maxConcurrency: ${config.claudeCodeMaxConcurrency}`,
  );
  let core!: AnalyzeCoreResult;
  let result: PersistFullResult;
  try {
    result = await analyzeCoreAndFinalize(
      project,
      { ...options, mode: 'full', journalFullRun: true },
      async (computed) => {
        core = computed;
        const certified = computed.pipelineResult.certifiedLlmExecution;
        if (certified) {
          try {
            const plan = buildFullAnalysisFinalizationPlan(project, computed);
            const executedAttempt = await readAnalyzeRun(project.path, { runId: certified.runId });
            const finalizingAt = timestampAtOrAfter(executedAttempt?.updatedAt ?? computed.now);
            await beginFinalizeAnalyzeRun(project.path, {
              runId: certified.runId,
              finalizingAt,
            }, certified.completion);
            const preparedAt = timestampAtOrAfter(finalizingAt);
            await prepareAnalyzeRunFinalization(project.path, {
              runId: certified.runId,
              preparedAt,
              promotion: plan.promotion,
              projection: plan.projection,
            });
            await finalizePreparedAnalyzeRun(project.path, {
              runId: certified.runId,
              completedAt: timestampAtOrAfter(preparedAt),
            });
            return {
              ...plan.result,
              durationMs: Date.now() - startedAt,
            };
          } catch (error) {
            const attempted = await readAnalyzeRun(
              project.path,
              { runId: certified.runId },
            ).catch(() => null);
            const recoverable = attempted?.finalization?.persistence === 'prepared';
            if (
              attempted
              && !recoverable
              && (attempted.state === 'running' || attempted.state === 'finalizing')
            ) {
              await dispatchAnalyzeRun(project.path, {
                kind: 'fail',
                runId: certified.runId,
                failedAt: timestampAtOrAfter(attempted.updatedAt),
                error: {
                  code: 'ANALYZE_FINALIZATION_FAILED',
                  message: error instanceof Error ? error.message : String(error),
                },
              });
            }
            throw error;
          }
        }
        return persistFullAnalysis(project, computed, startedAt);
      },
    );
  } catch (error) {
    if (isLlmSessionLimitError(error)) throw new AnalysisSessionLimitError(error);
    throw error;
  }

  if (options.source) {
    await trackEvent('analyze', {
      source: options.source,
      mode: 'full',
      serviceCount: result.serviceCount,
      fileCountRange: bucketFileCount(result.fileCount),
      languages: detectLanguages(core.analysisResult),
      architecture: result.architecture,
      durationRange: bucketDuration(result.durationMs),
    });
  }

  return result;
}

// Re-export so the route can detect and remove a specific analysis's history entry.
export { removeFromHistory };

function timestampAtOrAfter(notBefore: string): string {
  return new Date(Math.max(Date.now(), Date.parse(notBefore))).toISOString();
}
