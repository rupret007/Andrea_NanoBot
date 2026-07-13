import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';
import {
  consumeDurableResumeGrantAtomic,
  getDurableResumeGrantByTokenHash,
  getDurableWorkCheckpoint,
  getDurableWorkLease,
  getDurableWorkUnit,
  heartbeatDurableWorkLease,
  insertDurableResumeGrant,
  insertDurableWorkCheckpoint,
  insertDurableWorkUnit,
  isDatabaseInitialized,
  listCognitiveApprovalPackets,
  listDurableEffectReceipts,
  listDurableResumeGrants,
  listDurableWorkCheckpoints,
  listDurableWorkEvents,
  listDurableWorkLinks,
  listDurableWorkUnits,
  reconcileExpiredDurableWorkLeases,
  releaseDurableWorkLease,
  revokeDurableResumeGrant,
  stageDurableWorkApprovalPacketAtomic,
  transitionDurableWorkUnitCAS,
  upsertDurableEffectReceipt,
  upsertDurableWorkLink,
} from './db.js';
import {
  assertDurableActionClass,
  assertDurableActionEffectPolicy,
  durableActionRequiresApproval,
} from './durable-action-policy.js';
import type {
  CognitiveApprovalPacket,
  DurableAdaptiveDecision,
  DurableDecisionAction,
  DurableEffectReceipt,
  DurableResumeGrant,
  DurableWorkCheckpoint,
  DurableWorkEvent,
  DurableWorkLink,
  DurableWorkStatus,
  DurableWorkUnit,
} from './types.js';

const MAX_ID_COUNT = 200;
const MAX_ID_LENGTH = 220;
const MAX_SUMMARY_LENGTH = 900;
const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;
const MAX_GRANT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 60_000;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_APPROVAL_TTL_MS = 2 * 60 * 60 * 1000;
const PROCESS_GENERATION = `process:${process.pid}:${Date.now()}:${randomUUID()}`;

const SECRET_OR_RAW_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|Bearer\s+|password\s*[:=]|secret\s*[:=]|chain[- ]of[- ]thought|hidden reasoning|raw prompt|raw reply|raw tool output|private message body/i;
const PATH_OR_COMMAND_RE =
  /(?:^|[\s"'])\/(?:Users|home|private|tmp|var|opt|etc)\/|[A-Za-z]:\\|(?:^|\s)command\s*[:=]|\b(?:argv|shell|workingDirectory|absolutePath|canonicalPath)\b/i;

export const DURABLE_CONTINUITY_PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawRepliesStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  rawToolOutputStored: false,
  commandsStored: false,
  arbitraryPathsStored: false,
  resumeTokenStored: false,
  secretsRedacted: true,
} as const;

export type DurableContinuityBoundary =
  | 'before_checkpoint_commit'
  | 'after_checkpoint_commit'
  | 'after_lease_acquisition'
  | 'before_tool_invocation'
  | 'after_tool_start'
  | 'after_effect_before_receipt'
  | 'after_receipt_before_checkpoint'
  | 'after_final_write_before_verification'
  | 'after_verification_before_completion'
  | 'after_completion_before_reply'
  | 'after_reply_before_learning'
  | 'during_replan';

type DurableContinuityTestHook = (event: {
  boundary: DurableContinuityBoundary;
  workId: string;
  version: number;
}) => void;

let continuityTestHook: DurableContinuityTestHook | null = null;

/** @internal Test-only failpoint. Production behavior never reads an env flag. */
export function _setDurableContinuityTestHook(
  hook: DurableContinuityTestHook | null,
): void {
  continuityTestHook = hook;
}

function emitBoundary(
  boundary: DurableContinuityBoundary,
  workId: string,
  version: number,
): void {
  continuityTestHook?.({ boundary, workId, version });
}

export function durableProcessGeneration(): string {
  return PROCESS_GENERATION;
}

export function durableScopeHash(
  kind: string,
  value: string | null | undefined,
): string {
  const normalized = String(value || 'unbound').trim() || 'unbound';
  return createHash('sha256')
    .update(`andrea:durable-scope:v1\0${kind}\0${normalized}`)
    .digest('hex');
}

export function hashDurableResumeToken(token: string): string {
  return createHash('sha256')
    .update(`andrea:durable-resume:v1\0${token}`)
    .digest('hex');
}

function privacyJson(): string {
  return JSON.stringify(DURABLE_CONTINUITY_PRIVACY);
}

function safeId(value: string, label = 'identifier'): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH) {
    throw new Error(`Invalid durable ${label}.`);
  }
  if (!/^[A-Za-z0-9:_-]+$/.test(normalized)) {
    throw new Error(`Unsafe durable ${label}.`);
  }
  return normalized;
}

function safeIds(
  values: readonly string[] | undefined,
  label: string,
): string[] {
  const unique = Array.from(new Set(values || []));
  if (unique.length > MAX_ID_COUNT) {
    throw new Error(`Durable ${label} exceeds its bounded item count.`);
  }
  return unique.map((value) => safeId(value, label));
}

function safeSummary(value: string, label: string): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > MAX_SUMMARY_LENGTH) {
    throw new Error(`Invalid durable ${label}.`);
  }
  if (
    SECRET_OR_RAW_RE.test(normalized) ||
    PATH_OR_COMMAND_RE.test(normalized)
  ) {
    throw new Error(
      `Durable ${label} contains prohibited private execution data.`,
    );
  }
  return redactCouncilText(normalized, MAX_SUMMARY_LENGTH);
}

function idsJson(values: readonly string[] | undefined, label: string): string {
  return JSON.stringify(safeIds(values, label));
}

function iso(value: Date | string | undefined, fallback = new Date()): string {
  const date =
    value instanceof Date ? value : value ? new Date(value) : fallback;
  if (!Number.isFinite(date.getTime()))
    throw new Error('Invalid durable timestamp.');
  return date.toISOString();
}

function boundedTtl(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error('Durable lifetime is outside the allowed bound.');
  }
  return Math.trunc(value);
}

function event(params: {
  workId: string;
  kind: DurableWorkEvent['eventKind'];
  createdAt: string;
  fromStatus?: DurableWorkStatus | null;
  toStatus?: DurableWorkStatus | null;
  workVersion: number;
  planVersion: number;
  summary: string;
  refs?: string[];
  nonce?: string;
}): DurableWorkEvent {
  return {
    eventId: `durable:event:${createHash('sha256')
      .update(
        [
          params.workId,
          params.kind,
          params.createdAt,
          params.workVersion,
          params.planVersion,
          params.nonce || '',
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 32)}`,
    workId: params.workId,
    createdAt: params.createdAt,
    eventKind: params.kind,
    fromStatus: params.fromStatus || null,
    toStatus: params.toStatus || null,
    workVersion: params.workVersion,
    planVersion: params.planVersion,
    summary: safeSummary(params.summary, 'event summary'),
    refsJson: idsJson(params.refs || [], 'event reference'),
    privacyJson: privacyJson(),
  };
}

const ALLOWED_TRANSITIONS: Record<DurableWorkStatus, DurableWorkStatus[]> = {
  proposed: ['inspecting', 'cancelled', 'blocked'],
  inspecting: [
    'planned',
    'blocked',
    'interrupted',
    'needs_replan',
    'cancelled',
  ],
  planned: [
    'ready',
    'awaiting_approval',
    'needs_replan',
    'blocked',
    'cancelled',
  ],
  ready: ['executing', 'verifying', 'interrupted', 'needs_replan', 'cancelled'],
  awaiting_approval: [
    'planned',
    'ready',
    'executing',
    'blocked',
    'interrupted',
    'cancelled',
  ],
  executing: [
    'verifying',
    'interrupted',
    'needs_replan',
    'delivery_unverified',
    'blocked',
    'cancelled',
  ],
  verifying: [
    'ready',
    'completed',
    'verification_failed',
    'needs_replan',
    'delivery_unverified',
    'interrupted',
    'blocked',
  ],
  blocked: ['inspecting', 'needs_replan', 'cancelled', 'superseded'],
  interrupted: [
    'ready',
    'verifying',
    'needs_replan',
    'cancelled',
    'superseded',
  ],
  needs_replan: ['planned', 'ready', 'blocked', 'cancelled', 'superseded'],
  delivery_unverified: ['verifying', 'completed', 'blocked', 'cancelled'],
  verification_failed: ['needs_replan', 'verifying', 'blocked', 'cancelled'],
  completed: ['superseded'],
  cancelled: [],
  superseded: [],
};

export interface DurableWorkBindingInput {
  ownerId: string;
  chatId: string;
  groupId: string;
  channel: string;
  targetScopeKey: string;
}

function bindingHashes(binding: DurableWorkBindingInput): {
  ownerScopeHash: string;
  chatScopeHash: string;
  groupScopeHash: string;
  targetScopeHash: string;
  channel: string;
} {
  return {
    ownerScopeHash: durableScopeHash('owner', binding.ownerId),
    chatScopeHash: durableScopeHash('chat', binding.chatId),
    groupScopeHash: durableScopeHash('group', binding.groupId),
    targetScopeHash: durableScopeHash('target', binding.targetScopeKey),
    channel: safeId(binding.channel, 'channel'),
  };
}

export function shouldCreateDurableWork(input: {
  taskFamily?: string | null;
  requestRoute?: string | null;
  approvalRequired?: boolean;
  explicitlyDurable?: boolean;
}): boolean {
  if (input.explicitlyDurable || input.approvalRequired) return true;
  const shape = `${input.taskFamily || ''} ${input.requestRoute || ''}`;
  return /\b(code|coding|research|operator|mission|deep[_ -]?work|repair|deploy|cursor|runtime)\b/i.test(
    shape,
  );
}

export function createOrLoadDurableWork(input: {
  originTurnId: string;
  authorizedSurface: string;
  binding: DurableWorkBindingInput;
  goalSummary: string;
  status?: DurableWorkStatus;
  missionId?: string | null;
  goalId?: string | null;
  runtimeRunId?: string | null;
  agentOSEpisodeId?: string | null;
  cognitiveRunId?: string | null;
  deepWorkPacketId?: string | null;
  planId?: string | null;
  nextAction: string;
  now?: Date | string;
}): { work: DurableWorkUnit; created: boolean } {
  if (!isDatabaseInitialized()) {
    throw new Error('Durable work requires initialized storage.');
  }
  const now = iso(input.now);
  const hashes = bindingHashes(input.binding);
  const workId = `work:${randomUUID()}`;
  const status = input.status || 'proposed';
  const record: DurableWorkUnit = {
    workId,
    createdAt: now,
    updatedAt: now,
    status,
    version: 1,
    planVersion: 1,
    originTurnHash: durableScopeHash('origin-turn', input.originTurnId),
    authorizedSurface: safeId(input.authorizedSurface, 'authorized surface'),
    ...hashes,
    goalSummary: safeSummary(input.goalSummary, 'goal summary'),
    missionId: input.missionId ? safeId(input.missionId, 'mission ID') : null,
    goalId: input.goalId ? safeId(input.goalId, 'goal ID') : null,
    runtimeRunId: input.runtimeRunId
      ? safeId(input.runtimeRunId, 'runtime run ID')
      : null,
    agentOSEpisodeId: input.agentOSEpisodeId
      ? safeId(input.agentOSEpisodeId, 'Agent OS episode ID')
      : null,
    trajectoryId: null,
    cognitiveRunId: input.cognitiveRunId
      ? safeId(input.cognitiveRunId, 'cognitive run ID')
      : null,
    deepWorkPacketId: input.deepWorkPacketId
      ? safeId(input.deepWorkPacketId, 'deep-work packet ID')
      : null,
    approvalPacketId: null,
    approvalVersion: null,
    checkpointHeadId: null,
    planId: input.planId ? safeId(input.planId, 'plan ID') : null,
    executionEvidenceRefsJson: '[]',
    deliveryState: 'not_started',
    ownerReviewId: null,
    skillCandidateId: null,
    leaseId: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    expiresAt: null,
    interruptedAt: null,
    completedAt: null,
    nextAction: safeSummary(input.nextAction, 'next action'),
    privacyJson: privacyJson(),
  };
  const createdEvent = event({
    workId,
    kind: 'created',
    createdAt: now,
    toStatus: status,
    workVersion: 1,
    planVersion: 1,
    summary: 'Created one canonical durable work identity.',
    refs: [
      input.runtimeRunId || '',
      input.agentOSEpisodeId || '',
      input.cognitiveRunId || '',
      input.deepWorkPacketId || '',
    ].filter(Boolean),
    nonce: workId,
  });
  const result = insertDurableWorkUnit({ record, createdEvent });
  if (result.created) {
    for (const [kind, linkedId] of [
      ['mission', input.missionId],
      ['goal', input.goalId],
      ['runtime_run', input.runtimeRunId],
      ['agent_os_episode', input.agentOSEpisodeId],
      ['cognitive_run', input.cognitiveRunId],
      ['deep_work_packet', input.deepWorkPacketId],
    ] as Array<[DurableWorkLink['linkKind'], string | null | undefined]>) {
      if (linkedId)
        linkDurableWorkProjection(result.record.workId, kind, linkedId, now);
    }
  }
  return { work: result.record, created: result.created };
}

export function linkDurableWorkProjection(
  workId: string,
  linkKind: DurableWorkLink['linkKind'],
  linkedId: string,
  nowInput?: Date | string,
): DurableWorkLink {
  const now = iso(nowInput);
  const safeWorkId = safeId(workId, 'work ID');
  const safeLinkedId = safeId(linkedId, 'linked projection ID');
  const link: DurableWorkLink = {
    linkId: `durable:link:${createHash('sha256')
      .update(`${safeWorkId}|${linkKind}|${safeLinkedId}`)
      .digest('hex')
      .slice(0, 32)}`,
    workId: safeWorkId,
    linkKind,
    linkedId: safeLinkedId,
    createdAt: now,
    privacyJson: privacyJson(),
  };
  upsertDurableWorkLink(link);
  return link;
}

