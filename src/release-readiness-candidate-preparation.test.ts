import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listCapabilityProductionRuns,
  listCognitiveApprovalPackets,
  listReliabilityObservations,
} from './db.js';
import { prepareReleaseReadinessCandidate } from './release-readiness-candidate-preparation.js';

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

describe('release-readiness candidate preparation', () => {
  it('persists only synthetic preproduction evidence and stops for the owner', async () => {
    const prepared = await prepareReleaseReadinessCandidate({
      groupFolder: 'main',
      now: new Date('2026-07-15T15:00:00.000Z'),
    });

    expect(prepared.acquisition.state).toBe('owner_review_required');
    expect(prepared.acquisition.evidenceOrigin).toBe('synthetic');
    expect(prepared.contract.taskFamily).toBe('release_readiness');
    expect(prepared.contract.steps).toHaveLength(1);
    expect(prepared.contract.steps[0]).toMatchObject({
      actionClass: 'local_lookup',
      readOnly: true,
      approvalRequired: false,
    });
    expect(prepared.contract.dataEgressClass).toBe('none');
    expect(prepared.healthObservation?.outcome).toBe('success');
    expect(listCapabilityProductionRuns({ limit: 100 })).toHaveLength(0);
    expect(listCognitiveApprovalPackets({ limit: 100 })).toHaveLength(0);
  });

  it('resumes idempotently without manufacturing additional success evidence', async () => {
    const first = await prepareReleaseReadinessCandidate({
      groupFolder: 'main',
      now: new Date('2026-07-15T15:00:00.000Z'),
    });
    const observationsBefore = listReliabilityObservations({ limit: 100 });
    const second = await prepareReleaseReadinessCandidate({
      groupFolder: 'main',
      now: new Date('2026-07-15T15:01:00.000Z'),
    });

    expect(second.acquisition.acquisitionId).toBe(
      first.acquisition.acquisitionId,
    );
    expect(second.acquisition.recordVersion).toBe(
      first.acquisition.recordVersion,
    );
    expect(second.healthObservation?.observationId).toBe(
      first.healthObservation?.observationId,
    );
    expect(listReliabilityObservations({ limit: 100 })).toEqual(
      observationsBefore,
    );
  });

  it('refreshes an expired health proof only by rerunning the real local verifier', async () => {
    const first = await prepareReleaseReadinessCandidate({
      groupFolder: 'main',
      now: new Date('2026-07-15T15:00:00.000Z'),
    });
    const observationsBefore = listReliabilityObservations({ limit: 100 });

    const refreshed = await prepareReleaseReadinessCandidate({
      groupFolder: 'main',
      now: new Date('2026-07-15T15:31:00.000Z'),
    });

    expect(refreshed.acquisition.acquisitionId).toBe(
      first.acquisition.acquisitionId,
    );
    expect(refreshed.acquisition.recordVersion).toBe(
      first.acquisition.recordVersion,
    );
    expect(refreshed.healthObservation).toMatchObject({
      sourceKind: 'verified_usage',
      outcome: 'success',
      confidence: 1,
      fallbackUsed: false,
      observedAt: '2026-07-15T15:31:00.000Z',
    });
    expect(refreshed.healthObservation?.observationId).not.toBe(
      first.healthObservation?.observationId,
    );
    expect(listReliabilityObservations({ limit: 100 })).toHaveLength(
      observationsBefore.length + 1,
    );
  });

  it('fails closed without the hermetic provider-suppressed guard', async () => {
    vi.stubEnv('ANDREA_TEST_NETWORK_GUARD_ACTIVE', '0');
    await expect(
      prepareReleaseReadinessCandidate({ groupFolder: 'main' }),
    ).rejects.toThrow(/offline, provider-suppressed certification process/i);
  });
});
