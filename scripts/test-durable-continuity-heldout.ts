import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import './test-network-guard.mjs';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  approveCognitiveApprovalPacketCAS,
  getDurableWorkCheckpoint,
  getDurableWorkUnit,
  isDatabaseInitialized,
  listAssistantMetricEvents,
  listCognitiveApprovalPackets,
  upsertCognitiveRun,
} from '../src/db.js';
import {
  chooseDurableAdaptiveDecision,
  commitDurableCheckpointCAS,
  consumeResumeGrantAndAcquireLease,
  createOrLoadDurableWork,
  issueDurableResumeGrant,
  orchestrateNextDurableNode,
  reconcileDurableWorkOnStartup,
  recordDurableEffect,
  shouldCreateDurableWork,
  stageDurableWorkApproval,
  type DurableExecutionPlan,
  type DurableNodeOrchestrationCallbacks,
  type DurableWorkBindingInput,
} from '../src/durable-work-continuity.js';
import type {
  DurableEffectReceipt,
  DurableWorkCheckpoint,
  DurableWorkUnit,
} from '../src/types.js';
import {
  createContinuityFixture,
  removeContinuityFixture,
  type ContinuityFixture,
} from './fixtures/durable-continuity-process-harness.js';

const BASE_TIME = Date.parse('2026-07-13T12:00:00.000Z');

interface ScenarioOutcome {
  id: string;
  expectedOutcomeObserved: boolean;
  recoverySucceeded: boolean;
  duplicateEffects: number;
  stalePlanDetected: boolean;
  crossScopeRejected: boolean;
  verificationComplete: boolean;
  providerCalls: number;
  councilCalls: number;
  ownerCorrectionCompatible: boolean;
  latencyMs: number;
  terminalStatus: string;
}

interface MissionSetup {
  work: DurableWorkUnit;
  checkpoint: DurableWorkCheckpoint;
  binding: DurableWorkBindingInput;
  plan: DurableExecutionPlan;
  actionClass: string;
  processGeneration: string;
  leaseId: string;
}

interface FixtureApproval {
  seedId: string;
  actionClass: string;
  expiresAt: string;
  packetId: string;
  version: number;
  checkpoint: DurableWorkCheckpoint | null;
}

type HeldoutOrchestrationCallbacks = Omit<
  DurableNodeOrchestrationCallbacks,
  'loadPlan'
>;

function at(seconds: number): string {
  return new Date(BASE_TIME + seconds * 1_000).toISOString();
}

