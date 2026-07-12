import { describe, expect, it } from 'vitest';

import {
  buildIntegrationDoctorReport,
  buildIntegrationFixGuidance,
  formatIntegrationDoctorReport,
  isIntegrationDoctorRequest,
  parseIntegrationFixTarget,
  redactIntegrationDoctorText,
} from './integration-doctor.js';
import type {
  FieldTrialOperatorTruth,
  FieldTrialSurfaceTruth,
} from './field-trial-readiness.js';
import type { ResponseFeedbackRecord } from './types.js';
import type { ProviderHealthSnapshot } from './provider-health.js';

function surface(
  proofState: FieldTrialSurfaceTruth['proofState'],
  overrides: Partial<FieldTrialSurfaceTruth> = {},
): FieldTrialSurfaceTruth {
  return {
    proofState,
    blocker: '',
    blockerOwner: 'none',
    nextAction: '',
    detail: '',
    ...overrides,
  };
}

function truth(
  overrides: Partial<FieldTrialOperatorTruth> = {},
): FieldTrialOperatorTruth {
  return {
    telegram: surface('live_proven'),
    googleCalendar: surface('live_proven'),
    bluebubbles: {
      ...surface('degraded_but_usable', {
        detail: 'BlueBubbles transport is ready but proof is incomplete.',
        nextAction: 'Complete same-thread proof.',
      }),
      configured: true,
      transportState: 'ready',
      activeServerBaseUrl: 'http://192.168.5.50:1234',
      serverBaseUrl: 'http://MacBook-Pro.local:1234',
      messageActionProofState: 'none',
      lastIgnoredReason: 'direct_chat_requires_recent_context',
      lastIgnoredChatJid: 'bb:iMessage;-;+18173681595',
      detectionDetail:
        'Direct 1:1 chat lacks fresh Andrea context and needs @Andrea once.',
    },
    alexa: {
      ...surface('near_live_only', {
        detail: 'Alexa listener exists but no signed turn has reached host.',
      }),
      failureChecklist:
        'Check public URL, Developer Console endpoint, and simulator turn.',
    },
    hostHealth: surface('live_proven'),
    research: surface('live_proven'),
    imageGeneration: surface('live_proven'),
    workCockpit: surface('live_proven'),
    lifeThreads: surface('live_proven'),
    communicationCompanion: surface('live_proven'),
    chiefOfStaffMissions: surface('live_proven'),
    knowledgeLibrary: surface('live_proven'),
    actionBundlesDelegationOutcomeReview: surface('live_proven'),
    journeys: {},
    pilotIssues: {
      loggingEnabled: true,
      openCount: 0,
      latestSummary: '',
      latestResponseFeedbackStatus: '',
      latestResponseFeedbackClassification: '',
      latestResponseFeedbackSummary: '',
      localHotfixPending: false,
    },
    launchReadiness: {} as FieldTrialOperatorTruth['launchReadiness'],
    ...overrides,
  } as FieldTrialOperatorTruth;
}

function feedback(
  overrides: Partial<ResponseFeedbackRecord>,
): ResponseFeedbackRecord {
  return {
    feedbackId: 'feedback-1',
    createdAt: '2026-05-04T12:00:00.000Z',
    updatedAt: '2026-05-04T12:05:00.000Z',
    status: 'captured',
    classification: 'repo_side_rough_edge',
    channel: 'telegram',
    groupFolder: 'main',
    chatJid: 'telegram:main',
    originalUserText: 'Not helpful',
    assistantReplyText: 'Repair card',
    linkedRefs: {},
    blockerOwner: 'repo_side',
    ...overrides,
  } as ResponseFeedbackRecord;
}

