import type { Violation } from '@truecourse/shared';
import type {
  CertifiedAnalyzeLlmWork,
} from './certified-analyze-llm-run.js';
import type { PlannedCodeViolationWork } from './code-work-planner.js';
import type { PlannedDatabaseViolationWork } from './database-work-planner.js';
import type { PlannedModuleViolationWork } from './module-work-planner.js';
import type {
  CodeViolationLifecycleOutput,
  CodeViolationOutput,
  PreparedCodeViolationRequest,
} from './prepared-code-violation-request.js';
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
import type {
  PreparedLifecycleServiceViolationRequest,
  PreparedNormalServiceViolationRequest,
  ServiceLifecycleViolationOutput,
  ServiceViolationOutput,
} from './prepared-service-violation-request.js';
import type { PlannedServiceViolationWork } from './service-work-planner.js';
import { resolveId, resolveIds } from './prompts.js';
import type {
  CodeViolationsResult,
  DatabaseViolationsLifecycleResult,
  DatabaseViolationsResult,
  DiffViolationsResult,
  ModuleViolationsResult,
  ServiceDescription,
  ServiceViolationsResult,
} from './provider.js';

export interface PlannedViolationResultMaterialization {
  createId: () => string;
  createdAt: () => string;
}

export type MaterializedPlannedViolationResult =
  | MaterializedResult<'code', 'normal', CodeViolationsResult>
  | MaterializedResult<'code', 'lifecycle', CodeViolationsResult>
  | MaterializedResult<'database', 'normal', DatabaseViolationsResult>
  | MaterializedResult<'database', 'lifecycle', DatabaseViolationsLifecycleResult>
  | MaterializedResult<'service', 'normal', ServiceViolationsResult>
  | MaterializedResult<'service', 'lifecycle', DiffViolationsResult & {
      serviceDescriptions: ServiceDescription[];
    }>
  | MaterializedResult<'module', 'normal', ModuleViolationsResult>
  | MaterializedResult<'module', 'lifecycle', DiffViolationsResult>;

type WorkFamily = CertifiedAnalyzeLlmWork['family'];
type WorkMode = CertifiedAnalyzeLlmWork['mode'];
type NormalCodePlan = PlannedCodeViolationWork & {
  readonly request: Extract<PreparedCodeViolationRequest, { resultContractId: 'analyze.code@1' }>;
};
type LifecycleCodePlan = PlannedCodeViolationWork & {
  readonly request: Extract<PreparedCodeViolationRequest, { resultContractId: 'analyze.code-lifecycle@1' }>;
};

export type PlannedViolationResultInput =
  | PlannedResultInput<'code', 'normal', NormalCodePlan>
  | PlannedResultInput<'code', 'lifecycle', LifecycleCodePlan>
  | PlannedResultInput<'database', 'normal', PlannedDatabaseViolationWork<PreparedNormalDatabaseViolationRequest>>
  | PlannedResultInput<'database', 'lifecycle', PlannedDatabaseViolationWork<PreparedLifecycleDatabaseViolationRequest>>
  | PlannedResultInput<'service', 'normal', PlannedServiceViolationWork<PreparedNormalServiceViolationRequest>>
  | PlannedResultInput<'service', 'lifecycle', PlannedServiceViolationWork<PreparedLifecycleServiceViolationRequest>>
  | PlannedResultInput<'module', 'normal', PlannedModuleViolationWork<PreparedNormalModuleViolationRequest>>
  | PlannedResultInput<'module', 'lifecycle', PlannedModuleViolationWork<PreparedLifecycleModuleViolationRequest>>;

export type PlannedViolationResultRequest = PlannedViolationResultInput extends infer TInput
  ? TInput extends PlannedViolationResultInput
    ? Omit<TInput, 'result'>
    : never
  : never;

export type MaterializedPayloadFor<TInput extends PlannedViolationResultRequest> =
  Extract<MaterializedPlannedViolationResult, {
    family: TInput['family'];
    mode: TInput['mode'];
  }>['result'];

type PlannedResultInput<TFamily extends WorkFamily, TMode extends WorkMode, TPlanned> = {
  readonly family: TFamily;
  readonly mode: TMode;
  readonly planned: TPlanned;
  readonly result: unknown;
};

interface MaterializedResult<TFamily extends WorkFamily, TMode extends WorkMode, TResult> {
  readonly family: TFamily;
  readonly domain: Extract<CertifiedAnalyzeLlmWork, { family: TFamily }>['domain'];
  readonly mode: TMode;
  readonly workId: string;
  readonly inputFingerprint: string;
  readonly result: TResult;
}

/**
 * Rebind one schema-validated, alias-space provider result to the runtime IDs
 * captured by its exact immutable request. This never rebuilds context or
 * plans another provider call.
 */
export function materializePlannedViolationResult(
  outcome: { readonly work: CertifiedAnalyzeLlmWork; readonly result: unknown },
  materialization: PlannedViolationResultMaterialization,
): MaterializedPlannedViolationResult {
  const { work } = outcome;
  const input = plannedViolationResultInput(work, outcome.result);
  const result = materializePlannedViolationPayload(input, materialization);

  return {
    family: work.family,
    domain: work.domain,
    mode: work.mode,
    workId: work.workId,
    inputFingerprint: work.inputFingerprint,
    result,
  } as MaterializedPlannedViolationResult;
}

