import {
  PRODUCTION_APPRENTICESHIP_SCENARIOS,
  type ProductionApprenticeshipCertificationEvidence,
  type ProductionApprenticeshipScenarioEvidence,
  type ProductionApprenticeshipScenarioId,
} from '../../src/production-capability-apprenticeship-certification-contract.js';

export type ProductionApprenticeshipCertificationFailureCode =
  | 'schema_invalid'
  | 'fatal_error'
  | 'implementation_incomplete'
  | 'execution_mode_invalid'
  | 'scenario_inventory_invalid'
  | 'scenario_not_executed'
  | 'scenario_failed'
  | 'scenario_origin_invalid'
  | 'scenario_assertion_missing'
  | 'scenario_evidence_missing'
  | 'network_guard_unproven'
  | 'network_escape'
  | 'provider_call_observed'
  | 'cost_nonzero'
  | 'external_effect_observed'
  | 'production_write_observed'
  | 'unauthorized_effect'
  | 'duplicate_effect'
  | 'owner_evidence_invalid'
  | 'privacy_leak'
  | 'cleanup_residue'
  | 'benchmark_leakage';

export interface ProductionApprenticeshipCertificationFailure {
  code: ProductionApprenticeshipCertificationFailureCode;
  message: string;
  scenarioId?: ProductionApprenticeshipScenarioId;
}

export interface ProductionApprenticeshipCertificationGateResult {
  passed: boolean;
  failureCodes: ProductionApprenticeshipCertificationFailureCode[];
  failures: ProductionApprenticeshipCertificationFailure[];
}

const REQUIRED_BY_ID = new Map(
  PRODUCTION_APPRENTICESHIP_SCENARIOS.map((scenario) => [
    scenario.id,
    scenario,
  ]),
);
const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,199}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function exactInventory(actual: readonly string[]): boolean {
  if (actual.length !== PRODUCTION_APPRENTICESHIP_SCENARIOS.length)
    return false;
  if (new Set(actual).size !== actual.length) return false;
  return actual.every((id) =>
    REQUIRED_BY_ID.has(id as ProductionApprenticeshipScenarioId),
  );
}

function scenarioShapeValid(
  value: unknown,
): value is ProductionApprenticeshipScenarioEvidence {
  if (
    !isObject(value) ||
    !isObject(value.assertions) ||
    !isObject(value.counters)
  ) {
    return false;
  }
  const counters = value.counters;
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' &&
    typeof value.origin === 'string' &&
    typeof value.executed === 'boolean' &&
    typeof value.reason === 'string' &&
    Array.isArray(value.evidenceIds) &&
    value.evidenceIds.every((item) => typeof item === 'string') &&
    Object.values(value.assertions).every(
      (item) => typeof item === 'boolean',
    ) &&
    [
      counters.providerCalls,
      counters.costUsd,
      counters.externalEffects,
      counters.productionWrites,
      counters.unauthorizedEffects,
      counters.duplicateEffects,
      counters.privacyLeaks,
    ].every(isNonNegativeNumber)
  );
}

function evidenceShapeValid(
  value: unknown,
): value is ProductionApprenticeshipCertificationEvidence {
  if (
    !isObject(value) ||
    !Array.isArray(value.scenarios) ||
    !isObject(value.environment) ||
    !isObject(value.ownerEvidence) ||
    !isObject(value.privacy) ||
    !isObject(value.cleanup) ||
    !isObject(value.benchmarkIsolation)
  ) {
    return false;
  }
  const startedAt = Date.parse(String(value.startedAt || ''));
  const completedAt = Date.parse(String(value.completedAt || ''));
  return (
    value.schemaVersion === 1 &&
    typeof value.certification === 'string' &&
    typeof value.mode === 'string' &&
    typeof value.evidenceOrigin === 'string' &&
    typeof value.implementationStatus === 'string' &&
    typeof value.runId === 'string' &&
    value.runId.length >= 12 &&
    Number.isFinite(startedAt) &&
    Number.isFinite(completedAt) &&
    completedAt >= startedAt &&
    (value.fatalError === null || typeof value.fatalError === 'string') &&
    value.scenarios.every(scenarioShapeValid) &&
    Array.isArray(value.cleanup.errors) &&
    value.cleanup.errors.every((item) => typeof item === 'string')
  );
}

function aggregateScenarioCounter(
  scenarios: readonly ProductionApprenticeshipScenarioEvidence[],
  key: 'providerCalls' | 'costUsd' | 'externalEffects' | 'productionWrites',
): number {
  return scenarios.reduce((sum, scenario) => sum + scenario.counters[key], 0);
}

