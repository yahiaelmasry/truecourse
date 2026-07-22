/** Provider-neutral evidence retained for one successfully parsed LLM work item. */
export interface AnalyzeLlmExecutionUsage {
  provider: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  callType: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: string | null;
  durationMs: number;
}
