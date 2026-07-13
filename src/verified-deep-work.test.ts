import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listAssistantMetricEvents,
} from './db.js';
import {
  advanceVerifiedDeepWorkPacket,
  beginVerifiedDeepWorkForTurn,
  captureCurrentRepositorySnapshot,
  createVerifiedDeepWorkPacket,
  finalizeVerifiedDeepWorkForTurn,
  reconcileVerifiedDeepWorkExecution,
  resumeVerifiedDeepWorkPacket,
} from './verified-deep-work.js';
import type {
  RuntimeToolActionEvidence,
  RuntimeToolEvidenceV1,
} from './types.js';
import { linkDeepWorkMission } from './deep-work-apprenticeship.js';

const TEST_REPOSITORY_HEAD = 'a'.repeat(40);
const TEST_REPOSITORY_HEAD_FINGERPRINT = `sha256:${createHash('sha256')
  .update(TEST_REPOSITORY_HEAD)
  .digest('hex')}`;

function testRepositorySnapshot() {
  return {
    root: '/workspace/repository',
    branch: 'main',
    headSha: TEST_REPOSITORY_HEAD,
    dirtyPaths: [],
    capturedAt: '2026-07-13T07:00:00.000Z',
  };
}

function runtimeEvidence(
  evidenceId: string,
  actions: RuntimeToolActionEvidence[],
  collectorStatus: RuntimeToolEvidenceV1['collectorStatus'] = 'complete',
  state?: RuntimeToolEvidenceV1['state'],
): RuntimeToolEvidenceV1 {
  const hasRepositoryWrite = actions.some(
    (entry) => entry.class === 'repository_write',
  );
  const orderedActions = hasRepositoryWrite
    ? actions
    : actions.map((entry) => ({
        ...entry,
        succeededAfterLastRepositoryWrite: 0,
      }));
  const resolvedState =
    state ||
    (hasRepositoryWrite
      ? {
          preStateFingerprint: `sha256:${'1'.repeat(64)}`,
          postStateFingerprint: `sha256:${'2'.repeat(64)}`,
          repositoryHeadFingerprint: TEST_REPOSITORY_HEAD_FINGERPRINT,
        }
      : {
          preStateFingerprint: null,
          postStateFingerprint: null,
          repositoryHeadFingerprint: null,
        });
  const normalizedActions =
    (resolvedState.preStateFingerprint || resolvedState.postStateFingerprint) &&
    !orderedActions.some((entry) => entry.class === 'repository_state')
      ? [
          ...orderedActions,
          {
            class: 'repository_state' as const,
            observed: 2,
            succeeded: 2,
            failed: 0,
            unresolved: 0,
            succeededAfterLastRepositoryWrite: 0,
            lastOutcome: 'succeeded' as const,
            recovered: false,
          },
        ]
      : orderedActions;
  const calls = normalizedActions.reduce(
    (total, action) => ({
      observed: total.observed + action.observed,
      succeeded: total.succeeded + action.succeeded,
      failed: total.failed + action.failed,
      unresolved: total.unresolved + action.unresolved,
    }),
    { observed: 0, succeeded: 0, failed: 0, unresolved: 0 },
  );
  return {
    version: 1,
    evidenceId,
    cumulative: true,
    attempts: Math.max(1, calls.observed),
    collectorStatus,
    calls,
    actions: normalizedActions,
    state: resolvedState,
    privacy: {
      metadataOnly: true,
      rawInputsStored: false,
      resultBodiesStored: false,
      toolUseIdsStored: false,
    },
  };
}

function action(
  actionClass: RuntimeToolActionEvidence['class'],
  status: 'succeeded' | 'failed' | 'unresolved',
  options: {
    failed?: number;
    recovered?: boolean;
    succeededAfterLastRepositoryWrite?: number;
  } = {},
): RuntimeToolActionEvidence {
  const failed = options.failed ?? (status === 'failed' ? 1 : 0);
  const isVerification = actionClass.startsWith('verification_');
  return {
    class: actionClass,
    observed: 1 + (options.recovered ? failed : 0),
    succeeded: status === 'succeeded' ? 1 : 0,
    failed,
    unresolved: status === 'unresolved' ? 1 : 0,
    succeededAfterLastRepositoryWrite:
      options.succeededAfterLastRepositoryWrite ??
      (isVerification && status === 'succeeded' ? 1 : 0),
    lastOutcome: status,
    recovered: options.recovered === true,
  };
}