export function stageDurableWorkApproval(input: {
  workId: string;
  expectedWorkVersion: number;
  cognitiveRunId: string;
  actionClass: string;
  summary: string;
  checkpointId?: string | null;
  ttlMs?: number;
  now?: Date | string;
}): {
  packet: CognitiveApprovalPacket;
  work: DurableWorkUnit;
  checkpoint: DurableWorkCheckpoint;
} {
  const work = getDurableWorkUnit(safeId(input.workId, 'work ID'));
  if (!work) throw new Error('Durable work was not found.');
  if (work.version !== input.expectedWorkVersion) {
    throw new Error('Durable work changed; reload before staging approval.');
  }
  const cognitiveRunId = safeId(input.cognitiveRunId, 'cognitive run ID');
  const actionClass = safeId(input.actionClass, 'action class');
  assertDurableActionClass(actionClass);
  if (!durableActionRequiresApproval(actionClass)) {
    throw new Error(
      'Read-only durable work does not require approval staging.',
    );
  }
  if (work.cognitiveRunId !== cognitiveRunId) {
    throw new Error('Durable approval must use the work cognitive run.');
  }
  const parentCheckpointId = safeId(
    input.checkpointId || work.checkpointHeadId || '',
    'checkpoint ID',
  );
  if (work.checkpointHeadId !== parentCheckpointId) {
    throw new Error('Durable approval must use the current checkpoint.');
  }
  const parentCheckpoint = getDurableWorkCheckpoint(parentCheckpointId);
  if (
    !parentCheckpoint ||
    parentCheckpoint.workId !== work.workId ||
    parentCheckpoint.planVersion !== work.planVersion ||
    parentCheckpoint.targetScopeHash !== work.targetScopeHash
  ) {
    throw new Error('Durable approval parent checkpoint is stale.');
  }
  const now = iso(input.now);
  const ttlMs = boundedTtl(
    input.ttlMs,
    DEFAULT_APPROVAL_TTL_MS,
    MAX_APPROVAL_TTL_MS,
  );
  const approvalIdentity = createHash('sha256')
    .update(
      [
        work.workId,
        cognitiveRunId,
        parentCheckpointId,
        work.targetScopeHash,
        actionClass,
        String(work.planVersion),
        work.approvalPacketId || '',
        now,
      ].join('|'),
    )
    .digest('hex');
  const approvalPacketId = `approval:durable:${approvalIdentity.slice(0, 40)}`;
  const approvalCheckpointId = `checkpoint:approval:${approvalIdentity.slice(0, 40)}`;
  const summary = safeSummary(input.summary, 'approval summary');
  const packet: CognitiveApprovalPacket = {
    approvalPacketId,
    createdAt: now,
    updatedAt: now,
    runId: cognitiveRunId,
    toolId: `durable:${actionClass}`,
    actionClass,
    status: 'staged',
    summary,
    approvalChannel: null,
    approvalKey: `durable-scope:${approvalIdentity}`,
    expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    approvalVersion: 1,
    scopeDigest: null,
    summaryDigest: null,
    durableWorkId: work.workId,
    durableCheckpointId: approvalCheckpointId,
    planVersion: work.planVersion,
    targetScopeDigest: work.targetScopeHash,
    decisionJson: JSON.stringify({
      decision: 'staged',
      checkpointId: approvalCheckpointId,
      parentCheckpointId,
      planVersion: work.planVersion,
      approvalRequired: true,
      externalActionExecuted: false,
      metadataOnly: true,
    }),
    privacyJson: privacyJson(),
  };
  const approvalCheckpoint: DurableWorkCheckpoint = {
    durableCheckpointId: approvalCheckpointId,
    workId: work.workId,
    runtimeCheckpointId: parentCheckpoint.runtimeCheckpointId || null,
    parentCheckpointId,
    createdAt: now,
    updatedAt: now,
    status: 'interrupted',
    workVersion: work.version + 1,
    planVersion: work.planVersion,
    sequence: parentCheckpoint.sequence + 1,
    completedNodeIdsJson: parentCheckpoint.completedNodeIdsJson,
    pendingNodeIdsJson: parentCheckpoint.pendingNodeIdsJson,
    uncertainNodeIdsJson: parentCheckpoint.uncertainNodeIdsJson,
    dependencyIdsJson: parentCheckpoint.dependencyIdsJson,
    worldSignalStateJson: parentCheckpoint.worldSignalStateJson,
    approvalScopeJson: JSON.stringify({
      approvalPacketId,
      approvalVersion: 1,
      actionClass,
      durableWorkId: work.workId,
      durableCheckpointId: approvalCheckpointId,
      planVersion: work.planVersion,
      targetScopeHash: work.targetScopeHash,
      expiresAt: packet.expiresAt,
      metadataOnly: true,
    }),
    executorScopeHash: parentCheckpoint.executorScopeHash,
    targetScopeHash: parentCheckpoint.targetScopeHash,
    preStateFingerprint: parentCheckpoint.preStateFingerprint || null,
    verifiedPostStateFingerprint:
      parentCheckpoint.verifiedPostStateFingerprint || null,
    receiptIdsJson: parentCheckpoint.receiptIdsJson,
    verificationRequirementsJson: parentCheckpoint.verificationRequirementsJson,
    retryBudget: parentCheckpoint.retryBudget,
    attemptsUsed: parentCheckpoint.attemptsUsed,
    stopConditionsJson: parentCheckpoint.stopConditionsJson,
    recoveryPolicy: 'approval_required',
    nextSafeAction:
      'Wait for exact owner approval, then issue a fresh scoped resume grant.',
    privacyJson: privacyJson(),
  };
  const link: DurableWorkLink = {
    linkId: `durable:link:${createHash('sha256')
      .update(`${work.workId}|approval_packet|${approvalPacketId}`)
      .digest('hex')
      .slice(0, 32)}`,
    workId: work.workId,
    linkKind: 'approval_packet',
    linkedId: approvalPacketId,
    createdAt: now,
    privacyJson: privacyJson(),
  };
  const staged = stageDurableWorkApprovalPacketAtomic({
    packet,
    expectedWorkVersion: work.version,
    checkpoint: approvalCheckpoint,
    link,
    event: event({
      workId: work.workId,
      kind: 'transition',
      createdAt: now,
      fromStatus: work.status,
      toStatus: 'awaiting_approval',
      workVersion: work.version + 1,
      planVersion: work.planVersion,
      summary: 'Staged one immutable exact-scope durable approval.',
      refs: [approvalPacketId, approvalCheckpointId, parentCheckpointId],
      nonce: approvalPacketId,
    }),
  });
  if (!staged) {
    throw new Error('Durable approval lost its compare-and-set race.');
  }
  return staged;
}

export function transitionDurableWork(input: {
  workId: string;
  expectedVersion: number;
  toStatus: DurableWorkStatus;
  nextAction: string;
  now?: Date | string;
  deliveryState?: DurableWorkUnit['deliveryState'];
}): DurableWorkUnit {
  const work = getDurableWorkUnit(input.workId);
  if (!work) throw new Error('Durable work was not found.');
  if (work.version !== input.expectedVersion) {
    throw new Error('Durable work changed; reload before transitioning it.');
  }
  if (!ALLOWED_TRANSITIONS[work.status].includes(input.toStatus)) {
    throw new Error(
      `Invalid durable work transition ${work.status} -> ${input.toStatus}.`,
    );
  }
  if (input.toStatus === 'completed') {
    const checkpoint = work.checkpointHeadId
      ? getDurableWorkCheckpoint(work.checkpointHeadId)
      : null;
    const receiptIds = checkpoint
      ? new Set(checkpointIds(checkpoint.receiptIdsJson, 'receipt ID'))
      : new Set<string>();
    const receipts = checkpoint
      ? listDurableEffectReceipts({ workId: work.workId, limit: 1_000 }).filter(
          (receipt) =>
            receipt.planVersion === work.planVersion &&
            receiptIds.has(receipt.receiptId),
        )
      : [];
    const completedNodeIds = checkpoint
      ? checkpointIds(checkpoint.completedNodeIdsJson, 'completed node ID')
      : [];
    const pendingNodeIds = checkpoint
      ? checkpointIds(checkpoint.pendingNodeIdsJson, 'pending node ID')
      : [];
    const uncertainNodeIds = checkpoint
      ? checkpointIds(checkpoint.uncertainNodeIdsJson, 'uncertain node ID')
      : [];
    const unresolved = receipts.some((receipt) =>
      ['started', 'partial', 'unknown', 'failed'].includes(receipt.status),
    );
    const verifiedTerminalReceipt = receipts.find(
      (receipt) =>
        receipt.status === 'succeeded' &&
        Boolean(receipt.verificationFingerprint) &&
        Boolean(receipt.postStateFingerprint) &&
        receipt.postStateFingerprint ===
          checkpoint?.verifiedPostStateFingerprint &&
        receipt.targetScopeHash === work.targetScopeHash,
    );
    const approvalPackets = listCognitiveApprovalPackets({ limit: 1_000 });
    const invalidMutatingProvenance = receipts.some((receipt) => {
      if (!durableActionRequiresApproval(receipt.actionClass)) {
        return false;
      }
      const approval = approvalPackets.find(
        (packet) => packet.approvalPacketId === receipt.approvalPacketId,
      );
      return !(
        receipt.grantId &&
        receipt.approvalPacketId &&
        receipt.approvalVersion &&
        receipt.approvalScopeHash &&
        approval?.status === 'approved' &&
        approval.approvalVersion === receipt.approvalVersion &&
        approval.scopeDigest === receipt.approvalScopeHash &&
        approval.durableWorkId === work.workId &&
        approval.durableCheckpointId === receipt.checkpointId &&
        approval.planVersion === receipt.planVersion &&
        approval.targetScopeDigest === work.targetScopeHash &&
        approval.actionClass === receipt.actionClass
      );
    });
    if (checkpoint) {
      assertCompletedNodeReceipts({
        work,
        completedNodeIds,
        requiredNodeIds: completedNodeIds,
        referencedReceiptIds: [...receiptIds],
        targetScopeHash: work.targetScopeHash,
      });
    }
    if (
      !checkpoint ||
      checkpoint.workId !== work.workId ||
      checkpoint.planVersion !== work.planVersion ||
      checkpoint.status !== 'completed' ||
      !checkpoint.verifiedPostStateFingerprint ||
      !verifiedTerminalReceipt ||
      pendingNodeIds.length > 0 ||
      uncertainNodeIds.length > 0 ||
      unresolved ||
      invalidMutatingProvenance
    ) {
      throw new Error(
        'Durable work requires a verified terminal checkpoint and exact effect provenance before completion.',
      );
    }
  }
  const now = iso(input.now);
  const updated = transitionDurableWorkUnitCAS({
    workId: work.workId,
    expectedVersion: work.version,
    allowedFrom: [work.status],
    toStatus: input.toStatus,
    updatedAt: now,
    nextAction: safeSummary(input.nextAction, 'next action'),
    deliveryState: input.deliveryState,
    completedAt: input.toStatus === 'completed' ? now : null,
    interruptedAt: input.toStatus === 'interrupted' ? now : null,
    event: event({
      workId: work.workId,
      kind: input.toStatus === 'completed' ? 'verified' : 'transition',
      createdAt: now,
      fromStatus: work.status,
      toStatus: input.toStatus,
      workVersion: work.version + 1,
      planVersion: work.planVersion,
      summary: `Durable work advanced from ${work.status} to ${input.toStatus}.`,
      refs: [work.checkpointHeadId || ''].filter(Boolean),
      nonce: randomUUID(),
    }),
  });
  if (!updated)
    throw new Error('Durable work transition lost its compare-and-set race.');
  return updated;
}