function plannedViolationResultInput(
  work: CertifiedAnalyzeLlmWork,
  result: unknown,
): PlannedViolationResultInput {
  const request = work.planned.request;
  const lifecycle = request.resultContractId.endsWith('-lifecycle@1');
  const expectedMode = lifecycle ? 'lifecycle' : 'normal';
  if (work.mode !== expectedMode) {
    throw new Error(
      `Analyze ${work.family} work mode ${work.mode} does not match ${request.resultContractId}`,
    );
  }

  if (work.family === 'code') {
    if (request.resultContractId === 'analyze.code@1') {
      return { family: 'code', mode: 'normal', planned: { ...work.planned, request }, result };
    }
    if (request.resultContractId === 'analyze.code-lifecycle@1') {
      return { family: 'code', mode: 'lifecycle', planned: { ...work.planned, request }, result };
    }
  } else if (work.family === 'database') {
    if (request.resultContractId === 'analyze.database@1') {
      return { family: 'database', mode: 'normal', planned: { ...work.planned, request }, result };
    }
    if (request.resultContractId === 'analyze.database-lifecycle@1') {
      return { family: 'database', mode: 'lifecycle', planned: { ...work.planned, request }, result };
    }
  } else if (work.family === 'service') {
    if (request.resultContractId === 'analyze.service@1') {
      return { family: 'service', mode: 'normal', planned: { ...work.planned, request }, result };
    }
    if (request.resultContractId === 'analyze.service-lifecycle@1') {
      return { family: 'service', mode: 'lifecycle', planned: { ...work.planned, request }, result };
    }
  } else {
    if (request.resultContractId === 'analyze.module@1') {
      return { family: 'module', mode: 'normal', planned: { ...work.planned, request }, result };
    }
    if (request.resultContractId === 'analyze.module-lifecycle@1') {
      return { family: 'module', mode: 'lifecycle', planned: { ...work.planned, request }, result };
    }
  }

  throw new Error(
    `Analyze ${work.family} work cannot materialize result contract ${request.resultContractId}`,
  );
}

/** Shared payload-only seam used by legacy methods that do not own a run/domain envelope. */
export function materializePlannedViolationPayload<TInput extends PlannedViolationResultInput>(
  input: TInput,
  materialization: PlannedViolationResultMaterialization,
): MaterializedPayloadFor<Omit<TInput, 'result'> & PlannedViolationResultRequest> {
  const raw = input.planned.request.parse(input.result);
  if (input.family === 'code') {
    return materializeCode(
      input.planned,
      raw as CodeViolationOutput | CodeViolationLifecycleOutput,
    ) as MaterializedPayloadFor<Omit<TInput, 'result'> & PlannedViolationResultRequest>;
  }
  if (input.family === 'database') {
    return materializeDatabase(
      input.planned,
      raw as DatabaseViolationOutput | DatabaseLifecycleViolationOutput,
      materialization,
    ) as MaterializedPayloadFor<Omit<TInput, 'result'> & PlannedViolationResultRequest>;
  }
  if (input.family === 'service') {
    return materializeService(
      input.planned,
      raw as ServiceViolationOutput | ServiceLifecycleViolationOutput,
      materialization,
    ) as MaterializedPayloadFor<Omit<TInput, 'result'> & PlannedViolationResultRequest>;
  }
  return materializeModule(
    input.planned,
    raw as ModuleViolationOutput | ModuleLifecycleViolationOutput,
    materialization,
  ) as MaterializedPayloadFor<Omit<TInput, 'result'> & PlannedViolationResultRequest>;
}

function materializeCode(
  planned: PlannedCodeViolationWork,
  raw: CodeViolationOutput | CodeViolationLifecycleOutput,
): CodeViolationsResult {
  const request = planned.request;
  const mapFinding = (violation: CodeViolationOutput['violations'][number]) => ({
    ruleKey: violation.ruleKey,
    filePath: violation.filePath,
    lineStart: violation.lineStart,
    lineEnd: violation.lineEnd,
    severity: violation.severity,
    title: violation.title,
    content: violation.content,
    fixPrompt: violation.fixPrompt ?? null,
    sourceTier: request.ownership.tier,
  });
  if ('newViolations' in raw) {
    const idMap = promptIdMap(request.bindings);
    return {
      violations: raw.newViolations.map(mapFinding),
      resolvedViolationIds: resolveIds(raw.resolvedViolationIds, idMap),
      unchangedViolationIds: resolveIds(raw.unchangedViolationIds, idMap),
    };
  }
  return { violations: raw.violations.map(mapFinding) };
}

