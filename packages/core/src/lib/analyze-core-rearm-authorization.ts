import type { AnalyzeRunAmbiguousRearmConsent } from './analyze-run-ambiguous-rearm.js';

declare const analyzeCoreRearmAuthorizationBrand: unique symbol;

/** Opaque, one-shot authority retained only by the public atomic rearm command. */
export interface AnalyzeCoreRearmAuthorization {
  readonly [analyzeCoreRearmAuthorizationBrand]: true;
}

export interface AnalyzeCoreRearmSelection {
  readonly runId: string;
  readonly consent: AnalyzeRunAmbiguousRearmConsent | undefined;
}

const selections = new WeakMap<object, Readonly<AnalyzeCoreRearmSelection>>();

export function createAnalyzeCoreRearmAuthorization(
  selection: AnalyzeCoreRearmSelection,
): AnalyzeCoreRearmAuthorization {
  const authorization = Object.freeze({}) as AnalyzeCoreRearmAuthorization;
  selections.set(authorization, Object.freeze({
    runId: selection.runId,
    consent: selection.consent === undefined
      ? undefined
      : structuredClone(selection.consent),
  }));
  return authorization;
}

export function claimAnalyzeCoreRearmAuthorization(
  authorization: AnalyzeCoreRearmAuthorization | undefined,
): Readonly<AnalyzeCoreRearmSelection> | null {
  if (authorization === undefined) return null;
  const selection = selections.get(authorization);
  if (!selection) {
    throw new Error('Analyze Core rearm is not authorized for atomic finalization');
  }
  selections.delete(authorization);
  return selection;
}
