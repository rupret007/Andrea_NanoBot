import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  approveCognitiveApprovalPacketCAS,
  getDurableWorkUnit,
  isDatabaseInitialized,
  listCognitiveApprovalPackets,
  listDurableEffectReceipts,
  listDurableResumeGrants,
  listDurableWorkCheckpoints,
  listDurableWorkUnits,
  upsertCognitiveRun,
} from '../../src/db.js';
import {
  _setDurableContinuityTestHook,
  chooseDurableAdaptiveDecision,
  commitDurableCheckpointCAS,
  consumeResumeGrantAndAcquireLease,
  createOrLoadDurableWork,
  issueDurableResumeGrant,
  reconcileDurableWorkOnStartup,
  recordDurableEffect,
  replanDurableWork,
  shouldCreateDurableWork,
  stageDurableWorkApproval,
  transitionDurableDeliveryState,
  transitionDurableWork,
  type DurableContinuityBoundary,
  type DurableWorkBindingInput,
} from '../../src/durable-work-continuity.js';
import type {
  DurableEffectReceipt,
  DurableWorkCheckpoint,
  DurableWorkUnit,
} from '../../src/types.js';

interface WorkerConfig {
  kind: string;
  databasePath: string;
  workspacePath: string;
  markerPath: string;
  boundary?: DurableContinuityBoundary;
  scenario?: string;
  token?: string;
  workerId?: string;
}

const BASE_TIME = Date.parse('2026-07-13T12:00:00.000Z');
const binding: DurableWorkBindingInput = {
  ownerId: 'owner-fixture',
  chatId: 'chat-fixture',
  groupId: 'main',
  channel: 'operator',
  targetScopeKey: 'repository-fixture',
};

let pendingConsume: WorkerConfig | null = null;
let workerPhase = 'idle';

function at(seconds: number): string {
  return new Date(BASE_TIME + seconds * 1_000).toISOString();
}

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

function finish(message: Record<string, unknown>): void {
  if (isDatabaseInitialized()) _closeDatabase();
  if (process.send) {
    process.send(message, (error) => {
      if (error) process.exitCode = 1;
      process.disconnect?.();
    });
  } else {
    process.exitCode = 1;
  }
}

function failureClass(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/completed node requires/i.test(message)) {
    return 'missing_completed_node_proof';
  }
  if (/event identity collision/i.test(message)) return 'event_collision';
  if (/receipt.*provenance|provenance.*receipt/i.test(message)) {
    return 'receipt_provenance';
  }
  if (/receipt.*immutable|monotonic status/i.test(message)) {
    return 'receipt_monotonicity';
  }
  if (/checkpoint.*compare-and-set|work-head compare-and-set/i.test(message)) {
    return 'checkpoint_cas_conflict';
  }
  const durableInput = message.match(/(?:unsafe|invalid) durable ([a-z -]+)/i);
  if (durableInput) {
    return `invalid_${durableInput[1]!.trim().replaceAll(' ', '_')}`;
  }
  if (/changed/i.test(message)) return 'stale_state';
  if (/unsafe|invalid/i.test(message)) return 'invalid_input';
  if (/transition/i.test(message)) return 'invalid_transition';
  if (/compare-and-set|race/i.test(message)) return 'cas_conflict';
  if (/approval/i.test(message)) return 'approval_rejected';
  if (/grant/i.test(message)) return 'grant_rejected';
  return 'unclassified';
}

function failClosed(error?: unknown): void {
  try {
    if (isDatabaseInitialized()) _closeDatabase();
  } catch {
    // The worker returns only a stable code; database or path details are not
    // emitted from this adversarial fixture.
  }
  const message = {
    type: 'error',
    code: 'continuity_worker_failed',
    phase: workerPhase,
    failureClass: failureClass(error),
  };
  process.exitCode = 1;
  if (process.send) {
    process.send(message, () => process.disconnect?.());
  }
}

