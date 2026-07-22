import type { CompletedAnalysisProjectionIntent } from './completed-analysis-projection.js';
import type { CompletedAnalysisPromotion } from './completed-analysis-promotion.js';
import type { AnalyzeRunView } from './analyze-run-journal.js';

export interface PreparedAnalyzeRunFinalization {
  preparedAt: string;
  promotion: CompletedAnalysisPromotion;
  projection: CompletedAnalysisProjectionIntent;
}

type PreparedFinalizationReader = (
  repoKey: string,
  runId: string,
) => Promise<PreparedAnalyzeRunFinalization | null>;

declare const preparedAnalyzeRunCompletionBrand: unique symbol;
export type PreparedAnalyzeRunCompletion = Readonly<{
  [preparedAnalyzeRunCompletionBrand]: true;
}>;

export type CertifiedPreparedAnalyzeRunFinalization =
  | {
      state: 'prepared';
      repositoryKey: string;
      prepared: PreparedAnalyzeRunFinalization;
      completion: PreparedAnalyzeRunCompletion;
    }
  | {
      state: 'completed';
      repositoryKey: string;
      completed: AnalyzeRunView;
    };

type PreparedFinalizationCertifier = (
  repoKey: string,
  runId: string,
) => Promise<CertifiedPreparedAnalyzeRunFinalization | null>;

export interface CompletePreparedAnalyzeRunCommand {
  runId: string;
  completedAt: string;
  completion: PreparedAnalyzeRunCompletion;
}

type PreparedFinalizationCompleter = (
  repoKey: string,
  command: CompletePreparedAnalyzeRunCommand,
) => Promise<AnalyzeRunView>;

type PreparedFinalizationCompletionValidator = (
  completion: PreparedAnalyzeRunCompletion,
) => void;

let installedReader: PreparedFinalizationReader | null = null;
let installedCertifier: PreparedFinalizationCertifier | null = null;
let installedCompleter: PreparedFinalizationCompleter | null = null;
let installedCompletionValidator: PreparedFinalizationCompletionValidator | null = null;

export function installPreparedAnalyzeRunFinalizationReader(
  reader: PreparedFinalizationReader,
): void {
  installedReader = reader;
}

export function installPreparedAnalyzeRunFinalizationCompleter(
  completer: PreparedFinalizationCompleter,
): void {
  installedCompleter = completer;
}

export function installPreparedAnalyzeRunFinalizationCertifier(
  certifier: PreparedFinalizationCertifier,
): void {
  installedCertifier = certifier;
}

export function installPreparedAnalyzeRunFinalizationCompletionValidator(
  validator: PreparedFinalizationCompletionValidator,
): void {
  installedCompletionValidator = validator;
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

export async function certifyPreparedAnalyzeRunFinalization(
  repoKey: string,
  runId: string,
): Promise<CertifiedPreparedAnalyzeRunFinalization | null> {
  if (installedCertifier === null) {
    throw new Error('Analyze-run finalization certification is not initialized');
  }
  return installedCertifier(repoKey, runId);
}

export async function completePreparedAnalyzeRunFinalization(
  repoKey: string,
  command: CompletePreparedAnalyzeRunCommand,
): Promise<AnalyzeRunView> {
  if (installedCompleter === null) {
    throw new Error('Analyze-run finalization completion is not initialized');
  }
  return installedCompleter(repoKey, command);
}

export function assertPreparedAnalyzeRunFinalizationCompletionActive(
  completion: PreparedAnalyzeRunCompletion,
): void {
  if (installedCompletionValidator === null) {
    throw new Error('Analyze-run finalization completion validation is not initialized');
  }
  installedCompletionValidator(completion);
}
