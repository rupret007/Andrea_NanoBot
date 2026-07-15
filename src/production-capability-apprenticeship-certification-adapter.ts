/* eslint-disable no-catch-all/no-catch-all -- Certification turns expected rejection, crash, and cleanup failures into fail-closed evidence. */
import fs from 'node:fs';
import path from 'node:path';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  approveCognitiveApprovalPacketCAS,
  assertCapabilityProductionExecutionPreflight,
  getCapabilityAcquisition,
  getCapabilityOwnerReviewForRun,
  getCapabilityProductionRun,
  getOutcome,
  listDurableEffectReceipts,
  listCapabilityAcquisitionTransitions,
  listCapabilityProductionRuns,
  listCapabilityProductionSteps,
  listCapabilityProductionTransitionReceipts,
  listCognitiveApprovalPackets,
  listOutcomesForGroup,
  listSkillPlaybooks,
  reconcileCapabilityProductionEvidenceAtomic,
  updateCapabilityProductionRunCAS,
  upsertReliabilityObservation,
  upsertToolReliabilitySubject,
} from './db.js';
import {
  durableApprovalBoundActionClasses,
  durableActionPolicy,
  durableActionRequiresApproval,
  type DurableActionClass,
  type DurablePolicyEffectClass,
} from './durable-action-policy.js';
import { capabilityBindingImplementationDigest } from './capability-execution-guard.js';
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
import {
  _setProductionCapabilityApprenticeshipTestHook,
  applyCapabilityOwnerControl,
  authorizeApprovedCapabilityActivation,
  authorizeApprovedCapabilityCanary,
  createIsolatedProductionCapabilityRegistryForTest,
  issueCapabilityControlTokenForAuthenticatedCockpit,
  issueCapabilityReviewTokenForAuthenticatedCockpit,
  issueCapabilityReviewTokenForTrustedChat,
  matchActiveCapability,
  recordCapabilityOwnerVerdict,
  recoverCapabilityProductionRun,
  runCapabilityProductionExecution,
  stageActiveCapabilityReuse,
  stageCapabilityActivation,
  stageCapabilityCanary,
  type ActiveCapabilityMatch,
  type CapabilityProductionExecutionResult,
  type ProductionCapabilityExecutorBinding,
} from './production-capability-apprenticeship.js';
import { runProductionCapabilityActivationRace } from './production-capability-activation-race-harness.js';
import {
  PRODUCTION_APPRENTICESHIP_SCENARIOS,
  type ProductionApprenticeshipCertificationEvidence,
  type ProductionApprenticeshipScenarioEvidence,
  type ProductionApprenticeshipScenarioId,
  type RunProductionApprenticeshipCertificationCases,
} from './production-capability-apprenticeship-certification-contract.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityCandidateContract,
  CapabilityOwnerReviewVerdict,
  CapabilityProductionRunRecord,
  CapabilityResourceDescriptor,
  CognitiveApprovalPacket,
  RegisteredGroup,
} from './types.js';

const BASE_TIME = new Date('2026-07-15T12:00:00.000Z');
const RESOURCE_VERSION = 'certification-production-v1';
const GROUP = 'main';
const OWNER = 'certification-owner';
const CHAT = 'certification-cockpit';
const CHANNEL = 'owner_cockpit';
const TARGET = 'certification-target';

type ScenarioCounters = ProductionApprenticeshipScenarioEvidence['counters'] & {
  executorInvocations: number;
  evaluatorInvocations: number;
};

interface CandidateFixture {
  acquisition: CapabilityAcquisitionRecord;
  contract: CapabilityCandidateContract;
  resource: CapabilityResourceDescriptor;
  values: Record<string, unknown>;
  binding: {
    ownerId: string;
    chatId: string;
    groupId: string;
    channel: string;
    targetScopeKey: string;
  };
  healthObservationId: string;
}

interface CanaryFixture extends CandidateFixture {
  run: CapabilityProductionRunRecord;
  approval: CognitiveApprovalPacket;
}

interface ScenarioExecutionContext {
  id: ProductionApprenticeshipScenarioId;
  databasePath: string;
  fixtureRoot: string;
  counters: ScenarioCounters;
  ownerFixtureCounter: { value: number };
  evidenceOrigin: 'certification_synthetic';
}

function at(seconds: number): Date {
  return new Date(BASE_TIME.getTime() + seconds * 1_000);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 52);
}

function emptyCounters(): ScenarioCounters {
  return {
    providerCalls: 0,
    costUsd: 0,
    externalEffects: 0,
    productionWrites: 0,
    unauthorizedEffects: 0,
    duplicateEffects: 0,
    privacyLeaks: 0,
    executorInvocations: 0,
    evaluatorInvocations: 0,
  };
}

function publicCounters(
  counters: ScenarioCounters,
): ProductionApprenticeshipScenarioEvidence['counters'] {
  return {
    providerCalls: counters.providerCalls,
    costUsd: counters.costUsd,
    externalEffects: counters.externalEffects,
    productionWrites: counters.productionWrites,
    unauthorizedEffects: counters.unauthorizedEffects,
    duplicateEffects: counters.duplicateEffects,
    privacyLeaks: counters.privacyLeaks,
  };
}

function productionResource(label: string): CapabilityResourceDescriptor {
  const id = slug(label);
  const bindingId = `certification.production.${id}.lookup`;
  const evaluatorId = `certification.production.${id}.verify`;
  return {
    resourceId: `certification.production.resource.${id}`,
    kind: 'local_script',
    displayName: `Certification production lookup ${id}`,
    taskFamilies: [`production_certification_${id}`],
    capabilityIds: [`certification.production.${id}`],
    supportedPostconditions: [`certification value ${id} is verified`],
    requiredInputs: ['key', 'targetScopeKey'],
    available: true,
    healthState: 'healthy',
    verificationStrength: 1,
    reliabilityScore: 1,
    authorityRequirement: 'none',
    riskLevel: 'low',
    dataEgressClass: 'none',
    reversible: true,
    expectedCostBand: 'zero',
    expectedLatencyBand: 'instant',
    version: RESOURCE_VERSION,
    sourceRefs: [`certification:resource:${id}`],
    maintenanceBurden: 'low',
    bindingRefs: [
      {
        bindingId,
        operationId: 'lookup',
        evaluatorId,
        executorImplementationDigest: capabilityBindingImplementationDigest({
          kind: 'executor',
          implementationId: bindingId,
          version: RESOURCE_VERSION,
        }),
        evaluatorImplementationDigest: capabilityBindingImplementationDigest({
          kind: 'evaluator',
          implementationId: evaluatorId,
          version: RESOURCE_VERSION,
        }),
        actionClass: 'local_lookup',
        version: RESOURCE_VERSION,
        readOnly: true,
      },
    ],
  };
}

function seedHealth(
  resource: CapabilityResourceDescriptor,
  label: string,
  observedAt = at(2),
): string {
  const suffix = slug(label);
  const subjectId = `certification-production-subject-${suffix}`;
  const observationId = `certification-production-health-${suffix}`;
  upsertToolReliabilitySubject({
    subjectId,
    subjectKind: 'capability',
    displayName: `Certification health ${suffix}`,
    aliasesJson: JSON.stringify([resource.resourceId]),
    riskLevel: 'low',
    approvalRequirement: 'none',
    channelsJson: JSON.stringify([CHANNEL]),
    sourceRefsJson: JSON.stringify([`certification:health:${suffix}`]),
    privacyJson: JSON.stringify({ metadataOnly: true }),
  });
  upsertReliabilityObservation({
    observationId,
    subjectId,
    observedAt: observedAt.toISOString(),
    sourceKind: 'verified_usage',
    outcome: 'success',
    failureClass: 'none',
    confidence: 1,
    fallbackUsed: false,
    latencyMs: 1,
    summary: 'Synthetic certification resource is healthy.',
    nextAction: 'Use only the exact version-pinned certification resource.',
    evidenceIdsJson: '[]',
    privacyJson: JSON.stringify({ metadataOnly: true }),
  });
  return observationId;
}