describe('verified deep work', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('captures a bounded current repository baseline for production code turns', () => {
    const snapshot = captureCurrentRepositorySnapshot(process.cwd());
    expect(snapshot).toMatchObject({
      root: expect.any(String),
      branch: expect.any(String),
      headSha: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      dirtyPaths: expect.any(Array),
      capturedAt: expect.any(String),
    });
    expect(snapshot!.dirtyPaths.length).toBeLessThanOrEqual(200);
  });

  it('requires approval, verifies postconditions, and records an evidence-backed outcome', () => {
    let packet = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: 'Repair the service safely.',
      approvalRequired: true,
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'plan',
    });
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'inspect',
      sources: ['repo:service'],
    });
    expect(() =>
      advanceVerifiedDeepWorkPacket({
        packetId: packet.packetId,
        stage: 'approval',
      }),
    ).toThrow('Fresh approval');
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'approval',
      approvalRef: 'approval:operator-1',
    });
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'execute',
      artifacts: ['patch:service-fix'],
      toolSnapshots: [
        { toolId: 'test-runner', checkedAt: packet.updatedAt, reliability: 1 },
      ],
    });
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'verify',
      checks: [{ name: 'unit tests', passed: true, evidenceRef: 'test:123' }],
    });
    packet = advanceVerifiedDeepWorkPacket({
      packetId: packet.packetId,
      stage: 'record_outcome',
      outcomeSummary: 'The service repair passed its unit checks.',
    });
    expect(packet).toMatchObject({
      status: 'completed',
      approvalRef: 'approval:operator-1',
      outcomeSummary: 'The service repair passed its unit checks.',
    });
  });

  it('blocks degraded tools, failed postconditions, and stale resume snapshots', () => {
    let degraded = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'research',
      objective: 'Research a current provider change.',
    });
    degraded = advanceVerifiedDeepWorkPacket({
      packetId: degraded.packetId,
      stage: 'plan',
    });
    degraded = advanceVerifiedDeepWorkPacket({
      packetId: degraded.packetId,
      stage: 'inspect',
    });
    degraded = advanceVerifiedDeepWorkPacket({
      packetId: degraded.packetId,
      stage: 'execute',
      toolSnapshots: [
        { toolId: 'provider', checkedAt: degraded.updatedAt, reliability: 0.4 },
      ],
    });
    expect(degraded).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining(['provider_or_tool_degraded']),
    });

    let verify = createVerifiedDeepWorkPacket({
      groupFolder: 'main',
      taskFamily: 'coding',
      objective: 'Verify a code change.',
    });
    verify = advanceVerifiedDeepWorkPacket({
      packetId: verify.packetId,
      stage: 'plan',
    });
    verify = advanceVerifiedDeepWorkPacket({
      packetId: verify.packetId,
      stage: 'inspect',
    });
    verify = advanceVerifiedDeepWorkPacket({
      packetId: verify.packetId,
      stage: 'execute',
      toolSnapshots: [
        { toolId: 'compiler', checkedAt: verify.updatedAt, reliability: 1 },
      ],
    });
    verify = advanceVerifiedDeepWorkPacket({
      packetId: verify.packetId,
      stage: 'verify',
      checks: [{ name: 'build', passed: false, evidenceRef: 'build:failed' }],
    });
    expect(verify.unresolvedRisks).toContain('postcondition_failed');
    const resumed = resumeVerifiedDeepWorkPacket({
      packetId: verify.packetId,
      currentToolSnapshots: [
        {
          toolId: 'compiler',
          checkedAt: '2026-01-01T00:00:00.000Z',
          reliability: 1,
        },
      ],
    });
    expect(resumed.unresolvedRisks).toContain(
      'stale_tool_revalidation_required',
    );
  });

  it('records known preflight blockers before execution can start', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-provider-blocked',
      taskFamily: 'operator',
      objective: 'Diagnose the current provider service.',
      approvalRequired: false,
      cognitiveRunId: 'cog:turn-provider-blocked',
      sourceRefs: ['provider-health:current'],
      knownBlockers: ['provider_quota'],
      now: new Date('2026-07-11T12:00:00.000Z'),
    });

    expect(packet).toMatchObject({
      status: 'blocked',
      currentStage: 'execute',
      outcomeSummary:
        'Execution did not start because preflight found a known blocker.',
      unresolvedRisks: expect.arrayContaining(['provider_quota']),
      cognitiveRunId: 'cog:turn-provider-blocked',
    });
  });

  it('routes production code turns into the coding evidence ledger', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-code-mission',
      taskFamily: 'code',
      objective: 'Implement the repository test fix.',
      approvalRequired: false,
      cognitiveRunId: 'cog:turn-code-mission',
      now: new Date('2026-07-12T15:00:00.000Z'),
    });

    expect(packet).toMatchObject({
      taskFamily: 'coding',
      cognitiveRunId: 'cog:turn-code-mission',
    });
  });

  it('does not create execution missions for ordinary answer-only research or status turns', () => {
    expect(
      beginVerifiedDeepWorkForTurn({
        groupFolder: 'main',
        turnId: 'turn-research-answer',
        taskFamily: 'research',
        objective: 'What is the current provider model?',
        approvalRequired: false,
      }),
    ).toBeNull();
    expect(
      beginVerifiedDeepWorkForTurn({
        groupFolder: 'main',
        turnId: 'turn-status-answer',
        taskFamily: 'operator',
        objective: 'What is the service status?',
        approvalRequired: false,
      }),
    ).toBeNull();
  });

  it('binds a later approval turn but requires runtime evidence to close it', () => {
    const pending = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-plan',
      taskFamily: 'operator',
      objective: 'Repair the local service.',
      approvalRequired: true,
      sourceRefs: ['trace:plan'],
    });
    expect(pending).toMatchObject({
      currentStage: 'approval',
      status: 'active',
    });
    const approved = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-approval',
      taskFamily: 'operator',
      objective: 'Approval for the pending repair.',
      approvalRequired: true,
      resumePendingApproval: true,
    });
    expect(approved).toMatchObject({
      packetId: pending?.packetId,
      currentStage: 'execute',
      approvalRef: 'turn:turn-approval',
    });
    const answerOnly = finalizeVerifiedDeepWorkForTurn({
      packetId: approved!.packetId,
      outcomeSummary: 'Repair completed and service health was verified.',
      evidencePassed: true,
      evidenceRef: 'health:green',
      artifactRefs: ['patch:repair'],
    });
    expect(answerOnly).toMatchObject({
      status: 'active',
      currentStage: 'execute',
      unresolvedRisks: expect.arrayContaining(['runtime_execution_missing']),
    });

    const reconciled = reconcileVerifiedDeepWorkExecution({
      packetId: approved!.packetId,
      turnId: 'turn-approval',
      runtimeToolEvidence: runtimeEvidence('evidence-approved-operator', [
        action('workflow_control', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'Repair completed and service health was verified.',
    });
    expect(reconciled).toMatchObject({
      status: 'blocked',
      currentStage: 'execute',
      outcomeSummary: 'Repair completed and service health was verified.',
      unresolvedRisks: expect.arrayContaining([
        'runtime_privileged_action_missing',
      ]),
    });
  });

  it('does not bind an approval turn when multiple packets are waiting', () => {
    for (const [turnId, objective] of [
      ['turn-first', 'Restart and verify the first service.'],
      ['turn-second', 'Restart and verify the second service.'],
    ] as const) {
      beginVerifiedDeepWorkForTurn({
        groupFolder: 'main',
        turnId,
        taskFamily: 'operator',
        objective,
        approvalRequired: true,
      });
    }

    const result = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-ambiguous-approval',
      taskFamily: 'operator',
      objective: 'Yes, do it.',
      approvalRequired: true,
      resumePendingApproval: true,
    });

    expect(result).toBeNull();
  });

  it('keeps a confident answer open when no tool execution was observed', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-answer-only',
      taskFamily: 'code',
      objective: 'Implement the repository fix.',
      approvalRequired: false,
    });

    const reconciled = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-answer-only',
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The answer claimed the fix was complete.',
    });

    expect(reconciled).toMatchObject({
      status: 'active',
      currentStage: 'execute',
      artifacts: [],
      checks: [],
      unresolvedRisks: expect.arrayContaining(['runtime_execution_missing']),
    });
  });

  it('rejects failed, unresolved, cross-turn, and unapproved execution evidence', () => {
    const failedPacket = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-failed',
      taskFamily: 'code',
      objective: 'Implement the repository fix.',
      approvalRequired: false,
    });
    const failed = reconcileVerifiedDeepWorkExecution({
      packetId: failedPacket!.packetId,
      turnId: 'turn-failed',
      runtimeToolEvidence: runtimeEvidence('evidence-failed', [
        action('repository_write', 'failed'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'error',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'A write failed.',
    });
    expect(failed).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining(['runtime_execution_failed']),
    });

    const unresolvedPacket = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-unresolved',
      taskFamily: 'code',
      objective: 'Implement another repository fix.',
      approvalRequired: false,
    });
    const unresolved = reconcileVerifiedDeepWorkExecution({
      packetId: unresolvedPacket!.packetId,
      turnId: 'turn-unresolved',
      runtimeToolEvidence: runtimeEvidence(
        'evidence-unresolved',
        [action('repository_write', 'unresolved')],
        'partial',
      ),
      runtimeStatus: 'error',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The write result was uncertain.',
    });
    expect(unresolved.unresolvedRisks).toContain(
      'runtime_execution_unresolved',
    );

    const scopedPacket = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-original',
      taskFamily: 'code',
      objective: 'Inspect and test the repository.',
      approvalRequired: false,
    });
    const crossTurn = reconcileVerifiedDeepWorkExecution({
      packetId: scopedPacket!.packetId,
      turnId: 'turn-other',
      runtimeToolEvidence: runtimeEvidence('evidence-other-turn', [
        action('repository_read', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'Wrong turn evidence.',
    });
    expect(crossTurn.unresolvedRisks).toContain(
      'runtime_evidence_scope_mismatch',
    );

    const approvalPacket = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-unapproved',
      taskFamily: 'operator',
      objective: 'Restart and verify the external service.',
      approvalRequired: false,
    });
    const unapproved = reconcileVerifiedDeepWorkExecution({
      packetId: approvalPacket!.packetId,
      turnId: 'turn-unapproved',
      runtimeToolEvidence: runtimeEvidence('evidence-unapproved', [
        action('external_side_effect', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'An external action was observed without approval.',
    });
    expect(unapproved).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining(['approval_violation']),
    });
  });

  it('blocks an approved external action after any failed side-effect result', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-external-failure',
      taskFamily: 'operator',
      objective: 'Restart and verify the external service.',
      approvalRequired: true,
    });
    advanceVerifiedDeepWorkPacket({
      packetId: packet!.packetId,
      stage: 'approval',
      approvalRef: 'turn:turn-external-failure',
    });

    const result = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-external-failure',
      runtimeToolEvidence: runtimeEvidence('evidence-external-failure', [
        action('external_side_effect', 'succeeded', {
          failed: 1,
          recovered: true,
        }),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'External retry reported success.',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining([
        'runtime_external_effect_uncertain',
      ]),
    });
  });

  it('does not treat a generic approval reference as exact external-action binding', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-external-binding',
      taskFamily: 'operator',
      objective: 'Restart and verify the external service.',
      approvalRequired: true,
    });
    advanceVerifiedDeepWorkPacket({
      packetId: packet!.packetId,
      stage: 'approval',
      approvalRef: 'turn:turn-external-binding',
    });

    const result = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-external-binding',
      runtimeToolEvidence: runtimeEvidence('evidence-external-binding', [
        action('external_side_effect', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The external action reported success.',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining([
        'runtime_external_action_binding_missing',
      ]),
    });
  });

  it('blocks receipts containing an unclassified runtime action', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-unclassified',
      taskFamily: 'code',
      objective: 'Inspect and test the repository.',
      approvalRequired: false,
    });
    const result = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-unclassified',
      runtimeToolEvidence: runtimeEvidence('evidence-unclassified', [
        action('other', 'succeeded'),
        action('repository_read', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'An ambiguous command also ran.',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining(['runtime_action_unclassified']),
    });
  });

  it('does not complete a privileged operator objective from unrelated local controls', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-privileged-missing',
      taskFamily: 'operator',
      objective: 'Restart and verify the external service.',
      approvalRequired: true,
    });
    advanceVerifiedDeepWorkPacket({
      packetId: packet!.packetId,
      stage: 'approval',
      approvalRef: 'turn:turn-privileged-missing',
    });
    const result = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-privileged-missing',
      runtimeToolEvidence: runtimeEvidence('evidence-privileged-missing', [
        action('workflow_control', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'Only a local control and test ran.',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining([
        'runtime_privileged_action_missing',
      ]),
    });
  });

  it('keeps read-only operator diagnosis blocked until its target is bound', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-operator-diagnosis',
      taskFamily: 'operator',
      objective: 'Diagnose and verify the local service health.',
      approvalRequired: false,
    });
    const result = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-operator-diagnosis',
      runtimeToolEvidence: runtimeEvidence('evidence-operator-diagnosis', [
        action('repository_state', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The read-only service diagnosis passed.',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      currentStage: 'execute',
      unresolvedRisks: expect.arrayContaining([
        'runtime_operator_scope_unbound',
      ]),
    });
  });

  it('blocks terminal runtime errors even when every receipt reports success', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-terminal-error',
      taskFamily: 'operator',
      objective: 'Diagnose and verify the local service health.',
      approvalRequired: false,
    });
    const result = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-terminal-error',
      runtimeToolEvidence: runtimeEvidence('evidence-terminal-error', [
        action('repository_state', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'error',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The receipts looked successful before runtime exit.',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining(['runtime_terminal_error']),
    });
  });

  it('keeps recovered writes blocked until repository scope is host-bound', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-recovered',
      taskFamily: 'code',
      objective: 'Implement the repository test fix.',
      approvalRequired: false,
      repositorySnapshotProvider: testRepositorySnapshot,
    });
    const completed = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-recovered',
      runtimeToolEvidence: runtimeEvidence('evidence-recovered', [
        action('repository_write', 'succeeded', {
          failed: 1,
          recovered: true,
        }),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The recovered edit passed its test.',
    });

    expect(completed).toMatchObject({
      status: 'blocked',
      runtimeExecutionEvidence: {
        evidenceId: 'evidence-recovered',
      },
      unresolvedRisks: expect.arrayContaining([
        'runtime_repository_scope_unbound',
      ]),
    });
    const duplicate = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-recovered',
      runtimeToolEvidence: runtimeEvidence('evidence-recovered', [
        action('repository_write', 'succeeded', {
          failed: 1,
          recovered: true,
        }),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'Duplicate reconciliation must be idempotent.',
    });
    expect(duplicate).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining([
        'runtime_repository_scope_unbound',
      ]),
    });
    const toolMetrics = listAssistantMetricEvents({
      groupFolder: 'main',
    }).filter((event) => ['tool_attempt', 'tool_success'].includes(event.kind));
    expect(toolMetrics).toHaveLength(6);
    expect(
      toolMetrics.every((event) =>
        event.metadataJson.includes('"metricClass":"assistant_interaction"'),
      ),
    ).toBe(true);
  });

  it('blocks a write receipt when no inspected repository baseline was bound', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-missing-baseline',
      taskFamily: 'code',
      objective: 'Update the repository parser.',
      approvalRequired: false,
    });
    const reconciled = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-missing-baseline',
      runtimeToolEvidence: runtimeEvidence('evidence-missing-baseline', [
        action('repository_write', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The edit and test reported success.',
    });

    expect(reconciled).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining([
        'runtime_repository_baseline_missing',
      ]),
    });
  });

  it('keeps real tool evidence open when the answer evaluator reports a major gap', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-major-gap',
      taskFamily: 'code',
      objective: 'Implement the repository test fix.',
      approvalRequired: false,
      repositorySnapshotProvider: testRepositorySnapshot,
    });
    const reconciled = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-major-gap',
      runtimeToolEvidence: runtimeEvidence('evidence-major-gap', [
        action('repository_write', 'succeeded'),
        action('verification_test', 'succeeded'),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'warn',
      evidenceGap: 'major',
      outcomeSummary: 'The runtime worked but the answer overstated evidence.',
    });
    expect(reconciled).toMatchObject({
      status: 'active',
      currentStage: 'execute',
      unresolvedRisks: expect.arrayContaining(['answer_evidence_not_ready']),
    });
  });

  it('keeps a write open when verification did not run after the final write', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-pre-write-verification',
      taskFamily: 'code',
      objective: 'Implement the repository test fix.',
      approvalRequired: false,
      repositorySnapshotProvider: testRepositorySnapshot,
    });
    const reconciled = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-pre-write-verification',
      runtimeToolEvidence: runtimeEvidence('evidence-pre-write-check', [
        action('repository_write', 'succeeded'),
        action('verification_test', 'succeeded', {
          succeededAfterLastRepositoryWrite: 0,
        }),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The check ran before the final edit.',
    });

    expect(reconciled).toMatchObject({
      status: 'active',
      currentStage: 'execute',
      unresolvedRisks: expect.arrayContaining([
        'runtime_post_write_verification_missing',
      ]),
    });
  });

  it('does not accept class-wide recovered verification without check identity', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-recovered-verification',
      taskFamily: 'code',
      objective: 'Implement the repository test fix.',
      approvalRequired: false,
      repositorySnapshotProvider: testRepositorySnapshot,
    });
    const reconciled = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-recovered-verification',
      runtimeToolEvidence: runtimeEvidence('evidence-recovered-verification', [
        action('repository_write', 'succeeded'),
        action('verification_test', 'succeeded', {
          failed: 1,
          recovered: true,
          succeededAfterLastRepositoryWrite: 1,
        }),
      ]),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'A different test may have recovered the class.',
    });

    expect(reconciled).toMatchObject({
      status: 'active',
      currentStage: 'execute',
      unresolvedRisks: expect.arrayContaining(['runtime_verification_missing']),
    });
  });

  it('blocks a write when runtime HEAD does not match the inspected repository state', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-stale-state',
      taskFamily: 'code',
      objective: 'Implement the repository test fix.',
      approvalRequired: false,
    });
    linkDeepWorkMission({
      packetId: packet!.packetId,
      missionId: 'mission-stale-state',
      repository: {
        root: '/workspace/repository',
        branch: 'main',
        headSha: 'expected-head-sha',
        dirtyPaths: [],
        capturedAt: '2026-07-13T07:00:00.000Z',
      },
    });
    const stale = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-stale-state',
      runtimeToolEvidence: runtimeEvidence(
        'evidence-stale-state',
        [
          action('repository_state', 'succeeded'),
          action('repository_write', 'succeeded'),
          action('verification_test', 'succeeded'),
        ],
        'complete',
        {
          preStateFingerprint: `sha256:${'5'.repeat(64)}`,
          postStateFingerprint: `sha256:${'6'.repeat(64)}`,
          repositoryHeadFingerprint: `sha256:${'7'.repeat(64)}`,
        },
      ),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The repository changed after inspection.',
    });
    expect(stale).toMatchObject({
      status: 'blocked',
      unresolvedRisks: expect.arrayContaining(['stale_pre_state']),
    });
  });

  it('keeps a write open when no before/after repository transition was observed', () => {
    const packet = beginVerifiedDeepWorkForTurn({
      groupFolder: 'main',
      turnId: 'turn-missing-state',
      taskFamily: 'code',
      objective: 'Implement the repository state fix.',
      approvalRequired: false,
      repositorySnapshotProvider: testRepositorySnapshot,
    });
    const missing = reconcileVerifiedDeepWorkExecution({
      packetId: packet!.packetId,
      turnId: 'turn-missing-state',
      runtimeToolEvidence: runtimeEvidence(
        'evidence-missing-state',
        [
          action('repository_write', 'succeeded'),
          action('verification_test', 'succeeded'),
        ],
        'complete',
        {
          preStateFingerprint: null,
          postStateFingerprint: null,
          repositoryHeadFingerprint: null,
        },
      ),
      runtimeStatus: 'success',
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      outcomeSummary: 'The edit had no repository-state binding.',
    });
    expect(missing).toMatchObject({
      status: 'active',
      unresolvedRisks: expect.arrayContaining(['runtime_pre_state_missing']),
    });
  });
});
