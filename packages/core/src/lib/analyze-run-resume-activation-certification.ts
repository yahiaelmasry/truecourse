import type { ActivateAnalyzeRunResumeCommand } from './analyze-run-journal.js';

declare const analyzeRunResumeActivationCertificationBrand: unique symbol;

/** Opaque proof that the certified planner accepted the exact reusable/pending partition. */
export type AnalyzeRunResumeActivationCertification = Readonly<{
  [analyzeRunResumeActivationCertificationBrand]: true;
}>;

const certifications = new WeakMap<object, ActivateAnalyzeRunResumeCommand>();

/** Internal certified-planner boundary. This module is absent from the package export map. */
export function certifyAnalyzeRunResumeActivation(
  command: ActivateAnalyzeRunResumeCommand,
): AnalyzeRunResumeActivationCertification {
  const certification = Object.freeze({}) as AnalyzeRunResumeActivationCertification;
  certifications.set(certification, command);
  return certification;
}

export function inspectAnalyzeRunResumeActivationCertification(
  certification: AnalyzeRunResumeActivationCertification,
): ActivateAnalyzeRunResumeCommand | null {
  if (
    (typeof certification !== 'object' && typeof certification !== 'function')
    || certification === null
  ) return null;
  return certifications.get(certification) ?? null;
}
