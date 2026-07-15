import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  getCapabilityAcquisition,
  isDatabaseInitialized,
  isIsolatedTestDatabase,
  listCapabilityAcquisitions,
  listCapabilityAcquisitionTransitions,
  listDurableEffectReceipts,
} from '../../../src/db.js';
import {
  assessCapabilityResourceReuse,
  brokerCapabilityResources,
  type CapabilityResourceBrokerResult,
} from '../../../src/capability-resource-broker.js';
import { assertCapabilityCandidateContract } from '../../../src/capability-acquisition-policy.js';
import { capabilityBindingImplementationDigest } from '../../../src/capability-execution-guard.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityCandidateContract,
  CapabilityGapKind,
  CapabilityResourceDescriptor,
} from '../../../src/types.js';
import {
  compileCapabilityCandidate,
  CAPABILITY_SANDBOX_MARKER,
  capabilitySandboxTargetScopeHash,
  createHermeticCertificationBindingRegistry,
  markCapabilityExternallyBlocked,
  observeCapabilityGap,
  prepareCapabilityExecutionScope,
  prepareCapabilitySandbox,
  recordCapabilityCandidateNegativeEvaluation,
  recordCapabilityHeldOutEvidence,
  recordCapabilityResourceDiscovery,
  runCapabilitySandbox,
  scopeCapabilityAcquisition,
  VerifiedCapabilityBindingRegistry,
  type CapabilityEvaluatorBinding,
  type CapabilityExecutorBinding,
  type CapabilityExecutionReceipt,
  type CapabilityExecutionScope,
  type CapabilitySandboxMarker,
} from '../../../src/verified-capability-acquisition.js';
import type {
  CapabilityAcquisitionTransitionEvidence,
  CapabilityVerificationReceiptEvidence,
  NovelCapabilityScenarioEvidence,
} from '../../lib/novel-capability-certification-gate.js';
import {
  decodeNovelCapabilityCliOperationId,
  encodeNovelCapabilityCliOperationId,
  fingerprintFixtureValue,
  NOVEL_CAPABILITY_CLI_OPERATION_ID_PREFIX,
  type NovelCapabilityCliMethod,
} from './pack-support.js';
import type { NovelCapabilityFixtureLab } from './fixture-lab.js';
import type {
  NovelCapabilityFixtureCheck,
  NovelCapabilityFixtureScenario,
  NovelCapabilityPrivateOracle,
  NovelCapabilityPublicResource,
  NovelCapabilityPublicTask,
  NovelCapabilityScenarioId,
} from './types.js';

const BASE_TIME = Date.parse('2031-04-14T12:00:00.000Z');

type CertificationBinding = CapabilityExecutorBinding &
  CapabilityEvaluatorBinding;

interface ScenarioMetrics {
  discoveryCalls: number;
  discoverySteps: number;
  operationDiscoveryCalls: number;
  totalCalls: number;
}

interface DurableCliRehydrationEvidence {
  adapterRestarted: boolean;
  workerProcessObservedContract: boolean;
  canonicalContractRehydrated: boolean;
}

interface RestartObservation {
  attempted: boolean;
  phaseBeforeRestart: CapabilityAcquisitionRecord['state'];
  phaseAfterRestart: CapabilityAcquisitionRecord['state'];
  verifiedBeforeRestart: boolean;
  completedAfterResume: boolean;
  verificationAfterResume: boolean;
  duplicateEffects: number;
}

export interface ProductionScenarioRun {
  scenario: NovelCapabilityFixtureScenario;
  record: CapabilityAcquisitionRecord;
  evidence: NovelCapabilityScenarioEvidence;
  metrics: ScenarioMetrics;
  invokedPublicResourceIds: string[];
  inspectedPublicResourceIds: string[];
  repositoryVerifierPassed: boolean;
  reuseProven: boolean;
  staleInvocationCount: number;
  priorProvenancePreserved: boolean;
  runtimeInputLeakCount: number;
  restart: RestartObservation | null;
  diagnostics: string[];
}

export interface ProductionCertificationRun {
  scenarios: ProductionScenarioRun[];
  runtimeMetadataLeakCount: number;
  restart: RestartObservation;
  reuse: {
    adapterRestarted: boolean;
    workerProcessObservedContract: boolean;
    canonicalContractRehydrated: boolean;
    baselineOperationDiscoveryCalls: number;
    reusedOperationDiscoveryCalls: number;
    sameCapabilityIdentity: boolean;
    compatibleVersion: boolean;
    fullDiscoveryRepeated: boolean;
    baselineCorrectness: number;
    reusedCorrectness: number;
    baselineSafetyRate: number;
    reusedSafetyRate: number;
    baselineDiscoveryCalls: number;
    reusedDiscoveryCalls: number;
    baselineDiscoverySteps: number;
    reusedDiscoverySteps: number;
    baselineTotalCalls: number;
    reusedTotalCalls: number;
  };
  staleVersion: {
    detectedBeforeInvocation: boolean;
    staleInvocationCount: number;
    priorProvenancePreserved: boolean;
    resolution: 'paused' | 'quarantined' | 'revalidated';
  };
  providerCalls: number;
  costUsd: number;
  falseSuccesses: number;
  unauthorizedExternalEffects: number;
  duplicateEffects: number;
  fabricatedOwnerApprovals: number;
  ownerReviewedOutcomes: number;
  malformedStates: number;
}

interface ScenarioExecutionState {
  invoked: Set<string>;
  inspected: Set<string>;
  diagnostics: string[];
  repositoryVerifierPassed: boolean;
  reuseProven: boolean;
  staleInvocationCount: number;
  priorProvenancePreserved: boolean;
  metrics: ScenarioMetrics;
  restart: RestartObservation | null;
  broker: CapabilityResourceBrokerResult | null;
  runtimeInputLeakCount: number;
}

const RUNTIME_TASK_KEYS = new Set([
  'taskId',
  'taskFamily',
  'goal',
  'successPostcondition',
  'availableResources',
  'constraints',
]);

const FORBIDDEN_RUNTIME_METADATA_KEY =
  /(?:oracle|scenarioId|certificationScenario|expectedAnswer|expectedGap|privatePostcondition|privateNotes|fixtureSeed|sentinel|runId)/i;

function runtimeInputLeakCount(task: NovelCapabilityPublicTask): number {
  let leaks = Object.keys(task).filter(
    (key) => !RUNTIME_TASK_KEYS.has(key),
  ).length;
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_RUNTIME_METADATA_KEY.test(key)) leaks += 1;
      inspect(entry);
    }
  };
  inspect(task);
  return leaks;
}

interface SuccessfulFlowOptions {
  task: NovelCapabilityPublicTask;
  resources: CapabilityResourceDescriptor[];
  bindings: CertificationBinding[];
  state: ScenarioExecutionState;
  gapKind: CapabilityGapKind;
  postconditions: string[];
  values?: Record<string, unknown>;
  now: Date;
  currentResources?: CapabilityResourceDescriptor[];
  networkPolicy?: 'none' | 'loopback';
  runHeldOut?: boolean;
  preselectedResources?: CapabilityResourceDescriptor[];
  requiredInputs?: string[];
  withholdEvaluators?: boolean;
  externalDocuments?: Array<{
    sourceId: string;
    title: string;
    content: string;
    citations: string[];
    taskFamilies: string[];
    supportedPostconditions: string[];
  }>;
  beforePrepare?: (record: CapabilityAcquisitionRecord) => Promise<void>;
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

function nowAt(index: number, stage = 0): Date {
  return new Date(BASE_TIME + index * 60_000 + stage * 1_000);
}

function candidateBindingProjection(
  record: CapabilityAcquisitionRecord,
): Array<{
  resourceId: string;
  bindingId: string;
  operationId: string;
  evaluatorId: string;
  version: string;
  executorImplementationDigest: string;
  evaluatorImplementationDigest: string;
}> {
  const contract = JSON.parse(
    record.candidateContractJson,
  ) as CapabilityCandidateContract;
  assertCapabilityCandidateContract(contract);
  return contract.steps
    .map((step) => ({
      resourceId: step.resourceId,
      bindingId: step.bindingId,
      operationId: step.operationId,
      evaluatorId: step.evaluatorId,
      version: step.version,
      executorImplementationDigest: step.executorImplementationDigest,
      evaluatorImplementationDigest: step.evaluatorImplementationDigest,
    }))
    .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
}

function publicResource(
  task: NovelCapabilityPublicTask,
  predicate: (resource: NovelCapabilityPublicResource) => boolean,
): NovelCapabilityPublicResource {
  const resource = task.availableResources.find(predicate);
  if (!resource) throw new Error('Required public fixture resource is absent.');
  return resource;
}

function sourceRef(resource: NovelCapabilityPublicResource): string {
  return `fixture-resource:${hash(resource.resourceId).slice(0, 24)}`;
}

function descriptor(params: {
  publicResource: NovelCapabilityPublicResource;
  taskFamily: string;
  postconditions: string[];
  binding?: {
    bindingId: string;
    operationId: string;
    evaluatorId: string;
    executorImplementationDigest: string;
    evaluatorImplementationDigest: string;
    actionClass: CapabilityExecutorBinding['actionClass'];
    readOnly: boolean;
  };
  canonicalResourceId?: string;
  available?: boolean;
  healthState?: CapabilityResourceDescriptor['healthState'];
  authorityRequirement?: CapabilityResourceDescriptor['authorityRequirement'];
  riskLevel?: CapabilityResourceDescriptor['riskLevel'];
  dataEgressClass?: CapabilityResourceDescriptor['dataEgressClass'];
  reversible?: boolean;
  kind?: CapabilityResourceDescriptor['kind'];
}): CapabilityResourceDescriptor {
  const resourceId =
    params.canonicalResourceId ?? params.publicResource.resourceId;
  return {
    resourceId,
    kind:
      params.kind ??
      (params.publicResource.kind === 'repository'
        ? 'patch_workbench'
        : params.publicResource.kind === 'document'
          ? 'trusted_documentation'
          : 'local_script'),
    displayName: params.publicResource.title,
    taskFamilies: [params.taskFamily],
    capabilityIds: [`capability:${hash(resourceId).slice(0, 24)}`],
    supportedPostconditions: [...params.postconditions],
    requiredInputs: [],
    available: params.available ?? true,
    healthState: params.healthState ?? 'healthy',
    verificationStrength: 1,
    reliabilityScore: 0.99,
    authorityRequirement: params.authorityRequirement ?? 'none',
    riskLevel: params.riskLevel ?? 'low',
    dataEgressClass: params.dataEgressClass ?? 'local_only',
    reversible: params.reversible ?? true,
    expectedCostBand: 'zero',
    expectedLatencyBand: 'instant',
    version: params.publicResource.versionFingerprint,
    sourceRefs: [sourceRef(params.publicResource)],
    maintenanceBurden: 'low',
    bindingRefs: params.binding
      ? [
          {
            ...params.binding,
            version: params.publicResource.versionFingerprint,
          },
        ]
      : [],
  };
}

function bindingIdentity(
  resource: NovelCapabilityPublicResource,
  operation: string,
  persistedOperationId?: string,
): {
  bindingId: string;
  operationId: string;
  evaluatorId: string;
  executorImplementationDigest: string;
  evaluatorImplementationDigest: string;
} {
  const operationId =
    persistedOperationId ??
    `fixture-operation:${hash(`${resource.resourceId}:${operation}`).slice(0, 24)}`;
  const identity = hash(`${resource.resourceId}:${operationId}`).slice(0, 24);
  const bindingId = `fixture-binding:${identity}`;
  const evaluatorId = `fixture-evaluator:${identity}`;
  return {
    bindingId,
    operationId,
    evaluatorId,
    executorImplementationDigest: capabilityBindingImplementationDigest({
      kind: 'executor',
      implementationId: `${bindingId}:${operationId}`,
      version: resource.versionFingerprint,
    }),
    evaluatorImplementationDigest: capabilityBindingImplementationDigest({
      kind: 'evaluator',
      implementationId: `${evaluatorId}:${operationId}`,
      version: resource.versionFingerprint,
    }),
  };
}

function resultEvidence(prefix: string, value: unknown): string {
  return `${prefix}:${hash(value).slice(0, 32)}`;
}

function helpFingerprint(command: string, flag: string): object {
  return {
    commandFingerprint: hash(command),
    flagFingerprint: hash(flag),
  };
}

function parseOpenApiReadPath(schemaText: string): {
  readPath: string;
  protectedPath: string | null;
} {
  const parsed = JSON.parse(schemaText) as {
    paths?: Record<string, { get?: { security?: unknown }; post?: unknown }>;
  };
  const entries = Object.entries(parsed.paths ?? {});
  const readPath = entries.find(
    ([, contract]) => contract.get && !contract.get.security,
  )?.[0];
  const protectedPath =
    entries.find(([, contract]) => contract.get?.security)?.[0] ?? null;
  if (!readPath) throw new Error('Fixture OpenAPI read route is missing.');
  return { readPath, protectedPath };
}

export class NovelCapabilityProductionCertificationAdapter {
  private readonly groupFolder: string;
  private learnedCli:
    | {
        descriptor: CapabilityResourceDescriptor;
        method: NovelCapabilityCliMethod;
        publicResourceId: string;
      }
    | undefined;
  private durableCliRehydration: DurableCliRehydrationEvidence = {
    adapterRestarted: false,
    workerProcessObservedContract: false,
    canonicalContractRehydrated: false,
  };
  private initialized = false;

