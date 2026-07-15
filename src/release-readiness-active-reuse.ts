import { createHash } from 'node:crypto';

import {
  getCapabilityAcquisition,
  listReliabilityObservations,
  upsertReliabilityObservation,
  upsertToolReliabilitySubject,
} from './db.js';
import {
  assertCapabilityCandidateContract,
  canonicalCapabilityJson,
  parseCapabilityJson,
} from './capability-acquisition-policy.js';
import {
  durableScopeHash,
  type DurableWorkBindingInput,
} from './durable-work-continuity.js';
import {
  buildReleaseReadinessCandidateContract,
  getCapabilityApprenticeshipStatus,
  matchActiveCapability,
  ProductionCapabilityBindingRegistry,
  RELEASE_READINESS_POSTCONDITIONS,
  releaseReadinessCapabilityResource,
  runCapabilityProductionExecution,
  stageActiveCapabilityReuse,
  type ActiveCapabilityMatch,
  type CapabilityApprenticeshipStatus,
  type CapabilityCanaryHealthBinding,
  type CapabilityProductionExecutionResult,
  type ProductionCapabilityEvaluatorBinding,
  type ProductionCapabilityExecutorBinding,
} from './production-capability-apprenticeship.js';
import { isTrustedOwnerReviewSurface } from './trusted-owner-review-surface.js';
import type {
  CapabilityCandidateContract,
  CapabilityProductionRunRecord,
  CapabilityResourceDescriptor,
  RegisteredGroup,
  ReliabilityObservation,
} from './types.js';

const RELEASE_READINESS_TASK_FAMILY = 'release_readiness';
const RELEASE_READINESS_TARGET_SCOPE = 'release-readiness';
const RELEASE_READINESS_HEALTH_TTL_MS = 30 * 60 * 1_000;
const RELEASE_READINESS_WORKER_ID = 'andrea:release-readiness-active-reuse';
const RELEASE_READINESS_HEALTH_SUBJECT =
  'capability-resource:andrea.release_readiness_truth';
const RELEASE_READINESS_HEALTH_EVIDENCE_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,239}$/;

export interface ReleaseReadinessActiveReuseInput {
  text: string;
  channelName: string;
  chatJid: string;
  group: RegisteredGroup;
  now?: Date | string;
}

export type ReleaseReadinessActiveReuseAction =
  | 'verified'
  | 'restricted'
  | 'not_active'
  | 'ambiguous'
  | 'scope_mismatch'
  | 'freshness_gap'
  | 'version_gap'
  | 'execution_failed';

export interface ReleaseReadinessActiveReuseResult {
  handled: boolean;
  text?: string;
  action?: ReleaseReadinessActiveReuseAction;
  runId?: string;
}

export interface ReleaseReadinessActiveReuseDependencies {
  getStatus: (acquisitionId: string) => CapabilityApprenticeshipStatus;
  listHealth: (params: {
    subjectId?: string;
    limit?: number;
  }) => ReliabilityObservation[];
  refreshHealth: (params: {
    acquisitionId: string;
    groupFolder: string;
    now: string;
  }) => Promise<CapabilityCanaryHealthBinding | null>;
  match: (params: {
    groupFolder: string;
    taskFamily: string;
    inputs: Record<string, unknown>;
    intendedPostconditions: string[];
    binding: DurableWorkBindingInput;
    currentResourceVersions: Record<string, string>;
  }) => ActiveCapabilityMatch;
  stage: typeof stageActiveCapabilityReuse;
  execute: typeof runCapabilityProductionExecution;
  createRegistry: () => ProductionCapabilityBindingRegistry;
  buildContract: () => CapabilityCandidateContract;
  getResource: () => CapabilityResourceDescriptor;
}