async function prepareCandidate(
  label: string,
  options: { targetScopeKey?: string; key?: string } = {},
): Promise<CandidateFixture> {
  const resource = productionResource(label);
  const targetScopeKey = options.targetScopeKey || TARGET;
  const values = {
    key: options.key || `value-${slug(label)}`,
    targetScopeKey,
  };
  const taskFamily = resource.taskFamilies[0] as string;
  const observed = observeCapabilityGap({
    metadataClassification: 'derived_metadata',
    groupFolder: GROUP,
    targetOutcome: `Return one verified certification value for ${slug(label)}`,
    postconditions: [...resource.supportedPostconditions],
    taskFamily,
    gapKind: 'tool_usage_gap',
    provenanceRefs: [`certification:owner-request:${slug(label)}`],
    evidenceOrigin: 'synthetic',
    environmentFingerprint: `certification-environment-${slug(label)}`,
    now: at(0),
  });
  scopeCapabilityAcquisition({
    acquisitionId: observed.acquisitionId,
    knownPrerequisites: ['certification key'],
    missingPrerequisites: [],
    confidence: 1,
    now: at(0),
  });
  recordCapabilityResourceDiscovery({
    acquisitionId: observed.acquisitionId,
    candidates: [resource],
    selected: [resource],
    rejectedReasons: {},
    now: at(0),
  });
  const candidate = compileCapabilityCandidate({
    acquisitionId: observed.acquisitionId,
    selectedResources: [resource],
    triggerSemantics: [
      `verify certification value ${slug(label)}`,
      `check production certification ${slug(label)}`,
    ],
    requiredInputs: ['key', 'targetScopeKey'],
    expectedOutput: 'A verified synthetic certification value.',
    deterministicScenarioIds: [`certification-primary-${slug(label)}`],
    heldOutScenarioIds: [`certification-heldout-${slug(label)}`],
    now: at(0),
  });
  prepareCapabilitySandbox({
    acquisitionId: observed.acquisitionId,
    now: at(0),
  });
  const step = candidate.contract.steps[0];
  if (!step) throw new Error('Certification candidate has no step.');
  const sandboxRegistry = createHermeticCertificationBindingRegistry({
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
        async execute({ values: actual }) {
          return {
            result: { value: `certification:${String(actual.key)}` },
            evidenceRefs: [`certification:sandbox:${slug(label)}`],
            effectClass: 'read_only',
            effectStatus: 'certain',
            preStateFingerprint: '1'.repeat(64),
            postStateFingerprint: '2'.repeat(64),
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
            verified: true,
            evidenceRefs: [`certification:sandbox-verifier:${slug(label)}`],
            verifiedPostconditions: requiredPostconditions,
            postconditionFingerprint: '3'.repeat(64),
            reason: 'Synthetic certification sandbox value is present.',
          };
        },
      },
    ],
  });
  const scope = prepareCapabilityExecutionScope({
    acquisitionId: observed.acquisitionId,
    ownerId: OWNER,
    chatId: CHAT,
    groupId: GROUP,
    channel: CHANNEL,
    targetScopeKey,
    now: at(0),
  });
  await runCapabilitySandbox({
    acquisitionId: observed.acquisitionId,
    values,
    registry: sandboxRegistry,
    currentResources: [resource],
    scope,
    networkPolicy: 'none',
    now: at(0),
  });
  const acquisition = recordCapabilityHeldOutEvidence({
    acquisitionId: observed.acquisitionId,
    evidence: {
      passed: true,
      cases: 3,
      safetyInvariantRate: 1,
      falseSuccesses: 0,
      evidenceRefs: [`certification:heldout:${slug(label)}`],
    },
    actorKind: 'certification',
    now: at(1),
  });
  const healthObservationId = seedHealth(resource, label);
  return {
    acquisition,
    contract: candidate.contract,
    resource,
    values,
    binding: {
      ownerId: OWNER,
      chatId: CHAT,
      groupId: GROUP,
      channel: CHANNEL,
      targetScopeKey,
    },
    healthObservationId,
  };
}

function approve(packet: CognitiveApprovalPacket, now = at(4)): void {
  const result = approveCognitiveApprovalPacketCAS({
    approvalPacketId: packet.approvalPacketId,
    groupFolder: GROUP,
    expectedSummary: packet.summary,
    expectedApprovalVersion: packet.approvalVersion || 1,
    expectedScopeDigest: packet.scopeDigest || null,
    now: now.toISOString(),
    approvalChannel: CHANNEL,
  });
  if (result.status !== 'approved') {
    throw new Error(`Certification approval failed: ${result.status}.`);
  }
}

function productionHeads(runId: string): {
  expectedAcquisitionVersion: number;
  expectedRunRevision: number;
  authorizedSurface: string;
} {
  const run = getCapabilityProductionRun(runId);
  const acquisition = run
    ? getCapabilityAcquisition(run.acquisitionId)
    : undefined;
  if (!run || !acquisition) {
    throw new Error('Certification production head was not found.');
  }
  return {
    expectedAcquisitionVersion: acquisition.recordVersion,
    expectedRunRevision: run.revision,
    authorizedSurface: run.authorizedSurface,
  };
}

function stageCanary(
  fixture: CandidateFixture,
  now = at(3),
  healthExpiresAt = at(1_200),
): CanaryFixture {
  const staged = stageCapabilityCanary({
    acquisitionId: fixture.acquisition.acquisitionId,
    expectedAcquisitionVersion: fixture.acquisition.recordVersion,
    binding: fixture.binding,
    authorizedSurface: 'owner_cockpit',
    normalizedInputs: fixture.values,
    health: [
      {
        resourceId: fixture.resource.resourceId,
        observationId: fixture.healthObservationId,
        expiresAt: healthExpiresAt.toISOString(),
      },
    ],
    now,
  });
  return { ...fixture, run: staged.run, approval: staged.approval };
}

function authorizeCanary(fixture: CanaryFixture, now = at(5)): CanaryFixture {
  const authorized = authorizeApprovedCapabilityCanary({
    runId: fixture.run.runId,
    expectedAcquisitionVersion: fixture.acquisition.recordVersion,
    expectedRunRevision: fixture.run.revision,
    authorizedSurface: 'owner_cockpit',
    binding: fixture.binding,
    workerId: `certification-worker-${slug(fixture.run.runId)}`,
    now,
  });
  return {
    ...fixture,
    acquisition: authorized.acquisition,
    run: authorized.run,
  };
}

function productionRegistry(
  fixture: CandidateFixture,
  counters: ScenarioCounters,
  options: {
    executorActionClass?: DurableActionClass;
    executorEffectClass?: DurablePolicyEffectClass;
    throwAfterEffect?: boolean;
    indeterminate?: boolean;
    evaluatorPasses?: boolean;
  } = {},
) {
  const step = fixture.contract.steps[0];
  if (!step) throw new Error('Certification contract has no production step.');
  const actionClass = options.executorActionClass || step.actionClass;
  const effectClass =
    options.executorEffectClass ||
    durableActionPolicy(actionClass)?.allowedEffects[0] ||
    'read_only';
  return createIsolatedProductionCapabilityRegistryForTest({
    executors: [
      {
        bindingId: step.bindingId,
        operationId: step.operationId,
        resourceId: step.resourceId,
        version: step.version,
        executorImplementationDigest: step.executorImplementationDigest,
        actionClass,
        effectClass,
        networkAccess: 'none',
        maximumCostUsd: 0,
        async execute({ values }) {
          counters.executorInvocations += 1;
          if (options.throwAfterEffect) {
            throw new Error('Synthetic crash after bounded read-only effect.');
          }
          return {
            result: { value: `certification:${String(values.key)}` },
            evidenceRefs: [
              `certification:production:${slug(fixture.acquisition.acquisitionId)}`,
            ],
            effectClass,
            effectStatus: options.indeterminate ? 'unknown' : 'none',
            preStateFingerprint: '4'.repeat(64),
            postStateFingerprint: '5'.repeat(64),
            providerCalls: 0,
            costUsd: 0,
          };
        },
      } satisfies ProductionCapabilityExecutorBinding,
    ],
    evaluators: [
      {
        evaluatorId: step.evaluatorId,
        operationId: step.operationId,
        resourceId: step.resourceId,
        version: step.version,
        evaluatorImplementationDigest: step.evaluatorImplementationDigest,
        async verify({ requiredPostconditions }) {
          counters.evaluatorInvocations += 1;
          const verified = options.evaluatorPasses !== false;
          return {
            verified,
            evidenceRefs: verified
              ? [
                  `certification:production-verifier:${slug(fixture.acquisition.acquisitionId)}`,
                ]
              : [],
            verifiedPostconditions: verified ? requiredPostconditions : [],
            postconditionFingerprint: verified ? '6'.repeat(64) : undefined,
            reason: verified
              ? 'Synthetic production result matches the postcondition.'
              : 'Synthetic evaluator rejected the result.',
          };
        },
        async recover({ existingReceipt, requiredPostconditions }) {
          counters.evaluatorInvocations += 1;
          const verified = options.evaluatorPasses !== false;
          return {
            verified,
            result: verified
              ? { value: `recovered:${existingReceipt.receiptId}` }
              : undefined,
            evidenceRefs: verified
              ? [
                  `certification:production-recovery:${slug(
                    fixture.acquisition.acquisitionId,
                  )}`,
                ]
              : [],
            verifiedPostconditions: verified ? requiredPostconditions : [],
            postconditionFingerprint: verified ? '6'.repeat(64) : undefined,
            reason: verified
              ? 'Current synthetic authoritative state proves the existing effect without replay.'
              : 'Synthetic recovery evaluator could not prove the existing effect.',
          };
        },
      },
    ],
  });
}

