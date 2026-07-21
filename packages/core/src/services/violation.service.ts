import {
  createLLMProvider,
  type LLMProvider,
  type ServiceViolationContext,
  type DatabaseViolationContext,
  type ModuleViolationContext,
  type ViolationsResult,
  type AllViolationsResult,
  type AllViolationsLifecycleResult,
  type ExistingViolation,
} from './llm/provider.js';
import type { Violation } from '@truecourse/shared';

export interface ViolationGenerationInput {
  architecture: string;
  services: {
    id: string;
    name: string;
    type: string;
    framework?: string;
    fileCount: number;
    layerSummary: unknown;
  }[];
  dependencies: {
    sourceServiceName: string;
    targetServiceName: string;
    dependencyCount: number | null;
    dependencyType: string | null;
  }[];
  databases?: {
    id: string;
    name: string;
    type: string;
    driver: string;
    tableCount: number;
    connectedServices: string[];
    tables?: {
      name: string;
      columns: { name: string; type: string; isNullable?: boolean; isPrimaryKey?: boolean; isForeignKey?: boolean; referencesTable?: string }[];
    }[];
    relations?: { sourceTable: string; targetTable: string; foreignKeyColumn: string }[];
  }[];
  llmRules?: {
    key: string;
    name: string;
    severity: string;
    prompt: string;
    category: string;
  }[];
  modules?: {
    id: string;
    name: string;
    kind: string;
    serviceName: string;
    layerName: string;
    methodCount: number;
    propertyCount: number;
    importCount: number;
    exportCount: number;
    superClass?: string;
    lineCount?: number;
  }[];
  methods?: {
    id?: string;
    moduleName: string;
    name: string;
    signature: string;
    paramCount: number;
    returnType?: string;
    isAsync: boolean;
    lineCount?: number;
    statementCount?: number;
    maxNestingDepth?: number;
  }[];
  moduleDependencies?: {
    sourceModule: string;
    targetModule: string;
    importedNames: string[];
  }[];
  methodDependencies?: {
    callerMethod: string;
    callerModule: string;
    calleeMethod: string;
    calleeModule: string;
    callCount: number;
  }[];
  /** Existing violations per category for lifecycle mode (LLM-only, no deterministic) */
  existingServiceViolations?: ExistingViolation[];
  existingDatabaseViolations?: ExistingViolation[];
  existingModuleViolations?: ExistingViolation[];
}

export type ViolationLlmContextMode = 'normal' | 'lifecycle';

export interface ViolationLlmContexts {
  service: ServiceViolationContext;
  database: DatabaseViolationContext | undefined;
  module: ModuleViolationContext | undefined;
}

/** Build every aggregate LLM context before any provider call is admitted. */
export function buildViolationLlmContexts(
  input: ViolationGenerationInput,
  mode: ViolationLlmContextMode,
): ViolationLlmContexts {
  const serviceDtos = input.services.map((service) => ({
    id: service.id,
    name: service.name,
    type: service.type,
    framework: service.framework,
    fileCount: service.fileCount,
    layers: extractLayerNames(service.layerSummary),
  }));
  const includeExisting = mode === 'lifecycle';
  const service: ServiceViolationContext = {
    architecture: input.architecture,
    services: serviceDtos,
    dependencies: input.dependencies.map((dependency) => ({
      source: dependency.sourceServiceName,
      target: dependency.targetServiceName,
      count: dependency.dependencyCount || 0,
      type: dependency.dependencyType || undefined,
    })),
    llmRules: (input.llmRules || []).filter((rule) => rule.category === 'service'),
    ...(includeExisting ? { existingViolations: input.existingServiceViolations } : {}),
  };
  const database = input.databases && input.databases.length > 0
    ? {
        databases: input.databases,
        llmRules: (input.llmRules || []).filter((rule) => rule.category === 'database'),
        ...(includeExisting ? { existingViolations: input.existingDatabaseViolations } : {}),
      }
    : undefined;
  const serviceNameToId = new Map(serviceDtos.map((candidate) => [candidate.name, candidate.id]));
  const module = input.modules && input.modules.length > 0
    ? {
        modules: input.modules.map((candidate) => ({
          ...candidate,
          serviceId: serviceNameToId.get(candidate.serviceName),
        })),
        methods: input.methods || [],
        moduleDependencies: input.moduleDependencies || [],
        methodDependencies: input.methodDependencies || [],
        llmRules: (input.llmRules || []).filter((rule) => rule.category === 'module'),
        ...(includeExisting ? { existingViolations: input.existingModuleViolations } : {}),
      }
    : undefined;

  return { service, database, module };
}

