import { describe, expect, it } from 'vitest';

import {
  buildIntegrationRecoveryReport,
  formatIntegrationRecoveryReport,
  parseIntegrationRecoveryCommand,
} from './integration-recovery.js';
import { runIntegrationRepair } from './integration-healer.js';
import type {
  IntegrationDoctorReport,
  IntegrationStatus,
} from './integration-doctor.js';
import type { ProviderHealthSnapshot } from './provider-health.js';
import type {
  LiveProofGauntletEntry,
  LiveProofGauntletReport,
  RepairDoctorReport,
} from './types.js';

const generatedAt = '2026-06-12T12:00:00.000Z';

function integrationStatus(
  integrationId: string,
  label: string,
  state: IntegrationStatus['state'],
  overrides: Partial<IntegrationStatus> = {},
): IntegrationStatus {
  return {
    integrationId,
    label,
    state,
    credentialState: 'configured',
    transportState: 'healthy',
    proofState: state,
    lastHealthyAt: state === 'healthy' ? generatedAt : null,
    lastFailure: '',
    blockerOwner: 'none',
    nextAction: 'No action needed.',
    repairability: 'status_only',
    safeActions: [],
    detail: '',
    ...overrides,
  };
}

function proofEntry(
  proofName: string,
  status: LiveProofGauntletEntry['status'],
  overrides: Partial<LiveProofGauntletEntry> = {},
): LiveProofGauntletEntry {
  return {
    proofId: `proof:${proofName.toLowerCase().replace(/\s+/g, '_')}`,
    proofName,
    status,
    lastProofAt: 'none',
    nextStep: 'No action needed.',
    repoWorkRequired: false,
    blockerOwner: 'none',
    evidenceIdsJson: '[]',
    detail: '',
    privacyJson: '{}',
    ...overrides,
  };
}

function proofReport(
  entries: LiveProofGauntletEntry[],
): LiveProofGauntletReport {
  const dailyCoreEntries = entries.filter(
    (entry) => !/Alexa signed IntentRequest/i.test(entry.proofName),
  );
  return {
    generatedAt,
    entries,
    liveProvenCount: entries.filter((entry) => entry.status === 'live_proven')
      .length,
    proofDebtCount: entries.filter((entry) => entry.status !== 'live_proven')
      .length,
    dailyCoreLiveProvenCount: dailyCoreEntries.filter(
      (entry) => entry.status === 'live_proven',
    ).length,
    dailyCoreProofDebtCount: dailyCoreEntries.filter(
      (entry) => entry.status !== 'live_proven',
    ).length,
    optionalProofDebtCount: entries.filter(
      (entry) =>
        /Alexa signed IntentRequest/i.test(entry.proofName) &&
        entry.status !== 'live_proven',
    ).length,
    repoWorkRequiredCount: entries.filter((entry) => entry.repoWorkRequired)
      .length,
    nextAction: 'next proof action',
    privacyJson: '{}',
  };
}

function integrationReport(
  statuses: IntegrationStatus[],
): IntegrationDoctorReport {
  return {
    generatedAt,
    summary: {
      total: statuses.length,
      healthy: statuses.filter((status) => status.state === 'healthy').length,
      actionNeeded: statuses.filter((status) => status.state !== 'healthy')
        .length,
      needsProof: statuses.filter((status) => status.state === 'needs_proof')
        .length,
      manualOrExternal: statuses.filter((status) =>
        ['needs_auth', 'externally_blocked', 'manual_action_required'].includes(
          status.state,
        ),
      ).length,
    },
    statuses,
    secretsRedacted: true,
  };
}

function repairReport(): RepairDoctorReport {
  return {
    generatedAt,
    attempts: [],
    cooldowns: [],
    nextAction: 'none',
    privacy: {
      metadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      hiddenReasoningStored: false,
      secretsRedacted: true,
    },
  };
}

function provider(
  providerId: string,
  overrides: Partial<ProviderHealthSnapshot> = {},
): ProviderHealthSnapshot {
  return {
    providerId,
    kind: 'llm',
    state: 'externally_blocked',
    lastHealthyAt: null,
    lastCheckedAt: generatedAt,
    failureClass: 'quota_or_rate_limit',
    quotaState: 'blocked',
    credentialState: 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: 'quota blocked',
    nextAction: 'Wait for provider quota recovery.',
    metadata: {},
    ...overrides,
  };
}

function buildReport(params: {
  statuses: IntegrationStatus[];
  proofs: LiveProofGauntletEntry[];
  providers?: ProviderHealthSnapshot[];
  targetId?: string;
}) {
  return buildIntegrationRecoveryReport({
    now: new Date(generatedAt),
    targetId: params.targetId,
    integrationReport: integrationReport(params.statuses),
    proofReport: proofReport(params.proofs),
    providers: params.providers || [],
    repairReport: repairReport(),
  });
}

