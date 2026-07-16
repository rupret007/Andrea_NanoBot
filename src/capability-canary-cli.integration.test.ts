import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getCapabilityAcquisition,
  getCapabilityProductionRun,
  getCognitiveApprovalPacketForGroup,
  setRegisteredGroup,
} from './db.js';
import { dispatchCapabilityApprenticeshipOwnerAction } from './capability-apprenticeship-chat.js';
import { capabilityCanaryCliDependencies } from './capability-canary-runtime.js';
import {
  parseCapabilityCanaryArgs,
  runCapabilityCanaryCli,
} from './capability-canary-cli.js';
import { prepareReleaseReadinessCandidate } from './release-readiness-candidate-preparation.js';

function mutationArgs(input: {
  operation: '--stage' | '--authorize-canary' | '--run-canary';
  acquisitionId: string;
  acquisitionVersion: number;
  runId?: string;
  runRevision?: number;
  healthObservationId: string;
  healthExpiresAt: string;
}): string[] {
  return [
    input.operation,
    '--acquisition',
    input.acquisitionId,
    ...(input.operation === '--stage'
      ? []
      : [
          '--run-id',
          input.runId as string,
          '--expected-run-revision',
          String(input.runRevision),
          '--worker-id',
          'integration-worker',
        ]),
    '--group',
    'main',
    '--expected-acquisition-version',
    String(input.acquisitionVersion),
    '--owner-id',
    'owner',
    '--chat-id',
    'tg:owner',
    '--channel',
    'telegram',
    '--authorized-surface',
    'telegram',
    '--target-scope',
    'release-readiness',
    '--inputs-json',
    '{"targetScopeKey":"release-readiness"}',
    '--health-json',
    JSON.stringify([
      {
        resourceId: 'andrea.release_readiness_truth',
        observationId: input.healthObservationId,
        expiresAt: input.healthExpiresAt,
      },
    ]),
  ];
}

beforeEach(() => {
  vi.stubEnv('ANDREA_TEST_NETWORK_GUARD_ACTIVE', '1');
  vi.stubEnv('ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT', '1');
  vi.stubEnv('ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE', '1');
  _initTestDatabase();
  setRegisteredGroup('tg:owner', {
    name: 'Owner main chat',
    folder: 'main',
    trigger: '@Andrea',
    added_at: '2026-07-15T12:00:00.000Z',
    requiresTrigger: false,
    isMain: true,
  });
});

afterEach(() => {
  _closeDatabase();
  vi.unstubAllEnvs();
});

