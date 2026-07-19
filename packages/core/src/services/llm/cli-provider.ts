import { type ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../lib/logger.js';
import pLimit, { type LimitFunction } from 'p-limit';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { registerChildProcess, unregisterChildProcess } from '../analysis-registry.js';
import type { ZodType } from 'zod';
import type { Violation } from '@truecourse/shared';
import {
  isLlmSessionLimitError,
  parseLlmSessionLimitError,
  type LlmSessionLimitError,
  type LlmTransport,
} from '@truecourse/shared/llm';
import { config } from '../../config/index.js';
import {
  getPrompt,
  buildFlowTemplateVars,
  resolveId,
  resolveIds,
  type FlowEnrichmentContext,
  type PromptIdMap,
} from './prompts.js';
import {
  FlowEnrichmentOutputSchema,
} from './schemas.js';
import {
  type CodeViolationLifecycleOutput,
  type CodeViolationOutput,
  type PreparedCodeOwnership,
} from './prepared-code-violation-request.js';
import type {
  PreparedLifecycleServiceViolationRequest,
  PreparedNormalServiceViolationRequest,
  ServiceLifecycleViolationOutput,
  ServiceViolationOutput,
} from './prepared-service-violation-request.js';
import type {
  DatabaseLifecycleViolationOutput,
  DatabaseViolationOutput,
  PreparedLifecycleDatabaseViolationRequest,
  PreparedNormalDatabaseViolationRequest,
} from './prepared-database-violation-request.js';
import type {
  ModuleLifecycleViolationOutput,
  ModuleViolationOutput,
  PreparedLifecycleModuleViolationRequest,
  PreparedNormalModuleViolationRequest,
} from './prepared-module-violation-request.js';
import {
  serializePreparedRequestSchema,
  type PreparedLlmRequest,
} from './prepared-request.js';
import {
  planCodeViolationWork,
  type PlannedCodeViolationWork,
} from './code-work-planner.js';
import {
  planDatabaseViolationWork,
  type PlannedDatabaseViolationWork,
} from './database-work-planner.js';
import {
  planServiceViolationWork,
  type PlannedServiceViolationWork,
} from './service-work-planner.js';
import {
  planModuleViolationWork,
  type PlannedModuleViolationWork,
} from './module-work-planner.js';
import type { UsageData } from '../usage.service.js';
import type {
  LLMProvider,
  UsageRecord,
  ServiceViolationContext,
  DatabaseViolationContext,
  ModuleViolationContext,
  AllViolationsInput,
  AllViolationsResult,
  AllViolationsLifecycleResult,
  CodeViolationContext,
  ServiceViolationsResult,
  DatabaseViolationsResult,
  ModuleViolationsResult,
  CodeViolationsResult,
  CodeViolationRaw,
  FlowEnrichmentResult,
  DiffViolationItem,
  DiffViolationsResult,
  DatabaseViolationsLifecycleResult,
  ServiceDescription,
} from './provider.js';


// ---------------------------------------------------------------------------
// Base class for CLI-based LLM providers (Claude Code, future Codex)
// ---------------------------------------------------------------------------

interface SpawnOptions {
  timeoutMs?: number;
  /** Extra CLI args appended after base args */
  extraArgs?: string[];
  /** Fires once the concurrency limiter grants a slot, before spawnCLI runs. */
  onStart?: () => void;
  /** Exact provider-independent request metadata, when the request was prepared up front. */
  stage?: string;
  system?: string;
  responseFormat?: 'json' | 'text';
  /** Stable semantic identity of the planned work unit. */
  id?: string;
  workId?: string;
  inputFingerprint?: string;
}

interface CLIUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: string;
}

function certifyCodeResultOwnership(
  ownership: PreparedCodeOwnership,
  violations: CodeViolationRaw[],
): void {
  const allowedRules = new Set(ownership.ruleKeys);
  const allowedSources = new Map<string, PreparedCodeOwnership['sourceScopes'][number]['ranges'][number][]>();
  for (const scope of ownership.sourceScopes) {
    const ranges = allowedSources.get(scope.path) ?? [];
    ranges.push(...scope.ranges);
    allowedSources.set(scope.path, ranges);
  }
  const seenFindings = new Set<string>();

  for (const violation of violations) {
    if (!allowedRules.has(violation.ruleKey)) {
      throw new Error(
        `Code result rule "${violation.ruleKey}" is not owned by the originating batch`,
      );
    }

    const ranges = allowedSources.get(violation.filePath);
    if (!ranges) {
      throw new Error(
        `Code result source "${violation.filePath}" is not owned by the originating batch`,
      );
    }

    const rangeIsOwned = violation.lineEnd >= violation.lineStart && ranges.some((range) =>
      ownership.tier === 'metadata'
        ? violation.lineStart === range.lineStart && violation.lineEnd === range.lineEnd
        : violation.lineStart >= range.lineStart && violation.lineEnd <= range.lineEnd,
    );
    if (!rangeIsOwned) {
      throw new Error(
        `Code result range ${violation.lineStart}-${violation.lineEnd} for "${violation.filePath}" is not owned by the originating batch`,
      );
    }

    const findingKey = `${violation.ruleKey}\0${violation.filePath}\0${violation.lineStart}\0${violation.lineEnd}\0${violation.title}`;
    if (seenFindings.has(findingKey)) {
      throw new Error('Code result cannot contain the same new finding more than once');
    }
    seenFindings.add(findingKey);
  }
}

function certifyNoPriorCodeCollision(
  ownership: PreparedCodeOwnership,
  newViolations: CodeViolationRaw[],
): void {
  const priorKeys = new Set(ownership.priorFindings.map((violation) =>
    ownership.tier === 'metadata'
      ? `${violation.ruleKey}\0${violation.filePath}\0${violation.title}`
      : `${violation.ruleKey}\0${violation.filePath}\0${violation.lineStart}\0${violation.lineEnd}\0${violation.title}`,
  ));

  for (const violation of newViolations) {
    const key = ownership.tier === 'metadata'
      ? `${violation.ruleKey}\0${violation.filePath}\0${violation.title}`
      : `${violation.ruleKey}\0${violation.filePath}\0${violation.lineStart}\0${violation.lineEnd}\0${violation.title}`;
    if (priorKeys.has(key)) {
      throw new Error(
        'Code lifecycle result cannot classify a previous finding and reintroduce the same finding as new',
      );
    }
  }
}

