declare const analyzeRunExecutionCertificationBrand: unique symbol;
declare const analyzeRunExecutionCompletionBrand: unique symbol;

export type AnalyzeRunExecutionCertification = Readonly<{
  [analyzeRunExecutionCertificationBrand]: true;
}>;

export type AnalyzeRunExecutionCompletion = Readonly<{
  [analyzeRunExecutionCompletionBrand]: true;
}>;

export interface AnalyzeRunExecutionBinding {
  readonly storage: object;
  readonly scopeKey: string;
  readonly runId: string;
  readonly revision: number;
  readonly workKey: string;
  readonly execution: Readonly<{
    provider: string;
    requestedModel: string | null;
  }>;
  claimed: boolean;
}

const certifications = new WeakMap<object, AnalyzeRunExecutionBinding>();
const completions = new WeakMap<object, AnalyzeRunExecutionBinding>();

/** Internal admission output; it is inert until the certified executor accepts every result. */
export function issueAnalyzeRunExecutionCertification(
  binding: Omit<AnalyzeRunExecutionBinding, 'claimed'>,
): AnalyzeRunExecutionCertification {
  const certification = Object.freeze({}) as AnalyzeRunExecutionCertification;
  certifications.set(certification, {
    ...binding,
    execution: Object.freeze({ ...binding.execution }),
    claimed: false,
  });
  return certification;
}

/** Internal certified-executor boundary. This module is not a public package export. */
export function certifyAnalyzeRunExecutionCompletion(
  certification: AnalyzeRunExecutionCertification,
): AnalyzeRunExecutionCompletion {
  const binding = certifications.get(certification);
  if (!binding) throw new Error('Invalid analyze execution certification');
  certifications.delete(certification);
  const completion = Object.freeze({}) as AnalyzeRunExecutionCompletion;
  completions.set(completion, binding);
  return completion;
}

export function inspectAnalyzeRunExecutionCompletion(
  completion: AnalyzeRunExecutionCompletion,
): AnalyzeRunExecutionBinding | null {
  return completions.get(completion) ?? null;
}
