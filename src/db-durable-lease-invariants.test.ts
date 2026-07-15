import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  getDurableWorkLease,
  heartbeatDurableWorkLease,
  insertDurableResumeGrant,
  listDurableEffectReceipts,
  upsertDurableEffectReceipt,
} from './db.js';
import {
  commitDurableCheckpointCAS,
  consumeResumeGrantAndAcquireLease,
  createOrLoadDurableWork,
  durableScopeHash,
  hashDurableResumeToken,
  issueDurableResumeGrant,
} from './durable-work-continuity.js';
import type { DurableEffectReceipt, DurableWorkEvent } from './types.js';

const binding = {
  ownerId: 'db-lease-owner',
  chatId: 'db-lease-chat',
  groupId: 'main',
  channel: 'telegram',
  targetScopeKey: 'db-lease-target',
};
const privacyJson = '{"metadataOnly":true}';

let testDirectory = '';

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'andrea-db-lease-'));
  _initTestDatabaseAtPath(join(testDirectory, 'messages.db'));
});

afterEach(() => {
  _closeDatabase();
  rmSync(testDirectory, { recursive: true, force: true });
});

function acquireFixture() {
  const created = createOrLoadDurableWork({
    originTurnId: 'db-lease-turn',
    authorizedSurface: 'telegram',
    binding,
    goalSummary: 'Prove the database lease boundary.',
    status: 'ready',
    nextAction: 'Commit one bounded checkpoint.',
    now: '2026-07-13T12:00:00.000Z',
  });
  const checkpoint = commitDurableCheckpointCAS({
    workId: created.work.workId,
    expectedWorkVersion: created.work.version,
    pendingNodeIds: ['inspect'],
    executorScopeKey: 'db-lease-executor',
    targetScopeKey: binding.targetScopeKey,
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction: 'Inspect one node under an active lease.',
    now: '2026-07-13T12:00:10.000Z',
  });
  const issued = issueDurableResumeGrant({
    workId: checkpoint.work.workId,
    binding,
    actionClass: 'repository_read',
    inboundMessageId: 'db-lease-message',
    now: '2026-07-13T12:01:00.000Z',
  });
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding,
    actionClass: 'repository_read',
    inboundMessageId: 'db-lease-message',
    workerId: 'db-lease-worker',
    processGeneration: 'process:db-lease',
    leaseTtlMs: 60_000,
    now: '2026-07-13T12:01:00.000Z',
  });
  if (consumed.status !== 'consumed' || !consumed.work || !consumed.lease) {
    throw new Error('Could not acquire the database lease fixture.');
  }
  return {
    checkpoint: checkpoint.checkpoint,
    work: consumed.work,
    lease: consumed.lease,
  };
}

function receipt(
  fixture: ReturnType<typeof acquireFixture>,
  suffix: string,
  now: string,
): DurableEffectReceipt {
  return {
    receiptId: `receipt:db-lease-${suffix}`,
    workId: fixture.work.workId,
    checkpointId: fixture.checkpoint.durableCheckpointId,
    planVersion: fixture.work.planVersion,
    nodeId: `inspect-${suffix}`,
    invocationId: `invoke:db-lease-${suffix}`,
    actionClass: 'repository_read',
    effectClass: 'read_only',
    status: 'started',
    targetScopeHash: durableScopeHash('target', binding.targetScopeKey),
    createdAt: now,
    updatedAt: now,
    metadataJson: '{}',
    privacyJson,
  };
}

function receiptEvent(
  fixture: ReturnType<typeof acquireFixture>,
  suffix: string,
  now: string,
): DurableWorkEvent {
  return {
    eventId: `durable:event:db-lease-${suffix}`,
    workId: fixture.work.workId,
    createdAt: now,
    eventKind: 'receipt',
    fromStatus: null,
    toStatus: null,
    workVersion: fixture.work.version,
    planVersion: fixture.work.planVersion,
    summary: 'Recorded one lease-bound database receipt.',
    refsJson: '[]',
    privacyJson,
  };
}