export function commitDurableCheckpointCAS(input: {
  workId: string;
  expectedWorkVersion: number;
  runtimeCheckpointId?: string | null;
  completedNodeIds?: string[];
  pendingNodeIds?: string[];
  uncertainNodeIds?: string[];
  dependencyIds?: string[];
  worldSignals?: { fresh?: string[]; stale?: string[]; missing?: string[] };
  approval?: {
    packetId: string;
    version: number;
    scopeHash: string;
  } | null;
  executorScopeKey: string;
  targetScopeKey: string;
  preStateFingerprint?: string | null;
  verifiedPostStateFingerprint?: string | null;
  receiptIds?: string[];
  verificationRequirementIds?: string[];
  retryBudget?: number;
  attemptsUsed?: number;
  stopConditionIds?: string[];
  recoveryPolicy: DurableWorkCheckpoint['recoveryPolicy'];
  nextSafeAction: string;
  status?: DurableWorkCheckpoint['status'];
  now?: Date | string;
}): { work: DurableWorkUnit; checkpoint: DurableWorkCheckpoint } {
  const work = getDurableWorkUnit(input.workId);
  if (!work || work.version !== input.expectedWorkVersion) {
    throw new Error('Durable work changed before checkpoint commit.');
  }
  const prior = listDurableWorkCheckpoints({
    workId: work.workId,
    limit: 1,
  })[0];
  const now = iso(input.now);
  const completed = safeIds(input.completedNodeIds, 'completed node ID');
  const pending = safeIds(input.pendingNodeIds, 'pending node ID');
  const uncertain = safeIds(input.uncertainNodeIds, 'uncertain node ID');
  const receiptIds = safeIds(input.receiptIds, 'receipt ID');
  const overlap = new Set(
    completed.filter((id) => pending.includes(id) || uncertain.includes(id)),
  );
  if (overlap.size > 0)
    throw new Error('A durable plan node has conflicting checkpoint states.');
  if (prior && prior.planVersion === work.planVersion) {
    const priorCompleted = checkpointIds(
      prior.completedNodeIdsJson,
      'completed node ID',
    );
    const priorUncertain = checkpointIds(
      prior.uncertainNodeIdsJson,
      'uncertain node ID',
    );
    const priorPending = checkpointIds(
      prior.pendingNodeIdsJson,
      'pending node ID',
    );
    const droppedCompleted = priorCompleted.filter(
      (nodeId) => !completed.includes(nodeId),
    );
    if (droppedCompleted.length > 0) {
      throw new Error(
        'Durable checkpoint cannot drop previously completed node state.',
      );
    }
    const droppedUncertain = priorUncertain.filter(
      (nodeId) => !uncertain.includes(nodeId) && !completed.includes(nodeId),
    );
    if (droppedUncertain.length > 0) {
      throw new Error(
        'Durable checkpoint cannot drop uncertain node state without verified completion proof.',
      );
    }
    const droppedPending = priorPending.filter(
      (nodeId) =>
        !pending.includes(nodeId) &&
        !uncertain.includes(nodeId) &&
        !completed.includes(nodeId),
    );
    if (droppedPending.length > 0) {
      throw new Error(
        'Durable checkpoint cannot drop pending node state without replan or verified proof.',
      );
    }
    const newlyCompleted = completed.filter(
      (nodeId) => !priorCompleted.includes(nodeId),
    );
    assertCompletedNodeReceipts({
      work,
      completedNodeIds: completed,
      requiredNodeIds: newlyCompleted,
      referencedReceiptIds: receiptIds,
      targetScopeHash: work.targetScopeHash,
    });
  }
  if (input.status === 'completed') {
    if (pending.length > 0 || uncertain.length > 0) {
      throw new Error(
        'A completed durable checkpoint cannot retain pending or uncertain nodes.',
      );
    }
    assertCompletedNodeReceipts({
      work,
      completedNodeIds: completed,
      requiredNodeIds: completed,
      referencedReceiptIds: receiptIds,
      targetScopeHash: work.targetScopeHash,
    });
  }
  const retryBudget = Math.max(
    0,
    Math.min(20, Math.trunc(input.retryBudget ?? 3)),
  );
  const attemptsUsed = Math.max(
    0,
    Math.min(20, Math.trunc(input.attemptsUsed ?? 0)),
  );
  if (attemptsUsed > retryBudget)
    throw new Error('Durable attempts exceed the retry budget.');
  const sequence =
    prior && prior.planVersion === work.planVersion ? prior.sequence + 1 : 1;
  const checkpointId = `checkpoint:${randomUUID()}`;
  const checkpoint: DurableWorkCheckpoint = {
    durableCheckpointId: checkpointId,
    workId: work.workId,
    runtimeCheckpointId: input.runtimeCheckpointId
      ? safeId(input.runtimeCheckpointId, 'runtime checkpoint ID')
      : null,
    parentCheckpointId: prior?.durableCheckpointId || null,
    createdAt: now,
    updatedAt: now,
    status: input.status || 'open',
    workVersion: work.version + 1,
    planVersion: work.planVersion,
    sequence,
    completedNodeIdsJson: JSON.stringify(completed),
    pendingNodeIdsJson: JSON.stringify(pending),
    uncertainNodeIdsJson: JSON.stringify(uncertain),
    dependencyIdsJson: idsJson(input.dependencyIds, 'dependency ID'),
    worldSignalStateJson: JSON.stringify({
      fresh: safeIds(input.worldSignals?.fresh, 'fresh signal ID'),
      stale: safeIds(input.worldSignals?.stale, 'stale signal ID'),
      missing: safeIds(input.worldSignals?.missing, 'missing signal ID'),
    }),
    approvalScopeJson: JSON.stringify(
      input.approval
        ? {
            packetId: safeId(input.approval.packetId, 'approval packet ID'),
            version: Math.max(1, Math.trunc(input.approval.version)),
            scopeHash: safeId(input.approval.scopeHash, 'approval scope hash'),
          }
        : { required: false },
    ),
    executorScopeHash: durableScopeHash('executor', input.executorScopeKey),
    targetScopeHash: durableScopeHash('target', input.targetScopeKey),
    preStateFingerprint: input.preStateFingerprint
      ? safeId(input.preStateFingerprint, 'pre-state fingerprint')
      : null,
    verifiedPostStateFingerprint: input.verifiedPostStateFingerprint
      ? safeId(input.verifiedPostStateFingerprint, 'post-state fingerprint')
      : null,
    receiptIdsJson: JSON.stringify(receiptIds),
    verificationRequirementsJson: idsJson(
      input.verificationRequirementIds,
      'verification requirement ID',
    ),
    retryBudget,
    attemptsUsed,
    stopConditionsJson: idsJson(input.stopConditionIds, 'stop condition ID'),
    recoveryPolicy: input.recoveryPolicy,
    nextSafeAction: safeSummary(input.nextSafeAction, 'next safe action'),
    privacyJson: privacyJson(),
  };
  emitBoundary('before_checkpoint_commit', work.workId, work.version);
  const committed = insertDurableWorkCheckpoint({
    checkpoint,
    expectedWorkVersion: work.version,
    event: event({
      workId: work.workId,
      kind: 'checkpoint',
      createdAt: now,
      workVersion: work.version + 1,
      planVersion: work.planVersion,
      summary: 'Committed a bounded durable checkpoint.',
      refs: [checkpointId],
      nonce: checkpointId,
    }),
  });
  if (!committed)
    throw new Error('Durable checkpoint lost its compare-and-set race.');
  emitBoundary('after_checkpoint_commit', work.workId, committed.work.version);
  return committed;
}

function approvalForGrant(input: {
  approvalPacketId: string;
  approvalVersion: number;
  groupId: string;
  workId: string;
  checkpointId: string;
  planVersion: number;
  targetScopeHash: string;
  actionClass: string;
  now: string;
}): CognitiveApprovalPacket {
  const packet = listCognitiveApprovalPackets({
    groupFolder: input.groupId,
    limit: 100,
  }).find((candidate) => candidate.approvalPacketId === input.approvalPacketId);
  if (
    !packet ||
    packet.status !== 'approved' ||
    Math.max(1, packet.approvalVersion || 1) !== input.approvalVersion ||
    !packet.scopeDigest ||
    packet.durableWorkId !== input.workId ||
    packet.durableCheckpointId !== input.checkpointId ||
    packet.planVersion !== input.planVersion ||
    packet.targetScopeDigest !== input.targetScopeHash ||
    packet.actionClass !== input.actionClass ||
    (packet.expiresAt && packet.expiresAt <= input.now)
  ) {
    throw new Error(
      'A current exact-scope approval is required for this resume grant.',
    );
  }
  return packet;
}

export function issueDurableResumeGrant(input: {
  workId: string;
  binding: DurableWorkBindingInput;
  actionClass: string;
  approvalPacketId?: string | null;
  approvalVersion?: number | null;
  inboundMessageId?: string | null;
  ttlMs?: number;
  now?: Date | string;
}): { token: string; grant: DurableResumeGrant } {
  const work = getDurableWorkUnit(input.workId);
  if (!work || !work.checkpointHeadId) {
    throw new Error('Durable work has no resumable checkpoint.');
  }
  const checkpoint = getDurableWorkCheckpoint(work.checkpointHeadId);
  if (!checkpoint || checkpoint.workId !== work.workId) {
    throw new Error(
      'Durable checkpoint does not belong to this work identity.',
    );
  }
  if (
    ![
      'ready',
      'awaiting_approval',
      'interrupted',
      'needs_replan',
      'verifying',
      'delivery_unverified',
    ].includes(work.status)
  ) {
    throw new Error(
      `Durable work in ${work.status} cannot receive a resume grant.`,
    );
  }
  const hashes = bindingHashes(input.binding);
  if (
    hashes.ownerScopeHash !== work.ownerScopeHash ||
    hashes.chatScopeHash !== work.chatScopeHash ||
    hashes.groupScopeHash !== work.groupScopeHash ||
    hashes.channel !== work.channel ||
    hashes.targetScopeHash !== work.targetScopeHash
  ) {
    throw new Error(
      'Resume grant scope does not match the durable work identity.',
    );
  }
  const now = iso(input.now);
  const actionClass = safeId(input.actionClass, 'action class');
  assertDurableActionClass(actionClass);
  let approval: CognitiveApprovalPacket | null = null;
  if (durableActionRequiresApproval(actionClass)) {
    if (!input.approvalPacketId || !input.approvalVersion) {
      throw new Error(
        'A resume token is not approval; fresh approval is required.',
      );
    }
    if (
      work.approvalPacketId !== input.approvalPacketId ||
      work.approvalVersion !== input.approvalVersion
    ) {
      throw new Error(
        'A current exact-scope approval is required for this resume grant.',
      );
    }
    approval = approvalForGrant({
      approvalPacketId: input.approvalPacketId,
      approvalVersion: input.approvalVersion,
      groupId: input.binding.groupId,
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      targetScopeHash: work.targetScopeHash,
      actionClass,
      now,
    });
  }
  const ttlMs = boundedTtl(input.ttlMs, DEFAULT_GRANT_TTL_MS, MAX_GRANT_TTL_MS);
  const token = randomBytes(32).toString('base64url');
  const grantId = `grant:${randomUUID()}`;
  const grant: DurableResumeGrant = {
    grantId,
    tokenHash: hashDurableResumeToken(token),
    workId: work.workId,
    checkpointId: checkpoint.durableCheckpointId,
    workVersion: work.version,
    planVersion: work.planVersion,
    ...hashes,
    actionClass,
    approvalPacketId: approval?.approvalPacketId || null,
    approvalVersion: approval?.approvalVersion || null,
    approvalScopeHash: approval?.scopeDigest || null,
    inboundMessageHash: input.inboundMessageId
      ? durableScopeHash('inbound-message', input.inboundMessageId)
      : null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    consumedAt: null,
    revokedAt: null,
    consumedLeaseId: null,
    privacyJson: privacyJson(),
  };
  insertDurableResumeGrant({
    grant,
    event: event({
      workId: work.workId,
      kind: 'grant_issued',
      createdAt: now,
      workVersion: work.version,
      planVersion: work.planVersion,
      summary: 'Issued one expiring, scoped, single-use resume grant.',
      refs: [grant.grantId, checkpoint.durableCheckpointId],
      nonce: grant.grantId,
    }),
  });
  return { token, grant };
}

export function consumeResumeGrantAndAcquireLease(input: {
  token: string;
  binding: DurableWorkBindingInput;
  actionClass: string;
  inboundMessageId?: string | null;
  workerId: string;
  processGeneration?: string;
  leaseTtlMs?: number;
  now?: Date | string;
}): ReturnType<typeof consumeDurableResumeGrantAtomic> {
  if (!input.token || input.token.length < 32 || input.token.length > 256) {
    return { status: 'not_found' };
  }
  const hashes = bindingHashes(input.binding);
  const now = iso(input.now);
  const leaseTtlMs = boundedTtl(
    input.leaseTtlMs,
    DEFAULT_LEASE_TTL_MS,
    MAX_LEASE_TTL_MS,
  );
  const tokenHash = hashDurableResumeToken(input.token);
  const grant = getDurableResumeGrantByTokenHash(tokenHash);
  const checkpoint = grant
    ? getDurableWorkCheckpoint(grant.checkpointId)
    : null;
  const hasUnknown = checkpoint
    ? checkpointIds(checkpoint.uncertainNodeIdsJson, 'uncertain node ID')
        .length > 0 ||
      listDurableEffectReceipts({ workId: checkpoint.workId, limit: 500 }).some(
        (receipt) =>
          ['started', 'partial', 'unknown'].includes(receipt.status) ||
          (!receipt.verificationFingerprint &&
            ['succeeded', 'failed'].includes(receipt.status)),
      )
    : false;
  const leaseId = `lease:${randomUUID()}`;
  const result = consumeDurableResumeGrantAtomic({
    tokenHash,
    ...hashes,
    actionClass: safeId(input.actionClass, 'action class'),
    inboundMessageHash: input.inboundMessageId
      ? durableScopeHash('inbound-message', input.inboundMessageId)
      : null,
    processGeneration: safeId(
      input.processGeneration || PROCESS_GENERATION,
      'process generation',
    ),
    workerScopeHash: durableScopeHash('worker', input.workerId),
    leaseId,
    now,
    leaseExpiresAt: new Date(Date.parse(now) + leaseTtlMs).toISOString(),
    resumeStatus: hasUnknown ? 'verifying' : 'executing',
    event: event({
      workId: grant?.workId || 'work:unknown',
      kind: 'grant_consumed',
      createdAt: now,
      workVersion: (grant?.workVersion || 0) + 1,
      planVersion: grant?.planVersion || 0,
      summary: hasUnknown
        ? 'Consumed the grant into verification-only recovery.'
        : 'Consumed the grant and acquired one execution lease.',
      refs: [grant?.grantId || '', leaseId].filter(Boolean),
      nonce: leaseId,
    }),
    beforeCommit: grant
      ? () =>
          emitBoundary(
            'after_lease_acquisition',
            grant.workId,
            grant.workVersion + 1,
          )
      : undefined,
  });
  return result;
}

