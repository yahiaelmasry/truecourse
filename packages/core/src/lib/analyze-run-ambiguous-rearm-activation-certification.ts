import type { ActivateAnalyzeRunAmbiguousRearmCommand } from './analyze-run-journal.js';

declare const analyzeRunAmbiguousRearmActivationCertificationBrand: unique symbol;

/** Opaque proof that a planner accepted one exact ambiguous rearm partition. */
export type AnalyzeRunAmbiguousRearmActivationCertification = Readonly<{
  [analyzeRunAmbiguousRearmActivationCertificationBrand]: true;
}>;

const certifications = new WeakMap<object, ActivateAnalyzeRunAmbiguousRearmCommand>();

/** Internal planner seam; this module is absent from the package export map. */
export function certifyAnalyzeRunAmbiguousRearmActivation(
  command: ActivateAnalyzeRunAmbiguousRearmCommand,
): AnalyzeRunAmbiguousRearmActivationCertification {
  const certification = Object.freeze({}) as AnalyzeRunAmbiguousRearmActivationCertification;
  certifications.set(certification, command);
  return certification;
}

export function inspectAnalyzeRunAmbiguousRearmActivationCertification(
  certification: AnalyzeRunAmbiguousRearmActivationCertification,
): ActivateAnalyzeRunAmbiguousRearmCommand | null {
  if (
    (typeof certification !== 'object' && typeof certification !== 'function')
    || certification === null
  ) return null;
  return certifications.get(certification) ?? null;
}