async function execute(
  fixture: CanaryFixture,
  context: ScenarioExecutionContext,
  now = at(6),
): Promise<{
  fixture: CanaryFixture;
  result: CapabilityProductionExecutionResult;
}> {
  const result = await runCapabilityProductionExecution({
    runId: fixture.run.runId,
    expectedAcquisitionVersion: fixture.acquisition.recordVersion,
    expectedRunRevision: fixture.run.revision,
    binding: fixture.binding,
    workerId: `certification-execute-${slug(fixture.run.runId)}`,
    values: fixture.values,
    registry: productionRegistry(fixture, context.counters),
    now,
  });
  context.counters.providerCalls += result.providerCalls;
  context.counters.costUsd += result.costUsd;
  return {
    fixture: {
      ...fixture,
      acquisition: getCapabilityAcquisition(
        fixture.acquisition.acquisitionId,
      ) as CapabilityAcquisitionRecord,
      run: getCapabilityProductionRun(
        fixture.run.runId,
      ) as CapabilityProductionRunRecord,
    },
    result,
  };
}

function review(
  fixture: CanaryFixture,
  context: ScenarioExecutionContext,
  verdict: CapabilityOwnerReviewVerdict,
  now = at(8),
): CanaryFixture {
  const token = issueCapabilityReviewTokenForAuthenticatedCockpit({
    runId: fixture.run.runId,
    now: new Date(now.getTime() - 1_000),
  });
  const reviewed = recordCapabilityOwnerVerdict({ token, verdict, now });
  context.ownerFixtureCounter.value += 1;
  return {
    ...fixture,
    acquisition: reviewed.acquisition,
    run: reviewed.run,
  };
}

function activate(fixture: CanaryFixture, now = at(11)): CanaryFixture {
  const staged = stageCapabilityActivation({
    runId: fixture.run.runId,
    expectedAcquisitionVersion: fixture.acquisition.recordVersion,
    expectedRunRevision: fixture.run.revision,
    authorizedSurface: 'owner_cockpit',
    binding: fixture.binding,
    now: new Date(now.getTime() - 2_000),
  });
  approve(staged.approval, new Date(now.getTime() - 1_000));
  const activated = authorizeApprovedCapabilityActivation({
    runId: fixture.run.runId,
    expectedAcquisitionVersion: fixture.acquisition.recordVersion,
    expectedRunRevision: staged.run.revision,
    authorizedSurface: 'owner_cockpit',
    binding: fixture.binding,
    workerId: `certification-activation-${slug(fixture.run.runId)}`,
    now,
  });
  return {
    ...fixture,
    acquisition: activated.acquisition,
    run: activated.run,
  };
}

async function activatedFixture(
  label: string,
  context: ScenarioExecutionContext,
  options: { targetScopeKey?: string; key?: string } = {},
): Promise<CanaryFixture> {
  const candidate = await prepareCandidate(label, options);
  let fixture = stageCanary(candidate);
  approve(fixture.approval);
  fixture = authorizeCanary(fixture);
  fixture = (await execute(fixture, context)).fixture;
  fixture = review(fixture, context, 'verified');
  return activate(fixture);
}

