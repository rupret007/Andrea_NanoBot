import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getCommunicationThread,
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
  interpretMessageActionFollowup,
  resolveMessageActionForFollowup,
  runScheduledMessageActionByTaskId,
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

  it('can convert a drafted reply into a reminder-backed follow-up instead of a queued send', async () => {
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

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'remind_instead' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T19:16:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );

    const updated = getMessageAction(action.messageActionId)!;
    const reminderId = JSON.parse(updated.linkedRefsJson || '{}').reminderTaskId;

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('kept the draft unsent');
    expect(updated.sendStatus).toBe('deferred');
    expect(updated.lastActionKind).toBe('remind_instead');
    expect(reminderId).toBeTruthy();
    expect(getTaskById(reminderId)?.prompt).toContain('Revisit this draft reply');
    expect(
      getOutcomeBySource('main', 'message_action', action.messageActionId)?.status,
    ).toBe('deferred');
  });

  it('stores save-under-thread as a distinct unsent state', async () => {
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs an answer if dinner is on.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:17:00.000Z'),
    });

    const result = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'save_to_thread' },
      {
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: 'tg:main',
        currentTime: new Date('2026-04-08T19:18:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );

    const updated = getMessageAction(action.messageActionId)!;
    const linkedRefs = JSON.parse(updated.linkedRefsJson || '{}');
    const outcome = getOutcomeBySource('main', 'message_action', action.messageActionId)!;

    expect(result.handled).toBe(true);
    expect(updated.sendStatus).toBe('deferred');
    expect(updated.lastActionKind).toBe('save_to_thread');
    expect(updated.requiresApproval).toBe(false);
    expect(linkedRefs.threadId).toBeTruthy();
    expect(getCommunicationThread(thread.id)?.suggestedNextAction).toBe('save_for_later');
    expect(outcome.status).toBe('deferred');
    expect(outcome.nextFollowupText).toContain('saved under the thread');
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

  it('queues an eligible bluebubbles reply for scheduled send and tracks it separately from reminders', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs a quick dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:25:00.000Z'),
    });

    const result = await applyMessageActionOperation(action.messageActionId, { kind: 'defer' }, {
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:chat-1',
      currentTime: new Date('2026-04-08T19:26:00.000Z'),
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });

    const updated = getMessageAction(action.messageActionId)!;
    expect(result.handled).toBe(true);
    expect(updated.sendStatus).toBe('deferred');
    expect(updated.trustLevel).toBe('schedule_send');
    expect(updated.scheduledTaskId).toBeTruthy();
    expect(updated.approvedAt).toBeTruthy();
    expect(getTaskById(updated.scheduledTaskId!)?.next_run).toBeTruthy();
    expect(getCommunicationThread(thread.id)?.followupState).toBe('scheduled');
  });

  it('cancels a scheduled send and keeps the draft ready', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs a quick dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:30:00.000Z'),
    });

    await applyMessageActionOperation(action.messageActionId, { kind: 'defer' }, {
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:chat-1',
      currentTime: new Date('2026-04-08T19:31:00.000Z'),
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });
    const scheduled = getMessageAction(action.messageActionId)!;

    await applyMessageActionOperation(scheduled.messageActionId, { kind: 'cancel_deferred' }, {
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:chat-1',
      currentTime: new Date('2026-04-08T19:32:00.000Z'),
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });

    const updated = getMessageAction(action.messageActionId)!;
    expect(updated.sendStatus).toBe('approved');
    expect(updated.scheduledTaskId).toBeNull();
    expect(getTaskById(scheduled.scheduledTaskId!)?.status).toBe('paused');
  });

  it('rewriting a queued send cancels the queue and forces fresh approval', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs a quick dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:35:00.000Z'),
    });

    await applyMessageActionOperation(action.messageActionId, { kind: 'defer' }, {
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:chat-1',
      currentTime: new Date('2026-04-08T19:36:00.000Z'),
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });
    const scheduled = getMessageAction(action.messageActionId)!;

    await applyMessageActionOperation(
      scheduled.messageActionId,
      { kind: 'rewrite', style: 'shorter' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:37:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );

    const updated = getMessageAction(action.messageActionId)!;
    expect(updated.sendStatus).toBe('drafted');
    expect(updated.requiresApproval).toBe(true);
    expect(updated.scheduledTaskId).toBeNull();
    expect(updated.lastActionKind).toBe('rewrite');
    expect(getTaskById(scheduled.scheduledTaskId!)?.status).toBe('paused');
  });

  it('can keep a queued send as a draft without leaving it scheduled', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs a quick dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:38:00.000Z'),
    });

    await applyMessageActionOperation(action.messageActionId, { kind: 'defer' }, {
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:chat-1',
      currentTime: new Date('2026-04-08T19:39:00.000Z'),
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });
    const scheduled = getMessageAction(action.messageActionId)!;

    const result = await applyMessageActionOperation(
      scheduled.messageActionId,
      { kind: 'keep_draft' },
      {
        groupFolder: 'main',
        channel: 'bluebubbles',
        chatJid: 'bb:chat-1',
        currentTime: new Date('2026-04-08T19:40:00.000Z'),
        sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
      },
    );

    const updated = getMessageAction(action.messageActionId)!;
    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('kept it as a draft');
    expect(updated.sendStatus).toBe('drafted');
    expect(updated.requiresApproval).toBe(true);
    expect(updated.scheduledTaskId).toBeNull();
    expect(updated.approvedAt).toBeNull();
    expect(updated.lastActionKind).toBe('drafted');
    expect(getTaskById(scheduled.scheduledTaskId!)?.status).toBe('paused');
  });

  it('runs a scheduled send through the same shared send path', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    const thread = seedCommunicationThread();
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'bb:chat-1',
      sourceType: 'communication_thread',
      sourceKey: thread.id,
      sourceSummary: 'Candace still needs a quick dinner answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: thread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:40:00.000Z'),
    });

    await applyMessageActionOperation(action.messageActionId, { kind: 'defer' }, {
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:chat-1',
      currentTime: new Date('2026-04-08T19:41:00.000Z'),
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });
    const scheduled = getMessageAction(action.messageActionId)!;
    const sendToTarget = vi.fn(async () => ({ platformMessageId: 'bb:sent-scheduled' }));

    const runResult = await runScheduledMessageActionByTaskId(scheduled.scheduledTaskId!, {
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:chat-1',
      currentTime: new Date('2026-04-08T21:00:00.000Z'),
      sendToTarget,
    });

    expect(runResult.handled).toBe(true);
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      'bb:chat-1',
      'Yes, tonight still works for me.',
      expect.objectContaining({
        suppressSenderLabel: true,
      }),
    );
    expect(getMessageAction(action.messageActionId)?.sendStatus).toBe('sent');
    expect(getCommunicationThread(thread.id)?.followupState).toBe('waiting_on_them');
  });

  it('resolves explicit person-targeted followups to an existing open message action', () => {
    const candaceThread = seedCommunicationThread();
    seedCommunicationThread({
      id: 'comm-2',
      title: 'Jenna',
      channelChatJid: 'bb:chat-2',
      lastMessageId: 'bb:last-msg-2',
    });

    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'main',
      presentationChannel: 'telegram',
      presentationChatJid: 'tg:main',
      sourceType: 'communication_thread',
      sourceKey: candaceThread.id,
      sourceSummary: 'Candace still needs an answer.',
      draftText: 'Yes, tonight still works for me.',
      personName: 'Candace',
      threadTitle: 'Candace',
      communicationThreadId: candaceThread.id,
      communicationContext: 'reply_followthrough',
      now: new Date('2026-04-08T19:45:00.000Z'),
    });

    const resolved = resolveMessageActionForFollowup({
      groupFolder: 'main',
      chatJid: 'tg:main',
      rawText: 'send this to Candace',
    });

    expect(resolved?.messageActionId).toBe(action.messageActionId);
  });

  it('treats natural show-draft phrasing as a message-action follow-up', () => {
    expect(interpretMessageActionFollowup("ok let's see the draft again")).toEqual({
      kind: 'show_draft',
    });
    expect(interpretMessageActionFollowup('show me the draft again')).toEqual({
      kind: 'show_draft',
    });
  });
});
