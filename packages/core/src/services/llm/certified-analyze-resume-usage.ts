import type { UsageRecord } from '../../types/snapshot.js';
import { log } from '../../lib/logger.js';
import type { LLMProvider } from './provider.js';
import type { CertifiedAnalyzeLlmResumeExecution } from './certified-analyze-llm-run.js';

export interface CertifiedAnalyzeLlmResumeWithUsage {
  readonly execution: CertifiedAnalyzeLlmResumeExecution;
  readonly usage: readonly UsageRecord[];
}

/**
 * Account one certified Resume from its durable journal ledger only.
 * The provider's overlapping transient buffer is always drained and discarded.
 */
export async function executeCertifiedAnalyzeLlmResumeWithUsage(
  execute: () => Promise<CertifiedAnalyzeLlmResumeExecution>,
  provider: Pick<LLMProvider, 'flushUsage'>,
): Promise<CertifiedAnalyzeLlmResumeWithUsage> {
  let execution: CertifiedAnalyzeLlmResumeExecution | undefined;
  let executionFailed = false;
  let executionError: unknown;
  try {
    execution = await execute();
  } catch (error) {
    executionFailed = true;
    executionError = error;
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    provider.flushUsage();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (executionFailed) {
    if (cleanupFailed) {
      try {
        log.error(
          `[LLM] Failed to discard transient usage after certified resume: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      } catch {
        // Diagnostics must never replace the provider failure and its reset hint.
      }
    }
    throw executionError;
  }
  if (cleanupFailed) throw cleanupError;
  if (!execution) throw new Error('Certified Resume completed without execution evidence');

  const attemptIds = new Set<string>();
  const usage = execution.usageLedger.map<UsageRecord>((entry) => {
    if (attemptIds.has(entry.attemptId)) {
      throw new Error(`Duplicate certified resume usage attempt: ${entry.attemptId}`);
    }
    attemptIds.add(entry.attemptId);
    return {
      provider: entry.usage.provider,
      callType: entry.usage.callType,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens,
      cacheWriteTokens: entry.usage.cacheWriteTokens,
      totalTokens: entry.usage.totalTokens,
      costUsd: entry.usage.costUsd,
      durationMs: entry.usage.durationMs,
      createdAt: entry.checkpointedAt,
    };
  });

  return Object.freeze({ execution, usage: Object.freeze(usage) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