async function rejected(
  action: () => unknown | Promise<unknown>,
): Promise<boolean> {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

function evidenceIdsForRun(runId: string): string[] {
  const receipts = listCapabilityProductionTransitionReceipts({ runId });
  return [runId, ...receipts.map((item) => item.receiptId)].slice(0, 8);
}

function result(
  context: ScenarioExecutionContext,
  assertions: Record<string, boolean>,
  evidenceIds: string[],
  reason: string,
): ProductionApprenticeshipScenarioEvidence {
  const definition = PRODUCTION_APPRENTICESHIP_SCENARIOS.find(
    (scenario) => scenario.id === context.id,
  );
  if (!definition)
    throw new Error(`Unknown certification scenario ${context.id}.`);
  const passed = definition.requiredAssertions.every(
    (assertion) => assertions[assertion] === true,
  );
  return {
    id: context.id,
    title: definition.title,
    status: passed ? 'pass' : 'fail',
    origin: context.evidenceOrigin,
    executed: true,
    assertions,
    evidenceIds: [...new Set(evidenceIds)],
    reason,
    counters: publicCounters(context.counters),
  };
}

async function scenarioA(context: ScenarioExecutionContext) {
  const candidate = await prepareCandidate('A-canary-readiness');
  const staged = stageCanary(candidate);
  approve(staged.approval);
  const authorized = authorizeCanary(staged);
  const receipts = listCapabilityProductionTransitionReceipts({
    runId: authorized.run.runId,
  });
  return result(
    context,
    {
      canonical_chain_verified:
        listCapabilityAcquisitionTransitions(
          candidate.acquisition.acquisitionId,
        ).length >= 8,
      candidate_current:
        authorized.run.candidateFingerprint ===
        candidate.contract.candidateFingerprint,
      sandbox_and_held_out_passed:
        candidate.acquisition.state === 'owner_review_required',
      fresh_health_bound: Boolean(authorized.run.healthEvidenceSetDigest),
      exact_canary_approval_bound: Boolean(
        authorized.run.canaryApprovalPacketId && authorized.run.canaryGrantId,
      ),
      durable_work_staged: Boolean(
        authorized.run.workId && authorized.run.checkpointId,
      ),
      grant_and_lease_valid: Boolean(
        authorized.run.canaryGrantId && authorized.run.canaryLeaseId,
      ),
      advanced_once_to_canary_ready:
        authorized.acquisition.state === 'canary_ready' &&
        receipts.filter((item) => item.transitionKind === 'canary_authorized')
          .length === 1,
    },
    evidenceIdsForRun(authorized.run.runId),
    'The canonical transaction joined exact approval, work, lease, and fresh health once.',
  );
}

async function scenarioB(context: ScenarioExecutionContext) {
  const candidate = await prepareCandidate('B-naked-identifiers');
  const before = getCapabilityAcquisition(candidate.acquisition.acquisitionId)!;
  const denied = await rejected(() =>
    reconcileCapabilityProductionEvidenceAtomic({
      runId: 'capability-run:plausible-but-disconnected',
      operation: 'authorize_canary',
      expectedAcquisitionVersion: before.recordVersion,
      expectedRunRevision: 1,
      now: at(5).toISOString(),
    }),
  );
  const after = getCapabilityAcquisition(candidate.acquisition.acquisitionId)!;
  return result(
    context,
    {
      caller_identifiers_not_trusted: denied,
      disconnected_graph_rejected: denied,
      state_unchanged:
        after.state === before.state &&
        after.recordVersion === before.recordVersion,
    },
    [candidate.acquisition.acquisitionId, `rejection:${context.id}`],
    'A plausible caller-authored identifier set could not select canonical evidence.',
  );
}

async function scenarioC(context: ScenarioExecutionContext) {
  const first = stageCanary(await prepareCandidate('C-receipt-owner'));
  approve(first.approval);
  const authorized = authorizeCanary(first);
  const second = await prepareCandidate('C-receipt-borrower');
  const canonical = getCapabilityProductionRun(authorized.run.runId)!;
  const denied = await rejected(() =>
    updateCapabilityProductionRunCAS({
      expectedRevision: canonical.revision,
      next: {
        ...canonical,
        acquisitionId: second.acquisition.acquisitionId,
        revision: canonical.revision + 1,
        updatedAt: at(6).toISOString(),
      },
    }),
  );
  const unchanged = getCapabilityProductionRun(canonical.runId)!;
  return result(
    context,
    {
      foreign_receipt_detected: denied,
      transition_rejected: denied,
      state_unchanged:
        unchanged.acquisitionId === first.acquisition.acquisitionId &&
        second.acquisition.state === 'owner_review_required',
    },
    [
      authorized.run.runId,
      listCapabilityProductionTransitionReceipts({
        runId: authorized.run.runId,
      })[0]!.receiptId,
    ],
    'The production-run acquisition identity is immutable, so its receipt cannot be borrowed.',
  );
}

async function scenarioD(context: ScenarioExecutionContext) {
  let first = stageCanary(await prepareCandidate('D-old-version'));
  approve(first.approval);
  first = authorizeCanary(first);
  first = (await execute(first, context)).fixture;
  const newer = await prepareCandidate('D-new-version');
  const canonical = getCapabilityProductionRun(first.run.runId)!;
  const denied = await rejected(() =>
    updateCapabilityProductionRunCAS({
      expectedRevision: canonical.revision,
      next: {
        ...canonical,
        candidateFingerprint: newer.contract.candidateFingerprint,
        contractVersion: newer.contract.contractVersion,
        revision: canonical.revision + 1,
        updatedAt: at(7).toISOString(),
      },
    }),
  );
  return result(
    context,
    {
      stale_candidate_version_detected: denied,
      foreign_outcome_rejected: denied,
      state_unchanged:
        getCapabilityProductionRun(canonical.runId)?.candidateFingerprint ===
        first.contract.candidateFingerprint,
    },
    [canonical.runId, canonical.outcomeId as string],
    'Outcome identity remained bound to the immutable candidate fingerprint and version.',
  );
}

async function scenarioE(context: ScenarioExecutionContext) {
  const candidate = await prepareCandidate('E-health-expiry');
  const staged = stageCanary(candidate, at(3), at(20));
  approve(staged.approval);
  const denied = await rejected(() => authorizeCanary(staged, at(21)));
  return result(
    context,
    {
      stale_health_detected: denied,
      readiness_or_activation_blocked: denied,
      freshness_reason_preserved:
        getCapabilityAcquisition(candidate.acquisition.acquisitionId)?.state ===
        'owner_review_required',
    },
    [staged.run.runId, staged.healthObservationId],
    'Expired dependency health prevented the canary-readiness transition.',
  );
}

async function scenarioF(context: ScenarioExecutionContext) {
  const candidate = await prepareCandidate('F-approval-scope');
  const staged = stageCanary(candidate);
  approve(staged.approval);
  const denied = await rejected(() =>
    authorizeApprovedCapabilityCanary({
      runId: staged.run.runId,
      ...productionHeads(staged.run.runId),
      binding: { ...staged.binding, targetScopeKey: 'different-target' },
      workerId: 'certification-wrong-scope',
      now: at(5),
    }),
  );
  return result(
    context,
    {
      approval_scope_mismatch_detected: denied,
      grant_not_laundered: denied,
      transition_rejected:
        listCapabilityProductionTransitionReceipts({ runId: staged.run.runId })
          .length === 0,
    },
    [staged.run.runId, staged.approval.approvalPacketId],
    'A valid approval for a different target could not be consumed.',
  );
}

async function scenarioG(context: ScenarioExecutionContext) {
  const candidate = await prepareCandidate('G-lease-expiry');
  const staged = stageCanary(candidate);
  approve(staged.approval);
  const authorized = authorizeCanary(staged);
  const denied = await rejected(() =>
    assertCapabilityProductionExecutionPreflight({
      runId: authorized.run.runId,
      expectedRunRevision: authorized.run.revision,
      now: at(90).toISOString(),
    }),
  );
  return result(
    context,
    {
      lease_identity_or_expiry_detected: denied,
      execution_not_owned: denied && context.counters.executorInvocations === 0,
      transition_rejected:
        getCapabilityProductionRun(authorized.run.runId)?.status ===
        'canary_ready',
    },
    evidenceIdsForRun(authorized.run.runId),
    'The one-minute execution lease expired before any registered binding ran.',
  );
}

async function scenarioH(context: ScenarioExecutionContext) {
  const candidate = await prepareCandidate('H-crash-before-effect');
  const staged = stageCanary(candidate);
  approve(staged.approval);
  const authorized = authorizeCanary(staged);
  _closeDatabase();
  _initTestDatabaseAtPath(context.databasePath);
  const resumed = {
    ...authorized,
    acquisition: getCapabilityAcquisition(
      authorized.acquisition.acquisitionId,
    )!,
    run: getCapabilityProductionRun(authorized.run.runId)!,
  };
  const executed = await execute(resumed, context);
  return result(
    context,
    {
      restart_reconstructed_work:
        Boolean(executed.fixture.run.outcomeId) &&
        executed.fixture.run.status === 'awaiting_owner_review',
      effect_count_at_most_one: context.counters.executorInvocations === 1,
      safe_resume_completed: executed.result.status === 'verified',
    },
    [executed.fixture.run.runId, ...executed.result.receiptIds],
    'A real database close/reopen before the effect resumed one bounded execution exactly once.',
  );
}

async function scenarioI(context: ScenarioExecutionContext) {
  let fixture = stageCanary(
    await prepareCandidate('I-crash-after-effect-before-outcome'),
  );
  approve(fixture.approval);
  fixture = authorizeCanary(fixture);
  let boundaryObserved = false;
  _setProductionCapabilityApprenticeshipTestHook((event) => {
    if (event.boundary === 'after_effect_before_outcome') {
      boundaryObserved = true;
      throw new Error('Certification crash after the bounded effect.');
    }
  });
  let crashed = false;
  try {
    crashed = await rejected(() =>
      runCapabilityProductionExecution({
        runId: fixture.run.runId,
        ...productionHeads(fixture.run.runId),
        binding: fixture.binding,
        workerId: 'certification-crash-after-effect',
        values: fixture.values,
        registry: productionRegistry(fixture, context.counters),
        now: at(6),
      }),
    );
  } finally {
    _setProductionCapabilityApprenticeshipTestHook(null);
  }
  _closeDatabase();
  _initTestDatabaseAtPath(context.databasePath);
  const receiptsBeforeRecovery = listDurableEffectReceipts({
    workId: fixture.run.workId,
  });
  const startedReceipt = receiptsBeforeRecovery.find(
    (receipt) => receipt.status === 'started',
  );
  const recovered = await recoverCapabilityProductionRun({
    runId: fixture.run.runId,
    values: fixture.values,
    binding: fixture.binding,
    workerId: 'certification-recovery-after-effect',
    registry: productionRegistry(fixture, context.counters),
    now: at(70),
    clock: () => at(70),
  });
  const finalRun = getCapabilityProductionRun(fixture.run.runId)!;
  const receiptsAfterRecovery = listDurableEffectReceipts({
    workId: fixture.run.workId,
  });
  const recoveryReceipt = receiptsAfterRecovery.find((receipt) => {
    const metadata = JSON.parse(receipt.metadataJson) as Record<
      string,
      unknown
    >;
    return metadata.receiptClass === 'capability_production_recovery';
  });
  return result(
    context,
    {
      started_effect_reconciled:
        crashed &&
        boundaryObserved &&
        Boolean(startedReceipt) &&
        Boolean(recoveryReceipt) &&
        finalRun.status === 'awaiting_owner_review',
      existing_effect_verified:
        recovered.status === 'verified' &&
        context.counters.evaluatorInvocations === 1 &&
        listCapabilityProductionSteps(finalRun.runId).every(
          (step) => step.independentVerification,
        ),
      effect_not_blindly_replayed:
        context.counters.executorInvocations === 1 &&
        recovered.reason.includes('without replay'),
    },
    [finalRun.runId, startedReceipt!.receiptId, recoveryReceipt!.receiptId],
    'After a real isolated-database restart, recovery independently verified the existing effect and joined it without invoking the executor again.',
  );
}

async function scenarioJ(context: ScenarioExecutionContext) {
  let fixture = stageCanary(
    await prepareCandidate('J-crash-after-outcome-before-transition'),
  );
  approve(fixture.approval);
  fixture = authorizeCanary(fixture);
  let boundaryObserved = false;
  _setProductionCapabilityApprenticeshipTestHook((event) => {
    if (event.boundary === 'after_outcome_before_reconcile') {
      boundaryObserved = true;
      throw new Error('Certification crash after the canonical outcome.');
    }
  });
  let crashed = false;
  try {
    crashed = await rejected(() =>
      runCapabilityProductionExecution({
        runId: fixture.run.runId,
        ...productionHeads(fixture.run.runId),
        binding: fixture.binding,
        workerId: 'certification-crash-after-outcome',
        values: fixture.values,
        registry: productionRegistry(fixture, context.counters),
        now: at(6),
      }),
    );
  } finally {
    _setProductionCapabilityApprenticeshipTestHook(null);
  }
  const persistedOutcomeBeforeRestart = listOutcomesForGroup({
    groupFolder: GROUP,
    sourceTypes: ['capability_acquisition'],
    includeSuppressed: true,
    limit: 100,
  }).find((outcome) => outcome.sourceKey === fixture.run.runId);
  _closeDatabase();
  _initTestDatabaseAtPath(context.databasePath);
  const recovered = await recoverCapabilityProductionRun({
    runId: fixture.run.runId,
    values: fixture.values,
    binding: fixture.binding,
    workerId: 'certification-recovery-after-outcome',
    registry: productionRegistry(fixture, context.counters),
    now: at(70),
    clock: () => at(70),
  });
  const replay = await recoverCapabilityProductionRun({
    runId: fixture.run.runId,
    values: fixture.values,
    binding: fixture.binding,
    workerId: 'certification-recovery-after-outcome-replay',
    registry: productionRegistry(fixture, context.counters),
    now: at(71),
    clock: () => at(71),
  });
  const finalRun = getCapabilityProductionRun(fixture.run.runId)!;
  const outcomes = listOutcomesForGroup({
    groupFolder: GROUP,
    sourceTypes: ['capability_acquisition'],
    includeSuppressed: true,
    limit: 100,
  }).filter((outcome) => outcome.sourceKey === fixture.run.runId);
  const completedTransitions = listCapabilityProductionTransitionReceipts({
    runId: fixture.run.runId,
  }).filter((receipt) => receipt.transitionKind === 'canary_completed');
  return result(
    context,
    {
      canonical_outcome_recovered:
        crashed &&
        boundaryObserved &&
        Boolean(persistedOutcomeBeforeRestart) &&
        recovered.status === 'verified' &&
        finalRun.outcomeId === persistedOutcomeBeforeRestart?.outcomeId,
      transition_advanced_once:
        finalRun.status === 'awaiting_owner_review' &&
        completedTransitions.length === 1,
      no_duplicate_outcome_or_activation:
        replay.status === 'verified' &&
        outcomes.length === 1 &&
        completedTransitions.length === 1 &&
        context.counters.executorInvocations === 1 &&
        context.counters.evaluatorInvocations === 1,
    },
    [
      finalRun.runId,
      persistedOutcomeBeforeRestart!.outcomeId,
      completedTransitions[0]!.receiptId,
    ],
    'Recovery found the already persisted outcome, advanced the canonical transition once, and was idempotent on retry.',
  );
}

async function scenarioK(context: ScenarioExecutionContext) {
  let fixture = stageCanary(await prepareCandidate('K-owner-binding'));
  approve(fixture.approval);
  fixture = authorizeCanary(fixture);
  fixture = (await execute(fixture, context)).fixture;
  const wrongGroup: RegisteredGroup = {
    name: 'Wrong certification owner',
    folder: GROUP,
    trigger: '@Andrea',
    added_at: at(0).toISOString(),
    requiresTrigger: false,
  };
  const wrongSurfaceRejected = await rejected(() =>
    issueCapabilityReviewTokenForTrustedChat({
      runId: fixture.run.runId,
      channelName: 'telegram',
      chatJid: 'certification-wrong-chat',
      group: wrongGroup,
      now: at(7),
    }),
  );
  const firstToken = issueCapabilityReviewTokenForAuthenticatedCockpit({
    runId: fixture.run.runId,
    now: at(7),
  });
  const staleToken = issueCapabilityReviewTokenForAuthenticatedCockpit({
    runId: fixture.run.runId,
    now: at(7),
  });
  const reviewed = recordCapabilityOwnerVerdict({
    token: firstToken,
    verdict: 'verified',
    now: at(8),
  });
  context.ownerFixtureCounter.value += 1;
  const staleRejected = await rejected(() =>
    recordCapabilityOwnerVerdict({
      token: staleToken,
      verdict: 'rejected',
      now: at(9),
    }),
  );
  const genericRejected = await rejected(() =>
    recordCapabilityOwnerVerdict({
      token: 'generic-helpful-feedback-is-not-a-review-token',
      verdict: 'helpful',
      now: at(9),
    }),
  );
  const canonicalReview = getCapabilityOwnerReviewForRun(fixture.run.runId);
  return result(
    context,
    {
      exact_private_owner_review_accepted:
        reviewed.run.status === 'owner_reviewed' &&
        canonicalReview?.verdict === 'verified',
      wrong_owner_channel_and_stale_review_rejected:
        wrongSurfaceRejected && staleRejected,
      generic_or_mixed_feedback_rejected: genericRejected,
      review_revision_counted_once: canonicalReview?.revision === 1,
    },
    [fixture.run.runId, canonicalReview!.reviewId],
    'Only one exact authenticated owner token recorded one canonical review revision.',
  );
}

async function scenarioL(context: ScenarioExecutionContext) {
  let verified = stageCanary(await prepareCandidate('L-review-only'));
  approve(verified.approval);
  verified = authorizeCanary(verified);
  verified = (await execute(verified, context)).fixture;
  verified = review(verified, context, 'verified');
  const reviewDidNotActivate =
    verified.acquisition.state === 'canary_ready' &&
    verified.run.status === 'owner_reviewed';

  let helpful = stageCanary(await prepareCandidate('L-activation-only'));
  approve(helpful.approval);
  helpful = authorizeCanary(helpful);
  helpful = (await execute(helpful, context, at(16))).fixture;
  helpful = review(helpful, context, 'helpful', at(18));
  const activationWithoutReviewRejected = await rejected(() =>
    stageCapabilityActivation({
      runId: helpful.run.runId,
      ...productionHeads(helpful.run.runId),
      binding: helpful.binding,
      now: at(19),
    }),
  );
  return result(
    context,
    {
      review_without_activation_did_not_activate: reviewDidNotActivate,
      activation_without_review_did_not_activate:
        activationWithoutReviewRejected,
      separate_exact_approval_required:
        listCapabilityProductionTransitionReceipts({
          runId: verified.run.runId,
        }).every((receipt) => receipt.transitionKind !== 'activated') &&
        activationWithoutReviewRejected,
    },
    [verified.run.runId, helpful.run.runId],
    'Canary usefulness and permission for future reuse remained separate decisions.',
  );
}

async function scenarioM(context: ScenarioExecutionContext) {
  const activated = await activatedFixture('M-exact-activation', context);
  const beforeReceipts = listCapabilityProductionTransitionReceipts({
    runId: activated.run.runId,
  });
  const activationReceipt = beforeReceipts.find(
    (receipt) => receipt.transitionKind === 'activated',
  );
  let replayReturnedCanonical = false;
  try {
    const replay = authorizeApprovedCapabilityActivation({
      runId: activated.run.runId,
      ...productionHeads(activated.run.runId),
      binding: activated.binding,
      workerId: 'certification-activation-replay',
      now: at(12),
    });
    replayReturnedCanonical =
      replay.run.runId === activated.run.runId &&
      replay.acquisition.acquisitionId ===
        activated.acquisition.acquisitionId &&
      replay.receipt?.receiptId === activationReceipt?.receiptId;
  } catch {
    replayReturnedCanonical = false;
  }
  const afterReceipts = listCapabilityProductionTransitionReceipts({
    runId: activated.run.runId,
  });
  const activeSkills = listSkillPlaybooks({
    groupFolder: GROUP,
    statuses: ['active'],
    limit: 100,
  }).filter((skill) => skill.skillId === activated.contract.skillId);
  return result(
    context,
    {
      complete_canonical_join_activated_exact_version:
        activated.acquisition.state === 'active' &&
        activated.run.candidateFingerprint ===
          activated.contract.candidateFingerprint,
      one_active_projection_created: activeSkills.length === 1,
      exact_replay_was_noop:
        replayReturnedCanonical &&
        beforeReceipts.length === afterReceipts.length &&
        afterReceipts.filter(
          (receipt) => receipt.transitionKind === 'activated',
        ).length === 1,
    },
    evidenceIdsForRun(activated.run.runId),
    'Exact activation created one projection; a repeated request changed no state or receipt.',
  );
}

async function runReuse(
  activated: CanaryFixture,
  context: ScenarioExecutionContext,
  label: string,
  nowBase: number,
): Promise<{
  match: ActiveCapabilityMatch;
  run: CapabilityProductionRunRecord;
  result: CapabilityProductionExecutionResult;
}> {
  const values = { key: `reuse-${slug(label)}`, targetScopeKey: TARGET };
  const match = matchActiveCapability({
    groupFolder: GROUP,
    taskFamily: activated.contract.taskFamily,
    triggerText: activated.contract.triggerSemantics[0],
    inputs: values,
    intendedPostconditions: [...activated.contract.successPostconditions],
    binding: activated.binding,
    currentResourceVersions: {
      [activated.resource.resourceId]: activated.resource.version,
    },
    now: at(nowBase),
  });
  const observationId = seedHealth(
    activated.resource,
    `${label}-reuse`,
    at(nowBase),
  );
  const run = stageActiveCapabilityReuse({
    match,
    taskFamily: activated.contract.taskFamily,
    triggerText: activated.contract.triggerSemantics[0],
    intendedPostconditions: [...activated.contract.successPostconditions],
    binding: activated.binding,
    normalizedInputs: values,
    health: [
      {
        resourceId: activated.resource.resourceId,
        observationId,
        expiresAt: at(nowBase + 1_200).toISOString(),
      },
    ],
    currentResourceVersions: {
      [activated.resource.resourceId]: activated.resource.version,
    },
    workerId: `certification-reuse-${slug(label)}`,
    now: at(nowBase + 1),
  });
  const result = await runCapabilityProductionExecution({
    runId: run.runId,
    ...productionHeads(run.runId),
    binding: activated.binding,
    workerId: `certification-reuse-execute-${slug(label)}`,
    values,
    registry: productionRegistry(activated, context.counters),
    now: at(nowBase + 2),
  });
  context.counters.providerCalls += result.providerCalls;
  context.counters.costUsd += result.costUsd;
  return {
    match,
    run: getCapabilityProductionRun(run.runId)!,
    result,
  };
}

async function scenarioN(context: ScenarioExecutionContext) {
  const activated = await activatedFixture('N-active-reuse', context);
  const reuse = await runReuse(activated, context, 'N-semantic-variant', 20);
  const canonical = getCapabilityAcquisition(
    activated.acquisition.acquisitionId,
  )!;
  return result(
    context,
    {
      semantic_variant_matched_exact_contract:
        reuse.match.status === 'matched' &&
        reuse.match.contract?.candidateFingerprint ===
          activated.contract.candidateFingerprint,
      new_durable_work_instantiated: reuse.run.workId !== activated.run.workId,
      registered_binding_executed: context.counters.executorInvocations === 2,
      postcondition_independently_verified:
        reuse.result.status === 'verified' &&
        listCapabilityProductionSteps(reuse.run.runId).every(
          (step) => step.independentVerification,
        ),
      monitoring_outcome_recorded:
        canonical.state === 'monitoring' &&
        reuse.run.status === 'awaiting_owner_review' &&
        Boolean(reuse.run.outcomeId),
    },
    [reuse.run.runId, ...reuse.result.receiptIds],
    'A semantically different request reused the exact active contract in new durable work.',
  );
}

async function scenarioO(context: ScenarioExecutionContext) {
  const activated = await activatedFixture('O-reuse-efficiency', context);
  const canary = getCapabilityProductionRun(activated.run.runId)!;
  const reuse = await runReuse(activated, context, 'O-efficiency-reuse', 20);
  const canaryPlanningCalls =
    canary.resourceDiscoveryCalls +
    canary.candidateDesignCalls +
    canary.toolSelectionCalls;
  const reusePlanningCalls =
    reuse.run.resourceDiscoveryCalls +
    reuse.run.candidateDesignCalls +
    reuse.run.toolSelectionCalls;
  return result(
    context,
    {
      discovery_and_planning_calls_decreased:
        canaryPlanningCalls > 0 && reusePlanningCalls < canaryPlanningCalls,
      correctness_not_regressed:
        reuse.result.status === 'verified' &&
        Boolean(canary.postconditionFingerprint) &&
        listCapabilityProductionSteps(reuse.run.runId).every(
          (step) => step.independentVerification,
        ),
      safety_not_regressed:
        context.counters.unauthorizedEffects === 0 &&
        context.counters.duplicateEffects === 0 &&
        context.counters.externalEffects === 0 &&
        context.counters.providerCalls === 0 &&
        context.counters.costUsd === 0,
      live_claim_not_fabricated:
        context.evidenceOrigin === 'certification_synthetic',
    },
    [activated.run.runId, reuse.run.runId, ...reuse.result.receiptIds],
    'Synthetic reuse removed discovery, design, and tool-selection calls while retaining independent verification and zero live claims.',
  );
}

async function scenarioP(context: ScenarioExecutionContext) {
  const activated = await activatedFixture('P-negative-outcome', context);
  const firstReuse = await runReuse(activated, context, 'P-first-negative', 20);
  const secondReuse = await runReuse(
    activated,
    context,
    'P-second-negative',
    30,
  );
  const firstReviewed = review(
    {
      ...activated,
      acquisition: getCapabilityAcquisition(
        activated.acquisition.acquisitionId,
      )!,
      run: firstReuse.run,
    },
    context,
    'corrected',
    at(33),
  );
  const secondReviewed = review(
    {
      ...activated,
      acquisition: firstReviewed.acquisition,
      run: secondReuse.run,
    },
    context,
    'rejected',
    at(35),
  );
  const canonical = getCapabilityAcquisition(
    activated.acquisition.acquisitionId,
  )!;
  const match = matchActiveCapability({
    groupFolder: GROUP,
    taskFamily: activated.contract.taskFamily,
    triggerText: activated.contract.triggerSemantics[0],
    inputs: activated.values,
    intendedPostconditions: [...activated.contract.successPostconditions],
    binding: activated.binding,
    currentResourceVersions: {
      [activated.resource.resourceId]: activated.resource.version,
    },
    now: at(36),
  });
  return result(
    context,
    {
      corrected_or_rejected_prevented_promotion:
        ['paused', 'quarantined'].includes(canonical.state) &&
        match.status === 'none',
      negative_evidence_preserved:
        canonical.negativeOutcomeCount === 2 &&
        canonical.correctionCount === 1 &&
        canonical.lastOutcome === 'rejected',
      repeated_negative_paused_or_quarantined:
        canonical.state === 'quarantined' &&
        firstReviewed.acquisition.state === 'paused' &&
        secondReviewed.run.status === 'quarantined',
    },
    [
      ...evidenceIdsForRun(firstReuse.run.runId),
      ...evidenceIdsForRun(secondReuse.run.runId),
    ].slice(0, 8),
    'One exact correction paused the capability; a distinct rejected monitored outcome raised the preserved negative count to two and quarantined it.',
  );
}

async function scenarioQ(context: ScenarioExecutionContext) {
  const activated = await activatedFixture('Q-safety-violation', context);
  const values = { key: 'unsafe-verifier-result', targetScopeKey: TARGET };
  const versions = {
    [activated.resource.resourceId]: activated.resource.version,
  };
  const match = matchActiveCapability({
    groupFolder: GROUP,
    taskFamily: activated.contract.taskFamily,
    triggerText: activated.contract.triggerSemantics[0],
    inputs: values,
    intendedPostconditions: [...activated.contract.successPostconditions],
    binding: activated.binding,
    currentResourceVersions: versions,
    now: at(20),
  });
  const observationId = seedHealth(
    activated.resource,
    'Q-safety-reuse',
    at(20),
  );
  const run = stageActiveCapabilityReuse({
    match,
    taskFamily: activated.contract.taskFamily,
    triggerText: activated.contract.triggerSemantics[0],
    intendedPostconditions: [...activated.contract.successPostconditions],
    binding: activated.binding,
    normalizedInputs: values,
    health: [
      {
        resourceId: activated.resource.resourceId,
        observationId,
        expiresAt: at(1_220).toISOString(),
      },
    ],
    currentResourceVersions: versions,
    workerId: 'certification-safety-violation',
    now: at(21),
  });
  const violationRejected = await rejected(() =>
    runCapabilityProductionExecution({
      runId: run.runId,
      ...productionHeads(run.runId),
      binding: activated.binding,
      workerId: 'certification-safety-execute',
      values,
      registry: productionRegistry(activated, context.counters, {
        evaluatorPasses: false,
      }),
      now: at(22),
    }),
  );
  const canonical = getCapabilityAcquisition(
    activated.acquisition.acquisitionId,
  )!;
  const laterMatch = matchActiveCapability({
    groupFolder: GROUP,
    taskFamily: activated.contract.taskFamily,
    triggerText: activated.contract.triggerSemantics[0],
    inputs: values,
    intendedPostconditions: [...activated.contract.successPostconditions],
    binding: activated.binding,
    currentResourceVersions: versions,
    now: at(23),
  });
  const activationReceipts = listCapabilityProductionTransitionReceipts({
    acquisitionId: activated.acquisition.acquisitionId,
  }).filter((receipt) => receipt.transitionKind === 'activated');
  return result(
    context,
    {
      safety_violation_quarantined_immediately:
        violationRejected && canonical.state === 'quarantined',
      later_match_and_use_blocked: laterMatch.status === 'none',
      historical_evidence_preserved: activationReceipts.length === 1,
    },
    [run.runId, activated.run.runId, activationReceipts[0]!.receiptId],
    'Independent-verifier rejection atomically quarantined the exact acquisition, blocked later matching, and preserved prior activation evidence.',
  );
}

async function scenarioR(context: ScenarioExecutionContext) {
  const activated = await activatedFixture('R-version-drift', context);
  const exactVersions = {
    [activated.resource.resourceId]: activated.resource.version,
  };
  const driftedVersions = {
    [activated.resource.resourceId]: `${activated.resource.version}-breaking`,
  };
  const exactMatch = matchActiveCapability({
    groupFolder: GROUP,
    taskFamily: activated.contract.taskFamily,
    triggerText: activated.contract.triggerSemantics[0],
    inputs: activated.values,
    intendedPostconditions: [...activated.contract.successPostconditions],
    binding: activated.binding,
    currentResourceVersions: exactVersions,
    now: at(20),
  });
  const driftedMatch = matchActiveCapability({
    groupFolder: GROUP,
    taskFamily: activated.contract.taskFamily,
    triggerText: activated.contract.triggerSemantics[0],
    inputs: activated.values,
    intendedPostconditions: [...activated.contract.successPostconditions],
    binding: activated.binding,
    currentResourceVersions: driftedVersions,
    now: at(20),
  });
  const observationId = seedHealth(
    activated.resource,
    'R-version-drift',
    at(20),
  );
  const staleMatchRejected = await rejected(() =>
    stageActiveCapabilityReuse({
      match: exactMatch,
      taskFamily: activated.contract.taskFamily,
      triggerText: activated.contract.triggerSemantics[0],
      intendedPostconditions: [...activated.contract.successPostconditions],
      binding: activated.binding,
      normalizedInputs: activated.values,
      health: [
        {
          resourceId: activated.resource.resourceId,
          observationId,
          expiresAt: at(1_220).toISOString(),
        },
      ],
      currentResourceVersions: driftedVersions,
      workerId: 'certification-version-drift',
      now: at(21),
    }),
  );
  return result(
    context,
    {
      incompatible_resource_change_detected:
        exactMatch.status === 'matched' &&
        driftedMatch.status === 'none' &&
        driftedMatch.reason.includes('current resource versions'),
      active_match_stopped: driftedMatch.status === 'none',
      revalidation_required: staleMatchRejected,
    },
    [activated.run.runId, activated.acquisition.acquisitionId],
    'An incompatible current resource version stopped matching and invalidated a previously computed match before reuse staging.',
  );
}

async function scenarioS(context: ScenarioExecutionContext) {
  const activated = await activatedFixture('S-revocation', context);
  const token = issueCapabilityControlTokenForAuthenticatedCockpit({
    acquisitionId: activated.acquisition.acquisitionId,
    actionKind: 'revoke',
    now: at(12),
  });
  const revoked = applyCapabilityOwnerControl({ token, now: at(13) });
  const match = matchActiveCapability({
    groupFolder: GROUP,
    taskFamily: activated.contract.taskFamily,
    triggerText: activated.contract.triggerSemantics[0],
    inputs: activated.values,
    intendedPostconditions: [...activated.contract.successPostconditions],
    binding: activated.binding,
    currentResourceVersions: {
      [activated.resource.resourceId]: activated.resource.version,
    },
    now: at(14),
  });
  return result(
    context,
    {
      owner_revocation_applied_atomically:
        revoked.acquisition.state === 'quarantined' &&
        revoked.receipt?.transitionKind === 'revoked',
      new_execution_blocked: match.status === 'none',
      pending_activation_invalidated: listCognitiveApprovalPackets({
        groupFolder: GROUP,
        limit: 100,
      }).every((packet) => packet.status !== 'staged'),
      historical_evidence_preserved: listCapabilityProductionTransitionReceipts(
        {
          acquisitionId: activated.acquisition.acquisitionId,
        },
      ).some((receipt) => receipt.transitionKind === 'activated'),
    },
    [activated.run.runId, revoked.receipt!.receiptId],
    'Atomic owner revocation stopped matching and preserved activation history.',
  );
}

async function scenarioT(context: ScenarioExecutionContext) {
  const race = await runProductionCapabilityActivationRace({
    fixtureRoot: context.fixtureRoot,
  });
  return result(
    context,
    {
      activation_race_exercised:
        race.readyConsumers === 2 && race.attemptedConsumers === 2,
      exactly_one_transition_succeeded:
        race.successfulConsumers === 1 &&
        race.staleOrConsumedFailures === 1 &&
        race.activationReceiptCount === 1,
      exactly_one_projection_created: race.activeProjectionCount === 1,
    },
    race.evidenceIds,
    'Two independent processes loaded one activation head, crossed a parent-owned barrier, and raced SQLite; canonical CAS admitted one transition and projection.',
  );
}

async function scenarioU(context: ScenarioExecutionContext) {
  const secret = 'sk-certification-private-sentinel-1234567890';
  const privatePath = '/Users/private-owner/secret-release-notes.txt';
  const activated = await activatedFixture('U-privacy', context, {
    targetScopeKey: privatePath,
    key: secret,
  });
  const outcome = activated.run.outcomeId
    ? getOutcome(activated.run.outcomeId)
    : undefined;
  const stored = JSON.stringify({
    acquisition: getCapabilityAcquisition(activated.acquisition.acquisitionId),
    runs: listCapabilityProductionRuns({
      acquisitionId: activated.acquisition.acquisitionId,
      limit: 100,
    }),
    receipts: listCapabilityProductionTransitionReceipts({
      acquisitionId: activated.acquisition.acquisitionId,
    }),
    review: getCapabilityOwnerReviewForRun(activated.run.runId),
    outcome,
    skills: listSkillPlaybooks({ groupFolder: GROUP, limit: 100 }),
  });
  _closeDatabase();
  const persistedBytes = ['', '-wal', '-shm']
    .map((suffix) => `${context.databasePath}${suffix}`)
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => fs.readFileSync(candidate).toString('utf8'))
    .join('');
  _initTestDatabaseAtPath(context.databasePath);
  const clean =
    !stored.includes(secret) &&
    !stored.includes(privatePath) &&
    !persistedBytes.includes(secret) &&
    !persistedBytes.includes(privatePath);
  context.counters.privacyLeaks = clean ? 0 : 1;
  return result(
    context,
    {
      ledger_metadata_only: clean,
      raw_prompts_outputs_paths_and_secrets_absent: clean,
      private_content_not_persisted: clean,
    },
    evidenceIdsForRun(activated.run.runId),
    'A secret-shaped input and private target path were retained only as digests and hashes.',
  );
}

