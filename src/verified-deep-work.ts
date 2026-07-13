import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  getVerifiedDeepWorkPacket,
  listVerifiedDeepWorkPackets,
  upsertVerifiedDeepWorkPacket,
} from './db.js';
import { normalizeRuntimeToolEvidenceV1 } from './runtime-tool-evidence.js';
import { recordAssistantMetric } from './personal-assistant-metrics.js';
import type { PlatformTaskFamily } from './andrea-platform-bridge.js';
import type {
  BoundRuntimeExecutionEvidence,
  RuntimeToolActionClass,
  RuntimeToolActionEvidence,
  VerifiedDeepWorkPacket,
  VerifiedDeepWorkStage,
} from './types.js';

const RUNTIME_EVIDENCE_RISKS = new Set([
  'runtime_execution_missing',
  'runtime_execution_unresolved',
  'runtime_execution_failed',
  'runtime_terminal_error',
  'runtime_verification_missing',
  'runtime_post_write_verification_missing',
  'runtime_action_missing',
  'runtime_action_unclassified',
  'runtime_external_effect_uncertain',
  'runtime_external_action_binding_missing',
  'runtime_evidence_scope_mismatch',
  'runtime_pre_state_missing',
  'runtime_post_state_missing',
  'runtime_state_unchanged',
  'runtime_repository_baseline_missing',
  'runtime_repository_scope_unbound',
  'runtime_operator_scope_unbound',
  'runtime_privileged_action_missing',
  'stale_pre_state',
  'answer_evidence_not_ready',
  'approval_violation',
]);

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

export function captureCurrentRepositorySnapshot(
  repoRoot = process.cwd(),
  now = new Date(),
): NonNullable<VerifiedDeepWorkPacket['repository']> | null {
  const readGit = (args: string[]) =>
    execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 512 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    const root = readGit(['rev-parse', '--show-toplevel']);
    const branch = readGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const headSha = readGit(['rev-parse', 'HEAD']);
    if (!root || !branch || !/^[a-f0-9]{40,64}$/i.test(headSha)) return null;
    const dirtyPaths = readGit([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ])
      .split('\n')
      .filter(Boolean)
      .slice(0, 200)
      .map((line) => clean(line.slice(3).split(' -> ').at(-1) || '', 240))
      .filter(Boolean);
    return {
      root: clean(root, 500),
      branch: clean(branch, 160),
      headSha: headSha.toLowerCase(),
      dirtyPaths,
      capturedAt: now.toISOString(),
    };
  } catch {
    return null;
  }
}

