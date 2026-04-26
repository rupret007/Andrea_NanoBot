import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyActionBundleOperation,
  buildActionBundleVoiceSummary,
  buildActionBundlePresentation,
  createOrRefreshActionBundle,
  interpretActionBundleFollowup,
} from './action-bundles.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getActionBundleSnapshot,
  getAllTasks,
  getDelegationRule,
  listKnowledgeSourcesForGroup,
  listLifeThreadsForGroup,
  upsertDelegationRule,
} from './db.js';
import type { DelegationRuleRecord } from './types.js';

function seedDelegationRule(
  overrides: Partial<DelegationRuleRecord> = {},
): DelegationRuleRecord {
  const record: DelegationRuleRecord = {
    ruleId: overrides.ruleId || 'rule-1',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Candace reminder default',
    triggerType: overrides.triggerType || 'bundle_type',
    triggerScope: overrides.triggerScope || 'mixed',
    conditionsJson:
      overrides.conditionsJson ||
      JSON.stringify({
        actionType: 'create_reminder',
        originKind: 'communication',
      }),
    delegatedActionsJson:
      overrides.delegatedActionsJson ||
      JSON.stringify([
        {
          actionType: 'create_reminder',
          timingHint: 'tomorrow morning',
        },
      ]),
    approvalMode: overrides.approvalMode || 'auto_apply_when_safe',
    status: overrides.status || 'active',
    createdAt: overrides.createdAt || '2026-04-08T10:00:00.000Z',
    lastUsedAt: overrides.lastUsedAt ?? null,
    timesUsed: overrides.timesUsed ?? 0,
    timesAutoApplied: overrides.timesAutoApplied ?? 0,
    timesOverridden: overrides.timesOverridden ?? 0,
    lastOutcomeStatus: overrides.lastOutcomeStatus ?? null,
    userConfirmed: overrides.userConfirmed ?? true,
    channelApplicabilityJson:
      overrides.channelApplicabilityJson ||
      JSON.stringify(['telegram', 'alexa', 'bluebubbles']),
    safetyLevel: overrides.safetyLevel || 'safe_to_auto_after_delegation',
  };
  upsertDelegationRule(record);
  return record;
}