function certifyCodeLifecyclePartition(
  resolvedViolationIds: string[],
  unchangedViolationIds: string[],
  idMap: PromptIdMap,
): void {
  const expectedIds = new Set(idMap.keys());
  const classifiedIds = [...resolvedViolationIds, ...unchangedViolationIds];
  const classifiedSet = new Set(classifiedIds);
  const isExactPartition =
    classifiedIds.length === expectedIds.size &&
    classifiedSet.size === expectedIds.size &&
    classifiedIds.every((id) => expectedIds.has(id));

  if (!isExactPartition) {
    throw new Error(
      'Code lifecycle result must be an exact partition of the originating batch previous IDs',
    );
  }
}

export abstract class BaseCLIProvider implements LLMProvider {
  abstract get binaryName(): string;
  abstract get baseArgs(): string[];
  abstract get modelFlag(): string[];

  private maxRetries = config.claudeCodeMaxRetries ?? 2;
  private limit: LimitFunction = pLimit(config.claudeCodeMaxConcurrency);
  private debugDir: string | null = null;
  private callCounter = 0;
  private _analysisId: string | null = null;
  private _repoId: string | null = null;
  private _repoPath: string | null = null;
  private _abortSignal: AbortSignal | null = null;
  private _sessionLimitError: LlmSessionLimitError | null = null;
  private _sessionLimitHandler: ((error: LlmSessionLimitError) => void) | null = null;
  private _usageRecords: UsageRecord[] = [];
  /**
   * When set, LLM calls go through this transport (the agent file-mailbox)
   * instead of spawning the CLI. Lets `analyze` run LLM rules headless — no
   * `claude` binary, no API key (see @truecourse/shared/llm).
   */
  protected transport?: LlmTransport;

  setAnalysisId(id: string): void {
    this._analysisId = id;
    this._usageRecords = [];
    this._sessionLimitError = null;
  }

  setAbortSignal(signal: AbortSignal): void {
    this._abortSignal = signal;
  }

  setSessionLimitHandler(handler: (error: LlmSessionLimitError) => void): void {
    this._sessionLimitHandler = handler;
  }

  /** Set repoId for child process tracking in the analysis registry. */
  setRepoId(repoId: string): void {
    this._repoId = repoId;
  }

  /** Set target repo path — used as cwd when spawning CLI so Read tool accesses the right files. */
  setRepoPath(path: string): void {
    this._repoPath = path;
  }

  flushUsage(): UsageData[] {
    if (this._usageRecords.length === 0) return [];
    const records = this._usageRecords.slice();
    this._usageRecords = [];
    return records;
  }

  private collectUsage(callType: string, cliUsage: CLIUsage | undefined, durationMs: number): void {
    if (!cliUsage) return;
    this._usageRecords.push({
      provider: 'claude-code',
      callType,
      inputTokens: cliUsage.inputTokens,
      outputTokens: cliUsage.outputTokens,
      cacheReadTokens: cliUsage.cacheReadTokens,
      cacheWriteTokens: cliUsage.cacheWriteTokens,
      totalTokens: cliUsage.totalTokens,
      costUsd: cliUsage.costUsd,
      durationMs,
    });
  }

  constructor(transport?: LlmTransport) {
    this.transport = transport;
    if (process.env.TRUECOURSE_CLI_DEBUG) {
      this.debugDir = join(tmpdir(), 'truecourse-cli-debug');
      mkdirSync(this.debugDir, { recursive: true });
      log.info(`[CLI] Debug output: ${this.debugDir}`);
    }
  }

  /** Write input prompt, schema, and raw output to debug files. */
  private dumpDebug(label: string, prompt: string, rawOutput: string, jsonSchema?: string) {
    if (!this.debugDir) return;
    const n = String(++this.callCounter).padStart(2, '0');
    const prefix = join(this.debugDir, `${n}-${label}`);
    writeFileSync(`${prefix}-input.txt`, prompt, 'utf-8');
    writeFileSync(`${prefix}-output.json`, rawOutput, 'utf-8');
    if (jsonSchema) writeFileSync(`${prefix}-schema.json`, jsonSchema, 'utf-8');
  }

