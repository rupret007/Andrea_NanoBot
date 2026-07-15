import { createHash } from 'node:crypto';

import {
  getCapabilityAcquisition,
  listReliabilityObservations,
  upsertReliabilityObservation,
  upsertToolReliabilitySubject,
} from './db.js';
import {
  buildReleaseReadinessCandidateContract,
  ProductionCapabilityBindingRegistry,
  releaseReadinessCapabilityResource,
} from './production-capability-apprenticeship.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityCandidateContract,
  ReliabilityObservation,
} from './types.js';
import {
  assertCapabilityCandidateContract,
  canonicalCapabilityJson,
  parseCapabilityJson,
} from './capability-acquisition-policy.js';
import {
  compileCapabilityCandidate,
  createHermeticCertificationBindingRegistry,
  observeCapabilityGap,
  prepareCapabilityExecutionScope,
  prepareCapabilitySandbox,
  recordCapabilityHeldOutEvidence,
  recordCapabilityResourceDiscovery,
  runCapabilitySandbox,
  scopeCapabilityAcquisition,
} from './verified-capability-acquisition.js';

const PREPARATION_OWNER = 'certification:release-readiness-owner';
const PREPARATION_CHAT = 'certification:release-readiness-chat';
const PREPARATION_CHANNEL = 'certification';
const PREPARATION_TARGET = 'release-readiness-preproduction-v1';
const RELEASE_READINESS_HEALTH_SUBJECT =
  'capability-resource:andrea.release_readiness_truth';
const HEALTH_TTL_MS = 30 * 60 * 1_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertHermeticPreparationProcess(): void {
  if (
    process.env.ANDREA_TEST_NETWORK_GUARD_ACTIVE !== '1' ||
    process.env.ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT !== '1' ||
    process.env.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE !== '1'
  ) {
    throw new Error(
      'Release-readiness candidate preparation requires the offline, provider-suppressed certification process.',
    );
  }
}

function currentContract(
  acquisition: CapabilityAcquisitionRecord,
): CapabilityCandidateContract {
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    acquisition.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  return contract;
}

function releaseReadinessObservationId(params: {
  acquisitionId: string;
  observedAt: string;
  fingerprint: string;
}): string {
  return `release-readiness-health:${sha256(
    canonicalCapabilityJson(params),
  ).slice(0, 40)}`;
}

function recordReleaseReadinessHealth(params: {
  acquisitionId: string;
  observedAt: string;
  fingerprint: string;
  evidenceRefs: string[];
}): ReliabilityObservation {
  const resource = releaseReadinessCapabilityResource();
  upsertToolReliabilitySubject({
    subjectId: RELEASE_READINESS_HEALTH_SUBJECT,
    subjectKind: 'capability',
    displayName: 'Andrea release-readiness truth',
    aliasesJson: JSON.stringify([resource.resourceId]),
    riskLevel: 'low',
    approvalRequirement: 'none',
    channelsJson: JSON.stringify(['owner_cockpit', 'telegram', 'bluebubbles']),
    sourceRefsJson: JSON.stringify(resource.sourceRefs),
    privacyJson: JSON.stringify({
      metadataOnly: true,
      rawContentStored: false,
    }),
  });
  const observation: ReliabilityObservation = {
    observationId: releaseReadinessObservationId(params),
    subjectId: RELEASE_READINESS_HEALTH_SUBJECT,
    observedAt: params.observedAt,
    sourceKind: 'verified_usage',
    outcome: 'success',
    failureClass: 'none',
    confidence: 1,
    fallbackUsed: false,
    latencyMs: 0,
    summary:
      'Bundled release-readiness lookup and independent verifier agreed.',
    nextAction: 'Use only the exact version-pinned read-only binding.',
    evidenceIdsJson: JSON.stringify(params.evidenceRefs),
    privacyJson: JSON.stringify({
      metadataOnly: true,
      rawContentStored: false,
    }),
  };
  upsertReliabilityObservation(observation);
  return observation;
}

