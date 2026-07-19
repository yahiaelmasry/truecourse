import type { CompletedAnalysisProjectionIntent } from './completed-analysis-projection.js';
import type { CompletedAnalysisPromotion } from './completed-analysis-promotion.js';

export interface PreparedAnalyzeRunFinalization {
  preparedAt: string;
  promotion: CompletedAnalysisPromotion;
  projection: CompletedAnalysisProjectionIntent;
}

type PreparedFinalizationReader = (
  repoKey: string,
  runId: string,
) => Promise<PreparedAnalyzeRunFinalization | null>;

let installedReader: PreparedFinalizationReader | null = null;

export function installPreparedAnalyzeRunFinalizationReader(
  reader: PreparedFinalizationReader,
): void {
  installedReader = reader;
}

/** Internal recovery seam. This module is intentionally absent from the package export map. */
export async function readPreparedAnalyzeRunFinalization(
  repoKey: string,
  runId: string,
): Promise<PreparedAnalyzeRunFinalization | null> {
  if (installedReader === null) {
    throw new Error('Analyze-run finalization recovery is not initialized');
  }
  return installedReader(repoKey, runId);
}
