import type { ServiceViolationContext } from './provider.js';
import {
  prepareServiceViolationRequest,
  type PreparedLifecycleServiceViolationRequest,
  type PreparedNormalServiceViolationRequest,
  type PreparedServiceViolationRequest,
} from './prepared-service-violation-request.js';
import {
  assertUniqueLlmIdentity,
  canonicalJson,
  compareCanonicalText,
  fingerprint,
  type LlmWorkComponentFingerprints,
  type LlmWorkExecutionIntent,
} from './work-identity.js';

export type ServiceWorkExecutionIntent = LlmWorkExecutionIntent;
export type ServiceWorkComponentFingerprints = LlmWorkComponentFingerprints;

export interface PlannedServiceViolationWork<
  TRequest extends PreparedServiceViolationRequest = PreparedServiceViolationRequest,
> {
  readonly workId: string;
  readonly inputFingerprint: string;
  readonly componentFingerprints: ServiceWorkComponentFingerprints;
  readonly request: TRequest;
}

function sortCanonical<T>(values: T[]): T[] {
  return values.sort((left, right) =>
    compareCanonicalText(canonicalJson(left), canonicalJson(right)));
}

function canonicalContext(context: ServiceViolationContext): ServiceViolationContext {
  assertUniqueLlmIdentity(context.llmRules.map((rule) => rule.key), 'rule key');
  assertUniqueLlmIdentity(context.services.map((service) => service.id), 'service runtime ID');
  assertUniqueLlmIdentity(
    (context.existingViolations ?? []).map((violation) => violation.id),
    'prior runtime ID',
  );
  const semanticPriorKey = ({ id: _id, ...semantic }: NonNullable<ServiceViolationContext['existingViolations']>[number]): string =>
    canonicalJson(semantic);
  const existingViolations = (context.existingViolations ?? [])
    .map((violation) => ({ ...violation }))
    .sort((left, right) => compareCanonicalText(semanticPriorKey(left), semanticPriorKey(right)));
  const semanticPriorKeys = existingViolations.map(semanticPriorKey);
  if (semanticPriorKeys.some((key, index) => index > 0 && key === semanticPriorKeys[index - 1])) {
    throw new Error('Service work cannot assign stable aliases to duplicate semantic prior findings');
  }

  const services = context.services.map((service) => ({
    ...service,
    layers: [...service.layers].sort(compareCanonicalText),
  }));
  services.sort((left, right) => {
    const { id: _leftId, ...leftSemantic } = left;
    const { id: _rightId, ...rightSemantic } = right;
    return compareCanonicalText(canonicalJson(leftSemantic), canonicalJson(rightSemantic));
  });
  const semanticServiceKeys = services.map(({ id: _id, ...semantic }) => canonicalJson(semantic));
  if (semanticServiceKeys.some((key, index) => index > 0 && key === semanticServiceKeys[index - 1])) {
    throw new Error('Service work cannot assign stable aliases to duplicate semantic services');
  }

  return {
    architecture: context.architecture,
    services,
    dependencies: sortCanonical(context.dependencies.map((dependency) => ({ ...dependency }))),
    llmRules: sortCanonical(context.llmRules.map((rule) => ({ ...rule }))),
    existingViolations: context.existingViolations ? existingViolations : undefined,
  };
}

export function planServiceViolationWork(
  context: ServiceViolationContext,
  mode: 'normal',
  execution: ServiceWorkExecutionIntent,
): PlannedServiceViolationWork<PreparedNormalServiceViolationRequest>;
export function planServiceViolationWork(
  context: ServiceViolationContext,
  mode: 'lifecycle',
  execution: ServiceWorkExecutionIntent,
): PlannedServiceViolationWork<PreparedLifecycleServiceViolationRequest>;
export function planServiceViolationWork(
  context: ServiceViolationContext,
  mode: 'normal' | 'lifecycle',
  execution: ServiceWorkExecutionIntent,
): PlannedServiceViolationWork {
  const preparedContext = canonicalContext(context);
  const request = mode === 'normal'
    ? prepareServiceViolationRequest(preparedContext, 'normal')
    : prepareServiceViolationRequest(preparedContext, 'lifecycle');
  const serviceNames = preparedContext.services
    .map((service) => service.name)
    .sort(compareCanonicalText);
  const ruleKeys = [...new Set(preparedContext.llmRules.map((rule) => rule.key))]
    .sort(compareCanonicalText);
  const workId = `llm.service:${fingerprint({
    version: 1,
    serviceNames,
    ruleKeys,
  })}`;

  const componentFingerprints = Object.freeze({
    repository: fingerprint({
      architecture: preparedContext.architecture,
      services: preparedContext.services.map(({ id: _id, ...service }) => service),
      dependencies: preparedContext.dependencies,
    }),
    baseline: fingerprint((preparedContext.existingViolations ?? [])
      .map(({ id: _id, ...semantic }) => semantic)),
    rules: fingerprint(preparedContext.llmRules),
    configuration: fingerprint({
      mode,
      toolPolicy: request.toolPolicy,
      timeoutMs: request.timeoutMs,
    }),
    request: fingerprint({
      stage: request.stage,
      label: request.label,
      system: request.system,
      prompt: request.prompt,
      schemaJson: request.schemaJson,
      responseFormat: request.responseFormat,
      toolPolicy: request.toolPolicy,
      timeoutMs: request.timeoutMs,
    }),
    execution: fingerprint({
      provider: execution.provider,
      requestedModel: execution.requestedModel,
    }),
    resultContract: fingerprint({
      resultContractId: request.resultContractId,
      promptAliases: request.bindings.map((binding) => binding.promptId),
    }),
  });
  const inputFingerprint = fingerprint(componentFingerprints);

  return Object.freeze({
    workId,
    inputFingerprint,
    componentFingerprints,
    request,
  });
}
