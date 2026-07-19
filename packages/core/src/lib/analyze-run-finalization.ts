import {
  getAnalysisStore,
} from './analysis-store.js';
import { projectCompletedAnalysis } from './completed-analysis-projection.js';
import { getRegistryStore } from '../config/registry.js';
import {
  certifyPreparedAnalyzeRunFinalization,
  completePreparedAnalyzeRunFinalization,
} from './analyze-run-finalization-recovery.js';
import {
  InvalidAnalyzeRunTransitionError,
  type AnalyzeRunView,
} from './analyze-run-journal.js';

export interface FinalizePreparedAnalyzeRunCommand {
  runId: string;
  completedAt: string;
}

export type AnalyzeRunFinalizationFaultPoint =
  | 'after-promotion'
  | 'after-projection'
  | 'after-completion';

export interface FinalizePreparedAnalyzeRunOptions {
  faultInjector?: (
    point: AnalyzeRunFinalizationFaultPoint,
  ) => void | Promise<void>;
}

/**
 * Recover and finish one prepared attempt while the caller holds the repository lifecycle lock.
 * Journal completion is the final effect; every preceding persistence step is retry-safe.
 */
export async function finalizePreparedAnalyzeRun(
  repoKey: string,
  command: FinalizePreparedAnalyzeRunCommand,
  options: FinalizePreparedAnalyzeRunOptions = {},
): Promise<AnalyzeRunView> {
  const analysisStore = getAnalysisStore();
  const registryStore = getRegistryStore();
  const assertPersistenceStores = (): void => {
    if (getAnalysisStore() !== analysisStore || getRegistryStore() !== registryStore) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${command.runId} persistence storage changed during finalization`,
      );
    }
  };
  const certified = await certifyPreparedAnalyzeRunFinalization(repoKey, command.runId);
  assertPersistenceStores();
  if (!certified) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${command.runId} has no prepared finalization intent`,
    );
  }
  if (certified.state === 'completed') {
    if (certified.completed.updatedAt !== command.completedAt) {
      throw new InvalidAnalyzeRunTransitionError(
        `Analyze run ${command.runId} was completed with a different completion time`,
      );
    }
    return certified.completed;
  }
  if (
    typeof command.completedAt !== 'string'
    || command.completedAt.length === 0
    || !Number.isFinite(Date.parse(command.completedAt))
  ) {
    throw new InvalidAnalyzeRunTransitionError('completedAt must be a valid timestamp');
  }
  if (Date.parse(command.completedAt) < Date.parse(certified.prepared.preparedAt)) {
    throw new InvalidAnalyzeRunTransitionError(
      `Analyze run ${command.runId} completion cannot precede prepared finalization`,
    );
  }
  await analysisStore.promoteCompletedAnalysisBaseline(
    certified.repositoryKey,
    certified.prepared.promotion,
  );
  assertPersistenceStores();
  await options.faultInjector?.('after-promotion');
  assertPersistenceStores();
  await projectCompletedAnalysis(certified.repositoryKey, certified.prepared.projection, {
    analysisStore,
    registryStore,
  });
  assertPersistenceStores();
  await options.faultInjector?.('after-projection');
  assertPersistenceStores();
  const completed = await completePreparedAnalyzeRunFinalization(certified.repositoryKey, {
    ...command,
    completion: certified.completion,
  });
  await options.faultInjector?.('after-completion');
  return completed;
}