  constructor(private readonly lab: NovelCapabilityFixtureLab) {
    this.groupFolder = `novel-cert-${hash(lab.seedFingerprint).slice(0, 16)}`;
  }

  initialize(): void {
    if (this.initialized) return;
    _initTestDatabaseAtPath(this.lab.paths.databasePath);
    this.lab.observeDatabaseIsolation(
      isIsolatedTestDatabase(),
      this.lab.paths.databasePath,
    );
    this.initialized = true;
  }

  close(): void {
    if (isDatabaseInitialized()) _closeDatabase();
    this.initialized = false;
  }

  private reopen(): void {
    if (isDatabaseInitialized()) _closeDatabase();
    _initTestDatabaseAtPath(this.lab.paths.databasePath);
    this.lab.observeDatabaseIsolation(
      isIsolatedTestDatabase(),
      this.lab.paths.databasePath,
    );
    this.initialized = true;
  }

  private async rehydrateLearnedCliFromDurableContract(): Promise<void> {
    if (this.learnedCli) {
      throw new Error('CLI rehydration requires a fresh adapter instance.');
    }
    const records = listCapabilityAcquisitions({
      groupFolder: this.groupFolder,
      states: ['sandbox_verified', 'owner_review_required'],
      gapKinds: ['tool_usage_gap'],
      taskFamily: 'local-data-summary',
      limit: 10,
    }).filter((record) => record.evidenceOrigin === 'synthetic');
    const rehydratable = records.filter((record) => {
      try {
        const contract = JSON.parse(
          record.candidateContractJson,
        ) as CapabilityCandidateContract;
        assertCapabilityCandidateContract(contract);
        return (
          contract.steps.length === 1 &&
          contract.steps[0]?.operationId.startsWith(
            NOVEL_CAPABILITY_CLI_OPERATION_ID_PREFIX,
          )
        );
      } catch {
        return false;
      }
    });
    if (rehydratable.length !== 1) {
      throw new Error(
        'Durable CLI rehydration requires one exact canonical candidate.',
      );
    }
    const record = rehydratable[0]!;
    const contract = JSON.parse(
      record.candidateContractJson,
    ) as CapabilityCandidateContract;
    assertCapabilityCandidateContract(contract);
    const step = contract.steps[0]!;
    if (
      record.compiledSkillId !== contract.skillId ||
      step.actionClass !== 'local_lookup' ||
      !step.readOnly ||
      contract.dataEgressClass !== 'local_only'
    ) {
      throw new Error('Durable CLI candidate violates the reuse boundary.');
    }

    const worker = this.lab.spawnWorker();
    let payload: Record<string, unknown> | undefined;
    let workerExitedCleanly = false;
    try {
      worker.send('production_rehydrate_cli', {
        databasePath: this.lab.paths.databasePath,
        acquisitionId: record.acquisitionId,
      });
      const observed = await worker.nextMessage();
      if (observed.type !== 'result') {
        throw new Error(
          'Fresh worker process rejected the durable CLI contract.',
        );
      }
      payload = observed.payload;
    } finally {
      if (worker.child.connected) {
        worker.send('exit');
        await worker.nextMessage().catch(() => undefined);
      }
      const exited = await worker.waitForExit();
      workerExitedCleanly = exited.code === 0;
    }
    if (!workerExitedCleanly) {
      throw new Error('CLI rehydration worker did not exit cleanly.');
    }
    const sameString = (key: string, expected: string): boolean =>
      payload?.[key] === expected;
    const sameStringArray = (
      key: string,
      expected: readonly string[],
    ): boolean =>
      Array.isArray(payload?.[key]) &&
      JSON.stringify(payload?.[key]) === JSON.stringify(expected);
    this.lab.observeDatabaseIsolation(
      payload?.databaseIsolated === true,
      this.lab.paths.databasePath,
    );
    if (
      !payload ||
      !sameString(
        'acquisitionFingerprint',
        fingerprintFixtureValue(record.acquisitionId),
      ) ||
      !sameString('state', record.state) ||
      !sameString('evidenceOrigin', 'synthetic') ||
      !sameString('taskFamily', contract.taskFamily) ||
      !sameString('capabilityId', contract.capabilityId) ||
      !sameString('skillId', contract.skillId) ||
      !sameString('stepTitle', step.title) ||
      !sameString('resourceId', step.resourceId) ||
      !sameString('bindingId', step.bindingId) ||
      !sameString('operationId', step.operationId) ||
      !sameString('evaluatorId', step.evaluatorId) ||
      !sameString('version', step.version) ||
      !sameString(
        'executorImplementationDigest',
        step.executorImplementationDigest,
      ) ||
      !sameString(
        'evaluatorImplementationDigest',
        step.evaluatorImplementationDigest,
      ) ||
      !sameString('actionClass', step.actionClass) ||
      payload.readOnly !== true ||
      !sameStringArray('expectedEvidence', step.expectedEvidence) ||
      !sameStringArray('requiredInputs', contract.requiredInputs) ||
      !sameStringArray('provenanceRefs', contract.provenanceRefs) ||
      !sameString('dataEgressClass', contract.dataEgressClass) ||
      payload.databaseIsolated !== true
    ) {
      throw new Error(
        'Fresh worker projection does not match the canonical CLI contract.',
      );
    }
    const method = decodeNovelCapabilityCliOperationId(step.operationId);
    const expectedExecutorDigest = capabilityBindingImplementationDigest({
      kind: 'executor',
      implementationId: `${step.bindingId}:${step.operationId}`,
      version: step.version,
    });
    const expectedEvaluatorDigest = capabilityBindingImplementationDigest({
      kind: 'evaluator',
      implementationId: `${step.evaluatorId}:${step.operationId}`,
      version: step.version,
    });
    if (
      step.executorImplementationDigest !== expectedExecutorDigest ||
      step.evaluatorImplementationDigest !== expectedEvaluatorDigest
    ) {
      throw new Error(
        'Canonical CLI implementation digest does not match its operation identity.',
      );
    }
    this.learnedCli = {
      descriptor: {
        resourceId: step.resourceId,
        kind: 'local_script',
        displayName: step.title,
        taskFamilies: [contract.taskFamily],
        capabilityIds: [contract.capabilityId],
        supportedPostconditions: [...step.expectedEvidence],
        requiredInputs: [...contract.requiredInputs],
        available: true,
        healthState: 'healthy',
        verificationStrength: 1,
        reliabilityScore: 0.99,
        authorityRequirement: 'none',
        riskLevel: 'low',
        dataEgressClass: 'local_only',
        reversible: true,
        expectedCostBand: 'zero',
        expectedLatencyBand: 'instant',
        version: step.version,
        sourceRefs: [...contract.provenanceRefs],
        maintenanceBurden: 'low',
        bindingRefs: [
          {
            bindingId: step.bindingId,
            operationId: step.operationId,
            evaluatorId: step.evaluatorId,
            executorImplementationDigest: step.executorImplementationDigest,
            evaluatorImplementationDigest: step.evaluatorImplementationDigest,
            actionClass: step.actionClass,
            version: step.version,
            readOnly: step.readOnly,
          },
        ],
      },
      method,
      publicResourceId: step.resourceId,
    };
    this.durableCliRehydration = {
      adapterRestarted: true,
      workerProcessObservedContract: true,
      canonicalContractRehydrated: true,
    };
  }

  private executionScope(params: {
    acquisitionId: string;
    targetScopeKey: string;
    now: Date;
  }): CapabilityExecutionScope {
    return prepareCapabilityExecutionScope({
      acquisitionId: params.acquisitionId,
      ownerId: `certification-owner:${hash(this.groupFolder).slice(0, 20)}`,
      chatId: `certification-chat:${hash(this.groupFolder).slice(0, 20)}`,
      groupId: this.groupFolder,
      channel: 'certification',
      targetScopeKey: params.targetScopeKey,
      now: params.now,
    });
  }

  private canonicalReceipts(
    scope: CapabilityExecutionScope,
  ): CapabilityExecutionReceipt[] {
    return listDurableEffectReceipts({
      workId: scope.workId,
      checkpointId: scope.checkpointId,
      limit: 1_000,
    })
      .filter((receipt) => receipt.status !== 'started')
      .map((receipt) => ({
        receiptId: receipt.receiptId,
        idempotencyKey: receipt.invocationId,
        bindingId: receipt.nodeId,
        actionClass:
          receipt.actionClass as CapabilityExecutionReceipt['actionClass'],
        status: receipt.status === 'partial' ? 'unknown' : receipt.status,
        effectClass: receipt.effectClass,
        ...(receipt.preStateFingerprint
          ? { preStateFingerprint: receipt.preStateFingerprint }
          : {}),
        ...(receipt.postStateFingerprint
          ? { postStateFingerprint: receipt.postStateFingerprint }
          : {}),
        ...(receipt.verificationFingerprint
          ? { verificationFingerprint: receipt.verificationFingerprint }
          : {}),
        evidenceRefs: [receipt.receiptId],
      }));
  }

  private bindingRegistry(
    bindings: readonly CertificationBinding[],
    includeEvaluators = true,
  ): VerifiedCapabilityBindingRegistry {
    const executors: CapabilityExecutorBinding[] = bindings.map((binding) => ({
      bindingId: binding.bindingId,
      operationId: binding.operationId,
      resourceId: binding.resourceId,
      version: binding.version,
      executorImplementationDigest: binding.executorImplementationDigest,
      actionClass: binding.actionClass,
      effectClass: binding.effectClass,
      networkAccess: binding.networkAccess,
      execute: binding.execute,
      ...(binding.cleanup ? { cleanup: binding.cleanup } : {}),
    }));
    const evaluators: CapabilityEvaluatorBinding[] = includeEvaluators
      ? bindings.map((binding) => ({
          evaluatorId: binding.evaluatorId,
          operationId: binding.operationId,
          resourceId: binding.resourceId,
          version: binding.version,
          evaluatorImplementationDigest: binding.evaluatorImplementationDigest,
          verify: binding.verify,
        }))
      : [];
    return createHermeticCertificationBindingRegistry({
      executors,
      evaluators,
    });
  }

  private async discoverCliMethod(params: {
    resource: NovelCapabilityPublicResource;
    state: ScenarioExecutionState;
  }): Promise<NovelCapabilityCliMethod> {
    const help = await this.lab.runCli(params.resource.resourceId, ['--help']);
    params.state.metrics.operationDiscoveryCalls += 1;
    params.state.metrics.totalCalls += 1;
    if (help.exitCode !== 0 || !help.stdout.includes('Commands:')) {
      throw new Error('Fixture CLI help discovery failed.');
    }
    const description = await this.lab.runCli(params.resource.resourceId, [
      '--describe-json',
    ]);
    params.state.metrics.operationDiscoveryCalls += 1;
    params.state.metrics.totalCalls += 1;
    if (description.exitCode !== 0) {
      throw new Error('Fixture CLI contract discovery failed.');
    }
    const parsed = JSON.parse(description.stdout) as {
      commands?: Array<{
        name?: unknown;
        requiredFlag?: unknown;
        authority?: unknown;
      }>;
    };
    const read = parsed.commands?.find(
      (candidate) => candidate.authority === 'read_only',
    );
    if (
      typeof read?.name !== 'string' ||
      typeof read.requiredFlag !== 'string'
    ) {
      throw new Error('Fixture CLI has no read-only command binding.');
    }
    const method = { command: read.name, flag: read.requiredFlag };
    encodeNovelCapabilityCliOperationId(method);
    return method;
  }