async function runActualHeldOutProof(params: {
  acquisitionId: string;
  contract: CapabilityCandidateContract;
  values: Record<string, unknown>;
  observedAt: string;
}): Promise<ReliabilityObservation> {
  const step = params.contract.steps[0];
  if (
    !step ||
    params.contract.steps.length !== 1 ||
    step.actionClass !== 'local_lookup' ||
    !step.readOnly ||
    step.approvalRequired ||
    params.contract.dataEgressClass !== 'none'
  ) {
    throw new Error(
      'Release-readiness held-out proof rejected an authority or egress expansion.',
    );
  }
  const registry = ProductionCapabilityBindingRegistry.createBundled();
  const executor = registry.resolveExecutor(step);
  const evaluator = registry.resolveEvaluator(step);
  if (
    executor.networkAccess === 'external' ||
    executor.effectClass !== 'read_only' ||
    executor.maximumCostUsd !== 0
  ) {
    throw new Error(
      'Release-readiness held-out executor is not non-external, read-only, and zero-cost.',
    );
  }
  const result = await executor.execute({
    values: params.values,
    idempotencyKey: sha256(
      `${params.acquisitionId}|release-readiness-heldout-v1`,
    ),
  });
  const verification = await evaluator.verify({
    values: params.values,
    result,
    requiredPostconditions: params.contract.successPostconditions,
  });
  const failures = [
    ...(!verification.verified ? ['verifier_rejected'] : []),
    ...(!verification.postconditionFingerprint
      ? ['missing_postcondition_fingerprint']
      : []),
    ...(result.effectClass !== 'read_only' ? ['effect_not_read_only'] : []),
    ...(result.effectStatus === 'unknown' ? ['effect_unknown'] : []),
    ...((result.providerCalls || 0) !== 0 ? ['provider_call_detected'] : []),
    ...((result.costUsd || 0) !== 0 ? ['nonzero_cost'] : []),
  ];
  if (failures.length > 0) {
    throw new Error(
      `Release-readiness held-out proof did not produce independently verified zero-cost evidence: ${failures.join(', ')} (${verification.reason}).`,
    );
  }
  const fingerprint = verification.postconditionFingerprint;
  if (!fingerprint) {
    throw new Error(
      'Release-readiness verifier omitted its required fingerprint.',
    );
  }
  return recordReleaseReadinessHealth({
    acquisitionId: params.acquisitionId,
    observedAt: params.observedAt,
    fingerprint,
    evidenceRefs: verification.evidenceRefs,
  });
}

export interface PreparedReleaseReadinessCandidate {
  acquisition: CapabilityAcquisitionRecord;
  contract: CapabilityCandidateContract;
  healthObservation: ReliabilityObservation | null;
  suggestedHealthExpiry: string | null;
}

/**
 * Creates only synthetic preproduction evidence in the canonical ledger. It
 * cannot authorize a canary, record an owner verdict, or activate capability
 * reuse. Repeated calls resume the same deterministic candidate.
 */