const DEFAULT_DEPENDENCIES: ReleaseReadinessActiveReuseDependencies = {
  getStatus: getCapabilityApprenticeshipStatus,
  listHealth: listReliabilityObservations,
  refreshHealth: refreshActiveReleaseReadinessHealth,
  match: matchActiveCapability,
  stage: stageActiveCapabilityReuse,
  execute: runCapabilityProductionExecution,
  createRegistry: () => ProductionCapabilityBindingRegistry.createBundled(),
  buildContract: buildReleaseReadinessCandidateContract,
  getResource: releaseReadinessCapabilityResource,
};

interface ActiveReleaseReadinessHealthRefreshDependencies {
  getAcquisition: typeof getCapabilityAcquisition;
  resolveBindings: (step: CapabilityCandidateContract['steps'][number]) => {
    executor: ProductionCapabilityExecutorBinding;
    evaluator: ProductionCapabilityEvaluatorBinding;
  };
  recordObservation: (record: ReliabilityObservation) => void;
}

const DEFAULT_HEALTH_REFRESH_DEPENDENCIES: ActiveReleaseReadinessHealthRefreshDependencies =
  {
    getAcquisition: getCapabilityAcquisition,
    resolveBindings(step) {
      const registry = ProductionCapabilityBindingRegistry.createBundled();
      return {
        executor: registry.resolveExecutor(step),
        evaluator: registry.resolveEvaluator(step),
      };
    },
    recordObservation(record) {
      const resource = releaseReadinessCapabilityResource();
      upsertToolReliabilitySubject({
        subjectId: RELEASE_READINESS_HEALTH_SUBJECT,
        subjectKind: 'capability',
        displayName: 'Andrea release-readiness truth',
        aliasesJson: JSON.stringify([resource.resourceId]),
        riskLevel: 'low',
        approvalRequirement: 'none',
        channelsJson: JSON.stringify([
          'owner_cockpit',
          'telegram',
          'bluebubbles',
        ]),
        sourceRefsJson: JSON.stringify(resource.sourceRefs),
        privacyJson: JSON.stringify({
          metadataOnly: true,
          rawContentStored: false,
        }),
      });
      upsertReliabilityObservation(record);
    },
  };

function normalizedIntentText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Deliberately narrow semantic variants for the bundled read-only capability.
 * Imperative release, deploy, push, or mixed-action requests do not match.
 */
export function isReleaseReadinessActiveReuseRequest(text: string): boolean {
  const normalized = normalizedIntentText(text);
  if (!normalized || normalized.length > 240) return false;
  const polite = '(?:please\\s+)?';
  const punctuation = '[?.!]*';
  return [
    new RegExp(
      `^${polite}is\\s+andrea\\s+ready\\s+to\\s+release${punctuation}$`,
    ),
    new RegExp(
      `^${polite}are\\s+we\\s+ready\\s+(?:to\\s+release|for\\s+release)${punctuation}$`,
    ),
    new RegExp(
      `^${polite}is\\s+(?:this|the)\\s+build\\s+ready\\s+to\\s+ship${punctuation}$`,
    ),
    new RegExp(
      `^${polite}what(?:'s|\\s+is)?\\s+block(?:ing|s)\\s+(?:us\\s+from\\s+)?a\\s+safe\\s+demo${punctuation}$`,
    ),
    new RegExp(
      `^${polite}give\\s+me\\s+(?:a\\s+)?current\\s+release[- ]readiness\\s+brief${punctuation}$`,
    ),
    new RegExp(
      `^${polite}show\\s+(?:me\\s+)?(?:the\\s+)?(?:current\\s+)?release[- ]readiness(?:\\s+(?:brief|status))?${punctuation}$`,
    ),
  ].some((pattern) => pattern.test(normalized));
}

function iso(value?: Date | string): string {
  const parsed =
    value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('Release-readiness reuse time is invalid.');
  }
  return parsed.toISOString();
}

