import { randomUUID } from 'node:crypto';

import {
  getVerifiedDeepWorkPacket,
  listVerifiedDeepWorkPackets,
  upsertVerifiedDeepWorkPacket,
} from './db.js';
import type { PlatformTaskFamily } from './andrea-platform-bridge.js';
import type { VerifiedDeepWorkPacket, VerifiedDeepWorkStage } from './types.js';

function clean(value: string, limit = 400): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\b(?:sk|xox|ghp|gho|AIza)[A-Za-z0-9_-]{16,}\b/g, '[secret]')
    .trim()
    .slice(0, limit);
}

function persist(packet: VerifiedDeepWorkPacket): VerifiedDeepWorkPacket {
  upsertVerifiedDeepWorkPacket(packet);
  return packet;
}

export function createVerifiedDeepWorkPacket(params: {
  groupFolder: string;
  taskFamily: VerifiedDeepWorkPacket['taskFamily'];
  objective: string;
  approvalRequired?: boolean;
  cognitiveRunId?: string | null;
  now?: Date;
}): VerifiedDeepWorkPacket {
  const now = (params.now || new Date()).toISOString();
  return persist({
    packetId: randomUUID(),
    groupFolder: params.groupFolder,
    taskFamily: params.taskFamily,
    objective: clean(params.objective),
    status: 'active',
    currentStage: 'plan',
    stagesCompleted: [],
    checkpointVersion: 1,
    approvalRequired: params.approvalRequired === true,
    approvalRef: null,
    cognitiveRunId: params.cognitiveRunId
      ? clean(params.cognitiveRunId, 160)
      : null,
    cognitiveOwnerReviewSignalId: null,
    sources: [],
    artifacts: [],
    checks: [],
    toolSnapshots: [],
    unresolvedRisks: [],
    outcomeSummary: null,
    nextDecision: 'Complete and inspect a bounded plan.',
    createdAt: now,
    updatedAt: now,
  });
}

function deepWorkTaskFamily(
  taskFamily: PlatformTaskFamily,
): VerifiedDeepWorkPacket['taskFamily'] {
  if (taskFamily === 'research') return 'research';
  if (taskFamily === 'code') return 'coding';
  if (taskFamily === 'operator') return 'operator';
  return 'planning';
}

export function beginVerifiedDeepWorkForTurn(params: {
  groupFolder: string;
  turnId: string;
  taskFamily: PlatformTaskFamily;
  objective: string;
  approvalRequired: boolean;
  cognitiveRunId?: string | null;
  sourceRefs?: string[];
  knownBlockers?: string[];
  resumePendingApproval?: boolean;
  now?: Date;
}): VerifiedDeepWorkPacket | null {
  if (params.resumePendingApproval) {
    const pending = listVerifiedDeepWorkPackets({
      groupFolder: params.groupFolder,
      statuses: ['active'],
      limit: 20,
    }).find((packet) => packet.currentStage === 'approval');
    if (pending) {
      return advanceVerifiedDeepWorkPacket({
        packetId: pending.packetId,
        stage: 'approval',
        approvalRef: `turn:${params.turnId}`,
        nextDecision: 'Execute the approved bounded step, then verify it.',
        now: params.now,
      });
    }
  }
  if (
    params.taskFamily !== 'research' &&
    params.taskFamily !== 'operator' &&
    !/\b(?:deep|architecture|implement|code|repair|deploy|multi-step|plan)\b/i.test(
      params.objective,
    )
  ) {
    return null;
  }
  let packet = createVerifiedDeepWorkPacket({
    groupFolder: params.groupFolder,
    taskFamily: deepWorkTaskFamily(params.taskFamily),
    objective: params.objective,
    approvalRequired: params.approvalRequired,
    cognitiveRunId: params.cognitiveRunId,
    now: params.now,
  });
  packet = advanceVerifiedDeepWorkPacket({
    packetId: packet.packetId,
    stage: 'plan',
    sources: params.sourceRefs,
    nextDecision: 'Inspect the bounded plan and its evidence gaps.',
    now: params.now,
  });
  packet = advanceVerifiedDeepWorkPacket({
    packetId: packet.packetId,
    stage: 'inspect',
    sources: params.sourceRefs,
    nextDecision: params.approvalRequired
      ? 'Obtain fresh approval for the exact pending action.'
      : 'Execute the bounded read-only step.',
    now: params.now,
  });
  const knownBlockers = (params.knownBlockers || [])
    .map((blocker) => clean(blocker, 160))
    .filter(Boolean);
  if (knownBlockers.length > 0) {
    return recordBlockedVerifiedDeepWorkOutcome({
      packetId: packet.packetId,
      summary:
        'Execution did not start because preflight found a known blocker.',
      blocker: knownBlockers.join(', '),
      now: params.now,
    });
  }
  return packet;
}

