import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export function compareCanonicalText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalizeJsonValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJsonValue).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCanonicalText(left, right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeJsonValue(entry)}`).join(',')}}`;
}

/** Canonicalize exactly the JSON value that persistence would write. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Cannot fingerprint a non-JSON value');
  return canonicalizeJsonValue(JSON.parse(serialized));
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
