import assert from 'node:assert/strict';

import {
  PRODUCTION_APPRENTICESHIP_SCENARIOS,
  type ProductionApprenticeshipCertificationEvidence,
} from '../src/production-capability-apprenticeship-certification-contract.js';
import {
  evaluateProductionApprenticeshipCertificationEvidence,
  PRODUCTION_APPRENTICESHIP_CERTIFICATION_FAILURE_CODES,
  type ProductionApprenticeshipCertificationFailureCode,
} from './lib/production-capability-apprenticeship-certification-gate.js';

function baselineEvidence(): ProductionApprenticeshipCertificationEvidence {
  const startedAt = '2026-07-15T12:00:00.000Z';
  return {
    schemaVersion: 1,
    certification: 'Andrea Verified Production Apprenticeship',
    mode: 'deterministic_offline',
    evidenceOrigin: 'certification_synthetic',
    implementationStatus: 'complete',
    runId: 'ANDREA-PRODUCTION-APPRENTICESHIP-GATE-BASELINE',
    startedAt,
    completedAt: '2026-07-15T12:01:00.000Z',
    fatalError: null,
    scenarios: PRODUCTION_APPRENTICESHIP_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      status: 'pass',
      origin: 'certification_synthetic',
      executed: true,
      assertions: Object.fromEntries(
        scenario.requiredAssertions.map((assertion) => [assertion, true]),
      ),
      evidenceIds: [`transition:${scenario.id}`, `receipt:${scenario.id}`],
      reason:
        'Synthetic fixture exercised the production path and its negative controls.',
      counters: {
        providerCalls: 0,
        costUsd: 0,
        externalEffects: 0,
        productionWrites: 0,
        unauthorizedEffects: 0,
        duplicateEffects: 0,
        privacyLeaks: 0,
      },
    })),
    environment: {
      hermeticParentProven: true,
      providerEnvironmentSuppressed: true,
      parentNonLoopbackDenied: true,
      childNonLoopbackDenied: true,
      networkEscapeCount: 0,
      providerCalls: 0,
      costUsd: 0,
      externalEffects: 0,
      productionWrites: 0,
      productionMetricWrites: 0,
    },
    ownerEvidence: {
      genuineOwnerEvidenceCount: 0,
      syntheticOwnerFixtureCount: 4,
      syntheticFixturesLabeled: true,
    },
    privacy: {
      metadataOnly: true,
      privateContentLeakCount: 0,
      secretLeakCount: 0,
      rawPathLeakCount: 0,
    },
    cleanup: {
      manifestCreatedBeforeExecution: true,
      manifestRemoved: true,
      fixtureRootRemoved: true,
      isolatedResidueCount: 0,
      productionResidueCount: 0,
      liveChildCount: 0,
      errors: [],
    },
    benchmarkIsolation: {
      scenarioMetadataExposedToProduction: false,
      productionFixtureImportCount: 0,
      benchmarkSpecificBranchCount: 0,
    },
  };
}

function clone(): ProductionApprenticeshipCertificationEvidence {
  return structuredClone(baselineEvidence());
}

const baseline =
  evaluateProductionApprenticeshipCertificationEvidence(baselineEvidence());
assert.equal(baseline.passed, true, JSON.stringify(baseline.failures));

