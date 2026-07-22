import type {
  AnalyzeRunCheckpointWriter,
  CheckpointAnalyzeRunWorkCommand,
} from './analyze-run-journal.js';

declare const analyzeRunWorkCheckpointCertificationBrand: unique symbol;

/**
 * Opaque proof that the certified executor accepted one exact provider result.
 * This module is intentionally absent from the package export map.
 */
export type AnalyzeRunWorkCheckpointCertification = Readonly<{
  [analyzeRunWorkCheckpointCertificationBrand]: true;
}>;

const certifiedCheckpoints = new WeakMap<object, {
  writer: AnalyzeRunCheckpointWriter;
  command: CheckpointAnalyzeRunWorkCommand;
}>();

export function certifyAnalyzeRunWorkCheckpoint(
  writer: AnalyzeRunCheckpointWriter,
  command: CheckpointAnalyzeRunWorkCommand,
): AnalyzeRunWorkCheckpointCertification {
  const certification = Object.freeze({}) as AnalyzeRunWorkCheckpointCertification;
  certifiedCheckpoints.set(certification, { writer, command });
  return certification;
}

export function inspectAnalyzeRunWorkCheckpointCertification(
  certification: AnalyzeRunWorkCheckpointCertification,
): Readonly<{
  writer: AnalyzeRunCheckpointWriter;
  command: CheckpointAnalyzeRunWorkCommand;
}> | null {
  if (
    (typeof certification !== 'object' && typeof certification !== 'function')
    || certification === null
  ) {
    return null;
  }
  return certifiedCheckpoints.get(certification) ?? null;
}