export function recordBlockedVerifiedDeepWorkOutcome(params: {
  packetId: string;
  summary: string;
  blocker: string;
  now?: Date;
}): VerifiedDeepWorkPacket {
  const packet = getVerifiedDeepWorkPacket(params.packetId);
  if (!packet)
    throw new Error(`Deep-work packet ${params.packetId} not found.`);
  return persist({
    ...packet,
    status: 'blocked',
    outcomeSummary: clean(params.summary, 600),
    unresolvedRisks: Array.from(
      new Set([...packet.unresolvedRisks, clean(params.blocker, 240)]),
    ),
    nextDecision: 'Resolve the recorded blocker, then resume with fresh proof.',
    checkpointVersion: packet.checkpointVersion + 1,
    updatedAt: (params.now || new Date()).toISOString(),
  });
}

export function finalizeVerifiedDeepWorkForTurn(params: {
  packetId: string;
  outcomeSummary: string;
  evidencePassed: boolean;
  evidenceRef?: string | null;
  blocker?: string | null;
  toolId?: string;
  toolReliability?: number;
  artifactRefs?: string[];
  now?: Date;
}): VerifiedDeepWorkPacket {
  if (params.blocker || !params.evidencePassed) {
    return recordBlockedVerifiedDeepWorkOutcome({
      packetId: params.packetId,
      summary: params.outcomeSummary,
      blocker: params.blocker || 'postcondition_failed',
      now: params.now,
    });
  }
  let packet = getVerifiedDeepWorkPacket(params.packetId);
  if (!packet)
    throw new Error(`Deep-work packet ${params.packetId} not found.`);
  if (packet.currentStage === 'approval') return packet;
  if (packet.currentStage === 'execute') {
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'execute',
      artifacts: params.artifactRefs,
      toolSnapshots: [
        {
          toolId: params.toolId || 'turn_execution',
          checkedAt: (params.now || new Date()).toISOString(),
          reliability: params.toolReliability ?? 1,
        },
      ],
      now: params.now,
    });
  }
  if (packet.status === 'blocked') return packet;
  if (packet.currentStage === 'verify') {
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'verify',
      checks: [
        {
          name: 'turn outcome evidence',
          passed: true,
          evidenceRef: params.evidenceRef || `turn:${packet.packetId}`,
        },
      ],
      now: params.now,
    });
  }
  if (packet.currentStage === 'record_outcome') {
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'record_outcome',
      outcomeSummary: params.outcomeSummary,
      now: params.now,
    });
  }
  return packet;
}

function nextStage(
  packet: VerifiedDeepWorkPacket,
  completed: VerifiedDeepWorkStage,
): VerifiedDeepWorkStage {
  if (completed === 'plan') return 'inspect';
  if (completed === 'inspect')
    return packet.approvalRequired ? 'approval' : 'execute';
  if (completed === 'approval') return 'execute';
  if (completed === 'execute') return 'verify';
  if (completed === 'verify') return 'record_outcome';
  return 'record_outcome';
}