export function recordDurableEffect(input: {
  workId: string;
  checkpointId: string;
  planVersion: number;
  nodeId: string;
  invocationId: string;
  actionClass: string;
  authorizationGrantId?: string | null;
  leaseId?: string | null;
  processGeneration?: string | null;
  leaseAssertionNow?: Date | string;
  effectClass: DurableEffectReceipt['effectClass'];
  status: DurableEffectReceipt['status'];
  targetScopeKey: string;
  preStateFingerprint?: string | null;
  postStateFingerprint?: string | null;
  verificationFingerprint?: string | null;
  metadata?: {
    receiptClass?: string;
    verificationClass?: string;
    resultCode?: string;
    idempotencyKeyHash?: string;
    source?: string;
  };
  now?: Date | string;
}): DurableEffectReceipt {
  if (Boolean(input.leaseId) !== Boolean(input.processGeneration)) {
    throw new Error(
      'Durable receipt lease assertion requires both lease and process generation.',
    );
  }
  const work = getDurableWorkUnit(input.workId);
  const checkpoint = getDurableWorkCheckpoint(input.checkpointId);
  if (
    !work ||
    !checkpoint ||
    checkpoint.workId !== work.workId ||
    input.planVersion !== work.planVersion ||
    checkpoint.planVersion !== work.planVersion
  ) {
    throw new Error(
      'Effect receipt does not match the current durable work scope.',
    );
  }
  const actionClass = safeId(input.actionClass, 'receipt action class');
  assertDurableActionEffectPolicy(actionClass, input.effectClass);
  const targetScopeHash = durableScopeHash('target', input.targetScopeKey);
  if (
    targetScopeHash !== work.targetScopeHash ||
    targetScopeHash !== checkpoint.targetScopeHash
  ) {
    throw new Error('Effect receipt target scope changed.');
  }
  const now = iso(input.now);
  const receiptId = `receipt:${createHash('sha256')
    .update(
      [
        work.workId,
        checkpoint.durableCheckpointId,
        input.planVersion,
        input.nodeId,
        input.invocationId,
        input.effectClass,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 32)}`;
  const existing = listDurableEffectReceipts({
    workId: work.workId,
    checkpointId: checkpoint.durableCheckpointId,
    limit: 1_000,
  }).find((candidate) => candidate.receiptId === receiptId);
  const mutationRequiresApproval =
    durableActionRequiresApproval(actionClass) ||
    ['repository_write', 'external_effect'].includes(input.effectClass);
  const grant =
    mutationRequiresApproval && !existing
      ? listDurableResumeGrants({ workId: work.workId, limit: 100 }).find(
          (candidate) =>
            candidate.status === 'consumed' &&
            (input.authorizationGrantId
              ? candidate.grantId === input.authorizationGrantId
              : candidate.consumedLeaseId === work.leaseId),
        ) || null
      : null;
  if (
    mutationRequiresApproval &&
    (!input.leaseId || !input.processGeneration)
  ) {
    throw new Error(
      'Durable mutating receipt requires an active bound lease generation.',
    );
  }
  if (existing && existing.actionClass !== actionClass) {
    throw new Error('Durable effect receipt action scope changed.');
  }
  if (
    mutationRequiresApproval &&
    !existing &&
    (!grant ||
      grant.workId !== work.workId ||
      grant.checkpointId !== checkpoint.durableCheckpointId ||
      grant.targetScopeHash !== targetScopeHash ||
      grant.actionClass !== actionClass ||
      !grantHasCurrentApproval(grant, now))
  ) {
    throw new Error(
      'Durable mutating receipt requires the consumed exact-scope approval grant.',
    );
  }
  const metadata = Object.fromEntries(
    Object.entries(input.metadata || {}).map(([key, value]) => [
      safeId(key, 'receipt metadata key'),
      value === undefined
        ? null
        : safeSummary(String(value), 'receipt metadata value'),
    ]),
  );
  const receipt: DurableEffectReceipt = {
    receiptId,
    workId: work.workId,
    checkpointId: checkpoint.durableCheckpointId,
    planVersion: work.planVersion,
    nodeId: safeId(input.nodeId, 'plan node ID'),
    invocationId: safeId(input.invocationId, 'invocation ID'),
    actionClass,
    effectClass: input.effectClass,
    status: input.status,
    targetScopeHash,
    grantId: existing?.grantId || grant?.grantId || null,
    approvalPacketId:
      existing?.approvalPacketId || grant?.approvalPacketId || null,
    approvalVersion:
      existing?.approvalVersion || grant?.approvalVersion || null,
    approvalScopeHash:
      existing?.approvalScopeHash || grant?.approvalScopeHash || null,
    preStateFingerprint: input.preStateFingerprint
      ? safeId(input.preStateFingerprint, 'pre-state fingerprint')
      : null,
    postStateFingerprint: input.postStateFingerprint
      ? safeId(input.postStateFingerprint, 'post-state fingerprint')
      : null,
    verificationFingerprint: input.verificationFingerprint
      ? safeId(input.verificationFingerprint, 'verification fingerprint')
      : null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    metadataJson: JSON.stringify(metadata),
    privacyJson: privacyJson(),
  };
  if (input.status === 'started') {
    emitBoundary('after_tool_start', work.workId, work.version);
  }
  const stored = upsertDurableEffectReceipt({
    receipt,
    leaseAssertion:
      input.leaseId && input.processGeneration
        ? {
            leaseId: safeId(input.leaseId, 'lease ID'),
            processGeneration: safeId(
              input.processGeneration,
              'process generation',
            ),
            now: iso(input.leaseAssertionNow, new Date(now)),
          }
        : undefined,
    event: event({
      workId: work.workId,
      kind: 'receipt',
      createdAt: now,
      workVersion: work.version,
      planVersion: work.planVersion,
      summary: `Recorded ${input.effectClass} receipt as ${input.status}.`,
      refs: [receiptId, checkpoint.durableCheckpointId, receipt.nodeId],
      nonce: `${receiptId}:${input.status}`,
    }),
  });
  if (input.status !== 'started') {
    emitBoundary('after_receipt_before_checkpoint', work.workId, work.version);
  }
  return stored;
}

export function releaseDurableLease(input: {
  leaseId: string;
  processGeneration?: string;
  now?: Date | string;
}): boolean {
  return releaseDurableWorkLease({
    leaseId: safeId(input.leaseId, 'lease ID'),
    processGeneration: safeId(
      input.processGeneration || PROCESS_GENERATION,
      'process generation',
    ),
    now: iso(input.now),
  });
}

export function revokeDurableGrant(input: {
  grantId: string;
  now?: Date | string;
}): boolean {
  return revokeDurableResumeGrant({
    grantId: safeId(input.grantId, 'grant ID'),
    now: iso(input.now),
  });
}

export function reconcileDurableWorkOnStartup(
  input: {
    processGeneration?: string;
    now?: Date | string;
  } = {},
): ReturnType<typeof reconcileExpiredDurableWorkLeases> {
  if (!isDatabaseInitialized()) {
    return {
      inspected: 0,
      expired: 0,
      interrupted: 0,
      verificationNeeded: 0,
      deliveryUnverified: 0,
      healthyLeaseSkipped: 0,
    };
  }
  return reconcileExpiredDurableWorkLeases({
    processGeneration: safeId(
      input.processGeneration || PROCESS_GENERATION,
      'process generation',
    ),
    now: iso(input.now),
  });
}

export interface DurableDecisionCandidateInput {
  action: DurableDecisionAction;
  evidenceIds?: string[];
  usefulness: number;
  successProbability: number;
  cost: number;
  latency: number;
  risk: number;
  reversibility: number;
  informationGain: number;
  approvalRequired?: boolean;
  toolHealth?: 'healthy' | 'degraded' | 'blocked' | 'unknown';
  verificationMethod: string;
  stopCondition: string;
}

export function chooseDurableAdaptiveDecision(input: {
  workId: string;
  checkpointId?: string | null;
  objectiveSummary: string;
  verifiedFactIds?: string[];
  assumptionIds?: string[];
  contradictionIds?: string[];
  staleSignalIds?: string[];
  missingSignalIds?: string[];
  candidates: DurableDecisionCandidateInput[];
  attemptLimit?: number;
  replanLimit?: number;
  costLimitUsd?: number;
  timeLimitMs?: number;
  now?: Date | string;
}): DurableAdaptiveDecision {
  if (input.candidates.length === 0 || input.candidates.length > 20) {
    throw new Error(
      'Durable decision requires one to twenty bounded candidates.',
    );
  }
  const stale = safeIds(input.staleSignalIds, 'stale signal ID');
  const missing = safeIds(input.missingSignalIds, 'missing signal ID');
  const contradictions = safeIds(input.contradictionIds, 'contradiction ID');
  const scored = input.candidates.map((candidate) => {
    const healthPenalty =
      candidate.toolHealth === 'blocked'
        ? 1
        : candidate.toolHealth === 'degraded'
          ? 0.3
          : candidate.toolHealth === 'unknown'
            ? 0.15
            : 0;
    let score =
      0.25 * candidate.usefulness +
      0.2 * candidate.successProbability +
      0.15 * candidate.informationGain +
      0.1 * candidate.reversibility -
      0.12 * candidate.risk -
      0.08 * candidate.cost -
      0.04 * candidate.latency -
      0.12 * healthPenalty -
      (candidate.approvalRequired ? 0.04 : 0);
    if ((stale.length || missing.length) && candidate.action === 'inspect')
      score += 0.35;
    if (contradictions.length && candidate.action === 'replan') score += 0.4;
    if (contradictions.length && candidate.action === 'execute') score -= 0.8;
    if (candidate.toolHealth === 'blocked' && candidate.action === 'execute')
      score -= 1;
    return { candidate, score: Math.max(-2, Math.min(2, score)) };
  });
  scored.sort((left, right) => right.score - left.score);
  const selected = scored[0]!;
  const now = iso(input.now);
  const confidence = Math.max(
    0,
    Math.min(1, 0.5 + selected.score / 2 - contradictions.length * 0.1),
  );
  return {
    decisionId: `durable:decision:${randomUUID()}`,
    workId: safeId(input.workId, 'work ID'),
    checkpointId: input.checkpointId
      ? safeId(input.checkpointId, 'checkpoint ID')
      : null,
    createdAt: now,
    selectedAction: selected.candidate.action,
    confidence,
    candidateScoresJson: JSON.stringify(
      scored.map(({ candidate, score }) => ({
        action: candidate.action,
        score,
      })),
    ),
    evidenceRefsJson: idsJson(
      [
        ...(input.verifiedFactIds || []),
        ...(selected.candidate.evidenceIds || []),
      ],
      'decision evidence ID',
    ),
    assumptionsJson: idsJson(input.assumptionIds, 'assumption ID'),
    contradictionIdsJson: JSON.stringify(contradictions),
    staleSignalIdsJson: JSON.stringify(stale),
    missingSignalIdsJson: JSON.stringify(missing),
    approvalRequired: selected.candidate.approvalRequired === true,
    verificationMethod: safeSummary(
      selected.candidate.verificationMethod,
      'verification method',
    ),
    stopCondition: safeSummary(
      selected.candidate.stopCondition,
      'stop condition',
    ),
    attemptLimit: Math.max(
      1,
      Math.min(10, Math.trunc(input.attemptLimit || 3)),
    ),
    replanLimit: Math.max(0, Math.min(5, Math.trunc(input.replanLimit || 2))),
    costLimitUsd: Math.max(0, Math.min(100, input.costLimitUsd || 0)),
    timeLimitMs: Math.max(
      100,
      Math.min(3_600_000, input.timeLimitMs || 60_000),
    ),
    summary: safeSummary(
      `${selected.candidate.action} selected for the highest evidence-adjusted usefulness under current risk and freshness constraints.`,
      'decision summary',
    ),
    privacyJson: privacyJson(),
  };
}

export function replanDurableWork(input: {
  workId: string;
  expectedVersion: number;
  preservedCompletedNodeIds: string[];
  reasonCode: string;
  nextAction: string;
  now?: Date | string;
}): DurableWorkUnit {
  const work = getDurableWorkUnit(input.workId);
  if (!work || work.version !== input.expectedVersion) {
    throw new Error('Durable work changed before replanning.');
  }
  if (!ALLOWED_TRANSITIONS[work.status].includes('planned')) {
    throw new Error(
      `Invalid durable work transition ${work.status} -> planned.`,
    );
  }
  safeIds(input.preservedCompletedNodeIds, 'preserved node ID');
  const reasonCode = safeId(input.reasonCode, 'replan reason');
  const now = iso(input.now);
  emitBoundary('during_replan', work.workId, work.version);
  const updated = transitionDurableWorkUnitCAS({
    workId: work.workId,
    expectedVersion: work.version,
    allowedFrom: [work.status],
    toStatus: 'planned',
    updatedAt: now,
    nextAction: safeSummary(input.nextAction, 'next action'),
    planVersion: work.planVersion + 1,
    invalidateApproval: true,
    event: event({
      workId: work.workId,
      kind: 'replanned',
      createdAt: now,
      fromStatus: work.status,
      toStatus: 'planned',
      workVersion: work.version + 1,
      planVersion: work.planVersion + 1,
      summary: `Replanned durable work because ${reasonCode}.`,
      refs: input.preservedCompletedNodeIds,
      nonce: randomUUID(),
    }),
  });
  if (!updated)
    throw new Error('Durable replan lost its compare-and-set race.');
  return updated;
}

const ALLOWED_DELIVERY_TRANSITIONS: Record<
  DurableWorkUnit['deliveryState'],
  DurableWorkUnit['deliveryState'][]
