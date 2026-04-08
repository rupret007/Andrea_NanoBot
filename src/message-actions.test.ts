import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getMessageAction,
  getOutcomeBySource,
  getTaskById,
  upsertCommunicationThread,
  upsertDelegationRule,
} from './db.js';
import {
  applyMessageActionOperation,
  createOrRefreshMessageActionFromDraft,
  findLatestChatMessageAction,
} from './message-actions.js';
import type { CommunicationThreadRecord, DelegationRuleRecord } from './types.js';

function seedCommunicationThread(
  overrides: Partial<CommunicationThreadRecord> = {},
): CommunicationThreadRecord {
  const thread: CommunicationThreadRecord = {
    id: overrides.id || 'comm-1',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Candace',
    linkedSubjectIds: overrides.linkedSubjectIds || [],
    linkedLifeThreadIds: overrides.linkedLifeThreadIds || [],
    channel: overrides.channel || 'bluebubbles',
    channelChatJid: overrides.channelChatJid || 'bb:chat-1',
    lastInboundSummary:
      overrides.lastInboundSummary || 'Candace asked if dinner still works.',
    lastOutboundSummary: overrides.lastOutboundSummary || null,
    followupState: overrides.followupState || 'reply_needed',
    urgency: overrides.urgency || 'tonight',
    followupDueAt: overrides.followupDueAt || '2026-04-08T22:00:00.000Z',
    suggestedNextAction: overrides.suggestedNextAction || 'draft_reply',
    toneStyleHints: overrides.toneStyleHints || [],
    lastContactAt: overrides.lastContactAt || '2026-04-08T17:00:00.000Z',
    lastMessageId: overrides.lastMessageId || 'bb:last-msg-1',
    linkedTaskId: overrides.linkedTaskId || null,
    inferenceState: overrides.inferenceState || 'user_confirmed',
    trackingMode: overrides.trackingMode || 'default',
    createdAt: overrides.createdAt || '2026-04-08T16:30:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-08T18:30:00.000Z',
    disabledAt: overrides.disabledAt || null,
  };
  upsertCommunicationThread(thread);
  return thread;
}

function seedSendRule(
  overrides: Partial<DelegationRuleRecord> = {},
): DelegationRuleRecord {
  const rule: DelegationRuleRecord = {
    ruleId: overrides.ruleId || 'rule-send',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Candace safe reply rule',
    triggerType: overrides.triggerType || 'communication_context',
    triggerScope: overrides.triggerScope || 'household',
    conditionsJson:
      overrides.conditionsJson ||
      JSON.stringify({
        actionType: 'send_message',
        personName: 'Candace',
        communicationContext: 'reply_followthrough',
      }),
    delegatedActionsJson:
      overrides.delegatedActionsJson ||
      JSON.stringify([
        {
          actionType: 'send_message',
        },
      ]),
    approvalMode: overrides.approvalMode || 'auto_apply_when_safe',
    status: overrides.status || 'active',
    createdAt: overrides.createdAt || '2026-04-08T12:00:00.000Z',
    lastUsedAt: overrides.lastUsedAt ?? null,
    timesUsed: overrides.timesUsed ?? 1,
    timesAutoApplied: overrides.timesAutoApplied ?? 0,
    timesOverridden: overrides.timesOverridden ?? 0,
    lastOutcomeStatus: overrides.lastOutcomeStatus ?? null,
    userConfirmed: overrides.userConfirmed ?? true,
    channelApplicabilityJson:
      overrides.channelApplicabilityJson || JSON.stringify(['telegram', 'bluebubbles']),
    safetyLevel:
      overrides.safetyLevel || 'safe_to_auto_after_delegation',
  };
  upsertDelegationRule(rule);
  return rule;
}

describe('message actions', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
    vi.restoreAllMocks();
  });

  it('creates a tracked bluebubbles reply draft with an open outcome', () => {
    const thread = seedCommunicationThread();

    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs a dinner answer.',
      draftText: 'Dinner still works for me tonight.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:00:00.000Z'),
    });

    expect(action.targetChannel).toBe('bluebubbles');
    expect(action.targetKind).toBe('external_thread');
    expect(action.sendStatus).toBe('drafted');
    expect(findLatestChatMessageAction({ groupFolder: 'main', chatJid: 'bb:chat-1' })?.messageActionId).toBe(
      action.messageActionId,
    );
    expect(
      getOutcomeBySource('main', 'message_action', action.messageActionId)?.status,
    ).toBe('partial');
  });

  it('marks narrow safe bluebubbles replies as approved when a saved send rule matches', () => {
    const thread = seedCommunicationThread();
    seedSendRule();

    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace just needs a simple yes/no answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:05:00.000Z'),
    });

    expect(action.sendStatus).toBe('approved');
    expect(action.requiresApproval).toBe(false);
    expect(action.trustLevel).toBe('delegated_safe_send');
  });

  it('sends a bluebubbles reply without the Andrea companion label and marks it sent', async () => {
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs a quick answer.',
      draftText: 'Yes, that still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:10:00.000Z'),
    });
    const sendToTarget = vi.fn(async () => ({ platformMessageId: 'bb:sent-1' }));

    const result = await applyMessageActionOperation(action.messageActionId, { kind: 'send' }, {
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:chat-1',
      currentTime: new Date('2026-04-08T19:12:00.000Z'),
      sendToTarget,
    });

    expect(result.handled).toBe(true);
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:chat-1',
      'Yes, that still works for me.',
      expect.objectContaining({
        suppressSenderLabel: true,
        replyToMessageId: 'bb:last-msg-1',
      }),
    );
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe('sent');
    expect(
      getOutcomeBySource('main', 'message_action', action.messageActionId)?.status,
    ).toBe('completed');
  });

  it('defers a message action with a reminder-backed follow-up instead of auto-sending', async () => {
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs an answer, but not right now.',
      draftText: 'Yes, that still works for me tonight.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:15:00.000Z'),
    });

    const result = await applyMessageActionOperation(action.messageActionId, { kind: 'defer' }, {
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main',
      currentTime: new Date('2026-04-08T19:16:00.000Z'),
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });

    const updated = getMessageAction(action.messageActionId)!;
    const reminderId = JSON.parse(updated.linkedRefsJson || '{}').reminderTaskId;

    expect(result.handled).toBe(true);
    expect(updated.sendStatus).toBe('deferred');
    expect(reminderId).toBeTruthy();
    expect(getTaskById(reminderId)?.prompt).toContain('Revisit this draft reply');
    expect(
      getOutcomeBySource('main', 'message_action', action.messageActionId)?.status,
    ).toBe('deferred');
  });

  it('prevents duplicate sends unless the user explicitly asks to send again', async () => {
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs a quick answer.',
      draftText: 'Yes, tonight still works.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:20:00.000Z'),
    });
    const sendToTarget = vi.fn(async () => ({ platformMessageId: 'bb:sent-2' }));

    await applyMessageActionOperation(action.messageActionId, { kind: 'send' }, {
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:chat-1',
      currentTime: new Date('2026-04-08T19:21:00.000Z'),
      sendToTarget,
    });
    const duplicate = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'send' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:22:00.000Z'),
        sendToTarget,
      },
    );

    expect(duplicate.replyText).toContain('already went out');
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });
});
