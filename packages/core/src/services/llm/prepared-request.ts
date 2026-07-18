import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

export interface PreparedPromptBinding {
  readonly promptId: string;
  readonly runtimeId: string;
}

/** Neutral execution contract shared by every prepared LLM work family. */
export interface PreparedLlmRequest<T> {
  readonly stage: string;
  readonly label: string;
  readonly resultContractId: string;
  readonly system: string;
  readonly prompt: string;
  readonly schemaJson: string;
  readonly responseFormat: 'json' | 'text';
  readonly toolPolicy: 'none' | 'read';
  readonly timeoutMs: number;
  readonly parse: (value: unknown) => T;
}

export function serializePreparedRequestSchema(schema: ZodTypeAny): string {
  return JSON.stringify(zodToJsonSchema(schema, { target: 'openApi3' }));
}