> = {
  not_started: ['pending', 'unknown'],
  pending: ['delivered', 'partial', 'unknown'],
  partial: ['delivered', 'unknown'],
  unknown: ['partial', 'delivered'],
  delivered: [],
};

/**
 * Advances delivery truth independently from execution truth. This deliberately
 * keeps the durable work status unchanged, so a verified completion can remain
 * complete while its reply is pending or uncertain.
 */
export function transitionDurableDeliveryState(input: {
  workId: string;
  expectedVersion: number;
  toState: DurableWorkUnit['deliveryState'];
  nextAction: string;
  now?: Date | string;
}): DurableWorkUnit {
  const work = getDurableWorkUnit(input.workId);
  if (!work || work.version !== input.expectedVersion) {
    throw new Error('Durable work changed before delivery-state transition.');
  }
  if (
    !ALLOWED_DELIVERY_TRANSITIONS[work.deliveryState].includes(input.toState)
  ) {
    throw new Error(
      `Invalid durable delivery transition ${work.deliveryState} -> ${input.toState}.`,
    );
  }
  const now = iso(input.now);
  const updated = transitionDurableWorkUnitCAS({
    workId: work.workId,
    expectedVersion: work.version,
    allowedFrom: [work.status],
    toStatus: work.status,
    updatedAt: now,
    nextAction: safeSummary(input.nextAction, 'delivery next action'),
    deliveryState: input.toState,
    event: event({
      workId: work.workId,
      kind: 'transition',
      createdAt: now,
      fromStatus: work.status,
      toStatus: work.status,
      workVersion: work.version + 1,
      planVersion: work.planVersion,
      summary: `Durable delivery advanced from ${work.deliveryState} to ${input.toState}.`,
      refs: [work.checkpointHeadId || ''].filter(Boolean),
      nonce: randomUUID(),
    }),
  });
  if (!updated) {
    throw new Error(
      'Durable delivery transition lost its compare-and-set race.',
    );
  }
  return updated;
}

type MaybePromise<T> = T | Promise<T>;

export interface DurableExecutionPlanNode {
  nodeId: string;
  position: number;
  actionClass: string;
  effectClass: DurableEffectReceipt['effectClass'];
  dependsOnNodeIds: string[];
  verificationRequirementIds?: string[];
}

export interface DurableExecutionPlan {
  planId: string;
  planVersion: number;
  nodes: DurableExecutionPlanNode[];
}

export interface DurableNodeRevalidation {
  dependencyState: 'fresh' | 'changed' | 'unknown';
  targetState: 'fresh' | 'changed' | 'unknown';
  preStateFingerprint?: string | null;
  freshSignalIds?: string[];
  staleSignalIds?: string[];
  missingSignalIds?: string[];
}

export interface DurableScopePreflight<TAuthorization = unknown> {
  authorization: TAuthorization;
  targetScopeHash: string;
  preStateFingerprint?: string | null;
  receiptIds?: string[];
}

export interface DurableScopeCompletion {
  postStateFingerprint?: string | null;
  receiptIds?: string[];
}

export interface DurableNodeExecutionResult {
  status: 'succeeded' | 'failed' | 'partial' | 'unknown';
  postStateFingerprint?: string | null;
}

export type DurableNodeVerification =
  | {
      status: 'verified';
      verificationFingerprint: string;
      postStateFingerprint: string;
      receiptIds?: string[];
    }
  | {
      status: 'failed' | 'unknown' | 'not_applied';
      verificationFingerprint?: string | null;
      postStateFingerprint?: string | null;
      receiptIds?: string[];
    };

export interface DurableReplanResult {
  pendingNodeIds: string[];
  dependencyIds?: string[];
  verificationRequirementIds?: string[];
  nextAction: string;
}

export interface DurableNodeOrchestrationCallbacks<TAuthorization = unknown> {
  loadPlan(input: {
    work: DurableWorkUnit;
    checkpoint: DurableWorkCheckpoint;
  }): MaybePromise<DurableExecutionPlan>;
  revalidateNode(input: {
    work: DurableWorkUnit;
    checkpoint: DurableWorkCheckpoint;
    node: DurableExecutionPlanNode;
    completedNodeIds: readonly string[];
  }): MaybePromise<DurableNodeRevalidation>;
  /**
   * A repository adapter should call RepositoryExecutionScope.preflightAction
   * here and retain its opaque authorization only in memory.
   */
  preflightScope?(input: {
    work: DurableWorkUnit;
    checkpoint: DurableWorkCheckpoint;
    node: DurableExecutionPlanNode;
    invocationId: string;
  }): MaybePromise<DurableScopePreflight<TAuthorization>>;
  executeNode(input: {
    work: DurableWorkUnit;
    checkpoint: DurableWorkCheckpoint;
    node: DurableExecutionPlanNode;
    invocationId: string;
    authorization?: TAuthorization;
  }): MaybePromise<DurableNodeExecutionResult>;
  /**
   * A repository adapter should call RepositoryExecutionScope.completeAction
   * here. Only receipt IDs and state fingerprints may cross this boundary.
   */
  completeScope?(input: {
    work: DurableWorkUnit;
    checkpoint: DurableWorkCheckpoint;
    node: DurableExecutionPlanNode;
    invocationId: string;
    authorization: TAuthorization;
    outcome: DurableNodeExecutionResult['status'];
  }): MaybePromise<DurableScopeCompletion>;
  /**
   * A repository adapter can call RepositoryExecutionScope.verifyPostState
   * here. Verification is also used to inspect effects left uncertain by a
   * prior process; it never authorizes replay.
   */
  verifyNode(input: {
    work: DurableWorkUnit;
    checkpoint: DurableWorkCheckpoint;
    node: DurableExecutionPlanNode;
    execution: DurableNodeExecutionResult;
    existingReceipt?: DurableEffectReceipt | null;
    recovery: boolean;
  }): MaybePromise<DurableNodeVerification>;
  replan?(input: {
    work: DurableWorkUnit;
    checkpoint: DurableWorkCheckpoint;
    reasonCode: string;
    preservedCompletedNodeIds: readonly string[];
    preservedUncertainNodeIds: readonly string[];
    nextPlanVersion: number;
  }): MaybePromise<DurableReplanResult>;
  /** External effects are denied unless this separate policy callback exists. */
  authorizeExternalEffect?(input: {
    work: DurableWorkUnit;
    checkpoint: DurableWorkCheckpoint;
    node: DurableExecutionPlanNode;
  }): MaybePromise<boolean>;
}

export type DurableNodeOrchestrationStatus =
  | 'node_completed'
  | 'work_completed'
  | 'replanned'
  | 'replan_required'
  | 'verification_required'
  | 'verification_failed'
  | 'approval_required'
  | 'external_effect_denied'
  | 'no_ready_node';

export interface DurableNodeOrchestrationResult {
  status: DurableNodeOrchestrationStatus;
  work: DurableWorkUnit;
  checkpoint: DurableWorkCheckpoint | null;
  nodeId: string | null;
  receipt: DurableEffectReceipt | null;
  executed: boolean;
  leaseReleased: boolean;
}

function checkpointIds(value: string, label: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error('invalid');
    }
    return safeIds(parsed, label);
  } catch (_error) {
    // Stored state is an untrusted metadata boundary. Do not attach the parse
    // error as a cause because its message can contain private row contents.
    // eslint-disable-next-line preserve-caught-error -- intentionally discard untrusted persisted JSON details
    throw new Error(`Invalid durable ${label} checkpoint state.`);
  }
}

function verifiedCompletedNodeReceiptIds(input: {
  work: DurableWorkUnit;
  completedNodeIds: readonly string[];
  referencedReceiptIds: readonly string[];
  targetScopeHash: string;
}): Map<string, string> {
  const completed = new Set(input.completedNodeIds);
  const referenced = new Set(input.referencedReceiptIds);
  const verified = new Map<string, string>();
  for (const receipt of listDurableEffectReceipts({
    workId: input.work.workId,
    limit: 1_000,
  })) {
    if (
      receipt.workId === input.work.workId &&
      receipt.planVersion === input.work.planVersion &&
      receipt.targetScopeHash === input.targetScopeHash &&
      referenced.has(receipt.receiptId) &&
      completed.has(receipt.nodeId) &&
      receipt.status === 'succeeded' &&
      Boolean(receipt.verificationFingerprint) &&
      Boolean(receipt.postStateFingerprint)
    ) {
      verified.set(receipt.nodeId, receipt.receiptId);
    }
  }
  return verified;
}

function assertCompletedNodeReceipts(input: {
  work: DurableWorkUnit;
  completedNodeIds: readonly string[];
  requiredNodeIds: readonly string[];
  referencedReceiptIds: readonly string[];
  targetScopeHash: string;
}): void {
  if (input.requiredNodeIds.length === 0) return;
  const verified = verifiedCompletedNodeReceiptIds(input);
  const missing = input.requiredNodeIds.filter(
    (nodeId) => !verified.has(nodeId),
  );
  if (missing.length > 0) {
    throw new Error(
      'Durable completed node requires a referenced same-work, same-plan, same-target receipt as verified terminal checkpoint proof.',
    );
  }
}

function validateExecutionPlan(
  plan: DurableExecutionPlan,
  work: DurableWorkUnit,
): DurableExecutionPlan {
  const planId = safeId(plan.planId, 'execution plan ID');
  if (plan.planVersion !== work.planVersion) {
    throw new Error('Durable execution plan version changed.');
  }
  if (work.planId && work.planId !== planId) {
    throw new Error('Durable execution plan identity changed.');
  }
  if (plan.nodes.length === 0 || plan.nodes.length > MAX_ID_COUNT) {
    throw new Error('Durable execution plan has an invalid node count.');
  }
  const nodeIds = plan.nodes.map((node) => safeId(node.nodeId, 'plan node ID'));
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new Error('Durable execution plan contains duplicate nodes.');
  }
  const nodes = plan.nodes.map((node) => {
    const actionClass = safeId(node.actionClass, 'node action class');
    assertDurableActionEffectPolicy(actionClass, node.effectClass);
    return {
      ...node,
      nodeId: safeId(node.nodeId, 'plan node ID'),
      actionClass,
      position: Math.max(0, Math.min(10_000, Math.trunc(node.position))),
      dependsOnNodeIds: safeIds(node.dependsOnNodeIds, 'node dependency ID'),
      verificationRequirementIds: safeIds(
        node.verificationRequirementIds,
        'node verification requirement ID',
      ),
    };
  });
  return { planId, planVersion: plan.planVersion, nodes };
}

function needsRepositoryScope(node: DurableExecutionPlanNode): boolean {
  return (
    node.effectClass === 'repository_write' ||
    /^repository_(?:read|state|write)$/.test(node.actionClass)
  );
}

function safeFingerprint(
  value: string | null | undefined,
  label: string,
): string | null {
  return value ? safeId(value, label) : null;
}

function normalizeNodeVerification(
  value: DurableNodeVerification,
): DurableNodeVerification {
  if (value.status !== 'verified') return value;
  const verificationFingerprint = safeFingerprint(
    value.verificationFingerprint,
    'verification fingerprint',
  );
  const postStateFingerprint = safeFingerprint(
    value.postStateFingerprint,
    'verified post-state fingerprint',
  );
  if (!verificationFingerprint || !postStateFingerprint) {
    return { status: 'unknown' };
  }
  return {
    status: 'verified',
    verificationFingerprint,
    postStateFingerprint,
    receiptIds: safeIds(value.receiptIds, 'verification receipt ID'),
  };
}

function grantHasCurrentApproval(
  grant: DurableResumeGrant,
  now: string,
): boolean {
  if (
    !grant.approvalPacketId ||
    !grant.approvalVersion ||
    !grant.approvalScopeHash
  ) {
    return false;
  }
  const packet = listCognitiveApprovalPackets({ limit: 1_000 }).find(
    (candidate) => candidate.approvalPacketId === grant.approvalPacketId,
  );
  return Boolean(
    packet &&
    packet.status === 'approved' &&
    packet.actionClass === grant.actionClass &&
    packet.approvalVersion === grant.approvalVersion &&
    packet.scopeDigest === grant.approvalScopeHash &&
    packet.durableWorkId === grant.workId &&
    packet.durableCheckpointId === grant.checkpointId &&
    packet.planVersion === grant.planVersion &&
    packet.targetScopeDigest === grant.targetScopeHash &&
    packet.actionClass === grant.actionClass &&
    (!packet.expiresAt || packet.expiresAt > now),
  );
}

class DurableLeaseBoundaryError extends Error {
  constructor() {
    super(
      'Durable execution requires an unexpired active bound lease generation.',
    );
    this.name = 'DurableLeaseBoundaryError';
  }
}

function isDurableLeaseBoundaryError(
  error: unknown,
): error is DurableLeaseBoundaryError {
  return error instanceof DurableLeaseBoundaryError;
}

/**
 * Executes at most one dependency-ready node under an already acquired durable
 * lease. Every effect receives a started receipt before invocation. Unknown
 * effects are verified, never replayed. The lease is released on every exit.
 */
export async function orchestrateNextDurableNode<
  TAuthorization = unknown,