function exactBundledResource(resource: CapabilityResourceDescriptor): boolean {
  const binding = resource.bindingRefs[0];
  return Boolean(
    resource.available &&
    resource.healthState === 'healthy' &&
    resource.authorityRequirement === 'none' &&
    resource.dataEgressClass === 'none' &&
    resource.expectedCostBand === 'zero' &&
    resource.bindingRefs.length === 1 &&
    binding?.readOnly === true &&
    binding.actionClass === 'local_lookup' &&
    binding.version === resource.version,
  );
}

function exactBundledContract(
  matched: CapabilityCandidateContract,
  presentation: CapabilityCandidateContract,
  resource: CapabilityResourceDescriptor,
): boolean {
  const resourceBinding = matched.resourceBindings[0];
  const step = matched.steps[0];
  const binding = resource.bindingRefs[0];
  const sameStrings = (left: string[], right: readonly string[]) =>
    left.length === right.length &&
    left.every((item, index) => item === right[index]);
  return Boolean(
    matched.taskFamily === presentation.taskFamily &&
    sameStrings(matched.triggerSemantics, presentation.triggerSemantics) &&
    sameStrings(matched.requiredInputs, presentation.requiredInputs) &&
    sameStrings(matched.optionalInputs, presentation.optionalInputs) &&
    sameStrings(
      matched.successPostconditions,
      RELEASE_READINESS_POSTCONDITIONS,
    ) &&
    matched.resourceBindings.length === 1 &&
    resourceBinding?.resourceId === resource.resourceId &&
    resourceBinding.bindingKind === 'assistant_capability' &&
    resourceBinding.version === resource.version &&
    resourceBinding.required === true &&
    matched.steps.length === 1 &&
    step?.resourceId === resource.resourceId &&
    step.bindingId === binding?.bindingId &&
    step.operationId === binding?.operationId &&
    step.evaluatorId === binding?.evaluatorId &&
    step.executorImplementationDigest ===
      binding?.executorImplementationDigest &&
    step.evaluatorImplementationDigest ===
      binding?.evaluatorImplementationDigest &&
    step.version === resource.version &&
    step.readOnly === true &&
    step.approvalRequired === false &&
    step.actionClass === 'local_lookup' &&
    matched.dataEgressClass === 'none' &&
    matched.allowedActions.length === 1 &&
    matched.allowedActions[0] === 'local_lookup' &&
    matched.approvalRequirements.length === 0 &&
    matched.credentialRequirements.length === 0,
  );
}

