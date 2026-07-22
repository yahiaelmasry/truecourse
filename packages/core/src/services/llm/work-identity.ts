export {
  canonicalJson,
  compareCanonicalText,
  fingerprint,
} from '../../lib/canonical-json.js';

export interface LlmWorkExecutionIntent {
  readonly provider: string;
  readonly requestedModel: string | null;
}

export function validateLlmWorkExecutionIntent(
  value: unknown,
): Readonly<LlmWorkExecutionIntent> {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Invalid LLM execution intent');
  }
  const execution = value as Record<string, unknown>;
  if (
    typeof execution.provider !== 'string'
    || execution.provider.length === 0
    || execution.provider.trim() !== execution.provider
    || execution.provider === 'transport:unverified'
    || (execution.requestedModel !== null && (
      typeof execution.requestedModel !== 'string'
      || execution.requestedModel.length === 0
      || execution.requestedModel.trim() !== execution.requestedModel
    ))
  ) {
    throw new TypeError('Invalid LLM execution intent');
  }
  return Object.freeze({
    provider: execution.provider,
    requestedModel: execution.requestedModel,
  }) as Readonly<LlmWorkExecutionIntent>;
}

export interface LlmWorkComponentFingerprints {
  readonly repository: string;
  readonly baseline: string;
  readonly rules: string;
  readonly configuration: string;
  readonly request: string;
  readonly execution: string;
  readonly resultContract: string;
}

export function assertUniqueLlmIdentity(
  values: readonly string[],
  description: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`LLM work contains duplicate ${description}: ${value}`);
    seen.add(value);
  }
}