export function createVerifiedDeepWorkPacket(params: {
  groupFolder: string;
  taskFamily: VerifiedDeepWorkPacket['taskFamily'];
  objective: string;
  approvalRequired?: boolean;
  evidencePolicyVersion?: 2;
  sourceTurnId?: string | null;
  repository?: VerifiedDeepWorkPacket['repository'];
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
    evidencePolicyVersion: params.evidencePolicyVersion,
    sourceTurnId: params.sourceTurnId ? clean(params.sourceTurnId, 200) : null,
    runtimeExecutionEvidence: null,
    repository: params.repository,
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
  repositorySnapshotProvider?: () => NonNullable<
    VerifiedDeepWorkPacket['repository']
  > | null;
  now?: Date;
}): VerifiedDeepWorkPacket | null {
  if (params.resumePendingApproval) {
    const pendingPackets = listVerifiedDeepWorkPackets({
      groupFolder: params.groupFolder,
      statuses: ['active'],
      limit: 20,
    }).filter((packet) => packet.currentStage === 'approval');
    if (pendingPackets.length === 1) {
      const pending = pendingPackets[0];
      const approved = advanceVerifiedDeepWorkPacket({
        packetId: pending.packetId,
        stage: 'approval',
        approvalRef: `turn:${params.turnId}`,
        nextDecision: 'Execute the approved bounded step, then verify it.',
        now: params.now,
      });
      return persist({
        ...approved,
        sourceTurnId: clean(params.turnId, 200),
        checkpointVersion: approved.checkpointVersion + 1,
        updatedAt: (params.now || new Date()).toISOString(),
      });
    }
  }
  const executionIntent =
    /\b(?:deep|architecture|implement|write|edit|modify|update|add|remove|delete|change|fix|repair|refactor|build|test|debug|diagnose|inspect|review|restart|deploy|configure|install|migrate|commit|push|multi-step)\b/i.test(
      params.objective,
    );
  if (
    !executionIntent ||
    (params.taskFamily !== 'code' && params.taskFamily !== 'operator')
  ) {
    return null;
  }
  let packet = createVerifiedDeepWorkPacket({
    groupFolder: params.groupFolder,
    taskFamily: deepWorkTaskFamily(params.taskFamily),
    objective: params.objective,
    approvalRequired: params.approvalRequired,
    evidencePolicyVersion: 2,
    sourceTurnId: params.turnId,
    repository: params.repositorySnapshotProvider?.() || undefined,
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
  const current = getVerifiedDeepWorkPacket(params.packetId);
  if (!current)
    throw new Error(`Deep-work packet ${params.packetId} not found.`);
  if (current.evidencePolicyVersion === 2) {
    return persist({
      ...current,
      status: current.status === 'completed' ? 'completed' : 'active',
      outcomeSummary: clean(params.outcomeSummary, 600),
      unresolvedRisks: Array.from(
        new Set([...current.unresolvedRisks, 'runtime_execution_missing']),
      ),
      nextDecision:
        'Reconcile actual runtime tool evidence and postconditions before claiming completion.',
      checkpointVersion: current.checkpointVersion + 1,
      updatedAt: (params.now || new Date()).toISOString(),
    });
  }
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

function executionScopeKey(packet: VerifiedDeepWorkPacket, turnId: string) {
  return createHash('sha256')
    .update(
      ['andrea-runtime-evidence-scope-v1', packet.groupFolder, turnId].join(
        '\n',
      ),
    )
    .digest('hex')
    .slice(0, 32);
}

function stateFingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value.trim()).digest('hex')}`;
}

function successfulAction(
  actions: RuntimeToolActionEvidence[],
  actionClass: RuntimeToolActionClass,
): RuntimeToolActionEvidence | undefined {
  return actions.find(
    (action) =>
      action.class === actionClass &&
      action.succeeded > 0 &&
      action.unresolved === 0 &&
      action.lastOutcome === 'succeeded' &&
      (action.failed === 0 || action.recovered),
  );
}

function evidenceRiskUpdate(params: {
  packet: VerifiedDeepWorkPacket;
  risk: string;
  nextDecision: string;
  outcomeSummary: string;
  evidence?: BoundRuntimeExecutionEvidence | null;
  blocked?: boolean;
  now?: Date;
}): VerifiedDeepWorkPacket {
  const now = (params.now || new Date()).toISOString();
  return persist({
    ...params.packet,
    status: params.blocked ? 'blocked' : 'active',
    runtimeExecutionEvidence:
      params.evidence === undefined
        ? params.packet.runtimeExecutionEvidence || null
        : params.evidence,
    outcomeSummary: clean(params.outcomeSummary, 600),
    unresolvedRisks: Array.from(
      new Set([...params.packet.unresolvedRisks, clean(params.risk, 120)]),
    ),
    nextDecision: clean(params.nextDecision, 300),
    checkpointVersion: params.packet.checkpointVersion + 1,
    updatedAt: now,
  });
}

function recordRuntimeToolMetrics(
  packet: VerifiedDeepWorkPacket,
  evidence: BoundRuntimeExecutionEvidence,
  now: Date,
): void {
  for (const actionEvidence of evidence.actions.filter(
    (entry) => entry.observed > 0,
  )) {
    recordAssistantMetric({
      eventId: `runtime-evidence:${evidence.evidenceId}:${actionEvidence.class}:attempt`,
      groupFolder: packet.groupFolder,
      kind: 'tool_attempt',
      value: actionEvidence.observed,
      metadata: {
        metricClass: 'assistant_interaction',
        evidenceId: evidence.evidenceId,
        actionClass: actionEvidence.class,
        collectorStatus: evidence.collectorStatus,
      },
      now,
    });
    if (actionEvidence.succeeded > 0) {
      recordAssistantMetric({
        eventId: `runtime-evidence:${evidence.evidenceId}:${actionEvidence.class}:success`,
        groupFolder: packet.groupFolder,
        kind: 'tool_success',
        value: actionEvidence.succeeded,
        metadata: {
          metricClass: 'assistant_interaction',
          evidenceId: evidence.evidenceId,
          actionClass: actionEvidence.class,
          recovered: actionEvidence.recovered,
        },
        now,
      });
    }
  }
}

/**
 * Reconcile a V2 production packet from metadata-only evidence emitted by the
 * actual runtime. Answer quality and internal trace IDs are deliberately not
 * accepted here as proof that work executed or verified.
 */
export function reconcileVerifiedDeepWorkExecution(params: {
  packetId: string;
  turnId: string;
  runtimeToolEvidence?: unknown;
  runtimeStatus: 'success' | 'error';
  evaluationStatus: 'pass' | 'warn' | 'block';
  evidenceGap: 'none' | 'minor' | 'major' | 'blocked';
  outcomeSummary: string;
  blocker?: string | null;
  now?: Date;
}): VerifiedDeepWorkPacket {
  let packet = getVerifiedDeepWorkPacket(params.packetId);
  if (!packet)
    throw new Error(`Deep-work packet ${params.packetId} not found.`);
  if (packet.evidencePolicyVersion !== 2) return packet;
  if (packet.status === 'completed') return packet;

  const turnId = clean(params.turnId, 200);
  if (!turnId || packet.sourceTurnId !== turnId) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_evidence_scope_mismatch',
      nextDecision:
        'Keep this mission open and reconcile evidence from its original turn only.',
      outcomeSummary: params.outcomeSummary,
      blocked: true,
      now: params.now,
    });
  }
  if (params.blocker || params.evaluationStatus === 'block') {
    return recordBlockedVerifiedDeepWorkOutcome({
      packetId: packet.packetId,
      summary: params.outcomeSummary,
      blocker: params.blocker || 'answer_evaluation_blocked',
      now: params.now,
    });
  }

  const evidence = normalizeRuntimeToolEvidenceV1(params.runtimeToolEvidence);
  if (!evidence || evidence.calls.observed === 0) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_execution_missing',
      nextDecision:
        'Run the bounded execution step and capture an actual tool result before verification.',
      outcomeSummary: params.outcomeSummary,
      blocked: params.runtimeStatus === 'error',
      now: params.now,
    });
  }

  const now = params.now || new Date();
  const boundEvidence: BoundRuntimeExecutionEvidence = {
    ...evidence,
    scopeKey: executionScopeKey(packet, turnId),
    sourceTurnId: turnId,
    approvalRef: packet.approvalRef || null,
    reconciledAt: now.toISOString(),
  };
  recordRuntimeToolMetrics(packet, boundEvidence, now);
  if (
    evidence.collectorStatus !== 'complete' ||
    evidence.calls.unresolved > 0 ||
    evidence.actions.some(
      (action) => action.unresolved > 0 || action.lastOutcome === 'unresolved',
    )
  ) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_execution_unresolved',
      nextDecision:
        'Resolve the incomplete tool result without replaying an uncertain side effect.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: params.runtimeStatus === 'error',
      now,
    });
  }

  const externalAction = evidence.actions.find(
    (action) => action.class === 'external_side_effect' && action.observed > 0,
  );
  if (externalAction && !packet.approvalRef) {
    return evidenceRiskUpdate({
      packet,
      risk: 'approval_violation',
      nextDecision:
        'Do not rely on the external action; obtain fresh approval and inspect remote state before any new attempt.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: true,
      now,
    });
  }
  if (externalAction && externalAction.failed > 0) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_external_effect_uncertain',
      nextDecision:
        'Inspect external state before any new attempt; a failed side-effect result does not prove that nothing happened.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: true,
      now,
    });
  }
  if (externalAction) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_external_action_binding_missing',
      nextDecision:
        'Inspect external state and bind the exact approved action to a dedicated receipt before recording completion.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: true,
      now,
    });
  }

  const unclassifiedAction = evidence.actions.find(
    (action) => action.class === 'other' && action.observed > 0,
  );
  if (unclassifiedAction) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_action_unclassified',
      nextDecision:
        'Classify or remove the ambiguous runtime action before using this receipt as completion evidence.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: true,
      now,
    });
  }

  const unrecoveredFailure = evidence.actions.some(
    (action) =>
      action.failed > 0 &&
      (!action.recovered || action.lastOutcome !== 'succeeded'),
  );
  if (unrecoveredFailure || evidence.calls.failed > evidence.calls.succeeded) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_execution_failed',
      nextDecision:
        'Repair or replace the failed tool step, then capture a later successful attempt and postcondition.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: params.runtimeStatus === 'error',
      now,
    });
  }
  if (params.runtimeStatus === 'error') {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_terminal_error',
      nextDecision:
        'Keep the mission blocked and inspect the terminal runtime failure before trusting otherwise successful receipts.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: true,
      now,
    });
  }

  const requiresPrivilegedOperatorAction =
    packet.taskFamily === 'operator' &&
    /\b(?:apply|change|configure|create|delete|deploy|disable|edit|enable|fix|install|migrate|modify|publish|remove|repair|restart|start|stop|uninstall|update|write)\b/i.test(
      packet.objective,
    );
  if (requiresPrivilegedOperatorAction && !externalAction) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_privileged_action_missing',
      nextDecision:
        'Keep the operator task open until the exact privileged action has fresh approval and dedicated execution evidence.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: true,
      now,
    });
  }

  const requiresRepositoryWrite =
    packet.taskFamily === 'coding' &&
    /\b(?:implement|write|edit|modify|update|add|change|fix|repair|refactor|build|create|remove|delete|modernize|upgrade|migrate)\b/i.test(
      packet.objective,
    );
  if (requiresRepositoryWrite) {
    if (!packet.repository?.headSha) {
      return evidenceRiskUpdate({
        packet,
        risk: 'runtime_repository_baseline_missing',
        nextDecision:
          'Capture the target repository HEAD before writing, then re-plan from that exact baseline.',
        outcomeSummary: params.outcomeSummary,
        evidence: boundEvidence,
        blocked: true,
        now,
      });
    }
    if (!evidence.state.preStateFingerprint) {
      return evidenceRiskUpdate({
        packet,
        risk: 'runtime_pre_state_missing',
        nextDecision:
          'Inspect and fingerprint repository state before any new write attempt.',
        outcomeSummary: params.outcomeSummary,
        evidence: boundEvidence,
        now,
      });
    }
    if (!evidence.state.postStateFingerprint) {
      return evidenceRiskUpdate({
        packet,
        risk: 'runtime_post_state_missing',
        nextDecision:
          'Inspect repository state after the write so the artifact transition is observable.',
        outcomeSummary: params.outcomeSummary,
        evidence: boundEvidence,
        now,
      });
    }
    if (
      evidence.state.preStateFingerprint === evidence.state.postStateFingerprint
    ) {
      return evidenceRiskUpdate({
        packet,
        risk: 'runtime_state_unchanged',
        nextDecision:
          'The observed repository state did not change; inspect the artifact before claiming execution.',
        outcomeSummary: params.outcomeSummary,
        evidence: boundEvidence,
        now,
      });
    }
    const expectedHead = stateFingerprint(packet.repository.headSha);
    if (
      !evidence.state.repositoryHeadFingerprint ||
      evidence.state.repositoryHeadFingerprint !== expectedHead
    ) {
      return evidenceRiskUpdate({
        packet,
        risk: 'stale_pre_state',
        nextDecision:
          'Repository HEAD no longer matches the inspected mission state; re-plan from the current tree.',
        outcomeSummary: params.outcomeSummary,
        evidence: boundEvidence,
        blocked: true,
        now,
      });
    }
  }
  const action =
    packet.taskFamily === 'coding'
      ? requiresRepositoryWrite
        ? successfulAction(evidence.actions, 'repository_write')
        : successfulAction(evidence.actions, 'repository_read') ||
          successfulAction(evidence.actions, 'repository_state')
      : successfulAction(evidence.actions, 'repository_read') ||
        successfulAction(evidence.actions, 'repository_state');
  if (!action) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_action_missing',
      nextDecision:
        'Capture a successful task-relevant runtime action before claiming execution.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      now,
    });
  }

  const verificationClasses: RuntimeToolActionClass[] = [
    'verification_test',
    'verification_typecheck',
    'verification_build',
    'verification_lint',
    'verification_format',
  ];
  const verifications = verificationClasses.flatMap((actionClass) => {
    const verification = successfulAction(evidence.actions, actionClass);
    return verification && verification.failed === 0 ? [verification] : [];
  });
  if (verifications.length === 0) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_verification_missing',
      nextDecision:
        'Run and capture an actual deterministic postcondition check before completion.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      now,
    });
  }
  if (
    requiresRepositoryWrite &&
    !verifications.some(
      (verification) => verification.succeededAfterLastRepositoryWrite > 0,
    )
  ) {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_post_write_verification_missing',
      nextDecision:
        'Run and capture a deterministic verification after the final repository write before completion.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      now,
    });
  }
  if (
    params.evaluationStatus !== 'pass' ||
    params.evidenceGap === 'major' ||
    params.evidenceGap === 'blocked'
  ) {
    return evidenceRiskUpdate({
      packet,
      risk: 'answer_evidence_not_ready',
      nextDecision:
        'Keep the verified runtime evidence, but correct the answer evidence gap before recording the outcome.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      now,
    });
  }
  if (packet.taskFamily === 'coding') {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_repository_scope_unbound',
      nextDecision:
        'Bind repository reads, writes, state probes, and verification to one host-enforced target before recording completion.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: true,
      now,
    });
  }
  if (packet.taskFamily === 'operator') {
    return evidenceRiskUpdate({
      packet,
      risk: 'runtime_operator_scope_unbound',
      nextDecision:
        'Bind the exact operator target, action, and postcondition to a dedicated receipt before recording completion.',
      outcomeSummary: params.outcomeSummary,
      evidence: boundEvidence,
      blocked: true,
      now,
    });
  }

  packet = persist({
    ...packet,
    status: 'active',
    runtimeExecutionEvidence: boundEvidence,
    unresolvedRisks: packet.unresolvedRisks.filter(
      (risk) => !RUNTIME_EVIDENCE_RISKS.has(risk),
    ),
    updatedAt: now.toISOString(),
  });
  if (packet.currentStage === 'execute') {
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'execute',
      artifacts: [`runtime-evidence:${evidence.evidenceId}:${action.class}`],
      toolSnapshots: [
        {
          toolId: `runtime:${action.class}`,
          checkedAt: now.toISOString(),
          reliability: 1,
        },
      ],
      now,
    });
  }
  if (packet.currentStage === 'verify') {
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'verify',
      checks: verifications.map((verification) => ({
        name: verification.class.replace('verification_', ''),
        passed: true,
        evidenceRef: `runtime-evidence:${evidence.evidenceId}:${verification.class}`,
      })),
      now,
    });
  }
  if (packet.currentStage === 'record_outcome') {
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'record_outcome',
      outcomeSummary: params.outcomeSummary,
      now,
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