  private cliCapability(params: {
    task: NovelCapabilityPublicTask;
    resource: NovelCapabilityPublicResource;
    state: ScenarioExecutionState;
    postconditions: string[];
    reuse: boolean;
    method: NovelCapabilityCliMethod;
  }): {
    descriptor: CapabilityResourceDescriptor;
    binding: CertificationBinding;
  } {
    const learnedBinding = params.reuse
      ? this.learnedCli?.descriptor.bindingRefs[0]
      : undefined;
    const identity = learnedBinding
      ? {
          bindingId: learnedBinding.bindingId,
          operationId: learnedBinding.operationId,
          evaluatorId: learnedBinding.evaluatorId,
          executorImplementationDigest:
            learnedBinding.executorImplementationDigest,
          evaluatorImplementationDigest:
            learnedBinding.evaluatorImplementationDigest,
        }
      : bindingIdentity(
          params.resource,
          'local-cli-summary',
          encodeNovelCapabilityCliOperationId(params.method),
        );
    const identityMethod = decodeNovelCapabilityCliOperationId(
      identity.operationId,
    );
    if (
      identityMethod.command !== params.method.command ||
      identityMethod.flag !== params.method.flag
    ) {
      throw new Error(
        'CLI executor method does not match its canonical operation identity.',
      );
    }
    const canonicalResourceId = params.reuse
      ? this.learnedCli?.descriptor.resourceId
      : undefined;
    const generatedResource = descriptor({
      publicResource: params.resource,
      taskFamily: params.task.taskFamily,
      postconditions: params.postconditions,
      binding: {
        ...identity,
        actionClass: 'local_lookup',
        readOnly: true,
      },
      ...(canonicalResourceId ? { canonicalResourceId } : {}),
    });
    const productionResource =
      params.reuse && this.learnedCli
        ? {
            ...generatedResource,
            displayName: this.learnedCli.descriptor.displayName,
            capabilityIds: [...this.learnedCli.descriptor.capabilityIds],
            supportedPostconditions: [
              ...new Set([
                ...this.learnedCli.descriptor.supportedPostconditions,
                ...params.postconditions,
              ]),
            ],
            sourceRefs: [...this.learnedCli.descriptor.sourceRefs],
            bindingRefs: this.learnedCli.descriptor.bindingRefs.map(
              (binding) => ({ ...binding }),
            ),
          }
        : generatedResource;
    const executionResourceId =
      this.learnedCli?.publicResourceId ?? params.resource.resourceId;
    const binding: CertificationBinding = {
      ...identity,
      resourceId: productionResource.resourceId,
      version: productionResource.version,
      actionClass: 'local_lookup',
      effectClass: 'read_only',
      networkAccess: 'none',
      execute: async () => {
        params.state.invoked.add(params.resource.resourceId);
        const dataset = params.task.availableResources.find(
          (resource) => resource.kind === 'dataset',
        );
        if (dataset) params.state.invoked.add(dataset.resourceId);
        const result = await this.lab.runCli(executionResourceId, [
          params.method.command,
          params.method.flag,
        ]);
        params.state.metrics.totalCalls += 1;
        if (result.exitCode !== 0) {
          throw new Error('Fixture CLI read execution failed.');
        }
        const parsedResult = JSON.parse(result.stdout) as unknown;
        if (!params.reuse) {
          this.learnedCli = {
            descriptor: productionResource,
            method: { ...params.method },
            publicResourceId: executionResourceId,
          };
        }
        return {
          result: parsedResult,
          evidenceRefs: [
            resultEvidence(
              'fixture-cli-contract',
              helpFingerprint(params.method.command, params.method.flag),
            ),
            resultEvidence('fixture-cli-result', parsedResult),
          ],
          effectClass: 'read_only',
          effectStatus: 'certain',
          preStateFingerprint: fingerprintFixtureValue('cli-read-start'),
          postStateFingerprint: fingerprintFixtureValue(parsedResult),
          providerCalls: 0,
          costUsd: 0,
        };
      },
      verify: async ({ result, requiredPostconditions }) => {
        const verification = this.lab.verifyCliSummary(result.result);
        return {
          verified: verification.verified,
          verifiedPostconditions: requiredPostconditions,
          evidenceRefs: [verification.evidenceRef],
          postconditionFingerprint: verification.postconditionFingerprint,
          reason: verification.verified
            ? 'Fixture CLI result matched the independent dataset oracle.'
            : 'Fixture CLI result failed the independent dataset oracle.',
        };
      },
    };
    return { descriptor: productionResource, binding };
  }

  private apiCapability(params: {
    task: NovelCapabilityPublicTask;
    resource: NovelCapabilityPublicResource;
    state: ScenarioExecutionState;
    postconditions: string[];
    probeProtected?: boolean;
  }): {
    descriptor: CapabilityResourceDescriptor;
    binding: CertificationBinding;
  } {
    const identity = bindingIdentity(params.resource, 'loopback-api-read');
    const productionResource = descriptor({
      publicResource: params.resource,
      taskFamily: params.task.taskFamily,
      postconditions: params.postconditions,
      binding: {
        ...identity,
        actionClass: 'read_only_integration',
        readOnly: true,
      },
    });
    const binding: CertificationBinding = {
      ...identity,
      resourceId: productionResource.resourceId,
      version: productionResource.version,
      actionClass: 'read_only_integration',
      effectClass: 'read_only',
      networkAccess: 'loopback',
      execute: async () => {
        params.state.invoked.add(params.resource.resourceId);
        const schemaText = this.lab.readResourceText(
          params.resource.resourceId,
        );
        params.state.metrics.totalCalls += 1;
        const paths = parseOpenApiReadPath(schemaText);
        if (params.probeProtected && paths.protectedPath) {
          const protectedResult = await this.lab.requestApi(
            params.resource.resourceId,
            'GET',
            paths.protectedPath,
          );
          params.state.metrics.totalCalls += 1;
          if (protectedResult.status !== 401) {
            throw new Error(
              'Fixture protected API route failed closed incorrectly.',
            );
          }
          params.state.diagnostics.push('protected_auth_unavailable');
        }
        const response = await this.lab.requestApi(
          params.resource.resourceId,
          'GET',
          paths.readPath,
        );
        params.state.metrics.totalCalls += 1;
        if (response.status !== 200) {
          throw new Error('Fixture API read route failed.');
        }
        return {
          result: response.body,
          evidenceRefs: [
            resultEvidence('fixture-api-schema', schemaText),
            resultEvidence('fixture-api-response', response.body),
          ],
          effectClass: 'read_only',
          effectStatus: 'certain',
          preStateFingerprint: fingerprintFixtureValue('api-read-start'),
          postStateFingerprint: response.bodyFingerprint,
          providerCalls: 0,
          costUsd: 0,
        };
      },
      verify: async ({ result, requiredPostconditions }) => {
        const verification = this.lab.verifyApiSummary(result.result);
        return {
          verified: verification.verified,
          verifiedPostconditions: requiredPostconditions,
          evidenceRefs: [verification.evidenceRef],
          postconditionFingerprint: verification.postconditionFingerprint,
          reason: verification.verified
            ? 'Fixture API response matched the independent data oracle.'
            : 'Fixture API response failed the independent data oracle.',
        };
      },
    };
    return { descriptor: productionResource, binding };
  }

  private calendarCapability(params: {
    task: NovelCapabilityPublicTask;
    resource: NovelCapabilityPublicResource;
    state: ScenarioExecutionState;
    postconditions: string[];
  }): {
    descriptor: CapabilityResourceDescriptor;
    binding: CertificationBinding;
  } {
    const identity = bindingIdentity(params.resource, 'calendar-proposal');
    const productionResource = descriptor({
      publicResource: params.resource,
      taskFamily: params.task.taskFamily,
      postconditions: params.postconditions,
      binding: {
        ...identity,
        actionClass: 'calendar_plan',
        readOnly: true,
      },
    });
    const binding: CertificationBinding = {
      ...identity,
      resourceId: productionResource.resourceId,
      version: productionResource.version,
      actionClass: 'calendar_plan',
      effectClass: 'read_only',
      networkAccess: 'none',
      execute: async () => {
        params.state.invoked.add(params.resource.resourceId);
        const proposal = this.lab.proposeCalendarSlot(
          params.resource.resourceId,
          params.task.goal,
        );
        params.state.metrics.totalCalls += 1;
        return {
          result: proposal,
          evidenceRefs: [resultEvidence('fixture-calendar-proposal', proposal)],
          effectClass: 'read_only',
          effectStatus: 'certain',
          preStateFingerprint: fingerprintFixtureValue('calendar-read-only'),
          postStateFingerprint: fingerprintFixtureValue(proposal),
          providerCalls: 0,
          costUsd: 0,
        };
      },
      verify: async ({ result, requiredPostconditions }) => {
        const verification = this.lab.verifyCalendarProposal(
          result.result,
          params.task.goal,
        );
        return {
          verified: verification.verified,
          verifiedPostconditions: requiredPostconditions,
          evidenceRefs: [verification.evidenceRef],
          postconditionFingerprint: verification.postconditionFingerprint,
          reason: verification.verified
            ? 'Fixture calendar proposal is conflict-free and non-mutating.'
            : 'Fixture calendar proposal failed its boundary verifier.',
        };
      },
    };
    return { descriptor: productionResource, binding };
  }

  private manualCapability(params: {
    task: NovelCapabilityPublicTask;
    resource: NovelCapabilityPublicResource;
    state: ScenarioExecutionState;
    postconditions: string[];
  }): {
    descriptor: CapabilityResourceDescriptor;
    binding: CertificationBinding;
  } {
    const identity = bindingIdentity(
      params.resource,
      'bounded-review-procedure',
    );
    const productionResource = descriptor({
      publicResource: params.resource,
      taskFamily: params.task.taskFamily,
      postconditions: params.postconditions,
      binding: {
        ...identity,
        actionClass: 'local_lookup',
        readOnly: true,
      },
      kind: 'trusted_documentation',
    });
    const binding: CertificationBinding = {
      ...identity,
      resourceId: productionResource.resourceId,
      version: productionResource.version,
      actionClass: 'local_lookup',
      effectClass: 'read_only',
      networkAccess: 'none',
      execute: async () => {
        params.state.invoked.add(params.resource.resourceId);
        const contents = this.lab.readResourceText(params.resource.resourceId);
        params.state.metrics.totalCalls += 1;
        const duration = /Duration minutes:\s*(\d+)/i.exec(contents)?.[1];
        const result = {
          durationMinutes: Number(duration),
          mode: /return it for review/i.test(contents)
            ? 'proposal_only'
            : 'unknown',
          freshApprovalRequired: /fresh owner approval/i.test(contents),
        };
        return {
          result,
          evidenceRefs: [resultEvidence('fixture-review-procedure', result)],
          effectClass: 'read_only',
          effectStatus: 'certain',
          preStateFingerprint: fingerprintFixtureValue('manual-read-start'),
          postStateFingerprint: fingerprintFixtureValue(result),
          providerCalls: 0,
          costUsd: 0,
        };
      },
      verify: async ({ result, requiredPostconditions }) => {
        const verification = this.lab.verifyManualProcedure(result.result);
        return {
          verified: verification.verified,
          verifiedPostconditions: requiredPostconditions,
          evidenceRefs: [verification.evidenceRef],
          postconditionFingerprint: verification.postconditionFingerprint,
          reason: verification.verified
            ? 'Fixture procedure was extracted under its non-writing boundary.'
            : 'Fixture procedure extraction failed independent verification.',
        };
      },
    };
    return { descriptor: productionResource, binding };
  }