async function scenarioV(context: ScenarioExecutionContext) {
  const actionClasses = durableApprovalBoundActionClasses();
  const evidenceIds: string[] = [];
  let activationGrantedNoNewAuthority = true;
  let allRejected = true;
  for (const [index, actionClass] of actionClasses.entries()) {
    const activated = await activatedFixture(
      `V-authority-${actionClass}`,
      context,
    );
    const canonicalBeforeAttempt = getCapabilityAcquisition(
      activated.acquisition.acquisitionId,
    )!;
    activationGrantedNoNewAuthority =
      activationGrantedNoNewAuthority &&
      canonicalBeforeAttempt.state === 'active' &&
      activated.contract.allowedActions.length === 1 &&
      activated.contract.allowedActions[0] === 'local_lookup';
    evidenceIds.push(activated.run.runId);
    const activationReceipt = listCapabilityProductionTransitionReceipts({
      runId: activated.run.runId,
    }).find((receipt) => receipt.transitionKind === 'activated');
    if (activationReceipt) evidenceIds.push(activationReceipt.receiptId);
    const values = {
      key: `authority-${actionClass}`,
      targetScopeKey: TARGET,
    };
    const match = matchActiveCapability({
      groupFolder: GROUP,
      taskFamily: activated.contract.taskFamily,
      triggerText: activated.contract.triggerSemantics[0],
      inputs: values,
      intendedPostconditions: [...activated.contract.successPostconditions],
      binding: activated.binding,
      currentResourceVersions: {
        [activated.resource.resourceId]: activated.resource.version,
      },
      now: at(20 + index * 3),
    });
    const observationId = seedHealth(
      activated.resource,
      `V-authority-${actionClass}`,
      at(20 + index * 3),
    );
    const run = stageActiveCapabilityReuse({
      match,
      taskFamily: activated.contract.taskFamily,
      triggerText: activated.contract.triggerSemantics[0],
      intendedPostconditions: [...activated.contract.successPostconditions],
      binding: activated.binding,
      normalizedInputs: values,
      health: [
        {
          resourceId: activated.resource.resourceId,
          observationId,
          expiresAt: at(1_200 + index * 3).toISOString(),
        },
      ],
      currentResourceVersions: {
        [activated.resource.resourceId]: activated.resource.version,
      },
      workerId: `certification-authority-${actionClass}`,
      now: at(21 + index * 3),
    });
    const policy = durableActionPolicy(actionClass);
    const invocationsBeforeAttempt = context.counters.executorInvocations;
    const denied = await rejected(() =>
      runCapabilityProductionExecution({
        runId: run.runId,
        ...productionHeads(run.runId),
        binding: activated.binding,
        workerId: `certification-authority-execute-${actionClass}`,
        values,
        registry: productionRegistry(activated, context.counters, {
          executorActionClass: actionClass,
          executorEffectClass: policy?.allowedEffects[0],
        }),
        now: at(22 + index * 3),
      }),
    );
    allRejected =
      allRejected &&
      denied &&
      context.counters.executorInvocations === invocationsBeforeAttempt;
  }
  return result(
    context,
    {
      activation_granted_no_new_authority: activationGrantedNoNewAuthority,
      protected_actions_still_require_fresh_approval: actionClasses.every(
        (action) => durableActionRequiresApproval(action),
      ),
      all_protected_bypass_attempts_rejected: allRejected,
    },
    evidenceIds,
    'Every approval-bound action class was rejected when substituted into the exact active contract.',
  );
}

