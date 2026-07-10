import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';
import {
  advanceVerifiedDeepWorkPacket,
  beginVerifiedDeepWorkForTurn,
  createVerifiedDeepWorkPacket,
  finalizeVerifiedDeepWorkForTurn,
  resumeVerifiedDeepWorkPacket,
} from './verified-deep-work.js';

describe('verified deep work', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

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

  it('binds a later approval turn and closes a verified production turn', () => {
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
    const completed = finalizeVerifiedDeepWorkForTurn({
      packetId: approved!.packetId,
      outcomeSummary: 'Repair completed and service health was verified.',
      evidencePassed: true,
      evidenceRef: 'health:green',
      artifactRefs: ['patch:repair'],
    });
    expect(completed).toMatchObject({
      status: 'completed',
      currentStage: 'record_outcome',
      outcomeSummary: 'Repair completed and service health was verified.',
    });
  });
});