describe('release-readiness preparation to guided CLI', () => {
  it('does not infer current BlueBubbles owner authorship from stored CLI binding metadata', () => {
    vi.stubEnv('ANDREA_TEST_DISABLE_OWNER_ENV_FILE', '1');
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'iMessage;-;owner@example.invalid',
    );
    setRegisteredGroup('bb:iMessage;-;owner@example.invalid', {
      name: 'Messages (Main)',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-07-15T12:00:00.000Z',
      requiresTrigger: false,
      isMain: false,
    });
    const deps = capabilityCanaryCliDependencies();

    expect(
      deps.isTrustedBinding({
        binding: {
          ownerId: 'owner',
          chatId: 'bb:iMessage;-;owner@example.invalid',
          groupId: 'main',
          channel: 'bluebubbles',
          targetScopeKey: 'release-readiness',
        },
        authorizedSurface: 'bluebubbles',
      }),
    ).toBe(false);
  });

  it('stages, authorizes, and executes the canonical compiled candidate', async () => {
    const prepared = await prepareReleaseReadinessCandidate({
      groupFolder: 'main',
    });
    expect(prepared.healthObservation).not.toBeNull();
    expect(prepared.suggestedHealthExpiry).not.toBeNull();

    const deps = capabilityCanaryCliDependencies();
    const stage = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs(
        mutationArgs({
          operation: '--stage',
          acquisitionId: prepared.acquisition.acquisitionId,
          acquisitionVersion: prepared.acquisition.recordVersion,
          healthObservationId: prepared.healthObservation!.observationId,
          healthExpiresAt: prepared.suggestedHealthExpiry!,
        }),
      ),
      deps,
    );
    expect(stage.staged).toMatchObject({
      acquisitionId: prepared.acquisition.acquisitionId,
      runStatus: 'awaiting_canary_approval',
      approvalStatus: 'staged',
    });
    expect(
      stage.openRuns.find((run) => run.runId === stage.staged?.runId)
        ?.actionApproval,
    ).toBeNull();

    const stagedPacket = getCognitiveApprovalPacketForGroup({
      groupFolder: 'main',
      approvalPacketId: stage.staged!.approvalPacketId,
    });
    expect(stagedPacket).toBeDefined();
    expect(stage.staged!.approvalSummary).toBe(stagedPacket!.summary);
    expect(stage.staged!.approvalCommand).toContain(
      stagedPacket!.summaryDigest as string,
    );
    const group = {
      name: 'Owner main chat',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-07-15T12:00:00.000Z',
      requiresTrigger: false,
      isMain: true,
    };
    const wrongChat = dispatchCapabilityApprenticeshipOwnerAction({
      text: stage.staged!.approvalCommand,
      channelName: 'telegram',
      chatJid: 'tg:other',
      group,
      now: new Date().toISOString(),
    });
    expect(wrongChat.action).toBe('restricted');
    const wrongDigest = dispatchCapabilityApprenticeshipOwnerAction({
      text: stage.staged!.approvalCommand.replace(
        /summary [a-f0-9]{64}$/,
        `summary ${'f'.repeat(64)}`,
      ),
      channelName: 'telegram',
      chatJid: 'tg:owner',
      group,
      now: new Date().toISOString(),
    });
    expect(wrongDigest.text).toContain('no longer matches canonical truth');
    expect(
      getCognitiveApprovalPacketForGroup({
        groupFolder: 'main',
        approvalPacketId: stagedPacket!.approvalPacketId,
      })?.status,
    ).toBe('staged');
    const approved = dispatchCapabilityApprenticeshipOwnerAction({
      text: stage.staged!.approvalCommand,
      channelName: 'telegram',
      chatJid: 'tg:owner',
      group,
      messageId: 'telegram-message:approval-integration',
      now: new Date().toISOString(),
    });
    expect(approved).toMatchObject({ handled: true, action: 'approval' });
    expect(approved.text).toContain('Approved exact capability packet');
    expect(
      getCognitiveApprovalPacketForGroup({
        groupFolder: 'main',
        approvalPacketId: stagedPacket!.approvalPacketId,
      }),
    ).toMatchObject({ status: 'approved', approvalChannel: 'telegram' });
    const replay = dispatchCapabilityApprenticeshipOwnerAction({
      text: stage.staged!.approvalCommand,
      channelName: 'telegram',
      chatJid: 'tg:owner',
      group,
      now: new Date().toISOString(),
    });
    expect(replay.text).toContain('already approved on this exact telegram');

    const stagedRun = getCapabilityProductionRun(stage.staged!.runId)!;
    const stagedAcquisition = getCapabilityAcquisition(
      prepared.acquisition.acquisitionId,
    )!;
    const authorized = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs(
        mutationArgs({
          operation: '--authorize-canary',
          acquisitionId: stagedAcquisition.acquisitionId,
          acquisitionVersion: stagedAcquisition.recordVersion,
          runId: stagedRun.runId,
          runRevision: stagedRun.revision,
          healthObservationId: prepared.healthObservation!.observationId,
          healthExpiresAt: prepared.suggestedHealthExpiry!,
        }),
      ),
      deps,
    );
    expect(authorized.action).toMatchObject({
      operation: 'authorize_canary',
      runStatus: 'canary_ready',
      approvalStatus: 'approved',
    });

    const authorizedRun = getCapabilityProductionRun(stagedRun.runId)!;
    const authorizedAcquisition = getCapabilityAcquisition(
      prepared.acquisition.acquisitionId,
    )!;
    const executed = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs(
        mutationArgs({
          operation: '--run-canary',
          acquisitionId: authorizedAcquisition.acquisitionId,
          acquisitionVersion: authorizedAcquisition.recordVersion,
          runId: authorizedRun.runId,
          runRevision: authorizedRun.revision,
          healthObservationId: prepared.healthObservation!.observationId,
          healthExpiresAt: prepared.suggestedHealthExpiry!,
        }),
      ),
      deps,
    );
    expect(executed.action).toMatchObject({
      operation: 'run_canary',
      executionStatus: 'verified',
      runStatus: 'awaiting_owner_review',
      providerCalls: 0,
      costUsd: 0,
    });
  });
});