describe('integration doctor', () => {
  it('keeps Telegram transport healthy when only live-proof freshness is stale', () => {
    const lastSuccess = '2026-05-04T10:00:00.000Z';
    const report = buildIntegrationDoctorReport({
      now: new Date('2026-05-04T12:00:00.000Z'),
      truth: truth({
        telegram: {
          ...surface('near_live_only', {
            blocker:
              'Telegram live proof is overdue; refresh the roundtrip marker.',
            detail:
              'Telegram long polling is ready, but live proof needs a fresh roundtrip.',
            nextAction: 'Rerun npm run telegram:user:smoke.',
          }),
          configured: true,
          transportState: 'ready',
          transportDetail: 'Telegram long polling is ready.',
          lastSuccessfulRoundtripAt: lastSuccess,
          roundtripDue: true,
        },
      }),
      providers: [],
      recentFeedback: [],
    });

    const telegram = report.statuses.find(
      (status) => status.integrationId === 'telegram',
    );
    expect(telegram).toMatchObject({
      state: 'near_live_only',
      proofState: 'near_live_only',
      credentialState: 'configured',
      transportState: 'healthy',
      lastHealthyAt: lastSuccess,
      lastFailure:
        'Telegram live proof is overdue; refresh the roundtrip marker.',
    });
  });

  it('reports configured-only providers as needing proof rather than healthy or failed', () => {
    const configuredOnlyProvider: ProviderHealthSnapshot = {
      providerId: 'openai_cloud',
      kind: 'llm',
      state: 'unknown',
      lastHealthyAt: null,
      lastCheckedAt: '2026-05-04T12:00:00.000Z',
      failureClass: 'none',
      quotaState: 'unknown',
      credentialState: 'configured',
      knownExpiresAt: null,
      rotationDueAt: null,
      blocker: '',
      nextAction: '',
      metadata: {
        healthEvidence: 'configuration_only',
        liveProbe: 'not_run',
      },
    };
    const report = buildIntegrationDoctorReport({
      now: new Date('2026-05-04T12:00:00.000Z'),
      truth: truth(),
      providers: [configuredOnlyProvider],
      recentFeedback: [],
    });

    const provider = report.statuses.find(
      (status) => status.integrationId === 'openai_cloud',
    );
    expect(provider).toMatchObject({
      state: 'near_live_only',
      proofState: 'near_live_only',
      credentialState: 'configured',
      transportState: 'unknown',
      lastHealthyAt: null,
      lastFailure: '',
      repairability: 'status_only',
    });
    expect(provider?.nextAction).toContain('debug:providers');
    expect(provider?.detail).toContain('live health was not checked');
  });

  it('reports critical disk pressure as guided manual degradation, never auto-repair', () => {
    const report = buildIntegrationDoctorReport({
      now: new Date('2026-05-04T12:00:00.000Z'),
      truth: truth({
        hostHealth: surface('degraded_but_usable', {
          blocker: 'Host disk pressure is critical: 742 MiB available.',
          blockerOwner: 'external',
          detail: 'Disk capacity is critical.',
          nextAction:
            'Review owner-controlled disk usage; do not delete Docker automatically.',
        }),
      }),
      providers: [],
      recentFeedback: [],
    });

    const runtime = report.statuses.find(
      (status) => status.integrationId === 'runtime_backend',
    );
    expect(runtime).toMatchObject({
      state: 'degraded_but_usable',
      repairability: 'guided_manual',
      blockerOwner: 'external',
    });
    expect(runtime?.safeActions.join(' ')).toContain('never delete Docker');
  });

  it('classifies Google Calendar invalid_grant as needs_auth', () => {
    const report = buildIntegrationDoctorReport({
      now: new Date('2026-05-04T12:00:00.000Z'),
      truth: truth({
        googleCalendar: surface('externally_blocked', {
          blocker: 'Google token refresh 400: invalid_grant',
          blockerOwner: 'external',
          detail: 'Refresh token invalid_grant.',
        }),
      }),
      providers: [],
      recentFeedback: [],
    });

    const calendar = report.statuses.find(
      (status) => status.integrationId === 'google_calendar',
    );
    expect(calendar?.state).toBe('needs_auth');
    expect(calendar?.credentialState).toBe('invalid');
    expect(calendar?.nextAction).toContain(
      'publish/verify the app in Google Cloud Console',
    );
  });

  it('classifies BlueBubbles as proof-needed while transport is healthy', () => {
    const report = buildIntegrationDoctorReport({
      now: new Date('2026-05-04T12:00:00.000Z'),
      truth: truth(),
      providers: [],
      recentFeedback: [],
    });

    const bluebubbles = report.statuses.find(
      (status) => status.integrationId === 'bluebubbles',
    );
    expect(bluebubbles?.state).toBe('needs_proof');
    expect(bluebubbles?.transportState).toBe('healthy');
    expect(bluebubbles?.safeActions.join(' ')).toContain('@Andrea once');
  });

  it('keeps BlueBubbles degraded-but-usable when message-action proof is fresh', () => {
    const report = buildIntegrationDoctorReport({
      now: new Date('2026-05-04T12:00:00.000Z'),
      truth: truth({
        bluebubbles: {
          ...truth().bluebubbles,
          proofState: 'degraded_but_usable',
          messageActionProofState: 'fresh',
          detail:
            'Webhook side missed the latest inbound, but transport and deferred send proof are fresh.',
          nextAction: 'Check the Mac-side webhook target.',
        },
      }),
      providers: [],
      recentFeedback: [],
    });

    const bluebubbles = report.statuses.find(
      (status) => status.integrationId === 'bluebubbles',
    );
    expect(bluebubbles?.state).toBe('degraded_but_usable');
    expect(bluebubbles?.proofState).toBe('degraded_but_usable');
    expect(bluebubbles?.transportState).toBe('healthy');
    expect(bluebubbles?.detail).toContain('Same-thread proof is fresh');
    expect(bluebubbles?.nextAction).toContain('webhook target');
    expect(bluebubbles?.safeActions.join(' ')).not.toContain(
      'send it later tonight',
    );
  });

  it('surfaces stale repair plans as repo-fix-available cleanup work', () => {
    const report = buildIntegrationDoctorReport({
      now: new Date('2026-05-04T12:00:00.000Z'),
      truth: truth(),
      providers: [],
      recentFeedback: [
        feedback({
          linkedRefs: {
            platformRepairPlanId: 'plan-1',
            repairExecutionState: 'awaiting_approval',
          },
        }),
      ],
    });

    const selfRepair = report.statuses.find(
      (status) => status.integrationId === 'self_repair',
    );
    expect(selfRepair?.state).toBe('repo_fix_available');
    expect(selfRepair?.detail).toContain('1 pending/stale repair');
  });

  it('does not treat planless old feedback confirmations as active repair plans', () => {
    const report = buildIntegrationDoctorReport({
      now: new Date('2026-05-04T12:00:00.000Z'),
      truth: truth(),
      providers: [],
      recentFeedback: [
        feedback({
          status: 'awaiting_confirmation',
          linkedRefs: {},
          originalUserText: 'you have my approval',
        }),
      ],
    });

    const selfRepair = report.statuses.find(
      (status) => status.integrationId === 'self_repair',
    );
    expect(selfRepair?.state).toBe('healthy');
  });

  it('redacts secret-like material from reports', () => {
    const text = redactIntegrationDoctorText(
      'token=8755969867:AAFUMkQogpCP-aC344HSI5cnQjWLK8-UDZY password=abc123 sk-proj-abcdefabcdefabcdefabcdef',
    );

    expect(text).not.toContain('AAFUM');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('sk-proj-abcdef');
    expect(text).toContain('token=***');
    expect(text).toContain('password=***');
  });

  it('formats one concise broken-proof-healthy report', () => {
    const report = buildIntegrationDoctorReport({
      now: new Date('2026-05-04T12:00:00.000Z'),
      truth: truth({
        googleCalendar: surface('externally_blocked', {
          blocker: 'Google token refresh 400: invalid_grant',
          blockerOwner: 'external',
        }),
      }),
      providers: [],
      recentFeedback: [],
    });

    const formatted = formatIntegrationDoctorReport(report, 'doctor');
    expect(formatted).toContain('Action needed');
    expect(formatted).toContain('Google Calendar: needs_auth');
    expect(formatted).toContain('Proof needed, not broken');
    expect(formatted).toContain('BlueBubbles / iMessage: needs_proof');
  });

  it('matches chat requests and targeted fix requests', () => {
    expect(isIntegrationDoctorRequest("what's broken?")).toBe(true);
    expect(isIntegrationDoctorRequest('integration status')).toBe(true);
    expect(parseIntegrationFixTarget('fix google calendar')).toBe(
      'google calendar',
    );
    expect(
      parseIntegrationFixTarget('BlueBubbles seems down, can you check?'),
    ).toBe('bluebubbles');
    expect(
      isIntegrationDoctorRequest('BlueBubbles seems down, can you check?'),
    ).toBe(true);
    expect(buildIntegrationFixGuidance('calendar')).toContain(
      'Google Calendar needs OAuth reauth',
    );
  });
});