describe('durable database lease invariants', () => {
  it('fails closed when a low-level unknown action grant has no approval', () => {
    const created = createOrLoadDurableWork({
      originTurnId: 'db-unknown-action-turn',
      authorizedSurface: 'telegram',
      binding,
      goalSummary: 'Reject one unknown mutation-like action.',
      status: 'ready',
      nextAction: 'Commit one bounded checkpoint.',
      now: '2026-07-13T12:00:00.000Z',
    });
    const checkpoint = commitDurableCheckpointCAS({
      workId: created.work.workId,
      expectedWorkVersion: created.work.version,
      pendingNodeIds: ['unknown-action'],
      executorScopeKey: 'db-lease-executor',
      targetScopeKey: binding.targetScopeKey,
      recoveryPolicy: 'approval_required',
      nextSafeAction: 'Require an exact known action policy.',
      now: '2026-07-13T12:00:10.000Z',
    });
    const token = 'unknown-action-token-value-1234567890abcdef';
    expect(() =>
      insertDurableResumeGrant({
        grant: {
          grantId: 'grant:db-unknown-action',
          tokenHash: hashDurableResumeToken(token),
          workId: checkpoint.work.workId,
          checkpointId: checkpoint.checkpoint.durableCheckpointId,
          workVersion: checkpoint.work.version,
          planVersion: checkpoint.work.planVersion,
          ownerScopeHash: durableScopeHash('owner', binding.ownerId),
          chatScopeHash: durableScopeHash('chat', binding.chatId),
          groupScopeHash: durableScopeHash('group', binding.groupId),
          channel: binding.channel,
          targetScopeHash: durableScopeHash('target', binding.targetScopeKey),
          actionClass: 'send_message',
          approvalPacketId: null,
          approvalVersion: null,
          approvalScopeHash: null,
          inboundMessageHash: null,
          status: 'active',
          createdAt: '2026-07-13T12:00:20.000Z',
          updatedAt: '2026-07-13T12:00:20.000Z',
          expiresAt: '2026-07-13T12:10:20.000Z',
          consumedAt: null,
          revokedAt: null,
          consumedLeaseId: null,
          privacyJson,
        },
        event: {
          eventId: 'durable:event:db-unknown-action',
          workId: checkpoint.work.workId,
          createdAt: '2026-07-13T12:00:20.000Z',
          eventKind: 'grant_issued',
          fromStatus: checkpoint.work.status,
          toStatus: checkpoint.work.status,
          workVersion: checkpoint.work.version,
          planVersion: checkpoint.work.planVersion,
          summary: 'Inserted one adversarial unknown action grant.',
          refsJson: '[]',
          privacyJson,
        },
      }),
    ).toThrow(/closed policy set/i);
  });

  it('rejects a capability-only sandbox action at low-level grant storage', () => {
    const created = createOrLoadDurableWork({
      originTurnId: 'db-sandbox-only-grant-turn',
      authorizedSurface: 'telegram',
      binding,
      goalSummary: 'Reject a generic sandbox repository grant.',
      status: 'ready',
      nextAction: 'Commit one bounded checkpoint.',
      now: '2026-07-13T12:00:00.000Z',
    });
    const checkpoint = commitDurableCheckpointCAS({
      workId: created.work.workId,
      expectedWorkVersion: created.work.version,
      pendingNodeIds: ['sandbox-write'],
      executorScopeKey: 'db-lease-executor',
      targetScopeKey: binding.targetScopeKey,
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction: 'Keep the capability-only effect out of this surface.',
      now: '2026-07-13T12:00:10.000Z',
    });
    const createdAt = '2026-07-13T12:00:20.000Z';
    expect(() =>
      insertDurableResumeGrant({
        grant: {
          grantId: 'grant:db-sandbox-only-action',
          tokenHash: hashDurableResumeToken(
            'sandbox-only-token-value-1234567890abcdef',
          ),
          workId: checkpoint.work.workId,
          checkpointId: checkpoint.checkpoint.durableCheckpointId,
          workVersion: checkpoint.work.version,
          planVersion: checkpoint.work.planVersion,
          ownerScopeHash: checkpoint.work.ownerScopeHash,
          chatScopeHash: checkpoint.work.chatScopeHash,
          groupScopeHash: checkpoint.work.groupScopeHash,
          channel: checkpoint.work.channel,
          targetScopeHash: checkpoint.work.targetScopeHash,
          actionClass: 'sandbox_repository_write',
          approvalPacketId: null,
          approvalVersion: null,
          approvalScopeHash: null,
          inboundMessageHash: null,
          status: 'active',
          createdAt,
          updatedAt: createdAt,
          expiresAt: '2026-07-13T12:10:20.000Z',
          consumedAt: null,
          revokedAt: null,
          consumedLeaseId: null,
          privacyJson,
        },
        event: {
          eventId: 'durable:event:db-sandbox-only-action',
          workId: checkpoint.work.workId,
          createdAt,
          eventKind: 'grant_issued',
          fromStatus: checkpoint.work.status,
          toStatus: checkpoint.work.status,
          workVersion: checkpoint.work.version,
          planVersion: checkpoint.work.planVersion,
          summary: 'Attempted one generic capability-only action grant.',
          refsJson: '[]',
          privacyJson,
        },
      }),
    ).toThrow(/capability-sandbox-only/i);
  });

  it('rejects a low-level approval-bound grant without exact approved scope', () => {
    const created = createOrLoadDurableWork({
      originTurnId: 'db-unapproved-grant-turn',
      authorizedSurface: 'telegram',
      binding,
      goalSummary: 'Reject a forged approval-bound grant.',
      status: 'ready',
      nextAction: 'Commit one bounded checkpoint.',
      now: '2026-07-13T12:00:00.000Z',
    });
    const checkpoint = commitDurableCheckpointCAS({
      workId: created.work.workId,
      expectedWorkVersion: created.work.version,
      pendingNodeIds: ['edit'],
      executorScopeKey: 'db-lease-executor',
      targetScopeKey: binding.targetScopeKey,
      recoveryPolicy: 'approval_required',
      nextSafeAction: 'Require exact approval before editing.',
      now: '2026-07-13T12:00:10.000Z',
    });
    const createdAt = '2026-07-13T12:00:20.000Z';
    expect(() =>
      insertDurableResumeGrant({
        grant: {
          grantId: 'grant:db-unapproved-known-action',
          tokenHash: hashDurableResumeToken(
            'known-action-token-value-1234567890abcdef',
          ),
          workId: checkpoint.work.workId,
          checkpointId: checkpoint.checkpoint.durableCheckpointId,
          workVersion: checkpoint.work.version,
          planVersion: checkpoint.work.planVersion,
          ownerScopeHash: checkpoint.work.ownerScopeHash,
          chatScopeHash: checkpoint.work.chatScopeHash,
          groupScopeHash: checkpoint.work.groupScopeHash,
          channel: checkpoint.work.channel,
          targetScopeHash: checkpoint.work.targetScopeHash,
          actionClass: 'repository_write',
          approvalPacketId: null,
          approvalVersion: null,
          approvalScopeHash: null,
          inboundMessageHash: null,
          status: 'active',
          createdAt,
          updatedAt: createdAt,
          expiresAt: '2026-07-13T12:10:20.000Z',
          consumedAt: null,
          revokedAt: null,
          consumedLeaseId: null,
          privacyJson,
        },
        event: {
          eventId: 'durable:event:db-unapproved-known-action',
          workId: checkpoint.work.workId,
          createdAt,
          eventKind: 'grant_issued',
          fromStatus: checkpoint.work.status,
          toStatus: checkpoint.work.status,
          workVersion: checkpoint.work.version,
          planVersion: checkpoint.work.planVersion,
          summary: 'Attempted one forged approval-bound grant.',
          refsJson: '[]',
          privacyJson,
        },
      }),
    ).toThrow(/current exact approved scope/i);
  });

  it('enforces the closed action/effect and approval policy at receipt storage', () => {
    const fixture = acquireFixture();
    const now = '2026-07-13T12:01:30.000Z';
    expect(() =>
      upsertDurableEffectReceipt({
        receipt: {
          ...receipt(fixture, 'mismatched-effect', now),
          effectClass: 'local_write',
        },
        event: receiptEvent(fixture, 'mismatched-effect', now),
      }),
    ).toThrow(/closed execution policy/i);

    expect(() =>
      upsertDurableEffectReceipt({
        receipt: {
          ...receipt(fixture, 'sandbox-only', now),
          actionClass: 'sandbox_repository_write',
          effectClass: 'sandbox_repository_write',
        },
        event: receiptEvent(fixture, 'sandbox-only', now),
      }),
    ).toThrow(/capability-sandbox-only/i);

    const operatorReceipt: DurableEffectReceipt = {
      ...receipt(fixture, 'operator-change', now),
      actionClass: 'operator_change',
      effectClass: 'local_write',
    };
    expect(() =>
      upsertDurableEffectReceipt({
        receipt: operatorReceipt,
        event: receiptEvent(fixture, 'operator-change', now),
      }),
    ).toThrow(/active bound lease generation/i);
    expect(() =>
      upsertDurableEffectReceipt({
        receipt: operatorReceipt,
        event: receiptEvent(fixture, 'operator-change-with-lease', now),
        leaseAssertion: {
          leaseId: fixture.lease.leaseId,
          processGeneration: 'process:db-lease',
          now,
        },
      }),
    ).toThrow(/current exact-scope lease approval/i);
  });

  it('looks up a lease and atomically rejects the wrong generation or an expired lease', () => {
    const fixture = acquireFixture();
    expect(getDurableWorkLease(fixture.lease.leaseId)).toMatchObject({
      workId: fixture.work.workId,
      processGeneration: 'process:db-lease',
      status: 'active',
    });

    const validAt = '2026-07-13T12:01:30.000Z';
    expect(
      upsertDurableEffectReceipt({
        receipt: receipt(fixture, 'valid', validAt),
        event: receiptEvent(fixture, 'valid', validAt),
        leaseAssertion: {
          leaseId: fixture.lease.leaseId,
          processGeneration: 'process:db-lease',
          now: validAt,
        },
      }),
    ).toMatchObject({ receiptId: 'receipt:db-lease-valid' });

    expect(() =>
      upsertDurableEffectReceipt({
        receipt: receipt(fixture, 'wrong-generation', validAt),
        event: receiptEvent(fixture, 'wrong-generation', validAt),
        leaseAssertion: {
          leaseId: fixture.lease.leaseId,
          processGeneration: 'process:wrong',
          now: validAt,
        },
      }),
    ).toThrow(/active bound lease generation/i);

    const expiredAt = '2026-07-13T12:02:00.000Z';
    expect(() =>
      upsertDurableEffectReceipt({
        receipt: receipt(fixture, 'expired', expiredAt),
        event: receiptEvent(fixture, 'expired', expiredAt),
        leaseAssertion: {
          leaseId: fixture.lease.leaseId,
          processGeneration: 'process:db-lease',
          now: expiredAt,
        },
      }),
    ).toThrow(/active bound lease generation/i);
    expect(
      listDurableEffectReceipts({ workId: fixture.work.workId }).map(
        (candidate) => candidate.receiptId,
      ),
    ).toEqual(['receipt:db-lease-valid']);
  });

  it('does not revive an expired lease through heartbeat', () => {
    const fixture = acquireFixture();
    expect(
      heartbeatDurableWorkLease({
        leaseId: fixture.lease.leaseId,
        processGeneration: 'process:db-lease',
        now: '2026-07-13T12:02:00.000Z',
        expiresAt: '2026-07-13T12:03:00.000Z',
      }),
    ).toBe(false);
    expect(getDurableWorkLease(fixture.lease.leaseId)).toMatchObject({
      expiresAt: '2026-07-13T12:02:00.000Z',
      status: 'active',
    });
  });
});