>(input: {
  workId: string;
  leaseId: string;
  processGeneration?: string;
  executorScopeKey: string;
  targetScopeKey: string;
  callbacks: DurableNodeOrchestrationCallbacks<TAuthorization>;
  now?: Date | string;
}): Promise<DurableNodeOrchestrationResult> {
  const now = iso(input.now);
  const processGeneration = safeId(
    input.processGeneration || PROCESS_GENERATION,
    'process generation',
  );
  const initialWork = getDurableWorkUnit(input.workId);
  const initialLease = getDurableWorkLease(input.leaseId);
  if (
    !initialWork ||
    initialWork.leaseId !== input.leaseId ||
    !initialLease ||
    initialLease.workId !== initialWork.workId ||
    initialLease.status !== 'active' ||
    initialLease.processGeneration !== processGeneration ||
    initialLease.expiresAt <= now ||
    initialWork.leaseExpiresAt !== initialLease.expiresAt ||
    !['executing', 'verifying'].includes(initialWork.status)
  ) {
    throw new DurableLeaseBoundaryError();
  }
  const head = initialWork.checkpointHeadId
    ? getDurableWorkCheckpoint(initialWork.checkpointHeadId)
    : null;
  if (!head || head.workId !== initialWork.workId) {
    throw new Error('Durable execution requires the current checkpoint.');
  }
  if (
    head.planVersion !== initialWork.planVersion ||
    head.targetScopeHash !== durableScopeHash('target', input.targetScopeKey) ||
    head.executorScopeHash !==
      durableScopeHash('executor', input.executorScopeKey)
  ) {
    throw new Error('Durable execution scope changed before orchestration.');
  }
  const consumedGrant = listDurableResumeGrants({
    workId: initialWork.workId,
    limit: 100,
  }).find(
    (grant) =>
      grant.status === 'consumed' && grant.consumedLeaseId === input.leaseId,
  );
  if (!consumedGrant) {
    throw new Error('Durable execution lease has no consumed scoped grant.');
  }
  if (
    consumedGrant.workId !== initialWork.workId ||
    consumedGrant.checkpointId !== head.durableCheckpointId ||
    consumedGrant.planVersion !== initialWork.planVersion ||
    consumedGrant.targetScopeHash !== initialWork.targetScopeHash
  ) {
    throw new Error('Durable execution grant binding changed.');
  }
  const logicalStartMs = Date.parse(now);
  const wallStartMs = Date.now();
  const leaseTtlMs = Math.max(
    1,
    Math.min(
      MAX_LEASE_TTL_MS,
      Date.parse(initialLease.expiresAt) - Date.parse(initialLease.acquiredAt),
    ),
  );
  const leaseNow = (): string =>
    new Date(
      logicalStartMs + Math.max(0, Date.now() - wallStartMs),
    ).toISOString();
  const renewLease = (): void => {
    const heartbeatAt = leaseNow();
    const renewed = heartbeatDurableWorkLease({
      leaseId: input.leaseId,
      processGeneration,
      now: heartbeatAt,
      expiresAt: new Date(Date.parse(heartbeatAt) + leaseTtlMs).toISOString(),
    });
    if (!renewed) throw new DurableLeaseBoundaryError();
  };
  const withLeaseHeartbeat = async <T>(
    callback: () => MaybePromise<T>,
  ): Promise<T> => {
    renewLease();
    let leaseLost = false;
    const intervalMs = Math.max(
      10,
      Math.min(10_000, Math.floor(leaseTtlMs / 3)),
    );
    const heartbeat = setInterval(() => {
      if (leaseLost) return;
      try {
        renewLease();
      } catch {
        leaseLost = true;
      }
    }, intervalMs);
    heartbeat.unref?.();
    let value: T | undefined;
    let callbackFailure: unknown;
    try {
      value = await callback();
    } catch (error) {
      callbackFailure = error;
    } finally {
      clearInterval(heartbeat);
    }
    if (!leaseLost) {
      try {
        renewLease();
      } catch {
        leaseLost = true;
      }
    }
    if (leaseLost) throw new DurableLeaseBoundaryError();
    if (callbackFailure) throw callbackFailure;
    return value as T;
  };
  let outcome: Omit<DurableNodeOrchestrationResult, 'leaseReleased'> | null =
    null;
  let failure: unknown;

  const run = async (): Promise<
    Omit<DurableNodeOrchestrationResult, 'leaseReleased'>
  > => {
    let work = getDurableWorkUnit(initialWork.workId)!;
    const checkpoint = getDurableWorkCheckpoint(head.durableCheckpointId)!;
    const completed = checkpointIds(
      checkpoint.completedNodeIdsJson,
      'completed node ID',
    );
    const pending = checkpointIds(
      checkpoint.pendingNodeIdsJson,
      'pending node ID',
    );
    const uncertain = checkpointIds(
      checkpoint.uncertainNodeIdsJson,
      'uncertain node ID',
    );
    const priorReceiptIds = checkpointIds(
      checkpoint.receiptIdsJson,
      'receipt ID',
    );
    const priorRequirements = checkpointIds(
      checkpoint.verificationRequirementsJson,
      'verification requirement ID',
    );
    const requestReplan = async (
      currentWork: DurableWorkUnit,
      currentCheckpoint: DurableWorkCheckpoint,
      reasonCode: string,
    ): Promise<Omit<DurableNodeOrchestrationResult, 'leaseReleased'>> => {
      renewLease();
      const safeReason = safeId(reasonCode, 'replan reason');
      if (!ALLOWED_TRANSITIONS[currentWork.status].includes('needs_replan')) {
        throw new Error(
          `Invalid durable work transition ${currentWork.status} -> needs_replan.`,
        );
      }
      const markNeedsReplan = () =>
        transitionDurableWork({
          workId: currentWork.workId,
          expectedVersion: currentWork.version,
          toStatus: 'needs_replan',
          nextAction: 'Rebuild the bounded plan before executing another node.',
          now,
        });
      if (!input.callbacks.replan) {
        const replanning = markNeedsReplan();
        return {
          status: 'replan_required',
          work: replanning,
          checkpoint: currentCheckpoint,
          nodeId: null,
          receipt: null,
          executed: false,
        };
      }
      let revised: DurableReplanResult;
      try {
        revised = await withLeaseHeartbeat(() =>
          input.callbacks.replan!({
            work: currentWork,
            checkpoint: currentCheckpoint,
            reasonCode: safeReason,
            preservedCompletedNodeIds: completed,
            preservedUncertainNodeIds: uncertain,
            nextPlanVersion: currentWork.planVersion + 1,
          }),
        );
        // Replanner failures are converted to an explicit fail-closed state;
        // callback error bodies are never persisted.
      } catch (error) {
        if (isDurableLeaseBoundaryError(error)) throw error;
        const replanning = markNeedsReplan();
        return {
          status: 'replan_required',
          work: replanning,
          checkpoint: currentCheckpoint,
          nodeId: null,
          receipt: null,
          executed: false,
        };
      }
      const revisedPending = safeIds(
        revised.pendingNodeIds,
        'replanned pending node ID',
      ).filter((nodeId) => !completed.includes(nodeId));
      renewLease();
      let replanning = markNeedsReplan();
      replanning = replanDurableWork({
        workId: replanning.workId,
        expectedVersion: replanning.version,
        preservedCompletedNodeIds: completed,
        reasonCode: safeReason,
        nextAction: revised.nextAction,
        now,
      });
      const committed = commitDurableCheckpointCAS({
        workId: replanning.workId,
        expectedWorkVersion: replanning.version,
        completedNodeIds: completed,
        pendingNodeIds: revisedPending,
        uncertainNodeIds: uncertain,
        dependencyIds: revised.dependencyIds,
        worldSignals: { fresh: [], stale: [safeReason], missing: [] },
        executorScopeKey: input.executorScopeKey,
        targetScopeKey: input.targetScopeKey,
        preStateFingerprint: currentCheckpoint.preStateFingerprint,
        receiptIds: priorReceiptIds,
        verificationRequirementIds: revised.verificationRequirementIds,
        retryBudget: currentCheckpoint.retryBudget,
        attemptsUsed: currentCheckpoint.attemptsUsed,
        stopConditionIds: checkpointIds(
          currentCheckpoint.stopConditionsJson,
          'stop condition ID',
        ),
        recoveryPolicy: 'inspect_then_resume',
        nextSafeAction: revised.nextAction,
        now,
      });
      const ready = transitionDurableWork({
        workId: committed.work.workId,
        expectedVersion: committed.work.version,
        toStatus: 'ready',
        nextAction: revised.nextAction,
        now,
      });
      return {
        status: 'replanned',
        work: ready,
        checkpoint: committed.checkpoint,
        nodeId: null,
        receipt: null,
        executed: false,
      };
    };

    let plan: DurableExecutionPlan;
    try {
      plan = validateExecutionPlan(
        await withLeaseHeartbeat(() =>
          input.callbacks.loadPlan({ work, checkpoint }),
        ),
        work,
      );
      // Invalid or unavailable plan providers must trigger bounded replanning
      // without persisting provider error details.
    } catch (error) {
      if (isDurableLeaseBoundaryError(error)) throw error;
      return requestReplan(work, checkpoint, 'plan_unavailable');
    }
    const nodeById = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    const receipts = listDurableEffectReceipts({
      workId: work.workId,
      limit: 1_000,
    }).filter((receipt) => receipt.planVersion === work.planVersion);

    if (pending.length === 0 && uncertain.length === 0) {
      renewLease();
      if (work.status === 'executing') {
        work = transitionDurableWork({
          workId: work.workId,
          expectedVersion: work.version,
          toStatus: 'verifying',
          nextAction: 'Confirm the terminal checkpoint.',
          now,
        });
      }
      const referencedReceiptIds = new Set(priorReceiptIds);
      const terminalReceipt = receipts.find(
        (receipt) =>
          referencedReceiptIds.has(receipt.receiptId) &&
          receipt.status === 'succeeded' &&
          Boolean(receipt.verificationFingerprint) &&
          Boolean(receipt.postStateFingerprint) &&
          receipt.postStateFingerprint ===
            checkpoint.verifiedPostStateFingerprint,
      );
      if (
        checkpoint.status !== 'completed' ||
        !checkpoint.verifiedPostStateFingerprint ||
        !terminalReceipt
      ) {
        return {
          status: 'verification_required',
          work,
          checkpoint,
          nodeId: null,
          receipt: null,
          executed: false,
        };
      }
      const completedWork = transitionDurableWork({
        workId: work.workId,
        expectedVersion: work.version,
        toStatus: 'completed',
        nextAction: 'Await delivery and owner outcome review.',
        deliveryState: 'pending',
        now,
      });
      return {
        status: 'work_completed',
        work: completedWork,
        checkpoint,
        nodeId: null,
        receipt: null,
        executed: false,
      };
    }
    const unresolvedReceipts = [...receipts]
      .reverse()
      .filter(
        (receipt) =>
          ['started', 'partial', 'unknown'].includes(receipt.status) ||
          (['succeeded', 'failed'].includes(receipt.status) &&
            !receipt.verificationFingerprint),
      );
    const recoveryNodeId =
      uncertain[0] || unresolvedReceipts[0]?.nodeId || null;
    const unresolvedReceipt = recoveryNodeId
      ? unresolvedReceipts.find((receipt) => receipt.nodeId === recoveryNodeId)
      : undefined;

    let node: DurableExecutionPlanNode | undefined;
    if (recoveryNodeId) {
      node = nodeById.get(recoveryNodeId);
      if (!node) {
        return {
          status: 'verification_required',
          work,
          checkpoint,
          nodeId: recoveryNodeId,
          receipt: unresolvedReceipt || null,
          executed: false,
        };
      }
    } else {
      for (const pendingNodeId of pending) {
        const candidate = nodeById.get(pendingNodeId);
        if (!candidate)
          return requestReplan(work, checkpoint, 'unknown_plan_node');
        const unknownDependency = candidate.dependsOnNodeIds.some(
          (dependencyId) =>
            !completed.includes(dependencyId) &&
            !pending.includes(dependencyId) &&
            !uncertain.includes(dependencyId),
        );
        if (unknownDependency) {
          return requestReplan(work, checkpoint, 'unknown_dependency');
        }
        if (
          candidate.dependsOnNodeIds.every((dependencyId) =>
            completed.includes(dependencyId),
          )
        ) {
          node = candidate;
          break;
        }
      }
      if (!node) return requestReplan(work, checkpoint, 'dependency_deadlock');
    }

    let revalidation: DurableNodeRevalidation;
    try {
      revalidation = await withLeaseHeartbeat(() =>
        input.callbacks.revalidateNode({
          work,
          checkpoint,
          node,
          completedNodeIds: completed,
        }),
      );
      // Revalidation failure is evidence of unknown state, not permission to
      // execute. Suppress callback details at this metadata boundary.
    } catch (error) {
      if (isDurableLeaseBoundaryError(error)) throw error;
      revalidation = { dependencyState: 'unknown', targetState: 'unknown' };
    }
    if (
      revalidation.dependencyState !== 'fresh' ||
      revalidation.targetState !== 'fresh'
    ) {
      renewLease();
      if (recoveryNodeId) {
        if (work.status === 'executing') {
          work = transitionDurableWork({
            workId: work.workId,
            expectedVersion: work.version,
            toStatus: 'verifying',
            nextAction:
              'Verify the uncertain effect against the changed scope.',
            now,
          });
        }
        const failed = transitionDurableWork({
          workId: work.workId,
          expectedVersion: work.version,
          toStatus:
            node.effectClass === 'external_effect'
              ? 'delivery_unverified'
              : 'verification_failed',
          nextAction: 'Resolve changed or unknown scope before any retry.',
          now,
        });
        return {
          status: 'verification_required',
          work: failed,
          checkpoint,
          nodeId: node.nodeId,
          receipt: unresolvedReceipt || null,
          executed: false,
        };
      }
      const reason =
        revalidation.dependencyState === 'changed'
          ? 'dependency_changed'
          : revalidation.dependencyState === 'unknown'
            ? 'dependency_unknown'
            : revalidation.targetState === 'changed'
              ? 'target_changed'
              : 'target_unknown';
      return requestReplan(work, checkpoint, reason);
    }

    const finishVerifiedNode = (
      currentWork: DurableWorkUnit,
      receipt: DurableEffectReceipt,
      verification: DurableNodeVerification,
      executed: boolean,
      scopeReceiptIds: string[],
    ): Omit<DurableNodeOrchestrationResult, 'leaseReleased'> => {
      renewLease();
      const nextCompleted = [...new Set([...completed, node!.nodeId])];
      const nextPending = pending.filter((nodeId) => nodeId !== node!.nodeId);
      const nextUncertain = uncertain.filter(
        (nodeId) => nodeId !== node!.nodeId,
      );
      const hasRemainingWork =
        nextPending.length > 0 || nextUncertain.length > 0;
      const nextSafeAction = nextUncertain.length
        ? 'Verify the remaining uncertain effect before any retry.'
        : nextPending.length
          ? 'Resume only the next dependency-ready plan node.'
          : 'Complete after the verified terminal checkpoint.';
      const committed = commitDurableCheckpointCAS({
        workId: currentWork.workId,
        expectedWorkVersion: currentWork.version,
        completedNodeIds: nextCompleted,
        pendingNodeIds: nextPending,
        uncertainNodeIds: nextUncertain,
        dependencyIds: plan.nodes.flatMap((entry) => entry.dependsOnNodeIds),
        worldSignals: {
          fresh: revalidation.freshSignalIds,
          stale: revalidation.staleSignalIds,
          missing: revalidation.missingSignalIds,
        },
        executorScopeKey: input.executorScopeKey,
        targetScopeKey: input.targetScopeKey,
        preStateFingerprint:
          receipt.preStateFingerprint || revalidation.preStateFingerprint,
        verifiedPostStateFingerprint:
          verification.postStateFingerprint || receipt.postStateFingerprint,
        receiptIds: [
          ...priorReceiptIds,
          receipt.receiptId,
          ...scopeReceiptIds,
          ...(verification.receiptIds || []),
        ],
        verificationRequirementIds: [
          ...priorRequirements,
          ...(node!.verificationRequirementIds || []),
        ],
        retryBudget: checkpoint.retryBudget,
        attemptsUsed: checkpoint.attemptsUsed + (executed ? 1 : 0),
        stopConditionIds: checkpointIds(
          checkpoint.stopConditionsJson,
          'stop condition ID',
        ),
        recoveryPolicy: 'inspect_then_resume',
        nextSafeAction,
        status: hasRemainingWork ? 'open' : 'completed',
        now,
      });
      emitBoundary(
        'after_verification_before_completion',
        committed.work.workId,
        committed.work.version,
      );
      const finalWork = transitionDurableWork({
        workId: committed.work.workId,
        expectedVersion: committed.work.version,
        toStatus: hasRemainingWork ? 'ready' : 'completed',
        nextAction: hasRemainingWork
          ? nextSafeAction
          : 'Await delivery and owner outcome review.',
        deliveryState: hasRemainingWork ? undefined : 'pending',
        now,
      });
      return {
        status: hasRemainingWork ? 'node_completed' : 'work_completed',
        work: finalWork,
        checkpoint: committed.checkpoint,
        nodeId: node!.nodeId,
        receipt,
        executed,
      };
    };

    const persistUncertain = (
      currentWork: DurableWorkUnit,
      receipt: DurableEffectReceipt,
      verification: DurableNodeVerification,
      executed: boolean,
      scopeReceiptIds: string[],
    ): Omit<DurableNodeOrchestrationResult, 'leaseReleased'> => {
      renewLease();
      const nextUncertain = [...new Set([...uncertain, node!.nodeId])];
      const nextPending = pending.filter(
        (pendingNodeId) => pendingNodeId !== node!.nodeId,
      );
      const committed = commitDurableCheckpointCAS({
        workId: currentWork.workId,
        expectedWorkVersion: currentWork.version,
        completedNodeIds: completed,
        pendingNodeIds: nextPending,
        uncertainNodeIds: nextUncertain,
        dependencyIds: plan.nodes.flatMap((entry) => entry.dependsOnNodeIds),
        worldSignals: {
          fresh: revalidation.freshSignalIds,
          stale: revalidation.staleSignalIds,
          missing: revalidation.missingSignalIds,
        },
        executorScopeKey: input.executorScopeKey,
        targetScopeKey: input.targetScopeKey,
        preStateFingerprint:
          receipt.preStateFingerprint || revalidation.preStateFingerprint,
        receiptIds: [
          ...priorReceiptIds,
          receipt.receiptId,
          ...scopeReceiptIds,
          ...(verification.receiptIds || []),
        ],
        verificationRequirementIds: [
          ...priorRequirements,
          ...(node!.verificationRequirementIds || []),
        ],
        retryBudget: checkpoint.retryBudget,
        attemptsUsed: checkpoint.attemptsUsed + (executed ? 1 : 0),
        stopConditionIds: checkpointIds(
          checkpoint.stopConditionsJson,
          'stop condition ID',
        ),
        recoveryPolicy:
          node!.effectClass === 'external_effect'
            ? 'verify_unknown_effect'
            : 'inspect_then_resume',
        nextSafeAction: 'Verify the uncertain effect before any retry.',
        status: 'verification_needed',
        now,
      });
      const finalWork = transitionDurableWork({
        workId: committed.work.workId,
        expectedVersion: committed.work.version,
        toStatus:
          node!.effectClass === 'external_effect'
            ? 'delivery_unverified'
            : 'verification_failed',
        nextAction: 'Verify the uncertain effect before any retry.',
        now,
      });
      return {
        status:
          verification.status === 'failed'
            ? 'verification_failed'
            : 'verification_required',
        work: finalWork,
        checkpoint: committed.checkpoint,
        nodeId: node!.nodeId,
        receipt,
        executed,
      };
    };

    if (node.actionClass !== consumedGrant.actionClass) {
      return requestReplan(work, checkpoint, 'action_scope_changed');
    }
    if (recoveryNodeId) {
      if (work.status === 'executing') {
        work = transitionDurableWork({
          workId: work.workId,
          expectedVersion: work.version,
          toStatus: 'verifying',
          nextAction: 'Verify the uncertain effect without replaying it.',
          now,
        });
      }
      let verification: DurableNodeVerification;
      try {
        verification = normalizeNodeVerification(
          await withLeaseHeartbeat(() =>
            input.callbacks.verifyNode({
              work,
              checkpoint,
              node,
              execution: { status: 'unknown' },
              existingReceipt: unresolvedReceipt || null,
              recovery: true,
            }),
          ),
        );
        // Recovery verification failures remain unknown and must never cause
        // effect replay.
      } catch (error) {
        if (isDurableLeaseBoundaryError(error)) throw error;
        verification = { status: 'unknown' };
      }
      // Recovery is a new verification attempt, never a replay or mutation of
      // the original invocation receipt. Bind it to the current checkpoint so
      // every recovery attempt retains immutable provenance.
      const invocationId = `invoke:${createHash('sha256')
        .update(
          `${work.workId}|${checkpoint.durableCheckpointId}|${work.planVersion}|${node.nodeId}|recovery`,
        )
        .digest('hex')
        .slice(0, 32)}`;
      const terminalReceipt =
        unresolvedReceipt &&
        ['succeeded', 'failed'].includes(unresolvedReceipt.status)
          ? unresolvedReceipt
          : null;
      const receipt =
        terminalReceipt && verification.status !== 'verified'
          ? terminalReceipt
          : recordDurableEffect({
              workId: work.workId,
              checkpointId: checkpoint.durableCheckpointId,
              planVersion: work.planVersion,
              nodeId: node.nodeId,
              invocationId,
              actionClass: node.actionClass,
              authorizationGrantId: consumedGrant.grantId,
              leaseId: input.leaseId,
              processGeneration,
              leaseAssertionNow: leaseNow(),
              effectClass: node.effectClass,
              status: terminalReceipt
                ? terminalReceipt.status
                : verification.status === 'verified'
                  ? 'succeeded'
                  : verification.status === 'not_applied'
                    ? 'failed'
                    : unresolvedReceipt?.status === 'partial'
                      ? 'partial'
                      : 'unknown',
              targetScopeKey: input.targetScopeKey,
              preStateFingerprint:
                unresolvedReceipt?.preStateFingerprint ||
                revalidation.preStateFingerprint,
              postStateFingerprint: verification.postStateFingerprint,
              verificationFingerprint:
                verification.status === 'verified'
                  ? verification.verificationFingerprint
                  : null,
              now,
            });
      if (verification.status === 'verified') {
        return finishVerifiedNode(work, receipt, verification, false, []);
      }
      if (verification.status === 'not_applied') {
        return requestReplan(work, checkpoint, 'effect_not_applied');
      }
      return persistUncertain(work, receipt, verification, false, []);
    }

    if (checkpoint.attemptsUsed >= checkpoint.retryBudget) {
      return requestReplan(work, checkpoint, 'retry_budget_exhausted');
    }
    if (
      (durableActionRequiresApproval(node.actionClass) ||
        node.effectClass === 'repository_write' ||
        node.effectClass === 'external_effect') &&
      !grantHasCurrentApproval(consumedGrant, now)
    ) {
      renewLease();
      const blocked = transitionDurableWork({
        workId: work.workId,
        expectedVersion: work.version,
        toStatus: 'blocked',
        nextAction: 'Obtain fresh exact approval for the bounded mutation.',
        now,
      });
      return {
        status: 'approval_required',
        work: blocked,
        checkpoint,
        nodeId: node.nodeId,
        receipt: null,
        executed: false,
      };
    }
    if (node.effectClass === 'external_effect') {
      const authorized = input.callbacks.authorizeExternalEffect
        ? await withLeaseHeartbeat(() =>
            input.callbacks.authorizeExternalEffect!({
              work,
              checkpoint,
              node,
            }),
          )
        : false;
      if (!authorized) {
        renewLease();
        const blocked = transitionDurableWork({
          workId: work.workId,
          expectedVersion: work.version,
          toStatus: 'blocked',
          nextAction:
            'Obtain fresh exact authorization for the external effect.',
          now,
        });
        return {
          status: 'external_effect_denied',
          work: blocked,
          checkpoint,
          nodeId: node.nodeId,
          receipt: null,
          executed: false,
        };
      }
    }

    const invocationId = `invoke:${createHash('sha256')
      .update(
        `${work.workId}|${checkpoint.durableCheckpointId}|${work.planVersion}|${node.nodeId}|${checkpoint.attemptsUsed + 1}`,
      )
      .digest('hex')
      .slice(0, 32)}`;
    let authorization: TAuthorization | undefined;
    let preStateFingerprint = revalidation.preStateFingerprint || null;
    let scopeReceiptIds: string[] = [];
    if (needsRepositoryScope(node)) {
      if (!input.callbacks.preflightScope || !input.callbacks.completeScope) {
        return requestReplan(work, checkpoint, 'repository_scope_unavailable');
      }
      let scoped: DurableScopePreflight<TAuthorization>;
      try {
        scoped = await withLeaseHeartbeat(() =>
          input.callbacks.preflightScope!({
            work,
            checkpoint,
            node,
            invocationId,
          }),
        );
        // Scope adapters may contain host paths in errors; convert them to a
        // bounded target-unknown replan reason.
      } catch (error) {
        if (isDurableLeaseBoundaryError(error)) throw error;
        return requestReplan(work, checkpoint, 'target_unknown');
      }
      if (scoped.targetScopeHash !== work.targetScopeHash) {
        return requestReplan(work, checkpoint, 'target_changed');
      }
      authorization = scoped.authorization;
      preStateFingerprint =
        safeFingerprint(
          scoped.preStateFingerprint,
          'scope pre-state fingerprint',
        ) || preStateFingerprint;
      scopeReceiptIds = safeIds(scoped.receiptIds, 'scope receipt ID');
    }

    emitBoundary('before_tool_invocation', work.workId, work.version);
    let receipt = recordDurableEffect({
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: node.nodeId,
      invocationId,
      actionClass: node.actionClass,
      authorizationGrantId: consumedGrant.grantId,
      leaseId: input.leaseId,
      processGeneration,
      leaseAssertionNow: leaseNow(),
      effectClass: node.effectClass,
      status: 'started',
      targetScopeKey: input.targetScopeKey,
      preStateFingerprint,
      now,
    });
    let execution: DurableNodeExecutionResult;
    try {
      execution = await withLeaseHeartbeat(() =>
        input.callbacks.executeNode({
          work,
          checkpoint,
          node,
          invocationId,
          authorization,
        }),
      );
      // Once invocation begins, any thrown executor error leaves the effect
      // unknown until verification proves otherwise.
    } catch (error) {
      if (isDurableLeaseBoundaryError(error)) throw error;
      execution = { status: 'unknown' };
    }
    let scopeCompletion: DurableScopeCompletion = {};
    if (needsRepositoryScope(node) && input.callbacks.completeScope) {
      try {
        scopeCompletion = await withLeaseHeartbeat(() =>
          input.callbacks.completeScope!({
            work,
            checkpoint,
            node,
            invocationId,
            authorization: authorization!,
            outcome: execution.status,
          }),
        );
        // A missing scope receipt makes execution unknown; adapter error
        // details cannot cross the metadata-only boundary.
      } catch (error) {
        if (isDurableLeaseBoundaryError(error)) throw error;
        execution = { status: 'unknown' };
      }
    }
    scopeReceiptIds = [
      ...scopeReceiptIds,
      ...safeIds(scopeCompletion.receiptIds, 'scope receipt ID'),
    ];
    const postStateFingerprint =
      safeFingerprint(
        scopeCompletion.postStateFingerprint,
        'scope post-state fingerprint',
      ) ||
      safeFingerprint(execution.postStateFingerprint, 'post-state fingerprint');
    receipt = recordDurableEffect({
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: node.nodeId,
      invocationId,
      actionClass: node.actionClass,
      authorizationGrantId: consumedGrant.grantId,
      leaseId: input.leaseId,
      processGeneration,
      leaseAssertionNow: leaseNow(),
      effectClass: node.effectClass,
      status: execution.status === 'unknown' ? 'unknown' : 'partial',
      targetScopeKey: input.targetScopeKey,
      preStateFingerprint,
      postStateFingerprint,
      now,
    });
    renewLease();
    work = transitionDurableWork({
      workId: work.workId,
      expectedVersion: work.version,
      toStatus: 'verifying',
      nextAction: 'Verify the bounded node result before checkpointing it.',
      now,
    });
    if (node.effectClass !== 'read_only') {
      emitBoundary(
        'after_final_write_before_verification',
        work.workId,
        work.version,
      );
    }
    let verification: DurableNodeVerification;
    try {
      verification = normalizeNodeVerification(
        await withLeaseHeartbeat(() =>
          input.callbacks.verifyNode({
            work,
            checkpoint,
            node,
            execution,
            existingReceipt: receipt,
            recovery: false,
          }),
        ),
      );
      // Verifier failure is represented as unknown and cannot authorize
      // checkpoint completion.
    } catch (error) {
      if (isDurableLeaseBoundaryError(error)) throw error;
      verification = { status: 'unknown' };
    }
    receipt = recordDurableEffect({
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: node.nodeId,
      invocationId,
      actionClass: node.actionClass,
      authorizationGrantId: consumedGrant.grantId,
      leaseId: input.leaseId,
      processGeneration,
      leaseAssertionNow: leaseNow(),
      effectClass: node.effectClass,
      status:
        verification.status === 'verified'
          ? 'succeeded'
          : verification.status === 'not_applied'
            ? 'failed'
            : verification.status === 'failed'
              ? 'failed'
              : receipt.status === 'partial'
                ? 'partial'
                : 'unknown',
      targetScopeKey: input.targetScopeKey,
      preStateFingerprint,
      postStateFingerprint:
        verification.postStateFingerprint || postStateFingerprint,
      verificationFingerprint:
        verification.status === 'verified'
          ? verification.verificationFingerprint
          : null,
      now,
    });
    if (verification.status === 'verified') {
      return finishVerifiedNode(
        work,
        receipt,
        verification,
        true,
        scopeReceiptIds,
      );
    }
    if (verification.status === 'not_applied') {
      return requestReplan(work, checkpoint, 'effect_not_applied');
    }
    return persistUncertain(work, receipt, verification, true, scopeReceiptIds);
  };

  try {
    outcome = await run();
    // Release the lease before rethrowing any unexpected orchestration error.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    failure = error;
  }
  if (failure) {
    try {
      const failedWork = getDurableWorkUnit(initialWork.workId);
      const failedLease = getDurableWorkLease(input.leaseId);
      const recoveryNow = leaseNow();
      if (
        failedWork &&
        failedLease &&
        failedWork.leaseId === input.leaseId &&
        failedLease.workId === failedWork.workId &&
        failedLease.status === 'active' &&
        failedLease.processGeneration === processGeneration &&
        failedLease.expiresAt > recoveryNow &&
        failedWork.leaseExpiresAt === failedLease.expiresAt &&
        ['executing', 'verifying'].includes(failedWork.status)
      ) {
        const unresolved = listDurableEffectReceipts({
          workId: failedWork.workId,
          limit: 1_000,
        }).filter(
          (receipt) =>
            receipt.planVersion === failedWork.planVersion &&
            (!receipt.verificationFingerprint ||
              ['started', 'partial', 'unknown'].includes(receipt.status)),
        );
        const externalUnknown = unresolved.some(
          (receipt) => receipt.effectClass === 'external_effect',
        );
        if (
          externalUnknown &&
          ALLOWED_TRANSITIONS[failedWork.status].includes('delivery_unverified')
        ) {
          transitionDurableWork({
            workId: failedWork.workId,
            expectedVersion: failedWork.version,
            toStatus: 'delivery_unverified',
            nextAction:
              'Verify the uncertain external effect before any retry.',
            now,
          });
        } else if (unresolved.length > 0 && failedWork.status === 'executing') {
          transitionDurableWork({
            workId: failedWork.workId,
            expectedVersion: failedWork.version,
            toStatus: 'verifying',
            nextAction: 'Verify the uncertain effect before any retry.',
            now,
          });
        } else if (unresolved.length === 0) {
          transitionDurableWork({
            workId: failedWork.workId,
            expectedVersion: failedWork.version,
            toStatus: 'interrupted',
            nextAction: 'Resume from the last committed checkpoint.',
            now,
          });
        }
      }
      // Recovery is best effort. The original orchestration error must remain
      // the reported failure if this transition loses a compare-and-set race.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      // Intentionally preserve the original error below.
    }
  }
  let leaseReleased = false;
  try {
    leaseReleased = releaseDurableLease({
      leaseId: input.leaseId,
      processGeneration,
      now: leaseNow(),
    });
  } catch (releaseError) {
    if (!failure) throw releaseError;
  }
  if (failure) throw failure;
  const refreshed = getDurableWorkUnit(initialWork.workId);
  if (!outcome || !refreshed) {
    throw new Error('Durable orchestration did not produce a stable outcome.');
  }
  return { ...outcome, work: refreshed, leaseReleased };
}

