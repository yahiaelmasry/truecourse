import { config } from '../../config/index.js';
import type { ModuleViolationContext } from './provider.js';
import { buildModuleTemplateVars, getPrompt } from './prompts.js';
import {
  serializePreparedRequestSchema,
  type PreparedLlmRequest,
  type PreparedPromptBinding,
} from './prepared-request.js';
import {
  DiffViolationOutputSchema,
  ModuleViolationOutputSchema,
} from './schemas.js';

export interface PreparedModuleOwnership {
  readonly moduleNames: readonly string[];
  readonly methods: readonly {
    readonly moduleName: string;
    readonly name: string;
  }[];
  readonly ruleKeys: readonly string[];
  readonly priorFindings: readonly {
    readonly type: string;
    readonly title: string;
    readonly content: string;
    readonly severity: string;
  }[];
}

export interface PreparedModuleServiceBinding {
  readonly moduleRuntimeId: string;
  readonly serviceRuntimeId: string;
}

type ModuleViolationOutput = ReturnType<typeof ModuleViolationOutputSchema.parse>;
type ModuleLifecycleViolationOutput = ReturnType<typeof DiffViolationOutputSchema.parse>;

interface PreparedModuleRequestMetadata {
  readonly system: '';
  readonly responseFormat: 'json';
  readonly toolPolicy: 'none';
  readonly bindings: readonly PreparedPromptBinding[];
  readonly moduleServiceBindings: readonly PreparedModuleServiceBinding[];
  readonly ownership: PreparedModuleOwnership;
}

export type PreparedNormalModuleViolationRequest =
  PreparedLlmRequest<ModuleViolationOutput>
  & PreparedModuleRequestMetadata
  & {
    readonly stage: 'analyze.module';
    readonly label: 'module';
    readonly resultContractId: 'analyze.module@1';
    readonly timeoutMs: 300_000;
  };

export type PreparedLifecycleModuleViolationRequest =
  PreparedLlmRequest<ModuleLifecycleViolationOutput>
  & PreparedModuleRequestMetadata
  & {
    readonly stage: 'analyze.module-lifecycle';
    readonly label: 'module-lifecycle';
    readonly resultContractId: 'analyze.module-lifecycle@1';
  };

export type PreparedModuleViolationRequest =
  | PreparedNormalModuleViolationRequest
  | PreparedLifecycleModuleViolationRequest;

/** Capture every provider-independent input used by one module-check request. */
export function prepareModuleViolationRequest(
  context: ModuleViolationContext,
  mode: 'normal',
): PreparedNormalModuleViolationRequest;
export function prepareModuleViolationRequest(
  context: ModuleViolationContext,
  mode: 'lifecycle',
): PreparedLifecycleModuleViolationRequest;
export function prepareModuleViolationRequest(
  context: ModuleViolationContext,
  mode: 'normal' | 'lifecycle',
): PreparedModuleViolationRequest {
  const lifecycle = mode === 'lifecycle';
  const { vars, idMap } = buildModuleTemplateVars(context);
  const bindings = Object.freeze(
    [...idMap.entries()].map(([promptId, runtimeId]) =>
      Object.freeze({ promptId, runtimeId })),
  );
  const moduleServiceBindings = Object.freeze(context.modules
    .filter((module) => module.serviceId)
    .map((module) => Object.freeze({
      moduleRuntimeId: module.id,
      serviceRuntimeId: module.serviceId!,
    })));
  const ownership = Object.freeze({
    moduleNames: Object.freeze(context.modules.map((module) => module.name)),
    methods: Object.freeze(context.methods.map((method) => Object.freeze({
      moduleName: method.moduleName,
      name: method.name,
    }))),
    ruleKeys: Object.freeze(context.llmRules.map((rule) => rule.key)),
    priorFindings: Object.freeze((context.existingViolations ?? []).map((violation) => Object.freeze({
      type: violation.type,
      title: violation.title,
      content: violation.content,
      severity: violation.severity,
    }))),
  });
  const common = {
    system: '',
    prompt: getPrompt(
      lifecycle ? 'violations-module-lifecycle' : 'violations-module',
      vars,
    ),
    responseFormat: 'json',
    toolPolicy: 'none',
    bindings,
    moduleServiceBindings,
    ownership,
  } as const;

  if (lifecycle) {
    const parse = DiffViolationOutputSchema.parse.bind(DiffViolationOutputSchema);
    return Object.freeze({
      ...common,
      stage: 'analyze.module-lifecycle',
      label: 'module-lifecycle',
      schemaJson: serializePreparedRequestSchema(DiffViolationOutputSchema),
      resultContractId: 'analyze.module-lifecycle@1',
      timeoutMs: config.claudeCodeTimeoutMs,
      parse: Object.freeze((value: unknown) => parse(value)),
    });
  }

  const parse = ModuleViolationOutputSchema.parse.bind(ModuleViolationOutputSchema);
  return Object.freeze({
    ...common,
    stage: 'analyze.module',
    label: 'module',
    schemaJson: serializePreparedRequestSchema(ModuleViolationOutputSchema),
    resultContractId: 'analyze.module@1',
    timeoutMs: 300_000,
    parse: Object.freeze((value: unknown) => parse(value)),
  });
}