  /** Strip nesting guard env vars so subprocess doesn't detect parent Claude Code. */
  protected getCleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE_CODE') || key.startsWith('CLAUDE_INTERNAL')) {
        delete env[key];
      }
    }
    return env;
  }

  /** Convert a Zod schema to JSON Schema string for --json-schema flag. */
  protected toJsonSchema(schema: ZodType): string {
    return serializePreparedRequestSchema(schema);
  }

  /** Spawn CLI subprocess, pipe prompt via stdin, collect stdout. */
  protected spawnCLI(prompt: string, jsonSchemaStr: string, opts?: SpawnOptions & { label?: string }): Promise<string> {
    // Check if already aborted before spawning
    if (this._abortSignal?.aborted) {
      return Promise.reject(new DOMException('Analysis cancelled', 'AbortError'));
    }

    const timeout = opts?.timeoutMs ?? config.claudeCodeTimeoutMs ?? 120_000;
    const label = opts?.label ?? 'call';

    // Agent transport: hand the prompt + schema to the mailbox instead of
    // spawning the CLI. The answer is the raw JSON the model produced; wrap it
    // as a `{ result }` envelope so `parseAndValidate` extracts + Zod-validates
    // it exactly as it does for the CLI's `result` field.
    if (this.transport) {
      return this.transport({
        id: opts?.id,
        workId: opts?.workId,
        inputFingerprint: opts?.inputFingerprint,
        stage: opts?.stage ?? `analyze.${label}`,
        user: prompt,
        system: opts?.system ?? '',
        schema: jsonSchemaStr,
        responseFormat: opts?.responseFormat ?? 'json',
        model: this.modelFlag[1],
        timeoutMs: timeout,
      }).then((text) => JSON.stringify({ result: text }));
    }

    const args = [
      ...this.baseArgs,
      ...this.modelFlag,
      '--json-schema', jsonSchemaStr,
      ...(opts?.extraArgs ?? []),
    ];

    return new Promise((resolve, reject) => {
      // cross-spawn handles Windows `.cmd`/`.ps1` shim resolution without
      // shell:true, avoiding the CVE-2024-27980 spawn restriction and the
      // DEP0190 deprecation for shell:true + args array.
      const child: ChildProcess = spawn(this.binaryName, args, {
        env: this.getCleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this._repoPath ? { cwd: this._repoPath } : {}),
      });

      // Register child process for cancellation tracking
      if (this._repoId) {
        registerChildProcess(this._repoId, child);
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeout);

      // Listen for abort signal to kill the subprocess
      const onAbort = () => {
        aborted = true;
        clearTimeout(timer);
        if (!child.killed) child.kill('SIGTERM');
      };
      this._abortSignal?.addEventListener('abort', onAbort, { once: true });

      child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        this._abortSignal?.removeEventListener('abort', onAbort);
        if (this._repoId) unregisterChildProcess(this._repoId, child);

        if (aborted) {
          reject(new DOMException('Analysis cancelled', 'AbortError'));
          return;
        }
        if (timedOut) {
          reject(new Error(`[CLI] ${label} timed out after ${timeout}ms`));
          return;
        }
        if (code !== 0) {
          const sessionLimit =
            parseLlmSessionLimitError(stdout) ?? parseLlmSessionLimitError(stderr);
          if (sessionLimit) {
            reject(sessionLimit);
            return;
          }
          const detail = stderr.trim() || stdout.trim().slice(0, 500);
          reject(new Error(`[CLI] ${this.binaryName} exited with code ${code}: ${detail}`));
          return;
        }
        resolve(stdout);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this._abortSignal?.removeEventListener('abort', onAbort);
        if (this._repoId) unregisterChildProcess(this._repoId, child);
        reject(new Error(`[CLI] Failed to spawn ${this.binaryName}: ${err.message}`));
      });

      // Pipe prompt via stdin. Guard against the child having already exited
      // (early auth/crash failure): a write to a closed pipe emits an 'error' on
      // the stdin stream, which without a listener is an unhandled event that
      // crashes the whole process instead of surfacing via the 'close' handler
      // above. The prompt routinely exceeds the OS pipe buffer (~64 KB), so this
      // is a real path, not a corner case (same defect class as issue #658).
      child.stdin!.on('error', () => {});
      try {
        child.stdin!.write(prompt);
        child.stdin!.end();
      } catch {
        // Child already gone; the 'close'/'error' handlers above reject with the cause.
      }
    });
  }

  /** Extract usage data from CLI JSON envelope if present. */
  private extractCLIUsage(parsed: Record<string, unknown>): CLIUsage | undefined {
    const usage = parsed.usage as Record<string, number> | undefined;
    if (!usage) return undefined;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const costRaw = parsed.total_cost_usd;
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: input + output,
      costUsd: costRaw != null ? String(costRaw) : undefined,
    };
  }

  /**
   * Parse CLI output (--output-format json + --json-schema) and validate with Zod.
   * The response is a JSON envelope with structured_output containing validated data.
   */
  protected parseAndValidate<T>(raw: string, schema: ZodType<T>): { data: T; usage?: CLIUsage } {
    return this.parseAndValidatePrepared(raw, (value) => schema.parse(value));
  }

  private parseAndValidatePrepared<T>(
    raw: string,
    parse: (value: unknown) => T,
  ): { data: T; usage?: CLIUsage } {
    const parsed = JSON.parse(raw.trim());
    const usage = this.extractCLIUsage(parsed);

    if (parsed.is_error) {
      const sessionLimit = parseLlmSessionLimitError(parsed);
      if (sessionLimit) throw sessionLimit;
      throw new Error(`[CLI] Agent returned error: ${parsed.result || parsed.subtype}`);
    }

    if (parsed.structured_output) {
      return { data: parse(parsed.structured_output), usage };
    }

    // Fallback: try parsing the result field as JSON
    if (parsed.result) {
      const data = typeof parsed.result === 'string' ? JSON.parse(parsed.result) : parsed.result;
      return { data: parse(data), usage };
    }

    throw new Error(`[CLI] No structured_output in response (subtype: ${parsed.subtype})`);
  }

  /** Spawn CLI with retry on parse/validation failure. */
  protected async spawnAndParse<T>(
    prompt: string,
    schema: ZodType<T>,
    opts?: SpawnOptions & { label?: string },
  ): Promise<{ data: T; usage?: CLIUsage }> {
    return this.spawnPreparedAndParse({
      stage: `analyze.${opts?.label ?? 'call'}`,
      system: '',
      prompt,
      schemaJson: this.toJsonSchema(schema),
      responseFormat: 'json',
      parse: (value) => schema.parse(value),
    }, opts);
  }

  private async spawnPreparedAndParse<T>(
    request: Pick<
      PreparedLlmRequest<T>,
      'stage' | 'system' | 'prompt' | 'schemaJson' | 'responseFormat' | 'parse'
    >,
    opts?: SpawnOptions & { label?: string },
  ): Promise<{ data: T; usage?: CLIUsage }> {
    // Cap concurrent CLI spawns across all callers on this provider.
    // The limit runs the inner fn only when a slot is free, so timeout
    // timers (inside spawnCLI) can't start while the task is queued.
    return this.limit(async () => {
      if (this._abortSignal?.aborted) {
        throw this._abortSignal.reason ?? new DOMException('Analysis cancelled', 'AbortError');
      }
      if (this._sessionLimitError) throw this._sessionLimitError;
      opts?.onStart?.();

      const jsonSchemaStr = request.schemaJson;
      const label = opts?.label ?? 'call';
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const raw = await this.spawnCLI(request.prompt, jsonSchemaStr, {
            ...opts,
            stage: request.stage,
            system: request.system,
            responseFormat: request.responseFormat,
          });
          this.dumpDebug(label, request.prompt, raw, jsonSchemaStr);
          return this.parseAndValidatePrepared(raw, request.parse);
        } catch (err) {
          lastError = err as Error;
          if (this._abortSignal?.aborted) throw lastError; // don't retry on cancel
          const sessionLimit = isLlmSessionLimitError(lastError)
            ? lastError
            : parseLlmSessionLimitError(lastError);
          if (sessionLimit) {
            if (!this._sessionLimitError) {
              this._sessionLimitError = sessionLimit;
              log.warn(`[CLI] ${sessionLimit.message} Queued LLM calls will be stopped.`);
              try {
                this._sessionLimitHandler?.(sessionLimit);
              } catch (handlerError) {
                log.warn(
                  `[CLI] Session-limit notification failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
                );
              }
            }
            throw this._sessionLimitError;
          }
          // Another admitted call may have opened the provider-wide circuit
          // while this call was awaiting a generic failure. Do not start a
          // retry after that terminal state is known.
          if (this._sessionLimitError) throw this._sessionLimitError;
          if (attempt < this.maxRetries) {
            log.warn(`[CLI] Attempt ${attempt + 1} failed, retrying... (${lastError.message})`);
          }
        }
      }

      throw lastError!;
    });
  }

  // ---------------------------------------------------------------------------
  // LLMProvider implementation
  // ---------------------------------------------------------------------------

  private async executePreparedViolationWork<T>(options: {
    callType: string;
    attemptIdPrefix: string;
    workId: string;
    inputFingerprint: string;
    request: Pick<
      PreparedLlmRequest<T>,
      'stage' | 'system' | 'prompt' | 'schemaJson' | 'responseFormat' | 'parse'
    > & { readonly label: string; readonly timeoutMs: number };
    extraArgs: string[];
    startMessage: string;
    accept?: (result: T) => void;
    doneMessage: (result: T, durationMs: number) => string;
    onStart?: () => void;
  }): Promise<T> {
    log.info(options.startMessage);
    const t0 = Date.now();
    const { data, usage: cliUsage } = await this.spawnPreparedAndParse(options.request, {
      id: `${options.attemptIdPrefix}:${randomUUID()}`,
      workId: options.workId,
      inputFingerprint: options.inputFingerprint,
      extraArgs: options.extraArgs,
      label: options.request.label,
      timeoutMs: options.request.timeoutMs,
      onStart: options.onStart,
    });
    options.accept?.(data);
    const dur = Date.now() - t0;
    log.info(options.doneMessage(data, dur));
    this.collectUsage(options.callType, cliUsage, dur);
    return data;
  }

  /** Execute one already-planned service request without rebuilding its source context. */
  protected executePlannedServiceViolationWork(
    planned: PlannedServiceViolationWork<PreparedNormalServiceViolationRequest>,
    opts?: { onStart?: () => void },
  ): Promise<ServiceViolationOutput>;
  protected executePlannedServiceViolationWork(
    planned: PlannedServiceViolationWork<PreparedLifecycleServiceViolationRequest>,
    opts?: { onStart?: () => void },
  ): Promise<ServiceLifecycleViolationOutput>;
  protected executePlannedServiceViolationWork(
    planned: PlannedServiceViolationWork,
    opts?: { onStart?: () => void },
  ): Promise<ServiceViolationOutput | ServiceLifecycleViolationOutput>;
  protected async executePlannedServiceViolationWork(
    planned: PlannedServiceViolationWork,
    opts?: { onStart?: () => void },
  ): Promise<ServiceViolationOutput | ServiceLifecycleViolationOutput> {
    const request = planned.request;

    if (request.resultContractId === 'analyze.service-lifecycle@1') {
      return this.executePreparedViolationWork({
        callType: 'service',
        attemptIdPrefix: 'llm.service.attempt',
        workId: planned.workId,
        inputFingerprint: planned.inputFingerprint,
        request,
        extraArgs: ['--tools', ''],
        startMessage: '[CLI] Lifecycle service call starting...',
        doneMessage: (result, dur) =>
          `[CLI] Lifecycle service call done in ${dur}ms — resolved: ${result.resolvedViolationIds.length}, new: ${result.newViolations.length}`,
        onStart: opts?.onStart,
      });
    }
    return this.executePreparedViolationWork({
      callType: 'service',
      attemptIdPrefix: 'llm.service.attempt',
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      request,
      extraArgs: ['--tools', ''],
      startMessage: '[CLI] Service violations call starting...',
      doneMessage: (result, dur) =>
        `[CLI] Service violations call done in ${dur}ms — ${result.violations.length} violations`,
      onStart: opts?.onStart,
    });
  }

  /** Execute one already-planned database request without rebuilding its source context. */
  protected executePlannedDatabaseViolationWork(
    planned: PlannedDatabaseViolationWork<PreparedNormalDatabaseViolationRequest>,
    opts?: { onStart?: () => void },
  ): Promise<DatabaseViolationOutput>;
  protected executePlannedDatabaseViolationWork(
    planned: PlannedDatabaseViolationWork<PreparedLifecycleDatabaseViolationRequest>,
    opts?: { onStart?: () => void },
  ): Promise<DatabaseLifecycleViolationOutput>;
  protected executePlannedDatabaseViolationWork(
    planned: PlannedDatabaseViolationWork,
    opts?: { onStart?: () => void },
  ): Promise<DatabaseViolationOutput | DatabaseLifecycleViolationOutput>;
  protected async executePlannedDatabaseViolationWork(
    planned: PlannedDatabaseViolationWork,
    opts?: { onStart?: () => void },
  ): Promise<DatabaseViolationOutput | DatabaseLifecycleViolationOutput> {
    const request = planned.request;
    if (request.resultContractId === 'analyze.database-lifecycle@1') {
      return this.executePreparedViolationWork({
        callType: 'database',
        attemptIdPrefix: 'llm.database.attempt',
        workId: planned.workId,
        inputFingerprint: planned.inputFingerprint,
        request,
        extraArgs: ['--tools', ''],
        startMessage: '[CLI] Lifecycle database call starting...',
        doneMessage: (result, dur) =>
          `[CLI] Lifecycle database call done in ${dur}ms — resolved: ${result.resolvedViolationIds.length}, new: ${result.newViolations.length}`,
        onStart: opts?.onStart,
      });
    }
    return this.executePreparedViolationWork({
      callType: 'database',
      attemptIdPrefix: 'llm.database.attempt',
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      request,
      extraArgs: ['--tools', ''],
      startMessage: '[CLI] Database violations call starting...',
      doneMessage: (result, dur) =>
        `[CLI] Database violations call done in ${dur}ms — ${result.violations.length} violations`,
      onStart: opts?.onStart,
    });
  }

  /** Execute one already-planned module request without rebuilding its source context. */
  protected executePlannedModuleViolationWork(
    planned: PlannedModuleViolationWork<PreparedNormalModuleViolationRequest>,
    opts?: { onStart?: () => void },
  ): Promise<ModuleViolationOutput>;
  protected executePlannedModuleViolationWork(
    planned: PlannedModuleViolationWork<PreparedLifecycleModuleViolationRequest>,
    opts?: { onStart?: () => void },
  ): Promise<ModuleLifecycleViolationOutput>;
  protected executePlannedModuleViolationWork(
    planned: PlannedModuleViolationWork,
    opts?: { onStart?: () => void },
  ): Promise<ModuleViolationOutput | ModuleLifecycleViolationOutput>;
  protected async executePlannedModuleViolationWork(
    planned: PlannedModuleViolationWork,
    opts?: { onStart?: () => void },
  ): Promise<ModuleViolationOutput | ModuleLifecycleViolationOutput> {
    const request = planned.request;
    if (request.resultContractId === 'analyze.module-lifecycle@1') {
      return this.executePreparedViolationWork({
        callType: 'module',
        attemptIdPrefix: 'llm.module.attempt',
        workId: planned.workId,
        inputFingerprint: planned.inputFingerprint,
        request,
        extraArgs: ['--tools', ''],
        startMessage: '[CLI] Lifecycle module call starting...',
        doneMessage: (result, dur) =>
          `[CLI] Lifecycle module call done in ${dur}ms — resolved: ${result.resolvedViolationIds.length}, new: ${result.newViolations.length}`,
        onStart: opts?.onStart,
      });
    }
    return this.executePreparedViolationWork({
      callType: 'module',
      attemptIdPrefix: 'llm.module.attempt',
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      request,
      extraArgs: ['--tools', ''],
      startMessage: `[CLI] Module violations call starting (${request.ownership.moduleNames.length} modules)...`,
      doneMessage: (result, dur) =>
        `[CLI] Module violations call done in ${dur}ms — ${result.violations.length} violations`,
      onStart: opts?.onStart,
    });
  }

  /** Execute and certify one already-planned code request without rebuilding its source context. */
  protected async executePlannedCodeViolationWork(
    planned: PlannedCodeViolationWork,
    opts?: { onStart?: () => void },
  ): Promise<CodeViolationOutput | CodeViolationLifecycleOutput> {
    const request = planned.request;
    const codeExtraArgs = request.toolPolicy === 'read'
      ? ['--allowedTools', 'Read']
      : ['--tools', ''];
    if (request.resultContractId === 'analyze.code-lifecycle@1') {
      const idMap = new Map(request.bindings.map(({ promptId, runtimeId }) => [promptId, runtimeId]));
      return this.executePreparedViolationWork({
        callType: 'code',
        attemptIdPrefix: 'llm.code.attempt',
        workId: planned.workId,
        inputFingerprint: planned.inputFingerprint,
        request,
        extraArgs: codeExtraArgs,
        startMessage: `[CLI] Code violations call starting (${request.ownership.fileCount} files, lifecycle)...`,
        accept: (result) => {
          certifyCodeResultOwnership(request.ownership, result.newViolations);
          certifyCodeLifecyclePartition(
            result.resolvedViolationIds,
            result.unchangedViolationIds,
            idMap,
          );
          certifyNoPriorCodeCollision(request.ownership, result.newViolations);
        },
        doneMessage: (result, dur) =>
          `[CLI] Code violations call done in ${dur}ms — new: ${result.newViolations.length}, resolved: ${result.resolvedViolationIds.length}, unchanged: ${result.unchangedViolationIds.length}`,
        onStart: opts?.onStart,
      });
    }
    return this.executePreparedViolationWork({
      callType: 'code',
      attemptIdPrefix: 'llm.code.attempt',
      workId: planned.workId,
      inputFingerprint: planned.inputFingerprint,
      request,
      extraArgs: codeExtraArgs,
      startMessage: `[CLI] Code violations call starting (${request.ownership.fileCount} files, first-run)...`,
      accept: (result) => certifyCodeResultOwnership(request.ownership, result.violations),
      doneMessage: (result, dur) =>
        `[CLI] Code violations call done in ${dur}ms — ${result.violations.length} violations`,
      onStart: opts?.onStart,
    });
  }

  async generateServiceViolations(
    context: ServiceViolationContext,
    opts?: { onStart?: () => void },
  ): Promise<ServiceViolationsResult> {
    const planned = planServiceViolationWork(context, 'normal', {
      provider: this.transport ? 'transport:unverified' : 'claude-code',
      requestedModel: this.modelFlag[1] ?? null,
    });
    const request = planned.request;
    const idMap = new Map(request.bindings.map(({ promptId, runtimeId }) => [promptId, runtimeId]));

    const object = await this.executePlannedServiceViolationWork(planned, opts);

    return {
      violations: object.violations.map((v) => ({
        id: randomUUID(),
        type: v.type,
        category: 'rule' as const,
        title: v.title,
        content: v.content,
        severity: v.severity,
        targetServiceId: resolveId(v.targetServiceId, idMap) ?? undefined,
        fixPrompt: v.fixPrompt ?? undefined,
        ruleKey: v.ruleKey ?? undefined,
        createdAt: new Date().toISOString(),
      })),
      serviceDescriptions: object.serviceDescriptions.map((d) => ({
        id: resolveId(d.id, idMap) || d.id,
        description: d.description,
      })),
    };
  }

  async generateDatabaseViolations(
    context: DatabaseViolationContext,
    opts?: { onStart?: () => void },
  ): Promise<DatabaseViolationsResult> {
    const planned = planDatabaseViolationWork(context, 'normal', {
      provider: this.transport ? 'transport:unverified' : 'claude-code',
      requestedModel: this.modelFlag[1] ?? null,
    });
    const request = planned.request;
    const idMap = new Map(request.bindings.map(({ promptId, runtimeId }) => [promptId, runtimeId]));
    const object = await this.executePlannedDatabaseViolationWork(planned, opts);

    return {
      violations: object.violations.map((v) => ({
        id: randomUUID(),
        type: v.type,
        category: 'rule' as const,
        title: v.title,
        content: v.content,
        severity: v.severity,
        targetDatabaseId: resolveId(v.targetDatabaseId, idMap) ?? undefined,
        targetTable: v.targetTable ?? undefined,
        fixPrompt: v.fixPrompt ?? undefined,
        ruleKey: v.ruleKey ?? undefined,
        createdAt: new Date().toISOString(),
      })),
    };
  }

  async generateDatabaseViolationsWithLifecycle(
    context: DatabaseViolationContext,
    opts?: { onStart?: () => void },
  ): Promise<DatabaseViolationsLifecycleResult> {
    const planned = planDatabaseViolationWork(context, 'lifecycle', {
      provider: this.transport ? 'transport:unverified' : 'claude-code',
      requestedModel: this.modelFlag[1] ?? null,
    });
    const request = planned.request;
    const idMap = new Map(request.bindings.map(({ promptId, runtimeId }) => [promptId, runtimeId]));
    const object = await this.executePlannedDatabaseViolationWork(planned, opts);

    return {
      resolvedViolationIds: resolveIds(object.resolvedViolationIds, idMap),
      unchangedViolationIds: resolveIds(object.unchangedViolationIds, idMap),
      newViolations: object.newViolations.map((violation) => ({
        ...violation,
        targetDatabaseId: violation.targetDatabaseId?.startsWith('db-')
          ? idMap.get(violation.targetDatabaseId) ?? null
          : null,
      })),
    };
  }

  async generateModuleViolations(
    context: ModuleViolationContext,
    opts?: { onStart?: () => void },
  ): Promise<ModuleViolationsResult> {
    const planned = planModuleViolationWork(context, 'normal', {
      provider: this.transport ? 'transport:unverified' : 'claude-code',
      requestedModel: this.modelFlag[1] ?? null,
    });
    const request = planned.request;
    const idMap = new Map(request.bindings.map(({ promptId, runtimeId }) => [promptId, runtimeId]));
    const moduleIdToServiceId = new Map(
      request.moduleServiceBindings.map(({ moduleRuntimeId, serviceRuntimeId }) =>
        [moduleRuntimeId, serviceRuntimeId]),
    );

    const object = await this.executePlannedModuleViolationWork(planned, opts);

    return {
      violations: object.violations.map((v) => {
        const targetModuleId = resolveId(v.targetModuleId, idMap) ?? undefined;
        const targetServiceId = targetModuleId ? moduleIdToServiceId.get(targetModuleId) : undefined;
        return {
          id: randomUUID(),
          type: v.type,
          category: 'rule' as const,
          title: v.title,
          content: v.content,
          severity: v.severity,
          targetServiceId,
          targetModuleId,
          targetMethodId: resolveId(v.targetMethodId, idMap) ?? undefined,
          fixPrompt: v.fixPrompt ?? undefined,
          ruleKey: v.ruleKey ?? undefined,
          createdAt: new Date().toISOString(),
        };
      }),
    };
  }

  async generateAllViolations(contexts: AllViolationsInput): Promise<AllViolationsResult> {
    const onStepComplete = contexts.onStepComplete;
    const onCallStart = contexts.onCallStart;
    const onCallDone = contexts.onCallDone;
    const promises: [string, Promise<unknown>][] = [];

    if (contexts.service) {
      promises.push(['service', this.generateServiceViolations(contexts.service, {
        onStart: () => onCallStart?.('service'),
      })]);
    }
    if (contexts.database) {
      promises.push(['database', this.generateDatabaseViolations(contexts.database, {
        onStart: () => onCallStart?.('database'),
      })]);
    }
    if (contexts.module) {
      promises.push(['module', this.generateModuleViolations(contexts.module, {
        onStart: () => onCallStart?.('module'),
      })]);
    }

    const stepLabels: Record<string, string> = {
      service: 'Service architecture checks done',
      database: 'Database schema checks done',
      module: 'Module & function checks done',
    };

    const settled = await Promise.allSettled(promises.map(([key, p]) =>
      p.then(
        (v) => { onStepComplete?.(stepLabels[key] || `${key} done`); onCallDone?.(key as 'service' | 'database' | 'module', true); return v; },
        (err) => { onCallDone?.(key as 'service' | 'database' | 'module', false); throw err; },
      )
    ));

    const sessionLimit = settled.find(
      (outcome) => outcome.status === 'rejected' && isLlmSessionLimitError(outcome.reason),
    );
    if (sessionLimit?.status === 'rejected') throw sessionLimit.reason;

    const result: AllViolationsResult = {};
    for (let i = 0; i < promises.length; i++) {
      const [key] = promises[i];
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        (result as Record<string, unknown>)[key] = outcome.value;
      } else {
        log.info(`[CLI Violations] ${key} call failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
      }
    }

    return result;
  }

  async generateAllViolationsWithLifecycle(
    contexts: AllViolationsInput,
    onStepComplete?: (step: string) => void,
  ): Promise<AllViolationsLifecycleResult> {
    const onCallStart = contexts.onCallStart;
    const allResolved: string[] = [];
    const allUnchanged: string[] = [];
    const allNew: DiffViolationItem[] = [];
    let serviceDescriptions: ServiceDescription[] = [];

    const promises: [string, Promise<unknown>][] = [];
    const idMaps: Record<string, PromptIdMap> = {};

    // Service call
    if (contexts.service) {
      const ctx = contexts.service;
      if (ctx.existingViolations && ctx.existingViolations.length > 0) {
        promises.push(['service', (async () => {
          const planned = planServiceViolationWork(ctx, 'lifecycle', {
            provider: this.transport ? 'transport:unverified' : 'claude-code',
            requestedModel: this.modelFlag[1] ?? null,
          });
          const request = planned.request;
          const idMap = new Map(request.bindings.map(({ promptId, runtimeId }) => [promptId, runtimeId]));
          idMaps.service = idMap;
          return this.executePlannedServiceViolationWork(planned, {
            onStart: () => onCallStart?.('service'),
          });
        })()]);
      } else {
        promises.push(['service-normal', this.generateServiceViolations(ctx, {
          onStart: () => onCallStart?.('service'),
        })]);
      }
    }

    // Database call
    if (contexts.database) {
      const ctx = contexts.database;
      if (ctx.existingViolations && ctx.existingViolations.length > 0) {
        promises.push(['database', this.generateDatabaseViolationsWithLifecycle(ctx, {
          onStart: () => onCallStart?.('database'),
        })]);
      } else {
        promises.push(['database-normal', this.generateDatabaseViolations(ctx, {
          onStart: () => onCallStart?.('database'),
        })]);
      }
    }

    // Module call
    if (contexts.module) {
      const ctx = contexts.module;
      if (ctx.existingViolations && ctx.existingViolations.length > 0) {
        promises.push(['module', (async () => {
          const planned = planModuleViolationWork(ctx, 'lifecycle', {
            provider: this.transport ? 'transport:unverified' : 'claude-code',
            requestedModel: this.modelFlag[1] ?? null,
          });
          const request = planned.request;
          const idMap = new Map(request.bindings.map(({ promptId, runtimeId }) => [promptId, runtimeId]));
          const moduleIdToServiceId = new Map(
            request.moduleServiceBindings.map(({ moduleRuntimeId, serviceRuntimeId }) =>
              [moduleRuntimeId, serviceRuntimeId]),
          );
          const object = await this.executePlannedModuleViolationWork(planned, {
            onStart: () => onCallStart?.('module'),
          });
          return {
            resolvedViolationIds: resolveIds(object.resolvedViolationIds, idMap),
            unchangedViolationIds: resolveIds(object.unchangedViolationIds, idMap),
            newViolations: object.newViolations.map((i) => {
              const realModuleId = resolveId(i.targetModuleId, idMap);
              return {
                ...i,
                targetServiceId: (realModuleId ? moduleIdToServiceId.get(realModuleId) : null) ?? null,
                targetModuleId: realModuleId ?? null,
                targetMethodId: resolveId(i.targetMethodId, idMap) ?? null,
                targetModuleName: i.targetModuleName ?? null,
                targetMethodName: i.targetMethodName ?? null,
              };
            }),
          };
        })()]);
      } else {
        promises.push(['module-normal', this.generateModuleViolations(ctx, {
          onStart: () => onCallStart?.('module'),
        })]);
      }
    }

    const stepLabels: Record<string, string> = {
      service: 'Service checks done',
      'service-normal': 'Service checks done',
      database: 'Database checks done',
      'database-normal': 'Database checks done',
      module: 'Module checks done',
      'module-normal': 'Module checks done',
    };
    const baseKey = (key: string) => key.replace('-normal', '') as 'service' | 'database' | 'module';
    const onCallDone = contexts.onCallDone;

    const settled = await Promise.allSettled(promises.map(([key, p]) =>
      p.then(
        (v) => { onStepComplete?.(stepLabels[key] || `${key} done`); onCallDone?.(baseKey(key), true); return v; },
        (err) => { onCallDone?.(baseKey(key), false); throw err; },
      )
    ));

    const sessionLimit = settled.find(
      (outcome) => outcome.status === 'rejected' && isLlmSessionLimitError(outcome.reason),
    );
    if (sessionLimit?.status === 'rejected') throw sessionLimit.reason;

    for (let i = 0; i < promises.length; i++) {
      const [key] = promises[i];
      const outcome = settled[i];
      if (outcome.status !== 'fulfilled') {
        log.info(`[CLI ViolationsLifecycle] ${key} call failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
        continue;
      }

      if (key === 'service') {
        const idMap = idMaps.service;
        const result = outcome.value as { resolvedViolationIds: string[]; unchangedViolationIds: string[]; newViolations: DiffViolationItem[]; serviceDescriptions: ServiceDescription[] };
        allResolved.push(...resolveIds(result.resolvedViolationIds, idMap));
        allUnchanged.push(...resolveIds(result.unchangedViolationIds, idMap));
        allNew.push(...result.newViolations.map((v) => ({
          ...v,
          targetServiceId: resolveId(v.targetServiceId, idMap) ?? null,
          targetModuleId: v.targetModuleId ?? null,
          targetMethodId: v.targetMethodId ?? null,
          targetServiceName: v.targetServiceName ?? null,
          targetModuleName: v.targetModuleName ?? null,
          targetMethodName: v.targetMethodName ?? null,
        })));
        serviceDescriptions = result.serviceDescriptions.map((d) => ({
          id: resolveId(d.id, idMap) || d.id,
          description: d.description,
        }));
      } else if (key === 'service-normal') {
        const result = outcome.value as ServiceViolationsResult;
        serviceDescriptions = result.serviceDescriptions;
        for (const v of result.violations) {
          allNew.push({
            type: v.type, title: v.title, content: v.content, severity: v.severity,
            targetServiceId: v.targetServiceId ?? null, targetModuleId: v.targetModuleId ?? null,
            targetMethodId: v.targetMethodId ?? null, targetServiceName: null,
            targetModuleName: null, targetMethodName: null, fixPrompt: v.fixPrompt ?? null,
            ruleKey: (v as Violation).ruleKey || 'unknown',
          });
        }
      } else if (key === 'database') {
        const result = outcome.value as DatabaseViolationsLifecycleResult;
        allResolved.push(...result.resolvedViolationIds);
        allUnchanged.push(...result.unchangedViolationIds);
        allNew.push(...result.newViolations.map((v) => ({
          ...v,
          targetServiceId: null,
          targetDatabaseId: v.targetDatabaseId,
          targetModuleId: null,
          targetMethodId: null,
          targetTable: v.targetTable ?? null,
          targetServiceName: null,
          targetModuleName: null,
          targetMethodName: null,
        })));
      } else if (key === 'module') {
        const result = outcome.value as DiffViolationsResult;
        allResolved.push(...result.resolvedViolationIds);
        allUnchanged.push(...result.unchangedViolationIds);
        allNew.push(...result.newViolations.map((v) => ({
          ...v,
          targetServiceId: v.targetServiceId ?? null,
          targetModuleId: v.targetModuleId ?? null,
          targetMethodId: v.targetMethodId ?? null,
          targetServiceName: v.targetServiceName ?? null,
          targetModuleName: v.targetModuleName ?? null,
          targetMethodName: v.targetMethodName ?? null,
        })));
      } else {
        const result = outcome.value as DatabaseViolationsResult | ModuleViolationsResult;
        for (const v of result.violations) {
          allNew.push({
            type: v.type, title: v.title, content: v.content, severity: v.severity,
            targetServiceId: (v as Violation).targetServiceId ?? null,
            targetModuleId: (v as Violation).targetModuleId ?? null,
            targetMethodId: (v as Violation).targetMethodId ?? null,
            targetServiceName: null, targetModuleName: null, targetMethodName: null,
            fixPrompt: (v as Violation).fixPrompt ?? null,
            ruleKey: (v as Violation).ruleKey || 'unknown',
          });
        }
      }
    }

    return {
      resolvedViolationIds: allResolved,
      unchangedViolationIds: allUnchanged,
      newViolations: allNew,
      serviceDescriptions,
    };
  }

  async generateCodeViolations(
    context: CodeViolationContext,
    opts?: { onStart?: () => void },
  ): Promise<CodeViolationsResult> {
    const planned = planCodeViolationWork(context, {
      // An injected transport does not currently expose its served provider.
      // Keep that uncertainty explicit so future reuse fails closed until an
      // execution receipt can prove the provider/model that answered.
      provider: this.transport ? 'transport:unverified' : 'claude-code',
      requestedModel: this.modelFlag[1] ?? null,
      repositoryRoot: this._repoPath,
    });
    const request = planned.request;
    const idMap = new Map(request.bindings.map(({ promptId, runtimeId }) => [promptId, runtimeId]));
    const object = await this.executePlannedCodeViolationWork(planned, opts);

    if ('newViolations' in object) {
      return {
        violations: object.newViolations.map((v) => ({
          ruleKey: v.ruleKey,
          filePath: v.filePath,
          lineStart: v.lineStart,
          lineEnd: v.lineEnd,
          severity: v.severity,
          title: v.title,
          content: v.content,
          fixPrompt: v.fixPrompt ?? null,
          sourceTier: request.ownership.tier,
        })),
        resolvedViolationIds: resolveIds(object.resolvedViolationIds, idMap),
        unchangedViolationIds: resolveIds(object.unchangedViolationIds, idMap),
      };
    }

    return {
      violations: object.violations.map((v) => ({
        ruleKey: v.ruleKey,
        filePath: v.filePath,
        lineStart: v.lineStart,
        lineEnd: v.lineEnd,
        severity: v.severity,
        title: v.title,
        content: v.content,
        fixPrompt: v.fixPrompt ?? null,
        sourceTier: request.ownership.tier,
      })),
    };
  }

  async generateAllCodeViolations(batches: CodeViolationContext[]): Promise<CodeViolationsResult> {
    if (batches.length === 0) return { violations: [] };

    log.info(`[CLI] Code violations: ${batches.length} batch(es) starting...`);
    const t0 = Date.now();

    const results = await Promise.allSettled(
      batches.map((batch) => this.generateCodeViolations(batch))
    );

    const sessionLimit = results.find(
      (result) => result.status === 'rejected' && isLlmSessionLimitError(result.reason),
    );
    if (sessionLimit?.status === 'rejected') throw sessionLimit.reason;

    const allViolations: CodeViolationRaw[] = [];
    const allResolved: string[] = [];
    const allUnchanged: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allViolations.push(...result.value.violations);
        if (result.value.resolvedViolationIds) allResolved.push(...result.value.resolvedViolationIds);
        if (result.value.unchangedViolationIds) allUnchanged.push(...result.value.unchangedViolationIds);
      } else {
        log.info(`[CLI CodeViolations] Batch call failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }

    log.info(`[CLI] Code violations total: ${Date.now() - t0}ms — new: ${allViolations.length}, resolved: ${allResolved.length}, unchanged: ${allUnchanged.length}`);
    return {
      violations: allViolations,
      resolvedViolationIds: allResolved.length > 0 ? allResolved : undefined,
      unchangedViolationIds: allUnchanged.length > 0 ? allUnchanged : undefined,
    };
  }

  async enrichFlow(context: FlowEnrichmentContext): Promise<FlowEnrichmentResult> {
    const prompt = getPrompt('flow-enrichment', buildFlowTemplateVars(context));

    log.info(`[CLI] Flow enrichment call starting for ${context.flowName}...`);
    const t0 = Date.now();
    const { data: object, usage: cliUsage } = await this.spawnAndParse(prompt, FlowEnrichmentOutputSchema, {
      extraArgs: ['--tools', ''], label: 'flow',
    });
    const dur = Date.now() - t0;
    log.info(`[CLI] Flow enrichment done in ${dur}ms`);
    this.collectUsage('flow', cliUsage, dur);

    return {
      name: object.name,
      description: object.description,
      stepDescriptions: object.stepDescriptions,
    };
  }
}

// ---------------------------------------------------------------------------
// Claude Code provider
// ---------------------------------------------------------------------------

export class ClaudeCodeProvider extends BaseCLIProvider {
  /**
   * The model this run was told to use, from the analyze model picker.
   *
   * Undefined means "no explicit choice", in which case we fall back to
   * `CLAUDE_CODE_MODEL` and then to passing no `--model` at all — letting
   * Claude Code pick, which is the behavior that predates the picker.
   */
  private readonly selectedModel?: string;

  constructor(transport?: LlmTransport, selectedModel?: string) {
    super(transport);
    this.selectedModel = selectedModel;
  }

  get binaryName(): string {
    return config.claudeCodeBinary ?? 'claude';
  }

  get baseArgs(): string[] {
    return [
      '--print',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ];
  }

  get modelFlag(): string[] {
    // A picked model is a deliberate in-session choice, so it outranks the
    // CLAUDE_CODE_MODEL background default.
    const model = this.selectedModel || config.claudeCodeModel;
    return model ? ['--model', model] : [];
  }
}
