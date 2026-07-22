export {
  canonicalJson,
  compareCanonicalText,
  fingerprint,
} from '../../lib/canonical-json.js';

export interface LlmWorkExecutionIntent {
  readonly provider: string;
  readonly requestedModel: string | null;
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
