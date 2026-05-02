import { describe, expect, it } from 'vitest';

import {
  buildSelfImprovementStatusText,
  isSelfImprovementStatusFollowupRequest,
  isSelfImprovementStatusRequest,
  isSelfImprovementStatusMonitorRequest,
  planSelfImprovementStatusMonitor,
} from './self-improvement-status.js';
import type { ResponseFeedbackRecord } from './types.js';

function buildFeedbackRecord(
  overrides: Partial<ResponseFeedbackRecord> = {},
): ResponseFeedbackRecord {
  return {
    feedbackId: 'feedback-1',
    createdAt: '2026-05-02T04:00:00.000Z',
    updatedAt: '2026-05-02T04:01:00.000Z',
    status: 'awaiting_confirmation',
    classification: 'repo_side_rough_edge',
    channel: 'telegram',
    groupFolder: 'main',
    chatJid: 'tg:main',
    threadId: null,
    platformMessageId: 'msg-1',
    userMessageId: 'user-1',
    issueId: 'issue-1',
    routeKey: 'turn_agent_harness.blocked',
    capabilityId: 'assistant.intelligence',
    handlerKind: 'turn_agent_harness_hold',
    responseSource: 'local_companion',
    traceReason: 'downvoted answer',
    traceNotes: [],
    blockerClass: 'provider_blocked',
    blockerOwner: 'repo_side',
    originalUserText: 'What is the status of the self improvement job?',
    assistantReplyText: 'No job is running.',
    linkedRefs: {
      platformRepairPlanId: 'repair-plan-1',
    },
    remediationLaneId: 'andrea_runtime',
    remediationJobId: null,
    remediationRuntimePreference: 'codex_local',
    remediationPrompt: null,
    operatorNote: 'Cloud repair unavailable; waiting for explicit local approval.',
    ...overrides,
  };
}

describe('self-improvement status', () => {
  it('recognizes status and recurring-monitor requests from the recent failure mode', () => {
    expect(
      isSelfImprovementStatusRequest('The status of the self improvement job'),
    ).toBe(true);
    expect(isSelfImprovementStatusRequest('did it fix itself?')).toBe(true);
    expect(
      isSelfImprovementStatusMonitorRequest(
        'Ok provide me an update ok status every minute.',
      ),
    ).toBe(true);
    expect(
      isSelfImprovementStatusFollowupRequest(
        "Has it been a minute yet. I don't see an update. What's the status.",
      ),
    ).toBe(true);
  });

  it('creates a durable one-minute recurring monitor task', () => {
    const planned = planSelfImprovementStatusMonitor(
      'Please send self repair status every minute',
      'main',
      'tg:main',
      new Date('2026-05-02T04:18:00.000Z'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain('every minute');
    expect(planned?.task.schedule_type).toBe('interval');
    expect(planned?.task.schedule_value).toBe('60000');
    expect(planned?.task.prompt).toContain(
      'Send Andrea self-improvement status update',
    );
    expect(planned?.task.next_run).toBe('2026-05-02T04:19:00.000Z');
  });

  it('reports staged local-fallback repair truth without pretending work is running', () => {
    const text = buildSelfImprovementStatusText(
      [buildFeedbackRecord()],
      new Date('2026-05-02T04:22:00.000Z'),
    );

    expect(text).toContain('repair is staged and waiting for approval');
    expect(text).toContain('Repair plan: repair-plan-1');
    expect(text).toContain('Selected worker: Codex local fallback');
    expect(text).toContain('Approve local fallback');
  });
});