describe('action bundles', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('creates and reuses a mission bundle while it is still open', () => {
    const continuationCandidate = {
      capabilityId: 'missions.propose',
      voiceSummary:
        'You should follow up with Candace and keep the plan from slipping.',
      missionId: 'mission-1',
      missionSummary: 'Candace dinner follow-up',
      missionSuggestedActionsJson: JSON.stringify([
        {
          kind: 'draft_follow_up',
          label: 'Draft the message to Candace',
          reason: 'The plan depends on the conversation moving.',
          requiresConfirmation: true,
          linkedRefJson: JSON.stringify({ personName: 'Candace' }),
        },
        {
          kind: 'create_reminder',
          label: 'Set a reminder',
          reason: 'Keep it from slipping.',
          requiresConfirmation: true,
        },
        {
          kind: 'link_thread',
          label: 'Track this under Candace',
          reason: 'Keep it tied to the thread.',
          requiresConfirmation: true,
          linkedRefJson: JSON.stringify({ threadTitle: 'Candace' }),
        },
      ]),
      threadTitle: 'Candace',
      completionText: 'Follow up with Candace about dinner tonight.',
    };

    const first = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      capabilityId: 'missions.propose',
      continuationCandidate,
      summaryText: 'Candace dinner follow-up',
      utterance: 'help me plan tonight',
      now: new Date('2026-04-08T10:00:00.000Z'),
    });
    const second = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      capabilityId: 'missions.propose',
      continuationCandidate,
      summaryText: 'Candace dinner follow-up',
      utterance: 'help me plan tonight',
      now: new Date('2026-04-08T10:05:00.000Z'),
    });

    expect(first?.bundle.bundleId).toBeTruthy();
    expect(second?.bundle.bundleId).toBe(first?.bundle.bundleId);
    expect(first?.actions.map((action) => action.actionType)).toEqual([
      'draft_follow_up',
      'create_reminder',
      'save_to_thread',
    ]);
  });

  it('uses more natural voice phrasing for research bundles', () => {
    const continuationCandidate = {
      capabilityId: 'research.answer',
      voiceSummary:
        'Meal delivery saves time, but grocery delivery costs less.',
      handoffPayload: {
        kind: 'message' as const,
        title: 'Busy week tradeoffs',
        text: 'Meal delivery saves time, but grocery delivery costs less.',
        followupSuggestions: ['Send the fuller version to Telegram'],
      },
      completionText: 'meal delivery and grocery delivery for a busy week',
      followupSuggestions: ['send me the fuller version'],
    };

    const bundle = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'alexa',
      capabilityId: 'research.answer',
      continuationCandidate,
      summaryText: 'Busy week tradeoffs',
      utterance: 'compare meal delivery and grocery delivery for a busy week',
      now: new Date('2026-04-08T10:10:00.000Z'),
    });

    expect(bundle).toBeTruthy();
    const voiceSummary = buildActionBundleVoiceSummary(bundle!);
    expect(voiceSummary.summary).toContain(
      'If you want, I can send the fuller version to Telegram, save this to the library, and set a reminder.',
    );
    expect(voiceSummary.summary).not.toContain('I have 3 next steps ready');
    expect(voiceSummary.speech).toContain('send it to Telegram');
    expect(voiceSummary.speech).toContain('save it');
    expect(voiceSummary.speech).toContain('remind me later');
  });

  it('renders bundle cards and interprets conversational follow-ups', () => {
    const snapshot = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      capabilityId: 'communication.understand_message',
      continuationCandidate: {
        capabilityId: 'communication.understand_message',
        voiceSummary: 'Candace still needs a dinner answer.',
        communicationThreadId: 'comm-1',
        lastCommunicationSummary: 'Candace still needs a dinner answer.',
        threadTitle: 'Candace',
        completionText: 'Candace still needs a dinner answer tonight.',
      },
      summaryText: 'Candace still needs a dinner answer.',
      utterance: 'what should I say back',
      now: new Date('2026-04-08T10:00:00.000Z'),
    });

    expect(snapshot).toBeTruthy();
    const presentation = buildActionBundlePresentation(snapshot!);
    expect(presentation.text).toContain('*Action bundle*');
    expect(presentation.text).toContain('1. [ready]');
    expect(presentation.inlineActionRows[0]?.[0]?.label).toContain(
      'Approve all',
    );
    expect(
      interpretActionBundleFollowup('just the reminder', snapshot!),
    ).toEqual({
      kind: 'execute_action_type',
      actionType: 'create_reminder',
    });
    expect(
      interpretActionBundleFollowup('do the first two', snapshot!),
    ).toEqual({
      kind: 'execute_action_indexes',
      orderIndexes: [1, 2],
    });
    expect(
      interpretActionBundleFollowup(
        'Can you summerize my text messages in the Pops of Punk text thread please. Last 2 days.',
        snapshot!,
      ),
    ).toBeNull();
    expect(interpretActionBundleFollowup('2', snapshot!)).toEqual({
      kind: 'execute_action_indexes',
      orderIndexes: [2],
    });
  });

  it('hides generic Follow-up thread titles in daily guidance action summaries', () => {
    const snapshot = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      capabilityId: 'daily.guidance',
      continuationCandidate: {
        capabilityId: 'daily.guidance',
        voiceSummary: 'Pest control is coming today at 1:00 PM.',
        threadTitle: 'Follow-up',
        completionText: 'Pest control is coming today at 1:00 PM.',
      },
      summaryText: 'Pest control is coming today at 1:00 PM.',
      utterance: 'what should I remember tonight',
      now: new Date('2026-04-08T10:00:00.000Z'),
    });

    expect(snapshot).toBeTruthy();
    expect(snapshot?.bundle.title).toBe('Daily next steps');
    expect(
      snapshot?.actions.find((action) => action.actionType === 'save_to_thread')
        ?.summary,
    ).toBe('Save it for later');
  });

  it('handles partial execution honestly when one bundle action fails', async () => {
    const snapshot = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      capabilityId: 'research.compare',
      continuationCandidate: {
        capabilityId: 'research.compare',
        voiceSummary: 'Kindle is the safer battery pick.',
        handoffPayload: {
          kind: 'message',
          title: 'Full comparison',
          text: 'Kindle is the safer battery pick for long travel days.',
          followupSuggestions: ['Save it if useful.'],
        },
        completionText:
          'Kindle is the safer battery pick for long travel days.',
      },
      summaryText: 'Kindle is the safer battery pick.',
      utterance: 'compare kindle versus kobo',
      now: new Date('2026-04-08T10:00:00.000Z'),
    });

    const result = await applyActionBundleOperation(
      snapshot!.bundle.bundleId,
      { kind: 'approve_all' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T10:05:00.000Z'),
        resolveTelegramMainChat: () => undefined,
        sendTelegramMessage: vi.fn(async () => ({
          platformMessageId: 'unused',
        })),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('handled');
    expect(result.replyText).toContain('still needs attention');
    expect(listKnowledgeSourcesForGroup('main')).toHaveLength(1);
    expect(getAllTasks()).toHaveLength(1);
    expect(
      getActionBundleSnapshot(snapshot!.bundle.bundleId)?.actions.some(
        (action) => action.status === 'failed',
      ),
    ).toBe(true);
  });

  it('can execute just the reminder from a communication bundle', async () => {
    const snapshot = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      capabilityId: 'communication.understand_message',
      continuationCandidate: {
        capabilityId: 'communication.understand_message',
        voiceSummary: 'Candace still needs a dinner answer.',
        communicationThreadId: 'comm-1',
        lastCommunicationSummary: 'Candace still needs a dinner answer.',
        threadTitle: 'Candace',
        completionText: 'Candace still needs a dinner answer tonight.',
      },
      summaryText: 'Candace still needs a dinner answer.',
      utterance: 'what should I say back',
      now: new Date('2026-04-08T10:00:00.000Z'),
    });

    const result = await applyActionBundleOperation(
      snapshot!.bundle.bundleId,
      { kind: 'execute_action_type', actionType: 'create_reminder' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T10:15:00.000Z'),
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage: vi.fn(async () => ({
          platformMessageId: 'unused',
        })),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('reminder');
    expect(getAllTasks()).toHaveLength(1);
    expect(listLifeThreadsForGroup('main', ['active'])).toHaveLength(0);
  });

  it('marks rule-driven actions in a bundle and records overrides when skipped', async () => {
    const rule = seedDelegationRule();
    const snapshot = createOrRefreshActionBundle({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      capabilityId: 'communication.understand_message',
      continuationCandidate: {
        capabilityId: 'communication.understand_message',
        voiceSummary: 'Candace still needs a dinner answer.',
        communicationThreadId: 'comm-1',
        lastCommunicationSummary: 'Candace still needs a dinner answer.',
        threadTitle: 'Candace',
        completionText: 'Candace still needs a dinner answer tonight.',
      },
      summaryText: 'Candace still needs a dinner answer.',
      utterance: 'what should I say back',
      now: new Date('2026-04-08T10:00:00.000Z'),
    });

    expect(snapshot).toBeTruthy();
    expect(
      snapshot!.actions.find(
        (action) => action.actionType === 'create_reminder',
      )?.status,
    ).toBe('approved');

    const presentation = buildActionBundlePresentation(snapshot!);
    expect(presentation.text).toContain('Andrea used your saved rule');
    expect(presentation.text).toContain('[usual rule]');

    const result = await applyActionBundleOperation(
      snapshot!.bundle.bundleId,
      { kind: 'skip_action_type', actionType: 'create_reminder' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T10:15:00.000Z'),
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage: vi.fn(async () => ({
          platformMessageId: 'unused',
        })),
      },
    );

    expect(result.handled).toBe(true);
    expect(getDelegationRule(rule.ruleId)?.timesOverridden).toBe(1);
  });
});