export function advanceVerifiedDeepWorkPacket(params: {
  packetId: string;
  stage: VerifiedDeepWorkStage;
  approvalRef?: string;
  sources?: string[];
  artifacts?: string[];
  checks?: Array<{ name: string; passed: boolean; evidenceRef: string }>;
  toolSnapshots?: VerifiedDeepWorkPacket['toolSnapshots'];
  unresolvedRisks?: string[];
  outcomeSummary?: string;
  nextDecision?: string;
  now?: Date;
}): VerifiedDeepWorkPacket {
  const packet = getVerifiedDeepWorkPacket(params.packetId);
  if (!packet)
    throw new Error(`Deep-work packet ${params.packetId} not found.`);
  if (packet.status === 'completed') return packet;
  if (packet.currentStage !== params.stage) {
    throw new Error(
      `Expected deep-work stage ${packet.currentStage}, received ${params.stage}.`,
    );
  }
  if (
    params.stage === 'approval' &&
    packet.approvalRequired &&
    !params.approvalRef
  ) {
    throw new Error('Fresh approval evidence is required before execution.');
  }
  const toolSnapshots = params.toolSnapshots || packet.toolSnapshots;
  if (
    params.stage === 'execute' &&
    toolSnapshots.some((tool) => tool.reliability < 0.7)
  ) {
    return persist({
      ...packet,
      status: 'blocked',
      toolSnapshots,
      unresolvedRisks: Array.from(
        new Set([...packet.unresolvedRisks, 'provider_or_tool_degraded']),
      ),
      nextDecision: 'Revalidate or replace the degraded provider/tool.',
      checkpointVersion: packet.checkpointVersion + 1,
      updatedAt: (params.now || new Date()).toISOString(),
    });
  }
  const checks = params.checks || packet.checks;
  if (params.stage === 'verify' && checks.some((check) => !check.passed)) {
    return persist({
      ...packet,
      status: 'blocked',
      checks,
      unresolvedRisks: Array.from(
        new Set([...packet.unresolvedRisks, 'postcondition_failed']),
      ),
      nextDecision: 'Repair the failed postcondition and verify again.',
      checkpointVersion: packet.checkpointVersion + 1,
      updatedAt: (params.now || new Date()).toISOString(),
    });
  }
  if (params.stage === 'verify' && checks.length === 0) {
    throw new Error(
      'Verification requires at least one evidence-backed check.',
    );
  }
  if (
    params.stage === 'record_outcome' &&
    !clean(params.outcomeSummary || '')
  ) {
    throw new Error('Outcome recording requires a user-readable summary.');
  }
  const stagesCompleted = Array.from(
    new Set([...packet.stagesCompleted, params.stage]),
  );
  const complete = params.stage === 'record_outcome';
  return persist({
    ...packet,
    status: complete ? 'completed' : 'active',
    currentStage: nextStage(packet, params.stage),
    stagesCompleted,
    checkpointVersion: packet.checkpointVersion + 1,
    approvalRef: params.approvalRef
      ? clean(params.approvalRef, 160)
      : packet.approvalRef,
    sources: Array.from(
      new Set([
        ...packet.sources,
        ...(params.sources || []).map((item) => clean(item, 240)),
      ]),
    ),
    artifacts: Array.from(
      new Set([
        ...packet.artifacts,
        ...(params.artifacts || []).map((item) => clean(item, 240)),
      ]),
    ),
    checks,
    toolSnapshots,
    unresolvedRisks: Array.from(
      new Set([
        ...packet.unresolvedRisks,
        ...(params.unresolvedRisks || []).map((item) => clean(item, 240)),
      ]),
    ),
    outcomeSummary: params.outcomeSummary
      ? clean(params.outcomeSummary, 600)
      : packet.outcomeSummary,
    nextDecision: clean(
      params.nextDecision ||
        (complete
          ? 'No further decision required.'
          : `Continue with ${nextStage(packet, params.stage)}.`),
      300,
    ),
    updatedAt: (params.now || new Date()).toISOString(),
  });
}

export function resumeVerifiedDeepWorkPacket(params: {
  packetId: string;
  currentToolSnapshots: VerifiedDeepWorkPacket['toolSnapshots'];
  now?: Date;
}): VerifiedDeepWorkPacket {
  const packet = getVerifiedDeepWorkPacket(params.packetId);
  if (!packet)
    throw new Error(`Deep-work packet ${params.packetId} not found.`);
  const current = new Map(
    params.currentToolSnapshots.map((snapshot) => [snapshot.toolId, snapshot]),
  );
  const stale = packet.toolSnapshots.filter((previous) => {
    const latest = current.get(previous.toolId);
    return (
      !latest || latest.checkedAt < packet.updatedAt || latest.reliability < 0.7
    );
  });
  if (stale.length > 0) {
    return persist({
      ...packet,
      status: 'blocked',
      unresolvedRisks: Array.from(
        new Set([
          ...packet.unresolvedRisks,
          'stale_tool_revalidation_required',
        ]),
      ),
      nextDecision: `Revalidate ${stale.map((tool) => tool.toolId).join(', ')} before resuming.`,
      checkpointVersion: packet.checkpointVersion + 1,
      updatedAt: (params.now || new Date()).toISOString(),
    });
  }
  return persist({
    ...packet,
    status: packet.status === 'completed' ? 'completed' : 'active',
    toolSnapshots: params.currentToolSnapshots,
    unresolvedRisks: packet.unresolvedRisks.filter(
      (risk) => risk !== 'stale_tool_revalidation_required',
    ),
    checkpointVersion: packet.checkpointVersion + 1,
    updatedAt: (params.now || new Date()).toISOString(),
  });
}
