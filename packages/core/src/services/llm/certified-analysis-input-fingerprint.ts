import type { AnalysisRule } from '@truecourse/shared';
import { compareCanonicalText, fingerprint } from './work-identity.js';

/** Durable compatibility evidence for every rule/configuration input to a certified analysis. */
export function fingerprintCertifiedAnalysisInputs(input: Readonly<{
  enabledCategories?: readonly string[];
  enableLlmRules?: boolean;
  disabledRules?: readonly string[];
  rules: readonly AnalysisRule[];
}>): string {
  return fingerprint({
    version: 1,
    enabledCategories: input.enabledCategories
      ? [...input.enabledCategories].sort(compareCanonicalText)
      : null,
    enableLlmRules: input.enableLlmRules !== false,
    disabledRules: [...(input.disabledRules ?? [])].sort(compareCanonicalText),
    // Certify complete effective definitions. Engine, context requirements, and language
    // support can change execution even when a rule key and prompt remain unchanged.
    rules: input.rules.map((rule) => ({
      ...rule,
      domain: rule.domain ?? null,
      prompt: rule.prompt ?? null,
      contextRequirement: rule.contextRequirement ?? null,
      engine: rule.engine ?? null,
      languageSupport: rule.languageSupport ?? null,
    })).sort((left, right) => compareCanonicalText(left.key, right.key)),
  });
}