function exactActiveAcquisition(params: {
  acquisition: ActiveCapabilityMatch['acquisition'];
  contract: CapabilityCandidateContract;
  groupFolder: string;
}): boolean {
  if (!params.acquisition) return false;
  let authorityRequirements: unknown;
  try {
    authorityRequirements = JSON.parse(
      params.acquisition.authorityRequirementsJson,
    ) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return Boolean(
    ['active', 'monitoring'].includes(params.acquisition.state) &&
    params.acquisition.groupFolder === params.groupFolder &&
    params.acquisition.taskFamily === RELEASE_READINESS_TASK_FAMILY &&
    params.acquisition.compiledSkillId === params.contract.skillId &&
    params.acquisition.evidenceOrigin === 'live' &&
    params.acquisition.dataEgressClass === 'none' &&
    params.acquisition.expectedCostBand === 'zero' &&
    params.acquisition.negativeOutcomeCount === 0 &&
    params.acquisition.correctionCount === 0 &&
    Array.isArray(authorityRequirements) &&
    authorityRequirements.length === 0,
  );
}

function releaseReadinessHealthEvidenceIds(values: string[]): string[] {
  return [
    ...new Set(
      values.filter((value) =>
        RELEASE_READINESS_HEALTH_EVIDENCE_PATTERN.test(value),
      ),
    ),
  ]
    .sort()
    .slice(0, 64);
}

/**
 * Refreshes health for one already-active exact bundled contract. This is a
 * bounded local verification pass, not candidate discovery or lifecycle
 * authority: it cannot create/reseed an acquisition, call a provider, access
 * an external network, or execute a mutating binding.
 */
export async function refreshActiveReleaseReadinessHealth(
  params: {
    acquisitionId: string;
    groupFolder: string;
    now?: Date | string;
  },
  dependencies: Partial<ActiveReleaseReadinessHealthRefreshDependencies> = {},
): Promise<CapabilityCanaryHealthBinding | null> {
  const deps = { ...DEFAULT_HEALTH_REFRESH_DEPENDENCIES, ...dependencies };
  const now = iso(params.now);
  const acquisition = deps.getAcquisition(params.acquisitionId);
  if (!acquisition || acquisition.groupFolder !== params.groupFolder)
    return null;

  let contract: CapabilityCandidateContract;
  try {
    contract = parseCapabilityJson<CapabilityCandidateContract>(
      acquisition.candidateContractJson,
      'candidateContractJson',
    );
    assertCapabilityCandidateContract(contract);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
  const presentation = buildReleaseReadinessCandidateContract();
  const resource = releaseReadinessCapabilityResource();
  if (
    !exactBundledResource(resource) ||
    !exactBundledContract(contract, presentation, resource) ||
    !exactActiveAcquisition({
      acquisition,
      contract,
      groupFolder: params.groupFolder,
    })
  ) {
    return null;
  }

  const step = contract.steps[0];
  if (!step || contract.steps.length !== 1) return null;
  const { executor, evaluator } = deps.resolveBindings(step);
  if (
    executor.bindingId !== step.bindingId ||
    executor.operationId !== step.operationId ||
    executor.resourceId !== step.resourceId ||
    executor.version !== step.version ||
    executor.executorImplementationDigest !==
      step.executorImplementationDigest ||
    executor.actionClass !== 'local_lookup' ||
    executor.effectClass !== 'read_only' ||
    !['none', 'loopback'].includes(executor.networkAccess) ||
    executor.maximumCostUsd !== 0 ||
    evaluator.evaluatorId !== step.evaluatorId ||
    evaluator.operationId !== step.operationId ||
    evaluator.resourceId !== step.resourceId ||
    evaluator.version !== step.version ||
    evaluator.evaluatorImplementationDigest !==
      step.evaluatorImplementationDigest
  ) {
    return null;
  }

  const values = { targetScopeKey: RELEASE_READINESS_TARGET_SCOPE };
  const probeStartedAt = Date.now();
  const result = await executor.execute({
    values,
    idempotencyKey: createHash('sha256')
      .update(
        canonicalCapabilityJson({
          acquisitionId: acquisition.acquisitionId,
          candidateFingerprint: contract.candidateFingerprint,
          recordVersion: acquisition.recordVersion,
          observedAt: now,
          operation: 'active-release-readiness-health-refresh-v1',
        }),
      )
      .digest('hex'),
  });
  if (
    result.effectClass !== 'read_only' ||
    result.effectStatus !== 'none' ||
    (result.providerCalls || 0) !== 0 ||
    (result.costUsd || 0) !== 0 ||
    !result.postStateFingerprint
  ) {
    return null;
  }
  const verification = await evaluator.verify({
    values,
    result,
    requiredPostconditions: [...contract.successPostconditions],
  });
  const expectedPostconditions = [...contract.successPostconditions].sort();
  const verifiedPostconditions = [
    ...new Set(verification.verifiedPostconditions),
  ].sort();
  const evidenceIds = releaseReadinessHealthEvidenceIds([
    ...result.evidenceRefs,
    ...verification.evidenceRefs,
  ]);
  if (
    !verification.verified ||
    !verification.postconditionFingerprint ||
    !/^[a-f0-9]{64}$/.test(verification.postconditionFingerprint) ||
    canonicalCapabilityJson(verifiedPostconditions) !==
      canonicalCapabilityJson(expectedPostconditions) ||
    evidenceIds.length === 0
  ) {
    return null;
  }

  // Re-read the canonical head after both local reads. Do not persist health if
  // activation, version, contract, group, or negative evidence changed.
  const current = deps.getAcquisition(acquisition.acquisitionId);
  if (
    !current ||
    current.recordVersion !== acquisition.recordVersion ||
    current.updatedAt !== acquisition.updatedAt ||
    current.state !== acquisition.state ||
    current.candidateContractJson !== acquisition.candidateContractJson ||
    current.groupFolder !== params.groupFolder ||
    !['active', 'monitoring'].includes(current.state) ||
    current.negativeOutcomeCount !== 0 ||
    current.correctionCount !== 0
  ) {
    return null;
  }

  const observation: ReliabilityObservation = {
    observationId: `release-readiness-health:${createHash('sha256')
      .update(
        canonicalCapabilityJson({
          acquisitionId: current.acquisitionId,
          candidateFingerprint: contract.candidateFingerprint,
          recordVersion: current.recordVersion,
          observedAt: now,
          fingerprint: verification.postconditionFingerprint,
        }),
      )
      .digest('hex')
      .slice(0, 40)}`,
    subjectId: RELEASE_READINESS_HEALTH_SUBJECT,
    observedAt: now,
    sourceKind: 'verified_usage',
    outcome: 'success',
    failureClass: 'none',
    confidence: 1,
    fallbackUsed: false,
    latencyMs: Math.max(0, Date.now() - probeStartedAt),
    summary:
      'Active bundled release-readiness lookup and independent verifier agreed.',
    nextAction: 'Use only the exact active version-pinned read-only binding.',
    evidenceIdsJson: JSON.stringify(evidenceIds),
    privacyJson: JSON.stringify({
      metadataOnly: true,
      rawContentStored: false,
      providerCalls: 0,
      externalNetwork: false,
      authorityExpanded: false,
      acquisitionId: current.acquisitionId,
      candidateFingerprint: contract.candidateFingerprint,
    }),
  };
  deps.recordObservation(observation);
  return {
    resourceId: resource.resourceId,
    observationId: observation.observationId,
    expiresAt: new Date(
      Date.parse(now) + RELEASE_READINESS_HEALTH_TTL_MS,
    ).toISOString(),
  };
}

function exactActiveCanary(params: {
  status: CapabilityApprenticeshipStatus;
  expectedAcquisitionId: string;
  expectedCandidateFingerprint: string;
  binding: DurableWorkBindingInput;
  channelName: string;
}): CapabilityProductionRunRecord | null {
  if (
    !['active', 'monitoring'].includes(params.status.acquisition.state) ||
    params.status.acquisition.acquisitionId !== params.expectedAcquisitionId ||
    params.status.acquisition.groupFolder !== params.binding.groupId
  ) {
    return null;
  }
  const expected = {
    owner: durableScopeHash('owner', params.binding.ownerId),
    chat: durableScopeHash('chat', params.binding.chatId),
    group: durableScopeHash('group', params.binding.groupId),
    target: durableScopeHash('target', params.binding.targetScopeKey),
  };
  return (
    params.status.runs.find(
      (run) =>
        run.runKind === 'canary' &&
        ['active', 'monitoring'].includes(run.status) &&
        run.acquisitionId === params.expectedAcquisitionId &&
        run.candidateFingerprint === params.expectedCandidateFingerprint &&
        run.groupFolder === params.binding.groupId &&
        run.channel === params.channelName &&
        run.authorizedSurface === params.channelName &&
        run.ownerScopeHash === expected.owner &&
        run.chatScopeHash === expected.chat &&
        run.groupScopeHash === expected.group &&
        run.targetScopeHash === expected.target,
    ) || null
  );
}

function freshHealthBinding(params: {
  observations: ReliabilityObservation[];
  resourceId: string;
  now: string;
}): CapabilityCanaryHealthBinding | null {
  const nowMs = Date.parse(params.now);
  const subjectId = `capability-resource:${params.resourceId}`;
  const observation = params.observations
    .filter((item) => {
      const observedAtMs = Date.parse(item.observedAt);
      return (
        item.subjectId === subjectId &&
        item.sourceKind === 'verified_usage' &&
        item.outcome === 'success' &&
        item.confidence === 1 &&
        item.fallbackUsed === false &&
        Number.isFinite(observedAtMs) &&
        observedAtMs <= nowMs &&
        observedAtMs + RELEASE_READINESS_HEALTH_TTL_MS > nowMs
      );
    })
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0];
  if (!observation) return null;
  return {
    resourceId: params.resourceId,
    observationId: observation.observationId,
    expiresAt: new Date(
      Date.parse(observation.observedAt) + RELEASE_READINESS_HEALTH_TTL_MS,
    ).toISOString(),
  };
}

function safeCandidateIds(ids: string[]): string {
  return ids
    .filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,239}$/.test(id))
    .slice(0, 5)
    .join(', ');
}

