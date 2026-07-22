import { describe, expect, it } from 'vitest';

import {
  buildCodingDelegationPacket,
  claimMayBeStatedAsFact,
  classifyCodingOperations,
  verifyCodingWorkClaims,
  type CodingVerificationEvidence,
  type CodingWorkClaim,
  type CodingWorkResult,
} from './coding-work-contract.js';

const repository = {
  canonicalRoot: '/allowed/repo',
  worktreeRoot: '/private/worktrees/job-1',
  branch: 'coding/job-1',
  headSha: 'a'.repeat(40),
  dirty: false,
  isolatedWorktree: true,
};

describe('coding work contract', () => {
  it('keeps commit, push, deployment, and messaging outside ordinary coding authority', () => {
    const packet = buildCodingDelegationPacket({
      objective:
        'Implement the fix, test it, commit and push it, then deploy and message the team',
      repository,
      now: new Date('2026-07-22T12:00:00.000Z'),
      packetId: 'coding_test',
    });

    expect(classifyCodingOperations(packet.objective)).toEqual(
      expect.arrayContaining([
        'code_edit',
        'test',
        'commit',
        'push',
        'deploy',
        'message',
      ]),
    );
    expect(
      packet.operations.filter((entry) =>
        ['commit', 'push', 'deploy', 'message'].includes(entry.operation),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'commit',
          authority: 'prohibited',
        }),
        expect.objectContaining({ operation: 'push', authority: 'prohibited' }),
        expect.objectContaining({
          operation: 'deploy',
          authority: 'prohibited',
        }),
        expect.objectContaining({
          operation: 'message',
          authority: 'prohibited',
        }),
      ]),
    );
    expect(packet.operations).toContainEqual({
      operation: 'code_edit',
      authority: 'isolated_workspace_write',
      approvalId: null,
    });
  });

  it('requires a separate operation-specific approval and still labels it approval-gated', () => {
    const packet = buildCodingDelegationPacket({
      objective: 'Commit and push the verified change',
      repository,
      requestedOperations: ['commit', 'push'],
      approvedOperations: { commit: 'approval_commit_1' },
      now: new Date('2026-07-22T12:00:00.000Z'),
    });

    expect(packet.operations).toContainEqual({
      operation: 'commit',
      authority: 'approval_required',
      approvalId: 'approval_commit_1',
    });
    expect(packet.operations).toContainEqual({
      operation: 'push',
      authority: 'prohibited',
      approvalId: null,
    });
  });

  it('does not accept an agent claim without independent evidence', () => {
    const packet = buildCodingDelegationPacket({
      objective: 'Implement and test the fix',
      repository,
      now: new Date('2026-07-22T12:00:00.000Z'),
    });
    const claims: CodingWorkClaim[] = [
      {
        claimId: 'claim_tests',
        kind: 'tests_passed',
        text: 'All tests pass',
        evidenceIds: [],
      },
    ];

    expect(
      verifyCodingWorkClaims({
        packet,
        claims,
        evidence: [],
        now: new Date('2026-07-22T12:01:00.000Z'),
      }),
    ).toMatchObject({
      status: 'unverified',
      unsupportedClaimIds: ['claim_tests'],
    });
  });

  it('requires every evidence kind for a test-passed claim', () => {
    const packet = buildCodingDelegationPacket({
      objective: 'Run the tests',
      repository,
      requestedOperations: ['test'],
      now: new Date('2026-07-22T12:00:00.000Z'),
    });
    const evidence: CodingVerificationEvidence[] = [
      {
        evidenceId: 'exit',
        kind: 'process_exit',
        outcome: 'passed',
        operation: 'test',
        exitCode: 0,
        fingerprint: null,
        observedAt: '2026-07-22T12:00:10.000Z',
        metadata: {},
      },
      {
        evidenceId: 'tests',
        kind: 'test_result',
        outcome: 'passed',
        operation: 'test',
        exitCode: 0,
        fingerprint: 'sha256:result',
        observedAt: '2026-07-22T12:00:10.000Z',
        metadata: { suiteCount: 12 },
      },
    ];
    const claims: CodingWorkClaim[] = [
      {
        claimId: 'claim_tests',
        kind: 'tests_passed',
        text: 'Tests passed',
        evidenceIds: ['exit', 'tests'],
      },
    ];
    const verification = verifyCodingWorkClaims({
      packet,
      claims,
      evidence,
      now: new Date('2026-07-22T12:01:00.000Z'),
    });
    const result = {
      verification,
    } as CodingWorkResult;

    expect(verification).toMatchObject({
      status: 'verified',
      verifiedClaimIds: ['claim_tests'],
    });
    expect(claimMayBeStatedAsFact(result, 'claim_tests')).toBe(true);
  });

  it('rejects evidence for an operation the packet prohibited', () => {
    const packet = buildCodingDelegationPacket({
      objective: 'Push the change',
      repository,
      requestedOperations: ['push'],
      now: new Date('2026-07-22T12:00:00.000Z'),
    });
    const evidence: CodingVerificationEvidence[] = [
      {
        evidenceId: 'receipt',
        kind: 'provider_receipt',
        outcome: 'passed',
        operation: 'push',
        exitCode: 0,
        fingerprint: 'sha256:receipt',
        observedAt: '2026-07-22T12:00:10.000Z',
        metadata: {},
      },
    ];

    expect(
      verifyCodingWorkClaims({
        packet,
        claims: [],
        evidence,
        now: new Date('2026-07-22T12:01:00.000Z'),
      }),
    ).toMatchObject({
      status: 'rejected',
      invariantFailures: ['evidence_for_unauthorized_operation:push'],
    });
  });
});