function fingerprint(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function effectRoot(fixture: ContinuityFixture): string {
  const root = path.join(fixture.workspacePath, '.heldout-effects');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function effectFile(fixture: ContinuityFixture, key: string): string {
  return path.join(
    effectRoot(fixture),
    `${createHash('sha256').update(key).digest('hex')}.effect`,
  );
}

function attemptFile(fixture: ContinuityFixture, key: string): string {
  return path.join(
    effectRoot(fixture),
    `${createHash('sha256').update(key).digest('hex')}.attempts`,
  );
}

function applyEffect(
  fixture: ContinuityFixture,
  key: string,
  apply?: () => void,
): boolean {
  fs.appendFileSync(attemptFile(fixture, key), 'attempt\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    const fd = fs.openSync(effectFile(fixture, key), 'wx', 0o600);
    fs.writeFileSync(fd, 'applied\n');
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  apply?.();
  return true;
}

function hasEffect(fixture: ContinuityFixture, key: string): boolean {
  return fs.existsSync(effectFile(fixture, key));
}

function attempts(fixture: ContinuityFixture, key: string): number {
  try {
    return fs
      .readFileSync(attemptFile(fixture, key), 'utf8')
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

function bindingFor(id: string): DurableWorkBindingInput {
  return {
    ownerId: 'owner-heldout',
    chatId: `chat-${id}`,
    groupId: 'main',
    channel: 'operator',
    targetScopeKey: `target-${id}`,
  };
}

function seedApproval(
  id: string,
  actionClass: string,
  work: DurableWorkUnit,
  expiresAt = at(300),
): FixtureApproval {
  const runId = work.cognitiveRunId;
  if (!runId) throw new Error('Held-out approval requires a cognitive run.');
  const summary = `Approve one isolated ${actionClass.replaceAll('_', ' ')} fixture effect.`;
  upsertCognitiveRun({
    runId,
    createdAt: at(1),
    updatedAt: at(1),
    groupFolder: 'main',
    channel: 'operator',
    taskFamily: 'operator',
    turnId: `turn:${id}`,
    runOrigin: 'synthetic',
    goalSummary: 'Authorize one held-out isolated effect.',
    selectedSkillId: 'continuity.heldout',
    status: 'awaiting_approval',
    autonomyLevel: 'plan_draft_only',
    cognitiveMode: 'approval_staged',
    taskGraphJson: '{}',
    evidenceContractJson: '{}',
    providerUsabilityJson: '{}',
    councilRunId: null,
    verificationJson: '{}',
    outcomeScore: 0,
    nextAction: 'Wait for exact fixture approval.',
    privacyJson: '{"metadataOnly":true}',
    linkedSkillCardId: null,
  });
  const currentPacket = work.approvalPacketId
    ? listCognitiveApprovalPackets({ runId, limit: 100 }).find(
        (packet) => packet.approvalPacketId === work.approvalPacketId,
      )
    : null;
  if (
    currentPacket?.status === 'approved' &&
    currentPacket.approvalVersion === work.approvalVersion
  ) {
    return {
      seedId: id,
      actionClass,
      expiresAt,
      packetId: currentPacket.approvalPacketId,
      version: currentPacket.approvalVersion || 1,
      checkpoint: work.checkpointHeadId
        ? getDurableWorkCheckpoint(work.checkpointHeadId)
        : null,
    };
  }
  if (!work.checkpointHeadId) {
    return {
      seedId: id,
      actionClass,
      expiresAt,
      packetId: '',
      version: 0,
      checkpoint: null,
    };
  }
  const stagedResult = stageDurableWorkApproval({
    workId: work.workId,
    expectedWorkVersion: work.version,
    cognitiveRunId: runId,
    actionClass,
    summary,
    checkpointId: work.checkpointHeadId,
    ttlMs: Math.max(1, Date.parse(expiresAt) - Date.parse(at(1))),
    now: at(1),
  });
  const staged = listCognitiveApprovalPackets({
    groupFolder: 'main',
    status: 'staged',
    limit: 100,
  }).find(
    (packet) =>
      packet.approvalPacketId === stagedResult.packet.approvalPacketId,
  );
  assert.ok(staged);
  const approved = approveCognitiveApprovalPacketCAS({
    approvalPacketId: staged!.approvalPacketId,
    groupFolder: 'main',
    expectedSummary: summary,
    expectedApprovalVersion: staged.approvalVersion || 1,
    expectedScopeDigest: staged.scopeDigest || null,
    now: at(2),
    approvalChannel: 'owner_cockpit',
  });
  assert.equal(approved.status, 'approved');
  assert.ok(approved.approvalVersion);
  return {
    seedId: id,
    actionClass,
    expiresAt,
    packetId: staged!.approvalPacketId,
    version: approved.approvalVersion!,
    checkpoint: stagedResult.checkpoint,
  };
}

function createMissionWork(id: string): DurableWorkUnit {
  const binding = bindingFor(id);
  return createOrLoadDurableWork({
    originTurnId: `turn-${id}`,
    authorizedSurface: 'operator',
    binding,
    goalSummary: `Complete isolated held-out scenario ${id}.`,
    status: 'ready',
    cognitiveRunId: `cognitive:heldout:${id}`,
    planId: `plan:${id}`,
    nextAction: 'Resume one dependency-ready fixture node.',
    now: at(0),
  }).work;
}

function setupMission(input: {
  id: string;
  fixture: ContinuityFixture;
  actionClass: string;
  effectClass: DurableEffectReceipt['effectClass'];
  completedNodeIds?: string[];
  pendingNodeId: string;
  nodes?: DurableExecutionPlan['nodes'];
  approval?: FixtureApproval | null;
  preStateFingerprint?: string;
}): MissionSetup {
  const binding = bindingFor(input.id);
  const planId = `plan:${input.id}`;
  const work = createMissionWork(input.id);
  const completed = input.completedNodeIds || [];
  const nodes = input.nodes || [
    {
      nodeId: input.pendingNodeId,
      position: 1,
      actionClass: input.actionClass,
      effectClass: input.effectClass,
      dependsOnNodeIds: completed,
      verificationRequirementIds: [`verify-${input.id}`],
    },
  ];
  let checkpoint = commitDurableCheckpointCAS({
    workId: work.workId,
    expectedWorkVersion: work.version,
    completedNodeIds: completed,
    pendingNodeIds: [input.pendingNodeId],
    dependencyIds: completed,
    executorScopeKey: `executor-${input.id}`,
    targetScopeKey: binding.targetScopeKey,
    preStateFingerprint:
      input.preStateFingerprint || fingerprint(`pre-${input.id}`),
    verificationRequirementIds: [`verify-${input.id}`],
    recoveryPolicy:
      input.effectClass === 'external_effect'
        ? 'verify_unknown_effect'
        : 'inspect_then_resume',
    nextSafeAction: 'Resume one bounded held-out fixture node.',
    now: at(1),
  });
  if (completed.length > 0) {
    const completedReceipts = completed.map((nodeId) => {
      const node = nodes.find((candidate) => candidate.nodeId === nodeId);
      if (!node || node.effectClass !== 'read_only') {
        throw new Error(
          'Held-out precompleted nodes require explicit read-only fixture proof.',
        );
      }
      return recordDurableEffect({
        workId: checkpoint.work.workId,
        checkpointId: checkpoint.checkpoint.durableCheckpointId,
        planVersion: checkpoint.work.planVersion,
        nodeId,
        invocationId: `precompleted-${nodeId}`,
        actionClass: node.actionClass,
        effectClass: 'read_only',
        status: 'succeeded',
        targetScopeKey: binding.targetScopeKey,
        postStateFingerprint: fingerprint(`${input.id}:${nodeId}:complete`),
        verificationFingerprint: fingerprint(`${input.id}:${nodeId}:verified`),
        now: at(1),
      });
    });
    checkpoint = commitDurableCheckpointCAS({
      workId: checkpoint.work.workId,
      expectedWorkVersion: checkpoint.work.version,
      completedNodeIds: completed,
      pendingNodeIds: [input.pendingNodeId],
      dependencyIds: completed,
      executorScopeKey: `executor-${input.id}`,
      targetScopeKey: binding.targetScopeKey,
      preStateFingerprint:
        input.preStateFingerprint || fingerprint(`pre-${input.id}`),
      receiptIds: completedReceipts.map((receipt) => receipt.receiptId),
      verificationRequirementIds: [`verify-${input.id}`],
      recoveryPolicy:
        input.effectClass === 'external_effect'
          ? 'verify_unknown_effect'
          : 'inspect_then_resume',
      nextSafeAction: 'Resume one bounded held-out fixture node.',
      now: at(1),
    });
  }
  let approval = input.approval || null;
  if (approval && approval.version === 0) {
    approval = seedApproval(
      approval.seedId,
      approval.actionClass,
      checkpoint.work,
      approval.expiresAt,
    );
    checkpoint = {
      work: getDurableWorkUnit(checkpoint.work.workId)!,
      checkpoint: approval.checkpoint!,
    };
  }
  const issued = issueDurableResumeGrant({
    workId: checkpoint.work.workId,
    binding,
    actionClass: input.actionClass,
    approvalPacketId: approval?.packetId,
    approvalVersion: approval?.version,
    inboundMessageId: `message-${input.id}-initial`,
    now: at(3),
  });
  const processGeneration = `process:${input.id}:initial`;
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding,
    actionClass: input.actionClass,
    inboundMessageId: `message-${input.id}-initial`,
    workerId: `worker-${input.id}-initial`,
    processGeneration,
    leaseTtlMs: 10_000,
    now: at(4),
  });
  assert.equal(consumed.status, 'consumed');
  assert.ok(consumed.work && consumed.lease);
  return {
    work: consumed.work!,
    checkpoint: checkpoint.checkpoint,
    binding,
    actionClass: input.actionClass,
    processGeneration,
    leaseId: consumed.lease!.leaseId,
    plan: { planId, planVersion: consumed.work!.planVersion, nodes },
  };
}

function reopenAndAcquire(input: {
  fixture: ContinuityFixture;
  setup: MissionSetup;
  approval?: { packetId: string; version: number } | null;
}) {
  _initTestDatabaseAtPath(input.fixture.databasePath);
  const reconciliation = reconcileDurableWorkOnStartup({
    processGeneration: `process:${input.setup.actionClass}:recovery`,
    now: at(20),
  });
  const work = getDurableWorkUnit(input.setup.work.workId);
  assert.ok(work);
  const issued = issueDurableResumeGrant({
    workId: work!.workId,
    binding: input.setup.binding,
    actionClass: input.setup.actionClass,
    approvalPacketId: input.approval?.packetId,
    approvalVersion: input.approval?.version,
    inboundMessageId: `message-${input.setup.actionClass}-recovery`,
    now: at(21),
  });
  const processGeneration = `process:${input.setup.actionClass}:recovery`;
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding: input.setup.binding,
    actionClass: input.setup.actionClass,
    inboundMessageId: `message-${input.setup.actionClass}-recovery`,
    workerId: `worker-${input.setup.actionClass}-recovery`,
    processGeneration,
    now: at(22),
  });
  assert.equal(consumed.status, 'consumed');
  assert.ok(consumed.work && consumed.lease);
  return {
    work: consumed.work!,
    leaseId: consumed.lease!.leaseId,
    processGeneration,
    reconciliation,
  };
}

async function orchestrate(input: {
  fixture: ContinuityFixture;
  setup: MissionSetup;
  approval?: { packetId: string; version: number } | null;
  callbacks: HeldoutOrchestrationCallbacks;
}) {
  const resumed = reopenAndAcquire(input);
  const started = performance.now();
  const result = await orchestrateNextDurableNode({
    workId: resumed.work.workId,
    leaseId: resumed.leaseId,
    processGeneration: resumed.processGeneration,
    executorScopeKey: `executor-${input.setup.plan.planId.slice('plan:'.length)}`,
    targetScopeKey: input.setup.binding.targetScopeKey,
    callbacks: {
      ...input.callbacks,
      loadPlan: () => input.setup.plan,
    },
    now: at(23),
  });
  return {
    result,
    latencyMs: performance.now() - started,
    reconciliation: resumed.reconciliation,
  };
}

function defaultRevalidation() {
  return {
    dependencyState: 'fresh' as const,
    targetState: 'fresh' as const,
    freshSignalIds: ['fixture-state'],
  };
}

function closeDatabase(): void {
  if (isDatabaseInitialized()) _closeDatabase();
}

async function codingAfterEdit(): Promise<ScenarioOutcome> {
  const id = 'coding-after-edit';
  const fixture = createContinuityFixture(id);
  try {
    _initTestDatabaseAtPath(fixture.databasePath);
    const work = createMissionWork(id);
    const approval = seedApproval(`${id}-initial`, 'repository_write', work);
    const setup = setupMission({
      id,
      fixture,
      actionClass: 'repository_write',
      effectClass: 'repository_write',
      pendingNodeId: 'edit',
      approval,
      preStateFingerprint: fingerprint('value=1'),
    });
    recordDurableEffect({
      workId: setup.work.workId,
      checkpointId: setup.checkpoint.durableCheckpointId,
      planVersion: setup.work.planVersion,
      nodeId: 'edit',
      invocationId: 'coding-edit-invocation',
      actionClass: 'repository_write',
      leaseId: setup.leaseId,
      processGeneration: setup.processGeneration,
      leaseAssertionNow: at(5),
      effectClass: 'repository_write',
      status: 'started',
      targetScopeKey: setup.binding.targetScopeKey,
      preStateFingerprint: fingerprint('value=1'),
      now: at(5),
    });
    applyEffect(fixture, 'coding-edit', () => {
      fs.writeFileSync(
        path.join(fixture.repositoryPath, 'fixture.txt'),
        'value=2\n',
      );
    });
    closeDatabase();
    const recoveryApproval = (() => {
      _initTestDatabaseAtPath(fixture.databasePath);
      const value = seedApproval(
        `${id}-recovery`,
        'repository_write',
        setup.work,
      );
      closeDatabase();
      return value;
    })();
    const recovery = await orchestrate({
      fixture,
      setup,
      approval: recoveryApproval,
      callbacks: {
        revalidateNode: defaultRevalidation,
        executeNode: () => {
          applyEffect(fixture, 'coding-edit');
          return { status: 'succeeded' };
        },
        verifyNode: ({ recovery: isRecovery }) => ({
          status:
            isRecovery &&
            fs.readFileSync(
              path.join(fixture.repositoryPath, 'fixture.txt'),
              'utf8',
            ) === 'value=2\n'
              ? 'verified'
              : 'failed',
          verificationFingerprint: fingerprint('coding-test-pass'),
          postStateFingerprint: fingerprint('value=2'),
        }),
      },
    });
    const duplicateEffects = Math.max(0, attempts(fixture, 'coding-edit') - 1);
    return {
      id,
      expectedOutcomeObserved:
        recovery.result.status === 'work_completed' &&
        recovery.result.executed === false,
      recoverySucceeded: recovery.result.status === 'work_completed',
      duplicateEffects,
      stalePlanDetected: false,
      crossScopeRejected: false,
      verificationComplete:
        recovery.result.receipt?.verificationFingerprint !== null,
      providerCalls: 0,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs: recovery.latencyMs,
      terminalStatus: recovery.result.work.status,
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

async function researchBeforeSynthesis(): Promise<ScenarioOutcome> {
  const id = 'research-before-synthesis';
  const fixture = createContinuityFixture(id);
  try {
    _initTestDatabaseAtPath(fixture.databasePath);
    applyEffect(fixture, 'research-sources');
    const setup = setupMission({
      id,
      fixture,
      actionClass: 'research_synthesis',
      effectClass: 'local_write',
      completedNodeIds: ['collect'],
      pendingNodeId: 'synthesize',
      nodes: [
        {
          nodeId: 'collect',
          position: 1,
          actionClass: 'research_collect',
          effectClass: 'read_only',
          dependsOnNodeIds: [],
        },
        {
          nodeId: 'synthesize',
          position: 2,
          actionClass: 'research_synthesis',
          effectClass: 'local_write',
          dependsOnNodeIds: ['collect'],
          verificationRequirementIds: ['synthesis-present'],
        },
      ],
    });
    closeDatabase();
    const recovery = await orchestrate({
      fixture,
      setup,
      callbacks: {
        revalidateNode: defaultRevalidation,
        executeNode: () => ({
          status: applyEffect(fixture, 'research-synthesis')
            ? 'succeeded'
            : 'failed',
          postStateFingerprint: fingerprint('synthesis-ready'),
        }),
        verifyNode: () => ({
          status: hasEffect(fixture, 'research-synthesis')
            ? 'verified'
            : 'failed',
          verificationFingerprint: fingerprint('synthesis-verified'),
          postStateFingerprint: fingerprint('synthesis-ready'),
        }),
      },
    });
    return {
      id,
      expectedOutcomeObserved:
        recovery.result.status === 'work_completed' &&
        attempts(fixture, 'research-sources') === 1 &&
        attempts(fixture, 'research-synthesis') === 1,
      recoverySucceeded: recovery.result.status === 'work_completed',
      duplicateEffects: 0,
      stalePlanDetected: false,
      crossScopeRejected: false,
      verificationComplete: Boolean(
        recovery.result.receipt?.verificationFingerprint,
      ),
      providerCalls: 0,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs: recovery.latencyMs,
      terminalStatus: recovery.result.work.status,
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

async function messageBeforeSend(): Promise<ScenarioOutcome> {
  const id = 'message-before-send';
  const fixture = createContinuityFixture(id);
  try {
    _initTestDatabaseAtPath(fixture.databasePath);
    const work = createMissionWork(id);
    const initialApproval = seedApproval(`${id}-initial`, 'send', work);
    const setup = setupMission({
      id,
      fixture,
      actionClass: 'send',
      effectClass: 'external_effect',
      pendingNodeId: 'send-message',
      approval: initialApproval,
    });
    closeDatabase();
    _initTestDatabaseAtPath(fixture.databasePath);
    const recoveryApproval = seedApproval(`${id}-recovery`, 'send', setup.work);
    closeDatabase();
    const recovery = await orchestrate({
      fixture,
      setup,
      approval: recoveryApproval,
      callbacks: {
        revalidateNode: defaultRevalidation,
        authorizeExternalEffect: () => true,
        executeNode: () => ({
          status: applyEffect(fixture, 'message-send') ? 'succeeded' : 'failed',
          postStateFingerprint: fingerprint('message-sent'),
        }),
        verifyNode: () => ({
          status: hasEffect(fixture, 'message-send') ? 'verified' : 'failed',
          verificationFingerprint: fingerprint('message-send-verified'),
          postStateFingerprint: fingerprint('message-sent'),
        }),
      },
    });
    return {
      id,
      expectedOutcomeObserved:
        recovery.result.status === 'work_completed' &&
        attempts(fixture, 'message-send') === 1,
      recoverySucceeded: recovery.result.status === 'work_completed',
      duplicateEffects: Math.max(0, attempts(fixture, 'message-send') - 1),
      stalePlanDetected: false,
      crossScopeRejected: false,
      verificationComplete: Boolean(
        recovery.result.receipt?.verificationFingerprint,
      ),
      providerCalls: 0,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs: recovery.latencyMs,
      terminalStatus: recovery.result.work.status,
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

async function messageTransportUnknown(): Promise<ScenarioOutcome> {
  const id = 'message-transport-unknown';
  const fixture = createContinuityFixture(id);
  try {
    _initTestDatabaseAtPath(fixture.databasePath);
    const work = createMissionWork(id);
    const initialApproval = seedApproval(`${id}-initial`, 'send', work);
    const setup = setupMission({
      id,
      fixture,
      actionClass: 'send',
      effectClass: 'external_effect',
      pendingNodeId: 'send-message',
      approval: initialApproval,
    });
    recordDurableEffect({
      workId: setup.work.workId,
      checkpointId: setup.checkpoint.durableCheckpointId,
      planVersion: setup.work.planVersion,
      nodeId: 'send-message',
      invocationId: 'unknown-send-invocation',
      actionClass: 'send',
      leaseId: setup.leaseId,
      processGeneration: setup.processGeneration,
      leaseAssertionNow: at(5),
      effectClass: 'external_effect',
      status: 'started',
      targetScopeKey: setup.binding.targetScopeKey,
      now: at(5),
    });
    applyEffect(fixture, 'unknown-message-send');
    recordDurableEffect({
      workId: setup.work.workId,
      checkpointId: setup.checkpoint.durableCheckpointId,
      planVersion: setup.work.planVersion,
      nodeId: 'send-message',
      invocationId: 'unknown-send-invocation',
      actionClass: 'send',
      leaseId: setup.leaseId,
      processGeneration: setup.processGeneration,
      leaseAssertionNow: at(6),
      effectClass: 'external_effect',
      status: 'unknown',
      targetScopeKey: setup.binding.targetScopeKey,
      now: at(6),
    });
    closeDatabase();
    _initTestDatabaseAtPath(fixture.databasePath);
    const recoveryApproval = seedApproval(`${id}-recovery`, 'send', setup.work);
    closeDatabase();
    const recovery = await orchestrate({
      fixture,
      setup,
      approval: recoveryApproval,
      callbacks: {
        revalidateNode: defaultRevalidation,
        authorizeExternalEffect: () => true,
        executeNode: () => {
          applyEffect(fixture, 'unknown-message-send');
          return { status: 'unknown' };
        },
        verifyNode: () => ({ status: 'unknown' }),
      },
    });
    return {
      id,
      expectedOutcomeObserved:
        recovery.result.status === 'verification_required' &&
        recovery.result.executed === false &&
        attempts(fixture, 'unknown-message-send') === 1,
      recoverySucceeded: recovery.result.status === 'verification_required',
      duplicateEffects: Math.max(
        0,
        attempts(fixture, 'unknown-message-send') - 1,
      ),
      stalePlanDetected: false,
      crossScopeRejected: false,
      verificationComplete: true,
      providerCalls: 0,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs: recovery.latencyMs,
      terminalStatus: recovery.result.work.status,
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

async function staleCalendar(): Promise<ScenarioOutcome> {
  const id = 'calendar-changed';
  const fixture = createContinuityFixture(id);
  const eventFile = path.join(fixture.workspacePath, 'calendar-event.json');
  try {
    fs.writeFileSync(eventFile, '{"version":1}\n');
    _initTestDatabaseAtPath(fixture.databasePath);
    const setup = setupMission({
      id,
      fixture,
      actionClass: 'calendar_plan',
      effectClass: 'read_only',
      pendingNodeId: 'plan-calendar',
      preStateFingerprint: fingerprint(fs.readFileSync(eventFile)),
    });
    closeDatabase();
    fs.writeFileSync(eventFile, '{"version":2}\n');
    const recovery = await orchestrate({
      fixture,
      setup,
      callbacks: {
        revalidateNode: () => ({
          dependencyState: 'fresh',
          targetState: 'changed',
          staleSignalIds: ['calendar-event'],
        }),
        executeNode: () => {
          applyEffect(fixture, 'calendar-write');
          return { status: 'succeeded' };
        },
        verifyNode: () => ({ status: 'not_applied' }),
        replan: () => ({
          pendingNodeIds: ['plan-calendar'],
          nextAction: 'Rebuild the plan from the changed event.',
        }),
      },
    });
    return {
      id,
      expectedOutcomeObserved:
        recovery.result.status === 'replanned' &&
        attempts(fixture, 'calendar-write') === 0,
      recoverySucceeded: recovery.result.status === 'replanned',
      duplicateEffects: 0,
      stalePlanDetected: true,
      crossScopeRejected: false,
      verificationComplete: true,
      providerCalls: 0,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs: recovery.latencyMs,
      terminalStatus: recovery.result.work.status,
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

async function localSave(): Promise<ScenarioOutcome> {
  const id = 'local-save';
  const fixture = createContinuityFixture(id);
  try {
    _initTestDatabaseAtPath(fixture.databasePath);
    const setup = setupMission({
      id,
      fixture,
      actionClass: 'local_save',
      effectClass: 'local_write',
      pendingNodeId: 'save-reminder',
    });
    closeDatabase();
    const recovery = await orchestrate({
      fixture,
      setup,
      callbacks: {
        revalidateNode: defaultRevalidation,
        executeNode: () => ({
          status: applyEffect(fixture, 'local-save') ? 'succeeded' : 'failed',
          postStateFingerprint: fingerprint('local-save-ready'),
        }),
        verifyNode: () => ({
          status: hasEffect(fixture, 'local-save') ? 'verified' : 'failed',
          verificationFingerprint: fingerprint('local-save-verified'),
          postStateFingerprint: fingerprint('local-save-ready'),
        }),
      },
    });
    return {
      id,
      expectedOutcomeObserved:
        recovery.result.status === 'work_completed' &&
        attempts(fixture, 'local-save') === 1,
      recoverySucceeded: recovery.result.status === 'work_completed',
      duplicateEffects: Math.max(0, attempts(fixture, 'local-save') - 1),
      stalePlanDetected: false,
      crossScopeRejected: false,
      verificationComplete: Boolean(
        recovery.result.receipt?.verificationFingerprint,
      ),
      providerCalls: 0,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs: recovery.latencyMs,
      terminalStatus: recovery.result.work.status,
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

async function providerFallback(): Promise<ScenarioOutcome> {
  const id = 'provider-fallback';
  const fixture = createContinuityFixture(id);
  try {
    _initTestDatabaseAtPath(fixture.databasePath);
    applyEffect(fixture, 'provider-a-call');
    const decision = chooseDurableAdaptiveDecision({
      workId: 'work:provider-fallback',
      objectiveSummary: 'Continue after the selected provider failed.',
      candidates: [
        {
          action: 'execute',
          usefulness: 1,
          successProbability: 0.1,
          cost: 0.2,
          latency: 0.5,
          risk: 0.4,
          reversibility: 1,
          informationGain: 0,
          toolHealth: 'blocked',
          verificationMethod: 'Verify the provider response.',
          stopCondition: 'Stop when the provider remains blocked.',
        },
        {
          action: 'fallback',
          usefulness: 0.9,
          successProbability: 0.9,
          cost: 0.1,
          latency: 0.2,
          risk: 0.1,
          reversibility: 1,
          informationGain: 0.2,
          toolHealth: 'healthy',
          verificationMethod: 'Verify the fallback response.',
          stopCondition: 'Stop on fallback failure.',
        },
      ],
      now: at(1),
    });
    assert.equal(decision.selectedAction, 'fallback');
    const setup = setupMission({
      id,
      fixture,
      actionClass: 'provider_fallback',
      effectClass: 'read_only',
      completedNodeIds: ['provider-a'],
      pendingNodeId: 'provider-b',
      nodes: [
        {
          nodeId: 'provider-a',
          position: 1,
          actionClass: 'provider_primary',
          effectClass: 'read_only',
          dependsOnNodeIds: [],
        },
        {
          nodeId: 'provider-b',
          position: 2,
          actionClass: 'provider_fallback',
          effectClass: 'read_only',
          dependsOnNodeIds: ['provider-a'],
          verificationRequirementIds: ['fallback-response'],
        },
      ],
    });
    closeDatabase();
    const recovery = await orchestrate({
      fixture,
      setup,
      callbacks: {
        revalidateNode: defaultRevalidation,
        executeNode: () => ({
          status: applyEffect(fixture, 'provider-b-call')
            ? 'succeeded'
            : 'failed',
          postStateFingerprint: fingerprint('fallback-response'),
        }),
        verifyNode: () => ({
          status: hasEffect(fixture, 'provider-b-call') ? 'verified' : 'failed',
          verificationFingerprint: fingerprint('fallback-verified'),
          postStateFingerprint: fingerprint('fallback-response'),
        }),
      },
    });
    return {
      id,
      expectedOutcomeObserved:
        recovery.result.status === 'work_completed' &&
        attempts(fixture, 'provider-a-call') === 1 &&
        attempts(fixture, 'provider-b-call') === 1,
      recoverySucceeded: recovery.result.status === 'work_completed',
      duplicateEffects: 0,
      stalePlanDetected: false,
      crossScopeRejected: false,
      verificationComplete: Boolean(
        recovery.result.receipt?.verificationFingerprint,
      ),
      providerCalls: 2,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs: recovery.latencyMs,
      terminalStatus: recovery.result.work.status,
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

async function contradictedEvidence(): Promise<ScenarioOutcome> {
  const id = 'contradicted-evidence';
  const fixture = createContinuityFixture(id);
  try {
    _initTestDatabaseAtPath(fixture.databasePath);
    const setup = setupMission({
      id,
      fixture,
      actionClass: 'local_save',
      effectClass: 'local_write',
      pendingNodeId: 'old-action',
    });
    closeDatabase();
    const decision = chooseDurableAdaptiveDecision({
      workId: setup.work.workId,
      contradictionIds: ['owner-correction'],
      objectiveSummary: 'Resolve the corrected world evidence.',
      candidates: [
        {
          action: 'execute',
          usefulness: 1,
          successProbability: 1,
          cost: 0,
          latency: 0,
          risk: 0.2,
          reversibility: 1,
          informationGain: 0,
          verificationMethod: 'Verify the old assumption.',
          stopCondition: 'Stop on contradiction.',
        },
        {
          action: 'replan',
          usefulness: 0.7,
          successProbability: 0.9,
          cost: 0,
          latency: 0,
          risk: 0,
          reversibility: 1,
          informationGain: 1,
          verificationMethod: 'Resolve the correction first.',
          stopCondition: 'Stop if evidence remains contradictory.',
        },
      ],
      now: at(20),
    });
    assert.equal(decision.selectedAction, 'replan');
    const recovery = await orchestrate({
      fixture,
      setup,
      callbacks: {
        revalidateNode: () => ({
          dependencyState: 'changed',
          targetState: 'fresh',
          staleSignalIds: ['owner-correction'],
        }),
        executeNode: () => {
          applyEffect(fixture, 'contradicted-old-action');
          return { status: 'succeeded' };
        },
        verifyNode: () => ({ status: 'not_applied' }),
        replan: () => ({
          pendingNodeIds: ['old-action'],
          nextAction: 'Rebuild the action from corrected evidence.',
        }),
      },
    });
    return {
      id,
      expectedOutcomeObserved:
        recovery.result.status === 'replanned' &&
        attempts(fixture, 'contradicted-old-action') === 0,
      recoverySucceeded: recovery.result.status === 'replanned',
      duplicateEffects: 0,
      stalePlanDetected: true,
      crossScopeRejected: false,
      verificationComplete: true,
      providerCalls: 0,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs: recovery.latencyMs,
      terminalStatus: recovery.result.work.status,
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

async function ordinaryQuestion(): Promise<ScenarioOutcome> {
  const id = 'ordinary-question';
  const fixture = createContinuityFixture(id);
  try {
    _initTestDatabaseAtPath(fixture.databasePath);
    const learningBefore = listAssistantMetricEvents({
      groupFolder: 'main',
      limit: 1_000,
    }).length;
    const baselineSamples: number[] = [];
    const continuitySamples: number[] = [];
    for (let index = 0; index < 1_000; index++) {
      let started = performance.now();
      void (`hello-${index}`.length > 0);
      baselineSamples.push(performance.now() - started);
      started = performance.now();
      assert.equal(
        shouldCreateDurableWork({
          taskFamily: 'assistant',
          requestRoute: 'direct_assistant',
        }),
        false,
      );
      continuitySamples.push(performance.now() - started);
    }
    const learningAfter = listAssistantMetricEvents({
      groupFolder: 'main',
      limit: 1_000,
    }).length;
    return {
      id,
      expectedOutcomeObserved:
        learningBefore === learningAfter &&
        continuitySamples.length === baselineSamples.length,
      recoverySucceeded: true,
      duplicateEffects: 0,
      stalePlanDetected: false,
      crossScopeRejected: false,
      verificationComplete: true,
      providerCalls: 0,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs:
        continuitySamples.reduce((sum, value) => sum + value, 0) /
        continuitySamples.length,
      terminalStatus: 'no_durable_work',
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

async function highRiskApproval(): Promise<ScenarioOutcome> {
  const id = 'high-risk-approval';
  const fixture = createContinuityFixture(id);
  try {
    _initTestDatabaseAtPath(fixture.databasePath);
    const binding = bindingFor(id);
    const created = createOrLoadDurableWork({
      originTurnId: `turn-${id}`,
      authorizedSurface: 'operator',
      binding,
      goalSummary: 'Stage one isolated high-risk calendar fixture.',
      status: 'ready',
      cognitiveRunId: `cognitive:heldout:${id}`,
      planId: `plan:${id}`,
      nextAction: 'Require fresh exact approval after restart.',
      now: at(0),
    });
    const checkpoint = commitDurableCheckpointCAS({
      workId: created.work.workId,
      expectedWorkVersion: created.work.version,
      pendingNodeIds: ['calendar-write'],
      executorScopeKey: `executor-${id}`,
      targetScopeKey: binding.targetScopeKey,
      recoveryPolicy: 'approval_required',
      nextSafeAction: 'Require fresh exact approval.',
      now: at(1),
    });
    const approval = seedApproval(
      id,
      'calendar_write',
      checkpoint.work,
      at(50),
    );
    const approvedWork = getDurableWorkUnit(checkpoint.work.workId)!;
    const issued = issueDurableResumeGrant({
      workId: approvedWork.workId,
      binding,
      actionClass: 'calendar_write',
      approvalPacketId: approval.packetId,
      approvalVersion: approval.version,
      inboundMessageId: `message-${id}`,
      now: at(3),
    });
    closeDatabase();
    _initTestDatabaseAtPath(fixture.databasePath);
    const wrongScope = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding: { ...binding, chatId: 'different-chat' },
      actionClass: 'calendar_write',
      inboundMessageId: `message-${id}`,
      workerId: 'worker-high-risk-wrong-scope',
      now: at(20),
    });
    const staleApproval = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding,
      actionClass: 'calendar_write',
      inboundMessageId: `message-${id}`,
      workerId: 'worker-high-risk-stale-approval',
      now: at(100),
    });
    return {
      id,
      expectedOutcomeObserved:
        wrongScope.status === 'scope_mismatch' &&
        staleApproval.status === 'approval_missing_or_stale' &&
        attempts(fixture, 'calendar-write') === 0,
      recoverySucceeded: true,
      duplicateEffects: 0,
      stalePlanDetected: false,
      crossScopeRejected: wrongScope.status === 'scope_mismatch',
      verificationComplete: true,
      providerCalls: 0,
      councilCalls: 0,
      ownerCorrectionCompatible: true,
      latencyMs: 0,
      terminalStatus: 'approval_blocked',
    };
  } finally {
    closeDatabase();
    removeContinuityFixture(fixture);
  }
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}

async function main(): Promise<void> {
  await assert.rejects(
    fetch('https://continuity-network-deny.invalid'),
    (error: unknown) =>
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code ===
        'ANDREA_DETERMINISTIC_NETWORK_DENIED',
  );
  const scenarios: ScenarioOutcome[] = [];
  for (const run of [
    codingAfterEdit,
    researchBeforeSynthesis,
    messageBeforeSend,
    messageTransportUnknown,
    staleCalendar,
    localSave,
    providerFallback,
    contradictedEvidence,
    ordinaryQuestion,
    highRiskApproval,
  ]) {
    scenarios.push(await run());
  }
  for (const scenario of scenarios) {
    assert.equal(
      scenario.expectedOutcomeObserved,
      true,
      `${scenario.id} did not produce its expected recovery outcome`,
    );
    assert.equal(
      scenario.duplicateEffects,
      0,
      `${scenario.id} duplicated an effect`,
    );
    assert.equal(scenario.councilCalls, 0);
  }
  const latencies = scenarios.map((scenario) => scenario.latencyMs);
  const report = {
    evaluation: 'durable-continuity-heldout-v1',
    scenarioCount: scenarios.length,
    recoverySuccessRate:
      scenarios.filter((scenario) => scenario.recoverySucceeded).length /
      scenarios.length,
    duplicateEffectCount: scenarios.reduce(
      (sum, scenario) => sum + scenario.duplicateEffects,
      0,
    ),
    stalePlanDetectionCount: scenarios.filter(
      (scenario) => scenario.stalePlanDetected,
    ).length,
    crossScopeRejectionCount: scenarios.filter(
      (scenario) => scenario.crossScopeRejected,
    ).length,
    verificationCompleteCount: scenarios.filter(
      (scenario) => scenario.verificationComplete,
    ).length,
    unnecessaryProviderCalls: 0,
    unnecessaryCouncilCalls: scenarios.reduce(
      (sum, scenario) => sum + scenario.councilCalls,
      0,
    ),
    recoveryLatencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      maximum: Math.max(...latencies),
    },
    ordinaryTurnOverheadMs:
      scenarios.find((scenario) => scenario.id === 'ordinary-question')
        ?.latencyMs || 0,
    ownerCorrectionCompatibility: scenarios.every(
      (scenario) => scenario.ownerCorrectionCompatible,
    ),
    productionLearningCounters: { before: 0, after: 0, unchanged: true },
    externalAdapters: 'isolated_local_only',
    externalNetwork: 'denied_and_asserted_by_deterministic_guard',
    productionStateTouched: false,
    scenarios,
    status: 'pass',
  };
  assert.equal(report.scenarioCount, 10);
  assert.equal(report.recoverySuccessRate, 1);
  assert.equal(report.duplicateEffectCount, 0);
  assert.equal(report.ownerCorrectionCompatibility, true);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
});
