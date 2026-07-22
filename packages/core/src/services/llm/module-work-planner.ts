import type { ModuleViolationContext } from './provider.js';
import {
  prepareModuleViolationRequest,
  type PreparedLifecycleModuleViolationRequest,
  type PreparedModuleViolationRequest,
  type PreparedNormalModuleViolationRequest,
} from './prepared-module-violation-request.js';
import {
  assertUniqueLlmIdentity,
  canonicalJson,
  compareCanonicalText,
  fingerprint,
  type LlmWorkComponentFingerprints,
  type LlmWorkExecutionIntent,
} from './work-identity.js';

export type ModuleWorkExecutionIntent = LlmWorkExecutionIntent;
export type ModuleWorkComponentFingerprints = LlmWorkComponentFingerprints;

export interface PlannedModuleViolationWork<
  TRequest extends PreparedModuleViolationRequest = PreparedModuleViolationRequest,
> {
  readonly workId: string;
  readonly inputFingerprint: string;
  readonly componentFingerprints: ModuleWorkComponentFingerprints;
  readonly request: TRequest;
}

function sortCanonical<T>(values: T[]): T[] {
  return values.sort((left, right) =>
    compareCanonicalText(canonicalJson(left), canonicalJson(right)));
}

function canonicalContext(context: ModuleViolationContext): ModuleViolationContext {
  assertUniqueLlmIdentity(context.llmRules.map((rule) => rule.key), 'rule key');
  assertUniqueLlmIdentity(context.modules.map((module) => module.id), 'module runtime ID');
  assertUniqueLlmIdentity(
    context.methods.flatMap((method) => method.id ? [method.id] : []),
    'method runtime ID',
  );
  assertUniqueLlmIdentity(
    (context.existingViolations ?? []).map((violation) => violation.id),
    'prior runtime ID',
  );
  const semanticPriorKey = ({ id: _id, ...semantic }: NonNullable<ModuleViolationContext['existingViolations']>[number]): string =>
    canonicalJson(semantic);
  const existingViolations = (context.existingViolations ?? [])
    .map((violation) => ({ ...violation }))
    .sort((left, right) => compareCanonicalText(semanticPriorKey(left), semanticPriorKey(right)));
  const semanticPriorKeys = existingViolations.map(semanticPriorKey);
  if (semanticPriorKeys.some((key, index) => index > 0 && key === semanticPriorKeys[index - 1])) {
    throw new Error('Module work cannot assign stable aliases to duplicate semantic prior findings');
  }

  const semanticModuleKey = ({ id: _id, serviceId: _serviceId, ...semantic }: ModuleViolationContext['modules'][number]): string =>
    canonicalJson(semantic);
  const modules = context.modules
    .map((module) => ({ ...module }))
    .sort((left, right) => compareCanonicalText(semanticModuleKey(left), semanticModuleKey(right)));
  const semanticModuleKeys = modules.map(semanticModuleKey);
  if (semanticModuleKeys.some((key, index) => index > 0 && key === semanticModuleKeys[index - 1])) {
    throw new Error('Module work cannot assign stable aliases to duplicate semantic modules');
  }

  const semanticMethodKey = ({ id: _id, ...semantic }: ModuleViolationContext['methods'][number]): string =>
    canonicalJson(semantic);
  const methods = context.methods
    .map((method) => ({ ...method }))
    .sort((left, right) => compareCanonicalText(semanticMethodKey(left), semanticMethodKey(right)));
  const semanticMethodKeys = methods.map(semanticMethodKey);
  if (semanticMethodKeys.some((key, index) => index > 0 && key === semanticMethodKeys[index - 1])) {
    throw new Error('Module work cannot assign stable aliases to duplicate semantic methods');
  }

  return {
    analysisInputFingerprint: context.analysisInputFingerprint,
    modules,
    methods,
    moduleDependencies: sortCanonical(context.moduleDependencies.map((dependency) => ({
      ...dependency,
      importedNames: [...dependency.importedNames].sort(compareCanonicalText),
    }))),
    methodDependencies: sortCanonical(context.methodDependencies.map((dependency) => ({ ...dependency }))),
    llmRules: sortCanonical(context.llmRules.map((rule) => ({ ...rule }))),
    existingViolations: context.existingViolations ? existingViolations : undefined,
  };
}

export function planModuleViolationWork(
  context: ModuleViolationContext,
  mode: 'normal',
  execution: ModuleWorkExecutionIntent,
): PlannedModuleViolationWork<PreparedNormalModuleViolationRequest>;
export function planModuleViolationWork(
  context: ModuleViolationContext,
  mode: 'lifecycle',
  execution: ModuleWorkExecutionIntent,
): PlannedModuleViolationWork<PreparedLifecycleModuleViolationRequest>;
export function planModuleViolationWork(
  context: ModuleViolationContext,
  mode: 'normal' | 'lifecycle',
  execution: ModuleWorkExecutionIntent,
): PlannedModuleViolationWork {
  const preparedContext = canonicalContext(context);
  const request = mode === 'normal'
    ? prepareModuleViolationRequest(preparedContext, 'normal')
    : prepareModuleViolationRequest(preparedContext, 'lifecycle');
  const moduleNames = preparedContext.modules
    .map((module) => module.name)
    .sort(compareCanonicalText);
  const methods = preparedContext.methods
    .map((method) => ({
      moduleName: method.moduleName,
      name: method.name,
      signature: method.signature,
    }))
    .sort((left, right) => compareCanonicalText(canonicalJson(left), canonicalJson(right)));
  const ruleKeys = [...new Set(preparedContext.llmRules.map((rule) => rule.key))]
    .sort(compareCanonicalText);
  const workId = `llm.module:${fingerprint({
    version: 1,
    moduleNames,
    methods,
    ruleKeys,
  })}`;

  const serviceBoundRuntimeModules = new Set(
    request.moduleServiceBindings.map((binding) => binding.moduleRuntimeId),
  );
  const serviceBoundModuleAliases = request.bindings
    .filter((binding) => binding.promptId.startsWith('mod-')
      && serviceBoundRuntimeModules.has(binding.runtimeId))
    .map((binding) => binding.promptId);
  const componentFingerprints = Object.freeze({
    repository: fingerprint({
      modules: preparedContext.modules.map(({ id: _id, serviceId: _serviceId, ...module }) => module),
      methods: preparedContext.methods.map(({ id: _id, ...method }) => method),
      moduleDependencies: preparedContext.moduleDependencies,
      methodDependencies: preparedContext.methodDependencies,
    }),
    baseline: fingerprint((preparedContext.existingViolations ?? [])
      .map(({ id: _id, ...semantic }) => semantic)),
    rules: fingerprint(preparedContext.llmRules),
    configuration: fingerprint({
      mode,
      toolPolicy: request.toolPolicy,
      timeoutMs: request.timeoutMs,
      analysisInputFingerprint: preparedContext.analysisInputFingerprint ?? null,
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
      serviceBoundModuleAliases,
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