function verifiedBrief(
  execution: CapabilityProductionExecutionResult,
): string | null {
  const result = execution.results[0] as
    | { formattedBrief?: unknown; truthFingerprint?: unknown }
    | undefined;
  if (
    execution.status !== 'verified' ||
    execution.results.length !== 1 ||
    execution.providerCalls !== 0 ||
    execution.costUsd !== 0 ||
    typeof result?.formattedBrief !== 'string' ||
    result.formattedBrief.length === 0 ||
    result.formattedBrief.length > 16_000 ||
    typeof result.truthFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.truthFingerprint)
  ) {
    return null;
  }
  return result.formattedBrief;
}

function isExpectedReuseRace(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof AggregateError)
    return false;
  return /(?:active capability|active reuse|resource version|fresh successful health|activation evidence|lease acquisition|production execution input|production binding|production evaluator|independent evaluator|postcondition)/i.test(
    error.message,
  );
}

export async function dispatchActiveReleaseReadinessReuse(
  input: ReleaseReadinessActiveReuseInput,
  dependencies: Partial<ReleaseReadinessActiveReuseDependencies> = {},
): Promise<ReleaseReadinessActiveReuseResult> {
  if (!isReleaseReadinessActiveReuseRequest(input.text)) {
    return { handled: false };
  }
  if (!isTrustedOwnerReviewSurface(input)) {
    return {
      handled: true,
      action: 'restricted',
      text: 'The active release-readiness capability is restricted to your registered main Telegram chat or configured Messages self-thread. I did not inspect or execute it here.',
    };
  }

  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const now = iso(input.now);
  const resource = deps.getResource();
  if (!exactBundledResource(resource)) {
    return {
      handled: true,
      action: 'version_gap',
      text: 'The bundled release-readiness resource is unavailable, unhealthy, or no longer matches its read-only zero-egress contract. I did not execute it.',
    };
  }
  const presentationContract = deps.buildContract();
  const values = { targetScopeKey: RELEASE_READINESS_TARGET_SCOPE };
  const currentResourceVersions = { [resource.resourceId]: resource.version };
  const binding: DurableWorkBindingInput = {
    ownerId: 'owner',
    chatId: input.chatJid,
    groupId: input.group.folder,
    channel: input.channelName,
    targetScopeKey: RELEASE_READINESS_TARGET_SCOPE,
  };
  const match = deps.match({
    groupFolder: input.group.folder,
    taskFamily: RELEASE_READINESS_TASK_FAMILY,
    inputs: values,
    intendedPostconditions: [...RELEASE_READINESS_POSTCONDITIONS],
    binding,
    currentResourceVersions,
  });
  if (match.status === 'none') {
    return {
      handled: true,
      action: 'not_active',
      text: 'No active exact release-readiness capability is bound to this chat and target, so I did not execute one or change its lifecycle.',
    };
  }
  if (match.status === 'ambiguous') {
    const ids = safeCandidateIds(match.candidateIds);
    return {
      handled: true,
      action: 'ambiguous',
      text: `More than one active release-readiness contract matches this request${ids ? ` (${ids})` : ''}. I did not choose or execute one automatically.`,
    };
  }
  if (
    !match.acquisition ||
    !match.contract ||
    !exactActiveAcquisition({
      acquisition: match.acquisition,
      contract: match.contract,
      groupFolder: input.group.folder,
    }) ||
    !exactBundledContract(match.contract, presentationContract, resource)
  ) {
    return {
      handled: true,
      action: 'version_gap',
      text: 'The active match is not the exact current bundled release-readiness contract. I did not execute or upgrade it automatically.',
    };
  }
  const status = deps.getStatus(match.acquisition.acquisitionId);
  if (
    !exactActiveCanary({
      status,
      expectedAcquisitionId: match.acquisition.acquisitionId,
      expectedCandidateFingerprint: match.contract.candidateFingerprint,
      binding,
      channelName: input.channelName,
    })
  ) {
    return {
      handled: true,
      action: 'scope_mismatch',
      text: 'The active release-readiness canary is not bound to this exact owner chat, group, channel, and target. I did not execute it.',
    };
  }
  const subjectId = `capability-resource:${resource.resourceId}`;
  let health = freshHealthBinding({
    observations: deps.listHealth({ subjectId, limit: 100 }),
    resourceId: resource.resourceId,
    now,
  });
  if (!health) {
    health = await deps.refreshHealth({
      acquisitionId: match.acquisition.acquisitionId,
      groupFolder: input.group.folder,
      now,
    });
  }
  if (!health) {
    return {
      handled: true,
      action: 'freshness_gap',
      text: 'The active release-readiness capability lacks a fresh successful health proof, and its bounded local verifier could not refresh one. I did not stage or execute the capability.',
    };
  }

  let run: CapabilityProductionRunRecord;
  try {
    run = deps.stage({
      match,
      taskFamily: RELEASE_READINESS_TASK_FAMILY,
      intendedPostconditions: [...RELEASE_READINESS_POSTCONDITIONS],
      binding,
      normalizedInputs: values,
      health: [health],
      currentResourceVersions,
      workerId: RELEASE_READINESS_WORKER_ID,
      now,
    });
  } catch (error) {
    if (!isExpectedReuseRace(error)) throw error;
    return {
      handled: true,
      action: 'freshness_gap',
      text: 'The active release-readiness evidence changed while I was preparing the read-only run. Nothing was executed; ask again after health and version evidence are current.',
    };
  }

  let execution: CapabilityProductionExecutionResult;
  try {
    execution = await deps.execute({
      runId: run.runId,
      expectedAcquisitionVersion: match.acquisition.recordVersion,
      expectedRunRevision: run.revision,
      binding,
      workerId: RELEASE_READINESS_WORKER_ID,
      values,
      registry: deps.createRegistry(),
      now,
    });
  } catch (error) {
    if (!isExpectedReuseRace(error)) throw error;
    return {
      handled: true,
      action: 'execution_failed',
      runId: run.runId,
      text: 'The bounded release-readiness lookup or its independent verifier did not complete successfully. I recorded no success claim and did not retry or broaden authority.',
    };
  }
  const brief = verifiedBrief(execution);
  if (!brief) {
    return {
      handled: true,
      action: 'execution_failed',
      runId: run.runId,
      text: 'The release-readiness run did not return one verified, zero-cost, zero-provider brief. I recorded no success claim.',
    };
  }
  return {
    handled: true,
    action: 'verified',
    runId: run.runId,
    text: `${brief}\n\nVerified through the exact active read-only capability contract; independent postcondition check passed; provider calls: 0; cost: $0.`,
  };
}