function fingerprint(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function repositoryRoot(workspacePath: string): string {
  return path.join(workspacePath, 'repository');
}

function repositoryFile(workspacePath: string): string {
  return path.join(repositoryRoot(workspacePath), 'fixture.txt');
}

function assertLocalGitFixture(workspacePath: string): string {
  const root = repositoryRoot(workspacePath);
  const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
  if (head !== 'ref: refs/heads/main') {
    throw new Error('Invalid local Git fixture head.');
  }
  const commit = fs
    .readFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), 'utf8')
    .trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('Invalid local Git fixture commit.');
  }
  const compressed = fs.readFileSync(
    path.join(root, '.git', 'objects', commit.slice(0, 2), commit.slice(2)),
  );
  const object = inflateSync(compressed);
  const separator = object.indexOf(0);
  if (
    separator < 0 ||
    !object.subarray(0, separator).toString().startsWith('commit ')
  ) {
    throw new Error('Invalid local Git fixture object.');
  }
  return commit;
}

function repositoryState(workspacePath: string): string {
  const commit = assertLocalGitFixture(workspacePath);
  const contents = fs.readFileSync(repositoryFile(workspacePath));
  return fingerprint(Buffer.concat([Buffer.from(commit), contents]));
}

function effectRoot(workspacePath: string): string {
  const root = path.join(workspacePath, '.fixture-effects');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function effectKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function effectPath(workspacePath: string, key: string): string {
  return path.join(effectRoot(workspacePath), `${effectKey(key)}.effect`);
}

function attemptPath(workspacePath: string, key: string): string {
  return path.join(effectRoot(workspacePath), `${effectKey(key)}.attempts`);
}

function hasEffect(workspacePath: string, key: string): boolean {
  return fs.existsSync(effectPath(workspacePath, key));
}

function applyEffect(workspacePath: string, key: string): boolean {
  fs.appendFileSync(attemptPath(workspacePath, key), 'attempt\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    const fd = fs.openSync(effectPath(workspacePath, key), 'wx', 0o600);
    fs.writeFileSync(fd, 'applied\n');
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  if (key === 'repository-edit') {
    fs.writeFileSync(repositoryFile(workspacePath), 'value=2\n', 'utf8');
  }
  return true;
}

function effectAttempts(workspacePath: string, key: string): number {
  try {
    return fs
      .readFileSync(attemptPath(workspacePath, key), 'utf8')
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

function stopAtBoundary(
  config: WorkerConfig,
  boundary: DurableContinuityBoundary,
): never {
  fs.writeFileSync(config.markerPath, `${JSON.stringify({ boundary })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Unreachable continuity failpoint.');
}

function seedApproval(
  prefix: string,
  work: DurableWorkUnit,
  now = at(1),
): {
  packetId: string;
  version: number;
  checkpoint: DurableWorkCheckpoint;
} {
  const currentPacket = work.approvalPacketId
    ? listCognitiveApprovalPackets({ limit: 100 }).find(
        (packet) => packet.approvalPacketId === work.approvalPacketId,
      )
    : null;
  if (
    currentPacket?.status === 'approved' &&
    currentPacket.approvalVersion === work.approvalVersion
  ) {
    return {
      packetId: currentPacket.approvalPacketId,
      version: currentPacket.approvalVersion || 1,
      checkpoint: currentCheckpoint(work),
    };
  }
  const runId = work.cognitiveRunId;
  if (!runId || !work.checkpointHeadId) {
    throw new Error(
      'Fixture approval requires cognitive and checkpoint links.',
    );
  }
  const summary = 'Approve one bounded fixture effect for continuity testing.';
  upsertCognitiveRun({
    runId,
    createdAt: now,
    updatedAt: now,
    groupFolder: binding.groupId,
    channel: binding.channel,
    taskFamily: 'code',
    turnId: `turn:${prefix}`,
    runOrigin: 'synthetic',
    goalSummary: 'Authorize one isolated fixture effect.',
    selectedSkillId: 'code.repair',
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
  const stagedResult = stageDurableWorkApproval({
    workId: work.workId,
    expectedWorkVersion: work.version,
    cognitiveRunId: runId,
    actionClass: 'repository_write',
    summary,
    checkpointId: work.checkpointHeadId,
    ttlMs: Math.max(1, Date.parse(at(300)) - Date.parse(now)),
    now,
  });
  const staged = listCognitiveApprovalPackets({
    groupFolder: binding.groupId,
    status: 'staged',
    limit: 100,
  }).find(
    (packet) =>
      packet.approvalPacketId === stagedResult.packet.approvalPacketId,
  );
  if (!staged) throw new Error('Fixture approval was not staged.');
  const approved = approveCognitiveApprovalPacketCAS({
    approvalPacketId: staged!.approvalPacketId,
    groupFolder: binding.groupId,
    expectedSummary: summary,
    expectedApprovalVersion: staged.approvalVersion || 1,
    expectedScopeDigest: staged.scopeDigest || null,
    now,
    approvalChannel: 'owner_cockpit',
  });
  if (approved.status !== 'approved' || !approved.approvalVersion) {
    throw new Error('Fixture approval failed closed.');
  }
  return {
    packetId: staged!.approvalPacketId,
    version: approved.approvalVersion,
    checkpoint: stagedResult.checkpoint,
  };
}

function createBaseWork(now = at(0)): DurableWorkUnit {
  return createOrLoadDurableWork({
    originTurnId: 'turn-durable-hard-kill',
    authorizedSurface: 'operator',
    binding,
    goalSummary: 'Repair one isolated repository fixture and verify it.',
    status: 'ready',
    runtimeRunId: 'runtime:durable-hard-kill',
    agentOSEpisodeId: 'agentos:durable-hard-kill',
    cognitiveRunId: 'cognitive:durable-hard-kill',
    planId: 'plan:durable-hard-kill',
    nextAction: 'Commit a bounded checkpoint before execution.',
    now,
  }).work;
}

function commitInitialCheckpoint(work: DurableWorkUnit, workspacePath: string) {
  return commitDurableCheckpointCAS({
    workId: work.workId,
    expectedWorkVersion: work.version,
    completedNodeIds: ['inspect'],
    pendingNodeIds: ['edit', 'verify'],
    uncertainNodeIds: [],
    dependencyIds: ['inspect'],
    worldSignals: { fresh: ['repository-state'], stale: [], missing: [] },
    executorScopeKey: 'host-executor-fixture',
    targetScopeKey: binding.targetScopeKey,
    preStateFingerprint: repositoryState(workspacePath),
    verificationRequirementIds: ['fixture-value-two'],
    stopConditionIds: ['terminal-error', 'retry-budget'],
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction: 'Apply one idempotent fixture edit, then verify it.',
    now: at(1),
  });
}

function durableReceipt(
  work: DurableWorkUnit,
  checkpoint: DurableWorkCheckpoint,
  status: DurableEffectReceipt['status'],
  now: string,
  processGeneration: string,
  options: {
    invocationId?: string;
    authorizationGrantId?: string;
  } = {},
): DurableEffectReceipt {
  return recordDurableEffect({
    workId: work.workId,
    checkpointId: checkpoint.durableCheckpointId,
    planVersion: work.planVersion,
    nodeId: 'edit',
    invocationId: options.invocationId || 'edit-invocation',
    actionClass: 'repository_write',
    authorizationGrantId: options.authorizationGrantId,
    leaseId: work.leaseId,
    processGeneration,
    leaseAssertionNow: now,
    effectClass: 'repository_write',
    status,
    targetScopeKey: binding.targetScopeKey,
    preStateFingerprint: checkpoint.preStateFingerprint,
    postStateFingerprint:
      status === 'partial' || status === 'succeeded'
        ? 'sha256:edit-applied'
        : null,
    verificationFingerprint:
      status === 'succeeded' ? 'sha256:edit-verified' : null,
    metadata: {
      receiptClass: 'repository-write',
      idempotencyKeyHash: fingerprint('repository-edit'),
      source: 'hard-kill-fixture',
    },
    now,
  });
}

function inspectionReceipt(
  work: DurableWorkUnit,
  checkpoint: DurableWorkCheckpoint,
  workspacePath: string,
  now: string,
): DurableEffectReceipt {
  const state = repositoryState(workspacePath);
  return recordDurableEffect({
    workId: work.workId,
    checkpointId: checkpoint.durableCheckpointId,
    planVersion: work.planVersion,
    nodeId: 'inspect',
    invocationId: `inspect-invocation:${work.planVersion}`,
    actionClass: 'repository_read',
    effectClass: 'read_only',
    status: 'succeeded',
    targetScopeKey: binding.targetScopeKey,
    postStateFingerprint: state,
    verificationFingerprint: state,
    metadata: {
      receiptClass: 'repository-inspection',
      verificationClass: 'repository-state',
      resultCode: 'passed',
    },
    now,
  });
}

function runBoundary(config: WorkerConfig): never {
  const boundary = config.boundary;
  if (!boundary) throw new Error('Missing continuity boundary.');
  workerPhase = 'boundary_initialize';
  _initTestDatabaseAtPath(config.databasePath);
  assertLocalGitFixture(config.workspacePath);
  const work = createBaseWork();
  const coreHookBoundaries = new Set<DurableContinuityBoundary>([
    'before_checkpoint_commit',
    'after_checkpoint_commit',
    'during_replan',
  ]);
  _setDurableContinuityTestHook((event) => {
    if (event.boundary === boundary && coreHookBoundaries.has(boundary)) {
      stopAtBoundary(config, boundary);
    }
  });
  workerPhase = 'boundary_checkpoint';
  let committed = commitInitialCheckpoint(work, config.workspacePath);
  workerPhase = 'boundary_approval';
  const approval = seedApproval('hard-kill', committed.work);
  committed = {
    work: getDurableWorkUnit(committed.work.workId)!,
    checkpoint: approval.checkpoint,
  };
  workerPhase = 'boundary_grant';
  const issued = issueDurableResumeGrant({
    workId: committed.work.workId,
    binding,
    actionClass: 'repository_write',
    approvalPacketId: approval.packetId,
    approvalVersion: approval.version,
    inboundMessageId: 'resume-message-hard-kill',
    now: at(2),
  });
  workerPhase = 'boundary_consume';
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding,
    actionClass: 'repository_write',
    inboundMessageId: 'resume-message-hard-kill',
    workerId: 'worker-hard-kill',
    processGeneration: 'process:hard-kill',
    leaseTtlMs: 10_000,
    now: at(3),
  });
  if (consumed.status !== 'consumed' || !consumed.work || !consumed.lease) {
    throw new Error('Fixture grant was not consumed.');
  }
  let current = consumed.work;
  if (boundary === 'after_lease_acquisition') {
    stopAtBoundary(config, boundary);
  }
  if (boundary === 'during_replan') {
    workerPhase = 'boundary_replan';
    current = transitionDurableWork({
      workId: current.workId,
      expectedVersion: current.version,
      toStatus: 'needs_replan',
      nextAction: 'Replan after the fixture contradiction.',
      now: at(4),
    });
    replanDurableWork({
      workId: current.workId,
      expectedVersion: current.version,
      preservedCompletedNodeIds: ['inspect'],
      reasonCode: 'fixture-contradiction',
      nextAction:
        'Inspect the changed fixture before selecting another action.',
      now: at(4),
    });
    throw new Error('Replan failpoint did not stop the worker.');
  }
  const inspectReceipt = inspectionReceipt(
    current,
    committed.checkpoint,
    config.workspacePath,
    at(4),
  );
  if (boundary === 'before_tool_invocation') stopAtBoundary(config, boundary);
  durableReceipt(
    current,
    committed.checkpoint,
    'started',
    at(4),
    'process:hard-kill',
  );
  if (boundary === 'after_tool_start') stopAtBoundary(config, boundary);
  applyEffect(config.workspacePath, 'repository-edit');
  if (boundary === 'after_effect_before_receipt')
    stopAtBoundary(config, boundary);
  let writeReceipt = durableReceipt(
    current,
    committed.checkpoint,
    'partial',
    at(5),
    'process:hard-kill',
  );
  if (boundary === 'after_receipt_before_checkpoint') {
    stopAtBoundary(config, boundary);
  }
  current = transitionDurableWork({
    workId: current.workId,
    expectedVersion: current.version,
    toStatus: 'verifying',
    nextAction: 'Run the fixture postcondition.',
    now: at(6),
  });
  if (boundary === 'after_final_write_before_verification') {
    stopAtBoundary(config, boundary);
  }
  if (
    fs.readFileSync(repositoryFile(config.workspacePath), 'utf8') !==
    'value=2\n'
  ) {
    throw new Error('Fixture verification failed.');
  }
  writeReceipt = durableReceipt(
    current,
    committed.checkpoint,
    'succeeded',
    at(7),
    'process:hard-kill',
  );
  const verificationReceipt = recordDurableEffect({
    workId: current.workId,
    checkpointId: committed.checkpoint.durableCheckpointId,
    planVersion: current.planVersion,
    nodeId: 'verify',
    invocationId: 'verify-invocation',
    actionClass: 'verification_test',
    effectClass: 'read_only',
    status: 'succeeded',
    targetScopeKey: binding.targetScopeKey,
    postStateFingerprint: repositoryState(config.workspacePath),
    verificationFingerprint: repositoryState(config.workspacePath),
    metadata: {
      receiptClass: 'verification',
      verificationClass: 'fixture-value-two',
      resultCode: 'passed',
    },
    now: at(8),
  });
  committed = commitDurableCheckpointCAS({
    workId: current.workId,
    expectedWorkVersion: current.version,
    completedNodeIds: ['inspect', 'edit', 'verify'],
    pendingNodeIds: [],
    receiptIds: [
      inspectReceipt.receiptId,
      writeReceipt.receiptId,
      verificationReceipt.receiptId,
    ],
    executorScopeKey: 'host-executor-fixture',
    targetScopeKey: binding.targetScopeKey,
    preStateFingerprint: committed.checkpoint.preStateFingerprint,
    verifiedPostStateFingerprint: repositoryState(config.workspacePath),
    verificationRequirementIds: ['fixture-value-two'],
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction: 'Record verified completion.',
    status: 'completed',
    now: at(9),
  });
  if (boundary === 'after_verification_before_completion') {
    stopAtBoundary(config, boundary);
  }
  current = transitionDurableWork({
    workId: committed.work.workId,
    expectedVersion: committed.work.version,
    toStatus: 'completed',
    deliveryState: 'pending',
    nextAction: 'Deliver one bounded completion summary.',
    now: at(10),
  });
  if (boundary === 'after_completion_before_reply') {
    stopAtBoundary(config, boundary);
  }
  applyEffect(config.workspacePath, 'reply-delivery');
  recordDurableEffect({
    workId: current.workId,
    checkpointId: committed.checkpoint.durableCheckpointId,
    planVersion: current.planVersion,
    nodeId: 'reply',
    invocationId: 'reply-invocation',
    actionClass: 'local_delivery_record',
    effectClass: 'local_write',
    status: 'succeeded',
    targetScopeKey: binding.targetScopeKey,
    metadata: { receiptClass: 'delivery', resultCode: 'delivered' },
    now: at(11),
  });
  current = transitionDurableDeliveryState({
    workId: current.workId,
    expectedVersion: current.version,
    toState: 'delivered',
    nextAction: 'Await an owner-reviewed outcome.',
    now: at(12),
  });
  if (boundary === 'after_reply_before_learning') {
    stopAtBoundary(config, boundary);
  }
  applyEffect(config.workspacePath, 'learning-record');
  throw new Error(`Boundary ${boundary} was not reached.`);
}

function currentCheckpoint(work: DurableWorkUnit): DurableWorkCheckpoint {
  const checkpoint = listDurableWorkCheckpoints({
    workId: work.workId,
    limit: 1,
  })[0];
  if (!checkpoint) throw new Error('Fixture checkpoint is unavailable.');
  return checkpoint;
}

function completedNodes(checkpoint: DurableWorkCheckpoint): string[] {
  return JSON.parse(checkpoint.completedNodeIdsJson) as string[];
}

function recoverBoundary(config: WorkerConfig): Record<string, unknown> {
  workerPhase = 'recovery_initialize';
  _initTestDatabaseAtPath(config.databasePath);
  assertLocalGitFixture(config.workspacePath);
  workerPhase = 'recovery_reconcile';
  const reconciliation = reconcileDurableWorkOnStartup({
    processGeneration: 'process:recovery',
    now: at(30),
  });
  let work = createBaseWork(at(30));
  let checkpoint = listDurableWorkCheckpoints({
    workId: work.workId,
    limit: 1,
  })[0];
  if (!checkpoint) {
    const committed = commitInitialCheckpoint(work, config.workspacePath);
    work = committed.work;
    checkpoint = committed.checkpoint;
  }

  if (work.status !== 'completed') {
    workerPhase = 'recovery_approval';
    const approval = seedApproval('recovery', work, at(31));
    work = getDurableWorkUnit(work.workId)!;
    checkpoint = approval.checkpoint;
    workerPhase = 'recovery_grant';
    const issued = issueDurableResumeGrant({
      workId: work.workId,
      binding,
      actionClass: 'repository_write',
      approvalPacketId: approval.packetId,
      approvalVersion: approval.version,
      inboundMessageId: 'resume-message-recovery',
      now: at(32),
    });
    workerPhase = 'recovery_consume';
    const consumed = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding,
      actionClass: 'repository_write',
      inboundMessageId: 'resume-message-recovery',
      workerId: 'worker-recovery',
      processGeneration: 'process:recovery',
      leaseTtlMs: 60_000,
      now: at(33),
    });
    if (consumed.status !== 'consumed' || !consumed.work) {
      throw new Error('Recovery grant could not be consumed.');
    }
    work = consumed.work;
    checkpoint = currentCheckpoint(work);

    let inspectReceipt = listDurableEffectReceipts({
      workId: work.workId,
      limit: 100,
    }).find(
      (receipt) =>
        receipt.nodeId === 'inspect' &&
        receipt.status === 'succeeded' &&
        receipt.planVersion === work.planVersion,
    );
    if (!inspectReceipt) {
      inspectReceipt = inspectionReceipt(
        work,
        checkpoint,
        config.workspacePath,
        at(33),
      );
    }

    workerPhase = 'recovery_effect';
    const receiptsBefore = listDurableEffectReceipts({
      workId: work.workId,
      limit: 100,
    });
    if (!hasEffect(config.workspacePath, 'repository-edit')) {
      applyEffect(config.workspacePath, 'repository-edit');
    }
    let writeReceipt = receiptsBefore.find(
      (receipt) =>
        receipt.nodeId === 'edit' &&
        receipt.status === 'succeeded' &&
        Boolean(receipt.verificationFingerprint),
    );
    if (!writeReceipt) {
      if (
        fs.readFileSync(repositoryFile(config.workspacePath), 'utf8') !==
        'value=2\n'
      ) {
        throw new Error('Recovered fixture postcondition failed.');
      }
      writeReceipt = durableReceipt(
        work,
        checkpoint,
        'succeeded',
        at(34),
        'process:recovery',
        {
          invocationId: `edit-invocation-recovery:${work.planVersion}`,
          authorizationGrantId: issued.grant.grantId,
        },
      );
    }

    checkpoint = currentCheckpoint(work);
    if (work.status === 'executing') {
      workerPhase = 'recovery_verifying_transition';
      work = transitionDurableWork({
        workId: work.workId,
        expectedVersion: work.version,
        toStatus: 'verifying',
        nextAction: 'Verify the recovered fixture state.',
        now: at(36),
      });
    }

    checkpoint = currentCheckpoint(work);
    let verificationReceipt = listDurableEffectReceipts({
      workId: work.workId,
      limit: 100,
    }).find(
      (receipt) =>
        receipt.nodeId === 'verify' && receipt.status === 'succeeded',
    );
    if (!verificationReceipt) {
      if (
        fs.readFileSync(repositoryFile(config.workspacePath), 'utf8') !==
        'value=2\n'
      ) {
        throw new Error('Recovered fixture postcondition failed.');
      }
      workerPhase = 'recovery_verification_receipt';
      verificationReceipt = recordDurableEffect({
        workId: work.workId,
        checkpointId: checkpoint.durableCheckpointId,
        planVersion: work.planVersion,
        nodeId: 'verify',
        invocationId: 'verify-invocation-recovery',
        actionClass: 'verification_test',
        effectClass: 'read_only',
        status: 'succeeded',
        targetScopeKey: binding.targetScopeKey,
        postStateFingerprint: repositoryState(config.workspacePath),
        verificationFingerprint: repositoryState(config.workspacePath),
        metadata: {
          receiptClass: 'verification',
          verificationClass: 'fixture-value-two',
          resultCode: 'passed',
        },
        now: at(37),
      });
    }
    checkpoint = currentCheckpoint(work);
    if (
      !completedNodes(checkpoint).includes('verify') ||
      checkpoint.status !== 'completed' ||
      !checkpoint.verifiedPostStateFingerprint
    ) {
      workerPhase = 'recovery_final_checkpoint';
      const committed = commitDurableCheckpointCAS({
        workId: work.workId,
        expectedWorkVersion: work.version,
        completedNodeIds: ['inspect', 'edit', 'verify'],
        pendingNodeIds: [],
        receiptIds: [
          inspectReceipt.receiptId,
          writeReceipt.receiptId,
          verificationReceipt.receiptId,
        ],
        executorScopeKey: 'host-executor-fixture',
        targetScopeKey: binding.targetScopeKey,
        preStateFingerprint: checkpoint.preStateFingerprint,
        verifiedPostStateFingerprint: repositoryState(config.workspacePath),
        verificationRequirementIds: ['fixture-value-two'],
        recoveryPolicy: 'inspect_then_resume',
        nextSafeAction: 'Record verified completion.',
        status: 'completed',
        now: at(38),
      });
      work = committed.work;
      checkpoint = committed.checkpoint;
    } else {
      work = getDurableWorkUnit(work.workId)!;
    }
    if (work.status === 'verifying') {
      workerPhase = 'recovery_completion_transition';
      work = transitionDurableWork({
        workId: work.workId,
        expectedVersion: work.version,
        toStatus: 'completed',
        deliveryState: 'pending',
        nextAction: 'Deliver one bounded completion summary.',
        now: at(39),
      });
    }
  }

  checkpoint = currentCheckpoint(work);
  if (!hasEffect(config.workspacePath, 'reply-delivery')) {
    workerPhase = 'recovery_delivery';
    applyEffect(config.workspacePath, 'reply-delivery');
    recordDurableEffect({
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: 'reply',
      invocationId: 'reply-invocation-recovery',
      actionClass: 'local_delivery_record',
      effectClass: 'local_write',
      status: 'succeeded',
      targetScopeKey: binding.targetScopeKey,
      metadata: { receiptClass: 'delivery', resultCode: 'delivered' },
      now: at(40),
    });
  }
  work = getDurableWorkUnit(work.workId)!;
  if (work.deliveryState !== 'delivered') {
    work = transitionDurableDeliveryState({
      workId: work.workId,
      expectedVersion: work.version,
      toState: 'delivered',
      nextAction: 'Await an owner-reviewed outcome.',
      now: at(41),
    });
  }
  if (!hasEffect(config.workspacePath, 'learning-record')) {
    workerPhase = 'recovery_learning';
    applyEffect(config.workspacePath, 'learning-record');
  }
  work = getDurableWorkUnit(work.workId)!;
  return {
    type: 'recovered',
    boundary: config.boundary,
    status: work.status,
    deliveryState: work.deliveryState,
    checkpointCount: listDurableWorkCheckpoints({
      workId: work.workId,
      limit: 100,
    }).length,
    receiptCount: listDurableEffectReceipts({
      workId: work.workId,
      limit: 100,
    }).length,
    reconciliation,
    repositoryEditAttempts: effectAttempts(
      config.workspacePath,
      'repository-edit',
    ),
    replyAttempts: effectAttempts(config.workspacePath, 'reply-delivery'),
    learningAttempts: effectAttempts(config.workspacePath, 'learning-record'),
    verified:
      fs.readFileSync(repositoryFile(config.workspacePath), 'utf8') ===
      'value=2\n',
    productionStateTouched: false,
  };
}

function setupConcurrency(config: WorkerConfig): Record<string, unknown> {
  _initTestDatabaseAtPath(config.databasePath);
  const work = createBaseWork();
  const committed = commitInitialCheckpoint(work, config.workspacePath);
  const issued = issueDurableResumeGrant({
    workId: committed.work.workId,
    binding,
    actionClass: 'repository_read',
    inboundMessageId: 'concurrent-resume-message',
    now: at(2),
  });
  return {
    type: 'concurrency_setup',
    token: issued.token,
    workId: committed.work.workId,
  };
}

function consumeOnce(config: WorkerConfig): Record<string, unknown> {
  if (!config.token || !config.workerId) {
    throw new Error('Missing concurrency worker input.');
  }
  _initTestDatabaseAtPath(config.databasePath);
  const result = consumeResumeGrantAndAcquireLease({
    token: config.token,
    binding,
    actionClass: 'repository_read',
    inboundMessageId: 'concurrent-resume-message',
    workerId: config.workerId,
    processGeneration: `process:${config.workerId}`,
    now: at(3),
  });
  if (result.status === 'consumed') {
    applyEffect(config.workspacePath, 'concurrent-effect');
  }
  return { type: 'consume_result', status: result.status };
}

function inspectDatabase(config: WorkerConfig): Record<string, unknown> {
  _initTestDatabaseAtPath(config.databasePath);
  const works = listDurableWorkUnits({ limit: 100 });
  const grants = listDurableResumeGrants({ limit: 100 });
  return {
    type: 'inspection',
    workCount: works.length,
    grantCount: grants.length,
    tokenHashLengths: grants.map((grant) => grant.tokenHash.length),
    activeLeaseCount: works.filter((work) => Boolean(work.leaseId)).length,
    concurrentEffectAttempts: effectAttempts(
      config.workspacePath,
      'concurrent-effect',
    ),
  };
}

async function dispatch(config: WorkerConfig): Promise<void> {
  if (config.kind === 'initialize_then_block') {
    _initTestDatabaseAtPath(config.databasePath);
    fs.writeFileSync(
      config.markerPath,
      `${JSON.stringify({ boundary: 'after_database_initialization' })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('Unreachable initialization failpoint.');
  }
  if (config.kind === 'run_boundary') {
    runBoundary(config);
    return;
  }
  if (config.kind === 'recover_boundary') {
    finish(recoverBoundary(config));
    return;
  }
  if (config.kind === 'setup_concurrency') {
    const result = setupConcurrency(config);
    const token = result.token;
    // The token is intentionally transferred only through the private test
    // IPC channel and is never written to argv, env, stdout, or the database.
    void token;
    finish(result);
    return;
  }
  if (config.kind === 'prepare_consume') {
    pendingConsume = config;
    send({ type: 'ready' });
    return;
  }
  if (config.kind === 'inspect') {
    finish(inspectDatabase(config));
    return;
  }
  throw new Error('Unknown continuity worker command.');
}

process.on('message', (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const message = value as WorkerConfig & { kind: string };
  if (message.kind === 'go' && pendingConsume) {
    const config = pendingConsume;
    pendingConsume = null;
    try {
      finish(consumeOnce(config));
    } catch {
      failClosed();
    }
    return;
  }
  dispatch(message).catch(failClosed);
});