function materializeDatabase(
  planned: PlannedDatabaseViolationWork,
  raw: DatabaseViolationOutput | DatabaseLifecycleViolationOutput,
  materialization: PlannedViolationResultMaterialization,
): DatabaseViolationsResult | DatabaseViolationsLifecycleResult {
  const idMap = promptIdMap(planned.request.bindings);
  if ('newViolations' in raw) {
    return {
      resolvedViolationIds: resolveIds(raw.resolvedViolationIds, idMap),
      unchangedViolationIds: resolveIds(raw.unchangedViolationIds, idMap),
      newViolations: raw.newViolations.map((violation) => ({
        ...violation,
        targetDatabaseId: violation.targetDatabaseId?.startsWith('db-')
          ? idMap.get(violation.targetDatabaseId) ?? null
          : null,
      })),
    };
  }
  return {
    violations: raw.violations.map((violation) => ({
      id: materialization.createId(),
      type: violation.type,
      category: 'rule' as const,
      title: violation.title,
      content: violation.content,
      severity: violation.severity,
      targetDatabaseId: resolveId(violation.targetDatabaseId, idMap) ?? undefined,
      targetTable: violation.targetTable ?? undefined,
      fixPrompt: violation.fixPrompt ?? undefined,
      ruleKey: violation.ruleKey ?? undefined,
      createdAt: materialization.createdAt(),
    })),
  };
}

function materializeService(
  planned: PlannedServiceViolationWork,
  raw: ServiceViolationOutput | ServiceLifecycleViolationOutput,
  materialization: PlannedViolationResultMaterialization,
): ServiceViolationsResult | (DiffViolationsResult & { serviceDescriptions: ServiceDescription[] }) {
  const idMap = promptIdMap(planned.request.bindings);
  const serviceDescriptions = raw.serviceDescriptions.map((description) => ({
    id: resolveId(description.id, idMap) || description.id,
    description: description.description,
  }));
  if ('newViolations' in raw) {
    return {
      resolvedViolationIds: resolveIds(raw.resolvedViolationIds, idMap),
      unchangedViolationIds: resolveIds(raw.unchangedViolationIds, idMap),
      newViolations: raw.newViolations.map((violation) => ({
        ...violation,
        targetServiceId: resolveId(violation.targetServiceId, idMap) ?? null,
        targetModuleId: violation.targetModuleId ?? null,
        targetMethodId: violation.targetMethodId ?? null,
        targetServiceName: violation.targetServiceName ?? null,
        targetModuleName: violation.targetModuleName ?? null,
        targetMethodName: violation.targetMethodName ?? null,
      })),
      serviceDescriptions,
    };
  }
  return {
    violations: raw.violations.map((violation) => ({
      id: materialization.createId(),
      type: violation.type,
      category: 'rule' as const,
      title: violation.title,
      content: violation.content,
      severity: violation.severity,
      targetServiceId: resolveId(violation.targetServiceId, idMap) ?? undefined,
      fixPrompt: violation.fixPrompt ?? undefined,
      ruleKey: violation.ruleKey ?? undefined,
      createdAt: materialization.createdAt(),
    })),
    serviceDescriptions,
  };
}

function materializeModule(
  planned: PlannedModuleViolationWork,
  raw: ModuleViolationOutput | ModuleLifecycleViolationOutput,
  materialization: PlannedViolationResultMaterialization,
): ModuleViolationsResult | DiffViolationsResult {
  const request = planned.request;
  const idMap = promptIdMap(request.bindings);
  const moduleIdToServiceId = new Map(
    request.moduleServiceBindings.map(({ moduleRuntimeId, serviceRuntimeId }) =>
      [moduleRuntimeId, serviceRuntimeId]),
  );
  if ('newViolations' in raw) {
    return {
      resolvedViolationIds: resolveIds(raw.resolvedViolationIds, idMap),
      unchangedViolationIds: resolveIds(raw.unchangedViolationIds, idMap),
      newViolations: raw.newViolations.map((violation) => {
        const targetModuleId = resolveId(violation.targetModuleId, idMap);
        return {
          ...violation,
          targetServiceId: (targetModuleId ? moduleIdToServiceId.get(targetModuleId) : null) ?? null,
          targetModuleId: targetModuleId ?? null,
          targetMethodId: resolveId(violation.targetMethodId, idMap) ?? null,
          targetModuleName: violation.targetModuleName ?? null,
          targetMethodName: violation.targetMethodName ?? null,
        };
      }),
    };
  }
  return {
    violations: raw.violations.map((violation) => {
      const targetModuleId = resolveId(violation.targetModuleId, idMap) ?? undefined;
      const targetServiceId = targetModuleId ? moduleIdToServiceId.get(targetModuleId) : undefined;
      return {
        id: materialization.createId(),
        type: violation.type,
        category: 'rule' as const,
        title: violation.title,
        content: violation.content,
        severity: violation.severity,
        targetServiceId,
        targetModuleId,
        targetMethodId: resolveId(violation.targetMethodId, idMap) ?? undefined,
        fixPrompt: violation.fixPrompt ?? undefined,
        ruleKey: violation.ruleKey ?? undefined,
        createdAt: materialization.createdAt(),
      } satisfies Violation;
    }),
  };
}

function promptIdMap(
  bindings: readonly { readonly promptId: string; readonly runtimeId: string }[],
): Map<string, string> {
  return new Map(bindings.map(({ promptId, runtimeId }) => [promptId, runtimeId]));
}