export interface DurableContinuityReport {
  generatedAt: string;
  work: DurableWorkUnit | null;
  checkpoints: DurableWorkCheckpoint[];
  links: DurableWorkLink[];
  receipts: DurableEffectReceipt[];
  events: DurableWorkEvent[];
  activeGrantCount: number;
  resumeEligible: boolean;
  completedNodeCount: number;
  pendingNodeCount: number;
  uncertainNodeCount: number;
  evidenceGaps: string[];
  nextAction: string;
  privacy: typeof DURABLE_CONTINUITY_PRIVACY;
}

const DURABLE_RECOVERY_STATUSES: readonly DurableWorkStatus[] = [
  'proposed',
  'inspecting',
  'planned',
  'ready',
  'awaiting_approval',
  'executing',
  'verifying',
  'blocked',
  'interrupted',
  'needs_replan',
  'delivery_unverified',
  'verification_failed',
];

function durableReportIdCount(value: string): number | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === 'string')
      ? parsed.length
      : null;
  } catch {
    return null;
  }
}

export function buildDurableContinuityReport(
  input: {
    workId?: string | null;
    groupId?: string | null;
    now?: Date | string;
  } = {},
): DurableContinuityReport {
  const generatedAt = iso(input.now);
  if (!isDatabaseInitialized()) {
    return {
      generatedAt,
      work: null,
      checkpoints: [],
      links: [],
      receipts: [],
      events: [],
      activeGrantCount: 0,
      resumeEligible: false,
      completedNodeCount: 0,
      pendingNodeCount: 0,
      uncertainNodeCount: 0,
      evidenceGaps: ['storage_unavailable'],
      nextAction:
        'Initialize durable storage before recovery can be inspected.',
      privacy: DURABLE_CONTINUITY_PRIVACY,
    };
  }
  const groupScopeHash = input.groupId
    ? durableScopeHash('group', input.groupId)
    : undefined;
  const work = input.workId
    ? getDurableWorkUnit(input.workId)
    : listDurableWorkUnits({
        statuses: [...DURABLE_RECOVERY_STATUSES],
        groupScopeHash,
        limit: 1,
      })[0] ||
      listDurableWorkUnits({ groupScopeHash, limit: 1 })[0] ||
      null;
  if (!work) {
    return {
      generatedAt,
      work: null,
      checkpoints: [],
      links: [],
      receipts: [],
      events: [],
      activeGrantCount: 0,
      resumeEligible: false,
      completedNodeCount: 0,
      pendingNodeCount: 0,
      uncertainNodeCount: 0,
      evidenceGaps: [],
      nextAction: 'No durable mission is waiting for recovery.',
      privacy: DURABLE_CONTINUITY_PRIVACY,
    };
  }
  const checkpoints = listDurableWorkCheckpoints({
    workId: work.workId,
    limit: 100,
  });
  const head = checkpoints.find(
    (checkpoint) => checkpoint.durableCheckpointId === work.checkpointHeadId,
  );
  const receipts = listDurableEffectReceipts({
    workId: work.workId,
    limit: 500,
  });
  const completedCount = head
    ? durableReportIdCount(head.completedNodeIdsJson)
    : 0;
  const pendingCount = head ? durableReportIdCount(head.pendingNodeIdsJson) : 0;
  const uncertainCount = head
    ? durableReportIdCount(head.uncertainNodeIdsJson)
    : 0;
  const malformedCheckpoint =
    completedCount === null || pendingCount === null || uncertainCount === null;
  const completedNodeCount = completedCount || 0;
  const pendingNodeCount = pendingCount || 0;
  const uncertainNodeCount = uncertainCount || 0;
  const activeGrantCount = listDurableResumeGrants({
    workId: work.workId,
    status: 'active',
    limit: 100,
  }).filter((grant) => grant.expiresAt > generatedAt).length;
  const evidenceGaps: string[] = [];
  if (!head && !['proposed', 'inspecting'].includes(work.status)) {
    evidenceGaps.push('checkpoint_missing');
  }
  if (malformedCheckpoint) evidenceGaps.push('checkpoint_malformed');
  if (uncertainNodeCount)
    evidenceGaps.push('uncertain_effect_requires_verification');
  if (work.status === 'delivery_unverified')
    evidenceGaps.push('delivery_unverified');
  if (
    receipts.some(
      (receipt) => receipt.status === 'started' || receipt.status === 'unknown',
    )
  ) {
    evidenceGaps.push('execution_receipt_unresolved');
  }
  const resumeEligible =
    Boolean(head) &&
    !malformedCheckpoint &&
    activeGrantCount > 0 &&
    [
      'ready',
      'awaiting_approval',
      'interrupted',
      'needs_replan',
      'verifying',
      'delivery_unverified',
    ].includes(work.status);
  return {
    generatedAt,
    work,
    checkpoints,
    links: listDurableWorkLinks(work.workId),
    receipts,
    events: listDurableWorkEvents({ workId: work.workId, limit: 500 }),
    activeGrantCount,
    resumeEligible,
    completedNodeCount,
    pendingNodeCount,
    uncertainNodeCount,
    evidenceGaps,
    nextAction: work.nextAction,
    privacy: DURABLE_CONTINUITY_PRIVACY,
  };
}