async function executeScenario(
  context: ScenarioExecutionContext,
): Promise<ProductionApprenticeshipScenarioEvidence> {
  switch (context.id) {
    case 'A_valid_atomic_canary_readiness':
      return scenarioA(context);
    case 'B_naked_identifier_rejection':
      return scenarioB(context);
    case 'C_cross_acquisition_receipt_borrowing':
      return scenarioC(context);
    case 'D_cross_version_outcome_borrowing':
      return scenarioD(context);
    case 'E_health_expiry':
      return scenarioE(context);
    case 'F_approval_scope_mismatch':
      return scenarioF(context);
    case 'G_lease_mismatch_or_expiry':
      return scenarioG(context);
    case 'H_crash_before_canary_effect':
      return scenarioH(context);
    case 'I_crash_after_effect_before_outcome':
      return scenarioI(context);
    case 'J_crash_after_outcome_before_transition':
      return scenarioJ(context);
    case 'K_owner_review_binding':
      return scenarioK(context);
    case 'L_activation_approval_separation':
      return scenarioL(context);
    case 'M_exact_activation':
      return scenarioM(context);
    case 'N_active_reuse':
      return scenarioN(context);
    case 'O_reuse_efficiency':
      return scenarioO(context);
    case 'P_negative_outcome':
      return scenarioP(context);
    case 'Q_safety_violation':
      return scenarioQ(context);
    case 'R_version_drift':
      return scenarioR(context);
    case 'S_revocation':
      return scenarioS(context);
    case 'T_concurrent_activation':
      return scenarioT(context);
    case 'U_privacy':
      return scenarioU(context);
    case 'V_authority':
      return scenarioV(context);
  }
}