export async function prepareReleaseReadinessCandidate(params: {
  groupFolder: string;
  now?: Date;
}): Promise<PreparedReleaseReadinessCandidate> {
  assertHermeticPreparationProcess();
  const now = params.now || new Date();
  const nowIso = now.toISOString();
  const resource = releaseReadinessCapabilityResource();
  const presentation = buildReleaseReadinessCandidateContract();
  let acquisition = observeCapabilityGap({
    metadataClassification: 'derived_metadata',
    groupFolder: params.groupFolder,
    targetOutcome: presentation.title,
    postconditions: [...presentation.successPostconditions],
    taskFamily: presentation.taskFamily,
    gapKind: 'composable',
    knownPrerequisites: ['canonical local status surfaces'],
    missingPrerequisites: [],
    candidateResources: [resource],
    riskLevel: 'low',
    dataEgressClass: 'none',
    expectedCostBand: 'zero',
    expectedLatencyBand: 'interactive',
    authorityRequirements: [],
    confidence: 1,
    provenanceRefs: [
      'deterministic:release-readiness-sandbox-v1',
      'deterministic:release-readiness-heldout-v1',
    ],
    evidenceOrigin: 'synthetic',
    environmentFingerprint: 'offline-provider-suppressed-network-denied-v1',
    now,
  });

  if (acquisition.state === 'observed') {
    acquisition = scopeCapabilityAcquisition({
      acquisitionId: acquisition.acquisitionId,
      knownPrerequisites: ['canonical local status surfaces'],
      missingPrerequisites: [],
      confidence: 1,
      now,
    });
  }
  if (acquisition.state === 'scoped') {
    acquisition = recordCapabilityResourceDiscovery({
      acquisitionId: acquisition.acquisitionId,
      candidates: [resource],
      selected: [resource],
      rejectedReasons: {},
      now,
    });
  }
  let contract: CapabilityCandidateContract;
  if (acquisition.state === 'resource_discovery') {
    const compiled = compileCapabilityCandidate({
      acquisitionId: acquisition.acquisitionId,
      selectedResources: [resource],
      triggerSemantics: [...presentation.triggerSemantics],
      requiredInputs: [...presentation.requiredInputs],
      optionalInputs: [...presentation.optionalInputs],
      expectedOutput: presentation.expectedOutput,
      fallbackPaths: [...presentation.fallbackPaths],
      deterministicScenarioIds: [...presentation.deterministicScenarioIds],
      heldOutScenarioIds: [...presentation.heldOutScenarioIds],
      now,
    });
    acquisition = compiled.record;
    contract = compiled.contract;
  } else {
    contract = currentContract(acquisition);
  }

  if (acquisition.state === 'candidate_designed') {
    acquisition = prepareCapabilitySandbox({
      acquisitionId: acquisition.acquisitionId,
      now,
    });
  }
  const values = { targetScopeKey: PREPARATION_TARGET };
  if (
    acquisition.state === 'sandbox_ready' ||
    acquisition.state === 'sandbox_running'
  ) {
    const step = contract.steps[0];
    if (!step || contract.steps.length !== 1) {
      throw new Error('Release-readiness sandbox requires one exact step.');
    }
    const fixtureFingerprint = sha256(
      canonicalCapabilityJson({
        candidateFingerprint: contract.candidateFingerprint,
        fixture: 'release-readiness-sandbox-v1',
      }),
    );
    const registry = createHermeticCertificationBindingRegistry({
      executors: [
        {
          bindingId: step.bindingId,
          operationId: step.operationId,
          resourceId: step.resourceId,
          version: step.version,
          executorImplementationDigest: step.executorImplementationDigest,
          actionClass: step.actionClass,
          effectClass: 'read_only',
          networkAccess: 'none',
          async execute() {
            return {
              result: {
                result: 'synthetic release-readiness fixture',
                evidenceRefs: ['deterministic:release-readiness-sandbox-v1'],
              },
              evidenceRefs: ['deterministic:release-readiness-sandbox-v1'],
              effectClass: 'read_only',
              effectStatus: 'certain',
              preStateFingerprint: fixtureFingerprint,
              postStateFingerprint: fixtureFingerprint,
              providerCalls: 0,
              costUsd: 0,
            };
          },
        },
      ],
      evaluators: [
        {
          evaluatorId: step.evaluatorId,
          operationId: step.operationId,
          resourceId: step.resourceId,
          version: step.version,
          evaluatorImplementationDigest: step.evaluatorImplementationDigest,
          async verify({ requiredPostconditions }) {
            return {
              verified: requiredPostconditions.length > 0,
              evidenceRefs: [
                'deterministic:release-readiness-sandbox-verifier-v1',
              ],
              verifiedPostconditions: [...requiredPostconditions],
              postconditionFingerprint: fixtureFingerprint,
              reason:
                'Synthetic sandbox fixture satisfied the closed read-only contract.',
            };
          },
        },
      ],
    });
    const scope = prepareCapabilityExecutionScope({
      acquisitionId: acquisition.acquisitionId,
      ownerId: PREPARATION_OWNER,
      chatId: PREPARATION_CHAT,
      groupId: params.groupFolder,
      channel: PREPARATION_CHANNEL,
      targetScopeKey: PREPARATION_TARGET,
      now,
    });
    acquisition = await runCapabilitySandbox({
      acquisitionId: acquisition.acquisitionId,
      values,
      registry,
      currentResources: [resource],
      scope,
      networkPolicy: 'none',
      now,
    });
  }

  let healthObservation: ReliabilityObservation | null = null;
  if (acquisition.state === 'sandbox_verified') {
    healthObservation = await runActualHeldOutProof({
      acquisitionId: acquisition.acquisitionId,
      contract,
      values,
      observedAt: nowIso,
    });
    acquisition = recordCapabilityHeldOutEvidence({
      acquisitionId: acquisition.acquisitionId,
      evidence: {
        passed: true,
        cases: 2,
        safetyInvariantRate: 1,
        falseSuccesses: 0,
        evidenceRefs: [
          'deterministic:release-readiness-heldout-live-binding-v1',
          healthObservation.observationId,
        ],
      },
      actorKind: 'certification',
      now,
    });
  } else {
    const nowMs = now.getTime();
    healthObservation =
      listReliabilityObservations({ limit: 5_000 })
        .filter((item) => {
          const observedAtMs = Date.parse(item.observedAt);
          return (
            item.subjectId === RELEASE_READINESS_HEALTH_SUBJECT &&
            item.sourceKind === 'verified_usage' &&
            item.outcome === 'success' &&
            item.confidence === 1 &&
            item.fallbackUsed === false &&
            Number.isFinite(observedAtMs) &&
            observedAtMs <= nowMs &&
            observedAtMs + HEALTH_TTL_MS > nowMs
          );
        })
        .sort((left, right) =>
          right.observedAt.localeCompare(left.observedAt),
        )[0] || null;
    if (!healthObservation && acquisition.state === 'owner_review_required') {
      healthObservation = await runActualHeldOutProof({
        acquisitionId: acquisition.acquisitionId,
        contract,
        values,
        observedAt: nowIso,
      });
    }
  }
  const latest =
    getCapabilityAcquisition(acquisition.acquisitionId) || acquisition;
  if (latest.state !== 'owner_review_required') {
    throw new Error(
      `Release-readiness preparation stopped at unexpected state ${latest.state}.`,
    );
  }
  return {
    acquisition: latest,
    contract,
    healthObservation,
    suggestedHealthExpiry: healthObservation
      ? new Date(
          new Date(healthObservation.observedAt).getTime() + HEALTH_TTL_MS,
        ).toISOString()
      : null,
  };
}