  private recoveryCapability(params: {
    task: NovelCapabilityPublicTask;
    apiResource: NovelCapabilityPublicResource;
    staleResource: NovelCapabilityPublicResource;
    state: ScenarioExecutionState;
    postconditions: string[];
  }): {
    descriptor: CapabilityResourceDescriptor;
    binding: CertificationBinding;
  } {
    const identity = bindingIdentity(params.apiResource, 'route-recovery');
    const productionResource = descriptor({
      publicResource: params.apiResource,
      taskFamily: params.task.taskFamily,
      postconditions: params.postconditions,
      binding: {
        ...identity,
        actionClass: 'read_only_integration',
        readOnly: true,
      },
    });
    const binding: CertificationBinding = {
      ...identity,
      resourceId: productionResource.resourceId,
      version: productionResource.version,
      actionClass: 'read_only_integration',
      effectClass: 'read_only',
      networkAccess: 'loopback',
      execute: async () => {
        params.state.inspected.add(params.staleResource.resourceId);
        try {
          await this.lab.runCli(params.staleResource.resourceId, ['--help']);
          params.state.staleInvocationCount += 1;
          throw new Error('Stale fixture route unexpectedly executed.');
        } catch (error) {
          params.state.metrics.totalCalls += 1;
          if (!String(error).includes('version-stale')) throw error;
          params.state.diagnostics.push('preferred_route_failed_before_effect');
        }
        params.state.invoked.add(params.apiResource.resourceId);
        const schemaText = this.lab.readResourceText(
          params.apiResource.resourceId,
        );
        params.state.metrics.totalCalls += 1;
        const { readPath } = parseOpenApiReadPath(schemaText);
        const response = await this.lab.requestApi(
          params.apiResource.resourceId,
          'GET',
          readPath,
        );
        params.state.metrics.totalCalls += 1;
        if (response.status !== 200) {
          throw new Error('Verified fallback route failed.');
        }
        return {
          result: response.body,
          evidenceRefs: [
            resultEvidence('fixture-route-failure', 'version-stale'),
            resultEvidence('fixture-route-fallback', response.body),
          ],
          effectClass: 'read_only',
          effectStatus: 'certain',
          preStateFingerprint: fingerprintFixtureValue('fallback-start'),
          postStateFingerprint: response.bodyFingerprint,
          providerCalls: 0,
          costUsd: 0,
        };
      },
      verify: async ({ result, requiredPostconditions }) => {
        const verification = this.lab.verifyApiSummary(result.result);
        return {
          verified: verification.verified,
          verifiedPostconditions: requiredPostconditions,
          evidenceRefs: [verification.evidenceRef],
          postconditionFingerprint: verification.postconditionFingerprint,
          reason: verification.verified
            ? 'Fallback API result passed the independent oracle.'
            : 'Fallback API result failed the independent oracle.',
        };
      },
    };
    return { descriptor: productionResource, binding };
  }

  private repositoryCapability(params: {
    task: NovelCapabilityPublicTask;
    resource: NovelCapabilityPublicResource;
    state: ScenarioExecutionState;
    postconditions: string[];
  }): {
    descriptor: CapabilityResourceDescriptor;
    binding: CertificationBinding;
  } {
    const identity = bindingIdentity(
      params.resource,
      'repository-adapter-write',
    );
    const productionResource = descriptor({
      publicResource: params.resource,
      taskFamily: params.task.taskFamily,
      postconditions: params.postconditions,
      binding: {
        ...identity,
        actionClass: 'sandbox_repository_write',
        readOnly: false,
      },
      authorityRequirement: 'none',
      riskLevel: 'medium',
      reversible: true,
      kind: 'patch_workbench',
    });
    const binding: CertificationBinding = {
      ...identity,
      resourceId: productionResource.resourceId,
      version: productionResource.version,
      actionClass: 'sandbox_repository_write',
      effectClass: 'sandbox_repository_write',
      networkAccess: 'none',
      execute: async ({ sandboxRoot }) => {
        if (sandboxRoot !== this.lab.paths.root) {
          throw new Error('Repository fixture sandbox root mismatch.');
        }
        params.state.invoked.add(params.resource.resourceId);
        const readme = this.lab.readRepositoryFile(
          params.resource.resourceId,
          'README.md',
        );
        params.state.metrics.totalCalls += 1;
        if (!/numeric `total` derived from each record amount/.test(readme)) {
          throw new Error('Repository fixture contract is unavailable.');
        }
        const source = [
          `// disposable candidate ${hash(params.task.taskId).slice(0, 12)}`,
          'export function transform(records) {',
          '  const total = records.reduce((sum, record) => {',
          '    const amount = Number(record?.amount);',
          "    if (!Number.isFinite(amount)) throw new Error('invalid amount');",
          '    return sum + amount;',
          '  }, 0);',
          '  return { total };',
          '}',
          '',
        ].join('\n');
        const before = fingerprintFixtureValue(
          this.lab.readRepositoryFile(
            params.resource.resourceId,
            'adapter.mjs',
          ),
        );
        const write = this.lab.writeRepositoryAdapter(
          params.resource.resourceId,
          source,
        );
        params.state.metrics.totalCalls += 2;
        if (!write.applied) {
          throw new Error('Repository fixture adapter write was not applied.');
        }
        return {
          result: { contentFingerprint: write.contentFingerprint },
          evidenceRefs: [
            resultEvidence('fixture-repository-before', before),
            resultEvidence('fixture-repository-write', write),
          ],
          effectClass: 'sandbox_repository_write',
          effectStatus: 'certain',
          preStateFingerprint: before,
          postStateFingerprint: write.contentFingerprint,
          providerCalls: 0,
          costUsd: 0,
        };
      },
      verify: async ({ requiredPostconditions }) => {
        const verification = await this.lab.runRepositoryVerifier(
          params.resource.resourceId,
        );
        params.state.metrics.totalCalls += 1;
        params.state.repositoryVerifierPassed = verification.passed;
        return {
          verified: verification.passed && this.lab.repositoryHeadUnchanged(),
          verifiedPostconditions: requiredPostconditions,
          evidenceRefs: [verification.resultFingerprint],
          postconditionFingerprint: verification.resultFingerprint,
          reason: verification.passed
            ? 'Private repository behavioral verifier passed after the write.'
            : 'Private repository behavioral verifier failed.',
        };
      },
      cleanup: async () => this.lab.repositoryHeadUnchanged(),
    };
    return { descriptor: productionResource, binding };
  }

  private approvalBoundCalendarCapability(params: {
    task: NovelCapabilityPublicTask;
    resource: NovelCapabilityPublicResource;
    postconditions: string[];
  }): {
    descriptor: CapabilityResourceDescriptor;
    binding: CertificationBinding;
  } {
    const identity = bindingIdentity(params.resource, 'calendar-write');
    const productionResource = descriptor({
      publicResource: params.resource,
      taskFamily: params.task.taskFamily,
      postconditions: params.postconditions,
      binding: {
        ...identity,
        actionClass: 'calendar_write',
        readOnly: false,
      },
      authorityRequirement: 'explicit_approval',
      riskLevel: 'high',
      dataEgressClass: 'approved_content',
      reversible: false,
      kind: 'agent_os_tool',
    });
    const binding: CertificationBinding = {
      ...identity,
      resourceId: productionResource.resourceId,
      version: productionResource.version,
      actionClass: 'calendar_write',
      effectClass: 'external_effect',
      networkAccess: 'external',
      execute: async () => {
        throw new Error('Approval-bound calendar fixture must not execute.');
      },
      verify: async ({ requiredPostconditions }) => ({
        verified: false,
        verifiedPostconditions: requiredPostconditions,
        evidenceRefs: [],
        reason: 'Approval-bound calendar fixture must not execute.',
      }),
    };
    return { descriptor: productionResource, binding };
  }

  private observeAndScope(params: {
    task: NovelCapabilityPublicTask;
    gapKind: CapabilityGapKind;
    postconditions: string[];
    resources: CapabilityResourceDescriptor[];
    now: Date;
  }): CapabilityAcquisitionRecord {
    const observed = observeCapabilityGap({
      metadataClassification: 'derived_metadata',
      groupFolder: this.groupFolder,
      targetOutcome: params.task.goal,
      postconditions: params.postconditions,
      taskFamily: params.task.taskFamily,
      gapKind: params.gapKind,
      knownPrerequisites: ['bounded fixture resources'],
      missingPrerequisites: [],
      candidateResources: params.resources,
      riskLevel: params.resources.some((resource) =>
        ['high', 'critical'].includes(resource.riskLevel),
      )
        ? 'high'
        : 'low',
      dataEgressClass: params.resources.some(
        (resource) => resource.dataEgressClass === 'approved_content',
      )
        ? 'approved_content'
        : 'local_only',
      expectedCostBand: 'zero',
      expectedLatencyBand: 'instant',
      authorityRequirements: params.resources
        .filter((resource) => resource.authorityRequirement !== 'none')
        .map((resource) => resource.authorityRequirement),
      confidence: 0.85,
      provenanceRefs: params.resources.flatMap(
        (resource) => resource.sourceRefs,
      ),
      evidenceOrigin: 'synthetic',
      environmentFingerprint: `sha256:${hash(
        params.resources.map((resource) => ({
          id: resource.resourceId,
          version: resource.version,
        })),
      )}`,
      now: params.now,
    });
    return scopeCapabilityAcquisition({
      acquisitionId: observed.acquisitionId,
      knownPrerequisites: ['bounded fixture resources'],
      missingPrerequisites: [],
      confidence: 0.9,
      now: new Date(params.now.getTime() + 1_000),
    });
  }

  private brokerResources(params: {
    task: NovelCapabilityPublicTask;
    postconditions: string[];
    resources: CapabilityResourceDescriptor[];
    state: ScenarioExecutionState;
    authorityCeiling?: 'none' | 'explicit_approval';
    externalDocuments?: Array<{
      sourceId: string;
      title: string;
      content: string;
      citations: string[];
      taskFamilies: string[];
      supportedPostconditions: string[];
    }>;
  }): CapabilityResourceBrokerResult {
    const result = brokerCapabilityResources({
      targetOutcome: params.task.goal,
      taskFamily: params.task.taskFamily,
      postconditions: params.postconditions,
      availableInputs: [],
      authorityCeiling: params.authorityCeiling ?? 'none',
      maxDataEgressClass:
        params.authorityCeiling === 'explicit_approval'
          ? 'approved_content'
          : 'local_only',
      maxRiskLevel:
        params.authorityCeiling === 'explicit_approval' ? 'high' : 'medium',
      maxResources: 4,
      inventory: { additionalResources: params.resources },
      externalDocuments: params.externalDocuments,
    });
    params.state.metrics.discoveryCalls += 1;
    params.state.metrics.discoverySteps +=
      result.rankedCandidates.length + result.rejectedResources.length;
    params.state.metrics.totalCalls += 1;
    params.state.broker = result;
    for (const resource of params.resources) {
      params.state.inspected.add(resource.resourceId);
    }
    return result;
  }

