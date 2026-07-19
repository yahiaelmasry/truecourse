import { config } from '../../config/index.js';
import type { ServiceViolationContext } from './provider.js';
import { buildServiceTemplateVars, getPrompt } from './prompts.js';
import {
  serializePreparedRequestSchema,
  type PreparedLlmRequest,
  type PreparedPromptBinding,
} from './prepared-request.js';
import {
  LifecycleServiceOutputSchema,
  ServiceViolationOutputSchema,
} from './schemas.js';

export interface PreparedServiceOwnership {
  readonly architecture: string;
  readonly serviceNames: readonly string[];
  readonly ruleKeys: readonly string[];
  readonly priorFindings: readonly {
    readonly type: string;
    readonly title: string;
    readonly content: string;
    readonly severity: string;
  }[];
}

export type ServiceViolationOutput = ReturnType<typeof ServiceViolationOutputSchema.parse>;
export type ServiceLifecycleViolationOutput = ReturnType<typeof LifecycleServiceOutputSchema.parse>;

interface PreparedServiceRequestMetadata {
  readonly system: '';
  readonly responseFormat: 'json';
  readonly toolPolicy: 'none';
  readonly bindings: readonly PreparedPromptBinding[];
  readonly ownership: PreparedServiceOwnership;
}

export type PreparedNormalServiceViolationRequest =
  PreparedLlmRequest<ServiceViolationOutput>
  & PreparedServiceRequestMetadata
  & {
    readonly stage: 'analyze.service';
    readonly label: 'service';
    readonly resultContractId: 'analyze.service@1';
  };

export type PreparedLifecycleServiceViolationRequest =
  PreparedLlmRequest<ServiceLifecycleViolationOutput>
  & PreparedServiceRequestMetadata
  & {
    readonly stage: 'analyze.service-lifecycle';
    readonly label: 'service-lifecycle';
    readonly resultContractId: 'analyze.service-lifecycle@1';
  };

export type PreparedServiceViolationRequest =
  | PreparedNormalServiceViolationRequest
  | PreparedLifecycleServiceViolationRequest;

/** Capture every provider-independent input used by one service-check request. */
export function prepareServiceViolationRequest(
  context: ServiceViolationContext,
  mode: 'normal',
): PreparedNormalServiceViolationRequest;
export function prepareServiceViolationRequest(
  context: ServiceViolationContext,
  mode: 'lifecycle',
): PreparedLifecycleServiceViolationRequest;
export function prepareServiceViolationRequest(
  context: ServiceViolationContext,
  mode: 'normal' | 'lifecycle',
): PreparedServiceViolationRequest {
  const lifecycle = mode === 'lifecycle';
  const { vars, idMap } = buildServiceTemplateVars(context);
  const bindings = Object.freeze(
    [...idMap.entries()].map(([promptId, runtimeId]) =>
      Object.freeze({ promptId, runtimeId })),
  );
  const ownership = Object.freeze({
    architecture: context.architecture,
    serviceNames: Object.freeze(context.services.map((service) => service.name)),
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
      lifecycle ? 'violations-service-lifecycle' : 'violations-service',
      vars,
    ),
    responseFormat: 'json',
    toolPolicy: 'none',
    timeoutMs: config.claudeCodeTimeoutMs,
    bindings,
    ownership,
  } as const;

  if (lifecycle) {
    const parse = LifecycleServiceOutputSchema.parse.bind(LifecycleServiceOutputSchema);
    return Object.freeze({
      ...common,
      stage: 'analyze.service-lifecycle',
      label: 'service-lifecycle',
      schemaJson: serializePreparedRequestSchema(LifecycleServiceOutputSchema),
      resultContractId: 'analyze.service-lifecycle@1',
      parse: Object.freeze((value: unknown) => parse(value)),
    });
  }

  const parse = ServiceViolationOutputSchema.parse.bind(ServiceViolationOutputSchema);
  return Object.freeze({
    ...common,
    stage: 'analyze.service',
    label: 'service',
    schemaJson: serializePreparedRequestSchema(ServiceViolationOutputSchema),
    resultContractId: 'analyze.service@1',
    parse: Object.freeze((value: unknown) => parse(value)),
  });
}