export function formatDurableContinuityForUser(
  report: DurableContinuityReport,
): string {
  if (!report.work) return report.nextAction;
  const lastCheckpoint = report.checkpoints[0] || null;
  const completed = report.work.status === 'completed';
  const approvalNeeded = report.work.status === 'awaiting_approval';
  return [
    `Goal: ${report.work.goalSummary}`,
    `Last verified checkpoint: ${lastCheckpoint ? `${report.completedNodeCount} completed step(s)` : 'none yet'}`,
    `Completed work: ${completed ? 'verified complete' : `${report.completedNodeCount} verified step(s)`}`,
    `Uncertain work: ${report.uncertainNodeCount || 0} step(s)`,
    `Remaining work: ${report.pendingNodeCount || 0} step(s)`,
    `Changed assumptions: ${report.evidenceGaps.length ? report.evidenceGaps.join(', ') : 'none recorded'}`,
    `Blocker: ${report.work.status === 'blocked' ? report.work.nextAction : 'none'}`,
    `Approval needed: ${approvalNeeded ? 'yes' : 'no'}`,
    `Safest next action: ${report.nextAction}`,
  ].join('\n');
}

export function formatDurableContinuityForOperator(
  report: DurableContinuityReport,
): string {
  const work = report.work;
  return [
    'Durable Cognitive Continuity',
    '',
    `Work ID: ${work?.workId || 'none'}`,
    `Status/version: ${work ? `${work.status} / ${work.version}` : 'none'}`,
    `Plan version: ${work?.planVersion || 'none'}`,
    `Lease: ${work?.leaseId ? 'active' : 'none'}`,
    `Resume eligible: ${report.resumeEligible ? 'yes' : 'no'}`,
    `Scope binding: ${work?.targetScopeHash ? 'bound' : 'none'}`,
    `Approval status: ${work?.approvalPacketId ? `version ${work.approvalVersion || 'unknown'}` : 'not linked'}`,
    `Nodes: completed=${report.completedNodeCount} pending=${report.pendingNodeCount} uncertain=${report.uncertainNodeCount}`,
    `Receipts: ${report.receipts.length}`,
    `Evidence gaps: ${report.evidenceGaps.join(', ') || 'none'}`,
    `Owner review: ${work?.ownerReviewId || 'not recorded'}`,
    `Skill candidate: ${work?.skillCandidateId || 'none'}`,
    `Next: ${report.nextAction}`,
    '',
    'Privacy: bounded metadata only; no raw prompts, replies, private bodies, hidden reasoning, commands, arbitrary paths, tool output, secrets, or resume token values are stored.',
  ].join('\n');
}

export function isDurableContinuityNaturalRequest(text: string): boolean {
  return /^(?:what were you doing|what survived the restart|where did you stop|what is verified|what still needs approval|why can(?:not|'t) you continue|what changed since the checkpoint|show the mission evidence|(?:resume|continue) (?:the )?(?:durable )?(?:mission|work))\??$/i.test(
    text.trim(),
  );
}