export async function generateViolations(
  input: ViolationGenerationInput,
  onProgress?: (step: string) => void,
  externalProvider?: LLMProvider,
  onCallStart?: (key: 'service' | 'database' | 'module') => void,
  onCallDone?: (key: 'service' | 'database' | 'module', ok: boolean) => void,
): Promise<ViolationsResult> {
  const provider = externalProvider ?? createLLMProvider();

  const {
    service: serviceContext,
    database: dbContext,
    module: moduleContext,
  } = buildViolationLlmContexts(input, 'normal');

  // Run all in parallel via single traced call
  const results = await provider.generateAllViolations({
    service: serviceContext,
    database: dbContext,
    module: moduleContext,
    onStepComplete: onProgress,
    onCallStart,
    onCallDone,
  });

  return mergeViolationLlmResults(input, results);
}

/** Merge provider family results while rejecting graph IDs outside this analysis. */
export function mergeViolationLlmResults(
  input: ViolationGenerationInput,
  results: AllViolationsResult,
): ViolationsResult {
  const validServiceIds = new Set(input.services.map((service) => service.id));
  const validDatabaseIds = new Set((input.databases || []).map((database) => database.id));
  const validModuleIds = new Set((input.modules || []).map((module) => module.id));
  const validMethodIds = new Set(
    (input.methods || []).flatMap((method) => method.id ? [method.id] : []),
  );

  // --- Merge results ---
  const allViolations: Violation[] = [];
  let serviceDescriptions: { id: string; description: string }[] = [];

  // Service result
  if (results.service) {
    for (const violation of results.service.violations) {
      if (violation.targetServiceId && !validServiceIds.has(violation.targetServiceId)) {
        violation.targetServiceId = undefined;
      }
      allViolations.push(violation);
    }
    serviceDescriptions = results.service.serviceDescriptions.filter((d) => validServiceIds.has(d.id));
  }

  // Database result
  if (results.database) {
    for (const violation of results.database.violations) {
      if (violation.targetDatabaseId && !validDatabaseIds.has(violation.targetDatabaseId)) {
        violation.targetDatabaseId = undefined;
      }
      allViolations.push(violation);
    }
  }

  // Module result
  if (results.module) {
    for (const violation of results.module.violations) {
      if (violation.targetServiceId && !validServiceIds.has(violation.targetServiceId)) {
        violation.targetServiceId = undefined;
      }
      if (violation.targetModuleId && !validModuleIds.has(violation.targetModuleId)) {
        violation.targetModuleId = undefined;
      }
      if (violation.targetMethodId && !validMethodIds.has(violation.targetMethodId)) {
        violation.targetMethodId = undefined;
      }
      allViolations.push(violation);
    }
  }

  return { violations: allViolations, serviceDescriptions };
}

/**
 * Generate violations with lifecycle tracking — returns new violations + resolved IDs
 * instead of a flat violations array.
 */
export async function generateViolationsWithLifecycle(
  input: ViolationGenerationInput,
  onProgress?: (step: string) => void,
  externalProvider?: LLMProvider,
  onCallStart?: (key: 'service' | 'database' | 'module') => void,
  onCallDone?: (key: 'service' | 'database' | 'module', ok: boolean) => void,
): Promise<AllViolationsLifecycleResult> {
  const provider = externalProvider ?? createLLMProvider();
  const {
    service: serviceContext,
    database: dbContext,
    module: moduleContext,
  } = buildViolationLlmContexts(input, 'lifecycle');

  const result = await provider.generateAllViolationsWithLifecycle({
    service: serviceContext,
    database: dbContext,
    module: moduleContext,
    onCallStart,
    onCallDone,
  }, (step) => {
    onProgress?.(step);
  });

  return result;
}

function extractLayerNames(layerSummary: unknown): string[] {
  if (!layerSummary) return [];
  if (Array.isArray(layerSummary)) {
    return layerSummary
      .filter(
        (l): l is { layer: string } =>
          typeof l === 'object' && l !== null && 'layer' in l
      )
      .map((l) => l.layer);
  }
  return [];
}
