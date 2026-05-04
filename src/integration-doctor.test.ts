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
    expect(calendar?.nextAction).toContain('Reauthorize Google Calendar');
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
    expect(buildIntegrationFixGuidance('calendar')).toContain(
      'Google Calendar needs OAuth reauth',
    );
  });
});