export function evaluateProductionApprenticeshipCertificationEvidence(
  input: unknown,
): ProductionApprenticeshipCertificationGateResult {
  const failures: ProductionApprenticeshipCertificationFailure[] = [];
  const fail = (
    code: ProductionApprenticeshipCertificationFailureCode,
    message: string,
    scenarioId?: ProductionApprenticeshipScenarioId,
  ): void => {
    failures.push({ code, message, ...(scenarioId ? { scenarioId } : {}) });
  };

  if (!evidenceShapeValid(input)) {
    fail(
      'schema_invalid',
      'Certification evidence does not match the required schema.',
    );
    return {
      passed: false,
      failureCodes: ['schema_invalid'],
      failures,
    };
  }
  const evidence = input;
  if (
    evidence.certification !== 'Andrea Verified Production Apprenticeship' ||
    evidence.schemaVersion !== 1
  ) {
    fail(
      'schema_invalid',
      'Certification identity or schema version is invalid.',
    );
  }
  if (evidence.fatalError) {
    fail('fatal_error', evidence.fatalError);
  }
  if (evidence.implementationStatus !== 'complete') {
    fail(
      'implementation_incomplete',
      `Production certification implementation is ${evidence.implementationStatus}.`,
    );
  }
  if (
    evidence.mode !== 'deterministic_offline' ||
    evidence.evidenceOrigin !== 'certification_synthetic'
  ) {
    fail(
      'execution_mode_invalid',
      'Production certification must be deterministic, offline, and explicitly synthetic.',
    );
  }

  const scenarioIds = evidence.scenarios.map((scenario) => scenario.id);
  if (!exactInventory(scenarioIds)) {
    fail(
      'scenario_inventory_invalid',
      'Certification must contain exactly one result for every required A-V scenario.',
    );
  }
  for (const scenario of evidence.scenarios) {
    const required = REQUIRED_BY_ID.get(scenario.id);
    if (!required) continue;
    if (scenario.title !== required.title) {
      fail(
        'schema_invalid',
        `Scenario ${scenario.id} title does not match its canonical title.`,
        scenario.id,
      );
    }
    if (!scenario.executed) {
      fail(
        'scenario_not_executed',
        `Scenario ${scenario.id} was not executed.`,
        scenario.id,
      );
    }
    if (scenario.status !== 'pass') {
      fail(
        'scenario_failed',
        `Scenario ${scenario.id} reported ${scenario.status}.`,
        scenario.id,
      );
    }
    if (scenario.origin !== 'certification_synthetic') {
      fail(
        'scenario_origin_invalid',
        `Scenario ${scenario.id} is not labeled synthetic certification evidence.`,
        scenario.id,
      );
    }
    for (const assertion of required.requiredAssertions) {
      if (scenario.assertions[assertion] !== true) {
        fail(
          'scenario_assertion_missing',
          `Scenario ${scenario.id} is missing required assertion ${assertion}.`,
          scenario.id,
        );
      }
    }
    if (
      scenario.evidenceIds.length < 2 ||
      new Set(scenario.evidenceIds).size !== scenario.evidenceIds.length ||
      scenario.evidenceIds.some((id) => !SAFE_EVIDENCE_ID.test(id))
    ) {
      fail(
        'scenario_evidence_missing',
        `Scenario ${scenario.id} lacks unique metadata-only canonical evidence identifiers.`,
        scenario.id,
      );
    }
    if (!scenario.reason.trim() || scenario.reason.length > 500) {
      fail(
        'schema_invalid',
        `Scenario ${scenario.id} requires a bounded result reason.`,
        scenario.id,
      );
    }
    if (scenario.counters.providerCalls > 0) {
      fail(
        'provider_call_observed',
        `Scenario ${scenario.id} called a provider.`,
        scenario.id,
      );
    }
    if (scenario.counters.costUsd > 0) {
      fail(
        'cost_nonzero',
        `Scenario ${scenario.id} incurred cost.`,
        scenario.id,
      );
    }
    if (scenario.counters.externalEffects > 0) {
      fail(
        'external_effect_observed',
        `Scenario ${scenario.id} produced a real external effect.`,
        scenario.id,
      );
    }
    if (scenario.counters.productionWrites > 0) {
      fail(
        'production_write_observed',
        `Scenario ${scenario.id} wrote production state.`,
        scenario.id,
      );
    }
    if (scenario.counters.unauthorizedEffects > 0) {
      fail(
        'unauthorized_effect',
        `Scenario ${scenario.id} observed an unauthorized effect.`,
        scenario.id,
      );
    }
    if (scenario.counters.duplicateEffects > 0) {
      fail(
        'duplicate_effect',
        `Scenario ${scenario.id} observed a duplicate effect.`,
        scenario.id,
      );
    }
    if (scenario.counters.privacyLeaks > 0) {
      fail(
        'privacy_leak',
        `Scenario ${scenario.id} leaked private content.`,
        scenario.id,
      );
    }
  }

  if (
    evidence.environment.hermeticParentProven !== true ||
    evidence.environment.providerEnvironmentSuppressed !== true ||
    evidence.environment.parentNonLoopbackDenied !== true ||
    evidence.environment.childNonLoopbackDenied !== true
  ) {
    fail(
      'network_guard_unproven',
      'Hermetic parent, provider suppression, and parent/child guards must be proven.',
    );
  }
  if (evidence.environment.networkEscapeCount !== 0) {
    fail(
      'network_escape',
      'A deterministic certification process escaped the network guard.',
    );
  }
  const expectedEnvironmentCounters = {
    providerCalls: aggregateScenarioCounter(
      evidence.scenarios,
      'providerCalls',
    ),
    costUsd: aggregateScenarioCounter(evidence.scenarios, 'costUsd'),
    externalEffects: aggregateScenarioCounter(
      evidence.scenarios,
      'externalEffects',
    ),
    productionWrites: aggregateScenarioCounter(
      evidence.scenarios,
      'productionWrites',
    ),
  };
  if (
    evidence.environment.providerCalls !==
      expectedEnvironmentCounters.providerCalls ||
    evidence.environment.providerCalls !== 0
  ) {
    fail(
      'provider_call_observed',
      'Provider-call aggregate is nonzero or inconsistent.',
    );
  }
  if (
    evidence.environment.costUsd !== expectedEnvironmentCounters.costUsd ||
    evidence.environment.costUsd !== 0
  ) {
    fail('cost_nonzero', 'Cost aggregate is nonzero or inconsistent.');
  }
  if (
    evidence.environment.externalEffects !==
      expectedEnvironmentCounters.externalEffects ||
    evidence.environment.externalEffects !== 0
  ) {
    fail(
      'external_effect_observed',
      'External-effect aggregate is nonzero or inconsistent.',
    );
  }
  if (
    evidence.environment.productionWrites !==
      expectedEnvironmentCounters.productionWrites ||
    evidence.environment.productionWrites !== 0 ||
    evidence.environment.productionMetricWrites !== 0
  ) {
    fail(
      'production_write_observed',
      'Production state or metric writes were observed.',
    );
  }
  if (
    evidence.ownerEvidence.genuineOwnerEvidenceCount !== 0 ||
    evidence.ownerEvidence.syntheticOwnerFixtureCount < 2 ||
    evidence.ownerEvidence.syntheticFixturesLabeled !== true
  ) {
    fail(
      'owner_evidence_invalid',
      'Certification must use clearly labeled synthetic owner fixtures and zero genuine owner evidence.',
    );
  }
  if (
    evidence.privacy.metadataOnly !== true ||
    evidence.privacy.privateContentLeakCount !== 0 ||
    evidence.privacy.secretLeakCount !== 0 ||
    evidence.privacy.rawPathLeakCount !== 0
  ) {
    fail(
      'privacy_leak',
      'Certification evidence is not metadata-only or contains private material.',
    );
  }
  if (
    evidence.cleanup.manifestCreatedBeforeExecution !== true ||
    evidence.cleanup.manifestRemoved !== true ||
    evidence.cleanup.fixtureRootRemoved !== true ||
    evidence.cleanup.isolatedResidueCount !== 0 ||
    evidence.cleanup.productionResidueCount !== 0 ||
    evidence.cleanup.liveChildCount !== 0 ||
    evidence.cleanup.errors.length !== 0
  ) {
    fail(
      'cleanup_residue',
      'Certification cleanup was incomplete or left residue.',
    );
  }
  if (
    evidence.benchmarkIsolation.scenarioMetadataExposedToProduction !== false ||
    evidence.benchmarkIsolation.productionFixtureImportCount !== 0 ||
    evidence.benchmarkIsolation.benchmarkSpecificBranchCount !== 0
  ) {
    fail(
      'benchmark_leakage',
      'Production behavior depends on certification-only fixtures or scenario metadata.',
    );
  }

  const failureCodes = [...new Set(failures.map((failure) => failure.code))];
  return { passed: failures.length === 0, failureCodes, failures };
}

export const PRODUCTION_APPRENTICESHIP_CERTIFICATION_FAILURE_CODES = [
  'schema_invalid',
  'fatal_error',
  'implementation_incomplete',
  'execution_mode_invalid',
  'scenario_inventory_invalid',
  'scenario_not_executed',
  'scenario_failed',
  'scenario_origin_invalid',
  'scenario_assertion_missing',
  'scenario_evidence_missing',
  'network_guard_unproven',
  'network_escape',
  'provider_call_observed',
  'cost_nonzero',
  'external_effect_observed',
  'production_write_observed',
  'unauthorized_effect',
  'duplicate_effect',
  'owner_evidence_invalid',
  'privacy_leak',
  'cleanup_residue',
  'benchmark_leakage',
] as const satisfies readonly ProductionApprenticeshipCertificationFailureCode[];
