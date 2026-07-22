import type {
  AllViolationsLifecycleResult,
  DiffViolationItem,
  DiffViolationsResult,
  ModuleViolationContext,
  ModuleViolationsResult,
  ServiceViolationContext,
  ServiceViolationsResult,
  ViolationsResult,
} from './provider.js';
import type { CertifiedViolationPhaseResult } from './certified-violation-phase.js';
import {
  mergeViolationLlmResults,
  type ViolationGenerationInput,
} from '../violation.service.js';

export interface CertifiedArchitectureContexts {
  service?: ServiceViolationContext;
  module?: ModuleViolationContext;
}

/** Keep only aggregate families that own at least one enabled LLM rule. */
export function selectCertifiedArchitectureContexts(
  contexts: Readonly<{
    service: ServiceViolationContext;
    module?: ModuleViolationContext;
  }>,
): CertifiedArchitectureContexts | null {
  const service = contexts.service.llmRules.length > 0
    ? contexts.service
    : undefined;
  const module = contexts.module && contexts.module.llmRules.length > 0
    ? contexts.module
    : undefined;
  return service || module ? { service, module } : null;
}

/** Merge materialized service/module results without requiring both families. */
export function mergeCertifiedArchitectureResults(
  input: ViolationGenerationInput,
  phase: CertifiedViolationPhaseResult,
  mode: 'normal' | 'lifecycle',
): ViolationsResult | AllViolationsLifecycleResult {
  if (mode === 'normal') {
    const service = phase.results.find((result) => result.family === 'service');
    const module = phase.results.find((result) => result.family === 'module');
    return mergeViolationLlmResults(input, {
      service: service?.result as ServiceViolationsResult | undefined,
      module: module?.result as ModuleViolationsResult | undefined,
    });
  }

  const resolvedViolationIds: string[] = [];
  const unchangedViolationIds: string[] = [];
  const newViolations: DiffViolationItem[] = [];
  let serviceDescriptions: ServiceViolationsResult['serviceDescriptions'] = [];

  for (const outcome of phase.results) {
    if (outcome.family !== 'service' && outcome.family !== 'module') continue;
    if (outcome.mode === 'lifecycle') {
      const lifecycle = outcome.result as DiffViolationsResult & {
        serviceDescriptions?: ServiceViolationsResult['serviceDescriptions'];
      };
      resolvedViolationIds.push(...lifecycle.resolvedViolationIds);
      unchangedViolationIds.push(...lifecycle.unchangedViolationIds);
      newViolations.push(...lifecycle.newViolations);
      if (outcome.family === 'service') {
        serviceDescriptions = lifecycle.serviceDescriptions ?? [];
      }
      continue;
    }

    if (outcome.family === 'service') {
      const normal = mergeViolationLlmResults(input, {
        service: outcome.result as ServiceViolationsResult,
      });
      serviceDescriptions = normal.serviceDescriptions;
      newViolations.push(...normal.violations.map(asDiffViolationItem));
    } else {
      const normal = mergeViolationLlmResults(input, {
        module: outcome.result as ModuleViolationsResult,
      });
      newViolations.push(...normal.violations.map(asDiffViolationItem));
    }
  }

  const validServiceIds = new Set(input.services.map((service) => service.id));
  const validModuleIds = new Set((input.modules ?? []).map((module) => module.id));
  const validMethodIds = new Set(
    (input.methods ?? []).flatMap((method) => method.id ? [method.id] : []),
  );
  for (const violation of newViolations) {
    if (violation.targetServiceId && !validServiceIds.has(violation.targetServiceId)) {
      violation.targetServiceId = null;
    }
    if (violation.targetModuleId && !validModuleIds.has(violation.targetModuleId)) {
      violation.targetModuleId = null;
    }
    if (violation.targetMethodId && !validMethodIds.has(violation.targetMethodId)) {
      violation.targetMethodId = null;
    }
  }
  serviceDescriptions = serviceDescriptions.filter(({ id }) => validServiceIds.has(id));

  return {
    resolvedViolationIds,
    unchangedViolationIds,
    newViolations,
    serviceDescriptions,
  };
}

function asDiffViolationItem(
  violation: ServiceViolationsResult['violations'][number],
): DiffViolationItem {
  return {
    type: violation.type,
    title: violation.title,
    content: violation.content,
    severity: violation.severity,
    targetServiceId: violation.targetServiceId ?? null,
    targetModuleId: violation.targetModuleId ?? null,
    targetMethodId: violation.targetMethodId ?? null,
    targetDatabaseId: violation.targetDatabaseId ?? null,
    targetTable: violation.targetTable ?? null,
    targetServiceName: null,
    targetModuleName: null,
    targetMethodName: null,
    fixPrompt: violation.fixPrompt ?? null,
    ruleKey: violation.ruleKey ?? 'unknown',
  };
}