describe('integration recovery', () => {
  it('classifies missing Telegram user-session config as recoverable config debt', () => {
    const report = buildReport({
      statuses: [integrationStatus('telegram', 'Telegram', 'healthy')],
      proofs: [
        proofEntry('Telegram user-session proof', 'missing_config', {
          blockerOwner: 'external',
          nextStep:
            'Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH, then run npm run telegram:user:smoke.',
        }),
      ],
    });

    const telegram = report.items.find(
      (item) => item.integrationId === 'telegram',
    );
    expect(telegram?.recoveryClass).toBe('missing_config');
    expect(telegram?.currentState).toBe('missing_config');
    expect(telegram?.lastKnownGoodAt).toBeNull();
    expect(telegram?.successCheck).toContain('telegram:user:smoke');
  });

  it('lets specific user-session proof debt override broad Telegram near-live status', () => {
    const report = buildReport({
      statuses: [
        integrationStatus('telegram', 'Telegram', 'near_live_only', {
          detail: 'Observed a real Telegram request/response exchange.',
          nextAction:
            'Rerun npm run telegram:user:smoke to refresh the Telegram live-proof marker.',
        }),
      ],
      proofs: [
        proofEntry('Telegram user-session proof', 'missing_config', {
          nextStep:
            'Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH first.',
        }),
      ],
    });

    const telegram = report.items.find(
      (item) => item.integrationId === 'telegram',
    );
    expect(telegram?.recoveryClass).toBe('missing_config');
    expect(telegram?.currentState).toBe('missing_config');
    expect(telegram?.blockedBy).toBe('external');
    expect(telegram?.nextHumanStep).toContain('TELEGRAM_USER_API_ID');
  });

  it('omits healthy status-only surfaces from the recovery queue', () => {
    const report = buildReport({
      statuses: [
        integrationStatus('research', 'Research', 'healthy', {
          detail: 'Research is healthy.',
        }),
        integrationStatus('image_generation', 'Image generation', 'healthy', {
          detail: 'Image generation is healthy.',
        }),
      ],
      proofs: [],
    });

    expect(report.items).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it('classifies Google Calendar invalid_grant as OAuth reauth work', () => {
    const report = buildReport({
      statuses: [
        integrationStatus('google_calendar', 'Google Calendar', 'needs_auth', {
          blockerOwner: 'external',
          nextAction: 'Reauthorize Google Calendar.',
          detail: 'Google token refresh 400: invalid_grant',
        }),
      ],
      proofs: [
        proofEntry('Google Calendar live write proof', 'externally_blocked', {
          lastProofAt: '2026-06-01T09:00:00.000Z',
        }),
      ],
      targetId: 'calendar',
    });

    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.integrationId).toBe('google_calendar');
    expect(report.items[0]?.recoveryClass).toBe('needs_auth');
    expect(report.items[0]?.lastKnownGoodAt).toBe('2026-06-01T09:00:00.000Z');
  });

  it('classifies BlueBubbles healthy transport with missing same-thread proof as a proof drill', () => {
    const report = buildReport({
      statuses: [
        integrationStatus(
          'bluebubbles',
          'BlueBubbles / iMessage',
          'needs_proof',
          {
            nextAction: 'Complete same-thread proof.',
            detail:
              'Transport ready; same-thread message_action proof missing.',
          },
        ),
      ],
      proofs: [
        proofEntry(
          'BlueBubbles same-thread message-action proof',
          'near_live_only',
        ),
      ],
    });

    const bluebubbles = report.items.find(
      (item) => item.integrationId === 'bluebubbles',
    );
    expect(bluebubbles?.recoveryClass).toBe('proof_drill');
    expect(bluebubbles?.successCheck).toContain('debug:bluebubbles');
  });

  it('classifies stale Alexa signed proof as manual proof work', () => {
    const report = buildReport({
      statuses: [
        integrationStatus('alexa', 'Alexa', 'manual_action_required', {
          blockerOwner: 'manual',
          nextAction: 'Use a real signed simulator/device turn.',
        }),
      ],
      proofs: [
        proofEntry('Alexa signed IntentRequest proof', 'stale', {
          lastProofAt: '2026-06-10T18:30:00.000Z',
        }),
      ],
    });

    const alexa = report.items.find((item) => item.integrationId === 'alexa');
    expect(alexa?.recoveryClass).toBe('manual_proof');
    expect(alexa?.lastKnownGoodAt).toBe('2026-06-10T18:30:00.000Z');
    expect(alexa?.successCheck).toContain('/alexa-status');
  });

  it('classifies provider quota as an external provider blocker', () => {
    const report = buildReport({
      statuses: [],
      proofs: [],
      providers: [
        provider('anthropic_cloud', {
          lastHealthyAt: '2026-06-09T12:00:00.000Z',
        }),
      ],
    });

    const anthropic = report.items.find(
      (item) => item.integrationId === 'provider:anthropic_cloud',
    );
    expect(anthropic?.recoveryClass).toBe('provider_blocker');
    expect(anthropic?.blockedBy).toBe('external');
    expect(anthropic?.canApplySafely).toBe(true);
    expect(anthropic?.lastKnownGoodAt).toBe('2026-06-09T12:00:00.000Z');
  });

  it('redacts secret-like values while keeping secret names useful', () => {
    const report = buildReport({
      statuses: [
        integrationStatus('telegram', 'Telegram', 'externally_blocked', {
          detail:
            'TELEGRAM_USER_API_HASH=supersecretvalue token=8755969867:AA-fixture',
          nextAction: 'Set TELEGRAM_USER_API_HASH=supersecretvalue.',
        }),
      ],
      proofs: [
        proofEntry('Telegram user-session proof', 'missing_config', {
          blockerOwner: 'external',
        }),
      ],
    });

    const text = formatIntegrationRecoveryReport(report);
    expect(text).toContain('TELEGRAM_USER_API_HASH=***');
    expect(text).toContain('token=***');
    expect(text).not.toContain('supersecretvalue');
    expect(text).not.toContain('redaction-fixture');
  });

  it('keeps recovery output free of unrelated internal decision jargon', () => {
    const report = buildReport({
      statuses: [
        integrationStatus('google_calendar', 'Google Calendar', 'needs_auth', {
          blockerOwner: 'external',
          detail: 'Google token refresh 400: invalid_grant',
          nextAction: 'Reauthorize Google Calendar.',
        }),
      ],
      proofs: [
        proofEntry('Google Calendar live write proof', 'externally_blocked'),
      ],
    });

    const text = formatIntegrationRecoveryReport(report);
    expect(text).not.toMatch(/Council check|Hold or block|provider council/i);
    expect(text).not.toMatch(/autonomy governor|blackboard|route score/i);
    expect(text).not.toMatch(/proof ledger|stack trace|raw debug/i);
  });

  it('parses targeted status, plan, and apply commands', () => {
    expect(parseIntegrationRecoveryCommand('/integrations calendar')).toEqual({
      action: 'status',
      targetId: 'google_calendar',
    });
    expect(
      parseIntegrationRecoveryCommand('/integrations plan telegram'),
    ).toEqual({
      action: 'plan',
      targetId: 'telegram',
    });
    expect(
      parseIntegrationRecoveryCommand('/integrations apply anthropic'),
    ).toEqual({
      action: 'apply',
      targetId: 'provider:anthropic_cloud',
    });
  });

  it('records checklist-only apply attempts for manual and external recovery paths', async () => {
    const report = integrationReport([
      integrationStatus('google_calendar', 'Google Calendar', 'needs_auth', {
        blockerOwner: 'external',
        detail: 'Google token refresh 400: invalid_grant',
      }),
      integrationStatus('telegram', 'Telegram', 'externally_blocked', {
        blockerOwner: 'external',
        detail: 'TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH are missing.',
      }),
      integrationStatus('alexa', 'Alexa', 'manual_action_required', {
        blockerOwner: 'manual',
        detail: 'No handled signed Alexa IntentRequest is recorded.',
      }),
      integrationStatus(
        'bluebubbles',
        'BlueBubbles / iMessage',
        'needs_proof',
        {
          blockerOwner: 'manual',
          detail: 'Same-thread message_action proof missing.',
        },
      ),
    ]);

    const attempts = await Promise.all(
      ['google_calendar', 'telegram', 'alexa', 'bluebubbles'].map((id) =>
        runIntegrationRepair({
          id,
          apply: true,
          dryRun: false,
          now: new Date(generatedAt),
          report,
          providers: [],
          persist: false,
        }),
      ),
    );
    const text = attempts
      .map((attempt) => `${attempt.summary}\n${attempt.nextAction}`)
      .join('\n');

    expect(text).toContain('Recorded recovery checklist for Google Calendar');
    expect(text).toContain('Recorded recovery checklist for Telegram');
    expect(text).toContain('Recorded recovery checklist for Alexa');
    expect(text).toContain('Recorded proof-drill checklist');
    expect(text).not.toMatch(/OAuth (?:was )?(?:fixed|repaired|completed)/i);
    expect(text).not.toMatch(/credentials (?:were )?(?:added|fixed|repaired)/i);
    expect(text).not.toMatch(/signed .*IntentRequest.*(?:completed|fixed)/i);
    expect(text).not.toMatch(/same-thread proof.*(?:completed|fixed)/i);
    expect(text).not.toMatch(/message sent|calendar write/i);
  });
});
