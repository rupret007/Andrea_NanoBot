import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  approveCognitiveApprovalPacketCAS,
  getCapabilityAcquisition,
  getCapabilityProductionRun,
  listCognitiveApprovalPackets,
} from './db.js';
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
    'cockpit',
    '--channel',
    'owner_cockpit',
    '--authorized-surface',
    'owner_cockpit',
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
});

afterEach(() => {
  _closeDatabase();
  vi.unstubAllEnvs();
});

describe('release-readiness preparation to guided CLI', () => {
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

    const stagedPacket = listCognitiveApprovalPackets({
      groupFolder: 'main',
      status: 'staged',
      limit: 20,
    }).find(
      (packet) => packet.approvalPacketId === stage.staged?.approvalPacketId,
    );
    expect(stagedPacket).toBeDefined();
    const approved = approveCognitiveApprovalPacketCAS({
      approvalPacketId: stagedPacket!.approvalPacketId,
      groupFolder: 'main',
      expectedSummary: stagedPacket!.summary,
      expectedApprovalVersion: stagedPacket!.approvalVersion || 1,
      expectedScopeDigest: stagedPacket!.scopeDigest || null,
      now: new Date().toISOString(),
      approvalChannel: 'owner_cockpit',
    });
    expect(approved.status).toBe('approved');

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