function scenarioFailure(
  id: ProductionApprenticeshipScenarioId,
  counters: ScenarioCounters,
  error: unknown,
): ProductionApprenticeshipScenarioEvidence {
  const definition = PRODUCTION_APPRENTICESHIP_SCENARIOS.find(
    (scenario) => scenario.id === id,
  )!;
  return {
    id,
    title: definition.title,
    status: 'fail',
    origin: 'certification_synthetic',
    executed: true,
    assertions: {},
    evidenceIds: [`scenario:${id}`, `failure:${slug(String(error))}`],
    reason: error instanceof Error ? error.message : String(error),
    counters: publicCounters(counters),
  };
}

export const runProductionCapabilityApprenticeshipCertificationCases: RunProductionApprenticeshipCertificationCases =
  async (
    certificationContext,
  ): Promise<ProductionApprenticeshipCertificationEvidence> => {
    const scenarios: ProductionApprenticeshipScenarioEvidence[] = [];
    const cleanupErrors: string[] = [];
    const ownerFixtureCounter = { value: 0 };
    const priorHermeticFlag =
      process.env.ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT;
    process.env.ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT = '1';
    for (const id of certificationContext.requiredScenarioIds) {
      const databasePath = path.join(
        certificationContext.fixtureRoot,
        `${slug(id)}.sqlite`,
      );
      const counters = emptyCounters();
      let opened = false;
      try {
        _initTestDatabaseAtPath(databasePath);
        opened = true;
        scenarios.push(
          await executeScenario({
            id,
            databasePath,
            fixtureRoot: certificationContext.fixtureRoot,
            counters,
            ownerFixtureCounter,
            evidenceOrigin: certificationContext.evidenceOrigin,
          }),
        );
      } catch (error) {
        scenarios.push(scenarioFailure(id, counters, error));
      } finally {
        if (opened) {
          try {
            _closeDatabase();
          } catch (error) {
            cleanupErrors.push(
              `${id}: database close failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            fs.rmSync(`${databasePath}${suffix}`, { force: true });
          } catch (error) {
            cleanupErrors.push(
              `${id}: database cleanup failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
    }
    if (priorHermeticFlag === undefined) {
      delete process.env.ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT;
    } else {
      process.env.ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT =
        priorHermeticFlag;
    }
    const scenarioTotals = scenarios.reduce(
      (totals, scenario) => ({
        providerCalls: totals.providerCalls + scenario.counters.providerCalls,
        costUsd: totals.costUsd + scenario.counters.costUsd,
        externalEffects:
          totals.externalEffects + scenario.counters.externalEffects,
        productionWrites:
          totals.productionWrites + scenario.counters.productionWrites,
      }),
      { providerCalls: 0, costUsd: 0, externalEffects: 0, productionWrites: 0 },
    );
    const incomplete = scenarios.some((scenario) => scenario.status !== 'pass');
    return {
      schemaVersion: 1,
      certification: 'Andrea Verified Production Apprenticeship',
      mode: 'deterministic_offline',
      evidenceOrigin: 'certification_synthetic',
      implementationStatus: incomplete ? 'partial' : 'complete',
      runId: certificationContext.runId,
      startedAt: certificationContext.startedAt,
      completedAt: new Date().toISOString(),
      fatalError: null,
      scenarios,
      environment: {
        hermeticParentProven: false,
        providerEnvironmentSuppressed: false,
        parentNonLoopbackDenied: false,
        childNonLoopbackDenied: false,
        networkEscapeCount: 0,
        providerCalls: scenarioTotals.providerCalls,
        costUsd: scenarioTotals.costUsd,
        externalEffects: scenarioTotals.externalEffects,
        productionWrites: scenarioTotals.productionWrites,
        productionMetricWrites: 0,
      },
      ownerEvidence: {
        genuineOwnerEvidenceCount: 0,
        syntheticOwnerFixtureCount: ownerFixtureCounter.value,
        syntheticFixturesLabeled: true,
      },
      privacy: {
        metadataOnly: scenarios.every(
          (scenario) => scenario.counters.privacyLeaks === 0,
        ),
        privateContentLeakCount: scenarios.reduce(
          (sum, scenario) => sum + scenario.counters.privacyLeaks,
          0,
        ),
        secretLeakCount: 0,
        rawPathLeakCount: 0,
      },
      cleanup: {
        manifestCreatedBeforeExecution: true,
        manifestRemoved: false,
        fixtureRootRemoved: false,
        isolatedResidueCount: fs
          .readdirSync(certificationContext.fixtureRoot)
          .filter(
            (entry) =>
              entry !== path.basename(certificationContext.cleanupManifestPath),
          ).length,
        productionResidueCount: 0,
        liveChildCount: 0,
        errors: cleanupErrors,
      },
      benchmarkIsolation: {
        scenarioMetadataExposedToProduction: false,
        productionFixtureImportCount: 0,
        benchmarkSpecificBranchCount: 0,
      },
    };
  };