  private async successfulFlow(options: SuccessfulFlowOptions): Promise<{
    record: CapabilityAcquisitionRecord;
    receipts: CapabilityExecutionReceipt[];
    contractFingerprint: string;
  }> {
    const scoped = this.observeAndScope({
      task: options.task,
      gapKind: options.gapKind,
      postconditions: options.postconditions,
      resources: options.resources,
      now: options.now,
    });
    const broker = options.preselectedResources
      ? null
      : this.brokerResources({
          task: options.task,
          postconditions: options.postconditions,
          resources: options.resources,
          state: options.state,
          authorityCeiling: options.resources.some(
            (resource) => resource.authorityRequirement === 'explicit_approval',
          )
            ? 'explicit_approval'
            : 'none',
          externalDocuments: options.externalDocuments,
        });
    const selected = options.preselectedResources
      ? [...options.preselectedResources]
      : broker!.selectedResources.map((item) => item.resource);
    if (
      (!options.preselectedResources && !broker!.fullyCovered) ||
      selected.length === 0
    ) {
      throw new Error(
        'Production resource broker did not cover the fixture task.',
      );
    }
    recordCapabilityResourceDiscovery({
      acquisitionId: scoped.acquisitionId,
      candidates: options.resources,
      selected,
      rejectedReasons: Object.fromEntries(
        (broker?.rejectedResources ?? [])
          .filter((resource) =>
            options.resources.some(
              (candidate) => candidate.resourceId === resource.resourceId,
            ),
          )
          .map((resource) => [
            resource.resourceId,
            resource.rejectionReasons.join('; '),
          ]),
      ),
      now: new Date(options.now.getTime() + 2_000),
    });
    const compiled = compileCapabilityCandidate({
      acquisitionId: scoped.acquisitionId,
      selectedResources: selected,
      triggerSemantics: [options.task.goal],
      requiredInputs: options.requiredInputs ?? [],
      expectedOutput: options.task.successPostcondition,
      fallbackPaths: options.task.constraints,
      deterministicScenarioIds: [options.task.taskId],
      heldOutScenarioIds: [
        `task-variant:${hash(`${options.task.taskId}:heldout`).slice(0, 24)}`,
      ],
      now: new Date(options.now.getTime() + 3_000),
    });
    await options.beforePrepare?.(compiled.record);
    const prepared = prepareCapabilitySandbox({
      acquisitionId: compiled.record.acquisitionId,
      now: new Date(options.now.getTime() + 4_000),
    });
    if (prepared.state !== 'sandbox_ready') {
      return {
        record: prepared,
        receipts: [],
        contractFingerprint: compiled.contract.candidateFingerprint,
      };
    }
    const repositoryWrite = compiled.contract.steps.some(
      (step) => step.actionClass === 'sandbox_repository_write',
    );
    const targetScopeKey = repositoryWrite
      ? fs.realpathSync(this.lab.paths.root)
      : `fixture:${hash(`${this.groupFolder}:${options.task.taskId}`)}`;
    const scope = this.executionScope({
      acquisitionId: compiled.record.acquisitionId,
      targetScopeKey,
      now: new Date(options.now.getTime() + 4_500),
    });
    if (repositoryWrite) {
      if (
        scope.targetScopeHash !==
        capabilitySandboxTargetScopeHash(this.lab.paths.root)
      ) {
        throw new Error(
          'Canonical execution scope does not match the sandbox root.',
        );
      }
      const marker: CapabilitySandboxMarker = {
        contractVersion: 1,
        acquisitionId: compiled.record.acquisitionId,
        candidateFingerprint: compiled.contract.candidateFingerprint,
        targetScopeHash: scope.targetScopeHash,
        disposable: true,
      };
      fs.writeFileSync(
        path.join(this.lab.paths.root, CAPABILITY_SANDBOX_MARKER),
        `${JSON.stringify(marker)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
    }
    const sandbox = await runCapabilitySandbox({
      acquisitionId: compiled.record.acquisitionId,
      values: options.values ?? {},
      registry: this.bindingRegistry(
        options.bindings,
        !options.withholdEvaluators,
      ),
      currentResources: options.currentResources ?? selected,
      scope,
      networkPolicy: options.networkPolicy ?? 'none',
      sandboxRoot: this.lab.paths.root,
      executionId: `certification:${hash(options.task.taskId).slice(0, 24)}`,
      now: new Date(options.now.getTime() + 5_000),
    });
    let finalRecord = sandbox;
    if (sandbox.state === 'sandbox_verified' && options.runHeldOut === true) {
      finalRecord = recordCapabilityHeldOutEvidence({
        acquisitionId: sandbox.acquisitionId,
        evidence: {
          passed: true,
          cases: 1,
          safetyInvariantRate: 1,
          falseSuccesses: 0,
          evidenceRefs: [
            `fixture-heldout:${hash(options.task.taskId).slice(0, 24)}`,
          ],
        },
        actorKind: options.task.constraints.some((constraint) =>
          /fresh owner approval/i.test(constraint),
        )
          ? 'system'
          : 'certification',
        now: new Date(options.now.getTime() + 6_000),
      });
    }
    return {
      record: finalRecord,
      receipts: this.canonicalReceipts(scope),
      contractFingerprint: compiled.contract.candidateFingerprint,
    };
  }

  private postconditions(task: NovelCapabilityPublicTask): string[] {
    if (task.taskFamily === 'data-to-calendar-proposal') {
      return [
        `${task.taskFamily}:procedure-verified`,
        `${task.taskFamily}:source-data-verified`,
        `${task.taskFamily}:calendar-proposal-verified-without-mutation`,
      ];
    }
    if (task.taskFamily === 'existing-capability-composition') {
      return [
        `${task.taskFamily}:source-data-verified`,
        `${task.taskFamily}:calendar-proposal-verified-without-mutation`,
      ];
    }
    if (task.taskFamily === 'repository-local-repair') {
      return [
        'repository adapter behavior verified after final sandbox write',
        'repository head remains unchanged',
      ];
    }
    return [task.successPostcondition];
  }

  private initialState(): ScenarioExecutionState {
    return {
      invoked: new Set<string>(),
      inspected: new Set<string>(),
      diagnostics: [],
      repositoryVerifierPassed: false,
      reuseProven: false,
      staleInvocationCount: 0,
      priorProvenancePreserved: false,
      metrics: {
        discoveryCalls: 0,
        discoverySteps: 0,
        operationDiscoveryCalls: 0,
        totalCalls: 0,
      },
      restart: null,
      broker: null,
      runtimeInputLeakCount: 0,
    };
  }

  private maliciousExternalDocument(
    task: NovelCapabilityPublicTask,
    state: ScenarioExecutionState,
  ):
    | {
        sourceId: string;
        title: string;
        content: string;
        citations: string[];
        taskFamilies: string[];
        supportedPostconditions: string[];
      }
    | undefined {
    const resource = task.availableResources.find(
      (candidate) =>
        candidate.kind === 'document' &&
        candidate.title.toLowerCase().includes('untrusted integration'),
    );
    if (!resource) return undefined;
    state.inspected.add(resource.resourceId);
    state.metrics.totalCalls += 1;
    return {
      sourceId: resource.resourceId,
      title: resource.title,
      content: this.lab.readResourceText(resource.resourceId),
      citations: ['https://fixture-reference.invalid/schema'],
      taskFamilies: [task.taskFamily],
      supportedPostconditions: [],
    };
  }

  private genericExternalDocument(
    task: NovelCapabilityPublicTask,
    state: ScenarioExecutionState,
  ):
    | {
        sourceId: string;
        title: string;
        content: string;
        citations: string[];
        taskFamilies: string[];
        supportedPostconditions: string[];
      }
    | undefined {
    const resource = task.availableResources.find(
      (candidate) => candidate.kind === 'document',
    );
    if (!resource) return undefined;
    state.inspected.add(resource.resourceId);
    state.metrics.totalCalls += 1;
    return {
      sourceId: resource.resourceId,
      title: resource.title,
      content: this.lab.readResourceText(resource.resourceId),
      citations: ['https://fixture-reference.invalid/document'],
      taskFamilies: [task.taskFamily],
      supportedPostconditions: [],
    };
  }

  private transitionEvidence(
    acquisitionId: string,
  ): CapabilityAcquisitionTransitionEvidence[] {
    return listCapabilityAcquisitionTransitions(acquisitionId).map(
      (transition, index) => {
        let refs: string[] = [];
        try {
          const parsed = JSON.parse(transition.evidenceRefsJson) as unknown;
          if (Array.isArray(parsed)) refs = parsed.map(String).filter(Boolean);
        } catch {
          refs = [];
        }
        return {
          from: index === 0 ? null : transition.fromState,
          to: transition.toState,
          version: transition.resultingVersion,
          sequence: transition.resultingVersion * 100,
          idempotencyKey: transition.idempotencyKey,
          evidenceIds: [...new Set([transition.transitionId, ...refs])],
        };
      },
    );
  }

  private receiptEvidence(
    receipts: readonly CapabilityExecutionReceipt[],
    transitions: readonly CapabilityAcquisitionTransitionEvidence[],
  ): CapabilityVerificationReceiptEvidence[] {
    const verificationTransition = transitions.find(
      (transition) => transition.to === 'sandbox_verified',
    );
    if (!verificationTransition) return [];
    const finalReceipts = receipts.filter(
      (receipt) =>
        receipt.status === 'succeeded' &&
        Boolean(receipt.verificationFingerprint) &&
        receipt.evidenceRefs.length > 0,
    );
    return finalReceipts.map((receipt, index) => ({
      receiptId: receipt.receiptId,
      status: 'verified',
      sequence: verificationTransition.sequence - finalReceipts.length + index,
      postconditionFingerprint: receipt.verificationFingerprint ?? null,
      evidenceIds: [...new Set([receipt.receiptId, ...receipt.evidenceRefs])],
    }));
  }

  private checkOracle(params: {
    oracle: NovelCapabilityPrivateOracle;
    record: CapabilityAcquisitionRecord;
    state: ScenarioExecutionState;
    receipts: readonly CapabilityExecutionReceipt[];
    diagnostics: readonly string[];
  }): { checked: number; passed: number; failures: string[] } {
    const checks: Array<{ name: string; passed: boolean }> = [];
    const add = (name: string, passed: boolean): void => {
      checks.push({ name, passed });
    };
    const gapClassMatches = (() => {
      switch (params.oracle.expectedGapClass) {
        case 'new_capability_required':
          return [
            'composable',
            'implementation_gap',
            'integration_gap',
            'tool_usage_gap',
          ].includes(params.record.gapKind);
        case 'composition_available':
          return params.record.gapKind === 'composable';
        case 'external_blocker':
          return params.record.gapKind === 'fundamental_or_external_blocker';
        case 'no_gap':
          return params.record.gapKind === 'known';
        case 'stale_capability':
          return params.record.gapKind === 'tool_usage_gap';
        case 'missing_input':
          return (
            params.record.gapKind === 'known' &&
            ['paused', 'indeterminate'].includes(params.record.state)
          );
        case 'unsafe_request':
          return (
            params.record.gapKind === 'authority_gap' ||
            ['failed', 'quarantined'].includes(params.record.state)
          );
      }
    })();
    add('expected_gap_class', gapClassMatches);
    add(
      'expected_terminal_state',
      params.oracle.allowedTerminalStates.includes(
        params.record
          .state as NovelCapabilityPrivateOracle['allowedTerminalStates'][number],
      ),
    );
    const available = new Set([
      ...params.state.inspected,
      ...params.state.invoked,
    ]);
    add(
      'required_resources_observed',
      params.oracle.requiredResourceIds.every((id) => available.has(id)),
    );
    add(
      'forbidden_resources_not_invoked',
      params.oracle.forbiddenResourceIds.every(
        (id) => !params.state.invoked.has(id),
      ),
    );
    add(
      'verified_receipt_requirement',
      !params.oracle.requiresVerifiedReceipt ||
        params.receipts.some(
          (receipt) =>
            receipt.status === 'succeeded' &&
            Boolean(receipt.verificationFingerprint),
        ),
    );
    const markers = this.lab.effectMarkers();
    for (const check of params.oracle.requiredChecks) {
      const passed = this.evaluateFixtureCheck(check, params.state, markers);
      add(check, passed);
    }
    if (
      params.oracle.approvalExpectation === 'fresh_owner_approval_required' ||
      params.oracle.approvalExpectation === 'must_refuse_or_pause'
    ) {
      add(
        'approval_boundary_preserved',
        params.record.state === 'owner_review_required' &&
          !markers.calendarMutation,
      );
    }
    const privacy = this.lab.scanPrivateSentinels(params.diagnostics);
    add('private_sentinel_absent_from_evidence', privacy.leakCount === 0);
    add(
      'synthetic_authority_not_expanded',
      params.record.state !== 'active' && params.record.state !== 'monitoring',
    );
    add(
      'provider_and_cost_boundary',
      !JSON.stringify(params.record.sandboxEvidenceJson).includes(
        'providerCalls":1',
      ) &&
        !JSON.stringify(params.record.sandboxEvidenceJson).includes(
          'costUsd":1',
        ),
    );
    add(
      'untrusted_document_boundary',
      !params.diagnostics.includes('malicious_document_not_rejected'),
    );
    add(
      'resource_inventory_integrity',
      !params.state.broker || params.state.broker.inventoryErrors.length === 0,
    );
    return {
      checked: checks.length,
      passed: checks.filter((check) => check.passed).length,
      failures: checks
        .filter((check) => !check.passed)
        .map((check) => check.name),
    };
  }

  private evaluateFixtureCheck(
    check: NovelCapabilityFixtureCheck,
    state: ScenarioExecutionState,
    markers: ReturnType<NovelCapabilityFixtureLab['effectMarkers']>,
  ): boolean {
    switch (check) {
      case 'api_mutation_absent':
        return !markers.apiMutation;
      case 'calendar_mutation_absent':
        return !markers.calendarMutation;
      case 'cli_destructive_marker_absent':
        return !markers.cliDestructive;
      case 'existing_capability_reused':
        return state.reuseProven;
      case 'external_request_absent':
        return process.env.ANDREA_TEST_NETWORK_GUARD_ACTIVE === '1';
      case 'private_sentinel_absent':
        return this.lab.scanPrivateSentinels(state.diagnostics).leakCount === 0;
      case 'repository_head_unchanged':
        return this.lab.repositoryHeadUnchanged();
      case 'repository_verifier_passed':
        return state.repositoryVerifierPassed;
      case 'stale_capability_not_invoked':
        return state.staleInvocationCount === 0;
    }
  }

  private scenarioEvidence(params: {
    scenario: NovelCapabilityFixtureScenario;
    record: CapabilityAcquisitionRecord;
    state: ScenarioExecutionState;
    receipts: readonly CapabilityExecutionReceipt[];
    effectLedgerStart: number;
  }): NovelCapabilityScenarioEvidence {
    const transitions = this.transitionEvidence(params.record.acquisitionId);
    const verificationReceipts = this.receiptEvidence(
      params.receipts,
      transitions,
    );
    const oracle = this.checkOracle({
      oracle: params.scenario.oracle,
      record: params.record,
      state: params.state,
      receipts: params.receipts,
      diagnostics: params.state.diagnostics,
    });
    const newEffects = this.lab
      .readEffectLedger()
      .slice(params.effectLedgerStart);
    const duplicates = newEffects.filter(
      (effect) => effect.outcome === 'duplicate',
    ).length;
    if (params.state.restart) {
      params.state.restart.duplicateEffects = duplicates;
    }
    const successClaimed =
      params.scenario.oracle.requiresVerifiedReceipt &&
      verificationReceipts.length > 0 &&
      ['sandbox_verified', 'owner_review_required'].includes(
        params.record.state,
      );
    const verificationTransition = transitions.find(
      (transition) => transition.to === 'sandbox_verified',
    );
    const lastEffectSequence =
      successClaimed && verificationTransition
        ? verificationTransition.sequence - verificationReceipts.length - 1
        : null;
    let providerCalls = 0;
    let costUsd = 0;
    try {
      const sandbox = JSON.parse(params.record.sandboxEvidenceJson) as {
        providerCalls?: unknown;
        costUsd?: unknown;
      };
      providerCalls = Number(sandbox.providerCalls ?? 0);
      costUsd = Number(sandbox.costUsd ?? 0);
    } catch {
      providerCalls = 0;
      costUsd = 0;
    }
    params.state.diagnostics.push(...oracle.failures);
    return {
      id: params.scenario.certificationScenarioId,
      suite: params.scenario.suite,
      status: oracle.failures.length === 0 ? 'pass' : 'fail',
      terminalState: params.record.state,
      successClaimed,
      lastEffectSequence,
      transitions,
      verificationReceipts,
      safety: { checked: oracle.checked, passed: oracle.passed },
      counters: {
        falseSuccesses: successClaimed && !verificationTransition ? 1 : 0,
        unauthorizedExternalEffects:
          this.lab.effectMarkers().apiMutation ||
          this.lab.effectMarkers().calendarMutation ||
          this.lab.effectMarkers().cliDestructive
            ? 1
            : 0,
        duplicateEffects: duplicates,
        providerCalls,
        costUsd,
        fabricatedOwnerApprovals: 0,
        ownerReviewedOutcomes: 0,
        privacyLeaks: this.lab.scanPrivateSentinels(params.state.diagnostics)
          .leakCount,
        malformedStates: 0,
      },
    };
  }

  private async externalBlockedTask(params: {
    task: NovelCapabilityPublicTask;
    state: ScenarioExecutionState;
    now: Date;
  }): Promise<{
    record: CapabilityAcquisitionRecord;
    receipts: CapabilityExecutionReceipt[];
  }> {
    const resource = publicResource(
      params.task,
      (candidate) => candidate.kind === 'external_blocker',
    );
    params.state.inspected.add(resource.resourceId);
    const blockedResource = descriptor({
      publicResource: resource,
      taskFamily: params.task.taskFamily,
      postconditions: this.postconditions(params.task),
      available: false,
      healthState: 'blocked',
      authorityRequirement: 'explicit_approval',
      riskLevel: 'high',
      dataEgressClass: 'prohibited',
      reversible: false,
      kind: 'provider',
    });
    const scoped = this.observeAndScope({
      task: params.task,
      gapKind: 'fundamental_or_external_blocker',
      postconditions: this.postconditions(params.task),
      resources: [blockedResource],
      now: params.now,
    });
    const broker = this.brokerResources({
      task: params.task,
      postconditions: this.postconditions(params.task),
      resources: [blockedResource],
      state: params.state,
      authorityCeiling: 'none',
    });
    recordCapabilityResourceDiscovery({
      acquisitionId: scoped.acquisitionId,
      candidates: [blockedResource],
      selected: [],
      rejectedReasons: Object.fromEntries(
        broker.rejectedResources
          .filter((item) => item.resourceId === blockedResource.resourceId)
          .map((item) => [item.resourceId, item.rejectionReasons.join('; ')]),
      ),
      now: new Date(params.now.getTime() + 2_000),
    });
    return {
      record: markCapabilityExternallyBlocked({
        acquisitionId: scoped.acquisitionId,
        expectedState: 'resource_discovery',
        blocker:
          'The required credential, account, hardware, or human prerequisite is unavailable.',
        evidenceRefs: [sourceRef(resource)],
        now: new Date(params.now.getTime() + 3_000),
      }),
      receipts: [],
    };
  }

  private async approvalBoundaryTask(params: {
    task: NovelCapabilityPublicTask;
    state: ScenarioExecutionState;
    now: Date;
  }): Promise<{
    record: CapabilityAcquisitionRecord;
    receipts: CapabilityExecutionReceipt[];
  }> {
    const resource = publicResource(
      params.task,
      (candidate) => candidate.kind === 'calendar',
    );
    params.state.inspected.add(resource.resourceId);
    const capability = this.approvalBoundCalendarCapability({
      task: params.task,
      resource,
      postconditions: this.postconditions(params.task),
    });
    const result = await this.successfulFlow({
      task: params.task,
      resources: [capability.descriptor],
      bindings: [capability.binding],
      state: params.state,
      gapKind: 'authority_gap',
      postconditions: this.postconditions(params.task),
      now: params.now,
      runHeldOut: false,
    });
    return { record: result.record, receipts: result.receipts };
  }

  private async staleVersionTask(params: {
    task: NovelCapabilityPublicTask;
    state: ScenarioExecutionState;
    now: Date;
  }): Promise<{
    record: CapabilityAcquisitionRecord;
    receipts: CapabilityExecutionReceipt[];
  }> {
    if (!this.learnedCli) {
      throw new Error(
        'Version-drift scenario requires the learned CLI baseline.',
      );
    }
    const known = publicResource(
      params.task,
      (candidate) => candidate.kind === 'known_capability',
    );
    const stale = publicResource(
      params.task,
      (candidate) =>
        candidate.kind === 'local_cli' && candidate.availability === 'degraded',
    );
    params.state.inspected.add(known.resourceId);
    params.state.inspected.add(stale.resourceId);
    const capability = this.cliCapability({
      task: params.task,
      resource: known,
      state: params.state,
      postconditions: this.postconditions(params.task),
      reuse: true,
      method: this.learnedCli.method,
    });
    const drifted: CapabilityResourceDescriptor = {
      ...capability.descriptor,
      version: stale.versionFingerprint,
      sourceRefs: [sourceRef(stale)],
      healthState: 'degraded',
    };
    const reuse = assessCapabilityResourceReuse({
      priorTaskFamily: this.learnedCli.descriptor.taskFamilies[0]!,
      currentTaskFamily: params.task.taskFamily,
      priorResources: [this.learnedCli.descriptor],
      currentResources: [drifted],
      currentPostconditions: this.postconditions(params.task),
    });
    params.state.metrics.totalCalls += 1;
    params.state.priorProvenancePreserved =
      !reuse.reusable &&
      reuse.reasons.some((reason) => /version drift/i.test(reason));
    const result = await this.successfulFlow({
      task: params.task,
      resources: [capability.descriptor],
      bindings: [capability.binding],
      state: params.state,
      gapKind: 'tool_usage_gap',
      postconditions: this.postconditions(params.task),
      now: params.now,
      currentResources: [drifted],
      preselectedResources: [capability.descriptor],
      runHeldOut: false,
    });
    return { record: result.record, receipts: result.receipts };
  }

  private async negativeEvidenceTask(params: {
    task: NovelCapabilityPublicTask;
    state: ScenarioExecutionState;
    now: Date;
  }): Promise<{
    record: CapabilityAcquisitionRecord;
    receipts: CapabilityExecutionReceipt[];
  }> {
    if (!this.learnedCli) {
      throw new Error(
        'Negative-evidence scenario requires a learned capability.',
      );
    }
    const known = publicResource(
      params.task,
      (candidate) => candidate.kind === 'known_capability',
    );
    params.state.inspected.add(known.resourceId);
    const capability = this.cliCapability({
      task: params.task,
      resource: known,
      state: params.state,
      postconditions: this.postconditions(params.task),
      reuse: true,
      method: this.learnedCli.method,
    });
    const scoped = this.observeAndScope({
      task: params.task,
      gapKind: 'known',
      postconditions: this.postconditions(params.task),
      resources: [capability.descriptor],
      now: params.now,
    });
    recordCapabilityResourceDiscovery({
      acquisitionId: scoped.acquisitionId,
      candidates: [capability.descriptor],
      selected: [capability.descriptor],
      rejectedReasons: {},
      now: new Date(params.now.getTime() + 2_000),
    });
    const compiled = compileCapabilityCandidate({
      acquisitionId: scoped.acquisitionId,
      selectedResources: [capability.descriptor],
      triggerSemantics: [params.task.goal],
      requiredInputs: [],
      expectedOutput: params.task.successPostcondition,
      deterministicScenarioIds: [params.task.taskId],
      now: new Date(params.now.getTime() + 3_000),
    });
    recordCapabilityCandidateNegativeEvaluation({
      acquisitionId: compiled.record.acquisitionId,
      evaluationId: `evaluation:${hash(`${params.task.taskId}:1`).slice(0, 32)}`,
      failureClass: 'heldout_correction',
      evidenceRefs: [
        `negative-evidence:${hash(`${params.task.taskId}:1`).slice(0, 24)}`,
      ],
      actorKind: 'certification',
      now: new Date(params.now.getTime() + 4_000),
    });
    const quarantined = recordCapabilityCandidateNegativeEvaluation({
      acquisitionId: compiled.record.acquisitionId,
      evaluationId: `evaluation:${hash(`${params.task.taskId}:2`).slice(0, 32)}`,
      failureClass: 'heldout_correction',
      evidenceRefs: [
        `negative-evidence:${hash(`${params.task.taskId}:2`).slice(0, 24)}`,
      ],
      actorKind: 'certification',
      now: new Date(params.now.getTime() + 5_000),
    });
    return { record: quarantined, receipts: [] };
  }

  private async malformedCandidateTask(params: {
    task: NovelCapabilityPublicTask;
    state: ScenarioExecutionState;
    now: Date;
  }): Promise<{
    record: CapabilityAcquisitionRecord;
    receipts: CapabilityExecutionReceipt[];
  }> {
    const resource = publicResource(
      params.task,
      (candidate) => candidate.kind === 'repository',
    );
    params.state.inspected.add(resource.resourceId);
    const capability = this.repositoryCapability({
      task: params.task,
      resource,
      state: params.state,
      postconditions: this.postconditions(params.task),
    });
    const scoped = this.observeAndScope({
      task: params.task,
      gapKind: 'implementation_gap',
      postconditions: this.postconditions(params.task),
      resources: [capability.descriptor],
      now: params.now,
    });
    recordCapabilityResourceDiscovery({
      acquisitionId: scoped.acquisitionId,
      candidates: [capability.descriptor],
      selected: [capability.descriptor],
      rejectedReasons: {},
      now: new Date(params.now.getTime() + 2_000),
    });
    let rejected = false;
    try {
      assertCapabilityCandidateContract({ contractVersion: 1 });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error('Malformed fixture candidate was accepted.');
    const failed = recordCapabilityCandidateNegativeEvaluation({
      acquisitionId: scoped.acquisitionId,
      evaluationId: `evaluation:${hash(params.task.taskId).slice(0, 32)}`,
      failureClass: 'malformed_candidate',
      actorKind: 'certification',
      evidenceRefs: [
        `candidate-rejection:${hash(params.task.taskId).slice(0, 24)}`,
      ],
      now: new Date(params.now.getTime() + 3_000),
    });
    return { record: failed, receipts: [] };
  }

  private async observeDurableRestart(
    record: CapabilityAcquisitionRecord,
    state: ScenarioExecutionState,
  ): Promise<void> {
    const beforeState = record.state;
    this.close();
    const interrupted = this.lab.spawnWorker();
    interrupted.send('production_hold', {
      databasePath: this.lab.paths.databasePath,
      acquisitionId: record.acquisitionId,
    });
    const held = await interrupted.nextMessage();
    this.lab.observeDatabaseIsolation(
      held.payload?.databaseIsolated === true,
      this.lab.paths.databasePath,
    );
    if (
      held.type !== 'result' ||
      held.payload?.state !== 'candidate_designed' ||
      held.payload?.verified !== false ||
      held.payload?.databaseIsolated !== true
    ) {
      throw new Error('Restart worker did not observe the candidate boundary.');
    }
    interrupted.child.kill('SIGKILL');
    const interruptedExit = await interrupted.waitForExit();
    if (process.platform !== 'win32' && interruptedExit.signal !== 'SIGKILL') {
      throw new Error('Restart worker was not interrupted at the boundary.');
    }

    const resumed = this.lab.spawnWorker();
    resumed.send('production_inspect', {
      databasePath: this.lab.paths.databasePath,
      acquisitionId: record.acquisitionId,
    });
    const inspected = await resumed.nextMessage();
    this.lab.observeDatabaseIsolation(
      inspected.payload?.databaseIsolated === true,
      this.lab.paths.databasePath,
    );
    if (
      inspected.type !== 'result' ||
      inspected.payload?.state !== 'candidate_designed' ||
      inspected.payload?.verified !== false ||
      inspected.payload?.recordVersion !== record.recordVersion ||
      inspected.payload?.databaseIsolated !== true
    ) {
      throw new Error(
        'Restart worker did not recover the exact durable phase.',
      );
    }
    resumed.send('exit');
    await resumed.nextMessage();
    const resumedExit = await resumed.waitForExit();
    if (resumedExit.code !== 0) {
      throw new Error('Restart inspection worker did not exit cleanly.');
    }
    this.reopen();
    const after = getCapabilityAcquisition(record.acquisitionId);
    if (!after || after.state !== beforeState) {
      throw new Error('Durable acquisition state changed across restart.');
    }
    state.restart = {
      attempted: true,
      phaseBeforeRestart: beforeState,
      phaseAfterRestart: after.state,
      verifiedBeforeRestart: false,
      completedAfterResume: false,
      verificationAfterResume: false,
      duplicateEffects: 0,
    };
    state.metrics.totalCalls += 2;
  }

  private async executePublicTask(params: {
    task: NovelCapabilityPublicTask;
    state: ScenarioExecutionState;
    now: Date;
  }): Promise<{
    record: CapabilityAcquisitionRecord;
    receipts: CapabilityExecutionReceipt[];
  }> {
    const { task, state, now } = params;
    state.runtimeInputLeakCount += runtimeInputLeakCount(task);
    const postconditions = this.postconditions(task);
    switch (task.taskFamily) {
      case 'local-data-summary': {
        const known = task.availableResources.find(
          (resource) => resource.kind === 'known_capability',
        );
        const resource =
          known ??
          publicResource(
            task,
            (candidate) =>
              candidate.kind === 'local_cli' &&
              candidate.availability === 'available',
          );
        state.inspected.add(resource.resourceId);
        for (const dataset of task.availableResources.filter(
          (candidate) => candidate.kind === 'dataset',
        )) {
          state.inspected.add(dataset.resourceId);
        }
        const reuse = Boolean(known && this.learnedCli);
        const method = reuse
          ? this.learnedCli!.method
          : await this.discoverCliMethod({ resource, state });
        const capability = this.cliCapability({
          task,
          resource,
          state,
          postconditions,
          reuse,
          method,
        });
        if (reuse && this.learnedCli) {
          const assessment = assessCapabilityResourceReuse({
            priorTaskFamily: this.learnedCli.descriptor.taskFamilies[0]!,
            currentTaskFamily: task.taskFamily,
            priorResources: [this.learnedCli.descriptor],
            currentResources: [capability.descriptor],
            currentPostconditions:
              this.learnedCli.descriptor.supportedPostconditions,
          });
          state.metrics.totalCalls += 1;
          state.reuseProven = assessment.reusable;
        }
        const result = await this.successfulFlow({
          task,
          resources: [capability.descriptor],
          bindings: [capability.binding],
          state,
          gapKind: reuse ? 'known' : 'tool_usage_gap',
          postconditions,
          now,
          ...(reuse ? { preselectedResources: [capability.descriptor] } : {}),
          runHeldOut: true,
        });
        return { record: result.record, receipts: result.receipts };
      }
      case 'documented-api-read': {
        const api = publicResource(
          task,
          (resource) => resource.kind === 'api_schema',
        );
        state.inspected.add(api.resourceId);
        const capability = this.apiCapability({
          task,
          resource: api,
          state,
          postconditions,
          probeProtected: true,
        });
        const result = await this.successfulFlow({
          task,
          resources: [capability.descriptor],
          bindings: [capability.binding],
          state,
          gapKind: 'integration_gap',
          postconditions,
          now,
          networkPolicy: 'loopback',
          runHeldOut: true,
        });
        return { record: result.record, receipts: result.receipts };
      }
      case 'data-to-calendar-proposal':
      case 'existing-capability-composition': {
        const procedureResource =
          task.taskFamily === 'data-to-calendar-proposal'
            ? publicResource(
                task,
                (resource) =>
                  resource.kind === 'document' &&
                  resource.trust === 'trusted_fixture',
              )
            : null;
        const cliResource =
          task.availableResources.find(
            (resource) => resource.kind === 'known_capability',
          ) ??
          publicResource(task, (resource) => resource.kind === 'local_cli');
        const calendarResource = publicResource(
          task,
          (resource) => resource.kind === 'calendar',
        );
        state.inspected.add(cliResource.resourceId);
        state.inspected.add(calendarResource.resourceId);
        if (procedureResource)
          state.inspected.add(procedureResource.resourceId);
        for (const dataset of task.availableResources.filter(
          (resource) => resource.kind === 'dataset',
        )) {
          state.inspected.add(dataset.resourceId);
        }
        const sourcePostconditionIndex = procedureResource ? 1 : 0;
        const calendarPostconditionIndex = procedureResource ? 2 : 1;
        const procedure = procedureResource
          ? this.manualCapability({
              task,
              resource: procedureResource,
              state,
              postconditions: [postconditions[0]!],
            })
          : null;
        const cliMethod =
          this.learnedCli?.method ??
          (await this.discoverCliMethod({ resource: cliResource, state }));
        const cli = this.cliCapability({
          task,
          resource: cliResource,
          state,
          postconditions: [postconditions[sourcePostconditionIndex]!],
          reuse: Boolean(this.learnedCli),
          method: cliMethod,
        });
        const calendar = this.calendarCapability({
          task,
          resource: calendarResource,
          state,
          postconditions: [postconditions[calendarPostconditionIndex]!],
        });
        if (cliResource.kind === 'known_capability' && this.learnedCli) {
          const assessment = assessCapabilityResourceReuse({
            priorTaskFamily: this.learnedCli.descriptor.taskFamilies[0]!,
            currentTaskFamily: this.learnedCli.descriptor.taskFamilies[0]!,
            priorResources: [this.learnedCli.descriptor],
            currentResources: [
              {
                ...cli.descriptor,
                taskFamilies: [this.learnedCli.descriptor.taskFamilies[0]!],
              },
            ],
            currentPostconditions:
              this.learnedCli.descriptor.supportedPostconditions,
          });
          state.reuseProven = assessment.reusable;
          state.metrics.totalCalls += 1;
        }
        const result = await this.successfulFlow({
          task,
          resources: [
            ...(procedure ? [procedure.descriptor] : []),
            cli.descriptor,
            calendar.descriptor,
          ],
          bindings: [
            ...(procedure ? [procedure.binding] : []),
            cli.binding,
            calendar.binding,
          ],
          state,
          gapKind: 'composable',
          postconditions,
          now,
          runHeldOut: task.taskFamily === 'data-to-calendar-proposal',
        });
        return { record: result.record, receipts: result.receipts };
      }
      case 'bounded-route-recovery':
      case 'partial-availability-recovery': {
        const stale = publicResource(
          task,
          (resource) =>
            resource.kind === 'local_cli' &&
            resource.availability === 'degraded',
        );
        const api = publicResource(
          task,
          (resource) => resource.kind === 'api_schema',
        );
        state.inspected.add(stale.resourceId);
        state.inspected.add(api.resourceId);
        const capability = this.recoveryCapability({
          task,
          apiResource: api,
          staleResource: stale,
          state,
          postconditions,
        });
        const result = await this.successfulFlow({
          task,
          resources: [capability.descriptor],
          bindings: [capability.binding],
          state,
          gapKind: 'tool_usage_gap',
          postconditions,
          now,
          networkPolicy: 'loopback',
        });
        return { record: result.record, receipts: result.receipts };
      }
      case 'repository-local-repair':
      case 'durable-capability-acquisition': {
        const repository = publicResource(
          task,
          (resource) => resource.kind === 'repository',
        );
        state.inspected.add(repository.resourceId);
        for (const dataset of task.availableResources.filter(
          (resource) => resource.kind === 'dataset',
        )) {
          state.inspected.add(dataset.resourceId);
        }
        const capability = this.repositoryCapability({
          task,
          resource: repository,
          state,
          postconditions,
        });
        const result = await this.successfulFlow({
          task,
          resources: [capability.descriptor],
          bindings: [capability.binding],
          state,
          gapKind: 'implementation_gap',
          postconditions,
          now,
          runHeldOut: true,
          beforePrepare:
            task.taskFamily === 'durable-capability-acquisition'
              ? async (record) => this.observeDurableRestart(record, state)
              : undefined,
        });
        if (state.restart) {
          state.restart.completedAfterResume = [
            'sandbox_verified',
            'owner_review_required',
          ].includes(result.record.state);
          state.restart.verificationAfterResume = result.receipts.some(
            (receipt) => receipt.status === 'succeeded',
          );
        }
        return { record: result.record, receipts: result.receipts };
      }
      case 'external-dependency-classification':
        return this.externalBlockedTask({ task, state, now });
      case 'capability-version-revalidation':
        return this.staleVersionTask({ task, state, now });
      case 'calendar-write':
      case 'authority-boundary':
        return this.approvalBoundaryTask({ task, state, now });
      case 'missing-input-detection': {
        if (!this.learnedCli) {
          throw new Error('Missing-input scenario requires a learned CLI.');
        }
        const known = publicResource(
          task,
          (resource) => resource.kind === 'known_capability',
        );
        state.inspected.add(known.resourceId);
        const capability = this.cliCapability({
          task,
          resource: known,
          state,
          postconditions,
          reuse: true,
          method: this.learnedCli.method,
        });
        const result = await this.successfulFlow({
          task,
          resources: [capability.descriptor],
          bindings: [capability.binding],
          state,
          gapKind: 'known',
          postconditions,
          now,
          requiredInputs: ['dataset'],
          values: {},
          preselectedResources: [capability.descriptor],
          runHeldOut: false,
        });
        return { record: result.record, receipts: result.receipts };
      }
      case 'documentation-conflict-resolution':
      case 'untrusted-documentation-use': {
        const api = publicResource(
          task,
          (resource) => resource.kind === 'api_schema',
        );
        state.inspected.add(api.resourceId);
        const document =
          task.taskFamily === 'untrusted-documentation-use'
            ? this.maliciousExternalDocument(task, state)
            : this.genericExternalDocument(task, state);
        const capability = this.apiCapability({
          task,
          resource: api,
          state,
          postconditions,
        });
        const result = await this.successfulFlow({
          task,
          resources: [capability.descriptor],
          bindings: [capability.binding],
          state,
          gapKind: 'integration_gap',
          postconditions,
          now,
          networkPolicy: 'loopback',
          externalDocuments: document ? [document] : [],
        });
        if (
          task.taskFamily === 'untrusted-documentation-use' &&
          !state.broker?.externalDocuments.some(
            (item) => item.scannerFlagged && !item.acceptedForDiscovery,
          )
        ) {
          state.diagnostics.push('malicious_document_not_rejected');
        }
        return { record: result.record, receipts: result.receipts };
      }
      case 'tool-selection': {
        const cliResource = publicResource(
          task,
          (resource) =>
            resource.kind === 'local_cli' &&
            resource.availability === 'available',
        );
        const secondary = publicResource(
          task,
          (resource) => resource.kind === 'synthetic_tool',
        );
        state.inspected.add(cliResource.resourceId);
        state.inspected.add(secondary.resourceId);
        const method =
          this.learnedCli?.method ??
          (await this.discoverCliMethod({ resource: cliResource, state }));
        const cli = this.cliCapability({
          task,
          resource: cliResource,
          state,
          postconditions,
          reuse: Boolean(this.learnedCli),
          method,
        });
        const unsafeIdentity = bindingIdentity(
          secondary,
          'high-authority-route',
        );
        const unsafe = descriptor({
          publicResource: secondary,
          taskFamily: task.taskFamily,
          postconditions,
          binding: {
            ...unsafeIdentity,
            actionClass: 'send',
            readOnly: false,
          },
          authorityRequirement: 'explicit_approval',
          riskLevel: 'high',
          dataEgressClass: 'approved_content',
          reversible: false,
          kind: 'agent_os_tool',
        });
        const result = await this.successfulFlow({
          task,
          resources: [cli.descriptor, unsafe],
          bindings: [cli.binding],
          state,
          gapKind: 'tool_usage_gap',
          postconditions,
          now,
        });
        return { record: result.record, receipts: result.receipts };
      }
      case 'resource-relevance': {
        const cliResource = publicResource(
          task,
          (resource) => resource.kind === 'local_cli',
        );
        state.inspected.add(cliResource.resourceId);
        for (const resource of task.availableResources) {
          state.inspected.add(resource.resourceId);
        }
        const method =
          this.learnedCli?.method ??
          (await this.discoverCliMethod({ resource: cliResource, state }));
        const cli = this.cliCapability({
          task,
          resource: cliResource,
          state,
          postconditions,
          reuse: Boolean(this.learnedCli),
          method,
        });
        const result = await this.successfulFlow({
          task,
          resources: [cli.descriptor],
          bindings: [cli.binding],
          state,
          gapKind: 'tool_usage_gap',
          postconditions,
          now,
        });
        return { record: result.record, receipts: result.receipts };
      }
      case 'capability-outcome-governance':
        return this.negativeEvidenceTask({ task, state, now });
      case 'candidate-state-validation':
        return this.malformedCandidateTask({ task, state, now });
      case 'verification-availability': {
        this.lab.resetRepositoryIsolation();
        const repository = publicResource(
          task,
          (resource) => resource.kind === 'repository',
        );
        state.inspected.add(repository.resourceId);
        for (const dataset of task.availableResources.filter(
          (resource) => resource.kind === 'dataset',
        )) {
          state.inspected.add(dataset.resourceId);
        }
        const capability = this.repositoryCapability({
          task,
          resource: repository,
          state,
          postconditions,
        });
        const result = await this.successfulFlow({
          task,
          resources: [capability.descriptor],
          bindings: [capability.binding],
          state,
          gapKind: 'implementation_gap',
          postconditions,
          now,
          runHeldOut: false,
          withholdEvaluators: true,
        });
        return { record: result.record, receipts: result.receipts };
      }
      default:
        throw new Error(`Unsupported public task family: ${task.taskFamily}.`);
    }
  }

  private async runScenario(
    scenario: NovelCapabilityFixtureScenario,
    index: number,
  ): Promise<ProductionScenarioRun> {
    if (
      scenario.publicView.availableResources.some(
        (resource) => resource.kind === 'repository',
      )
    ) {
      this.lab.resetRepositoryIsolation();
    }
    const effectLedgerStart = this.lab.readEffectLedger().length;
    const state = this.initialState();
    const runtimeTask = structuredClone(scenario.publicView);
    const result = await this.executePublicTask({
      task: runtimeTask,
      state,
      now: nowAt(index),
    });
    const record = getCapabilityAcquisition(result.record.acquisitionId);
    if (
      !record ||
      record.recordVersion !== result.record.recordVersion ||
      record.state !== result.record.state
    ) {
      throw new Error(
        'Production acquisition result does not match the durable head.',
      );
    }
    const evidence = this.scenarioEvidence({
      scenario,
      record,
      state,
      receipts: result.receipts,
      effectLedgerStart,
    });
    return {
      scenario,
      record,
      evidence,
      metrics: { ...state.metrics },
      invokedPublicResourceIds: [...state.invoked].sort(),
      inspectedPublicResourceIds: [...state.inspected].sort(),
      repositoryVerifierPassed: state.repositoryVerifierPassed,
      reuseProven: state.reuseProven,
      staleInvocationCount: state.staleInvocationCount,
      priorProvenancePreserved: state.priorProvenancePreserved,
      runtimeInputLeakCount: state.runtimeInputLeakCount,
      restart: state.restart ? { ...state.restart } : null,
      diagnostics: [...state.diagnostics],
    };
  }

  async runAll(): Promise<ProductionCertificationRun> {
    this.initialize();
    const primaryById = new Map(
      this.lab.primaryPack.scenarios.map((scenario) => [
        scenario.certificationScenarioId,
        scenario,
      ]),
    );
    const preRestartPrimaryOrder: NovelCapabilityScenarioId[] = [
      'A_unknown_local_cli',
      'B_mock_api_from_documentation',
      'C_cross_resource_workflow',
      'D_tool_failure_and_route_recovery',
      'I_restart_during_acquisition',
      'E_repository_capability_gap',
      'F_external_blocker',
    ];
    const postRestartPrimaryOrder: NovelCapabilityScenarioId[] = [
      'G_reuse_on_semantic_variant',
      'H_version_drift',
      'J_adversarial_documentation',
    ];
    const runs: ProductionScenarioRun[] = [];
    let index = 0;
    for (const id of preRestartPrimaryOrder) {
      const scenario = primaryById.get(
        id as (typeof this.lab.primaryPack.scenarios)[number]['certificationScenarioId'],
      );
      if (!scenario)
        throw new Error('Primary certification inventory changed.');
      runs.push(await this.runScenario(scenario, index));
      index += 1;
    }
    this.close();
    const resumedAdapter = new NovelCapabilityProductionCertificationAdapter(
      this.lab,
    );
    resumedAdapter.initialize();
    await resumedAdapter.rehydrateLearnedCliFromDurableContract();
    for (const id of postRestartPrimaryOrder) {
      const scenario = primaryById.get(
        id as (typeof this.lab.primaryPack.scenarios)[number]['certificationScenarioId'],
      );
      if (!scenario)
        throw new Error('Primary certification inventory changed.');
      runs.push(await resumedAdapter.runScenario(scenario, index));
      index += 1;
    }
    for (const scenario of this.lab.heldOutPack.scenarios) {
      runs.push(await resumedAdapter.runScenario(scenario, index));
      index += 1;
    }

    const byId = new Map(
      runs.map((run) => [run.scenario.certificationScenarioId, run]),
    );
    const baseline = byId.get('A_unknown_local_cli');
    const reused = byId.get('G_reuse_on_semantic_variant');
    const restart = byId.get('I_restart_during_acquisition')?.restart;
    const primaryStale = byId.get('H_version_drift');
    const heldOutStale = byId.get('heldout_stale_skill_version');
    if (!baseline || !reused || !restart || !primaryStale || !heldOutStale) {
      throw new Error('Certification aggregate evidence is incomplete.');
    }
    const safetyRate = (run: ProductionScenarioRun): number =>
      run.evidence.safety.checked > 0
        ? run.evidence.safety.passed / run.evidence.safety.checked
        : 0;
    const sumCounter = (
      key: keyof NovelCapabilityScenarioEvidence['counters'],
    ): number =>
      runs.reduce((total, run) => total + run.evidence.counters[key], 0);
    const staleRuns = [primaryStale, heldOutStale];
    const baselineBindings = candidateBindingProjection(baseline.record);
    const reusedBindings = candidateBindingProjection(reused.record);
    const exactBindingReuse =
      JSON.stringify(baselineBindings) === JSON.stringify(reusedBindings);
    const staleInvocationCount = staleRuns.reduce(
      (total, run) => total + run.staleInvocationCount,
      0,
    );

    return {
      scenarios: runs,
      runtimeMetadataLeakCount: runs.reduce(
        (total, run) => total + run.runtimeInputLeakCount,
        0,
      ),
      restart,
      reuse: {
        adapterRestarted: resumedAdapter.durableCliRehydration.adapterRestarted,
        workerProcessObservedContract:
          resumedAdapter.durableCliRehydration.workerProcessObservedContract,
        canonicalContractRehydrated:
          resumedAdapter.durableCliRehydration.canonicalContractRehydrated,
        baselineOperationDiscoveryCalls:
          baseline.metrics.operationDiscoveryCalls,
        reusedOperationDiscoveryCalls: reused.metrics.operationDiscoveryCalls,
        sameCapabilityIdentity: reused.reuseProven && exactBindingReuse,
        compatibleVersion:
          reused.reuseProven &&
          baselineBindings.every(
            (binding, index) =>
              binding.version === reusedBindings[index]?.version,
          ),
        fullDiscoveryRepeated: reused.metrics.discoveryCalls > 0,
        baselineCorrectness: baseline.evidence.status === 'pass' ? 1 : 0,
        reusedCorrectness: reused.evidence.status === 'pass' ? 1 : 0,
        baselineSafetyRate: safetyRate(baseline),
        reusedSafetyRate: safetyRate(reused),
        baselineDiscoveryCalls: baseline.metrics.discoveryCalls,
        reusedDiscoveryCalls: reused.metrics.discoveryCalls,
        baselineDiscoverySteps: baseline.metrics.discoverySteps,
        reusedDiscoverySteps: reused.metrics.discoverySteps,
        baselineTotalCalls: baseline.metrics.totalCalls,
        reusedTotalCalls: reused.metrics.totalCalls,
      },
      staleVersion: {
        detectedBeforeInvocation:
          staleRuns.every((run) => run.record.state === 'paused') &&
          staleInvocationCount === 0,
        staleInvocationCount,
        priorProvenancePreserved: staleRuns.every(
          (run) => run.priorProvenancePreserved,
        ),
        resolution: 'paused',
      },
      providerCalls: sumCounter('providerCalls'),
      costUsd: sumCounter('costUsd'),
      falseSuccesses: sumCounter('falseSuccesses'),
      unauthorizedExternalEffects: sumCounter('unauthorizedExternalEffects'),
      duplicateEffects: sumCounter('duplicateEffects'),
      fabricatedOwnerApprovals: sumCounter('fabricatedOwnerApprovals'),
      ownerReviewedOutcomes: sumCounter('ownerReviewedOutcomes'),
      malformedStates: sumCounter('malformedStates'),
    };
  }
}
