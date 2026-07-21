import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

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

export function compareCanonicalText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareCanonicalText(left, right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
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