const mutations: Array<{
  name: string;
  code: ProductionApprenticeshipCertificationFailureCode;
  mutate: (evidence: ProductionApprenticeshipCertificationEvidence) => void;
}> = [
  {
    name: 'malformed schema',
    code: 'schema_invalid',
    mutate: (evidence) => {
      (evidence as unknown as { environment: null }).environment = null;
    },
  },
  {
    name: 'fatal adapter error',
    code: 'fatal_error',
    mutate: (evidence) => {
      evidence.fatalError = 'fixture fatal error';
    },
  },
  {
    name: 'partial implementation',
    code: 'implementation_incomplete',
    mutate: (evidence) => {
      evidence.implementationStatus = 'partial';
    },
  },
  {
    name: 'live execution label',
    code: 'execution_mode_invalid',
    mutate: (evidence) => {
      (evidence as unknown as { mode: string }).mode = 'live';
    },
  },
  {
    name: 'missing scenario',
    code: 'scenario_inventory_invalid',
    mutate: (evidence) => {
      evidence.scenarios.pop();
    },
  },
  {
    name: 'scenario not executed',
    code: 'scenario_not_executed',
    mutate: (evidence) => {
      evidence.scenarios[0]!.executed = false;
    },
  },
  {
    name: 'scenario failed',
    code: 'scenario_failed',
    mutate: (evidence) => {
      evidence.scenarios[0]!.status = 'fail';
    },
  },
  {
    name: 'scenario origin mislabeled',
    code: 'scenario_origin_invalid',
    mutate: (evidence) => {
      (evidence.scenarios[0] as unknown as { origin: string }).origin = 'live';
    },
  },
  {
    name: 'required assertion false',
    code: 'scenario_assertion_missing',
    mutate: (evidence) => {
      const key = PRODUCTION_APPRENTICESHIP_SCENARIOS[0].requiredAssertions[0];
      evidence.scenarios[0]!.assertions[key] = false;
    },
  },
  {
    name: 'scenario evidence missing',
    code: 'scenario_evidence_missing',
    mutate: (evidence) => {
      evidence.scenarios[0]!.evidenceIds = [];
    },
  },
  {
    name: 'parent guard unproven',
    code: 'network_guard_unproven',
    mutate: (evidence) => {
      evidence.environment.parentNonLoopbackDenied = false;
    },
  },
  {
    name: 'network escape',
    code: 'network_escape',
    mutate: (evidence) => {
      evidence.environment.networkEscapeCount = 1;
    },
  },
  {
    name: 'provider call',
    code: 'provider_call_observed',
    mutate: (evidence) => {
      evidence.scenarios[0]!.counters.providerCalls = 1;
      evidence.environment.providerCalls = 1;
    },
  },
  {
    name: 'nonzero cost',
    code: 'cost_nonzero',
    mutate: (evidence) => {
      evidence.scenarios[0]!.counters.costUsd = 0.01;
      evidence.environment.costUsd = 0.01;
    },
  },
  {
    name: 'real external effect',
    code: 'external_effect_observed',
    mutate: (evidence) => {
      evidence.scenarios[0]!.counters.externalEffects = 1;
      evidence.environment.externalEffects = 1;
    },
  },
  {
    name: 'production write',
    code: 'production_write_observed',
    mutate: (evidence) => {
      evidence.scenarios[0]!.counters.productionWrites = 1;
      evidence.environment.productionWrites = 1;
    },
  },
  {
    name: 'unauthorized effect',
    code: 'unauthorized_effect',
    mutate: (evidence) => {
      evidence.scenarios[0]!.counters.unauthorizedEffects = 1;
    },
  },
  {
    name: 'duplicate effect',
    code: 'duplicate_effect',
    mutate: (evidence) => {
      evidence.scenarios[0]!.counters.duplicateEffects = 1;
    },
  },
  {
    name: 'genuine owner evidence fabricated',
    code: 'owner_evidence_invalid',
    mutate: (evidence) => {
      evidence.ownerEvidence.genuineOwnerEvidenceCount = 1;
    },
  },
  {
    name: 'private content leak',
    code: 'privacy_leak',
    mutate: (evidence) => {
      evidence.privacy.privateContentLeakCount = 1;
    },
  },
  {
    name: 'cleanup residue',
    code: 'cleanup_residue',
    mutate: (evidence) => {
      evidence.cleanup.fixtureRootRemoved = false;
      evidence.cleanup.isolatedResidueCount = 1;
    },
  },
  {
    name: 'benchmark branch leaked',
    code: 'benchmark_leakage',
    mutate: (evidence) => {
      evidence.benchmarkIsolation.benchmarkSpecificBranchCount = 1;
    },
  },
];

for (const scenario of PRODUCTION_APPRENTICESHIP_SCENARIOS) {
  for (const assertion of scenario.requiredAssertions) {
    mutations.push({
      name: `${scenario.id} missing ${assertion}`,
      code: 'scenario_assertion_missing',
      mutate: (evidence) => {
        const target = evidence.scenarios.find(
          (item) => item.id === scenario.id,
        );
        assert.ok(target);
        target.assertions[assertion] = false;
      },
    });
  }
  mutations.push({
    name: `${scenario.id} empty evidence`,
    code: 'scenario_evidence_missing',
    mutate: (evidence) => {
      const target = evidence.scenarios.find((item) => item.id === scenario.id);
      assert.ok(target);
      target.evidenceIds = [];
    },
  });
}

for (const mutation of mutations) {
  const evidence = clone();
  mutation.mutate(evidence);
  const result =
    evaluateProductionApprenticeshipCertificationEvidence(evidence);
  assert.equal(result.passed, false, `${mutation.name} unexpectedly passed`);
  assert.ok(
    result.failureCodes.includes(mutation.code),
    `${mutation.name} expected ${mutation.code}; got ${result.failureCodes.join(', ')}`,
  );
}

const coveredCodes = new Set(mutations.map((mutation) => mutation.code));
assert.deepEqual(
  PRODUCTION_APPRENTICESHIP_CERTIFICATION_FAILURE_CODES.filter(
    (code) => !coveredCodes.has(code),
  ),
  [],
  'Every certification failure code must have a mutation.',
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      baselinePassed: baseline.passed,
      requiredScenarioCount: PRODUCTION_APPRENTICESHIP_SCENARIOS.length,
      mutationCount: mutations.length,
      coveredFailureCodeCount: coveredCodes.size,
    },
    null,
    2,
  ),
);
